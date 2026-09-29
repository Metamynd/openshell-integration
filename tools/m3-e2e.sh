#!/usr/bin/env bash
# M3 exit test (build plan tasks 3.1-3.6): a governed purchase from inside an OpenShell sandbox
# executes exactly once. Agent A's sandbox buys RM100 at OfficeMart through
#   sandbox -> OpenShell supervisor -> MetaMynd adapter (authorize at metamynd.ai as agent A,
#   signed x-magp-request) -> credential substitution -> purchasing gateway (re-verify, claim,
#   capture) -> mock purchasing API ledger,
# while agent B's sandbox is denied the identical request, and concurrent traffic from both
# sandboxes through one adapter is never cross-attributed. The sandboxes hold only a
# placeholder for the purchasing token.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh
. tools/lib/openshell.sh

out="docs/report/runs"
mkdir -p "$out"
adapter_log=state/logs/adapter.log
sb_a="m3-agent-a-$$"
sb_b="m3-agent-b-$$"
profile_id="poc-purchasing-gw"
provider="poc-purchasing"
concurrent=${M3_CONCURRENT:-10}
fail=0
adapter_pid=""
created_profile=0
created_provider=0
sid_a=""
sid_b=""

ok()  { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
die() { printf 'FAIL  %s\n' "$1"; exit 1; }

cleanup() {
  openshell sandbox delete "$sb_a" >/dev/null 2>&1 || true
  openshell sandbox delete "$sb_b" >/dev/null 2>&1 || true
  for s in "$sid_a" "$sid_b"; do [[ -n "$s" ]] && node packages/adapter/bin/bindings.mjs revoke "$s" >/dev/null 2>&1; done
  (( created_provider )) && { sleep 2; openshell provider delete "$provider" >/dev/null 2>&1 || echo "WARN  could not delete provider $provider"; }
  (( created_profile )) && { openshell profile delete "$profile_id" >/dev/null 2>&1 || echo "WARN  could not delete profile $profile_id"; }
  restore_gateway_cfg
  [[ -n "$adapter_pid" ]] && kill "$adapter_pid" 2>/dev/null
  bash tools/poc-stack.sh down >/dev/null
}
trap cleanup EXIT

ledger_count() {
  curl -s -H "x-ledger-token: $(cat state/ledger-token)" http://127.0.0.1:18080/ledger | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).count))'
}

# buy <sandbox> <json>: prints "<status> <body>" for one purchase from inside the sandbox
buy() {
  openshell sandbox exec -n "$1" --no-tty -- sh -c \
    'curl -sS -w "\n%{http_code}" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $PURCHASING_TOKEN" --data-binary @- https://host.openshell.internal:8443/purchase-requests' <<<"$2"
}
status_of() { tail -n1 <<<"$1"; }
# journal_last <sandboxId>: "<decision> <reasonCode>" of the sandbox's latest journaled request
journal_last() {
  cat state/journal/*.jsonl | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=s.split("\n").filter(Boolean).map(JSON.parse).filter(x=>x.kind==="request"&&x.sandboxId===process.argv[1]).at(-1);console.log(r?`${r.decision} ${r.reasonCode??r.osReasonCode??""}`:"none")})' "$1"
}
body_of() { sed '$d' <<<"$1"; }

[[ -f state/enrolment.json ]] || die "no state/enrolment.json; run: bash tools/m1-enrol.sh"
ensure_deps
bash tools/gen-middleware-certs.sh >/dev/null || die "certificates"
ensure_images || exit 1
openshell profile lint -f deploy/openshell/poc-purchasing-profile.yaml >/dev/null || die "provider profile lint"

echo "== purchasing stack"
bash tools/poc-stack.sh up || exit 1

echo "== MetaMynd adapter with the allow path (authorize at metamynd.ai as the bound agent)"
: > "$adapter_log"
ADAPTER_TLS_CERT=state/certs/server.pem ADAPTER_TLS_KEY=state/certs/server.key OPENSHELL_JWT_DIR="$OPENSHELL_JWT_DIR" \
  ADAPTER_REGISTRY=state/bindings.json ADAPTER_JOURNAL_DIR=state/journal ADAPTER_AGENTS_DIR=state/agents ADAPTER_GATE=on \
  nohup node packages/adapter/src/main.mjs >> "$adapter_log" 2>&1 &
adapter_pid=$!
for _ in $(seq 1 20); do grep -q '"event":"listening"' "$adapter_log" && break; sleep 0.5; done
grep -q '"event":"listening".*"gate":true' "$adapter_log" || { cat "$adapter_log"; die "adapter did not start with the gate on"; }
ok "adapter listening, gate on"

write_gateway_cfg || exit 1
ok "adapter registered with the gateway (request + response bindings)"

echo "== provider for the purchasing token, sandboxes A and B"
openshell profile import -f deploy/openshell/poc-purchasing-profile.yaml >/dev/null || die "profile import"
created_profile=1
PURCHASING_TOKEN=$(cat state/purchasing-api-token) openshell provider create --name "$provider" --type "$profile_id" --credential PURCHASING_TOKEN >/dev/null || die "provider create"
created_provider=1
for pair in "$sb_a:A" "$sb_b:B"; do
  sb=${pair%%:*} key=${pair##*:}
  openshell sandbox create --name "$sb" --from "$SMOKE_IMAGE" --no-auto-providers --provider "$provider" \
    --policy deploy/openshell/m3-policy.yaml --detach -- sleep 1800 || die "sandbox create $sb"
  id=$(sandbox_id "$sb") || die "sandbox id for $sb"
  node packages/adapter/bin/bindings.mjs bind "$id" "$sb" "$key" >/dev/null || die "bind $sb"
  [[ $key == A ]] && sid_a=$id || sid_b=$id
done
ok "sandbox A $sid_a -> agent A; sandbox B $sid_b -> agent B"

placeholder=$(openshell sandbox exec -n "$sb_a" --no-tty -- sh -c 'printf %s "$PURCHASING_TOKEN"')
[[ "$placeholder" == *openshell:resolve* && "$placeholder" != "$(cat state/purchasing-api-token)" ]] \
  && ok "sandbox holds only a placeholder for the purchasing token" || bad "sandbox PURCHASING_TOKEN is not a placeholder"

echo "== governed purchases through OpenShell"
before=$(ledger_count)
r=$(buy "$sb_a" '{"amount":100,"currency":"MYR","merchant":"OfficeMart","items":[{"sku":"A4-PAPER","qty":10}]}')
echo "   A RM100 OfficeMart -> $(status_of "$r") $(body_of "$r" | head -c 200)"
[[ $(status_of "$r") == 201 ]] && ok "agent A's purchase executed (201 from the purchasing API)" || bad "agent A's purchase -> $(status_of "$r")"
after=$(ledger_count)
(( after == before + 1 )) && ok "exactly one ledger row was written" || bad "ledger changed by $((after - before)) (want 1)"

before=$(ledger_count)
r=$(buy "$sb_b" '{"amount":100,"currency":"MYR","merchant":"OfficeMart","items":[{"sku":"A4-PAPER","qty":10}]}')
code=$(body_of "$r" | grep -o '"reason_code":"[^"]*"' | cut -d'"' -f4)
if [[ $(status_of "$r") == 403 && "$code" == metamynd_merchant_not_allowed ]]; then
  ok "agent B's identical request denied ($code)"
elif [[ $(status_of "$r") == 000 && $(journal_last "$sid_b") == "block MERCHANT_NOT_ALLOWED" && $(ledger_count) == "$before" ]]; then
  # Seen once on COO-JASIM-NB1: the adapter denied, but OpenShell closed the connection without the 403 body.
  ok "agent B's identical request denied (MERCHANT_NOT_ALLOWED in the adapter journal; OpenShell returned an empty reply, no ledger row)"
else
  bad "agent B's identical request -> $(status_of "$r") ${code:-} (journal: $(journal_last "$sid_b"))"
fi

r=$(buy "$sb_b" '{"amount":100,"currency":"MYR","merchant":"PaperCo"}')
[[ $(status_of "$r") == 201 ]] && ok "agent B's own purchase at PaperCo executed" || bad "agent B at PaperCo -> $(status_of "$r")"

for case in '600:metamynd_sop_spend_cap' '350:metamynd_escalation_pending'; do
  amt=${case%%:*} want=${case##*:}
  r=$(buy "$sb_a" "{\"amount\":$amt,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}")
  code=$(body_of "$r" | grep -o '"reason_code":"[^"]*"' | cut -d'"' -f4)
  [[ "$code" == "$want" ]] && ok "agent A RM$amt -> $code" || bad "agent A RM$amt -> $(status_of "$r") ${code:-} (want $want)"
done

echo "== concurrency: $concurrent parallel purchases from each sandbox through one adapter"
before=$(ledger_count)
burst() { # <sandbox> <merchant>
  openshell sandbox exec -n "$1" --no-tty --env "MERCHANT=$2" --env "N=$concurrent" -- sh -c \
    'i=0; while [ $i -lt $N ]; do curl -sS -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $PURCHASING_TOKEN" --data-binary "{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"$MERCHANT\"}" https://host.openshell.internal:8443/purchase-requests & i=$((i+1)); done; wait'
}
burst "$sb_a" OfficeMart > state/m3-burst-a.txt 2>&1 &
pid_a=$!
burst "$sb_b" PaperCo > state/m3-burst-b.txt 2>&1 &
pid_b=$!
wait "$pid_a" "$pid_b" # only the bursts: a bare `wait` would also wait for the adapter, which never exits
codes_a=$(cat state/m3-burst-a.txt)
codes_b=$(cat state/m3-burst-b.txt)
rm -f state/m3-burst-a.txt state/m3-burst-b.txt
ok_a=$(grep -c '^201$' <<<"$codes_a" || true)
ok_b=$(grep -c '^201$' <<<"$codes_b" || true)
other=$(cat <<<"$codes_a"$'\n'"$codes_b" | grep -vE '^(201|403|)$' || true)
after=$(ledger_count)
# Safety (must hold): every executed purchase is exactly one ledger row, and every refusal failed closed.
(( after - before == ok_a + ok_b )) && ok "ledger grew by exactly the $((ok_a + ok_b)) purchases that returned 201" \
  || bad "ledger grew by $((after - before)) but $((ok_a + ok_b)) purchases returned 201"
[[ -z "$other" ]] && ok "every concurrent request either executed (201) or was refused (403)" || bad "unexpected statuses under concurrency: $(tr '\n' ' ' <<<"$other")"
# Availability (reported, not asserted): transient issuer failures under a burst fail closed.
if (( ok_a == concurrent && ok_b == concurrent )); then ok "availability under a $((2 * concurrent))-request burst: 100%"
else printf 'note  availability under a %d-request burst: A %d/%d, B %d/%d (refusals are fail-closed; reasons below)\n' "$((2 * concurrent))" "$ok_a" "$concurrent" "$ok_b" "$concurrent"; fi

echo "== evidence"
node - "$sid_a" "$sid_b" "$(enrolment_field 'e.agents.A.agentDid')" "$(enrolment_field 'e.agents.B.agentDid')" "$(cat state/purchasing-api-token)" <<'NODE'
const fs = require('fs');
const [sidA, sidB, didA, didB, token] = process.argv.slice(2);
const lines = fs.readdirSync('state/journal').filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => fs.readFileSync(`state/journal/${f}`, 'utf8').split('\n').filter(Boolean));
const recs = lines.map((l) => JSON.parse(l));
const mine = recs.filter((r) => r.sandboxId === sidA || r.sandboxId === sidB);
const say = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) process.exitCode = 1; };
const requests = mine.filter((r) => r.kind === 'request');
const crossed = requests.filter((r) => r.agentDid && ((r.sandboxId === sidA && r.agentDid !== didA) || (r.sandboxId === sidB && r.agentDid !== didB)));
say(crossed.length === 0, `no cross-attribution across ${requests.length} journaled decisions (sandbox A -> agent A, sandbox B -> agent B)`);
const allowed = requests.filter((r) => r.decision === 'allow');
const responses = new Map(mine.filter((r) => r.kind === 'response').map((r) => [r.requestId, r.statusCode]));
const joined = allowed.filter((r) => r.authorizationId && responses.has(r.requestId));
say(allowed.length > 0 && joined.length === allowed.length, `${joined.length}/${allowed.length} allowed decisions carry an authorizationId and a joined upstream response`);
const executed = allowed.filter((r) => responses.get(r.requestId) === 201).length;
const refusedUpstream = allowed.filter((r) => responses.has(r.requestId) && responses.get(r.requestId) !== 201);
console.log(`note  ${executed} allowed decisions executed (201); ${refusedUpstream.length} were refused by the purchasing gateway after the adapter allowed them`);
for (const r of requests.filter((x) => x.decision !== 'allow' && x.decision !== 'passthrough' && x.amount === 1)) {
  console.log(`note  burst refusal in ${r.sandboxId.slice(0, 8)}: ${r.decision} ${r.reasonCode ?? r.osReasonCode} (${r.latencyMs} ms)`);
}
say(!lines.some((l) => l.includes(token)), 'the purchasing token never appears in the adapter journal');
NODE
[[ $? -eq 0 ]] || fail=1
grep -qF "$(cat state/purchasing-api-token)" "$adapter_log" && bad "the purchasing token appears in the adapter log" || ok "the purchasing token never reached the adapter"
grep '"status":4' state/logs/gateway.log | sed 's/^/note  purchasing gateway refusal: /' | tail -n 5

cp "$adapter_log" "$out/m3-e2e-adapter.log"
cp state/logs/gateway.log "$out/m3-e2e-gateway.log"
exit "$fail"

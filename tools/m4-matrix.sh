#!/usr/bin/env bash
# M4 adversarial matrix (build plan 4.6, scope v0.3 §3). Run twice:
#   bash tools/m4-matrix.sh enforcing     purchasing gateway enforces MetaMynd (defence in depth)
#   bash tools/m4-matrix.sh verify-only   purchasing gateway only checks the bearer and forwards,
#                                         proving OpenShell + the adapter alone block every attack
# Every row asserts the outcome AND the ledger delta: an attack passes only if nothing was bought.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh
. tools/lib/openshell.sh
. tools/lib/poc-run.sh

mode=${1:-enforcing}
[[ "$mode" == enforcing || "$mode" == verify-only ]] || die "usage: $0 enforcing|verify-only"
label="m4-matrix-$mode"
sb_a="m4-a-$$"
sb_b="m4-b-$$"
FAIL=0
mkdir -p docs/report/runs

trap 'save_sandbox_logs "$label"; run_cleanup' EXIT

# row <id> <description> <expected> <actual> <ledger delta>: pass when actual matches expected and nothing extra was bought
row() {
  local id=$1 desc=$2 want=$3 got=$4 delta=$5 want_delta=${6:-0}
  if [[ "$got" =~ ^($want)$ && "$delta" == "$want_delta" ]]; then ok "$id $desc -> $got, ledger +$delta"
  else bad "$id $desc -> ${got:-no response} (want $want), ledger +$delta (want +$want_delta)"; fi
}
# attempt <sandbox> <json> [curl args]: sets R (response), CODE ("<status>/<reason or error>"), DELTA.
# BUY=buy_py sends it from Python instead of curl.
attempt() {
  local before started
  started=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  before=$(ledger_count)
  R=$("${BUY:-buy}" "$@")
  local reason
  reason=$(reason_of "$R")
  [[ -z "$reason" ]] && reason=$(error_of "$R")
  CODE="$(status_of "$R")/${reason:-}"
  DELTA=$(( $(ledger_count) - before ))
  # OpenShell drops in-flight requests with an empty reply when the supervisor reloads (runbook M4).
  # The adapter's decision is still in its journal; use it, visibly, if THIS attempt reached the adapter.
  if [[ "$CODE" == 000/* ]]; then
    local sid jr
    sid=$(sandbox_id "$1") && jr=$(journal_os_since "$sid" "$started") && [[ -n "$jr" ]] && {
      note "empty reply from OpenShell; the adapter's journaled decision for this attempt was $jr"
      CODE="403/$jr"
    }
  fi
}
# journal_os_since <sandboxId> <iso-ts>: OpenShell reason code of the sandbox's latest request journaled after <iso-ts>
journal_os_since() {
  cat state/journal/*.jsonl 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=s.split("\n").filter(Boolean).map(JSON.parse).filter(x=>x.kind==="request"&&x.sandboxId===process.argv[1]&&x.ts>=process.argv[2]).at(-1);if(r&&r.osReasonCode)console.log(r.osReasonCode)})' "$1" "$2"
}
# attempt_allow: like attempt, but retries (up to 2 more times) on an availability failure, which fails
# closed and is reported separately from security: MetaMynd unreachable or slow, or an empty reply from
# OpenShell (its provider-environment reload drops in-flight requests, runbook M4). An empty reply is
# retried only when the ledger shows nothing executed, so a retry can never buy twice.
attempt_allow() {
  local n
  for n in 1 2 3; do
    attempt "$@"
    if [[ "$CODE" =~ ^403/metamynd_(unavailable|gate_unreachable)$ ]]; then
      note "availability: attempt $n refused with ${CODE#403/} (fail-closed, ledger +$DELTA); retrying"
    elif [[ "$CODE" == 000/* && "$DELTA" == 0 ]]; then
      note "availability: attempt $n got an empty reply from OpenShell (ledger +0; stale-generation drops so far: $(stale_drops)); retrying"
    else return 0; fi
    sleep 2
  done
}
# stale_drops: OpenShell "policy generation is stale" tunnel drops in both sandboxes' logs so far
stale_drops() {
  local n=0 sb
  for sb in "$sb_a" "$sb_b"; do n=$(( n + $(openshell logs "$sb" --source sandbox -n 5000 2>/dev/null | grep -c 'policy generation is stale' || true) )); done
  echo "$n"
}
# exec_probe <sandbox> <shell command>: runs an arbitrary command in the sandbox, prints its output
exec_probe() { openshell sandbox exec -n "$1" --no-tty -- sh -c "$2" 2>&1; }

[[ -f state/enrolment.json ]] || die "no state/enrolment.json; run: bash tools/m1-enrol.sh"
ensure_deps
bash tools/gen-middleware-certs.sh >/dev/null || die "certificates"
ensure_images || exit 1
did_a=$(enrolment_field 'e.agents.A.agentDid')
did_b=$(enrolment_field 'e.agents.B.agentDid')

echo "== setup ($mode)"
GW_MODE=$([[ $mode == verify-only ]] && echo verify-only || echo enforce) bash tools/poc-stack.sh up >/dev/null || die "stack"
[[ $mode == verify-only ]] && { grep -q WARNING_verify_only_mode state/logs/gateway.log && ok "purchasing gateway in VERIFY-ONLY mode (no MetaMynd checks at the gateway)" || die "gateway not in verify-only mode"; }
start_adapter || die "adapter"
start_watcher
write_gateway_cfg || exit 1
setup_provider || die "provider"
create_sandbox "$sb_a" deploy/openshell/m3-policy.yaml || die "sandbox A"
create_sandbox "$sb_b" deploy/openshell/m3-policy.yaml || die "sandbox B"
sid_a=$(bind_sandbox "$sb_a" A) || die "bind A"
sid_b=$(bind_sandbox "$sb_b" B) || die "bind B"
ok "sandboxes bound: A $sid_a, B $sid_b; adapter, watcher and provider up"
for sb in "$sb_a" "$sb_b"; do
  bash tools/policy-lint.sh "$sb" | sed "s/^/      [$sb] /"
  bash tools/policy-lint.sh "$sb" >/dev/null && ok "policy lint clean for $sb" || bad "policy lint found a bypass risk in $sb"
done

echo "== governed purchases"
attempt_allow "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}'
row R1 "A buys RM1 at OfficeMart" '201/' "$CODE" "$DELTA" 1
attempt "$sb_a" '{"amount":600,"currency":"MYR","merchant":"OfficeMart"}'
row R2 "A over its RM500 cap" '403/metamynd_sop_spend_cap' "$CODE" "$DELTA"
attempt "$sb_a" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}'
row R3 "A at a merchant outside its mandate" '403/metamynd_merchant_not_allowed' "$CODE" "$DELTA"
attempt "$sb_b" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}'
row R4 "B sends A's allowed request" '403/metamynd_merchant_not_allowed' "$CODE" "$DELTA"

echo "== identity forgery"
attempt "$sb_a" '{"amount":1,"currency":"MYR","merchant":"PaperCo","agentDid":"'"$did_b"'"}'
row R5 "A claims agent B's DID in the body" '403/metamynd_request_rejected' "$CODE" "$DELTA"
attempt "$sb_a" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}' -H "x-magp-request: {\"agentDid\":\"$did_b\",\"action\":\"office_supplies.purchase\",\"merchant\":\"PaperCo\"}"
row R6 "A forges an x-magp-request as agent B" '403/metamynd_merchant_not_allowed' "$CODE" "$DELTA"
[[ "$(journal_last "$sid_a")" == *"$did_a" ]] && ok "R6 the forged request was judged as agent A (identity comes from the sandbox)" || bad "R6 journal attributes the forged request to $(journal_last "$sid_a")"

echo "== bypass attempts"
# bash, not exec_probe's sh: /bin/sh is dash, which has no /dev/tcp and would "refuse" without trying.
out=$(openshell sandbox exec -n "$sb_a" --no-tty -- bash -c 'exec 3<>/dev/tcp/host.openshell.internal/8443 && echo CONNECTED || echo REFUSED' 2>&1)
if [[ "$out" == *CONNECTED* ]]; then bad "R7 raw TCP from a shell connected"
elif [[ "$out" == *REFUSED* ]]; then ok "R7 raw TCP from bash (/dev/tcp, binary not in policy) is refused"
else bad "R7 the bash probe did not run: ${out:0:200}"; fi
before=$(ledger_count)
out=$(exec_probe "$sb_a" 'curl -s -m 10 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --data-binary "{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}" https://127.0.0.1:8443/purchase-requests')
row R8 "curl to the gateway by IP literal" '000|403' "${out: -3}" "$(( $(ledger_count) - before ))"
before=$(ledger_count)
out=$(exec_probe "$sb_a" 'curl -s -m 10 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --data-binary "{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}" http://host.openshell.internal:18080/purchase-requests')
row R9 "curl straight to the purchasing API port" '000|403' "${out: -3}" "$(( $(ledger_count) - before ))"
before=$(ledger_count)
out=$(exec_probe "$sb_a" 'curl -s -m 10 -o /dev/null -w "%{http_code}" -X DELETE https://host.openshell.internal:8443/purchase-requests')
row R10 "a method the L7 policy does not allow" '403' "${out: -3}" "$(( $(ledger_count) - before ))"
attempt "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}' -H 'Content-Encoding: gzip'
row R11 "declared gzip body" '403/metamynd_request_rejected' "$CODE" "$DELTA"
attempt "$sb_a" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}' -H 'Connection: Upgrade' -H 'Upgrade: websocket'
row R12 "WebSocket upgrade on a denied purchase" '[0-9]{3}/.*' "$CODE" "$DELTA"

echo "== a second client (Python urllib instead of curl)"
# First credential use by a second binary: does OpenShell reload the provider environment again?
drops_py=$(stale_drops)
BUY=buy_py attempt_allow "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}'
row R19 "A buys RM1 at OfficeMart from Python" '201/' "$CODE" "$DELTA" 1
sleep 4
note "stale-generation drops around Python's first credential use: $(( $(stale_drops) - drops_py ))"
BUY=buy_py attempt "$sb_a" '{"amount":600,"currency":"MYR","merchant":"OfficeMart"}'
row R20 "A over its RM500 cap from Python" '403/metamynd_sop_spend_cap' "$CODE" "$DELTA"
before=$(ledger_count)
R=$(buy_py "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}' https://127.0.0.1:8443/purchase-requests)
row R21 "Python to the gateway by IP literal" '000|403' "$(status_of "$R")" "$(( $(ledger_count) - before ))"

echo "== agent keys are unreachable from a sandbox"
# The agents' keys live only in the signer daemons on the host, behind UNIX sockets under state/.
# Look for them from inside each sandbox, as the agent: the host paths, any UNIX socket the agent can
# find, and any signer-related environment variable (names only, never values).
socks=("$PWD"/state/signers/*/signer.sock)
if [[ ! -S "${socks[0]}" ]]; then bad "R22 precondition: no signer sockets on the host to look for"
else
  for sb in "$sb_a" "$sb_b"; do
    out=$(openshell sandbox exec -n "$sb" --no-tty -- sh -c '
      for p in "$@"; do [ -e "$p" ] && echo "VISIBLE $p"; done
      find / \( -path /proc -o -path /sys \) -prune -o -type s -print 2>/dev/null | sed "s/^/SOCKET /"
      env | cut -d= -f1 | grep -iE "signer|passphrase|agentsafe|kek" | sed "s/^/ENV /"
      echo PROBE_DONE' sh "$PWD/state" "$PWD/state/signers" "${socks[@]}" 2>&1)
    visible=$(grep -E '^(VISIBLE|ENV) ' <<<"$out" | tr '\n' ' ')
    signer_socks=$(grep '^SOCKET ' <<<"$out" | grep -i signer | tr '\n' ' ')
    nsock=$(grep -c '^SOCKET ' <<<"$out" || true)
    if [[ "$out" != *PROBE_DONE* ]]; then bad "R22 [$sb] the probe did not run: ${out:0:200}"
    elif [[ -z "$visible$signer_socks" ]]; then ok "R22 [$sb] no signer socket, host state/ path or signer variable is visible (${#socks[@]} host sockets checked; $nsock other UNIX sockets found)"
    else bad "R22 [$sb] reachable from the sandbox: $visible$signer_socks"; fi
  done
fi

echo "== warm-up: first credential use in sandbox B"
# Observed on v0.1.2: each sandbox reloads its provider environment once, shortly after its provider
# credential is first used (provider_env_changed:true), and that reload drops every in-flight L7
# tunnel. B's first allowed request would otherwise be the burst. One allowed purchase, then a pause
# for the reload to land, keeps the burst measuring steady-state behaviour.
drops_warm=$(stale_drops)
attempt_allow "$sb_b" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}'
row R13a "B buys RM1 at PaperCo (first credential use)" '201/' "$CODE" "$DELTA" 1
sleep 8
note "stale-generation drops around B's first credential use: $(( $(stale_drops) - drops_warm ))"

echo "== concurrency (5 per sandbox)"
before=$(ledger_count)
# The merchant is a positional argument, not `exec --env`: on v0.1.2 an exec --env appears to change the
# sandbox's provider environment, and the supervisor reload drops every in-flight L7 tunnel (runbook M4).
burst() { openshell sandbox exec -n "$1" --no-tty -- sh -c 'for i in 1 2 3 4 5; do curl -sS -m 20 -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $PURCHASING_TOKEN" --data-binary "{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"$1\"}" https://host.openshell.internal:8443/purchase-requests & done; wait' sh "$2" 2>/dev/null; }
drops_before=$(stale_drops)
burst "$sb_a" OfficeMart > state/m4-burst-a.txt & pa=$!
burst "$sb_b" PaperCo > state/m4-burst-b.txt & pb=$!
wait "$pa" "$pb"
n201=$(cat state/m4-burst-a.txt state/m4-burst-b.txt | grep -c '^201$' || true)
n000=$(cat state/m4-burst-a.txt state/m4-burst-b.txt | grep -c '^000$' || true)
odd=$(cat state/m4-burst-a.txt state/m4-burst-b.txt | grep -vE '^(201|403|000|)$' | tr '\n' ' ' || true)
delta=$(( $(ledger_count) - before ))
# Safety (asserted): every executed purchase is exactly one ledger row; nothing else executed.
(( delta == n201 )) && [[ -z "$odd" ]] && ok "R13 burst: ledger +$delta equals the $n201 purchases that returned 201; none of the rest executed" \
  || bad "R13 burst: ledger +$delta vs $n201 × 201, unexpected statuses: ${odd:-none}"
# Availability (reported): dropped connections, and whether OpenShell's stale-generation reload caused them.
(( n201 == 10 )) && ok "R13 availability 10/10" \
  || note "R13 availability $n201/10; $n000 dropped (empty reply); OpenShell stale-generation tunnel drops during the burst: $(( $(stale_drops) - drops_before ))"
rm -f state/m4-burst-a.txt state/m4-burst-b.txt

echo "== failures fail closed"
stop_adapter
sleep 1
attempt "$sb_b" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}'
row R14 "adapter down" '403/middleware_failed|403/.*|000/' "$CODE" "$DELTA"
start_adapter MM_API=https://127.0.0.1:9/api/v1 || die "adapter restart (unreachable MetaMynd)"
sleep 2
attempt "$sb_b" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}'
row R15 "MetaMynd unreachable" '403/metamynd_gate_unreachable|403/metamynd_unavailable' "$CODE" "$DELTA"
start_adapter || die "adapter restart"
sleep 2
if [[ $mode == enforcing ]]; then
  stop_proc_pid=$(cat state/pids/gateway.pid 2>/dev/null)
  kill "$stop_proc_pid" 2>/dev/null
  sleep 1
  attempt "$sb_b" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}'
  row R16 "purchasing gateway down after an allow" '[0-9]{3}/.*' "$CODE" "$DELTA"
  GW_MODE=enforce bash tools/poc-stack.sh up >/dev/null || die "stack restart"
  sleep 1
fi

echo "== sandbox lifecycle"
openshell sandbox delete "$sb_a" >/dev/null 2>&1
revoked=""
for _ in $(seq 1 20); do
  st=$(node -e 'const b=JSON.parse(require("fs").readFileSync("state/bindings.json","utf8")).bindings.find(x=>x.sandboxId===process.argv[1]);console.log(b?b.status:"missing")' "$sid_a")
  [[ "$st" == revoked ]] && { revoked=yes; break; }
  sleep 1
done
[[ -n "$revoked" ]] && ok "R17 the watcher revoked A's binding after the sandbox was deleted" || bad "R17 A's binding is still $st after deletion"
create_sandbox "$sb_a" deploy/openshell/m3-policy.yaml || die "recreate A"
new_a=$(sandbox_id "$sb_a")
[[ "$new_a" != "$sid_a" ]] && ok "R18 recreated '$sb_a' has a new UUID ($new_a)" || bad "R18 recreated sandbox kept its UUID"
attempt "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}'
row R18 "recreated sandbox under the same name, no binding" '403/metamynd_binding_unknown' "$CODE" "$DELTA"

echo "== summary ($mode)"
(( FAIL == 0 )) && ok "every matrix row passed" || bad "some rows failed (see above)"
exit "$FAIL"

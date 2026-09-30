#!/usr/bin/env bash
# Five-minute demo runner (integration report, "Demo"; narration in docs/report/demo-script.md).
# Sets up the stack off camera, then plays each scene: a caption, the command it runs inside the
# sandbox, and the result in plain language. It pauses between scenes.
#   bash tools/demo.sh                            press Enter to advance each scene
#   DEMO_AUTO=6 bash tools/demo.sh                advance automatically after 6 s
#   DEMO_GW_MODE=verify-only bash tools/demo.sh   purchasing gateway without MetaMynd checks
#   DEMO_CLEAR=0 bash tools/demo.sh               do not clear the screen between scenes
# It never prints DIDs, sandbox UUIDs or the purchasing token. The escalations it creates wait in the
# POC tenant's review queue and expire after 24 h.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh
. tools/lib/openshell.sh
. tools/lib/poc-run.sh

FAIL=0
sb_a="demo-agent-a"
sb_b="demo-agent-b"
gw_mode=${DEMO_GW_MODE:-enforce}
[[ "$gw_mode" == enforce || "$gw_mode" == verify-only ]] || die "DEMO_GW_MODE must be enforce or verify-only"
api="https://host.openshell.internal:8443/purchase-requests"
MISMATCH=()
SCENE=""

if [[ -t 1 ]]; then C_B=$'\e[1m' C_DIM=$'\e[2m' C_OK=$'\e[32m' C_NO=$'\e[31m' C_INFO=$'\e[33m' C_T=$'\e[36m' C_OFF=$'\e[0m'
else C_B="" C_DIM="" C_OK="" C_NO="" C_INFO="" C_T="" C_OFF=""; fi

scene() {
  SCENE=$1
  (( ${DEMO_CLEAR:-1} )) && [[ -t 1 ]] && clear
  printf '\n%s%s%s\n' "$C_B$C_T" "$1" "$C_OFF"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2"
  echo
}
cmd()     { printf '%s$ %s%s\n' "$C_DIM" "$1" "$C_OFF"; }
good()    { printf '  %s✔ %s%s\n' "$C_OK" "$1" "$C_OFF"; }
blocked() { printf '  %s✘ %s%s\n' "$C_NO" "$1" "$C_OFF"; }
info()    { printf '  %s%s%s\n' "$C_INFO" "$1" "$C_OFF"; }
dim()     { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
advance() {
  echo
  if [[ -n "${DEMO_AUTO:-}" ]]; then sleep "$DEMO_AUTO"; else read -r -p "${C_DIM}  [Enter]${C_OFF}" _ </dev/tty; fi
}

explain() {
  case "$1" in
    metamynd_merchant_not_allowed) echo "this agent's mandate does not cover that supplier" ;;
    metamynd_sop_spend_cap)        echo "over the organisation's per-purchase limit" ;;
    metamynd_escalation_pending)   echo "a person must approve it; sent to the review queue" ;;
    metamynd_binding_unknown)      echo "this sandbox is not bound to any agent" ;;
    metamynd_request_rejected)     echo "the request is not in a form MetaMynd will sign" ;;
    *)                             echo "$1" ;;
  esac
}
# journal_reason <sandboxId>: MetaMynd's own reason code for the sandbox's latest decision (no DID)
journal_reason() {
  cat state/journal/*.jsonl 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=s.split("\n").filter(Boolean).map(JSON.parse).filter(x=>x.kind==="request"&&x.sandboxId===process.argv[1]).at(-1);console.log(r?.reasonCode??"")})' "$1"
}

# purchase <sandbox> <json> [buy|buy_py]: sets ST, RC, L0, L1, DELTA. An empty reply from OpenShell with
# nothing executed (its provider reload, runbook M4) is retried visibly; a retry can never buy twice.
purchase() {
  local fn=${3:-buy} n
  for n in 1 2 3; do
    L0=$(ledger_count)
    local r
    r=$("$fn" "$1" "$2")
    ST=$(status_of "$r"); RC=$(reason_of "$r"); L1=$(ledger_count); DELTA=$(( L1 - L0 ))
    [[ "$ST" == 000 && "$DELTA" == 0 && $n -lt 3 ]] || return 0
    dim "(OpenShell closed the connection before answering; nothing executed; retrying)"
    sleep 2
  done
}
# result: the last purchase in plain language, plus the ledger before and after
result() {
  if [[ "$ST" == 201 ]]; then good "201 Created: the purchase executed"
  elif [[ "$ST" == 403 && -n "$RC" ]]; then blocked "403 Forbidden: $(explain "$RC")"; dim "reason_code: $RC"
  else blocked "no response (status $ST)"; fi
  printf '  Ledger: %s → %s\n' "$L0" "$L1"
}
# expect <status> <reason regex> <ledger delta>: records a mismatch for the operator's summary
expect() {
  [[ "$ST" == "$1" && "$RC" =~ ^($2)$ && "$DELTA" == "$3" ]] && return 0
  MISMATCH+=("$SCENE: got $ST ${RC:-} ledger +$DELTA (expected $1 ${2:-} +$3)")
}

trap 'run_cleanup' EXIT

# ---------------------------------------------------------------- setup (off camera)
echo "Preparing the demo (about a minute; not part of the recording)..."
[[ -f state/enrolment.json ]] || die "no state/enrolment.json; run: bash tools/m1-enrol.sh"
require_env MM_USERNAME MM_PASSWORD || exit 1
ensure_deps
bash tools/gen-middleware-certs.sh >/dev/null || die "certificates"
ensure_images || exit 1
for sb in "$sb_a" "$sb_b"; do openshell sandbox delete "$sb" >/dev/null 2>&1 || true; done
GW_MODE=$gw_mode bash tools/poc-stack.sh up >/dev/null || die "stack"
start_adapter || die "adapter"
write_gateway_cfg || exit 1
setup_provider || die "provider"
create_sandbox "$sb_a" deploy/openshell/m3-policy.yaml || die "sandbox A"
create_sandbox "$sb_b" deploy/openshell/m3-policy.yaml || die "sandbox B"
sid_a=$(bind_sandbox "$sb_a" A) || die "bind A"
sid_b=$(bind_sandbox "$sb_b" B) || die "bind B"
# Warm every binary that will use the credential, then let OpenShell's provider reloads land (runbook M4).
buy "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}' >/dev/null
buy_py "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}' >/dev/null
buy "$sb_b" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}' >/dev/null
sleep 8
since=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
t0=$(date +%s)
start_ledger=$(ledger_count)
ok "ready (purchasing gateway: $gw_mode). Start recording, then press Enter."
advance

# ---------------------------------------------------------------- 1. the question
scene "When an AI agent acts outside its mandate, can we stop it before it reaches the business system, and show why?"
cat <<EOF
  Two procurement agents, each in its own NVIDIA OpenShell sandbox.
  One MetaMynd decision service. One purchasing system.

    agent A ─┐                       ┌─ MetaMynd: is THIS agent authorised for THIS purchase?
             ├─ OpenShell sandbox ───┤
    agent B ─┘   (egress, secrets)   └─ purchasing system + ledger

  Agent A may buy from OfficeMart (up to RM500; over RM300 needs approval).
  Agent B may buy from PaperCo (up to RM200).
EOF
advance

# ---------------------------------------------------------------- 2. no secrets in the sandbox
scene "The agent holds no secrets" "OpenShell gives the agent a placeholder. The real API token is swapped in only after MetaMynd approves."
cmd "printenv PURCHASING_TOKEN        # inside $sb_a"
token=$(openshell sandbox exec -n "$sb_a" --no-tty -- sh -c 'printf %s "$PURCHASING_TOKEN"' 2>/dev/null)
printf '  %s\n' "${token:0:48}"
if [[ "$token" == openshell:resolve* && "$token" != "$(cat state/purchasing-api-token)" ]]; then good "only a placeholder: the real token never enters the sandbox"
else blocked "unexpected value"; MISMATCH+=("$SCENE: PURCHASING_TOKEN is not a placeholder"); fi
cmd "ls <host signer sockets>          # inside $sb_a"
seen=$(openshell sandbox exec -n "$sb_a" --no-tty -- sh -c '[ -e "$1" ] && echo VISIBLE || echo absent' sh "$PWD/state/signers" 2>/dev/null)
if [[ "$seen" == *absent* ]]; then good "the agents' signing keys live outside the sandbox and cannot be reached from it"
else blocked "signer directory visible"; MISMATCH+=("$SCENE: signer directory visible from the sandbox"); fi
advance

# ---------------------------------------------------------------- 3. an allowed purchase
scene "Agent A buys from its approved supplier" "OpenShell intercepts the request; MetaMynd checks agent A's live mandate; the purchasing system settles."
cmd "curl -X POST $api -d '{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}'   # inside $sb_a"
purchase "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart","items":[{"sku":"A4-PAPER","qty":10}]}'
result; expect 201 '' 1
(( DELTA == 1 )) && good "exactly one ledger row"
advance

# ---------------------------------------------------------------- 4. the identical request from agent B
scene "Agent B sends the identical request" "Same bytes, different agent. Identity comes from the sandbox OpenShell attests, not from the request."
cmd "curl -X POST $api -d '{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}'   # inside $sb_b"
purchase "$sb_b" '{"amount":1,"currency":"MYR","merchant":"OfficeMart","items":[{"sku":"A4-PAPER","qty":10}]}'
result; expect 403 metamynd_merchant_not_allowed 0
advance

# ---------------------------------------------------------------- 5. the organisation's rules
scene "The organisation's rules" "Limits and approval thresholds set by the principal, enforced before anything reaches the purchasing system."
cmd "curl -X POST $api -d '{\"amount\":600,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}'   # inside $sb_a"
purchase "$sb_a" '{"amount":600,"currency":"MYR","merchant":"OfficeMart"}'
result; expect 403 metamynd_sop_spend_cap 0
echo
cmd "curl -X POST $api -d '{\"amount\":350,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}'   # inside $sb_a"
purchase "$sb_a" '{"amount":350,"currency":"MYR","merchant":"OfficeMart"}'
result; expect 403 metamynd_escalation_pending 0
[[ "$RC" == metamynd_escalation_pending ]] && { dim "MetaMynd reason: $(journal_reason "$sid_a")"; info "Now waiting for the accountable principal in the metamynd.ai review queue."; }
advance

# ---------------------------------------------------------------- 6. behaviour, not just rules
scene "Behaviour, not just rules" "RM100 is within every limit, but agent A has only ever bought at RM1. MetaMynd flags the jump for a person."
cmd "curl -X POST $api -d '{\"amount\":100,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}'   # inside $sb_a"
purchase "$sb_a" '{"amount":100,"currency":"MYR","merchant":"OfficeMart"}'
result
if [[ "$RC" == metamynd_escalation_pending ]]; then dim "MetaMynd reason: $(journal_reason "$sid_a")"
elif [[ "$ST" == 201 ]]; then info "Allowed: this agent has no unusual history to compare against."; fi
advance

# ---------------------------------------------------------------- 7. trying to get around it
scene "Trying to get around it" "Every path out of the sandbox goes through OpenShell, whatever program the agent uses."
[[ "$gw_mode" == verify-only ]] && info "In this run the purchasing system does NO MetaMynd checks: OpenShell and the adapter alone decide." && echo
cmd "bash: exec 3<>/dev/tcp/host.openshell.internal/8443   # raw TCP from a shell"
out=$(openshell sandbox exec -n "$sb_a" --no-tty -- bash -c 'exec 3<>/dev/tcp/host.openshell.internal/8443 && echo CONNECTED || echo REFUSED' 2>&1)
if [[ "$out" == *CONNECTED* ]]; then blocked "the connection opened"; MISMATCH+=("$SCENE: raw TCP from bash connected")
else good "refused by OpenShell: bash is not a program the policy allows to reach the purchasing host"; fi
echo
cmd "curl -X POST https://127.0.0.1:8443/purchase-requests ...   # the gateway by IP address"
L0=$(ledger_count)
out=$(openshell sandbox exec -n "$sb_a" --no-tty -- sh -c 'curl -s -m 10 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --data-binary "{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}" https://127.0.0.1:8443/purchase-requests' 2>/dev/null)
L1=$(ledger_count)
[[ "${out: -3}" =~ ^(000|403)$ && "$L1" == "$L0" ]] && good "blocked by OpenShell (no route); ledger unchanged" || { blocked "status ${out: -3}, ledger $L0 → $L1"; MISMATCH+=("$SCENE: IP literal returned ${out: -3}"); }
echo
cmd "curl -X POST http://host.openshell.internal:18080/purchase-requests ...   # the purchasing API directly"
L0=$(ledger_count)
out=$(openshell sandbox exec -n "$sb_a" --no-tty -- sh -c 'curl -s -m 10 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --data-binary "{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}" http://host.openshell.internal:18080/purchase-requests' 2>/dev/null)
L1=$(ledger_count)
[[ "${out: -3}" =~ ^(000|403)$ && "$L1" == "$L0" ]] && good "blocked by OpenShell (port not in policy); ledger unchanged" || { blocked "status ${out: -3}, ledger $L0 → $L1"; MISMATCH+=("$SCENE: direct API port returned ${out: -3}"); }
echo
cmd "python3 -c 'urllib.request.urlopen(...)'  # RM600 from Python instead of curl"
purchase "$sb_a" '{"amount":600,"currency":"MYR","merchant":"OfficeMart"}' buy_py
result; expect 403 metamynd_sop_spend_cap 0
advance

# ---------------------------------------------------------------- 8. one trace
scene "One trace, four sources" "Each decision joins OpenShell's log, the adapter's journal, MetaMynd's anchored evidence and the ledger."
wait_s=$(( 75 - ($(date +%s) - t0) ))
while (( wait_s > 0 )); do printf '\r  %sMetaMynd anchors decisions in batches: %2d s%s' "$C_DIM" "$wait_s" "$C_OFF"; sleep 1; wait_s=$((wait_s - 1)); done
printf '\r%60s\r' ""
for sb in "$sb_a" "$sb_b"; do openshell logs "$sb" --source sandbox -n 5000 > "state/demo-$sb.log" 2>&1; done
ev=$(LEDGER_TOKEN=$(cat state/ledger-token) node packages/poc-cli/bin/evidence.mjs --since "$since" --out state/demo-evidence \
  --log "$sb_a=state/demo-$sb_a.log" --log "$sb_b=state/demo-$sb_b.log" 2>&1)
ev_rc=$?
grep '^|' <<<"$ev" | sed 's/^/  /'
echo
if (( ev_rc == 0 )); then good "every decision joined: OpenShell ↔ adapter ↔ MetaMynd evidence and Merkle proof ↔ ledger"
else blocked "some decisions did not join (see state/demo-evidence.md)"; MISMATCH+=("$SCENE: evidence join incomplete"); fi
advance

# ---------------------------------------------------------------- 9. close
scene "What each layer did"
executed=$(( $(ledger_count) - start_ledger ))
if (( executed == 1 )); then executed_line="1 purchase executed during the demo, exactly once."
else executed_line="$executed purchases executed during the demo, each exactly once."; fi
cat <<EOF
  OpenShell:  contained both agents, kept the API token out of the sandbox,
              and refused every path that avoided the inspected route.
  MetaMynd:   decided each purchase against the agent's live mandate, the
              organisation's rules and the agent's behaviour, and escalated
              to a named person when required.
  Together:   $executed_line
              Nothing else reached the ledger.
EOF
echo
if (( ${#MISMATCH[@]} )); then
  FAIL=1
  printf '%sOperator check (edit out of the recording):%s\n' "$C_B" "$C_OFF"
  printf '  %s\n' "${MISMATCH[@]}"
fi
advance
exit "$FAIL"

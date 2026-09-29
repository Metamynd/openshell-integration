#!/usr/bin/env bash
# Start or stop the POC's MetaMynd side on this host:
#   signer daemons (agents A and B, and the gateway's service key) bound to their DIDs,
#   the mock purchasing API on 127.0.0.1:18080 (ledger: state/purchasing-ledger.sqlite),
#   the purchasing gateway on https://127.0.0.1:8443 (TLS: state/certs/server.pem).
# Usage: bash tools/poc-stack.sh up|down|status
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh

start_proc() { # <name> <ready-regex> <cmd...>
  local name=$1 ready=$2
  shift 2
  stop_proc "$name"
  : > "state/logs/$name.log"
  nohup "$@" >> "state/logs/$name.log" 2>&1 &
  echo $! > "state/pids/$name.pid"
  for _ in $(seq 1 40); do grep -qE "$ready" "state/logs/$name.log" && return 0; sleep 0.5; done
  echo "FAIL  $name did not start; last log lines:"
  tail -n 20 "state/logs/$name.log"
  return 1
}

stop_proc() {
  local pidfile="state/pids/$1.pid"
  [[ -f "$pidfile" ]] && { kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; }
}

up() {
  require_env AGENTSAFE_SIGNER_PASSPHRASE || return 1
  [[ -f state/enrolment.json ]] || { echo "FAIL  no state/enrolment.json; run: bash tools/m1-enrol.sh"; return 1; }
  ensure_deps
  bash tools/gen-middleware-certs.sh >/dev/null || return 1
  local did_a did_b svc policy_key
  did_a=$(enrolment_field 'e.agents.A.agentDid') && did_b=$(enrolment_field 'e.agents.B.agentDid') \
    && svc=$(enrolment_field 'e.serviceDid') && policy_key=$(enrolment_field 'e.policyPublicKey') \
    || { echo "FAIL  state/enrolment.json is incomplete; re-run tools/m1-enrol.sh"; return 1; }

  start_signer agentA agent "$did_a" || return 1
  start_signer agentB agent "$did_b" || return 1
  start_signer gw service "$svc" || return 1
  echo "ok    signers up (agent A, agent B, gateway service key)"

  MOCK_LEDGER_TOKEN=$(private_token state/ledger-token) MOCK_DB=state/purchasing-ledger.sqlite \
    start_proc mock '"event":"listening"' node packages/mock-purchasing/src/main.mjs || return 1
  echo "ok    mock purchasing API on 127.0.0.1:18080"

  GW_TLS_CERT=state/certs/server.pem GW_TLS_KEY=state/certs/server.key GW_UPSTREAM=http://127.0.0.1:18080 \
    SERVICE_DID="$svc" SERVICE_SIGNER_SOCKET=state/signers/gw/signer.sock MM_POLICY_PUBLIC_KEY="$policy_key" \
    PURCHASING_API_TOKEN=$(private_token state/purchasing-api-token) \
    start_proc gateway '"event":"listening"' node packages/purchasing-gateway/src/main.mjs || return 1
  echo "ok    purchasing gateway on https://127.0.0.1:8443 (service $svc)"
}

down() {
  stop_proc gateway
  stop_proc mock
  for s in agentA agentB gw; do stop_signer "$s"; done
  echo "== POC stack stopped"
}

status() {
  for f in state/pids/*.pid state/signers/*/daemon.pid; do
    [[ -f "$f" ]] || continue
    if kill -0 "$(cat "$f")" 2>/dev/null; then echo "up    $f"; else echo "down  $f (stale)"; fi
  done
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status"; exit 2 ;;
esac

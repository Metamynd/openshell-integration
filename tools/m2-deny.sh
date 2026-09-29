#!/usr/bin/env bash
# M2 exit test (build plan): the real adapter, registered with the local OpenShell gateway over
# TLS with JWT checks, denies every request from a bound sandbox with the right reason_code,
# journals each decision, and nothing reaches the purchasing gateway. The MetaMynd allow path is
# not enabled yet (M3), so a fully valid purchase is denied with metamynd_gate_not_configured.
# Needs: tools/m1-enrol.sh done; .env.poc with AGENTSAFE_SIGNER_PASSPHRASE.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh
. tools/lib/openshell.sh

name="m2-deny-$$"
out="docs/report/runs"
mkdir -p "$out"
adapter_log=state/logs/adapter.log
fail=0
adapter_pid=""
sid=""

ok()  { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
die() { printf 'FAIL  %s\n' "$1"; exit 1; }

cleanup() {
  openshell sandbox delete "$name" >/dev/null 2>&1 || true
  [[ -n "$sid" ]] && node packages/adapter/bin/bindings.mjs revoke "$sid" >/dev/null 2>&1
  restore_gateway_cfg
  [[ -n "$adapter_pid" ]] && kill "$adapter_pid" 2>/dev/null
  bash tools/poc-stack.sh down >/dev/null
}
trap cleanup EXIT

[[ -f state/enrolment.json ]] || die "no state/enrolment.json; run: bash tools/m1-enrol.sh"
ensure_deps
bash tools/gen-middleware-certs.sh >/dev/null || die "certificates"
ensure_images || exit 1

echo "== purchasing stack (signers, mock API, gateway)"
bash tools/poc-stack.sh up || exit 1
gw_requests_before=$(grep -c '"method":' state/logs/gateway.log || true)

echo "== starting the MetaMynd adapter on 127.0.0.1:50051 (TLS + gateway JWT, deny path only)"
: > "$adapter_log"
ADAPTER_TLS_CERT=state/certs/server.pem ADAPTER_TLS_KEY=state/certs/server.key OPENSHELL_JWT_DIR="$OPENSHELL_JWT_DIR" \
  ADAPTER_REGISTRY=state/bindings.json ADAPTER_JOURNAL_DIR=state/journal ADAPTER_GATE=off \
  nohup node packages/adapter/src/main.mjs >> "$adapter_log" 2>&1 &
adapter_pid=$!
for _ in $(seq 1 20); do grep -q '"event":"listening"' "$adapter_log" && break; sleep 0.5; done
grep -q '"event":"listening"' "$adapter_log" || { cat "$adapter_log"; die "adapter did not start"; }
ok "adapter listening"

echo "== registering the adapter with the gateway"
write_gateway_cfg || exit 1
grep -q '"rpc":"Describe","caller":"gateway"' "$adapter_log" && ok "gateway negotiated with the adapter (verified JWT)" || bad "no authenticated Describe from the gateway"

echo "== sandbox $name, bound to agent A"
openshell sandbox create --name "$name" --from "$SMOKE_IMAGE" --no-auto-providers \
  --policy deploy/openshell/m2-policy.yaml --detach -- sleep 900 || die "sandbox create"
grep -q '"rpc":"ValidateConfig".*"valid":true' "$adapter_log" && ok "gateway validated the policy's adapter config" || bad "no valid ValidateConfig in $adapter_log"
sid=$(sandbox_id "$name") || die "could not read the sandbox id (openshell sandbox get $name -o json)"
node packages/adapter/bin/bindings.mjs bind "$sid" "$name" A || die "bind"

# request <path> <json body> [extra curl args...]  -> prints the reason_code OpenShell returned
request() {
  local path=$1 body=$2
  shift 2
  openshell sandbox exec -n "$name" --no-tty -- \
    curl -sS -X POST -H 'Content-Type: application/json' "$@" --data-binary @- "https://host.openshell.internal:8443$path" <<<"$body" \
    | grep -o '"reason_code":"[^"]*"' | cut -d'"' -f4
}
# expect <label> <want> <path> <body> [extra curl args...]
expect() {
  local label=$1 want=$2
  shift 2
  local got
  got=$(request "$@")
  [[ "$got" == "$want" ]] && ok "$label -> $got" || bad "$label -> ${got:-no reason_code} (want $want)"
}

valid='{"amount":100,"currency":"MYR","merchant":"OfficeMart"}'
expect "valid purchase (allow path not built yet)" metamynd_gate_not_configured /purchase-requests "$valid"
expect "gzip content-encoding"                     metamynd_request_rejected   /purchase-requests "$valid" -H 'Content-Encoding: gzip'
expect "amount as a string"                        metamynd_request_rejected   /purchase-requests '{"amount":"100","currency":"MYR","merchant":"OfficeMart"}'
expect "duplicate JSON key"                        metamynd_request_rejected   /purchase-requests '{"amount":100,"amount":1,"currency":"MYR","merchant":"OfficeMart"}'
expect "field not on the route"                    metamynd_request_rejected   /purchase-requests '{"amount":100,"currency":"MYR","merchant":"OfficeMart","payee":"x"}'
expect "L7-allowed path with no adapter route"     metamynd_route_not_allowed  /not-a-route "$valid"
node packages/adapter/bin/bindings.mjs revoke "$sid" >/dev/null && sleep 1
expect "sandbox binding revoked"                   metamynd_binding_unknown    /purchase-requests "$valid"

echo "== evidence"
denied=""
for _ in $(seq 1 15); do
  openshell logs "$name" --source sandbox -n 500 > "$out/m2-deny-sandbox.log" 2>&1 || true
  denied=$(grep -c 'reason:middleware_denied:metamynd:metamynd_' "$out/m2-deny-sandbox.log" || true)
  (( denied >= 7 )) && break
  sleep 2
done
(( denied >= 7 )) && ok "OCSF logged $denied middleware denials from metamynd" || bad "OCSF shows ${denied:-0} metamynd denials (want 7)"

journaled=$(cat state/journal/*.jsonl 2>/dev/null | grep -c "\"sandboxId\":\"$sid\"" || true)
(( journaled >= 7 )) && ok "adapter journaled $journaled decisions for $sid" || bad "journal has $journaled entries for $sid (want >= 7)"
if cat state/journal/*.jsonl | grep "\"sandboxId\":\"$sid\"" | grep -qiE 'bearer|authorization|"body"'; then bad "journal contains request content"; else ok "journal holds no header values or bodies"; fi

gw_requests_after=$(grep -c '"method":' state/logs/gateway.log || true)
(( gw_requests_after == gw_requests_before )) && ok "nothing reached the purchasing gateway" || bad "the purchasing gateway saw $((gw_requests_after - gw_requests_before)) request(s)"

cp "$adapter_log" "$out/m2-deny-adapter.log"
exit "$fail"

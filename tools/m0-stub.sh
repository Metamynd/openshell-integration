#!/usr/bin/env bash
# M0 stub test (build plan step 0.4): register the stub middleware with the local
# OpenShell gateway over TLS with JWT verification, send a request from a sandbox,
# and prove the middleware denied it (403 middleware_denied/stub_deny, the OCSF
# event, and the stub's own log). Always restores the gateway's default config.
#
# Requires: the .deb gateway as a systemd user service, no existing
# ~/.config/openshell/gateway.toml (this script creates and removes it), Docker, Node >= 22.
set -uo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/openshell/gateway.toml"
jwt_dir="${XDG_STATE_HOME:-$HOME/.local/state}/openshell/tls/jwt"
reg="metamynd-stub"
audience="urn:openshell:extension:middleware:$reg"
port=50051
image="mm-poc-smoke:0.1"
name="m0-stub-$$"
out="docs/report/runs"
mkdir -p "$out"
sandbox_log="$out/m0-stub-sandbox.log"
stub_log="$out/m0-stub-server.log"
fail=0
stub_pid=""
wrote_cfg=0

ok()   { printf 'ok    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
die()  { printf 'FAIL  %s\n' "$1"; exit 1; }

wait_gateway() {
  for _ in $(seq 1 45); do
    openshell status 2>/dev/null | grep -q 'Status: Connected' && return 0
    sleep 2
  done
  return 1
}

cleanup() {
  openshell sandbox delete "$name" >/dev/null 2>&1 || true
  if (( wrote_cfg )); then
    rm -f "$cfg"
    systemctl --user restart openshell-gateway
    if wait_gateway; then echo "== gateway restored to its default config"; else echo "WARN  gateway did not reconnect after restore; check: journalctl --user -u openshell-gateway -n 50"; fi
  fi
  [[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null
}
trap cleanup EXIT

[[ -e "$cfg" ]] && die "$cfg already exists; this script only manages a gateway.toml it creates. Move it aside and re-run."
[[ -f "$jwt_dir/public.pem" && -f "$jwt_dir/kid" ]] || die "gateway JWT key not found in $jwt_dir (is JWT signing enabled?)"
command -v openssl >/dev/null || die "openssl not installed"

echo "== dependencies, certificates, sandbox image"
[[ -d node_modules/@grpc/grpc-js ]] || npm ci --no-audit --no-fund >/dev/null || die "npm ci"
bash tools/gen-middleware-certs.sh >/dev/null || die "certificate generation"
docker build -q -t "$image" deploy/images/smoke >/dev/null || die "docker build"

echo "== starting stub middleware on 127.0.0.1:$port (TLS + gateway JWT)"
: > "$stub_log"
STUB_BIND="127.0.0.1:$port" STUB_TLS_CERT="$root/state/certs/server.pem" STUB_TLS_KEY="$root/state/certs/server.key" \
  STUB_AUDIENCE="$audience" OPENSHELL_JWT_DIR="$jwt_dir" \
  node packages/adapter/src/stub-main.mjs >> "$stub_log" 2>&1 &
stub_pid=$!
for _ in $(seq 1 20); do grep -q '"event":"listening"' "$stub_log" && break; sleep 0.5; done
grep -q '"event":"listening"' "$stub_log" || { cat "$stub_log"; die "stub did not start"; }
ok "stub listening"

echo "== registering $reg with the gateway ($cfg) and restarting it"
mkdir -p "$(dirname "$cfg")"
cat > "$cfg" <<EOF
[openshell]
version = 2

[[openshell.supervisor.middleware]]
name = "$reg"
grpc_endpoint = "https://127.0.0.1:$port"
tls_ca_cert_path = "$root/state/certs/ca.pem"
audience = "$audience"
max_payload_bytes = 262144
timeout = "2s"
EOF
wrote_cfg=1
systemctl --user restart openshell-gateway
if wait_gateway; then ok "gateway reconnected with the middleware registered"; else
  journalctl --user -u openshell-gateway -n 30 --no-pager
  die "gateway did not come back (see journal above)"
fi
grep -q '"rpc":"Describe","caller":"gateway"' "$stub_log" && ok "gateway called Describe with a verified JWT" || bad "no authenticated Describe from the gateway in $stub_log"

echo "== creating sandbox $name with the middleware attached"
openshell sandbox create --name "$name" --from "$image" --no-auto-providers \
  --policy deploy/openshell/m0-stub-policy.yaml --detach -- sleep 600 || die "sandbox create"
grep -q '"rpc":"ValidateConfig","caller":"gateway"' "$stub_log" && ok "gateway called ValidateConfig for the policy" || bad "no ValidateConfig call in $stub_log"

echo "== POST from inside the sandbox (L7 allows it; the stub must deny it)"
resp=$(openshell sandbox exec -n "$name" --no-tty -- curl -sS -w '\n%{http_code}' -X POST \
  -H 'Content-Type: application/json' -d '{"text":"hi"}' https://api.github.com/markdown)
status=$(tail -n1 <<<"$resp")
body=$(sed '$d' <<<"$resp")
echo "$body" | head -c 600; echo
[[ "$status" == 403 ]] && ok "POST -> 403" || bad "POST -> ${status:-no response} (want 403)"
grep -q '"error":"middleware_denied"' <<<"$body" && grep -q '"reason_code":"stub_deny"' <<<"$body" \
  && ok "body is middleware_denied with reason_code stub_deny" || bad "403 body is not middleware_denied/stub_deny"

evaluate=$(grep '"rpc":"EvaluateHttpRequest"' "$stub_log" | tail -n1)
[[ -n "$evaluate" ]] && echo "$evaluate"
grep -q '"auth":"ok"' <<<"$evaluate" && ok "stub verified the supervisor JWT and matched its sandbox_id" \
  || bad "stub did not see an authenticated, sandbox-matched EvaluateHttpRequest"

echo "== waiting for the OCSF middleware denial event (up to 30s) -> $sandbox_log"
denied=""
for _ in $(seq 1 15); do
  openshell logs "$name" --source sandbox -n 500 > "$sandbox_log" 2>&1 || true
  denied=$(grep "reason:middleware_denied:$reg:stub_deny" "$sandbox_log" | tail -n1)
  [[ -n "$denied" ]] && break
  sleep 2
done
[[ -n "$denied" ]] && { echo "$denied"; ok "OCSF middleware denial logged"; } || bad "no middleware_denied:$reg:stub_deny event in the sandbox log"

exit "$fail"

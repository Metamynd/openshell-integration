#!/usr/bin/env bash
# M0 upstream-trust test (build plan step 0.5, spike S3). Proves a sandbox can reach a
# host-local purchasing stand-in at host.openshell.internal over
#   (a) HTTPS with a private CA, trusted via a derived supervisor image, and
#   (b) plain HTTP (the fallback),
# with L7 enforcement and the provider credential substituted after the sandbox, while
# the sandbox itself only ever holds a placeholder. Always restores the gateway defaults
# and removes the provider, profile and sandbox it created.
set -uo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/openshell/gateway.toml"
image="mm-poc-smoke:0.1"
pca_image="local/openshell-supervisor:0.1.2-pca"
base_image="ghcr.io/nvidia/openshell/supervisor:0.1.2"
profile_id="m0-purchasing-gw"
provider="m0-purchasing"
name="m0-upstream-$$"
out="docs/report/runs"
mkdir -p "$out" state/supervisor-pca
echo_log="$out/m0-upstream-echo.log"
fail=0
echo_pid=""
wrote_cfg=0
created_profile=0
created_provider=0

ok()  { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
die() { printf 'FAIL  %s\n' "$1"; exit 1; }

wait_gateway() {
  for _ in $(seq 1 45); do
    openshell status 2>/dev/null | grep -q 'Status: Connected' && return 0
    sleep 2
  done
  return 1
}

cleanup() {
  openshell sandbox delete "$name" >/dev/null 2>&1 || true
  (( created_provider )) && { sleep 2; openshell provider delete "$provider" >/dev/null 2>&1 || echo "WARN  could not delete provider $provider"; }
  (( created_profile )) && { openshell profile delete "$profile_id" >/dev/null 2>&1 || echo "WARN  could not delete profile $profile_id"; }
  if (( wrote_cfg )); then
    rm -f "$cfg"
    systemctl --user restart openshell-gateway
    if wait_gateway; then echo "== gateway restored to its default config"; else echo "WARN  gateway did not reconnect after restore; check: journalctl --user -u openshell-gateway -n 50"; fi
  fi
  [[ -n "$echo_pid" ]] && kill "$echo_pid" 2>/dev/null
}
trap cleanup EXIT

[[ -e "$cfg" ]] && die "$cfg already exists; this script only manages a gateway.toml it creates. Move it aside and re-run."
openshell profile lint -f deploy/openshell/m0-purchasing-profile.yaml >/dev/null || die "provider profile lint (run: openshell profile lint -f deploy/openshell/m0-purchasing-profile.yaml)"

echo "== certificates, sandbox image"
bash tools/gen-middleware-certs.sh >/dev/null || die "certificate generation"
openssl x509 -in state/certs/server.pem -noout -ext subjectAltName 2>/dev/null | grep -q 'host.openshell.internal' \
  || die "state/certs/server.pem lacks SAN host.openshell.internal (run: bash tools/gen-middleware-certs.sh --force)"
docker build -q -t "$image" deploy/images/smoke >/dev/null || die "docker build $image"

echo "== building $pca_image (stock supervisor CA bundle + POC CA)"
docker image inspect "$base_image" >/dev/null 2>&1 || docker pull -q "$base_image" >/dev/null || die "pull $base_image"
cid=$(docker create "$base_image") || die "docker create $base_image"
docker cp "$cid:/etc/ssl/certs/ca-certificates.crt" state/supervisor-pca/stock-bundle.crt >/dev/null || { docker rm "$cid" >/dev/null; die "copy stock CA bundle"; }
docker rm "$cid" >/dev/null
cat state/supervisor-pca/stock-bundle.crt state/certs/ca.pem > state/supervisor-pca/ca-bundle.crt
chmod 644 state/supervisor-pca/ca-bundle.crt   # the supervisor runs as nobody; see the Dockerfile
cp deploy/images/supervisor-pca/Dockerfile state/supervisor-pca/Dockerfile
docker build -q --build-arg "BASE=$base_image" -t "$pca_image" state/supervisor-pca >/dev/null || die "docker build $pca_image"
ok "built $pca_image ($(grep -c 'BEGIN CERTIFICATE' state/supervisor-pca/ca-bundle.crt) roots)"

echo "== starting the purchasing stand-in on 127.0.0.1:8443 (TLS) and :8081 (HTTP)"
token=$(openssl rand -hex 24)
: > "$echo_log"
ECHO_TOKEN="$token" ECHO_TLS_CERT="$root/state/certs/server.pem" ECHO_TLS_KEY="$root/state/certs/server.key" \
  node tools/lib/upstream-echo.mjs >> "$echo_log" 2>&1 &
echo_pid=$!
for _ in $(seq 1 20); do [[ $(grep -c '"event":"listening"' "$echo_log") -ge 2 ]] && break; sleep 0.5; done
[[ $(grep -c '"event":"listening"' "$echo_log") -ge 2 ]] || { cat "$echo_log"; die "stand-in did not start"; }
ok "stand-in listening"

echo "== pointing the gateway's Docker driver at $pca_image and restarting it"
mkdir -p "$(dirname "$cfg")"
cat > "$cfg" <<EOF
[openshell]
version = 2

[openshell.drivers.docker]
supervisor_image = "$pca_image"
EOF
wrote_cfg=1
systemctl --user restart openshell-gateway
wait_gateway && ok "gateway reconnected" || { journalctl --user -u openshell-gateway -n 30 --no-pager; die "gateway did not come back"; }

echo "== provider profile and provider (throwaway token)"
openshell profile import -f deploy/openshell/m0-purchasing-profile.yaml >/dev/null || die "profile import"
created_profile=1
PURCHASING_TOKEN="$token" openshell provider create --name "$provider" --type "$profile_id" --credential PURCHASING_TOKEN >/dev/null \
  || die "provider create"
created_provider=1
ok "provider $provider created from profile $profile_id"

echo "== creating sandbox $name"
openshell sandbox create --name "$name" --from "$image" --no-auto-providers --provider "$provider" \
  --policy deploy/openshell/m0-upstream-policy.yaml --detach -- sleep 600 || die "sandbox create"
if [[ -n "$(docker ps -q --filter "ancestor=$pca_image")" ]]; then ok "a supervisor container runs $pca_image"; else
  bad "no running container uses $pca_image"; docker ps --format '   {{.Image}}  {{.Names}}'; fi

in_sandbox() { openshell sandbox exec -n "$name" --no-tty -- sh -c "$1"; }

placeholder=$(in_sandbox 'printf %s "$PURCHASING_TOKEN"')
[[ -n "$placeholder" && "$placeholder" != "$token" && "$placeholder" == *openshell:resolve* ]] \
  && ok "sandbox env holds only a placeholder ($placeholder)" || bad "sandbox PURCHASING_TOKEN is not a placeholder"
in_sandbox 'env' | grep -qF "$token" && bad "the real token is visible in the sandbox environment" || ok "real token absent from the sandbox environment"

for url in https://host.openshell.internal:8443/purchase-requests http://host.openshell.internal:8081/purchase-requests; do
  body=$(in_sandbox "curl -sS -X POST -H \"Authorization: Bearer \$PURCHASING_TOKEN\" -H 'Content-Type: application/json' -d '{\"amount\":\"1\"}' $url")
  echo "   $url -> $body"
  grep -q '"auth_is_real_token":true' <<<"$body" \
    && ok "$url reached the stand-in with the real token substituted" || bad "$url did not reach the stand-in with the substituted token"
done

denied=$(in_sandbox "curl -sS -o /dev/null -w '%{http_code}' -X DELETE https://host.openshell.internal:8443/purchase-requests/1")
[[ "$denied" == 403 ]] && ok "L7 still enforced on the TLS path (DELETE -> 403)" || bad "DELETE on the TLS path -> ${denied:-no response} (want 403)"

grep -qF "$token" "$echo_log" && bad "the stand-in log contains the token" || true
exit "$fail"

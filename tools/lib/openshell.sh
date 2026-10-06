#!/usr/bin/env bash
# OpenShell helpers shared by the M2+ scripts. Source after tools/lib/poc-env.sh.
# The scripts own ~/.config/openshell/gateway.toml only while they run and always restore
# the gateway's defaults (remove the file, restart) on exit.

GATEWAY_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/openshell/gateway.toml"
OPENSHELL_JWT_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/openshell/tls/jwt"
PCA_IMAGE="local/openshell-supervisor:0.1.2-pca"
PCA_BASE="ghcr.io/nvidia/openshell/supervisor:0.1.2"
SMOKE_IMAGE="mm-poc-smoke:0.1"
# First line of every gateway.toml these scripts write; tools/poc-reset.sh removes only a file that carries it
# (or the older, unmarked POC registration).
GATEWAY_CFG_MARKER="# written by the openshell-integration POC scripts (tools/lib/openshell.sh)"
WROTE_GATEWAY_CFG=0

wait_gateway() {
  for _ in $(seq 1 45); do
    openshell status 2>/dev/null | grep -q 'Status: Connected' && return 0
    sleep 2
  done
  return 1
}

# write_gateway_cfg: registers the MetaMynd adapter and points the Docker driver at the
# supervisor image that trusts the POC CA. Refuses to touch a gateway.toml it did not create.
write_gateway_cfg() {
  if [[ -e "$GATEWAY_CFG" ]]; then
    echo "FAIL  $GATEWAY_CFG already exists; these scripts only manage a gateway.toml they create."
    echo "      If an earlier POC run was interrupted, run: bash tools/poc-reset.sh"
    return 1
  fi
  mkdir -p "$(dirname "$GATEWAY_CFG")"
  cat > "$GATEWAY_CFG" <<EOF
$GATEWAY_CFG_MARKER
[openshell]
version = 2

[openshell.drivers.docker]
supervisor_image = "$PCA_IMAGE"

[[openshell.supervisor.middleware]]
name = "metamynd"
grpc_endpoint = "https://127.0.0.1:50051"
tls_ca_cert_path = "$PWD/state/certs/ca.pem"
audience = "urn:openshell:extension:middleware:metamynd"
max_payload_bytes = 1048576
timeout = "5s"
EOF
  WROTE_GATEWAY_CFG=1
  systemctl --user restart openshell-gateway
  if ! wait_gateway; then
    journalctl --user -u openshell-gateway -n 30 --no-pager
    echo "FAIL  gateway did not come back with the adapter registered"
    return 1
  fi
}

restore_gateway_cfg() {
  (( WROTE_GATEWAY_CFG )) || return 0
  rm -f "$GATEWAY_CFG"
  WROTE_GATEWAY_CFG=0
  systemctl --user restart openshell-gateway
  if wait_gateway; then echo "== gateway restored to its default config"; else echo "WARN  gateway did not reconnect; check: journalctl --user -u openshell-gateway -n 50"; fi
}

# ensure_images: the curl sandbox image and the supervisor image trusting the POC CA.
ensure_images() {
  docker build -q -t "$SMOKE_IMAGE" deploy/images/smoke >/dev/null || { echo "FAIL  docker build $SMOKE_IMAGE"; return 1; }
  if docker image inspect "$PCA_IMAGE" >/dev/null 2>&1 && [[ state/supervisor-pca/ca-bundle.crt -nt state/certs/ca.pem ]] \
    && [[ $(stat -c %a state/supervisor-pca/ca-bundle.crt) == 644 ]]; then return 0; fi
  mkdir -p state/supervisor-pca
  docker image inspect "$PCA_BASE" >/dev/null 2>&1 || docker pull -q "$PCA_BASE" >/dev/null || { echo "FAIL  pull $PCA_BASE"; return 1; }
  local cid
  cid=$(docker create "$PCA_BASE") || return 1
  docker cp "$cid:/etc/ssl/certs/ca-certificates.crt" state/supervisor-pca/stock-bundle.crt >/dev/null
  docker rm "$cid" >/dev/null
  cat state/supervisor-pca/stock-bundle.crt state/certs/ca.pem > state/supervisor-pca/ca-bundle.crt
  chmod 644 state/supervisor-pca/ca-bundle.crt   # the supervisor runs as nobody; see the Dockerfile
  cp deploy/images/supervisor-pca/Dockerfile state/supervisor-pca/Dockerfile
  docker build -q --build-arg "BASE=$PCA_BASE" -t "$PCA_IMAGE" state/supervisor-pca >/dev/null || { echo "FAIL  docker build $PCA_IMAGE"; return 1; }
}

# sandbox_id <name>: the gateway-generated UUID for a sandbox (the adapter binds by it, never by name)
sandbox_id() {
  openshell sandbox get "$1" -o json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = JSON.parse(s);
      const find = (o) => (o && typeof o === "object" ? (o.metadata?.id ?? o.sandbox?.metadata?.id ?? o.id ?? Object.values(o).map(find).find(Boolean)) : undefined);
      const id = find(j);
      if (!/^[0-9a-f-]{36}$/i.test(String(id))) process.exit(1);
      console.log(id);
    });'
}

#!/usr/bin/env bash
# Generate the POC private CA and the adapter's TLS server certificate in state/certs/.
# The gateway pins ca.pem (tls_ca_cert_path) and ships it to sandbox supervisors.
# Usage: bash tools/gen-middleware-certs.sh [--force]
set -euo pipefail

cd "$(dirname "$0")/.."
d=state/certs
mkdir -p "$d"
chmod 700 state "$d"

if [[ -f "$d/server.pem" && "${1:-}" != --force ]]; then
  echo "certs already exist in $d (pass --force to regenerate)"
  exit 0
fi

openssl ecparam -name prime256v1 -genkey -noout -out "$d/ca.key"
openssl req -x509 -new -key "$d/ca.key" -sha256 -days 90 \
  -subj "/CN=MetaMynd OpenShell POC CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out "$d/ca.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "$d/server.key"
openssl req -new -key "$d/server.key" -subj "/CN=metamynd-openshell-adapter" -out "$d/server.csr"
cat > "$d/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:host.openshell.internal
EOF
openssl x509 -req -in "$d/server.csr" -CA "$d/ca.pem" -CAkey "$d/ca.key" -CAcreateserial \
  -days 90 -sha256 -extfile "$d/server.ext" -out "$d/server.pem" 2>/dev/null
rm -f "$d/server.csr" "$d/server.ext" "$d/ca.srl"
chmod 600 "$d"/*.key

openssl verify -CAfile "$d/ca.pem" "$d/server.pem"
echo "wrote $d/ca.pem, $d/server.pem, $d/server.key"

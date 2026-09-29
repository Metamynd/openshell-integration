#!/usr/bin/env bash
# M0 smoke test (build plan step 0.3): an unmodified OpenShell sandbox allows a GET
# and denies a POST under an enforced L7 policy. Builds a small image with curl,
# creates a throwaway sandbox, runs both requests, saves the sandbox log, and
# always deletes the sandbox.
set -uo pipefail

cd "$(dirname "$0")/.."
image="mm-poc-smoke:0.1"
name="m0-smoke-$$"
out="docs/report/runs"
mkdir -p "$out"
log="$out/m0-smoke-sandbox.log"
fail=0

cleanup() { openshell sandbox delete "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== building $image"
docker build -q -t "$image" deploy/images/smoke >/dev/null || { echo "FAIL  docker build"; exit 1; }

echo "== creating sandbox $name"
openshell sandbox create --name "$name" --from "$image" --no-auto-providers \
  --policy deploy/openshell/m0-smoke-policy.yaml --detach -- sleep 600 || { echo "FAIL  sandbox create"; exit 1; }

# Prints the HTTP status, or curl's own error on stderr if the request never completed.
code() { openshell sandbox exec -n "$name" --no-tty -- curl -sS -o /dev/null -w '%{http_code}' "$@"; }

get=$(code https://api.github.com/zen)
[[ "$get" == 200 ]] && echo "ok    GET  api.github.com/zen -> $get" || { echo "FAIL  GET  api.github.com/zen -> ${get:-no response} (want 200)"; fail=1; }

post=$(code -X POST -H 'Content-Type: application/json' -d '{"text":"hi"}' https://api.github.com/markdown)
[[ "$post" == 403 ]] && echo "ok    POST api.github.com/markdown -> $post (denied by L7)" || { echo "FAIL  POST api.github.com/markdown -> ${post:-no response} (want 403)"; fail=1; }

echo "== sandbox log excerpt -> $log"
timeout 10 openshell logs "$name" --source sandbox > "$log" 2>&1 || true
grep -E 'HTTP|L7|DENIED|ALLOWED' "$log" | tail -n 10 || true

exit "$fail"

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
[[ "$post" == 403 ]] && echo "ok    POST api.github.com/markdown -> $post" || { echo "FAIL  POST api.github.com/markdown -> ${post:-no response} (want 403)"; fail=1; }

# Evidence that the 403 came from OpenShell, not GitHub: the response body...
echo "== POST response body"
openshell sandbox exec -n "$name" --no-tty -- curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"text":"hi"}' https://api.github.com/markdown | head -c 600; echo

# ...and the supervisor's L7 denial event. Logs reach the gateway asynchronously, so poll.
echo "== waiting for the L7 denial event (up to 30s) -> $log"
denied=""
for _ in $(seq 1 15); do
  openshell logs "$name" --source sandbox -n 500 > "$log" 2>&1 || true
  denied=$(grep -E 'HTTP:POST.*DENIED' "$log" | tail -n 1)
  [[ -n "$denied" ]] && break
  sleep 2
done
grep -E 'HTTP:|NET:OPEN' "$log" | tail -n 10 || true
[[ -n "$denied" ]] && echo "ok    L7 denial logged" || { echo "FAIL  no HTTP:POST DENIED event in the sandbox log"; fail=1; }

exit "$fail"

#!/usr/bin/env bash
# M0 step 0.6 (spike S5): time signed authorize calls from this host to metamynd.ai.
# Reads MM_USERNAME / MM_PASSWORD (and optional MM_API) from .env.poc on first run.
# Usage: bash tools/m0-latency.sh
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -d node_modules/@metamynd/agentsafe-guard ]] || npm ci --no-audit --no-fund >/dev/null
if [[ -f .env.poc ]]; then
  exec node --env-file=.env.poc packages/adapter/scripts/latency-probe.mjs
fi
exec node packages/adapter/scripts/latency-probe.mjs

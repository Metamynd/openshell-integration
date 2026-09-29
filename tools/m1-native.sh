#!/usr/bin/env bash
# M1 task 1.4: the native baseline. Starts the POC stack, runs the purchase scenarios with
# NO OpenShell in the path, and stops the stack. Run tools/m1-enrol.sh once first.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh
trap 'bash tools/poc-stack.sh down >/dev/null' EXIT

bash tools/poc-stack.sh up || exit 1
echo "== native baseline (agents -> metamynd.ai gate -> purchasing gateway -> ledger)"
NODE_EXTRA_CA_CERTS=state/certs/ca.pem \
PURCHASING_API_TOKEN=$(private_token state/purchasing-api-token) \
LEDGER_TOKEN=$(private_token state/ledger-token) \
  node packages/poc-cli/bin/native-baseline.mjs

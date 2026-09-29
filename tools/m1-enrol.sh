#!/usr/bin/env bash
# M1 task 1.3: enrol the POC tenant on metamynd.ai. Idempotent; safe to re-run.
#  1. one agentsafe-signer daemon each for agent A, agent B and the purchasing gateway
#     generates its Ed25519 key (the key never leaves the daemon);
#  2. agents A and B are onboarded as BYOK testnet agents with their mandates (and A's SOP)
#     and prove key possession;
#  3. the gateway's did:key is registered as the tenant's trusted counterparty.
# Needs .env.poc with MM_USERNAME, MM_PASSWORD and AGENTSAFE_SIGNER_PASSPHRASE.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh
require_env MM_USERNAME MM_PASSWORD AGENTSAFE_SIGNER_PASSPHRASE || exit 1
ensure_deps

trap 'for s in agentA agentB gw; do stop_signer "$s"; done' EXIT

echo "== signer keys"
for spec in agentA:agent agentB:agent gw:service; do
  name=${spec%%:*} role=${spec##*:}
  if [[ -f "state/signers/$name/public.hex" ]]; then
    echo "ok    $name: key already generated"
    continue
  fi
  start_signer "$name" "$role" "" admin || exit 1
  node packages/poc-cli/bin/enrol.mjs keygen "$name" || exit 1
  stop_signer "$name"
done

echo "== onboarding, key proof, counterparty"
start_signer agentA agent || exit 1
start_signer agentB agent || exit 1
node packages/poc-cli/bin/enrol.mjs enrol || exit 1

echo "== summary"
echo "   agent A   $(enrolment_field 'e.agents.A.agentDid')"
echo "   agent B   $(enrolment_field 'e.agents.B.agentDid')"
echo "   gateway   $(enrolment_field 'e.serviceDid')"

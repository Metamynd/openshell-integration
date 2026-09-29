#!/usr/bin/env bash
# M5 task 5.1: produce a small, known set of governed decisions through OpenShell, then join every
# one across OpenShell OCSF, the adapter journal, MetaMynd evidence and the purchasing ledger.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh
. tools/lib/openshell.sh
. tools/lib/poc-run.sh

FAIL=0
sb_a="m5-a-$$"
sb_b="m5-b-$$"
trap 'save_sandbox_logs m5-evidence; run_cleanup' EXIT

[[ -f state/enrolment.json ]] || die "no state/enrolment.json; run: bash tools/m1-enrol.sh"
require_env MM_USERNAME MM_PASSWORD || exit 1
ensure_deps
bash tools/gen-middleware-certs.sh >/dev/null || die "certificates"
ensure_images || exit 1

echo "== setup"
bash tools/poc-stack.sh up >/dev/null || die "stack"
start_adapter || die "adapter"
write_gateway_cfg || exit 1
setup_provider || die "provider"
create_sandbox "$sb_a" deploy/openshell/m3-policy.yaml || die "sandbox A"
create_sandbox "$sb_b" deploy/openshell/m3-policy.yaml || die "sandbox B"
bind_sandbox "$sb_a" A >/dev/null || die "bind A"
bind_sandbox "$sb_b" B >/dev/null || die "bind B"
# First credential use per sandbox, then let OpenShell's one-time provider reload land (runbook M4).
buy "$sb_a" '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}' >/dev/null
buy "$sb_b" '{"amount":1,"currency":"MYR","merchant":"PaperCo"}' >/dev/null
sleep 8
ok "stack, adapter and sandboxes ready"

since=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
echo "== scenario (since $since)"
for body in '{"amount":1,"currency":"MYR","merchant":"OfficeMart","note":"evidence 1"}' '{"amount":1,"currency":"MYR","merchant":"OfficeMart","note":"evidence 2"}' \
            '{"amount":600,"currency":"MYR","merchant":"OfficeMart"}' '{"amount":350,"currency":"MYR","merchant":"OfficeMart"}'; do
  r=$(buy "$sb_a" "$body"); echo "   A $(status_of "$r") $(reason_of "$r")"
done
for body in '{"amount":1,"currency":"MYR","merchant":"PaperCo","note":"evidence 3"}' '{"amount":1,"currency":"MYR","merchant":"OfficeMart"}'; do
  r=$(buy "$sb_b" "$body"); echo "   B $(status_of "$r") $(reason_of "$r")"
done

echo "== collecting OpenShell logs; waiting 75 s for MetaMynd's evidence batch to anchor"
for sb in "$sb_a" "$sb_b"; do openshell logs "$sb" --source sandbox -n 5000 > "docs/report/runs/m5-evidence-$sb.log" 2>&1; done
sleep 75

echo "== joining"
LEDGER_TOKEN=$(cat state/ledger-token) node packages/poc-cli/bin/evidence.mjs --since "$since" \
  --log "$sb_a=docs/report/runs/m5-evidence-$sb_a.log" --log "$sb_b=docs/report/runs/m5-evidence-$sb_b.log" || FAIL=1
exit "$FAIL"

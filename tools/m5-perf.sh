#!/usr/bin/env bash
# M5 task 5.2: end-to-end purchase latency on three paths, PERF_N (default 100) sequential RM1
# purchases each, measured by the client:
#   (a) openshell-only  sandbox -> OpenShell (L4/TLS/L7/credential) -> purchasing gateway without MetaMynd checks
#   (b) metamynd-only   agent A -> metamynd.ai authorize -> enforcing purchasing gateway (no OpenShell)
#   (c) combined        sandbox -> OpenShell -> MetaMynd adapter (authorize at metamynd.ai) -> enforcing gateway
# Writes docs/report/runs/m5-perf[-$PERF_LABEL].json. Each sandbox is warmed first (OpenShell's first-credential reload).
# Gateway options pass through the environment (packages/purchasing-gateway/src/main.mjs):
#   GW_SETTLE_IN_BACKGROUND=0 PERF_LABEL=settle-first bash tools/m5-perf.sh   capture before answering (pre-0.16.0)
#   GW_BUNDLE_TTL_MS=30000 PERF_LABEL=bundle-cache bash tools/m5-perf.sh      also cache the policy bundle
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/poc-env.sh
. tools/lib/openshell.sh
. tools/lib/poc-run.sh

N=${PERF_N:-100}
FAIL=0
sb_os="m5-perf-os-$$"
sb_mm="m5-perf-mm-$$"
out=docs/report/runs
trap 'save_sandbox_logs m5-perf; run_cleanup' EXIT

[[ -f state/enrolment.json ]] || die "no state/enrolment.json; run: bash tools/m1-enrol.sh"
ensure_deps
bash tools/gen-middleware-certs.sh >/dev/null || die "certificates"
ensure_images || exit 1

# loop_in <sandbox> <n>: n sequential purchases from inside the sandbox, "<seconds> <status>" per line
loop_in() {
  openshell sandbox exec -n "$1" --no-tty -- sh -c 'i=0; while [ $i -lt $1 ]; do curl -s -m 30 -o /dev/null -w "%{time_total} %{http_code}\n" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $PURCHASING_TOKEN" --data-binary "{\"amount\":1,\"currency\":\"MYR\",\"merchant\":\"OfficeMart\"}" https://host.openshell.internal:8443/purchase-requests; i=$((i+1)); done' sh "$2" 2>/dev/null
}

echo "== setup"
GW_MODE=verify-only bash tools/poc-stack.sh up >/dev/null || die "stack"
start_adapter || die "adapter"
write_gateway_cfg || exit 1
setup_provider || die "provider"
create_sandbox "$sb_os" deploy/openshell/m5-perf-no-middleware.yaml || die "sandbox (openshell-only)"
create_sandbox "$sb_mm" deploy/openshell/m3-policy.yaml || die "sandbox (combined)"
bind_sandbox "$sb_mm" A >/dev/null || die "bind"
loop_in "$sb_os" 1 >/dev/null
loop_in "$sb_mm" 1 >/dev/null
sleep 8
ok "ready: $N purchases per path; gateway options: settle in background ${GW_SETTLE_IN_BACKGROUND:-1}, bundle cache ${GW_BUNDLE_TTL_MS:-0} ms"

echo "== (a) openshell-only"
loop_in "$sb_os" "$N" > state/perf-a.txt
echo "== restarting the purchasing gateway with MetaMynd enforcement"
GW_MODE=enforce bash tools/poc-stack.sh up >/dev/null || die "stack restart"
sleep 2
echo "== (b) metamynd-only"
NODE_EXTRA_CA_CERTS=state/certs/ca.pem PURCHASING_API_TOKEN=$(cat state/purchasing-api-token) PERF_N="$N" \
  node packages/poc-cli/bin/perf-native.mjs > state/perf-b.txt
echo "== (c) combined"
loop_in "$sb_mm" "$N" > state/perf-c.txt
# agentsafe-http-gateway (0.16.0+) logs every settlement that did not land: "<capture|release|mark-unknown> of <id> not applied".
sleep 3 # let the last background settlements land
unsettled=$(grep -c 'not applied' state/logs/gateway.log || true)
(( unsettled == 0 )) && ok "every hold settled (no 'not applied' in the purchasing gateway log)" \
  || { bad "$unsettled settlement(s) did not land (their holds stay committed to the cap):"; grep 'not applied' state/logs/gateway.log | tail -n 5; }

node - "$N" "$out/m5-perf${PERF_LABEL:+-$PERF_LABEL}.json" <<'NODE'
const fs = require('fs');
const n = Number(process.argv[2]);
const read = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { const [s, c] = l.split(' '); return { ms: Number(s) * 1000, code: c }; });
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const stats = (rows) => {
  const ok = rows.filter((r) => r.code === '201').map((r) => r.ms).sort((a, b) => a - b);
  const codes = {};
  for (const r of rows) codes[r.code] = (codes[r.code] ?? 0) + 1;
  const round = (x) => (x === undefined ? null : Math.round(x));
  return { n: rows.length, ok: ok.length, p50: round(pct(ok, 50)), p95: round(pct(ok, 95)), p99: round(pct(ok, 99)),
    mean: ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null, max: round(ok.at(-1)), codes };
};
const paths = { 'openshell-only': stats(read('state/perf-a.txt')), 'metamynd-only': stats(read('state/perf-b.txt')), combined: stats(read('state/perf-c.txt')) };
const options = { settleInBackground: process.env.GW_SETTLE_IN_BACKGROUND !== '0', bundleTtlMs: Number(process.env.GW_BUNDLE_TTL_MS ?? 0) };
fs.writeFileSync(process.argv[3], `${JSON.stringify({ at: new Date().toISOString(), perPath: n, options, paths }, null, 2)}\n`);
console.log('path             n    201   p50    p95    p99    mean   max    statuses');
for (const [k, s] of Object.entries(paths)) {
  console.log(`${k.padEnd(16)} ${String(s.n).padEnd(4)} ${String(s.ok).padEnd(5)} ${String(s.p50).padEnd(6)} ${String(s.p95).padEnd(6)} ${String(s.p99).padEnd(6)} ${String(s.mean).padEnd(6)} ${String(s.max).padEnd(6)} ${JSON.stringify(s.codes)}`);
}
console.log('(milliseconds, successful purchases only; client-measured end to end)');
const a = paths['openshell-only'], c = paths.combined, b = paths['metamynd-only'];
if (a.p50 !== null && b.p50 !== null && c.p50 !== null) console.log(`note  combined p50 ≈ openshell-only p50 + metamynd-only p50? ${a.p50} + ${b.p50} = ${a.p50 + b.p50} vs ${c.p50}`);
NODE
rm -f state/perf-a.txt state/perf-b.txt state/perf-c.txt
exit "$FAIL"

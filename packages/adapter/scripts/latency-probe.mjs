// M0 step 0.6 (spike S5): time signed authorize calls from the POC host to the hosted
// MetaMynd gate. It sets the adapter's timeout budget (design §5.3).
//
// On first run it logs in as the POC tenant and provisions a throwaway probe agent via
// POST /onboarding/agent (managed key, testnet, MYR mandate). The returned guard config
// holds the agent key, so it is written to state/latency-agent.json with mode 0600.
// Later runs reuse it.
//
// Env: MM_API (default https://metamynd.ai/api/v1), MM_USERNAME, MM_PASSWORD (first run only),
//      PROBE_CALLS (default 20 per class). Output: a summary on stdout and a JSON file in docs/report/runs/.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createGuard } from '@metamynd/agentsafe-guard';

const api = (process.env.MM_API ?? 'https://metamynd.ai/api/v1').replace(/\/$/, '');
const calls = Number(process.env.PROBE_CALLS ?? 20);
const configPath = 'state/latency-agent.json';
const scope = 'office_supplies.purchase';

async function post(path, body, token) {
  const res = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function provisionProbeAgent() {
  const { MM_USERNAME: username, MM_PASSWORD: password } = process.env;
  if (!username || !password) throw new Error('MM_USERNAME and MM_PASSWORD are required to provision the probe agent');
  const login = await post('/auth/login', { username, password });
  const token = login.json?.data?.accessToken;
  if (!token) throw new Error(`login failed (${login.status}): ${login.json?.message ?? 'no accessToken'}`);

  const provision = await post('/onboarding/agent', {
    name: 'poc-latency-probe',
    scope,
    network: 'testnet',
    currency: 'MYR',
    maxAmount: 100000,
    perTxnMax: 500,
    merchants: ['OfficeMart'],
  }, token);
  const config = provision.json?.data;
  if (provision.status >= 300 || !config?.agentDid || !config?.agentKey) {
    throw new Error(`provisioning failed (${provision.status}): ${provision.json?.message ?? JSON.stringify(provision.json).slice(0, 300)}`);
  }
  mkdirSync('state', { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  console.log(`provisioned probe agent ${config.agentDid} (config: ${configPath})`);
  return config;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const round = (x) => Math.round(x);
  return { n: sorted.length, min: round(sorted[0]), p50: round(pick(50)), p95: round(pick(95)), max: round(sorted.at(-1)) };
}

async function timeClass(guard, label, request, expect) {
  const samples = [];
  const outcomes = {};
  for (let i = 0; i < calls; i += 1) {
    const t0 = performance.now();
    const verdict = await guard.authorize(request);
    samples.push(performance.now() - t0);
    const key = `${verdict.decision}/${verdict.reasonCode}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const s = stats(samples);
  const ok = Object.keys(outcomes).every((k) => k.startsWith(expect));
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(26)} n=${s.n} min=${s.min}ms p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms  ${JSON.stringify(outcomes)}`);
  return { label, ...s, outcomes, ok };
}

const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : await provisionProbeAgent();
const guard = createGuard({ config: { ...config, apiBase: api } });

console.log(`probing ${api} as ${config.agentDid}, ${calls} calls per class`);
// The enforced EU AI Act Standard's risk rule escalates (CONTEXT_UNVERIFIABLE) when riskLevel
// is missing, so every request carries one. In the adapter it comes from operator route
// config (design §4.2), never from the agent; the context signature covers it.
const context = { riskLevel: 'low' };
const results = [
  // Denied by the mandate's merchant allow-list: no hold is minted.
  await timeClass(guard, 'deny (merchant)', { action: scope, amount: 1, currency: 'MYR', merchant: 'PaperCo', context }, 'block/'),
  // Allowed: each mints a small unclaimed hold that lapses after 15 minutes.
  await timeClass(guard, 'allow (RM1 OfficeMart)', { action: scope, amount: 1, currency: 'MYR', merchant: 'OfficeMart', context }, 'allow/'),
];

mkdirSync('docs/report/runs', { recursive: true });
const out = 'docs/report/runs/m0-latency.json';
writeFileSync(out, `${JSON.stringify({ api, agentDid: config.agentDid, at: new Date().toISOString(), results }, null, 2)}\n`);
console.log(`wrote ${out}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);

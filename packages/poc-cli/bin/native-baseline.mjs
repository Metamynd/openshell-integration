// M1 native baseline (build plan task 1.4): agents A and B buy through the purchasing
// gateway with NO OpenShell in the path. Each agent authorizes at metamynd.ai with its
// daemon-held key, then sends a freshly signed request plus the authorizationId to the
// gateway, exactly as create-metamynd-agent's scaffold does. Asserts every gate verdict,
// gateway status and ledger delta; writes docs/report/runs/m1-native.json.
//
// Env: PURCHASING_API_TOKEN, LEDGER_TOKEN, GW_URL (https://127.0.0.1:8443), LEDGER_URL
// (http://127.0.0.1:18080/ledger), MM_API (optional). NODE_EXTRA_CA_CERTS must point at
// state/certs/ca.pem so Node trusts the gateway's certificate.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGuard } from '@metamynd/agentsafe-guard';
import { SCOPE, agentConfigPath, loadState, signerDir } from '../src/enrolment.mjs';

const env = process.env;
const gwUrl = (env.GW_URL ?? 'https://127.0.0.1:8443').replace(/\/$/, '');
const ledgerUrl = env.LEDGER_URL ?? 'http://127.0.0.1:18080/ledger';
const bearer = env.PURCHASING_API_TOKEN;
if (!bearer || !env.LEDGER_TOKEN) throw new Error('PURCHASING_API_TOKEN and LEDGER_TOKEN are required');

const state = loadState();
/** @param {string} key */
function guardFor(key) {
  const entry = state.agents[key];
  if (!entry?.keyVerified) throw new Error(`agent ${key} is not enrolled and verified; run tools/m1-enrol.sh`);
  const config = JSON.parse(readFileSync(agentConfigPath(key), 'utf8'));
  return createGuard({ config: { ...config, apiBase: env.MM_API ?? state.apiBase ?? config.apiBase }, keyProvider: 'daemon', daemonSocketPath: `${signerDir(entry.signer)}/signer.sock` });
}
const guards = { A: guardFor('A'), B: guardFor('B') };
const context = { riskLevel: 'low' };

async function ledgerCount() {
  const res = await fetch(ledgerUrl, { headers: { 'x-ledger-token': /** @type {string} */ (env.LEDGER_TOKEN) } });
  return (await res.json()).count;
}

/** @param {Record<string, string>} headers @param {unknown} body */
async function sendToGateway(headers, body) {
  const res = await fetch(`${gwUrl}/purchase-requests`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * Authorize at the gate, then (if allowed) send to the gateway.
 * @param {'A' | 'B'} agent
 * @param {{ amount: number, currency: string, merchant: string }} body
 * @param {{ tamper?: (b: any) => any, omitBearer?: boolean }} [opts]
 */
async function purchase(agent, body, opts = {}) {
  const guard = guards[agent];
  const req = { action: SCOPE, amount: body.amount, currency: body.currency, merchant: body.merchant, context, payload: body };
  const t0 = Date.now();
  const verdict = await guard.authorize(req);
  const gateMs = Date.now() - t0;
  if (verdict.decision !== 'allow' && verdict.decision !== 'observe') return { verdict, gateMs };
  const signed = await guard.buildSignedRequest(req);
  signed.authorizationId = verdict.authorizationId;
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json', 'x-magp-request': JSON.stringify(signed) };
  if (!opts.omitBearer) headers.authorization = `Bearer ${bearer}`;
  const sentBody = opts.tamper ? opts.tamper(body) : body;
  const gateway = await sendToGateway(headers, sentBody);
  return { verdict, gateMs, gateway, replay: { headers, body: sentBody } };
}

/** @type {any[]} */
const results = [];
let failures = 0;
/**
 * @param {string} name
 * @param {() => Promise<any>} run
 * @param {(r: any) => boolean} expect
 * @param {number} ledgerDelta expected change in ledger rows
 */
async function scenario(name, run, expect, ledgerDelta) {
  const before = await ledgerCount();
  let r;
  try {
    r = await run();
  } catch (err) {
    r = { error: String(/** @type {Error} */ (err).message) };
  }
  const delta = (await ledgerCount()) - before;
  const ok = !r.error && expect(r) && delta === ledgerDelta;
  if (!ok) failures += 1;
  const gate = r.verdict ? `${r.verdict.decision}/${r.verdict.reasonCode}` : '-';
  const gw = r.gateway ? `${r.gateway.status}/${r.gateway.body?.reasonCode ?? r.gateway.body?.id ?? ''}` : '-';
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(46)} gate=${gate.padEnd(40)} gateway=${gw.padEnd(44)} ledger${delta >= 0 ? '+' : ''}${delta}${r.error ? `  error=${r.error}` : ''}`);
  results.push({ name, ok, gate, gatewayStatus: r.gateway?.status, gatewayReason: r.gateway?.body?.reasonCode, ledgerDelta: delta, gateMs: r.gateMs, error: r.error });
  return r;
}

const allowedA = await scenario('A buys RM100 at OfficeMart', () => purchase('A', { amount: 100, currency: 'MYR', merchant: 'OfficeMart' }),
  (r) => r.verdict.decision === 'allow' && r.gateway.status === 201, 1);
await scenario('A buys RM600 at OfficeMart (over the RM500 cap)', () => purchase('A', { amount: 600, currency: 'MYR', merchant: 'OfficeMart' }),
  (r) => r.verdict.decision === 'block', 0);
await scenario('A buys RM100 at PaperCo (merchant not allowed)', () => purchase('A', { amount: 100, currency: 'MYR', merchant: 'PaperCo' }),
  (r) => r.verdict.decision === 'block' && r.verdict.reasonCode === 'MERCHANT_NOT_ALLOWED', 0);
await scenario('A buys RM350 at OfficeMart (needs approval)', () => purchase('A', { amount: 350, currency: 'MYR', merchant: 'OfficeMart' }),
  (r) => r.verdict.decision === 'escalate', 0);
await scenario('B buys RM100 at PaperCo', () => purchase('B', { amount: 100, currency: 'MYR', merchant: 'PaperCo' }),
  (r) => r.verdict.decision === 'allow' && r.gateway.status === 201, 1);
await scenario('B buys RM100 at OfficeMart (A\'s merchant)', () => purchase('B', { amount: 100, currency: 'MYR', merchant: 'OfficeMart' }),
  (r) => r.verdict.decision === 'block' && r.verdict.reasonCode === 'MERCHANT_NOT_ALLOWED', 0);
await scenario('B buys RM250 at PaperCo (over B\'s RM200 cap)', () => purchase('B', { amount: 250, currency: 'MYR', merchant: 'PaperCo' }),
  (r) => r.verdict.decision === 'block', 0);
await scenario('replay of A\'s allowed request to the gateway', () => sendToGateway(allowedA.replay.headers, allowedA.replay.body).then((gateway) => ({ gateway })),
  (r) => r.gateway.status === 403, 0);
await scenario('A authorized RM100 but the body says RM90', () => purchase('A', { amount: 100, currency: 'MYR', merchant: 'OfficeMart' }, { tamper: (b) => ({ ...b, amount: 90 }) }),
  (r) => r.verdict.decision === 'allow' && r.gateway.status === 403, 0);
await scenario('A allowed but no upstream bearer token', () => purchase('A', { amount: 100, currency: 'MYR', merchant: 'OfficeMart' }, { omitBearer: true }),
  (r) => r.gateway.status === 401 && r.gateway.body?.reasonCode === 'UPSTREAM_AUTH_REQUIRED', 0);
await scenario('request with no MetaMynd governance at all', () => sendToGateway({ 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, { amount: 100, currency: 'MYR', merchant: 'OfficeMart' }).then((gateway) => ({ gateway })),
  (r) => r.gateway.status === 401 && r.gateway.body?.reasonCode === 'MISSING_GOVERNANCE', 0);

mkdirSync('docs/report/runs', { recursive: true });
writeFileSync('docs/report/runs/m1-native.json', `${JSON.stringify({ at: new Date().toISOString(), agents: { A: state.agents.A?.agentDid, B: state.agents.B?.agentDid }, serviceDid: state.serviceDid, results }, null, 2)}\n`);
console.log(failures === 0 ? 'ok    all native-baseline scenarios passed' : `FAIL  ${failures} scenario(s) failed`);
process.exit(failures === 0 ? 0 : 1);

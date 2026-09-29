// M5 task 5.1: join one purchase across all four evidence sources (design §7).
//   OpenShell OCSF (sandbox log)  --(sandbox + time window: OCSF carries no request_id)-->
//   adapter journal (request_id, agent, authorizationId, MetaMynd eventId)  -->
//   MetaMynd evidence (GET /evidence/:eventId -> decision digest, anchoring; trust-graph evidence path;
//                      public Merkle inclusion proof)  -->
//   purchasing ledger (Idempotency-Key = authorizationId)
// Usage: node packages/poc-cli/bin/evidence.mjs --since <iso> --log <sandbox>=<file> [--log ...]
// Env: MM_USERNAME, MM_PASSWORD, MM_API (optional), LEDGER_TOKEN. Writes docs/report/runs/m5-evidence.{json,md}.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createApi } from '../src/api.mjs';

const args = process.argv.slice(2);
const since = args[args.indexOf('--since') + 1];
if (!since) throw new Error('--since <iso timestamp> is required');
/** @type {Map<string, string>} sandbox name -> log file */
const logs = new Map();
args.forEach((a, i) => { if (a === '--log') { const [n, f] = args[i + 1].split('='); logs.set(n, f); } });

// ---- adapter journal
const journal = readdirSync('state/journal').filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => readFileSync(`state/journal/${f}`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => r.ts >= since);
const responses = new Map(journal.filter((r) => r.kind === 'response').map((r) => [r.requestId, r.statusCode]));
const requests = journal.filter((r) => r.kind === 'request' && r.action);

// ---- OpenShell OCSF (shorthand log lines: "[<epoch>] [sandbox] [OCSF ] [ocsf] HTTP:POST ...")
/** @type {Map<string, Array<{ t: number, line: string }>>} */
const ocsf = new Map();
for (const [name, file] of logs) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => /\[ocsf\] HTTP:POST/.test(l));
  ocsf.set(name, lines.map((line) => ({ t: Number(/^\[(\d+\.\d+)\]/.exec(line)?.[1] ?? 0), line })));
}
/** @param {any} r the matching OCSF events for a journaled request, by sandbox and time window */
function ocsfFor(r) {
  const events = ocsf.get(r.sandboxName) ?? [];
  const end = Date.parse(r.ts) / 1000;
  const start = end - (r.latencyMs ?? 0) / 1000 - 2;
  const window = events.filter((e) => e.t >= start && e.t <= end + 2);
  const l7 = window.find((e) => /engine:l7/.test(e.line) && /ALLOWED/.test(e.line));
  const mw = r.osReasonCode ? window.find((e) => e.line.includes(`middleware_denied:metamynd:${r.osReasonCode}`)) : undefined;
  return { l7: Boolean(l7), middlewareDenial: r.osReasonCode ? Boolean(mw) : null, candidates: window.length };
}

// ---- ledger
const ledgerRes = await fetch('http://127.0.0.1:18080/ledger', { headers: { 'x-ledger-token': process.env.LEDGER_TOKEN ?? '' } });
const ledger = ledgerRes.ok ? (await ledgerRes.json()).purchases : [];
const byKey = new Map(ledger.map((/** @type {any} */ p) => [p.idempotencyKey, p]));

// ---- MetaMynd
const api = createApi();
await api.login(/** @type {string} */ (process.env.MM_USERNAME), /** @type {string} */ (process.env.MM_PASSWORD));
/** @param {any} obj @param {RegExp} re */
const pick = (obj, re) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number')) return v;
    if (v && typeof v === 'object') { const x = pick(v, re); if (x !== undefined) return x; }
  }
  return undefined;
};
/** @param {string} eventId */
async function metamynd(eventId) {
  const ev = await api.call('GET', `/evidence/${encodeURIComponent(eventId)}`, undefined, { allow: [400, 401, 403, 404] });
  const digest = pick(ev.json?.data, /decision_?digest/i);
  const path = digest ? await api.call('GET', `/trust-graph/decision/${encodeURIComponent(String(digest))}/evidence-path`, undefined, { allow: [400, 401, 403, 404, 409, 500] }) : null;
  const proofRes = await fetch(`${api.base}/magp/evidence/${encodeURIComponent(eventId)}/proof`);
  const proof = await proofRes.json().catch(() => null);
  return {
    event: ev.status,
    decision: pick(ev.json?.data, /^decision$/i),
    anchorStatus: pick(ev.json?.data, /anchor_?status/i),
    digest: digest ? String(digest).slice(0, 16) : undefined,
    evidencePath: path?.status,
    proof: proofRes.status,
    root: pick(proof?.data, /root/i) !== undefined,
  };
}

const rows = [];
for (const r of requests) {
  const status = responses.get(r.requestId);
  const mm = r.eventId ? await metamynd(r.eventId) : null;
  const purchase = r.authorizationId ? byKey.get(r.authorizationId) : undefined;
  const os = ocsfFor(r);
  rows.push({
    at: r.ts, sandbox: r.sandboxName, requestId: r.requestId, agentDid: r.agentDid, amount: r.amount, merchant: r.merchant,
    decision: r.decision, reason: r.reasonCode ?? r.osReasonCode, authorizationId: r.authorizationId, eventId: r.eventId,
    upstreamStatus: status, ocsf: os, metamynd: mm, ledgerId: purchase?.id,
    joined: {
      ocsf: os.l7 && (os.middlewareDenial ?? true),
      metamynd: mm ? mm.event === 200 : null,
      ledger: r.decision === 'allow' ? (status === 201 ? Boolean(purchase) : !purchase) : !purchase,
    },
  });
}

const count = (/** @type {(x: any) => boolean} */ f) => rows.filter(f).length;
const summary = {
  decisions: rows.length,
  allowed: count((x) => x.decision === 'allow'),
  denied: count((x) => x.decision !== 'allow'),
  ocsfJoined: count((x) => x.joined.ocsf),
  metamyndJoined: count((x) => x.joined.metamynd === true),
  metamyndWithEvent: count((x) => x.metamynd !== null),
  proofsAvailable: count((x) => x.metamynd?.proof === 200),
  ledgerConsistent: count((x) => x.joined.ledger),
};
mkdirSync('docs/report/runs', { recursive: true });
writeFileSync('docs/report/runs/m5-evidence.json', `${JSON.stringify({ since, summary, rows }, null, 2)}\n`);
const md = [
  '| time (UTC) | sandbox | decision | reason | upstream | OCSF | MetaMynd event / path / proof | ledger |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((x) => `| ${x.at.slice(11, 19)} | ${x.sandbox} | ${x.decision} | ${x.reason ?? ''} | ${x.upstreamStatus ?? '–'} | ${x.joined.ocsf ? 'joined' : `missing (${x.ocsf.candidates} candidates)`} | ${x.metamynd ? `${x.metamynd.event} / ${x.metamynd.evidencePath ?? '–'} / ${x.metamynd.proof}` : '–'} | ${x.ledgerId ?? (x.joined.ledger ? 'none (correct)' : 'MISSING')} |`),
];
writeFileSync('docs/report/runs/m5-evidence.md', `${md.join('\n')}\n`);
console.log(md.join('\n'));
console.log(JSON.stringify(summary));
const ok = summary.ocsfJoined === rows.length && summary.ledgerConsistent === rows.length && summary.metamyndJoined === summary.metamyndWithEvent;
console.log(ok ? 'ok    every decision joined across OCSF, the journal, MetaMynd and the ledger' : 'FAIL  some decisions did not join (see the table)');
process.exit(ok ? 0 : 1);

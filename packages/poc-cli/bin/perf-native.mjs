// M5 task 5.2, path (b): MetaMynd without OpenShell. Agent A authorizes at metamynd.ai with its
// daemon-held key and sends the signed request to the enforcing purchasing gateway, N times in
// sequence; prints one "<seconds> <status>" line per purchase (the same format the sandbox loop uses).
// Env: PERF_N (100), PURCHASING_API_TOKEN, GW_URL (https://127.0.0.1:8443), NODE_EXTRA_CA_CERTS.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createGuard } from '@metamynd/agentsafe-guard';
import { SCOPE, agentConfigPath, loadState, signerDir } from '../src/enrolment.mjs';

const n = Number(process.env.PERF_N ?? 100);
const gw = (process.env.GW_URL ?? 'https://127.0.0.1:8443').replace(/\/$/, '');
const state = loadState();
const config = JSON.parse(readFileSync(agentConfigPath('A'), 'utf8'));
const guard = createGuard({ config: { ...config, apiBase: process.env.MM_API ?? state.apiBase ?? config.apiBase }, keyProvider: 'daemon', daemonSocketPath: `${signerDir('agentA')}/signer.sock` });
const body = { amount: 1, currency: 'MYR', merchant: 'OfficeMart' };
const req = { action: SCOPE, amount: 1, currency: 'MYR', merchant: 'OfficeMart', context: { riskLevel: 'low' }, payload: body };

for (let i = 0; i < n; i += 1) {
  const t0 = performance.now();
  let status = '000';
  try {
    const verdict = await guard.authorize(req);
    if (verdict.decision === 'allow') {
      const signed = await guard.buildSignedRequest(req);
      signed.authorizationId = verdict.authorizationId;
      const res = await fetch(`${gw}/purchase-requests`, { method: 'POST', headers: { 'content-type': 'application/json',
        authorization: `Bearer ${process.env.PURCHASING_API_TOKEN}`, 'x-magp-request': JSON.stringify(signed) }, body: JSON.stringify(body) });
      await res.arrayBuffer();
      status = String(res.status);
    } else {
      status = `gate:${verdict.decision}`;
    }
  } catch {
    status = 'error';
  }
  console.log(`${((performance.now() - t0) / 1000).toFixed(3)} ${status}`);
}

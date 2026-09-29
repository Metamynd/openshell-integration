// gRPC round trips against the adapter: every deny path, plus the gate contract the allow path
// will use in M3 (permit, block, escalate, gate failure) and fail-closed journaling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import { createAdapterHandlers } from '../src/adapter.mjs';
import { CONTRACT_CAPABILITY } from '../src/describe.mjs';
import { createExtensionVerifier } from '../src/jwt.mjs';
import { loadMiddlewareProto } from '../src/proto.mjs';
import { openRegistry, writeRegistry } from '../src/registry.mjs';
import { validateRoutes } from '../src/routes.mjs';
import { startMiddlewareServer } from '../src/server.mjs';
import { ISSUER, KID, gatewayKeys, mintToken, supervisorClaims } from './helpers.mjs';

const AUDIENCE = 'urn:openshell:extension:middleware:metamynd';
const SB = '159bd5a3-4814-4e8b-8ecf-8aca1681b7db';
const UNBOUND = '359bd5a3-4814-4e8b-8ecf-8aca1681b7db';
const keys = gatewayKeys();
const tok = (/** @type {Record<string, unknown>} */ claims) => mintToken(keys.privateKey, { aud: AUDIENCE, ...claims });

/** @type {any} */ let client;
/** @type {grpc.Server} */ let server;
/** @type {any[]} */ const journal = [];
/** @type {any} */ let gateImpl = null;
let journalFails = false;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const registryPath = join(dir, 'bindings.json');
  writeRegistry(registryPath, [{ sandboxId: SB, sandboxName: 'agent-a', agentKey: 'A', agentDid: 'did:hedera:testnet:zA_0.0.1',
    signerSocket: 'x.sock', generation: 1, status: 'active', createdAt: '2026-09-29T00:00:00Z', revokedAt: null }]);
  const routeSets = new Map([['purchasing-v1', validateRoutes([
    { host: 'host.openshell.internal', port: 8443, method: 'POST', path: '/purchase-requests', action: 'office_supplies.purchase',
      valueFields: ['amount', 'currency', 'merchant'], allowedFields: ['amount', 'currency', 'merchant', 'items', 'note'], riskLevel: 'low' },
    { host: 'host.openshell.internal', port: 8443, method: 'GET', path: '/purchase-requests/*', action: null },
  ], 'test')]]);
  const handlers = createAdapterHandlers({
    verifyToken: createExtensionVerifier({ publicKeyPem: keys.publicKeyPem, issuer: ISSUER, audience: AUDIENCE, kid: KID }),
    audience: AUDIENCE,
    maxPayloadBytes: 65536,
    routeSets,
    registry: openRegistry(registryPath, { minReloadMs: 0 }),
    journal: { append: (/** @type {any} */ e) => { if (journalFails) throw new Error('disk full'); journal.push(e); } },
    gate: (/** @type {any} */ c) => (gateImpl ? gateImpl(c) : Promise.reject(new Error('gate unset'))),
  });
  const started = await startMiddlewareServer({ bind: '127.0.0.1:0', tls: null, handlers });
  server = started.server;
  const { SupervisorMiddleware } = loadMiddlewareProto();
  client = new SupervisorMiddleware(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure());
});

after(() => {
  client.close();
  server.forceShutdown();
});

/** @param {string} method @param {object} req @param {string} [auth] @returns {Promise<any>} */
function call(method, req, auth) {
  const md = new grpc.Metadata();
  if (auth) md.add('authorization', auth);
  return new Promise((resolve, reject) => client[method](req, md, (/** @type {any} */ e, /** @type {any} */ r) => (e ? reject(e) : resolve(r))));
}

const struct = (/** @type {Record<string, string>} */ o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { stringValue: v }])) });
const body = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o));
const order = { amount: 100, currency: 'MYR', merchant: 'OfficeMart' };

/** @param {Record<string, any>} [over] */
function evaluation(over = {}) {
  return {
    phase: 'SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS',
    context: { request_id: 'req-1', sandbox_id: SB, sandbox: 'agent-a', workspace: 'default', ...(over.context ?? {}) },
    config: struct(over.config ?? { routes: 'purchasing-v1' }),
    target: { scheme: 'https', host: 'host.openshell.internal', port: 8443, method: 'POST', path: '/purchase-requests', query: '', ...(over.target ?? {}) },
    headers: over.headers ?? [{ name: 'content-type', value: 'application/json' }],
    body: over.body ?? body(order),
    middleware_name: 'metamynd',
  };
}
const supervisor = (sb = SB) => tok(supervisorClaims(sb));
/** @param {any} over @param {string} [auth] */
const evaluate = (over, auth = supervisor()) => call('EvaluateHttpRequest', evaluation(over), auth);

test('Describe negotiates with the gateway and advertises the request binding', async () => {
  const res = await call('Describe', { gateway: { protocol_version: { major: 1, minor: 0 }, required_capabilities: [CONTRACT_CAPABILITY] } }, tok({}));
  assert.equal(res.expected_audience, AUDIENCE);
  assert.equal(res.bindings[0].operation, 'SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST');
  assert.equal(res.extension.implementation_name, 'metamynd/openshell-adapter');
});

test('ValidateConfig accepts only a known route set', async () => {
  assert.equal((await call('ValidateConfig', { config: struct({ routes: 'purchasing-v1' }) }, tok({}))).valid, true);
  const unknown = await call('ValidateConfig', { config: struct({ routes: 'other' }) }, tok({}));
  assert.equal(unknown.valid, false);
  assert.match(unknown.reason, /purchasing-v1/);
  assert.equal((await call('ValidateConfig', { config: struct({ routes: 'purchasing-v1', extra: 'x' }) }, tok({}))).valid, false);
  assert.equal((await call('ValidateConfig', { config: struct({}) }, tok({}))).valid, false);
  await assert.rejects(call('ValidateConfig', { config: struct({ routes: 'purchasing-v1' }) }, supervisor()), { code: grpc.status.PERMISSION_DENIED });
});

test('every identity failure denies with metamynd_caller_unauthenticated', async () => {
  for (const auth of ['', tok({}), mintToken(gatewayKeys().privateKey, { aud: AUDIENCE, ...supervisorClaims(SB) }), supervisor(UNBOUND)]) {
    const r = await evaluate({}, auth);
    assert.equal(r.decision, 'DECISION_DENY');
    assert.equal(r.reason_code, 'metamynd_caller_unauthenticated');
  }
});

test('unbound sandboxes, unknown routes and bad configs are denied before any gate call', async () => {
  gateImpl = () => { throw new Error('gate must not be called'); };
  assert.equal((await evaluate({ context: { sandbox_id: UNBOUND } }, supervisor(UNBOUND))).reason_code, 'metamynd_binding_unknown');
  assert.equal((await evaluate({ target: { host: 'api.example.com', port: 443 } })).reason_code, 'metamynd_route_not_allowed');
  assert.equal((await evaluate({ target: { method: 'DELETE' } })).reason_code, 'metamynd_route_not_allowed');
  assert.equal((await evaluate({ config: { routes: 'nope' } })).reason_code, 'metamynd_route_not_allowed');
});

test('ambiguous bodies are denied with metamynd_request_rejected', async () => {
  gateImpl = () => { throw new Error('gate must not be called'); };
  const bad = [
    { headers: [{ name: 'content-type', value: 'application/json' }, { name: 'content-encoding', value: 'gzip' }] },
    { body: Buffer.from('{"amount":100,"amount":1,"currency":"MYR","merchant":"OfficeMart"}') },
    { body: body({ ...order, amount: '100' }) },
    { body: body({ ...order, payee: 'attacker' }) },
  ];
  for (const over of bad) assert.equal((await evaluate(over)).reason_code, 'metamynd_request_rejected');
});

test('a read-only passthrough route is allowed without calling MetaMynd', async () => {
  gateImpl = () => { throw new Error('gate must not be called'); };
  const r = await evaluate({ target: { method: 'GET', path: '/purchase-requests/pr_1' }, headers: [], body: Buffer.alloc(0) });
  assert.equal(r.decision, 'DECISION_ALLOW');
  assert.equal(journal.at(-1).decision, 'passthrough');
});

test('gate verdicts map to OpenShell decisions (the M3 contract)', async () => {
  gateImpl = async () => ({ permit: true, decision: 'allow', reasonCode: 'AUTHORIZED', authorizationId: 'auth-1',
    headerMutations: [{ write: { name: 'x-magp-request', value: '{}', on_existing: 'EXISTING_HEADER_ACTION_OVERWRITE' } }] });
  const allowed = await evaluate({});
  assert.equal(allowed.decision, 'DECISION_ALLOW');
  assert.equal(allowed.header_mutations[0].write.name, 'x-magp-request');
  assert.equal(journal.at(-1).authorizationId, 'auth-1');

  gateImpl = async () => ({ permit: false, decision: 'block', reasonCode: 'SOP_SPEND_CAP' });
  assert.equal((await evaluate({})).reason_code, 'metamynd_sop_spend_cap');

  gateImpl = async () => ({ permit: false, decision: 'escalate', reasonCode: 'AMOUNT_ABOVE_APPROVAL_THRESHOLD', escalationId: 'esc-1' });
  assert.equal((await evaluate({})).reason_code, 'metamynd_escalation_pending');

  gateImpl = async () => { throw new Error('timeout'); };
  const failed = await evaluate({});
  assert.equal(failed.decision, 'DECISION_DENY');
  assert.equal(failed.reason_code, 'metamynd_unavailable');
});

test('a permit is withdrawn if the decision cannot be journaled', async () => {
  gateImpl = async () => ({ permit: true, decision: 'allow', reasonCode: 'AUTHORIZED', authorizationId: 'auth-2' });
  journalFails = true;
  try {
    const r = await evaluate({});
    assert.equal(r.decision, 'DECISION_DENY');
    assert.equal(r.reason_code, 'metamynd_internal_error');
  } finally {
    journalFails = false;
  }
});

test('the journal records the decision chain without request content', () => {
  const last = journal.find((e) => e.reasonCode === 'SOP_SPEND_CAP');
  assert.equal(last.sandboxId, SB);
  assert.equal(last.agentDid, 'did:hedera:testnet:zA_0.0.1');
  assert.equal(last.amount, 100);
  assert.equal(last.osReasonCode, 'metamynd_sop_spend_cap');
  assert.equal(typeof last.latencyMs, 'number');
  assert.doesNotMatch(JSON.stringify(journal), /Bearer|content-type/);
});

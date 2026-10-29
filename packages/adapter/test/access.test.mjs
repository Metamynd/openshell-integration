// Route `access`: an upstream answer reaches the sandbox only when every tenant and user field the route names holds the
// principal the sandbox is bound for. Both stages over gRPC: the request stage refuses to send a call it could not check
// the answer of, and the response stage asks for the whole body and blocks its delivery on a mismatch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import { accessPrincipal, checkAccessBody, validateRouteAccess } from '../src/access.mjs';
import { createAdapterHandlers, createResponseHandlers } from '../src/adapter.mjs';
import { loadMiddlewareProto } from '../src/proto.mjs';
import { openRegistry, parseRegistry, writeRegistry } from '../src/registry.mjs';
import { validateRoutes } from '../src/routes.mjs';
import { startMiddlewareServer } from '../src/server.mjs';

const SB = '159bd5a3-4814-4e8b-8ecf-8aca1681b7db';
const NO_PRINCIPAL = '259bd5a3-4814-4e8b-8ecf-8aca1681b7db';
const HOST = 'crm.internal';
const WHOLE = 'HTTP_RESPONSE_BODY_MODE_WHOLE_BODY_BYTES';
const HEADERS_ONLY = 'HTTP_RESPONSE_BODY_MODE_HEADERS_ONLY';
const ACCESS = { tenant: ['/items/*/tenantId'], user: ['/items/*/owner'], principal: 'binding' };

const binding = (/** @type {string} */ sandboxId, /** @type {any} */ extra = {}) => ({ sandboxId, sandboxName: 'agent-a', agentKey: 'A',
  agentDid: 'did:hedera:testnet:zA_0.0.1', signerSocket: 'x.sock', generation: 1, status: 'active', createdAt: '2026-10-29T00:00:00Z', revokedAt: null, ...extra });

/** @type {any} */ let requestClient;
/** @type {any} */ let responseClient;
/** @type {grpc.Server} */ let server;
/** @type {any[]} */ const journal = [];

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  const registryPath = join(dir, 'bindings.json');
  writeRegistry(registryPath, [binding(SB, { accessPrincipal: { tenantId: 'acme', userId: 'alice' } }), binding(NO_PRINCIPAL)]);
  const routeSets = new Map([['crm', validateRoutes([
    { host: HOST, port: 443, method: 'GET', path: '/records', action: null, access: ACCESS },
    { host: HOST, port: 443, method: 'GET', path: '/fixed', action: null, access: { tenant: ['/tenantId'], principal: { tenantId: 'acme' } } },
    { host: HOST, port: 443, method: 'GET', path: '/open', action: null },
  ], 'test')]]);
  const registry = openRegistry(registryPath, { minReloadMs: 0 });
  const journalSink = { append: (/** @type {any} */ e) => journal.push(e) };
  const started = await startMiddlewareServer({ bind: '127.0.0.1:0', tls: null,
    handlers: createAdapterHandlers({ verifyToken: null, audience: '', maxPayloadBytes: 65536, routeSets, registry, journal: journalSink, gate: null, responseBinding: true }),
    responseHandlers: createResponseHandlers({ verifyToken: null, journal: journalSink, routeSets, registry }) });
  server = started.server;
  const { SupervisorMiddleware, HttpResponsePreReturn } = loadMiddlewareProto();
  requestClient = new SupervisorMiddleware(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure());
  responseClient = new HttpResponsePreReturn(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure());
});

after(() => {
  requestClient.close();
  responseClient.close();
  server.forceShutdown();
});

const config = { fields: { routes: { stringValue: 'crm' } } };
const target = (/** @type {string} */ path, method = 'GET') => ({ scheme: 'https', host: HOST, port: 443, method, path, query: '' });

/** @param {string} sandboxId @param {string} path @returns {Promise<any>} */
function evaluateRequest(sandboxId, path) {
  const req = { phase: 'SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS', context: { request_id: 'req-1', sandbox_id: sandboxId }, config,
    target: target(path), headers: [], body: Buffer.alloc(0), middleware_name: 'metamynd' };
  return new Promise((resolve, reject) => requestClient.EvaluateHttpRequest(req, new grpc.Metadata(), (/** @type {any} */ e, /** @type {any} */ r) => (e ? reject(e) : resolve(r))));
}

/**
 * One response stream: the preflight, then (when the stage asked to inspect) the body as one final unit.
 * @param {{ sandboxId?: string, path?: string, method?: string, status?: number, modes?: string[], body?: unknown }} o
 * @returns {Promise<{ preflight: any, body: any }>}
 */
async function respond({ sandboxId = SB, path = '/records', method = 'GET', status = 200, modes = [HEADERS_ONLY, WHOLE], body }) {
  const stream = responseClient.Evaluate();
  stream.on('error', () => {});
  /** @type {any[]} */ const results = [];
  /** @type {((v?: unknown) => void)[]} */ const waiters = [];
  stream.on('data', (/** @type {any} */ r) => { results.push(r); waiters.shift()?.(); });
  const next = () => new Promise((resolve) => { if (results.length) resolve(undefined); else waiters.push(resolve); }).then(() => results.shift());
  stream.write({ preflight: { context: { request_id: 'req-1', sandbox_id: sandboxId }, target: target(path, method), status_code: status, middleware_name: 'metamynd', config, permitted_body_modes: modes } });
  const preflight = (await next()).preflight_result;
  let bodyResult = null;
  if (preflight.inspect) {
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    stream.write({ body: { sequence: '1', data: bytes, end_of_stream: true } });
    bodyResult = (await next()).body_result;
  }
  stream.end();
  return { preflight, body: bodyResult };
}

test('an answer whose records all belong to the bound principal is delivered', async () => {
  const r = await respond({ body: { items: [{ tenantId: 'acme', owner: 'alice' }, { tenantId: 'acme', owner: 'alice' }] } });
  assert.equal(r.preflight.inspect?.body_mode, WHOLE);
  assert.ok(r.body.pass_through);
  assert.equal(r.body.sequence, '1');
  assert.equal(journal.at(-1).access, 'released');
});

test('one record for another tenant or user blocks delivery, with the reason code and never the value', async () => {
  const r = await respond({ body: { items: [{ tenantId: 'acme', owner: 'alice' }, { tenantId: 'globex', owner: 'alice' }] } });
  assert.ok(r.body.block_delivery);
  assert.equal(r.body.reason_code, 'metamynd_access_context_mismatch');
  assert.deepEqual([journal.at(-1).access, journal.at(-1).reasonCode, journal.at(-1).path], ['withheld', 'ACCESS_CONTEXT_MISMATCH', '/items/1/tenantId']);
  assert.ok(!JSON.stringify(journal.at(-1)).includes('globex'));
  const otherUser = await respond({ body: { items: [{ tenantId: 'acme', owner: 'bob' }] } });
  assert.equal(otherUser.body.reason_code, 'metamynd_access_context_mismatch');
});

test('what cannot be checked is withheld: a missing field, a body that is not JSON, an answer that cannot be read whole', async () => {
  assert.equal((await respond({ body: { items: [{ owner: 'alice' }] } })).body.reason_code, 'metamynd_access_context_uncheckable');
  assert.equal((await respond({ body: '<html>' })).body.reason_code, 'metamynd_access_context_uncheckable');
  assert.equal((await respond({ body: '{"items":[{"tenantId":"globex","tenantId":"acme","owner":"alice"}]}' })).body.reason_code, 'metamynd_access_context_uncheckable');
  const encoded = await respond({ modes: [HEADERS_ONLY] });
  assert.ok(encoded.preflight.block_delivery);
  assert.equal(encoded.preflight.reason_code, 'metamynd_access_context_uncheckable');
});

test('no records, an empty body, a bodyless status and an error status pass', async () => {
  assert.ok((await respond({ body: { items: [] } })).body.pass_through);
  assert.ok((await respond({ body: '' })).body.pass_through);
  assert.ok((await respond({ status: 204, modes: [HEADERS_ONLY] })).preflight.skip);
  assert.ok((await respond({ status: 404, modes: [HEADERS_ONLY, WHOLE] })).preflight.skip);
});

test('a route without access is skipped as before; a fixed principal works without a binding principal', async () => {
  assert.ok((await respond({ path: '/open' })).preflight.skip);
  const fixed = await respond({ sandboxId: NO_PRINCIPAL, path: '/fixed', body: { tenantId: 'acme' } });
  assert.ok(fixed.body.pass_through);
});

test('a sandbox bound with no principal: the request is denied before it is sent, and an answer is never delivered', async () => {
  const req = await evaluateRequest(NO_PRINCIPAL, '/records');
  assert.equal(req.decision, 'DECISION_DENY');
  assert.equal(req.reason_code, 'metamynd_access_principal_unavailable');
  const res = await respond({ sandboxId: NO_PRINCIPAL, body: { items: [] } });
  assert.equal(res.preflight.reason_code, 'metamynd_access_principal_unavailable');
  const allowed = await evaluateRequest(SB, '/records');
  assert.equal(allowed.decision, 'DECISION_ALLOW');
});

test('routes and bindings with a malformed access setting are refused when loaded', () => {
  const r = (/** @type {any} */ access) => [{ host: HOST, port: 443, method: 'GET', path: '/x', action: null, access }];
  for (const bad of [null, { tenant: ['/t'] }, { tenant: ['t'], principal: 'binding' }, { principal: 'binding' }, { tenant: ['/t'], principal: 'sandbox' }, { tenant: ['/t'], principal: {} }]) {
    assert.throws(() => validateRoutes(r(bad), 'test'), Error, JSON.stringify(bad));
  }
  assert.deepEqual(validateRouteAccess({ user: ['/u'], principal: 'binding' }, 'x'), { user: ['/u'], principal: 'binding' });
  for (const bad of [{}, { tenantId: '' }, { tenantId: 7 }, { tenantId: 'a', role: 'admin' }, 'acme']) {
    assert.throws(() => parseRegistry({ bindings: [binding(SB, { accessPrincipal: bad })] }), /accessPrincipal/, JSON.stringify(bad));
  }
});

test('the principal comes from the route or the binding, never the request', () => {
  assert.deepEqual(accessPrincipal({ tenant: ['/t'], principal: 'binding' }, { accessPrincipal: { tenantId: 'acme' } }), { tenantId: 'acme', userId: undefined });
  assert.equal(accessPrincipal({ user: ['/u'], principal: 'binding' }, { accessPrincipal: { tenantId: 'acme' } }), null);
  assert.equal(accessPrincipal({ tenant: ['/t'], principal: 'binding' }, null), null);
  assert.equal(checkAccessBody(Buffer.from([0xff]), { tenant: ['/t'], principal: 'binding' }, { tenantId: 'a' })?.detail, 'the answer is not UTF-8');
});

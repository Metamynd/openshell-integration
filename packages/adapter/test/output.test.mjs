// Route `output`: a request leaves the sandbox only when its buffered body and its query string have none of the
// operator's forbidden words. Over gRPC at the request stage: a refused request is denied before MetaMynd is asked, and
// the journal names where the word is, never the word.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import { createAdapterHandlers } from '../src/adapter.mjs';
import { checkOutputRequest, validateRouteOutput } from '../src/output.mjs';
import { loadMiddlewareProto } from '../src/proto.mjs';
import { openRegistry, writeRegistry } from '../src/registry.mjs';
import { validateRoutes } from '../src/routes.mjs';
import { startMiddlewareServer } from '../src/server.mjs';

const SB = '359bd5a3-4814-4e8b-8ecf-8aca1681b7db';
const HOST = 'mail.internal';
const OUTPUT = { forbidden: ['ssn', 'Falcon', '机密'], headers: ['x-note'] };

/** @type {any} */ let client;
/** @type {grpc.Server} */ let server;
/** @type {any[]} */ const journal = [];
let gateCalls = 0;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'output-'));
  const registryPath = join(dir, 'bindings.json');
  writeRegistry(registryPath, [{ sandboxId: SB, sandboxName: 'agent-a', agentKey: 'A', agentDid: 'did:hedera:testnet:zA_0.0.1',
    signerSocket: 'x.sock', generation: 1, status: 'active', createdAt: '2026-10-29T00:00:00Z', revokedAt: null }]);
  const routeSets = new Map([['mail', validateRoutes([
    { host: HOST, port: 443, method: 'POST', path: '/send', action: 'send-email', riskLevel: 'medium', valueFields: ['amount', 'currency', 'merchant'], allowedFields: ['to', 'text', 'amount', 'currency', 'merchant'], output: OUTPUT },
    { host: HOST, port: 443, method: 'GET', path: '/search', action: null, output: OUTPUT },
    { host: HOST, port: 443, method: 'POST', path: '/open', action: null },
  ], 'test')]]);
  const gate = async () => { gateCalls++; return { permit: true, decision: 'allow' }; };
  const started = await startMiddlewareServer({ bind: '127.0.0.1:0', tls: null,
    handlers: createAdapterHandlers({ verifyToken: null, audience: '', maxPayloadBytes: 65536, routeSets, registry: openRegistry(registryPath, { minReloadMs: 0 }),
      journal: { append: (/** @type {any} */ e) => journal.push(e) }, gate }) });
  server = started.server;
  const { SupervisorMiddleware } = loadMiddlewareProto();
  client = new SupervisorMiddleware(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure());
});

after(() => {
  client.close();
  server.forceShutdown();
});

/** @param {{ path?: string, method?: string, query?: string, body?: unknown, extraHeaders?: Array<{ name: string, value: string }> }} o @returns {Promise<any>} */
function send({ path = '/send', method = 'POST', query = '', body, extraHeaders = [] }) {
  const bytes = body === undefined ? Buffer.alloc(0) : typeof body === 'string' || Buffer.isBuffer(body) ? Buffer.from(/** @type {any} */ (body)) : Buffer.from(JSON.stringify(body));
  const req = { phase: 'SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS', context: { request_id: 'req-1', sandbox_id: SB }, config: { fields: { routes: { stringValue: 'mail' } } },
    target: { scheme: 'https', host: HOST, port: 443, method, path, query }, headers: [...(typeof body === 'object' && !Buffer.isBuffer(body) ? [{ name: 'content-type', value: 'application/json' }] : []), ...extraHeaders], body: bytes, middleware_name: 'metamynd' };
  return new Promise((resolve, reject) => client.EvaluateHttpRequest(req, new grpc.Metadata(), (/** @type {any} */ e, /** @type {any} */ r) => (e ? reject(e) : resolve(r))));
}

test('clean text goes on to MetaMynd and is allowed', async () => {
  gateCalls = 0;
  const r = await send({ body: { to: 'x@y', text: 'lessons on falconry', amount: 1, currency: 'USD', merchant: 'mailer' } });
  assert.equal(r.decision, 'DECISION_ALLOW', JSON.stringify(journal.at(-1)));
  assert.equal(gateCalls, 1);
});

test('a forbidden word is denied before MetaMynd is asked; the journal names the path, never the word', async () => {
  gateCalls = 0;
  const r = await send({ body: { to: 'x@y', text: 'Customer SSN: 123' } });
  assert.equal(r.decision, 'DECISION_DENY');
  assert.equal(r.reason_code, 'metamynd_output_forbidden_word');
  assert.equal(gateCalls, 0);
  assert.deepEqual([journal.at(-1).output, journal.at(-1).reasonCode, journal.at(-1).path], ['refused', 'OUTPUT_FORBIDDEN_WORD', '/text']);
  assert.ok(!JSON.stringify(journal.at(-1)).toLowerCase().includes('ssn'));
});

test('a fullwidth spelling, an object key, a non-JSON body and the query string are all checked', async () => {
  for (const o of [{ body: { text: 'ＦＡＬＣＯＮ' } }, { body: { ssn: 1 } }, { body: 'plain text, ssn inside' }, { path: '/search', method: 'GET', query: 'q=my+ssn' }]) {
    assert.equal((await send(o)).reason_code, 'metamynd_output_forbidden_word', JSON.stringify(o));
  }
  assert.equal((await send({ path: '/search', method: 'GET', query: 'q=hello' })).decision, 'DECISION_ALLOW');
});

test('a body that is not UTF-8 or a query string that does not decode is uncheckable', async () => {
  assert.equal((await send({ body: Buffer.from([0xff, 0xfe]) })).reason_code, 'metamynd_output_uncheckable');
  assert.equal((await send({ path: '/search', method: 'GET', query: 'q=%E0%A4%A' })).reason_code, 'metamynd_output_uncheckable');
});

test('JSON that is not strict is uncheckable; a form body is decoded', async () => {
  assert.equal((await send({ body: '{"a":1,"a":2,"t":"\u0073sn"}' })).reason_code, 'metamynd_output_uncheckable');
  assert.equal(checkOutputRequest(Buffer.from('note=%73sn'), '', 'application/x-www-form-urlencoded', OUTPUT)?.reasonCode, 'OUTPUT_FORBIDDEN_WORD');
  assert.equal(checkOutputRequest(Buffer.from('{"t":"my_ssn"}'), '', 'application/json', OUTPUT)?.path, '/t');
});

test('the headers the route names, the path, and a word in a script without spaces are checked', async () => {
  gateCalls = 0;
  const r = await send({ path: '/search', method: 'GET', extraHeaders: [{ name: 'x-note', value: 'the FALCON plan' }] });
  assert.deepEqual([r.reason_code, journal.at(-1).path, gateCalls], ['metamynd_output_forbidden_word', '@headers/x-note', 0]);
  assert.equal((await send({ path: '/search', method: 'GET', extraHeaders: [{ name: 'x-other', value: 'ssn' }] })).decision, 'DECISION_ALLOW');
  assert.equal((await send({ path: '/search', method: 'GET', query: 'q=%E8%BF%99%E6%98%AF%E6%9C%BA%E5%AF%86' })).reason_code, 'metamynd_output_forbidden_word');
  assert.equal(checkOutputRequest(new Uint8Array(0), '', undefined, OUTPUT, { path: '/notes/my%2520ssn' })?.path, '@path');
  assert.equal(checkOutputRequest(new Uint8Array(0), '', undefined, { ...OUTPUT, path: false }, { path: '/ssn/lookup' }), null);
  assert.deepEqual(validateRouteOutput({ forbidden: ['ssn'], path: false, headers: ['x-note'] }, 'x'), { forbidden: ['ssn'], path: false, headers: ['x-note'] });
});

test('a route without output is unchanged', async () => {
  assert.equal((await send({ path: '/open', body: { text: 'ssn' } })).decision, 'DECISION_ALLOW');
});

test('a malformed output setting is refused when the routes load', () => {
  const r = (/** @type {any} */ output) => [{ host: HOST, port: 443, method: 'GET', path: '/x', action: null, output }];
  for (const bad of [null, {}, { forbidden: [] }, { forbidden: ['credit card'] }, { forbidden: ['ssn'], fields: ['/x'] }]) {
    assert.throws(() => validateRoutes(r(bad), 'test'), Error, JSON.stringify(bad));
  }
  assert.deepEqual(validateRouteOutput({ forbidden: ['ssn'] }, 'x'), { forbidden: ['ssn'] });
  assert.equal(checkOutputRequest(new Uint8Array(0), '', undefined, OUTPUT), null);
});

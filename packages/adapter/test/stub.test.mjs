import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import { loadMiddlewareProto } from '../src/proto.mjs';
import { createExtensionVerifier } from '../src/jwt.mjs';
import { createStubHandlers, startStubServer, CONTRACT_CAPABILITY } from '../src/stub.mjs';
import { gatewayKeys, mintToken, supervisorClaims, ISSUER, AUDIENCE, KID } from './helpers.mjs';

const keys = gatewayKeys();
/** @type {Record<string, unknown>[]} */
const logs = [];
/** @type {grpc.Server} */
let server;
/** @type {any} */
let client;

const GATEWAY_META = {
  protocol_version: { major: 1, minor: 0 },
  implementation_name: 'openshell/gateway',
  implementation_version: '0.1.2',
  supported_capabilities: [CONTRACT_CAPABILITY],
  required_capabilities: [CONTRACT_CAPABILITY],
};

before(async () => {
  const verifyToken = createExtensionVerifier({ publicKeyPem: keys.publicKeyPem, issuer: ISSUER, audience: AUDIENCE, kid: KID });
  const handlers = createStubHandlers({ verifyToken, audience: AUDIENCE, maxPayloadBytes: 262144, log: (e) => logs.push(e) });
  const started = await startStubServer({ bind: '127.0.0.1:0', tls: null, handlers });
  server = started.server;
  const { SupervisorMiddleware } = loadMiddlewareProto();
  client = new SupervisorMiddleware(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure());
});

after(() => {
  client.close();
  server.forceShutdown();
});

/** @param {string} [authorization] */
function meta(authorization) {
  const m = new grpc.Metadata();
  if (authorization) m.add('authorization', authorization);
  return m;
}

/** @param {string} method @param {object} request @param {grpc.Metadata} metadata @returns {Promise<any>} */
function call(method, request, metadata) {
  return new Promise((resolve, reject) => {
    client[method](request, metadata, (/** @type {any} */ err, /** @type {any} */ res) => (err ? reject(err) : resolve(res)));
  });
}

/** @param {string} sandboxId */
function evaluation(sandboxId) {
  return {
    phase: 'SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS',
    context: { request_id: 'req-1', sandbox_id: sandboxId, sandbox: 'agent-a', workspace: 'default' },
    target: { scheme: 'https', host: 'api.github.com', port: 443, method: 'POST', path: '/markdown', query: '' },
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from('{"text":"hi"}'),
    middleware_name: 'metamynd-stub',
  };
}

test('Describe returns a manifest the v0.1.2 gateway accepts', async () => {
  const res = await call('Describe', { gateway: GATEWAY_META }, meta(mintToken(keys.privateKey)));
  assert.equal(res.expected_audience, AUDIENCE);
  assert.deepEqual(res.extension.protocol_version, { major: 1, minor: 0 });
  assert.deepEqual(res.extension.supported_capabilities, [CONTRACT_CAPABILITY]);
  assert.equal(res.bindings.length, 1);
  assert.equal(res.bindings[0].operation, 'SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST');
  assert.equal(res.bindings[0].phase, 'SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS');
  assert.equal(res.bindings[0].max_payload_bytes, '262144');
});

test('Describe accepts supervisor callers and rejects bad tokens or protocol majors', async () => {
  await call('Describe', { gateway: GATEWAY_META }, meta(mintToken(keys.privateKey, supervisorClaims('sb-1'))));
  await assert.rejects(call('Describe', { gateway: GATEWAY_META }, meta()), { code: grpc.status.UNAUTHENTICATED });
  await assert.rejects(call('Describe', { gateway: GATEWAY_META }, meta(mintToken(gatewayKeys().privateKey))),
    { code: grpc.status.UNAUTHENTICATED });
  await assert.rejects(
    call('Describe', { gateway: { ...GATEWAY_META, protocol_version: { major: 2, minor: 0 } } }, meta(mintToken(keys.privateKey))),
    { code: grpc.status.FAILED_PRECONDITION });
});

test('ValidateConfig accepts the gateway only', async () => {
  const res = await call('ValidateConfig', { config: {}, middleware_name: 'metamynd-stub' }, meta(mintToken(keys.privateKey)));
  assert.equal(res.valid, true);
  await assert.rejects(
    call('ValidateConfig', { config: {}, middleware_name: 'metamynd-stub' }, meta(mintToken(keys.privateKey, supervisorClaims('sb-1')))),
    { code: grpc.status.PERMISSION_DENIED });
});

test('EvaluateHttpRequest denies an authenticated supervisor request with stub_deny', async () => {
  const res = await call('EvaluateHttpRequest', evaluation('sb-1'), meta(mintToken(keys.privateKey, supervisorClaims('sb-1'))));
  assert.equal(res.decision, 'DECISION_DENY');
  assert.equal(res.reason_code, 'stub_deny');
  const entry = logs.findLast((e) => e.rpc === 'EvaluateHttpRequest');
  assert.equal(entry?.sandbox_id, 'sb-1');
  assert.equal(entry?.request_id, 'req-1');
  assert.equal(entry?.body_bytes, 13);
});

test('EvaluateHttpRequest denies with a distinct code when identity does not check out', async () => {
  const mismatch = await call('EvaluateHttpRequest', evaluation('sb-2'), meta(mintToken(keys.privateKey, supervisorClaims('sb-1'))));
  assert.equal(mismatch.reason_code, 'stub_sandbox_mismatch');
  const anonymous = await call('EvaluateHttpRequest', evaluation('sb-1'), meta());
  assert.equal(anonymous.reason_code, 'stub_unauthenticated');
  const gateway = await call('EvaluateHttpRequest', evaluation('sb-1'), meta(mintToken(keys.privateKey)));
  assert.equal(gateway.reason_code, 'stub_unauthenticated');
  for (const res of [mismatch, anonymous, gateway]) assert.equal(res.decision, 'DECISION_DENY');
});

test('every reason code satisfies the OpenShell reason_code grammar', () => {
  for (const code of ['stub_deny', 'stub_sandbox_mismatch', 'stub_unauthenticated']) {
    assert.match(code, /^[a-z][a-z0-9_]{0,63}$/);
  }
});

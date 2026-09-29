// Exercises our wrapper around agentsafe-http-gateway with a fake guard and the real mock
// purchasing API: bearer check, forwarding, idempotency key, settlement and refusals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- the @metamynd packages ship no type declarations
import { createHttpGateway } from '@metamynd/agentsafe-http-gateway';
import { createMockPurchasing } from '../../mock-purchasing/src/server.mjs';
import { createForward, createPurchasingServer } from '../src/gateway.mjs';

const TOKEN = 'upstream-token';
const LEDGER = 'ledger-token';
/** @type {{ decision: string, reasonCode: string }} */
let verdict = { decision: 'allow', reasonCode: 'AUTHORIZED' };
/** @type {any[]} */
const settled = [];
/** @type {any[]} */
const logs = [];
let auth = 0;

const fakeGuard = {
  async verifyRequest(/** @type {any} */ request) {
    auth += 1;
    return { ...verdict, authorizationId: `auth-${auth}-${request.nonce}`, counterpartyAuthenticated: true };
  },
  async captureAuthorization(/** @type {any} */ c) { settled.push({ kind: 'capture', ...c }); },
  async releaseAuthorization(/** @type {any} */ c) { settled.push({ kind: 'release', ...c }); },
  async markAuthorizationUnknown(/** @type {any} */ c) { settled.push({ kind: 'unknown', ...c }); },
};

/** @type {import('node:http').Server} */ let upstream;
/** @type {import('node:http').Server} */ let server;
let base = '';
let upstreamBase = '';

/** @param {import('node:http').Server} s */
const listen = (s) => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${/** @type {any} */ (s.address()).port}`)));

before(async () => {
  upstream = createMockPurchasing({ dbPath: ':memory:', ledgerToken: LEDGER });
  upstreamBase = /** @type {string} */ (await listen(upstream));
  const routes = [{ method: 'POST', path: '/purchase-requests', action: 'office_supplies.purchase',
    valueFields: ['amount', 'currency', 'merchant'], allowedFields: ['amount', 'currency', 'merchant', 'items', 'note'] }];
  const gateway = createHttpGateway({ guard: fakeGuard, routes, forward: createForward(upstreamBase), denyByDefault: true,
    releaseOnStatus: [400, 409, 413, 415, 422] });
  server = createPurchasingServer({ gateway, bearerToken: TOKEN, tls: null, log: (e) => logs.push(e) });
  base = /** @type {string} */ (await listen(server));
});

after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  await new Promise((r) => upstream.close(() => r(undefined)));
});

/** @param {Record<string, unknown>} body @param {Record<string, unknown> | null} signed @param {Record<string, string>} [extra] */
function post(body, signed, extra = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'idempotency-key': 'agent-chosen-key', ...extra };
  if (signed) headers['x-magp-request'] = JSON.stringify(signed);
  return fetch(`${base}/purchase-requests`, { method: 'POST', headers, body: JSON.stringify(body) });
}

const signedFor = (/** @type {any} */ b, nonce = 'nonce-0001') => ({ agentDid: 'did:key:zAgent', action: 'office_supplies.purchase',
  amount: b.amount, currency: b.currency, merchant: b.merchant, nonce, issuedAt: new Date().toISOString(), signature: 'aa' });

const ledger = async () => (await (await fetch(`${upstreamBase}/ledger`, { headers: { 'x-ledger-token': LEDGER } })).json());

test('rejects a request without the upstream bearer before any governance', async () => {
  const before = auth;
  const res = await post({ amount: 100, currency: 'MYR', merchant: 'OfficeMart' }, null, { authorization: 'Bearer openshell:resolve:env:v1_PURCHASING_TOKEN' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reasonCode, 'UPSTREAM_AUTH_REQUIRED');
  assert.equal(auth, before);
});

test('an allowed purchase is forwarded once, keyed by the authorization, and captured', async () => {
  verdict = { decision: 'allow', reasonCode: 'AUTHORIZED' };
  const body = { amount: 100, currency: 'MYR', merchant: 'OfficeMart', items: [{ sku: 'A4', qty: 5 }] };
  const res = await post(body, signedFor(body, 'nonce-allow-1'));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('x-agentsafe-decision'), 'allow');
  const created = await res.json();
  assert.match(created.idempotencyKey, /^auth-\d+-nonce-allow-1$/, 'the agent-chosen Idempotency-Key is replaced by the authorization id');
  const capture = settled.at(-1);
  assert.equal(capture.kind, 'capture');
  assert.equal(capture.amountCharged, 100);
});

test('a guard refusal never reaches the ledger', async () => {
  verdict = { decision: 'block', reasonCode: 'MERCHANT_NOT_ALLOWED' };
  const before = (await ledger()).count;
  const body = { amount: 100, currency: 'MYR', merchant: 'PaperCo' };
  const res = await post(body, signedFor(body, 'nonce-block-1'));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reasonCode, 'MERCHANT_NOT_ALLOWED');
  assert.equal((await ledger()).count, before);
});

test('a body that contradicts the signed values or omits governance is refused', async () => {
  verdict = { decision: 'allow', reasonCode: 'AUTHORIZED' };
  const before = (await ledger()).count;
  const signed = signedFor({ amount: 100, currency: 'MYR', merchant: 'OfficeMart' }, 'nonce-tamper-1');
  const tampered = await post({ amount: 900, currency: 'MYR', merchant: 'OfficeMart' }, signed);
  assert.equal(tampered.status, 403);
  assert.equal((await tampered.json()).reasonCode, 'PAYLOAD_NOT_BOUND');
  const ungoverned = await post({ amount: 100, currency: 'MYR', merchant: 'OfficeMart' }, null);
  assert.equal(ungoverned.status, 401);
  assert.equal((await ungoverned.json()).reasonCode, 'MISSING_GOVERNANCE');
  assert.equal((await ledger()).count, before);
});

test('an upstream rejection releases the hold instead of capturing it', async () => {
  verdict = { decision: 'allow', reasonCode: 'AUTHORIZED' };
  const body = { amount: 100, currency: 'myr', merchant: 'OfficeMart' };
  const res = await post(body, signedFor(body, 'nonce-release-1'));
  assert.equal(res.status, 422);
  assert.equal(settled.at(-1).kind, 'release');
});

test('unlisted routes are denied', async () => {
  const res = await fetch(`${base}/ledger`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reasonCode, 'ROUTE_NOT_ALLOWED');
});

test('logs each decision without secrets', () => {
  const text = JSON.stringify(logs);
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.ok(logs.some((e) => e.status === 201 && e.decision === 'allow'));
});

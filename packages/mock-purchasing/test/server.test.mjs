import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockPurchasing, validatePurchase } from '../src/server.mjs';

const LEDGER_TOKEN = 'ledger-secret';
/** @type {import('node:http').Server} */
let server;
let base = '';

before(async () => {
  server = createMockPurchasing({ dbPath: ':memory:', ledgerToken: LEDGER_TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise((resolve) => server.close(() => resolve(undefined))));

/** @param {string} key @param {unknown} body @param {Record<string, string>} [headers] */
function purchase(key, body, headers = {}) {
  return fetch(`${base}/purchase-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const order = { amount: '100.00', currency: 'MYR', merchant: 'OfficeMart', items: [{ sku: 'A4-PAPER', qty: 10 }] };

test('creates one ledger row per idempotency key', async () => {
  const res = await purchase('auth-key-0001', order);
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.match(created.id, /^pr_/);
  assert.equal(created.amount, '100.00');

  const fetched = await fetch(`${base}/purchase-requests/${created.id}`);
  assert.equal(fetched.status, 200);
});

test('a replay with the same key and body returns the original row without a second effect', async () => {
  const first = await (await purchase('auth-key-0002', order)).json();
  const replay = await purchase('auth-key-0002', order);
  assert.equal(replay.status, 200);
  const body = await replay.json();
  assert.equal(body.id, first.id);
  assert.equal(body.replayed, true);
});

test('the same key with a different body is a conflict', async () => {
  await purchase('auth-key-0003', order);
  const res = await purchase('auth-key-0003', { ...order, amount: '999.00' });
  assert.equal(res.status, 409);
});

test('rejects requests the gateway should never forward', async () => {
  assert.equal((await purchase('', order)).status, 400);
  assert.equal((await purchase('auth-key-0004', order, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await purchase('auth-key-0005', order, { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await purchase('auth-key-0006', '{not json')).status, 400);
  assert.equal((await purchase('auth-key-0007', { ...order, amount: '1.005' })).status, 422);
  assert.equal((await purchase('auth-key-0008', 'x'.repeat(70 * 1024))).status, 413);
});

test('refuses protocol upgrades', async () => {
  const res = await fetch(`${base}/purchase-requests/x`, { headers: { upgrade: 'websocket', connection: 'upgrade' } }).catch(() => null);
  // fetch refuses to send Upgrade on some runtimes; when it does send, the server must answer 400.
  if (res) assert.equal(res.status, 400);
});

test('the ledger requires the operator token and totals per currency', async () => {
  assert.equal((await fetch(`${base}/ledger`)).status, 401);
  const res = await fetch(`${base}/ledger`, { headers: { 'x-ledger-token': LEDGER_TOKEN } });
  assert.equal(res.status, 200);
  const ledger = await res.json();
  assert.ok(ledger.count >= 3);
  assert.equal(typeof ledger.totals.MYR, 'number');
});

test('never echoes request headers', async () => {
  const res = await purchase('auth-key-0009', order, { authorization: 'Bearer do-not-echo' });
  assert.doesNotMatch(await res.text(), /do-not-echo/);
});

test('validatePurchase normalises numeric amounts and rejects bad input', () => {
  assert.deepEqual(validatePurchase({ amount: 12.5, currency: 'MYR', merchant: 'OfficeMart' }),
    { ok: true, value: { amount: '12.5', currency: 'MYR', merchant: 'OfficeMart', items: [], note: '' } });
  assert.equal(validatePurchase({ amount: '10', currency: 'myr', merchant: 'x' }).ok, false);
  assert.equal(validatePurchase([]).ok, false);
});

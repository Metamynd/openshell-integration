// The purchasing gateway's policy-bundle cache (GW_BUNDLE_TTL_MS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBundleCache } from '../src/latency.mjs';

/** A fetch that serves one bundle per call and counts the calls. */
function fakeIssuer({ ok = true } = {}) {
  const calls = { n: 0 };
  /** @type {any} */
  const fetchImpl = async (/** @type {string} */ url) => {
    calls.n++;
    const body = ok ? { data: { subject: decodeURIComponent(url.split('/').at(-1) ?? ''), n: calls.n }, contained: { status: 'suspended' }, operatingMode: { mode: 'SUPERVISED' } } : { error: 'nope' };
    return { ok, status: ok ? 200 : 503, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('the bundle cache reuses a bundle within its TTL and refetches after it', async () => {
  let t = 0;
  const { calls, fetchImpl } = fakeIssuer();
  const fetchBundle = createBundleCache({ issuerApi: 'https://issuer', ttlMs: 1000, fetchImpl, now: () => t });
  const a = await fetchBundle('did:a');
  t = 999;
  assert.equal(await fetchBundle('did:a'), a);
  assert.equal(calls.n, 1);
  t = 1000;
  assert.notEqual(await fetchBundle('did:a'), a);
  assert.equal(calls.n, 2);
});

test('the bundle cache keys by agent and shares one fetch between concurrent requests', async () => {
  const { calls, fetchImpl } = fakeIssuer();
  const fetchBundle = createBundleCache({ issuerApi: 'https://issuer', ttlMs: 1000, fetchImpl });
  const [x, y] = await Promise.all([fetchBundle('did:a'), fetchBundle('did:a')]);
  assert.equal(x, y);
  assert.equal(calls.n, 1);
  assert.equal((await fetchBundle('did:b')).subject, 'did:b');
  assert.equal(calls.n, 2);
});

test('a cached bundle keeps containment and mode as non-enumerable props, like the guard loader', async () => {
  const { fetchImpl } = fakeIssuer();
  const b = await createBundleCache({ issuerApi: 'https://issuer', ttlMs: 1000, fetchImpl })('did:a');
  assert.deepEqual(b.__contained, { status: 'suspended' });
  assert.deepEqual(b.__operatingMode, { mode: 'SUPERVISED' });
  assert.ok(!Object.keys(b).includes('__contained') && !Object.keys(b).includes('__operatingMode'));
});

test('a failed bundle fetch throws and is not cached', async () => {
  const bad = fakeIssuer({ ok: false });
  const fetchBundle = createBundleCache({ issuerApi: 'https://issuer', ttlMs: 60_000, fetchImpl: bad.fetchImpl });
  await assert.rejects(fetchBundle('did:a'), /HTTP 503/);
  await assert.rejects(fetchBundle('did:a'), /HTTP 503/);
  assert.equal(bad.calls.n, 2);
});

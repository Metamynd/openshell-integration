import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalise } from '../src/canon.mjs';
import { createJournal } from '../src/journal.mjs';
import { REASON, isValidReasonCode, mapMetaMyndReason } from '../src/reasons.mjs';
import { openRegistry, readBindings, registryGid, writeRegistry } from '../src/registry.mjs';
import { matchRoute, validateRoutes } from '../src/routes.mjs';

const ROUTES = validateRoutes([
  { host: 'host.openshell.internal', port: 8443, method: 'POST', path: '/purchase-requests', action: 'office_supplies.purchase',
    valueFields: ['amount', 'currency', 'merchant'], allowedFields: ['amount', 'currency', 'merchant', 'items', 'note'], riskLevel: 'low' },
  { host: 'host.openshell.internal', port: 8443, method: 'GET', path: '/purchase-requests/*', action: null },
], 'test');
const governed = ROUTES[0];

test('MetaMynd reason codes map into the OpenShell grammar', () => {
  assert.equal(mapMetaMyndReason('SPEND_LIMIT_EXCEEDED'), 'metamynd_spend_limit_exceeded');
  assert.equal(mapMetaMyndReason('SOP_SPEND_CAP'), 'metamynd_sop_spend_cap');
  assert.equal(mapMetaMyndReason('CONSTRAINT_FAILED:mm:merchant'), 'metamynd_constraint_failed_mm_merchant');
  assert.equal(mapMetaMyndReason('X'.repeat(200)).length, 64);
  assert.equal(mapMetaMyndReason(undefined), REASON.UNAVAILABLE);
  for (const code of Object.values(REASON)) assert.ok(isValidReasonCode(code), code);
});

test('routes match on host, port, method and decoded path', () => {
  const t = { host: 'HOST.openshell.internal', port: 8443, method: 'post', path: '/purchase-requests' };
  assert.equal(matchRoute(ROUTES, t), governed);
  assert.equal(matchRoute(ROUTES, { ...t, path: '/%70urchase-requests' }), governed, 'percent-encoding cannot dodge a route');
  assert.equal(matchRoute(ROUTES, { ...t, port: 443 }), null);
  assert.equal(matchRoute(ROUTES, { ...t, host: 'api.example.com' }), null);
  assert.equal(matchRoute(ROUTES, { ...t, method: 'DELETE' }), null);
  assert.equal(matchRoute(ROUTES, { ...t, method: 'GET', path: '/purchase-requests/pr_1' })?.action, null);
});

test('route validation refuses governed routes without a riskLevel or with inconsistent fields', () => {
  const base = { host: 'h', port: 1, method: 'POST', path: '/x', action: 'a', valueFields: ['amount'], allowedFields: ['amount'] };
  assert.throws(() => validateRoutes([base], 't'), /riskLevel/);
  assert.throws(() => validateRoutes([{ ...base, riskLevel: 'low', allowedFields: ['merchant'] }], 't'), /valueFields not in allowedFields/);
  assert.throws(() => validateRoutes([], 't'), /non-empty/);
});

const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);
const json = [{ name: 'content-type', value: 'application/json' }];
/** @param {string} body @param {Array<{ name: string, value: string }>} [headers] */
const canon = (body, headers = json) => canonicalise(governed, { headers, body: enc(body) }, 1024);

test('canonicalise extracts the governed fields from a clean body', () => {
  const r = canon('{"amount":100,"currency":"MYR","merchant":"OfficeMart","items":[{"sku":"A4","qty":2}]}');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.fields, { amount: 100, currency: 'MYR', merchant: 'OfficeMart' });
    assert.equal(r.action, 'office_supplies.purchase');
  }
});

test('canonicalise refuses everything ambiguous', () => {
  /** @type {Array<[string, Array<{ name: string, value: string }>, RegExp]>} */
  const cases = [
    ['{"amount":100,"currency":"MYR","merchant":"OfficeMart"}', [...json, { name: 'content-encoding', value: 'gzip' }], /content-encoding/],
    ['{"amount":100,"currency":"MYR","merchant":"OfficeMart"}', [...json, ...json], /exactly one content-type/],
    ['{"amount":100,"currency":"MYR","merchant":"OfficeMart"}', [{ name: 'content-type', value: 'text/plain' }], /application\/json/],
    ['{"amount":100,"amount":1,"currency":"MYR","merchant":"OfficeMart"}', json, /strict JSON/],
    ['{"amount":"100","currency":"MYR","merchant":"OfficeMart"}', json, /positive JSON number/],
    ['{"amount":100.001,"currency":"MYR","merchant":"OfficeMart"}', json, /2 decimal/],
    ['{"amount":100,"currency":"myr","merchant":"OfficeMart"}', json, /currency/],
    ['{"amount":100,"currency":"MYR","merchant":"OfficeMart","payee":"x"}', json, /not allowed/],
    ['{"amount":100,"currency":"MYR"}', json, /missing value fields/],
    ['[1,2]', json, /JSON object/],
    ['﻿{"amount":100,"currency":"MYR","merchant":"OfficeMart"}', json, /byte-order mark/],
    ['{"amount":100,"currency":"MYR","merchant":"' + 'x'.repeat(2000) + '"}', json, /exceeds/],
  ];
  for (const [body, headers, why] of cases) {
    const r = canon(body, headers);
    assert.equal(r.ok, false, body.slice(0, 60));
    if (!r.ok) assert.match(r.why, why);
  }
  const invalidUtf8 = canonicalise(governed, { headers: json, body: new Uint8Array([0x7b, 0xff, 0x7d]) }, 1024);
  assert.equal(invalidUtf8.ok, false);
});

const binding = (/** @type {string} */ id, over = {}) => ({ sandboxId: id, sandboxName: 'agent-a', agentKey: 'A', agentDid: 'did:hedera:testnet:zA_0.0.1',
  signerSocket: 'state/signers/agentA/signer.sock', generation: 1, status: /** @type {const} */ ('active'), createdAt: '2026-09-29T00:00:00Z', revokedAt: null, ...over });
const SB1 = '159bd5a3-4814-4e8b-8ecf-8aca1681b7db';
const SB2 = '259bd5a3-4814-4e8b-8ecf-8aca1681b7db';

test('the registry returns only active bindings and keeps the last good copy on a bad write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  const path = join(dir, 'bindings.json');
  writeRegistry(path, [binding(SB1), binding(SB2, { status: 'revoked' })]);
  /** @type {any[]} */
  const logs = [];
  const reg = openRegistry(path, { log: (e) => logs.push(e), minReloadMs: 0 });
  assert.equal(reg.lookup(SB1.toUpperCase())?.agentKey, 'A');
  assert.equal(reg.lookup(SB2), null, 'revoked bindings never authorize');
  assert.equal(reg.lookup('not-a-uuid'), null);

  writeFileSync(path, '{"bindings":[{"sandboxId":"nope"}]}');
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
  assert.equal(reg.lookup(SB1)?.agentKey, 'A', 'last good copy survives an invalid write');
  assert.ok(logs.some((e) => e.event === 'registry_invalid_kept_last_good'));

  assert.throws(() => writeRegistry(path, [binding(SB1), binding(SB1)]), /duplicate/);
  assert.deepEqual(readBindings(join(dir, 'missing.json')), []);
});

test('ADAPTER_REGISTRY_GID shares the registry with one group, read-only; unset it stays owner-only', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  assert.equal(registryGid({}), null);
  assert.equal(registryGid({ ADAPTER_REGISTRY_GID: '' }), null);
  assert.equal(registryGid({ ADAPTER_REGISTRY_GID: '998' }), 998);
  assert.throws(() => registryGid({ ADAPTER_REGISTRY_GID: 'metamynd' }), /numeric group id/);

  const gid = /** @type {() => number} */ (process.getgid)(); // a group this test may chown to without root
  const shared = join(mkdtempSync(join(tmpdir(), 'registry-gid-')), 'registry', 'bindings.json');
  writeRegistry(shared, [binding(SB1)], { gid });
  const st = statSync(shared);
  assert.equal(st.mode & 0o777, 0o640);
  assert.equal(st.gid, gid);
  assert.equal(statSync(join(shared, '..')).mode & 0o777, 0o750, 'a directory it creates is traversable by the group');
  writeRegistry(shared, [binding(SB1), binding(SB2)], { gid });
  assert.equal(statSync(shared).mode & 0o777, 0o640, 'a rewrite keeps the shared mode');

  const own = join(mkdtempSync(join(tmpdir(), 'registry-own-')), 'bindings.json');
  writeRegistry(own, [binding(SB1)], { gid: null });
  assert.equal(statSync(own).mode & 0o777, 0o600);
});
test('the journal writes only allow-listed fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  const journal = createJournal(dir, { now: () => new Date('2026-09-29T10:00:00Z') });
  journal.append({ kind: 'request', requestId: 'r1', decision: 'deny', authorization: 'Bearer secret', body: 'x' });
  const line = readFileSync(join(dir, '2026-09-29.jsonl'), 'utf8');
  assert.match(line, /"requestId":"r1"/);
  assert.doesNotMatch(line, /secret|"body"/);
});

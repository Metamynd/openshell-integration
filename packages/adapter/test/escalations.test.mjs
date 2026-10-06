import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEscalations, requestFingerprint } from '../src/escalations.mjs';

const req = { action: 'office_supplies.purchase', amount: 350, currency: 'MYR', merchant: 'OfficeMart', context: { riskLevel: 'low' }, payload: { a: 1, b: 2 } };

test('the fingerprint ignores trace and key order, and binds everything else', () => {
  const fp = requestFingerprint('did:a', req);
  assert.equal(requestFingerprint('did:a', { ...req, trace: { workflowId: 'x' }, payload: { b: 2, a: 1 } }), fp);
  for (const changed of [{ amount: 351 }, { merchant: 'Other' }, { currency: 'USD' }, { context: { riskLevel: 'high' } }, { payload: { a: 1, b: 3 } }, { action: 'x' }]) {
    assert.notEqual(requestFingerprint('did:a', { ...req, ...changed }), fp, JSON.stringify(changed));
  }
  assert.notEqual(requestFingerprint('did:b', req), fp);
});

test('escalations persist across a restart and expire', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'esc-')), 'state', 'escalations.json');
  let t = 1000;
  const a = openEscalations(path, { now: () => t });
  a.remember('fp', 'esc-1');
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).fp);
  const b = openEscalations(path, { now: () => t });
  assert.equal(b.get('fp'), 'esc-1');
  b.forget('fp');
  assert.equal(openEscalations(path).get('fp'), null);
  b.remember('fp2', 'esc-2');
  t += 25 * 60 * 60 * 1000;
  assert.equal(b.get('fp2'), null, 'past the escalation + hold TTL an entry is dropped');
});
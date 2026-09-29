import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry, readBindings, revokeBinding, writeRegistry } from '../src/registry.mjs';
import { createWatcher, sandboxIdsFrom } from '../src/watcher.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NEW_A = '33333333-3333-4333-8333-333333333333';
const binding = (/** @type {string} */ id, name = 'agent-a') => ({ sandboxId: id, sandboxName: name, agentKey: 'A', agentDid: 'did:hedera:testnet:zA_0.0.1',
  signerSocket: 's.sock', generation: 1, status: /** @type {const} */ ('active'), createdAt: '2026-09-29T00:00:00Z', revokedAt: null });

test('sandbox ids are collected from any list envelope', () => {
  assert.deepEqual([...sandboxIdsFrom({ sandboxes: [{ metadata: { id: A.toUpperCase(), name: 'a' }, phase: 'READY' }, { metadata: { id: B } }] })].sort(), [A, B]);
  assert.deepEqual([...sandboxIdsFrom([{ id: A, name: 'a', phase: 'Ready' }])], [A]);
  assert.equal(sandboxIdsFrom({ policy: { id: A } }).size, 0, 'ids on non-sandbox objects are ignored');
});

test('a sandbox missing for the grace period is revoked; a failed poll changes nothing', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'watch-')), 'bindings.json');
  writeRegistry(path, [binding(A), binding(B, 'agent-b')]);
  const watcher = createWatcher({ readBindings: () => readBindings(path), revoke: (id) => revokeBinding(path, id), graceMisses: 2 });

  assert.deepEqual(watcher.observe(new Set([A, B])), []);
  assert.deepEqual(watcher.observe(new Set([B])), [], 'first miss is within the grace period');
  assert.deepEqual(watcher.observe(null), [], 'a failed poll never revokes');
  assert.deepEqual(watcher.observe(new Set([B])), [A], 'second consecutive miss revokes');
  assert.equal(readBindings(path).find((b) => b.sandboxId === A)?.status, 'revoked');

  assert.deepEqual(watcher.observe(new Set()), []);
  assert.deepEqual(watcher.observe(new Set()), [B]);
});

test('a sandbox that reappears resets its miss count', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'watch-')), 'bindings.json');
  writeRegistry(path, [binding(A)]);
  const watcher = createWatcher({ readBindings: () => readBindings(path), revoke: (id) => revokeBinding(path, id), graceMisses: 2 });
  watcher.observe(new Set());
  watcher.observe(new Set([A]));
  assert.deepEqual(watcher.observe(new Set()), []);
  assert.equal(readBindings(path)[0].status, 'active');
});

test('delete-and-recreate under the same name never inherits the old binding', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'watch-')), 'bindings.json');
  writeRegistry(path, [binding(A, 'agent-a')]);
  const watcher = createWatcher({ readBindings: () => readBindings(path), revoke: (id) => revokeBinding(path, id), graceMisses: 1 });
  watcher.observe(new Set([NEW_A])); // same name, new UUID
  const reg = openRegistry(path, { minReloadMs: 0 });
  assert.equal(reg.lookup(A), null);
  assert.equal(reg.lookup(NEW_A), null);
  assert.equal(revokeBinding(path, NEW_A), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorEgressPolicy, egressPolicyHash, isEgressPolicyHash, readEffectivePolicy } from '../src/egress-policy.mjs';
import { parseRegistry } from '../src/registry.mjs';

const POLICY = 'version: 1\nnetwork_policies:\n  purchasing:\n    endpoints:\n      - host: host.openshell.internal\n        port: 8443\n';
// The vector @metamynd/magp-evidence publishes for egressPolicyHash: the verifier and this tooling must agree.
const VECTOR = 'sha256:c9cff2825dc9cd95014ca4475954f3781749d670e37b955aea324b49b7e6f397';

test('egressPolicyHash matches the independent verifier\'s vector', () => {
  assert.equal(egressPolicyHash(POLICY), VECTOR);
  assert.equal(egressPolicyHash(POLICY.replace(/\n/g, '\r\n') + '\r\n'), VECTOR);
  assert.notEqual(egressPolicyHash(POLICY.replace('8443', '8444')), VECTOR);
  assert.ok(isEgressPolicyHash(VECTOR));
  assert.ok(!isEgressPolicyHash(VECTOR.slice(7)));
});

test('readEffectivePolicy asks OpenShell for the effective policy, and refuses an empty one', () => {
  /** @type {string[][]} */
  const calls = [];
  const exec = (/** @type {string} */ cmd, /** @type {string[]} */ a) => { calls.push([cmd, ...a]); return POLICY; };
  assert.equal(readEffectivePolicy('sb-a', { exec }), POLICY);
  assert.deepEqual(calls, [['openshell', 'sandbox', 'get', 'sb-a', '--policy-only']]);
  assert.throws(() => readEffectivePolicy('sb-a', { exec: () => '  \n' }), /empty policy/);
});

test('anchorEgressPolicy logs in as the owner and posts the hash for the agent', async () => {
  /** @type {Array<{ url: string, body: any, auth: string | undefined }>} */
  const seen = [];
  /** @type {any} */
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    const data = url.endsWith('/auth/login') ? { accessToken: 'tok' } : { topicId: '0.0.4242', txId: '0.0.1@1.2', ref: 'https://hashscan.io/x' };
    return { ok: true, json: async () => ({ data }) };
  };
  const policy = { sandboxId: '0b5c6a1e-2f3d-4c5b-8a9e-1f2d3c4b5a60', egressPolicyHash: VECTOR, generation: 2 };
  const anchor = await anchorEgressPolicy({ base: 'https://mm.test/api/v1/', username: 'u', password: 'p', identityId: 'id-1', policy, fetchImpl });
  assert.equal(anchor.ref, 'https://hashscan.io/x');
  assert.equal(seen[0].url, 'https://mm.test/api/v1/auth/login');
  assert.equal(seen[1].url, 'https://mm.test/api/v1/agent-identity/id-1/egress-policy');
  assert.equal(seen[1].auth, 'Bearer tok');
  assert.deepEqual(seen[1].body, { runtime: 'openshell', ...policy });
});

test('anchorEgressPolicy surfaces the API\'s refusal', async () => {
  /** @type {any} */
  const fetchImpl = async (/** @type {string} */ url) => (url.endsWith('/auth/login')
    ? { ok: true, json: async () => ({ data: { accessToken: 'tok' } }) }
    : { ok: false, status: 502, json: async () => ({ message: 'Could not anchor' }) });
  await assert.rejects(
    anchorEgressPolicy({ base: 'https://mm.test/api/v1', username: 'u', password: 'p', identityId: 'id-1', policy: { sandboxId: 'x', egressPolicyHash: VECTOR, generation: 1 }, fetchImpl }),
    /502: Could not anchor/,
  );
});

test('the registry accepts a recorded egress policy and refuses a malformed one', () => {
  const base = { sandboxId: '0b5c6a1e-2f3d-4c5b-8a9e-1f2d3c4b5a60', sandboxName: 'a', agentKey: 'A', agentDid: 'did:key:z', signerSocket: 's', generation: 1, status: 'active', createdAt: 't', revokedAt: null };
  assert.equal(parseRegistry({ bindings: [base] }).size, 1); // bound before the policy was recorded
  assert.equal(parseRegistry({ bindings: [{ ...base, egressPolicyHash: VECTOR, egressPolicyAnchor: null }] }).size, 1);
  assert.throws(() => parseRegistry({ bindings: [{ ...base, egressPolicyHash: 'abc' }] }), /egressPolicyHash/);
  assert.throws(() => parseRegistry({ bindings: [{ ...base, egressPolicyHash: VECTOR, egressPolicyAnchor: 5 }] }), /egressPolicyAnchor/);
});

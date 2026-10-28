// The sandbox's egress policy, hashed and anchored on Hedera against the agent it is bound to.
//
// OpenShell enforces where a sandbox may connect; that policy is what makes "every governed call goes through the
// adapter" true. When a sandbox is bound to an agent, the operator tooling reads the sandbox's EFFECTIVE policy (the
// same text tools/policy-lint.sh checks), hashes it, records the hash on the binding, and asks MetaMynd to publish it
// on the agent's HCS topic. Anyone later shown the policy can recompute the hash, find the anchor, and read the policy
// to confirm it allows no route around the adapter. `bindings.mjs check` re-reads the policy and reports drift.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * sha256 over the policy text as OpenShell reports it, line endings normalised to LF and trailing whitespace at the end
 * removed. MUST stay byte-identical to `egressPolicyHash` in @metamynd/magp-evidence (the independent verifier); the
 * shared vector in test/egress-policy.test.mjs pins both.
 * @param {string} policyText
 */
export function egressPolicyHash(policyText) {
  const normalised = String(policyText).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return `sha256:${createHash('sha256').update(normalised, 'utf8').digest('hex')}`;
}

/** @param {unknown} value */
export const isEgressPolicyHash = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);

/**
 * The sandbox's effective policy, as `openshell sandbox get <name> --policy-only` prints it.
 * @param {string} sandboxName
 * @param {{ exec?: (cmd: string, args: string[]) => string }} [opts]
 */
export function readEffectivePolicy(sandboxName, { exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const text = exec('openshell', ['sandbox', 'get', sandboxName, '--policy-only']);
  if (!text.trim()) throw new Error(`openshell returned an empty policy for ${sandboxName}`);
  return text;
}

/**
 * Ask MetaMynd to anchor the hash on the agent's HCS topic (POST /agent-identity/:id/egress-policy), as the agent's
 * owner. Returns the anchor ({ topicId, txId, ref, … }); throws with the API's message on failure.
 * @param {object} opts
 * @param {string} opts.base API root, e.g. https://metamynd.ai/api/v1
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} opts.identityId the agent's identity id (state/enrolment.json)
 * @param {{ sandboxId: string, egressPolicyHash: string, generation: number }} opts.policy
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function anchorEgressPolicy({ base, username, password, identityId, policy, fetchImpl = fetch }) {
  const root = base.replace(/\/$/, '');
  /** @param {string} path @param {unknown} body @param {string} [token] */
  const post = async (path, body, token) => {
    const res = await fetchImpl(`${root}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${json?.message ?? 'error'}`);
    return json;
  };
  const login = await post('/auth/login', { username, password });
  const token = login?.data?.accessToken;
  if (!token) throw new Error('login returned no accessToken');
  const anchored = await post(`/agent-identity/${encodeURIComponent(identityId)}/egress-policy`, { runtime: 'openshell', ...policy }, token);
  return anchored?.data ?? null;
}

// Operator CLI for the sandbox_id -> agent binding registry (design §3.2). Run from the repo root.
//   node packages/adapter/bin/bindings.mjs bind <sandboxId> <sandboxName> <agentKey>   (agentKey from state/enrolment.json, e.g. A)
//   node packages/adapter/bin/bindings.mjs check <sandboxId>   (does the sandbox still run the egress policy it was bound under?)
//   node packages/adapter/bin/bindings.mjs revoke <sandboxId>
//   node packages/adapter/bin/bindings.mjs list
// Env: ADAPTER_REGISTRY (state/bindings.json), ADAPTER_REGISTRY_GID (unset = owner-only 0600; a numeric gid = shared 0640 with that group)
//      MM_USERNAME + MM_PASSWORD (the agents' owner) and MM_API: bind anchors the sandbox's egress-policy hash on the
//      agent's HCS topic through MetaMynd. Without them the hash is still recorded on the binding, but not anchored.
import { readFileSync } from 'node:fs';
import { anchorEgressPolicy, egressPolicyHash, readEffectivePolicy } from '../src/egress-policy.mjs';
import { readBindings, revokeBinding, writeRegistry } from '../src/registry.mjs';

const path = process.env.ADAPTER_REGISTRY ?? 'state/bindings.json';
const [cmd, ...args] = process.argv.slice(2);
const bindings = readBindings(path);

if (cmd === 'bind' && args.length === 3) {
  const [sandboxId, sandboxName, agentKey] = args;
  const enrolment = JSON.parse(readFileSync('state/enrolment.json', 'utf8'));
  const agent = enrolment.agents?.[agentKey];
  if (!agent?.keyVerified) throw new Error(`agent ${agentKey} is not enrolled and verified in state/enrolment.json`);
  const id = sandboxId.toLowerCase();
  const previous = bindings.find((b) => b.sandboxId === id);
  // The policy the sandbox runs under now. Read before binding, so a sandbox whose policy cannot be read is never bound.
  const policyHash = egressPolicyHash(readEffectivePolicy(sandboxName));
  const next = {
    sandboxId: id, sandboxName, agentKey, agentDid: agent.agentDid, signerSocket: `state/signers/${agent.signer}/signer.sock`,
    generation: (previous?.generation ?? 0) + 1, status: /** @type {const} */ ('active'), createdAt: new Date().toISOString(), revokedAt: null,
    egressPolicyHash: policyHash, egressPolicyAnchor: /** @type {string | null} */ (null),
  };
  writeRegistry(path, [...bindings.filter((b) => b.sandboxId !== id), next]);
  console.log(`ok    bound ${id} (${sandboxName}) -> agent ${agentKey} ${agent.agentDid} (generation ${next.generation})`);
  console.log(`      egress policy ${policyHash}`);

  // Anchoring is evidence, not enforcement: the binding stands whether or not it succeeds, and says which.
  const { MM_USERNAME, MM_PASSWORD } = process.env;
  if (!MM_USERNAME || !MM_PASSWORD || !agent.identityId) {
    console.log('WARN  egress policy not anchored: set MM_USERNAME and MM_PASSWORD (the agent owner) to anchor it');
  } else {
    try {
      const anchor = await anchorEgressPolicy({
        base: process.env.MM_API ?? enrolment.apiBase ?? 'https://metamynd.ai/api/v1', username: MM_USERNAME, password: MM_PASSWORD,
        identityId: agent.identityId, policy: { sandboxId: id, egressPolicyHash: policyHash, generation: next.generation },
      });
      const where = anchor?.ref ?? anchor?.txId ?? null;
      // Patch only the anchor onto the binding as it is NOW: a revoke or rebind that landed during the call changed its
      // generation, and is never undone here.
      const current = readBindings(path);
      const mine = current.find((b) => b.sandboxId === id && b.generation === next.generation);
      if (mine) writeRegistry(path, current.map((b) => (b === mine ? { ...b, egressPolicyAnchor: where } : b)));
      console.log(`ok    egress policy anchored on ${anchor?.topicId ?? 'HCS'}${where ? ` (${where})` : ''}${mine ? '' : ' (binding changed meanwhile; not recorded on it)'}`);
    } catch (err) {
      console.log(`WARN  egress policy not anchored: ${/** @type {Error} */ (err).message}`);
    }
  }
} else if (cmd === 'check' && args.length === 1) {
  const b = bindings.find((x) => x.sandboxId === args[0].toLowerCase());
  if (!b) throw new Error(`no binding for ${args[0]}`);
  if (!b.egressPolicyHash) throw new Error(`binding ${b.sandboxId} records no egress policy (bound before it was recorded): rebind it`);
  const now = egressPolicyHash(readEffectivePolicy(b.sandboxName));
  if (now === b.egressPolicyHash) {
    console.log(`ok    ${b.sandboxId} (${b.sandboxName}) runs the egress policy it was bound under${b.egressPolicyAnchor ? `, anchored ${b.egressPolicyAnchor}` : ' (not anchored)'}`);
  } else {
    console.log(`FAIL  ${b.sandboxId} (${b.sandboxName}) egress policy changed since it was bound: bound ${b.egressPolicyHash}, now ${now}. Rebind to record and anchor the new one.`);
    process.exit(1);
  }
} else if (cmd === 'revoke' && args.length === 1) {
  if (!revokeBinding(path, args[0])) throw new Error(`no binding for ${args[0]}`);
  console.log(`ok    revoked ${args[0].toLowerCase()}`);
} else if (cmd === 'list') {
  for (const b of bindings) console.log(`${b.status.padEnd(8)} ${b.sandboxId}  ${b.sandboxName.padEnd(20)} agent ${b.agentKey}  gen ${b.generation}${b.egressPolicyHash ? `  policy ${b.egressPolicyHash.slice(0, 19)}…${b.egressPolicyAnchor ? ' anchored' : ''}` : ''}`);
} else {
  console.error('usage: bindings.mjs bind <sandboxId> <sandboxName> <agentKey> | check <sandboxId> | revoke <sandboxId> | list');
  process.exit(2);
}

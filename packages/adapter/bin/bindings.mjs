// Operator CLI for the sandbox_id -> agent binding registry (design §3.2). Run from the repo root.
//   node packages/adapter/bin/bindings.mjs bind <sandboxId> <sandboxName> <agentKey>   (agentKey from state/enrolment.json, e.g. A)
//   node packages/adapter/bin/bindings.mjs revoke <sandboxId>
//   node packages/adapter/bin/bindings.mjs list
// Env: ADAPTER_REGISTRY (state/bindings.json)
import { readFileSync } from 'node:fs';
import { readBindings, writeRegistry } from '../src/registry.mjs';

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
  const next = {
    sandboxId: id, sandboxName, agentKey, agentDid: agent.agentDid, signerSocket: `state/signers/${agent.signer}/signer.sock`,
    generation: (previous?.generation ?? 0) + 1, status: /** @type {const} */ ('active'), createdAt: new Date().toISOString(), revokedAt: null,
  };
  writeRegistry(path, [...bindings.filter((b) => b.sandboxId !== id), next]);
  console.log(`ok    bound ${id} (${sandboxName}) -> agent ${agentKey} ${agent.agentDid} (generation ${next.generation})`);
} else if (cmd === 'revoke' && args.length === 1) {
  const id = args[0].toLowerCase();
  const b = bindings.find((x) => x.sandboxId === id);
  if (!b) throw new Error(`no binding for ${id}`);
  writeRegistry(path, bindings.map((x) => (x.sandboxId === id ? { ...x, status: 'revoked', generation: x.generation + 1, revokedAt: new Date().toISOString() } : x)));
  console.log(`ok    revoked ${id}`);
} else if (cmd === 'list') {
  for (const b of bindings) console.log(`${b.status.padEnd(8)} ${b.sandboxId}  ${b.sandboxName.padEnd(20)} agent ${b.agentKey}  gen ${b.generation}`);
} else {
  console.error('usage: bindings.mjs bind <sandboxId> <sandboxName> <agentKey> | revoke <sandboxId> | list');
  process.exit(2);
}

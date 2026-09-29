// POC enrolment against the hosted MetaMynd tenant (build plan task 1.3). Idempotent.
//   node packages/poc-cli/bin/enrol.mjs keygen <signer>   one-shot generate-key on the signer's admin socket
//   node packages/poc-cli/bin/enrol.mjs enrol             onboard agents A and B (BYOK), prove key possession,
//                                                         derive the gateway's did:key, register it as a counterparty
// Env: MM_USERNAME, MM_PASSWORD, MM_API (optional). Run from the repo root; state goes to state/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildDidKey } from '@metamynd/agentsafe-mcp-guard/did';
import { createApi } from '../src/api.mjs';
import { daemonRequest } from '../src/daemon.mjs';
import { AGENTS, STATE, agentConfigPath, loadState, signerDir, writePrivateJson } from '../src/enrolment.mjs';

const SPKI_ED25519_PREFIX = '302a300506032b6570032100';

/** @param {string} name */
async function keygen(name) {
  const out = `${signerDir(name)}/public.hex`;
  if (existsSync(out)) {
    console.log(`ok    ${name}: key already generated (${out})`);
    return;
  }
  const { publicKeyHex } = await daemonRequest(`${signerDir(name)}/signer-admin.sock`, 'generate-key', { allowRekey: false });
  if (!/^302a300506032b6570032100[0-9a-f]{64}$/.test(publicKeyHex)) throw new Error(`unexpected public key format from ${name}: ${publicKeyHex}`);
  writeFileSync(out, `${publicKeyHex}\n`);
  console.log(`ok    ${name}: generated key ${publicKeyHex.slice(-16)}…`);
}

/** @param {string} name */
const publicKeyOf = (name) => readFileSync(`${signerDir(name)}/public.hex`, 'utf8').trim();

async function enrol() {
  const { MM_USERNAME, MM_PASSWORD } = process.env;
  if (!MM_USERNAME || !MM_PASSWORD) throw new Error('MM_USERNAME and MM_PASSWORD are required (see .env.poc)');
  const api = createApi();
  await api.login(MM_USERNAME, MM_PASSWORD);
  const state = loadState();
  state.apiBase = api.base;

  for (const agent of AGENTS) {
    let entry = state.agents[agent.key];
    if (!entry) {
      const { json } = await api.call('POST', '/onboarding/agent', { ...agent.body, publicKey: publicKeyOf(agent.signer) });
      const config = json.data;
      writePrivateJson(agentConfigPath(agent.key), config);
      entry = { agentDid: config.agentDid, identityId: config.identityId, keyVerified: Boolean(config.keyVerified), signer: agent.signer };
      state.agents[agent.key] = entry;
      state.policyPublicKey ??= config.issuer?.policyKey;
      writePrivateJson(STATE, state);
      console.log(`ok    agent ${agent.key} onboarded: ${entry.agentDid}`);
    } else {
      console.log(`ok    agent ${agent.key} already onboarded: ${entry.agentDid}`);
    }

    if (!entry.keyVerified) {
      const config = JSON.parse(readFileSync(agentConfigPath(agent.key), 'utf8'));
      let challenge = config.challenge;
      let res = challenge ? await verify(api, agent.signer, entry.identityId, challenge) : { status: 400 };
      if (res.status !== 200) {
        const regen = await api.call('POST', `/agent-identity/${entry.identityId}/regenerate-challenge`, {});
        challenge = regen.json?.data?.challenge;
        res = await verify(api, agent.signer, entry.identityId, challenge);
      }
      if (res.status !== 200) throw new Error(`agent ${agent.key}: key verification failed (${res.status}): ${res.json?.message}`);
      entry.keyVerified = true;
      writePrivateJson(STATE, state);
      console.log(`ok    agent ${agent.key} proved key possession`);
    }
  }

  const gwKey = publicKeyOf('gw');
  if (!gwKey.startsWith(SPKI_ED25519_PREFIX)) throw new Error('gateway key is not an Ed25519 SPKI key');
  state.serviceDid = buildDidKey(Buffer.from(gwKey.slice(SPKI_ED25519_PREFIX.length), 'hex'));
  writeFileSync(`${signerDir('gw')}/did.txt`, `${state.serviceDid}\n`);

  const { json: list } = await api.call('GET', '/policy/counterparties');
  const existing = (list?.data?.counterparties ?? []).find((/** @type {any} */ c) => c.did === state.serviceDid && c.status !== 'revoked');
  if (existing) {
    state.counterpartyId = existing.counterpartyId;
    console.log(`ok    purchasing gateway already registered as counterparty ${state.serviceDid}`);
  } else {
    const { json } = await api.call('POST', '/policy/counterparties', {
      did: state.serviceDid, label: 'openshell-poc-purchasing-gateway', merchants: ['OfficeMart', 'PaperCo'], confirmEnforcementChange: true,
    });
    state.counterpartyId = json.data.counterpartyId;
    console.log(`ok    purchasing gateway registered as counterparty ${state.serviceDid} (tenant is now registered-counterparty only)`);
  }

  if (!state.policyPublicKey) {
    const { json } = await api.call('GET', '/magp/policy/pubkey');
    state.policyPublicKey = json.data.publicKey;
  }
  writePrivateJson(STATE, state);
  console.log(`ok    enrolment written to ${STATE}`);
}

/** @param {ReturnType<typeof createApi>} api @param {string} signer @param {string} identityId @param {string} challenge */
async function verify(api, signer, identityId, challenge) {
  const { signature } = await daemonRequest(`${signerDir(signer)}/signer.sock`, 'sign-key-control-challenge', { challenge });
  return api.call('POST', `/agent-identity/${identityId}/verify-key`, { signature }, { allow: [400, 401, 409, 410] });
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'keygen' && arg) await keygen(arg);
  else if (cmd === 'enrol') await enrol();
  else throw new Error('usage: enrol.mjs keygen <signer> | enrol');
} catch (err) {
  console.error(`FAIL  ${/** @type {Error} */ (err).message}`);
  process.exit(1);
}

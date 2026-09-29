// Enrolment definitions and local state for the POC tenant (build plan task 1.3).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCOPE = 'office_supplies.purchase';
export const STATE = 'state/enrolment.json';

/** Agent A's SOP replaces the onboarding default entirely, so it restates the default blocks and adds the RM300 escalation. */
export const AGENT_A_SOP = {
  title: 'POC Agent A controls',
  documentJson: {
    molecules: [
      { id: 'amount-known', name: 'Amount must be determinable', combinator: 'any', atoms: [{ id: 'a0', predicate: 'amount-unknown' }], decision: 'block', reasonCode: 'AMOUNT_NOT_DETERMINABLE' },
      { id: 'cap', name: 'Per-transaction cap', combinator: 'any', atoms: [{ id: 'a1', predicate: 'amount-over', config: { limit: 500, currency: ['MYR'] } }], decision: 'block', reasonCode: 'SOP_SPEND_CAP' },
      { id: 'approval-over-300', name: 'Approval over RM300', combinator: 'any', atoms: [{ id: 'a2', predicate: 'amount-over', config: { limit: 300, currency: ['MYR'] } }], decision: 'escalate', reasonCode: 'AMOUNT_ABOVE_APPROVAL_THRESHOLD' },
      { id: 'review', name: 'High-risk review', combinator: 'any', atoms: [{ id: 'a3', predicate: 'risk-at-or-above', config: { level: 'high' } }], decision: 'escalate', reasonCode: 'RISK_REVIEW' },
    ],
  },
};

// maxAmount is the cumulative budget and it never resets, so it is sized for many
// baseline and matrix runs (each allowed purchase is small). The per-transaction caps are
// the scenario's rules: A RM500 at OfficeMart, B RM200 at PaperCo.
export const AGENTS = /** @type {const} */ ([
  { key: 'A', signer: 'agentA', body: { name: 'POC Agent A (OfficeMart)', scope: SCOPE, network: 'testnet', currency: 'MYR', maxAmount: 20000, perTxnMax: 500, merchants: ['OfficeMart'], requirePayloadBinding: true, sop: AGENT_A_SOP } },
  { key: 'B', signer: 'agentB', body: { name: 'POC Agent B (PaperCo)', scope: SCOPE, network: 'testnet', currency: 'MYR', maxAmount: 20000, perTxnMax: 200, merchants: ['PaperCo'], requirePayloadBinding: true } },
]);

/** @param {string} name */
export const signerDir = (name) => `state/signers/${name}`;
/** @param {string} key */
export const agentConfigPath = (key) => `state/agents/${key}.json`;

/** @returns {{ agents: Record<string, { agentDid: string, identityId: string, keyVerified: boolean, signer: string }>, serviceDid?: string, counterpartyId?: string, policyPublicKey?: string, apiBase?: string }} */
export function loadState() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { agents: {} };
}

/** @param {string} path @param {unknown} value */
export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// The MetaMynd allow path (design §3.1 `signer` + `gate`, §5.1). For a canonicalised request
// from a bound sandbox, the adapter acts as the agent: it asks MetaMynd for a decision with the
// agent's daemon-held key, and on a permit builds the signed request the purchasing gateway
// re-verifies and claims. This is the create-metamynd-agent pattern: authorize, then a freshly
// signed request carrying the authorizationId, sent as `x-magp-request`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error -- the @metamynd packages ship no type declarations
import { createGuard } from '@metamynd/agentsafe-guard';
import { openEscalations, requestFingerprint } from './escalations.mjs';
import { REASON } from './reasons.mjs';

const PERMITS = new Set(['allow', 'observe']);

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`gate deadline ${ms}ms exceeded`)), ms); });
  return /** @type {Promise<T>} */ (Promise.race([promise, deadline]).finally(() => clearTimeout(timer)));
}

/**
 * @param {object} opts
 * @param {string} opts.agentsDir directory holding each enrolled agent's guard config (<agentKey>.json)
 * @param {string} [opts.apiBase] overrides the config's apiBase (default: the config's)
 * @param {number} [opts.deadlineMs] budget for authorize + signing (design §5.3: 4 s)
 * @param {(opts: object) => any} [opts.guardFactory] injectable for tests
 * @param {ReturnType<typeof openEscalations>} [opts.escalations] the escalations awaiting a person (default: in memory)
 * @returns {(ctx: { binding: import('./registry.mjs').Binding, route: import('./routes.mjs').Route, canon: any, requestContext: any }) => Promise<import('./adapter.mjs').Verdict>}
 */
export function createMetaMyndGate({ agentsDir, apiBase, deadlineMs = 4000, guardFactory = createGuard, escalations = openEscalations(null) }) {
  /** @type {Map<string, any>} one guard per (agent, signer socket) */
  const guards = new Map();

  /** @param {import('./registry.mjs').Binding} binding */
  function guardFor(binding) {
    const key = `${binding.agentDid}|${binding.signerSocket}`;
    let guard = guards.get(key);
    if (!guard) {
      const config = JSON.parse(readFileSync(join(agentsDir, `${binding.agentKey}.json`), 'utf8'));
      if (config.agentDid !== binding.agentDid) throw new Error(`agent config ${binding.agentKey} does not match the bound DID`);
      guard = guardFactory({ config: { ...config, ...(apiBase ? { apiBase } : {}) }, keyProvider: 'daemon', daemonSocketPath: binding.signerSocket });
      guards.set(key, guard);
    }
    return guard;
  }

  return async function gate({ binding, route, canon, requestContext }) {
    const guard = guardFor(binding);
    const request = {
      action: canon.action,
      amount: canon.fields.amount,
      currency: canon.fields.currency,
      merchant: canon.fields.merchant,
      // Operator route config, never the agent's request; covered by the context signature.
      context: { riskLevel: route.riskLevel },
      // Correlation (design §7): the sandbox and OpenShell's request id land in MetaMynd's decision record.
      trace: { workflowId: String(requestContext.sandbox_id ?? ''), parentActionId: String(requestContext.request_id ?? '') },
      payload: canon.payload,
    };
    /** @param {{ decision: string, reasonCode?: string, authorizationId: string, eventId?: string, escalationId?: string }} base */
    const permitWith = async (base) => {
      const signed = await guard.buildSignedRequest(request);
      signed.authorizationId = base.authorizationId;
      return {
        ...base,
        permit: true,
        headerMutations: [{ write: { name: 'x-magp-request', value: JSON.stringify(signed), on_existing: 'EXISTING_HEADER_ACTION_OVERWRITE' } }],
      };
    };
    // The approval path: an escalated request is held for a person, and the agent can only resend it. The resend resumes
    // the escalation it raised — never a second one — and once a person approved it, runs on the authorization that
    // approval minted. The gateway claims that authorization atomically and checks it is this exact request (amount,
    // merchant, payload and context), so a resend can spend an approval at most once.
    const fingerprint = requestFingerprint(binding.agentDid, request);
    return withDeadline((async () => {
      const held = escalations.get(fingerprint);
      if (held) {
        // MetaMynd not answering is not an answer: fail closed and keep the entry, or a person's approval is lost.
        const unavailable = { decision: 'error', reasonCode: 'GATE_UNREACHABLE', osReasonCode: REASON.UNAVAILABLE, escalationId: held, permit: false };
        const st = await guard.escalationStatus(held);
        if (st?.status === 'unreachable' || /^GATE_HTTP_5\d\d$/.test(String(st?.reasonCode ?? ''))) return unavailable;
        if (st?.status === 'pending') return { decision: 'escalate', reasonCode: st.reasonCode ?? 'ESCALATION_PENDING', escalationId: held, permit: false };
        if (st?.status === 'approved' && st.authorizationId) {
          const fx = await guard.effectStatus(st.authorizationId);
          if (fx?.effectState === 'unreachable') return unavailable;
          if (fx?.outcome === 'not_started') {
            return permitWith({ decision: 'allow', reasonCode: 'ESCALATION_APPROVED', authorizationId: st.authorizationId, escalationId: held });
          }
        }
        // Denied, expired, modified (the approved request is not this one), or already spent: this request asks afresh.
        escalations.forget(fingerprint);
      }
      const verdict = await guard.authorize(request);
      const base = { decision: String(verdict?.decision ?? 'error'), reasonCode: verdict?.reasonCode,
        authorizationId: verdict?.authorizationId ?? undefined, eventId: verdict?.eventId ?? undefined, escalationId: verdict?.escalationId ?? undefined };
      if (base.decision === 'escalate' && base.escalationId) escalations.remember(fingerprint, base.escalationId);
      if (!PERMITS.has(base.decision) || !base.authorizationId) return { ...base, permit: false };
      return permitWith(/** @type {any} */ (base));
    })(), deadlineMs);
  };
}

// MetaMynd OpenShell adapter: SupervisorMiddleware handlers (design §3.1, §5).
// Pipeline for every request: authenticate the gateway JWT and bind it to the request's
// sandbox_id -> look up the sandbox's agent binding -> match a route -> canonicalise ->
// ask MetaMynd (the `gate`). Every path that is not an explicit MetaMynd permit (or a
// read-only passthrough route) returns DENY with a stable reason_code; errors never allow.
import grpc from '@grpc/grpc-js';
import { canonicalise } from './canon.mjs';
import { buildManifest, checkGatewayMetadata, structToObject } from './describe.mjs';
import { ExtensionAuthError } from './jwt.mjs';
import { REASON, isValidReasonCode, mapMetaMyndReason } from './reasons.mjs';
import { matchRoute } from './routes.mjs';

export const ADAPTER_VERSION = '0.2.2-m3';

/**
 * HttpResponsePreReturn handler (design §3.1 `response`): evidence only. At preflight it
 * journals the upstream status against the request_id, then skips the stage. It never blocks
 * a response and never settles anything: OpenShell does not call it when the upstream fails,
 * so settlement stays with the purchasing gateway.
 * @param {object} opts
 * @param {((authorization: unknown) => import('./jwt.mjs').ExtensionClaims) | null} opts.verifyToken
 * @param {{ append(entry: Record<string, unknown>): unknown }} opts.journal
 * @param {(entry: Record<string, unknown>) => void} [opts.log]
 */
export function createResponseHandlers({ verifyToken, journal, log = () => {} }) {
  return {
    /** @param {any} call bidirectional stream of HttpResponseEvent / HttpResponseEventResult */
    Evaluate(call) {
      let trusted = !verifyToken;
      if (verifyToken) {
        try {
          const claims = verifyToken(call.metadata.get('authorization')[0]);
          trusted = claims.caller_kind === 'supervisor';
        } catch (err) {
          log({ rpc: 'HttpResponsePreReturn', auth: err instanceof ExtensionAuthError ? err.code : 'error' });
        }
      }
      call.on('data', (/** @type {any} */ event) => {
        if (!event?.preflight) return; // body/trailers never follow a skip; session_end needs no reply
        const ctx = event.preflight.context ?? {};
        if (trusted) {
          try {
            journal.append({ kind: 'response', requestId: ctx.request_id, sandboxId: ctx.sandbox_id, statusCode: event.preflight.status_code });
          } catch (err) {
            log({ event: 'journal_write_failed', error: String(/** @type {Error} */ (err).message) });
          }
        }
        call.write({ preflight_result: { skip: {} } });
      });
      call.on('end', () => call.end());
      call.on('error', () => {});
    },
  };
}

/** @param {number} code @param {string} details */
const rpcError = (code, details) => Object.assign(new Error(details), { code, details });

/**
 * @typedef {object} Verdict
 * @property {boolean} permit
 * @property {string} decision MetaMynd decision (allow/observe/block/escalate/...) or 'error'
 * @property {string} [reasonCode] MetaMynd reason code
 * @property {string} [osReasonCode] adapter-level OpenShell code when MetaMynd was not reached
 * @property {string} [authorizationId]
 * @property {string} [eventId]
 * @property {string} [escalationId]
 * @property {Array<{ write: { name: string, value: string, on_existing: string } }>} [headerMutations]
 */

/**
 * @param {object} opts
 * @param {((authorization: unknown) => import('./jwt.mjs').ExtensionClaims) | null} opts.verifyToken null only in insecure mode
 * @param {string} opts.audience
 * @param {number} opts.maxPayloadBytes
 * @param {Map<string, import('./routes.mjs').Route[]>} opts.routeSets route files by name
 * @param {{ lookup(sandboxId: unknown): import('./registry.mjs').Binding | null }} opts.registry
 * @param {{ append(entry: Record<string, unknown>): unknown }} opts.journal
 * @param {((ctx: { binding: import('./registry.mjs').Binding, route: import('./routes.mjs').Route, canon: any, requestContext: any }) => Promise<Verdict>) | null} opts.gate
 *   null until the allow path is built (M3): every governed request is then denied
 * @param {boolean} [opts.responseBinding] advertise HTTP_RESPONSE/PRE_RETURN (serve createResponseHandlers too)
 * @param {(entry: Record<string, unknown>) => void} [opts.log]
 */
export function createAdapterHandlers({ verifyToken, audience, maxPayloadBytes, routeSets, registry, journal, gate, responseBinding = false, log = () => {} }) {
  /** @param {any} call @param {Array<'gateway' | 'supervisor'>} allowed */
  function authenticate(call, allowed) {
    if (!verifyToken) return null;
    const claims = verifyToken(call.metadata.get('authorization')[0]);
    if (!allowed.includes(claims.caller_kind)) throw new ExtensionAuthError('caller_not_allowed', `caller_kind ${claims.caller_kind} may not call this RPC`);
    return claims;
  }

  /** @param {unknown} err */
  function authStatus(err) {
    if (err instanceof ExtensionAuthError) {
      return rpcError(err.code === 'caller_not_allowed' ? grpc.status.PERMISSION_DENIED : grpc.status.UNAUTHENTICATED, err.message);
    }
    return rpcError(grpc.status.INTERNAL, 'internal error');
  }

  /** @param {Record<string, unknown>} config @returns {string | null} */
  function configProblem(config) {
    const extra = Object.keys(config).filter((k) => k !== 'routes' && k !== 'mode');
    if (extra.length) return `unknown config keys: ${extra.join(', ')}`;
    if (typeof config.routes !== 'string' || !routeSets.has(config.routes)) return `config.routes must name one of: ${[...routeSets.keys()].join(', ')}`;
    if (config.mode !== undefined && config.mode !== 'enforce') return 'config.mode must be "enforce"';
    return null;
  }

  /**
   * The whole decision for one request. Never throws; never returns allow except for a
   * MetaMynd permit or an operator-declared passthrough route.
   * @param {any} call
   */
  async function evaluate(call) {
    const started = Date.now();
    const req = call.request ?? {};
    const ctx = req.context ?? {};
    const target = req.target ?? {};
    /** @type {Record<string, unknown>} */
    const entry = { kind: 'request', requestId: ctx.request_id, sandboxId: ctx.sandbox_id, sandboxName: ctx.sandbox,
      route: `${target.method ?? '?'} ${target.host ?? '?'}:${target.port ?? '?'}${target.path ?? ''}` };
    /** @param {string} osReasonCode @param {string} why @returns {{ allow: boolean, osReasonCode: string, headerMutations?: any[] }} */
    const deny = (osReasonCode, why) => {
      Object.assign(entry, { decision: 'deny', osReasonCode, why });
      return { allow: false, osReasonCode };
    };

    const result = await (async () => {
      try {
        const claims = authenticate(call, ['supervisor']);
        if (claims && claims.sandbox_id !== ctx.sandbox_id) return deny(REASON.CALLER_UNAUTHENTICATED, 'token sandbox_id differs from the request context');
      } catch (err) {
        return deny(REASON.CALLER_UNAUTHENTICATED, err instanceof ExtensionAuthError ? err.code : 'token verification failed');
      }

      const config = structToObject(req.config);
      const problem = configProblem(config);
      if (problem) return deny(REASON.ROUTE_NOT_ALLOWED, problem);

      const binding = registry.lookup(ctx.sandbox_id);
      if (!binding) return deny(REASON.BINDING_UNKNOWN, 'no active binding for this sandbox_id');
      Object.assign(entry, { agentDid: binding.agentDid, generation: binding.generation });

      const route = matchRoute(/** @type {any} */ (routeSets.get(/** @type {string} */ (config.routes))), target);
      if (!route) return deny(REASON.ROUTE_NOT_ALLOWED, 'no route matches this request');
      if (route.action === null) {
        Object.assign(entry, { decision: 'passthrough' });
        return { allow: true, osReasonCode: '' };
      }
      entry.action = route.action;

      const canon = canonicalise(route, { headers: req.headers, body: req.body }, maxPayloadBytes);
      if (!canon.ok) return deny(REASON.REQUEST_REJECTED, canon.why);
      Object.assign(entry, canon.fields);

      if (!gate) return deny(REASON.GATE_NOT_CONFIGURED, 'the MetaMynd allow path is not enabled');
      /** @type {Verdict} */
      let verdict;
      try {
        verdict = await gate({ binding, route, canon, requestContext: ctx });
      } catch {
        return deny(REASON.UNAVAILABLE, 'gate call failed');
      }
      Object.assign(entry, { decision: verdict.decision, reasonCode: verdict.reasonCode, authorizationId: verdict.authorizationId,
        eventId: verdict.eventId, escalationId: verdict.escalationId });
      if (verdict.permit) return { allow: true, osReasonCode: '', headerMutations: verdict.headerMutations };
      const code = verdict.osReasonCode ?? (verdict.decision === 'escalate' ? REASON.ESCALATION_PENDING : mapMetaMyndReason(verdict.reasonCode));
      entry.osReasonCode = code;
      return { allow: false, osReasonCode: code };
    })().catch(() => deny(REASON.INTERNAL, 'unexpected adapter error'));

    entry.latencyMs = Date.now() - started;
    try {
      journal.append(entry);
    } catch (err) {
      log({ event: 'journal_write_failed', error: String(/** @type {Error} */ (err).message) });
      if (result.allow) return { allow: false, osReasonCode: REASON.INTERNAL };
    }
    return result;
  }

  return {
    /** @param {any} call @param {any} callback */
    Describe(call, callback) {
      try {
        const claims = authenticate(call, ['gateway', 'supervisor']);
        const refused = checkGatewayMetadata(call.request.gateway);
        log({ rpc: 'Describe', caller: claims?.caller_kind ?? 'unauthenticated', refused });
        if (refused) return callback(rpcError(grpc.status.FAILED_PRECONDITION, refused));
        callback(null, buildManifest({ name: 'metamynd/openshell-adapter', version: ADAPTER_VERSION,
          expectedAudience: verifyToken ? audience : '', maxPayloadBytes, responseBinding }));
      } catch (err) {
        callback(authStatus(err));
      }
    },

    /** @param {any} call @param {any} callback */
    ValidateConfig(call, callback) {
      try {
        authenticate(call, ['gateway']);
        const problem = configProblem(structToObject(call.request.config));
        log({ rpc: 'ValidateConfig', middleware: call.request.middleware_name, valid: !problem, reason: problem });
        callback(null, { valid: !problem, reason: problem ?? '' });
      } catch (err) {
        callback(authStatus(err));
      }
    },

    /** @param {any} call @param {any} callback */
    EvaluateHttpRequest(call, callback) {
      evaluate(call).then((r) => {
        const code = r.allow ? '' : (isValidReasonCode(r.osReasonCode) ? r.osReasonCode : REASON.INTERNAL);
        callback(null, {
          decision: r.allow ? 'DECISION_ALLOW' : 'DECISION_DENY',
          reason: r.allow ? '' : 'denied by MetaMynd adapter',
          reason_code: code,
          header_mutations: r.allow ? (r.headerMutations ?? []) : [],
        });
      });
    },
  };
}

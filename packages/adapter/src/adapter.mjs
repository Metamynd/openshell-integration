// MetaMynd OpenShell adapter: SupervisorMiddleware handlers (design §3.1, §5).
// Pipeline for every request: authenticate the gateway JWT and bind it to the request's
// sandbox_id -> look up the sandbox's agent binding -> match a route -> canonicalise ->
// ask MetaMynd (the `gate`). Every path that is not an explicit MetaMynd permit (or a
// read-only passthrough route) returns DENY with a stable reason_code; errors never allow.
import grpc from '@grpc/grpc-js';
import { accessPrincipal, checkAccessBody } from './access.mjs';
import { canonicalise } from './canon.mjs';
import { checkOutputRequest } from './output.mjs';
import { buildManifest, checkGatewayMetadata, structToObject } from './describe.mjs';
import { ExtensionAuthError } from './jwt.mjs';
import { REASON, isValidReasonCode, mapMetaMyndReason } from './reasons.mjs';
import { matchRoute } from './routes.mjs';

export const ADAPTER_VERSION = '0.4.0-m3';

const WHOLE_BODY = 'HTTP_RESPONSE_BODY_MODE_WHOLE_BODY_BYTES';
// Statuses that carry no body: nothing to withhold.
const BODYLESS = new Set([204, 205, 304]);

/**
 * HttpResponsePreReturn handler (design §3.1 `response`). At preflight it journals the upstream status against the
 * request_id. A route with no `access` is then skipped, as before: this stage never settles anything (OpenShell does not
 * call it when the upstream fails, so settlement stays with the purchasing gateway).
 *
 * A route with `access` (access.mjs) asks for the whole body of a 2xx answer and blocks its delivery unless every tenant
 * and user field it names holds the principal the sandbox is bound for. The upstream call already ran; what is withheld
 * is its answer, and OpenShell returns its canonical 403 with the reason_code (never the field's value). An answer that
 * cannot be read whole (encoded, partial, too large) is withheld as uncheckable.
 * @param {object} opts
 * @param {((authorization: unknown) => import('./jwt.mjs').ExtensionClaims) | null} opts.verifyToken
 * @param {{ append(entry: Record<string, unknown>): unknown }} opts.journal
 * @param {Map<string, import('./routes.mjs').Route[]>} [opts.routeSets] route files by name; without them no answer is checked
 * @param {{ lookup(sandboxId: unknown): import('./registry.mjs').Binding | null }} [opts.registry]
 * @param {(entry: Record<string, unknown>) => void} [opts.log]
 */
export function createResponseHandlers({ verifyToken, journal, routeSets, registry, log = () => {} }) {
  /** @param {Record<string, unknown>} entry */
  const record = (entry) => {
    try {
      journal.append(entry);
    } catch (err) {
      log({ event: 'journal_write_failed', error: String(/** @type {Error} */ (err).message) });
    }
  };
  /** @param {string} reasonCode @param {string} reason */
  const block = (reasonCode, reason) => ({ block_delivery: {}, reason_code: mapMetaMyndReason(reasonCode), reason });
  // A preflight that fails before its route is known is blocked only when some route could have needed the check.
  const anyAccess = [...(routeSets?.values() ?? [])].some((routes) => routes.some((r) => r.access));

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
      /** @type {{ access: import('./access.mjs').RouteAccess, principal: { tenantId?: string | number, userId?: string | number }, entry: Record<string, unknown> } | null} */
      let pending = null;

      /** @param {any} preflight */
      function onPreflight(preflight) {
        const ctx = preflight.context ?? {};
        /** @type {Record<string, unknown>} */
        const entry = { kind: 'response', requestId: ctx.request_id, sandboxId: ctx.sandbox_id, statusCode: preflight.status_code };
        const config = structToObject(preflight.config);
        const routes = typeof config.routes === 'string' ? routeSets?.get(config.routes) : undefined;
        const route = routes ? matchRoute(routes, preflight.target ?? {}) : null;
        const status = Number(preflight.status_code);
        if (!route?.access || status < 200 || status >= 300) {
          if (trusted) record(entry);
          return { skip: {} };
        }
        // From here the answer is checked; what happens to it is journaled either way.
        const withhold = (/** @type {string} */ reasonCode, /** @type {string} */ why) => {
          record({ ...entry, access: 'withheld', reasonCode, why });
          return block(reasonCode, why);
        };
        if (!trusted) return withhold('ACCESS_CONTEXT_UNCHECKABLE', 'the response stage caller is not authenticated');
        const principal = accessPrincipal(route.access, registry?.lookup(ctx.sandbox_id) ?? null);
        if (!principal) return withhold('ACCESS_PRINCIPAL_UNAVAILABLE', 'no access principal for this sandbox');
        const modes = preflight.permitted_body_modes ?? [];
        if (!modes.includes(WHOLE_BODY)) {
          if (BODYLESS.has(status) || preflight.target?.method === 'HEAD') {
            record({ ...entry, access: 'released' });
            return { skip: {} };
          }
          return withhold('ACCESS_CONTEXT_UNCHECKABLE', 'the answer cannot be read whole (encoded, partial or larger than the limit)');
        }
        pending = { access: route.access, principal, entry };
        return { inspect: { body_mode: WHOLE_BODY, header_mutations: [] } };
      }

      // Once a body unit is blocked, every later unit on this stream is blocked too (OpenShell should send none).
      let blocked = false;
      /** @param {any} body */
      function onBody(body) {
        if (blocked) return { sequence: body.sequence, ...block('ACCESS_CONTEXT_UNCHECKABLE', 'delivery already blocked') };
        const p = pending;
        if (!p) return { sequence: body.sequence, pass_through: {} };
        pending = null;
        // WHOLE_BODY_BYTES delivers the body as one final unit.
        const refusal = body.end_of_stream
          ? checkAccessBody(body.data ?? new Uint8Array(0), p.access, p.principal)
          : { reasonCode: 'ACCESS_CONTEXT_UNCHECKABLE', path: '', detail: 'the answer arrived in parts' };
        if (!refusal) {
          record({ ...p.entry, access: 'released' });
          return { sequence: body.sequence, pass_through: {} };
        }
        const why = `${refusal.reasonCode} at ${refusal.path || '(body)'}${refusal.detail ? `: ${refusal.detail}` : ''}`;
        record({ ...p.entry, access: 'withheld', reasonCode: refusal.reasonCode, path: refusal.path });
        blocked = true;
        return { sequence: body.sequence, ...block(refusal.reasonCode, why) };
      }

      call.on('data', (/** @type {any} */ event) => {
        try {
          if (event?.preflight) call.write({ preflight_result: onPreflight(event.preflight) });
          else if (event?.body) call.write({ body_result: onBody(event.body) });
          else if (event?.trailers) call.write({ trailers_result: { trailer_mutations: [] } });
          // session_end needs no reply
        } catch (err) {
          log({ rpc: 'HttpResponsePreReturn', event: 'error', error: String(/** @type {Error} */ (err)?.message ?? err) });
          // An answer under an access check that could not be checked is never delivered; one without a check is unaffected.
          if (event?.preflight) call.write({ preflight_result: anyAccess ? block('ACCESS_CONTEXT_UNCHECKABLE', 'adapter error') : { skip: {} } });
          else if (event?.body) call.write({ body_result: { sequence: event.body.sequence, ...block('ACCESS_CONTEXT_UNCHECKABLE', 'adapter error') } });
        }
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
      // Under an access check the answer is compared with the principal this sandbox is bound for; with none to compare
      // against, nothing is sent (the response stage would only withhold the answer of a call that already ran).
      if (route.access && !accessPrincipal(route.access, binding)) return deny(REASON.ACCESS_PRINCIPAL_UNAVAILABLE, 'no access principal for this sandbox');
      // Under an output check, a request whose body or query string has a forbidden word is never sent, and nothing is asked
      // of MetaMynd (no hold is claimed). The journal names where the word is, never the word.
      if (route.output) {
        const contentType = (req.headers ?? []).filter((/** @type {any} */ h) => h.name === 'content-type').map((/** @type {any} */ h) => h.value).join(',') || undefined;
        const refusal = checkOutputRequest(req.body ?? new Uint8Array(0), String(target.query ?? ''), contentType, route.output, { path: String(target.path ?? ''), headers: req.headers ?? [] });
        if (refusal) {
          Object.assign(entry, { output: 'refused', reasonCode: refusal.reasonCode, path: refusal.path });
          return deny(mapMetaMyndReason(refusal.reasonCode), `${refusal.reasonCode} at ${refusal.path || '(body)'}${refusal.detail ? `: ${refusal.detail}` : ''}`);
        }
      }
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

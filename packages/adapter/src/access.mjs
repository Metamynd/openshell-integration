// The access check on what an upstream returns to a sandbox (route `access`, design §3.1 `response`). The same check as
// agentsafe-http-gateway's route.access, run at OpenShell's response stage: an answer reaches the agent only when every
// tenant and user field the route names holds the principal the sandbox is bound for. It fails closed: an answer that
// cannot be read whole, is not strict JSON, or lacks a named field is withheld.
import { parseStrictJson } from '@metamynd/agentsafe-http-gateway';
import { assertAccessPolicy, checkAccessContext } from '@metamynd/agentsafe-http-gateway/access-context';

/**
 * @typedef {object} RouteAccess
 * @property {string[]} [tenant] JSON Pointers into the answer, `*` any key or index
 * @property {string[]} [user]
 * @property {{ tenantId?: string | number, userId?: string | number } | 'binding'} principal fixed, or the one the operator
 *   recorded on the sandbox's binding (`bindings.mjs bind ... --tenant T --user U`); never anything the sandbox sends
 */

/**
 * A route's `access`, checked when the routes file loads.
 * @param {unknown} access
 * @param {string} where
 * @returns {RouteAccess}
 */
export function validateRouteAccess(access, where) {
  const a = /** @type {any} */ (access);
  const fromBinding = a && typeof a === 'object' && a.principal === 'binding';
  // 'binding' is resolved per request; validate the rest as a resolver would be.
  assertAccessPolicy({ access: fromBinding ? { ...a, principal: () => ({}) } : a }, where);
  return { ...(a.tenant ? { tenant: [...a.tenant] } : {}), ...(a.user ? { user: [...a.user] } : {}),
    principal: fromBinding ? 'binding' : { tenantId: a.principal.tenantId, userId: a.principal.userId } };
}

/** @param {unknown} v */
const idOk = (v) => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v));

/**
 * The principal a sandbox's request is served for, or null when there is none to check against.
 * @param {RouteAccess} access
 * @param {{ accessPrincipal?: { tenantId?: string | number, userId?: string | number } } | null} binding
 */
export function accessPrincipal(access, binding) {
  const p = access.principal === 'binding' ? binding?.accessPrincipal : access.principal;
  if (!p || (access.tenant && !idOk(p.tenantId)) || (access.user && !idOk(p.userId))) return null;
  return { tenantId: p.tenantId, userId: p.userId };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether an answer's body may reach the sandbox: null to release it, or { reasonCode, path, detail? }. An empty body
 * carries no records and is released.
 * @param {Uint8Array} bytes
 * @param {RouteAccess} access
 * @param {{ tenantId?: string | number, userId?: string | number }} principal
 * @returns {{ reasonCode: string, path: string, detail?: string } | null}
 */
export function checkAccessBody(bytes, access, principal) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { reasonCode: 'ACCESS_CONTEXT_UNCHECKABLE', path: '', detail: 'the answer is not UTF-8' };
  }
  if (!text.trim()) return null;
  let body;
  try {
    body = parseStrictJson(text);
  } catch {
    return { reasonCode: 'ACCESS_CONTEXT_UNCHECKABLE', path: '', detail: 'the answer is not strict JSON' };
  }
  const found = checkAccessContext(body, access, principal);
  return found ? { reasonCode: found.reasonCode, path: found.path, ...(found.detail ? { detail: found.detail } : {}) } : null;
}

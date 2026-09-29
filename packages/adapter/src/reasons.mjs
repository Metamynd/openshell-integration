// OpenShell reason_code mapping (design §4.5). OpenShell accepts ^[a-z][a-z0-9_]{0,63}$ and
// may return the code to the sandbox; free-text reasons are never returned or logged by it.

export const REASON = Object.freeze({
  ROUTE_NOT_ALLOWED: 'metamynd_route_not_allowed',
  BINDING_UNKNOWN: 'metamynd_binding_unknown',
  CALLER_UNAUTHENTICATED: 'metamynd_caller_unauthenticated',
  REQUEST_REJECTED: 'metamynd_request_rejected',
  SIGNER_UNAVAILABLE: 'metamynd_signer_unavailable',
  UNAVAILABLE: 'metamynd_unavailable',
  ESCALATION_PENDING: 'metamynd_escalation_pending',
  GATE_NOT_CONFIGURED: 'metamynd_gate_not_configured',
  INTERNAL: 'metamynd_internal_error',
});

const GRAMMAR = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Map a MetaMynd reason code (e.g. SPEND_LIMIT_EXCEEDED, CONSTRAINT_FAILED:mm:merchant) to an
 * OpenShell reason_code: metamynd_ + lowercase, anything outside [a-z0-9_] becomes _, 64 bytes max.
 * @param {unknown} code
 */
export function mapMetaMyndReason(code) {
  if (typeof code !== 'string' || code === '') return REASON.UNAVAILABLE;
  const mapped = `metamynd_${code.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 64);
  return GRAMMAR.test(mapped) ? mapped : REASON.UNAVAILABLE;
}

/** @param {string} code */
export const isValidReasonCode = (code) => GRAMMAR.test(code);

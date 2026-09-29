// Canonicalise a governed HTTP request into the action MetaMynd will judge (design §3.1 `canon`).
// Everything ambiguous is refused rather than interpreted: an encoded or non-JSON body, repeated
// framing headers, non-strict JSON (duplicate keys, unsafe numbers), unknown fields, and value
// fields the purchasing gateway could not bind (amount must be a JSON number).
// @ts-expect-error -- the @metamynd packages ship no type declarations
import { parseStrictJson } from '@metamynd/agentsafe-http-gateway';

const CURRENCY = /^[A-Z]{3}$/;

/**
 * @param {import('./routes.mjs').Route} route a governed route
 * @param {{ headers?: Array<{ name: string, value: string }>, body?: Uint8Array }} request
 * @param {number} maxBodyBytes
 * @returns {{ ok: true, action: string, fields: { amount: number, currency: string, merchant: string }, payload: Record<string, unknown> } | { ok: false, why: string }}
 */
export function canonicalise(route, request, maxBodyBytes) {
  const headers = request.headers ?? [];
  /** @param {string} name */
  const values = (name) => headers.filter((h) => h.name === name).map((h) => h.value);

  if (values('content-encoding').length > 0) return { ok: false, why: 'content-encoding is not accepted' };
  const types = values('content-type');
  if (types.length !== 1) return { ok: false, why: 'exactly one content-type header is required' };
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(types[0].trim())) return { ok: false, why: 'content-type must be application/json' };

  const body = request.body ?? new Uint8Array();
  if (body.length === 0) return { ok: false, why: 'a JSON body is required' };
  if (body.length > maxBodyBytes) return { ok: false, why: 'body exceeds the limit' };

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { ok: false, why: 'body is not valid UTF-8' };
  }
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, why: 'a byte-order mark is not accepted' };

  let payload;
  try {
    payload = parseStrictJson(text);
  } catch (err) {
    return { ok: false, why: String(/** @type {Error} */ (err).message) };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, why: 'body must be a JSON object' };

  const allowed = new Set(route.allowedFields);
  const unknown = Object.keys(payload).filter((k) => !allowed.has(k));
  if (unknown.length) return { ok: false, why: `fields not allowed on this route: ${unknown.join(', ')}` };
  const missing = (route.valueFields ?? []).filter((k) => payload[k] === undefined);
  if (missing.length) return { ok: false, why: `missing value fields: ${missing.join(', ')}` };

  const { amount, currency, merchant } = payload;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return { ok: false, why: 'amount must be a positive JSON number' };
  if (Math.round(amount * 100) / 100 !== amount) return { ok: false, why: 'amount has more than 2 decimal places' };
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return { ok: false, why: 'currency must be a 3-letter uppercase code' };
  if (typeof merchant !== 'string' || merchant.length === 0 || merchant.length > 120) return { ok: false, why: 'merchant must be a non-empty string' };

  return { ok: true, action: /** @type {string} */ (route.action), fields: { amount, currency, merchant }, payload };
}

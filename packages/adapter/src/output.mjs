// The output check on what a sandbox sends out (route `output`, design §4.2b). The same check as
// agentsafe-http-gateway's route.output, run at OpenShell's request stage: a request is sent only when its buffered body,
// its query string, its path (unless `path: false`) and the headers the route names have none of the operator's forbidden
// words, matched as words after folding (NFKC + Unicode case folding; a word in a script without spaces as a substring). It
// fails closed: a body that is not UTF-8, JSON that is not strict, or a form, query string or path that does not decode is
// refused as uncheckable.
import { parseStrictJson } from '@metamynd/agentsafe-http-gateway';
import { assertOutputPolicy, checkOutputBody, checkOutputHeaders, checkOutputPath, checkOutputQuery } from '@metamynd/agentsafe-http-gateway/output-filter';

/**
 * @typedef {object} RouteOutput
 * @property {string[]} forbidden each exactly one word; a phrase is refused when the routes file loads
 * @property {boolean} [path] the request path is checked unless this is false
 * @property {string[]} [headers] request headers whose values are checked too
 */

/**
 * A route's `output`, checked when the routes file loads.
 * @param {unknown} output
 * @param {string} where
 * @returns {RouteOutput}
 */
export function validateRouteOutput(output, where) {
  assertOutputPolicy({ output: /** @type {any} */ (output) }, where);
  const o = /** @type {any} */ (output);
  return { forbidden: [...o.forbidden], ...(o.path !== undefined ? { path: o.path } : {}), ...(o.headers !== undefined ? { headers: [...o.headers] } : {}) };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether a request may be sent: null, or { reasonCode, path, detail? } naming where the word is (`?` for the query
 * string), never the word. The body is read by its Content-Type: a form decoded, JSON strictly, anything else as text.
 * @param {Uint8Array} bytes the buffered request body (empty for a bodyless request)
 * @param {string} query the raw query string, without the `?`
 * @param {string | undefined} contentType
 * @param {RouteOutput} output
 * @param {{ path?: string, headers?: Array<{ name: string, value: string }> }} [request] the request path (checked unless
 *   `output.path` is false; refusal path `@path`) and headers (only those `output.headers` names; `@headers/<name>`)
 * @returns {{ reasonCode: string, path: string, detail?: string } | null}
 */
export function checkOutputRequest(bytes, query, contentType, output, { path, headers } = {}) {
  const inPath = checkOutputPath(String(path ?? ''), output);
  if (inPath) return inPath;
  const inQuery = checkOutputQuery(query, output);
  if (inQuery) return inQuery;
  /** @type {Record<string, string[]>} */
  const byName = {};
  for (const h of headers ?? []) (byName[h.name] ??= []).push(h.value);
  const inHeaders = checkOutputHeaders(byName, output);
  if (inHeaders) return inHeaders;
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { reasonCode: 'OUTPUT_UNCHECKABLE', path: '', detail: 'the body is not UTF-8' };
  }
  return checkOutputBody(text, contentType, output, parseStrictJson);
}

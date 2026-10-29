// The output check on what a sandbox sends out (route `output`, design §4.2b). The same check as
// agentsafe-http-gateway's route.output, run at OpenShell's request stage: a request is sent only when its buffered body and
// its query string have none of the operator's forbidden words, matched as words after folding (NFKC + case). It fails
// closed: a body that is not UTF-8, JSON that is not strict, or a form or query string that does not decode is refused as
// uncheckable.
import { parseStrictJson } from '@metamynd/agentsafe-http-gateway';
import { assertOutputPolicy, checkOutputBody, checkOutputQuery } from '@metamynd/agentsafe-http-gateway/output-filter';

/**
 * @typedef {object} RouteOutput
 * @property {string[]} forbidden each exactly one word; a phrase is refused when the routes file loads
 */

/**
 * A route's `output`, checked when the routes file loads.
 * @param {unknown} output
 * @param {string} where
 * @returns {RouteOutput}
 */
export function validateRouteOutput(output, where) {
  assertOutputPolicy({ output: /** @type {any} */ (output) }, where);
  return { forbidden: [.../** @type {any} */ (output).forbidden] };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether a request may be sent: null, or { reasonCode, path, detail? } naming where the word is (`?` for the query
 * string), never the word. The body is read by its Content-Type: a form decoded, JSON strictly, anything else as text.
 * @param {Uint8Array} bytes the buffered request body (empty for a bodyless request)
 * @param {string} query the raw query string, without the `?`
 * @param {string | undefined} contentType
 * @param {RouteOutput} output
 * @returns {{ reasonCode: string, path: string, detail?: string } | null}
 */
export function checkOutputRequest(bytes, query, contentType, output) {
  const inQuery = checkOutputQuery(query, output);
  if (inQuery) return inQuery;
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { reasonCode: 'OUTPUT_UNCHECKABLE', path: '', detail: 'the body is not UTF-8' };
  }
  return checkOutputBody(text, contentType, output, parseStrictJson);
}

// Host-aware route matching (design §4.2). Path and method rules reuse agentsafe-http-gateway's
// matcher (percent-decoding, `*` one segment, trailing `**` the rest) so the adapter and the
// purchasing gateway classify a request identically; the adapter adds host and port.
import { readFileSync } from 'node:fs';
// @ts-expect-error -- the @metamynd packages ship no type declarations
import { methodMatches, pathMatches } from '@metamynd/agentsafe-http-gateway/route-match';

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

/**
 * @typedef {object} Route
 * @property {string} host
 * @property {number} port
 * @property {string} method
 * @property {string} path
 * @property {string | null} action null = read-only passthrough, never sent to MetaMynd
 * @property {string[]} [valueFields]
 * @property {string[]} [allowedFields]
 * @property {'low' | 'medium' | 'high' | 'critical'} [riskLevel] required for governed routes
 */

/** @param {unknown} raw @param {string} source @returns {Route[]} */
export function validateRoutes(raw, source) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${source}: routes must be a non-empty array`);
  return raw.map((r, i) => {
    const where = `${source}[${i}]`;
    if (!r || typeof r !== 'object') throw new Error(`${where}: route must be an object`);
    if (typeof r.host !== 'string' || !r.host) throw new Error(`${where}: host is required`);
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) throw new Error(`${where}: port must be 1-65535`);
    if (typeof r.method !== 'string' || typeof r.path !== 'string') throw new Error(`${where}: method and path are required`);
    if (r.action === null) return { host: r.host.toLowerCase(), port: r.port, method: r.method, path: r.path, action: null };
    if (typeof r.action !== 'string' || !r.action) throw new Error(`${where}: action must be a string or null`);
    if (!RISK_LEVELS.has(r.riskLevel)) throw new Error(`${where}: governed routes need riskLevel low|medium|high|critical`);
    for (const k of ['valueFields', 'allowedFields']) {
      if (!Array.isArray(r[k]) || r[k].some((/** @type {unknown} */ f) => typeof f !== 'string')) throw new Error(`${where}: ${k} must be a string array`);
    }
    const missing = r.valueFields.filter((/** @type {string} */ f) => !r.allowedFields.includes(f));
    if (missing.length) throw new Error(`${where}: valueFields not in allowedFields: ${missing.join(', ')}`);
    return { host: r.host.toLowerCase(), port: r.port, method: r.method, path: r.path, action: r.action,
      valueFields: [...r.valueFields], allowedFields: [...r.allowedFields], riskLevel: r.riskLevel };
  });
}

/** @param {string} file */
export function loadRoutes(file) {
  return validateRoutes(JSON.parse(readFileSync(file, 'utf8')), file);
}

/**
 * First route matching the admitted request target, or null.
 * @param {Route[]} routes
 * @param {{ host?: string, port?: number, method?: string, path?: string }} target
 */
export function matchRoute(routes, target) {
  const host = String(target.host ?? '').toLowerCase();
  for (const r of routes) {
    if (r.host === host && r.port === Number(target.port) && methodMatches(r.method, target.method) && pathMatches(r.path, target.path ?? '')) return r;
  }
  return null;
}

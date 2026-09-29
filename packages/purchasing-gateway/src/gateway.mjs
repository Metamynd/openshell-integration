// Purchasing gateway (design §3.5): MetaMynd's agentsafe-http-gateway core, served over TLS
// on loopback, in front of the mock purchasing API. It is the second enforcement point and
// the party that settles each hold. Two checks run before any governance:
//   1. the upstream bearer token (what OpenShell substitutes from the provider after the
//      sandbox), so the sandbox's placeholder alone can never reach the ledger;
//   2. a body size limit.
// Only content-type and the gateway-set Idempotency-Key are forwarded upstream: the agent's
// Authorization and x-magp-request never reach the purchasing system.
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const MAX_BODY_BYTES = 1024 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'te', 'trailer', 'upgrade']);

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Forwarder for createHttpGateway: sends only what the purchasing API needs.
 * @param {string} upstream base URL, e.g. http://127.0.0.1:18080
 */
export function createForward(upstream) {
  const base = upstream.replace(/\/$/, '');
  /** @param {{ method: string, path: string, headers: Record<string, any>, rawBody?: Buffer }} req */
  return async function forward(req) {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const name of ['content-type', 'idempotency-key']) {
      const v = req.headers?.[name];
      if (typeof v === 'string') headers[name] = v;
    }
    /** @type {RequestInit} */
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.rawBody?.length) init.body = new Uint8Array(req.rawBody);
    const res = await fetch(base + req.path, init);
    return { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }, rawBody: Buffer.from(await res.arrayBuffer()) };
  };
}

/** @param {http.IncomingMessage} req @returns {Promise<Buffer | null>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {(req: object) => Promise<any>} opts.gateway the function createHttpGateway returns
 * @param {string} opts.bearerToken upstream API token OpenShell injects from the provider
 * @param {{ cert: Buffer, key: Buffer } | null} opts.tls null serves plain HTTP (tests only)
 * @param {(entry: Record<string, unknown>) => void} [opts.log]
 */
export function createPurchasingServer({ gateway, bearerToken, tls, log = () => {} }) {
  if (!bearerToken) throw new Error('bearerToken is required');
  const expected = `Bearer ${bearerToken}`;

  /** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify(body)}\n`);
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    const started = Date.now();
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !safeEqual(auth, expected)) {
      log({ method: req.method, path: req.url, status: 401, reasonCode: 'UPSTREAM_AUTH_REQUIRED' });
      return send(res, 401, { decision: 'block', reasonCode: 'UPSTREAM_AUTH_REQUIRED' });
    }
    const rawBody = await readBody(req);
    if (rawBody === null) return send(res, 413, { decision: 'block', reasonCode: 'BODY_TOO_LARGE' });

    let result;
    try {
      result = await gateway({ method: req.method, path: req.url, headers: req.headers, rawBody, body: null });
    } catch (err) {
      log({ method: req.method, path: req.url, status: 502, reasonCode: 'GATEWAY_ERROR', error: String(/** @type {any} */ (err)?.message ?? err) });
      return send(res, 502, { decision: 'block', reasonCode: 'GATEWAY_ERROR' });
    }
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(result.headers ?? { 'content-type': 'application/json' })) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
    }
    if (result.governance?.decision) headers['x-agentsafe-decision'] = result.governance.decision;
    log({ method: req.method, path: req.url, status: result.status, decision: result.governance?.decision,
      reasonCode: result.governance?.reasonCode ?? result.body?.reasonCode, authorizationId: result.governance?.authorizationId,
      ms: Date.now() - started });
    res.writeHead(result.status, headers);
    if (result.rawBody) res.end(result.rawBody);
    else res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {}));
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const listener = (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 502, { decision: 'block', reasonCode: 'GATEWAY_ERROR' });
    });
  };
  return tls ? https.createServer({ cert: tls.cert, key: tls.key }, listener) : http.createServer(listener);
}

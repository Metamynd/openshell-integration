// Purchasing gateway entry point. Env:
//   GW_BIND (127.0.0.1)  GW_PORT (8443)  GW_TLS_CERT / GW_TLS_KEY (required)
//   GW_UPSTREAM (http://127.0.0.1:18080)  GW_ROUTES (routes.json next to this package)
//   MM_API (https://metamynd.ai/api/v1)  MM_POLICY_PUBLIC_KEY (required; pinned bundle key)
//   SERVICE_DID (did:key of this gateway)  SERVICE_SIGNER_SOCKET (its agentsafe-signer daemon, role service)
//   PURCHASING_API_TOKEN (required; the bearer OpenShell substitutes from the provider)
//   GW_BUNDLE_TTL_MS (0 = off)  cache each agent's policy bundle this long (src/latency.mjs)
//   GW_ASYNC_CAPTURE (off)      1 = answer first, capture in the background (src/latency.mjs)
// Settlement: a 2xx upstream captures, 400/409/413/415/422 (the mock rejected it before any
// effect) release, anything else is marked unknown.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- the @metamynd packages ship no type declarations
import { createHttpGateway } from '@metamynd/agentsafe-http-gateway';
// @ts-expect-error -- the @metamynd packages ship no type declarations
import { createMcpGuard } from '@metamynd/agentsafe-mcp-guard';
import { createForward, createPurchasingServer } from './gateway.mjs';
import { createBundleCache, deferCapture } from './latency.mjs';

const env = process.env;
/** @param {Record<string, unknown>} entry */
const log = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
/** @param {string} name */
const required = (name) => {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const routesPath = env.GW_ROUTES ?? new URL('../routes.json', import.meta.url);
const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
const issuerApi = (env.MM_API ?? 'https://metamynd.ai/api/v1').replace(/\/$/, '');
const bundleTtlMs = Number(env.GW_BUNDLE_TTL_MS ?? 0);
const asyncCapture = env.GW_ASYNC_CAPTURE === '1';
const baseGuard = createMcpGuard({
  serviceDid: required('SERVICE_DID'),
  keyProvider: 'daemon',
  daemonSocketPath: required('SERVICE_SIGNER_SOCKET'),
  issuerApi,
  requireAuthorization: true,
  policyPublicKey: required('MM_POLICY_PUBLIC_KEY'),
  requireContextSignature: true,
  ...(bundleTtlMs > 0 ? { fetchBundle: createBundleCache({ issuerApi, ttlMs: bundleTtlMs }) } : {}),
});
const deferred = asyncCapture ? deferCapture(baseGuard, { log }) : null;
const guard = deferred ? deferred.guard : baseGuard;
const forward = createForward(env.GW_UPSTREAM ?? 'http://127.0.0.1:18080');
// GW_MODE=verify-only (adversarial matrix run B only): no MetaMynd checks at all, just the bearer
// check and forwarding, so the ledger shows exactly what OpenShell + the adapter let through.
const verifyOnly = env.GW_MODE === 'verify-only';
const gateway = verifyOnly
  ? async (/** @type {any} */ req) => ({ ...(await forward({ ...req, headers: { ...req.headers, 'idempotency-key': randomUUID() } })), governance: { decision: 'unverified' } })
  : createHttpGateway({
    guard,
    routes,
    forward,
    denyByDefault: true,
    requirePayloadBinding: true,
    requireContextSignature: true,
    releaseOnStatus: [400, 409, 413, 415, 422],
  });
if (verifyOnly) log({ event: 'WARNING_verify_only_mode', note: 'MetaMynd checks at the gateway are OFF' });
if (!verifyOnly && (bundleTtlMs > 0 || asyncCapture)) log({ event: 'latency_options', bundleTtlMs, asyncCapture });

const server = createPurchasingServer({
  gateway,
  bearerToken: required('PURCHASING_API_TOKEN'),
  tls: { cert: readFileSync(required('GW_TLS_CERT')), key: readFileSync(required('GW_TLS_KEY')) },
  log,
});
const host = env.GW_BIND ?? '127.0.0.1';
const port = Number(env.GW_PORT ?? 8443);
server.listen(port, host, () => log({ event: 'listening', host, port, routes: routes.length, serviceDid: env.SERVICE_DID }));
// Background captures still in flight get up to 10 s to finish before the process exits.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(async () => {
    if (deferred) { log({ event: 'draining_captures', inFlight: deferred.inFlight() }); await deferred.drain(10_000); }
    process.exit(0);
  }));
}

// Purchasing gateway entry point. Env:
//   GW_BIND (127.0.0.1)  GW_PORT (8443)  GW_TLS_CERT / GW_TLS_KEY (required)
//   GW_UPSTREAM (http://127.0.0.1:18080)  GW_ROUTES (routes.json next to this package)
//   MM_API (https://metamynd.ai/api/v1)  MM_POLICY_PUBLIC_KEY (required; pinned bundle key)
//   SERVICE_DID (did:key of this gateway)  SERVICE_SIGNER_SOCKET (its agentsafe-signer daemon, role service)
//   PURCHASING_API_TOKEN (required; the bearer OpenShell substitutes from the provider)
// Settlement: a 2xx upstream captures, 400/409/413/415/422 (the mock rejected it before any
// effect) release, anything else is marked unknown.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- the @metamynd packages ship no type declarations
import { createHttpGateway } from '@metamynd/agentsafe-http-gateway';
// @ts-expect-error -- the @metamynd packages ship no type declarations
import { createMcpGuard } from '@metamynd/agentsafe-mcp-guard';
import { createForward, createPurchasingServer } from './gateway.mjs';

const env = process.env;
/** @param {string} name */
const required = (name) => {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const routesPath = env.GW_ROUTES ?? new URL('../routes.json', import.meta.url);
const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
const guard = createMcpGuard({
  serviceDid: required('SERVICE_DID'),
  keyProvider: 'daemon',
  daemonSocketPath: required('SERVICE_SIGNER_SOCKET'),
  issuerApi: (env.MM_API ?? 'https://metamynd.ai/api/v1').replace(/\/$/, ''),
  requireAuthorization: true,
  policyPublicKey: required('MM_POLICY_PUBLIC_KEY'),
  requireContextSignature: true,
});
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
if (verifyOnly) process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'WARNING_verify_only_mode', note: 'MetaMynd checks at the gateway are OFF' })}\n`);

/** @param {Record<string, unknown>} entry */
const log = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
const server = createPurchasingServer({
  gateway,
  bearerToken: required('PURCHASING_API_TOKEN'),
  tls: { cert: readFileSync(required('GW_TLS_CERT')), key: readFileSync(required('GW_TLS_KEY')) },
  log,
});
const host = env.GW_BIND ?? '127.0.0.1';
const port = Number(env.GW_PORT ?? 8443);
server.listen(port, host, () => log({ event: 'listening', host, port, routes: routes.length, serviceDid: env.SERVICE_DID }));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));

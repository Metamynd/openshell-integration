// MetaMynd OpenShell adapter entry point. Env:
//   ADAPTER_BIND (127.0.0.1:50051)  ADAPTER_TLS_CERT / ADAPTER_TLS_KEY (required)
//   ADAPTER_AUDIENCE (urn:openshell:extension:middleware:metamynd)
//   OPENSHELL_JWT_DIR (~/.local/state/openshell/tls/jwt)  OPENSHELL_JWT_ISSUER (openshell-gateway:openshell)
//   ADAPTER_MAX_PAYLOAD (1048576)  ADAPTER_REGISTRY (state/bindings.json)  ADAPTER_JOURNAL_DIR (state/journal)
//   ADAPTER_ROUTES_DIR (routes/ in this package): every *.json there is a route set, named by file
//   ADAPTER_GATE (on): "off" builds the deny-only adapter of M2
//   ADAPTER_AGENTS_DIR (state/agents): each bound agent's guard config (<agentKey>.json, from enrolment)
//   ADAPTER_GATE_DEADLINE_MS (4000)  MM_API (the agent config's apiBase)
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_VERSION, createAdapterHandlers, createResponseHandlers } from './adapter.mjs';
import { createMetaMyndGate } from './gate.mjs';
import { createJournal } from './journal.mjs';
import { createExtensionVerifier } from './jwt.mjs';
import { openRegistry } from './registry.mjs';
import { loadRoutes } from './routes.mjs';
import { startMiddlewareServer } from './server.mjs';

const env = process.env;
/** @param {Record<string, unknown>} entry */
const log = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
/** @param {string} name */
const required = (name) => {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const audience = env.ADAPTER_AUDIENCE ?? 'urn:openshell:extension:middleware:metamynd';
const jwtDir = env.OPENSHELL_JWT_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'openshell/tls/jwt');
const routesDir = env.ADAPTER_ROUTES_DIR ?? fileURLToPath(new URL('../routes/', import.meta.url));

/** @type {Map<string, import('./routes.mjs').Route[]>} */
const routeSets = new Map();
for (const f of readdirSync(routesDir).filter((n) => n.endsWith('.json'))) routeSets.set(basename(f, '.json'), loadRoutes(join(routesDir, f)));

const verifyToken = createExtensionVerifier({
  publicKeyPem: readFileSync(join(jwtDir, 'public.pem'), 'utf8'),
  kid: readFileSync(join(jwtDir, 'kid'), 'utf8').trim(),
  issuer: env.OPENSHELL_JWT_ISSUER ?? 'openshell-gateway:openshell',
  audience,
});
const journal = createJournal(env.ADAPTER_JOURNAL_DIR ?? 'state/journal');
const gateOn = env.ADAPTER_GATE !== 'off';
const gate = gateOn
  ? createMetaMyndGate({ agentsDir: env.ADAPTER_AGENTS_DIR ?? 'state/agents', apiBase: env.MM_API, deadlineMs: Number(env.ADAPTER_GATE_DEADLINE_MS ?? 4000) })
  : null;
const handlers = createAdapterHandlers({
  verifyToken,
  audience,
  maxPayloadBytes: Number(env.ADAPTER_MAX_PAYLOAD ?? 1048576),
  routeSets,
  registry: openRegistry(env.ADAPTER_REGISTRY ?? 'state/bindings.json', { log }),
  journal,
  gate,
  responseBinding: true,
  log,
});

const bind = env.ADAPTER_BIND ?? '127.0.0.1:50051';
const { server, port } = await startMiddlewareServer({
  bind,
  tls: { certPem: readFileSync(required('ADAPTER_TLS_CERT')), keyPem: readFileSync(required('ADAPTER_TLS_KEY')) },
  handlers,
  responseHandlers: createResponseHandlers({ verifyToken, journal, log }),
});
log({ event: 'listening', bind, port, version: ADAPTER_VERSION, audience, gate: gateOn, routeSets: [...routeSets.keys()] });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.tryShutdown(() => process.exit(0)));

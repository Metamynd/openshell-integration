// Entry point for the M0 stub middleware. Configuration is by environment:
//   STUB_BIND            host:port to listen on (default 127.0.0.1:50051)
//   STUB_TLS_CERT/KEY    server certificate and key (PEM); both required unless STUB_INSECURE=1
//   STUB_AUDIENCE        registration audience (default urn:openshell:extension:middleware:metamynd-stub)
//   OPENSHELL_JWT_DIR    gateway JWT dir holding public.pem and kid (default ~/.local/state/openshell/tls/jwt)
//   OPENSHELL_JWT_ISSUER expected iss (default openshell-gateway:openshell)
//   STUB_MAX_PAYLOAD     binding max_payload_bytes (default 262144)
//   STUB_INSECURE=1      plaintext, no JWT checks (pair with allow_insecure_transport; debugging only)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createExtensionVerifier } from './jwt.mjs';
import { createStubHandlers, startStubServer } from './stub.mjs';

const env = process.env;
const insecure = env.STUB_INSECURE === '1';
const bind = env.STUB_BIND ?? '127.0.0.1:50051';
const audience = env.STUB_AUDIENCE ?? 'urn:openshell:extension:middleware:metamynd-stub';
const maxPayloadBytes = Number(env.STUB_MAX_PAYLOAD ?? 262144);

/** @param {Record<string, unknown>} entry */
const log = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);

let verifyToken = null;
let tls = null;
if (!insecure) {
  if (!env.STUB_TLS_CERT || !env.STUB_TLS_KEY) throw new Error('STUB_TLS_CERT and STUB_TLS_KEY are required (or STUB_INSECURE=1)');
  const jwtDir = env.OPENSHELL_JWT_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'openshell/tls/jwt');
  verifyToken = createExtensionVerifier({
    publicKeyPem: readFileSync(join(jwtDir, 'public.pem'), 'utf8'),
    kid: readFileSync(join(jwtDir, 'kid'), 'utf8').trim(),
    issuer: env.OPENSHELL_JWT_ISSUER ?? 'openshell-gateway:openshell',
    audience,
  });
  tls = { certPem: readFileSync(env.STUB_TLS_CERT), keyPem: readFileSync(env.STUB_TLS_KEY) };
}

const handlers = createStubHandlers({ verifyToken, audience, maxPayloadBytes, log });
const { server, port } = await startStubServer({ bind, tls, handlers });
log({ event: 'listening', bind, port, tls: Boolean(tls), jwt: Boolean(verifyToken), audience });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.tryShutdown(() => process.exit(0)));
}

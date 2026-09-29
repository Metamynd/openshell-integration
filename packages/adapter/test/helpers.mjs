// Test helpers: an Ed25519 "gateway" key and a minter for OpenShell-shaped extension JWTs.
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';

export const ISSUER = 'openshell-gateway:openshell';
export const AUDIENCE = 'urn:openshell:extension:middleware:metamynd-stub';
export const KID = 'test-kid';

export function gatewayKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

/**
 * @param {import('node:crypto').KeyObject} privateKey
 * @param {Record<string, unknown>} [claims]
 * @param {Record<string, unknown>} [header]
 */
export function mintToken(privateKey, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'EdDSA', typ: 'openshell-ext+jwt', kid: KID, ...header };
  const c = { iss: ISSUER, aud: AUDIENCE, sub: ISSUER, iat: now, exp: now + 900, jti: randomUUID(), caller_kind: 'gateway', ...claims };
  const enc = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc(h)}.${enc(c)}`;
  return `Bearer ${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

/** @param {string} sandboxId */
export function supervisorClaims(sandboxId) {
  return { caller_kind: 'supervisor', sandbox_id: sandboxId, sub: `spiffe://openshell/sandbox/${sandboxId}` };
}

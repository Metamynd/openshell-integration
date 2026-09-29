// Verifies the gateway-signed extension JWT that OpenShell v0.1.2 attaches to every
// middleware RPC as `authorization: Bearer <jwt>` (EdDSA, typ openshell-ext+jwt).
// The key is the gateway's Ed25519 JWT public key, pinned out of band.
import { createPublicKey, verify } from 'node:crypto';

export class ExtensionAuthError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @typedef {object} ExtensionClaims
 * @property {string} iss
 * @property {string | string[]} aud
 * @property {string} sub
 * @property {number} exp
 * @property {number} [iat]
 * @property {string} [jti]
 * @property {'gateway' | 'supervisor'} caller_kind
 * @property {string} [sandbox_id]
 */

/** @param {string} part */
function decodeJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * @param {object} opts
 * @param {string} opts.publicKeyPem gateway JWT public key (Ed25519, SPKI PEM)
 * @param {string} opts.issuer expected `iss`, e.g. `openshell-gateway:openshell`
 * @param {string} opts.audience the registration's audience
 * @param {string} [opts.kid] expected header `kid`; skipped when omitted
 * @param {number} [opts.leewaySec]
 * @param {() => number} [opts.now] epoch milliseconds
 * @returns {(authorization: unknown) => ExtensionClaims}
 */
export function createExtensionVerifier({ publicKeyPem, issuer, audience, kid, leewaySec = 30, now = Date.now }) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('gateway JWT public key must be Ed25519');

  return function verifyToken(authorization) {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new ExtensionAuthError('missing_token', 'no bearer token');
    }
    const parts = authorization.slice('Bearer '.length).trim().split('.');
    if (parts.length !== 3) throw new ExtensionAuthError('malformed_token', 'token is not a JWS compact serialization');

    let header;
    /** @type {ExtensionClaims} */
    let claims;
    try {
      header = decodeJson(parts[0]);
      claims = decodeJson(parts[1]);
    } catch {
      throw new ExtensionAuthError('malformed_token', 'token header or claims are not JSON');
    }
    if (header.alg !== 'EdDSA') throw new ExtensionAuthError('bad_alg', 'alg must be EdDSA');
    if (header.typ !== 'openshell-ext+jwt') throw new ExtensionAuthError('bad_typ', 'typ must be openshell-ext+jwt');
    if (kid !== undefined && header.kid !== kid) throw new ExtensionAuthError('bad_kid', 'unexpected kid');

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!verify(null, signed, key, Buffer.from(parts[2], 'base64url'))) {
      throw new ExtensionAuthError('bad_signature', 'signature does not verify against the pinned gateway key');
    }

    if (claims.iss !== issuer) throw new ExtensionAuthError('bad_issuer', 'unexpected iss');
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(audience)) throw new ExtensionAuthError('bad_audience', 'unexpected aud');

    const t = Math.floor(now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + leewaySec < t) throw new ExtensionAuthError('expired', 'token expired');
    if (typeof claims.iat === 'number' && claims.iat - leewaySec > t) throw new ExtensionAuthError('not_yet_valid', 'token issued in the future');

    if (claims.caller_kind === 'supervisor') {
      if (typeof claims.sandbox_id !== 'string' || claims.sandbox_id === '') {
        throw new ExtensionAuthError('missing_sandbox_id', 'supervisor token has no sandbox_id');
      }
    } else if (claims.caller_kind !== 'gateway') {
      throw new ExtensionAuthError('bad_caller_kind', 'caller_kind must be gateway or supervisor');
    }
    return claims;
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionVerifier } from '../src/jwt.mjs';
import { gatewayKeys, mintToken, supervisorClaims, ISSUER, AUDIENCE, KID } from './helpers.mjs';

const keys = gatewayKeys();
const verify = createExtensionVerifier({ publicKeyPem: keys.publicKeyPem, issuer: ISSUER, audience: AUDIENCE, kid: KID });

/** @param {string} token @param {string} code */
function rejects(token, code) {
  assert.throws(() => verify(token), (/** @type {any} */ err) => err.code === code);
}

test('accepts gateway and supervisor tokens', () => {
  assert.equal(verify(mintToken(keys.privateKey)).caller_kind, 'gateway');
  const claims = verify(mintToken(keys.privateKey, supervisorClaims('sb-1')));
  assert.equal(claims.caller_kind, 'supervisor');
  assert.equal(claims.sandbox_id, 'sb-1');
});

test('accepts an audience array containing the registration audience', () => {
  verify(mintToken(keys.privateKey, { aud: ['other', AUDIENCE] }));
});

test('rejects missing or malformed tokens', () => {
  assert.throws(() => verify(undefined), (/** @type {any} */ e) => e.code === 'missing_token');
  rejects('Bearer a.b', 'malformed_token');
  rejects('Bearer !!!.@@@.###', 'malformed_token');
});

test('rejects wrong header fields', () => {
  rejects(mintToken(keys.privateKey, {}, { alg: 'none' }), 'bad_alg');
  rejects(mintToken(keys.privateKey, {}, { typ: 'JWT' }), 'bad_typ');
  rejects(mintToken(keys.privateKey, {}, { kid: 'other' }), 'bad_kid');
});

test('rejects a token signed by a different key', () => {
  rejects(mintToken(gatewayKeys().privateKey), 'bad_signature');
});

test('rejects a token whose claims were altered after signing', () => {
  const [, header, claims, sig] = /^Bearer ([^.]+)\.([^.]+)\.(.+)$/.exec(mintToken(keys.privateKey, supervisorClaims('sb-1'))) ?? [];
  const forged = JSON.parse(Buffer.from(claims, 'base64url').toString());
  forged.sandbox_id = 'sb-2';
  rejects(`Bearer ${header}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, 'bad_signature');
});

test('rejects wrong issuer, audience, expiry and caller kind', () => {
  rejects(mintToken(keys.privateKey, { iss: 'openshell-gateway:other' }), 'bad_issuer');
  rejects(mintToken(keys.privateKey, { aud: 'urn:openshell:extension:middleware:other' }), 'bad_audience');
  const past = Math.floor(Date.now() / 1000) - 3600;
  rejects(mintToken(keys.privateKey, { iat: past - 900, exp: past }), 'expired');
  rejects(mintToken(keys.privateKey, { iat: Math.floor(Date.now() / 1000) + 3600 }), 'not_yet_valid');
  rejects(mintToken(keys.privateKey, { caller_kind: 'admin' }), 'bad_caller_kind');
  rejects(mintToken(keys.privateKey, { caller_kind: 'supervisor' }), 'missing_sandbox_id');
});

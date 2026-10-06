import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import { createResponseHandlers } from '../src/adapter.mjs';
import { createMetaMyndGate } from '../src/gate.mjs';
import { openEscalations } from '../src/escalations.mjs';
import { loadMiddlewareProto } from '../src/proto.mjs';
import { startMiddlewareServer } from '../src/server.mjs';

const DID = 'did:hedera:testnet:zA_0.0.1';
const agentsDir = mkdtempSync(join(tmpdir(), 'agents-'));
writeFileSync(join(agentsDir, 'A.json'), JSON.stringify({ apiBase: 'https://metamynd.ai/api/v1', agentDid: DID, agentKey: null }));

const binding = { sandboxId: 'sb-1', sandboxName: 'agent-a', agentKey: 'A', agentDid: DID, signerSocket: 'state/signers/agentA/signer.sock',
  generation: 1, status: /** @type {const} */ ('active'), createdAt: '', revokedAt: null };
const route = /** @type {any} */ ({ action: 'office_supplies.purchase', riskLevel: 'low' });
const canon = { action: 'office_supplies.purchase', fields: { amount: 100, currency: 'MYR', merchant: 'OfficeMart' },
  payload: { amount: 100, currency: 'MYR', merchant: 'OfficeMart' } };
const requestContext = { sandbox_id: 'sb-1', request_id: 'req-9' };

/** @param {any} verdict @param {{ delayMs?: number }} [opts] */
function fakeFactory(verdict, { delayMs = 0 } = {}) {
  /** @type {any[]} */ const created = [];
  /** @type {any[]} */ const authorized = [];
  /** @type {any[]} */ const built = [];
  /** @param {any} opts */
  const factory = (opts) => {
    created.push(opts);
    return {
      async authorize(/** @type {any} */ req) {
        authorized.push(req);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return verdict;
      },
      async buildSignedRequest(/** @type {any} */ req) {
        built.push(req);
        return { agentDid: DID, action: req.action, amount: req.amount, nonce: 'n2', signature: 'sig', payloadDigest: 'sha256:x' };
      },
    };
  };
  return { factory, created, authorized, built };
}

test('a permit builds the signed x-magp-request carrying the authorizationId', async () => {
  const f = fakeFactory({ decision: 'allow', reasonCode: 'AUTHORIZED', authorizationId: 'auth-1', eventId: 'ev-1' });
  const gate = createMetaMyndGate({ agentsDir, guardFactory: f.factory });
  const v = await gate({ binding, route, canon, requestContext });
  assert.equal(v.permit, true);
  assert.equal(v.authorizationId, 'auth-1');
  const header = /** @type {any[]} */ (v.headerMutations)[0].write;
  assert.equal(header.name, 'x-magp-request');
  assert.equal(header.on_existing, 'EXISTING_HEADER_ACTION_OVERWRITE');
  assert.equal(JSON.parse(header.value).authorizationId, 'auth-1');

  const req = f.authorized[0];
  assert.deepEqual(req.context, { riskLevel: 'low' }, 'riskLevel comes from the route, not the request');
  assert.deepEqual(req.trace, { workflowId: 'sb-1', parentActionId: 'req-9' });
  assert.deepEqual(req.payload, canon.payload);
  assert.deepEqual(f.built[0], req, 'the signed request covers exactly what was authorized');
  assert.equal(f.created[0].keyProvider, 'daemon');
  assert.equal(f.created[0].daemonSocketPath, binding.signerSocket);
});

test('one guard per bound agent is reused', async () => {
  const f = fakeFactory({ decision: 'allow', reasonCode: 'AUTHORIZED', authorizationId: 'auth-2' });
  const gate = createMetaMyndGate({ agentsDir, guardFactory: f.factory });
  await gate({ binding, route, canon, requestContext });
  await gate({ binding, route, canon, requestContext });
  assert.equal(f.created.length, 1);
});

test('non-permits and permits without an authorizationId never build a header', async () => {
  for (const verdict of [
    { decision: 'block', reasonCode: 'SOP_SPEND_CAP' },
    { decision: 'escalate', reasonCode: 'AMOUNT_ABOVE_APPROVAL_THRESHOLD', escalationId: 'esc-1' },
    { decision: 'block', reasonCode: 'GATE_UNREACHABLE' },
    { decision: 'allow', reasonCode: 'AUTHORIZED' },
  ]) {
    const f = fakeFactory(verdict);
    const v = await createMetaMyndGate({ agentsDir, guardFactory: f.factory })({ binding, route, canon, requestContext });
    assert.equal(v.permit, false, JSON.stringify(verdict));
    assert.equal(f.built.length, 0);
    assert.equal(v.headerMutations, undefined);
  }
});

test('the gate rejects past its deadline and on a config/DID mismatch', async () => {
  const slow = fakeFactory({ decision: 'allow', authorizationId: 'late' }, { delayMs: 200 });
  await assert.rejects(createMetaMyndGate({ agentsDir, guardFactory: slow.factory, deadlineMs: 50 })({ binding, route, canon, requestContext }), /deadline/);
  const f = fakeFactory({ decision: 'allow', authorizationId: 'x' });
  await assert.rejects(createMetaMyndGate({ agentsDir, guardFactory: f.factory })({ binding: { ...binding, agentDid: 'did:hedera:testnet:zOther' }, route, canon, requestContext }), /does not match/);
});

test('the response hook journals the upstream status and always skips', async () => {
  /** @type {any[]} */ const journal = [];
  const { server, port } = await startMiddlewareServer({ bind: '127.0.0.1:0', tls: null, handlers: {},
    responseHandlers: createResponseHandlers({ verifyToken: null, journal: { append: (/** @type {any} */ e) => journal.push(e) } }) });
  const { HttpResponsePreReturn } = loadMiddlewareProto();
  const client = /** @type {any} */ (new HttpResponsePreReturn(`127.0.0.1:${port}`, grpc.credentials.createInsecure()));
  try {
    const stream = client.Evaluate();
    stream.on('error', () => {});
    const closed = new Promise((resolve) => stream.on('status', resolve));
    const reply = new Promise((resolve) => stream.on('data', resolve));
    stream.write({ preflight: { context: { request_id: 'req-9', sandbox_id: 'sb-1' }, status_code: 201, middleware_name: 'metamynd' } });
    const result = /** @type {any} */ (await reply);
    assert.ok(result.preflight_result?.skip, 'preflight is always skipped');
    stream.end();
    await closed;
    assert.deepEqual(journal[0], { kind: 'response', requestId: 'req-9', sandboxId: 'sb-1', statusCode: 201 });
  } finally {
    client.close();
    server.forceShutdown();
  }
});

// The approval path: an escalated request is resumed by resending it, never re-raised.
/** @param {{ verdicts: any[], statuses?: any[], effects?: any[] }} script */
function resumeFactory({ verdicts, statuses = [], effects = [] }) {
  /** @type {any[]} */ const authorized = [];
  /** @type {any[]} */ const asked = [];
  /** @type {any[]} */ const effectAsked = [];
  const factory = () => ({
    async authorize(/** @type {any} */ req) { authorized.push(req); return verdicts.shift(); },
    async buildSignedRequest(/** @type {any} */ req) { return { agentDid: DID, action: req.action, nonce: 'n', signature: 's' }; },
    async escalationStatus(/** @type {string} */ id) { asked.push(id); return statuses.shift(); },
    async effectStatus(/** @type {string} */ id) { effectAsked.push(id); return effects.shift(); },
  });
  return { factory, authorized, asked, effectAsked };
}
const escalated = { decision: 'escalate', reasonCode: 'AMOUNT_ABOVE_APPROVAL_THRESHOLD', escalationId: 'esc-1' };
const resend = { ...requestContext, request_id: 'req-10' };

test('a resend while the person has not decided returns the same escalation without raising another', async () => {
  const f = resumeFactory({ verdicts: [escalated], statuses: [{ status: 'pending', reasonCode: 'ESCALATION_PENDING' }] });
  const gate = createMetaMyndGate({ agentsDir, guardFactory: f.factory });
  const first = await gate({ binding, route, canon, requestContext });
  assert.equal(first.decision, 'escalate');
  const again = await gate({ binding, route, canon, requestContext: resend });
  assert.equal(again.permit, false);
  assert.equal(again.escalationId, 'esc-1');
  assert.equal(f.authorized.length, 1, 'the resend did not authorize again');
  assert.deepEqual(f.asked, ['esc-1']);
});

test('after approval the resend runs on the approval\'s authorization', async () => {
  const f = resumeFactory({ verdicts: [escalated], statuses: [{ status: 'approved', authorizationId: 'auth-approved' }], effects: [{ outcome: 'not_started' }] });
  const gate = createMetaMyndGate({ agentsDir, guardFactory: f.factory });
  await gate({ binding, route, canon, requestContext });
  const v = await gate({ binding, route, canon, requestContext: resend });
  assert.equal(v.permit, true);
  assert.equal(v.reasonCode, 'ESCALATION_APPROVED');
  assert.equal(v.authorizationId, 'auth-approved');
  assert.equal(JSON.parse(/** @type {any[]} */ (v.headerMutations)[0].write.value).authorizationId, 'auth-approved');
  assert.equal(f.authorized.length, 1);
  assert.deepEqual(f.effectAsked, ['auth-approved']);
});

test('a different request does not resume another request\'s approval', async () => {
  const f = resumeFactory({ verdicts: [escalated, { decision: 'escalate', escalationId: 'esc-2' }] });
  const gate = createMetaMyndGate({ agentsDir, guardFactory: f.factory });
  await gate({ binding, route, canon, requestContext });
  const other = { ...canon, fields: { ...canon.fields, amount: 101 }, payload: { ...canon.payload, amount: 101 } };
  const v = await gate({ binding, route, canon: other, requestContext: resend });
  assert.equal(v.escalationId, 'esc-2');
  assert.equal(f.asked.length, 0);
  assert.equal(f.authorized.length, 2);
});

test('a denied, expired, modified or spent approval asks afresh', async () => {
  for (const [status, effect] of /** @type {const} */ ([
    [{ status: 'denied' }, undefined],
    [{ status: 'expired' }, undefined],
    [{ status: 'modified_approved', authorizationId: 'auth-m' }, undefined],
    [{ status: 'approved', authorizationId: 'auth-spent' }, { outcome: 'succeeded' }],
  ])) {
    const f = resumeFactory({ verdicts: [escalated, { decision: 'escalate', escalationId: 'esc-new' }], statuses: [status], effects: effect ? [effect] : [] });
    const gate = createMetaMyndGate({ agentsDir, guardFactory: f.factory });
    await gate({ binding, route, canon, requestContext });
    const v = await gate({ binding, route, canon, requestContext: resend });
    assert.equal(v.permit, false, JSON.stringify(status));
    assert.equal(v.escalationId, 'esc-new');
    assert.equal(f.authorized.length, 2);
  }
});

test('an unreachable MetaMynd fails closed on resume', async () => {
  for (const script of [
    { statuses: [{ status: 'unreachable' }], effects: [] },
    { statuses: [{ status: 'approved', authorizationId: 'auth-a' }], effects: [{ effectState: 'unreachable' }] },
    { statuses: [{ status: 'unknown', reasonCode: 'GATE_HTTP_503' }], effects: [] },
  ]) {
    const f = resumeFactory({ verdicts: [escalated], ...script });
    const escalations = openEscalations(null);
    const gate = createMetaMyndGate({ agentsDir, guardFactory: f.factory, escalations });
    await gate({ binding, route, canon, requestContext });
    const v = await gate({ binding, route, canon, requestContext: resend });
    assert.equal(v.permit, false);
    assert.equal(v.reasonCode, 'GATE_UNREACHABLE');
    assert.equal(v.osReasonCode, 'metamynd_unavailable');
    assert.equal(f.authorized.length, 1);
    assert.equal(escalations.size, 1, 'the escalation is kept for the next resend');
  }
});

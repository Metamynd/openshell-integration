import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonRequest } from '../src/daemon.mjs';
import { AGENTS, AGENT_A_SOP } from '../src/enrolment.mjs';

const socketPath = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\poc-cli-test-${process.pid}-${Math.random().toString(16).slice(2)}`
  : join(tmpdir(), `poc-cli-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`));

/** @param {(req: any) => any} reply */
async function fakeDaemon(reply) {
  const path = socketPath();
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) sock.end(`${JSON.stringify(reply(JSON.parse(buf.split('\n')[0])))}\n`);
    });
  });
  await new Promise((resolve) => server.listen(path, () => resolve(undefined)));
  return { path, close: () => server.close() };
}

test('sends one protocol-v1 request and resolves the result', async () => {
  /** @type {any} */
  let seen;
  const d = await fakeDaemon((req) => {
    seen = req;
    return { protocolVersion: 1, requestId: req.requestId, ok: true, result: { signature: 'ab'.repeat(64) } };
  });
  try {
    const result = await daemonRequest(d.path, 'sign-key-control-challenge', { challenge: 'c0ffee' });
    assert.equal(result.signature.length, 128);
    assert.equal(seen.protocolVersion, 1);
    assert.equal(seen.op, 'sign-key-control-challenge');
    assert.deepEqual(seen.params, { challenge: 'c0ffee' });
  } finally {
    d.close();
  }
});

test('rejects with the daemon error code', async () => {
  const d = await fakeDaemon((req) => ({ protocolVersion: 1, requestId: req.requestId, ok: false, error: { code: 'DAEMON_KEY_ALREADY_EXISTS', message: 'key exists' } }));
  try {
    await assert.rejects(daemonRequest(d.path, 'generate-key'), { code: 'DAEMON_KEY_ALREADY_EXISTS' });
  } finally {
    d.close();
  }
});

test('enrolment definitions match the POC scenario', () => {
  const [a, b] = AGENTS;
  assert.deepEqual(a.body.merchants, ['OfficeMart']);
  assert.equal(a.body.perTxnMax, 500);
  assert.deepEqual(b.body.merchants, ['PaperCo']);
  assert.equal(b.body.perTxnMax, 200);
  for (const agent of AGENTS) {
    assert.equal(agent.body.network, 'testnet');
    assert.equal(agent.body.currency, 'MYR');
    assert.equal(agent.body.requirePayloadBinding, true);
  }
  const escalation = AGENT_A_SOP.documentJson.molecules.find((m) => m.id === 'approval-over-300');
  assert.equal(escalation?.decision, 'escalate');
  assert.deepEqual(/** @type {any} */ (escalation?.atoms[0])?.config, { limit: 300, currency: ['MYR'] });
});

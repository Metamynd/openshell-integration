// Env: MOCK_BIND (127.0.0.1), MOCK_PORT (18080), MOCK_DB (state/purchasing-ledger.sqlite),
//      MOCK_LEDGER_TOKEN (required; operator token for GET /ledger)
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMockPurchasing } from './server.mjs';

const env = process.env;
const host = env.MOCK_BIND ?? '127.0.0.1';
const port = Number(env.MOCK_PORT ?? 18080);
const dbPath = env.MOCK_DB ?? 'state/purchasing-ledger.sqlite';
if (!env.MOCK_LEDGER_TOKEN) throw new Error('MOCK_LEDGER_TOKEN is required');
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

/** @param {Record<string, unknown>} entry */
const log = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
const server = createMockPurchasing({ dbPath, ledgerToken: env.MOCK_LEDGER_TOKEN, log });
server.listen(port, host, () => log({ event: 'listening', host, port, dbPath }));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));

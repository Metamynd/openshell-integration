// Mock purchasing API (design §3.6). The system of record for the POC: every accepted
// purchase is one ledger row keyed by the Idempotency-Key the purchasing gateway sets
// (the MetaMynd authorizationId), so a replayed or retried request can never create a
// second effect. It never echoes request headers.
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const MAX_BODY_BYTES = 64 * 1024;
const AMOUNT = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(`${JSON.stringify(body)}\n`);
}

/** @param {http.IncomingMessage} req @returns {Promise<Buffer | null>} null when over the limit */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true; // keep draining so the 413 can be delivered
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, value: { amount: string, currency: string, merchant: string, items: unknown[], note: string } } | { ok: false, error: string }}
 */
export function validatePurchase(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = /** @type {Record<string, unknown>} */ (body);
  const amount = typeof b.amount === 'number' ? String(b.amount) : b.amount;
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) return { ok: false, error: 'amount must be a decimal with at most 2 places' };
  if (typeof b.currency !== 'string' || !CURRENCY.test(b.currency)) return { ok: false, error: 'currency must be a 3-letter uppercase code' };
  if (typeof b.merchant !== 'string' || b.merchant.length === 0 || b.merchant.length > 120) return { ok: false, error: 'merchant is required' };
  if (b.items !== undefined && !Array.isArray(b.items)) return { ok: false, error: 'items must be an array' };
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 500)) return { ok: false, error: 'note must be a string of at most 500 characters' };
  return { ok: true, value: { amount, currency: b.currency, merchant: b.merchant, items: /** @type {unknown[]} */ (b.items ?? []), note: /** @type {string} */ (b.note ?? '') } };
}

/**
 * @param {object} opts
 * @param {string} opts.dbPath SQLite file, or ':memory:'
 * @param {string} opts.ledgerToken required in x-ledger-token for GET /ledger
 * @param {(entry: Record<string, unknown>) => void} [opts.log]
 */
export function createMockPurchasing({ dbPath, ledgerToken, log = () => {} }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    body_hash TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    merchant TEXT NOT NULL,
    items TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  const byKey = db.prepare('SELECT * FROM purchases WHERE idempotency_key = ?');
  const byId = db.prepare('SELECT * FROM purchases WHERE id = ?');
  const insert = db.prepare(`INSERT INTO purchases (id, idempotency_key, body_hash, amount, currency, merchant, items, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`);
  const all = db.prepare('SELECT * FROM purchases ORDER BY created_at, id');

  /** @param {any} row */
  const view = (row) => ({ id: row.id, idempotencyKey: row.idempotency_key, amount: row.amount, currency: row.currency,
    merchant: row.merchant, items: JSON.parse(row.items), note: row.note, createdAt: row.created_at });

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (req.headers.upgrade) return send(res, 400, { error: 'upgrade_not_supported' });

    if (req.method === 'POST' && url.pathname === '/purchase-requests') {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8 || key.length > 128) return send(res, 400, { error: 'idempotency_key_required' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json_required' });
      if (req.headers['content-encoding']) return send(res, 415, { error: 'content_encoding_not_supported' });
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, { error: 'body_too_large' });
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'invalid_json' });
      }
      const checked = validatePurchase(parsed);
      if (!checked.ok) return send(res, 422, { error: 'invalid_purchase', detail: checked.error });
      const p = checked.value;
      const bodyHash = createHash('sha256').update(raw).digest('hex');

      const id = `pr_${randomUUID()}`;
      const inserted = insert.run(id, key, bodyHash, p.amount, p.currency, p.merchant, JSON.stringify(p.items), p.note, new Date().toISOString());
      if (inserted.changes === 1) {
        log({ event: 'purchase_created', id, idempotencyKey: key, amount: p.amount, currency: p.currency, merchant: p.merchant });
        return send(res, 201, view(byId.get(id)));
      }
      const existing = /** @type {any} */ (byKey.get(key));
      if (existing.body_hash !== bodyHash) {
        log({ event: 'idempotency_conflict', idempotencyKey: key });
        return send(res, 409, { error: 'idempotency_key_reused_with_different_body' });
      }
      log({ event: 'purchase_replayed', id: existing.id, idempotencyKey: key });
      return send(res, 200, { ...view(existing), replayed: true });
    }

    const one = /^\/purchase-requests\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && one) {
      const row = byId.get(decodeURIComponent(one[1]));
      return row ? send(res, 200, view(row)) : send(res, 404, { error: 'not_found' });
    }

    if (req.method === 'GET' && url.pathname === '/ledger') {
      if (!ledgerToken || req.headers['x-ledger-token'] !== ledgerToken) return send(res, 401, { error: 'ledger_token_required' });
      const rows = all.all().map(view);
      /** @type {Record<string, number>} */
      const totals = {};
      for (const r of rows) totals[r.currency] = Math.round(((totals[r.currency] ?? 0) + Number(r.amount)) * 100) / 100;
      return send(res, 200, { count: rows.length, totals, purchases: rows });
    }

    return send(res, url.pathname === '/purchase-requests' || one ? 405 : 404, { error: 'not_found_or_method_not_allowed' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { error: 'internal_error' }));
  });
  server.on('close', () => db.close());
  return server;
}

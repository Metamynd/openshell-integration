// Escalations the adapter is waiting on, by the request they hold (design §5.1, the approval path).
//
// MetaMynd parks an escalated request for a person; their approval mints ONE authorization for exactly that request. The
// agent in a sandbox cannot resume it — it only resends the request — so the adapter remembers which escalation each
// request raised, by a fingerprint of everything the approval is bound to (agent, action, amount, currency, merchant,
// context, payload). The same request coming back then resumes that escalation instead of raising a new one.
//
// Persisted (best-effort) so an adapter restart does not orphan an approval a person already gave. Entries older than the
// escalation TTL plus the hold TTL are dropped; they can no longer be spent anyway.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 24 h (escalation TTL) + 15 min (hold TTL) — past this an entry cannot be resumed, only re-raised. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000 + 15 * 60 * 1000;

/**
 * RFC 8785-style canonical JSON (sorted keys): the fingerprint must not depend on key order.
 * @param {unknown} v
 * @returns {string}
 */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = /** @type {Record<string, unknown>} */ (v);
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/**
 * The fingerprint of a request, over everything an approval is bound to. Trace (sandbox and request ids) is left out:
 * it differs on every resend and binds nothing.
 * @param {string} agentDid
 * @param {{ action: string, amount?: unknown, currency?: unknown, merchant?: unknown, context?: unknown, payload?: unknown, trace?: unknown }} request
 */
export function requestFingerprint(agentDid, request) {
  const { action, amount, currency, merchant, context, payload } = request;
  return createHash('sha256').update(canonical({ agentDid, action, amount, currency, merchant, context, payload })).digest('hex');
}

/**
 * @param {string | null} [path] JSON file to persist to; null keeps it in memory only
 * @param {{ now?: () => number, log?: (e: Record<string, unknown>) => unknown }} [opts]
 */
export function openEscalations(path = null, { now = () => Date.now(), log = () => {} } = {}) {
  /** @type {Map<string, { escalationId: string, at: number }>} */
  const byFingerprint = new Map();
  if (path && existsSync(path)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(path, 'utf8')))) {
        if (v && typeof v.escalationId === 'string' && typeof v.at === 'number') byFingerprint.set(k, v);
      }
    } catch (err) {
      log({ event: 'escalations_unreadable', path, error: String(/** @type {any} */ (err)?.message ?? err) });
    }
  }
  const save = () => {
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(byFingerprint)));
      renameSync(tmp, path);
    } catch (err) {
      log({ event: 'escalations_unwritable', path, error: String(/** @type {any} */ (err)?.message ?? err) });
    }
  };
  const prune = () => {
    const cutoff = now() - MAX_AGE_MS;
    for (const [k, v] of byFingerprint) if (v.at < cutoff) byFingerprint.delete(k);
  };
  return {
    /** @param {string} fingerprint */
    get(fingerprint) {
      prune();
      return byFingerprint.get(fingerprint)?.escalationId ?? null;
    },
    /** @param {string} fingerprint @param {string} escalationId */
    remember(fingerprint, escalationId) {
      prune();
      byFingerprint.set(fingerprint, { escalationId, at: now() });
      save();
    },
    /** @param {string} fingerprint */
    forget(fingerprint) {
      if (byFingerprint.delete(fingerprint)) save();
    },
    get size() {
      return byFingerprint.size;
    },
  };
}

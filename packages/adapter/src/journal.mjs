// Append-only decision journal (design §4.6): one JSON line per decision, fsynced, in a
// daily file. It is the bridge between OpenShell OCSF (which carries no request_id) and
// MetaMynd's decision records. Only allow-listed fields are written: never header values,
// bodies, tokens or keys.
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const FIELDS = ['kind', 'requestId', 'sandboxId', 'sandboxName', 'generation', 'agentDid', 'route', 'action', 'amount',
  'currency', 'merchant', 'decision', 'reasonCode', 'osReasonCode', 'why', 'authorizationId', 'eventId', 'escalationId',
  'statusCode', 'latencyMs'];

/** @param {string} dir @param {{ now?: () => Date }} [opts] */
export function createJournal(dir, { now = () => new Date() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    /** @param {Record<string, unknown>} entry */
    append(entry) {
      const ts = now();
      /** @type {Record<string, unknown>} */
      const record = { ts: ts.toISOString() };
      for (const k of FIELDS) if (entry[k] !== undefined) record[k] = entry[k];
      const fd = openSync(join(dir, `${ts.toISOString().slice(0, 10)}.jsonl`), 'a', 0o600);
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return record;
    },
  };
}

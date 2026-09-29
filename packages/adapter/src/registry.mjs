// sandbox_id -> agent binding registry (design §3.2, §4.4). A single JSON document written
// atomically by trusted operator tooling; the adapter only reads it. A reload that fails
// validation keeps the last good copy, so a bad write can never widen or drop bindings silently.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @typedef {object} Binding
 * @property {string} sandboxId
 * @property {string} sandboxName display only; never used for identity
 * @property {string} agentKey e.g. "A"
 * @property {string} agentDid
 * @property {string} signerSocket agentsafe-signer socket holding this agent's key
 * @property {number} generation
 * @property {'active' | 'revoked'} status
 * @property {string} createdAt
 * @property {string | null} revokedAt
 */

/** @param {unknown} doc @returns {Map<string, Binding>} */
export function parseRegistry(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(/** @type {any} */ (doc).bindings)) throw new Error('registry must be { bindings: [...] }');
  /** @type {Map<string, Binding>} */
  const map = new Map();
  for (const [i, b] of /** @type {any[]} */ (/** @type {any} */ (doc).bindings).entries()) {
    const where = `bindings[${i}]`;
    if (!b || typeof b !== 'object') throw new Error(`${where}: must be an object`);
    if (typeof b.sandboxId !== 'string' || !UUID.test(b.sandboxId)) throw new Error(`${where}: sandboxId must be a UUID`);
    if (map.has(b.sandboxId.toLowerCase())) throw new Error(`${where}: duplicate sandboxId`);
    for (const k of ['agentKey', 'agentDid', 'signerSocket', 'createdAt']) {
      if (typeof b[k] !== 'string' || !b[k]) throw new Error(`${where}: ${k} is required`);
    }
    if (!b.agentDid.startsWith('did:')) throw new Error(`${where}: agentDid must be a DID`);
    if (!Number.isInteger(b.generation) || b.generation < 1) throw new Error(`${where}: generation must be a positive integer`);
    if (b.status !== 'active' && b.status !== 'revoked') throw new Error(`${where}: status must be active or revoked`);
    map.set(b.sandboxId.toLowerCase(), { ...b, sandboxId: b.sandboxId.toLowerCase() });
  }
  return map;
}

/**
 * Read-only view with reload-on-change and last-good fallback.
 * @param {string} path
 * @param {{ log?: (e: Record<string, unknown>) => void, minReloadMs?: number }} [opts]
 */
export function openRegistry(path, { log = () => {}, minReloadMs = 500 } = {}) {
  /** @type {Map<string, Binding>} */
  let current = new Map();
  let loadedMtime = -1;
  let checkedAt = 0;

  function reload() {
    checkedAt = Date.now();
    if (!existsSync(path)) {
      if (loadedMtime !== 0) log({ event: 'registry_missing', path });
      current = new Map();
      loadedMtime = 0;
      return;
    }
    const mtime = statSync(path).mtimeMs;
    if (mtime === loadedMtime) return;
    try {
      current = parseRegistry(JSON.parse(readFileSync(path, 'utf8')));
      loadedMtime = mtime;
      log({ event: 'registry_loaded', bindings: current.size });
    } catch (err) {
      loadedMtime = mtime;
      log({ event: 'registry_invalid_kept_last_good', error: String(/** @type {Error} */ (err).message), bindings: current.size });
    }
  }
  reload();

  return {
    /**
     * The ACTIVE binding for a sandbox, or null (unknown or revoked).
     * @param {unknown} sandboxId
     */
    lookup(sandboxId) {
      if (Date.now() - checkedAt >= minReloadMs) reload();
      if (typeof sandboxId !== 'string') return null;
      const b = current.get(sandboxId.toLowerCase());
      return b && b.status === 'active' ? b : null;
    },
    size: () => current.size,
  };
}

/** Atomic write for operator tooling: temp file, fsync, rename. @param {string} path @param {Binding[]} bindings */
export function writeRegistry(path, bindings) {
  parseRegistry({ bindings });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ bindings }, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** @param {string} path @returns {Binding[]} */
export function readBindings(path) {
  return existsSync(path) ? [...parseRegistry(JSON.parse(readFileSync(path, 'utf8'))).values()] : [];
}

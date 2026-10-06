// sandbox_id -> agent binding registry (design §3.2, §4.4). A single JSON document written
// atomically by trusted operator tooling; the adapter only reads it. A reload that fails
// validation keeps the last good copy, so a bad write can never widen or drop bindings silently.
import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
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

/**
 * The group the registry is shared with, from ADAPTER_REGISTRY_GID: when the writers (bind CLI, watcher) run as a
 * different user from the adapter (e.g. root writes, the adapter runs as `metamynd`), the file is made <owner>:<gid> 0640
 * so the adapter can read it and nobody else can. Unset: owner-only 0600, as before.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number | null}
 */
export function registryGid(env = process.env) {
  const raw = env.ADAPTER_REGISTRY_GID;
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw)) throw new Error(`ADAPTER_REGISTRY_GID must be a numeric group id, got ${raw}`);
  return Number(raw);
}

/**
 * Atomic write for operator tooling: temp file, fsync, rename. Ownership and mode are set on the temp file, before the
 * rename, so the registry is never visible with the wrong permissions.
 * @param {string} path
 * @param {Binding[]} bindings
 * @param {{ gid?: number | null }} [opts] defaults to ADAPTER_REGISTRY_GID
 */
export function writeRegistry(path, bindings, { gid = registryGid() } = {}) {
  parseRegistry({ bindings });
  const dir = dirname(path);
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: gid === null ? 0o700 : 0o750 });
  if (created && gid !== null) chownSync(dir, -1, gid);
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ bindings }, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (gid !== null) {
    chownSync(tmp, -1, gid); // -1: keep the writer as owner
    chmodSync(tmp, 0o640);
  }
  renameSync(tmp, path);
  if (gid === null) chmodSync(path, 0o600);
}

/**
 * Revoke one binding (status revoked, generation bumped). Returns false when there is no such binding.
 * @param {string} path
 * @param {string} sandboxId
 */
export function revokeBinding(path, sandboxId) {
  const id = sandboxId.toLowerCase();
  const bindings = readBindings(path);
  if (!bindings.some((b) => b.sandboxId === id)) return false;
  writeRegistry(path, bindings.map((b) => (b.sandboxId === id && b.status === 'active'
    ? { ...b, status: /** @type {const} */ ('revoked'), generation: b.generation + 1, revokedAt: new Date().toISOString() }
    : b)));
  return true;
}

/** @param {string} path @returns {Binding[]} */
export function readBindings(path) {
  return existsSync(path) ? [...parseRegistry(JSON.parse(readFileSync(path, 'utf8'))).values()] : [];
}

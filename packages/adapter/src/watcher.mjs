// Revocation watcher logic (design §3.4, build plan 4.1). Pure and injectable: the entry point
// feeds it the gateway's current sandbox ids; it revokes any ACTIVE binding whose sandbox has
// been absent for `graceMisses` consecutive successful polls. A failed poll changes nothing, so a
// flaky gateway can never mass-revoke, and a deleted-then-recreated sandbox (new UUID under the
// same name) never inherits the old binding because bindings are keyed by UUID.

/**
 * Collect every sandbox id (`metadata.id`, or `id` on a sandbox-shaped object) from a parsed
 * `openshell sandbox list -o json` document, whatever its envelope.
 * @param {unknown} doc
 * @returns {Set<string>}
 */
export function sandboxIdsFrom(doc) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** @type {Set<string>} */
  const ids = new Set();
  /** @param {unknown} node */
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const o = /** @type {Record<string, any>} */ (node);
    const id = o.metadata?.id ?? (o.name !== undefined || o.phase !== undefined ? o.id : undefined);
    if (typeof id === 'string' && UUID.test(id)) ids.add(id.toLowerCase());
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(doc);
  return ids;
}

/**
 * @param {object} opts
 * @param {() => import('./registry.mjs').Binding[]} opts.readBindings
 * @param {(sandboxId: string) => void} opts.revoke
 * @param {number} [opts.graceMisses]
 * @param {(e: Record<string, unknown>) => void} [opts.log]
 */
export function createWatcher({ readBindings, revoke, graceMisses = 2, log = () => {} }) {
  /** @type {Map<string, number>} consecutive polls a bound sandbox was missing */
  const misses = new Map();
  return {
    /** @param {Set<string> | null} present null when the poll failed */
    observe(present) {
      if (!present) {
        log({ event: 'poll_failed_no_change' });
        return [];
      }
      /** @type {string[]} */
      const revoked = [];
      for (const b of readBindings().filter((x) => x.status === 'active')) {
        if (present.has(b.sandboxId)) {
          misses.delete(b.sandboxId);
          continue;
        }
        const n = (misses.get(b.sandboxId) ?? 0) + 1;
        misses.set(b.sandboxId, n);
        if (n >= graceMisses) {
          revoke(b.sandboxId);
          misses.delete(b.sandboxId);
          revoked.push(b.sandboxId);
          log({ event: 'binding_revoked', sandboxId: b.sandboxId, sandboxName: b.sandboxName, reason: 'sandbox no longer listed by the gateway' });
        }
      }
      return revoked;
    },
  };
}

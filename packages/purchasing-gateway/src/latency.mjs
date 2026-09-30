// Two latency options for the purchasing gateway. Both are off unless main.mjs is told to enable them.
//
// createBundleCache: the guard fetches the agent's signed policy bundle from metamynd.ai on every request.
//   This caches it per agent for ttlMs through the guard's documented fetchBundle hook. The guard still
//   verifies the bundle's signature and staleness on every request. Trade-off: the gateway's own view of
//   containment lags by up to ttlMs; the adapter's authorize and the claim still check live state.
//
// deferCapture: the gateway captures the hold before it answers. The answer does not depend on the capture,
//   and a hold whose capture fails stays committed to the cap, so this answers first and captures in the
//   background, retrying transient failures. drain() waits for captures still in flight before shutdown.

/**
 * @param {{ issuerApi: string, ttlMs: number, fetchImpl?: typeof fetch, now?: () => number }} opts
 * @returns {(agentDid: string) => Promise<any>} a fetchBundle for createMcpGuard
 */
export function createBundleCache({ issuerApi, ttlMs, fetchImpl = fetch, now = Date.now }) {
  /** @type {Map<string, { at: number, promise: Promise<any> }>} */
  const cache = new Map();

  /** Same contract as the guard's own loader: throws on failure, containment and mode as non-enumerable props. */
  async function load(/** @type {string} */ agentDid) {
    const res = await fetchImpl(`${issuerApi}/policy/bundle/${encodeURIComponent(agentDid)}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.data) throw new Error(`policy bundle fetch failed (HTTP ${res.status})`);
    Object.defineProperty(body.data, '__contained', { value: body?.contained ?? null, enumerable: false, configurable: true });
    Object.defineProperty(body.data, '__operatingMode', { value: body?.operatingMode ?? null, enumerable: false, configurable: true });
    return body.data;
  }

  return function fetchBundle(agentDid) {
    const hit = cache.get(agentDid);
    if (hit && now() - hit.at < ttlMs) return hit.promise;
    // Concurrent requests for the same agent share one fetch. A failure is never cached.
    const promise = load(agentDid);
    cache.set(agentDid, { at: now(), promise });
    promise.catch(() => { if (cache.get(agentDid)?.promise === promise) cache.delete(agentDid); });
    return promise;
  };
}

/**
 * @param {any} guard an agentsafe-mcp-guard instance
 * @param {{ log: (entry: Record<string, unknown>) => void, attempts?: number, backoffMs?: number,
 *   sleep?: (ms: number) => Promise<void> }} opts
 * @returns {{ guard: any, drain: (timeoutMs: number) => Promise<void>, inFlight: () => number }}
 */
export function deferCapture(guard, { log, attempts = 3, backoffMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  const transient = (/** @type {any} */ r) => r?.reasonCode === 'ISSUER_UNREACHABLE' || r?.reasonCode === 'CAPTURE_THREW' || (r?.status ?? 0) >= 500;

  async function settle(/** @type {any} */ claim) {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      /** @type {any} */
      let r;
      try { r = await guard.captureAuthorization(claim); } catch (err) { r = { ok: false, reasonCode: 'CAPTURE_THREW', error: String(/** @type {any} */ (err)?.message ?? err) }; }
      if (r?.ok || !transient(r) || attempt >= attempts) {
        // A failed capture leaves the hold claimed and committed to the cap; it is logged for reconciliation.
        log({ event: 'deferred_capture', authorizationId: claim.authorizationId, ok: Boolean(r?.ok), reasonCode: r?.reasonCode, attempts: attempt, ms: Date.now() - started });
        return r;
      }
      await sleep(backoffMs * attempt);
    }
  }

  const wrapped = {
    ...guard,
    captureAuthorization(/** @type {any} */ claim) {
      const p = settle(claim).finally(() => pending.delete(p));
      pending.add(p);
      return Promise.resolve({ ok: true, deferred: true });
    },
  };
  return {
    guard: wrapped,
    // A real timer, not the injectable backoff sleep: the shutdown bound must hold whatever the retry pacing is.
    drain: async (timeoutMs) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(r, timeoutMs); });
      await Promise.race([Promise.allSettled([...pending]), timeout]);
      clearTimeout(timer);
    },
    inFlight: () => pending.size,
  };
}

// Policy-bundle cache for the purchasing gateway, off unless main.mjs enables it (GW_BUNDLE_TTL_MS).
//
// The guard fetches the agent's signed policy bundle from metamynd.ai on every request. This caches it per
// agent for ttlMs through the guard's documented fetchBundle hook. The guard still verifies the bundle's
// signature and staleness on every request. Trade-off: the gateway's own view of containment lags by up to
// ttlMs; the adapter's authorize and the claim still check live state.
//
// Settling after the response is agentsafe-http-gateway's own behaviour since 0.16.0 (settleInBackground).

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

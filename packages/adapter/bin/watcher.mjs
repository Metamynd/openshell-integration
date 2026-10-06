// Revocation watcher (build plan 4.1). Polls the OpenShell gateway's sandbox list through the
// `openshell` CLI (the operator's mTLS credentials) and revokes the binding of any sandbox the
// gateway no longer lists. Deviation from design §3.4: the CLI list replaces a gRPC
// ListSandboxes/WatchSandbox client, so no control-plane protos are vendored; the poll interval
// bounds the revocation lag instead of a stream.
// Env: ADAPTER_REGISTRY (state/bindings.json), ADAPTER_REGISTRY_GID (unset = owner-only 0600; a numeric gid = shared 0640 with that group), WATCH_INTERVAL_MS (3000), WATCH_GRACE_MISSES (2)
import { execFile } from 'node:child_process';
import { readBindings, revokeBinding } from '../src/registry.mjs';
import { createWatcher, sandboxIdsFrom } from '../src/watcher.mjs';

const path = process.env.ADAPTER_REGISTRY ?? 'state/bindings.json';
const interval = Number(process.env.WATCH_INTERVAL_MS ?? 3000);
/** @param {Record<string, unknown>} e */
const log = (e) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`);

const watcher = createWatcher({
  readBindings: () => readBindings(path),
  revoke: (id) => revokeBinding(path, id),
  graceMisses: Number(process.env.WATCH_GRACE_MISSES ?? 2),
  log,
});

/** @returns {Promise<Set<string> | null>} */
function listSandboxes() {
  return new Promise((resolve) => {
    execFile('openshell', ['sandbox', 'list', '-o', 'json'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(sandboxIdsFrom(JSON.parse(stdout)));
      } catch {
        resolve(null);
      }
    });
  });
}

log({ event: 'watching', registry: path, intervalMs: interval });
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; });
while (!stopping) {
  watcher.observe(await listSandboxes());
  await new Promise((r) => setTimeout(r, interval));
}
process.exit(0);

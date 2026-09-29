# [Feature] A get-by-id RPC and a fleet-wide sandbox lifecycle watch

*Draft for NVIDIA/OpenShell. Not filed.*

**User story.** As an external service that binds `sandbox_id` to an identity, I want to revoke that binding the moment a sandbox is deleted or replaced.

**Problem statement.** Public RPCs reference sandboxes by name, and there is no get-by-id. `WatchSandbox` works per sandbox; the fleet-wide `WatchSandboxes` exists only on the internal driver API. External services therefore poll `ListSandboxes` and keep one stream per sandbox. Watch cursors also reset when the gateway restarts.

**Impact.** Our watcher polls every 2 s and revokes after two consecutive misses, so revocation lag is bounded by the poll interval rather than being event-driven.

**Proposed design.** Add a `GetSandbox` that accepts an id, and a public, authenticated, resumable `WatchSandboxes` with create, delete and generation-change events, filterable by label and workspace.

**Acceptance criteria.** An external service learns of a sandbox deletion or recreation within one event, without polling.

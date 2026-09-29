# [Feature] Include `request_id` in supervisor-middleware OCSF events

*Draft for NVIDIA/OpenShell. Not filed.*

**User story.** As an operator correlating OpenShell decisions with an external policy engine's decision records, I want the OCSF event for a middleware decision to carry the same `request_id` the middleware received.

**Problem statement.** `RequestContext.request_id` links the request-phase and response-phase middleware calls, but no OCSF event includes it. The `HttpActivity` middleware lines carry method, URL, policy and reason. Joining OpenShell's audit trail to the middleware's records therefore falls back to sandbox plus a time window, which is ambiguous under concurrency.

**Impact.** In our POC we had to keep a separate middleware-side journal and join by `container.uid`, host, path and ±2 s. Every decision joined in a low-rate test, but the join cannot be made exact.

**Proposed design.** Add `request_id` to every middleware-related OCSF event (the request stage, the response stage, and failure findings), in a stable field such as `metadata.correlation_uid` or `unmapped.request_id`. Optionally also add the registration name and the policy map key.

**Alternatives considered.** A time-window join, which is what we use today and is approximate. A middleware-written response header, which is not visible in OCSF.

**Acceptance criteria.** For any middleware decision, the OCSF event and the `EvaluateHttpRequest` context share one `request_id`.

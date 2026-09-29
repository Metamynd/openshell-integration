# [Feature] A notification-only HTTP completion event for middleware, including upstream failures

*Draft for NVIDIA/OpenShell. Not filed. RFC 0009 lists `HttpResponse/completed` as future work.*

**User story.** As an authorization middleware that reserves a budget hold on ALLOW, I want to learn the final outcome of every request I allowed, so that I can capture, release or mark the hold unknown.

**Problem statement.** `HttpResponsePreReturn` is not called when the upstream fails before a response head, when the response is a 101 upgrade, or when a later stage denies. So a middleware cannot learn every outcome for requests it allowed.

**Impact.** We moved settlement to a counterparty gateway in front of the upstream. That works, but it means every protected API needs a second enforcement component. Holds from dropped or failed requests lapse on a timer instead of being released.

**Proposed design.** A one-way `HttpRequestCompleted` event for middleware that allowed a request, with `request_id`, the final status or an error class (`upstream_connect_failed`, `upstream_reset`, `later_stage_denied`, `client_disconnected`, `policy_reload`), and timings. Best-effort delivery is acceptable if it is documented.

**Alternatives considered.** Counterparty settlement, which is what we use. Timers.

**Acceptance criteria.** For every allowed request, the middleware receives exactly one completion event or a documented best-effort loss signal.

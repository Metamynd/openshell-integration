# [Bug] A provider-environment reload closes in-flight L7 tunnels, including requests mid-middleware, with an empty reply

*Draft for NVIDIA/OpenShell. Not filed. Uses the bug-report template sections. Filing needs a vouched contributor.*

## User story
As an operator running an authorization middleware with a 1–3 s decision time, I want requests that OpenShell has already admitted to finish or fail with an explicit status when the sandbox's provider environment reloads. They should not be silently cut off.

## Problem statement
On v0.1.2, the supervisor sometimes detects `provider_env_changed:true` with `policy_changed:false`. When it does, it bumps the policy generation and closes **every in-flight L7 tunnel**, including requests whose middleware evaluation is still running. The client sees an empty reply (curl `(52) Empty reply from server`), with no 403 and no 503.

Two triggers were observed:
1. **A sandbox's first use of a provider credential.** Each sandbox reloads exactly once, about 1–2 s after its first request that resolves a provider placeholder.
2. **`openshell sandbox exec --env KEY=VALUE`**, about 0.8 s after the exec session opens.

## Impact
- A new sandbox's first burst of requests is dropped. In our runs, availability of that burst was 0/10 and 4/10, against 10/10 after a one-request warm-up.
- The client cannot tell a dropped request from a network failure, and gets no retry hint.
- With middleware in the path (1–3 s per decision), the exposure window is wide.
- Current workaround: send one warm-up request per sandbox and wait several seconds before real traffic, and never use `exec --env` while traffic is in flight. Neither is acceptable for a production agent's first actions.

## Reproduction
1. Gateway v0.1.2, Docker driver. Register an operator middleware that takes about 2 s to answer (any stub that sleeps and then allows).
2. Import an endpointless provider profile with a bearer credential, create a provider, and create a sandbox with that provider plus a policy binding the credential to an HTTPS endpoint, with the middleware attached.
3. **Without any earlier request from this sandbox**, start 5 concurrent `curl` requests to that endpoint using `Authorization: Bearer $TOKEN_ENV`.
4. Observe the empty replies. `openshell logs <sandbox> --source sandbox` shows:

```
HTTP:POST [INFO] ALLOWED POST http://host.openshell.internal:8443/purchase-requests [policy:purchasing engine:l7]      (x5)
CONFIG:DETECTED Settings poll: config change detected [old_revision:… new_revision:… policy_changed:false provider_env_changed:true]
NET:OPEN [MED] DENIED host.openshell.internal:8443 [reason:L7 tunnel closed before inspection because policy changed:
  policy generation is stale [captured_generation:2 current_generation:3]]                                                   (x5)
```

5. Repeat after one warm-up request and an 8 s pause: all 5 succeed.

## Environment
OpenShell v0.1.2 (`.deb`, systemd user gateway, Docker driver 29.8.1), WSL2 Ubuntu 24.04, kernel 6.18.

## Proposed design
- When only the provider environment changed, let admitted requests finish under the generation they were admitted with. The credential they would use is unchanged or only newly installed.
- If a request must be aborted, return a retryable `503` with a stable `error` code, and emit an OCSF event naming the request.
- Consider completing provider readiness before the sandbox reports Ready, so that the first credential use doesn't trigger a reload.

## Alternatives considered
- Client-side retry on an empty reply. Unsafe in general for POST, because the client cannot know whether the upstream executed.
- A warm-up request per sandbox. This is our workaround; it is operationally brittle.

## Acceptance criteria
- Concurrent first requests from a new sandbox all complete (or all get an explicit retryable status) when the only change is provider readiness.
- `exec --env` does not abort other in-flight requests in the sandbox.

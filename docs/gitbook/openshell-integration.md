---
description: >-
  Run MetaMynd authorisation inside the NVIDIA OpenShell runtime boundary, so that every action a sandboxed agent
  takes is checked against its live mandate before it reaches your systems.
---

# NVIDIA OpenShell integration

{% hint style="warning" %}
**Status: proof of concept.** The integration is built and tested on OpenShell `v0.1.2`, whose supervisor-middleware API is a research preview. Pin versions, and expect the API to change. This is MetaMynd's integration with open-source OpenShell. It is not an NVIDIA product, partnership or endorsement.
{% endhint %}

## What it does

[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) runs AI agents in sandboxes and controls where they can connect. MetaMynd decides whether a specific action is authorised by the organisation the agent acts for. The integration joins the two.

The **MetaMynd OpenShell adapter** is an OpenShell *supervisor middleware*. OpenShell calls it for every request a sandboxed agent sends to a protected API. For each request the adapter:

1. **Authenticates the call.** It verifies OpenShell's signed gateway token and requires the token's sandbox to match the request.
2. **Resolves identity.** It maps the sandbox to an enrolled MetaMynd agent through an operator-controlled registry. The request itself is never trusted for identity.
3. **Canonicalises the request.** It checks the route, the content type, a strict JSON parse and the allowed fields, and refuses compressed or oversized bodies.
4. **Asks MetaMynd.** It signs an authorisation request as the bound agent, binding the exact body, and gets a decision.
5. **Allows or denies.** On approval it attaches a signed `x-magp-request` header and lets the request continue. On anything else it denies, with a stable reason code.

OpenShell then adds the real API credential, and only after approval. The protected API sits behind MetaMynd's `agentsafe-http-gateway`, which re-verifies the signed request, claims the authorisation once, executes, and settles.

**Two independent controls must both pass:**

| Layer | Answers | Enforces |
| --- | --- | --- |
| OpenShell | *Where may this agent go?* | Kernel-level egress capture for any program, TLS, request rules, credential isolation |
| MetaMynd | *Is this agent allowed to do this, right now?* | Identity, delegated mandate, spend and supplier rules, behavioural checks, human escalation, evidence |

## How a request flows

1. The agent sends `POST /purchase-requests` with a **placeholder** token. The sandbox never holds the real secret.
2. OpenShell's supervisor applies its network, TLS and request rules, then calls the MetaMynd adapter, its last middleware stage, set to fail closed.
3. The adapter authorises at MetaMynd as the agent bound to that sandbox.
4. On approval, OpenShell swaps in the real credential and forwards the request.
5. `agentsafe-http-gateway` re-verifies, claims the authorisation once, and forwards to the API. It answers immediately and settles the hold in the background.
6. Every decision is recorded in OpenShell's audit log, the adapter's journal, MetaMynd's anchored evidence and the API's ledger.

A denial never leaves the sandbox. The agent gets OpenShell's `403` with MetaMynd's reason:

```json
{"error":"middleware_denied","middleware":"metamynd","reason_code":"metamynd_merchant_not_allowed","layer":"l7"}
```

## Benefits

* **Business authority OpenShell can't express.** Live mandates, per-agent supplier lists and spend caps, organisation rules (SOPs), behavioural anomaly checks, and escalation to a named, accountable person.
* **Enforcement MetaMynd can't provide alone.** OpenShell captures egress at the kernel, whatever program the agent uses, so an agent can't skip governance by calling the API another way.
* **No secrets in the agent.** The agent holds neither the API credential nor its own signing key. Keys stay in `agentsafe-signer` daemons outside every sandbox.
* **Identity that can't be forged from inside.** Identity comes from the sandbox OpenShell attests. Agent IDs or signed headers written into a request are ignored.
* **Exactly-once execution.** Each approval can be claimed once, and the API's ledger is keyed by the authorisation ID.
* **Fail closed.** If the adapter is down, MetaMynd is unreachable or anything looks wrong, the request is refused.
* **One audit trail.** Each decision joins across OpenShell's log, the adapter journal, MetaMynd's anchored evidence (with a Merkle proof) and the ledger.
* **Many agents, one service.** One adapter serves every sandbox, each with its own identity, authority and audit trail.

## Tested results

Proof-of-concept runs on 29–30 September 2026: WSL2 Ubuntu 24.04, OpenShell `v0.1.2`, against `metamynd.ai`.

**Adversarial matrix, 22 cases.** Every case passed, with the purchasing gateway enforcing *and* with it doing no MetaMynd checks at all. The second run shows OpenShell plus the adapter alone stop every attack.

| Case | Result |
| --- | --- |
| Allowed purchase | Executed exactly once |
| Over the cap; supplier outside the mandate; another agent's identical request | Denied, nothing written |
| Another agent's ID in the body; a forged signed header | Ignored; judged as the sandbox's own agent |
| Raw TCP from a shell; the gateway by IP address; the API port directly | Blocked by OpenShell |
| A method the policy disallows; a compressed body; a WebSocket upgrade | Refused |
| The same requests from Python instead of curl | Same outcomes |
| Concurrent purchases from two sandboxes | Ledger rows equal the successful purchases |
| Adapter down; MetaMynd unreachable; API gateway down | Failed closed, nothing written |
| Sandbox deleted, then recreated under the same name | Binding revoked; the new sandbox is unbound |
| Searching for agent keys from inside a sandbox | Nothing visible |

**Evidence:** 6 of 6 decisions joined across all four sources.

## Performance benchmarks

100 sequential purchases per path, measured end to end by the client. The POC host was in Malaysia; MetaMynd was `metamynd.ai`.

| Path | p50 | p95 | p99 |
| --- | --- | --- | --- |
| OpenShell only (no MetaMynd) | 47 ms | 75 ms | 87 ms |
| OpenShell + MetaMynd, default settings | 1144 ms | 1302 ms | 1586 ms |
| OpenShell + MetaMynd, with the gateway's 30 s policy cache | **839 ms** | **1051 ms** | **1286 ms** |

**How it got there.** These are combined-path medians:

| Change | Combined p50 |
| --- | --- |
| First measurement (MetaMynd `v1.71.0`) | 3024 ms |
| Asynchronous decision path (`v1.72.0`): authorise in 358 ms, approvals as fast as denials | 1410 ms |
| Gateway answers first and settles after (`v1.72.1`, `agentsafe-http-gateway` 0.16.0) | 1217 ms |
| SDKs keep idle connections for 60 s (`v1.72.2`) | 1144 ms, p99 1586 ms |
| Plus a 30 s policy-bundle cache at the gateway | **839 ms** |

* OpenShell adds about **50 ms** and the adapter about **50 ms**. The rest is round trips to MetaMynd.
* Only `authorize` sits inside OpenShell's middleware timeout, with p95 643 ms against a 4 s deadline.
* Medians are stable across runs. The p95 and p99 vary from run to run with the network path, so repeat runs before relying on tail figures.

{% hint style="info" %}
The policy-bundle cache is opt-in (`GW_BUNDLE_TTL_MS`). It removes one round trip per request. Since agentsafe-mcp-guard 0.18.0 it is the guard's own cache, which drops an agent's bundle as soon as MetaMynd pushes a change for it (containment, revocation, rule change), so the gateway refuses a contained agent within about a second; with the push stream down it simply fetches every time. The adapter's authorisation and the gateway's claim still check live state on every request.
{% endhint %}

## Requirements

* **A Linux host, or Windows with WSL2,** with systemd, kernel 6.2 or later with Landlock ABI 3, seccomp and Docker 28 or later. OpenShell's Windows support (WSL2) is experimental.
* **OpenShell `v0.1.2`,** pinned. Install it from the tagged installer.
* **Node.js 22 or later.**
* **A MetaMynd tenant** with a verified principal, enrolled agents and mandates.
* **MetaMynd packages:** `@metamynd/agentsafe-guard` 0.17.1+, `@metamynd/agentsafe-http-gateway` 0.16.1+, `@metamynd/agentsafe-mcp-guard` 0.17.2+, `@metamynd/agentsafe-signer` 0.19.1+.

## Set it up

{% stepper %}
{% step %}
### Enrol your agents

Each sandboxed agent is a MetaMynd agent with its own key. Generate the key inside an `agentsafe-signer` daemon (bring your own key), prove possession, and give the agent a mandate. For example: action `office_supplies.purchase`, currency MYR, a per-transaction cap and an allowed supplier list. Register the API gateway's service identity as a trusted counterparty.

Keys never leave the signer daemons. Run them as a dedicated user that no sandbox can reach.
{% endstep %}

{% step %}
### Protect the API with `agentsafe-http-gateway`

Put the API behind MetaMynd's gateway with strict settings:

```js
import { createHttpGateway } from '@metamynd/agentsafe-http-gateway';
import { createMcpGuard } from '@metamynd/agentsafe-mcp-guard';

const guard = createMcpGuard({
  serviceDid, keyProvider: 'daemon', daemonSocketPath,
  issuerApi: 'https://metamynd.ai/api/v1',
  requireAuthorization: true, requireContextSignature: true, policyPublicKey,
});
const gateway = createHttpGateway({
  guard, routes, forward,
  denyByDefault: true, requirePayloadBinding: true, requireContextSignature: true,
  // settleInBackground is on by default since 0.16.0
});
// On shutdown: await gateway.drainSettlements(10_000);
```

Make the gateway reachable from sandboxes only through the inspected host. For a host-local service that is `host.openshell.internal`.
{% endstep %}

{% step %}
### Run the adapter

The adapter is a gRPC service over TLS:

```bash
ADAPTER_TLS_CERT=certs/server.pem ADAPTER_TLS_KEY=certs/server.key \
ADAPTER_REGISTRY=state/bindings.json ADAPTER_JOURNAL_DIR=state/journal \
ADAPTER_AGENTS_DIR=state/agents ADAPTER_GATE=on \
node packages/adapter/src/main.mjs
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADAPTER_BIND` | `127.0.0.1:50051` | Listen address |
| `ADAPTER_AUDIENCE` | `urn:openshell:extension:middleware:metamynd` | Expected token audience |
| `OPENSHELL_JWT_DIR` | `~/.local/state/openshell/tls/jwt` | Gateway's token-signing public key |
| `ADAPTER_ROUTES_DIR` | `routes/` | Route sets, one JSON file each |
| `ADAPTER_GATE_DEADLINE_MS` | `4000` | Deadline for MetaMynd's decision |
{% endstep %}

{% step %}
### Register it with the OpenShell gateway

In `~/.config/openshell/gateway.toml`:

```toml
[[openshell.supervisor.middleware]]
name = "metamynd"
grpc_endpoint = "https://127.0.0.1:50051"
tls_ca_cert_path = "/path/to/ca.pem"
audience = "urn:openshell:extension:middleware:metamynd"
max_payload_bytes = 1048576
timeout = "5s"
```

Restart the gateway. It won't start if the adapter is unreachable, so start the adapter first.
{% endstep %}

{% step %}
### Attach it in the sandbox policy

Make the adapter the **last** stage, and fail closed:

```yaml
network_policies:
  purchasing:
    endpoints:
      - host: host.openshell.internal
        port: 8443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: POST, path: /purchase-requests }
        credential_binding: { provider: poc-purchasing }
    binaries:
      - { path: /usr/bin/curl }

network_middlewares:
  metamynd:
    middleware: metamynd
    order: 1000
    on_error: fail_closed
    config: { routes: purchasing-v1 }
    endpoints:
      include: ["host.openshell.internal"]
```

Avoid `tls: skip`, `protocol: tcp`, IP allow-lists and `enforcement: audit` on any path to the API. The reference implementation's `tools/policy-lint.sh` checks for these.
{% endstep %}

{% step %}
### Bind each sandbox to its agent

Bind by the sandbox's UUID, never its name:

```bash
openshell sandbox get <name> -o json        # read metadata.id
node packages/adapter/bin/bindings.mjs bind <sandboxId> <name> <agentKey>
node packages/adapter/bin/bindings.mjs list
```

Run the revocation watcher (`packages/adapter/bin/watcher.mjs`). It revokes a binding once its sandbox disappears. A recreated sandbox gets a new UUID and no binding.
{% endstep %}
{% endstepper %}

## Route configuration

Each route set is a JSON array. A request that matches no route is denied.

```json
[{
  "host": "host.openshell.internal", "port": 8443, "method": "POST", "path": "/purchase-requests",
  "action": "office_supplies.purchase",
  "valueFields": ["amount", "currency", "merchant"],
  "allowedFields": ["amount", "currency", "merchant", "items", "note"],
  "riskLevel": "low"
}]
```

| Field | Meaning |
| --- | --- |
| `host`, `port`, `method`, `path` | The request this route covers |
| `action` | The MetaMynd mandate action it maps to |
| `valueFields` | Fields that carry amount, currency and supplier |
| `allowedFields` | Every field the body may contain; any other is refused |
| `riskLevel` | Sent to MetaMynd as context. Required on metamynd.ai, where a missing value escalates |

## Reason codes

MetaMynd decisions appear as `metamynd_<code>`, for example `metamynd_sop_spend_cap`, `metamynd_merchant_not_allowed` or `metamynd_escalation_pending`. The adapter's own codes:

| Code | Meaning |
| --- | --- |
| `metamynd_route_not_allowed` | No route matched |
| `metamynd_binding_unknown` | The sandbox is not bound, or its binding was revoked |
| `metamynd_caller_unauthenticated` | Invalid gateway token, or a sandbox mismatch |
| `metamynd_request_rejected` | Encoding, size, parse or field violation |
| `metamynd_signer_unavailable` | The agent's signer could not sign |
| `metamynd_unavailable` | MetaMynd timed out, failed or returned no verdict |
| `metamynd_internal_error` | Unexpected adapter error |

## Limitations

* **The adapter holds signing authority for every bound agent.** The evidence therefore proves that *OpenShell saw this request leave sandbox S, and S's bound agent is authorised for it*, not the agent's intent. Protect the adapter's OS user accordingly.
* **One agent per sandbox.** OpenShell has no per-agent identity inside a sandbox.
* **One inspected route proves only that route.** Uninspected paths, such as `tls: skip`, raw TCP and WebSocket frames, are outside its coverage.
* **Known OpenShell `v0.1.2` behaviour:**
  * a sandbox's first use of a credential, or a new program using it, triggers a reload that drops in-flight requests with an empty reply (fail-closed; warm each sandbox and program once);
  * middleware log events carry no request ID;
  * the response hook does not fire when the upstream fails, so settlement lives at the API gateway.

  These have been drafted as issue reports for the OpenShell maintainers.

## Versions tested

| Component | Version |
| --- | --- |
| OpenShell | `v0.1.2` (`6648bd0c`) |
| MetaMynd | `metamynd.ai` `v1.71.0`–`v1.72.2` |
| `agentsafe-guard` / `agentsafe-mcp-guard` / `agentsafe-http-gateway` / `agentsafe-signer` | 0.17.1 / 0.17.2 / 0.16.1 / 0.19.1 |
| Host | Windows 11 + WSL2 Ubuntu 24.04, kernel 6.18, Docker 29.8, Node 24 |

# Runbook: POC host

## Host

The POC runs on **COO-JASIM-NB1**, in Windows 11 + WSL2 Ubuntu 24.04. The repo is cloned inside the WSL filesystem at `~/src/openshell-integration`. Don't use a clone under `/mnt/c`: it is slower for Docker, and on Windows clones scripts can get CRLF line endings.

### Preflight result (build plan step 0.2, spike S1): 29 Sep 2026

| Check | Result |
| --- | --- |
| WSL2 | ok |
| Distro | Ubuntu 24.04 |
| systemd as PID 1 | ok |
| Kernel | 6.18.33.2 (≥ 6.2) |
| Landlock | ABI 7 (≥ 3), via the ABI probe; `/sys/kernel/security/lsm` is unreadable under WSL, which is harmless |
| seccomp | available, including `user_notif` |
| Docker | Engine 29.8.1 inside the distro (not Docker Desktop) |
| Node | 24.19.0 |
| OpenShell | CLI and gateway 0.1.2, installed from the `v0.1.2` installer as a systemd user service. Gateway at `https://127.0.0.1:17670`, mTLS, status `Connected` |

**S1 is closed.** The WSL2 kernel meets OpenShell's sandbox requirements, so no Linux VM is needed.

### Setup steps used

1. Install Docker Engine from Docker's apt repository (`docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`). Run `sudo usermod -aG docker $USER`, then `wsl --shutdown` and reopen WSL.
2. Install OpenShell pinned to the tag:

   ```shell
   curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/install.sh | OPENSHELL_VERSION=v0.1.2 sh
   ```
3. Run `openshell status`, which should report `Connected`, then `bash tools/host-preflight.sh`.

If you forget the WSL `sudo` password, reset it from Windows PowerShell with `wsl -u root passwd <user>`.

## M0 smoke test (build plan step 0.3)

```shell
bash tools/m0-smoke.sh
```

The default workload image (`nvcr.io/nvidia/base/ubuntu:24.04`) has no `curl`, and OpenShell v0.1.2 no longer builds images from a Dockerfile passed to `--from`. So the script first builds `deploy/images/smoke` with Docker as `mm-poc-smoke:0.1`. It then creates a throwaway sandbox from that image with `deploy/openshell/m0-smoke-policy.yaml`. That policy allows only GET to `api.github.com`, with `enforcement: enforce`. The script then runs a GET, which should return 200, and a POST, which should return 403 because the L7 rules deny it. It saves the sandbox log to `docs/report/runs/m0-smoke-sandbox.log` and deletes the sandbox.

Sandbox logs reach the gateway asynchronously, so the script polls for the denial event rather than reading the log once.

### Result: 29 Sep 2026 on COO-JASIM-NB1 (step 0.3 passed)

- `GET https://api.github.com/zen` → **200**. OCSF: `HTTP:GET [INFO] ALLOWED … [policy:github_read engine:l7]`.
- `POST https://api.github.com/markdown` → **403**. The body is OpenShell's, not GitHub's:

  ```json
  {"error":"policy_denied","layer":"l7","policy":"github_read","method":"POST","path":"/markdown",
   "detail":"POST /markdown not permitted by policy","binary":"/usr/bin/curl", …}
  ```
- OCSF: `HTTP:POST [MED] DENIED POST http://api.github.com:443/markdown [policy:github_read engine:l7] [reason:L7_REQUEST deny …]`.

What this shows for the design:
- L7 enforcement works with `enforcement: enforce` on this host.
- The L4 and L7 decisions are logged separately: `NET:OPEN … engine:opa`, then `HTTP:<method> … engine:l7`.
- The deny body includes the policy name and binary, which will sit alongside the middleware-denial body (`error: middleware_denied`) once the adapter is attached.

## M0 stub middleware (build plan step 0.4, spike S2)

```shell
bash tools/m0-stub.sh
```

The script performs these steps:

1. Generates a private CA and a server certificate for `127.0.0.1` in `state/certs/`.
2. Starts the stub (`packages/adapter/src/stub-main.mjs`) on `127.0.0.1:50051` over TLS. The stub checks the gateway's Ed25519 JWT against `~/.local/state/openshell/tls/jwt/public.pem`.
3. Registers the stub by writing `~/.config/openshell/gateway.toml` and restarting the `openshell-gateway` user service.
4. Creates a sandbox with `deploy/openshell/m0-stub-policy.yaml`. That policy's L7 rules *allow* `POST /markdown`, so a denial of that request can only come from the middleware.
5. Checks four things: a 403 `middleware_denied` response with `reason_code: stub_deny`; an authenticated `EvaluateHttpRequest` in the stub log whose JWT `sandbox_id` matches the request context; the OCSF event `reason:middleware_denied:metamynd-stub:stub_deny`; and authenticated `Describe` and `ValidateConfig` calls from the gateway.
6. On exit, always deletes the sandbox, removes `gateway.toml`, restarts the gateway on its defaults, and stops the stub.

Facts this relies on (OpenShell v0.1.2):
- Supervisor containers use host networking, so `127.0.0.1:50051` is reachable from the gateway and from every sandbox supervisor.
- JWT signing is enabled by default on a local `.deb` install. The token issuer is `openshell-gateway:openshell`.
- The gateway won't start if a registered middleware fails `Describe`. That is why the script owns `gateway.toml` and restores it.

### Result: 29 Sep 2026 on COO-JASIM-NB1 (step 0.4 passed, spike S2 closed)

All seven checks passed:

1. The stub listened on `127.0.0.1:50051` over TLS with the POC private CA.
2. The gateway restarted with `metamynd-stub` registered.
3. The gateway called `Describe` with a JWT that verified (`caller_kind=gateway`).
4. The gateway called `ValidateConfig` when the sandbox was created with the middleware policy.
5. The POST from the sandbox got a **403** with the body `{"error":"middleware_denied","middleware":"metamynd-stub","reason_code":"stub_deny","layer":"l7","policy":"github",…}`.
6. The stub received an authenticated `EvaluateHttpRequest`:

   ```json
   {"rpc":"EvaluateHttpRequest","auth":"ok","request_id":"8a0056ee-…","sandbox_id":"159bd5a3-…",
    "token_sandbox_id":"159bd5a3-…","sandbox":"m0-stub-8562","method":"POST","host":"api.github.com",
    "port":443,"path":"/markdown","body_bytes":13,"reason_code":"stub_deny"}
   ```
7. OCSF logged `HTTP:POST [MED] DENIED … [policy:github engine:middleware] [failed:false transformed:false reason:middleware_denied:metamynd-stub:stub_deny]`.

The gateway was restored to its default config afterwards.

What this confirms for the design:
- Supervisors reach a host-bound middleware at `127.0.0.1` over TLS, and the gateway ships the pinned CA to them. Spike S2 is closed; no container or bridge networking is needed.
- The per-call JWT carries a gateway-attested `sandbox_id` that matches `RequestContext.sandbox_id`. This is the identity binding design §6.1 depends on.
- `request_id` is a UUID that the middleware sees, but it does **not** appear in the OCSF line. Correlation needs the adapter's journal, as design §7 assumes.
- The middleware receives the full request body (`body_bytes: 13`) before credentials are injected.
- The OCSF denial reason has the form `middleware_denied:<policy map key>:<reason_code>`.

npm reports that `protobufjs`'s postinstall script is not in `allowScripts`. It is skipped, and gRPC works without it.

## Upstream trust for the purchasing gateway (build plan step 0.5, spike S3)

```shell
bash tools/m0-upstream.sh
```

The script proves that a sandbox can reach a host-local purchasing stand-in (`tools/lib/upstream-echo.mjs`) at `host.openshell.internal` two ways:

- **HTTPS on port 8443:** the stand-in presents a certificate from the POC private CA, with SAN `DNS:host.openshell.internal`.
- **Plain HTTP on port 8081:** the fallback.

On both routes it checks that L7 enforcement applies, and that the `m0-purchasing` provider's bearer token is substituted after the sandbox while the sandbox only ever holds a placeholder.

Facts this relies on (OpenShell v0.1.2, Docker driver):
- **Upstream TLS trust.** The supervisor verifies upstream TLS against `/etc/ssl/certs/ca-certificates.crt` inside its own image. v0.1.2 has no config setting to add a private CA with the Docker driver. The script therefore builds `local/openshell-supervisor:0.1.2-pca`: the stock image with the stock bundle plus the POC CA, from `deploy/images/supervisor-pca`. It points the driver at that image through `[openshell.drivers.docker] supervisor_image`. The tag is local-only; a `latest` or `dev` tag would be re-pulled.
- **Loopback reachability.** Loopback destinations are always blocked, even with `allowed_ips`. The single exception is the policy host `host.openshell.internal`, which the Docker driver pins to the gateway's address (`127.0.0.1`), so no `allowed_ips` entry is needed. Custom names such as `purchasing.poc.internal` would need real DNS, and a loopback answer would still be blocked.
- **Credential binding.** The credential binds through an endpointless provider profile (`deploy/openshell/m0-purchasing-profile.yaml`) and `credential_binding` in the sandbox policy.

On exit the script always deletes the sandbox, the `m0-purchasing` provider and the `m0-purchasing-gw` profile. It removes `gateway.toml` and restarts the gateway on the stock supervisor image. The derived image stays in local Docker for reuse.

### Result: 29 Sep 2026 on COO-JASIM-NB1 (step 0.5 passed, spike S3 closed, M0 complete)

- `local/openshell-supervisor:0.1.2-pca` was built from the stock supervisor bundle plus the POC CA (151 roots), and the sandbox's supervisor ran it.
- The sandbox env held only `PURCHASING_TOKEN=openshell:resolve:env:v…_PURCHASING_TOKEN`. The real token appeared nowhere in the sandbox environment.
- `POST https://host.openshell.internal:8443/purchase-requests` reached the stand-in over the private-CA TLS hop with `auth_is_real_token: true`.
- `POST http://host.openshell.internal:8081/purchase-requests` did the same (`auth_is_real_token: true`).
- L7 enforcement held on the TLS path: `DELETE` got a 403.

**Decision:** the purchasing gateway runs HTTPS on `127.0.0.1:8443` as `host.openshell.internal`, trusted through the derived supervisor image. The plain-HTTP fallback is not needed. A profile with `auth_style: bearer` also needs `header_name: authorization` in v0.1.2.

## MetaMynd POC tenant and latency probe (build plan step 0.6, spike S5)

The POC uses the hosted MetaMynd service at `https://metamynd.ai/api/v1`, release `v1.71.0`, which contains AgentSafe #785. MetaMynd holds the Hedera operator account, so nothing on the POC host needs Hedera credentials.

### Tenant setup (one time)

1. Register a dedicated POC user at `https://metamynd.ai` using an address used only for the POC.
2. Create the POC owner principal: a fictional organisation such as "Acme Office Supplies (POC)".
3. A platform admin approves the principal's verification. Agents stay on **testnet**, so no real value moves.
4. On the POC host, create `~/src/openshell-integration/.env.poc`. It is gitignored. Restrict it with `chmod 600 .env.poc`.

   ```shell
   MM_USERNAME=<poc user email>
   MM_PASSWORD=<poc user password>
   ```

### Latency probe

```shell
bash tools/m0-latency.sh
```

On first run, the probe logs in as the POC user. It then provisions a throwaway agent, `poc-latency-probe`, through `POST /onboarding/agent` with these settings:
- a managed key on testnet;
- scope `office_supplies.purchase`;
- currency MYR, with a per-transaction cap of RM500 and a total of RM100,000;
- merchant `OfficeMart`.

It saves the returned guard config, which includes the agent key, to `state/latency-agent.json` with mode 0600, and reuses it on later runs.

The probe then times two classes of 20 signed `POST /policy/mandate/authorize` calls each:
- a merchant-denied class, which creates no hold;
- an allowed RM1 class, which creates small unclaimed holds that lapse after 15 minutes.

Results go to stdout and to `docs/report/runs/m0-latency.json`. The p95 figure sets the middleware `timeout` (design §5.3).

### Result: 29 Sep 2026 from COO-JASIM-NB1 to metamynd.ai (step 0.6 passed, spike S5 closed)

The POC tenant was created and its principal verified by a platform admin. The probe agent is `did:hedera:testnet:zJ4H95Gq…_0.0.10361974`.

| Class (20 calls each; includes signing) | Verdict | min | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| RM1 at PaperCo (not on the allow-list) | `block/MERCHANT_NOT_ALLOWED` ×20 | 357 ms | 405 ms | 929 ms | 974 ms |
| RM1 at OfficeMart | `allow/AUTHORIZED` ×20 | 994 ms | 1213 ms | 1570 ms | 1573 ms |

Findings:
- A permit costs about 800 ms more than a deny. The permit path also inserts the hold, anchors the decision to the ledger, and signs the Action Passport. This is worth raising with the MetaMynd team as a performance item.
- The design's middleware timeout goes from 3 s to **5 s**, with a 4 s gate deadline.
- **`riskLevel` is required.** metamynd.ai enforces the EU AI Act Standard, whose risk rule escalates any request without a well-formed `riskLevel` (`CONTEXT_UNVERIFIABLE`). The first probe run sent none and escalated all 20 allowed calls; those escalations are pending in the POC tenant's review queue and expire after 24 h. The adapter now takes `riskLevel` from operator route config (design §4.2).

## M1: MetaMynd side without OpenShell (build plan tasks 1.1–1.4)

### One-time: signer passphrase

Add a third line to `.env.poc`. It is the passphrase that encrypts the agent and gateway keys held by the `agentsafe-signer` daemons in `state/signers/`. There is no keychain or TPM backend on a normal WSL user, so the passphrase backend is pinned with `--kek-backend passphrase`.

```shell
AGENTSAFE_SIGNER_PASSPHRASE=<long random passphrase>
```

### Enrolment (task 1.3, run once)

```shell
bash tools/m1-enrol.sh
```

The script is idempotent:
- It starts a signer daemon for `agentA`, `agentB` and `gw`, each with a one-shot admin socket, and generates each Ed25519 key inside its daemon. Keys never leave the daemons.
- It onboards two **testnet BYOK** agents through `POST /onboarding/agent` and proves key possession with `sign-key-control-challenge` → `POST /agent-identity/:id/verify-key`:
  - **Agent A:** `office_supplies.purchase`, MYR, per transaction ≤ RM500, merchant `OfficeMart`, payload binding required. Its SOP blocks an unknown amount and anything over RM500, escalates over RM300, and escalates high risk.
  - **Agent B:** same scope, per transaction ≤ RM200, merchant `PaperCo`, with the default SOP.
- The cumulative budget for each agent is RM20,000. It never resets, so it is sized for many runs.
- It derives the gateway's `did:key` from its daemon key and registers it through `POST /policy/counterparties` for `OfficeMart` and `PaperCo`. **This switches the POC tenant to registered-counterparty-only claims.**

The results go to `state/enrolment.json` and `state/agents/{A,B}.json`, both mode 0600 and gitignored.

### Stack (task 1.2)

```shell
bash tools/poc-stack.sh up        # or: down | status
```

This starts three things:
- the signer daemons, now bound to their DIDs;
- the mock purchasing API on `127.0.0.1:18080`, with its ledger in `state/purchasing-ledger.sqlite`;
- the purchasing gateway on `https://127.0.0.1:8443`, with the POC CA certificate and SAN `host.openshell.internal`.

The gateway is `agentsafe-http-gateway` plus `agentsafe-mcp-guard`, with the service key held in its daemon and settings `denyByDefault`, `requireAuthorization`, `requirePayloadBinding` and `requireContextSignature`. Before any governance it requires `Authorization: Bearer <state/purchasing-api-token>`; that is the token OpenShell will substitute from the provider in M3. Logs go to `state/logs/`.

### Native baseline (task 1.4)

```shell
bash tools/m1-native.sh
```

It brings the stack up, runs the scenarios with no OpenShell in the path, and brings the stack down. Each purchase is authorized at metamynd.ai with the agent's daemon-held key and `context.riskLevel: low`. The client then sends a freshly signed request plus the `authorizationId` to the gateway in `x-magp-request`, the same pattern as `create-metamynd-agent`.

The scenarios check allow, over-cap, wrong merchant, escalation over RM300, agent B's rules, replay of an allowed request, body tampering, a missing upstream bearer, and a request with no governance. Each scenario asserts the gate verdict, the gateway status and the ledger delta. Results go to `docs/report/runs/m1-native.json`.

The RM350 scenario leaves an escalation in the tenant's review queue. It expires after 24 h.

### Result: 29 Sep 2026 on COO-JASIM-NB1 against metamynd.ai (M1 passed, spike S4 closed)

Enrolment:
- agent A `did:hedera:testnet:z9YYbfMa…_0.0.10361974`
- agent B `did:hedera:testnet:zAzPELLj…_0.0.10361974`
- gateway counterparty `did:key:z6MkrfsVFhSnfGChuneqy72bFd1JCKddwDwGaHo7UDkjC7UB`

All keys were generated in and held by the signer daemons, and both agents proved possession.

| Scenario | Gate | Gateway | Ledger |
| --- | --- | --- | --- |
| A buys RM100 at OfficeMart | `allow/AUTHORIZED` | 201 | +1 |
| A buys RM600 at OfficeMart | `block/SOP_SPEND_CAP` | – | 0 |
| A buys RM100 at PaperCo | `block/MERCHANT_NOT_ALLOWED` | – | 0 |
| A buys RM350 at OfficeMart | `escalate/AMOUNT_ABOVE_APPROVAL_THRESHOLD` | – | 0 |
| B buys RM100 at PaperCo | `allow/AUTHORIZED` | 201 | +1 |
| B buys RM100 at OfficeMart | `block/MERCHANT_NOT_ALLOWED` | – | 0 |
| B buys RM250 at PaperCo | `block/SOP_SPEND_CAP` | – | 0 |
| Replay of A's allowed request | – | 403 `AUTHORIZATION_ALREADY_CLAIMED` | 0 |
| A authorized RM100, body says RM90 | `allow/AUTHORIZED` | 403 `PAYLOAD_NOT_BOUND` | 0 |
| A allowed, no upstream bearer | `allow/AUTHORIZED` | 401 `UPSTREAM_AUTH_REQUIRED` | 0 |
| No MetaMynd governance at all | – | 401 `MISSING_GOVERNANCE` | 0 |

Findings:
- **S4 closed.** `agentsafe-http-gateway` accepts the `x-magp-request` built as `buildSignedRequest(...)` plus `authorizationId`, with a fresh nonce after `authorize`. That is the `create-metamynd-agent` pattern, and the adapter will build the header the same way.
- **An over-cap purchase is blocked by the SOP molecule** (`SOP_SPEND_CAP`) before the mandate's `SPEND_LIMIT_EXCEEDED` is reached. This confirms the scope's rule to record the actual reason rather than rely on evaluation order. Through the adapter it surfaces as `metamynd_sop_spend_cap`.
- **Holds from the tamper and missing-bearer scenarios were never claimed**, so they lapse after 15 minutes. The gateway refused both before the claim.
- **The RM350 escalation is pending in the POC tenant's queue.**

## M2: adapter deny path (build plan tasks 2.1–2.6)

```shell
bash tools/m2-deny.sh
```

The real adapter (`packages/adapter/src/main.mjs`) is built with no MetaMynd allow path (`gate: null`), so it can only deny. The script does the following:

1. Starts the purchasing stack.
2. Starts the adapter on `127.0.0.1:50051` over TLS.
3. Writes `gateway.toml`: middleware `metamynd` with `timeout = "5s"`, and the Docker driver using `local/openshell-supervisor:0.1.2-pca`.
4. Creates a sandbox with `deploy/openshell/m2-policy.yaml`, whose L7 rules allow the requests under test so that any denial comes from the adapter.
5. Binds the sandbox's UUID to agent A with `packages/adapter/bin/bindings.mjs`.
6. Sends seven requests from inside the sandbox, each expected to be denied with a specific reason code:

| Request | Expected `reason_code` |
| --- | --- |
| Valid RM100 OfficeMart purchase | `metamynd_gate_not_configured` (identity, binding, route and canonicalisation all passed) |
| `Content-Encoding: gzip` | `metamynd_request_rejected` |
| `amount` as a string | `metamynd_request_rejected` |
| Duplicate JSON key | `metamynd_request_rejected` |
| Field not in the route's `allowedFields` | `metamynd_request_rejected` |
| L7-allowed path with no adapter route | `metamynd_route_not_allowed` |
| Binding revoked mid-session | `metamynd_binding_unknown` |

It then checks the evidence:
- OCSF logs a `middleware_denied:metamynd:<code>` event for every request.
- Every decision is in `state/journal/*.jsonl`, with no header values or bodies.
- The purchasing gateway received nothing.

On exit it always deletes the sandbox, revokes the binding, restores the gateway's defaults, and stops the adapter and the stack.

Adapter modules: `describe` (negotiation), `jwt` (gateway token verification), `routes` (host-aware; reuses the http-gateway matcher), `canon` (strict JSON via the http-gateway parser), `registry` (atomic, last-good), `journal` (allow-listed fields, fsync), `reasons` (the OpenShell grammar), `adapter` (the pipeline). Every error path denies. A permit that cannot be journaled is withdrawn (`metamynd_internal_error`).

### Result: 29 Sep 2026 on COO-JASIM-NB1 (M2 passed)

- The gateway negotiated with the adapter using a verified JWT and validated the policy's `config.routes`.
- Sandbox `02f76672-61e4-45ec-b96c-71324f94c04d` was bound to agent A, generation 1. The UUID came from `openshell sandbox get <name> -o json`.
- All seven requests got their expected reason code:
  - valid purchase → `metamynd_gate_not_configured`
  - gzip → `metamynd_request_rejected`
  - string amount → `metamynd_request_rejected`
  - duplicate key → `metamynd_request_rejected`
  - extra field → `metamynd_request_rejected`
  - unrouted path → `metamynd_route_not_allowed`
  - revoked binding → `metamynd_binding_unknown`, effective within about 1 s of the revoke
- OCSF logged 7 `middleware_denied:metamynd:*` events.
- The journal holds 7 decisions for the sandbox and no header values or bodies.
- The purchasing gateway received no requests.

## M3: governed purchase through OpenShell (build plan tasks 3.1–3.6)

```shell
bash tools/m3-e2e.sh
```

The adapter now runs with the allow path on (`ADAPTER_GATE=on`, `packages/adapter/src/gate.mjs`). For a canonicalised request from a bound sandbox it acts as the bound agent:
1. It calls `agentsafe-guard` `authorize` at metamynd.ai with the agent's daemon-held key. The request carries:
   - `context.riskLevel` from the route;
   - `trace.workflowId = sandbox_id` and `trace.parentActionId = request_id`;
   - the parsed body as the bound payload.
2. On a permit it builds a fresh signed request with the `authorizationId` and writes it as the `x-magp-request` header mutation.
3. OpenShell then substitutes the `poc-purchasing` provider's bearer token.
4. The purchasing gateway re-verifies, claims, forwards and captures.

The response hook journals the upstream status against the `request_id`, for evidence only.

The script:
- starts the stack and the adapter;
- registers the adapter with its request and response bindings;
- imports the endpointless `poc-purchasing-gw` profile and creates the `poc-purchasing` provider with the token in `state/purchasing-api-token`;
- creates sandboxes A and B with `deploy/openshell/m3-policy.yaml` and binds each UUID to its agent.

It then checks:
- the sandbox holds only a placeholder for the purchasing token;
- **A buys RM100 at OfficeMart → 201, and exactly one ledger row is written**;
- **B's identical request → 403 `metamynd_merchant_not_allowed`**;
- B's own PaperCo purchase → 201;
- A at RM600 → `metamynd_sop_spend_cap`, and A at RM350 → `metamynd_escalation_pending`;
- `M3_CONCURRENT` (default 10) parallel RM1 purchases from each sandbox all succeed, and the ledger grows by exactly that many;
- the journal shows no cross-attribution: sandbox A's decisions are all agent A and sandbox B's all agent B;
- every allowed decision has an `authorizationId` and a joined 201 response record;
- the purchasing token never appears in the adapter's journal or log.

On exit it always deletes the sandboxes, provider and profile, revokes the bindings, restores the gateway, and stops everything.

### Result: 29 Sep 2026 on COO-JASIM-NB1 (M3 passed)

Sandbox A `e07cc3fa-…` was bound to agent A, and sandbox B `a7e3e8d7-…` to agent B, both through one adapter instance.

| Check | Result |
| --- | --- |
| Sandbox's `PURCHASING_TOKEN` | placeholder only |
| A buys RM1 at OfficeMart through OpenShell | **201, exactly one ledger row** (`x-magp-request` survived the chain; closes S6) |
| B, identical request | 403 `metamynd_merchant_not_allowed` |
| B buys RM1 at PaperCo | 201 |
| A RM600 | 403 `metamynd_sop_spend_cap` |
| A RM350 | 403 `metamynd_escalation_pending` (`AMOUNT_ABOVE_APPROVAL_THRESHOLD`) |
| A RM100 after an RM1 history | 403 `metamynd_escalation_pending` (`SPEND_PATTERN_ANOMALY`) |
| 20-request concurrent burst (10 per sandbox) | 17 × 201, 3 × 403; **ledger +17, exactly the 201s** |
| Journal | 26 decisions, no cross-attribution, 21/21 allowed decisions with an `authorizationId` and a joined upstream response |
| Purchasing token in the adapter journal or log | never |

Findings from the four M3 runs:
- **The allow path works through OpenShell unchanged.** The adapter's `x-magp-request` header mutation reaches the purchasing gateway after OpenShell substitutes the credential. The gateway re-verifies, claims and captures. Spike S6 is closed.
- **MetaMynd's spend-anomaly floor is active on metamynd.ai** (`SPEND_ANOMALY_MODE=on`). It looks at the agent's last 20 purchases for the action and flags an amount above mean + 4 sd, or above 4× a uniform mean, once there are at least 5. It escalates even when every rule allows the purchase. That is a behavioural control OpenShell alone cannot express. The test purchases at the agents' RM1 scale and reports the RM100 case. Agent A is now effectively limited to small purchases, so a demo of the RM100 story needs fresh agents.
- **Availability under bursts depends on the network path to metamynd.ai.** All refusals under 20-way concurrency were `fetch failed`, meaning the HTTPS call from the POC host never completed. This affected both the adapter's authorize (`GATE_UNREACHABLE`) and the purchasing gateway's claim (`GUARD_ERROR`). The rate was about 10–15% of burst calls, and every one failed closed. One earlier run (run 3) dropped the whole burst after the adapter allowed it; its sandbox logs were not captured. The script now keeps them for M4.
- **Latency: an allowed decision took 1.4–3.1 s** end to end at the adapter under a burst, inside the 4 s gate deadline.
- **OpenShell once returned an empty reply instead of the 403 body** for an adapter denial. It was not reproduced in later runs. The request was still blocked and no ledger row was written.

## M4: adversarial matrix (build plan tasks 4.1, 4.2, 4.6)

```shell
bash tools/m4-matrix.sh enforcing
bash tools/m4-matrix.sh verify-only
```

`enforcing` is defence in depth: the purchasing gateway re-verifies, claims and settles. `verify-only` runs the purchasing gateway with `GW_MODE=verify-only`: it checks only the bearer and forwards everything. That run proves **OpenShell plus the adapter alone** block every attack. Every row asserts the outcome **and** the ledger delta.

| Row | Attack or case | Expected |
| --- | --- | --- |
| R1 | A buys RM1 at OfficeMart | 201, ledger +1 |
| R2 | A over its RM500 cap | `metamynd_sop_spend_cap` |
| R3 | A at PaperCo | `metamynd_merchant_not_allowed` |
| R4 | B sends A's allowed request | `metamynd_merchant_not_allowed` |
| R5 | A puts agent B's DID in the body | `metamynd_request_rejected` |
| R6 | A forges an `x-magp-request` as agent B | Judged as agent A (`metamynd_merchant_not_allowed`, journal shows A) |
| R7 | Raw TCP from a shell (`/dev/tcp`) | Refused (binary not in policy) |
| R8, R9 | Gateway by IP literal; the purchasing API port directly | Blocked at L4 |
| R10 | Method not allowed by L7 | 403 |
| R11 | Declared gzip body | `metamynd_request_rejected` |
| R12 | WebSocket upgrade on a denied purchase | No ledger row |
| R13 | 5 + 5 concurrent purchases | Ledger delta equals the 201s; everything else 403 |
| R14 | Adapter down | 403 (`middleware_failed`), no ledger row |
| R15 | MetaMynd unreachable | `metamynd_gate_unreachable` |
| R16 | Purchasing gateway down after an allow (enforcing run only) | No ledger row; the hold lapses unclaimed |
| R17 | Sandbox deleted | The watcher revokes its binding |
| R18 | Recreated under the same name | New UUID, `metamynd_binding_unknown` |

It also runs `tools/policy-lint.sh` against each sandbox's effective policy, checking for: `tls: skip`, `protocol: tcp`, `allowed_ips`, literal-IP hosts, `enforcement: audit`, `fail_open`, a missing adapter, or an adapter that is not the last stage.

The revocation watcher (`packages/adapter/bin/watcher.mjs`) polls `openshell sandbox list -o json` every 2 s and revokes a binding after 2 consecutive misses. A failed poll never revokes anything.

**Deviation from the design:** the watcher uses the CLI's mTLS credentials instead of a gRPC `ListSandboxes`/`WatchSandbox` client, so no OpenShell control-plane protos are vendored. The revocation lag is bounded by the poll interval.

Deferred, and not in the matrix:
- **4.3, cleanup of unclaimed holds:** MetaMynd already lapses unclaimed holds after 15 min.
- **4.4 and 4.5, escalation retry and the policy-integrity interceptor:** stretch goals.
- **MetaMynd-side mandate revocation:** it would permanently revoke the enrolled agents. Binding revocation (R17, and M2) and containment are covered instead.
- **A later middleware rewriting the body:** it needs a second middleware service. Body tampering is refused at the purchasing gateway (M1, `PAYLOAD_NOT_BOUND`).

### Finding: OpenShell drops in-flight requests when a sandbox's provider environment reloads

First M4 runs, 29 Sep 2026: in both matrix modes, all five of sandbox B's concurrent purchases got curl `(52) Empty reply from server`. The adapter had **allowed** each of them (1.7–2.7 s), but none reached the purchasing gateway. Sandbox B's OpenShell log shows why:

```
HTTP:POST [INFO] ALLOWED POST http://host.openshell.internal:8443/purchase-requests [policy:purchasing engine:l7]   (x5, then in the adapter)
CONFIG:DETECTED Settings poll: config change detected [... policy_changed:false provider_env_changed:true]
NET:OPEN [MED] DENIED host.openshell.internal:8443 [reason:L7 tunnel closed before inspection because policy changed:
         policy generation is stale [captured_generation:2 current_generation:3]]   (x5)
```

When the supervisor sees a provider-environment change (`provider_env_changed:true`, even with `policy_changed:false`), it bumps the policy generation and closes every in-flight L7 tunnel. That includes requests whose middleware evaluation is still running. The client gets an empty reply, not a 403 or 503.

The change landed 0.78 s after the burst's `openshell sandbox exec --env MERCHANT=…` session opened. Our test used `exec --env`, which apparently counts as a provider-environment change. The scripts now pass values as `sh -c` positional arguments instead.

- **Safety held.** Nothing executed. The adapter's MetaMynd holds were unclaimed and lapse after 15 minutes.
- **Availability impact.** Any config or provider change to a sandbox aborts its in-flight requests. With a MetaMynd round trip of about 1–3 s, the window is wide.
- **Upstream feature request.** Let in-flight L7 requests finish, or give them a retryable 503, when only the provider environment changed, instead of closing tunnels with no response.
- **Matrix handling.** When OpenShell drops a single request, the matrix uses the adapter's decision from its journal if the entry is under 30 s old, and says so in a `note` line.

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

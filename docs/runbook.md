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

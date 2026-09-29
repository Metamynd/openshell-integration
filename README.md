# MetaMynd × NVIDIA OpenShell integration

Proof-of-concept scope for putting MetaMynd's agent-authorization decisions behind [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) supervisor middleware. OpenShell supplies containment and egress control. MetaMynd supplies business authority: a live mandate, spend and merchant rules, revocation, human escalation, and an anchored evidence trail.

This is a scoping document, not a claim of an existing partnership, endorsement, or completed integration.

## Contents

- [`MetaMynd_OpenShell_Integration_POC_Scope_v0.3.md`](MetaMynd_OpenShell_Integration_POC_Scope_v0.3.md): the current scope. It is checked against OpenShell `v0.1.2` and the MetaMynd guard and gateway packages.
- [`versions.lock.json`](versions.lock.json): pinned OpenShell tag and commit, SHA-256 of the vendored protos, AgentSafe commit and host minimums.
- [`adapter/`](adapter): the MetaMynd OpenShell adapter (Node 22, plain ESM, `@grpc/grpc-js`). `adapter/proto/openshell/` holds the two OpenShell protos it implements, vendored unmodified under Apache-2.0.
- [`scripts/wsl-preflight.sh`](scripts/wsl-preflight.sh): WP0 host checks (systemd, kernel ≥6.2, Landlock ABI ≥3, seccomp, Docker ≥28, Node ≥22).
- [`scripts/sync-protos.sh`](scripts/sync-protos.sh): re-vendors the protos at the pinned commit; `--check` verifies them.

## Getting started

```sh
scripts/wsl-preflight.sh          # on the WSL2 or Linux host that will run OpenShell
cd adapter && npm ci && npm test
```

## Status

WP0 repo setup is done: pins, vendored protos, and a proto-loading test. The middleware server itself has not been written yet. The OpenShell supervisor-middleware API is a research preview, so the scope pins OpenShell `v0.1.2`.

OpenShell is licensed under Apache-2.0 by NVIDIA. NVIDIA and OpenShell are trademarks of their respective owners.

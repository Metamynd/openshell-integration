# MetaMynd × NVIDIA OpenShell integration

Proof-of-concept scope for putting MetaMynd's agent-authorization decisions behind [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) supervisor middleware. OpenShell supplies containment and egress control. MetaMynd supplies business authority: a live mandate, spend and merchant rules, revocation, human escalation, and an anchored evidence trail.

This is a scoping document, not a claim of an existing partnership, endorsement, or completed integration.

## Contents

- [`MetaMynd_OpenShell_Integration_POC_Scope_v0.3.md`](MetaMynd_OpenShell_Integration_POC_Scope_v0.3.md): the current scope. It is checked against OpenShell `v0.1.2` and the MetaMynd guard and gateway packages.
- [`docs/design.md`](docs/design.md): adapter design. It covers the components, interfaces, request flows, security model, evidence joins, deployment topology and open spikes.
- [`docs/build-plan.md`](docs/build-plan.md): milestones M0–M5, with tasks, exit criteria, dependencies and risks.
- [`versions.lock`](versions.lock): pinned OpenShell tag and commit, SHA-256 of the vendored protos, MetaMynd backend commit and package versions, and host minimums.
- [`proto/v0.1.2/`](proto/v0.1.2): the two OpenShell protos the adapter implements, vendored unmodified under Apache-2.0.
- [`packages/adapter/`](packages/adapter): the MetaMynd OpenShell adapter (Node 22 ESM, `@grpc/grpc-js`).
- [`tools/host-preflight.sh`](tools/host-preflight.sh): M0 host checks (systemd, kernel ≥6.2, Landlock ABI ≥3, seccomp, Docker ≥28, Node ≥22).
- [`tools/sync-protos.sh`](tools/sync-protos.sh): re-vendors the protos at the pinned commit; `--check` verifies them.

## Getting started

```sh
tools/host-preflight.sh   # on the WSL2 or Linux host that will run OpenShell
npm ci
npm run check             # lint, tsc --checkJs, node:test
```

## Status

M0 task 0.1 (repo scaffold) is done. The middleware server itself has not been written yet. The OpenShell supervisor-middleware API is a research preview, so the scope pins OpenShell `v0.1.2`.

OpenShell is licensed under Apache-2.0 by NVIDIA. NVIDIA and OpenShell are trademarks of their respective owners.

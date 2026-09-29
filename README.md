# MetaMynd × NVIDIA OpenShell integration

A proof of concept that puts MetaMynd's agent-authorization decisions behind [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) supervisor middleware. OpenShell supplies containment, egress control and credential isolation. MetaMynd supplies business authority: live mandates, spend and merchant rules, human escalation, behavioural anomaly checks, per-agent identity, and an anchored evidence trail.

This is a POC built on public, released extension points. It is not a claim of partnership, endorsement or a completed product integration.

**Start with the [integration report](docs/report/integration-report.md).**

## Status

The POC is complete through M5 on one host (OpenShell `v0.1.2`, metamynd.ai `v1.71.0`, WSL2). A governed purchase from an OpenShell sandbox:
1. is authorized at metamynd.ai as the agent bound to that sandbox;
2. has its credential substituted by OpenShell;
3. is re-verified and settled by MetaMynd's purchasing gateway;
4. executes exactly once.

An 18-row adversarial matrix passed with the purchasing gateway enforcing and in verify-only mode. Every decision joins across OpenShell OCSF, the adapter journal, MetaMynd evidence and the ledger. The independent threat review is still open.

## Contents

| Path | What |
| --- | --- |
| [`docs/report/integration-report.md`](docs/report/integration-report.md) | Results, findings, limitations and next steps |
| [`docs/report/upstream/`](docs/report/upstream) | Seven OpenShell issue drafts (one reproducible bug), not filed |
| [`docs/runbook.md`](docs/runbook.md) | How to run every milestone, and the raw result of every run |
| [`docs/design.md`](docs/design.md), [`docs/build-plan.md`](docs/build-plan.md) | Adapter design and milestones M0–M5 |
| [`MetaMynd_OpenShell_Integration_POC_Scope_v0.3.md`](MetaMynd_OpenShell_Integration_POC_Scope_v0.3.md) | The POC scope |
| [`packages/adapter/`](packages/adapter) | The MetaMynd OpenShell adapter (gRPC middleware), binding registry, revocation watcher |
| [`packages/purchasing-gateway/`](packages/purchasing-gateway) | MetaMynd's `agentsafe-http-gateway` over TLS in front of the purchasing API |
| [`packages/mock-purchasing/`](packages/mock-purchasing) | Idempotent mock purchasing API and ledger |
| [`packages/poc-cli/`](packages/poc-cli) | Enrolment, native baseline, evidence joiner, latency client |
| [`tools/`](tools) | Host preflight and one script per milestone (`m0-*` … `m5-*`, `m4-matrix.sh`, `poc-stack.sh`, `policy-lint.sh`) |
| [`proto/v0.1.2/`](proto/v0.1.2), [`versions.lock`](versions.lock) | Vendored OpenShell middleware protos (Apache-2.0) and every version pin |

## Getting started

```sh
bash tools/host-preflight.sh   # on the WSL2 or Linux host that runs OpenShell
npm ci
npm run check                  # lint, tsc --checkJs, node:test
```

Then follow [`docs/runbook.md`](docs/runbook.md). It needs a MetaMynd tenant (`.env.poc`, gitignored) and an OpenShell `v0.1.2` gateway.

OpenShell is licensed under Apache-2.0 by NVIDIA. NVIDIA and OpenShell are trademarks of their respective owners.

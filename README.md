# MetaMynd × NVIDIA OpenShell integration

Proof-of-concept scope for putting MetaMynd's agent-authorization decisions behind [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) supervisor middleware. OpenShell supplies containment and egress control. MetaMynd supplies business authority: a live mandate, spend and merchant rules, revocation, human escalation, and an anchored evidence trail.

This is a scoping document, not a claim of an existing partnership, endorsement, or completed integration.

## Contents

- [`MetaMynd_OpenShell_Integration_POC_Scope_v0.3.md`](MetaMynd_OpenShell_Integration_POC_Scope_v0.3.md): the current scope. It is checked against OpenShell `v0.1.2` and the MetaMynd guard and gateway packages.
- [`docs/design.md`](docs/design.md): adapter design. It covers the components, interfaces, request flows, security model, evidence joins, deployment topology and open spikes.
- [`docs/build-plan.md`](docs/build-plan.md): milestones M0–M5, with tasks, exit criteria, dependencies and risks.

## Status

Design and planning. No adapter code has been written yet. The OpenShell supervisor-middleware API is a research preview, so the scope pins OpenShell `v0.1.2`.

OpenShell is licensed under Apache-2.0 by NVIDIA. NVIDIA and OpenShell are trademarks of their respective owners.

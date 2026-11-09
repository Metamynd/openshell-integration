---
name: run-openshell-poc
description: Run the MetaMynd and NVIDIA OpenShell proof of concept, in which a purchase from an OpenShell sandbox is authorized by MetaMynd before it executes. Use when the user wants to evaluate, reproduce or demo MetaMynd authorization middleware on OpenShell. It is a proof of concept for evaluation, not a production install.
---

# Run the MetaMynd and OpenShell proof of concept

This reproduces a proof of concept: MetaMynd authorization behind NVIDIA OpenShell supervisor
middleware, shown with a mock purchasing API. Tell the user these things before starting:

- It is a proof of concept, not a product, and not a claim of partnership with NVIDIA.
- It has run on one host (WSL2 with Docker). The independent threat review is still open.
- Agents stay on testnet and purchases go to a mock API, so no real value moves.

`docs/runbook.md` is the source of truth. Read the section for each step before running it, and
follow it if it differs from this summary.

## 1. Check the host

It needs Linux or WSL2 Ubuntu 24.04 with systemd, kernel 6.2 or later, Landlock, Docker Engine 28 or
later, Node 22 or later, and OpenShell `v0.1.2`, the version the protos are pinned to. Under WSL,
clone inside the WSL filesystem and not under `/mnt/c`.

Show the user the OpenShell install step from the runbook and let them decide whether to run it.
Then, from the repository root:

```bash
bash tools/host-preflight.sh
npm ci
npm run check
```

Stop and report any `FAIL` line from preflight.

## 2. Set up a dedicated tenant

The user does this part. It needs a MetaMynd user and a fictional organisation used only for this
proof of concept, and that organisation's verification has to be approved. **Do not use a real
tenant:** enrolment switches the tenant to registered-counterparty-only claims.

Ask the user to create `.env.poc` themselves, as the runbook describes, and to run
`chmod 600 .env.poc`. It holds their password and the signer passphrase. Never ask for those values
in chat, never print the file, and confirm it stays gitignored. The same goes for everything under
`state/`.

## 3. Enrol and start

```bash
bash tools/m1-enrol.sh
bash tools/poc-stack.sh up
bash tools/poc-stack.sh status
```

Enrolment is idempotent. It creates two testnet agents with keys held inside signer daemons.

## 4. Run a governed purchase

```bash
bash tools/m3-e2e.sh
```

Report what each case returned against the expected results in the runbook. To see the full story
instead, run `bash tools/demo.sh`, which plays nine scenes and waits for Enter between them.

## 5. Optionally, run the adversarial matrix

```bash
bash tools/m4-matrix.sh enforcing
```

Report any row that did not pass exactly as it appears. Do not edit a policy, a script or an
expected result to make a row pass.

## 6. Clean up

```bash
bash tools/poc-stack.sh down
bash tools/poc-reset.sh --dry-run
```

Show the user the dry-run list, and run `bash tools/poc-reset.sh` only after they agree. It removes
what the proof-of-concept scripts created, and restarts the OpenShell gateway.

## 7. Tell the user what this does not show

Point them at the Limitations section of `docs/report/integration-report.md`. In short: one host, one
HTTPS API with a JSON body, small local latency samples, and no independent threat review yet.
WebSocket, streaming, `tls: skip` and `protocol: tcp` traffic are not covered.

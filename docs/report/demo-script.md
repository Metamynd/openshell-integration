# Demo script: five minutes

The recording follows `tools/demo.sh` scene by scene. Each scene waits for Enter, so the narration sets the pace. About 650 words of narration fits five minutes.

## Before recording

1. On COO-JASIM-NB1, update `main` and check the stack is idle (no other POC script running).
2. Terminal: WSL window maximised, dark theme, font size 18 or larger, about 110 × 32 characters. Hide the prompt's hostname if you prefer.
3. Browser: signed in to metamynd.ai as the POC principal, with the review queue open in a tab. Close every tab that shows DIDs, keys or `.env.poc`.
4. Recording: OBS, or Windows' built-in Game Bar (Win + Alt + R records the active window). Record the terminal and the browser tab; cut between them in the edit.
5. Rehearse once with `DEMO_AUTO=3 bash tools/demo.sh`. The run adds a few RM1 rows and two escalations to the tenant; the escalations expire after 24 h.
6. Start: `bash tools/demo.sh`. Setup takes about a minute and prints `ready`, including `bundle cache 30000 ms`: the gateway's policy-bundle cache is on by default (`GW_BUNDLE_TTL_MS=0` turns it off). Start recording, then press Enter.

If the last screen shows an **Operator check** block, a scene did not behave as expected: re-record that scene or cut the block.

## Scenes and narration

| # | Time | Screen | Narration |
| --- | --- | --- | --- |
| 1 | 0:00–0:35 | The question and the diagram | "AI agents can now act for hours without supervision. When one acts outside its mandate, can we stop it before it reaches the business system, and show why? Here are two procurement agents, each in its own NVIDIA OpenShell sandbox, sharing one MetaMynd decision service and one purchasing system." |
| 2 | 0:35–1:05 | Placeholder token; keys absent | "First, the agent holds no secrets. Its API token is only a placeholder: OpenShell swaps in the real one after MetaMynd approves. And the agents' signing keys live outside the sandbox, where the agent can't reach them." |
| 3 | 1:05–1:40 | A's purchase → 201; ledger +1 | "Agent A buys paper from OfficeMart, its approved supplier. OpenShell intercepts the request, MetaMynd checks agent A's live mandate, and the purchasing system settles it. Exactly one ledger row." |
| 4 | 1:40–2:10 | B's identical request → 403 | "Now agent B sends the identical request, byte for byte. It's refused: B isn't authorised for OfficeMart. Identity comes from the sandbox OpenShell attests, not from anything the agent writes." |
| 5 | 2:10–2:55 | RM600 → limit; RM350 → approval; cut to the review queue | "The organisation's rules apply before anything happens. RM600 is over agent A's limit. RM350 needs a person's approval, so it now waits in the principal's review queue, with a named, accountable human." |
| 6 | 2:55–3:25 | RM100 → anomaly escalation | "RM100 is within every limit. But agent A has only ever spent RM1, so MetaMynd flags the jump for review. That's behaviour, not just rules." |
| 7 | 3:25–4:05 | Raw TCP, IP address, direct port, Python | "Can the agent get around it? A raw connection from the shell: refused. The gateway by IP address, or the purchasing API directly: blocked. A different program, Python instead of curl: same MetaMynd decision. Every path goes through OpenShell." |
| 8 | 4:05–4:35 | Evidence table | "And every decision leaves one trace across four sources: OpenShell's log, the adapter's journal, MetaMynd's evidence with its anchored Merkle proof, and the ledger." |
| 9 | 4:35–5:00 | What each layer did | "OpenShell controls where an agent can go and keeps secrets out of its hands. MetaMynd decides whether a specific action is authorised, and by whom. Neither can do the other's job, and together a governed purchase takes about a second. That's how agents earn the right to do real work." |

Scene 8 waits until 75 s have passed since the first purchase, so MetaMynd's evidence batch has anchored. At a normal pace no countdown shows; if one does, cut it.

## What to keep off screen

- DIDs, sandbox UUIDs, the purchasing token, `.env.poc` and anything under `state/` (the runner prints none of these).
- Any claim of partnership or endorsement. Say "NVIDIA OpenShell" as the product name only.
- The OpenShell reload bug. If a scene shows "OpenShell closed the connection… retrying", cut the line or re-record; the bug is for the maintainers first.

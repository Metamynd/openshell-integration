# [Feature] Model an operator middleware in the policy prover as an opaque, fail-closed gate

*Draft for NVIDIA/OpenShell. Not filed.*

**User story.** As an operator who adds an authorization middleware, I still want the prover's containment answers for the rest of my policy.

**Problem statement.** Any policy with `network_middlewares` makes the prover return `unsupported`.

**Impact.** We prove the policy with the middleware block removed and report middleware coverage separately. That loses the combined statement.

**Proposed design.** Treat each attached `fail_closed` middleware as an opaque predicate that may deny but never widens reachability. The prover can then still prove the L4 and L7 boundaries and state "additionally gated by middleware X on hosts Y", without claiming anything about the external decision.

**Acceptance criteria.** A policy with a `fail_closed` middleware gets the same containment result as without it, annotated with the middleware gate.

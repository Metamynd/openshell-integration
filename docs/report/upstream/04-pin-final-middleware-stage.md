# [Feature] Let an operator pin a middleware as the final stage, or protect governed fields from later stages

*Draft for NVIDIA/OpenShell. Not filed.*

**User story.** As an operator whose middleware authorizes the exact request body, I want a guarantee that no later stage can change what I approved.

**Problem statement.** A chain can hold up to 10 stages, ordered by the policy's `order` field, and policies are live-editable. A later stage receives the body and headers my stage allowed, and may replace them. Nothing in the registration lets an operator require that their stage runs last or that governed fields stay read-only.

**Impact.** We mitigate this in three ways: running at the highest `order`, binding the payload digest into a signed request that the upstream re-verifies, and linting the effective policy. A policy author can still reorder stages. Our upstream then refuses the request (it fails closed), but authorization at the middleware alone becomes unreliable.

**Proposed design.** One of the following:
- a registration-level `pin: final` that the gateway enforces when a policy is written;
- a per-binding option making the body and a list of headers read-only for later stages;
- a supported `validate` interceptor recipe for this purpose.

**Alternatives considered.** A gateway interceptor on `CreateSandbox`/`UpdateConfig` (possible today, but custom). Upstream re-verification, which is what we do.

**Acceptance criteria.** An operator can guarantee that the bytes they approved are the bytes forwarded, apart from OpenShell's own credential substitution.

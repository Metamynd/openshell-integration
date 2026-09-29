# [Feature] Trust a private upstream CA with the Docker driver without a custom supervisor image

*Draft for NVIDIA/OpenShell. Not filed.*

**User story.** As an operator protecting an internal HTTPS API signed by a private CA, I want the supervisor to verify that upstream without rebuilding the supervisor image.

**Problem statement.** The supervisor reads upstream roots from its own image (`/etc/ssl/certs/ca-certificates.crt`, plus bundled webpki roots). `proxy_ca_bundle` exists for the Podman, Kubernetes and VM drivers, but only together with `https_proxy`, and not at all in the Docker driver's config. `SSL_CERT_FILE` has no effect on this path.

**Impact.** We built a derived image (`FROM supervisor:0.1.2`, then `COPY` the stock bundle plus our CA) and set `[openshell.drivers.docker] supervisor_image`. It works, but it has to be rebuilt for every release.

**Proposed design.** A driver-independent gateway setting such as `[openshell.supervisor] upstream_ca_bundle = "…"` that the gateway ships to supervisors, in the same way it ships middleware `tls_ca_cert_path`, and adds to the upstream root store.

**Acceptance criteria.** A supervisor verifies a private-CA upstream using only gateway configuration.

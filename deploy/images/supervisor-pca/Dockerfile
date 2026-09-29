# OpenShell v0.1.2 supervisor with the POC private CA added to its upstream trust store.
# The supervisor reads upstream roots only from /etc/ssl/certs/ca-certificates.crt in its
# own image; v0.1.2 has no config knob for this with the Docker driver. The base is
# distroless (no shell), so the combined bundle is prepared outside and copied in by
# tools/m0-upstream.sh. The bundle is the stock one plus our CA, so public roots still work.
ARG BASE=ghcr.io/nvidia/openshell/supervisor:0.1.2
FROM ${BASE}
COPY ca-bundle.crt /etc/ssl/certs/ca-certificates.crt

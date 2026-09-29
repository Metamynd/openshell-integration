# Minimal sandbox image for the M0 smoke test. The default OpenShell workload image
# (nvcr.io/nvidia/base/ubuntu:24.04) ships without curl.
FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Docker sandboxes need a non-root OCI USER; OpenShell starts the supervisor as
# root and drops agent processes to this account.
RUN groupadd --gid 1500 agent \
    && useradd --uid 1500 --gid agent --create-home agent \
    && install -d -o agent -g agent /sandbox
WORKDIR /sandbox
USER agent

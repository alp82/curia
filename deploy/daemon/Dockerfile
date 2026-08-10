# The daemon image (#260). The code is NOT baked in — it runs from the repo
# mount at /home/alp/curia — so this image is only the toolchain: node (pinned
# to what the box ran under systemd), git, gh, the docker CLI (agent containers
# are siblings on host dockerd), the tailscale CLI (Serve over the host
# tailscaled socket), and tmux as a CLIENT of the tmux service's server.
#
# Every version is a pin, same rule as config/curia.yaml `sandbox:`.

ARG NODE_VERSION=22.17.1
ARG DOCKER_CLI_VERSION=28
ARG COMPOSE_VERSION=v2.39.2
ARG TAILSCALE_VERSION=v1.98.10

FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli
FROM docker/compose-bin:${COMPOSE_VERSION} AS compose-bin
FROM tailscale/tailscale:${TAILSCALE_VERSION} AS tailscale

FROM node:${NODE_VERSION}-bookworm-slim
ARG GH_VERSION=2.97.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends git tmux bash curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Debian ships a 2023 gh; pinned from the upstream release instead (same
# reasoning as the agent image's pin in config/curia.yaml).
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /tmp \
  && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh_*

# Static Go binaries: safe to copy across distros.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
# The compose plugin, for the self-deploy sibling (#270): the deploy verb runs
# deploy/self-deploy.sh in a container on THIS image, and that script drives
# `docker compose`. Pinned to the version proven on the box (#260).
COPY --from=compose-bin /docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

# Seed the tmux socket volume dir with the right owner: a named volume copies
# ownership from the image on first use, and a root-owned dir would stop
# uid 1000 from creating the socket.
RUN mkdir -p /run/curia-tmux && chown 1000:1000 /run/curia-tmux

# HOME is /home/alp (compose sets it; the mounts sit under it). The directory
# itself must exist writable for uid 1000, or container-local writes beside
# the mounts — the npm cache, shell state — fail with EACCES.
RUN mkdir -p /home/alp && chown 1000:1000 /home/alp

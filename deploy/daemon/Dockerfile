# The daemon image (#260). The code is NOT baked in — it runs from the repo
# mount at /home/alp/curia — so this image is only the toolchain: node (the one
# pin every curia image shares, #357), git, gh, the docker CLI (agent containers
# are siblings on host dockerd), the tailscale CLI (Serve over the host
# tailscaled socket), tmux as a CLIENT of the tmux service's server, and the
# sqlite3 shell for the journal.
#
# Every version is a pin, same rule as config/curia.yaml `sandbox:`.

# NODE_VERSION carries NO default (#357, applied by #409). One patch version
# runs every curia image, and it is committed in deploy/compose.yaml for this
# image and in config/curia.yaml for the agent one. A build that forgets the arg
# fails here rather than picking a Node of its own.
ARG NODE_VERSION
ARG NPM_VERSION=11.12.1
ARG DOCKER_CLI_VERSION=28
ARG COMPOSE_VERSION=v2.39.2
ARG TAILSCALE_VERSION=v1.98.10

FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli
FROM docker/compose-bin:${COMPOSE_VERSION} AS compose-bin
FROM tailscale/tailscale:${TAILSCALE_VERSION} AS tailscale

FROM node:${NODE_VERSION}-bookworm-slim
ARG GH_VERSION=2.97.0
ARG NPM_VERSION

# The base image ships its own npm, and one npm major rewrites what another one
# wrote: npm 10 strips the `libc` field npm 11 puts in package-lock.json. The
# start-time `npm install` runs against the repo mount, so a mismatched npm
# dirties the checkout and the next deploy refuses. Pin the version the dev
# machines run. Node 24 ships an npm 11 of its own, so this pin now fixes the
# patch rather than the major.
RUN npm install -g --no-fund --no-audit "npm@${NPM_VERSION}"

# sqlite3 is the journal's shell (#409, from ADR-0017). Two things need it: the
# daily `.dump` the daemon spawns for the backup (#436), and the operator, whose
# whole read surface on the journal is SQL after #320. The host's own copy is not
# an option — Ubuntu 20.04 packages SQLite 3.31, which cannot open a STRICT
# table. Debian 12 packages 3.40, which can. Unpinned, like the rest of this apt
# set.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tmux bash curl ca-certificates sqlite3 \
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

# HOME is `home/` inside the workspace root, and compose passes the same path
# here that it sets on the container (#473). curia owns that tree rather than
# the operator's home. The workspace mount covers it at run time, so what this
# line makes is the fallback under the mount — but the directory must exist
# writable for uid 1000 either way, or container-local writes beside the mounts
# — the npm cache, shell state — fail with EACCES.
#
# No default, the rule the Node pin already follows: an empty arg makes
# `mkdir -p ""` fail, so a build that forgets it stops here rather than baking a
# home at a path nobody named.
ARG CURIA_HOME
RUN mkdir -p "$CURIA_HOME" && chown 1000:1000 "$CURIA_HOME"

# The daemon image (#260, release stage by #869). Three stages:
#
#   toolchain  node (the one pin every curia image shares, #357), git, gh, the
#              docker CLI (agent containers are siblings on host dockerd), the
#              tailscale CLI (Serve over the host tailscaled socket), tmux as a
#              CLIENT of the tmux service's server, and the sqlite3 shell for
#              the journal.
#   box        the source deployment's image (deploy/compose.yaml, `target:
#              box`). The code is NOT baked in — it runs from the repo mount —
#              so this stage adds only what uid 1000 on that box needs.
#   release    the published image. The checkout sits at /opt/curia with its
#              dependency tree installed, root-owned and read-only to whoever
#              runs it, and nothing in it assumes a uid or a host path. The
#              release workflow builds this stage and the Compose bundle names
#              it by digest.
#
# Every version is a pin, same rule as config/curia.yaml `sandbox:`.

# NODE_VERSION carries NO default (#357, applied by #409). One patch version
# runs every curia image, and it is committed in config/curia.yaml as
# `sandbox.node_version`, which deploy/compose.yaml anchors for this box and
# deploy/bundle/pins.mjs reads for a release. A build that forgets the arg
# fails here rather than picking a Node of its own.
ARG NODE_VERSION
ARG NPM_VERSION=11.12.1
ARG DOCKER_CLI_VERSION=28.5.2
ARG COMPOSE_VERSION=v2.39.2
ARG TAILSCALE_VERSION=v1.98.10

FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli
FROM docker/compose-bin:${COMPOSE_VERSION} AS compose-bin
FROM tailscale/tailscale:${TAILSCALE_VERSION} AS tailscale

FROM node:${NODE_VERSION}-bookworm-slim AS toolchain
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

# ---------------------------------------------------------------------------
# The source deployment's image. deploy/compose.yaml builds this stage.
FROM toolchain AS box

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

# ---------------------------------------------------------------------------
# The release image (#869). Last, so a build that names no target builds it.
#
# What it carries is what the service reads at run time and nothing beside it:
# the daemon's code, its assets, and its pinned dependency tree; the lifecycle
# interface's source, which the daemon imports by relative path (#866); the
# shipped configuration; the vendored skills; and the agent image recipe, which
# the service builds on the host from its pins (daemon/src/image.mjs). Named
# paths, never a tree: `daemon/` as a whole would carry the box's env file and
# journal, and the repository root would carry the secrets directory.
#
# Every file is root-owned and world-readable, which is what makes an installed
# version read-only to the operator that runs it (#851). The process writes
# only under the installation root's mounts and under HOME, which the bundle
# sets to `cache/home` inside the root.
FROM toolchain AS release

# The socket directory the tmux volume copies on first use, writable by any uid
# with the sticky bit, because the operator's uid is a run-time fact (#851).
RUN mkdir -p /run/curia-tmux && chmod 1777 /run/curia-tmux

WORKDIR /opt/curia/daemon
# Its own layer, keyed on the two pin files, so a code-only change reuses it.
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --ignore-scripts \
  && npm cache clean --force
COPY daemon/src ./src
COPY daemon/bin ./bin
COPY daemon/assets ./assets
COPY cli/src /opt/curia/cli/src
COPY config/curia.yaml config/routing.yaml /opt/curia/config/
COPY skills /opt/curia/skills
COPY deploy/agent /opt/curia/deploy/agent

LABEL org.opencontainers.image.title="curia daemon" \
      org.opencontainers.image.source="https://github.com/alp82/curia" \
      org.opencontainers.image.description="The Curia service: the agent-facing surface, the Discord bridge, and the durable journal." \
      curia.gh-version="${GH_VERSION}"

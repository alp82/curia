# The dashboard sidecar image (#249, #260, stood up by #263, release stage by
# #869). Secret-free: node plus the tailscale CLI — the sidecar asserts its own
# Serve rule over the host tailscaled socket. No credentials on disk or in env.
#
# Three stages, the same shape as the daemon image:
#
#   toolchain  node and the tailscale CLI.
#   box        the source deployment's image. The CODE is not baked in. It
#              runs from the repo mount, exactly as the daemon's does, so a
#              deploy is a pull plus a restart. What IS baked in is the
#              dependency tree, and that is deliberate: compose mounts
#              `daemon/src`, `daemon/bin` and `daemon/assets` and nothing else
#              under `daemon/`, because the two things it must NOT mount live
#              beside them — `.env` holds the Discord token, and `data/` holds
#              the journal the where-it-lives decision keeps daemon-private.
#   release    the published image, the code and the tree at /opt/curia.
#
# Both install the DAEMON's own pinned tree rather than a hand-listed subset.
# The sidecar imports daemon modules, so a second pin here would be a second
# version of a module the two processes share.

# No default: the pin is one version across every curia image, and it comes
# from config/curia.yaml through the anchor in deploy/compose.yaml on the box
# and deploy/bundle/pins.mjs in a release (#357, applied by #409).
ARG NODE_VERSION
ARG TAILSCALE_VERSION=v1.98.10

FROM tailscale/tailscale:${TAILSCALE_VERSION} AS tailscale

FROM node:${NODE_VERSION}-bookworm-slim AS toolchain

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale

# ---------------------------------------------------------------------------
# The source deployment's image. deploy/compose.yaml builds this stage.
FROM toolchain AS box

# HOME for uid 1000 (see daemon Dockerfile). This container mounts no
# workspace, so the directory this line makes is the one the process runs on.
# Neither arg carries a default, the rule the Node pin already follows (#473).
ARG CURIA_HOME
RUN mkdir -p "$CURIA_HOME" && chown 1000:1000 "$CURIA_HOME"

# THE BAKED DEPENDENCY TREE HAS TO SIT WHERE THE REPO MOUNTS (#473). Compose
# mounts `daemon/src`, `daemon/bin` and `daemon/assets` and nothing else under
# `daemon/`, so `node_modules` comes from this image and must land beside them
# — which makes this path the same variable the mounts take.
ARG CURIA_REPO_ROOT
# Its own layer, keyed on the two pin files: a code-only deploy rebuilds this
# image without re-running the install.
WORKDIR $CURIA_REPO_ROOT/daemon
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --ignore-scripts \
  && chown -R 1000:1000 "$CURIA_REPO_ROOT"

# ---------------------------------------------------------------------------
# The release image (#869). Last, so a build that names no target builds it.
#
# The app reads the daemon's modules, the shipped configuration, and the
# lifecycle interface's source (#866). It reads no skill and no agent recipe,
# so neither is here. Root-owned and world-readable, read-only to the operator
# that runs it; the process writes under HOME only.
FROM toolchain AS release

WORKDIR /opt/curia/daemon
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --ignore-scripts \
  && npm cache clean --force
COPY daemon/src ./src
COPY daemon/bin ./bin
COPY daemon/assets ./assets
COPY cli/src /opt/curia/cli/src
COPY config/curia.yaml config/routing.yaml /opt/curia/config/

LABEL org.opencontainers.image.title="curia dashboard" \
      org.opencontainers.image.source="https://github.com/alp82/curia" \
      org.opencontainers.image.description="The Curia app: the console beside the service."

# The dashboard sidecar image (#249, #260, stood up by #263). Secret-free: node
# plus the tailscale CLI — the sidecar asserts its own Serve rule over the host
# tailscaled socket. No credentials on disk or in env.
#
# The CODE is not baked in. It runs from the repo mount, exactly as the daemon's
# does, so a deploy is a pull plus a restart. What IS baked in is the dependency
# tree, and that is deliberate: compose mounts `daemon/src`, `daemon/bin` and
# `daemon/assets` and nothing else under `daemon/`, because the two things it
# must NOT mount live beside them — `.env` holds the Discord token, and `data/`
# holds the journal the where-it-lives decision keeps daemon-private. So
# `node_modules` cannot come from the mount, and it comes from here.
#
# It installs the DAEMON's own pinned tree rather than a hand-listed subset. The
# sidecar imports daemon modules, so a second pin here would be a second version
# of a module the two processes share. Today that tree is needed for one package
# (`yaml`, to read curia.yaml); the pin is what matters, not the count.

# No default: the pin is one version across every curia image, and it comes from
# the anchor in deploy/compose.yaml (#357, applied by #409).
ARG NODE_VERSION
ARG TAILSCALE_VERSION=v1.98.10

FROM tailscale/tailscale:${TAILSCALE_VERSION} AS tailscale

FROM node:${NODE_VERSION}-bookworm-slim

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale

# HOME for uid 1000 (see daemon Dockerfile).
RUN mkdir -p /home/alp && chown 1000:1000 /home/alp

# Its own layer, keyed on the two pin files: a code-only deploy rebuilds this
# image without re-running the install.
WORKDIR /home/alp/curia/daemon
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --ignore-scripts \
  && chown -R 1000:1000 /home/alp/curia

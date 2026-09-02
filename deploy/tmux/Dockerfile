# The shared tmux/ttyd image (#260, release stage by #869). Two services run it:
#
#   tmux — the server that holds the agent panes, parked on a `keeper`
#          session. It replaces the systemd unit's KillMode=process: a daemon
#          restart never touches it.
#   ttyd — the attach surface, `tmux attach` as a client over the shared
#          socket volume via daemon/bin/curia-attach.sh.
#
# Three stages, the same shape as the daemon image: `toolchain` is the two
# binaries and their libraries, `box` is the source deployment's image with the
# uid 1000 facts of that box, and `release` is the published image, which
# carries the attach script and the attach index at /opt/curia and assumes no
# uid.
#
# ttyd is pinned to the version the committed attach index was built from
# (daemon/assets/attach-index.html embeds that ttyd's whole client bundle —
# see daemon/bin/build-attach-index.mjs). Bump both together.

ARG DOCKER_CLI_VERSION=28.5.2
# A dated tag, so the distro moves by a commit and never by a rebuild.
ARG DEBIAN_TAG=bookworm-20260824-slim

FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

FROM debian:${DEBIAN_TAG} AS toolchain
ARG TTYD_VERSION=1.7.7

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux bash curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /usr/local/bin/ttyd \
    "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
  && chmod +x /usr/local/bin/ttyd

# Panes run `docker run` for sandboxed agents, against host dockerd.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

# ---------------------------------------------------------------------------
# The source deployment's image. deploy/compose.yaml builds this stage.
FROM toolchain AS box

# Seed the tmux socket volume dir with the right owner (see daemon Dockerfile).
RUN mkdir -p /run/curia-tmux && chown 1000:1000 /run/curia-tmux

# The services run as uid 1000, and tmux looks the user up for its default
# shell — debian-slim has no uid 1000 entry, so give it one, homed where the
# compose mounts sit. That home is curia's own now, `home/` inside the workspace
# root, and compose passes the same path it sets on the container (#473). The
# workspace mount covers it here, so a pane agent reads the credential store the
# daemon points it at. No default: an empty arg fails the `mkdir` below.
ARG CURIA_HOME
RUN useradd -u 1000 -d "$CURIA_HOME" -M -s /bin/bash curia \
  && mkdir -p "$CURIA_HOME" && chown 1000:1000 "$CURIA_HOME"

# ---------------------------------------------------------------------------
# The release image (#869). Last, so a build that names no target builds it.
#
# No user entry: the operator's uid is a run-time fact, and tmux with no passwd
# entry falls back to /bin/sh for its default shell, which the panes never use
# (every pane runs the command the service hands it). HOME comes from the
# bundle, at `cache/home` inside the installation root.
FROM toolchain AS release

# The socket directory the tmux volume copies on first use, writable by any uid
# with the sticky bit (#851).
RUN mkdir -p /run/curia-tmux && chmod 1777 /run/curia-tmux

# What the attach surface runs and serves: the whitelist wrapper and the built
# attach index. The same paths the bundle's ttyd command names.
COPY daemon/bin/curia-attach.sh /opt/curia/daemon/bin/curia-attach.sh
COPY daemon/assets/attach-index.html /opt/curia/daemon/assets/attach-index.html

LABEL org.opencontainers.image.title="curia tmux" \
      org.opencontainers.image.source="https://github.com/alp82/curia" \
      org.opencontainers.image.description="The Curia tmux runtime and attach surface." \
      curia.ttyd-version="${TTYD_VERSION}"

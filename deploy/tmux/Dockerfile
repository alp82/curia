# The shared tmux/ttyd image (#260). Two services run it:
#
#   tmux — the server that holds the agent panes, parked on a `keeper`
#          session. It replaces the systemd unit's KillMode=process: a daemon
#          restart never touches it.
#   ttyd — the attach surface, `tmux attach` as a client over the shared
#          socket volume via daemon/bin/curia-attach.sh (from the repo mount).
#
# ttyd is pinned to the version the committed attach index was built from
# (daemon/assets/attach-index.html embeds that ttyd's whole client bundle —
# see daemon/bin/build-attach-index.mjs). Bump both together.

ARG DOCKER_CLI_VERSION=28

FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

FROM debian:bookworm-slim
ARG TTYD_VERSION=1.7.7

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux bash curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /usr/local/bin/ttyd \
    "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
  && chmod +x /usr/local/bin/ttyd

# Panes run `docker run` for sandboxed agents, against host dockerd.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

# Seed the tmux socket volume dir with the right owner (see daemon Dockerfile).
RUN mkdir -p /run/curia-tmux && chown 1000:1000 /run/curia-tmux

# The services run as uid 1000, and tmux looks the user up for its default
# shell — debian-slim has no uid 1000 entry, so give it one, homed where the
# compose mounts sit.
RUN useradd -u 1000 -d /home/alp -M -s /bin/bash curia \
  && mkdir -p /home/alp && chown 1000:1000 /home/alp

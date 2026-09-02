# The overseer image (#327, building the service [ADR-0015](../../docs/adr/0015-the-overseer-is-a-service.md)
# decided; release stage by #869). One long-lived container beside the
# dashboard, and many conversations pass through it.
#
# ITS OWN IMAGE, NOT THE AGENT IMAGE. The agent image already carries git, gh
# and both harnesses, so reuse was the obvious move. Its tag is a CONTENT
# ADDRESS over the Dockerfile bytes and the pins (daemon/src/image.mjs), and the
# rebuild path of ADR-0012 depends on that: one line added there names a tag no
# box has, and every agent image rebuilds on the next dispatch. The overseer
# also needs none of codex, playwright, tmux or ttyd, and it needs two things
# the agent image must never carry — the read-only token routing below.
#
# WHAT THE SHELL ADMITS. ADR-0014 moved the overseer here to give it a shell,
# and this file is what that shell holds:
#
#   git, gh          — the checkouts of #312 and the tracker
#   ripgrep, jq      — how a shell reads a tree and a JSON answer
#   less, procps     — what makes an interactive shell usable
#   curl             — how the turn reaches the daemon seam
#   node, npm        — the base image's own, because the host process is node
#
# Deliberately absent: build-essential, the chromium libraries, tmux, ttyd,
# codex, and any skill tree. The image installs NO repository dependency and
# runs NO test suite. So the overseer cannot answer "does this test pass" — that
# stays an agent's job, and the overseer dispatches one. What it can do is read
# every watched repo at every ref, which is what ADR-0014 asked for.
#
# Three stages, the same shape as the daemon image: `toolchain` is the shell
# and the harness, `box` is the source deployment's image (the code runs from
# the repo mount, the dependency tree is baked in for the reason the dashboard
# states), and `release` is the published image with the code at /opt/curia.

# No default: the pin is one version across every curia image, and it comes
# from config/curia.yaml through the anchor in deploy/compose.yaml on the box
# and deploy/bundle/pins.mjs in a release (#357, applied by #409).
ARG NODE_VERSION
ARG GH_VERSION=2.97.0
ARG CLAUDE_VERSION

FROM node:${NODE_VERSION}-bookworm-slim AS toolchain
ARG GH_VERSION
ARG CLAUDE_VERSION

# The shell is a human-facing surface through the chat, and a tree read with a
# broken locale answers in question marks.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git jq less procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Debian ships a 2023 gh; pinned from the upstream release instead, the same
# rule and the same version the daemon and agent images pin.
#
# The real binary lands OUT OF PATH, under libexec: the name `gh` on PATH is the
# shim below, and a shell that found the real one first would reach GitHub with
# whatever GH_TOKEN it happened to hold.
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /tmp \
  && install -D -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/libexec/curia/gh \
  && rm -rf /tmp/gh_* \
  && /usr/local/libexec/curia/gh --version

# The shared service hosts each live conversation as one Claude Code process.
# Keep the CLI pinned to the agent image's version through compose.
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
  && npm cache clean --force \
  && claude --version

# THE PER-OWNER TOKEN ROUTING, half one (#313). The container holds one
# read-only token per resource owner and `gh` reads a single GH_TOKEN, so the
# shim picks the owner off the command line and execs the real binary.
#
# Half two is git's, and it is not here: one
# `credential.https://github.com/<owner>.helper` line per owner routes every
# clone and fetch, written at start by daemon/src/overseercreds.mjs, because the
# owners come from the watch list and the watch list is not a build input.
COPY deploy/overseer/gh-shim.sh /usr/local/bin/gh
RUN chmod 0755 /usr/local/bin/gh

# The SDK checks for a newer self on start. The image is the pin, and this
# container is recreated by a deploy, never by an update it decided itself.
ENV DISABLE_AUTOUPDATER=1

# ---------------------------------------------------------------------------
# The source deployment's image. deploy/compose.yaml builds this stage.
FROM toolchain AS box

# THE BAKED DEPENDENCY TREE HAS TO SIT WHERE THE REPO MOUNTS (#473), the same
# reason the dashboard image states. So this path is the variable the mounts
# take, and it carries no default: an empty arg fails the chown below rather
# than baking a tree the mounts miss.
ARG CURIA_REPO_ROOT
# Its own layer, keyed on the two pin files: a code-only deploy rebuilds this
# image without re-running the install. The daemon's own pinned tree, not a
# hand-listed subset — this process imports daemon modules, and a second pin
# would be a second version of a module the two share.
WORKDIR $CURIA_REPO_ROOT/daemon
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --ignore-scripts \
  && chown -R 1000:1000 "$CURIA_REPO_ROOT"

# HOME is `home/` inside the workspace root, and compose sets the same path it
# passes here (#473). This container mounts three subtrees of the workspace and
# never the tree itself, so the directory this line makes is the one the process
# runs on. It must exist writable for uid 1000: the per-owner git config is
# written there at every start, and a container-local write beside the mounts
# would otherwise fail with EACCES.
ARG CURIA_HOME
RUN mkdir -p "$CURIA_HOME" && chown 1000:1000 "$CURIA_HOME"

LABEL org.opencontainers.image.title="curia overseer" \
      org.opencontainers.image.source="https://github.com/alp82/curia" \
      curia.gh-version="${GH_VERSION}"

# ---------------------------------------------------------------------------
# The release image (#869). Last, so a build that names no target builds it.
#
# The overseer reads the daemon's modules, the seed's assets (`voice.md`, #314),
# the shipped configuration, and the lifecycle interface's source (#866). The
# per-owner git config lands under HOME, which the bundle sets to `cache/home`
# inside the installation root. Root-owned and world-readable, read-only to the
# operator that runs it.
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

LABEL org.opencontainers.image.title="curia overseer" \
      org.opencontainers.image.source="https://github.com/alp82/curia" \
      org.opencontainers.image.description="The Curia overseer: one shell-holding container that every conversation passes through." \
      curia.gh-version="${GH_VERSION}"

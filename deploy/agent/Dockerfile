# The shared curia agent image (#154), built from the sandbox decision (#148).
#
#     npm run build-agent-image --prefix daemon
#
# One image serves every agent. The per-ticket difference is what the daemon
# mounts and passes in (#156), never a per-agent build: a build per dispatch
# would put a network fetch and two npm installs on the dispatch path.
#
# Kept to the classic builder on purpose — the box runs docker 20.10, where
# BuildKit is not the default. No heredocs, no `RUN --mount`, no `COPY --link`.
#
# Nothing is COPYed, so the build context is this directory and it stays empty
# of content. See daemon/src/image.mjs for the context and the tag.

# Every version is a build ARG with NO default. An unpinned CLI in an agent
# image is the failure this ticket exists to prevent: the pins live in
# config/curia.yaml under `sandbox`, and they feed the image tag, so a bump
# there names a tag that is not on the box and the daemon rebuilds.
#
# NODE_VERSION joined that set at #409, from the ruling at #357. This image ran
# `FROM node:lts-slim` and served whatever Node that tag pointed at, while the
# other three images pinned one. The daemon suite runs in here, so the suite
# that must prove a Node upgrade ran on a Node nobody pinned. The distro is
# named too, as `-bookworm-slim`, so a new Debian arrives by a commit and not by
# a rebuild. The other three images name it the same way.
ARG NODE_VERSION

FROM node:${NODE_VERSION}-bookworm-slim

ARG CLAUDE_VERSION
ARG CODEX_VERSION
ARG GH_VERSION
ARG PLAYWRIGHT_VERSION
ARG TTYD_VERSION
# The agent uid must match the host user that owns the mounted clone and cfg
# dir, or the agent cannot write its own worktree. The box runs the daemon as
# uid 1000 (`alp`).
ARG AGENT_UID=1000

# TUIs draw box characters. A container with no LANG lays them out as question
# marks, and both harnesses are TUIs.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive

# git, gh, curl, ripgrep and build essentials are the set #148 named. procps
# and less are what make an interactive shell usable (`ps`, the git pager);
# ca-certificates is what makes every https fetch below work at all. tmux is
# for the daemon's own test suite (#231): without it, three describes in
# tmux.test.mjs — the #141 wedged-tmux classification guard — skip in every
# agent container. sqlite3 is there for the same reason (#409): the daemon
# suite runs in this image, and the backup (#436) spawns the binary. The daemon
# image carries it for the backup itself. Unpinned like the rest of the apt set.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      less \
      procps \
      python3 \
      ripgrep \
      sqlite3 \
      tmux; \
    rm -rf /var/lib/apt/lists/*

# gh from the upstream release, not from apt: Debian 12 ships gh 2.23 (2023),
# three years behind the gh a hand session on this box runs. An agent and a
# hand session must speak the same tracker CLI, so this one is pinned too.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL -o /tmp/gh.tgz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${arch}"; \
    gh --version

# ttyd, also for the daemon's test suite (#231): attach.test.mjs reads the
# real binary's `--version` output, and skips wherever TTYD_BIN is absent.
# The release ships a static binary named by uname arch, not dpkg arch.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) ttyd_arch=x86_64 ;; \
      arm64) ttyd_arch=aarch64 ;; \
      *) echo "no ttyd release asset for this arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}"; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version
ENV TTYD_BIN=/usr/local/bin/ttyd

# Both harnesses, at the exact versions the box runs. The npm cache from this
# layer is dropped rather than left in the image: the run-time cache is a
# mounted volume, and a stale copy baked at build time only costs size.
RUN set -eux; \
    npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}"; \
    npm cache clean --force

# Chromium's OS libraries, but not chromium. #148 keeps browsers out of the
# image and installs them on demand into the shared volume. The libraries
# cannot follow that rule: `playwright install` runs as the agent, and the
# `--with-deps` half of it is apt-get, which needs root the agent does not
# have. Without this an on-demand chromium installs and then fails to launch.
RUN set -eux; \
    npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium; \
    rm -rf /var/lib/apt/lists/* /root/.npm

# The agent user (#148: Claude Code refuses to run as root, and root is the
# escape surface worth removing anyway). The node base image already holds uid
# 1000 as `node`, so the normal path renames it rather than adding a second user.
RUN set -eux; \
    at_uid="$(getent passwd "${AGENT_UID}" | cut -d: -f1 || true)"; \
    if [ -n "${at_uid}" ]; then \
      groupmod -n agent "$(id -gn "${at_uid}")"; \
      usermod -l agent -d /home/agent -m "${at_uid}"; \
    else \
      groupadd -g "${AGENT_UID}" agent; \
      useradd -u "${AGENT_UID}" -g agent -m -s /bin/bash agent; \
    fi; \
    chsh -s /bin/bash agent; \
    id agent

# The two shared cache volumes (#148). They are declared here so an empty
# volume inherits the agent ownership on first mount, and named in labels so
# the run side (#156) reads the paths off the image instead of repeating them.
ENV NPM_CONFIG_CACHE=/cache/npm \
    PLAYWRIGHT_BROWSERS_PATH=/cache/playwright-browsers
RUN set -eux; \
    mkdir -p /cache/npm /cache/playwright-browsers /workspace; \
    chown -R agent:agent /cache /workspace

# The kill guard's login-shell half (#385). The guard itself is written by the
# daemon into the mounted config dir (`/cfg/bin`, see daemon/src/sandbox.mjs):
# BASH_ENV covers every non-interactive bash, but `bash -lc` — the codex tool
# shell — reads /etc/profile instead of BASH_ENV, so the same two lines land in
# profile.d. Both are guarded on the mount, so the image still works with no
# /cfg at all (the daemon's own test suite runs in here, #231/#409). Written
# inline rather than COPYed, so the build context stays empty of content and
# the guard rides the image digest with the rest of the Dockerfile.
RUN printf '%s\n' \
      'if [ -d /cfg/bin ]; then case ":$PATH:" in *":/cfg/bin:"*) ;; *) PATH="/cfg/bin:$PATH" ;; esac; fi' \
      'if [ -x /cfg/bin/kill ]; then kill() { /cfg/bin/kill "$@"; }; fi' \
      > /etc/profile.d/curia-kill-guard.sh

# Both CLIs check for a newer self on start. The image IS the pin, and an
# updated CLI inside a container that dies with its ticket is a download the
# next agent repeats.
ENV DISABLE_AUTOUPDATER=1

LABEL org.opencontainers.image.title="curia agent" \
      org.opencontainers.image.source="https://github.com/alp82/curia" \
      curia.claude-version="${CLAUDE_VERSION}" \
      curia.codex-version="${CODEX_VERSION}" \
      curia.gh-version="${GH_VERSION}" \
      curia.ttyd-version="${TTYD_VERSION}" \
      curia.playwright-version="${PLAYWRIGHT_VERSION}" \
      curia.npm-cache="/cache/npm" \
      curia.browsers="/cache/playwright-browsers" \
      curia.workdir="/workspace"

USER agent
WORKDIR /workspace
CMD ["bash"]

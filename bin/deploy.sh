#!/usr/bin/env bash
# Deploy curia to the Hetzner box. Run from any machine with ssh access.
# See docs/deploy.md.
#
# The deploy names ONLY `daemon dashboard overseer`. Never widen it to a bare
# `docker compose up -d`: that recreates a changed `tmux` service, and a
# recreated tmux service kills every live agent (wayfinder #132 in compose
# clothes). Recreating tmux/ttyd is a deliberate act at zero live agents.
# Recreating the overseer kills no agent, so it joined the list with #327.
set -euo pipefail

HOST="${CURIA_DEPLOY_HOST:-alp@coinmatica.net}"

ssh "$HOST" 'set -euo pipefail
cd ~/curia
git pull --ff-only
# The overseer bind-mount sources, before compose can create them as root
# (alp82/curia#474). The path comes from the committed config, so the two
# stay one fact.
WORK=$(awk "/^ *workspace_root:/ {print \$2; exit}" config/curia.yaml)
mkdir -p "$WORK/cfg/curia-overseer" "$WORK/overseer/repos"
# --force-recreate: code runs from the repo mount, so a code-only deploy
# changes no image layer, and without the flag compose leaves the old
# daemon running (#270).
docker compose -f deploy/compose.yaml up -d --build --force-recreate --no-deps daemon dashboard overseer
sleep 3
docker compose -f deploy/compose.yaml ps daemon dashboard overseer'

echo "deployed: $HOST"

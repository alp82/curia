#!/usr/bin/env bash
# Deploy curia to the Hetzner box. Run from any machine with ssh access.
# See docs/deploy.md.
#
# The deploy names ONLY `daemon dashboard`. Never widen it to a bare
# `docker compose up -d`: that recreates a changed `tmux` service, and a
# recreated tmux service kills every live agent (wayfinder #132 in compose
# clothes). Recreating tmux/ttyd is a deliberate act at zero live agents.
set -euo pipefail

HOST="${CURIA_DEPLOY_HOST:-alp@coinmatica.net}"

ssh "$HOST" 'set -euo pipefail
cd ~/curia
git pull --ff-only
# --force-recreate: code runs from the repo mount, so a code-only deploy
# changes no image layer, and without the flag compose leaves the old
# daemon running (#270).
docker compose -f deploy/compose.yaml up -d --build --force-recreate --no-deps daemon dashboard
sleep 3
docker compose -f deploy/compose.yaml ps daemon dashboard'

echo "deployed: $HOST"

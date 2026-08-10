#!/usr/bin/env bash
# The self-deploy sibling (#270). The daemon starts this in a detached
# container (`curia-deploy`, on the curia-daemon image) and then dies when
# compose recreates it — this script is the process that survives the deploy.
#
# It fast-forwards the checkout, recreates `daemon dashboard`, and
# health-checks the successor. On a failed health check it resets the checkout
# to the previous ref and recreates again, so a deploy that ships a
# crash-looping daemon rolls itself back with no ssh in the loop.
#
# THE DEPLOY RULE OUTRANKS EVERYTHING HERE: every `up` names its targets with
# --no-deps. A bare `docker compose up -d` recreates a changed `tmux` service,
# and a recreated tmux service kills every live agent (wayfinder #132 in
# compose clothes). deploy.test.mjs pins this file to the rule.
#
# argv: prev next repoRoot markerFile logFile port
set -uo pipefail
PREV=$1 NEXT=$2 REPO=$3 MARKER=$4 LOG=$5 PORT=$6
exec >>"$LOG" 2>&1

say() { echo "[self-deploy $(date -u +%FT%TZ)] $*"; }

# The marker is the contract with the surviving daemon: resolvePending() polls
# it until a terminal state (landed | rolled-back | lockout) and announces it.
# All values are shas and fixed words, so printf-JSON is safe.
mark() {
  printf '{"state":"%s","prev":"%s","next":"%s","reason":"%s","ts":"%s"}\n' \
    "$1" "$PREV" "$NEXT" "${2:-}" "$(date -u +%FT%TZ)" >"$MARKER.tmp" \
    && mv "$MARKER.tmp" "$MARKER"
}

recreate() {
  docker compose -f "$REPO/deploy/compose.yaml" up -d --build --no-deps daemon dashboard
}

# Up means: /ping answers on host loopback, still answers 10s later, and the
# NEW daemon container has never been restarted. The last check is what
# catches a daemon that listens and then dies — on-failure respawns it, and
# RestartCount counts each death.
healthy() {
  local deadline=$(( $(date +%s) + $1 ))
  until curl -fsS -m 2 "http://127.0.0.1:$PORT/ping" >/dev/null; do
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 3
  done
  sleep 10
  curl -fsS -m 2 "http://127.0.0.1:$PORT/ping" >/dev/null || return 1
  local restarts
  restarts=$(docker inspect -f '{{.RestartCount}}' curia-daemon-1 2>/dev/null) || return 1
  [ "$restarts" -eq 0 ]
}

say "deploy $PREV -> $NEXT"
mark deploying
if git -C "$REPO" merge --ff-only "$NEXT" && recreate && healthy 180; then
  mark landed
  say "landed $NEXT"
  exit 0
fi

say "health check failed — rolling back to $PREV"
mark rolling-back
git -C "$REPO" reset --hard "$PREV"
if recreate && healthy 180; then
  mark rolled-back "the new daemon failed its health check"
  say "rolled back to $PREV"
  exit 0
fi

mark lockout "the rollback health check failed too"
say "LOCKOUT: rollback to $PREV did not come up either"
exit 1

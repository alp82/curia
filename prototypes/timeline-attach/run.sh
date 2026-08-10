#!/usr/bin/env bash
# PROTOTYPE (#73) — one command to put the timeline surface on the tailnet
# beside the existing ttyd attach page, with a real Claude Code worker running
# under a real per-worker CLAUDE_CONFIG_DIR to look at.
#
# Throwaway. It touches nothing the daemon owns: its own port, its own Serve
# rule, its own tmux session, its own config dir under the workspace root.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${CURIA_WORKSPACE:-/home/alp/curia-work}"
SESSION="${SESSION:-curia-lab}"
PORT="${TIMELINE_PORT:-4272}"
SERVE_PORT="${TIMELINE_SERVE_PORT:-8444}"   # NOT 8443 (attach) and NOT 8500-8599 (previews)
ATTACH_SERVE_PORT="${ATTACH_SERVE_PORT:-8443}"
CFG="$WORKSPACE/cfg/$SESSION"
LAB="$WORKSPACE/lab-timeline"
MODEL="${MODEL:-sonnet}"

stop() {
  pkill -f "$HERE/server.mjs" 2>/dev/null || true
  tailscale serve "--https=$SERVE_PORT" off 2>/dev/null || true
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
  echo "timeline server down, serve rule on :$SERVE_PORT withdrawn, $SESSION gone"
  echo "(the lab config dir $CFG and $LAB are left in place — rm them by hand)"
}

if [[ "${1:-}" == "--stop" ]]; then stop; exit 0; fi

# --- the lab worker -----------------------------------------------------------
# Shaped exactly like a curia worker (#23/#29/#53): its own CLAUDE_CONFIG_DIR,
# the host's credential store shared rather than copied, onboarding pre-seeded
# so no first-spawn dialog appears. It is NOT dispatched by the daemon — no
# ticket is claimed, no MCP side channel, no Stop hook. The transcript it writes
# is the same artifact either way, which is the point being tested.
mkdir -p "$CFG" "$LAB"
[[ -d "$LAB/docs" ]] || cp -r "$HERE/../../docs" "$LAB/docs"

python3 - "$CFG" "$LAB" <<'PY'
import json, sys, os
cfg, wt = sys.argv[1], sys.argv[2]
json.dump({
    "hasCompletedOnboarding": True, "installMethod": "native", "autoUpdates": False,
    "theme": "dark", "numStartups": 1,
    "projects": {wt: {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True,
                      "hasClaudeMdExternalIncludesApproved": True,
                      "hasClaudeMdExternalIncludesWarningShown": True}},
}, open(os.path.join(cfg, ".claude.json"), "w"), indent=2)
json.dump({"skipDangerousModePermissionPrompt": True}, open(os.path.join(cfg, "settings.json"), "w"), indent=2)
PY

cat >"$CFG/prompt.txt" <<EOF
You are a lab worker for a curia prototype. Work ONLY inside $LAB, never outside it.

Task: read the markdown files under ./docs/research one at a time, and append a
one-paragraph note about each to ./notes.md. Before each file, say in one line
what you are about to do. Do them one at a time and do not batch. After five
files, stop and ask me which one to do next.

Two people are watching this session from two devices and either of them may
type at you. Whatever either says, take it.
EOF

if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
  # The same argv shape as the real claude harness (config/routing.yaml).
  tmux new-session -d -s "$SESSION" -c "$LAB" env \
    "CLAUDE_CONFIG_DIR=$CFG" \
    "CLAUDE_SECURESTORAGE_CONFIG_DIR=$HOME/.claude" \
    bash -c "claude --model $MODEL --permission-mode bypassPermissions \"\$(cat '$CFG/prompt.txt')\"; exec bash"
  echo "spawned lab worker in tmux session $SESSION (model $MODEL)"
fi

# --- the surface --------------------------------------------------------------
pkill -f "$HERE/server.mjs" 2>/dev/null || true
sleep 0.2
CURIA_WORKSPACE="$WORKSPACE" TIMELINE_PORT="$PORT" \
  setsid node "$HERE/server.mjs" >"$HERE/server.log" 2>&1 &
sleep 0.6

tailscale serve --bg "--https=$SERVE_PORT" "http://127.0.0.1:$PORT" >/dev/null
BASE="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

cat <<EOF

open BOTH of these, on a real phone and on the desktop, at the same time:

  timeline   https://$BASE:$SERVE_PORT/?session=$SESSION
  terminal   https://$BASE:$ATTACH_SERVE_PORT/?arg=$SESSION      (today's surface, for comparison)

stop with: $0 --stop
server log: $HERE/server.log
EOF

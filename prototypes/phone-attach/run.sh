#!/usr/bin/env bash
# Spike #32: browser-terminal phone attach on the lean substrate.
# Stands up: tmux session "curia-worker" running a live Claude Code TUI,
# fronted by ttyd on 127.0.0.1:7681 (expose via `tailscale serve`).
#
# Usage:
#   ./run.sh <path-to-ttyd> [workspace-dir]
#   ./run.sh --stop
set -euo pipefail

SESSION=curia-worker
PORT=7681

if [[ "${1:-}" == "--stop" ]]; then
  pkill -f "ttyd.*tmux attach.*$SESSION" || true
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "stopped"
  exit 0
fi

TTYD="${1:?usage: run.sh <path-to-ttyd> [workspace-dir]}"
WS="${2:-$PWD}"

# 1. Worker session: real Claude Code TUI inside tmux (survives ttyd restarts).
#    has-session guard, not `new-session -A`: with an existing session -A turns
#    into attach-session, which blocks (tty) or dies (no tty) — never detaches.
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -c "$WS" \
    "claude; exec bash"   # drop to a shell if claude exits, so the pane survives
fi

# Refuse to double-start ttyd (port 7681 would collide).
if pgrep -f "ttyd.*tmux attach.*$SESSION" >/dev/null; then
  echo "ttyd already running for $SESSION — ./run.sh --stop first" >&2
  exit 1
fi

# 2. Browser terminal. -W = writable. Each browser client runs its own
#    `tmux attach`, so all clients (plus any SSH attach) share one PTY,
#    tmux-style interleave. Bound to localhost: expose with
#    `tailscale serve --bg --https=8443 http://127.0.0.1:7681`
exec "$TTYD" -W -p "$PORT" -i 127.0.0.1 \
  -t fontSize=15 -t 'theme={"background":"#0e0e0e"}' \
  tmux attach -t "$SESSION"

#!/usr/bin/env bash
# PROTOTYPE (#69) — one command to put the three attach-surface variants on the
# real attach URL. Throwaway: it restarts the shared ttyd with a custom index
# and puts the stock one back on --stop.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TTYD="${TTYD_BIN:-$HOME/.local/bin/ttyd}"
WRAPPER="$ROOT/daemon/bin/curia-attach.sh"
PORT="${TTYD_PORT:-7681}"
SERVE_PORT="${SERVE_PORT:-8443}"
SESSION="${SESSION:-curia-69}"
INDEX="$HERE/index-proto.html"

kill_ttyd() {
  pkill -f "$TTYD .*-p $PORT " 2>/dev/null || true
  pkill -f "$TTYD -W -a -O -p $PORT" 2>/dev/null || true
  for _ in $(seq 20); do
    ss -ltn "sport = :$PORT" | grep -q LISTEN || return 0
    sleep 0.1
  done
}

if [[ "${1:-}" == "--stop" ]]; then
  kill_ttyd
  # put the daemon's exact argv back so a later reconcile adopts it as verified
  setsid "$TTYD" -W -a -O -p "$PORT" -i 127.0.0.1 "$WRAPPER" >/dev/null 2>&1 &
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "stock ttyd restored on :$PORT; demo session $SESSION gone"
  exit 0
fi

# 1. stock index -> prototype index
curl -sf "http://127.0.0.1:$PORT/" -o "$HERE/index-orig.html" || {
  echo "no ttyd on :$PORT to copy the stock index from — start one first"; exit 1; }
"$HERE/build-index.py" "$HERE/index-orig.html" "$INDEX"

# 2. a session worth watching: a real TUI beats a bare shell for judging chrome
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -c "$ROOT"
  tmux send-keys -t "$SESSION" \
    "git -C '$ROOT' log --stat -25 | head -200; echo; command -v claude >/dev/null && claude || exec \$SHELL" C-m
  echo "created tmux session $SESSION"
fi

# 3. same hardened flags the daemon asserts, plus the custom index and a
#    renderer that actually draws. ttyd defaults to rendererType=webgl, which
#    renders NOTHING in Firefox — socket open, grid sized, theme applied, blank
#    screen, no console error. Verified against the STOCK ttyd index, so it is
#    ttyd's default and not this chrome. Append &rendererType=webgl to compare.
kill_ttyd
setsid "$TTYD" -W -a -O -p "$PORT" -i 127.0.0.1 \
  -t rendererType=dom -I "$INDEX" "$WRAPPER" >/dev/null 2>&1 &
sleep 0.6

# 4. the Serve rule the daemon reasserts on reconcile
tailscale serve --bg "--https=$SERVE_PORT" "http://127.0.0.1:$PORT" >/dev/null
BASE="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

echo
echo "open on BOTH a phone and the desktop:"
for v in A B C; do
  echo "  $v  https://$BASE:$SERVE_PORT/?arg=$SESSION&variant=$v"
done
echo
echo "the switcher pill at the bottom cycles A/B/C; stop with: $0 --stop"

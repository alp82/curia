#!/usr/bin/env bash
# Does the WRITE path need a geometry? Drive a tmux session that has zero
# attached clients, and check what the program at the other end receives.
# This is the measurement leg 3's recommendation rests on.
set -u
S=/tmp/curia-probe-inject
OUT=/tmp/curia-probe-out.txt
tmux -S $S kill-server 2>/dev/null; sleep 0.2
rm -f $OUT

# curia's own newSession shape: -d, no -x/-y (daemon/src/tmux.mjs:66-71)
tmux -S $S new-session -d -s curia-x "cat > $OUT"
echo -n "attached clients: "; tmux -S $S list-clients 2>/dev/null | wc -l
echo -n "window size with zero clients: "; tmux -S $S display -p -t curia-x: '#{window_width}x#{window_height}'
echo -n "global default-size: "; tmux -S $S show-options -g default-size

tmux -S $S send-keys -t curia-x "hello from a client-less write path" Enter
sleep 0.5
tmux -S $S send-keys -t curia-x C-d
sleep 0.5
echo "what the program received: $(cat $OUT)"

tmux -S $S kill-server 2>/dev/null; rm -f $OUT

#!/usr/bin/env bash
# Two clients of different geometry on ONE tmux session, measured on tmux 3.7b.
# The "terminals" are two outer tmux sessions of fixed size, each hosting one
# inner client -- the same rig #71 used, so the numbers are comparable.
set -u
O=/tmp/curia-probe-outer
I=/tmp/curia-probe-inner
tmux -S $O kill-server 2>/dev/null
tmux -S $I kill-server 2>/dev/null
sleep 0.3

# outer "devices"
tmux -S $O new-session -d -s pc    -x 159 -y 72
tmux -S $O new-session -d -s phone -x 47  -y 49

# the shared worker session
tmux -S $I new-session -d -s work -x 100 -y 30 'cat'

report () {
  echo "=== $1"
  echo -n "  window: "; tmux -S $I display -p -t work '#{window_width}x#{window_height}'
  echo    "  clients:"
  tmux -S $I list-clients -F '    #{client_name} #{client_width}x#{client_height} flags=#{client_flags}'
}

report "before any client attaches"

# attach the PC
tmux -S $O send-keys -t pc "tmux -S $I attach -t work" Enter
sleep 1
report "PC attached (159x72)"

# attach the phone
tmux -S $O send-keys -t phone "tmux -S $I attach -t work" Enter
sleep 1
report "phone attached too (47x49), window-size=latest (default)"

for m in largest smallest manual; do
  tmux -S $I set-option -t work window-size $m
  if [ "$m" = manual ]; then tmux -S $I resize-window -t work -x 100 -y 30; fi
  sleep 0.6
  report "window-size=$m"
done

tmux -S $I set-option -t work window-size latest
sleep 0.4

# can refresh-client -C hold two different sizes at once?
echo "=== refresh-client -C per client"
for c in $(tmux -S $I list-clients -F '#{client_name}'); do
  case "$c" in *pc*|*0) tmux -S $I refresh-client -C 159x72 -t "$c" 2>&1 ;; esac
done
first=$(tmux -S $I list-clients -F '#{client_name}' | head -1)
second=$(tmux -S $I list-clients -F '#{client_name}' | tail -1)
tmux -S $I refresh-client -C 159x72 -t "$first" 2>&1
tmux -S $I refresh-client -C 47x49  -t "$second" 2>&1
sleep 0.6
report "after refresh-client -C 159x72 on one client and 47x49 on the other"

# grouped sessions: a second session sharing the window list
echo "=== grouped session (new-session -t work)"
tmux -S $I new-session -d -s grouped -t work -x 47 -y 49 2>&1
sleep 0.4
echo -n "  work window:    "; tmux -S $I display -p -t work    '#{window_width}x#{window_height}'
echo -n "  grouped window: "; tmux -S $I display -p -t grouped '#{window_width}x#{window_height}'

# does the PTY itself carry one size? ask the process
echo "=== the pty the program sees"
tmux -S $I display -p -t work 'pane_width=#{pane_width} pane_height=#{pane_height} pane_tty=#{pane_tty}'

tmux -S $O kill-server 2>/dev/null
tmux -S $I kill-server 2>/dev/null

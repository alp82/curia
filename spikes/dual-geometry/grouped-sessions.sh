#!/usr/bin/env bash
# Grouped sessions, measured cleanly: one window list, two sessions, one client
# of a different size on each. Does the SHARED window hold two sizes?
set -u
O=/tmp/curia-probe-outer
I=/tmp/curia-probe-inner
tmux -S $O kill-server 2>/dev/null; tmux -S $I kill-server 2>/dev/null; sleep 0.3

tmux -S $O new-session -d -s pc    -x 159 -y 72
tmux -S $O new-session -d -s phone -x 47  -y 49

tmux -S $I new-session -d -s work -x 100 -y 30 'cat'
# session B shares session A's window list
tmux -S $I new-session -d -s mirror -t work

tmux -S $O send-keys -t pc    "tmux -S $I attach -t work"   Enter
sleep 1
tmux -S $O send-keys -t phone "tmux -S $I attach -t mirror" Enter
sleep 1

echo "=== grouped: PC on session 'work', phone on session 'mirror', one window list"
tmux -S $I list-clients -F '  client #{client_name} #{client_width}x#{client_height} session=#{client_session}'
echo -n "  window as seen from work:   "; tmux -S $I display -p -t work   '#{window_width}x#{window_height}'
echo -n "  window as seen from mirror: "; tmux -S $I display -p -t mirror '#{window_width}x#{window_height}'
echo -n "  window id work / mirror:    "; echo "$(tmux -S $I display -p -t work '#{window_id}') / $(tmux -S $I display -p -t mirror '#{window_id}')"
echo -n "  the pty the program sees:   "; tmux -S $I display -p -t work 'pane_width=#{pane_width} pane_height=#{pane_height} tty=#{pane_tty}'
tty=$(tmux -S $I display -p -t work '#{pane_tty}')
echo -n "  kernel winsize on that pty: "; stty -F "$tty" size 2>&1

echo "=== per-session window-size, if such a thing exists"
tmux -S $I set-option -t work   window-size largest
tmux -S $I set-option -t mirror window-size smallest
sleep 0.6
echo -n "  work:   "; tmux -S $I display -p -t work   '#{window_width}x#{window_height} (window-size=#{window-size})'
echo -n "  mirror: "; tmux -S $I display -p -t mirror '#{window_width}x#{window_height} (window-size=#{window-size})'

echo "=== unlinking: a SEPARATE window is the only way to get a second size"
tmux -S $I new-window -d -t mirror 2>&1 >/dev/null
sleep 0.5
tmux -S $O send-keys -t phone "" Enter
sleep 0.5
tmux -S $I list-windows -a -F '  #{session_name}:#{window_id} #{window_width}x#{window_height} panes=#{window_panes}'

tmux -S $O kill-server 2>/dev/null; tmux -S $I kill-server 2>/dev/null

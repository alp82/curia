#!/usr/bin/env bash
# Under `window-size largest`, what does the SMALL client actually see?
# #71 recorded "the phone sees the top-left corner of 159 columns". tmux's
# tty.c tracks a per-client offset instead, so the small client gets a
# pannable viewport that follows its own cursor. Measure which it is.
set -u
O=/tmp/curia-probe-outer
I=/tmp/curia-probe-inner
tmux -S $O kill-server 2>/dev/null; tmux -S $I kill-server 2>/dev/null; sleep 0.3

tmux -S $O new-session -d -s pc    -x 159 -y 72
tmux -S $O new-session -d -s phone -x 47  -y 49

tmux -S $I new-session -d -s work -x 100 -y 30 'cat'
tmux -S $I set-option -t work window-size largest

tmux -S $O send-keys -t pc    "tmux -S $I attach -t work" Enter; sleep 1
tmux -S $O send-keys -t phone "tmux -S $I attach -t work" Enter; sleep 1

echo "=== window-size=largest, two clients"
echo -n "  window: "; tmux -S $I display -p -t work: '#{window_width}x#{window_height}'
tmux -S $I list-clients -F '  client #{client_name} #{client_width}x#{client_height} offset=#{window_offset_x},#{window_offset_y}'

echo "=== is the small client's offset its own? pan it right and re-read"
small=$(tmux -S $I list-clients -F '#{client_width} #{client_name}' | sort -n | head -1 | cut -d' ' -f2)
big=$(tmux -S $I list-clients -F '#{client_width} #{client_name}' | sort -n | tail -1 | cut -d' ' -f2)
echo "  small=$small big=$big"
# -t BEFORE the adjustment: tmux stops option parsing at the first
# non-option argument, so `-R 40 -t <client>` is read as three stray args.
tmux -S $I refresh-client -t "$small" -R 40 2>&1
sleep 0.5
tmux -S $I list-clients -F '  client #{client_name} offset=#{window_offset_x},#{window_offset_y}'

tmux -S $O kill-server 2>/dev/null; tmux -S $I kill-server 2>/dev/null

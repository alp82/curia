#!/usr/bin/env bash
# ttyd wrapper (#30, prototype.md §2 — exact verified shape). ttyd runs with -a,
# so any tailnet client can append an arbitrary argument; serving `tmux attach -t`
# directly would hand out attach to ANY tmux session on the box. This whitelist
# is a hard requirement, not a nicety.
s="${1:-}"
if [[ ! "$s" =~ ^curia-[A-Za-z0-9._-]+$ ]]; then
  echo "refused: '$s' is not a curia session"; sleep 3; exit 1
fi
# #260: the tmux server lives in the `tmux` service; ttyd reaches it over the
# shared socket volume. Unset (dev box) means the default socket.
exec tmux ${CURIA_TMUX_SOCKET:+-S "$CURIA_TMUX_SOCKET"} attach -t "$s"

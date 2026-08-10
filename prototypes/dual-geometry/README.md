# dual-geometry probes

Measurement scripts behind [`docs/research/dual-geometry-attach.md`](../../docs/research/dual-geometry-attach.md)
([#72](https://github.com/alp82/curia/issues/72)). They answer one question:
can two clients of different size share one live terminal session?

Run them on the deployment host, so the numbers come from the tmux that actually
serves attach (`tmux 3.7b` at the time of writing). Each script kills and
recreates its own tmux servers on private sockets under `/tmp`, and touches no
`curia-*` session on the default socket.

| script | what it measures |
| --- | --- |
| `two-clients.sh` | every `window-size` value, and `refresh-client -C`, with a 159x71 client and a 47x48 client on one session |
| `grouped-sessions.sh` | whether grouped sessions give a shared window two sizes, and what `stty size` reports on the pane's own tty |
| `no-client-write.sh` | whether `send-keys` drives a session with zero attached clients — the write path leg 3 rests on |

The two "devices" are outer tmux sessions of fixed size, each hosting one inner
client. That is [#71](https://github.com/alp82/curia/issues/71)'s rig, kept so
the numbers are comparable with what it recorded.

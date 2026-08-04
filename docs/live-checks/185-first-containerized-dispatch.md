# Live check: the first live containerized dispatch (#185)

Ticket: [alp82/curia#185](https://github.com/alp82/curia/issues/185), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.net` (docker 20.10.17) on 2026-08-04, from a dev session.

Every part of the container path was measured on its own before this — the image
([#154](https://github.com/alp82/curia/issues/154)), the `docker run` line and the paths
([#156](https://github.com/alp82/curia/issues/156)), the token
([#155](https://github.com/alp82/curia/issues/155),
[#159](https://github.com/alp82/curia/issues/159)), the preview
([#157](https://github.com/alp82/curia/issues/157)). None of them together, on the box,
through Discord.

The box was pulled to `e68a6a4` and restarted, and one real ticket was dispatched:
[#179](https://github.com/alp82/curia/issues/179), the status-line model name.

**Result: the ticket went from dispatch to merge in a container, and the run found three
faults.** Two were fixed during it. One is not fixed and is the largest.

## What held

| Leg | Reading |
| --- | --- |
| Image build inside the dispatch | 2 m 05 s, announced in the thread |
| The tag is a content address | `curia-worker:2.1.220-0.146.0-c6c38f36` — the same string #154 and #181 recorded, rebuilt from scratch on a third occasion |
| Mounts | `/workspace` and `/cfg` writable, two cache volumes, nothing else |
| No host reach | `/var/run/docker.sock`, `/home/alp` and `/tmp/tmux-1000` all absent inside |
| uid | `agent` = 1000:1000, matching the clone's owner |
| Ports | `127.0.0.1:9000-9002` published, three per worker |
| `gh` as the agent | `github_pat_…AWE0` = `CURIA_AGENT_GH_TOKEN_ALP82`, sourced from `GH_TOKEN`; no `~/.config/gh` inside to fall back to |
| Worker token | in the `.mcp.json` header, per #159 |
| Route bounds | `/state`, `/command`, `/answer` all 403 from inside; `/mcp` 403 with no token and with a wrong one |
| Stop hook | reached the daemon and held the worker at the ending |
| `ask_human` | reached Discord as `esc-70`, answered by button |
| Review gate | reached Discord as `esc-71`, approved by button |
| Merge | PR #186 merged `5998d0a`, issue #179 closed by the daemon |
| Teardown | container gone, tmux session gone, no stopped container left by `--rm` |

## Fault 1: the daemon looks for its gateway when the bridge is down

The boot logged this and carried on:

```
WARNING: no container-facing listener (docker's default bridge network states no gateway
address, and no interface on this box sits in its subnet — the daemon has nowhere to listen
for its containers) — a sandboxed worker cannot reach ask_human or the Stop hook
```

`dockerGateway()` reads the bridge's `Gateway` field, and this box states none — the case #156
predicted. It then falls back to the host interface inside the bridge subnet. That fallback
fails at boot, and the reason is not the subnet arithmetic:

```
$ ip -o link show docker0        # no container attached
11: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> ... state DOWN
$ ip -4 -o addr show docker0
11: docker0    inet 10.0.1.1/24 brd 10.0.1.255 scope global

$ node -e 'console.log(!!require("os").networkInterfaces().docker0)'
false
$ node -e 'dockerGateway()'
THREW: docker's default bridge network states no gateway address, and no interface on this
box sits in its subnet — the daemon has nowhere to listen for its containers
```

`docker0` keeps its address, but docker leaves it `NO-CARRIER` while no container is attached.
libuv lists an interface only when `IFF_UP` **and** `IFF_RUNNING` are set, so `os.networkInterfaces()`
drops it. With a worker attached, the same call answers at once:

```
$ node -e 'dockerGateway()'      # curia-179 running
gateway = 10.0.1.1
```

So the daemon can find its gateway only when a worker is already running, and it needs the
gateway to give that worker a side channel. The read is done once, at boot, which is the one
moment it cannot succeed on a box with no other default-bridge container.

**Not fixed.** Worked around here by restarting the daemon while `curia-179` held the bridge up:

```
[10:09:27.284Z] curia daemon also listening on http://10.0.1.1:4271 — the side channel for claude containers
[10:09:28.371Z] reconcile: re-adopted live worker curia-179 (alp82/curia#179)
```

## Fault 2: ufw drops container-to-host traffic

A listener on the gateway is not enough. With one bound on `10.0.1.1:4999`, a request from
inside the container **timed out** rather than being refused:

```
$ docker exec curia-179 curl -m 6 http://host.docker.internal:4999/
curl: (28) Connection timed out after 6000 milliseconds
```

A timeout, not a reset, means a drop. The box runs ufw with `-P INPUT DROP` and 32 rules, and
`/etc/ufw/user.rules` allows ssh, wireguard and one narrow rule for another stack. Nothing
allows the docker bridge.

**Fixed on the box**, by the operator, as root:

```
ufw allow in on docker0 from 10.0.1.0/24 to 10.0.1.1 port 4271 proto tcp \
  comment 'curia worker side channel'
```

The rule is host state and lives in no file this repo carries. See `docs/deploy.md`.

It is scoped to the daemon port on the bridge interface. Port 4999 stayed dropped after it was
added, which is what says the rule is narrow rather than an open host. Every default-bridge
container can reach the port, which is the posture #159 designed for: that listener carries the
two worker routes and nothing else, and both demand the token the daemon minted.

## Fault 3: a worker never recovers an MCP server that was down at spawn

The largest one, and it is not about this box.

`curia-179` started while faults 1 and 2 were still live, so its `.mcp.json` server was
unreachable at session start. It stayed unreachable **for the whole session**, after the
daemon was fixed and the endpoint answered. The worker's own words:

> The curia MCP server never connected in this session. Its tools — ask_human, notify,
> open_pull_request, publish_preview, request_review, report_result — are not present, so I
> cannot call any of them. The daemon itself is alive. I probed it directly and it answered an
> MCP initialize correctly. So this is the client side of the connection, not the daemon.

Claude Code connects an HTTP MCP server once, at startup, and does not retry it. A side channel
that is down for those seconds takes the worker's entire curia toolset with it, for the life of
the session, and the daemon is told nothing — it sees a worker that reads and edits and never
calls a tool.

The ticket still reached merge, because the worker read the token out of its own `.mcp.json`
and drove the endpoint over plain HTTP instead:

> I found a way through: the curia MCP client never connected in this session, but the daemon
> answers on its own endpoint, so I reached the tools over HTTP with the same worker token from
> `.mcp.json`. Same tools, different transport.

That is one worker being resourceful, not a path that works. A worker that is not sits with no
tools and no way to say so.

It behaved well while blocked, which is worth recording beside the fault: it refused to
`git push`, said that write belongs to curia, and reported the ticket unresolved rather than
inventing an ending.

## Also found

- **The daemon's loudest warning is invisible in `journalctl -u curia`.** Fault 1's line renders
  as `[433B blob data]`, because it carries an em dash and the box locale is not UTF-8. It was
  found only by decoding the journal as JSON. Several dispatch messages hide the same way.
- **The worker image was gone from the box** before this run, though #154 built it there and
  #181 read it back as `already built`. No docker delete event survives that far back, so
  nothing here names the cause. The box also runs Coolify, which prunes.
- **The test suite is not green inside a worker container.** 14 real-boot and config tests need
  docker and network the container does not have. The worker handled it by stashing its change
  and comparing failure sets, which is the right move and is not free.
- **`container.env` outlives the worker**, mode 0600 in the daemon-owned cfg dir. Not a new
  hole, and not inside any mount after teardown.

## What this check does not cover

**No preview was published.** #179 is a daemon change with no page, so the worker skipped
`publish_preview` on purpose rather than pointing at a site root. A preview from inside a
container reaching a phone is still unmeasured live — #157 measured every part of it against a
real container, a real Serve rule and a real HTTPS request, but not through a worker. The map's
closing test is where that lands.

**The codex lane was not exercised.** It stays `sandbox: none` until
[#158](https://github.com/alp82/curia/issues/158).

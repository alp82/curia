# Live check: the daemon catches a worker that never got its tools (#194)

Ticket: [alp82/curia#194](https://github.com/alp82/curia/issues/194), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on the deployment box
`coinmatica.net` on 2026-08-04, from a dev session. Five real dispatches of
[#170](https://github.com/alp82/curia/issues/170) through the live daemon: four healthy, one
against a deliberately dead MCP endpoint.

[The first live containerized dispatch](https://github.com/alp82/curia/issues/185) found the
fault this closes. Claude Code connects an HTTP MCP server once and never retries, so an outage
of seconds at spawn cost `curia-179` its whole curia toolset for its whole session, **with the
daemon told nothing**. A worker with no tools looked exactly like a worker that was thinking.

## The one unmeasured number

[#189](https://github.com/alp82/curia/issues/189) settled the mechanism and left one question
open: when does a HEALTHY worker send its first `/mcp` request, relative to the composer marker
the readiness watchdog already waits for? Two readings on record pulled opposite ways.
[#166](https://github.com/alp82/curia/issues/166) measured MCP tools at 0 context, "loaded on
demand", which hints the client connects lazily. The #185 worker knew its server "never
connected", which says the client settles that state at startup.

The daemon owns `/mcp` and recorded none of it, so the measurement needed one commit first
(`df9189c`): a stamp per worker, the first time its name lands on the route.

## The reading

Four healthy dispatches on the claude lane, `opus`, in a container:

| Run | spawn → first `/mcp` | spawn → composer marker | handshake, relative to the marker |
| --- | --- | --- | --- |
| 15:01:30 | 3679 ms | 6039 ms | **2360 ms ahead** |
| 15:02:16 | 3153 ms | 6050 ms | **2897 ms ahead** |
| 15:22:37 | 3277 ms | 6031 ms | **2754 ms ahead** |
| 15:25:22 | 2717 ms | 4027 ms | **1310 ms ahead** |

Every run states `since_ready_ms: null` and `state: "spawning"` on the stamp, which is the
answer in one field: **the handshake had already landed when the marker appeared.** This lane
connects its MCP servers at startup. It does not connect them lazily, so #166's "loaded on
demand" is about tool definitions in a context window and not about the connection.

The marker is read by a 2 s poll, so the true composer moment sits somewhere in the 2 s before
`worker_ready`. That narrows the margin, it does not cross it: the handshake is ahead in every
run either way.

```json
{"type":"worker_spawned","worker":"curia-170","model":"opus","backend":"claude","sandbox":"docker"}
{"type":"worker_mcp_first","worker":"curia-170","since_spawn_ms":3277,"since_ready_ms":null,"state":"spawning"}
{"type":"worker_ready","worker":"curia-170","model":"opus"}
```

**The window is 15 s on the claude lane** (`backends.claude.tool_channel_grace_s`), which is
that margin with room in it, and still catches a mute worker about 21 s after spawn. The codex
lane runs on 60 s and says so in the config: nothing here says its CLI starts on the claude
lane's clock, and [#158](https://github.com/alp82/curia/issues/158) takes that reading when the
lane gets its container.

## A healthy worker is never touched

Run 3 was watched for 25 s past readiness — ten seconds past the whole window:

```
worker_mcp_first  15:22:41.011
worker_ready      15:22:43.763
(nothing else)
```

No `worker_mute`, one `worker_spawned`, the session still live at the cancel.

## The fault, induced

The endpoint had to be dead in a way [#188](https://github.com/alp82/curia/issues/188) does not
already refuse. Its probe measures the PATH from a container to the daemon, and that path was
healthy here — so the fault was put on the CLIENT, where #185 found it: the deployed
`workspace.mjs` was patched to write `daemonPort + 1000` into the worker's `.mcp.json`, and the
daemon restarted. Everything else stayed real, the Stop hook's curl included.

```
15:23:49.488  worker_spawned      opus, claude, container, ports 9000-9002
15:23:49.464  side_channel_ready  gateway 10.0.1.1     ← #188's probe passes: the path is fine
15:23:53.515  worker_ready        the composer, with no tools behind it
15:24:08.676  worker_mute         grace_s 15, found "grace window", attempt 1
15:24:10.192  worker_spawned      model opus, retry_after_mute true
15:24:14.221  worker_ready
15:24:29.358  worker_mute         attempt 2
15:24:31.918  dispatch_unclaimed  reason "no tool channel, twice"
```

Read across: caught **15.16 s** after the marker, respawned **1.5 s** later on the SAME model,
caught again **15.14 s** after the second marker, and refused. **42 s from spawn to refusal**,
against a fault that used to consume a whole session unnoticed.

Checked at the end of it:

- `gh issue view 170` — **no assignee**, open. The ticket is back on the frontier.
- The daemon log carries the reason in words, twice: `curia-170 reached its composer and sent no /mcp request (grace window) — attempt 1`.

The two Discord messages are the operator's surface. They name the cause rather than the
symptom, and the refusal names where to look — the side channel has to be up before the worker
is, so `/state` and the last `side_channel_ready` are what to read.

The induced patch was reverted with `git checkout`, the daemon restarted, and run 4 above is
the proof the box came back healthy.

## What this does not cover

- **A tool channel lost mid-session.** Out of scope by #189 and on the map as fog. After
  readiness a mute worker and a busy one are indistinguishable without a heartbeat, and a
  heartbeat is the worker cooperation that fails here.
- **The Stop hook backstop did not fire live.** With a 15 s window nothing reaches the end of a
  turn first, which is the point of the window. It is unit-tested, and it is a backstop for a
  MISTUNED window rather than a second mechanism.
- **The codex lane.** Its window is a conservative guess until #158.
- **A respawn that fails.** The mute path releases the claim exactly as the cap-hit path does,
  and both now run through one respawn function. Unit-tested only.

## One correction, made while checking #158

The teardown after the refusal was first read with `tmux -L curia ls`, which answers about a
socket named `curia`. **The daemon uses the DEFAULT socket** (`tmux.mjs` runs bare `tmux`), so
that command reported "no such file" about a socket nobody writes, and it would have said the
same with a live worker on the pane. The reading proved nothing.

Re-read on the right socket during the #158 check: `tmux ls` says `no server running` and
`docker ps` lists no `curia-*` container, with the box idle. So the conclusion holds and the
evidence for it did not. Anything checking for a live pane on this box reads `tmux ls`.

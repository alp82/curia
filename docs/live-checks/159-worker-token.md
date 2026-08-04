# Live checks: the per-worker token on the daemon loopback (#159)

Run 2026-08-04 on the workstation, against the real `claude` 2.1.221 and the real `codex` 0.146.0. The whole control turns on one question the source cannot answer: does each CLI actually put the header on the wire? Every claim below is a measurement.

## 1. Both lanes accept a per-server header

The header has to reach the daemon on a request the CLI composes itself, so the delivery had to be one both CLIs already support.

| Check | Result |
| --- | --- |
| `claude mcp add --transport http … --header 'X-Curia-Worker-Token: secret123'` | writes `"headers": {"X-Curia-Worker-Token": "secret123"}` into `.mcp.json` |
| `codex mcp list --json` against a hand-written `http_headers = { … }` | reads it back as `transport.http_headers` |

So the two lanes spell the same thing two ways: `headers` on the claude lane, `http_headers` on the codex one. Codex offers `bearer_token_env_var` as well, and that one is wrong here: it names an environment variable, which puts the secret back in `ps` on the bare path.

## 2. The header is on every request, on both lanes

A stub daemon recorded the headers of every request it received. The harness was written by curia's own `writeHarness`, not a hand-rolled fixture, so what ran is the shipped file. Each CLI was then asked to call one MCP tool and stop.

| Lane | Routes reached | Requests carrying the token |
| --- | --- | --- |
| claude | `/mcp`, `/worker_done` | 14 of 14 |
| codex | `/mcp`, `/worker_done` | 6 of 6 |

`requests with a WRONG or MISSING token: []` on both lanes. The Stop hook is included, which is the half that rides a curl argument rather than an MCP client.

One thing the run showed by accident and worth keeping: a claude worker with no credential still connects its MCP client and sends the header four times before it says `Not logged in`. The identity check and the model credential are independent.

## 3. The gate, on a real boot of both listeners

`daemon/test/index.test.mjs` boots the real daemon with a sandboxed backend, so it brings up the loopback listener and the container-facing one. Only `docker network inspect` is faked, and the gateway it reports is `127.0.0.2` — another loopback address this box can bind and dial, so the second listener is the shipped one, reached the way a container reaches it.

| Check | Result |
| --- | --- |
| `POST /mcp?worker=curia-41` with no header | `403 no valid curia worker token` |
| `POST /worker_done?worker=curia-42` with `curia-43`'s token | `403` |
| `POST /worker_done?worker=curia-44` with its own token | `200`, and the route ran |
| `/command`, `/answer`, `/cancel`, `/escalate`, `/reconcile`, `/state` on `127.0.0.2` | `403 not reachable from a worker container` |
| the same routes on `127.0.0.1` | unchanged |
| `POST /worker_done` on `127.0.0.2` with the worker's own token | `200` |

The refusal is journalled as `worker_token_refused`, so a worker that stops being able to talk says why in the journal rather than going quiet.

## 4. What is not closed

- **The bare path has no boundary to enforce.** Every bare-pane worker runs as the same host user, so one can read another's harness file whatever the daemon stores and where. The token is a real control for a container, which mounts only its own two directories, and for anything else on the box that reaches the port but cannot read the daemon's data dir.
- **A worker armed before this shipped carries no header.** The daemon restart that adopts the change refuses its live workers on both routes: `ask_human` fails and the Stop hook stops being able to block the ending. Take that restart with no worker live, and there is no cost at all. With one live, the recovery is `tmux kill-session -t curia-<n>` on the box and then `resume <n>`, which arms a fresh worker and mints its token — the worktree and its commits survive (`resume` inherits a surviving worktree), the conversation does not. `cancel` is the wrong verb here: it removes the worktree.

# reject-on-lint rig (#416)

The instrument for [alp82/curia#416](https://github.com/alp82/curia/issues/416). It answers one
question. When an MCP tool rejects an agent's prose, does the agent rewrite it and call again?

The finding is [docs/live-checks/416-reject-on-lint.md](../../docs/live-checks/416-reject-on-lint.md).
Read that first. This file says how to run the rig again.

## The parts

| File | What it does |
|---|---|
| `lint-server.mjs` | A stdio MCP server with one tool, `ask_human`. It lints the prose and rejects it. |
| `run-claude.mjs` | Drives one bare `claude -p` child against that server. Needs a credential. |
| `stub-responses.mjs` | A stub Responses API. It stands in for the model, so codex needs no credential. |
| `run-codex.mjs` | Drives one `codex exec` against the stub and the same server. |

`lint-server.mjs` is hand-rolled JSON-RPC. It needs node and nothing else.

## The knobs

`LINT_CARRIAGE` picks how a rejection reaches the agent.

| Value | The wire |
|---|---|
| `tool-error` | `{ isError: true, content: [...] }` |
| `ok-text` | a normal result whose text refuses. This is what curia does today. |
| `protocol-error` | a JSON-RPC error, code -32602. This is the shape a zod failure takes. |

`LINT_MODE` picks the policy.

| Value | The policy |
|---|---|
| `lint` | Lint for real. The agent escapes by rewriting. |
| `always` | Reject every call. The agent cannot escape. |
| `until:N` | Reject the first N calls, then accept. |
| `cap:N` | Reject N times, then accept the text with a lint warning on it. |

`run-claude.mjs` also reads `TASK_VARIANT`. Use `neutral` for the ping-pong runs. The `cap` task
names the numbers 3 and 5, and an agent can anchor its own stopping point on them.

## Run one

```sh
# claude, real model, real credential from /cfg/container.env
node run-claude.mjs s1-lint-toolerror tool-error lint opus 2.0 900

# codex, no credential, stub model
node run-codex.mjs c1-toolerror tool-error 8899
STUB_VARIANT=discard node run-codex.mjs c2-toolerror-discard tool-error 8901
```

Each run writes `out/<name>/summary.json` and `out/<name>/calls.jsonl`. The raw transcript
(`stream.jsonl`) and the raw codex request bodies (`requests/`) stay out of git.

Give every concurrent codex run its own port. The stub binds one.

## Two traps

The claude child must run OUTSIDE `/workspace`. The CLI walks up from the working directory for a
`.mcp.json`, finds curia's own, and the child then sees the real curia server. `SANDBOX_ROOT`
defaults to `/tmp/reject-on-lint` for that reason.

`--mcp-config` is the wrong way to plant the server. The CLI connects those servers
"fully async (nonblocking)", so turn one can start before the tool exists. The child then answers
that it has no such tool. Plant a project `.mcp.json` instead, the way curia does.

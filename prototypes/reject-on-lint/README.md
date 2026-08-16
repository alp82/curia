# reject-on-lint rig (#416, #448)

The instrument for [alp82/curia#416](https://github.com/alp82/curia/issues/416). It answers one
question. When an MCP tool rejects an agent's prose, does the agent rewrite it and call again?

[#448](https://github.com/alp82/curia/issues/448) asks the same question of a real codex model, so
`run-codex.mjs` gained a real lane. See [Run the #448 matrix](#run-the-448-matrix).

The findings are [docs/live-checks/416-reject-on-lint.md](../../docs/live-checks/416-reject-on-lint.md)
and [docs/live-checks/448-codex-rewrite.md](../../docs/live-checks/448-codex-rewrite.md).
Read those first. This file says how to run the rig again.

## The parts

| File | What it does |
|---|---|
| `lint-server.mjs` | A stdio MCP server with one tool, `ask_human`. It lints the prose and rejects it. |
| `run-claude.mjs` | Drives one bare `claude -p` child against that server. Needs a credential. |
| `stub-responses.mjs` | A stub Responses API. It stands in for the model, so codex needs no credential. |
| `run-codex.mjs` | Drives one `codex exec` against the same server. Stub model, or a real one under `REAL=1`. |
| `matrix-448.mjs` | Runs the whole #448 matrix on a real credential and writes one table. |

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

`LINT_TOOL_DESC` picks the tool description. It is the #448 lever.

| Value | The description |
|---|---|
| `plain` | Says nothing about the return value. This is the shape curia ships today. |
| `read-return` | Tells the model to read the return value and print it. |

`run-claude.mjs` and `run-codex.mjs` both read `TASK_VARIANT`. Use `neutral` for the ping-pong runs.
The `cap` task names the numbers 3 and 5, and an agent can anchor its own stopping point on them.

## Run one

```sh
# claude, real model, real credential from /cfg/container.env
node run-claude.mjs s1-lint-toolerror tool-error lint opus 2.0 900

# codex, no credential, stub model
node run-codex.mjs c1-toolerror tool-error 8899
STUB_VARIANT=discard node run-codex.mjs c2-toolerror-discard tool-error 8901
```

Each run writes `out/<name>/summary.json` and `out/<name>/calls.jsonl`. The raw transcripts
(`stream.jsonl`, `rollout.jsonl`), the raw codex request bodies (`requests/`) and `codex.log` stay
out of git.

Give every concurrent codex run its own port. The stub binds one.

## Run the #448 matrix

This lane needs a real codex credential, so it runs ON THE BOX. Never in an agent container:
[#438](https://github.com/alp82/curia/issues/438) settled that.

```sh
cd prototypes/reject-on-lint
node matrix-448.mjs
```

Ten `codex exec` sessions, one after another, on `gpt-5.6-sol` at effort `high` — the model and the
effort `config/routing.yaml` spawns. Each is a short session, and each costs the operator's own
quota. The two `always` rows are the long ones. Drop them with `SKIP_PINGPONG=1`, or pick rows with
`ONLY=r1,r5`.

The matrix writes `out/448-matrix.md` and `out/448-matrix.json`. The finding is written from those.

Every run is disposable, the way [#207](https://github.com/alp82/curia/issues/207) ran it: a
throwaway `CODEX_HOME` under `/tmp/reject-on-lint`, a throwaway working directory, and a COPY of
`~/.codex/auth.json`. Codex refreshes the token in the file it is given, so the copy keeps the
operator's own credential out of the run.

`REAL=1 node run-codex.mjs <name> <carriage>` runs one row by hand. It reads `MODEL`, `EFFORT`,
`CODEX_AUTH` and `TIMEOUT_MS`.

**The real lane reads the rollout, not the stub requests.** Codex writes a session transcript under
`$CODEX_HOME/sessions`. It carries the `exec` script the model wrote and the output codex handed
back for it. So both lanes read the wire, and neither reads the model's own account of itself.

## Two traps

The claude child must run OUTSIDE `/workspace`. The CLI walks up from the working directory for a
`.mcp.json`, finds curia's own, and the child then sees the real curia server. `SANDBOX_ROOT`
defaults to `/tmp/reject-on-lint` for that reason.

`--mcp-config` is the wrong way to plant the server. The CLI connects those servers
"fully async (nonblocking)", so turn one can start before the tool exists. The child then answers
that it has no such tool. Plant a project `.mcp.json` instead, the way curia does.

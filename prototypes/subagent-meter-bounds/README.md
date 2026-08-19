# subagent-meter-bounds

The rig for [#544](https://github.com/alp82/curia/issues/544): when a dispatched agent spawns a subagent, what does the context meter read, and do the write bounds reach the subagent?

The finding is [docs/live-checks/544-subagent-meter-bounds.md](../../docs/live-checks/544-subagent-meter-bounds.md). Read that first. This file says how to run the codex rig again. The demo the operator reads is [demo.html](demo.html).

## The two lanes

The claude lane needs no rig. The check ran live inside the dispatched agent's own session, under curia's own config. The agent spawned a subagent with its harness Task tool and then read its own transcript directory with the daemon's own `findTranscript` and `readTranscriptMeters`. The committed evidence is `out/claude-live/extract.json`.

The codex lane is this rig. No codex credential exists in an agent container, so the model is a stub Responses API, the same instrument as [prototypes/codex-stop-hook](../codex-stop-hook). The stub scripts a parent turn that calls `spawn_agent`, a child turn that writes outside the worktree, and a `wait_agent` collect. The measurements are mechanical, so the stub costs nothing that matters here. It measures which files codex writes, what the daemon meter reads from them, and what context the child receives. It cannot measure what a real model would choose to do.

## Run it

```
node run-codex.mjs <name>            # the scripted spawn_agent run (stub model)
node run-codex.mjs <name> discover   # unscripted stub; the value is the logged tool schemas
node run-codex.mjs <name> live       # the REAL model on the REAL account — run on the box
```

Live mode is the operator's lane. It needs the box: `~/.codex/auth.json`, tmux, node, and the
pinned codex on PATH. It seeds a throwaway `CODEX_HOME` from the host store (the #207 method),
keeps curia's config verbatim (`multi_agent = false` included), and asks the real model to spawn
one subagent whose task is the outside write plus the sentinel report. It needs no npm install:
the imported daemon modules use only node built-ins. Everything lands in `out/<name>/` as in the
stub lanes, plus `pane.txt` with the parent's final report.

| Knob | What it does |
|---|---|
| `MULTI_AGENT=1` | write `multi_agent = true` and `multi_agent_v2 = true` instead of curia's `multi_agent = false`. Without it the collaboration tools are absent under the stub provider, and the run cannot spawn. |
| `STUB_PORT` | the stub port (default 8899) |
| `SANDBOX_ROOT` | where the throwaway `CODEX_HOME` and worktree go (default `/tmp/curia-544`) |

The run that produced the finding:

```
MULTI_AGENT=1 node run-codex.mjs s3
```

## Read the result

- `out/<name>/summary.json` — the file layout, the final meter read, the sentinel check, and the outside-write result.
- `out/<name>/timeline.jsonl` — what `findTranscript` picked and what `codexTail` reported, sampled four times a second while the run went.
- `out/d2/tools-extract.json` — the collaboration tool schemas, read off the wire in the discover run.
- `out/claude-live/extract.json` — the claude-lane evidence from the live in-session run.
- `out/live2/` — the live box run (2026-08-19): the summary the operator pasted back, and the pane
  tail with the child's refusal of the outside write. The box carries no codex binary, so the
  operator ran the rig inside the agent image with the host `auth.json` mounted read-only.

## The wire detail a re-run needs

Codex 0.146.0 addresses a namespaced tool with a `namespace` field beside `name` on the `function_call` item. A dotted name (`collaboration.spawn_agent`) and a plain name (`spawn_agent`) both answer `unsupported call` (runs s1 and s2). The stub therefore emits `{name: "spawn_agent", namespace: "collaboration"}`.

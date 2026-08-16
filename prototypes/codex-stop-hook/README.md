# codex-stop-hook

The rig for [#447](https://github.com/alp82/curia/issues/447): does the codex Stop hook still block?

The finding is [docs/live-checks/447-codex-stop-hook.md](../../docs/live-checks/447-codex-stop-hook.md).
Read that first. This file says how to run the rig again.

The whole codex lint gate rests on one reading of this hook. A codex version bump owes a re-run.

## Why it needs no credential

Two stub servers on loopback, with a real codex binary between them.

- `stub-responses.mjs` is the model. It is the instrument #360 built and #416 reused. It answers
  every turn with a plain message, so the turn ends and the Stop hook fires.
- `stub-daemon.mjs` is the daemon's `POST /agent_done`. It answers `{decision:"block", reason}` while
  a step is outstanding, then a bare `{}`.
- `run.mjs` builds a throwaway `CODEX_HOME` and a throwaway worktree, writes `hooks.json` in the
  daemon's exact shape, and spawns the daemon's own template from `config/routing.yaml`.

No codex credential exists in an agent container. That is why the model is a stub, and it is also why
this rig runs anywhere.

## The sentinel

The refusal text carries the string `CURIA-BLOCK-SENTINEL`. No model and no CLI emits it on its own.
So finding it in the next request body proves the hook's `reason` reached the model. The check is a
string match over the bytes codex sent, not a report from the model.

Keep that property. A stub model can be made to say anything. It cannot forge the wire.

## Run it

```
node run.mjs <name> [tui|exec]
```

`tui` is the default, because it is what the daemon actually spawns. `exec` is the contrast lane.

| Knob | What it does |
|---|---|
| `BLOCKS=N` | how many stops the stub daemon refuses (default 2) |
| `NO_TRUST_FLAG=1` | drop `--dangerously-bypass-hook-trust` from the spawn |
| `EXTRA_KEY=1` | answer `{ok:true}` instead of `{}` on the allow path |
| `STUB_PORT`, `HOOK_PORT` | give every concurrent run its own pair |

The five runs behind the finding:

```
node run.mjs t1 tui
STUB_PORT=8902 HOOK_PORT=8903 NO_TRUST_FLAG=1 node run.mjs t2-notrust tui
STUB_PORT=8904 HOOK_PORT=8905 node run.mjs t3-exec exec
STUB_PORT=8906 HOOK_PORT=8907 BLOCKS=5 node run.mjs t4-deep tui
STUB_PORT=8908 HOOK_PORT=8909 BLOCKS=1 EXTRA_KEY=1 node run.mjs t5-extrakey tui
```

## Read the result

- `out/<name>/summary.json` — the counts, and the reason item read off the wire.
- `out/<name>/stops.jsonl` — one line per stop, with `stop_hook_active` and the raw payload.
- `out/<name>/codex.log` — the pane. This is where `Stop hook (blocked)` appears.
- `out/<name>/spawn.txt` — the exact command the run spawned.

## Notes for a re-run

The TUI lane needs `tmux`. The runner kills its own session at the end.

Every run wipes its own `out/<name>/` and `/tmp/codex-stop-hook/<name>/` first. So a re-run never
reads a stale result from the run before it.

A run that reports `stops_seen: 0` did not measure a weak hook. It measured no session. Read
`codex.log`: codex stalls at a `Hooks need review` menu when the trust flag is missing.

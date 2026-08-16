# Live check: does the codex Stop hook still block on 0.146.0 (#447)

Ticket: [The codex Stop hook still blocks on 0.146.0](https://github.com/alp82/curia/issues/447), on
the map [Typed HITL payloads](https://github.com/alp82/curia/issues/413). Run on 2026-08-16.

Versions: codex-cli 0.146.0, the version `config/curia.yaml` pins. The reading it replaces was taken
against `codex --version 0.145` and is recorded at `daemon/src/workspace.mjs:362`.

Where it ran: inside an agent container, not on the box. The container holds no codex credential, so
the model is a stub Responses API. Section 5 says what that costs.

The rig is [prototypes/codex-stop-hook](../../prototypes/codex-stop-hook). Five runs.

## Summary

**The codex Stop hook still blocks on 0.146.0. The codex lint gate keeps its guarantee, and #438
does not reopen.**

All three measurements pass.

1. The hook refuses the stop when the daemon answers `{decision:"block", reason}`. The `reason` text
   reaches the model as a user message.
2. `stop_hook_active` is `false` on the first stop and `true` on the second. #438 can key its flagged
   send on that flip.
3. The refusal works under `--dangerously-bypass-hook-trust`, the flag the spawn template passes.

Two further facts came out of the same runs.

- The flag is not a survival question. It is load-bearing. Without it the spawn stalls before the
  first model turn, at an interactive menu nobody is there to answer.
- The daemon must keep answering a bare `{}` on the allow path. An extra key still fails the hook on
  0.146.0.

| Run | Lane | Trust flag | Blocks set | Stops seen | Turns seen | Reason on the wire |
|---|---|---|---|---|---|---|
| t1 | TUI | yes | 2 | 3 | 3 | requests 2, 3 |
| t2-notrust | TUI | **no** | 2 | **0** | **0** | none |
| t3-exec | `exec` | yes | 2 | 3 | 3 | requests 2, 3 |
| t4-deep | TUI | yes | 5 | 6 | 6 | requests 2 to 6 |
| t5-extrakey | TUI | yes | 1 | 2 | 2 | request 2 |

## The instrument

Two stub servers on loopback, and a real codex 0.146.0 binary between them.

`stub-daemon.mjs` stands in for the daemon's `POST /agent_done`. It carries the same contract as
`daemon/src/index.mjs`: it answers `{decision:"block", reason}` while a step is outstanding, then a
bare `{}`. It logs every payload the hook posts.

`stub-responses.mjs` is the model, the same instrument [#360](https://github.com/alp82/curia/issues/360)
built and #416 reused. It answers every turn with a plain message, so the turn ends and the hook
fires. It writes every request body to disk.

`run.mjs` builds a throwaway `CODEX_HOME` and a throwaway worktree, the way
[#207](https://github.com/alp82/curia/issues/207) ran. It writes `hooks.json` in the daemon's exact
shape, and it spawns the daemon's own template from `config/routing.yaml` in a tmux pane.

**The reason is read off the wire, not from the model.** The refusal text carries a sentinel string,
`CURIA-BLOCK-SENTINEL`. No model and no CLI emits that string on its own. So finding it in the next
request body can only mean the hook's `reason` travelled there. A stub model cannot flatter this
result, because the check is a fixed string match over the bytes codex sent.

That makes the stub a better instrument for this question than a real session, not a worse one. A
real model reports that it saw the reason. The wire shows it.

## 1. The hook refuses the stop, and the reason reaches the model

Run t1, the daemon's own TUI lane. The stub daemon blocked twice. Codex took three turns.

The pane says it plainly:

```
• stub turn 1: done
• Stop hook (blocked)
  feedback: CURIA-BLOCK-SENTINEL: the ending is not done. Call report_result before you stop. (stop 1)
• stub turn 2: done
• Stop hook (blocked)
  feedback: CURIA-BLOCK-SENTINEL: the ending is not done. Call report_result before you stop. (stop 2)
• stub turn 3: done
```

The reason arrives at the model as a **user message**, wrapped in a `hook_prompt` tag:

```json
{
  "type": "message",
  "role": "user",
  "content": [{
    "type": "input_text",
    "text": "<hook_prompt hook_run_id=\"stop:0:/tmp/codex-stop-hook/t1/codex/hooks.json\">CURIA-BLOCK-SENTINEL: the ending is not done. Call report_result before you stop. (stop 1)</hook_prompt>"
  }]
}
```

Two things follow from that shape.

- The text is conversation, not metadata. The model reads it the same way it reads any user turn.
- The tag names the hook file that produced it. So the model can tell a hook refusal from a human
  message.

**The block is mechanical, and it does not depend on the model.** Codex refuses to end the turn and
sends the conversation back to the model whatever the model then does. That is what makes the hook
the guarantee #438 wanted. A rejection on codex is a return value and can be thrown away (#416
section 5). A Stop-hook refusal cannot.

Run t4 pushed this to five blocks. Codex blocked all five times and took six turns. **No cap fired.**
The refusal is not spent after one or two uses.

Run t3 repeated t1 on the `exec` lane. The result is identical. The `exec` surface moved between
0.145 and 0.146, which is why the ticket asked. It did not move the Stop hook.

### The payload the hook posts

Nine keys, on every stop:

```
cwd, hook_event_name, last_assistant_message, model, permission_mode,
session_id, stop_hook_active, transcript_path, turn_id
```

The daemon reads three of them at `/agent_done`: `stop_hook_active`, `hook_event_name` and
`session_id`. All three are present, and `hook_event_name` is `Stop`.

The 0.145 note says the hook carries "the same payload keys" as the claude harness. This check did
not measure the claude harness, so it does not confirm that phrasing key for key. `turn_id` looks
codex-specific. What it does confirm is the claim the daemon depends on: every key the daemon reads
is there.

## 2. `stop_hook_active` flips on the second stop

Measured in every run that reached a second stop.

| Stop | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| `stop_hook_active` (t4) | `false` | `true` | `true` | `true` | `true` | `true` |

The flag is `false` on the first stop and `true` on every stop after it. It does not toggle back, and
it does not count. It says "a Stop hook already ran in this session" and nothing more.

#438 keys its flagged send on that flip, and the flip fires. But read the shape before building on
it: **the flag is sticky, not a counter.** It cannot tell a second stop from a sixth. A design that
needs the number of refusals must count them in the daemon, which is where #416 section 2 already put
that job for the same reason.

## 3. The refusal needs `--dangerously-bypass-hook-trust`

Run t2 dropped the flag and changed nothing else. The result is not a weaker block. It is **no
session at all**: zero stops and zero model turns.

The pane shows why. Codex stopped before the first turn and asked:

```
  Hooks need review
  1 hook is new or changed.
  Hooks can run outside the sandbox after you trust them.
› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)
```

A zero-keystroke spawn waits there forever. This is the stall the comment at
`daemon/src/workspace.mjs:886` records as observed, and it still happens on 0.146.0.

So the ticket's third question has a stronger answer than it asked for. The refusal does not merely
survive the flag. The flag is what lets the hook run at all, and the spawn template is right to pass
it. The bound that comes with it is unchanged: the flag is not scoped to curia's own hook, which is
why `untrustedProjectConfig` refuses a dispatch onto a worktree that carries `.codex/hooks.json`.

## 4. The allow body must stay a bare `{}`

Run t5 answered `{ok:true}` on the allow path instead of `{}`. Codex refused it:

```
• Stop hook (blocked)
• Stop hook (failed)
  error: hook returned invalid stop hook JSON output
```

The closed schema still bites on 0.146.0. The behavior matches the comment at `/agent_done` exactly,
including the failure mode: it **fails open**. The session ended, so nothing was trapped. What it
costs is the signal, because a genuinely broken hook looks the same.

The daemon already sends a bare `{}`. This run pins the reason, so a later edit does not add a
friendly key back.

## 5. What this check does not settle

**Model compliance.** The stub answers whether codex refuses the stop and delivers the reason. It
cannot answer whether a real model then does what the reason asks. That is a real gap, and it is the
codex half of the question #416 section 6 also left open. It needs a codex credential, which no agent
container holds.

The gap is narrower than it looks. The block itself does not need the model to cooperate, because
codex forces another turn on its own. A model that ignores the reason burns a turn and stops again,
and the hook refuses again. Run t4 shows the refusal repeating without limit. So the worst case is a
loop, not an escape. That is the opposite failure mode to #416 section 5, where the rejection went
missing in silence.

**The box.** This ran in an agent container, not on `coinmatica.net`. #207 ran on the box with a real
credential. Nothing measured here is host-specific, but the reading is a container reading.

**The claude comparison.** The 0.145 note claims the payload keys match the claude harness. This
check measured codex only.

**A long real session.** Every run here is a short session with one stub turn. Whether the hook
behaves the same at a full context window is untested.

## 6. How to run it again

A codex version bump owes a re-run of sections 1 to 4. The whole codex gate rests on this reading.

1. `cd prototypes/codex-stop-hook`
2. `node run.mjs <name> tui` for the daemon's own lane. Add `exec` instead of `tui` for the other one.
3. Knobs: `BLOCKS=N` sets how many stops the daemon refuses. `NO_TRUST_FLAG=1` drops the trust flag.
   `EXTRA_KEY=1` answers `{ok:true}` on the allow path.
4. Give every concurrent run its own `STUB_PORT` and `HOOK_PORT`.
5. Read `out/<name>/summary.json` for the counts. Read `out/<name>/codex.log` for the pane.

The rig needs no credential. That is what makes it re-runnable inside a container.

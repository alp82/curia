# Live check: does a real codex model rewrite after a rejection (#448)

Ticket: [Does a real codex model rewrite after a rejection?](https://github.com/alp82/curia/issues/448),
on the map [Typed HITL payloads](https://github.com/alp82/curia/issues/413). Run on 2026-08-16.

Versions: codex-cli 0.146.0, the version `config/curia.yaml` pins. The model is `gpt-5.6-sol` at
reasoning effort `high`, which is what `config/routing.yaml` spawns for the codex harness.

Where it ran: on the box, by the operator, with the operator's own credential. No codex credential
goes into an agent container, and [#438](https://github.com/alp82/curia/issues/438) settled that.
This is the run [#416](https://github.com/alp82/curia/issues/416) could not make.

The rig is [prototypes/reject-on-lint](../../prototypes/reject-on-lint). Ten runs, one command:
`node matrix-448.mjs`.

## Summary

**Both answers are yes, and the codex arm now matches the claude arm.**

1. A real codex model rewrites its own text after a rejection and calls again. Eight escapable runs,
   eight passes on attempt 2, with no instruction to retry. #416 measured the same number on claude.
2. The model prints the `exec` script's return value by itself. It did so in four runs of four with
   the plain tool description, the one curia ships today.

So the cap of 3 is right on codex, and the Stop-hook catch is the rare path and not the normal one.
A codex escalation costs one extra turn, the same as a claude one.

**This does not close the hole #416 found.** The call still never throws. A model that discards the
return value still sees "Script completed", and that is why the hook stays the guarantee (#447).
This check measures what one model does, not what the harness prevents.

| Run | Description | Carriage | Policy | Calls | Rejected | Passed on | Return value reached the model | Tokens |
|---|---|---|---|---|---|---|---|---|
| r1 | plain | tool-error | lint | 2 | 1 | attempt 2 | yes | 58k |
| r2 | plain | tool-error | lint | 2 | 1 | attempt 2 | yes | 58k |
| r3 | plain | ok-text | lint | 2 | 1 | attempt 2 | yes | 57k |
| r4 | plain | protocol-error | lint | 2 | 1 | attempt 2 | yes | 58k |
| r5 | read-return | tool-error | lint | 2 | 1 | attempt 2 | yes | 58k |
| r6 | read-return | tool-error | lint | 2 | 1 | attempt 2 | yes | 58k |
| r7 | read-return | ok-text | lint | 2 | 1 | attempt 2 | yes | 58k |
| r8 | read-return | protocol-error | lint | 2 | 1 | attempt 2 | yes | 58k |
| r9 | read-return | tool-error | always | 5 | 5 | never | yes | 105k |
| r10 | read-return | ok-text | always | 15 | 15 | never | yes | 381k |

Every run ended by itself. No run hit the timeout.

## The instrument

The lint server is the one #416 built, unchanged: one MCP tool, `ask_human`, two fields, and a
mechanical subset of `daemon/assets/voice.md`. The rejection names the rule, quotes the text, and
ends with one line that asks for a rewrite. The task never states the voice rules and never says
"retry".

`run-codex.mjs` gained a real lane. It drops the stub Responses API, copies `~/.codex/auth.json`
into a throwaway `CODEX_HOME`, and runs `codex exec` against the real endpoint. Every run is
disposable, the way [#207](https://github.com/alp82/curia/issues/207) ran.

`LINT_TOOL_DESC` is the new knob, and it is the lever question 2 measures.

| Value | The description |
|---|---|
| `plain` | Says nothing about the return value. This is what curia ships today. |
| `read-return` | Tells the model to read the return value and print it. |

**The real lane reads the rollout, not the model's report.** Codex writes a session transcript under
`$CODEX_HOME/sessions`. It carries the `exec` script the model wrote, byte for byte, and the output
codex handed back for it. So every number here is read off the wire.

The counted evidence is committed under `prototypes/reject-on-lint/out/448-*`. The rollouts stay on
the box, because they are large and they regenerate.

## 1. The model rewrites, in all three carriages

Eight escapable runs. Every one called twice, was rejected once, and passed on attempt 2.

The model reads the rejection, fixes the named fault, and calls again inside the same turn. Run r1,
the plain description, is the whole loop in three scripts. The rejection said the sentence ran to 21
words against a cap of 20:

```js
// the rejected call
prompt: "... Should the cap be 3 or 5? Choose 3 to end a stuck loop sooner, or 5 to give the agent more room to fix its own text."
// the accepted call, one turn later
prompt: "... Should the cap be 3 or 5? Choose 3 to end a stuck loop sooner. Choose 5 to give the agent more room to fix its own text."
```

**The carriage does not change the behavior.** A tool error, a plain refusal in a normal result, and
a JSON-RPC error all drive the same rewrite. This is the #416 result, repeated on the other harness.

**The description does not change it either.** The four `plain` runs behave like the four
`read-return` runs. So the retry does not wait on an instruction.

**No information was lost.** All eight accepted prompts still carry both options and both
consequences. The rejection's last line asks for this, and the model obeyed it every time.

## 2. The model prints the return value by itself

This is the question #416 left open, and the answer is the good one.

In all four `plain` runs the model wrote the read loop with no prompting:

```js
const result = await tools.mcp__lintcheck__ask_human({ headline: "...", prompt: "..." });
for (const item of (result?.content ?? [])) {
  if (item.type === "text") text(item.text);
}
```

The `read-return` runs wrote the same loop. The description bought nothing here, because the model
already did it.

**The model also reads the tool description before it calls.** Script 1 of every run of all ten is a
discovery script, not a call:

```js
const hits = ALL_TOOLS.filter(x => /lintcheck|ask_human/i.test(x.name + " " + x.description));
text(hits);
```

What comes back is the description plus a type declaration codex generates from the input schema:

```ts
declare const tools: { mcp__lintcheck__ask_human(args: {
  // One line naming the decision.
  headline: string;
  // The question, with the options and their consequences.
  prompt: string;
}): Promise<CallToolResult>; };
```

Two things follow. The description is a live lever, because the model fetches it on purpose. And the
field descriptions in the input schema reach the model the same way, which is a second place to put
the rule.

**Read this as a cost measurement, not as a guarantee.** The isolate still never throws. A -32602
resolves to a return value with `isError: true`, whose text is codex's own wrapper around the
message. Re-measured in a container while writing this finding, against the same 0.146.0:

```json
{"content":[{"type":"text","text":"tool call error: tool call failed for `lintcheck/ask_human`\n\nCaused by:\n    Mcp error: -32602: REJECTED: ..."}],"isError":true}
```

The stub model that discards that value still sees "Script completed" and reports a clean send.
#416 section 5 stands. What changed is the likelihood, not the mechanism.

## 3. What an uncapped loop costs on codex

Two runs against `always`, a rejecter that invents a fault when the prose is already clean. Both use the `neutral` task. The `cap` task names 3 and 5, and an agent can
anchor its stopping point on those numbers (#416 section 2).

| Run | Carriage | Rejections absorbed | Tokens | How it ended |
|---|---|---|---|---|
| r9 | tool-error | 5 | 105k | The model stopped and said the operator never got the question. |
| r10 | ok-text | 15 | 381k | The model stopped and said the same, after it read the linter's source. |

An escapable run costs 58k tokens. So an unwinnable one costs 2 times to 7 times more.

**The carriage sets the patience.** An error-flagged rejection is given up on after 5 attempts. The
same refusal inside a normal result runs to 15. Curia uses the second shape today, so it buys the
long loop, not the short one.

**The question survives the loop.** Sonnet dropped the real question at call 8 in #416 and started
asking about the lint instead. Neither codex run did that. Call 15 of r10 still asks about the
preview link, and it still carries both options:

```
Ticket closed. Keep the link?
- No. We free the port. We stop the old page.
- Yes. We keep it. You can reread it after merge.
```

**But the loop ends somewhere new.** After 15 rewrites r10 stopped rewriting and started to
investigate the rig. Four scripts, in order. A ripgrep for the rejection text across `/tmp`. A
directory listing. A `ps -ef` for the server process. Then the source of the linter itself.

```js
const r = await tools.exec_command({
  cmd: "sed -n '1,260p' /home/alp/dev/projects/curia/prototypes/reject-on-lint/lint-server.mjs",
  ...
```

That is debugging and not mischief. The model was told to reach the operator, the gate kept refusing,
and it went to read the gate. The consequence for curia is plain. On codex an uncapped lint loop does
not only waste turns. It ends with the agent reading the daemon's own lint code, and a cap of 3 stops
that 12 attempts earlier.

## 4. What the numbers buy

The ticket asked what this measurement is for. Both answers land where #416 put them.

- **The cap of 3 is right on codex.** One rejection is what an escapable lint costs, in 8 runs of 8.
  Three sits 3 times above that, and it sits far under 5 and 15, where the model quits.
- **The Stop-hook catch is the rare path.** The model read the return value in every run.
  So the flagged send at the second stop block is a backstop and not the normal route.

Neither number changes the design. #438 already ruled that the design must hold without them, and it
does.

## 5. What this check does not settle

**One model.** Everything here is `gpt-5.6-sol` at effort `high`. A cheaper model in the same family,
or a lower effort, may skip the read loop. The `terra` and `luna` models are defensible swaps for a
bulk lane (#207), and neither was measured.

**One session shape.** Every run is a short, single-purpose `codex exec` session with one tool and no
standing orders. A real curia agent carries a long context, a skill and other work. Whether it still
prints the return value at 80 percent context is untested. This is the same bound #416 left on the
claude arm.

**The `exec` lane only.** The daemon spawns the TUI lane. #447 measured both lanes for the Stop hook
and found no difference, but this check ran `exec`.

**Two ping-pong runs.** The claude arm had six. The stopping points of 5 and 15 are single readings.
The gap between them is wide, so anything that rests on it wants a repeat first.

**The `read-return` wording.** The description used here is a probe. #438 leaves the shipped wording
to the build ticket. This check gives that ticket one fact. The plain description was already
enough for this model.

**The lint is easy.** Every fault here is named and quotable, and one rewrite fixes it. A cap that is
hard to hit may need more rounds.

## 6. How to run it again

A codex version bump owes a re-run, and so does a model change in `config/routing.yaml`.

1. Read `prototypes/reject-on-lint/README.md`.
2. Run `node matrix-448.mjs` on the box, where the codex credential is.
3. Read `out/448-matrix.md` for the table and the scripts the model wrote.
4. Use `ONLY=r1,r5` for one row, and `SKIP_PINGPONG=1` to drop the two long ones.

The container cannot run this lane. It holds no codex credential, and #438 keeps it that way.

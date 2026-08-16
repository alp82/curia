# Live check: does a harness retry when a tool rejects its prose (#416)

Ticket: [Reject-on-lint live check](https://github.com/alp82/curia/issues/416), on the map
[Typed HITL payloads](https://github.com/alp82/curia/issues/413). Run on 2026-08-16 inside an agent
container.

Versions: Claude Code 2.1.220, against `claude-opus-5` and `claude-sonnet-5`. codex-cli 0.146.0,
which `config/curia.yaml` pins. The container holds a claude credential and no codex credential.

The rig is [prototypes/reject-on-lint](../../prototypes/reject-on-lint). Thirteen claude runs and
five codex runs. The claude runs cost 1.87 dollars in total.

## Summary

Reject-on-lint works on the claude harness. An agent reads the rejection, rewrites its own text and
calls again, with no instruction telling it to. Every escapable run passed on attempt 2. All three
carriages drive the retry: a tool error, a plain refusal in a normal result, and a JSON-RPC error.
So curia can keep the carriage it uses today.

The loop does not run forever. Against a rejecter that can never be satisfied, opus stopped itself
after 6 calls, twice. Sonnet stopped after 10. No run needed an outside limit. But the agent stops
by giving up, and the question then reaches nobody.

**A cap of 3 rejections is safe.** It sits 3 times above the observed convergence point of one
rejection. It sits well under the 6 to 10 rejections an agent absorbs before it quits.

The accept-with-flag fallback works, and it is the part that saves the escalation. On attempt 4 the
tool took the text, said it went out with a lint warning, and told the agent not to call again. The
agent stopped and reported the flag honestly.

**Codex 0.146.0 can lose the rejection in silence, and this blocks the codex half.** On that
version an MCP tool is reachable only from JavaScript inside the `exec` tool. The rejection comes
back as the call's return value. It never throws. An agent that ignores the return value sees
"Script completed" and believes the message went out. Measured in all three carriages.

## The instrument

`lint-server.mjs` is a stdio MCP server with one tool, `ask_human`, and two fields: `headline` and
`prompt`. It lints a mechanical subset of `daemon/assets/voice.md`: em-dashes, semicolons,
contractions, marketing adjectives, and sentences over 20 words. It rejects with actionable prose.
The message names the rule, quotes the text, and ends with one line:

```
Rewrite the prompt yourself and call ask_human again. Keep every option and every constraint.
```

Two knobs. `LINT_CARRIAGE` picks how the rejection reaches the agent.

| Carriage | The wire | Why it is in the set |
|---|---|---|
| `tool-error` | `{ isError: true, content: [...] }` | The obvious shape for a failed call. |
| `ok-text` | a normal result whose text refuses | What curia's own refusals do today. |
| `protocol-error` | a JSON-RPC error, code -32602 | The shape a zod schema failure takes. |

`LINT_MODE` picks the policy: `lint` (escapable), `always` (never satisfied), `cap:N` (reject N
times, then accept with a flag).

`run-claude.mjs` drives a BARE `claude -p` child. No CLAUDE.md, no skills, no standing orders, and
one built-in tool. The child's only way to act is the MCP tool. So what it does after a rejection
is the harness and the model, not curia's prompt. That is the floor the daemon must design
against.

The task tells the child to ask the operator one question. It never states the voice rules. It
never says "retry". The child meets the rules only through the rejection.

`run-codex.mjs` drives `codex exec` against a stub Responses API, the same instrument
[#360](https://github.com/alp82/curia/issues/360) built. No codex credential exists in a container.
The stub IS the model: it calls the tool with bad prose, then with good prose. That answers the
mechanical half and not the judgment half.

## 1. Claude Code rewrites and retries, in every carriage

Five escapable runs. Every one passed on attempt 2.

| Run | Model | Carriage | Calls | Rejected | Passed on |
|---|---|---|---|---|---|
| s1 | opus | tool-error | 2 | 1 | attempt 2 |
| s2 | opus | ok-text | 2 | 1 | attempt 2 |
| s5 | opus | protocol-error | 2 | 1 | attempt 2 |
| s7 | sonnet | tool-error | 2 | 1 | attempt 2 |
| smoke | haiku | tool-error | 2 | 1 | attempt 2 |

The agent needs no instruction to retry. It reads the rejection, fixes the named faults, and calls
again in the same turn.

**The carriage does not change the behavior.** The lint text reaches the model intact in all three.

| Carriage | What the model receives |
|---|---|
| `tool-error` | the message as a flat string, with `is_error: true` |
| `ok-text` | the message inside the content array, with no error flag |
| `protocol-error` | `MCP error -32602: <message>`, with `is_error: true` |

The `ok-text` result matters most for curia. Curia's refusals ride a successful result today, and
that shape drives the retry just as well as an error does. So reject-on-lint needs no new failure
path in the daemon.

**No information was lost while the lint was escapable.** Every accepted prompt still carried both
options and both consequences. The rejection's last line asks for this, and the agents obeyed it.
Keep that line. Section 2 shows where that holds and where it breaks.

## 2. The loop does not ping-pong. The agent quits by itself

Six runs against `always`, a rejecter that invents a fault when the prose is already clean.

| Run | Model | Task | Calls before it stopped |
|---|---|---|---|
| s3 | opus | cap | 4 |
| s8 | opus | cap | 4 |
| s9 | sonnet | cap | 7 |
| s10 | opus | neutral | 6 |
| s12 | opus | neutral | 6 |
| s11 | sonnet | neutral | 10 |

**Read the `neutral` rows, not the `cap` rows.** The first task asked the operator to pick a retry
cap of 3 or 5. Those two numbers sat in the child's own context while it decided when to stop. The
sonnet run named the anchor in its answer:

> Per the task's own premise (a cap of 3–5 rewrites before stopping), I'm stopping here rather than
> continuing indefinitely.

So the `cap` task measures the anchor and not the agent. The `neutral` task asks about a preview
link and carries no numbers. Without the anchor, opus stops after 6 calls and sonnet after 10.

Every agent stopped for the same stated reason: the rejection stopped changing. The first rejection
named concrete faults and the agent fixed them. Every later one repeated the same generic sentence.
The agents read a repeated message as a gate that cannot be passed. Opus, run s8:

> I stopped there rather than keep looping. The last three rejections carried no actionable
> detail — the same sentence each time, against text that is already about as short and plain as
> the required content allows.

Three consequences follow.

1. **A vague rejection is the expensive one.** A rejection that names the rule and quotes the text
   is fixed in one attempt. A rejection that says "make it plainer" burns 6 to 10 attempts and then
   fails. The lint message is the whole cost driver.
2. **The agent's own count is unreliable.** In s9 the agent reported five rewrites. The server
   logged seven calls. The daemon must count the rejections, because the agent miscounts its own.
3. **A long loop corrupts the question itself.** Opus kept both options and both consequences
   through all 6 rejections, in both neutral runs. Sonnet did not. On call 8 of run s11 it dropped
   the operator's question and asked about the lint gate instead:

   > I tried asking the preview-link question 7 times, each with simpler wording, and got the same
   > rejection message every time. Do you want me to keep retrying with different wording, or stop
   > here and report the rejections as-is?

   Call 10 asked "Which exact words in my last prompt are not plain enough?". By then the
   escalation channel no longer carried the escalation. A cap that fires before attempt 7 stops
   this on its own.

The failure mode is not a runaway loop. The failure mode is a silent drop: the agent gives up, the
question never reaches the operator, and the agent reports that in its final text, where nobody
gates on it.

## 3. The retry cap: 3 rejections

| Fact | Value |
|---|---|
| Rejections an escapable lint needed | 1, in 5 of 5 runs |
| Rejections an agent absorbs before it quits | 6 (opus) to 10 (sonnet) |
| Attempt where sonnet stopped asking the real question | 8 |
| Recommended cap | 3 rejections, then accept with a flag |

Three sits 3 times above the observed need and well under the point where an agent quits. No run
in this check would have been truncated by it. It also fires before attempt 8, where sonnet turned
the escalation into a question about the lint.

A cap of 5 also fits, and buys nothing measured: no run used more than one rejection when the lint
was escapable.

The cap counts rejections per call site, not per session. Supersede keys are on agent plus kind
(#336), so a second question after a flagged send starts its own count.

## 4. The accept-with-flag fallback

Measured in run s6, with `cap:3`. After 3 rejections the tool took the fourth text as it stood and
returned this:

```
SENT WITH A LINT WARNING. The retry cap is used up, so curia sent your text as it stands. The
operator sees a warning that it failed the voice check. Do not call ask_human again for this
question.
```

The agent stopped, did not call again, and reported the flag in its own words:

> Both options and both consequences survived intact, but it was delivered flagged as failing the
> voice check.

Three parts make that work, and each earns its place.

1. **The tool accepts.** The escalation reaches the operator. This is the whole point. Without it
   the agent quits and the question dies.
2. **The reply says the text went out flagged.** The agent then reports the truth instead of a
   clean send.
3. **The reply says not to call again.** Without that line the agent may read a warning as a fresh
   invitation to fix its text.

The rejection message should also count down. In s6 each rejection ended with "This was attempt 1
of 3", and the agent's report tracked the cap correctly.

What the operator sees is the daemon's job and not the agent's. The lint faults belong on the card
as a warning, next to the text that failed them.

## 5. Codex 0.146.0 can lose the rejection in silence

This is the finding that blocks the codex half of the map.

On 0.146.0 codex sends no `tools` array on the wire. It declares one custom tool, `exec`, which
runs JavaScript. Every MCP tool is reachable only from inside that script, as
`tools.mcp__<server>__<tool>`. The request names it exactly:

```json
"code_mode_tool_names": {
  "mcp__lintcheck__ask_human": {"name": "ask_human", "namespace": "mcp__lintcheck"}
}
```

So a codex MCP call is a nested call inside a script. A rejection is a return value, and a return
value can be thrown away. Five runs, two script shapes.

| Run | Carriage | The script | Did the rejection reach the model? |
|---|---|---|---|
| c1 | tool-error | prints the return value | **yes** |
| c4 | protocol-error | prints the return value | **yes** |
| c2 | tool-error | ignores the return value | **no** |
| c5 | ok-text | ignores the return value | **no** |
| c3 | protocol-error | ignores the return value | **no** |

The call never throws. Not even the JSON-RPC error throws. In c3 the isolate ran to the end and
codex reported success to the model:

```json
{"type": "custom_tool_call_output", "output": [
  {"type": "input_text", "text": "Script completed\nWall time 0.0 seconds\nOutput:\n"},
  {"type": "input_text", "text": "asked the operator"}]}
```

The operator's terminal did show the error, as `tool call error: tool call failed for
lintcheck/ask_human`. The model did not.

A model that writes `await tools.mcp__curia__ask_human({...})` and moves on is not careless. A tool
that only sends a message has no return worth printing. So the silent path is the likely path.

Three facts bound whatever fix follows.

1. The carriage does not help. All three lose the rejection the same way.
2. The tool description is the one lever this check found. It reaches the model on every turn, and
   it can tell the model to read the return value.
3. Whether a real codex model prints the return value is UNMEASURED. A stub cannot answer it.

## 6. What this check does not settle

**Codex judgment.** Whether a real codex model rewrites and retries after a rejection stays
unmeasured. It needs a codex credential, which no agent container holds. `seedConfigDir` symlinks
the host's `~/.codex/auth.json`, and a container mounts no host home. The stub answers the
mechanics and cannot answer the judgment.

**The cap under a real session.** Every claude run here was a bare, single-purpose child. A real
curia agent carries standing orders, a long context and other work. Whether it retries the same way
at 80 percent context is untested.

**A hard lint.** The lint used here is fixed in one attempt. A cap that is hard to hit, such as a
200-character limit on a rich `detail` field, may need more rounds. The cap of 3 rests on a lint
whose faults are all named and quotable.

**The "do not call again" line.** Run s6 included it. Whether the agent stops without it is
untested.

## 7. How to run it again

1. Read `prototypes/reject-on-lint/README.md`.
2. Run `node run-claude.mjs <name> <carriage> <policy> <model> <budget> <timeout>`.
3. Run `node run-codex.mjs <name> <carriage> <port>` for the codex arm. Give each run its own port.
4. Read `out/<name>/summary.json` for the counts, and `out/<name>/calls.jsonl` for the prose.

Keep the claude child outside `/workspace`. The CLI walks up for a `.mcp.json`, finds curia's own,
and the child then reaches the real curia server.

Do not plant the test server with `--mcp-config`. The CLI connects those servers "fully async
(nonblocking)", so turn one can start before the tool exists. Plant a project `.mcp.json`, the way
curia does.

A codex version bump owes a re-run of section 5. The `exec` tool is the whole reason the rejection
can go missing, and that surface moved between versions.

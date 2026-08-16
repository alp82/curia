# Does a keystroke reach a codex agent inside a tool call

Evidence for [wayfinder #457](https://github.com/alp82/curia/issues/457), on [map #244](https://github.com/alp82/curia/issues/244). Measured on 2026-08-16 inside an ordinary agent container, on the codex harness, CLI `0.146.0`. Read it after [tool-channel-mid-session.md](tool-channel-mid-session.md) and [tool-channel-mid-session-codex.md](tool-channel-mid-session-codex.md). This reading takes the half that one stated it could not.

## The question

[#426](https://github.com/alp82/curia/issues/426) decided that the daemon says goodbye before it dies, and [#458](https://github.com/alp82/curia/issues/458) shipped it. A goodbye covers a restart, a deploy and a crash. It cannot cover a SIGKILL, because the daemon never gets to speak. For that one death the pane is the only wire left.

Today curia refuses that wire in exactly this case. `interruptNote` turns away an agent with an open escalation (`dispatch.mjs:4892`), because Escape would abort the very call that is asking the question. After a SIGKILL that call is already dead, so the refusal no longer fits. Nobody had measured whether the keystrokes land at all.

[#371](https://github.com/alp82/curia/issues/371) could not ask this. Its probe is headless, so it has no composer and no pane.

## The rig

[pane-keystroke-codex.probe.mjs](pane-keystroke-codex.probe.mjs). Three parts of it are real, and they are the three the question needs.

1. **The codex CLI.** The real binary, spawned from the template in `config/routing.yaml`, in a tmux pane.
2. **The write path.** `sendKey` and `sendText`, imported from `daemon/src/tmux.mjs`. Same pacing, same literal write, same separate Enter. That module is the thing under test, so the probe imports it rather than copying it.
3. **The config.** The shape `daemon/src/workspace.mjs` writes for a codex agent, with `tool_timeout_sec` at the daemon's own day.

Two parts are stand-ins, for the reason #371 already gave. The model is a script on the Responses wire API, because an agent container carries no codex credential. The daemon is #371's stand-in: a stateless `StreamableHTTPServerTransport` on `POST /mcp?agent=&ticket=`, with the `x-curia-agent-token` header, as `daemon/src/index.mjs` serves it.

The words the probe types are the words `#injectNote` builds, with one sentinel string inside them. No model and no CLI emits that string. So finding it in a request body can only mean the keystrokes reached the composer and the composer started a turn. The reading is a match over the bytes codex sent, never a model's report of itself.

Seven deviations, all stated rather than hidden:

1. The model is a script, not a model.
2. The stand-in daemon writes no journal, holds no escalation record, sends no keepalive and has no Discord bridge.
3. Client and server share one container, so the docker host gateway is not in the path.
4. The scripted model names `mcp__curia__<tool>` directly. The TUI defers the offer behind `tool_search` (see below), and the script has no use for a search result.
5. The pane is resized to 200 by 50 after `newSession`, for a readable transcript. The write path never reads the pane size.
6. The park lasts seconds, not hours.
7. There is no container, no Stop hook and no GitHub credential.

Each case ran twice. The second run agreed with the first to within 0.1 second every time.

## Run 1: the daemon was SIGKILLed, then Escape and the words

The agent calls `ask_human`. The stand-in is SIGKILLed 0.3 seconds later, while it holds the call. A new process listens 5.5 seconds after that, which is the boot the sweep would run in. Then the grace, the Escape and the words.

| Time | What happened |
| --- | --- |
| 23:15:41.417 | `tools/call` `ask_human` arrives |
| 23:15:41.667 | the daemon is SIGKILLed, holding the call |
| 23:15:47.190 | a new daemon process listens on the same port |
| 23:15:52.195 | Escape, written in 13 ms |
| 23:15:52.220 | the words, written in 3.010 s |
| 23:15:55.310 | a new turn reaches the model, carrying the words |
| 23:15:55.774 | the agent's next curia tool call arrives |

**1. Escape ends the tool call, and the model is told plainly.** The `function_call_output` for `ask_human` reads:

> aborted by user after 10.8s

That number is the call's own age at the keystroke, to 0.1 second. So the Escape ended it, and nothing else did.

The model also gets a user message of codex's own:

> `<turn_aborted>` The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.

**2. The words start a turn.** The sentinel appears in the very next request to the model, and in every request after it. The words arrive as an ordinary user message, after the `<turn_aborted>` one.

**3. Each step is fast, and the daemon's own pacing is the whole cost.** The Escape write takes 9 to 43 ms. The word write takes 3.01 seconds, which is `PANE_WRITE_GAP_MS` twice: 1.5 seconds before the literal text, and 1.5 seconds before the Enter. The turn starts 0.07 to 0.09 seconds after the Enter. So the wire costs about 3.1 seconds from the first keystroke to a live turn, and nearly all of it is curia holding itself back.

**4. The abort costs the session nothing.** The agent made two more curia tool calls after the words, and both succeeded against the RESPAWNED daemon process, with no new handshake and no `initialize`. The conversation, the MCP connection and the tmux session all survived. The pane transcript still holds the whole run, the aborted call included.

## Run 2: the same keystrokes, with the daemon ALIVE

Nothing is killed. The stand-in holds a real `ask_human` and answers it 15 seconds in, which is a human taking their time. The Escape lands first, at 5.1 seconds.

| Time | What happened |
| --- | --- |
| 23:17:15.858 | `tools/call` `ask_human` arrives |
| 23:17:20.978 | Escape |
| 23:17:24.077 | the words start a turn |
| 23:17:24.501 | the agent's next curia tool call arrives |
| 23:17:30.859 | the human answers |
| 23:17:30.861 | the daemon writes the answer and closes the request |

**5. Escape does real harm on a live call, and neither side can see it.**

The abort is client-side ONLY. The `tools/call` request stayed OPEN across the whole abort. The daemon logged no close at the keystroke. It logged one 9.9 seconds later, when it wrote its own answer into the socket, and that write reported success.

So the daemon believes it delivered. The record settles, the card closes, and `handOffAnswer` never runs, because `settle` found its resolver exactly where it left it. The agent had moved on six seconds earlier and never saw one word of the answer. The human's answer is lost, and nothing anywhere reports a failure.

That is worse than a plain loss. A loss curia can see becomes a hand-off note. This one closes the question as answered.

**The refusal at `dispatch.mjs:4892` must stay.** It is now measured rather than assumed.

## Run 3: the words alone, with no Escape

The `dead` case again, with the Escape left out. This asks whether the Escape is load-bearing or whether the composer would have done the job by itself.

The words never reach the model. Two turns ran, both before the block. No request carries the sentinel, and no tool call follows the words. The pane says why, in codex's own words:

```
• Calling curia.ask_human({"prompt":"blocking"})

◦ Working (2m 21s • esc to interrupt)

• Messages to be submitted after next tool call (press esc to interrupt and send immediately)
  ↳ [the operator, interrupting from the thread] …
```

**The composer QUEUES a message typed during a tool call.** It holds it until the call returns. The call in this case belongs to a dead process, so it returns at `tool_timeout_sec`, a day out. Words alone reach a parked agent a day late.

## The three runs side by side

| | dead | alive | quiet |
| --- | --- | --- | --- |
| Escape sent | yes | yes | no |
| the call ends | yes, at the keystroke | yes, at the keystroke | no |
| what the model is told | `aborted by user after <n>s` | the same | nothing |
| the words start a turn | yes, 0.08 s after the Enter | yes | NO, they sit in the composer |
| the agent works on | yes, both later calls succeed | yes | no |
| the cost | none | the human's answer, silently | none |

## What this means

**The keystroke reaches a parked codex agent, and it costs about three seconds.** Every step measured twice, and the wire never dropped one keystroke. So the pane is a real wire for the one death a goodbye cannot cover, and a boot-time sweep is now open as a design.

**A sweep must send BOTH keys, in that order.** Escape alone frees the agent and says nothing. Words alone sit in the composer until a dead call times out. Only the pair works, and it needs the paced write path curia already has: two writes 1.5 seconds apart, and the text on ONE line, because the composer reads a newline as a submit.

**A sweep must fire only where the resolver is truly dead.** Run 2 is the cost of getting that wrong, and it is a silent one. The boot recovery loop over `reduction.openEscalations()` in `index.mjs` already names that set: at boot `pending` is empty, so every record in it lost its resolver. That is the only set a sweep may touch. An agent whose daemon is alive keeps the refusal it has today.

**The abort does not cost the session.** This was the open worry in #426, and it is answered: the transcript, the MCP connection and the pane all survive, and the agent goes back to work on the next turn.

**One line in the daemon was promising a delivery that never happens.** When an answer lands with no resolver, `handOffAnswer` told the thread that the agent "gets this answer with its next tool result". A parked codex agent makes no next tool result. Fixed on this ticket, in `handOffLine` in `daemon/src/messaging.mjs`.

The line now turns on a fact rather than on the harness alone. #458's goodbye ends every blocked call with an error before a planned death, so a codex agent usually has its turn back within a second, and the promise holds for it. The one that does not is the agent that has NOT spoken to this daemon process since it started. #194 already records that, as `mcpLastAt`. A SIGKILL is the death that leaves it empty, and that is the agent the warning is for. A young agent that has not spoken yet reads the warning too. That costs one warning nobody needed, where the other way round costs an answer.

The agent-note lines that carry the same phrase are NOT wrong, and they stay. A note is queued at any moment, and a working codex agent does make a next tool result. The hand-off line is the one that only ever runs after a death.

## What else the probe saw

**A codex agent in a PANE cannot call a curia tool until it searches for it.** The first request to the model offers no curia tool at all. It offers a `tool_search` tool whose own description names `curia` as a deferred source. The same server and the same config in the `exec` lane offer `mcp__curia__ask_human` and `mcp__curia__notify` upfront, which is what #371 recorded. Measured both ways, with the daemon's own `[features]` table and without it: the LANE decides, not the config. `codex features list` states `tool_search_always_defer_mcp_tools` as `removed true`, so the deferral is not a switch curia can turn off.

The daemon spawns the pane lane. So this is what every real codex agent meets, and no reading covers what it costs.

## What this does not measure

- **What a real model does with a `<turn_aborted>`.** The script obeys the next instruction. A model may apologize, re-plan, or read the abort as a stop signal. This is a model question, not a transport one.
- **The re-ask.** A revived agent has to ask its question again, and [#369](https://github.com/alp82/curia/issues/369) then replays the recorded answer if one landed. The stand-in holds no record, so no run here exercises that match.
- **A long park.** Every run parks the agent for seconds. A real SIGKILL can leave one parked for hours before the daemon returns.
- **The claude pane.** The refusal covers both lanes, and this reading is codex only.
- **The real daemon.** "The record stays open and the resolver survives" is read off `index.mjs`, not off these runs.

# A tool channel that breaks mid-session

Evidence for [wayfinder #341](https://github.com/alp82/curia/issues/341), on [map #244](https://github.com/alp82/curia/issues/244). Measured on 2026-08-15 inside an ordinary agent container, on the claude harness, CLI `2.1.220`. The harness is real. The daemon is a stand-in: [tool-channel-mid-session.probe.mjs](tool-channel-mid-session.probe.mjs), which serves curia's own `/mcp` route shape and nothing else.

## The question

[#194](https://github.com/alp82/curia/issues/194) closed the channel that never comes up. It ruled this case out of scope in its own words: after readiness, silence is what a healthy agent looks like, so the daemon cannot tell a mute agent from a busy one without a heartbeat, and a heartbeat is agent cooperation, which is the thing that fails here.

The ticket carried the fault forward as a premise: the channel dies mid-session, the agent keeps working, and no wire reaches back. This file tests that premise instead of building on it.

## What stands in for the daemon

The probe serves `POST /mcp?agent=&ticket=` with a stateless `StreamableHTTPServerTransport` and the `x-curia-agent-token` header, the way `daemon/src/index.mjs:1558` does. The agent reaches it through the `.mcp.json` and the two settings files `daemon/src/workspace.mjs` writes, with `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` at the daemon's own one day. A supervisor respawns the stand-in after it exits, the way `restart: on-failure` respawns the daemon.

Five deviations, all stated rather than hidden:

1. The agent runs headless (`claude -p`), not in a tmux pane.
2. The model is haiku. The transport is what is under test, and it carries no model.
3. The stand-in sends no keepalive, writes no journal and has no Discord bridge.
4. Client and server share one container, so the docker host gateway is not in the path.
5. The codex harness is not measured at all. See [What this does not measure](#what-this-does-not-measure).

## Run 1: the daemon dies under a blocking call

The agent calls `ask_human`. The stand-in dies three seconds later, while it holds the call. The supervisor brings it back 5.5 seconds after that.

| Time | What happened |
| --- | --- |
| 09:23:41.072 | `tools/call` `ask_human` arrives |
| 09:23:44.078 | the daemon exits, holding the call |
| 09:23:49.612 | a new daemon process listens on the same port |
| 09:25:43.619 | the agent's NEXT call arrives, on the new process |

The call failed. This is what the model was told, verbatim:

> MCP server "curia" transport dropped mid-call; response for tool "ask_human" was lost

**The wait is about two minutes.** The error reached the model 119.5 seconds after the daemon died, and the daemon had been back for 114 of them. Three runs of this case agree: 119.5 s, 118.9 s and 119.2 s from the death to the agent's next call. The comment at `daemon/src/workspace.mjs:575` called this a 90 second watchdog. The measurement says about 120, which is also where the harness moves a slow call to a background task.

**Nothing else was lost.** The two calls after the failed one succeeded on the new process, with no new handshake and no `initialize`.

## Run 2: the daemon is down when the call is made

The stand-in dies with no call in flight and stays down. The agent was told to call `notify` again and again until it succeeds. This run used a 45 second outage, which is longer than the agent's patience. The `refused` case in the probe uses 20 seconds, so the agent outlives it.

It made 25 attempts in about 40 seconds and gave up before the daemon returned. Every attempt failed the same way, in about 1.5 seconds:

> Unable to connect. Is the computer able to access the url?

So a call made into an outage fails fast and says so plainly. The client never stopped trying, and it never marked the server dead.

## Run 3: the tools come back by themselves

The same shape as run 2, with the outage cut to 20 seconds so the agent outlives it.

| Time | What happened |
| --- | --- |
| 09:30:20.829 | the daemon exits |
| 09:30:41.421 | a new daemon process listens |
| 09:30:41.944 | attempt 16 of the agent's `notify` arrives and succeeds |

**The channel needs no recovery.** The daemon's MCP server is stateless and the client opens a connection per call, so a restarted daemon is invisible to every call after the outage. Attempt 16 landed 0.5 seconds after the new process came up. It was an ordinary `tools/call`, not a handshake. A second run of this case took 16 attempts too, and landed 1.2 seconds after the new process.

## What this means

**The premise is wrong for a daemon that comes back.** Every deploy and every `POST /restart` restarts the daemon under live agents, and this measurement says the tool channel survives all of them. The channel only stays dead if the daemon does.

**One thing dies: the call in flight.** It costs about two minutes of agent time, and it costs the answer, which is a bigger loss than the call. The retry the standing orders ask for then works.

**[#56](https://github.com/alp82/curia/issues/56) recorded this from the agent's side** in [56-gateway-crash.md](../live-checks/56-gateway-crash.md), section 5, before anyone had measured it. That agent's `request_review` died with the same two sentences this probe produced. It then retried four times inside two minutes, met the same outage every time, and ended its turn. The rule was correct and the timing beat it.

**So the fix is a wait, not a mechanism.** The retry sits in the standing orders, and it fires within seconds of the failure. A restart takes seconds to a minute, and the transport takes two minutes to report the drop. An agent that retries once and stops is a healthy agent that gave up during an ordinary restart.

**The answer to a dead call is asked for twice.** The operator answers the card whose reader died. `settle` finds no resolver, so [#139](https://github.com/alp82/curia/issues/139) queues question and answer as an agent note and the thread says the agent gets it with its next tool result. The agent then re-asks. Supersede does not close the old record, because supersede only touches OPEN records (`daemon/src/store.mjs:405`) and this one is answered. So a second card carries the same question, the operator answers twice, and the queued answer only reaches the agent when the second answer returns the call. `drainNotes()` runs after the answer resolves (`daemon/src/index.mjs:1107`).

**The daemon has no reading to show.** It stamps the FIRST `/mcp` call per agent (#194) and nothing after it, so no surface can say when an agent last reached curia. That reading is what turns a silent agent into a fact the operator can judge.

## What this does not measure

- **The codex harness.** An agent container carries no codex credential, so this probe cannot run there. Codex bounds one tool call at 24 hours (`CODEX_TOOL_TIMEOUT_S`), and nothing on record says its client survives a transport drop the way this one does. That reading needs a dev session or a codex-lane dispatch.
- **A daemon that never comes back.** The agent's Stop hook rides curl to the same dead port, so its turn ends with nothing told to anyone. Section 5 of the #56 record is the only account of that state.
- **The live daemon on the box.** The stand-in has no keepalive, so this says nothing about a call that is held for hours and answered.
- **The pane.** A headless agent has no composer and no keystroke channel, so the note interrupt was not exercised.

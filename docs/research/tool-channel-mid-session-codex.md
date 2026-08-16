# The codex half of a channel that breaks mid-session

Evidence for [wayfinder #371](https://github.com/alp82/curia/issues/371), on [map #244](https://github.com/alp82/curia/issues/244). Measured on 2026-08-16 inside an ordinary agent container, on the codex harness, CLI `0.146.0`. Read it beside [tool-channel-mid-session.md](tool-channel-mid-session.md), which took the same two readings on the claude harness.

## The question

[#341](https://github.com/alp82/curia/issues/341) measured the claude harness and said what it had not measured. An agent container carries no codex credential, so its probe could not run there.

The claude reading is that the tool channel survives a daemon restart whole. The server is stateless, the client opens a connection per call, and only the call in flight dies. That call is reported after about 120 seconds, and the retry in the standing orders then works.

Nothing said codex behaves the same. Its client bounds one tool call at 24 hours (`CODEX_TOOL_TIMEOUT_S` in `daemon/src/workspace.mjs`), which is a hard deadline and not an idle timer. [#34](https://github.com/alp82/curia/issues/34) already found that the keepalive which saves the claude lane does nothing for it.

## What the credential problem cost, and what replaced it

The claude probe needed a model credential, and that is why it could not measure codex. [tool-channel-mid-session-codex.probe.mjs](tool-channel-mid-session-codex.probe.mjs) removes the credential from the path. It stands in for the MODEL as well as for the daemon.

Codex takes a local model provider on the Responses wire API, so the probe serves one and scripts the turn. The codex CLI is the real one, with the real MCP client and the real `tool_timeout_sec` the daemon writes. What it talks to is a script. The claude probe already made this trade in the other direction, and stated it: "the model is haiku. The transport is what is under test, and it carries no model."

So this probe needs no credential of any kind. It runs in an ordinary agent container, which is where these three runs were taken.

The stand-in daemon is the claude probe's, unchanged. It serves `POST /mcp?agent=&ticket=` with a stateless `StreamableHTTPServerTransport` and the `x-curia-agent-token` header, the way `daemon/src/index.mjs:1558` does. A supervisor respawns it after it exits, the way `restart: on-failure` respawns the daemon.

Six deviations, all stated rather than hidden:

1. The model is a script, not a model. See above.
2. The agent runs headless (`codex exec`), not in a tmux pane.
3. The stand-in sends no keepalive, writes no journal and has no Discord bridge.
4. Client and server share one container, so the docker host gateway is not in the path.
5. The scripted model paces itself. A real model takes seconds to answer, and a script takes milliseconds, so every step carries a pause. Without it the `refused` case spent all its retries before the daemon had even died.
6. Run 2 cuts `tool_timeout_sec` from a day to 60 seconds. That run exists to name the deadline, and the run beside it holds the daemon's own value.

## Run 1: the daemon dies under a blocking call

The agent calls `ask_human`. The stand-in dies three seconds later, while it holds the call. The supervisor brings it back 5.5 seconds after that.

| Time | What happened |
| --- | --- |
| 11:58:12.179 | `tools/call` `ask_human` arrives |
| 11:58:15.191 | the daemon exits, holding the call |
| 11:58:20.742 | a new daemon process listens on the same port |
| 12:08:10.677 | the probe's cap ends the run, with the agent still waiting |

**The agent is never told.** Codex sat in the call for the whole 595.5 seconds between the death and the cap, and the daemon had been back for 590 of them. The CLI printed `mcp: curia/ask_human started` and nothing after it. A second run agrees: 295.5 seconds to its own cap, and the same silence.

The claude harness reports this same drop in about 120 seconds. Codex has no such watchdog.

## Run 2: the same death, with the deadline cut to 60 seconds

Run 1 ends at a cap, so it names no deadline. This run cuts `tool_timeout_sec` to 60 seconds and lets the call die of its own accord.

| Time | What happened |
| --- | --- |
| 12:08:46.391 | `tools/call` `ask_human` arrives |
| 12:08:49.396 | the daemon exits, holding the call |
| 12:08:55.022 | a new daemon process listens on the same port |
| 12:09:46.437 | the call fails, 60.009 seconds after it was made |

This is what the model was told, verbatim:

> tool call error: tool call failed for `curia/ask_human`
>
> Caused by:
>     timed out awaiting tools/call after 60s

**So `tool_timeout_sec` is the only bound on a call whose daemon died.** The call failed at its deadline to the millisecond, 57.0 seconds after the death. A second run agrees at 60.007 seconds. The clock belongs to the CALL and not to the death, so an agent whose daemon dies waits the deadline minus whatever the call had already run. At curia's own value that is up to 24 hours.

The message is the shape [#34](https://github.com/alp82/curia/issues/34) already recorded from a live agent, `timed out awaiting tools/call after 300s`. It is the deadline speaking, not the transport.

**Nothing else was lost.** The two `notify` calls after the failed one succeeded on the new process, with no new handshake and no `initialize`.

## Run 3: the daemon is down when the call is made

The stand-in dies with no call in flight and stays down 20 seconds. The scripted agent calls `notify` once a second until it succeeds.

| Time | What happened |
| --- | --- |
| 11:57:37.569 | the daemon exits |
| 11:57:39.167 | the first refused attempt reaches the model, 1.6 s after the death |
| 11:57:58.154 | a new daemon process listens |
| 11:57:59.228 | the next attempt arrives and succeeds |

Every attempt into the outage failed in about 2 milliseconds. This is the first one, verbatim:

> tool call error: tool call failed for `curia/notify`
>
> Caused by:
>     Transport send error: Transport [rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker<codex_rmcp_client::http_client_adapter::StreamableHttpClientAdapter>>] error: Client error: HTTP request failed: http/request failed: error sending request for url (http://127.0.0.1:9010/mcp?agent=curia-371&ticket=371)

**The channel needs no recovery.** 19 attempts failed and the 20th succeeded, 1.07 seconds after the new process came up. It was an ordinary `tools/call` and not a handshake. A second run took 18 failures and landed 0.06 seconds after the new process.

So a call made INTO an outage fails fast and says so plainly, and the tools come back by themselves. That half matches the claude reading exactly.

## The two harnesses, side by side

| | claude | codex |
| --- | --- | --- |
| a call the daemon dies under | reported in about 120 s | NOT reported. The only bound is `tool_timeout_sec`, which curia sets to 24 hours |
| what the agent is told | `MCP server "curia" transport dropped mid-call; response for tool "<tool>" was lost` | `timed out awaiting tools/call after <n>s`, at the deadline |
| a call made into an outage | fails in about 1.5 s | fails in about 2 ms |
| the tools after the restart | work, with no handshake | work, with no handshake |

## What this means

**One half matches and one half does not.** A restarted daemon is invisible to every call after the outage on both harnesses. The call in flight is where they part.

**The retry rule cannot fire on the codex lane.** #341 gave the standing orders a ladder: retry at once, then after two minutes, then after five. Every rung needs an error to retry, and a codex agent gets no error for up to a day. It is not that the agent retries too early. It never gets its turn back.

**The deadline now serves two jobs, and they pull apart.** #34 raised `CODEX_TOOL_TIMEOUT_S` to a day because the 300 second default killed calls where a human simply took their time. That same number is the only thing that ends a call whose daemon died. A value that is generous to a slow human is a value that parks a stranded agent for a day, and one number cannot be both.

**The cost is bigger than the wait.** A claude agent loses about two minutes and the answer. A codex agent loses its whole session to a restart it never hears about: no error, no retry, no Stop hook, and no report. Every deploy and every `POST /restart` can do this to a live codex agent that holds a blocking call.

**What to do about it is a decision, not a reading.** This ticket took the reading. The trade against #34 belongs to its own ticket.

## What else the probe saw

The pinned codex does not offer an MCP tool as a function of its own. It offers the SERVER as one tool of type `namespace`, named `mcp__curia`, with the server's tools nested inside it. The model names one with a `function_call` that carries the namespace beside the bare tool name. A flat `mcp__curia__notify` name is answered by the CLI's router with `unsupported call`. This is the tool surface [#172](https://github.com/alp82/curia/issues/172) bounds, seen from the wire.

## What this does not measure

- **The live daemon's keepalive.** The stand-in sends none, so this adds nothing to #34's finding that the keepalive does not move the codex deadline. It also changes nothing here: a dead daemon sends no keepalive either way.
- **A daemon that never comes back.** The agent's Stop hook rides curl to the same dead port, so its turn ends with nothing told to anyone. Section 5 of the [#56](https://github.com/alp82/curia/issues/56) record is the only account of that state.
- **The pane.** A headless agent has no composer and no keystroke channel, so the note interrupt was not exercised. That channel matters more here than on the claude lane, because it is the one wire that still reaches a parked codex agent.
- **A real model.** The script never gets tired, never gives up and never misreads an error. What an actual codex model does with a 24 hour silence is not a transport question, and no run here answers it.

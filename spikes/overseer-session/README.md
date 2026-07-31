# Spike: overseer session

Prototype for [Prototype the overseer session (#83)](https://github.com/alp82/curia/issues/83), on the ranked pick from [the hosting research](../../docs/research/overseer-session-hosting.md). Throwaway code.

## What it is

A standalone bot process beside the daemon. It watches one Discord channel (`#curia-overseer`). A top-level message opens a thread and a fresh overseer session. A later message in the thread revives the session with full memory. The session runs `claude-haiku-4-5` through the Agent SDK, one `query()` per message.

The session acts only through five in-process MCP tools: `tickets`, `status`, `start`, `cancel`, `attach`. Each tool posts canonical verb text to the live daemon at `POST /command` — the same seam the Discord slash commands and REST use. The daemon executes every effect. The session has no shell, no files, and no process handles.

The thread-to-session map is `sessions.jsonl` in this directory. The process replays it at boot, so a restart loses no conversation.

## Run it

The daemon must run first (it answers `/command` on port 4271).

```
cd spikes/overseer-session
npm install
npm start
```

The process reads `daemon/.env` for `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS`, and `CURIA_GUILD_ID`. It shares the daemon's bot token. That is safe: the daemon's bridge only reacts to its own threads and slash commands, and this spike only reacts inside `#curia-overseer`.

Optional environment overrides: `OVERSEER_MODEL` (default `claude-haiku-4-5`), `OVERSEER_CHANNEL` (default `curia-overseer`).

## What to try

1. Write `what is curia working on right now?` as a top-level message in `#curia-overseer`. The router cannot parse this. The overseer must call `status` and summarize.
2. Write `what should I start next?`. The overseer must call `tickets` and recommend one with a reason. The router has no such verb.
3. Tell it to start that ticket, in prose.
4. Ask it to cancel the ticket. It must confirm in conversation before the tool call.
5. Ask it to approve an open review gate. It must refuse (never-list).
6. Restart the spike process, then write in the same thread. The session must remember the conversation.

## What it measures

- `resume` continuity across a process restart (journal replay + SDK session files).
- Credential inheritance under a dedicated `CLAUDE_CONFIG_DIR` with `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointed at the host store (the open question from the research).
- Haiku 4.5 tool-call reliability on the verb catalogue, and revival latency per message (logged per turn, with cost).

# curia daemon

The always-on daemon from map decision [#9](https://github.com/alp82/curia/issues/9): worker-facing MCP surface + Discord bridge module + durable escalation record ([#31](https://github.com/alp82/curia/issues/31)). Substrate-agnostic — workers connect over streamable-HTTP MCP regardless of how they were spawned (#29).

## Run

```
npm install
npm start          # reads daemon/.env
```

`.env` (never committed):

- `DISCORD_BOT_TOKEN` — CuriaBot token. Omit to run REST-only (escalations stay answerable via `POST /answer`).
- `DISCORD_ALLOWED_USERS` — comma-separated Discord user ids; the auth gate. The bridge refuses to start if empty.
- `CURIA_GUILD_ID` (optional — defaults to the bot's first guild), `CURIA_CHANNEL` (default `curia`), `PORT` (default 4271), `NUDGE_MS` (default 30 min).

## Surfaces

- `POST /mcp?worker=<name>&ticket=<n>` — MCP tools `ask_human` (blocking), `notify`, `report_result`. Ticket binding rides the spawn URL (#11).
- `GET /state` — open escalations + bridge status.
- `POST /escalate` — synthetic escalation (testing / non-MCP emitters); `?wait=1` blocks until answered.
- `POST /answer {id, answer}` / `POST /cancel {id}` — same first-valid-wins gate as Discord.
- `POST /worker_done?worker=` — Stop-hook webhook (#29).

## State posture

`data/events.jsonl` is the only durable artifact — an append-only journal; in-memory state is a pure reduction over it, rebuilt on boot. Open escalations survive daemon restarts with their Discord message ids intact (the rebooted process still honors clicks on messages posted before the restart — verified live). The pending-resolver map and ticket→thread cache are ephemeral (#9); a restart loses only the in-process worker call (accepted re-dispatch posture, #11/#12).

Supersede (#29): a re-issued `ask_human` (same worker + same payload while an older escalation is open) closes the old record, strips its buttons in Discord, and routes late answers to the live successor.

Deferred: voice-memo STT (text parity is the PoC floor, #31 scope note); the slash-verb relay logs canonical text to the journal — interpretation lands with the overseer session (#18).

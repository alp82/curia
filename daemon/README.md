# curia daemon

The always-on daemon from map decision [#9](https://github.com/alp82/curia/issues/9): worker-facing MCP surface + Discord bridge module + durable escalation record ([#31](https://github.com/alp82/curia/issues/31)) + the dispatch loop ([#33](https://github.com/alp82/curia/issues/33)). Substrate-agnostic — workers connect over streamable-HTTP MCP regardless of how they were spawned (#29).

## Run

```
npm install
npm start          # reads daemon/.env
npm test           # unit tests (frontier / routing / commands)
```

`.env` (never committed):

- `DISCORD_BOT_TOKEN` — CuriaBot token. Omit to run REST-only (escalations stay answerable via `POST /answer`).
- `DISCORD_ALLOWED_USERS` — comma-separated Discord user ids; the auth gate. The bridge refuses to start if empty.
- `CURIA_GUILD_ID` (optional — defaults to the bot's first guild), `CURIA_CHANNEL` (default `curia`), `PORT` (default 4271), `NUDGE_MS` (default 30 min).

Config (validated on load; a bad shape refuses the boot): `../config/curia.yaml` (watch list, dispatch settings — `auto_dispatch` ships `false` — attach ports) and `../config/routing.yaml` (label-only model routing, fallback chains, backend command templates). Override the directory with `CURIA_CONFIG_DIR`.

## Surfaces

- `POST /mcp?worker=<name>&ticket=<n>` — MCP tools `ask_human` (blocking), `notify`, `report_result`. Ticket binding rides the spawn URL (#11).
- `GET /state` — open escalations + bridge status.
- `POST /escalate` — synthetic escalation (testing / non-MCP emitters); `?wait=1` blocks until answered.
- `POST /answer {id, answer}` / `POST /cancel {id}` — same first-valid-wins gate as Discord.
- `POST /worker_done?worker=` — Stop-hook webhook (#29); closes the dispatch lifecycle (result recorded ⇒ clean close; result-less ⇒ abnormal exit, session kept for post-mortem).
- `POST /command {text}` — canonical command text, REST parity with the Discord slash verbs.
- `POST /reconcile` — on-demand reconcile (boot reconcile runs automatically).

## The five verbs (Discord slash commands or `POST /command`)

- `frontier [owner/repo]` — takeable tickets per watched repo (map lane with deferred-map skip and multi-map union, or flat `ready-for-agent` lane per watch-entry `mode`).
- `start <n>` / `start owner/repo#<n>` (`model=x backend=y` optional) — claim the GitHub issue, carve a worktree off the daemon-owned base clone under `workspace_root`, spawn a Claude Code worker in tmux `curia-<n>` with a pre-seeded `CLAUDE_CONFIG_DIR` (no first-run dialogs), watch for readiness. Anomalies (assigned/blocked/already-live) ask for an approve-reject confirm first.
- `status` — live workers + tmux cross-check.
- `cancel <n>` — confirm-then-teardown: kill session, remove worktree, unassign (re-frontier).
- `attach <n>` — `https://<tailnet-dns>:<serve_port>/?arg=curia-<n>` via the shared ttyd; `bin/curia-attach.sh` whitelists `^curia-[A-Za-z0-9._-]+$` (hard requirement — ttyd `-a` would otherwise hand out attach to any tmux session). ttyd also runs with `-O` (`--check-origin`): without it any web page open on any tailnet-connected device could hijack a worker's terminal cross-origin, since the victim's browser supplies the network position. What `-O` actually enforces (verified in ttyd's `src/protocol.c`) is `Origin == Host` — a same-origin *browser* control, not an allowlist: a mismatched `Origin` is refused at the WebSocket upgrade, but a DNS-rebinding page whose Host and Origin match each other passes. Auth in front of ttyd (basic-auth / identity header) remains deferred.

## State posture

`data/events.jsonl` is the only durable artifact — an append-only journal; in-memory state is a pure reduction over it, rebuilt on boot. Open escalations survive daemon restarts with their Discord message ids intact (the rebooted process still honors clicks on messages posted before the restart — verified live). The pending-resolver map and ticket→thread cache are ephemeral (#9); a restart loses only the in-process worker call (accepted re-dispatch posture, #11/#12).

Supersede (#29): a re-issued `ask_human` (same worker + same payload while an older escalation is open) closes the old record, strips its buttons in Discord, and routes late answers to the live successor.

Dispatch state follows the same posture (#33): the workers map is a disposable in-memory cache. Reconcile (boot + on demand) re-derives it from GitHub claims, `tmux ls` and the journal — epoch-scoped (journal events only count against a ticket's latest dispatch), orphan sessions swept and dead claims released only on positive gh evidence, open overseer confirms voided on boot (the resolver died with the old process). Provider/model cooling is in-memory only and expires at the provider's stated reset (or a journalled 1 h fallback).

Deferred: voice-memo STT (text parity is the PoC floor, #31 scope note); the overseer NL agent session — canonical text currently routes to the deterministic in-daemon command router (stated #18 deviation); the gpt/codex backend lane (a config addition to `routing.yaml` once its follow-up ticket lands).

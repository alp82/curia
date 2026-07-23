# One worker, two channels: the side-channel-driven worker lane, prototyped

Resolves [#29](https://github.com/alp82/curia/issues/29) — can one worker session be both **structurally driveable by the daemon** and **multi-client attachable by humans**, without the daemon ever parsing a terminal? Run 2026-07-24 on Alp's desktop (same Hetzner stand-in as #19/#24/#25). Spike code: [`spikes/worker-two-channels/`](../../spikes/worker-two-channels/).

**Answer: yes — verified live on both substrate models, with one worker config that is substrate-independent.** The same Claude Code worker (identical workspace-scoped side-channel harness) ran the full golden-thread inner loop under **herdr** (PTY substrate) and under **Paseo** (message-level substrate): `notify` → blocking `ask_human` → REST answer → resume → real git commit → structured `report_result` → Stop-hook `worker_done`, while a second human client attached mid-run. The daemon's knowledge of the worker came entirely from its own side channels; scrollback was never parsed.

## The harness

One stub daemon process (`daemon/server.mjs`, ~150 lines, MCP SDK), two surfaces:

- **MCP side channel** — streamable-HTTP endpoint `POST /mcp?worker=<name>`, serving #11's contract: `ask_human(kind, prompt, options, preview_url)` (blocks the tool call until answered; durable JSONL record on open and on answer), `notify(msg)`, and the spike's core unknown, `report_result(ticket, status, summary, details)`.
- **REST control surface** — `GET /state` (open escalations), `POST /answer` (the Discord-bridge stand-in; first valid answer wins, closes atomically), `POST /worker_done` (webhook target for the worker's **Stop hook**).

Worker-side config is **entirely workspace-scoped** — `.mcp.json` (points at the daemon MCP URL, worker name in the query string) plus `.claude/settings.json` (`enableAllProjectMcpServers`, bypassPermissions, Stop hook `curl`ing `/worker_done`) — so the identical harness rode both substrates unchanged. Per-worker isolation was a fresh `CLAUDE_CONFIG_DIR` (seeded with credentials + pre-accepted trust/onboarding flags), injected per spawn: `herdr agent start --env` and `paseo run --env` both take it first-class.

## Run A — herdr (PTY substrate): all four axes PASS

`herdr agent start w2 --cwd <ws> --env CLAUDE_CONFIG_DIR=<cfg> -- claude --model sonnet "<ticket prompt>"`.

- **Escalation**: `notify` landed 12 s after spawn; `ask_human(choice)` opened and the worker sat **blocked in the tool call for 46 s** until `POST /answer` resolved it. Resume was immediate.
- **Attach mid-run**: while the escalation was open, a second full-app `herdr` client (hosted in tmux, standing in for the PC) attached: it rendered the live TUI (spinner, tool call in flight, sidebar `working · w2`) and **keystrokes typed in the second client landed in the canonical composer** — human channel and daemon channel simultaneously live, no interference.
- **Result capture**: `report_result` delivered `{ticket: DEMO-1, status: resolved, commit: cdbfe21, title: Overseer}` — sha matches the real commit the worker made.
- **Lifecycle**: the Stop hook POSTed `worker_done` (with the worker's session id) **2 s after** `report_result`. Ordering `result → worker_done` held.

## Run B — Paseo (message-level): all four axes PASS, plus steering, plus one sharp edge

`paseo run --detach --json --provider claude --model sonnet --mode bypassPermissions --cwd <ws> --env CLAUDE_CONFIG_DIR=<cfg> --label ticket=DEMO-2 "<ticket prompt>"` — dispatch returns an agent id and the CLI disconnects; `--label` carries the ticket binding.

- Same event chain end-to-end: `notify` → blocking `ask_human` → answer → commit `1e87a19` → `report_result` (sha correct) → Stop-hook `worker_done` 7 s later. Same workspace harness, zero changes.
- **Attach**: the "second client" is any client on the broadcast timeline — `paseo logs` replayed the live turn (user message, tool calls in flight); a **mid-turn steering message** sent from it (`after your commit, also call notify 'steer-ack'`) was honored: the worker committed, then sent `steer-ack`. Message-level attach = observe + steer, with per-message attribution.
- **Sharp edge — steering aborts in-flight blocking tool calls.** The injected message interrupted the open `ask_human` call; Claude re-issued it, so a **duplicate escalation** (`esc-3`) opened while `esc-2` still looked answerable, and the answer posted to `esc-2` resolved a dead call (the daemon reported success; the worker never saw it). The run only completed because the live `esc-3` was answered too.

## What this decides

1. **The worker-driving question is now substrate-independent.** Escalation, lifecycle, and result capture all ride curia-owned side channels (MCP tools + Stop hook) that behave identically on a PTY substrate and a message substrate. [Pick the substrate](https://github.com/alp82/curia/issues/30) is therefore **freed from the driving axis entirely** — it should be decided on ops qualities (restart hygiene, footprint, URL surface, voice, worktrees), not on how the daemon talks to workers.
2. **`report_result` works and is the right resolution primitive** — structured, verifiable (shas matched), arrives *before* `worker_done` in both runs, so the daemon can treat `worker_done`-without-result as an abnormal-exit signal.
3. **What "attach" minimally means** (the destination's "PC attaches to the same live session" beat): *observe the live turn + inject input into it, on the canonical timeline*. Message-level attach delivers both, and is arguably the better fit for how curia actually drives workers (prompts, steering, escalation answers — not keystrokes). **The PTY question dissolves for driving.** What PTY attach still uniquely buys is (a) watching the agent's own TUI raw, and (b) a hand on interactive dialogs that only render in a terminal — which matters because of finding 4.
4. **First-spawn dialogs remain the PTY lane's residue (#19 family, new instance).** Under herdr, the worker stalled on Claude Code's "Allow external CLAUDE.md imports?" dialog (the spike workspace nests inside the curia repo, whose `CLAUDE.md` imports `AGENTS.md`) *despite* pre-seeded trust flags — dispatch had to send a keystroke. Under Paseo's stream-json lane the same workspace produced **no blocking dialog**. Dispatch-time auto-answer (or config pre-seeding verified per dialog class) is mandatory for any PTY lane; the message lane dodges the class.
5. **The escalation record must survive tool-call re-issue** (new hard requirement for [#31](https://github.com/alp82/curia/issues/31), sibling of #28's unanswerable-REST finding): any mid-turn interruption (Paseo steering here; any substrate's interrupt generally) can abort an open `ask_human` and re-open it under a new id. The bridge must (a) detect the re-issue (same worker + same payload while an older escalation is open), (b) supersede the dead record so devices can't answer a corpse, and (c) route late answers to the live call. Timeout-only cleanup leaves a window where the human answers the dead button.
6. **Per-worker `CLAUDE_CONFIG_DIR` works everywhere but cuts both ways**: both spawn APIs inject it cleanly, and it isolates host config as required (#23/#24/#26) — but it also bypasses host-installed substrate integrations (herdr's `~/.claude/hooks` state hook never loads), which is fine for curia (lifecycle is hook-based on curia's side) and consistent with #25's ruling that substrate state detection is not the escalation channel.

## Caveats

- The human side of both `ask_human` round-trips was driven by the operator harness over REST (AFK run, same posture as #22/#23/#28); the Discord rendering of the same record is [#31](https://github.com/alp82/curia/issues/31)'s build, and click→resume over Discord was already closed live in #22.
- Blocking calls were held open for ~1–3 min only; #11's indefinite-block + re-nudge posture over streamable HTTP (proxy/idle timeouts on a real box) is unproven here — fold into the escalation build spike.
- Images over the side channel were not exercised (standing fog item; protocol-level support verified in #23).

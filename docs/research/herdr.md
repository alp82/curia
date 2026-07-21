# herdr (ogulcancelik/herdr, "tmux for AI agents") — primary-source research

Date: 2026-07-21. Sources: site https://herdr.dev and its `/docs/*` pages (persistence-remote, session-state, socket-api, integrations, plugins); repo `ogulcancelik/herdr` at commit `7c18900` (master, 2026-07-21) — README, LICENSE, `src/` (`server/`, `remote/`, `persist/`, `api/`, `agent_resume.rs`, `integration/`), CHANGELOG; GitHub API for stats. herdr.dev unambiguously maps to this one repo (site header/footer link, README badges); no competing "herdr" tool found.

**Verdict.** herdr is a **worker-substrate host, not a dispatcher or a bridge.** It is "tmux for AI agents" — a single Rust binary that runs multiple coding-agent CLIs (Claude Code, Codex, Pi, Hermes, etc.) in persistent PTY panes inside a background server you attach to from any terminal, including over SSH from a phone. For curia it cleanly fills the **worker-hosting / live-session-substrate** layer and gives you free multi-device attach and detach-survival, but it has **no ticket queue, no cron, no routing rule, no ticket state store, no Discord, no voice, and no HTTP/WebSocket endpoint** — remote access is SSH-tunneled to a Unix domain socket, so a phone reaches a session through an SSH terminal app, not a URL. In-flight agent turns do **not** survive a full server restart; herdr instead re-launches the agent with its native resume flag (`claude --resume <id>`, `pi --session <id>`), losing the interrupted turn. It is AGPL-3.0-or-later (dual-licensed with a paid commercial option) and a ~4-month-old solo-maintainer project (19k stars). Curia would build its dispatcher and Discord/voice bridge itself and drive herdr's socket API to spawn/observe/wait-on worker panes — herdr is the layer those sit on top of.

## Role fit

herdr fills the **worker-substrate / live-session host** role and none of curia's other two.

- **Worker host: strong, and this is its whole identity.** herdr is a **terminal multiplexer for agents** — "agent multiplexer that lives in your terminal… every agent at a glance — blocked, working, done… detach, agents keep running" ([`README.md:25-32`](https://github.com/ogulcancelik/herdr)). It runs your agent CLIs in PTY panes; it does not itself call any model provider. Its **pure socket API** — "agents spawn panes, read output, wait on each other" (`README.md:29`) — is a clean substrate an external dispatcher can drive: `pane.split`, `agent.start`, `pane.report_agent`, subscribe/`wait` on `working`/`blocked`/`done` ([socket-api docs](https://herdr.dev/docs)).
- **Dispatcher: no — no such machinery exists.** Source searches for queue/cron/schedule/dispatch/routing surface only internal plumbing, never a ticket system: `schedule*` = internal timer tasks like `schedule_session_save` (`src/app/runtime.rs:221`); `queue` = the render/event queue (`src/pane.rs:179`); `dispatch` = internal API-method dispatch (`src/app/runtime_mutations.rs:12`); `routing` = mouse-wheel/input routing (`src/pane.rs:1077`). `cron` = 0 files. There is no work-item concept, backend-selection rule, or ticket state store — herdr persists *session/layout* state only.
- **Bridge: no.** No Discord, no chat, no voice, no push surface (see the next three sections).

## Discord support

**None in core.** `discord` appears only as a test-fixture plugin-path string (`platforms/discord`) inside a Hermes-agent plugin-list config-conversion test (`src/integration/tests.rs:2382`, `fn install_hermes_preserves_flat_plugin_list`); no such plugin ships, and there is no Discord code, webhook code (`webhook` = 0 files), or bot in the repo. Notifications are **local only** — `src/server/notifications.rs` emits terminal/system **toasts** (`ToastDelivery::Terminal` / `::System`), not chat messages. There are **no native HITL buttons**: "blocked" is a detected agent *state* surfaced in the TUI, not an interactive chat prompt.

The one adjacent primitive: the plugin system can "send notifications by calling… external services" and run background processes, and the official examples include **`agent-telegram-notify`** (`src/cli/plugin.rs:1756`, `src/plugin_paths.rs:116`) — a **one-way outbound** Telegram notifier. A Discord equivalent is buildable the same way, but it would be one-way notify, not a two-way HITL bridge, and you would write it.

## Voice input

**None.** No transcription, dictation, voice-memo, or Whisper. `whisper` / `dictation` / `voice-memo` = 0 files. The two `voice` hits are unit-test names about wide-character handling (`long_multilingual_voice_like_burst`, `src/raw_input.rs:2061`; `route_client_input_forwards_long_voice_like_cjk_text`, `src/app/mod.rs:4977`) — unrelated to audio. All 15 `transcri*` hits refer to **agent session transcript files** (text logs used for session-identity restore, e.g. `src/integration/assets/claude/herdr-agent-state.ps1:41`; Codex `transcript_viewer` state detection, `src/detect/manifests/codex.toml:23`) — not audio. Voice would be solved entirely upstream and handed to herdr's agents as text.

## Session attach/sharing across devices

**Yes for viewing across devices; single-writer for input; SSH-tunneled, not a network server.** herdr uses a **background-server model**: the headless server "listens on both `herdr.sock`… and `herdr-client.sock`… Streams frames to connected clients after each render… Continues running after client disconnect" (`src/server/headless.rs` module doc). Rendering is per-client ("Per-client render baseline for the negotiated render encoding," `src/server/render_stream.rs:12`), so **a phone and a PC can both attach to the same live session** — docs confirm "Multiple observers can watch the same terminal without taking input, resize, scroll, or takeover ownership" ([persistence-remote](https://herdr.dev/docs)).

- **Input is single-owner per terminal** — "Only one writable direct attach client owns input and resize for a terminal," with a `--takeover` flag to steal it (persistence-remote). So phone + PC can both *watch*, but only one drives a given pane at a time.
- **Transport is SSH, not an exposed daemon.** `herdr --remote` "connects over SSH, starts or attaches to the remote Herdr server, and streams the UI back to your local terminal" (persistence-remote). The sockets are a Unix domain socket / Windows named pipe (`src/remote/unix.rs`, `src/server/socket_paths.rs`); there is **no HTTP/WebSocket/TCP endpoint** (`websocket` appears only inside an error-matching regex, `src/integration/assets/omp/herdr-agent-state.ts:77`). **Implication for curia:** a phone reaches the session via an SSH terminal app, not a browser URL — herdr provides no web/WS surface for a phone client, so the "preview link opens from the phone" and "PC attaches to the live session" requirements split: attach works over SSH; a browser-openable surface does not exist in herdr.

## Restart survival

Mixed — the sharpest limitation for curia.

- **Detach/reattach: full survival.** The background server keeps processes running; "panes and agents keep running. Reattach by running `herdr` again" (README/docs). The process never stopped, so screen and layout return intact.
- **Full server restart: processes are lost.** Layout is restored from a saved session snapshot (`src/persist/snapshot.rs`, `restore.rs`), and screen content returns only "with pane screen history" or via **native agent session restore** — herdr re-invokes the agent with its resume flag, e.g. `claude --resume <id>` or `pi --session <path-or-id>` (session-state docs; mechanism in `src/agent_resume.rs`, `AgentResumePlan`). So an **in-flight turn does not survive a mid-turn kill**: the agent subprocess dies, and on restart herdr starts a *new* agent process resumed to the last saved session checkpoint, not the interrupted turn.
- **Live handoff (`--handoff`): experimental, opt-in.** Asks an old server to transfer live panes to a new server so processes survive a *server replacement* (e.g. a binary update), "best effort for supported running servers" (`src/server/handoff.rs`, session-state docs). Not general crash recovery.
- **Supervision: none built in.** No systemd/launchd/service integration (`systemd` = 0 files). The server is a self-managed background process, not a supervised daemon — if the host reboots or the server is killed, nothing auto-restarts it; you rerun `herdr`, which then restores layout and resumes eligible agents. Supervision is curia's responsibility (systemd unit around the herdr server).

## Self-hostability

**Strong.** Single **Rust binary, no Electron** (`README.md:32`). Install via `curl -fsSL https://herdr.dev/install.sh | sh`, `brew install herdr`, `mise use -g herdr`, prebuilt release binaries, or a **Nix flake** (`flake.nix` in repo); builds from source with `cargo build --release`. Runs fine on a plain Linux/Hetzner box — it needs only a PTY and a terminal, and remote access is over ordinary SSH.

**Model-provider support is agent-agnostic by design:** herdr never talks to a model provider itself; it multiplexes whatever agent CLIs you run, so provider support equals whatever your agent CLI (Claude Code, Codex, OpenCode, Cursor, Copilot, Devin, Pi, Hermes, …; integrations docs) supports. No forced account or login observed for local/self-hosted use. There is an update-check path (`src/update.rs`, `src/product_announcements.rs`) that contacts herdr.dev for release notes/announcements — whether it is disable-able and what it transmits was not verified (see Gaps).

**License caveat:** herdr is **AGPL-3.0-or-later** (`LICENSE`, `README.md:83-88`), dual-licensed with a paid commercial option (hey@herdr.dev). If curia modifies herdr and exposes it over a network to users, AGPL's network-copyleft obligations apply — the same class of entanglement flagged for Paseo (AGPL-3.0). Driving an *unmodified* herdr binary via its socket API from separate curia code is the clean path.

## Maturity / license

From the GitHub API on 2026-07-21:

- **Stars 19,035 · forks 1,243 · open issues 79.** Very popular, very young: **created 2026-03-27** (~4 months old), last push 2026-07-21.
- **License:** dual — **AGPL-3.0-or-later** OR commercial (`LICENSE`). GitHub reports `NOASSERTION` because the file leads with the dual-license header; the README badge and text confirm AGPL-3.0.
- **Release cadence:** rapid, pre-1.0. Latest stable **v0.7.4 (2026-07-15)**; tags v0.7.0→v0.7.4; near-daily `preview-*` builds (e.g. 2026-07-16, -07-17). Large active CHANGELOG.
- **Bus factor: ~1.** Top contributors: `ogulcancelik` 996 commits; then bots (`kangal-bot` 54, `github-actions` 43, `akbash-bot` 22); the largest *human* external contributors have ~4 commits each (`dmmulroy`, `LaneBirmingham`). Effectively a solo-maintainer project, built "full-time, in the open," funded via GitHub Sponsors (gold sponsor Terminal Trove). No backing company; a commercial-license offer exists but no named org.

## Verdict for curia

- **Fills — worker substrate / live-session host.** Best-in-class for running the coding-agent CLIs, keeping them alive on detach, and letting a phone (SSH terminal) and a PC attach to the same live session. Its socket API (`pane.split`, `agent.start`, `pane.report_agent`, subscribe/`wait` on `working`/`blocked`/`done`) is a clean substrate an external dispatcher can drive. This is the layer curia's dispatcher and bridge sit on top of — comparable to pi's worker role but with multiplexing and multi-device attach that pi lacks (pi is point-to-point subprocess stdio; herdr is a shared background server).
- **Does not fill — dispatcher.** No ticket queue, cron, scheduling, routing rule, or ticket state store. Curia must build the entire dispatcher and provide the "state home"; herdr stores only session/layout state.
- **Does not fill — bridge.** No Discord, no two-way HITL buttons, no voice/transcription, no HTTP/WebSocket surface for a phone app. The "blocked" state exists but is surfaced in-TUI, not pushed to chat, and there is no browser-openable session URL.
- **What curia must build around it:**
  1. A **dispatcher** (queue + routing rule + persistent ticket state) that calls herdr's socket API to spawn a worker pane and `wait` on its agent state.
  2. A **Discord/voice bridge** service: subscribe to herdr's agent-status changes → when a worker goes `blocked`, post the HITL question to Discord; take the (curia-transcribed) reply and send it back via the socket API to resume the worker. herdr's `agent-telegram-notify` example plugin is the closest primitive and is one-way only.
  3. Your own **supervision** (systemd unit) around the herdr server, plus awareness that a mid-turn kill loses the in-flight turn and only resumes to the last agent-session checkpoint.
- **Natural pairings:** herdr as the worker/attach layer; a purpose-built dispatcher (or Hermes's built-in dispatcher — see the hermes-agent eval) above it; a Discord bot + Whisper transcription as the bridge. Note the overlap with Hermes and Paseo: **all three can host workers**, but herdr's differentiator is terminal-native multiplexing + SSH multi-device attach with detach-survival, whereas Paseo offers daemon/multi-client attach and Hermes offers the dispatcher+Discord bridge herdr lacks. herdr competes most directly with Paseo for the "worker host / session substrate" slot, not with Hermes for dispatch.

## Gaps / unknowns

- **Concurrent *writable* full-app clients:** docs confirm multiple *observers* and single-writer *per terminal*, but do not spell out whether two full-app clients can each hold input on *different* panes of the same session simultaneously (likely yes given per-client render baselines — inferred, not documented).
- **Telemetry opt-out:** `src/update.rs` / `src/product_announcements.rs` contact herdr.dev for updates/announcements; whether this is disable-able and what it transmits was not verified.
- **In-flight-turn durability granularity:** the exact checkpoint granularity of "native agent session restore" depends on each agent CLI's own resume behavior, not herdr; not independently tested.
- **`platforms/discord`:** confirmed only as a test-fixture plugin-path string, not a shipped plugin; whether a *community* Discord plugin exists in the marketplace (GitHub topic `herdr-plugin`) was not enumerated.
- **Live-handoff reliability:** `--handoff` is labeled experimental/best-effort; not tested for whether it reliably preserves running agent processes across restarts.
- Docs were read via the site's rendered pages and the repo's `docs/next/` MDX at commit `7c18900`; a couple of non-rubric doc pages (keyboard, concepts) were not read exhaustively.

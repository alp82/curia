# Orca (stablyai/orca) — primary-source research

Date: 2026-07-22. Sources: repo cloned at commit `6ad6241` (main, 2026-07-22) — README, `docs/reference/` (headless-linux-server.md, remote-agent-session-host-authority.md), `src/` (`main/`, `cli/`, `relay/`, `shared/`), `mobile/`, `skills/`, LICENSE; GitHub API for stats/releases/contributors. All file paths below are relative to the repo root. The official docs site (onorca.dev/docs) was not fetched; every claim here is source-verified from the repo instead.

**Verdict.** Orca is the **strongest substrate candidate found for curia** — it is the only tool evaluated that meets curia's hard requirement of concurrent multi-device attach *with in-flight-turn restart survival*. It is an Electron "agentic development environment": one runtime (desktop app or standalone headless `orca serve`) hosts **any CLI agent** in PTYs inside git worktrees, and desktop, iOS/Android app, a **browser web client served by the runtime itself**, and a scriptable `orca` CLI all attach to the same live sessions. Its decisive differentiator over Paseo and herdr: PTYs live in a **detached daemon process** that survives runtime quit/restart ("normal quits keep the detached daemon for warm reattach", `src/main/index.ts:2484`), so an `orca serve` restart does **not** kill running agent turns — the failure mode Paseo and herdr both have. It also has built-in dictation (local ONNX STT on the host or OpenAI), usable from the phone against a headless server. Headless Linux/VPS is a documented first-class target (systemd + Tailscale guide). License is MIT, and it is company-backed with 100+ contributors and multiple substantial committers — the best maturity profile in the field. What it is **not**: a dispatcher (cron automations + an experimental agent-orchestration layer exist, but no ticket queue, no webhook triggers, no routing policy) and **not** a bridge (zero Discord code; notifications are mobile push + in-app). Main caveats: it is a full Electron/Chromium app even headless (needs Xvfb, heavier than Paseo's Node daemon or herdr's Rust binary), ~4 months old with very fast churn (CLI flags explicitly unstable between releases), 1,991 open issues, and off-LAN mobile connectivity routes through Orca's cloud relay (`relay.onorca.dev` + Orca Cloud login) — though Tailscale-direct is the documented path that avoids it entirely.

## Role fit

- **Substrate / live-session host: excellent — this is its identity.** "Run Codex, ClaudeCode, OpenCode or Pi side-by-side — each in its own worktree, tracked in one place"; "Works with **any CLI agent** — if it runs in a terminal, it runs in Orca" (README, ~30 agents listed). Like herdr, Orca is agent-agnostic: it multiplexes agent CLIs in PTYs and never calls a model provider itself. Native **agent hooks** report structured status `working | blocked | waiting | done` (`src/shared/agent-status-types.ts:15`, hooks in `src/main/agent-hooks/`, remote ingest via `src/relay/agent-hook-server.ts`) — the same agent-awareness that is herdr's differentiator, plus worktree isolation, diff review/annotation, an embedded browser, and GitHub/Linear task panes on top.
- **Dispatcher: partial, cron-shaped only.** `src/main/automations/` is a real scheduler: RRULE + timezone recurrence, `nextRunAt`, missed-run policy (`run_once_within_grace`), precheck shell commands with timeouts, persisted run history with statuses (`pending … completed | dispatch_failed | skipped_*`), per-run token/cost usage collection, and a **headless dispatcher** that creates a workspace, launches the agent with the prompt, and awaits completion with a captured output snapshot (`src/main/automations/headless-dispatch.ts`, `service.ts`; types in `src/shared/automations-types.ts`). Triggers are **only `scheduled | manual`** — no webhook, no queue, no routing rule, no ticket state machine (verified: `trigger: AutomationRunTrigger` is the only trigger field; `webhook` = 0 hits under `src/main/automations`). Separately, an **experimental orchestration layer** gives agent-to-agent coordination: `orca orchestration task-create / dispatch --inject / check --wait / gate-create / ask / reply / inbox`, task DAGs, `worker_done`/`escalation`/heartbeat lifecycle (`skills/orchestration/SKILL.md`, `src/cli/specs/orchestration.ts`, RPC in `src/main/runtime/rpc/methods/orchestration-gates.ts`) — comparable to Paseo's orchestration primitives, gated behind Settings > Experimental. GitHub/Linear integration maps external tickets to worktrees (`orca worktree create --issue N` / `--linear-issue`), but pull-based and manual — curia's routing brain still does not exist here. Amusing interop note: Orca's "external automations" manager can even list and manage **hermes-agent's cron jobs** (`mapHermesJobs`, reads `~/.hermes/cron/jobs.json` — `src/main/automations/external-manager.ts`).
- **Worker: hosts them, is not one.** No embeddable SDK; workers are whatever CLIs you install.
- **Bridge: absent** (next two sections).

## Discord support

**None.** Repo-wide, `discord` appears only as: the community-server badge/link in README (`https://discord.gg/fzjDKHxv8Q`), the same link in the in-app help menu (`src/renderer/src/components/sidebar/SidebarSettingsHelpMenu.tsx:41`), locale strings for that menu item, and an internal comment referencing a bug report made on their Discord (`src/main/git/gh-rate-limit-breaker.ts:8`). No bot, no webhook surface, no outbound chat integration. Outbound notification channels are **mobile push** (opt-in, `mobile/src/notifications/`) and in-app/system notifications with unread state (README "Notifications and unread state"). A curia Discord bridge would be external code driving the `orca` CLI or runtime RPC, exactly as with Paseo/herdr.

## Voice input

**Built-in dictation (STT only), host-side, works from mobile — no TTS/voice-mode.**

- STT providers: **local** ONNX models (`transducer | paraformer | whisper` types — sherpa-style model manifests with download/cache management, `src/main/speech/model-manager.ts`, `model-catalog.ts`) or **OpenAI** transcription (`src/main/speech/openai-transcription-client.ts`). Settings include toggle/hold dictation modes and a confirm-before-insert gate for terminals (`src/shared/speech-types.ts` `VoiceSettings`).
- **Transcription runs on the runtime host, not the client**: the mobile app streams audio chunks over RPC (`speech.dictation.setup/start/chunk/finish/cancel` — all in the mobile RPC allowlist, `src/main/runtime/runtime-rpc.ts:343-350`; client side `mobile/src/hooks/use-mobile-dictation.ts`, host handler `src/main/runtime/rpc/methods/speech.ts`). So a phone dictating to a headless Hetzner `orca serve` is the designed path — same architecture as Paseo.
- **No TTS and no conversational voice mode** (`tts`/`kokoro`/text-to-speech = 0 hits). Paseo's realtime voice-agent mode has no Orca equivalent; Orca voice is dictation into prompts/terminals only.

## Session attach/sharing across devices

**Yes — one runtime, four client surfaces, converging on canonical shared sessions.**

- **Surfaces:** (1) the desktop Electron window; (2) the **mobile app** (React Native/Expo; WebSocket RPC on port 6768, QR pairing — `mobile/README.md`); (3) a **browser web client bundled with the app and served by the runtime itself** at `<endpoint>/web-index.html#pairing=<offer>` — `orca serve` prints this "Web client URL" in its ready block (`src/main/runtime/runtime-rpc.ts:117-131` `createWebClientUrl`, `src/main/index.ts:1499` `getBundledWebClientRoot`, `docs/reference/headless-linux-server.md`), so **the phone can reach a URL, no app required**; (4) the `orca` CLI over a local unix socket. Pairing offers are minted locally by the runtime (capability URL with device credential + E2EE material); no account needed.
- **Concurrent attach with single-session identity is a formally engineered invariant**: "one provider-session identity has at most one live PTY owner and canonical host surface"; the deterministic repro harness asserts "two clients race the same structured resume; exactly one daemon subprocess is spawned; **both clients receive the same canonical handle, tab, pane, and PTY**" (`docs/reference/remote-agent-session-host-authority.md`). This is precisely curia's session-identity requirement, solved with claim registries, PTY incarnation IDs, and fail-closed conflict handling.
- **Input:** all surfaces can write — desktop types directly, mobile has a direct-input mode (default for terminals, `mobile/mobile-terminal-direct-input-default.md`) plus buffered send, and `orca terminal send` injects from scripts. **No exclusive input ownership/takeover lock exists anywhere in the source** (contrast herdr's single-writer-with-`--takeover`), so concurrent multi-writer appears to be the model — though no doc states "multi-writer" explicitly (see Gaps).
- **Multimodal:** desktop drags files/images into agent prompts (README "Drag Files to Agents"); Design Mode sends HTML/CSS + cropped screenshots from the embedded browser into the prompt; **mobile can attach images into an agent's terminal** (`mobile/src/session/use-mobile-attachment-input-lease-gate.ts` — "Gates an image attachment's terminal.send"); mobile also renders agent sessions as **structured native chat** parsed from provider transcript files (Claude/Codex/Grok decoders, `src/main/native-chat/`) with an image viewer. Agent→human image output is file-based (preview panes), not a chat-attachment channel.
- **Remote topology:** `orca serve --pairing-address 100.64.1.20` — a **Tailscale address is the documented recommendation** for private servers (headless-linux-server.md). Off-LAN mobile without a tailnet uses Orca's E2EE **cloud relay** (director `https://relay.onorca.dev`, requires Orca Cloud login for the relay token — `src/main/orca-profiles/profile-cloud-auth-config.ts:19-21`, `src/main/runtime/relay/`); pairing can be forced `local-only`.

## Restart survival

**The best in the field — this is where Orca beats both Paseo and herdr.**

- **PTYs live in a detached daemon, not the runtime process.** The runtime spawns a detached daemon (unix socket + token auth, `src/main/daemon/daemon-spawner.ts`) and all persistent terminals are daemon-backed. On normal quit the runtime only **disconnects**: "normal quits keep the detached daemon for warm reattach" (`src/main/index.ts:2484`); SIGINT/SIGTERM route through the same path (`index.ts:1584`). On next start the runtime **re-adopts live PTYs** from daemon listings (the execution owner "recover[s] live claims from listings", host-authority doc). **Consequence: an `orca serve` restart or upgrade does not kill in-flight agent turns** — the agent process keeps running in the daemon and clients reattach. If daemon startup fails, Orca falls back to in-process PTYs and says so: "terminals will not persist across quit" (`index.ts:697`).
- **Screen state is checkpointed** independently: a headless terminal emulator in the daemon writes `checkpoint.json` + incremental `output.log` per session (`src/main/daemon/daemon-checkpoint-file.ts`, `headless-emulator.ts`), so scrollback and even alt-screen TUI frames cold-restore after a full daemon death (`hibernation-cold-restore-repro.test.ts`). README: "scrollback that survives restarts".
- **When the daemon itself dies (box reboot, crash):** Orca falls back to **native provider resume** — "AI Vault" resume records carry provider metadata (Claude session IDs, Pi transcript/session paths, Antigravity conversation IDs; host-authority doc "Renderer behavior") and relaunch the agent CLI with its resume flag. Same class as herdr/Paseo: the interrupted turn is lost; history resumes from the provider's last checkpoint.
- **Explicit non-guarantees** (host-authority doc): no automatic resume of intentionally sleeping agents; fresh-launch exactly-once does **not** hold across a full runtime restart (the operation ledger is memory-bound; a durable journal is listed under Future extensions); exited terminals are durably retired and cannot resurrect ("restarting the serve process with the same profile cannot resurrect the terminal or tab" — that's the anti-ghost guarantee, not a limitation).
- **Supervision is documented, not bundled:** the headless guide ships a systemd unit (`Restart=on-failure`) and a machine-readable one-line JSON readiness contract (`orca_server_ready`, schemaVersion 1) for health checks. Headless serve **never self-updates** — upgrade is a deliberate AppImage swap with documented atomic-rename, rollback-bundle, and profile-backup procedures (headless-linux-server.md "Upgrade").

## Queue/state durability

- Primary store: **`orca-data.json`** — a single schema-migrating JSON document under the profile dir (`~/.config/orca` + `~/.config/Orca`), with rolling `orca-data.json.bak.*` corruption-recovery snapshots (`src/main/persistence.ts`; headless doc "Roll back"). Holds projects, repos, worktree metadata/lineage, workspaces, automations + run history, settings, device registry.
- **SQLite** (Node's built-in `node:sqlite`, no native addon — `src/main/sqlite/sync-database.ts`) backs higher-churn stores (usage tracking et al.). Terminal history lives in per-session checkpoint/log files (above). Upgrade doc enumerates what persists: "projects, worktree metadata, terminal history, **orchestration state**, or paired-device keys" — so orchestration tasks/dispatches survive restarts.
- **Dispatcher-brain-shaped?** Partially: automations (with `nextRunAt`, run statuses, output snapshots) and orchestration tasks/gates are durable and could carry some curia state, but there is no ticket/queue schema to adopt — curia's ticket store remains its own.

## Self-hostability

**Documented first-class, with an Electron-sized asterisk.**

- `orca serve` "starts the Orca runtime without opening the desktop window" — standalone headless server, **no desktop hub required**. Dedicated guide for Ubuntu/Debian VPS: AppImage (+`--appimage-extract` for Docker/no-FUSE), Xvfb auto-started when no `DISPLAY`, `LIBGL_ALWAYS_SOFTWARE=1`, non-root service user, systemd units, JSON readiness contract, reverse-proxy/wss notes (`docs/reference/headless-linux-server.md`). AUR packages exist (`stably-orca-bin`); arm64 AppImage published.
- **It is still Electron/Chromium headless** — needs Xvfb and Chromium's library set, and is much heavier than Paseo's Node daemon or herdr's single Rust binary. No published resource numbers (a renderer memory profile doc exists, `docs/renderer-memory-profile-2026-06-01.md`, but nothing for headless serve).
- **No forced account:** pairing is minted locally; providers use your own agent-CLI subscriptions ("Run any coding agent with your own subscription"). Orca Cloud login is needed **only** for the off-LAN mobile relay — irrelevant over Tailscale. Telemetry is on by default but opt-out via settings, `ORCA_TELEMETRY_DISABLED=1`, or DNT (`src/main/telemetry/consent.ts`; README links a telemetry doc).
- **License: MIT for the whole repo** (LICENSE, copyright "Lovecast Inc."), including the server, CLI, relay, and mobile app source. The iOS binary ships via App Store/TestFlight; Android via direct APK. No AGPL entanglement — a real advantage over both Paseo and herdr for curia.

## Maturity / license

- **Stars/forks/issues:** 25,903 stars, 1,867 forks, **1,991 open issues** (GitHub API, 2026-07-22). Created **2026-03-17** (~4 months old, same vintage as herdr); pushed today.
- **Cadence: extreme.** v1.4.150 stable released 2026-07-22; multiple releases (stable + RC) per day; README: "we ship daily, so this list is perpetually behind."
- **Bus factor: the best in the field.** Top contributors: nwparker 2,380 commits, AmethystLiang 1,456, brennanb2025 883, Jinwoo-H 845, plus a long tail — 100+ contributors (API capped at 100/page). Backed by a company (GitHub org `stablyai`, homepage onOrca.dev; LICENSE copyright Lovecast Inc.). Contrast Paseo and herdr at effectively bus factor 1.
- **Engineering quality signals:** unusually rigorous internal design docs with reliability gates and deterministic repro harnesses (`docs/reference/remote-agent-session-host-authority.md`, `config/reliability-gates.jsonc`, `pnpm test:repro:remote-agent-session`), massive test surface throughout `src/`.
- **Churn risk:** the CLI's own skill stub warns subcommands/flags "change between Orca releases" and deliberately serves a version-matched guide from the binary (`skills/orca-cli/SKILL.md`). The runtime WS protocol is versioned (v3, min-compat v2) with monotonic mixed-version rules, but is not documented as a stable public API.

## API surface (driving Orca from curia's dispatcher)

**Yes — a broad public CLI, RPC-backed, plus structured orchestration.** The `orca` CLI talks to the running runtime over a unix socket / named pipe (newline-JSON, `src/main/runtime/rpc/unix-socket-transport.ts`), so curia's daemon on the same Hetzner box can drive a headless `orca serve` directly:

- **Spawn a worker on a repo/worktree with a prompt:** `orca worktree create --name X --repo <sel> --agent <id> --prompt <text> [--issue N | --linear-issue ID] [--base-branch ref]` (`src/cli/specs/core.ts:86-116`); or in an existing checkout: `orca terminal create --worktree <sel> --command "codex"`.
- **Feed/inject mid-session input:** `orca terminal send [--terminal h] [--text t] [--enter] [--interrupt]`.
- **Observe:** `orca terminal read [--cursor]`, `orca terminal wait --for exit|tui-idle [--timeout-ms]`, `orca terminal list`, `orca worktree ps` ("compact orchestration summary across worktrees"), `orca status --json`.
- **Structured completion tracking (experimental):** `orca orchestration task-create` → `dispatch --inject` (injects a lifecycle preamble instructing the worker to emit `worker_done`/`escalation`/heartbeats) → `check --wait`; decision gates via `gate-create/gate-resolve`. This is a ready-made escalate/complete signal for curia's HITL loop — the worker's `escalation` message is exactly the event curia would forward to Discord.
- **Scheduling:** `orca automations create/run/runs/…` for cron-style runs on the serve host.
- Also scriptable: embedded-browser automation (goto/click/fill/screenshot), Computer Use (desktop UI control), Android emulator control, Linear ticket CRUD — none needed by curia but indicative of surface breadth.
- **Stability caveat:** all of this is version-matched, pre-1.0-style churn (see above); pin the AppImage version (the headless guide itself tells you to) and re-read `orca skills get orca-cli` per release.

## Benchmark: Orca vs Paseo vs herdr (substrate slot)

| Dimension | **Orca** | **Paseo** | **herdr** |
|---|---|---|---|
| Role | Substrate + cron automations + experimental orchestration | Daemon substrate + orchestration primitives | Substrate only |
| Discord | ✗ (community link only) | ✗ | ✗ |
| Voice | **STT dictation, host-side, mobile-capable** (local ONNX/OpenAI); no TTS | **STT + TTS + realtime voice mode**, host-side, mobile-capable | ✗ |
| Phone surface | **Native iOS/Android app + browser URL served by runtime** | Expo mobile/web app + daemon-served web UI | SSH terminal app only, no URL |
| Multi-client attach | Yes; canonical-session invariant, engineered + repro-tested; no input lock found | Yes; daemon broadcasts, last-writer-wins PTY size | Multi-observer, **single writer** per terminal (`--takeover`) |
| Image input to agents | Desktop drag + Design Mode + **mobile image attach**; structured chat view | File mentions; provider-dependent | ✗ (terminal only) |
| In-flight turn survives host restart | **Yes — detached PTY daemon, warm reattach** (dies only with daemon/box) | No — turn dies with daemon; lazy record resume | No — turn dies; native `--resume` relaunch |
| State | orca-data.json + SQLite + per-session checkpoints; durable orchestration/automation state | File-backed JSON under `$PASEO_HOME` | Session/layout snapshots |
| Headless Linux | **Documented systemd + Tailscale guide**, but Electron+Xvfb footprint | Node daemon, Docker image, one port — lighter | Single Rust binary — lightest |
| Driveable API | Broad CLI (worktree/terminal/orchestration/automations), version-churny | CLI + WS SDK + MCP endpoint | Socket API (pane/agent/wait) |
| License | **MIT** | AGPL-3.0 | AGPL-3.0-or-later (dual) |
| Backing / bus factor | **Company, 100+ contributors, 4 with 800–2,400 commits** | Solo (~1) | Solo (~1) |
| Age / issues | 4 mo; 25.9k★; 1,991 open issues | 9 mo; 11.0k★; 825 open | 4 mo; 19.0k★; 79 open |

**Verdict for curia's substrate slot: Orca replaces herdr and absorbs the substrate half of Paseo.** On every curia hard requirement — concurrent multi-client attach with a phone-reachable browser URL, tmux-grade detach survival (Orca exceeds it: even the *host* can restart), self-host on a Hetzner box over Tailscale, programmatic spawn/inject/observe — Orca meets or beats both, and adds MIT licensing plus a real team behind it. herdr's remaining edges are footprint (one Rust binary vs Electron+Xvfb) and a much cleaner issue tracker; it keeps single-writer input, no browser surface, no voice. Paseo's remaining edges are genuinely distinct: full voice *mode* with TTS (Orca is dictation-only), a lighter daemon, an MCP endpoint, and an E2EE relay that is self-contained rather than cloud-account-gated — but Paseo is AGPL, solo-maintained, and loses in-flight turns on daemon restart. What Orca does **not** change: curia still builds the dispatcher (Orca's automations are cron-only, no webhook/queue/routing) and the entire Discord/HITL bridge — with the note that `orca orchestration`'s `escalation`/`worker_done` events and the `working|blocked|waiting|done` agent-status model give the bridge better hooks than raw terminal scraping.

## Gaps / unknowns

- **Concurrent multi-writer input is inferred, not documented.** No input-ownership lock exists in the source and all surfaces have send paths, but no primary doc states two clients may type into one PTY simultaneously. Worth an empirical two-client test.
- **Daemon lifetime policy not fully mapped.** Warm-reattach-on-quit is explicit; whether the daemon idle-shuts-down with live agent PTYs attached (an `onIdleShutdown` hook exists, `src/main/daemon/daemon-main.ts`) was not traced to its trigger conditions. An idle daemon exiting would narrow the restart-survival claim; needs a kill-the-serve-process-mid-turn empirical test.
- **Headless resource footprint** (Electron + Xvfb + daemon + web client on a small Hetzner box) is undocumented and untested here.
- **Linux coverage of the host-authority invariant:** the reliability doc itself lists "Linux, Windows, WSL, and live SSH" as explicit evidence gaps for the v1 validation (macOS-validated). The mechanism is platform-generic but Linux is less proven.
- **Voice on headless serve:** the `speech.dictation.*` RPCs are in the mobile allowlist and STT runs host-side; whether local ONNX model download/inference works identically under headless serve (vs desktop) was not runtime-tested.
- **Open-issue triage state** (1,991 open issues) not sampled for headless/Linux showstoppers; issue volume partly reflects the project's practice of tracking internal work as issues (docs reference issue numbers throughout).
- **Stably AI corporate details:** org `stablyai`, LICENSE copyright "Lovecast Inc." — the exact corporate relationship/funding was not verified from primary sources.
- **Docs site** (onorca.dev/docs — mobile, telemetry, CLI pages) was not fetched; repo sources were treated as authoritative. The web client's exact feature parity vs desktop (terminal-only vs full workspace) was not enumerated.

## Sources

- Repo: https://github.com/stablyai/orca — clone at commit `6ad6241` (2026-07-22)
- GitHub API: `gh api repos/stablyai/orca` (stars/forks/issues/license/dates), `/releases`, `/contributors` (2026-07-22)
- README.md (features, supported agents, install, community, license)
- docs/reference/headless-linux-server.md (serve mode, Xvfb, systemd, pairing, Tailscale, upgrade/rollback, no self-update)
- docs/reference/remote-agent-session-host-authority.md (session-identity invariant, canonical PTY, repro harness, non-guarantees)
- src/main/index.ts (daemon warm reattach :2484, local-PTY fallback :697, serve readiness, web client root :1499)
- src/main/daemon/ (daemon-spawner.ts, daemon-main.ts, daemon-entry.ts, daemon-checkpoint-file.ts, hibernation-cold-restore-repro.test.ts)
- src/main/automations/ (service.ts, headless-dispatch.ts, external-manager.ts) + src/shared/automations-types.ts
- src/main/speech/ + src/shared/speech-types.ts + mobile/src/hooks/use-mobile-dictation.ts (dictation architecture)
- src/main/runtime/runtime-rpc.ts (web client URL :117-131, mobile RPC allowlist incl. speech.dictation.* :343-350, pairing offers)
- src/main/runtime/relay/ + src/main/orca-profiles/profile-cloud-auth-config.ts (cloud relay, relay.onorca.dev, E2EE)
- src/main/runtime/rpc/unix-socket-transport.ts (CLI transport)
- src/cli/specs/ (core.ts — worktree/terminal commands; serve.ts; orchestration.ts; automations.ts)
- skills/orca-cli/SKILL.md, skills/orchestration/SKILL.md (public CLI + orchestration contract)
- src/shared/agent-status-types.ts (working/blocked/waiting/done model)
- mobile/README.md, mobile/mobile-terminal-direct-input-default.md, mobile/src/session/use-mobile-attachment-input-lease-gate.ts, mobile/src/notifications/
- src/main/telemetry/consent.ts (opt-out), src/main/persistence.ts + src/main/sqlite/sync-database.ts (storage), src/main/native-chat/ (structured chat)
- LICENSE (MIT, Lovecast Inc.)
- Comparison baselines: docs/research/paseo.md, docs/research/herdr.md, docs/research/landscape-scan.md (this repo)

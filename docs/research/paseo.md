# Paseo (getpaseo/paseo) — primary-source research

Date: 2026-07-21. Sources: repo at commit `b2139b1` (2026-07-21), https://github.com/getpaseo/paseo, docs read from a clone of `main`.

**Verdict.** Paseo is a strong fit for role (a), the always-on daemon: it is exactly a one-daemon/many-clients system — a Node.js daemon on a Linux box managing Claude Code/Codex/Copilot/OpenCode/Pi sessions, with mobile/web/desktop/CLI clients all attaching to the same live sessions over one WebSocket protocol, with persisted-and-resumable agent state and first-class voice. It is a partial fit for role (b), dispatcher: it has real orchestration primitives (cross-provider subagents, schedules, heartbeats, loops, chat rooms, an MCP/native tool catalog, a scriptable CLI/SDK), but no ticket/queue concept — curia's routing logic would sit on top. For role (c), worker host, it is a superset: workers are what it hosts natively. What it does **not** provide is any Discord surface — a curia Discord bridge would have to be written against Paseo's CLI/SDK/MCP interfaces. Main caveats: effectively a bus factor of one, AGPL-3.0, pre-1.0 with a very fast release cadence, and mid-turn work does not survive a daemon restart (records resume lazily, but a running turn dies with the process).

## Role fit

- **Daemon (a): excellent.** "Paseo runs a local server called the daemon that manages your coding agents. Clients like the desktop app, mobile app, web app, and CLI connect to it" ([README.md](https://github.com/getpaseo/paseo/blob/main/README.md); [docs/architecture.md](https://github.com/getpaseo/paseo/blob/main/docs/architecture.md) "System overview"). All clients speak one WebSocket protocol (`packages/protocol/src/messages.ts`); deployment model 1 is a headless daemon on `127.0.0.1:6767` (architecture.md "Deployment models").
- **Dispatcher (b): partial.** Primitives exist: agent-to-agent `create_agent` across providers, `paseo agent run/send/wait/attach`, cron `schedule`s, per-agent `heartbeat`s, `loop` runs that retry until an exit condition, chat rooms for agent↔agent/human↔agent messaging ([public-docs/orchestration.md](https://github.com/getpaseo/paseo/blob/main/public-docs/orchestration.md); architecture.md CLI command list, `server/schedule/`, `server/loop-service.ts`, `server/chat/`). There is no ticket queue, triage, or routing policy — an orchestrator agent or external code (curia) must supply that. There is also an optional "Hub" — a daemon-outbound execution-dispatch relationship with idempotent `hub.execution.agent.create` — but it is a foundation for Paseo's own hosted control plane, one Hub per daemon ([docs/hub.md](https://github.com/getpaseo/paseo/blob/main/docs/hub.md)).
- **Worker host (c): native.** Providers wrap Claude Agent SDK, Codex app-server, Copilot ACP, OpenCode, Pi, generic ACP (architecture.md "Agent providers"); each supports resume via provider persistence handles (Claude `~/.claude/projects/{cwd}/{session-id}.jsonl`, Codex rollout files). Workspaces with `local | worktree` isolation, per-project checkouts, terminals, git/PR operations.
- **Bridge: absent.** Nothing bridges to external chat platforms (see Discord below).

## Discord support

**None.** A repo-wide grep for `discord` matches only community links: website nav/footer, in-app help menu, README "Discord is the fastest place to reach me" (solo-maintainer support note), CHANGELOG "Added a Discord link to the website navigation". No bot, no webhook, no outbound chat integration of any kind; a grep for `webhook|slack|telegram` across `packages/server/src`, `docs/`, `public-docs/` finds only an unrelated test fixture. The only outbound notification channel is **Expo mobile push** (`packages/server/src/server/push/push-service.ts` — batches tokens to Expo's push API, so notifications transit Expo's cloud; tokens in `$PASEO_HOME/push-tokens.json`). A curia Discord bridge would be external code driving Paseo via the CLI, the `@getpaseo/client` WebSocket SDK (`packages/client`), or the MCP endpoint at `/mcp/agents` (architecture.md).

## Voice input

**Built-in and local-first**, running on the daemon, not the client ([public-docs/voice.md](https://github.com/getpaseo/paseo/blob/main/public-docs/voice.md)):

- Two features: **dictation** (STT into the composer) and **voice mode** (realtime conversation with a hidden agent session using your configured provider — `claude`/`codex`/`opencode` — plus TTS).
- STT/TTS providers: `local` (ONNX on CPU via sherpa — `packages/server/src/server/speech/providers/local/sherpa/`; default models `parakeet-tdt-0.6b-v2-int8` STT, `kokoro-en-v0_19` TTS, auto-downloaded to `$PASEO_HOME/models/local-speech` at daemon startup) or `openai` (`/v1/audio/transcriptions`, `/v1/audio/speech`; configurable base URL, so any OpenAI-compatible endpoint).
- **Works from mobile**: the Expo app has "Voice features: dictation (STT) and voice agent (realtime)" (docs/architecture.md, packages/app section); audio streams over the same WebSocket as session messages (`dictation_stream_*`, `assistant_chunk`, `audio_output`, `transcription_result` message types, architecture.md "Notable session message types"; server side in `packages/server/src/server/dictation/dictation-stream-manager.ts` and `server/session/voice/voice-session.ts`; mic plumbing in `packages/expo-two-way-audio`). So a phone dictating to a daemon on a Hetzner box is the designed path.
- Voice mode can launch and control agents (voice.md "Operational Notes") — i.e., voice is a full command surface, not just transcription.

## Session attach/sharing across devices

**Yes — this is the core design.** One daemon, N clients; agent state and timelines are daemon-owned and broadcast:

- "AgentManager is the source of truth for agent state and broadcasts updates to all subscribers"; events "stream to connected clients in real time," with authoritative paged timeline fetches for catch-up (docs/architecture.md "Agent lifecycle", [docs/timeline-sync.md](https://github.com/getpaseo/paseo/blob/main/docs/timeline-sync.md)). A phone and a PC attached to the same agent see the same live timeline.
- Terminals are shared too: PTY size is "last-interacting-client-wins" and "every attached client renders that output in its own local viewport" (architecture.md "Binary frames").
- Attach surfaces: mobile/web app (Expo), desktop (Electron), CLI (`paseo attach <id>` streams an agent live, [public-docs/cli.md](https://github.com/getpaseo/paseo/blob/main/public-docs/cli.md) "Streaming output"), daemon-served web UI, and the `@getpaseo/client` SDK.
- Global vs per-client state is explicit: archive is global; tab layout is per-client (docs/agent-lifecycle.md "Tabs vs archive").
- Remote connectivity: direct WebSocket (`paseo --host workstation.local:6767`), or the E2E-encrypted relay (Curve25519 + NaCl `box`, zero-knowledge relay server, QR pairing) for daemons behind NAT (`packages/relay`, architecture.md). Over Tailscale the relay is unnecessary — direct is a documented topology ([public-docs/web-ui.md](https://github.com/getpaseo/paseo/blob/main/public-docs/web-ui.md) "Topologies" explicitly names "a Tailscale tailnet").

## Restart survival

**Records survive; live turns do not.**

- Everything durable is file-backed JSON under `$PASEO_HOME` (`~/.paseo`): agent record + persisted timeline rows per agent (`agents/{cwd-with-dashes}/{agent-id}.json`), project/workspace registries, chat, schedules, loops, config, daemon keypair (docs/architecture.md "Storage").
- `closed` is "the persisted, resumable state for an agent record that has no live provider runtime" ([docs/agent-lifecycle.md](https://github.com/getpaseo/paseo/blob/main/docs/agent-lifecycle.md) "States"). Opening or prompting runs `ensureAgentLoaded()` → `resumeAgentFromPersistence(handle, …)`, resuming the durable provider session (Claude/Codex session files) under the same Paseo agent id, then rehydrates the timeline (`packages/server/src/server/agent/agent-loading.ts`).
- Resume is **lazy** — there is no boot-time relaunch of previously-running agents found in `bootstrap.ts`/`agent-manager.ts`; the daemon also garbage-collects idle runtimes after 2 minutes by design, and "its next prompt resumes the runtime" (agent-lifecycle.md "Runtime residency"). Storage defaults `lastStatus` to `closed` on load (`agent-storage.ts:47`).
- Consequence for curia: a daemon restart (or crash) kills in-flight provider turns; conversation history up to the last provider flush survives and the session resumes on next prompt, but the interrupted turn is not automatically continued or retried. Scheduled/heartbeat/loop definitions persist (`schedules/`, `loops/` dirs). The daemon has a self-update-and-restart flow (`server/session/daemon/daemon-self-updater.ts`), so restarts are a designed event, with the same limitation.

## Self-hostability

**Good — headless Linux is a first-class target.**

- Install: `npm install -g @getpaseo/cli && paseo` (README "CLI/headless"); `paseo daemon start/stop/restart/status/pair/set-password`. Node.js daemon, TypeScript monorepo; Nix flake also present (`flake.nix`, `nix/`).
- Docker: official image, listens `0.0.0.0:6767`, `PASEO_PASSWORD`, persistent volume at `/home/paseo`, drops to non-root `paseo` user after first-run setup; reverse-proxy (Caddy/nginx) examples ([public-docs/docker.md](https://github.com/getpaseo/paseo/blob/main/public-docs/docker.md)).
- One port: `6767` serves WS API, HTTP `/api/*`, MCP `/mcp/*`, service-proxy, and (opt-in `--web-ui` / `PASEO_WEB_UI_ENABLED=true`) the full browser UI from the same origin (public-docs/web-ui.md). Default bind is `127.0.0.1`; `--listen 0.0.0.0:6767` + password for network exposure — binding to a tailnet address is the documented "Private network (LAN or VPN)" topology, so a Hetzner box over Tailscale works with no relay and no public exposure.
- Auth: optional password, host allowlist (`PASEO_HOSTNAMES`); providers handle their own API keys ("Paseo does not manage API keys", architecture.md). No telemetry, no forced account (README).

## Maturity / license

- **Stars/forks/issues:** ~10,981 stars, 1,074 forks, 825 open issues (GitHub API, 2026-07-21). Repo created 2025-10-13; last push 2026-07-21 (today).
- **Cadence:** 102 changelog releases from v0.1.1 (2026-02-11) to 0.2.0-beta.1 (2026-07-17) — multiple releases per week ([CHANGELOG.md](https://github.com/getpaseo/paseo/blob/main/CHANGELOG.md)). Still 0.x/beta.
- **License:** AGPL-3.0 (GitHub reports "NOASSERTION" because the LICENSE file is a preamble + AGPLv3 text; copyright "Mohamed Boudra"). AGPL matters if curia ever offers Paseo-backed functionality as a network service to third parties; for personal self-hosting it is a non-issue.
- **Bus factor: ~1.** Contributor stats: boudra 4,050 commits; next human contributor 14 ([contributors API](https://api.github.com/repos/getpaseo/paseo/contributors)). README says outright: "I'm a solo maintainer and don't always keep up with GitHub Issues daily." External PRs do land (CHANGELOG credits several).
- Docs quality is unusually high: `docs/` (internal architecture, data model, protocol) + `public-docs/` (user docs served at paseo.sh).

## Gaps / unknowns

- **Mid-turn restart behavior not explicitly documented.** The lazy-resume conclusion is inferred from `agent-loading.ts`, `agent-storage.ts` (`lastStatus` defaults `closed`), and agent-lifecycle.md; I found no doc or code that relaunches or retries agents that were `running` when the daemon died. Worth an empirical test (kill daemon mid-turn, restart, inspect).
- **Resource footprint** of the daemon + local speech models (Parakeet/Kokoro ONNX on CPU) on a small Hetzner box — not documented; models download at startup only if local provider is selected.
- **Hub** is described as a foundation ("one Hub relationship per daemon") — whether a self-hosted Hub exists or it is cloud-only (`packages/website/src/routes/cloud.tsx` suggests a hosted cloud signup) was not determined.
- **`@getpaseo/client` SDK stability** — architecture.md calls parts of it "during migration"; the wire protocol has explicit append-only compatibility rules, but the SDK surface may churn pre-1.0.
- Open-issue triage state (825 open issues) not sampled for showstoppers relevant to headless/Linux use.

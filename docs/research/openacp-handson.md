# OpenACP fork — hands-on boot trial (does the vendor candidate build and bridge?)

Date: 2026-07-23. Ticket: [#22](https://github.com/alp82/curia/issues/22). Follows the source-only eval [#16](https://github.com/alp82/curia/issues/16) ([docs/research/openacp.md](openacp.md)). Feeds the build-posture decision [#17](https://github.com/alp82/curia/issues/17).

Method: full clone of `an1creator/OpenACP` at `7485bbd` (the exact commit #16 pinned), **built from source** (`pnpm install` + `pnpm build`), ran the test suite, booted the daemon headless on this Linux box, registered a **generic (non-Claude) ACP agent** as a `custom` agent, and drove real sessions through the REST API — including a permission round-trip and a kill/restart-mid-escalation. Nothing here is source-reading; every claim below was executed. Machine: Arch Linux, Node 24.15.0, pnpm 11.3.0.

## Verdict

**The vendored fork builds clean, tests green, and boots into a working bridge core from source — the "does it even build" risk from #16 is retired.** A generic ACP subprocess (my own mock agent, no model auth) spawned, ran a full prompt turn, and raised a permission request through OpenACP's gate — proving the exact seam curia needs (present an Orca worker to OpenACP as a thin ACP agent). Session persistence and the "in-flight escalations die on restart" claim both reproduced exactly as #16 predicted from source.

**One materially new finding that source-reading did not surface:** a session with **no messaging adapter bound is "headless", and OpenACP's core auto-approves any permission that carries an allow option** (and hangs-to-timeout on any that doesn't). So driving workers purely over the REST/SSE "api" channel is **not a human-gating surface** — escalations would silently self-approve. For curia this means a worker that must escalate has to be bound to a real adapter thread (Discord), or curia must run its own gate in front. This sharpens, not changes, #16's "OpenACP insists on owning the session lifecycle" note.

**Still blocked on Discord bot credentials** (see checklist at the end): the Discord-specific surface — thread-per-session, allow/reject buttons, first-click-wins, images both directions, inbound voice-memo STT, and a restart-mid-escalation *on the real (non-headless) gate* — was not exercised. The Discord adapter is a separate frozen npm artifact (`@openacp/discord-adapter`, AGPL-declared), not in this repo's source; booting it needs a token. This ticket stays open pending that.

## What passed, hands-on

### Build from source — PASS
- `pnpm install` (4.1s) and `pnpm build` (tsc + asset copy) both clean, zero errors. `node dist/cli.js --version` → `openacp v2026.721.1`. `--help` renders the full command surface.
- **License in practice:** the repo `LICENSE` and root `package.json` are **MIT**; building from source yields an MIT artifact. The AGPL-3.0 declaration #16 flagged lives only in the *published npm tarballs* (`@openacp/cli` / `@n1creator/openacp-cli`) — I never pulled those. So the vendor-and-pin-from-source posture is clean; do **not** `npm install -g` the published CLI if AGPL is a concern.
- The one platform wrinkle: `devDependencies` pin `@rolldown/binding-darwin-arm64` (a macOS-only binary). It installed as an ignored optional on Linux and did not block the build. Pin the fork commit; expect macOS-flavoured devDeps.

### Test suite — PASS (4012/4012)
`pnpm test` → **301 files, 4012 tests, all passing, ~5s.** This directly exercises the machinery curia depends on: `permission-gate` (+ comprehensive/extended), `elicitation-gate`, `session-store`, multi-bridge routing, and the `IChannelAdapter` conformance suite. The gate timeout/first-answer-wins/superseded-on-new logic is unit-verified on this platform, not just read.

### Daemon boots headless — PASS
`node dist/cli.js --foreground` with `OPENACP_INSTANCE_ROOT` pointed at a scratch dir came up in ~1s:
- REST API + SSE server listening on `127.0.0.1:21420` (`openacp api health` returns ok).
- All core plugins loaded (security, file-service, context, speech, notifications, api-server, sse-adapter, telegram[disabled], attachment-delivery, identity, tunnel).
- **Agent warm-pool pre-spawned** the configured agent (capacity 1, 5-min TTL).
- **Auto-provisioned a Cloudflare tunnel** out of the box (`https://tunnel-*.openacp.ai`) — it downloaded and installed `cloudflared` itself. Self-hosting story is real; no manual reverse-proxy needed for a public URL. (For curia we'd disable this in favour of Tailscale Serve per #8.)
- Footprint: **RSS ~200 MB** for the daemon + one warm agent. Comfortable on the 8 GB Hetzner box.
- Config is fully file-driven (`config.json` / `agents.json` / `plugins.json` in the instance root) — no interactive wizard required to boot. Discord is env-var configurable (`OPENACP_DISCORD_BOT_TOKEN` + `OPENACP_DISCORD_GUILD_ID`), which simplifies a headless deploy.

### Generic (non-Claude) ACP agent as a `custom` agent — PASS
Registered a plain stdio ACP agent (`command: node`, `args: [<script>]`, `distribution: "custom"`) — no registry, no model auth. Created a session via `openacp api new`, sent a prompt via `openacp api send`; the agent spawned as a subprocess, streamed `agent_message_chunk` updates (the session auto-named itself from the first chunk), ran tool calls, and raised a `session/request_permission`. **This is the integration seam from #16 proven live:** curia can present an Orca worker to OpenACP as a thin generic ACP shim and OpenACP drives it happily — it does not require its own registry agents.

### Session persistence + restart-kills-pending-escalation — PASS (matches #16)
Wrote a second mock agent that raises a permission with **no allow option**, so the gate genuinely holds pending. Observed:
1. After the prompt: session `active`, `promptRunning: true` — turn blocked on the pending permission. Log: *"Headless session has no allow option for permission request — skipping auto-approve, will time out."*
2. Killed the daemon (SIGTERM) and relaunched.
3. After restart: the session **reloaded from the durable JSON store** but as `status: finished`, `promptRunning: false`, `isLive: false` — **the in-flight turn and its pending permission were gone, not resumed.** The agent subprocess died with the daemon and was not auto-respawned.
4. A fresh `api send` to the reloaded session was accepted (new turnId) — the session record survives and is reusable, but the escalation must be **re-dispatched**, not recovered.

This is exactly #16's "sessions durable, in-flight escalations die" — now empirical. **Consequence for curia (confirms #11):** curia must own its durable escalation record and re-ask on reconnect; OpenACP will not hold a question across a restart.

## New finding: headless sessions auto-approve permissions

`src/core/core.ts:972-990` — when a session has no adapter (the REST/`api` channel is adapter-less = "headless"), core installs a fallback permission handler that:
- **auto-approves** any request that has an `isAllow` option (logs *"Auto-approving permission … for headless session — no adapter connected"*), and
- returns a never-resolving promise for requests **without** an allow option (→ gate times out at 10 min).

Reproduced both branches live. **Why it matters for #17/#11:** "connect it to a generic ACP agent and drive over REST" is *not* by itself a human-in-the-loop path — a worker's `requestPermission` self-approves the moment no Discord/Telegram thread is attached. To make an escalation actually reach Alp, the session must be created **bound to a real adapter thread** (`createThread`, channelId=discord), or curia must interpose its own gate (the MCP `ask_human` design in #11) rather than lean on OpenACP's. This is the concrete cost of "OpenACP owns the session lifecycle."

## Rubric scorecard (hands-on where marked ✔, else deferred)

| Dimension | Result |
|---|---|
| Builds from source (vendor-and-pin) | ✔ PASS — MIT from source, clean install+build |
| Boots self-hosted, headless | ✔ PASS — ~200 MB, file-config, auto-tunnel |
| Generic ACP worker seam | ✔ PASS — custom non-Claude agent spawns & drives |
| Permission gate exists & fires | ✔ PASS — reproduced pending + auto-approve branches |
| Session persistence | ✔ PASS — durable JSON store reloads across restart |
| Restart kills in-flight escalation | ✔ PASS — turn lost, re-dispatch required |
| Discord thread-per-session | ⏳ needs bot token |
| Allow/reject buttons + first-click-wins | ⏳ needs bot token |
| Images both directions through the bridge | ⏳ needs bot token |
| Inbound voice-memo → STT | ⏳ needs bot token (local faster-whisper bootstraps a Python env on first use) |
| Restart mid-escalation on the *real* (bridged) gate | ⏳ needs bot token |

## Side effects of this run (cleanup)

- Instance state was correctly isolated to a scratchpad dir via `OPENACP_INSTANCE_ROOT`.
- **But** the daemon auto-installed `cloudflared` to `~/.openacp/bin/cloudflared` and created `~/.openacp/` (a global cache path, not overridable by the instance-root env). Harmless, but present on the box now. Safe to `rm -rf ~/.openacp` if unwanted.
- All spawned processes were killed; nothing is left listening.

## Handoff: Discord verification checklist (blocked on Alp)

To finish the Discord half, I need a throwaway Discord bot. Precise steps:

1. **Create the app + bot:** https://discord.com/developers/applications → New Application → Bot tab → Reset Token → copy the **bot token**.
2. **Enable the Message Content intent:** Bot tab → Privileged Gateway Intents → toggle **MESSAGE CONTENT INTENT** on (OpenACP reads message bodies).
3. **Invite it to a server** (a fresh private test guild is ideal): OAuth2 → URL Generator → scopes `bot` + `applications.commands`; OpenACP's docs specify permission integer **`328565073936`**. Open the generated URL, add the bot to the guild.
4. **Grab the guild ID:** enable Developer Mode in Discord (Settings → Advanced), right-click the server → Copy Server ID.
5. **Hand me:** the **bot token** and the **guild ID**. Drop them in a file I can read (e.g. `~/.config/curia-openacp-discord.env` with `OPENACP_DISCORD_BOT_TOKEN=…` and `OPENACP_DISCORD_GUILD_ID=…`), or paste in-session. A private test guild means no risk to any real server.

With those I'll: install `@openacp/discord-adapter`, boot with Discord enabled, and verify thread-per-session, allow/reject buttons + first-click-wins, images both ways, and a voice-memo transcript — plus a restart mid-escalation on the real bridged gate — then close #22 and record the result on the map.

**Alternative if you'd rather not:** the build + core-bridge + persistence + restart behavior is already enough to de-risk the "vendor OpenACP" branch of #17 on everything except the Discord UX, which #16 already read from the compiled adapter. If you want to skip the live Discord run, say so and I'll close #22 on the strength of the source-read + this boot trial.

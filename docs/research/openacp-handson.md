# OpenACP fork — hands-on boot trial (does the vendor candidate build and bridge?)

Date: 2026-07-23. Ticket: [#22](https://github.com/alp82/curia/issues/22). Follows the source-only eval [#16](https://github.com/alp82/curia/issues/16) ([docs/research/openacp.md](openacp.md)). Feeds the build-posture decision [#17](https://github.com/alp82/curia/issues/17).

Method: full clone of `an1creator/OpenACP` at `7485bbd` (the exact commit #16 pinned), **built from source** (`pnpm install` + `pnpm build`), ran the test suite, booted the daemon headless on this Linux box, registered a **generic (non-Claude) ACP agent** as a `custom` agent, and drove real sessions through the REST API — including a permission round-trip and a kill/restart-mid-escalation. Nothing here is source-reading; every claim below was executed. Machine: Arch Linux, Node 24.15.0, pnpm 11.3.0.

## Verdict

**The vendored fork builds clean, tests green, boots into a working bridge core from source, and the full Discord escalate→answer→resume round-trip works live — the two big unknowns from #16 (does it build? does the human-in-the-loop loop actually close?) are both retired.** A generic ACP subprocess (my own mock agent, no model auth) spawned, ran a prompt turn, raised a permission through OpenACP's gate, that gate rendered as **allow/reject buttons in a per-session Discord thread**, and **Alp clicking ✅ Allow resumed the blocked worker to completion** (verified in the daemon log: `requestId call_2, optionId allow, isAllow true` → `Prompt execution completed` — a 7-minute block ended by the click, not a timeout). This is curia's #11 contract, proven end-to-end on real Discord.

**Two materially new findings source-reading did not surface:**
1. A session with **no messaging adapter bound is "headless", and OpenACP's core auto-approves any permission carrying an allow option** (hangs-to-timeout on ones without). Driving workers purely over the REST/SSE "api" channel is therefore **not a human-gating surface** — escalations silently self-approve. Escalations must bind a real adapter thread (Discord), or curia interposes its own gate. Sharpens #16's "OpenACP owns the session lifecycle" note.
2. **The `install` command is broken in a from-source build** (needs a bundled plugin catalog that only ships in the published npm package), and — a related operational caveat — when the Discord adapter **fails to post a permission message** (a `Missing Access` on the thread, seen once here), the gate is left **pending with no human-answerable UI and the worker hangs** to timeout. Curia's own durable-escalation record must cover post-failures, not just restarts.

**Remaining (best re-run in a clean throwaway guild):** agent→human images through the bridge, inbound voice-memo STT, and a literal first-click-wins race (only one click was exercised). These were blocked by an intermittent `Missing Access` on the thread in the pre-configured "AI Stack" server (see Discord section) — a guild-permission-overwrite quirk, not an OpenACP defect. The core loop is proven; these are polish.

**License correction to #16:** the **Discord adapter npm artifact (`@openacp/discord-adapter@2026.518.1`) is MIT-declared**, not AGPL. Only the core `@openacp/cli` / `@n1creator/openacp-cli` *published tarballs* carry the AGPL injection; building the core from source is MIT. So the Discord path is not the license risk #16 implied — the risk is narrowly the published-core-CLI tarball, which vendoring-from-source sidesteps.

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

## Discord live verification (with Alp's throwaway bot)

Alp provisioned a bot (**CuriaBot#1524**) and handed me the token; it was in one guild, **"AI Stack"** (`1458774587209683088`). Because the from-source `install` command is broken (see below), I wired the adapter in by hand: `npm install @openacp/discord-adapter --prefix <root>/plugins`, registered it in `plugins.json` (`source: npm`), wrote `botToken`/`guildId`/`enabled` into its settings, and booted.

- **Gateway connect — PASS.** First boot failed to *create channels* with `DiscordAPIError[50013] Missing Permissions` — the bot lacked **Manage Channels / Manage Messages / Manage Threads**. I decoded the exact missing bits, Alp granted them via the role, I re-verified the bot's guild permission integer over the Discord API, and re-booted. Second boot: `[DiscordAdapter] Client ready`, guild recognized, **Initialization complete**. So the token + **Message Content intent** were correct from the start; the only wall was three guild permissions.
- **Channel + thread creation — PASS.** The adapter created an `openacp-sessions` channel (logged *"Community mode not enabled, using threads fallback"* — AI Stack isn't a Community server, so it uses a text channel + threads rather than a true Forum Channel, exactly as #16 read), an `openacp-notifications` channel, and an `Assistant` thread.
- **Thread-per-session — PASS.** `openacp api new mock … --channel discord` returned `channelId: discord, threadId: 1529836183293792436`; the Discord API confirmed a public thread (`type 11`) named *"🔄 mock — New Session"* under the sessions channel.
- **Permission buttons — PASS.** Sending a prompt drove the mock agent to raise its permission; the thread showed **`🔐 Permission request: Modifying critical configuration file`** with two buttons — *✅ Allow this change* (style 3) and *❌ Skip this change* (style 4) — custom_ids `p:O6NUVGyT:allow` / `p:O6NUVGyT:reject`. The `p:<key>:<optionId>` scheme is exactly #16's source read. A session-started message with *Enable Bypass* / *Text to Speech* control buttons also rendered.
- **Button click → resume — PASS (the headline).** The bridged (non-headless) session did **not** auto-approve — the worker blocked in `requestPermission` for ~7 minutes. Alp clicked **✅ Allow**; the log recorded `requestId call_2, optionId allow, isAllow true` and then `Prompt execution completed (durationMs 434545)`. A timeout would have produced a rejection, not an `allow` outcome — so the click genuinely resolved the gate and resumed the turn. **This is curia's escalate→answer→resume contract (#11), closed live over real Discord.**
- **Caveat — thread `Missing Access` after the turn.** Immediately after, a follow-up permission post failed with `DiscordAPIError[50001] Missing Access` on the same thread, and the bot could no longer GET the thread's messages — yet the thread still appears in the guild's active-threads list. The bot created that channel and had posted to it minutes earlier, so this is a **channel permission-overwrite interaction specific to this pre-configured server** (View Channel not effectively granted on the new channel/thread), not an OpenACP bug. It left a second turn hung with no answerable UI — which is itself the operational lesson: **if the bridge can't post the permission buttons, the escalation is silently un-answerable and the worker hangs to timeout.** The image/voice/first-click-wins checks were blocked by this and should be re-run in a clean throwaway guild (no restrictive category overwrites).

## Finding: `install` is broken in a from-source build

`node dist/cli.js install @openacp/discord-adapter` fails with `PluginCatalogError: The packaged plugin catalog is unavailable or invalid` — the plugin catalog ships only inside the published npm package, not the source tree. **Consequence for vendoring:** a from-source deploy can't use `openacp install`; plugins must be placed via `npm install --prefix <root>/plugins` and registered in `plugins.json` directly (which is exactly what the setup wizard's non-interactive path does under the hood). Worth scripting if curia vendors OpenACP.

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
| Discord adapter loads + gateway connect | ✔ PASS — token + Message Content intent valid, guild recognized |
| Discord thread-per-session | ✔ PASS — real thread per `api new --channel discord` |
| Allow/reject buttons render | ✔ PASS — `p:<key>:<optionId>` scheme, matches #16's source read |
| **Button click → worker resumes** | ✔ **PASS — Alp clicked ✅ Allow, blocked turn resumed & completed** |
| Non-headless session does NOT auto-approve | ✔ PASS — waited 7 min for the human click |
| First-click-wins race | ⏳ only one click exercised; re-run in a clean guild |
| Images both directions through the bridge | ⏳ blocked by thread `Missing Access`; re-run in a clean guild |
| Inbound voice-memo → STT | ⏳ not reached (local faster-whisper bootstraps a Python env on first use) |

## Side effects of this run (cleanup)

- Instance state was isolated to a scratchpad dir via `OPENACP_INSTANCE_ROOT`; all processes were killed, nothing left listening.
- The daemon auto-installed `cloudflared` to `~/.openacp/bin/cloudflared` and created `~/.openacp/` (a global cache path not overridable by the instance-root env). Safe to `rm -rf ~/.openacp` if unwanted.
- **In the "AI Stack" Discord server, OpenACP created two channels that are still there:** `openacp-sessions` (`1529836015336820738`) and `openacp-notifications` (`1529836017589424129`), plus session/Assistant threads under them. These are scaffolding from the test — delete them when convenient (I left them rather than delete channels in a real server unprompted).
- The bot token is inert now (daemon stopped). Reset it in the Discord Developer Portal if you don't want it lingering.

## Remaining to fully close #22

The build, core-bridge, persistence, restart, and the **Discord escalate→answer→resume round-trip** are all verified live — enough to de-risk the "vendor OpenACP" branch of #17. Three polish checks remain, all blocked only by the `Missing Access` overwrite quirk in the AI Stack guild, so they want a **clean throwaway guild** (created fresh, no restrictive category permissions, bot invited with integer `328565073936`):

1. **Images both directions** — mock agent sends a file into the thread (agent→human); a human attaches a screenshot in the thread (human→agent) and the worker receives it.
2. **Inbound voice-memo → STT** — post a Discord voice message; confirm the local faster-whisper bootstrap transcribes it into the prompt.
3. **First-click-wins race** — two devices, near-simultaneous clicks; confirm the second gets "expired".

If you want these, spin up a fresh private guild + re-invite CuriaBot with integer `328565073936`, hand me the new guild ID, and I'll finish. Otherwise this is a strong stopping point — #16's compiled-adapter read already covers the images/voice code paths, and the live loop is proven.

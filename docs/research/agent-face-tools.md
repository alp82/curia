# Agent face tools — dashboards and remote UIs for coding agents

Date: 2026-08-09. **Scope:** tools that put a "face" (dashboard, mobile app, or remote UI) on coding agents. The three operator finds (kimaki, happy, pounce) plus close comparables. **Method:** primary sources only. GitHub READMEs, source trees, official docs sites, and the GitHub API. Every claim carries a URL or a repo file path. Repo metadata (stars, dates, license) comes from `gh api` on 2026-08-09.

**Relation to the [landscape scan](landscape-scan.md) (2026-07-21):** that scan covered dispatchers, Discord bridges, HITL frameworks, and terminal muxes. This report covers the *client surface* slot the scan did not fill: browser and phone UIs over a local agent daemon. Vibe Kanban, Orca, and the ebibibi/zebbern Discord bridges appear in the scan and are not re-surveyed here.

**Target for the steal-list:** curia's planned browser dashboard beside the daemon. Tailnet-only, identity allowlist, single operator. It shows running agents, an event feed, a frontier graph of tickets, and daemon settings.

---

## 1. kimaki — `remorses/kimaki`

1,296★, created 2025-09-02, pushed 2026-08-08, MIT, TypeScript ([API](https://github.com/remorses/kimaki)). Self-description: "all opencode features deeply integrated inside Discord. each project is a channel. each session a thread."

### Features
Kimaki is a "collaborative agent orchestrator" that drives [OpenCode](https://opencode.ai) from Discord ([README](https://github.com/remorses/kimaki/blob/main/README.md)). Channels map to project directories, threads map to OpenCode sessions. Feature list from the README, each with a docs page on [kimaki.dev](https://kimaki.dev):

- **Scheduled tasks** — cron or one-time runs, for example a morning email-digest thread.
- **The queue** — "queue a message to send when the current run finishes." End a message with `. queue`, edit it later.
- **btw** — "fork the current context into a new thread to ask a clarifying question in parallel while the agent keeps working."
- **Worktrees** — `/new-worktree` moves a session into an isolated folder mid-plan. `/merge-worktree` rebases back and asks the agent to resolve conflicts.
- **Diff viewer** — `/diff` generates "a shareable URL to review changes in a real diff viewer from your phone or browser."
- **Voice messages** — Kimaki transcribes Discord voice notes "using your project's file tree for accuracy."
- **Shell commands** — prefix a message with `!` to run it in the project directory.
- **Tunnels** — expose a local dev server on a public URL.
- **Interrupt semantics** — a message sent during a run waits about 3 seconds, then Kimaki "aborts it and force-sends your message, then resumes" ([Message Handling](https://kimaki.dev/docs/core-concepts/message-handling)).
- **Subscription auth** — OAuth against Claude Pro/Max and ChatGPT/Codex "the same way the native CLIs do." Multiple accounts rotate on rate limits.

### Dashboarding
There is no dashboard. Discord *is* the surface. The channel list is the project list, the thread list is the session list, and the message stream is the event feed. The only web surfaces are the shareable `/diff` and `/share` URLs.

### Mobile interactions
Via the stock Discord mobile app: text, voice notes (transcribed), images inline, slash commands, and the diff URL in the phone browser. Discord provides push notifications for free. No app of its own.

### Agent capabilities
OpenCode only, as the worker runtime. Through OpenCode it reaches "every model OpenCode supports: Anthropic, OpenAI, Google, and more" (README). It does not drive Claude Code, Codex CLI, or Gemini CLI directly. Spawn (new thread = new session), steer (interrupt + queue), resume, fork (`/btw`), abort. OpenCode permission prompts surface in the thread.

### Integrations
Discord (deep: threads, slash commands, roles, voice notes, attachments). Git worktrees. OpenCode commands, skills, and MCP prompts become Discord slash commands ([docs](https://kimaki.dev/docs/features/opencode-commands)). CI/GitHub Actions for programmatic sessions ([docs](https://kimaki.dev/docs/guides/ci-automation)).

### Tech stack
TypeScript monorepo. The CLI runs locally as the bridge between Discord and the machine. Dependencies in `cli/package.json`: `discord.js`, `@discordjs/voice`, `@opencode-ai/sdk` and `@opencode-ai/plugin` (embeds the OpenCode server), `libsql` + `drizzle-orm` (SQLite state), `@google/genai` (transcription), `cron-parser`, `ws`. Two connection modes (README "Setup"): **Gateway mode** uses Kimaki's pre-built hosted Discord bot (repo dir `gateway-proxy/`), **self-hosted mode** uses your own bot token.

### Limitations
- Single worker runtime (OpenCode). No Claude Code.
- The CLI must stay running on the dev machine.
- Gateway mode routes Discord traffic through the author's hosted bot infrastructure.
- Discord's UI ceiling: no graph views, no settings panels, message-length and embed limits.
- Bus factor 1 (the README's "I'm Tommy" section states one author does all development through it).

### USP
The deepest Discord-native mapping of agent work: channel = project, thread = session, with queue/fork/worktree verbs as messages.

### Pricing
MIT, free. No paid tier found on kimaki.dev. Model costs ride the user's own subscriptions or API keys.

### Requirements
A Discord server, Node (npx), a machine with the project directories, and either the one-click gateway bot or a self-made Discord bot. Access control via Discord roles ("Kimaki" / "no-kimaki" roles, README "Access Control").

### Steal-worthy ideas for curia
- **The queue verb.** "Send when the current run finishes" is a first-class dashboard action, not a chat hack. Curia's steer box can offer "send now (interrupt)" and "queue for after this run."
- **Interrupt-after-grace semantics.** Wait ~3 s for the current tool call, then abort and inject. A precise, documented policy for what "send" means mid-run.
- **`/btw` context forking.** Ask the agent a side question in a parallel thread without disturbing the run. Maps to a "ask about this session" affordance in the dashboard.
- **Shareable diff URL as a standalone artifact.** The diff viewer is a small web page decoupled from the chat surface. Curia can render the same page inside the tailnet.
- **Scheduled tasks in the dispatcher.** Cron-started sessions as tickets, edited from the settings screen.

---

## 2. happy — `slopus/happy` ("Happy Coder")

23,232★, created 2025-07-18, pushed 2026-08-07, MIT, TypeScript ([API](https://github.com/slopus/happy)). Self-description: "Mobile and Web client for Codex and Claude Code, with realtime voice, encryption and fully featured."

### Features
From the [README](https://github.com/slopus/happy/blob/main/README.md) and `packages/happy-cli/README.md`:

- Run `happy` instead of `claude`: the wrapper starts the agent, prints a QR, and mirrors the session to phone and web.
- "Switch devices instantly — Take control from phone or desktop with one keypress."
- Push notifications "when agents need permissions or encounter errors."
- "End-to-end encrypted — Your code never leaves your devices unencrypted." "No telemetry, no tracking."
- A background **daemon**: "It lets you spawn and manage coding sessions remotely — from your phone or the web app — without needing an open terminal" (`packages/happy-cli/README.md`).
- Realtime voice assistant that can message sessions and answer permission requests by voice (`docs/voice-architecture.md`).

### Dashboarding
The app (web at app.happy.engineering, plus iOS/Android) shows a session list across machines, a per-session transcript with tool calls, permission prompts as tappable approvals, and a new-session flow driven by the daemon. It is session-centric chat UI, not an analytics dashboard.

### Mobile interactions
Native iOS and Android apps built with Expo/React Native (monorepo `packages/happy-app`). Push notifications on permission requests and errors (README). Realtime voice via an embedded ElevenLabs conversational agent. The voice agent routes tool calls to the currently focused session and can inject context and process permission requests (`docs/voice-architecture.md`, `docs/paid-voice.md`).

### Agent capabilities
Wider than the front-page claim. `packages/happy-cli/README.md` lists: `happy claude` (default), `happy codex`, `happy agy` (Antigravity, "Gemini's successor"), `happy gemini` (deprecated), `happy openclaw`, and "any ACP-compatible CLI" via `happy acp <cmd>`. Spawn (from phone, via daemon), steer (send messages), approve (permission prompts as buttons, plus voice). Caveat the README itself flags: the agy backend is one-shot `agy --print` with "no interactive approval surface," so approval gating there is flag-selection only, not per-tool prompts.

### Integrations
Claude Code, Codex, Antigravity, OpenClaw, ACP CLIs. No GitHub/issue-tracker integration and no chat-platform bridge. MCP config passes through to the wrapped agent.

### Tech stack
TypeScript monorepo: `packages/happy-app` (Expo app + web), `packages/happy-cli` (wrapper + daemon), `packages/happy-server` (private source, hosted backend), `packages/happy-server-self-host` (publishing shell), `packages/happy-wire` (protocol). Transport is a **cloud relay**: clients talk HTTP/WebSocket to a server backed by Postgres, and the server stores only ciphertext. "Keep the server blind to user content (end-to-end encryption on clients)" — legacy NaCl boxes or AES-GCM under a dataKey (`docs/encryption.md`). Self-hosting exists: `happy server` runs the bundled server "with embedded PGlite storage and local filesystem uploads — no Postgres, no Redis, no S3" (`packages/happy-server-self-host/README.md`), though the canonical server source stays private.

### Limitations
- Relay-shaped: default operation depends on the hosted backend. The self-host package wraps a private-source server.
- Chat-per-session UI, no fleet analytics, no ticket or queue model, no dispatcher.
- Voice is metered through ElevenLabs. Past roughly 20 minutes it requires a subscription, with a 5-hour hard cap (`docs/paid-voice.md`).
- No GitHub/issue integration.

### USP
The polished consumer-grade phone client for Claude Code, with E2E encryption and realtime voice.

### Pricing
MIT, free app and CLI. Realtime voice is the paid surface: free up to ~20 min/30 days, then "subscription_required" (`docs/paid-voice.md`). Agent costs ride the user's own Claude/Codex accounts.

### Requirements
`npm install -g happy` on the dev machine, the mobile app or web client, and QR pairing. Default mode uses the hosted relay account-lessly (key-pair identity). Optional local self-host server.

### Steal-worthy ideas for curia
- **Daemon-spawned sessions with stateless clients.** The daemon owns session lifecycle. Phone, web, and terminal are interchangeable viewers that can each take control. Curia's dashboard should be a stateless view over daemon state, so a second device needs no migration.
- **Push on "needs permission" and "error" only.** Notification policy tuned to blockage, not chatter. Curia can mirror this with ntfy/Web Push from the daemon over the tailnet.
- **Permission prompts as structured UI.** Render Claude Code permission requests as typed approve/deny objects in the event feed, not as text.
- **The inverse lesson on encryption.** Happy spends a whole protocol (`docs/encryption.md`, `docs/protocol.md`) making a public relay blind. A tailnet with an identity allowlist deletes that entire problem. Curia should treat Tailscale identity headers as authentication and skip application-layer crypto.
- **Wrapper-command onboarding.** `happy claude` instead of config files. Curia equivalents: a one-line daemon flag that enrolls a session into the dashboard.

---

## 3. pounce — `pounce-ai/pounce`

5★ (young repo), created 2026-06-17, pushed 2026-08-09, MIT, TypeScript ([API](https://github.com/pounce-ai/pounce)). Self-description: "Pounce — control your coding agents from your phone. Mobile app, desktop Bridge, bridge server." Site: [use-pounce.com](https://use-pounce.com).

### Features
From the [repo README](https://github.com/pounce-ai/pounce/blob/main/README.md) and the docs in `apps/web/src/content/docs/docs/`:

- "Pounce lets you steer Claude, Codex & opencode across every machine you own — from your phone. Watch agents work in real time, jump in by voice, review diffs, and ship, all one-handed" (README).
- **Full local history**: "every session the agent has on that machine appears in Pounce, not just the ones you start from the phone" (`docs/agents.md`). Pounce reads each agent's own on-disk history format.
- **Start and steer**: "kick off new sessions from the phone, reply mid-session, or redirect an agent that's headed the wrong way" (`docs/agents.md`).
- **Interactive prompts**: "permission requests, plan approvals, multiple-choice questions: whatever the CLI asks, you can answer from your phone" (`docs/agents.md`).
- **"Needs you" triage**: the landing page surfaces threads that wait on the operator ([use-pounce.com](https://use-pounce.com)).
- **Changes screen**: full diff with syntax highlighting, then commit / push / commit-and-push / create PR from the phone. "Committing straight onto main or master asks first" (`docs/changes.md`).
- **Activity screen**: a year heatmap across machines, streaks, trends, and breakdowns by agent, model, and project. Cost policy: "Pounce reports what your agents actually reported, not an estimate," and estimates are labeled as estimates (`docs/activity.md`).
- **Spaces**: "A Space is one project on one machine." Worktrees group under their parent project by asking git, not by parsing paths, and merged-then-deleted worktrees still attribute correctly (`docs/spaces.md`).
- **MCP server**: five read-only tools (`search_history`, `list_threads`, `get_thread`, `list_markers`, `recent_activity`) so any agent can search cross-agent history on the machine ([docs/mcp](https://use-pounce.com/docs/mcp)).
- **Voice**: press-to-talk with on-device transcription ([use-pounce.com](https://use-pounce.com)).
- **Machine sharing** and Spaces/devices shipped mid-2026 (changelog files `apps/web/src/content/changelog/2026-08-08-machine-sharing.md`, `2026-08-05-spaces-and-devices.md`).

### Dashboarding
The strongest of the three. Home: a fleet list of sessions across machines with stacking filters for "status, agent, device, and branch or worktree" plus Space (`docs/spaces.md`). Per session: live token-by-token reasoning and tool stream. Changes: diff plus git verbs, docked beside the transcript on desktop (`docs/changes.md`). Activity: the analytics screen above. Search across all agents' histories.

### Mobile interactions
Native iOS app on the App Store, Android in Play testing ([use-pounce.com/docs/getting-started](https://use-pounce.com/docs/getting-started)). Press-to-talk voice with on-device transcription. One-handed diff review and shipping. QR pairing, including scanning a QR printed in an SSH terminal (`docs/remote-access.md`).

### Agent capabilities
Claude Code (`claude`), Codex (`codex`), Cursor (`cursor-agent`), opencode (`opencode`) (`docs/agents.md`). "Pounce drives the agent CLIs already installed on your machine. No extra accounts, no API keys handed to Pounce." Spawn, steer mid-session, and answer any interactive prompt. Any MCP client can additionally consume the history server.

### Integrations
Git (commit/push/PR from the Changes screen). MCP (read-only history server for all agents). Reads `CLAUDE.md` and `AGENTS.md` per project and shows them in the Space view (`docs/spaces.md`). No chat-platform or issue-tracker integration.

### Tech stack
TypeScript/Bun monorepo (README "Repo layout"): `apps/mobile` (Expo/React Native, shared with the desktop app), `apps/bridge` (`server.mjs`, "the native agent host + LAN HTTP surface"), `desktop` (react-native-macos/windows with the bridge embedded), `apps/web` (Astro + Starlight on Cloudflare). The agent host is a native daemon called `kittylitter` (README dev prereqs). Transport: on LAN, the app talks directly to a token-protected HTTP surface. Off network, "Pounce's own secure peer-to-peer tunnel (built on [iroh](https://github.com/n0-computer/iroh))" dials the machine "by its identity, not its address." "There's no Pounce relay account and no cloud inbox" (`docs/remote-access.md`). A `--lan` flag disables the tunnel entirely. Per-machine random tokens, QR as the credential.

### Limitations
- Young: the public monorepo has 5 stars and the apps shipped mid-2026 (changelog).
- Android still in testing. Desktop app is macOS Apple Silicon (Windows/Linux get the headless Bridge).
- The `kittylitter` agent host is a native binary dependency, not plain source in this repo.
- Very large diffs are truncated on the phone (`docs/changes.md`).
- No dispatcher, no ticket model, no chat bridge. It observes and steers, it does not route work.

### USP
A fleet remote that derives everything from the agents' own on-disk history, over direct peer-to-peer transport with no cloud middleman.

### Pricing
MIT, open source, no pricing page or tiers found on use-pounce.com.

### Requirements
The phone app plus one of: `npx use-pounce` in a terminal (works over SSH), the macOS app, or the headless Bridge bundle for Windows/Linux. QR pairing per machine. Agents run "on your computer, under your own accounts and logins — Pounce is the remote, not the runtime" (`docs/agents.md`).

### Steal-worthy ideas for curia
- **Derive state from disk, do not require registration.** Pounce indexes the session files Claude Code and friends already write. Curia's dashboard can show *all* Claude Code sessions on the box, not only daemon-dispatched ones, by reading `~/.claude/projects/*` transcripts.
- **"Needs you" as the top-level sort.** Blocked-on-operator threads float above everything. This is the correct default for a single-operator event feed.
- **The Space data model: project × machine, worktrees folded by git parentage.** Curia dispatches per-issue worktrees. Group them under the parent repo by asking git, and keep attribution after worktree deletion.
- **Diff-then-ship with a main-branch confirm.** One screen: diff, commit (agent-written message option), push, PR. Guard rails as confirmations, not prohibitions.
- **Honest cost reporting.** Show what the agent reported, label estimates as estimates, and accept that flat-rate plans make per-session dollars "fiction."
- **LAN-only flag.** `--lan` maps exactly to curia's stance: on a tailnet, the tunnel layer is unnecessary, so a bind-to-tailnet-interface design is the entire transport story.
- **Read-only MCP history server.** Expose the daemon's ticket and session history to the agents themselves as read-only MCP tools.

---

## Close comparables (verified, kept short)

- **Omnara** (`omnara-ai/omnara`, 2,713★, Apache-2.0, Go): formerly a mobile "command center" for Claude Code. The current [README](https://github.com/omnara-ai/omnara) describes "an open source platform for running managed agents" with Postgres-durable state, sandbox providers, a web console, and a Slack connector. It has pivoted from phone-face to managed runtime, so it no longer competes for this slot. Noted for the durable-state design.
- **Conductor** ([conductor.build](https://conductor.build)): a macOS app that runs "parallel Claude Code, Codex, and Cursor agents in isolated workspaces" with review-and-merge. Desktop-only, closed source, no remote/mobile story. Comparable as a fleet UI pattern, not as a remote face.
- **Vibe Kanban, Orca, ebibibi/zebbern Discord bridges, chadingTV/claudecode-discord**: already covered in the [landscape scan](landscape-scan.md). Vibe Kanban remains the best kanban-dispatcher blueprint but is sunsetting. Orca remains the unevaluated substrate contender with desktop/mobile/VPS attach.
- Dropped as not genuinely comparable: terminal-web bridges (ttyd, sshx, tmate — generic muxes, no agent awareness, see the scan) and cloud-agent products that own the runtime (Cursor background agents, Codex cloud, Claude Code web), because curia's agents run beside its own daemon.

---

## Comparison table

| Dimension | kimaki | happy | pounce |
|---|---|---|---|
| Face | Discord (channels/threads) + diff web page | Native iOS/Android + web app | Native iOS (Android beta) + macOS app |
| Main screen | Discord thread stream | Session list + chat transcript | Fleet list, filters, "Needs you", Activity analytics |
| Agents | OpenCode only (any model via it) | Claude Code, Codex, Antigravity, OpenClaw, any ACP CLI | Claude Code, Codex, Cursor, opencode |
| Spawn / steer / approve | Yes / queue + 3 s interrupt / via OpenCode prompts | Yes (daemon) / yes / typed permission buttons + voice | Yes / yes / "whatever the CLI asks" |
| Voice | Voice notes, transcribed with file-tree context | Realtime ElevenLabs assistant (metered) | Press-to-talk, on-device transcription |
| Push notifications | Via Discord | Yes (permissions, errors) | Not documented as push (live streaming UI) |
| Diff review | Shareable web diff URL | In-transcript | Dedicated Changes screen + commit/push/PR |
| Transport | Local CLI ↔ Discord API (gateway bot or own bot) | Cloud relay, E2E encrypted (NaCl / AES-GCM), self-host option | LAN HTTP + iroh p2p tunnel, no relay account, `--lan` mode |
| State store | Local SQLite (libsql + drizzle) | Server Postgres (ciphertext), PGlite self-host | Agents' own on-disk histories, indexed |
| Integrations | Discord, git worktrees, MCP-as-slash-commands, CI | ACP, MCP passthrough | Git verbs, read-only MCP history server, CLAUDE.md display |
| License / pricing | MIT, free | MIT, free, paid voice metering | MIT, free, no tiers |
| Requirements | Discord server + local CLI | CLI wrapper + hosted relay (or self-host) + app | Bridge/CLI per machine + phone app, QR pairing |
| Key limitation | OpenCode-only, Discord UI ceiling | Relay-centric, private server source, no fleet view | Young, no dispatcher, macOS-centric desktop |
| USP | Deepest Discord mapping of agent work | Consumer-grade E2E phone client with voice | Fleet remote from on-disk history, p2p, no cloud |

---

## Steal-list for curia's tailnet-only dashboard

Ordered by fit for tailnet-only, single operator, daemon-adjacent. Each item names its source.

1. **"Needs you" triage as the home screen's top band** (pounce). Sessions blocked on a permission, a question, or an error sort above running ones. For one operator, the dashboard's first job is "where am I the bottleneck." Fits the planned event feed directly: make blockage a state, not an event.
2. **Derive sessions from disk, not from registration** (pounce). Index `~/.claude/projects/*` transcripts and daemon records together. The dashboard then shows every Claude Code session on the machine, including hand-started ones, with zero enrollment. This also gives cross-session full-text search almost free.
3. **Structured approval objects in the feed** (happy, pounce). Render permission requests, plan approvals, and `AskUserQuestion` as typed cards with buttons, streamed over one WebSocket/SSE channel from the daemon. Happy's protocol docs (`docs/protocol.md`, `docs/permission-resolution.md` in slopus/happy) are a working reference for the message shapes.
4. **Queue vs interrupt as explicit send modes** (kimaki). The steer box gets two verbs: "queue after this run" and "interrupt (grace ~3 s, then abort and inject)." Curia already dispatches runs, so the daemon owns the queue. This removes the worst chat-remote failure: a message stuck behind a long tool call.
5. **Space = project × machine, worktrees folded by git parentage** (pounce). Curia's frontier graph nodes are issues, but each issue's worktree should group under its repo by asking git. Attribution must survive worktree deletion. This is the data model that keeps a worktree-heavy dispatcher legible.
6. **Diff-then-ship screen with confirm-on-main** (pounce, kimaki). One page per session: full diff, commit with agent-written message, push, open PR via `gh`. Tailnet-only means the page needs no sharing infrastructure. Kimaki proves the diff page works well as a standalone URL the operator can open from anywhere.
7. **Tailnet identity replaces the crypto layer** (inverse lesson from happy, confirmed by pounce's `--lan`). Bind the dashboard to the tailnet interface, read the Tailscale identity header, check the allowlist, done. Happy's E2E protocol and pounce's iroh tunnel both solve "untrusted network," which curia does not have. Do not rebuild either.
8. **Push on blockage only** (happy). Notify on "needs permission" and "error," nothing else. Over a tailnet this can be a self-hosted ntfy topic or Web Push from the daemon. It complements item 1: the push is the doorbell, "Needs you" is the queue.
9. **Honest cost panel** (pounce). Show what the agent session records report. Label estimates. Show rate-limit-window burn for subscription plans instead of fictional dollars. Small feature, large trust payoff for a settings-and-ops dashboard.
10. **Read-only MCP history server** (pounce). Expose tickets, verdicts, and session history from the daemon as read-only MCP tools, so dispatched agents can search prior curia work. Deliberately read-only, so the surface stays safe.
11. **Scheduled tasks as first-class tickets** (kimaki). Cron-created sessions already fit curia's issue-driven model: a schedule that files or re-opens an issue. Edit schedules from the dashboard settings screen.

# Agent face tools — dashboards and remote UIs for coding agents

Date: 2026-08-09. **Scope:** tools that put a "face" (dashboard, mobile app, or remote UI) on coding agents. The three operator finds (kimaki, happy, pounce) as deep dives, plus a full alternatives sweep (this file, chapter "Alternatives survey"): open-source browser faces, desktop apps, first-party cloud faces, and dead or pivoted tools. **Method:** primary sources only. GitHub READMEs, source trees, official docs sites, and the GitHub API. Every claim carries a URL or a repo file path. Repo metadata (stars, dates, license) comes from `gh api` on 2026-08-09.

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

## Alternatives survey (sweep 2026-08-09)

A hard sweep for other tools that put a face on coding agents. Inclusion bar: the tool's job is a UI or control surface over coding agents. Plain IDE assistants, plain CLIs, and TUI-only managers stay out. Vibe Kanban, Orca, and the Discord bridges stay in the [landscape scan](landscape-scan.md). All repo numbers come from `gh api` on 2026-08-09.

### Local open-source faces (browser or phone over your own machine)

#### CloudCLI, aka Claude Code UI — `siteboon/claudecodeui`
13,190★, created 2025-06-25, pushed 2026-08-04, AGPL-3.0 ([repo](https://github.com/siteboon/claudecodeui)). The most-adopted self-hosted web face for Claude Code. `npx @cloudcli-ai/cloudcli` starts a local Node server (Node 22+). The browser gets a project list, a chat transcript per session, an integrated shell terminal, a file tree with live editing, a git panel (stage, commit, branch switch), and browser-use sessions ([README](https://github.com/siteboon/claudecodeui/blob/main/README.md)). It drives Claude Code, Cursor CLI, Codex, and OpenCode (repo description). Mobile story: a responsive web UI with touch navigation, no native app. A plugin system adds custom tabs and backend services. The project now leads with a paid hosted offer, "CloudCLI Cloud" (managed containers, mobile app, API) at [cloudcli.ai](https://cloudcli.ai). Limitations: AGPL, session-centric chat with no fleet view, and the open-source path now sits behind the cloud offer in the README. For curia it confirms that the git panel belongs on the same page as the transcript.

#### Codeman — `Ark0N/Codeman`
633★, created 2026-01-21, pushed 2026-08-09, MIT ([repo](https://github.com/Ark0N/Codeman)). "Self-hosted mission control for AI coding agents." It spawns Claude Code, OpenCode, Codex, Antigravity, or Gemini CLI inside persistent tmux sessions and streams the real terminal to any browser ([README](https://github.com/Ark0N/Codeman/blob/master/README.md)). The face shows session tabs, live floating windows per subagent, and plan usage in the header. Mobile: a touch-optimized terminal with instant local echo, QR login, swipe navigation, and push notifications. A "respawn controller" re-prompts idle agents and auto-resumes when a subscription limit resets, for 24+ hour unattended runs. Scheduled jobs exist too. Sessions run locally, in Docker, or over SSH. Stack: TypeScript, Fastify, tmux, Node 22+. It binds to loopback by default, and a network bind without a password needs an explicit confirmation. Free, MIT. Limitations: young, small bus factor, and the face streams a terminal instead of structured state. Steal: limit-reset auto-resume as a daemon policy.

#### Agent of Empires (aoe) — `agent-of-empires/agent-of-empires`
3,020★, created 2026-01-09, pushed 2026-08-08, MIT ([repo](https://github.com/agent-of-empires/agent-of-empires)). A session manager driven from a TUI or from a browser web dashboard, installable as a PWA ([README](https://github.com/agent-of-empires/agent-of-empires/blob/main/README.md), [web dashboard guide](https://www.agent-of-empires.com/guides/web-dashboard/)). Agents: 15 CLIs, among them Claude Code, OpenCode, Codex, Gemini, Cursor, Copilot, and Factory Droid. The web dashboard defaults to a **structured view**: native rendering of agent state via the Agent Client Protocol, with plan panels, tool-call cards, and swipe-to-approve. Each session can flip to a raw tmux terminal view. A status column shows running, waiting, or idle. It adds tmux persistence, git worktrees, Docker/Podman sandboxing, a diff view, session resume across reboots, and browser/PWA push when an agent needs attention. Remote access: press `R` in the TUI to expose the dashboard over HTTPS with QR plus passphrase auth, via Tailscale Funnel or Cloudflare Tunnel. A CLI and HTTP API serve external orchestrators. Limitations: Linux/macOS only, tmux required, no dispatcher. Steal: the dual render (structured cards by default, raw terminal as escape hatch) and the tailnet-friendly exposure flow.

#### VibeTunnel — `amantus-ai/vibetunnel`
4,629★, created 2025-06-15, pushed 2026-08-05, MIT ([repo](https://github.com/amantus-ai/vibetunnel)). "Turn any browser into your terminal & command your agents on the go" (repo description). A terminal-to-browser proxy: run any command through `vt` and the live terminal renders in a web page. It ships as a macOS menu-bar app (Apple Silicon only) and as an npm package for Linux and headless systems. Windows is not supported ([#252](https://github.com/amantus-ai/vibetunnel/issues/252)). It is agent-agnostic: terminal titles and a git follow mode exist, but there is no structured agent state, no approvals, and no diff screen. Mobile: any phone browser against the server, with remote-access options documented at [docs.vibetunnel.sh](https://docs.vibetunnel.sh). Free, donations via Polar. This is the modern gotty-class bridge: a good fallback surface, not a face. It proves raw-terminal-in-browser is a solved commodity curia does not need to build.

#### MuxAgent — [muxagent.com](https://muxagent.com/en/)
A phone-first remote: iOS and Android apps pair to a local daemon (`muxagent daemon start`) via QR and drive "Claude Code, Codex, Gemini CLI, Copilot, OpenCode, and Goose — across every machine you work on" (site). Transport: an end-to-end encrypted "zero-knowledge relay". The relay source is open and self-hostable, but the site states the hosted relay is currently offline. That is a strong fragility signal. No pricing published, no public app repo found via GitHub search. Same shape as happy (daemon plus relay plus phone app) with far less traction. Watch, do not depend on.

#### Small faces and monitors (one paragraph)
A cluster of small dashboards over Claude Code hooks and transcripts, verified to exist via GitHub search on 2026-08-09 but not re-verified deeper: [`hoangsonww/Claude-Code-Agent-Monitor`](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) (894★, live analytics, kanban status board, WebSocket push), [`simple10/agents-observe`](https://github.com/simple10/agents-observe) (641★, real-time event dashboard with token costs), [`mixpeek/amux`](https://github.com/mixpeek/amux) (335★, "control plane" web dashboard plus phone, tmux-native), [`SirAllap/agentglass`](https://github.com/SirAllap/agentglass) (284★, live cost and tool calls, holds on dangerous actions), [`decolua/9remote`](https://github.com/decolua/9remote) (497★, phone terminal), and [`BlackBeltTechnology/pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard) (233★, mobile-first remote for pi sessions). They confirm demand for the event-feed face. None has the operator-verb depth curia needs.

### Desktop apps

#### Conductor — [conductor.build](https://conductor.build) (Melty Labs)
A closed-source macOS app from Melty Labs (YC S24, earlier product: the Melty editor — this resolves the "melty" trail). It runs parallel Claude Code, Codex, and Cursor agents in isolated workspaces. The UI shows at a glance what each agent works on, then review and merge ([conductor.build](https://conductor.build), current release 0.79.0). No remote or mobile story. The site has pricing and enterprise pages; the app is a free download. A fleet-UI pattern reference, not a remote face.

#### Sculptor — `imbue-ai/sculptor` (Imbue)
213★, created 2025-08-07, pushed 2026-08-08, MIT ([repo](https://github.com/imbue-ai/sculptor)). A desktop app (Mac Apple Silicon, Linux) that runs coding agents in parallel isolated workspaces. The README labels it an "experimental research preview". Harnesses: Claude Code and the [Pi harness](https://pi.dev) integrated, plus "any terminal-based agents". It ships a skills library (spec, mocks, fix-bug) and an experimental container backend for Docker or a remote machine ([docs](https://github.com/imbue-ai/sculptor/blob/main/docs/help/experimental/container_backend.md)). The site leads with Pairing Mode: bidirectional sync of an agent's containerized work into the local IDE ([imbue.com/sculptor](https://imbue.com/sculptor/)). Free in beta, BYO Claude account. No mobile or remote face. Pairing Mode is the strongest answer anyone has for "get the agent's work into my editor now". Curia's per-issue worktrees give a near equivalent through plain `git worktree` plus open-in-editor.

#### Mux — `coder/mux` (Coder)
1,965★, created 2025-09-17, pushed 2026-08-09, AGPL-3.0 ([repo](https://github.com/coder/mux)). "A desktop app for isolated, parallel agentic development" from the Coder team. It runs from the browser or the desktop shell. Each workspace is isolated, with a central view of git status and rich markdown output (mermaid, LaTeX) ([mux.coder.com](https://mux.coder.com/)). It hosts its own agent loop against a choice of models (Sonnet, Opus, GPT-5, Grok, via a Mux Gateway with evaluation credits) instead of wrapping external agent CLIs. Open source, AGPL. No mobile story found. Relevant as a workspace-grid pattern, not as a remote.

#### AionUi — `iOfficeAI/AionUi`
31,735★, created 2025-08-07, pushed 2026-08-09, Apache-2.0 ([repo](https://github.com/iOfficeAI/AionUi)). A cross-platform desktop "Cowork" app with a built-in agent engine, plus wrappers for "dozens of external agents — including Claude Code, Codex, Qwen Code, Hermes Agent, Cursor Agent" ([README](https://github.com/iOfficeAI/AionUi/blob/main/README.md)). The face is a multi-agent chat workspace with file access and cron-scheduled 24/7 automation. Remote story: a WebUI plus Telegram, Lark, DingTalk, and WeChat bridges for phone access (README comparison table). Free, BYO API keys. The scope sprawls into consumer office assistants (PPT, Word, Excel), so it is a cowork product, not an operator dashboard. The IM-bridge remote is the on-topic part, and kimaki already covers that pattern better for curia.

#### cmux — `manaflow-ai/cmux`
25,811★, created 2026-01-28, pushed 2026-08-09, license NOASSERTION ([repo](https://github.com/manaflow-ai/cmux)). A native macOS (Swift/AppKit) Ghostty-based terminal built for agent multitasking ([README](https://github.com/manaflow-ai/cmux/blob/main/README.md)). The face is still a terminal, but agent-aware: panes get a blue "notification ring" when a coding agent needs attention, a notification panel collects pending ones, and the sidebar shows git branch, linked PR status, listening ports, and the latest notification per workspace. It adds an in-app scriptable browser, SSH workspaces, and one-command Claude Code teams. No web, no mobile. Included for one idea: attention state rendered at the window chrome, so "needs you" is visible from across the room.

### First-party cloud faces (brief cluster)
These products own the runtime. Sessions run in vendor cloud VMs, so they do not compete for the daemon-adjacent slot. They matter as UX references and for their local-session bridges.

- **Claude Code on the web + Claude mobile app** (Anthropic): sessions run on Anthropic-managed VMs at claude.ai/code, in research preview for Pro, Max, Team, and Enterprise. The Claude mobile app monitors and steers the same sessions. `claude --cloud` pushes a task up, `--teleport` pulls a session down into the terminal with branch checkout and full history, and `/tasks` lists cloud sessions from the CLI. Auto-fix watches PRs for CI failures and review comments ([docs](https://code.claude.com/docs/en/claude-code-on-the-web)). The daemon-adjacent exception: **Remote Control** (`--remote-control`) "exposes a local CLI session for monitoring from the web" ([docs](https://code.claude.com/docs/en/remote-control)) — a first-party face over a local session, exactly curia's slot.
- **OpenAI Codex cloud**: parallel tasks in isolated cloud environments, managed at chatgpt.com/codex, with entry points from GitHub PRs, Linear, and Slack, and a CLI for terminal access ([docs](https://learn.chatgpt.com/docs/cloud)).
- **Cursor cloud agents + iOS app**: isolated cloud VMs driven from [cursor.com/agents](https://cursor.com/cloud), Slack, Teams, GitHub, and Linear. The iOS app (2026) prompts agents and steers sessions "already running on a desktop or in the cloud" ([changelog](https://cursor.com/changelog/ios-mobile-app)). The desktop-steering half touches curia's slot. Android gets the web UI, not a native app.
- **Google Jules**: an async agent that clones the repo to a Google Cloud VM and works with Gemini. Web UI at jules.google.com, task assignment via a "jules" GitHub label, tiers at 15/100/300 tasks per day ([jules.google](https://jules.google/)).
- **Devin** (Cognition): a web app plus Slack, Linear, CLI, and API entry points ([cognition.com](https://cognition.com/blog/how-cognition-uses-devin-to-build-devin)). Subscription tiers on [devin.ai](https://devin.ai).
- **Factory**: "droids" driven from any browser or phone, a desktop app, and the `droid` CLI, with Linear, JIRA, Slack, GitHub, and PagerDuty integrations ([factory.ai/product/web](https://factory.ai/product/web)).

One pattern worth stealing from the whole cluster: every first-party face treats **handoff verbs** (cloud-to-terminal teleport, "Continue in") as core UX, not as an afterthought.

### Dead, stale, or pivoted

- **opcode**, formerly Claudia (`getAsterisk` → now [`winfunc/opcode`](https://github.com/winfunc/opcode)): 22,363★, AGPL-3.0, a Tauri desktop GUI for Claude Code. It browses `~/.claude/projects/`, resumes sessions, runs custom background agents, and shows a usage dashboard, MCP manager, and checkpoints (README). Last push 2025-10-16, about ten months stale. The core pattern (GUI derived from Claude Code's own on-disk state) lives on in pounce.
- **Crystal** ([`stravu/crystal`](https://github.com/stravu/crystal), 3,107★, MIT): a multi-session Claude Code/Codex worktree manager, deprecated 2026-02 and replaced by Nimbalyst, an "AI-native workspace" desktop product (README). A pivot away from the agent-face slot.
- **claude-code-webui** ([`sugyan/claude-code-webui`](https://github.com/sugyan/claude-code-webui), 1,142★, MIT): archived, last push 2026-05-29. Dead.
- **Terragon** ([`terragon-labs/terragon-oss`](https://github.com/terragon-labs/terragon-oss), 254★, Apache-2.0): a cloud background-agent orchestrator for Claude Code and Codex. It shut down in January 2026, and the repo is the open-sourced snapshot (repo description). Dead.
- **Omnara** ([`omnara-ai/omnara`](https://github.com/omnara-ai/omnara), 2,713★, Apache-2.0): formerly a mobile "command center" for Claude Code. The current README describes "an open source platform for running managed agents" with Postgres-durable state, sandbox providers, a web console, and a Slack connector. It pivoted from phone-face to managed runtime, so it no longer competes for this slot. Noted for the durable-state design.
- **Vibe Kanban** (`BloopAI/vibe-kanban`, 27,713★): the kanban dispatcher face, sunsetting. Covered in the [landscape scan](landscape-scan.md).

### Excluded, with reason

- **CCManager** ([`kbwo/ccmanager`](https://github.com/kbwo/ccmanager), 1,213★, MIT, active): TUI-only session manager across worktrees, no browser or phone face (README).
- **claude-squad** (8,260★, AGPL-3.0): TUI mux, covered in the [landscape scan](landscape-scan.md).
- **agent-deck** ([`asheshgoplani/agent-deck`](https://github.com/asheshgoplani/agent-deck), 688★, MIT): "One TUI", no remote face (description).
- **claude-hud** (`jarrodwatts/claude-hud`, 27,234★): a statusline HUD plugin inside Claude Code, not a control surface over it.
- **cc-switch** (`farion1231/cc-switch`): a provider and config switcher, not a session face.
- **ttyd, sshx, tmate, gotty-class muxes**: generic and agent-blind, covered in the [landscape scan](landscape-scan.md). VibeTunnel above stands in for the whole class.

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

## Comparison table — alternatives (condensed)

Daemon-adjacent = the agents run on the operator's own machine beside the tool.

| Tool | Face type | Agents | Mobile | Transport | Price | Daemon-adjacent |
|---|---|---|---|---|---|---|
| CloudCLI (claudecodeui) | Browser web UI (chat + terminal + git) | Claude Code, Cursor CLI, Codex, OpenCode | Responsive web | Local Node server, HTTP/WS | Free (AGPL) + paid cloud | Yes |
| Codeman | Browser mission control (tmux stream) | Claude Code, OpenCode, Codex, Antigravity, Gemini | Touch web, QR login, push | Local Fastify server, loopback default | Free (MIT) | Yes |
| Agent of Empires | TUI + web PWA (structured ACP view) | 15 CLIs | PWA, push, swipe-to-approve | Local server, Tailscale Funnel / CF Tunnel | Free (MIT) | Yes |
| VibeTunnel | Browser terminal proxy | Any (agent-blind) | Phone browser | Local server + tunnel options | Free (MIT) | Yes, no agent state |
| MuxAgent | Native iOS + Android apps | Claude Code, Codex, Gemini, Copilot, OpenCode, Goose | Native apps | E2E relay (hosted relay offline) | Unpublished | Yes, fragile |
| Conductor | macOS desktop | Claude Code, Codex, Cursor | None | Local app | Free download, closed source | Yes, desktop only |
| Sculptor | Desktop (Mac/Linux) | Claude Code, Pi, any terminal agent | None | Local app, containers | Free beta (MIT) | Yes, desktop only |
| Mux (Coder) | Desktop + browser workspaces | Own agent loop, model choice | None found | Local app | Free (AGPL) | Partial, own harness |
| AionUi | Desktop cowork + WebUI + IM bridges | Built-in engine + 20+ CLIs | WebUI, Telegram/Lark/DingTalk/WeChat | Local app + IM bridges | Free (Apache-2.0) | Yes |
| cmux | macOS terminal, agent-aware chrome | Any CLI in a terminal | None | Local app | Free (NOASSERTION) | Yes, terminal |
| Claude Code web + app | Vendor web + Claude mobile app | Claude Code | Claude app | Anthropic cloud VMs | Plan-included | No, except Remote Control |
| Codex cloud | Vendor web (chatgpt.com/codex) | Codex | ChatGPT surfaces | OpenAI cloud | Plan-included | No |
| Cursor cloud agents | Vendor web + iOS app | Cursor agents | iOS app, Android web | Cursor cloud VMs | Plan-included | No, iOS can steer desktop |
| Jules | Vendor web | Gemini agent | Web | Google Cloud VMs | Tiers: 15/100/300 tasks/day | No |
| Devin | Vendor web + Slack/Linear/API | Devin | Web | Cognition cloud | Subscription | No |
| Factory | Vendor web + desktop + CLI | Droids | Phone browser | Factory cloud | Subscription | No |

---

## Steal-list for curia's tailnet-only dashboard

Ordered by fit for tailnet-only, single operator, daemon-adjacent. Each item names its source.

1. **"Needs you" triage as the home screen's top band** (pounce; cmux confirms). Sessions blocked on a permission, a question, or an error sort above running ones. For one operator, the dashboard's first job is "where am I the bottleneck." Fits the planned event feed directly: make blockage a state, not an event. cmux renders the same state as a colored ring at the window chrome, so carry the "needs you" count into the browser tab title and favicon.
2. **Derive sessions from disk, not from registration** (pounce; opcode used the same source). Index `~/.claude/projects/*` transcripts and daemon records together. The dashboard then shows every Claude Code session on the machine, including hand-started ones, with zero enrollment. This also gives cross-session full-text search almost free.
3. **Structured approval objects in the feed** (happy, pounce, agent-of-empires). Render permission requests, plan approvals, and `AskUserQuestion` as typed cards with buttons, streamed over one WebSocket/SSE channel from the daemon. Happy's protocol docs (`docs/protocol.md`, `docs/permission-resolution.md` in slopus/happy) are a working reference for the message shapes. Agent of Empires shows the same idea over ACP, with swipe-to-approve on the phone.
4. **Dual render: structured cards by default, raw terminal as escape hatch** (agent-of-empires). The structured view is legible on a phone, but some interactions only make sense against the real terminal. Give every session a flip between the typed event feed and a live terminal view. This also caps how complete the structured renderer must be on day one.
5. **Queue vs interrupt as explicit send modes** (kimaki). The steer box gets two verbs: "queue after this run" and "interrupt (grace ~3 s, then abort and inject)." Curia already dispatches runs, so the daemon owns the queue. This removes the worst chat-remote failure: a message stuck behind a long tool call.
6. **Space = project × machine, worktrees folded by git parentage** (pounce). Curia's frontier graph nodes are issues, but each issue's worktree should group under its repo by asking git. Attribution must survive worktree deletion. This is the data model that keeps a worktree-heavy dispatcher legible.
7. **Diff-then-ship screen with confirm-on-main** (pounce, kimaki; CloudCLI confirms). One page per session: full diff, commit with agent-written message, push, open PR via `gh`. Tailnet-only means the page needs no sharing infrastructure. Kimaki proves the diff page works well as a standalone URL the operator can open from anywhere.
8. **Tailnet identity replaces the crypto layer** (inverse lesson from happy, confirmed by pounce's `--lan`). Bind the dashboard to the tailnet interface, read the Tailscale identity header, check the allowlist, done. Happy's E2E protocol and pounce's iroh tunnel both solve "untrusted network," which curia does not have. Do not rebuild either. If an off-tailnet guest ever needs a peek, Agent of Empires shows the cheap answer: a temporary Tailscale Funnel URL with QR plus passphrase, not a relay.
9. **Teleport as the dashboard-to-terminal handoff verb** (Claude Code web `--teleport`; Cursor "Continue in"). Every first-party face ships a one-command pull of a session into a local terminal: check out the branch, load the history, continue there. Curia's session page should print the exact command that resumes the dispatched worktree session in a terminal.
10. **Push on blockage only** (happy). Notify on "needs permission" and "error," nothing else. Over a tailnet this can be a self-hosted ntfy topic or Web Push from the daemon. It complements item 1: the push is the doorbell, "Needs you" is the queue.
11. **Honest cost panel** (pounce). Show what the agent session records report. Label estimates. Show rate-limit-window burn for subscription plans instead of fictional dollars. Small feature, large trust payoff for a settings-and-ops dashboard.
12. **Read-only MCP history server** (pounce). Expose tickets, verdicts, and session history from the daemon as read-only MCP tools, so dispatched agents can search prior curia work. Deliberately read-only, so the surface stays safe.
13. **Scheduled tasks as first-class tickets** (kimaki; Codeman confirms with scheduled jobs). Cron-created sessions already fit curia's issue-driven model: a schedule that files or re-opens an issue. Edit schedules from the dashboard settings screen.
14. **Limit-reset auto-resume as a daemon policy** (Codeman). When a run dies on a subscription rate limit, the daemon records the reset time and resumes the session when the window opens. Pair it with an idle re-prompt policy for long unattended runs. This is dispatcher logic, not UI, and it fits curia's daemon exactly.

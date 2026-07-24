# Landscape scan — sweep beyond Paseo / hermes-agent / pi / herdr

Date: 2026-07-21. **Sources swept:** GitHub (repo APIs + READMEs + docs sites) across five categories — (1) agent daemons with remote clients, (2) Discord-fronted agent bridges, (3) multi-agent orchestrators, (4) session-sharing / terminal-multiplexing substrates, (5) HITL escalation frameworks. **Method:** primary sources only — each surviving candidate verified with `gh api repos/<owner>/<repo>` for stars / created / last-push / license / open-issues, plus first-party README/doc reads. All star counts and dates are from the GitHub API on 2026-07-21; "stale" means no push in ≳3 months. Secondary write-ups were not used. Candidate list seeded from the task brief (claude-flow, claude-squad, claudia, opencode, OpenHands, AutoGen/AG2, CrewAI, LangGraph, Temporal, Dagster, Prefect, Windmill, n8n, Trigger.dev, mcp-discord, vibe-kanban, backlog.md, conductor, tmux/zellij/mosh/gotty/ttyd/sshx/tmate/wetty, humanlayer, gotoHuman, AgentInbox) and expanded with finds surfaced during the sweep (Orca, OpenHands Agent Canvas, the OpenACP ecosystem, ebibibi/zebbern Discord bridges, KOBA789/human-in-the-loop, Backlog.md, Hephaestus/Agentlas-OS).

## Verdict

**Nothing found replaces any of the four already-evaluated tools outright; a few overlap and one is a genuine new contender for a role curia had not filled.** The standout finds: **OpenHands "Agent Canvas"** (`OpenHands/OpenHands`, 81,558★) is the first mainstream, self-hostable, coding-agent-native **dispatcher** — it runs third-party agents including Claude Code/Codex with automations that trigger *on a schedule or via webhook* and integrate Slack/GitHub/Linear/Notion — but it speaks **no Discord** and owns its own ticket model, so it competes with hermes-agent's dispatcher role without matching its Discord+HITL bridge. **Orca** (`stablyai/orca`, 24,613★, MIT) is a serious new **substrate** contender — "run any coding agent… available on desktop, mobile and VPS" — overlapping Paseo/herdr's multi-device-attach slot. On the bridge side, two real self-hosted **Discord→Claude-Code bridges with button-based HITL** now exist (`ebibibi/claude-code-discord-bridge`, `zebbern/claude-code-discord`), narrowing (but not closing) the gap hermes-agent fills — they drive a single Claude Code session from Discord but have no dispatcher, no routing, and no voice. **The biggest gap curia still owns is the integration itself:** no single self-hostable tool combines a routing dispatcher + a two-way **Discord** HITL bridge + multi-device live-session attach + voice. hermes-agent remains the closest all-in-one; everything else is a partial that curia would glue or replace a slice of. **Voice input is essentially absent** across the entire non-Paseo/non-hermes field.

## Scored shortlist

Rubric: Role (D=dispatcher / W=worker / B=bridge / S=substrate). Cells are terse; prose below carries the nuance. ★ = GitHub stars 2026-07-21.

| Candidate | Role fit | Discord | Voice | Multi-device attach | Restart survival | Self-host | Maturity / license |
|---|---|---|---|---|---|---|---|
| **OpenHands** (Agent Canvas) | D (+ hosts W) | ✗ (Slack/GH/Linear) | ✗ | partial (local↔remote↔cloud) | yes (durable runs) | yes | 81,558★, 2024, NOASSERTION |
| **Orca** stablyai | S (+ any W) | ? unverified | ? | **yes (desktop/mobile/VPS)** | ? | yes (VPS) | 24,613★, 2026-03, MIT |
| **vibe-kanban** | **D** (kanban queue) | ✗ | ✗ | ✗ | yes (DB) | yes | 27,473★, Apache-2.0, **stale/sunsetting** |
| **claude-flow** | D (swarm routing) | ✗ | ✗ | ✗ | yes (AgentDB) | yes | 65,396★, MIT, bus≈1 |
| **Backlog.md** | D-slice (state store) | ✗ | ✗ | ✗ | yes (git .md) | yes | 6,249★, MIT |
| **claude-squad** | W-mux | ✗ | ✗ | tmux/ssh manual | tmux (not reboot) | yes | 8,152★, AGPL-3.0 |
| **sst/opencode** | W (client/server) | ✗ | ✗ | partial (server split) | — | yes | 188,240★, MIT |
| **ebibibi/cc-discord-bridge** | **B** (Claude Code) | **native bot** | ✗ | yes (sync/resume) | **yes** | yes | 51★, MIT, active |
| **zebbern/claude-code-discord** | **B** (Claude Code) | **native bot** | ✗ | ✗ | partial | yes | 214★, MIT |
| **OpenACP** ecosystem | B (multi-chat) | adapter (2-way) | TTS/voice-notes | ✗ | ? | yes | fragmented, ≤5★ repos, **core unverified** |
| **chadingTV/claudecode-discord** | B + S | native bot | ✗ | multi-machine | ? | yes | 59★, MIT |
| **KOBA789/human-in-the-loop** | HITL primitive | MCP `ask_human` | ✗ | — | — | yes | 229★, MIT, **stale** |
| **HumanLayer** | HITL bridge | ✗ (**planned**) | ✗ | — | yes (server) | ✗ (SaaS) | 11,136★, main repo **deprecated** |
| **gotoHuman** | HITL bridge | ✗ | ✗ | — | yes (cloud) | ✗ (SaaS) | SDKs ≤53★, MIT |
| **AgentInbox** (LangChain) | HITL surface | ✗ (web only) | ✗ | — | yes (LangGraph) | yes | 1,033★, MIT |
| **LangGraph** `interrupt()` | HITL primitive | ✗ (BYO) | ✗ | — | **yes (checkpointer)** | yes | 37,759★, MIT |
| **Windmill** | D (generic) | ✗ (no node) | ✗ | ✗ | yes (PG queue) | yes | 17,207★, AGPL+EE |
| **n8n** | D (generic) | **native node** | ✗ | ✗ | yes (exec history) | yes | 197,339★, Sustainable-Use |
| **Trigger.dev** | D (generic) | ✗ | ✗ | ✗ | yes (checkpoint) | yes | 15,702★, Apache-2.0 |
| **Temporal** | durable substrate | ✗ | ✗ | ✗ | **yes** | yes | 21,781★, MIT |
| **tmux + ttyd** (recipe) | **S** (+browser URL) | ✗ | ✗ | yes (multi-writer) | disconnect ✓ / reboot ✗ | yes | 47,936★ / 12,073★ |
| **sshx** | S (web collab) | ✗ | ✗ | **yes (browser, multi-writer)** | ephemeral | ✗ (self-host unsupported) | 7,551★, MIT |
| **tmate** | S (share links) | ✗ | ✗ | yes (ssh + ro links) | disconnect ✓ | yes | 6,083★, BSD |

## Notable candidates

### OpenHands "Agent Canvas" — `OpenHands/OpenHands` (the real new dispatcher contender)
81,558★, created 2024-03-13, pushed today, license NOASSERTION (MIT core historically), 363 open issues. The README now describes a self-hosted "developer control center" that *"runs the open source OpenHands agent out-of-the-box, but can use any third-party agent like Claude Code and Codex"* and lets you *"Create automations and workflows that integrate with Slack, GitHub, Linear, and more. Run on a schedule or in response to webhook events"*, self-hostable *"locally, in Docker, on VMs, or anywhere you can run an agent server backend"* with local↔remote↔cloud agent switching (README, raw.githubusercontent.com/OpenHands/OpenHands/main/README.md, fetched 2026-07-21). This is the closest thing in the whole sweep to a purpose-built coding-agent dispatcher: cron + webhook triggers + backend routing + agent hosting in one self-hostable product. **Gaps for curia:** no Discord (Slack/GitHub/Linear/Notion instead), and it owns its own ticket/automation model rather than exposing a durable queue whose schema you control. Overlaps hermes-agent's dispatcher role; does not match its Discord/HITL bridge.

### Orca — `stablyai/orca` (new substrate contender)
24,613★, created 2026-03-17, pushed today (2026-07-21), MIT, 1,852 open issues. Self-describes as *"the ADE for working with a fleet of parallel agents. Run any coding agent with your own subscription. Available on desktop, mobile and VPS."* (repo description, verified via API). The desktop+mobile+VPS framing hits curia's SUBSTRATE (multi-device attach) and self-host requirements head-on and is agent-agnostic on the worker side — the most direct competitor to Paseo/herdr for the live-session-host slot found in this sweep. Discord, voice, queue durability, and the exact attach model were **not** verified in this pass and warrant a dedicated follow-up. (Note: this is the same "Orca" behind the `orca-cli`/`orchestration` tooling present in this environment.)

### vibe-kanban — `BloopAI/vibe-kanban` (best dispatcher blueprint, but sunsetting)
27,473★, created 2025-06-14, **last push 2026-04-24 (~3 months stale)**, Apache-2.0, 534 open issues (API-verified; not archived). Real kanban DISPATCHER: create/prioritize/**assign** tasks, persistent DB (survives restart), web UI + CLI, orchestrates a long agent roster (Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor, OpenCode, Droid, Qwen), self-hostable incl. Docker/reverse-proxy (README). **Caveat:** BloopAI announced the company wound down (Apr 2026) and it is now community-maintained — hence the stale push; a risky base to build on. No native two-way Discord (community server only), no voice, no cross-device session attach. Best evidence of what a coding-agent dispatcher's queue/routing/state should look like.

### claude-flow — `ruvnet/claude-flow`
65,396★, created 2025-06-02, pushed today, MIT, 819 open issues. Swarm meta-harness: queen-led hierarchy, a task "Router", AgentDB vector-memory persistence, MCP tooling, Docker/CLI self-host. Fills a DISPATCHER-ish slot (routing + durable memory, spawns workers) but is **swarm-coordination-shaped, not a ticket queue with cron/webhook triggers or a kanban**; no Discord/voice/substrate; single-author (bus factor ≈1), mid-rebrand, high issue churn. Powerful but sprawling; a conceptual reference, not a drop-in dispatcher.

### Backlog.md — `MrLesk/Backlog.md` (the state-store slice)
6,249★, created 2025-06-04, pushed 2026-07-19 (active), MIT, 21 open issues. Local-first task manager where **every task is a `.md` file in git** — an excellent, trivially-restart-surviving STATE STORE, with CLI + local web kanban + MCP for Claude Code/Gemini. But it does **not** auto-dispatch (no cron/webhook/routing engine); work is manual per session. Buy the ticket-model/state-store slice of the dispatcher, not the live dispatcher.

### Discord→Claude-Code bridges with HITL (the closest thing to hermes-agent's bridge)
Two real, actively-maintained, self-hosted bridges that drive Claude Code *from* Discord with button-based human-in-the-loop:
- **`ebibibi/claude-code-discord-bridge`** — 51★, created 2026-02-18, pushed 2026-07-20, MIT, 5 open issues. Most complete: Discord threads map 1:1 to persistent Claude Code CLI sessions; renders Allow/Deny permission buttons, Approve/Cancel plan-mode buttons, and button/select answers for `AskUserQuestion`; **real restart survival** (auto-resume after reboot, snapshots before self-upgrade); cross-device via `/sync-sessions` and `/resume`. Python/discord.py/SQLite, spawns `claude -p --output-format stream-json`, runs on a Pro/Max sub (no API key).
- **`zebbern/claude-code-discord`** — 214★ (most-adopted), created 2025-08-27, pushed 2026-06-04, MIT, 2 open issues. Two-way with Allow/Deny permission prompts + clarifying-question buttons + mid-session controls (interrupt/model-switch/rewind); Deno + `@anthropic-ai/claude-agent-sdk`, self-hosted. No documented cross-device attach or restart survival.

Both are single-Claude-Code, **bus-factor-1** projects with **no dispatcher, no routing, no voice** — they cover curia's BRIDGE for one worker but not the DISPATCHER above it. Also on-target but tiny: `chadingTV/claudecode-discord` (59★, "control Claude Code from your phone — multi-machine agent hub via Discord", pushed 2026-05-01) — reference-grade for the phone+multi-machine slice.

### OpenACP ecosystem (bridge-complete on paper, but fragmented and unverified)
The most **bridge-complete** thing surfaced: a self-hosted daemon claiming to bridge Claude Code to Discord/Telegram/Slack/Signal/WhatsApp/Mattermost with two-way native threads, allow/reject buttons, a TTS plugin and Signal **voice-notes** (= the only voice signal in the non-Paseo field). **But the canonical core repo could not be verified** — both `Open-ACP/OpenACP` and `openacp/openacp` return 404 (API-checked). What exists is a scattering of tiny adapter/plugin repos, each ≤5★: `Cosmos-Sapiens/openacp-{signal,telegram,whatsapp,mattermost}-adapter`, `Cosmos-Sapiens/personal-agent-acp` (3★, "Claude Code + OpenACP"), `heavygee/openacp-openai-tts-plugin`, `peterr0x/usage-plugin` (all API-verified, MIT, pushed early-to-mid 2026). Treat as an **early, fragmented, unproven** ecosystem — promising design direction, not a dependable base. (See Gaps.)

### KOBA789/human-in-the-loop (the pure Discord HITL primitive)
229★, created 2025-06-21, **last push 2025-07-02 (~12.5 months stale)**, MIT. An MCP server exposing one `ask_human` tool: the agent calls it → the server opens a Discord thread with the question → **blocks** waiting for the human reply → returns it. This is exactly the escalate→answer→resume round-trip primitive, over Discord — but it is stale and is a primitive you pair with an MCP agent, not a bridge that drives Claude Code.

### HITL frameworks — none speak Discord with durable resume out of the box
- **HumanLayer** (`humanlayer/humanlayer`, 11,136★) — canonical HITL SDK (`@require_approval`, `human_as_tool`), true pause→approve→resume, server-side durable state. But channels shipped are **Slack + email + web/API**; **Discord is roadmap-only ("planned")** (humanlayer.dev/docs/channels). It is **SaaS** (needs a HumanLayer API key), and the **main repo is now marked deprecated** as the org pivoted to a coding-agent product (CodeLayer / `agentcontrolplane`).
- **gotoHuman** — cloud review-inbox; channels are web inbox + email + Slack, **no Discord**, **SaaS-only** (OSS repos are thin SDK/MCP clients, ≤53★).
- **AgentInbox** (`langchain-ai/agent-inbox`, 1,033★, MIT) — a **web-only** UI over LangGraph `interrupt()`s; no Slack/Discord/email.
- **LangGraph `interrupt()`** (`langchain-ai/langgraph`, 37,759★, MIT) — the strongest **durable pause/resume primitive** (checkpointer persists full graph state; resume with `Command(resume=…)`), but **no channel built in** — you wire Discord yourself. Best foundation if curia builds its own Discord HITL round-trip.

**Direct answer:** there is no drop-in HITL layer combining **Discord + durable pause/resume**. Cheapest build path is a thin Discord bot over LangGraph `interrupt()` + a persistent checkpointer, or KOBA789's primitive; HumanLayer becomes a buy option only *if* it ships its planned Discord channel.

### Generic workflow engines as a dispatcher (powerful, heavyweight, generic)
The thesis holds for 10 of 11 general engines — durable and capable, but you bolt coding-agent dispatch on top; none give "coding-agent tickets + Discord" out of the box:
- **Windmill** (17,207★, AGPL+EE) — closest generic match on paper: self-hosted **Postgres-backed queue + cron + per-script webhooks + flow routing** in one box; no Discord node, no coding-agent hosting (shelling out to `claude` from a script is trivial). Watch the AGPL/Enterprise license gating.
- **n8n** (197,339★, Sustainable-Use License — source-available, not OSI-open) — best trigger coverage: **native Discord node/trigger** + cron + webhook + IF/Switch routing + durable execution history, Docker self-host. But its state model is workflow-execution, not ticket-lifecycle, and "AI" nodes are LLM calls, **not** a hosted Claude Code worker.
- **Trigger.dev** (15,702★, Apache-2.0 — cleanest license) — durable TS jobs with cron + checkpointed retries surviving restart, Docker/Helm self-host; no Discord, no coding-agent hosting.
- **Temporal / Prefect / Dagster** — rock-solid durable-execution / orchestration substrates (Temporal 21,781★ MIT; Prefect 23,449★ Apache; Dagster 15,874★ Apache) but low-level and generic; Dagster is a data-pipeline tool (wrong domain). All would need the entire ticket app + Discord built on top.

### Terminal-mux substrate (generic muxes, zero agent-awareness)
Every terminal tool here is a **generic multiplexer/transport with no notion of agent state** (working/blocked/done) — herdr's whole differentiator. What they add over herdr is the **browser-URL** surface herdr lacks:
- **tmux (47,936★, ISC) + ttyd (12,073★, MIT)** — the closest practical recipe to "phone via browser + PC via SSH, one live session": tmux gives persistence + multi-writer attach; `ttyd tmux new -A -s main` adds the browser URL. Survives disconnect, **not host reboot** without tmux-continuum/systemd. (Pair with **mosh**, 14,195★ GPL-3.0, as the resilient mobile transport.)
- **sshx** (7,551★, MIT) — slickest **native browser multi-writer collab** (E2E-encrypted, one share URL), but README says **self-hosting is not officially supported** and it's ephemeral (pairing/debugging, not a long-lived agent host); last push ~1yr ago.
- **tmate** (6,083★, BSD) — tmux fork emitting shareable read-write/read-only SSH links, self-hostable (`tmate-ssh-server`); SSH-first, web view is a hosted convenience.
- **zellij** (34,415★, MIT) — tmux-class mux with a WASM plugin runtime; still terminal-only, no browser, no agent state.

## Would any replace / absorb a named candidate?

- **Paseo** (daemon + multi-device attach + first-class voice). **Not replaced.** The only real overlap is **Orca** (desktop/mobile/VPS multi-device, any coding agent) — a credible alternative *substrate*, but its voice/attach/durability specifics are unverified, and Paseo's built-in local-first STT/TTS remains unmatched anywhere else in this sweep. No generic mux (tmux+ttyd, sshx, tmate) matches Paseo's one-daemon/many-typed-clients + voice model. Orca is the one to benchmark against Paseo directly.
- **hermes-agent** (dispatcher + first-class Discord HITL bridge + voice memos). **Not replaced — and this stays curia's strongest single anchor.** The closest challenger, **OpenHands Agent Canvas**, matches the dispatcher half (cron+webhook+routing+coding-agent hosting) but has **no Discord** and no voice. The Discord bridges (`ebibibi`, `zebbern`) match the bridge half for one Claude Code worker but have **no dispatcher/routing/voice**. **OpenACP** aims at exactly hermes' bridge scope (multi-chat incl. Discord + voice-notes/TTS) but its core is unverified/fragmented. No single tool reproduces hermes' dispatcher+Discord+HITL+voice combination.
- **pi** (clean embeddable worker SDK). **Not replaced.** **sst/opencode** (188,240★, client/server split) is a plausible alternative *worker*, and OpenHands/vibe-kanban/claude-squad all *host* workers, but none is a leaner embeddable worker SDK than pi; they are heavier products. pi's niche stands.
- **herdr** ("tmux for AI agents"; SSH multi-device attach, agent-aware). **Not replaced, partially challenged.** **Orca** overlaps its multi-device worker-host slot and adds mobile + a browser-capable surface herdr lacks; generic muxes (tmux+ttyd) add a browser URL but **lose herdr's agent-awareness**. herdr's specific combination (terminal-native agent-state multiplexing + SSH attach) is still unique; Orca is the closest thing that could absorb its role while adding the phone-browser surface.

## Gaps / what curia must still build itself

1. **The integration is the product.** No self-hostable tool combines dispatcher (routing rule + durable ticket queue) + **Discord** two-way HITL + multi-device live attach + voice. hermes-agent is the closest single anchor; everything else covers one slice. Curia's owned value is the **glue and the routing policy**, not any one role.
2. **Discord-native HITL with durable resume does not exist off the shelf.** HumanLayer/gotoHuman/AgentInbox don't do Discord (HumanLayer's is "planned"); the Discord bridges are single-worker with no dispatcher; KOBA789's Discord `ask_human` primitive is stale. Curia builds the Discord escalate→answer→resume round-trip itself — cheapest over LangGraph `interrupt()` + a persistent checkpointer, or by driving one of the ebibibi/zebbern bridges.
3. **Voice is nearly absent outside Paseo/hermes.** The only voice signal in the entire sweep is OpenACP's TTS plugin + Signal voice-notes (unverified/fragmented). If curia wants voice without Paseo/hermes, it wires STT/TTS itself.
4. **Coding-agent dispatch + Discord together is unsolved.** OpenHands has the dispatch (Slack/GitHub/Linear); vibe-kanban has the kanban (but is sunsetting); n8n/Windmill have generic queue+triggers (Windmill no Discord; n8n has a Discord node but no coding-agent worker). The routing rule that picks a backend per ticket and the ticket state store are curia's to own — Backlog.md (git-`.md`) or Windmill/Trigger.dev (durable queue) or a hermes-style SQLite kanban are the buildable substrates.
5. **Restart survival of in-flight turns is nobody's solved problem** — same limitation flagged for Paseo/herdr recurs everywhere (durable *records/queue* survive; live provider turns die with the process). Curia inherits this constraint from whatever worker it drives.

## Gaps in this scan (honesty note)

- **Orca** (24,613★) was verified to exist, be MIT, and be actively pushed, but its Discord support, voice, exact multi-device-attach model, and queue durability were **not** primary-source-verified — it deserves a dedicated eval on par with the Paseo/herdr reports.
- **OpenACP** — its central daemon/core repo could not be located (`Open-ACP/OpenACP`, `openacp/openacp` both 404); only satellite adapter/plugin repos (≤5★) were confirmed. The bridge-completeness and voice claims rest on docs (openacp.gitbook.io) and adapters, not a verified core — needs a follow-up if pursued.
- Feature claims for the Discord bridges (restart survival, cross-device sync) and workflow engines are taken from READMEs/docs, **not runtime-tested**.
- All the promising bridges/dispatchers (ebibibi, zebbern, chadingTV, claude-flow, vibe-kanban) are effectively **bus-factor-1**.
- License flags to carry forward: n8n (Sustainable-Use, not OSI-open), Windmill (AGPL + Enterprise gating), claude-squad & claudia/opcode (AGPL-3.0), HumanLayer (NOASSERTION + deprecated main repo), OpenHands (NOASSERTION).
- The generic terminal muxes were characterized from READMEs; herdr's existing report already covers the SSH-attach substrate slot in depth, so muxes were assessed only for what they add (browser URL) or lack (agent-awareness).

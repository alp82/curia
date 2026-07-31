# Overseer session hosting — substrates and patterns

Date: 2026-07-31. Ticket: [Research substrates and patterns for the overseer session](https://github.com/alp82/curia/issues/82). Requirement: the resolution of [Grill the overseer](https://github.com/alp82/curia/issues/81). Sources: Claude Agent SDK docs ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)), the Claude Code [CLI reference](https://code.claude.com/docs/en/cli-reference), the [models overview](https://platform.claude.com/docs/en/about-claude/models/overview), the daemon source (`daemon/src/index.mjs`, `daemon/src/commands.mjs`), the local research notes cited inline, and one external repo ([fredchu/discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot)). Every load-bearing claim carries its source. Nothing was executed.

## The requirement, restated

The grilling fixed the shape. Each top-level Discord message opens a thread backed by a fresh overseer session. The session ends after it answers. It revives when the user writes in the thread again. No singleton. The overseer runs a cheap model. Every effect goes through daemon tools. The never-list applies: no checkout, no process handles, no config writes, no answering escalations, confirm-once on destructive verbs.

This report resolves three open mechanics: the host, the thread-to-session revival, and the tool-exposure pattern.

## Hosting options

### Option A — SDK loop inside the daemon

The daemon imports `@anthropic-ai/claude-agent-sdk` (package name verified against the [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)) and calls `query({ prompt, options })` per Discord message. The SDK runs the full Claude Code harness and streams messages back as an async generator. `options.resume` takes a session id and continues a prior conversation. `options.mcpServers` accepts in-process servers built with `createSdkMcpServer()` and `tool()` — tool handlers are plain functions that close over daemon state (all verified in the TypeScript reference).

- **Restart posture: good.** The SDK writes every session to disk as `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, or under `$CLAUDE_CONFIG_DIR` when set ([sessions doc](https://code.claude.com/docs/en/agent-sdk/sessions), "Resume by ID" tip). A daemon restart loses nothing: the thread-to-session map rebuilds from the journal, and `resume` finds the transcript on disk. The doc names one pitfall: resume is keyed by `cwd`, so a changed working directory silently returns a fresh session. The fix is to pin one fixed overseer directory.
- **Cost profile: one harness subprocess per message.** The session runs only while it answers, which is exactly the grilled session model. Between messages nothing runs. Each revival re-reads the transcript as input tokens with a cold prompt cache (the 5-minute cache TTL expires between human messages). Overseer transcripts are short, so this is cheap at any tier — and free of API dollars when the session runs on the shared host credential store (ADR-0007), where the cost is subscription quota.
- **Attach story: partial.** There is no tmux session and no PTY, so the terminal surface does not apply. The session transcript is the same JSONL format the timeline already reads (ADR-0009), so a read-only timeline view is possible with modest work. The primary surface is the Discord thread itself, which the grilling already fixed as the only built skin.

### Option B — spawned CLI under tmux (the worker pattern turned inward)

The daemon spawns `claude -p --resume <id> --output-format stream-json` (flags verified against the [CLI reference](https://code.claude.com/docs/en/cli-reference); all resumption flags work with `-p` print mode) in a tmux session per thread, the way it spawns workers.

- **Restart posture: same as A.** The CLI writes the same session files, so `--resume` survives restarts.
- **Cost profile: worse.** A tmux session per Discord thread contradicts "the session ends after it answers". Either the daemon keeps idle tmux sessions alive — which adds orphan sweeping, reconcile rules, and memory per thread — or it kills them after each answer, and then tmux adds nothing over a plain subprocess. The worker pattern exists because workers are long-lived and interactive. The overseer is request-response.
- **Attach story: full.** A live tmux session gets the terminal and timeline surfaces for free. This is the only real advantage, and the grilling did not ask for terminal attach on the overseer.

A tmux-less variant — spawn `claude -p --resume` directly, no session hosting — keeps B's simplicity claims without the idle-session cost. It is the honest fallback to A: the same session files, the same revival, but tool calls must cross HTTP instead of staying in-process, and the daemon must parse stream-json instead of receiving typed messages.

### Option C — external client over MCP

Some external host (a desktop client, a separate orchestrator box) runs the session and reaches the daemon over MCP. Rejected. It adds a component with its own lifecycle and credentials, the daemon can no longer revive a session when a Discord message arrives (the external host owns the conversation), and the never-list is easier to hold when the daemon composes the session and its tool surface itself. No local candidate note supports this shape either — every evaluated system hosts its command brain next to its dispatcher.

### Hybrid note

The grilling called true conversation-continue "an implementation bonus where the agent CLI supports it". With option A it is not a bonus but the default: `resume` restores the full conversation, so a revived thread remembers its earlier turns without re-priming. `forkSession` exists if a thread ever needs a branch (verified in the sessions doc). The `resume` contract for **workers** (re-dispatch, fresh worker, surviving worktree) is unchanged — this continuity applies to overseer threads only.

## Thread-to-session revival mechanics (for option A)

1. **Open.** A top-level Discord message creates a thread. The daemon calls `query()` with a fixed `cwd` (a dedicated overseer home, no checkout) and a dedicated `CLAUDE_CONFIG_DIR`, mirroring the worker config-dir posture (ADR-0006) minus the repo skills. The first `system/init` message carries `session_id` (verified in the sessions doc, "Capture the session ID").
2. **Record.** The daemon journals `overseer_session_opened { thread_id, session_id }`. The journal is already the daemon's only durable artifact, and in-memory state is a reduction over it (CONTEXT.md, "Journal"). No new state home is needed.
3. **Revive.** A later message in the thread resolves `thread_id → session_id` from the reduction and calls `query({ resume: session_id })`. The agent returns with full context.
4. **Survive restarts.** The mapping rebuilds from the journal. The transcripts sit on disk under the overseer config dir. Both survive daemon death by construction.
5. **What persists.** The conversation persists verbatim (transcript JSONL). Nothing needs re-priming except the system prompt, which the daemon passes fresh on every `query()` call anyway — so prompt updates take effect on the next revival without breaking old threads.
6. **Storage cost.** JSONL transcripts of chat-sized conversations are kilobytes. No cleanup is required at curia's scale. A TTL sweep of dead thread mappings can ride the existing reconcile pass if it ever matters.

External confirmation of the exact pattern: [fredchu/discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot) keeps a crash-safe SQLite map from Discord thread id to Claude Code session UUID and spawns `--session-id` for new threads, `--resume` for revivals (README, verified 2026-07-31). [ebibibi/claude-code-discord-bridge](https://github.com/ebibibi/claude-code-discord-bridge) does the same with restart auto-resume ([landscape-scan.md](landscape-scan.md)). Curia replaces their SQLite with the journal it already has.

## Tool exposure: MCP against the daemon, in-process

Three candidate surfaces, given that the daemon already speaks MCP to workers (`POST /mcp?worker=<name>&ticket=<n>`, streamable HTTP, per-scope `buildMcpServer(worker, ticket)` — `daemon/src/index.mjs:4,378,566`):

1. **Reuse the worker MCP surface.** Rejected. The worker tools are `ask_human`, `notify`, `report_result` — a worker's contract, not a command surface. Sharing it widens the blast radius of every worker-tool change to the overseer and vice versa.
2. **A dedicated HTTP MCP scope** (`/mcp?role=overseer&thread=<id>`). Correct shape for option B or any out-of-process host. Reuses the transport and the per-scope server pattern the daemon already has.
3. **In-process SDK tools** via `createSdkMcpServer()` + `tool()` (verified in the TypeScript reference). Correct shape for option A. Tool handlers call the same functions the router calls (`CommandRouter` in `daemon/src/commands.mjs`), with no HTTP hop, no serialization seam, and typed Zod inputs.

Recommendation: **option 3, one dedicated in-process server, one tool per verb.** The tool surface is the containment boundary, so the never-list becomes tool design: the overseer session gets `allowedTools` restricted to the curia MCP tools only — no Bash, no Write, no Edit — and the daemon executes every effect. The catalogue mirrors the grilled router: `tickets`, `next`, `start`, `status`, `cancel`, `resume`, `attach`, plus one dispatch tool for subagent workers (heavy reasoning, map edits, charting), which the daemon runs through its normal dispatch path so the overseer never holds a handle. `cancel all` and `resume all` confirm in conversation before the tool call, the same split ADR-0005 uses for `cancel`.

One caution from prior art: Multica's source documents why `AskUserQuestion` fails in headless mode — the question renders nowhere and returns empty ([multica.md](multica.md) §6). The overseer has a rendering surface (its Discord thread), but only through the bridge relaying its *reply text*. Interactive in-session question tools stay disabled; the overseer asks by answering.

## Model choice

Verified against the [models overview](https://platform.claude.com/docs/en/about-claude/models/overview) (2026-07-31):

| Model | ID | Price (in/out per MTok) | Notes |
|---|---|---|---|
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1 / $5 | Fastest, 200k context, no adaptive thinking |
| Claude Sonnet 5 | `claude-sonnet-5` | $3 / $15 ($2 / $10 intro through 2026-08-31) | 1M context, adaptive thinking |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | $3 / $15 | Previous Sonnet |

No tier named "terra" exists in Anthropic's model catalogue — the grilling's "Sonnet or terra tier" phrase does not map to a verifiable product name. Mark it unresolved vocabulary; the verifiable cheap tiers are Haiku and Sonnet.

Recommendation: **start the prototype on `claude-haiku-4-5`, keep `claude-sonnet-5` as the fallback.** The overseer's turns are verb translation, status summaries, and dispatch decisions — short, tool-heavy, low-reasoning. Haiku is built for that and costs a fifth of Sonnet. Two caveats favor testing rather than deciding here: Haiku lacks adaptive thinking, and tool-call reliability on the verb catalogue is exactly what the prototype can measure. When the session runs on the shared subscription credentials (ADR-0007), the price difference becomes quota headroom rather than dollars — still worth having, since worker dispatches compete for the same quota (the cooling/exhaustion machinery). Prompt caching gives little here: revivals arrive minutes to hours apart, past the 5-minute cache TTL, so assume cold-cache input on every turn and keep the system prompt short.

## Prior art

Local (the PoC candidate notes):

- **Paseo** hosts sessions inside the daemon and resumes lazily through the provider's own persistence handle — Claude's `~/.claude/projects/{cwd}/{session-id}.jsonl` ([paseo.md](paseo.md), "Restart survival"). That is precisely option A's mechanism, observed working in a shipped product.
- **Paperclip** spawns a fresh subprocess per unit of work and resumes the conversation by session id across runs — "same employee, new shift, same memory" ([paperclip.md](paperclip.md) §2). The overseer session model is the same shape with Discord messages as the work units.
- **OpenACP** maps one Discord thread per session with a durable JSON session store, and revives sessions on restart — but its pending questions live in memory and die with the process ([openacp.md](openacp.md), "Restart survival"). Lesson kept: the thread map must be durable (curia: the journal), and nothing conversational may be the only copy of an open obligation (curia already holds escalations durably, ADR-0005).
- **Hermes** keys sessions to platform conversation lanes but routes everything through one gateway singleton ([hermes-agent.md](hermes-agent.md), "Session attach/sharing"). The grilling rejected the singleton; the lane-keying idea survives as the thread-to-session map.
- **Multica** confirms the headless-interactive-tool failure mode cited above ([multica.md](multica.md) §6).

New since [Define the overseer command surface](https://github.com/alp82/curia/issues/18): the Agent SDK's session API is now the documented, first-party way to do per-thread revival (`resume`, `forkSession`, `listSessions()`, session files on disk — [sessions doc](https://code.claude.com/docs/en/agent-sdk/sessions)), and small open projects ([fredchu](https://github.com/fredchu/discord-claude-code-bot), [ebibibi](https://github.com/ebibibi/claude-code-discord-bridge)) ship the Discord-thread-to-session pattern on exactly this API surface. The SDK's experimental V2 session API (`createSession()`) was removed in 0.3.142 — build on `query()` + options, not on V2 examples found elsewhere.

## Ranked recommendation for the prototype ([#83](https://github.com/alp82/curia/issues/83))

1. **SDK loop inside the daemon** — `@anthropic-ai/claude-agent-sdk`, `query()` per Discord message, `resume` per thread, fixed overseer `cwd` + dedicated `CLAUDE_CONFIG_DIR`, thread map in the journal. Tools: one in-process MCP server (`createSdkMcpServer`) with the verb catalogue plus a subagent-dispatch tool, `allowedTools` restricted to it. Model: Haiku 4.5 first, Sonnet 5 as fallback.
2. **Spawned `claude -p --resume` without tmux** — the fallback if the SDK dependency misbehaves inside the daemon process. Same session files and revival. Tools move to a dedicated `role=overseer` scope on the existing HTTP MCP endpoint.
3. **tmux-hosted CLI session per thread** — only if live terminal attach to the overseer becomes a requirement. It buys the attach surfaces at the price of idle session management the grilled model does not want.
4. **External MCP client** — rejected (lifecycle, revival, and containment all argue against it).

The prototype should verify, in order: `resume` continuity across a simulated daemon restart, the cwd/config-dir pinning, in-process tool calls hitting the real router functions, and Haiku's tool-call reliability on the verb catalogue.

## Unverified / open

- Nothing was executed. All SDK and CLI behavior comes from the official docs, not from a run — the prototype closes that gap.
- Whether the SDK subprocess inherits the shared host credentials cleanly under a custom `CLAUDE_CONFIG_DIR` (workers already do this through the harness, but the overseer path is new).
- Revival latency (process spawn + transcript re-read) per Discord message was not measured.
- "terra tier" has no verifiable referent in Anthropic's catalogue.

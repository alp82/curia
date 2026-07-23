# claude-agent-acp escalation round-trip — empirical verification

Date: 2026-07-23. Wayfinder ticket: [#23](https://github.com/alp82/curia/issues/23). Prior source-read: [docs/research/acp.md](acp.md) (#20), which ran nothing — this spike runs everything. Setup: `@agentclientprotocol/claude-agent-acp` **0.61.0** (latest, 2026-07-22) + `@agentclientprotocol/sdk` **1.3.0**, spawned standalone over stdio from a ~250-line Node client (`spikes/acp-roundtrip/spike.mjs`); the adapter's bundled `@anthropic-ai/claude-agent-sdk` 0.3.217 ships its **own native Claude Code binary (2.1.217)** — the system CLI is not used unless `CLAUDE_CODE_EXECUTABLE` overrides it. Full NDJSON wire logs captured per scenario. Box: the dev laptop (Arch), Claude Code OAuth credentials.

**Verdict: everything the ticket asked for works — all five exercises PASS on stable npm releases.** Prompt turn, blocking permission round-trip, unstable `elicitation/create` for both choice and free-text (via `AskUserQuestion` *and* via an MCP-server `elicitInput` — the exact shape of curia's #11 `ask_human` tools), images both directions, and `_meta.steering` mid-turn injection. Two findings matter beyond "it works": a **silent capability-shape footgun** that cost most of this spike's debugging time and will bite any bridge author, and **wholesale host-config inheritance** that curia's dispatcher must explicitly suppress.

## Scenario results

| # | Exercise | Result | Wall-clock |
|---|---|---|---|
| 1 | Standalone stdio spawn + prompt turn | **PASS** — protocol v1 negotiated, `end_turn`, text streamed | 3.7 s |
| 2 | `session/request_permission` round-trip | **PASS** — worker blocked on a non-allowlisted Bash call, client answered `allow_once` after a simulated 3 s human delay, worker resumed and completed | 11.1 s turn |
| 3a | `elicitation/create`, choice | **PASS** — enum `oneOf` form, answered `green`, model reported it | |
| 3b | `elicitation/create`, free-text | **PASS** — string field, custom text round-tripped verbatim | |
| 3c | `AskUserQuestion` → elicitation | **PASS** — surfaced as form elicitation (`question_0` enum + `question_0_custom` "Other" field), answer folded back into the tool result | 7.3 s turn |
| 4 | Images both directions | **PASS** — base64 PNG in `session/prompt` correctly identified ("Red"); agent→human image rode a `tool_call_update` content block when the worker Read an image file | |
| 5 | `_meta.steering` | **PASS** — `_session/steering` mid-turn returned `{outcome:"injected"}`, generation stopped mid-haiku, steered reply (`STEERED_OK`) streamed via `session/update` **after** the interrupted turn's `PromptResponse` | inject → stop ~1 s |

## Finding 1: the capability-shape footgun (cost: most of the spike)

The adapter gates the entire elicitation surface — both MCP-elicitation forwarding *and* whether `AskUserQuestion` is even in the worker's toolset (`disallowedTools`) — on `clientCapabilities.elicitation.form` from `initialize`. The schema types `form`/`url` as **object** capabilities (`{}`), not booleans. Sending `elicitation: { form: true }`:

- fails the ACP SDK's zod parse for that sub-field, whose `defaultOnError` **silently degrades it to `undefined`** — no error, no log line anywhere;
- so the adapter sees "no elicitation support": `AskUserQuestion` is stripped from the toolset (the CLI rejects a forced call with *"exists but is not enabled in this context"*), and every MCP elicitation is auto-declined (`{"action":"decline"}` surfaces in the tool result with no hint of why).

Correct: `elicitation: { form: {} }`. With that one change, everything in scenario 3 passes. Chased down by isolating layers: SDK-direct `query()` with `onElicitation` worked perfectly (proving CLI+SDK innocent), then reading the adapter's gate against `zod.gen.js`, where `zElicitationCapabilities` wants `zElicitationFormCapabilities.nullish()`.

**Consequence for curia's bridge:** ACP's lenient-parse philosophy means a mis-shaped *capability* produces a **behavioral downgrade, not an error**. The vendored bridge should assert the negotiated capabilities it depends on at startup (e.g. round-trip a probe elicitation at session open) rather than trust that "we sent the capability" equals "it was understood". This also retires #20's worry that `AskUserQuestion` support was uncertain — it works today on stable releases; the GitHub issue trail ([claude-agent-acp#405](https://github.com/agentclientprotocol/claude-agent-acp/issues/405), fixed in Zed stable 2026-07-22) was about Zed's client-side rendering, not the adapter.

## Finding 2: host-config inheritance — the worker is *your* Claude, not *a* Claude

Spawned with a plain inherited env, the adapter's worker inherited the host's entire `~/.claude` identity, observed directly:

- **Permission allowlist**: the first permission test silently auto-allowed `echo … > file` because the dev box's `settings.json` allowlists `Bash(echo:*)` — zero ACP permission request sent. Only a non-allowlisted command (`sha256sum`) triggered the round-trip.
- **Permission mode**: sessions open in the host's saved default (`acceptEdits` here), not `default`. `session/set_mode` → `"default"` works and was needed to make gating deterministic.
- **Global `CLAUDE.md`**: the worker quoted the operator's personal shell-hygiene rules while running a command.
- **MCP servers & plugins**: the worker's toolset included the host's claude.ai connectors (Notion, Google Drive) and plugin MCP servers (chrome-devtools) — ~60 inherited tools of context bloat and, worse, **live credentialed surfaces** any dispatched ticket could touch.

**Consequence for curia:** the dispatcher must give each worker a controlled config home (`CLAUDE_CONFIG_DIR` pointing at a curia-owned dir with just credentials + a minimal settings.json — verified working with a clean dir holding only `.credentials.json`), force the permission mode explicitly per session, and treat the host allowlist as *not* part of the escalation contract. This is the claude-agent-acp sibling of #22's "headless sessions auto-approve" finding: **on every substrate so far, the default posture leaks approvals; curia must own the gate.**

## Smaller facts worth keeping

- **MCP servers per session**: ACP `session/new` takes `mcpServers` (stdio command+args) and the adapter wires them through — a 40-line MCP server whose tools call `elicitInput()` produced real blocking `elicitation/create` requests. **This is exactly where curia's #11 `ask_human` tools plug in** — no adapter patches, no PTY: `ask_human(choice/free-text)` rides `elicitation/create` (with a permission gate on the MCP tool call in `default` mode — first ping is the permission, second is the elicitation), `approve-reject` rides `session/request_permission` natively.
- **Permission options offered**: `allow_always` / `allow_once` / `reject_once` with stable optionIds; blocking is real (worker frozen the full simulated-human delay; wire shows the tool call held `pending` until the response).
- **Steering semantics** match the adapter docs: `injected` when a turn is live (delivered at `now` priority — generation interrupts within a chunk), `startedNewTurn` when it raced past; the steered output arrives as post-response `session/update`s, so a bridge must keep consuming updates after `session/prompt` resolves.
- **`AskUserQuestion` has an AFK auto-advance**: CLI strings show a timeout path that resolves the dialog with *"No response after Ns — the user may be away from keyboard. Proceed using your best judgment…"*. Not triggered in these runs (blocked fine for the delays tested); before relying on indefinite-block semantics (#11), the vendored bridge should verify no default timeout fires through this path on long escalations.
- **Deferred tools / ToolSearch is on by default** in SDK workers (this CLI version): most built-ins load lazily via a ToolSearch call. `ENABLE_TOOL_SEARCH=0` restores eager tools. Mostly cosmetic, but it changes tool-availability introspection and added a confusing layer while debugging.
- **Version pinning comes free**: the adapter runs the SDK's bundled CLI binary, so `npm install claude-agent-acp@X` fully pins the worker stack; the host's `claude` upgrade cadence is irrelevant unless `CLAUDE_CODE_EXECUTABLE` is set.
- Footprint per worker process tree (adapter node + native CLI): not formally measured; subjectively instant spawn (~0.8–1.3 s to session-created on a warm box).

## What this unblocks

Both #17 custom-branch paths lean on this seam; it now stands verified end-to-end, including the one contract piece (#20 flagged) that rides unstable protocol surface. The remaining #17 inputs are the other hands-on spikes (#24–#26).

## Assets

- Spike client + MCP ask-server + SDK isolation test: [`spikes/acp-roundtrip/`](../../spikes/acp-roundtrip/) (`spike.mjs`, `mcp-ask-server.mjs`, `sdk-elicit-test.mjs`; scenarios: `basic` / `permission` / `elicit` / `elicit-free` / `askuser` / `image` / `steer` / `tools`). Wire logs land in `logs/*.ndjson` (gitignored).

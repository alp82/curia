# pi hands-on re-run — worker-core verification (wayfinder #26)

Date: 2026-07-23. Method: **live execution, not source-reading** — drove the system-installed pi 0.80.7 (Arch package `pi-coding-agent`) plus the npm SDK 0.81.1 and the third-party `pi-acp` 0.0.31 adapter on this Arch box. Follows the rubric of the other hands-on re-runs (#19/#21/#22/#23/#24/#25). Prior source-read: [pi.md](pi.md) (#4). Feeds the build-posture decision (#17).

**Verdict.** The embed story holds up live on every axis the source-read claimed: **SDK, stdio RPC, and one-shot JSON all drive a real tool-using worker; a Claude Code skill fires with zero porting; and `pi-acp` slots pi into the same ACP seam as claude-agent-acp/codex-acp workers** — initialize → session/new → prompt → tool_call stream → cancel all verified. Two upgrades on the source-read: pi ships a **zero-key GitHub Copilot lane** (`COPILOT_GITHUB_TOKEN` from `gh auth token` — the lane hermes rides and Cline's binary disables), and at **~130 MB RSS per worker** it is the lightest worker runtime measured (Orca ~0.4 GB, Paseo ~0.3 GB per worker). Standing costs confirmed: pre-1.0 SDK churn is real (this week's 0.81.x renamed the auth API out from under the shipped examples), pi has **no permission gate at all** by design (HITL must come from curia-registered custom tools or bridge policy), and `pi-acp` is a solo-maintainer MVP.

## Setup

- pi 0.80.7 system-wide (`/usr/bin/pi`); npm SDK `@earendil-works/pi-coding-agent` 0.81.1 installed fresh in a scratch workspace; `pi-acp` 0.0.31 from npm (deps: official `@agentclientprotocol/sdk` 0.26).
- **Model lane:** the box's Anthropic OAuth (Max subscription) was quota-blocked all session ("out of extra usage" — same environmental block #24 hit). Ran everything on **`github-copilot/gpt-4.1`** via `COPILOT_GITHUB_TOKEN="$(gh auth token)"` — pi does the Copilot token exchange itself.
- Worker isolation demoed with a per-worker agent dir: `PI_CODING_AGENT_DIR=<dir>` with its own `settings.json` (`defaultProvider`/`defaultModel`) + `--session-dir` for session storage.

## Exercise results

### 1. One-shot JSON mode (`pi --mode json -p`) — PASS

Dispatcher-style single invocation returns the full session as JSON lines (`session` → `agent_start` → message/turn events → `agent_end` → `agent_settled`), with per-turn token usage and cost. Round-trip ~3–8 s on Copilot gpt-4.1.

- **Error shape is dispatcher-friendly:** the quota-blocked Anthropic run didn't crash or hang — it emitted a normal event stream with `stopReason: "error"`, the provider's full 400 body in `errorMessage`, and `willRetry: false`, then exited cleanly. Curia's auth-health watchdog (#21) gets a parseable, in-stream signal — better than hermes' silent fail-closed and Cline's ACP-mode error swallowing.
- **Copilot model enablement caveat:** `github-copilot/claude-haiku-4.5` returned `model_not_supported` (not enabled on the account); `gpt-4.1` worked out of the box. pi even ships `enableGitHubCopilotModel()` helpers internally. Routing config (#13) must pin to account-enabled models per lane.

### 2. stdio RPC (`pi --mode rpc`) — PASS

Hand-rolled Python JSONL client over stdin/stdout:

- **Prompt + tool use:** `{"type":"prompt"}` accepted with id-correlated response; `write` + `read` tools fired; proof file verified on disk. Turn ~5 s.
- **Abort mid-turn:** `{"type":"abort"}` settled the stream in ~1.5 s (`turn_end` + `agent_settled` emitted); **session stayed usable** — next prompt answered normally, `get_last_assistant_text` returned it.
- The command surface is wide: `steer`/`follow_up` (queue semantics during streaming), `get_state`/`get_messages`, `set_model` mid-session, `compact`, `bash`, session `fork`/`clone`/`switch_session`, `export_html`. Framing is strict LF-JSONL (docs explicitly warn Node `readline` is non-compliant — U+2028/U+2029).
- Boot is silent (no events until first command) — a supervisor should treat "process up" as ready, not wait for a banner.

### 3. Node/TS SDK (`createAgentSession`) — PASS, with churn caveat

- In-process session boot **18 ms**; `subscribe()` streamed the same event vocabulary as RPC; tool-using turn 3.2 s with the proof file verified; `session.abort()` settled the in-flight turn in ~2.5 s and the session remained usable; `session.messages` readable; `dispose()` clean.
- **API churn is live, not theoretical:** the docs and shipped examples (0.80.7) build auth via `AuthStorage.create()` + `ModelRegistry.create(authStorage)`; npm 0.81.1 (released this week) **removed the `AuthStorage` export** — the current shape is `ModelRuntime.create()` passed as `modelRuntime`, with `getModel(provider, id)` for model resolution. The port took minutes, but anything curia builds on the SDK must pin the version and expect renames until 1.0.
- Env-var credentials (`COPILOT_GITHUB_TOKEN`) flow through the default runtime untouched — per-spawn key injection (#13) is just env, same as the Cline lane.

### 4. Claude Code skill port — PASS (zero-port)

Ported `domain-modeling` (SKILL.md + two reference docs, the Matt Pocock format). Finding: **no porting exists to do** — Alp's `~/.claude/skills/*` are symlinks into `~/.agents/skills/`, which pi auto-discovers natively (Agent Skills standard). A one-shot run with `/skill:domain-modeling <question>` expanded the command into a `<skill>` block in the user message (verified in the event stream) and the model answered a fact that lives in the skill's ADR-FORMAT reference (`docs/adr/0001-slug.md` convention) correctly.

- **Flip side — host-config inheritance again** (sibling of #23/#24/#25 findings): a default-config pi worker inherits `~/.agents/skills`, `~/.pi/agent/settings.json`, `auth.json`, and extensions. The isolation controls exist and worked: `PI_CODING_AGENT_DIR` (CLI/adapter) or `agentDir`/`resourceLoader` (SDK) + `--no-extensions`/`--no-skills` flags. Curia must set them per worker, same posture as `CLAUDE_CONFIG_DIR`.

### 5. `pi-acp` (third-party ACP adapter) — PASS

`pi-acp` 0.0.31 (svkozak, MVP by its own README; Zed-centric) spawns `pi --mode rpc` from PATH (`PI_ACP_PI_COMMAND` overridable) and bridges to ACP over stdio. Driven with a raw NDJSON JSON-RPC client:

- `initialize` → protocolVersion 1, caps declare `loadSession: true`, `promptCapabilities.image: true` (audio false, embeddedContext off by default); `session/new` returns pi thinking levels as ACP session modes; tool-using `session/prompt` streamed `tool_call` + 22 `tool_call_update`s and ended `end_turn` in 3.2 s with the file verified; `session/cancel` → `stopReason: "cancelled"` in 2 s; **post-cancel prompts work** (two consecutive `end_turn`s — an apparent hang in the first run was this harness's event-draining bug, disproved on retest).
- **So pi does slot into the OpenACP custom-agent seam** exactly like claude-agent-acp (#23), codex-acp, and Cline (#28) — no PTY, and the per-worker env (`PI_CODING_AGENT_DIR`, `COPILOT_GITHUB_TOKEN`) rides the same wrapper-script pattern as the Cline lane.
- Caveats: solo third-party maintainer at 0.0.x (vendor-and-pin posture, same as OpenACP); session persistence via a side mapping file (`~/.pi/pi-acp/session-map.json`); image capability declared but not exercised this session; no audio.

## Cross-cutting findings

- **HITL: pi has no permission gate, by design.** No `session/request_permission` was ever emitted — core pi executes tools without asking ("no permission popups" is a listed non-feature). Unlike Cline (gate per tool call, no question tool) pi is the opposite pole: nothing to intercept unless you add it. Curia's `ask_human`/gating for a pi lane comes from **registering custom tools / `tool_call` event hooks via pi's extension API** (the intended mechanism) or gating at the bridge. This is the cleanest fit yet for #11's daemon-hosted MCP-style `ask_human`-as-tool design — but it's build-work, not config.
- **Zero-key Copilot lane (feeds #13):** `github-copilot` is a first-class pi provider fed by `COPILOT_GITHUB_TOKEN` (gh CLI token; pi handles the exchange), listing Claude/GPT/Gemini models. An `openai-codex` ChatGPT-OAuth provider also exists in the binary (login flow present; untested). pi now covers every routing lane #13 names, without an API key.
- **Footprint:** ~126 MB RSS idle RPC worker, ~134 MB post-turn (+ ~50 MB for the pi-acp Node adapter when used). Between herdr's ~20 MB mux and Orca/Paseo's 300–400 MB workers; an 8 GB box runs many.
- **External observability confirmed:** the session JSONL (`--session-dir`) is written promptly and tail-parses cleanly line-by-line mid-session — the "observe a live worker by tailing v3 JSONL" path from the source-read works. (Clean path remains owning the event stream.)

## Verdict for #17

pi's worker-core claims are now empirical, matching or beating the source-read. As a **worker lane behind the bridge** it offers: the lightest footprint, three driving surfaces (SDK in-process, RPC subprocess, ACP via pi-acp), skills shared with Claude Code workers at zero cost, per-spawn env-key routing incl. a zero-key Copilot lane, and dispatcher-friendly error surfacing. Its costs are symmetrical with the other lanes: pre-1.0 churn (pin versions), host-config isolation is curia's job (set `PI_CODING_AGENT_DIR`), and HITL is bring-your-own (extension custom tools — aligned with, but not free like, #11's design). Nothing here re-opens the substrate/dispatcher rulings: pi remains worker-only. All six verification spikes (#21–#26) are now landed; #17 is unblocked.

# OpenCode and Pi against the selectable-harness contract

Date: August 28, 2026.

Research question: Which parts of Curia's selectable-harness contract can OpenCode and Pi satisfy, and what does each candidate add beyond Claude and Codex?

This note evaluates the versions pinned in `config/curia.yaml`: OpenCode 1.18.23 and Pi 0.84.3. The rubric is [ADR-0029](../adr/0029-selectable-harnesses-satisfy-one-behavioral-contract.md), as settled in [Define the contract for a selectable Curia harness](https://github.com/alp82/curia/issues/826). Credential findings use [ADR-0027](../adr/0027-the-daemon-owns-model-credentials.md).

## Result

Both candidates receive a **conditional pass**. Neither candidate is selectable today.

| Candidate | Verdict | Condition for selection |
| --- | --- | --- |
| OpenCode 1.18.23 | **Conditional pass** | Build its adapter, add an ADR-0027 credential consumer, enforce the project-config and external-skill disable flags, prove a completion loop over session-idle events, normalize its durable store, and pass the shared conformance and live-check bars. |
| Pi 0.84.3 | **Conditional pass** | Build its adapter, add an ADR-0027 credential consumer, ship a Curia-owned extension that exposes the Curia tools and completion loop, normalize its JSONL, and pass the shared conformance and live-check bars. |

The verdicts are independent. OpenCode has the shorter path to Curia tools because it has a native remote Model Context Protocol (MCP) client. Pi has the cleaner lifecycle and transcript surfaces, but it needs a custom tool bridge because Pi deliberately omits MCP.

The evidence does not justify a plain pass. This session did not run a provider-backed full loop, a held human question, credential refresh, live credential replacement, or the completion gate. Those are required live checks, not details that source inspection can waive.

## What the candidates add

OpenCode adds a server-shaped harness. It ships a native remote MCP client, Agent Client Protocol (ACP) mode, a server and attach client, server-sent lifecycle events, and an SDK endpoint that can enqueue another prompt. It also supports ChatGPT Plus or Pro OAuth, GitHub Copilot OAuth, and many API-key providers. The OpenAI plugin uses the same public OAuth client ID as Pi and Codex-style consumers. See the pinned [OpenAI OAuth plugin](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/plugin/openai/codex.ts), [MCP client](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/mcp/index.ts), and [generated session client](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/sdk/js/src/gen/sdk.gen.ts).

Pi adds a small, controllable agent core. It ships text, JSON-event, and RPC modes, a documented tree-structured JSONL session format, exact resource-disable flags, explicit model and thinking flags, and a TypeScript extension API. The extension API can register tools, observe `agent_settled`, and inject a user message that always starts another turn. Pi supports Anthropic Pro or Max OAuth, ChatGPT Plus or Pro OAuth, and GitHub Copilot OAuth as subscription providers. See the pinned [usage guide](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/usage.md), [RPC guide](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/rpc.md), [extension guide](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/extensions.md), and [provider definitions](https://github.com/earendil-works/pi/tree/v0.84.3/packages/ai/src/providers).

The distinction matters for implementation cost:

- OpenCode needs less tool-transport code, but more containment and lifecycle proof. Its configuration merges several sources, and its session-idle signal is not a Stop hook.
- Pi needs a Curia-specific MCP-to-extension bridge, but its config root, transcript, resume command, settled event, and forced-follow-up mechanism are direct and documented.

## Contract matrix

### Isolated configuration root and declared provider

**OpenCode: pass with adapter configuration.** The pinned worker image can redirect every persistent OpenCode root into `/cfg` with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, and `OPENCODE_CONFIG_DIR`. The exact pinned probe reported:

```text
home       /home/agent
data       /cfg/data/opencode
bin        /cfg/cache/opencode/bin
log        /cfg/data/opencode/log
repos      /cfg/data/opencode/repos
cache      /cfg/cache/opencode
config     /cfg/config/opencode
state      /cfg/state/opencode
```

The adapter must set all of these values. `OPENCODE_CONFIG_DIR` alone doesn't relocate the SQLite store, logs, state, or cache. The source of the path behavior is OpenCode's pinned [global path service](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/core/src/global.ts) and [configuration loader](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/config/config.ts).

**Pi: pass with adapter configuration.** `PI_CODING_AGENT_DIR=/cfg` relocates settings, credentials, model catalog, extensions, and default session storage. The exact pinned probe created `/cfg/auth.json` and `/cfg/models-store.json` as the worker user. `--session-dir` can give the adapter an explicit transcript directory. See Pi's pinned [environment-variable guide](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/environment-variables.md) and [session manager](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/session-manager.ts).

Both adapters must declare one provider. The lowest-change provider is OpenAI subscription OAuth because both candidates implement the same `app_EMoamEEZ73f0CkXaXp7hrann` client and can use the daemon's existing OpenAI provider refresh lineage. This still requires a separate consumer row for each harness.

### ADR-0027 credential consumer

**OpenCode: conditional pass.** OpenCode stores provider credentials under its data root in `auth.json`. Its OAuth record contains `access`, `refresh`, `expires`, and optional `accountId`. The OpenAI plugin refreshes an expired token and writes the rotated result through `auth.set`. See the pinned [auth store](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/auth/index.ts) and [OpenAI refresh path](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/plugin/openai/codex.ts).

Curia must not let that refresh path become the owner. The consumer should deliver a daemon-refreshed OpenAI lease before the refresh margin, write it atomically in OpenCode's native shape, keep it mode `0400`, and include `accountId`. OpenCode reads the auth file on credential lookup, so a later daemon rewrite has a viable live-healing path. The live replacement check must prove that behavior before selection. `OPENCODE_AUTH_CONTENT` is not sufficient because a running process can't receive a replaced environment value.

**Pi: conditional pass.** Pi stores type-tagged credentials in `<PI_CODING_AGENT_DIR>/auth.json`. Its OpenAI Codex OAuth record also uses `access`, `refresh`, and `expires`. `AuthStorage` re-reads file revisions during credential operations and serializes writes. See the pinned [auth storage](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/auth-storage.ts), [model runtime](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/model-runtime.ts), and [OpenAI subscription provider](https://github.com/earendil-works/pi/blob/v0.84.3/packages/ai/src/providers/openai-codex.ts).

The consumer should write the daemon's OpenAI lease in Pi's native shape and keep it mode `0400`. The daemon refreshes it before Pi tries to. Pi's revision-aware reads make live healing plausible, but the required live replacement check remains open.

Alternative subscription lanes exist for both candidates. GitHub Copilot adds Claude, GPT, and Gemini model families behind a third provider contract. Pi also supports Anthropic Pro or Max OAuth. Those choices add provider, refresh, reauthentication, and account-usage work and don't belong in this verdict.

### Fresh launch, resume, model, and effort

**OpenCode: pass.** `opencode [project]` starts the TUI. `--continue` resumes the latest session, and `--session <id>` resumes a named one. `--model provider/model` selects a fresh model. The `/models` picker switches a live session. Reasoning effort comes from model options or a declared variant in `opencode.json`. The prior direct wire probes on 1.18.18 found that resumed sessions preserve their model, reread base reasoning options, and store model IDs per assistant message. See [the model-switch evidence](../../prototypes/model-switch/findings.md) and [the reasoning-effort evidence](../../prototypes/harness-effort/findings.md). The 1.18.23 help output still exposes the same launch, continue, session, and model flags.

OpenCode model and effort switching are optional under ADR-0029, so a delayed switch implementation doesn't block the required contract. If exposed, Curia must validate values before pane input. OpenCode accepts some bad values until the next provider request.

**Pi: pass.** `pi` starts the TUI. `--continue`, `--session <path|id>`, and `--session-id <id>` give deterministic resume choices. `--provider`, `--model`, and `--thinking` select the launch values. `/model` switches a live model, and Shift+Tab changes thinking. Pi validates its fixed thinking vocabulary but falls back instead of exiting on an invalid value. Direct 0.84.2 probes found that the model survives resume, an explicit resume flag wins, and thinking must ride every resume command. The pinned 0.84.3 help preserves these commands. See [the model-switch evidence](../../prototypes/model-switch/findings.md) and [the reasoning-effort evidence](../../prototypes/harness-effort/findings.md).

### Standing orders and bounded skill discovery

**OpenCode: conditional pass.** OpenCode supports global `AGENTS.md`, configured instruction paths, and Agent Skills. Its skill catalog describes available skills and loads a selected `SKILL.md` on demand. See the pinned [skill loader](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/skill/index.ts) and [configuration schema](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/config/config.ts).

The adapter can place Curia's standing orders and selected skills under the redirected global config root. It must verify that the catalog stays bounded and that resume doesn't append another copy to conversation history. OpenCode's merge rules make containment part of this item, not a later cleanup.

**Pi: pass with seeded flags.** The adapter can pass `--append-system-prompt /cfg/<standing-file>` on every fresh and resumed launch. It can pass one `--skill` per installed skill and disable ambient discovery with `--no-skills`. Pi's resource loader builds the active catalog for each turn rather than appending copies to the saved conversation. See the pinned [CLI arguments](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/cli/args.ts) and [skills guide](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/skills.md).

### Authenticated Curia tools and the startup grace window

**OpenCode: pass, subject to a live handshake.** OpenCode has a native remote MCP client. Its config accepts a URL, request headers, enablement, and timeout, and the client passes configured headers to both Streamable HTTP and server-sent event transports. See the pinned [MCP implementation](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/mcp/index.ts).

The adapter can point one server named `curia` at the per-agent URL and send the existing token header. It must disable every other server and measure tool availability against `tool_channel_grace_s`. No exact pinned handshake ran in this session.

**Pi: conditional pass with a required extension.** Pi deliberately has no MCP client. Its extension API can register custom model-callable tools immediately, execute asynchronous code, and return or throw tool results. A Curia-owned extension can register exactly the Curia tool schemas and forward each call to the authenticated Curia MCP endpoint. See Pi's pinned [documented omission](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/usage.md) and [extension tool API](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/extensions.md).

This is not a configuration-only workaround. The bridge must implement the MCP initialization and call protocol, streaming keepalive behavior, cancellation, schema refresh policy, and loud transport errors. The startup check should query `pi.getAllTools()` or observe an extension-ready marker before Curia's grace window ends.

### Lint gate and enforceable completion

**OpenCode: conditional pass with a session controller or plugin.** The native MCP path sends Curia tool results back to the model, so ordinary lint rejection works. OpenCode has no Claude-compatible Stop hook. It does expose `session.status` and deprecated `session.idle` events, plus `session.promptAsync`. A Curia-owned controller can observe the root session becoming idle, call `/agent_done`, and enqueue the refusal reason as another user turn until Curia allows completion. See the pinned [status event](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/schema/src/session-status-event.ts), [plugin event hook](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/plugin/src/index.ts), and [prompt endpoint](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/sdk/js/src/gen/sdk.gen.ts).

This loop needs a prototype. It must exclude child sessions, avoid a race between idle and persisted messages, survive event-stream loss, and prove repeated blocking. A July 2026 upstream report describes stale `busy` status after a prompt completes, so the adapter can't trust status polling as its only liveness fact. See [OpenCode issue 35472](https://github.com/anomalyco/opencode/issues/35472).

**Pi: conditional pass with a required extension.** The Curia tool extension can return lint rejection as the tool result. Pi's `agent_settled` event fires when Pi won't continue automatically. The completion extension can then call `/agent_done`; on refusal, `pi.sendUserMessage()` injects a real user message and always triggers a turn. See the pinned [settled event and send API](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/extensions.md).

The extension must prevent recursive or duplicate checks, distinguish root work from extension-created sessions, and treat daemon or transport failure as incomplete. This path is more direct than OpenCode's session controller but remains unbuilt and unmeasured.

### Readiness, activity, stalls, process death, and pane input

**OpenCode: conditional pass.** Direct TUI probes on 1.18.18 found a stable footer and composer, safe model-picker filtering, and one important input rule: Ctrl+U clears queued composer text, but Ctrl+Y doesn't restore it. Curia must save and retype the text. The 1.18.23 process still exposes the same TUI and server event surfaces. Session status, message-part events, store growth, pane text, and process state can provide independent activity facts. See [the pane and model-switch evidence](../../prototypes/model-switch/findings.md).

The adapter needs exact 1.18.23 pane captures and classifiers. The stale-status risk means a stall decision must combine event, transcript, pane, and process evidence.

**Pi: conditional pass.** Direct TUI probes on 0.84.2 found a persistent model and thinking footer. Ctrl+U clears queued text, and Ctrl+Y restores it. JSON/RPC modes expose `agent_start`, streaming message and tool events, `agent_end`, and `agent_settled`. The 0.84.3 help and source preserve these surfaces. See the pinned [RPC event protocol](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/rpc.md) and [prior pane evidence](../../prototypes/model-switch/findings.md).

The adapter still needs exact 0.84.3 composer captures, process-death checks, and a measured stall classifier. Pi's explicit settled event lowers the inference burden.

### Durable normalized transcript

**OpenCode: conditional pass.** OpenCode persists sessions and message parts in its redirected data root. It can export a session as JSON, and its server exposes message and event APIs. The `opencode run --format json` path emits raw events. See the pinned [run command](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/cli/cmd/run.ts), [session schema](https://github.com/anomalyco/opencode/tree/v1.18.23/packages/schema/src), and [database source](https://github.com/anomalyco/opencode/tree/v1.18.23/packages/opencode/src/storage).

The adapter should read durable messages and parts, not depend on a live event stream alone. It must normalize user, assistant, and tool activity and report every unknown part or event type. SQLite is already present in the worker image. The database and schema are upstream implementation surfaces, so a version bump must rerun parser fixtures and live evidence.

**Pi: pass with a parser.** Pi's session is append-oriented JSONL with a versioned header and typed entries. Messages carry user, assistant, and tool content. Separate entries record model, thinking, compaction, branches, and custom extension state. `--session-dir` makes discovery deterministic. See the pinned [session-format guide](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/session-format.md) and [session manager types](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/session-manager.ts).

Curia must still apply its loud-parser rule. A malformed JSON line, unknown top-level entry, unknown message role, or unknown content part must surface instead of disappearing.

### Cross-harness fallback and worktree preservation

**Both: pass at the Curia layer.** Neither candidate needs to own fallback. Curia keeps the mounted ticket worktree, starts the replacement adapter with the existing prompt and a bounded context restatement, and doesn't pretend the old native session can resume under another harness. This is the same ADR-0029 rule used for Claude and Codex.

OpenCode's data root and Pi's agent and session roots remain harness-bound under `/cfg`. The fallback path must not infer a candidate from files in a shared config directory.

### Refusal of repository configuration and skills

**OpenCode: pass with disable flags and a refusal belt.** OpenCode merges remote, global, custom, project, `.opencode`, inline, and managed configuration by default. Project configuration isn't replaced by an inline config. It also discovers `AGENTS.md`, `.opencode` resources, and Agent Skills under project paths. See the pinned [configuration loader](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/config/config.ts), [config path walk](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/config/paths.ts), and [skill loader](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/skill/index.ts).

`OPENCODE_DISABLE_PROJECT_CONFIG=1` skips project configuration, `.opencode` discovery, and project `AGENTS.md`. `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` independently skips `.agents/skills` and `.claude/skills`. See the pinned [flag definitions](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/core/src/flag/flag.ts), [instruction context](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/core/src/instruction-context.ts), and [runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/effect/runtime-flags.ts). The adapter must set both flags, isolate HOME and every XDG root, seed only Curia's global resources, and preflight-refuse the known project inputs as a belt. It should also disable remote organizational configuration or refuse a provider account that supplies it.

**Pi: pass with explicit disable flags.** Start Pi with `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, and `--no-approve`. Then pass only the Curia extension, standing-order file, and selected skill paths explicitly. The 0.84.3 help names all of these controls. Pi's [resource loader](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/resource-loader.ts) implements the corresponding discovery policy.

### Automated conformance and live evidence

**Both: fail today, convertible to pass.** Curia's public harness list and transcript readers still name only Claude and Codex. No OpenCode or Pi adapter, fixtures, conformance results, or pinned full-loop record exists. The current boundaries are visible in `daemon/src/workspace.mjs` and `daemon/src/transcript.mjs`.

Before selection, each adapter needs:

1. Shared contract tests through injected filesystem, process, pane, transcript, and tool-channel seams.
2. Harness fixtures for command rendering, configuration, credentials, pane classification, transcript normalization, unknown events, and optional capabilities.
3. One full containerized run with a question and answer, lint rejection, completion blocking, review, and resolution.
4. Focused live checks for same-session resume, preserved worktree, lost Curia tools, process death, malformed and unknown transcript data, safe composer input, and live credential replacement.
5. Exact records naming OpenCode 1.18.23 or Pi 0.84.3 and worker image `curia-agent:2.1.220-0.146.0-2cd55c92`.

## Missing capabilities, workarounds, and risks

### OpenCode

- **Missing now:** Harness adapter, credential consumer, exact project-input refusal, enforceable completion integration, normalized transcript reader, conformance tests, and required live evidence.
- **Workaround:** Use native remote MCP for Curia tools. Use a controller or trusted global plugin over `session.status` and `promptAsync` for completion. Redirect every XDG root. Refuse all repository-owned OpenCode inputs before launch.
- **Risk:** Configuration is merged, so new upstream project sources enlarge the refusal list.
- **Risk:** Session status can lag completion or stay stale. Never base completion or stall decisions on one status map.
- **Risk:** The durable SQLite and event vocabularies are version-sensitive. The adapter must reject unknown data loudly.
- **Risk:** OpenCode accepts some unavailable models and invalid effort values until a provider call, which can lose the operator's turn.
- **Maintenance estimate:** Medium to high. Native MCP saves transport work, but containment and lifecycle behavior need continuing version-specific checks.

### Pi

- **Missing now:** Harness adapter, credential consumer, native MCP client, Curia tool extension, completion extension, normalized transcript reader, conformance tests, and required live evidence.
- **Workaround:** Register the exact Curia tools through one trusted global extension. Forward calls through an MCP client library. On `agent_settled`, call the completion endpoint and use `sendUserMessage` when blocked.
- **Risk:** The custom tool bridge becomes security- and protocol-sensitive code that Claude, Codex, and OpenCode don't need.
- **Risk:** A writable `auth.json` lets Pi refresh credentials itself. The daemon must stay ahead of expiry and keep the delivered file read-only.
- **Risk:** Pi is pre-1.0. Pinning and conformance checks are the compatibility boundary.
- **Risk:** Model and thinking resume rules differ. The adapter must state both on every resume command.
- **Risk:** In JSON mode, a terminal assistant `error` or `aborted` event can leave the process exit status at zero because the nonzero mapping is text-mode-only. The adapter must classify the event stream or use RPC instead of trusting process status. See the pinned [print-mode implementation](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/modes/print-mode.ts#L121-L161).
- **Risk checked, not reproduced:** [Pi issue 8620](https://github.com/earendil-works/pi/issues/8620) reports 0.84.3 failures for extensions importing bundled Pi modules. Exact-image RPC probes loaded the shipped `hello.ts` and `subagent/index.ts` extensions without an extension error and returned a successful `get_state` response. A Curia extension still needs its own exact-artifact load and tool-enumeration test.
- **Maintenance estimate:** Medium. Initial tool-bridge cost is higher, but transcript, resource isolation, and completion surfaces are narrower.

## Recommendation for the next map decision

If Curia advances one candidate first, advance **OpenCode** to a bounded adapter prototype. Native authenticated MCP removes the largest custom security and protocol surface, and exact disable flags answer the repository-authority requirement. The prototype should focus on repeated completion blocking and session-status races.

Keep **Pi** as a viable second candidate. Its settled event, forced-follow-up API, JSONL, resume flags, and resource-disable flags are strong contract surfaces. The map should first prove one exact-image Curia tool extension because both tool delivery and completion enforcement depend on it.

This recommendation doesn't decide final product scope. It orders the remaining uncertainty by contract risk.

## Evidence log

### Exact pinned image build

Command:

```sh
npm run build-agent-image --prefix daemon
```

Result:

```text
image  curia-agent:2.1.220-0.146.0-2cd55c92
ok: claude 2.1.220
ok: codex 0.146.0
ok: opencode 1.18.23
ok: pi 0.84.3
```

The Docker build runs each version command as uid 1000, the same worker user. See the [worker Dockerfile](../../deploy/agent/Dockerfile) and [image builder](../../daemon/src/image.mjs).

### Exact pinned help and roots

Commands:

```sh
docker run --rm -e HOME=/home/agent \
  curia-agent:2.1.220-0.146.0-2cd55c92 opencode --help

docker run --rm -e HOME=/home/agent \
  curia-agent:2.1.220-0.146.0-2cd55c92 pi --help

docker run --rm -e HOME=/home/agent \
  -e XDG_CONFIG_HOME=/cfg/config -e XDG_DATA_HOME=/cfg/data \
  -e XDG_STATE_HOME=/cfg/state -e XDG_CACHE_HOME=/cfg/cache \
  -e OPENCODE_CONFIG_DIR=/cfg/config/opencode -v <scratch>:/cfg \
  curia-agent:2.1.220-0.146.0-2cd55c92 opencode debug paths

docker run --rm -e HOME=/home/agent -e PI_CODING_AGENT_DIR=/cfg \
  -e PI_OFFLINE=1 -v <scratch>:/cfg \
  curia-agent:2.1.220-0.146.0-2cd55c92 \
  pi --no-session --no-extensions --no-skills --no-context-files --list-models
```

Results:

- OpenCode reported every redirected XDG path under `/cfg` and kept only `home` at `/home/agent`.
- Pi created `auth.json` and `models-store.json` under `/cfg` as uid 1000.
- OpenCode 1.18.23 exposed TUI, `run`, `serve`, `attach`, `acp`, `mcp`, model, continue, and session commands.
- Pi 0.84.3 exposed TUI, text/JSON/RPC modes, explicit session roots, model and thinking controls, selected resource paths, and resource-disable flags.

Pi's extension surface received two extra exact-image probes because [Pi issue 8620](https://github.com/earendil-works/pi/issues/8620) reports a 0.84.3 bundled-loader regression:

```sh
docker run --rm -i -e HOME=/home/agent -e PI_CODING_AGENT_DIR=/tmp/pi-test \
  -e PI_OFFLINE=1 curia-agent:2.1.220-0.146.0-2cd55c92 \
  bash -lc 'pi --no-session --no-skills --no-context-files \
    -e /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/hello.ts \
    --mode rpc' <<<'{"type":"get_state"}'
```

The same command then loaded `examples/extensions/subagent/index.ts`. Both returned a successful RPC `get_state` response, and the subagent probe exited zero. The published worker artifact therefore didn't reproduce the reported import failure for these shipped extensions. A Curia extension still needs its own load and callable-tool proof.

### Pinned upstream source

The source review used exact release tags, not moving branches:

```text
OpenCode v1.18.23  ef2880f379129aa048be9e9353e30aa168d42c17
Pi v0.84.3        4e58f324fae8ebfa98a3d45181fb248072a2afac
```

Primary repositories:

- [OpenCode v1.18.23](https://github.com/anomalyco/opencode/tree/v1.18.23)
- [Pi v0.84.3](https://github.com/earendil-works/pi/tree/v0.84.3)

### Environment limits

This environment had Docker and network access, so the exact shared image and source tags were available. It did not provide a disposable subscription credential or an isolated Curia daemon endpoint for destructive authentication and completion tests. The research therefore did not claim evidence for provider-backed generation, held MCP calls, credential rotation, live healing, or end-to-end completion enforcement. ADR-0029 requires those checks before either conditional pass can become a pass.

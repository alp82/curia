# The worker context budget

**Question** ([#166](https://github.com/alp82/curia/issues/166)): why do worker sessions carry so
much context, and what can curia cut?

**Answer**: nothing worth cutting. The context is not large. The **meter** is wrong by 5×,
because curia divides by 200,000 tokens and the claude lane runs a 1,000,000-token window.
A fresh worker sits at **2%** of its window, not 30%. The session the operator watched reach
"100%" reached **25%**.

**Method**: measured on the deployment box (`coinmatica.net`) on 2026-08-03.

1. A `/context` reading from a live Claude Code session started with a faithful copy of a
   worker's config: the same `CLAUDE_CONFIG_DIR` shape `seedConfigDir` writes, the same nine
   symlinked skills, the same `voice.md` memory file, the same project `.mcp.json` pointing at
   the live daemon, and the same `--model opus --permission-mode bypassPermissions`. The probe
   ran in its own tmux session and is torn down.
2. Token totals from the thirteen claude-lane worker transcripts kept under
   `~/curia-work/cfg/*/projects/*/*.jsonl`, summed the way `usage.mjs` sums them
   (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`).
3. The codex-lane counterpart from `~/curia-work/cfg/*/sessions/*/rollout-*.jsonl`.

The transcripts live outside the repo and a sweep can remove them, so every number below is
quoted here.

## 1. The meter divides by the wrong window

`config/routing.yaml` states `context_window: 200000` for `fable`, `opus` and `sonnet`, with the
comment "200000 is the standard window for these three". Claude Code disagrees, on the box, for
the model curia actually dispatches:

```
Opus 5
claude-opus-5
24.8k/1m tokens (2%)
```

Every claude-lane transcript names the same model, `"model":"claude-opus-5"`. So the denominator
is five times too small, and every context figure the status line has ever shown on the claude
lane is five times too large.

The clamp in `usage.mjs` (`Math.min(100, ...)`) hid the size of the error. Session 151 sent
**248,003 tokens** in one request. Under the configured window that is 124%, rendered as `ctx
100%`. Under the real window it is 25%, and the auto-compaction the operator suspected of being
broken correctly never fired.

| Session | Turns | First request | Peak request | Shown | True (of 1M) |
|---|---:|---:|---:|---:|---:|
| curia-151 | 251 | 36,985 | 248,003 | 100% | 24.8% |
| curia-138 | 94 | 37,230 | 154,543 | 77% | 15.5% |
| curia-82 | 92 | 37,345 | 147,536 | 74% | 14.8% |
| curia-112 | 99 | 36,086 | 123,273 | 62% | 12.3% |
| curia-110 | 143 | 35,949 | 115,616 | 58% | 11.6% |
| curia-115 | 107 | 37,368 | 107,373 | 54% | 10.7% |
| curia-114 | 106 | 36,131 | 107,368 | 54% | 10.7% |
| curia-150 | 100 | 36,912 | 101,615 | 51% | 10.2% |
| curia-113 | 129 | 35,968 | 98,542 | 49% | 9.9% |
| curia-111 | 88 | 35,914 | 93,331 | 47% | 9.3% |
| curia-106 | 82 | 35,738 | 90,732 | 45% | 9.1% |
| curia-114b | 68 | 35,843 | 78,716 | 39% | 7.9% |
| curia-107 | 38 | 35,639 | 62,699 | 31% | 6.3% |

The first request of every session lands between 35,639 and 37,368 tokens — **3.6% of the real
window, shown as 18%**. The operator's "almost 30%" screenshots are about 60,000 tokens, which is
6%.

**The codex lane is correct.** Its transcript states `"model_context_window":258400`, and the
`context_window: 258400` in `routing.yaml` matches. Its peak observed request is 141,297 tokens,
55% of that window, which is a real number.

## 2. Where the 24.8k of a fresh session goes

`/context` on the probe, before any prompt:

| Category | Tokens | Share of 24.8k | Whose |
|---|---:|---:|---|
| System tools | 17.9k | 72% | Claude Code |
| System prompt | 3.6k | 15% | Claude Code |
| Skills (21) | 2.3k | 9% | 0.5k curia, 1.8k Claude Code |
| Memory files (3) | 985 | 4% | 763 curia (`voice.md`), 222 the repo |
| Messages | 8 | 0% | — |
| MCP tools (38) | **0** | 0% | loaded on demand |

Curia owns 3.3k of 24.8k, or **0.33% of the window**.

The 2.3k of skills splits into seven curia skills the model can see (`code-review` 140,
`research` 80, `domain-modeling` 80, `prototype` 60, `diagnosing-bugs` 60, `grilling` 50, `tdd`
50 — 520 tokens) and fourteen Claude Code built-ins curia never configured (`dataviz` 380,
`claude-api` 360, `update-config` 240, `artifact-capabilities` 140, `schedule` 130, `run` 120,
`loop` 110, `keybindings-help` 80, `fewer-permission-prompts` 60, `simplify` 60,
`security-review` 30, `review` 30, `artifact-design` 20, `init` 20 — 1,780 tokens).
`wayfinder` and `implement` cost nothing, which confirms that
`disable-model-invocation: true` keeps a skill out of the listing.

The `/wayfinder` prompt and the map and ticket reads take the session from 24.8k to about 36k.
That is the skill text the worker is dispatched to run, so it is the work, not waste.

**The largest cut available to curia is 1.8k tokens, and it is not curia's to make.** Removing
every built-in skill would save 0.18% of the window. Removing `voice.md` would save 0.08% and
cost the writing rules. There is no context-waste ticket here.

## 3. Two status-line faults found beside it

Both live in `#146`'s meters and are separate from the denominator.

**The line names the routing label, not the model.** `meterParts` renders `m.model`, which is the
key in `routing.yaml`. On the claude lane the key `opus` reads like a model and hides the
mismatch. On the codex lane the key is `gpt` while `id` is `gpt-5.6-sol`, so the line and the
dispatch message both say `gpt` about a Sol 5.6 worker. `usage.mjs` already holds the spec that
carries `id`.

**The model drops off long lines.** `#text` appends meters in value order and stops at the first
one that will not fit in `LINE_BUDGET` (130 columns). A `waiting` line carrying a long escalation
title starts near 116 columns, so the model group — first in the order — is the one that goes,
and everything after it goes with it. The line then says nothing about the model at all.

**What shipped** ([#179](https://github.com/alp82/curia/issues/179)): both. `workerMeters` now
resolves a model NAME from three sources, best evidence first — the model the transcript states,
then `models.<label>.id`, then the routing label. That is the same order #178 settled for the
context denominator, asked about the same fact. The status line and the composer-ready message
both say it. And the meter run no longer loses to the base: a `waiting` line cuts its escalation
title far enough to keep the model, down to a floor of 24 columns.

## 4. A bounds finding, not a context one

The probe's 38 MCP tools are curia's six (`ask_human`, `notify`, `open_pull_request`,
`publish_preview`, `report_result`, `request_review`) plus the operator's account-level claude.ai
connectors: Notion, Gmail, Google Drive and Google Calendar. `#23`/`#29` state that a worker gets
"no MCP connectors from the host", and `CLAUDE_CONFIG_DIR` does hold that line. Account
connectors do not travel through the config dir. They follow the credential, which `#53`
deliberately shares with the host.

They cost 0 context tokens, so this is not a context fault. It is a bounds fault: a worker can
read and write the operator's Notion, mail, Drive and calendar.

**What shipped** ([#180](https://github.com/alp82/curia/issues/180)): the namespace is bounded
in the worker's own `settings.json`, and the credential did not have to change. Claude Code runs
an eligibility chain before it fetches account connectors, and `disableClaudeAiConnectors` sits
ahead of every auth branch in it — measured both ways against the pinned CLI, which names the
setting in its own debug line. A second key, `allowedMcpServers`, admits curia's server and
nothing else, whatever route another server arrives by. Its entries are objects, not strings, and
the string form enforces an EMPTY allowlist that takes curia's own server with it.

The same probe found the container lane already closed, by accident rather than by decision: its
`CLAUDE_CODE_OAUTH_TOKEN` states `user:inference` alone, and the API refuses it `403 ... does not
meet scope requirement user:mcp_servers`. The bare-pane lane is the open one, because it shares
the host store and its interactive-login credential. Measurements in
[docs/live-checks/180-worker-mcp-namespace.md](../live-checks/180-worker-mcp-namespace.md).

## 5. What a fix must not repeat

The claude transcript states no window anywhere — searched, and the only matches in a 1.4 MB
transcript are curia's own source text that a worker read. Config is the only source, so a
corrected number can go stale again exactly as this one did.

Two guards are cheap and were missing:

- **A request above the configured window proves the config wrong.** Session 151 sent 248,003
  tokens against a stated 200,000 and the meter answered `100%`. Clamping turned evidence into a
  plausible reading. Over-window should say so.
- **The number belongs beside its measurement.** `1m` is what the CLI itself prints; a live check
  of one `/context` line is enough to confirm or refute the config, and takes one probe.

**What shipped** ([#178](https://github.com/alp82/curia/issues/178)): both guards, and config
stopped being the source. The transcript states the model id on the same line as the counts, and
`GET /v1/models/<id>` states its `max_input_tokens` — so the denominator is now two live facts
neither of which a human maintains. The meter no longer clamps: over 100% it renders at its real
size with a ⚠️. Measurements in
[docs/live-checks/178-context-window-source.md](../live-checks/178-context-window-source.md).

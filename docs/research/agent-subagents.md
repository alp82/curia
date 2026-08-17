# Subagents inside the dispatched agents

**Question** ([#529](https://github.com/alp82/curia/issues/529)): a dispatched agent spends its
own context window on reading and searching, and the context percent is the one meter that warns.
Can curia's agents push that work into subagents, so the main context stays small?

**Answer**: yes, on both harnesses, today, with no daemon change. Both pinned harnesses ship
model-invocable subagents that run in a separate context, curia restricts neither, and a codex
agent under curia's own config already spawned one live. But the measured pressure does not
support a build ticket. The claude lane peaks at 25% of its real window, and the codex lane at
55%. The one cheap lever is one paragraph in the standing orders, and one meter fault must be
checked before that paragraph is written. A grilling ticket follows, not a prototype.

**Method**: read at the pins in `config/curia.yaml`: claude 2.1.220, codex 0.146.0. Sources are
the harness docs and the tagged codex source tree, curia's own daemon source, the vendored
skills, the closed tickets, and the transcripts on this box.

## 1. What each harness offers

### claude 2.1.220

- **The subagent tool.** The model can delegate a task to a subagent. Each subagent runs in its
  own context window, with its own system prompt, and it does not see the parent's history or
  the files the parent read. Only its final report returns to the parent. The intermediate tool
  output stays in the subagent's context
  ([sub-agents doc](https://code.claude.com/docs/en/sub-agents.md)).
- **Built-in agent types.** `Explore` (read-only, for search and analysis), `Plan` (read-only),
  and a general-purpose type with all tools (same doc).
- **Custom agents.** Markdown files under `.claude/agents/` (project) or `~/.claude/agents/`
  (user), with frontmatter for `name`, `description`, `tools`, and `model`. The model can invoke
  one on its own when the description matches the work (same doc).
- **Skills.** A skill runs inline in the current context by default. The frontmatter field
  `context: fork` runs it in a subagent context instead, with an optional `agent` field to pick
  the type ([skills doc](https://code.claude.com/docs/en/skills.md)).
- Caveat: the claude docs site is versionless, so these pages describe the current release line.
  Local evidence agrees with them for the pinned CLI. The
  [worker context budget](worker-context-budget.md) probe on the pinned image saw the skill
  catalog behave as the docs state, and the transcript format carries subagent entries as
  `isSidechain` lines in the same file.

### codex 0.146.0

- **The collaboration tools.** The "MultiAgentV2" toolset gives the model `spawn_agent`, `wait`,
  `send_message`, `list_agents`, and `interrupt_agent`
  ([tagged source](https://github.com/openai/codex/tree/rust-v0.146.0/codex-rs/core/src/tools/handlers/multi_agents_v2)).
  `spawn_agent` takes a `fork_turns` parameter: `"none"` for a fresh context, `"all"` for a full
  fork of the parent's history, or a turn count
  ([tagged config](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/config/mod.rs)).
  So a fresh-context subagent is a first-class call, not a shell trick.
- **On by default.** The committed schema at the tag states `agents.enabled` "Defaults to true",
  beside `agents.default_subagent_model` and a per-session thread cap
  ([tagged schema](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/config.schema.json)).
- **Custom agent roles.** TOML files under `~/.codex/agents/` or `.codex/agents/`, with
  `developer_instructions`, an optional `model`, and per-role `skills.config`. The docs state the
  parent collects a summary rather than the raw output, to avoid context pollution
  ([subagents doc](https://developers.openai.com/codex/agent-configuration/subagents)).
- **Skills stay inline.** A codex skill loads its full `SKILL.md` into the current thread. There
  is no fork field ([skills doc](https://developers.openai.com/codex/skills)).
- **No documented self-invocation pattern.** `codex exec` exists, but no doc recommends shelling
  out to it for a fresh context. `spawn_agent` with `fork_turns: "none"` is the documented way.

### What curia's config does to these tools

Nothing that removes them, on either lane, and that is a ruling rather than an accident.

- The claude agent's `settings.json` sets three keys and no tool list, and the spawn command
  carries `--permission-mode bypassPermissions` and no `--disallowedTools`
  (`daemon/src/workspace.mjs:693-697`, `config/routing.yaml:126`). The one place curia disallows
  the `Task` tool is the overseer (`daemon/src/overseerprompt.mjs`), which is not a dispatched
  agent.
- The codex `config.toml` writes `multi_agent = false`, and [#207](https://github.com/alp82/curia/issues/207)
  measured that flag as a no-op on 0.146: the family moved to the collaboration tools, and a
  live agent under this exact config spawned a subagent (docs/live-checks/207). The operator
  then ruled the collaboration tools allowed (2026-08-05): "they are the codex spelling of
  claude's own subagents, which curia has never forbidden" (`daemon/src/workspace.mjs:854-862`).

## 2. What curia says today

- `CONTEXT.md` (Agent): an agent "may spawn subagents of its own, which curia neither sees nor
  counts".
- **The standing orders say nothing about subagents.** The bounds, tools, and ending prose in
  `daemon/src/workspace.mjs` (`standingBody`, lines 2025-2059) never name them, forbid them, or
  invite them. The only subagent prose a dispatched agent ever reads is the charting dispatch's
  burn-down parameters (`researchParams`, `workspace.mjs:1394-1414`): one `/research` subagent
  per research ticket, no git inside a subagent. A ticket builder reads no such line.
- **Installed skills** (`config/curia.yaml` `skills.install`, vendored at `skills/`):
  - `research` spawns a background agent as its whole mechanism (`skills/research/SKILL.md`).
  - `code-review` runs its Standards and Spec axes as parallel subagents, stated to keep the two
    contexts apart (`skills/code-review/SKILL.md`).
  - `wayfinder` fires one `/research` subagent per research ticket at charting
    (`skills/wayfinder/SKILL.md:115`).
  - `implement`, `tdd`, `grilling`, `diagnosing-bugs`, `prototype`, and `domain-modeling` name
    no subagent. Their reading and searching runs inline.
- **The transcripts agree.** No claude-lane transcript under `~/curia-work/cfg/` on this box
  carries a single `Task` call or an `isSidechain` line. Outside the charting burn-down and a
  `/code-review` run, every dispatched agent does all reading in its main context today.

## 3. The measured pressure

[The worker context budget](worker-context-budget.md) already measured where context goes, on
the deployment box, and its numbers bound this ticket.

- The claude lane runs a 1,000,000-token window. The largest request ever observed was 248,003
  tokens, which is 25% of the window. A fresh session starts at 3.6%. The alarming meter
  readings were a denominator wrong by 5×, fixed at
  [#178](https://github.com/alp82/curia/issues/178).
- Of a fresh session's 24.8k tokens, curia owns 3.3k. The note's conclusion: "There is no
  context-waste ticket here."
- The codex lane is the real pressure. Its window is 258,400 tokens and its observed peak was
  141,297 tokens, which is 55%. Codex 0.146.0 also ships auto-compaction keys
  (`model_auto_compact_token_limit`, [tagged schema](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/config.schema.json)),
  so the wall is soft, at the price of a lossy summary.
- Newer local transcripts agree with the old measurement: the three newest claude-lane sessions
  on this box (curia-85, 86, 90) peak between 49,298 and 65,459 input tokens, under 7% of the
  window.
- The meter is display-only, on purpose. `agentMeters` in `daemon/src/usage.mjs` computes the
  percent, nothing acts on a threshold, and the source states "The context percent IS the
  signal". The closed tickets on this pain are [#166](https://github.com/alp82/curia/issues/166)
  (the waste that was not there), [#178](https://github.com/alp82/curia/issues/178) (the wrong
  denominator), and [#146](https://github.com/alp82/curia/issues/146) (the meter itself). No
  ticket records an agent that actually ran out of context.

## 4. The levers, and what each costs

Three classes of work can move into a subagent:

1. **Search-and-read fan-out.** The survey phase of `implement`, `diagnosing-bugs`, and
   charting: many files read, few facts kept. This is the textbook case for claude's `Explore`
   type and for `spawn_agent` with `fork_turns: "none"`. It is the largest class, because file
   content dominates a long session's growth.
2. **Review.** Already delegated: `code-review` runs its two axes as subagents.
3. **Test runs and long tool output.** A subagent runs the suite and reports the failures. Small
   win on the claude lane, where the meter counts the last request rather than the sum. Real win
   only when the output would stay in context across many turns.

The costs:

- **Tokens.** A subagent re-reads its own system prompt and re-opens the files it needs, so
  total account spend goes up while the main context stays small. The account bars still count
  it, because usage is an account fact. Only the context percent and curia's liveness view miss
  it.
- **Wall clock.** A serial delegation adds a round trip. Parallel fan-out can win time back.
- **Invisibility.** "Curia neither sees nor counts" a subagent (`CONTEXT.md`). The operator who
  attaches sees the parent's pane, and the status line meters the parent.
- **A meter fault to check first.** `claudeTail` in `daemon/src/usage.mjs` takes the last usage
  line of the transcript, and claude writes subagent usage into the same file as `isSidechain`
  lines. A small subagent request that lands last would make the meter under-report the main
  context. No local transcript has a sidechain line, so this is unmeasured. If curia invites
  subagents, the one warning meter must first learn to skip sidechain lines.
- **The bounds question.** The standing orders ride the config dir's memory file. Whether a
  spawned subagent loads that file, and so inherits the write bounds and the tool bound, is not
  established for either harness. The Stop hook and the lint gate bind only the parent.

What curia would change, per lever:

- **Skills prose: nothing.** The vendored skills are never patched (ADR-0006 vendors them
  unmodified, `skills/UPSTREAM.md`). `research` and `code-review` already delegate. A change to
  `implement` or `tdd` is an upstream proposal, not a curia edit.
- **Standing orders: the one real lever.** One paragraph in `standingBody`
  (`daemon/src/workspace.mjs`) that invites fan-out delegation and states the inherited bounds.
  It reaches both harnesses through the memory file, every turn.
- **Spawn prompt: nothing.** The prompt states parameters, not procedure, and delegation is
  procedure.
- **Config: nothing.** Both harnesses ship the tools on, and curia already leaves them on.

## 5. Recommendation

A grilling ticket, not a prototype. The capability needs no proof: both harnesses ship it, curia
restricts it nowhere, live-check 207 shows a codex agent spawning one, and the charting
burn-down exercises it on the claude lane every time it runs. What needs a decision is whether
to spend anything at all, because the measured claude-lane pressure is under 25% of the window
and no agent has ever run out.

The grilling ticket should ask:

1. Is a standing-orders paragraph that invites subagent fan-out worth its risk, and on which
   lane? The codex lane is the one with real pressure (55% peak of a 258,400 window).
2. Must the context meter skip `isSidechain` usage lines before that paragraph lands, so the one
   warning meter stays honest? This is a small `usage.mjs` change and a live check.
3. Do subagents inherit the standing orders, the write bounds, and the tool bound, on each
   harness? If not, what one sentence in the inviting paragraph carries the bounds down?
4. Does the operator accept more account spend and less visibility in exchange for a smaller
   main context, given that curia neither sees nor counts a subagent?

If the grilling answers yes to the paragraph, the follow-up is a small build ticket: the
`usage.mjs` sidechain fix, the paragraph, and one live check per harness that a subagent under
curia's config respects the write bounds.

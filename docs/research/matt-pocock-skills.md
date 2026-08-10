# Matt Pocock's skill set (sandcastle) — survey for curia

Date: 2026-07-21. **Sources:** the skills installed in this environment (`/home/alp/.agents/skills/`, symlinked into `~/.claude/skills/`) read first-party as the authoritative current copy, cross-checked against the canonical upstream `github.com/mattpocock/skills` (engineering README + docs), the aihero.dev skill docs, and the v1.1 changelog. **Method:** read every relevant `SKILL.md` directly; used the web only to confirm the "sandcastle" name, the canonical skill inventory, and deltas between the local install and upstream.

---

## Update 2026-08-10: the set moves to 1.2 (#268)

Everything below this section surveys **v1.1.0**. The set is now vendored in this repo at
`skills/`, pinned to **v1.2.3** — see [skills/UPSTREAM.md](../../skills/UPSTREAM.md) for the
release, the commit and how to bump it.

**What was installed before this.** Eight of curia's nine skills matched `v1.1.0` byte for
byte. `prototype` had drifted: it carried part of the 1.2 reshape and not the rest, with no
record of the edit. Version 1.2.3's `prototype` is a strict superset of that copy, so the
drift resolved with nothing lost.

### Breaking changes, and what must follow

| Change in 1.2 | What it hits |
|---|---|
| **`grilling` is round-by-round.** It maps a design tree, asks the whole **frontier** in one numbered round, then recomputes. It also dispatches sub-agents for facts. | [ADR-0005](../adr/0005-escalation-contract.md) and the spawn prompt both say one question at a time. A round of N questions has no shape in `ask_human`. **Unresolved — needs a decision.** |
| **`wayfinder` names the unit a decision ticket**, and the charting session now resolves research tickets with `/research` sub-agents on a `research/<name>` branch. Charting hand-resolves nothing else. | **Settled by [#286](https://github.com/alp82/curia/issues/286): curia takes both.** The operator ruled for compatibility with the skill over curia's earlier shape. A charting session burns down the research tickets it creates, each subagent on its own throwaway `research/<name>` branch, merged into `curia/<map>` and carried by one pull request through the gate. So [ADR-0008](../adr/0008-resolved-means-merged.md) holds unbent, and the branch needs no pusher. **Decision ticket** joins [CONTEXT.md](../../CONTEXT.md) beside **Ticket**, as the subset it names. The skill file is untouched. |
| **`prototype` produces one shareable HTML file**, captured on a throwaway `prototype/<name>` branch with a context pointer. | [ADR-0008](../adr/0008-resolved-means-merged.md) gives an agent one branch, `curia/<n>`, and one pull request. A second branch has no path through the gate. **Unresolved — needs a decision.** |
| **`writing-great-skills` → `writing-for-agents`**, model-invoked, no alias. | Not in `skills.install`. The inventory table below is stale on this row. |
| **`resolving-merge-conflicts` now ships** in the promoted set. | It was the one upstream/local gap this survey found. It is vendored now, still not installed. |
| `code-review` drops Claude Code's tool and agent-type names. | Helps the codex harness ([#173](https://github.com/alp82/curia/issues/173)). No action. |
| `diagnosing-bugs` gains a **Redact** section. | Agents paste command output into threads and pull requests. A gain, no action. |
| The `deprecated/` bucket is gone, `qa` with it. | The "`qa` does not exist" note below is now true by deletion as well. |

### New invocation forms

- **The set ships as a Claude Code plugin** (`claude plugins install mattpocock-skills`).
  curia cannot use it: a plugin lands under `<config dir>/plugins/`, and `installSkills`
  builds `<config dir>/skills/<name>`. Upstream also warns that two installs leave every
  skill twice. curia stays on the vendored copy.
- **Codex metadata beside every skill** (`agents/openai.yaml`) carries the display name and
  `policy.allow_implicit_invocation`, the analog of `disable-model-invocation`. The vendored
  tree copies it, so a codex agent reads it with no extra step.
- **Three new promoted skills**: `wizard` (model-invoked, generates a bash script that walks
  a human through a manual procedure), `wait-what` (one word, re-pitches a message), and
  `to-questionnaire`. None are installed. `wizard` is the interesting one for curia, because
  a `wayfinder:task` ticket is exactly the HITL checklist it writes.

---

## What "sandcastle" is

**Sandcastle is not a skill.** It is Matt Pocock's **demo/example repo** — the codebase he drove `/wayfinder` across on stream to chart the "should we pull in the Vercel AI SDK as a dependency" investigation. It illustrates the skills; it is not part of them. The skills themselves live in one repo, `mattpocock/skills` ("Skills for Real Engineers. Straight from my .agents directory."), and are already installed and configured in this environment. **Takeaway for curia: there is nothing to adopt from "sandcastle" beyond the worked example; the artifact formats curia cares about come from the skills, which we already have locally.** curia itself is already set up on these skills — `docs/agents/{issue-tracker,triage-labels,domain}.md` are their setup output, and this very wayfinder map is one of their artifacts.

## Verdict for curia

**The skills matter to curia as a source of artifact formats, not as software to run.** They define the exact shapes curia's overseer must read and write: the **wayfinder map** (a labelled issue with Destination / Decisions / Fog), the **child ticket** (native blocking edges + `wayfinder:<type>` + assignee-as-claim), the **spec** (`to-spec` PRD template), the **tracer-bullet ticket** (`to-tickets`, `ready-for-agent`, native blocking links), and the **triage state machine** + **agent brief**. curia's full loop ("reports frontiers, dispatches a worker, the ticket resolves and the map updates") is *literally* a machine reading and writing these formats over a GitHub tracker. So the overseer's awareness source (ticket #10) is not an open question of format invention — **the format already exists and this repo already speaks it**; the open question is only the read/query mechanism. Nothing here changes the dispatcher/worker/bridge candidate evaluations; the skills sit *above* that layer as the planning grammar the whole system serves.

## The inventory

Two axes: **user-invoked** (`/name`, `disable-model-invocation: true`) vs **model-invoked** (a skill pulls it in), and where each sits on the planning → dispatch → review arc. Locally installed unless flagged.

| Skill | Invocation | Arc slot | One-liner |
|---|---|---|---|
| **ask-matt** | user | router | "Which skill fits?" — a map over the whole set (see below). |
| **setup-matt-pocock-skills** | user | precondition | One-time repo config: issue tracker, triage labels, domain-doc layout. Wrote curia's `docs/agents/*.md`. |
| **grill-with-docs** | user | plan (idea) | Relentless one-question-at-a-time interview that *persists* into `CONTEXT.md` + ADRs. The stateful on-ramp. |
| **grill-me** | user | plan (idea) | Same interview, **stateless / no codebase** — saves nothing. |
| **grilling** | model | plan (primitive) | The underlying one-question interview loop both grills drive. Wayfinder uses it directly. |
| **domain-modeling** | model | plan (vocabulary) | Sharpen domain terms, resolve overloaded words, record ADRs. The discipline `grill-with-docs` runs to keep `CONTEXT.md` a clean glossary. |
| **prototype** | model | plan (detour) | Throwaway program answering one design question (state model / UI). Keep the answer, delete the code. |
| **research** | model | plan (detour) | Background agent investigates against primary sources, leaves a cited `.md` in the repo. **This ticket type.** |
| **wayfinder** | user | plan (foggy) | Charts a huge effort as a *map of decision tickets* on the tracker, resolved one at a time. **The map curia is being built under.** |
| **to-spec** | user | plan → dispatch handoff | Synthesizes the current thread into a spec/PRD (no interview) and publishes it, labelled `ready-for-agent`. |
| **to-tickets** | user | dispatch | Slices a plan/spec into **tracer-bullet** tickets with **native blocking edges**, published `ready-for-agent`. |
| **triage** | user | dispatch (on-ramp) | State machine for issues/PRs *you didn't create*; produces `ready-for-agent` **agent briefs**. |
| **implement** | user | dispatch → review | Builds one spec/ticket via `/tdd`, then `/code-review`, then commits. The unit of AFK execution. |
| **tdd** | model | review (build) | Red-green-refactor at pre-agreed seams. |
| **code-review** | user+model | review | Two-axis review of a diff — **Standards** (repo conventions) + **Spec** (does it match the issue). |
| **diagnosing-bugs** | model | review (on-ramp) | Tight-feedback-loop debugging for hard/intermittent bugs; refuses to theorize before a red repro. |
| **codebase-design** | model | review (vocabulary) | Deep-module vocabulary (module/interface/depth/seam/adapter) for shaping a module. |
| **improve-codebase-architecture** | user | upkeep | Scans for "deepening opportunities"; each found candidate becomes an idea for the main flow. |
| **handoff** | user | cross-session | Compacts a conversation into a markdown file so a *fresh* session can continue. `/handoff` forks; `/compact` continues. |
| **resolving-merge-conflicts** | model | review | *(upstream only — NOT installed here)* Resolve conflicts hunk-by-hunk by intent. |
| **teach** | user | standalone | Learn a concept over multiple sessions using the cwd as a stateful workspace. |
| **writing-great-skills** | user | meta | Reference for authoring skills well. |
| **find-skills** | model | meta (ecosystem) | Generic `npx skills` discovery over skills.sh — **not part of Matt's engineering flow**, a general ecosystem helper. |

Not from Matt's set but installed alongside (Alp's own): **computer-use**, **orca-cli**, **orchestration**. Out of scope for this survey.

**Two inventory notes worth flagging:**
- **`qa` does not exist.** `setup-matt-pocock-skills` names a `qa` skill ("Skills like `to-tickets`, `triage`, `to-spec`, and `qa` read from…") but no such skill ships upstream or locally — a stale reference. Do not build curia to expect it.
- **`resolving-merge-conflicts`** is in the canonical engineering README but **absent from this install** — the only upstream/local delta found. Relevant if curia's workers ever run parallel branches on one project (currently out of scope — the PoC runs one worker).

## The flow they encode (`ask-matt`, verbatim shape)

One **main flow** with two **on-ramps**:

```
idea ─▶ grill-with-docs ─▶ [runnable question? ─▶ handoff⇄prototype]
     ─▶ multi-session? ─┬─ yes ─▶ to-spec ─▶ to-tickets ─▶ implement (per ticket, fresh context)
                        └─ no  ─────────────────────────▶ implement (same window)
                                            implement = tdd (red-green) ─▶ code-review ─▶ commit

on-ramp: raw issues/requests  ─▶ triage        ─▶ (produces ready-for-agent) ─▶ implement
on-ramp: huge foggy effort    ─▶ wayfinder ─▶ (decisions, not deliverables) ─▶ merges at to-spec
```

Mapped to curia's **planning → dispatch → review**:
- **Planning** = `wayfinder` (foggy) / `grill-with-docs` (holdable) → `to-spec`. Output: a **spec** or a **map of resolved decisions**.
- **Dispatch** = `to-tickets` (+ `triage` for inbound) → **tracer-bullet tickets, `ready-for-agent`, native blocking edges**. This is precisely the frontier curia's overseer reports and hands to a worker.
- **Review** = `implement` internally runs `tdd` then `code-review` (Standards + Spec) before committing. curia's worker *is* an `/implement` run; the "cross-check" idea (model A implements / model B reviews) is already explicitly **out of scope** on the map and layers on top of this.

Context-hygiene rule they insist on: keep grill → spec → tickets in **one unbroken context window** (the ~120k "smart zone"), then **each `/implement` starts fresh from its ticket, clearing context between tickets.** This is a direct constraint on how curia should spawn workers — **one worker session per ticket, seeded only from the ticket body**, not a long-lived worker carrying accumulated context. It also explains why tickets and specs forbid file paths / code snippets: they must survive being read cold by a fresh agent.

## What shapes the overseer's awareness-source decision (ticket #10)

**The skills define the exact ticket/spec formats curia should read — curia should consume them, not invent its own.** Concretely, the overseer can treat the tracker as its world model because every artifact is already structured and labelled:

- **Frontier is a native query, not a parse.** `to-tickets`/`wayfinder` encode blocking as **GitHub native issue dependencies** (`issue_dependencies_summary.blocked_by`), and claiming is **assignee = the driving dev**. So "what's takeable" = *open child, `blocked_by == 0`, no assignee* — a pure API query (exactly what this session ran to pick ticket #7). curia's overseer reports frontiers by running that query per project; it does **not** need to read issue prose to know what's dispatchable.
- **Type/role lives in labels.** `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`) and the triage roles (`ready-for-agent`, `ready-for-human`, `needs-info`, …) are the machine-readable signal. `ready-for-agent` is the explicit "an AFK worker may grab this" flag — the dispatch gate curia keys on.
- **The bodies have fixed templates.** Spec (`to-spec`: Problem / Solution / User Stories / Implementation Decisions / Testing Decisions / Out of Scope), ticket (`to-tickets`: What to build / Acceptance criteria / Blocked by), agent brief (`triage`), wayfinder map (Destination / Notes / Decisions / Fog / Out of scope). A worker is seeded from *one* such body; the overseer summarizes from their headings.
- **Resolution is a fixed protocol.** Comment the answer → close → append a one-line context pointer to the map's Decisions-so-far. "The ticket resolves and the map updates" in the full loop is exactly this three-step write. curia's overseer performs it (or drives a worker that does).
- **Setup already wired this repo.** `docs/agents/issue-tracker.md` spells out the precise `gh`/`gh api` commands for every wayfinding operation (map, child, blocking edge via database-id, frontier query, claim, resolve). **curia's awareness layer can lift these command recipes directly** rather than designing a tracker interface from scratch.

**Recommendation to fold into ticket #10:** the overseer's awareness source is **the GitHub tracker itself, read through the Matt-Pocock artifact grammar** — labels + native dependencies for the machine-actionable state (frontier, claim, type), template headings for the human-readable summary. No secondary index or bespoke schema is needed for the PoC. This also lands ticket #14 (demo maps for both projects) cheaply: those maps are ordinary `/wayfinder` maps in this same format, and #12 (session/device identity) can reuse **assignee-as-claim** as its claim primitive.

## Loose ends / caveats

- The **local install is the source of truth** for what curia runs against; upstream is ahead by exactly one skill (`resolving-merge-conflicts`) and the versions here are current enough that `ask-matt`'s flow map matches the installed skills 1:1 (minus that one).
- The skills assume a **human in the loop** for `grilling`/`prototype`/`triage`/`to-tickets` approval steps. curia's overseer automates the *dispatch and resolution plumbing* around them, but the HITL skills stay HITL — which is exactly what the Discord escalation round-trip (ticket #11) exists to carry. The escalation contract should mirror `grilling`'s **one-question-at-a-time** shape.
- Nothing in the skill set speaks Discord, does routing, or manages sessions — consistent with every prior candidate eval: **the integration is curia's to own; the skills are the grammar that integration serves.**

## Sources

- Local install: `/home/alp/.agents/skills/*/SKILL.md` (read first-party, 2026-07-21).
- [mattpocock/skills](https://github.com/mattpocock/skills) — canonical repo; [engineering README](https://github.com/mattpocock/skills/blob/main/skills/engineering/README.md); [wayfinder doc](https://github.com/mattpocock/skills/blob/main/docs/engineering/wayfinder.md).
- [aihero.dev — v1.1 changelog](https://www.aihero.dev/skills/skills-changelog-v1-1-wayfinder-to-spec-to-tickets-grilling-improvements) and [The /wayfinder Skill](https://www.aihero.dev/skills-wayfinder) (confirmed "sandcastle" = the AI-SDK-dependency demo repo).
</content>
</invoke>

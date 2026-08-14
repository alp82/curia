# Live check: codex skill fade across turns (#340)

Ticket: [alp82/curia#340](https://github.com/alp82/curia/issues/340), on the map
[The operator sees and steers curia](https://github.com/alp82/curia/issues/244). Run on
2026-08-14 inside an agent container, against codex 0.146.0. That is the version
`config/curia.yaml` pins. No credential was needed.

Every probe seeded a throwaway `CODEX_HOME` with the daemon's own code. A short script called
`seedConfigDir`, `writeConnectionSettings` and `writePrompt` from `daemon/src/workspace.mjs`,
with `harness: 'codex'` and the vendored tree at `skills/`. So the fixture is the spawn curia
performs, not a hand-built copy of it.

## Summary

The codex invocation works. `$wayfinder` injects the whole `SKILL.md` into the session as a
user message, on the turn that names it. Measured on a real rollout file.

`wayfinder` is absent from the auto-listed skill catalog, and that is upstream's deliberate
design rather than a fault. Codex states that an unlisted skill still answers an explicit
mention, and the rollout proves it does.

The fade the ticket predicted is real and structural. The skill arrives as a user message on
turn one, and codex tells the model to drop a skill after its turn and to treat earlier user
requests as stale. How far obedience decays cannot be measured here. That needs a credential
and a long session.

## 1. Two instruments, and only one of them sees a mention

`codex debug prompt-input` renders the session context plus the raw prompt. It does **not**
resolve skill mentions. Proved by rendering four prompts against the same fixture: `x`,
`$grilling grill me`, `$wayfinder go`, and `Use the wayfinder skill`. Every render returned the
same five messages, and only the last message length changed. `$grilling` names a **listed**
skill, so a render that resolved mentions would have changed.

`codex exec` with no credential builds the whole turn, writes a rollout file, and only then
fails on a 401. The rollout is the instrument that sees the mention. This is how the checks in
sections 4 and 5 were run, and it is new: [#173](https://github.com/alp82/curia/issues/173)
had only the render.

## 2. What the model sees on turn one

Five messages. Every one carries the metadata tag `turn_id: auto-compact-0`.

| # | Role | Content | Size |
|---|---|---|---|
| 0 | developer | `<skills_instructions>` and the permissions block | 2,441 + 3,882 chars |
| 1 | developer | the multi-agent team framing | 2,183 chars |
| 2 | developer | `<multi_agent_mode>` | 271 chars |
| 3 | user | `# AGENTS.md instructions` and `<environment_context>` | 2,187 + 533 chars |
| 4 | user | `prompt.md`, the curia standing orders | 9,076 chars |

`base_instructions` for `gpt-5.6-sol` adds 17,730 characters. That model carries
`include_skills_usage_instructions: false`, so its skill protocol lives inside
`base_instructions`. This matches #173.

Curia's own load-bearing rules are message 4 alone. The bounds, the tool list, the ordered
ending and the cross-check duty are 9,076 characters of turn-one user text. `AGENTS.md`
carries the voice rules and nothing else.

## 3. Seven of the nine installed skills are listed

The seed installs nine. `<skills_instructions>` lists seven:

```
code-review, diagnosing-bugs, domain-modeling, grilling, prototype, research, tdd
```

`wayfinder` and `implement` are absent. Exactly those two carry a codex manifest at
`agents/openai.yaml` with:

```yaml
policy:
  allow_implicit_invocation: false
```

The claude frontmatter key is not the cause. `implement` still carries
`disable-model-invocation: true`, and it returns to the list as soon as the manifest changes.
That confirms #173 finding 2: codex ignores the frontmatter key.

Version 1.1.0 of the skill tree, which #173 measured on 2026-08-05, shipped no `agents/`
directory. The vendoring in [#268](https://github.com/alp82/curia/issues/268) brought the
manifest in on 2026-08-10. So the two measurements do not disagree. The tree changed.

**This is the intended state, on both sides.** Upstream states it in `.agents/invocation.md`:
a user-invoked skill is "reachable only by the human typing its name", and the pair to set is
`disable-model-invocation: true` plus `policy.allow_implicit_invocation: false`. Codex states
the same in the `skill-creator` docs it ships:

> `policy.allow_implicit_invocation`: When false, the skill is not injected into the model
> context by default, but can still be invoked explicitly via `$skill`. Defaults to true.

So the vendored bytes need no change. Curia's `$wayfinder` line is the human typing the name.

## 4. The mention resolves, and the whole skill arrives

One `codex exec` run with the prompt `$wayfinder hello`. The rollout holds, right after the
user message, a second user message of 11,867 characters:

```
<skill>
<name>wayfinder</name>
<path>/workspace/skills/wayfinder/SKILL.md</path>
---
name: wayfinder
...
</skill>
```

That is the complete `SKILL.md`, inline. The model never has to read the file. The trace also
names the resolver, `collect_explicit_skill_mentions` in `ext/skills/src/selection.rs`, and the
session ships with a `MentionsV2` feature flag.

## 5. The `$` sigil is load-bearing

The same run with the prompt `Use the wayfinder skill to do this` injected **nothing**. No
`<skill>` block reached the rollout.

For a listed skill, plain text can trigger the model's own trigger rule. For an unlisted one,
the explicit mention is the only route, and it needs the sigil. This is the measurement that
#173's operator ruling now stands on.

`config.toml` holds no lever either. A `[[skills.config]] name = "wayfinder", enabled = true`
entry does not add the skill to the list.

## 6. The two rules that make a skill fade

Both are quoted from `gpt-5.6-sol` `base_instructions` on 0.146.0.

The skill binds one turn:

> Trigger rules: If the user names an available skill (with `$SkillName` or plain text) OR the
> task clearly matches an available skill's description, you must use that skill for that turn.
> Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.

Compaction marks earlier requests stale:

> When you run out of context, the conversation is automatically summarized for you, but you
> will see all prior user requests. Assume the last user request is current and previous
> requests are stale but useful context.

Both rules land on the same place. The injected `<skill>` block is a **user message**, and so
are the standing orders. A wayfinder ticket is many turns. It blocks on `ask_human`, it blocks
on `request_review`, and a rejection sends it round again. By turn twenty the skill and the
orders are both "previous requests".

A queued operator note rides the next tool result, so it adds no user message. A line the
operator types into the pane through the timeline attach does add one.

The claude lane is not affected in the same way. `/wayfinder` is a slash command, and Claude
Code expands the whole `SKILL.md` into the first user message. The session that ran this check
is the evidence: its own prompt carries the skill body in full.

## 7. The real-dispatch record

There is almost no population to measure. The tracker names the model in every pull-request
body and every cross-check verdict.

- 75 pull requests. One names `model gpt`: [#353](https://github.com/alp82/curia/pull/353),
  for ticket [#318](https://github.com/alp82/curia/issues/318), on 2026-08-13.
- 454 issue comments. Two are cross-check verdicts on `gpt`, both on 2026-08-05.

So one codex worker session exists in the durable record since the tree changed. Its ending was
clean. It posted its own resolution comment, it closed the ticket, and curia repaired nothing.

## 8. The counter: the orders move to the durable channel

Read the routing table as a fact about today, not as a safeguard. `defaults.research` is the
only row that names `gpt`, and `fallbacks.opus` reaches it whenever opus cools. Both rows are
one edit away from putting a many-turn HITL ticket on the codex lane. The operator said so on
this ticket (2026-08-14): it is a configuration thing, and gpt may take other work later.

So the counter is not a re-injection and not a shorter leash. It is the root cause. Curia's
standing orders were conversation, exactly like the skill, and the rollout shows where the
durable channel is:

| Kind | What is in it | Lifetime |
|---|---|---|
| World state | `agents_md`, `host_skills`, `environments`, `model`, `permissions` | restated, and replaced when it changes |
| Conversation | `prompt.md`, the injected `<skill>` block, every later message | one message, then stale |

Codex's own replacement line for the first kind is "These AGENTS.md instructions replace all
previously provided AGENTS.md instructions". Nothing says that about a user message.

The change on this ticket: the bounds, the tool list, the ending and the cross-check duty move
out of `prompt.md` and into `<cfgDir>/standing.md`, which is composed into the global-memory
file the harness loads. `CLAUDE.md` on the claude lane, `AGENTS.md` on codex. `prompt.md` keeps
the parameters and one line pointing at the orders. It fell from 9,076 characters to about
1,300.

The skill is untouched. It is upstream's bytes, it loads on turn one, and #49 already ruled:
install it, do not restate it.

### pi and opencode

Neither is a harness curia runs. `HARNESS_NAMES` is `claude` and `codex`, and the two
appearances of those names in this repo are third-party surveys. So there is nothing to move
today.

The file is a row in the harness table for that reason. A lane added later must name its own
global-memory file, or it carries no orders that survive turn one, and the table is where that
has to be answered rather than discovered.

## 9. What is still unmeasured

Three things, and all three need a codex credential and a session longer than one turn. An
agent container has neither, so they belong to a dev session.

1. Whether a second `$wayfinder` on a later turn injects the block again.
2. Whether a mention inside a curia tool result resolves at all. The resolver runs over user
   input, and a tool result is not user input.
3. How far obedience decays between turn one and turn twenty, on a real ticket.

## How to re-run it

```sh
cat > /tmp/seed.mjs <<'EOF'
import { seedConfigDir, writeConnectionSettings, writePrompt, DEFAULT_SKILLS }
  from '/workspace/daemon/src/workspace.mjs'
const cfg = process.argv[2]
const skills = { root: '/workspace/skills', install: DEFAULT_SKILLS }
seedConfigDir(cfg, '/workspace', skills, 'codex', { sandboxed: false })
writeConnectionSettings({
  wtPath: '/workspace', cfgDir: cfg, agent: 'curia-340', ticket: '340',
  daemonPort: 4271, harness: 'codex', reasoningEffort: 'high',
  daemonHost: 'host.docker.internal', token: 'a'.repeat(64), skills,
})
writePrompt(cfg, { number: 340, title: 'x', body: 'Part of #244' }, {
  repo: 'alp82/curia', wtPath: '/workspace', mapNumber: 244,
  type: 'wayfinder:task', ports: [9009, 9010, 9011], harness: 'codex',
})
EOF
node /tmp/seed.mjs /tmp/ch

# the catalog, and the session context
CODEX_HOME=/tmp/ch codex debug prompt-input "$(cat /tmp/ch/prompt.md)"
CODEX_HOME=/tmp/ch codex debug models

# the mention. It fails on a 401 AFTER it writes the rollout.
CODEX_HOME=/tmp/ch codex exec --skip-git-repo-check '$wayfinder hello'
grep -l '<skill>' /tmp/ch/sessions/*/*/*/rollout-*.jsonl
```

A codex version bump owes a re-run. A skill-tree bump owes one too: the manifest that decides
section 3 lives in the tree, not in the CLI.

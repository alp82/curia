# Live check: how often a codex model re-reads a skill it triggers (#461)

Ticket: [alp82/curia#461](https://github.com/alp82/curia/issues/461), on the map
[The operator sees and steers curia](https://github.com/alp82/curia/issues/244). Counted on
2026-08-17, over a codex 0.146.0 session against the real `openai` provider. Two files are
committed beside this one: [461-codex-skill-reread.counter.mjs](461-codex-skill-reread.counter.mjs)
counts a rollout, and [461-seed-codex-session.mjs](461-seed-codex-session.mjs) makes the
session that produces one.

This check finishes [#399](https://github.com/alp82/curia/issues/399). That one bounded the
COST of a re-read at both ends and left the FREQUENCY open, because a frequency needs a real
model. Its probe drives a real codex CLI against a stub provider, so the model there obeys
nothing: it reads what the script tells it to read.

## Summary

**The model read the wayfinder skill once, on turn one, and never again across eight turns.**
It read the pointer zero times. The worst case #399 bounded at 12,299 characters per turn did
not happen, and nothing stacked.

**The read-once rule was never tested, because the model never read it.** The rule lives in the
POINTER'S BODY, and the body was never opened. What the model obeyed was the catalog
DESCRIPTION, which already ends in "Read `<target>` in full before you act on this." So the
good outcome cannot be credited to the rule. That is the finding, and section 6 says what
follows from it.

## 1. A turn is one user message

This is stated first because it changes what the ticket asks for.

Codex stamps every rollout item with a `turn_id` and writes one `turn_context` record per
turn. That record is per USER MESSAGE, not per model step. The #399 fixtures show it directly:
a three-prompt run writes three `turn_context` records, three `event_msg:user_message` records
and three `event_msg:task_started` records, while the model takes many more steps than three.

The twelve codex rollouts already on the box agree. They carry 1 to 3 turns each, in files up
to 1.1 MB. A megabyte of session is one user turn.

Codex scopes its own instruction to the same unit:

> ... you must use that skill for that turn. ... Do not carry skills across turns unless
> re-mentioned.

So the turn is the right unit to count. It also follows that **a curia dispatch cannot produce
twenty turns**. A dispatch is one prompt, plus one per escalation reply. The session counted
here is an interactive one, and it reached eight turns.

## 2. No existing rollout could have answered this

Four rounds asked the operator to copy an existing rollout, and every one failed. The finder
committed beside this file gave the reason on its first run.

Twelve rollouts sit under `<workspace root>/cfg`, across `curia-166`, `curia-318`,
`curia-review-173` and `curia-review-223`. They date from 2026-08-03 to 2026-08-13. The
pointer this ticket measures landed with #399 on 2026-08-16. **Every rollout on the box is
older than the thing being measured**, so none armed a curia pointer, and a count over any of
them would have read zero and meant nothing.

That is why the session had to be made rather than found.

## 3. What was counted

An interactive codex session, seeded by `461-seed-codex-session.mjs`, which calls
`seedConfigDir` from the daemon and writes no files of its own. The pointer under measurement
is written by `writeSkillPointers`, so a hand-made copy would have measured a file curia does
not ship.

- codex 0.146.0, the version `config/curia.yaml` pins as `sandbox.codex_version`.
- Provider `openai`, model `gpt-5.6-sol`. A real model, deciding for itself.
- Eight turns. The task was charting a wayfinder map, which the skill's description matches.
- The catalog carried `curia-wayfinder` and `curia-implement`, as a dispatch's would.

The model announced the skill on turn one:

> I will use the curia-wayfinder skill to create the new `test` map.

It then ran the wayfinder protocol through turn eight: grilling questions, then a map body
with a destination, notes and tickets. **The task still matched the skill's description on
every one of those turns**, so the re-trigger condition held throughout. That matters, because
a session that stopped matching would not have tested anything.

### The evidence committed beside this file

`461-codex-skill-reread.rollout-extract.jsonl` is the session, reduced. This repo is public
and the rollout is an operator's own transcript, so the whole file is not published here. The
extract keeps every record the count reads: the session meta, all eight `turn_context`
records, the eight user prompts, and both tool calls with their outputs. Each output body is
replaced by its own length in `X` characters, which preserves every number and publishes no
file content.

Run the counter over it and it reports the same table as the full rollout, turn for turn and
character for character. That was checked before this file was written.

```
node docs/live-checks/461-codex-skill-reread.counter.mjs \
  docs/live-checks/461-codex-skill-reread.rollout-extract.jsonl
```

The model's reasoning blobs and its own messages are dropped. The messages quoted in this
document come from the full rollout, which the operator holds.

## 4. How a read is counted

A read is counted at the TOOL CALL, because that is where the model decides to read. The
counter matches `skills/curia-<name>/SKILL.md` and `skills/<name>/SKILL.md` by path, so a
`cat`, a `sed -n` and a dedicated read tool all count the same. The `curia-` prefix is what
tells the pointer from the skill it names.

One call that names the same file twice is one read. The counter passes a self-test against
two #399 cases with known counts: three reads for the `reread` case, and zero for the
`pointer` case.

**The character columns are the whole call's output**, and a real model batches. Both reads
here came in calls that also read something else, so those figures are an upper bound per
file. Section 5 gives the true per-file sizes.

## 5. The numbers

```
codex 0.146.0, provider openai, 8 turns

| skill           | pointer reads | on turns | skill reads | on turns |
|-----------------|---------------|----------|-------------|----------|
| wayfinder       | 0             | 0/8      | 1           | 1/8      |
| grilling        | 0             | 0/8      | 1           | 1/8      |
| domain-modeling | 0             | 0/8      | 1           | 1/8      |

Read-once rule: holds — no file was read twice.
```

Every read happened on turn one, in two calls:

| call | command | output |
|---|---|---|
| 1 | `sed -n '1,240p' <cfg>/skills/wayfinder/SKILL.md && sed -n '1,200p' .claude/output-styles/literal.md` | 15,167 |
| 2 | `sed -n '1,260p' skills/grilling/SKILL.md && ... domain-modeling/SKILL.md && ... docs/agents/issue-tracker.md` | 8,922 |

So the true per-file cost of the skill read is the file itself: **11,887 characters, paid
once**. The wayfinder skill is 128 lines, so `sed -n '1,240p'` read all of it. The rest of
call 1 is `literal.md` at 3,343 bytes.

Turns 2 to 8 read nothing at all.

`grilling` and `domain-modeling` are a second-order effect rather than a pointer one. The
wayfinder skill's own text tells the model to invoke them, and it read them from the repo
checkout rather than from the config dir. They are listed here for completeness.

## 6. Does the read-once rule hold?

The pointer says:

> Read that file ONCE in a session. If you have already read it, you are still running it,
> and reading it again only repeats what you have.

Codex says the opposite, and says it on every turn:

> After deciding to use a skill, the main agent must read its `SKILL.md` completely before
> taking task actions.

**The outcome is the one curia wanted, and the rule did not produce it.**

The pointer path appears in this rollout exactly twice, and both are codex's own bookkeeping:
once in the developer message that carries the skill catalog, and once in `world_state`. It
appears in **no tool call**. The model never opened the pointer, so it never read the sentence
that tells it to read once.

What the model followed was the catalog line. `writeSkillPointers` builds the description as
the skill's own description plus `Read <target> in full before you act on this.`, and codex
puts that line in the catalog every turn. The model read the target named there, went straight
past the pointer body, and did not read anything again.

So the two questions the ticket asks answer as:

1. **The pointer is re-read zero times, and the skill once in eight turns.** Not once per turn.
2. **The rule holds in outcome and is untested in fact.** Codex's instruction did not beat it.
   Nothing beat it, because the two never met.

## 7. What follows

1. **Nothing needs fixing.** The frequency is one read per session, not one per turn. #399's
   worst case cost 12,299 characters per turn and stacked. The measured cost is 11,887
   characters, once.
2. **The read-once rule is not load-bearing here, and it is still worth keeping.** It costs
   nothing while the pointer body goes unread, and it is the only lever curia holds if a model
   ever does open the pointer.
3. **The description is the load-bearing part.** `Read <target> in full before you act on this.`
   is what the model acted on, and it reaches the model every turn at catalog cost. Anyone
   editing `writeSkillPointers` should know the description does the work, not the body.

## 8. What this check does not answer

- **One model, one session.** `gpt-5.6-sol` on codex 0.146.0. A different model may weigh
  codex's "read it completely" against the description differently.
- **Eight turns, not twenty.** The ticket asked for about twenty. Eight is enough to show the
  read is not per-turn, because a per-turn re-read would have fired seven more times. It is
  not enough to rule out a re-read that fires rarely.
- **Four of the eight prompts were short acknowledgements** ("ok", "super", "yes"). The model
  was mid-protocol on those turns, so the skill was in use, but they are weaker matches than a
  fresh task statement would be.
- **The pointer body has never been observed being read**, so the read-once rule remains
  untested by measurement rather than confirmed.

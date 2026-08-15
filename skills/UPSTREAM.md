# The vendored skill set

This tree is a copy of [mattpocock/skills](https://github.com/mattpocock/skills), the
"Skills for Real Engineers" set. It is vendored, not linked. curia owns this copy.

| | |
|---|---|
| Upstream | https://github.com/mattpocock/skills |
| Release | `v1.2.3` |
| Commit | `835450ef244ab7335f75d95b83e7d979eae22a6d` |
| Vendored | 2026-08-10, by [Matt's skills move to 1.2](https://github.com/alp82/curia/issues/268) |
| License | MIT. `LICENSE` beside this file is upstream's own. |

## Why a copy

The set used to live in the operator's home directory, at `~/.agents/skills`, reached
through `~/.claude/skills`. That put it outside every write bound curia has, so no agent
could read it as a diff and no agent could change it. Three costs followed.

1. An upgrade was invisible. `prototype` had drifted from its release and nobody knew.
2. An upgrade was unreviewable. Version 1.2 turns `grilling` round-by-round, which
   contradicts [ADR-0005](../docs/adr/0005-escalation-contract.md). An automatic update
   ships that change without a word.
3. The daemon read a path that only one machine carries.

A vendored tree answers all three. An upgrade is a pull request, the review gate reads
it, and every reader gets the same bytes.

## The layout is flat

`skills/<name>/SKILL.md`, one directory per skill. Upstream sorts skills into buckets
(`engineering/`, `productivity/`). Those buckets do not survive the copy, because
`installSkills` joins the root and the bare skill name (`daemon/src/workspace.mjs`).

Each skill keeps its own disclosed files: `agents/openai.yaml` for the Codex harness,
plus any reference pages the skill points at.

## Who reads this tree

- **Agents.** `config/curia.yaml` sets `skills.root: ../skills`. The daemon copies the
  names in `skills.install` into each agent's config dir at spawn.
- **A hand session.** Point `~/.claude/skills` at this directory.

`skills.install` is what bounds an agent, not this tree. The tree carries all 25 promoted
skills so that a hand session reads the same copy. The four skills [#49](https://github.com/alp82/curia/issues/49)
withholds stay withheld, because they are not in that list. `wizard` is withheld with them
([#348](https://github.com/alp82/curia/issues/348)): it writes an interactive bash script
for a human at a terminal, and a `wayfinder:task` ticket hands its checklist to a phone
through `ask_human`. `writing-for-agents` is in the list, because an agent here edits
agent-facing prose often.

## How to bump the release

1. Read the upstream release notes for every version between the pinned one and the new
   one. A skill is prose an agent obeys, so a reworded paragraph is a behavior change.
2. Download the new release and replace the directories this tree names:

   ```
   gh api repos/mattpocock/skills/tarball/<tag> | tar -xz
   ```

   Take only the skills in upstream's `.claude-plugin/plugin.json`, and flatten them.
3. Update the table at the top of this file.
4. Read the diff for anything that contradicts an ADR. Version 1.2 held two such
   changes, and both are recorded in
   [the skill-set survey](../docs/research/matt-pocock-skills.md).
5. Open a pull request. The diff is the point of this tree.

Do not install the set a second way. The Claude Code plugin
(`claude plugins install mattpocock-skills`) lands under `<config dir>/plugins/`, which
`installSkills` never reads, and upstream warns that two installs leave every skill
twice.

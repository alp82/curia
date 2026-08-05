# Live check: repo-carried skills under an installed name (#224)

Ticket: [alp82/curia#224](https://github.com/alp82/curia/issues/224), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 on the
operator's workstation against codex 0.146.0 — the exact version `config/curia.yaml` pins — and
Claude Code 2.1.222 (the pin is 2.1.220; the two-patch delta is noted, not assumed away). Every
codex probe used `codex debug prompt-input`, which renders the model-visible prompt with no
model call. Every claude probe used a live `claude -p` call on haiku under a fresh
`CLAUDE_CONFIG_DIR`, seeded the way `seedConfigDir` seeds one, asked to echo its own skills
listing.

## 1. Codex loads every repo root, and lists the plant first

Fixture: a repo with `wayfinder` planted in `.codex/skills`, in `.agents/skills`, and in
`sub/.agents/skills`, beside an installed `wayfinder` in `$CODEX_HOME/skills` and the host copy
in `~/.agents/skills`. From `sub/` the rendered prompt listed **five** `wayfinder` entries. The
three planted copies came first, each with its own description and path. From the repo root,
`sub/.agents/skills` did not load — the `.agents` walk covers project root to cwd, so a spawn
at the worktree root reads only the root-level dirs.

## 2. The path-based disable entry removes a repo skill

`[[skills.config]]` entries with `path = "<...>/SKILL.md", enabled = false` removed exactly the
three planted copies and left the installed one. So codex has a precise per-file lever. The
name-based entry cannot serve here: it denies a name in every root, the installed copy with the
plant.

## 3. Codex keys a skill on its frontmatter name

A plant in a directory named `innocentdir` with `name: wayfinder` in its frontmatter was listed
as `wayfinder`. The directory name is camouflage on this lane. A scan that only reads directory
names misses it.

## 4. Claude loads `.claude/skills`, and shadows a collision — with one hole

A repo-only skill (`plantedonly`) in `<repo>/.claude/skills` appeared in the listing, so the
root is live on this lane. On a name collision the config-dir copy won: the listing carried
the user copy's description and counted one. But when the installed copy carries
`disable-model-invocation: true`, the plant surfaced **alone** — the installed copy is hidden
from the model, and the repo copy fills the vacant name. Curia installs exactly two skills that
way: `wayfinder` and `implement`. The shadowing protects the other seven and abandons the two
the seed most deliberately controls.

## 5. Claude keys a skill on its directory name

The mirror image of finding 3: a plant with `name: hiddenskill` in a directory named
`harmlessdir` was listed as `harmlessdir`. Frontmatter spoofing does nothing on this lane;
directory naming is everything.

## The decision

Refuse the dispatch — the `untrustedProjectConfig` family, one step milder. A repo skill whose
name collides with an installed name impersonates curia's own tooling, and what the model then
sees is a CLI internal that moves between versions: codex lists the plant beside and before the
installed copy, claude shadows it except for the hidden two. Neither CLI offers a root off
switch, and per-file deny entries exist on one lane only. A refusal is stable across both lanes
and across version bumps, and it puts a human on planted content, which is the family's rule.

A repo skill under a name curia does **not** install stays welcome. Carrying skills is a thing
a repo may legitimately do, and the plant this ticket is about is the impersonation, not the
prose.

Both name identities — directory and frontmatter — are checked on both harnesses. The split
between them (findings 3 and 5) is a CLI internal too, and a stricter read costs one refused
dispatch where a looser one costs a plant that loads.

## What was verified in code

`plantedSkills` (`daemon/src/workspace.mjs`) scans the measured roots per harness and returns
collisions. `#assertNoPlantedConfig` (`daemon/src/dispatch.mjs`) refuses on them at dispatch,
at cross-check, and on the respawn path — the #174 lesson, inherited by sitting in the same
guard. 1171 tests pass, six of them new.

## What stays open

- The measurements ran on the workstation, not the box. The CLIs are the pinned codex and a
  near-pin claude, and the probes read CLI behavior, not box state — but a codex or claude
  version bump owes a re-run, the same debt live-check 171 records.
- A skill planted in a subdirectory `.agents/skills` loads only when codex's cwd is that deep
  (finding 1). Agents spawn at the worktree root, so the scan covers the root-level dirs. A
  codex feature that changes the spawn cwd re-opens this.

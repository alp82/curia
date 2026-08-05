# Live check: the codex skill roots (#171)

Ticket: [alp82/curia#171](https://github.com/alp82/curia/issues/171), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 on the box,
`coinmatica.net`, against codex 0.146.0 — the version `config/curia.yaml` pins — with the
operator's credentials in place. Every probe used `codex debug prompt-input`, which renders the
model-visible prompt with no model call, under a throwaway `CODEX_HOME` seeded with a symlink to
`~/.codex/auth.json`.

## 1. CODEX_HOME does not bound skills

A fresh `CODEX_HOME` held exactly one skill, `only-one`. The rendered prompt listed `only-one`
plus all 25 skills under `/home/alp/.agents/skills` — the four #57 excludes (`to-tickets`,
`triage`, `to-spec`, `handoff`) among them. This reproduces what the curia-70 worker transcript
showed (gap 1 of `docs/research/codex-lane-gaps.md`).

The source names the roots. At `rust-v0.146.0`, `codex-rs/core-skills/src/loader.rs`
(`skill_roots_from_layer_stack_inner`) pushes, for the user config layer:

1. `$CODEX_HOME/skills` — commented "deprecated user skills location, kept for backward
   compatibility". This is the root curia's `installSkills` fills.
2. `$HOME/.agents/skills` — unconditional, resolved from `home_dir()`, so `CODEX_HOME` never
   touches it.
3. `$CODEX_HOME/skills/.system` — the embedded bundled skills, re-planted on every start.

It also pushes `/etc/codex/skills` for the system config layer, `<project config dir>/skills`
for a project layer, and `.agents/skills` in every directory between the project root and the
cwd (`repo_agents_skill_roots`). Skills load by path with symlinks canonicalised, so the nine
installed symlinks dedupe against their host-root targets.

## 2. No root off switch exists, so the bound is a deny list

The config schema (`codex-rs/core/config.schema.json`) has no key that removes the
`$HOME/.agents/skills` root on 0.146. It has two levers, both verified live:

- `[[skills.config]]` entries with `{ name | path, enabled }`. A `name = "to-tickets",
  enabled = false` entry removed the skill from the rendered prompt. A `path` entry naming a
  `SKILL.md` did the same. Matching is exact (`resolve_disabled_skill_paths` in
  `core-skills/src/config_rules.rs`), name entries resolve against every root.
- `skills.bundled = { enabled = false }`. This removed the `.system` root from the prompt AND
  deleted `<CODEX_HOME>/skills/.system` from disk (`uninstall_system_skills`).

The full rehearsal used the daemon's exact shape: nine skills symlinked into
`$CODEX_HOME/skills`, one disable entry per host skill outside the install list, bundled off.
The rendered prompt listed exactly the nine.

The trap is #172's: codex ignores an unknown config key in silence, so a rename upstream turns
the whole bound into a no-op that reads like a bound lane. The unit tests pin the string the
daemon writes; this live read is the other half of the guard, and a codex version bump owes a
re-run.

## 3. The claude harness is bounded — measured, not assumed

The gap inventory called the claude side "absence of evidence". Now measured: with
`CLAUDE_CONFIG_DIR` pointing at a fresh config dir holding one skill, a live `claude -p` call
asked the model to echo its available-skills listing. It returned `only-one` plus Claude Code's
own built-ins (`dataviz`, `update-config`, `keybindings-help`, `simplify`,
`fewer-permission-prompts`, `loop`, `schedule`, `claude-api`, `run`, `init`, `review`,
`security-review`) — no host skill, none of the #57 excludes. `CLAUDE_CONFIG_DIR` bounds the
user skill root on the claude lane. The built-ins are harness features, none of them installs
further skills, and no config key removes them; they stay.

## 4. What stays open

- A skill added to `$HOME/.agents/skills` after an agent is armed leaks to that agent until the
  next arm. Accepted: the deny list is computed per arm, and the alternative is a watcher on
  the operator's own skill tree.
- Repo-carried skill roots: codex loads `<repo>/.codex/skills` and `.agents/skills` between
  project root and cwd; a name-denied skill stays denied there too, but a repo skill under an
  INSTALLED name (for example a planted `wayfinder`) would load. That is a planted-content
  surface in the same family as `untrustedProjectConfig`, and it is its own ticket.

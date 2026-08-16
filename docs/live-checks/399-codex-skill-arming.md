# Live check: what arms a skill on codex, and what it costs (#399)

Ticket: [alp82/curia#399](https://github.com/alp82/curia/issues/399), on the map
[The operator sees and steers curia](https://github.com/alp82/curia/issues/244). Run on
2026-08-16 inside an agent container, against codex 0.146.0. That is the version
`config/curia.yaml` pins. No codex credential was used.

This check continues [#360](https://github.com/alp82/curia/issues/360), which closed every
cheap way to re-arm a skill and left the stable one to find. The probe is committed beside
this file: [399-codex-skill-arming.probe.mjs](399-codex-skill-arming.probe.mjs).

## Summary

**A listed skill never pastes its body.** The catalog entry is one line of name, description
and path, in a developer message, byte-identical on every turn. The 11,867-character
`<skill>` block reaches the model from one place only: a `$name` mention in a user message.
Listing a skill does not change that, and a listed skill that the task matches carries no
block at all.

So the question the ticket called untested is answered, for the CLI half. Whatever lists
`wayfinder` costs about 270 characters per turn and no body. The duplication does not return
by that door.

**`config.toml` holds no additive lever, and it now has a control.** `enabled = false`
removes a listed skill. `enabled = true` does not add an unlisted one.
`allow_implicit_invocation` is a manifest field, and codex ignores it in `config.toml`.

**Curia can own a listed skill without patching one byte upstream.** A skill directory with
no `agents/openai.yaml` is listed by default. Curia already writes files into the agent
config dir at seed time, so it can write that directory too.

One half stays out of reach here, and it is a MODEL behavior rather than a CLI one. Codex
tells the model to read a skill's `SKILL.md` completely each time it decides to use it. How
often a real model re-reads is section 5.

## The instrument

[#360](https://github.com/alp82/curia/issues/360)'s: a local stub of the Responses API behind
`-c model_provider=fake`. A real `codex exec` runs a real multi-turn session against it, with
no credential anywhere, and every request body is written to disk. The input list the model
would have read is the reading.

The fixture is curia's own spawn. The probe calls `seedConfigDir`, `writeConnectionSettings`
and `writePrompt` from `daemon/src/workspace.mjs`, with `harness: 'codex'` and the vendored
tree at `skills/`.

#360 described its stub in prose and committed no code, so this ticket rebuilt it from the
description. The probe is committed for that reason. A codex version bump owes a re-run, and
a re-run should not start at a blank page.

## 1. The control: a mention, and what it costs after it

`$wayfinder` on turn one, nothing on the two turns after it.

| turn | input items | user msgs | `<skill>` blocks | body chars | catalog chars | input chars |
|---|---|---|---|---|---|---|
| 1 | 8 | 3 | 1 | 11,867 | 2,621 | 46,682 |
| 2 | 10 | 4 | 1 | 11,867 | 2,621 | 46,704 |
| 3 | 12 | 5 | 1 | 11,867 | 2,621 | 46,716 |

The block arrives once and stays. It is never restated and never removed. #360 measured the
other half of this: a SECOND mention adds a second copy and keeps the first.

## 2. A listed skill pastes no body

The route the operator rejected on 2026-08-16, measured for the question it left open. A
patched copy of the tree carries `policy.allow_implicit_invocation: true`. The checkout is
never written to.

| turn | prompt | `<skill>` blocks | body chars | catalog chars | wayfinder entry | input chars |
|---|---|---|---|---|---|---|
| 1 | `chart a map for the new effort` | 0 | 0 | 3,023 | 273 | 35,207 |
| 2 | `$wayfinder go` | 1 | 11,884 | 3,023 | 273 | 47,106 |
| 3 | `continue charting` | 1 | 11,884 | 3,023 | 273 | 47,125 |

Three readings:

1. **Turn one carries no body**, on a prompt that matches the skill's own description word
   for word. Listing arms the trigger. It injects nothing.
2. **The mention still resolves for a listed skill.** Turn two adds the block, exactly as it
   does for an unlisted one. The mention is the injector, and listing does not replace it.
3. **The entry is world state.** 273 characters, byte-identical on all three turns, in the
   `<skills_instructions>` developer message.

The entry is `- <name>: <description> (file: <path>)`, so its length follows the description
and the path. The 273 above holds for the probe's own paths. #360 measured 257 for the same
entry under the checkout path.

## 3. `config.toml` has no additive lever

Rendered with `codex debug prompt-input`, which answers a catalog question without a model.
The `grilling` column is the control: without it, an entry codex ignores and an entry codex
never read look the same.

| `[[skills.config]]` entry | wayfinder listed | grilling listed | codex |
|---|---|---|---|
| (none) | no | yes | rendered |
| `name = "grilling"`, `enabled = false` | no | **no** | rendered |
| `name = "wayfinder"`, `enabled = true` | no | yes | rendered |
| `name = "wayfinder"`, `enabled = true`, `allow_implicit_invocation = true` | no | yes | rendered |
| `name = "wayfinder"`, `allow_implicit_invocation = true` | — | — | **refused**: missing field `enabled` |

Row 2 is the control and it passes: the entry is read, and `enabled = false` takes a skill
off the list. That is the lever curia already uses for the [#171](https://github.com/alp82/curia/issues/171)
deny list.

Rows 3 and 4 close [#340](https://github.com/alp82/curia/issues/340)'s question with a
control behind it. The list is SUBTRACTIVE. An entry cannot add a skill the manifest hides,
and `allow_implicit_invocation` in `config.toml` changes nothing.

Row 5 is a trap worth stating, because curia writes these entries itself. `enabled` is a
REQUIRED field. An entry without it is a hard config error, and codex renders nothing at all.
Curia is safe today, because `codexSkillDenyList` always writes `enabled = false`. A future
entry that forgets it takes the whole agent down at startup.

The binary agrees with the readings. `SkillConfig` carries three fields, and its own refusals
name them: an entry needs a `path` or a `name` selector, never both, plus `enabled`. There is
no fourth field to reach for. `allow_implicit_invocation` appears only in the `openai.yaml`
manifest schema, beside `interface`, `dependencies` and `policy`.

## 4. Curia can own a listed skill, and patch nothing

A skill needs no manifest to be listed. `allow_implicit_invocation` defaults to true, so a
directory with a `SKILL.md` and no `agents/openai.yaml` is on the list.

The probe writes one into the agent config dir, beside the `standing.md` curia already writes
there:

```
<cfgDir>/skills/curia-wayfinder/SKILL.md
```

Its description names the dispatch and points at the installed `wayfinder` SKILL.md. Its body
does the same in one sentence. It restates no rule.

| turn | prompt | `<skill>` blocks | catalog chars | pointer entry | input chars |
|---|---|---|---|---|---|
| 1 | `$wayfinder hello` | 1 | 2,892 | 270 | 46,953 |
| 2 | `turn two, no mention` | 1 | 2,892 | 270 | 46,975 |

270 characters per turn, byte-identical, and no body of its own. The vendored tree is
untouched, so a skill-tree update cannot break it in silence. That is the property the
patched manifest lacked.

The entry survives curia's own bounds. `codexSkillDenyList` denies names the HOST root
carries that the seed did not install, and a generated name is in neither, so nothing denies
it.

## 5. What a credential would still answer

The CLI half is settled: no catalog mechanism pastes a body. The model half is not, and it is
a different question from the one the ticket asked.

Codex states the protocol in `base_instructions`, which is world state and reaches the model
on every turn:

> Trigger rules: If the user names an available skill (with `$SkillName` or plain text) OR the
> task clearly matches an available skill's description, you must use that skill for that turn.
> Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.

> After deciding to use a skill, the main agent must read its `SKILL.md` completely before
> taking task actions.

Read together, those two put the re-arm and the cost in the same place. A listed skill
re-triggers on every turn the task matches, because its description never goes stale. And
each trigger tells the model to read the file completely. A model that obeys both literally
puts 11,867 characters into a tool result every turn, which is #360's duplication under
another name.

A pointer is what bounds that. The model re-reads the file the catalog names, so a short
pointer costs a short read, and the full skill is read when the model reaches for it rather
than on every turn.

How often a real model actually re-reads needs a credential and a long session. The stub
cannot answer it, because there is no model behind it to obey anything.

## How to re-run it

```sh
node docs/live-checks/399-codex-skill-arming.probe.mjs all
```

Cases: `mention`, `flip`, `pointer`, `lever`. Each writes its request bodies under
`/tmp/curia-399-arm/<case>/`, so a number in this file can be read back off the wire.

A codex version bump owes a re-run. Section 3 depends on the config schema and section 5
quotes `base_instructions`, and both live in the CLI. A skill-tree bump owes one too: the
manifest that decides section 2 lives in the tree.

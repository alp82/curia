# Live check: how a codex agent loads a skill (#173)

Ticket: [alp82/curia#173](https://github.com/alp82/curia/issues/173), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 inside the agent
image, against codex 0.146.0 — the version `config/curia.yaml` pins. No credential was needed:
`codex debug prompt-input` renders the model-visible input list with no model call, and
`codex debug models` prints the model catalog the CLI ships with.

Every probe used a throwaway `CODEX_HOME` under the session scratchpad, holding one skill: a
dereferenced copy of the agent's own `wayfinder`. Nothing else wrote.

## 1. The claude invocation does not travel

The first line of `prompt.md` reached the model as plain user text:

```json
{ "role": "user", "content": [{ "type": "input_text",
  "text": "/wayfinder https://github.com/alp82/curia/issues/147 ticket #173" }] }
```

Nothing expanded it. This reproduces gap 4 of `docs/research/codex-lane-gaps.md` on the pinned
version, from the code path curia actually spawns.

## 2. Codex lists the skill, and `disable-model-invocation` does not travel either

The same render carried a developer message that names every installed skill:

```
<skills_instructions>
## Skills
...
- wayfinder: Plan a huge chunk of work — more than one agent session can hold — as a shared map of
  investigation tickets on your issue tracker, ... (file: <CODEX_HOME>/skills/wayfinder/SKILL.md)
</skills_instructions>
```

`wayfinder` carries `disable-model-invocation: true`, which hides it from the model on the claude
lane. Codex ignores the key: the skill is listed with its description and its path.

## 3. The trigger rule reaches every codex model, by two routes

Codex states its skill protocol in one of two places, and the model catalog picks which:

- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` carry `include_skills_usage_instructions: false`
  and a `# Using skills` section inside `base_instructions` (17,730 characters).
- `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2` and `codex-auto-review` carry
  `include_skills_usage_instructions: true`, and the CLI appends a `### How to use skills` block
  to the skills developer message above. Verified by rendering the same prompt under
  `-c model=gpt-5.5`.

The two texts are complementary, so the protocol is always present. Both state the same two rules:

- **Trigger**: "If the user names an available skill (with `$SkillName` or plain text) OR the task
  clearly matches an available skill's description, you must use that skill for that turn."
- **Load**: "the main agent must read its `SKILL.md` completely before taking task actions."

`gpt-5.6-sol` is the model curia's `gpt` label spawns, so the first route is the live one.

## 4. The rule that decides the design: a skill is scoped to one turn

Both texts also say:

> Do not carry skills across turns unless re-mentioned.

A wayfinder ticket is many turns. It blocks on `ask_human`, it blocks on `request_review`, and a
rejection sends it round again. So a named skill binds the turn that named it, and codex states no
promise about the twentieth turn.

## 5. `$CODEX_HOME/AGENTS.md` is loaded

Curia copies the operator's voice rules to `<cfgDir>/AGENTS.md` for this harness
(`seedConfigDir`). A marker line in that file appeared in the rendered prompt, so the copy reaches
the model.

## 6. What curia now writes, checked end to end

Operator ruling on this ticket (2026-08-05): the codex-native invocation, not the skill text
inlined in the prompt. `writePrompt` takes the harness and spells one line two ways. Everything
after the sigil is identical, so two prompts read as one document.

The last probe used the daemon's own code and the daemon's own spawn template. `writePrompt` wrote
`prompt.md` with `harness: 'codex'`, and the render read it the way `config/routing.yaml` does:

```sh
CODEX_HOME=<throwaway> codex debug prompt-input "$(cat prompt.md)"
```

The model-visible user message starts with:

```
$wayfinder https://github.com/alp82/curia/issues/147 ticket #173
```

The sigil survives. A command substitution's output is never rescanned, so the shell reads
`$wayfinder` as ten characters and expands nothing. The same render lists `wayfinder` in the skills
message, which is the list the trigger rule resolves against.

## How to re-run it

```sh
mkdir -p /tmp/ch/skills && cp -rL <skills root>/wayfinder /tmp/ch/skills/
CODEX_HOME=/tmp/ch codex debug prompt-input "/wayfinder <map url> ticket #<n>"
CODEX_HOME=/tmp/ch codex debug prompt-input -c model=gpt-5.5 "x"
CODEX_HOME=/tmp/ch codex debug models
```

A codex version bump owes a re-run: the trigger rule lives in text the CLI ships, and the model
catalog decides which copy a model gets.

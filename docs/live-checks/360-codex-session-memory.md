# Live check: what a codex session keeps after turn one (#360)

Ticket: [alp82/curia#360](https://github.com/alp82/curia/issues/360), on the map
[The operator sees and steers curia](https://github.com/alp82/curia/issues/244). Run on
2026-08-16 inside an agent container, against codex 0.146.0. That is the version
`config/curia.yaml` pins. No codex credential was available.

This check continues [#340](https://github.com/alp82/curia/issues/340), which left three
questions open. It answers two of them. The operator ruled the third out of scope, because the
first two settle the decision it was meant to inform.

## Summary

A re-mention works, and it is the wrong counter. `$wayfinder` on turn two injects the whole
skill a second time. The second copy does not replace the first. Both sit in the context
together, so a re-mention adds 11,867 characters and frees nothing.

A mention resolves in one channel only: a fresh user message. A mention inside a tool result
does not resolve. A mention inside `AGENTS.md` does not resolve either. So the pane send is
the only channel curia owns, exactly as the ticket predicted.

Together those two close re-injection as an option. The operator rejected it on 2026-08-16 and
named the direction instead: fix the embedding and the invocation, so the skill stops being
conversation. Section 4 prices the durable channel and states why the one-flag route is not
that fix.

Obedience decay over twenty turns stays unmeasured, and the operator ruled the number
unnecessary. See section 3.

## The instrument: a stub Responses API

[#340](https://github.com/alp82/curia/issues/340) read the rollout file that `codex exec`
writes before it fails on a 401. That instrument answers question 1, because the mention
resolver runs before the request. It cannot answer question 2, because a tool result needs a
model turn, and a 401 never produces one.

So this check adds a second instrument. `codex exec` accepts a model provider override, and
the provider can be a local server:

```sh
codex exec \
  -c model_providers.fake.name=fake \
  -c model_providers.fake.base_url=http://127.0.0.1:8899/v1 \
  -c model_providers.fake.wire_api=responses \
  -c model_providers.fake.env_key=FAKE_KEY \
  -c model_provider=fake \
  '<prompt>'
```

The server answers the Responses wire protocol with three server-sent events:
`response.created`, `response.output_item.done` and `response.completed`. It writes every
request body to disk. That gives the exact input list the model would have seen, turn after
turn, with no credential and no cost.

`wire_api = "chat"` is refused on 0.146.0. The CLI names the fix in the error, and it is
`responses`.

The fixture is the same one #340 used. A short script calls `seedConfigDir`,
`writeConnectionSettings` and `writePrompt` from `daemon/src/workspace.mjs`, with
`harness: 'codex'` and the vendored tree at `skills/`. So the seed is curia's own spawn.

## 1. A second mention injects the whole skill again, and stacks

Measured two ways, and both agree.

The rollout, with no credential, after `codex exec '$wayfinder hello'` then
`codex exec resume --last '$wayfinder again'`:

| Item | Role | Content | Size |
|---|---|---|---|
| 8 | user | `$wayfinder hello` | 16 |
| 10 | user | `<skill>` block | 11,867 |
| 15 | user | `$wayfinder again` | 16 |
| 17 | user | `<skill>` block | 11,867 |

The two blocks are byte-identical. Both hash to `c7fb8087f103a7e2`.

The stub API shows the cost, because it sees the input list the model reads. A three-turn
session, mention on turns one and two, no mention on turn three:

| Turn | Input items | User messages | `<skill>` blocks | Input size |
|---|---|---|---|---|
| 1 | 8 | 3 | 1 | 70,748 |
| 2 | 13 | 5 | 2 | 83,851 |
| 3 | 15 | 6 | 2 | 84,120 |

The turn-two input carries **both** copies, at item 7 and item 12. The re-mention costs
13,103 characters of input growth, and the old copy stays.

**So re-injection defeats itself.** It buys turn-level priority by growing the context, and a
grown context is what forces the compaction that makes the orders stale. Twenty re-mentions
would add about 237,000 characters of duplicated skill text. The counter would cause the
failure it exists to prevent.

## 2. Only a fresh user message resolves a mention

Three runs against the stub, one channel each.

| Channel | Where the `$wayfinder` text sat | `<skill>` block appeared |
|---|---|---|
| User message | the prompt | **yes** |
| Tool result | the `custom_tool_call_output` | no |
| Global memory | `AGENTS.md` | no |

The user-message run is the control. Without it, an absent block proves nothing about the rig.

The tool-result run drove the model to call `exec`, the tool that carries every nested call on
0.146.0. Curia's own tools reach the model through it, as `tools.mcp__curia__ask_human` and
its siblings, so an `exec` result is the same item type a curia tool result becomes. The
output reached the model intact:

```json
{"type": "custom_tool_call_output", "output": [
  {"type": "input_text", "text": "Script completed\nWall time 0.0 seconds\nOutput:\n"},
  {"type": "input_text", "text": "$wayfinder please re-read the skill"}]}
```

The next request carried that text and no `<skill>` block.

**This confirms the ticket's own reading.** The resolver runs over user input. A tool result is
not user input, and neither is a global-memory file. A queued operator note rides a tool
result, so it cannot re-arm a skill. The timeline pane send is the only channel curia owns
that can.

## 3. Obedience decay is not measured, and the operator ruled it unnecessary

Not measured. It needs a codex credential and a session of about twenty turns on a real
ticket. An agent container has no credential: `seedConfigDir` copies the host's
`~/.codex/auth.json` into the config dir, and a container mounts no host home, so the file
does not exist. The stub API cannot stand in, because there is no model behind it to obey or
disobey anything.

The durable record cannot stand in either. The tracker names the model in every pull-request
body. 92 pull requests carry seven that name `gpt`, and only
[#353](https://github.com/alp82/curia/pull/353) ran after the skill tree changed on
2026-08-10. That is the same population of one that #340 found. It did not grow.

**The operator ruled the measurement unnecessary (2026-08-16).** The decay number existed to
decide whether re-injection was worth its price. Section 1 settles that on its own, because a
re-mention duplicates the skill and pollutes the context. The operator rejected that outright,
so the number would decide nothing. The question is out of scope, not open.

## 4. The catalog lever exists, and it is not a stable fix

Section 2 leaves the pane send as curia's only channel, and section 1 prices a re-mention out
of reach. So the remaining direction is to stop the skill from being conversation at all. The
operator named it on 2026-08-16: fix the embedding and the invocation.

Codex lists the skills it can see in a **developer** message. That message is world state. The
model reads it on every turn, and no compaction rule calls it stale. `wayfinder` is absent from
that list because the vendored tree carries this:

```yaml
# skills/wayfinder/agents/openai.yaml
policy:
  allow_implicit_invocation: false
```

Flipping the flag to `true` puts `wayfinder` in the list. Measured against the stub with a
patched copy of the tree:

| | Cost | Channel | Restated each turn |
|---|---|---|---|
| `$wayfinder` mention | 11,867 chars, stacking | user message | no |
| Catalog entry | 257 chars | developer message | yes |

The catalog entry carries the name, the description and the file path. No `<skill>` block
reaches the input, so listing a skill does not inject its body.

**The operator rejected the flip (2026-08-16).** Patching a vendored manifest, either in the
tree or in curia's per-agent copy, is a monkey patch. It is brittle, and a skill-tree update
breaks it silently. The measurement stands as evidence of what the durable channel costs. It
is not the fix.

Two facts bound whatever the stable fix turns out to be. `allow_implicit_invocation: false` is
upstream's deliberate pair to `disable-model-invocation: true`, so any fix disagrees with
upstream on purpose or asks upstream for a lever. And listing a skill only re-arms the trigger.
Whether codex then pastes the whole body on every turn it triggers is untested here, and it
needs a credential. If it does, the duplication returns by another door.

## 5. What this check did not settle about the #340 counter

#340 moved the standing orders into `AGENTS.md` because codex holds that file as world state.
This check confirms the first half and leaves the second half open.

Confirmed: the rollout carries a `world_state` record whose `state.agents_md.text` holds the
voice rules and the standing orders in full. The seeded `AGENTS.md` is 10,398 characters,
against 1,375 for `prompt.md`.

Open: `AGENTS.md` reaches the model as a **user message** at the head of the input, not as a
separate durable channel. Across three turns it stayed at that position and codex never
re-emitted it. Whether codex restates it after a compaction is the untested part, and it is
untestable here for the same reason as section 3. A compaction needs a real model.

So the counter rests on a behavior this check could observe at rest and not under load. That
belongs with the decay question, not with this one.

## 6. How to re-run it

Seed the fixture as #340 documents, then start the stub and point codex at it:

1. Write the stub server. It must answer `POST /v1/responses` with `response.created`,
   `response.output_item.done` and `response.completed`, and log every request body.
2. Seed a throwaway `CODEX_HOME` with `seedConfigDir`, `writeConnectionSettings` and
   `writePrompt`.
3. Run `codex exec` with the five `-c` overrides above. Close stdin with `</dev/null`, or the
   CLI waits on it and never returns.
4. Resume with `codex exec resume --last` for each later turn.
5. Count `<skill>` blocks in each captured request body.

A codex version bump owes a re-run. The tool surface moved between versions, and section 2
depends on it: `shell` is not a callable tool name on 0.146.0, and a call to it returns
`unsupported call: shell`.

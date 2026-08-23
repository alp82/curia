# The codex skill catalog survives a compaction (#577)

Ticket: [alp82/curia#577](https://github.com/alp82/curia/issues/577), on the map
[The UX map](https://github.com/alp82/curia/issues/511). Measured on 2026-08-22 inside an
agent container, against codex 0.146.0. That is the version `config/curia.yaml` pins. No
codex credential was used. The probe is committed beside this file:
[probe.mjs](probe.mjs). The demo is [demo.html](demo.html).

## Summary

**The catalog survives every compaction, byte for byte.** Three compactions in the main
case and eight in the stress case, and the `<skills_instructions>` developer message is
byte-identical on every request of each session. Both pointer entries, `curia-wayfinder`
and `curia-implement`, are listed on every request.

**The standing orders survive with it.** The `# AGENTS.md instructions` user message rides
through every compaction at its full 14,138 characters.

**The reason is structural, and the probe read it off the wire.** Codex rebuilds its
developer prefix fresh on every request. The catalog is world state, not conversation.
A compaction cuts conversation only: every assistant message, tool call, and tool result
between the first user message and the newest one. The first user message stays verbatim,
a summary bridge replaces the cut middle, and the prefix and the AGENTS.md message come
back untouched.

So the #399 mechanism holds under the load it was never observed under. The pointer
re-arms on every turn, before and after any number of compactions, and nothing has to be
rethought.

## The instrument

The rig is #399's: a local stub of the Responses API behind `-c model_provider=fake`.
A real `codex exec` runs a real multi-turn session against it, with no credential, and
every request body is written to disk. The input list the model would have read is the
reading.

The load is new, and it needs two levers:

1. **The stub reports the `usage` codex trusts.** It estimates the serialized input at
   four characters per token and reports that as `input_tokens`. Codex takes the
   provider's count for its context accounting.
2. **`model_auto_compact_token_limit` is a plain config override.** The probe passes it
   with `-c`, so the session crosses the limit without a real 200,000-token transcript.

A compaction is recognized on the wire by codex's own instruction text, "You are
performing a CONTEXT CHECKPOINT COMPACTION", never assumed from timing. The rollout
corroborates the wire: the stress case shows eight `compacted` records and eight
`context_compacted` events for its eight compaction requests.

For real bulk, the scripted model reads a 40,000-character fixture file once per turn,
through the same `exec` mechanics as #399's reread case. The transcript then carries
weight a compaction can visibly cut, and the cut shows as a number.

## 1. The control: the rig at rest

No limit, three turns. This is #399 section 5 re-taken on the same rig as the load cases,
so the compaction rows have a baseline.

| req | turn | kind | catalog chars | pointer entries | catalog same as req 1 | AGENTS.md chars | read chars | input chars |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | turn | 7,441 | both | yes | 14,135 | 0 | 42,534 |
| 2 | 2 | turn | 7,441 | both | yes | 14,135 | 0 | 42,556 |
| 3 | 3 | turn | 7,441 | both | yes | 14,135 | 0 | 42,580 |

The catalog is larger than #399 measured (7,441 characters against 3,246) because the
seed installs more skills now. Within a session it is byte-identical, which is the
property under test. Catalog size differs a few bytes between cases because the entry
carries the case directory in its path.

## 2. The reading: growth, compaction, growth again

Limit 30,000 tokens. The developer prefix alone is about 13,000 tokens by the stub's
count, and each turn adds a 40,000-character read, about 10,000 tokens. So the session
grows for two turns, crosses the limit, compacts, and grows again. Six turns, three full
cycles.

| req | turn | kind | catalog chars | catalog same as req 1 | AGENTS.md chars | summary chars | read chars | input chars |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | turn | 7,525 | yes | 14,138 | 0 | 0 | 42,627 |
| 2 | 1 | turn | 7,525 | yes | 14,138 | 0 | 40,232 | 82,859 |
| 3 | 2 | turn | 7,525 | yes | 14,138 | 0 | 40,232 | 82,881 |
| 4 | 2 | **compaction** | 7,525 | yes | 14,138 | 0 | 80,464 | 123,539 |
| 5 | 2 | turn | 7,525 | yes | 14,138 | 648 | 0 | 43,295 |
| 6 | 3 | turn | 7,525 | yes | 14,138 | 648 | 0 | 43,319 |
| 7 | 3 | turn | 7,525 | yes | 14,138 | 648 | 40,232 | 83,551 |
| 8 | 4 | turn | 7,525 | yes | 14,138 | 648 | 40,232 | 83,574 |
| 9 | 4 | **compaction** | 7,525 | yes | 14,138 | 648 | 80,464 | 124,232 |
| 10 | 4 | turn | 7,525 | yes | 14,138 | 648 | 0 | 43,338 |
| 11 | 5 | turn | 7,525 | yes | 14,138 | 648 | 0 | 43,361 |
| 12 | 5 | turn | 7,525 | yes | 14,138 | 648 | 40,232 | 83,593 |
| 13 | 6 | turn | 7,525 | yes | 14,138 | 648 | 40,232 | 83,615 |
| 14 | 6 | **compaction** | 7,525 | yes | 14,138 | 648 | 80,464 | 124,273 |
| 15 | 6 | turn | 7,525 | yes | 14,138 | 648 | 0 | 43,379 |

Three readings:

1. **The cut is real.** Request 4 carries 80,464 characters of tool output. Request 5,
   the same turn continued after the compaction, carries zero. The input falls from
   123,539 characters to 43,295.
2. **The catalog does not move.** All fifteen requests, compaction requests included,
   carry the identical 7,525-character catalog with both pointer entries.
3. **Compaction fires mid-turn.** Request 4 sits inside turn 2, after the read lands.
   Codex then continues the same turn on the rebuilt history. `codex exec` prints
   nothing about it on stdout. The wire and the rollout are the only witnesses.

## 3. The stress case: a limit compaction can never satisfy

Limit 9,000 tokens, which is below the developer prefix itself. Codex must compact on
every turn, and the compacted session is still over the limit. Nine turns produce eight
compactions.

The catalog is byte-identical on all seventeen requests, and the AGENTS.md message rides
through all eight compactions. Codex compacts once per turn and proceeds. It does not
loop and it does not degrade. The eighth compaction behaves exactly like the first, and
by then nothing conversational of turn one remains to carry anything.

## 4. What a compaction keeps, read off the wire

The first request after a compaction, item by item:

| item | role | content | fate |
|---|---|---|---|
| base instructions | developer | 17,730 chars | rebuilt fresh, unchanged |
| first user message | user | 31 chars | kept verbatim |
| permissions + **skill catalog** | developer | 362 + 7,525 chars | rebuilt fresh, unchanged |
| team + multi-agent notes | developer | 2,454 chars | rebuilt fresh, unchanged |
| **AGENTS.md instructions** + environment | user | 14,138 + 387 chars | rebuilt fresh, unchanged |
| the turn's user message | user | 20 chars | kept |
| summary bridge | user | 648 chars | new: wraps the model's handoff summary |

Cut: every assistant message, every tool call, and every tool result between the first
user message and the newest one.

Two consequences for curia beyond the catalog question:

1. **The dispatch anchor survives.** The first user message is the spawn prompt, and
   codex keeps it verbatim through every compaction. A codex dispatch never loses the
   line that names `prompt.md`.
2. **Skill bodies do not survive.** A `<skill>` block or a skill file read is
   conversation, so a compaction cuts it. The re-arm after a compaction is the catalog
   pointer alone, which tells the model to read the file again. That read costs 11,887
   characters once per compaction cycle at most (#461 measured once per session at
   rest). This is the mechanism working as designed, not a gap.

## 5. A trap for the next probe author

The first run of this probe looped for 5,608 requests. The stub followed #399's rule for
turn state: count the `exec` calls after the last user message. A mid-turn compaction
breaks that rule. The rebuilt history ends with codex's summary bridge, which is a user
message, so the count reset, the stub read the bulk file again, the read pushed the
session back over the limit, and codex compacted forever.

The rule for a scripted model under compaction: hold turn state in the stub process,
never infer it from the input list. The committed probe refills its read list once per
`codex exec` invocation.

The loop also says something true about codex itself: codex will compact as many times
in one turn as the model's behavior forces. Nothing in codex breaks the cycle. A real
model that redoes cut work after every compaction would pay this loop in the real world,
which is why codex's own instructions tell the model to assume the compaction happened
and not to restart.

## 6. What this check does not answer

- **A real model's choices after a compaction.** The stub scripts the model, so how often
  a real model re-reads a skill file after the read is cut needs a credential, as #461's
  frequency did. The structural half, what reaches the model, does not depend on it.
- **Real token accounting.** The stub reports four characters per token. A real provider
  counts reasoning and caching differently, so the limit crossing moves, and the
  structural result does not.
- **The TUI lane.** This is `codex exec` plus `resume`, the lane curia dispatches on.
- **A future codex.** The compaction rebuild lives in the CLI. A codex version bump owes
  a re-run, and the probe is committed so the re-run starts from a working rig.

## How to re-run it

```sh
node prototypes/codex-compaction/probe.mjs all
```

Cases: `rest`, `compact`, `floor`. Each writes its request bodies under
`/tmp/curia-577-compact/<case>/`, so every number in this file can be read back off the
wire. Needs the `codex` binary on PATH, no credential and no network.

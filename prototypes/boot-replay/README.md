# What fills the reduction at boot

Evidence for [The boot replay (#322)](https://github.com/alp82/curia/issues/322), on
[the journal map (#316)](https://github.com/alp82/curia/issues/316).

```
node prototypes/boot-replay/run.mjs
```

It writes `results.json` beside itself. Every number in the ticket comes out of that file.

## The question

**The build shipped.** [#407](https://github.com/alp82/curia/issues/407) moved the rebuild onto the
journal, and `EscalationStore._replay` is now `Reduction#rebuild`. This directory keeps the measurement
that settled #322, and it is not the shipped code. The file baseline it times no longer exists in
`daemon/src`. `results.json` holds the numbers the ADR cites.

Before that build, `EscalationStore._replay` read `daemon/data/events.jsonl` whole, once per process, and folded every
line through `_apply`. That one pass fills all 24 in-memory reductions. It is the one cost
proportional to the whole history that [the schema ticket (#321)](https://github.com/alp82/curia/issues/321)
did not remove.

With the journal on `node:sqlite`, two answers are possible. The pass disappears, because each
reduction becomes a query. Or the pass survives and reads the journal instead. This prototype
measures both, and a third answer between them.

**A note on the name.** #322 is titled "The boot replay", and this directory follows the ticket. The
ticket then ruled that the boot act is a **rebuild**, because `CONTEXT.md` already gives "replay" to
[#388](https://github.com/alp82/curia/issues/388): sending a killed turn's message again. So the
prose below says rebuild, and `_replay` appears only where it names today's code.

## The reduction has two halves

`CONTEXT.md` already names the split, and it decides the ticket.

**Three fields keep journal rows verbatim.** The feed tail (`recent`, the last 100 events), the
outcomes (the last five of each of three endings), and the last event per agent. Each one is "the
last N rows matching X". Each one is a query, and #321 already indexed the shape.

**Every other field is computed.** One escalation record folds the opened, rendered, superseded,
answered and closed rows into an object no row holds. `agent_notes_expired` drops the pending notes
whose instance is not the live one and marks the rest read, which depends on the queue at that
moment. `pendingTurns` counts the `command` rows since a turn started and keeps their canonical
text. `consoleSpent` holds every conversation key ever minted and never shrinks, while
`consoleConversations` holds the live ones and a delete takes one out of the second and not the
first. None of these is one query.

So "the reductions become queries" is not one decision. It is a decision about three fields.

## What the prototype boots

Five ways over the same journal, all through the daemon's own `_apply`:

1. **from the file** — `_replay` as it stands today
2. **from the journal, row by row** — `select body from events order by id`, `iterate()`
3. **from the journal, batched** — the same rows a thousand at a time, `where id > ? limit 1000`
4. **from the journal, all at once** — the same rows materialized in one `all()`
5. **narrowed** — scan only the 32 types the reducer acts on, and fill the verbatim three by query

After each boot it compares all 24 fields of the reduction against the boot from the file.

## The fixture

`traffic.mjs` takes #321's synthetic journal and injects the traffic the reducer lives on.
#321's fixture was built for the fourteen questions, and those are all about dispatches, so it
writes no escalation, no note, no thread binding, no overseer turn and no console conversation. A
boot over it folds an almost empty reduction, which is fine evidence for #321 and no evidence for
this ticket.

**The injection rates are an assumption, not a measurement.** Nobody has a census of the real
journal by type. #317 measured its size and its growth and no more. So read the share the narrowed
scan reads as one plausible journal, and read the equivalence check, which does not depend on the
rates, as the evidence.

## The numbers

Node 24.19.0, in an agent container. One boot, start to finish, averaged over 30 runs at the live
size, 10 at the middle sizes and 3 at the top.

| events | file today | row by row | batched | all at once | narrowed | the narrowed scan reads |
|---|---|---|---|---|---|---|
| 4,310 (the live journal) | 43.9 ms | 49.2 ms | 42.1 ms | 37.2 ms | 26.2 ms | 2,059 rows, 47.8% |
| 29,877 | 261.9 ms | 312.7 ms | 256.4 ms | 253.5 ms | 236.2 ms | 14,432 rows, 48.3% |
| 59,952 | 519.7 ms | 632.2 ms | 559.9 ms | 551.9 ms | 582.5 ms | 29,176 rows, 48.7% |
| 249,966 | 2,368.7 ms | 2,975.3 ms | 2,569.3 ms | 2,838.2 ms | 2,370.2 ms | 121,346 rows, 48.5% |

Where the boot spends the time. Each stage is the one above it plus a step, so a difference is what
that step costs.

| stage | 4,310 events | 249,966 events |
|---|---|---|
| read the file | 9.7 ms | 722.1 ms |
| read the rows, one at a time | 11.4 ms | 773.7 ms |
| read the rows, all at once | 5.6 ms | 563.3 ms |
| read the file and `JSON.parse` | 23.6 ms | 1,448.0 ms |
| read the rows and `JSON.parse` | 26.8 ms | 1,599.6 ms |
| the whole boot from the file | 43.9 ms | 2,368.7 ms |

The reduction the live-size fixture folds to: 248 escalations, 141 agents, 72 notes, 37 bound
threads, 26 console conversations and 2 turns a restart killed.

## What the numbers say

**The medium is the small part.** Reading is about 30 percent of the boot, `JSON.parse` is about
another 30, and the fold itself is the rest. Reading rows costs about what reading the file costs.
So moving the journal to `node:sqlite` neither pays for the boot nor charges for it. The boot
rebuild is the one cost #316 does not remove, and the ticket should say so plainly.

**Read the rows in pages.** `iterate()` pays a step across the JavaScript-to-SQLite edge per row and
runs 10 to 25 percent slower than the file. One `all()` is the fastest read and holds the whole
journal in memory: about 65 MB of strings at 250,000 events. A page of a thousand rows is as fast as
`all()` and holds a thousand rows.

**All five boots end at the same reduction.** All 24 fields, at four sizes, byte for byte against
the boot from the file. `body` is verbatim, so the fold does not know which medium it read.

**Narrowing the scan buys almost nothing.** The reducer acts on 32 of the 96 event types, but those
32 are about half the rows, and the three queries that replace the skipped rows cost back the
saving. It wins 18 ms at the live size, loses at 60,000, and ties at 250,000. It also splits one
rule across two places: the reducer's switch, and a type list beside it. A type added to `_apply`
and forgotten in the list makes the boot silently lose state, and nothing fails until the next
restart. `checkTypeList` in `reduce.mjs` catches the switch half of that drift and not the six types
`_apply` acts on outside its switch.

**Order by `id`, never by `ts`.** #321 measured 2,000 events through the daemon's own writer
carrying 58 distinct millisecond stamps, up to 53 on one. The fold is order-dependent, so a stamp
cannot order it.

**The rebuild is the last reader of `normalizeEvent`.** #321 put the #184 translation at the write
edge, so every query reads normalized columns. The rebuild reads `body`, which is verbatim, so it
still translates every line it folds.

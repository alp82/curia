# What the journal scans cost

Evidence for [wayfinder #303](https://github.com/alp82/curia/issues/303), on [map #244](https://github.com/alp82/curia/issues/244). Read and measured on 2026-08-10, against the daemon at `fbbcf02`.

The operator ruled at the #303 escalation: the journal becomes a `node:sqlite` store, and that build gets its own map. This file is the evidence the ruling stands on. It exists so the charting session reads the numbers instead of measuring them again.

## What reads the journal

Two readers open `daemon/data/events.jsonl`.

- `EscalationStore._replay` (`daemon/src/store.mjs:144`) reads it once per process, at boot. Every in-memory reduction is filled from that one pass.
- The dispatcher's `#readJournal` (`daemon/src/dispatch.mjs:4954`) reads it on demand. It reads the file whole, splits it on newlines, and calls `JSON.parse` on every line.

[#289](https://github.com/alp82/curia/issues/289) removed the two `#readJournal` callers that sat on the `/overview` poll. Ten call sites remain, and they ask fourteen distinct questions.

## The fourteen questions

Every line below is one question a caller asks about the past. `#epochScan` answers three of them in one pass, and `#reconcileContext` answers three.

| # | Question | Where | Key |
|---|---|---|---|
| 1 | Did this dispatch push a pull request? | `#epochScan` `dispatch.mjs:2744` | ticket or agent |
| 2 | Did a human approve this dispatch at the gate? | `#epochScan` | ticket or agent |
| 3 | How many times has the Stop hook held this agent? | `#epochScan` | agent |
| 4 | Did the merge outrun the reviewer? | `#verdictIsLate` `:2526` | ticket |
| 5 | When was this ticket last claimed? | `#liveUnjudgedVerdict` `:2511` | ticket |
| 6 | Which repo was this ticket last dispatched against? | `#epochRepo` `:2970` | ticket |
| 7 | Was the last dispatch a charting one, and what rode it? | `#epochCharting` `:2995` | ticket |
| 8 | Which model and harness was this session last spawned on? | `#epochSpawn` `:3024` | agent |
| 9 | Which map did this session report? | `#epochAdoptedMap` `:3211` | agent |
| 10 | What did the ending say? | `#endingClause` `:3379` | agent |
| 11 | Which ticket and repo does this reviewer belong to? | `#captureVerdict` `:1542` | agent |
| 12 | What is every ticket's latest dispatch epoch? | `#reconcileContext` `:4410` | every ticket |
| 13 | Did this session report a result after its dispatch? | reconcile, `:4565` | ticket or agent |
| 14 | Did anything close this epoch? | reconcile, `:4786` | ticket or agent |

The ten call sites do not bound the cost, because the methods above are called from more than thirty places. `#epochCharting` alone has eleven callers. Most of them short-circuit on an in-memory agent record and never reach the file. An agent this process never held misses every short circuit. That is a restart mid-flight, or a reconcile adoption.

## The three shapes

Every one of the fourteen is one of three forms. Not one is an ad-hoc query over history.

- **A. The last event of type T for key K.** Questions 5 to 12. Six of them need the event body, not only its position.
- **B. Did type T happen for key K after that key's epoch?** Questions 1, 2, 13 and 14. Each one compares two positions.
- **C. How many times did type T happen for key K after its epoch?** Question 3, and nothing else.

Three of the fourteen narrow a type by a predicate rather than taking the plain last one. Question 2 counts only a `review_answered` whose `approved` is `true`. Question 6 takes the last dispatch event that carries a repo. Question 10 takes the last ending carrier that carries a summary.

## What one read costs

Measured by [`journal-scan-cost.bench.mjs`](journal-scan-cost.bench.mjs) on Node 24.19.0, in the agent container, over a synthetic journal of the same shape as the real one: a mix of small operational lines and a tail of long-text lines for prompts, answers, summaries and verdicts. Each row is one `#readJournal` plus one `#epochScan` over the result.

| lines | size | read | scan | total |
|---|---|---|---|---|
| 2,800 | 0.72 MB | 11 ms | 1 ms | **12 ms** |
| 10,000 | 2.58 MB | 49 ms | 3 ms | 52 ms |
| 30,000 | 7.77 MB | 126 ms | 10 ms | 136 ms |
| 60,000 | 15.55 MB | 243 ms | 15 ms | 258 ms |
| 250,000 | 65.02 MB | 1164 ms | 58 ms | **1222 ms** |

Two runs of the same script differ by about 15 percent, so read the table as an order of magnitude and not as a stopwatch. The shape is what matters, and it is linear.

The read dominates. Parsing every line costs about twenty times what the question costs, at every size.

## What the real journal holds

The live file lives on the operator's box, in a directory no agent container mounts, so no dispatched agent can measure it. Two records stand in.

- On 2026-08-09 it held **2,667 events**, reaching back to 2026-07-24 ([the thread surprise catalog](discord-thread-surprises.md)). That is about **167 events per day**.
- The daemon writes **96 event types** from **129 `logEvent` call sites**.

At 167 events per day the file passes 60,000 lines in about a year. Its byte size on the box is still unmeasured, and the estimate above puts it under 2 MB today.

## What the Stop hook pays

`#endingState` (`dispatch.mjs:2768`) is the hot path. It runs at the end of every turn of every agent.

- An agent this process holds in memory pays **one** whole read per turn, for `#epochScan`. Both `#epochCharting` calls short-circuit on the record, and `#liveUnjudgedVerdict` returns before its scan when no verdict file exists.
- An agent this process never held pays **three or four** whole reads per turn.

So the Stop-hook cost today is about 12 ms per turn, and about a quarter of a second per turn at one year of the current rate.

## What was put up and turned down

A third shape was offered at the escalation and refused, and the record names it because the new map will meet it again.

**One general index in the store, instead of one reduction per question.** For each indexed event type the store would keep the last event and its sequence number, keyed by ticket and by agent, plus three predicate-narrowed keys and one counter. All fourteen questions are then one lookup. It needs no migration, no write-path change and no dependency, and the journal stays a file the operator can `grep` and `tail -f`. It is about 150 lines.

What it does not do is answer anything outside the three shapes above. The operator chose the store over the index, which reads as buying the query engine rather than the ten scans.

## What the new map must decide

- The schema, and how 96 event types map onto it.
- What stays greppable. `grep` and `tail -f` on the journal are how curia is debugged today.
- What happens to the file that exists, and how it migrates.
- Whether [ADR-0001](../adr/0001-github-is-the-only-durable-state-home.md)'s one durable artifact moves, or whether the JSON lines stay the truth and the store becomes a derived index rebuilt at boot.
- The boot replay. It is the one cost proportional to the whole history, and a store either removes it or inherits it.
- The write paths: 129 `logEvent` call sites, and the crash guard that must still journal while the process dies.
- The test suite: 37 places in 14 test files seed or read `events.jsonl` directly.

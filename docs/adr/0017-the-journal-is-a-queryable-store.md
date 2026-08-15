# ADR-0017: The journal is a queryable store

**Status**: accepted (2026-08). Not built. The build is charted on [the store map (#316)](https://github.com/alp82/curia/issues/316).
**Provenance**: [The journal becomes a queryable store (#303)](https://github.com/alp82/curia/issues/303), [Where does the truth live (#319)](https://github.com/alp82/curia/issues/319)

## Context

[ADR-0001](0001-github-is-the-only-durable-state-home.md) named `daemon/data/events.jsonl` curia's one durable artifact. It is append-only text, one JSON object per line, and it never rotates. The operator ruled at the [#303](https://github.com/alp82/curia/issues/303) escalation that the journal becomes a `node:sqlite` store. That ruling left one question open, and this record answers it: does the store hold the truth, or do the lines hold it while the store serves as a derived index?

The evidence is measured. [What the journal scans cost](../research/journal-scan-cost.md) holds the full table.

- Ten `#readJournal` call sites ask **fourteen** distinct questions. More than thirty callers sit above them.
- All fourteen take one of three shapes. The last event of a type for a key. Whether a type occurred for a key after that key's epoch. One count. Not one is an ad-hoc query over history.
- One whole read costs about **25 ms** today. The read dominates the question by about twenty to one.
- The box held **4,282 events in 1.4 MB** on 2026-08-13, and it grows about **404 events per day**.
- `#epochScan` runs at the end of every turn of every agent. It reaches a quarter of a second per turn in about five months.

[What `node:sqlite` guarantees](../research/node-sqlite-guarantees.md) holds the durability facts. Node 24.19 marks the module Stability 1.2, which stays experimental. A Node patch update can change the API, the defaults, and the bundled SQLite engine.

## Decision

- **The store holds the truth.** The `node:sqlite` database is curia's durable artifact. `daemon/data/events.jsonl` retires.
- **A row keeps the written line verbatim.** A `body` column holds the exact text curia serialized. The other columns are extracted copies, and they exist for indexing. So the store is a superset of the file, and a query regenerates that file byte for byte.
- **The daemon owns the only write connection.** Every other process opens the store read-only. WAL permits one writer, and every process must sit on one host.
- **The store runs WAL with `synchronous=FULL`.** The store now holds the record, so a commit lost to a power cut is a record lost. FULL costs about 1.230 ms per insert, against about 404 events per day.
- **A periodic `.dump` backs up the store, and the Node patch version is pinned.** The record sits on an experimental module, and curia does not carry that risk bare. `sqlite3 events.db .dump` produces portable SQL text.
- **The old spelling survives untouched.** [#184](https://github.com/alp82/curia/issues/184) renamed the worker to the agent, and the journal was never rewritten to match. Curia stores the line as written and translates on read, exactly as `normalizeEvent` does today.

## Considered options

**The lines stay the truth, and the store is a derived index rebuilt at boot.** This was the recommendation this ticket opened with, and the operator moved off it. It puts no record on an experimental module, and a bad Node upgrade costs only a rebuild. It keeps `grep` and `tail -f` free.

It was refused for three reasons. It needs a dual write and a divergence window, because a process can die between the append and the insert. It keeps a boot cost proportional to the whole history. It leaves the text file growing forever, because the journal never rotates.

Two arguments made for it did not survive. The smaller migration is a migration argument, and the operator accepts a migration. The cheaper write path is real as a ratio and not as a number, because 404 events per day at 1.230 ms costs about half a second per day.

**One general index in the store, about 150 lines.** It answers all fourteen questions with no migration and no write-path change, and the journal stays a text file. It answers nothing outside the three shapes. The operator put it up at the #303 escalation and turned it down, which reads as buying the query engine rather than the ten scans.

## Consequences

- **ADR-0001's journal bullet moves here.** That record now points at this one.
- **ADR-0001's "no local brain to lose" gains a caveat.** Restart recovery is still a re-query against GitHub, and the tracker still holds ticket state. The store is a local brain, and the `.dump` is what bounds the loss.
- **The operator queries the store, and curia builds nothing to help.** [#320](https://github.com/alp82/curia/issues/320) decided the surface: a read-only `sqlite3` shell out of the daemon image, and no wrapper, no text tail, and no backwards compatibility with the old `grep` pipelines. The store exists to make a question cheap, so the answer to a question is a query. That decision puts one requirement on the schema: extract the columns a human types by hand, and normalize the [#184](https://github.com/alp82/curia/issues/184) spelling into them. `sqlite3` joins the daemon image with the Node bump. The queries are in [the daemon README](../../daemon/README.md#reading-the-journal).
- **Retention becomes possible and stays undecided.** The text file never rotated. A row deletes. Nothing here rules on what curia keeps.
- **The schema is not decided here.** [#321](https://github.com/alp82/curia/issues/321) prototypes it against the fourteen queries. This record fixes only the verbatim `body` column and the truth.
- **The boot replay changes.** `EscalationStore._replay` reads the whole file once per process today. [#322](https://github.com/alp82/curia/issues/322) decides what fills the [#289](https://github.com/alp82/curia/issues/289) reductions.
- **The existing file migrates.** [#323](https://github.com/alp82/curia/issues/323) converts 4,282 rows and decides what remains of the file.
- **The write path changes at 129 `logEvent` call sites**, and the crash guard must still journal while the process dies. `installCrashGuard` journals and then exits, and a synchronous insert completes before that exit.
- **The test suite changes.** 37 places across 14 test files seed or read `events.jsonl` directly.
- **The word "store" now names two things.** `EscalationStore` lives in `daemon/src/store.mjs` and holds the in-memory reductions. The durable artifact above is also a store. Curia writes one name for one thing, so the build picks a second name before it writes code.

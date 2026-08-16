# The schema and the fourteen queries

The prototype for [alp82/curia#321](https://github.com/alp82/curia/issues/321), on
[the store map #316](https://github.com/alp82/curia/issues/316). Throwaway code under `prototypes/`
(ADR-0008). It answers one question: does one table carry 96 event types and all fourteen questions,
and what does it cost?

```sh
node prototypes/journal-schema/run.mjs    # build, check, measure — writes results.json
node prototypes/journal-schema/demo.mjs   # write demo.html from results.json
```

`run.mjs` needs Node 24 for `node:sqlite`. It writes its fixtures to a temp directory and touches
nothing in `daemon/data`.

## What is here

| file | what it holds |
|---|---|
| `schema.sql` | The proposal: one table, four indexes, one trigger. |
| `schema-no-epoch.sql` | The same table without the `epoch` column, so the stamp costs a number. |
| `journal.mjs` | The write path: one journal line in, one row out, through `normalizeEvent`. |
| `synth.mjs` | A synthetic journal of the measured shape, dispatches interleaved, oldest fifth in the pre-#184 spelling. |
| `oracle.mjs` | The fourteen questions as the daemon answers them today, ported out of `dispatch.mjs`. |
| `queries.mjs` | The fourteen as SQL, plus the five the operator types from the daemon README. |
| `run.mjs` | Builds, checks every query against the oracle, times both, measures the write and the disk. |
| `demo.mjs` | Turns `results.json` into `demo.html`. Every number on the page comes from the run. |
| `results.json` | The last run's numbers, committed so the verdict can be read without running anything. |

## The check

`run.mjs` does not assert that the SQL looks right. It runs every query and the daemon's own loop over
the same journal and compares the answers, for every ticket and every agent the journal holds, at four
sizes. A query that disagrees with the loop is wrong by definition — including where the daemon's rule
is surprising.

## What it does not do

It does not touch `daemon/src`, and it is not the build. The migration
([#323](https://github.com/alp82/curia/issues/323)), the boot replay
([#322](https://github.com/alp82/curia/issues/322)) and the write path behind 129 `logEvent` call sites
are their own tickets.

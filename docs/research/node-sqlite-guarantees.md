# What `node:sqlite` guarantees

Evidence for [What node:sqlite guarantees](https://github.com/alp82/curia/issues/318), on [The journal becomes a queryable store](https://github.com/alp82/curia/issues/316).
This research checked sources and issue states on 2026-08-13.

## Answer

Use WAL with an explicit `synchronous` level.
WAL keeps readers active during a write, but it still permits only one writer.

`synchronous=NORMAL` survives an application process crash.
It can lose recent commits after an operating-system crash or power cut.
`synchronous=FULL` adds one WAL sync per commit and protects those commits from a power cut.

Node 24.19 marks `node:sqlite` as Stability 1.2, Release candidate.
This level remains experimental.
Pin the Node patch and test each upgrade before deployment.

## Journal modes

SQLite offers six journal modes through `PRAGMA journal_mode`.
The [journal mode reference](https://www.sqlite.org/pragma.html#pragma_journal_mode) defines each mode.

| Mode | What SQLite writes | Application process kill | Operating-system crash or power cut |
|---|---|---|---|
| `DELETE` | A rollback journal, deleted after commit | SQLite recovers an incomplete transaction | The `synchronous` level controls loss |
| `TRUNCATE` | A rollback journal, truncated after commit | SQLite recovers an incomplete transaction | The `synchronous` level controls loss |
| `PERSIST` | A rollback journal with an invalidated header after commit | SQLite recovers an incomplete transaction | The `synchronous` level controls loss |
| `MEMORY` | A rollback journal in memory | A kill during a transaction probably corrupts the database | A cut during a transaction probably corrupts the database |
| `WAL` | Changes in a separate write-ahead log | SQLite recovers committed transactions from the WAL | The `synchronous` level controls recent loss |
| `OFF` | No rollback journal | A kill during a transaction probably corrupts the database | A cut during a transaction probably corrupts the database |

The first three modes use the same rollback design.
They differ in journal cleanup after a commit.
`DELETE` is the default mode.

Do not copy only the main database file while a transaction can run.
The journal or WAL can hold required recovery data.
SQLite lists this action as a [database corruption cause](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active).

## Synchronous levels

SQLite offers four levels through `PRAGMA synchronous`.
The [synchronous reference](https://www.sqlite.org/pragma.html#pragma_synchronous) defines the loss boundary.

| Level | Rollback journal after a power cut | WAL after a power cut | Application process kill |
|---|---|---|---|
| `EXTRA` (`3`) | ACID, including a directory sync after `DELETE` removes the journal | Same as `FULL` | Committed transactions survive |
| `FULL` (`2`) | No corruption, but the last commit can disappear on some filesystems | ACID | Committed transactions survive |
| `NORMAL` (`1`) | A rare cut can corrupt a database on an older filesystem | No corruption, but recent commits can disappear | Committed transactions survive |
| `OFF` (`0`) | A cut can corrupt the database | A cut can corrupt the database | A safe journal mode preserves a completed commit |

`FULL` is the default for rollback journals.
`EXTRA` adds rollback durability when the containing directory needs a sync after journal deletion.

In WAL mode, `NORMAL` syncs at checkpoints and WAL reuse.
It does not sync most commits.
`FULL` adds a WAL sync after each commit.

These guarantees depend on correct storage behavior.
SQLite cannot detect hardware or filesystems that give false results for sync requests.
SQLite documents this limit in its [corruption guide](https://www.sqlite.org/howtocorrupt.html#_failure_to_sync).

## WAL for one writer and few readers

WAL lets readers continue while the writer appends a commit.
The writer also continues while readers hold old snapshots.
SQLite still allows [only one writer at a time](https://www.sqlite.org/wal.html#concurrency).

WAL is usually faster because it writes sequentially and uses fewer sync calls.
SQLite reports that WAL can run slightly slower for mostly read-only work.
The [WAL overview](https://www.sqlite.org/wal.html#overview) gives a possible one to two percent cost.

WAL adds `-wal` and `-shm` sidecar files.
All processes must run on one host because the WAL index uses shared memory.
WAL does not work on a network filesystem.

WAL also adds checkpoint work.
SQLite starts an automatic checkpoint at 1,000 WAL pages by default.
A long read can stop a checkpoint before that reader's end mark.
The WAL then grows, and later reads cost more.

The commit that starts a checkpoint can take much longer than adjacent commits.
An operator can move checkpoints to quiet periods with `PRAGMA wal_checkpoint`.
The [checkpoint guide](https://www.sqlite.org/wal.html#checkpointing) describes this latency tradeoff.

One `DatabaseSync` connection does not make reads concurrent with its own write.
Node runs [all methods on that connection synchronously](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#class-databasesync).
WAL helps when separate connections or processes read during the daemon's write.

## Backup and inspection

Node 24 provides `sqlite.backup(sourceDb, path)`.
It wraps SQLite's online backup API and returns a promise.
The source stays usable during the copy.

Writes through the source connection appear in the backup immediately.
Writes through other connections restart the copy.
The [Node backup reference](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourcedb-path-options) defines these rules.

The operator can use the SQLite CLI for a live backup:

```sh
sqlite3 events.db ".backup 'events.backup.db'"
```

The online backup API makes a consistent snapshot.
It avoids the mixed-page risk from a normal file copy.
SQLite documents this behavior in the [online backup guide](https://www.sqlite.org/backup.html).

The operator can make a portable SQL dump:

```sh
sqlite3 events.db .dump | gzip -c > events.dump.gz
zcat events.dump.gz | sqlite3 restored.db
```

The operator can inspect without write access:

```sh
sqlite3 -readonly events.db
```

Useful commands include `.tables`, `.schema`, `.dbinfo`, and normal `SELECT` statements.
The [SQLite CLI guide](https://www.sqlite.org/cli.html) defines `.backup`, `.dump`, and `-readonly`.

If the daemon is stopped, the operator can copy the database file normally.
If the daemon runs, use the backup API or CLI `.backup`.

## Node 24 maturity

Node 24.15 raised `node:sqlite` from Stability 1.1 to [Stability 1.2](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
Node calls this stage Release candidate.

Stability 1.2 remains experimental.
Node excludes experimental APIs from semantic-version rules.
Node can change or remove them in any future release.

Node expects no more breaking changes at stage 1.2.
User feedback or the underlying specification can still cause one.
The [Node stability index](https://nodejs.org/docs/latest-v24.x/api/documentation.html#stability-index) states both rules.

Open Node defects include these material cases:

- A callback can reenter its running statement. A bounded reset caused `SIGSEGV` on Node 24.15 in [the defect report](https://github.com/nodejs/node/issues/65102#issuecomment-5233546237).
- `StatementSync.run()` silently rounds a large `lastInsertRowid` in [the integer defect](https://github.com/nodejs/node/issues/65177). Node 24.19.0 reproduces it.
- Excess arguments produce an unclear SQLite error in [the binding defect](https://github.com/nodejs/node/issues/65163).
- An authorizer can modify its own connection against SQLite's contract in [the authorizer defect](https://github.com/nodejs/node/issues/63207). Node 24.19.0 reproduces it.

These reports do not target a normal prepared insert.
Avoid callback reentry and read integer identifiers as `BigInt`.

An upgrade inside Node 24 can change defaults.
Node 24.14 enabled SQLite defensive mode by default in a [minor release](https://nodejs.org/en/blog/release/v24.14.0).

An upgrade also changes the bundled SQLite engine.
Node 24.18 updated SQLite to 3.53.1 in its [release record](https://nodejs.org/en/blog/release/v24.18.0).
The local Node 24.19.0 runtime contains SQLite 3.53.3.

Engine updates can change query plans, limits, SQL behavior, extensions, and speed.
This result follows from the bundled engine updates.

SQLite keeps backward file compatibility from SQLite 3.0.
A newer SQLite reads older database files.
An older SQLite can reject a file that uses a newer feature, such as WAL.
The [file format policy](https://www.sqlite.org/formatchng.html) defines this limit.

Pin an exact Node patch.
Set the database options and PRAGMAs explicitly.
Record `process.version` and `process.versions.sqlite` in diagnostics.
Test schema access, recovery, and durability before each upgrade or rollback.

## Crash guard cost

`DatabaseSync` performs each insert on the JavaScript thread.
The call blocks the event loop until SQLite returns.
This API behavior differs from the `PRAGMA synchronous` durability level.

The container measured 1,000 autocommit inserts on Node 24.19.0.
Each insert stored one small event in a prepared statement.

| Mode | Mean | Median | 95th percentile | Maximum | Main cost |
|---|---:|---:|---:|---:|---|
| WAL with `FULL` | 1.230 ms | 1.163 ms | 1.969 ms | 14.937 ms | One WAL sync for each commit |
| WAL with `NORMAL` | 0.041 ms | 0.026 ms | 0.049 ms | 8.948 ms | No sync on most commits |
| `DELETE` with `FULL` | 3.897 ms | 3.773 ms | 5.452 ms | 24.721 ms | Rollback journal work and syncs |

The WAL `NORMAL` maximum occurred near the default automatic-checkpoint threshold.
The benchmark did not trace the checkpoint, so this cause is an inference.
These values describe this container filesystem and host only.
The deployment disk can produce different sync times and tail delays.

For a process crash alone, WAL with `NORMAL` preserves committed writes.
For a simultaneous system crash or power cut, use WAL with `FULL`.
That choice adds about one storage sync to each crash-guard insert.

Node says an `uncaughtException` handler can only do synchronous cleanup before exit.
Node also says normal operation after that event is unsafe.
The [process guide](https://nodejs.org/docs/latest-v24.x/api/process.html#warning-using-uncaughtexception-correctly) sets this boundary.

The crash guard cannot cover every death.
`SIGKILL` cannot have a listener and always terminates Node.
Native `SIGSEGV` handling cannot safely call JavaScript listeners.
The [signal rules](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events) state these limits.

// The journal (#407, ADR-0017): curia's durable record, a `node:sqlite`
// database at `daemon/data/events.db`.
//
// The name follows the record and not the medium (#358), so this database IS
// the journal. It was `daemon/data/events.jsonl` until this module shipped, and
// that file survives as the **journal file**, a historical term.
//
// Three rules come straight out of ADR-0017.
//
//   - One table holds all 96 event types. The boot rebuild reads every event in
//     write order, and the questions the daemon asks key by ticket, by agent or
//     by type. Ninety-six tables would make "the last thirty events" a
//     ninety-six-way union.
//   - `body` holds the line curia serialized, byte for byte. The other columns
//     are extracted copies and they exist for indexing, so the journal is a
//     superset of the file it replaced and `select body from events order by id`
//     regenerates that file exactly.
//   - The daemon owns the only write connection. It runs WAL with
//     `synchronous=full`, because the record lives here now and a commit lost to
//     a power cut is a record lost. That costs about 1.230 ms per insert against
//     about 404 events per day.
//
// The schema is [#321](https://github.com/alp82/curia/issues/321), measured in
// `prototypes/journal-schema/`. The migration is
// [#323](https://github.com/alp82/curia/issues/323), and it lives here because
// it shares the schema and the column extraction with the writer.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// The journal, and the file it replaced. The migration reads the second and
// writes the first, and it never renames or deletes the second (#323).
export const JOURNAL = 'events.db'
export const JOURNAL_FILE = 'events.jsonl'

// The half-built database a migration writes. It is renamed into place only
// after the row count matches the line count, so a conversion killed halfway
// leaves `events.db` absent and the next boot converts again.
const MIGRATING = `${JOURNAL}.migrating`

// How many rows the boot rebuild reads at a time (#322). The whole history is
// about 1.4 MB today, so this bounds the peak rather than the cost.
export const REBUILD_PAGE = 1000

// One table, five indexes, one trigger.
//
// STRICT is permitted: #320 ruled that the operator's `sqlite3` comes out of the
// daemon image, and that image carries SQLite 3.53.
const SCHEMA = `
create table if not exists events (
  -- The write order. This id IS the position the epoch questions mean when they
  -- say "after the epoch", so every ordering is \`order by id\` and never by ts.
  -- Two events inside one millisecond keep their order.
  id     integer primary key,

  -- ISO-8601 UTC, exactly as the append stamps it.
  ts     text    not null,

  -- The event type, in today's spelling. A line written before #184 says
  -- \`worker_spawned\` in body and \`agent_spawned\` here.
  type   text    not null,

  -- The ticket, as text. Null when the event names none. Text and not integer,
  -- so \`where ticket='320'\` works, and \`where ticket=320\` works too, because
  -- SQLite applies the column's TEXT affinity to a bare numeric literal.
  ticket text,

  -- The agent session, in today's spelling. A pre-#184 line carries
  -- \`"worker": "curia-170"\` in body and \`curia-170\` here.
  agent  text,

  -- The repo the event is about, or null. A column because the operator types
  -- it. It gets no index of its own: curia runs one or two repos, so
  -- \`where repo='alp82/curia'\` selects nearly every row.
  repo   text,

  -- The dispatch this row belongs to: the id of the \`dispatch_claimed\` or
  -- \`agent_spawned\` row that opened the ticket's latest epoch when this row was
  -- written. An epoch-opening row carries its own id. 0 for a row with no
  -- ticket, or one written before its ticket was ever dispatched.
  epoch  integer not null default 0,

  -- The line curia wrote, byte for byte, old spelling and all (ADR-0017).
  body   text    not null
) strict;

-- The last event of a type for a key, and the type-narrowed epoch questions.
-- Both directions, because six of the fourteen questions key by agent.
create index if not exists events_ticket_type on events (ticket, type, id);
create index if not exists events_agent_type  on events (agent, type, id);

-- The current epoch of a ticket, as one index probe. Without it, \`max(epoch)\`
-- reads every row the ticket ever wrote.
create index if not exists events_ticket_epoch on events (ticket, epoch);

-- "Since the epoch", and the operator's "this dispatch, whole".
create index if not exists events_epoch_type on events (epoch, type);

-- The census, \`group by type\`. Also the type-only reads the rebuild does.
create index if not exists events_type on events (type, id);

-- The epoch stamp is a property of the table and not of the write path. Every
-- call site stays ignorant of it, and a migrated row gets the same stamp as a
-- live one because both arrive through this trigger.
create trigger if not exists events_stamp_epoch after insert on events
when new.ticket is not null
begin
  update events set epoch = coalesce((
    select e.id from events e
     where e.ticket = new.ticket
       and e.type in ('dispatch_claimed', 'agent_spawned')
       and e.id <= new.id
     order by e.id desc limit 1
  ), 0)
  where id = new.id;
end;
`

// The journal in the old spelling (#184).
//
// Until #184 the process curia spawns was a "worker" and the program it ran
// under was its "backend", so every line written before the rename says
// `worker_spawned`, `"worker": "curia-170"`, `"backend": "claude"`. The journal
// is append-only and it is the daemon's only durable artifact. A record you
// rewrite to match today's vocabulary is no longer a record. So `body` keeps the
// old spellings and the translation happens HERE instead.
//
// Two edges cross it. The columns above run it on the way in, so
// `where agent='curia-170'` finds a line that says `"worker"`. The boot rebuild
// runs it on the way out, and it is the last reader that does.
//
// A new-spelling key always wins over a legacy one, so a line carrying both
// (which nothing writes) can never resurrect the old value.
const LEGACY_FIELDS = { worker: 'agent', backend: 'harness' }

export function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev
  let out = ev
  // Covers every legacy type in one rule, `escalation_worker_died` included:
  // there is no event whose name says "worker" and means something else.
  if (typeof ev.type === 'string' && ev.type.includes('worker')) {
    out = { ...out, type: ev.type.replaceAll('worker', 'agent') }
  }
  for (const [legacy, current] of Object.entries(LEGACY_FIELDS)) {
    if (!(legacy in out) || current in out) continue
    out = { ...out, [current]: out[legacy] }
    delete out[legacy]
  }
  return out
}

// What one line becomes in the columns. The line itself is untouched.
//
// Every value is a string or null. `node:sqlite` binds a JavaScript number as a
// REAL, so a ticket handed over as a number lands in the TEXT column as "321.0"
// and every `where ticket=321` misses it.
export function columnsFor(line) {
  const ev = normalizeEvent(JSON.parse(line))
  // The bar the old boot pass set: one JSON OBJECT per line. It read `ev.type`
  // without a guard, so a line holding a number, a string or null stopped it.
  // The migration stops on the same lines, and it stops at the line rather than
  // at the rebuild that follows.
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    throw new Error('a journal line is not a JSON object')
  }
  const text = (v) => (v == null ? null : String(v))
  return {
    ts: String(ev.ts ?? ''),
    type: String(ev.type ?? ''),
    ticket: text(ev.ticket),
    agent: text(ev.agent),
    repo: text(ev.repo),
    body: line,
  }
}

// One write connection over one file.
export class Journal {
  constructor(file) {
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec('pragma journal_mode = wal')
    this.db.exec('pragma synchronous = full')
    this.db.exec(SCHEMA)
    this.insert = this.db.prepare(
      'insert into events (ts, type, ticket, agent, repo, body) values (?, ?, ?, ?, ?, ?)',
    )
    this.pageStmt = this.db.prepare('select id, body from events where id > ? order by id limit ?')
    this.countStmt = this.db.prepare('select count(*) as n from events')
  }

  // One line in, one row out. Synchronous, which is what lets the crash guard
  // journal and then exit (ADR-0017).
  append(line) {
    const c = columnsFor(line)
    this.insert.run(c.ts, c.type, c.ticket, c.agent, c.repo, c.body)
  }

  // One transaction for a migration. The daemon commits per event.
  appendAll(lines) {
    this.db.exec('begin')
    try {
      for (const line of lines) this.append(line)
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
  }

  count() {
    return Number(this.countStmt.get().n)
  }

  // The rebuild's read (#322): `select id, body from events where id > ? order
  // by id limit 1000`, page by page. It orders by id and never by ts, because
  // stamps tie.
  *bodies(page = REBUILD_PAGE) {
    let after = 0
    for (;;) {
      const rows = this.pageStmt.all(after, page)
      if (!rows.length) return
      for (const row of rows) yield row.body
      after = rows.at(-1).id
    }
  }

  // Nothing hands out the whole journal any more (#408). `bodies()` above is
  // the one read that walks it, and only the boot rebuild calls it: every
  // question the daemon asks about the past is an indexed query
  // (`./questions.mjs`).
  close() {
    this.db.close()
  }
}

// The migration (#323). The daemon converts at its first boot on this code.
//
// It accepts exactly what the boot pass accepted before it: a blank line is
// skipped, and anything else that is not one JSON object stops the boot. A
// conversion that fails needs no hand — the daemon crash-loops, the self-deploy
// health check fails, and the box resets to a ref whose daemon still finds a
// whole journal file.
//
// The journal file is not renamed and not deleted, so the ref a failed
// conversion resets to finds it whole. The daemon never writes it again. The
// box's own file was the floor the automatic rollback landed on until #427
// deleted it, and a rollback regenerates one now (see the README).
function migrate(linesFile, dbFile) {
  const staging = path.join(path.dirname(dbFile), MIGRATING)
  for (const leftover of [staging, `${staging}-wal`, `${staging}-shm`]) {
    fs.rmSync(leftover, { force: true })
  }
  const lines = fs.readFileSync(linesFile, 'utf8').split('\n').filter((l) => l.trim())
  const journal = new Journal(staging)
  try {
    try {
      journal.appendAll(lines)
    } catch (e) {
      throw new Error(`the journal file did not convert: ${e.message}`)
    }
    const rows = journal.count()
    if (rows !== lines.length) {
      throw new Error(`the journal file did not convert: ${lines.length} lines became ${rows} rows`)
    }
  } finally {
    // Out of WAL before the close, so the one file this rename moves holds
    // every row. A `-wal` left beside a renamed database is a lost migration.
    try { journal.db.exec('pragma journal_mode = delete') } catch { /* the close is what matters */ }
    journal.close()
  }
  fs.renameSync(staging, dbFile)
  return { lines: lines.length }
}

// Open the daemon's write connection, converting the journal file first when
// this is the first boot on this code.
export function openJournal(dataDir, { log = () => {} } = {}) {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbFile = path.join(dataDir, JOURNAL)
  const linesFile = path.join(dataDir, JOURNAL_FILE)
  if (!fs.existsSync(dbFile) && fs.existsSync(linesFile)) {
    const started = Date.now()
    const { lines } = migrate(linesFile, dbFile)
    log(`[journal] converted ${lines} lines of ${JOURNAL_FILE} into ${JOURNAL} in ${Date.now() - started} ms`)
  }
  return new Journal(dbFile)
}

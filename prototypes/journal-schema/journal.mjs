// The write path, prototyped for #321: one journal line in, one row out.
//
// The daemon's `_append` builds `{ ts, ...event }`, serializes it, and appends
// the text. Here the same text becomes `body`, and the five columns #320 asks
// for are extracted beside it — through `normalizeEvent`, the daemon's own
// #184 translation, so `where agent='curia-170'` finds a line that says
// `"worker"`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { normalizeEvent } from '../../daemon/src/journal.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// What a line becomes in the columns. The line itself is untouched.
export function columnsFor(line) {
  const ev = normalizeEvent(JSON.parse(line))
  return {
    ts: String(ev.ts ?? ''),
    type: String(ev.type ?? ''),
    // Stringified, always. `node:sqlite` binds a JavaScript number as a REAL,
    // so a ticket handed over as a number lands in the TEXT column as "321.0"
    // and every `where ticket=321` misses it.
    ticket: ev.ticket == null ? null : String(ev.ticket),
    agent: ev.agent == null ? null : String(ev.agent),
    repo: ev.repo == null ? null : String(ev.repo),
    body: line,
  }
}

export function openJournal(file, { epochColumn = true, wal = true } = {}) {
  fs.rmSync(file, { force: true })
  fs.rmSync(`${file}-wal`, { force: true })
  fs.rmSync(`${file}-shm`, { force: true })
  const db = new DatabaseSync(file)
  if (wal) {
    db.exec('pragma journal_mode = wal')
    db.exec('pragma synchronous = full') // ADR-0017: the record is here now
  }
  const schema = epochColumn ? 'schema.sql' : 'schema-no-epoch.sql'
  db.exec(fs.readFileSync(path.join(here, schema), 'utf8'))
  const insert = db.prepare('insert into events (ts, type, ticket, agent, repo, body) values (?, ?, ?, ?, ?, ?)')
  return {
    db,
    epochColumn,
    append(line) {
      const c = columnsFor(line)
      insert.run(c.ts, c.type, c.ticket, c.agent, c.repo, c.body)
    },
    // One transaction for a migration or a synthetic fill. The daemon commits
    // per event, and `bench.mjs` measures that separately.
    appendAll(lines) {
      this.db.exec('begin')
      for (const line of lines) this.append(line)
      this.db.exec('commit')
    },
    close() { db.close() },
  }
}

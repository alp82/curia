// The rollback release must still read the journal (#885, implementing #854).
//
// A minor release may add a restart-safe migration, and the retained
// rollback release must read what that migration wrote. The rule that makes
// it true is additive-only: a minor release adds a column with a default, an
// index, a table, or a trigger, and never renames, drops, retypes, or
// constrains what is there, never bumps a version pragma this code refuses,
// and never rewrites `body`. These tests are the guard on this side of the
// rule: this daemon opens and writes a journal that a later minor release
// migrated that way, and it reads back every row it and that release wrote.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openJournal, JOURNAL } from '../src/journal.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'curia-journal-forward-'))
}

// What a later minor release's migration leaves behind: this release's
// schema, plus one column with a default, one table, one index, and one
// row written with the new column filled in.
function migratedByLaterRelease(dir) {
  const journal = openJournal(dir)
  journal.append(JSON.stringify({ ts: '2026-09-01T10:00:00Z', type: 'agent_spawned', agent: 'curia-1', ticket: '1', repo: 'o/r' }))
  journal.close()
  const db = new DatabaseSync(path.join(dir, JOURNAL))
  db.exec("alter table events add column origin text not null default 'service'")
  db.exec('create table if not exists rehearsals (id integer primary key, ticket text not null, started text not null) strict')
  db.exec('create index if not exists events_origin on events (origin, id)')
  db.exec("insert into events (ts, type, ticket, agent, repo, body, origin) values ('2026-09-01T11:00:00Z', 'agent_ready', '1', 'curia-1', 'o/r', '{\"ts\":\"2026-09-01T11:00:00Z\",\"type\":\"agent_ready\",\"agent\":\"curia-1\",\"ticket\":\"1\"}', 'rehearsal')")
  db.exec("insert into rehearsals (ticket, started) values ('1', '2026-09-01T11:00:00Z')")
  db.close()
}

describe('the retained rollback release reads a journal a later minor release migrated', () => {
  test('this daemon opens it, appends to it, and reads every row in order', () => {
    const dir = tmpdir()
    migratedByLaterRelease(dir)

    const journal = openJournal(dir)
    try {
      journal.append(JSON.stringify({ ts: '2026-09-01T12:00:00Z', type: 'agent_exited', agent: 'curia-1', ticket: '1' }))
      assert.equal(journal.count(), 3)
      const types = [...journal.bodies()].map((b) => JSON.parse(b).type)
      assert.deepEqual(types, ['agent_spawned', 'agent_ready', 'agent_exited'])
      // The row this release wrote took the later release's default, so that
      // release reads it back too when the operator rolls forward again.
      assert.equal(journal.db.prepare("select origin from events where type = 'agent_exited'").get().origin, 'service')
      assert.equal(journal.db.prepare('select count(*) as n from rehearsals').get().n, 1, 'the later release\'s table is untouched')
    } finally {
      journal.close()
    }
  })

  test('the schema pins no version this daemon would refuse, so a later release that bumps none is readable', () => {
    const dir = tmpdir()
    const journal = openJournal(dir)
    try {
      assert.equal(journal.db.prepare('pragma user_version').get().user_version, 0)
    } finally {
      journal.close()
    }
  })
})

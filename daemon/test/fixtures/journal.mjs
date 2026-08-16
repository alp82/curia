// Read a journal the daemon wrote, the way the operator's shell does (#320):
// a read-only connection over `daemon/data/events.db`, and one query.
//
// The suite used to read `events.jsonl` with `fs.readFileSync`. The journal is a
// `node:sqlite` database since #407, so a test that asserts what the daemon
// journalled asks the journal for it. `body` is the line curia serialized, byte
// for byte, so these answers are the ones the file gave.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { JOURNAL, Journal, openJournal } from '../../src/journal.mjs'
import { Questions } from '../../src/questions.mjs'

// The verbatim lines, oldest first. Empty for a journal nothing has written,
// which is what an absent file used to mean.
export function journalLines(dataDir) {
  const file = path.join(dataDir, JOURNAL)
  if (!fs.existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('select body from events order by id').all().map((r) => r.body)
  } finally {
    db.close()
  }
}

// The same rows, parsed.
export function journalEvents(dataDir) {
  return journalLines(dataDir).map((line) => JSON.parse(line))
}

// The whole journal as one text, for a test that only asks whether a word
// reached the record.
export function journalText(dataDir) {
  return journalLines(dataDir).join('\n')
}

// The questions over a journal nothing has written, for a test whose dispatcher
// never reads its own past. Every answer is the one an empty journal gives, and
// no file is touched.
export function emptyQuestions() {
  return new Questions(new Journal(':memory:').db)
}

// The half of the reduction a Dispatcher test needs (#408): the write verb, and
// the questions the dispatcher asks about its own past.
//
// A test double used to hold the journal in an array, because the dispatcher
// read one back. It asks fifteen keyed queries now, so the double writes to a
// REAL journal in `dataDir` and answers off it — otherwise every question would
// say "never happened" and the tests would prove the opposite of what they
// assert. `events` is the same array as before, for the tests that read it.
export function journalDouble(dataDir, { stamp = true } = {}) {
  const db = openJournal(dataDir)
  const events = []
  return {
    events,
    questions: new Questions(db.db),
    journal: (type, data) => {
      const rec = stamp ? { type, ts: new Date().toISOString(), ...data } : { type, ...data }
      db.append(JSON.stringify(rec))
      events.push(rec)
      return rec
    },
    close: () => db.close(),
  }
}

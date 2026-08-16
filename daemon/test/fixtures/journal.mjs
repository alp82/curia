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
import { JOURNAL } from '../../src/journal.mjs'

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

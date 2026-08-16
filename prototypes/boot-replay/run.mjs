// What the boot replay costs, and whether it can be narrowed (#322).
//
//   node prototypes/boot-replay/run.mjs
//
// It builds the same synthetic journal #321 used, at the same four sizes, then
// boots the daemon's OWN reducer three ways over it:
//
//   1. from the file, exactly as `EscalationStore._replay` does today
//   2. from the journal, `select body from events order by id`
//   3. narrowed: scan only the computed half, query the verbatim three
//
// It checks all three end at the same reduction, field by field, and writes
// `results.json` beside itself.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { synthesize } from '../journal-schema/synth.mjs'
import { openJournal } from '../journal-schema/journal.mjs'
import { enrichedJournal } from './traffic.mjs'
import { bootFromFile, bootFromJournal, bootFromJournalBatched, bootFromJournalAll, bootNarrowed, snapshot, diffFields, checkTypeList, COMPUTED_TYPES } from './reduce.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-replay-'))

// The sizes of #321's cost table. 4,282 is the live journal on 2026-08-13.
const SIZES = [4282, 30000, 60000, 250000]
const LIVE = 4282

const now = () => process.hrtime.bigint()

function timed(fn, iterations) {
  fn() // warm
  const t0 = now()
  for (let i = 0; i < iterations; i++) fn()
  return Number(Number(now() - t0) / 1e6 / iterations).toFixed(2) * 1
}

const typeCheck = checkTypeList(fs.readFileSync(path.join(here, '../../daemon/src/store.mjs'), 'utf8'))
if (typeCheck.missing.length) {
  console.error(`the reducer switch has moved on: ${typeCheck.missing.join(', ')} is not in COMPUTED_TYPES`)
  process.exit(1)
}

const results = {
  built: 'prototypes/boot-replay/run.mjs',
  node: process.version,
  computedTypes: COMPUTED_TYPES.length,
  switchTypes: typeCheck.switchTypes,
  sizes: [],
}

for (const size of SIZES) {
  process.stdout.write(`building ${size}…`)
  const { lines } = enrichedJournal(synthesize, size)
  const file = path.join(tmp, `events-${size}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
  const dbFile = path.join(tmp, `events-${size}.db`)
  const j = openJournal(dbFile, { epochColumn: true })
  j.appendAll(lines)

  const dir = path.join(tmp, `reduce-${size}`)
  const fromFile = bootFromFile(dir, file)
  const fromJournal = bootFromJournal(dir, j.db)
  const batched = bootFromJournalBatched(dir, j.db)
  const narrowed = bootNarrowed(dir, j.db)

  // How much of the journal the narrowed scan actually reads.
  const marks = COMPUTED_TYPES.map(() => '?').join(',')
  const scanned = j.db.prepare(`select count(*) as n from events where type in (${marks})`).get(...COMPUTED_TYPES).n

  const iterations = size > 100000 ? 3 : size < 10000 ? 30 : 10
  const entry = {
    size,
    actual: lines.length,
    live: size === LIVE,
    fileBytes: fs.statSync(file).size,
    scannedRows: scanned,
    scannedShare: Number((scanned / lines.length).toFixed(3)),
    fileMs: timed(() => bootFromFile(dir, file), iterations),
    journalMs: timed(() => bootFromJournal(dir, j.db), iterations),
    journalBatchedMs: timed(() => bootFromJournalBatched(dir, j.db), iterations),
    journalAllMs: timed(() => bootFromJournalAll(dir, j.db), iterations),
    narrowedMs: timed(() => bootNarrowed(dir, j.db), iterations),
    agents: fromFile.lastAgentEvents.size,
    escalations: fromFile.escalations.size,
    notes: fromFile.notes.size,
    openTurns: fromFile.pendingTurns.size,
    threads: fromFile.ticketThreads.size,
    conversations: fromFile.consoleConversations.size,
    equivalence: {
      journal: diffFields(snapshot(fromFile), snapshot(fromJournal)),
      batched: diffFields(snapshot(fromFile), snapshot(batched)),
      narrowed: diffFields(snapshot(fromFile), snapshot(narrowed)),
    },
    // Where the boot spends its time. Three stages, each one the one before it
    // plus a step, so the difference between two rows is what that step costs.
    stages: {
      fileRead: timed(() => fs.readFileSync(file, 'utf8').split('\n').length, iterations),
      rowRead: timed(() => {
        let n = 0
        for (const row of j.db.prepare('select body from events order by id').iterate()) n += row.body.length
        return n
      }, iterations),
      rowReadAll: timed(() => j.db.prepare('select body from events order by id').all().length, iterations),
      filePlusParse: timed(() => {
        let n = 0
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (line.trim()) n += JSON.parse(line).type.length }
        return n
      }, iterations),
      rowPlusParse: timed(() => {
        let n = 0
        for (const row of j.db.prepare('select body from events order by id').iterate()) n += JSON.parse(row.body).type.length
        return n
      }, iterations),
    },
  }
  results.sizes.push(entry)
  j.close()
  const ok = !entry.equivalence.journal.length && !entry.equivalence.batched.length && !entry.equivalence.narrowed.length
  process.stdout.write(` ${ok ? 'ok' : 'DIFFERS'}\n`)
}

fs.writeFileSync(path.join(here, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)

console.log(`\nthe reducer acts on ${results.computedTypes} types, ${results.switchTypes} of them in its switch\n`)
for (const s of results.sizes) {
  console.log(`${s.size} events${s.live ? ' (the live journal today)' : ''}`)
  console.log(`  from the file today:   ${s.fileMs} ms`)
  console.log(`  from the journal, row by row: ${s.journalMs} ms`)
  console.log(`  from the journal, batched:    ${s.journalBatchedMs} ms`)
  console.log(`  from the journal, all at once:${s.journalAllMs} ms`)
  console.log(`  narrowed + 3 queries:  ${s.narrowedMs} ms  (scans ${s.scannedRows} rows, ${(s.scannedShare * 100).toFixed(1)}%)`)
  console.log(`  it holds ${s.escalations} escalations, ${s.agents} agents, ${s.openTurns} killed turns, ${s.notes} notes`)
  const st = s.stages
  console.log(`  stages: read ${st.fileRead} ms file / ${st.rowRead} ms rows (${st.rowReadAll} ms materialized)`)
  console.log(`          + JSON.parse ${st.filePlusParse} ms file / ${st.rowPlusParse} ms rows`)
  const d = s.equivalence
  console.log(`  same reduction: journal ${d.journal.length ? d.journal.join(',') : 'yes'}; batched ${d.batched.length ? d.batched.join(',') : 'yes'}; narrowed ${d.narrowed.length ? d.narrowed.join(',') : 'yes'}`)
}
console.log(`\nresults.json written. Temp fixtures in ${tmp}`)

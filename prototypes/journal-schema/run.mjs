// The prototype's one entry point (#321).
//
//   node prototypes/journal-schema/run.mjs
//
// It builds a synthetic journal, loads it into the schema, checks all fourteen
// queries against the daemon's own loop, times both, measures the write path
// and the file on disk, runs the operator's five README queries, and writes
// `results.json` beside itself. `demo.mjs` turns that into the one HTML page.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { normalizeEvent } from '../../daemon/src/journal.mjs'
import { Reduction } from '../../daemon/src/reduction.mjs'
import { synthesize } from './synth.mjs'
import { oracle } from './oracle.mjs'
import { QUERIES, OPERATOR_QUERIES } from './queries.mjs'
import { openJournal } from './journal.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-schema-'))

// The sizes from the cost table in docs/research/journal-scan-cost.md, plus
// the live one the operator measured on the box: 4,282 events on 2026-08-13.
const SIZES = [4282, 30000, 60000, 250000]
const LIVE = 4282

const ms = (t) => Number((Number(t) / 1e6).toFixed(3))
const now = () => process.hrtime.bigint()

function timed(fn, iterations) {
  fn() // warm
  const t0 = now()
  for (let i = 0; i < iterations; i++) fn()
  return Number(now() - t0) / 1e6 / iterations
}

// ---------------------------------------------------------------- the fixture

function buildFixture(size) {
  const { lines, tickets } = synthesize(size)
  const file = path.join(tmp, `events-${size}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
  const dbFile = path.join(tmp, `events-${size}.db`)
  const j = openJournal(dbFile, { epochColumn: true })
  const t0 = now()
  j.appendAll(lines)
  const loadMs = ms(now() - t0)
  const plainFile = path.join(tmp, `plain-${size}.db`)
  const plain = openJournal(plainFile, { epochColumn: false })
  plain.appendAll(lines)
  return { lines, tickets, file, dbFile, plainFile, j, plain, loadMs }
}

// What the daemon does today: read the whole file, split, parse, normalize.
function wholeRead(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    events.push(normalizeEvent(JSON.parse(line)))
  }
  return events
}

// ------------------------------------------------------------------- checking

// Every key the checker asks about: real tickets, their builders, their
// reviewers, and keys nothing ever wrote.
function keysFor(journal, tickets) {
  const reviewers = [...new Set(journal.filter((e) => /^curia-review-/.test(e.agent ?? '')).map((e) => e.agent))]
  const keys = []
  for (const t of tickets) keys.push({ ticket: t, agent: `curia-${t}` })
  for (const a of reviewers) keys.push({ ticket: a.match(/(\d+)$/)[1], agent: a })
  keys.push({ ticket: '999999', agent: 'curia-999999' }) // nothing ever wrote it
  return keys
}

function checkEquivalence(db, journal, keys) {
  const out = { checks: 0, mismatches: [] }
  for (const q of QUERIES) {
    const stmt = db.prepare(q.sql)
    if (q.whole) {
      const got = q.read(stmt.all())
      const want = oracle[q.oracle](journal)
      try {
        assert.deepStrictEqual([...got.entries()].sort(), [...want.entries()].sort())
      } catch (e) {
        out.mismatches.push({ n: q.n, key: 'every ticket', why: e.message.split('\n')[0] })
      }
      out.checks++
      continue
    }
    for (const key of keys) {
      const got = q.read(stmt.all(q.args(key)))
      const want = oracle[q.oracle](journal, key)
      out.checks++
      try {
        assert.deepStrictEqual(got, want)
      } catch (e) {
        if (out.mismatches.length < 8) out.mismatches.push({ n: q.n, key: `${key.ticket}/${key.agent}`, why: e.message.split('\n')[0] })
      }
    }
  }
  return out
}

// ------------------------------------------------------------------ the costs

function benchQueries(fixture, journal, keys) {
  const db = fixture.j.db
  const plainDb = fixture.plain.db
  const sample = keys.filter((k) => k.ticket !== '999999').slice(0, 40)
  const sqlIters = fixture.lines.length > 100000 ? 50 : 200
  const scanIters = fixture.lines.length > 100000 ? 2 : (fixture.lines.length > 20000 ? 5 : 20)
  const rows = []
  for (const q of QUERIES) {
    const stmt = db.prepare(q.sql)
    // The same question on the table with NO epoch column: its own SQL, its
    // own database, so the comparison is honest about both.
    const plainStmt = plainDb.prepare(q.plain ?? q.sql)
    let i = 0
    const next = () => sample[i++ % sample.length]
    const sqlMs = q.whole
      ? timed(() => stmt.all(), 10)
      : timed(() => stmt.all(q.args(next())), sqlIters)
    const plainMs = q.whole
      ? timed(() => plainStmt.all(), 10)
      : timed(() => plainStmt.all(q.args(next())), sqlIters)
    // The scan the daemon runs today, WITHOUT the read that feeds it. The read
    // is one number per size (`wholeReadMs`), and it dominates both.
    const scanMs = q.whole
      ? timed(() => oracle[q.oracle](journal), Math.max(2, Math.floor(scanIters / 4)))
      : timed(() => oracle[q.oracle](journal, next()), scanIters)
    rows.push({
      n: q.n,
      shape: q.shape,
      where: q.where,
      question: q.question,
      note: q.note ?? null,
      sql: q.sql,
      plain: q.plain ?? null,
      sqlMs: Number(sqlMs.toFixed(4)),
      plainMs: Number(plainMs.toFixed(4)),
      scanMs: Number(scanMs.toFixed(4)),
      plan: db.prepare(`explain query plan ${q.sql}`).all(q.whole ? {} : q.args(sample[0])).map((r) => r.detail),
    })
  }
  return rows
}

// The write path: one event, committed, the way the daemon commits it.
function benchWrite(size) {
  const { lines } = synthesize(2000, { seed: 11, firstTicket: 5000 })
  const out = {}
  for (const epochColumn of [true, false]) {
    const file = path.join(tmp, `write-${epochColumn}-${size}.db`)
    const j = openJournal(file, { epochColumn })
    j.appendAll(synthesize(size, { seed: 3 }).lines) // a journal of realistic depth first
    const t0 = now()
    for (const line of lines) j.append(line) // one implicit transaction each
    const per = Number(now() - t0) / 1e6 / lines.length
    out[epochColumn ? 'stamped' : 'plain'] = Number(per.toFixed(3))
    j.close()
  }
  return out
}

function dbSizes(fixture) {
  const db = fixture.j.db
  db.exec('pragma wal_checkpoint(truncate)')
  const bytes = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0)
  const perIndex = db.prepare(`
    select name, sum(pgsize) as bytes from dbstat where name like 'events%' group by name order by 2 desc
  `).all().map((r) => ({ name: r.name, bytes: Number(r.bytes) }))
  return {
    journalFileBytes: bytes(fixture.file),
    dbBytes: bytes(fixture.dbFile),
    plainDbBytes: bytes(fixture.plainFile),
    perIndex,
  }
}

// ------------------------------------------------------- the operator's five

function operatorRun(fixture, journal) {
  const db = fixture.j.db
  // A ticket out of the OLD part of the journal, so query one and query five
  // both run against pre-#184 lines. That is the harder case, and the one the
  // operator hits at 2 a.m. on a ticket from July.
  const ticket = journal.find((e) => e.type === 'dispatch_claimed').ticket
  const agent = `curia-${ticket}`
  const id = Math.floor(fixture.lines.length / 2)
  const rows = []
  for (const q of OPERATOR_QUERIES) {
    const sql = q.sql({ ticket, id, agent })
    const t0 = now()
    const result = db.prepare(sql).all()
    rows.push({
      title: q.title,
      sql,
      note: q.note ?? null,
      ms: ms(now() - t0),
      count: result.length,
      sample: result.slice(0, 4).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v]))),
    })
  }
  return rows
}

// The two claims the schema makes about the record itself.
function fidelity(fixture, journal) {
  const db = fixture.j.db
  const lines = fs.readFileSync(fixture.file, 'utf8').split('\n').filter(Boolean)
  const back = db.prepare('select body from events order by id').all().map((r) => r.body)
  const byteForByte = back.length === lines.length && back.every((b, i) => b === lines[i])

  // The #184 proof: a row whose body says "worker", found through the agent column.
  const legacyRow = db.prepare(`
    select id, agent, type, body from events
     where body like '%"worker":%' and agent is not null
     order by id limit 1`).get()
  const foundByAgent = legacyRow
    ? db.prepare('select count(*) as n from events where agent = :a').get({ a: legacyRow.agent }).n
    : 0
  const legacyTypeNormalized = legacyRow
    ? db.prepare("select count(*) as n from events where type = 'agent_spawned' and body like '%worker_spawned%'").get().n
    : 0

  // The affinity proof: `where ticket=320`, a bare integer literal against a
  // TEXT column, typed exactly as the README types it.
  const t = journal.find((e) => e.ticket != null).ticket
  const asNumber = db.prepare(`select count(*) as n from events where ticket=${t}`).get().n
  const asText = db.prepare(`select count(*) as n from events where ticket='${t}'`).get().n

  // The write-path hazard this prototype found. node:sqlite binds a JS number
  // as a REAL, so `ticket: 321` straight off the event lands in a TEXT column
  // as the string "321.0" — and every `where ticket=321` then misses it. The
  // extraction stringifies for exactly this reason.
  const numbers = (() => {
    const probe = (value) => {
      db.prepare('insert into events (ts, type, ticket, agent, repo, body) values (?, ?, ?, ?, ?, ?)')
        .run('2026-08-16T00:00:00.000Z', 'probe', value, null, null, '{"probe":true}')
      const row = db.prepare("select ticket, typeof(ticket) as t from events where type='probe'").get()
      db.exec("delete from events where type='probe'")
      return { stored: row.ticket, typeof: row.t }
    }
    return { bound_number: probe(321), bound_string: probe('321') }
  })()

  // STRICT is the point of #320's ruling that the shell comes out of the image.
  const strict = (() => {
    try {
      db.exec("insert into events (ts, type, ticket, agent, repo, body) values (x'00', 'probe', null, null, null, '{}')")
      db.exec("delete from events where type='probe'")
      return { blobIntoText: 'accepted' }
    } catch (e) {
      return { blobIntoText: 'refused', message: e.message }
    }
  })()

  return {
    byteForByte,
    lines: lines.length,
    legacy: legacyRow
      ? { id: legacyRow.id, agent: legacyRow.agent, type: legacyRow.type, body: legacyRow.body.slice(0, 200), foundByAgent, legacyTypeNormalized }
      : null,
    affinity: { ticket: String(t), asNumber, asText, equal: asNumber === asText && asNumber > 0 },
    numbers,
    strict,
    types: db.prepare('select count(distinct type) as n from events').get().n,
    bytesPerLine: Math.round(fs.statSync(fixture.file).size / lines.length),
  }
}

// ------------------------------------------------- why the cut is an id, not a ts
//
// The operator asked what `epoch` buys over `ts`. This measures it against the
// daemon's OWN writer rather than the synthetic journal, whose stamps are
// spaced by construction.
//
// `_append` stamps `new Date().toISOString()`, which is milliseconds, and
// nothing makes it unique. Two events in one millisecond tie, and a `ts >`
// comparison at the epoch boundary then answers the wrong question: `>` drops
// every row that shares the opener's stamp, and `>=` takes rows written before
// it. The ten scans this schema replaces compare POSITION in the file, so an
// id reproduces their rule exactly and a stamp does not.
function stampEvidence() {
  const dir = fs.mkdtempSync(path.join(tmp, 'stamps-'))
  const reduction = new Reduction(dir)
  for (let i = 0; i < 2000; i++) reduction.journal('probe', { ticket: 900, agent: 'curia-900', i })
  const stamps = [...reduction.db.bodies()].map((b) => JSON.parse(b).ts)
  const counts = new Map()
  for (const s of stamps) counts.set(s, (counts.get(s) ?? 0) + 1)

  // The boundary itself. A dispatch is claimed and the pull request lands in
  // the SAME millisecond, which is what happens whenever two `journal` calls
  // sit in one tick. Pairs are written until one ties, and the count says how
  // hard that was to provoke through the daemon's own writer.
  const dir2 = fs.mkdtempSync(path.join(tmp, 'boundary-'))
  const reduction2 = new Reduction(dir2)
  let pairs = 0
  let tie = null
  while (!tie && pairs < 500) {
    const ticket = 901 + pairs
    pairs++
    const a = reduction2.journal('dispatch_claimed', { repo: 'alp82/curia', ticket, agent: `curia-${ticket}`, by: 'auto' })
    const b = reduction2.journal('pr_opened', { repo: 'alp82/curia', ticket, agent: `curia-${ticket}`, url: 'https://example.invalid/1' })
    if (a.ts === b.ts) tie = { ticket: String(ticket), ts: a.ts }
  }

  const probe = openJournal(path.join(tmp, 'boundary.db'), { epochColumn: true })
  probe.appendAll([...reduction2.db.bodies()])
  const ask = (sql) => Boolean(probe.db.prepare(sql).get({ t: tie?.ticket ?? '0' }).answer)
  // "Did this dispatch push a pull request?", cut by the id and cut by the stamp.
  const byId = ask(`
    select exists(select 1 from events where ticket = :t and type = 'pr_opened'
      and id > (select coalesce(max(epoch), 0) from events where ticket = :t)) as answer`)
  const byTs = ask(`
    select exists(select 1 from events where ticket = :t and type = 'pr_opened'
      and ts > (select ts from events where ticket = :t and type = 'dispatch_claimed'
                 order by id desc limit 1)) as answer`)
  probe.close()

  return {
    events: stamps.length,
    distinctStamps: counts.size,
    mostOnOneStamp: Math.max(...counts.values()),
    boundary: tie ? { ...tie, pairs, byId, byTs } : { tied: false, pairs },
  }
}

// ----------------------------------------------------------------------- main

const results = {
  node: process.version,
  sqlite: new DatabaseSync(':memory:').prepare('select sqlite_version() as v').get().v,
  stamps: stampEvidence(),
  sizes: [],
}

for (const size of SIZES) {
  process.stdout.write(`building ${size}…`)
  const fixture = buildFixture(size)
  const journal = wholeRead(fixture.file)
  const keys = keysFor(journal, fixture.tickets)

  const readMs = timed(() => wholeRead(fixture.file), size > 100000 ? 3 : 10)
  const entry = {
    size,
    live: size === LIVE,
    tickets: fixture.tickets.length,
    loadMs: fixture.loadMs,
    wholeReadMs: Number(readMs.toFixed(2)),
    sizes: dbSizes(fixture),
  }

  // Equivalence is checked over every ticket and every agent the journal
  // holds, up to a cap. Above the cap the keys are taken evenly across the
  // whole journal, so the oldest dispatches are checked too, and the page says
  // the sample was capped.
  const CAP = 400
  const sample = keys.length > CAP ? keys.filter((_, i) => i % Math.ceil(keys.length / CAP) === 0) : keys
  entry.equivalence = { ...checkEquivalence(fixture.j.db, journal, sample), keys: sample.length, capped: sample.length !== keys.length }
  entry.queries = benchQueries(fixture, journal, keys)
  if (size === LIVE || size === 60000) {
    entry.operator = operatorRun(fixture, journal)
    entry.fidelity = fidelity(fixture, journal)
    entry.write = benchWrite(size)
  }
  results.sizes.push(entry)
  fixture.j.close()
  fixture.plain.close()
  process.stdout.write(` ${entry.equivalence.mismatches.length ? 'MISMATCHES' : 'ok'}\n`)
}

fs.writeFileSync(path.join(here, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)

// The console verdict. The page says it again, for a phone.
for (const s of results.sizes) {
  const q = s.queries
  const worst = q.reduce((a, b) => (b.sqlMs > a.sqlMs ? b : a))
  const keyed = q.filter((x) => x.n !== 12)
  const total = keyed.reduce((a, b) => a + b.sqlMs, 0)
  console.log(`\n${s.size} events${s.live ? ' (the live journal today)' : ''}`)
  console.log(`  db ${(s.sizes.dbBytes / 1e6).toFixed(2)} MB against a ${(s.sizes.journalFileBytes / 1e6).toFixed(2)} MB file`)
  console.log(`  one whole read today: ${s.wholeReadMs} ms`)
  console.log(`  the thirteen keyed queries, all of them: ${total.toFixed(3)} ms; worst single ${worst.sqlMs} ms (q${worst.n})`)
  console.log(`  q12, every ticket at once: ${q.find((x) => x.n === 12).sqlMs} ms`)
  console.log(`  equivalence: ${s.equivalence.checks} checks over ${s.equivalence.keys} keys, ${s.equivalence.mismatches.length} mismatches`)
  for (const m of s.equivalence.mismatches) console.log(`    q${m.n} ${m.key}: ${m.why}`)
  if (s.write) console.log(`  one committed insert: ${s.write.stamped} ms stamped, ${s.write.plain} ms without the epoch column`)
}
const st = results.stamps
console.log(`\nthe stamp: ${st.events} events through the daemon's own writer carried ${st.distinctStamps} distinct stamps, up to ${st.mostOnOneStamp} on one`)
console.log(`  a claim and its pull request tied on one stamp after ${st.boundary.pairs} pair(s): by id ${st.boundary.byId}, by ts ${st.boundary.byTs}`)
console.log(`\nresults.json written. Temp fixtures in ${tmp}`)

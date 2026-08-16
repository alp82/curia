// The journal backup (#436, from #357 and ADR-0017).
//
// What is pinned here is the CADENCE, the RETENTION and the ALARM, because
// those are the three rules that decide whether the box still holds a usable
// dump on the day the journal is corrupt.
//
// The dump spawns a real child process, so most of these tests hand the watch a
// stub `sqlite3` they write themselves. That keeps the whole suite honest about
// the exit code, the stderr and the empty dump, on a box with no SQLite shell.
// One describe at the end runs the real binary, and it states why it skipped
// when the box carries none. The daemon image carries `sqlite3` since #409.

import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import {
  BACKUP_DIR, CHECK_INTERVAL_MS, DUMP_AGE_MS, STALE_AGE_MS, KEEP,
  stampFor, dumpName, stampAt, dumpsIn, prune, ageHours,
  writeDump, failedLine, recoveredLine, JournalBackup,
} from '../src/backup.mjs'
import { Reduction } from '../src/reduction.mjs'

const HOUR = 60 * 60 * 1000

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-backup-')) })

// A stub `sqlite3`. It answers the arguments the dump passes and nothing else,
// so a test that gets the argument order wrong fails instead of passing quietly.
function stubSqlite(behavior = {}) {
  const { sql = 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCOMMIT;\n', code = 0, stderr = '' } = behavior
  const bin = path.join(dir, 'sqlite3-stub')
  // The SQL and the stderr sit in files beside the stub, so no shell quoting
  // stands between what a test writes and what the dump reads.
  const out = `${bin}.out`
  const err = `${bin}.err`
  fs.writeFileSync(out, sql)
  fs.writeFileSync(err, stderr)
  fs.writeFileSync(bin, [
    '#!/bin/bash',
    'if [ "$1" != "-readonly" ]; then echo "the dump did not ask for a read-only connection" >&2; exit 90; fi',
    'if [ "$3" != ".dump" ]; then echo "the dump did not ask for .dump" >&2; exit 91; fi',
    'if [ ! -f "$2" ]; then echo "no such database: $2" >&2; exit 92; fi',
    `cat ${JSON.stringify(err)} >&2`,
    `cat ${JSON.stringify(out)}`,
    `exit ${code}`,
  ].join('\n'))
  fs.chmodSync(bin, 0o755)
  return bin
}

// The journal the dump reads. Its content never matters to the stub, but its
// existence does: a dump of a database that is not there must fail.
function fakeJournal() {
  const file = path.join(dir, 'events.db')
  fs.writeFileSync(file, 'not really a database')
  return file
}

// The reduction's own memory of the standing alarm, driven by the same two
// event types `reduction.mjs` reduces.
function fakeReduction() {
  let alarm = null
  const events = []
  return {
    events,
    standing: () => (alarm ? { ...alarm } : null),
    journal: (type, ev) => {
      events.push({ type, ...ev })
      if (type === 'journal_backup_failed') alarm = { ...ev }
      if (type === 'journal_backup') alarm = null
    },
  }
}

function watchOver(reduction, { bin, now, bridge = true, keep = KEEP } = {}) {
  const said = []
  const backup = new JournalBackup({
    dataDir: dir,
    dbFile: fakeJournal(),
    bin,
    keep,
    now: () => (typeof now === 'function' ? now() : now ?? Date.now()),
    journal: reduction.journal,
    standing: reduction.standing,
    announce: (text) => {
      if (!bridge) return false
      said.push(text)
      return Promise.resolve(true)
    },
    log: () => {},
  })
  return { backup, said }
}

// A dump that already exists, at the age the test needs.
function seedDump(at, bytes = 'x') {
  const backups = path.join(dir, BACKUP_DIR)
  fs.mkdirSync(backups, { recursive: true })
  const name = dumpName(at)
  fs.writeFileSync(path.join(backups, name), bytes)
  return name
}

describe('the name states the instant, in UTC', () => {
  test('the stamp is UTC seconds with no colon in it', () => {
    const at = Date.parse('2026-08-16T09:07:05.412Z')
    assert.equal(stampFor(at), '2026-08-16T09-07-05Z')
    assert.equal(dumpName(at), 'events-2026-08-16T09-07-05Z.sql.gz')
  })

  test('a name reads back as the instant it states', () => {
    const at = Date.parse('2026-08-16T09:07:05.000Z')
    assert.equal(stampAt(dumpName(at)), at)
  })

  test('anything that is not a dump reads as no instant at all', () => {
    // The half-written file a killed dump leaves behind is the one that matters:
    // it must never pass for a backup, or the retention counts it as one.
    assert.equal(stampAt('events-2026-08-16T09-07-05Z.sql.gz.part'), null)
    assert.equal(stampAt('events.db'), null)
    assert.equal(stampAt('events-2026-08-16.sql.gz'), null)
    assert.equal(stampAt('README.md'), null)
  })

  test('the names sort in write order as plain text', () => {
    const names = [
      dumpName(Date.parse('2026-08-09T00:00:00Z')),
      dumpName(Date.parse('2026-08-16T00:00:00Z')),
      dumpName(Date.parse('2026-01-01T00:00:00Z')),
    ]
    assert.deepEqual([...names].sort(), [names[2], names[0], names[1]])
  })
})

describe('the set on disk reads newest first', () => {
  test('a directory that does not exist yet holds no dumps', () => {
    assert.deepEqual(dumpsIn(path.join(dir, BACKUP_DIR)), [])
  })

  test('the dumps come back newest first, and nothing else comes back', () => {
    const old = seedDump(Date.parse('2026-08-01T00:00:00Z'))
    const recent = seedDump(Date.parse('2026-08-16T00:00:00Z'))
    fs.writeFileSync(path.join(dir, BACKUP_DIR, 'events-2026-08-17T00-00-00Z.sql.gz.part'), 'half')
    const found = dumpsIn(path.join(dir, BACKUP_DIR))
    assert.deepEqual(found.map((d) => d.name), [recent, old])
  })
})

describe('fourteen are kept', () => {
  test('the newest fourteen stay and the rest go', () => {
    const base = Date.parse('2026-08-16T00:00:00Z')
    const names = []
    for (let i = 0; i < 20; i++) names.push(seedDump(base - i * 24 * HOUR))
    const deleted = prune(path.join(dir, BACKUP_DIR))
    assert.equal(deleted.length, 6)
    const left = dumpsIn(path.join(dir, BACKUP_DIR)).map((d) => d.name)
    assert.equal(left.length, KEEP)
    // The newest fourteen, and the six oldest are the ones that went.
    assert.deepEqual(left, names.slice(0, KEEP))
    assert.deepEqual(deleted.sort(), names.slice(KEEP).sort())
  })

  test('a set under the count loses nothing', () => {
    seedDump(Date.parse('2026-08-16T00:00:00Z'))
    assert.deepEqual(prune(path.join(dir, BACKUP_DIR)), [])
    assert.equal(dumpsIn(path.join(dir, BACKUP_DIR)).length, 1)
  })
})

describe('one dump', () => {
  test('it writes gzipped SQL text under the stamped name', async () => {
    const sql = 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nINSERT INTO events VALUES(1);\nCOMMIT;\n'
    const at = Date.parse('2026-08-16T09:07:05Z')
    const res = await writeDump({
      dbFile: fakeJournal(), dir: path.join(dir, BACKUP_DIR), at, bin: stubSqlite({ sql }),
    })
    assert.equal(res.name, dumpName(at))
    const file = path.join(dir, BACKUP_DIR, res.name)
    assert.equal(zlib.gunzipSync(fs.readFileSync(file)).toString(), sql)
    assert.equal(res.bytes, fs.statSync(file).size)
  })

  test('a dump that fails leaves nothing behind, and says what the shell said', async () => {
    await assert.rejects(
      writeDump({
        dbFile: fakeJournal(),
        dir: path.join(dir, BACKUP_DIR),
        at: Date.now(),
        bin: stubSqlite({ sql: '', code: 1, stderr: 'Error: database disk image is malformed' }),
      }),
      /exited 1: Error: database disk image is malformed/,
    )
    // Not even a `.part` file: a half dump that survives is a backup that lies.
    assert.deepEqual(fs.readdirSync(path.join(dir, BACKUP_DIR)), [])
  })

  test('a shell that is not on the box fails by name', async () => {
    await assert.rejects(
      writeDump({ dbFile: fakeJournal(), dir: path.join(dir, BACKUP_DIR), at: Date.now(), bin: path.join(dir, 'no-such-sqlite3') }),
      /did not run/,
    )
  })

  test('an exit 0 with no SQL behind it is a failure, not a backup', async () => {
    // This is the one failure that would otherwise be silent: a valid gzip file
    // holding nothing would stand in the retention and push a real dump out.
    await assert.rejects(
      writeDump({ dbFile: fakeJournal(), dir: path.join(dir, BACKUP_DIR), at: Date.now(), bin: stubSqlite({ sql: '' }) }),
      /wrote no SQL/,
    )
    assert.deepEqual(fs.readdirSync(path.join(dir, BACKUP_DIR)), [])
  })
})

describe('the cadence is a check, never a timer', () => {
  test('the check runs hourly and the dump is due at a day', () => {
    assert.equal(CHECK_INTERVAL_MS, HOUR)
    assert.equal(DUMP_AGE_MS, 24 * HOUR)
    assert.equal(STALE_AGE_MS, 48 * HOUR)
  })

  test('a box with no dump at all dumps at once', async () => {
    const reduction = fakeReduction()
    const { backup, said } = watchOver(reduction, { bin: stubSqlite(), now: Date.parse('2026-08-16T09:00:00Z') })
    assert.ok(await backup.pass())
    assert.equal(dumpsIn(path.join(dir, BACKUP_DIR)).length, 1)
    // The first dump on a fresh box is an ordinary success, so it says nothing.
    assert.deepEqual(said, [])
    assert.equal(reduction.events.at(-1).type, 'journal_backup')
    assert.equal(reduction.events.at(-1).lapse_h, null)
  })

  test('a dump under a day old is left alone', async () => {
    const now = Date.parse('2026-08-16T09:00:00Z')
    const name = seedDump(now - 23 * HOUR)
    const reduction = fakeReduction()
    const { backup } = watchOver(reduction, { bin: stubSqlite(), now })
    assert.equal(await backup.pass(), null)
    assert.deepEqual(dumpsIn(path.join(dir, BACKUP_DIR)).map((d) => d.name), [name])
    assert.deepEqual(reduction.events, [])
  })

  test('a dump a day old or older is taken again', async () => {
    const now = Date.parse('2026-08-16T09:00:00Z')
    seedDump(now - 24 * HOUR)
    const reduction = fakeReduction()
    const { backup } = watchOver(reduction, { bin: stubSqlite(), now })
    assert.ok(await backup.pass())
    assert.equal(dumpsIn(path.join(dir, BACKUP_DIR)).length, 2)
  })

  test('a restart takes no dump the boot before it already took', async () => {
    // The rule the plain 24-hour timer breaks: a box that deploys daily rearms
    // that timer every day and never dumps. This check reads the disk instead.
    const now = Date.parse('2026-08-16T09:00:00Z')
    const reduction = fakeReduction()
    const first = watchOver(reduction, { bin: stubSqlite(), now })
    await first.backup.pass()
    const second = watchOver(reduction, { bin: stubSqlite(), now: now + 2 * HOUR })
    assert.equal(await second.backup.pass(), null)
    assert.equal(dumpsIn(path.join(dir, BACKUP_DIR)).length, 1)
  })

  test('a dump prunes the set it just joined', async () => {
    const now = Date.parse('2026-08-16T09:00:00Z')
    for (let i = 1; i <= KEEP; i++) seedDump(now - i * 24 * HOUR)
    const reduction = fakeReduction()
    const { backup } = watchOver(reduction, { bin: stubSqlite(), now })
    await backup.pass()
    const left = dumpsIn(path.join(dir, BACKUP_DIR))
    assert.equal(left.length, KEEP)
    assert.equal(left[0].name, dumpName(now))
    assert.equal(reduction.events.at(-1).deleted, 1)
    assert.equal(reduction.events.at(-1).kept, KEEP)
  })
})

describe('the channel is the alarm', () => {
  test('a failed dump reaches the channel and stands in the journal', async () => {
    const reduction = fakeReduction()
    const { backup, said } = watchOver(reduction, {
      bin: stubSqlite({ sql: '', code: 1, stderr: 'disk I/O error' }),
      now: Date.parse('2026-08-16T09:00:00Z'),
    })
    await backup.pass()
    assert.equal(said.length, 1)
    assert.match(said[0], /journal backup failed/)
    assert.match(said[0], /disk I\/O error/)
    const ev = reduction.events.at(-1)
    assert.equal(ev.type, 'journal_backup_failed')
    assert.equal(ev.said, true)
    assert.ok(reduction.standing())
  })

  test('the same failure is journalled every hour and said once', async () => {
    const reduction = fakeReduction()
    const bin = stubSqlite({ sql: '', code: 1, stderr: 'disk I/O error' })
    const now = Date.parse('2026-08-16T09:00:00Z')
    const { backup, said } = watchOver(reduction, { bin, now })
    await backup.pass()
    await backup.pass()
    await backup.pass()
    // A warning repeated hourly is a warning its reader learns to skip.
    assert.equal(said.length, 1)
    assert.equal(reduction.events.filter((e) => e.type === 'journal_backup_failed').length, 3)
  })

  test('a failure whose reason changed is news again', async () => {
    const reduction = fakeReduction()
    const now = Date.parse('2026-08-16T09:00:00Z')
    const first = watchOver(reduction, { bin: stubSqlite({ sql: '', code: 1, stderr: 'disk I/O error' }), now })
    await first.backup.pass()
    const second = watchOver(reduction, { bin: stubSqlite({ sql: '', code: 1, stderr: 'no such table' }), now })
    await second.backup.pass()
    assert.equal(second.said.length, 1)
    assert.match(second.said[0], /no such table/)
  })

  test('a line that never reached Discord is said again by the next pass', async () => {
    const reduction = fakeReduction()
    const bin = stubSqlite({ sql: '', code: 1, stderr: 'disk I/O error' })
    const now = Date.parse('2026-08-16T09:00:00Z')
    const down = watchOver(reduction, { bin, now, bridge: false })
    await down.backup.pass()
    assert.equal(reduction.standing().said, false)
    const up = watchOver(reduction, { bin, now })
    await up.backup.pass()
    assert.equal(up.said.length, 1)
    assert.equal(reduction.standing().said, true)
  })

  test('a failure that crosses 48 hours says so, once', async () => {
    const reduction = fakeReduction()
    const bin = stubSqlite({ sql: '', code: 1, stderr: 'disk I/O error' })
    const at = Date.parse('2026-08-16T09:00:00Z')
    seedDump(at)
    let now = at + 25 * HOUR
    const watch = watchOver(reduction, { bin, now: () => now })
    await watch.backup.pass()
    assert.equal(watch.said.length, 1)
    assert.match(watch.said[0], /25 hours old/)
    now = at + 49 * HOUR
    await watch.backup.pass()
    // Silence must never stand in for a check that stopped running, so the
    // crossing is news even though the reason did not change.
    assert.equal(watch.said.length, 2)
    assert.match(watch.said[1], /49 hours old/)
    now = at + 50 * HOUR
    await watch.backup.pass()
    assert.equal(watch.said.length, 2)
  })

  test('an ordinary success says nothing at all', async () => {
    const reduction = fakeReduction()
    const now = Date.parse('2026-08-16T09:00:00Z')
    seedDump(now - 25 * HOUR)
    const { backup, said } = watchOver(reduction, { bin: stubSqlite(), now })
    await backup.pass()
    assert.deepEqual(said, [])
  })

  test('a dump that lands after a failure clears the alarm and says so', async () => {
    const reduction = fakeReduction()
    const now = Date.parse('2026-08-16T09:00:00Z')
    const broken = watchOver(reduction, { bin: stubSqlite({ sql: '', code: 1, stderr: 'disk I/O error' }), now })
    await broken.backup.pass()
    const fixed = watchOver(reduction, { bin: stubSqlite(), now })
    await fixed.backup.pass()
    assert.equal(fixed.said.length, 1)
    assert.match(fixed.said[0], /current again/)
    assert.equal(reduction.standing(), null)
  })

  test('a dump that repairs a lapse nobody was told about says the age it repaired', async () => {
    // The daemon was off for three days. Nothing failed, so no alarm stands, and
    // the operator would otherwise never learn the box lost its cover.
    const reduction = fakeReduction()
    const now = Date.parse('2026-08-16T09:00:00Z')
    seedDump(now - 72 * HOUR)
    const { backup, said } = watchOver(reduction, { bin: stubSqlite(), now })
    await backup.pass()
    assert.equal(said.length, 1)
    assert.match(said[0], /72 hours old/)
    assert.equal(reduction.events.at(-1).lapse_h, 72)
  })
})

describe('the lines name the act that ends them', () => {
  test('a failure states the reason and the age', () => {
    assert.match(failedLine({ message: 'disk I/O error', age_h: 30 }), /30 hours old/)
    assert.match(failedLine({ message: 'disk I/O error', age_h: 1 }), /1 hour old/)
    assert.match(failedLine({ message: 'disk I/O error', age_h: null }), /no dump on the box at all/)
    assert.match(failedLine({ message: 'disk I/O error', age_h: 30 }), /sqlite3/)
  })

  test('a repaired lapse states the age, and an ordinary clear does not', () => {
    assert.match(recoveredLine({ lapse_h: 72 }), /72 hours/)
    assert.equal(recoveredLine({ lapse_h: null }), '✅ the journal backup is current again.')
    assert.equal(recoveredLine({ lapse_h: 3 }), '✅ the journal backup is current again.')
  })

  test('an age is measured in whole hours, and a missing dump has none', () => {
    const now = Date.parse('2026-08-16T09:00:00Z')
    assert.equal(ageHours({ at: now - 90 * 60 * 1000 }, now), 1)
    assert.equal(ageHours(null, now), null)
  })
})

describe('the reduction remembers the alarm across a restart', () => {
  test('a failure stands and a dump clears it', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-backup-reduction-'))
    const reduction = new Reduction(data)
    assert.equal(reduction.standingBackupAlarm(), null)
    reduction.journal('journal_backup_failed', { message: 'disk I/O error', age_h: 30, stale: false, said: true })
    assert.equal(reduction.standingBackupAlarm().message, 'disk I/O error')
    reduction.close()

    // The restart: a fresh reduction over the same journal.
    const booted = new Reduction(data)
    assert.equal(booted.standingBackupAlarm().message, 'disk I/O error')
    booted.journal('journal_backup', { file: 'backups/x.sql.gz', bytes: 10, kept: 1, deleted: 0, lapse_h: null })
    assert.equal(booted.standingBackupAlarm(), null)
    booted.close()
  })
})

// The real shell, when the box has one. The daemon image carries `sqlite3` since
// #409, so this runs on the box and in CI, and it states why it did not.
const sqliteVersion = (() => {
  try { return execFileSync('sqlite3', ['--version'], { encoding: 'utf8' }).trim() } catch { return null }
})()

describe('the real sqlite3 dumps a real journal', { skip: sqliteVersion ? false : 'no sqlite3 on this box — the daemon image carries one (#409)' }, () => {
  test('the dump restores into a database that holds the same rows', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-backup-real-'))
    const reduction = new Reduction(data)
    reduction.journal('journal_opened', { node: process.version, sqlite: process.versions.sqlite })
    reduction.journal('notify', { agent: 'curia-436', ticket: '436', message: 'the journal backs itself up' })
    reduction.close()

    const at = Date.parse('2026-08-16T09:07:05Z')
    const res = await writeDump({ dbFile: path.join(data, 'events.db'), dir: path.join(data, BACKUP_DIR), at })
    const sql = zlib.gunzipSync(fs.readFileSync(path.join(data, BACKUP_DIR, res.name))).toString()
    assert.match(sql, /CREATE TABLE.*events/s)
    assert.match(sql, /journal_opened/)

    // The restore recipe, in one line: zcat into a fresh database.
    const restored = path.join(data, 'restored.db')
    execFileSync('sqlite3', [restored], { input: sql })
    const rows = execFileSync('sqlite3', ['-readonly', '-noheader', '-list', restored, 'select type from events order by id'], { encoding: 'utf8' })
    assert.deepEqual(rows.trim().split('\n'), ['journal_opened', 'notify'])
  })

  test('the dump reads a journal the daemon still holds open', async () => {
    // Rule 2: the dump is a second, read-only connection. A dump that needed the
    // write connection would have to stop the daemon to take a backup.
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-backup-live-'))
    const reduction = new Reduction(data)
    reduction.journal('notify', { message: 'before the dump' })
    const res = await writeDump({ dbFile: path.join(data, 'events.db'), dir: path.join(data, BACKUP_DIR), at: Date.now() })
    reduction.journal('notify', { message: 'after the dump' })
    reduction.close()
    const sql = zlib.gunzipSync(fs.readFileSync(path.join(data, BACKUP_DIR, res.name))).toString()
    assert.match(sql, /before the dump/)
  })
})

// The journal backup (#436, from #357 and ADR-0017).
//
// The journal is curia's own brain and it lives on one box. This dump is what
// bounds the loss. The daemon spawns `sqlite3 <journal> .dump` on a second
// read-only connection, gzips the portable SQL text, and writes
// `daemon/data/backups/events-<UTC stamp>.sql.gz`. The image carries `sqlite3`
// since #409.
//
// Five rules settle it, and each one keeps a wrong answer out.
//
//   1. A CHECK, NOT A TIMER. The daemon checks at boot and every hour, and it
//      dumps when the newest dump is 24 hours old or older. A plain 24-hour
//      timer would never fire on a box that deploys daily, because a deploy
//      restarts the daemon and rearms the timer.
//
//   2. THE DUMP IS A SECOND CONNECTION. `sqlite3 -readonly` is its own process,
//      so the write connection is untouched and a dump can never block an
//      append. A read-only reader opens a hot WAL, which #320 measured.
//
//   3. FOURTEEN KEPT. The newest fourteen stay and the daemon deletes the rest.
//      This is a backup count. It is not journal retention, which stays
//      undecided.
//
//   4. THE CHANNEL IS THE ALARM, AND A SUCCESS SAYS NOTHING. A failed dump
//      reaches the channel. So does a dump that lands after the newest one went
//      over 48 hours old, because silence must never stand in for a check that
//      stopped running. An ordinary day carries no noise at all.
//
//   5. ONE LINE PER FACT. A failure states the age of the newest dump beside
//      the reason, and a repaired lapse states the age it repaired. The alarm
//      is edge-triggered off the journal, so a dump that fails for three days
//      says one line when it starts failing and one more when it crosses 48
//      hours. The reduction remembers what stands, so a deploy repeats nothing.
//
// The restore is a hand recipe in the daemon README. Curia ships no verb and no
// button for it, because a restore is rare and destructive and a human picks
// which dump.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

// Where the dumps live, under the data directory the journal itself sits in.
export const BACKUP_DIR = 'backups'

// Rule 1. The check runs every hour and the dump is due at a day.
export const CHECK_INTERVAL_MS = 60 * 60 * 1000
export const DUMP_AGE_MS = 24 * 60 * 60 * 1000

// Rule 4. Twice the dump age, so one missed dump is not an alarm and two are.
export const STALE_AGE_MS = 48 * 60 * 60 * 1000

// Rule 3.
export const KEEP = 14

// A dump of the 4,282 events the box held on 2026-08-13 took well under a
// second. Ten minutes is a wedge rather than a slow box, and a wedged child
// must actually die, so the kill is SIGKILL.
export const DUMP_TIMEOUT_MS = 10 * 60 * 1000

// The name, and the stamp inside it. UTC, and colons folded to hyphens: a colon
// is legal on this filesystem and awkward in every shell that later names the
// file. The stamp sorts lexicographically in write order, which is what lets
// the retention rank the set without reading a single mtime.
const NAME = /^events-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.sql\.gz$/

export function stampFor(at) {
  return new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')
}

export function dumpName(at) {
  return `events-${stampFor(at)}.sql.gz`
}

// The instant a dump name states, in milliseconds, or null when the name is not
// one of ours. The half-written `.part` file a killed dump leaves behind reads
// null here, so it can never pass for a backup.
export function stampAt(name) {
  const m = NAME.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
}

// Every dump in the directory, newest first. A directory that does not exist
// yet holds no dumps, which is the honest answer on a box that has never taken
// one.
export function dumpsIn(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .map((name) => ({ name, at: stampAt(name) }))
    .filter((d) => d.at !== null)
    .sort((a, b) => b.at - a.at)
}

// Rule 3, at the point it bites. Returns the names it deleted.
export function prune(dir, keep = KEEP) {
  const gone = []
  for (const dump of dumpsIn(dir).slice(keep)) {
    try {
      fs.rmSync(path.join(dir, dump.name), { force: true })
      gone.push(dump.name)
    } catch { /* a dump curia cannot delete is not a backup curia lost */ }
  }
  return gone
}

// Hours, rounded down, for the words the operator reads. A missing dump has no
// age at all, so it reads null and the lines below say so in words.
export function ageHours(newest, now) {
  if (!newest) return null
  return Math.floor((now - newest.at) / (60 * 60 * 1000))
}

// ---- the dump ---------------------------------------------------------------

// One dump, into one file. It writes `<name>.part` and renames, so a dump
// killed halfway leaves nothing that `dumpsIn` will ever return.
//
// It refuses an empty dump. `sqlite3` exiting 0 with no SQL behind it would
// otherwise write a valid gzip file holding nothing, and that file would then
// stand in the retention as a backup and push a real one out.
export async function writeDump({ dbFile, dir, at, bin = 'sqlite3', timeoutMs = DUMP_TIMEOUT_MS }) {
  fs.mkdirSync(dir, { recursive: true })
  const name = dumpName(at)
  const out = path.join(dir, `${name}.part`)
  fs.rmSync(out, { force: true })

  const child = spawn(bin, ['-readonly', dbFile, '.dump'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk })

  let sql = 0
  child.stdout.on('data', (chunk) => { sql += chunk.length })

  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  timer.unref?.()
  const exited = new Promise((resolve, reject) => {
    child.once('error', (e) => reject(new Error(`${bin} did not run: ${e.message}`)))
    child.once('close', (code, signal) => {
      if (signal) return reject(new Error(`${bin} was killed on ${signal}`))
      if (code !== 0) return reject(new Error(`${bin} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
      resolve()
    })
  })

  try {
    await Promise.all([pipeline(child.stdout, createGzip(), fs.createWriteStream(out)), exited])
    if (!sql) throw new Error(`${bin} wrote no SQL`)
    const bytes = fs.statSync(out).size
    fs.renameSync(out, path.join(dir, name))
    return { name, bytes, sql }
  } catch (e) {
    fs.rmSync(out, { force: true })
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ---- the lines --------------------------------------------------------------
//
// CuriaBot's own voice: these state mechanics, which is the half ADR-0013 gives
// the bot. Each one names the act that ends it.

export function failedLine({ message, age_h }) {
  const age = age_h === null
    ? 'There is no dump on the box at all.'
    : `The newest dump is ${age_h} hour${age_h === 1 ? '' : 's'} old.`
  return `⚠️ the journal backup failed: ${message}. ${age} The journal itself is unharmed. Read the daemon log, then check \`sqlite3\` and the free space under \`daemon/data\`.`
}

export function recoveredLine({ lapse_h }) {
  if (lapse_h === null || lapse_h < DUMP_AGE_MS / (60 * 60 * 1000)) {
    return '✅ the journal backup is current again.'
  }
  return `✅ the journal backup is current again. The dump before it was ${lapse_h} hours old.`
}

// ---- the watch --------------------------------------------------------------

export class JournalBackup {
  // `journal` writes one event. `announce` resolves true when the words reached
  // Discord, exactly as the credential watch's does (#380). `standing` reads the
  // alarm the reduction remembers, so a deploy inherits it.
  constructor({
    dataDir, dbFile, journal, announce, standing,
    log = () => {}, now = () => Date.now(),
    bin = 'sqlite3', intervalMs = CHECK_INTERVAL_MS, keep = KEEP,
  }) {
    this.dir = path.join(dataDir, BACKUP_DIR)
    this.dbFile = dbFile
    this.journal = journal
    this.announce = announce
    this.standing = standing
    this.log = log
    this.now = now
    this.bin = bin
    this.intervalMs = intervalMs
    this.keep = keep
    this.timer = null
  }

  newest() {
    return dumpsIn(this.dir)[0] ?? null
  }

  // One check, and whatever it makes curia say. It never throws: a backup that
  // cannot be taken is an alarm, and an alarm must not take the daemon with it.
  async pass() {
    const now = this.now()
    const before = this.newest()
    if (before && now - before.at < DUMP_AGE_MS) return null

    const lapse = ageHours(before, now)
    let dump
    try {
      dump = await writeDump({ dbFile: this.dbFile, dir: this.dir, at: now, bin: this.bin })
    } catch (e) {
      await this.#alarm({ message: e.message, age_h: lapse })
      return null
    }

    const deleted = prune(this.dir, this.keep)
    // Rule 4: the success itself says nothing. It only speaks when it repairs
    // something the operator was told about, or when it repairs a lapse nobody
    // was told about because the check had stopped running.
    const stood = this.standing?.() ?? null
    const lapsed = lapse !== null && (now - before.at) >= STALE_AGE_MS
    this.journal('journal_backup', {
      file: `${BACKUP_DIR}/${dump.name}`, bytes: dump.bytes, kept: dumpsIn(this.dir).length,
      deleted: deleted.length, lapse_h: lapsed ? lapse : null,
    })
    if (stood || lapsed) await this.#say(recoveredLine({ lapse_h: lapse }))
    return dump
  }

  // Rule 5. The alarm is said when it is news: a first failure, a failure whose
  // reason changed, a failure that has now crossed 48 hours, or one the bridge
  // was down for. Everything else is journalled and stays quiet.
  async #alarm(reading) {
    const stale = reading.age_h !== null && reading.age_h >= STALE_AGE_MS / (60 * 60 * 1000)
    const entry = this.standing?.() ?? null
    const news = !entry || !entry.said || entry.message !== reading.message || (stale && !entry.stale)
    this.log(`the journal backup failed: ${reading.message}`)
    if (!news) {
      this.journal('journal_backup_failed', { ...reading, stale, said: entry.said ?? false })
      return
    }
    const said = await this.#say(failedLine(reading))
    this.journal('journal_backup_failed', { ...reading, stale, said })
  }

  // The one place `said` is decided. A missing bridge and a failing send are the
  // same answer: the operator did not read it.
  async #say(text) {
    try {
      const res = await this.announce(text)
      if (res === false) this.log('the journal backup alarm could not be said — there is no bridge yet, so it stands until there is')
      return res !== false
    } catch (e) {
      this.log(`the journal backup alarm did not reach Discord (${e.message}) — it stands until it does`)
      return false
    }
  }

  start() {
    this.stop()
    this.timer = setInterval(() => { this.pass().catch(() => {}) }, this.intervalMs)
    this.timer.unref?.()
    return this.timer
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

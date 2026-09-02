// The daily update check (#883, implementing #854's update discovery).
//
// An installed Curia learns whether a newer stable release exists the same
// way `curia update` does: it downloads the signed stable-release index,
// verifies it with the pinned key of the package the active version
// carries, and reads the recommended version and the withdrawn list. This
// module is that check as the service runs it, and the one answer the Curia
// app's update panel reads.
//
//   - WHEN. At service startup when the last successful check is older than
//     24 hours (or there never was one), then once every 24 hours. Nothing
//     else triggers it: not a request, not a reload, not the app opening
//     the panel. The panel shows what the last check found and when.
//   - WHAT IS KEPT. `state/update-check.json` holds the result of the last
//     check and nothing else: when it ran, whether it verified, the reason
//     when it did not, and the index's own fields (sequence, updated,
//     stable, withdrawn). It is not a cache of artifacts, not an update
//     queue, and not a marker anything else reads. A check that fails keeps
//     the last verified index beside the failure, so the panel can still
//     say what the last good read said and how old it is.
//   - WHAT IT NEVER DOES. It downloads no release, switches nothing, restarts
//     nothing, and posts nothing to Discord. A failed check is a fact in the
//     file and a log line; the running installation is not affected. The
//     operator starts an update with `curia update`.
//   - OLDER INDEX. The sequence of the last verified index is remembered, and
//     an index with a lower sequence is refused as a failed check: a
//     replayed old file cannot un-withdraw a version.
//
// The network read and the clock are injectable, so the test hands in a
// signed fixture instead of raw.githubusercontent.com.

import fs from 'node:fs'
import path from 'node:path'

import { writeAtomically } from '../../cli/src/atomic.mjs'
import { STABLE_INDEX_URL, fetchStableIndex, releaseNotesUrl } from '../../cli/src/stable.mjs'
import { compareAppVersions } from './appversion.mjs'

export const UPDATE_CHECK_FILE = 'update-check.json'
export const UPDATE_CHECK_FORMAT = 1
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_COMMAND = 'curia update'

export const updateCheckPath = (stateDir) => path.join(stateDir, UPDATE_CHECK_FILE)

// The network boundary: the raw index file at `url`. Null when it does not
// download, which the fetch reports as a failed check.
export function indexProbes(url = STABLE_INDEX_URL) {
  return {
    stableIndex: async () => {
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
        if (!response.ok) return null
        return await response.text()
      } catch {
        return null
      }
    },
  }
}

// The answer for a Curia that runs from a source checkout: no installation
// root, no stable-release index to read, updates come from the deploy.
export function unmanagedStatus(installed) {
  return {
    managed: false,
    installed,
    recommended: null,
    update_available: false,
    installed_withdrawn: false,
    withdrawn: [],
    release_notes: { installed: releaseNotesUrl(installed), recommended: null },
    checked_at: null,
    succeeded_at: null,
    ok: null,
    error: null,
    next_check_at: null,
    command: null,
    reason: 'This Curia runs from a source checkout, so its deploy updates it. The stable-release index is not read here.',
  }
}

export class UpdateCheck {
  #stateDir
  #installed
  #publicKey
  #probes
  #log
  #now
  #setTimer
  #clearTimer
  #timer = null
  #nextAt = null
  #running = null

  // `installed()` answers the active version on every read, `publicKey()`
  // the pinned key text of that version's package or null. `probes` is the
  // index read, `now` the clock in milliseconds, `setTimer` and `clearTimer`
  // the timer pair (the real ones unref, so the check never keeps a
  // stopping process alive).
  constructor({ stateDir, installed, publicKey, probes = indexProbes(), log = () => {}, now = Date.now, setTimer = unrefTimeout, clearTimer = clearTimeout }) {
    this.#stateDir = stateDir
    this.#installed = installed
    this.#publicKey = publicKey
    this.#probes = probes
    this.#log = log
    this.#now = now
    this.#setTimer = setTimer
    this.#clearTimer = clearTimer
  }

  // The record on disk, or null. A file that is not a record reads as none,
  // so a damaged file costs one check and never a boot.
  record() {
    let text
    try {
      text = fs.readFileSync(updateCheckPath(this.#stateDir), 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
    try {
      const r = JSON.parse(text)
      return r && typeof r === 'object' && r.format === UPDATE_CHECK_FORMAT ? r : null
    } catch {
      return null
    }
  }

  // One check, recorded whatever it finds. Never throws: a failure is the
  // record's `error` and a log line.
  async check() {
    if (this.#running) return this.#running
    this.#running = this.#run().finally(() => { this.#running = null })
    return this.#running
  }

  async #run() {
    const previous = this.record()
    const at = new Date(this.#now()).toISOString()
    const lines = []
    const stdout = { write: (s) => { lines.push(String(s)); return true } }
    let outcome
    try {
      const publicKey = this.#publicKey()
      const fetched = await fetchStableIndex({ stdout, publicKey }, this.#probes)
      if (!fetched.ok) {
        outcome = { ok: false, error: fetched.error }
      } else if (previous?.index && fetched.index.sequence < previous.index.sequence) {
        outcome = { ok: false, error: `the stable-release index has sequence ${fetched.index.sequence}, older than the sequence ${previous.index.sequence} already verified. An older index is never taken.` }
      } else {
        const { sequence, updated, stable, withdrawn } = fetched.index
        outcome = { ok: true, error: null, index: { sequence, updated, stable, withdrawn } }
      }
    } catch (e) {
      outcome = { ok: false, error: e.message }
    }
    const record = {
      format: UPDATE_CHECK_FORMAT,
      checked_at: at,
      ok: outcome.ok,
      error: outcome.error,
      succeeded_at: outcome.ok ? at : previous?.succeeded_at ?? null,
      index: outcome.ok ? outcome.index : previous?.index ?? null,
    }
    fs.mkdirSync(this.#stateDir, { recursive: true })
    writeAtomically(updateCheckPath(this.#stateDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    this.#log(outcome.ok
      ? `update check: stable ${record.index.stable ?? 'none'}, installed ${this.#installed()}${record.index.withdrawn.length ? `, withdrawn ${record.index.withdrawn.join(', ')}` : ''}`
      : `update check failed: ${outcome.error} The running installation is not affected.`)
    return record
  }

  // Arms the schedule: a check now when the last successful one is older
  // than the interval (or absent), else at the moment it turns that old,
  // and every interval after a check.
  start() {
    const last = this.record()?.succeeded_at
    const lastMs = last ? Date.parse(last) : NaN
    const due = Number.isFinite(lastMs) ? lastMs + CHECK_INTERVAL_MS : this.#now()
    this.#arm(Math.max(0, due - this.#now()))
  }

  stop() {
    if (this.#timer !== null) this.#clearTimer(this.#timer)
    this.#timer = null
    this.#nextAt = null
  }

  #arm(delay) {
    this.stop()
    this.#nextAt = new Date(this.#now() + delay).toISOString()
    this.#timer = this.#setTimer(() => {
      this.#timer = null
      this.check().finally(() => this.#arm(CHECK_INTERVAL_MS))
    }, delay)
  }

  // What the app's update panel reads. Composed from the record and the
  // active version on every read, never stored.
  status() {
    const installed = this.#installed()
    const record = this.record()
    const index = record?.index ?? null
    const recommended = index?.stable ?? null
    const withdrawn = index?.withdrawn ?? []
    let updateAvailable = false
    try {
      updateAvailable = recommended !== null && compareAppVersions(recommended, installed) > 0
    } catch {
      updateAvailable = recommended !== null && recommended !== installed
    }
    return {
      managed: true,
      installed,
      recommended,
      update_available: updateAvailable,
      installed_withdrawn: withdrawn.includes(installed),
      withdrawn,
      release_notes: { installed: releaseNotesUrl(installed), recommended: recommended ? releaseNotesUrl(recommended) : null },
      checked_at: record?.checked_at ?? null,
      succeeded_at: record?.succeeded_at ?? null,
      ok: record?.ok ?? null,
      error: record?.error ?? null,
      next_check_at: this.#nextAt,
      command: UPDATE_COMMAND,
      reason: null,
    }
  }
}

function unrefTimeout(fn, delay) {
  const t = setTimeout(fn, delay)
  t.unref()
  return t
}

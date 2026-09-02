// The daily update check (#883). What is pinned: when a check runs, what
// the record in state/ holds and never holds, what the app's read says for
// no update, an update, a withdrawn installed version, and a failed read,
// and that a failure changes nothing but the record.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStableIndex, generateStableIndexKeys, signStableIndex } from '../../cli/src/stable.mjs'
import { CHECK_INTERVAL_MS, UPDATE_CHECK_FILE, UpdateCheck, unmanagedStatus, updateCheckPath } from '../src/updatecheck.mjs'

const keys = generateStableIndexKeys()
const otherKeys = generateStableIndexKeys()
const T0 = Date.parse('2026-09-02T10:00:00Z')
const HOUR = 60 * 60 * 1000

const index = ({ sequence = 1, stable = '1.4.0', withdrawn = [] } = {}) => createStableIndex({ sequence, updated: '2026-09-01T00:00:00Z', stable, withdrawn })
const signed = (i, privateKey = keys.privateKey) => signStableIndex(i, privateKey)

let tmp
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-updatecheck-')) })
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// One check under test: a fake clock, a fake timer that records its delay
// and fires only when asked, a probe that answers the text handed in.
function harness({ installed = '1.3.0', text = signed(index()), publicKey = keys.publicKey, now = T0 } = {}) {
  const stateDir = fs.mkdtempSync(path.join(tmp, 'state-'))
  const clock = { now }
  const timers = []
  const logs = []
  let answer = text
  const check = new UpdateCheck({
    stateDir,
    installed: () => installed,
    publicKey: () => publicKey,
    probes: { stableIndex: async () => (typeof answer === 'function' ? answer() : answer) },
    log: (line) => logs.push(line),
    now: () => clock.now,
    setTimer: (fn, delay) => { const t = { fn, delay, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
  })
  return { check, stateDir, clock, timers, logs, answer: (t) => { answer = t }, record: () => JSON.parse(fs.readFileSync(updateCheckPath(stateDir), 'utf8')) }
}

describe('the check record', () => {
  test('a verified index lands as the check result and nothing else, owner-only', async () => {
    const h = harness()
    const record = await h.check.check()
    assert.deepEqual(record, {
      format: 1,
      checked_at: '2026-09-02T10:00:00.000Z',
      ok: true,
      error: null,
      succeeded_at: '2026-09-02T10:00:00.000Z',
      index: { sequence: 1, updated: '2026-09-01T00:00:00Z', stable: '1.4.0', withdrawn: [] },
    })
    assert.deepEqual(h.record(), record)
    assert.equal(fs.statSync(path.join(h.stateDir, UPDATE_CHECK_FILE)).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(h.stateDir), [UPDATE_CHECK_FILE], 'no artifact, no cache, nothing else')
    assert.deepEqual(h.logs, ['update check: stable 1.4.0, installed 1.3.0'])
  })

  test('a failed read is recorded with its reason, keeps the last verified index, and throws nothing', async () => {
    const h = harness()
    await h.check.check()
    h.clock.now = T0 + 2 * HOUR
    h.answer(null)
    const failed = await h.check.check()
    assert.equal(failed.ok, false)
    assert.match(failed.error, /could not be downloaded/)
    assert.equal(failed.checked_at, '2026-09-02T12:00:00.000Z')
    assert.equal(failed.succeeded_at, '2026-09-02T10:00:00.000Z', 'the last success stands')
    assert.equal(failed.index.stable, '1.4.0', 'the last verified index stands')
    assert.match(h.logs.at(-1), /^update check failed: .*The running installation is not affected\.$/)

    h.answer(signed(index(), otherKeys.privateKey))
    const forged = await h.check.check()
    assert.equal(forged.ok, false)
    assert.match(forged.error, /signed with key/)
    assert.equal(forged.index.stable, '1.4.0')
  })

  test('an index older than the one already verified is refused', async () => {
    const h = harness({ text: signed(index({ sequence: 5, withdrawn: ['1.3.0'] })) })
    await h.check.check()
    h.answer(signed(index({ sequence: 4 })))
    const replayed = await h.check.check()
    assert.equal(replayed.ok, false)
    assert.match(replayed.error, /sequence 4, older than the sequence 5 already verified/)
    assert.deepEqual(replayed.index.withdrawn, ['1.3.0'], 'the replay un-withdraws nothing')
  })

  test('no pinned key is a failed check, not a crash', async () => {
    const h = harness({ publicKey: null })
    const record = await h.check.check()
    assert.equal(record.ok, false)
    assert.match(record.error, /no stable-index public key|pins no|key/i)
    assert.equal(record.index, null)
  })

  test('a damaged record file reads as no record', async () => {
    const h = harness()
    fs.writeFileSync(updateCheckPath(h.stateDir), '{not json')
    assert.equal(h.check.record(), null)
    const record = await h.check.check()
    assert.equal(record.ok, true)
  })
})

describe('when the check runs', () => {
  test('with no record it runs at start, then once every 24 hours', async () => {
    const h = harness()
    h.check.start()
    assert.equal(h.timers.length, 1)
    assert.equal(h.timers[0].delay, 0)
    assert.equal(h.check.status().next_check_at, '2026-09-02T10:00:00.000Z')
    h.timers[0].fn()
    await h.check.check()
    await new Promise((r) => setImmediate(r))
    assert.equal(h.timers.length, 2, 'the next check is armed after this one')
    assert.equal(h.timers[1].delay, CHECK_INTERVAL_MS)
    assert.equal(h.check.status().next_check_at, '2026-09-03T10:00:00.000Z')
  })

  test('with a success younger than 24 hours it waits for the remainder', () => {
    const h = harness()
    fs.writeFileSync(updateCheckPath(h.stateDir), JSON.stringify({ format: 1, checked_at: '2026-09-02T04:00:00.000Z', ok: true, error: null, succeeded_at: '2026-09-02T04:00:00.000Z', index: index() }))
    h.check.start()
    assert.equal(h.timers[0].delay, 18 * HOUR)
    assert.equal(h.check.status().next_check_at, '2026-09-03T04:00:00.000Z')
  })

  test('with a success older than 24 hours, or only failures, it runs at start', () => {
    const stale = harness()
    fs.writeFileSync(updateCheckPath(stale.stateDir), JSON.stringify({ format: 1, checked_at: '2026-08-30T04:00:00.000Z', ok: true, error: null, succeeded_at: '2026-08-30T04:00:00.000Z', index: index() }))
    stale.check.start()
    assert.equal(stale.timers[0].delay, 0)
    const failing = harness()
    fs.writeFileSync(updateCheckPath(failing.stateDir), JSON.stringify({ format: 1, checked_at: '2026-09-02T09:00:00.000Z', ok: false, error: 'x', succeeded_at: null, index: null }))
    failing.check.start()
    assert.equal(failing.timers[0].delay, 0)
  })

  test('stop clears the armed timer', () => {
    const h = harness()
    h.check.start()
    h.check.stop()
    assert.equal(h.timers[0].cleared, true)
    assert.equal(h.check.status().next_check_at, null)
  })
})

describe('what the app reads', () => {
  test('before any check: the installed version, no recommendation, nothing known', () => {
    const h = harness({ installed: '1.3.0' })
    assert.deepEqual(h.check.status(), {
      managed: true,
      installed: '1.3.0',
      recommended: null,
      update_available: false,
      installed_withdrawn: false,
      withdrawn: [],
      release_notes: { installed: 'https://github.com/alp82/curia/releases/tag/v1.3.0', recommended: null },
      checked_at: null,
      succeeded_at: null,
      ok: null,
      error: null,
      next_check_at: null,
      command: 'curia update',
      reason: null,
    })
  })

  test('no update: the stable release is the installed one', async () => {
    const h = harness({ installed: '1.4.0' })
    await h.check.check()
    const s = h.check.status()
    assert.equal(s.recommended, '1.4.0')
    assert.equal(s.update_available, false)
    assert.equal(s.ok, true)
    assert.equal(s.checked_at, '2026-09-02T10:00:00.000Z')
  })

  test('an update: a newer stable release, with both release-notes links and the command', async () => {
    const h = harness({ installed: '1.3.0' })
    await h.check.check()
    const s = h.check.status()
    assert.equal(s.update_available, true)
    assert.deepEqual(s.release_notes, {
      installed: 'https://github.com/alp82/curia/releases/tag/v1.3.0',
      recommended: 'https://github.com/alp82/curia/releases/tag/v1.4.0',
    })
    assert.equal(s.command, 'curia update')
  })

  test('a stable release older than the installed prerelease is no update', async () => {
    const h = harness({ installed: '1.5.0-rc.1' })
    await h.check.check()
    assert.equal(h.check.status().update_available, false)
  })

  test('a withdrawn installed version is a warning beside the recommendation', async () => {
    const h = harness({ installed: '1.3.0', text: signed(index({ withdrawn: ['1.3.0', '1.2.9'] })) })
    await h.check.check()
    const s = h.check.status()
    assert.equal(s.installed_withdrawn, true)
    assert.deepEqual(s.withdrawn, ['1.2.9', '1.3.0'])
    assert.equal(s.update_available, true)
  })

  test('a failed check says so beside what the last good read said', async () => {
    const h = harness({ installed: '1.3.0' })
    await h.check.check()
    h.clock.now = T0 + HOUR
    h.answer(null)
    await h.check.check()
    const s = h.check.status()
    assert.equal(s.ok, false)
    assert.match(s.error, /could not be downloaded/)
    assert.equal(s.recommended, '1.4.0')
    assert.equal(s.succeeded_at, '2026-09-02T10:00:00.000Z')
    assert.equal(s.checked_at, '2026-09-02T11:00:00.000Z')
  })

  test('a source checkout is unmanaged: the version, no index, and the reason', () => {
    const s = unmanagedStatus('0.4.1')
    assert.equal(s.managed, false)
    assert.equal(s.installed, '0.4.1')
    assert.equal(s.update_available, false)
    assert.match(s.reason, /source checkout/)
  })
})

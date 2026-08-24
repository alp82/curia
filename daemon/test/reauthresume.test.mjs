// The login a restart interrupted (#671).
//
// `ReauthFlow.flow` was process state with nothing behind it, so a daemon
// replaced mid-login left three things wrong at once: a blank panel, a finished
// credential nobody adopted, and a `curia-auth-` session no sweep may walk with
// its thirty-minute window gone with the process that held it.
//
// Two halves are driven here, and both are the real thing:
//
//   1. The journal reduction, on a real `Reduction` over a real journal —
//      including the second reduction that reads it cold, because surviving the
//      process is the whole point.
//   2. `ReauthFlow`, resuming from that record and then running its ORDINARY
//      poll. Nothing about the outcome is decided by the resume: the credential
//      is still checked before the deadline, and the pane before either.
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Reduction } from '../src/reduction.mjs'
import {
  ReauthFlow, DeviceLoginLane, CodexCredentialBroker, REAUTH_TIMEOUT_MS,
} from '../src/credentials.mjs'

const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

function accessToken({ iat, exp }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: Math.floor(iat / 1000), exp: Math.floor(exp / 1000) })}.sig`
}

function authJson({ iat, exp, refresh = 'rt.fresh' }) {
  return `${JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: 'id.1', access_token: accessToken({ iat, exp }), refresh_token: refresh, account_id: 'acct-1' },
    last_refresh: new Date(iat).toISOString(),
  }, null, 2)}\n`
}

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-reauth-resume-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// A flow that reads its open login from whatever the caller hands it, which is
// a real `Reduction` in the tests below.
function flow({ now = () => 0, sessions = new Set(), openLogin = () => null, journal = () => {} } = {}) {
  const calls = { spawned: [], killed: [], stopped: [], pane: '' }
  const f = new ReauthFlow({
    lanes: { openai: new DeviceLoginLane({ broker: new CodexCredentialBroker({ home: dir, now }) }) },
    image: 'curia-agent:test',
    agentUid: 1000,
    cfgDirFor: (session) => path.join(dir, 'cfg', session),
    newSession: async (opts) => { calls.spawned.push(opts); sessions.add(opts.name) },
    capturePane: async () => calls.pane,
    killSession: async (name) => { calls.killed.push(name); sessions.delete(name) },
    hasSession: async (name) => sessions.has(name),
    stopContainer: async (name) => { calls.stopped.push(name) },
    openLogin,
    now,
    journal,
  })
  return { f, calls, sessions }
}

// The scratch config dir a login writes into, as `cfgDirFor` names it.
const scratch = (session) => path.join(dir, 'cfg', session)

describe('the journal holds the open login (#671)', () => {
  test('a started login is open, and every ending closes it', () => {
    for (const ending of ['reauth_completed', 'reauth_timed_out', 'reauth_abandoned', 'reauth_failed']) {
      const reduction = new Reduction(fs.mkdtempSync(path.join(dir, 'j-')))
      reduction.journal('reauth_started', { provider: 'openai', session: 'curia-auth-openai' })
      assert.equal(reduction.openLogin().provider, 'openai', `open before ${ending}`)
      reduction.journal(ending, { provider: 'openai', session: 'curia-auth-openai' })
      assert.equal(reduction.openLogin(), null, `closed by ${ending}`)
      reduction.close()
    }
  })

  test('a fresh reduction reads the same open login off the file, with the instant it began', () => {
    const home = fs.mkdtempSync(path.join(dir, 'j-'))
    const first = new Reduction(home)
    first.journal('reauth_started', { provider: 'openai', session: 'curia-auth-openai' })
    // No ending event: this is the process the restart killed.
    first.close()

    const booted = new Reduction(home)
    const open = booted.openLogin()
    assert.equal(open.provider, 'openai')
    assert.equal(open.session, 'curia-auth-openai')
    assert.ok(Number.isFinite(open.startedAt), 'the clock is what a restart cannot re-derive')
    assert.ok(Math.abs(Date.now() - open.startedAt) < 60_000)
    booted.close()
  })

  // The flow carries one login at a time, so the record nearest its deadline is
  // the one to resume. The other is not lost: it is still open here.
  test('two open logins hand back the oldest', () => {
    const reduction = new Reduction(fs.mkdtempSync(path.join(dir, 'j-')))
    reduction.journal('reauth_started', { provider: 'openai', session: 'curia-auth-openai' })
    reduction.journal('reauth_started', { provider: 'anthropic', session: 'curia-auth-anthropic' })
    // Insertion order would lie once openai signs in a second time: `Map.set`
    // on a key already there keeps its original position.
    reduction.journal('reauth_completed', { provider: 'openai' })
    reduction.journal('reauth_started', { provider: 'openai', session: 'curia-auth-openai' })
    assert.equal(reduction.openLogin().provider, 'anthropic')
    reduction.journal('reauth_completed', { provider: 'anthropic' })
    assert.equal(reduction.openLogin().provider, 'openai')
    reduction.close()
  })

  // Every event is stamped by the append, so an unreadable one is a corrupt
  // record — and a login curia cannot clock is not one it will resume.
  test('a started login curia cannot date is not an open login', () => {
    const reduction = new Reduction(fs.mkdtempSync(path.join(dir, 'j-')))
    reduction._apply({ type: 'reauth_started', provider: 'openai', session: 'curia-auth-openai', ts: 'not a date' }, { replay: true })
    assert.equal(reduction.openLogin(), null)
    reduction.close()
  })
})

describe('a restart takes the login back (#671)', () => {
  // The panel is drawn from `state()`, so this is what a blank Credentials
  // screen and a missing Discord card both come down to.
  test('the poll re-adopts the open login, and the deadline is counted from the journal', async () => {
    const began = Date.parse('2026-08-24T10:00:00Z')
    let now = began + 5 * MINUTE
    const sessions = new Set(['curia-auth-openai'])
    const { f, calls } = flow({
      now: () => now,
      sessions,
      openLogin: () => ({ provider: 'openai', session: 'curia-auth-openai', startedAt: began }),
    })
    calls.pane = '   https://auth.openai.com/codex/device\n2. Enter this one-time code (expires in 15 minutes)\n   85PT-A4E5M\n'
    assert.equal(f.state(), null, 'nothing is tracked until the poll asks')

    assert.equal(await f.poll(), null, 'a live login is not an outcome')
    const state = f.state()
    assert.equal(state.state, 'waiting')
    assert.equal(state.provider, 'openai')
    assert.equal(state.session, 'curia-auth-openai')
    assert.equal(state.started_at, new Date(began).toISOString())
    // The window is the one the login started with, not a second one.
    assert.equal(state.seconds_left, (REAUTH_TIMEOUT_MS - 5 * MINUTE) / 1000)
    // And the link and the code come back off the pane on that same tick.
    assert.equal(state.url, 'https://auth.openai.com/codex/device')
    assert.equal(state.code, '85PT-A4E5M')
  })

  // The reason the deadline had to survive: without it the login gets a second
  // window, and the pane can outlive the code in it by three quarters of an hour.
  test('a login whose window ran out while the daemon was down times out at once', async () => {
    const began = Date.parse('2026-08-24T10:00:00Z')
    const events = []
    const sessions = new Set(['curia-auth-openai'])
    const { f, calls } = flow({
      now: () => began + REAUTH_TIMEOUT_MS + MINUTE,
      sessions,
      openLogin: () => ({ provider: 'openai', session: 'curia-auth-openai', startedAt: began }),
      journal: (e, d) => events.push([e, d]),
    })
    const out = await f.poll()
    assert.equal(out.state, 'timeout')
    assert.deepEqual(calls.killed, ['curia-auth-openai'], 'the session no sweep walks is closed by its own flow')
    assert.equal(events.at(-1)[0], 'reauth_timed_out')
    assert.equal(events.at(-1)[1].after_s, (REAUTH_TIMEOUT_MS + MINUTE) / 1000)
  })

  // The ordering `poll` already had, and the case the ticket was filed for: the
  // operator finished in the browser while curia was being replaced.
  test('a credential the operator completed while curia was down is adopted, late or not', async () => {
    const began = Date.parse('2026-08-24T10:00:00Z')
    const iat = began
    const events = []
    const sessions = new Set(['curia-auth-openai'])
    const { f } = flow({
      now: () => began + REAUTH_TIMEOUT_MS + 10 * MINUTE,
      sessions,
      openLogin: () => ({ provider: 'openai', session: 'curia-auth-openai', startedAt: began }),
      journal: (e, d) => events.push([e, d]),
    })
    fs.mkdirSync(scratch('curia-auth-openai'), { recursive: true })
    fs.writeFileSync(path.join(scratch('curia-auth-openai'), 'auth.json'), authJson({ iat, exp: iat + 10 * DAY }))

    const out = await f.poll()
    assert.equal(out.state, 'done')
    assert.match(fs.readFileSync(path.join(dir, '.codex', 'auth.json'), 'utf8'), /rt\.fresh/)
    assert.equal(events.at(-1)[0], 'reauth_completed')
  })

  // A session the operator closed, or a login that died with the daemon. The
  // record is what lets curia say so rather than leave it unsaid.
  test('an open login whose session is gone ends as abandoned rather than lingering', async () => {
    const began = Date.parse('2026-08-24T10:00:00Z')
    const events = []
    const { f } = flow({
      now: () => began + MINUTE,
      sessions: new Set(),
      openLogin: () => ({ provider: 'openai', session: 'curia-auth-openai', startedAt: began }),
      journal: (e, d) => events.push([e, d]),
    })
    assert.equal((await f.poll()).state, 'abandoned')
    assert.equal(events.at(-1)[0], 'reauth_abandoned')
  })

  // A record this daemon cannot act on: the store it belongs to is not one this
  // process was handed, so there is no lane to finish it.
  test('an open login for a provider this daemon has no lane for is left alone', async () => {
    const { f } = flow({
      openLogin: () => ({ provider: 'anthropic', session: 'curia-auth-anthropic', startedAt: 0 }),
    })
    assert.equal(await f.poll(), null)
    assert.equal(f.state(), null)
  })

  test('a live flow is never displaced by the record it wrote itself', async () => {
    const began = Date.parse('2026-08-24T10:00:00Z')
    let now = began
    const { f } = flow({
      now: () => now,
      openLogin: () => ({ provider: 'openai', session: 'curia-auth-openai', startedAt: began - 20 * MINUTE }),
    })
    await f.start({ provider: 'openai' })
    now = began + MINUTE
    await f.poll()
    assert.equal(f.state().started_at, new Date(began).toISOString(), 'the running flow keeps its own clock')
  })

  // The way back the ticket called undiscoverable. It still works, and it now
  // adopts the window the login actually started with.
  test('typing reauth again adopts the journal clock rather than opening a second window', async () => {
    const began = Date.parse('2026-08-24T10:00:00Z')
    const sessions = new Set(['curia-auth-openai'])
    const { f, calls } = flow({
      now: () => began + 20 * MINUTE,
      sessions,
      openLogin: () => ({ provider: 'openai', session: 'curia-auth-openai', startedAt: began }),
    })
    const again = await f.start({ provider: 'openai' })
    assert.equal(again.started, false)
    assert.equal(calls.spawned.length, 0, 'the operator’s half-finished login is not replaced')
    assert.equal(f.state().started_at, new Date(began).toISOString())
    assert.equal(f.state().seconds_left, (REAUTH_TIMEOUT_MS - 20 * MINUTE) / 1000)
  })

  // The one case with no record at all: a session on the box that the journal
  // never saw. A deadline nothing can date is worse than a generous one.
  test('a session with no journal record still gets adopted, on a fresh window', async () => {
    const now = Date.parse('2026-08-24T10:00:00Z')
    const sessions = new Set(['curia-auth-openai'])
    const { f } = flow({ now: () => now, sessions })
    const again = await f.start({ provider: 'openai' })
    assert.equal(again.started, false)
    assert.equal(f.state().seconds_left, REAUTH_TIMEOUT_MS / 1000)
  })
})

// The bridge starts when the token lands (#891, on the #876 card).
//
// The live rehearsal booted the daemon before the bot token existed, and the
// bridge used to start only at boot: the agent's review gate opened, nothing
// reached Discord, and the run sat on its escalation for an hour until the
// operator restarted the service. This file pins the rule that replaces that:
// one `ensure()` that reads the token and the settings fresh and starts the
// bridge when there is a token, an operator, and no bridge; a no-op while one
// runs or starts; a retry ladder that re-reads both on every attempt; and a
// state the card can say (`starting` while the login is in flight).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { BridgeStarter } from '../src/bridgestart.mjs'

const TOKEN = 'MTIz.this-value-must-never-be-printed.abc'

// A bridge the factory hands back: `start()` settles the way the test says.
function fakeBridge({ fail = null } = {}) {
  const b = {
    started: 0, stopped: 0, health: { state: 'down' },
    start: async () => {
      b.started += 1
      if (fail) throw new Error(fail)
      b.health.state = 'up'
    },
    stop: async () => { b.stopped += 1 },
  }
  return b
}

function harness({ token = TOKEN, users = ['100'], bridges = [fakeBridge()] } = {}) {
  const log = []
  const timers = []
  const created = []
  const started = []
  const files = { token, users }
  const starter = new BridgeStarter({
    token: () => files.token,
    settings: () => ({ allowed_users: files.users, guild_id: '200', channel: 'curia' }),
    create: (tok, settings) => {
      const b = bridges[created.length] ?? bridges.at(-1)
      created.push({ token: tok, settings, bridge: b })
      return b
    },
    onStarted: (b) => started.push(b),
    log: (line) => log.push(line),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } },
    gateSentence: () => 'state/discord.json names no allowed user',
    tokenSentence: () => 'no secrets/discord-bot-token',
  })
  return { starter, files, log, timers, created, started }
}

describe('the bridge starts when the token lands (#891)', () => {
  test('with no token there is no bridge, the log says so once, and the state is null', () => {
    const h = harness({ token: null })
    assert.deepEqual(h.starter.ensure(), { started: false, reason: 'no-token' })
    assert.deepEqual(h.starter.ensure(), { started: false, reason: 'no-token' })
    assert.equal(h.created.length, 0)
    assert.deepEqual(h.log, ['no secrets/discord-bot-token — running without the bridge (REST-only)'])
    assert.equal(h.starter.state(), null)
    assert.equal(h.starter.bridge, null)
  })

  test('with a token and no allowed user the bridge refuses to start and names the gate, never the token', () => {
    const h = harness({ users: [] })
    assert.deepEqual(h.starter.ensure(), { started: false, reason: 'no-operator' })
    assert.equal(h.created.length, 0)
    assert.deepEqual(h.log, ['state/discord.json names no allowed user — refusing to start the bridge without an auth gate'])
    assert.ok(!h.log.join('\n').includes(TOKEN))
  })

  test('the token landing after boot starts the bridge on the next ensure, and the card reads starting then up', async () => {
    const h = harness({ token: null })
    assert.equal(h.starter.ensure().started, false)
    h.files.token = TOKEN
    const out = h.starter.ensure()
    assert.deepEqual(out, { started: true, reason: 'starting' })
    assert.equal(h.starter.state(), 'starting', 'the login is in flight')
    assert.equal(h.starter.launching, true)
    assert.equal(h.created.length, 1)
    assert.equal(h.created[0].token, TOKEN, 'the factory gets the token read now, not the one read at boot')
    assert.deepEqual(h.created[0].settings.allowed_users, ['100'])
    await h.starter.settled()
    assert.equal(h.starter.bridge, h.created[0].bridge)
    assert.equal(h.starter.state(), 'up')
    assert.equal(h.starter.launching, false)
    assert.deepEqual(h.started, [h.created[0].bridge], 'the daemon is told once, with the live bridge')
  })

  test('ensure while a bridge starts or runs creates nothing: one bridge per process', async () => {
    const h = harness()
    h.starter.ensure()
    assert.deepEqual(h.starter.ensure(), { started: false, reason: 'starting' })
    await h.starter.settled()
    assert.deepEqual(h.starter.ensure(), { started: false, reason: 'running' })
    assert.deepEqual(h.starter.ensure(), { started: false, reason: 'running' })
    assert.equal(h.created.length, 1)
    assert.equal(h.created[0].bridge.started, 1)
  })

  test('a start that fails retries on a growing ladder, stops the dead instance, and re-reads the token each attempt', async () => {
    const bad = fakeBridge({ fail: 'Discord refused the token' })
    const good = fakeBridge()
    const h = harness({ bridges: [bad, good] })
    h.starter.ensure()
    await h.starter.settled()
    assert.equal(bad.stopped, 1, 'the failed instance is stopped')
    assert.equal(h.starter.bridge, null)
    assert.equal(h.starter.state(), 'starting', 'a ladder in flight still reads as starting')
    assert.match(h.log.at(-1), /bridge start attempt 1 failed: Discord refused the token — retrying in 5s/)
    assert.equal(h.timers.length, 1)
    assert.equal(h.timers[0].ms, 5000)
    assert.deepEqual(h.starter.ensure(), { started: false, reason: 'starting' }, 'no second ladder beside the first')
    h.timers[0].fn()
    await h.starter.settled()
    assert.equal(h.created.length, 2)
    assert.equal(h.starter.bridge, good)
    assert.equal(h.starter.state(), 'up')
  })

  test('a token removed mid-ladder ends the ladder instead of retrying a token that is gone', async () => {
    const bad = fakeBridge({ fail: 'Discord refused the token' })
    const h = harness({ bridges: [bad] })
    h.starter.ensure()
    await h.starter.settled()
    h.files.token = null
    h.timers[0].fn()
    await h.starter.settled()
    assert.equal(h.created.length, 1)
    assert.equal(h.starter.launching, false)
    assert.equal(h.starter.state(), null)
  })

  test('relaunch drops the live bridge and starts a fresh instance, which is what the wedge watchdog needs', async () => {
    const first = fakeBridge()
    const second = fakeBridge()
    const h = harness({ bridges: [first, second] })
    h.starter.ensure()
    await h.starter.settled()
    h.starter.relaunch()
    assert.equal(first.stopped, 1)
    assert.equal(h.starter.bridge, null)
    await h.starter.settled()
    assert.equal(h.starter.bridge, second)
    assert.deepEqual(h.started, [first, second])
  })
})

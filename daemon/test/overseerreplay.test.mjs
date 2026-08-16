// The replay (#388, building ADR-0015): a turn a restart killed is sent again,
// never retyped.
//
// Three halves are driven here, and each one is the real thing:
//
//   1. The journal reduction, on a real `Reduction` over a real journal —
//      including the second reduction that reads that journal cold, because the
//      whole point is that the message survives the process.
//   2. `refuseReplay`, which is the whole decision and is pure.
//   3. `replayKilledTurns`, the boot pass, with the container, the bridge and
//      the clock injected.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Reduction } from '../src/reduction.mjs'
import {
  replayKilledTurns, refuseReplay, droppedLine, replayLine, REPLAY_FRESH_MS,
} from '../src/overseerreplay.mjs'
import { journalEvents } from './fixtures/journal.mjs'

const quiet = () => {}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-replay-'))

// One started turn, as the client writes it.
function start(reduction, { key = '111', prompt = 'what is on the frontier', threadId = '111', replay = false } = {}) {
  reduction.beginOverseerTurn({ key, turn: 'abc', prompt, threadId, replay })
}

// One seam crossing, as index.mjs writes it: the command event the daemon
// already journals, carrying the conversation key.
function cross(reduction, key, canonical) {
  reduction.journal('command', { canonical, by: 'overseer', overseer_key: key })
}

describe('the journal holds the pending turn (#388)', () => {
  test('a started turn is pending, and an ended one is not', () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    start(reduction)
    assert.equal(reduction.pendingOverseerTurns().length, 1)
    assert.equal(reduction.pendingOverseerTurns()[0].prompt, 'what is on the frontier')
    reduction.endOverseerTurn({ key: '111', turn: 'abc', ok: true, crossings: 0 })
    assert.deepEqual(reduction.pendingOverseerTurns(), [])
  })

  test('a fresh reduction reads the same pending turn off the file — the message survives the process', () => {
    const dir = tmp()
    const first = new Reduction(dir)
    start(first, { prompt: 'start 256' })
    // No end event: this is the process the restart killed.
    const booted = new Reduction(dir)
    const killed = booted.pendingOverseerTurns()
    assert.equal(killed.length, 1)
    assert.equal(killed[0].prompt, 'start 256')
    assert.equal(killed[0].thread_id, '111')
    assert.equal(killed[0].crossings, 0)
  })

  test('the crossings are counted off the command event the seam already writes', () => {
    const dir = tmp()
    const first = new Reduction(dir)
    start(first)
    cross(first, '111', 'start 256 in alp82/curia')
    cross(first, '111', 'status')
    const booted = new Reduction(dir)
    const killed = booted.pendingOverseerTurns()[0]
    assert.equal(killed.crossings, 2)
    assert.deepEqual(killed.commands, ['start 256 in alp82/curia', 'status'])
  })

  test('a command with no conversation key counts against nothing', () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    start(reduction)
    reduction.journal('command', { canonical: 'start 256', by: 'alp82' })
    assert.equal(reduction.pendingOverseerTurns()[0].crossings, 0)
  })

  test('a drop ends the turn and leaves the line for the surfaces', () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    start(reduction, { key: 'console-1', threadId: null })
    reduction.dropOverseerTurn({ key: 'console-1', crossings: 1, commands: ['cancel 3'], replayed: false, why: 'it already crossed the seam' })
    assert.deepEqual(reduction.pendingOverseerTurns(), [])
    assert.equal(reduction.droppedOverseerTurn('console-1').why, 'it already crossed the seam')
    // And the next boot reads no corpse twice.
    assert.deepEqual(new Reduction(dir).pendingOverseerTurns(), [])
  })

  test('the conversation\'s next turn clears the dropped line', () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    start(reduction, { key: 'console-1', threadId: null })
    reduction.dropOverseerTurn({ key: 'console-1', crossings: 1, commands: [], replayed: false, why: 'no' })
    assert.ok(reduction.droppedOverseerTurn('console-1'))
    start(reduction, { key: 'console-1', threadId: null })
    assert.equal(reduction.droppedOverseerTurn('console-1'), null)
  })

  test('a deleted conversation takes its pending and dropped turns with it', () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    reduction.openConsoleConversation()
    start(reduction, { key: 'console-1', threadId: null })
    reduction.deleteConsoleConversation('console-1')
    assert.deepEqual(reduction.pendingOverseerTurns(), [])
    assert.equal(reduction.droppedOverseerTurn('console-1'), null)
  })

  test('the turn bookkeeping stays out of the feed, and the drop does not', () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    start(reduction)
    reduction.endOverseerTurn({ key: '111', turn: 'abc', ok: true })
    assert.deepEqual(reduction.recentEvents().map((e) => e.type), [])
    reduction.dropOverseerTurn({ key: '111', replayed: true })
    assert.deepEqual(reduction.recentEvents().map((e) => e.type), ['overseer_turn_dropped'])
  })
})

describe('what stops a replay (#388, ADR-0015)', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z')
  const bootAt = now - 30_000
  const fresh = { key: '111', crossings: 0, replay: false, at: '2026-08-16T11:59:00.000Z' }

  test('a turn that crossed nothing is sent again', () => {
    assert.equal(refuseReplay(fresh, { nowMs: now, bootAt }), null)
  })

  test('a turn that ran a verb is not', () => {
    assert.equal(refuseReplay({ ...fresh, crossings: 1 }, { nowMs: now, bootAt }), 'it already crossed the seam')
  })

  test('a replay is not replayed', () => {
    assert.equal(
      refuseReplay({ ...fresh, replay: true }, { nowMs: now, bootAt }),
      'curia already sent this message again once',
    )
  })

  test('a conversation with a turn in flight is left alone', () => {
    assert.equal(refuseReplay(fresh, { nowMs: now, bootAt, live: true }), 'you were already talking here')
  })

  test('a conversation that spoke since the boot is left alone', () => {
    assert.equal(
      refuseReplay(fresh, { nowMs: now, bootAt, lastTurnAt: new Date(bootAt + 5_000).toISOString() }),
      'you were already talking here',
    )
  })

  test('the killed turn\'s own start does not read as the operator retyping', () => {
    assert.equal(refuseReplay(fresh, { nowMs: now, bootAt, lastTurnAt: fresh.at }), null)
  })

  test('a stale message is not sent again', () => {
    const old = { ...fresh, at: new Date(now - REPLAY_FRESH_MS - 1_000).toISOString() }
    assert.equal(refuseReplay(old, { nowMs: now, bootAt }), 'the message is older than 15 minutes')
  })
})

// ---- the boot pass ---------------------------------------------------------

function harness({ killed, up = true, bridge = true, live = () => false, bootAt = Date.now() }) {
  const dir = tmp()
  const reduction = new Reduction(dir)
  const said = []
  const replayed = []
  const browsed = []
  // A clock the sleep moves, so the wait for a container that never answers
  // reaches its deadline without the suite waiting two real minutes.
  let clock = bootAt
  return {
    dir,
    reduction,
    said,
    replayed,
    browsed,
    run: () => replayKilledTurns({
      killed,
      reduction,
      bootAt,
      nowMs: () => clock,
      probe: async () => ({ up }),
      live,
      sleep: async (ms) => { clock += ms },
      waitMs: 30, // the deadline is crossed after one poll, so a down container is fast
      pollMs: 10,
      discord: {
        ready: () => bridge,
        say: async (threadId, text) => { said.push([threadId, text]) },
        replay: async (threadId, prompt) => { replayed.push([threadId, prompt]) },
      },
      browser: { replay: async (key, prompt) => { browsed.push([key, prompt]) } },
      log: quiet,
    }),
  }
}

const killedTurn = (over = {}) => ({
  key: '111', turn: 'abc', prompt: 'what is on the frontier', thread_id: '111',
  replay: false, crossings: 0, commands: [], at: new Date().toISOString(), ...over,
})

describe('the boot pass (#388)', () => {
  test('nothing pending is nothing done', async () => {
    const h = harness({ killed: [] })
    assert.deepEqual(await h.run(), [])
  })

  test('a clean Discord turn is sent again, and journalled as sent', async () => {
    const h = harness({ killed: [killedTurn()] })
    const out = await h.run()
    assert.deepEqual(out, [{ key: '111', replayed: true, why: null }])
    assert.deepEqual(h.replayed, [['111', 'what is on the frontier']])
    assert.equal(h.said.length, 0)
    assert.equal(h.reduction.droppedOverseerTurn('111').replayed, true)
  })

  test('a turn that ran a verb gets one line naming what it ran, and no replay', async () => {
    const h = harness({ killed: [killedTurn({ crossings: 1, commands: ['start 256 in alp82/curia'] })] })
    await h.run()
    assert.equal(h.replayed.length, 0)
    assert.equal(h.said.length, 1)
    const [threadId, text] = h.said[0]
    assert.equal(threadId, '111')
    assert.match(text, /start 256 in alp82\/curia/)
    assert.match(text, /did not send the message again/)
  })

  test('a browser conversation is replayed with no thread line — the journal is its surface', async () => {
    const h = harness({ killed: [killedTurn({ key: 'console-2', thread_id: null })] })
    await h.run()
    assert.deepEqual(h.browsed, [['console-2', 'what is on the frontier']])
    assert.equal(h.said.length, 0)
  })

  test('a browser conversation that crossed the seam leaves its line on the record', async () => {
    const h = harness({ killed: [killedTurn({ key: 'console-2', thread_id: null, crossings: 1, commands: ['cancel 3'] })] })
    await h.run()
    assert.equal(h.browsed.length, 0)
    assert.equal(h.said.length, 0)
    const dropped = h.reduction.droppedOverseerTurn('console-2')
    assert.equal(dropped.replayed, false)
    assert.deepEqual(dropped.commands, ['cancel 3'])
  })

  test('a container that never comes back sends nothing again, and says so', async () => {
    const h = harness({ killed: [killedTurn()], up: false })
    const out = await h.run()
    assert.equal(out[0].why, 'the overseer container did not come back')
    assert.equal(h.replayed.length, 0)
    assert.match(h.said[0][1], /did not come back/)
  })

  test('a health check that throws reads as a container that is down, never as a lost turn', async () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    let clock = Date.now()
    const out = await replayKilledTurns({
      killed: [killedTurn()],
      reduction,
      bootAt: clock,
      nowMs: () => clock,
      probe: async () => { throw new Error('the socket is gone') },
      sleep: async (ms) => { clock += ms },
      waitMs: 30,
      pollMs: 10,
      discord: { ready: () => true, say: async () => {}, replay: async () => {} },
      log: quiet,
    })
    assert.equal(out[0].why, 'the overseer container did not come back')
    // And the turn is closed, not left pending for a boot an hour from now.
    assert.deepEqual(new Reduction(dir).pendingOverseerTurns(), [])
  })

  test('a bridge that never comes back holds the Discord replay', async () => {
    const h = harness({ killed: [killedTurn()], bridge: false })
    const out = await h.run()
    assert.equal(out[0].why, 'the Discord bridge did not come back')
    assert.equal(h.replayed.length, 0)
  })

  test('a conversation the operator is already talking in is left alone', async () => {
    const h = harness({ killed: [killedTurn()], live: (key) => key === '111' })
    const out = await h.run()
    assert.equal(out[0].why, 'you were already talking here')
    assert.equal(h.replayed.length, 0)
    assert.match(h.said[0][1], /already talking/)
  })

  test('a replay a second restart killed is not replayed a third time', async () => {
    const h = harness({ killed: [killedTurn({ replay: true })] })
    const out = await h.run()
    assert.equal(out[0].why, 'curia already sent this message again once')
    assert.equal(h.replayed.length, 0)
  })

  test('the verdict is journalled before the replay runs, so a second boot finds nothing', async () => {
    const killed = [killedTurn()]
    const h = harness({ killed })
    await h.run()
    // The pass ended the killed turn. A reduction reading the same file cold — the
    // next boot — has no corpse to read.
    assert.deepEqual(new Reduction(h.dir).pendingOverseerTurns(), [])
  })

  test('every verdict is on the record before one word is sent', async () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    const drops = () => journalEvents(dir).filter((e) => e.type === 'overseer_turn_dropped').length
    let atFirstSend = null
    await replayKilledTurns({
      killed: [killedTurn(), killedTurn({ key: '222', thread_id: '222' })],
      reduction,
      bootAt: Date.now(),
      probe: async () => ({ up: true }),
      sleep: async () => {},
      discord: {
        ready: () => true,
        say: async () => {},
        replay: async () => { atFirstSend ??= drops() },
      },
      log: quiet,
    })
    // Both, not one: a daemon that dies while the first replay runs must not
    // find the second killed turn still open and replay it a second time.
    assert.equal(atFirstSend, 2)
  })

  test('a replay that throws does not stop the next conversation', async () => {
    const dir = tmp()
    const reduction = new Reduction(dir)
    const browsed = []
    const out = await replayKilledTurns({
      killed: [killedTurn(), killedTurn({ key: 'console-3', thread_id: null })],
      reduction,
      bootAt: Date.now(),
      probe: async () => ({ up: true }),
      sleep: async () => {},
      discord: {
        ready: () => true,
        say: async () => {},
        replay: async () => { throw new Error('the thread is gone') },
      },
      browser: { replay: async (key, prompt) => { browsed.push([key, prompt]) } },
      log: quiet,
    })
    assert.equal(out.length, 2)
    assert.deepEqual(browsed, [['console-3', 'what is on the frontier']])
  })
})

describe('the lines the operator reads (#388)', () => {
  test('the dropped line names the commands and stays one line', () => {
    const text = droppedLine({ commands: ['start 256', 'status'], why: 'it already crossed the seam' })
    assert.match(text, /`start 256`, `status`/)
    assert.match(text, /Say it again if you still want it\./)
    assert.equal(text.includes('\n'), false)
    // The commands are the reason, so the reason is not said a second time.
    assert.equal(text.includes('it already crossed the seam'), false)
  })

  test('a drop with no command names the reason instead', () => {
    const text = droppedLine({ commands: [], why: 'you were already talking here' })
    assert.equal(text.includes('had already run'), false)
    assert.match(text, /did not send the message again — you were already talking here\./)
  })

  test('the replay notice is small print, because it is curia talking about curia', () => {
    assert.match(replayLine(), /^-# /)
  })
})

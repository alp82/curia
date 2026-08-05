// The rename gate (#199): every thread rename rides a self-accounted budget
// of RENAME_LIMIT per thread per RENAME_WINDOW_MS — the hidden, name-specific
// limit measured in docs/live-checks/199 — with latest-desired-wins reconcile
// when the budget is out, and a reserve rule that keeps the last slot for the
// rename that CLEARS a blocked glyph.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ThreadRenamer, RENAME_LIMIT, RENAME_WINDOW_MS } from '../src/threadname.mjs'

describe('ThreadRenamer', () => {
  let applied, clock, timers, renamer, applyResult

  beforeEach(() => {
    applied = []
    clock = 0
    timers = [] // { fn, at } — fired by hand
    applyResult = () => true
    renamer = new ThreadRenamer({
      apply: async (threadId, name) => {
        applied.push({ threadId, name, at: clock })
        return applyResult(threadId, name)
      },
      log: () => {},
      now: () => clock,
      timers: {
        set: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t },
        clear: (t) => { timers = timers.filter((x) => x !== t) },
      },
    })
  })

  const fire = async () => {
    const due = timers.filter((t) => t.at <= clock)
    timers = timers.filter((t) => t.at > clock)
    for (const t of due) t.fn()
    await renamer.threads.get('T')?.chain
  }

  test('a rename inside the budget applies at once, and a repeat of the applied name is free', async () => {
    await renamer.set('T', '⏳ 9 · task')
    await renamer.set('T', '⏳ 9 · task')
    assert.equal(applied.length, 1, 'the second set changed nothing and never reached apply')
  })

  test('an apply that did not PATCH refunds its slot', async () => {
    applyResult = () => false // name already right on Discord
    await renamer.set('T', 'a')
    applyResult = () => true
    await renamer.set('T', 'b')
    await renamer.set('T', 'c')
    assert.deepEqual(applied.map((a) => a.name), ['a', 'b', 'c'], 'the no-op left both real slots free')
  })

  test('the third rename in the window defers to the window edge and applies the LATEST desired', async () => {
    await renamer.set('T', 'a')
    clock += 1000
    await renamer.set('T', 'b')
    clock += 1000
    await renamer.set('T', 'c')
    assert.equal(applied.length, RENAME_LIMIT, 'the budget held')
    assert.equal(timers.length, 1, 'one wake-up scheduled')
    await renamer.set('T', 'd') // desire moves while deferred
    assert.equal(applied.length, RENAME_LIMIT, 'still deferred')
    clock = RENAME_WINDOW_MS + 2000 // the first spend has left the window
    await fire()
    assert.deepEqual(applied.at(-1), { threadId: 'T', name: 'd', at: clock }, 'latest wins — c was never sent')
    assert.equal(applied.length, RENAME_LIMIT + 1)
  })

  test('reserve spends only while a second slot stays free — adding ⏳ waits, clearing it lands', async () => {
    await renamer.set('T', '🎫 9 · task') // slot 1 gone
    clock += 1000
    await renamer.set('T', '⏳ 9 · task', { reserve: true })
    assert.equal(applied.length, 1, 'one free slot is not enough to ADD the blocked glyph')
    // the clear it was reserving for: spends the last slot with no wait
    await renamer.set('T', '🎫 9 · task')
    assert.equal(applied.length, 1, 'desired is already the applied name — nothing to send')
    await renamer.set('T', '✅ 9 · task')
    assert.equal(applied.length, 2, 'a non-reserve rename takes the last slot at once')
  })

  test('a deferred reserve rename lands once TWO slots are free', async () => {
    await renamer.set('T', 'a')
    clock += 1000
    await renamer.set('T', 'b')
    clock += 1000
    await renamer.set('T', '⏳ 9 · task', { reserve: true })
    assert.equal(applied.length, 2)
    clock = RENAME_WINDOW_MS + 500 // only the FIRST spend has expired — one slot free
    await renamer.set('T', '⏳ 9 · task', { reserve: true }) // a re-step at one free slot
    assert.equal(applied.length, 2, 'one slot is not enough for a reserve rename')
    clock = RENAME_WINDOW_MS + 2500 // both spends expired
    await fire()
    assert.equal(applied.at(-1).name, '⏳ 9 · task')
  })

  test('budgets are per thread', async () => {
    await renamer.set('A', 'a1')
    await renamer.set('A', 'a2')
    await renamer.set('A', 'a3')
    await renamer.set('B', 'b1')
    assert.deepEqual(applied.map((a) => a.name), ['a1', 'a2', 'b1'], "A's exhaustion never touches B")
  })

  test('an apply that throws is logged, spends, and the next set still works', async () => {
    applyResult = () => { throw new Error('discord hiccup') }
    await renamer.set('T', 'a')
    applyResult = () => true
    await renamer.set('T', 'b')
    assert.equal(applied.length, 2, 'the failure never poisons the chain')
  })

  test('stop clears every pending wake-up', async () => {
    await renamer.set('T', 'a')
    await renamer.set('T', 'b')
    await renamer.set('T', 'c')
    assert.equal(timers.length, 1)
    renamer.stop()
    assert.equal(timers.length, 0)
  })
})

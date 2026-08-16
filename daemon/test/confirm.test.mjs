// Button confirms at the reduction layer (#94): the `confirm` kind's own
// semantics — instance-keyed supersede, the lapsed terminal state, and the
// synthetic overseer notes — all as journal reductions that survive a replay.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Reduction, CONFIRM_KIND } from '../src/reduction.mjs'
import { journalEvents } from './fixtures/journal.mjs'

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-confirm-test-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const target = (session, instance) => ({ session, ticket: session.replace('curia-', ''), instance })

function openConfirm(reduction, targets, extra = {}) {
  return reduction.open({
    agent: 'overseer', ticket: targets.length === 1 ? targets[0].ticket : 'all',
    kind: CONFIRM_KIND, prompt: 'Cancel?', action: { verb: 'cancel', targets },
    origin_thread_id: 'thread-9', ...extra,
  })
}

describe('confirm records (#94)', () => {
  test('open persists the action and the issuing thread, and both survive a replay', () => {
    const reduction = new Reduction(dir)
    const { record } = openConfirm(reduction, [target('curia-42', 'curia-42@1')])
    assert.equal(record.kind, CONFIRM_KIND)
    assert.deepEqual(record.action.targets, [target('curia-42', 'curia-42@1')])
    assert.equal(record.origin_thread_id, 'thread-9')

    const replayed = new Reduction(dir).get(record.id)
    assert.deepEqual(replayed.action, record.action)
    assert.equal(replayed.origin_thread_id, 'thread-9')
    assert.equal(replayed.status, 'open')
  })

  test('a newer confirm sharing a target instance supersedes the older, whatever the wording', () => {
    const reduction = new Reduction(dir)
    const { record: older } = openConfirm(reduction, [target('curia-42', 'curia-42@1')])
    const { record: newer, superseded } = openConfirm(reduction, [
      target('curia-42', 'curia-42@1'), target('curia-43', 'curia-43@1'),
    ], { prompt: 'Cancel ALL 2 agent(s)?' })

    assert.equal(superseded.id, older.id)
    assert.equal(reduction.get(older.id).status, 'superseded')
    assert.equal(reduction.get(older.id).successor, newer.id)
    // an answer to the dead id routes to the live confirm (reused chain)
    const r = reduction.answer(older.id, { answer: 'approve', by: 'alp', via: 'button' })
    assert.equal(r.record.id, newer.id)
  })

  test('a confirm on a DIFFERENT instance of the same session does not supersede', () => {
    const reduction = new Reduction(dir)
    const { record: older } = openConfirm(reduction, [target('curia-42', 'curia-42@1')])
    const { superseded } = openConfirm(reduction, [target('curia-42', 'curia-42@2')])
    assert.equal(superseded, null)
    assert.equal(reduction.get(older.id).status, 'open')
  })

  test('a confirm never trips the payload-hash supersede of ordinary escalations, and vice versa', () => {
    const reduction = new Reduction(dir)
    const esc = reduction.open({ agent: 'overseer', ticket: '42', kind: 'approve-reject', prompt: 'Cancel?' })
    const { superseded } = openConfirm(reduction, [target('curia-42', 'curia-42@1')])
    assert.equal(superseded, null)
    assert.equal(reduction.get(esc.record.id).status, 'open')
  })

  test('lapse closes the record with its reason, refuses non-open records, and survives a replay', () => {
    const reduction = new Reduction(dir)
    const { record } = openConfirm(reduction, [target('curia-42', 'curia-42@1')])
    const r = reduction.lapse(record.id, '`curia-42` finished')
    assert.equal(r.ok, true)
    assert.equal(reduction.get(record.id).status, 'lapsed')
    assert.equal(reduction.get(record.id).lapse_reason, '`curia-42` finished')
    assert.equal(reduction.lapse(record.id, 'again').ok, false, 'a closed record never lapses twice')
    assert.equal(reduction.answer(record.id, { answer: 'approve', by: 'alp', via: 'button' }).ok, false,
      'a lapsed confirm is not answerable — the buttons are dead')

    assert.equal(new Reduction(dir).get(record.id).status, 'lapsed')
  })
})

describe('overseer notes (#94)', () => {
  test('notes queue per thread, drain once, and the drain survives a replay', () => {
    const reduction = new Reduction(dir)
    reduction.addOverseerNote('thread-9', 'confirm esc-1 approved — cancelled curia-42')
    reduction.addOverseerNote('thread-9', 'confirm esc-2 lapsed — `curia-43` finished; nothing was executed')
    reduction.addOverseerNote('thread-other', 'unrelated')

    assert.deepEqual(reduction.takeOverseerNotes('thread-9'), [
      'confirm esc-1 approved — cancelled curia-42',
      'confirm esc-2 lapsed — `curia-43` finished; nothing was executed',
    ])
    assert.deepEqual(reduction.takeOverseerNotes('thread-9'), [], 'drained notes never replay into a later turn')

    const replayed = new Reduction(dir)
    assert.deepEqual(replayed.takeOverseerNotes('thread-9'), [], 'the drain is a journal event too')
    assert.deepEqual(replayed.takeOverseerNotes('thread-other'), ['unrelated'])
  })

  test('an empty take writes no drain event', () => {
    const reduction = new Reduction(dir)
    assert.deepEqual(reduction.takeOverseerNotes('thread-9'), [])
    assert.deepEqual(journalEvents(dir), [], 'no notes ⇒ no journal traffic')
  })
})

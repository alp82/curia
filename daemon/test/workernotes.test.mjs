// The worker-note queue (#108 item 14, positive half): operator text in a
// worker-bound thread with no open escalation queues here and rides the
// worker's next tool result. The grace window tags a note typed just after an
// answered escalation with that escalation's id.

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EscalationStore } from '../src/store.mjs'

describe('worker-note queue', () => {
  let dir, store
  const dirs = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-notes-'))
    dirs.push(dir)
    store = new EscalationStore(dir)
  })

  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

  test('a note queues, drains once, and the drain is journalled', () => {
    store.queueWorkerNote('curia-9', 'D could be mentioned as well', { by: 'alp' })
    store.queueWorkerNote('curia-9', 'also check mobile', { by: 'alp' })
    const notes = store.takeWorkerNotes('curia-9')
    assert.deepEqual(notes.map((n) => n.text), ['D could be mentioned as well', 'also check mobile'])
    assert.deepEqual(store.takeWorkerNotes('curia-9'), [], 'drained means gone')
  })

  test('notes are per worker — another session drains nothing', () => {
    store.queueWorkerNote('curia-9', 'for nine', {})
    assert.deepEqual(store.takeWorkerNotes('curia-4'), [])
    assert.equal(store.takeWorkerNotes('curia-9').length, 1)
  })

  test('a note inside the grace window is tagged with the just-closed escalation', () => {
    const { record } = store.open({ worker: 'curia-9', ticket: '9', kind: 'choice', prompt: 'A or B?', options: ['A', 'B'] })
    store.answer(record.id, { answer: 'B', by: 'alp', via: 'button' })
    const { after } = store.queueWorkerNote('curia-9', 'D could be mentioned as well', {})
    assert.equal(after, record.id)
    const [note] = store.takeWorkerNotes('curia-9')
    assert.equal(note.after, record.id)
  })

  test('outside the grace window the tag is off — the note stands alone', () => {
    const { record } = store.open({ worker: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    store.answer(record.id, { answer: 'x', by: 'alp', via: 'button' })
    const { after } = store.queueWorkerNote('curia-9', 'much later thought', {
      now: Date.now() + 10 * 60_000,
    })
    assert.equal(after, null)
  })

  test('an OPEN escalation never tags — only closed records are "just answered"', () => {
    store.open({ worker: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'still open' })
    const { after } = store.queueWorkerNote('curia-9', 'note while open', {})
    assert.equal(after, null)
  })

  test('the queue survives a daemon restart — journal, not memory', () => {
    store.queueWorkerNote('curia-9', 'undelivered', {})
    const reborn = new EscalationStore(dir)
    assert.deepEqual(reborn.takeWorkerNotes('curia-9').map((n) => n.text), ['undelivered'])
    // and the drain replays too: a third boot sees nothing
    const third = new EscalationStore(dir)
    assert.deepEqual(third.takeWorkerNotes('curia-9'), [])
  })
})

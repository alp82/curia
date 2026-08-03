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
import { BARE_COMMAND_VERB } from '../src/bridge.mjs'

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

  // #108 item 23: "Cancel" typed at a worker thread queues as prose, so the
  // bridge's reply must name the way out. The detection is this regex — a
  // message that is nothing but a command verb.
  test('a bare command verb is detected, with case and punctuation forgiven', () => {
    for (const s of ['cancel', 'Cancel', 'STOP', 'pause', 'resume', 'status', 'cancel!', ' stop. ', 'status?']) {
      assert.ok(BARE_COMMAND_VERB.test(s), `"${s}" should read as a bare command verb`)
    }
  })

  test('a verb inside a sentence is a real note, not a swallowed command', () => {
    for (const s of ['cancel the deploy', 'please stop', 'status of the tests?', 'do not pause here', 'ok']) {
      assert.ok(!BARE_COMMAND_VERB.test(s), `"${s}" should read as prose`)
    }
  })

  // The recorded-answer hand-off (#139): an answer nothing live received is
  // re-queued as a worker note, so the resumed worker gets question and answer
  // on its first tool result.
  test('escalation_worker_died marks the record, and the mark survives a restart', () => {
    const { record } = store.open({ worker: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    store.logEvent('escalation_worker_died', { id: record.id, worker: 'curia-9', ticket: '9' })
    assert.equal(store.get(record.id).worker_died, true)
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.get(record.id).worker_died, true)
  })

  test('queueRecordedAnswer queues question and answer, tagged with the escalation id', () => {
    const { record } = store.open({ worker: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'deploy to staging first?' })
    store.answer(record.id, { answer: 'yes, staging first', by: 'alp', via: 'button' })
    store.queueRecordedAnswer(store.get(record.id))
    const [note] = store.takeWorkerNotes('curia-9')
    assert.equal(note.after, record.id)
    assert.match(note.text, /deploy to staging first\?/)
    assert.match(note.text, /yes, staging first/)
  })

  test('the hand-off note names attachment paths so a fresh worker can read them', () => {
    const { record } = store.open({ worker: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    store.answer(record.id, { answer: 'see the screenshot', attachments: ['/data/attachments/esc-1/image.png'], by: 'alp', via: 'thread' })
    store.queueRecordedAnswer(store.get(record.id))
    const [note] = store.takeWorkerNotes('curia-9')
    assert.match(note.text, /\/data\/attachments\/esc-1\/image\.png/)
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

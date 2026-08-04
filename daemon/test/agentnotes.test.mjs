// The agent-note queue (#108 item 14, positive half): operator text in an
// agent-bound thread with no open escalation queues here and rides the
// agent's next tool result. The grace window tags a note typed just after an
// answered escalation with that escalation's id.

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EscalationStore } from '../src/store.mjs'
import { COMMAND_SHAPED, commandHint, queuedNoteReply } from '../src/bridge.mjs'

describe('agent-note queue', () => {
  let dir, store
  const dirs = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-notes-'))
    dirs.push(dir)
    store = new EscalationStore(dir)
  })

  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

  test('a note queues, drains once, and the drain is journalled', () => {
    store.queueAgentNote('curia-9', 'D could be mentioned as well', { by: 'alp' })
    store.queueAgentNote('curia-9', 'also check mobile', { by: 'alp' })
    const notes = store.takeAgentNotes('curia-9')
    assert.deepEqual(notes.map((n) => n.text), ['D could be mentioned as well', 'also check mobile'])
    assert.deepEqual(store.takeAgentNotes('curia-9'), [], 'drained means gone')
  })

  test('notes are per agent — another session drains nothing', () => {
    store.queueAgentNote('curia-9', 'for nine', {})
    assert.deepEqual(store.takeAgentNotes('curia-4'), [])
    assert.equal(store.takeAgentNotes('curia-9').length, 1)
  })

  test('a note inside the grace window is tagged with the just-closed escalation', () => {
    const { record } = store.open({ agent: 'curia-9', ticket: '9', kind: 'choice', prompt: 'A or B?', options: ['A', 'B'] })
    store.answer(record.id, { answer: 'B', by: 'alp', via: 'button' })
    const { after } = store.queueAgentNote('curia-9', 'D could be mentioned as well', {})
    assert.equal(after, record.id)
    const [note] = store.takeAgentNotes('curia-9')
    assert.equal(note.after, record.id)
  })

  test('outside the grace window the tag is off — the note stands alone', () => {
    const { record } = store.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    store.answer(record.id, { answer: 'x', by: 'alp', via: 'button' })
    const { after } = store.queueAgentNote('curia-9', 'much later thought', {
      now: Date.now() + 10 * 60_000,
    })
    assert.equal(after, null)
  })

  test('an OPEN escalation never tags — only closed records are "just answered"', () => {
    store.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'still open' })
    const { after } = store.queueAgentNote('curia-9', 'note while open', {})
    assert.equal(after, null)
  })

  // #108 item 23: "Cancel" typed at an agent thread queues as prose, so the
  // bridge's reply must name the way out. The detection is this regex — a
  // message that is nothing but a command.
  test('a bare command verb is detected, with case and punctuation forgiven', () => {
    for (const s of ['cancel', 'Cancel', 'STOP', 'pause', 'resume', 'status', 'cancel!', ' stop. ', 'status?']) {
      assert.ok(COMMAND_SHAPED.test(s), `"${s}" should read as a command`)
    }
  })

  // #170: the verb WITH its ticket is the surface's own syntax, and the more
  // natural thing to type. It was the one shape that got no hint at all — an
  // operator waited an hour on a `cancel 166` that had queued as prose.
  test('a verb with its ticket is detected too — the shape that cost an hour', () => {
    for (const s of ['cancel 166', 'Cancel #166', 'resume 12', 'start 166', 'attach 166', 'cancel all', 'resume all.']) {
      assert.ok(COMMAND_SHAPED.test(s), `"${s}" should read as a command`)
    }
  })

  test('a verb inside a sentence is a real note, not a swallowed command', () => {
    for (const s of ['cancel the deploy', 'please stop', 'status of the tests?', 'do not pause here', 'ok', 'cancel 166 once the tests pass']) {
      assert.ok(!COMMAND_SHAPED.test(s), `"${s}" should read as prose`)
    }
  })

  // The hint names the channel, because that is the whole difference between
  // the words working and the words queueing.
  test('the hint names the command the operator meant, and where it runs', () => {
    assert.equal(commandHint('cancel 166', '166', 'C1'), 'commands run in <#C1>, never in a ticket thread — say `cancel 166` there')
    // stop and pause are not verbs the surface has; at an agent they mean cancel
    assert.match(commandHint('stop', '166', 'C1'), /say `cancel 166` there/)
    assert.match(commandHint('pause', '166', 'C1'), /say `cancel 166` there/)
    // status is the one verb that takes no ticket
    assert.match(commandHint('status', '166', 'C1'), /say `status` there/)
    assert.match(commandHint('resume', null, 'C1'), /say `resume <n>` there/)
  })

  // #170: the reply promised "it reads this with its next tool result" for an
  // agent that had already died on its own command line. An hour of waiting
  // came out of that one sentence.
  test('the reply refuses to promise a delivery a dead agent cannot make', () => {
    const dead = queuedNoteReply({ owner: 'curia-166', q: { reads: false, ticket: '166' }, text: 'look at the logs', channelId: 'C1' })
    assert.equal(dead.length, 1, 'prose gets no command hint')
    assert.match(dead[0], /NOT running/)
    assert.match(dead[0], /resume 166/)
    assert.ok(!dead[0].includes('next tool result'), 'the promise must not survive on a dead agent')

    const live = queuedNoteReply({ owner: 'curia-9', q: { reads: true, ticket: '9' }, text: 'look at the logs', channelId: 'C1' })
    assert.match(live[0], /reads this with its next tool result/)
  })

  test('an unknown liveness keeps the old promise — only positive evidence demotes it', () => {
    const [line] = queuedNoteReply({ owner: 'curia-9', q: { ticket: '9' }, text: 'hi', channelId: 'C1' })
    assert.match(line, /next tool result/)
  })

  test('a command at a dead agent says BOTH — nothing reads it, and where it runs', () => {
    const lines = queuedNoteReply({ owner: 'curia-166', q: { reads: false, ticket: '166' }, text: 'cancel 166', channelId: 'C1' })
    assert.equal(lines.length, 2)
    assert.match(lines[0], /NOT running/)
    assert.match(lines[1], /commands run in <#C1>/)
    assert.match(lines[1], /`cancel 166`/)
  })

  test('the grace-window tag still rides the live line', () => {
    const [line] = queuedNoteReply({ owner: 'curia-9', q: { reads: true, ticket: '9', after: 'esc-13' }, text: 'and one more thing', channelId: 'C1' })
    assert.match(line, /noted as after esc-13/)
  })

  // The recorded-answer hand-off (#139): an answer nothing live received is
  // re-queued as an agent note, so the resumed agent gets question and answer
  // on its first tool result.
  test('escalation_agent_died marks the record, and the mark survives a restart', () => {
    const { record } = store.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    store.logEvent('escalation_agent_died', { id: record.id, agent: 'curia-9', ticket: '9' })
    assert.equal(store.get(record.id).agent_died, true)
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.get(record.id).agent_died, true)
  })

  test('queueRecordedAnswer queues question and answer, tagged with the escalation id', () => {
    const { record } = store.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'deploy to staging first?' })
    store.answer(record.id, { answer: 'yes, staging first', by: 'alp', via: 'button' })
    store.queueRecordedAnswer(store.get(record.id))
    const [note] = store.takeAgentNotes('curia-9')
    assert.equal(note.after, record.id)
    assert.match(note.text, /deploy to staging first\?/)
    assert.match(note.text, /yes, staging first/)
  })

  test('the hand-off note names attachment paths so a fresh agent can read them', () => {
    const { record } = store.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    store.answer(record.id, { answer: 'see the screenshot', attachments: ['/data/attachments/esc-1/image.png'], by: 'alp', via: 'thread' })
    store.queueRecordedAnswer(store.get(record.id))
    const [note] = store.takeAgentNotes('curia-9')
    assert.match(note.text, /\/data\/attachments\/esc-1\/image\.png/)
  })

  test('the queue survives a daemon restart — journal, not memory', () => {
    store.queueAgentNote('curia-9', 'undelivered', {})
    const reborn = new EscalationStore(dir)
    assert.deepEqual(reborn.takeAgentNotes('curia-9').map((n) => n.text), ['undelivered'])
    // and the drain replays too: a third boot sees nothing
    const third = new EscalationStore(dir)
    assert.deepEqual(third.takeAgentNotes('curia-9'), [])
  })
})

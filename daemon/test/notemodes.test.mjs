// The two delivery modes, and the notes that must never die in silence (#252,
// ADR-0013 "One voice per fact").
//
// Queued is the default: today's fire-and-forget path, and the receipt under it
// now carries an interrupt button. Interrupt is the other mode: a grace for the
// current tool call, then the words go into the pane as a user turn and the
// agent's own reply is the outcome.
//
// The other half is loss. Every expiry announces, on every path, and a
// cross-check verdict that expires is posted in FULL rather than mourned in one
// line — the #223 shape, where a four-finding `fail` verdict expired nine
// seconds after a whole reviewer session produced it and the thread showed
// nothing at all.

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EscalationStore, VERDICT_LABEL } from '../src/store.mjs'
import { DiscordBridge, noteReceipt, noteInterruptId, interruptedReceipt } from '../src/bridge.mjs'
import { verdictCarrier } from '../src/resolve.mjs'

const dirs = []
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-notemodes-'))
  dirs.push(d)
  return d
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// the queue: one note, one identity, one delivery
// ---------------------------------------------------------------------------

describe('a note has an identity, so a button can name it (#252)', () => {
  let dir, store

  beforeEach(() => {
    dir = tmpDir()
    store = new EscalationStore(dir)
  })

  test('queueing returns the id, and the id finds the note back', () => {
    const { id } = store.queueAgentNote('curia-9', 'look at the logs', { instance: 'curia-9@1' })
    assert.match(id, /^note-\d+$/)
    assert.equal(store.noteById(id).text, 'look at the logs')
    assert.equal(store.noteById(id).pending, true)
  })

  test('ids do not repeat, and a restart does not hand out one twice', () => {
    const a = store.queueAgentNote('curia-9', 'first', {}).id
    const b = store.queueAgentNote('curia-9', 'second', {}).id
    assert.notEqual(a, b)
    const reborn = new EscalationStore(dir)
    assert.notEqual(reborn.queueAgentNote('curia-9', 'third', {}).id, b)
  })

  test('an interrupt takes the words OUT of the queue — one fact, one delivery', () => {
    const { id } = store.queueAgentNote('curia-9', 'answer me', { instance: 'curia-9@1' })
    store.queueAgentNote('curia-9', 'and this one stays queued', { instance: 'curia-9@1' })

    assert.equal(store.interruptAgentNote(id).text, 'answer me')

    assert.deepEqual(store.takeAgentNotes('curia-9', 'curia-9@1').map((n) => n.text),
      ['and this one stays queued'], 'the interrupted words must never also ride a tool result')
  })

  test('the removal is journalled, so a restart does not resurrect the words', () => {
    const { id } = store.queueAgentNote('curia-9', 'answer me', { instance: 'curia-9@1' })
    store.interruptAgentNote(id, { by: 'alp' })
    assert.deepEqual(new EscalationStore(dir).takeAgentNotes('curia-9', 'curia-9@1'), [])
  })

  // The ADR's own case: no drain receipt exists, so an operator who wants a
  // reply presses interrupt — and by then the agent has usually read the words
  // already and said nothing. The button must still work.
  test('a note the agent already read is still interruptable, and nothing is journalled twice', () => {
    const { id } = store.queueAgentNote('curia-9', 'whats taking so long', { instance: 'curia-9@1' })
    store.takeAgentNotes('curia-9', 'curia-9@1')
    assert.equal(store.noteById(id).pending, false)

    assert.equal(store.interruptAgentNote(id).text, 'whats taking so long')

    const journal = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(journal.filter((e) => e.type === 'agent_note_interrupted').length, 0,
      'nothing left the queue, so nothing is recorded as leaving it')
  })

  test('an id that names nothing is null, never a guess', () => {
    assert.equal(store.noteById('note-404'), null)
    assert.equal(store.interruptAgentNote('note-404'), null)
  })
})

describe('expiry always announces, on every path (#252)', () => {
  let dir, store, fired

  beforeEach(() => {
    dir = tmpDir()
    store = new EscalationStore(dir)
    fired = []
    store.onNotesExpired = (ev) => fired.push(ev)
  })

  test('the hook carries the notes themselves, not a count', () => {
    store.queueAgentNote('curia-9', 'cancel 9', { instance: 'curia-9@1' })
    store.queueAgentNote('curia-9', 'and check the logs', { instance: 'curia-9@1' })

    const gone = store.expireAgentNotes('curia-9', null, 'finished')

    assert.deepEqual(gone.map((n) => n.text), ['cancel 9', 'and check the logs'])
    assert.equal(fired.length, 1, 'one expiry, one announcement')
    assert.deepEqual(fired[0].notes.map((n) => n.text), ['cancel 9', 'and check the logs'])
    assert.equal(fired[0].why, 'finished')
  })

  // The path that was silent before this ticket: an exit that nothing swept,
  // caught by the drain's own belt-and-braces sweep. It expired the words and
  // said nothing, which is exactly how the #223 verdict vanished.
  test('the drain sweep announces too — the path that used to be silent', () => {
    store.queueAgentNote('curia-9', 'typed at the predecessor', { instance: 'curia-9@15:13' })

    store.takeAgentNotes('curia-9', 'curia-9@16:36')

    assert.equal(fired.length, 1)
    assert.deepEqual(fired[0].notes.map((n) => n.text), ['typed at the predecessor'])
  })

  test('expiring nothing announces nothing — an empty sweep is not an event', () => {
    store.queueAgentNote('curia-9', 'a note for whoever resumes', {})
    assert.deepEqual(store.expireAgentNotes('curia-9', null), [])
    assert.deepEqual(fired, [])
  })

  test('an observer that throws never poisons the record', () => {
    store.onNotesExpired = () => { throw new Error('boom') }
    store.queueAgentNote('curia-9', 'cancel 9', { instance: 'curia-9@1' })
    assert.equal(store.expireAgentNotes('curia-9', null).length, 1)
    assert.deepEqual(new EscalationStore(dir).takeAgentNotes('curia-9'), [], 'the journal write already happened')
  })
})

// ---------------------------------------------------------------------------
// the receipt and its button
// ---------------------------------------------------------------------------

const idsOf = (rows) => rows.flatMap((r) => r.toJSON().components.map((c) => c.custom_id))
const labelsOf = (rows) => rows.flatMap((r) => r.toJSON().components.map((c) => c.label))

describe('the receipt carries the "Ask now" button (#252)', () => {
  test('a live agent gets the button, pointing at the note the receipt is about', () => {
    const r = noteReceipt({
      owner: 'curia-9', q: { reads: true, ticket: '9', id: 'note-7' }, text: 'look at the logs', channelId: 'C1',
    })
    assert.match(r.content, /queued for `curia-9`/)
    assert.deepEqual(idsOf(r.components), ['note|note-7|interrupt'])
    assert.equal(noteInterruptId('note-7'), 'note|note-7|interrupt')
  })

  // The operator's own wording. "Interrupt" was the first label and it read as
  // "end this agent" — the one thing no button does any more (#200). The press
  // asks a question and gets an answer, so the label says that.
  test('the label asks, and never reads as an ending', () => {
    const r = noteReceipt({
      owner: 'curia-9', q: { reads: true, ticket: '9', id: 'note-7' }, text: 'hi', channelId: 'C1',
    })
    assert.deepEqual(labelsOf(r.components), ['⚙️ Ask now'])
  })

  test('a dead agent gets no button — nothing queued, so nothing to ask', () => {
    const r = noteReceipt({
      owner: 'curia-166', q: { reads: false, ticket: '166' }, text: 'look at the logs', channelId: 'C1',
    })
    assert.match(r.content, /NOT running/)
    assert.deepEqual(r.components, [])
  })

  test('a note journalled before this ticket has no id, so its receipt has no button', () => {
    const r = noteReceipt({ owner: 'curia-9', q: { reads: true, ticket: '9' }, text: 'hi', channelId: 'C1' })
    assert.deepEqual(r.components, [])
  })

  test('the pressed receipt records the press in place and says what happens next', () => {
    const out = interruptedReceipt('-# queued for `curia-9`', { by: 'u1', session: 'curia-9', graceMs: 5000 })
    assert.match(out, /^-# queued for `curia-9`\n/, 'the receipt itself is kept — this is one message, edited')
    assert.match(out, /<@u1> asked for this now/)
    assert.match(out, /5s/)
    assert.match(out, /Its reply is the answer/)
  })
})

describe('a press on the interrupt button (#252)', () => {
  let bridge, replies, edits, calls, result

  beforeEach(() => {
    replies = []
    edits = []
    calls = []
    result = { ok: true, session: 'curia-9', ticket: '9', graceMs: 5000 }
    bridge = new DiscordBridge({
      token: 'x',
      allowedUsers: ['u1'],
      dataDir: tmpDir(),
      handlers: {
        interruptNote: async (id, by) => { calls.push({ id, by }); return result },
      },
      log: () => {},
    })
    bridge.channel = { id: 'C' }
  })

  const press = async (customId, userId = 'u1') => {
    let deferred = false
    await bridge.handleInteraction({
      customId,
      user: { id: userId },
      isButton: () => true,
      isChatInputCommand: () => false,
      isRepliable: () => true,
      message: {
        content: '-# queued for `curia-9` — it reads this with its next tool result',
        edit: async (payload) => { edits.push(payload) },
      },
      deferUpdate: async () => { deferred = true },
      reply: async (payload) => { replies.push(payload) },
    })
    return deferred
  }

  test('it reaches the daemon with the note id and the presser', async () => {
    await press('note|note-7|interrupt')
    assert.deepEqual(calls, [{ id: 'note-7', by: 'u1' }])
  })

  // ADR-0013's button rule: the card is the only record. The receipt IS the
  // record of what happened to those words, so the press is written onto it and
  // no interaction reply exists beside it.
  test('a success is silent and edits the receipt in place, button gone', async () => {
    const deferred = await press('note|note-7|interrupt')
    assert.equal(deferred, true)
    assert.deepEqual(replies, [], 'an interaction reply here would say the same fact twice')
    assert.equal(edits.length, 1)
    assert.match(edits[0].content, /queued for `curia-9`/)
    assert.match(edits[0].content, /<@u1> asked for this now/)
    assert.deepEqual(edits[0].components, [], 'pressed once, and there is nothing left to press')
  })

  // A refusal is the other case: nothing happened, so there is no record to
  // show. The presser is told privately and the button stays pressable.
  test('a refusal replies ephemerally and leaves the receipt alone', async () => {
    result = { ok: false, why: '`curia-9` is waiting on **esc-3** — answer that question instead' }
    await press('note|note-7|interrupt')
    assert.deepEqual(edits, [], 'nothing happened, so the thread gains no line')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ephemeral, true)
    assert.match(replies[0].content, /not asked/)
    assert.match(replies[0].content, /esc-3/)
  })

  test('an unauthorized press does nothing at all', async () => {
    await press('note|note-7|interrupt', 'someone-else')
    assert.deepEqual(calls, [])
    assert.deepEqual(edits, [])
  })

  test('an unknown note action is ignored rather than guessed at', async () => {
    await press('note|note-7|something-else')
    assert.deepEqual(calls, [])
    assert.deepEqual(replies, [])
  })
})

// ---------------------------------------------------------------------------
// the carrier text
// ---------------------------------------------------------------------------

describe('the verdict carrier (#252)', () => {
  test('it names the reviewer, the model, the findings and where the full text lives', () => {
    const out = verdictCarrier({
      agent: 'curia-review-223',
      model: 'gpt-5',
      verdict: 'VERDICT: fail\n1. a real race in the drain path',
      ticket: '223',
      url: 'https://github.com/o/r/pull/9',
      why: '`curia-223` is not running',
    })
    assert.match(out, /curia-review-223/, 'who wrote it')
    assert.match(out, /gpt-5/, 'what it ran on')
    assert.match(out, /a real race in the drain path/, 'what it found, in full')
    assert.match(out, /pull\/9/, 'where the full text lives')
    assert.match(out, /resume 223/, 'the way to act on it')
    assert.ok(!/^expired/im.test(out), 'never just "expired" — that is the #223 loss')
  })

  test('with no pull request it says this message is the only copy', () => {
    const out = verdictCarrier({ agent: 'r', model: 'm', verdict: 'fail', ticket: '5', url: null, why: 'it died' })
    assert.match(out, /only copy/)
  })
})

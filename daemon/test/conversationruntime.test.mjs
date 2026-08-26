import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConversationRuntime } from '../src/conversationruntime.mjs'
import { Reduction } from '../src/reduction.mjs'

const recorded = (name) => fs.readFileSync(
  new URL(`../../prototypes/overseer-pane/evidence/${name}`, import.meta.url),
  'utf8',
)

function paneDouble({ active = false } = {}) {
  const pane = {
    keys: [], texts: [],
    active: async () => active,
    key: async (session, key) => { pane.keys.push({ session, key }) },
    text: async (session, text) => { pane.texts.push({ session, text }) },
  }
  return pane
}

function journalDouble() {
  return {
    events: [],
    journal(type, detail) { this.events.push({ type, ...detail }) },
  }
}

describe('conversation message take back (#702)', () => {
  test('one Claude rewind keeps the text and records the active landing', async () => {
    const pane = paneDouble()
    const reduction = journalDouble()
    const runtime = new ConversationRuntime({ pane, reduction })

    const result = await runtime.takeBack({
      session: 'curia-89',
      role: 'agent',
      harness: 'claude',
      source: recorded('transcript-1-after-rewind.jsonl'),
    })

    // No recorded turn stands behind this transcript, so the prompt IS the
    // words: a message typed straight into the pane has no frame to strip.
    assert.equal(result.composer,
      '[curia note] The deploy of curia 1.4 finished at 17:20.\nGood. Now rename the maps effort to Atlas.')
    assert.deepEqual(pane.keys, [
      { session: 'curia-89', key: 'Escape' },
      { session: 'curia-89', key: 'Escape' },
      { session: 'curia-89', key: 'Up' },
      { session: 'curia-89', key: 'Enter' },
      { session: 'curia-89', key: 'Enter' },
      { session: 'curia-89', key: 'C-c' },
    ])
    assert.equal(result.receipt.landing, 'The conversation continues after “Park the maps effort until Monday.”')
    assert.deepEqual(result.receipt.remains, [
      'Files restored with the conversation.',
      'Shell side effects, Curia verbs, subagent edits, and commits stand.',
    ])
    assert.deepEqual(reduction.events[0], {
      type: 'transcript_landed',
      session: 'curia-89',
      landing_uuid: 'd0a31952-1600-42c2-913c-572e2944d035',
      tail_uuid: '4fd009e6-5cd9-4bdf-abaf-9d4a7d0ebefd',
    })
  })

  test('an overseer take back rehydrates its pane before the rewind', async () => {
    const prepared = []
    const runtime = new ConversationRuntime({
      pane: paneDouble(),
      reduction: journalDouble(),
      prepare: async (session, role) => { prepared.push({ session, role }) },
    })

    await runtime.takeBack({
      session: 'curia-console-2', role: 'overseer', harness: 'claude',
      source: recorded('transcript-1-after-rewind.jsonl'),
    })

    assert.deepEqual(prepared, [{ session: 'curia-console-2', role: 'overseer' }])
  })

  test('a rewind returns notes drained into that operator turn to the queue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-take-back-turn-'))
    const text = 'Good. Now rename the maps effort to Atlas.'
    try {
      const reduction = new Reduction(dir)
      reduction.recordConversationTurn('curia-89', 'Park the maps effort until Monday.')
      const earlier = reduction.queueAgentNote('curia-89', 'Earlier news.')
      assert.deepEqual(reduction.takeAgentNotes('curia-89').map((item) => item.id), [earlier.id])
      const note = reduction.queueAgentNote('curia-89', 'The deploy finished.')
      reduction.recordConversationTurn('curia-89', text)
      assert.deepEqual(reduction.takeAgentNotes('curia-89').map((item) => item.id), [note.id])
      assert.equal(reduction.noteById(note.id).pending, false)
      const later = reduction.queueAgentNote('curia-89', 'Later news.')
      const runtime = new ConversationRuntime({ pane: paneDouble(), reduction })

      const result = await runtime.takeBack({
        session: 'curia-89', role: 'agent', harness: 'claude',
        source: recorded('transcript-1-after-rewind.jsonl'),
      })

      assert.equal(result.composer, text)
      assert.equal(reduction.noteById(note.id).pending, true)
      assert.equal(reduction.noteById(earlier.id).pending, false)
      assert.ok(result.receipt.remains.includes('Returned 1 unread note to the queue.'))
      reduction.close()

      const rebuilt = new Reduction(dir)
      assert.equal(rebuilt.noteById(note.id).pending, true)
      assert.deepEqual(rebuilt.takeAgentNotes('curia-89').map((item) => item.id), [note.id, later.id])
      rebuilt.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a composed pane message gives back only the words the operator typed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-take-back-composed-'))
    try {
      const reduction = new Reduction(dir)
      const session = 'curia-console-2'
      const first = 'Park the maps effort until Monday.'
      const second = 'Good. Now rename the maps effort to Atlas.'
      reduction.recordConversationTurn(session, first)
      const note = reduction.queueAgentNote(session, 'The deploy finished.')
      reduction.recordConversationTurn(session, second)
      assert.deepEqual(reduction.takeAgentNotes(session).map((item) => item.id), [note.id])
      const runtime = new ConversationRuntime({ pane: paneDouble(), reduction })
      // What a pane message actually sends: the checkout verdict, then the
      // queued notes, then the operator's words last (#708).
      const message = (uuid, parentUuid, text) => JSON.stringify({
        type: 'user', uuid, parentUuid, message: { role: 'user', content: text },
      })
      const source = [
        message('m1', null, `Repo checkouts at 17:10\ncuria: clean\n\n${first}`),
        message('m2', 'm1', `Repo checkouts at 17:20\ncuria: clean\n\n[curia: The deploy finished.]\n\n${second}`),
      ].join('\n')

      const result = await runtime.takeBack({ session, role: 'overseer', harness: 'claude', source })

      assert.equal(result.composer, second)
      assert.equal(result.receipt.landing, `The conversation continues after \u201c${first}\u201d`)
      assert.ok(result.receipt.remains.includes('Returned 1 unread note to the queue.'))
      assert.equal(reduction.noteById(note.id).pending, true)
      reduction.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a rewind returns the overseer notes that message carried to their queue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-take-back-overseer-'))
    try {
      const reduction = new Reduction(dir)
      const session = 'curia-console-2'
      const key = 'console-2'
      const first = 'Park the maps effort until Monday.'
      const second = 'Good. Now rename the maps effort to Atlas.'
      reduction.recordConversationTurn(session, first)
      reduction.addOverseerNote(key, 'The deploy of curia 1.4 finished at 17:20.')
      // What a pane message does, in its order: drain, carry, then the surface
      // records the turn those notes rode in on.
      assert.deepEqual(reduction.takeOverseerNotes(key), ['The deploy of curia 1.4 finished at 17:20.'])
      reduction.carryOverseerNotes(session, key, ['The deploy of curia 1.4 finished at 17:20.'])
      reduction.recordConversationTurn(session, second)
      assert.deepEqual(reduction.takeOverseerNotes(key), [])
      const runtime = new ConversationRuntime({ pane: paneDouble(), reduction })
      const message = (uuid, parentUuid, text) => JSON.stringify({
        type: 'user', uuid, parentUuid, message: { role: 'user', content: text },
      })
      const source = [
        message('m1', null, first),
        message('m2', 'm1', `[curia: The deploy of curia 1.4 finished at 17:20.]\n\n${second}`),
      ].join('\n')

      const result = await runtime.takeBack({ session, role: 'overseer', harness: 'claude', source })

      assert.equal(result.composer, second)
      assert.ok(result.receipt.remains.includes('Returned 1 unread note to the queue.'))
      assert.deepEqual(reduction.overseerNotes.get(key), ['The deploy of curia 1.4 finished at 17:20.'])
      reduction.close()

      const rebuilt = new Reduction(dir)
      assert.deepEqual(rebuilt.takeOverseerNotes(key), ['The deploy of curia 1.4 finished at 17:20.'])
      rebuilt.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('one Codex backtrack keeps the tree and restores the operator text', async () => {
    const pane = paneDouble({ active: true })
    const reduction = journalDouble()
    const runtime = new ConversationRuntime({ pane, reduction })
    const message = (role, text) => JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    })

    const result = await runtime.takeBack({
      session: 'curia-90', role: 'agent', harness: 'codex',
      source: [message('user', 'Start here.'), message('assistant', 'Started.'), message('user', 'Change course.')].join('\n'),
    })

    assert.equal(result.composer, 'Change course.')
    assert.deepEqual(pane.keys, [
      { session: 'curia-90', key: 'Escape' },
      { session: 'curia-90', key: 'Escape' },
      { session: 'curia-90', key: 'Escape' },
      { session: 'curia-90', key: 'Enter' },
      { session: 'curia-90', key: 'C-u' },
    ])
    assert.deepEqual(result.receipt.remains, [
      'The tree stands. Only the conversation rewound.',
      'Shell side effects, Curia verbs, subagent edits, and commits stand.',
    ])
    assert.ok(!reduction.events.some((event) => event.type === 'transcript_landed'))
  })

  test('the first operator message cannot be taken back', async () => {
    const pane = paneDouble()
    const runtime = new ConversationRuntime({ pane, reduction: journalDouble() })
    const source = JSON.stringify({
      type: 'user', uuid: 'start', parentUuid: null,
      message: { content: 'Start this ticket.' },
    })

    await assert.rejects(
      runtime.takeBack({ session: 'curia-89', role: 'agent', harness: 'claude', source }),
      (error) => error.status === 409 && /first message/.test(error.message),
    )
    assert.deepEqual(pane.keys, [])
  })

  test('an unread note returns from the queue without rewinding the pane', async () => {
    const pane = paneDouble({ active: true })
    const taken = []
    const reduction = {
      ...journalDouble(),
      noteById: () => ({ id: 'note-4', agent: 'curia-89', text: 'Use staging.', pending: true }),
      takeBackAgentNote: (id) => { taken.push(id); return true },
    }
    const runtime = new ConversationRuntime({ pane, reduction })

    const result = await runtime.takeBack({
      session: 'curia-89',
      role: 'agent',
      harness: 'claude',
      source: recorded('transcript-1-after-rewind.jsonl'),
      target: { kind: 'note', id: 'note-4' },
    })

    assert.equal(result.composer, 'Use staging.')
    assert.deepEqual(taken, ['note-4'])
    assert.deepEqual(pane.keys, [])
    assert.equal(result.correction, null)
    assert.deepEqual(result.receipt, {
      headline: 'Took back your unread note.',
      landing: 'The conversation did not change.',
      remains: ['Nothing reached the conversation.', 'World state did not change.'],
    })
  })

  test('an unread note stays taken back after a daemon restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-take-back-note-'))
    try {
      const first = new Reduction(dir)
      const note = first.queueAgentNote('curia-89', 'Use staging.')

      assert.equal(first.takeBackAgentNote(note.id)?.text, 'Use staging.')
      assert.equal(first.noteById(note.id).pending, false)
      first.close()

      const rebuilt = new Reduction(dir)
      assert.equal(rebuilt.noteById(note.id).pending, false)
      rebuilt.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a read note interrupts and returns a correction draft', async () => {
    const pane = paneDouble({ active: true })
    const reduction = {
      ...journalDouble(),
      noteById: () => ({ id: 'note-4', agent: 'curia-89', text: 'Use staging.', pending: false }),
    }
    const runtime = new ConversationRuntime({ pane, reduction })

    const result = await runtime.takeBack({
      session: 'curia-89', role: 'agent', harness: 'claude', source: '',
      target: { kind: 'note', id: 'note-4' },
    })

    assert.equal(result.composer, 'Use staging.')
    assert.deepEqual(pane.keys, [{ session: 'curia-89', key: 'Escape' }])
    assert.deepEqual(result.correction, {
      kind: 'note', id: 'note-4', prefix: 'Correction to the note above:',
    })
    assert.deepEqual(result.receipt, {
      headline: 'Started a correction for your note.',
      landing: 'The conversation did not rewind.',
      remains: ['The note and all later work stand.'],
    })
  })

  test('an answered card opens a correction card without transcript surgery', async () => {
    const pane = paneDouble({ active: true })
    const reopened = []
    let answerCard
    const answered = new Promise((resolve) => { answerCard = resolve })
    const record = {
      id: 'esc-4', agent: 'curia-89', status: 'answered', answer: 'Use staging.',
    }
    const reduction = {
      ...journalDouble(),
      get: (id) => id === record.id ? record : null,
    }
    const runtime = new ConversationRuntime({
      pane,
      reduction,
      reopenCard: async (card) => { reopened.push(card); return { id: 'esc-5', answered } },
    })

    const result = await runtime.takeBack({
      session: 'curia-89', role: 'agent', harness: 'claude', source: '',
      target: { kind: 'answer', id: 'esc-4' },
    })

    assert.equal(result.composer, 'Use staging.')
    assert.deepEqual(pane.keys, [{ session: 'curia-89', key: 'Escape' }])
    assert.deepEqual(reopened, [record])
    assert.deepEqual(result.correction, {
      kind: 'answer', id: 'esc-4', card: 'esc-5', prefix: 'Correction to the answer above:',
    })
    assert.deepEqual(result.receipt, {
      headline: 'Started a correction for your answer.',
      landing: 'The conversation did not rewind.',
      remains: ['The answer and all later work stand.'],
    })

    answerCard({ text: 'Use production instead.' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(pane.texts, [{
      session: 'curia-89', text: 'Correction to the answer above:\nUse production instead.',
    }])
  })

  test('a correction send adds Curia framing before pane delivery', async () => {
    const pane = paneDouble()
    const reduction = journalDouble()
    const runtime = new ConversationRuntime({ pane, reduction })

    const result = await runtime.correct({
      session: 'curia-89',
      role: 'agent',
      correction: { kind: 'note', id: 'note-4', prefix: 'Correction to the note above:' },
      text: 'Use production instead.',
    })

    assert.deepEqual(pane.texts, [{
      session: 'curia-89', text: 'Correction to the note above:\nUse production instead.',
    }])
    assert.deepEqual(result, { ok: true })
    assert.equal(reduction.events.at(-1).type, 'conversation_correction_sent')
  })
})

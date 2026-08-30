import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readActiveMessages } from '../src/transcript.mjs'
import { Reduction } from '../src/reduction.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EVIDENCE = path.join(ROOT, 'prototypes', 'overseer-pane', 'evidence')

const texts = (items) => items.map(({ kind, text }) => ({ kind, text }))
const readRecordedMessages = (name, options) => readActiveMessages(
  'claude',
  fs.readFileSync(path.join(EVIDENCE, name), 'utf8').trimEnd().split('\n'),
  options,
).items

test('reads a recorded linear transcript', () => {
  const items = readRecordedMessages('transcript-1-after-rewind.jsonl')

  assert.deepEqual(texts(items), [
    { kind: 'prompt', text: 'Which agents run right now?' },
    { kind: 'say', text: 'Overseer here (req 4, 2 msgs in context). You said: "<system-reminder> As you answer the user\'s questions, you can use the following context: # currentDate Today\'s date is 2". Nothing else is moving.' },
    { kind: 'prompt', text: 'Park the maps effort until Monday.' },
    { kind: 'say', text: 'Overseer here (req 6, 4 msgs in context). You said: "Park the maps effort until Monday.". Nothing else is moving.' },
    { kind: 'prompt', text: '[curia note] The deploy of curia 1.4 finished at 17:20.\nGood. Now rename the maps effort to Atlas.' },
    { kind: 'say', text: 'Overseer here (req 8, 6 msgs in context). You said: "[curia note] The deploy of curia 1.4 finished at 17:20. Good. Now rename the maps effort to Atlas.". Nothing else is moving.' },
  ])
})

test('uses the journaled landing point before the next transcript message', () => {
  const items = readRecordedMessages(
    'transcript-1-after-rewind.jsonl',
    { landingUuid: 'd0a31952-1600-42c2-913c-572e2944d035' },
  )

  assert.deepEqual(texts(items), [
    { kind: 'prompt', text: 'Which agents run right now?' },
    { kind: 'say', text: 'Overseer here (req 4, 2 msgs in context). You said: "<system-reminder> As you answer the user\'s questions, you can use the following context: # currentDate Today\'s date is 2". Nothing else is moving.' },
    { kind: 'prompt', text: 'Park the maps effort until Monday.' },
    { kind: 'say', text: 'Overseer here (req 6, 4 msgs in context). You said: "Park the maps effort until Monday.". Nothing else is moving.' },
  ])
})

test('excludes the abandoned branch from a recorded forked transcript', () => {
  const items = readRecordedMessages('transcript-2-after-fork.jsonl')

  assert.deepEqual(texts(items), [
    { kind: 'prompt', text: 'Which agents run right now?' },
    { kind: 'say', text: 'Overseer here (req 4, 2 msgs in context). You said: "<system-reminder> As you answer the user\'s questions, you can use the following context: # currentDate Today\'s date is 2". Nothing else is moving.' },
    { kind: 'prompt', text: 'Park the maps effort until Monday.' },
    { kind: 'say', text: 'Overseer here (req 6, 4 msgs in context). You said: "Park the maps effort until Monday.". Nothing else is moving.' },
    { kind: 'prompt', text: 'Rename the maps effort to Atlas Prime.' },
    { kind: 'say', text: 'Overseer here (req 10, 6 msgs in context). You said: "Rename the maps effort to Atlas Prime.". Nothing else is moving.' },
  ])
})

test('the journal keeps the landing point through a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-transcript-'))
  let reduction = new Reduction(dir)
  try {
    reduction.journal('transcript_rewound', { agent: 'curia-11', landing_uuid: 'parent-1' })
    assert.equal(reduction.transcriptLanding('curia-11'), 'parent-1')
    reduction.close()

    reduction = new Reduction(dir)
    assert.equal(reduction.transcriptLanding('curia-11'), 'parent-1')
    reduction.journal('transcript_branch_started', { agent: 'curia-11' })
    assert.equal(reduction.transcriptLanding('curia-11'), null)
  } finally {
    reduction.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// The composite send on the Chat stream (#716). The one renderer Discord
// posts from gives the transcript item its sequence, so Curia app draws the same
// rails. The deciding message is marked, because the page draws it as the
// card from the daemon's record.
const SEND = [
  { format: 'prose', label: 'answer', prose: '**The cap held.** Cooling ran to 14:20.' },
  { format: 'choice', label: 'decision', headline: 'Keep the cap?', options: [
    { label: 'Keep it.', handle: 'keep', consequence: 'The cap stands.' },
    { label: 'Drop it.', handle: 'drop', consequence: 'The cap goes.' },
  ] },
]

test('a composite curia call carries its rendered sequence, on the claude harness', () => {
  const line = JSON.stringify({
    type: 'assistant', uuid: 'a1', parentUuid: null, timestamp: '2026-08-26T09:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__curia__ask_human', input: { messages: SEND } }] },
  })
  const [item] = readActiveMessages('claude', [line]).items
  assert.equal(item.kind, 'tool')
  assert.equal(item.brief, 'send of 2: answer · decision')
  assert.equal(item.text, undefined)
  assert.deepEqual(item.send.map((m) => [m.rail, m.deciding]), [['-# 1 of 2 · answer', false], ['-# 2 of 2 · decision', true]])
  assert.equal(item.send[0].body, '**The cap held.** Cooling ran to 14:20.')
  assert.match(item.send[1].body, /^\*\*Keep the cap\?\*\*/)
})

test('a composite curia call carries its rendered sequence, on the codex harness', () => {
  const line = JSON.stringify({
    type: 'response_item', timestamp: '2026-08-26T09:00:00.000Z',
    payload: { type: 'function_call', call_id: 'c1', name: 'notify', namespace: 'mcp__curia', arguments: JSON.stringify({ messages: [SEND[0]] }) },
  })
  const [item] = readActiveMessages('codex', [line]).items
  assert.equal(item.name, 'curia.notify')
  assert.equal(item.brief, 'send of 1: answer')
  assert.deepEqual(item.send, [{ rail: '', body: '**The cap held.** Cooling ran to 14:20.', deciding: false, format: 'prose', label: 'answer' }])
})

test('a `messages` value the renderer cannot read leaves the brief alone', () => {
  const line = JSON.stringify({
    type: 'assistant', uuid: 'a2', parentUuid: null, timestamp: '2026-08-26T09:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__curia__notify', input: { messages: [null, 'x'] } }] },
  })
  const [item] = readActiveMessages('claude', [line]).items
  assert.equal(item.send, undefined)
  assert.equal(item.brief, 'send of 2: ? · ?')
})

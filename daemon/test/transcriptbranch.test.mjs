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
const read = (name, options) => readActiveMessages(
  'claude',
  fs.readFileSync(path.join(EVIDENCE, name), 'utf8').trimEnd().split('\n'),
  options,
).items

test('reads a recorded linear transcript', () => {
  const items = read('transcript-1-after-rewind.jsonl')

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
  const items = read(
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
  const items = read('transcript-2-after-fork.jsonl')

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

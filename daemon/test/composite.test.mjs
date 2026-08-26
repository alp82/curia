// Tests for src/composite.mjs (#716): the one renderer over the ADR-0026
// contract that `send.mjs` types. The contract's own rules are pinned in
// send.test.mjs; this file pins that the renderer reads that contract rather
// than a second one, and what each message comes out as.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compositeSendFaults, compositeSendSchemaFaults, lintCompositeSend,
  renderCompositeSend, compositeRail, MAX_MESSAGES_PER_SEND,
} from '../src/composite.mjs'
import { MESSAGES_PER_SEND } from '../src/send.mjs'

const prose = (label, text = '**The result is ready.** The journal owns the record.') => ({
  format: 'prose', label, prose: text, attachments: [],
})

const choice = () => ({
  format: 'choice',
  label: 'decision',
  headline: 'Which storage keeps the record?',
  options: [
    { label: 'Use the journal.', handle: 'journal', consequence: 'The record survives a restart.' },
    { label: 'Use memory.', handle: 'memory', consequence: 'A restart loses the record.' },
  ],
  attachments: [],
})

describe('the renderer reads the one contract', () => {
  test('the cap is the contract\'s cap', () => {
    assert.equal(MAX_MESSAGES_PER_SEND, MESSAGES_PER_SEND)
  })

  test('a send over the cap is refused whole, and the messages come back untouched', () => {
    assert.deepEqual(compositeSendFaults([prose('answer'), choice()]), [])
    const messages = [1, 2, 3, 4, 5].map((n) => prose(`part ${n}`))
    const before = structuredClone(messages)
    assert.match(compositeSendFaults(messages).join(' | '), /5 messages over the 4 cap/)
    assert.deepEqual(messages, before, 'a refusal must not drop the fifth message')
    assert.deepEqual(compositeSendFaults([prose('a'), prose('b'), prose('c')], { maxMessages: 2 }).length, 1)
  })

  test('the deciding message is last, and there is at most one', () => {
    assert.match(compositeSendFaults([choice(), prose('follow-up')]).join(' | '), /deciding message is 1 of 2\. It posts last/)
    assert.match(compositeSendFaults([choice(), { ...choice(), label: 'second' }]).join(' | '), /2 deciding messages/)
  })

  test('the fields are the contract\'s: `prose` carries the prose, and `text` is named', () => {
    const faults = compositeSendSchemaFaults([{ format: 'prose', label: 'answer', text: 'words' }]).join(' | ')
    assert.match(faults, /messages\[0\]\.text: a `prose` message does not carry it/)
    assert.match(faults, /messages\[0\]\.prose: missing/)
  })

  test('the words take the grades they already had', () => {
    const faults = lintCompositeSend([prose('x'.repeat(21)), choice()]).join(' | ')
    assert.match(faults, /messages\[0\]\.label: 21 characters over the 20 cap/)
    assert.match(lintCompositeSend([prose('answer', 'No bold lead.')]).join(' | '), /lead with the conclusion, in bold/)
  })
})

describe('the rail', () => {
  test('curia writes the count, and a send of one carries none', () => {
    assert.equal(compositeRail({ label: 'answer' }, 0, 3), '-# 1 of 3 · answer')
    assert.equal(compositeRail({ label: 'answer' }, 0, 1), '')
    assert.equal(renderCompositeSend([prose('answer')])[0].content, '**The result is ready.** The journal owns the record.')
    assert.equal(renderCompositeSend([prose('answer')])[0].rail, '')
  })
})

describe('the rendered sequence', () => {
  test('one renderer gives every surface the same ordered message sequence', () => {
    const messages = [
      { ...prose('answer', '**The journal owns the record.** It survives a restart.'), picture: '/workspace/chart.png' },
      {
        format: 'round', label: 'decision', headline: 'Choose the limits.', attachments: ['/workspace/limits.md'],
        questions: [{ text: 'How many messages?', background: 'Discord keeps the deciding message last.', recommendation: 'Four.' }],
      },
    ]

    const rendered = renderCompositeSend(messages)
    assert.equal(rendered.length, 2)
    assert.equal(rendered[0].rail, '-# 1 of 2 · answer')
    assert.match(rendered[0].content, /^-# 1 of 2 · answer\n\*\*The journal owns the record\.\*\* It survives a restart\.$/)
    assert.deepEqual(rendered[0].attachments, ['/workspace/chart.png'])
    assert.equal(rendered[0].deciding, false)
    assert.equal(rendered[0].payload, null)
    assert.match(rendered[1].content, /^-# 2 of 2 · decision\n\*\*Choose the limits\.\*\*/)
    // The question background: small print, behind 💡, under its line.
    assert.match(rendered[1].content, /\*\*1\.\*\* How many messages\?\n-# 💡 Discord keeps the deciding message last\.\n↳ Four\./)
    assert.deepEqual(rendered[1].attachments, ['/workspace/limits.md'])
    assert.equal(rendered[1].kind, 'free-text')
    assert.equal(rendered[1].deciding, true)
    assert.equal(rendered[1].payload.headline, 'Choose the limits.')
    assert.equal(rendered[1].payload.questions[0].background, 'Discord keeps the deciding message last.')
    assert.equal('visual' in rendered[1].payload, false, 'the retired field is not reborn on the record')
  })

  test('a visual message is its fenced block, a picture-only one says so, and a files message is its caption', () => {
    const rendered = renderCompositeSend([
      { format: 'visual', label: 'flow', diagram: 'a -> b', attachments: [] },
      { format: 'visual', label: 'mock', picture: '/workspace/mock.png', attachments: [] },
      { format: 'files', label: 'patch', caption: 'The complete patch.', attachments: ['/workspace/fix.patch'] },
    ])
    assert.equal(rendered[0].body, '```\na -> b\n```')
    assert.equal(rendered[1].body, '-# Picture attached.')
    assert.deepEqual(rendered[1].attachments, ['/workspace/mock.png'])
    assert.equal(rendered[2].body, 'The complete patch.')
    assert.equal(rendered[2].content, '-# 3 of 3 · patch\nThe complete patch.')
  })

  test('a prose message keeps its table and its facts under the prose', () => {
    const [m] = renderCompositeSend([{ ...prose('cost'), table: 'a  b\n1  2', detail: 'Measured on the box.' }])
    assert.equal(m.body, '**The result is ready.** The journal owns the record.\n\n```\na  b\n1  2\n```\n\nDetails: ||Measured on the box.||')
  })
})

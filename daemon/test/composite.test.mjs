import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compositeSendFaults, compositeSendSchemaFaults, lintCompositeSend,
  renderCompositeSend,
} from '../src/composite.mjs'

const prose = (label, text = 'The result is ready.') => ({
  format: 'prose', label, text, attachments: [],
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

describe('the composite send contract', () => {
  test('one send carries no more than four typed messages', () => {
    assert.deepEqual(compositeSendFaults([prose('answer'), choice()]), [])

    const messages = [1, 2, 3, 4, 5].map((n) => prose(`part ${n}`))
    const before = structuredClone(messages)
    const faults = compositeSendFaults(messages)

    assert.match(faults.join(' | '), /5 messages over the 4 message cap/)
    assert.deepEqual(messages, before, 'a refusal must not drop the fifth message')
  })

  test('one deciding message is allowed, and it must be last', () => {
    const twoDecisions = [choice(), { ...choice(), label: 'second decision' }]
    assert.match(compositeSendFaults(twoDecisions).join(' | '), /at most one deciding message/)

    const decisionFirst = [choice(), prose('follow-up')]
    assert.match(compositeSendFaults(decisionFirst).join(' | '), /deciding message at messages\[0\] must be last/)

    assert.deepEqual(compositeSendFaults([prose('answer'), choice()]), [])
  })

  test('every entry names one supported format', () => {
    const formats = ['prose', 'round', 'choice', 'approve-reject', 'preview-review', 'visual', 'files']
    for (const format of formats) {
      assert.doesNotMatch(
        compositeSendFaults([{ format, label: format, attachments: [] }]).join(' | '),
        /\.format:/,
      )
    }

    const faults = compositeSendFaults([{ format: 'markdown', label: 'answer', attachments: [] }])
    assert.match(faults.join(' | '), /messages\[0\]\.format: "markdown" is not supported/)
  })

  test('labels cap at 20 characters, and attachments are path strings', () => {
    assert.deepEqual(compositeSendFaults([prose('x'.repeat(20))]), [])
    assert.match(compositeSendFaults([prose('x'.repeat(21))]).join(' | '), /label: 21 characters over the 20 cap/)
    assert.match(compositeSendFaults([{ ...prose('answer'), attachments: 'answer.md' }]).join(' | '), /attachments: expected an array of file paths/)
    assert.match(compositeSendFaults([{ ...prose('answer'), attachments: ['answer.md', 2] }]).join(' | '), /attachments\[1\]: expected a file path/)
  })

  test('the new visual and attachment names are accepted without losing retired fields', () => {
    const accepted = {
      ...prose('answer'), picture: '/workspace/chart.png', table: 'A  B\n1  2', diagram: 'A -> B',
      attachments: ['/workspace/details.md'],
    }
    assert.deepEqual(compositeSendFaults([accepted]), [])

    const retired = [{ ...prose('answer'), visual: 'A -> B', images: ['/workspace/chart.png'] }]
    const before = structuredClone(retired)
    const faults = compositeSendFaults(retired).join(' | ')
    assert.match(faults, /visual: retired.*table.*diagram/)
    assert.match(faults, /images: retired.*attachments/)
    assert.deepEqual(retired, before)
  })

  test('prose caps at 1600 and tells the author to compose another message', () => {
    assert.deepEqual(lintCompositeSend([prose('answer', 'x'.repeat(1600))]), [])
    const faults = lintCompositeSend([prose('answer', 'x'.repeat(1601))]).join(' | ')
    assert.match(faults, /messages\[0\]\.text: 1601 characters over the 1600 cap/)
    assert.match(faults, /Compose a second prose message/)
  })

  test('question background is grade B prose capped at 600 characters', () => {
    const round = {
      format: 'round', label: 'decision', headline: 'Which limit should apply?', attachments: [],
      questions: [{ text: 'How many messages?', background: 'x'.repeat(600), recommendation: 'Four.' }],
    }
    assert.deepEqual(compositeSendSchemaFaults([round]), [])
    assert.deepEqual(lintCompositeSend([round]), [])

    round.questions[0].background += 'x'
    assert.match(lintCompositeSend([round]).join(' | '), /background: 601 characters over the 600 cap/)
  })

  test('each format enforces its own content floor', () => {
    const valid = [
      prose('answer'),
      {
        format: 'round', label: 'questions', headline: 'Choose the limits.',
        questions: [{ text: 'How many?', recommendation: 'Four.' }], attachments: [],
      },
      choice(),
      { format: 'approve-reject', label: 'approval', headline: 'Ship the change?', attachments: [] },
      { format: 'preview-review', label: 'preview', headline: 'Does the page read well?', preview_url: 'https://preview.invalid', attachments: [] },
      { format: 'visual', label: 'flow', diagram: 'input -> output', attachments: [] },
      { format: 'files', label: 'patch', caption: 'The complete patch.', attachments: ['/workspace/fix.patch'] },
    ]
    for (const message of valid) assert.deepEqual(compositeSendSchemaFaults([message]), [], message.format)

    assert.match(compositeSendSchemaFaults([{ format: 'prose', label: 'answer' }]).join(' | '), /text: missing/)
    assert.match(compositeSendSchemaFaults([{ format: 'visual', label: 'flow' }]).join(' | '), /picture, table, or diagram/)
    assert.match(compositeSendSchemaFaults([{ format: 'files', label: 'patch', caption: 'Patch.' }]).join(' | '), /attachments: missing/)
  })

  test('choice options require an explicit short button handle', () => {
    const without = choice()
    delete without.options[0].handle
    assert.match(compositeSendSchemaFaults([without]).join(' | '), /options\[0\]\.handle: missing/)

    const bad = choice()
    bad.options[0].handle = { text: 'journal' }
    assert.match(compositeSendSchemaFaults([bad]).join(' | '), /options\[0\]\.handle: expected one line of text/)
  })

  test('a format refuses content fields that belong to another format', () => {
    const payload = [{ ...prose('answer'), questions: [{ text: 'Hidden question?' }] }]
    const before = structuredClone(payload)
    assert.match(compositeSendSchemaFaults(payload).join(' | '), /questions: not permitted on the prose format/)
    assert.deepEqual(payload, before)
  })

  test('typed card fields and handles keep their existing lint grades', () => {
    const message = choice()
    message.options[0].handle = 'journal\nnow'
    assert.match(lintCompositeSend([message]).join(' | '), /options\[0\]\.handle: a newline/)

    message.options[0].handle = 'journal'
    message.options[0].consequence = 'A robust record.'
    assert.match(lintCompositeSend([message]).join(' | '), /options\[0\]\.consequence: the marketing adjective "robust"/)
  })

  test('tables and diagrams keep the phone geometry limit', () => {
    const table = { ...prose('answer'), table: 'x'.repeat(43) }
    const diagram = { ...prose('answer'), diagram: Array(21).fill('row').join('\n') }
    const faults = lintCompositeSend([table, diagram]).join(' | ')
    assert.match(faults, /messages\[0\]\.table: 43 columns over the 42 cap/)
    assert.match(faults, /messages\[1\]\.diagram: 21 lines over the 20 cap/)
  })

  test('a send and each typed field keep their declared types', () => {
    assert.match(compositeSendSchemaFaults([]).join(' | '), /messages: empty/)
    assert.match(compositeSendSchemaFaults(['answer']).join(' | '), /messages\[0\]: expected a typed message object/)

    const bad = choice()
    bad.headline = 42
    bad.timeline = 'yes'
    bad.options[0].recommended = 'yes'
    const before = structuredClone(bad)
    const faults = compositeSendSchemaFaults([bad]).join(' | ')
    assert.match(faults, /headline: expected text/)
    assert.match(faults, /timeline: expected true or false/)
    assert.match(faults, /options\[0\]\.recommended: expected true or false/)
    assert.deepEqual(bad, before)
  })

  test('one renderer gives every surface the same ordered message sequence', () => {
    const messages = [
      { ...prose('answer', 'The journal owns the record.'), picture: '/workspace/chart.png' },
      {
        format: 'round', label: 'decision', headline: 'Choose the limits.', attachments: ['/workspace/limits.md'],
        questions: [{ text: 'How many messages?', background: 'Discord keeps the deciding message last.', recommendation: 'Four.' }],
      },
    ]

    const rendered = renderCompositeSend(messages)
    assert.equal(rendered.length, 2)
    assert.match(rendered[0].content, /^-# 1 of 2 · answer\nThe journal owns the record\.$/)
    assert.deepEqual(rendered[0].attachments, ['/workspace/chart.png'])
    assert.equal(rendered[0].deciding, false)
    assert.match(rendered[1].content, /^-# 2 of 2 · decision\n\*\*Choose the limits\.\*\*/)
    assert.match(rendered[1].content, /-# 💡 Discord keeps the deciding message last\./)
    assert.deepEqual(rendered[1].attachments, ['/workspace/limits.md'])
    assert.equal(rendered[1].kind, 'free-text')
    assert.equal(rendered[1].deciding, true)
  })

  test('a single message carries no rail', () => {
    assert.equal(renderCompositeSend([prose('answer')])[0].content, 'The result is ready.')
  })
})

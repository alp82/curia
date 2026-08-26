// Tests for src/send.mjs (#691): the composite-send payload contract ADR-0026
// locks. A send is an ordered array, it carries at most four messages, at most
// one of them decides, and the deciding one goes last.
//
// Every test here reads PURE DATA. Discord and Atlas are two renderers of what
// this module accepts, and #716 builds them.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MESSAGES_PER_SEND, MESSAGE_FORMATS, DECIDING_FORMATS, CONTENT_FIELDS,
  sendFloorFaults, lintSend, sendHasText, sendPrompt, decidingIndex, isComposite,
  messageSchema, sendSchema,
} from '../src/send.mjs'
import { CAPS } from '../src/lint.mjs'

const names = (faults) => faults.join(' | ')

const prose = (label, text = 'The cap landed at 09:00 and cooling ran to 14:20.') => ({
  format: 'prose', label, prose: text,
})
const round = (label = 'decision') => ({
  format: 'round',
  label,
  headline: 'Re-arm cooling at boot, and from what source?',
  questions: [{ text: 'Should cooling re-arm at boot?', recommendation: 'Yes, from the stored cap.' }],
})

describe('the per-option handle on a composite choice (#712)', () => {
  test('the message schema keeps a handle, so the button can be short while the body keeps the words', () => {
    const parsed = messageSchema.parse({ format: 'choice', headline: 'Which?', options: [{ label: 'Stable, and wait', handle: 'stable' }, { label: 'Preview' }] })
    assert.equal(parsed.options[0].handle, 'stable')
    assert.equal(parsed.options[1].handle, undefined)
  })
})

describe('the catalog', () => {
  test('the seven formats of ADR-0026, and the four that decide', () => {
    assert.deepEqual(MESSAGE_FORMATS, ['prose', 'round', 'choice', 'approve-reject', 'preview-review', 'visual', 'files'])
    assert.deepEqual(DECIDING_FORMATS, ['round', 'choice', 'approve-reject', 'preview-review'])
    for (const f of DECIDING_FORMATS) assert.ok(MESSAGE_FORMATS.includes(f), `${f} is not in the catalog`)
  })

  test('every format has its permitted content fields', () => {
    for (const f of MESSAGE_FORMATS) assert.ok(CONTENT_FIELDS[f]?.length, `${f} permits nothing`)
  })

  test('the cap is four, which is the ADR-0026 default', () => {
    assert.equal(MESSAGES_PER_SEND, 4)
  })

  test('a composite call is one that carries the array, and nothing else is', () => {
    assert.equal(isComposite({ messages: [] }), true)
    assert.equal(isComposite({ headline: 'one card' }), false)
  })
})

describe('the cap on a send', () => {
  test('a send of the cap passes', () => {
    const send = [prose('answer'), prose('cost'), prose('reading'), round()]
    assert.deepEqual(sendFloorFaults(send), [])
  })

  test('a send over the cap is REFUSED, and no message is dropped', () => {
    const send = [prose('a'), prose('b'), prose('c'), prose('d'), round()]
    const faults = sendFloorFaults(send)
    assert.match(names(faults), /5 messages over the 4 cap/)
    assert.match(names(faults), /never drops a message/)
    assert.match(names(faults), /second call/, 'the refusal names the path, not only the number')
  })

  test('the cap is a parameter, because it is a curia.yaml row', () => {
    assert.match(names(sendFloorFaults([prose('a'), round()], { cap: 1 })), /2 messages over the 1 cap/)
  })

  test('an empty send and a missing one are both named', () => {
    assert.match(names(sendFloorFaults([])), /messages: empty/)
    assert.match(names(sendFloorFaults(undefined)), /messages: missing/)
  })
})

describe('the deciding message posts last', () => {
  test('a send whose decision is last passes', () => {
    assert.deepEqual(sendFloorFaults([prose('answer'), round()]), [])
    assert.equal(decidingIndex([prose('answer'), round()]), 1)
  })

  test('a decision that is not last is refused, and the send is not reordered for the agent', () => {
    const send = [round('decision'), prose('answer')]
    const faults = sendFloorFaults(send)
    assert.match(names(faults), /the deciding message is 1 of 2/)
    assert.match(names(faults), /buttons sit at the thread bottom/)
    assert.equal(send[0].format, 'round', 'the array the agent sent is untouched')
    assert.equal(send.length, 2, 'nothing is dropped to make the order legal')
  })

  test('two decisions are refused, and both are named', () => {
    const faults = sendFloorFaults([round('one'), prose('answer'), round('two')])
    assert.match(names(faults), /2 deciding messages at 1 and 3/)
    assert.match(names(faults), /never drops a message/)
  })

  test('a send that decides nothing is a send', () => {
    assert.deepEqual(sendFloorFaults([prose('answer'), { format: 'visual', label: 'the shape', diagram: 'a\nb' }]), [])
    assert.equal(decidingIndex([prose('answer')]), -1)
  })
})

describe('the rail label', () => {
  test('every message of a send of several carries one', () => {
    const faults = sendFloorFaults([{ format: 'prose', prose: 'the answer' }, round()])
    assert.match(names(faults), /messages\[0\]\.label: missing/)
  })

  test('a send of ONE carries no rail, so its label is optional', () => {
    assert.deepEqual(sendFloorFaults([{ format: 'prose', prose: 'the answer' }]), [])
  })

  test('the label is capped at 20 and linted as inline text', () => {
    assert.match(names(lintSend([prose('x'.repeat(CAPS.label + 1)), round()])), new RegExp(`messages\\[0\\]\\.label: ${CAPS.label + 1} characters over the ${CAPS.label} cap`))
    assert.match(names(lintSend([prose('see https://x.dev'), round()])), /messages\[0\]\.label: a link/)
  })
})

describe('the field vocabulary per format', () => {
  test('a prose message needs its prose', () => {
    assert.match(names(sendFloorFaults([{ format: 'prose', label: 'answer' }])), /messages\[0\]\.prose: missing/)
  })

  test('prose caps at 1600, not at the block cap', () => {
    assert.deepEqual(lintSend([{ format: 'prose', label: 'answer', prose: 'Short words. '.repeat(100) }]), [])
    const long = 'Short words here. '.repeat(100)
    assert.ok(long.length > CAPS.prose)
    assert.match(names(lintSend([{ format: 'prose', label: 'answer', prose: long }])), new RegExp(`messages\\[0\\]\\.prose: ${long.length} characters over the ${CAPS.prose} cap`))
  })

  test('a visual message shows one of the three', () => {
    assert.match(names(sendFloorFaults([{ format: 'visual', label: 'the shape' }])), /A visual message shows one thing/)
    assert.deepEqual(sendFloorFaults([{ format: 'visual', label: 'the shape', picture: '/workspace/mock.png' }]), [])
    assert.deepEqual(sendFloorFaults([{ format: 'visual', label: 'the shape', table: 'a  b\nc  d' }]), [])
  })

  test('a files message carries at least one file', () => {
    assert.match(names(sendFloorFaults([{ format: 'files', label: 'the diff' }])), /messages\[0\]\.attachments: missing/)
    assert.deepEqual(sendFloorFaults([{ format: 'files', label: 'the diff', attachments: ['/workspace/a.diff'] }]), [])
  })

  test('a field outside its format is NAMED rather than stripped, with the format that carries it', () => {
    const faults = sendFloorFaults([{ format: 'prose', label: 'answer', prose: 'a', questions: [{ text: 'q' }] }])
    assert.match(names(faults), /messages\[0\]\.questions: a `prose` message does not carry it\. A `round` message does\./)
  })

  test('a format outside the catalog is named against the catalog', () => {
    assert.match(names(sendFloorFaults([{ format: 'essay', label: 'answer' }])), /"essay" is not one of prose, round/)
    assert.match(names(sendFloorFaults([{ label: 'answer' }])), /messages\[0\]\.format: missing/)
  })

  test('an entry that is not an object is named, and the rest of the send is still read', () => {
    const faults = sendFloorFaults(['just a string', { format: 'prose', label: 'answer' }])
    assert.match(names(faults), /messages\[0\]\.: not a message/)
    assert.match(names(faults), /messages\[1\]\.prose: missing/)
  })
})

describe('a deciding message keeps the lint it already had', () => {
  test('a round takes the ADR-0019 floor under its ADR-0026 name', () => {
    const faults = sendFloorFaults([{ format: 'round', label: 'decision' }])
    assert.match(names(faults), /messages\[0\]\.headline: missing/)
    assert.match(names(faults), /messages\[0\]\.questions: missing/)
  })

  test('a choice still needs two options, each with its consequence', () => {
    const faults = sendFloorFaults([{
      format: 'choice', label: 'decision', headline: 'Which cap?', options: [{ label: 'the stored one' }],
    }])
    assert.match(names(faults), /messages\[0\]\.options: a choice needs two options or more/)
    assert.match(names(faults), /messages\[0\]\.options\[0\]\.consequence: missing/)
  })

  test('the word lint reaches inside a card of a send', () => {
    const faults = lintSend([{
      format: 'round', label: 'decision', headline: 'x'.repeat(CAPS.headline + 1),
      questions: [{ text: 'Should cooling re-arm?' }],
    }])
    assert.match(names(faults), new RegExp(`messages\\[0\\]\\.headline: ${CAPS.headline + 1} characters`))
  })

  test('the question background is Grade B at 600', () => {
    const q = (background) => lintSend([{
      format: 'round', label: 'decision', headline: 'Which cap?', questions: [{ text: 'Which one?', background }],
    }])
    assert.deepEqual(q('The cap landed at 09:00. Cooling ran until 14:20.'), [])
    assert.match(names(q('x'.repeat(CAPS.background + 1))), new RegExp(`messages\\[0\\]\\.questions\\[0\\]\\.background: ${CAPS.background + 1} characters over the ${CAPS.background} cap`))
  })
})

describe('the fields ADR-0026 retired', () => {
  test('a `visual` inside a message is named, and the rows are not dropped', () => {
    const m = { format: 'prose', label: 'answer', prose: 'a', visual: 'a  b\nc  d' }
    const faults = sendFloorFaults([m])
    assert.match(names(faults), /messages\[0\]\.visual: retired by ADR-0026/)
    assert.match(names(faults), /`table`/)
    assert.equal(m.visual, 'a  b\nc  d', 'the rows the agent wrote are still on the payload')
    assert.equal(faults.filter((f) => /\.visual:/.test(f)).length, 1, 'one fault, not two')
  })

  test('an `images` inside a message is named with its new home', () => {
    assert.match(names(sendFloorFaults([{ format: 'prose', label: 'answer', prose: 'a', images: ['/workspace/a.png'] }])), /messages\[0\]\.images: renamed to `attachments`/)
  })
})

describe('what a send says about itself', () => {
  test('a send with words has text, and one of empty entries does not', () => {
    assert.equal(sendHasText([prose('answer')]), true)
    assert.equal(sendHasText([{ format: 'prose' }, { format: 'round' }]), false)
    assert.equal(sendHasText('not a send'), false)
  })

  test('the prompt is the decision when there is one, and the prose otherwise', () => {
    assert.equal(sendPrompt([prose('answer'), round()]), 'Re-arm cooling at boot, and from what source?')
    assert.equal(sendPrompt([prose('answer', 'The cap landed at 09:00.')]), 'The cap landed at 09:00.')
    assert.equal(sendPrompt([]), null)
  })
})

describe('the shape a tool declares', () => {
  test('every field is optional to zod, so a schema rejection never traps a send', () => {
    assert.equal(messageSchema.safeParse({}).success, true)
  })

  test('the retired fields stay declared, so curia sees one rather than losing it', () => {
    const parsed = messageSchema.parse({ format: 'prose', prose: 'a', visual: 'a  b', images: ['/workspace/a.png'] })
    assert.equal(parsed.visual, 'a  b')
    assert.deepEqual(parsed.images, ['/workspace/a.png'])
  })

  test('the format is the one enum zod holds, because it is not prose', () => {
    assert.equal(messageSchema.safeParse({ format: 'essay' }).success, false)
    for (const f of MESSAGE_FORMATS) assert.equal(messageSchema.safeParse({ format: f }).success, true, f)
  })

  test('a send parses as an ordered array of messages', () => {
    const send = sendSchema.parse([prose('answer'), round()])
    assert.equal(send.length, 2)
    assert.equal(send[1].format, 'round')
    assert.equal(send[1].questions[0].text, 'Should cooling re-arm at boot?')
  })

  test('the three visual fields ride the message, and `visual` is not one of them', () => {
    const parsed = messageSchema.parse({ format: 'visual', picture: 'a.png', table: 'a  b', diagram: 'a\nb' })
    assert.equal(parsed.picture, 'a.png')
    assert.equal(parsed.table, 'a  b')
    assert.equal(parsed.diagram, 'a\nb')
  })
})

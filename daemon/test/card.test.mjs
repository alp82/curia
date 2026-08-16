// Tests for src/card.mjs (#418): the card-4 body #415 picked, composed once
// and read by both the record and the bridge.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { composeCard, composeReviewBody, visualBlock, optionLabels } from '../src/card.mjs'
import { lintReply, CHUNK_LIMIT } from '../src/messaging.mjs'

const CHOICE = {
  headline: 'A restart forgets every cooling. Re-arm it at boot, and from what?',
  visual: '09:00  cap lands, cooling until 14:20\n13:02  deploy, memory wiped',
  options: [
    {
      label: 'From the journal.',
      consequence: 'A guessed reset can hold at most 55 minutes too long.',
      example: 'start at 13:03 answers "opus cools until 14:20".',
      recommended: true,
    },
    { label: 'From a fresh reading.', consequence: 'It answers "am I near the cap", not "did I hit one".' },
  ],
  detail: 'The daemon has journalled provider_cooling with reset_at since #175.',
}

describe('composeCard: a choice', () => {
  const body = composeCard('choice', CHOICE)

  test('the headline leads, in bold and on its own line', () => {
    assert.equal(body.split('\n')[0], `**${CHOICE.headline}**`)
  })

  test('the visual rides a fence curia wrote', () => {
    assert.ok(body.includes('```\n09:00  cap lands, cooling until 14:20\n13:02  deploy, memory wiped\n```'))
  })

  test('every option carries its letter, its cost and its case', () => {
    assert.ok(body.includes('**A. From the journal.**'))
    assert.ok(body.includes('↳ A guessed reset can hold at most 55 minutes too long.'))
    assert.ok(body.includes('› start at 13:03 answers "opus cools until 14:20".'))
    assert.ok(body.includes('**B. From a fresh reading.**'))
  })

  test('an option with no example prints no example line', () => {
    assert.equal((body.match(/^› /gm) ?? []).length, 1)
  })

  test('the recommendation names the letter it picked', () => {
    assert.ok(body.includes('Recommendation: **A**.'))
  })

  test('a card with no recommended option says nothing about one', () => {
    const plain = composeCard('choice', { headline: 'h', options: [{ label: 'A', consequence: 'x' }] })
    assert.doesNotMatch(plain, /Recommendation/)
  })

  test('the detail is a spoiler, not a paragraph', () => {
    assert.ok(body.includes(`Details: ||${CHOICE.detail}||`))
  })

  test('the body keeps the messaging standard and fits one chunk', () => {
    assert.deepEqual(lintReply(body), [])
    assert.ok(body.length < CHUNK_LIMIT)
  })
})

describe('composeCard: a round', () => {
  const body = composeCard('free-text', {
    headline: 'Three questions before I build.',
    questions: [
      { text: 'Does the lint read an untyped call?', recommendation: 'No. It reads named fields only.' },
      { text: 'Where does the headline render?' },
    ],
  })

  test('the questions are numbered, and curia writes the numbers', () => {
    assert.ok(body.includes('**1.** Does the lint read an untyped call?'))
    assert.ok(body.includes('**2.** Where does the headline render?'))
  })

  test('a recommendation rides the question it belongs to', () => {
    assert.ok(body.includes('**1.** Does the lint read an untyped call?\n↳ No. It reads named fields only.'))
  })

  test('a question with no recommendation carries no line', () => {
    assert.equal((body.match(/^↳ /gm) ?? []).length, 1)
  })
})

describe('composeCard: the two-answer kinds', () => {
  test('curia keeps its own button words and the agent supplies the cost', () => {
    const body = composeCard('approve-reject', {
      headline: 'Take the cap at 3 rejections?',
      options: [{ consequence: 'The text goes out flagged.' }, { consequence: 'The question reaches nobody.' }],
    })
    assert.ok(body.includes('✅ Approve: The text goes out flagged.'))
    assert.ok(body.includes('❌ Reject: The question reaches nobody.'))
  })

  test('approve comes first whatever the agent numbered them', () => {
    const body = composeCard('preview-review', {
      headline: 'h',
      options: [{ consequence: 'first' }, { consequence: 'second' }],
    })
    assert.ok(body.indexOf('✅ Approve: first') < body.indexOf('❌ Reject: second'))
  })

  test('a card with no options is still a card', () => {
    assert.equal(composeCard('approve-reject', { headline: 'h' }), '**h**')
  })
})

describe('the timeline flag', () => {
  test('it renders a pointer and never a url: curia composes the link as a button', () => {
    const body = composeCard('free-text', { headline: 'h', questions: [{ text: 'q?' }], timeline: true })
    assert.ok(body.includes('-# The reasoning is on the timeline. The button is below.'))
    assert.doesNotMatch(body, /https?:\/\//)
  })
})

describe('visualBlock', () => {
  test('rows come in bare and leave fenced', () => {
    assert.equal(visualBlock('a\nb'), '```\na\nb\n```')
  })

  test('rows the agent fenced are not fenced twice', () => {
    assert.equal(visualBlock('```\na\nb\n```'), '```\na\nb\n```')
  })
})

describe('optionLabels', () => {
  test('a typed option gives up its label for the buttons and the menu', () => {
    assert.deepEqual(optionLabels(CHOICE), ['From the journal.', 'From a fresh reading.'])
  })

  test('the old string shape passes through unchanged', () => {
    assert.deepEqual(optionLabels({ options: ['A', 'B'] }), ['A', 'B'])
  })
})

describe('composeReviewBody', () => {
  test('the gate body is the headline, the visual and the spoiler', () => {
    const body = composeReviewBody({ headline: 'Typed ask_human.', detail: 'The lint module is daemon/src/lint.mjs.' })
    assert.equal(body, '**Typed ask_human.**\n\nDetails: ||The lint module is daemon/src/lint.mjs.||')
  })

  test('an untyped gate composes nothing', () => {
    assert.equal(composeReviewBody({}), '')
  })
})

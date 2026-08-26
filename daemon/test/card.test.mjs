// Tests for src/card.mjs (#418): the card-4 body #415 picked, composed once
// and read by both the record and the bridge.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeCard, composeReviewBody, composeResultBody, composeResultReport, composeNotify, composeOpening, NOTIFY_KINDS,
  visualBlock, optionLabels, composeVerdict, composeVerdictReport,
} from '../src/card.mjs'
import { lintReply, CHUNK_LIMIT } from '../src/messaging.mjs'

const CHOICE = {
  headline: 'A restart forgets every cooling. Re-arm it at boot, and from what?',
  diagram: '09:00  cap lands, cooling until 14:20\n13:02  deploy, memory wiped',
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

  test('the diagram rides a fence curia wrote', () => {
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
  test('the gate body is the headline, the table and the spoiler', () => {
    const body = composeReviewBody({ headline: 'Typed ask_human.', detail: 'The lint module is daemon/src/lint.mjs.' })
    assert.equal(body, '**Typed ask_human.**\n\nDetails: ||The lint module is daemon/src/lint.mjs.||')
  })

  test('a gate with no typed part composes nothing', () => {
    assert.equal(composeReviewBody({}), '')
  })
})

describe('composeResultReport: the ending report (#419)', () => {
  const REPORT = {
    status: 'resolved',
    headline: 'The ending report is typed, and curia lays it out.',
    summary: 'The report takes a headline, a summary, a detail and a table.',
    detail: 'The composer is daemon/src/card.mjs.',
    table: 'headline  150\nsummary   600',
  }

  test('the parts read top down: headline, table, summary, spoiler', () => {
    assert.equal(composeResultBody(REPORT), [
      '**The ending report is typed, and curia lays it out.**',
      '```\nheadline  150\nsummary   600\n```',
      'The report takes a headline, a summary, a detail and a table.',
      'Details: ||The composer is daemon/src/card.mjs.||',
    ].join('\n\n'))
  })

  test('the typed headline leads beside the resolved status', () => {
    const post = composeResultReport('resolved', REPORT)
    assert.equal(post.split('\n')[0], '✅ **resolved** - **The ending report is typed, and curia lays it out.**')
    assert.equal(post.match(/The ending report is typed/g).length, 1, 'the headline appears once')
    assert.ok(post.includes(REPORT.summary))
  })

  test('a report with no headline keeps the one line the thread has read since #253', () => {
    assert.equal(composeResultReport('blocked', { summary: 'the token was missing' }),
      '✅ **blocked**: the token was missing')
  })

  test('a report with no prose at all is still a status', () => {
    assert.equal(composeResultReport('aborted', {}), '✅ **aborted**')
  })

  test('curia writes the fence, so an agent that fenced its table is not fenced twice', () => {
    const body = composeResultBody({ table: '```\na\nb\n```' })
    assert.equal(body, '```\na\nb\n```')
  })
})

describe('composeNotify: the status line (#420)', () => {
  const LINE = {
    message: 'The lint reads the notify fields now. The gate refuses a fault.',
    detail: 'The composer is daemon/src/card.mjs.',
    table: 'message  600\ndetail   500',
  }

  test('the parts read top down: message, table, spoiler', () => {
    assert.equal(composeNotify(LINE), [
      '⚙️ The lint reads the notify fields now. The gate refuses a fault.',
      '```\nmessage  600\ndetail   500\n```',
      'Details: ||The composer is daemon/src/card.mjs.||',
    ].join('\n\n'))
  })

  test('a notify with no kind keeps the one line the thread has always read', () => {
    assert.equal(composeNotify({ message: 'reading the map' }), '⚙️ reading the map')
    assert.equal(composeNotify({ kind: 'progress', message: 'reading the map' }), '⚙️ reading the map',
      'progress IS the default, so naming it changes nothing')
  })

  test('the kind picks the prefix, and it says what the operator must do', () => {
    assert.equal(composeNotify({ kind: 'look', message: 'the prototype is up' }), '🔗 the prototype is up')
    assert.ok(composeNotify({ kind: 'ask', message: 'which port?' }).startsWith('❓ which port?'))
  })

  test('an ask says where the answer goes, in small print and one line', () => {
    const post = composeNotify({ kind: 'ask', message: 'which port?' })
    const last = post.split('\n\n').at(-1)
    assert.match(last, /^-# Reply in this thread/)
    assert.equal(last.split('\n').length, 1, '#414: small print is one line, never stacked')
    assert.equal(composeNotify({ kind: 'ask' }), '', 'a line with no words gets no pointer either')
  })

  test('a kind curia does not know renders as progress rather than as nothing', () => {
    assert.equal(composeNotify({ kind: 'finding', message: 'the deploy fast-forwards only' }),
      '⚙️ the deploy fast-forwards only')
  })

  test('every notify prefix is in the signal set the reply lint reads', () => {
    for (const kind of NOTIFY_KINDS) {
      assert.deepEqual(lintReply(composeNotify({ kind, message: 'a line' })), [])
    }
  })

  test('a notify with no message at all composes nothing', () => {
    assert.equal(composeNotify({}), '')
  })

  test('curia writes the fence, so an agent that fenced its table is not fenced twice', () => {
    assert.equal(composeNotify({ message: 'a', table: '```\nx\n```' }), '⚙️ a\n\n```\nx\n```')
  })
})

describe('composeOpening: the ticket story (#690)', () => {
  test('the goal and first step render as one two-line work message', () => {
    assert.equal(composeOpening({
      goal: 'I’ll make each ticket thread tell one quiet story.',
      first_step: 'I’ll trace the dispatch events into the status line first.',
    }), [
      '⚙️ I’ll make each ticket thread tell one quiet story.',
      'I’ll trace the dispatch events into the status line first.',
    ].join('\n'))
  })
})

describe('composeVerdict: the cross-check verdict (#421)', () => {
  const VERDICT = {
    headline: 'One blocker and one note: the retry loop never exits.',
    summary: 'I read the diff and ran the daemon suite. It is green.',
    findings: [
      { text: 'daemon/src/retry.mjs:41 loops while the socket is open, and nothing closes it.', severity: 'blocker' },
      { text: 'daemon/src/card.mjs:52 could name the marker helper once.', severity: 'note', out_of_scope: true },
    ],
    detail: 'The suite ran 71 files.',
    table: 'blocker  1\nnote     1',
  }

  test('the grade leads under the headline, and curia derives it', () => {
    const lines = composeVerdict(VERDICT).split('\n\n')
    assert.equal(lines[0], '**One blocker and one note: the retry loop never exits.**')
    assert.equal(lines[1], '❌ **fail** — 1 blocker, 1 note')
  })

  test('every finding carries its number, its severity and its own prose', () => {
    const body = composeVerdict(VERDICT)
    assert.ok(body.includes('**1. blocker**\ndaemon/src/retry.mjs:41 loops while the socket is open, and nothing closes it.'))
    assert.ok(body.includes('**2. note** (out of scope)'), 'the scope mark is rendered, never left in the prose')
  })

  test('the parts read top down: headline, grade, table, summary, findings, spoiler', () => {
    const body = composeVerdict(VERDICT)
    const at = (s) => body.indexOf(s)
    assert.ok(at('**fail**') < at('```'))
    assert.ok(at('```') < at('I read the diff'))
    assert.ok(at('I read the diff') < at('**1. blocker**'))
    assert.ok(at('**1. blocker**') < at('Details: ||'))
  })

  test('a clean reading says so, and it says it in words', () => {
    const body = composeVerdict({ headline: 'Nothing to fix.', summary: 'The tests pass.', findings: [] })
    assert.ok(body.includes('✅ **pass** — no findings'))
  })

  test('a concern with no blocker grades the verdict concerns', () => {
    const body = composeVerdict({ headline: 'h', summary: 's', findings: [{ text: 't', severity: 'concern' }] })
    assert.ok(body.includes('⚠️ **concerns** — 1 concern'))
  })

  test('a verdict with no findings list is its summary, whole and unchanged', () => {
    assert.equal(composeVerdict({ summary: 'VERDICT: pass\n\nTESTS: green' }), 'VERDICT: pass\n\nTESTS: green')
  })

  test('the reviewer ending post wears the cross-check signal, not an ending tick', () => {
    const post = composeVerdictReport('resolved', VERDICT)
    assert.equal(post.split('\n')[0], '🔎 the cross-check found **resolved**')
    assert.ok(post.includes(composeVerdict(VERDICT)), 'no finding is dropped from the thread')
  })

  test('a reviewer that could not read the diff still leads with its status', () => {
    assert.equal(composeVerdictReport('blocked', {}), '🔎 the cross-check found **blocked**')
  })
})

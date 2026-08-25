// Tests for src/lint.mjs (#418): the two grades ADR-0019 locks, the geometry
// check that is not a grade, the caps, and the mandatory floor per surface.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPS, VISUAL_COLUMNS, VISUAL_LINES, SENTENCE_WORDS,
  gradeA, gradeB, lintGeometry, lintTable, lintPicture, retiredFieldFaults, unfence, isTyped, floorFaults, lintAskHuman,
  lintRequestReview, reviewFloorFaults, hasText,
  isTypedResult, lintResult, resultFloorFaults,
  lintNotify, notifyFloorFaults, notifyHasText,
  lintVerdict, verdictFloorFaults, verdictGrade, isTypedVerdict, VERDICT_SEVERITIES,
} from '../src/lint.mjs'

const names = (faults) => faults.join(' | ')

describe('grade A: inline decision text', () => {
  test('a plain one-line field passes', () => {
    assert.deepEqual(gradeA('headline', 'Re-arm cooling at boot, and from what source?', CAPS.headline), [])
  })

  test('the cap refuses rather than truncates', () => {
    const faults = gradeA('headline', 'x'.repeat(CAPS.headline + 1), CAPS.headline)
    assert.match(names(faults), /151 characters over the 150 cap/)
    assert.match(names(faults), /never cuts it/)
  })

  test('a field exactly at the cap passes', () => {
    assert.deepEqual(gradeA('headline', 'x'.repeat(CAPS.headline), CAPS.headline), [])
  })

  test('a newline is a fault: grade A is one line', () => {
    assert.match(names(gradeA('detail', 'one\ntwo', CAPS.detail)), /a newline/)
  })

  test('markdown structure is refused, marker by marker', () => {
    assert.match(names(gradeA('headline', '## a heading', CAPS.headline)), /heading marker/)
    assert.match(names(gradeA('headline', '| a | b |', CAPS.headline)), /markdown table row/)
    assert.match(names(gradeA('headline', '> quoted', CAPS.headline)), /blockquote/)
    assert.match(names(gradeA('headline', '```js', CAPS.headline)), /code fence/)
    assert.match(names(gradeA('headline', '- an item', CAPS.headline)), /list marker/)
    assert.match(names(gradeA('headline', '1. an item', CAPS.headline)), /list marker/)
  })

  test('a link is refused, because curia composes every link it renders', () => {
    assert.match(names(gradeA('headline', 'see https://example.com', CAPS.headline)), /a link/)
    assert.match(names(gradeA('headline', 'see [the page](/x)', CAPS.headline)), /a link/)
  })

  test('a hyphen in a word is not a list marker', () => {
    assert.deepEqual(gradeA('headline', 'the reject-on-lint gate holds', CAPS.headline), [])
  })
})

describe('the word rules both grades share', () => {
  test('a semicolon is a fault', () => {
    assert.match(names(gradeA('headline', 'this holds; that does not', CAPS.headline)), /a semicolon/)
    assert.match(names(gradeB('summary', 'this holds; that does not')), /a semicolon/)
  })

  test('an em-dash is a fault and a normal dash is not', () => {
    assert.match(names(gradeA('headline', 'this holds — that does not', CAPS.headline)), /an em-dash/)
    assert.deepEqual(gradeA('headline', 'this holds - that does not', CAPS.headline), [])
  })

  // The voice ASKS for contractions, so neither grade may fault one. This test
  // is the guard on that: an apostrophe rule that came back would refuse text
  // voice.md tells the agent to write.
  test('a contraction passes both grades', () => {
    assert.deepEqual(gradeA('headline', "it's not there", CAPS.headline), [])
    assert.deepEqual(gradeA('headline', 'curia doesn’t read it', CAPS.headline), [])
    assert.deepEqual(gradeB('summary', "The daemon doesn't rewrite your text."), [])
  })

  test('a possessive passes too', () => {
    assert.deepEqual(gradeA('headline', "the agent's own worktree stays", CAPS.headline), [])
    assert.deepEqual(gradeB('summary', "The daemon reads the record's payload."), [])
  })

  test('a marketing adjective is a fault', () => {
    assert.match(names(gradeB('summary', 'A robust and seamless gate.')), /the marketing adjective "robust"/)
    assert.match(names(gradeB('summary', 'A robust and seamless gate.')), /the marketing adjective "seamless"/)
  })
})

describe('grade B: block prose', () => {
  test('several short sentences pass', () => {
    assert.deepEqual(gradeB('summary', 'The daemon lints a named field. The agent rewrites its own text.'), [])
  })

  test('a sentence over the word cap is refused and quoted', () => {
    const long = `${new Array(SENTENCE_WORDS + 1).fill('word').join(' ')}.`
    assert.match(names(gradeB('summary', long)), new RegExp(`a sentence of ${SENTENCE_WORDS + 1} words`))
  })

  test('a sentence exactly at the word cap passes', () => {
    assert.deepEqual(gradeB('summary', `${new Array(SENTENCE_WORDS).fill('word').join(' ')}.`), [])
  })

  test('the block cap refuses', () => {
    assert.match(names(gradeB('charting', 'a. '.repeat(CAPS.block))), new RegExp(`over the ${CAPS.block} cap`))
  })

  test('a heading and a bare table are refused, and a fenced table is not (#432)', () => {
    assert.match(names(gradeB('summary', '# a heading')), /heading/)
    assert.match(names(gradeB('summary', '| a | b |')), /table/)
    assert.deepEqual(gradeB('summary', '```\n| a | b |\n```'), [])
  })

  test('a fenced block is not counted as a sentence', () => {
    const rows = `\`\`\`\n${new Array(SENTENCE_WORDS + 5).fill('col').join(' ')}\n\`\`\``
    assert.deepEqual(gradeB('summary', rows), [])
  })

  test('an emoji outside the signal set is refused', () => {
    assert.match(names(gradeB('summary', 'shipped 🚀')), /emoji outside the signal set/)
  })
})

describe('the geometry fields: never words', () => {
  test('rows inside the box pass', () => {
    assert.deepEqual(lintGeometry('diagram', '09:00  cap lands\n13:02  deploy'), [])
  })

  test('a row over the column cap is refused', () => {
    assert.match(names(lintGeometry('diagram', 'x'.repeat(VISUAL_COLUMNS + 1))), new RegExp(`${VISUAL_COLUMNS + 1} columns over the ${VISUAL_COLUMNS} cap`))
  })

  test('a diagram over the line cap is refused', () => {
    const tall = new Array(VISUAL_LINES + 1).fill('row').join('\n')
    assert.match(names(lintGeometry('diagram', tall)), new RegExp(`${VISUAL_LINES + 1} lines over the ${VISUAL_LINES} cap`))
  })

  test('a diagram the agent fenced itself is measured on its rows', () => {
    assert.deepEqual(lintGeometry('diagram', '```\nshort row\n```'), [])
    assert.equal(unfence('```\nshort row\n```'), 'short row')
    assert.equal(unfence('short row'), 'short row')
  })

  test('a fence inside the rows is refused: it would close the fence curia writes', () => {
    assert.match(names(lintGeometry('diagram', 'row one\n```\nrow two')), /a code fence inside the rows/)
  })

  test('a diagram takes no grade: a semicolon in it passes', () => {
    assert.deepEqual(lintGeometry('diagram', 'a; b; c'), [])
  })

  test('the geometry cap keeps a diagram under the code-block cap', () => {
    assert.ok(VISUAL_COLUMNS * VISUAL_LINES < 1000)
  })
})

describe('isTyped', () => {
  test('an untyped call is not typed by its prompt or its images', () => {
    assert.equal(isTyped({ prompt: 'what now?', images: ['/workspace/a.png'] }), false)
  })

  test('any prose field types the call', () => {
    assert.equal(isTyped({ headline: 'a decision' }), true)
    assert.equal(isTyped({ questions: [{ text: 'one?' }] }), true)
    assert.equal(isTyped({ options: [{ label: 'A', consequence: 'x' }] }), true)
    assert.equal(isTyped({ detail: 'a fact' }), true)
  })

  test('a bare string option is the old shape, so it does not type the call', () => {
    assert.equal(isTyped({ options: ['A', 'B'] }), false)
  })
})

describe('the mandatory floor', () => {
  test('every kind owes a headline', () => {
    assert.match(names(floorFaults('free-text', { questions: [{ text: 'one?' }] })), /headline: missing/)
  })

  test('a round owes its questions', () => {
    assert.match(names(floorFaults('free-text', { headline: 'h' })), /questions: missing/)
    assert.match(names(floorFaults('free-text', { headline: 'h', questions: [{}] })), /questions\[0\]\.text: missing/)
  })

  test('a choice owes one consequence per option: the floor #415 proved', () => {
    const faults = floorFaults('choice', { headline: 'h', options: [{ label: 'A' }, { label: 'B', consequence: 'x' }] })
    assert.match(names(faults), /options\[0\]\.consequence: missing/)
    assert.doesNotMatch(names(faults), /options\[1\]/)
  })

  test('a choice of one is not a choice', () => {
    assert.match(names(floorFaults('choice', { headline: 'h', options: [{ label: 'A', consequence: 'x' }] })), /two options or more/)
  })

  test('approve-reject takes no options, or exactly two', () => {
    assert.deepEqual(floorFaults('approve-reject', { headline: 'h' }), [])
    assert.match(names(floorFaults('approve-reject', { headline: 'h', options: [{ consequence: 'x' }] })), /exactly two/)
    assert.deepEqual(floorFaults('approve-reject', { headline: 'h', options: [{ consequence: 'x' }, { consequence: 'y' }] }), [])
  })

  test('a call with no prose at all fails the whole floor', () => {
    // What `ask_human` leans on. `prompt` was required by the schema until
    // #418, and moving that check off zod (#438) must not turn a blank call
    // into a blank card in a human's thread.
    assert.equal(hasText({ kind: 'free-text' }), false)
    const faults = names(floorFaults('free-text', {}))
    assert.match(faults, /headline: missing/)
    assert.match(faults, /questions: missing/)
  })

  test('an untyped prompt is prose, so it is not an empty call', () => {
    assert.equal(hasText({ prompt: 'which port?' }), true)
  })

  test('preview-review owes its preview url', () => {
    assert.match(names(floorFaults('preview-review', { headline: 'h' })), /preview_url: missing/)
  })
})

// THE FLIP (#422). The untyped call is refused now, and the three fields it was
// written with are named rather than dropped. A dropped field takes the words
// the agent wrote with it, which is the silent loss this map exists to stop.
describe('the flip: an untyped call and the fields it retired (#422)', () => {
  test('an untyped call is refused, and the refusal names the headline it wants', () => {
    const faults = names(floorFaults('free-text', { prompt: 'which port should the dev server bind?' }))
    assert.match(faults, /headline: missing/)
    assert.match(faults, /questions: missing/)
  })

  test('a prompt is named, so the agent knows where its own words go', () => {
    assert.match(names(floorFaults('free-text', { prompt: 'which port?' })), /prompt: retired by the flip/)
    assert.deepEqual(floorFaults('free-text', { headline: 'h', questions: [{ text: 'one?' }] }), [])
  })

  test('a bare string option is named ONCE, not three times over its own fields', () => {
    const faults = floorFaults('choice', { headline: 'h', options: ['claude', 'codex'] })
    assert.match(names(faults), /options: a bare string/)
    assert.doesNotMatch(names(faults), /options\[0\]\./)
    assert.doesNotMatch(names(faults), /options\[1\]\./)
  })

  test('a bare string option is named on approve-reject too', () => {
    const faults = floorFaults('approve-reject', { headline: 'h', options: ['yes', 'no'] })
    assert.match(names(faults), /options: a bare string/)
    assert.doesNotMatch(names(faults), /options\[0\]\./)
  })

  test('the recommended boolean is named, because a retired flag draws no button', () => {
    assert.match(
      names(floorFaults('free-text', { headline: 'h', questions: [{ text: 'one?' }], recommended: true })),
      /recommended: retired by the flip/,
    )
    // `false` is a claim too, and it is just as retired as `true`.
    assert.match(
      names(floorFaults('free-text', { headline: 'h', questions: [{ text: 'one?' }], recommended: false })),
      /recommended: retired by the flip/,
    )
  })

  test('an option-level recommended is NOT retired: it is what a choice card marks', () => {
    assert.deepEqual(floorFaults('choice', {
      headline: 'h',
      options: [{ label: 'A', consequence: 'x', recommended: true }, { label: 'B', consequence: 'y' }],
    }), [])
  })

  test('a refused untyped call still has text, so the cap sends it flagged', () => {
    // ADR-0019: a schema rejection never traps a question. The prompt is the
    // one thing the call gave the operator to read, so it is what goes out.
    assert.equal(hasText({ prompt: 'which port?' }), true)
  })
})

describe('lintAskHuman', () => {
  test('a card that keeps every rule passes', () => {
    const faults = lintAskHuman('choice', {
      headline: 'A restart forgets every cooling. Re-arm it at boot, and from what?',
      options: [
        { label: 'From the journal.', consequence: 'A guessed reset can hold at most 55 minutes too long.' },
        { label: 'From a fresh reading.', consequence: 'It answers "am I near the cap", not "did I hit one".' },
      ],
      detail: 'The daemon has journalled provider_cooling with reset_at since #175.',
      diagram: '09:00  cap lands\n13:02  deploy',
    })
    assert.deepEqual(faults, [])
  })

  test('the fault names the field it is in', () => {
    const faults = lintAskHuman('choice', {
      headline: 'fine',
      options: [{ label: 'A', consequence: 'this holds; that does not' }],
    })
    assert.match(names(faults), /options\[0\]\.consequence: a semicolon/)
  })

  test('an option label over 80 is refused, because a select menu carries 80 whole', () => {
    const faults = lintAskHuman('choice', { headline: 'fine', options: [{ label: 'x'.repeat(81), consequence: 'y' }] })
    assert.match(names(faults), new RegExp(`options\\[0\\]\\.label: 81 characters over the ${CAPS.option} cap`))
  })

  test('an example is block prose, so it keeps its sentences', () => {
    assert.deepEqual(lintAskHuman('choice', {
      headline: 'fine',
      options: [{ label: 'A', consequence: 'y', example: 'The boot reading says 41% used. The 09:00 cap is invisible.' }],
    }), [])
  })

  test('a round lints every question and every recommendation', () => {
    const faults = lintAskHuman('free-text', {
      headline: 'fine',
      questions: [{ text: 'is it right?', recommendation: 'yes; it is right' }],
    })
    assert.match(names(faults), /questions\[0\]\.recommendation: a semicolon/)
  })
})

describe('lintRequestReview', () => {
  test('the gate prose is grade B and the headline is grade A', () => {
    assert.deepEqual(lintRequestReview({
      headline: 'Typed ask_human and request_review, with the lint gate.',
      summary: 'The daemon lints a named field. A cap refuses rather than cuts.',
      charting: 'none',
    }), [])
  })

  test('a long gate sentence is refused', () => {
    const long = `${new Array(SENTENCE_WORDS + 2).fill('word').join(' ')}.`
    assert.match(names(lintRequestReview({ headline: 'h', summary: long, charting: 'none' })), /summary: a sentence/)
  })

  test('the gate floor is the headline, the summary and the charting', () => {
    assert.deepEqual(reviewFloorFaults({ headline: 'h', summary: 's', charting: 'none' }), [])
    const faults = names(reviewFloorFaults({}))
    assert.match(faults, /headline: missing/)
    assert.match(faults, /summary: missing/)
    assert.match(faults, /charting: missing/)
  })

  test('summary and charting were required before the flip, and the headline joins them (#422)', () => {
    // Moving the check off zod (#438) decides which layer refuses the call. It
    // never lets a silent gate open.
    assert.match(names(reviewFloorFaults({ headline: 'h' })), /summary: missing/)
    assert.match(names(reviewFloorFaults({ headline: 'h' })), /charting: missing/)
    assert.match(names(reviewFloorFaults({ summary: 's', charting: 'none' })), /headline: missing/)
  })
})

describe('lintResult: the ending report (#419)', () => {
  const REPORT = {
    ticket: '419',
    status: 'resolved',
    headline: 'The ending report is typed, and the lint reads its named fields.',
    summary: 'The report takes a headline, a summary, a detail and a table. Curia lays them out.',
    detail: 'The lint module is daemon/src/lint.mjs and the composer is daemon/src/card.mjs.',
    table: 'headline  one line, 150\nsummary   block prose, 600',
  }

  test('a typed report passes every grade', () => {
    assert.deepEqual(lintResult(REPORT), [])
  })

  test('the headline is grade A, so a link in it is refused', () => {
    assert.match(names(lintResult({ ...REPORT, headline: 'see https://example.com' })), /headline: a link/)
  })

  test('the summary is grade B, so it keeps its sentences and loses its em-dash', () => {
    assert.deepEqual(lintResult({ summary: 'One thing changed. Then a second thing changed.' }), [])
    assert.match(names(lintResult({ summary: 'One thing changed — and then another.' })), /summary: an em-dash/)
  })

  test('a summary over the block cap is refused rather than cut', () => {
    const faults = lintResult({ summary: 'x'.repeat(CAPS.block + 1) })
    assert.match(names(faults), new RegExp(`summary: 601 characters over the ${CAPS.block} cap`))
    assert.match(names(faults), /never cuts it/)
  })

  test('the geometry fields keep their check and no grade', () => {
    assert.match(names(lintResult({ diagram: 'x'.repeat(VISUAL_COLUMNS + 1) })), /diagram: 43 columns/)
    assert.deepEqual(lintResult({ diagram: 'a; b — c' }), [], 'a diagram is not prose')
  })

  test('`details` is a free record: ADR-0019 rule 3, and no lint reads it', () => {
    assert.deepEqual(lintResult({ ...REPORT, details: { note: "it's a machine field — and it stays one" } }), [])
  })

  test('the floor is the headline and the summary, both unconditional since the flip (#422)', () => {
    assert.match(names(resultFloorFaults({ summary: 's' })), /headline: missing/)
    assert.match(names(resultFloorFaults({ headline: 'h' })), /summary: missing/)
    assert.deepEqual(resultFloorFaults({ headline: 'h', summary: 's' }), [])
  })

  test('findings are the verdict\'s field, so a builder that sends them is refused (#421)', () => {
    const faults = resultFloorFaults({ headline: 'h', summary: 's', findings: [{ text: 't', severity: 'note' }] })
    assert.match(names(faults), /findings: the cross-check reviewer's field/)
  })

  test('isTypedResult reads the SHAPE, and a bare summary is the old one', () => {
    assert.equal(isTypedResult({ summary: 'what changed' }), false)
    assert.equal(isTypedResult({ headline: 'h' }), true)
    assert.equal(isTypedResult({ detail: 'd' }), true)
    assert.equal(isTypedResult({ diagram: 'v' }), true)
  })

  test('a report carrying a summary has text, so the cap ends in a flagged send', () => {
    assert.equal(hasText({ status: 'resolved', summary: 'what changed' }), true)
  })
})

describe('the status line (#420)', () => {
  const LINE = { message: 'The tests are green. The pull request is open.' }

  test('the message is grade B, so it keeps its sentences and loses its em-dash', () => {
    assert.deepEqual(lintNotify(LINE), [])
    assert.match(names(lintNotify({ message: 'the tests pass — and the branch is pushed' })), /message: an em-dash/)
  })

  test('the message shares the block cap, and it is refused rather than cut', () => {
    const faults = lintNotify({ message: 'x'.repeat(CAPS.block + 1) })
    assert.match(names(faults), new RegExp(`message: 601 characters over the ${CAPS.block} cap`))
    assert.match(names(faults), /never cuts it/)
  })

  test('the detail is grade A, so it is one line and carries no link', () => {
    assert.deepEqual(lintNotify({ ...LINE, detail: 'The module is daemon/src/lint.mjs.' }), [])
    assert.match(names(lintNotify({ ...LINE, detail: 'one\ntwo' })), /detail: a newline/)
    assert.match(names(lintNotify({ ...LINE, detail: 'see https://example.com' })), /detail: a link/)
  })

  test('the geometry fields keep their check and no grade', () => {
    assert.match(names(lintNotify({ ...LINE, diagram: 'x'.repeat(VISUAL_COLUMNS + 1) })), /diagram: 43 columns/)
    assert.deepEqual(lintNotify({ ...LINE, diagram: 'a; b — c' }), [], 'a diagram is not prose')
  })

  test('the floor is the message, because the schema required it before this ticket', () => {
    assert.deepEqual(notifyFloorFaults(LINE), [])
    assert.match(names(notifyFloorFaults({ detail: 'facts' })), /message: missing/)
  })

  test('a status line with words has text, so its cap ends in a flagged send', () => {
    assert.equal(notifyHasText(LINE), true)
    assert.equal(notifyHasText({ diagram: 'a  b' }), true, 'a diagram alone still says something')
    assert.equal(notifyHasText({ images: ['a.png'] }), false, 'a file is not prose, so it is the dead end')
  })

  test('an opening and a phase update pass without a milestone message', () => {
    const opening = {
      opening: {
        goal: 'I’ll make each ticket thread tell one quiet story.',
        first_step: 'I’ll trace dispatch events into the status line first.',
      },
      phase: 'explore',
      label: 'reads the events',
    }
    assert.deepEqual(notifyFloorFaults(opening), [])
    assert.deepEqual(lintNotify(opening), [])
    assert.equal(notifyHasText(opening), true)
    assert.deepEqual(notifyFloorFaults({ phase: 'build', label: 'writes the status' }), [])
  })

  test('the opening, phase, and label faults name their fields', () => {
    assert.match(names(notifyFloorFaults({ opening: { goal: 'I read the goal.' } })), /opening.first_step: missing/)
    assert.match(names(notifyFloorFaults({ phase: 'build' })), /label: missing/)
    assert.match(names(notifyFloorFaults({ label: 'writes the status' })), /phase: missing/)
    assert.match(names(lintNotify({ phase: 'guess', label: 'reads' })), /phase: "guess"/)
    assert.match(names(lintNotify({ phase: 'think', label: 'x'.repeat(21) })), /label: 21 characters over the 20 cap/)
    assert.match(names(lintNotify({ opening: { goal: 'one\ntwo', first_step: 'reads' } })), /opening.goal: a newline/)
  })
})

describe('the cross-check verdict (#421)', () => {
  const VERDICT = {
    headline: 'One blocker: the gate counts a rejection it never journalled',
    summary: 'I read the diff and ran the daemon suite. It is green on 71 files.',
    findings: [
      { text: 'daemon/src/lintgate.mjs:108 counts the attempt before the journal line lands.', severity: 'blocker' },
      { text: 'daemon/src/card.mjs:52 could name the marker helper once.', severity: 'note', out_of_scope: true },
    ],
  }

  test('a typed verdict passes both the floor and the words', () => {
    assert.deepEqual(verdictFloorFaults(VERDICT), [])
    assert.deepEqual(lintVerdict(VERDICT), [])
  })

  test('the headline is grade A and every finding is grade B', () => {
    assert.match(names(lintVerdict({ ...VERDICT, headline: 'one\ntwo' })), /headline: a newline/)
    const long = { text: 'x'.repeat(CAPS.block + 1), severity: 'note' }
    assert.match(names(lintVerdict({ ...VERDICT, findings: [long] })), /findings\[0\]\.text: 601 characters/)
    const dashed = { text: 'a.mjs:1 is wrong — and it matters', severity: 'note' }
    assert.match(names(lintVerdict({ ...VERDICT, findings: [dashed] })), /findings\[0\]\.text: an em-dash/)
  })

  test('a finding with no severity is a schema fault, and the fault names the set', () => {
    const faults = verdictFloorFaults({ ...VERDICT, findings: [{ text: 'a.mjs:1 is wrong.' }] })
    assert.match(names(faults), /findings\[0\]\.severity: missing/)
    assert.match(names(faults), /blocker, concern, note/)
  })

  test('a severity outside the set is refused, never coerced', () => {
    const faults = verdictFloorFaults({ ...VERDICT, findings: [{ text: 'a.mjs:1 is wrong.', severity: 'critical' }] })
    assert.match(names(faults), /findings\[0\]\.severity: "critical" is not one of/)
  })

  test('AN EMPTY findings list is a verdict, and a missing one is not', () => {
    assert.deepEqual(verdictFloorFaults({ headline: 'h', summary: 's', findings: [] }), [])
    assert.match(names(verdictFloorFaults({ headline: 'h', summary: 's' })), /findings: missing/)
  })

  test('the floor is the headline, the summary and the list, all three since the flip (#422)', () => {
    const faults = names(verdictFloorFaults({ summary: 's' }))
    assert.match(faults, /headline: missing/)
    assert.match(faults, /findings: missing/)
    assert.match(names(verdictFloorFaults({ headline: 'h' })), /summary: missing/)
  })

  test('the grade is DERIVED from the severities, so no verdict passes over its own blocker', () => {
    assert.equal(verdictGrade(VERDICT.findings), 'fail')
    assert.equal(verdictGrade([{ severity: 'concern' }, { severity: 'note' }]), 'concerns')
    assert.equal(verdictGrade([{ severity: 'note' }]), 'pass')
    assert.equal(verdictGrade([]), 'pass', 'a clean reading is a real result')
  })

  test('an untyped verdict has no findings, so curia states no grade', () => {
    assert.equal(verdictGrade(undefined), null)
    assert.equal(isTypedVerdict({ summary: 'VERDICT: pass' }), false)
    assert.equal(isTypedVerdict({ headline: 'h' }), true)
    assert.equal(isTypedVerdict({ findings: [] }), true, 'an empty list is a typed verdict')
  })

  test('the three severities, most serious first', () => {
    assert.deepEqual(VERDICT_SEVERITIES, ['blocker', 'concern', 'note'])
  })
})

// ---- ADR-0026 (#691): the field vocabulary that replaced `visual` ------------

describe('the table: geometry, and the columns line up', () => {
  test('a table whose columns line up passes', () => {
    assert.deepEqual(lintTable('kind      what you must do\nlook      open it now\nprogress  nothing'), [])
  })

  test('a column that starts where no column of the first row starts is refused', () => {
    assert.match(names(lintTable('kind      what you must do\nlook    open it now')), /row 2 starts a column at character 9/)
  })

  test('a row with more columns than the first row is refused', () => {
    assert.match(names(lintTable('kind      what\nlook      open  now')), /row 2 has 3 columns where the first row has 2/)
  })

  test('a blank cell is a real row, so fewer columns pass on the offsets that are there', () => {
    assert.deepEqual(lintTable('kind      what      when\nlook                now'), [])
  })

  test('a title or a rule line is not a row, so it is skipped', () => {
    assert.deepEqual(lintTable('the kinds\nkind      what\n--------  ----'), [])
  })

  test('the table keeps the geometry check every block takes', () => {
    assert.match(names(lintTable('x'.repeat(VISUAL_COLUMNS + 1))), new RegExp(`table: ${VISUAL_COLUMNS + 1} columns`))
  })
})

describe('the picture: one image file', () => {
  test('an image path passes', () => {
    assert.deepEqual(lintPicture('picture', 'renders/home.png'), [])
    assert.deepEqual(lintPicture('picture', '/workspace/a.WEBP'), [])
  })

  test('a download is not a picture, and the fault says where it goes', () => {
    const faults = names(lintPicture('picture', 'notes/reading.md'))
    assert.match(faults, /is not an image/)
    assert.match(faults, /`attachments`/)
  })

  test('a second picture is a second message, not a second line', () => {
    assert.match(names(lintPicture('picture', 'a.png\nb.png')), /a newline/)
  })
})

describe('the fields ADR-0026 retired, on every surface', () => {
  const surfaces = {
    'ask_human': (p) => floorFaults('free-text', p),
    notify: notifyFloorFaults,
    report_result: resultFloorFaults,
    verdict: verdictFloorFaults,
    request_review: reviewFloorFaults,
  }

  for (const [surface, floor] of Object.entries(surfaces)) {
    test(`\`visual\` is refused on ${surface}, and the rows are named rather than dropped`, () => {
      const payload = { visual: 'a  b\nc  d' }
      const faults = names(floor(payload))
      assert.match(faults, /visual: retired by ADR-0026/)
      assert.match(faults, /`diagram`/)
      assert.equal(payload.visual, 'a  b\nc  d', 'the rows are still on the payload')
    })

    test(`\`images\` is refused on ${surface}, and the paths are named`, () => {
      assert.match(names(floor({ images: ['/workspace/a.png'] })), /images: renamed to `attachments`/)
    })
  }

  test('an empty payload carries neither fault', () => {
    assert.deepEqual(retiredFieldFaults({}), [])
    assert.deepEqual(retiredFieldFaults({ table: 'a  b', attachments: [] }), [])
  })
})

describe('the question background (ADR-0026)', () => {
  const round = (background) => ({
    headline: 'Which cap?',
    questions: [{ text: 'Which cap re-arms at boot?', background }],
  })

  test('a background inside the cap passes, and it keeps its sentences', () => {
    assert.deepEqual(lintAskHuman('free-text', round('The cap landed at 09:00. Cooling ran until 14:20.')), [])
  })

  test('the background is refused over 600, and it is refused rather than cut', () => {
    const long = 'x'.repeat(CAPS.background + 1)
    assert.match(names(lintAskHuman('free-text', round(long))), new RegExp(`questions\\[0\\].background: ${CAPS.background + 1} characters over the ${CAPS.background} cap`))
  })

  test('the background is block prose, so a list of separable facts passes', () => {
    assert.deepEqual(lintAskHuman('free-text', round('- the cap landed at 09:00\n- cooling ran until 14:20')), [])
  })
})

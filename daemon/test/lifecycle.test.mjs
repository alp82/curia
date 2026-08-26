// Unit tests for src/lifecycle.mjs (#54) — the ordered ending, which the spawn
// prompt and the Stop hook both render from.
//
// The properties worth pinning:
//   - report_result ends the sequence WHATEVER its status, so an agent that
//     cannot comply is never held (the loop #48 refused)
//   - each todo fires only on positive evidence, so an indeterminate read drops
//     the item rather than adding it
//   - approval is narrow: only the ✅ button's own word approves

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENDING, endingProse, outstanding, stopReason, reviewGateText, classifyReviewAnswer,
} from '../src/lifecycle.mjs'

const FRESH = {
  hasCommits: false, prOpened: false, reviewApproved: false, prState: null, hasResult: false,
}
const todos = (over) => outstanding({ ...FRESH, ...over })

describe('the outstanding checklist', () => {
  test('an agent that has done nothing is asked for the review and the result', () => {
    assert.deepEqual(todos({}).length, 2)
    assert.match(todos({})[0], /request_review/)
    assert.match(todos({})[1], /report_result/)
  })

  test('commits with no pull request add the pull request, in order', () => {
    const items = todos({ hasCommits: true })
    assert.equal(items.length, 3)
    assert.match(items[0], /open_pull_request/)
  })

  test('a ticket with no code is never asked for a pull request — a grilling ticket resolves with a comment', () => {
    assert.ok(!todos({}).some((t) => /open_pull_request/.test(t)))
    assert.ok(!todos({ prOpened: true }).some((t) => /open_pull_request/.test(t)))
  })

  test('the merge is asked for only once a human has approved AND the pull request is still open', () => {
    const approved = { hasCommits: true, prOpened: true, reviewApproved: true }
    assert.ok(todos({ ...approved, prState: 'OPEN' }).some((t) => /merge/.test(t)))
    assert.ok(!todos({ ...approved, prState: 'MERGED' }).some((t) => /merge/.test(t)))
    // an unreadable pull-request state leaves prState null: the item drops out
    // rather than trapping an agent over a failed gh call
    assert.ok(!todos({ ...approved, prState: null }).some((t) => /merge/.test(t)))
  })

  test('report_result ends the sequence whatever its status', () => {
    // The `blocked` path is exactly this: an agent that cannot finish has
    // complied with the one order covering that, and holding it here would loop
    // the very agent that cannot comply.
    assert.deepEqual(todos({ hasResult: true, hasCommits: true }), [])
  })

  test('the full happy sequence ends empty', () => {
    assert.deepEqual(todos({
      hasCommits: true, prOpened: true, reviewApproved: true, prState: 'MERGED', hasResult: true,
    }), [])
  })
})

describe('the prompt prose is the same structure', () => {
  test('every ENDING step renders, numbered, in order', () => {
    const lines = endingProse({ repo: 'o/r', ticket: 42, branch: 'curia/42', mapNumber: 1 })
    const numbered = lines.filter((l) => /^\d+\. /.test(l))
    assert.equal(numbered.length, ENDING.length)
    assert.deepEqual(numbered.map((l) => Number(l.split('.')[0])), ENDING.map((_, i) => i + 1))
  })

  test('a mapless ticket gets the tracker wording, with its own ticket number filled in', () => {
    const lines = endingProse({ repo: 'o/r', ticket: 42, branch: 'curia/42', mapNumber: null }).join('\n')
    assert.match(lines, /comment on o\/r#42/)
    assert.ok(!lines.includes('#{n}'), 'the placeholder must not reach an agent')
  })
})

describe('the reason a blocked stop hands back', () => {
  test('it names the steps and where the nudge budget stands', () => {
    const r = stopReason(['do A', 'do B'], { attempt: 2, budget: 3 })
    assert.match(r, /2 steps outstanding/)
    assert.match(r, /- do A\n- do B/)
    assert.match(r, /nudge 2 of 3/)
  })

  test('one outstanding step reads as one', () => {
    assert.match(stopReason(['do A'], { attempt: 1, budget: 3 }), /1 step outstanding/)
  })
})

describe('the review gate payload', () => {
  const base = {
    repo: 'o/r', ticket: '42', title: 'a ticket', summary: 'did the thing',
    charting: 'create "next question"; remove the fog line about X',
    links: ['Ticket: https://github.com/o/r/issues/42', 'Pull request (**OPEN**): https://x/pull/7'],
  }

  test('it carries the question, both agent statements, and every link', () => {
    const { text } = reviewGateText(base)
    assert.match(text, /❓ \*\*Is o\/r#42 done\?\*\* - a ticket/)
    assert.match(text, /\*\*What changed\*\*/)
    assert.match(text, /\*\*Charting\*\*/)
    assert.match(text, /did the thing/)
    assert.match(text, /remove the fog line about X/)
    assert.match(text, /- Ticket: https:\/\/github\.com\/o\/r\/issues\/42/)
    assert.match(text, /- Pull request \(\*\*OPEN\*\*\)/)
  })

  test('a silent agent is shown as silent rather than as an empty section', () => {
    const { text } = reviewGateText({ ...base, summary: '   ', charting: '' })
    assert.equal(text.match(/\(nothing said\)/g).length, 2)
  })

  test('an over-long payload is handed over whole — the bridge chunks it (#119)', () => {
    const { text } = reviewGateText({ ...base, charting: 'x'.repeat(4000) })
    assert.ok(text.includes('x'.repeat(4000)), 'nothing may be cut from the charting the gate exists to judge')
    assert.doesNotMatch(text, /did not fit/)
  })

  // #418, ADR-0019: the gate takes the typed fields too. The HEADING stays
  // curia's, because what the operator is being asked is curia's to state
  // (#297). The headline under it is what the agent did.
  test('the typed body sits under curia\'s heading, above the summary', () => {
    const { text } = reviewGateText({
      ...base,
      body: '**Typed ask_human and request_review.**\n\nDetails: ||The lint is daemon/src/lint.mjs.||',
    })
    assert.match(text, /❓ \*\*Is o\/r#42 done\?\*\* - a ticket\n\n\*\*Typed ask_human and request_review\.\*\*/)
    assert.ok(text.indexOf('Typed ask_human') < text.indexOf('**What changed**'))
    assert.match(text, /Details: \|\|The lint is daemon\/src\/lint\.mjs\.\|\|/)
  })

  test('a gate with an empty body is byte-for-byte what it was before the typed fields', () => {
    assert.equal(reviewGateText({ ...base, body: '' }).text, reviewGateText(base).text)
    assert.equal(reviewGateText({ ...base, body: '   ' }).text, reviewGateText(base).text)
  })
})

describe('classifying the answer', () => {
  test("the button's own word approves", () => {
    for (const t of ['approve', 'Approve', ' APPROVED ', 'lgtm']) {
      assert.equal(classifyReviewAnswer(t).approved, true, t)
    }
  })

  test('everything else is a rejection carrying the words as feedback', () => {
    // A false reject costs one more loop; a false approve merges code nobody
    // read. So a thread reply is always feedback, even a friendly one.
    const r = classifyReviewAnswer('looks good but rename the flag')
    assert.equal(r.approved, false)
    assert.equal(r.feedback, 'looks good but rename the flag')
    assert.equal(classifyReviewAnswer('reject').approved, false)
    assert.equal(classifyReviewAnswer('').approved, false)
    assert.equal(classifyReviewAnswer(undefined).approved, false)
  })
})

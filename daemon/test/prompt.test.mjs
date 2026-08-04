// The spawn prompt is the only control on a bypassPermissions agent's tracker
// authority — the disabled push URL is a speed bump, not a control (see
// workspace.mjs). So it gets pinned like an interface.
//
// What it can pin CHANGED with #49/#54. The prompt no longer states the resolve
// protocol: the agent reads that from the wayfinder skill installed in its own
// config dir (#57), and restating it here is the duplication #49 deleted. So the
// assertions below pin the parameters, the bounds, the tool block and the ordered
// ending — and the ABSENCE of the protocol, because a well-meaning re-addition is
// exactly how the two copies would drift apart again.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writePrompt, branchFor } from '../src/workspace.mjs'
import { ENDING } from '../src/lifecycle.mjs'

const ISSUE = { number: 42, title: 'Close the loop', body: 'the question' }

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-prompt-test-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function write(opts) {
  const file = writePrompt(tmp, ISSUE, { repo: 'o/r', wtPath: '/w/42', ...opts })
  return fs.readFileSync(file, 'utf8')
}

describe('the wayfinder invocation', () => {
  test('a map ticket starts with the literal /wayfinder line — the only form that loads it', () => {
    // #57, verified both directions: `wayfinder` carries
    // disable-model-invocation, so prose naming the skill gets "cannot be used
    // with Skill tool" and only a first-line slash command loads it.
    const p = write({ mapNumber: 1 })
    assert.equal(p.split('\n')[0], '/wayfinder https://github.com/o/r/issues/1 ticket #42')
  })

  test('a ticket with no map does not invoke the skill at all', () => {
    // The skill works THROUGH a map; invoking it with nothing to work through
    // would have it chart one. The flat ready-for-agent lane (#10) is this case.
    const p = write({ mapNumber: null })
    assert.ok(!p.includes('/wayfinder'))
    assert.equal(p.split('\n')[0], '# o/r#42: Close the loop')
    assert.match(p, /belongs to no map/)
  })
})

describe('parameters, not procedure', () => {
  test('the tracker is named, so the skill never falls back to local markdown', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /tracker is \*\*GitHub\*\*, repo `o\/r`/)
    assert.match(p, /Do not fall back to a\n\s*local-markdown tracker/)
  })

  test('the map, the ticket and the claim are stated as facts curia already established', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /The map is o\/r#1 — https:\/\/github\.com\/o\/r\/issues\/1/)
    assert.match(p, /already CLAIMED it in your name/)
    assert.match(p, /you start at\n\s*resolving it, not at choosing it/)
  })

  test('the ticket type reaches the agent, with its meaning left to the skill', () => {
    // The one line that stops a dispatched grilling agent from standing in for
    // the human's side of its own ticket (#49 decision 2).
    assert.match(write({ mapNumber: 1, type: 'wayfinder:grilling' }), /Ticket type: `wayfinder:grilling`/)
    assert.match(write({ mapNumber: 1, type: null }), /no `wayfinder:` type label/)
  })

  test('the resolve protocol is NOT restated — the skill owns it now', () => {
    const p = write({ mapNumber: 1 })
    assert.ok(!/gh issue comment/.test(p), 'the literal command lines left writePrompt (#49)')
    assert.ok(!/gh issue close/.test(p))
    assert.ok(!/Decisions so far/.test(p), "resolve.mjs's DECISIONS_HEADING is curia's only copy")
    assert.ok(!/- \[Close the loop\]\(/.test(p), 'the pointer line shape left too')
  })
})

describe('bounds', () => {
  test('reading is unbounded and writing is not', () => {
    // #49 decision 3: the old wording read as a ban on the skill's own "zoom as
    // needed", which is the reading an agent actually has to do.
    const p = write({ mapNumber: 1 })
    assert.match(p, /\*\*Read anything\.\*\*/)
    assert.match(p, /Nothing here limits\n\s*reading/)
    assert.match(p, /\*\*Write only:\*\* files inside \/w\/42; this ticket; the map o\/r#1 and its children;/)
    assert.match(p, /the one merge a human has just approved/)
  })

  // #131: the bound is judgment, not tooling — a renderer that embeds Chrome
  // (remotion, screenshot assets, HTML-to-PDF) is a build step; viewing or
  // approving the agent's own output stays forbidden.
  test('the claim is left alone, and the browser is a build tool never a judge', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /Leave the assignee alone/)
    assert.match(p, /\*\*A browser is a build tool, never a judge\.\*\*/)
    assert.match(p, /renders an ARTIFACT is\n\s*allowed/)
    assert.match(p, /view, verify or approve your own work is forbidden/)
    assert.match(p, /`publish_preview` is how a HUMAN looks at a page/)
  })

  // #56: the daemon died and took an agent's ask_human with it; the agent read
  // the transport error as permission to answer its own question. The live check
  // then found the error-path rule is not enough — its own call never errored, it
  // just went quiet for 7h53m, and a story filled the silence.
  test('a failed curia call is not an answer, and neither is silence (#56)', () => {
    const body = write({ mapNumber: 1 })
    assert.match(body, /\*\*A failed `curia` tool call is not an answer\.\*\*/)
    assert.match(body, /make the same call once more/, 'the retry is what supersede routing exists for')
    assert.match(body, /\*\*Silence is not an answer either\.\*\*/)
    assert.match(body, /stand in for the reply/)
  })

  // #172/#180 shut the namespaces both harnesses handed out unasked. This order
  // is the half no config key reaches: a skill that installs an MCP server, a
  // `codex plugin add`, a `claude mcp add`, a marketplace. Asserted on a
  // charting dispatch too, because it is harness-blind AND dispatch-blind — a
  // charting agent can reach for a tool just as easily.
  test('the tool set is closed, on every dispatch (#172)', () => {
    for (const opts of [{ mapNumber: 1 }, { mapNumber: 1, charting: true }, {}]) {
      const p = write(opts)
      assert.match(p, /\*\*Your tools are the ones curia configured, and that set is closed\.\*\*/)
      assert.match(p, /no plugin, no app, no MCP server, no marketplace/)
      assert.match(p, /out of bounds even when it is reachable/)
    }
  })

  test('a HITL ticket is never answered by the agent itself', () => {
    assert.match(write({ mapNumber: 1 }), /\*\*Never answer for the human\.\*\*/)
  })

  // #161, from #149: no verification gate stands behind a freshly charted map,
  // so the agent reading it cold is the only fresh check. curia-107 caught a map
  // that could not reach its destination by accident; this makes it a duty.
  describe('the route-gap duty (#161)', () => {
    test('a mapped ticket is told to escalate a map that stops short', () => {
      const p = write({ mapNumber: 1 })
      assert.match(p, /\*\*A map that cannot reach its destination is an escalation\.\*\*/)
      assert.match(p, /you its only fresh check/)
      assert.match(p, /first `ask_human` call/)
      assert.match(p, /rather than working around the gap or leaving it for the review gate/)
    })

    test('a mapless ticket is not, because it has no map to check', () => {
      assert.ok(!/cannot reach its destination/.test(write({ mapNumber: null })))
    })

    test('a charting dispatch is not, because changing the map IS its job', () => {
      // It carries mapNumber like any map dispatch, so the guard has to read
      // `charting` too — a map agent told to escalate about the map it was sent
      // to repair would be circular.
      assert.ok(!/cannot reach its destination/.test(write({ mapNumber: 1, charting: true })))
    })
  })

  test('curia wins over a skill on conflict', () => {
    assert.match(write({ mapNumber: 1 }), /Where a skill and these bounds disagree, these win/)
  })

  test('a mapless ticket is granted no map write at all', () => {
    const p = write({ mapNumber: null })
    assert.match(p, /\*\*Write only:\*\* files inside \/w\/42; this ticket;\n/)
  })
})

describe('the tool block', () => {
  test('every agent-facing tool is named with a reach-for-it-when', () => {
    // #35: publish_preview's own description already said all this and lost to a
    // strong prior for ~17 minutes. A positive pointer in the orders is the fix.
    const p = write({ mapNumber: 1 })
    for (const tool of ['ask_human', 'notify', 'publish_preview', 'open_pull_request', 'request_review', 'report_result']) {
      assert.match(p, new RegExp(`- \`${tool}\` —`), `${tool} is missing from the tool block`)
    }
  })
})

describe('the ordered ending', () => {
  test('it is numbered, in ENDING order, and renders from that one structure', () => {
    const p = write({ mapNumber: 1 })
    const positions = ['Commit your work locally', 'open_pull_request`. curia pushes', 'publish_preview` with its port',
      'Call `request_review`', 'gh pr merge', 'Then resolve the ticket', 'report_result` exactly once']
      .map((s) => p.indexOf(s))
    assert.ok(positions.every((i) => i > -1), `every step appears: ${positions.join(',')}`)
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'and in the ENDING order')
    assert.equal(ENDING.length, positions.length, 'a new step must appear in the prompt too')
  })

  test('the merge is the agent\'s, and the push never is', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /Never `git push`: curia pushes for you/)
    assert.match(p, /gh pr merge <url> --repo o\/r --squash --delete-branch/)
    assert.match(p, /Only after the approval/)
  })

  test('a mapless ticket is told to resolve on the tracker instead of through the skill', () => {
    assert.match(write({ mapNumber: null }), /post the resolution as a comment on o\/r#42/)
    assert.match(write({ mapNumber: 1 }), /the resolve step of the skill you are running/)
  })

  test('blocked is still the honest way out, and the Stop hook is announced', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /`report_result` with status `blocked`/)
    assert.match(p, /Never comment-and-close\n\s*a ticket you did not resolve/)
    assert.match(p, /Stop hook refuses your stop while a step is outstanding/)
  })
})

describe('what survived the rewrite', () => {
  test('the ticket body, the worktree boundary and the branch', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /# o\/r#42: Close the loop/)
    assert.match(p, /the question/)
    assert.match(p, /Your worktree is \/w\/42/)
    assert.match(p, new RegExp(`on branch \`${branchFor(42)}\``))
  })
})

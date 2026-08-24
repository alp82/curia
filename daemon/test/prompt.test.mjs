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
import {
  writePrompt, branchFor, STANDING_FILE, memoryFileFor, seedConfigDir,
  EXCHANGE_FIELD_CAP, EXCHANGE_BLOCK_CAP,
} from '../src/workspace.mjs'
import { ENDING } from '../src/lifecycle.mjs'

const ISSUE = { number: 42, title: 'Close the loop', body: 'the question' }
const TICKET_TYPES = ['wayfinder:research', 'wayfinder:prototype', 'wayfinder:grilling', 'wayfinder:task', null]

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-prompt-test-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// #340 split the one text in two: `prompt.md` holds the parameters, and
// `standing.md` holds the bounds, the tools and the ending — composed into the
// CLI's global-memory file, which both harnesses load as instructions rather
// than as one message. An agent reads BOTH, so the assertions below read both,
// in the order the agent meets them. Which half a fact lands in is pinned
// separately, in "the two files" at the bottom of this file.
function write(opts) {
  const file = writePrompt(tmp, ISSUE, { repo: 'o/r', wtPath: '/w/42', ...opts })
  return `${fs.readFileSync(file, 'utf8')}\n${fs.readFileSync(path.join(tmp, STANDING_FILE), 'utf8')}`
}

function writeParts(opts) {
  const file = writePrompt(tmp, ISSUE, { repo: 'o/r', wtPath: '/w/42', ...opts })
  return {
    prompt: fs.readFileSync(file, 'utf8'),
    standing: fs.readFileSync(path.join(tmp, STANDING_FILE), 'utf8'),
  }
}

function writeTicketType(type) {
  return write({
    mapNumber: type ? 1 : null,
    type,
    ...(type === 'wayfinder:prototype' ? { prototypeVariations: 3 } : {}),
  })
}

function forEveryTicketType(assertion) {
  for (const type of TICKET_TYPES) assertion(writeTicketType(type), type ?? 'untyped')
}

function assertBothEndingRecords(generatedInstructions, label) {
  assert.match(generatedInstructions, /ticket number and title/i, `${label} omits the ticket identity`)
  assert.match(generatedInstructions, /resolution comment and the `report_result` summary/i,
    `${label} omits one ending record`)
}

describe('the wayfinder invocation', () => {
  test('a map ticket starts with the literal /wayfinder line — the only form that loads it', () => {
    // #57, verified both directions: `wayfinder` carries
    // disable-model-invocation, so prose naming the skill gets "cannot be used
    // with Skill tool" and only a first-line slash command loads it.
    const p = write({ mapNumber: 1 })
    assert.equal(p.split('\n')[0], '/wayfinder https://github.com/o/r/issues/1 ticket #42')
  })

  test('the claude spelling is what an unstated harness gets', () => {
    // Every caller states the harness since #173. The default stays claude, so
    // a test double or a caller written before it keeps the old prompt.
    assert.equal(write({ mapNumber: 1 }), write({ mapNumber: 1, harness: 'claude' }))
  })

  test('a ticket with no map does not invoke the skill at all', () => {
    // The skill works THROUGH a map; invoking it with nothing to work through
    // would have it chart one. The flat ready-for-agent lane (#10) is this case.
    const p = write({ mapNumber: null })
    assert.ok(!p.includes('/wayfinder'))
    assert.equal(p.split('\n')[0], '# o/r#42: Close the loop')
    assert.match(p, /belongs to no map/)
  })

  // #173 gave the codex lane its own spelling, `$wayfinder`, and #399 took the
  // line away entirely. The mention was the ONLY thing that injected the
  // 11,867-character skill body into a codex session, and it injected it as a
  // user message — conversation, which codex tells the model is stale after the
  // turn that carried it. #360 then closed every way to re-arm it.
  //
  // So the codex lane now reaches the skill the way it reaches every other
  // skill: through the catalog, which is world state. `writeSkillPointers` puts
  // it back on that catalog. Measured in docs/live-checks/399: zero `<skill>`
  // blocks on every turn, against 11,867 characters for the mention.
  describe('the codex harness types no sigil at all (#399)', () => {
    test('a map ticket starts at the ticket heading, with no mention anywhere', () => {
      const p = write({ mapNumber: 1, harness: 'codex' })
      assert.equal(p.split('\n')[0], '# o/r#42: Close the loop')
      assert.ok(!p.includes('$wayfinder'), 'the mention is what pasted the body — it is gone')
      assert.ok(!p.includes('/wayfinder'), 'and the claude slash command never belonged here')
    })

    test('a map dispatch types no mention either', () => {
      const p = write({ mapNumber: 42, charting: true, harness: 'codex' })
      assert.equal(p.split('\n')[0], '# o/r#42: Close the loop')
      assert.ok(!p.includes('$wayfinder'))
    })

    test('a mapless ticket invokes nothing, in either spelling', () => {
      const p = write({ mapNumber: null, harness: 'codex' })
      assert.ok(!p.includes('wayfinder '), 'no invocation without a map to work through')
      assert.equal(p.split('\n')[0], '# o/r#42: Close the loop')
    })

    // The skill is still NAMED in prose on both lanes, and that is deliberate.
    // With no sigil, "the skill's Ticket Types section" would point at nothing
    // a codex agent can resolve — and naming a listed skill in plain text is
    // also how codex triggers one.
    test('the prose names the skill, so no reference dangles on the lane with no sigil', () => {
      for (const harness of ['codex', 'claude']) {
        const p = write({ mapNumber: 1, type: 'wayfinder:grilling', harness })
        assert.match(p, /The wayfinder skill's Ticket Types section/, `${harness} names the skill`)
      }
    })

    test('the invocation, memory file, and deferred-tool order are the only differences', () => {
      // The bounds and ending stay harness-blind. #609 adds one tool order to
      // Codex because only that lane receives Curia schemas through ALL_TOOLS.
      //
      // #340 added the memory-file difference. Each CLI has its own name for
      // the global-memory file. #399 removed the Codex sigil, so compare the
      // files by content instead of line number.
      const codex = writeParts({ mapNumber: 1, harness: 'codex' })
      const claude = writeParts({ mapNumber: 1, harness: 'claude' })
      const deferred = [
        '- **Load deferred Curia tools once.** If `ALL_TOOLS` holds Curia schemas, return every',
        '  `mcp__curia__*` definition from one `exec` call before your first Curia call. Keep the output',
        '  in context, and use the same definitions for every later Curia call.',
        '',
      ].join('\n')
      assert.equal(
        codex.standing.replace(`\n${deferred}`, ''),
        claude.standing,
        'the Codex tool order is the only standing-order difference',
      )

      const claudeLines = claude.prompt.split('\n')
      const codexLines = codex.prompt.split('\n')
      // The claude prompt is the codex one plus the invocation line and its
      // blank, with one line reworded.
      assert.deepEqual(claudeLines.slice(0, 2), ['/wayfinder https://github.com/o/r/issues/1 ticket #42', ''])
      const rest = claudeLines.slice(2)
      const differ = codexLines
        .map((l, i) => [l, rest[i]])
        .filter(([a, b]) => a !== b)
      assert.equal(differ.length, 1, `expected one differing line, got ${differ.length}: ${JSON.stringify(differ)}`)
      assert.match(differ[0][0], /`AGENTS\.md`/)
      assert.match(differ[0][1], /`CLAUDE\.md`/)
    })

    test('an unknown harness is refused, never quietly spelled the claude way', () => {
      assert.throws(() => write({ mapNumber: 1, harness: 'gemini' }), /no agent harness/)
    })
  })
})

describe('parameters, not procedure', () => {
  test('a cross-provider handoff reaches ticket and charting prompts', () => {
    for (const charting of [false, true]) {
      const p = write({ mapNumber: 1, charting, handoff: true })
      assert.match(p, /picking up mid-ticket from another model's work/i)
      assert.match(p, /inherit the private clone's files and Git history/i)
      assert.match(p, /don't inherit its reasoning/i)
    }
  })

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

  // #341: the rule above had the right instinct and the wrong clock. The
  // transport reports a dropped call about 120 s after the daemon died, and the
  // daemon is back seconds after it left, so an immediate retry meets the same
  // outage and the agent gives up on a channel that is already healthy.
  test('the retry waits, and the wait is a foreground sleep (#341)', () => {
    const body = write({ mapNumber: 1 })
    assert.match(body, /the channel comes back by itself/, 'the agent needs the model of the world, not just the step')
    assert.match(body, /Wait two minutes with a foreground `sleep 120`/)
    assert.match(body, /wait five minutes the same way and make it one last time/)
    assert.match(body, /Only then stop and end your/)
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

// #287. The vendored `prototype` skill tells its agent to capture the prototype
// on a throwaway branch out of main. curia does not contradict that sentence, it
// READS it: `curia/<n>` is cut from main and deleted at the merge, so it already
// IS the throwaway branch. Only the skill's last clause is deviated from. These
// lines live here rather than in `skills/prototype/SKILL.md`, whose bytes are
// upstream's and pinned — so the deviation has to be pinned on this side.
describe('the prototype bound (#287)', () => {
  const proto = (opts = {}) => write({
    mapNumber: 1,
    type: 'wayfinder:prototype',
    prototypeVariations: 5,
    ...opts,
  })

  test('each round carries the configured count and feedback rule (#636)', () => {
    const p = proto({ prototypeVariations: 7 })
    assert.match(p, /Offer 7 variations in each prototype round by default/)
    assert.match(p, /state why/)
    assert.match(p, /A logic walkthrough may warrant a different count/)
    assert.match(p, /dimensions the ticket opens/)
    assert.match(p, /Palette or copy\s+changes alone do not count/)
    assert.match(p, /Keep what the operator kept/)
    assert.match(p, /avoid what the\s+operator rejected/)
    assert.match(p, /mix working patterns, and add new ideas/)
    assert.match(p, /Record every round in `NOTES\.md`/)
  })

  test('a prototype dispatch requires the configured count', () => {
    assert.throws(
      () => write({ mapNumber: 1, type: 'wayfinder:prototype' }),
      /prototypeVariations must be a positive integer/,
    )
  })

  test('the throwaway branch is named as the one the agent already stands on', () => {
    assert.match(proto(), new RegExp(`Your throwaway branch is \`${branchFor(42)}\`, the one you are already on`))
    assert.match(proto(), /Do not make a second branch, and do not push one/)
  })

  test('the one deviation is stated where the agent reads it, not left to the ADR', () => {
    assert.match(proto(), /`prototypes\/<name>\/`, and main keeps it/)
    assert.match(proto(), /ADR-0008/)
  })

  test('the demo is one served file, because the operator has no double-click', () => {
    const p = proto()
    assert.match(p, /ONE self-contained HTML file/)
    assert.match(p, /`publish_preview`/)
    assert.match(p, /no double-click exists/)
  })

  test('curia adds no index the skill never asked for', () => {
    assert.match(proto(), /keeps no index/)
    assert.match(proto(), /Decisions-so-far is the index/)
  })

  test('no other ticket type carries it — this bound belongs to one type', () => {
    for (const type of ['wayfinder:grilling', 'wayfinder:research', 'wayfinder:task', null]) {
      assert.ok(
        !/throwaway branch/.test(write({ mapNumber: 1, type })),
        `${type} was handed the prototype bound`,
      )
    }
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

  test('Codex loads every deferred Curia schema once, and Claude does not (#609)', () => {
    const codex = write({ mapNumber: 1, harness: 'codex' })
    assert.match(codex, /Load deferred Curia tools once/)
    assert.match(codex, /every\s+`mcp__curia__\*` definition from one `exec` call/)
    assert.match(codex, /use the same definitions for every later Curia call/)

    const claude = write({ mapNumber: 1, harness: 'claude' })
    assert.ok(!claude.includes('Load deferred Curia tools once'))
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

  test('every ticket type names each existing ticket it unblocks in both ending records', () => {
    forEveryTicketType((generatedInstructions, label) => {
      assert.match(generatedInstructions, /existing\s+follow-up ticket[^.]*unblock/i,
        `${label} omits existing follow-up tickets`)
      assertBothEndingRecords(generatedInstructions, label)
    })
  })

  test('every ticket type names each new follow-up ticket it creates in both ending records', () => {
    forEveryTicketType((generatedInstructions, label) => {
      assert.match(generatedInstructions, /new\s+follow-up ticket[^.]*create/i,
        `${label} omits new follow-up tickets`)
      assertBothEndingRecords(generatedInstructions, label)
    })
  })

  test('every ticket type records when it has no direct follow-up ticket', () => {
    forEveryTicketType((generatedInstructions, label) => {
      assert.match(generatedInstructions, /no direct follow-up ticket/i, `${label} omits the empty result`)
    })
  })

  test('charting endings record follow-up tickets from resolved research tickets', () => {
    for (const generatedInstructions of [
      write({ mapNumber: 1, charting: true }),
      write({ newMap: true, instruction: 'Chart a map' }),
    ]) {
      assert.match(generatedInstructions, /existing\s+follow-up ticket[^.]*unblock/i)
      assert.match(generatedInstructions, /new\s+follow-up ticket[^.]*create/i)
      assert.match(generatedInstructions, /no direct follow-up ticket/i)
      assertBothEndingRecords(generatedInstructions, 'charting')
    }
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

// ---- the two files (#340) ----------------------------------------------------
//
// The measurement behind this split is docs/live-checks/340-codex-skill-fade.md.
// Codex carries the global-memory file as world state and restates it, while a
// user message is conversation that its own instructions call stale after the
// next one. So the parameters ride `prompt.md` and the orders ride the memory
// file, and the tests below pin WHICH half each fact lands in.
describe('the two files (#340)', () => {
  test('the prompt holds the parameters, and nothing standing', () => {
    const { prompt } = writeParts({ mapNumber: 1, ports: [9009, 9010, 9011] })
    assert.match(prompt, /# o\/r#42: Close the loop/)
    assert.match(prompt, /already CLAIMED it in your name/)
    assert.match(prompt, /Your worktree is \/w\/42/)
    assert.match(prompt, /three preview ports/)
    for (const heading of ['## Bounds', '## Your tools', '## How this ends', '## The cross-check']) {
      assert.ok(!prompt.includes(heading), `${heading} must not ride the prompt any more`)
    }
  })

  test('the standing file holds the orders, and names the ticket it belongs to', () => {
    const { standing } = writeParts({ mapNumber: 1 })
    assert.match(standing, /^# curia standing orders \(o\/r#42\)/)
    for (const heading of ['## Bounds', '## Your tools', '## How this ends', '## The cross-check']) {
      assert.ok(standing.includes(heading), `${heading} belongs in the standing orders`)
    }
    assert.ok(!standing.includes('already CLAIMED it in your name'), 'a parameter must not ride the orders')
  })

  test('the standing file invites bounded delegation on both harnesses (#545)', () => {
    for (const harness of ['claude', 'codex']) {
      const { standing } = writeParts({ mapNumber: 1, harness })
      assert.match(standing, /Keep trivial work inline\./, `${harness} keeps trivial work inline`)
      assert.match(
        standing,
        /If a task must read or write significant amounts, delegate it when delegation has no downside\./,
        `${harness} delegates significant work`,
      )
      assert.match(
        standing,
        /These standing orders pass to every subagent, and the write bounds bind each subagent as they bind you\./,
        `${harness} passes the write bounds to each subagent`,
      )
      assert.ok(
        standing.indexOf('Keep trivial work inline.') < standing.indexOf('## Your tools'),
        `${harness} keeps delegation beside the bounds`,
      )
    }
  })

  test('the prompt points at the file, so the bounds never read as missing', () => {
    assert.match(writeParts({ mapNumber: 1 }).prompt, /Your bounds, your tools and the ending are in `CLAUDE\.md`/)
    assert.match(writeParts({ mapNumber: 1, harness: 'codex' }).prompt, /are in `AGENTS\.md`/)
  })

  test('the memory file is the voice rules plus the orders, in that order', () => {
    writePrompt(tmp, ISSUE, { repo: 'o/r', wtPath: '/w/42', mapNumber: 1 })
    const memory = fs.readFileSync(path.join(tmp, memoryFileFor('claude')), 'utf8')
    const standing = fs.readFileSync(path.join(tmp, STANDING_FILE), 'utf8')
    assert.match(memory, /Google developer documentation style guide/, 'the voice rules are mandatory for every agent (#133)')
    assert.ok(memory.endsWith(standing), 'the orders are composed onto the end, not instead of the voice rules')
    assert.ok(memory.indexOf('Google developer documentation style guide') < memory.indexOf('# curia standing orders'))
  })

  // The failure this split would otherwise INTRODUCE. `seedConfigDir` runs on
  // every arm, including the same-harness respawn a usage limit forces, and
  // that path deliberately does not rewrite the prompt. A memory file copied
  // from voice.md alone would drop the orders there, in silence.
  test('a re-arm on the same harness keeps the orders', () => {
    seedConfigDir(tmp, '/w/42', null, 'claude')
    writePrompt(tmp, ISSUE, { repo: 'o/r', wtPath: '/w/42', mapNumber: 1 })
    const armed = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8')

    seedConfigDir(tmp, '/w/42', null, 'claude')
    assert.equal(fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8'), armed,
      'the second arm dropped the standing orders, which is the #340 failure arriving by the back door')
  })

  test('a harness that names no memory file is refused', () => {
    assert.throws(() => memoryFileFor('gemini'), /no agent harness/)
  })
})

// #374, decided at #344: `resume` handed a fresh agent the worktree and the
// model and none of the exchange, so every question the operator had already
// answered was asked again — and the wait is the expensive part.
//
// The cure is a PUSH. The daemon writes the recorded questions and answers into
// the prompt's own parameters, because a prior answer IS a parameter of this
// dispatch. The seven rules the operator settled are pinned one test each.
describe('the inherited exchange (#374)', () => {
  const ANSWERED = [
    { id: 'esc-1', kind: 'free-text', prompt: 'which reduction holds the record?', answer: 'the journal', attachments: 0 },
    { id: 'esc-4', kind: 'review-gate', prompt: 'is this done?', answer: 'no — the cap is missing', attachments: 0 },
  ]

  test('a first dispatch has no exchange, and the prompt says nothing about one', () => {
    // The block is absent, not empty: an agent told "no answers are recorded"
    // learns nothing and reads one more paragraph for it.
    const p = write({ mapNumber: 1 })
    assert.ok(!p.includes('already answered on this ticket'))
    assert.equal(write({ mapNumber: 1, exchange: [] }), p)
  })

  test('question and answer both ride, verbatim and quoted', () => {
    // Rule 2. An answer alone is unreadable — "the journal" says nothing
    // without what was asked. Quoted, because the operator's own words can
    // carry headings and lists that would otherwise read as this prompt's.
    const p = write({ mapNumber: 1, exchange: ANSWERED })
    assert.match(p, /> which reduction holds the record\?/)
    assert.match(p, /> the journal/)
    assert.match(p, /\*\*1\. curia asked\*\* \(`esc-1`, free-text\):/)
  })

  test('the block sits in the parameters, not in the standing orders', () => {
    // A prior answer is a parameter of THIS dispatch (#340): it changes with
    // every spawn, and the orders hold for the whole ticket.
    const { prompt, standing } = writeParts({ mapNumber: 1, exchange: ANSWERED })
    assert.match(prompt, /## What curia already did \(parameters, not procedure\)/)
    assert.ok(prompt.includes('which reduction holds the record?'))
    assert.ok(!standing.includes('which reduction holds the record?'))
  })

  test('the agent is told the answers are recorded, and what that costs it', () => {
    // Rule 5, and the reason it matters: a recorded answer read as a fresh one
    // is a stale ruling taken as this session's, and nobody sees it happen.
    const p = write({ mapNumber: 1, exchange: ANSWERED })
    assert.match(p, /RECORDED words, not a fresh reply/)
    assert.match(p, /\*\*Do not ask any of them again\.\*\*/)
    assert.match(p, /say so with `ask_human` rather than choosing between them yourself/)
    assert.match(p, /It does not settle a near neighbour/)
  })

  test('the review gate rides along with the rest', () => {
    // Rule 6. A gate REJECTION is the operator's own instruction, and today it
    // dies with the agent that read it.
    const p = write({ mapNumber: 1, exchange: ANSWERED })
    assert.match(p, /\(`esc-4`, review-gate\)/)
    assert.match(p, /> no — the cap is missing/)
  })

  test('the oldest question is written first, whatever the caller hands over', () => {
    const p = write({ mapNumber: 1, exchange: ANSWERED })
    assert.ok(p.indexOf('which reduction holds the record?') < p.indexOf('is this done?'))
  })

  test('an answer that carried images says so, and carries no path', () => {
    // #34 sends an answer's images to the agent as tool-result content. A file
    // cannot hold them, and a path into the daemon's disk would be a dead link.
    const p = write({ mapNumber: 1, exchange: [{ ...ANSWERED[0], attachments: 2 }] })
    assert.match(p, /the answer carried 2 images, which this file cannot repeat/)
  })

  test('a runaway question is cut per field, and says how long it really was', () => {
    // Rule 4, first half: one enormous round must not eat the whole block.
    const long = 'x'.repeat(EXCHANGE_FIELD_CAP * 3)
    const p = write({ mapNumber: 1, exchange: [{ id: 'esc-9', kind: 'free-text', prompt: long, answer: 'ok', attachments: 0 }] })
    assert.ok(!p.includes(long), 'the whole question reached the prompt')
    assert.match(p, new RegExp(`cut here: the question ran to ${EXCHANGE_FIELD_CAP * 3} characters`))
  })

  test('a long history keeps the NEWEST answers, and says how many it dropped', () => {
    // Rule 4, second half. The answers nearest the dead agent's last turn are
    // the ones a resumed agent is about to re-ask, so those are what survive.
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `esc-${i + 1}`,
      kind: 'free-text',
      prompt: `question ${i + 1} `.padEnd(EXCHANGE_FIELD_CAP, 'q'),
      answer: `answer ${i + 1} `.padEnd(EXCHANGE_FIELD_CAP, 'a'),
      attachments: 0,
    }))
    const { prompt } = writeParts({ mapNumber: 1, exchange: many })
    assert.ok(prompt.includes('question 40'), 'the newest question was dropped')
    assert.ok(!prompt.includes('question 1 '), 'the oldest question survived a full block')
    assert.match(prompt, /older answers are not shown here/)
    // The cap bounds the operator's own words. The block itself is a little
    // larger, because every entry carries a heading and every line a `> `.
    const block = prompt.slice(prompt.indexOf('### What the operator has already answered'))
    assert.ok(block.length < EXCHANGE_BLOCK_CAP * 1.2, `the block ran to ${block.length} characters`)
  })

  test('one surviving answer reads as one, not as "1 questions"', () => {
    assert.match(write({ mapNumber: 1, exchange: [ANSWERED[0]] }), /These is one question an agent on this ticket asked/)
  })

  test('the one-tap answer is glossed, because cold it reads as no answer at all', () => {
    // #285's ✅ button records one word. An agent meeting it for the first time
    // could take it for a non-answer and ask the round again, which is exactly
    // the wait this block exists to spare the operator.
    const p = write({
      mapNumber: 1,
      exchange: [{ id: 'esc-7', kind: 'free-text', prompt: '1. reach?\nRecommended: every dispatch', answer: 'all-as-recommended', attachments: 0 }],
    })
    assert.match(p, /the operator took the recommendation on every question above/)
    assert.ok(!write({ mapNumber: 1, exchange: ANSWERED }).includes('one-tap button'), 'an ordinary answer is not glossed')
  })

  test('a charting agent inherits its map exchange too', () => {
    // A map session is `curia-<map>`, and it holds a conversation of its own.
    const p = write({ mapNumber: 42, charting: true, exchange: ANSWERED })
    assert.match(p, /> which reduction holds the record\?/)
  })
})

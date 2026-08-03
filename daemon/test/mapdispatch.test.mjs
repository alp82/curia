// The map dispatch (#160, building #149 points 3-5): `start curia#<map>` on a
// `wayfinder:map` issue spawns a CHARTING worker, which updates the map and
// ends without a close, a pull request or a review gate.
//
// Four seams, tested where each one lives:
//   1. the canonical text — `-- <instruction>` on `start` (commands.test.mjs
//      and overseer.test.mjs carry the parse and the render);
//   2. routing — a `map` row in the defaults, reached by the label;
//   3. the prompt — a charting worker is told what it is, what the operator
//      asked for, and what it must not do;
//   4. the ending — Stop-hook checklist, the two refused tools, and what
//      report_result does instead of resolving.
//
// The failure this file exists to pin: a charting worker run through the TICKET
// ending would close the map. That is the one act nothing can undo cheaply —
// closing a map takes a whole effort off every frontier — so the assertions on
// #finishCharting are exact rather than "does not throw".

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Dispatcher } from '../src/dispatch.mjs'
import { writePrompt } from '../src/workspace.mjs'
import { outstanding, CHARTING_ENDING, ENDING } from '../src/lifecycle.mjs'
import { chartingComment } from '../src/resolve.mjs'
import { resolveModel, candidates, Cooling } from '../src/routing.mjs'
import { loadRoutingConfig } from '../src/config.mjs'
import { expandCommand } from '../src/bridge.mjs'
import { parseCommand } from '../src/commands.mjs'

const ROUTING = {
  defaults: { untyped: 'sonnet', map: 'opus' },
  models: {
    sonnet: { provider: 'anthropic', backend: 'claude' },
    opus: { provider: 'anthropic', backend: 'claude' },
  },
  fallbacks: {},
  backends: { claude: { template: 'claude --model {model} "$(cat {prompt_file})"', ready: 'x', readyRe: /x/ } },
}

const MAP_ISSUE = {
  number: 147, title: 'Curia gets better', body: '## Destination\n\nsomewhere', state: 'open',
  assignees: [], labels: [{ name: 'wayfinder:map' }],
}

const TICKET_ISSUE = {
  number: 42, title: 'a ticket', body: 'body text', state: 'open',
  assignees: [], labels: [{ name: 'wayfinder:task' }],
}

let tmp
let notifies
let events
let calls // every gh-ish effect the dispatcher ordered, in order

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-mapdispatch-test-'))
  fs.mkdirSync(path.join(tmp, 'data', 'results'), { recursive: true })
  notifies = []
  events = []
  calls = []
})

afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function makeDispatcher(deps = {}, { issue = MAP_ISSUE } = {}) {
  const root = path.join(tmp, 'work')
  const dataDir = path.join(tmp, 'data')
  const config = {
    watch: [{ repo: 'o/r', mode: 'auto' }],
    dispatch: {
      auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
      workspace_root: root, ready_timeout_s: 45, stop_nudge_budget: 3,
    },
    attach: { ttyd_port: 7681, serve_port: 8443 },
    identity: { allow: ['tester@example.com'], proxy_port: 7682 },
    skills: null,
  }
  // The journal is a real file here: #epochCharting reads it back, which is the
  // whole point of journalling the kind — a restarted daemon must still know
  // which ending it is holding a worker to.
  const store = {
    logEvent: (type, data) => {
      const rec = { type, ...data }
      events.push(rec)
      fs.appendFileSync(path.join(dataDir, 'events.jsonl'), JSON.stringify(rec) + '\n')
      return rec
    },
    openEscalations: () => [],
    cancel: () => ({ ok: true }),
  }
  const base = {
    viewerLogin: async () => 'me',
    repoMaps: async () => [],
    mapFrontier: async () => [],
    flatFrontier: async () => [],
    blockedByOf: async () => [],
    fetchIssue: async () => ({ ...issue }),
    claim: async (repo, n) => calls.push(`claim ${repo}#${n}`),
    unclaim: async (repo, n) => calls.push(`unclaim ${repo}#${n}`),
    hasSession: async () => false,
    listSessions: async () => [],
    newSession: async () => {},
    capturePane: async () => '',
    killSession: async () => {},
    ensureBaseClone: async (r, repo) => path.join(r, 'repos', repo.replace('/', '__'), 'base'),
    createWorktree: async (b, n) => {
      const wt = path.join(path.dirname(b), 'wt', String(n))
      fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
      fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
      return wt
    },
    removeWorktree: async () => {},
    removeConfigDir: () => {},
    removeCredentials: () => {},
    seedConfigDir: () => {},
    writeHarness: () => {},
    writePrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
    ensureTtyd: async () => ({ verified: true }),
    assertServe: async () => {},
    serveOff: async () => {},
    commentIssue: async (repo, n, body) => calls.push(`comment ${repo}#${n}`, body),
    closeIssue: async (repo, n) => calls.push(`CLOSE ${repo}#${n}`),
    setIssueBody: async (repo, n) => calls.push(`setBody ${repo}#${n}`),
    issueComments: async () => [],
    findPullRequest: async () => null,
    createPullRequest: async () => { calls.push('createPullRequest'); return 'https://github.com/o/r/pull/1' },
    defaultBranchOf: async () => 'main',
    commitsOnBranch: async () => [],
    pushBranch: async () => { calls.push('pushBranch'); return 'abc1234' },
    hasUnpushedWork: async () => false,
    setPullRequestBody: async () => {},
    deleteRemoteBranch: async () => ({ deleted: true }),
  }
  const d = new Dispatcher({
    config,
    routing: ROUTING,
    store,
    notify: (ticket, message) => notifies.push({ ticket, message }),
    log: () => {},
    dataDir,
    daemonPort: 4271,
    deps: { ...base, ...deps },
  })
  d.identityProxy = { listening: true }
  return d
}

// ---- routing (#149 point 5) ---------------------------------------------------

describe('a wayfinder:map row joins the routing defaults', () => {
  test('the shipped config routes a map to a claude-backend model', () => {
    const routing = loadRoutingConfig(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'config', 'routing.yaml'))
    const model = resolveModel(routing, ['wayfinder:map'], null)
    assert.ok(routing.defaults.map, 'routing.yaml states no map default')
    assert.equal(model, routing.defaults.map)
    assert.equal(routing.models[model].backend, 'claude', 'a map dispatch must route to the claude lane')
  })

  test('the shipped chain is the one the operator asked for on #160', () => {
    // "fable with fallback to opus if it's at its limit. then again fallback to
    // gpt 5.6 sol" — ruled 2026-08-03. Pinned because it is a THREE-hop
    // transitive walk through `fallbacks`, not a list anyone can read off one
    // row, so an edit to opus's or fable's chain can move it silently.
    const routing = loadRoutingConfig(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'config', 'routing.yaml'))
    const chain = candidates(routing, resolveModel(routing, ['wayfinder:map'], null), new Cooling())
    assert.deepEqual(chain.slice(0, 3), ['fable', 'opus', 'gpt'])
    assert.equal(routing.models.gpt.id, 'gpt-5.6-sol')
  })

  test('a model: label on the map still beats the row', () => {
    // The precedence rule is resolveModel's and unchanged — pinned here because
    // #149 named it as part of THIS decision, so a later edit to the defaults
    // has a test that says the override outranks them.
    assert.equal(resolveModel(ROUTING, ['wayfinder:map'], null), 'opus')
    assert.equal(resolveModel(ROUTING, ['wayfinder:map', 'model:sonnet'], null), 'sonnet')
  })
})

// ---- the prompt (#149 point 4) ------------------------------------------------

describe('the charting prompt', () => {
  const write = (opts) => {
    const file = writePrompt(tmp, MAP_ISSUE, { repo: 'o/r', wtPath: '/w/147', mapNumber: 147, type: 'wayfinder:map', ...opts })
    return fs.readFileSync(file, 'utf8')
  }

  test('the /wayfinder line names the map and NO ticket', () => {
    // The skill still has to load — fog of war, out of scope, the body shape and
    // refer-by-name are doctrine curia does not restate — but "ticket #147"
    // would tell it to resolve the map as if it were its own child.
    const p = write({ charting: true, instruction: 'add a ticket for X' })
    assert.equal(p.split('\n')[0], '/wayfinder https://github.com/o/r/issues/147')
  })

  test('it says this is a map dispatch and cancels the skill\'s choose-a-ticket step', () => {
    const p = write({ charting: true, instruction: 'add a ticket for X' })
    assert.match(p, /\*\*This is a MAP DISPATCH\.\*\*/)
    assert.match(p, /Do not choose a frontier ticket/)
    assert.ok(!p.includes('already CLAIMED it in your name'), 'the ticket-claim wording must not reach a charting worker')
  })

  test('the operator\'s sentence rides the prompt verbatim, as the first thing it reads', () => {
    // #149 called it "the worker's first note". The note QUEUE drains on the
    // next curia tool call, and a charting worker can read the map and start
    // editing before it makes one — so the prompt is the only channel that is
    // first by construction.
    const p = write({ charting: true, instruction: 'update the landing page map so that the proof frames come last' })
    assert.match(p, /> update the landing page map so that the proof frames come last/)
    assert.match(p, /This is the whole brief/)
  })

  test('with no instruction the worker is ordered to ask what should change', () => {
    const p = write({ charting: true, instruction: null })
    assert.match(p, /No instruction rode this dispatch/)
    assert.match(p, /FIRST act is one\n\s*`ask_human` call: what should change on this map\?/)
    assert.ok(!p.includes('the whole brief'))
  })

  test('the ending has no pull request, no review and no merge — and says so', () => {
    const p = write({ charting: true, instruction: 'x' })
    const ending = p.slice(p.indexOf('## How this ends'))
    assert.match(ending, /Update the map/)
    assert.match(ending, /Never close the map/)
    assert.match(ending, /curia refuses both/)
    assert.ok(!/Only after the approval: merge it/.test(ending), 'the merge step leaked into a map dispatch')
    assert.ok(!/request_review`: a summary of what you did/.test(ending), 'the review step leaked into a map dispatch')
  })

  test('the write bounds are the map and its children, and nothing on disk', () => {
    const p = write({ charting: true, instruction: 'x' })
    assert.match(p, /\*\*Write only:\*\* the map o\/r#147 and its child tickets/)
    assert.match(p, /read-only checkout/)
  })

  test('an ordinary ticket prompt is untouched by any of it', () => {
    const p = writePrompt(tmp, TICKET_ISSUE, { repo: 'o/r', wtPath: '/w/42', mapNumber: 147, type: 'wayfinder:task' })
    const text = fs.readFileSync(p, 'utf8')
    assert.equal(text.split('\n')[0], '/wayfinder https://github.com/o/r/issues/147 ticket #42')
    assert.match(text, /already CLAIMED it in your name/)
    assert.match(text, /Only after the approval: merge it/)
    assert.ok(!text.includes('MAP DISPATCH'))
  })
})

// ---- the ending (#149 point 3) ------------------------------------------------

describe('the charting checklist', () => {
  test('a charting worker is only ever held for report_result', () => {
    // The state below would put THREE items on a ticket worker's checklist.
    const state = { hasResult: false, hasCommits: true, prOpened: false, reviewApproved: false, prState: null }
    assert.equal(outstanding({ ...state, charting: false }).length, 3)
    assert.deepEqual(outstanding({ ...state, charting: true }), ['call `report_result` exactly once'])
  })

  test('a reported result ends both endings, whatever its status', () => {
    assert.deepEqual(outstanding({ hasResult: true, charting: true }), [])
    assert.deepEqual(outstanding({ hasResult: true, charting: false }), [])
  })

  test('the charting ending states no step the daemon cannot see', () => {
    // Every `todo` is a step the Stop hook will block on, so a step with no
    // evidence behind it would trap the worker. Only `report` has one.
    assert.deepEqual(CHARTING_ENDING.filter((s) => s.todo).map((s) => s.key), ['report'])
    assert.ok(ENDING.filter((s) => s.todo).length > 1, 'the ticket ending should still have several')
  })
})

describe('report_result on a map dispatch', () => {
  async function chartAndReport(result, deps = {}) {
    const d = makeDispatcher(deps)
    const reply = await d.start('147')
    assert.match(reply, /charting worker on map/)
    calls.length = 0
    const text = await d.onResult('curia-147', result)
    return { d, text }
  }

  test('it comments on the map, unassigns it, and CLOSES NOTHING', async () => {
    const { text } = await chartAndReport({
      ticket: '147', status: 'resolved', summary: 'graduated two fog lines into tickets',
    })
    assert.ok(calls.some((c) => c === 'comment o/r#147'), 'no summary comment on the map')
    assert.ok(calls.some((c) => c === 'unclaim o/r#147'), 'the map stayed assigned')
    assert.ok(!calls.some((c) => String(c).startsWith('CLOSE')), 'a charting worker closed the map')
    assert.ok(!calls.some((c) => String(c).startsWith('setBody')), 'curia wrote a Decisions-so-far line for a charting session')
    assert.ok(!calls.includes('pushBranch') && !calls.includes('createPullRequest'), 'a charting session landed code')
    assert.match(text, /Nothing was closed, resolved or pushed/)
  })

  test('the summary comment carries the operator\'s instruction and the model', async () => {
    await chartAndReport({ ticket: '147', status: 'resolved', summary: 'did the thing' })
    const body = calls.find((c) => typeof c === 'string' && c.startsWith('## Charting'))
    assert.ok(body, 'the comment body is not a charting comment')
    assert.match(body, /curia session `curia-147`/)
    assert.match(body, /did the thing/)
    assert.match(body, /opened no pull request and closed nothing/)
  })

  test('a blocked charting worker still leaves the map unassigned and says the edits stand', async () => {
    // The half-charted map is the dangerous state: the next operator has to
    // know that whatever it wrote is already live on the map.
    await chartAndReport({ ticket: '147', status: 'blocked', summary: 'ran out of road on the fog section' })
    const body = calls.find((c) => typeof c === 'string' && c.startsWith('## Charting'))
    assert.match(body, /\*\*blocked\*\*/)
    assert.match(body, /STANDS/)
    assert.ok(calls.some((c) => c === 'unclaim o/r#147'))
    assert.ok(!calls.some((c) => String(c).startsWith('CLOSE')))
  })

  test('the finish is journalled as charting, not as a resolution', async () => {
    await chartAndReport({ ticket: '147', status: 'resolved', summary: 's' })
    assert.ok(events.some((e) => e.type === 'charting_finished' && e.map === '147'))
    assert.ok(!events.some((e) => e.type === 'ticket_resolved'))
  })

  test('a worker whose record this process never held is still read as charting', async () => {
    // The restart case: the in-memory record is gone and only the journal is
    // left. Falling back to "ticket" here would close the map.
    const d = makeDispatcher()
    await d.start('147')
    d.workers.delete('curia-147') // as a restart, or #releaseClaim, leaves it
    calls.length = 0
    await d.onResult('curia-147', { ticket: '147', status: 'resolved', summary: 's' })
    assert.ok(!calls.some((c) => String(c).startsWith('CLOSE')), 'the journal fallback lost the charting kind')
    assert.ok(calls.some((c) => c === 'comment o/r#147'))
  })
})

describe('the two tools a map dispatch refuses', () => {
  test('open_pull_request is refused, and nothing is pushed', async () => {
    const d = makeDispatcher()
    await d.start('147')
    calls.length = 0
    const reply = await d.openPullRequest('curia-147', { summary: 'x' })
    assert.match(reply, /CHARTING worker/)
    assert.match(reply, /opens no pull request/)
    assert.equal(calls.length, 0, 'the refusal still touched the remote')
    assert.ok(events.some((e) => e.type === 'charting_tool_refused' && e.tool === 'open_pull_request'))
  })

  test('request_review is refused, and no gate is opened', async () => {
    let asked = 0
    const d = makeDispatcher()
    d.askReview = async () => { asked += 1; return { text: 'approve', status: 'answered' } }
    await d.start('147')
    const r = await d.requestReview('curia-147', { summary: 'x', charting: 'y' })
    assert.equal(r.ok, false)
    assert.match(r.text, /no review gate/)
    assert.equal(asked, 0, 'a review gate was opened for a map dispatch')
  })

  test('an ordinary ticket worker reaches both as before', async () => {
    const d = makeDispatcher({}, { issue: TICKET_ISSUE })
    await d.start('42')
    const reply = await d.openPullRequest('curia-42', { summary: 'x' })
    assert.ok(!/CHARTING/.test(reply))
  })
})

// ---- the dispatch itself ------------------------------------------------------

describe('start on a map', () => {
  test('the map is claimed, the prompt gets the map and the instruction, and the reply says charting', async () => {
    let prompted = null
    const d = makeDispatcher({
      writePrompt: (cfgDir, issue, opts) => { prompted = opts; return path.join(cfgDir, 'prompt.md') },
    })
    const reply = await d.start('147', { instruction: 'add a ticket for the cooling signal' })
    assert.match(reply, /charting worker on map o\/r#147/)
    assert.match(reply, /on \*\*opus\*\*/)
    assert.equal(prompted.charting, true)
    assert.equal(prompted.mapNumber, 147)
    assert.equal(prompted.instruction, 'add a ticket for the cooling signal')
    assert.ok(calls.includes('claim o/r#147'))
  })

  test('with no instruction the reply says the worker will ask', async () => {
    const d = makeDispatcher()
    const reply = await d.start('147')
    assert.match(reply, /no instruction rode this dispatch, so it will ask what should change/)
  })

  test('the spawn is journalled with its kind and its instruction', async () => {
    const d = makeDispatcher()
    await d.start('147', { instruction: 'do X' })
    const spawn = events.find((e) => e.type === 'worker_spawned')
    assert.equal(spawn.kind, 'charting')
    assert.equal(spawn.instruction, 'do X')
  })

  test('an instruction on a ticket is REFUSED, not dropped', async () => {
    // Silently dropping it would steer nothing and say nothing. The ticket body
    // is where a ticket worker's brief has to live, because other sessions read
    // it and a spawn prompt is read once.
    const d = makeDispatcher({}, { issue: TICKET_ISSUE })
    const reply = await d.start('42', { instruction: 'focus on the routing part' })
    assert.match(reply, /not a `wayfinder:map` issue/)
    assert.equal(calls.length, 0, 'the refused dispatch still claimed the ticket')
  })

  test('a ticket dispatch is journalled as a ticket', async () => {
    const d = makeDispatcher({}, { issue: TICKET_ISSUE })
    await d.start('42')
    assert.equal(events.find((e) => e.type === 'worker_spawned').kind, 'ticket')
  })

  test('a map already assigned refuses — one charting worker at a time', async () => {
    // The map body is a read-modify-write with no compare-and-swap behind it,
    // and the WORKER does the writing, so #withMapLock cannot serialise it.
    // The claim is what does.
    const d = makeDispatcher({}, { issue: { ...MAP_ISSUE, assignees: [{ login: 'me' }] } })
    const reply = await d.start('147')
    assert.match(reply, /already assigned/)
  })
})

describe('resume on a map', () => {
  test('the instruction that rode the first dispatch rides the resumed one', async () => {
    let prompted = null
    const d = makeDispatcher({
      writePrompt: (cfgDir, issue, opts) => { prompted = opts; return path.join(cfgDir, 'prompt.md') },
    })
    await d.start('147', { instruction: 'graduate the cooling fog' })
    d.workers.delete('curia-147')
    prompted = null
    await d.resume('147')
    assert.equal(prompted.instruction, 'graduate the cooling fog', 'the resumed charting worker lost the brief')
  })

  test('a map that has since lost its label degrades instead of refusing', async () => {
    // The operator typed no instruction on `resume`, so a refusal naming one
    // would be a refusal for something they did not do.
    const d = makeDispatcher()
    await d.start('147', { instruction: 'do X' })
    d.workers.delete('curia-147')
    const plain = makeDispatcher({ fetchIssue: async () => ({ ...MAP_ISSUE, labels: [] }) })
    plain.dataDir = d.dataDir
    const reply = await plain.resume('147')
    assert.ok(!/an instruction rides a map dispatch only/.test(reply), reply)
  })
})

// ---- the phone's command surface ----------------------------------------------

describe('the /start slash expansion', () => {
  const interaction = (options) => ({
    commandName: 'start',
    options: { getString: (name) => options[name] ?? null },
  })

  test('an instruction expands to the same canonical text the overseer writes', () => {
    assert.equal(
      expandCommand(interaction({ ticket: '147', instruction: 'add a ticket for X' })),
      'start 147 -- add a ticket for X',
    )
    assert.equal(
      expandCommand(interaction({ ticket: '147', model: 'opus', instruction: 'add a ticket for X' })),
      'start 147 model=opus -- add a ticket for X',
    )
  })

  test('no instruction leaves the pre-#160 text untouched', () => {
    // An old client-side manifest sends no such option (#65), and the dispatch
    // must still work — the charting worker then asks what should change.
    assert.equal(expandCommand(interaction({ ticket: '147' })), 'start 147')
    assert.equal(expandCommand(interaction({ ticket: '147', instruction: '  ' })), 'start 147')
  })

  test('what the phone sends, the router reads back', () => {
    const text = expandCommand(interaction({ ticket: '147', backend: 'claude', instruction: 'chart\nthe fog' }))
    assert.deepEqual(parseCommand(text), {
      verb: 'start', ticket: '147', backend: 'claude', instruction: 'chart the fog',
    })
  })
})

// ---- the comment shape --------------------------------------------------------

describe('chartingComment', () => {
  test('it is not marked as machine plumbing — it is the record of the session', () => {
    const body = chartingComment({
      worker: 'curia-147', model: 'opus', instruction: 'do X',
      result: { status: 'resolved', summary: 'did X' },
    })
    assert.ok(!body.includes('curia:machine'))
    assert.match(body, /> do X/)
  })

  test('no instruction is stated as such, never left blank', () => {
    const body = chartingComment({
      worker: 'curia-147', model: 'opus', instruction: null,
      result: { status: 'resolved', summary: 'did X' },
    })
    assert.match(body, /Dispatched with no instruction/)
  })
})

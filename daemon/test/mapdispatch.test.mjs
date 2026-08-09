// The map dispatch (#160, building #149 points 3-5): a `wayfinder:map` issue
// gets a CHARTING agent, which updates the map and ends without a close, a
// pull request or a review gate.
//
// #221 moved the verb. `start <map>` used to spawn that agent, which gave one
// word two meanings; it now dispatches the map's next takeable ticket, and
// `map <n> [-- <instruction>]` is charting's own verb. The mechanics below are
// #160's, unchanged, with one removal: NO DISPATCH CLAIMS A MAP any more.
//
// Four seams, tested where each one lives:
//   1. the canonical text — `-- <instruction>` on `map` (commands.test.mjs
//      and overseer.test.mjs carry the parse and the render);
//   2. routing — a `map` row in the defaults, reached by the label;
//   3. the prompt — a charting agent is told what it is, what the operator
//      asked for, and what it must not do;
//   4. the ending — Stop-hook checklist, the two refused tools, and what
//      report_result does instead of resolving.
//
// The failure this file exists to pin: a charting agent run through the TICKET
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
import { TEST_PINS, containerDeps, seedConfigDirStub, withTestCredential } from './fixtures/sandbox.mjs'

const ROUTING = {
  defaults: { untyped: 'sonnet', map: 'opus' },
  models: {
    sonnet: { provider: 'anthropic', harness: 'claude' },
    opus: { provider: 'anthropic', harness: 'claude' },
  },
  fallbacks: {},
  harnesses: { claude: { template: 'claude --model {model} "$(cat {prompt_file})"', ready: 'x', toolChannelGraceS: 15, readyRe: /x/ } },
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
let restoreCredential // #195: the model credential the container env file needs

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-mapdispatch-test-'))
  fs.mkdirSync(path.join(tmp, 'data', 'results'), { recursive: true })
  notifies = []
  events = []
  calls = []
  restoreCredential = withTestCredential()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  restoreCredential()
})

// Poll until a condition holds — the watchdog paths below are timers, not
// promises the caller can await.
async function waitFor(cond, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out waiting for a condition')
}

function makeDispatcher(deps = {}, { issue = MAP_ISSUE, routing = ROUTING } = {}) {
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
    // #195: every dispatch prepares a container, so every Dispatcher needs pins
    sandbox: TEST_PINS,
  }
  // The journal is a real file here: #epochCharting reads it back, which is the
  // whole point of journalling the kind — a restarted daemon must still know
  // which ending it is holding an agent to.
  const store = {
    logEvent: (type, data) => {
      const rec = { type, ...data }
      events.push(rec)
      fs.appendFileSync(path.join(dataDir, 'events.jsonl'), JSON.stringify(rec) + '\n')
      return rec
    },
    openEscalations: () => [],
    cancel: () => ({ ok: true }),
    // #208: no test here queues an operator note, so nothing ever expires
    expireAgentNotes: () => 0,
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
    ...containerDeps(),
    removeWorkspace: async () => {},
    removeConfigDir: () => {},
    removeCredentials: () => {},
    seedConfigDir: seedConfigDirStub(),
    writeConnectionSettings: () => {},
    writePrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
    probeTtyd: async () => ({ verified: true }),
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
    routing,
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
  test('the shipped config routes a map to a claude-harness model', () => {
    const routing = loadRoutingConfig(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'config', 'routing.yaml'))
    const model = resolveModel(routing, ['wayfinder:map'], null)
    assert.ok(routing.defaults.map, 'routing.yaml states no map default')
    assert.equal(model, routing.defaults.map)
    assert.equal(routing.models[model].harness, 'claude', 'a map dispatch must route to the claude harness')
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
    assert.ok(!p.includes('already CLAIMED it in your name'), 'the ticket-claim wording must not reach a charting agent')
  })

  test('the operator\'s sentence rides the prompt verbatim, as the first thing it reads', () => {
    // #149 called it "the agent's first note". The note QUEUE drains on the
    // next curia tool call, and a charting agent can read the map and start
    // editing before it makes one — so the prompt is the only channel that is
    // first by construction.
    const p = write({ charting: true, instruction: 'update the landing page map so that the proof frames come last' })
    assert.match(p, /> update the landing page map so that the proof frames come last/)
    assert.match(p, /This is the whole brief/)
  })

  test('with no instruction the agent is ordered to ask what should change', () => {
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

describe('the new-map prompt (#241)', () => {
  const NEW_MAP_ISSUE = {
    number: 'chat-1', title: 'new map: chart the next feature', body: 'chart the next feature',
    state: 'open', assignees: [], labels: [{ name: 'wayfinder:map' }],
  }
  const write = (opts = {}) => {
    const file = writePrompt(tmp, NEW_MAP_ISSUE, {
      repo: 'o/r', wtPath: '/w/chat-1', mapNumber: null, type: 'wayfinder:map',
      charting: true, newMap: true, instruction: 'read direction.md and chart the next feature', ...opts,
    })
    return fs.readFileSync(file, 'utf8')
  }

  test('the /wayfinder line names NO map — it is the skill\'s chart mode', () => {
    // "Chart the map" starts from a loose idea. A map URL here would invoke
    // "work through the map" against an issue that does not exist.
    assert.equal(write().split('\n')[0], '/wayfinder')
  })

  test('it says the map does not exist and orders the chart mode from the top', () => {
    const p = write()
    assert.match(p, /\*\*This is a NEW-MAP DISPATCH\.\*\*/)
    assert.match(p, /No map exists yet/)
    assert.match(p, /"Chart the map" mode/)
    assert.ok(!p.includes('This is a MAP DISPATCH'), 'the map-dispatch wording must not reach a new-map agent')
    assert.ok(!p.includes('already CLAIMED it in your name'))
  })

  test('the operator\'s prose rides verbatim, as the loose idea and not a specification', () => {
    const p = write()
    assert.match(p, /> read direction\.md and chart the next feature/)
    assert.match(p, /loose idea, not a specification/)
  })

  test('the adoption is ordered in the params AND in the ending', () => {
    const p = write()
    assert.match(p, /call `map_created` with its number/)
    const ending = p.slice(p.indexOf('## How this ends'))
    assert.match(ending, /map_created/)
    assert.match(ending, /report_result/)
    assert.ok(!/Only after the approval: merge it/.test(ending))
  })

  test('map_created is listed as a tool, and only here', () => {
    assert.match(write(), /- `map_created`/)
    const onAMap = writePrompt(tmp, MAP_ISSUE, {
      repo: 'o/r', wtPath: '/w/147', mapNumber: 147, type: 'wayfinder:map', charting: true, instruction: 'x',
    })
    assert.ok(!fs.readFileSync(onAMap, 'utf8').includes('map_created'))
  })

  test('the write bound is the ONE map it creates, and no existing issue', () => {
    const p = write()
    assert.match(p, /the ONE `wayfinder:map` issue you create in o\/r/)
    assert.match(p, /no existing issue is yours to edit/)
    assert.match(p, /read-only checkout/)
  })

  test('it is told to create NO map when the grilling shows none is needed', () => {
    // The skill says this too, and it is the finding most easily overridden by
    // the pull to produce the artifact the dispatch named.
    assert.match(write(), /If the grilling shows no map is needed/)
  })

  test('the HITL rule is stated — the destination is the operator\'s to settle', () => {
    const p = write()
    assert.match(p, /many `ask_human` calls, one question at a time/)
    assert.match(p, /Never answer for them/)
  })
})

// ---- the ending (#149 point 3) ------------------------------------------------

describe('the charting checklist', () => {
  test('a charting agent is only ever held for report_result', () => {
    // The state below would put THREE items on a ticket agent's checklist.
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
    // evidence behind it would trap the agent. Only `report` has one.
    assert.deepEqual(CHARTING_ENDING.filter((s) => s.todo).map((s) => s.key), ['report'])
    assert.ok(ENDING.filter((s) => s.todo).length > 1, 'the ticket ending should still have several')
  })
})

describe('report_result on a map dispatch', () => {
  async function chartAndReport(result, deps = {}) {
    const d = makeDispatcher(deps)
    const reply = await d.chart('147')
    assert.match(reply, /charting agent on map/)
    calls.length = 0
    const text = await d.onResult('curia-147', result)
    return { d, text }
  }

  test('it comments on the map, TOUCHES NO ASSIGNEE, and CLOSES NOTHING', async () => {
    const { text } = await chartAndReport({
      ticket: '147', status: 'resolved', summary: 'graduated two fog lines into tickets',
    })
    assert.ok(calls.some((c) => c === 'comment o/r#147'), 'no summary comment on the map')
    // #221: nothing claimed the map, so nothing releases it. An unclaim here
    // would undo an assignee an operator had put on by hand.
    assert.ok(!calls.some((c) => c === 'unclaim o/r#147'), 'the charting ending unclaimed a map it never claimed')
    assert.ok(!calls.some((c) => String(c).startsWith('CLOSE')), 'a charting agent closed the map')
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

  test('a blocked charting agent says the edits stand, and still claims nothing', async () => {
    // The half-charted map is the dangerous state: the next operator has to
    // know that whatever it wrote is already live on the map.
    await chartAndReport({ ticket: '147', status: 'blocked', summary: 'ran out of road on the fog section' })
    const body = calls.find((c) => typeof c === 'string' && c.startsWith('## Charting'))
    assert.match(body, /\*\*blocked\*\*/)
    assert.match(body, /STANDS/)
    assert.ok(!calls.some((c) => c === 'unclaim o/r#147'))
    assert.ok(!calls.some((c) => String(c).startsWith('CLOSE')))
  })

  test('the finish is journalled as charting, not as a resolution', async () => {
    await chartAndReport({ ticket: '147', status: 'resolved', summary: 's' })
    assert.ok(events.some((e) => e.type === 'charting_finished' && e.map === '147'))
    assert.ok(!events.some((e) => e.type === 'ticket_resolved'))
  })

  test('an agent whose record this process never held is still read as charting', async () => {
    // The restart case: the in-memory record is gone and only the journal is
    // left. Falling back to "ticket" here would close the map.
    const d = makeDispatcher()
    await d.chart('147')
    d.agents.delete('curia-147') // as a restart, or #releaseClaim, leaves it
    calls.length = 0
    await d.onResult('curia-147', { ticket: '147', status: 'resolved', summary: 's' })
    assert.ok(!calls.some((c) => String(c).startsWith('CLOSE')), 'the journal fallback lost the charting kind')
    assert.ok(calls.some((c) => c === 'comment o/r#147'))
    // #221's own restart hazard: with no in-memory record there is no
    // `charting` flag to read off it, and #releaseClaim's default path would
    // unclaim the map. The finish asserts the flag instead of inheriting it.
    assert.ok(!calls.some((c) => c === 'unclaim o/r#147'), 'the restart path unclaimed a map curia never claimed')
  })
})

describe('the two tools a map dispatch refuses', () => {
  test('open_pull_request is refused, and nothing is pushed', async () => {
    const d = makeDispatcher()
    await d.chart('147')
    calls.length = 0
    const reply = await d.openPullRequest('curia-147', { summary: 'x' })
    assert.match(reply, /CHARTING agent/)
    assert.match(reply, /opens no pull request/)
    assert.equal(calls.length, 0, 'the refusal still touched the remote')
    assert.ok(events.some((e) => e.type === 'charting_tool_refused' && e.tool === 'open_pull_request'))
  })

  test('request_review is refused, and no gate is opened', async () => {
    let asked = 0
    const d = makeDispatcher()
    d.askReview = async () => { asked += 1; return { text: 'approve', status: 'answered' } }
    await d.chart('147')
    const r = await d.requestReview('curia-147', { summary: 'x', charting: 'y' })
    assert.equal(r.ok, false)
    assert.match(r.text, /no review gate/)
    assert.equal(asked, 0, 'a review gate was opened for a map dispatch')
  })

  test('an ordinary ticket agent reaches both as before', async () => {
    const d = makeDispatcher({}, { issue: TICKET_ISSUE })
    await d.start('42')
    const reply = await d.openPullRequest('curia-42', { summary: 'x' })
    assert.ok(!/CHARTING/.test(reply))
  })
})

// ---- the dispatch itself ------------------------------------------------------

describe('map <n> — the charting verb (#221)', () => {
  test('the prompt gets the map and the instruction, and the reply says charting', async () => {
    let prompted = null
    const d = makeDispatcher({
      writePrompt: (cfgDir, issue, opts) => { prompted = opts; return path.join(cfgDir, 'prompt.md') },
    })
    const reply = await d.chart('147', { instruction: 'add a ticket for the cooling signal' })
    assert.match(reply, /charting agent on map o\/r#147/)
    assert.match(reply, /on \*\*opus\*\*/)
    assert.equal(prompted.charting, true)
    assert.equal(prompted.mapNumber, 147)
    assert.equal(prompted.instruction, 'add a ticket for the cooling signal')
  })

  // #221's ruling, and the one assertion this file exists to keep: a claim
  // means "off the frontier", and a map is never on one. The claim #160 took
  // said nothing true and made the issue read as worked.
  test('NO DISPATCH CLAIMS THE MAP', async () => {
    const d = makeDispatcher()
    await d.chart('147', { instruction: 'do X' })
    assert.ok(!calls.some((c) => String(c).startsWith('claim')), `the map was claimed: ${calls.join(', ')}`)
    assert.ok(!events.some((e) => e.type === 'dispatch_claimed'), 'a claim that never happened was journalled')
  })

  test('the epoch survives without dispatch_claimed — agent_spawned carries it', async () => {
    // Every epoch reader takes either event, which is what makes dropping the
    // claim line safe: reconcile still finds the map's latest dispatch.
    const d = makeDispatcher()
    await d.chart('147')
    assert.ok(events.some((e) => e.type === 'agent_spawned' && String(e.ticket) === '147'))
  })

  test('a map already assigned is charted anyway — the assignee is not the lock', async () => {
    // A map left assigned by a pre-#221 dispatch, or by an operator's own hand,
    // must not lock charting out forever.
    const d = makeDispatcher({}, { issue: { ...MAP_ISSUE, assignees: [{ login: 'someone' }] } })
    const reply = await d.chart('147')
    assert.match(reply, /charting agent on map/)
  })

  test('the SESSION NAME is the lock: a second charting agent is refused', async () => {
    const d = makeDispatcher()
    await d.chart('147')
    const second = await d.chart('147')
    assert.match(second, /already charting/)
    assert.equal(events.filter((e) => e.type === 'agent_spawned').length, 1)
  })

  test('the lock asks tmux, so it holds with no in-memory record at all', async () => {
    // The restart case. This guard is why removing the claim costs nothing:
    // it survives a daemon that has forgotten the agent it adopted.
    const d = makeDispatcher({ hasSession: async () => true })
    const reply = await d.chart('147')
    assert.match(reply, /already live but untracked/)
    assert.equal(events.filter((e) => e.type === 'agent_spawned').length, 0)
  })

  test('with no instruction the reply says the agent will ask', async () => {
    const d = makeDispatcher()
    const reply = await d.chart('147')
    assert.match(reply, /no instruction rode this dispatch, so it will ask what should change/)
  })

  test('the spawn is journalled with its kind and its instruction', async () => {
    const d = makeDispatcher()
    await d.chart('147', { instruction: 'do X' })
    const spawn = events.find((e) => e.type === 'agent_spawned')
    assert.equal(spawn.kind, 'charting')
    assert.equal(spawn.instruction, 'do X')
  })

  test('map on a NON-map issue is refused, never degraded to a ticket dispatch', async () => {
    // The two verbs mean different things now, so guessing which one was meant
    // is the ambiguity #221 removed.
    const d = makeDispatcher({}, { issue: TICKET_ISSUE })
    const reply = await d.chart('42', { instruction: 'focus on the routing part' })
    assert.match(reply, /not a `wayfinder:map` issue/)
    assert.match(reply, /`start 42` is how a ticket gets worked/)
    assert.equal(calls.length, 0, 'the refused dispatch still touched the tracker')
  })

  test('map on a closed map is refused', async () => {
    const d = makeDispatcher({}, { issue: { ...MAP_ISSUE, state: 'closed' } })
    assert.match(await d.chart('147'), /closed map is not charted/)
  })

  test('a ticket dispatch is journalled as a ticket, and still claims', async () => {
    const d = makeDispatcher({}, { issue: TICKET_ISSUE })
    await d.start('42')
    assert.equal(events.find((e) => e.type === 'agent_spawned').kind, 'ticket')
    assert.ok(calls.includes('claim o/r#42'))
  })
})

// ---- the respawn (#219) -------------------------------------------------------

// A map dispatch that falls down the fallback chain used to lose the fact that
// it was a map dispatch: the respawn wrote `agent_spawned` with the model and
// the harness and nothing else, and #epochCharting keeps the LAST such line. So
// the journal — the belt built for exactly the restart case — ended up
// describing a charting agent as a ticket agent.
//
// Not an edge: while the account holds no fable credits, `map: fable` burns a
// spawn on every map dispatch, so the respawn is the normal path. Measured live
// on 2026-08-04 (`docs/live-checks/183-first-map-dispatch.md`).
describe('a respawn restates the dispatch kind (#219)', () => {
  const CHAIN = {
    defaults: { untyped: 'sonnet', map: 'opus' },
    models: {
      sonnet: { provider: 'anthropic', harness: 'claude' },
      opus: { provider: 'anthropic', harness: 'claude' },
    },
    fallbacks: { opus: ['sonnet'], sonnet: ['opus'] },
    harnesses: ROUTING.harnesses,
  }

  // The first spawn hits a model-scoped cap and the second one is healthy — the
  // shape of every map dispatch on the box today.
  function capOnFirstSpawn() {
    let spawns = 0
    return {
      newSession: async () => { spawns += 1 },
      capturePane: async () => (spawns > 1 ? 'x' : 'Opus usage limit reached | 1800000000'),
    }
  }

  const spawnsOf = () => events.filter((e) => e.type === 'agent_spawned')

  test('the second line says charting, and carries the instruction again', async () => {
    const d = makeDispatcher(capOnFirstSpawn(), { routing: CHAIN })
    await d.chart('147', { instruction: 'do X' })
    await waitFor(() => spawnsOf().length === 2)

    const [first, second] = spawnsOf()
    assert.equal(first.kind, 'charting')
    assert.equal(second.model, 'sonnet', 'the respawn is the point of this test')
    assert.equal(second.retry_after_limit, true)
    assert.equal(second.kind, 'charting', 'the respawn erased the dispatch kind')
    assert.equal(second.instruction, 'do X', 'the respawn erased the operator instruction')
    // A respawn changes the process, not the dispatch, so the id that names the
    // dispatch is restated rather than dropped.
    assert.equal(second.instance, first.instance)
    d.agents.delete('curia-147')
  })

  test('a restarted daemon reading only the journal still holds the map ending', async () => {
    // The whole reason the kind is journalled: with no in-memory record left,
    // `charting: false` here sends a map agent to the ticket ending, which
    // CLOSES the map.
    const d = makeDispatcher(capOnFirstSpawn(), { routing: CHAIN })
    await d.chart('147', { instruction: 'do X' })
    await waitFor(() => spawnsOf().length === 2)
    d.agents.delete('curia-147') // as a restart leaves it
    calls.length = 0

    await d.onResult('curia-147', { ticket: '147', status: 'resolved', summary: 's' })
    assert.ok(!calls.some((c) => String(c).startsWith('CLOSE')), 'the respawned map dispatch was closed as a ticket')
    assert.ok(calls.some((c) => c === 'comment o/r#147'))
    assert.ok(calls.some((c) => String(c).includes('do X')), 'the summary comment lost the operator instruction')
  })

  test('resume after a respawn charts the map, and does not dispatch a child', async () => {
    // #221 made `start <map>` dispatch the map's next takeable child, so a
    // resume that reads `ticket` off the journal does not fail loudly — it
    // quietly works a different issue.
    const d = makeDispatcher({ ...capOnFirstSpawn(), mapFrontier: async () => [] }, { routing: CHAIN })
    await d.chart('147', { instruction: 'do X' })
    await waitFor(() => spawnsOf().length === 2)
    d.agents.delete('curia-147')

    const reply = await d.resume('147')
    assert.match(reply, /charting agent on map o\/r#147/)
    assert.equal(spawnsOf().at(-1).kind, 'charting')
    d.agents.delete('curia-147')
  })

  test('a ticket dispatch respawns as a ticket — the kind is stated, never absent', async () => {
    const d = makeDispatcher(capOnFirstSpawn(), { issue: TICKET_ISSUE, routing: { ...CHAIN, defaults: { untyped: 'opus' } } })
    await d.start('42')
    await waitFor(() => spawnsOf().length === 2)
    assert.equal(spawnsOf()[1].kind, 'ticket')
    assert.equal(spawnsOf()[1].instruction, null)
    d.agents.delete('curia-42')
  })
})

describe('start on a map — the map\'s next takeable ticket (#221)', () => {
  const CHILD = (n, title, extra = {}) => ({
    number: n, title, state: 'open', assignees: [], labels: [{ name: 'wayfinder:task' }], ...extra,
  })

  test('it dispatches the map\'s first takeable child, and charts nothing', async () => {
    let prompted = null
    const d = makeDispatcher({
      mapFrontier: async () => [CHILD(51, 'the second one'), CHILD(43, 'the first one')],
      fetchIssue: async (repo, n) => (String(n) === '147'
        ? { ...MAP_ISSUE }
        : CHILD(Number(n), 'the first one')),
      writePrompt: (cfgDir, issue, opts) => { prompted = opts; return path.join(cfgDir, 'prompt.md') },
    })
    const reply = await d.start('147')
    // ascending issue number — the order `tickets` prints and the auto loop walks
    assert.match(reply, /dispatched o\/r#43/)
    assert.ok(!/charting/.test(reply), 'start still charted a map')
    assert.equal(prompted.charting, false)
    assert.ok(calls.includes('claim o/r#43'), 'the CHILD is claimed, as any ticket is')
    assert.ok(!calls.includes('claim o/r#147'), 'start claimed the map')
    assert.equal(events.find((e) => e.type === 'agent_spawned').kind, 'ticket')
  })

  test('the REPLY names the ticket it picked, and no thread is opened on the map', async () => {
    // The operator typed a map number and gets an agent on a different number.
    // Saying which one, and why, is what keeps that from reading as a fault —
    // and it belongs in the reply, where they typed the command (#218).
    const d = makeDispatcher({
      mapFrontier: async () => [CHILD(43, 'the first one')],
      fetchIssue: async (repo, n) => (String(n) === '147' ? { ...MAP_ISSUE } : CHILD(43, 'the first one')),
    })
    const reply = await d.start('147')
    assert.match(reply, /next takeable ticket of \*\*Curia gets better\*\* is o\/r#43 \*\*the first one\*\*/)
    assert.match(reply, /dispatched o\/r#43/)
    assert.ok(!notifies.some((x) => String(x.ticket) === '147'), 'start on a map opened a thread on the map')
  })

  test('a blocked, claimed or closed child is not takeable', async () => {
    const d = makeDispatcher({
      mapFrontier: async () => [
        CHILD(43, 'claimed', { assignees: [{ login: 'me' }] }),
        CHILD(44, 'blocked', { issue_dependencies_summary: { blocked_by: 1 } }),
        CHILD(45, 'closed', { state: 'closed' }),
        CHILD(46, 'takeable'),
      ],
      fetchIssue: async (repo, n) => (String(n) === '147' ? { ...MAP_ISSUE } : CHILD(46, 'takeable')),
    })
    assert.match(await d.start('147'), /dispatched o\/r#46/)
  })

  test('a child whose session is already live is skipped, not refused', async () => {
    const d = makeDispatcher({
      mapFrontier: async () => [CHILD(43, 'running'), CHILD(44, 'free')],
      fetchIssue: async (repo, n) => (String(n) === '147' ? { ...MAP_ISSUE } : CHILD(44, 'free')),
      hasSession: async (s) => s === 'curia-43',
    })
    assert.match(await d.start('147'), /dispatched o\/r#44/)
  })

  test('an empty frontier refuses and names the OTHER verb', async () => {
    // An operator who typed `start <map>` meaning "update the map" is exactly
    // the operator standing in front of this message.
    const d = makeDispatcher({ mapFrontier: async () => [] })
    const reply = await d.start('147')
    assert.match(reply, /has no takeable ticket/)
    assert.match(reply, /`map 147 -- <what should change>` updates the map itself/)
    assert.equal(events.filter((e) => e.type === 'agent_spawned').length, 0)
  })

  test('a frontier read that fails refuses rather than charting or guessing', async () => {
    const d = makeDispatcher({ mapFrontier: async () => { throw new Error('gh exploded') } })
    const reply = await d.start('147')
    assert.match(reply, /could not read the frontier/)
    assert.match(reply, /gh exploded/)
  })
})

describe('resume on a map', () => {
  test('the instruction that rode the first dispatch rides the resumed one', async () => {
    let prompted = null
    const d = makeDispatcher({
      writePrompt: (cfgDir, issue, opts) => { prompted = opts; return path.join(cfgDir, 'prompt.md') },
    })
    await d.chart('147', { instruction: 'graduate the cooling fog' })
    d.agents.delete('curia-147')
    prompted = null
    await d.resume('147')
    assert.equal(prompted.instruction, 'graduate the cooling fog', 'the resumed charting agent lost the brief')
    assert.equal(prompted.charting, true, 'the resumed map dispatch came back as a ticket one')
  })

  // #221: `resume` names a SESSION, and what that session was doing is a
  // journal fact. Reading it off the issue would send a resumed charting agent
  // to `start`, which on a map number now dispatches a CHILD.
  test('a resumed charting agent is never redirected to a child ticket', async () => {
    const d = makeDispatcher({ mapFrontier: async () => [{ number: 43, title: 'a child', state: 'open', assignees: [], labels: [] }] })
    await d.chart('147')
    d.agents.delete('curia-147')
    calls.length = 0
    const reply = await d.resume('147')
    assert.match(reply, /charting agent on map o\/r#147/)
    assert.ok(!/#43/.test(reply), 'resume of a charting agent dispatched a child ticket')
  })

  test('a map that has since lost its label is refused, and the refusal names start', async () => {
    // There is no map left to chart. Degrading to a ticket dispatch on a body
    // written as a map is the guess #221 removed.
    const d = makeDispatcher()
    await d.chart('147', { instruction: 'do X' })
    d.agents.delete('curia-147')
    const plain = makeDispatcher({ fetchIssue: async () => ({ ...MAP_ISSUE, labels: [] }) })
    plain.dataDir = d.dataDir
    const reply = await plain.resume('147')
    assert.match(reply, /not a `wayfinder:map` issue/)
    assert.match(reply, /`start 147` is how a ticket gets worked/)
  })

  test('an ordinary ticket resume is untouched by any of it', async () => {
    const d = makeDispatcher({}, { issue: TICKET_ISSUE })
    await d.start('42')
    d.agents.delete('curia-42')
    calls.length = 0
    const reply = await d.resume('42')
    assert.match(reply, /dispatched o\/r#42/)
  })
})

describe('cancel on a map dispatch (#221)', () => {
  test('it removes the checkout, claims nothing back, and says the edits stand', async () => {
    const d = makeDispatcher()
    await d.chart('147', { instruction: 'do X' })
    calls.length = 0
    const reply = await d.cancel('147')
    assert.ok(!calls.some((c) => String(c).startsWith('unclaim')), 'cancel unclaimed a map curia never claimed')
    assert.ok(!events.some((e) => e.type === 'unclaim_failed'), 'a claim release that was never owed was journalled as failed')
    assert.match(reply, /the map was never claimed/)
    assert.match(reply, /STANDS/)
  })

  test('an ordinary ticket cancel still releases its claim', async () => {
    const d = makeDispatcher({}, { issue: TICKET_ISSUE })
    await d.start('42')
    calls.length = 0
    const reply = await d.cancel('42')
    assert.ok(calls.some((c) => c === 'unclaim o/r#42'))
    assert.match(reply, /re-frontiered/)
  })
})

// ---- the phone's command surface ----------------------------------------------

// ---- map with no issue: chart a NEW map (#241) --------------------------------
//
// The second shape of the verb, and the first curia agent that no issue answers
// for. What this section pins is the consequence of that, not the parse (which
// commands.test.mjs holds): the identity is a chat handle, the daemon learns the
// map number through `map_created` and CHECKS it, and the ending owes that step.

describe('map with no issue — the new-map dispatch (#241)', () => {
  test('it spawns on a chat handle, claims nothing, and names the handle in the reply', async () => {
    const d = makeDispatcher()
    const reply = await d.chartNew({ repo: 'o/r', instruction: 'chart the next feature', by: 'u' })
    assert.match(reply, /NEW map in o\/r/)
    assert.match(reply, /curia-chat-1/)
    assert.match(reply, /cancel chat-1/)
    assert.ok(d.agents.has('curia-chat-1'))
    const w = d.agents.get('curia-chat-1')
    assert.equal(w.ticket, 'chat-1')
    assert.equal(w.repo, 'o/r')
    assert.equal(w.charting, true)
    assert.equal(w.newMap, true)
    assert.equal(w.mapNumber, null)
    // no claim: there is no issue to assign, and #221's rule holds anyway
    assert.deepEqual(calls.filter((c) => c.startsWith('claim')), [])
  })

  test('the handles ENUMERATE — two new maps chart side by side', async () => {
    const d = makeDispatcher()
    await d.chartNew({ repo: 'o/r', instruction: 'one', by: 'u' })
    await d.chartNew({ repo: 'o/r', instruction: 'two', by: 'u' })
    assert.deepEqual([...d.agents.keys()].sort(), ['curia-chat-1', 'curia-chat-2'])
  })

  test('the free index is read off TMUX, not only off the agents map', async () => {
    // A restarted daemon holds no agents map. Handing chat-1 to a second agent
    // would put two of them on one pane, one config dir and one thread.
    const d = makeDispatcher({ listSessions: async () => ['curia-chat-1', 'curia-9'] })
    await d.chartNew({ repo: 'o/r', instruction: 'one', by: 'u' })
    assert.ok(d.agents.has('curia-chat-2'))
  })

  test('an indeterminate tmux list refuses rather than guessing an index', async () => {
    const d = makeDispatcher({ listSessions: async () => { throw new Error('no server') } })
    const reply = await d.chartNew({ repo: 'o/r', instruction: 'one', by: 'u' })
    assert.match(reply, /indeterminate/)
    assert.equal(d.agents.size, 0)
  })

  test('an unwatched repo and an empty instruction are both refused', async () => {
    const d = makeDispatcher()
    assert.match(await d.chartNew({ repo: 'o/nope', instruction: 'x' }), /not on the watch list/)
    assert.match(await d.chartNew({ repo: 'o/r', instruction: '  ' }), /needs a sentence/)
    assert.equal(d.agents.size, 0)
  })

  test('the spawn is journalled as charting AND as a new map', async () => {
    const d = makeDispatcher()
    await d.chartNew({ repo: 'o/r', instruction: 'chart the next feature', by: 'u' })
    const spawn = events.filter((e) => e.type === 'agent_spawned').at(-1)
    assert.equal(spawn.kind, 'charting')
    assert.equal(spawn.newMap, true)
    assert.equal(spawn.ticket, 'chat-1')
    assert.equal(spawn.instruction, 'chart the next feature')
  })

  test('the routing reads the map row — a new map runs the model an old one does', async () => {
    const d = makeDispatcher()
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    assert.equal(d.agents.get('curia-chat-1').model, 'opus')
  })

  test('no tracker doc refuses the dispatch — a mapless charting agent is the worst case', async () => {
    const d = makeDispatcher({
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
        return wt
      },
    })
    const reply = await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    assert.match(reply, /charting a new map/)
    assert.match(reply, /issue-tracker\.md/)
    assert.equal(d.agents.size, 0)
  })
})

describe('map_created — the daemon learns the number (#241)', () => {
  const MADE = {
    number: 250, title: 'The next feature', state: 'open', assignees: [],
    labels: [{ name: 'wayfinder:map' }],
  }

  test('curia takes the map, journals it, and moves the thread onto it', async () => {
    const moved = []
    const d = makeDispatcher({ fetchIssue: async () => ({ ...MADE }) })
    d.threads = {
      bind: async () => ({ ok: true }),
      release: async () => {},
      cancelled: async () => {},
      adoptMap: async (handle, n, opts) => { moved.push({ handle, n, ...opts }) },
    }
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    const text = await d.adoptMap('curia-chat-1', '250')
    assert.match(text, /o\/r#250/)
    assert.equal(d.agents.get('curia-chat-1').mapNumber, '250')
    assert.deepEqual(moved, [{ handle: 'chat-1', n: '250', repo: 'o/r', title: 'The next feature' }])
    const ev = events.find((e) => e.type === 'map_adopted')
    assert.equal(ev.map, '250')
    assert.equal(ev.ticket, 'chat-1')
  })

  test('the number is CHECKED, never believed', async () => {
    // A record curia writes from an agent's own account is not evidence (#40).
    const cases = [
      [{ ...MADE, state: 'closed' }, /is closed/],
      [{ ...MADE, labels: [{ name: 'wayfinder:task' }] }, /carries no `wayfinder:map` label/],
    ]
    for (const [issue, re] of cases) {
      const d = makeDispatcher({ fetchIssue: async () => ({ ...issue }) })
      await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
      assert.match(await d.adoptMap('curia-chat-1', '250'), re)
      assert.equal(d.agents.get('curia-chat-1').mapNumber, null)
    }
  })

  test('an unreadable issue refuses and says to call again — it never adopts on a failed read', async () => {
    const d = makeDispatcher({ fetchIssue: async () => { throw new Error('gh exploded') } })
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    const text = await d.adoptMap('curia-chat-1', '250')
    assert.match(text, /could not read/)
    assert.match(text, /again/)
    assert.equal(d.agents.get('curia-chat-1').mapNumber, null)
  })

  test('the same number twice is a no-op; a different one is refused', async () => {
    const d = makeDispatcher({ fetchIssue: async () => ({ ...MADE }) })
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    await d.adoptMap('curia-chat-1', '250')
    assert.match(await d.adoptMap('curia-chat-1', '250'), /already taken/)
    assert.match(await d.adoptMap('curia-chat-1', '251'), /already created o\/r#250/)
    assert.equal(d.agents.get('curia-chat-1').mapNumber, '250')
  })

  test('a ticket agent and a map-dispatch agent are both refused', async () => {
    const d = makeDispatcher({ fetchIssue: async () => ({ ...MAP_ISSUE }) })
    await d.chart('147', { repo: 'o/r', instruction: 'x', by: 'u' })
    assert.match(await d.adoptMap('curia-147', '250'), /dispatched on an existing map/)
    assert.match(await d.adoptMap('curia-999', '250'), /holds no record/)
  })

  test('a number that is not one is refused before any read', async () => {
    let read = 0
    const d = makeDispatcher({ fetchIssue: async () => { read += 1; return { ...MADE } } })
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    assert.match(await d.adoptMap('curia-chat-1', 'the map'), /is not one/)
    assert.equal(read, 0)
  })

  test('`#250` is taken — the agent writes the number the way GitHub prints it', async () => {
    const d = makeDispatcher({ fetchIssue: async () => ({ ...MADE }) })
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    await d.adoptMap('curia-chat-1', '#250')
    assert.equal(d.agents.get('curia-chat-1').mapNumber, '250')
  })

  test('the adopted map is LOCKED — `map 250` is refused while the chat runs', async () => {
    const d = makeDispatcher({ fetchIssue: async () => ({ ...MADE }) })
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    await d.adoptMap('curia-chat-1', '250')
    const reply = await d.chart('250', { repo: 'o/r', by: 'u' })
    assert.match(reply, /curia-chat-1/)
    assert.match(reply, /cancel chat-1/)
    assert.ok(!d.agents.has('curia-250'))
  })
})

describe('the new-map ending (#241)', () => {
  test('the checklist owes the map BEFORE the result', () => {
    const items = outstanding({ newMap: true, charting: true, hasResult: false, mapAdopted: false })
    assert.equal(items.length, 2)
    assert.match(items[0], /map_created/)
    assert.match(items[1], /report_result/)
  })

  test('an adopted map clears its step and leaves only the result', () => {
    const items = outstanding({ newMap: true, charting: true, hasResult: false, mapAdopted: true })
    assert.deepEqual(items.map((i) => /map_created/.test(i)), [false])
  })

  test('a reported result ends it, whatever the status — the same rule as every ending', () => {
    assert.deepEqual(outstanding({ newMap: true, charting: true, hasResult: true, mapAdopted: false }), [])
  })

  test('a map dispatch is untouched by any of it', () => {
    const items = outstanding({ charting: true, hasResult: false, mapAdopted: false })
    assert.deepEqual(items.map((i) => /map_created/.test(i)), [false])
  })
})

describe('report_result on a new-map dispatch (#241)', () => {
  const MADE = {
    number: 250, title: 'The next feature', state: 'open', assignees: [],
    labels: [{ name: 'wayfinder:map' }],
  }

  test('the summary lands on the map the agent created, not on the handle', async () => {
    const d = makeDispatcher({ fetchIssue: async () => ({ ...MADE }) })
    await d.chartNew({ repo: 'o/r', instruction: 'chart it', by: 'u' })
    await d.adoptMap('curia-chat-1', '250')
    calls.length = 0
    await d.onResult('curia-chat-1', { status: 'resolved', summary: 'charted the map' })
    assert.ok(calls.includes('comment o/r#250'), `expected a comment on the map, got ${JSON.stringify(calls)}`)
    assert.ok(!calls.some((c) => String(c).startsWith('CLOSE')))
    assert.ok(!calls.some((c) => String(c).startsWith('unclaim')))
  })

  test('a session that created NO map says so instead of posting nowhere', async () => {
    const d = makeDispatcher()
    await d.chartNew({ repo: 'o/r', instruction: 'chart it', by: 'u' })
    calls.length = 0
    const text = await d.onResult('curia-chat-1', { status: 'blocked', summary: 'the way was already clear' })
    assert.match(text, /created NO map/)
    assert.ok(!calls.some((c) => String(c).startsWith('comment')))
    const ev = events.find((e) => e.type === 'charting_finished')
    assert.equal(ev.map, null)
    assert.equal(ev.commented, false)
  })
})

describe('cancel and resume on a chat handle (#241)', () => {
  const MADE = {
    number: 250, title: 'The next feature', state: 'open', assignees: [],
    labels: [{ name: 'wayfinder:map' }],
  }

  test('cancel claims nothing back and says whether a map was left behind', async () => {
    const d = makeDispatcher({ fetchIssue: async () => ({ ...MADE }) })
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    await d.adoptMap('curia-chat-1', '250')
    const msg = await d.cancel('chat-1', { by: 'u' })
    assert.match(msg, /o\/r#250\) STANDS/)
    assert.ok(!calls.some((c) => String(c).startsWith('unclaim')))
    assert.ok(!d.agents.has('curia-chat-1'))
  })

  test('cancel before any map says the tracker is untouched', async () => {
    const d = makeDispatcher()
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    const msg = await d.cancel('chat-1', { by: 'u' })
    assert.match(msg, /created no map yet/)
  })

  test('resume re-dispatches the SAME handle, with the instruction it rode', async () => {
    const d = makeDispatcher()
    await d.chartNew({ repo: 'o/r', instruction: 'read direction.md and chart it', by: 'u' })
    d.agents.delete('curia-chat-1')
    await d.resume('chat-1', { by: 'u' })
    assert.ok(d.agents.has('curia-chat-1'), 'the handle must not be re-picked — its thread and worktree answer to it')
    assert.equal(d.agents.get('curia-chat-1').instruction, 'read direction.md and chart it')
  })

  test('resume after the map exists names `map <n>` instead of charting a second one', async () => {
    const d = makeDispatcher({ fetchIssue: async () => ({ ...MADE }) })
    await d.chartNew({ repo: 'o/r', instruction: 'x', by: 'u' })
    await d.adoptMap('curia-chat-1', '250')
    d.agents.delete('curia-chat-1')
    const reply = await d.resume('chat-1', { by: 'u' })
    assert.match(reply, /already created o\/r#250/)
    assert.match(reply, /map 250 --/)
    assert.equal(d.agents.size, 0)
  })
})

// A restarted daemon and a live chat pane. The fault this pins is the one #228
// pinned for map dispatches: a session GitHub cannot speak for is swept as an
// orphan, killing a charting agent mid-conversation. A chat handle is that case
// permanently — `getIssue(repo, 'chat-1')` is a 404 forever.
describe('reconcile and a live chat session (#241)', () => {
  const MADE = {
    number: 250, title: 'The next feature', state: 'open', assignees: [],
    labels: [{ name: 'wayfinder:map' }],
  }
  const writeJournal = (lines) => {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  test('a spawn line in the journal is the positive evidence — it is adopted, not swept', async () => {
    const killed = []
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: 'chat-1', agent: 'curia-chat-1', kind: 'charting', newMap: true, instruction: 'chart it', model: 'opus', harness: 'claude' },
    ])
    const d = makeDispatcher({
      listSessions: async () => ['curia-chat-1'],
      killSession: async (s) => { killed.push(s) },
    })
    await d.reconcile({ boot: false })
    assert.deepEqual(killed, [])
    const w = d.agents.get('curia-chat-1')
    assert.ok(w, 'the live charting agent was swept instead of adopted')
    assert.equal(w.charting, true)
    assert.equal(w.newMap, true)
    assert.equal(w.instruction, 'chart it')
    assert.equal(w.model, 'opus')
    assert.equal(w.repo, 'o/r')
  })

  test('the map it already created comes back on the record, so the lock holds', async () => {
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: 'chat-1', agent: 'curia-chat-1', kind: 'charting', newMap: true, model: 'opus', harness: 'claude' },
      { type: 'map_adopted', repo: 'o/r', ticket: 'chat-1', agent: 'curia-chat-1', map: '250' },
    ])
    const d = makeDispatcher({ listSessions: async () => ['curia-chat-1'], fetchIssue: async () => ({ ...MADE }) })
    await d.reconcile({ boot: false })
    assert.equal(d.agents.get('curia-chat-1').mapNumber, '250')
    assert.match(await d.chart('250', { repo: 'o/r' }), /curia-chat-1/)
  })

  test('a chat pane no dispatch explains is swept', async () => {
    const killed = []
    writeJournal([{ type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', kind: 'ticket' }])
    const d = makeDispatcher({
      listSessions: async () => ['curia-chat-7'],
      killSession: async (s) => { killed.push(s) },
    })
    await d.reconcile({ boot: false })
    assert.deepEqual(killed, ['curia-chat-7'])
    assert.ok(!d.agents.has('curia-chat-7'))
  })

  test('a CLOSED map sweeps it — the subject is positively finished', async () => {
    const killed = []
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: 'chat-1', agent: 'curia-chat-1', kind: 'charting', newMap: true, model: 'opus', harness: 'claude' },
      { type: 'map_adopted', repo: 'o/r', ticket: 'chat-1', agent: 'curia-chat-1', map: '250' },
    ])
    const d = makeDispatcher({
      listSessions: async () => ['curia-chat-1'],
      fetchIssue: async () => ({ ...MADE, state: 'closed' }),
      killSession: async (s) => { killed.push(s) },
    })
    await d.reconcile({ boot: false })
    assert.deepEqual(killed, ['curia-chat-1'])
  })

  test('an UNREADABLE map neither adopts nor sweeps — a failed read is not evidence', async () => {
    const killed = []
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: 'chat-1', agent: 'curia-chat-1', kind: 'charting', newMap: true, model: 'opus', harness: 'claude' },
      { type: 'map_adopted', repo: 'o/r', ticket: 'chat-1', agent: 'curia-chat-1', map: '250' },
    ])
    const d = makeDispatcher({
      listSessions: async () => ['curia-chat-1'],
      fetchIssue: async () => { throw new Error('gh exploded') },
      killSession: async (s) => { killed.push(s) },
    })
    await d.reconcile({ boot: false })
    assert.deepEqual(killed, [])
    assert.ok(!d.agents.has('curia-chat-1'), 'an indeterminate read must not adopt either')
  })
})

describe('the /map slash expansion', () => {
  const interaction = (commandName, options) => ({
    commandName,
    options: { getString: (name) => options[name] ?? null },
  })

  test('an instruction expands to the same canonical text the overseer writes', () => {
    assert.equal(
      expandCommand(interaction('map', { ticket: '147', instruction: 'add a ticket for X' })),
      'map 147 -- add a ticket for X',
    )
    assert.equal(
      expandCommand(interaction('map', { ticket: '147', model: 'opus', instruction: 'add a ticket for X' })),
      'map 147 model=opus -- add a ticket for X',
    )
  })

  test('no instruction still dispatches — the agent then asks what should change', () => {
    assert.equal(expandCommand(interaction('map', { ticket: '147' })), 'map 147')
    assert.equal(expandCommand(interaction('map', { ticket: '147', instruction: '  ' })), 'map 147')
  })

  // #241 changed what "no ticket" means on this verb: it is now the NEW-map
  // shape, not a stale manifest. So the error is its own kind, and the reply
  // teaches the two shapes instead of telling the operator to restart Discord.
  test('a /map with neither ticket nor instruction is the shape error', () => {
    assert.deepEqual(expandCommand(interaction('map', {})), { error: 'map-shape' })
    assert.deepEqual(expandCommand(interaction('map', { model: 'opus' })), { error: 'map-shape' })
  })

  test('an instruction with NO ticket expands to the new-map shape', () => {
    assert.equal(
      expandCommand(interaction('map', { instruction: 'chart the next feature' })),
      'map -- chart the next feature',
    )
    assert.equal(
      expandCommand(interaction('map', { instruction: 'chart it', repo: 'cur', model: 'opus' })),
      'map cur model=opus -- chart it',
    )
  })

  test('what the phone sends for a NEW map, the router reads back', () => {
    const text = expandCommand(interaction('map', { instruction: 'read direction.md\nand chart it', repo: 'cur' }))
    assert.deepEqual(parseCommand(text), {
      verb: 'map', repoArg: 'cur', instruction: 'read direction.md and chart it',
    })
  })

  // The repo option only means anything on the new-map shape: with a number,
  // the repo is resolved from the number itself. Dropping it there keeps one
  // meaning per option rather than two that disagree.
  test('repo is ignored when a map number is given', () => {
    assert.equal(expandCommand(interaction('map', { ticket: '147', repo: 'cur' })), 'map 147')
  })

  test('what the phone sends, the router reads back', () => {
    const text = expandCommand(interaction('map', { ticket: '147', model: 'opus', instruction: 'chart\nthe fog' }))
    assert.deepEqual(parseCommand(text), {
      verb: 'map', ticket: '147', model: 'opus', instruction: 'chart the fog',
    })
  })

  // #177: the option is gone from the manifest, so a current client cannot send
  // it. A STALE client-side manifest still can, and expansion must not put it
  // back into the canonical text — the round trip above is what would break.
  test('a stale client sending harness= expands to text without it', () => {
    assert.equal(expandCommand(interaction('start', { ticket: '147', harness: 'codex' })), 'start 147')
  })

  // #221 removed `instruction` from /start's manifest. A stale client-side
  // manifest still sends it, and putting it back into the canonical text would
  // expand to a line the router now refuses — the same fault #177 fixed.
  test('a stale client sending instruction= on /start expands to text without it', () => {
    const text = expandCommand(interaction('start', { ticket: '147', instruction: 'update the map' }))
    assert.equal(text, 'start 147')
    assert.deepEqual(parseCommand(text), { verb: 'start', ticket: '147' })
  })
})

// ---- the comment shape --------------------------------------------------------

describe('chartingComment', () => {
  test('it is not marked as machine plumbing — it is the record of the session', () => {
    const body = chartingComment({
      agent: 'curia-147', model: 'opus', instruction: 'do X',
      result: { status: 'resolved', summary: 'did X' },
    })
    assert.ok(!body.includes('curia:machine'))
    assert.match(body, /> do X/)
  })

  test('no instruction is stated as such, never left blank', () => {
    const body = chartingComment({
      agent: 'curia-147', model: 'opus', instruction: null,
      result: { status: 'resolved', summary: 'did X' },
    })
    assert.match(body, /Dispatched with no instruction/)
  })
})

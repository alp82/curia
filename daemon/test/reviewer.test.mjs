// The cross-check reviewer (#164, ADR-0010): a second model reads the diff on
// the other provider and returns a verdict.
//
// Four layers, each tested where it lives:
//   1. the pairing — routing.mjs picks the model, and says whose provider it is
//   2. the table — config.mjs refuses a `review:` row that is not a cross-check
//   3. the orders — the reviewer's prompt and its one-step ending
//   4. the engine — the dispatcher spawns it, refuses its write tools, captures
//      its verdict, and never touches the builder's claim

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Dispatcher, reviewSessionFor } from '../src/dispatch.mjs'
import { resolveReviewer, Cooling, SAME_PROVIDER_STAMP } from '../src/routing.mjs'
import { loadRoutingConfig } from '../src/config.mjs'
import { outstanding, REVIEW_ENDING } from '../src/lifecycle.mjs'
import { writeReviewPrompt } from '../src/workspace.mjs'
import { parseCommand, CommandRouter } from '../src/commands.mjs'
import { TEST_PINS, containerDeps, seedConfigDirStub, withTestCredential } from './fixtures/sandbox.mjs'
import { journalDouble } from './fixtures/journal.mjs'

// Two providers, two harnesses, and the shipped pairing — the shape
// config/routing.yaml carries.
const ROUTING = {
  defaults: { untyped: 'opus' },
  review: { anthropic: 'gpt', openai: 'opus' },
  models: {
    opus: { provider: 'anthropic', harness: 'claude' },
    sonnet: { provider: 'anthropic', harness: 'claude' },
    gpt: { provider: 'openai', harness: 'codex', id: 'gpt-5.6-sol' },
  },
  fallbacks: { opus: ['gpt', 'sonnet'], gpt: ['opus'], sonnet: ['gpt'] },
  harnesses: {
    claude: {
      template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"',
      ready: '⏵⏵', readyRe: /⏵⏵/, toolChannelGraceS: 15,
    },
    codex: {
      template: 'codex --model {model} "$(cat {prompt_file})"',
      ready: '·\\s[~/]', readyRe: /·\s[~/]/, toolChannelGraceS: 20,
    },
  },
}

const OPEN_ISSUE = {
  number: 42, title: 'a ticket', body: 'body text', state: 'open', assignees: [], labels: [],
}

let tmp
let restoreCredential // #195: the model credential the container env file needs
let events
let notifies
const dispatchers = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-reviewer-test-'))
  fs.mkdirSync(path.join(tmp, 'data', 'results'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'data', 'tokens'), { recursive: true, mode: 0o700 })
  events = []
  notifies = []
  restoreCredential = withTestCredential()
})

afterEach(() => {
  // Same rule dispatch.test.mjs runs on: dropping the records ends every
  // detached watch, so a 15 s grace window cannot journal into the next test.
  for (const d of dispatchers) d.agents.clear()
  dispatchers.length = 0
  fs.rmSync(tmp, { recursive: true, force: true })
  restoreCredential()
})

function makeDispatcher(deps = {}, { routing = ROUTING, minter = null } = {}) {
  const root = path.join(tmp, 'work')
  const config = {
    watch: [{ repo: 'o/r', mode: 'auto' }],
    dispatch: {
      auto_dispatch: false, max_concurrent: 4, poll_interval_s: 60,
      workspace_root: root, ready_timeout_s: 45, stop_nudge_budget: 3,
    },
    attach: { ttyd_port: 7681, serve_port: 8443 },
    identity: { allow: ['tester@example.com'], proxy_port: 7682 },
    skills: null,
    // #195: every dispatch prepares a container, so every Dispatcher needs pins
    sandbox: TEST_PINS,
  }
  const dataDir = path.join(tmp, 'data')
  // A REAL journal behind the double. The dispatcher asks its own journal about
  // the past — #epochScan, #epochSpawn and the reviewer adoption pass all do —
  // and those are keyed queries since #408, so what the double writes has to
  // reach the rows the queries read. `events` is the array these tests assert on.
  const double = journalDouble(dataDir)
  const reduction = {
    journal: (type, data) => {
      const rec = double.journal(type, data)
      events.push(rec)
      return rec
    },
    questions: double.questions,
    openEscalations: () => [],
    // #374: no test here records an answered escalation, so the resumed prompt
    // inherits an empty exchange and says nothing about one.
    answeredExchangeFor: () => [],
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
    fetchIssue: async () => ({ ...OPEN_ISSUE }),
    claim: async () => {},
    unclaim: async () => {},
    hasSession: async () => false,
    listSessions: async () => [],
    newSession: async () => {},
    capturePane: async () => '',
    killSession: async () => {},
    ...containerDeps(),
    createPrivateClone: async () => path.join(root, 'wt'),
    removeWorkspace: async () => {},
    removeConfigDir: () => {},
    removeCredentials: () => {},
    seedConfigDir: seedConfigDirStub(),
    writeConnectionSettings: () => {},
    writePrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
    // The reviewer's own two seams. A real directory, because the dispatcher
    // reads it for a planted config file before it arms anything.
    createReviewCheckout: async (r, repo, n) => {
      const p = path.join(r, 'repos', repo.replace('/', '__'), 'review', String(n))
      fs.mkdirSync(p, { recursive: true })
      return { path: p, sha: 'deadbeefcafe0123456789', branch: `curia/${n}`, baseBranch: 'main' }
    },
    writeReviewPrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
    probeTtyd: async () => ({ verified: true }),
    assertServe: async () => {},
    serveOff: async () => {},
    commentIssue: async () => {},
    closeIssue: async () => {},
    setIssueBody: async () => {},
    issueComments: async () => [],
    findPullRequest: async () => null,
    createPullRequest: async () => 'https://github.com/o/r/pull/1',
    defaultBranchOf: async () => 'main',
    commitsOnBranch: async () => [],
    pushBranch: async () => 'abc1234',
    hasUnpushedWork: async () => false,
    setPullRequestBody: async () => {},
    deleteRemoteBranch: async () => ({ deleted: true }),
  }
  const d = new Dispatcher({
    config,
    routing,
    reduction,
    notify: (ticket, message) => notifies.push({ ticket, message }),
    log: () => {},
    dataDir,
    daemonPort: 4271,
    minter,
    deps: { ...base, ...deps },
  })
  dispatchers.push(d)
  return d
}

// A live builder on #42, as the dispatcher's own cache holds one.
function withBuilder(d, over = {}) {
  const w = {
    repo: 'o/r', ticket: '42', session: 'curia-42', title: 'a ticket',
    wtPath: path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42'),
    cfgDir: path.join(tmp, 'work', 'cfg', 'curia-42'),
    model: 'opus', harness: 'claude', provider: 'anthropic', state: 'awaiting-review',
    ...over,
  }
  d.agents.set('curia-42', w)
  return w
}

const typesOf = () => events.map((e) => e.type)

// Poll until `cond` holds — for behaviour that completes inside a detached
// continuation (the readiness watchdog) rather than the awaited call.
async function waitFor(cond, ms = 15_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out waiting for the condition')
}

// ---- 1. the pairing ----------------------------------------------------------

describe('the pairing table (#164)', () => {
  test('an anthropic builder gets gpt, and an openai builder gets opus', () => {
    const cooling = new Cooling()
    assert.deepEqual(
      resolveReviewer(ROUTING, { builderModel: 'opus', labels: [], cooling }),
      { model: 'gpt', wanted: 'gpt', sameProvider: false },
    )
    assert.deepEqual(
      resolveReviewer(ROUTING, { builderModel: 'gpt', labels: [], cooling }),
      { model: 'opus', wanted: 'opus', sameProvider: false },
    )
  })

  test('a review-model: label on the ticket beats the table', () => {
    const r = resolveReviewer(ROUTING, {
      builderModel: 'gpt', labels: ['wayfinder:task', 'review-model:sonnet'], cooling: new Cooling(),
    })
    assert.equal(r.model, 'sonnet', 'the label names the model, and the table does not overrule it')
    assert.equal(r.sameProvider, false, 'sonnet is anthropic and the builder was openai')
  })

  test('a label naming a model that is not configured refuses by name', () => {
    assert.throws(
      () => resolveReviewer(ROUTING, { builderModel: 'opus', labels: ['review-model:nope'], cooling: new Cooling() }),
      /review-model:nope/,
    )
  })

  test('a provider with no row refuses, naming the key that would fix it', () => {
    const noTable = { ...ROUTING, review: {} }
    assert.throws(
      () => resolveReviewer(noTable, { builderModel: 'opus', labels: [], cooling: new Cooling() }),
      /no cross-check pairing for provider "anthropic"/,
    )
  })

  test('the paired model cooling falls to another model on the other provider first', () => {
    // A three-model shape where the other provider has a second warm model, so
    // "cross-provider first" is testable at all.
    const routing = {
      ...ROUTING,
      models: { ...ROUTING.models, gpt2: { provider: 'openai', harness: 'codex' } },
      fallbacks: { ...ROUTING.fallbacks, gpt: ['gpt2', 'opus'] },
    }
    const cooling = new Cooling()
    cooling.coolModel('gpt', new Date(Date.now() + 3600_000))
    const r = resolveReviewer(routing, { builderModel: 'opus', labels: [], cooling })
    assert.equal(r.model, 'gpt2')
    assert.equal(r.sameProvider, false, 'still a cross-check — a warm sibling on the other provider')
  })

  test('every model on the other provider cooling falls back to the builder\'s own, and says so', () => {
    const cooling = new Cooling()
    cooling.coolProvider('openai', new Date(Date.now() + 3600_000))
    const r = resolveReviewer(ROUTING, { builderModel: 'opus', labels: [], cooling })
    assert.equal(r.model, 'opus', 'the builder\'s own provider, per ADR-0010')
    assert.equal(r.sameProvider, true, 'the flag the verdict stamp hangs off')
  })

  test('both providers cooling refuses rather than picking a cooling model', () => {
    const cooling = new Cooling()
    const at = new Date(Date.now() + 3600_000)
    cooling.coolProvider('openai', at)
    cooling.coolProvider('anthropic', at)
    assert.throws(
      () => resolveReviewer(ROUTING, { builderModel: 'opus', labels: [], cooling }),
      /every configured model is cooling/,
    )
  })
})

// ---- 2. the table in config --------------------------------------------------

describe('the `review:` section in routing.yaml (#164)', () => {
  const lines = (review) => [
    'defaults:',
    '  untyped: opus',
    ...review,
    'models:',
    '  opus: { provider: anthropic, harness: claude }',
    '  gpt: { provider: openai, harness: codex, id: gpt-5.6-sol }',
    'harnesses:',
    "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', ready: 'x', tool_channel_grace_s: 15 }",
    "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', ready: 'y', tool_channel_grace_s: 20 }",
  ]
  const load = (review) => {
    const file = path.join(tmp, 'routing.yaml')
    fs.writeFileSync(file, lines(review).join('\n'))
    return loadRoutingConfig(file)
  }

  test('the shipped shape loads, keyed by the builder\'s provider', () => {
    const cfg = load(['review:', '  anthropic: gpt', '  openai: opus'])
    assert.deepEqual(cfg.review, { anthropic: 'gpt', openai: 'opus' })
  })

  test('omitting it is legal and yields an empty table', () => {
    assert.deepEqual(load([]).review, {})
  })

  test('a row pairing a provider with itself is refused — that is not a cross-check', () => {
    assert.throws(() => load(['review:', '  anthropic: opus']), /runs on anthropic itself/)
  })

  test('a row naming an unknown model is refused', () => {
    assert.throws(() => load(['review:', '  anthropic: nope']), /unknown model "nope"/)
  })

  test('a row naming a provider no model runs on is refused', () => {
    assert.throws(() => load(['review:', '  mistral: gpt']), /no configured model runs on/)
  })
})

// ---- 3. the standing orders --------------------------------------------------

describe('the reviewer\'s standing orders (#164)', () => {
  test('the ending is one step, and it is the verdict', () => {
    assert.equal(REVIEW_ENDING.length, 1)
    assert.deepEqual(outstanding({ reviewer: true, hasResult: false }), [
      'call `report_result` once, with your verdict as the summary',
    ])
    assert.deepEqual(outstanding({ reviewer: true, hasResult: true }), [], 'the verdict ends it')
  })

  test('the prompt orders a read-and-run-tests pass that writes nothing', () => {
    const cfgDir = path.join(tmp, 'cfg')
    fs.mkdirSync(cfgDir, { recursive: true })
    const file = writeReviewPrompt(cfgDir, OPEN_ISSUE, {
      repo: 'o/r', wtPath: '/workspace', branch: 'curia/42', baseBranch: 'main',
      sha: 'deadbeefcafe0123456789', model: 'gpt-5.6-sol', builderModel: 'opus',
    })
    const text = fs.readFileSync(file, 'utf8')

    assert.match(text, /CROSS-CHECK REVIEWER/)
    assert.match(text, /DETACHED HEAD at `deadbeefcafe`/, 'the sha it reads, named in the prompt')
    assert.match(text, /git diff origin\/main\.\.\.HEAD/, 'the diff command, so it does not guess one')
    assert.match(text, /Run the tests/)
    assert.match(text, /Write nothing/)
    assert.match(text, /No tracker write/)
    assert.match(text, /VERDICT: pass \| concerns \| fail/, 'the shape the return path reads')
    assert.match(text, /report_result/)
    // The two things a reviewer must not inherit from a builder's prompt.
    assert.ok(!text.includes('/wayfinder'), 'a reviewer works through no map and resolves no ticket')
    // `request_review` appears exactly once, as a refusal — never as a step.
    assert.match(text, /curia refuses `open_pull_request`, `request_review`/)
    assert.equal(text.split('request_review').length - 1, 1)
  })
})

// ---- 4. the engine -----------------------------------------------------------

describe('Dispatcher.crossCheck (#164)', () => {
  test('spawns curia-review-<n> on the other provider, claims nothing, and journals the spawn', async () => {
    const spawned = []
    let claims = 0
    const d = makeDispatcher({
      newSession: async (opts) => { spawned.push(opts.name) },
      claim: async () => { claims += 1 },
    })
    withBuilder(d)

    const reply = await d.crossCheck('42', { by: 'test' })

    assert.match(reply, /cross-checking o\/r#42/)
    assert.deepEqual(spawned, ['curia-review-42'], 'a name of its own, distinct from curia-42')
    assert.equal(claims, 0, 'the builder holds the ticket\'s only claim')
    assert.ok(d.agents.has('curia-42'), 'the builder is untouched')
    const spawn = events.find((e) => e.type === 'reviewer_spawned')
    assert.equal(spawn.agent, 'curia-review-42')
    assert.equal(spawn.model, 'gpt', 'an anthropic builder is read by gpt')
    assert.equal(spawn.builder_model, 'opus')
    assert.equal(spawn.same_provider, false)
    // The status line and the timeline both draw off agent_spawned, so the
    // reviewer gets its own line in the ticket thread (ADR-0010).
    const drawn = events.find((e) => e.type === 'agent_spawned' && e.agent === 'curia-review-42')
    assert.equal(drawn.kind, 'reviewer')
    assert.equal(drawn.ticket, '42')
  })

  test('a reviewer mints the READ set, where its builder mints write (#389)', async () => {
    // ADR-0010 gives the reviewer a detached checkout, no branch and no tracker
    // write, and curia posts its verdict for it. One key and two sets is what
    // the GitHub App bought (ADR-0018), so a reviewer holding push rights it
    // never uses is exactly the reach the app exists to end.
    const calls = []
    const minter = { tokenFor: async (owner, role) => { calls.push({ owner, role }); return 'ghs_minted' } }
    const d = makeDispatcher({}, { minter })
    withBuilder(d)

    await d.crossCheck('42', { by: 'test' })

    assert.deepEqual(calls, [{ owner: 'o', role: 'read' }])
    // and the refresh keeps reading it that way for the rest of the reviewer's
    // life — an adopted reviewer must not be re-armed with write
    calls.length = 0
    await d.refreshGhCredentials()
    assert.deepEqual(calls, [{ owner: 'o', role: 'read' }])
  })

  test('`model=` overrides the table, and a second press is refused while one reads', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    await d.crossCheck('42', { model: 'sonnet' })
    assert.equal(d.agents.get('curia-review-42').model, 'sonnet')
    assert.match(await d.crossCheck('42'), /already reading/)
  })

  test('the cooling fallback runs on the builder\'s own provider and stamps the verdict', async () => {
    const d = makeDispatcher()
    d.cooling.coolProvider('openai', new Date(Date.now() + 3600_000))
    withBuilder(d)

    const reply = await d.crossCheck('42')
    assert.match(reply, new RegExp(SAME_PROVIDER_STAMP))
    assert.equal(d.agents.get('curia-review-42').sameProvider, true)

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    const held = d.verdictFor('42')
    assert.equal(held.same_provider, true)
    assert.ok(held.verdict.startsWith(`**${SAME_PROVIDER_STAMP}**`), 'the stamp sits at the top of the text')
    assert.match(held.verdict, /VERDICT: pass/)
  })

  test('unpushed builder commits refuse the cross-check rather than reviewing another diff', async () => {
    const wt = path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42')
    fs.mkdirSync(wt, { recursive: true })
    const spawned = []
    const d = makeDispatcher({
      hasUnpushedWork: async () => true,
      newSession: async (o) => spawned.push(o.name),
    })
    withBuilder(d, { wtPath: wt })

    const reply = await d.crossCheck('42')
    assert.match(reply, /commits that are on no remote/)
    assert.match(reply, /open_pull_request/)
    assert.deepEqual(spawned, [], 'nothing was spawned')
  })

  test('an indeterminate unpushed check refuses too — the evidence rule', async () => {
    const wt = path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42')
    fs.mkdirSync(wt, { recursive: true })
    const d = makeDispatcher({ hasUnpushedWork: async () => { throw new Error('git is wedged') } })
    withBuilder(d, { wtPath: wt })
    assert.match(await d.crossCheck('42'), /could not tell whether #42 holds unpushed commits/)
  })

  test('a ticket curia has no dispatch record for is refused: there is no other provider to name', async () => {
    const d = makeDispatcher()
    assert.match(await d.crossCheck('42', { repo: 'o/r' }), /no record of what #42 was built on/)
  })

  test('a failed checkout leaves the builder alone and says so', async () => {
    const d = makeDispatcher({
      createReviewCheckout: async () => { throw new Error('origin carries no `curia/42`') },
    })
    withBuilder(d)
    const reply = await d.crossCheck('42')
    assert.match(reply, /could not start/)
    assert.match(reply, /the builder is untouched/)
    assert.equal(d.agents.has('curia-review-42'), false)
    assert.ok(typesOf().includes('reviewer_spawn_failed'))
  })
})

describe('the reviewer writes nothing (#164)', () => {
  test('every write tool is refused by name, and the builder\'s are not', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    await d.crossCheck('42')

    for (const tool of ['open_pull_request', 'request_review', 'publish_preview', 'ask_human']) {
      const refusal = d.toolRefusal('curia-review-42', tool)
      assert.match(refusal, /CROSS-CHECK REVIEWER/, `${tool} must be refused`)
      assert.match(refusal, new RegExp(tool))
    }
    assert.equal(d.toolRefusal('curia-42', 'open_pull_request'), null, 'the builder keeps every tool')

    // Through the real entry points, not only the helper: these are the two that
    // push and gate, and both must refuse before they reach the branch.
    assert.match(await d.openPullRequest('curia-review-42', { summary: 'x' }), /Nothing was pushed/)
    const gate = await d.requestReview('curia-review-42', { summary: 'x', charting: 'none' })
    assert.equal(gate.ok, false)
    assert.match(gate.text, /CROSS-CHECK REVIEWER/)
    assert.ok(events.filter((e) => e.type === 'reviewer_tool_refused').length >= 6)
  })

  test('the refusal holds after a restart, when the record is gone', () => {
    const d = makeDispatcher()
    assert.match(d.toolRefusal('curia-review-42', 'ask_human'), /CROSS-CHECK REVIEWER/)
  })

  test('the Stop hook holds a reviewer only until the verdict, and asks for nothing else', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    await d.crossCheck('42')
    // #194's mute backstop outranks the checklist for an agent that never spoke,
    // and a real reviewer speaks: its MCP client connects at startup.
    d.onMcpCall('curia-review-42')

    const blocked = await d.onStopHook('curia-review-42')
    assert.equal(blocked.decision, 'block')
    assert.match(blocked.reason, /report_result/)
    assert.ok(!/pull request/.test(blocked.reason), 'a reviewer is never nudged toward the builder\'s ending')

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    assert.deepEqual(await d.onStopHook('curia-review-42'), { allow: true, terminal: true })
  })
})

describe('the verdict is a captured artifact (#164)', () => {
  test('report_result writes it to disk, journals it, and resolves nothing', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    await d.crossCheck('42')

    const text = await d.onResult('curia-review-42', {
      ticket: 'o/r#42', status: 'resolved', summary: 'VERDICT: concerns\n\nFINDINGS:\n- a.mjs:7 — off by one',
    })

    assert.match(text, /verdict captured/)
    const file = path.join(tmp, 'data', 'verdicts', '42.json')
    const held = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(held.repo, 'o/r')
    assert.equal(held.ticket, '42')
    assert.equal(held.model, 'gpt')
    assert.equal(held.same_provider, false)
    assert.match(held.verdict, /off by one/)
    assert.ok(!held.verdict.startsWith('**'), 'a real cross-provider reading carries no stamp')
    assert.ok(typesOf().includes('verdict_captured'))
    // The ticket path must not have run: nothing resolved, closed or commented.
    for (const t of ['ticket_resolved', 'nonclean_noted', 'resolve_skipped']) {
      assert.ok(!typesOf().includes(t), `${t} belongs to a ticket agent`)
    }
    assert.match(notifies.at(-1).message, /cross-check verdict/)
  })

  test('verdictFor reads the artifact back when the memory cache is empty', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    await d.crossCheck('42')
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })

    d.verdicts.clear()
    assert.match(d.verdictFor('42').verdict, /VERDICT: pass/, 'the artifact is what survives a restart')
    assert.equal(d.verdictFor('99'), null)
  })

  test('a reviewer that ends without a verdict keeps its pane and changes nothing', async () => {
    const killed = []
    const d = makeDispatcher({ killSession: async (n) => killed.push(n) })
    withBuilder(d)
    await d.crossCheck('42')

    await d.onAgentDone('curia-review-42')

    assert.deepEqual(killed, [], 'the pane is the post-mortem evidence')
    assert.ok(typesOf().includes('reviewer_abnormal_exit'))
    assert.match(notifies.at(-1).message, /WITHOUT a verdict/)
    assert.ok(d.agents.has('curia-42'), 'the builder is untouched')
  })
})

describe('a reviewer never touches the builder\'s claim (#164)', () => {
  test('cancelling the ticket ends both agents', async () => {
    const killed = []
    const unclaimed = []
    const d = makeDispatcher({
      killSession: async (n) => killed.push(n),
      unclaim: async (repo, t) => unclaimed.push(`${repo}#${t}`),
    })
    withBuilder(d)
    await d.crossCheck('42')

    const reply = await d.cancel('42', { by: 'test' })

    assert.deepEqual(killed, ['curia-review-42', 'curia-42'])
    assert.deepEqual(unclaimed, ['o/r#42'], 'exactly one claim, released once')
    assert.match(reply, /cancelled too/)
    assert.equal(d.agents.size, 0)
  })

  test('cancel reaches a reviewer whose builder is already gone', async () => {
    const killed = []
    const live = new Set()
    const d = makeDispatcher({
      killSession: async (n) => killed.push(n),
      hasSession: async (n) => live.has(n),
    })
    withBuilder(d)
    await d.crossCheck('42')
    // The builder finished first: its record and its pane are gone, and only the
    // untracked reviewer pane is left.
    d.agents.delete('curia-42')
    d.agents.delete('curia-review-42')
    live.add('curia-review-42')

    const reply = await d.cancel('42', { by: 'test' })
    assert.match(reply, /cancelled too/)
    assert.deepEqual(killed, ['curia-review-42'])
    assert.ok(typesOf().includes('reviewer_cancelled'))
  })

  test('a reviewer whose respawn fails is given up on, and #42 is never unclaimed', async () => {
    const unclaimed = []
    let spawns = 0
    const d = makeDispatcher({
      unclaim: async (repo, t) => unclaimed.push(`${repo}#${t}`),
      // The second spawn is the respawn down the fallback chain. Failing it
      // drives the reviewer into #releaseClaim — the one path where a
      // cross-check could have released a live builder's ticket.
      newSession: async () => { spawns += 1; if (spawns > 1) throw new Error('tmux is wedged') },
      capturePane: async () => "You've hit your usage limit.",
    })
    withBuilder(d)
    await d.crossCheck('42')

    await waitFor(() => events.some((e) => e.type === 'reviewer_ended'))

    assert.deepEqual(unclaimed, [], 'the builder holds the claim, and it keeps it')
    assert.equal(d.agents.has('curia-42'), true, 'the builder is untouched')
    assert.equal(d.agents.has('curia-review-42'), false)
    assert.match(notifies.at(-1).message, /the builder and its claim are untouched/)
    assert.ok(!typesOf().includes('dispatch_unclaimed'))
    assert.ok(!typesOf().includes('unclaim_failed'))
  })

  // #346 arms a limit resume on true exhaustion, and a reviewer is the one
  // agent it must not arm one for: #releaseClaim has already unparked the
  // builder with "the reviewer ended", so a resumed reviewer would read the
  // same diff twice and land a verdict on a builder that stopped waiting.
  test('a reviewer that exhausts every lane arms no limit resume', async () => {
    const d = makeDispatcher({ capturePane: async () => "You've hit your usage limit." })
    withBuilder(d)
    // The builder's own provider is already cooling, so the reviewer's chain
    // has nowhere left to fall when its cap lands.
    d.cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))
    await d.crossCheck('42')

    await waitFor(() => events.some((e) => e.type === 'reviewer_ended'))

    assert.ok(!typesOf().includes('limit_resume_armed'), 'nothing may resume a reviewer')
    assert.equal(d.limitResumes.size, 0)
    assert.ok(typesOf().includes('dispatch_exhausted'), 'the exhaustion itself is still journalled and said')
  })

  test('a dead reviewer says so and leaves the builder working', async () => {
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      hasSession: async (n) => n === 'curia-42',
    })
    withBuilder(d)
    await d.crossCheck('42')

    await d.livenessSweep()

    assert.equal(d.agents.has('curia-review-42'), false)
    assert.ok(d.agents.has('curia-42'), 'the builder is untouched')
    assert.ok(events.some((e) => e.type === 'agent_died' && e.kind === 'reviewer'))
    assert.match(notifies.at(-1).message, /left NO verdict/)
  })
})

describe('reconcile and the reviewer (#164)', () => {
  test('a live reviewer is re-adopted from the journal, so its verdict still lands', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    await d.crossCheck('42')
    // What a daemon restart leaves behind: the pane and the journal on disk.
    d.agents.clear()

    const adopted = makeDispatcher({
      listSessions: async () => ['curia-review-42'],
      hasSession: async () => true,
    })
    await adopted.reconcile({ boot: true })

    const w = adopted.agents.get('curia-review-42')
    assert.ok(w, 'adopted')
    assert.equal(w.reviewer, true)
    assert.equal(w.ticket, '42')
    assert.equal(w.repo, 'o/r')
    assert.equal(w.model, 'gpt')

    await adopted.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    assert.match(adopted.verdictFor('42').verdict, /VERDICT: pass/)
  })

  test('a live reviewer the journal cannot describe is swept, not adopted', async () => {
    const killed = []
    const d = makeDispatcher({
      killSession: async (n) => killed.push(n),
      listSessions: async () => ['curia-review-7'],
    })
    await d.reconcile({ boot: false })
    assert.deepEqual(killed, ['curia-review-7'])
    assert.equal(d.agents.has('curia-review-7'), false)
    assert.ok(typesOf().includes('orphan_reviewer_swept'))
  })
})

// ---- 5. the entry point ------------------------------------------------------

describe('the `review` verb (#164)', () => {
  test('parses a ticket and an optional model, and refuses anything else', () => {
    assert.deepEqual(parseCommand('review 42'), { verb: 'review', ticket: '42' })
    assert.deepEqual(parseCommand('review 42 model=sonnet'), { verb: 'review', ticket: '42', model: 'sonnet' })
    assert.equal(parseCommand('review'), null)
    assert.equal(parseCommand('review all'), null)
    assert.equal(parseCommand('review 42 harness=codex'), null, 'the harness follows the model, never the operator')
  })

  test('the router hands it to crossCheck', async () => {
    const calls = []
    const router = new CommandRouter({
      dispatcher: { config: { watch: [] }, routing: ROUTING, crossCheck: async (n, o) => { calls.push([n, o]); return 'ok' } },
      attach: {},
      log: () => {},
    })
    assert.equal(await router.handle('review 42 model=sonnet', 'alp'), 'ok')
    assert.deepEqual(calls, [['42', { model: 'sonnet', by: 'alp' }]])
  })

  test('the attach reply adds the reviewer only while one is live', async () => {
    const attach = {
      link: async (t, { session = `curia-${t}` } = {}) => `https://box/?arg=${session}`,
      timelineLink: async (t, { session = `curia-${t}` } = {}) => `https://box/timeline/${session}`,
    }
    const make = (reviewer) => new CommandRouter({
      dispatcher: { config: { watch: [] }, routing: ROUTING, reviewerSession: () => reviewer },
      attach,
      log: () => {},
    })
    const without = await make(null).handle('attach 42', 'alp')
    assert.ok(!without.includes('curia-review-42'), 'no reviewer ⇒ the reply is unchanged')
    const with_ = await make('curia-review-42').handle('attach 42', 'alp')
    assert.match(with_, /cross-check reviewer/)
    assert.match(with_, /arg=curia-review-42/)
    assert.match(with_, /timeline\/curia-review-42/)
  })
})

test('the session name is the reviewer\'s identity, and it is not the builder\'s', () => {
  assert.equal(reviewSessionFor('42'), 'curia-review-42')
  assert.notEqual(reviewSessionFor('42'), 'curia-42')
})

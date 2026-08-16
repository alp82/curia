// The cross-check button and the verdict's way back (#165, ADR-0010): the
// operator half of the feature whose engine #164 built.
//
// Five layers, each tested where it lives:
//   1. the button — the gate renders a third one, and the word it sends
//   2. the press — the gate call spawns the reviewer and PARKS the builder
//   3. the way back — verdict → pull-request comment → note queue → the parked call
//   4. the judgement — the builder's question lands as the second comment
//   5. the orders — the duty is in the builder's prompt, one copy, one wording

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Dispatcher } from '../src/dispatch.mjs'
import {
  classifyReviewAnswer, CROSS_CHECK_ANSWER, CROSS_CHECK_DUTY, dutyLines, outstanding, REVIEW_KIND,
} from '../src/lifecycle.mjs'
import { verdictComment, judgementComment, verdictNote } from '../src/resolve.mjs'
import { writePrompt, STANDING_FILE } from '../src/workspace.mjs'
import { DiscordBridge } from '../src/bridge.mjs'
import { StatusLine } from '../src/statusline.mjs'
import { TEST_PINS, containerDeps, seedConfigDirStub, withTestCredential } from './fixtures/sandbox.mjs'

const ROUTING = {
  defaults: { untyped: 'opus' },
  review: { anthropic: 'gpt', openai: 'opus' },
  models: {
    opus: { provider: 'anthropic', harness: 'claude' },
    gpt: { provider: 'openai', harness: 'codex', id: 'gpt-5.6-sol' },
  },
  fallbacks: { opus: ['gpt'], gpt: ['opus'] },
  harnesses: {
    claude: { template: 'claude {model} {prompt_file}', ready: '⏵⏵', readyRe: /⏵⏵/, toolChannelGraceS: 15 },
    codex: { template: 'codex {model} {prompt_file}', ready: '·', readyRe: /·/, toolChannelGraceS: 20 },
  },
}

const OPEN_ISSUE = { number: 42, title: 'a ticket', body: 'body text', state: 'open', assignees: [], labels: [] }

let tmp
let restoreCredential // #195: the model credential the container env file needs
let events
let notifies
let notes
let comments
const dispatchers = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-crosscheck-test-'))
  fs.mkdirSync(path.join(tmp, 'data', 'results'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'data', 'tokens'), { recursive: true, mode: 0o700 })
  events = []
  notifies = []
  notes = []
  comments = []
  restoreCredential = withTestCredential()
})

afterEach(() => {
  for (const d of dispatchers) d.agents.clear()
  dispatchers.length = 0
  fs.rmSync(tmp, { recursive: true, force: true })
  restoreCredential()
})

const typesOf = () => events.map((e) => e.type)

function makeDispatcher(deps = {}, { askReview } = {}) {
  const root = path.join(tmp, 'work')
  const dataDir = path.join(tmp, 'data')
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
  const store = {
    logEvent: (type, data) => {
      const rec = { type, ts: new Date().toISOString(), ...data }
      events.push(rec)
      fs.appendFileSync(path.join(dataDir, 'events.jsonl'), `${JSON.stringify(rec)}\n`)
      return rec
    },
    openEscalations: () => [],
    cancel: () => ({ ok: true }),
    expireAgentNotes: () => 0,
    queueAgentNote: (agent, text, opts) => { notes.push({ agent, text, ...opts }); return { after: null } },
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
    createReviewCheckout: async (r, repo, n) => {
      const p = path.join(r, 'repos', repo.replace('/', '__'), 'review', String(n))
      fs.mkdirSync(p, { recursive: true })
      return { path: p, sha: 'deadbeefcafe0123456789', branch: `curia/${n}`, baseBranch: 'main' }
    },
    writeReviewPrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
    probeTtyd: async () => ({ verified: true }),
    assertServe: async () => {},
    serveOff: async () => {},
    commentIssue: async (repo, n, body) => { comments.push({ repo, n: String(n), body }) },
    closeIssue: async () => {},
    setIssueBody: async () => {},
    issueComments: async () => [],
    findPullRequest: async () => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }),
    createPullRequest: async () => 'https://github.com/o/r/pull/7',
    defaultBranchOf: async () => 'main',
    commitsOnBranch: async () => [],
    pushBranch: async () => 'abc1234',
    hasUnpushedWork: async () => false,
    setPullRequestBody: async () => {},
    deleteRemoteBranch: async () => ({ deleted: true }),
  }
  const d = new Dispatcher({
    config,
    routing: ROUTING,
    store,
    notify: (ticket, message) => notifies.push({ ticket, message }),
    askReview: askReview ?? (async () => ({ text: CROSS_CHECK_ANSWER, status: 'answered' })),
    log: () => {},
    dataDir,
    daemonPort: 4271,
    deps: { ...base, ...deps },
  })
  dispatchers.push(d)
  return d
}

function withBuilder(d, over = {}) {
  const w = {
    repo: 'o/r', ticket: '42', session: 'curia-42', title: 'a ticket',
    instance: 'curia-42@1000',
    wtPath: path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42'),
    cfgDir: path.join(tmp, 'work', 'cfg', 'curia-42'),
    model: 'opus', harness: 'claude', provider: 'anthropic', state: 'working',
    ...over,
  }
  d.agents.set('curia-42', w)
  return w
}

async function waitFor(cond, ms = 15_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out waiting for the condition')
}

// The press, from the gate call, up to the moment the builder is parked. Every
// return-path test starts here.
//
// The promise is returned WRAPPED: an async function that returns a promise
// adopts it, which would make every caller wait for the very call this helper
// exists to leave open.
async function pressAndPark(d) {
  const gate = d.requestReview('curia-42', { summary: 's', charting: 'none' })
  await waitFor(() => d.reviewWaits.has('42'))
  return { gate }
}

// ---- 1. the button -----------------------------------------------------------

describe('the third button (#165)', () => {
  let bridge, sent

  beforeEach(() => {
    sent = []
    const thread = {
      id: 'T', name: '🎫 t', send: async (p) => { sent.push(p); return { id: 'M', edit: async () => {} } },
    }
    bridge = new DiscordBridge({ token: 'x', allowedUsers: [], dataDir: tmp, handlers: {}, log: () => {} })
    bridge.channel = { id: 'C' }
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
  })

  const render = async (record) => {
    await bridge.renderEscalation(record)
    return sent.at(-1)
  }

  test('the review gate carries approve, reject and cross-check, in that order', async () => {
    const msg = await render({ id: 'esc-3', ticket: '42', agent: 'curia-42', kind: REVIEW_KIND, prompt: 'done?' })
    const ids = msg.components.flatMap((r) => r.components.map((c) => c.data.custom_id))
    assert.deepEqual(ids, ['esc|esc-3|opt|approve', 'esc|esc-3|opt|reject', `esc|esc-3|opt|${CROSS_CHECK_ANSWER}`])
  })

  test('the gate text says what the third button does — it answers neither way', async () => {
    const msg = await render({ id: 'esc-3', ticket: '42', agent: 'curia-42', kind: REVIEW_KIND, prompt: 'done?' })
    assert.match(msg.content, /Cross-check answers neither/)
    assert.match(msg.content, /other provider/)
  })

  test('a plain approve-reject question keeps two buttons — this is a button on the GATE', async () => {
    const msg = await render({ id: 'esc-4', ticket: '42', agent: 'curia-42', kind: 'approve-reject', prompt: 'ok?' })
    const ids = msg.components.flatMap((r) => r.components.map((c) => c.data.custom_id))
    assert.deepEqual(ids, ['esc|esc-4|opt|approve', 'esc|esc-4|opt|reject'],
      'ADR-0010 adds a button to the gate, not a new escalation kind')
  })

  test('the word is classified as neither an approval nor a rejection', () => {
    assert.deepEqual(classifyReviewAnswer(CROSS_CHECK_ANSWER), { approved: false, crossCheck: true, feedback: '' })
    // The operator may type it instead of pressing it.
    for (const typed of ['cross-check', 'Cross Check', 'crosscheck', '  CROSS-CHECK  ']) {
      assert.equal(classifyReviewAnswer(typed).crossCheck, true, `${typed} means the button`)
    }
    assert.equal(classifyReviewAnswer('approve').crossCheck, false)
    assert.equal(classifyReviewAnswer('cross-check the parser first').crossCheck, false,
      'a sentence that mentions it is a rejection carrying words')
    assert.equal(classifyReviewAnswer('cross-check the parser first').feedback, 'cross-check the parser first')
  })
})

// ---- 2. the press ------------------------------------------------------------

describe('the press spawns the reviewer and parks the builder (#165)', () => {
  test('the gate call does not return: the builder waits, idle, holding its claim', async () => {
    const unclaimed = []
    const d = makeDispatcher({ unclaim: async (r, t) => unclaimed.push(`${r}#${t}`) })
    const w = withBuilder(d)
    const { gate } = await pressAndPark(d)

    assert.ok(d.agents.has('curia-review-42'), 'the reviewer holds the second slot')
    assert.ok(d.agents.has('curia-42'), 'the builder keeps its own')
    assert.equal(w.state, 'cross-checking')
    assert.deepEqual(unclaimed, [], 'the builder holds the ticket\'s only claim throughout')
    assert.ok(typesOf().includes('cross_check_requested'))
    assert.match(notifies.map((n) => n.message).join('\n'), /idle at the gate/)

    // Nothing has come back yet — the call is genuinely still open.
    let settled = false
    gate.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(settled, false)

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    await gate
  })

  test('the answer is journalled as a cross-check, and nothing counts as an approval', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    const r = await gate

    const answered = events.find((e) => e.type === 'review_answered')
    assert.equal(answered.approved, false)
    assert.equal(answered.outcome, 'cross-check')
    assert.equal(r.approved, false)
    assert.equal(r.crossCheck, true)
    assert.ok(!/APPROVED/.test(r.text), 'nothing merges on a cross-check')
    assert.ok(!/NOT approved/.test(r.text), 'and nothing is rejected either')
  })

  test('the button is pressable on every round — a rejection then a press is one loop', async () => {
    const answers = ['fix the flag', CROSS_CHECK_ANSWER]
    const d = makeDispatcher({}, { askReview: async () => ({ text: answers.shift(), status: 'answered' }) })
    withBuilder(d)

    const first = await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.match(first.text, /NOT approved/)

    const { gate } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    assert.equal((await gate).crossCheck, true)
  })

  test('a reviewer that cannot start hands the builder back to the gate, not into a wait', async () => {
    const d = makeDispatcher({ createReviewCheckout: async () => { throw new Error('origin carries no `curia/42`') } })
    const w = withBuilder(d)

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.match(r.text, /could not start the reviewer/)
    assert.match(r.text, /request_review again/)
    assert.equal(d.reviewWaits.size, 0, 'nothing to wait for, so nothing waits')
    assert.equal(w.state, 'ready')
    assert.equal(events.find((e) => e.type === 'cross_check_returned').ok, false)
  })

  test('a parked builder is not nudged toward the gate it is already sitting in', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)
    d.onMcpCall('curia-42')

    assert.deepEqual(await d.onStopHook('curia-42'), { allow: true, terminal: false },
      'a turn that ends parked is blocked, not finished')
    const blocked = events.filter((e) => e.type === 'agent_blocked_on_human').at(-1)
    assert.equal(blocked.cross_check, true)

    // And the terminal path leaves it alone too: nothing is withdrawn or closed.
    await d.onAgentDone('curia-42')
    assert.ok(d.agents.has('curia-42'))
    assert.ok(!typesOf().includes('agent_abnormal_exit'))

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    await gate
  })
})

// ---- 3. the way back ---------------------------------------------------------

describe('the verdict\'s way back (#165)', () => {
  test('it lands as a pull-request comment, on the pull request and not on the ticket', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)

    await d.onResult('curia-review-42', {
      ticket: '42', status: 'resolved', summary: 'VERDICT: concerns\n\nFINDINGS:\n- a.mjs:7 — off by one',
    })
    await gate

    const posted = comments.filter((c) => /Cross-check verdict/.test(c.body))
    assert.equal(posted.length, 1)
    assert.equal(posted[0].n, '7', 'the PULL REQUEST number, not the ticket number')
    assert.match(posted[0].body, /off by one/)
    assert.match(posted[0].body, /curia-review-42/)
    assert.equal(events.find((e) => e.type === 'verdict_commented').ok, true)
  })

  test('the verdict reaches the builder on its note queue, stamped for that instance', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: fail\n- b.mjs:2 — wrong' })
    await gate

    assert.equal(notes.length, 1)
    assert.equal(notes[0].agent, 'curia-42')
    assert.equal(notes[0].label, 'cross-check verdict', 'it must not read as words the operator typed')
    assert.equal(notes[0].instance, 'curia-42@1000', '#208: it dies with the agent it was meant for')
    assert.match(notes[0].text, /wrong/)
  })

  test('the returned gate text states the duty and leaves the findings to the note', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: fail\n- b.mjs:2 — wrong' })
    const r = await gate

    assert.match(r.text, /CROSS-CHECK/)
    assert.match(r.text, /rides in this same tool result as a note/)
    assert.ok(!r.text.includes('b.mjs:2'), 'the verdict rides the note queue, not this string')
    assert.match(r.text, /never a\n\s+gate/, 'the question is plain, never a gate')
    assert.match(r.text, /pure\n\s+approve-or-reject/)
    assert.match(r.text, /charting line/)
    assert.match(r.text, /Never open a fault/)
    assert.equal(events.find((e) => e.type === 'cross_check_returned').ok, true)
  })

  test('the reviewer is told its verdict went on, and told to stop', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)
    const said = await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    await gate

    assert.match(said, /verdict captured/)
    assert.match(said, /posted it on the pull request/)
    assert.match(said, /stop/)
  })

  test('a verdict that cannot be commented still reaches the builder', async () => {
    const d = makeDispatcher({ findPullRequest: async () => null })
    withBuilder(d)
    const { gate } = await pressAndPark(d)

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    await gate

    assert.equal(events.find((e) => e.type === 'verdict_commented').ok, false)
    assert.match(notifies.map((n) => n.message).join('\n'), /could NOT be posted/)
    assert.equal(notes.length, 1, 'the return path does not depend on the comment')
  })

  test('a verdict with no builder left to read it is still on the pull request', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    await d.crossCheck('42')
    d.agents.delete('curia-42')

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })

    assert.equal(comments.filter((c) => /Cross-check verdict/.test(c.body)).length, 1)
    // The start notice (#258) reached the builder while it was still there; the
    // VERDICT is what must not queue at an agent that has since gone.
    assert.deepEqual(notes.filter((n) => n.label === 'cross-check verdict'), [], 'nothing is queued for an agent that is not there')
    assert.ok(typesOf().includes('verdict_undelivered'))
    assert.match(notifies.map((n) => n.message).join('\n'), /resume 42/)
  })

  // #252, ADR-0013: a verdict with no live reader is POSTED, not mourned. The
  // old line said only that it had nowhere to go, and on #223 that one line was
  // the entire surviving record of a four-finding `fail` verdict.
  test('a verdict with no live reader is posted in FULL, with attribution', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    await d.crossCheck('42')
    d.agents.delete('curia-42')

    await d.onResult('curia-review-42', {
      ticket: '42', status: 'resolved', summary: 'VERDICT: fail\n1. the drain path races the exit',
    })

    const carried = notifies.map((n) => n.message).find((m) => /has no live reader/.test(m))
    assert.ok(carried, 'the thread is the verdict\'s last reader, so the thread gets the verdict')
    assert.match(carried, /the drain path races the exit/, 'the findings themselves, not a count')
    assert.match(carried, /curia-review-42/, 'who wrote it')
    assert.match(carried, /https:\/\/github\.com\/o\/r\/pull\/7/, 'where the full text lives')
  })
})

describe('a cross-check that produces no verdict releases the builder (#165)', () => {
  const endings = [
    ['the reviewer stops without one', async (d) => d.onAgentDone('curia-review-42'), /stopped without producing one/],
    ['the reviewer is cancelled', async (d) => d.cancel('42', { by: 'test' }), /cancelled/],
  ]

  for (const [name, end, why] of endings) {
    test(`${name} — the gate call returns, and nothing is approved or rejected`, async () => {
      const live = new Set()
      const d = makeDispatcher({
        hasSession: async (n) => live.has(n),
        newSession: async (o) => { live.add(o.name) },
        killSession: async (n) => { live.delete(n) },
      })
      const w = withBuilder(d)
      const { gate } = await pressAndPark(d)

      await end(d)
      const r = await gate

      assert.match(r.text, /ENDED WITH NO VERDICT/)
      assert.match(r.text, why)
      assert.match(r.text, /request_review again/)
      assert.equal(r.approved, false)
      assert.equal(w.state, 'ready')
      assert.equal(d.reviewWaits.size, 0)
      assert.equal(events.find((e) => e.type === 'cross_check_returned').ok, false)
    })
  }

  test('a reviewer whose respawn fails releases the builder too — #releaseClaim is the choke point', async () => {
    // The watchdog reads a usage limit off the reviewer's pane, the respawn
    // throws, and the release path runs. That path is the one every bad ending
    // goes through, and it must never leave the builder parked on an agent that
    // is already gone.
    const started = []
    const d = makeDispatcher({
      capturePane: async (s) => (s === 'curia-review-42' ? "you've hit your usage limit" : ''),
      newSession: async (o) => {
        if (started.includes(o.name)) throw new Error('tmux refused the respawn')
        started.push(o.name)
      },
    })
    withBuilder(d)
    const { gate } = await pressAndPark(d)

    const r = await gate

    assert.match(r.text, /ENDED WITH NO VERDICT/)
    assert.match(r.text, /the reviewer ended/)
    assert.ok(typesOf().includes('reviewer_ended'))
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'the builder\'s claim is never released by a reviewer fault')
  })
})

// ---- 4. the judgement --------------------------------------------------------

describe('the builder\'s judgement is the second comment (#165)', () => {
  const askJudgement = async (d, prompt) => d.noteJudgement('curia-42', prompt)

  test('the first question after a verdict lands under it, and the daemon writes it', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: concerns' })
    await gate

    assert.equal(await askJudgement(d, 'I agree with finding 1 and disagree with 2. Ship it?'), true)

    const bodies = comments.map((c) => c.body)
    assert.equal(bodies.filter((b) => /Cross-check verdict/.test(b)).length, 1)
    assert.equal(bodies.filter((b) => /The builder answers the cross-check/.test(b)).length, 1)
    assert.ok(
      bodies.findIndex((b) => /Cross-check verdict/.test(b)) < bodies.findIndex((b) => /builder answers/.test(b)),
      'the judgement is the SECOND comment, under the verdict',
    )
    assert.match(bodies.at(-1), /disagree with 2/)
    assert.equal(comments.at(-1).n, '7')
    assert.equal(events.find((e) => e.type === 'judgement_commented').ok, true)
  })

  test('only the first one — a later question is an ordinary question', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: concerns' })
    await gate

    await askJudgement(d, 'the judgement')
    assert.equal(await askJudgement(d, 'and now an unrelated question'), false)
    assert.equal(comments.filter((c) => /builder answers/.test(c.body)).length, 1)
    assert.equal(d.verdictFor('42').judged, true, 'the mark rides the artifact, so a restart keeps it')
  })

  test('a question on a ticket with no verdict posts nothing at all', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    assert.equal(await askJudgement(d, 'an ordinary question'), false)
    assert.deepEqual(comments, [])
  })

  test('a reviewer never posts a judgement — it has no ask_human to post', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    await gate

    assert.equal(await d.noteJudgement('curia-review-42', 'may I?'), false,
      'the session name is not a builder\'s, so this path is not its path')
  })

  test('a fresh cross-check opens the judgement again', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate: first } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: concerns' })
    await first
    await askJudgement(d, 'round one')
    await d.onAgentDone('curia-review-42')

    const { gate: second } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    await second

    assert.equal(d.verdictFor('42').judged, undefined, 'a new verdict is unjudged')
    assert.equal(await askJudgement(d, 'round two'), true)
    assert.equal(comments.filter((c) => /builder answers/.test(c.body)).length, 2)
  })
})

// ---- the composed texts ------------------------------------------------------

describe('what the two comments say (#165)', () => {
  const VERDICT = {
    agent: 'curia-review-42', model: 'gpt', builder_model: 'opus',
    sha: 'deadbeefcafe0123456789', verdict: 'VERDICT: pass', same_provider: false,
  }

  test('the verdict comment names both models, the sha, and who wrote it', () => {
    const c = verdictComment(VERDICT)
    assert.match(c, /🔎 Cross-check verdict/)
    assert.match(c, /`curia-review-42` on `gpt` read `deadbeefcafe`/)
    assert.match(c, /builder ran on `opus`/)
    assert.match(c, /It wrote nothing anywhere/)
    assert.ok(!/weaker check/.test(c))
  })

  test('a same-provider reading says it is the weaker check', () => {
    assert.match(verdictComment({ ...VERDICT, same_provider: true }), /weaker check/)
  })

  test('the judgement comment says the operator decides, not the reviewer', () => {
    const c = judgementComment('curia-42', 'I disagree with finding 2.')
    assert.match(c, /The builder answers the cross-check/)
    assert.match(c, /I disagree with finding 2\./)
    assert.match(c, /operator decides/)
    assert.match(c, /pure approve-or-reject/)
  })

  test('the note is the verdict, and it says who read the diff', () => {
    const n = verdictNote(VERDICT)
    assert.match(n, /`curia-review-42` on `gpt` cross-checked your diff/)
    assert.match(n, /VERDICT: pass/)
  })
})

// ---- 5. the orders -----------------------------------------------------------

describe('the builder\'s duty, in its standing orders (#165)', () => {
  // #340: the duty rides `standing.md` now, composed into the memory file. The
  // agent reads it with the prompt, so this reads both.
  const write = (opts = {}) => {
    const file = writePrompt(tmp, { number: 42, title: 'a ticket', body: 'q' }, { repo: 'o/r', wtPath: '/w/42', ...opts })
    return `${fs.readFileSync(file, 'utf8')}\n${fs.readFileSync(path.join(tmp, STANDING_FILE), 'utf8')}`
  }

  test('the prompt states the third button, the wait, and every step of the duty', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /## The cross-check \(a third button on the gate\)/)
    assert.match(p, /pressable on every round/)
    assert.match(p, /OTHER provider/)
    assert.match(p, /does not end your `request_review` call/)
    for (const line of dutyLines()) assert.ok(p.includes(line), `missing duty line: ${line}`)
  })

  test('it says the question is plain and the next gate is two-way', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /A plain question, never a/)
    assert.match(p, /approve-or-reject about the final code/)
    assert.match(p, /Never open a fault/)
    assert.match(p, /curia posts the verdict and your/)
  })

  test('it says the ending waits for a cross-check the operator starts from the thread (#258)', () => {
    const p = write({ mapNumber: 1 })
    assert.match(p, /start a cross-check from the thread/)
    assert.match(p, /do not resolve the ticket, do not merge the pull request/)
    assert.match(p, /park until the verdict arrives/)
    assert.match(p, /`gh` commands in your own shell/, 'the two acts curia holds no wire on')
  })

  test('a charting agent is told all of it too — #297 gave it a gate to press a button on', () => {
    // It used to be told none of this, because a map dispatch could open no
    // gate. #286 gave the session research findings, ADR-0008 gave those
    // findings the ordinary ending, and the third button sits on that gate — so
    // a charting agent that met a verdict with no word for one would be the
    // #223 shape again.
    const p = write({ mapNumber: 1, charting: true })
    assert.match(p, /## The cross-check \(a third button on the gate\)/)
    for (const line of dutyLines()) assert.ok(p.includes(line), `missing duty line: ${line}`)
  })

  test('one copy: the prompt and the tool result render the same list', () => {
    // dutyLines is the only renderer, so a drift between the two readers is a
    // single edit away rather than two — the #49 rule ENDING already runs on.
    assert.equal(dutyLines().length, CROSS_CHECK_DUTY.flat().length)
    assert.match(dutyLines('  ')[0], /^ {2}- Judge every finding/)
  })
})

// ---- the surfaces ------------------------------------------------------------

describe('a parked builder reads as idle, never as working (#165)', () => {
  const lineFor = async (evs) => {
    const posted = []
    const s = new StatusLine({
      post: async (ticket, text) => { posted.push(text); return { threadId: 'T', messageId: 'M' } },
      edit: async (ids, text) => { posted.push(text); return true },
      remove: async () => {},
      get: (id) => ({ id, agent: 'curia-42', ticket: '42', kind: REVIEW_KIND }),
      meters: () => null,
      log: () => {},
    })
    for (const ev of evs) await s.onEvent(ev)
    return posted.at(-1) ?? ''
  }

  test('the press does not move the line to "working" — the cross-check state does', async () => {
    const line = await lineFor([
      { type: 'agent_spawned', agent: 'curia-42', ticket: '42', model: 'opus' },
      { type: 'esc_answer', id: 'esc-1', answer: CROSS_CHECK_ANSWER, ts: new Date().toISOString() },
      { type: 'cross_check_requested', agent: 'curia-42', ticket: '42', ts: new Date().toISOString() },
    ])
    assert.match(line, /idle at the gate/)
    assert.match(line, /cross-check is reading its diff/)
  })

  test('the verdict puts it back to work', async () => {
    const line = await lineFor([
      { type: 'agent_spawned', agent: 'curia-42', ticket: '42', model: 'opus' },
      { type: 'cross_check_requested', agent: 'curia-42', ticket: '42', ts: new Date().toISOString() },
      { type: 'cross_check_returned', agent: 'curia-42', ticket: '42', ok: true },
    ])
    assert.match(line, /working/)
  })

  test('an ordinary rejection still moves it to working', async () => {
    const line = await lineFor([
      { type: 'agent_spawned', agent: 'curia-42', ticket: '42', model: 'opus' },
      { type: 'esc_answer', id: 'esc-1', answer: 'rename the flag', ts: new Date().toISOString() },
    ])
    assert.match(line, /working/)
  })
})

// ---- the gate and the ending cannot outrun the verdict (#237) ----------------
//
// The #223 ordering, replayed from the live journal: the daemon restarted 20 s
// after the press, the parked call died with it, the builder's client retried
// `request_review`, and the restarted daemon opened a PLAIN approve/reject gate
// — so the operator approved and the merge beat the verdict by three seconds.
// The reviewer record survives a restart (reconcile re-adopts it), so the gate
// and `report_result` now ask it before they act.

// The builder whose park a restart severed: the reviewer is live in the agents
// map (reconcile put it back), and no wait exists — exactly the state the
// retried `request_review` meets.
function withAdoptedReviewer(d, over = {}) {
  const r = {
    repo: 'o/r', ticket: '42', session: 'curia-review-42', title: '',
    instance: 'curia-review-42@adopted-1', wtPath: path.join(tmp, 'work', 'review', '42'),
    cfgDir: path.join(tmp, 'work', 'cfg', 'curia-review-42'),
    model: 'gpt', harness: 'codex', provider: 'openai', state: 'ready',
    spawnedAt: null, resultReceived: false, reviewer: true,
    builderModel: 'opus', sameProvider: false, sha: 'deadbeefcafe0123456789',
    ...over,
  }
  d.agents.set('curia-review-42', r)
  return r
}

// A captured verdict on disk, the artifact a restart also survives.
function plantVerdict(over = {}) {
  const v = {
    repo: 'o/r', ticket: '42', agent: 'curia-review-42', model: 'gpt',
    builder_model: 'opus', same_provider: false, sha: 'deadbeefcafe0123456789',
    status: 'resolved', verdict: 'VERDICT: fail\n\nFINDINGS:\n- b.mjs:2 — wrong',
    details: null, at: new Date().toISOString(), ...over,
  }
  const file = path.join(tmp, 'data', 'verdicts', '42.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(v, null, 2))
  return v
}

describe('request_review knows a cross-check is in flight (#237)', () => {
  test('a live reviewer re-parks the builder — no plain gate opens', async () => {
    let gateOpened = false
    const d = makeDispatcher({}, {
      askReview: async () => { gateOpened = true; return { text: 'approve', status: 'answered' } },
    })
    const w = withBuilder(d)
    withAdoptedReviewer(d)

    const call = d.requestReview('curia-42', { summary: 's', charting: 'none' })
    await waitFor(() => d.reviewWaits.has('42'))

    assert.equal(gateOpened, false, 'the gate #223 was approved on must never open')
    assert.equal(w.state, 'cross-checking')
    assert.ok(typesOf().includes('cross_check_rejoined'))
    assert.match(notifies.map((n) => n.message).join('\n'), /re-parked until the verdict lands/)

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    const r = await call
    assert.equal(r.crossCheck, true)
    assert.match(r.text, /rides in this same tool result as a note/)
    assert.equal(gateOpened, false)
    assert.equal(notes.at(-1).agent, 'curia-42', 'the verdict reached the rejoined builder')
  })

  test('an unjudged verdict shuts the gate and rides back as a note', async () => {
    let gateOpened = false
    const d = makeDispatcher({}, {
      askReview: async () => { gateOpened = true; return { text: 'approve', status: 'answered' } },
    })
    withBuilder(d)
    plantVerdict()

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(gateOpened, false)
    assert.equal(r.ok, false)
    assert.match(r.text, /UNJUDGED/)
    assert.match(r.text, /Judge every finding/)
    const requeued = notes.at(-1)
    assert.equal(requeued.agent, 'curia-42')
    assert.equal(requeued.label, 'cross-check verdict')
    assert.match(requeued.text, /b\.mjs:2/)
    assert.equal(events.find((e) => e.type === 'review_refused').reason, 'unjudged cross-check verdict')
  })

  test('a judged verdict opens the gate again — the duty ends where it should', async () => {
    const d = makeDispatcher({}, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    withBuilder(d)
    plantVerdict()
    await d.noteJudgement('curia-42', 'finding 1: agree. finding 2: disagree. Recommendation: merge.')

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.equal(r.approved, true)
  })

  test('a verdict older than the ticket\'s last claim does not bind a fresh dispatch', async () => {
    const d = makeDispatcher({}, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    withBuilder(d)
    plantVerdict({ at: '2020-01-01T00:00:00.000Z' })
    d.store.logEvent('dispatch_claimed', { repo: 'o/r', ticket: '42', agent: 'curia-42', kind: 'ticket' })

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.equal(r.approved, true, 'a dead dispatch\'s verdict must not shut every later gate')
  })
})

describe('report_result cannot end a ticket around its cross-check (#237)', () => {
  test('refused while the reviewer reads, and no result trace is left', async () => {
    const d = makeDispatcher()
    const w = withBuilder(d)
    withAdoptedReviewer(d)

    const text = await d.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'done' })

    assert.match(text, /report_result refused/)
    assert.match(text, /request_review/)
    assert.ok(!w.resultReceived, 'a refused result must not read as hasResult')
    assert.equal(events.find((e) => e.type === 'result_refused').reason, 'cross-check in flight')
    assert.ok(!typesOf().includes('ticket_resolved'), 'nothing on the tracker moved')
  })

  test('refused on an unjudged verdict, allowed after the judgement', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    plantVerdict()

    const refused = await d.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'done' })
    assert.match(refused, /UNJUDGED/)
    assert.equal(events.find((e) => e.type === 'result_refused').reason, 'unjudged cross-check verdict')

    await d.noteJudgement('curia-42', 'judged, recommendation attached')
    assert.equal(d.resultRefusal('curia-42'), null, 'the duty done is the whole condition')
  })

  test('the reviewer\'s own report_result is never the one refused', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    withAdoptedReviewer(d)

    const said = await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    assert.match(said, /verdict captured/)
  })

  test('the Stop-hook checklist names the duty ahead of every ordinary step', () => {
    const judge = outstanding({ hasResult: false, unjudgedVerdict: true })
    assert.match(judge[0], /judge the cross-check verdict/)
    const wait = outstanding({ hasResult: false, crossCheckInFlight: true })
    assert.match(wait[0], /cross-check is still reading/)
    assert.deepEqual(
      outstanding({ hasResult: true, unjudgedVerdict: true }), [],
      'a reported result still ends the checklist — the wire refusal is what keeps this pair apart',
    )
  })
})

describe('a verdict that lost the race says so (#237)', () => {
  test('the thread says TOO LATE, never the neutral holding line', async () => {
    const d = makeDispatcher()
    withBuilder(d, { resultReceived: true })
    withAdoptedReviewer(d)

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: fail' })

    const said = notifies.map((n) => n.message).join('\n')
    assert.match(said, /TOO LATE to gate anything/)
    assert.ok(!/curia is holding it/.test(said), 'the neutral line is what read as a delivery on #223')
    assert.ok(typesOf().includes('verdict_late'))
    assert.equal(comments.filter((c) => /Cross-check verdict/.test(c.body)).length, 1,
      'the durable record still lands on the pull request')
  })

  test('the journal alone proves late — a restart holds no builder record', async () => {
    const d = makeDispatcher()
    withAdoptedReviewer(d)
    d.store.logEvent('reviewer_spawned', { repo: 'o/r', ticket: '42', agent: 'curia-review-42' })
    d.store.logEvent('ticket_resolved', { repo: 'o/r', ticket: '42', agent: 'curia-42' })

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: fail' })

    assert.ok(typesOf().includes('verdict_late'))
    assert.match(notifies.map((n) => n.message).join('\n'), /TOO LATE/)
  })

  test('an on-time verdict keeps the holding line', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    const { gate } = await pressAndPark(d)
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    await gate

    assert.match(notifies.map((n) => n.message).join('\n'), /curia is holding it/)
    assert.ok(!typesOf().includes('verdict_late'))
  })
})

// ---- 6. the race the park closes (#258) --------------------------------------
//
// #237 made the builder lose loudly; it did not stop it from losing. A
// cross-check started from the command seam lands on a builder that is WORKING,
// and #223 is what that costs: merge, resolve and report all ran while the
// reviewer read. Two halves close it — the start speaks, and the ending parks.

describe('the start of a cross-check speaks to the builder (#258)', () => {
  test('a press from the command seam queues the notice at the builder', async () => {
    const d = makeDispatcher()
    const w = withBuilder(d)

    const reply = await d.crossCheck('42', { by: 'test' })

    assert.match(reply, /cross-checking o\/r#42/)
    const said = notes.at(-1)
    assert.equal(said.agent, 'curia-42')
    assert.equal(said.label, 'cross-check started')
    assert.equal(said.instance, w.instance, 'the words are for THIS builder (#208)')
    assert.match(said.text, /`curia-review-42` is reading your diff/)
    assert.match(said.text, /do not resolve the ticket, do not merge the pull request/)
    assert.match(said.text, /park until the verdict arrives/)
    assert.match(said.text, /`gh` commands in your own shell/, 'the two acts curia holds no wire on')
    assert.equal(events.find((e) => e.type === 'cross_check_announced').reviewer, 'curia-review-42')
  })

  test('the gate press queues nothing — the park says it on the call itself', async () => {
    const d = makeDispatcher()
    withBuilder(d)

    const { gate } = await pressAndPark(d)

    assert.equal(notes.length, 0, 'a notice here would ride out beside the verdict')
    assert.ok(!typesOf().includes('cross_check_announced'))
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    const r = await gate
    assert.match(r.text, /rides in this same tool result as a note/)
    assert.equal(notes.length, 1, 'the verdict is the one thing that reached it')
  })

  test('no builder to reach, so nothing queues and the journal says why', async () => {
    const d = makeDispatcher()
    d.store.logEvent('agent_spawned', { repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'opus', kind: 'ticket' })

    await d.crossCheck('42', { repo: 'o/r' })

    assert.equal(notes.length, 0)
    assert.equal(events.find((e) => e.type === 'cross_check_unannounced').reason, 'no builder is running')
  })

  test('a start notice that dies gets no operator-note line of its own', async () => {
    const d = makeDispatcher()
    withBuilder(d)

    d.announceExpiredNotes({
      agent: 'curia-42',
      notes: [{ label: 'cross-check started', text: 'a reviewer is reading' }],
      liveInstance: null,
      why: 'is gone',
    })

    assert.equal(notifies.length, 0, 'the verdict carrier is the fact worth a line, not its warning')
  })
})

describe('a pending cross-check parks the ending (#258)', () => {
  test('report_result parks, and the verdict lands on that call', async () => {
    const d = makeDispatcher()
    const w = withBuilder(d)
    withAdoptedReviewer(d)

    const held = d.endingHold('curia-42')
    await waitFor(() => d.reviewWaits.has('42'))
    assert.equal(w.state, 'cross-checking')
    assert.match(notifies.map((n) => n.message).join('\n'), /parked until the verdict lands/)

    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: fail\n- b.mjs:2 wrong' })
    const text = await held

    assert.match(text, /^HELD/)
    assert.match(text, /rides in\nthis same tool result as a note/)
    assert.match(text, /Judge every finding/)
    assert.equal(notes.at(-1).agent, 'curia-42', 'the verdict reached the builder that tried to end')
    assert.equal(notes.at(-1).label, 'cross-check verdict')
    assert.equal(events.find((e) => e.type === 'result_parked').reason, 'cross-check in flight')
    assert.equal(events.findLast((e) => e.type === 'cross_check_returned').on, 'report_result')
    assert.ok(!w.resultReceived, 'a held result must not read as hasResult')
    assert.ok(!typesOf().includes('ticket_resolved'), 'nothing on the tracker moved')
  })

  test('a cross-check that ends with no verdict releases the ending', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    withAdoptedReviewer(d)

    const held = d.endingHold('curia-42')
    await waitFor(() => d.reviewWaits.has('42'))
    await d.onAgentDone('curia-review-42')

    assert.equal(await held, null, 'there is nothing to judge, so the builder is not punished for the press')
    assert.equal(events.findLast((e) => e.type === 'cross_check_returned').ok, false)
  })

  test('no cross-check, no hold — the ordinary ending is untouched', async () => {
    const d = makeDispatcher()
    withBuilder(d)

    assert.equal(await d.endingHold('curia-42'), null)
    assert.equal(notifies.length, 0)
  })

  test('an unjudged verdict still refuses rather than parking — nothing is coming', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    plantVerdict()

    assert.equal(await d.endingHold('curia-42'), null, 'the hold waits for a reviewer, and none is reading')
    assert.match(d.resultRefusal('curia-42'), /UNJUDGED/)
  })

  test('the reviewer\'s own ending is never held', async () => {
    const d = makeDispatcher()
    withBuilder(d)
    withAdoptedReviewer(d)

    assert.equal(await d.endingHold('curia-review-42'), null)
  })

  test('a parked ending reads as idle at the turn end, never as gone', async () => {
    const d = makeDispatcher({ hasSession: async () => true })
    withBuilder(d)
    withAdoptedReviewer(d)

    const held = d.endingHold('curia-42')
    await waitFor(() => d.reviewWaits.has('42'))
    await d.onAgentDone('curia-42')

    assert.ok(events.some((e) => e.type === 'agent_blocked_on_human' && e.cross_check === true))
    assert.ok(!typesOf().includes('agent_finished'), 'a parked builder is not a finished one')
    await d.onResult('curia-review-42', { ticket: '42', status: 'resolved', summary: 'VERDICT: pass' })
    await held
  })
})

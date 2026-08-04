// Unit tests for src/dispatch.mjs, driven entirely through the Dispatcher's
// injected `deps` seam — no gh, no git, no tmux, no live box.
//
// Covers the three behaviours the review wave found untested (acceptance N2):
//   1. the in-flight admission guard (criterion 3: one claim per ticket)
//   2. abnormal-exit detection (criterion 4: a result-less exit keeps its pane)
//   3. reconcile epoch scoping (criterion 7: a stale result never masks a dead
//      claim from a LATER dispatch of the same ticket)
// plus the B1 regression: reconcile must destroy nothing when it cannot
// establish who the gh viewer is.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Dispatcher, paneTail, textCarriesLimitPhrase, parseTicketRef, newExitMarker, parseExitMarker, paneExcerpt } from '../src/dispatch.mjs'
import { parseUsageLimit } from '../src/routing.mjs'

const ROUTING = {
  defaults: { untyped: 'sonnet' },
  models: { sonnet: { provider: 'anthropic', harness: 'claude' } },
  fallbacks: {},
  harnesses: { claude: { template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"', ready: '⏵⏵|bypass permissions', toolChannelGraceS: 15, readyRe: /⏵⏵|bypass permissions/ } },
}

// The same routing with a shorter tool-channel window (#194), so a test can sit
// out the grace period instead of the configured 15 s. ROUTING itself is shared
// across every test in this file and is never mutated.
const withGrace = (s) => ({
  ...ROUTING,
  harnesses: { claude: { ...ROUTING.harnesses.claude, toolChannelGraceS: s } },
})

const OPEN_ISSUE = {
  number: 42, title: 'a ticket', body: 'body text', state: 'open',
  assignees: [], labels: [],
}

let tmp
let notifies
let events
let escalations // open escalation records the store double reports (#47)
let cancelled // ids the dispatcher cancelled through the injected gate
let confirms // confirm records opened through the injected openConfirm (#94)
let lapses // {id, reason} lapsed through the injected lapseEscalation (#94)
let confirmNotes // {id, text} posted next to a confirm's buttons (#94)
let overseerNotes // {threadId, text} synthetic session lines (#94)
const dispatchers = [] // every Dispatcher a test built, so afterEach can end its watches

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-dispatch-test-'))
  fs.mkdirSync(path.join(tmp, 'data', 'results'), { recursive: true })
  notifies = []
  events = []
  escalations = []
  cancelled = []
  confirms = []
  lapses = []
  confirmNotes = []
  overseerNotes = []
})

afterEach(() => {
  // Every detached watch this test left running is ended HERE, by dropping the
  // records they hold: both the readiness watchdog and the tool-channel watch
  // (#194) stop as soon as `agents.get(session)` is no longer the object they
  // started on. Without this an agent that reached its composer keeps a 15 s
  // window open, and it journals its verdict into whatever test is running when
  // it closes — `events` and `notifies` are shared across the file.
  for (const d of dispatchers) d.agents.clear()
  dispatchers.length = 0
  fs.rmSync(tmp, { recursive: true, force: true })
})

// Poll until `cond` holds — for behaviour that completes inside a detached
// continuation (confirm chains, the watchdog) rather than the awaited call.
async function waitFor(cond, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!cond()) throw new Error('waitFor: condition not reached in time')
}

// Deps default to inert doubles; each test overrides only what it asserts on.
function makeDispatcher(deps = {}, {
  watch = [{ repo: 'o/r', mode: 'auto' }], readyTimeoutS = 45, routing = ROUTING,
  skills = null, stopNudgeBudget = 3,
  askReview = async () => ({ text: 'approve', status: 'answered' }),
  identityProxy = { listening: true },
} = {}) {
  const root = path.join(tmp, 'work')
  const config = {
    watch,
    dispatch: {
      auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
      workspace_root: root, ready_timeout_s: readyTimeoutS,
      stop_nudge_budget: stopNudgeBudget,
    },
    attach: { ttyd_port: 7681, serve_port: 8443 },
    identity: { allow: ['tester@example.com'], proxy_port: 7682 },
    skills,
  }
  const store = {
    logEvent: (type, data) => { const rec = { type, ...data }; events.push(rec); return rec },
    openEscalations: () => escalations.filter((r) => r.status === 'open'),
    cancel: () => ({ ok: true }),
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
    ensureBaseClone: async (r, repo) => path.join(r, 'repos', repo.replace('/', '__'), 'base'),
    // A real directory carrying the tracker doc, because that is what every
    // watched repo has: the doc-less case is a deliberate override (#57).
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
    writeConnectionSettings: () => {},
    writePrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
    ensureTtyd: async () => ({ verified: true }),
    assertServe: async () => {},
    serveOff: async () => {},
    // resolve + land (#41)
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
    store,
    notify: (ticket, message) => notifies.push({ ticket, message }),
    // the #94 confirm seams: records land in `escalations` so the dispatcher's
    // own openEscalations() reads find them (lapse-on-exit walks that list)
    openConfirm: ({ ticket, prompt, action, originThreadId }) => {
      const rec = {
        id: `esc-${escalations.length + confirms.length + 1}`, status: 'open', kind: 'confirm',
        agent: 'overseer', ticket, prompt, action, origin_thread_id: originThreadId ?? null,
      }
      confirms.push(rec)
      escalations.push(rec)
      return rec
    },
    lapseEscalation: (id, reason) => {
      lapses.push({ id, reason })
      const r = escalations.find((x) => x.id === id)
      if (r) r.status = 'lapsed'
      return { ok: true }
    },
    confirmNote: (record, text) => confirmNotes.push({ id: record.id, text }),
    overseerNote: (threadId, text) => overseerNotes.push({ threadId, text }),
    askReview,
    cancelEscalation: (id, opts) => { cancelled.push({ id, ...opts }); return { ok: true } },
    log: () => {},
    dataDir: path.join(tmp, 'data'),
    daemonPort: 4271,
    deps: { ...base, ...deps },
  })
  // #151: index.mjs hangs the identity proxy on the dispatcher the way it hangs
  // the timeline. Reconcile refuses to publish the terminal surface while the
  // proxy is down, so the default here is up — the down case gets its own test.
  d.identityProxy = identityProxy
  dispatchers.push(d)
  return d
}

const typesOf = () => events.map((e) => e.type)

describe('in-flight admission guard (criterion 3)', () => {
  test('a second start() interleaving with the first is refused, and the ticket is claimed exactly once', async () => {
    let claims = 0
    let spawns = 0
    const d = makeDispatcher({
      claim: async () => { claims += 1 },
      newSession: async () => { spawns += 1 },
    })

    // deliberately NOT awaited: the second call lands while the first is still
    // inside its gh round-trips
    const first = d.start('42', { repo: 'o/r', by: 'test' })
    const secondReply = await d.start('42', { repo: 'o/r', by: 'test' })
    const firstReply = await first

    assert.match(secondReply, /already starting/)
    assert.match(firstReply, /dispatched/)
    assert.equal(claims, 1, 'the ticket must be claimed exactly once')
    assert.equal(spawns, 1, 'exactly one agent must be spawned')
    assert.equal(events.filter((e) => e.type === 'dispatch_claimed').length, 1)
  })

  test('the guard is released after start() settles, so a later start is admitted again', async () => {
    let claims = 0
    const d = makeDispatcher({ claim: async () => { claims += 1 } })
    await d.start('42', { repo: 'o/r' })
    d.agents.delete('curia-42') // simulate the agent having gone away
    const again = await d.start('42', { repo: 'o/r' })
    assert.match(again, /dispatched/)
    assert.equal(claims, 2)
  })
})

describe('abnormal-exit detection (criterion 4)', () => {
  test('agent_done with NO recorded result journals agent_abnormal_exit, notifies, and keeps the session', async () => {
    let killed = null
    const d = makeDispatcher({ killSession: async (name) => { killed = name } })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready', resultReceived: false })

    await d.onAgentDone('curia-42')

    assert.ok(typesOf().includes('agent_abnormal_exit'))
    assert.ok(!typesOf().includes('lifecycle_closed'))
    assert.equal(killed, null, 'the pane is the post-mortem evidence — it must NOT be killed')
    assert.equal(d.agents.get('curia-42').state, 'failed')
    assert.match(notifies.at(-1).message, /WITHOUT reporting a result/)
  })

  test('agent_done with a results file on disk journals lifecycle_closed and kills the session', async () => {
    let killed = null
    const d = makeDispatcher({ killSession: async (name) => { killed = name } })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready', resultReceived: false })
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{"status":"resolved"}')

    await d.onAgentDone('curia-42')

    assert.ok(typesOf().includes('lifecycle_closed'))
    assert.ok(!typesOf().includes('agent_abnormal_exit'))
    assert.equal(killed, 'curia-42')
    assert.equal(d.agents.has('curia-42'), false)
  })

  test('onResult alone (no file yet) is enough to make the exit a normal close', async () => {
    let killed = null
    const d = makeDispatcher({ killSession: async (name) => { killed = name } })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready', resultReceived: false })
    d.onResult('curia-42')

    await d.onAgentDone('curia-42')

    assert.ok(typesOf().includes('lifecycle_closed'))
    assert.equal(killed, 'curia-42')
  })
})

// #47: the Stop hook reports the end of a TURN, not the end of an agent. A
// agent blocked in ask_human ends its turn while the call is pending, and the
// terminal path used to run on it — withdrawing the preview the human was
// mid-review of.
describe('a blocked agent is not a crashed one (#47)', () => {
  // Preview double: `withdrawn` is the assertion that matters — the rehearsal's
  // damage was the link disappearing under a human, not the journal line.
  function previewDouble(withdrawn) {
    return {
      get: () => ({ url: 'https://box.ts.net:8500/' }),
      withdraw: async (ticket) => { withdrawn.push(String(ticket)); return { ok: true, withdrawn: true } },
    }
  }

  const blockedAgent = () => ({ repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready', resultReceived: false })

  test('Stop while an escalation is open: preview kept, no crash notify, agent marked blocked', async () => {
    const withdrawn = []
    let killed = null
    const d = makeDispatcher({ hasSession: async () => true, killSession: async (n) => { killed = n } })
    d.previews = previewDouble(withdrawn)
    d.agents.set('curia-42', blockedAgent())
    escalations = [{ id: 'esc-21', agent: 'curia-42', ticket: '42', status: 'open' }]

    await d.onAgentDone('curia-42')

    assert.deepEqual(withdrawn, [], 'the human is still reviewing that preview')
    assert.ok(!typesOf().includes('agent_abnormal_exit'))
    assert.ok(!typesOf().includes('lifecycle_closed'))
    assert.ok(typesOf().includes('agent_blocked_on_human'))
    assert.deepEqual(events.at(-1).escalations, ['esc-21'])
    assert.equal(killed, null)
    assert.equal(d.agents.get('curia-42').state, 'blocked')
    assert.deepEqual(notifies, [], 'the escalation itself is the human surface — a crash notify would be a lie')
  })

  test('an open escalation belonging to someone else does not defer this agent', async () => {
    const withdrawn = []
    const d = makeDispatcher({ hasSession: async () => true })
    d.previews = previewDouble(withdrawn)
    d.agents.set('curia-42', blockedAgent())
    // an overseer confirm on the same ticket, and another agent's block
    escalations = [
      { id: 'esc-30', agent: 'overseer', ticket: '42', status: 'open' },
      { id: 'esc-31', agent: 'curia-43', ticket: '43', status: 'open' },
    ]

    await d.onAgentDone('curia-42')

    assert.ok(typesOf().includes('agent_abnormal_exit'))
    assert.deepEqual(withdrawn, ['42'])
    assert.match(notifies.at(-1).message, /WITHOUT reporting a result/)
  })

  test('the deferral is re-judged: once the escalation closes, the next Stop closes the lifecycle', async () => {
    const withdrawn = []
    let killed = null
    const d = makeDispatcher({ hasSession: async () => true, killSession: async (n) => { killed = n } })
    d.previews = previewDouble(withdrawn)
    d.agents.set('curia-42', blockedAgent())
    escalations = [{ id: 'esc-21', agent: 'curia-42', ticket: '42', status: 'open' }]

    await d.onAgentDone('curia-42') // blocked: deferred
    escalations = [] // human answered; the agent resumed, worked, reported
    d.onResult('curia-42')
    await d.onAgentDone('curia-42')

    assert.ok(typesOf().includes('lifecycle_closed'))
    assert.equal(killed, 'curia-42')
    assert.deepEqual(withdrawn, ['42'], 'withdrawn once, at the real end')
  })

  test('an INDETERMINATE session read keeps the block — it is not evidence of death', async () => {
    const withdrawn = []
    const d = makeDispatcher({ hasSession: async () => { throw new Error('tmux session presence is indeterminate: wedged') } })
    d.previews = previewDouble(withdrawn)
    d.agents.set('curia-42', blockedAgent())
    escalations = [{ id: 'esc-21', agent: 'curia-42', ticket: '42', status: 'open' }]

    await d.onAgentDone('curia-42')

    assert.ok(typesOf().includes('agent_blocked_on_human'))
    assert.deepEqual(withdrawn, [])
    assert.deepEqual(cancelled, [])
  })

  test('/cancel on a blocked agent cancels the question it was blocked on', async () => {
    const d = makeDispatcher({}, { confirm: async () => true })
    d.agents.set('curia-42', { ...blockedAgent(), wtPath: '/w/42', cfgDir: '/c/42' })
    escalations = [{ id: 'esc-21', agent: 'curia-42', ticket: '42', status: 'open' }]

    d.cancel('42', { by: 'test' })
    await waitFor(() => notifies.some((n) => /cancelled/.test(n.message)))

    assert.deepEqual(cancelled, [{ id: 'esc-21', by: 'cancel' }], 'the thread must stop asking an agent that no longer exists')
    assert.ok(typesOf().includes('escalation_orphaned'))
  })

  test('a session POSITIVELY gone is a real exit: the orphaned escalation is cancelled', async () => {
    const withdrawn = []
    const d = makeDispatcher({ hasSession: async () => false })
    d.previews = previewDouble(withdrawn)
    d.agents.set('curia-42', blockedAgent())
    escalations = [{ id: 'esc-21', agent: 'curia-42', ticket: '42', status: 'open' }]

    await d.onAgentDone('curia-42')

    assert.deepEqual(cancelled, [{ id: 'esc-21', by: 'agent-death' }])
    assert.ok(typesOf().includes('escalation_orphaned'))
    assert.ok(typesOf().includes('agent_abnormal_exit'))
    assert.deepEqual(withdrawn, ['42'])
    assert.match(notifies[0].message, /still open/)
  })
})

describe('reconcile epoch scoping (criterion 7)', () => {
  function writeJournal(lines) {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  const assignedToMe = { ...OPEN_ISSUE, assignees: [{ login: 'me' }] }

  test('a result BEFORE the latest dispatch_claimed does not mask the dead claim', async () => {
    const unclaimed = []
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' },
      { type: 'result', agent: 'curia-42', ticket: '42' },
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' },
    ])
    const d = makeDispatcher({
      listSessions: async () => [], // no live session for curia-42
      fetchIssue: async () => ({ ...assignedToMe }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, ['o/r#42'])
    assert.ok(typesOf().includes('dead_claim_released'))
  })

  test('a result AFTER the latest dispatch_claimed closes the epoch — no dead claim', async () => {
    const unclaimed = []
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' },
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' },
      { type: 'result', agent: 'curia-42', ticket: '42' },
    ])
    const d = makeDispatcher({
      listSessions: async () => [],
      fetchIssue: async () => ({ ...assignedToMe }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, [])
    assert.ok(!typesOf().includes('dead_claim_released'))
  })

  test('a live tmux session keeps its claim, whatever the journal says', async () => {
    const unclaimed = []
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }])
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...assignedToMe }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, [])
    assert.equal(d.agents.get('curia-42').repo, 'o/r') // re-adopted instead
  })

  test('a re-adopted agent gets its model and harness back from the journal (#187)', async () => {
    // The record used to be rebuilt with every spawn-time fact missing. The
    // status line then had no routing row for the agent, and both account
    // bars left the line while the context figure stayed — one missing fact,
    // two meters gone. The journal wrote the label down at spawn.
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'sonnet', harness: 'claude' },
    ])
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...assignedToMe }),
    })

    await d.reconcile({ boot: false })

    const w = d.agents.get('curia-42')
    assert.equal(w.model, 'sonnet')
    assert.equal(w.harness, 'claude')
    assert.equal(w.provider, 'anthropic', 'the provider follows the label, as it does at spawn')
  })

  test('a respawn down the fallback chain is what is running, so the LAST spawn wins', async () => {
    const routing = {
      ...ROUTING,
      models: { sonnet: { provider: 'anthropic', harness: 'claude' }, gpt: { provider: 'openai', harness: 'codex' } },
    }
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'sonnet', harness: 'claude' },
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'gpt', harness: 'codex', retry_after_limit: true },
    ])
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...assignedToMe }),
    }, { routing })

    await d.reconcile({ boot: false })

    const w = d.agents.get('curia-42')
    assert.equal(w.model, 'gpt')
    assert.equal(w.harness, 'codex')
    assert.equal(w.provider, 'openai')
  })

  test('a session this daemon never spawned is adopted with no model, and nothing breaks', async () => {
    // A lab session, or a journal that no longer reaches back that far. The
    // meters fall to their on-disk evidence — the transcript names the model
    // and the config dir names the harness.
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }])
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...assignedToMe }),
    })

    await d.reconcile({ boot: false })

    const w = d.agents.get('curia-42')
    assert.equal(w.model, null)
    assert.equal(w.harness, null)
    assert.equal(w.provider, null)
  })
})

describe('the pane is untrusted text (B6)', () => {
  test('narrowing 1: a rendered ticket body scrolled above the tail no longer classifies', () => {
    const pane = [
      '> alp82/curia#42: investigate the limit banner',
      '  Users report a "Claude usage limit reached" message even though',
      '  their weekly quota is untouched. Reproduce and fix.',
      ...Array(20).fill('● reading the banner component…'),
      '  ⏵⏵ bypass permissions on',
    ].join('\n')
    assert.equal(parseUsageLimit(paneTail(pane)), null)
    // the naive whole-pane read is exactly what used to misfire here
    assert.notEqual(parseUsageLimit(pane), null)
  })

  test('a real cap hit at the bottom of the pane still classifies', () => {
    const pane = ['> some ticket', '  body', '', 'Claude usage limit reached | 1800000000'].join('\n')
    const limit = parseUsageLimit(paneTail(pane))
    assert.ok(limit)
    assert.equal(limit.scope, 'provider')
  })

  test('paneTail ignores trailing blank lines when taking the tail', () => {
    const pane = ['keep-me', ...Array(30).fill('x'), '', '', ''].join('\n')
    assert.equal(paneTail(pane, 5).split('\n').length, 5)
    assert.ok(!paneTail(pane, 5).includes('keep-me'))
  })

  test('the composer marker in a rendered ticket body above the tail does not mark the agent ready', async () => {
    // a ticket ABOUT the agent harness renders "bypass permissions" into the
    // pane; scrolled above the tail it must not forge readiness any more than
    // "usage limit reached" may forge a cap hit
    const pane = [
      '> ticket: the harness runs agents with "bypass permissions" on',
      ...Array(25).fill('● thinking…'),
    ].join('\n')
    const d = makeDispatcher({ capturePane: async () => pane }, { readyTimeoutS: 3 })
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => notifies.some((n) => /did not reach a composer/.test(n.message)))
    assert.ok(!typesOf().includes('agent_ready'), 'marker text outside the tail must not mark ready')
  })

  test('textCarriesLimitPhrase spots a ticket that can forge the signal', () => {
    assert.equal(textCarriesLimitPhrase('fix the banner', 'shows "usage limit reached" wrongly'), true)
    assert.equal(textCarriesLimitPhrase('fix the banner', 'shows the weekly usage limit'), false)
    assert.equal(textCarriesLimitPhrase(undefined, undefined), false)
  })

  test('narrowing 2: a ticket whose own body carries the phrase never cools a model or kills the agent', async () => {
    let killed = null
    const hostile = {
      ...OPEN_ISSUE,
      body: 'Repro: the CLI prints "Claude usage limit reached" even when the quota is fine.',
    }
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...hostile }),
      // the pane echoes the ticket text right next to the composer
      capturePane: async () => 'Claude usage limit reached | 1800000000',
      killSession: async (n) => { killed = n },
    }, { readyTimeoutS: 3 })

    await d.start('42', { repo: 'o/r' })
    // let the watchdog poll until it gives up
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !notifies.some((n) => /did not reach a composer/.test(n.message))) {
      await new Promise((r) => setTimeout(r, 100))
    }

    assert.ok(notifies.some((n) => /did not reach a composer/.test(n.message)), 'must fall through to the ready-timeout path')
    // the refusal leans on this notify as its human surface, so it must NAME
    // the ignored signal — a bare timeout gives no reason to suspect a cap hit
    assert.ok(notifies.some((n) => /usage-limit signal was seen but IGNORED/.test(n.message)),
      'the ready-timeout notify must say a usage-limit signal was ignored')
    assert.ok(typesOf().includes('usage_limit_ignored_ambiguous'))
    assert.ok(!typesOf().includes('model_cooling'))
    assert.ok(!typesOf().includes('provider_cooling'))
    assert.equal(killed, null, 'a healthy session must not be killed by its own ticket text')
  })
})

// #169: `codex` was never installed on the box, so the research lane's spawn
// died in a millisecond. The pane said `codex: command not found` at the first
// poll, and the watchdog still waited 45 s and then reported a bare "did not
// reach a composer" — the cause was on screen the whole time.
describe('a harness command that exits is not a slow start (#169)', () => {
  // The pane a dead spawn leaves: the reason, the wrapper's exit line, a shell
  // prompt back. `marker` is the nonce this spawn was given.
  const deadPane = (marker, reason = 'bash: codex: command not found') => [
    reason,
    `[curia] the harness command exited — ${marker} 127`,
    'alp@box:~/curia-work/repos/o__r/wt/42$',
  ].join('\n')

  test('the exit marker ends the watch at once, and the notify carries the reason', async () => {
    let marker = null
    const d = makeDispatcher({
      newSession: async (opts) => { marker = opts.exitMarker },
      capturePane: async () => (marker ? deadPane(marker) : ''),
    }, { readyTimeoutS: 45 })

    const started = Date.now()
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => notifies.some((n) => /exited with status 127/.test(n.message)))
    const elapsed = Date.now() - started

    assert.ok(elapsed < 20_000, `must not sit out the 45 s timeout (took ${elapsed}ms)`)
    assert.ok(typesOf().includes('agent_exited_early'))
    assert.ok(!typesOf().includes('agent_ready_timeout'), 'the fast path replaces the timeout, it does not precede it')
    assert.ok(!typesOf().includes('agent_ready'))
    const msg = notifies.find((n) => /exited with status 127/.test(n.message)).message
    assert.match(msg, /command not found/, 'the pane line that explains the death must reach the thread')
    assert.match(msg, /kept for inspection/, 'the posture does not change: a human decides what happens next')
    assert.ok(!msg.includes(marker), 'the nonce is machinery, not operator text')
  })

  test('the marker is a per-spawn nonce, so ticket text cannot forge an exit', async () => {
    // a ticket ABOUT this very mechanism renders a plausible exit line into the
    // pane; a fixed marker would let it stop a healthy agent's watchdog
    const hostile = {
      ...OPEN_ISSUE,
      body: 'the pane shows "[curia] the harness command exited — curia-exit-deadbeefcafe 127" and the watch stops',
    }
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...hostile }),
      capturePane: async () => hostile.body,
    }, { readyTimeoutS: 3 })

    await d.start('42', { repo: 'o/r' })
    await waitFor(() => notifies.some((n) => /did not reach a composer/.test(n.message)))
    assert.ok(!typesOf().includes('agent_exited_early'), 'a forged marker must classify as nothing at all')
  })

  test('parseExitMarker reads the status, and only its own marker', () => {
    const pane = deadPane('curia-exit-abc123')
    assert.equal(parseExitMarker(pane, 'curia-exit-abc123'), 127)
    assert.equal(parseExitMarker(pane, 'curia-exit-999999'), null)
    assert.equal(parseExitMarker(pane, null), null)
    assert.equal(parseExitMarker('still working…', 'curia-exit-abc123'), null)
    // status 0 is still a death before the composer, and 0 is not falsy here
    assert.equal(parseExitMarker('[curia] the harness command exited — curia-exit-abc123 0', 'curia-exit-abc123'), 0)
  })

  test('newExitMarker is quote-free and never repeats', () => {
    const a = newExitMarker()
    const b = newExitMarker()
    assert.notEqual(a, b)
    assert.match(a, /^curia-exit-[0-9a-f]{12}$/)
  })

  test('paneExcerpt quotes the lines above the marker, and cannot break out of the fence', () => {
    const pane = [
      'noise the operator does not need',
      'line one', 'line two', 'line three', 'line four',
      'bash: codex: command not found',
      '[curia] the harness command exited — curia-exit-abc123 127',
      'alp@box:~$',
    ].join('\n')
    const excerpt = paneExcerpt(pane, 'curia-exit-abc123')

    assert.match(excerpt, /command not found/)
    assert.ok(!excerpt.includes('alp@box'), 'everything from the marker down is machinery')
    assert.ok(!excerpt.includes('noise'), 'bounded to the last few lines')
    assert.equal(excerpt.split('\n').length, 4)
    assert.ok(!paneExcerpt('a ``` fence\nand more', null).includes('`'), 'untrusted text must not carry a fence')
  })
})

describe('the tool channel is recorded, not assumed (#194)', () => {
  const READY = '⏵⏵ bypass permissions on'

  test('the first /mcp call per agent is stamped and journalled, and later ones are not', async () => {
    const d = makeDispatcher({ capturePane: async () => READY })
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => typesOf().includes('agent_ready'))

    d.onMcpCall('curia-42')
    const first = d.agents.get('curia-42').mcpSeenAt
    assert.ok(first, 'the stamp is the whole detector')
    d.onMcpCall('curia-42')
    d.onMcpCall('curia-42')

    const stamps = events.filter((e) => e.type === 'agent_mcp_first')
    assert.equal(stamps.length, 1, 'FIRST, not every call — the journal is evidence, not traffic')
    assert.equal(d.agents.get('curia-42').mcpSeenAt, first, 'the stamp never moves')
    assert.equal(stamps[0].agent, 'curia-42')
    assert.equal(stamps[0].ticket, '42')
    assert.equal(typeof stamps[0].since_spawn_ms, 'number')
    assert.equal(typeof stamps[0].since_ready_ms, 'number', 'the reading the grace window is tuned against')
  })

  test('a handshake that lands before the composer states a null since_ready_ms', async () => {
    // the reading #189 could not settle: whether the client connects at startup
    // or lazily. A null here IS the answer that it ran ahead of the marker.
    // The watchdog polls every 2 s, so the call below lands while the record
    // still says `spawning` — and the wait after it leaves no watch running.
    const d = makeDispatcher({ capturePane: async () => READY })
    await d.start('42', { repo: 'o/r' })
    d.onMcpCall('curia-42')

    const stamp = events.find((e) => e.type === 'agent_mcp_first')
    assert.equal(stamp.since_ready_ms, null)
    assert.equal(stamp.state, 'spawning')
    assert.ok(stamp.since_spawn_ms >= 0)
    await waitFor(() => typesOf().includes('agent_ready'))
  })

  test('a name with no live agent records nothing at all', () => {
    const d = makeDispatcher()
    d.onMcpCall('curia-999')
    assert.ok(!typesOf().includes('agent_mcp_first'), 'no agent, no evidence — and no throw')
  })

  test('an agent at the composer that calls /mcp inside the window is left alone', async () => {
    const d = makeDispatcher({ capturePane: async () => READY }, { routing: withGrace(3) })
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => typesOf().includes('agent_ready'))
    d.onMcpCall('curia-42')

    await new Promise((r) => setTimeout(r, 4500))
    assert.ok(!typesOf().includes('agent_mute'), 'a healthy agent must never be called mute')
    assert.equal(events.filter((e) => e.type === 'agent_spawned').length, 1)
    d.agents.delete('curia-42')
  })

  test('a mute agent is respawned ONCE, on the same model, and the cause reaches the operator', async () => {
    const killed = []
    const spawns = []
    const d = makeDispatcher({
      capturePane: async () => READY,
      killSession: async (n) => { killed.push(n) },
      newSession: async (o) => { spawns.push(o.name) },
    }, { routing: withGrace(2) })
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => typesOf().includes('agent_mute'), 12_000)
    await waitFor(() => events.filter((e) => e.type === 'agent_spawned').length === 2, 12_000)

    const mute = events.find((e) => e.type === 'agent_mute')
    assert.equal(mute.attempt, 1)
    assert.equal(mute.found, 'grace window')
    assert.equal(mute.grace_s, 2)
    assert.deepEqual(killed, ['curia-42'], 'the mute session is torn down before the respawn')

    const respawn = events.filter((e) => e.type === 'agent_spawned')[1]
    assert.equal(respawn.model, 'sonnet', 'the SAME model — the model is not what failed')
    assert.equal(respawn.retry_after_mute, true)
    assert.equal(spawns.length, 2)

    const msg = notifies.find((n) => /no curia tools/.test(n.message)).message
    assert.match(msg, /MCP client never connected/, 'the operator gets the cause, not just the symptom')
    assert.match(msg, /same model/)
    assert.ok(!notifies.some((n) => /usage limit/.test(n.message)), 'this is not a cap hit and must not read as one')

    // the respawned agent's own window is still open, and `events` is shared
    // across tests — dropping the record ends the watch at its next check
    d.agents.delete('curia-42')
  })

  test('the respawn clears the stamp, so the second window is a reading and not an echo', async () => {
    const d = makeDispatcher({ capturePane: async () => READY }, { routing: withGrace(2) })
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => events.filter((e) => e.type === 'agent_spawned').length === 2, 12_000)

    // A stamp carried over would make the successor look healthy on its
    // predecessor's evidence — and a second stamp is only journalled when the
    // record holds none, so this event IS the clearing.
    assert.equal(d.agents.get('curia-42').mcpSeenAt, null)
    d.onMcpCall('curia-42')
    assert.equal(events.filter((e) => e.type === 'agent_mcp_first').length, 1)
    await waitFor(() => typesOf().filter((t) => t === 'agent_ready').length === 2, 12_000)
    await new Promise((r) => setTimeout(r, 3000))
    assert.ok(!events.some((e) => e.type === 'agent_mute' && e.attempt === 2), 'the second agent spoke, so the second window closes clean')
    d.agents.delete('curia-42')
  })

  test('a second mute agent is refused and unclaimed, never respawned again', async () => {
    let unclaimed = 0
    const d = makeDispatcher({
      capturePane: async () => READY,
      unclaim: async () => { unclaimed += 1 },
    }, { routing: withGrace(2) })
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => events.filter((e) => e.type === 'agent_mute').length === 2, 25_000)

    assert.equal(events.filter((e) => e.type === 'agent_spawned').length, 2, 'one respawn, and only one — #126 paid for the unbounded kind once')
    assert.equal(events.filter((e) => e.type === 'agent_mute')[1].attempt, 2)
    assert.equal(unclaimed, 1)
    assert.ok(typesOf().includes('dispatch_unclaimed'))
    assert.ok(!d.agents.has('curia-42'), 'the record goes with the claim')

    const msg = notifies.find((n) => /refusing to dispatch/.test(n.message)).message
    assert.match(msg, /twice/)
    assert.match(msg, /side channel has to be up BEFORE the agent/, 'the refusal names where to look')
  })
})

describe('the Stop hook is the backstop for a mistuned window (#194)', () => {
  test('an agent that ends a turn having never called /mcp is named, not nudged', async () => {
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const d = makeDispatcher({ commitsOnBranch: async () => [{ sha: 'a', subject: 's' }] })
    liveAgent(d, { mcpSeenAt: null })

    const decision = await d.onStopHook('curia-42', {})

    assert.deepEqual(decision, { allow: true, terminal: true }, 'nothing it could do about it')
    assert.ok(!typesOf().includes('stop_blocked'), 'the ending is all curia tools — nudging asks for the impossible')
    const mute = events.find((e) => e.type === 'agent_mute')
    assert.equal(mute.found, 'stop hook')
    const msg = notifies.find((n) => /never called one curia tool/.test(n.message)).message
    assert.match(msg, /rides curl/, 'the transport that proved it is the point')
  })

  test('an agent adopted after a daemon restart is never called mute on this path', async () => {
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const d = makeDispatcher({ commitsOnBranch: async () => [{ sha: 'a', subject: 's' }] })
    // reconcile rebuilds a re-adopted record with spawnedAt null: this daemon
    // never saw the spawn, so it never saw the handshake either
    liveAgent(d, { mcpSeenAt: null, spawnedAt: null })

    const decision = await d.onStopHook('curia-42', {})

    assert.equal(decision.decision, 'block', 'the ordinary nudge, on the ordinary evidence')
    assert.ok(!typesOf().includes('agent_mute'), 'the silence belongs to the restart, not to the agent')
  })
})

describe('reconcile without a confirmed viewer identity (B1)', () => {
  test('a failed `gh api user` destroys nothing — no sweep, no unclaim, no worktree removal', async () => {
    const destroyed = []
    fs.writeFileSync(
      path.join(tmp, 'data', 'events.jsonl'),
      JSON.stringify({ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }) + '\n',
    )
    const d = makeDispatcher({
      viewerLogin: async () => { throw new Error('HTTP 403: rate limit') },
      listSessions: async () => ['curia-42'],
      // the issue reads fine — a DIFFERENT endpoint from /user, which is
      // exactly how the destructive path used to be reached
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      killSession: async (n) => { destroyed.push(`kill:${n}`) },
      removeWorktree: async (b, wt) => { destroyed.push(`worktree:${wt}`) },
      removeConfigDir: (dir) => { destroyed.push(`cfg:${dir}`) },
      unclaim: async (repo, ticket) => { destroyed.push(`unclaim:${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(destroyed, [], 'reconcile must not act on ownership it cannot establish')
    assert.ok(typesOf().includes('reconcile_identity_unknown'))
    assert.ok(!typesOf().includes('orphan_swept'))
  })
})

describe('reconcile with an indeterminate tmux session list (the B1 hole through the tmux read)', () => {
  test('a failing listSessions destroys nothing — no unclaim, no sweep, no worktree removal', async () => {
    // An agent is ALIVE right now, but the tmux read fails (wedged server,
    // foreign socket, the 5 s timeout). Reading that as "no sessions" used to
    // release the live claim, re-frontier the ticket, and let a re-dispatch
    // force-remove the live worktree.
    const destroyed = []
    fs.writeFileSync(
      path.join(tmp, 'data', 'events.jsonl'),
      JSON.stringify({ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }) + '\n',
    )
    const d = makeDispatcher({
      listSessions: async () => { throw new Error('tmux session list is indeterminate: timeout') },
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      killSession: async (n) => { destroyed.push(`kill:${n}`) },
      removeWorktree: async (b, wt) => { destroyed.push(`worktree:${wt}`) },
      removeConfigDir: (dir) => { destroyed.push(`cfg:${dir}`) },
      unclaim: async (repo, ticket) => { destroyed.push(`unclaim:${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(destroyed, [], 'an indeterminate session list is a failed pass, not evidence')
    assert.ok(typesOf().includes('reconcile_sessions_indeterminate'))
    assert.ok(!typesOf().includes('dead_claim_released'))
    assert.ok(!typesOf().includes('orphan_swept'))
  })
})

describe('start never confirms (#89, built by #94)', () => {
  test('a tracked already-running agent refuses with the way out and destroys nothing', async () => {
    let kills = 0
    let claims = 0
    const original = { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready' }
    const d = makeDispatcher({
      killSession: async () => { kills += 1 },
      claim: async () => { claims += 1 },
    })
    d.agents.set('curia-42', original)

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })

    assert.match(reply, /already running/)
    assert.match(reply, /cancel 42/)
    assert.equal(kills, 0, 'start must never tear down a live agent')
    assert.equal(claims, 0)
    assert.equal(d.agents.get('curia-42'), original, 'the tracked record is untouched')
    assert.deepEqual(confirms, [], 'no confirm is ever opened for start')
  })

  test('an untracked live tmux session refuses the same way', async () => {
    let kills = 0
    const d = makeDispatcher({
      hasSession: async () => true,
      killSession: async () => { kills += 1 },
    })
    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /already live but untracked/)
    assert.match(reply, /cancel 42/)
    assert.equal(kills, 0)
    assert.deepEqual(confirms, [])
  })

  test('an assigned or blocked ticket refuses instead of offering a dispatch-anyway confirm', async () => {
    let claims = 0
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'somebody' }] }),
      claim: async () => { claims += 1 },
    })
    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /already assigned to somebody/)
    assert.match(reply, /start never dispatches over an anomaly/)
    assert.equal(claims, 0)
    assert.deepEqual(confirms, [])
  })
})

describe('usage-limit respawn failure releases the claim (B3)', () => {
  test('newSession throws on the post-limit respawn ⇒ one unclaim, dispatch_unclaimed, agent dropped, one notify', async () => {
    const routing = {
      defaults: { untyped: 'sonnet' },
      models: {
        sonnet: { provider: 'anthropic', harness: 'claude' },
        haiku: { provider: 'anthropic', harness: 'claude' },
      },
      fallbacks: { sonnet: ['haiku'] },
      harnesses: ROUTING.harnesses,
    }
    let spawnCalls = 0
    const unclaimed = []
    const credsRemoved = []
    const d = makeDispatcher({
      newSession: async () => {
        spawnCalls += 1
        if (spawnCalls > 1) throw new Error('tmux exploded')
      },
      // a model-scoped cap hit ⇒ cool sonnet, fall back to haiku
      capturePane: async () => 'Sonnet usage limit reached | 1800000000',
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
      removeCredentials: (dir) => { credsRemoved.push(dir) },
    }, { routing })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /dispatched/)

    await waitFor(() => unclaimed.length > 0)
    assert.deepEqual(unclaimed, ['o/r#42'], 'exactly one unclaim')
    assert.ok(typesOf().includes('model_cooling'))
    assert.ok(events.some((e) => e.type === 'dispatch_unclaimed' && /respawn after model usage limit failed/.test(e.reason)))
    assert.equal(d.agents.has('curia-42'), false, 'the agent record is dropped')
    assert.equal(credsRemoved.length, 1, 'the OAuth credential copy is collected on release')
    assert.equal(notifies.length, 1, 'exactly one notify')
    assert.match(notifies[0].message, /respawn on \*\*haiku\*\* failed/)
  })
})

describe('the usage-credits dialog gates the model (#126, #108 item 12)', () => {
  test('the dialog cools fable, vetoes the ready marker under it, and respawns down the chain', async () => {
    const routing = {
      defaults: { untyped: 'fable' },
      models: {
        fable: { provider: 'anthropic', harness: 'claude' },
        opus: { provider: 'anthropic', harness: 'claude' },
      },
      fallbacks: { fable: ['opus'] },
      harnesses: ROUTING.harnesses,
    }
    // The dialog verbatim from the deployment box (2026-08-02), with the
    // status footer under it: the dogfood run's ready marker matched through
    // the modal, so the credit parse has to win before the readiness test.
    const DIALOG = [
      '  Fable 5 now uses usage credits',
      '  Fable 5 runs on usage credits, purchased separately from your plan.',
      "  You don't have usage credits yet.",
      '    1. Request usage credits from your admin',
      '  ❯ 2. Switch to Sonnet 5 and continue',
      '  Enter to confirm · Esc to cancel',
      '  ⏵⏵ bypass permissions on',
    ].join('\n')
    let spawnCalls = 0
    const d = makeDispatcher({
      newSession: async () => { spawnCalls += 1 },
      capturePane: async () => (spawnCalls > 1 ? '⏵⏵ bypass permissions on' : DIALOG),
    }, { routing })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /dispatched/)

    await waitFor(() => typesOf().includes('agent_ready'))
    // the dialog never read as a healthy fable agent
    const ready = events.find((e) => e.type === 'agent_ready')
    assert.equal(ready.model, 'opus')
    const cooled = events.find((e) => e.type === 'model_cooling')
    assert.equal(cooled.model, 'fable')
    assert.ok(events.some((e) => e.type === 'agent_spawned' && e.model === 'opus' && e.retry_after_limit))
    assert.ok(notifies.some((n) => /usage-credits dialog/.test(n.message) && /respawned on \*\*opus\*\*/.test(n.message)))

    d.agents.delete('curia-42') // retire the watchdog
  })
})

describe('every spawn path shares the host credential store (#53)', () => {
  // The frozen-copy failure (#34) came back on the *respawn* path in an earlier
  // shape of this code, so both paths are asserted: an agent that survives its
  // first host-side refresh but respawns onto a snapshot is still broken.
  test('the initial spawn carries CLAUDE_SECURESTORAGE_CONFIG_DIR alongside the isolated config dir', async () => {
    const envs = []
    const d = makeDispatcher({
      newSession: async ({ env }) => { envs.push(env) },
    })

    await d.start('42', { repo: 'o/r', by: 'test' })

    assert.equal(envs.length, 1)
    assert.equal(envs[0].CLAUDE_SECURESTORAGE_CONFIG_DIR, path.join(os.homedir(), '.claude'))
    assert.match(envs[0].CLAUDE_CONFIG_DIR, /cfg[/\\]curia-42$/)
    assert.notEqual(envs[0].CLAUDE_CONFIG_DIR, envs[0].CLAUDE_SECURESTORAGE_CONFIG_DIR)

    // retire the watchdog: the loop stops as soon as the record it was spawned
    // for is gone, and a poller outliving its test journals into the NEXT one
    d.agents.delete('curia-42')
  })

  test('the respawn after a usage limit carries it too', async () => {
    const routing = {
      defaults: ROUTING.defaults,
      models: {
        sonnet: { provider: 'anthropic', harness: 'claude' },
        haiku: { provider: 'anthropic', harness: 'claude' },
      },
      fallbacks: { sonnet: ['haiku'] },
      harnesses: ROUTING.harnesses,
    }
    const envs = []
    const d = makeDispatcher({
      newSession: async ({ env }) => { envs.push(env) },
      capturePane: async () => 'Sonnet usage limit reached | 1800000000',
    }, { routing })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => envs.length > 1)

    assert.equal(envs[1].CLAUDE_SECURESTORAGE_CONFIG_DIR, path.join(os.homedir(), '.claude'))
    assert.deepEqual(envs[1], envs[0], 'a respawn must not be authenticated differently from a spawn')

    // this pane says "usage limit" forever, so the watchdog would respawn on a
    // loop for the rest of the run if the record stayed
    d.agents.delete('curia-42')
  })
})

describe('true exhaustion with a FAILED unclaim tells the operator the truth (residual 3)', () => {
  test('unclaim throws on the exhaustion release ⇒ unclaim_failed journalled AND a claim-release-FAILED notify', async () => {
    // provider-scope limit (generic "Claude usage limit reached") with no
    // fallback models ⇒ #handleLimit's true-exhaustion tail. Both exhaustion
    // messages say "no claim made"/"nothing claimed" — when the release
    // failed that is the opposite of the truth: the ticket stays assigned
    // and filterTakeable drops it from every frontier.
    const d = makeDispatcher({
      capturePane: async () => 'Claude usage limit reached | 1800000000',
      unclaim: async () => { throw new Error('gh: HTTP 502') },
    })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /dispatched/)

    await waitFor(() => events.some((e) => e.type === 'unclaim_failed'))
    await waitFor(() => notifies.some((n) => /claim release FAILED: the issue is still assigned; reconcile will retry/.test(n.message)))
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'a failed release must never be journalled as done (F1)')
    assert.equal(notifies.filter((n) => /cooling/.test(n.message)).length, 1, 'the exhaustion-window latch is untouched — exactly one cooling message')
  })

  test('control: a successful unclaim on true exhaustion adds no release-failure message', async () => {
    const d = makeDispatcher({
      capturePane: async () => 'Claude usage limit reached | 1800000000',
    })

    await d.start('42', { repo: 'o/r', by: 'test' })

    await waitFor(() => events.some((e) => e.type === 'dispatch_unclaimed'))
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(notifies.filter((n) => /claim release FAILED/.test(n.message)).length, 0)
  })
})

describe('exactly one notify per exhaustion window (B7/R5)', () => {
  test('two exhausted direct dispatches in one cooling window ⇒ one notify, two journal events, both replies carried', async () => {
    const d = makeDispatcher()
    d.cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))

    const first = await d.start('42', { repo: 'o/r' })
    const second = await d.start('42', { repo: 'o/r' })

    assert.match(first, /all routing lanes are cooling/)
    assert.match(second, /all routing lanes are cooling/, 'the direct reply path always carries the string')
    assert.equal(events.filter((e) => e.type === 'dispatch_exhausted').length, 2)
    assert.equal(notifies.length, 1, 'the latch allows exactly one notify per window')
  })

  test('an anomaly refusal on a latched exhaustion window stays a refusal — no confirm, no echo', async () => {
    // pre-#94 this path parked a dispatch-anyway confirm whose continuation
    // could land on exhaustion; start refuses flat now, so the anomaly reply
    // is the whole story and the latch stays untouched
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'somebody' }] }),
    })
    d.cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))

    const reply = await d.start('42', { repo: 'o/r' })
    assert.match(reply, /start never dispatches over an anomaly/)
    assert.deepEqual(confirms, [])
    assert.equal(notifies.filter((n) => /cooling/.test(n.message)).length, 0, 'a refusal never reaches #dispatch, so the latch never fires')
  })
})

describe('an indeterminate hasSession answer never authorises a claim (W1)', () => {
  test('start(): hasSession throwing propagates BEFORE any claim — no claim, no worktree churn', async () => {
    let claims = 0
    const destroyed = []
    const d = makeDispatcher({
      hasSession: async () => { throw new Error('tmux session presence is indeterminate: timeout') },
      claim: async () => { claims += 1 },
      killSession: async (n) => { destroyed.push(`kill:${n}`) },
      createWorktree: async () => { destroyed.push('worktree'); return '/x' },
    })

    await assert.rejects(() => d.start('42', { repo: 'o/r' }), /indeterminate/)
    assert.equal(claims, 0, 'never claim on an answer tmux could not give')
    assert.deepEqual(destroyed, [])
    assert.equal(d.inFlight.size, 0, 'the admission guard is released on the throw')
  })
})

describe('Dispatcher.cancel (criterion 6, the destructive half — W8; immediate since #94)', () => {
  test('slash cancel executes at once: session killed, worktree removed, unclaimed, config dir removed, record dropped, journalled', async () => {
    const acts = []
    const d = makeDispatcher({
      killSession: async (n) => acts.push(`kill:${n}`),
      removeWorktree: async (base, wt) => acts.push(`worktree:${wt}`),
      unclaim: async (repo, t) => acts.push(`unclaim:${repo}#${t}`),
      removeConfigDir: (dir) => acts.push(`cfg:${path.basename(dir)}`),
    })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready' })

    const reply = await d.cancel('42', { by: 'test' })

    assert.match(reply, /cancelled/)
    assert.match(reply, /worktree removed, ticket re-frontiered/)
    assert.deepEqual(acts, ['kill:curia-42', 'worktree:/w/42', 'unclaim:o/r#42', 'cfg:curia-42'])
    assert.equal(d.agents.has('curia-42'), false)
    assert.ok(events.some((e) => e.type === 'dispatch_unclaimed' && e.reason === 'cancelled' && e.by === 'test'))
    assert.deepEqual(confirms, [], 'a typed cancel is its own confirmation — no buttons (#89)')
  })

  test('cancel with nothing live says so and destroys nothing', async () => {
    const acts = []
    const d = makeDispatcher({
      killSession: async () => acts.push('kill'),
      removeConfigDir: () => acts.push('cfg'),
    })
    const reply = await d.cancel('42', { by: 'test' })
    assert.match(reply, /nothing to cancel/)
    assert.deepEqual(acts, [])
    assert.ok(!typesOf().includes('agent_cancelled'))
  })

  test('untracked cancel: session and config dir go, the GitHub claim is left alone', async () => {
    const acts = []
    const d = makeDispatcher({
      hasSession: async () => true,
      killSession: async (n) => acts.push(`kill:${n}`),
      removeWorktree: async () => acts.push('worktree'),
      unclaim: async () => acts.push('unclaim'),
      removeConfigDir: (dir) => acts.push(`cfg:${path.basename(dir)}`),
    })

    const reply = await d.cancel('42', { by: 'test' })

    assert.match(reply, /cancelled/)
    assert.deepEqual(acts, ['kill:curia-42', 'cfg:curia-42'], 'no tracked record ⇒ no worktree removal, no unclaim')
    assert.match(reply, /GitHub claim untouched/)
    // F1: the message admits the claim was untouched, so the journal must not
    // record an unclaim that never happened — closedAfterEpoch reads
    // dispatch_unclaimed as "this ticket is settled" and would skip it forever
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'no unclaim happened ⇒ none may be journalled')
    assert.ok(!typesOf().includes('unclaim_failed'), 'no unclaim was even attempted ⇒ no event at all')
  })
})

describe('button confirms: the interpreted cancel path (#94)', () => {
  const liveAgent = (instance = 'curia-42@1') => ({
    repo: 'o/r', ticket: '42', session: 'curia-42', instance,
    wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready',
  })

  test('requestCancel opens an instance-bound confirm and executes NOTHING', async () => {
    const acts = []
    const d = makeDispatcher({ killSession: async () => acts.push('kill') })
    d.agents.set('curia-42', liveAgent())

    const reply = await d.requestCancel('42', { threadId: 'thread-9' })

    assert.match(reply, /confirm \*\*esc-1\*\*/)
    assert.match(reply, /nothing happens until ✅/)
    assert.equal(confirms.length, 1)
    assert.deepEqual(confirms[0].action, {
      verb: 'cancel',
      targets: [{ session: 'curia-42', ticket: '42', repo: 'o/r', state: 'ready', instance: 'curia-42@1' }],
    })
    assert.equal(confirms[0].origin_thread_id, 'thread-9')
    assert.deepEqual(acts, [], 'the tool handler never executes (#89)')
    assert.ok(d.agents.has('curia-42'))
  })

  test('requestCancel with nothing live refuses without opening a confirm', async () => {
    const d = makeDispatcher()
    assert.match(await d.requestCancel('42', {}), /nothing to cancel/)
    assert.deepEqual(confirms, [])
  })

  test('approve executes button → daemon: teardown runs, outcome noted for the issuing session', async () => {
    const acts = []
    const d = makeDispatcher({
      killSession: async (n) => acts.push(`kill:${n}`),
      removeWorktree: async () => acts.push('worktree'),
      unclaim: async (repo, t) => acts.push(`unclaim:${repo}#${t}`),
      removeConfigDir: () => acts.push('cfg'),
    })
    d.agents.set('curia-42', liveAgent())
    await d.requestCancel('42', { threadId: 'thread-9' })

    Object.assign(confirms[0], { status: 'answered', answer: 'approve', answered_by: 'alp' })
    await d.onConfirmAnswered(confirms[0])

    assert.deepEqual(acts, ['kill:curia-42', 'worktree', 'unclaim:o/r#42', 'cfg'])
    assert.equal(d.agents.has('curia-42'), false)
    assert.ok(overseerNotes.some((n) => n.threadId === 'thread-9' && /approved — cancelled curia-42/.test(n.text)))
  })

  test('decline executes nothing and says so next to the buttons and to the issuing session', async () => {
    const acts = []
    const d = makeDispatcher({ killSession: async () => acts.push('kill') })
    d.agents.set('curia-42', liveAgent())
    await d.requestCancel('42', { threadId: 'thread-9' })

    Object.assign(confirms[0], { status: 'answered', answer: 'reject', answered_by: 'alp' })
    await d.onConfirmAnswered(confirms[0])

    assert.deepEqual(acts, [])
    assert.ok(d.agents.has('curia-42'))
    assert.ok(confirmNotes.some((n) => /not confirmed/.test(n.text)))
    assert.ok(overseerNotes.some((n) => /declined/.test(n.text)))
  })

  test('instance mismatch: an approved confirm never hits a replacement agent', async () => {
    const acts = []
    const d = makeDispatcher({ killSession: async (n) => acts.push(`kill:${n}`) })
    d.agents.set('curia-42', liveAgent('curia-42@1'))
    await d.requestCancel('42', { threadId: 'thread-9' })
    // the described agent exits and a NEW dispatch takes the session name
    d.agents.set('curia-42', liveAgent('curia-42@2'))

    Object.assign(confirms[0], { status: 'answered', answer: 'approve', answered_by: 'alp' })
    await d.onConfirmAnswered(confirms[0])

    assert.deepEqual(acts, [], 'the confirm was bound to instance @1 — @2 must survive')
    assert.ok(d.agents.has('curia-42'))
    assert.ok(confirmNotes.some((n) => /skipped/.test(n.text)))
  })

  test('an agent exit lapses its open confirm — message, journal, session note', async () => {
    const d = makeDispatcher({ hasSession: async () => false })
    d.agents.set('curia-42', liveAgent())
    await d.requestCancel('42', { threadId: 'thread-9' })
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{}')

    await d.onAgentDone('curia-42')

    assert.equal(lapses.length, 1)
    assert.equal(lapses[0].id, confirms[0].id)
    assert.ok(events.some((e) => e.type === 'confirm_lapsed' && e.id === confirms[0].id))
    assert.ok(overseerNotes.some((n) => /lapsed/.test(n.text)))
  })

  test('requestCancelAll lists tracked and untracked targets, approve tears down each', async () => {
    const acts = []
    const d = makeDispatcher({
      listSessions: async () => ['curia-42', 'curia-77'],
      hasSession: async (s) => s === 'curia-77',
      killSession: async (n) => acts.push(`kill:${n}`),
      removeWorktree: async () => {},
      unclaim: async () => {},
      removeConfigDir: () => {},
    })
    d.agents.set('curia-42', liveAgent())

    const reply = await d.requestCancelAll({ threadId: 'thread-9' })
    assert.match(reply, /2 agent\(s\)/)
    assert.match(reply, /curia-77.*untracked/)
    assert.deepEqual(acts, [])
    assert.equal(confirms[0].action.targets.length, 2)
    assert.equal(confirms[0].action.targets[1].instance, 'curia-77@untracked')

    Object.assign(confirms[0], { status: 'answered', answer: 'approve', answered_by: 'alp' })
    await d.onConfirmAnswered(confirms[0])
    assert.deepEqual(acts, ['kill:curia-42', 'kill:curia-77'])
  })
})

describe('reconcile sweeps abandoned credential copies (W6)', () => {
  function seedCfg(session) {
    const dir = path.join(tmp, 'work', 'cfg', session)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
    fs.writeFileSync(path.join(dir, 'prompt.md'), '# kept for post-mortem')
    return dir
  }

  test('a cfg dir whose session is positively gone loses its credentials — a live one keeps them', async () => {
    const swept = []
    seedCfg('curia-77') // dead: no session
    seedCfg('curia-88') // alive: session listed
    const d = makeDispatcher({
      listSessions: async () => ['curia-88'],
      removeCredentials: (dir) => swept.push(path.basename(dir)),
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(swept, ['curia-77'], 'only the dead agent is swept')
    assert.ok(events.some((e) => e.type === 'credentials_swept' && e.agent === 'curia-77'))
  })

  test('an INDETERMINATE session list sweeps nothing (the W1 interaction)', async () => {
    const swept = []
    seedCfg('curia-77')
    const d = makeDispatcher({
      listSessions: async () => { throw new Error('tmux session list is indeterminate: timeout') },
      removeCredentials: (dir) => swept.push(path.basename(dir)),
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(swept, [], 'a failed read is not evidence the agent is dead')
  })
})

describe('a failed unclaim is never journalled as dispatch_unclaimed (F1 — the W1 class in the journal)', () => {
  function writeJournal(lines) {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  test('#dispatch failure path: unclaim rejects ⇒ unclaim_failed, no dispatch_unclaimed, and the reply does not say "claim released"', async () => {
    const d = makeDispatcher({
      createWorktree: async () => { throw new Error('git exploded') },
      unclaim: async () => { throw new Error('gh: HTTP 502') },
    })

    const reply = await d.start('42', { repo: 'o/r' })

    assert.match(reply, /failed before the agent could run/)
    assert.ok(!/claim released\b/.test(reply), 'the operator must not be told a release that did not happen')
    assert.match(reply, /claim release FAILED/)
    assert.ok(typesOf().includes('unclaim_failed'))
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'the unclaim did not happen — recording it would disarm reconcile')
  })

  test('#dispatch failure path: unclaim succeeds ⇒ dispatch_unclaimed as before, reply says released', async () => {
    const d = makeDispatcher({ createWorktree: async () => { throw new Error('git exploded') } })

    const reply = await d.start('42', { repo: 'o/r' })

    assert.match(reply, /claim released/)
    assert.ok(typesOf().includes('dispatch_unclaimed'))
    assert.ok(!typesOf().includes('unclaim_failed'))
  })

  test('unclaim_failed does NOT close the epoch: the next reconcile releases the still-assigned claim', async () => {
    // the exact silent-disappearance scenario: dispatch failed, the unclaim
    // failed transiently, the issue is still assigned to the bot — a
    // dispatch_unclaimed here would make closedAfterEpoch skip the ticket on
    // every future reconcile while filterTakeable keeps it off the frontier
    const unclaimed = []
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' },
      { type: 'unclaim_failed', repo: 'o/r', ticket: '42', agent: 'curia-42', reason: 'git exploded', error: 'gh: HTTP 502' },
    ])
    const d = makeDispatcher({
      listSessions: async () => [],
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, ['o/r#42'], 'reconcile must retry the release the failed unclaim left behind')
    assert.ok(typesOf().includes('dead_claim_released'))
  })

  test('control: a genuine dispatch_unclaimed still closes the epoch — reconcile leaves it alone', async () => {
    const unclaimed = []
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' },
      { type: 'dispatch_unclaimed', repo: 'o/r', ticket: '42', agent: 'curia-42', reason: 'git exploded' },
    ])
    const d = makeDispatcher({
      listSessions: async () => [],
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, [])
    assert.ok(!typesOf().includes('dead_claim_released'))
  })

  test('#releaseClaim with no viewer login journals unclaim_failed, never dispatch_unclaimed', async () => {
    // reach #releaseClaim through the respawn-failure path: first spawn OK,
    // usage-limit hit, second spawn throws, and by then gh identity is gone
    const routing = {
      defaults: { untyped: 'sonnet' },
      models: {
        sonnet: { provider: 'anthropic', harness: 'claude' },
        haiku: { provider: 'anthropic', harness: 'claude' },
      },
      fallbacks: { sonnet: ['haiku'] },
      harnesses: ROUTING.harnesses,
    }
    let spawnCalls = 0
    let loginCalls = 0
    const unclaimed = []
    const d = makeDispatcher({
      viewerLogin: async () => {
        loginCalls += 1
        if (loginCalls > 1) throw new Error('gh: HTTP 503')
        return 'me'
      },
      newSession: async () => {
        spawnCalls += 1
        if (spawnCalls > 1) throw new Error('tmux exploded')
      },
      capturePane: async () => 'Sonnet usage limit reached | 1800000000',
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    }, { routing })

    await d.start('42', { repo: 'o/r' })
    await waitFor(() => events.some((e) => e.type === 'unclaim_failed'))

    assert.deepEqual(unclaimed, [], 'no login ⇒ no unclaim was possible')
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'an impossible unclaim must not be recorded as done')
    assert.ok(notifies.some((n) => /claim release FAILED/.test(n.message)), 'the operator hears the truth, not "re-frontiered"')
  })
})

describe('#resolveRepo refuses on failed reads instead of narrowing (F2 — the W1 class in a read)', () => {
  const takeable = (n) => ({ number: n, title: 't', state: 'open', assignees: [], labels: [] })
  const twoRepos = { watch: [{ repo: 'o/r1', mode: 'ready-for-agent' }, { repo: 'o/r2', mode: 'ready-for-agent' }] }

  test('a failed frontier read on ONE repo makes the bare-number start refuse — never claim against the repo that happened to answer', async () => {
    // both repos carry #42; r1\'s read fails transiently — the old filter
    // dropped the {error} row, saw one hit, and dispatched a bypassPermissions
    // agent against r2\'s #42 with no confirm
    let claims = 0
    const d = makeDispatcher({
      flatFrontier: async (repo) => {
        if (repo === 'o/r1') throw new Error('gh: HTTP 502')
        return [takeable(42)]
      },
      claim: async () => { claims += 1 },
    }, twoRepos)

    const reply = await d.start('42', {})

    assert.match(reply, /could not determine which repo owns #42/)
    assert.match(reply, /o\/r1/, 'the refusal names the repo whose read failed')
    assert.equal(claims, 0, 'nothing may be claimed on an indeterminate candidate set')
    assert.ok(!typesOf().includes('dispatch_claimed'))
  })

  test('control: with both frontier reads healthy, a bare number takeable in exactly one repo still dispatches', async () => {
    const d = makeDispatcher({
      flatFrontier: async (repo) => (repo === 'o/r2' ? [takeable(42)] : []),
    }, twoRepos)

    const reply = await d.start('42', {})

    assert.match(reply, /dispatched o\/r2#42/)
  })

  test('probe path: a non-404 fetchIssue failure refuses instead of narrowing to the repo that answered', async () => {
    let claims = 0
    const d = makeDispatcher({
      flatFrontier: async () => [], // not on any frontier ⇒ probe
      fetchIssue: async (repo) => {
        if (repo === 'o/r1') throw new Error('gh: HTTP 502')
        return { ...OPEN_ISSUE }
      },
      claim: async () => { claims += 1 },
    }, twoRepos)

    const reply = await d.start('42', {})

    assert.match(reply, /could not determine which repo owns #42/)
    assert.equal(claims, 0)
  })

  test('probe path: an HTTP 404 is positive absence — the other repo\'s issue still dispatches', async () => {
    const d = makeDispatcher({
      flatFrontier: async () => [],
      fetchIssue: async (repo) => {
        if (repo === 'o/r1') throw new Error('gh: HTTP 404: Not Found (https://api.github.com/repos/o/r1/issues/42)')
        return { ...OPEN_ISSUE }
      },
    }, twoRepos)

    const reply = await d.start('42', {})

    assert.match(reply, /dispatched o\/r2#42/)
  })
})

describe('an unverified ttyd listener is never published (F3)', () => {
  test('verified:false ⇒ assertServe is skipped AND the persisted serve rule is withdrawn', async () => {
    // `tailscale serve --bg` config persists in tailscaled across daemon
    // restarts — skipping assertServe alone leaves a prior run\'s rule live,
    // still publishing the unverified listener tailnet-wide
    const calls = []
    const d = makeDispatcher({
      ensureTtyd: async () => ({ verified: false }),
      assertServe: async () => { calls.push('serve') },
      serveOff: async ({ servePort }) => { calls.push(`off:${servePort}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(calls, ['off:8443'], 'no publish, and the stale rule is actively withdrawn')
  })

  test('verified:true ⇒ assertServe runs and nothing is withdrawn', async () => {
    const calls = []
    const d = makeDispatcher({
      ensureTtyd: async () => ({ verified: true }),
      assertServe: async () => { calls.push('serve') },
      serveOff: async ({ servePort }) => { calls.push(`off:${servePort}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(calls, ['serve'])
  })

  test('a failing withdrawal is non-fatal to reconcile and still never publishes', async () => {
    const calls = []
    const logs = []
    const d = makeDispatcher({
      ensureTtyd: async () => ({ verified: false }),
      assertServe: async () => { calls.push('serve') },
      serveOff: async () => { throw new Error('tailscale exploded') },
    })
    d.log = (...a) => logs.push(a.join(' '))

    await d.reconcile({ boot: false })

    assert.deepEqual(calls, [], 'assertServe must not run even when serveOff fails')
    assert.ok(logs.some((l) => /REMAINS PUBLISHED/.test(l)), 'the warning states plainly that the surface may still be published')
  })
})

// ---- #41: report_result now closes the TICKET, not just the lifecycle --------

describe('onResult acts on the SPAWN BINDING, never on the reported ticket number', () => {
  test('an agent naming someone else\'s ticket resolves its own, and the disagreement is journalled', async () => {
    const closed = []
    const d = makeDispatcher({ closeIssue: async (repo, n) => closed.push(`${repo}#${n}`) })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/nope/42', cfgDir: '/c', state: 'ready' })

    // this path closes issues and rewrites map bodies — `ticket` is
    // agent-supplied text and must never steer it
    await d.onResult('curia-42', { ticket: '99', status: 'resolved', summary: 'done' })

    assert.deepEqual(closed, ['o/r#42'], 'the repair closes the BOUND ticket; #99 is never touched')
    assert.ok(events.some((e) => e.type === 'result_ticket_mismatch' && e.bound === '42' && e.reported === '99'))
    assert.ok(events.some((e) => e.type === 'ticket_resolved' && e.ticket === '42'))
    assert.ok(!events.some((e) => e.type === 'ticket_resolved' && e.ticket === '99'))
  })

  // #103: every journalled mismatch to date was an agent naming ITS OWN ticket
  // in a repo-qualified or URL shape. Those are equal ids, not disagreements.
  test('a repo-qualified id for the bound ticket is not a mismatch', async () => {
    const d = makeDispatcher({ closeIssue: async () => {} })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/nope/42', cfgDir: '/c', state: 'ready' })
    await d.onResult('curia-42', { ticket: 'o/r#42', status: 'resolved', summary: 'done' })
    assert.ok(!events.some((e) => e.type === 'result_ticket_mismatch'))
  })

  test('the full issue URL for the bound ticket is not a mismatch', async () => {
    const d = makeDispatcher({ closeIssue: async () => {} })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/nope/42', cfgDir: '/c', state: 'ready' })
    await d.onResult('curia-42', { ticket: 'https://github.com/o/r/issues/42', status: 'resolved', summary: 'done' })
    assert.ok(!events.some((e) => e.type === 'result_ticket_mismatch'))
  })

  test('the same number in a DIFFERENT repo is still a mismatch', async () => {
    const d = makeDispatcher({ closeIssue: async () => {} })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/nope/42', cfgDir: '/c', state: 'ready' })
    await d.onResult('curia-42', { ticket: 'other/repo#42', status: 'resolved', summary: 'done' })
    assert.ok(events.some((e) => e.type === 'result_ticket_mismatch' && e.reported === 'other/repo#42'))
  })
})

describe('parseTicketRef', () => {
  test('accepts every shape agents have journalled', () => {
    assert.deepEqual(parseTicketRef('66'), { repo: null, number: '66' })
    assert.deepEqual(parseTicketRef('#66'), { repo: null, number: '66' })
    assert.deepEqual(parseTicketRef('alp82/curia#66'), { repo: 'alp82/curia', number: '66' })
    assert.deepEqual(parseTicketRef('https://github.com/alp82/alperortac.com/issues/74'), { repo: 'alp82/alperortac.com', number: '74' })
  })

  test('an unparseable id yields no number, which reads as a mismatch', () => {
    assert.deepEqual(parseTicketRef('the landing page ticket'), { repo: null, number: null })
  })
})

describe('onResult falls back to the journal when the agent record is gone', () => {
  test('an agent whose record this process never held still resolves, via the journal epoch', async () => {
    fs.writeFileSync(
      path.join(tmp, 'data', 'events.jsonl'),
      JSON.stringify({ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }) + '\n',
    )
    const d = makeDispatcher()
    const text = await d.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'done' })
    assert.ok(events.some((e) => e.type === 'ticket_resolved' && e.repo === 'o/r' && e.ticket === '42'))
    assert.match(text, /ticket closed/)
  })

  test('an agent whose repo cannot be determined touches nothing', async () => {
    const d = makeDispatcher({ closeIssue: async () => { throw new Error('must not be called') } })
    const text = await d.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'done' })
    assert.match(text, /could not tell which repo/)
    assert.ok(events.some((e) => e.type === 'resolve_skipped'))
  })
})

describe('a non-clean result resolves nothing AND hands the ticket back (#41)', () => {
  const agent = () => ({ repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready' })

  test('blocked: claim released, reason noted on the ticket, nothing closed or pushed', async () => {
    const acts = []
    const d = makeDispatcher({
      unclaim: async (repo, n) => acts.push(`unclaim:${repo}#${n}`),
      commentIssue: async (repo, n, body) => acts.push({ comment: `${repo}#${n}`, body }),
      closeIssue: async () => acts.push('close'),
      pushBranch: async () => acts.push('push'),
      removeCredentials: () => acts.push('credentials'),
    })
    d.agents.set('curia-42', agent())

    const text = await d.onResult('curia-42', { ticket: '42', status: 'blocked', summary: 'need a human' })

    assert.ok(acts.includes('unclaim:o/r#42'), 'before #41 the claim was kept and the ticket vanished from every frontier')
    assert.ok(!acts.includes('close') && !acts.includes('push'))
    // the agent is still alive here — taking its credential copy now kills its
    // next model turn (#34)
    assert.ok(!acts.includes('credentials'), 'a live agent keeps its credentials')
    const note = acts.find((a) => a.comment)
    assert.match(note.body, /did \*\*not\*\* resolve/)
    assert.match(note.body, /need a human/)
    assert.ok(events.some((e) => e.type === 'dispatch_unclaimed'))
    assert.ok(events.some((e) => e.type === 'nonclean_noted' && e.released === true && e.noted === true))
    assert.match(text, /nothing was resolved or pushed/)
    assert.match(notifies.at(-1).message, /NOT resolved/)
  })

  test('blocked with a failing unclaim: the note and the thread both say the ticket is still assigned', async () => {
    let body = null
    const d = makeDispatcher({
      unclaim: async () => { throw new Error('gh: HTTP 502') },
      commentIssue: async (repo, n, b) => { body = b },
    })
    d.agents.set('curia-42', agent())

    await d.onResult('curia-42', { ticket: '42', status: 'blocked', summary: 'stuck' })

    assert.match(body, /Releasing its claim FAILED/)
    assert.ok(events.some((e) => e.type === 'unclaim_failed'))
    assert.ok(!events.some((e) => e.type === 'dispatch_unclaimed'))
    assert.match(notifies.at(-1).message, /claim release FAILED/)
  })

  test('a note that cannot be posted still releases the claim, and says which half failed', async () => {
    const d = makeDispatcher({
      commentIssue: async () => { throw new Error('gh: HTTP 403') },
    })
    d.agents.set('curia-42', agent())

    await d.onResult('curia-42', { ticket: '42', status: 'aborted', summary: 'cancelled' })

    assert.ok(events.some((e) => e.type === 'nonclean_noted' && e.released === true && e.noted === false))
    assert.match(notifies.at(-1).message, /the note could not be posted/)
  })
})

describe('two agents resolving into one map body do not lose each other\'s pointer (#41)', () => {
  test('the map lock serialises read-modify-write; both pointers survive', async () => {
    const MAP = [
      '## Decisions so far', '', '- [older](https://github.com/o/r/issues/7) — done', '', '## Not yet specified', '',
    ].join('\n')
    const issues = {
      1: { number: 1, title: 'map', state: 'open', labels: [{ name: 'wayfinder:map' }], body: MAP },
      42: { number: 42, title: 'forty-two', state: 'closed', html_url: 'https://github.com/o/r/issues/42', parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' },
      43: { number: 43, title: 'forty-three', state: 'closed', html_url: 'https://github.com/o/r/issues/43', parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' },
    }
    const d = makeDispatcher({
      fetchIssue: async (repo, n) => ({ ...issues[String(n)] }),
      issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T00:00:00Z' }],
      // a slow write is what turns a read-modify-write race from theoretical
      // into reproducible
      setIssueBody: async (repo, n, body) => {
        await new Promise((r) => setTimeout(r, 30))
        issues[String(n)].body = body
      },
    })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/nope', cfgDir: '/c', state: 'ready' })
    d.agents.set('curia-43', { repo: 'o/r', ticket: '43', session: 'curia-43', wtPath: '/nope', cfgDir: '/c', state: 'ready' })

    await Promise.all([
      d.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'answer A' }),
      d.onResult('curia-43', { ticket: '43', status: 'resolved', summary: 'answer B' }),
    ])

    const body = issues['1'].body
    assert.match(body, /issues\/42\) — answer A/)
    assert.match(body, /issues\/43\) — answer B/)
    assert.match(body, /issues\/7\) — done/, 'the pre-existing decision is untouched')
    assert.equal(body.split('\n').filter((l) => /^## /.test(l)).length, 2, 'the section structure survives both writes')
  })
})

describe('the orphan sweep cannot destroy unlanded work (#41)', () => {
  function writeJournal(lines) {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  test('a live session that already reported a result is a finishing agent, not an orphan', async () => {
    // The agent resolved its ticket, so the issue is CLOSED and its claim may
    // already be gone — every positive-evidence test reads "orphan" while the
    // worktree still holds commits the daemon has not pushed.
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' },
      { type: 'result', agent: 'curia-42', ticket: '42', status: 'resolved' },
    ])
    const destroyed = []
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', assignees: [] }),
      killSession: async (n) => destroyed.push(`kill:${n}`),
      removeWorktree: async (b, wt) => destroyed.push(`worktree:${wt}`),
      removeConfigDir: (dir) => destroyed.push(`cfg:${dir}`),
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(destroyed, [])
    assert.ok(events.some((e) => e.type === 'orphan_sweep_skipped' && e.agent === 'curia-42'))
    assert.ok(!typesOf().includes('orphan_swept'))
  })

  test('a config-dir rm that races the dying agent does not abort the pass (#74, found live)', async () => {
    // The swept agent can still be flushing its transcript while rmSync walks
    // the dir — ENOTEMPTY. The throw used to abort the whole reconcile,
    // including the attach/timeline surface asserts that run at its end.
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }])
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', assignees: [] }),
      killSession: async () => {},
      removeWorktree: async () => {},
      removeConfigDir: () => { throw new Error('ENOTEMPTY, Directory not empty') },
      hasUnpushedWork: async () => false,
    })
    let surfacesAsserted = false
    d.timeline = { assert: async () => { surfacesAsserted = true; return { verified: true } } }

    await d.reconcile({ boot: false })

    assert.ok(typesOf().includes('orphan_swept'))
    assert.ok(surfacesAsserted, 'the surface asserts at the end of the pass still ran')
  })

  test('a genuine orphan whose branch holds unpushed commits keeps its worktree', async () => {
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }])
    const destroyed = []
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', assignees: [] }),
      killSession: async (n) => destroyed.push(`kill:${n}`),
      removeWorktree: async (b, wt) => destroyed.push(`worktree:${wt}`),
      removeConfigDir: () => {},
      hasUnpushedWork: async () => true,
    })

    await d.reconcile({ boot: false })

    assert.ok(typesOf().includes('orphan_swept'), 'the session is still swept')
    assert.deepEqual(destroyed.filter((x) => x.startsWith('worktree:')), [], 'but the only copy of the work survives')
    assert.ok(events.some((e) => e.type === 'orphan_worktree_kept' && /commits that exist nowhere else/.test(e.reason)))
  })

  test('an indeterminate unpushed-work check keeps the worktree too', async () => {
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }])
    const destroyed = []
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', assignees: [] }),
      killSession: async () => {},
      removeWorktree: async (b, wt) => destroyed.push(wt),
      removeConfigDir: () => {},
      hasUnpushedWork: async () => { throw new Error('git exploded') },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(destroyed, [], '"cannot tell" is not "nothing there"')
    assert.ok(events.some((e) => e.type === 'orphan_worktree_kept' && /could not tell/.test(e.reason)))
  })

  test('an orphan with nothing unlanded is still cleaned up in full', async () => {
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }])
    const destroyed = []
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', assignees: [] }),
      killSession: async (n) => destroyed.push(`kill:${n}`),
      removeWorktree: async (b, wt) => destroyed.push(`worktree:${wt}`),
      removeConfigDir: (dir) => destroyed.push(`cfg:${path.basename(dir)}`),
      hasUnpushedWork: async () => false,
    })

    await d.reconcile({ boot: false })

    assert.ok(typesOf().includes('orphan_swept'))
    assert.ok(destroyed.some((x) => x.startsWith('worktree:')))
    assert.ok(!typesOf().includes('orphan_worktree_kept'))
  })
})

describe('the spawn prompt names the parent map (#41)', () => {
  test('a map child is prompted with its map number; the parent lookup rides the issue payload', async () => {
    let prompt = null
    const d = makeDispatcher({
      fetchIssue: async (repo, n) => (String(n) === '1'
        ? { number: 1, title: 'map', state: 'open', labels: [{ name: 'wayfinder:map' }] }
        : { ...OPEN_ISSUE, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' }),
      writePrompt: (cfgDir, issue, opts) => { prompt = opts; return '/p' },
    }, { readyTimeoutS: 0 })

    await d.start('42', { repo: 'o/r' })
    assert.equal(prompt.mapNumber, 1)
  })

  test('a parent that is not a map, and an unreadable parent, both prompt without one', async () => {
    let prompt = null
    const d = makeDispatcher({
      fetchIssue: async (repo, n) => (String(n) === '1'
        ? { number: 1, title: 'ordinary parent', state: 'open', labels: [] }
        : { ...OPEN_ISSUE, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' }),
      writePrompt: (cfgDir, issue, opts) => { prompt = opts; return '/p' },
    }, { readyTimeoutS: 0 })
    await d.start('42', { repo: 'o/r' })
    assert.equal(prompt.mapNumber, null)

    prompt = null
    const d2 = makeDispatcher({
      fetchIssue: async (repo, n) => {
        if (String(n) === '1') throw new Error('HTTP 502')
        return { ...OPEN_ISSUE, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' }
      },
      writePrompt: (cfgDir, issue, opts) => { prompt = opts; return '/p' },
    }, { readyTimeoutS: 0 })
    await d2.start('42', { repo: 'o/r' })
    assert.equal(prompt.mapNumber, null, 'a failed read must not invent a map for the agent to edit')
  })
})

// #57: an agent had no skills at all, and no guard against the wayfinder skill
// falling back to the local-markdown tracker in a repo that carries no
// docs/agents/issue-tracker.md.
describe('the agent skill set and the tracker prerequisite (#57)', () => {
  const MAP_CHILD = { ...OPEN_ISSUE, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' }
  const MAP = { number: 1, title: 'map', state: 'open', labels: [{ name: 'wayfinder:map' }] }

  test('the configured skill set reaches seedConfigDir', async () => {
    const skills = { root: '/host/skills', install: ['wayfinder', 'tdd'] }
    let seeded = null
    const d = makeDispatcher({
      seedConfigDir: (cfgDir, wtPath, s) => { seeded = s },
    }, { readyTimeoutS: 0, skills })

    await d.start('42', { repo: 'o/r' })
    assert.deepEqual(seeded, skills)
  })

  test('a map child in a repo with no tracker doc is refused, and the claim released', async () => {
    let unclaimed = null
    const d = makeDispatcher({
      fetchIssue: async (repo, n) => (String(n) === '1' ? MAP : { ...MAP_CHILD }),
      // the doc-less repo: a worktree with no docs/agents/issue-tracker.md
      createWorktree: async (b, n) => {
        const wt = path.join(path.dirname(b), 'wt', String(n))
        fs.mkdirSync(wt, { recursive: true })
        return wt
      },
      unclaim: async (repo, n) => { unclaimed = `${repo}#${n}` },
      newSession: async () => { throw new Error('a refused dispatch must never spawn') },
    }, { readyTimeoutS: 0 })

    const reply = await d.start('42', { repo: 'o/r' })

    assert.match(reply, /issue-tracker\.md/)
    assert.match(reply, /setup-matt-pocock-skills/)
    assert.equal(unclaimed, 'o/r#42', 'never leave a claim on a ticket no agent will run')
    assert.ok(typesOf().includes('dispatch_unclaimed'))
    assert.ok(!typesOf().includes('agent_spawned'))
  })

  test('a plain ticket in the same repo still dispatches, and the absence is journalled', async () => {
    const d = makeDispatcher({
      // no parent ⇒ no map ⇒ no wayfinder invocation ⇒ nothing to fall back
      createWorktree: async (b, n) => {
        const wt = path.join(path.dirname(b), 'wt', String(n))
        fs.mkdirSync(wt, { recursive: true })
        return wt
      },
    }, { readyTimeoutS: 0 })

    const reply = await d.start('42', { repo: 'o/r' })

    assert.match(reply, /dispatched/, 'the flat lane watches ANY plain repo (#10) — do not take it away')
    assert.ok(typesOf().includes('agent_spawned'))
    assert.ok(typesOf().includes('tracker_doc_missing'), 'the absence stays on the record')
  })

  test('a map child in a repo that HAS the doc dispatches unremarked', async () => {
    const d = makeDispatcher({
      fetchIssue: async (repo, n) => (String(n) === '1' ? MAP : { ...MAP_CHILD }),
    }, { readyTimeoutS: 0 })

    const reply = await d.start('42', { repo: 'o/r' })

    assert.match(reply, /dispatched/)
    assert.ok(!typesOf().includes('tracker_doc_missing'))
  })
})

// ---- the merge-gated ending (#54) --------------------------------------------

function journalTo(lines) {
  fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

// A live agent record with a real worktree on disk, the shape every tool body
// below resolves its binding from.
function liveAgent(d, over = {}) {
  const wt = path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42')
  fs.mkdirSync(wt, { recursive: true })
  const w = {
    repo: 'o/r', ticket: '42', title: 'a ticket', session: 'curia-42', wtPath: wt,
    cfgDir: path.join(tmp, 'work', 'cfg', 'curia-42'), model: 'opus',
    state: 'ready', resultReceived: false, spawnedAt: Date.now(),
    // an agent that got as far as the ending has a tool channel by definition
    // (#194) — it took one to open the pull request and ask for the review
    mcpSeenAt: Date.now(), ...over,
  }
  d.agents.set('curia-42', w)
  return w
}

describe('open_pull_request (#54 item 1)', () => {
  test('it pushes, opens the PR, comments the link on the OPEN ticket, and points at the gate', async () => {
    const calls = []
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'abc1234', subject: 'do it' }],
      pushBranch: async (wt, repo, branch) => { calls.push(`push:${branch}`); return 'abc1234' },
      createPullRequest: async () => { calls.push('create'); return 'https://github.com/o/r/pull/7' },
      commentIssue: async (repo, n, body) => { calls.push(`comment:${/curia:machine/.test(body) ? 'marked' : 'BARE'}`) },
    })
    const w = liveAgent(d)

    const reply = await d.openPullRequest('curia-42', { summary: 'what it does' })

    assert.match(reply, /opened https:\/\/github\.com\/o\/r\/pull\/7/)
    assert.match(reply, /Next: request_review/)
    assert.deepEqual(calls, ['push:curia/42', 'create', 'comment:marked'])
    assert.equal(w.prUrl, 'https://github.com/o/r/pull/7')
    assert.ok(typesOf().includes('pr_opened'))
  })

  test('a second call updates the same pull request — the rejection loop opens one, not one per round', async () => {
    const calls = []
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'abc1234', subject: 'do it' }],
      findPullRequest: async () => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }),
      setPullRequestBody: async () => { calls.push('edit') },
      createPullRequest: async () => { calls.push('create'); return 'x' },
    })
    liveAgent(d)

    const reply = await d.openPullRequest('curia-42', { summary: 's' })
    assert.match(reply, /updated https/)
    assert.deepEqual(calls, ['edit'])
  })

  test('no commits refuses without pushing, and says what to do instead', async () => {
    const d = makeDispatcher({ commitsOnBranch: async () => [] })
    liveAgent(d)
    const reply = await d.openPullRequest('curia-42', { summary: 's' })
    assert.match(reply, /no commits.*Commit your work first/s)
  })

  test('a failed push tells the agent its commits are safe, and journals the failure', async () => {
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'a', subject: 's' }],
      pushBranch: async () => { throw new Error('permission denied') },
    })
    liveAgent(d)
    const reply = await d.openPullRequest('curia-42', { summary: 's' })
    assert.match(reply, /could not land `curia\/42`: permission denied/)
    assert.match(reply, /commits are safe in the worktree/)
    assert.ok(typesOf().includes('land_failed'))
  })
})

describe('request_review: the one gate (#54 item 2)', () => {
  test('every link is composed by the daemon — the agent passes none', async () => {
    let asked = null
    const d = makeDispatcher({
      findPullRequest: async () => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }),
    }, { askReview: async (agent, ticket, text) => { asked = { agent, ticket, text }; return { text: 'approve', status: 'answered' } } })
    liveAgent(d)
    // an ALLOCATED preview, not a string the agent handed over (#40's limit)
    d.previews = { get: () => ({ servePort: 8500, devPort: 5173, url: 'https://box.ts.net:8500/' }) }

    const r = await d.requestReview('curia-42', { summary: 'did it', charting: 'create "next"' })

    assert.equal(asked.agent, 'curia-42')
    assert.equal(asked.ticket, '42')
    assert.match(asked.text, /Ticket: https:\/\/github\.com\/o\/r\/issues\/42/)
    assert.match(asked.text, /Pull request \(\*\*OPEN\*\*\): https:\/\/github\.com\/o\/r\/pull\/7/)
    assert.match(asked.text, /Preview: https:\/\/box\.ts\.net:8500\//)
    assert.match(asked.text, /create "next"/)
    assert.equal(r.approved, true)
    assert.match(r.text, /APPROVED/)
    assert.match(r.text, /gh pr merge <url> --repo o\/r --squash --delete-branch/)
  })

  test('a ticket with no code says so rather than inventing a link', async () => {
    let asked = null
    const d = makeDispatcher({}, { askReview: async (w, t, text) => { asked = text; return { text: 'approve', status: 'answered' } } })
    liveAgent(d)
    const r = await d.requestReview('curia-42', { summary: 'a grilling answer', charting: 'none' })
    assert.match(asked, /No pull request — this ticket produced no code/)
    assert.equal(r.approved, true)
  })

  test('an approval is journalled as a fact the Stop hook can check', async () => {
    const d = makeDispatcher({}, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d)
    await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.ok(events.some((e) => e.type === 'review_requested'))
    assert.ok(events.some((e) => e.type === 'review_answered' && e.approved === true))
  })

  test('a rejection returns the human words as feedback and forbids merging', async () => {
    const d = makeDispatcher({}, { askReview: async () => ({ text: 'rename the flag', status: 'answered' }) })
    liveAgent(d)
    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(r.approved, false)
    assert.match(r.text, /NOT approved/)
    assert.match(r.text, /rename the flag/)
    assert.match(r.text, /Do not merge and do not resolve/)
    assert.match(r.text, /open_pull_request again, then\nrequest_review again/)
    assert.ok(events.some((e) => e.type === 'review_answered' && e.approved === false))
  })

  test('a cancelled gate is not a rejection: nothing is merged and nothing resolved', async () => {
    const d = makeDispatcher({}, { askReview: async () => ({ text: 'aborted: a human cancelled this escalation', status: 'cancelled' }) })
    liveAgent(d)
    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.equal(r.aborted, true)
    assert.match(r.text, /was cancelled, not answered/)
    assert.ok(events.some((e) => e.type === 'review_answered' && e.approved === false && e.status === 'cancelled'))
  })

  test('the agent reads *awaiting review* while it is blocked on the gate', async () => {
    let seen = null
    const d = makeDispatcher({}, {
      askReview: async () => { seen = d.agents.get('curia-42').state; return { text: 'approve', status: 'answered' } },
    })
    liveAgent(d)
    await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.equal(seen, 'awaiting-review')
  })

  test('/status reads awaiting-review off the open escalation, so an adopted agent is right too', async () => {
    const d = makeDispatcher()
    liveAgent(d, { state: 'ready' })
    escalations.push({ id: 'esc-9', agent: 'curia-42', ticket: '42', kind: 'review-gate', status: 'open' })
    const { agents } = await d.status()
    assert.equal(agents[0].state, 'awaiting-review')
  })
})

describe('the Stop hook enforces the ending (#54 item 4)', () => {
  test('#47 stays first: a turn that ends on an open escalation is a block, never a stop-block', async () => {
    const d = makeDispatcher({ hasSession: async () => true })
    liveAgent(d)
    escalations.push({ id: 'esc-1', agent: 'curia-42', ticket: '42', kind: 'free-text', status: 'open' })

    const decision = await d.onStopHook('curia-42', {})

    assert.deepEqual(decision, { allow: true, terminal: false })
    assert.ok(typesOf().includes('agent_blocked_on_human'))
    assert.ok(!typesOf().includes('stop_blocked'), 'an agent waiting on a human must not be told to keep working')
    assert.equal(d.agents.get('curia-42').state, 'blocked')
  })

  test('an agent blocked on the GATE reads awaiting-review, distinguishably', async () => {
    const d = makeDispatcher({ hasSession: async () => true })
    liveAgent(d)
    escalations.push({ id: 'esc-1', agent: 'curia-42', ticket: '42', kind: 'review-gate', status: 'open' })

    await d.onStopHook('curia-42', {})

    assert.equal(d.agents.get('curia-42').state, 'awaiting-review')
    assert.ok(events.some((e) => e.type === 'agent_blocked_on_human' && e.awaiting_review === true))
  })

  test('an agent that stops before the gate is blocked with its outstanding checklist', async () => {
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const d = makeDispatcher({ commitsOnBranch: async () => [{ sha: 'a', subject: 's' }] })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})

    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /open_pull_request/)
    assert.match(decision.reason, /request_review/)
    assert.match(decision.reason, /report_result/)
    assert.match(decision.reason, /nudge 1 of 3/)
    assert.ok(events.some((e) => e.type === 'stop_blocked' && e.attempt === 1))
  })

  test('a merged, reported ticket is allowed to stop and closes the lifecycle', async () => {
    journalTo([
      { type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' },
      { type: 'pr_opened', ticket: '42', repo: 'o/r', agent: 'curia-42' },
      { type: 'review_answered', ticket: '42', agent: 'curia-42', approved: true },
    ])
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'a', subject: 's' }],
      findPullRequest: async () => ({ number: 7, url: 'u', state: 'MERGED' }),
    })
    liveAgent(d, { resultReceived: true })

    assert.deepEqual(await d.onStopHook('curia-42', {}), { allow: true, terminal: true })
    assert.ok(!typesOf().includes('stop_blocked'))
  })

  test('an approved but unmerged pull request holds the agent for the merge', async () => {
    journalTo([
      { type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' },
      { type: 'pr_opened', ticket: '42', repo: 'o/r', agent: 'curia-42' },
      { type: 'review_answered', ticket: '42', agent: 'curia-42', approved: true },
    ])
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'a', subject: 's' }],
      findPullRequest: async () => ({ number: 7, url: 'u', state: 'OPEN' }),
    })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})
    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /merge the approved pull request/)
  })

  test('past the nudge budget the stop is allowed, loudly — an agent that cannot comply never loops on quota', async () => {
    journalTo([
      { type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' },
      { type: 'stop_blocked', ticket: '42', agent: 'curia-42', attempt: 1 },
      { type: 'stop_blocked', ticket: '42', agent: 'curia-42', attempt: 2 },
    ])
    const d = makeDispatcher({}, { stopNudgeBudget: 2 })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', { stopHookActive: true })

    assert.deepEqual(decision, { allow: true, terminal: true })
    assert.ok(events.some((e) => e.type === 'stop_budget_exhausted' && e.blocks === 2))
    assert.match(notifies.at(-1).message, /no longer holding it/)
  })

  test('an unreadable git log drops the pull-request item rather than trapping the agent', async () => {
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const d = makeDispatcher({ commitsOnBranch: async () => { throw new Error('index.lock') } })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})
    assert.equal(decision.decision, 'block')
    assert.ok(!/open_pull_request/.test(decision.reason), 'a failed read must not add work')
  })

  test('an agent with no binding is let go rather than held forever', async () => {
    const d = makeDispatcher()
    assert.deepEqual(await d.onStopHook('curia-lab', {}), { allow: true, terminal: true })
  })
})

describe('merge ends the workspace lease (#54 item 7)', () => {
  const withResult = (d) => fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{"status":"resolved"}')

  test('a merged pull request releases the worktree and repairs the remote branch', async () => {
    const done = []
    const d = makeDispatcher({
      findPullRequest: async () => ({ number: 7, url: 'https://x/pull/7', state: 'MERGED' }),
      removeWorktree: async (base, wt) => { done.push(`rm:${path.basename(wt)}`) },
      deleteRemoteBranch: async (repo, branch) => { done.push(`del:${branch}`); return { deleted: true } },
    })
    liveAgent(d)
    withResult(d)

    await d.onAgentDone('curia-42')

    assert.deepEqual(done, ['rm:42', 'del:curia/42'])
    assert.ok(events.some((e) => e.type === 'lease_released' && e.merged === true))
    assert.match(notifies.at(-1).message, /is merged — worktree removed, remote `curia\/42` deleted/)
  })

  test('an UNMERGED pull request keeps the worktree and the branch, loudly', async () => {
    let removed = false
    const d = makeDispatcher({
      findPullRequest: async () => ({ number: 7, url: 'https://x/pull/7', state: 'OPEN' }),
      removeWorktree: async () => { removed = true },
    })
    liveAgent(d)
    withResult(d)

    await d.onAgentDone('curia-42')

    assert.equal(removed, false, 'the worktree may hold the only copy of unlanded work')
    assert.ok(events.some((e) => e.type === 'lease_kept'))
    assert.match(notifies.at(-1).message, /KEPT.*is \*\*OPEN\*\*, not merged/)
  })

  test('an unreadable pull-request state keeps the workspace — "cannot tell" is not "merged"', async () => {
    let removed = false
    const d = makeDispatcher({
      findPullRequest: async () => { throw new Error('HTTP 502') },
      removeWorktree: async () => { removed = true },
    })
    liveAgent(d)
    withResult(d)

    await d.onAgentDone('curia-42')

    assert.equal(removed, false)
    assert.ok(events.some((e) => e.type === 'lease_kept' && /502/.test(e.reason)))
  })

  test('a ticket that produced no code releases its worktree without a pull request', async () => {
    let removed = false
    const d = makeDispatcher({
      findPullRequest: async () => null,
      commitsOnBranch: async () => [],
      removeWorktree: async () => { removed = true },
      deleteRemoteBranch: async () => { throw new Error('must not be called — there is no branch to delete') },
    })
    liveAgent(d)
    withResult(d)

    await d.onAgentDone('curia-42')

    assert.equal(removed, true)
    assert.ok(events.some((e) => e.type === 'lease_released' && e.merged === false))
  })

  test('no pull request but commits on the branch keeps everything', async () => {
    let removed = false
    const d = makeDispatcher({
      findPullRequest: async () => null,
      commitsOnBranch: async () => [{ sha: 'a', subject: 's' }],
      removeWorktree: async () => { removed = true },
    })
    liveAgent(d)
    withResult(d)

    await d.onAgentDone('curia-42')

    assert.equal(removed, false)
    assert.match(notifies.at(-1).message, /cannot rule out unlanded commits/)
  })
})

describe('awaiting review is not a dead claim (#54 item 5)', () => {
  const assignedToMe = { ...OPEN_ISSUE, assignees: [{ login: 'me' }] }

  test('an open pull request from curia/<n> keeps the claim', async () => {
    // open + assigned + no live session + no result is ALSO the shape of a
    // agent whose box rebooted while a human sat on the gate.
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const unclaimed = []
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...assignedToMe }),
      findPullRequest: async () => ({ number: 7, url: 'https://x/pull/7', state: 'OPEN' }),
      unclaim: async (repo, n) => { unclaimed.push(String(n)) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, [])
    assert.ok(events.some((e) => e.type === 'dead_claim_kept_awaiting_review'))
  })

  test('a merged pull request does not keep it — that claim really is dead', async () => {
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const unclaimed = []
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...assignedToMe }),
      findPullRequest: async () => ({ number: 7, url: 'u', state: 'MERGED' }),
      unclaim: async (repo, n) => { unclaimed.push(String(n)) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, ['42'])
    assert.ok(events.some((e) => e.type === 'dead_claim_released'))
  })

  test('an unreadable pull-request state releases nothing this pass', async () => {
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const unclaimed = []
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...assignedToMe }),
      findPullRequest: async () => { throw new Error('HTTP 502') },
      unclaim: async (repo, n) => { unclaimed.push(String(n)) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, [])
    assert.ok(events.some((e) => e.type === 'reconcile_repo_skipped'))
  })
})

describe('the gate the Stop hook cannot enforce', () => {
  test('a resolve with no approved review is journalled and said out loud', async () => {
    // report_result ends the Stop checklist, so an agent that skips straight from
    // the work to comment-close-report is never held. Nothing can un-resolve it;
    // the daemon can refuse to call it reviewed.
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', html_url: 'u' }),
      issueComments: async () => [{ user: { login: 'me' }, created_at: '2999-01-01T00:00:00Z', body: 'resolution' }],
      commitsOnBranch: async () => [],
    })
    liveAgent(d)

    const text = await d.onResult('curia-42', { status: 'resolved', summary: 's' })

    assert.ok(events.some((e) => e.type === 'resolved_unreviewed'))
    assert.match(text, /NO approved review gate/)
  })

  test('a resolve WITH an approval this epoch says nothing extra', async () => {
    journalTo([
      { type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' },
      { type: 'review_answered', ticket: '42', agent: 'curia-42', approved: true },
    ])
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', html_url: 'u' }),
      issueComments: async () => [{ user: { login: 'me' }, created_at: '2999-01-01T00:00:00Z', body: 'resolution' }],
      commitsOnBranch: async () => [],
    })
    liveAgent(d)

    const text = await d.onResult('curia-42', { status: 'resolved', summary: 's' })

    assert.ok(!events.some((e) => e.type === 'resolved_unreviewed'))
    assert.ok(!/NO approved review gate/.test(text))
  })

  test("an approval from an EARLIER dispatch does not count for this one", async () => {
    journalTo([
      { type: 'review_answered', ticket: '42', agent: 'curia-42', approved: true },
      { type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' },
    ])
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', html_url: 'u' }),
      issueComments: async () => [{ user: { login: 'me' }, created_at: '2999-01-01T00:00:00Z', body: 'resolution' }],
      commitsOnBranch: async () => [],
    })
    liveAgent(d)

    await d.onResult('curia-42', { status: 'resolved', summary: 's' })
    assert.ok(events.some((e) => e.type === 'resolved_unreviewed'))
  })
})

// ---- two harnesses (#39) ------------------------------------------------------

const TWO_LANE = {
  defaults: { untyped: 'sonnet', research: 'gpt' },
  models: {
    sonnet: { provider: 'anthropic', harness: 'claude' },
    gpt: { provider: 'openai', harness: 'codex', id: 'gpt-5.5' },
  },
  fallbacks: { sonnet: ['gpt'], gpt: ['sonnet'] },
  harnesses: {
    claude: {
      template: 'claude --model {model} "$(cat {prompt_file})"',
      ready: '⏵⏵|bypass permissions', toolChannelGraceS: 15, readyRe: /⏵⏵|bypass permissions/,
    },
    codex: {
      template: 'codex --model {model} "$(cat {prompt_file})"',
      ready: '·\\s[~/]', toolChannelGraceS: 15, readyRe: /·\s[~/]/,
    },
  },
}

describe('dispatching across two harnesses (#39)', () => {
  test('a research ticket seeds and spawns the codex harness end to end', async () => {
    const seeded = []
    const harnessed = []
    let spawn = null
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      seedConfigDir: (cfg, wt, s, harness) => seeded.push(harness),
      writeConnectionSettings: (opts) => harnessed.push(opts.harness),
      newSession: async (opts) => { spawn = opts },
    }, { routing: TWO_LANE })

    await d.start('42', { repo: 'o/r', by: 'test' })
    assert.deepEqual(seeded, ['codex'])
    assert.deepEqual(harnessed, ['codex'])
    // the CLI model id, not the routing name
    assert.match(spawn.shellCmd, /codex --model gpt-5\.5/)
    // and the codex isolation variable, with no Claude one alongside it
    assert.deepEqual(Object.keys(spawn.env), ['CODEX_HOME'])
  })

  // The bug this ordering fixes: `harness` used to be read off the REQUESTED
  // model. With one harness that was invisible; with two it would seed a claude
  // config dir and then spawn codex into it.
  test('the harness follows the model actually spawned, not the one asked for', async () => {
    const seeded = []
    let spawn = null
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [] }),
      seedConfigDir: (cfg, wt, s, harness) => seeded.push(harness),
      newSession: async (opts) => { spawn = opts },
    }, { routing: TWO_LANE })
    // untyped → sonnet (claude), but anthropic is cooling, so gpt (codex) runs
    d.cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))

    await d.start('42', { repo: 'o/r', by: 'test' })
    assert.deepEqual(seeded, ['codex'])
    assert.match(spawn.shellCmd, /codex --model gpt-5\.5/)
  })

  test('a codex composer is read as ready, and a claude pane is not read by the codex marker', async () => {
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      capturePane: async () => 'working\n\n> Implement {feature}\n\n  gpt-5.5 low · ~/curia-work/repos/o__r/wt/42\n',
    }, { routing: TWO_LANE, readyTimeoutS: 6 })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await new Promise((r) => setTimeout(r, 2600))
    assert.ok(events.some((e) => e.type === 'agent_ready' && e.model === 'gpt'))
    assert.equal(events.some((e) => e.type === 'agent_ready_timeout'), false)
  })

  // A cap hit on one provider is now a hand-off, not exhaustion — and the
  // hand-off changes harnesses, so the config dir has to be rebuilt for the new one.
  test('a codex cap hit re-seeds the claude harness before respawning on it', async () => {
    const seeded = []
    const harnessed = []
    const spawns = []
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      seedConfigDir: (cfg, wt, s, harness) => seeded.push(harness),
      writeConnectionSettings: (opts) => harnessed.push(opts.harness),
      newSession: async (opts) => { spawns.push(opts) },
      capturePane: async () => "You've hit your usage limit. Upgrade to Plus to continue using Codex\n",
    }, { routing: TWO_LANE, readyTimeoutS: 6 })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await new Promise((r) => setTimeout(r, 2600))

    assert.deepEqual(seeded, ['codex', 'claude'])
    assert.deepEqual(harnessed, ['codex', 'claude'])
    assert.ok(events.some((e) => e.type === 'provider_cooling' && e.provider === 'openai'))
    assert.match(spawns[1].shellCmd, /claude --model sonnet/)
    assert.deepEqual(Object.keys(spawns[1].env).sort(), ['CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'])
    // and the watchdog that follows must read the NEW harness's marker
    assert.ok(events.some((e) => e.type === 'agent_spawned' && e.harness === 'claude'))
  })

  // #175: the codex pane states no reset instant, so this harness cooled a blind
  // hour. Its transcript states one, on the `token_count` event the status bars
  // already read. The shape below is the one usage.test.mjs pins.
  const CAP_PANE = "You've hit your usage limit. Upgrade to Plus to continue using Codex\n"
  const HOUR = 3600_000

  const writeRollout = (cfgDir, { usedPct, windowMinutes, resetsInMinutes }) => {
    const day = path.join(cfgDir, 'sessions', '2026', '08', '03')
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(path.join(day, 'rollout-2026-08-03T11-00-00-a.jsonl'), `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 4000 }, model_context_window: 258400 },
        rate_limits: {
          primary: {
            used_percent: usedPct,
            window_minutes: windowMinutes,
            resets_at: Math.round((Date.now() + resetsInMinutes * 60_000) / 1000),
          },
        },
      },
    })}\n`)
  }

  test('a codex cap hit cools until the reset its own transcript states', async () => {
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      // The transcript the capped agent has already written, taken at its last
      // turn: the 5 h window is spent and states when it rolls.
      seedConfigDir: (cfgDir, wt, s, harness) => {
        if (harness === 'codex') writeRollout(cfgDir, { usedPct: 100, windowMinutes: 300, resetsInMinutes: 12 })
      },
      capturePane: async () => CAP_PANE,
    }, { routing: TWO_LANE, readyTimeoutS: 6 })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => events.some((e) => e.type === 'provider_cooling'))

    const cooled = events.find((e) => e.type === 'provider_cooling')
    assert.equal(cooled.reset_source, 'transcript')
    const waited = Date.parse(cooled.reset_at) - Date.now()
    assert.ok(waited > 10 * 60_000 && waited < 14 * 60_000, `cooled for ${Math.round(waited / 60_000)} min, not the stated 12`)
    assert.equal(events.some((e) => e.type === 'reset_unparseable'), false)
  })

  test('an agent capped before its first turn keeps the one-hour floor', async () => {
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      capturePane: async () => CAP_PANE,
    }, { routing: TWO_LANE, readyTimeoutS: 6 })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => events.some((e) => e.type === 'provider_cooling'))

    const cooled = events.find((e) => e.type === 'provider_cooling')
    assert.equal(cooled.reset_source, 'floor')
    assert.ok(Math.abs(Date.parse(cooled.reset_at) - (Date.now() + HOUR)) < 5000)
    assert.ok(events.some((e) => e.type === 'reset_unparseable' && e.applied_cooldown_h === 1))
  })

  test('a window with room states nothing, so the floor stands', async () => {
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      // 41% is not what the pane just refused a turn for.
      seedConfigDir: (cfgDir, wt, s, harness) => {
        if (harness === 'codex') writeRollout(cfgDir, { usedPct: 41, windowMinutes: 300, resetsInMinutes: 12 })
      },
      capturePane: async () => CAP_PANE,
    }, { routing: TWO_LANE, readyTimeoutS: 6 })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => events.some((e) => e.type === 'provider_cooling'))

    assert.equal(events.find((e) => e.type === 'provider_cooling').reset_source, 'floor')
  })

  // The cap is account-level, so a sibling's reading is about the same account
  // — and the agent that just spawned is the one least likely to hold one.
  test('a sibling agent on the same provider supplies the reset', async () => {
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      capturePane: async () => CAP_PANE,
    }, { routing: TWO_LANE, readyTimeoutS: 6 })

    const siblingCfg = path.join(tmp, 'work', 'cfg', 'curia-41')
    writeRollout(siblingCfg, { usedPct: 99.6, windowMinutes: 10080, resetsInMinutes: 300 })
    await d.start('42', { repo: 'o/r', by: 'test' })
    d.agents.set('curia-41', {
      session: 'curia-41', ticket: '41', repo: 'o/r', harness: 'codex', provider: 'openai', cfgDir: siblingCfg,
    })
    await waitFor(() => events.some((e) => e.type === 'provider_cooling'))

    const cooled = events.find((e) => e.type === 'provider_cooling')
    assert.equal(cooled.reset_source, 'transcript')
    const waited = Date.parse(cooled.reset_at) - Date.now()
    assert.ok(waited > 4 * HOUR && waited < 6 * HOUR, `cooled for ${Math.round(waited / 60_000)} min, not the stated 300`)
  })

  // The codex harness spawns with hook trust bypassed, so a hook the repo carries
  // would run unreviewed with no model in the loop.
  test('a repo-planted .codex/hooks.json refuses the dispatch and releases the claim', async () => {
    let unclaimed = false
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      createWorktree: async (b, n) => {
        const wt = path.join(path.dirname(b), 'wt', String(n))
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
        fs.mkdirSync(path.join(wt, '.codex'), { recursive: true })
        fs.writeFileSync(path.join(wt, '.codex', 'hooks.json'), '{"hooks":{"SessionStart":[]}}')
        return wt
      },
      unclaim: async () => { unclaimed = true },
      newSession: async () => { throw new Error('must never spawn') },
    }, { routing: TWO_LANE })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /config file curia did not write/)
    assert.equal(unclaimed, true)
  })

  // Claude Code merges settings.local.json over the settings.json curia writes,
  // so a repo-carried copy runs its hooks with no model in the loop (#105).
  test('a repo-planted .claude/settings.local.json refuses the claude-harness dispatch', async () => {
    let unclaimed = false
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [] }),
      createWorktree: async (b, n) => {
        const wt = path.join(path.dirname(b), 'wt', String(n))
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
        fs.mkdirSync(path.join(wt, '.claude'), { recursive: true })
        fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), '{"hooks":{"SessionStart":[]}}')
        return wt
      },
      unclaim: async () => { unclaimed = true },
      newSession: async () => { throw new Error('must never spawn') },
    }, { routing: TWO_LANE })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /config file curia did not write/)
    assert.equal(unclaimed, true)
  })

  test('the same repo dispatches fine on the claude harness, which never loads .codex/', async () => {
    let spawned = false
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [] }),
      createWorktree: async (b, n) => {
        const wt = path.join(path.dirname(b), 'wt', String(n))
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
        fs.mkdirSync(path.join(wt, '.codex'), { recursive: true })
        fs.writeFileSync(path.join(wt, '.codex', 'hooks.json'), '{"hooks":{"SessionStart":[]}}')
        return wt
      },
      newSession: async () => { spawned = true },
    }, { routing: TWO_LANE })

    await d.start('42', { repo: 'o/r', by: 'test' })
    assert.equal(spawned, true)
  })
})

describe('the grown verbs (#81, wayfinder #91)', () => {
  const MAP = [{ number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] }]
  const child = (n) => ({
    number: n, state: 'open', assignees: [], labels: [{ name: 'wayfinder:task' }],
    issue_dependencies_summary: { blocked_by: 0 },
  })

  test('next dispatches the first takeable map-lane ticket', async () => {
    const d = makeDispatcher({
      repoMaps: async () => MAP,
      mapFrontier: async () => [child(7), child(9)],
      fetchIssue: async () => ({ ...OPEN_ISSUE, number: 7 }),
    })
    const reply = await d.next(undefined, { by: 'test' })
    assert.match(reply, /dispatched o\/r#7/)
    assert.equal(d.agents.has('curia-7'), true)
  })

  test('next with nothing takeable says so instead of dispatching', async () => {
    const d = makeDispatcher()
    assert.match(await d.next(undefined, { by: 'test' }), /nothing takeable/)
  })

  test('resume inherits the surviving worktree instead of recreating it', async () => {
    const surviving = path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42')
    fs.mkdirSync(surviving, { recursive: true })
    fs.writeFileSync(path.join(surviving, 'leftover.txt'), 'uncommitted work')
    const d = makeDispatcher({
      createWorktree: async () => { throw new Error('resume must not recreate the worktree') },
    })
    const reply = await d.resume('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /dispatched o\/r#42/)
    assert.equal(d.agents.get('curia-42').wtPath, surviving)
  })

  test('resume without a surviving worktree degrades to an ordinary dispatch', async () => {
    const d = makeDispatcher()
    const reply = await d.resume('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /dispatched o\/r#42/)
  })

  test('resume refuses a live agent flat', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    const reply = await d.resume('42', { repo: 'o/r' })
    assert.match(reply, /already running/)
  })

  test('cancel all runs the same teardown on each agent at once — a typed bulk cancel never confirms (#94)', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    await d.start('43', { repo: 'o/r' })
    const reply = await d.cancelAll({ by: 'test' })
    assert.match(reply, /2 agent\(s\)/)
    assert.match(reply, /curia-42/)
    assert.match(reply, /curia-43/)
    assert.equal(events.filter((e) => e.type === 'agent_cancelled').length, 2)
    assert.deepEqual(confirms, [], 'no confirm on the slash path')
    assert.equal(d.agents.size, 0)
  })

  test('cancel all refuses on an indeterminate session list', async () => {
    const d = makeDispatcher({ listSessions: async () => { throw new Error('tmux gone') } })
    assert.match(await d.cancelAll({ by: 'test' }), /refused/)
  })

  test('resume all dispatches every surviving worktree at once with count and list — not destructive, no confirm (#89)', async () => {
    for (const n of ['50', '51']) {
      fs.mkdirSync(path.join(tmp, 'work', 'repos', 'o__r', 'wt', n), { recursive: true })
    }
    const d = makeDispatcher()
    const reply = await d.resumeAll({ by: 'test' })
    assert.match(reply, /resuming 2 ticket\(s\)/)
    await waitFor(() => d.agents.has('curia-50') && d.agents.has('curia-51'))
    assert.deepEqual(confirms, [])
  })

  test('resume all with nothing to resume says so', async () => {
    const d = makeDispatcher()
    assert.match(await d.resumeAll({ by: 'test' }), /nothing to resume/)
  })

  test('status carries waiting-where and the recent cancelled and finished', async () => {
    const journal = path.join(tmp, 'data', 'events.jsonl')
    fs.appendFileSync(journal, JSON.stringify({ type: 'agent_cancelled', repo: 'o/r', ticket: '3' }) + '\n')
    fs.appendFileSync(journal, JSON.stringify({ type: 'lifecycle_closed', repo: 'o/r', ticket: '4' }) + '\n')
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    escalations.push({ id: 'esc-9', kind: 'free-text', agent: 'curia-42', status: 'open' })
    const { agents, recent } = await d.status()
    assert.deepEqual(agents[0].waiting_on, [{ id: 'esc-9', kind: 'free-text' }])
    assert.deepEqual(recent, [
      { kind: 'cancelled', repo: 'o/r', ticket: '3' },
      { kind: 'finished', repo: 'o/r', ticket: '4' },
    ])
  })
})

// The periodic agent-liveness sweep (#138, #108 items 19/20): a tracked
// agent whose tmux session is gone WITHOUT a teardown order is a death —
// one agent_died event, every surface stops lying at once. Ordered kills,
// indeterminate reads and live sessions all stay silent.
describe('agent-liveness sweep (#138)', () => {
  // start() must see an unassigned ticket and no session; the sweep must see
  // the claim and the absence. Both doubles flip after the dispatch.
  function makeSwept(deps = {}) {
    const state = { assigned: false, session: async () => false }
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: state.assigned ? [{ login: 'me' }] : [] }),
      hasSession: (name) => state.session(name),
      ...deps,
    })
    return { d, state }
  }

  test('a vanished session journals agent_died, releases the claim, and names the way out', async () => {
    let unclaims = 0
    const { d, state } = makeSwept({ unclaim: async () => { unclaims += 1 } })
    await d.start('42', { repo: 'o/r' })
    state.assigned = true

    await d.livenessSweep()

    assert.ok(events.some((e) => e.type === 'agent_died' && e.agent === 'curia-42'))
    assert.ok(events.some((e) => e.type === 'dead_claim_released' && e.ticket === '42'))
    assert.equal(unclaims, 1)
    assert.ok(!d.agents.has('curia-42'), 'the dead record is dropped so `resume` is takeable')
    const n = notifies.find((x) => /gone without a teardown order/.test(x.message))
    assert.ok(n, 'the thread hears about the death')
    assert.match(n.message, /claim released, ticket re-frontiered/)
    assert.match(n.message, /`resume 42`/)
  })

  test('an ordered kill is an expected absence — no agent_died', async () => {
    const { d } = makeSwept()
    await d.start('42', { repo: 'o/r' })
    // mid-teardown shape: the kill is ordered, the record not yet dropped
    await d.deps.killSession('curia-42')

    await d.livenessSweep()

    assert.ok(!events.some((e) => e.type === 'agent_died'))
  })

  test('a fresh spawn under the same name clears the ordered-kill memory', async () => {
    const { d, state } = makeSwept()
    await d.start('42', { repo: 'o/r' })
    await d.deps.killSession('curia-42')
    d.agents.delete('curia-42')
    await d.start('42', { repo: 'o/r' })
    state.assigned = true

    await d.livenessSweep()

    assert.ok(events.some((e) => e.type === 'agent_died' && e.agent === 'curia-42'),
      'the successor is watched — a stale ordered-kill entry must not blind the sweep')
  })

  test('an indeterminate hasSession is not evidence of death', async () => {
    const { d, state } = makeSwept()
    await d.start('42', { repo: 'o/r' })
    state.session = async () => { throw new Error('tmux wedged') }

    await d.livenessSweep()

    assert.ok(!events.some((e) => e.type === 'agent_died'))
    assert.ok(d.agents.has('curia-42'), 'the record stays for the next pass')
  })

  test('a live session is left alone', async () => {
    const { d, state } = makeSwept()
    await d.start('42', { repo: 'o/r' })
    state.session = async () => true

    await d.livenessSweep()

    assert.ok(!events.some((e) => e.type === 'agent_died'))
    assert.ok(d.agents.has('curia-42'))
  })

  test('an open pull request keeps the claim — death while awaiting review', async () => {
    let unclaims = 0
    const { d, state } = makeSwept({
      unclaim: async () => { unclaims += 1 },
      findPullRequest: async () => ({ state: 'OPEN', url: 'https://github.com/o/r/pull/9' }),
    })
    await d.start('42', { repo: 'o/r' })
    state.assigned = true

    await d.livenessSweep()

    assert.ok(events.some((e) => e.type === 'agent_died'))
    assert.ok(events.some((e) => e.type === 'dead_claim_kept_awaiting_review'))
    assert.equal(unclaims, 0, 'the reviewable claim is not dead')
    assert.ok(notifies.some((x) => /awaiting review, so the claim stays/.test(x.message)))
  })

  test('open escalations stay answerable: marked in-thread and journalled, never cancelled', async () => {
    const { d, state } = makeSwept()
    await d.start('42', { repo: 'o/r' })
    state.assigned = true
    escalations.push({ id: 'esc-5', kind: 'free-text', agent: 'curia-42', ticket: '42', status: 'open' })

    await d.livenessSweep()

    assert.deepEqual(cancelled, [], 'the surface half of item 19: the question survives its agent')
    assert.ok(events.some((e) => e.type === 'escalation_agent_died' && e.id === 'esc-5'))
    const n = notifies.find((x) => /gone without a teardown order/.test(x.message))
    assert.match(n.message, /\*\*esc-5\*\*/)
    assert.match(n.message, /recorded and handed to the resumed agent/)
  })

  test('an open confirm on the dead agent lapses — it described an instance that no longer exists', async () => {
    const { d, state } = makeSwept()
    await d.start('42', { repo: 'o/r' })
    state.assigned = true
    const rec = {
      id: 'esc-c1', kind: 'confirm', agent: 'overseer', ticket: '42', status: 'open',
      action: { targets: [{ session: 'curia-42' }] },
    }
    escalations.push(rec)

    await d.livenessSweep()

    assert.ok(lapses.some((l) => l.id === 'esc-c1'))
  })

  test('a dead session WITH a recorded result is the normal close, not a death', async () => {
    const { d, state } = makeSwept()
    await d.start('42', { repo: 'o/r' })
    state.assigned = true
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), JSON.stringify({ status: 'resolved' }))

    await d.livenessSweep()

    assert.ok(!events.some((e) => e.type === 'agent_died'))
    assert.ok(events.some((e) => e.type === 'lifecycle_closed'))
  })

  test('status recents carry the death, with the resume hint riding the journal event', async () => {
    fs.appendFileSync(path.join(tmp, 'data', 'events.jsonl'),
      JSON.stringify({ type: 'agent_died', repo: 'o/r', ticket: '7', agent: 'curia-7' }) + '\n')
    const d = makeDispatcher()
    const { recent } = await d.status()
    assert.deepEqual(recent, [{ kind: 'died', repo: 'o/r', ticket: '7' }])
  })
})

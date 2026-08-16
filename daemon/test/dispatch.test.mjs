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
import { Dispatcher, discordTime, paneTail, textCarriesLimitPhrase, parseTicketRef, newExitMarker, parseExitMarker, paneExcerpt } from '../src/dispatch.mjs'
import { Reduction } from '../src/reduction.mjs'
import { parseUsageLimit } from '../src/routing.mjs'
import { TEST_PINS, containerDeps, fakePrivateClone, seedConfigDirStub, withTestCredential } from './fixtures/sandbox.mjs'
import { ENV_FILE, GUEST_CFG } from '../src/sandbox.mjs'
import { GH_DIR, readGhCredentials, writeGhCredentials } from '../src/agentgh.mjs'
import { readOverseerToken } from '../src/overseertoken.mjs'
import { removeCredentials } from '../src/workspace.mjs'

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
let escalations // open escalation records the reduction double reports (#47)
let cancelled // ids the dispatcher cancelled through the injected gate
let confirms // confirm records opened through the injected openConfirm (#94)
let lapses // {id, reason} lapsed through the injected lapseEscalation (#94)
let confirmNotes // {id, text} posted next to a confirm's buttons (#94)
let overseerNotes // {threadId, text} synthetic session lines (#94)
let agentNotes // session -> queued operator notes the exit sweep expires (#208)
const dispatchers = [] // every Dispatcher a test built, so afterEach can end its watches
let restoreCredential // #195: the model credential the container env file needs

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
  agentNotes = new Map()
  restoreCredential = withTestCredential()
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
  restoreCredential()
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
  // The account readings the pre-emptive hold judges (#384). None by default:
  // a box with no reading holds nothing, which is every test but its own.
  readings = () => [],
  askReview = async () => ({ text: 'approve', status: 'answered' }),
  identityProxy = { listening: true },
  // #389: the GitHub App's minter. None by default — a box with no app keeps
  // #155's PAT, which is every test but the cutover's own.
  minter = null,
  // #390: who a claim assigns. `loadCuriaConfig` refuses a boot without it, so
  // every test gets one; the null case is its own test, and it pins that
  // reconcile skips rather than sweeps.
  claimLogin = 'me',
  // Discarded by default. A test that asserts on a boot line passes a collector,
  // because the lines it wants are written inside the constructor (#377).
  log = () => {},
} = {}) {
  const root = path.join(tmp, 'work')
  const config = {
    watch,
    dispatch: {
      auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
      workspace_root: root, ready_timeout_s: readyTimeoutS, claim_login: claimLogin,
      stop_nudge_budget: stopNudgeBudget,
    },
    attach: { ttyd_port: 7681, serve_port: 8443 },
    identity: { allow: ['tester@example.com'], proxy_port: 7682 },
    skills,
    // #195: every dispatch prepares a container, so every Dispatcher needs pins
    sandbox: TEST_PINS,
  }
  // A REAL reduction behind the double (#289). The journal must reach disk,
  // because several dispatcher reductions read it back off disk — the ending
  // clause (#253) among them, which is how report_result's sentence reaches
  // the Stop hook. Two reductions no longer do, so the double delegates them
  // to the code that owns them instead of keeping a second copy of the rule.
  // Its constructor converts a seeded `events.jsonl` into the journal (#323),
  // so a test that seeds the file before it builds a dispatcher still gets
  // those lines counted.
  const journal = new Reduction(path.join(tmp, 'data'))
  const reduction = {
    journal: (type, data) => {
      const rec = journal.journal(type, data)
      events.push(rec)
      return rec
    },
    // The dispatcher's questions about the past run on the journal the real
    // reduction wrote, which is what a test that seeds it before this line
    // depends on (#408).
    questions: journal.questions,
    recentOutcomes: () => journal.recentOutcomes(),
    pullRequestFor: (agent) => journal.pullRequestFor(agent),
    // #346: the arm outlives the process, so the reduction is the real one.
    armedLimitResumes: () => journal.armedLimitResumes(),
    // #444: the failed-spawn count is the journal's too, and for the same
    // reason — the auto loop reads it a tick after the failure wrote it, with a
    // deploy allowed in between.
    failedSpawns: (ticket) => journal.failedSpawns(ticket),
    spawnFailureCounts: () => journal.spawnFailureCounts(),
    // #377, for the same reason: the cooling the dispatcher seeds itself from
    // at construction is the real reduction over the real journal.
    armedCoolings: () => journal.armedCoolings(),
    // #485: the stranded-map alarm is the real reduction's, for the reason the
    // backup's is — it must stand across passes and across a deploy.
    standingStrandedMaps: () => journal.standingStrandedMaps(),
    strandedMap: (repo, map) => journal.strandedMap(repo, map),
    openEscalations: () => escalations.filter((r) => r.status === 'open'),
    // #374: the real reduction over the real journal. A test seeds `esc_open`
    // and `esc_answer` through `journal` above, and the exchange the prompt
    // inherits is built by the code that owns the rule.
    answeredExchangeFor: (agent) => journal.answeredExchangeFor(agent),
    cancel: () => ({ ok: true }),
    // #208, the real Reduction predicate: a note stamped with an
    // instance dies when that instance is no longer the live one. An
    // unstamped note is session-keyed and stays (the #139 hand-off).
    // #252 moved the ANNOUNCEMENT behind the hook the real reduction fires here,
    // so the double fires it too — the count in the thread comes from it now.
    expireAgentNotes: (agent, live = null, why = 'is gone') => {
      const arr = agentNotes.get(agent) ?? []
      const keep = arr.filter((n) => !n.instance || n.instance === live)
      const stale = arr.filter((n) => n.instance && n.instance !== live)
      agentNotes.set(agent, keep)
      if (stale.length) reduction.onNotesExpired?.({ agent, notes: stale, liveInstance: live, why })
      return stale
    },
    // #418: the lint gate's ledger is the real reduction's, for the same reason
    // the exchange is — the Stop hook's second-block rule counts daemon-side.
    journalLintStopBlock: (agent, kind) => {
      const rec = journal.journalLintStopBlock(agent, kind)
      events.push(rec)
      return rec
    },
    clearLintRejections: (agent, kind) => journal.clearLintRejections(agent, kind),
    // #252: the note-by-id half the interrupt button reads.
    noteById: (id) => [...agentNotes.values()].flat().find((n) => n.id === id) ?? null,
    interruptAgentNote: (id) => {
      const note = [...agentNotes.values()].flat().find((n) => n.id === id) ?? null
      if (note) agentNotes.set(note.agent, (agentNotes.get(note.agent) ?? []).filter((n) => n.id !== id))
      return note
    },
  }
  const base = {
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
    removeWorkspace: async () => {},
    removeConfigDir: () => {},
    removeCredentials: () => {},
    seedConfigDir: seedConfigDirStub(),
    writeConnectionSettings: () => {},
    writePrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
    probeTtyd: async () => ({ verified: true }),
    assertServe: async () => {},
    serveOff: async () => {},
    // resolve + land (#41)
    commentIssue: async () => {},
    closeIssue: async () => {},
    setIssueBody: async () => {},
    issueComments: async () => [],
    findPullRequest: async () => null,
    createPullRequest: async () => 'https://github.com/o/r/pull/1',
    // #391: the gate press posts a real approval. Stubbed everywhere but its
    // own tests, so no suite reaches for `gh`.
    approvePullRequest: async () => {},
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
    log,
    readings,
    dataDir: path.join(tmp, 'data'),
    daemonPort: 4271,
    minter,
    deps: { ...base, ...deps },
  })
  // #151: index.mjs hangs the identity proxy on the dispatcher the way it hangs
  // the timeline. Reconcile refuses to publish the terminal surface while the
  // proxy is down, so the default here is up — the down case gets its own test.
  d.identityProxy = identityProxy
  // #252: index.mjs wires the reduction's expiry hook to the dispatcher's one
  // announcer, so every expiry — exit, adoption, drain — says so exactly once.
  reduction.onNotesExpired = (ev) => d.announceExpiredNotes(ev)
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

// #336: the other half of #47's evidence. An open escalation says "blocked"
// only while someone could still read the answer. Once the agent has reported
// its result, the record is a corpse: it held the ticket on the Needs-You list,
// it made every later Stop hook mark a finished agent blocked, and through that
// mark it kept the container up two days past a merge.
describe('a question its own agent finished past (#336)', () => {
  function writeJournal(lines) {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  // The gate double closes nothing by itself. index.mjs closes the record, so a
  // test that asserts what the NEXT pass sees has to close it here too.
  function closesRecords(d) {
    d.cancelEscalation = (id, opts) => {
      cancelled.push({ id, ...opts })
      const r = escalations.find((x) => x.id === id)
      if (r) r.status = 'cancelled'
      return { ok: true }
    }
  }

  const at = (iso) => new Date(iso).toISOString()

  test('the result closes the question, and the Stop that follows ends the agent', async () => {
    let killed = null
    const d = makeDispatcher({ hasSession: async () => true, killSession: async (n) => { killed = n } })
    closesRecords(d)
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready', resultReceived: false })
    escalations = [{ id: 'esc-21', agent: 'curia-42', ticket: '42', status: 'open' }]

    d.onResult('curia-42')

    assert.deepEqual(cancelled, [{ id: 'esc-21', by: 'result' }])
    assert.ok(typesOf().includes('escalation_stale_at_result'))

    await d.onAgentDone('curia-42')

    assert.ok(typesOf().includes('lifecycle_closed'))
    assert.ok(!typesOf().includes('agent_blocked_on_human'), 'a finished agent is not blocked on anyone')
    assert.equal(killed, 'curia-42', 'nothing holds the session any more')
  })

  test('the result speaks for its own agent only', async () => {
    const d = makeDispatcher()
    closesRecords(d)
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready' })
    escalations = [
      { id: 'esc-30', agent: 'overseer', ticket: '42', status: 'open' },
      { id: 'esc-31', agent: 'curia-43', ticket: '43', status: 'open' },
    ]

    d.onResult('curia-42')

    assert.deepEqual(cancelled, [], 'a confirm and another agent\'s question are not this result\'s to close')
  })

  test('reconcile closes a record whose result landed under an older daemon process', async () => {
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '313', agent: 'curia-313', ts: at('2026-08-11T17:00:00Z') },
      { type: 'result', agent: 'curia-313', ticket: '313', ts: at('2026-08-12T21:33:00Z') },
    ])
    const d = makeDispatcher({ listSessions: async () => [] })
    closesRecords(d)
    escalations = [{ id: 'esc-267', agent: 'curia-313', ticket: '313', status: 'open', opened_at: at('2026-08-11T17:26:00Z') }]

    await d.reconcile({ boot: false })

    assert.deepEqual(cancelled, [{ id: 'esc-267', by: 'result' }])
    assert.ok(events.some((e) => e.type === 'escalation_stale_at_result' && e.id === 'esc-267' && e.by === 'reconcile'))
  })

  test('a question asked after the result is not one of these', async () => {
    // The rule is "the agent finished past this question", and the stamps are
    // what say so. A record opened later belongs to a live exchange.
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', ts: at('2026-08-12T09:00:00Z') },
      { type: 'result', agent: 'curia-42', ticket: '42', ts: at('2026-08-12T10:00:00Z') },
    ])
    const d = makeDispatcher({ listSessions: async () => [] })
    closesRecords(d)
    escalations = [{ id: 'esc-9', agent: 'curia-42', ticket: '42', status: 'open', opened_at: at('2026-08-12T11:00:00Z') }]

    await d.reconcile({ boot: false })

    assert.deepEqual(cancelled, [])
  })

  test('a re-dispatch does not inherit the last one\'s ending', async () => {
    // Session names are reused. A result from the PREVIOUS agent of this
    // ticket must not close the question the current one is asking.
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', ts: at('2026-08-10T09:00:00Z') },
      { type: 'result', agent: 'curia-42', ticket: '42', ts: at('2026-08-10T10:00:00Z') },
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', ts: at('2026-08-12T09:00:00Z') },
    ])
    const d = makeDispatcher({ listSessions: async () => [] })
    closesRecords(d)
    escalations = [{ id: 'esc-9', agent: 'curia-42', ticket: '42', status: 'open', opened_at: at('2026-08-12T09:30:00Z') }]

    await d.reconcile({ boot: false })

    assert.deepEqual(cancelled, [])
  })

  test('an open question with no result is left asking — silence resolves nothing (#285)', async () => {
    writeJournal([{ type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', ts: at('2026-08-12T09:00:00Z') }])
    const d = makeDispatcher({ listSessions: async () => [] })
    closesRecords(d)
    escalations = [{ id: 'esc-9', agent: 'curia-42', ticket: '42', status: 'open', opened_at: at('2026-08-12T09:30:00Z') }]

    await d.reconcile({ boot: false })

    assert.deepEqual(cancelled, [])
    assert.ok(!typesOf().includes('escalation_stale_at_result'))
  })

  test('the ending the Stop hook deferred to the corpse runs, and the container goes', async () => {
    // The live ghost whole: a merged ticket, a result, a Stop hook that read
    // the corpse as a live block, and a session nothing could ever end — the
    // orphan sweep exempts exactly these agents.
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', ts: at('2026-08-12T09:00:00Z') },
      { type: 'result', agent: 'curia-42', ticket: '42', ts: at('2026-08-12T21:33:00Z') },
      { type: 'agent_blocked_on_human', agent: 'curia-42', ticket: '42', escalations: ['esc-21'], ts: at('2026-08-12T21:33:09Z') },
    ])
    let killed = null
    const d = makeDispatcher({ listSessions: async () => ['curia-42'], killSession: async (n) => { killed = n } })
    closesRecords(d)
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{"status":"resolved"}')
    escalations = [{ id: 'esc-21', agent: 'curia-42', ticket: '42', status: 'open', opened_at: at('2026-08-12T17:26:00Z') }]

    await d.reconcile({ boot: false })

    assert.deepEqual(cancelled, [{ id: 'esc-21', by: 'result' }])
    assert.ok(events.some((e) => e.type === 'orphan_sweep_skipped'), 'the sweep still keeps its hands off a finishing agent')
    assert.ok(typesOf().includes('lifecycle_closed'))
    assert.equal(killed, 'curia-42')
  })

  test('an indeterminate session list still closes the record, and ends nothing', async () => {
    // The evidence rule of every sweep in this file: a tmux read that failed
    // is not "no sessions". The journal alone is enough to close a question.
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', ts: at('2026-08-12T09:00:00Z') },
      { type: 'result', agent: 'curia-42', ticket: '42', ts: at('2026-08-12T21:33:00Z') },
      { type: 'agent_blocked_on_human', agent: 'curia-42', ticket: '42', escalations: ['esc-21'], ts: at('2026-08-12T21:33:09Z') },
    ])
    let killed = null
    const d = makeDispatcher({
      listSessions: async () => { throw new Error('tmux is wedged') },
      killSession: async (n) => { killed = n },
    })
    closesRecords(d)
    escalations = [{ id: 'esc-21', agent: 'curia-42', ticket: '42', status: 'open', opened_at: at('2026-08-12T17:26:00Z') }]

    await d.reconcile({ boot: false })

    assert.deepEqual(cancelled, [{ id: 'esc-21', by: 'result' }])
    assert.equal(killed, null)
    assert.ok(!typesOf().includes('lifecycle_closed'))
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

  test('a live charting session is adopted off the journal kind — a map holds no claim (#228)', async () => {
    // #221 removed the map claim, so the assignee test above can never pass
    // for a charting session. The journal's spawn line is the positive
    // evidence instead, and the adopted record must restate the kind:
    // #epochCharting trusts the in-memory record first, so a record without
    // the field would hold this agent to the ticket ending.
    const destroyed = []
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '7', agent: 'curia-7', model: 'sonnet', harness: 'claude', kind: 'charting', instruction: 'tighten the fog' },
    ])
    const d = makeDispatcher({
      listSessions: async () => ['curia-7'],
      fetchIssue: async () => ({ number: 7, title: 'a map', body: '', state: 'open', assignees: [], labels: [{ name: 'wayfinder:map' }] }),
      killSession: async (s) => destroyed.push(`kill:${s}`),
      removeWorkspace: async (wt) => destroyed.push(`workspace:${wt}`),
      removeConfigDir: (dir) => destroyed.push(`cfg:${dir}`),
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(destroyed, [])
    assert.ok(!typesOf().includes('orphan_swept'))
    const w = d.agents.get('curia-7')
    assert.equal(w.charting, true)
    assert.equal(w.instruction, 'tighten the fog')
  })

  test('the charting evidence does not widen adoption: an unclaimed ticket session is still an orphan (#228)', async () => {
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'sonnet', harness: 'claude', kind: 'ticket' },
    ])
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...OPEN_ISSUE }), // open, and assigned to nobody
      killSession: async () => {},
      removeWorkspace: async () => {},
      removeConfigDir: () => {},
      hasUnpushedWork: async () => false,
    })

    await d.reconcile({ boot: false })

    assert.ok(typesOf().includes('orphan_swept'))
  })

  test('a charting session on a CLOSED map is swept — the open gate holds for maps too (#228)', async () => {
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '7', agent: 'curia-7', model: 'sonnet', harness: 'claude', kind: 'charting' },
    ])
    const d = makeDispatcher({
      listSessions: async () => ['curia-7'],
      fetchIssue: async () => ({ number: 7, title: 'a map', body: '', state: 'closed', assignees: [], labels: [{ name: 'wayfinder:map' }] }),
      killSession: async () => {},
      removeWorkspace: async () => {},
      removeConfigDir: () => {},
      hasUnpushedWork: async () => false,
    })

    await d.reconcile({ boot: false })

    assert.ok(typesOf().includes('orphan_swept'))
    assert.ok(!d.agents.has('curia-7'))
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

  test('every call moves the last-contact reading, and /status states it in seconds (#370)', async () => {
    const d = makeDispatcher()
    const w = liveAgent(d, { mcpSeenAt: null, mcpLastAt: null })

    // Null, never 0: this process has heard nothing from an agent it spawned.
    assert.equal((await d.status()).agents[0].last_contact_s, null)

    d.onMcpCall('curia-42')
    const first = w.mcpSeenAt
    assert.equal(w.mcpLastAt, first, 'the first call sets both')

    // A call two minutes later moves the reading and leaves the stamp.
    w.mcpLastAt = first - 120_000
    d.onMcpCall('curia-42')
    assert.equal(w.mcpSeenAt, first, 'the stamp still dates the FIRST call')
    assert.ok(w.mcpLastAt > first - 120_000, 'the reading dates the last one')
    assert.equal((await d.status()).agents[0].last_contact_s, 0)
    assert.equal(events.filter((e) => e.type === 'agent_mcp_first').length, 1,
      'the reading is traffic and stays in memory — the journal takes the first call and no other')
  })

  test('an adopted agent reads null until it speaks to THIS process (#370)', async () => {
    const d = makeDispatcher()
    // reconcile rebuilds a re-adopted record with spawnedAt null and no stamp
    liveAgent(d, { mcpSeenAt: null, mcpLastAt: null, spawnedAt: null })

    const before = (await d.status()).agents[0]
    assert.equal(before.last_contact_s, null)
    assert.equal(before.uptime_s, null, 'the null beside it is what says the silence belongs to the restart')

    d.onMcpCall('curia-42')
    assert.equal((await d.status()).agents[0].last_contact_s, 0, 'an adopted agent that speaks is heard like any other')
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
    // and the last-contact reading with it (#370): the successor has reached
    // curia never, and its row must not show the dead client's traffic
    assert.equal(d.agents.get('curia-42').mcpLastAt, null)
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

describe('reconcile without a claim login (B1)', () => {
  // #390 moved the identity off `gh api user` and onto `dispatch.claim_login`,
  // which `loadCuriaConfig` refuses a boot without. The GUARD stays all the
  // same, and this is what it is for: with no name, every live agent looks
  // unowned, and the sweep would kill its session and force-remove its
  // uncommitted output.
  test('a config with no claim_login destroys nothing — no sweep, no unclaim, no worktree removal', async () => {
    const destroyed = []
    fs.writeFileSync(
      path.join(tmp, 'data', 'events.jsonl'),
      JSON.stringify({ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }) + '\n',
    )
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      // the issue reads fine — the identity is the only thing missing, which is
      // exactly how the destructive path used to be reached
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      killSession: async (n) => { destroyed.push(`kill:${n}`) },
      removeWorkspace: async (wt) => { destroyed.push(`workspace:${wt}`) },
      removeConfigDir: (dir) => { destroyed.push(`cfg:${dir}`) },
      unclaim: async (repo, ticket) => { destroyed.push(`unclaim:${repo}#${ticket}`) },
    }, { claimLogin: null })

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
      removeWorkspace: async (wt) => { destroyed.push(`workspace:${wt}`) },
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
    // #217: tmux exploding IS a fault, and this sentence must keep saying so —
    // the refusal frame is for the other fact.
    assert.ok(!/REFUSED/.test(notifies[0].message), 'a fault must not read as a decision')
    assert.match(notifies[0].message, /^⚠️/)
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

// The agents are the first holder to move off a PAT and onto minted tokens
// (ADR-0018). Everything here is about the SWAP: what reaches the container, what
// does not, and what happens when the mint cannot be made.
describe('the claim assigns dispatch.claim_login (#390)', () => {
  // The daemon calls GitHub as `curia-sh[bot]` now, and GitHub does not let an
  // App be an issue assignee. So the claim names a real user, and the config is
  // the one place that says which — `gh api user` used to, and it answers
  // nothing under an installation token.
  test('the login on the claim is the configured one, not the daemon\'s own', async () => {
    const assigned = []
    const d = makeDispatcher(
      { claim: async (repo, n, login) => { assigned.push({ repo, n, login }) } },
      { claimLogin: 'alp82' },
    )

    await d.start('42', { repo: 'o/r' })

    assert.deepEqual(assigned, [{ repo: 'o/r', n: '42', login: 'alp82' }])
  })

  test('the release names the same login the claim did', async () => {
    const released = []
    const d = makeDispatcher(
      { unclaim: async (repo, n, login) => { released.push({ repo, n, login }) } },
      { claimLogin: 'alp82' },
    )

    await d.start('42', { repo: 'o/r' })
    await d.cancel('42', { by: 'test' })

    assert.deepEqual(released, [{ repo: 'o/r', n: '42', login: 'alp82' }])
  })

  // A watch reload rewrites the config in place, so a claim must read the name
  // the file says NOW rather than one frozen at construction.
  test('a config edited under a live dispatcher is the one the next claim reads', async () => {
    const assigned = []
    const d = makeDispatcher(
      { claim: async (repo, n, login) => { assigned.push(login) } },
      { claimLogin: 'alp82' },
    )

    await d.start('42', { repo: 'o/r' })
    d.config.dispatch.claim_login = 'someone-else'
    d.agents.delete('curia-42')
    await d.start('42', { repo: 'o/r' })

    assert.deepEqual(assigned, ['alp82', 'someone-else'])
  })
})

describe('the agent mints its GitHub token (#389)', () => {
  const envFileOf = (session) => {
    const file = path.join(tmp, 'work', 'cfg', session, ENV_FILE)
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
      .filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  }
  const cfgOf = (session) => path.join(tmp, 'work', 'cfg', session)
  const hostsOf = (session) => path.join(cfgOf(session), GH_DIR, 'hosts.yml')

  // A minter shaped like the real one and reaching no GitHub: a fresh token per
  // call, so a refresh is visible as a CHANGED file rather than as a rewrite
  // nothing can tell from the last one.
  const fakeMinter = ({ fail = false } = {}) => {
    const calls = []
    let n = 0
    return {
      calls,
      tokenFor: async (owner, role) => {
        calls.push({ owner, role })
        if (fail) throw new Error(`curia's GitHub App is not installed on ${owner}`)
        n += 1
        return `ghs_minted${n}`
      },
    }
  }

  // #155's key for owner `o`, set only where a test is about the fallback.
  const withPat = (value = 'github_pat_11PAT') => {
    const key = 'CURIA_AGENT_GH_TOKEN_O'
    const had = Object.hasOwn(process.env, key)
    const old = process.env[key]
    process.env[key] = value
    return () => {
      if (had) process.env[key] = old
      else delete process.env[key]
    }
  }

  test('the container gets a PATH and no secret, and the token is in the file', async () => {
    const minter = fakeMinter()
    const d = makeDispatcher({}, { minter })
    await d.start('42', { repo: 'o/r', by: 'test' })

    const env = envFileOf('curia-42')
    assert.equal(env.GH_CONFIG_DIR, path.join(GUEST_CFG, GH_DIR))
    assert.equal('GH_TOKEN' in env, false, 'a token in the env is frozen for the agent\'s life')
    assert.equal(readGhCredentials(cfgOf('curia-42')), 'ghs_minted1')
    assert.deepEqual(minter.calls, [{ owner: 'o', role: 'write' }])
    assert.ok(events.some((e) => e.type === 'agent_token_minted' && e.agent === 'curia-42' && e.role === 'write'))

    d.agents.delete('curia-42')
  })

  test('the commits read as the bot, not as the operator', async () => {
    const identities = []
    const minter = fakeMinter()
    minter.botIdentity = async (token) => {
      assert.equal(token, 'ghs_minted1', 'the identity is read on the token just minted')
      return { name: 'curia-sh[bot]', email: '317489578+curia-sh[bot]@users.noreply.github.com' }
    }
    const d = makeDispatcher({
      setGitIdentity: async (gitDir, who) => identities.push({ gitDir, who }),
    }, { minter })

    await d.start('42', { repo: 'o/r', by: 'test' })

    assert.equal(identities.length, 1)
    assert.equal(identities[0].who.name, 'curia-sh[bot]')
    assert.equal(identities[0].gitDir, path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42'))
    d.agents.delete('curia-42')
  })

  test('an identity GitHub will not state costs the box its dispatch of nothing', async () => {
    // Two network reads stand behind the bot identity. A GitHub that cannot
    // answer them is no reason to refuse a ticket: the agent keeps the box
    // identity its clone was given, which is exactly today's attribution.
    const minter = fakeMinter()
    minter.botIdentity = async () => { throw new Error('GitHub answered HTTP 502') }
    const lines = []
    let set = 0
    const d = makeDispatcher({
      setGitIdentity: async () => { set += 1 },
    }, { minter, log: (...a) => lines.push(a.join(' ')) })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })

    assert.match(reply, /dispatched/)
    assert.equal(set, 0, 'an identity nobody could read is never written')
    assert.equal(readGhCredentials(cfgOf('curia-42')), 'ghs_minted1', 'the token still landed')
    assert.ok(lines.some((l) => /HTTP 502.*commits under this box's git identity/.test(l)))
    d.agents.delete('curia-42')
  })

  test('no app on the box leaves every agent on the PAT, untouched', async () => {
    const restore = withPat()
    try {
      const d = makeDispatcher()
      await d.start('42', { repo: 'o/r', by: 'test' })
      const env = envFileOf('curia-42')
      assert.equal(env.GH_TOKEN, 'github_pat_11PAT')
      assert.equal('GH_CONFIG_DIR' in env, false)
      assert.equal(fs.existsSync(hostsOf('curia-42')), false)
      d.agents.delete('curia-42')
    } finally {
      restore()
    }
  })

  test('a mint that fails falls back to the PAT, and leaves no stale credential behind', async () => {
    const restore = withPat()
    try {
      // The re-arm case, which is the one that bites: a config dir is reused
      // across dispatches, `gh` prefers GH_TOKEN over hosts.yml, and a left-over
      // file would be a credential on disk that nothing reads and the refresh
      // would keep alive.
      fs.mkdirSync(cfgOf('curia-42'), { recursive: true })
      writeGhCredentials(cfgOf('curia-42'), 'ghs_fromlasttime')
      const d = makeDispatcher({}, { minter: fakeMinter({ fail: true }) })
      await d.start('42', { repo: 'o/r', by: 'test' })

      const env = envFileOf('curia-42')
      assert.equal(env.GH_TOKEN, 'github_pat_11PAT')
      assert.equal('GH_CONFIG_DIR' in env, false)
      assert.equal(fs.existsSync(hostsOf('curia-42')), false)
      d.agents.delete('curia-42')
    } finally {
      restore()
    }
  })

  test('the refresh rewrites a live agent, and never arms one on the PAT', async () => {
    const minter = fakeMinter()
    const d = makeDispatcher({}, { minter })
    await d.start('42', { repo: 'o/r', by: 'test' })
    assert.equal(readGhCredentials(cfgOf('curia-42')), 'ghs_minted1')

    // An agent that fell back: a record with a config dir and no file. The
    // file's ABSENCE is what says it reads GH_TOKEN, and a refresh that wrote
    // one would put a live token where nothing looks.
    fs.mkdirSync(cfgOf('curia-99'), { recursive: true })
    d.agents.set('curia-99', {
      session: 'curia-99', ticket: '99', repo: 'o/r', cfgDir: cfgOf('curia-99'), state: 'ready',
    })

    await d.refreshGhCredentials()

    assert.equal(readGhCredentials(cfgOf('curia-42')), 'ghs_minted2')
    assert.equal(fs.existsSync(hostsOf('curia-99')), false)
    d.agents.delete('curia-42')
    d.agents.delete('curia-99')
  })

  test('a refresh that cannot mint leaves the last good token standing', async () => {
    const d = makeDispatcher({}, { minter: fakeMinter() })
    await d.start('42', { repo: 'o/r', by: 'test' })
    assert.equal(readGhCredentials(cfgOf('curia-42')), 'ghs_minted1')

    // GitHub is down, or the install was removed mid-ticket. That token is good
    // for up to another hour and the next tick is 60 s away, so deleting it
    // would break an agent this pass cannot fix.
    d.minter = fakeMinter({ fail: true })
    await d.refreshGhCredentials()

    assert.equal(readGhCredentials(cfgOf('curia-42')), 'ghs_minted1')
    d.agents.delete('curia-42')
  })

  test('the ending takes the credential with it, whatever the ending was', async () => {
    const d = makeDispatcher({
      // the real sweep, not the no-op double: this is the code under test
      removeCredentials,
    }, { minter: fakeMinter() })
    await d.start('42', { repo: 'o/r', by: 'test' })
    assert.equal(fs.existsSync(hostsOf('curia-42')), true)

    // The two terminal states that KEEP the config dir for a post-mortem sweep
    // credentials rather than the directory, and this is the call they make.
    removeCredentials(cfgOf('curia-42'))
    assert.equal(fs.existsSync(hostsOf('curia-42')), false)
    d.agents.delete('curia-42')
  })
})

// The overseer is the second holder to move (ADR-0018). It is one long-lived
// container rather than a fleet, so the pass is per WATCHED OWNER and it runs
// whether or not that container has ever asked for a token.
describe('the overseer mints its read-only token (#392)', () => {
  const tokensDir = () => path.join(tmp, 'work', 'overseer', 'tokens')
  const tokenOf = (owner) => readOverseerToken(tokensDir(), owner)

  const readMinter = ({ fail = null } = {}) => {
    const calls = []
    let n = 0
    return {
      calls,
      tokenFor: async (owner, role) => {
        calls.push({ owner, role })
        if (fail === owner || fail === true) throw new Error(`curia's GitHub App is not installed on ${owner}`)
        n += 1
        return `ghs_read${n}`
      },
    }
  }

  test('one READ token per watched owner, in a file the container can only read', async () => {
    const minter = readMinter()
    const d = makeDispatcher({}, {
      minter, watch: [{ repo: 'o/r' }, { repo: 'o/second' }, { repo: 'other/thing' }],
    })

    await d.refreshOverseerCredentials()

    assert.deepEqual(minter.calls, [{ owner: 'o', role: 'read' }, { owner: 'other', role: 'read' }],
      'one call per OWNER, never per repo, and never the write set')
    assert.equal(tokenOf('o'), 'ghs_read1')
    assert.equal(tokenOf('other'), 'ghs_read2')
    assert.equal(fs.statSync(path.join(tokensDir(), 'o')).mode & 0o077, 0)
  })

  test('the refresh replaces the value, which is what makes the hour survivable', async () => {
    const d = makeDispatcher({}, { minter: readMinter() })
    await d.refreshOverseerCredentials()
    assert.equal(tokenOf('o'), 'ghs_read1')
    await d.refreshOverseerCredentials()
    assert.equal(tokenOf('o'), 'ghs_read2')
  })

  test('an owner curia cannot mint for keeps the token it has, and the others still land', async () => {
    const d = makeDispatcher({}, { minter: readMinter(), watch: [{ repo: 'o/r' }, { repo: 'other/thing' }] })
    await d.refreshOverseerCredentials()
    const held = tokenOf('o')

    d.minter = readMinter({ fail: 'o' })
    await d.refreshOverseerCredentials()

    assert.equal(tokenOf('o'), held, 'that token is good for up to another hour, and the next tick is 60 s away')
    assert.equal(tokenOf('other'), 'ghs_read1', 'one owner curia cannot reach does not strand the rest')
  })

  test('an owner the watch list drops loses its file: nothing refreshes it any more', async () => {
    const d = makeDispatcher({}, { minter: readMinter(), watch: [{ repo: 'o/r' }, { repo: 'other/thing' }] })
    await d.refreshOverseerCredentials()
    assert.equal(tokenOf('other'), 'ghs_read2')

    d.config.watch = [{ repo: 'o/r' }]
    await d.refreshOverseerCredentials()

    assert.equal(tokenOf('other'), null)
    assert.deepEqual(fs.readdirSync(tokensDir()), ['o'])
  })

  test('a box with no app writes nothing at all, rather than an empty file', async () => {
    const d = makeDispatcher()
    await d.refreshOverseerCredentials()
    assert.equal(fs.existsSync(tokensDir()), false)
  })
})

describe('every spawn path authenticates the agent the same way (#53, #156)', () => {
  // #53 pinned this against the host credential store, which a bare pane shared
  // through `CLAUDE_SECURESTORAGE_CONFIG_DIR`. #195 deleted the bare pane, so
  // the reduction is gone: the pane environment is EMPTY on purpose (a pane env
  // would put every value in `ps`, the cost #155 measured), and the credential
  // rides the container's `--env-file` instead.
  //
  // What #53 was really about survives, and is what is asserted here: the
  // frozen-copy failure (#34) came back on the *respawn* path in an earlier
  // shape of this code, so both paths are read. An agent authenticated one way
  // at spawn and another way after a fallback is still broken.
  const envFileOf = (session) => {
    const file = path.join(tmp, 'work', 'cfg', session, ENV_FILE)
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
      .filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  }

  test('the initial spawn puts nothing in the pane and the credential in the container env file', async () => {
    const envs = []
    const files = []
    const d = makeDispatcher({
      newSession: async ({ env }) => { envs.push(env); files.push(envFileOf('curia-42')) },
    })

    await d.start('42', { repo: 'o/r', by: 'test' })

    assert.equal(envs.length, 1)
    assert.deepEqual(envs[0], {}, 'the pane env would show every value in `ps`')
    assert.equal(files[0].ANTHROPIC_API_KEY, 'sk-test')
    // the config dir the AGENT sees is its mount point, not the host path
    assert.equal(files[0].CLAUDE_CONFIG_DIR, GUEST_CFG)
    assert.equal('CLAUDE_SECURESTORAGE_CONFIG_DIR' in files[0], false, 'the container denies the host HOME')

    // retire the watchdog: the loop stops as soon as the record it was spawned
    // for is gone, and a poller outliving its test journals into the NEXT one
    d.agents.delete('curia-42')
  })

  test('the respawn after a usage limit authenticates identically', async () => {
    const routing = {
      defaults: ROUTING.defaults,
      models: {
        sonnet: { provider: 'anthropic', harness: 'claude' },
        haiku: { provider: 'anthropic', harness: 'claude' },
      },
      fallbacks: { sonnet: ['haiku'] },
      harnesses: ROUTING.harnesses,
    }
    const files = []
    const d = makeDispatcher({
      newSession: async () => { files.push(envFileOf('curia-42')) },
      capturePane: async () => 'Sonnet usage limit reached | 1800000000',
    }, { routing })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => files.length > 1)

    assert.equal(files[1].ANTHROPIC_API_KEY, 'sk-test')
    assert.deepEqual(files[1], files[0], 'a respawn must not be authenticated differently from a spawn')

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

// The pre-emptive hold (#384, decided on #339). The reactive path waits for an
// agent to hit the wall; this one reads the account bars and holds the provider
// before that happens. Same store, so every start path already steps over it —
// what is tested here is what WRITES and CLEARS the entry, and that a hold and a
// landed cap are told apart everywhere the difference matters.
describe('a hot reading cools the provider before the limit lands (#384)', () => {
  // Two providers, so a held one has somewhere to fall to.
  const TWO = {
    defaults: { untyped: 'sonnet' },
    models: {
      sonnet: { provider: 'anthropic', harness: 'claude' },
      gpt: { provider: 'openai', harness: 'claude' },
    },
    fallbacks: { sonnet: ['gpt'] },
    harnesses: ROUTING.harnesses,
  }
  const ahead = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString()
  const reading = (pct, { provider = 'anthropic', label = '5h', at = ahead(90) } = {}) => (
    [{ provider, from: 'account', session: null, windows: [{ label, pct, elapsedPct: 40, resetsAt: at }] }]
  )

  test('a window at COOL_PCT holds the provider, and says so once', () => {
    let pct = 92
    const d = makeDispatcher({}, { routing: TWO, readings: () => reading(pct) })

    d.judgeReadings()
    assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true, 'the chain steps over a held provider')
    assert.equal(d.cooling.isCool('gpt', 'openai'), false, 'the hold is per provider')
    const held = events.filter((e) => e.type === 'provider_precooling')
    assert.equal(held.length, 1)
    assert.equal(held[0].provider, 'anthropic')
    assert.equal(held[0].window, '5h')
    assert.equal(held[0].pct, 92)
    assert.ok(Date.parse(held[0].reset_at) > Date.now(), 'the lift time is the window reset')
    assert.notEqual(held[0].type, 'provider_cooling')

    // The reading refreshes every ten minutes and says the same thing. The
    // hold stands, and the feed does not repeat itself.
    pct = 94
    d.judgeReadings()
    assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true)
    assert.equal(events.filter((e) => e.type === 'provider_precooling').length, 1)
  })

  test('the hold stands through the hysteresis band and lifts under it', () => {
    let pct = 91
    const d = makeDispatcher({}, { routing: TWO, readings: () => reading(pct) })

    d.judgeReadings()
    pct = 87 // below COOL_PCT, above WARM_PCT: still held
    d.judgeReadings()
    assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true, 'a hold hovering on the threshold must not flap')
    assert.equal(events.filter((e) => e.type === 'provider_precooling_lifted').length, 0)

    pct = 84
    d.judgeReadings()
    assert.equal(d.cooling.isCool('sonnet', 'anthropic'), false)
    const lifted = events.filter((e) => e.type === 'provider_precooling_lifted')
    assert.equal(lifted.length, 1)
    assert.equal(lifted[0].provider, 'anthropic')
    assert.equal(lifted[0].pct, 84)
  })

  test('a window that rolled lifts the hold, whatever the old number said', () => {
    // What `accountWindows` hands over once the reset passes: a fresh window at
    // 0%, marked `fresh`. Nothing else has to notice the roll.
    let windows = reading(96)
    const d = makeDispatcher({}, { routing: TWO, readings: () => windows })
    d.judgeReadings()
    assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true)

    windows = [{ provider: 'anthropic', from: 'account', session: null, windows: [{ label: '5h', pct: 0, elapsedPct: 2, resetsAt: ahead(300), fresh: true }] }]
    d.judgeReadings()
    assert.equal(d.cooling.isCool('sonnet', 'anthropic'), false)
    assert.ok(events.some((e) => e.type === 'provider_precooling_lifted'))
  })

  test('a provider with no reading is never held, and a reading curia cannot take holds nothing', () => {
    const d = makeDispatcher({}, { routing: TWO, readings: () => reading(97) })
    d.judgeReadings()
    assert.equal(d.cooling.isCool('gpt', 'openai'), false, 'openai states no window here, so it says nothing rather than zero')

    const blind = makeDispatcher({}, {
      routing: TWO,
      readings: () => { throw new Error('the probe is refused') },
    })
    blind.judgeReadings()
    assert.deepEqual(blind.preCoolings(), [])
    assert.equal(events.filter((e) => e.type === 'provider_precooling').length, 1, 'the first dispatcher wrote that one')
  })

  test('a landed cap outranks the hold, and the hold never clears it', () => {
    let pct = 93
    const d = makeDispatcher({}, { routing: TWO, readings: () => reading(pct) })
    d.judgeReadings()
    assert.deepEqual(d.preCoolings().map((h) => h.provider), ['anthropic'])

    // The wall the reading was walking towards. #handleLimit writes the landed
    // entry over the prediction.
    const landed = new Date(Date.now() + 5 * 3600_000)
    d.cooling.coolProvider('anthropic', landed)
    assert.deepEqual(d.preCoolings(), [], 'a measured cap is not a guess, and no surface calls it one')

    // The reading falls away, and the landed cap stands until its own reset.
    pct = 3
    d.judgeReadings()
    assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true)
    assert.equal(d.cooling.earliestReset().getTime(), landed.getTime())
    assert.equal(events.filter((e) => e.type === 'provider_precooling_lifted').length, 0,
      'nothing was lifted: the entry standing there was never a prediction')
  })

  test('a start on a held provider takes the other lane, and a named model takes the held one', async () => {
    const d = makeDispatcher({}, { routing: TWO, readings: () => reading(93) })
    await d.start('42', { repo: 'o/r', by: 'test' })
    const spawned = events.filter((e) => e.type === 'agent_spawned')
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].model, 'gpt', 'the chain steps over the hold exactly as it does for a landed cap')

    // The deliberate last-10% burn: the operator has read the same bars.
    const named = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, number: 43, labels: [{ name: 'model:sonnet' }] }),
    }, { routing: TWO, readings: () => reading(93) })
    await named.start('43', { repo: 'o/r', by: 'test' })
    const second = events.filter((e) => e.type === 'agent_spawned').at(-1)
    assert.equal(second.model, 'sonnet', 'a `model:` label steps over a PREDICTED entry')
  })

  test('a named model never steps over a landed cap', async () => {
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'model:sonnet' }] }),
    }, { routing: TWO })
    d.cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))
    await d.start('42', { repo: 'o/r', by: 'test' })
    const spawned = events.filter((e) => e.type === 'agent_spawned')
    assert.equal(spawned.at(-1).model, 'gpt', 'the label is not a way past a cap that already landed')
  })

  test('the boot seed takes landed caps only — a hold curia did not measure never binds', () => {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), [
      { ts: new Date().toISOString(), type: 'provider_precooling', provider: 'anthropic', window: '5h', pct: 96, reset_at: new Date(Date.now() + 3600_000).toISOString() },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    const d = makeDispatcher({}, { routing: TWO })
    assert.equal(d.cooling.isCool('sonnet', 'anthropic'), false,
      'the reading that wrote it is gone, so the guess it carried does not bind this process')
  })
})

// The limit resume (#346). True exhaustion killed the agent, released the claim
// and left the worktree standing, and then nothing moved: the wake timer fired
// #autoTick, which returns at once while `auto_dispatch` is false, and that
// flag ships false. The work waited for a human to notice.
describe('the limit resume: the window rolls and curia puts the agent back (#346)', () => {
  function writeJournal(lines) {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  // An epoch the pane can state, seconds out, so the whole real path runs
  // inside a test: cap, cooling, exhaustion, arm, wake, resume.
  const soon = (s) => Math.floor(Date.now() / 1000) + s
  const iso = (s) => new Date(s).toISOString()
  const MAP = [{ number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] }]
  const child = (n) => ({
    number: n, state: 'open', assignees: [], labels: [{ name: 'wayfinder:task' }],
    issue_dependencies_summary: { blocked_by: 0 },
  })

  test('an instant goes out as epoch SECONDS in Discord markup, so a phone renders its own clock', () => {
    // Seconds, not milliseconds: Discord reads the number as epoch seconds and
    // a millisecond value lands the operator tens of thousands of years out.
    assert.equal(discordTime(new Date('2026-08-15T10:00:00.000Z')), '<t:1786788000:t> (<t:1786788000:R>)')
    assert.equal(discordTime(new Date('2026-08-15T10:00:00.999Z')), '<t:1786788000:t> (<t:1786788000:R>)')
  })

  test('true exhaustion arms the resume, and the thread states the instant in local time', async () => {
    const at = soon(3600)
    const d = makeDispatcher({ capturePane: async () => `Claude usage limit reached | ${at}` })

    await d.start('42', { repo: 'o/r', by: 'test' })

    await waitFor(() => events.some((e) => e.type === 'limit_resume_armed'))
    const armed = events.find((e) => e.type === 'limit_resume_armed')
    assert.equal(String(armed.ticket), '42')
    assert.equal(armed.repo, 'o/r')
    assert.equal(Date.parse(armed.resume_at), at * 1000 + 60_000, 'a minute behind the stated reset, for the clock skew')
    assert.ok(d.limitResumes.has('42'))

    // ONE message, not two: the promise is per ticket and the window sentence
    // is per window, and folding them keeps the count where #13 put it.
    const line = notifies.find((n) => /every routing lane is cooling/.test(n.message))
    assert.match(line.message, /curia resumes this ticket/)
    assert.match(line.message, new RegExp(`<t:${at + 60}:t>`), 'a phone reads its own clock, never an ISO string in UTC')
    assert.equal(notifies.filter((n) => /cooling/.test(n.message)).length, 1)
  })

  test('the SECOND ticket to exhaust in one window is armed AND told', async () => {
    // The latch is per window and the promise is per ticket, and the two land
    // in two different threads. A promise on its own line would be swallowed
    // by the latch here, and #43 would be resumed with nobody told it would be.
    let capped = false
    const at = soon(3600)
    const d = makeDispatcher({
      fetchIssue: async (repo, n) => ({ ...OPEN_ISSUE, number: Number(n) }),
      capturePane: async () => (capped ? `Claude usage limit reached | ${at}` : ''),
    })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await d.start('43', { repo: 'o/r', by: 'test' })
    capped = true

    await waitFor(() => events.filter((e) => e.type === 'limit_resume_armed').length === 2, 15_000)
    assert.deepEqual(
      events.filter((e) => e.type === 'limit_resume_armed').map((e) => String(e.ticket)).sort(),
      ['42', '43'],
    )
    for (const ticket of ['42', '43']) {
      const said = notifies.filter((n) => String(n.ticket) === ticket && /curia resumes this ticket/.test(n.message))
      assert.equal(said.length, 1, `#${ticket} is told once that curia will resume it`)
      assert.match(said[0].message, new RegExp(`<t:${at + 60}:t>`))
    }
  })

  test('the wake RESUMES: the surviving worktree is handed back, never recreated from origin', async () => {
    let clones = 0
    let wt = null
    let capped = true
    const d = makeDispatcher({
      capturePane: async () => (capped ? `Claude usage limit reached | ${soon(2)}` : '⏵⏵ bypass permissions'),
      // The cap is a one-shot: the kill is what ends this agent's, so the
      // resumed one comes up on a healthy pane.
      killSession: async () => { capped = false },
      createPrivateClone: async (r, repo, n) => { clones += 1; wt = fakePrivateClone(r, repo, n); return wt },
    })
    d.resumeGraceMs = 0
    d.wakeFloorMs = 5

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => events.some((e) => e.type === 'limit_resume_armed'))
    // What an agent had written and not committed when the cap landed.
    fs.writeFileSync(path.join(wt, 'work-in-progress.txt'), 'half a day of it')

    await waitFor(() => notifies.some((n) => /the usage limit reset/.test(n.message)), 15_000)

    assert.equal(clones, 1, 'createPrivateClone deletes the worktree first, so a resume must never reach it')
    assert.equal(fs.readFileSync(path.join(wt, 'work-in-progress.txt'), 'utf8'), 'half a day of it')
    assert.ok(notifies.some((n) => /the usage limit reset\. ⚙️ dispatched o\/r#42/.test(n.message)),
      'the reason curia started it rides in front of the ordinary dispatch line')
    assert.ok(events.some((e) => e.type === 'limit_resume' && e.outcome === 'ran'))
    assert.equal(d.limitResumes.size, 0, 'one arm buys one attempt')
  })

  test('a lane still cooling at the wake re-arms instead of stranding the ticket', async () => {
    const d = makeDispatcher({ capturePane: async () => `Claude usage limit reached | ${soon(2)}` })
    d.resumeGraceMs = 0
    d.wakeFloorMs = 5

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => events.some((e) => e.type === 'limit_resume_armed'))
    // A second cap the first one hid: the provider rolls, the model does not.
    const later = new Date(Date.now() + 3600_000)
    d.cooling.coolModel('sonnet', later)

    await waitFor(() => events.filter((e) => e.type === 'limit_resume_armed').length === 2, 15_000)

    const arms = events.filter((e) => e.type === 'limit_resume_armed')
    assert.equal(Date.parse(arms[1].resume_at), later.getTime(), 'the arm follows the lane that is still cooling')
    assert.ok(d.limitResumes.has('42'))
    assert.equal(events.filter((e) => e.type === 'limit_resume').length, 1, 'the attempt happened, and it was one')
    assert.equal(notifies.filter((n) => /the usage limit reset/.test(n.message)).length, 0,
      'the exhaustion already stated the new instant — saying it twice is two voices on one fact')
  })

  test('a resume curia cannot make says so in the same thread the promise landed in', async () => {
    // tmux goes indeterminate between the cap and the wake, which is the shape
    // every dispatch refuses on rather than guessing at.
    let wedged = false
    const d = makeDispatcher({
      capturePane: async () => `Claude usage limit reached | ${soon(2)}`,
      killSession: async () => { wedged = true },
      hasSession: async () => {
        if (wedged) throw new Error('tmux session presence is indeterminate: timeout')
        return false
      },
    })
    d.resumeGraceMs = 0
    d.wakeFloorMs = 5

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => events.some((e) => e.type === 'limit_resume_armed'))

    await waitFor(() => events.some((e) => e.type === 'limit_resume' && e.outcome === 'failed'), 15_000)
    const said = notifies.find((n) => /curia could not resume this ticket/.test(n.message))
    assert.ok(said, 'silence after a cap is the fault this path exists to end')
    assert.match(said.message, /`resume 42`/, 'the operator is told how to do it by hand')
    assert.equal(d.limitResumes.size, 0)
  })

  test('the arm outlives the daemon: reconcile re-arms it at boot from the journal', async () => {
    const at = new Date(Date.now() + 3600_000)
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'sonnet', ts: iso('2026-08-15T09:00:00Z') },
      { type: 'limit_resume_armed', repo: 'o/r', ticket: '42', resume_at: at.toISOString(), ts: iso('2026-08-15T10:00:00Z') },
    ])
    const d = makeDispatcher({ listSessions: async () => [] })

    await d.reconcile({ boot: true })

    assert.deepEqual([...d.limitResumes.keys()], ['42'])
    assert.equal(d.limitResumes.get('42').at.getTime(), at.getTime())
    assert.equal(d.limitResumes.get('42').repo, 'o/r')
  })

  test('a reset that passed while the daemon was down is due at once, not lost', async () => {
    writeJournal([
      { type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'sonnet', ts: iso('2026-08-15T09:00:00Z') },
      { type: 'limit_resume_armed', repo: 'o/r', ticket: '42', resume_at: iso('2026-08-15T10:00:00Z'), ts: iso('2026-08-15T09:30:00Z') },
    ])
    const d = makeDispatcher()
    d.wakeFloorMs = 5

    await d.reconcile({ boot: true })

    await waitFor(() => events.some((e) => e.type === 'limit_resume'), 15_000)
    assert.ok(notifies.some((n) => /the usage limit reset/.test(n.message)))
  })

  test('an agent that came back some other way is not resumed on top of itself', async () => {
    writeJournal([
      { type: 'limit_resume_armed', repo: 'o/r', ticket: '42', resume_at: new Date(Date.now() + 3600_000).toISOString(), ts: iso('2026-08-15T10:00:00Z') },
    ])
    const d = makeDispatcher({ listSessions: async () => [] })
    d.agents.set('curia-42', { session: 'curia-42', ticket: '42', repo: 'o/r' })

    await d.reconcile({ boot: true })

    assert.equal(d.limitResumes.size, 0)
  })

  // #377, the other half of the same restart. #346 kept the ARM across a deploy
  // and left the cooling in memory, so a daemon that came back inside the window
  // believed every lane was warm and spent a container proving otherwise.
  describe('the cooling outlives the daemon too (#377)', () => {
    test('a landed provider cap binds at CONSTRUCTION, before the daemon takes a command', () => {
      writeJournal([
        { type: 'provider_cooling', provider: 'anthropic', reset_at: new Date(Date.now() + 3600_000).toISOString(), reset_source: 'pane', ts: iso('2026-08-15T09:00:00Z') },
      ])

      // No reconcile, no start: the seed rides the constructor, because a
      // `start` typed two seconds after a deploy must not beat it.
      const lines = []
      const d = makeDispatcher({}, { log: (m) => lines.push(m) })

      assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true)
      assert.ok(lines.some((l) => /boot: cooling still holds — anthropic until/.test(l)),
        'the boot log names the hold, so an operator reading a quiet box knows why')
    })

    test('a model cap binds that model and leaves its provider warm', () => {
      writeJournal([
        { type: 'model_cooling', model: 'sonnet', reset_at: new Date(Date.now() + 3600_000).toISOString(), reset_source: 'transcript', ts: iso('2026-08-15T09:00:00Z') },
      ])

      const d = makeDispatcher()

      assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true)
      assert.equal(d.cooling.isCool('other', 'anthropic'), false, 'a model cap is not a provider cap')
    })

    test('the one-hour floor binds too — forgetting a guess is the restart-into-the-cap this fixes', () => {
      writeJournal([
        { type: 'provider_cooling', provider: 'anthropic', reset_at: new Date(Date.now() + 1800_000).toISOString(), reset_source: 'floor', ts: iso('2026-08-15T09:00:00Z') },
      ])

      const d = makeDispatcher()

      assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true)
    })

    test('a window that rolled while the daemon was down binds nothing', () => {
      writeJournal([
        { type: 'provider_cooling', provider: 'anthropic', reset_at: iso('2026-08-15T10:00:00Z'), reset_source: 'pane', ts: iso('2026-08-15T09:00:00Z') },
      ])

      const lines = []
      const d = makeDispatcher({}, { log: (m) => lines.push(m) })

      assert.equal(d.cooling.isCool('sonnet', 'anthropic'), false)
      assert.ok(!lines.some((l) => /cooling still holds/.test(l)),
        'a dead hold is skipped rather than armed, so the boot log states only what still binds')
    })

    test('the last cap on a key wins, so a re-cool after a resume states the fresh reset', () => {
      const later = new Date(Date.now() + 7200_000)
      writeJournal([
        { type: 'provider_cooling', provider: 'anthropic', reset_at: iso('2026-08-15T10:00:00Z'), reset_source: 'pane', ts: iso('2026-08-15T09:00:00Z') },
        { type: 'provider_cooling', provider: 'anthropic', reset_at: later.toISOString(), reset_source: 'pane', ts: iso('2026-08-15T11:00:00Z') },
      ])

      const d = makeDispatcher()

      assert.equal(d.cooling.isCool('sonnet', 'anthropic'), true)
      assert.equal(d.cooling.earliestReset().getTime(), later.getTime())
    })

    test('the whole point: the first start after the deploy spends no container', async () => {
      let clones = 0
      writeJournal([
        { type: 'provider_cooling', provider: 'anthropic', reset_at: new Date(Date.now() + 3600_000).toISOString(), reset_source: 'pane', ts: iso('2026-08-15T09:00:00Z') },
      ])
      const d = makeDispatcher({
        createPrivateClone: async (r, repo, n) => { clones += 1; return fakePrivateClone(r, repo, n) },
      })

      await d.start('42', { repo: 'o/r', by: 'test' })

      assert.equal(clones, 0, 'the cap was already measured — nothing is spawned into it')
      assert.ok(events.some((e) => e.type === 'dispatch_exhausted'))
      assert.ok(notifies.some((n) => /every routing lane is cooling/.test(n.message)),
        'the operator is told why, in the thread, instead of watching a container die')
    })
  })

  test('auto-dispatch steps over a ticket curia owes a resume, because start would delete its worktree', async () => {
    const started = []
    const d = makeDispatcher({
      repoMaps: async () => MAP,
      mapFrontier: async () => [child(42), child(43)],
      createPrivateClone: async (r, repo, n) => { started.push(String(n)); return fakePrivateClone(r, repo, n) },
    })
    d.config.dispatch.auto_dispatch = true
    d.config.dispatch.poll_interval_s = 0.05
    d.limitResumes.set('42', { repo: 'o/r', at: new Date(Date.now() + 3600_000) })

    d.startAutoLoop()
    await waitFor(() => started.includes('43'))
    await new Promise((r) => setTimeout(r, 150))
    clearInterval(d.autoTimer)

    assert.ok(!started.includes('42'), 'the armed ticket is the resume\'s, and a start would recreate its worktree')
  })

  // #376: #346 closed ONE instance of this and not the class. A ticket whose
  // agent died is unclaimed and back on the frontier with its worktree
  // standing, and it carries no arm — so the auto loop used to `start` it, and
  // `start` calls createPrivateClone, which deletes that worktree first.
  describe('and it resumes a surviving worktree rather than starting over one (#376)', () => {
    test('the uncommitted files of the dead agent stand, and the resumed agent runs in them', async () => {
      const clones = []
      const d = makeDispatcher({
        repoMaps: async () => MAP,
        mapFrontier: async () => [child(42)],
        createPrivateClone: async (r, repo, n) => { clones.push(String(n)); return fakePrivateClone(r, repo, n) },
      })
      // what the dead agent wrote and never committed
      const wt = fakePrivateClone(d.root, 'o/r', '42')
      fs.writeFileSync(path.join(wt, 'work-in-progress.txt'), 'half a day of it')
      d.config.dispatch.auto_dispatch = true
      d.config.dispatch.poll_interval_s = 0.05

      d.startAutoLoop()
      await waitFor(() => d.agents.has('curia-42'))
      d.stopAutoLoop()

      assert.deepEqual(clones, [], 'createPrivateClone deletes the worktree first, so the auto loop must never reach it')
      assert.equal(fs.readFileSync(path.join(wt, 'work-in-progress.txt'), 'utf8'), 'half a day of it')
      assert.equal(d.agents.get('curia-42').wtPath, wt, 'the resumed agent runs in the worktree that survived')
    })

    test('the thread is told curia resumed, and the journal records it', async () => {
      const d = makeDispatcher({
        repoMaps: async () => MAP,
        mapFrontier: async () => [child(42)],
      })
      fakePrivateClone(d.root, 'o/r', '42')
      d.config.dispatch.auto_dispatch = true
      d.config.dispatch.poll_interval_s = 0.05

      d.startAutoLoop()
      await waitFor(() => events.some((e) => e.type === 'auto_resume'))
      d.stopAutoLoop()

      const said = notifies.find((n) => String(n.ticket) === '42' && /RESUMED/.test(n.message))
      assert.ok(said, 'the death notify promised `resume 42` in this thread — curia says it made that resume itself')
      assert.match(said.message, /Nothing was recreated from origin/)
      const rec = events.find((e) => e.type === 'auto_resume')
      assert.equal(String(rec.ticket), '42')
      assert.equal(rec.repo, 'o/r')
    })

    test('a takeable ticket with no worktree is still started', async () => {
      const clones = []
      const d = makeDispatcher({
        repoMaps: async () => MAP,
        mapFrontier: async () => [child(43)],
        createPrivateClone: async (r, repo, n) => { clones.push(String(n)); return fakePrivateClone(r, repo, n) },
      })
      d.config.dispatch.auto_dispatch = true
      d.config.dispatch.poll_interval_s = 0.05

      d.startAutoLoop()
      await waitFor(() => clones.includes('43'))
      d.stopAutoLoop()

      assert.equal(events.some((e) => e.type === 'auto_resume'), false, 'no worktree stood, so nothing was resumed')
    })
  })

  // #362: `poll_interval_s` is the one reloadable setting the daemon CAPTURES —
  // it lives in the interval this arms. So a reload re-arms the loop, and the
  // old timer has to die with it: two timers on one dispatcher would tick twice
  // per interval for the rest of the process.
  test('the auto loop re-arms on the new interval, and the old timer stops ticking', async () => {
    let sweeps = 0
    const d = makeDispatcher({ hasSession: async () => { sweeps += 1; return true } })
    d.agents.set('curia-42', { session: 'curia-42', ticket: '42', repo: 'o/r' })
    d.config.dispatch.poll_interval_s = 0.05

    d.startAutoLoop()
    const fast = d.autoTimer
    await waitFor(() => sweeps >= 2)

    // The reload: a slower interval, armed over the top of the fast one.
    d.config.dispatch.poll_interval_s = 3600
    d.startAutoLoop()
    assert.notEqual(d.autoTimer, fast, 'a re-arm is a new timer')
    const taken = sweeps
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(sweeps, taken, 'the old 50ms timer would have fired several times by now')

    d.stopAutoLoop()
    assert.equal(d.autoTimer, null, 'a stopped loop holds no timer, so a reload does not arm one before boot reconcile has')
  })
})

// The failed-spawn step-over (#444). A dispatch that fails releases the claim,
// so the ticket is back on the frontier and the next tick takes it again. #376
// made the loop RESUME a surviving worktree, which keeps the files and stops no
// repeat: a resume that dies the same way arms the same loop.
describe('the auto loop stops taking a ticket that dies at every spawn (#444)', () => {
  const MAP = [{ number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] }]
  const child = (n) => ({
    number: n, state: 'open', assignees: [], labels: [{ name: 'wayfinder:task' }],
    issue_dependencies_summary: { blocked_by: 0 },
  })

  // The broken image pin of the ticket, in the seam a test owns: the clone is
  // inside #dispatch's try, so it fails the same way and by the same path.
  function brokenBox(extra = {}) {
    const claims = []
    const d = makeDispatcher({
      repoMaps: async () => MAP,
      mapFrontier: async () => [child(42)],
      claim: async (repo, ticket) => { claims.push(`${repo}#${ticket}`) },
      createPrivateClone: async () => { throw new Error('the image pin is broken') },
      ...extra,
    })
    d.config.dispatch.auto_dispatch = true
    d.config.dispatch.poll_interval_s = 0.05
    return { d, claims }
  }

  test('two failed spawns, and the loop steps over it — every tick after costs nothing', async () => {
    const { d, claims } = brokenBox()

    d.startAutoLoop()
    await waitFor(() => events.some((e) => e.type === 'dispatch_held'))
    // Several more ticks at 50ms, which is what the loop had before this.
    await new Promise((r) => setTimeout(r, 400))
    d.stopAutoLoop()

    assert.deepEqual(claims, ['o/r#42', 'o/r#42'], 'two containers and two claim round-trips, then nothing')
    assert.equal(events.filter((e) => e.type === 'dispatch_failed').length, 2)
    assert.equal(d.dispatchHolds().length, 1, 'and the surfaces can say which ticket the loop steps over')
    assert.deepEqual(d.dispatchHolds(), [{ ticket: '42', repo: 'o/r', failures: 2 }])
  })

  test('the thread hears it once, at the instant the step-over arms', async () => {
    const { d } = brokenBox()

    d.startAutoLoop()
    await waitFor(() => events.some((e) => e.type === 'dispatch_held'))
    await new Promise((r) => setTimeout(r, 400))
    d.stopAutoLoop()

    const said = notifies.filter((n) => /steps over it/.test(n.message))
    assert.equal(said.length, 1, 'a line per tick is the traffic this ticket exists to end')
    assert.match(said[0].message, /start 42/, 'and it names the act that clears the count')
    assert.equal(events.filter((e) => e.type === 'dispatch_held').length, 1)
  })

  test('a dispatch the operator types runs, and clears the count with it', async () => {
    const { d, claims } = brokenBox()

    d.startAutoLoop()
    await waitFor(() => events.some((e) => e.type === 'dispatch_held'))
    d.stopAutoLoop()

    // The operator fixed the cause. The clone works now.
    d.deps.createPrivateClone = async (r, repo, n) => fakePrivateClone(r, repo, n)
    const reply = await d.start('42', { repo: 'o/r', by: 'alp82' })

    assert.match(reply, /dispatched/, 'the step-over binds the auto loop, and never a press')
    assert.deepEqual(claims, ['o/r#42', 'o/r#42', 'o/r#42'])
    assert.equal(d.dispatchHolds().length, 0, 'the typed dispatch cleared the count')
    d.agents.clear()
  })

  test('an agent that reached its curia tools clears the count, so a working ticket is never held', async () => {
    const { d } = brokenBox({ createPrivateClone: async (r, repo, n) => fakePrivateClone(r, repo, n) })

    // A spawn that came up and spoke, then died with nothing reported. #376
    // resumes it, and this must never be read as a ticket dying at its spawn.
    for (let i = 0; i < 3; i += 1) {
      d.reduction.journal('dispatch_claimed', { repo: 'o/r', ticket: '42', agent: 'curia-42', by: 'auto' })
      d.agents.set('curia-42', { session: 'curia-42', ticket: '42', repo: 'o/r', spawnedAt: Date.now() })
      d.onMcpCall('curia-42')
      d.agents.delete('curia-42')
      d.reduction.journal('dispatch_failed', { repo: 'o/r', ticket: '42', reason: 'the agent died without reporting a result' })
    }

    assert.equal(d.reduction.failedSpawns('42'), 1, 'every death counts from zero again')
    assert.deepEqual(d.dispatchHolds(), [])
  })

  test('exhaustion is not a failed spawn — the cooling is already its own throttle', async () => {
    const at = Math.floor(Date.now() / 1000) + 3600
    const d = makeDispatcher({ capturePane: async () => `Claude usage limit reached | ${at}` })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => events.some((e) => e.type === 'limit_resume_armed'))

    assert.equal(d.reduction.failedSpawns('42'), 0, 'every lane cooling is not this ticket dying at its spawn')
    assert.deepEqual(d.dispatchHolds(), [])
    d.agents.clear()
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
      createPrivateClone: async () => { destroyed.push('worktree'); return '/x' },
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
      removeWorkspace: async (wt) => acts.push(`workspace:${wt}`),
      unclaim: async (repo, t) => acts.push(`unclaim:${repo}#${t}`),
      removeConfigDir: (dir) => acts.push(`cfg:${path.basename(dir)}`),
    })
    d.agents.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready' })

    const reply = await d.cancel('42', { by: 'test' })

    assert.match(reply, /cancelled/)
    assert.match(reply, /worktree removed, ticket re-frontiered/)
    assert.deepEqual(acts, ['kill:curia-42', 'workspace:/w/42', 'unclaim:o/r#42', 'cfg:curia-42'])
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
      // Named rather than blanket-true (#164): `cancel` now also asks whether a
      // cross-check reviewer is live on this ticket, and a double that says yes
      // to every name would have this test tear one down too.
      hasSession: async (n) => n === 'curia-42',
      killSession: async (n) => acts.push(`kill:${n}`),
      removeWorkspace: async () => acts.push('workspace'),
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

// #208: words typed at an agent die with that agent. The confirm rule of #94,
// applied to the note queue — same exit paths, same reason, and the operator
// is told at the moment the words die rather than left to find out when a
// successor acts on them an hour later (#170).
describe('operator notes die with the instance they were typed at (#208)', () => {
  const noted = (instance) => ({ text: 'cancel 42', instance })
  const writeJournal = (lines) =>
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const agentAt = (instance) => ({
    repo: 'o/r', ticket: '42', session: 'curia-42', instance,
    wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready', resultReceived: false,
  })

  test('a finished agent takes its unread notes with it, and the thread gets the count', async () => {
    const d = makeDispatcher({ hasSession: async () => false })
    d.agents.set('curia-42', agentAt('curia-42@1'))
    agentNotes.set('curia-42', [noted('curia-42@1'), noted('curia-42@1')])
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{}')

    await d.onAgentDone('curia-42')

    assert.deepEqual(agentNotes.get('curia-42'), [], 'nothing survives to a successor')
    const line = notifies.find((n) => /operator note/.test(n.message))
    assert.ok(line, 'a note that vanishes with no line is the dead end #170 was about')
    assert.match(line.message, /2 operator notes it never read/)
    assert.match(line.message, /resume 42/)
    assert.ok(!line.message.includes('cancel 42'), 'the count, never the words')
  })

  test('a result-less exit expires them too — that is the #170 shape exactly', async () => {
    const d = makeDispatcher({ hasSession: async () => false })
    d.agents.set('curia-42', agentAt('curia-42@1'))
    agentNotes.set('curia-42', [noted('curia-42@1')])

    await d.onAgentDone('curia-42')

    assert.deepEqual(agentNotes.get('curia-42'), [])
    assert.match(notifies.find((n) => /operator note/.test(n.message)).message, /1 operator note it never read/)
  })

  test('the #139 hand-off carries no instance, so it survives every exit', async () => {
    const d = makeDispatcher({ hasSession: async () => false })
    d.agents.set('curia-42', agentAt('curia-42@1'))
    const handOff = { text: 'a human answered esc-3', instance: null }
    agentNotes.set('curia-42', [noted('curia-42@1'), handOff])

    await d.onAgentDone('curia-42')

    assert.deepEqual(agentNotes.get('curia-42'), [handOff], 'the successor is the whole point of that one')
    assert.match(notifies.find((n) => /operator note/.test(n.message)).message, /1 operator note it never read/)
  })

  test('an exit with nothing queued says nothing — no empty line in the thread', async () => {
    const d = makeDispatcher({ hasSession: async () => false })
    d.agents.set('curia-42', agentAt('curia-42@1'))

    await d.onAgentDone('curia-42')

    assert.equal(notifies.filter((n) => /operator note/.test(n.message)).length, 0)
  })

  test('adoption after a restart mints a fresh instance, so pre-restart words expire there too', async () => {
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }])
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
    })
    agentNotes.set('curia-42', [noted('curia-42@before-the-restart')])

    await d.reconcile({ boot: false })

    assert.deepEqual(agentNotes.get('curia-42'), [])
    const line = notifies.find((n) => /operator note/.test(n.message))
    // this agent IS running, so the way out is the thread, not a resume
    assert.match(line.message, /Say them again in this thread/)
  })
})

// #252, ADR-0013: the second delivery mode. Queued is the default and owes no
// reply; the operator picks interrupt by pressing the button under the receipt,
// and the words then go into the pane as a user turn. The agent's own reply is
// the outcome, so nothing here composes one.
describe('a note interrupts instead of queueing (#252)', () => {
  const liveAgent = (instance = 'curia-42@1') => ({
    repo: 'o/r', ticket: '42', session: 'curia-42', instance,
    wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready',
  })
  const queued = (id, instance = 'curia-42@1') => ({
    id, agent: 'curia-42', text: 'whats taking so long', instance, label: null, pending: true,
  })

  // The keystrokes the pane would see, in order.
  const keyed = () => {
    const typed = []
    const d = makeDispatcher({
      sendKey: async (session, key) => typed.push({ session, key }),
      sendText: async (session, text) => typed.push({ session, text }),
    })
    d.interruptGraceMs = 0
    return { d, typed }
  }

  test('Escape first, then the words as a user turn', async () => {
    const { d, typed } = keyed()
    d.agents.set('curia-42', liveAgent())
    agentNotes.set('curia-42', [queued('note-1')])

    const res = await d.interruptNote('note-1', { by: 'u1' })
    await new Promise((r) => setTimeout(r, 5))

    assert.equal(res.ok, true)
    assert.equal(typed[0].key, 'Escape', 'the grace is over, so the current tool call is aborted')
    assert.match(typed[1].text, /whats taking so long/)
    assert.match(typed[1].text, /interrupting from the thread/, 'the agent must know a human typed this')
    assert.match(typed[1].text, /`notify` tool/, 'the pane is not a surface the operator reads')
    assert.ok(typesOf().includes('note_interrupt_delivered'))
  })

  // A composer reads a newline as a submit, so a two-line send starts a turn on
  // the first half and leaves the rest in the box.
  test('the pane gets ONE line, whatever the operator typed', async () => {
    const { d, typed } = keyed()
    d.agents.set('curia-42', liveAgent())
    agentNotes.set('curia-42', [{ ...queued('note-1'), text: 'stop\n\nand check #118 first' }])

    await d.interruptNote('note-1', { by: 'u1' })
    await new Promise((r) => setTimeout(r, 5))

    assert.ok(!typed[1].text.includes('\n'), 'a newline mid-send is a half-sent message')
    assert.match(typed[1].text, /stop and check #118 first/)
  })

  test('the words leave the queue, so no tool result carries them too', async () => {
    const { d } = keyed()
    d.agents.set('curia-42', liveAgent())
    agentNotes.set('curia-42', [queued('note-1'), queued('note-2')])

    await d.interruptNote('note-1', { by: 'u1' })

    assert.deepEqual(agentNotes.get('curia-42').map((n) => n.id), ['note-2'])
  })

  test('a dead agent refuses, and nothing is typed anywhere', async () => {
    const { d, typed } = keyed()
    agentNotes.set('curia-42', [queued('note-1')])

    const res = await d.interruptNote('note-1', { by: 'u1' })
    await new Promise((r) => setTimeout(r, 5))

    assert.equal(res.ok, false)
    assert.match(res.why, /NOT running/)
    assert.match(res.why, /resume 42/)
    assert.deepEqual(typed, [])
  })

  test('words typed at an earlier instance refuse — a note dies with its agent (#208)', async () => {
    const { d, typed } = keyed()
    d.agents.set('curia-42', liveAgent('curia-42@2'))
    agentNotes.set('curia-42', [queued('note-1', 'curia-42@1')])

    const res = await d.interruptNote('note-1', { by: 'u1' })

    assert.equal(res.ok, false)
    assert.match(res.why, /earlier/)
    assert.deepEqual(typed, [])
  })

  // The refusal that matters most: the agent is blocked INSIDE ask_human, so
  // the Escape would abort the very tool call that is asking the question.
  test('an open escalation refuses, and names the question to answer instead', async () => {
    const { d, typed } = keyed()
    d.agents.set('curia-42', liveAgent())
    agentNotes.set('curia-42', [queued('note-1')])
    escalations.push({ id: 'esc-3', agent: 'curia-42', ticket: '42', status: 'open', kind: 'free-text' })

    const res = await d.interruptNote('note-1', { by: 'u1' })
    await new Promise((r) => setTimeout(r, 5))

    assert.equal(res.ok, false)
    assert.match(res.why, /esc-3/)
    assert.deepEqual(typed, [], 'an interrupt here would abort the call that is asking')
  })

  test('an id that names nothing refuses rather than guessing at a note', async () => {
    const { d } = keyed()
    assert.equal((await d.interruptNote('note-404', { by: 'u1' })).ok, false)
  })

  test('an agent that exits during the grace loses the words, and the thread is told', async () => {
    const typed = []
    const d = makeDispatcher({
      sendKey: async () => typed.push('key'),
      sendText: async () => typed.push('text'),
    })
    d.interruptGraceMs = 5
    d.agents.set('curia-42', liveAgent())
    agentNotes.set('curia-42', [queued('note-1')])

    await d.interruptNote('note-1', { by: 'u1' })
    d.agents.delete('curia-42')
    await new Promise((r) => setTimeout(r, 25))

    assert.deepEqual(typed, [], 'a dead session names no pane')
    assert.match(notifies.at(-1).message, /reached nobody/)
    assert.match(notifies.at(-1).message, /whats taking so long/, 'the words are quoted back — nobody else holds them')
  })

  test('a send that fails says so, rather than leaving the operator to assume delivery', async () => {
    const d = makeDispatcher({
      sendKey: async () => {},
      sendText: async () => { throw new Error('no server running') },
    })
    d.interruptGraceMs = 0
    d.agents.set('curia-42', liveAgent())
    agentNotes.set('curia-42', [queued('note-1')])

    await d.interruptNote('note-1', { by: 'u1' })
    await new Promise((r) => setTimeout(r, 10))

    assert.match(notifies.at(-1).message, /could not put those words/)
    assert.ok(typesOf().includes('note_interrupt_failed'))
  })
})

// #252, ADR-0013: an ordinary note that dies gets one line with the count. A
// cross-check verdict that dies gets its whole content — it is the output of a
// whole reviewer session, and nobody can say it again.
describe('an expiring verdict is posted in full, never mourned (#252)', () => {
  const agentAt = (instance) => ({
    repo: 'o/r', ticket: '42', session: 'curia-42', instance,
    wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready', resultReceived: false,
  })

  test('the verdict content reaches the thread when the builder dies unread', async () => {
    const d = makeDispatcher({ hasSession: async () => false })
    d.agents.set('curia-42', agentAt('curia-42@1'))
    d.verdicts.set('42', {
      ticket: '42', agent: 'curia-review-42', model: 'gpt-5',
      verdict: 'VERDICT: fail\n1. the drain path races the exit', pr_url: 'https://github.com/o/r/pull/7',
    })
    agentNotes.set('curia-42', [{
      agent: 'curia-42', text: 'a verdict note', instance: 'curia-42@1', label: 'cross-check verdict',
    }])

    await d.onAgentDone('curia-42')

    const carried = notifies.map((n) => n.message).find((m) => /has no live reader/.test(m))
    assert.ok(carried, 'a whole reviewer session\'s output must not die as a count')
    assert.match(carried, /the drain path races the exit/)
    assert.match(carried, /curia-review-42/)
    assert.match(carried, /pull\/7/)
    assert.ok(typesOf().includes('verdict_carried'))
  })

  test('an ordinary note beside it still gets the count, and only the count', async () => {
    const d = makeDispatcher({ hasSession: async () => false })
    d.agents.set('curia-42', agentAt('curia-42@1'))
    agentNotes.set('curia-42', [
      { agent: 'curia-42', text: 'cancel 42', instance: 'curia-42@1', label: null },
      { agent: 'curia-42', text: 'a verdict note', instance: 'curia-42@1', label: 'cross-check verdict' },
    ])

    await d.onAgentDone('curia-42')

    const line = notifies.map((n) => n.message).find((m) => /operator note/.test(m))
    assert.match(line, /1 operator note it never read/, 'the verdict is not counted as one of them')
    assert.ok(!line.includes('cancel 42'), 'the count, never the words')
  })

  test('with no artifact left, the note text itself is what gets carried', async () => {
    const d = makeDispatcher({ hasSession: async () => false })
    d.agents.set('curia-42', agentAt('curia-42@1'))
    agentNotes.set('curia-42', [{
      agent: 'curia-42', text: 'VERDICT: fail — the only copy left', instance: 'curia-42@1', label: 'cross-check verdict',
    }])

    await d.onAgentDone('curia-42')

    assert.match(notifies.map((n) => n.message).join('\n'), /the only copy left/)
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

  // #218: the reply used to say "in the ticket thread" for every cancel, which
  // was the fault written down. The confirm renders where the command was
  // typed, and the same threadId decides the words, so the two cannot disagree.
  test('the reply names where the buttons actually went', async () => {
    const d = makeDispatcher()
    d.agents.set('curia-42', liveAgent())
    assert.match(await d.requestCancel('42', { threadId: 'thread-9' }), /buttons in this thread/)

    d.agents.set('curia-42', liveAgent('curia-42@2'))
    assert.match(await d.requestCancel('42', {}), /buttons in #curia/,
      'typed outside any thread, the confirm lands in the command channel')
  })

  test('the bulk reply names the place too — one verb, one rule', async () => {
    const d = makeDispatcher({ listSessions: async () => ['curia-42'] })
    assert.match(await d.requestCancelAll({ threadId: 'thread-9' }), /agent\(s\) in this thread/)
    assert.match(await d.requestCancelAll({}), /agent\(s\) in #curia/)
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
      removeWorkspace: async () => acts.push('workspace'),
      unclaim: async (repo, t) => acts.push(`unclaim:${repo}#${t}`),
      removeConfigDir: () => acts.push('cfg'),
    })
    d.agents.set('curia-42', liveAgent())
    await d.requestCancel('42', { threadId: 'thread-9' })

    Object.assign(confirms[0], { status: 'answered', answer: 'approve', answered_by: 'alp' })
    await d.onConfirmAnswered(confirms[0])

    assert.deepEqual(acts, ['kill:curia-42', 'workspace', 'unclaim:o/r#42', 'cfg'])
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
      removeWorkspace: async () => {},
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
  // `holds` is the credential file the dead agent left behind — the whole
  // trigger. `prompt.md` is the rest of the post-mortem, which the sweep keeps.
  function seedCfg(session, holds = '.credentials.json') {
    const dir = path.join(tmp, 'work', 'cfg', session)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, holds), '{}')
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

  // #467: a codex agent holds `auth.json` and no `.credentials.json` at all. In
  // a container that file is a real COPY of the host credential (#158), so the
  // dir the post-mortem keeps holds a live token. On a box still on #155's PAT
  // there is no `gh` dir beside it either, so the trigger saw nothing.
  test('a codex config dir holding only auth.json is swept too', async () => {
    const swept = []
    seedCfg('curia-77', 'auth.json')
    const d = makeDispatcher({
      listSessions: async () => [],
      removeCredentials: (dir) => swept.push(path.basename(dir)),
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(swept, ['curia-77'], 'the codex credential copy outlived its agent')
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
      createPrivateClone: async () => { throw new Error('git exploded') },
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
    const d = makeDispatcher({ createPrivateClone: async () => { throw new Error('git exploded') } })

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

  test('#releaseClaim whose unclaim call fails journals unclaim_failed, never dispatch_unclaimed', async () => {
    // reach #releaseClaim through the respawn-failure path: first spawn OK,
    // usage-limit hit, second spawn throws, and GitHub then refuses the release
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
    const d = makeDispatcher({
      newSession: async () => {
        spawnCalls += 1
        if (spawnCalls > 1) throw new Error('tmux exploded')
      },
      capturePane: async () => 'Sonnet usage limit reached | 1800000000',
      unclaim: async () => { throw new Error('gh: HTTP 503') },
    }, { routing })

    await d.start('42', { repo: 'o/r' })
    await waitFor(() => events.some((e) => e.type === 'unclaim_failed'))

    assert.deepEqual(unclaimed, [], 'a refused unclaim released nothing')
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
      probeTtyd: async () => ({ verified: false }),
      assertServe: async () => { calls.push('serve') },
      serveOff: async ({ servePort }) => { calls.push(`off:${servePort}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(calls, ['off:8443'], 'no publish, and the stale rule is actively withdrawn')
  })

  test('verified:true ⇒ assertServe runs and nothing is withdrawn', async () => {
    const calls = []
    const d = makeDispatcher({
      probeTtyd: async () => ({ verified: true }),
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
      probeTtyd: async () => ({ verified: false }),
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
    // #253: the tracker sentence is carried on the journal event and read back
    // by the ending receipt. Nothing is said in the thread here — report_result
    // and the Stop hook are one ending, and one ending is one message.
    assert.match(events.find((e) => e.type === 'nonclean_noted').summary, /NOT resolved/)
    assert.ok(!notifies.some((n) => /NOT resolved/.test(n.message)), 'the ending speaks once, at the end')
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
    assert.match(events.find((e) => e.type === 'nonclean_noted').summary, /claim release FAILED/)
  })

  test('a note that cannot be posted still releases the claim, and says which half failed', async () => {
    const d = makeDispatcher({
      commentIssue: async () => { throw new Error('gh: HTTP 403') },
    })
    d.agents.set('curia-42', agent())

    await d.onResult('curia-42', { ticket: '42', status: 'aborted', summary: 'cancelled' })

    assert.ok(events.some((e) => e.type === 'nonclean_noted' && e.released === true && e.noted === false))
    assert.match(events.find((e) => e.type === 'nonclean_noted').summary, /the note could not be posted/)
  })
})

// ---- #253, ADR-0013: the ending speaks once --------------------------------
//
// The cold read of 131 threads (docs/research/discord-thread-surprises.md,
// section 3) found every ending narrated by three identities in up to four
// messages inside twenty seconds. Two remain: the agent's report, in the
// agent's voice, and this receipt, in CuriaBot's.
describe('the ending is one CuriaBot message (#253)', () => {
  const agent = () => ({ repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/nope/42', cfgDir: '/c/curia-42', state: 'ready' })

  test('the tracker step is silent; the receipt carries it, once, in small print', async () => {
    const d = makeDispatcher({
      findPullRequest: async () => ({ url: 'https://github.com/o/r/pull/9', state: 'MERGED' }),
    })
    d.agents.set('curia-42', agent())

    await d.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'done' })
    assert.equal(notifies.length, 0, 'report_result says nothing in the thread of its own')

    await d.onAgentDone('curia-42')

    assert.equal(notifies.length, 1, 'one ending, one message')
    const { message } = notifies[0]
    assert.ok(message.split('\n').every((l) => l.startsWith('-# ')), 'the mechanics register is small print')
    assert.match(message, /o\/r#42 resolved/, 'what the tracker step did')
    assert.match(message, /session closed/, 'what the teardown did')
    assert.ok(!/🏁/.test(message), 'the done line is gone with no replacement')
  })

  test('no bare link rides the receipt — the pull request unfurls in the report and nowhere else', async () => {
    const d = makeDispatcher({
      findPullRequest: async () => ({ url: 'https://github.com/o/r/pull/9', state: 'OPEN' }),
      issueComments: async () => [],
    })
    d.agents.set('curia-42', agent())

    await d.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'done' })
    await d.onAgentDone('curia-42')

    const { message } = notifies[0]
    assert.match(message, /pull\/9/, 'the link is still stated')
    assert.ok(!/[^<]https:\/\//.test(message), 'every url is wrapped in <>, so Discord renders no embed')
  })

  test('a blocked result ends in the same one message', async () => {
    const d = makeDispatcher()
    d.agents.set('curia-42', agent())

    await d.onResult('curia-42', { ticket: '42', status: 'blocked', summary: 'need a human' })
    // the wire writes this file before onResult runs; releasing the claim drops
    // the in-memory record, so the file is what makes the exit a clean one
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{"status":"blocked"}')
    await d.onAgentDone('curia-42')

    assert.equal(notifies.length, 1)
    assert.match(notifies[0].message, /NOT resolved.*session closed/s)
  })

  test('the clause survives a restart between report_result and the Stop hook', async () => {
    const first = makeDispatcher()
    first.agents.set('curia-42', agent())
    await first.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'done' })

    // a second Dispatcher over the same data dir: the in-memory record is gone,
    // and only the journal remains
    const second = makeDispatcher()
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{"status":"resolved"}')
    await second.onAgentDone('curia-42')

    assert.match(notifies.at(-1).message, /o\/r#42 resolved/)
  })

  test('a session whose ending touched no tracker still gets a receipt', async () => {
    const d = makeDispatcher()
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{"status":"resolved"}')
    d.agents.set('curia-42', agent())

    await d.onAgentDone('curia-42')

    assert.equal(notifies.length, 1)
    assert.match(notifies[0].message, /finished with a recorded result/)
  })

  // The report is the ONE place the pull-request link is allowed to unfurl, so
  // index.mjs asks the dispatcher for it at report_result.
  describe('the pull request the report carries', () => {
    test('the live record answers first', () => {
      const d = makeDispatcher()
      d.agents.set('curia-42', { ...agent(), prUrl: 'https://github.com/o/r/pull/9' })
      assert.equal(d.pullRequestUrlFor('curia-42'), 'https://github.com/o/r/pull/9')
    })

    test('the journal answers for a session this process never held', () => {
      const d = makeDispatcher()
      d.reduction.journal('pr_opened', { repo: 'o/r', ticket: '42', agent: 'curia-42', url: 'https://github.com/o/r/pull/9' })
      assert.equal(d.pullRequestUrlFor('curia-42'), 'https://github.com/o/r/pull/9')
    })

    test('a fresh dispatch does not inherit the last one\'s pull request', () => {
      const d = makeDispatcher()
      d.reduction.journal('pr_opened', { repo: 'o/r', ticket: '42', agent: 'curia-42', url: 'https://github.com/o/r/pull/9' })
      d.reduction.journal('agent_spawned', { repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'sonnet' })
      assert.equal(d.pullRequestUrlFor('curia-42'), null)
    })
  })

  test('a resume does not inherit the ending of the dispatch before it', async () => {
    const d = makeDispatcher()
    d.agents.set('curia-42', agent())
    await d.onResult('curia-42', { ticket: '42', status: 'resolved', summary: 'done' })
    // the next dispatch of the same ticket, on the same session name
    d.reduction.journal('agent_spawned', { repo: 'o/r', ticket: '42', agent: 'curia-42', model: 'sonnet' })
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{"status":"resolved"}')
    d.agents.set('curia-42', agent())

    await d.onAgentDone('curia-42')

    assert.match(notifies.at(-1).message, /finished with a recorded result/)
    assert.ok(!/resolved —/.test(notifies.at(-1).message), 'the last run\'s sentence stays with the last run')
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
      removeWorkspace: async (wt) => destroyed.push(`workspace:${wt}`),
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
      removeWorkspace: async () => {},
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
      removeWorkspace: async (wt) => destroyed.push(`workspace:${wt}`),
      removeConfigDir: () => {},
      hasUnpushedWork: async () => true,
    })

    await d.reconcile({ boot: false })

    assert.ok(typesOf().includes('orphan_swept'), 'the session is still swept')
    assert.deepEqual(destroyed.filter((x) => x.startsWith('workspace:')), [], 'but the only copy of the work survives')
    assert.ok(events.some((e) => e.type === 'orphan_worktree_kept' && /commits that exist nowhere else/.test(e.reason)))
  })

  test('an indeterminate unpushed-work check keeps the worktree too', async () => {
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', agent: 'curia-42' }])
    const destroyed = []
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed', assignees: [] }),
      killSession: async () => {},
      removeWorkspace: async (wt) => destroyed.push(wt),
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
      removeWorkspace: async (wt) => destroyed.push(`workspace:${wt}`),
      removeConfigDir: (dir) => destroyed.push(`cfg:${path.basename(dir)}`),
      hasUnpushedWork: async () => false,
    })

    await d.reconcile({ boot: false })

    assert.ok(typesOf().includes('orphan_swept'))
    assert.ok(destroyed.some((x) => x.startsWith('workspace:')))
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

// #374: `resume` handed a fresh agent the worktree and the model and none of
// the exchange, so the operator answered the same question twice. The push is
// one argument on the prompt, read out of the reduction the daemon already holds.
// The rule itself is pinned in `inheritedexchange.test.mjs`, and its wording in
// `prompt.test.mjs`; what belongs HERE is that a dispatch actually asks.
describe('a dispatch hands the recorded exchange to the prompt (#374)', () => {
  test('a resumed agent is handed what a human already answered on this ticket', async () => {
    let prompt = null
    const d = makeDispatcher({
      writePrompt: (cfgDir, issue, opts) => { prompt = opts; return '/p' },
    }, { readyTimeoutS: 0 })
    // The dead agent's round, as the journal really carries it. Both events go
    // through the reduction double, which writes them to the real journal.
    d.reduction.journal('esc_open', { id: 'esc-1', agent: 'curia-42', ticket: '42', kind: 'free-text', prompt: 'which lane?' })
    d.reduction.journal('esc_answer', { id: 'esc-1', answer: 'the flat one', by: 'operator', via: 'discord' })

    await d.start('42', { repo: 'o/r', reuse: true })

    assert.deepEqual(prompt.exchange, [
      { id: 'esc-1', kind: 'free-text', prompt: 'which lane?', answer: 'the flat one', attachments: 0 },
    ])
  })

  test('a first dispatch hands over an empty exchange, not a missing one', async () => {
    // Rule 7: one rule for every dispatch. The prompt writes no block for an
    // empty list, so `resume` needs no branch of its own.
    let prompt = null
    const d = makeDispatcher({
      writePrompt: (cfgDir, issue, opts) => { prompt = opts; return '/p' },
    }, { readyTimeoutS: 0 })
    await d.start('42', { repo: 'o/r' })
    assert.deepEqual(prompt.exchange, [])
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
      seedConfigDir: (cfgDir, wtPath, s) => { fs.mkdirSync(cfgDir, { recursive: true }); seeded = s },
    }, { readyTimeoutS: 0, skills })

    await d.start('42', { repo: 'o/r' })
    assert.deepEqual(seeded, skills)
  })

  test('a map child in a repo with no tracker doc is refused, and the claim released', async () => {
    let unclaimed = null
    const d = makeDispatcher({
      fetchIssue: async (repo, n) => (String(n) === '1' ? MAP : { ...MAP_CHILD }),
      // the doc-less repo: a worktree with no docs/agents/issue-tracker.md
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
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
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
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

  // #238: `alp82/aistack` had only sandboxed dispatches, so `repos/…/base` never
  // existed — and the landing path died on `defaultBranchOf(basePath)` with the
  // agent's commits stranded in its clone. The default branch comes from the
  // WORKSPACE, which exists for every agent that can call this tool at all.
  test('landing reads the default branch from the workspace — a sandboxed repo has no base clone (#238)', async () => {
    const seen = []
    const d = makeDispatcher({
      defaultBranchOf: async (p) => { seen.push(p); return 'main' },
      commitsOnBranch: async () => [{ sha: 'abc1234', subject: 'do it' }],
      createPullRequest: async () => 'https://github.com/o/r/pull/7',
    })
    const w = liveAgent(d)
    assert.ok(!fs.existsSync(path.join(tmp, 'work', 'repos', 'o__r', 'base')), 'the shape under test: no base clone on disk')

    const reply = await d.openPullRequest('curia-42', { summary: 's' })

    assert.match(reply, /opened https/)
    assert.deepEqual(seen, [w.wtPath])
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

  // #256, the #81 case: the agent retried three times, and each retry pasted the
  // same two lines of git stderr into the thread. The thread hears the failure
  // once, in prose. The raw error is not lost — it is journalled every time, and
  // the reply hands it whole to the agent that has to act on it.
  test('a retried failure posts one prose line, and the raw error stays in the journal (#256)', async () => {
    const raw = "Command failed: git -C /home/alp/work/wt/42 push https://github.com/o/r.git abc:refs/heads/curia/42\n"
      + "fatal: cannot change to '/home/alp/work/wt/42': No such file or directory"
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'a', subject: 's' }],
      pushBranch: async () => { throw new Error(raw) },
    })
    liveAgent(d)

    const replies = []
    for (let i = 0; i < 3; i++) replies.push(await d.openPullRequest('curia-42', { summary: 's' }))

    const failures = notifies.filter((n) => /opening the pull request FAILED/.test(n.message))
    assert.equal(failures.length, 1, 'the thread heard the same failure more than once')
    assert.match(failures[0].message, /opening the pull request FAILED — the checkout on the box is gone$/)
    assert.ok(!/fatal:|\/home\/alp/.test(failures[0].message), 'stderr reached the thread')

    const journalled = events.filter((e) => e.type === 'land_failed')
    assert.equal(journalled.length, 3, 'every occurrence is in the record')
    for (const e of journalled) assert.equal(e.error, raw)
    for (const r of replies) assert.match(r, /fatal: cannot change to/, 'the agent needs the raw error to fix it')
  })

  test('a second, different failure on the same act still speaks (#256)', async () => {
    let boom = 'fatal: Authentication failed'
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'a', subject: 's' }],
      pushBranch: async () => { throw new Error(boom) },
    })
    liveAgent(d)

    await d.openPullRequest('curia-42', { summary: 's' })
    boom = 'fatal: Could not resolve host: github.com'
    await d.openPullRequest('curia-42', { summary: 's' })

    const said = notifies.filter((n) => /opening the pull request FAILED/.test(n.message)).map((n) => n.message)
    assert.equal(said.length, 2)
    assert.match(said[0], /GitHub refused the daemon login/)
    assert.match(said[1], /the box could not reach GitHub/)
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

  // ---- the press is a real GitHub approval (#391, ADR-0018) -------------------
  //
  // `main` is protected now, so the merge the agent owns needs an approving
  // review on the pull request. The press is what posts it, and everything here
  // pins the one rule that makes the gate honest: what is journalled as approved
  // is what GitHub actually carries.

  const OPEN_PR = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }

  test('the press posts one approving review on the pull request the gate showed', async () => {
    const approvals = []
    const d = makeDispatcher({
      findPullRequest: async () => ({ ...OPEN_PR }),
      approvePullRequest: async (repo, n) => { approvals.push({ repo, n }) },
    }, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d)

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.deepEqual(approvals, [{ repo: 'o/r', n: 7 }])
    assert.equal(r.approved, true)
    assert.match(r.text, /APPROVED by the human/)
    assert.ok(events.some((e) => e.type === 'pr_approved' && e.pr === 'https://github.com/o/r/pull/7'))
    assert.ok(events.some((e) => e.type === 'review_answered' && e.approved === true))
  })

  // The gate stays open for hours, so the pull request is read again at the
  // press. The state that decides is the state the operator answered on.
  test('the pull request is re-read at the press, not taken from the open', async () => {
    const seen = []
    let reads = 0
    const d = makeDispatcher({
      findPullRequest: async () => {
        reads += 1
        return reads === 1 ? { ...OPEN_PR } : { number: 9, url: 'https://github.com/o/r/pull/9', state: 'OPEN' }
      },
      approvePullRequest: async (repo, n) => { seen.push(n) },
    }, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d)

    await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.deepEqual(seen, [9])
  })

  // The failure this ticket exists to contain. A press whose approval never
  // reached GitHub must not send the agent at a merge a protected branch
  // refuses, and must not read as approved to anything that asks later.
  test('an approval curia could not post does NOT read as approved', async () => {
    const d = makeDispatcher({
      findPullRequest: async () => ({ ...OPEN_PR }),
      approvePullRequest: async () => { throw new Error('HTTP 401: Bad credentials') },
    }, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d)

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(r.approved, false, 'the agent must not read this as an approval')
    assert.equal(r.approvalFailed, true)
    assert.match(r.text, /could NOT post the GitHub approval/)
    assert.match(r.text, /HTTP 401: Bad credentials/)
    assert.match(r.text, /Do not merge and do not resolve/)
    assert.match(r.text, /no commit of yours fixes it/)

    const answered = events.find((e) => e.type === 'review_answered')
    assert.equal(answered.approved, false, 'the Stop hook reads this, and it must not let the ticket resolve')
    assert.equal(answered.outcome, 'approval-failed')
    assert.equal(answered.pressed, 'approve', 'the operator pressed approve, and the record must keep that')
    assert.ok(events.some((e) => e.type === 'pr_approval_failed'))
    assert.ok(notifies.some((n) => /could not post the GitHub approval/.test(n.message)))
  })

  // A pull request curia cannot name is indeterminate, and an indeterminate
  // approval is a failed one: nobody can tell whether the review is there.
  test('a pull-request read that fails is a failed approval, not a silent skip', async () => {
    const d = makeDispatcher({
      findPullRequest: async () => { throw new Error('could not resolve host: github.com') },
    }, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d, { prUrl: 'https://github.com/o/r/pull/7' })

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(r.approved, false)
    assert.match(r.text, /could not read the pull request/)
    assert.ok(events.some((e) => e.type === 'pr_approval_failed'))
  })

  // Two honest skips. Neither is a failure, because neither leaves a merge
  // waiting on a review that is not there.
  test('a ticket with no pull request approves nothing and still approves', async () => {
    let called = false
    const d = makeDispatcher({
      findPullRequest: async () => null,
      approvePullRequest: async () => { called = true },
    }, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d)

    const r = await d.requestReview('curia-42', { summary: 'a grilling answer', charting: 'none' })

    assert.equal(called, false)
    assert.equal(r.approved, true)
    assert.ok(events.some((e) => e.type === 'pr_approval_skipped' && e.reason === 'no pull request'))
  })

  test('a merged pull request is skipped — the #369 replay of an approval already given', async () => {
    let called = false
    const d = makeDispatcher({
      findPullRequest: async () => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED' }),
      approvePullRequest: async () => { called = true },
    }, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d)

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(called, false)
    assert.equal(r.approved, true)
    assert.ok(events.some((e) => e.type === 'pr_approval_skipped' && /MERGED/.test(e.reason)))
  })

  // A box with no app for this owner: #390's fallback opens the pull request on
  // the host login, so the press and the pull request are one account. That box
  // keeps exactly the gate it had before this ticket, and the operator hears why
  // once. ADR-0018: no credential comes out ahead of its replacement.
  test('a self-approval is a skip, and the ending is untouched', async () => {
    const d = makeDispatcher({
      findPullRequest: async () => ({ ...OPEN_PR }),
      approvePullRequest: async () => {
        throw new Error('GraphQL: Can not approve your own pull request (addPullRequestReview)')
      },
    }, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d)

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(r.approved, true, 'the ending must not break on a box with no app')
    assert.match(r.text, /APPROVED by the human/)
    assert.ok(events.some((e) => e.type === 'pr_approval_skipped' && e.reason === 'self-approval'))
    assert.ok(!events.some((e) => e.type === 'pr_approval_failed'))
    assert.ok(events.some((e) => e.type === 'review_answered' && e.approved === true))
    assert.ok(notifies.some((n) => /refused the approval as a self-approval/.test(n.message)))
  })

  // The rejection path is untouched: nothing is submitted on ❌.
  test('a rejection submits nothing', async () => {
    let called = false
    const d = makeDispatcher({
      findPullRequest: async () => ({ ...OPEN_PR }),
      approvePullRequest: async () => { called = true },
    }, { askReview: async () => ({ text: 'rename the flag', status: 'answered' }) })
    liveAgent(d)

    await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.equal(called, false)
  })

  // The third button answers neither way, so it posts nothing either (#165).
  test('a cross-check press submits nothing', async () => {
    let called = false
    const d = makeDispatcher({
      findPullRequest: async () => ({ ...OPEN_PR }),
      approvePullRequest: async () => { called = true },
    }, { askReview: async () => ({ text: 'cross-check', status: 'answered' }) })
    liveAgent(d)

    await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.equal(called, false)
  })

  test('a cancelled gate submits nothing', async () => {
    let called = false
    const d = makeDispatcher({
      findPullRequest: async () => ({ ...OPEN_PR }),
      approvePullRequest: async () => { called = true },
    }, { askReview: async () => ({ text: 'aborted: a human cancelled this escalation', status: 'cancelled' }) })
    liveAgent(d)

    await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.equal(called, false)
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

  // #369: the gate handed back an answer the operator had already given, so no
  // second card opened. The agent has to be told, and the answer has to keep
  // its meaning — the line rides in front of the ORDER, never in front of the
  // word `approve`, which is classified by a narrow set.
  test('a recorded approval says so, and still orders the merge', async () => {
    const d = makeDispatcher({}, {
      askReview: async () => ({ text: 'approve', status: 'answered', recorded: '[recorded answer — a human answered this exact question by alp at T, on esc-12, while no call of yours was live.]' }),
    })
    liveAgent(d)
    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(r.approved, true)
    assert.match(r.text, /recorded answer .* on esc-12/)
    assert.match(r.text, /APPROVED by the human/)
    assert.match(r.text, /gh pr merge/)
    assert.ok(events.some((e) => e.type === 'review_answered' && e.approved === true && e.recorded === true))
  })

  test('a recorded rejection carries the same line in front of the human words', async () => {
    const d = makeDispatcher({}, {
      askReview: async () => ({ text: 'rename the flag', status: 'answered', recorded: '[recorded answer — on esc-12]' }),
    })
    liveAgent(d)
    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(r.approved, false)
    assert.match(r.text, /recorded answer/)
    assert.match(r.text, /NOT approved/)
    assert.match(r.text, /rename the flag/)
  })

  test('an ordinary gate carries no such line', async () => {
    const d = makeDispatcher({}, { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    liveAgent(d)
    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })
    assert.doesNotMatch(r.text, /recorded answer/)
    assert.ok(events.some((e) => e.type === 'review_answered' && e.recorded === undefined))
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

// The diff digest at the gate (#355, building #343).
//
// The COUNT itself is diffdigest.test.mjs's, against real git. What is pinned
// here is the WIRING: that the gate counts once, in the agent's own worktree,
// at the instant it opens; that the numbers reach the Discord card, the journal
// event and the escalation record together, so no second reader ever re-counts;
// and that a worktree already gone is null with a reason rather than an empty
// change.
describe('the diff digest at the gate (#355)', () => {
  const DIGEST = {
    uncommitted: false, files: 14, added: 812, deleted: 233, capped: false,
    rank_rule: 'source first, then tests, then docs, generated and lock files last — largest first inside each class',
    list: [
      { path: 'daemon/src/dashboard.mjs', added: 120, deleted: 4, status: 'M', binary: false, untracked: false, hunks: 9, from: null },
      { path: 'daemon/test/x.test.mjs', added: 40, deleted: 0, status: 'A', binary: false, untracked: false, hunks: 1, from: null },
    ],
  }
  const counting = (out, seen = []) => ({
    readDiffDigest: async (wtPath, opts) => { seen.push({ wtPath, opts }); return out },
  })

  test('the count happens once, in the agent\'s own worktree, when the gate opens', async () => {
    const seen = []
    const d = makeDispatcher(counting({ digest: DIGEST, error: null }, seen),
      { askReview: async () => ({ text: 'approve', status: 'answered' }) })
    const w = liveAgent(d)

    await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(seen.length, 1, 'the gate counted more than once')
    assert.equal(seen[0].wtPath, w.wtPath, 'the count must read the agent\'s own worktree')
  })

  test('the Discord card gains one line under the links, and never the hunks', async () => {
    let asked = null
    const d = makeDispatcher(counting({ digest: DIGEST, error: null }),
      { askReview: async (a, t, text) => { asked = text; return { text: 'approve', status: 'answered' } } })
    liveAgent(d)

    await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.match(asked, /14 files · \+812 −233 · biggest: daemon\/src\/dashboard\.mjs \+120 −4/)
    assert.ok(asked.indexOf('14 files') > asked.indexOf('**Look at**'), 'the line belongs under the links')
    assert.ok(!/^@@|^\+\+\+ |^--- /m.test(asked), 'a hunk reached a phone-sized message')
  })

  test('the digest lands on the journal event AND on the escalation record', async () => {
    let opened = null
    const d = makeDispatcher(counting({ digest: DIGEST, error: null }), {
      askReview: async (a, t, text, opts) => { opened = opts; return { text: 'approve', status: 'answered' } },
    })
    liveAgent(d)

    await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    const ev = events.find((e) => e.type === 'review_requested')
    assert.equal(ev.diff.files, 14)
    assert.equal(ev.diff.added, 812)
    assert.equal(ev.diff.list.length, 2)
    assert.equal(ev.diff_error, null)
    // The record is what `GET /overview` reads, so the console and Discord
    // state one measurement rather than two.
    assert.equal(opened.diff.files, 14)
    assert.equal(opened.diffError, null)
  })

  // NULL, NEVER EMPTY. An orphan gate — one whose agent died and whose
  // workspace was swept — must say curia could not count this, because "no
  // files changed" is a different fact and a dangerous one at a merge gate.
  test('a worktree that is gone makes the digest null with its reason, on the card and on the record', async () => {
    let asked = null
    const d = makeDispatcher(counting({ digest: null, error: 'the agent worktree is gone' }), {
      askReview: async (a, t, text) => { asked = text; return { text: 'approve', status: 'answered' } },
    })
    liveAgent(d)

    await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.match(asked, /curia could not count this diff — the agent worktree is gone/)
    const ev = events.find((e) => e.type === 'review_requested')
    assert.equal(ev.diff, null)
    assert.equal(ev.diff_error, 'the agent worktree is gone')
  })

  test('a count that throws does not cost the gate — the card opens and says so', async () => {
    let asked = null
    const d = makeDispatcher({
      readDiffDigest: async () => ({ digest: null, error: 'fatal: not a git repository' }),
    }, { askReview: async (a, t, text) => { asked = text; return { text: 'approve', status: 'answered' } } })
    liveAgent(d)

    const r = await d.requestReview('curia-42', { summary: 's', charting: 'none' })

    assert.equal(r.approved, true, 'an uncountable diff must never hold the gate shut')
    assert.match(asked, /could not count this diff/)
  })
})

// The hunks, on demand (#355). The browser names an escalation id or an agent,
// and these are what resolve that name to a worktree — the #266 seam.
describe('the hunks the console asks for (#355)', () => {
  const FILE = { path: 'src/app.mjs', added: 2, deleted: 0, status: 'M', binary: false, untracked: false, hunks: 1, from: null }

  test('the live agent row reads committed and uncommitted work together', async () => {
    const seen = []
    const d = makeDispatcher({
      readDiffDigest: async (wtPath, opts) => { seen.push(opts); return { digest: { files: 1, list: [FILE] }, error: null } },
    })
    liveAgent(d)

    const out = await d.agentDiff('curia-42')

    assert.equal(out.digest.files, 1)
    assert.equal(seen[0].uncommitted, true)
  })

  test('the hunks come from the worktree while it is there', async () => {
    const d = makeDispatcher({
      readFileHunks: async () => ({ text: 'diff --git a/src/app.mjs b/src/app.mjs', lines_shown: 1, lines_total: 1, truncated: false, error: null }),
    })
    liveAgent(d)

    const out = await d.agentHunks('curia-42', FILE)

    assert.equal(out.source, 'worktree')
    assert.equal(out.path, 'src/app.mjs')
    assert.match(out.text, /^diff --git/)
  })

  // A gate outlives its agent. When the workspace is swept the pull request is
  // the only copy left, and the card says which source it is reading.
  test('a worktree that is gone falls back to the pull request, and says so', async () => {
    const patch = ['diff --git a/src/app.mjs b/src/app.mjs', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')
    const d = makeDispatcher({ pullRequestDiff: async () => patch })
    const w = liveAgent(d)
    w.prUrl = 'https://github.com/o/r/pull/7'
    fs.rmSync(w.wtPath, { recursive: true, force: true })

    const out = await d.agentHunks('curia-42', FILE)

    assert.equal(out.source, 'pull-request')
    assert.match(out.text, /^\+y$/m)
    assert.equal(out.error, null)
  })

  test('no worktree and no pull request says there is nowhere left to read it from', async () => {
    const d = makeDispatcher()
    const w = liveAgent(d)
    fs.rmSync(w.wtPath, { recursive: true, force: true })

    const out = await d.agentHunks('curia-42', FILE)

    assert.equal(out.text, null)
    assert.match(out.error, /nowhere left to read this diff from/)
    assert.ok(!out.error.includes(w.wtPath), 'a daemon path reached the console')
  })
})

describe('the Stop hook enforces the ending (#54 item 4)', () => {
  // The lint gate's catch (#418, ADR-0005 as #438 amended it). On codex a
  // rejection is the `exec` script's return value and it never throws, so an
  // agent can believe its question went out and come here to end its turn. The
  // hook is the one lever it cannot discard.
  const rejected = (over = {}) => ({
    agent: 'curia-42', kind: 'free-text', count: 1, stop_blocks: 0,
    faults: ['headline: a semicolon. Write two sentences.'],
    prompt: '**a card**', payload: { headline: 'a card' }, ...over,
  })

  test('a rejection the agent never read holds the stop and hands the faults back', async () => {
    const held = rejected()
    const d = makeDispatcher({ lintRejection: () => held })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})

    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /curia REFUSED your last `ask_human` call/)
    assert.match(decision.reason, /headline: a semicolon/)
    assert.match(decision.reason, /Keep every option and every constraint/)
    assert.ok(events.some((e) => e.type === 'lint_stop_blocked'))
  })

  test('#47 still wins: an agent blocked on a human is not held for its rejection', async () => {
    const d = makeDispatcher({ hasSession: async () => true, lintRejection: () => rejected() })
    liveAgent(d)
    escalations.push({ id: 'esc-1', agent: 'curia-42', ticket: '42', kind: 'choice', status: 'open' })

    assert.deepEqual(await d.onStopHook('curia-42', {}), { allow: true, terminal: false })
    assert.ok(!typesOf().includes('lint_stop_blocked'), 'a parked agent is not spinning on anything')
  })

  test('at the SECOND block curia sends the text itself, flagged, and lets the agent stop', async () => {
    const sent = []
    const d = makeDispatcher({
      lintRejection: () => rejected({ stop_blocks: 1, count: 2 }),
      sendFlagged: (agent, h) => { sent.push({ agent, h }); return { id: 'esc-9' } },
    })
    liveAgent(d)

    assert.deepEqual(await d.onStopHook('curia-42', {}), { allow: true, terminal: false })
    assert.equal(sent.length, 1, 'the question reaches the operator on a path the model cannot lose')
    assert.equal(sent[0].h.prompt, '**a card**')
    assert.ok(events.some((e) => e.type === 'lint_flagged_send' && e.id === 'esc-9'))
    assert.ok(notifies.some((n) => /sent the text as it stands/.test(n.message)), 'the thread says the send happened')
  })

  test('a rejected GATE falls through to the ending, which already nudges for one', async () => {
    // The review gate is a step of the ending. Sending a half-composed gate
    // would put a card with no links in front of the operator.
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const sent = []
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'a', subject: 's' }],
      lintRejection: () => rejected({ kind: 'review-gate', stop_blocks: 1 }),
      sendFlagged: (agent, h) => { sent.push(h); return { id: 'esc-9' } },
    })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})

    assert.equal(sent.length, 0, 'no gate is composed by the hook')
    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /request_review/, 'the ordinary checklist asks for the gate instead')
  })

  test('the reviewer is nameable without writing a refusal line (#419)', () => {
    // The report lint asks which SHAPE a call carries. `toolRefusal` answers the
    // same question and journals a refusal, which is the wrong record for it.
    const d = makeDispatcher({})
    assert.equal(d.isReviewerSession('curia-review-42'), true)
    assert.equal(d.isReviewerSession('curia-42'), false)
    assert.ok(!typesOf().includes('reviewer_tool_refused'))
  })

  test('a rejected REPORT falls through the same way, and opens no card (#419)', async () => {
    // `sendFlagged` opens an escalation, and a report asks nobody anything. The
    // ending checklist already holds an agent that has not reported.
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const sent = []
    const d = makeDispatcher({
      lintRejection: () => rejected({ kind: 'report-result', stop_blocks: 1 }),
      sendFlagged: (agent, h) => { sent.push(h); return { id: 'esc-9' } },
    })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})

    assert.equal(sent.length, 0, 'a report is never sent as a question')
    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /report_result/, 'the ordinary checklist asks for the report instead')
  })

  test('the first block on a rejected report names report_result and says nothing reported (#419)', async () => {
    const d = makeDispatcher({ lintRejection: () => rejected({ kind: 'report-result' }) })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})

    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /curia REFUSED your last `report_result` call/)
    assert.match(decision.reason, /This ticket has reported nothing/)
  })

  test('a rejected STATUS LINE is posted, and it never holds the turn (#420)', async () => {
    // Nothing waits on a status line, so the block a question earns would cost
    // the agent a turn to deliver a line the operator did not ask for.
    journalTo([{ type: 'dispatch_claimed', ticket: '42', repo: 'o/r', agent: 'curia-42' }])
    const posted = []
    const d = makeDispatcher({
      commitsOnBranch: async () => [{ sha: 'a', subject: 's' }],
      lintRejection: () => rejected({ kind: 'notify', payload: { message: 'the tests pass' } }),
      sendFlaggedNotify: (agent, h) => { posted.push({ agent, h }); return true },
      sendFlagged: () => { throw new Error('a status line is never staged as a card') },
    })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})

    assert.equal(posted.length, 1, 'the words the agent lost still reach the thread')
    assert.equal(posted[0].h.payload.message, 'the tests pass')
    assert.ok(events.some((e) => e.type === 'lint_flagged_send' && e.kind === 'notify'))
    assert.ok(!typesOf().includes('lint_stop_blocked'), 'no turn is spent on a line nobody waits for')
    assert.equal(decision.decision, 'block', 'the ordinary ending checklist still runs')
    assert.match(decision.reason, /request_review/)
  })

  test('a cleared status line does not hide the question behind it (#420)', async () => {
    // The ledger holds one entry per kind and the hook reads the newest. Before
    // the loop, a status line refused after a question ended the turn with the
    // question still unsent.
    const held = [
      rejected({ kind: 'notify', payload: { message: 'the tests pass' } }),
      rejected({ kind: 'free-text' }),
    ]
    const d = makeDispatcher({
      lintRejection: () => held[0] ?? null,
      sendFlaggedNotify: () => { held.shift(); return true },
    })
    liveAgent(d)

    const decision = await d.onStopHook('curia-42', {})

    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /curia REFUSED your last `ask_human` call/)
  })

  test('a dep that clears nothing does not spin the hook (#420)', async () => {
    const posted = []
    const d = makeDispatcher({
      lintRejection: () => rejected({ kind: 'notify', payload: { message: 'a line' } }),
      sendFlaggedNotify: () => { posted.push(1); return true },
    })
    liveAgent(d)

    await d.onStopHook('curia-42', {})

    assert.equal(posted.length, 1, 'one pass per kind, whatever the ledger keeps saying')
  })

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
      removeWorkspace: async (wt) => { done.push(`rm:${path.basename(wt)}`) },
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
      removeWorkspace: async () => { removed = true },
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
      removeWorkspace: async () => { removed = true },
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
      removeWorkspace: async () => { removed = true },
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
      removeWorkspace: async () => { removed = true },
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
    // open + assigned + no live session + no result is ALSO the shape of an
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
      seedConfigDir: (cfg, wt, s, harness) => { fs.mkdirSync(cfg, { recursive: true }); seeded.push(harness) },
      writeConnectionSettings: (opts) => harnessed.push(opts.harness),
      newSession: async (opts) => { spawn = opts },
    }, { routing: TWO_LANE })

    await d.start('42', { repo: 'o/r', by: 'test' })
    assert.deepEqual(seeded, ['codex'])
    assert.deepEqual(harnessed, ['codex'])
    // the CLI model id, not the routing name
    assert.match(spawn.shellCmd, /codex --model gpt-5\.5/)
    // #195: the pane carries NO environment at all — the container's env file
    // carries CODEX_HOME, and a pane env would show every value in `ps`
    assert.deepEqual(spawn.env, {})
    assert.match(fs.readFileSync(path.join(tmp, 'work', 'cfg', 'curia-42', ENV_FILE), 'utf8'), /^CODEX_HOME=/m)
  })

  // The bug this ordering fixes: `harness` used to be read off the REQUESTED
  // model. With one harness that was invisible; with two it would seed a claude
  // config dir and then spawn codex into it.
  test('the harness follows the model actually spawned, not the one asked for', async () => {
    const seeded = []
    let spawn = null
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [] }),
      seedConfigDir: (cfg, wt, s, harness) => { fs.mkdirSync(cfg, { recursive: true }); seeded.push(harness) },
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
      seedConfigDir: (cfg, wt, s, harness) => { fs.mkdirSync(cfg, { recursive: true }); seeded.push(harness) },
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
    // #195: the pane carries no environment either time — the claude
    // variables are in the container env file the respawn rewrote
    assert.deepEqual(spawns[1].env, {})
    const envFile = fs.readFileSync(path.join(tmp, 'work', 'cfg', 'curia-42', ENV_FILE), 'utf8')
    assert.match(envFile, /^CLAUDE_CONFIG_DIR=/m)
    assert.match(envFile, /^CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=/m)
    assert.equal(/^CLAUDE_SECURESTORAGE_CONFIG_DIR=/m.test(envFile), false, 'the container denies the host HOME')
    // and the watchdog that follows must read the NEW harness's marker
    assert.ok(events.some((e) => e.type === 'agent_spawned' && e.harness === 'claude'))
  })

  // #173: the wayfinder invocation is spelled per harness — `/wayfinder` on
  // claude, `$wayfinder` on codex — so the prompt is no longer harness-blind.
  // A cap hit hands the ticket to the OTHER provider, which is the other
  // harness, and both harnesses run containers, so that hand-off moves no view
  // at all. The harness is the whole signal that the prompt must be written
  // again; without it the claude agent would inherit the codex spelling.
  test('a cap hit that changes harness writes the prompt again, for the new one', async () => {
    const written = []
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      writePrompt: (cfgDir, issue, opts) => { written.push(opts.harness); return path.join(cfgDir, 'prompt.md') },
      capturePane: async () => "You've hit your usage limit. Upgrade to Plus to continue using Codex\n",
    }, { routing: TWO_LANE, readyTimeoutS: 6 })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await new Promise((r) => setTimeout(r, 2600))

    assert.deepEqual(written, ['codex', 'claude'])
  })

  // The other half of the same guard: a respawn that stays on the harness and
  // in the view keeps the prompt it has. Rewriting it would cost an issue read
  // per mute, and #157's ports would have to be re-stated for nothing.
  test('a same-harness respawn keeps its prompt', async () => {
    const written = []
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:research' }] }),
      writePrompt: (cfgDir, issue, opts) => { written.push(opts.harness); return path.join(cfgDir, 'prompt.md') },
      capturePane: async () => '  gpt-5.5 low · ~/curia-work/repos/o__r/wt/42\n',
    }, { routing: { ...TWO_LANE, harnesses: { ...TWO_LANE.harnesses, codex: { ...TWO_LANE.harnesses.codex, toolChannelGraceS: 2 } } }, readyTimeoutS: 6 })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => events.filter((e) => e.type === 'agent_spawned').length === 2, 12_000)

    assert.deepEqual(written, ['codex'], 'the mute respawn re-used the prompt on disk')
    d.agents.delete('curia-42')
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
        fs.mkdirSync(cfgDir, { recursive: true })
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
        fs.mkdirSync(cfgDir, { recursive: true })
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
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
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
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
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

  // #224: a repo skill under a name curia installs is the same family as a
  // planted config file — the model would read the repo's copy in place of, or
  // beside, the one curia seeded.
  test('a repo skill under an installed name refuses the dispatch and releases the claim', async () => {
    let unclaimed = false
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [] }),
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
        fs.mkdirSync(path.join(wt, '.claude', 'skills', 'wayfinder'), { recursive: true })
        fs.writeFileSync(path.join(wt, '.claude', 'skills', 'wayfinder', 'SKILL.md'), '---\nname: wayfinder\n---\nplanted\n')
        return wt
      },
      unclaim: async () => { unclaimed = true },
      newSession: async () => { throw new Error('must never spawn') },
    }, { routing: TWO_LANE, skills: { root: '/host/skills', install: ['wayfinder'] } })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /repo-carried skill named `wayfinder`/)
    assert.equal(unclaimed, true)
  })

  test('a repo skill under a name curia does not install dispatches fine', async () => {
    let spawned = false
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [] }),
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
        fs.mkdirSync(path.join(wt, '.claude', 'skills', 'deploy-docs'), { recursive: true })
        fs.writeFileSync(path.join(wt, '.claude', 'skills', 'deploy-docs', 'SKILL.md'), '---\nname: deploy-docs\n---\nrepo skill\n')
        return wt
      },
      newSession: async () => { spawned = true },
    }, { routing: TWO_LANE, skills: { root: '/host/skills', install: ['wayfinder'] } })

    await d.start('42', { repo: 'o/r', by: 'test' })
    assert.equal(spawned, true)
  })

  test('the same repo dispatches fine on the claude harness, which never loads .codex/', async () => {
    let spawned = false
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [] }),
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
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

  // #174. The test above is the hole: that dispatch is clean BECAUSE the claude
  // harness does not read `.codex/`, and the fallback chain hands the same
  // worktree to codex, which does — under `--dangerously-bypass-hook-trust`.
  test('a cap hit refuses the fallback onto the harness the repo carries a config file for', async () => {
    const seeded = []
    const spawns = []
    const unclaimed = []
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [] }),
      createPrivateClone: async (r, repo, n) => {
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
        fs.mkdirSync(path.join(wt, '.codex'), { recursive: true })
        fs.writeFileSync(path.join(wt, '.codex', 'hooks.json'), '{"hooks":{"SessionStart":[]}}')
        return wt
      },
      seedConfigDir: (cfg, wt, s, harness) => { fs.mkdirSync(cfg, { recursive: true }); seeded.push(harness) },
      newSession: async (o) => { spawns.push(o) },
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
      capturePane: async () => 'Sonnet usage limit reached | 1800000000',
    }, { routing: TWO_LANE, readyTimeoutS: 6 })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => unclaimed.length > 0, 12_000)

    assert.equal(spawns.length, 1, 'codex never spawned over the planted file')
    assert.deepEqual(seeded, ['claude'], 'refused BEFORE the config dir was re-seeded for codex')
    assert.deepEqual(unclaimed, ['o/r#42'], 'the claim is released, exactly once')
    assert.ok(events.some((e) => e.type === 'dispatch_unclaimed' && /config file curia did not write/.test(e.reason)))
    assert.equal(d.agents.has('curia-42'), false, 'the agent record is dropped')
    const msg = notifies.find((n) => /hooks\.json/.test(n.message))?.message
    assert.ok(msg, 'the operator is told which file refused the fallback')
    assert.match(msg, /once a harness that does not load it is warm/, 'the way out fits the fallback, not the dispatch')
    // #217: curia would not, rather than curia could not. "failed" sends the
    // operator looking for a fault that is not there.
    assert.match(msg, /REFUSED to respawn it on \*\*gpt\*\*/)
    assert.ok(!/failed/i.test(msg), 'a refusal is not a failure')
    assert.match(msg, /^🚫/, 'the refusal icon, the same one the twice-mute refusal uses')
    assert.match(msg, /claim released, ticket re-frontiered/, 'the claim tail is shared with the failure shape')
    // The lane still cooled: the refusal is about the NEXT harness, not the cap.
    assert.ok(events.some((e) => e.type === 'model_cooling' || e.type === 'provider_cooling'))
  })

  // The check is unconditional on the respawn path, so it also covers a file
  // that appeared AFTER the dispatch check passed — the agent writes in this
  // worktree, and the mute respawn re-seeds the same harness over it.
  test('a same-harness mute respawn refuses a file planted after the dispatch check', async () => {
    const spawns = []
    const unclaimed = []
    const d = makeDispatcher({
      newSession: async (o) => {
        spawns.push(o)
        fs.mkdirSync(path.join(o.cwd, '.claude'), { recursive: true })
        fs.writeFileSync(path.join(o.cwd, '.claude', 'settings.local.json'), '{"hooks":{"SessionStart":[]}}')
      },
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
      capturePane: async () => '⏵⏵ bypass permissions on',
    }, { routing: withGrace(2) })

    await d.start('42', { repo: 'o/r', by: 'test' })
    await waitFor(() => unclaimed.length > 0, 12_000)

    assert.equal(spawns.length, 1, 'the respawn never reached tmux')
    assert.ok(events.some((e) => e.type === 'agent_mute'))
    assert.ok(events.some((e) => e.type === 'dispatch_unclaimed' && /settings\.local\.json/.test(e.reason)))
    assert.equal(d.agents.has('curia-42'), false)
    // #217: the mute lane carries the refusal too, and frames it the same way
    // the cap lane does — one shape for one fact, on both call sites.
    const msg = notifies.find((n) => /settings\.local\.json/.test(n.message))?.message
    assert.ok(msg, 'the operator is told which file refused the respawn')
    assert.match(msg, /had no curia tools and curia REFUSED to respawn it on \*\*sonnet\*\*/)
    assert.ok(!/failed/i.test(msg), 'a refusal is not a failure')
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
    fs.mkdirSync(path.join(surviving, '.git'), { recursive: true })
    fs.writeFileSync(path.join(surviving, 'leftover.txt'), 'uncommitted work')
    const d = makeDispatcher({
      createPrivateClone: async () => { throw new Error('resume must not recreate the worktree') },
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
      fs.mkdirSync(path.join(tmp, 'work', 'repos', 'o__r', 'wt', n, '.git'), { recursive: true })
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

  // #177: resume re-routed from the labels, so a ticket that ran on gpt came
  // back on opus — the worktree was inherited and the lane was not. The journal
  // held the answer all along: `agent_spawned` states the model of each spawn.
  //
  // TWO_LANE is what makes these readable: `sonnet` is the untyped default on
  // the claude harness and `gpt` is on codex, so the model and the harness both
  // move, or neither does.
  describe('resume inherits the model (#177)', () => {
    const journalSpawn = (fields) => fs.appendFileSync(
      path.join(tmp, 'data', 'events.jsonl'),
      JSON.stringify({ type: 'agent_spawned', repo: 'o/r', ticket: '42', agent: 'curia-42', ...fields }) + '\n',
    )

    test('a resumed ticket comes back on the model the dead agent ran on, and on its harness', async () => {
      journalSpawn({ model: 'gpt', harness: 'codex' })
      const d = makeDispatcher({}, { routing: TWO_LANE })
      await d.resume('42', { repo: 'o/r', by: 'test' })
      const agent = d.agents.get('curia-42')
      assert.equal(agent.model, 'gpt')
      assert.equal(agent.harness, 'codex')
    })

    test('the LAST spawn wins — a respawn down the fallback chain is what actually ran', async () => {
      journalSpawn({ model: 'sonnet', harness: 'claude' })
      journalSpawn({ model: 'gpt', harness: 'codex' })
      const d = makeDispatcher({}, { routing: TWO_LANE })
      await d.resume('42', { repo: 'o/r', by: 'test' })
      assert.equal(d.agents.get('curia-42').model, 'gpt')
    })

    test('a typed model beats the inheritance', async () => {
      journalSpawn({ model: 'gpt', harness: 'codex' })
      const d = makeDispatcher({}, { routing: TWO_LANE })
      await d.resume('42', { repo: 'o/r', model: 'sonnet', by: 'test' })
      const agent = d.agents.get('curia-42')
      assert.equal(agent.model, 'sonnet')
      // the harness follows the model, never the journal
      assert.equal(agent.harness, 'claude')
    })

    test('no spawn in the journal degrades to ordinary routing rather than refusing', async () => {
      const d = makeDispatcher({}, { routing: TWO_LANE })
      const reply = await d.resume('42', { repo: 'o/r', by: 'test' })
      assert.match(reply, /dispatched o\/r#42/)
      assert.equal(d.agents.get('curia-42').model, 'sonnet') // TWO_LANE's untyped default
    })

    test('a journalled model routing.yaml no longer carries degrades the same way', async () => {
      journalSpawn({ model: 'a-row-since-deleted', harness: 'codex' })
      const d = makeDispatcher({}, { routing: TWO_LANE })
      const reply = await d.resume('42', { repo: 'o/r', by: 'test' })
      assert.match(reply, /dispatched o\/r#42/)
      assert.equal(d.agents.get('curia-42').model, 'sonnet')
    })

    // The journal states a harness beside the model, and it is NOT read: config
    // is the authority on which harness a model runs on. A stale harness with a
    // current model is the `codex --model opus` contradiction by another road.
    test('a journalled harness that config contradicts is ignored, not honored', async () => {
      journalSpawn({ model: 'gpt', harness: 'claude' })
      const d = makeDispatcher({}, { routing: TWO_LANE })
      await d.resume('42', { repo: 'o/r', by: 'test' })
      assert.equal(d.agents.get('curia-42').harness, 'codex')
    })

    // resume all takes no model, so each ticket inherits its own.
    test('resume all leaves every ticket on its own inherited model', async () => {
      fs.mkdirSync(path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42', '.git'), { recursive: true })
      journalSpawn({ model: 'gpt', harness: 'codex' })
      const d = makeDispatcher({}, { routing: TWO_LANE })
      await d.resumeAll({ by: 'test' })
      await waitFor(() => d.agents.has('curia-42'))
      assert.equal(d.agents.get('curia-42').model, 'gpt')
    })
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

// The stranded-map watch (#485). An open, non-deferred map whose children are
// all closed gets no dispatch ever again, so the frontier read is the one place
// that can say so. The alarm is edge-triggered off the journal like the backup
// alarm (#436): said once, standing until the map closes, defers, or gains an
// open child.
describe('the stranded-map watch (#485)', () => {
  const map = (n, { state = 'open', labels = [] } = {}) => ({
    number: n, state, title: 'The journal becomes a queryable store',
    labels: [{ name: 'wayfinder:map' }, ...labels.map((name) => ({ name }))],
  })
  const closedChild = (n) => ({ number: n, state: 'closed', assignees: [], labels: [{ name: 'wayfinder:task' }] })
  const openChild = (n) => ({
    number: n, state: 'open', assignees: [], labels: [{ name: 'wayfinder:task' }],
    issue_dependencies_summary: { blocked_by: 0 },
  })

  test('an all-closed map is said once, journalled, and the second pass is quiet', async () => {
    const says = []
    const d = makeDispatcher({
      repoMaps: async () => [map(316)],
      mapFrontier: async () => [closedChild(1), closedChild(2)],
    })
    d.announce = async (text) => { says.push(text); return true }

    await d.frontier()
    assert.equal(says.length, 1)
    assert.match(says[0], /#316/)
    assert.match(says[0], /no open ticket left/)
    const ev = events.find((e) => e.type === 'map_stranded')
    assert.equal(ev.repo, 'o/r')
    assert.equal(ev.map, 316)
    assert.equal(ev.said, true)

    await d.frontier()
    assert.equal(says.length, 1, 'a standing alarm is not re-said')
    assert.equal(events.filter((e) => e.type === 'map_stranded').length, 1)
  })

  test('an open child, an empty map, and a deferred map raise nothing', async () => {
    const says = []
    let maps = [map(316)]
    let children = [closedChild(1), openChild(2)]
    const d = makeDispatcher({
      repoMaps: async () => maps,
      mapFrontier: async () => children,
    })
    d.announce = async (text) => { says.push(text); return true }

    await d.frontier()
    children = []
    await d.frontier()
    maps = [map(316, { labels: ['wayfinder:deferred'] })]
    children = [closedChild(1)]
    await d.frontier()

    assert.equal(says.length, 0)
    assert.ok(!events.some((e) => e.type === 'map_stranded'))
  })

  test('the alarm clears when a child reopens, and again when the map closes', async () => {
    let maps = [map(316)]
    let children = [closedChild(1)]
    const says = []
    const d = makeDispatcher({
      repoMaps: async () => maps,
      mapFrontier: async () => children,
    })
    d.announce = async (text) => { says.push(text); return true }

    await d.frontier()
    assert.equal(says.length, 1)

    children = [closedChild(1), openChild(2)]
    await d.frontier()
    assert.ok(events.some((e) => e.type === 'map_stranded_cleared' && e.map === 316))

    // it re-strands and is news again
    children = [closedChild(1), closedChild(2)]
    await d.frontier()
    assert.equal(says.length, 2)

    maps = [map(316, { state: 'closed' })]
    await d.frontier()
    assert.equal(events.filter((e) => e.type === 'map_stranded_cleared').length, 2)
  })

  test('an alarm the bridge could not carry stands unsaid and re-says when it returns', async () => {
    const d = makeDispatcher({
      repoMaps: async () => [map(316)],
      mapFrontier: async () => [closedChild(1)],
    })
    // the constructor default announce is the no-bridge answer: false

    await d.frontier()
    assert.equal(events.find((e) => e.type === 'map_stranded').said, false)

    await d.frontier()
    assert.equal(events.filter((e) => e.type === 'map_stranded').length, 1,
      'a standing unsaid alarm does not journal every pass')

    const says = []
    d.announce = async (text) => { says.push(text); return true }
    await d.frontier()
    assert.equal(says.length, 1)
    assert.equal(events.filter((e) => e.type === 'map_stranded').at(-1).said, true)
  })
})

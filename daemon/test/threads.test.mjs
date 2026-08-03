// Tests for the thread lifecycle and label binding (#93, per the #89
// discipline): the journalled ticket↔thread map in the store, the bridge's
// display-only label helpers, the thread context through the command seam,
// and the dispatcher's bind-at-claim / release-on-terminal-state calls.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EscalationStore } from '../src/store.mjs'
import { DiscordBridge } from '../src/bridge.mjs'
import { CommandRouter } from '../src/commands.mjs'
import { Dispatcher } from '../src/dispatch.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-threads-test-'))

// ---- the journalled binding (store.mjs) -------------------------------------

describe('EscalationStore ticket-thread bindings', () => {
  test('bind journals, both lookups answer, and boundTickets lists the ticket', () => {
    const store = new EscalationStore(tmp())
    const r = store.bindTicketThread('85', 't-1')
    assert.equal(r.ok, true)
    assert.equal(store.threadForTicket('85'), 't-1')
    assert.equal(store.threadForTicket(85), 't-1', 'numeric and string tickets are the same key')
    assert.equal(store.ticketForThread('t-1'), '85')
    assert.deepEqual(store.boundTickets(), ['85'])
  })

  test('rebinding the same pair is an ok no-op with no second journal line', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('85', 't-1')
    assert.equal(store.bindTicketThread('85', 't-1').ok, true)
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(lines.filter((l) => l.type === 'thread_bound').length, 1)
  })

  test('a double-bind refuses and names the holder, both directions', () => {
    const store = new EscalationStore(tmp())
    store.bindTicketThread('85', 't-1')
    // the ticket already lives on a thread
    const byTicket = store.bindTicketThread('85', 't-2')
    assert.deepEqual(byTicket, { ok: false, reason: 'ticket-bound', threadId: 't-1' })
    // the thread already carries a label
    const byThread = store.bindTicketThread('86', 't-1')
    assert.deepEqual(byThread, { ok: false, reason: 'thread-bound', ticket: '85' })
    assert.equal(store.threadForTicket('85'), 't-1', 'the refused bind changed nothing')
  })

  test('release journals once, clears both lookups, and is idempotent', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('85', 't-1')
    assert.equal(store.releaseTicketThread('85', 'finished'), 't-1')
    assert.equal(store.threadForTicket('85'), undefined)
    assert.equal(store.ticketForThread('t-1'), undefined)
    assert.equal(store.releaseTicketThread('85', 'finished'), null, 'nothing bound ⇒ no event')
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(lines.filter((l) => l.type === 'thread_released').length, 1)
    // a released thread is bindable again
    assert.equal(store.bindTicketThread('86', 't-1').ok, true)
  })

  test('the journal is the truth: a restart replays live bindings and released ones stay off', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('85', 't-1')
    store.bindTicketThread('86', 't-2')
    store.releaseTicketThread('85', 'cancelled')
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.threadForTicket('85'), undefined)
    assert.equal(reborn.threadForTicket('86'), 't-2')
    assert.deepEqual(reborn.boundTickets(), ['86'])
  })

  test('lastThreadForTicket survives a release and a restart (#140)', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindTicketThread('85', 't-1')
    store.releaseTicketThread('85', 'reconcile')
    assert.equal(store.threadForTicket('85'), undefined)
    assert.equal(store.lastThreadForTicket('85'), 't-1', 'the release does not erase the journal history')
    const reborn = new EscalationStore(dir)
    assert.equal(reborn.lastThreadForTicket('85'), 't-1')
    assert.equal(reborn.lastThreadForTicket(85), 't-1', 'numeric and string tickets are the same key')
    // a later rebind moves the pointer
    store.bindTicketThread('85', 't-9')
    assert.equal(store.lastThreadForTicket('85'), 't-9')
  })
})

// ---- the display-only label (bridge.mjs) ------------------------------------

describe('DiscordBridge label helpers', () => {
  test('labelName renders the 🎫 rename, with and without a type, capped at 100', () => {
    assert.equal(DiscordBridge.labelName('85'), '🎫 85')
    assert.equal(DiscordBridge.labelName('85', 'grilling'), '🎫 85 · grilling')
    assert.equal(DiscordBridge.labelName('85', 'x'.repeat(200)).length, 100)
  })

  test('doneName swaps the ticket signal for the checkmark and keeps the rest', () => {
    assert.equal(DiscordBridge.doneName('🎫 85 · grilling'), '✅ 85 · grilling')
    assert.equal(DiscordBridge.doneName('🎫 85'), '✅ 85')
    assert.equal(DiscordBridge.doneName(DiscordBridge.labelName('85', 'task')), '✅ 85 · task')
    assert.equal(DiscordBridge.doneName('deploy talk'), 'deploy talk')
  })

  test('threadLink composes from the ids the daemon already holds', () => {
    assert.equal(DiscordBridge.threadLink('G1', 'T9'), 'https://discord.com/channels/G1/T9')
  })
})

// ---- cross-thread breadcrumbs (#108 item 10) --------------------------------

describe('DiscordBridge cross-thread breadcrumbs', () => {
  let store, bridge, created, sentTo

  const makeThread = (id, name) => ({
    id, name, sent: [],
    send: async (text) => { sentTo.push({ id, text }) },
    setName: async () => {},
  })

  beforeEach(() => {
    store = new EscalationStore(tmp())
    created = []
    sentTo = []
    const threads = new Map()
    bridge = new DiscordBridge({
      token: 'x', allowedUsers: [], dataDir: tmp(),
      handlers: {}, log: () => {},
      bindings: {
        get: (t) => store.threadForTicket(t),
        bind: (t, id) => store.bindTicketThread(t, id),
        release: (t, r) => store.releaseTicketThread(t, r),
        last: (t) => store.lastThreadForTicket(t),
      },
    })
    bridge.guild = { id: 'G' }
    bridge.channel = {
      id: 'C',
      threads: {
        create: async ({ name }) => {
          const t = makeThread(`fresh-${created.length + 1}`, name)
          created.push(t)
          threads.set(t.id, t)
          return t
        },
      },
    }
    bridge.client = { channels: { fetch: async (id) => threads.get(id) ?? null } }
    bridge.registerThread = (t) => threads.set(t.id, t)
  })

  test('a dispatch from an already-bound thread opens a fresh thread and breadcrumbs both ways', async () => {
    const origin = makeThread('t-origin', '🎫 106 · charting')
    bridge.registerThread(origin)
    store.bindTicketThread('106', 't-origin')

    const r = await bridge.bindTicket('107', { threadId: 't-origin', type: 'research' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(store.threadForTicket('107'), created[0].id)
    assert.equal(created[0].name, '🎫 107 · research', 'the type names the fresh thread')
    // the new thread opens by naming the thread that sent it
    const inFresh = sentTo.find((s) => s.id === created[0].id)
    assert.match(inFresh.text, /dispatched from “🎫 106 · charting”/)
    assert.match(inFresh.text, /discord\.com\/channels\/G\/t-origin/)
    // and the origin learns where the work went
    const inOrigin = sentTo.find((s) => s.id === 't-origin')
    assert.match(inOrigin.text, /🎫 107 · research/)
    assert.match(inOrigin.text, new RegExp(`discord\\.com/channels/G/${created[0].id}`))
  })

  test('an autonomous dispatch (no issuing thread) opens a fresh thread with no breadcrumb', async () => {
    const r = await bridge.bindTicket('108', { type: 'prototype' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(created[0].name, '🎫 108 · prototype')
    assert.equal(sentTo.length, 0)
  })

  test('an untyped ticket names its thread with the number alone', async () => {
    const r = await bridge.bindTicket('115', {})
    assert.equal(r.ok, true)
    assert.equal(created[0].name, '🎫 115')
  })

  test('a bind onto an unbound issuing thread stays in place and takes the label as its name', async () => {
    const origin = makeThread('t-conv', 'deploy talk')
    const renames = []
    origin.setName = async (n) => { renames.push(n) }
    bridge.registerThread(origin)
    const r = await bridge.bindTicket('109', { threadId: 't-conv', type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 0)
    assert.equal(sentTo.length, 0)
    assert.equal(store.threadForTicket('109'), 't-conv')
    assert.deepEqual(renames, ['🎫 109 · task'], 'the old conversation name is replaced, not kept')
  })

  test('a ticket already bound elsewhere refuses as before — no thread churn', async () => {
    store.bindTicketThread('110', 't-elsewhere')
    const r = await bridge.bindTicket('110', { threadId: 't-other', type: 'task' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'ticket-bound')
    assert.equal(created.length, 0)
  })

  // ---- the dispatch backstop (#140) ------------------------------------------

  test('an unbound ticket goes back to the journal-last thread when it still exists', async () => {
    const old = makeThread('t-old', 'Run the map')
    bridge.registerThread(old)
    store.bindTicketThread('111', 't-old')
    store.releaseTicketThread('111', 'reconcile') // the pre-#140 sweep struck
    const renames = []
    old.setName = async (n) => { renames.push(n) }

    const r = await bridge.bindTicket('111', { type: 'research' })
    assert.equal(r.ok, true)
    assert.equal(r.threadId, 't-old', 'the old thread is rebound, not replaced')
    assert.equal(created.length, 0, 'no fresh thread')
    assert.equal(store.threadForTicket('111'), 't-old')
    assert.deepEqual(renames, ['🎫 111 · research'], 'the label goes back on')
  })

  test('a revived thread that finished once goes from ✅ back to 🎫', async () => {
    const old = makeThread('t-done', '✅ 116 · task')
    const renames = []
    old.setName = async (n) => { renames.push(n) }
    bridge.registerThread(old)
    store.bindTicketThread('116', 't-done')
    store.releaseTicketThread('116', 'finished')

    const r = await bridge.bindTicket('116', { type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(r.threadId, 't-done')
    assert.deepEqual(renames, ['🎫 116 · task'], 'reopened work reads as open again')
  })

  test('the backstop unarchives a revived thread', async () => {
    const old = makeThread('t-old', '🎫 112 · sleepy')
    old.archived = true
    const unarchived = []
    old.setArchived = async (v) => { unarchived.push(v) }
    bridge.registerThread(old)
    store.bindTicketThread('112', 't-old')
    store.releaseTicketThread('112', 'reconcile')

    const r = await bridge.bindTicket('112', { type: 'grilling' })
    assert.equal(r.ok, true)
    assert.deepEqual(unarchived, [false])
  })

  test('a journal-last thread gone from Discord falls back to a fresh one', async () => {
    store.bindTicketThread('113', 't-deleted') // never registered ⇒ fetch misses
    store.releaseTicketThread('113', 'reconcile')
    const r = await bridge.bindTicket('113', { type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(store.threadForTicket('113'), created[0].id)
  })

  test('a journal-last thread re-bound to another ticket is not taken back', async () => {
    const old = makeThread('t-taken', '🎫 200 · new owner')
    bridge.registerThread(old)
    store.bindTicketThread('114', 't-taken')
    store.releaseTicketThread('114', 'reconcile')
    store.bindTicketThread('200', 't-taken') // another ticket moved in

    const r = await bridge.bindTicket('114', { type: 'task' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1, 'a fresh thread instead')
    assert.equal(store.threadForTicket('114'), created[0].id)
    assert.equal(store.threadForTicket('200'), 't-taken', 'the squatter keeps its thread')
  })

  // ---- release keeps the name and changes the signal --------------------------

  test('release swaps 🎫 for ✅ and keeps the ticket and its type', async () => {
    const t = makeThread('t-fin', '🎫 117 · grilling')
    const renames = []
    t.setName = async (n) => { renames.push(n) }
    bridge.registerThread(t)
    store.bindTicketThread('117', 't-fin')

    await bridge.releaseTicket('117', 'finished')
    assert.deepEqual(renames, ['✅ 117 · grilling'])
    assert.equal(store.threadForTicket('117'), undefined, 'the journal releases either way')
  })

  test('release leaves an unlabeled thread alone and survives a deleted one', async () => {
    const t = makeThread('t-plain', 'deploy talk')
    const renames = []
    t.setName = async (n) => { renames.push(n) }
    bridge.registerThread(t)
    store.bindTicketThread('118', 't-plain')
    await bridge.releaseTicket('118', 'finished')
    assert.deepEqual(renames, [])

    store.bindTicketThread('119', 't-gone') // never registered ⇒ fetch misses
    await bridge.releaseTicket('119', 'finished')
    assert.equal(store.threadForTicket('119'), undefined)
  })
})

// ---- the thread context through the router (commands.mjs) --------------------

describe('CommandRouter thread context (#93)', () => {
  const WATCH = { watch: [{ repo: 'o/r' }], }
  test('start, next and resume carry the issuing thread to the dispatcher', async () => {
    const got = []
    const dispatcher = {
      config: WATCH,
      routing: { backends: {} },
      start: async (t, opts) => { got.push(['start', t, opts.threadId]); return 'ok' },
      next: async (r, opts) => { got.push(['next', r, opts.threadId]); return 'ok' },
      resume: async (t, opts) => { got.push(['resume', t, opts.threadId]); return 'ok' },
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    await router.handle('start 85', 'u1', { threadId: 't-9' })
    await router.handle('next', 'u1', { threadId: 't-9' })
    await router.handle('resume 85', 'u1', { threadId: 't-9' })
    await router.handle('start 85', 'u1') // no context — REST, top-level slash
    assert.deepEqual(got, [
      ['start', '85', 't-9'], ['next', undefined, 't-9'], ['resume', '85', 't-9'], ['start', '85', null],
    ])
  })
})

// ---- bind at claim, release on terminal states (dispatch.mjs) ----------------

const OPEN_ISSUE = {
  number: 42, title: 'a ticket', body: 'body text', state: 'open',
  assignees: [], labels: [],
}

let dir
let binds
let releases
let escalations

beforeEach(() => {
  dir = tmp()
  fs.mkdirSync(path.join(dir, 'data', 'results'), { recursive: true })
  binds = []
  releases = []
  escalations = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function waitFor(cond, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!cond()) throw new Error('waitFor: condition not reached in time')
}

function makeDispatcher(deps = {}, { confirm = async () => true, bound = [] } = {}) {
  const root = path.join(dir, 'work')
  return new Dispatcher({
    config: {
      watch: [{ repo: 'o/r', mode: 'auto' }],
      dispatch: {
        auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
        workspace_root: root, ready_timeout_s: 1, confirm_ttl_h: 4, stop_nudge_budget: 3,
      },
      attach: { ttyd_port: 7681, serve_port: 8443 },
      identity: { allow: ['tester@example.com'], proxy_port: 7682 },
      skills: null,
    },
    routing: {
      defaults: { untyped: 'sonnet' },
      models: { sonnet: { provider: 'anthropic', backend: 'claude' } },
      fallbacks: {},
      backends: { claude: { template: 'claude "$(cat {prompt_file})"', readyRe: /⏵⏵/ } },
    },
    store: {
      logEvent: (type, data) => ({ type, ...data }),
      openEscalations: () => escalations,
      cancel: () => ({ ok: true }),
      boundTickets: () => bound,
    },
    notify: () => {},
    confirm,
    threads: {
      bind: async (ticket, opts) => { binds.push({ ticket, ...opts }); return { ok: true } },
      release: async (ticket, reason) => { releases.push({ ticket, reason }) },
    },
    log: () => {},
    dataDir: path.join(dir, 'data'),
    daemonPort: 4271,
    deps: {
      viewerLogin: async () => 'me',
      repoMaps: async () => [], mapFrontier: async () => [], flatFrontier: async () => [],
      blockedByOf: async () => [],
      fetchIssue: async () => ({ ...OPEN_ISSUE }),
      claim: async () => {}, unclaim: async () => {},
      hasSession: async () => false, listSessions: async () => [],
      newSession: async () => {}, capturePane: async () => '', killSession: async () => {},
      ensureBaseClone: async (r, repo) => path.join(r, 'repos', repo.replace('/', '__'), 'base'),
      createWorktree: async (b, n) => {
        const wt = path.join(path.dirname(b), 'wt', String(n))
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
        return wt
      },
      removeWorktree: async () => {}, removeConfigDir: () => {}, removeCredentials: () => {},
      seedConfigDir: () => {}, writeHarness: () => {},
      writePrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
      ensureTtyd: async () => ({ verified: true }), assertServe: async () => {}, serveOff: async () => {},
      commentIssue: async () => {}, closeIssue: async () => {}, setIssueBody: async () => {},
      issueComments: async () => [], findPullRequest: async () => null,
      createPullRequest: async () => 'url', setPullRequestBody: async () => {},
      deleteRemoteBranch: async () => ({ deleted: true }),
      defaultBranchOf: async () => 'main', commitsOnBranch: async () => [],
      pushBranch: async () => 'abc', hasUnpushedWork: async () => false,
      ...deps,
    },
  })
}

describe('Dispatcher thread binding (#93)', () => {
  test('start binds the thread it ran in, at the claim, with the ticket type', async () => {
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, labels: [{ name: 'wayfinder:grilling' }] }),
    })
    assert.match(await d.start('42', { repo: 'o/r', threadId: 't-7' }), /dispatched/)
    assert.deepEqual(binds, [{ ticket: '42', threadId: 't-7', type: 'grilling' }])
  })

  test('an untyped ticket binds with an empty type — the number names the thread', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r', threadId: 't-7' })
    assert.deepEqual(binds, [{ ticket: '42', threadId: 't-7', type: '' }])
  })

  test('a dispatch with no issuing thread asks for a fresh bound thread (threadId null)', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r', by: 'auto' })
    assert.deepEqual(binds, [{ ticket: '42', threadId: null, type: '' }])
  })

  test('a prepare failure keeps the label — a claim release is not ticket-terminal (#140)', async () => {
    const d = makeDispatcher({ createWorktree: async () => { throw new Error('disk full') } })
    assert.match(await d.start('42', { repo: 'o/r', threadId: 't-7' }), /failed before the worker could run/)
    assert.deepEqual(releases, [], 'the retry belongs in the same thread')
  })

  test('a confirmed cancel keeps the label — the ticket goes back to the frontier (#140)', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    assert.match(await d.cancel('42', { by: 'test' }), /cancelled/)
    assert.deepEqual(releases, [], 'a later dispatch belongs in the thread its history lives in')
  })

  test('a finished worker (result recorded) releases the label; an abnormal exit keeps it', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    fs.writeFileSync(path.join(dir, 'data', 'results', 'curia-42.json'), '{}')
    await d.onWorkerDone('curia-42')
    assert.deepEqual(releases, [{ ticket: '42', reason: 'finished' }])

    releases.length = 0
    await d.start('43', { repo: 'o/r' })
    await d.onWorkerDone('curia-43') // no results file ⇒ abnormal exit, pane kept
    assert.deepEqual(releases, [], 'post-mortem traffic still belongs in the labeled thread')
  })

  test('reconcile releases a binding only when the issue is positively closed (#140)', async () => {
    const d = makeDispatcher(
      { fetchIssue: async (repo, n) => ({ ...OPEN_ISSUE, number: Number(n), state: String(n) === '42' ? 'closed' : 'open' }) },
      { bound: ['42', '44'] },
    )
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [{ ticket: '42', reason: 'reconcile' }],
      'the closed ticket loses its label; the open one keeps it for the resumed worker')
  })

  test('reconcile keeps the binding of a dead worker on an open ticket, even with no escalation (#140)', async () => {
    const d = makeDispatcher({}, { bound: ['42'] }) // fetchIssue default: state open
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [], 'worker death is not a ticket-terminal state')
  })

  test('reconcile keeps the label of a closed ticket while a human is still being asked', async () => {
    const d = makeDispatcher(
      { fetchIssue: async () => ({ ...OPEN_ISSUE, state: 'closed' }) },
      { bound: ['43'] },
    )
    escalations.push({ id: 'esc-1', worker: 'curia-43', ticket: '43', status: 'open', kind: 'review-gate' })
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [], 'the open escalation traffic must keep landing in the labeled thread')
  })

  test('reconcile releases a binding whose issue is positively absent everywhere', async () => {
    const d = makeDispatcher(
      { fetchIssue: async () => { throw new Error('gh: Not Found (HTTP 404)') } },
      { bound: ['42'] },
    )
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [{ ticket: '42', reason: 'reconcile' }])
  })

  test('reconcile keeps every binding when the issue read fails', async () => {
    const d = makeDispatcher(
      { fetchIssue: async () => { throw new Error('network is down') } },
      { bound: ['42'] },
    )
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [], 'an unreadable issue is not evidence — the next pass retries')
  })

  test('reconcile with an indeterminate session list releases nothing', async () => {
    const d = makeDispatcher({ listSessions: async () => { throw new Error('tmux wedged') } }, { bound: ['42'] })
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [])
  })
})

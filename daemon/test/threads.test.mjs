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
})

// ---- the display-only label (bridge.mjs) ------------------------------------

describe('DiscordBridge label helpers', () => {
  test('labelName renders the 🎫 rename, with and without a title, capped at 100', () => {
    assert.equal(DiscordBridge.labelName('85'), '🎫 85')
    assert.equal(DiscordBridge.labelName('85', 'Fix the parser'), '🎫 85 · Fix the parser')
    assert.equal(DiscordBridge.labelName('85', 'x'.repeat(200)).length, 100)
  })

  test('stripLabel removes the label and leaves everything else alone', () => {
    assert.equal(DiscordBridge.stripLabel('🎫 85 · deploy talk'), 'deploy talk')
    assert.equal(DiscordBridge.stripLabel('🎫 85'), '')
    assert.equal(DiscordBridge.stripLabel('deploy talk'), 'deploy talk')
    assert.equal(DiscordBridge.stripLabel(DiscordBridge.labelName('85', 'roundtrip')), 'roundtrip')
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

    const r = await bridge.bindTicket('107', { threadId: 't-origin', title: 'Run the map' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(store.threadForTicket('107'), created[0].id)
    // the new thread opens by naming the thread that sent it
    const inFresh = sentTo.find((s) => s.id === created[0].id)
    assert.match(inFresh.text, /dispatched from “🎫 106 · charting”/)
    assert.match(inFresh.text, /discord\.com\/channels\/G\/t-origin/)
    // and the origin learns where the work went
    const inOrigin = sentTo.find((s) => s.id === 't-origin')
    assert.match(inOrigin.text, /🎫 107 · Run the map/)
    assert.match(inOrigin.text, new RegExp(`discord\\.com/channels/G/${created[0].id}`))
  })

  test('an autonomous dispatch (no issuing thread) opens a fresh thread with no breadcrumb', async () => {
    const r = await bridge.bindTicket('108', { title: 'quiet start' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(sentTo.length, 0)
  })

  test('a bind onto an unbound issuing thread stays in place — no fresh thread, no breadcrumb', async () => {
    const origin = makeThread('t-conv', 'deploy talk')
    bridge.registerThread(origin)
    const r = await bridge.bindTicket('109', { threadId: 't-conv', title: 'x' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 0)
    assert.equal(sentTo.length, 0)
    assert.equal(store.threadForTicket('109'), 't-conv')
  })

  test('a ticket already bound elsewhere refuses as before — no thread churn', async () => {
    store.bindTicketThread('110', 't-elsewhere')
    const r = await bridge.bindTicket('110', { threadId: 't-other', title: 'x' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'ticket-bound')
    assert.equal(created.length, 0)
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
  test('start binds the thread it ran in, at the claim, with the ticket title', async () => {
    const d = makeDispatcher()
    assert.match(await d.start('42', { repo: 'o/r', threadId: 't-7' }), /dispatched/)
    assert.deepEqual(binds, [{ ticket: '42', threadId: 't-7', title: 'a ticket' }])
  })

  test('a dispatch with no issuing thread asks for a fresh bound thread (threadId null)', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r', by: 'auto' })
    assert.deepEqual(binds, [{ ticket: '42', threadId: null, title: 'a ticket' }])
  })

  test('a prepare failure releases the label it just put on', async () => {
    const d = makeDispatcher({ createWorktree: async () => { throw new Error('disk full') } })
    assert.match(await d.start('42', { repo: 'o/r', threadId: 't-7' }), /failed before the worker could run/)
    assert.deepEqual(releases, [{ ticket: '42', reason: 'dispatch-failed' }])
  })

  test('a confirmed cancel releases the label after the teardown', async () => {
    const d = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    d.cancel('42', { by: 'test' })
    await waitFor(() => releases.length > 0)
    assert.deepEqual(releases, [{ ticket: '42', reason: 'cancelled' }])
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

  test('reconcile releases a binding whose dispatch is positively over, and keeps one with an open escalation', async () => {
    const d = makeDispatcher({}, { bound: ['42', '43'] })
    escalations.push({ id: 'esc-1', worker: 'curia-43', ticket: '43', status: 'open', kind: 'review-gate' })
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [{ ticket: '42', reason: 'reconcile' }],
      'no session + no worker ⇒ released; the ticket a human is still being asked about keeps its label')
  })

  test('reconcile with an indeterminate session list releases nothing', async () => {
    const d = makeDispatcher({ listSessions: async () => { throw new Error('tmux wedged') } }, { bound: ['42'] })
    await d.reconcile({ boot: false })
    assert.deepEqual(releases, [])
  })
})

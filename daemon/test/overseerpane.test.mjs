import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OverseerPaneHost, containerCheckoutPass, overseerPaneName, overseerPaneSession,
  prepareOverseerPane,
} from '../src/overseerpane.mjs'
import { PASTE_START, PASTE_END, bracketedPaste } from '../src/tmux.mjs'
import { Reduction } from '../src/reduction.mjs'

const UUID = '11111111-2222-4333-8444-555555555555'
const ROOT = '/work'
const REPO = '/srv/curia'
const DATA = '/data'
const HOME = path.join(ROOT, 'cfg', 'curia-overseer', 'home')

function storeDouble() {
  const sessions = new Map()
  const pending = new Map()
  return {
    events: [],
    overseerSession: (key) => sessions.get(key),
    pendingOverseerSession: (key) => pending.get(key),
    reserveOverseerSession(key, session) { pending.set(key, session) },
    bindOverseerSession(key, session) {
      sessions.set(key, session)
      pending.delete(key)
    },
    journal(type, detail) { this.events.push({ type, ...detail }) },
  }
}

function paneDouble() {
  const sessions = new Set()
  return {
    starts: [],
    readies: [],
    sends: [],
    parks: [],
    async has(name) { return sessions.has(name) },
    async start(spec) { this.starts.push(spec); sessions.add(spec.name) },
    async ready(name) { this.readies.push(name) },
    async send(name, text) {
      this.sends.push({ name, text })
      return { status: 'confirmed' }
    },
    async park(name) { this.parks.push(name); sessions.delete(name) },
  }
}

function identityDouble() {
  const tokens = new Map()
  const calls = { armed: [], carried: [] }
  return {
    calls,
    tokenFor: (key) => tokens.get(key),
    deps: {
      ensureToken(dataDir, key) {
        if (!tokens.has(key)) tokens.set(key, `token-${key}-${tokens.size}`)
        assert.equal(dataDir, DATA)
        return tokens.get(key)
      },
      writeConnection(settings) { calls.armed.push(settings) },
      carryTranscript(options) { calls.carried.push(options) },
    },
  }
}

function hosted({ reduction = storeDouble(), pane = paneDouble(), identity = identityDouble(), ...options } = {}) {
  const host = new OverseerPaneHost({
    reduction,
    workspaceRoot: ROOT,
    repoRoot: REPO,
    dataDir: DATA,
    daemonPort: 8177,
    pane,
    containerId: async () => 'overseer-container',
    newSessionId: () => UUID,
    deps: identity.deps,
    ...options,
  })
  return { host, reduction, pane, identity }
}

describe('overseer conversations use the pane host (#688, #701)', () => {
  test('one hosted message starts an armed pane with durable overseer identity', async () => {
    const { host, reduction, pane, identity } = hosted()

    const sent = await host.send('console-7', 'Show active agents.')

    assert.deepEqual(sent, { status: 'confirmed' })
    assert.equal(reduction.overseerSession('console-7'), UUID)
    assert.equal(pane.starts[0].name, 'curia-console-7')
    assert.equal(pane.starts[0].cwd, path.join(HOME, UUID))
    assert.equal(pane.starts[0].keepOpen, false)
    assert.match(pane.starts[0].shellCmd, /docker exec -it overseer-container/)
    assert.match(pane.starts[0].shellCmd, new RegExp('--session-id ' + UUID + '$'))
    assert.doesNotMatch(pane.starts[0].shellCmd, /console-7|conversation=/)
    assert.deepEqual(pane.sends, [{ name: 'curia-console-7', text: 'Show active agents.' }])
    assert.ok(reduction.events.some((event) => (
      event.type === 'overseer_pane_started' && event.session_id === UUID
    )))
    assert.deepEqual(identity.calls.armed, [{
      home: path.join(HOME, UUID),
      url: 'http://host.docker.internal:8177/overseer/mcp?conversation=console-7',
      token: identity.tokenFor('console-7'),
      serverName: 'curia',
      header: 'x-curia-agent-token',
    }])
    assert.deepEqual(identity.calls.carried, [{
      configDir: path.join(ROOT, 'cfg', 'curia-overseer'),
      sessionId: UUID,
      home: path.join(HOME, UUID),
    }])
  })

  test('a deploy parks the pane and rehydrates the same conversation identity', async () => {
    const state = hosted()

    await state.host.send('console-7', 'First message.')
    const first = state.identity.calls.armed.at(-1)
    await state.host.parkForDeploy()
    await state.host.send('console-7', 'Second message.')

    const second = state.identity.calls.armed.at(-1)
    assert.deepEqual(state.pane.parks, ['curia-console-7'])
    assert.equal(state.reduction.overseerSession('console-7'), UUID)
    assert.match(state.pane.starts[1].shellCmd, new RegExp('--resume ' + UUID + '$'))
    assert.equal(second.token, first.token)
    assert.equal(second.url, first.url)
    assert.equal(second.home, first.home)
  })

  test('take back can rehydrate a parked pane without sending a message', async () => {
    const reduction = storeDouble()
    reduction.bindOverseerSession('console-7', UUID)
    const state = hosted({ reduction })

    assert.equal(await state.host.ensure('console-7'), 'curia-console-7')
    assert.match(state.pane.starts[0].shellCmd, new RegExp('--resume ' + UUID + '$'))
    assert.deepEqual(state.pane.sends, [])
  })

  test('pane names preserve Curia app routes and isolate other identities', () => {
    assert.equal(overseerPaneName('console-12'), 'curia-console-12')
    assert.equal(overseerPaneName('688'), 'curia-overseer-688')
    assert.match(overseerPaneName('discord/thread:12'), /^curia-overseer-[a-f0-9]{16}$/)
    assert.equal(overseerPaneSession('console-8'), 'curia-console-8')
    assert.equal(overseerPaneSession('688'), 'curia-overseer-688')
    assert.throws(() => overseerPaneSession('ticket-688'), /conversation key/)
  })

  test('a deleted Curia app conversation cannot create or arm a pane', async () => {
    const reduction = { ...storeDouble(), hasConsoleConversation: () => false }
    const state = hosted({ reduction })

    await assert.rejects(state.host.send('console-7', 'Do not send.'), /there is no conversation/)
    assert.equal(state.pane.starts.length, 0)
    assert.equal(state.identity.calls.armed.length, 0)
  })

  test('a failed first launch retries the reserved identity and token', async () => {
    const pane = paneDouble()
    pane.ready = async () => { throw new Error('composer timeout') }
    const state = hosted({ pane })

    await assert.rejects(state.host.send('console-7', 'First try.'), /composer timeout/)
    assert.equal(state.reduction.overseerSession('console-7'), undefined)
    assert.equal(state.reduction.pendingOverseerSession('console-7'), UUID)
    const first = state.identity.calls.armed.at(-1)
    await pane.park('curia-console-7')
    pane.ready = async (name) => { pane.readies.push(name) }
    await state.host.send('console-7', 'Second try.')

    const second = state.identity.calls.armed.at(-1)
    assert.equal(state.reduction.overseerSession('console-7'), UUID)
    assert.equal(state.reduction.pendingOverseerSession('console-7'), undefined)
    assert.equal(pane.starts.length, 2)
    assert.equal(second.token, first.token)
    for (const start of pane.starts) {
      assert.match(start.shellCmd, new RegExp('--session-id ' + UUID + '$'))
      assert.doesNotMatch(start.shellCmd, /--resume/)
    }
  })

  test('the live pane cap parks the least recently used conversation', async () => {
    let seq = 0
    const state = hosted({
      livePaneCap: 2,
      newSessionId: () => (
        '11111111-2222-4333-8444-' + String(++seq).padStart(12, '0')
      ),
    })

    await state.host.send('console-1', 'One.')
    await state.host.send('console-2', 'Two.')
    await state.host.send('console-1', 'One again.')
    await state.host.send('console-3', 'Three.')

    assert.deepEqual(state.pane.parks, ['curia-console-2'])
    await state.host.send('console-2', 'Resume two.')
    assert.match(state.pane.starts.at(-1).shellCmd, /--resume 11111111-2222-4333-8444-000000000002$/)
    assert.equal(state.host.live.size, 2)
  })

  test('concurrent conversation opens share one capacity decision', async () => {
    const state = hosted({
      livePaneCap: 2,
      newSessionId: () => crypto.randomUUID(),
    })

    await Promise.all([
      state.host.ensure('console-1'),
      state.host.ensure('console-2'),
      state.host.ensure('console-3'),
    ])

    assert.equal(state.host.live.size, 2)
    assert.equal(state.pane.parks.length, 1)
  })

  test('two conversations never share one tool identity', async () => {
    const state = hosted({ newSessionId: () => crypto.randomUUID() })

    await state.host.send('console-4', 'First.')
    await state.host.send('console-5', 'Second.')

    const [one, two] = state.identity.calls.armed
    assert.notEqual(one.token, two.token)
    assert.notEqual(one.home, two.home)
    assert.match(one.url, /conversation=console-4$/)
    assert.match(two.url, /conversation=console-5$/)
  })

  test('the hosted process keeps overseer authority inside its conversation home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overseer-pane-'))
    try {
      const cfg = { dispatch: { workspace_root: root }, watch: [{ repo: 'alp82/curia' }] }
      const seeded = []
      let credentialInstalled = false
      const launch = prepareOverseerPane({
        cfg,
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        resume: true,
        deps: {
          seed: (...args) => seeded.push(args),
          systemPrompt: () => 'overseer orders',
          installCredential: (storeFile, configDir) => {
            credentialInstalled = true
            assert.equal(storeFile, path.join(root, 'credentials', 'anthropic.json'), 'the store, which only the daemon reads (#867)')
            assert.equal(configDir, path.join(root, 'cfg', 'curia-overseer'))
            return null
          },
          processEnv: () => ({ PATH: '/usr/bin' }),
        },
      })

      const home = path.join(
        root, 'cfg', 'curia-overseer', 'home', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      )
      assert.deepEqual(seeded, [[
        path.join(root, 'cfg', 'curia-overseer'),
        home,
        null,
        'claude',
        { sandboxed: true },
      ]])
      assert.equal(launch.cwd, home)
      assert.equal(launch.env.CLAUDE_CONFIG_DIR, path.join(root, 'cfg', 'curia-overseer'))
      assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
      assert.equal(credentialInstalled, true)
      assert.deepEqual(launch.args.slice(-2), ['--resume', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
      assert.ok(launch.args.includes('overseer orders'))
      assert.ok(launch.args.includes('--dangerously-skip-permissions'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// one complete message (#708, ADR-0024)
// ---------------------------------------------------------------------------

const WORKING = '✻ Thinking… (esc to interrupt)'
const COMPOSER = '> '

function messageHost({
  pass, notes = [], panes = [WORKING, COMPOSER],
  delivery = { status: 'confirmed' },
  startTimeoutMs = 5_000, messageTimeoutMs = 5_000,
} = {}) {
  const queued = [...notes]
  const calls = { journal: [], sent: [], signals: [], passes: [], requeued: [] }
  const reduction = {
    overseerSession: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pendingOverseerSession: () => null,
    reserveOverseerSession: () => {},
    bindOverseerSession: () => {},
    takeOverseerNotes: () => queued.splice(0, queued.length),
    addOverseerNote: (key, text) => { calls.requeued.push({ key, text }); queued.push(text) },
    journal: (type, detail) => calls.journal.push({ type, ...detail }),
  }
  const shown = [...panes]
  const host = new OverseerPaneHost({
    reduction,
    workspaceRoot: ROOT,
    repoRoot: REPO,
    dataDir: DATA,
    daemonPort: 8177,
    readyTimeoutMs: 0,
    watchRepos: () => ['alp82/curia', 'alp82/orca'],
    startTimeoutMs,
    messageTimeoutMs,
    settlePollMs: 0,
    log: () => {},
    deps: {
      ensureDir: () => {},
      ensureToken: () => 'token',
      writeConnection: () => {},
      carryTranscript: () => {},
      hasSession: async () => true,
      newSession: async () => {},
      capturePane: async () => (shown.length > 1 ? shown.shift() : shown[0]),
      sendText: async (name, text, options) => {
        calls.sent.push({ name, text, options })
        return delivery
      },
      checkoutPass: async (args) => {
        calls.passes.push(args)
        return pass(args)
      },
      onComplete: async (signal) => { calls.signals.push(signal) },
    },
  })
  return { host, calls, queued }
}

const freshPass = ({ repos }) => ({
  root: '/work/overseer/repos',
  at: '2026-08-25T10:00:00.000Z',
  removed: [],
  repos: repos.map((repo) => ({
    repo, ok: true, cloned: false, branch: 'main', head: 'abc1234', fetchedAt: '2026-08-25T10:00:00.000Z',
  })),
  why: null,
})

describe('one complete pane message (#708)', () => {
  test('the message starts on a checkout verdict for every watched repo', async () => {
    const { host, calls } = messageHost({ pass: freshPass })

    const out = await host.deliver('console-4', 'what is on the frontier?')

    assert.deepEqual(calls.passes[0].repos, ['alp82/curia', 'alp82/orca'])
    assert.deepEqual(out.checkouts.repos.map((r) => r.repo), ['alp82/curia', 'alp82/orca'])
    const sent = calls.sent[0].text
    assert.ok(sent.startsWith('This turn\'s checkouts:'), 'the facts frame the message')
    assert.match(sent, /Every watched repo was fetched/)
    assert.ok(sent.endsWith('what is on the frontier?'), 'the operator\'s words are last')
    assert.equal(calls.sent[0].options.paste, true)
    await out.completion
  })

  test('a stale checkout reaches the model as stale, with its age', async () => {
    const { host, calls } = messageHost({
      pass: ({ repos }) => ({
        removed: [],
        repos: [
          { repo: repos[0], ok: true, cloned: false, branch: 'main', head: 'abc1234', fetchedAt: '2026-08-25T10:00:00.000Z' },
          { repo: repos[1], ok: false, cloned: false, error: 'could not reach github.com', fetchedAt: null, staleSince: '2026-08-24T10:00:00.000Z' },
        ],
        why: null,
      }),
    })

    const out = await host.deliver('console-4', 'read the curia scene')

    const sent = calls.sent[0].text
    assert.match(sent, /alp82\/orca is STALE/)
    assert.match(sent, /could not reach github\.com/)
    assert.match(sent, /last good fetch was .+ ago/)
    assert.equal(out.checkouts.repos.filter((r) => !r.ok).length, 1)
    assert.ok(calls.journal.some((e) => e.type === 'overseer_pane_message' && e.stale === 1))
    await out.completion
  })

  test('a pass that could not run leaves no repo reading as fresh', async () => {
    const { host, calls } = messageHost({
      pass: ({ repos }) => containerCheckoutPass({
        repoRoot: REPO,
        repos,
        execFile: async () => {
          throw Object.assign(new Error('exec failed'), { stderr: 'Error: No such container: curia-overseer-1' })
        },
      }),
    })

    const out = await host.deliver('console-4', 'what changed today?')

    assert.equal(out.checkouts.repos.length, 2)
    assert.equal(out.checkouts.repos.every((r) => r.ok === false), true)
    assert.match(calls.sent[0].text, /No such container/)
    await out.completion
  })

  test('several queued notes enter as one bracketed paste with their newlines', async () => {
    const { host, calls, queued } = messageHost({
      pass: freshPass,
      notes: ['esc-12 was answered: yes', 'the deploy of curia@abc1234 succeeded', 'map #685 gained a child'],
    })

    const out = await host.deliver('console-4', 'anything I missed?')

    const sent = calls.sent[0].text
    assert.equal(calls.sent.length, 1, 'one message, not one send per note')
    assert.match(sent, /\[curia: esc-12 was answered: yes\]\n\[curia: the deploy of curia@abc1234 succeeded\]\n\[curia: map #685 gained a child\]/)
    assert.ok(sent.indexOf('[curia: esc-12') < sent.indexOf('anything I missed?'))
    assert.equal(calls.sent[0].options.paste, true, 'the newlines survive only inside a bracketed paste')
    assert.deepEqual(queued, [], 'the notes left the queue with the message')
    assert.equal(out.notes.length, 3)
    const wrapped = bracketedPaste(sent)
    assert.ok(wrapped.startsWith(PASTE_START) && wrapped.endsWith(PASTE_END))
    assert.equal(wrapped.split('\r').length, sent.split('\n').length)
    assert.doesNotMatch(wrapped, /\n/, 'a newline inside a paste would submit half the message')
    await out.completion
  })

  test('the harness finishing the message emits exactly one completion signal', async () => {
    const { host, calls } = messageHost({
      pass: freshPass,
      panes: [WORKING, WORKING, COMPOSER],
    })

    const out = await host.deliver('console-4', 'summarise the map')
    const signal = await out.completion

    assert.equal(signal.ok, true)
    assert.equal(signal.key, 'console-4')
    assert.equal(signal.session, 'curia-console-4')
    assert.deepEqual(calls.signals, [signal], 'one signal, once')
    const ended = calls.journal.filter((e) => e.type === 'overseer_pane_message_ended')
    assert.equal(ended.length, 1)
    assert.equal(ended[0].ok, true)
  })

  test('a message the pane refused signals its failure and puts the notes back', async () => {
    const { host, calls, queued } = messageHost({
      pass: freshPass,
      notes: ['esc-12 was answered: yes'],
      delivery: { status: 'not-sent' },
    })

    const out = await host.deliver('console-4', 'stop the agent')
    const signal = await out.completion

    assert.equal(signal.ok, false)
    assert.match(signal.why, /still working/)
    assert.equal(calls.signals.length, 1, 'a message that never went in still signals, once')
    assert.deepEqual(queued, ['esc-12 was answered: yes'], 'the drained note is back on the queue')
    assert.deepEqual(calls.requeued, [{ key: 'console-4', text: 'esc-12 was answered: yes' }])
    assert.equal(calls.journal.some((e) => e.type === 'overseer_pane_message'), false, 'nothing was delivered')
  })

  test('a harness that never finishes fails the message by name', async () => {
    const { host, calls } = messageHost({
      pass: freshPass,
      panes: [WORKING],
      messageTimeoutMs: 0,
    })

    const signal = await (await host.deliver('console-4', 'read every repo')).completion

    assert.equal(signal.ok, false)
    assert.match(signal.why, /still working 0s after the message/)
    assert.equal(calls.signals.length, 1)
  })

  test('a pane that never picks the message up fails it by name', async () => {
    const { host } = messageHost({
      pass: freshPass,
      panes: [COMPOSER],
      startTimeoutMs: 0,
    })

    const signal = await (await host.deliver('console-4', 'hello')).completion

    assert.equal(signal.ok, false)
    assert.match(signal.why, /never started a turn/)
  })
})

// ---------------------------------------------------------------------------
// the cap's idle rule, the forced park and the turn a restart can find (#710)
// ---------------------------------------------------------------------------
//
// A live pane is a CACHE in front of a durable conversation. Everything below
// tests one promise: capacity management may stop a process, and it may not
// change the conversation. So the assertions are as much about what parking
// leaves alone — the resume id, the token, the notes — as about what it stops.

const IDLE = 'bypass permissions'
const BUSY = '✻ Thinking… (esc to interrupt)'

// `paneDouble` with a capture that can say a named pane is mid-message, which
// is the one fact the idle rule turns on.
function capturingPane(busy = new Set()) {
  const pane = paneDouble()
  pane.capture = async (name) => (busy.has(name) ? BUSY : IDLE)
  pane.busy = busy
  return pane
}

function capStore() {
  const store = storeDouble()
  store.turns = []
  store.parked = []
  store.livePanes = new Map()
  store.touch = 0
  const journal = store.journal.bind(store)
  store.journal = function (type, detail) {
    journal(type, detail)
    if (['overseer_pane_started', 'overseer_pane_resumed', 'overseer_pane_message'].includes(type)) {
      if (detail.key) this.livePanes.set(detail.key, ++this.touch)
    }
  }
  store.livePaneKeys = function () {
    return [...this.livePanes.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key)
  }
  store.parkOverseerPane = function (record) {
    this.livePanes.delete(record.key)
    this.parked.push(record)
    this.events.push({ type: 'overseer_pane_parked', ...record })
  }
  store.takeOverseerNotes = () => []
  store.addOverseerNote = () => {}
  store.beginOverseerTurn = function (t) { this.turns.push({ type: 'started', ...t }) }
  store.endOverseerTurn = function (t) { this.turns.push({ type: 'ended', ...t }) }
  return store
}

function capHost({ cap = 2, reduction = capStore(), pane = capturingPane(), ...rest } = {}) {
  let seq = 0
  return hosted({
    reduction,
    pane,
    livePaneCap: cap,
    newSessionId: () => '11111111-2222-4333-8444-' + String(++seq).padStart(12, '0'),
    settlePollMs: 0,
    startTimeoutMs: 0,
    messageTimeoutMs: 0,
    log: () => {},
    ...rest,
  })
}

describe('the live-pane cap parks an IDLE pane (#710, ADR-0024)', () => {
  test('a pane mid-message is skipped, and the next-oldest parks instead', async () => {
    // Parking the pane the operator is waiting on would kill one turn to make
    // room for another, and neither would get an answer.
    const pane = capturingPane()
    const { host, reduction } = capHost({ cap: 2, pane })

    await host.send('console-1', 'one')
    await host.send('console-2', 'two')
    pane.busy.add('curia-console-1')
    await host.send('console-3', 'three')

    assert.deepEqual(pane.parks, ['curia-console-2'], 'the oldest IDLE one, not the oldest one')
    assert.deepEqual(reduction.parked.map((p) => p.key), ['console-2'])
    assert.equal(reduction.parked[0].reason, 'capacity')
  })

  test('a cap where every pane is working parks nothing rather than cutting an answer off', async () => {
    const pane = capturingPane()
    const { host, reduction } = capHost({ cap: 2, pane })

    await host.send('console-1', 'one')
    await host.send('console-2', 'two')
    pane.busy.add('curia-console-1')
    pane.busy.add('curia-console-2')
    await host.send('console-3', 'three')

    assert.deepEqual(pane.parks, [], 'one pane over the cap beats an answer cut in half')
    assert.deepEqual(reduction.parked, [])
    assert.equal(host.live.size, 3)
  })

  test('a conversation that already holds its pane costs nobody else theirs', async () => {
    const { host, pane } = capHost({ cap: 2 })

    await host.send('console-1', 'one')
    await host.send('console-2', 'two')
    await host.send('console-1', 'one again')

    assert.deepEqual(pane.parks, [], 'the cap is asked where a pane comes into existence, and nowhere else')
  })

  test('the cap is read per decision, so a reload moves it under a running daemon', async () => {
    let cap = 3
    const { host, pane } = capHost({ cap: () => cap })

    await host.send('console-1', 'one')
    await host.send('console-2', 'two')
    await host.send('console-3', 'three')
    assert.deepEqual(pane.parks, [])

    cap = 2
    await host.send('console-4', 'four')
    assert.equal(pane.parks.length, 2, 'the save took effect without a restart')
  })

  test('a cap that reads as nonsense falls back to the default rather than parking everything', async () => {
    const { host, pane } = capHost({ cap: () => 0 })

    await host.send('console-1', 'one')
    await host.send('console-2', 'two')
    await host.send('console-3', 'three')

    assert.deepEqual(pane.parks, [], 'zero is refused by the loader; here it must not mean "park every time"')
  })

  test('parking stops a process and changes nothing durable', async () => {
    const state = capHost({ cap: 1 })

    await state.host.send('console-1', 'one')
    const first = state.identity.calls.armed.at(-1)
    await state.host.send('console-2', 'two')
    assert.deepEqual(state.pane.parks, ['curia-console-1'])

    // The rehydration happens inside `ensure`, before any model work, on the
    // identity #701 minted once.
    await state.host.send('console-1', 'one again')
    const back = state.identity.calls.armed.at(-1)
    assert.equal(back.token, first.token, 'the durable token was never revoked')
    assert.equal(back.home, first.home)
    assert.match(state.pane.starts.at(-1).shellCmd, /--resume /, 'the resume id survived the park')
  })
})

describe('the forced park a restart already took (#710)', () => {
  test('a conversation the journal calls live whose pane is gone is parked as forced', async () => {
    const reduction = capStore()
    const pane = capturingPane()
    const { host } = capHost({ reduction, pane })

    await host.send('console-1', 'one')
    // Whatever recreated the overseer service killed the pane without this
    // process getting to write it down.
    await pane.park('curia-console-1')
    pane.parks.length = 0

    const parked = await host.reconcile()

    assert.deepEqual(parked, ['console-1'])
    assert.equal(reduction.parked.at(-1).reason, 'restart')
    assert.deepEqual(reduction.livePaneKeys(), [], 'the cap counts panes that exist')
  })

  test('a pane that survived the restart is counted again rather than forgotten', async () => {
    const reduction = capStore()
    const pane = capturingPane()
    const { host } = capHost({ reduction, pane, cap: 1 })

    await host.send('console-1', 'one')
    host.live.clear() // a fresh process, with the journal and the tmux server both intact

    const parked = await host.reconcile()

    assert.deepEqual(parked, [])
    assert.equal(host.live.size, 1, 'a boot that forgot it would park nothing until it spoke again')
  })
})

describe('a pane message opens a turn a restart can find (#710, closing #708)', () => {
  test('the turn opens before the write and closes on the completion signal', async () => {
    const reduction = capStore()
    const { host } = capHost({ reduction })

    const out = await host.deliver('console-4', 'what is on the frontier?')
    await out.completion

    const [started, ended] = reduction.turns
    assert.equal(started.type, 'started')
    assert.equal(started.prompt, 'what is on the frontier?',
      'the operator\'s words, not the composed paste — a replay re-runs the checkout pass')
    assert.equal(started.replay, false)
    assert.equal(ended.type, 'ended')
    assert.equal(ended.turn, started.turn)
  })

  test('a message curia refused to send still closes its turn', async () => {
    const reduction = capStore()
    const pane = capturingPane()
    pane.send = async () => ({ status: 'not-sent' })
    const { host } = capHost({ reduction, pane })

    await host.deliver('console-4', 'anything I missed?')

    assert.deepEqual(reduction.turns.map((t) => t.type), ['started', 'ended'],
      'a turn left open is one the next boot reads as killed and sends again')
    assert.equal(reduction.turns[1].ok, false)
  })

  test('a replayed message says so, so it is never sent a third time', async () => {
    const reduction = capStore()
    const { host } = capHost({ reduction })

    await (await host.deliver('console-4', 'stop the agent', { replay: true })).completion

    assert.equal(reduction.turns[0].replay, true)
  })

  test('a conversation with a message in flight reports busy, and stops when the signal lands', async () => {
    // The pane shows a turn, so the message is still open when `deliver`
    // returns — which is the whole point: the surface does not hold an HTTP
    // request for the length of a model's work.
    const pane = capturingPane(new Set(['curia-console-4']))
    const { host } = capHost({ pane, messageTimeoutMs: 60_000 })

    const out = await host.deliver('console-4', 'read the map')
    assert.equal(host.busy('console-4'), true, 'the replay must not land an older message behind these words')

    pane.busy.delete('curia-console-4')
    await out.completion
    assert.equal(host.busy('console-4'), false)
  })
})

// The cache's own bookkeeping, on the REAL journal. The order matters more than
// it looks: `Map.set` on a key that is already there keeps its original
// position, so plain insertion order would report a conversation speaking for
// the second time as the oldest one there. The reduction counts instead.
describe('which conversations hold a live pane (#710)', () => {
  const fresh = () => new Reduction(fs.mkdtempSync(path.join(os.tmpdir(), 'curia-livepanes-')))

  test('the order is least recently used, and it survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-livepanes-'))
    const r = new Reduction(dir)
    r.journal('overseer_pane_started', { key: 'console-1' })
    r.journal('overseer_pane_started', { key: 'console-2' })
    r.journal('overseer_pane_message', { key: 'console-1' })
    assert.deepEqual(r.livePaneKeys(), ['console-2', 'console-1'],
      'console-1 spoke last, so console-2 is the one to park')

    const back = new Reduction(dir)
    assert.deepEqual(back.livePaneKeys(), ['console-2', 'console-1'])
    assert.equal(back.hasLivePane('console-1'), true)
  })

  test('a park takes the pane off the list and leaves the conversation whole', () => {
    const r = fresh()
    r.journal('console_conversation_opened', { key: 'console-1' })
    r.bindOverseerSession('console-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    r.addOverseerNote('console-1', 'curia started 704')
    r.journal('overseer_pane_started', { key: 'console-1' })

    r.parkOverseerPane({ key: 'console-1', pane: 'curia-console-1', reason: 'capacity' })

    assert.deepEqual(r.livePaneKeys(), [])
    assert.equal(r.overseerSession('console-1'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'the resume id is the conversation, and parking stops a process')
    assert.equal(r.hasConsoleConversation('console-1'), true)
    assert.deepEqual(r.takeOverseerNotes('console-1'), ['curia started 704'],
      'the notes waited through the park')
  })

  test('a deleted conversation takes its pane record with it', () => {
    const r = fresh()
    r.journal('console_conversation_opened', { key: 'console-1' })
    r.journal('overseer_pane_started', { key: 'console-1' })
    r.journal('console_conversation_deleted', { key: 'console-1' })
    assert.deepEqual(r.livePaneKeys(), [])
  })

  test('the operator never reads about a park', () => {
    // The spec hides it: "parked conversations hidden as a runtime detail, so
    // that capacity management doesn't change the conversation model".
    const r = fresh()
    r.journal('overseer_pane_started', { key: 'console-1' })
    r.parkOverseerPane({ key: 'console-1', pane: 'curia-console-1', reason: 'capacity' })
    assert.ok(!r.recent.some((e) => e.type === 'overseer_pane_parked'))
  })
})

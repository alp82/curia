// The overseer pane host (#688). These tests drive the service seam that owns
// process hosting. The tmux adapter stays injected, so the test observes the
// same start and write calls without needing a live Docker service.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  OverseerPaneHost, overseerPaneSession, prepareOverseerPane,
} from '../src/overseerpane.mjs'
import { TimelineSurface, DEFAULT_TIMELINE_INDEX } from '../src/timeline.mjs'

const ROOT = '/work'
const REPO = '/repo'
const DATA = '/data'
const HOME = path.join(ROOT, 'cfg', 'curia-overseer', 'home')

function build({ sessions = {}, pending = {}, live = [], ready = () => 'bypass permissions' } = {}) {
  const bound = { ...sessions }
  const reserved = { ...pending }
  const calls = { started: [], sent: [], journal: [], armed: [], carried: [] }
  const minted = {}
  const liveSessions = new Set(live)
  const reduction = {
    overseerSession: (key) => bound[key] ?? null,
    pendingOverseerSession: (key) => reserved[key] ?? null,
    reserveOverseerSession: (key, id) => { reserved[key] = id },
    bindOverseerSession: (key, id) => {
      bound[key] = id
      delete reserved[key]
    },
    journal: (type, detail) => calls.journal.push({ type, ...detail }),
  }
  const host = new OverseerPaneHost({
    reduction,
    workspaceRoot: ROOT,
    repoRoot: REPO,
    dataDir: DATA,
    daemonPort: 8177,
    readyTimeoutMs: 0,
    deps: {
      ensureDir: () => {},
      ensureToken: (dataDir, key) => {
        minted[key] ??= `token-${key}-${Object.keys(minted).length}`
        return minted[key]
      },
      writeConnection: (settings) => { calls.armed.push(settings) },
      carryTranscript: (opts) => { calls.carried.push(opts) },
      hasSession: async (name) => liveSessions.has(name),
      newSession: async (opts) => { calls.started.push(opts); liveSessions.add(opts.name) },
      capturePane: async () => ready(),
      sendText: async (name, text) => {
        calls.sent.push({ name, text })
        return { status: 'confirmed' }
      },
    },
  })
  return { host, calls, bound, reserved, liveSessions, minted }
}

describe('the hosted overseer pane (#688)', () => {
  test('one operator message starts a pane under its durable conversation identity', async () => {
    const { host, calls, bound } = build()

    const out = await host.send('console-4', 'what is on the frontier?')

    assert.equal(out.session, 'curia-console-4')
    assert.match(bound['console-4'], /^[0-9a-f-]{36}$/)
    assert.deepEqual(calls.sent, [{ name: 'curia-console-4', text: 'what is on the frontier?' }])
    assert.equal(calls.started.length, 1)
    assert.equal(calls.started[0].name, 'curia-console-4')
    assert.equal(calls.started[0].cwd, path.join(HOME, bound['console-4']))
    assert.equal(calls.started[0].keepOpen, false, 'an exited docker exec is a parked conversation, not a shell')
    assert.match(calls.started[0].shellCmd, /docker exec -it curia-overseer-1/)
    assert.doesNotMatch(calls.started[0].shellCmd, /--key/)
    assert.match(calls.started[0].shellCmd, new RegExp(`--session-id ${bound['console-4']}`))
    assert.ok(calls.journal.some((e) => e.type === 'overseer_pane_started' && e.key === 'console-4'))
  })

  test('one timeline message crosses the conversation driver into the hosted pane', async () => {
    const state = build()
    const surface = new TimelineSurface({
      port: 0,
      servePort: 8444,
      index: DEFAULT_TIMELINE_INDEX,
      workspaceRoot: ROOT,
      log: () => {},
      deps: {
        identityCheck: () => null,
        journal: () => {},
        escalationsFor: () => [],
        escalationHistoryFor: () => [],
        driverFor: (session) => (session === 'curia-console-5'
          ? {
            cfgDir: path.join(ROOT, 'cfg', 'curia-overseer'),
            sessionId: state.bound['console-5'] ?? null,
            harness: 'claude',
            send: (text) => state.host.send('console-5', text),
          }
          : null),
      },
    })
    await surface.start()
    try {
      const response = await fetch(`http://127.0.0.1:${surface.port}/send`, {
        method: 'POST',
        body: JSON.stringify({ session: 'curia-console-5', text: 'show the current map' }),
      })

      assert.equal(response.status, 200)
      assert.deepEqual(state.calls.sent, [{
        name: 'curia-console-5', text: 'show the current map',
      }])
      assert.match(state.bound['console-5'], /^[0-9a-f-]{36}$/)
    } finally {
      surface.stop()
    }
  })

  test('a routine deploy rehydrates the missing pane with the same identity', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const { host, calls, liveSessions } = build({ sessions: { '981234567890': id } })

    await host.send('981234567890', 'first message after deploy')
    liveSessions.delete('curia-overseer-981234567890')
    await host.send('981234567890', 'second message after deploy')

    assert.equal(calls.started.length, 2)
    for (const start of calls.started) assert.match(start.shellCmd, new RegExp(`--resume ${id}`))
    assert.deepEqual(calls.sent.map((c) => c.text), ['first message after deploy', 'second message after deploy'])
    assert.equal(calls.journal.filter((e) => e.type === 'overseer_pane_resumed').length, 2)
  })

  test('a failed first launch retries the reserved identity as a new session', async () => {
    let composer = ''
    const state = build({ ready: () => composer })

    await assert.rejects(state.host.send('console-3', 'first try'), /did not reach/)
    const id = state.reserved['console-3']
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(state.bound['console-3'], undefined)

    state.liveSessions.delete('curia-console-3')
    composer = 'bypass permissions'
    await state.host.send('console-3', 'second try')

    assert.equal(state.bound['console-3'], id)
    assert.equal(state.reserved['console-3'], undefined)
    assert.equal(state.calls.started.length, 2)
    for (const start of state.calls.started) {
      assert.match(start.shellCmd, new RegExp(`--session-id ${id}`))
      assert.doesNotMatch(start.shellCmd, /--resume/)
    }
  })

  test('a live conversation reuses its pane without starting another process', async () => {
    const { host, calls } = build({
      sessions: { 'console-2': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      live: ['curia-console-2'],
    })

    await host.send('console-2', 'resume here')

    assert.deepEqual(calls.started, [])
    assert.deepEqual(calls.sent, [{ name: 'curia-console-2', text: 'resume here' }])
  })

  test('two first messages share one pane launch', async () => {
    const { host, calls } = build()

    await Promise.all([
      host.send('console-6', 'first'),
      host.send('console-6', 'second'),
    ])

    assert.equal(calls.started.length, 1)
    assert.deepEqual(calls.sent.map((call) => call.text), ['first', 'second'])
  })

  test('a pane is armed with its conversation\'s token before the process starts', async () => {
    const { host, calls, bound, minted } = build()

    await host.send('console-4', 'what is on the frontier?')

    assert.deepEqual(calls.armed, [{
      home: path.join(HOME, bound['console-4']),
      url: 'http://host.docker.internal:8177/overseer/mcp?conversation=console-4',
      token: minted['console-4'],
      serverName: 'curia',
      header: 'x-curia-agent-token',
    }])
    assert.deepEqual(calls.carried, [{
      configDir: path.join(ROOT, 'cfg', 'curia-overseer'),
      sessionId: bound['console-4'],
      home: path.join(HOME, bound['console-4']),
    }])
  })

  test('the conversation key never rides the pane command line', async () => {
    const { host, calls } = build()

    await host.send('981234567890', 'who is running?')

    const [start] = calls.started
    assert.doesNotMatch(start.shellCmd, /981234567890/, 'the pane learns its session id, never its destination')
    assert.doesNotMatch(start.shellCmd, /conversation=/)
  })

  test('a rehydrated pane keeps the identity it had, and gains nothing', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const { host, calls, minted } = build({ sessions: { '981234567890': id } })

    await host.send('981234567890', 'before the deploy')
    const first = calls.armed.at(-1)
    // The deploy killed the pane. The next message rehydrates it.
    host.deps.hasSession = async () => false
    await host.send('981234567890', 'after the deploy')

    const second = calls.armed.at(-1)
    assert.equal(second.token, first.token)
    assert.equal(second.token, minted['981234567890'])
    assert.equal(second.url, first.url)
    assert.equal(second.home, path.join(HOME, id), 'the project directory follows the durable session id')
  })

  test('two conversations never share one tool identity', async () => {
    const { host, calls } = build()

    await host.send('console-4', 'first')
    await host.send('console-5', 'second')

    const [one, two] = calls.armed
    assert.notEqual(one.token, two.token)
    assert.notEqual(one.home, two.home)
    assert.match(one.url, /conversation=console-4$/)
    assert.match(two.url, /conversation=console-5$/)
  })

  test('conversation sessions cannot collide with ticket agents', () => {
    assert.equal(overseerPaneSession('console-8'), 'curia-console-8')
    assert.equal(overseerPaneSession('688'), 'curia-overseer-688')
    assert.throws(() => overseerPaneSession('ticket-688'), /conversation key/)
  })

  test('the hosted process keeps overseer authority inside the shared container', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overseer-pane-'))
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
        installCredential: (workspaceRoot, configDir) => {
          credentialInstalled = true
          assert.equal(workspaceRoot, root)
          assert.equal(configDir, path.join(root, 'cfg', 'curia-overseer'))
          return null
        },
        processEnv: () => ({ PATH: '/usr/bin' }),
      },
    })

    const home = path.join(root, 'cfg', 'curia-overseer', 'home', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    assert.deepEqual(seeded, [[
      path.join(root, 'cfg', 'curia-overseer'),
      home,
      null,
      'claude',
      { sandboxed: true },
    ]])
    assert.equal(launch.cwd, home, 'the pane runs in its conversation\'s own project directory (#701)')
    assert.equal(launch.env.CLAUDE_CONFIG_DIR, path.join(root, 'cfg', 'curia-overseer'))
    assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    assert.equal(credentialInstalled, true)
    assert.deepEqual(launch.args.slice(-2), ['--resume', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
    assert.ok(launch.args.includes('overseer orders'))
    assert.ok(launch.args.includes('--dangerously-skip-permissions'))
  })
})

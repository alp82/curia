import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OverseerPaneHost, overseerPaneName, overseerPaneSession, prepareOverseerPane,
} from '../src/overseerpane.mjs'

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

  test('pane names preserve Atlas routes and isolate other identities', () => {
    assert.equal(overseerPaneName('console-12'), 'curia-console-12')
    assert.equal(overseerPaneName('688'), 'curia-overseer-688')
    assert.match(overseerPaneName('discord/thread:12'), /^curia-overseer-[a-f0-9]{16}$/)
    assert.equal(overseerPaneSession('console-8'), 'curia-console-8')
    assert.equal(overseerPaneSession('688'), 'curia-overseer-688')
    assert.throws(() => overseerPaneSession('ticket-688'), /conversation key/)
  })

  test('a deleted Atlas conversation cannot create or arm a pane', async () => {
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
          installCredential: (workspaceRoot, configDir) => {
            credentialInstalled = true
            assert.equal(workspaceRoot, root)
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

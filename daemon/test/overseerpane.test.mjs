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

describe('overseer conversations use the pane host (#688)', () => {
  test('one hosted message starts a pane with durable overseer identity', async () => {
    const reduction = storeDouble()
    const pane = paneDouble()
    const host = new OverseerPaneHost({
      reduction,
      pane,
      repoRoot: '/srv/curia',
      containerId: async () => 'overseer-container',
      newSessionId: () => UUID,
    })

    const sent = await host.send('console-7', 'Show active agents.')

    assert.deepEqual(sent, { status: 'confirmed' })
    assert.equal(reduction.overseerSession('console-7'), UUID)
    assert.equal(pane.starts[0].name, 'curia-console-7')
    assert.equal(pane.starts[0].keepOpen, false)
    assert.match(pane.starts[0].shellCmd, new RegExp('--session-id ' + UUID + '$'))
    assert.deepEqual(pane.sends, [{ name: 'curia-console-7', text: 'Show active agents.' }])
    assert.ok(reduction.events.some((event) => (
      event.type === 'overseer_pane_started' && event.session_id === UUID
    )))
  })

  test('a deploy parks the pane and the next message resumes its identity', async () => {
    const reduction = storeDouble()
    const pane = paneDouble()
    const host = new OverseerPaneHost({
      reduction,
      pane,
      repoRoot: '/srv/curia',
      containerId: async () => 'overseer-container',
      newSessionId: () => UUID,
    })

    await host.send('console-7', 'First message.')
    await host.parkForDeploy()
    await host.send('console-7', 'Second message.')

    assert.deepEqual(pane.parks, ['curia-console-7'])
    assert.equal(reduction.overseerSession('console-7'), UUID)
    assert.match(pane.starts[1].shellCmd, new RegExp('--resume ' + UUID + '$'))
  })

  test('take back can rehydrate a parked pane without sending a message', async () => {
    const reduction = storeDouble()
    reduction.bindOverseerSession('console-7', UUID)
    const pane = paneDouble()
    const host = new OverseerPaneHost({
      reduction,
      pane,
      repoRoot: '/srv/curia',
      containerId: async () => 'overseer-container',
    })

    assert.equal(await host.ensure('console-7'), 'curia-console-7')
    assert.match(pane.starts[0].shellCmd, new RegExp('--resume ' + UUID + '$'))
    assert.deepEqual(pane.sends, [])
  })

  test('pane names preserve Atlas routes and isolate other identities', () => {
    assert.equal(overseerPaneName('console-12'), 'curia-console-12')
    assert.equal(overseerPaneName('688'), 'curia-overseer-688')
    assert.match(overseerPaneName('discord/thread:12'), /^curia-overseer-[a-f0-9]{16}$/)
    assert.equal(overseerPaneSession('console-8'), 'curia-console-8')
    assert.equal(overseerPaneSession('688'), 'curia-overseer-688')
    assert.throws(() => overseerPaneSession('ticket-688'), /conversation key/)
  })

  test('a deleted Atlas conversation cannot create a pane', async () => {
    const reduction = { ...storeDouble(), hasConsoleConversation: () => false }
    const pane = paneDouble()
    const host = new OverseerPaneHost({ reduction, pane, repoRoot: '/srv/curia' })

    await assert.rejects(host.send('console-7', 'Do not send.'), /there is no conversation/)
    assert.equal(pane.starts.length, 0)
  })

  test('a failed first launch retries the reserved identity as a new session', async () => {
    const reduction = storeDouble()
    const pane = paneDouble()
    pane.ready = async () => { throw new Error('composer timeout') }
    const host = new OverseerPaneHost({
      reduction,
      pane,
      repoRoot: '/srv/curia',
      containerId: async () => 'overseer-container',
      newSessionId: () => UUID,
    })

    await assert.rejects(host.send('console-7', 'First try.'), /composer timeout/)
    assert.equal(reduction.overseerSession('console-7'), undefined)
    assert.equal(reduction.pendingOverseerSession('console-7'), UUID)
    await pane.park('curia-console-7')
    pane.ready = async (name) => { pane.readies.push(name) }
    await host.send('console-7', 'Second try.')

    assert.equal(reduction.overseerSession('console-7'), UUID)
    assert.equal(reduction.pendingOverseerSession('console-7'), undefined)
    assert.equal(pane.starts.length, 2)
    for (const start of pane.starts) {
      assert.match(start.shellCmd, new RegExp('--session-id ' + UUID + '$'))
      assert.doesNotMatch(start.shellCmd, /--resume/)
    }
  })

  test('the live pane cap parks the least recently used conversation', async () => {
    const reduction = storeDouble()
    const pane = paneDouble()
    let seq = 0
    const host = new OverseerPaneHost({
      reduction,
      pane,
      repoRoot: '/srv/curia',
      livePaneCap: 2,
      containerId: async () => 'overseer-container',
      newSessionId: () => (
        '11111111-2222-4333-8444-' + String(++seq).padStart(12, '0')
      ),
    })

    await host.send('console-1', 'One.')
    await host.send('console-2', 'Two.')
    await host.send('console-1', 'One again.')
    await host.send('console-3', 'Three.')

    assert.deepEqual(pane.parks, ['curia-console-2'])
    await host.send('console-2', 'Resume two.')
    assert.match(pane.starts.at(-1).shellCmd, /--resume 11111111-2222-4333-8444-000000000002$/)
    assert.equal(host.live.size, 2)
  })

  test('concurrent conversation opens share one capacity decision', async () => {
    const reduction = storeDouble()
    const pane = paneDouble()
    const host = new OverseerPaneHost({
      reduction,
      pane,
      repoRoot: '/srv/curia',
      livePaneCap: 2,
      containerId: async () => 'overseer-container',
      newSessionId: () => crypto.randomUUID(),
    })

    await Promise.all([host.ensure('console-1'), host.ensure('console-2'), host.ensure('console-3')])

    assert.equal(host.live.size, 2)
    assert.equal(pane.parks.length, 1)
  })

  test('the hosted process keeps overseer authority inside the shared container', () => {
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

      assert.equal(launch.cwd, path.join(root, 'cfg', 'curia-overseer', 'home'))
      assert.equal(launch.env.CLAUDE_CONFIG_DIR, path.join(root, 'cfg', 'curia-overseer'))
      assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
      assert.equal(credentialInstalled, true)
      assert.deepEqual(launch.args.slice(-2), ['--resume', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
      assert.ok(launch.args.includes('overseer orders'))
      assert.ok(launch.args.includes('--dangerously-skip-permissions'))
      assert.equal(seeded.length, 1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

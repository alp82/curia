import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  OverseerPaneHost, overseerPaneName,
} from '../src/overseerpane.mjs'

const UUID = '11111111-2222-4333-8444-555555555555'

function storeDouble() {
  const sessions = new Map()
  return {
    events: [],
    overseerSession: (key) => sessions.get(key),
    bindOverseerSession(key, session) { sessions.set(key, session) },
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
    assert.deepEqual(pane.starts, [{
      name: 'curia-console-7',
      cwd: '/srv/curia',
      role: 'overseer',
      authority: 'overseer',
      shellCmd: [
        'docker exec -it overseer-container',
        'node /srv/curia/daemon/bin/curia-overseer-pane.mjs',
        `--session ${UUID}`,
      ].join(' '),
    }])
    assert.deepEqual(pane.sends, [{ name: 'curia-console-7', text: 'Show active agents.' }])
    assert.deepEqual(pane.readies, ['curia-console-7'])
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
    assert.match(pane.starts[1].shellCmd, new RegExp(`--resume ${UUID}$`))
    assert.deepEqual(reduction.events, [{
      type: 'overseer_pane_parked',
      key: 'console-7',
      pane: 'curia-console-7',
      reason: 'deploy',
    }])
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

    const name = await host.ensure('console-7')

    assert.equal(name, 'curia-console-7')
    assert.match(pane.starts[0].shellCmd, new RegExp(`--resume ${UUID}$`))
    assert.deepEqual(pane.sends, [])
  })

  test('pane names preserve Atlas console routes and isolate other identities', () => {
    assert.equal(overseerPaneName('console-12'), 'curia-console-12')
    assert.match(overseerPaneName('discord/thread:12'), /^curia-overseer-[a-f0-9]{16}$/)
  })

  test('a deleted Atlas conversation cannot create a pane', async () => {
    const reduction = {
      ...storeDouble(),
      hasConsoleConversation: () => false,
    }
    const pane = paneDouble()
    const host = new OverseerPaneHost({ reduction, pane, repoRoot: '/srv/curia' })

    await assert.rejects(host.send('console-7', 'Do not send.'), /there is no conversation/)
    assert.equal(pane.starts.length, 0)
  })

  test('a pane that never reaches its composer does not bind a new identity', async () => {
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

    await assert.rejects(host.send('console-7', 'Do not lose this.'), /composer timeout/)
    assert.equal(reduction.overseerSession('console-7'), undefined)
  })

  test('the live pane cap parks the least recently used conversation and resumes it on demand', async () => {
    const reduction = storeDouble()
    const pane = paneDouble()
    let seq = 0
    const host = new OverseerPaneHost({
      reduction,
      pane,
      repoRoot: '/srv/curia',
      livePaneCap: 2,
      containerId: async () => 'overseer-container',
      newSessionId: () => `11111111-2222-4333-8444-${String(++seq).padStart(12, '0')}`,
    })

    await host.send('console-1', 'One.')
    await host.send('console-2', 'Two.')
    await host.send('console-1', 'One again.')
    await host.send('console-3', 'Three.')

    assert.deepEqual(pane.parks, ['curia-console-2'])
    assert.deepEqual(reduction.events, [{
      type: 'overseer_pane_parked', key: 'console-2', pane: 'curia-console-2', reason: 'capacity',
    }])
    await host.send('console-2', 'Resume two.')
    assert.match(pane.starts.at(-1).shellCmd, /--resume 11111111-2222-4333-8444-000000000002$/)
    assert.equal(host.live.size, 2)
  })

  test('surviving panes discovered after restart still obey the live pane cap', async () => {
    const reduction = storeDouble()
    const pane = paneDouble()
    for (const key of ['console-1', 'console-2', 'console-3']) {
      reduction.bindOverseerSession(key, `${UUID}-${key}`)
      await pane.start({ name: `curia-${key}` })
    }
    const host = new OverseerPaneHost({ reduction, pane, repoRoot: '/srv/curia', livePaneCap: 2 })

    await host.ensure('console-1')
    await host.ensure('console-2')
    await host.ensure('console-3')

    assert.deepEqual(pane.parks, ['curia-console-1'])
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
})

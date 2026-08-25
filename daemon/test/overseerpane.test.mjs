// The overseer pane host (#688). These tests drive the service seam that owns
// process hosting. The tmux adapter stays injected, so the test observes the
// same start and write calls without needing a live Docker service.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  OverseerPaneHost, overseerPaneSession, overseerPaneConfigDirFor, prepareOverseerPane,
} from '../src/overseerpane.mjs'

const ROOT = '/work'
const REPO = '/repo'

function build({ sessions = {}, live = [] } = {}) {
  const bound = { ...sessions }
  const calls = { started: [], sent: [], journal: [] }
  const liveSessions = new Set(live)
  const reduction = {
    overseerSession: (key) => bound[key] ?? null,
    bindOverseerSession: (key, id) => { bound[key] = id },
    journal: (type, detail) => calls.journal.push({ type, ...detail }),
  }
  const host = new OverseerPaneHost({
    reduction,
    workspaceRoot: ROOT,
    repoRoot: REPO,
    readyTimeoutMs: 0,
    deps: {
      ensureDir: () => {},
      hasSession: async (name) => liveSessions.has(name),
      newSession: async (opts) => { calls.started.push(opts); liveSessions.add(opts.name) },
      capturePane: async () => 'bypass permissions',
      sendText: async (name, text) => {
        calls.sent.push({ name, text })
        return { status: 'confirmed' }
      },
    },
  })
  return { host, calls, bound, liveSessions }
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
    assert.equal(calls.started[0].cwd, path.join(ROOT, 'cfg', 'curia-overseer', 'home'))
    assert.equal(calls.started[0].keepOpen, false, 'an exited docker exec is a parked conversation, not a shell')
    assert.match(calls.started[0].shellCmd, /docker exec -it curia-overseer-1/)
    assert.match(calls.started[0].shellCmd, new RegExp(`--session-id ${bound['console-4']}`))
    assert.ok(calls.journal.some((e) => e.type === 'overseer_pane_started' && e.key === 'console-4'))
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

  test('a live conversation reuses its pane without starting another process', async () => {
    const { host, calls } = build({
      sessions: { 'console-2': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      live: ['curia-console-2'],
    })

    await host.send('console-2', 'resume here')

    assert.deepEqual(calls.started, [])
    assert.deepEqual(calls.sent, [{ name: 'curia-console-2', text: 'resume here' }])
  })

  test('conversation sessions cannot collide with ticket agents', () => {
    assert.equal(overseerPaneSession('console-8'), 'curia-console-8')
    assert.equal(overseerPaneSession('688'), 'curia-overseer-688')
    assert.equal(overseerPaneConfigDirFor(ROOT), path.join(ROOT, 'cfg', 'curia-overseer'))
    assert.throws(() => overseerPaneSession('ticket-688'), /conversation key/)
  })

  test('the hosted process keeps overseer authority inside the shared container', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overseer-pane-'))
    const cfg = { dispatch: { workspace_root: root }, watch: [{ repo: 'alp82/curia' }] }
    const seeded = []
    const launch = prepareOverseerPane({
      cfg,
      key: 'console-1',
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      resume: true,
      deps: {
        seed: (...args) => seeded.push(args),
        systemPrompt: () => 'overseer orders',
        credential: () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'from-store' }, note: null }),
        processEnv: () => ({ PATH: '/usr/bin' }),
      },
    })

    assert.deepEqual(seeded, [[
      path.join(root, 'cfg', 'curia-overseer'),
      path.join(root, 'cfg', 'curia-overseer', 'home'),
      null,
      'claude',
      { sandboxed: true },
    ]])
    assert.equal(launch.cwd, path.join(root, 'cfg', 'curia-overseer', 'home'))
    assert.equal(launch.env.CLAUDE_CONFIG_DIR, path.join(root, 'cfg', 'curia-overseer'))
    assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, 'from-store')
    assert.deepEqual(launch.args.slice(-2), ['--resume', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
    assert.ok(launch.args.includes('overseer orders'))
    assert.ok(launch.args.includes('--dangerously-skip-permissions'))
  })
})

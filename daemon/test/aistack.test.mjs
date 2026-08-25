import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AISTACK_PACKAGE,
  AistackSync,
  aistackEnvironment,
} from '../src/aistack.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-aistack-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'cfg', 'curia-2', 'projects'), { recursive: true })
  fs.mkdirSync(path.join(root, 'cfg', 'curia-1', 'projects'), { recursive: true })
  fs.mkdirSync(path.join(root, 'home', '.codex'), { recursive: true })
  return root
}

describe('aistack recurring publication (#695)', () => {
  test('builds current Claude roots and the supported Codex root at invocation time', () => {
    const root = workspace()
    const first = aistackEnvironment(root)
    fs.mkdirSync(path.join(root, 'cfg', 'curia-3', 'projects'), { recursive: true })
    const second = aistackEnvironment(root)

    assert.equal(first.HOME, path.join(root, 'home'))
    assert.equal(first.CLAUDE_CONFIG_DIR, [
      path.join(root, 'cfg', 'curia-1'), path.join(root, 'cfg', 'curia-2'),
    ].join(','))
    assert.equal(second.CLAUDE_CONFIG_DIR.endsWith(path.join('cfg', 'curia-3')), true)
    assert.equal(second.CODEX_HOME, path.join(root, 'home', '.codex'))
  })

  test('runs the pinned sync only when a machine credential exists', async () => {
    const root = workspace()
    const calls = []
    const sync = new AistackSync({
      workspaceRoot: root,
      runProcess: async (...args) => { calls.push(args); return { stdout: '', stderr: '' } },
      now: () => Date.parse('2026-08-25T10:00:00Z'),
    })

    assert.deepEqual(await sync.tick(), { state: 'unregistered', last_attempt_at: null })
    fs.mkdirSync(path.dirname(sync.credentialFile), { recursive: true })
    fs.writeFileSync(sync.credentialFile, '{"servers":{}}\n', { mode: 0o600 })
    const status = await sync.tick()

    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'npx')
    assert.deepEqual(calls[0][1], ['-y', AISTACK_PACKAGE, 'sync', '--auto'])
    assert.equal(calls[0][2].env.CLAUDE_CONFIG_DIR.includes('curia-2'), true)
    assert.deepEqual(status, {
      state: 'ok',
      last_attempt_at: '2026-08-25T10:00:00.000Z',
      last_success_at: '2026-08-25T10:00:00.000Z',
      consecutive_failures: 0,
    })
  })

  test('a failed run is bounded and the next timer tick recovers', async () => {
    const root = workspace()
    const credential = path.join(root, 'home', '.config', 'aistack', 'credentials.json')
    fs.mkdirSync(path.dirname(credential), { recursive: true })
    fs.writeFileSync(credential, '{}\n')
    let attempts = 0
    const logs = []
    const sync = new AistackSync({
      workspaceRoot: root,
      runProcess: async () => {
        attempts += 1
        if (attempts === 1) throw new Error(`failed ${'x'.repeat(1000)}`)
        return { stdout: '', stderr: '' }
      },
      log: (line) => logs.push(line),
    })

    await sync.tick()
    assert.equal(sync.status().state, 'failed')
    assert.equal(sync.status().error.length <= 240, true)
    assert.match(sync.status().recovery, /register the machine again/)
    await sync.tick()

    assert.equal(sync.status().state, 'ok')
    assert.equal(sync.status().consecutive_failures, 0)
    assert.equal(logs.length, 2)
    assert.equal(attempts, 2)
  })
})

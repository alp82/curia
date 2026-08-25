import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  APP_ID_KEY,
  APP_KEY_FILE_KEY,
  GitHubAppSetup,
} from '../src/githubapp.mjs'

let root
let pem
const permissions = {
  contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'read', metadata: 'read',
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-app-setup-'))
  pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs1', format: 'pem' })
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

const response = (body, status = 201) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})

const paths = (name) => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return {
    daemonRoot: dir,
    stateFile: path.join(dir, 'setup.json'),
    envFile: path.join(dir, '.env.daemon'),
    keyFile: path.join(dir, '.curia-app.pem'),
  }
}

describe('GitHub App manifest setup (#694)', () => {
  test('starts with the exact permission set, no events, and expiring state', () => {
    const setup = new GitHubAppSetup({
      ...paths('start'),
      now: () => Date.parse('2026-08-25T10:00:00Z'),
      randomBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    })

    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/github-app/complete' })

    assert.equal(started.action, 'https://github.com/settings/apps/new?state=3031323334353637383961626364656630313233343536373839616263646566')
    assert.deepEqual(started.manifest.default_permissions, {
      contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'read', metadata: 'read',
    })
    assert.deepEqual(started.manifest.default_events, [])
    assert.deepEqual(started.manifest.hook_attributes, { active: false })
    assert.equal(started.manifest.public, true)
    assert.equal(started.expires_at, '2026-08-25T11:00:00.000Z')
    assert.deepEqual(setup.status(), { status: 'pending', expires_at: started.expires_at })
  })

  test('converts once, stores the key, preserves env lines, and returns no secret', async () => {
    const p = paths('success')
    fs.writeFileSync(p.envFile, 'DISCORD_BOT_TOKEN=keep-me\n# operator note\n')
    const calls = []
    const adopted = []
    const setup = new GitHubAppSetup({
      ...p,
      fetchImpl: async (url, options) => {
        calls.push({ url, options })
        return response({ id: 42, slug: 'curia-alp', pem, permissions, events: [], client_secret: 'discard', webhook_secret: 'discard' })
      },
      adopt: (facts) => adopted.push(facts),
    })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })

    const completed = await setup.complete({ code: 'temporary-code', state: started.state })

    assert.deepEqual(completed, { ok: true, app: { id: '42', slug: 'curia-alp' } })
    assert.deepEqual(setup.status(), { status: 'complete', app: { id: '42', slug: 'curia-alp' } })
    assert.equal(JSON.stringify(completed).includes('PRIVATE KEY'), false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.github.com/app-manifests/temporary-code/conversions')
    assert.equal(fs.statSync(p.keyFile).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(p.keyFile, 'utf8'), pem)
    const env = fs.readFileSync(p.envFile, 'utf8')
    assert.match(env, /DISCORD_BOT_TOKEN=keep-me/)
    assert.match(env, /# operator note/)
    assert.match(env, new RegExp(`${APP_ID_KEY}=42`))
    assert.match(env, new RegExp(`${APP_KEY_FILE_KEY}=\.curia-app\.pem`))
    assert.deepEqual(adopted, [{ appId: '42', keyFile: p.keyFile }])

    const replay = await setup.complete({ code: 'temporary-code', state: started.state })
    assert.deepEqual(replay, { ok: false, reason: 'already completed', app: { id: '42', slug: 'curia-alp' } })
    assert.equal(calls.length, 1)
  })

  test('rejects a bad or expired state before conversion', async () => {
    const p = paths('state')
    let now = Date.parse('2026-08-25T10:00:00Z')
    let calls = 0
    const setup = new GitHubAppSetup({ ...p, now: () => now, fetchImpl: async () => { calls += 1 } })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })

    await assert.rejects(setup.complete({ code: 'x', state: 'wrong' }), /state does not match/)
    now += 60 * 60 * 1000 + 1
    await assert.rejects(setup.complete({ code: 'x', state: started.state }), /expired/)
    assert.equal(calls, 0)
  })

  test('a storage failure retries storage without converting the code again', async () => {
    const p = paths('storage')
    let fetches = 0
    let stores = 0
    const setup = new GitHubAppSetup({
      ...p,
      fetchImpl: async () => { fetches += 1; return response({ id: 43, slug: 'curia-retry', pem, permissions, events: [] }) },
      store: (payload) => {
        stores += 1
        if (stores === 1) throw new Error('disk full')
        return setup.storeApp(payload)
      },
    })
    const started = setup.start({ name: 'curia-retry', redirectUrl: 'https://box.example/complete' })

    await assert.rejects(setup.complete({ code: 'one-use', state: started.state }), /disk full/)
    const completed = await setup.complete({ code: 'one-use', state: started.state })

    assert.equal(completed.ok, true)
    assert.equal(fetches, 1)
    assert.equal(stores, 2)
  })
})

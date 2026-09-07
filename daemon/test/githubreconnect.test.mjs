import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ensureLayout } from '../../cli/src/root.mjs'
import { readSecret, writeSecret } from '../../cli/src/secrets.mjs'
import { GitHubReconnect } from '../src/githubreconnect.mjs'
import { OperatorAuthorization } from '../src/githuboperator.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-reconnect-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  ensureLayout(root, { uid: process.getuid() })
  writeSecret(root, 'github-app.json', JSON.stringify({ id: '42', pem: 'fixture-key' }))
  let now = 1000
  const calls = []
  const auth = new OperatorAuthorization({ root, fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/user')
      ? { login: 'operator' } : { access_token: 'fixture-user-token' }) }
  } })
  const create = () => new GitHubReconnect({ root, authorization: auth, now: () => now })
  const input = { client_id: 'Iv1.fixture', client_secret: 'fixture-secret',
    redirect_uri: 'https://box.example:8445/api/github-app/authorize', operator: 'operator@example.com' }
  return { root, auth, calls, create, input, expire: () => { now += 600001 } }
}

test('a migrated App authorizes through the browser, preserves its key, and survives a daemon restart', async (t) => {
  const f = fixture(t)
  assert.deepEqual(f.auth.recoveryStatus(), { credentials_required: true })
  const result = f.create().start(f.input)
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false)
  const url = new URL(result.url)
  assert.equal(url.origin, 'https://github.com')
  assert.equal(url.searchParams.get('redirect_uri'), f.input.redirect_uri)
  assert.deepEqual(f.auth.recoveryStatus(), { credentials_required: false })
  const saved = JSON.parse(readSecret(f.root, 'github-app.json'))
  assert.equal(saved.pem, 'fixture-key')
  assert.equal(saved.id, '42')
  assert.equal(fs.statSync(path.join(f.root, 'secrets/github-app.json')).mode & 0o777, 0o600)
  const callback = { code: 'fixture-code', state: url.searchParams.get('state'), operator: f.input.operator }
  assert.deepEqual(await f.create().complete(callback), { login: 'operator' })
  const exchange = new URLSearchParams(f.calls[0].options.body)
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'))
  assert.equal(exchange.get('redirect_uri'), f.input.redirect_uri)
  await assert.rejects(f.create().complete(callback), /expired|another session/)
  assert.equal(f.calls.length, 2)
})

test('wrong state, another operator, expiry, and incomplete credentials cannot authorize', async (t) => {
  const f = fixture(t)
  assert.throws(() => f.create().start({ ...f.input, client_secret: '' }), /Client ID and client secret/)
  assert.equal(JSON.parse(readSecret(f.root, 'github-app.json')).client_id, undefined)
  const url = new URL(f.create().start(f.input).url)
  const callback = { code: 'fixture-code', state: url.searchParams.get('state'), operator: f.input.operator }
  await assert.rejects(f.create().complete({ ...callback, state: 'wrong' }), /another session/)
  await assert.rejects(f.create().complete({ ...callback, operator: 'another@example.com' }), /another session/)
  f.expire()
  await assert.rejects(f.create().complete(callback), /expired/)
  assert.equal(f.calls.length, 0)
})

test('an App with saved credentials starts authorization without secret entry', (t) => {
  const f = fixture(t)
  f.create().start(f.input)
  const { client_id, client_secret, ...input } = f.input
  assert.equal(new URL(f.create().start(input).url).searchParams.get('client_id'), client_id)
})

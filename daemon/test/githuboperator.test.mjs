// The operator's own GitHub authorization (#891, ADR-0031).
//
// What is pinned: the callback's code is exchanged with the App's client id
// and secret and lands `secrets/github-operator.json` owner-only, with the
// login read from `GET /user` and never a token in the answer; a token near
// its end is refreshed before it is handed out, once for concurrent callers;
// a refresh GitHub refuses, and a box with no authorization at all, refuse
// with the reinstall as the sentence; and a non-expiring token is kept as it
// is. GitHub is a fake `fetch`. Nothing here touches the network.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ensureLayout } from '../../cli/src/root.mjs'
import { readSecret, secretPath, writeSecret } from '../../cli/src/secrets.mjs'
import { APP_SECRET, appSecretJson } from '../src/githubapp.mjs'
import { OPERATOR_SECRET, OPERATOR_REFRESH_MARGIN_MS, OperatorAuthorization } from '../src/githuboperator.mjs'

let base
before(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-operator-')) })
after(() => fs.rmSync(base, { recursive: true, force: true }))

const T0 = Date.parse('2026-09-01T10:00:00Z')
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nnot read here\n-----END RSA PRIVATE KEY-----\n'

function rootWithApp(name, { client = true } = {}) {
  const root = path.join(base, name)
  ensureLayout(root, { uid: process.getuid() })
  writeSecret(root, APP_SECRET, appSecretJson({ id: '42', pem: PEM, ...(client ? { client_id: 'Iv1.client', client_secret: 'sekrit' } : {}) }))
  return root
}

// A GitHub that answers the token endpoint and `/user`. Every call is kept
// with its body, so a test can say what was exchanged with what.
function github({ tokens = [], user = { login: 'alp', id: 1 } } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null
    calls.push({ url, method: init.method ?? 'GET', auth: init.headers?.authorization ?? null, accept: init.headers?.accept ?? null, body })
    if (url === 'https://github.com/login/oauth/access_token') {
      const answer = tokens.shift() ?? { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }
      return { ok: true, status: 200, text: async () => JSON.stringify(answer) }
    }
    if (url === 'https://api.github.com/user') {
      if (typeof user === 'function') return user(init)
      return { ok: true, status: 200, text: async () => JSON.stringify(user) }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ message: `no route ${url}` }) }
  }
  return { fetchImpl, calls }
}

const expiring = (over = {}) => ({
  access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first', refresh_token_expires_in: 15811200, token_type: 'bearer', scope: '', ...over,
})

describe('the callback (#891)', () => {
  test('exchanges the code with the client id and secret, records the login, and lands the secret owner-only', async () => {
    const root = rootWithApp('exchange')
    const gh = github({ tokens: [expiring()] })
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 })

    const out = await auth.authorize({ code: 'one-use', setupAction: 'install' })

    assert.deepEqual(out, { login: 'alp' })
    const exchange = gh.calls[0]
    assert.equal(exchange.url, 'https://github.com/login/oauth/access_token')
    assert.equal(exchange.method, 'POST')
    assert.equal(exchange.accept, 'application/json')
    assert.deepEqual(exchange.body, { client_id: 'Iv1.client', client_secret: 'sekrit', code: 'one-use' })
    assert.equal(gh.calls[1].url, 'https://api.github.com/user')
    assert.equal(gh.calls[1].auth, 'Bearer ghu_first')
    const file = secretPath(root, OPERATOR_SECRET)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readSecret(root, OPERATOR_SECRET)), {
      token: 'ghu_first',
      expires_at: '2026-09-01T18:00:00.000Z',
      refresh_token: 'ghr_first',
      refresh_token_expires_at: '2027-03-03T10:00:00.000Z',
      login: 'alp',
      authorized_at: '2026-09-01T10:00:00.000Z',
    })
    assert.deepEqual(auth.status(), { authorized: true, login: 'alp', expires_at: '2026-09-01T18:00:00.000Z', authorized_at: '2026-09-01T10:00:00.000Z' })
    assert.equal(await auth.token(), 'ghu_first')
  })

  test('a code GitHub refuses stores nothing and says so in GitHub\'s words', async () => {
    const root = rootWithApp('refused')
    const gh = github({ tokens: [{ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }] })
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 })
    await assert.rejects(auth.authorize({ code: 'stale' }), /GitHub refused the authorization code.*incorrect or expired/)
    assert.equal(readSecret(root, OPERATOR_SECRET), null)
    assert.equal(auth.status().authorized, false)
  })

  test('a code shaped like anything but a code is refused before any call', async () => {
    const root = rootWithApp('shape')
    const gh = github()
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 })
    await assert.rejects(auth.authorize({ code: '../evil' }), /no usable authorization code/)
    await assert.rejects(auth.authorize({ code: '' }), /no usable authorization code/)
    assert.equal(gh.calls.length, 0)
  })

  test('an App converted before curia asked for authorization has no client secret, and the sentence says to create the App again', async () => {
    const root = rootWithApp('noclient', { client: false })
    const gh = github({ tokens: [expiring()] })
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 })
    await assert.rejects(auth.authorize({ code: 'one-use' }), /no client secret.*Create the GitHub App again/)
    assert.equal(gh.calls.length, 0)
  })

  test('a non-expiring token is kept as it is, with no expiry and no refresh token', async () => {
    const root = rootWithApp('plain')
    const gh = github({ tokens: [{ access_token: 'ghu_forever', token_type: 'bearer', scope: '' }] })
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 })
    await auth.authorize({ code: 'one-use' })
    const record = JSON.parse(readSecret(root, OPERATOR_SECRET))
    assert.equal(record.token, 'ghu_forever')
    assert.equal(record.expires_at, null)
    assert.equal(record.refresh_token, null)
    assert.equal(await auth.token(), 'ghu_forever')
    assert.equal(gh.calls.filter((c) => c.url.endsWith('access_token')).length, 1, 'nothing to refresh')
  })
})

describe('the token (#891)', () => {
  test('a box with no authorization refuses with the reinstall as the cure', async () => {
    const root = rootWithApp('none')
    const auth = new OperatorAuthorization({ root, fetchImpl: github().fetchImpl, now: () => T0 })
    await assert.rejects(auth.token(), /curia holds no GitHub authorization for you.*[Rr]einstall the App/)
    assert.deepEqual(auth.status(), { authorized: false })
  })

  test('a token inside the refresh margin is refreshed before it is handed out, once for concurrent callers, and the file is rewritten', async () => {
    const root = rootWithApp('refresh')
    let now = T0
    const gh = github({ tokens: [expiring(), expiring({ access_token: 'ghu_second', refresh_token: 'ghr_second' })] })
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => now })
    await auth.authorize({ code: 'one-use' })

    now = T0 + 28800 * 1000 - OPERATOR_REFRESH_MARGIN_MS + 1000
    const [a, b] = await Promise.all([auth.token(), auth.token()])

    assert.equal(a, 'ghu_second')
    assert.equal(b, 'ghu_second')
    const refreshes = gh.calls.filter((c) => c.body?.grant_type === 'refresh_token')
    assert.equal(refreshes.length, 1)
    assert.deepEqual(refreshes[0].body, { client_id: 'Iv1.client', client_secret: 'sekrit', grant_type: 'refresh_token', refresh_token: 'ghr_first' })
    const record = JSON.parse(readSecret(root, OPERATOR_SECRET))
    assert.equal(record.token, 'ghu_second')
    assert.equal(record.refresh_token, 'ghr_second')
    assert.equal(record.login, 'alp', 'the login survives a refresh')
    assert.equal(record.expires_at, new Date(now + 28800 * 1000).toISOString())
  })

  test('a fresh daemon reads the file the last one wrote and refreshes from it', async () => {
    const root = rootWithApp('restart')
    const gh = github({ tokens: [expiring(), expiring({ access_token: 'ghu_second' })] })
    await new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 }).authorize({ code: 'one-use' })
    const later = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 + 9 * 3600 * 1000 })
    assert.equal(await later.token(), 'ghu_second')
    assert.equal(later.status().login, 'alp')
  })

  test('a refresh GitHub refuses is the reinstall sentence, and the dead record is kept for the card to name', async () => {
    const root = rootWithApp('dead')
    const gh = github({ tokens: [expiring(), { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }] })
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 + 9 * 3600 * 1000 })
    await new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 }).authorize({ code: 'one-use' })
    await assert.rejects(auth.token(), /could not refresh your GitHub authorization.*incorrect or expired.*[Rr]einstall the App/)
    assert.equal(auth.status().login, 'alp')
  })

  test('verify proves the token on GET /user and answers the login only', async () => {
    const root = rootWithApp('verify')
    const gh = github({ tokens: [expiring()] })
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 })
    await auth.authorize({ code: 'one-use' })
    const out = await auth.verify()
    assert.deepEqual(out, { login: 'alp' })
    assert.ok(!JSON.stringify(out).includes('ghu_'), 'no token in the answer')
  })

  test('a token GitHub no longer accepts fails verify with the reinstall as the cure', async () => {
    const root = rootWithApp('revoked')
    const gh = github({
      tokens: [expiring()],
      user: (init) => (init.headers?.authorization === 'Bearer ghu_first' && gh.calls.length > 2
        ? { ok: false, status: 401, text: async () => JSON.stringify({ message: 'Bad credentials' }) }
        : { ok: true, status: 200, text: async () => JSON.stringify({ login: 'alp', id: 1 }) }),
    })
    const auth = new OperatorAuthorization({ root, fetchImpl: gh.fetchImpl, now: () => T0 })
    await auth.authorize({ code: 'one-use' })
    await assert.rejects(auth.verify(), /GitHub refused your authorization \(401\).*[Rr]einstall the App/)
  })
})

// Creating curia's GitHub App from Atlas (#694, building the spec at #684).
//
// Four things are worth pinning, and they are the four the ticket names: the
// manifest asks for the five repository permissions and no events; the state
// gate converts once and refuses a replay or a code curia never started; the
// key and the two env keys reach disk or the failure says so; and the browser
// learns none of it — the sidecar relays `code` and `state` and gets the app's
// public facts back, never the conversion response.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  AppSetup, buildManifest, upsertEnv, minterForAdopted,
  MANIFEST_PERMISSIONS, MANIFEST_ACTION, STATE_TTL_MS, MAX_PENDING, STATE_RE,
} from '../src/appsetup.mjs'
import {
  APP_ID_KEY, APP_KEY_FILE_KEY, appConfigFrom, ROLES, permissionsFor,
} from '../src/githubapp.mjs'
import { DashboardSurface, DEFAULT_DASHBOARD_INDEX } from '../src/dashboard.mjs'
import { serveHosts, LOGIN_HEADER } from '../src/identity.mjs'

const REDIRECT = 'https://box.tail1234.ts.net:8445/'

let PEM
before(() => {
  PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' })
})

// What GitHub answers a conversion with. The pem is the whole reason this flow
// lives on the daemon, so every test that has one asserts where it did NOT go.
const conversion = () => ({
  id: 4610603,
  slug: 'curia-sh',
  name: 'curia.sh',
  html_url: 'https://github.com/apps/curia-sh',
  pem: PEM,
  client_secret: 'not-a-real-secret',
})

describe('the manifest (#694)', () => {
  test('it asks for the five repository permissions of the checklist, and no more', () => {
    const m = buildManifest({ name: 'curia.sh', redirectUrl: REDIRECT })
    assert.deepEqual(m.default_permissions, {
      contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'read', metadata: 'read',
    })
    assert.equal(Object.keys(m.default_permissions).length, 5)
    // ADR-0018's one absence: an app that writes `.github/workflows/` lets any
    // agent rewrite CI, and the PATs it replaced could not do it either.
    assert.equal(m.default_permissions.workflows, undefined)
  })

  // The manifest is DERIVED from the tables in githubapp.mjs, so this fails the
  // day a permission is added to either one and the manifest does not follow —
  // which is the App created without it, and the 422 on the first token that
  // asks for it.
  test('it holds every permission any minted token can ask for, at least as wide', () => {
    const m = buildManifest({ name: 'curia.sh', redirectUrl: REDIRECT })
    const width = { read: 1, write: 2 }
    for (const role of Object.keys(ROLES)) {
      for (const [name, level] of Object.entries(permissionsFor(role))) {
        assert.ok(m.default_permissions[name], `the manifest omits ${name}, which the ${role} token asks for`)
        assert.ok(
          width[m.default_permissions[name]] >= width[level],
          `the manifest grants ${name} at ${m.default_permissions[name]}, narrower than the ${role} token's ${level}`,
        )
      }
    }
    // And nothing beyond them: a permission in the manifest that no token asks
    // for is reach curia does not use.
    const asked = new Set(Object.keys(ROLES).flatMap((r) => Object.keys(permissionsFor(r))))
    assert.deepEqual(Object.keys(m.default_permissions).filter((k) => !asked.has(k)), [])
  })

  test('it subscribes to no events and activates no webhook — curia polls', () => {
    const m = buildManifest({ name: 'curia.sh', redirectUrl: REDIRECT })
    assert.deepEqual(m.default_events, [])
    assert.equal(m.hook_attributes.active, false)
  })

  test('it is installable on any account, because one owner is an organization', () => {
    assert.equal(buildManifest({ name: 'curia.sh', redirectUrl: REDIRECT }).public, true)
  })

  test('a redirect that is not https refuses — the conversion code lands on it', () => {
    assert.throws(() => buildManifest({ name: 'curia.sh', redirectUrl: 'http://box/' }), /not an https redirect url/)
    assert.throws(() => buildManifest({ name: 'curia.sh', redirectUrl: '' }), /not an https redirect url/)
  })

  test('an app with no name refuses', () => {
    assert.throws(() => buildManifest({ name: '  ', redirectUrl: REDIRECT }), /needs a name/)
  })
})

describe('the env file upsert (#694)', () => {
  test('every other line survives, in order — the Discord token lives here too', () => {
    const before = 'DISCORD_TOKEN=abc\n# a comment\nCURIA_GH_APP_ID=1\n'
    const after = upsertEnv(before, { [APP_ID_KEY]: '7', [APP_KEY_FILE_KEY]: '.curia-app.pem' })
    assert.equal(after, 'DISCORD_TOKEN=abc\n# a comment\nCURIA_GH_APP_ID=7\nCURIA_GH_APP_KEY_FILE=.curia-app.pem\n')
  })

  test('an empty file becomes the two keys and nothing else', () => {
    assert.equal(upsertEnv('', { A: '1' }), 'A=1\n')
  })
})

describe('the conversion (#694)', () => {
  let dir
  let calls
  let answer
  let adopted
  let setup

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-appsetup-'))
    calls = []
    answer = () => ({ ok: true, status: 201, body: conversion() })
    adopted = []
    setup = makeSetup({})
  })

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function makeSetup(over) {
    return new AppSetup({
      daemonRoot: dir,
      log: () => {},
      adopt: (a) => adopted.push(a),
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init?.method })
        const a = answer()
        return { ok: a.ok, status: a.status, text: async () => JSON.stringify(a.body) }
      },
      ...over,
    })
  }

  const start = (s = setup) => s.begin({ name: 'curia.sh', redirectUrl: REDIRECT })

  test('a start mints a single-use state and points the form at GitHub', () => {
    const { state, action, manifest } = start()
    assert.match(state, STATE_RE)
    assert.equal(action, `${MANIFEST_ACTION}?state=${state}`)
    assert.equal(manifest.redirect_url, REDIRECT)
  })

  // ---- success -------------------------------------------------------------

  test('a converted manifest stores the key at 0600, writes both env keys, and adopts in process', async () => {
    const { state } = start()
    const out = await setup.convert({ code: 'gh-code-1', state })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.github.com/app-manifests/gh-code-1/conversions')
    assert.equal(calls[0].method, 'POST')

    const keyFile = path.join(dir, '.curia-app.pem')
    assert.equal(fs.readFileSync(keyFile, 'utf8'), PEM)
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'curia\'s one durable secret is not world-readable')

    const env = fs.readFileSync(path.join(dir, '.env.daemon'), 'utf8')
    assert.match(env, new RegExp(`^${APP_ID_KEY}=4610603$`, 'm'))
    assert.match(env, new RegExp(`^${APP_KEY_FILE_KEY}=.curia-app.pem$`, 'm'))
    // The two keys the next boot reads, read the way the next boot reads them.
    const cfg = appConfigFrom({ [APP_ID_KEY]: '4610603', [APP_KEY_FILE_KEY]: '.curia-app.pem' }, dir)
    assert.equal(cfg.keyFile, keyFile)

    // In process, so the operator's next act is the install and not a restart.
    assert.equal(adopted.length, 1)
    assert.equal(adopted[0].appId, '4610603')
    assert.equal(minterForAdopted(adopted[0]).appId, '4610603')

    // What the browser is allowed to learn: the app's own settings page, and
    // where to install it. Nothing from the conversion body.
    assert.deepEqual(out, {
      ok: true,
      app_id: '4610603',
      slug: 'curia-sh',
      name: 'curia.sh',
      bot_login: 'curia-sh[bot]',
      html_url: 'https://github.com/apps/curia-sh',
      install_url: 'https://github.com/apps/curia-sh/installations/new',
      key_file: keyFile,
    })
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE KEY|client_secret/)
  })

  // ---- replay --------------------------------------------------------------

  test('the same state converts once — a replayed redirect is refused and asks GitHub nothing', async () => {
    const { state } = start()
    await setup.convert({ code: 'gh-code-1', state })
    await assert.rejects(
      setup.convert({ code: 'gh-code-1', state }),
      (e) => e.refusal === true && /already converted/.test(e.message))
    assert.equal(calls.length, 1, 'a replay must not reach GitHub at all')
    assert.equal(adopted.length, 1)
  })

  test('a replay that arrives while the first conversion is still in flight is refused too', async () => {
    let release
    answer = () => ({ ok: true, status: 201, body: conversion() })
    const slow = makeSetup({
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init?.method })
        await new Promise((r) => { release = r })
        return { ok: true, status: 201, text: async () => JSON.stringify(conversion()) }
      },
    })
    const { state } = start(slow)
    const first = slow.convert({ code: 'gh-code-1', state })
    await assert.rejects(slow.convert({ code: 'gh-code-1', state }), /already converted/)
    release()
    await first
    assert.equal(calls.length, 1)
  })

  // ---- bad state -----------------------------------------------------------

  test('a code with a state curia never minted is refused before any call', async () => {
    start()
    const forged = 'f'.repeat(64)
    await assert.rejects(
      setup.convert({ code: 'gh-code-1', state: forged }),
      (e) => e.refusal === true && /did not start on this box/.test(e.message))
    assert.equal(calls.length, 0)
  })

  test('a code with no state at all is refused — a plain redirect is forgeable', async () => {
    await assert.rejects(setup.convert({ code: 'gh-code-1', state: '' }), /no state curia minted/)
    await assert.rejects(setup.convert({ code: 'gh-code-1', state: 'nope' }), /no state curia minted/)
    assert.equal(calls.length, 0)
  })

  test('a state that lapsed is a state curia no longer holds', async () => {
    let clock = 1_000
    const aged = makeSetup({ now: () => clock })
    const { state } = start(aged)
    clock += STATE_TTL_MS + 1
    await assert.rejects(aged.convert({ code: 'gh-code-1', state }), /or it lapsed/)
    assert.equal(calls.length, 0)
  })

  test('a state good for a code GitHub no longer knows says so in the operator\'s words', async () => {
    const { state } = start()
    answer = () => ({ ok: false, status: 404, body: { message: 'Not Found' } })
    await assert.rejects(
      setup.convert({ code: 'gh-code-1', state }),
      (e) => e.refusal === true && /good for one hour and for one conversion/.test(e.message))
    assert.equal(adopted.length, 0)
  })

  test('open setups are bounded', () => {
    for (let i = 0; i < MAX_PENDING; i += 1) start()
    assert.throws(() => start(), /are already open/)
  })

  // ---- failed storage ------------------------------------------------------

  test('a key that cannot be stored refuses the setup, adopts nothing, and names the file', async () => {
    const blocked = makeSetup({ keyFile: path.join(dir, 'no-such-dir', 'app.pem') })
    const { state } = start(blocked)
    await assert.rejects(
      blocked.convert({ code: 'gh-code-1', state }),
      (e) => !e.refusal && /could not store its private key at .*no-such-dir/.test(e.message)
        && /delete the app on GitHub/.test(e.message))
    assert.equal(adopted.length, 0, 'a daemon must not run on an app whose key it could not keep')
  })

  test('an env file that cannot be written names both halves — the key is on disk and the keys are not', async () => {
    const blocked = makeSetup({ envFile: path.join(dir, 'no-such-dir', '.env.daemon') })
    const { state } = start(blocked)
    await assert.rejects(
      blocked.convert({ code: 'gh-code-1', state }),
      (e) => !e.refusal && new RegExp(`key is stored at .*\\.curia-app\\.pem.*${APP_ID_KEY}`, 's').test(e.message))
    assert.equal(adopted.length, 0)
  })

  test('a conversion carrying no key stores nothing', async () => {
    const { state } = start()
    answer = () => ({ ok: true, status: 201, body: { id: 7, slug: 'x' } })
    await assert.rejects(setup.convert({ code: 'gh-code-1', state }), /nothing to store/)
    assert.equal(fs.existsSync(path.join(dir, '.curia-app.pem')), false)
  })

  test('a private key GitHub sent that curia cannot read is refused before anything is written', async () => {
    const { state } = start()
    answer = () => ({ ok: true, status: 201, body: { ...conversion(), pem: 'not a pem' } })
    await assert.rejects(setup.convert({ code: 'gh-code-1', state }), /cannot read/)
    assert.equal(fs.existsSync(path.join(dir, '.curia-app.pem')), false)
    assert.equal(adopted.length, 0)
  })
})

// ---------------------------------------------------------------------------
// the relay (#694)
// ---------------------------------------------------------------------------
//
// A real sidecar in front of a real AppSetup, with a fake GitHub behind it. The
// one thing being proved is the boundary: what crosses the browser wire in each
// direction, and what does not.

describe('the sidecar relays code and state, and nothing else (#694)', () => {
  const SERVE_PORT = 8445
  const ALLOW = ['alp@example.com']
  const HOST = 'box.tail1234.ts.net:8445'
  const served = (extra = {}) => ({ host: HOST, [LOGIN_HEADER]: 'alp@example.com', ...extra })
  const writes = (extra = {}) => served({
    origin: `https://${HOST}`, 'content-type': 'application/json', ...extra,
  })

  let dir
  let surface
  let daemon
  let setup
  let bodies
  let ghCalls

  function req(port, p, { headers = {}, method = 'GET', body = null } = {}) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, setHost: false }, (res) => {
        let buf = ''
        res.on('data', (d) => { buf += d })
        res.on('end', () => resolve({ status: res.statusCode, text: buf }))
      })
      r.on('error', reject)
      if (body !== null) r.write(typeof body === 'string' ? body : JSON.stringify(body))
      r.end()
    })
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-appsetup-relay-'))
    bodies = []
    ghCalls = []
    setup = new AppSetup({
      daemonRoot: dir,
      log: () => {},
      fetchImpl: async (url) => {
        ghCalls.push(url)
        return { ok: true, status: 201, text: async () => JSON.stringify(conversion()) }
      },
    })
    // A stand-in daemon holding the real flow, so the conversion is proved to
    // happen on the far side of the browser's wire.
    daemon = http.createServer(async (r, res) => {
      let raw = ''
      for await (const c of r) raw += c
      const body = raw ? JSON.parse(raw) : {}
      bodies.push({ url: r.url, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      try {
        if (r.url === '/app/setup') return res.end(JSON.stringify(setup.begin({ name: body.name, redirectUrl: body.redirect_url })))
        if (r.url === '/app/convert') return res.end(JSON.stringify(await setup.convert(body)))
        // #705: the install reading, which is public facts and a watch list.
        if (r.url === '/app/installs') {
          return res.end(JSON.stringify({
            configured: true, app_id: '9', slug: 'curia-sh', bot_login: 'curia-sh[bot]',
            owners: [{ owner: 'alp82', installed: true, install_url: 'https://github.com/apps/curia-sh/installations/new' }],
          }))
        }
      } catch (e) {
        return res.end(JSON.stringify({ ok: false, error: e.message }))
      }
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((done) => daemon.listen(0, '127.0.0.1', done))

    surface = new DashboardSurface({
      port: 0,
      servePort: SERVE_PORT,
      index: DEFAULT_DASHBOARD_INDEX,
      allow: ALLOW,
      pollIntervalS: 5,
      daemonPort: daemon.address().port,
      log: () => {},
      deps: {
        fetchOverview: async () => ({ daemon: { port: 4271 }, agents: [] }),
        assertServe: async () => {},
        serveOff: async () => {},
        attachBase: async () => 'box.tail1234.ts.net',
        tailnetSelf: async () => ({ dnsName: 'box.tail1234.ts.net', ips: ['100.98.118.33'] }),
      },
    })
    await surface.start()
    await surface.resolveHosts()
    assert.deepEqual([...surface.hosts].sort(), [...serveHosts({ dnsName: 'box.tail1234.ts.net.', ips: ['100.98.118.33'], servePort: SERVE_PORT })].sort())
  })

  afterEach(() => {
    surface?.stop()
    daemon?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function begin() {
    const res = await req(surface.port, '/api/appsetup/begin', {
      method: 'POST', headers: writes(), body: { name: 'curia.sh' },
    })
    assert.equal(res.status, 200)
    return JSON.parse(res.text)
  }

  test('the start hands the browser a manifest and a state, and names the redirect itself', async () => {
    const out = await begin()
    assert.match(out.state, STATE_RE)
    assert.deepEqual(out.manifest.default_permissions, { ...MANIFEST_PERMISSIONS })
    // The redirect is composed from curia's own records, never from the body.
    assert.equal(bodies[0].body.redirect_url, 'https://box.tail1234.ts.net:8445/')
    assert.equal(out.manifest.redirect_url, 'https://box.tail1234.ts.net:8445/')
  })

  test('a browser-named redirect is not a field this surface forwards', async () => {
    await req(surface.port, '/api/appsetup/begin', {
      method: 'POST', headers: writes(), body: { name: 'curia.sh', redirect_url: 'https://evil.example.com/' },
    })
    assert.equal(bodies[0].body.redirect_url, 'https://box.tail1234.ts.net:8445/')
  })

  test('the convert relays exactly code and state, and the browser gets no key back', async () => {
    const { state } = await begin()
    const res = await req(surface.port, '/api/appsetup/convert', {
      method: 'POST', headers: writes(), body: { code: 'gh-code-1', state, extra: 'ignored' },
    })
    assert.equal(res.status, 200)
    assert.equal(ghCalls.length, 1)
    assert.deepEqual(Object.keys(bodies[1].body).sort(), ['code', 'state'])

    // The one assertion this ticket exists for.
    assert.doesNotMatch(res.text, /PRIVATE KEY|client_secret/)
    const out = JSON.parse(res.text)
    assert.equal(out.pem, undefined)
    assert.equal(out.bot_login, 'curia-sh[bot]')
    assert.equal(out.install_url, 'https://github.com/apps/curia-sh/installations/new')
    // And the key went where the daemon put it, which is not on this wire.
    assert.equal(fs.readFileSync(path.join(dir, '.curia-app.pem'), 'utf8'), PEM)
  })

  test('a replayed convert answers the refusal, not a second conversion', async () => {
    const { state } = await begin()
    await req(surface.port, '/api/appsetup/convert', { method: 'POST', headers: writes(), body: { code: 'c', state } })
    const again = await req(surface.port, '/api/appsetup/convert', { method: 'POST', headers: writes(), body: { code: 'c', state } })
    assert.equal(again.status, 409)
    assert.match(again.text, /already converted/)
    assert.equal(ghCalls.length, 1)
  })

  test('a state this surface cannot have minted never reaches the daemon', async () => {
    const res = await req(surface.port, '/api/appsetup/convert', {
      method: 'POST', headers: writes(), body: { code: 'c', state: 'not-a-state' },
    })
    assert.equal(res.status, 409)
    assert.match(res.text, /is not a setup state curia minted/)
    assert.equal(bodies.length, 0)
  })

  test('a conversion code shaped like a URL is refused rather than composed into one', async () => {
    const { state } = await begin()
    const res = await req(surface.port, '/api/appsetup/convert', {
      method: 'POST', headers: writes(), body: { code: '../../evil', state },
    })
    assert.equal(res.status, 409)
    assert.match(res.text, /is not a GitHub conversion code/)
    assert.equal(ghCalls.length, 0)
  })

  // #705. Atlas presses this after the operator installs the app on GitHub, and
  // the whole of what it sends is the press: the watch list is the daemon's and
  // the browser names no owner.
  test('the re-read carries no field at all, and answers the same public shape', async () => {
    const res = await req(surface.port, '/api/appsetup/refresh', { method: 'POST', headers: writes(), body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(bodies.map((b) => b.url), ['/app/installs'])
    assert.deepEqual(bodies[0].body, {})
    const out = JSON.parse(res.text)
    assert.equal(out.owners[0].owner, 'alp82')
    assert.doesNotMatch(res.text, /PRIVATE KEY|client_secret/)
  })

  test('all three routes are writes: no Origin, no setup', async () => {
    for (const route of ['/api/appsetup/begin', '/api/appsetup/convert', '/api/appsetup/refresh']) {
      const res = await req(surface.port, route, {
        method: 'POST', headers: served({ 'content-type': 'application/json' }), body: { name: 'curia.sh' },
      })
      assert.equal(res.status, 403)
      assert.match(res.text, /must carry an Origin header/)
    }
    assert.equal(bodies.length, 0)
  })
})

// Creating curia's GitHub App from the Curia app (#694, one stack since #764).
//
// Four things are worth pinning: the manifest asks for the five repository
// permissions and no events, and holds every permission any minted token can
// ask for; the state gate converts once and refuses a replay, a forged state,
// or a code curia never started; the key and the two env keys reach disk or
// the failure says so; and the browser learns none of it. The sidecar half of
// that last one lives in dashboard.test.mjs, in front of a fake daemon.

import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  APP_ID_KEY,
  APP_KEY_FILE_KEY,
  APP_SECRET,
  APP_SETUP_STATE_RE,
  GitHubAppSetup,
  MANIFEST_PERMISSIONS,
  ROLES,
  appConfigFromRoot,
  appNameTaken,
  assertManifest,
  minterFrom,
  suggestedAppName,
} from '../src/githubapp.mjs'
import { ensureLayout } from '../../cli/src/root.mjs'
import { secretPath } from '../../cli/src/secrets.mjs'

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

const converted = (over = {}) => ({
  id: 42, slug: 'curia-alp', pem, permissions, events: [], client_id: 'Iv1.client', client_secret: 'sekrit', webhook_secret: 'discard', ...over,
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

const WIDTH = { read: 0, write: 1 }

describe('the manifest (#694)', () => {
  test('it asks for the five repository permissions of the checklist, and no more', () => {
    assert.deepEqual(MANIFEST_PERMISSIONS, permissions)
    assert.equal('workflows' in MANIFEST_PERMISSIONS, false, 'a workflow write is a path from a ticket to the next CI run\'s secrets')
  })

  // An installation token may scope DOWN from what the app holds and never
  // up, so the app must hold the union of every set the minter asks for.
  test('it holds every permission any minted token can ask for, at least as wide', () => {
    for (const [role, set] of Object.entries(ROLES)) {
      for (const [name, level] of Object.entries(set)) {
        assert.ok(name in MANIFEST_PERMISSIONS, `${role} asks for ${name}, which the manifest never requested`)
        assert.ok(WIDTH[MANIFEST_PERMISSIONS[name]] >= WIDTH[level], `${role} asks for ${name}:${level}, wider than the manifest's ${MANIFEST_PERMISSIONS[name]}`)
      }
    }
  })

  test('starts with the exact permission set, no events, and expiring state', () => {
    const setup = new GitHubAppSetup({
      ...paths('start'),
      now: () => Date.parse('2026-08-25T10:00:00Z'),
      randomBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    })

    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/github-app/complete' })

    assert.equal(started.action, 'https://github.com/settings/apps/new?state=3031323334353637383961626364656630313233343536373839616263646566')
    assert.match(started.state, APP_SETUP_STATE_RE)
    assert.deepEqual(started.manifest.default_permissions, permissions)
    assert.deepEqual(started.manifest.default_events, [])
    // GitHub requires `hook_attributes.url` whenever the object is present,
    // even with `active: false` (#891). Curia listens for no webhook, so the
    // manifest carries no `hook_attributes` at all.
    assert.equal('hook_attributes' in started.manifest, false, 'no webhook block, because GitHub would demand a URL inside it')
    assert.equal(started.manifest.url, 'https://box.example')
    assert.equal(started.manifest.redirect_url, 'https://box.example/github-app/complete')
    assert.equal(started.manifest.public, true, 'one owner is an organization')
    assert.equal(started.expires_at, '2026-08-25T11:00:00.000Z')
    assert.deepEqual(setup.status(), { status: 'pending', expires_at: started.expires_at })
  })

  // Installing the App is also the operator's authorization (#891, ADR-0031):
  // the manifest asks GitHub to run the user authorization on install and
  // on every update, and names the callback the code comes back to. No
  // `setup_url`: GitHub sends the operator to the callback instead when the
  // authorization is requested, and a manifest that names both is refused.
  test('it asks for the operator authorization on install, on update, and names the callback (#891)', () => {
    const setup = new GitHubAppSetup(paths('oauth'))
    const started = setup.start({ name: 'curia.sh', redirectUrl: 'https://box.example/api/github-app/complete' })
    assert.equal(started.manifest.request_oauth_on_install, true)
    assert.equal(started.manifest.setup_on_update, true)
    assert.deepEqual(started.manifest.callback_urls, ['https://box.example/api/github-app/authorize'])
    assert.equal('setup_url' in started.manifest, false)
    assert.throws(() => assertManifest({ ...started.manifest, callback_urls: [] }), /callback_urls/)
    assert.throws(() => assertManifest({ ...started.manifest, request_oauth_on_install: false }), /request_oauth_on_install/)
  })

  test('a manifest missing a URL GitHub requires is refused by name before any handoff (#891)', () => {
    const good = {
      name: 'curia-alp', url: 'https://box.example', redirect_url: 'https://box.example/complete',
      callback_urls: ['https://box.example/authorize'], request_oauth_on_install: true,
    }
    assert.doesNotThrow(() => assertManifest(good))
    assert.throws(() => assertManifest({ ...good, url: '' }), /manifest carries no "url"/)
    assert.throws(() => assertManifest({ ...good, url: undefined }), /manifest carries no "url"/)
    assert.throws(() => assertManifest({ ...good, hook_attributes: { active: false } }), /"hook_attributes\.url"/)
    assert.doesNotThrow(() => assertManifest({ ...good, hook_attributes: { url: 'https://box.example/events', active: false } }))
  })

  test('the setup action identity survives the GitHub redirect and daemon restart', () => {
    const setup = new GitHubAppSetup(paths('action'))
    setup.start({
      name: 'curia-alp', redirectUrl: 'https://box.example/github-app/complete',
      actionId: 'app-github-app-setup',
    })

    const restarted = new GitHubAppSetup(paths('action'))
    assert.equal(restarted.status().action_id, 'app-github-app-setup')
  })

  test('a redirect that is not https, or that carries more than a path, refuses', () => {
    const setup = new GitHubAppSetup(paths('redirect'))
    assert.throws(() => setup.start({ name: 'x', redirectUrl: 'http://box.example/complete' }), /must use HTTPS/)
    assert.throws(() => setup.start({ name: 'x', redirectUrl: 'https://box.example/complete?next=evil' }), /no query or fragment/)
    assert.throws(() => setup.start({ name: 'x', redirectUrl: 'https://u:p@box.example/complete' }), /no credentials/)
    assert.throws(() => setup.start({ name: '', redirectUrl: 'https://box.example/complete' }), /1 to 34 characters/)
  })
})

describe('the conversion (#694)', () => {
  test('converts once, stores the key, preserves env lines, and returns no secret', async () => {
    const p = paths('success')
    fs.writeFileSync(p.envFile, 'DISCORD_BOT_TOKEN=keep-me\n# operator note\n')
    const calls = []
    const adopted = []
    const setup = new GitHubAppSetup({
      ...p,
      fetchImpl: async (url, options) => {
        calls.push({ url, options })
        return response(converted())
      },
      adopt: (facts) => adopted.push(facts),
    })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })

    const completed = await setup.complete({ code: 'temporary-code', state: started.state })

    assert.deepEqual(completed, { ok: true, app: { id: '42', slug: 'curia-alp' }, screen: 'settings' })
    assert.doesNotMatch(fs.readFileSync(p.envFile, 'utf8'), /sekrit/, 'the source deployment keeps its host login and stores no client secret')
    assert.deepEqual(setup.status(), { status: 'complete', app: { id: '42', slug: 'curia-alp' } })
    assert.doesNotMatch(JSON.stringify(completed), /PRIVATE KEY|client_secret|webhook_secret/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.github.com/app-manifests/temporary-code/conversions')
    assert.equal(fs.statSync(p.keyFile).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(p.keyFile, 'utf8'), pem)
    const env = fs.readFileSync(p.envFile, 'utf8')
    assert.match(env, /DISCORD_BOT_TOKEN=keep-me/)
    assert.match(env, /# operator note/)
    assert.match(env, new RegExp(`${APP_ID_KEY}=42`))
    assert.match(env, new RegExp(`${APP_KEY_FILE_KEY}=\\.curia-app\\.pem`))
    assert.deepEqual(adopted, [{ appId: '42', keyFile: p.keyFile }])
    assert.equal(fs.existsSync(setup.secretFile), false, 'the conversion response does not outlive the setup')

    const replay = await setup.complete({ code: 'temporary-code', state: started.state })
    assert.deepEqual(replay, { ok: false, reason: 'already completed', app: { id: '42', slug: 'curia-alp' }, screen: 'settings' })
    assert.equal(calls.length, 1, 'a replay must not reach GitHub at all')
    assert.equal(adopted.length, 1)
  })

  // Under an installation root (#867) the converted app is one owner-only
  // secret file and no env file is touched: the key never leaves `secrets/`.
  // #875: the Setup screen starts the same flow the Settings section does,
  // and the redirect back has to land on the screen that started it. The
  // screen is part of the record, so a daemon restart mid-trip keeps it.
  test('the screen that started the setup rides the record and comes back with the completion', async () => {
    const setup = new GitHubAppSetup({ ...paths('screen'), fetchImpl: async () => response(converted()) })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete', screen: 'setup' })
    const completed = await new GitHubAppSetup({ ...paths('screen'), fetchImpl: async () => response(converted()) })
      .complete({ code: 'temporary-code', state: started.state })
    assert.equal(completed.screen, 'setup')
    assert.equal((await setup.complete({ code: 'temporary-code', state: started.state })).screen, 'setup', 'a replay lands on the same screen')

    const plain = new GitHubAppSetup({ ...paths('screen-default'), fetchImpl: async () => response(converted()) })
    const settings = plain.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })
    assert.equal((await plain.complete({ code: 'temporary-code', state: settings.state })).screen, 'settings')
    assert.throws(() => plain.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete', screen: 'javascript:alert(1)' }), /screen/)
  })

  test('under an installation root the app lands in secrets/github-app.json, and nothing is written beside the daemon', async () => {
    const p = paths('root')
    const installRoot = path.join(root, 'install-root')
    ensureLayout(installRoot, { uid: process.getuid() })
    const adopted = []
    const setup = new GitHubAppSetup({
      root: installRoot,
      stateFile: path.join(installRoot, 'state', 'github-app-setup.json'),
      secretFile: path.join(installRoot, 'run', 'github-app-setup.conversion'),
      fetchImpl: async () => response(converted()),
      adopt: (facts) => adopted.push(facts),
    })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })

    const completed = await setup.complete({ code: 'temporary-code', state: started.state })

    assert.equal(completed.ok, true)
    const secret = secretPath(installRoot, APP_SECRET)
    assert.equal(fs.statSync(secret).mode & 0o777, 0o600)
    // The client id and secret ride beside the key (#891): the operator
    // authorization is exchanged and refreshed with them.
    assert.deepEqual(JSON.parse(fs.readFileSync(secret, 'utf8')), { id: '42', pem, client_id: 'Iv1.client', client_secret: 'sekrit' })
    assert.deepEqual(appConfigFromRoot(installRoot).client, { id: 'Iv1.client', secret: 'sekrit' })
    assert.deepEqual(adopted, [{ appId: '42', keyFile: secret }])
    assert.equal(fs.existsSync(p.envFile), false, 'no env file is written under a root')
    assert.equal(fs.existsSync(p.keyFile), false)
    assert.equal(fs.existsSync(setup.secretFile), false, 'the conversion response does not outlive the setup')
    assert.deepEqual(fs.readdirSync(path.join(installRoot, 'run')), [], 'run/ holds nothing once the setup is complete')
    assert.equal(minterFrom({ root: installRoot }).appId, '42', 'the boot reads the same file back')
  })

  test('a replay that arrives while the first conversion is still in flight is refused too', async () => {
    const p = paths('inflight')
    let release
    let calls = 0
    const setup = new GitHubAppSetup({
      ...p,
      fetchImpl: async () => {
        calls += 1
        await new Promise((r) => { release = r })
        return response(converted())
      },
    })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })
    const first = setup.complete({ code: 'one-use', state: started.state })
    await new Promise((r) => setImmediate(r))
    await assert.rejects(setup.complete({ code: 'one-use', state: started.state }), /being converted right now/)
    release()
    assert.equal((await first).ok, true)
    assert.equal(calls, 1)
  })

  test('a forged, absent, or mismatched state is refused before any call', async () => {
    const p = paths('state')
    let calls = 0
    const setup = new GitHubAppSetup({ ...p, fetchImpl: async () => { calls += 1 } })
    // Before any setup exists, a state-shaped forgery finds no record.
    await assert.rejects(setup.complete({ code: 'x', state: 'f'.repeat(64) }), /no GitHub App setup in progress/)
    setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })
    await assert.rejects(setup.complete({ code: 'x', state: '' }), /no state curia minted/)
    await assert.rejects(setup.complete({ code: 'x', state: 'nope' }), /no state curia minted/)
    await assert.rejects(setup.complete({ code: 'x', state: 'f'.repeat(64) }), /state does not match/)
    assert.equal(calls, 0)
  })

  test('an expired state, and a code shaped like a path, are refused before any call', async () => {
    const p = paths('expiry')
    let now = Date.parse('2026-08-25T10:00:00Z')
    let calls = 0
    const setup = new GitHubAppSetup({ ...p, now: () => now, fetchImpl: async () => { calls += 1 } })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })

    await assert.rejects(setup.complete({ code: '../../evil', state: started.state }), /no usable conversion code/)
    await assert.rejects(setup.complete({ code: '', state: started.state }), /no usable conversion code/)
    now += 60 * 60 * 1000 + 1
    await assert.rejects(setup.complete({ code: 'x', state: started.state }), /expired/)
    assert.equal(setup.status().status, 'expired')
    assert.equal(calls, 0)
  })

  test('a code GitHub no longer knows says so in the operator\'s words, and the setup stays open for a retry', async () => {
    const p = paths('gone')
    const answers = [response({ message: 'Not Found' }, 404), response(converted())]
    const setup = new GitHubAppSetup({ ...p, fetchImpl: async () => answers.shift() })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })
    await assert.rejects(setup.complete({ code: 'stale', state: started.state }), /good for one hour and for one conversion/)
    assert.equal(setup.status().status, 'pending')
    assert.equal((await setup.complete({ code: 'fresh', state: started.state })).ok, true)
  })

  test('a conversion carrying no key, or wider permissions, stores nothing', async () => {
    const p = paths('nokey')
    let answer = { id: 7, slug: 'x' }
    const setup = new GitHubAppSetup({ ...p, fetchImpl: async () => response(answer) })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })
    await assert.rejects(setup.complete({ code: 'a', state: started.state }), /nothing to store/)
    answer = converted({ permissions: { ...permissions, workflows: 'write' } })
    await assert.rejects(setup.complete({ code: 'b', state: started.state }), /permissions that differ/)
    answer = converted({ events: ['push'] })
    await assert.rejects(setup.complete({ code: 'c', state: started.state }), /webhook events/)
    assert.equal(fs.existsSync(p.keyFile), false)
    assert.equal(fs.existsSync(p.envFile), false)
  })

  test('a private key GitHub sent that curia cannot read is refused before anything is written', async () => {
    const p = paths('badpem')
    const adopted = []
    const setup = new GitHubAppSetup({
      ...p,
      fetchImpl: async () => response(converted({ pem: 'not a pem' })),
      adopt: (facts) => adopted.push(facts),
    })
    const started = setup.start({ name: 'curia-alp', redirectUrl: 'https://box.example/complete' })
    await assert.rejects(setup.complete({ code: 'a', state: started.state }), /cannot read/)
    assert.equal(fs.existsSync(p.keyFile), false)
    assert.equal(fs.existsSync(`${p.keyFile}.candidate`), false, 'no candidate is left behind')
    assert.equal(fs.existsSync(p.envFile), false)
    assert.equal(adopted.length, 0, 'a daemon must not run on an app whose key it could not keep')
  })

  test('a storage failure retries storage without converting the code again', async () => {
    const p = paths('storage')
    let fetches = 0
    let stores = 0
    const setup = new GitHubAppSetup({
      ...p,
      fetchImpl: async () => { fetches += 1; return response(converted({ id: 43, slug: 'curia-retry' })) },
      store: (payload) => {
        stores += 1
        if (stores === 1) throw new Error('disk full')
        return setup.storeApp(payload)
      },
    })
    const started = setup.start({ name: 'curia-retry', redirectUrl: 'https://box.example/complete' })

    await assert.rejects(setup.complete({ code: 'one-use', state: started.state }), /disk full/)
    assert.equal(setup.status().status, 'pending')
    const completed = await setup.complete({ code: 'one-use', state: started.state })

    assert.equal(completed.ok, true)
    assert.equal(fetches, 1)
    assert.equal(stores, 2)
  })
})

// The default name is `curia.sh` (#891), and an App name is unique across the
// whole of GitHub. The taken name is read from GitHub before the handoff:
// GitHub's consent page would say it after the operator has left curia, and
// the card can then offer `curia.sh-<node>` prefilled.
describe('the App name (#891)', () => {
  const answer = (status, body) => async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) })

  test('a name GitHub already knows is taken, and the answer names the App GitHub has', async () => {
    const taken = await appNameTaken('curia.sh', { fetchImpl: answer(200, { slug: 'curia-sh', name: 'curia.sh', owner: { login: 'alp82' }, html_url: 'https://github.com/apps/curia-sh' }) })
    assert.deepEqual(taken, { taken: true, slug: 'curia-sh', name: 'curia.sh', owner: 'alp82', url: 'https://github.com/apps/curia-sh' })
  })

  test('a name GitHub does not know is free, and a GitHub that does not answer is not a refusal', async () => {
    assert.deepEqual(await appNameTaken('curia.sh-curia-ubuntu', { fetchImpl: answer(404, { message: 'Not Found' }) }), { taken: false })
    assert.deepEqual(await appNameTaken('curia.sh', { fetchImpl: async () => { throw new Error('ECONNRESET') } }), { taken: false, unknown: 'ECONNRESET' })
  })

  test('the slug is asked for the way GitHub builds one', async () => {
    const asked = []
    await appNameTaken('Curia.sh  Box_1', { fetchImpl: async (url) => { asked.push(url); return answer(404, {})() } })
    assert.deepEqual(asked, ['https://api.github.com/apps/curia-sh-box-1'])
  })

  test('the suggestion is the name with the node name, and stays within GitHub\'s 34 characters', () => {
    assert.equal(suggestedAppName('curia.sh', 'curia-ubuntu'), 'curia.sh-curia-ubuntu')
    assert.equal(suggestedAppName('curia.sh', null), 'curia.sh-2')
    assert.equal(suggestedAppName('curia.sh', 'a-very-long-tailscale-node-name-indeed'), 'curia.sh-a-very-long-tailscale-nod')
  })
})

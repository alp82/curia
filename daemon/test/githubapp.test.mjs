// #352: the GitHub App minting core — the two env keys, the key file, the JWT,
// the two permission sets, and the cache that makes the one-hour token safe.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  APP_ID_KEY, APP_KEY_FILE_KEY, JWT_LIFETIME_S, JWT_BACKDATE_S, REFRESH_MARGIN_MS,
  WRITE_PERMISSIONS, READ_PERMISSIONS,
  appConfigFrom, readPrivateKey, keyFileIsPrivate, appJwt, permissionsFor,
  listInstallations, listInstallationRepos, mintInstallationToken, TokenMinter, minterFrom,
  MAX_REPO_PAGES, appFactsFrom, installUrlFor,
} from '../src/githubapp.mjs'

let dir
let keyPair
let keyFile

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-app-'))
  keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  keyFile = path.join(dir, 'app.pem')
  fs.writeFileSync(keyFile, keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 })
  fs.chmodSync(keyFile, 0o600)
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the two env keys (#352)', () => {
  test('no app is the legal pre-cutover state, and reads as null', () => {
    assert.equal(appConfigFrom({}, dir), null)
    assert.equal(appConfigFrom({ [APP_ID_KEY]: '  ', [APP_KEY_FILE_KEY]: '' }, dir), null)
  })

  // Half an app is an operator typo, and it must refuse the boot rather than
  // reach a dispatch as a 401 nobody can place.
  test('half an app refuses, and the refusal names the missing key', () => {
    assert.throws(() => appConfigFrom({ [APP_ID_KEY]: '123' }, dir), new RegExp(APP_KEY_FILE_KEY))
    assert.throws(() => appConfigFrom({ [APP_KEY_FILE_KEY]: 'x.pem' }, dir), new RegExp(APP_ID_KEY))
  })

  // The app id, the app slug and the client id all sit on one settings page,
  // and only one of them is digits.
  test('an app id that is not digits refuses, and says which value was pasted', () => {
    assert.throws(
      () => appConfigFrom({ [APP_ID_KEY]: 'curia', [APP_KEY_FILE_KEY]: 'app.pem' }, dir),
      /app SLUG or the client id/)
  })

  test('the key file resolves against the daemon directory, and an absolute path is kept', () => {
    assert.equal(appConfigFrom({ [APP_ID_KEY]: '7', [APP_KEY_FILE_KEY]: '.curia-app.pem' }, dir).keyFile,
      path.join(dir, '.curia-app.pem'))
    assert.equal(appConfigFrom({ [APP_ID_KEY]: '7', [APP_KEY_FILE_KEY]: keyFile }, dir).keyFile, keyFile)
  })
})

describe('the private key (#352)', () => {
  test('a PKCS#1 PEM reads, which is the file GitHub hands out', () => {
    assert.equal(readPrivateKey(keyFile).type, 'private')
  })

  test('the public half is named back, because that download is the easy mistake', () => {
    const pub = path.join(dir, 'pub.pem')
    fs.writeFileSync(pub, keyPair.publicKey.export({ type: 'spki', format: 'pem' }))
    assert.throws(() => readPrivateKey(pub), /PUBLIC key/)
  })

  test('a missing file names the env key that pointed at it', () => {
    assert.throws(() => readPrivateKey(path.join(dir, 'nope.pem')), new RegExp(APP_KEY_FILE_KEY))
  })

  test('junk is refused with what a real key looks like', () => {
    const junk = path.join(dir, 'junk.pem')
    fs.writeFileSync(junk, 'not a key\n')
    assert.throws(() => readPrivateKey(junk), /BEGIN RSA PRIVATE KEY/)
  })

  // Checked, never fixed: a key curia silently chmods is a key nobody learns to
  // place, and the next box repeats it.
  test('the mode is read, and a group-readable key is not private', () => {
    assert.equal(keyFileIsPrivate(keyFile), true)
    const loose = path.join(dir, 'loose.pem')
    fs.writeFileSync(loose, 'x')
    fs.chmodSync(loose, 0o644)
    assert.equal(keyFileIsPrivate(loose), false)
    assert.equal(keyFileIsPrivate(path.join(dir, 'gone.pem')), false)
  })
})

describe('the app JWT (#352)', () => {
  const NOW = 1_800_000_000_000

  function claimsOf(jwt) {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
  }

  test('the claims are what GitHub asks for, and the issuer is the app id', () => {
    const c = claimsOf(appJwt('12345', keyPair.privateKey, { now: () => NOW }))
    assert.equal(c.iss, '12345')
    // Backdated: GitHub refuses a JWT whose iat is in the future, and two clocks
    // are never the same clock.
    assert.equal(c.iat, Math.floor(NOW / 1000) - JWT_BACKDATE_S)
    assert.equal(c.exp - c.iat, JWT_LIFETIME_S)
    // GitHub's ceiling is ten minutes, and the tenth is left as margin.
    assert.ok(JWT_LIFETIME_S < 600)
  })

  test('the header says RS256, and the signature verifies against the public half', () => {
    const jwt = appJwt('12345', keyPair.privateKey, { now: () => NOW })
    const [header, claims, signature] = jwt.split('.')
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
    assert.ok(crypto.createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(keyPair.publicKey, Buffer.from(signature, 'base64url')))
  })

  // base64url, not base64: a `+` or `/` in a JWT segment is a JWT GitHub reads
  // as a different string, and the failure is a bare 401.
  test('no segment carries a base64 character a URL would change', () => {
    for (let i = 0; i < 20; i++) {
      const jwt = appJwt(String(i), keyPair.privateKey, { now: () => NOW + i })
      assert.doesNotMatch(jwt, /[+/=]/)
    }
  })
})

describe('the permission sets (#352)', () => {
  // The write set is what an agent needs to resolve a ticket: comment, close,
  // open a pull request, push a branch. Nothing wider.
  test('the write set is the four an agent uses, and metadata stays read', () => {
    assert.deepEqual({ ...WRITE_PERMISSIONS }, {
      contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read',
    })
  })

  // The path from a ticket's text to a CI secret. The PATs of #155 do not carry
  // it either, so leaving it out keeps today's reach exactly.
  test('no role can write a workflow file', () => {
    assert.equal(WRITE_PERMISSIONS.workflows, undefined)
    assert.equal(READ_PERMISSIONS.workflows, undefined)
  })

  // #313's set, unchanged. ADR-0014's boundary is this line.
  test('the read set writes nothing at all', () => {
    assert.deepEqual({ ...READ_PERMISSIONS }, {
      contents: 'read', issues: 'read', pull_requests: 'read', statuses: 'read', metadata: 'read',
    })
    for (const level of Object.values(READ_PERMISSIONS)) assert.equal(level, 'read')
  })

  test('an unknown role refuses rather than minting something unnamed', () => {
    assert.equal(permissionsFor('write'), WRITE_PERMISSIONS)
    assert.equal(permissionsFor('read'), READ_PERMISSIONS)
    assert.throws(() => permissionsFor('admin'), /no such token role/)
  })
})

// A fetch stand-in: records every call and answers from a queue.
function fakeFetch(answers) {
  const calls = []
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null })
    const next = answers.shift()
    if (!next) throw new Error(`no canned answer for ${url}`)
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    }
  }
  impl.calls = calls
  return impl
}

describe('the API calls (#352)', () => {
  test('the installation list is id and owner, and nothing else travels', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: [
      { id: 111, account: { login: 'alp82' } },
      { id: 222, account: { login: 'getalfredo' } },
    ] }])
    assert.deepEqual(await listInstallations({ jwt: 'j', fetchImpl }), [
      { id: 111, owner: 'alp82', account_id: null },
      { id: 222, owner: 'getalfredo', account_id: null },
    ])
    const { url, opts } = fetchImpl.calls[0]
    // per_page, because GitHub's default page is 30 and nothing here paginates
    assert.equal(url, 'https://api.github.com/app/installations?per_page=100')
    assert.equal(opts.headers.authorization, 'Bearer j')
    assert.equal(opts.headers['x-github-api-version'], '2022-11-28')
  })

  // A 401 on the JWT has two causes and a status code names neither.
  test('a refused JWT names the app id and the box clock', async () => {
    const fetchImpl = fakeFetch([{ status: 401, body: { message: 'Bad credentials' } }])
    await assert.rejects(listInstallations({ jwt: 'j', fetchImpl }), /box clock must be right/)
  })

  test('the mint posts the permission set and returns the token with its expiry', async () => {
    const expires = '2026-08-15T12:00:00Z'
    const fetchImpl = fakeFetch([{ status: 201, body: {
      token: 'ghs_abc', expires_at: expires, permissions: { contents: 'write' },
    } }])
    const out = await mintInstallationToken(111, { jwt: 'j', permissions: WRITE_PERMISSIONS, fetchImpl })
    assert.equal(out.token, 'ghs_abc')
    assert.equal(out.expiresAt, Date.parse(expires))
    const call = fetchImpl.calls[0]
    assert.equal(call.url, 'https://api.github.com/app/installations/111/access_tokens')
    assert.equal(call.opts.method, 'POST')
    assert.deepEqual(call.body, { permissions: { ...WRITE_PERMISSIONS } })
  })

  // The 422 is the operator's grant, not curia's code, and the status alone
  // sends nobody to the app settings page.
  test('a 422 says what curia asked for and where to fix it', async () => {
    const fetchImpl = fakeFetch([{ status: 422, body: { message: 'The permissions requested are not granted' } }])
    await assert.rejects(
      mintInstallationToken(111, { jwt: 'j', permissions: WRITE_PERMISSIONS, fetchImpl }),
      /contents:write.*Permissions page/s)
  })
})

// What the credential watch reads (#466). A token probe of the repo itself
// cannot answer this: an installation token reads every PUBLIC repository on
// GitHub, so `GET /repos/<owner>/<name>` says 200 for a repo the app was never
// granted — measured on the box against `octocat/Hello-World`.
describe('what one installation covers (#466)', () => {
  const page = (names, total = names.length) => ({
    status: 200,
    body: { total_count: total, repositories: names.map((full_name) => ({ full_name })) },
  })

  test('the repos come back as owner/name, read with the installation token', async () => {
    const fetchImpl = fakeFetch([page(['alp82/curia', 'alp82/aistack'])])
    assert.deepEqual(await listInstallationRepos({ token: 'ghs_x', fetchImpl }),
      ['alp82/curia', 'alp82/aistack'])
    const { url, opts } = fetchImpl.calls[0]
    assert.equal(url, 'https://api.github.com/installation/repositories?per_page=100&page=1')
    // the installation's own token, never the app JWT: this route refuses one
    assert.equal(opts.headers.authorization, 'Bearer ghs_x')
  })

  // An installation granted "all repositories" covers every repo the owner has,
  // so this is the one app read that can run long.
  test('a full page is followed by the next one, and a short page ends it', async () => {
    const first = Array.from({ length: 100 }, (_, i) => `alp82/r${i}`)
    const fetchImpl = fakeFetch([page(first, 101), page(['alp82/curia'], 101)])
    const out = await listInstallationRepos({ token: 'ghs_x', fetchImpl })
    assert.equal(out.length, 101)
    assert.equal(out.at(-1), 'alp82/curia')
    assert.equal(fetchImpl.calls.length, 2)
    assert.match(fetchImpl.calls[1].url, /page=2/)
  })

  test('an empty installation reads as no repositories rather than as a failure', async () => {
    const fetchImpl = fakeFetch([page([])])
    assert.deepEqual(await listInstallationRepos({ token: 'ghs_x', fetchImpl }), [])
  })

  // A short answer would name a covered repo as uncovered, and the watch would
  // ask the operator to repair an installation that is already right. So the
  // cap throws, and the watch reads a throw as "measured nothing".
  test('a list longer than the cap refuses rather than answering short', async () => {
    const full = Array.from({ length: 100 }, (_, i) => `alp82/r${i}`)
    const fetchImpl = fakeFetch(Array.from({ length: MAX_REPO_PAGES }, () => page(full, 9999)))
    await assert.rejects(listInstallationRepos({ token: 'ghs_x', fetchImpl }), /more than/)
    assert.equal(fetchImpl.calls.length, MAX_REPO_PAGES)
  })
})

describe('the minter (#352)', () => {
  const NOW = 1_800_000_000_000
  const HOUR = 3_600_000

  function minter(answers, { now = () => NOW } = {}) {
    const fetchImpl = fakeFetch(answers)
    const m = new TokenMinter({ appId: '7', key: keyPair.privateKey, fetchImpl, now })
    return { m, fetchImpl }
  }

  const installs = { status: 200, body: [{ id: 111, account: { login: 'alp82' } }] }
  const mint = (token, at) => ({ status: 201, body: { token, expires_at: new Date(at).toISOString() } })

  test('a token is minted once and served from cache while the margin holds', async () => {
    const { m, fetchImpl } = minter([installs, mint('ghs_1', NOW + HOUR)])
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_1')
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_1')
    assert.equal(fetchImpl.calls.length, 2) // the install list, then one mint
  })

  // The hour is the whole reason the holders read a file the daemon rewrites.
  test('inside the refresh margin the token is minted again', async () => {
    let now = NOW
    const { m, fetchImpl } = minter(
      [installs, mint('ghs_1', NOW + HOUR), mint('ghs_2', NOW + 2 * HOUR)],
      { now: () => now })
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_1')
    now = NOW + HOUR - REFRESH_MARGIN_MS - 1_000
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_1') // still outside the margin
    now = NOW + HOUR - REFRESH_MARGIN_MS + 1_000
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_2')
    assert.equal(fetchImpl.calls.length, 3)
  })

  // Same owner, two holders: the overseer's read-only token must never be the
  // agents' write token served from a cache that forgot the difference.
  test('the two roles cache apart, and each asks for its own permissions', async () => {
    const { m, fetchImpl } = minter([installs, mint('ghs_w', NOW + HOUR), mint('ghs_r', NOW + HOUR)])
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_w')
    assert.equal(await m.tokenFor('alp82', 'read'), 'ghs_r')
    assert.deepEqual(fetchImpl.calls[1].body.permissions, { ...WRITE_PERMISSIONS })
    assert.deepEqual(fetchImpl.calls[2].body.permissions, { ...READ_PERMISSIONS })
  })

  // An owner installed while the daemon runs must not need a restart.
  test('an unknown owner re-reads the install list before it gives up', async () => {
    const { m, fetchImpl } = minter([
      { status: 200, body: [] },
      { status: 200, body: [{ id: 222, account: { login: 'getalfredo' } }] },
      mint('ghs_g', NOW + HOUR),
    ])
    assert.equal(await m.tokenFor('getalfredo', 'write'), 'ghs_g')
    assert.equal(fetchImpl.calls.length, 3)
  })

  // Null would send an unauthenticated push at a private repo, and the failure
  // would name the repo instead of the missing install.
  test('an owner with no installation throws, naming the owner', async () => {
    const { m } = minter([{ status: 200, body: [] }, { status: 200, body: [] }])
    await assert.rejects(m.tokenFor('nobody', 'write'), /not installed on nobody/)
  })

  // #390: the daemon fires many calls per owner at once — one reconcile pass
  // reads the maps, the map frontier and the flat frontier for every watched
  // repo. Each would find a cold cache and mint its own token.
  test('concurrent callers share one mint instead of each starting their own', async () => {
    const { m, fetchImpl } = minter([installs, mint('ghs_1', NOW + HOUR)])
    const all = await Promise.all(Array.from({ length: 5 }, () => m.tokenFor('alp82', 'write')))
    assert.deepEqual(all, Array(5).fill('ghs_1'))
    assert.equal(fetchImpl.calls.length, 2, 'the install list, then ONE mint')
  })

  // A stall must not be remembered as an answer: the next caller starts fresh.
  test('a failed mint is not held against the next caller', async () => {
    const { m } = minter([installs, { status: 500, body: { message: 'boom' } }, mint('ghs_1', NOW + HOUR)])
    await assert.rejects(m.tokenFor('alp82', 'write'), /HTTP 500/)
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_1')
  })

  test('forget drops the tokens and the install list together', async () => {
    const { m, fetchImpl } = minter([installs, mint('ghs_1', NOW + HOUR), installs, mint('ghs_2', NOW + HOUR)])
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_1')
    m.forget()
    assert.equal(await m.tokenFor('alp82', 'write'), 'ghs_2')
    assert.equal(fetchImpl.calls.length, 4)
  })

  // The watch asks per owner, and the question is about the grant rather than
  // about writing — so the read set carries it (#466).
  test('reposFor mints a READ token and lowercases what it answers', async () => {
    const { m, fetchImpl } = minter([
      installs,
      mint('ghs_read', NOW + HOUR),
      { status: 200, body: { repositories: [{ full_name: 'alp82/Curia' }, { full_name: 'alp82/AiStack' }] } },
    ])
    assert.deepEqual(await m.reposFor('alp82'), ['alp82/curia', 'alp82/aistack'])
    assert.deepEqual(fetchImpl.calls[1].body, { permissions: { ...READ_PERMISSIONS } })
    assert.equal(fetchImpl.calls[2].opts.headers.authorization, 'Bearer ghs_read')
  })

  // An owner the app is not installed on has no answer to give, and that
  // refusal is the one thing the operator must act on.
  test('reposFor on an owner with no installation refuses by name', async () => {
    const { m } = minter([{ status: 200, body: [] }, { status: 200, body: [] }])
    await assert.rejects(m.reposFor('stranger'), /not installed on stranger/)
  })
})

// #389: git has to NAME the app, and a login alone does not link a commit to an
// account. The `<id>+<login>@users.noreply.github.com` form does, and the id
// takes a second read.
describe('the app\'s own git identity (#389)', () => {
  const app = { status: 200, body: { id: 4610603, slug: 'curia-sh' } }
  const bot = { status: 200, body: { id: 317489578, login: 'curia-sh[bot]' } }

  function minter(answers) {
    const fetchImpl = fakeFetch(answers)
    return { m: new TokenMinter({ appId: '7', key: keyPair.privateKey, fetchImpl }), fetchImpl }
  }

  // #762: the reading is a record with three states, and the facts are read
  // once and shared with the bot identity.
  test('the installation reading is unread, then read or failed, each with its instant', async () => {
    const now = () => Date.parse('2026-08-26T10:00:00.000Z')
    const fetchImpl = fakeFetch([
      { status: 500, body: { message: 'down' } },
      { status: 200, body: [{ id: 111, account: { login: 'alp82', id: 9 } }] },
    ])
    const m = new TokenMinter({ appId: '7', key: keyPair.privateKey, fetchImpl, now })
    assert.deepEqual(m.reading, { state: 'unread', at: null, installations: [], error: null })
    await assert.rejects(m.installations())
    assert.equal(m.reading.state, 'failed')
    assert.equal(m.reading.at, '2026-08-26T10:00:00.000Z')
    assert.match(m.reading.error, /down/)
    assert.deepEqual(m.reading.installations, [])
    await m.refreshInstallations()
    assert.equal(m.reading.state, 'read')
    assert.deepEqual(m.reading.installations, [{ id: 111, owner: 'alp82', account_id: 9 }])
    assert.equal(m.reading.error, null)
  })

  test('the app facts are read once, and the bot identity reads them rather than /app again', async () => {
    const { m, fetchImpl } = minter([
      { status: 200, body: { id: 4610603, slug: 'curia-sh', name: 'Curia', html_url: 'https://github.com/apps/curia-sh', owner: { login: 'alp82' } } },
      bot,
    ])
    assert.equal(m.facts, null)
    assert.deepEqual(await m.readFacts(), {
      id: 4610603, slug: 'curia-sh', name: 'Curia', owner: 'alp82', settings_url: 'https://github.com/apps/curia-sh',
    })
    await m.readFacts()
    assert.equal((await m.botIdentity('ghs_x')).name, 'curia-sh[bot]')
    assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/app')).length, 1)
    m.forget()
    assert.equal(m.facts, null)
  })

  test('the install link is the app\'s own page once the slug is known', () => {
    assert.equal(installUrlFor({}), 'https://github.com/settings/installations')
    assert.equal(installUrlFor({ slug: 'curia-sh' }), 'https://github.com/apps/curia-sh/installations/new')
    assert.equal(installUrlFor({ slug: 'curia-sh', accountId: 9 }), 'https://github.com/apps/curia-sh/installations/new/permissions?target_id=9')
    assert.equal(appFactsFrom({ slug: ' ' }).slug, null)
  })

  test('the slug becomes the login, and the bot id becomes the email', async () => {
    const { m, fetchImpl } = minter([app, bot])
    assert.deepEqual(await m.botIdentity('ghs_x'), {
      name: 'curia-sh[bot]',
      email: '317489578+curia-sh[bot]@users.noreply.github.com',
    })
    assert.equal(fetchImpl.calls[0].url, 'https://api.github.com/app')
    // the bracket is not URL-safe, and an unescaped one is a 404 on a route
    // that would otherwise look right
    assert.equal(fetchImpl.calls[1].url, 'https://api.github.com/users/curia-sh%5Bbot%5D')
    // an app JWT authenticates the /app routes and NOTHING else, so the user
    // read has to run on the installation token the caller already holds
    assert.equal(fetchImpl.calls[1].opts.headers.authorization, 'Bearer ghs_x')
  })

  test('both facts are read once and kept — they never change for an installed app', async () => {
    const { m, fetchImpl } = minter([app, bot])
    await m.botIdentity('ghs_x')
    await m.botIdentity('ghs_x')
    assert.equal(fetchImpl.calls.length, 2)
  })

  test('a bot user with no id refuses, rather than composing an email that links to nothing', async () => {
    const { m } = minter([app, { status: 200, body: { login: 'curia-sh[bot]' } }])
    await assert.rejects(m.botIdentity('ghs_x'), /link to no account/)
  })

  test('forget re-reads the identity too', async () => {
    const { m, fetchImpl } = minter([app, bot, app, bot])
    await m.botIdentity('ghs_x')
    m.forget()
    await m.botIdentity('ghs_x')
    assert.equal(fetchImpl.calls.length, 4)
  })
})

describe('the minter this box gets (#352)', () => {
  test('no app configured is null, not a refusal', () => {
    assert.equal(minterFrom({ env: {}, daemonRoot: dir }), null)
  })

  test('a configured app builds a minter carrying the app id', () => {
    const m = minterFrom({ env: { [APP_ID_KEY]: '7', [APP_KEY_FILE_KEY]: keyFile }, daemonRoot: dir })
    assert.equal(m.appId, '7')
    assert.equal(m.key.type, 'private')
  })

  test('a key readable beyond its owner warns and still works', () => {
    const loose = path.join(dir, 'loose-real.pem')
    fs.writeFileSync(loose, keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }))
    fs.chmodSync(loose, 0o644)
    const said = []
    const m = minterFrom({
      env: { [APP_ID_KEY]: '7', [APP_KEY_FILE_KEY]: loose }, daemonRoot: dir, log: (s) => said.push(s),
    })
    assert.ok(m)
    assert.match(said.join('\n'), /chmod 600/)
  })
})

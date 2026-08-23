// #642: the codex credential broker and the browser re-authentication.
//
// Everything here is hermetic. No test reaches OpenAI, no test reads the box's
// real credential, and no test needs a subscription — the exchange runs on an
// injected `fetchImpl` and the clock on an injected `now`, which is the same
// discipline `githubapp.test.mjs` runs the installation-token minter under.
//
// The device flow itself is NOT tested here. Proving it means completing a real
// login, and that lives in docs/live-checks/642-codex-reauth.md.
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  REFRESH_AT_FRACTION, MEASURED_LIFETIME_MS, MIN_REFRESH_MARGIN_MS,
  AGENT_CREDENTIAL_MODE, HOST_CREDENTIAL_MODE, REAUTH_TIMEOUT_MS,
  CODEX_TOKEN_URL, CODEX_CLIENT_ID,
  codexTokenClock, codexAccessTokenExpiry, refreshMarginMs, refreshDue, credentialState,
  exchangeRefreshToken, applyRefresh, writeCredentialFile,
  CodexCredentialBroker, ReauthFlow,
  authSessionName, isAuthSession, scrapeDeviceAuth, reauthRunCmd,
} from '../src/credentials.mjs'

const DAY = 24 * 60 * 60 * 1000

// A codex access token, as codex writes one: a JWT whose payload carries the
// two claims this module reads. Nothing verifies the signature — the daemon is
// not the audience — so the signature segment is a placeholder on purpose.
function accessToken({ iat, exp, plan = 'prolite' }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: Math.floor(iat / 1000), exp: Math.floor(exp / 1000), 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })}.sig`
}

// The real file's shape, read off the box: `auth_mode`, a null `OPENAI_API_KEY`,
// four token fields and a `last_refresh` stamp.
function authJson({ iat, exp, refresh = 'rt.old', account = 'acct-1' } = {}) {
  return `${JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'id.old',
      access_token: accessToken({ iat, exp }),
      refresh_token: refresh,
      account_id: account,
    },
    last_refresh: new Date(iat).toISOString(),
  }, null, 2)}\n`
}

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-cred-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// A fake HOME whose `.codex/auth.json` the broker owns.
function seedHost(text) {
  const store = path.join(dir, '.codex')
  fs.mkdirSync(store, { recursive: true })
  const file = path.join(store, 'auth.json')
  fs.writeFileSync(file, text, { mode: HOST_CREDENTIAL_MODE })
  fs.chmodSync(file, HOST_CREDENTIAL_MODE)
  return file
}

function seedAgent(session, text) {
  const cfgDir = path.join(dir, 'cfg', session)
  fs.mkdirSync(cfgDir, { recursive: true })
  const file = path.join(cfgDir, 'auth.json')
  fs.writeFileSync(file, text)
  fs.chmodSync(file, AGENT_CREDENTIAL_MODE)
  return { session, cfgDir, file }
}

const modeOf = (f) => fs.statSync(f).mode & 0o777

describe('reading the credential (#642)', () => {
  test('both clock claims come off the token, in milliseconds', () => {
    const iat = Date.parse('2026-08-23T13:35:23Z')
    const exp = iat + 10 * DAY
    const clock = codexTokenClock(authJson({ iat, exp }))
    assert.equal(clock.iat, iat)
    assert.equal(clock.exp, exp)
    assert.equal(codexAccessTokenExpiry(authJson({ iat, exp })), exp)
  })

  // The #351 refusal in workspace.mjs stands on a measured expiry, and this
  // parser is now the only one in the daemon. Null on ANY failure keeps that
  // refusal honest: a file nothing can read proves nothing about the token.
  test('anything unreadable answers null rather than guessing', () => {
    for (const bad of ['', 'not json', '{}', '{"tokens":{}}', '{"tokens":{"access_token":"a.b"}}', '{"tokens":{"access_token":123}}']) {
      assert.equal(codexAccessTokenExpiry(bad), null, bad)
    }
  })
})

describe('the refresh margin (#642)', () => {
  // The token states its own life, so the margin is a fraction of a measurement
  // rather than a constant somebody guessed. Ten days is the measured lifetime
  // (docs/live-checks/644), and a quarter of it is 2.5 days.
  test('a quarter of the life the token itself states', () => {
    const iat = 1_000_000_000_000
    assert.equal(refreshMarginMs({ iat, exp: iat + 10 * DAY }), 10 * DAY * REFRESH_AT_FRACTION)
  })

  test('a token that states no issue instant falls back to the measured lifetime', () => {
    assert.equal(refreshMarginMs({ iat: null, exp: 1 }), MEASURED_LIFETIME_MS * REFRESH_AT_FRACTION)
  })

  // A provider that started minting five-minute tokens would compute a
  // 75-second margin, which is barely one dispatch tick.
  test('the margin never falls below the floor, whatever the provider does', () => {
    const iat = 1_000_000_000_000
    assert.equal(refreshMarginMs({ iat, exp: iat + 5 * 60 * 1000 }), MIN_REFRESH_MARGIN_MS)
  })

  test('due exactly at the last quarter, and not one millisecond before', () => {
    const iat = 1_000_000_000_000
    const exp = iat + 10 * DAY
    const at = exp - 10 * DAY * REFRESH_AT_FRACTION
    const text = authJson({ iat, exp })
    assert.equal(refreshDue(text, at - 1).due, false)
    assert.equal(refreshDue(text, at).due, true)
    assert.match(refreshDue(text, at).why, /last 25% of the token's life/)
  })

  // Deliberate direction: a refresh rotates the server-side token, and a
  // rotation this module cannot record is exactly the #351 failure. An
  // unreadable file is a re-authentication case, never a refresh case.
  test('an unreadable expiry never spends a refresh token', () => {
    const verdict = refreshDue('{"tokens":{"access_token":"junk"}}', Date.now())
    assert.equal(verdict.due, false)
    assert.match(verdict.why, /states no expiry/)
  })
})

describe('what the surfaces are told (#642)', () => {
  const iat = 1_000_000_000_000
  const exp = iat + 10 * DAY
  const text = authJson({ iat, exp })

  test('valid, expiring, expired, unreadable and absent are five different facts', () => {
    assert.equal(credentialState(text, iat + DAY).state, 'valid')
    assert.equal(credentialState(text, exp - DAY).state, 'expiring')
    assert.equal(credentialState(text, exp + 1).state, 'expired')
    assert.equal(credentialState('{}', iat).state, 'unreadable')
    assert.equal(credentialState(null, iat).state, 'absent')
  })

  test('a valid credential still states when it dies, so a page can count down', () => {
    assert.equal(credentialState(text, iat).expires_at, new Date(exp).toISOString())
  })
})

describe('the exchange (#642)', () => {
  test('it posts exactly the three fields #644 measured, and nothing else', async () => {
    let seen = null
    await exchangeRefreshToken({
      refreshToken: 'rt.old',
      fetchImpl: async (url, init) => {
        seen = { url, body: JSON.parse(init.body), method: init.method }
        return new Response(JSON.stringify({ access_token: 'at.new' }), { status: 200 })
      },
    })
    assert.equal(seen.url, CODEX_TOKEN_URL)
    assert.equal(seen.method, 'POST')
    assert.deepEqual(Object.keys(seen.body).sort(), ['client_id', 'grant_type', 'refresh_token'])
    assert.equal(seen.body.client_id, CODEX_CLIENT_ID)
    assert.equal(seen.body.grant_type, 'refresh_token')
  })

  // #646 keys its classifier on `error.code`. OpenAI answers a spent token with
  // `refresh_token_reused` inside its OWN error envelope, not the OAuth
  // standard's top-level `invalid_grant` — a classifier written against the
  // standard would have missed the one failure this map was built on.
  test('a spent token arrives with its code intact, off OpenAI\'s error envelope', async () => {
    const body = {
      error: {
        message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.',
        type: 'invalid_request_error',
        param: null,
        code: 'refresh_token_reused',
      },
    }
    await assert.rejects(
      exchangeRefreshToken({
        refreshToken: 'rt.spent',
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 401 }),
      }),
      (e) => e.status === 401 && e.code === 'refresh_token_reused' && /already been used/.test(e.message))
  })

  test('a 200 with no access token is a failure, not a credential', async () => {
    await assert.rejects(
      exchangeRefreshToken({ refreshToken: 'rt', fetchImpl: async () => new Response('{}', { status: 200 }) }),
      /no access token/)
  })

  test('no refresh token at all is named as a re-authentication case', async () => {
    await assert.rejects(exchangeRefreshToken({ refreshToken: null }), /re-authentication case/)
  })
})

describe('applying a refresh (#642)', () => {
  const iat = 1_000_000_000_000
  const text = authJson({ iat, exp: iat + 10 * DAY, account: 'acct-7' })

  // `auth.json` carries fields the exchange never answers for. A rewrite that
  // dropped them would hand codex a file it reads differently.
  test('it merges, so the fields the exchange never answers survive', () => {
    const out = JSON.parse(applyRefresh(text, { access_token: 'at.new' }, { now: () => 42 }))
    assert.equal(out.auth_mode, 'chatgpt')
    assert.equal(out.OPENAI_API_KEY, null)
    assert.equal(out.tokens.account_id, 'acct-7')
    assert.equal(out.tokens.access_token, 'at.new')
    assert.equal(out.last_refresh, new Date(42).toISOString())
  })

  test('a rotated refresh token replaces the old one; an omitted one keeps it', () => {
    assert.equal(JSON.parse(applyRefresh(text, { access_token: 'a', refresh_token: 'rt.new' })).tokens.refresh_token, 'rt.new')
    assert.equal(JSON.parse(applyRefresh(text, { access_token: 'a' })).tokens.refresh_token, 'rt.old')
    assert.equal(JSON.parse(applyRefresh(text, { access_token: 'a' })).tokens.id_token, 'id.old')
  })
})

describe('the write (#642)', () => {
  // Codex's own write truncates in place, and workspace.mjs notes that a
  // refresh racing a read can be seen torn. The daemon writes this file far
  // more often than codex does, so it writes it the way Claude Code does.
  test('a reader never sees a torn file: the replacement is a rename', () => {
    const file = path.join(dir, 'auth.json')
    fs.writeFileSync(file, 'old')
    const before = fs.statSync(dir).ino
    writeCredentialFile(file, 'new', { mode: 0o600 })
    assert.equal(fs.readFileSync(file, 'utf8'), 'new')
    assert.equal(fs.statSync(dir).ino, before)
    // and no temp file is left behind
    assert.deepEqual(fs.readdirSync(dir), ['auth.json'])
  })

  test('the mode is restored even though the file already existed', () => {
    const file = path.join(dir, 'auth.json')
    fs.writeFileSync(file, 'old', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    writeCredentialFile(file, 'new', { mode: AGENT_CREDENTIAL_MODE })
    assert.equal(modeOf(file), AGENT_CREDENTIAL_MODE)
  })
})

describe('the broker (#642)', () => {
  const iat = 1_000_000_000_000
  const exp = iat + 10 * DAY

  function broker({ now, fetchImpl, journal = () => {} } = {}) {
    return new CodexCredentialBroker({ home: dir, now, fetchImpl, journal })
  }

  test('a box with no codex login is legal, and refreshes nothing', async () => {
    const b = broker({ now: () => iat })
    assert.deepEqual(await b.refreshIfDue(), { refreshed: false, why: 'no codex credential on this box' })
    assert.equal(b.state().state, 'absent')
  })

  test('a token in the first three quarters of its life is left alone', async () => {
    seedHost(authJson({ iat, exp }))
    let called = false
    const b = broker({ now: () => iat + DAY, fetchImpl: async () => { called = true } })
    assert.equal((await b.refreshIfDue()).refreshed, false)
    assert.equal(called, false)
  })

  test('inside the last quarter it refreshes, and the host store carries the new token', async () => {
    const file = seedHost(authJson({ iat, exp }))
    const events = []
    const b = broker({
      now: () => exp - DAY,
      journal: (e, d) => events.push([e, d]),
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: accessToken({ iat: exp - DAY, exp: exp + 9 * DAY }),
        refresh_token: 'rt.new',
      }), { status: 200 }),
    })
    assert.equal((await b.refreshIfDue()).refreshed, true)
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after.tokens.refresh_token, 'rt.new')
    assert.equal(codexAccessTokenExpiry(fs.readFileSync(file, 'utf8')), exp + 9 * DAY)
    assert.equal(modeOf(file), HOST_CREDENTIAL_MODE)
    assert.equal(events[0][0], 'credential_refreshed')
  })

  // ONE EXCHANGE AT A TIME. The server rotates the refresh token the moment an
  // exchange succeeds, so two concurrent exchanges would spend each other's and
  // strand the store — which is the failure this whole module exists to end.
  test('two callers landing together make ONE exchange', async () => {
    seedHost(authJson({ iat, exp }))
    let calls = 0
    const b = broker({
      now: () => exp - DAY,
      fetchImpl: async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 10))
        return new Response(JSON.stringify({ access_token: accessToken({ iat: exp, exp: exp + 10 * DAY }) }), { status: 200 })
      },
    })
    const [a, c] = await Promise.all([b.refreshIfDue(), b.refreshIfDue()])
    assert.equal(calls, 1)
    assert.equal(a.refreshed, true)
    assert.equal(c.refreshed, true)
  })

  // A failure leaves the last good file standing. That token is good for days,
  // and the next tick is 60 s away.
  test('a refused exchange keeps the file that is already on disk', async () => {
    const file = seedHost(authJson({ iat, exp }))
    const before = fs.readFileSync(file, 'utf8')
    const events = []
    const b = broker({
      now: () => exp - DAY,
      journal: (e, d) => events.push([e, d]),
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'refresh_token_reused' } }), { status: 401 }),
    })
    const out = await b.refreshIfDue()
    assert.equal(out.refreshed, false)
    assert.equal(out.code, 'refresh_token_reused')
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.deepEqual(events.map((e) => e[0]), ['credential_refresh_failed'])
    assert.equal(events[0][1].code, 'refresh_token_reused')
    assert.match(b.state().last_error, /refresh_token_reused/)
  })
})

describe('the fan-out (#642)', () => {
  const iat = 1_000_000_000_000
  const exp = iat + 10 * DAY

  test('live agents get the host store, and the 0400 bit is restored', () => {
    const host = authJson({ iat, exp, refresh: 'rt.new' })
    seedHost(host)
    const a = seedAgent('curia-574', authJson({ iat: iat - 10 * DAY, exp: iat, refresh: 'rt.spent' }))
    const b = new CodexCredentialBroker({ home: dir, now: () => exp - DAY })
    assert.deepEqual(b.fanOut([{ session: a.session, cfgDir: a.cfgDir }]).healed, ['curia-574'])
    assert.equal(fs.readFileSync(a.file, 'utf8'), host)
    assert.equal(modeOf(a.file), AGENT_CREDENTIAL_MODE)
  })

  // There were 245 directories under `cfg/` on the box the day this was written.
  // "Every config dir" is not the shape: a dead one holds nothing worth a live
  // credential, and `removeCredentials` already sweeps them.
  test('a config dir with no codex credential is skipped, never seeded', () => {
    seedHost(authJson({ iat, exp }))
    const claude = path.join(dir, 'cfg', 'curia-600')
    fs.mkdirSync(claude, { recursive: true })
    const b = new CodexCredentialBroker({ home: dir, now: () => exp })
    assert.deepEqual(b.fanOut([{ session: 'curia-600', cfgDir: claude }]).healed, [])
    assert.equal(fs.existsSync(path.join(claude, 'auth.json')), false)
  })

  test('an agent already holding the current credential is not rewritten', () => {
    const host = authJson({ iat, exp })
    seedHost(host)
    const a = seedAgent('curia-578', host)
    const b = new CodexCredentialBroker({ home: dir, now: () => exp })
    assert.deepEqual(b.fanOut([{ session: a.session, cfgDir: a.cfgDir }]).healed, [])
  })

  test('one unwritable agent does not cost the others their credential', () => {
    seedHost(authJson({ iat, exp, refresh: 'rt.new' }))
    const good = seedAgent('curia-1', authJson({ iat, exp: iat + 1 }))
    const bad = seedAgent('curia-2', authJson({ iat, exp: iat + 1 }))
    fs.chmodSync(bad.cfgDir, 0o500)
    try {
      const out = new CodexCredentialBroker({ home: dir, now: () => exp }).fanOut([
        { session: bad.session, cfgDir: bad.cfgDir },
        { session: good.session, cfgDir: good.cfgDir },
      ])
      assert.deepEqual(out.healed, ['curia-1'])
      assert.equal(out.errors.length, 1)
      assert.equal(out.errors[0].session, 'curia-2')
    } finally {
      fs.chmodSync(bad.cfgDir, 0o700)
    }
  })
})

// HOST STORE FIRST, THEN THE AGENTS. A crash between the two leaves the host
// correct and the agents stale, which the next tick repairs. The reverse
// ordering loses the rotation, which is exactly the 2026-08-23 failure.
describe('the ordering (#642)', () => {
  test('nothing reaches an agent before the host store holds it', async () => {
    const iat = 1_000_000_000_000
    const exp = iat + 10 * DAY
    const hostFile = seedHost(authJson({ iat, exp, refresh: 'rt.old' }))
    const agent = seedAgent('curia-574', authJson({ iat, exp, refresh: 'rt.old' }))
    const b = new CodexCredentialBroker({
      home: dir,
      now: () => exp - DAY,
      fetchImpl: async () => {
        // Mid-exchange, the agent still holds the OLD credential: the fan-out
        // has not run and cannot have.
        assert.match(fs.readFileSync(agent.file, 'utf8'), /rt\.old/)
        return new Response(JSON.stringify({ access_token: accessToken({ iat: exp, exp: exp + 10 * DAY }), refresh_token: 'rt.new' }), { status: 200 })
      },
    })
    await b.refreshIfDue()
    assert.match(fs.readFileSync(hostFile, 'utf8'), /rt\.new/)
    assert.match(fs.readFileSync(agent.file, 'utf8'), /rt\.old/, 'the host store is written first, alone')
    b.fanOut([{ session: agent.session, cfgDir: agent.cfgDir }])
    assert.match(fs.readFileSync(agent.file, 'utf8'), /rt\.new/)
  })
})

describe('the re-authentication session name (#642)', () => {
  // `curia-attach.sh` admits `^curia-[A-Za-z0-9._-]+$`, so this name is
  // reachable on the existing attach surface with no whitelist change.
  test('the name is admitted by the attach whitelist as it stands', () => {
    assert.match(authSessionName('openai'), /^curia-[A-Za-z0-9._-]+$/)
    assert.equal(authSessionName('openai'), 'curia-auth-openai')
  })

  test('an agent session is never mistaken for a login, and the reverse', () => {
    for (const yes of ['curia-auth-openai', 'curia-auth-anthropic', 'curia-auth-a-b']) assert.equal(isAuthSession(yes), true, yes)
    for (const no of ['curia-574', 'curia-review-574', 'curia-chat-1', 'curia-authors', 'auth-openai', '', null, undefined]) {
      assert.equal(isAuthSession(no), false, String(no))
    }
  })
})

describe('scraping the device card (#642)', () => {
  // Verbatim from the box, codex-cli 0.146.0.
  const pane = `
1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device
2. Enter this one-time code (expires in 15 minutes)
   83CC-A4ZTO

Waiting for you to sign in...
`

  test('the link and the code come off the pane', () => {
    assert.deepEqual(scrapeDeviceAuth(pane), { url: 'https://auth.openai.com/codex/device', code: '83CC-A4ZTO' })
  })

  // A card that shows four wrong characters sends the operator round the loop a
  // second time, so the pattern is anchored on codex's own sentence rather than
  // matched loosely. A pane with no code answers null, and the card degrades to
  // "open the terminal" — never to a dead end.
  test('a pane with no code yields no code, rather than something code-shaped', () => {
    assert.deepEqual(scrapeDeviceAuth('GPT-5.6 is READY-TO-GO and the LANE-IS-OPEN'), { url: null, code: null })
    assert.deepEqual(scrapeDeviceAuth(''), { url: null, code: null })
    assert.deepEqual(scrapeDeviceAuth(null), { url: null, code: null })
  })

  test('a half-drawn pane gives what it has, and null for the rest', () => {
    assert.deepEqual(scrapeDeviceAuth('open https://auth.openai.com/codex/device now'), {
      url: 'https://auth.openai.com/codex/device', code: null,
    })
  })
})

describe('the command the login pane runs (#642)', () => {
  const cmd = () => reauthRunCmd({ name: 'curia-auth-openai', image: 'curia-agent:1.2.3-0.146.0-abcd1234', cfgDir: '/w/cfg/curia-auth-openai', agentUid: 1000 })

  // The tmux image carries docker but not codex, so the indirection is required
  // rather than chosen (measured, #644 §1).
  test('it runs codex inside the agent image, on a scratch CODEX_HOME', () => {
    assert.match(cmd(), /docker run .*--name curia-auth-openai/)
    assert.match(cmd(), /-v \/w\/cfg\/curia-auth-openai:\/cfg/)
    assert.match(cmd(), /-e CODEX_HOME=\/cfg/)
    assert.match(cmd(), /codex login --device-auth$/)
  })

  // `listContainers` filters on `label=curia.session` and `#sweepContainers`
  // removes anything it finds whose pane is gone. A labelled login container
  // would be swept out from under an operator halfway through typing the code.
  test('it carries NO curia.session label, so no container sweep can see it', () => {
    assert.equal(/curia\.session/.test(cmd()), false)
  })

  // The live check ran this as root and left a root-owned auth.json the daemon
  // could not read.
  test('it runs as the uid that owns the mount', () => {
    assert.match(cmd(), /--user 1000:1000/)
  })

  test('an unsafe argument refuses rather than being escaped', () => {
    assert.throws(() => reauthRunCmd({ name: 'curia-auth-openai; rm -rf /', image: 'i', cfgDir: '/c', agentUid: 1 }), /not shell-safe/)
  })
})

describe('the re-authentication flow (#642)', () => {
  function flow({ now = () => 0, sessions = new Set(), journal = () => {} } = {}) {
    const calls = { spawned: [], killed: [], stopped: [] }
    const f = new ReauthFlow({
      broker: new CodexCredentialBroker({ home: dir, now }),
      image: 'curia-agent:test',
      agentUid: 1000,
      cfgDirFor: (session) => path.join(dir, 'cfg', session),
      newSession: async (opts) => { calls.spawned.push(opts); sessions.add(opts.name) },
      capturePane: async () => calls.pane ?? '',
      killSession: async (name) => { calls.killed.push(name); sessions.delete(name) },
      hasSession: async (name) => sessions.has(name),
      stopContainer: async (name) => { calls.stopped.push(name) },
      now,
      journal,
    })
    return { f, calls, sessions }
  }

  test('starting spawns one session and reports it', async () => {
    const { f, calls } = flow()
    const out = await f.start({ consumer: 'openai' })
    assert.equal(out.started, true)
    assert.equal(out.session, 'curia-auth-openai')
    assert.equal(calls.spawned.length, 1)
    assert.match(calls.spawned[0].shellCmd, /codex login --device-auth/)
    assert.equal(f.state().state, 'waiting')
  })

  // One session per consumer, enforced by the fixed name. Pressing the button
  // twice attaches to the first, which is what an operator on a phone expects.
  test('a second start attaches to the first rather than opening another', async () => {
    const { f, calls } = flow()
    await f.start({ consumer: 'openai' })
    const again = await f.start({ consumer: 'openai' })
    assert.equal(again.started, false)
    assert.equal(calls.spawned.length, 1)
  })

  // A leftover credential read as a fresh login is the silent return to the
  // failure this map exists for.
  test('a leftover credential from an earlier attempt is cleared before the login runs', async () => {
    const cfgDir = path.join(dir, 'cfg', 'curia-auth-openai')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'auth.json'), 'stale')
    const { f } = flow()
    await f.start({ consumer: 'openai' })
    assert.equal(fs.existsSync(path.join(cfgDir, 'auth.json')), false)
  })

  test('the card fills in from the pane, and the journal never carries the code', async () => {
    const events = []
    const { f, calls, sessions } = flow({ journal: (e, d) => events.push([e, d]) })
    await f.start({ consumer: 'openai' })
    calls.pane = '   https://auth.openai.com/codex/device\n2. Enter this one-time code (expires in 15 minutes)\n   85PT-A4E5M\n'
    sessions.add('curia-auth-openai')
    await f.poll()
    assert.equal(f.state().code, '85PT-A4E5M')
    assert.equal(f.state().url, 'https://auth.openai.com/codex/device')
    assert.equal(JSON.stringify(events).includes('85PT-A4E5M'), false, 'a one-time code must never reach the journal')
    assert.deepEqual(events.map((e) => e[0]), ['reauth_started', 'reauth_code_seen'])
  })

  // The credential file appearing is the completion signal, not the pane's
  // "Successfully logged in" — that wording belongs upstream.
  test('the credential appearing completes the flow and adopts it as the host store', async () => {
    const iat = 1_000_000_000_000
    const events = []
    const { f, calls, sessions } = flow({ now: () => iat, journal: (e, d) => events.push([e, d]) })
    await f.start({ consumer: 'openai' })
    fs.writeFileSync(path.join(dir, 'cfg', 'curia-auth-openai', 'auth.json'), authJson({ iat, exp: iat + 10 * DAY, refresh: 'rt.fresh' }))
    const out = await f.poll()
    assert.equal(out.state, 'done')
    const host = fs.readFileSync(path.join(dir, '.codex', 'auth.json'), 'utf8')
    assert.match(host, /rt\.fresh/)
    // the session, its unlabelled container and the scratch dir all go
    assert.deepEqual(calls.killed, ['curia-auth-openai'])
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(calls.stopped, ['curia-auth-openai'])
    assert.equal(fs.existsSync(path.join(dir, 'cfg', 'curia-auth-openai')), false)
    assert.equal(events.at(-1)[0], 'reauth_completed')
    assert.equal(sessions.has('curia-auth-openai'), false)
  })

  test('a file that is not a credential is not completion', async () => {
    const { f } = flow()
    await f.start({ consumer: 'openai' })
    fs.writeFileSync(path.join(dir, 'cfg', 'curia-auth-openai', 'auth.json'), '{"tokens":{}}')
    assert.equal(await f.poll(), null)
    assert.equal(f.state().state, 'waiting')
  })

  // A re-authentication that silently vanished is the same class of bug as the
  // credential that silently vanished, and this map exists because of one.
  test('the thirty-minute timeout tears down and is journalled', async () => {
    let now = 0
    const events = []
    const { f, calls } = flow({ now: () => now, journal: (e, d) => events.push([e, d]) })
    await f.start({ consumer: 'openai' })
    now = REAUTH_TIMEOUT_MS - 1
    assert.equal(await f.poll(), null)
    now = REAUTH_TIMEOUT_MS
    const out = await f.poll()
    assert.equal(out.state, 'timeout')
    assert.deepEqual(calls.killed, ['curia-auth-openai'])
    assert.equal(events.at(-1)[0], 'reauth_timed_out')
    assert.equal(events.at(-1)[1].after_s, REAUTH_TIMEOUT_MS / 1000)
  })

  // A login that completed in the last seconds of the window is adopted rather
  // than torn down.
  test('a credential that lands on the deadline tick is still adopted', async () => {
    const iat = 1_000_000_000_000
    let now = iat
    const { f } = flow({ now: () => now })
    await f.start({ consumer: 'openai' })
    fs.writeFileSync(path.join(dir, 'cfg', 'curia-auth-openai', 'auth.json'), authJson({ iat, exp: iat + 10 * DAY }))
    now = iat + REAUTH_TIMEOUT_MS
    assert.equal((await f.poll()).state, 'done')
  })

  test('a session that is gone with no credential is reported, not forgotten', async () => {
    const events = []
    const { f, sessions } = flow({ journal: (e, d) => events.push([e, d]) })
    await f.start({ consumer: 'openai' })
    sessions.delete('curia-auth-openai')
    assert.equal((await f.poll()).state, 'abandoned')
    assert.equal(events.at(-1)[0], 'reauth_abandoned')
  })

  // The evidence rule the whole daemon runs on: an indeterminate tmux is not
  // absence.
  test('an indeterminate tmux ends nothing', async () => {
    const { f } = flow()
    await f.start({ consumer: 'openai' })
    f.hasSession = async () => { throw new Error('tmux session presence is indeterminate') }
    assert.equal(await f.poll(), null)
    assert.equal(f.state().state, 'waiting')
  })
})

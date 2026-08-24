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
  classifyRefreshFailure, TERMINAL_REFRESH_CODES, TRANSIENT_RETRY_BOUND, CODEX_PROVIDER,
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

// #646: what happens when a refresh FAILS.
//
// The table below is the whole classifier, and the row that matters most is the
// unrecognised 401: codex itself calls any 401 permanent, and curia calls it
// transient. A wrong transient call costs minutes of an outage already under
// way; a wrong terminal call cools a lane, freezes a fleet and wakes the
// operator for a network blip.
describe('classifying a failed refresh (#646)', () => {
  const wire = (status, code, message = 'refused') => Object.assign(new Error(message), { status, code })

  test('the three codes codex itself recognises are terminal, on 400 and on 401', () => {
    for (const code of TERMINAL_REFRESH_CODES) {
      for (const status of [400, 401]) {
        const out = classifyRefreshFailure(wire(status, code))
        assert.equal(out.terminal, true, `${status} ${code}`)
        assert.match(out.why, new RegExp(code))
      }
    }
  })

  // The one #643 MEASURED, in OpenAI's own error envelope rather than the
  // OAuth standard's top-level field.
  test('the measured spent-token answer is terminal', () => {
    assert.equal(classifyRefreshFailure(wire(401, 'refresh_token_reused')).terminal, true)
  })

  test('the OAuth standard invalid_grant is terminal on 400', () => {
    assert.equal(classifyRefreshFailure(wire(400, 'invalid_grant')).terminal, true)
  })

  // WHERE CURIA PARTS COMPANY WITH CODEX, and the reason the retry bound exists.
  test('an unrecognised 401 is TRANSIENT, and says why', () => {
    const out = classifyRefreshFailure(wire(401, 'some_new_code'))
    assert.equal(out.terminal, false)
    assert.match(out.why, /does not prove the credential died/)
  })

  test('an unrecognised code on 403 is transient too', () => {
    assert.equal(classifyRefreshFailure(wire(403, null)).terminal, false)
  })

  test('a request that never got a response is transient', () => {
    const out = classifyRefreshFailure(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
    assert.equal(out.terminal, false)
    assert.match(out.why, /no HTTP response reached curia/)
  })

  test('408, 429 and 5xx are the provider asking for a retry', () => {
    for (const status of [408, 429, 500, 502, 503]) {
      const out = classifyRefreshFailure(wire(status, null))
      assert.equal(out.terminal, false, String(status))
      assert.match(out.why, /asking for a retry/)
    }
  })

  // A 200 carrying no token is a provider having a bad minute. It proves
  // nothing about the refresh token, so it counts toward the bound like any
  // other unknown rather than killing the lane on its own.
  test('a success that carried no access token is transient', async () => {
    await assert.rejects(
      exchangeRefreshToken({ refreshToken: 'rt', fetchImpl: async () => new Response('{}', { status: 200 }) }),
      (e) => {
        assert.equal(e.status, 200)
        assert.equal(classifyRefreshFailure(e).terminal, false)
        return true
      },
    )
  })

  // #643 measured the code at `error.code`. The other two locations are the
  // OAuth standard's and a bare one, in the order the research note names.
  test('the code is read from all three locations, envelope first', async () => {
    const codeFrom = async (body) => {
      try {
        await exchangeRefreshToken({ refreshToken: 'rt', fetchImpl: async () => new Response(JSON.stringify(body), { status: 400 }) })
      } catch (e) { return e.code }
      return null
    }
    assert.equal(await codeFrom({ error: { code: 'refresh_token_reused' } }), 'refresh_token_reused')
    assert.equal(await codeFrom({ error: 'invalid_grant' }), 'invalid_grant')
    assert.equal(await codeFrom({ code: 'invalid_grant' }), 'invalid_grant')
  })

  test('the codex consumer holds the openai lane', () => {
    assert.equal(CODEX_PROVIDER, 'openai')
  })
})

// #646: the bound, and the hold it arms.
describe('the retry bound and the hold (#646)', () => {
  const iat = 1_000_000_000_000
  const exp = iat + 10 * DAY

  // Every call sits inside the last quarter, so `refreshDue` stays true and the
  // only thing stopping an exchange is the latch under test.
  function brokerOn(fetchImpl, events = []) {
    seedHost(authJson({ iat, exp }))
    return new CodexCredentialBroker({
      home: dir, now: () => exp - DAY, fetchImpl,
      journal: (e, d) => events.push([e, d]),
    })
  }

  const refused = (status, code) => async () => new Response(JSON.stringify({ error: { code } }), { status })
  const flaky = () => async () => new Response('gateway', { status: 503 })

  test('a terminal code holds the lane on the first answer', async () => {
    const events = []
    const b = brokerOn(refused(401, 'refresh_token_reused'), events)
    const out = await b.refreshIfDue()
    assert.equal(out.terminal, true)
    assert.equal(out.by, 'provider')
    assert.equal(b.held.code, 'refresh_token_reused')
    assert.deepEqual(events.map((e) => e[0]), ['credential_refresh_failed'])
    assert.equal(events[0][1].terminal, true)
  })

  // THE LATCH. A dead refresh token does not resurrect, and asking once a
  // minute writes a failure line into the journal the operator will read to
  // reconstruct the incident.
  test('a held broker never touches the wire again, and reports held rather than terminal', async () => {
    let calls = 0
    const b = brokerOn(async () => { calls += 1; return new Response(JSON.stringify({ error: { code: 'refresh_token_reused' } }), { status: 401 }) })
    await b.refreshIfDue()
    assert.equal(calls, 1)

    const again = await b.refreshIfDue()
    assert.equal(calls, 1, 'the second tick asks a question already answered')
    assert.equal(again.held, true)
    assert.equal(again.terminal, undefined, 'so the dispatcher alarms once per transition, not once per tick')
  })

  test(`${TRANSIENT_RETRY_BOUND} unknown answers in a row make a terminal call, journalled as its own event`, async () => {
    const events = []
    const b = brokerOn(flaky(), events)
    for (let i = 1; i < TRANSIENT_RETRY_BOUND; i += 1) {
      const out = await b.refreshIfDue()
      assert.equal(out.terminal, false, `attempt ${i}`)
      assert.equal(b.held, null)
    }
    const last = await b.refreshIfDue()
    assert.equal(last.terminal, true)
    assert.equal(last.by, 'bound')

    const names = events.map((e) => e[0])
    assert.deepEqual(names.slice(0, TRANSIENT_RETRY_BOUND - 1), Array(TRANSIENT_RETRY_BOUND - 1).fill('credential_refresh_failed'))
    // The give-up is NOT a fifth `credential_refresh_failed`: "the provider said
    // it is dead" and "curia stopped believing the unknown" are different facts.
    assert.equal(names.at(-1), 'credential_refresh_exhausted')
    assert.equal(events.at(-1)[1].attempts, TRANSIENT_RETRY_BOUND)
  })

  test('a success in between resets the count, so a flapping provider never reaches the bound', async () => {
    const events = []
    let fail = true
    // The fresh token keeps the SAME expiry, so the credential is still due and
    // the next call is still a real attempt.
    const b = brokerOn(async () => (fail
      ? new Response('gateway', { status: 503 })
      : new Response(JSON.stringify({ access_token: accessToken({ iat, exp }) }), { status: 200 })), events)

    for (let i = 1; i < TRANSIENT_RETRY_BOUND; i += 1) await b.refreshIfDue()
    fail = false
    assert.equal((await b.refreshIfDue()).refreshed, true)
    fail = true
    for (let i = 1; i < TRANSIENT_RETRY_BOUND; i += 1) await b.refreshIfDue()

    assert.equal(b.held, null)
    assert.ok(!events.some((e) => e[0] === 'credential_refresh_exhausted'))
  })

  // Adoption is the ONLY exit. The operator just proved intent by completing a
  // login; asking them to confirm again is ceremony.
  test('adoption lifts the hold and the broker exchanges again', async () => {
    let calls = 0
    const b = brokerOn(async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { code: 'refresh_token_reused' } }), { status: 401 })
    })
    await b.refreshIfDue()
    assert.equal(b.held.by, 'provider')

    b.adopt(authJson({ iat: exp - DAY, exp: exp + 9 * DAY, refresh: 'rt.fresh' }))
    assert.equal(b.held, null)
    assert.equal(b.state().held, null)
    assert.equal(b.state().last_error, null)

    // still inside the last quarter of the ADOPTED token? no — so prove the
    // latch is gone by putting a due credential back under it.
    b.adopt(authJson({ iat, exp }))
    await b.refreshIfDue()
    assert.equal(calls, 2, 'the wire is reachable again')
  })

  // #646 does not persist the hold: `armedCoolings` carries `{provider, at}`
  // rows and a hold has no `at`, so persisting it means inventing the sentinel
  // date the design refused. A fresh broker re-derives it in one call.
  test('a fresh broker starts unheld and re-arms from the provider’s own answer', async () => {
    const events = []
    const b = brokerOn(refused(401, 'refresh_token_invalidated'), events)
    await b.refreshIfDue()
    assert.equal(b.held.code, 'refresh_token_invalidated')

    const restarted = new CodexCredentialBroker({
      home: dir, now: () => exp - DAY,
      fetchImpl: refused(401, 'refresh_token_invalidated'),
      journal: () => {},
    })
    assert.equal(restarted.held, null, 'nothing is remembered across a restart')
    assert.equal((await restarted.refreshIfDue()).terminal, true, 'one call re-derives it')
  })

  test('the card says held, so nobody has to infer it from an expiry hours away', async () => {
    const b = brokerOn(refused(401, 'refresh_token_expired'))
    await b.refreshIfDue()
    const state = b.state()
    assert.equal(state.state, 'expiring', 'the token itself is still alive')
    assert.equal(state.held.by, 'provider')
    assert.match(state.held.why, /refresh_token_expired/)
  })
})

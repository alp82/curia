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
  codexTokenClock, codexAccessTokenExpiry, codexTokenIdentity, refreshMarginMs, refreshDue, credentialState,
  exchangeRefreshToken, applyRefresh, writeCredentialFile,
  CodexCredentialBroker, ReauthFlow,
  authSessionName, isAuthSession, scrapeDeviceAuth, reauthRunCmd,
  classifyRefreshFailure, TERMINAL_REFRESH_CODES, TRANSIENT_RETRY_BOUND, CODEX_PROVIDER,
  ANTHROPIC_PROVIDER, ANTHROPIC_DOCUMENTED_LIFETIME_MS, ANTHROPIC_EXPIRING_WINDOW_MS, ANTHROPIC_TOKEN_RE,
  anthropicStoreFile, claudeCredentialsJson, writeClaudeCredentials, deliveryExpiry,
  AnthropicCredentialStore, PROVIDER_CREDENTIALS, CONSUMER_CREDENTIALS, CONSUMER_NAMES,
  consumerContractFault, providerContractFault, SETUP_TOKEN_SCOPES, CLAUDE_CREDENTIAL_FILE,
  DeviceLoginLane, SetupTokenLane, setupTokenRunCmd, joinWrapped,
  scrapeAuthorizeUrl, scrapeSetupToken, checkAnthropicToken, ANTHROPIC_AUTHORIZE_HEAD,
} from '../src/credentials.mjs'
// #660 checks that the token under test is the one on the wire, and it asks with
// the headers `usage.mjs` owns.
import { MODELS_URL, OAUTH_BETA } from '../src/usage.mjs'

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

  // The safe identity facts integration setup records (#878): the opaque
  // account id and the plan, never the email in the profile claim and never
  // a token. An unreadable credential answers null for each.
  test('the identity facts are the account id and the plan, and nothing that is a person or a secret', () => {
    const iat = Date.parse('2026-08-23T13:35:23Z')
    const exp = iat + 10 * DAY
    const identity = codexTokenIdentity(authJson({ iat, exp, account: 'acct-42' }))
    assert.deepEqual(identity, { account_id: 'acct-42', plan_type: 'prolite', iat, exp })
    assert.deepEqual(codexTokenIdentity('not json'), { account_id: null, plan_type: null, iat: null, exp: null })
    assert.ok(!JSON.stringify(identity).includes('rt.old'))
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
    assert.deepEqual(scrapeDeviceAuth(pane), {
      url: 'https://auth.openai.com/codex/device', code: '83CC-A4ZTO', codeLifeMs: 15 * 60 * 1000,
    })
  })

  // #721: the fifteen is READ, not assumed. It decides whether a vanished
  // session is reported as a timeout or as an abandonment, and a number that
  // lives only in prose is one OpenAI can change without curia noticing.
  test('the code states its own lifetime, whatever the number is', () => {
    const said = (n) => scrapeDeviceAuth(pane.replace('15 minutes', n)).codeLifeMs
    assert.equal(said('20 minutes'), 20 * 60 * 1000)
    assert.equal(said('1 minute'), 60 * 1000)
  })

  // The miss falls back to the lane's declared lifetime rather than to zero: a
  // frame that says nothing must not make every ending look like a timeout.
  test('a frame that does not state the lifetime states null', () => {
    assert.equal(scrapeDeviceAuth(pane.replace('(expires in 15 minutes)', '')).codeLifeMs, null)
    assert.equal(scrapeDeviceAuth('expires in 15 minutes, somewhere else entirely').codeLifeMs, null)
    assert.equal(new DeviceLoginLane({ broker: null }).codeLifeMs, 15 * 60 * 1000)
  })

  // A card that shows four wrong characters sends the operator round the loop a
  // second time, so the pattern is anchored on codex's own sentence rather than
  // matched loosely. A pane with no code answers null, and the card degrades to
  // "open the terminal" — never to a dead end.
  test('a pane with no code yields no code, rather than something code-shaped', () => {
    const nothing = { url: null, code: null, codeLifeMs: null }
    assert.deepEqual(scrapeDeviceAuth('GPT-5.6 is READY-TO-GO and the LANE-IS-OPEN'), nothing)
    assert.deepEqual(scrapeDeviceAuth(''), nothing)
    assert.deepEqual(scrapeDeviceAuth(null), nothing)
  })

  test('a half-drawn pane gives what it has, and null for the rest', () => {
    assert.deepEqual(scrapeDeviceAuth('open https://auth.openai.com/codex/device now'), {
      url: 'https://auth.openai.com/codex/device', code: null, codeLifeMs: null,
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
      lanes: { openai: new DeviceLoginLane({ broker: new CodexCredentialBroker({ home: dir, now }) }) },
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
    const out = await f.start({ provider: 'openai' })
    assert.equal(out.started, true)
    assert.equal(out.session, 'curia-auth-openai')
    assert.equal(calls.spawned.length, 1)
    assert.match(calls.spawned[0].shellCmd, /codex login --device-auth/)
    assert.equal(f.state().state, 'waiting')
  })

  // One session per provider, enforced by the fixed name. Pressing the button
  // twice attaches to the first, which is what an operator on a phone expects.
  test('a second start attaches to the first rather than opening another', async () => {
    const { f, calls } = flow()
    await f.start({ provider: 'openai' })
    const again = await f.start({ provider: 'openai' })
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
    await f.start({ provider: 'openai' })
    assert.equal(fs.existsSync(path.join(cfgDir, 'auth.json')), false)
  })

  test('the card fills in from the pane, and the journal never carries the code', async () => {
    const events = []
    const { f, calls, sessions } = flow({ journal: (e, d) => events.push([e, d]) })
    await f.start({ provider: 'openai' })
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
    await f.start({ provider: 'openai' })
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
    await f.start({ provider: 'openai' })
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
    await f.start({ provider: 'openai' })
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
    await f.start({ provider: 'openai' })
    fs.writeFileSync(path.join(dir, 'cfg', 'curia-auth-openai', 'auth.json'), authJson({ iat, exp: iat + 10 * DAY }))
    now = iat + REAUTH_TIMEOUT_MS
    assert.equal((await f.poll()).state, 'done')
  })

  test('a session that is gone with no credential is reported, not forgotten', async () => {
    const events = []
    const { f, sessions } = flow({ journal: (e, d) => events.push([e, d]) })
    await f.start({ provider: 'openai' })
    sessions.delete('curia-auth-openai')
    assert.equal((await f.poll()).state, 'abandoned')
    assert.equal(events.at(-1)[0], 'reauth_abandoned')
  })

  // #721. Both endings present identically — the session is gone and no
  // credential arrived — and the code's own clock is the only thing on the box
  // that can tell them apart: codex logs neither ending, and the pane is gone
  // before the next tick can read it. Measured in
  // docs/live-checks/680-device-code-expiry.md; what is asserted here is the
  // rule, not the ending, because the ending cost two containers and half an
  // hour of wall clock.
  test('a session that vanishes AFTER the code ran out timed out, and says so', async () => {
    let now = 1_000_000_000_000
    const events = []
    const { f, sessions } = flow({ now: () => now, journal: (e, d) => events.push([e, d]) })
    await f.start({ provider: 'openai' })
    now += 15 * 60 * 1000
    sessions.delete('curia-auth-openai')
    const out = await f.poll()
    assert.equal(out.state, 'expired')
    assert.match(out.why, /one-time code ran out/)
    assert.equal(events.at(-1)[0], 'reauth_code_expired')
    assert.equal(events.at(-1)[1].code_life_s, 15 * 60)
    // and the card can still say it once the live flow is cleared
    f.clear()
    assert.equal(f.state(), null)
    assert.equal(f.ending.state, 'expired')
    assert.equal(f.ending.provider, 'openai')
  })

  test('a session that vanishes BEFORE the code ran out was closed, and says that instead', async () => {
    let now = 1_000_000_000_000
    const events = []
    const { f, sessions } = flow({ now: () => now, journal: (e, d) => events.push([e, d]) })
    await f.start({ provider: 'openai' })
    now += 15 * 60 * 1000 - 1
    sessions.delete('curia-auth-openai')
    const out = await f.poll()
    assert.equal(out.state, 'abandoned')
    assert.match(out.why, /closed before its code ran out/)
    assert.equal(events.at(-1)[0], 'reauth_abandoned')
  })

  // The pane outranks the lane, because the pane is the login speaking for
  // itself. A code codex says lives five minutes ends a vanished session at
  // five, not at the fifteen the lane declares.
  test('the lifetime the pane states is the one the ending is judged against', async () => {
    let now = 1_000_000_000_000
    const { f, sessions, calls } = flow({ now: () => now })
    await f.start({ provider: 'openai' })
    calls.pane = '2. Enter this one-time code (expires in 5 minutes)\n   83CC-A4ZTO\n'
    await f.poll()
    now += 5 * 60 * 1000
    sessions.delete('curia-auth-openai')
    assert.equal((await f.poll()).state, 'expired')
  })

  // A fresh login drops the last one's sentence, so the page never shows an
  // ending beside a live attempt.
  test('starting another login clears the ending the last one left', async () => {
    const { f, sessions } = flow()
    await f.start({ provider: 'openai' })
    sessions.delete('curia-auth-openai')
    await f.poll()
    f.clear()
    assert.equal(f.ending.state, 'abandoned')
    await f.start({ provider: 'openai' })
    assert.equal(f.ending, null)
  })

  // The window is the lane's, not the flow's (#721). Codex's fifteen always
  // arrives first, so the thirty has only ever been the anthropic lane's — and
  // a shared number one lane can never reach looks like a decision and is not.
  test('each lane declares its own window and its own code lifetime', () => {
    const codex = new DeviceLoginLane({ broker: null })
    const anthropic = new SetupTokenLane({ store: null })
    assert.equal(codex.windowMs, REAUTH_TIMEOUT_MS)
    assert.equal(anthropic.windowMs, REAUTH_TIMEOUT_MS)
    assert.equal(anthropic.codeLifeMs, null)
    assert.equal(anthropic.scrape('anything').codeLifeMs, null)
  })

  // The evidence rule the whole daemon runs on: an indeterminate tmux is not
  // absence.
  test('an indeterminate tmux ends nothing', async () => {
    const { f } = flow()
    await f.start({ provider: 'openai' })
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

// ---------------------------------------------------------------------------
// the anthropic store and the two contract tables (#648)
// ---------------------------------------------------------------------------
//
// Hermetic like everything above it: no test reaches Anthropic and none reads
// the box's own credential. What CANNOT be tested here is whether the claude CLI
// accepts the file this module writes — that is a measurement, and it lives in
// docs/live-checks/648-claude-credential-shape.md.

// A `setup-token` value, shaped like the real thing and reaching nothing.
const OAT = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OAT2 = 'sk-ant-oat01-bbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const storeOn = (over = {}) => new AnthropicCredentialStore({
  workspaceRoot: dir, now: () => Date.parse('2026-08-24T12:00:00Z'), ...over,
})

describe('the anthropic store (#648)', () => {
  test('the store is keyed by PROVIDER, and it is not the CLI own path', () => {
    assert.equal(anthropicStoreFile('/w'), '/w/credentials/anthropic.json')
    // Writing curia's record into `~/.claude/.credentials.json` would leave a
    // host session reading a file it did not write in a shape it did not expect.
    assert.ok(!anthropicStoreFile('/w').includes('.claude'))
  })

  test('adoption stamps `obtained_at`, and that is the only place it is stamped', () => {
    const s = storeOn()
    const record = s.adopt(OAT)
    assert.equal(record.obtained_at, '2026-08-24T12:00:00.000Z')
    assert.equal(record.seeded_at, null)
    assert.equal(s.read().token, OAT)
  })

  test('a legacy seeded record remains readable, and its row reads unknown', () => {
    const file = anthropicStoreFile(dir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({
      token: OAT,
      obtained_at: null,
      seeded_at: '2026-08-24T12:00:00.000Z',
    })}\n`)
    const s = storeOn()
    assert.equal(s.read().token, OAT)
    const row = s.state('claude')
    assert.equal(row.state, 'unknown')
    assert.equal(row.expires_at, null)
    assert.match(row.why, /sign in once/)
  })

  test('a value that is not a subscription token is refused on adoption', () => {
    const s = storeOn()
    assert.throws(() => s.adopt('sk-proj-an-api-key'), /sk-ant/)
    assert.equal(s.read(), null)
  })

  test('the store is written through a rename, at 0600, and never left half-written', () => {
    const s = storeOn()
    s.adopt(OAT)
    const file = anthropicStoreFile(dir)
    assert.equal(modeOf(file), HOST_CREDENTIAL_MODE)
    // A rename leaves no temp file behind for a sweep to find a live token in.
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['anthropic.json'])
  })

  test('an adopted credential states an expiry from the DOCS, and says so', () => {
    const at = Date.parse('2026-08-24T12:00:00Z')
    const s = storeOn()
    s.adopt(OAT)
    const row = s.state('claude')
    assert.equal(row.state, 'valid')
    assert.equal(Date.parse(row.expires_at), at + ANTHROPIC_DOCUMENTED_LIFETIME_MS)
    assert.match(row.why, /documented one-year lifetime/)
    assert.match(row.why, /not a date the token states/)
  })

  test('`expiring` is a month out, not a quarter of a year — nothing refreshes on this lane', () => {
    const adopted = Date.parse('2026-08-24T12:00:00Z')
    const at = (ms) => storeOn({ now: () => ms }).state('claude').state
    storeOn().adopt(OAT)
    const ends = adopted + ANTHROPIC_DOCUMENTED_LIFETIME_MS
    assert.equal(at(ends - ANTHROPIC_EXPIRING_WINDOW_MS - 1000), 'valid')
    assert.equal(at(ends - ANTHROPIC_EXPIRING_WINDOW_MS + 1000), 'expiring')
    assert.equal(at(ends + 1000), 'expired')
  })

  test('both rows name the same store, because both consumers run on one account', () => {
    const s = storeOn()
    s.adopt(OAT)
    const claude = s.state('claude')
    const overseer = s.state('overseer')
    assert.equal(claude.store, overseer.store)
    assert.equal(claude.provider, ANTHROPIC_PROVIDER)
    assert.equal(overseer.provider, ANTHROPIC_PROVIDER)
    assert.equal(claude.expires_at, overseer.expires_at, 'two stores would be two answers free to disagree')
  })
})

describe('the file the claude CLI reads (#648, measured by the live check)', () => {
  const record = { token: OAT, obtained_at: '2026-08-24T12:00:00.000Z', seeded_at: null }

  test('all three measured fields are written, and nothing else is', () => {
    // Measured on the box: accessToken alone is refused, accessToken plus a
    // future expiresAt is refused, and accessToken + expiresAt + a non-empty
    // scopes array authenticates. `subscriptionType` is not one of the three.
    const written = JSON.parse(claudeCredentialsJson(record)).claudeAiOauth
    assert.deepEqual(Object.keys(written).sort(), ['accessToken', 'expiresAt', 'scopes'])
    assert.equal(written.accessToken, OAT)
    assert.deepEqual(written.scopes, [...SETUP_TOKEN_SCOPES])
  })

  test('the expiresAt is in the future, because the CLI refuses a date already past', () => {
    const written = JSON.parse(claudeCredentialsJson(record)).claudeAiOauth
    assert.equal(written.expiresAt, Date.parse(record.obtained_at) + ANTHROPIC_DOCUMENTED_LIFETIME_MS)
    assert.ok(written.expiresAt > Date.now())
  })

  test('a SEEDED credential still gets a future date — from the seed instant, not an invented age', () => {
    // The ROW reads `unknown` for a seed, because curia knows no age for it. The
    // FILE has no such freedom: a missing or past `expiresAt` reads as no
    // credential at all, and on this lane that is a fleet that cannot spawn.
    const seed = { token: OAT, obtained_at: null, seeded_at: '2026-08-24T12:00:00.000Z' }
    assert.equal(deliveryExpiry(seed), Date.parse(seed.seeded_at) + ANTHROPIC_DOCUMENTED_LIFETIME_MS)
    assert.equal(PROVIDER_CREDENTIALS.anthropic.credentialExpiry(seed), null, 'and the row still states nothing')
  })

  test('a record with neither instant is refused rather than written with no date', () => {
    assert.throws(() => claudeCredentialsJson({ token: OAT }), /expiresAt/)
    assert.throws(() => claudeCredentialsJson({ token: 'sk-proj-key' }), /sk-ant/)
  })

  test('the agent copy is written through a rename, at 0600 and not 0400', () => {
    // The codex copy is 0400 because the AGENT must not rotate it. A
    // `setup-token` credential has nothing to rotate, and the live check
    // measured the file untouched across four authenticated runs.
    const cfgDir = path.join(dir, 'cfg', 'curia-1')
    fs.mkdirSync(cfgDir, { recursive: true })
    const file = writeClaudeCredentials(cfgDir, record)
    assert.equal(file, path.join(cfgDir, CLAUDE_CREDENTIAL_FILE))
    assert.equal(modeOf(file), HOST_CREDENTIAL_MODE)
  })
})

describe('the fan-out to live claude agents (#648)', () => {
  const seedClaude = (session) => {
    const cfgDir = path.join(dir, 'cfg', session)
    fs.mkdirSync(cfgDir, { recursive: true })
    return { session, cfgDir, harness: 'claude' }
  }

  test('it CREATES the file where there is none — the agents that predate the slice', () => {
    // The codex fan-out skips a config dir with no `auth.json`, because that
    // file is its evidence. Here the absence is the ordinary case: every agent
    // spawned before this slice got its credential in an environment variable,
    // and #659 measured that writing a file into such an agent heals it.
    const s = storeOn()
    s.adopt(OAT)
    const a = seedClaude('curia-1')
    const { healed, errors } = s.fanOut([a])
    assert.deepEqual(healed, ['curia-1'])
    assert.deepEqual(errors, [])
    assert.equal(JSON.parse(fs.readFileSync(path.join(a.cfgDir, CLAUDE_CREDENTIAL_FILE), 'utf8')).claudeAiOauth.accessToken, OAT)
  })

  test('a codex agent never grows a claude credential it cannot use', () => {
    const s = storeOn()
    s.adopt(OAT)
    const codex = { ...seedClaude('curia-2'), harness: 'codex' }
    assert.deepEqual(s.fanOut([codex]).healed, [])
    assert.equal(fs.existsSync(path.join(codex.cfgDir, CLAUDE_CREDENTIAL_FILE)), false)
  })

  test('a byte-identical file is not rewritten, so a steady box does no disk writes', () => {
    const s = storeOn()
    s.adopt(OAT)
    const a = seedClaude('curia-3')
    assert.deepEqual(s.fanOut([a]).healed, ['curia-3'])
    assert.deepEqual(s.fanOut([a]).healed, [], 'the returned list means "these agents just changed"')
  })

  test('an empty store heals nobody rather than writing an empty credential', () => {
    assert.deepEqual(storeOn().fanOut([seedClaude('curia-4')]), { healed: [], errors: [] })
  })
})

describe('the two contract tables (#648)', () => {
  test('every consumer names a provider that exists and a delivery curia can perform', () => {
    for (const consumer of CONSUMER_NAMES) {
      assert.equal(consumerContractFault(consumer), null, consumer)
    }
    assert.deepEqual(CONSUMER_NAMES, ['codex', 'claude', 'overseer'], 'three consumers, and the overseer is not a harness')
  })

  test('the anthropic lane declares `refresh: null`, which is a statement and not a gap', () => {
    assert.equal(PROVIDER_CREDENTIALS.anthropic.refresh, null)
    assert.equal(typeof PROVIDER_CREDENTIALS.openai.refresh, 'function')
  })

  test('the claude row and the overseer row point at ONE provider, and both take a copy in their config dir', () => {
    assert.equal(CONSUMER_CREDENTIALS.claude.provider, ANTHROPIC_PROVIDER)
    assert.equal(CONSUMER_CREDENTIALS.overseer.provider, ANTHROPIC_PROVIDER)
    assert.equal(CONSUMER_CREDENTIALS.claude.deliver.how, 'config-dir')
    // #867: the overseer used to read the store behind a read-only mount. Under
    // an installation root the store is one file in `secrets/`, and the
    // container that holds a shell gets no mount of that boundary.
    assert.equal(CONSUMER_CREDENTIALS.overseer.deliver.how, 'config-dir')
    assert.equal(CONSUMER_CREDENTIALS.overseer.deliver.file, CONSUMER_CREDENTIALS.claude.deliver.file)
    assert.equal(CONSUMER_CREDENTIALS.claude.heal, 'in-place')
    assert.equal(CONSUMER_CREDENTIALS.overseer.heal, 'in-place')
  })

  test('a consumer curia cannot deliver to is named rather than discovered at dispatch', () => {
    // The fault reader is what `config.mjs` refuses a boot on, so the suite
    // drives it directly rather than reconstructing the message.
    assert.match(consumerContractFault('nobody'), /no row in CONSUMER_CREDENTIALS/)
  })

  test('a harness on a provider with no contract row refuses the boot, and says which', () => {
    // The guard for the harness nobody has added yet: it cannot fire against
    // the shipped table, which is exactly why the reader is tested here and the
    // shipped table is asserted clean in config.test.mjs.
    assert.equal(providerContractFault('claude', ANTHROPIC_PROVIDER), null)
    assert.equal(providerContractFault('codex', CODEX_PROVIDER), null)
    const fault = providerContractFault('gemini', 'google')
    assert.match(fault, /harnesses\.gemini runs on provider "google"/)
    assert.match(fault, /would get no model credential/)
    assert.match(fault, /anthropic/, 'and it names the providers that do have a row')
  })

  test('the token pattern admits a subscription token and refuses an API key', () => {
    assert.ok(ANTHROPIC_TOKEN_RE.test(OAT))
    assert.ok(!ANTHROPIC_TOKEN_RE.test('sk-proj-abcdefghijklmnopqrstuvwxyz'))
    assert.ok(!ANTHROPIC_TOKEN_RE.test('sk-ant-short'))
  })
})

// ---------------------------------------------------------------------------
// the setup-token lane (#660)
// ---------------------------------------------------------------------------
//
// The lane that reads its credential off a rendered TUI, and every fixture below
// is a MEASUREMENT rather than a guess about one.
//
//   - `WAITING_60` is the verbatim `tmux capture-pane -p` of a real `claude
//     setup-token` at 60 columns, run on the workstation on 2026-08-24 and
//     abandoned at the paste prompt. Nothing was minted for it.
//   - `successFrame` is laid out from the render tree read out of the BOX's own
//     agent image, `curia-agent:2.1.220-0.146.0-7cba0f7a` — the `setup-token`
//     success state is a column of bare Ink `Text` children with `gap: 1`, the
//     token one of them, no border and no prefix.
//
// What is NOT here, and the record says so rather than implying coverage: a
// frame from a login that actually completed. The layout is measured, the wrap
// is measured, and the token's presence among those lines is inference — which
// is exactly why `SetupTokenLane` asks Anthropic before it adopts anything.

const WAITING_60 = [
  'Welcome to Claude Code v2.1.241',
  '',
  ' This will guide you through long-lived (1-year) auth token',
  ' setup for your Claude account. Claude subscription',
  ' required.',
  '',
  " Browser didn't open? Use the url below to sign  (c to copy)",
  ' in',
  '',
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9',
  'd1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redir',
  'ect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fc',
  'allback&scope=user%3Ainference&code_challenge=gBwSYcCCQjC9xU',
  'Dnje4H0Limz_8WGf6LWi9KonM8CDU&code_challenge_method=S256&sta',
  'te=9oq-pmO4pEY1t4nD2prvbnqYYqlSkptF03z3EABHPaA',
  '',
  '',
  ' Paste code here if prompted >',
].join('\n')

// 108 characters, which is what the box's own credential measures.
const LIVE_OAT = `sk-ant-oat01-${'x'.repeat(85)}_-abc7AB89`

function successFrame(paneWidth, token = LIVE_OAT) {
  const pad = (s) => ` ${s}`
  const content = paneWidth - 1 // Ink indents the frame one column
  const pieces = []
  for (let i = 0; i < token.length; i += content) pieces.push(token.slice(i, i + content))
  return [
    'Welcome to Claude Code v2.1.220',
    '',
    pad('✓ Long-lived authentication token created successfully!'),
    '',
    pad('Your OAuth token (valid for 1 year):'),
    '',
    ...pieces.map(pad),
    '',
    pad("Store this token securely. You won't be able to see it again."),
    '',
    pad('Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>'),
    '',
    'curia@box:/cfg$ ',
  ].join('\n')
}

describe('putting a wrapped TUI value back together (#660)', () => {
  // Rule 1: a short line ended the run. Without it a rejoin walks into the
  // paragraph underneath.
  test('a run stops at the first piece shorter than the ones before it', () => {
    const lines = ['aaaa', 'aaaa', 'bb', 'cccc']
    assert.equal(joinWrapped(lines, 0, () => true), 'aaaaaaaabb')
  })

  // Rule 2: the charset ended the run. Ink's `gap: 1` puts a blank line after
  // every child, and a blank line is not a continuation of anything.
  test('a run stops at a line the continuation test rejects', () => {
    const lines = ['aaaa', 'aaaa', '', 'aaaa']
    assert.equal(joinWrapped(lines, 0, (l) => /^[a-z]+$/.test(l)), 'aaaaaaaa')
  })

  // BOTH guards are load-bearing. A value whose length is an exact multiple of
  // the wrap width ends on a full-width piece, so rule 1 alone would run on.
  test('a value that ends exactly on the wrap boundary still stops', () => {
    const lines = ['aaaa', 'aaaa', '', 'zzzz']
    assert.equal(joinWrapped(lines, 0, (l) => /^[a-z]+$/.test(l)), 'aaaaaaaa')
  })
})

describe('reading the anthropic login pane (#660)', () => {
  test('the authorize URL comes back whole from a real 60-column capture', () => {
    const url = scrapeAuthorizeUrl(WAITING_60)
    assert.ok(url.startsWith(ANTHROPIC_AUTHORIZE_HEAD))
    const parsed = new URL(url)
    // The bound #180 bought, visible in the request curia reassembled.
    assert.equal(parsed.searchParams.get('scope'), 'user:inference')
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(parsed.searchParams.get('state'), '9oq-pmO4pEY1t4nD2prvbnqYYqlSkptF03z3EABHPaA')
  })

  // A reassembly that ran long lands its junk in the last parameter, and a link
  // that fails after the operator has already opened it is worse than no link.
  test('a URL missing the PKCE parameters is not offered', () => {
    assert.equal(scrapeAuthorizeUrl(`${ANTHROPIC_AUTHORIZE_HEAD}code=true`), null)
  })

  test('the waiting frame holds no token, and curia does not invent one', () => {
    assert.equal(scrapeSetupToken(WAITING_60), null)
  })

  // The whole point of the lane. A 108-character token wraps on every pane
  // narrower than itself and does not on a wide one, and both go back together.
  for (const width of [40, 60, 80, 110, 200]) {
    test(`the token comes back whole from a ${width}-column success frame`, () => {
      assert.equal(scrapeSetupToken(successFrame(width)), LIVE_OAT)
    })
  }

  // 108 = 4 × 27, so at 28 columns the last piece is full width.
  test('a token that ends exactly on the wrap boundary comes back whole', () => {
    assert.equal(scrapeSetupToken(successFrame(28)), LIVE_OAT)
  })

  // The line below the token holds the literal string `<token>` and not the
  // value, so the frame's own instructions can never be read as a credential.
  test('the export line under the token is not mistaken for one', () => {
    const frame = successFrame(200)
    assert.ok(frame.includes('CLAUDE_CODE_OAUTH_TOKEN=<token>'))
    assert.equal(scrapeSetupToken(frame), LIVE_OAT)
  })

  test('a frame with no `sk-ant-` line at all reads as not finished', () => {
    assert.equal(scrapeSetupToken('nothing here\n\nnor here\n'), null)
  })
})

describe('asking Anthropic whether the scrape is right (#660)', () => {
  const check = (impl) => checkAnthropicToken(OAT, { fetchImpl: impl })

  test('a 200 adopts', async () => {
    assert.deepEqual(await check(async () => ({ ok: true, status: 200 })), {
      ok: true, retry: false, why: 'Anthropic accepted the token',
    })
  })

  // The credential the header carries is the one being checked, not the box's.
  test('the request carries the token under test and the oauth beta header', async () => {
    let seen = null
    await checkAnthropicToken(OAT2, { fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200 } } })
    assert.equal(seen.url, MODELS_URL)
    assert.equal(seen.init.headers.authorization, `Bearer ${OAT2}`)
    assert.equal(seen.init.headers['anthropic-beta'], OAUTH_BETA)
  })

  // The expensive failure this exists to stop: a mis-read frame reassembled into
  // something that passes the prefix check and is not a credential.
  for (const status of [401, 403]) {
    test(`a ${status} is terminal — the store is not touched`, async () => {
      const out = await check(async () => ({ ok: false, status }))
      assert.equal(out.ok, false)
      assert.equal(out.retry, false)
      assert.match(out.why, /read the frame wrong/)
    })
  }

  // A network that blinked proves nothing about the token, and treating it as a
  // refusal would throw away a good login.
  test('an unreachable provider is a retry, not a verdict', async () => {
    const out = await check(async () => { throw new Error('ECONNRESET') })
    assert.equal(out.retry, true)
    assert.match(out.why, /could not reach Anthropic/)
  })

  test('a 500 is a retry, not a verdict', async () => {
    assert.equal((await check(async () => ({ ok: false, status: 500 }))).retry, true)
  })
})

describe('the setup-token lane (#660)', () => {
  const laneOn = (over = {}) => {
    const s = storeOn()
    return { s, lane: new SetupTokenLane({ store: s, check: async () => ({ ok: true, retry: false }), ...over }) }
  }

  test('the container runs `claude setup-token` with its config home pointed at the mount', () => {
    const cmd = setupTokenRunCmd({
      name: 'curia-auth-anthropic', image: 'curia-agent:test', cfgDir: '/w/cfg/curia-auth-anthropic', agentUid: 1000,
    })
    assert.match(cmd, /claude setup-token$/)
    assert.match(cmd, /-e CLAUDE_CONFIG_DIR=\/cfg/)
    assert.match(cmd, /--user 1000:1000/)
    assert.match(cmd, /--name curia-auth-anthropic/)
    // NO CREDENTIAL REACHES IT. A login must not run against the token it is
    // replacing, and the pane must not be able to show one that was already here.
    assert.ok(!cmd.includes('CLAUDE_CODE_OAUTH_TOKEN'))
    assert.ok(!cmd.includes('ANTHROPIC_API_KEY'))
    // Unlabelled, so `#sweepContainers` never collects a half-finished login.
    assert.ok(!cmd.includes('curia.session'))
  })

  test('the same shell-safety refusal guards both lanes', () => {
    assert.throws(() => setupTokenRunCmd({ name: 'curia-auth-anthropic; rm -rf /', image: 'i', cfgDir: '/c', agentUid: 1 }), /not shell-safe/)
  })

  test('a pane with no token yet is not completion', async () => {
    const { lane, s } = laneOn()
    assert.equal(await lane.finish({ pane: WAITING_60 }), null)
    assert.equal(s.read(), null)
  })

  test('a token Anthropic accepts is adopted, and the row gets a real date', async () => {
    const { lane, s } = laneOn()
    const out = await lane.finish({ pane: successFrame(60) })
    assert.equal(s.read().token, LIVE_OAT)
    assert.equal(s.read().obtained_at, '2026-08-24T12:00:00.000Z')
    assert.equal(s.state('claude').state, 'valid')
    // The flow reports an expiry and never a token.
    assert.equal(out.expiresAt, Date.parse('2026-08-24T12:00:00Z') + ANTHROPIC_DOCUMENTED_LIFETIME_MS)
    assert.equal(JSON.stringify(out).includes(LIVE_OAT), false)
  })

  // The store is left EXACTLY as it was. A fleet running on a good credential
  // must not lose it to a login that read a frame wrong.
  test('a token Anthropic rejects throws, and the store keeps what it had', async () => {
    const { lane, s } = laneOn({ check: async () => ({ ok: false, retry: false, why: 'Anthropic answered HTTP 401' }) })
    s.adopt(OAT)
    await assert.rejects(() => lane.finish({ pane: successFrame(60) }), /401/)
    assert.equal(s.read().token, OAT)
  })

  test('a check that could not be made waits for the next tick rather than failing', async () => {
    const { lane, s } = laneOn({ check: async () => ({ ok: false, retry: true, why: 'unreachable' }) })
    assert.equal(await lane.finish({ pane: successFrame(60) }), null)
    assert.equal(s.read(), null, 'nothing is stored on a verdict curia never got')
  })

  test('the operator types on this lane, and does not on the codex one', () => {
    assert.equal(new SetupTokenLane({ store: storeOn() }).typed, true)
    assert.equal(new DeviceLoginLane({ broker: null }).typed, false)
  })

  // There is no code to READ on this lane — the operator puts one in. Inventing
  // a field for it would put a wrong value on the card.
  test('the card carries the link and no code', () => {
    const { url, code } = new SetupTokenLane({ store: storeOn() }).scrape(WAITING_60)
    assert.ok(url.startsWith(ANTHROPIC_AUTHORIZE_HEAD))
    assert.equal(code, null)
  })
})

describe('the flow drives either lane (#660)', () => {
  function anthropicFlow({ check = async () => ({ ok: true, retry: false }) } = {}) {
    const now = () => Date.parse('2026-08-24T12:00:00Z')
    const calls = { spawned: [], killed: [], stopped: [], pane: '' }
    const sessions = new Set()
    const events = []
    const s = new AnthropicCredentialStore({ workspaceRoot: dir, now })
    const f = new ReauthFlow({
      lanes: {
        openai: new DeviceLoginLane({ broker: new CodexCredentialBroker({ home: dir, now }) }),
        anthropic: new SetupTokenLane({ store: s, check }),
      },
      image: 'curia-agent:test',
      agentUid: 1000,
      cfgDirFor: (session) => path.join(dir, 'cfg', session),
      newSession: async (opts) => { calls.spawned.push(opts); sessions.add(opts.name) },
      capturePane: async () => calls.pane,
      killSession: async (name) => { calls.killed.push(name); sessions.delete(name) },
      hasSession: async (name) => sessions.has(name),
      stopContainer: async (name) => { calls.stopped.push(name) },
      now,
      journal: (e, d) => events.push([e, d]),
    })
    return { f, calls, sessions, events, store: s }
  }

  test('the anthropic session is named by the PROVIDER, and the two consumers share it', async () => {
    const { f, calls } = anthropicFlow()
    const out = await f.start({ provider: 'anthropic' })
    assert.equal(out.session, 'curia-auth-anthropic')
    assert.match(calls.spawned[0].shellCmd, /claude setup-token/)
    assert.equal(f.state().provider, 'anthropic')
    assert.equal(f.state().typed, true)
  })

  test('a provider with no lane is refused by name', async () => {
    const { f } = anthropicFlow()
    await assert.rejects(() => f.start({ provider: 'gemini' }), /no re-authentication lane for provider "gemini"/)
  })

  // End to end on the lane whose completion signal is the PANE (#659 §3): the
  // credential file ADR-0027 detects does not exist here.
  test('the token appearing in the pane completes the flow, adopts it, and tears the session down', async () => {
    const { f, calls, sessions, events, store } = anthropicFlow()
    await f.start({ provider: 'anthropic' })
    calls.pane = WAITING_60
    assert.equal(await f.poll(), null, 'the link is up but nothing has completed')
    assert.ok(f.state().url.startsWith(ANTHROPIC_AUTHORIZE_HEAD))

    calls.pane = successFrame(80)
    const out = await f.poll()

    assert.equal(out.state, 'done')
    assert.equal(out.provider, 'anthropic')
    assert.equal(store.read().token, LIVE_OAT)
    // The pane held a plaintext year-long credential; the teardown is what takes
    // the last copy off the box.
    assert.deepEqual(calls.killed, ['curia-auth-anthropic'])
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(calls.stopped, ['curia-auth-anthropic'])
    assert.equal(fs.existsSync(path.join(dir, 'cfg', 'curia-auth-anthropic')), false)
    assert.equal(sessions.has('curia-auth-anthropic'), false)
  })

  // THE ONE THAT MATTERS MOST. A device code is a fifteen-minute secret and the
  // journal already refuses it; this token is good for a year.
  test('the token reaches the store and NOTHING else — not the journal, not the card', async () => {
    const { f, calls, events } = anthropicFlow()
    await f.start({ provider: 'anthropic' })
    calls.pane = successFrame(60)
    await f.poll()
    assert.equal(JSON.stringify(events).includes(LIVE_OAT), false, 'a year-long credential must never reach the journal')
    assert.equal(JSON.stringify(f.state() ?? {}).includes(LIVE_OAT), false)
    assert.equal(events.at(-1)[0], 'reauth_completed')
    assert.equal(events.at(-1)[1].provider, 'anthropic')
  })

  // A rejected token ends the flow loudly and leaves the fleet on what it had.
  test('a token the provider rejects ends the flow as failed', async () => {
    const { f, calls, store } = anthropicFlow({ check: async () => ({ ok: false, retry: false, why: 'Anthropic answered HTTP 401' }) })
    await f.start({ provider: 'anthropic' })
    calls.pane = successFrame(60)
    const out = await f.poll()
    assert.equal(out.state, 'failed')
    assert.match(out.why, /401/)
    assert.equal(store.read(), null)
  })

  // Both are `curia-auth-` sessions, so the five sweep guards cover the new one
  // for free — that is the whole reason it is one flow and not two.
  test('the anthropic session is an auth session to every guard that asks', () => {
    assert.equal(isAuthSession(authSessionName('anthropic')), true)
    assert.equal(authSessionName('anthropic'), 'curia-auth-anthropic')
  })
})

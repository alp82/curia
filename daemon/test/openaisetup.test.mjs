// The OpenAI half of the model-provider card of integration setup (#878,
// filling the #874 seam under the #852 contract).
//
// What is pinned: setup starts the existing subscription sign-in (the codex
// device login the dispatcher already runs) and adds no API-key path; the
// credential lands in `secrets/codex-auth.json` by that login and comes back
// in no answer, no log, and no refusal; the panel's own read is presence
// only plus the one-time link and code the live login shows; verification
// is one minimal model request against the Codex backend, timed, recording
// the opaque account id, the plan, the model, the response id, and the
// timing; a verified credential applies the routing preset once and reports
// routing readiness; every miss is one failed verification with one action,
// and a retry measures again. Nothing here touches the network: OpenAI is a
// fake `fetch`.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeSecret } from '../../cli/src/secrets.mjs'
import { loadRoutingConfig } from '../src/config.mjs'
import { OpenAISetup, CODEX_RESPONSES_URL, VERIFY_PROMPT } from '../src/openaisetup.mjs'

const DAY = 24 * 60 * 60 * 1000
const REFRESH = 'rt.this-refresh-token-must-never-be-shown-anywhere'

function accessToken({ iat, exp, plan = 'pro', account = 'acct-42' }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iat: Math.floor(iat / 1000), exp: Math.floor(exp / 1000),
    'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_account_id: account },
    'https://api.openai.com/profile': { email: 'person@example.com' },
  })}.sig-that-must-never-be-shown`
}

function authJson({ iat = Date.now() - DAY, exp = Date.now() + 9 * DAY, account = 'acct-42' } = {}) {
  return `${JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: 'id.old', access_token: accessToken({ iat, exp, account }), refresh_token: REFRESH, account_id: account },
    last_refresh: new Date(iat).toISOString(),
  }, null, 2)}\n`
}

const SECRETS = (text) => [REFRESH, 'sig-that-must-never-be-shown', 'person@example.com', ...(text ? [JSON.parse(text).tokens.access_token] : [])]

const BASE = [
  'defaults:',
  '  research: {model: gpt, effort: high}',
  '  untyped: {model: opus, effort: high}',
  'models:',
  '  opus: { provider: anthropic, harness: claude }',
  '  gpt: { provider: openai, harness: codex, id: gpt-5.6-sol, reasoning_effort: high }',
  'fallbacks:',
  '  opus: [gpt]',
  '  gpt: [opus]',
  'harnesses:',
  '  claude:',
  '    template: claude --model {model} "$(cat {prompt_file})"',
  '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
  "    ready: '⏵⏵|bypass permissions'",
  '    tool_channel_grace_s: 15',
  '  codex:',
  '    template: codex --model {model} "$(cat {prompt_file})"',
  '    resume_template: codex resume --last --model {model} "Continue the interrupted work."',
  "    ready: '·\\s[~/]'",
  '    tool_channel_grace_s: 20',
  '',
].join('\n')

// The SSE stream the Codex backend answers a streamed response with.
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const completed = (over = {}) => sse([
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-sol' } },
  { type: 'response.output_text.delta', delta: 'OK' },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.6-sol', usage: { input_tokens: 12, output_tokens: 1 }, ...over } },
])

// An OpenAI that answers by turn: each entry is one answer, in order, and
// the last one repeats. Every call is recorded with its headers and body.
function openai(answers) {
  const calls = []
  let n = 0
  const fetchImpl = async (url, init = {}) => {
    const answer = answers[Math.min(n++, answers.length - 1)]
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null })
    if (answer instanceof Error) throw answer
    return {
      status: answer.status ?? 200,
      ok: (answer.status ?? 200) < 300,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (answer.contentType ?? 'text/event-stream') : null) },
      text: async () => answer.body ?? '',
    }
  }
  return { fetchImpl, calls }
}

let tmp
let root
let routingFile
let localFile
let logged
let applied
let routing
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-openaisetup-'))
  root = path.join(tmp, 'root')
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(root, 'state'), { recursive: true, mode: 0o700 })
  routingFile = path.join(tmp, 'routing.yaml')
  fs.writeFileSync(routingFile, BASE)
  localFile = path.join(root, 'state', 'routing.local.yaml')
  logged = []
  applied = []
  routing = loadRoutingConfig(routingFile, { localFile })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

// A login lane in the shape the dispatcher's flow presents: what the live
// flow says, the ending the last one left, and the start that answers
// curia's own sentence.
function lane() {
  const l = {
    calls: [],
    flow: null,
    ending: null,
    said: '🔑 signing `openai` back in. Open the session and follow the two lines codex prints.',
  }
  l.login = {
    state: () => l.flow,
    ending: () => l.ending,
    start: async (opts) => { l.calls.push(opts); return l.said },
  }
  return l
}

function setup({ answers = [{ body: completed() }], theLane = lane(), rootless = false, over = {} } = {}) {
  const ai = openai(answers)
  const s = new OpenAISetup({
    root: rootless ? null : root,
    authFile: rootless ? path.join(tmp, 'auth.json') : path.join(root, 'secrets', 'codex-auth.json'),
    credentialFiles: { openai: rootless ? path.join(tmp, 'auth.json') : path.join(root, 'secrets', 'codex-auth.json'), anthropic: path.join(root, 'secrets', 'anthropic.json') },
    routing: { file: routingFile, localFile, live: () => routing, apply: (next) => { applied.push(next); routing = next } },
    login: theLane.login,
    fetchImpl: ai.fetchImpl,
    codexVersion: '0.151.0',
    log: (line) => logged.push(String(line)),
    ...over,
  })
  return { s, ai, lane: theLane }
}

const noSecret = (text, ...blobs) => {
  for (const value of SECRETS(text)) {
    for (const blob of blobs) assert.ok(!JSON.stringify(blob).includes(value), `carries a secret: ${value.slice(0, 12)}…`)
  }
}

describe('the OpenAI card (#878)', () => {
  test('without a credential the card is plain, and the panel read says absent and offers the sign-in, never a key field', async () => {
    const { s } = setup()
    assert.deepEqual(await s.verifier()({ progress: {} }), { ok: false, unconnected: true })
    const o = s.overview()
    assert.deepEqual(o.secret, { state: 'absent' })
    assert.equal(o.identity, null)
    assert.equal(o.login, null)
    assert.equal(o.routing.ready, false)
    assert.ok(!Object.keys(o).some((k) => /key/i.test(k)))
  })

  test('the sign-in handoff starts the codex device login through the dispatcher, once, and the panel shows the link and the code while it waits', async () => {
    const { s, lane: l } = setup()
    const out = await s.startLogin()
    assert.deepEqual(l.calls, [{ provider: 'openai', by: 'setup' }])
    assert.equal(out.started, true)
    assert.match(out.said, /signing `openai` back in/)
    l.flow = { provider: 'openai', session: 'curia-auth-openai', state: 'waiting', url: 'https://auth.openai.com/codex/device', code: '83CC-A4ZTO', typed: false, terminal_url: 'https://box.tail1234.ts.net:8446/?arg=curia-auth-openai', seconds_left: 840 }
    const o = s.overview()
    assert.equal(o.login.code, '83CC-A4ZTO')
    assert.equal(o.login.url, 'https://auth.openai.com/codex/device')
    assert.equal(o.secret.state, 'absent')
  })

  // The rehearsal (#891) watched the row say the pane had not printed the
  // link for about a minute, and the connected state arrive a minute after
  // the browser finished: the flow was polled on the 60 s dispatch tick alone.
  // The panel's read polls the flow itself while a login is live, so the
  // link, the code, and the adoption land on the page's own cadence.
  test('the panel read polls the live login, at most once per gap, and the read after the adoption shows the login gone', async () => {
    const l = lane()
    let polls = 0
    let clock = 1_000_000
    l.login.poll = async () => { polls += 1; if (polls === 2) l.flow = null; return null }
    const { s } = setup({ theLane: l, over: { now: () => new Date(clock) } })
    assert.equal((await s.read()).login, null)
    assert.equal(polls, 0, 'nothing to poll without a login')
    l.flow = { provider: 'openai', session: 'curia-auth-openai', state: 'waiting', url: null, code: null, typed: false, terminal_url: null, seconds_left: 840 }
    const first = await s.read()
    assert.equal(polls, 1)
    assert.equal(first.login.state, 'waiting')
    clock += 500
    await s.read()
    assert.equal(polls, 1, 'a read inside the gap does not poll again')
    clock += 3000
    const after = await s.read()
    assert.equal(polls, 2)
    assert.equal(after.login, null, 'the adoption is on the read that polled it')
  })

  test('the first read of the row prepares the agent image, once', async () => {
    const l = lane()
    let prepared = 0
    l.login.prepare = async () => { prepared += 1 }
    const { s } = setup({ theLane: l })
    await s.read()
    await s.read()
    assert.equal(prepared, 1)
  })

  test('a refused start is reported as curia\'s own sentence and starts nothing twice', async () => {
    const l = lane()
    l.said = '❌ this daemon runs no containers, so it has nothing to run the login in'
    const { s } = setup({ theLane: l })
    const out = await s.startLogin()
    assert.equal(out.started, false)
    assert.match(out.said, /runs no containers/)
    assert.equal(s.overview().said, out.said)
  })

  test('a credential the login landed verifies on the next read: one minimal request on the Codex backend, as codex sends it, and the token is in no answer and no log line', async () => {
    const text = authJson()
    writeSecret(root, 'codex-auth.json', text)
    const { s, ai } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.equal(ai.calls.length, 1)
    const [call] = ai.calls
    assert.equal(call.url, CODEX_RESPONSES_URL)
    assert.equal(call.method, 'POST')
    assert.equal(call.headers.authorization, `Bearer ${JSON.parse(text).tokens.access_token}`)
    assert.equal(call.headers['chatgpt-account-id'], 'acct-42')
    assert.equal(call.headers['openai-beta'], 'responses=experimental')
    assert.equal(call.headers.originator, 'codex_cli_rs')
    assert.equal(call.headers.accept, 'text/event-stream')
    assert.equal(call.body.model, 'gpt-5.6-sol')
    assert.equal(call.body.stream, true)
    assert.equal(call.body.store, false)
    assert.deepEqual(call.body.tools, [])
    assert.deepEqual(call.body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: VERIFY_PROMPT }] }])
    noSecret(text, answer, s.overview(), logged)
  })

  test('the connected answer is the provider, the timed request, and the safe facts: account id, plan, expiry, model, response id, usage, routing', async () => {
    const text = authJson({ exp: Date.parse('2026-09-11T10:00:00Z') })
    writeSecret(root, 'codex-auth.json', text)
    const { s } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, true)
    assert.equal(answer.primary, 'OpenAI')
    assert.equal(answer.emoji, '⚡')
    assert.match(answer.secondary, /^verification request completed in \d+(\.\d+)? s$/)
    const d = answer.detail
    assert.equal(d.provider, 'openai')
    assert.deepEqual(d.identity, { account_id: 'acct-42', plan_type: 'pro' })
    assert.equal(d.credential.expires_at, '2026-09-11T10:00:00.000Z')
    assert.equal(d.request.model, 'gpt-5.6-sol')
    assert.equal(d.request.id, 'resp_1')
    assert.deepEqual(d.request.usage, { input_tokens: 12, output_tokens: 1 })
    assert.equal(typeof d.request.ms, 'number')
    assert.match(d.request.at, /^\d{4}-/)
    assert.equal(d.routing.ready, true)
    assert.equal(d.routing.model, 'gpt')
    assert.match(d.verified_at, /^\d{4}-/)
    assert.deepEqual(Object.keys(d).sort(), ['credential', 'identity', 'provider', 'request', 'routing', 'verified_at'])
  })

  test('the first verified read applies the routing preset: every row on gpt, the anthropic model off, the live routing replaced, and a second read applies nothing', async () => {
    writeSecret(root, 'codex-auth.json', authJson())
    const { s } = setup()
    const first = await s.verifier()({ progress: {} })
    assert.equal(first.detail.routing.applied, true)
    assert.equal(first.detail.routing.file, localFile)
    assert.equal(applied.length, 1)
    assert.equal(routing.defaults.untyped.model, 'gpt')
    assert.equal(routing.models.opus.active, false)
    assert.match(fs.readFileSync(localFile, 'utf8'), /untyped:\n\s+model: gpt/)
    assert.equal(fs.readFileSync(routingFile, 'utf8'), BASE)
    const second = await s.verifier()({ progress: {} })
    assert.equal(second.detail.routing.applied, false)
    assert.equal(second.detail.routing.ready, true)
    assert.equal(applied.length, 1)
    assert.equal(s.overview().routing.ready, true)
  })

  test('with the anthropic credential on disk too, the rows that route there are ready already and stay', async () => {
    writeSecret(root, 'codex-auth.json', authJson())
    writeSecret(root, 'anthropic.json', '{"token":"x"}\n')
    const { s } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.detail.routing.applied, false)
    assert.equal(routing.defaults.untyped.model, 'opus')
    assert.equal(fs.existsSync(localFile), false)
  })

  // ---- every miss ----------------------------------------------------------

  test('a secret file that is refused fails before OpenAI is asked, with the boundary\'s own sentence', async () => {
    writeSecret(root, 'codex-auth.json', authJson())
    fs.chmodSync(path.join(root, 'secrets', 'codex-auth.json'), 0o644)
    const { s, ai } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /mode 0644.*chmod 0600/)
    assert.match(answer.action, /Fix the file the message names/)
    assert.equal(answer.detail.stage, 'credential')
    assert.equal(ai.calls.length, 0)
    assert.equal(s.overview().secret.state, 'refused')
  })

  test('a file that is not a codex credential is a failed verification whose action is the sign-in', async () => {
    writeSecret(root, 'codex-auth.json', '{"tokens":{}}\n')
    const { s, ai } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /not a codex credential/)
    assert.match(answer.action, /Sign in to OpenAI/)
    assert.equal(ai.calls.length, 0)
  })

  test('an expired credential fails without a request, because the daemon\'s refresh would have replaced a live one', async () => {
    const text = authJson({ iat: Date.now() - 12 * DAY, exp: Date.now() - DAY })
    writeSecret(root, 'codex-auth.json', text)
    const { s, ai } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /expired/)
    assert.match(answer.action, /Sign in to OpenAI/)
    assert.equal(answer.detail.stage, 'credential')
    assert.equal(ai.calls.length, 0)
    noSecret(text, answer, logged)
  })

  test('a credential OpenAI refuses names the status and asks for the sign-in; a usage limit names the wait; a server fault names the retry', async () => {
    const text = authJson()
    writeSecret(root, 'codex-auth.json', text)
    for (const [status, body, failed, action] of [
      [401, '{"error":{"message":"invalid token"}}', /OpenAI refused the credential \(HTTP 401: invalid token\)/, /Sign in to OpenAI/],
      [429, '{"error":{"message":"usage limit reached"}}', /HTTP 429: usage limit reached/, /Wait for the usage window/],
      [503, 'upstream unavailable', /HTTP 503/, /try again/],
    ]) {
      const { s } = setup({ answers: [{ status, body, contentType: 'application/json' }] })
      const answer = await s.verifier()({ progress: {} })
      assert.equal(answer.ok, false, String(status))
      assert.match(answer.failed, failed)
      assert.match(answer.action, action)
      assert.equal(answer.detail.stage, 'request')
      noSecret(text, answer, logged)
    }
  })

  test('an OpenAI that cannot be reached, a stream that reports failure, and a stream that never completes are each one failure', async () => {
    writeSecret(root, 'codex-auth.json', authJson())
    for (const [answers, failed] of [
      [[Object.assign(new Error('getaddrinfo ENOTFOUND chatgpt.com'), { code: 'ENOTFOUND' })], /could not be reached.*ENOTFOUND/],
      [[{ body: sse([{ type: 'response.failed', response: { error: { message: 'model overloaded' } } }]) }], /did not complete: model overloaded/],
      [[{ body: sse([{ type: 'response.created', response: { id: 'resp_2' } }]) }], /ended without completing/],
    ]) {
      const { s } = setup({ answers })
      const answer = await s.verifier()({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, failed)
      assert.equal(answer.detail.stage, 'request')
    }
  })

  test('a routing preset that cannot be written fails after the request, naming the file', async () => {
    writeSecret(root, 'codex-auth.json', authJson())
    fs.rmSync(path.join(root, 'state'), { recursive: true })
    const { s } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /routing preset could not be applied/)
    assert.equal(answer.detail.stage, 'routing')
    assert.equal(answer.detail.request.id, 'resp_1')
  })

  test('a retry measures again: a server fault on one read and a completed request on the next connect the card', async () => {
    writeSecret(root, 'codex-auth.json', authJson())
    const { s, ai } = setup({ answers: [{ status: 503, body: 'no', contentType: 'text/plain' }, { body: completed({ id: 'resp_9' }) }] })
    assert.equal((await s.verifier()({ progress: {} })).ok, false)
    const again = await s.verifier()({ progress: {} })
    assert.equal(again.ok, true)
    assert.equal(again.detail.request.id, 'resp_9')
    assert.equal(ai.calls.length, 2)
  })

  test('a login that ended without a credential is the sentence the panel shows beside the plain card', async () => {
    const l = lane()
    l.ending = { provider: 'openai', state: 'expired', why: 'the one-time code ran out before anybody finished the login', ended_at: '2026-09-02T10:00:00.000Z', after_s: 900 }
    const { s } = setup({ theLane: l })
    assert.deepEqual(await s.verifier()({ progress: {} }), { ok: false, unconnected: true })
    assert.equal(s.overview().ending.state, 'expired')
  })

  test('without an installation root the credential is the home\'s codex store and the preset lands beside the tracked file', async () => {
    const authFile = path.join(tmp, 'auth.json')
    fs.writeFileSync(authFile, authJson(), { mode: 0o600 })
    const { s } = setup({ rootless: true })
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, true)
    assert.equal(s.overview().secret.state, 'present')
  })
})

// The Anthropic half of the model-provider card of integration setup (#879,
// filling the #874 seam under the #852 contract, beside #878's OpenAI row).
//
// What is pinned: setup starts the existing subscription sign-in (the
// `claude setup-token` lane the dispatcher already runs) and adds no API-key
// path; the credential lands in `secrets/anthropic.json` by that login and
// comes back in no answer, no log, and no refusal; the panel's own read is
// presence only plus the link the live login shows; verification is one
// minimal Messages request with the subscription credential, timed,
// recording the model, the response id, the usage, and the timing; a
// verified credential applies the routing preset once, alone and beside
// OpenAI, and reports routing readiness; every miss is one failed
// verification with one action, and a retry measures again. Nothing here
// touches the network: Anthropic is a fake `fetch`.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeSecret } from '../../cli/src/secrets.mjs'
import { loadRoutingConfig } from '../src/config.mjs'
import { AnthropicSetup, VERIFY_PROMPT } from '../src/anthropicsetup.mjs'
import { MESSAGES_URL } from '../src/usage.mjs'

const DAY = 24 * 60 * 60 * 1000
const TOKEN = 'sk-ant-oat01-this-subscription-token-must-never-be-shown-anywhere-at-all-0123456789'

function record({ obtained = Date.now() - 10 * DAY } = {}) {
  return `${JSON.stringify({ token: TOKEN, obtained_at: new Date(obtained).toISOString(), seeded_at: null }, null, 2)}\n`
}

const BASE = [
  'defaults:',
  '  research: {model: gpt, effort: high}',
  '  untyped: {model: opus, effort: high}',
  'models:',
  '  fable: { provider: anthropic, harness: claude }',
  '  opus: { provider: anthropic, harness: claude }',
  '  gpt: { provider: openai, harness: codex, id: gpt-5.6-sol, reasoning_effort: high }',
  'fallbacks:',
  '  fable: [opus]',
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

// The Messages response Anthropic answers a minimal request with.
const completed = (over = {}) => JSON.stringify({
  id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
  content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
  usage: { input_tokens: 31, output_tokens: 1 }, ...over,
})

// An Anthropic that answers by turn: each entry is one answer, in order, and
// the last one repeats. Every call is recorded with its headers and body.
function anthropic(answers) {
  const calls = []
  let n = 0
  const fetchImpl = async (url, init = {}) => {
    const answer = answers[Math.min(n++, answers.length - 1)]
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null })
    if (answer instanceof Error) throw answer
    return {
      status: answer.status ?? 200,
      ok: (answer.status ?? 200) < 300,
      headers: { get: (k) => (k.toLowerCase() === 'request-id' ? (answer.requestId ?? 'req_abc') : null) },
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-anthropicsetup-'))
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

function lane() {
  const l = {
    calls: [],
    flow: null,
    ending: null,
    said: '🔑 signing `anthropic` back in. Open the session, follow the link, and paste the code the browser shows back into the same terminal.',
  }
  l.login = {
    state: () => l.flow,
    ending: () => l.ending,
    start: async (opts) => { l.calls.push(opts); return l.said },
  }
  return l
}

function setup({ answers = [{ body: completed() }], theLane = lane(), rootless = false, over = {} } = {}) {
  const ai = anthropic(answers)
  const authFile = rootless ? path.join(tmp, 'credentials', 'anthropic.json') : path.join(root, 'secrets', 'anthropic.json')
  const s = new AnthropicSetup({
    root: rootless ? null : root,
    authFile,
    credentialFiles: { anthropic: authFile, openai: path.join(root, 'secrets', 'codex-auth.json') },
    routing: { file: routingFile, localFile, live: () => routing, apply: (next) => { applied.push(next); routing = next } },
    login: theLane.login,
    fetchImpl: ai.fetchImpl,
    probeModel: 'claude-haiku-4-5-20251001',
    claudeVersion: '2.1.220',
    log: (line) => logged.push(String(line)),
    ...over,
  })
  return { s, ai, lane: theLane }
}

const noSecret = (...blobs) => {
  for (const blob of blobs) assert.ok(!JSON.stringify(blob).includes(TOKEN), 'carries the token')
}

describe('the Anthropic card (#879)', () => {
  test('without a credential the card is plain, and the panel read says absent and offers the sign-in, never a key field', async () => {
    const { s } = setup()
    assert.deepEqual(await s.verifier()({ progress: {} }), { ok: false, unconnected: true })
    const o = s.overview()
    assert.equal(o.provider, 'anthropic')
    assert.deepEqual(o.secret, { state: 'absent' })
    assert.equal(o.credential, null)
    assert.equal(o.login, null)
    assert.equal(o.routing.ready, false)
    assert.ok(!Object.keys(o).some((k) => /key/i.test(k)))
  })

  test('the sign-in handoff starts the setup-token login through the dispatcher, once, and the panel shows the typed flow with its link while it waits', async () => {
    const { s, lane: l } = setup()
    const out = await s.startLogin()
    assert.deepEqual(l.calls, [{ provider: 'anthropic', by: 'setup' }])
    assert.equal(out.started, true)
    assert.match(out.said, /signing `anthropic` back in/)
    l.flow = { provider: 'anthropic', session: 'curia-auth-anthropic', state: 'waiting', url: 'https://claude.com/cai/oauth/authorize?code_challenge=x&state=y', code: null, typed: true, terminal_url: 'https://box.tail1234.ts.net:8446/?arg=curia-auth-anthropic', seconds_left: 1700 }
    const o = s.overview()
    assert.equal(o.login.typed, true)
    assert.equal(o.login.code, null)
    assert.match(o.login.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize/)
    assert.equal(o.secret.state, 'absent')
  })

  test('a running openai login is not this row\'s login', () => {
    const l = lane()
    l.flow = { provider: 'openai', state: 'waiting', url: 'https://auth.openai.com/codex/device', code: '83CC-A4ZTO', typed: false }
    const { s } = setup({ theLane: l })
    assert.equal(s.overview().login, null)
  })

  test('a refused start is reported as curia\'s own sentence and starts nothing twice', async () => {
    const l = lane()
    l.said = '❌ this daemon runs no containers, so it has nothing to run the login in'
    const { s } = setup({ theLane: l })
    const out = await s.startLogin()
    assert.equal(out.started, false)
    assert.match(out.said, /runs no containers/)
    assert.equal(s.overview().said, out.said)
    assert.equal(l.calls.length, 1)
  })

  test('a credential the login landed verifies on the next read: one minimal Messages request as Claude Code sends one, and the token is in no answer and no log line', async () => {
    writeSecret(root, 'anthropic.json', record())
    const { s, ai } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.equal(ai.calls.length, 1)
    const [call] = ai.calls
    assert.equal(call.url, MESSAGES_URL)
    assert.equal(call.method, 'POST')
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20')
    assert.equal(call.headers['anthropic-version'], '2023-06-01')
    assert.match(call.headers['user-agent'], /^claude-cli\/2\.1\.220 /)
    assert.ok(!('x-api-key' in call.headers), 'a subscription credential is a bearer token, never an API key')
    assert.equal(call.body.model, 'claude-haiku-4-5-20251001')
    assert.equal(call.body.max_tokens, 8)
    assert.equal(call.body.stream, undefined)
    assert.equal(call.body.tools, undefined)
    assert.deepEqual(call.body.messages, [{ role: 'user', content: VERIFY_PROMPT }])
    noSecret(answer, s.overview(), logged)
  })

  test('the connected answer is the provider, the timed request, and the safe facts: adoption, estimated expiry, model, response id, usage, routing', async () => {
    const obtained = Date.parse('2026-08-24T12:00:00Z')
    writeSecret(root, 'anthropic.json', record({ obtained }))
    const { s } = setup({ over: { now: () => new Date('2026-09-02T10:00:00Z') } })
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, true)
    assert.equal(answer.primary, 'Anthropic')
    assert.equal(answer.emoji, '🧠')
    assert.match(answer.secondary, /^verification request completed in \d+(\.\d+)? s$/)
    const d = answer.detail
    assert.equal(d.provider, 'anthropic')
    assert.deepEqual(d.credential, { kind: 'setup-token', obtained_at: '2026-08-24T12:00:00.000Z', expires_at: '2027-08-24T12:00:00.000Z', estimated: true })
    assert.equal(d.request.model, 'claude-haiku-4-5-20251001')
    assert.equal(d.request.id, 'msg_01')
    assert.equal(d.request.request_id, 'req_abc')
    assert.equal(d.request.stop_reason, 'end_turn')
    assert.deepEqual(d.request.usage, { input_tokens: 31, output_tokens: 1 })
    assert.equal(typeof d.request.ms, 'number')
    assert.equal(d.request.at, '2026-09-02T10:00:00.000Z')
    assert.equal(d.routing.ready, true)
    assert.equal(d.routing.model, 'fable')
    assert.equal(d.verified_at, '2026-09-02T10:00:00.000Z')
    assert.deepEqual(Object.keys(d).sort(), ['credential', 'provider', 'request', 'routing', 'verified_at'])
    noSecret(answer)
  })

  test('the first verified read applies the routing preset alone: the openai row moves to fable, gpt switches off, the live routing is replaced, and a second read applies nothing', async () => {
    writeSecret(root, 'anthropic.json', record())
    const { s } = setup()
    const first = await s.verifier()({ progress: {} })
    assert.equal(first.detail.routing.applied, true)
    assert.equal(first.detail.routing.file, localFile)
    assert.equal(applied.length, 1)
    assert.equal(routing.defaults.research.model, 'fable')
    assert.equal(routing.defaults.research.effort, 'high')
    assert.equal(routing.defaults.untyped.model, 'opus')
    assert.equal(routing.models.gpt.active, false)
    assert.equal(routing.models.fable.active, true)
    assert.match(fs.readFileSync(localFile, 'utf8'), /research:\n\s+model: fable/)
    assert.equal(fs.readFileSync(routingFile, 'utf8'), BASE)
    const second = await s.verifier()({ progress: {} })
    assert.equal(second.detail.routing.applied, false)
    assert.equal(second.detail.routing.ready, true)
    assert.equal(applied.length, 1)
    assert.equal(s.overview().routing.ready, true)
  })

  test('with both credentials on disk the preset covers both: every row stays where it is and every model of both providers is on', async () => {
    writeSecret(root, 'anthropic.json', record())
    writeSecret(root, 'codex-auth.json', '{"tokens":{"access_token":"x"}}\n')
    // The OpenAI row connected first: its preset moved the anthropic row
    // onto gpt and switched the anthropic models off.
    fs.writeFileSync(localFile, 'defaults:\n  untyped: {model: gpt, effort: high}\nmodels:\n  fable: {active: false}\n  opus: {active: false}\n', { mode: 0o600 })
    routing = loadRoutingConfig(routingFile, { localFile })
    assert.equal(routing.models.opus.active, false)
    const { s } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.equal(answer.detail.routing.applied, true)
    assert.deepEqual(answer.detail.routing.rows.map((r) => [r.type, r.model, r.ok]), [['research', 'gpt', true], ['untyped', 'gpt', true]])
    assert.equal(routing.models.gpt.active, true)
    assert.equal(routing.models.opus.active, true)
    assert.equal(routing.models.fable.active, true)
    assert.deepEqual(s.overview().routing.credentialed.sort(), ['anthropic', 'openai'])
  })

  // ---- every miss ----------------------------------------------------------

  test('a secret file that is refused fails before Anthropic is asked, with the boundary\'s own sentence', async () => {
    writeSecret(root, 'anthropic.json', record())
    fs.chmodSync(path.join(root, 'secrets', 'anthropic.json'), 0o644)
    const { s, ai } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /mode 0644.*chmod 0600/)
    assert.match(answer.action, /Fix the file the message names/)
    assert.equal(answer.detail.stage, 'credential')
    assert.equal(ai.calls.length, 0)
    assert.equal(s.overview().secret.state, 'refused')
  })

  test('a file that is not a subscription credential is a failed verification whose action is the sign-in', async () => {
    writeSecret(root, 'anthropic.json', '{"token":"not-a-token"}\n')
    const { s, ai } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /not an Anthropic subscription credential/)
    assert.match(answer.action, /Sign in to Anthropic/)
    assert.equal(answer.detail.stage, 'credential')
    assert.equal(ai.calls.length, 0)
  })

  test('a credential past its documented year fails without a request, naming the estimate', async () => {
    writeSecret(root, 'anthropic.json', record({ obtained: Date.now() - 400 * DAY }))
    const { s, ai } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /documented one-year lifetime/)
    assert.match(answer.action, /Sign in to Anthropic/)
    assert.equal(answer.detail.stage, 'credential')
    assert.equal(ai.calls.length, 0)
    noSecret(answer, logged)
  })

  test('a credential Anthropic refuses names the status and asks for the sign-in; a rate limit names the wait; a server fault names the retry', async () => {
    writeSecret(root, 'anthropic.json', record())
    for (const [status, body, failed, action] of [
      [401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', /Anthropic refused the credential \(HTTP 401: invalid x-api-key\)/, /Sign in to Anthropic/],
      [429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your usage limit"}}', /HTTP 429: This request would exceed your usage limit/, /Wait for the usage window/],
      [529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', /HTTP 529: Overloaded/, /try again/],
    ]) {
      const { s } = setup({ answers: [{ status, body }] })
      const answer = await s.verifier()({ progress: {} })
      assert.equal(answer.ok, false, String(status))
      assert.match(answer.failed, failed)
      assert.match(answer.action, action)
      assert.equal(answer.detail.stage, 'request')
      assert.equal(answer.detail.request.status, status)
      noSecret(answer, logged)
    }
  })

  test('an Anthropic that cannot be reached, a body that is not a message, and a message that ended for a refusal are each one failure', async () => {
    writeSecret(root, 'anthropic.json', record())
    for (const [answers, failed] of [
      [[Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' })], /could not be reached.*ENOTFOUND/],
      [[{ body: '<html>gateway</html>' }], /not a message/],
      [[{ body: completed({ stop_reason: 'refusal', content: [] }) }], /ended with stop reason refusal/],
    ]) {
      const { s } = setup({ answers })
      const answer = await s.verifier()({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, failed)
      assert.equal(answer.detail.stage, 'request')
    }
  })

  test('a routing preset that cannot be written fails after the request, naming the file', async () => {
    writeSecret(root, 'anthropic.json', record())
    fs.rmSync(path.join(root, 'state'), { recursive: true })
    const { s } = setup()
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.failed, /routing preset could not be applied/)
    assert.equal(answer.detail.stage, 'routing')
    assert.equal(answer.detail.request.id, 'msg_01')
  })

  test('a retry measures again: a server fault on one read and a completed request on the next connect the card', async () => {
    writeSecret(root, 'anthropic.json', record())
    const { s, ai } = setup({ answers: [{ status: 503, body: 'no' }, { body: completed({ id: 'msg_09' }) }] })
    assert.equal((await s.verifier()({ progress: {} })).ok, false)
    const again = await s.verifier()({ progress: {} })
    assert.equal(again.ok, true)
    assert.equal(again.detail.request.id, 'msg_09')
    assert.equal(ai.calls.length, 2)
  })

  test('a login that ended without a credential is the sentence the panel shows beside the plain card, and an openai ending is not', async () => {
    const l = lane()
    l.ending = { provider: 'anthropic', state: 'failed', why: 'Anthropic answered HTTP 401 for the token read off the login pane', ended_at: '2026-09-02T10:00:00.000Z', after_s: 300 }
    const { s } = setup({ theLane: l })
    assert.deepEqual(await s.verifier()({ progress: {} }), { ok: false, unconnected: true })
    assert.equal(s.overview().ending.state, 'failed')
    l.ending = { provider: 'openai', state: 'expired', why: 'the code ran out' }
    assert.equal(s.overview().ending, null)
  })

  test('without an installation root the credential is the workspace store and the preset lands beside the tracked file', async () => {
    const authFile = path.join(tmp, 'credentials', 'anthropic.json')
    fs.mkdirSync(path.dirname(authFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(authFile, record(), { mode: 0o600 })
    const { s } = setup({ rootless: true })
    const answer = await s.verifier()({ progress: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.equal(s.overview().secret.state, 'present')
    assert.equal(answer.detail.routing.file, localFile)
  })
})

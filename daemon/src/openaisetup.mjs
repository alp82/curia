// The OpenAI half of the model-provider card of integration setup (#878,
// filling the #874 seam under the #852 contract and the #853 journey).
//
// One module holds the OpenAI step: the panel's own read, the one press that
// starts the sign-in, and the verifier the frame asks on every read. The
// Anthropic half (#879) is its sibling behind the same card; the frame joins
// the two under `card.providers`, and the routing preset both apply lives in
// `modelrouting.mjs`, so this file is OpenAI's business alone.
//
// THE SIGN-IN IS THE ONE CURIA ALREADY HAS. `codex login --device-auth` in
// a tmux session, driven by `ReauthFlow` from the dispatch tick (#642, #660):
// the pane prints a link and a one-time code, the operator finishes in the
// browser, and the lane adopts the credential into `secrets/codex-auth.json`
// under a root (the home's `.codex/auth.json` without one) through the
// broker's atomic write. This module starts that flow through the
// dispatcher's `startReauth` and reads its state; it holds no second login
// and offers no API-key path (#852). The device code lives in the flow's
// memory and nowhere else; it reaches this panel and no file.
//
// VERIFICATION IS ONE MINIMAL MODEL REQUEST, on the Codex backend the CLI
// itself uses with a subscription credential: `POST
// https://chatgpt.com/backend-api/codex/responses`, bearer access token,
// `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`, streamed
// (the backend answers a stream), `store: false`, no tools, a one-line
// prompt. The endpoint, the headers, and the event names are read off the
// pinned codex binary (`strings codex`, codex-cli 0.151.0), and the request
// goes through an injectable `fetch` so the suite needs no network.
//
// WHAT IS RECORDED is safe: the opaque account id and the plan off the
// token's auth claim (never the email in the profile claim), the token's
// expiry, the model asked for, the response id and usage, the elapsed
// milliseconds, and when. No answer, log line, or refusal carries the token.
//
// VERIFICATION IS THE CURRENT FACT, in the order the operator meets it:
//
//   1. the credential is on disk (else the card is plain, "Ready to
//      connect"), readable within the secret boundary, a codex credential,
//      and not expired;
//   2. OpenAI completes the minimal request, timed;
//   3. routing is ready for the providers that hold a credential, and the
//      preset is applied when it is not.
//
// Each miss is one failed verification with one corrective action and the
// stage it failed at. A retry measures again.

import crypto from 'node:crypto'
import fs from 'node:fs'

import { readSecret, SecretError, redact } from '../../cli/src/secrets.mjs'
import { codexTokenIdentity } from './codexcredential.mjs'
import { ensureRoutingPreset, presetModel, routingReadiness } from './modelrouting.mjs'
import { spawnModelId } from './routing.mjs'

export const PROVIDER = 'openai'
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const VERIFY_PROMPT = 'Reply with the single word OK.'
const VERIFY_INSTRUCTIONS = 'You are answering a connection check. Reply with the single word OK and nothing else.'
const REQUEST_TIMEOUT_MS = 60_000

const SIGN_IN = 'Sign in to OpenAI from this panel, then try again.'
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

// The events of a streamed response, out of its `data:` lines. Anything that
// is not JSON is skipped: the stream may carry keep-alive comments.
export function parseEventStream(text) {
  const events = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      events.push(JSON.parse(data))
    } catch {
      // not an event
    }
  }
  return events
}

// The sentence in an error body, as OpenAI's envelope states it, or the
// body's first line when it is not JSON.
function errorSentence(text) {
  const raw = String(text ?? '').trim()
  try {
    const data = JSON.parse(raw)
    const message = data?.error?.message ?? data?.detail ?? data?.message
    if (typeof message === 'string' && message) return message
  } catch {
    // not JSON
  }
  return raw.split('\n')[0].slice(0, 200)
}

export class OpenAISetup {
  // `root` null is the source deployment: the credential is the home's codex
  // store and the routing override lands beside the tracked file.
  // `credentialFiles` names each provider's long-lived credential by path,
  // read by presence only, which is what decides the routing preset.
  // `routing` is the daemon's live routing: the tracked file, the override
  // file, a reader of the running object, and the apply that puts a reloaded
  // one into it. `login` is the dispatcher's flow: `state()`, `ending()`, and
  // `start({ provider, by })`, which answers curia's own sentence.
  constructor({
    root = null, authFile, credentialFiles = {}, routing, login,
    fetchImpl = globalThis.fetch, codexVersion = null, log = console.log, now = () => new Date(),
  }) {
    this.root = root
    this.authFile = authFile
    this.credentialFiles = { [PROVIDER]: authFile, ...credentialFiles }
    this.routing = routing
    this.login = login
    this.fetchImpl = fetchImpl
    this.codexVersion = codexVersion
    this.log = log
    this.now = now
    // The start in flight, and what the last one answered. Process memory:
    // a restart forgets both, and the flow itself is re-adopted by the tick.
    this.pending = null
    this.said = null
  }

  // The credential by presence, with the text for the verifier's own use.
  // Never leaves this class as text.
  #read() {
    if (this.root) {
      try {
        const text = readSecret(this.root, 'codex-auth.json')
        return text === null ? { state: 'absent', text: null } : { state: 'present', text }
      } catch (e) {
        if (e instanceof SecretError) return { state: 'refused', why: e.message, text: null }
        throw e
      }
    }
    try {
      return { state: 'present', text: fs.readFileSync(this.authFile, 'utf8') }
    } catch (e) {
      if (e.code === 'ENOENT') return { state: 'absent', text: null }
      return { state: 'refused', why: `${this.authFile} could not be read (${e.message})`, text: null }
    }
  }

  #credentialed() {
    return Object.entries(this.credentialFiles)
      .filter(([, file]) => { try { return Boolean(file) && fs.statSync(file).isFile() } catch { return false } })
      .map(([provider]) => provider)
  }

  #flow() {
    const flow = this.login?.state?.() ?? null
    if (flow?.provider === PROVIDER) return flow
    return this.pending ? { provider: PROVIDER, state: 'starting' } : null
  }

  // The panel's own read: the credential by presence, its safe identity
  // facts, the live login with its link and code, the ending the last login
  // left, and routing readiness. Never a token, never a key.
  overview() {
    const secret = this.#read()
    const identity = secret.text ? codexTokenIdentity(secret.text) : null
    const ending = this.login?.ending?.() ?? null
    return {
      provider: PROVIDER,
      root: Boolean(this.root),
      secret: secret.state === 'refused' ? { state: 'refused', why: secret.why } : { state: secret.state },
      identity: identity && (identity.account_id || identity.plan_type)
        ? { account_id: identity.account_id, plan_type: identity.plan_type, expires_at: identity.exp ? new Date(identity.exp).toISOString() : null }
        : null,
      login: this.#flow(),
      ending: ending?.provider === PROVIDER ? ending : null,
      said: this.said,
      routing: this.#readiness(secret.state === 'present'),
    }
  }

  #readiness(present) {
    const live = this.routing.live()
    const credentialed = this.#credentialed().filter((p) => p !== PROVIDER || present)
    const { ready, rows, missing } = routingReadiness(live, credentialed, { provider: PROVIDER })
    return { ready, model: presetModel(live, PROVIDER), rows, missing, credentialed }
  }

  // The one press: start the subscription sign-in, or hand back the one
  // already running. The start may take a while (the agent image is ensured
  // first), so a caller may answer its overview at once and read `said` on a
  // later poll; the promise settles to the same answer either way.
  startLogin() {
    if (this.pending) return this.pending
    this.said = null
    this.pending = (async () => {
      let said
      try {
        said = await this.login.start({ provider: PROVIDER, by: 'setup' })
      } catch (e) {
        said = `❌ the sign-in could not be started (${e.message})`
      }
      this.said = String(said)
      this.pending = null
      const started = !this.said.startsWith('❌')
      this.log(`model setup: openai sign-in ${started ? 'started' : 'refused'} — ${this.said.split('\n')[0]}`)
      return { started, said: this.said, ...this.overview() }
    })()
    return this.pending
  }

  // The frame's verifier (#874): `{ ok, primary, secondary, emoji, detail }`,
  // `{ ok: false, failed, action, detail }`, or `{ ok: false, unconnected }`.
  verifier() {
    return async () => {
      const secret = this.#read()
      if (secret.state === 'absent') return { ok: false, unconnected: true }
      if (secret.state === 'refused') {
        return { ok: false, failed: secret.why, action: 'Fix the file the message names, or sign in to OpenAI again from this panel, then try again.', detail: { stage: 'credential' } }
      }
      try {
        return await this.#verify(secret.text)
      } catch (e) {
        const message = redact(e.message, [secret.text])
        this.log(`model setup: openai verification did not finish: ${message}`)
        return { ok: false, failed: message, action: 'Fix the cause the message names, then try again.', detail: { stage: 'unknown' } }
      }
    }
  }

  async #verify(text) {
    const facts = { provider: PROVIDER }
    const fail = (stage, failed, action) => ({ ok: false, failed, action, detail: { stage, ...facts } })

    const identity = codexTokenIdentity(text)
    let token = null
    try { token = JSON.parse(text)?.tokens?.access_token ?? null } catch { /* said below */ }
    if (typeof token !== 'string' || !token || !Number.isFinite(identity.exp)) {
      return fail('credential', `${this.authFile} is not a codex credential curia can read`, SIGN_IN)
    }
    facts.identity = { account_id: identity.account_id, plan_type: identity.plan_type }
    facts.credential = { expires_at: new Date(identity.exp).toISOString() }
    if (identity.exp <= this.now().getTime()) {
      return fail('credential', `The OpenAI credential expired ${facts.credential.expires_at}, and curia could not refresh it`, SIGN_IN)
    }

    // The minimal request, as codex sends one with a subscription credential.
    const model = spawnModelId(this.routing.live(), presetModel(this.routing.live(), PROVIDER) ?? 'gpt')
    const started = Date.now()
    const at = this.now().toISOString()
    let res
    try {
      res = await this.fetchImpl(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(identity.account_id ? { 'chatgpt-account-id': identity.account_id } : {}),
          'openai-beta': 'responses=experimental',
          originator: 'codex_cli_rs',
          'user-agent': `codex_cli_rs/${this.codexVersion ?? 'unknown'} (curia integration setup)`,
          session_id: crypto.randomUUID(),
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          instructions: VERIFY_INSTRUCTIONS,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: VERIFY_PROMPT }] }],
          tools: [],
          tool_choice: 'auto',
          parallel_tool_calls: false,
          store: false,
          stream: true,
          include: [],
          prompt_cache_key: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      facts.request = { model, at, ms: Date.now() - started, error: redact(e.message, [token]) }
      return fail('request', `OpenAI could not be reached (${facts.request.error})`, 'Check that this host reaches chatgpt.com (`curia doctor` runs the outbound check), then try again.')
    }
    const ms = Date.now() - started
    const body = await res.text().catch(() => '')
    if (res.status < 200 || res.status >= 300) {
      const why = redact(errorSentence(body), [token])
      facts.request = { model, at, ms, status: res.status, error: why }
      if (res.status === 401 || res.status === 403) return fail('request', `OpenAI refused the credential (HTTP ${res.status}${why ? `: ${why}` : ''})`, SIGN_IN)
      if (res.status === 429) return fail('request', `OpenAI answered HTTP 429${why ? `: ${why}` : ''}`, 'Wait for the usage window to reset, or sign in with another subscription, then try again.')
      return fail('request', `OpenAI answered HTTP ${res.status}${why ? `: ${why}` : ''}`, 'Wait a moment, then try again.')
    }
    const events = parseEventStream(body)
    const failed = events.find((e) => e?.type === 'response.failed' || e?.type === 'error')
    if (failed) {
      const why = redact(String(failed.response?.error?.message ?? failed.error?.message ?? failed.message ?? 'no reason given'), [token])
      facts.request = { model, at, ms, status: res.status, error: why }
      return fail('request', `The verification request did not complete: ${why}`, 'Wait a moment, then try again.')
    }
    const done = events.find((e) => e?.type === 'response.completed')?.response
    if (!done) {
      facts.request = { model, at, ms, status: res.status, error: 'the stream ended without response.completed' }
      return fail('request', 'The verification request ended without completing', 'Wait a moment, then try again.')
    }
    facts.request = {
      model: typeof done.model === 'string' ? done.model : model,
      id: typeof done.id === 'string' ? done.id : null,
      at,
      ms,
      usage: done.usage && typeof done.usage === 'object'
        ? { input_tokens: done.usage.input_tokens ?? null, output_tokens: done.usage.output_tokens ?? null }
        : null,
    }

    // The routing preset, applied when routing is not ready for the
    // providers that hold a credential.
    try {
      const routing = ensureRoutingPreset({
        routingFile: this.routing.file, localFile: this.routing.localFile, provider: PROVIDER,
        credentialed: this.#credentialed(), live: this.routing.live(), apply: this.routing.apply, log: this.log,
      })
      facts.routing = { ready: routing.ready, applied: routing.applied, model: routing.model, file: routing.file, rows: routing.rows, missing: routing.missing }
    } catch (e) {
      facts.routing = { ready: false, applied: false, model: presetModel(this.routing.live(), PROVIDER), file: this.routing.localFile ?? null, error: e.message }
      return fail('routing', `The routing preset could not be applied: ${e.message}`, `Fix ${this.routing.localFile ?? 'the routing override'} so the service can write it, then try again.`)
    }
    if (!facts.routing.ready) {
      return fail('routing', `Routing still names ${facts.routing.missing.join(', ')} on a model that cannot run`, 'Open Settings and route every type to a model whose provider is signed in, then try again.')
    }
    facts.verified_at = this.now().toISOString()
    this.log(`model setup: openai verified — account ${identity.account_id ?? 'unknown'}, plan ${identity.plan_type ?? 'unknown'}, ${facts.request.model} answered in ${ms} ms${facts.routing.applied ? ', routing preset applied' : ''}`)
    return {
      ok: true,
      emoji: '⚡',
      primary: 'OpenAI',
      secondary: `verification request completed in ${seconds(ms)}`,
      detail: facts,
    }
  }
}

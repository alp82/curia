// The Anthropic half of the model-provider card of integration setup (#879,
// filling the #874 seam under the #852 contract and the #853 journey).
//
// One module holds the Anthropic step: the panel's own read, the one press
// that starts the sign-in, and the verifier the frame asks on every read.
// The OpenAI half (#878, `openaisetup.mjs`) is its sibling behind the same
// card; the frame joins the two under `card.providers`, and the routing
// preset both apply lives in `modelrouting.mjs`, so this file is
// Anthropic's business alone. The two files have the same shape on purpose:
// a reader who knows one knows the other.
//
// THE SIGN-IN IS THE ONE CURIA ALREADY HAS. `claude setup-token` in a tmux
// session, driven by `ReauthFlow` through `SetupTokenLane` (#660): the pane
// prints an authorize link, the operator signs in on claude.com and pastes
// the code the browser shows back into the same pane, the CLI prints the
// token once, and the lane reads it off the frame, asks Anthropic whether it
// authenticates, and adopts it into `secrets/anthropic.json` under a root
// (`<workspace_root>/credentials/anthropic.json` without one) through the
// store's atomic write. This module starts that flow through the
// dispatcher's `startReauth` and reads its state; it holds no second login
// and offers no API-key path (#852). The link reaches this panel; the token
// reaches the store and nothing a surface reads (`ReauthFlow.state` keeps it
// out by design).
//
// VERIFICATION IS ONE MINIMAL MODEL REQUEST, the same Messages request the
// account-usage probe already makes with a subscription credential
// (`usage.mjs`): `POST https://api.anthropic.com/v1/messages`, bearer token,
// `anthropic-beta: oauth-2025-04-20`, the Claude Code system prompt an OAuth
// credential is entitled to send, the cheapest model the box's `usage.
// probe_model` names, a handful of output tokens, no tools, not streamed.
// It goes through an injectable `fetch`, so the suite needs no network.
//
// WHAT IS RECORDED is safe: the instant the credential was adopted and the
// expiry estimated from it (the token states no dates, so the estimate says
// it is one), the model asked for, the response id, the request id
// Anthropic stamped, the stop reason, the usage, the elapsed milliseconds,
// and when. A `setup-token` credential carries no account identity, so none
// is invented. No answer, log line, or refusal carries the token.
//
// VERIFICATION IS THE CURRENT FACT, in the order the operator meets it:
//
//   1. the credential is on disk (else the card is plain, "Ready to
//      connect"), readable within the secret boundary, a subscription
//      credential, and inside its documented lifetime;
//   2. Anthropic completes the minimal request, timed;
//   3. routing is ready for the providers that hold a credential, and the
//      preset is applied when it is not.
//
// Each miss is one failed verification with one corrective action and the
// stage it failed at. A retry measures again.

import fs from 'node:fs'

import { readSecret, SecretError, redact } from '../../cli/src/secrets.mjs'
import { ANTHROPIC_PROVIDER, ANTHROPIC_TOKEN_RE, PROVIDER_CREDENTIALS } from './credentials.mjs'
import { ensureRoutingPreset, presetModel, routingReadiness } from './modelrouting.mjs'
import { MESSAGES_URL, ANTHROPIC_VERSION, PROBE_MODEL, anthropicCredential } from './usage.mjs'

export const PROVIDER = ANTHROPIC_PROVIDER
export const VERIFY_PROMPT = 'Reply with the single word OK.'
// The system prompt an OAuth credential is entitled to send, the same line
// the usage probe rides on, so the request stays a Claude Code call.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
const MAX_TOKENS = 8
const REQUEST_TIMEOUT_MS = 60_000
// The panel read polls the live login itself (#891). The page reads every
// 3 s while a login runs; the dispatch tick alone runs every 60 s, and the
// rehearsal watched the row wait a minute for the link and a minute more for
// the adoption. One poll per gap, however many reads land inside it.
export const POLL_GAP_MS = 2_000

const SIGN_IN = 'Sign in to Anthropic from this panel, then try again.'
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

// The sentence in an error body, as Anthropic's envelope states it
// (`{ type: "error", error: { type, message } }`), or the body's first line
// when it is not JSON.
function errorSentence(text) {
  const raw = String(text ?? '').trim()
  try {
    const data = JSON.parse(raw)
    const message = data?.error?.message ?? data?.message
    if (typeof message === 'string' && message) return message
  } catch {
    // not JSON
  }
  return raw.split('\n')[0].slice(0, 200)
}

// The record's safe facts: when it was adopted and the estimated expiry.
// `null` for a file that is not a subscription credential.
function credentialFacts(text) {
  let record
  try { record = JSON.parse(text) } catch { return null }
  if (!ANTHROPIC_TOKEN_RE.test(String(record?.token ?? ''))) return null
  const exp = PROVIDER_CREDENTIALS[PROVIDER].credentialExpiry(record)
  return {
    token: record.token,
    obtained_at: typeof record.obtained_at === 'string' ? record.obtained_at : null,
    expires_at: Number.isFinite(exp) ? new Date(exp).toISOString() : null,
    exp: Number.isFinite(exp) ? exp : null,
  }
}

export class AnthropicSetup {
  // `root` null is the source deployment: the credential is the workspace
  // store and the routing override lands beside the tracked file.
  // `authFile` is `cfg.paths.anthropicStore`. `credentialFiles` names each
  // provider's long-lived credential by path, read by presence only, which
  // is what decides the routing preset. `routing` is the daemon's live
  // routing: the tracked file, the override file, a reader of the running
  // object, and the apply that puts a reloaded one into it. `login` is the
  // dispatcher's flow: `state()`, `ending()`, and `start({ provider, by })`,
  // which answers curia's own sentence. `probeModel` is `usage.probe_model`.
  constructor({
    root = null, authFile, credentialFiles = {}, routing, login,
    fetchImpl = globalThis.fetch, probeModel = PROBE_MODEL, claudeVersion = null, log = console.log, now = () => new Date(),
  }) {
    this.root = root
    this.authFile = authFile
    this.credentialFiles = { [PROVIDER]: authFile, ...credentialFiles }
    this.routing = routing
    this.login = login
    this.fetchImpl = fetchImpl
    this.probeModel = probeModel
    this.claudeVersion = claudeVersion
    this.log = log
    this.now = now
    // The start in flight, and what the last one answered. Process memory:
    // a restart forgets both, and the flow itself is re-adopted by the tick.
    this.pending = null
    this.said = null
    // The last poll the read drove, and the image preparation the first read
    // started: both process memory, like the flow they serve.
    this.polledAt = 0
    this.prepared = null
  }

  // The credential by presence, with the text for the verifier's own use.
  // Never leaves this class as text.
  #read() {
    if (this.root) {
      try {
        const text = readSecret(this.root, 'anthropic.json')
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

  // The panel's own read: the credential by presence, its safe facts, the
  // live login with its link, the ending the last login left, and routing
  // readiness. Never a token, never a key.
  overview() {
    const secret = this.#read()
    const facts = secret.text ? credentialFacts(secret.text) : null
    const ending = this.login?.ending?.() ?? null
    return {
      provider: PROVIDER,
      root: Boolean(this.root),
      secret: secret.state === 'refused' ? { state: 'refused', why: secret.why } : { state: secret.state },
      credential: facts ? { kind: 'setup-token', obtained_at: facts.obtained_at, expires_at: facts.expires_at, estimated: true } : null,
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

  // The panel's read from the route: the overview, after this row has done
  // what the read can do for the operator. While this provider's login is
  // live the flow is polled (the pane scraped, the credential adopted the
  // moment it lands), at most once per gap; with no login running, the agent
  // image the login runs in is prepared once, so the press has nothing left
  // to pull. Neither is awaited past what it costs: a poll that fails is the
  // tick's to retry, and a preparation that fails is retried by the press.
  async read() {
    const flow = this.login?.state?.() ?? null
    if (flow?.provider === PROVIDER && flow.state === 'waiting' && typeof this.login.poll === 'function') {
      const at = this.now().getTime()
      if (at - this.polledAt >= POLL_GAP_MS) {
        this.polledAt = at
        try {
          await this.login.poll()
        } catch (e) {
          this.log(`model setup: the ${PROVIDER} login poll failed (${e.message})`)
        }
      }
    } else if (!flow && !this.pending && !this.prepared && typeof this.login?.prepare === 'function') {
      this.prepared = Promise.resolve()
        .then(() => this.login.prepare())
        .catch((e) => { this.log(`model setup: the agent image could not be prepared ahead of the ${PROVIDER} sign-in (${e.message})`); this.prepared = null })
    }
    return this.overview()
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
      this.log(`model setup: anthropic sign-in ${started ? 'started' : 'refused'} — ${this.said.split('\n')[0]}`)
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
        return { ok: false, failed: secret.why, action: 'Fix the file the message names, or sign in to Anthropic again from this panel, then try again.', detail: { stage: 'credential' } }
      }
      try {
        return await this.#verify(secret.text)
      } catch (e) {
        const message = redact(e.message, [secret.text, credentialFacts(secret.text)?.token])
        this.log(`model setup: anthropic verification did not finish: ${message}`)
        return { ok: false, failed: message, action: 'Fix the cause the message names, then try again.', detail: { stage: 'unknown' } }
      }
    }
  }

  async #verify(text) {
    const facts = { provider: PROVIDER }
    const fail = (stage, failed, action) => ({ ok: false, failed, action, detail: { stage, ...facts } })

    const credential = credentialFacts(text)
    if (!credential) {
      return fail('credential', `${this.authFile} is not an Anthropic subscription credential curia can read`, SIGN_IN)
    }
    const { token } = credential
    facts.credential = { kind: 'setup-token', obtained_at: credential.obtained_at, expires_at: credential.expires_at, estimated: true }
    if (credential.exp !== null && credential.exp <= this.now().getTime()) {
      return fail('credential', `The Anthropic credential passed its documented one-year lifetime ${credential.expires_at}, counted from its ${credential.obtained_at} adoption`, SIGN_IN)
    }

    // The minimal request, as Claude Code sends one with a subscription
    // credential: the usage probe's own shape, asked for a few tokens.
    const model = this.probeModel
    const started = Date.now()
    const at = this.now().toISOString()
    let res
    try {
      res = await this.fetchImpl(MESSAGES_URL, {
        method: 'POST',
        headers: {
          ...anthropicCredential({ token }).headers,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': `claude-cli/${this.claudeVersion ?? 'unknown'} (external, cli; curia integration setup)`,
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM }],
          messages: [{ role: 'user', content: VERIFY_PROMPT }],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      facts.request = { model, at, ms: Date.now() - started, error: redact(e.message, [token]) }
      return fail('request', `Anthropic could not be reached (${facts.request.error})`, 'Check that this host reaches api.anthropic.com (`curia doctor` runs the outbound check), then try again.')
    }
    const ms = Date.now() - started
    const body = await res.text().catch(() => '')
    const requestId = res.headers?.get?.('request-id') ?? null
    if (res.status < 200 || res.status >= 300) {
      const why = redact(errorSentence(body), [token])
      facts.request = { model, at, ms, status: res.status, request_id: requestId, error: why }
      if (res.status === 401 || res.status === 403) return fail('request', `Anthropic refused the credential (HTTP ${res.status}${why ? `: ${why}` : ''})`, SIGN_IN)
      if (res.status === 429) return fail('request', `Anthropic answered HTTP 429${why ? `: ${why}` : ''}`, 'Wait for the usage window to reset, or sign in with another subscription, then try again.')
      return fail('request', `Anthropic answered HTTP ${res.status}${why ? `: ${why}` : ''}`, 'Wait a moment, then try again.')
    }
    let message = null
    try { message = JSON.parse(body) } catch { /* said below */ }
    if (message?.type !== 'message' || typeof message.id !== 'string') {
      facts.request = { model, at, ms, status: res.status, request_id: requestId, error: 'the body is not a message' }
      return fail('request', 'The verification request answered something that is not a message', 'Wait a moment, then try again.')
    }
    facts.request = {
      model: typeof message.model === 'string' ? message.model : model,
      id: message.id,
      request_id: requestId,
      at,
      ms,
      stop_reason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      usage: message.usage && typeof message.usage === 'object'
        ? { input_tokens: message.usage.input_tokens ?? null, output_tokens: message.usage.output_tokens ?? null }
        : null,
    }
    if (facts.request.stop_reason !== 'end_turn' && facts.request.stop_reason !== 'max_tokens') {
      return fail('request', `The verification request ended with stop reason ${facts.request.stop_reason ?? 'unknown'}`, 'Wait a moment, then try again.')
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
    this.log(`model setup: anthropic verified — credential adopted ${credential.obtained_at ?? 'at an unknown time'}, ${facts.request.model} answered in ${ms} ms${facts.routing.applied ? ', routing preset applied' : ''}`)
    return {
      ok: true,
      emoji: '🧠',
      primary: 'Anthropic',
      secondary: `verification request completed in ${seconds(ms)}`,
      detail: facts,
    }
  }
}

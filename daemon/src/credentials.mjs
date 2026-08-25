// The daemon owns the codex model credential (#642, building the map at #641).
//
// On 2026-08-23 two agents went silent for five hours and nobody could see it.
// The ChatGPT access token had been minted ten days earlier, codex refreshed it
// over the network exactly as it is supposed to, and the write-back died on the
// `0400` bit `workspace.mjs` sets on purpose. The server had already rotated the
// refresh token by then, so the host store and both agents were stranded on one
// spent credential together. `workspace.mjs:772` predicted it in as many words:
// "the bound this buys is one access-token lifetime".
//
// This module removes that bound. The daemon refreshes BEFORE the token can die
// under an agent, so nothing downstream ever has to. Same shape as
// `githubapp.mjs`'s `TokenMinter`, which already solves this exact problem for
// GitHub App installation tokens: injected `fetchImpl` and `now`, pure expiry
// parsing, one refresh in flight at a time, and a failure that leaves the last
// good file standing.
//
// TWO HALVES, and they answer different questions.
//
//   - The BROKER keeps a live credential live. It reads the host store's own
//     `exp` claim, refreshes inside the last quarter of the token's life, writes
//     the host store, and fans the result out to live agents.
//   - The RE-AUTH FLOW gets a credential back when there is none to refresh — a
//     device login in a tmux session the operator drives from a phone, with no
//     ssh anywhere in it.
//
// WHAT HAPPENS WHEN A REFRESH FAILS IS NOW HERE TOO (#646). This module tells a
// spent refresh token apart from a network blip and latches itself off the wire
// once the provider has said the credential is dead. It does NOT cool the lane,
// freeze the agents or raise the alarm — those are the dispatcher's, because
// they are facts about the fleet rather than about this file.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TRANSIENT_RETRY_BOUND } from './credentialpolicy.mjs'
// The anthropic request this module makes is ONE question — "does this token
// work" (#660) — and it asks it with the headers `usage.mjs` already owns. The
// import runs one way: nothing in the usage reader knows about this module.
import { MODELS_URL, ANTHROPIC_VERSION, anthropicCredential } from './usage.mjs'

// ---- reading the credential ------------------------------------------------

// Where the daemon's own codex credential lives. `HOME` under compose is
// curia's own home inside the workspace root (#473), never the operator's, and
// every container mounts it at the identical path — so one string is the answer
// for the daemon, for the tmux pane, and for the `docker run` inside it.
export const codexHostStore = (home = null) => path.join(home ?? os.homedir(), '.codex')
export const codexAuthFile = (home = null) => path.join(codexHostStore(home), 'auth.json')

// The clock the SERVER stamped on the access token, in epoch milliseconds.
//
// The token is a JWT, so both values are claims in its payload, read without
// verification: the daemon is not the audience, it only needs the two numbers.
// `iat` is what makes the refresh margin a fraction of a real lifetime rather
// than a constant somebody guessed — see `refreshMarginMs`.
//
// Nulls on ANY parse failure, on purpose. `workspace.mjs`'s #351 refusal stands
// on a measured expiry, and this module's refresh decision does too: a
// credential file this parser cannot read proves nothing about the token's life,
// and a guess would either refresh every tick or never.
export function codexTokenClock(authJson) {
  try {
    const token = JSON.parse(authJson)?.tokens?.access_token
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    return {
      iat: Number.isFinite(payload.iat) ? payload.iat * 1000 : null,
      exp: Number.isFinite(payload.exp) ? payload.exp * 1000 : null,
    }
  } catch {
    return { iat: null, exp: null }
  }
}

// When the codex access token expires, in epoch milliseconds — or null when the
// file does not answer the question.
//
// It lived in `workspace.mjs` until #642, which needed the same parse. One
// parser, two callers: a second one would be free to disagree with the first
// about whether a dispatch may proceed.
export function codexAccessTokenExpiry(authJson) {
  return codexTokenClock(authJson).exp
}

// ---- when to refresh -------------------------------------------------------

// The last quarter of the token's life. A fraction rather than a constant
// because the lifetime is the provider's to change and this box does not
// negotiate it: if OpenAI halves the life tomorrow, the margin halves with it
// and nothing here needs editing.
export const REFRESH_AT_FRACTION = 0.25

// The lifetime to assume when the token states no `iat`. Two samples on one
// account, 2026-08-13 and 2026-08-23, both exactly ten days
// (docs/live-checks/644-credential-swap-heals.md §2) — so this is a measurement
// and not a default, and the quarter of it is 2.5 days.
//
// It is a FALLBACK and never the primary reading. A token that states its own
// `iat` is always read rather than assumed.
export const MEASURED_LIFETIME_MS = 10 * 24 * 60 * 60 * 1000

// The floor under the margin. A provider that started minting five-minute
// tokens would compute a 75-second margin, which is barely one dispatch tick —
// so the margin never falls below the ten minutes `githubapp.mjs` already
// judged safe against a 60 s tick plus the slowest call a token has to carry.
export const MIN_REFRESH_MARGIN_MS = 10 * 60 * 1000

export function refreshMarginMs({ iat, exp }) {
  const life = Number.isFinite(iat) && Number.isFinite(exp) && exp > iat ? exp - iat : MEASURED_LIFETIME_MS
  return Math.max(MIN_REFRESH_MARGIN_MS, Math.round(life * REFRESH_AT_FRACTION))
}

// Whether this credential wants refreshing now, and WHY — the `why` travels
// into the journal, so a refresh that fired at the wrong moment is arguable
// after the fact rather than inferred from a timestamp.
//
// An UNREADABLE expiry does not refresh. That is the deliberate direction: a
// file this module cannot parse is one it must not spend a refresh token on,
// because a refresh rotates the server-side token and a rotation this module
// cannot record is precisely the #351 failure. It is a re-auth case, not a
// refresh case, and `credentialState` reports it as one.
export function refreshDue(authJson, now = Date.now()) {
  const clock = codexTokenClock(authJson)
  if (!Number.isFinite(clock.exp)) return { due: false, why: 'the access token states no expiry, so nothing here can judge its life', ...clock }
  const margin = refreshMarginMs(clock)
  const at = clock.exp - margin
  if (now < at) {
    return { due: false, why: `${Math.round((at - now) / 60000)} min until the last ${REFRESH_AT_FRACTION * 100}% of this token's life`, ...clock, margin }
  }
  return { due: true, why: `inside the last ${REFRESH_AT_FRACTION * 100}% of the token's life (expires ${new Date(clock.exp).toISOString()})`, ...clock, margin }
}

// What every surface says about one consumer's credential, from the file alone.
// `state` is deliberately coarse — `valid`, `expiring`, `expired`, `unreadable`,
// `absent` — because the fine-grained question (is this failure terminal?) is
// #646's and needs the wire, not the disk.
export function credentialState(authJson, now = Date.now()) {
  if (authJson === null) return { state: 'absent', expires_at: null, why: 'no credential file' }
  const { due, why, exp } = refreshDue(authJson, now)
  if (!Number.isFinite(exp)) return { state: 'unreadable', expires_at: null, why }
  const expires_at = new Date(exp).toISOString()
  if (exp <= now) return { state: 'expired', expires_at, why: 'the access token expired' }
  return { state: due ? 'expiring' : 'valid', expires_at, why }
}

// ---- the refresh call ------------------------------------------------------

// Codex's own OAuth endpoint and public client id, both read out of the pinned
// binary (`strings codex | grep auth.openai.com`, codex-cli 0.146.0) rather than
// copied from a blog post. The client id is public by construction — it rides in
// the authorize URL of every device login.
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const FETCH_TIMEOUT_MS = 20_000

// One refresh, on the wire.
//
// The body is exactly the three fields #644 sent by hand on the box — no
// `scope`. That request reached OpenAI's token lookup and came back with
// `refresh_token_reused`, which is positive evidence that the shape is accepted;
// adding a fourth field nobody has measured would be a guess in front of the one
// call this whole map exists to make work.
//
// A failure carries `status` and `code` rather than being flattened into a
// message. #646 classifies on `error.code` — OpenAI answers a spent token with
// `refresh_token_reused` inside its own API error envelope, NOT the OAuth
// standard's top-level `invalid_grant` — and a classifier cannot key on a field
// this function threw away.
export async function exchangeRefreshToken({ refreshToken, fetchImpl = globalThis.fetch, tokenUrl = CODEX_TOKEN_URL, clientId = CODEX_CLIENT_ID } = {}) {
  if (!refreshToken) throw new Error('the codex credential carries no refresh token, so there is nothing to exchange — this is a re-authentication case, not a refresh case')
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'curia' },
    body: JSON.stringify({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch { /* a non-JSON body leaves the status as the whole answer */ }
  if (!res.ok) {
    // Three locations, in the order #643 measured them: OpenAI's own envelope
    // first, then the OAuth standard's top-level string, then a bare `code`.
    // The measured answer — `refresh_token_reused` — lives only in the first.
    const code = payload?.error?.code ?? payload?.error ?? payload?.code ?? null
    const detail = payload?.error?.message ?? payload?.error_description ?? text.slice(0, 200)
    const err = new Error(`OpenAI refused the codex refresh with HTTP ${res.status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`)
    err.status = res.status
    err.code = typeof code === 'string' ? code : null
    throw err
  }
  if (!payload?.access_token) {
    // Carries the status so the classifier can say WHICH success carried
    // nothing. It stays transient: a 200 with no token is a provider having a
    // bad minute, and it proves nothing about the refresh token.
    const err = new Error(`OpenAI answered the codex refresh with HTTP ${res.status} and no access token, so there is nothing to store`)
    err.status = res.status
    err.code = null
    throw err
  }
  return payload
}

// The refreshed credential, as the text that replaces `auth.json`.
//
// It MERGES rather than rebuilds. `auth.json` carries fields this exchange never
// answers for — `OPENAI_API_KEY`, `auth_mode`, `tokens.account_id` — and a
// rewrite that dropped them would hand codex a file it reads differently. A
// response that omits a rotated refresh token keeps the one already on disk,
// which is what OpenAI's own client does.
export function applyRefresh(authJson, response, { now = Date.now } = {}) {
  const auth = JSON.parse(authJson)
  const tokens = { ...(auth.tokens ?? {}) }
  tokens.access_token = response.access_token
  if (response.id_token) tokens.id_token = response.id_token
  if (response.refresh_token) tokens.refresh_token = response.refresh_token
  return `${JSON.stringify({ ...auth, tokens, last_refresh: new Date(now()).toISOString() }, null, 2)}\n`
}

// ---- classifying a failed refresh (#646) -----------------------------------
//
// The credential sibling of `health.mjs`'s `classifyFault`, and deliberately the
// same shape: `{ terminal, why }`, with `why` journalled so a wrong call is
// arguable after the fact rather than inferred from a timestamp.
//
// The direction of the asymmetry is the whole design. A wrong TRANSIENT call
// costs a few more minutes of an outage that is already happening. A wrong
// TERMINAL call cools a lane, freezes a fleet and wakes the operator at 3am for
// a network blip. So everything unrecognised is transient, and the retry bound
// in the broker is what stops "unrecognised" from meaning "forever".

// The three codes codex 0.146.0 itself recognises, read out of its own refresh
// classifier rather than guessed (docs/research/provider-credential-failures.md).
// `refresh_token_reused` is the one #643 MEASURED, on this account, on this box.
export const TERMINAL_REFRESH_CODES = Object.freeze(new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]))

// The provider whose lane a dead codex credential holds. The broker's consumer
// is `codex` and the routing table's provider is `openai`; `Cooling` is keyed by
// the second, so the translation lives here beside the credential rather than as
// a string literal at the call site.
export const CODEX_PROVIDER = 'openai'

// Statuses that are the provider asking for a retry in as many words.
const RETRY_STATUSES = new Set([408, 429])

// Does this failed refresh prove the refresh token is dead?
//
// NOTE what is NOT here: "any 401 is permanent". Codex itself takes that rule,
// and curia deliberately does not copy it. An unknown 401 does not prove the
// credential died — it proves curia has not seen this response before — and the
// bounded retry turns that into a terminal call within minutes anyway.
export function classifyRefreshFailure(err) {
  const status = Number.isFinite(err?.status) ? err.status : null
  const code = typeof err?.code === 'string' ? err.code : null

  if ((status === 400 || status === 401) && code && TERMINAL_REFRESH_CODES.has(code)) {
    return { terminal: true, why: `OpenAI answered HTTP ${status} \`${code}\`, which names a refresh token that cannot be exchanged again` }
  }
  // The OAuth standard's answer, which loses the subtype but not the verdict.
  if (status === 400 && code === 'invalid_grant') {
    return { terminal: true, why: 'OpenAI answered HTTP 400 `invalid_grant`, the OAuth standard’s dead-refresh-token answer' }
  }
  if (status === null) {
    return { terminal: false, why: `no HTTP response reached curia (${err?.message ?? err})` }
  }
  if (RETRY_STATUSES.has(status) || status >= 500) {
    return { terminal: false, why: `HTTP ${status} is the provider asking for a retry, not an answer about the refresh token` }
  }
  return { terminal: false, why: `HTTP ${status}${code ? ` \`${code}\`` : ''} is not a response curia recognises, and an unrecognised answer does not prove the credential died` }
}

// How many consecutive transient failures make a terminal call anyway.
//
// Five, at the 60-second dispatch tick, is five minutes. That is the number the
// ticket argued for in prose — "the retry bound turns a persistent unknown into
// a terminal call within minutes anyway" — and the reason it is small is that a
// refresh only starts 2.5 days before the token dies, so the alternative to
// giving up early is an outage nobody is told about until the token expires.
//
// It counts CONSECUTIVE failures and a success resets it, so a provider that
// flaps for an hour never reaches the bound.
export { TRANSIENT_RETRY_BOUND }

// ---- writing it down -------------------------------------------------------

// Temp file plus rename, which is the whole reason this function exists.
//
// Codex's own write is `O_WRONLY|O_CREAT|O_TRUNC` — a truncating in-place
// rewrite — and `workspace.mjs` notes that a refresh racing a read can be seen
// torn. The daemon writes the same file far more often than codex does, so it
// writes it the way Claude Code does instead: the reader either sees the whole
// old file or the whole new one, and never half of each.
//
// The temp file is created in the SAME directory, because rename is only atomic
// within one filesystem and the config dirs are a mount of their own.
//
// The mode is restored explicitly. `writeFileSync` applies a mode only when it
// CREATES a file, and every path here writes over one that already exists.
export function writeCredentialFile(file, text, { mode = 0o600 } = {}) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.curia-${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, text, { mode })
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return file
}

// The mode an agent's copy carries, and the reason it is not 0600.
//
// `workspace.mjs` seeds the container copy at `0400` so an ordinary in-place
// refresh by the AGENT fails rather than silently rotating the host store away.
// A broker does not change that reason: the agent still must not be the thing
// that rotates this credential. So the daemon restores 0400 after every write,
// and the bit that used to be the bug is now the bit that says who owns the
// rotation.
export const AGENT_CREDENTIAL_MODE = 0o400
export const HOST_CREDENTIAL_MODE = 0o600

// ---- the broker ------------------------------------------------------------

// One per daemon, driven by the dispatch tick.
//
// THE TICK IS THE RIGHT CLOCK, and that is a decision rather than convenience: a
// deploy replaces the daemon process at any moment, and the next tick re-derives
// everything from the token's own `exp`. Nothing is remembered across a restart
// because nothing needs to be — the file states it.
export class CodexCredentialBroker {
  // The refresh in flight, or null. One at a time, for `TokenMinter`'s reason
  // said about a rarer call: an exchange rotates the server-side refresh token,
  // so two concurrent exchanges would spend each other's and strand the store.
  #refreshing = null

  // Consecutive transient refresh failures. Reset by a success and by adoption,
  // never persisted: see `TRANSIENT_RETRY_BOUND`.
  #transientFailures = 0

  constructor({
    home = null, fetchImpl = globalThis.fetch, now = Date.now,
    log = () => {}, journal = () => {},
  } = {}) {
    this.authFile = codexAuthFile(home)
    this.fetchImpl = fetchImpl
    this.now = now
    this.log = log
    this.journal = journal
    // Whether the last pass could refresh, for the surfaces. Null until a pass
    // has tried — "not attempted" and "succeeded" are different facts.
    this.lastError = null
    this.lastRefreshAt = null
    // The hold, or null. Set when a refresh proves the credential dead, and
    // lifted ONLY by adoption — a dead refresh token does not resurrect on a
    // timer, so nothing here counts down.
    //
    // NOT PERSISTED, on purpose. A restart clears it, the token is still inside
    // its last quarter so `refreshDue` is still true, and the next tick spends
    // exactly one refresh to hear the same answer and re-arm. That costs one
    // call and buys a hold derived from the provider rather than remembered
    // from a file — the posture this whole module already takes.
    this.held = null
  }

  // The host store's text, or null when there is none. Never throws: a box with
  // no codex login is a legal box, and every caller here treats it as a re-auth
  // case rather than an error.
  read() {
    try {
      return fs.readFileSync(this.authFile, 'utf8')
    } catch {
      return null
    }
  }

  // What the surfaces say about this consumer.
  state() {
    return {
      consumer: 'codex',
      // The provider, beside the consumer, since the store became provider-keyed
      // (#648). One consumer on this lane today, and the row still names the
      // provider because that is what `Cooling` and the routing table are keyed
      // by — the translation lives here rather than at every reader.
      provider: CODEX_PROVIDER,
      file: this.authFile,
      store: this.authFile,
      delivery: CONSUMER_CREDENTIALS.codex.deliver.how,
      heal: CONSUMER_CREDENTIALS.codex.heal,
      ...credentialState(this.read(), this.now()),
      last_refresh_at: this.lastRefreshAt,
      last_error: this.lastError,
      // The card says "held" rather than leaving the operator to infer it from
      // an expiry that is still hours away. A held credential can be perfectly
      // valid right now and still be unrecoverable.
      held: this.held,
    }
  }

  // Refresh the host store if the token is inside the last quarter of its life.
  //
  // HOST STORE FIRST, then the fan-out, and the ordering is load-bearing. A
  // crash between the two leaves the host correct and the agents stale, which
  // the next tick repairs. The reverse ordering loses the rotation the moment
  // the crash lands — which is today's failure, arriving by a new road.
  //
  // Returns `{ refreshed, why }`. It never throws: a pass that cannot reach
  // OpenAI leaves the last good file standing, that token is good for days
  // rather than the hour a GitHub token gets, and the next tick is 60 s away.
  async refreshIfDue() {
    const text = this.read()
    if (text === null) return { refreshed: false, why: 'no codex credential on this box' }
    // THE LATCH. Once the provider has said the refresh token is dead, every
    // further exchange asks a question already answered — and answers it into
    // the journal once a minute, which is the record the operator will read to
    // reconstruct the incident. `held` is reported without `terminal`, so the
    // dispatcher arms the alarm on the transition and never again.
    if (this.held) return { refreshed: false, held: true, why: this.held.why }
    const verdict = refreshDue(text, this.now())
    if (!verdict.due) return { refreshed: false, why: verdict.why }
    if (this.#refreshing) return this.#refreshing
    const pending = (async () => {
      let auth
      try {
        auth = JSON.parse(text)
      } catch (e) {
        return this.#failed(`the codex credential is not readable JSON (${e.message})`, null)
      }
      let response
      try {
        response = await exchangeRefreshToken({ refreshToken: auth?.tokens?.refresh_token, fetchImpl: this.fetchImpl })
      } catch (e) {
        return this.#failedExchange(e)
      }
      const fresh = applyRefresh(text, response, { now: this.now })
      try {
        writeCredentialFile(this.authFile, fresh, { mode: HOST_CREDENTIAL_MODE })
      } catch (e) {
        return this.#failed(`the refreshed codex credential could not be written to ${this.authFile} (${e.message})`, null)
      }
      const expiry = codexAccessTokenExpiry(fresh)
      this.#transientFailures = 0
      this.lastError = null
      this.lastRefreshAt = new Date(this.now()).toISOString()
      this.journal('credential_refreshed', {
        consumer: 'codex',
        expires_at: expiry ? new Date(expiry).toISOString() : null,
        why: verdict.why,
      })
      this.log(`refreshed the codex credential — it now expires ${expiry ? new Date(expiry).toISOString() : 'at an unreadable instant'}`)
      return { refreshed: true, why: verdict.why }
    })()
    this.#refreshing = pending
    try {
      return await pending
    } finally {
      this.#refreshing = null
    }
  }

  // One failed exchange, classified. Transient failures count toward the bound;
  // the bound and a terminal code both end in the same hold, because five
  // unrecognised answers and one recognised one leave the operator with the
  // identical job.
  #failedExchange(e) {
    const { terminal, why } = classifyRefreshFailure(e)
    const code = typeof e?.code === 'string' ? e.code : null
    const status = Number.isFinite(e?.status) ? e.status : null
    if (terminal) return this.#hold({ why, code, status, by: 'provider' })
    this.#transientFailures += 1
    if (this.#transientFailures >= TRANSIENT_RETRY_BOUND) {
      return this.#hold({
        why: `${TRANSIENT_RETRY_BOUND} refreshes in a row failed without an answer curia recognises — the last was: ${why}`,
        code, status, by: 'bound',
      })
    }
    this.lastError = why
    this.journal('credential_refresh_failed', {
      consumer: 'codex', code, status, terminal: false,
      attempt: this.#transientFailures, of: TRANSIENT_RETRY_BOUND, why,
    })
    this.log(`the codex credential refresh failed (${why}) — attempt ${this.#transientFailures} of ${TRANSIENT_RETRY_BOUND}, the file already on disk stands until the next tick`)
    return { refreshed: false, terminal: false, why, code, status }
  }

  // Arm the hold, and say WHICH of the two roads led here.
  //
  // The give-up gets its own event rather than a fifth `credential_refresh_failed`.
  // "The provider said it is dead" and "curia stopped believing the unknown" are
  // different facts, and only the first is evidence about the credential — an
  // operator reading the journal after the fact has to be able to tell them
  // apart without counting lines.
  #hold({ why, code, status, by }) {
    this.held = { why, code, status, by, at: new Date(this.now()).toISOString() }
    this.lastError = why
    this.#transientFailures = 0
    this.journal(by === 'bound' ? 'credential_refresh_exhausted' : 'credential_refresh_failed', {
      consumer: 'codex', code, status, terminal: true, why,
      ...(by === 'bound' ? { attempts: TRANSIENT_RETRY_BOUND } : {}),
    })
    this.log(`the codex credential cannot be refreshed (${why}) — the lane is held until someone signs in again`)
    return { refreshed: false, terminal: true, why, code, status, by }
  }

  #failed(why, code, status = null) {
    this.lastError = why
    this.journal('credential_refresh_failed', { consumer: 'codex', code, status, why })
    this.log(`the codex credential refresh failed (${why}) — the file already on disk stands until the next tick`)
    return { refreshed: false, why, code, status }
  }

  // Adopt a credential that came from somewhere other than a refresh — today,
  // the device login the re-auth flow drives. Same atomic write, same mode.
  adopt(text) {
    // The store may not exist at all: a box whose codex login has never run has
    // no `~/.codex`, and this is the call that gives it one.
    fs.mkdirSync(path.dirname(this.authFile), { recursive: true })
    writeCredentialFile(this.authFile, text, { mode: HOST_CREDENTIAL_MODE })
    // Adoption is the ONLY thing that lifts the hold. The operator just proved
    // intent by completing a login; asking them to confirm again is ceremony.
    this.held = null
    this.#transientFailures = 0
    this.lastError = null
    this.lastRefreshAt = new Date(this.now()).toISOString()
    return codexAccessTokenExpiry(text)
  }

  // Push the host store into the config dirs of LIVE agents.
  //
  // LIVE AGENTS ONLY, and never "every config dir under cfg/". There were 245 of
  // those on the box the day this was written; a dead one holds nothing worth a
  // live credential, and `removeCredentials` already sweeps them. `targets` is
  // therefore the caller's list of running agents, not a directory listing.
  //
  // A config dir with no `auth.json` is SKIPPED rather than seeded. The file's
  // presence is the evidence that this agent is a codex agent whose spawn wrote
  // one — the same rule `refreshGhCredentials` reads for the GitHub token, and
  // the reason a claude agent never grows a codex credential it cannot use.
  //
  // Byte-identical files are not rewritten, so a steady box does no disk writes
  // at all and the returned list means "these agents just changed".
  fanOut(targets = []) {
    const text = this.read()
    if (text === null) return { healed: [], errors: [] }
    const healed = []
    const errors = []
    for (const { session, cfgDir } of targets) {
      if (!cfgDir) continue
      const dest = path.join(cfgDir, 'auth.json')
      let current
      try {
        current = fs.readFileSync(dest, 'utf8')
      } catch {
        continue // no codex credential here: not a codex agent, or already swept
      }
      if (current === text) continue
      try {
        writeCredentialFile(dest, text, { mode: AGENT_CREDENTIAL_MODE })
        healed.push(session)
      } catch (e) {
        errors.push({ session, why: e.message })
      }
    }
    return { healed, errors }
  }
}

// ---- the re-authentication surface -----------------------------------------
//
// `codex login --device-auth` in a tmux session the operator attaches to over
// the tailnet. Verified end to end on the box, codex-cli 0.146.0
// (docs/live-checks/644-credential-swap-heals.md §1). The pane prints:
//
//     1. Open this link in your browser and sign in to your account
//        https://auth.openai.com/codex/device
//     2. Enter this one-time code (expires in 15 minutes)
//        83CC-A4ZTO
//
// Nothing is pasted back, so the operator never has to type into a terminal on a
// phone. That is what made this shape win over scraping a PTY and over
// reimplementing PKCE inside curia: no parsing contract with the CLI, no new
// auth story (ttyd already runs behind `tailscale serve` with the #151 identity
// check), and one mechanism for every consumer.

// The prefix, and the whole reason it is a prefix: `curia-attach.sh` admits
// anything matching `^curia-[A-Za-z0-9._-]+$`, so this session is reachable on
// the existing attach surface with no whitelist change — and it is recognisable
// to every sweep in one test.
export const AUTH_SESSION_PREFIX = 'curia-auth-'
export const AUTH_SESSION_RE = /^curia-auth-[a-z0-9][a-z0-9-]*$/

// ONE SESSION PER CONSUMER, enforced by the fixed name rather than by a lock.
// Starting a second re-auth finds the first alive and attaches to it, which is
// the behaviour an operator on a phone expects from pressing a button twice.
export const authSessionName = (consumer) => `${AUTH_SESSION_PREFIX}${consumer}`

// THE INVARIANT: no sweep may ever walk one of these.
//
// It used to hold by accident — the sweeps iterate `this.agents`, and nothing
// registers an auth session there — and an accident is not an invariant. What it
// guards is specific: `stallSweep` would find a pane whose transcript is not
// growing and type a continue message into a login prompt. So every sweep that
// could reach a session name asks this question out loud, and the tests assert
// each refusal by name.
export const isAuthSession = (name) => AUTH_SESSION_RE.test(String(name ?? ''))

// Thirty minutes, comfortably past the device code's own fifteen. The margin is
// for the operator, not the code: a phone that locks, a browser that asks for a
// second factor, a person who walks away mid-login and comes back.
//
// IT IS THE DEFAULT AND NOT THE RULE (#721). Each lane declares its own window,
// because a shared number one lane can never reach looks like a decision and is
// not: the codex login exits on its own at fifteen minutes and takes its session
// with it, so this window has only ever fired on the anthropic lane. Declaring
// it twice is what turns "never reached" from an accident into a statement.
export const REAUTH_TIMEOUT_MS = 30 * 60 * 1000

// How long the codex one-time code lives, when the pane does not say.
//
// Measured on the box (docs/live-checks/680-device-code-expiry.md): the login
// exits at fifteen minutes with `device auth timed out after 15 minutes`. The
// number is read off the pane where it can be (`DEVICE_CODE_LIFE_RE` below), and
// this is the fallback for a frame that never showed it - so if OpenAI changes
// the lifetime, curia follows it rather than going quietly wrong.
export const DEVICE_CODE_LIFE_MS = 15 * 60 * 1000

// What the card reads off the pane.
//
// The code pattern is ANCHORED on codex's own sentence rather than matched
// loosely, because a wrong code is worse than no code: the card degrades to
// "open the terminal", and a card showing four wrong characters sends the
// operator round the loop a second time. Two observed samples were `83CC-A4ZTO`
// and `85PT-A4E5M`; the range is widened a little either side of them, and the
// anchor is what keeps that widening safe.
export const DEVICE_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device[^\s]*/
export const DEVICE_CODE_RE = /one-time code[^\n]*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4,8})/

// THE CODE'S OWN CLOCK, off the line the code pattern already anchors on (#721):
//
//     2. Enter this one-time code (expires in 15 minutes)
//
// Read rather than assumed, because that fifteen decides which sentence curia
// tells the operator about a login that ended, and a number living only in prose
// is one upstream can change without anybody noticing. A frame that does not
// state it reads `null`, and the lane's declared lifetime stands in.
export const DEVICE_CODE_LIFE_RE = /one-time code[^\n]*?expires in (\d+) minutes?/

export function scrapeDeviceAuth(pane) {
  const text = String(pane ?? '')
  const minutes = Number(text.match(DEVICE_CODE_LIFE_RE)?.[1])
  return {
    url: text.match(DEVICE_URL_RE)?.[0] ?? null,
    code: text.match(DEVICE_CODE_RE)?.[1] ?? null,
    codeLifeMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : null,
  }
}

// The command the pane runs, as one shell line for `tmux.newSession`.
//
// `docker run` and not `codex` directly: the tmux image carries docker but not
// codex (measured, #644 §1), so the indirection is required rather than chosen.
//
// NO `curia.session` LABEL, deliberately. `listContainers` filters on that label
// and `#sweepContainers` removes anything it finds whose pane is gone — which is
// exactly what would happen to a login the operator started and had not finished.
// The flow tears its own container down instead, on completion and on timeout.
//
// `--user` is not decoration. The live check ran this as root and left a
// root-owned `auth.json` the daemon could not read; the uid that owns the mount
// is the uid that must write into it.
// ONE BUILDER, TWO LANES since #660. Everything above is true of both logins —
// the same image, the same uid, the same unlabelled container, the same scratch
// mount — and only the environment variable naming the config home and the argv
// differ. Splitting the shell-safety check across two copies is how one of them
// stops checking.
export function loginRunCmd({ name, image, cfgDir, agentUid, guestCfg = '/cfg', docker = 'docker', homeEnv, argv }) {
  for (const [what, value] of [['the session name', name], ['the image', image], ['the config dir', cfgDir], ['the uid', String(agentUid)]]) {
    if (!/^[A-Za-z0-9_.:/@=-]+$/.test(String(value ?? ''))) {
      throw new Error(`refusing to build the re-authentication command: ${what} (${value}) is not shell-safe`)
    }
  }
  return [
    docker, 'run', '--rm', '-i', '-t', '--init',
    '--name', name,
    '--user', `${agentUid}:${agentUid}`,
    '-v', `${cfgDir}:${guestCfg}`,
    '-e', `${homeEnv}=${guestCfg}`,
    image, ...argv,
  ].join(' ')
}

export function reauthRunCmd(opts) {
  return loginRunCmd({ ...opts, homeEnv: 'CODEX_HOME', argv: ['codex', 'login', '--device-auth'] })
}

// `claude setup-token` in the same shape (#660).
//
// `CLAUDE_CONFIG_DIR` and not `CODEX_HOME`, and it is NOT there to catch a
// credential: #659 measured that `setup-token` writes none. It is there because
// the CLI writes `.claude.json` wherever its config home points, and an
// unpointed one would write into the image's own `$HOME` — a login leaving state
// in a layer that every agent container then starts from.
//
// NO CREDENTIAL REACHES THIS CONTAINER, deliberately. The daemon's own token is
// not passed in, so a login never runs against a credential it is replacing, and
// the pane cannot show the operator a token that was already on the box.
export function setupTokenRunCmd(opts) {
  return loginRunCmd({ ...opts, homeEnv: 'CLAUDE_CONFIG_DIR', argv: ['claude', 'setup-token'] })
}

// The states a flow reports. `waiting` is the long one — the operator has the
// link and the code and curia has nothing to do but watch the file appear.
//
// `expired` AND `abandoned` ARE TWO ENDINGS, not one (#721). Both present the
// same way - the session is gone and no credential arrived - and until the code
// carried a clock, curia said `abandoned` to both. That word blames the operator
// for closing a window, and on the codex lane the ordinary ending is the
// opposite: the login exits by itself when its code runs out, and the operator
// never had a window to close. The code's own lifetime is the only thing on the
// box that can tell the two apart, because codex logs neither ending and the
// pane is gone before the next tick can read it.
export const REAUTH_STATES = Object.freeze(['starting', 'waiting', 'done', 'timeout', 'expired', 'abandoned', 'failed'])

// What each ending means, in the operator's words. One sentence per state,
// written once: the dashboard card, the Discord alarm and the journal detail all
// say the same thing, so a login that ended does not get three accounts of why.
export const REAUTH_ENDING_WHY = Object.freeze({
  timeout: 'nobody finished it before curia stopped waiting',
  expired: 'the one-time code ran out before anybody finished the login',
  abandoned: 'the login session closed before its code ran out',
  failed: 'the login produced a credential curia refused',
})

// One re-authentication, from `start` to a credential on disk.
//
// It is polled from the dispatch tick rather than waited on, for the reason the
// broker is: the daemon may be replaced at any moment, and a flow that lived in
// a promise would vanish with it. What survives a restart is the tmux session
// and whatever the login leaves behind, both of which the lane re-reads from
// scratch — plus one line in the journal saying when the login began, which is
// the only thing neither of them can restate (#671).
//
// KEYED BY PROVIDER, NOT BY CONSUMER (#660), and the rename is a correction
// rather than a tidy-up. `curia-auth-openai` was provider-keyed from the first
// commit while the code called it a consumer, and the anthropic lane is what
// makes the muddle expensive: one login there serves TWO consumers, the claude
// containers and the overseer, so "consumer: anthropic" would name nothing that
// exists.
//
// WHAT VARIES PER PROVIDER IS A LANE, injected the way the broker is. The
// machine here — one session per provider, the thirty-minute window, the
// scrape-before-deadline ordering, the teardown, the journal — is the same on
// both, and #660 kept it that way rather than growing a second flow that would
// have to re-earn all five sweep guards.
export class ReauthFlow {
  constructor({
    lanes = {}, image, agentUid, cfgDirFor, docker = 'docker',
    newSession, capturePane, killSession, hasSession, stopContainer,
    openLogin = () => null,
    now = Date.now, log = () => {}, journal = () => {},
  }) {
    this.lanes = lanes
    this.image = image
    this.agentUid = agentUid
    this.cfgDirFor = cfgDirFor
    this.docker = docker
    // The tmux calls arrive RAW, never through the dispatcher's wrapped copies.
    // Those wrappers exist to keep agent bookkeeping straight — ordered kills,
    // the write pacing, the auth-session refusal on `sendText` — and this flow
    // is not an agent. Keeping it off those paths is what makes the refusal on
    // the agent side unconditional: nothing has to carve an exception out of it.
    this.newSession = newSession
    this.capturePane = capturePane
    this.killSession = killSession
    this.hasSession = hasSession
    this.stopContainer = stopContainer
    // What a restart cannot re-derive, read back off the journal (#671). It is
    // injected the way `now` and `hasSession` are, so this class still holds no
    // reduction and no file — it asks one question and gets one record.
    this.openLogin = openLogin
    this.now = now
    this.log = log
    this.journal = journal
    this.flow = null
  }

  // What the surfaces read. Null when nothing is in flight — the dashboard
  // draws no card, and Discord has nothing to link to.
  //
  // THE CODE IS IN HERE and the journal never sees it. A one-time auth code in a
  // chat log is a credential in a chat log; the dashboard is published over the
  // tailnet behind the operator's own Tailscale login, and that is the one
  // surface it may reach.
  //
  // THE ANTHROPIC TOKEN IS NOT IN HERE AND NEVER WILL BE (#660). A device code is
  // a fifteen-minute secret and this object is the one place it is allowed; a
  // `setup-token` credential is a YEAR-long one, and the lane hands it straight
  // to the store without it passing through anything a surface reads. That is
  // why `finish` returns an expiry and not a token.
  state() {
    if (!this.flow) return null
    const { provider, session, state, url, code, typed, startedAt, deadline } = this.flow
    return {
      provider,
      session,
      state,
      url,
      code,
      // Whether the operator has to type into this pane, which is the one thing
      // the two lanes differ on that the OPERATOR can feel. `codex login
      // --device-auth` pastes nothing back; `claude setup-token` waits on a code
      // the browser shows, and `sendText` refuses this session by name — so the
      // typing is the operator's to do, on the device they opened the link on.
      typed,
      started_at: new Date(startedAt).toISOString(),
      expires_at: new Date(deadline).toISOString(),
      seconds_left: Math.max(0, Math.round((deadline - this.now()) / 1000)),
    }
  }

  // The last login that ended without a credential, kept after `clear()` has
  // taken the live card away (#721).
  //
  // WHY THIS OUTLIVES THE FLOW. The credential card that sent the operator here
  // still stands and still says to sign in, so nobody is stranded - but a login
  // that vanished mid-attempt without a sentence is the same class of bug as the
  // credential that vanished without one. This is the sentence, and the card
  // that already stands is where it lands. It is dropped the moment another
  // login for that provider starts or completes, so the page never shows a
  // stale ending beside a live attempt.
  ending = null

  // The lane for one provider, or a refusal naming what this daemon can sign in.
  laneFor(provider) {
    return this.lanes[provider] ?? null
  }

  get providers() {
    return Object.keys(this.lanes)
  }

  // Start a login, or hand back the one already running.
  //
  // The scratch config dir is CLEARED BY THE LANE first, and each lane clears
  // what its own completion rule would otherwise read twice. The codex lane
  // removes a leftover `auth.json`, because a stale credential adopted on the
  // first poll is the silent return to the failure this map exists for. The
  // anthropic lane has no such file to remove (#659 measured that `setup-token`
  // writes none) and clears the dir anyway, so a second attempt never starts on
  // the first one's `.claude.json`.
  async start({ provider = CODEX_PROVIDER } = {}) {
    const lane = this.laneFor(provider)
    if (!lane) throw new Error(`there is no re-authentication lane for provider "${provider}" — this daemon can sign in: ${this.providers.join(', ') || 'nothing'}`)
    const session = authSessionName(provider)
    if (this.flow && this.flow.state === 'waiting') return { started: false, session, why: 'a re-authentication is already running for this provider' }
    if (await this.hasSession(session)) {
      // A session with no flow is one a previous daemon process started. Adopt
      // it rather than killing the operator's half-finished login, and take its
      // clock off the journal where there is one (#671) — the tick has usually
      // resumed it already, and an operator typing `reauth` in the first minute
      // after a restart is what makes it worth asking here too.
      //
      // A session the journal never saw still gets adopted, on a fresh window.
      // A deadline nothing can date is worse than a generous one.
      if (!this.flow && !this.#resume(provider)) this.#track(provider, session)
      return { started: false, session, why: 'a re-authentication session is already open — attach to it' }
    }
    // THE SESSION IS THE LIVENESS, NOT THE RECORD, and the order above is what
    // says so. An open journal record whose session is gone must not answer
    // "already running" to an operator asking for a login: nothing is running,
    // and the `reauth_started` this start writes replaces the stale record.
    const cfgDir = this.cfgDirFor(session)
    fs.mkdirSync(cfgDir, { recursive: true })
    lane.prepare(cfgDir)
    const shellCmd = lane.runCmd({
      name: session, image: this.image, cfgDir, agentUid: this.agentUid, docker: this.docker,
    })
    await this.newSession({ name: session, cwd: cfgDir, shellCmd })
    if (this.ending?.provider === provider) this.ending = null
    this.#track(provider, session)
    this.journal('reauth_started', { provider, session })
    this.log(`re-authentication started for ${provider} in tmux session ${session}`)
    return { started: true, session }
  }

  #track(provider, session, startedAt = this.now()) {
    const lane = this.laneFor(provider)
    this.flow = {
      provider,
      session,
      cfgDir: this.cfgDirFor(session),
      state: 'waiting',
      url: null,
      code: null,
      codeSeen: false,
      typed: Boolean(lane?.typed),
      startedAt,
      // BOTH CLOCKS COME OFF THE LANE (#721), and they are different clocks.
      // The window is curia's patience; the code's lifetime is the login's own,
      // and only the second one can say whether a vanished session timed out or
      // was closed. A lane with no code of its own states `null` and its
      // vanishings all read as abandonment, which is the truth there.
      deadline: startedAt + (Number.isFinite(lane?.windowMs) ? lane.windowMs : REAUTH_TIMEOUT_MS),
      codeLifeMs: Number.isFinite(lane?.codeLifeMs) ? lane.codeLifeMs : null,
    }
  }

  // Take back a login a previous daemon process started (#671).
  //
  // The flow is process state and the module keeps no file, which is the same
  // posture the credential hold takes. What a restart cannot re-derive lives in
  // the journal instead — one `reauth_started` line, one terminal line, and the
  // boot reads what is left between them, the way ADR-0015 reads an overseer
  // turn a restart killed.
  //
  // ONLY THE CLOCK COMES BACK. The session is named by its provider, the pane
  // still holds the link and the code and is scraped again on this same tick,
  // and the credential is wherever the login left it. The deadline is the one
  // fact the dead process was holding that nothing else can restate, and
  // keeping it honest is what stops a login outliving its window twice over.
  //
  // NOTHING IS DECIDED HERE and nothing is announced. The record is tracked,
  // and the ordinary poll below finishes it: adopted when the operator
  // completed the login in the browser while curia was down, timed out when the
  // window is spent, abandoned when the pane is gone. Repeating that ordering
  // here is how the two copies would come to disagree.
  #resume(provider = null) {
    if (this.flow) return null
    const record = this.openLogin()
    if (!record || !this.laneFor(record.provider)) return null
    // `start` names the provider it is being asked for, and another provider's
    // open login is not an answer to that question. The poll names nothing and
    // takes whichever record the journal hands it.
    if (provider && record.provider !== provider) return null
    const session = authSessionName(record.provider)
    this.#track(record.provider, session, record.startedAt)
    this.log(`re-adopted the ${record.provider} re-authentication that began ${new Date(record.startedAt).toISOString()} — the session is ${session}`)
    return this.flow
  }

  // One poll, from the dispatch tick. Never throws — an unreadable pane proves
  // nothing and the next tick asks again.
  //
  // The order is deliberate. The credential is checked BEFORE the deadline, so a
  // login that completed in the last seconds of the window is adopted rather
  // than torn down; and the pane is scraped before either, so the card is
  // populated even on the tick that finishes the flow.
  async poll() {
    // A restart is not an ending (#671). Before this asks whether there is a
    // login to poll, it asks the journal whether a previous process left one.
    this.#resume()
    if (!this.flow || this.flow.state !== 'waiting') return null
    const pane = await this.#scrape()
    const adopted = await this.#adoptIfComplete(pane)
    if (adopted) return adopted
    if (this.now() >= this.flow.deadline) return this.#end('timeout', 'reauth_timed_out')
    // A session that is gone with no credential is an operator who closed it, or
    // a `codex login` that died. Saying so is the point: a re-authentication
    // that silently vanished is the same class of bug as the credential that
    // silently vanished.
    let present
    try {
      present = await this.hasSession(this.flow.session)
    } catch {
      return null // indeterminate tmux is not absence, here as everywhere
    }
    if (!present) return this.#endVanished()
    return null
  }

  // The session is gone and no credential arrived. Which of the two endings is
  // that?
  //
  // THE CODE'S AGE DECIDES, and it is counted from `startedAt` (#721). That
  // instant is a few seconds before codex printed the code, so it makes the code
  // look slightly older than it is - which fails toward calling an abandonment a
  // timeout, and that is the harmless direction. The other candidate, the
  // `reauth_code_seen` instant, is a tick late and fails toward calling a
  // timeout an abandonment: the exact sentence this exists to stop curia saying.
  // `startedAt` also survives a restart already, because #671 restores it.
  #endVanished() {
    const life = this.flow.codeLifeMs
    if (Number.isFinite(life) && this.now() - this.flow.startedAt >= life) {
      return this.#end('expired', 'reauth_code_expired', { code_life_s: Math.round(life / 1000) })
    }
    return this.#end('abandoned', 'reauth_abandoned')
  }

  // Returns the pane text so the completion check reads the SAME capture the
  // card did. On the anthropic lane that matters rather than merely saving a
  // call: the pane is the completion signal there, and two captures a moment
  // apart could show the operator a link from one frame and adopt a token from
  // another.
  async #scrape() {
    let pane
    try {
      pane = await this.capturePane(this.flow.session)
    } catch {
      return null
    }
    const { url, code, codeLifeMs } = this.laneFor(this.flow.provider).scrape(pane)
    if (url) this.flow.url = url
    if (code) this.flow.code = code
    // The pane outranks the lane's declared number, because the pane is the
    // login speaking for itself. A frame that says nothing changes nothing.
    if (Number.isFinite(codeLifeMs)) this.flow.codeLifeMs = codeLifeMs
    // Journalled ONCE and WITHOUT the code, so the record says the operator had
    // something to act on without becoming a place the code is written down.
    if (code && !this.flow.codeSeen) {
      this.flow.codeSeen = true
      this.journal('reauth_code_seen', { provider: this.flow.provider, session: this.flow.session })
    }
    return pane
  }

  // Has the login finished, and if so has the credential been taken?
  //
  // The LANE answers, because the two lanes answer differently and ADR-0027's
  // rule holds on only one of them. Codex writes a credential file, so the file
  // appearing is completion. `claude setup-token` writes nothing and prints the
  // token once (#659 §3), so the pane is the only channel and the token
  // appearing is completion.
  //
  // THREE RETURNS, and the middle one is the reason this is not a boolean.
  // `null` means "not finished, ask again next tick" — including a probe that
  // could not reach the network, which proves nothing about the token. A THROW
  // means the login produced something curia refuses, and that ends the flow
  // loudly. An object means done.
  async #adoptIfComplete(pane) {
    let adopted
    try {
      adopted = await this.laneFor(this.flow.provider).finish({ pane, cfgDir: this.flow.cfgDir })
    } catch (e) {
      return this.#end('failed', 'reauth_failed', { why: `the fresh credential could not be adopted (${e.message})` })
    }
    if (!adopted) return null
    const expiry = Number.isFinite(adopted.expiresAt) ? adopted.expiresAt : null
    const done = this.#end('done', 'reauth_completed', {
      expires_at: expiry ? new Date(expiry).toISOString() : null,
    })
    this.log(`re-authentication for ${done.provider} completed — the credential now expires ${expiry ? new Date(expiry).toISOString() : 'at an instant curia cannot read'}`)
    return done
  }

  // Tear down and record. The container goes explicitly, because it carries no
  // `curia.session` label and no sweep will ever collect it.
  //
  // The scratch config dir is removed WHOLE, credential included: it has been
  // copied to the host store by now, and a live refresh token left lying in a
  // directory nothing sweeps is the leftover `removeCredentials` exists to stop.
  //
  // THE TEARDOWN IS PART OF THE SECRET HANDLING SINCE #660, not only tidiness.
  // On the anthropic lane the pane itself holds a plaintext year-long token in
  // the frame the login left behind, so killing the session on the tick that
  // adopts is what takes the last copy off the box. It is the same call in the
  // same place; what changed is that skipping it would now leave a credential
  // readable to anything that can attach.
  #end(state, event, extra = {}) {
    const flow = this.flow
    flow.state = state
    const why = REAUTH_ENDING_WHY[state] ?? null
    const detail = { provider: flow.provider, session: flow.session, after_s: Math.round((this.now() - flow.startedAt) / 1000), ...extra }
    if (why && !detail.why) detail.why = why
    this.journal(event, detail)
    // The ending the surfaces read. Only a login that produced no credential
    // leaves one: `done` is announced on its own tick and has nothing left to
    // explain, and a stale success beside the next attempt would be noise.
    this.ending = state === 'done'
      ? null
      : { provider: flow.provider, state, why, ended_at: new Date(this.now()).toISOString(), after_s: detail.after_s }
    if (state !== 'done') this.log(`re-authentication for ${flow.provider} ended as ${state} after ${detail.after_s}s — ${why ?? 'no reason recorded'}`)
    // Detached, and in that order: the session first, then the container the
    // session's client may already have taken with it. Neither failure may
    // reach the caller — the outcome is already decided and journalled, and a
    // teardown that could not run is a log line rather than a lost credential.
    void (async () => {
      try {
        await this.killSession(flow.session)
      } catch (e) {
        this.log(`could not kill ${flow.session} (${e.message})`)
      }
      try {
        await this.stopContainer(flow.session)
      } catch (e) {
        this.log(`could not remove the ${flow.session} container (${e.message})`)
      }
    })()
    try {
      fs.rmSync(flow.cfgDir, { recursive: true, force: true })
    } catch (e) {
      this.log(`could not remove the re-authentication scratch dir ${flow.cfgDir} (${e.message})`)
    }
    return { provider: flow.provider, state, why, ...extra }
  }

  // Drop a finished flow so the surfaces stop drawing it. The dispatcher calls
  // this once it has said whatever the outcome needed saying.
  clear() {
    if (this.flow && this.flow.state !== 'waiting') this.flow = null
  }
}

// ---- the anthropic store (#648) --------------------------------------------
//
// The second store, and the one three consumers share. The claude agent
// containers and the overseer run on the SAME value from the SAME account, so
// the store is keyed by PROVIDER and not by consumer: two stores, three rows.
// A store per consumer would mean two copies of one token, two expiry answers
// free to disagree, and a re-authentication that healed one row and left the
// other stale.
//
// IT IS NOT `~/.claude/.credentials.json`. Writing curia's own record into the
// CLI's own path would leave a host `claude` session reading a file it did not
// write in a shape it did not expect, and #53 already paid for one version of
// that confusion. Codex's store stays where it is for the opposite reason: that
// one IS the CLI's store, and the CLI must read it.
//
// THE TOKEN IS A `setup-token` CREDENTIAL AND IT DOES NOT ROTATE. A `claude
// /login` credential has a real refresh lineage — measured on the workstation on
// 2026-08-23, an `expiresAt` 8.0 hours out and a `refreshTokenExpiresAt` 17.7
// days out — and it is refused anyway: it hands every agent container the
// operator's full account scope, where a `setup-token` credential can only make
// model requests (`scope=user:inference` alone, visible in the authorize URL
// #659 read). So the anthropic provider declares `refresh: null`, and `null` is
// a statement rather than a gap.

export const ANTHROPIC_PROVIDER = 'anthropic'

// Beside `overseer/tokens/`, under the same workspace root, so curia's own
// credential state is one tree. The overseer mounts it READ-ONLY the way #392's
// token tree is mounted; nothing in that container has a reason to write a
// credential, and the shell in there is the reason to say so.
export const anthropicStoreDir = (workspaceRoot) => path.join(workspaceRoot, 'credentials')
export const anthropicStoreFile = (workspaceRoot) => path.join(anthropicStoreDir(workspaceRoot), 'anthropic.json')

// `sk-ant-oat01-…` is the subscription credential the map keeps. Asserted rather
// than escaped, because the value lands in a JSON string the CLI parses and in
// an env file docker reads line by line — a newline in either makes a reader
// read something other than what curia meant to write.
export const ANTHROPIC_TOKEN_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/

// What Anthropic documents for a `setup-token` credential. It is an ESTIMATE and
// every surface says so: the token itself states no dates, so this number is
// applied to the instant curia adopted the login and never read off the
// credential. `MEASURED_LIFETIME_MS` above is the opposite kind of number — that
// one is three samples of a token that states its own clock.
export const ANTHROPIC_DOCUMENTED_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000

// How long before the estimated end the row starts reading `expiring`.
//
// NOT `REFRESH_AT_FRACTION`. That fraction is a REFRESH MARGIN — the codex lane
// starts exchanging inside it, so it has to be long enough for the exchange and
// short enough not to spend one early. Nothing exchanges on this lane, so the
// only question the word answers is "should the operator plan a login", and a
// quarter of a year would answer yes for three months at a stretch.
//
// A month, because the estimate underneath it is soft: the token states no dates
// and the lifetime comes from the docs, so a window measured in weeks is honest
// where one measured in hours would pretend to a precision nothing here has.
export const ANTHROPIC_EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

// ---- what the CLI actually needs on disk ------------------------------------
//
// MEASURED ON THE BOX, 2026-08-24, agent image `curia-agent:2.1.220-…`, throwaway
// containers against scratch config dirs. #659 settled that the CLI reads
// `<CLAUDE_CONFIG_DIR>/.credentials.json` in the sandboxed shape; this is the
// shape that file has to have, and the obvious guess is wrong:
//
//   accessToken alone                          → `Not logged in · Please run /login`
//   accessToken + future expiresAt             → `Not logged in`
//   accessToken + future expiresAt + scopes    → PONG, exit 0
//   accessToken + PAST expiresAt + scopes      → `Not logged in`
//   accessToken + expiresAt + subscriptionType → `Not logged in`
//
// So THREE fields are load-bearing — `accessToken`, an `expiresAt` in the
// future, and a non-empty `scopes` — and `subscriptionType` is not one of them.
// A file missing any of the three reads as no credential at all, which on this
// lane would be a fleet that cannot spawn.
//
// An `expiresAt` ten minutes out still authenticated, so the CLI applies no
// pre-expiry refusal window to a credential it cannot refresh. What it refuses
// is a date already past.
export const CLAUDE_CREDENTIAL_FILE = '.credentials.json'

// The scope a `setup-token` credential actually carries, read out of the
// authorize URL #659 captured (`scope=user:inference`). Written truthfully
// rather than padded: this file is curia's statement about what the token can
// do, and the bound #180 bought is the reason the map refused the `/login`
// shape.
export const SETUP_TOKEN_SCOPES = Object.freeze(['user:inference'])

// The instant the DELIVERED FILE claims, which is not the instant the ROW
// claims, and the difference is deliberate.
//
// The row's expiry comes from `obtained_at` and reads `unknown` without one,
// because curia must not invent an age for a credential it inherited from an env
// file. The FILE has no such freedom: the CLI refuses a past date and refuses a
// missing one, so a legacy seeded credential still needs a future instant
// written into it. `seeded_at` records when an older daemon read that seed.
// #726 retired new seeds without invalidating existing store records.
//
// STABLE ACROSS TICKS, which is why it is not simply `now + a year`: the fan-out
// compares file contents and rewrites nothing that already matches, and a
// rolling instant would rewrite every live agent's credential once a minute.
export function deliveryExpiry(record) {
  const at = Date.parse(record?.obtained_at ?? record?.seeded_at ?? '')
  return Number.isFinite(at) ? at + ANTHROPIC_DOCUMENTED_LIFETIME_MS : null
}

// The bytes the claude CLI reads. `claudeAiOauth` is the CLI's own key, which is
// why `usage.mjs` and `sandbox.mjs` have both read it since #100.
export function claudeCredentialsJson(record) {
  const token = record?.token
  if (!ANTHROPIC_TOKEN_RE.test(String(token ?? ''))) {
    throw new Error('refusing to write a claude credential: the anthropic store holds no `sk-ant-…` token')
  }
  const expiresAt = deliveryExpiry(record)
  if (!Number.isFinite(expiresAt)) {
    throw new Error('refusing to write a claude credential: the anthropic store states neither an adoption nor a seed instant, and the CLI refuses a file with no `expiresAt`')
  }
  return `${JSON.stringify({
    claudeAiOauth: { accessToken: token, expiresAt, scopes: [...SETUP_TOKEN_SCOPES] },
  }, null, 2)}\n`
}

// One agent's copy, written the way every other daemon-owned credential is:
// temp file plus rename, in the directory it lands in.
//
// 0600 AND NOT 0400. The codex copy is read-only because the AGENT must not be
// the thing that rotates it — codex refreshes over the network and writes the
// result back. A `setup-token` credential has nothing to rotate, and #659
// measured the file's md5 unchanged across four authenticated runs, so there is
// no write to defend against and no reason to make the agent's own credential
// unwritable to it.
export function writeClaudeCredentials(cfgDir, record) {
  return writeCredentialFile(path.join(cfgDir, CLAUDE_CREDENTIAL_FILE), claudeCredentialsJson(record), { mode: HOST_CREDENTIAL_MODE })
}

// ---- the two contract tables ------------------------------------------------
//
// ADR-0027 left this open in as many words: the table "may no longer be keyed by
// harness alone". It is two tables now, and neither is keyed by harness.
//
// WHAT VARIES BY PROVIDER — how a credential expires, whether it rotates, how you
// sign back in — and WHAT VARIES BY CONSUMER — how the credential reaches it,
// what happens to a live one when it changes — are different axes. One table
// keyed on either forces the anthropic answer to be written twice, which is how
// the claude row and the overseer row drift apart.

export const PROVIDER_CREDENTIALS = Object.freeze({
  openai: Object.freeze({
    // The token states its own clock: `exp` is a claim in the JWT.
    credentialExpiry: (record) => codexAccessTokenExpiry(record?.text ?? record),
    // A real rotation, on the wire, in the broker above.
    refresh: exchangeRefreshToken,
    // `codex login --device-auth`: a link and a one-time code, nothing pasted
    // back. Shipped by #642 and measured end to end on the box.
    reauth: 'device-login',
  }),
  anthropic: Object.freeze({
    // NOT from the token. `setup-token` states no dates, so the estimate is the
    // documented lifetime applied to the instant curia adopted the login — and
    // `null` where curia never saw that instant.
    credentialExpiry: (record) => {
      const at = Date.parse(record?.obtained_at ?? '')
      return Number.isFinite(at) ? at + ANTHROPIC_DOCUMENTED_LIFETIME_MS : null
    },
    // EXPLICITLY NULL, and the map says why: `null` is a statement, not a gap.
    // The `/login` shape that would have made this a function is refused, so
    // what detects a dead credential here is the account-usage probe's 401
    // rather than a refresh that fails.
    refresh: null,
    // `claude setup-token`. The flow itself is #660's: the CLI puts its whole
    // TUI on stdout and writes no credential file, so ADR-0027's completion rule
    // has nothing to detect on this lane (#659 §3).
    reauth: 'setup-token',
  }),
})

// How the credential reaches one consumer, and what happens to a live one when
// it changes. `heal` is measured on both lanes rather than reasoned about:
// #644 §1 for codex, #659 §2 for claude.
export const CONSUMER_CREDENTIALS = Object.freeze({
  codex: Object.freeze({
    provider: 'openai',
    deliver: Object.freeze({ how: 'config-dir', file: 'auth.json' }),
    heal: 'in-place',
  }),
  claude: Object.freeze({
    provider: ANTHROPIC_PROVIDER,
    deliver: Object.freeze({ how: 'config-dir', file: CLAUDE_CREDENTIAL_FILE }),
    heal: 'in-place',
  }),
  overseer: Object.freeze({
    provider: ANTHROPIC_PROVIDER,
    // THE STORE ITSELF, behind a read-only mount — the #392 precedent, the same
    // shape in the same container for the same reason. The daemon writes one
    // file and compose mounts it; there is no per-consumer copy to keep in step.
    // `runOneTurn` re-reads it per turn, beside the checkout pass and the
    // credential pass it already runs per turn.
    deliver: Object.freeze({ how: 'mount', file: 'anthropic.json' }),
    heal: 'next-turn',
  }),
})

export const CONSUMER_NAMES = Object.freeze(Object.keys(CONSUMER_CREDENTIALS))

// The delivery shapes this daemon knows how to perform. A consumer naming
// anything else is a consumer nothing delivers to, and `config.mjs` refuses it
// at boot rather than letting a dispatch discover it.
export const DELIVERY_SHAPES = Object.freeze(new Set(['config-dir', 'mount']))

// Why a HARNESS's provider is unusable, or null when it is fine. A harness whose
// provider has no contract row would spawn agents curia cannot give a credential
// to, cannot state an expiry for and cannot sign back in — the gap ADR-0027 left
// open. `config.mjs` refuses the boot on it; this is the reader both it and the
// suite ask, so a future harness's failure is a sentence rather than a crash.
export function providerContractFault(harness, provider) {
  if (PROVIDER_CREDENTIALS[provider]) return null
  return `harnesses.${harness} runs on provider "${provider}", which has no row in PROVIDER_CREDENTIALS in credentials.mjs — an agent under it would get no model credential. Known providers: ${Object.keys(PROVIDER_CREDENTIALS).join(', ')}`
}

// Why a consumer row is unusable, or null when it is fine. One reader, so the
// boot refusal and the suite ask the same question.
export function consumerContractFault(consumer) {
  const row = CONSUMER_CREDENTIALS[consumer]
  if (!row) return `"${consumer}" has no row in CONSUMER_CREDENTIALS — known consumers: ${CONSUMER_NAMES.join(', ')}`
  if (!PROVIDER_CREDENTIALS[row.provider]) {
    return `"${consumer}" names provider "${row.provider}", which has no row in PROVIDER_CREDENTIALS — known providers: ${Object.keys(PROVIDER_CREDENTIALS).join(', ')}`
  }
  if (!row.deliver || !DELIVERY_SHAPES.has(row.deliver.how)) {
    return `"${consumer}" declares no delivery curia can perform (got ${JSON.stringify(row.deliver?.how ?? null)}) — known shapes: ${[...DELIVERY_SHAPES].join(', ')}`
  }
  return null
}

// ---- the store ---------------------------------------------------------------

// One per daemon, beside the codex broker, and deliberately NOT a broker: there
// is nothing to refresh here. It owns the record and fan-out to live claude
// agents. #726 retired environment seeding after re-authentication shipped.
export class AnthropicCredentialStore {
  constructor({ workspaceRoot, now = Date.now, journal = () => {} } = {}) {
    this.file = anthropicStoreFile(workspaceRoot)
    this.now = now
    this.journal = journal
  }

  // The record, or null when this box has none. Never throws: a box that has
  // never signed in is a legal box, and every caller treats it as a re-auth case.
  read() {
    try {
      const record = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return ANTHROPIC_TOKEN_RE.test(String(record?.token ?? '')) ? record : null
    } catch {
      return null
    }
  }

  #write(record) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    writeCredentialFile(this.file, `${JSON.stringify(record, null, 2)}\n`, { mode: HOST_CREDENTIAL_MODE })
    return record
  }

  // A login curia watched complete. THE ONLY PLACE `obtained_at` IS STAMPED, and
  // the reason the row can state a date at all.
  adopt(token) {
    if (!ANTHROPIC_TOKEN_RE.test(String(token ?? ''))) {
      throw new Error('refusing to adopt an anthropic credential: a subscription token is `sk-ant-…`')
    }
    const record = { token, obtained_at: new Date(this.now()).toISOString(), seeded_at: null }
    this.#write(record)
    this.journal('credential_adopted', { provider: ANTHROPIC_PROVIDER, obtained_at: record.obtained_at })
    return record
  }

  // What the surfaces say, for ONE consumer. Two of the three rows land here and
  // both name the store they share, so the page can say so rather than leaving
  // the operator to infer it from two identical dates.
  state(consumer) {
    const record = this.read()
    const row = { consumer, provider: ANTHROPIC_PROVIDER, store: this.file, refresh: null }
    if (!record) {
      return { ...row, state: 'absent', expires_at: null, why: 'no anthropic credential on this box' }
    }
    const exp = PROVIDER_CREDENTIALS[ANTHROPIC_PROVIDER].credentialExpiry(record)
    if (!Number.isFinite(exp)) {
      return {
        ...row,
        state: 'unknown',
        expires_at: null,
        why: 'this credential was seeded from an env file rather than adopted from a login, so curia knows no date for it — sign in once to get one',
      }
    }
    const now = this.now()
    const expires_at = new Date(exp).toISOString()
    const why = `the documented one-year lifetime, counted from the ${record.obtained_at} adoption — an estimate from Anthropic's docs, not a date the token states`
    if (exp <= now) return { ...row, state: 'expired', expires_at, why }
    return {
      ...row,
      state: exp - now <= ANTHROPIC_EXPIRING_WINDOW_MS ? 'expiring' : 'valid',
      expires_at,
      why,
    }
  }

  // Push the record into the config dirs of LIVE claude agents.
  //
  // IT CREATES THE FILE WHERE THERE IS NONE, which is the one place this differs
  // from the codex fan-out. That one skips a config dir with no `auth.json`,
  // because the file's presence is the evidence that an agent is a codex agent.
  // Here the absence is the ordinary case: every agent spawned before this slice
  // got its credential as an environment variable and has no file at all, and
  // #659 measured that writing one into such an agent heals it with no restart
  // — its expired variable still in its environment. So the harness is the
  // evidence instead, and the agents that predate this slice are not killed.
  //
  // Byte-identical files are not rewritten, so a steady box does no disk writes
  // and the returned list means "these agents just changed".
  fanOut(targets = []) {
    const record = this.read()
    if (!record) return { healed: [], errors: [] }
    let text
    try {
      text = claudeCredentialsJson(record)
    } catch (e) {
      return { healed: [], errors: [{ session: null, why: e.message }] }
    }
    const healed = []
    const errors = []
    for (const { session, cfgDir, harness } of targets) {
      if (!cfgDir || harness !== 'claude') continue
      const dest = path.join(cfgDir, CLAUDE_CREDENTIAL_FILE)
      let current = null
      try {
        current = fs.readFileSync(dest, 'utf8')
      } catch { /* absent is the ordinary case here, not a skip */ }
      if (current === text) continue
      try {
        writeCredentialFile(dest, text, { mode: HOST_CREDENTIAL_MODE })
        healed.push(session)
      } catch (e) {
        errors.push({ session, why: e.message })
      }
    }
    return { healed, errors }
  }
}

// ---- reading a wrapped TUI (#660) -------------------------------------------
//
// MEASURED, not assumed. `claude setup-token` is an Ink app, and Ink wraps its
// own text at the pane width — it emits a REAL newline, so `tmux capture-pane
// -J` does not rejoin it and no tmux flag does. Verified on the workstation at
// 60 columns: the authorize URL came back as six lines, five of them exactly 60
// characters and the sixth short, and `-J` returned the identical six.
//
// So a value longer than the pane is wide arrives in pieces, and something has
// to put it back together. That is this function, and it is one function because
// the same two facts govern both values the lane reads:
//
//   1. A string with no spaces in it breaks at EXACTLY the wrap width, so every
//      piece except the last is full width. A short line therefore ends the run,
//      which is what stops a rejoin from eating the paragraph underneath.
//   2. The pieces sit alone on their lines. Ink's `gap:1` puts a blank line
//      between every child of the column, so the line after the last piece is
//      empty and fails any continuation test.
//
// Both guards are needed. The width rule alone would run on past a value whose
// length happens to be a multiple of the pane width; the charset rule alone
// would swallow a following single-word line if a layout ever dropped the gap.
export function joinWrapped(lines, start, continues) {
  let out = lines[start]
  let width = out.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i - 1].length < width) break // the previous piece was the tail
    if (!continues(lines[i])) break
    out += lines[i]
    width = Math.max(width, lines[i].length)
  }
  return out
}

// The pane, trimmed line by line. Ink pads the frame one column in, so every
// line carries a leading space the reassembly must not keep — and tmux already
// strips the trailing ones.
const paneLines = (pane) => String(pane ?? '').split('\n').map((l) => l.trim())

// ---- the anthropic login's own pane ----------------------------------------

// The authorize URL, for the card. `claude.com/cai/oauth/authorize`, captured on
// the workstation on 2026-08-24 — and it is the CARD's copy only: the operator
// still has to type the code back into the pane, so the card is a convenience
// here where on the codex lane it is the whole interaction.
export const ANTHROPIC_AUTHORIZE_HEAD = 'https://claude.com/cai/oauth/authorize?'
// A URL's own charset. Deliberately excludes the space, which is what makes rule
// 1 above hold for it.
const URL_PIECE_RE = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/

export function scrapeAuthorizeUrl(pane) {
  const lines = paneLines(pane)
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(ANTHROPIC_AUTHORIZE_HEAD)) continue
    const url = joinWrapped(lines, i, (l) => URL_PIECE_RE.test(l))
    // Parsed rather than pattern-matched, and checked for the two parameters a
    // PKCE authorize URL cannot work without. A reassembly that ran long lands
    // its junk in the last parameter, so this is what stops the card offering a
    // link that fails after the operator has already opened it.
    try {
      const parsed = new URL(url)
      if (parsed.searchParams.get('code_challenge') && parsed.searchParams.get('state')) return url
    } catch { /* not a URL is not the URL */ }
  }
  return null
}

// The token, reassembled off the completed frame.
//
// WHAT THE FRAME LOOKS LIKE, read out of the box's own agent image rather than
// guessed — `curia-agent:2.1.220-0.146.0-7cba0f7a`, Claude Code 2.1.220, the
// render tree for the `setup-token` success state:
//
//     ✓ Long-lived authentication token created successfully!
//                                             <- Ink `gap:1`
//     Your OAuth token (valid for 1 year):
//
//     sk-ant-oat01-…                          <- a bare Text, no border, no prefix
//
//     Store this token securely. You won't be able to see it again.
//
//     Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
//
// The token is its own child of a `flexDirection: "column"` box with no border
// and no padding of its own, so it is ALONE on its line or lines — and the two
// lines that follow it both contain spaces, so neither can be mistaken for a
// continuation. The last of them holds the literal string `<token>` and not the
// value, so it cannot be mistaken for the token either.
//
// 108 characters on this account, measured, so it wraps on any pane narrower
// than that and does not on a wide one. Both cases go through `joinWrapped`.
const TOKEN_PIECE_RE = /^[A-Za-z0-9_-]+$/

export function scrapeSetupToken(pane) {
  const lines = paneLines(pane)
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('sk-ant-')) continue
    const token = joinWrapped(lines, i, (l) => TOKEN_PIECE_RE.test(l))
    if (ANTHROPIC_TOKEN_RE.test(token)) return token
  }
  return null
}

// ---- asking Anthropic whether the scrape is right ---------------------------
//
// THIS IS WHAT MAKES THE SCRAPE SAFE, and it is the answer to ADR-0027's own
// objection to scraping. That ADR chose a tmux surface precisely to avoid a
// parsing contract with a CLI's output, and this lane cannot avoid one: the
// token is printed once and written nowhere (#659 §3). So the contract is made
// FALSIFIABLE instead — curia asks the provider whether what it read is a
// working credential, and adopts only on a yes.
//
// The failure mode this removes is the expensive one. `adopt` checks a prefix and
// a charset, which a mis-reassembled token would pass; it would then be written
// into the store and fanned out to every live claude agent, and the fleet would
// stop. A probe turns that into a `failed` flow and an unchanged store.
//
// `/v1/models` is the request, for the reason `usage.mjs` already uses it: it
// costs no quota and it answers the only question here, which is whether the
// credential authenticates at all.
export const TOKEN_CHECK_TIMEOUT_MS = 10_000

// `{ ok }` adopts, `{ retry }` waits for the next tick, and neither is a
// judgement about the operator. The split matters: a 401 says the token is wrong
// and the flow should end loudly, while a timeout says curia could not ask and
// proves nothing about the token — treating the second as the first would throw
// away a good login because the box's network blinked.
export async function checkAnthropicToken(token, { fetchImpl = globalThis.fetch, timeoutMs = TOKEN_CHECK_TIMEOUT_MS } = {}) {
  let res
  try {
    res = await fetchImpl(MODELS_URL, {
      headers: {
        ...anthropicCredential({ token }).headers,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { ok: false, retry: true, why: `curia could not reach Anthropic to check the token (${e?.message ?? e})` }
  }
  if (res.ok) return { ok: true, retry: false, why: 'Anthropic accepted the token' }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      retry: false,
      why: `Anthropic answered HTTP ${res.status} for the token read off the login pane — either the login did not finish or curia read the frame wrong, and neither is a credential worth storing`,
    }
  }
  return { ok: false, retry: true, why: `Anthropic answered HTTP ${res.status}, which says nothing about the token` }
}

// ---- the two lanes ----------------------------------------------------------
//
// One object per provider, holding the three things the flow above cannot know:
// what to run, what the pane means, and what completion is. Everything else —
// the session name, the window, the teardown, the journal — is the flow's.

// `codex login --device-auth`. Shipped by #642 and measured end to end on the
// box; #660 only lifted it out of `ReauthFlow` so a second lane could exist.
export class DeviceLoginLane {
  // The operator reads a link and a code and types nothing back, which is what
  // made this shape win for a phone.
  typed = false

  // THIS LANE ENDS ON THE CODE'S CLOCK, NOT ON CURIA'S (#721). The login exits
  // by itself at fifteen minutes and takes its tmux session with it, so the
  // window below is a backstop that has never fired here - it is stated anyway,
  // because a session that outlived its own code is exactly the case nothing
  // else would end.
  codeLifeMs = DEVICE_CODE_LIFE_MS

  windowMs = REAUTH_TIMEOUT_MS

  constructor({ broker }) {
    this.broker = broker
  }

  get provider() { return CODEX_PROVIDER }

  // The pane's whole interaction, so Discord can say what to expect.
  get howTo() {
    return 'Open the session and follow the two lines codex prints: a link, then a one-time code that lives fifteen minutes. Nothing is pasted back.'
  }

  prepare(cfgDir) {
    fs.rmSync(path.join(cfgDir, 'auth.json'), { force: true })
  }

  runCmd(opts) { return reauthRunCmd(opts) }

  scrape(pane) { return scrapeDeviceAuth(pane) }

  // The credential file appearing in the scratch dir is the completion signal —
  // not the pane's "Successfully logged in", which is a wording upstream owns.
  async finish({ cfgDir }) {
    let text
    try {
      text = fs.readFileSync(path.join(cfgDir, 'auth.json'), 'utf8')
    } catch {
      return null
    }
    // A file that is not a credential is not completion. Left in place: the
    // login may still be writing it, and the next tick reads it again.
    if (!Number.isFinite(codexAccessTokenExpiry(text))) return null
    return { expiresAt: this.broker.adopt(text) }
  }
}

// `claude setup-token` (#660). The lane whose completion rule ADR-0027 does not
// cover, and the reason this slice is separate from #648.
export class SetupTokenLane {
  // The operator has to type the code back into this pane. `sendText` refuses a
  // `curia-auth-` session by name — that guard is what stops the stall ladder
  // typing into a login prompt — so curia cannot do it for them, and the
  // writable ttyd terminal is where it happens.
  typed = true

  // NO CODE WITH A LIFE OF ITS OWN, and `null` is the statement rather than the
  // gap (#721). The authorize URL's own expiry has never been measured, so this
  // lane claims nothing about it and every vanished session here reads as an
  // abandonment. The thirty-minute window is the only clock on this lane, and it
  // is the only lane it has ever fired on.
  codeLifeMs = null

  windowMs = REAUTH_TIMEOUT_MS

  constructor({ store, check = checkAnthropicToken }) {
    this.store = store
    this.check = check
  }

  get provider() { return ANTHROPIC_PROVIDER }

  get howTo() {
    return 'Open the session, follow the link, and paste the code the browser shows back into the same terminal. curia takes the token from there; it never appears in this channel.'
  }

  // NOTHING TO CLEAR, and that is the measured fact rather than an oversight:
  // `setup-token` writes no credential file (#659 §3), so there is no stale one
  // to adopt. The dir is emptied anyway so a second attempt does not start on the
  // first one's `.claude.json`.
  prepare(cfgDir) {
    fs.rmSync(cfgDir, { recursive: true, force: true })
    fs.mkdirSync(cfgDir, { recursive: true })
  }

  runCmd(opts) { return setupTokenRunCmd(opts) }

  // No code to show. The codex lane reads one OUT of the pane for the operator;
  // here the operator puts one IN, so the card carries the link alone and says
  // nothing it would have to invent.
  scrape(pane) { return { url: scrapeAuthorizeUrl(pane), code: null, codeLifeMs: null } }

  // THE PANE IS THE CREDENTIAL CHANNEL, which is what the whole slice turns on.
  //
  // Three outcomes, in the order they are cheap: no token in the frame yet is
  // `null` and the next tick looks again; a token Anthropic accepts is adopted;
  // a token Anthropic rejects throws, which ends the flow as `failed` and leaves
  // the store untouched.
  async finish({ pane }) {
    const token = scrapeSetupToken(pane)
    if (!token) return null
    const verdict = await this.check(token)
    if (verdict.retry) return null
    if (!verdict.ok) throw new Error(verdict.why)
    // `adopt` stamps `obtained_at`, which is the whole reason the row's expiry
    // column can read a date instead of `unknown` (#648).
    const record = this.store.adopt(token)
    return { expiresAt: deliveryExpiry(record) }
  }
}

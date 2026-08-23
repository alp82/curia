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
// WHAT HAPPENS WHEN A REFRESH FAILS IS NOT HERE. Classifying a spent token
// against a network blip, cooling the lane and deciding freeze-or-kill is #646,
// and it is blocked on research this module deliberately does not pre-empt. A
// failed refresh here logs, journals and leaves the last good file in place.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
    const code = payload?.error?.code ?? payload?.error ?? null
    const detail = payload?.error?.message ?? payload?.error_description ?? text.slice(0, 200)
    const err = new Error(`OpenAI refused the codex refresh with HTTP ${res.status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`)
    err.status = res.status
    err.code = typeof code === 'string' ? code : null
    throw err
  }
  if (!payload?.access_token) {
    throw new Error(`OpenAI answered the codex refresh with HTTP ${res.status} and no access token, so there is nothing to store`)
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
      file: this.authFile,
      ...credentialState(this.read(), this.now()),
      last_refresh_at: this.lastRefreshAt,
      last_error: this.lastError,
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
        return this.#failed(e.message, e.code ?? null, e.status ?? null)
      }
      const fresh = applyRefresh(text, response, { now: this.now })
      try {
        writeCredentialFile(this.authFile, fresh, { mode: HOST_CREDENTIAL_MODE })
      } catch (e) {
        return this.#failed(`the refreshed codex credential could not be written to ${this.authFile} (${e.message})`, null)
      }
      const expiry = codexAccessTokenExpiry(fresh)
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
export const REAUTH_TIMEOUT_MS = 30 * 60 * 1000

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

export function scrapeDeviceAuth(pane) {
  const text = String(pane ?? '')
  return {
    url: text.match(DEVICE_URL_RE)?.[0] ?? null,
    code: text.match(DEVICE_CODE_RE)?.[1] ?? null,
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
export function reauthRunCmd({ name, image, cfgDir, agentUid, guestCfg = '/cfg', docker = 'docker' }) {
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
    '-e', `CODEX_HOME=${guestCfg}`,
    image, 'codex', 'login', '--device-auth',
  ].join(' ')
}

// The states a flow reports. `waiting` is the long one — the operator has the
// link and the code and curia has nothing to do but watch the file appear.
export const REAUTH_STATES = Object.freeze(['starting', 'waiting', 'done', 'timeout', 'abandoned', 'failed'])

// One re-authentication, from `start` to a credential on disk.
//
// It is polled from the dispatch tick rather than waited on, for the reason the
// broker is: the daemon may be replaced at any moment, and a flow that lived in
// a promise would vanish with it. What survives a restart is the tmux session
// and the file it will write, both of which `adoptIfComplete` re-reads from
// scratch.
export class ReauthFlow {
  constructor({
    broker, image, agentUid, cfgDirFor, docker = 'docker',
    newSession, capturePane, killSession, hasSession, stopContainer,
    now = Date.now, log = () => {}, journal = () => {},
  }) {
    this.broker = broker
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
  state() {
    if (!this.flow) return null
    const { consumer, session, state, url, code, startedAt, deadline } = this.flow
    return {
      consumer,
      session,
      state,
      url,
      code,
      started_at: new Date(startedAt).toISOString(),
      expires_at: new Date(deadline).toISOString(),
      seconds_left: Math.max(0, Math.round((deadline - this.now()) / 1000)),
    }
  }

  // Start a device login, or hand back the one already running.
  //
  // The scratch config dir is emptied of any previous `auth.json` FIRST.
  // Completion is detected by that file appearing, so a leftover from an earlier
  // attempt would be adopted on the very first poll — a stale credential read as
  // a fresh login is the silent return to the failure this map exists for.
  async start({ consumer = 'openai' } = {}) {
    const session = authSessionName(consumer)
    if (this.flow && this.flow.state === 'waiting') return { started: false, session, why: 'a re-authentication is already running for this consumer' }
    if (await this.hasSession(session)) {
      // A session with no flow record is one a previous daemon process started.
      // Adopt the record rather than killing the operator's half-finished login.
      if (!this.flow) this.#track(consumer, session)
      return { started: false, session, why: 'a re-authentication session is already open — attach to it' }
    }
    const cfgDir = this.cfgDirFor(session)
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.rmSync(path.join(cfgDir, 'auth.json'), { force: true })
    const shellCmd = reauthRunCmd({
      name: session, image: this.image, cfgDir, agentUid: this.agentUid, docker: this.docker,
    })
    await this.newSession({ name: session, cwd: cfgDir, shellCmd })
    this.#track(consumer, session)
    this.journal('reauth_started', { consumer, session })
    this.log(`re-authentication started for ${consumer} in tmux session ${session}`)
    return { started: true, session }
  }

  #track(consumer, session) {
    this.flow = {
      consumer,
      session,
      cfgDir: this.cfgDirFor(session),
      state: 'waiting',
      url: null,
      code: null,
      codeSeen: false,
      startedAt: this.now(),
      deadline: this.now() + REAUTH_TIMEOUT_MS,
    }
  }

  // One poll, from the dispatch tick. Never throws — an unreadable pane proves
  // nothing and the next tick asks again.
  //
  // The order is deliberate. The credential is checked BEFORE the deadline, so a
  // login that completed in the last seconds of the window is adopted rather
  // than torn down; and the pane is scraped before either, so the card is
  // populated even on the tick that finishes the flow.
  async poll() {
    if (!this.flow || this.flow.state !== 'waiting') return null
    await this.#scrape()
    const adopted = this.#adoptIfComplete()
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
    if (!present) return this.#end('abandoned', 'reauth_abandoned')
    return null
  }

  async #scrape() {
    let pane
    try {
      pane = await this.capturePane(this.flow.session)
    } catch {
      return
    }
    const { url, code } = scrapeDeviceAuth(pane)
    if (url) this.flow.url = url
    if (code) this.flow.code = code
    // Journalled ONCE and WITHOUT the code, so the record says the operator had
    // something to act on without becoming a place the code is written down.
    if (code && !this.flow.codeSeen) {
      this.flow.codeSeen = true
      this.journal('reauth_code_seen', { consumer: this.flow.consumer, session: this.flow.session })
    }
  }

  // The credential file appearing in the scratch dir is the completion signal —
  // not the pane's "Successfully logged in", which is a wording upstream owns.
  #adoptIfComplete() {
    let text
    try {
      text = fs.readFileSync(path.join(this.flow.cfgDir, 'auth.json'), 'utf8')
    } catch {
      return null
    }
    if (!Number.isFinite(codexAccessTokenExpiry(text))) {
      // A file that is not a credential is not completion. Left in place: the
      // login may still be writing it, and the next tick reads it again.
      return null
    }
    let expiry
    try {
      expiry = this.broker.adopt(text)
    } catch (e) {
      return this.#end('failed', 'reauth_failed', { why: `the fresh credential could not be adopted (${e.message})` })
    }
    const done = this.#end('done', 'reauth_completed', {
      expires_at: expiry ? new Date(expiry).toISOString() : null,
    })
    this.log(`re-authentication for ${done.consumer} completed — the codex credential now expires ${expiry ? new Date(expiry).toISOString() : 'at an unreadable instant'}`)
    return done
  }

  // Tear down and record. The container goes explicitly, because it carries no
  // `curia.session` label and no sweep will ever collect it.
  //
  // The scratch config dir is removed WHOLE, credential included: it has been
  // copied to the host store by now, and a live refresh token left lying in a
  // directory nothing sweeps is the leftover `removeCredentials` exists to stop.
  #end(state, event, extra = {}) {
    const flow = this.flow
    flow.state = state
    const detail = { consumer: flow.consumer, session: flow.session, after_s: Math.round((this.now() - flow.startedAt) / 1000), ...extra }
    this.journal(event, detail)
    if (state !== 'done') this.log(`re-authentication for ${flow.consumer} ended as ${state} after ${detail.after_s}s`)
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
    return { consumer: flow.consumer, state, ...extra }
  }

  // Drop a finished flow so the surfaces stop drawing it. The dispatcher calls
  // this once it has said whatever the outcome needed saying.
  clear() {
    if (this.flow && this.flow.state !== 'waiting') this.flow = null
  }
}

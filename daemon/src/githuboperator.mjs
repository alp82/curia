// The operator's own GitHub authorization (#891, ADR-0031).
//
// The review gate's approval is the operator's judgment, and GitHub records
// it only under the operator's own account: an App cannot approve for a
// human, and an App-minted approval on an App-authored pull request is the
// self-approval GitHub refuses (ADR-0018). The source deployment posts it on
// the host `gh` login. The packaged daemon has no host login, and the #891
// rehearsal stalled there: the operator pressed approve, `gh pr review` ran
// with no credential, and the run waited on a review nobody could post.
//
// WHAT REPLACES THE HOST LOGIN is a user access token GitHub hands the App
// when the operator installs it. The manifest asks for the authorization on
// install (`request_oauth_on_install`) and on every later change to the
// installation (`setup_on_update`), so the operator never signs in by hand:
// the install they do anyway is the authorization. GitHub sends a one-use
// code to the App's callback, this module exchanges it with the App's client
// id and secret, reads the login it stands for, and keeps the result as one
// owner-only secret file, `secrets/github-operator.json`.
//
// THE TOKEN IS SHORT, and this module refreshes it. A user token of an App
// that expires them lives eight hours and its refresh token six months. The
// approval is asked for at a press hours or weeks after the install, so
// `token()` refreshes inside the margin before it hands a value out, once
// for concurrent callers, and rewrites the file. An App that does not expire
// them answers no `expires_in`, and the token is kept as it is.
//
// WHAT A REFUSAL MEANS. No file, a refresh GitHub refuses, and a token GitHub
// no longer accepts all read the same to the caller: curia holds no
// authorization it can use, and the one cure is to install the App again
// from the GitHub card, which repeats the authorization. The sentence says
// so, and the card's verification turns on the same sentence. Nothing here
// falls back to a host login, because under a root there is none.
//
// NEVER IN THE ENVIRONMENT, A LOG, OR AN ANSWER. The token reaches exactly
// one `gh` child per approval through daemongh.mjs, the way minted tokens
// do. `status()` and `verify()` answer the login and the dates, never a value.

import { readSecret, writeSecret } from '../../cli/src/secrets.mjs'
import { APP_SECRET, api } from './githubapp.mjs'

export const OPERATOR_SECRET = 'github-operator.json'

// GitHub's token endpoint, for the exchange and the refresh alike. It answers
// HTTP 200 with `{ error, error_description }` on a bad code or refresh token,
// so the body decides, never the status.
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const FETCH_TIMEOUT_MS = 20_000

// A token is refreshed this long before its own end. The approval is one
// `gh` call, so one poll interval plus the call is margin enough, and the
// same ten minutes the installation tokens keep.
export const OPERATOR_REFRESH_MARGIN_MS = 10 * 60 * 1000

// What a browser may send back as the code. It is composed into a request
// body here, so its shape is named rather than trusted.
export const AUTHORIZATION_CODE_RE = /^[A-Za-z0-9_-]{1,255}$/

const REINSTALL = 'Reinstall the App from the GitHub card of Setup, which authorizes curia as you again'

async function tokenCall(body, { fetchImpl }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'curia' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const text = await res.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = null }
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} at its token endpoint${payload?.error_description ? `: ${payload.error_description}` : ''}`)
  if (payload?.error) throw new Error(`${payload.error}${payload.error_description ? `: ${payload.error_description}` : ''}`)
  if (!payload?.access_token) throw new Error('GitHub answered its token endpoint without an access token')
  return payload
}

// The record one token answer becomes. `expires_in` is seconds from now, and
// its absence is a token that does not expire.
function recordFrom(payload, { now, login, authorizedAt }) {
  const at = (seconds) => (Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? new Date(now + Number(seconds) * 1000).toISOString() : null)
  return {
    token: String(payload.access_token),
    expires_at: at(payload.expires_in),
    refresh_token: payload.refresh_token ? String(payload.refresh_token) : null,
    refresh_token_expires_at: payload.refresh_token ? at(payload.refresh_token_expires_in) : null,
    login,
    authorized_at: authorizedAt,
  }
}

export class OperatorAuthorization {
  // `<token>` → the promise of a refresh that has not answered yet.
  #refreshing = null

  constructor({ root, fetchImpl = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
    if (!root) throw new Error('the operator authorization lives under an installation root, and none was given')
    this.root = root
    this.fetchImpl = fetchImpl
    this.now = now
    this.log = log
  }

  // The App's client id and secret, read fresh from the App's own secret file
  // on every call: the App is converted in process, and an App converted
  // before curia asked for authorization carries none.
  #client() {
    const text = readSecret(this.root, APP_SECRET)
    if (text === null) throw new Error('no GitHub App is configured, so there is nothing to authorize. Create the GitHub App from the GitHub card of Setup')
    let data
    try { data = JSON.parse(text) } catch { data = null }
    const id = String(data?.client_id ?? '').trim()
    const secret = String(data?.client_secret ?? '').trim()
    if (!id || !secret) throw new Error('the GitHub App holds no client secret, so the operator authorization cannot be exchanged. Create the GitHub App again from the GitHub card of Setup, which asks for the authorization when you install it')
    return { id, secret }
  }

  // The stored record, or null. A file that will not parse is a refusal with
  // the file named, because a half-written secret is not "none".
  read() {
    const text = readSecret(this.root, OPERATOR_SECRET)
    if (text === null) return null
    let data
    try { data = JSON.parse(text) } catch { throw new Error(`secrets/${OPERATOR_SECRET} is not JSON. ${REINSTALL}`) }
    if (!data?.token) throw new Error(`secrets/${OPERATOR_SECRET} holds no token. ${REINSTALL}`)
    return data
  }

  #write(record) {
    writeSecret(this.root, OPERATOR_SECRET, `${JSON.stringify(record, null, 2)}\n`)
  }

  // Presence and dates, for the card and the overview. Never a value.
  status() {
    let record
    try { record = this.read() } catch { record = null }
    if (!record) return { authorized: false }
    return { authorized: true, login: record.login ?? null, expires_at: record.expires_at ?? null, authorized_at: record.authorized_at ?? null }
  }

  // The callback (#891). GitHub sends the operator here after the install
  // with a one-use code. The code is exchanged for the token, the token is
  // asked who it stands for, and both facts land in the secret file. A
  // failure anywhere stores nothing.
  async authorize({ code, setupAction = null } = {}) {
    const value = String(code ?? '').trim()
    if (!AUTHORIZATION_CODE_RE.test(value)) throw new Error('GitHub sent no usable authorization code back. Reinstall the App from the GitHub card of Setup')
    const client = this.#client()
    let payload
    try {
      payload = await tokenCall({ client_id: client.id, client_secret: client.secret, code: value }, { fetchImpl: this.fetchImpl })
    } catch (e) {
      throw new Error(`GitHub refused the authorization code (${e.message}). Reinstall the App from the GitHub card of Setup`)
    }
    const login = await this.#whoIs(payload.access_token)
    const at = new Date(this.now()).toISOString()
    const record = recordFrom(payload, { now: this.now(), login, authorizedAt: at })
    this.#write(record)
    this.log(`GitHub authorized curia as ${login}${setupAction ? ` (${setupAction})` : ''}${record.expires_at ? `, token good until ${record.expires_at}` : ''}`)
    return { login }
  }

  async #whoIs(token) {
    let user
    try {
      user = await api('/user', { jwt: token, fetchImpl: this.fetchImpl })
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new Error(`GitHub refused your authorization (${e.status}). ${REINSTALL}`)
      throw new Error(`curia could not read who the GitHub authorization stands for: ${e.message}`)
    }
    const login = String(user?.login ?? '').trim()
    if (!login) throw new Error('GitHub described the authorization without a login, so curia cannot say who approves')
    return login
  }

  // A token good for at least the margin, refreshed when it is not. Throws
  // when curia holds none it can use, naming the reinstall.
  async token() {
    const record = this.read()
    if (!record) throw new Error(`curia holds no GitHub authorization for you, so it cannot post the approval as you. ${REINSTALL}`)
    const expiresAt = record.expires_at ? Date.parse(record.expires_at) : null
    if (expiresAt === null || Number.isNaN(expiresAt) || expiresAt - this.now() > OPERATOR_REFRESH_MARGIN_MS) return record.token
    if (!this.#refreshing) {
      this.#refreshing = this.#refresh(record).finally(() => { this.#refreshing = null })
    }
    return this.#refreshing
  }

  async #refresh(record) {
    if (!record.refresh_token) throw new Error(`your GitHub authorization expired at ${record.expires_at} and carries no refresh token. ${REINSTALL}`)
    const client = this.#client()
    let payload
    try {
      payload = await tokenCall({
        client_id: client.id, client_secret: client.secret, grant_type: 'refresh_token', refresh_token: record.refresh_token,
      }, { fetchImpl: this.fetchImpl })
    } catch (e) {
      throw new Error(`curia could not refresh your GitHub authorization (${e.message}). ${REINSTALL}`)
    }
    const next = recordFrom(payload, { now: this.now(), login: record.login ?? null, authorizedAt: record.authorized_at ?? null })
    this.#write(next)
    this.log(`refreshed the GitHub authorization of ${next.login ?? 'the operator'}${next.expires_at ? ` (good until ${next.expires_at})` : ''}`)
    return next.token
  }

  // The card's proof (#891): the token is present, refreshable, and GitHub
  // accepts it. Answers the login and nothing else.
  async verify() {
    const token = await this.token()
    return { login: await this.#whoIs(token) }
  }
}

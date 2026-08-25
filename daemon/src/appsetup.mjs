// Creating curia's GitHub App from Atlas (#694, building the spec at #684).
//
// docs/github-app.md is a seven-step checklist a human does by hand, and every
// step of it is a place to get one field wrong. GitHub's app-manifest flow
// replaces the first three: curia states the app it wants as JSON, the operator
// presses one button on github.com, and GitHub hands back a temporary code that
// converts ONCE into the app id, the slug and the private key.
//
// WHAT THIS MODULE OWNS is the daemon's half of that flow, and the reason the
// daemon owns it at all is the key. The conversion response carries curia's one
// durable secret in its body. The sidecar holds no secret (#263) and a browser
// must hold this one least of all — so the browser carries the manifest TO
// GitHub and carries `code` and `state` BACK, and the conversion itself happens
// here, on the daemon, where the key can go straight to a 0600 file.
//
//   browser ── manifest form ──> github.com
//   github.com ── ?code&state ──> sidecar ──> daemon POST /app/convert
//   daemon ── POST /app-manifests/<code>/conversions ──> GitHub
//   daemon ── writes .curia-app.pem + two env keys ──> adopts in process
//
// THE STATE IS THE WHOLE GATE. A conversion code arrives on a plain redirect,
// which anything can forge, so the daemon mints the state that goes out with
// the manifest and refuses any code that comes back without one it minted. A
// state is single use and short lived, which is what makes the replay of a
// captured redirect a refusal rather than a second conversion.
//
// ADOPTION IS IN PROCESS. Writing the key and the env keys alone would leave a
// running daemon with no app until its next restart, and the restart is the
// step this ticket exists to delete. So a stored key is handed to the caller's
// `adopt`, which rewires the live minter.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  APP_ID_KEY, APP_KEY_FILE_KEY, DEFAULT_KEY_FILE, TokenMinter,
  READ_PERMISSIONS, WRITE_PERMISSIONS,
} from './githubapp.mjs'

// ---- the manifest ----------------------------------------------------------

// The five repository permissions of docs/github-app.md step 2, and nothing
// else. DERIVED, not restated: an installation token may scope DOWN from what
// the app holds and never up, so the app must be created with the union of
// every set `githubapp.mjs` mints — the write set the agents ask for, plus the
// read set the overseer asks for. An app created without `statuses` would 422
// the first read token, and a permission added to either table there would
// otherwise never reach a newly created App.
//
// The write value wins where both name a permission, because it is the wider
// one. WORKFLOWS IS DELIBERATELY ABSENT, and stays absent as long as neither
// table names it, for the reason githubapp.mjs states at WRITE_PERMISSIONS: an
// app that can write `.github/workflows/` is a path from a ticket's text to
// whatever secrets the next CI run holds.
export const MANIFEST_PERMISSIONS = Object.freeze({ ...READ_PERMISSIONS, ...WRITE_PERMISSIONS })

export const MANIFEST_EVENTS = Object.freeze([])

export const HOMEPAGE_URL = 'https://github.com/alp82/curia'

// Where the browser posts the manifest. `?state=` is appended by the caller.
export const MANIFEST_ACTION = 'https://github.com/settings/apps/new'

// The app must be installable on an ORGANIZATION as well as on the operator's
// own user, which is what `public: true` buys — docs/github-app.md step 1 says
// why: "Only on this account" leaves an org off the Install App page entirely.
export function buildManifest({ name, redirectUrl }) {
  const appName = String(name ?? '').trim()
  if (!appName) throw refuse('a GitHub App needs a name, and it must be free across the whole of GitHub')
  const redirect = String(redirectUrl ?? '').trim()
  if (!/^https:\/\/[^\s"']+$/.test(redirect)) {
    throw refuse(`"${redirect}" is not an https redirect url — GitHub sends the conversion code back to it`)
  }
  return {
    name: appName,
    url: HOMEPAGE_URL,
    redirect_url: redirect,
    public: true,
    default_permissions: { ...MANIFEST_PERMISSIONS },
    default_events: [...MANIFEST_EVENTS],
    hook_attributes: { url: HOMEPAGE_URL, active: false },
  }
}

// ---- the env file ----------------------------------------------------------

// `daemon/.env.daemon` holds the Discord token beside these two keys, so the
// write is an UPSERT of two lines rather than a rewrite of the file: a setup
// run that dropped the bot token would take the box off Discord.
//
// Pure, so the one thing worth pinning — that every other line survives, in
// order — is pinned without a filesystem.
export function upsertEnv(text, entries) {
  const lines = String(text ?? '').split('\n')
  const left = new Map(Object.entries(entries))
  const out = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (!m || !left.has(m[1])) return line
    const key = m[1]
    const value = left.get(key)
    left.delete(key)
    return `${key}=${value}`
  })
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  for (const [key, value] of left) out.push(`${key}=${value}`)
  return `${out.join('\n')}\n`
}

// ---- refusals --------------------------------------------------------------

// The sidecar's own vocabulary (#265): a refusal is something the operator can
// see and fix, and it answers 409 rather than reading as this process failing.
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

// What a browser may send back. The code is GitHub's, and it is composed into a
// URL here, so its shape is named rather than trusted.
export const CODE_RE = /^[A-Za-z0-9_-]{1,255}$/
export const STATE_RE = /^[0-9a-f]{64}$/

// ---- the flow --------------------------------------------------------------

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const CONVERT_TIMEOUT_MS = 20_000

// How long a started setup stays convertible. The operator's own trip through
// github.com — name the app, press create, press install — is minutes, and a
// state that outlived the tab it was minted for is a forged redirect's window.
export const STATE_TTL_MS = 30 * 60 * 1000

// How many starts are remembered at once. A person presses the button twice
// when the first tab got lost; nobody presses it eight times, and an unbounded
// map is a way for a refused-but-admitted caller to grow the daemon's heap.
export const MAX_PENDING = 8

export class AppSetup {
  // `<state>` → { at, used }. `used` is set BEFORE the conversion call, which
  // is what makes replay a refusal even while the first conversion is still in
  // flight.
  #pending = new Map()

  constructor({
    daemonRoot = '.',
    envFile = null,
    keyFile = DEFAULT_KEY_FILE,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    log = () => {},
    adopt = null,
  } = {}) {
    this.daemonRoot = daemonRoot
    this.envFile = envFile ?? path.join(daemonRoot, '.env.daemon')
    this.keyFile = path.resolve(daemonRoot, keyFile)
    this.fetchImpl = fetchImpl
    this.now = now
    this.log = log
    this.adopt = adopt
  }

  // The operator opens the setup screen. The daemon mints the state and states
  // the manifest; the page posts BOTH to github.com as a form, because a
  // manifest travels as a form field and never as a call curia makes.
  begin({ name, redirectUrl }) {
    const manifest = buildManifest({ name, redirectUrl })
    this.#sweep()
    if (this.#pending.size >= MAX_PENDING) {
      throw refuse(`${MAX_PENDING} GitHub App setups are already open — finish one, or wait for them to lapse`)
    }
    const state = crypto.randomBytes(32).toString('hex')
    this.#pending.set(state, { at: this.now(), used: false })
    this.log(`GitHub App setup started for "${manifest.name}", redirecting to ${manifest.redirect_url}`)
    return { state, action: `${MANIFEST_ACTION}?state=${state}`, manifest }
  }

  #sweep() {
    for (const [state, rec] of this.#pending) {
      if (this.now() - rec.at > STATE_TTL_MS) this.#pending.delete(state)
    }
  }

  // Everything the browser is allowed to learn about the setup: the facts that
  // are already public on the app's own settings page. The conversion response
  // never leaves this method, and the pem never leaves this file.
  static publicFacts(app, { keyFile }) {
    const slug = String(app?.slug ?? '').trim()
    return {
      ok: true,
      app_id: String(app.id),
      slug,
      name: app?.name ?? null,
      bot_login: slug ? `${slug}[bot]` : null,
      html_url: app?.html_url ?? null,
      install_url: slug ? `https://github.com/apps/${slug}/installations/new` : null,
      key_file: keyFile,
    }
  }

  // The one conversion. `code` and `state` are the only two things that cross
  // from the browser, and this is the only place either is read.
  async convert({ code, state }) {
    const stateValue = String(state ?? '').trim()
    const codeValue = String(code ?? '').trim()
    if (!STATE_RE.test(stateValue)) throw refuse('that GitHub App setup carries no state curia minted, so curia did not start it')
    if (!CODE_RE.test(codeValue)) throw refuse('GitHub sent no usable conversion code back — start the setup again')
    this.#sweep()
    const rec = this.#pending.get(stateValue)
    if (!rec) throw refuse('that GitHub App setup did not start on this box, or it lapsed — start it again from Atlas')
    // Single use, and consumed BEFORE the network call: a redirect replayed
    // while the first conversion is still in flight must not convert twice.
    if (rec.used) throw refuse('that GitHub App setup was already converted — a conversion code is good exactly once')
    rec.used = true

    const app = await this.#convertOnGitHub(codeValue)
    const key = this.#readKey(app)
    this.#store(app, key)
    this.#adopt(app, key)
    return AppSetup.publicFacts(app, { keyFile: this.keyFile })
  }

  async #convertOnGitHub(code) {
    let res
    try {
      res = await this.fetchImpl(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'user-agent': 'curia',
        },
        signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
      })
    } catch (e) {
      throw refuse(`curia could not reach GitHub to convert the app manifest (${e.message}) — start the setup again`)
    }
    const text = await res.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch { /* a non-JSON body leaves the status as the whole answer */ }
    if (!res.ok) {
      const detail = payload?.message ? `: ${payload.message}` : ''
      // 404 is what an expired or already-converted code answers, and it is the
      // operator's own sentence rather than a status nobody can place.
      if (res.status === 404) {
        throw refuse('GitHub does not know that conversion code — it is good for one hour and for one conversion. Start the setup again')
      }
      throw refuse(`GitHub answered HTTP ${res.status} to the app manifest conversion${detail}`)
    }
    if (!payload?.id || !payload?.pem) {
      throw refuse('GitHub converted the manifest without an app id and a private key, so there is nothing to store')
    }
    return payload
  }

  // The pem, as a key object rather than as text — the same check boot makes
  // (githubapp.mjs readPrivateKey), run BEFORE anything is written: a key that
  // will not parse must refuse here and not at the first mint.
  #readKey(app) {
    try {
      return crypto.createPrivateKey(app.pem)
    } catch (e) {
      throw refuse(`GitHub's converted app carries a private key curia cannot read (${e.message})`)
    }
  }

  // The key file and the two env keys. NOT a refusal when it fails: a full disk
  // or a read-only mount is this box failing, and the operator's next act is on
  // the box rather than on the page. The sentence names the file either way,
  // because the conversion is spent and the key is gone with it.
  #store(app, key) {
    try {
      fs.writeFileSync(this.keyFile, app.pem, { mode: 0o600 })
      fs.chmodSync(this.keyFile, 0o600)
    } catch (e) {
      throw new Error(`the GitHub App was created, but curia could not store its private key at ${this.keyFile} (${e.message}) — the key is gone with the conversion, so delete the app on GitHub and run the setup again`)
    }
    try {
      const before = fs.existsSync(this.envFile) ? fs.readFileSync(this.envFile, 'utf8') : ''
      fs.writeFileSync(this.envFile, upsertEnv(before, {
        [APP_ID_KEY]: String(app.id),
        [APP_KEY_FILE_KEY]: path.relative(this.daemonRoot, this.keyFile) || this.keyFile,
      }), { mode: 0o600 })
      fs.chmodSync(this.envFile, 0o600)
    } catch (e) {
      // The key is on disk and the env file is not, which is the half-configured
      // state githubapp.mjs refuses a boot on. Say both halves.
      throw new Error(`the GitHub App's key is stored at ${this.keyFile}, but curia could not write ${APP_ID_KEY} and ${APP_KEY_FILE_KEY} into ${this.envFile} (${e.message}) — add those two keys by hand before the next restart`)
    }
    // Nothing here logs the pem, and nothing ever should: this line is the only
    // trace the setup leaves in journalctl.
    this.log(`GitHub App ${app.id} (${app.slug}) created — key stored at ${this.keyFile}, ${APP_ID_KEY} written to ${this.envFile}`)
    void key
  }

  // In process, so the operator's next act is the install and not a restart.
  // A caller with no `adopt` stores and says so; the app is live at the next
  // boot either way, which is what makes the failure here worth a log and not a
  // refusal of a setup that already succeeded.
  #adopt(app, key) {
    if (!this.adopt) return
    try {
      this.adopt({ appId: String(app.id), key, keyFile: this.keyFile, slug: app.slug ?? null })
    } catch (e) {
      this.log(`WARNING: the GitHub App is stored but this daemon could not adopt it in process (${e.message}) — restart the daemon`)
    }
  }
}

// The minter one adoption produces. Here rather than in index.mjs so that the
// setup's own tests can prove a converted app becomes a minting one.
export function minterForAdopted({ appId, key, keyFile, fetchImpl = globalThis.fetch, now = Date.now, log = () => {} }) {
  return new TokenMinter({ appId, key, keyFile, fetchImpl, now, log })
}

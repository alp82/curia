// The daemon's own GitHub identity (#352, building the decision at #338).
//
// Curia's whole credential story used to be hand-minted fine-grained PATs: one
// read-write pair for agents (#155), one read-only pair for the overseer
// (#313), and the operator's own `gh` login for the daemon. Every one of them
// is a secret an operator makes by hand, per resource owner, and re-makes when
// it expires — `getalfredo` caps a fine-grained PAT at 366 days.
//
// #338 replaced all of it with ONE GitHub App. The operator creates the app
// once and installs it on each watched owner. The daemon holds the app's
// private key as its one durable secret and mints installation tokens itself.
// This module is that minting, and nothing else: it turns a key into tokens.
// Who holds which token is the business of the modules that ask.
//
// WHAT AN APP BUYS, in the order that decided it:
//
//   - The minting cost dies. One app, once, instead of a token pair per owner.
//   - The boundary holds with no second secret. From the SAME key the daemon
//     mints read-write tokens for agents and READ-ONLY tokens for the overseer,
//     because a minted token may scope DOWN from what the installation grants.
//     ADR-0014 stands: the overseer's shell still writes nowhere.
//   - Gate integrity. An agent's pull request becomes `curia[bot]`-authored, so
//     the operator's approval is a real GitHub approval by a different account.
//   - Token life. An installation token lives one hour. The private key does
//     not expire, so nothing is a calendar item any more.
//
// THE PRICE IS THE HOUR. A PAT was set once into a container environment and
// stayed good for a year. An installation token dies inside a long ticket, so
// whoever holds one must be REFRESHED rather than handed a value at start. That
// is why `TokenMinter` caches with a margin and why the holders read a file the
// daemon rewrites, instead of an environment variable frozen at spawn.
//
// NO DEPENDENCY. A GitHub App JWT is RS256 over two base64url JSON objects, and
// `node:crypto` signs it. Adding a JWT library to sign one 100-byte string
// would put a supply-chain surface in front of the daemon's only durable
// secret.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ---- what the operator sets ------------------------------------------------
//
// Two keys in `daemon/.env.daemon`, beside the Discord token. The key ITSELF is
// a file, named by the second one, and never a value in the env file: a PEM
// carries newlines, and `writeEnvFile` already refuses a newline because docker
// reads one as a second variable. A path also keeps the key out of every child
// process environment the daemon spawns.

export const APP_ID_KEY = 'CURIA_GH_APP_ID'
export const APP_KEY_FILE_KEY = 'CURIA_GH_APP_KEY_FILE'

// Where the operator is told to put the key. Relative paths resolve against the
// daemon directory, so the deploy copies one more file beside the env file it
// already copies.
export const DEFAULT_KEY_FILE = '.curia-app.pem'

// The app's configuration, or null when no app is set up yet.
//
// NULL IS LEGAL and stays legal until the last holder cuts over: #338 says a
// working boundary does not come out ahead of its replacement, so a daemon with
// no app keeps running on the PATs. What is NOT legal is half of it. An app id
// with no key, or a key with no app id, is an operator typo, and it refuses the
// boot rather than reaching a dispatch as a 401 nobody can place.
export function appConfigFrom(env = process.env, daemonRoot = '.') {
  const appId = String(env[APP_ID_KEY] ?? '').trim()
  const keyFile = String(env[APP_KEY_FILE_KEY] ?? '').trim()
  if (!appId && !keyFile) return null
  if (!appId) throw new Error(`${APP_KEY_FILE_KEY} is set in daemon/.env.daemon and ${APP_ID_KEY} is not — an app needs both`)
  if (!keyFile) throw new Error(`${APP_ID_KEY} is set in daemon/.env.daemon and ${APP_KEY_FILE_KEY} is not — an app needs both`)
  if (!/^[0-9]+$/.test(appId)) {
    throw new Error(`bad ${APP_ID_KEY} in daemon/.env.daemon: an app id is digits only — "${appId}" is the app SLUG or the client id, and GitHub states the id on the app's own settings page`)
  }
  return { appId, keyFile: path.resolve(daemonRoot, keyFile) }
}

// The private key, as a crypto key object rather than text: an unreadable or
// wrong-shaped file must fail HERE, at boot, and not at the first mint.
//
// GitHub hands the operator one PKCS#1 file — `-----BEGIN RSA PRIVATE KEY-----`
// — on a download that happens exactly once. The two mistakes worth naming back
// are the ones that download makes easy: keeping the public half, and copying
// the file with the wrong mode.
export function readPrivateKey(file) {
  let pem
  try {
    pem = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no GitHub App key at ${file} — ${APP_KEY_FILE_KEY} names a file that is not there`)
    if (e.code === 'EACCES') throw new Error(`cannot read the GitHub App key at ${file}: permission denied — the daemon runs as the box user, and the key must be owned by it at mode 0600`)
    throw e
  }
  if (/BEGIN[A-Z ]*PUBLIC KEY/.test(pem)) {
    throw new Error(`${file} holds a PUBLIC key — GitHub downloads the PRIVATE half once, when the app's key is generated, and never again`)
  }
  try {
    return crypto.createPrivateKey(pem)
  } catch (e) {
    throw new Error(`${file} is not a readable private key: ${e.message} — GitHub hands out a PKCS#1 PEM that starts "-----BEGIN RSA PRIVATE KEY-----"`)
  }
}

// The key file's mode, checked rather than fixed. The daemon does not chmod a
// file the operator placed: a key it silently repairs is a key nobody learns to
// place correctly, and the next box repeats the mistake.
export function keyFileIsPrivate(file) {
  try {
    return (fs.statSync(file).mode & 0o077) === 0
  } catch {
    return false // unreadable is a different failure, and readPrivateKey names it
  }
}

// ---- the app JWT -----------------------------------------------------------
//
// GitHub accepts a JWT for at most ten minutes and REFUSES one whose `iat` is
// in the future, so the claim is backdated against clock skew between this box
// and GitHub. Nine minutes of life leaves the tenth as margin: a JWT is minted
// per mint call and never cached, so a long-lived one buys nothing.

export const JWT_LIFETIME_S = 540
export const JWT_BACKDATE_S = 60

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function appJwt(appId, key, { now = Date.now } = {}) {
  const iat = Math.floor(now() / 1000) - JWT_BACKDATE_S
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S, iss: appId }))
  const signingInput = `${header}.${claims}`
  const signature = b64url(crypto.createSign('RSA-SHA256').update(signingInput).sign(key))
  return `${signingInput}.${signature}`
}

// ---- the permission sets ---------------------------------------------------
//
// An installation token may ask for a SUBSET of what the installation grants,
// and asking for more is a 422. So the app is created with the write set, and
// the read set is the same call with smaller words. These two constants are
// what the operator checklist grants, and the checklist names them one for one.
//
// WORKFLOWS IS DELIBERATELY ABSENT. GitHub gates `.github/workflows/` behind
// its own permission, and an app that holds it lets any agent rewrite CI — which
// is a path from a ticket's text to whatever secrets the next workflow run
// holds. The fine-grained PATs of #155 do not carry it either, so leaving it out
// keeps today's reach exactly. The cost is stated rather than hidden: an agent
// cannot push a change under `.github/workflows/`, and that push fails naming
// the permission.
export const WRITE_PERMISSIONS = Object.freeze({
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  metadata: 'read',
})

// #313's set, unchanged: Contents, Issues, Pull requests, Commit statuses and
// Metadata at READ, and nothing else. The overseer holds a shell, and this is
// the control that replaces the `/command` seam.
export const READ_PERMISSIONS = Object.freeze({
  contents: 'read',
  issues: 'read',
  pull_requests: 'read',
  statuses: 'read',
  metadata: 'read',
})

export const ROLES = Object.freeze({ write: WRITE_PERMISSIONS, read: READ_PERMISSIONS })

// The App itself holds the union needed by the two scoped token roles. Commit
// statuses are read-only for the overseer, while the other write permissions
// serve agents. No workflow, organization, or account permission is present.
export const MANIFEST_PERMISSIONS = Object.freeze({
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  statuses: 'read',
  metadata: 'read',
})

export function permissionsFor(role) {
  const set = ROLES[role]
  if (!set) throw new Error(`no such token role "${role}" — curia mints ${Object.keys(ROLES).join(' and ')}`)
  return set
}

// ---- manifest setup --------------------------------------------------------

export const APP_SETUP_TTL_MS = 60 * 60 * 1000

function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  fs.writeFileSync(temporary, text, { mode })
  fs.chmodSync(temporary, mode)
  fs.renameSync(temporary, file)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function envWith(existing, values) {
  const pending = new Map(Object.entries(values))
  const lines = String(existing ?? '').split('\n').map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/)
    if (!match || !pending.has(match[1])) return line
    const value = pending.get(match[1])
    pending.delete(match[1])
    return `${match[1]}=${value}`
  })
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (const [key, value] of pending) lines.push(`${key}=${value}`)
  return `${lines.join('\n')}\n`
}

function samePermissions(actual) {
  const wanted = Object.entries(MANIFEST_PERMISSIONS).sort()
  const got = Object.entries(actual ?? {}).sort()
  return JSON.stringify(got) === JSON.stringify(wanted)
}

export class GitHubAppSetup {
  constructor({
    daemonRoot = '.',
    stateFile = path.join(daemonRoot, '.github-app-setup.json'),
    envFile = path.join(daemonRoot, '.env.daemon'),
    keyFile = path.join(daemonRoot, DEFAULT_KEY_FILE),
    fetchImpl = globalThis.fetch,
    now = Date.now,
    randomBytes = crypto.randomBytes,
    adopt = () => {},
    store = null,
  } = {}) {
    this.daemonRoot = daemonRoot
    this.stateFile = stateFile
    this.secretFile = `${stateFile}.conversion`
    this.envFile = envFile
    this.keyFile = keyFile
    this.fetchImpl = fetchImpl
    this.now = now
    this.randomBytes = randomBytes
    this.adopt = adopt
    this.store = store ?? ((payload) => this.storeApp(payload))
  }

  #writeState(record) {
    atomicWrite(this.stateFile, `${JSON.stringify(record)}\n`)
  }

  #readState() {
    try {
      return readJson(this.stateFile)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('there is no GitHub App setup in progress')
      throw error
    }
  }

  status() {
    try {
      const record = this.#readState()
      if (record.status === 'complete') return { status: 'complete', app: record.app }
      return {
        status: this.now() > record.expires_at ? 'expired' : record.status,
        expires_at: new Date(record.expires_at).toISOString(),
      }
    } catch (error) {
      if (/no GitHub App setup/.test(error?.message ?? '')) return { status: 'unconfigured' }
      throw error
    }
  }

  start({ name, redirectUrl, organization = null } = {}) {
    const appName = String(name ?? '').trim()
    if (!appName || appName.length > 34) throw new Error('the GitHub App name must contain 1 to 34 characters')
    let redirect
    try {
      redirect = new URL(String(redirectUrl))
    } catch {
      throw new Error('the GitHub App redirect URL is not a URL')
    }
    if (redirect.protocol !== 'https:') throw new Error('the GitHub App redirect URL must use HTTPS')
    const state = Buffer.from(this.randomBytes(32)).toString('hex')
    const expires = this.now() + APP_SETUP_TTL_MS
    this.#writeState({ state, expires_at: expires, status: 'pending' })
    const ownerPath = organization
      ? `/organizations/${encodeURIComponent(String(organization))}/settings/apps/new`
      : '/settings/apps/new'
    return {
      state,
      expires_at: new Date(expires).toISOString(),
      action: `https://github.com${ownerPath}?state=${state}`,
      manifest: {
        name: appName,
        url: redirect.origin,
        redirect_url: redirect.toString(),
        public: true,
        default_permissions: { ...MANIFEST_PERMISSIONS },
        default_events: [],
        hook_attributes: { active: false },
      },
    }
  }

  async #convert(code) {
    const route = `/app-manifests/${encodeURIComponent(code)}/conversions`
    const response = await this.fetchImpl(`${API}${route}`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        'user-agent': 'curia',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const text = await response.text()
    let payload
    try { payload = text ? JSON.parse(text) : null } catch { payload = null }
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} while converting the App manifest${payload?.message ? `: ${payload.message}` : ''}`)
    if (!payload?.id || !payload?.slug || !payload?.pem) throw new Error('GitHub converted the App manifest without an id, slug, or private key')
    if (!samePermissions(payload.permissions)) throw new Error('GitHub converted the App with permissions that differ from Curia\'s requested five')
    if (!Array.isArray(payload.events) || payload.events.length) throw new Error('GitHub converted the App with webhook events, but Curia requests none')
    return { id: String(payload.id), slug: String(payload.slug), pem: String(payload.pem) }
  }

  storeApp(payload) {
    const temporaryKey = `${this.keyFile}.candidate`
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true })
    fs.writeFileSync(temporaryKey, payload.pem, { mode: 0o600 })
    fs.chmodSync(temporaryKey, 0o600)
    readPrivateKey(temporaryKey)
    fs.renameSync(temporaryKey, this.keyFile)
    let existing = ''
    try { existing = fs.readFileSync(this.envFile, 'utf8') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    atomicWrite(this.envFile, envWith(existing, {
      [APP_ID_KEY]: payload.id,
      [APP_KEY_FILE_KEY]: path.relative(this.daemonRoot, this.keyFile) || path.basename(this.keyFile),
    }))
  }

  async complete({ code, state } = {}) {
    const record = this.#readState()
    if (String(state ?? '') !== record.state) throw new Error('the GitHub App setup state does not match')
    if (record.status === 'complete') {
      return { ok: false, reason: 'already completed', app: record.app }
    }
    if (this.now() > record.expires_at) throw new Error('the GitHub App setup state expired after one hour')

    let converted
    if (record.status === 'converted') {
      converted = readJson(this.secretFile)
    } else {
      const temporaryCode = String(code ?? '').trim()
      if (!temporaryCode) throw new Error('the GitHub App setup returned no temporary code')
      converted = await this.#convert(temporaryCode)
      atomicWrite(this.secretFile, `${JSON.stringify(converted)}\n`)
      this.#writeState({ ...record, status: 'converted' })
    }

    await this.store(converted)
    await this.adopt({ appId: converted.id, keyFile: this.keyFile })
    const app = { id: converted.id, slug: converted.slug }
    this.#writeState({ ...record, status: 'complete', app, completed_at: this.now() })
    try { fs.unlinkSync(this.secretFile) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    return { ok: true, app }
  }
}

// ---- the API ---------------------------------------------------------------

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const FETCH_TIMEOUT_MS = 20_000

// One place that builds a request and reads a failure, so every error the
// operator sees names the same three things: what curia asked for, what GitHub
// answered, and what to do about it.
async function api(route, { jwt, method = 'GET', body = null, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`${API}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': 'curia',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch { /* a non-JSON body leaves the status as the whole answer */ }
  if (!res.ok) {
    const detail = payload?.message ? `: ${payload.message}` : ''
    const err = new Error(`GitHub answered HTTP ${res.status} to ${method} ${route}${detail}`)
    err.status = res.status
    err.payload = payload
    throw err
  }
  return payload
}

// Every owner the app is installed on, as `{ id, owner }`. This is the ONE
// lookup that says whether the operator finished the install step, so its
// failure is worth a sentence rather than a status code.
//
// `per_page=100` rather than a pagination loop: GitHub's default page is 30,
// and this app installs only on accounts the operator owns.
export async function listInstallations({ jwt, fetchImpl = globalThis.fetch } = {}) {
  let payload
  try {
    payload = await api('/app/installations?per_page=100', { jwt, fetchImpl })
  } catch (e) {
    if (e.status === 401) throw new Error(`GitHub refused curia's app JWT (401) — ${APP_ID_KEY} and the key file must belong to the same app, and the box clock must be right`)
    throw e
  }
  return (payload ?? []).map((i) => ({ id: i.id, owner: i.account?.login ?? null }))
}

// How many pages of repositories one installation may state. An installation
// granted "all repositories" covers every repo the owner has, so this one CAN
// be long where the installation list above cannot.
export const MAX_REPO_PAGES = 20

// Every repository one installation covers, as `owner/name`, read with that
// installation's own token.
//
// This is the reach half of the credential watch (#466), and it is the one
// question a probe against the repository cannot answer. An installation token
// reads every PUBLIC repository on GitHub, so `GET /repos/<owner>/<name>`
// answers 200 for a repo the app was never granted — measured on the box, where
// an agent's own token read `octocat/Hello-World`. The installation states its
// own grant, and it states it for private and public alike.
//
// A list longer than the cap THROWS rather than answering short. A short answer
// would name a covered repo as uncovered, and the watch would ask the operator
// to repair an installation that is already right.
export async function listInstallationRepos({ token, fetchImpl = globalThis.fetch } = {}) {
  const out = []
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const payload = await api(`/installation/repositories?per_page=100&page=${page}`, { jwt: token, fetchImpl })
    const batch = payload?.repositories ?? []
    for (const repo of batch) if (repo?.full_name) out.push(repo.full_name)
    if (batch.length < 100) return out
  }
  throw new Error(`curia's app installation states more than ${MAX_REPO_PAGES * 100} repositories, which is more than this read pages through`)
}

// One installation token. `permissions` scopes it DOWN from what the
// installation grants; `repositories` narrows it to named repos of that owner.
//
// A 422 here is the operator's grant, not curia's code: the app was created
// without a permission this role asks for. The message says so, because the
// status alone sends nobody to the app settings page.
export async function mintInstallationToken(installationId, {
  jwt, permissions = null, repositories = null, fetchImpl = globalThis.fetch,
} = {}) {
  const body = {}
  if (permissions) body.permissions = permissions
  if (repositories) body.repositories = repositories
  let payload
  try {
    payload = await api(`/app/installations/${installationId}/access_tokens`, {
      jwt, method: 'POST', body: Object.keys(body).length ? body : null, fetchImpl,
    })
  } catch (e) {
    if (e.status === 422) {
      throw new Error(`${e.message} — curia asked for ${Object.entries(permissions ?? {}).map(([k, v]) => `${k}:${v}`).join(', ')}, and the app grants less; fix it on the app's Permissions page and accept the new grant on each installation`)
    }
    throw e
  }
  return {
    token: payload.token,
    expiresAt: Date.parse(payload.expires_at),
    permissions: payload.permissions ?? {},
  }
}

// ---- the minter ------------------------------------------------------------
//
// One per daemon. It caches a token per owner and role, and it hands back a
// cached one until the refresh margin. The margin is what makes the hour safe
// for a holder that reads a file: the daemon rewrites before the value in the
// file could expire mid-use, so nothing downstream ever has to retry a 401.
//
// TEN MINUTES, and the number is a duty rather than a taste. The daemon
// refreshes on its own poll interval (60 s), so a margin has only to be longer
// than one poll plus the slowest `git push` a token is asked to carry.

export const REFRESH_MARGIN_MS = 10 * 60 * 1000

export class TokenMinter {
  #installations = null

  #bot = null

  // `<owner>|<role>` → the promise of a mint that has not answered yet (#390).
  #minting = new Map()

  constructor({
    appId, key, keyFile = null, fetchImpl = globalThis.fetch, now = Date.now, log = () => {},
  } = {}) {
    this.appId = appId
    this.key = key
    // Kept only so the boot line can name the file it read. Nothing mints with it.
    this.keyFile = keyFile
    this.fetchImpl = fetchImpl
    this.now = now
    this.log = log
    this.cache = new Map() // `<owner>|<role>` → { token, expiresAt }
  }

  jwt() {
    return appJwt(this.appId, this.key, { now: this.now })
  }

  // The installation list, read once and kept. An install is an operator act
  // that happens between deploys, so a miss re-reads rather than a clock: the
  // one case that matters is an owner added to the watch list and installed the
  // same minute, and `refreshInstallations` is what a restart-free box calls.
  async installations() {
    if (!this.#installations) this.#installations = await listInstallations({ jwt: this.jwt(), fetchImpl: this.fetchImpl })
    return this.#installations
  }

  async refreshInstallations() {
    this.#installations = null
    return this.installations()
  }

  async installationFor(owner) {
    const wanted = String(owner ?? '').toLowerCase()
    let hit = (await this.installations()).find((i) => String(i.owner ?? '').toLowerCase() === wanted)
    if (!hit) hit = (await this.refreshInstallations()).find((i) => String(i.owner ?? '').toLowerCase() === wanted)
    return hit ?? null
  }

  // A token for one owner in one role. Cached until the margin, then minted
  // again. Throws when the app is not installed on that owner, because a null
  // here would send an unauthenticated `git push` at a private repo and the
  // failure would name the repo instead of the missing install.
  // ONE MINT AT A TIME PER KEY. The daemon cut over at #390, and it makes many
  // more calls per owner than an agent does: one reconcile pass fires the map
  // read, the frontier read and the flat read for every watched repo at once.
  // With a bare cache each of those would find it cold and mint its own token,
  // so a boot would burn a dozen mints where one is wanted. So a mint already in
  // flight for the same owner and role is AWAITED rather than started again.
  //
  // The entry is dropped on failure, which is what keeps a network stall from
  // being remembered as an answer: the next caller starts a fresh mint.
  async tokenFor(owner, role) {
    const permissions = permissionsFor(role)
    const cacheKey = `${owner}|${role}`
    const hit = this.cache.get(cacheKey)
    if (hit && hit.expiresAt - this.now() > REFRESH_MARGIN_MS) return hit.token
    const inFlight = this.#minting.get(cacheKey)
    if (inFlight) return inFlight
    const pending = (async () => {
      const install = await this.installationFor(owner)
      if (!install) {
        throw new Error(`curia's GitHub App is not installed on ${owner} — install it on that owner and grant it the watched repos`)
      }
      const minted = await mintInstallationToken(install.id, { jwt: this.jwt(), permissions, fetchImpl: this.fetchImpl })
      this.cache.set(cacheKey, minted)
      this.log(`minted a ${role} token for ${owner} (expires ${new Date(minted.expiresAt).toISOString()})`)
      return minted.token
    })()
    this.#minting.set(cacheKey, pending)
    try {
      return await pending
    } finally {
      this.#minting.delete(cacheKey)
    }
  }

  // The repositories one owner's installation covers (#466), lowercased so the
  // caller compares names rather than spellings — GitHub keeps the case an owner
  // typed, and a watch list is hand-written.
  //
  // It mints a READ token, because the question is about the grant and never
  // about writing. It throws when the app is not installed on that owner, which
  // is `tokenFor`'s refusal and says the one thing the operator must act on.
  async reposFor(owner) {
    const token = await this.tokenFor(owner, 'read')
    const repos = await listInstallationRepos({ token, fetchImpl: this.fetchImpl })
    return repos.map((r) => r.toLowerCase())
  }

  // The app's own user, as GIT has to name it (#389).
  //
  // A commit is attributed by its author email, and GitHub links one to an
  // account only through the `<id>+<login>@users.noreply.github.com` form. So
  // "curia-sh[bot]" alone is not enough, and the id is nowhere in the app's own
  // description — it takes two reads. `/app` states the SLUG, which is what
  // GitHub builds the bot login from, and the bot user then states its id.
  //
  // Neither fact ever changes for an installed app, so this is read once and
  // kept for the life of the process.
  //
  // It takes a TOKEN rather than minting its own, and that is not a saving: an
  // app JWT authenticates the `/app*` routes and nothing else, so the second
  // read has to run on an installation token, and the caller already holds one.
  //
  // NOT HARD-CODED, though this box's answer is `curia-sh[bot]` and 317489578.
  // The app is per-operator (ADR-0018) and its name has to be free across the
  // whole of GitHub, so another operator's daemon has another bot entirely.
  async botIdentity(token) {
    if (this.#bot) return this.#bot
    const app = await api('/app', { jwt: this.jwt(), fetchImpl: this.fetchImpl })
    const slug = String(app?.slug ?? '').trim()
    if (!slug) throw new Error('GitHub described curia\'s app without a slug, so its bot login cannot be built')
    const login = `${slug}[bot]`
    const user = await api(`/users/${encodeURIComponent(login)}`, { jwt: token, fetchImpl: this.fetchImpl })
    if (!user?.id) throw new Error(`GitHub states no id for ${login}, so a commit authored as it would link to no account`)
    this.#bot = { name: login, email: `${user.id}+${login}@users.noreply.github.com` }
    this.log(`curia commits as ${this.#bot.name} <${this.#bot.email}>`)
    return this.#bot
  }

  // Drop every cached token. Called when a holder has to be re-armed from
  // scratch — a rotated key, or an install the operator has just repaired.
  forget() {
    this.cache.clear()
    this.#minting.clear()
    this.#installations = null
    this.#bot = null
  }
}

// The minter for this box, or null when no app is set up yet. One function so
// that every caller reads the same two env keys and gets the same refusal text.
export function minterFrom({ env = process.env, daemonRoot = '.', fetchImpl = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  const cfg = appConfigFrom(env, daemonRoot)
  if (!cfg) return null
  const key = readPrivateKey(cfg.keyFile)
  if (!keyFileIsPrivate(cfg.keyFile)) {
    log(`WARNING: ${cfg.keyFile} is readable beyond its owner — this is curia's one durable secret; run \`chmod 600\` on it`)
  }
  return new TokenMinter({ appId: cfg.appId, key, keyFile: cfg.keyFile, fetchImpl, now, log })
}

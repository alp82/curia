// The dashboard sidecar (#263, building the where-it-lives decision #249).
//
// A thin Node process BESIDE the daemon, not a daemon surface. That is the
// whole point of the split: the sidecar stays up while the daemon restarts, so
// the restart is a marker on the page rather than a dead tab. It holds no
// secret — no Discord token, no GitHub token, no journal handle. Everything it
// draws comes from one loopback read of the daemon's `GET /overview` (#262).
//
//   tailnet ──Serve(:8445)──> sidecar(:4273) ──> daemon(:4271) GET /overview
//
// IDENTITY. The sidecar is its own HTTP server, so it carries the #151
// predicate in-process exactly as the timeline does — same module, same
// allowlist, same fail-closed default. It publishes its own Serve rule and
// withdraws it the moment the surface stops being verifiable, under the rule
// #70 set and the timeline follows: only a listener that is positively ours is
// ever published.
//
// THE POLL IS DEMAND-DRIVEN, which is half the answer to the cost #262 stated.
// The sidecar refreshes only when a page asks and the snapshot it holds is
// older than the interval. A browser polls while its tab is visible and stops
// when it is hidden, which makes a forgotten tab cost nothing. Many tabs
// collapse to one read: the age check answers them all, and one in-flight
// refresh is shared.
//
// The other half is #289, on the daemon's side of the wire: `GET /overview`
// reads no journal at all now, so what one refresh costs no longer rises
// with everything curia ever wrote.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION } from './appversion.mjs'
import { assertServe, serveOff, attachBase } from './attach.mjs'
import { identityRefusal, readAllow, serveHosts, tailnetSelf, LOGIN_HEADER } from './identity.mjs'
import { readSettings, saveSettings } from './settings.mjs'
import { CARDS as SETUP_CARDS, PROGRESS_FIELDS as SETUP_FIELDS } from './setup.mjs'
// The two config layers (#292). config.mjs imports readDashboard from this file
// in turn; both edges are runtime calls, never module-level ones.
import { readLayered } from './config.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

export const DEFAULT_DASHBOARD_INDEX = path.resolve(DIR, '..', 'assets', 'dashboard.html')

// The daemon's own port, as the daemon itself computes it. One fact, one
// place: a `dashboard.daemon_port` key in the yaml would be a second way to
// write it, free to disagree with the process it names.
export const DEFAULT_DAEMON_PORT = 4271
export const daemonPort = () => Number(process.env.PORT ?? DEFAULT_DAEMON_PORT)

// Same rule the timeline page carries (#70, TIMELINE_PROTO): the page and this
// server are two halves of one protocol, and the running process can drift
// against the disk when a pull changes both halves with no restart. The page
// declares what it speaks, the server compares, and a mismatch refuses loudly
// rather than serving a surface nobody agreed to.
// Bumped to 2 by #266: the page now POSTs to verb routes an older sidecar does
// not serve, so an old server must refuse the new page rather than serve one
// whose every button answers 404.
// Bumped to 3 by #267: the Chat screen sends the operator to `/chat`, which an
// older sidecar does not serve either.
// Bumped to 4 by #333: the Chat screen is a conversation picker now. It reads
// `/api/console` and it POSTs the two console routes, none of which a proto-3
// sidecar serves — so an old server must refuse this page rather than draw a
// picker whose every row and button answers 404.
// Bumped to 5 by #355: the gate card reads `/api/diff`, which a proto-4
// sidecar does not serve — so an old server must refuse this
// page rather than draw a digest whose every file answers 404.
// Bumped to 6 by #642: the attention list draws the credentials the daemon now
// owns, and the device link and one-time code of a login in flight. A proto-5
// sidecar serves an `/overview` with no `credentials` section at all, so the
// card would render empty at the one moment it is the only thing that matters.
// Bumped to 7 by #713: every page now opens `/api/search` through this sidecar.
// Bumped to 8 by #714: Chat embeds the terminal through `/terminal/`, including
// its WebSocket upgrade. An older sidecar would leave that pane disconnected.
// Bumped to 9 by #715: a native dialog card answers through `/dialog-answer`.
// Bumped to 10 by #661: the page carries a Credentials screen whose one button
// POSTs `/api/reauth`, a route a proto-9 sidecar does not serve — so a screen
// built for the 3am no-ssh recovery would answer 404 at the press it exists
// for. It also reads two fields a proto-9 daemon's `/overview` does not carry.
// Bumped to 11 by #706: the Settings screen carries an aistack section that
// reads `/api/aistack` and POSTs three `/api/aistack/*` routes, none of which a
// proto-10 sidecar serves — so an old server must refuse this page rather than
// draw a registration flow whose device code never arrives and whose every
// button answers 404.
// Bumped to 13 by #711: Chat is a page of its own now. `/chat` redirects into
// the `#chat/<session>` route, the page reads the six timeline routes through
// this sidecar, and it draws an ended agent from the `live` field of
// `/api/console`, which a proto-12 daemon does not carry.
// Bumped to 15 by #809: credential sign-in now carries an Action identity
// through `/api/reauth`. A proto-14 sidecar drops that identity and leaves the
// optimistic projection pending with no daemon evidence that can settle it.
// Bumped to 16 by #874: the page carries the integration setup frame, which
// reads `/api/setup` and POSTs it. A proto-15 sidecar answers 404 on both, and
// a setup screen whose every card is unreadable is not a screen.
// Bumped to 17 by #882: the setup frame runs the Full loop through
// `/api/setup/full-loop` and its retry, and draws the run the read carries.
// A proto-16 sidecar answers 404 on the press, and a Run Full loop that runs
// nothing is the stub this release retired.
// Bumped to 18 by #883: the Settings screen carries an Update section that
// reads `/api/update`. A proto-17 sidecar answers 404, and a panel that can
// never say which version is installed is not a panel.
export const DASHBOARD_PROTO = 18

// The Credentials screen's own hash (#661). It is here rather than in the
// daemon that links to it, because the page's screen names are this file's half
// of the protocol — and a second copy of the word in dispatch.mjs would be free
// to point at a screen the page had renamed.
export const CREDENTIALS_HASH = '#credentials'
export const STAMP_NAME = 'curia-dashboard'
const STAMP_RE = new RegExp(`<meta name="${STAMP_NAME}" content="proto=(\\d+)">`)

// Only POSITIVE evidence refuses — the same classification rule attach.mjs and
// timeline.mjs read under.
export function pageRefusal(indexFile) {
  let head
  try {
    head = fs.readFileSync(indexFile, 'utf8')
  } catch {
    return `dashboard page ${indexFile} is not readable — it ships committed in daemon/assets/`
  }
  const m = STAMP_RE.exec(head)
  if (!m) return `dashboard page ${indexFile} carries no ${STAMP_NAME} proto stamp — it is not a page this server speaks`
  if (Number(m[1]) !== DASHBOARD_PROTO) {
    return `dashboard page ${indexFile} speaks proto ${m[1]} but this sidecar speaks proto ${DASHBOARD_PROTO} — restart the sidecar on the same checkout as the page`
  }
  return null
}

// ---------------------------------------------------------------------------
// the `dashboard:` block
// ---------------------------------------------------------------------------
//
// Read by TWO processes, so it lives here rather than inside loadCuriaConfig:
// the daemon validates the block and refuses to boot on a bad shape (#249), and
// the sidecar reads its own ports out of the same file with the same rules. One
// definition, two callers — the alternative is two parsers free to disagree
// about the config they share.
export const DEFAULT_DASHBOARD = {
  port: 4273,
  serve_port: 8445,
  // The one decision #263 owns: how often the daemon is asked while a tab is
  // open, and it is paused entirely while none is. It used to set the rate of
  // a whole-journal read as well. It no longer does (#289), so this number is
  // now about freshness rather than about cost.
  poll_interval_s: 5,
}

// `fail(msg)` is the caller's own refusal — loadCuriaConfig names the file, the
// sidecar names itself. `configFile` resolves `index` relative to the yaml, so
// the shipped config can name the asset portably instead of carrying one box's
// absolute path. Returns the normalized block.
export function readDashboard(cfg, fail, configFile = null) {
  const dash = cfg.dashboard ?? {}
  if (typeof dash !== 'object' || Array.isArray(dash)) fail('`dashboard` must be a mapping')
  const out = {
    port: dash.port ?? DEFAULT_DASHBOARD.port,
    serve_port: dash.serve_port ?? DEFAULT_DASHBOARD.serve_port,
    poll_interval_s: dash.poll_interval_s ?? DEFAULT_DASHBOARD.poll_interval_s,
  }
  for (const key of ['port', 'serve_port']) {
    if (!(Number.isInteger(out[key]) && out[key] > 0 && out[key] < 65536)) {
      fail(`dashboard.${key} must be a port number`)
    }
  }
  if (!(typeof out.poll_interval_s === 'number' && out.poll_interval_s > 0)) {
    fail('dashboard.poll_interval_s must be a positive number of seconds — it is how often the page re-reads the journal through GET /overview')
  }
  if (dash.index !== undefined && typeof dash.index !== 'string') fail('dashboard.index must be a path')
  out.index = dash.index === undefined || !configFile
    ? DEFAULT_DASHBOARD_INDEX
    : path.resolve(path.dirname(path.resolve(configFile)), dash.index)
  return out
}

// The sidecar's own entry into the shared config file.
//
// It deliberately does NOT run loadCuriaConfig. That loader checks paths that
// belong to the DAEMON's filesystem — the agent Dockerfile, the attach index,
// every installed skill — and the sidecar's container mounts none of them. A
// check that passed here would be evidence about the wrong process. So each
// process validates what it can actually see, out of one file, with the same
// per-key rules: the `dashboard:` block above, and the identity allowlist from
// identity.mjs.
export function loadDashboardConfig(file) {
  // Both layers (#292), because the daemon reads both: a sidecar that read the
  // tracked file alone could admit a different identity list than the daemon
  // does, off the same directory.
  const { data: cfg, localFile } = readLayered(file)
  const src = localFile ? `${file} + ${localFile}` : file
  const fail = (msg) => { throw new Error(`bad config ${src}: ${msg}`) }
  if (!cfg || typeof cfg !== 'object') fail('not a mapping')
  const dashboard = readDashboard(cfg, fail, file)
  if (!fs.existsSync(dashboard.index)) {
    fail(`dashboard.index resolves to ${dashboard.index}, which does not exist — it ships committed in daemon/assets/`)
  }
  const allow = readAllow(cfg.identity, fail)
  return {
    dashboard,
    allow,
    timelinePort: readTimelinePort(cfg, fail),
    terminalPort: readTerminalPort(cfg, fail),
  }
}

// The chat (#267) is the timeline, served under this surface's own address, so
// the sidecar needs the one number that says where the timeline listens. It is
// the daemon's own loopback port and both containers share the host network.
//
// Read here rather than through loadCuriaConfig for the #263 reason: that
// loader checks the timeline PAGE on the daemon's filesystem, which this
// container does not mount. This process validates the one key it uses.
export function readTimelinePort(cfg, fail) {
  const port = cfg.timeline?.port
  if (port === undefined) return null // no timeline block: the chat says so rather than guessing
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) fail('timeline.port must be a port number')
  return port
}

export function readTerminalPort(cfg, fail) {
  const port = cfg.attach?.ttyd_port
  if (port === undefined) return null
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) fail('attach.ttyd_port must be a port number')
  return port
}

// ---------------------------------------------------------------------------
// the surface
// ---------------------------------------------------------------------------

// How often the Serve rule is re-asserted and the page re-checked. The daemon
// does this on its reconcile pass; the sidecar has no reconcile, so it keeps
// its own slow tick. It costs one `tailscale serve` exec a minute and it is
// what makes the surface heal after tailscaled restarts under it.
export const ASSERT_MS = 60_000

// How long the sidecar waits on the daemon before calling the read failed. A
// wedged daemon must not wedge the page too: the marker and the last snapshot
// are the answer, and they need this to return.
export const POLL_TIMEOUT_MS = 10_000

// What an aistack act (#706) gets instead. A poll must be quick or be dropped,
// but starting the device flow means `npx` fetching a package before the CLI
// prints anything, and granting the standing permission means a round trip to
// aistack.to. This is a hair past the daemon's own wait on each, so the daemon's
// sentence about what happened is what the operator reads rather than this
// side's sentence about not having heard.
export const AISTACK_ACT_TIMEOUT_MS = 150_000

// The one read that may leave the box (#355). Hunks come from the worktree in
// milliseconds, and from `gh pr diff` over the network when the worktree is
// gone — so this waits longer than the poll does, on a card the operator opened
// and is watching.
export const DIFF_TIMEOUT_MS = 30_000

// The setup read (#874) verifies every integration fresh, and a verification
// may cross the network to GitHub, Discord, Tailscale, or a model provider.
export const SETUP_TIMEOUT_MS = 60_000

// The biggest settings patch this surface will read. The screen writes a watch
// list and a handful of numbers, so anything near this is not a settings save.
export const MAX_BODY = 256 * 1024
// An answer may carry files inline as base64 (#712): 8 MB of files is about
// 11 MB on the wire, and the daemon caps the decoded bytes at 8 MB.
export const MAX_ANSWER_BODY = 12 * 1024 * 1024

// What the page may name on a verb route (#266).
//
// Each field is checked HERE rather than trusted, because two of them are
// composed into a command line the daemon parses. A ticket is an issue number
// or a chat handle (#241), a repo is `owner/name`, a session is a curia one.
// The words the operator types are bounded only in length: they are text for a
// person or an agent to read, and curia never interprets them.
const VERB_REPO_RE = /^[\w.-]+\/[\w.-]+$/
const VERB_TICKET_RE = /^(\d+|chat-\d+)$/
const VERB_SESSION_RE = /^curia-[\w.-]+$/
const VERB_ESC_RE = /^[\w.-]+$/
// A browser conversation key (#333). Checked here as well as in the daemon for
// the reason every field above is: this surface composes the call, so it names
// the shape it will send rather than passing a browser's word through.
const CONSOLE_KEY_RE = /^console-\d+$/
// A file's place in the digest's own ranked list (#355). An index rather than a
// path, so the set of files this surface can ask about is exactly the set curia
// measured — the browser cannot name a file, only pick one.
const VERB_FILE_RE = /^\d{1,4}$/
// A model-credential provider (#661), the shape `reauth [provider]` parses.
// Checked here for the reason every field above is: this surface composes the
// command line, so it names the shape it will send. The daemon refuses an
// unknown provider by naming what it can sign in, and that sentence is the
// reply the button shows — this only keeps a browser from writing the rest of
// the line.
const VERB_PROVIDER_RE = /^[a-z0-9][a-z0-9-]*$/
// The GitHub App setup (#694). A name GitHub will slugify, checked here for
// the reason every field above is: this surface composes the daemon call, so
// it names the shape it will send. The two fields GitHub redirects back with
// are checked on the daemon, which is the side that composes them into a URL.
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$/
// The screen GitHub's redirect lands on (#875): the Settings section or the
// Setup screen, whichever started the trip. A name, never a location.
const APP_SCREEN_RE = /^(settings|setup)$/
// The Discord card (#876). The token is checked for shape HERE, so a paste
// that is not a token is refused without crossing, and refused BY NAME: no
// sentence this surface writes carries the value. The user ID, the server
// id, and the channel name are the shapes `state/discord.json` takes.
const DISCORD_TOKEN_RE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/
const SNOWFLAKE_RE = /^[0-9]{5,25}$/
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/
// The Tailscale card's (#877) one field since #891 is the node name, which
// the daemon checks as a MagicDNS label and applies. The login is never a
// field, because the daemon records the identity Serve stamped on the
// request and nothing a browser typed.
// What the first-operator window admits (#877): exactly what the Setup page
// asks for before an operator is confirmed. The page and the favicon the
// browser requests beside it, the overview the status banner reads, the
// setup routes, and the two GitHub App manifest routes the GitHub card runs
// through (the start, and the callback GitHub redirects to). The rehearsal
// of the packaged lifecycle (#891) found the banner saying the console was
// offline and the GitHub card answering 403 with a narrower window. The
// terminal, the chat, and every verb stay refused until an operator is
// confirmed.
const FIRST_OPERATOR_PATHS = /^\/(?:$|index\.html$|favicon\.ico$|api\/overview$|api\/setup(?:\/|$)|api\/github-app\/(?:start|complete)$)/
// How the app keeps asking the daemon for its allowlist at boot (#891):
// every 2 s, for up to a minute, until the daemon has answered once.
const IDENTITY_RETRY_MS = 2_000
const IDENTITY_RETRY_FOR_MS = 60_000

export const MAX_WORDS = 4000

// Why an answer did not land (#266). The reduction refuses in ONE WORD — `unknown`,
// or whatever status the record holds instead of open — because that word is
// for a caller. The operator gets the sentence it stands for, since every one
// of these is first-valid-wins or supersede doing exactly its job.
export const ANSWER_REFUSAL = {
  unknown: 'curia has no record of that question',
  answered: 'that question was already answered — the first valid answer wins',
  cancelled: 'that question was cancelled, so nobody is waiting for an answer to it',
  lapsed: 'that question lapsed with the agent that asked it',
  superseded: 'that question was superseded by a newer one',
}

// A refusal about what the PAGE sent, in the same vocabulary a refused save
// carries: the operator can see it and fix it, so it answers 409 rather than
// reading as this process failing.
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

// What the box's own log says about the apply that followed a save (#362). The
// page says the same three things to the operator, in its banner.
function reloadLine(reload) {
  if (!reload) return 'nothing to apply'
  if (reload.ok) {
    return reload.applied?.length
      ? `the daemon applied ${reload.applied.join(', ')}`
      : 'the daemon was already running what the file says'
  }
  if (reload.reason === 'daemon-down') return `the daemon could not be asked to apply it (${reload.error}) — it reads the file at its next boot`
  return `the daemon declined to apply it: ${reload.error}`
}

function settingsPaths(patch) {
  const paths = []
  if (patch && ['dispatch', 'overseer', 'watch'].some((key) => Object.hasOwn(patch, key))) paths.push('config.yaml')
  if (patch && Object.hasOwn(patch, 'routing')) paths.push('routing.local.yaml')
  return paths
}

function field(value, re, what) {
  const s = String(value ?? '').trim()
  if (!re.test(s)) throw refuse(`"${s}" is not ${what}`)
  return s
}
// A reply's files, as the page sends them (#712): `{name, data}` with base64
// data. The names are the operator's own and the daemon makes them safe; this
// surface only keeps the shape honest and the count small.
const MAX_REPLY_FILES = 10
function replyFiles(value) {
  if (!Array.isArray(value)) return []
  if (value.length > MAX_REPLY_FILES) throw refuse(`a reply carries at most ${MAX_REPLY_FILES} files`)
  return value.map((f) => ({ name: String(f?.name ?? ''), data: String(f?.data ?? '') }))
}

function words(value, what) {
  const s = String(value ?? '').trim()
  if (!s) throw refuse(`${what} with no words is not ${what}`)
  if (s.length > MAX_WORDS) throw refuse(`${what} may not exceed ${MAX_WORDS} characters`)
  return s
}

// The chat (#267, a page of Curia app since #711). The Curia app page draws the
// transcript and the composer itself, and the six routes it speaks are handed
// straight through to the daemon's timeline listener on loopback. The
// timeline's own Serve rule retired with #711: this is the only way in.
//
//   browser ──Serve(:8445)──> sidecar ──> daemon timeline(:4272)
//
// `/chat` stays as a door for the links an older daemon handed out: it sends
// the browser to the `#chat/<session>` route of the page.
//
// Nothing is rewritten on the way. The Host and the operator's login travel as
// they arrived, so the timeline applies the #151 predicate in-process to the
// evidence the browser actually sent — the sidecar carries the bytes and
// vouches for nothing. The daemon's own host allowlist admits this surface's
// name, which is what makes that pass (index.mjs resolveServeHosts).
export const CHAT_PAGE = '/chat'
const CHAT_ROUTES = new Set(['/events', '/send', '/draft', '/key', '/take-back', '/dialog-answer'])
export const TERMINAL_PAGE = '/terminal/'

export class DashboardSurface {
  constructor({
    port, servePort, index, allow, daemonPort: dPort = daemonPort(),
    pollIntervalS = DEFAULT_DASHBOARD.poll_interval_s,
    curiaFile = null, routingFile = null, timelinePort = null, terminalPort = null,
    identitySource = 'config', settingsSource = 'files',
    identityRetryMs = IDENTITY_RETRY_MS, identityRetryForMs = IDENTITY_RETRY_FOR_MS,
    log = console.log, deps = {},
  }) {
    this.port = port
    // Where the timeline listens on loopback. Null means this sidecar was
    // started against a config with no timeline block, and the chat says so.
    this.timelinePort = timelinePort
    this.terminalPort = terminalPort
    this.servePort = servePort
    this.index = index
    // The two files the settings screen writes (#265). In the source
    // deployment they are the only writable thing in this container: #263's
    // mount list gives it `config/` read-write and everything else
    // read-only. Under an installation root the app mounts nothing (#867),
    // so `settingsSource: 'daemon'` reads them and lands a save through the
    // service's `GET` and `POST /settings` instead (#880).
    this.curiaFile = curiaFile
    this.routingFile = routingFile
    this.settingsSource = settingsSource
    this.daemonPort = dPort
    this.pollIntervalMs = pollIntervalS * 1000
    this.pollIntervalS = pollIntervalS
    this.log = log
    // Created empty and filled in place, exactly as index.mjs does it: the
    // request handler holds a live reference, so a tailscale answer that
    // arrives after the listener is up is picked up without rewiring. Empty
    // means refuse — a surface that does not know its own name admits nobody.
    this.allow = new Set(allow ?? [])
    // Where the allowlist comes from (#877). `config` is the source
    // deployment: `identity.allow` in curia.yaml, read once at boot. `daemon`
    // is an installation root: the confirmed operator the daemon keeps in
    // `state/tailscale.json`, which this container cannot read, asked over
    // loopback at boot, on every poll, and after the confirmation. Until the
    // daemon has answered, nobody is admitted; and only the daemon's own
    // word that no operator is confirmed yet opens the first-operator window.
    this.identitySource = identitySource
    this.firstOperator = false
    // The retry of a failed identity read (#891), until the daemon has
    // answered once. At boot the app reads `/identity` before the daemon is
    // up, and without this the next read was the periodic Serve assert, a
    // minute in which the app refused the operator `curia install` had
    // sent to it.
    this.identityRetryMs = identityRetryMs
    this.identityRetryForMs = identityRetryForMs
    this.identityAnswered = false
    this.identityRetryTimer = null
    this.identityRetrySince = null
    this.hosts = new Set()
    this.deps = { assertServe, serveOff, attachBase, tailnetSelf, fetchOverview: null, ...deps }
    this.server = null
    this.listening = false
    this.timer = null
    // The snapshot the page draws, and everything the marker needs to be
    // honest about it: when it was read, and why the last read failed.
    this.snapshot = null
    this.snapshotAt = 0
    this.error = null
    this.errorSince = null
    this.inFlight = null
  }

  #refusal(req) {
    const reason = identityRefusal(req.headers, { allow: this.allow, hosts: this.hosts })
    if (!reason || !this.firstOperator) return reason
    // The first-operator window (#877): the daemon said no operator is
    // confirmed yet, so the identity that opens the app is the one setup
    // shows and asks to confirm. The Funnel and Host legs still hold; only
    // the allowlist leg is answered by the request's own stamped login, and
    // only for the page and the setup routes.
    const login = String(req.headers[LOGIN_HEADER] ?? '').toLowerCase()
    if (!login) return reason
    const pathname = String(req.url ?? '').split('?')[0]
    if (!FIRST_OPERATOR_PATHS.test(pathname)) return `${reason} — no operator is confirmed yet, and only setup is open before one is`
    return identityRefusal(req.headers, { allow: new Set([login]), hosts: this.hosts })
  }

  // The allowlist from the daemon (#877), written into the live set in place.
  // A daemon that cannot be asked leaves the last answer standing: a restart
  // of the daemon must not open the window, and must not lock the operator
  // out either.
  async refreshIdentity() {
    if (this.identitySource !== 'daemon') return
    let out
    try {
      out = await this.#daemon({ path: '/identity' })
    } catch (e) {
      const retry = this.#retryIdentity()
      this.log(`dashboard: the daemon's identity read failed (${e.message}) — keeping the last allowlist${retry ? `, retrying every ${this.identityRetryMs / 1000}s until the daemon answers` : ''}`)
      return
    }
    this.identityAnswered = true
    this.#stopIdentityRetry()
    const logins = Array.isArray(out?.allow) ? out.allow.map((l) => String(l).toLowerCase()) : []
    this.allow.clear()
    for (const l of logins) this.allow.add(l)
    const window = Boolean(out?.first_operator) && logins.length === 0
    if (window !== this.firstOperator) this.log(window ? 'dashboard: no operator is confirmed yet — setup is open to the first Tailscale identity that arrives' : `dashboard: ${logins.length} login(s) admitted`)
    this.firstOperator = window
  }

  // Schedule the next identity read after a failed one, while the daemon has
  // never answered and the ceiling is not spent. Answers whether a retry is
  // scheduled. Once the daemon has answered once, a later failure keeps the
  // last allowlist and waits for the assert loop, as before: a daemon
  // restart must not open the window, and must not lock the operator out.
  #retryIdentity() {
    if (this.identityAnswered || this.identityRetryTimer) return Boolean(this.identityRetryTimer)
    this.identityRetrySince ??= Date.now()
    if (Date.now() - this.identityRetrySince >= this.identityRetryForMs) {
      if (this.identityRetrySince !== Infinity) this.log(`dashboard: stopped retrying the daemon's identity read after ${this.identityRetryForMs / 1000}s — the next read is the serve assert`)
      this.identityRetrySince = Infinity
      return false
    }
    this.identityRetryTimer = setTimeout(() => {
      this.identityRetryTimer = null
      this.refreshIdentity().catch((e) => this.log(`dashboard: the identity retry failed: ${e.message}`))
    }, this.identityRetryMs)
    this.identityRetryTimer.unref?.()
    return true
  }

  #stopIdentityRetry() {
    if (this.identityRetryTimer) clearTimeout(this.identityRetryTimer)
    this.identityRetryTimer = null
  }

  // Bind the loopback listener. A port that will not bind is not a surface this
  // process can own, and the caller withdraws the Serve rule and dies rather
  // than leaving a rule pointed at whatever took the port (#70's rule).
  start() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        try {
          this.#handle(req, res)
        } catch (e) {
          this.log(`dashboard request ${req.method} ${req.url} failed: ${e.message}`)
          if (res.writableEnded) return
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head))
      server.once('error', (e) => {
        this.log(`WARNING: the dashboard could not bind 127.0.0.1:${this.port} (${e.message}) — the surface is DOWN and will not be published`)
        this.listening = false
        resolve({ verified: false, error: e.message })
      })
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server
        this.port = server.address().port // resolves port 0 (tests bind ephemerally)
        this.listening = true
        this.log(`dashboard on http://127.0.0.1:${this.port} → daemon :${this.daemonPort}, refreshing at most every ${this.pollIntervalS}s`)
        resolve({ verified: true })
      })
    })
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.#stopIdentityRetry()
    this.server?.close()
    this.server = null
    this.listening = false
  }

  // The names this box answers to on the Serve port. Retried rather than
  // resolved once: tailscale may be slow or down at boot, and that must not be
  // fatal to a process whose page still serves its last snapshot on loopback.
  async resolveHosts() {
    const self = await this.deps.tailnetSelf()
    this.hosts.clear()
    for (const h of serveHosts({ ...self, servePort: this.servePort })) this.hosts.add(h)
    return self
  }

  // Publish, or withdraw and say why. Fail-closed in both directions: the rule
  // goes up only over a listener that is ours, serving a page this server
  // speaks, behind an identity check that knows its own name — and a surface
  // that stops satisfying any of those has its rule actively withdrawn, because
  // `tailscale serve --bg` persists in tailscaled and skipping the assert alone
  // un-publishes nothing.
  async assert() {
    await this.refreshIdentity()
    let refusal = null
    if (!this.listening) refusal = `the dashboard listener on 127.0.0.1:${this.port} is not up`
    else refusal = pageRefusal(this.index)
    if (!refusal) {
      try {
        await this.resolveHosts()
      } catch (e) {
        refusal = `the dashboard cannot resolve the tailnet names it serves (${e.message}) — its identity check would refuse every caller`
      }
    }
    if (refusal) {
      try {
        await this.deps.serveOff({ servePort: this.servePort, log: this.log })
        this.log(`WARNING: ${refusal} — dashboard serve rule for :${this.servePort} withdrawn`)
      } catch (e) {
        this.log(`WARNING: ${refusal} — and withdrawing the dashboard serve rule failed (${e.message}); if a rule for :${this.servePort} exists it REMAINS PUBLISHED tailnet-wide; run \`tailscale serve --https=${this.servePort} off\` by hand`)
      }
      return { verified: false, refusal }
    }
    await this.deps.assertServe({ servePort: this.servePort, targetPort: this.port })
    return { verified: true }
  }

  // The slow tick that keeps the rule true. Never the poll: the poll is what a
  // page asks for, and this asks tailscale.
  startAssertLoop(everyMs = ASSERT_MS) {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      this.assert().catch((e) => this.log(`dashboard serve assert failed: ${e.message}`))
    }, everyMs)
    this.timer.unref?.()
  }

  // The composed link — curia's own records, never a hand-written URL (#68).
  async link() {
    const base = await this.deps.attachBase()
    return `https://${base}:${this.servePort}/`
  }

  // ---- the read ------------------------------------------------------------

  // One loopback call to the daemon. NOTHING here forwards a browser's request:
  // the sidecar composes its own, with no Origin header, because the daemon's
  // whole loopback surface refuses any request carrying one — the CSRF gate
  // that stops a page on this box from driving the daemon. The sidecar is
  // loopback tooling on the daemon's side of that gate, and it earns that by
  // building each call from a route it names in code, never from a URL a
  // browser handed it.
  // `accept` widens what counts as an answer rather than a failure (#266). The
  // answer route needs it: a question that is no longer open comes back 409
  // with the REASON in the body, and that reason is the whole point — it is
  // what first-valid-wins looks like from the console.
  // `timeout` is widened by the one read that may leave the box (#355): the
  // hunks fall back to `gh pr diff` when the worktree is gone, and a network
  // round trip does not fit the poll's ceiling.
  #daemon({ method = 'GET', path: route, body = null, accept = [200], timeout = POLL_TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
      const payload = body === null ? null : Buffer.from(JSON.stringify(body))
      const req = http.request({
        host: '127.0.0.1', port: this.daemonPort, path: route, method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (!accept.includes(res.statusCode)) return reject(new Error(`the daemon answered ${res.statusCode} on ${route}`))
          try {
            resolve(JSON.parse(text))
          } catch (e) {
            reject(new Error(`the daemon's ${route} is not JSON: ${e.message}`))
          }
        })
      })
      req.setTimeout(timeout, () => req.destroy(new Error(`the daemon did not answer ${route} within ${timeout / 1000}s`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  #fetchOverview() {
    if (this.deps.fetchOverview) return this.deps.fetchOverview()
    return this.#daemon({ path: '/overview' })
  }

  // A failed read NEVER costs the snapshot. That is the sidecar's reason to
  // exist: during a daemon restart the page keeps the last reading and says so,
  // rather than going blank at the exact moment the box is most interesting.
  async refresh() {
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      try {
        const overview = await this.#fetchOverview()
        await this.refreshIdentity()
        this.snapshot = overview
        this.snapshotAt = Date.now()
        if (this.error) this.log(`dashboard: the daemon is answering again on :${this.daemonPort}`)
        this.error = null
        this.errorSince = null
      } catch (e) {
        if (!this.error) {
          this.errorSince = new Date().toISOString()
          this.log(`dashboard: the daemon is not answering on :${this.daemonPort} (${e.message}) — serving the last snapshot with the restarting marker`)
        }
        this.error = e.message
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  // What the page reads. The age check is the whole poll policy: a request
  // inside the interval is answered from memory, so N tabs cost one read and a
  // hidden tab — which stops asking — costs none.
  async payload() {
    const stale = Date.now() - this.snapshotAt >= this.pollIntervalMs
    if (stale || !this.snapshot) await this.refresh()
    return {
      poll_interval_s: this.pollIntervalS,
      // The instant the snapshot was READ, not the instant it was served. The
      // page states the age of the reading, the same honesty the frontier
      // stamp carries inside it (#262).
      read_at: this.snapshotAt ? new Date(this.snapshotAt).toISOString() : null,
      // The restarting marker. `daemon_up` is false exactly while the last read
      // failed, and the reason travels with it rather than being inferred from
      // a blank page.
      daemon_up: !this.error,
      daemon_port: this.daemonPort,
      error: this.error,
      error_since: this.errorSince,
      overview: this.snapshot,
    }
  }

  // ---- requests ------------------------------------------------------------

  #json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }

  // The extra gate every WRITE passes, on top of the identity check (#265).
  //
  // The identity header does not answer this one. A page on any origin can
  // `fetch` this surface's tailnet URL, and Serve stamps that request with the
  // operator's own login on the way through — the header proves who the browser
  // belongs to, never which page told it to call. So a write also has to come
  // from THIS surface's own origin, and the set of names it answers to is the
  // one identityRefusal already checks Host against.
  //
  // Fail-closed: a write with no Origin at all is refused too. Every browser
  // sends one on a POST, and a caller that is not a browser has the daemon's
  // own loopback surface to talk to.
  #crossSite(req) {
    const origin = req.headers.origin
    if (!origin) return 'a write to this surface must carry an Origin header — it is the console page that writes here, and nothing else'
    let host
    try {
      host = new URL(origin).host.toLowerCase()
    } catch {
      return `Origin "${origin}" is not a URL`
    }
    if (!this.hosts.has(host)) return `Origin "${origin}" is not this console — a write may only come from the page this surface serves`
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin') return `this write says it crossed sites (Sec-Fetch-Site: ${site})`
    return null
  }

  // A JSON body, bounded. `readBody` on the daemon side is the same shape; this
  // one is separate because the sidecar imports no daemon internals.
  #body(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > limit) {
          req.destroy()
          return reject(new Error(`a ${limit === MAX_BODY ? 'settings save' : 'reply with files'} may not exceed ${limit} bytes`))
        }
        chunks.push(c)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text.trim()) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch (e) {
          reject(new Error(`the body is not JSON: ${e.message}`))
        }
      })
      req.on('error', reject)
    })
  }

  // Everything this surface WRITES runs through here — the settings save (#265)
  // and every operator verb (#266) — so the refusal vocabulary is one thing: a
  // refusal is something the operator can see and fix and answers 409, and
  // anything else is this process failing and answers 500. The two must not
  // read the same. The first is fixed on the page, the second on the box.
  #write(res, work) {
    return Promise.resolve().then(work).then(
      (out) => this.#json(res, 200, out),
      (e) => {
        if (e?.refusal) {
          this.log(`dashboard: the save was refused — ${e.message}`)
          return this.#json(res, 409, { error: e.message, refused: true, ...(e.receipt ? { receipt: e.receipt } : {}) })
        }
        this.log(`dashboard: the save failed — ${e.message}`)
        return this.#json(res, 500, { error: e.message })
      },
    )
  }

  // A verb (#266): the same refusal vocabulary a save carries, plus the one
  // thing a save does not need. The held snapshot is now behind the box — an
  // agent has spawned, a question has closed, a ticket has left the frontier —
  // so its age is dropped and the next page read is a fresh one. Without this
  // the operator presses a button and watches nothing change for the rest of
  // the poll interval.
  #verb(res, work) {
    return this.#write(res, async () => {
      const out = await work()
      this.snapshotAt = 0
      return out
    })
  }

  // The apply (#362). The daemon holds the running config, so it is the one
  // process that can take a new one — this file only asks, and hands back
  // whatever it answers. A daemon that is not there is not a failure of the
  // save: the file is written, and the daemon reads it at its next boot.
  async #reload(by, { actionId = null, written = [] } = {}) {
    try {
      const out = await this.#daemon({
        method: 'POST', path: '/reload',
        body: { by, ...(actionId ? { action_id: actionId, written } : {}) },
      })
      // The next page read must be a fresh one. The marker on the settings
      // screen compares the daemon's own six against the file, and a snapshot
      // taken before the reload would say they disagree for a whole interval
      // after they stopped.
      this.snapshotAt = 0
      return out
    } catch (e) {
      return { ok: false, reason: 'daemon-down', error: e.message }
    }
  }

  async #beginSettingsAction({ actionId, paths, by }) {
    try {
      return await this.#daemon({
        method: 'POST', path: '/settings/action',
        body: { action_id: actionId, paths, by },
      })
    } catch (e) {
      return { action: null, offline: e.message }
    }
  }

  async #finishSettingsAction(actionId, status, detail = {}) {
    if (!actionId) return null
    try {
      const out = await this.#daemon({
        method: 'POST', path: '/settings/action/finish',
        body: { action_id: actionId, status, ...detail },
        accept: [200, 404],
      })
      return out.action ?? null
    } catch {
      return null
    }
  }

  // The one guard the save owes (#362). A repo removed from the watch list
  // while an agent runs on it drops out of reconcile, and that agent's claim
  // stops being covered — nothing releases it, and no surface counts it. So the
  // save refuses and names the agent. A restart would do the same to that
  // agent, which is why this guard is owed whether the apply is hot or not.
  //
  // The evidence is the DAEMON's fleet, read fresh: an agent spawned inside the
  // last poll interval is exactly the one this exists for. A daemon that cannot
  // be asked leaves the guard unrun, and the save goes through — refusing there
  // would take away the one thing the sidecar exists for, which is fixing the
  // config from the page while the daemon is down.
  async #guardWatchRemoval(patch) {
    if (!Array.isArray(patch?.watch)) return
    const before = (await this.#readSettings()).watch
    const kept = new Set(patch.watch.map((w) => String(w?.repo ?? '')))
    const removed = before.map((w) => w.repo).filter((repo) => !kept.has(repo))
    if (!removed.length) return
    this.snapshotAt = 0
    await this.refresh()
    const agents = this.snapshot?.agents
    if (this.error || !agents) {
      this.log(`dashboard: could not ask the daemon whether an agent runs on ${removed.join(', ')} — saving the removal unchecked`)
      return
    }
    const held = agents.filter((a) => removed.includes(a.repo))
    if (!held.length) return
    const names = held.map((a) => a.session).join(', ')
    throw refuse(`${held[0].repo} cannot leave the watch list while ${names} runs on it — curia would stop covering that agent's claim. Cancel it, or wait for it to finish.`)
  }

  // The settings read and the settings write, from the files this container
  // mounts or through the service (#880). One flow either way: the handler
  // above these two is the same, and only where the bytes come from and land
  // differs. A daemon refusal (400) is the operator's to fix and reads as a
  // refusal here; a daemon that cannot be asked is this process failing.
  async #readSettings() {
    if (this.settingsSource === 'daemon') return this.#daemon({ path: '/settings' })
    if (!this.curiaFile || !this.routingFile) throw new Error('this sidecar was started without config file paths, so it cannot read them')
    return readSettings({ curiaFile: this.curiaFile, routingFile: this.routingFile })
  }

  async #saveSettings(patch) {
    if (this.settingsSource === 'daemon') {
      const out = await this.#daemon({ method: 'POST', path: '/settings', body: patch, accept: [200, 400] })
      if (out?.ok === false) throw refuse(out.error ?? 'the daemon refused the save')
      return out
    }
    if (!this.curiaFile || !this.routingFile) throw new Error('this sidecar was started without config file paths, so it cannot save')
    return saveSettings({ curiaFile: this.curiaFile, routingFile: this.routingFile, patch })
  }

  // The command seam (#33 step 9), reached with text this file composed. Every
  // verb that has a word in the operator's own catalogue goes through it rather
  // than around it, so a press from the console journals the same `command`
  // event a typed one does and lands in the feed for free.
  #command(text, by, actionId = null) {
    return this.#daemon({
      method: 'POST', path: '/command',
      body: { text, by, ...(actionId ? { action_id: actionId } : {}) },
    })
  }

  // The chat, piped (#267). Headers travel unchanged in both directions, and
  // the body streams — the timeline's read is server-sent events, which a
  // buffering proxy would turn into a page that never updates.
  #chat(req, res, upstreamPath) {
    if (!this.timelinePort) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end('this sidecar was started against a config with no `timeline:` block, so it cannot reach the chat\n')
    }
    const up = http.request({
      host: '127.0.0.1', port: this.timelinePort, method: req.method, path: upstreamPath, headers: req.headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers)
      upRes.pipe(res)
    })
    up.on('error', (e) => {
      this.log(`dashboard: the chat could not reach the timeline on :${this.timelinePort} (${e.message})`)
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`the chat is the daemon's timeline surface, and it is not answering on :${this.timelinePort} (${e.message})\n`)
    })
    // A reader that closes the tab must not leave an event stream open on the
    // daemon: the timeline counts its clients, and a phantom one keeps a
    // session pumping forever.
    res.on('close', () => up.destroy())
    req.pipe(up)
  }

  // The terminal shares Curia app's address. HTTP serves ttyd's built page and the
  // WebSocket carries its PTY. The sidecar checks identity and Origin before it
  // opens either path, then rewrites the upstream origin to ttyd's loopback
  // address. ttyd receives no operator identity and holds no Curia app secret.
  #terminal(req, res, upstreamPath) {
    if (!this.terminalPort) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end('this sidecar was started against a config with no `attach.ttyd_port`, so it cannot reach the terminal\n')
    }
    const headers = {
      ...req.headers,
      host: `127.0.0.1:${this.terminalPort}`,
      origin: `http://127.0.0.1:${this.terminalPort}`,
    }
    const up = http.request({
      host: '127.0.0.1', port: this.terminalPort, method: req.method, path: upstreamPath, headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers)
      upRes.pipe(res)
    })
    up.on('error', (e) => {
      this.log(`dashboard: the terminal could not reach ttyd on :${this.terminalPort} (${e.message})`)
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`the embedded terminal is not answering on :${this.terminalPort} (${e.message})\n`)
    })
    res.on('close', () => up.destroy())
    req.pipe(up)
  }

  #upgrade(req, socket, head) {
    const refusal = this.#refusal(req) ?? this.#crossSite(req)
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`)
    if (refusal || !url.pathname.startsWith(TERMINAL_PAGE) || !this.terminalPort) {
      const status = refusal ? '403 Forbidden' : '404 Not Found'
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
      return
    }
    const upstreamPath = `/${url.pathname.slice(TERMINAL_PAGE.length)}${url.search}`
    const headers = {
      ...req.headers,
      host: `127.0.0.1:${this.terminalPort}`,
      origin: `http://127.0.0.1:${this.terminalPort}`,
    }
    const up = http.request({
      host: '127.0.0.1', port: this.terminalPort, method: 'GET', path: upstreamPath, headers,
    })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (Array.isArray(value)) value.forEach((item) => lines.push(`${name}: ${item}`))
        else if (value !== undefined) lines.push(`${name}: ${value}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upSocket.write(head)
      if (upHead.length) socket.write(upHead)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    up.on('response', (upRes) => {
      socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\nConnection: close\r\n\r\n`)
      socket.end()
      upRes.resume()
    })
    up.on('error', (e) => {
      this.log(`dashboard: terminal WebSocket failed (${e.message})`)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    })
    up.end()
  }

  #handle(req, res) {
    // The reachability probe (#884), before the identity gate: the version
    // this process runs and nothing else, so the lifecycle interface can
    // prove on loopback, where no Serve identity exists, that the app came
    // back on the target release after a switch. It reads nothing and asks
    // the daemon nothing; a version is not a secret.
    if (req.method === 'GET' && String(req.url ?? '').split('?')[0] === '/ping') {
      return this.#json(res, 200, { curia: 'curia-dashboard', version: APP_VERSION })
    }
    const reason = this.#refusal(req)
    if (reason) {
      this.log(`dashboard: REFUSED ${req.url} — ${reason}`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(`curia refused this request: ${reason}\n`)
    }
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`)

    if (req.method === 'GET' && (url.pathname === '/terminal' || url.pathname.startsWith(TERMINAL_PAGE))) {
      const upstreamPath = url.pathname === '/terminal'
        ? '/'
        : `/${url.pathname.slice(TERMINAL_PAGE.length)}${url.search}`
      return this.#terminal(req, res, upstreamPath)
    }

    if (req.method === 'POST') {
      const crossSite = this.#crossSite(req)
      if (crossSite) {
        this.log(`dashboard: REFUSED ${req.method} ${req.url} — ${crossSite}`)
        return this.#json(res, 403, { error: crossSite })
      }
      // The chat's writes include the composer, shared draft, pane key, and
      // message take back. They pass the cross-site check here. The timeline
      // applies its own check too.
      if (CHAT_ROUTES.has(url.pathname)) return this.#chat(req, res, url.pathname + url.search)
      // The save (#265). In the source deployment the sidecar writes the file
      // itself: it holds the only read-write mount in this container, and
      // #249 put the edit here so that a config the daemon refuses to boot on
      // can still be fixed from the page while the daemon is down. Under an
      // installation root the write lands through the service (#880).
      if (url.pathname === '/api/settings') {
        return this.#write(res, async () => {
          const body = await this.#body(req)
          const actionId = body.action_id == null ? null : field(body.action_id, ACTION_ID_RE, 'an Action id')
          const { action_id: _actionId, ...patch } = body
          const paths = settingsPaths(patch)
          const by = String(req.headers[LOGIN_HEADER] ?? '') || 'dashboard'
          const begun = actionId ? await this.#beginSettingsAction({ actionId, paths, by }) : null
          if (begun?.action && ['refused', 'failed'].includes(begun.action.status)) {
            return {
              written: [], reload: null, action: begun.action,
              settings: await this.#readSettings(),
            }
          }
          let out
          try {
            await this.#guardWatchRemoval(patch)
            out = await this.#saveSettings(patch)
          } catch (error) {
            const settled = await this.#finishSettingsAction(actionId, 'refused', { reason: error.message })
            if (settled) error.receipt = { action: settled }
            throw error
          }
          // The save APPLIES (#362). The daemon re-reads both files and takes
          // every setting this screen writes, so the restart stops being
          // phase two of every save. A save that wrote nothing asks for
          // nothing: the file did not move, so there is nothing to reload.
          const reload = out.written.length
            ? await this.#reload(by, { actionId, written: out.written })
            : null
          const noChange = out.written.length ? null : await this.#finishSettingsAction(actionId, 'confirmed', {
            receipt: { written: [], applied: [] },
          })
          this.log(out.written.length
            ? `dashboard: saved ${out.written.join(' and ')} — ${reloadLine(reload)}`
            : 'dashboard: the save changed nothing')
          return {
            ...out, reload,
            ...(reload?.action || noChange || begun?.action ? { action: reload?.action ?? noChange ?? begun.action } : {}),
            settings: await this.#readSettings(),
          }
        })
      }
      // The restart (#249 item 6). The sidecar orders it and the daemon does
      // it: POST /restart journals the request and exits nonzero, and the
      // supervisor respawns. Nothing here waits for the daemon to come back —
      // the page's own marker is what says whether it has.
      if (url.pathname === '/api/restart') {
        return this.#write(res, async () => {
          const b = await this.#body(req)
          const actionId = field(b.action_id, ACTION_ID_RE, 'an Action id')
          // Drop the held reading before the order crosses the socket. If the
          // daemon exits after taking the order but before its receipt arrives,
          // the next poll still measures daemon health instead of holding the
          // pre-restart snapshot through the ambiguous interval.
          this.snapshotAt = 0
          const uptime = this.snapshot?.daemon?.uptime_s
          const out = await this.#daemon({
            method: 'POST',
            path: '/restart',
            body: {
              by: 'dashboard',
              action_id: actionId,
              ...(typeof uptime === 'number' && Number.isFinite(uptime) && uptime >= 0 ? { uptime_s: uptime } : {}),
            },
            accept: [200, 409],
          })
          if (out.action && this.snapshot) {
            const prior = (this.snapshot.actions ?? []).filter((action) => action.action_id !== out.action.action_id)
            this.snapshot = { ...this.snapshot, actions: [...prior, out.action] }
          }
          this.log('dashboard: the daemon took the restart order')
          return out
        })
      }
      if (url.pathname === '/api/github-app/start') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const name = field(b.name, APP_NAME_RE, 'a GitHub App name')
          const actionId = field(b.action_id, ACTION_ID_RE, 'an Action id')
          const screen = b.screen === undefined ? 'settings' : field(b.screen, APP_SCREEN_RE, 'a screen that starts a GitHub App setup')
          // The redirect is THIS surface's own address, composed from curia's
          // own records (#68) rather than from the request headers. GitHub
          // sends the conversion code back to this URL, so a caller-named
          // redirect would be a way to send that code somewhere else. The
          // `Host` header is whatever the caller wrote; `link()` is what
          // tailscale says this box is.
          const redirectUrl = new URL('api/github-app/complete', await this.link()).toString()
          return this.#daemon({
            method: 'POST', path: '/github-app/start', body: { name, redirect_url: redirectUrl, action_id: actionId, screen }, accept: [200, 400],
          })
        })
      }
      // The re-read of the app's installations (#762). No field crosses: the
      // press is the whole message.
      if (url.pathname === '/api/github-app/refresh') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const actionId = field(b.action_id, ACTION_ID_RE, 'an Action id')
          return this.#daemon({ method: 'POST', path: '/github-app/installations', body: { action_id: actionId } })
        })
      }
      // ---- the operator verbs (#266) ---------------------------------------
      //
      // Every one of them is a call this file COMPOSES. The browser hands over
      // typed fields — a repo, a ticket number, an escalation id, some words —
      // and each route below builds the daemon call out of a shape it names in
      // code. Nothing a browser sends is forwarded as command TEXT: `POST
      // /command` runs the whole operator catalogue, and passing a string
      // through would make this surface a way to type anything at the daemon.
      // The sidecar sits on the daemon's side of the loopback gate, and this is
      // what it earns that with.
      //
      // `by` is the operator's own Tailscale login, read off the header the
      // identity gate above already checked. The journal and the feed then name
      // who pressed, instead of saying `dashboard` about every act.
      const by = String(req.headers[LOGIN_HEADER] ?? '')

      // Start, from a frontier card. The dispatch order (claim, prepare, spawn)
      // is `start`'s and nothing here repeats it — the reply is curia's own
      // sentence about what happened, shown as it stands.
      if (url.pathname === '/api/start') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const repo = field(b.repo, VERB_REPO_RE, 'an owner/name repo')
          const ticket = field(b.ticket, VERB_TICKET_RE, 'a ticket number')
          const actionId = b.action_id == null ? null : field(b.action_id, ACTION_ID_RE, 'an Action id')
          return this.#command(`start ${repo}#${ticket}`, by, actionId)
        })
      }

      // An answer, for an escalation or for the review gate — one route,
      // because they are one act. First-valid-wins and supersede are the
      // reduction's, so an answer that arrives second comes back 409 with the
      // reason, and the page says which.
      if (url.pathname === '/api/answer') {
        return this.#verb(res, async () => {
          const b = await this.#body(req, MAX_ANSWER_BODY)
          const id = field(b.id, VERB_ESC_RE, 'an escalation id')
          // An answer is words, an option index, or files (#712): a button and
          // a select send the index every surface shares, a numbered reply
          // sends words the page resolved, and a reply may carry files as
          // inline base64. Any one of the three is an answer.
          const index = Number.isInteger(b.index) && b.index >= 0 ? b.index : null
          const files = replyFiles(b.files)
          const answer = index === null && !files.length ? words(b.answer, 'an answer') : String(b.answer ?? '').trim().slice(0, MAX_WORDS)
          const actionId = b.action_id == null ? null : field(b.action_id, ACTION_ID_RE, 'an Action id')
          const out = await this.#daemon({
            method: 'POST', path: '/answer', body: {
              id, answer, index, files, by, via: 'dashboard', ...(actionId ? { action_id: actionId } : {}),
            }, accept: [200, 400, 409],
          })
          if (out.action) return out
          if (out.ok === false) {
            // The first receipt rides the refusal, so the page shows the mark
            // rather than an error (#712, ADR-0025).
            throw Object.assign(refuse(out.error ?? ANSWER_REFUSAL[out.reason] ?? `that question is ${out.reason}`), { receipt: out.receipt ?? null })
          }
          return out
        })
      }

      // The Feed's read stamp (#704): the page opened the Feed under this
      // login, and the daemon journals the instant. The snapshot is dropped so
      // the next poll carries the new stamp back.
      if (url.pathname === '/api/feed/read') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const actionId = field(b.action_id, ACTION_ID_RE, 'an Action id')
          return this.#daemon({ method: 'POST', path: '/feed/read', body: { by, action_id: actionId } })
        })
      }
      // Sign a model credential back in (#661). The Credentials screen's one
      // action, and the reason that screen exists: the recovery from a dead
      // credential has no ssh in it, so the press has to reach a phone.
      //
      // It runs the operator's own `reauth <provider>` through the command
      // seam, so a press journals the same `command` event a typed one does and
      // the reply the button shows is curia's own sentence about what happened
      // — including the refusal when this daemon brokers no credential for that
      // provider. Nothing about the login is decided here.
      if (url.pathname === '/api/reauth') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const provider = field(b.provider, VERB_PROVIDER_RE, 'a provider name')
          const actionId = b.action_id == null ? null : field(b.action_id, ACTION_ID_RE, 'an Action id')
          return this.#command(`reauth ${provider}`, by, actionId)
        })
      }
      // The browser conversations (#333). The Chat screen mints one and
      // deletes one, and both are composed here out of a shape this file names:
      // `new` sends no field at all, and `delete` sends one key this side
      // validates before the daemon validates it again.
      // Integration setup (#874). The record the daemon keeps is the selected
      // card and a closed list of safe fields per card, and this side composes
      // the write out of exactly that list: a key the list does not name goes
      // nowhere, so a token typed into a field a later ticket adds cannot ride
      // into `state/setup.json` by way of this route. The daemon checks the
      // shapes again.
      if (url.pathname === '/api/setup') {
        return this.#write(res, async () => {
          const b = await this.#body(req)
          const body = {}
          if (b.step !== undefined) {
            const step = String(b.step ?? '')
            if (!SETUP_CARDS.includes(step)) throw refuse(`"${step.slice(0, 40)}" is not a setup card`)
            body.step = step
          }
          if (b.progress !== undefined) {
            if (!b.progress || typeof b.progress !== 'object') throw refuse('progress must be a mapping of card to fields')
            body.progress = {}
            for (const card of SETUP_CARDS) {
              const fields = b.progress[card]
              if (!fields || typeof fields !== 'object') continue
              body.progress[card] = Object.fromEntries(SETUP_FIELDS[card]
                .filter((key) => typeof fields[key] === 'string')
                .map((key) => [key, fields[key]]))
            }
          }
          const out = await this.#daemon({ method: 'POST', path: '/setup', body, accept: [200, 400] })
          if (out.ok === false) throw refuse(out.error)
          return out
        })
      }
      // The Full loop's press and retry (#882). The press names at most a
      // covered repository and a ticket number, both shaped here; the daemon
      // reads its own gate and refuses a closed one. The answer is the run.
      if (url.pathname === '/api/setup/full-loop' || url.pathname === '/api/setup/full-loop/retry') {
        return this.#write(res, async () => {
          const b = await this.#body(req)
          const body = {}
          if (!url.pathname.endsWith('/retry')) {
            if (typeof b.repo === 'string' && b.repo) {
              if (!/^[\w.-]+\/[\w.-]+$/.test(b.repo)) throw refuse(`"${b.repo.slice(0, 60)}" is not a repository`)
              body.repo = b.repo
            }
            if (b.ticket !== undefined && b.ticket !== null && b.ticket !== '') {
              const n = Number(b.ticket)
              if (!Number.isInteger(n) || n <= 0) throw refuse(`"${String(b.ticket).slice(0, 40)}" is not a ticket number`)
              body.ticket = n
            }
          }
          const out = await this.#daemon({ method: 'POST', path: url.pathname.replace('/api', ''), body, accept: [200, 400], timeout: SETUP_TIMEOUT_MS })
          if (out.ok === false) throw refuse(out.error)
          return out
        })
      }
      // The Discord card (#876). Two writes, each composed here out of the
      // fields it names and nothing else. The token crosses once, to the
      // daemon, which lands it in its secret file; this surface holds no copy
      // and its answers and logs never carry it. The daemon's refusal is the
      // sentence the page shows.
      if (url.pathname === '/api/setup/discord/token') {
        return this.#write(res, async () => {
          const b = await this.#body(req)
          if (typeof b.token !== 'string' || !DISCORD_TOKEN_RE.test(b.token)) throw refuse('That is not the shape a Discord bot token takes. Copy the token from the Bot page of your application, with no spaces around it.')
          const userId = field(b.user_id, SNOWFLAKE_RE, 'a Discord user ID')
          const out = await this.#daemon({ method: 'POST', path: '/setup/discord/token', body: { token: b.token, user_id: userId }, accept: [200, 400], timeout: SETUP_TIMEOUT_MS })
          if (out.ok === false) throw refuse(out.error)
          return out
        })
      }
      if (url.pathname === '/api/setup/discord/channel') {
        return this.#write(res, async () => {
          const b = await this.#body(req)
          const guildId = field(b.guild_id, SNOWFLAKE_RE, 'a Discord server id')
          const channel = field(b.channel, CHANNEL_NAME_RE, 'a Discord channel name')
          const out = await this.#daemon({ method: 'POST', path: '/setup/discord/channel', body: { guild_id: guildId, channel }, accept: [200, 400], timeout: SETUP_TIMEOUT_MS })
          if (out.ok === false) throw refuse(out.error)
          return out
        })
      }
      // The Tailscale card (#877). The one write is the confirmation, composed
      // here as the login Serve stamped on THIS request beside the node name
      // the page sent: the browser cannot name who becomes the operator, only
      // agree that it is the identity it arrived with, and the node's name
      // is the card's one field (#891), which the daemon checks and applies.
      // The allowlist is read back from the daemon at once, so the next
      // request is admitted by the record and not by the window.
      if (url.pathname === '/api/setup/tailscale/operator') {
        return this.#write(res, async () => {
          const b = await this.#body(req)
          const login = String(req.headers[LOGIN_HEADER] ?? '').toLowerCase()
          if (!login) throw refuse('This request carried no Tailscale identity. Open the Curia app through its Tailscale address, then confirm again.')
          const body = { login, ...(typeof b.machine_name === 'string' ? { machine_name: b.machine_name.trim() } : {}) }
          const out = await this.#daemon({ method: 'POST', path: '/setup/tailscale/operator', body, accept: [200, 400], timeout: SETUP_TIMEOUT_MS })
          if (out.ok === false) throw refuse(out.error)
          await this.refreshIdentity()
          return out
        })
      }
      // The OpenAI half of the model card (#878). The one write starts the
      // subscription sign-in the daemon already runs (`codex login
      // --device-auth` in a tmux session), and it carries no field at all:
      // there is nothing a browser can name about that login, and no key
      // it could paste. The daemon answers the panel read, and the page
      // polls it for the link and the code.
      if (url.pathname === '/api/setup/openai/login') {
        return this.#write(res, async () => {
          await this.#body(req)
          const out = await this.#daemon({ method: 'POST', path: '/setup/openai/login', body: {}, accept: [200, 400], timeout: SETUP_TIMEOUT_MS })
          if (out.ok === false) throw refuse(out.error)
          return out
        })
      }
      // The Anthropic half (#879), the same press: it starts the `claude
      // setup-token` session the daemon already runs and carries no field.
      if (url.pathname === '/api/setup/anthropic/login') {
        return this.#write(res, async () => {
          await this.#body(req)
          const out = await this.#daemon({ method: 'POST', path: '/setup/anthropic/login', body: {}, accept: [200, 400], timeout: SETUP_TIMEOUT_MS })
          if (out.ok === false) throw refuse(out.error)
          return out
        })
      }
      // The aistack registration (#706), in three presses: start the device
      // flow, stop waiting for it, and grant the standing permission once the
      // machine exists.
      //
      // The browser sends only the Action identity it minted. Each route still
      // decides the command, pinned CLI version, HOME, and server on this box.
      // There is no field through which a browser can name any of those.
      if (url.pathname === '/api/aistack/register' || url.pathname === '/api/aistack/cancel'
        || url.pathname === '/api/aistack/optin') {
        const act = url.pathname.slice('/api/aistack/'.length)
        return this.#write(res, async () => {
          const b = await this.#body(req)
          const actionId = field(b.action_id, ACTION_ID_RE, 'an Action id')
          const out = await this.#daemon({
            method: 'POST', path: `/aistack/${act}`, body: { action_id: actionId }, accept: [200, 409],
            timeout: AISTACK_ACT_TIMEOUT_MS,
          })
          if (out.ok === false) {
            const error = refuse(out.error)
            if (out.action) error.receipt = { action: out.action }
            throw error
          }
          return out
        })
      }
      if (url.pathname === '/api/console/new') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const actionId = field(b.action_id, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/, 'an Action id')
          return this.#daemon({ method: 'POST', path: '/console/new', body: { action_id: actionId } })
        })
      }
      if (url.pathname === '/api/console/delete') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const key = field(b.key, CONSOLE_KEY_RE, 'a browser conversation key')
          const actionId = field(b.action_id, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/, 'an Action id')
          const out = await this.#daemon({
            method: 'POST', path: '/console/delete', body: { key, action_id: actionId }, accept: [200, 409, 500],
          })
          return out
        })
      }
      return this.#json(res, 404, { error: `no route ${url.pathname} on the dashboard` })
    }

    if (req.method !== 'GET') return this.#json(res, 405, { error: 'this surface answers GET and POST' })

    // The chat page and its event stream (#267). `/chat` serves the timeline's
    // own page — the daemon re-reads and stamp-checks it per request, so the
    // bytes the console hands out are the ones the daemon agreed to serve.
    if (url.pathname === CHAT_PAGE) {
      const session = String(url.searchParams.get('session') ?? '')
      const hash = VERB_SESSION_RE.test(session) ? `#chat/${session}` : '#chat'
      res.writeHead(303, { location: `/${hash}`, 'cache-control': 'no-store' })
      return res.end()
    }
    if (CHAT_ROUTES.has(url.pathname)) return this.#chat(req, res, url.pathname + url.search)

    if (url.pathname === '/api/overview') {
      return this.payload().then(
        (p) => this.#json(res, 200, { ...p, operator: String(req.headers[LOGIN_HEADER] ?? '').toLowerCase() }),
        (e) => this.#json(res, 500, { error: e.message }),
      )
    }
    if (url.pathname === '/api/github-app/complete') {
      const q = new URLSearchParams()
      q.set('code', String(url.searchParams.get('code') ?? ''))
      q.set('state', String(url.searchParams.get('state') ?? ''))
      return this.#daemon({ path: `/github-app/complete?${q}`, accept: [200, 400] }).then(
        (out) => {
          if (out.error) return this.#json(res, 400, out)
          res.writeHead(303, { location: out.screen === 'setup' ? '/#setup' : '/#settings' })
          res.end()
        },
        (e) => this.#json(res, 500, { error: e.message }),
      )
    }
    if (url.pathname === '/api/search') {
      const query = String(url.searchParams.get('q') ?? '').trim()
      if (!query || query.length > 200) {
        return this.#json(res, 400, { error: 'a search query must contain 1 to 200 characters' })
      }
      const q = new URLSearchParams({ q: query })
      return this.#daemon({ path: `/search?${q}` }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { query, results: null, errors: [{ source: 'daemon', error: e.message }] }),
      )
    }
    // The diff, on demand (#355). Never from the poll snapshot and never on the
    // poll at all: a gate's digest already rides `/overview`, and everything
    // this route answers costs a git call the operator asked for by opening a
    // card.
    //
    // Two fields, and this side names the shape of both. The browser names an
    // escalation id and a file only by its index into the digest curia itself
    // produced — so no path, no repo, no branch and no command crosses this
    // wire.
    if (url.pathname === '/api/diff') {
      let q
      try {
        q = new URLSearchParams()
        q.set('esc', field(url.searchParams.get('esc'), VERB_ESC_RE, 'an escalation id'))
        if (url.searchParams.has('file')) q.set('file', field(url.searchParams.get('file'), VERB_FILE_RE, 'a file index'))
      } catch (e) {
        return this.#json(res, 400, { error: e.message })
      }
      return this.#daemon({ path: `/diff?${q}`, accept: [200, 400, 404], timeout: DIFF_TIMEOUT_MS }).then(
        (r) => this.#json(res, 200, r),
        // A daemon that cannot be reached says so as data, the way the fleet
        // does: the card then states that curia could not be asked, rather
        // than drawing a file list with nothing in it.
        (e) => this.#json(res, 200, { digest: null, hunks: null, error: e.message }),
      )
    }
    // The browser conversations (#333). Read only while the Chat screen is
    // open, and never from the poll snapshot: a row costs a transcript read on
    // the daemon side, so the list stays off the poll every other screen
    // shares. An unreachable daemon answers a null list rather than an empty
    // one, for the reason the fleet does: "curia could not be asked" and "you
    // have no conversations" are opposite facts.
    if (url.pathname === '/api/console') {
      return this.#daemon({ path: '/console' }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { conversations: null, error: e.message }),
      )
    }
    // Read fresh off disk every time, never from the poll snapshot: these two
    // files are hand-edited on the box as well as written here, and a settings
    // screen that showed a cached copy would offer to save over an edit it
    // never saw.
    if (url.pathname === '/api/settings') {
      return this.#readSettings().then(
        (settings) => this.#json(res, 200, settings),
        (e) => this.#json(res, 500, { error: e.message }),
      )
    }
    // Integration setup (#874): the record and the four cards, each verified
    // on this read. Straight from the daemon, which holds the verifiers and
    // the secret files they check. A daemon that cannot be asked answers null
    // cards with the reason: "curia could not verify" and "nothing is
    // connected" are opposite facts, and the frame says which.
    if (url.pathname === '/api/setup') {
      return this.#daemon({ path: '/setup', timeout: SETUP_TIMEOUT_MS }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { step: null, progress: null, cards: null, full_loop: null, error: e.message }),
      )
    }
    // The Full loop's run (#882), as the daemon reads it off the journal. A
    // daemon that cannot be asked answers a null state with the reason.
    if (url.pathname === '/api/setup/full-loop') {
      return this.#daemon({ path: '/setup/full-loop', timeout: SETUP_TIMEOUT_MS }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { state: null, legs: null, error: e.message }),
      )
    }
    // The Discord card's own read (#876): the token by presence, the bot, its
    // servers, and the safe facts, straight from the daemon. Never the token.
    if (url.pathname === '/api/setup/discord') {
      return this.#daemon({ path: '/setup/discord', timeout: SETUP_TIMEOUT_MS }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { secret: null, settings: null, bot: null, guilds: [], invite_url: null, error: e.message }),
      )
    }
    // The OpenAI half of the model card's own read (#878): the credential by
    // presence, the live sign-in's link and code, and routing readiness,
    // straight from the daemon. Never a token.
    if (url.pathname === '/api/setup/openai') {
      return this.#daemon({ path: '/setup/openai', timeout: SETUP_TIMEOUT_MS }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { provider: 'openai', secret: null, identity: null, login: null, ending: null, said: null, routing: null, error: e.message }),
      )
    }
    // The Anthropic half's own read (#879): the credential by presence, the
    // live sign-in's link, and routing readiness. Never a token.
    if (url.pathname === '/api/setup/anthropic') {
      return this.#daemon({ path: '/setup/anthropic', timeout: SETUP_TIMEOUT_MS }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { provider: 'anthropic', secret: null, credential: null, login: null, ending: null, said: null, routing: null, error: e.message }),
      )
    }
    // The Tailscale card's own read (#877): the identity Serve stamped on this
    // request, passed to the daemon by name so the panel can show who opened
    // the app, beside the node, the record, and the private address.
    if (url.pathname === '/api/setup/tailscale') {
      const login = String(req.headers[LOGIN_HEADER] ?? '').toLowerCase()
      return this.#daemon({ path: `/setup/tailscale?login=${encodeURIComponent(login)}`, timeout: SETUP_TIMEOUT_MS }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { requester: login || null, operator: null, node: null, serve: null, app_url: null, first_operator: null, error: e.message }),
      )
    }
    // The aistack registration and the sync verdict (#706). Straight from the
    // daemon, which is the process that holds the credential and spawns the
    // CLI. The sidecar relays and adds nothing: it holds no secret (#263) and
    // this answer deliberately carries none either.
    if (url.pathname === '/api/aistack') {
      return this.#daemon({ path: '/aistack' }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { ok: false, error: e.message }),
      )
    }
    // The update panel's read (#883): the installed and recommended
    // versions, update availability, release notes, a withdrawal warning,
    // and the daily check's last result. The daemon keeps the check and its
    // record; the sidecar relays and adds nothing. A daemon that cannot be
    // asked is unknown, never "up to date".
    if (url.pathname === '/api/update') {
      return this.#daemon({ path: '/update' }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { managed: null, installed: null, error: e.message }),
      )
    }
    // The repos the operator could watch. The sidecar holds no GitHub
    // credential — that is what #263 means by secret-free — so the list comes
    // from the daemon, which already holds the `gh` login every dispatch uses.
    if (url.pathname === '/api/repos') {
      return this.#daemon({ path: '/repos' }).then(
        (r) => this.#json(res, 200, r),
        (e) => this.#json(res, 200, { login: null, repos: null, error: e.message }),
      )
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Re-read per request, and refused on the same terms the reconcile
      // assert uses: there is no build step, so the file on disk IS the
      // reviewed source, and a page this server does not speak is not served.
      const refusal = pageRefusal(this.index)
      if (refusal) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(`${refusal}\n`)
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(fs.readFileSync(this.index))
    }
    return this.#json(res, 404, { error: `no route ${url.pathname} on the dashboard` })
  }
}

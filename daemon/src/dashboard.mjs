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
import { assertServe, serveOff, attachBase } from './attach.mjs'
import { identityRefusal, readAllow, serveHosts, tailnetSelf, LOGIN_HEADER } from './identity.mjs'
import { readSettings, saveSettings } from './settings.mjs'
// The two config layers (#292). config.mjs imports readDashboard from this file
// in turn; both edges are runtime calls, never module-level ones.
import { readLayered } from './config.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

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
// Bumped to 5 by #355: the gate card and the agent row both read `/api/diff`,
// which a proto-4 sidecar does not serve — so an old server must refuse this
// page rather than draw a digest whose every file answers 404.
// Bumped to 6 by #642: the attention list draws the credentials the daemon now
// owns, and the device link and one-time code of a login in flight. A proto-5
// sidecar serves an `/overview` with no `credentials` section at all, so the
// card would render empty at the one moment it is the only thing that matters.
export const DASHBOARD_PROTO = 6
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
  return { dashboard, allow, timelinePort: readTimelinePort(cfg, fail) }
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

// The one read that may leave the box (#355). Hunks come from the worktree in
// milliseconds, and from `gh pr diff` over the network when the worktree is
// gone — so this waits longer than the poll does, on a card the operator opened
// and is watching.
export const DIFF_TIMEOUT_MS = 30_000

// The biggest settings patch this surface will read. The screen writes a watch
// list and a handful of numbers, so anything near this is not a settings save.
export const MAX_BODY = 256 * 1024

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

function field(value, re, what) {
  const s = String(value ?? '').trim()
  if (!re.test(s)) throw refuse(`"${s}" is not ${what}`)
  return s
}
function words(value, what) {
  const s = String(value ?? '').trim()
  if (!s) throw refuse(`${what} with no words is not ${what}`)
  if (s.length > MAX_WORDS) throw refuse(`${what} may not exceed ${MAX_WORDS} characters`)
  return s
}

// The chat (#267). The console does not draw a chat of its own and it does not
// frame one: it SERVES the timeline, under its own address, and hands the four
// routes that page speaks straight through to the daemon.
//
//   browser ──Serve(:8445)──> sidecar ──> daemon timeline(:4272)
//
// Nothing is rewritten on the way. The Host and the operator's login travel as
// they arrived, so the timeline applies the #151 predicate in-process to the
// evidence the browser actually sent — the sidecar carries the bytes and
// vouches for nothing. The daemon's own host allowlist admits this surface's
// name, which is what makes that pass (index.mjs resolveServeHosts).
export const CHAT_PAGE = '/chat'
const CHAT_ROUTES = new Set(['/events', '/send', '/draft', '/key'])

export class DashboardSurface {
  constructor({
    port, servePort, index, allow, daemonPort: dPort = daemonPort(),
    pollIntervalS = DEFAULT_DASHBOARD.poll_interval_s,
    curiaFile = null, routingFile = null, timelinePort = null,
    log = console.log, deps = {},
  }) {
    this.port = port
    // Where the timeline listens on loopback. Null means this sidecar was
    // started against a config with no timeline block, and the chat says so.
    this.timelinePort = timelinePort
    this.servePort = servePort
    this.index = index
    // The two files the settings screen writes (#265). They are the only
    // writable thing in this container: #263's mount list gives it `config/`
    // read-write and everything else read-only.
    this.curiaFile = curiaFile
    this.routingFile = routingFile
    this.daemonPort = dPort
    this.pollIntervalMs = pollIntervalS * 1000
    this.pollIntervalS = pollIntervalS
    this.log = log
    // Created empty and filled in place, exactly as index.mjs does it: the
    // request handler holds a live reference, so a tailscale answer that
    // arrives after the listener is up is picked up without rewiring. Empty
    // means refuse — a surface that does not know its own name admits nobody.
    this.allow = new Set(allow ?? [])
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
    return identityRefusal(req.headers, { allow: this.allow, hosts: this.hosts })
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
  #body(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) {
          req.destroy()
          return reject(new Error(`a settings save may not exceed ${MAX_BODY} bytes`))
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
          return this.#json(res, 409, { error: e.message, refused: true })
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
  async #reload(by) {
    try {
      const out = await this.#daemon({ method: 'POST', path: '/reload', body: { by } })
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
    const before = readSettings({ curiaFile: this.curiaFile, routingFile: this.routingFile }).watch
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

  // The command seam (#33 step 9), reached with text this file composed. Every
  // verb that has a word in the operator's own catalogue goes through it rather
  // than around it, so a press from the console journals the same `command`
  // event a typed one does and lands in the feed for free.
  #command(text, by) {
    return this.#daemon({ method: 'POST', path: '/command', body: { text, by } })
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

  #handle(req, res) {
    const reason = this.#refusal(req)
    if (reason) {
      this.log(`dashboard: REFUSED ${req.url} — ${reason}`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(`curia refused this request: ${reason}\n`)
    }
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`)

    if (req.method === 'POST') {
      const crossSite = this.#crossSite(req)
      if (crossSite) {
        this.log(`dashboard: REFUSED ${req.method} ${req.url} — ${crossSite}`)
        return this.#json(res, 403, { error: crossSite })
      }
      // The chat's three writes (#267): the composer, the shared draft and the
      // key the timeline page sends. They pass the cross-site check above like
      // every other write here, and the timeline applies its own on top.
      if (CHAT_ROUTES.has(url.pathname)) return this.#chat(req, res, url.pathname + url.search)
      // The save (#265). The sidecar writes the file itself: it holds the only
      // read-write mount in this container, and #249 put the edit here so that
      // a config the daemon refuses to boot on can still be fixed from the page
      // while the daemon is down.
      if (url.pathname === '/api/settings') {
        return this.#write(res, async () => {
          if (!this.curiaFile || !this.routingFile) throw new Error('this sidecar was started without config file paths, so it cannot save')
          const patch = await this.#body(req)
          await this.#guardWatchRemoval(patch)
          const out = saveSettings({ curiaFile: this.curiaFile, routingFile: this.routingFile, patch })
          // The save APPLIES (#362). The daemon re-reads both files and takes
          // every setting this screen writes, so the restart stops being
          // phase two of every save. A save that wrote nothing asks for
          // nothing: the file did not move, so there is nothing to reload.
          const reload = out.written.length
            ? await this.#reload(String(req.headers[LOGIN_HEADER] ?? '') || 'dashboard')
            : null
          this.log(out.written.length
            ? `dashboard: saved ${out.written.join(' and ')} — ${reloadLine(reload)}`
            : 'dashboard: the save changed nothing')
          return { ...out, reload, settings: readSettings({ curiaFile: this.curiaFile, routingFile: this.routingFile }) }
        })
      }
      // The restart (#249 item 6). The sidecar orders it and the daemon does
      // it: POST /restart journals the request and exits nonzero, and the
      // supervisor respawns. Nothing here waits for the daemon to come back —
      // the page's own marker is what says whether it has.
      if (url.pathname === '/api/restart') {
        return this.#write(res, async () => {
          const out = await this.#daemon({ method: 'POST', path: '/restart', body: { by: 'dashboard' } })
          this.log('dashboard: the daemon took the restart order')
          // The next page read must not be answered from a snapshot taken
          // before the restart: it would say the daemon is up for as long as
          // the interval lasts, at the one moment that is false.
          this.snapshotAt = 0
          return out
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
          return this.#command(`start ${repo}#${ticket}`, by)
        })
      }

      // Cancel. The page confirms it with its consequences before it presses;
      // this is the immediate teardown, the same one `cancel <n>` runs from the
      // command channel. NOT the interpreted cancel: that opens a Discord
      // confirm card, and a button press in the console is already the
      // operator's own act, typed by nobody's model.
      if (url.pathname === '/api/cancel') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const ticket = field(b.ticket, VERB_TICKET_RE, 'a ticket number')
          return this.#command(`cancel ${ticket}`, by)
        })
      }

      // Teleport. `attach <n>` composes the timeline link and the terminal link
      // from curia's own records (#68), which is why the press asks for them
      // rather than the page building a URL it cannot vouch for.
      if (url.pathname === '/api/teleport') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const ticket = field(b.ticket, VERB_TICKET_RE, 'a ticket number')
          return this.#command(`attach ${ticket}`, by)
        })
      }

      // An answer, for an escalation or for the review gate — one route,
      // because they are one act. First-valid-wins and supersede are the
      // reduction's, so an answer that arrives second comes back 409 with the
      // reason, and the page says which.
      if (url.pathname === '/api/answer') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const id = field(b.id, VERB_ESC_RE, 'an escalation id')
          const answer = words(b.answer, 'an answer')
          const out = await this.#daemon({
            method: 'POST', path: '/answer', body: { id, answer, by, via: 'dashboard' }, accept: [200, 409],
          })
          if (out.ok === false) throw refuse(ANSWER_REFUSAL[out.reason] ?? `that question is ${out.reason}`)
          return out
        })
      }

      // A note to one agent, in either delivery mode (ADR-0013). Queued is the
      // default and rides the agent's next tool result; interrupt is #252's
      // second mode, and its refusals are the daemon's.
      if (url.pathname === '/api/note') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const agent = field(b.agent, VERB_SESSION_RE, 'a curia session name')
          const text = words(b.text, 'a note')
          const mode = b.mode === 'interrupt' ? 'interrupt' : 'queue'
          return this.#daemon({ method: 'POST', path: '/note', body: { agent, text, mode, by } })
        })
      }
      // The browser conversations (#333). The Chat screen mints one and
      // deletes one, and both are composed here out of a shape this file names:
      // `new` sends no field at all, and `delete` sends one key this side
      // validates before the daemon validates it again.
      if (url.pathname === '/api/console/new') {
        return this.#verb(res, () => this.#daemon({ method: 'POST', path: '/console/new' }))
      }
      if (url.pathname === '/api/console/delete') {
        return this.#verb(res, async () => {
          const b = await this.#body(req)
          const key = field(b.key, CONSOLE_KEY_RE, 'a browser conversation key')
          const out = await this.#daemon({ method: 'POST', path: '/console/delete', body: { key }, accept: [200, 409] })
          if (out.ok === false) throw refuse(out.error)
          return out
        })
      }
      return this.#json(res, 404, { error: `no route ${url.pathname} on the dashboard` })
    }

    if (req.method !== 'GET') return this.#json(res, 405, { error: 'this surface answers GET and POST' })

    // The chat page and its event stream (#267). `/chat` serves the timeline's
    // own page — the daemon re-reads and stamp-checks it per request, so the
    // bytes the console hands out are the ones the daemon agreed to serve.
    if (url.pathname === CHAT_PAGE) return this.#chat(req, res, '/')
    if (CHAT_ROUTES.has(url.pathname)) return this.#chat(req, res, url.pathname + url.search)

    if (url.pathname === '/api/overview') {
      return this.payload().then(
        (p) => this.#json(res, 200, p),
        (e) => this.#json(res, 500, { error: e.message }),
      )
    }
    // The diff, on demand (#355). Never from the poll snapshot and never on the
    // poll at all: a gate's digest already rides `/overview`, and everything
    // this route answers costs a git call the operator asked for by opening a
    // card.
    //
    // Three fields, and this side names the shape of every one. The daemon
    // resolves the worktree; the browser names an escalation id or an agent,
    // and a file only by its index into the digest curia itself produced — so
    // no path, no repo, no branch and no command crosses this wire.
    if (url.pathname === '/api/diff') {
      let q
      try {
        q = new URLSearchParams()
        if (url.searchParams.has('esc')) q.set('esc', field(url.searchParams.get('esc'), VERB_ESC_RE, 'an escalation id'))
        if (url.searchParams.has('agent')) q.set('agent', field(url.searchParams.get('agent'), VERB_SESSION_RE, 'a curia session name'))
        if (url.searchParams.has('file')) q.set('file', field(url.searchParams.get('file'), VERB_FILE_RE, 'a file index'))
        if (!q.has('esc') && !q.has('agent')) throw refuse('name a review gate or an agent to read a diff for')
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
      if (!this.curiaFile || !this.routingFile) return this.#json(res, 500, { error: 'this sidecar was started without config file paths' })
      try {
        return this.#json(res, 200, readSettings({ curiaFile: this.curiaFile, routingFile: this.routingFile }))
      } catch (e) {
        return this.#json(res, 500, { error: e.message })
      }
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

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
// THE POLL IS DEMAND-DRIVEN, and that is the answer to the cost #262 stated.
// `GET /overview` reads the whole journal off disk, and the journal grows
// without bound. So the sidecar refreshes only when a page asks and the
// snapshot it holds is older than the interval. A browser polls while its tab
// is visible and stops when it is hidden, which makes a forgotten tab cost
// nothing. Many tabs collapse to one read: the age check answers them all, and
// one in-flight refresh is shared.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { assertServe, serveOff, attachBase } from './attach.mjs'
import { identityRefusal, readAllow, serveHosts, tailnetSelf } from './identity.mjs'

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
export const DASHBOARD_PROTO = 1
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
  // The one decision #263 owns. Every refresh reads the whole journal off disk
  // through `dispatcher.status()`, and once more per open review gate through
  // the pull-request lookup, so this number IS that read rate while a tab is
  // open. It is paused entirely while none is.
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
  const fail = (msg) => { throw new Error(`bad config ${file}: ${msg}`) }
  const cfg = parse(fs.readFileSync(file, 'utf8'))
  if (!cfg || typeof cfg !== 'object') fail('not a mapping')
  const dashboard = readDashboard(cfg, fail, file)
  if (!fs.existsSync(dashboard.index)) {
    fail(`dashboard.index resolves to ${dashboard.index}, which does not exist — it ships committed in daemon/assets/`)
  }
  const allow = readAllow(cfg.identity, fail)
  return { dashboard, allow }
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

export class DashboardSurface {
  constructor({
    port, servePort, index, allow, daemonPort: dPort = daemonPort(),
    pollIntervalS = DEFAULT_DASHBOARD.poll_interval_s,
    log = console.log, deps = {},
  }) {
    this.port = port
    this.servePort = servePort
    this.index = index
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

  // One loopback GET. No Origin header: the daemon's whole loopback surface
  // refuses any request carrying one, and the sidecar is loopback tooling, not
  // a browser.
  #fetchOverview() {
    if (this.deps.fetchOverview) return this.deps.fetchOverview()
    return new Promise((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1', port: this.daemonPort, path: '/overview',
        headers: { accept: 'application/json' },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) return reject(new Error(`the daemon answered ${res.statusCode} on /overview`))
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(new Error(`the daemon's /overview is not JSON: ${e.message}`))
          }
        })
      })
      req.setTimeout(POLL_TIMEOUT_MS, () => req.destroy(new Error(`the daemon did not answer /overview within ${POLL_TIMEOUT_MS / 1000}s`)))
      req.on('error', reject)
    })
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

  #handle(req, res) {
    const reason = this.#refusal(req)
    if (reason) {
      this.log(`dashboard: REFUSED ${req.url} — ${reason}`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(`curia refused this request: ${reason}\n`)
    }
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`)
    if (req.method !== 'GET') return this.#json(res, 405, { error: 'this surface reads; it does not write' })

    if (url.pathname === '/api/overview') {
      return this.payload().then(
        (p) => this.#json(res, 200, p),
        (e) => this.#json(res, 500, { error: e.message }),
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

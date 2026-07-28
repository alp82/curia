// Preview links (#40, implementing #8's scheme "B1"): one HTTPS Serve port per
// preview, allocated by the DAEMON — not by the worker — from a configured
// range, proxying a dev server the worker runs on localhost.
//
//   worker: npm run dev                  (binds SOME localhost address — see localhostTarget)
//   daemon: publish_preview(port, path)  -> tailscale serve --bg --https=<serve-port> http://<target>:<dev-port>
//   human:  https://<box>.<tailnet>.ts.net:<serve-port><path>
//
// Why the daemon allocates: a worker choosing its own Serve port would collide
// with other workers and with the attach rule, and — the sharper reason —
// `tailscale serve` publishes ANY localhost port to the whole tailnet. The
// daemon's own MCP/REST surface (/answer, /command, /escalate) is a localhost
// port. So "publish this port" is a privileged request from an agent that may
// be confused or wrong, and the registry is where that is contained:
//
//   - reserved ports are refused outright (the daemon's own port, the ttyd
//     port, the attach Serve port) — publishing the daemon port would hand the
//     escalation-answer surface to the tailnet with no auth at all;
//   - the dev port must be a LIVE localhost listener, so a worker cannot
//     reserve a rule pointing at a port something else may bind later;
//   - the Serve port comes from the configured range only, never from the
//     worker.
//
// State posture (#9): the registry is an ephemeral cache. The durable truth is
// tailscaled's own serve config, which SURVIVES daemon restarts — so a rule
// outlives the process that made it, and reconcile must re-derive and sweep
// (the same orphan discipline as the tmux sweep in #33/#19).

import net from 'node:net'
import { execFileP } from './exec.mjs'

export const DEFAULT_RANGE = { from: 8500, to: 8599 }

// `tailscale serve status --json` shape, verified live on this host:
//   { "TCP": { "8443": { "HTTPS": true } },
//     "Web": { "host:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:7681" } } } } }
// Returns Map<servePort, proxyTarget>. A shape we do not recognise yields an
// empty map rather than a throw — an unreadable status must not take the
// daemon down, and every caller treats "unknown" conservatively.
export function parseServedPorts(status) {
  const out = new Map()
  const web = status?.Web
  if (!web || typeof web !== 'object') return out
  for (const [hostPort, entry] of Object.entries(web)) {
    const port = Number(String(hostPort).split(':').pop())
    if (!Number.isInteger(port)) continue
    const proxy = entry?.Handlers?.['/']?.Proxy ?? null
    out.set(port, proxy)
  }
  return out
}

function dial(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
}

// Which localhost address is the dev server ACTUALLY on? Returns the host to
// put in the Serve rule, or null if nothing answers on either family.
//
// "localhost" is not one address. Vite (verified on v8 in both demo repos)
// binds `[::1]` and NOT 127.0.0.1 unless told otherwise, so probing only IPv4
// refused a dev server that was plainly running — the worker was told "start
// the dev server first" right after it had, with no way to tell what curia
// actually wanted. Whatever answers is what the rule must point at.
//
// The IPv6 case yields `localhost`, not `[::1]`: tailscale's target parser does
// not handle a bracketed literal — `http://[::1]:3099` is stored as
// `http://::1:3099` and the proxy then 500s (verified live). `localhost`
// resolves at dial time inside tailscaled and reaches the same listener.
// IPv4 stays an explicit 127.0.0.1 so the common case carries no resolution
// ambiguity at all.
export async function localhostTarget(port, { timeout = 750 } = {}) {
  if (await dial('127.0.0.1', port, timeout)) return '127.0.0.1'
  if (await dial('::1', port, timeout)) return 'localhost'
  return null
}

// The PAGE to look at, not just the site (#68). `publish_preview` used to take a
// port and nothing else, so the only link curia could compose pointed at the dev
// server's root — and in #65's re-run all three review gates sent Alp to an
// untouched homepage while the work lived on `/curia-check`. He sent the ticket
// back, and the worker then routed around curia by putting the real URL in its
// own prose: exactly the worker-asserted string the gate exists so as not to
// depend on (#54, #40).
//
// The path is a DISPLAY suffix on a rule that is already allocated. It grants no
// reach the Serve rule does not already have — the rule proxies the whole dev
// server either way — so it needs no new refusal for reach. It needs one for
// what it must not smuggle: a host or a scheme would move the gate's own link
// off this box, which is the one property that makes a daemon-composed link
// worth more than a worker's word.
//
// Resolution decides that, rather than a pattern: anything that moves the origin
// is refused whatever syntax it arrived in — `//evil.com/x` (protocol-relative),
// `https://evil.com/x`, `\\evil.com` (a backslash is a slash to the URL parser),
// and `box.ts.net:8500/x`, which parses as a SCHEME. Everything surviving that
// is a path on this preview, and `..` in it can only ever resolve back to `/`.
const PATH_ORIGIN = 'https://preview.invalid'
const PATH_LIMIT = 512

export function normalizePreviewPath(input) {
  if (input === undefined || input === null || input === '') return { ok: true, path: '/' }
  if (typeof input !== 'string') {
    return { ok: false, reason: `path must be a string (got ${JSON.stringify(input)})` }
  }
  if (input.length > PATH_LIMIT) {
    return { ok: false, reason: `path is longer than ${PATH_LIMIT} characters` }
  }
  if (/[\s\u0000-\u001f\u007f]/.test(input)) {
    return { ok: false, reason: `path must hold no spaces or control characters — percent-encode them (got ${JSON.stringify(input)})` }
  }
  let url
  try {
    url = new URL(input, PATH_ORIGIN)
  } catch {
    return { ok: false, reason: `path is not a usable URL path (got ${JSON.stringify(input)})` }
  }
  if (url.origin !== PATH_ORIGIN) {
    return {
      ok: false,
      reason: `path must be a path on this preview, not a host or a scheme (got ${JSON.stringify(input)}) — pass something like "/some/page"`,
    }
  }
  return { ok: true, path: `${url.pathname}${url.search}${url.hash}` }
}

export function previewUrl(base, servePort, path = '/') {
  const suffix = String(path ?? '/')
  return `https://${base}:${servePort}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
}

export class PreviewRegistry {
  // `reserved` is the set of localhost ports a preview may never point AT.
  constructor({
    range = DEFAULT_RANGE,
    reserved = [],
    exec = execFileP,
    isLive = localhostTarget,
    log = console.log,
  } = {}) {
    this.range = range
    this.reserved = new Set(reserved.filter((p) => Number.isInteger(p)))
    this.exec = exec
    this.isLive = isLive
    this.log = log
    this.byTicket = new Map() // ticket -> { servePort, devPort } — ephemeral (#9)
  }

  get(ticket) {
    return this.byTicket.get(String(ticket)) ?? null
  }

  list() {
    return [...this.byTicket.entries()].map(([ticket, v]) => ({ ticket, ...v }))
  }

  inRange(port) {
    return port >= this.range.from && port <= this.range.to
  }

  // Live serve rules straight from tailscaled — the durable side of the state.
  // Throws on an unreadable status: callers decide, because "no rules" and "I
  // could not ask" must never collapse into the same answer (the recurring bug
  // class #33's review killed four times).
  async servedPorts() {
    const { stdout } = await this.exec('tailscale', ['serve', 'status', '--json'], { maxBuffer: 8 * 1024 * 1024 })
    return parseServedPorts(JSON.parse(stdout))
  }

  #refuse(reason) {
    return { ok: false, reason }
  }

  // Allocate + publish. Idempotent per ticket: a repeat call for the same dev
  // port returns the existing allocation rather than burning a second port.
  async publish(ticket, devPort, { base, path: rawPath } = {}) {
    const key = String(ticket)
    if (!Number.isInteger(devPort) || devPort < 1 || devPort > 65535) {
      return this.#refuse(`dev port must be a port number (got ${JSON.stringify(devPort)})`)
    }
    if (this.reserved.has(devPort)) {
      return this.#refuse(`refusing to publish port ${devPort} — it is one of curia's own surfaces (daemon API, ttyd, attach), and publishing it would expose it to the whole tailnet`)
    }
    const norm = normalizePreviewPath(rawPath)
    if (!norm.ok) return this.#refuse(norm.reason)
    const path = norm.path

    // Re-publishing the same dev port reuses the allocation — but it MOVES the
    // path, because correcting a wrong link is the whole reason a worker calls
    // this twice. Returning the stale URL here would reinstate #68 one call in.
    const existing = this.byTicket.get(key)
    if (existing && existing.devPort === devPort) {
      const entry = { ...existing, path, url: previewUrl(base, existing.servePort, path) }
      this.byTicket.set(key, entry)
      return { ok: true, ...entry, reused: true }
    }
    const target = await this.isLive(devPort)
    if (!target) {
      return this.#refuse(`nothing is listening on port ${devPort} — probed both 127.0.0.1 and [::1]. Start the dev server first, then publish (a rule pointing at a dead port would publish whatever binds it next)`)
    }

    let served
    try {
      served = await this.servedPorts()
    } catch (e) {
      return this.#refuse(`could not read tailscale serve status (${e.message}) — refusing to allocate blind`)
    }

    const taken = new Set([...served.keys(), ...[...this.byTicket.values()].map((v) => v.servePort)])
    let servePort = null
    for (let p = this.range.from; p <= this.range.to; p += 1) {
      if (!taken.has(p)) { servePort = p; break }
    }
    if (servePort === null) {
      return this.#refuse(`no free preview port in ${this.range.from}-${this.range.to} (${taken.size} in use)`)
    }

    // If this ticket already had a different dev port, withdraw the stale rule
    // rather than leaking it — serve config outlives the process.
    if (existing) await this.#serveOff(existing.servePort).catch(() => {})

    await this.exec('tailscale', ['serve', '--bg', `--https=${servePort}`, `http://${target}:${devPort}`])
    // The URL is kept on the entry, not only returned: the review gate (#54)
    // shows the human the preview link, and it must be the link this registry
    // actually allocated rather than a string a worker handed over. Resolving
    // the tailnet name again there would mean a second `tailscale` call inside a
    // blocking tool.
    const url = previewUrl(base, servePort, path)
    this.byTicket.set(key, { servePort, devPort, target, path, url })
    this.log(`preview for ticket ${key}: ${url} -> ${target}:${devPort}`)
    return { ok: true, servePort, devPort, target, path, url, reused: false }
  }

  // "handler does not exist" is POSITIVE ABSENCE, not a failed withdrawal —
  // same classification rule as attach.mjs's serveOff.
  async #serveOff(servePort) {
    try {
      await this.exec('tailscale', ['serve', `--https=${servePort}`, 'off'])
    } catch (e) {
      if (/handler does not exist/i.test(`${e?.message ?? ''}\n${e?.stderr ?? ''}`)) return
      throw e
    }
  }

  async withdraw(ticket) {
    const key = String(ticket)
    const entry = this.byTicket.get(key)
    if (!entry) return { ok: true, withdrawn: false }
    try {
      await this.#serveOff(entry.servePort)
    } catch (e) {
      // Keep the entry: an un-withdrawn rule is still published, and dropping
      // the record here would make the next sweep the only thing that could
      // ever find it.
      this.log(`WARNING: preview rule for ticket ${key} on :${entry.servePort} REMAINS PUBLISHED — withdrawal failed: ${e.message}`)
      return { ok: false, reason: e.message }
    }
    this.byTicket.delete(key)
    return { ok: true, withdrawn: true, servePort: entry.servePort }
  }

  // Orphan sweep (#19's lesson, #33's discipline): `tailscale serve --bg`
  // config persists in tailscaled across daemon restarts, so a rule can easily
  // outlive both the worker and the process that published it. Anything in our
  // range that no live ticket claims is withdrawn.
  //
  // `liveTickets` must be positively known. An indeterminate serve status
  // aborts the sweep rather than withdrawing everything.
  async sweep(liveTickets) {
    const live = new Set([...liveTickets].map(String))
    let served
    try {
      served = await this.servedPorts()
    } catch (e) {
      this.log(`preview sweep skipped — could not read serve status: ${e.message}`)
      return { swept: [], skipped: true }
    }

    // Drop cache entries for tickets that are gone, and remember their ports.
    const swept = []
    for (const [ticket, entry] of [...this.byTicket]) {
      if (!live.has(ticket)) {
        await this.#serveOff(entry.servePort).catch((e) => this.log(`preview withdraw for ${ticket} failed: ${e.message}`))
        this.byTicket.delete(ticket)
        swept.push({ servePort: entry.servePort, ticket })
      }
    }

    // Rules in our range that no cache entry claims are orphans from a previous
    // process — the case the in-memory pass structurally cannot see.
    const claimed = new Set([...this.byTicket.values()].map((v) => v.servePort))
    for (const port of served.keys()) {
      if (!this.inRange(port) || claimed.has(port)) continue
      await this.#serveOff(port).catch((e) => this.log(`orphan preview withdraw on :${port} failed: ${e.message}`))
      this.log(`swept orphan preview rule on :${port} (no live ticket claims it)`)
      swept.push({ servePort: port, ticket: null })
    }
    return { swept, skipped: false }
  }
}

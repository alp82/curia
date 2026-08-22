// Preview links (#40, implementing #8's scheme "B1"): one HTTPS Serve port per
// preview, allocated by the DAEMON — not by the agent — from a configured
// range, proxying a dev server the agent runs on localhost.
//
//   agent: npm run dev                  (binds SOME localhost address — see localhostTarget)
//   daemon: publish_preview(port, path)  -> tailscale serve --bg --https=<serve-port> http://<target>:<dev-port>
//   human:  https://<box>.<tailnet>.ts.net:<serve-port><path>
//
// A SANDBOXED agent (#156) runs the dev server inside its container, and the
// daemon reaches it only through one of the three host ports that container
// publishes — so #157 gives `publish` a second shape, picked by whether the
// caller has published ports:
//
//   agent: npm run dev -- --host 0.0.0.0 --port 9000   (inside the container)
//   docker: 127.0.0.1:9000 -> container 9000
//   daemon: the rule points at 127.0.0.1:9000, as it always did
//
// Why the daemon allocates: an agent choosing its own Serve port would collide
// with other agents and with the attach rule, and — the sharper reason —
// `tailscale serve` publishes ANY localhost port to the whole tailnet. The
// daemon's own MCP/REST surface (/answer, /command, /escalate) is a localhost
// port. So "publish this port" is a privileged request from an agent that may
// be confused or wrong, and the registry is where that is contained:
//
//   - reserved ports are refused outright (the daemon's own port, the ttyd
//     port, the attach Serve port) — publishing the daemon port would hand the
//     escalation-answer surface to the tailnet with no auth at all;
//   - the dev port must be the agent's own: one of the three ports its
//     container publishes, or — on the bare path, until #158 retires it — a
//     LIVE localhost listener, so an agent cannot reserve a rule pointing at a
//     port something else may bind later;
//   - the Serve port comes from the configured range only, never from the
//     agent.
//
// State posture (#563): the registry entries persist in the daemon data dir.
// The identity proxies stay process-local. Boot recovery probes each live dev
// server, reopens its proxy, and reasserts its Serve rule before the orphan
// sweep. Tailscaled's config still supplies the orphan evidence for rules that
// no persisted live ticket claims.
//
// #168 put the identity check (#151, ADR-0011) in front of this surface too —
// the third and last thing curia publishes through Serve, and the one ADR-0011
// named as still open. Until then a preview was gated on tailnet membership
// alone, which is the posture #151 ended on the terminal and the timeline.
//
//   before:  tailnet ──Serve(:8501)──────────────────────> dev server(:9000)
//   after:   tailnet ──Serve(:8501)──> proxy(:7701) ─────> dev server(:9000)
//
// Three things decided the shape, and the first was the operator's: a preview
// is HIS ALONE, never shown to anyone else. So `identity.allow` serves all
// three surfaces, and reaching one preview from another's rule is not an
// escalation. That killed the shared-router design — it would have had to pick
// a preview out of the `Host` header, which Serve passes through verbatim
// (#151 fact 4), and with one list there is nothing to buy by paying that.
//
// So: ONE PROXY PER LIVE PREVIEW, which is IdentityProxy used exactly as attach
// uses it, and no routing code anywhere. The bill is six idle listeners at
// `agents.max_concurrent`, and the proxy port is DERIVED rather than allocated —
// `identity.preview_proxy_from` pairs index-for-index with the preview range, so
// the preview on 8501 always proxies through 7701, greppable in `ss -ltn` on the
// box. A rule pointing at a proxy port also makes an ORPHAN rule harmless: the
// old shape left a stale rule aimed at a docker-published port something else
// could still be binding, and this one aims it at a dead loopback listener.
//
// Fail-closed in three places, the same posture attach runs under:
//
//   1. publish  — the proxy must bind and the host set must be non-empty before
//                 the serve rule is written. Neither holds, publish refuses and
//                 the agent gets the cause. Publishing anyway would put back
//                 exactly what this ticket closed.
//   2. sweep    — a live entry whose proxy stopped listening has its rule
//                 withdrawn, rather than left published over an un-gated port.
//   3. caller   — a 403 naming the reason, journalled `preview_identity_refused`.

import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFileP } from './exec.mjs'
import { IdentityProxy, serveHosts, tailnetSelf } from './identity.mjs'

export const DEFAULT_RANGE = { from: 8500, to: 8599 }
// Paired index-for-index with DEFAULT_RANGE. Clear of ttyd (7681) and the
// attach identity proxy (7682), and config.mjs checks it against every other
// port and range this box uses rather than trusting these numbers.
export const DEFAULT_PROXY_FROM = 7700

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
// refused a dev server that was plainly running — the agent was told "start
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
// back, and the agent then routed around curia by putting the real URL in its
// own prose: exactly the agent-asserted string the gate exists so as not to
// depend on (#54, #40).
//
// The path is a DISPLAY suffix on a rule that is already allocated. It grants no
// reach the Serve rule does not already have — the rule proxies the whole dev
// server either way — so it needs no new refusal for reach. It needs one for
// what it must not smuggle: a host or a scheme would move the gate's own link
// off this box, which is the one property that makes a daemon-composed link
// worth more than an agent's word.
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

// The publish probe (#239): one HTTP GET at the page the link will open, with
// the same rewritten Host the proxy forwards — so publish verifies what the
// OPERATOR will see, not just that a socket accepts. The dial check cannot do
// this, and on a published container port it proves nothing at all (#157):
// docker-proxy accepts for the container's whole life, then RESETS when nothing
// is bound inside — which used to reach the operator as a bare 502 at the link.
//
// What the answer means:
//   - any HTTP status  -> an app answered. The status is carried back to the
//     agent, never judged here: a 404 on the stated path is the agent's to fix,
//     and refusing on it would break every app that 302s or 401s its own root.
//   - a socket error   -> no app will answer the operator either. Refused.
//   - a timeout        -> NOT death. A dev server compiling its first page can
//     take longer than any polite probe waits, so this passes with `slow`.
export function probePreviewPage(target, port, { path = '/', timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: target, port, path, headers: { host: `${target}:${port}` }, timeout },
      (res) => {
        res.resume()
        resolve({ ok: true, status: res.statusCode })
      },
    )
    req.on('timeout', () => { req.destroy(); resolve({ ok: true, status: null, slow: true }) })
    req.on('error', (e) => resolve({ ok: false, error: e.code ?? e.message }))
    req.end()
  })
}

export function previewUrl(base, servePort, path = '/') {
  const suffix = String(path ?? '/')
  return `https://${base}:${servePort}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
}

export class PreviewRegistry {
  // `reserved` is the set of localhost ports a preview may never point AT. The
  // derived proxy block is NOT in it and does not need to be: the arithmetic
  // lives here, so #refuseProxyBlock checks the whole block without index.mjs
  // enumerating a hundred numbers into a Set.
  constructor({
    range = DEFAULT_RANGE,
    reserved = [],
    exec = execFileP,
    isLive = localhostTarget,
    log = console.log,
    // #168. `allow` is the SAME set index.mjs hands the attach proxy and the
    // timeline — one list for all three surfaces, by the operator's call.
    allow = new Set(),
    proxyFrom = DEFAULT_PROXY_FROM,
    self = tailnetSelf,
    Proxy = IdentityProxy,
    probe = probePreviewPage,
    journal = () => {},
    dataDir = null,
  } = {}) {
    this.range = range
    this.reserved = new Set(reserved.filter((p) => Number.isInteger(p)))
    this.exec = exec
    this.isLive = isLive
    this.log = log
    this.allow = allow
    this.proxyFrom = proxyFrom
    this.self = self
    this.Proxy = Proxy
    this.probe = probe
    this.journal = journal
    this.stateFile = dataDir ? path.join(dataDir, 'previews.json') : null
    this.byTicket = new Map()
    this.proxies = new Map() // IdentityProxy instances stay process-local.
  }

  #persist() {
    if (!this.stateFile) return
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(this.list(), null, 2)}\n`)
    fs.renameSync(temporary, this.stateFile)
  }

  #readPersistedEntries() {
    if (!this.stateFile) return []
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      return Array.isArray(value) ? value : []
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`preview recovery ignored unreadable state: ${e.message}`)
      return []
    }
  }

  // The pairing. One line, deliberately, because every other part of the design
  // reads it: the sweep, the reserved-block refusal and the box's own `ss` output.
  proxyPortFor(servePort) {
    return this.proxyFrom + (servePort - this.range.from)
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
  //
  // `published` is the caller's own container ports (#157), or null for a bare
  // agent. It is the whole bound where it is present: a sandboxed agent can
  // reach the host on those three ports and on nothing else, so a fourth number
  // is a mistake to name rather than a port to probe.
  async publish(ticket, devPort, { base, path: rawPath, published = null } = {}) {
    const key = String(ticket)
    if (!Number.isInteger(devPort) || devPort < 1 || devPort > 65535) {
      return this.#refuse(`dev port must be a port number (got ${JSON.stringify(devPort)})`)
    }
    if (this.reserved.has(devPort)) {
      return this.#refuse(`refusing to publish port ${devPort} — it is one of curia's own surfaces (daemon API, ttyd, attach), and publishing it would expose it to the whole tailnet`)
    }
    // #168: the derived proxy block is curia's own too, and it is the one
    // reserved range that grows and shrinks with the previews themselves.
    // Pointing a rule at another preview's PROXY would publish that preview on
    // a second port whose Host the proxy does not answer to — every caller
    // refused, and a surface silently double-listed. Same fault the reserved
    // list already catches for identity.proxy_port, one range along.
    const proxyTo = this.proxyPortFor(this.range.to)
    if (devPort >= this.proxyFrom && devPort <= proxyTo) {
      return this.#refuse(`refusing to publish port ${devPort} — ${this.proxyFrom}-${proxyTo} is curia's own preview identity-proxy block, one port per live preview`)
    }
    if (published && !published.includes(devPort)) {
      return this.#refuse(`port ${devPort} is not one of your published ports (${published.join(', ')}) — your dev server runs inside a container, and those are the only ports this box can reach it on. Bind it to 0.0.0.0 on one of them, then publish that port`)
    }
    const norm = normalizePreviewPath(rawPath)
    if (!norm.ok) return this.#refuse(norm.reason)
    const path = norm.path

    // Re-publishing the same dev port reuses the allocation — but it MOVES the
    // path, because correcting a wrong link is the whole reason an agent calls
    // this twice. Returning the stale URL here would reinstate #68 one call in.
    const existing = this.byTicket.get(key)
    if (existing && existing.devPort === devPort) {
      // #239: the moved path gets the same probe a fresh publish gets — a
      // repeat call is exactly the fix-the-link call, so handing back a link
      // nobody verified would reinstate the fault one call in. A dead server
      // refuses the MOVE and leaves the standing allocation alone: the rule and
      // its gate are still published, and the sweep owns their teardown.
      const p = await this.probe(existing.target, devPort, { path })
      if (!p.ok) {
        return this.#refuse(this.#probeReason(devPort, p, Boolean(published)))
      }
      const entry = { ...existing, path, url: previewUrl(base, existing.servePort, path) }
      this.byTicket.set(key, entry)
      this.#persist()
      return { ok: true, ...entry, reused: true, probeStatus: p.status ?? null }
    }
    // The published-port case skips the probe, because on a published port the
    // probe cannot answer the question any more. docker binds the host port for
    // the container's whole life — a `docker-proxy` on 127.0.0.1:<p>, measured
    // on docker 29.6.2 and on the box's 20.10.17 — so a connect succeeds whether
    // or not the agent ever started a server, and even when it bound `localhost`
    // INSIDE the container, where the proxy accepts and then resets. A probe that
    // always says "live" is not a weaker check, it is a false one; the allocation
    // is the real check, and the human's own eyes are what find a dead page.
    //
    // It also answers what the probe answered second: which address the rule
    // points at. docker publishes on 127.0.0.1 by name (see sandbox.mjs), so
    // there is no address family left to discover.
    let target = '127.0.0.1'
    if (!published) {
      target = await this.isLive(devPort)
      if (!target) {
        return this.#refuse(`nothing is listening on port ${devPort} — probed both 127.0.0.1 and [::1]. Start the dev server first, then publish (a rule pointing at a dead port would publish whatever binds it next)`)
      }
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
    if (existing) {
      const withdrawn = await this.withdraw(key)
      if (!withdrawn.ok) {
        return this.#refuse(`could not withdraw the existing preview on port ${existing.servePort} (${withdrawn.reason}) — the existing preview stays published`)
      }
    }

    // #168: the gate goes up BEFORE the rule, and a gate that will not go up
    // refuses the publish. The order is the whole fail-closed property — a rule
    // written first and gated second is an un-gated dev server on the tailnet
    // for as long as the second step takes, and forever if it fails.
    // #239: before anything is published, ask the app the question the link
    // will ask — a GET at the stated page, carrying the Host the proxy will
    // forward. This is where the container case gets its first real liveness
    // check: the dial probe was dropped there because docker-proxy always
    // accepts (#157), but it cannot fake an HTTP RESPONSE, so a dev server that
    // is absent or bound to localhost inside the container refuses here with
    // the cause, instead of publishing the 502 the operator used to find.
    const page = await this.probe(target, devPort, { path })
    if (!page.ok) {
      return this.#refuse(this.#probeReason(devPort, page, Boolean(published)))
    }

    const gate = await this.#openGate(servePort, target, devPort)
    if (!gate.ok) return this.#refuse(gate.reason)

    // The rule points at the PROXY now, never at the dev server. That also
    // makes an orphaned rule harmless: it aims at a loopback port that dies
    // with the daemon, where the old shape aimed it at a docker-published port
    // something else could still be binding.
    await this.exec('tailscale', ['serve', '--bg', `--https=${servePort}`, `http://127.0.0.1:${gate.proxyPort}`])
    // The URL is kept on the entry, not only returned: the review gate (#54)
    // shows the human the preview link, and it must be the link this registry
    // actually allocated rather than a string an agent handed over. Resolving
    // the tailnet name again there would mean a second `tailscale` call inside a
    // blocking tool.
    const url = previewUrl(base, servePort, path)
    this.byTicket.set(key, { servePort, devPort, target, path, url, proxyPort: gate.proxyPort })
    this.#persist()
    this.log(`preview for ticket ${key}: ${url} -> proxy :${gate.proxyPort} -> ${target}:${devPort} (page answered ${page.slow ? 'slowly — probe timed out' : `HTTP ${page.status}`})`)
    return { ok: true, servePort, devPort, target, path, url, proxyPort: gate.proxyPort, reused: false, probeStatus: page.status ?? null }
  }

  // The words a failed page probe hands the agent. The two socket errors mean
  // different things on the two workspace shapes, and the container one names
  // the fix (#157's known silent failure): docker accepted the connection, so
  // the dev server inside is absent or bound to localhost.
  #probeReason(devPort, p, sandboxed) {
    const cause = p.error ?? 'no HTTP response'
    if (sandboxed) {
      return `the dev server on port ${devPort} accepted no HTTP request (${cause}) — your server runs inside a container, so it must bind 0.0.0.0:${devPort}, not localhost. Fix the bind, check the server is still up, then publish again`
    }
    return `the dev server on port ${devPort} accepted no HTTP request (${cause}) — check the server is still running, then publish again`
  }

  // Stand up this preview's identity proxy. Returns the port the serve rule must
  // point at, or the reason the preview cannot be published at all.
  //
  // Both legs are POSITIVE checks, ADR-0011's inversion of the reconcile rule:
  // there an open question must not take a surface down, here an open question
  // must not let a caller in. A box that cannot say its own name admits nobody,
  // so a preview it cannot name is a preview it must not publish.
  async #openGate(servePort, target, devPort) {
    let hosts
    try {
      hosts = serveHosts({ ...(await this.self()), servePort })
    } catch (e) {
      return { ok: false, reason: `could not resolve this box's tailnet names (${e.message}) — refusing to publish a preview the identity check cannot verify` }
    }
    if (!hosts.size) {
      return { ok: false, reason: 'this box resolved no tailnet name for the preview rule — refusing to publish a surface that cannot verify its own name' }
    }
    const proxyPort = this.proxyPortFor(servePort)
    const proxy = new this.Proxy({
      port: proxyPort,
      targetHost: target,
      targetPort: devPort,
      allow: this.allow,
      hosts,
      surface: 'preview',
      // #239: the tailnet Host has done its one job (the identity check) by the
      // time the proxy forwards, and framework dev servers refuse it — Vite's
      // allowedHosts block page, delivered as the review-gate link. The proxy
      // forwards the dev server's own name instead. Preview only: attach keeps
      // the true Host because ttyd's -O compares Origin against it.
      rewriteHost: true,
      name: `the dev server behind this preview`,
      log: this.log,
      journal: this.journal,
    })
    const { verified } = await proxy.start()
    if (!verified) {
      return { ok: false, reason: `the preview identity proxy could not bind 127.0.0.1:${proxyPort} — refusing to publish an un-gated dev server to the tailnet` }
    }
    this.proxies.set(servePort, proxy)
    return { ok: true, proxyPort: proxy.port }
  }

  #stopProxy(servePort) {
    const proxy = this.proxies.get(servePort)
    if (!proxy) return
    proxy.stop()
    this.proxies.delete(servePort)
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

  async #withdrawEntry(ticket, entry, failureMessage) {
    try {
      await this.#serveOff(entry.servePort)
    } catch (e) {
      this.log(failureMessage(e))
      return { ok: false, reason: e.message }
    }
    this.#stopProxy(entry.servePort)
    this.byTicket.delete(ticket)
    return { ok: true }
  }

  async #withdrawRecoveredEntry(ticket, entry, reason) {
    this.byTicket.set(ticket, entry)
    return await this.#withdrawEntry(ticket, entry, (e) => (
      `WARNING: preview recovery kept the entry for ticket ${ticket} after ${reason} — withdrawal failed: ${e.message}`
    ))
  }

  async recover(liveTickets) {
    const live = new Set([...liveTickets].map(String))
    const entries = this.#readPersistedEntries()
    const probes = await Promise.all(entries.map(async (entry) => ({
      entry,
      page: live.has(String(entry.ticket))
        ? await this.probe(entry.target, entry.devPort, { path: entry.path })
        : null,
    })))
    const recovered = []
    const dropped = []
    for (const { entry, page } of probes) {
      const ticket = String(entry.ticket)
      const { ticket: _persistedTicket, ...preview } = entry
      if (!live.has(ticket) || !page?.ok || page.slow) {
        const reason = !live.has(ticket) ? 'the ticket stopped' : 'the dev server did not answer'
        if ((await this.#withdrawRecoveredEntry(ticket, preview, reason)).ok) dropped.push(ticket)
        continue
      }
      const gate = await this.#openGate(preview.servePort, preview.target, preview.devPort)
      if (!gate.ok) {
        if ((await this.#withdrawRecoveredEntry(ticket, preview, 'the identity proxy did not start')).ok) dropped.push(ticket)
        continue
      }
      try {
        await this.exec('tailscale', ['serve', '--bg', `--https=${preview.servePort}`, `http://127.0.0.1:${gate.proxyPort}`])
      } catch (e) {
        this.log(`preview recovery for ${ticket} failed: ${e.message}`)
        const current = { ...preview, proxyPort: gate.proxyPort }
        if ((await this.#withdrawRecoveredEntry(ticket, current, 'the Serve rule did not start')).ok) dropped.push(ticket)
        continue
      }
      this.byTicket.set(ticket, { ...preview, proxyPort: gate.proxyPort })
      recovered.push(ticket)
    }
    this.#persist()
    return { recovered, dropped }
  }

  async withdraw(ticket) {
    const key = String(ticket)
    const entry = this.byTicket.get(key)
    if (!entry) return { ok: true, withdrawn: false }
    const withdrawn = await this.#withdrawEntry(key, entry, (e) => {
      // Keep the entry: an un-withdrawn rule is still published, and dropping
      // the record here would make the next sweep the only thing that could
      // ever find it. #168 adds the sharper half — the PROXY stays up too. A
      // rule that is still published must keep its gate, or the failure to
      // withdraw becomes the un-gated dev server this ticket closed.
      return `WARNING: preview rule for ticket ${key} on :${entry.servePort} REMAINS PUBLISHED — withdrawal failed: ${e.message}`
    })
    if (!withdrawn.ok) {
      return { ok: false, reason: withdrawn.reason }
    }
    this.#persist()
    return { ok: true, withdrawn: true, servePort: entry.servePort }
  }

  // Orphan sweep (#19's lesson, #33's discipline): `tailscale serve --bg`
  // config persists in tailscaled across daemon restarts, so a rule can easily
  // outlive both the agent and the process that published it. Anything in our
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
        const withdrawn = await this.#withdrawEntry(
          ticket, entry, (e) => `preview withdraw for ${ticket} failed: ${e.message}`,
        )
        if (!withdrawn.ok) continue
        swept.push({ servePort: entry.servePort, ticket })
        continue
      }
      // #168, the verified→unverified flip: attach re-checks its proxy on every
      // /attach request, and a preview has no such path — nobody asks curia for
      // a link a second time, the human just opens the one they were given. So
      // the sweep is where a live preview's gate is re-checked, and a gate that
      // stopped listening takes the RULE down with it rather than leaving it
      // published over a port with no check in front of it any more.
      //
      // `listening` is this process's own boolean, so there is no failed read to
      // classify here. That is why the fail-closed direction is safe to take.
      if (!this.proxies.get(entry.servePort)?.listening) {
        this.log(`WARNING: the identity proxy for ticket ${ticket}'s preview on :${entry.servePort} is not listening — withdrawing the rule rather than leaving the dev server un-gated`)
        this.journal('preview_gate_lost', { ticket, servePort: entry.servePort, proxyPort: entry.proxyPort ?? null })
        const withdrawn = await this.#withdrawEntry(
          ticket, entry, (e) => `preview withdraw for ${ticket} failed: ${e.message}`,
        )
        if (!withdrawn.ok) continue
        swept.push({ servePort: entry.servePort, ticket, ungated: true })
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
    this.#persist()
    return { swept, skipped: false }
  }
}

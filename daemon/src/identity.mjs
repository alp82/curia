// The identity check in front of both attach surfaces (#151) — the standing
// pre-production requirement ADR-0003 booked and #74 restated when it landed a
// SECOND writable surface under the same deferral.
//
// What was actually open, stated plainly: the only gate on the terminal and the
// timeline was tailnet membership. Session names are public GitHub issue
// numbers, so `wss://<box>:8443/ws?arg=curia-151` is guessable, and ttyd's -O
// stops a BROWSER on another origin only — a non-browser client on the tailnet
// (curl, websocat) sets Origin to whatever it likes. Any tailnet node could
// therefore drive a bypassPermissions worker, and read every transcript on the
// timeline beside it.
//
// The closure rides Tailscale Serve's own identity headers. Measured live on
// this box (docs/live-checks/151-attach-surface-auth.md), four facts decide the
// design:
//
//   1. Serve injects `Tailscale-User-Login` on every proxied request.
//   2. A client that FORGES that header has it OVERWRITTEN by Serve. It is not
//      spoofable from the tailnet — which is what makes it an identity rather
//      than another client assertion like Origin.
//   3. The header rides the WebSocket UPGRADE too, so it reaches the drive
//      path, not just the page load.
//   4. Serve passes a forged `Host` through VERBATIM. That is exactly the
//      residual hole -O leaves, confirmed rather than reasoned about — so Host
//      is client-controlled input here and gets an allowlist of its own.
//
// The boundary this does NOT move: a process on the box itself reaches
// 127.0.0.1:7681 and 127.0.0.1:4272 directly, bypassing Serve, and can set any
// header it likes (fact 4's sibling, also measured). Loopback on this box is
// already inside the trust boundary — workers share the host credential store
// (ADR-0007) and the tmux socket (ADR-0003) — so this is recorded, not chased.

import http from 'node:http'
import { execFileP } from './exec.mjs'

// Node lowercases incoming header names, so these are the keys as they arrive.
export const LOGIN_HEADER = 'tailscale-user-login'
export const FUNNEL_HEADER = 'tailscale-funnel-request'

// The predicate. Returns a refusal reason, or null when the caller may drive.
//
// Fail-closed by construction: every leg must be POSITIVELY satisfied. This is
// the opposite of the classification rule the reconcile reads run under ("a
// failed read is not evidence, so do not refuse") and deliberately so — there,
// an open question must not take a surface DOWN; here, an open question must
// not let a caller IN.
export function identityRefusal(headers = {}, { allow, hosts } = {}) {
  // Funnel is the public internet. No curia surface is ever for it, and Serve
  // marks such a request rather than leaving it to be inferred.
  if (headers[FUNNEL_HEADER] !== undefined) {
    return 'this surface is tailnet-only and the request arrived over Funnel'
  }
  // Host is client-controlled (fact 4), so it is checked against the names this
  // box actually answers to. This is what closes the DNS-rebinding shape that
  // -O cannot: a rebinding page sends a Host of the attacker's own name, which
  // is not in the set.
  const host = String(headers.host ?? '').toLowerCase()
  if (!hosts?.size) return 'the served-host allowlist is empty — the surface cannot verify its own name'
  if (!hosts.has(host)) return `Host "${headers.host ?? ''}" is not a name this box serves`
  // Absent means the request did not come through Serve. On a loopback-bound
  // listener that means a local process, which is inside the boundary but is
  // not an identity — so it is refused here and reaches ttyd directly if it
  // really is the operator.
  const login = headers[LOGIN_HEADER]
  if (!login) {
    return `no ${LOGIN_HEADER} header — the request did not arrive through Tailscale Serve`
  }
  if (!allow?.size) return 'the identity allowlist is empty — no caller can be admitted'
  if (!allow.has(String(login).toLowerCase())) {
    return `"${login}" is not on the attach identity allowlist`
  }
  return null
}

// Every name this box legitimately answers to on `servePort`. The FQDN is what
// curia's own composed links use; the MagicDNS short name and the raw tailnet
// IPs are added because an operator types those by hand and none of them can be
// an attacker-controlled DNS name — so admitting them costs no rebinding
// protection.
export function serveHosts({ dnsName, ips = [], servePort }) {
  const set = new Set()
  const add = (h) => set.add(`${h}:${servePort}`.toLowerCase())
  const fqdn = String(dnsName ?? '').replace(/\.$/, '')
  if (fqdn) {
    add(fqdn)
    const short = fqdn.split('.')[0]
    if (short && short !== fqdn) add(short)
  }
  for (const ip of ips) add(ip.includes(':') ? `[${ip}]` : ip)
  return set
}

// The box's own tailnet names, from tailscale itself — never hardcoded, the
// same rule attachBase() follows. Cached: the node's name and addresses do not
// change under a running daemon, and every request would otherwise shell out.
let cachedSelf = null
export async function tailnetSelf({ exec = execFileP } = {}) {
  if (!cachedSelf) {
    const { stdout } = await exec('tailscale', ['status', '--json'], { maxBuffer: 8 * 1024 * 1024 })
    const self = JSON.parse(stdout)?.Self
    if (!self?.DNSName) throw new Error('tailscale status carries no Self.DNSName')
    cachedSelf = { dnsName: self.DNSName.replace(/\.$/, ''), ips: self.TailscaleIPs ?? [] }
  }
  return cachedSelf
}

export function resetTailnetSelfCache() {
  cachedSelf = null
}

// ---------------------------------------------------------------------------
// The identity proxy: the terminal surface's half
// ---------------------------------------------------------------------------
//
// The timeline is the daemon's own HTTP server, so it applies identityRefusal
// in-process. ttyd is a C process we do not own, so the check needs somewhere
// to live: this loopback proxy goes between Serve and ttyd.
//
//   tailnet ──Serve(:8443)──> identity proxy(:7682) ──> ttyd(:7681)
//
// ttyd keeps every flag it had. -O and the loopback bind stay load-bearing
// (ADR-0003), and the Host header is forwarded UNCHANGED so -O still compares
// what it always compared. The proxy adds a gate in front; it removes nothing.
export class IdentityProxy {
  constructor({ port, targetPort, allow, hosts, log = console.log, journal = () => {} }) {
    this.port = port
    this.targetPort = targetPort
    this.allow = allow
    this.hosts = hosts
    this.log = log
    this.journal = journal
    this.server = null
    this.listening = false
  }

  #refusal(req) {
    return identityRefusal(req.headers, { allow: this.allow, hosts: this.hosts })
  }

  // One record per refusal, on the journal and in the log. #75's lesson: the
  // first fact that goes unrecorded is the one nobody can grep for afterwards.
  // A refused attach is rare by nature, so this does not flood.
  #record(req, reason, path) {
    this.journal('attach_identity_refused', {
      reason,
      path,
      host: req.headers.host ?? null,
      login: req.headers[LOGIN_HEADER] ?? null,
    })
    this.log(`attach: REFUSED ${path} — ${reason}`)
  }

  // Bind the loopback listener. A port that will not bind leaves the surface
  // unverified, and the CALLER must then keep the serve rule withdrawn — the
  // same rule ensureTtyd and the timeline already run under: only a listener
  // that is positively ours is ever published.
  start() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.#request(req, res))
      server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head))
      server.once('error', (e) => {
        this.log(`WARNING: the attach identity proxy could not bind 127.0.0.1:${this.port} (${e.message}) — the terminal surface is DOWN and will not be published`)
        this.journal('attach_proxy_bind_failed', { port: this.port, error: e.message })
        this.listening = false
        resolve({ verified: false })
      })
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server
        this.port = server.address().port // resolves port 0 (tests bind ephemerally)
        this.listening = true
        this.log(`attach identity proxy on http://127.0.0.1:${this.port} → ttyd :${this.targetPort}`)
        resolve({ verified: true })
      })
    })
  }

  stop() {
    this.server?.close()
    this.server = null
    this.listening = false
  }

  #request(req, res) {
    const reason = this.#refusal(req)
    if (reason) {
      this.#record(req, reason, req.url)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(`curia refused this request: ${reason}\n`)
    }
    const up = http.request(
      { host: '127.0.0.1', port: this.targetPort, method: req.method, path: req.url, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers)
        upRes.pipe(res)
      },
    )
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`the terminal surface is not answering on :${this.targetPort} (${e.message})\n`)
    })
    req.pipe(up)
  }

  // The WebSocket half — the one that matters, because /ws IS the drive path.
  // Fact 3 is what makes this possible at all: the identity header rides the
  // upgrade, so the same predicate decides here.
  #upgrade(req, socket, head) {
    const reason = this.#refusal(req)
    if (reason) {
      this.#record(req, reason, `${req.url} (upgrade)`)
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\ncuria refused this request: ${reason}\n`)
      return
    }
    const up = http.request({
      host: '127.0.0.1',
      port: this.targetPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
      for (const [k, v] of Object.entries(upRes.headers)) {
        for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      // Both `head` buffers are bytes already read past the handshake, so they
      // belong to the POST-upgrade stream on the far side — not to the request
      // body. Writing `head` into the ClientRequest instead would inject the
      // client's first WebSocket frame into ttyd's request and lose it.
      if (upHead?.length) socket.write(upHead)
      if (head?.length) upSocket.write(head)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    // ttyd answered the upgrade with a normal response (a 4xx, say): pass it
    // back rather than leaving the client hanging on a socket nobody speaks on.
    up.on('response', (upRes) => {
      socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\nconnection: close\r\n\r\n`)
      upRes.pipe(socket)
    })
    up.on('error', (e) => {
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\nthe terminal surface is not answering on :${this.targetPort} (${e.message})\n`)
    })
    up.end()
  }
}

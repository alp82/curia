// The identity check in front of both attach surfaces (#151).
//
// The header names and behaviours these tests pin were MEASURED on the
// deployment box, not assumed — docs/live-checks/151-attach-surface-auth.md
// holds the transcript. What is unit-testable here is that the daemon acts on
// them: refuse a caller Serve did not stamp, refuse a Host this box does not
// answer to, and never let either past on the WebSocket upgrade, which is the
// path that actually drives an agent.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  identityRefusal, serveHosts, hostsForPorts, IdentityProxy, LOGIN_HEADER, FUNNEL_HEADER,
} from '../src/identity.mjs'
import { TimelineSurface, DEFAULT_TIMELINE_INDEX } from '../src/timeline.mjs'

// `fetch` forbids setting Host, and Host is exactly what these tests must vary
// (fact 4: Serve passes a forged one through verbatim). node's own client with
// setHost:false is the only way to send the header a rebinding client sends.
function req(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, setHost: false }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => resolve({ status: res.statusCode, text: buf, headers: res.headers }))
    })
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

const ALLOW = new Set(['alp@example.com'])
const HOSTS = serveHosts({ dnsName: 'box.tail1234.ts.net.', ips: ['100.98.118.33', 'fd7a:115c::1'], servePort: 8443 })

// What Tailscale Serve actually puts on a request it proxies (fact 1).
const served = (extra = {}) => ({
  host: 'box.tail1234.ts.net:8443',
  [LOGIN_HEADER]: 'alp@example.com',
  ...extra,
})

describe('serveHosts: every name this box legitimately answers to (#151)', () => {
  test('the FQDN, the MagicDNS short name and both raw tailnet IPs, all with the serve port', () => {
    assert.deepEqual([...HOSTS].sort(), [
      '100.98.118.33:8443',
      '[fd7a:115c::1]:8443',
      'box.tail1234.ts.net:8443',
      'box:8443',
    ].sort())
  })

  test('the trailing dot tailscale reports on DNSName never reaches the set', () => {
    assert.ok(!([...HOSTS].some((h) => h.includes('.:'))))
  })

  test('a different serve port is a different set — the timeline cannot be reached on the terminal name', () => {
    const tl = serveHosts({ dnsName: 'box.tail1234.ts.net', ips: [], servePort: 8444 })
    assert.ok(tl.has('box.tail1234.ts.net:8444'))
    assert.ok(!tl.has('box.tail1234.ts.net:8443'))
  })

  // #267: the chat is the timeline, reached through the console's own address,
  // so the timeline answers to two published ports now. It is still a closed
  // set of names this box owns — which is the whole thing this check buys.
  test('hostsForPorts admits every port that proxies to one surface, and nothing else', () => {
    const self = { dnsName: 'box.tail1234.ts.net', ips: ['100.98.118.33'] }
    const hosts = hostsForPorts(self, [8444, 8445])
    assert.ok(hosts.has('box.tail1234.ts.net:8444'), 'its own published port')
    assert.ok(hosts.has('box.tail1234.ts.net:8445'), 'and the console that serves the chat')
    assert.ok(hosts.has('box:8445'), 'the short name on both')
    assert.ok(hosts.has('100.98.118.33:8444'))
    assert.ok(!hosts.has('box.tail1234.ts.net:8443'), 'never a port nobody proxies from')
    assert.ok(!hosts.has('evil.example:8445'), 'and never a name this box does not answer to')
  })
})

describe('identityRefusal: fail-closed, every leg positive (#151)', () => {
  test('a request Serve stamped, on a name this box serves, is admitted', () => {
    assert.equal(identityRefusal(served(), { allow: ALLOW, hosts: HOSTS }), null)
  })

  test('no identity header ⇒ refused: the request did not come through Serve', () => {
    const r = identityRefusal({ host: 'box.tail1234.ts.net:8443' }, { allow: ALLOW, hosts: HOSTS })
    assert.match(r, /did not arrive through Tailscale Serve/)
  })

  test('a login off the allowlist is refused by name', () => {
    const r = identityRefusal(served({ [LOGIN_HEADER]: 'mallory@example.com' }), { allow: ALLOW, hosts: HOSTS })
    assert.match(r, /mallory@example\.com.*not on the identity allowlist/)
  })

  test('the login compares case-insensitively — an IdP may change the casing', () => {
    assert.equal(identityRefusal(served({ [LOGIN_HEADER]: 'ALP@Example.COM' }), { allow: ALLOW, hosts: HOSTS }), null)
  })

  // The DNS-rebinding shape, which is exactly what ttyd's -O cannot catch:
  // Serve passes a forged Host through verbatim (measured, fact 4), so Origin
  // and Host match EACH OTHER and -O is satisfied. The name allowlist is what
  // refuses it.
  test('a Host this box does not serve is refused even with a valid identity', () => {
    const r = identityRefusal(served({ host: 'evil.example.com' }), { allow: ALLOW, hosts: HOSTS })
    assert.match(r, /Host "evil\.example\.com" is not a name this box serves/)
  })

  test('the right name on the WRONG port is refused — a preview rule cannot re-publish the terminal', () => {
    const r = identityRefusal(served({ host: 'box.tail1234.ts.net:8500' }), { allow: ALLOW, hosts: HOSTS })
    assert.match(r, /is not a name this box serves/)
  })

  test('a Funnel request is refused outright — no curia surface is for the public internet', () => {
    const r = identityRefusal(served({ [FUNNEL_HEADER]: '?1' }), { allow: ALLOW, hosts: HOSTS })
    assert.match(r, /tailnet-only/)
  })

  // The window between boot and tailscale answering. An unresolved surface does
  // not know its own name, so it cannot tell a legitimate Host from a forged
  // one — and a control that cannot decide must refuse, not admit.
  test('an unresolved host set refuses everyone rather than admitting anyone', () => {
    const r = identityRefusal(served(), { allow: ALLOW, hosts: new Set() })
    assert.match(r, /served-host allowlist is empty/)
  })

  test('an empty allowlist admits nobody', () => {
    const r = identityRefusal(served(), { allow: new Set(), hosts: HOSTS })
    assert.match(r, /identity allowlist is empty/)
  })

  test('called with nothing at all, it refuses', () => {
    assert.ok(identityRefusal())
  })
})

// ---------------------------------------------------------------------------
// The proxy: ttyd's half, including the upgrade that actually drives an agent
// ---------------------------------------------------------------------------

describe('IdentityProxy in front of ttyd (#151)', () => {
  let harness, proxy, harnessHits, journal
  // An upgraded socket outlives the request by design, so the test has to close
  // what it opened or node never drains and the FILE times out with every test
  // green — a failure that reads like a hang rather than a bug.
  const upgraded = []

  before(async () => {
    harnessHits = []
    journal = []
    harness = http.createServer((req, res) => {
      harnessHits.push({ path: req.url, host: req.headers.host })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ttyd here')
    })
    // ttyd's /ws, standing in for the real handshake: enough of a 101 to prove
    // the bytes flow, and a hit recorded so a REFUSED upgrade can be shown
    // never to have reached it.
    harness.on('upgrade', (req, socket) => {
      harnessHits.push({ path: req.url, host: req.headers.host, upgrade: true })
      upgraded.push(socket)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
      socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])))
    })
    await new Promise((r) => harness.listen(0, '127.0.0.1', r))

    proxy = new IdentityProxy({
      port: 0,
      targetPort: harness.address().port,
      allow: ALLOW,
      hosts: HOSTS,
      log: () => {},
      journal: (type, detail) => journal.push({ type, ...detail }),
    })
    const { verified } = await proxy.start()
    assert.equal(verified, true)
  })

  after(() => {
    for (const sock of upgraded) sock.destroy()
    proxy.stop()
    harness.closeAllConnections?.()
    harness.close()
  })

  const hit = (headers, p = '/') => req(proxy.port, p, { headers })

  test('a stamped request reaches ttyd, with the Host forwarded UNCHANGED so -O still works', async () => {
    harnessHits.length = 0
    const res = await hit(served())
    assert.equal(res.status, 200)
    assert.equal(res.text, 'ttyd here')
    assert.deepEqual(harnessHits, [{ path: '/', host: 'box.tail1234.ts.net:8443' }])
  })

  test('an unstamped request gets 403 and NEVER reaches ttyd', async () => {
    harnessHits.length = 0
    const res = await hit({ host: 'box.tail1234.ts.net:8443' })
    assert.equal(res.status, 403)
    assert.match(res.text, /did not arrive through Tailscale Serve/)
    assert.deepEqual(harnessHits, [], 'ttyd must never see a refused request')
  })

  test('a stranger on the tailnet gets 403 and never reaches ttyd', async () => {
    harnessHits.length = 0
    const res = await hit(served({ [LOGIN_HEADER]: 'mallory@example.com' }), '/?arg=curia-151')
    assert.equal(res.status, 403)
    assert.deepEqual(harnessHits, [])
  })

  test('every refusal lands on the journal with the who and the why', () => {
    const refusals = journal.filter((j) => j.type === 'attach_identity_refused')
    assert.ok(refusals.length >= 2)
    const stranger = refusals.find((j) => j.login === 'mallory@example.com')
    assert.ok(stranger, 'the refused login is recorded, not just the fact of a refusal')
    assert.match(stranger.reason, /not on the identity allowlist/)
    assert.equal(stranger.host, 'box.tail1234.ts.net:8443')
  })

  // The one that matters: /ws IS the drive path. A gate that only covers page
  // loads leaves the terminal wide open to a client that skips the page.
  const upgrade = (headers) => new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, '127.0.0.1', () => {
      const lines = ['GET /ws?arg=curia-151 HTTP/1.1', 'connection: Upgrade', 'upgrade: websocket',
        'sec-websocket-version: 13', 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==']
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
      sock.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let buf = ''
    sock.on('data', (d) => {
      buf += d
      if (/^HTTP\/1.1 403/.test(buf)) { sock.destroy(); resolve({ status: 403, buf }) }
      if (/\r\n\r\n/.test(buf) && /101/.test(buf)) resolve({ status: 101, sock, read: () => buf })
    })
    sock.on('error', reject)
    setTimeout(() => { sock.destroy(); reject(new Error(`no answer; got ${JSON.stringify(buf)}`)) }, 4000).unref?.()
  })

  test('a stamped WebSocket upgrade reaches ttyd and bytes flow both ways', async () => {
    harnessHits.length = 0
    const r = await upgrade(served())
    assert.equal(r.status, 101)
    const echoed = await new Promise((resolve) => {
      r.sock.on('data', (d) => { if (/echo:/.test(String(d))) resolve(String(d)) })
      r.sock.write('drive')
    })
    assert.match(echoed, /echo:drive/)
    r.sock.destroy()
    assert.ok(harnessHits.some((h) => h.upgrade), 'the upgrade reached ttyd')
  })

  test('an UNSTAMPED WebSocket upgrade is refused and never reaches ttyd', async () => {
    harnessHits.length = 0
    const r = await upgrade({ host: 'box.tail1234.ts.net:8443' })
    assert.equal(r.status, 403)
    assert.match(r.buf, /did not arrive through Tailscale Serve/)
    assert.deepEqual(harnessHits, [], 'the drive path must never open for an unstamped caller')
  })

  test('a rebinding-shaped upgrade — valid identity, forged Host — is refused', async () => {
    harnessHits.length = 0
    const r = await upgrade({ host: 'evil.example.com' })
    assert.equal(r.status, 403)
    assert.deepEqual(harnessHits, [])
  })
})

// #239: the preview surface rewrites Host once the identity check has passed —
// framework dev servers (Vite's allowedHosts) refuse the tailnet name, so
// forwarding it verbatim handed the operator a block page. Origin is left
// untouched on purpose: Vite guards its HMR websocket with a URL token, not by
// matching Origin (measured on 8.2.0), so the browser's real Origin keeps
// telling the truth to any upstream that wants it.
describe('IdentityProxy with rewriteHost: the preview surface (#239)', () => {
  let harness, proxy, harnessHits
  const upgraded = []

  before(async () => {
    harnessHits = []
    harness = http.createServer((req, res) => {
      harnessHits.push({ host: req.headers.host, xfh: req.headers['x-forwarded-host'], xfp: req.headers['x-forwarded-proto'] })
      res.writeHead(200)
      res.end('the app')
    })
    harness.on('upgrade', (req, socket) => {
      harnessHits.push({ host: req.headers.host, origin: req.headers.origin, upgrade: true })
      upgraded.push(socket)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    })
    await new Promise((r) => harness.listen(0, '127.0.0.1', r))
    proxy = new IdentityProxy({
      port: 0,
      targetPort: harness.address().port,
      allow: ALLOW,
      hosts: HOSTS,
      surface: 'preview',
      rewriteHost: true,
      log: () => {},
    })
    const { verified } = await proxy.start()
    assert.equal(verified, true)
  })

  after(() => {
    for (const sock of upgraded) sock.destroy()
    proxy.stop()
    harness.closeAllConnections?.()
    harness.close()
  })

  test('the dev server sees its own name, and the true one rides X-Forwarded-Host', async () => {
    harnessHits.length = 0
    const res = await req(proxy.port, '/', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(harnessHits, [{
      host: `127.0.0.1:${harness.address().port}`,
      xfh: 'box.tail1234.ts.net:8443',
      xfp: 'https',
    }])
  })

  test('the identity check still judges the ORIGINAL Host — the rewrite happens after, not instead', async () => {
    harnessHits.length = 0
    const res = await req(proxy.port, '/', { headers: served({ host: 'evil.example.com' }) })
    assert.equal(res.status, 403, 'a rewrite that ran first would launder the forged Host it exists to catch')
    assert.deepEqual(harnessHits, [])
  })

  test('the HMR-shaped upgrade gets the rewritten Host and its Origin untouched', async () => {
    harnessHits.length = 0
    const r = await new Promise((resolve, reject) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => {
        sock.write([
          'GET /?token=abc HTTP/1.1',
          'host: box.tail1234.ts.net:8443',
          `${LOGIN_HEADER}: alp@example.com`,
          'origin: https://box.tail1234.ts.net:8443',
          'connection: Upgrade', 'upgrade: websocket',
          'sec-websocket-version: 13', 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-protocol: vite-hmr',
          '', '',
        ].join('\r\n'))
      })
      let buf = ''
      sock.on('data', (d) => {
        buf += d
        if (/\r\n\r\n/.test(buf)) { sock.destroy(); resolve(buf) }
      })
      sock.on('error', reject)
      setTimeout(() => { sock.destroy(); reject(new Error(`no answer; got ${JSON.stringify(buf)}`)) }, 4000).unref?.()
    })
    assert.match(r, /101/)
    assert.deepEqual(harnessHits, [{
      host: `127.0.0.1:${harness.address().port}`,
      origin: 'https://box.tail1234.ts.net:8443',
      upgrade: true,
    }])
  })
})

// ---------------------------------------------------------------------------
// The timeline's half: same predicate, applied in-process
// ---------------------------------------------------------------------------

describe('the timeline refuses an unstamped caller too (#151)', () => {
  let surface, tmp, journal

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-identity-'))
    fs.mkdirSync(path.join(tmp, 'cfg'), { recursive: true })
    journal = []
    const hosts = serveHosts({ dnsName: 'box.tail1234.ts.net', ips: [], servePort: 8444 })
    surface = new TimelineSurface({
      port: 0,
      servePort: 8444,
      index: DEFAULT_TIMELINE_INDEX,
      workspaceRoot: tmp,
      log: () => {},
      deps: {
        journal: (type, detail) => journal.push({ type, ...detail }),
        identityCheck: (h) => identityRefusal(h, { allow: ALLOW, hosts }),
        assertServe: async () => {},
        serveOff: async () => {},
        attachBase: async () => 'box.tail1234.ts.net',
      },
    })
    await surface.start()
  })

  after(() => {
    surface.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const hit = (p, headers, init = {}) => req(surface.port, p, { headers, ...init })

  const stamped = { host: 'box.tail1234.ts.net:8444', [LOGIN_HEADER]: 'alp@example.com' }

  test('the page itself is refused to an unstamped caller', async () => {
    const res = await hit('/', { host: 'box.tail1234.ts.net:8444' })
    assert.equal(res.status, 403)
    assert.match(res.text, /did not arrive through Tailscale Serve/)
  })

  // Reads are gated, not just writes: the transcript IS the sensitive thing —
  // a caller who may not drive the agent may not read what it has produced.
  test('the transcript stream is refused to an unstamped caller', async () => {
    const res = await hit('/events?session=curia-151&once=1', { host: 'box.tail1234.ts.net:8444' })
    assert.equal(res.status, 403)
  })

  test('a stranger on the tailnet is refused on the write path', async () => {
    const res = await hit('/send', { ...stamped, [LOGIN_HEADER]: 'mallory@example.com', 'content-type': 'application/json' },
      { method: 'POST', body: JSON.stringify({ session: 'curia-151', text: 'rm -rf /' }) })
    assert.equal(res.status, 403)
  })

  test('a forged Host is refused even with a valid identity', async () => {
    const res = await hit('/', { ...stamped, host: 'evil.example.com' })
    assert.equal(res.status, 403)
  })

  test('a stamped caller gets the page', async () => {
    const res = await hit('/', stamped)
    assert.equal(res.status, 200)
    assert.match(res.text, /curia-timeline/)
  })

  test('every timeline refusal is journalled', () => {
    const refusals = journal.filter((j) => j.type === 'timeline_identity_refused')
    assert.ok(refusals.length >= 4)
    assert.ok(refusals.some((j) => j.path === '/events'), 'the refused route is recorded')
  })

  // The reason the default is a refusal and not an admission: a surface wired
  // up without a check must fail closed, or the control is one missing line of
  // wiring away from being absent.
  test('a surface constructed with NO identity check refuses everything', async () => {
    const bare = new TimelineSurface({
      port: 0, servePort: 8447, index: DEFAULT_TIMELINE_INDEX, workspaceRoot: tmp, log: () => {},
      deps: { assertServe: async () => {}, serveOff: async () => {}, attachBase: async () => 'x' },
    })
    await bare.start()
    try {
      const res = await req(bare.port, '/', { headers: stamped })
      assert.equal(res.status, 403)
      assert.match(res.text, /constructed with no identity check/)
    } finally {
      bare.stop()
    }
  })
})

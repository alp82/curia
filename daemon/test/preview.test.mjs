// Tests for src/preview.mjs — the preview-link registry (#40, implementing #8).
//
// The contract these pin:
//
//   - the daemon allocates the Serve port, never the agent;
//   - curia's own localhost surfaces can never be published (the daemon API is
//     an unauthenticated escalation-answer surface — publishing it to the
//     tailnet is the worst thing this module could do);
//   - a rule is never pointed at a dead port (it would publish whatever binds
//     it next);
//   - an unreadable `tailscale serve status` is INDETERMINATE — it must not
//     read as "no rules exist" and must not trigger a sweep. This is the bug
//     class #33's review killed four times over; it is re-armed here because
//     the sweep's failure mode is withdrawing live previews.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PreviewRegistry, parseServedPorts, previewUrl, normalizePreviewPath, DEFAULT_RANGE,
  DEFAULT_PROXY_FROM, probePreviewPage,
} from '../src/preview.mjs'
import { IdentityProxy, LOGIN_HEADER, serveHosts } from '../src/identity.mjs'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The exact shape `tailscale serve status --json` returned on the box.
const REAL_STATUS = {
  TCP: { 8443: { HTTPS: true } },
  Web: { 'alppc.tail3b99f1.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7681' } } } },
}

const BASE = 'box.tail0000.ts.net'

// A recording fake for execFileP. `status` is what serve-status returns.
function fakeExec({ status = { Web: {} }, failStatus = null, failServe = null } = {}) {
  const calls = []
  const exec = async (bin, argv) => {
    calls.push([bin, ...argv].join(' '))
    if (argv[1] === 'status') {
      if (failStatus) throw new Error(failStatus)
      return { stdout: JSON.stringify(status) }
    }
    if (failServe) throw new Error(failServe)
    return { stdout: '' }
  }
  return { exec, calls }
}

// isLive resolves the localhost address to point the rule AT, or null.
const alwaysLive = async () => '127.0.0.1'
const liveOnIpv6 = async () => 'localhost'
const neverLive = async () => null

// #168: every preview now stands an identity proxy up before its rule is
// written, so the registry needs two things it did not need before — this box's
// tailnet names, and a port it can bind. Both are faked by default here so the
// pre-#168 tests keep testing what they were written to test. The REAL classes
// get their own describe block below, and the real bind gets the live check.
const FAKE_SELF = async () => ({ dnsName: 'box.tail0000.ts.net', ips: ['100.64.0.1'] })

class FakeProxy {
  static made = []
  constructor(opts) {
    Object.assign(this, opts)
    this.listening = false
    this.stopped = false
    FakeProxy.made.push(this)
  }

  async start() {
    if (this.failBind) return { verified: false }
    this.listening = true
    return { verified: true }
  }

  stop() {
    this.listening = false
    this.stopped = true
  }
}

// A proxy that refuses to bind, standing in for a port already taken.
class DeadProxy extends FakeProxy {
  constructor(opts) { super(opts); this.failBind = true }
}

// #239 gave publish an HTTP probe of the page itself. Faked green here for the
// same reason the proxy is faked: the pre-#239 tests keep testing what they
// were written to test, and the probe gets its own describe block below.
const pageAnswers = async () => ({ ok: true, status: 200 })

function mkReg(opts = {}) {
  return new PreviewRegistry({ self: FAKE_SELF, Proxy: FakeProxy, probe: pageAnswers, ...opts })
}

// The port the rule points at under the default range: the base of the derived
// block, because the first preview lands on the base of the preview range.
const FIRST_PROXY = DEFAULT_PROXY_FROM

describe('parseServedPorts reads the real tailscale shape', () => {
  test('a live rule maps its serve port to its proxy target', () => {
    const m = parseServedPorts(REAL_STATUS)
    assert.equal(m.get(8443), 'http://127.0.0.1:7681')
  })

  test('an unrecognised shape yields an empty map, never a throw', () => {
    for (const junk of [null, undefined, {}, { Web: null }, { Web: 'nope' }]) {
      assert.equal(parseServedPorts(junk).size, 0)
    }
  })
})

describe('publish refuses what must never reach the tailnet', () => {
  test("curia's own surfaces are refused by port, not by hope", async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ reserved: [4271, 7681, 8443], exec, isLive: alwaysLive, log: () => {} })
    for (const port of [4271, 7681, 8443]) {
      const r = await reg.publish('7', port, { base: BASE })
      assert.equal(r.ok, false, `port ${port} must be refused`)
      assert.match(r.reason, /curia's own surfaces/)
    }
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0, 'no serve rule may be written for a refused port')
  })

  test('a dead dev port is refused — a rule would publish whatever binds it next', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: neverLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.ok, false)
    assert.match(r.reason, /nothing is listening/)
    assert.match(r.reason, /both 127\.0\.0\.1 and \[::1\]/, 'the refusal must say which addresses were probed — the agent cannot otherwise tell a dead server from a wrong-family bind')
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })

  test('a nonsense port is refused before anything is probed', async () => {
    const reg = mkReg({ exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    for (const bad of [0, -1, 70000, 'http://x', null, 3.5]) {
      assert.equal((await reg.publish('7', bad, { base: BASE })).ok, false, `${bad} must be refused`)
    }
  })

  test('an unreadable serve status refuses to allocate rather than allocating blind', async () => {
    const { exec, calls } = fakeExec({ failStatus: 'tailscaled not responding' })
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.ok, false)
    assert.match(r.reason, /could not read tailscale serve status/)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })
})

// Regression: "localhost" is not one address. Vite v8 binds [::1] only, so an
// IPv4-only probe refused a dev server that was running and the rehearsal's
// preview leg could never pass against a real project repo.
describe('the rule points at the address the dev server is actually on', () => {
  test('an IPv6-only dev server is published, not refused', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: liveOnIpv6, log: () => {} })
    const r = await reg.publish('7', 3015, { base: BASE })
    assert.equal(r.ok, true, 'a running dev server must never be reported as absent')
    assert.equal(r.target, 'localhost')
    // #168 moved this fact one hop: the serve rule points at the identity proxy
    // now, and the proxy is what carries the address the dev server answers on.
    // The reason is unchanged — a bracketed literal must never reach tailscale.
    assert.ok(
      calls.some((c) => c === `tailscale serve --bg --https=${DEFAULT_RANGE.from} http://127.0.0.1:${FIRST_PROXY}`),
      'the rule points at the gate, never at the dev server',
    )
    assert.equal(FakeProxy.made.at(-1).targetHost, 'localhost', 'and the gate is what reaches an IPv6-only dev server')
    assert.equal(FakeProxy.made.at(-1).targetPort, 3015)
  })

  test('an IPv4 dev server still gets an explicit 127.0.0.1, never a resolved name', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 3055, { base: BASE })
    assert.equal(r.target, '127.0.0.1')
    assert.equal(FakeProxy.made.at(-1).targetHost, '127.0.0.1')
    assert.equal(FakeProxy.made.at(-1).targetPort, 3055)
  })

  test('reserved ports are still refused whichever family answers', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ reserved: [4271], exec, isLive: liveOnIpv6, log: () => {} })
    const r = await reg.publish('7', 4271, { base: BASE })
    assert.equal(r.ok, false, 'containment is by port and must not depend on the address family')
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })
})

describe('allocation', () => {
  test('the first free port in range is taken and the rule points at that preview\'s gate', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.ok, true)
    assert.equal(r.servePort, DEFAULT_RANGE.from)
    assert.equal(r.url, `https://${BASE}:${DEFAULT_RANGE.from}/`)
    assert.ok(calls.some((c) => c === `tailscale serve --bg --https=${DEFAULT_RANGE.from} http://127.0.0.1:${FIRST_PROXY}`))
  })

  test('a port already served by tailscaled is skipped — including the attach rule', async () => {
    const status = { Web: { 'h:8500': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } }
    const { exec } = fakeExec({ status })
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.servePort, 8501, 'must not collide with an existing rule')
  })

  test('two tickets get two ports', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const a = await reg.publish('7', 4321, { base: BASE })
    const b = await reg.publish('8', 4322, { base: BASE })
    assert.notEqual(a.servePort, b.servePort)
  })

  test('republishing the same dev port reuses the allocation instead of burning a port', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const a = await reg.publish('7', 4321, { base: BASE })
    const b = await reg.publish('7', 4321, { base: BASE })
    assert.equal(b.servePort, a.servePort)
    assert.equal(b.reused, true)
    assert.equal(reg.list().length, 1)
  })

  test('a ticket moving to a new dev port withdraws its stale rule rather than leaking it', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const a = await reg.publish('7', 4321, { base: BASE })
    await reg.publish('7', 4999, { base: BASE })
    assert.ok(calls.some((c) => c === `tailscale serve --https=${a.servePort} off`), 'the stale rule must be withdrawn')
  })

  test('an exhausted range refuses rather than reusing a live port', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ range: { from: 8500, to: 8501 }, exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('1', 4001, { base: BASE })
    await reg.publish('2', 4002, { base: BASE })
    const r = await reg.publish('3', 4003, { base: BASE })
    assert.equal(r.ok, false)
    assert.match(r.reason, /no free preview port/)
  })
})

describe('withdraw', () => {
  test('withdrawing frees the port for the next ticket', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const a = await reg.publish('7', 4321, { base: BASE })
    await reg.withdraw('7')
    assert.equal(reg.get('7'), null)
    const b = await reg.publish('8', 4322, { base: BASE })
    assert.equal(b.servePort, a.servePort, 'the freed port is reusable')
  })

  test('"handler does not exist" is positive absence, not a failure', async () => {
    const { exec } = fakeExec({ failServe: 'error: failed to remove web serve: handler does not exist' })
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    reg.byTicket.set('7', { servePort: 8500, devPort: 4321 })
    const r = await reg.withdraw('7')
    assert.equal(r.ok, true)
    assert.equal(reg.get('7'), null)
  })

  test('a real withdrawal failure KEEPS the record — the rule is still published', async () => {
    const { exec } = fakeExec({ failServe: 'tailscaled is down' })
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    reg.byTicket.set('7', { servePort: 8500, devPort: 4321 })
    const r = await reg.withdraw('7')
    assert.equal(r.ok, false)
    assert.ok(reg.get('7'), 'dropping the record would hide a published rule from the next sweep')
  })

  test('withdrawing an unknown ticket is a no-op, not an error', async () => {
    const reg = mkReg({ exec: fakeExec().exec, log: () => {} })
    assert.deepEqual(await reg.withdraw('nope'), { ok: true, withdrawn: false })
  })
})

describe('sweep', () => {
  test('a rule whose ticket is gone is withdrawn', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const { swept } = await reg.sweep(['8'])
    assert.equal(swept.length, 1)
    assert.ok(calls.some((c) => /serve --https=8500 off/.test(c)))
    assert.equal(reg.get('7'), null)
  })

  test('a live ticket keeps its preview', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const { swept } = await reg.sweep(['7'])
    assert.equal(swept.length, 0)
    assert.ok(reg.get('7'))
  })

  test('an orphan rule from a PREVIOUS process is swept — the case the cache cannot see', async () => {
    // serve config survives daemon restarts, so a fresh registry starts empty
    // while tailscaled still holds the rule.
    const status = { Web: { 'h:8507': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4321' } } } } }
    const { exec, calls } = fakeExec({ status })
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const { swept } = await reg.sweep([])
    assert.deepEqual(swept, [{ servePort: 8507, ticket: null }])
    assert.ok(calls.some((c) => /serve --https=8507 off/.test(c)))
  })

  test('rules OUTSIDE the preview range are never touched — the attach rule must survive', async () => {
    const { exec, calls } = fakeExec({ status: REAL_STATUS }) // 8443 = attach
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const { swept } = await reg.sweep([])
    assert.equal(swept.length, 0)
    assert.equal(calls.filter((c) => c.includes('off')).length, 0, 'sweeping the attach rule would kill /attach tailnet-wide')
  })

  test('an unreadable serve status SKIPS the sweep instead of withdrawing everything', async () => {
    const { exec, calls } = fakeExec({ failStatus: 'tailscaled not responding' })
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    reg.byTicket.set('7', { servePort: 8500, devPort: 4321 })
    const r = await reg.sweep([])
    assert.equal(r.skipped, true)
    assert.deepEqual(r.swept, [])
    assert.ok(reg.get('7'), 'an indeterminate read must never be treated as "no live tickets"')
    assert.equal(calls.filter((c) => c.includes('off')).length, 0)
  })
})

describe('restart recovery (#563)', () => {
  test('a persisted preview for a live ticket keeps its URL and reopens its gate', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    const firstExec = fakeExec()
    const first = mkReg({ dataDir, exec: firstExec.exec, isLive: alwaysLive, log: () => {} })
    const published = await first.publish('7', 4321, { base: BASE, path: '/curia-check' })

    const secondExec = fakeExec()
    const second = mkReg({ dataDir, exec: secondExec.exec, isLive: alwaysLive, log: () => {} })
    const recovered = await second.recover(['7'])

    assert.deepEqual(recovered, { recovered: ['7'], dropped: [] })
    assert.equal(second.get('7').url, published.url)
    assert.equal(FakeProxy.made.at(-1).targetPort, 4321)
    assert.ok(secondExec.calls.includes(
      `tailscale serve --bg --https=${published.servePort} http://127.0.0.1:${published.proxyPort}`,
    ))
  })

  test('the recovered gate serves the same preview page after a restart', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    const range = { from: 18520, to: 18529 }
    const proxyFrom = 17720
    const allow = new Set(['alp@example.com'])
    const self = async () => ({ dnsName: 'box.tail0000.ts.net', ips: [] })
    const dev = http.createServer((_req, res) => { res.writeHead(200); res.end('the recovered page') })
    await new Promise((resolve) => dev.listen(0, '127.0.0.1', resolve))
    const devPort = dev.address().port
    let second = null
    try {
      const first = new PreviewRegistry({
        dataDir, range, proxyFrom, allow, self, exec: fakeExec().exec, log: () => {},
      })
      const published = await first.publish('7', devPort, { base: BASE, path: '/curia-check' })
      first.proxies.get(published.servePort).stop()
      first.proxies.clear()

      second = new PreviewRegistry({
        dataDir, range, proxyFrom, allow, self, exec: fakeExec().exec, log: () => {},
      })
      await second.recover(['7'])
      const page = await new Promise((resolve) => {
        http.get({
          host: '127.0.0.1',
          port: proxyFrom,
          path: '/curia-check',
          headers: {
            host: `box.tail0000.ts.net:${range.from}`,
            [LOGIN_HEADER]: 'alp@example.com',
          },
        }, (res) => {
          let body = ''
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode, body }))
        })
      })

      assert.equal(second.get('7').url, published.url)
      assert.deepEqual(page, { status: 200, body: 'the recovered page' })
    } finally {
      await second?.withdraw('7').catch(() => {})
      dev.close()
    }
  })

  test('a persisted preview with a dead server loses its rule and its entry', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    const first = mkReg({ dataDir, exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    const published = await first.publish('7', 4321, { base: BASE })

    const secondExec = fakeExec()
    const second = mkReg({
      dataDir,
      exec: secondExec.exec,
      isLive: alwaysLive,
      probe: async () => ({ ok: false, error: 'ECONNREFUSED' }),
      log: () => {},
    })
    const recovered = await second.recover(['7'])

    assert.deepEqual(recovered, { recovered: [], dropped: ['7'] })
    assert.equal(second.get('7'), null)
    assert.ok(secondExec.calls.includes(`tailscale serve --https=${published.servePort} off`))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'previews.json'), 'utf8')), [])
  })

  test('a preview whose gate cannot recover loses its rule', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    const first = mkReg({ dataDir, exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    const published = await first.publish('7', 4321, { base: BASE })

    const secondExec = fakeExec()
    const second = mkReg({ dataDir, exec: secondExec.exec, Proxy: DeadProxy, log: () => {} })
    const recovered = await second.recover(['7'])

    assert.deepEqual(recovered, { recovered: [], dropped: ['7'] })
    assert.ok(secondExec.calls.includes(`tailscale serve --https=${published.servePort} off`))
    assert.equal(second.get('7'), null)
  })

  test('a timed-out recovery probe withdraws the rule and drops the entry', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    const first = mkReg({ dataDir, exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    const published = await first.publish('7', 4321, { base: BASE })

    const secondExec = fakeExec()
    const second = mkReg({
      dataDir,
      exec: secondExec.exec,
      probe: async () => ({ ok: true, status: null, slow: true }),
      log: () => {},
    })
    const recovered = await second.recover(['7'])

    assert.deepEqual(recovered, { recovered: [], dropped: ['7'] })
    assert.ok(secondExec.calls.includes(`tailscale serve --https=${published.servePort} off`))
    assert.equal(second.get('7'), null)
  })

  test('a failed recovery withdrawal keeps the entry for the next sweep', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    const first = mkReg({ dataDir, exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    await first.publish('7', 4321, { base: BASE })

    const second = mkReg({
      dataDir,
      exec: fakeExec({ failServe: 'tailscaled is down' }).exec,
      Proxy: DeadProxy,
      log: () => {},
    })
    const recovered = await second.recover(['7'])
    await second.sweep(['7'])

    assert.deepEqual(recovered, { recovered: [], dropped: [] })
    assert.equal(second.get('7').devPort, 4321)
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'previews.json'), 'utf8'))
    assert.deepEqual(persisted.map((entry) => entry.ticket), ['7'])
  })

  test('a failed move removes the withdrawn preview from persisted state', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    let probes = 0
    const reg = mkReg({
      dataDir,
      exec: fakeExec().exec,
      isLive: alwaysLive,
      probe: async () => (++probes === 1
        ? { ok: true, status: 200 }
        : { ok: false, error: 'ECONNREFUSED' }),
      log: () => {},
    })
    await reg.publish('7', 4321, { base: BASE })

    const moved = await reg.publish('7', 4322, { base: BASE })

    assert.equal(moved.ok, false)
    assert.equal(reg.get('7'), null)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'previews.json'), 'utf8')), [])
  })

  test('withdraw removes the persisted entry', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    const reg = mkReg({ dataDir, exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })

    await reg.withdraw('7')

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'previews.json'), 'utf8')), [])
  })

  test('sweep removes dead tickets from the persisted entries', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-preview-'))
    const reg = mkReg({ dataDir, exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    await reg.publish('8', 4322, { base: BASE })

    await reg.sweep(['8'])

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'previews.json'), 'utf8'))
    assert.deepEqual(persisted.map((entry) => entry.ticket), ['8'])
  })
})

describe('previewUrl', () => {
  test('is the tailnet base with the allocated port', () => {
    assert.equal(previewUrl('box.ts.net', 8500), 'https://box.ts.net:8500/')
  })

  test('carries the path, so the link opens the page rather than the site', () => {
    assert.equal(previewUrl('box.ts.net', 8500, '/curia-check'), 'https://box.ts.net:8500/curia-check')
  })
})

// #68: the whole defect was that this argument did not exist. These pin the two
// halves of it — the path reaches the composed link, and it can never move that
// link off this box.
describe('normalizePreviewPath', () => {
  test('nothing given means the site root, as before', () => {
    for (const empty of [undefined, null, '']) {
      assert.deepEqual(normalizePreviewPath(empty), { ok: true, path: '/' })
    }
  })

  test('a plain path, a query and a fragment all survive', () => {
    assert.equal(normalizePreviewPath('/curia-check').path, '/curia-check')
    assert.equal(normalizePreviewPath('/blog/post?draft=1').path, '/blog/post?draft=1')
    assert.equal(normalizePreviewPath('/docs#anchor').path, '/docs#anchor')
    assert.equal(normalizePreviewPath('curia-check').path, '/curia-check', 'a missing leading slash is a typo, not a refusal')
  })

  test('a path that would move the origin is refused, whatever syntax it arrives in', () => {
    for (const smuggled of [
      '//evil.com/x', // protocol-relative — the one that looks like a path
      'https://evil.com/x',
      'http://127.0.0.1:4271/answer',
      '\\\\evil.com/x', // a backslash is a slash to the URL parser
      'box.ts.net:8500/x', // parses as a SCHEME, not a host
      'javascript:alert(1)',
    ]) {
      const r = normalizePreviewPath(smuggled)
      assert.equal(r.ok, false, `${smuggled} must be refused`)
      assert.match(r.reason, /not a host or a scheme|not a usable URL path/)
    }
  })

  test('`..` can only ever climb back to the root of this preview', () => {
    assert.equal(normalizePreviewPath('/a/../../../etc/passwd').path, '/etc/passwd')
  })

  test('spaces, control characters, a non-string and an overlong path are refused', () => {
    assert.equal(normalizePreviewPath('/a page').ok, false)
    assert.equal(normalizePreviewPath('/a\nb').ok, false)
    assert.equal(normalizePreviewPath(7).ok, false)
    assert.equal(normalizePreviewPath(`/${'x'.repeat(600)}`).ok, false)
  })
})

describe('the published link points at the page, not the site root (#68)', () => {
  test('the path reaches the URL the registry hands back and stores', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE, path: '/curia-check' })
    assert.equal(r.ok, true)
    assert.equal(r.url, `https://${BASE}:${DEFAULT_RANGE.from}/curia-check`)
    // The gate reads the STORED entry, not this return value (#54).
    assert.equal(reg.get('7').url, r.url)
  })

  test('the Serve rule is unchanged by the path — it is a display suffix, not reach', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE, path: '/curia-check' })
    assert.ok(calls.some((c) => c === `tailscale serve --bg --https=${DEFAULT_RANGE.from} http://127.0.0.1:${FIRST_PROXY}`))
  })

  test('re-publishing the same port with a new path MOVES the link', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const b = await reg.publish('7', 4321, { base: BASE, path: '/curia-check' })
    assert.equal(b.reused, true, 'still one port')
    assert.equal(b.url, `https://${BASE}:${DEFAULT_RANGE.from}/curia-check`)
    assert.equal(reg.get('7').url, b.url, 'correcting a wrong link is why this call is made twice')
    assert.equal(reg.list().length, 1)
  })

  test('a smuggled path refuses the publish outright — no rule, no link', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE, path: '//evil.com/x' })
    assert.equal(r.ok, false)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
    assert.equal(reg.get('7'), null)
  })
})

// #157: a sandboxed agent's dev server runs inside its container, and the box
// reaches it only through the three ports that container publishes. So the
// allocation, not a probe, is what says the port is the agent's own.
//
// The probe is not merely weaker here — it is false. docker binds the host port
// for the container's whole life, so a connect succeeds whether or not a server
// was ever started inside, and succeeds even when the server bound `localhost`
// inside the container, where nothing outside can reach it. Measured on docker
// 29.6.2 and on the box's 20.10.17.
describe('the published-port bound (#157)', () => {
  // A probe that fails the test if it is consulted at all.
  const neverProbed = async () => { throw new Error('the probe must not run for a published port') }

  test('a port outside the published set is refused, and the refusal names the three', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: neverProbed, log: () => {} })
    const r = await reg.publish('7', 3000, { base: BASE, published: [9000, 9001, 9002] })
    assert.equal(r.ok, false)
    assert.match(r.reason, /9000, 9001, 9002/, 'an agent cannot discover its ports — the refusal has to state them')
    assert.match(r.reason, /0\.0\.0\.0/, 'and has to say how to bind, since a localhost bind inside the container fails silently')
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
    assert.equal(reg.get('7'), null)
  })

  test('a published port is published without probing anything', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: neverProbed, log: () => {} })
    const r = await reg.publish('7', 9001, { base: BASE, published: [9000, 9001, 9002], path: '/curia-check' })
    assert.equal(r.ok, true)
    assert.equal(r.target, '127.0.0.1', 'docker publishes on 127.0.0.1 by name — there is no address family left to discover')
    assert.ok(calls.some((c) => c === `tailscale serve --bg --https=${DEFAULT_RANGE.from} http://127.0.0.1:${FIRST_PROXY}`))
    assert.equal(FakeProxy.made.at(-1).targetPort, 9001, 'the gate is what reaches into the container')
    assert.equal(r.url, `https://${BASE}:${DEFAULT_RANGE.from}/curia-check`)
  })

  test("curia's own surfaces stay refused even if they reach the published set", async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ reserved: [4271], exec, isLive: neverProbed, log: () => {} })
    const r = await reg.publish('7', 4271, { base: BASE, published: [4271] })
    assert.equal(r.ok, false, 'containment is by port and no allocation may argue with it')
    assert.match(r.reason, /curia's own surfaces/)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })

  test('an agent with no published ports keeps the probe — the bare path until #158', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: neverLive, log: () => {} })
    const r = await reg.publish('7', 3000, { base: BASE, published: null })
    assert.equal(r.ok, false)
    assert.match(r.reason, /nothing is listening/)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })
})

// ---------------------------------------------------------------------------
// #168: the identity check reaches preview rules
// ---------------------------------------------------------------------------
//
// The last surface curia publishes through Serve, and the one ADR-0011 named as
// still open. What these pin is the FAIL-CLOSED ordering, because that is the
// whole property: a rule written before its gate is up is an un-gated dev
// server on the tailnet for as long as the gap lasts, and forever if the gate
// never comes up.
describe('#168: every preview stands behind an identity proxy', () => {
  test('the proxy port is DERIVED from the serve port, index for index', () => {
    const reg = mkReg({ log: () => {} })
    assert.equal(reg.proxyPortFor(DEFAULT_RANGE.from), DEFAULT_PROXY_FROM)
    assert.equal(reg.proxyPortFor(DEFAULT_RANGE.from + 1), DEFAULT_PROXY_FROM + 1)
    assert.equal(reg.proxyPortFor(DEFAULT_RANGE.to), DEFAULT_PROXY_FROM + (DEFAULT_RANGE.to - DEFAULT_RANGE.from))
  })

  test('the gate carries the SAME allowlist object the attach surfaces hold', async () => {
    const { exec } = fakeExec()
    const allow = new Set(['alp@example.com'])
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {}, allow })
    await reg.publish('7', 4321, { base: BASE })
    // Identity, not equality: the operator's call was ONE list for all three
    // surfaces, so a login added at runtime must reach a live preview too.
    assert.equal(FakeProxy.made.at(-1).allow, allow)
  })

  test("the host set is this preview's OWN serve port, not the whole range", async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const { hosts } = FakeProxy.made.at(-1)
    assert.ok(hosts.has(`box.tail0000.ts.net:${DEFAULT_RANGE.from}`), 'the FQDN on this preview\'s port')
    assert.ok(hosts.has(`100.64.0.1:${DEFAULT_RANGE.from}`), 'and the tailnet IP an operator may type')
    assert.ok(!hosts.has(`box.tail0000.ts.net:${DEFAULT_RANGE.from + 1}`), 'never a neighbouring preview\'s port')
  })

  test('the gate is journalled as `preview`, so a refusal is greppable apart from attach', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    assert.equal(FakeProxy.made.at(-1).surface, 'preview')
  })

  test('a proxy that will not bind REFUSES the publish — no rule is ever written', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {}, Proxy: DeadProxy })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.ok, false)
    assert.match(r.reason, /un-gated/, 'the refusal has to say what it is protecting, not just that it failed')
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0, 'THE property: no rule without a gate')
    assert.equal(reg.get('7'), null)
  })

  test('a box that cannot name itself refuses the publish rather than publishing blind', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({
      exec, isLive: alwaysLive, log: () => {},
      self: async () => { throw new Error('tailscale status carries no Self.DNSName') },
    })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.ok, false)
    assert.match(r.reason, /tailnet names/)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })

  test('a resolved-but-empty name set refuses too — an empty host set admits nobody', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({
      exec, isLive: alwaysLive, log: () => {},
      self: async () => ({ dnsName: '', ips: [] }),
    })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.ok, false)
    assert.match(r.reason, /cannot verify its own name/)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })

  test('the derived proxy block is refused as a dev port, like every other curia surface', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    for (const port of [DEFAULT_PROXY_FROM, DEFAULT_PROXY_FROM + 7]) {
      const r = await reg.publish('7', port, { base: BASE })
      assert.equal(r.ok, false, `:${port} is a preview's own gate`)
      assert.match(r.reason, /identity-proxy block/)
    }
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })

  test('withdrawing a preview takes its gate down with it', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const proxy = FakeProxy.made.at(-1)
    assert.equal(proxy.listening, true)
    await reg.withdraw('7')
    assert.equal(proxy.stopped, true)
    assert.equal(reg.proxies.size, 0)
  })

  test('a FAILED withdrawal keeps the gate up — the rule is still published', async () => {
    // Only the withdrawal fails: the rule went up fine and is still up, which
    // is the whole point of the case.
    let breakIt = false
    const exec = async (bin, argv) => {
      if (argv[1] === 'status') return { stdout: '{"Web":{}}' }
      if (breakIt) throw new Error('tailscaled is not answering')
      return { stdout: '' }
    }
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    breakIt = true
    const proxy = FakeProxy.made.at(-1)
    const r = await reg.withdraw('7')
    assert.equal(r.ok, false)
    assert.equal(proxy.stopped, false, 'a rule that is still up must keep its check, or the failure IS the hole')
    assert.equal(proxy.listening, true)
  })

  test('moving a preview to a new dev port replaces the gate rather than leaking it', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const first = FakeProxy.made.at(-1)
    await reg.publish('7', 4322, { base: BASE })
    const second = FakeProxy.made.at(-1)
    assert.equal(first.stopped, true)
    assert.notEqual(first, second)
    assert.equal(second.targetPort, 4322)
    assert.equal(reg.proxies.size, 1)
  })

  test('re-publishing the same dev port keeps the gate it already has', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const proxy = FakeProxy.made.at(-1)
    const r = await reg.publish('7', 4321, { base: BASE, path: '/moved' })
    assert.equal(r.reused, true)
    assert.equal(proxy.stopped, false, 'the path moved, the gate did not')
    assert.equal(FakeProxy.made.at(-1), proxy)
  })
})

describe('#168: the sweep re-checks a live preview\'s gate', () => {
  test('a live ticket whose gate died has its RULE withdrawn', async () => {
    const { exec, calls } = fakeExec()
    const events = []
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {}, journal: (t, d) => events.push([t, d]) })
    await reg.publish('7', 4321, { base: BASE })
    // Attach re-checks its proxy on every /attach request. A preview has no
    // such path, so the sweep is the only thing that can see this flip.
    FakeProxy.made.at(-1).listening = false
    const r = await reg.sweep(['7'])
    assert.equal(r.skipped, false)
    assert.deepEqual(r.swept, [{ servePort: DEFAULT_RANGE.from, ticket: '7', ungated: true }])
    assert.ok(calls.some((c) => c === `tailscale serve --https=${DEFAULT_RANGE.from} off`))
    assert.equal(reg.get('7'), null)
    assert.ok(events.some(([t]) => t === 'preview_gate_lost'), 'the flip has to be greppable afterwards')
  })

  test('a live ticket with a healthy gate is left completely alone', async () => {
    const { exec, calls } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const r = await reg.sweep(['7'])
    assert.deepEqual(r.swept, [])
    assert.equal(calls.filter((c) => c.includes('off')).length, 0)
    assert.equal(reg.get('7').servePort, DEFAULT_RANGE.from)
  })

  test('an indeterminate serve status still aborts before any gate is judged', async () => {
    const { exec } = fakeExec({ failStatus: 'tailscaled is not answering' })
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    reg.byTicket.set('7', { servePort: DEFAULT_RANGE.from, devPort: 4321 })
    const r = await reg.sweep(['7'])
    assert.equal(r.skipped, true, '#33\'s rule outranks #168\'s: an unreadable status withdraws nothing')
    assert.equal(reg.get('7').servePort, DEFAULT_RANGE.from)
  })

  test('a dead ticket takes its gate down as well as its rule', async () => {
    const { exec } = fakeExec()
    const reg = mkReg({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const proxy = FakeProxy.made.at(-1)
    await reg.sweep([])
    assert.equal(proxy.stopped, true)
    assert.equal(reg.proxies.size, 0)
  })
})

// The real class, on real sockets — the wiring the fakes above cannot prove.
// The proxy binds, refuses an unstamped caller, and reaches the dev server for
// a stamped one. Serve itself is what the live check covers.
describe('#168: a real gate in front of a real dev server', () => {
  const REAL_RANGE = { from: 18500, to: 18509 }
  const REAL_PROXY_FROM = 17700

  test('an unstamped caller is refused and a stamped one reaches the page', async () => {
    let seenHeaders = null
    const dev = http.createServer((req, res) => {
      seenHeaders = req.headers
      res.writeHead(200)
      res.end('the page under review')
    })
    await new Promise((r) => dev.listen(0, '127.0.0.1', r))
    const devPort = dev.address().port
    const { exec } = fakeExec()
    const reg = new PreviewRegistry({
      range: REAL_RANGE,
      proxyFrom: REAL_PROXY_FROM,
      exec,
      isLive: async () => '127.0.0.1',
      log: () => {},
      allow: new Set(['alp@example.com']),
      self: async () => ({ dnsName: 'box.tail0000.ts.net', ips: [] }),
      Proxy: IdentityProxy,
    })
    try {
      const r = await reg.publish('7', devPort, { base: BASE })
      assert.equal(r.ok, true)
      assert.equal(r.proxyPort, REAL_PROXY_FROM)

      const get = (headers) => new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: REAL_PROXY_FROM, path: '/', headers }, (res) => {
          let body = ''
          res.on('data', (c) => { body += c })
          res.on('end', () => resolve({ status: res.statusCode, body }))
        })
      })

      const host = `box.tail0000.ts.net:${REAL_RANGE.from}`
      const bare = await get({ host })
      assert.equal(bare.status, 403, 'no Serve stamp means the request did not come through Serve')
      assert.match(bare.body, /did not arrive through Tailscale Serve/)

      const stamped = await get({ host, [LOGIN_HEADER]: 'alp@example.com' })
      assert.equal(stamped.status, 200)
      assert.equal(stamped.body, 'the page under review')
      // #239: the dev server sees its OWN name, never the tailnet one — the
      // Host that framework dev servers refuse has done its identity work and
      // stops here. The true name survives as X-Forwarded-Host.
      assert.equal(seenHeaders.host, `127.0.0.1:${devPort}`)
      assert.equal(seenHeaders['x-forwarded-host'], host)
      assert.equal(seenHeaders['x-forwarded-proto'], 'https')

      const stranger = await get({ host, [LOGIN_HEADER]: 'mallory@example.com' })
      assert.equal(stranger.status, 403)
      assert.match(stranger.body, /not on the identity allowlist/)

      const wrongHost = await get({ host: 'evil.example.com', [LOGIN_HEADER]: 'alp@example.com' })
      assert.equal(wrongHost.status, 403, 'Serve passes a forged Host through verbatim (#151 fact 4)')

      const neighbour = await get({ host: `box.tail0000.ts.net:${REAL_RANGE.from + 1}`, [LOGIN_HEADER]: 'alp@example.com' })
      assert.equal(neighbour.status, 403, "a rule aimed at this gate under another preview's name is refused")
    } finally {
      await reg.withdraw('7').catch(() => {})
      dev.close()
    }
  })
})

// #239: the review-gate link opened on Vite's blocked-host page. The identity
// proxy forwarded the tailnet Host verbatim (its rebinding job done), and
// framework dev servers refuse any Host that is not their own. Two closures:
// the proxy rewrites Host once the check has passed, and publish probes the
// page with that same Host so a dead link is refused at publish time with the
// cause, instead of reaching the operator as a block page or a 502.
describe('#239: the preview link opens the app, not a block page', () => {
  const RANGE = { from: 18510, to: 18519 }
  const PROXY_FROM = 17710

  test('a Vite-shaped server that refuses foreign Hosts serves its page through the gate', async () => {
    // The stock behavior measured on Vite 8.2.0: any Host that is not the
    // server's own name gets the allowedHosts block page as a 403.
    const dev = http.createServer((req, res) => {
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? '')) {
        res.writeHead(403)
        return res.end(`Blocked request. This host ("${(req.headers.host ?? '').split(':')[0]}") is not allowed.`)
      }
      res.writeHead(200)
      res.end('the app')
    })
    await new Promise((r) => dev.listen(0, '127.0.0.1', r))
    const devPort = dev.address().port
    const { exec } = fakeExec()
    const reg = new PreviewRegistry({
      range: RANGE,
      proxyFrom: PROXY_FROM,
      exec,
      isLive: async () => '127.0.0.1',
      log: () => {},
      allow: new Set(['alp@example.com']),
      self: async () => ({ dnsName: 'box.tail0000.ts.net', ips: [] }),
      Proxy: IdentityProxy,
    })
    try {
      const r = await reg.publish('9', devPort, { base: BASE })
      assert.equal(r.ok, true, `publish refused: ${r.reason}`)
      assert.equal(r.probeStatus, 200, 'the probe itself must carry the rewritten Host, or it reports the block page')

      const page = await new Promise((resolve) => {
        http.get({
          host: '127.0.0.1',
          port: PROXY_FROM,
          path: '/',
          headers: { host: `box.tail0000.ts.net:${RANGE.from}`, [LOGIN_HEADER]: 'alp@example.com' },
        }, (res) => {
          let body = ''
          res.on('data', (c) => { body += c })
          res.on('end', () => resolve({ status: res.statusCode, body }))
        })
      })
      assert.equal(page.status, 200, `the operator got: ${page.body}`)
      assert.equal(page.body, 'the app')
    } finally {
      await reg.withdraw('9').catch(() => {})
      dev.close()
    }
  })

  test('probePreviewPage: an HTTP answer passes with its status, unjudged', async () => {
    const dev = http.createServer((req, res) => { res.writeHead(404); res.end('no such page') })
    await new Promise((r) => dev.listen(0, '127.0.0.1', r))
    try {
      const p = await probePreviewPage('127.0.0.1', dev.address().port, { path: '/gone' })
      assert.deepEqual(p, { ok: true, status: 404 })
    } finally {
      dev.close()
    }
  })

  test('probePreviewPage: accepted-then-reset is a refusal — the docker-proxy shape (#157)', async () => {
    const net = await import('node:net')
    const trap = net.createServer((socket) => socket.destroy())
    await new Promise((r) => trap.listen(0, '127.0.0.1', r))
    try {
      const p = await probePreviewPage('127.0.0.1', trap.address().port)
      assert.equal(p.ok, false)
      assert.ok(p.error, 'the socket error is the cause the agent is handed')
    } finally {
      trap.close()
    }
  })

  test('probePreviewPage: a wedged server reaches the bounded timeout', async () => {
    const dev = http.createServer(() => {})
    await new Promise((resolve) => dev.listen(0, '127.0.0.1', resolve))
    try {
      const p = await probePreviewPage('127.0.0.1', dev.address().port, { timeout: 25 })
      assert.deepEqual(p, { ok: true, status: null, slow: true })
    } finally {
      dev.close()
    }
  })

  test('publish refuses a page that will not answer, and the container message names the bind', async () => {
    const reg = mkReg({
      exec: fakeExec().exec,
      isLive: alwaysLive,
      log: () => {},
      probe: async () => ({ ok: false, error: 'ECONNRESET' }),
    })
    const before = FakeProxy.made.length
    const sandboxed = await reg.publish('11', 9000, { base: BASE, published: [9000, 9001, 9002] })
    assert.equal(sandboxed.ok, false)
    assert.match(sandboxed.reason, /ECONNRESET/)
    assert.match(sandboxed.reason, /0\.0\.0\.0:9000/, 'the container case names the fix')
    assert.equal(FakeProxy.made.length, before, 'the probe runs before the gate, so a refused publish stands no gate up')

    const bare = await reg.publish('12', 9000, { base: BASE })
    assert.equal(bare.ok, false)
    assert.doesNotMatch(bare.reason, /container/, 'a bare agent is not told about a container it does not have')
  })

  test('a repeat publish probes the MOVED path, and a dead server refuses the move but keeps the link', async () => {
    let probes = []
    let fail = false
    const reg = mkReg({
      exec: fakeExec().exec,
      isLive: alwaysLive,
      log: () => {},
      probe: async (target, port, { path }) => {
        probes.push(path)
        return fail ? { ok: false, error: 'ECONNREFUSED' } : { ok: true, status: 200 }
      },
    })
    const first = await reg.publish('13', 9000, { base: BASE, path: '/a' })
    assert.equal(first.ok, true)

    fail = true
    const moved = await reg.publish('13', 9000, { base: BASE, path: '/b' })
    assert.equal(moved.ok, false)
    assert.deepEqual(probes, ['/a', '/b'])
    assert.equal(reg.get('13').path, '/a', 'the standing link is untouched — the sweep owns teardown, not a failed move')
  })

  test('the preview gate rewrites Host and attach does not — the flag reaches the proxy', async () => {
    const reg = mkReg({ exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('14', 9000, { base: BASE })
    assert.equal(r.ok, true)
    assert.equal(FakeProxy.made.at(-1).rewriteHost, true)
    assert.equal(new IdentityProxy({ port: 0, targetPort: 1 }).rewriteHost, false,
      "off by default: ttyd's -O compares Origin against Host, so attach must forward it unchanged")
  })
})

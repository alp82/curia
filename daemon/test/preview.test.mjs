// Tests for src/preview.mjs — the preview-link registry (#40, implementing #8).
//
// The contract these pin:
//
//   - the daemon allocates the Serve port, never the worker;
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
} from '../src/preview.mjs'

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
    const reg = new PreviewRegistry({ reserved: [4271, 7681, 8443], exec, isLive: alwaysLive, log: () => {} })
    for (const port of [4271, 7681, 8443]) {
      const r = await reg.publish('7', port, { base: BASE })
      assert.equal(r.ok, false, `port ${port} must be refused`)
      assert.match(r.reason, /curia's own surfaces/)
    }
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0, 'no serve rule may be written for a refused port')
  })

  test('a dead dev port is refused — a rule would publish whatever binds it next', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: neverLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.ok, false)
    assert.match(r.reason, /nothing is listening/)
    assert.match(r.reason, /both 127\.0\.0\.1 and \[::1\]/, 'the refusal must say which addresses were probed — the worker cannot otherwise tell a dead server from a wrong-family bind')
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })

  test('a nonsense port is refused before anything is probed', async () => {
    const reg = new PreviewRegistry({ exec: fakeExec().exec, isLive: alwaysLive, log: () => {} })
    for (const bad of [0, -1, 70000, 'http://x', null, 3.5]) {
      assert.equal((await reg.publish('7', bad, { base: BASE })).ok, false, `${bad} must be refused`)
    }
  })

  test('an unreadable serve status refuses to allocate rather than allocating blind', async () => {
    const { exec, calls } = fakeExec({ failStatus: 'tailscaled not responding' })
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
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
    const reg = new PreviewRegistry({ exec, isLive: liveOnIpv6, log: () => {} })
    const r = await reg.publish('7', 3015, { base: BASE })
    assert.equal(r.ok, true, 'a running dev server must never be reported as absent')
    assert.equal(r.target, 'localhost')
    assert.ok(
      calls.some((c) => c === `tailscale serve --bg --https=${DEFAULT_RANGE.from} http://localhost:3015`),
      'the IPv6 case must go out as `localhost` — tailscale mangles a bracketed literal into http://::1:<port> and the proxy then 500s',
    )
  })

  test('an IPv4 dev server still gets an explicit 127.0.0.1, never a resolved name', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 3055, { base: BASE })
    assert.equal(r.target, '127.0.0.1')
    assert.ok(calls.some((c) => c.endsWith('http://127.0.0.1:3055')))
  })

  test('reserved ports are still refused whichever family answers', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ reserved: [4271], exec, isLive: liveOnIpv6, log: () => {} })
    const r = await reg.publish('7', 4271, { base: BASE })
    assert.equal(r.ok, false, 'containment is by port and must not depend on the address family')
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })
})

describe('allocation', () => {
  test('the first free port in range is taken and the rule points at the dev port', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.ok, true)
    assert.equal(r.servePort, DEFAULT_RANGE.from)
    assert.equal(r.url, `https://${BASE}:${DEFAULT_RANGE.from}/`)
    assert.ok(calls.some((c) => c === `tailscale serve --bg --https=${DEFAULT_RANGE.from} http://127.0.0.1:4321`))
  })

  test('a port already served by tailscaled is skipped — including the attach rule', async () => {
    const status = { Web: { 'h:8500': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } }
    const { exec } = fakeExec({ status })
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE })
    assert.equal(r.servePort, 8501, 'must not collide with an existing rule')
  })

  test('two tickets get two ports', async () => {
    const { exec } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const a = await reg.publish('7', 4321, { base: BASE })
    const b = await reg.publish('8', 4322, { base: BASE })
    assert.notEqual(a.servePort, b.servePort)
  })

  test('republishing the same dev port reuses the allocation instead of burning a port', async () => {
    const { exec } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const a = await reg.publish('7', 4321, { base: BASE })
    const b = await reg.publish('7', 4321, { base: BASE })
    assert.equal(b.servePort, a.servePort)
    assert.equal(b.reused, true)
    assert.equal(reg.list().length, 1)
  })

  test('a ticket moving to a new dev port withdraws its stale rule rather than leaking it', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const a = await reg.publish('7', 4321, { base: BASE })
    await reg.publish('7', 4999, { base: BASE })
    assert.ok(calls.some((c) => c === `tailscale serve --https=${a.servePort} off`), 'the stale rule must be withdrawn')
  })

  test('an exhausted range refuses rather than reusing a live port', async () => {
    const { exec } = fakeExec()
    const reg = new PreviewRegistry({ range: { from: 8500, to: 8501 }, exec, isLive: alwaysLive, log: () => {} })
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
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const a = await reg.publish('7', 4321, { base: BASE })
    await reg.withdraw('7')
    assert.equal(reg.get('7'), null)
    const b = await reg.publish('8', 4322, { base: BASE })
    assert.equal(b.servePort, a.servePort, 'the freed port is reusable')
  })

  test('"handler does not exist" is positive absence, not a failure', async () => {
    const { exec } = fakeExec({ failServe: 'error: failed to remove web serve: handler does not exist' })
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    reg.byTicket.set('7', { servePort: 8500, devPort: 4321 })
    const r = await reg.withdraw('7')
    assert.equal(r.ok, true)
    assert.equal(reg.get('7'), null)
  })

  test('a real withdrawal failure KEEPS the record — the rule is still published', async () => {
    const { exec } = fakeExec({ failServe: 'tailscaled is down' })
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    reg.byTicket.set('7', { servePort: 8500, devPort: 4321 })
    const r = await reg.withdraw('7')
    assert.equal(r.ok, false)
    assert.ok(reg.get('7'), 'dropping the record would hide a published rule from the next sweep')
  })

  test('withdrawing an unknown ticket is a no-op, not an error', async () => {
    const reg = new PreviewRegistry({ exec: fakeExec().exec, log: () => {} })
    assert.deepEqual(await reg.withdraw('nope'), { ok: true, withdrawn: false })
  })
})

describe('sweep', () => {
  test('a rule whose ticket is gone is withdrawn', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const { swept } = await reg.sweep(['8'])
    assert.equal(swept.length, 1)
    assert.ok(calls.some((c) => /serve --https=8500 off/.test(c)))
    assert.equal(reg.get('7'), null)
  })

  test('a live ticket keeps its preview', async () => {
    const { exec } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
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
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const { swept } = await reg.sweep([])
    assert.deepEqual(swept, [{ servePort: 8507, ticket: null }])
    assert.ok(calls.some((c) => /serve --https=8507 off/.test(c)))
  })

  test('rules OUTSIDE the preview range are never touched — the attach rule must survive', async () => {
    const { exec, calls } = fakeExec({ status: REAL_STATUS }) // 8443 = attach
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const { swept } = await reg.sweep([])
    assert.equal(swept.length, 0)
    assert.equal(calls.filter((c) => c.includes('off')).length, 0, 'sweeping the attach rule would kill /attach tailnet-wide')
  })

  test('an unreadable serve status SKIPS the sweep instead of withdrawing everything', async () => {
    const { exec, calls } = fakeExec({ failStatus: 'tailscaled not responding' })
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    reg.byTicket.set('7', { servePort: 8500, devPort: 4321 })
    const r = await reg.sweep([])
    assert.equal(r.skipped, true)
    assert.deepEqual(r.swept, [])
    assert.ok(reg.get('7'), 'an indeterminate read must never be treated as "no live tickets"')
    assert.equal(calls.filter((c) => c.includes('off')).length, 0)
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
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE, path: '/curia-check' })
    assert.equal(r.ok, true)
    assert.equal(r.url, `https://${BASE}:${DEFAULT_RANGE.from}/curia-check`)
    // The gate reads the STORED entry, not this return value (#54).
    assert.equal(reg.get('7').url, r.url)
  })

  test('the Serve rule is unchanged by the path — it is a display suffix, not reach', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE, path: '/curia-check' })
    assert.ok(calls.some((c) => c === `tailscale serve --bg --https=${DEFAULT_RANGE.from} http://127.0.0.1:4321`))
  })

  test('re-publishing the same port with a new path MOVES the link', async () => {
    const { exec } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    await reg.publish('7', 4321, { base: BASE })
    const b = await reg.publish('7', 4321, { base: BASE, path: '/curia-check' })
    assert.equal(b.reused, true, 'still one port')
    assert.equal(b.url, `https://${BASE}:${DEFAULT_RANGE.from}/curia-check`)
    assert.equal(reg.get('7').url, b.url, 'correcting a wrong link is why this call is made twice')
    assert.equal(reg.list().length, 1)
  })

  test('a smuggled path refuses the publish outright — no rule, no link', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: alwaysLive, log: () => {} })
    const r = await reg.publish('7', 4321, { base: BASE, path: '//evil.com/x' })
    assert.equal(r.ok, false)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
    assert.equal(reg.get('7'), null)
  })
})

// #157: a sandboxed worker's dev server runs inside its container, and the box
// reaches it only through the three ports that container publishes. So the
// allocation, not a probe, is what says the port is the worker's own.
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
    const reg = new PreviewRegistry({ exec, isLive: neverProbed, log: () => {} })
    const r = await reg.publish('7', 3000, { base: BASE, published: [9000, 9001, 9002] })
    assert.equal(r.ok, false)
    assert.match(r.reason, /9000, 9001, 9002/, 'a worker cannot discover its ports — the refusal has to state them')
    assert.match(r.reason, /0\.0\.0\.0/, 'and has to say how to bind, since a localhost bind inside the container fails silently')
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
    assert.equal(reg.get('7'), null)
  })

  test('a published port is published without probing anything', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: neverProbed, log: () => {} })
    const r = await reg.publish('7', 9001, { base: BASE, published: [9000, 9001, 9002], path: '/curia-check' })
    assert.equal(r.ok, true)
    assert.equal(r.target, '127.0.0.1', 'docker publishes on 127.0.0.1 by name — there is no address family left to discover')
    assert.ok(calls.some((c) => c === `tailscale serve --bg --https=${DEFAULT_RANGE.from} http://127.0.0.1:9001`))
    assert.equal(r.url, `https://${BASE}:${DEFAULT_RANGE.from}/curia-check`)
  })

  test("curia's own surfaces stay refused even if they reach the published set", async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ reserved: [4271], exec, isLive: neverProbed, log: () => {} })
    const r = await reg.publish('7', 4271, { base: BASE, published: [4271] })
    assert.equal(r.ok, false, 'containment is by port and no allocation may argue with it')
    assert.match(r.reason, /curia's own surfaces/)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })

  test('a worker with no published ports keeps the probe — the bare path until #158', async () => {
    const { exec, calls } = fakeExec()
    const reg = new PreviewRegistry({ exec, isLive: neverLive, log: () => {} })
    const r = await reg.publish('7', 3000, { base: BASE, published: null })
    assert.equal(r.ok, false)
    assert.match(r.reason, /nothing is listening/)
    assert.equal(calls.filter((c) => c.includes('--bg')).length, 0)
  })
})

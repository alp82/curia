// Pins for the attach surface hardening. The ttyd spawn argv is exported
// precisely so these tests can hold the security-relevant flags in place —
// nothing else would notice -O (origin check) silently disappearing.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { ttydArgv, ensureTtyd, verifiedHardenedArgv, WRAPPER_PATH, validSessionName, attachUrl, serveOff } from '../src/attach.mjs'

describe('ttyd spawn argv (hardening pins)', () => {
  test('-O (--check-origin) is present — cross-origin WebSocket upgrades must be refused', () => {
    assert.ok(ttydArgv(7681).includes('-O'))
  })

  test('binds loopback only, on the requested port', () => {
    const argv = ttydArgv(7681)
    assert.equal(argv[argv.indexOf('-i') + 1], '127.0.0.1')
    assert.equal(argv[argv.indexOf('-p') + 1], '7681')
  })

  test('serves the whitelisting wrapper by absolute path, as the last argv element', () => {
    const argv = ttydArgv(7681)
    assert.equal(argv.at(-1), WRAPPER_PATH)
    assert.ok(path.isAbsolute(WRAPPER_PATH))
  })
})

describe('listener verification predicate (W3)', () => {
  test('our own spawn argv passes all three legs', () => {
    assert.ok(verifiedHardenedArgv(ttydArgv(7681)))
  })

  test('missing origin check fails; --check-origin is accepted as equivalent to -O', () => {
    const noO = ttydArgv(7681).filter((a) => a !== '-O')
    assert.ok(!verifiedHardenedArgv(noO))
    assert.ok(verifiedHardenedArgv([...noO, '--check-origin']))
  })

  test('a wrapper+-O listener bound beyond loopback is NOT verified — -O is a browser control, not LAN auth', () => {
    const argv = ttydArgv(7681).map((a) => (a === '127.0.0.1' ? '0.0.0.0' : a))
    assert.ok(!verifiedHardenedArgv(argv))
    const noBind = ttydArgv(7681).filter((a, i, all) => a !== '-i' && all[i - 1] !== '-i') // ttyd default: all interfaces
    assert.ok(!verifiedHardenedArgv(noBind))
  })

  test('a listener without our wrapper is never verified', () => {
    assert.ok(!verifiedHardenedArgv(['ttyd', '-W', '-a', '-O', '-p', '7681', '-i', '127.0.0.1', '/usr/bin/bash']))
  })
})

describe('ensureTtyd adoption', () => {
  test('a live listener that cannot be verified as our hardened ttyd is adopted with a LOUD warning, never silently', async () => {
    const srv = net.createServer(() => {})
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = srv.address().port
    const logs = []
    try {
      const res = await ensureTtyd({ ttydPort: port, log: (m) => logs.push(String(m)) })
      // the exact shape is pinned: verified:false means the caller must not
      // publish (F3), and the shape carries no unread `spawned` flag any more
      assert.deepEqual(res, { verified: false }, 'an unverifiable listener must come back verified:false — the caller must not publish it (F3)')
      assert.ok(logs.some((m) => /UNVERIFIABLE/.test(m)), 'the adoption must be logged loudly')
    } finally {
      srv.close()
    }
  })
})

describe('serveOff withdrawal classification (residual 1)', () => {
  // Verified live on this host: with no rule asserted, `tailscale serve
  // --https=<port> off` exits 1 with "error: failed to remove web serve:
  // handler does not exist" — the COMMON case, since no rule is asserted on
  // a clean box. That is positive absence: the withdrawal's goal state
  // already holds. It must never surface as "withdrawal failed", or the
  // REMAINS PUBLISHED warning fires on every clean boot and trains the
  // operator to ignore the one time it is real.
  test('"handler does not exist" is positive absence — resolves and logs, never rejects', async () => {
    const logs = []
    const err = Object.assign(
      new Error('Command failed: tailscale serve --https=8443 off\nerror: failed to remove web serve: handler does not exist'),
      { stderr: 'error: failed to remove web serve: handler does not exist\n', code: 1 },
    )
    await serveOff({ servePort: 8443, log: (m) => logs.push(String(m)), exec: async () => { throw err } })
    assert.ok(logs.some((m) => /no serve rule to withdraw/.test(m)), 'positive absence is stated, not alarmed about')
  })

  test('any other failure still rejects — the REMAINS PUBLISHED path must stay reachable', async () => {
    await assert.rejects(
      () => serveOff({ servePort: 8443, log: () => {}, exec: async () => { throw new Error('tailscale: connect: connection refused') } }),
      /connection refused/,
    )
  })
})

describe('session-name gate', () => {
  test('validSessionName matches the wrapper regex', () => {
    assert.ok(validSessionName('curia-42'))
    assert.ok(!validSessionName('curia-42; rm -rf /'))
    assert.ok(!validSessionName('other-42'))
  })

  test('attachUrl refuses an invalid session name', () => {
    assert.throws(() => attachUrl('host.ts.net', 8443, '42; x'))
    assert.equal(attachUrl('host.ts.net', 8443, '42'), 'https://host.ts.net:8443/?arg=curia-42')
  })
})

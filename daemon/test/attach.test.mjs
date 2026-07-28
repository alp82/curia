// Pins for the attach surface hardening. The ttyd spawn argv is exported
// precisely so these tests can hold the security-relevant flags in place —
// nothing else would notice -O (origin check) silently disappearing.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import {
  ttydArgv, ensureTtyd, verifiedHardenedArgv, canonicalArgv, WRAPPER_PATH, validSessionName,
  attachUrl, serveOff, DEFAULT_INDEX, CHROME_BASENAME, indexRefusal, readIndexStamp,
  stampMeta, sha256, ttydVersion, TTYD_BIN,
} from '../src/attach.mjs'

const INDEX = '/opt/curia/attach-index.html'
const argv = (port = 7681) => ttydArgv(port, { index: INDEX })

// /proc/<pid>/cmdline as the kernel hands it back: argv[0] first, and ttyd's
// `-t key=value` already split by the NUL it wrote over the '='. This is the
// exact shape the adopt path reads, so every predicate test goes through it.
function procForm(spawnArgv, bin = TTYD_BIN) {
  return [bin, ...spawnArgv.flatMap((a) => (/^\w+=/.test(a) ? a.split('=') : [a]))]
}

describe('ttyd spawn argv (hardening pins)', () => {
  test('-O (--check-origin) is present — cross-origin WebSocket upgrades must be refused', () => {
    assert.ok(argv().includes('-O'))
  })

  test('binds loopback only, on the requested port', () => {
    const a = argv()
    assert.equal(a[a.indexOf('-i') + 1], '127.0.0.1')
    assert.equal(a[a.indexOf('-p') + 1], '7681')
  })

  test('serves the whitelisting wrapper by absolute path, as the last argv element', () => {
    assert.equal(argv().at(-1), WRAPPER_PATH)
    assert.ok(path.isAbsolute(WRAPPER_PATH))
  })

  test('#69: the renderer is dom — ttyd\'s default webgl renders a BLANK terminal in Vivaldi and Firefox', () => {
    const a = argv()
    assert.equal(a[a.indexOf('-t') + 1], 'rendererType=dom')
  })

  test('#70: the owned index is served — no flag can add the viewport meta ttyd 1.7.7 omits', () => {
    const a = argv()
    assert.equal(a[a.indexOf('-I') + 1], INDEX)
    assert.equal(a.at(-2), INDEX, 'index second to last, wrapper last')
    assert.equal(ttydArgv(7681).at(-2), DEFAULT_INDEX, 'and the shipped asset is the default')
  })
})

describe('the -t NUL trap (#69, verified live)', () => {
  // ttyd overwrites the '=' with a NUL while parsing, so a check that looks
  // for the joined form in /proc can never match — and a check that never
  // matches is the silent loss this ticket is about, one layer up.
  test('the split /proc form and the joined spawn form canonicalise the same', () => {
    assert.deepEqual(canonicalArgv(['-t', 'rendererType', 'dom']), ['-t', 'rendererType=dom'])
    assert.deepEqual(canonicalArgv(['-t', 'rendererType=dom']), ['-t', 'rendererType=dom'])
  })

  test('a listener whose cmdline is split by the NUL still verifies', () => {
    assert.ok(verifiedHardenedArgv(procForm(argv()), argv()))
  })

  test('canonicalising leaves a trailing -t alone rather than eating the wrapper', () => {
    assert.deepEqual(canonicalArgv(['-a', '-t']), ['-a', '-t'])
  })
})

describe('listener verification predicate (W3, widened by #70)', () => {
  test('our own spawn argv, as /proc reports it, verifies', () => {
    assert.ok(verifiedHardenedArgv(procForm(argv()), argv()))
  })

  test('THE #70 REGRESSION: a stock ttyd serving our wrapper passed the old three legs — it must not pass now', () => {
    // wrapper + -O + -i 127.0.0.1 and nothing else: chrome-less, rendering
    // blank in the operator's own browser, and reconcile used to publish it
    // and report it verified.
    const stock = ['-W', '-a', '-O', '-p', '7681', '-i', '127.0.0.1', WRAPPER_PATH]
    assert.ok(!verifiedHardenedArgv(procForm(stock), argv()))
  })

  test('a missing or stale -I is not the asserted surface', () => {
    const noI = argv().filter((a, i, all) => a !== '-I' && all[i - 1] !== '-I')
    assert.ok(!verifiedHardenedArgv(procForm(noI), argv()))
    const stale = argv().map((a) => (a === INDEX ? '/opt/curia/old-index.html' : a))
    assert.ok(!verifiedHardenedArgv(procForm(stale), argv()))
  })

  test('a missing or webgl renderer is not the asserted surface', () => {
    const webgl = argv().map((a) => (a === 'rendererType=dom' ? 'rendererType=webgl' : a))
    assert.ok(!verifiedHardenedArgv(procForm(webgl), argv()))
  })

  test('missing origin check fails', () => {
    assert.ok(!verifiedHardenedArgv(procForm(argv().filter((a) => a !== '-O')), argv()))
  })

  test('--check-origin is no longer ADOPTED as equivalent — it is ours, so it is replaced instead', () => {
    // Not a weakening: the listener still serves our wrapper, so ensureTtyd
    // kills and respawns it with the exact asserted argv. The surface is one
    // argv now, and a spelling that means the same thing still is not it.
    const spelt = argv().map((a) => (a === '-O' ? '--check-origin' : a))
    assert.ok(!verifiedHardenedArgv(procForm(spelt), argv()))
    assert.ok(spelt.includes(WRAPPER_PATH), 'still positively ours — the kill branch, not the adopt branch')
  })

  test('a wrapper+-O listener bound beyond loopback is NOT verified — -O is a browser control, not LAN auth', () => {
    assert.ok(!verifiedHardenedArgv(procForm(argv().map((a) => (a === '127.0.0.1' ? '0.0.0.0' : a))), argv()))
    const noBind = argv().filter((a, i, all) => a !== '-i' && all[i - 1] !== '-i') // ttyd default: all interfaces
    assert.ok(!verifiedHardenedArgv(procForm(noBind), argv()))
  })

  test('a listener without our wrapper is never verified', () => {
    const bare = argv().map((a) => (a === WRAPPER_PATH ? '/usr/bin/bash' : a))
    assert.ok(!verifiedHardenedArgv(procForm(bare), argv()))
  })

  test('extra flags are not tolerated — the argv is the whole statement', () => {
    assert.ok(!verifiedHardenedArgv(procForm([...argv(), '-c', 'a:b']), argv()))
  })
})

describe('the built index asset (#70)', () => {
  let tmp
  const write = (stamp, chrome) => {
    tmp = tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'curia-attach-'))
    const dir = fs.mkdtempSync(path.join(tmp, 'a-'))
    const index = path.join(dir, 'attach-index.html')
    fs.writeFileSync(index, `<!DOCTYPE html><html><head>${stamp ?? ''}</head><body></body></html>`)
    if (chrome !== null) fs.writeFileSync(path.join(dir, CHROME_BASENAME), chrome ?? 'chrome')
    return index
  }
  const stampFor = (ttyd, chrome) => stampMeta({ ttyd, chrome: sha256(chrome) })

  test('the shipped asset is a real built index, and the daemon accepts it', () => {
    // Not a mock: this is the file ttyd is actually spawned with. If the
    // committed asset ever goes stale against the committed chrome source,
    // this fails in CI instead of blanking a terminal on a phone.
    const stamp = readIndexStamp(DEFAULT_INDEX)
    assert.ok(stamp?.ttyd, 'the shipped index must carry its stamp')
    assert.equal(stamp.chrome, sha256(fs.readFileSync(path.join(path.dirname(DEFAULT_INDEX), CHROME_BASENAME))),
      'the committed index was built from a different attach-chrome.html — run `npm run build-attach-index`')
    assert.equal(indexRefusal({ indexFile: DEFAULT_INDEX, log: () => {}, version: () => stamp.ttyd }), null)
  })

  test('the shipped asset carries the viewport meta and the key-bar', () => {
    const head = fs.readFileSync(DEFAULT_INDEX, 'utf8').slice(0, 8192)
    assert.match(head, /<meta name="viewport" content="width=device-width/, 'ttyd 1.7.7 ships none and no flag can add one')
    assert.match(fs.readFileSync(DEFAULT_INDEX, 'utf8'), /id="curia-keybar"/, 'spike #32\'s key-bar, lost twice already')
  })

  test('an absent index refuses, naming the build command', () => {
    assert.match(indexRefusal({ indexFile: '/nope/attach-index.html', log: () => {} }), /does not exist.*build-attach-index/s)
  })

  test('an unstamped page refuses — it was not built by us', () => {
    assert.match(indexRefusal({ indexFile: write(null), log: () => {} }), /carries no curia-attach-index stamp/)
  })

  test('an index built for a different ttyd refuses — it embeds that ttyd\'s whole client bundle', () => {
    const f = write(stampFor('1.7.7-40e79c7', 'chrome'), 'chrome')
    assert.match(indexRefusal({ indexFile: f, log: () => {}, version: () => '1.8.0-deadbee' }), /built for ttyd 1\.7\.7-40e79c7 but ttyd 1\.8\.0-deadbee is installed/)
  })

  test('an index built from a different chrome source refuses — the reviewed diff is not the served one', () => {
    const f = write(stampFor('1.7.7', 'old chrome'), 'edited chrome')
    assert.match(indexRefusal({ indexFile: f, log: () => {}, version: () => '1.7.7' }), /built from a different attach-chrome\.html/)
  })

  test('A FAILED READ IS NOT EVIDENCE: an unreadable ttyd version does not take attach down', () => {
    const logs = []
    const f = write(stampFor('1.7.7', 'chrome'), 'chrome')
    assert.equal(indexRefusal({ indexFile: f, log: (m) => logs.push(m), version: () => null }), null)
    assert.ok(logs.some((m) => /NOT treating that as a mismatch/.test(m)), 'the open question is stated, not acted on')
  })

  test('A FAILED READ IS NOT EVIDENCE: no chrome source beside a custom index does not take attach down', () => {
    const logs = []
    const f = write(stampFor('1.7.7', 'chrome'), null)
    assert.equal(indexRefusal({ indexFile: f, log: (m) => logs.push(m), version: () => '1.7.7' }), null)
    assert.ok(logs.some((m) => /NOT treating that as a mismatch/.test(m)))
  })

  test('ttydVersion reads the installed binary, and returns null rather than throwing when it cannot', (t) => {
    assert.equal(ttydVersion('/nonexistent/ttyd'), null)
    if (!fs.existsSync(TTYD_BIN)) return t.skip(`no ttyd at ${TTYD_BIN}`)
    assert.match(ttydVersion(), /^\d+\.\d+\.\d+/)
  })
})

describe('ensureTtyd adoption', () => {
  test('a stale index refuses BEFORE anything is spawned or published', async () => {
    const logs = []
    const res = await ensureTtyd({ ttydPort: 1, index: '/nope/attach-index.html', log: (m) => logs.push(String(m)) })
    assert.deepEqual(res, { verified: false }, 'the caller must not publish a surface nobody agreed to')
    assert.ok(logs.some((m) => /refusing to publish the attach surface/.test(m)))
  })

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

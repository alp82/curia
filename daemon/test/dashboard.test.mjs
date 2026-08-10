// The dashboard sidecar (#263, building the where-it-lives decision #249).
//
// Four things are worth pinning here, and they are the four the ticket names:
// the `dashboard:` block and its place in the collision check, the sidecar's
// own read of that same file, the identity gate in front of its server, and the
// poll policy — one read per interval no matter how many tabs ask, and a failed
// read that keeps the last snapshot behind the restarting marker instead of
// blanking the page.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  DashboardSurface, DEFAULT_DASHBOARD, DEFAULT_DASHBOARD_INDEX, DASHBOARD_PROTO,
  loadDashboardConfig, pageRefusal, readDashboard, daemonPort,
} from '../src/dashboard.mjs'
import { loadCuriaConfig } from '../src/config.mjs'
import { serveHosts, LOGIN_HEADER, FUNNEL_HEADER } from '../src/identity.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'

// One temp dir for the whole file: the page-stamp cases write fixtures the
// serve-rule cases read back, so it must outlive any one describe.
let tmp
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-dash-')) })
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// Host is exactly what these tests must vary, and `fetch` forbids setting it.
function req(port, p, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, setHost: false }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => resolve({ status: res.statusCode, text: buf }))
    })
    r.on('error', reject)
    r.end()
  })
}

describe('the `dashboard:` block (#263)', () => {
  // A whole valid config, so any failure names the dashboard and not a
  // neighbour section.
  function writeConfig(dashboardYaml = '', extra = '') {
    const skills = skillsYaml(seedSkillsRoot(tmp)).join('\n')
    const file = path.join(tmp, `curia-${Math.random().toString(36).slice(2)}.yaml`)
    fs.writeFileSync(file, [
      'watch:', '  - repo: o/r',
      'dispatch:',
      '  auto_dispatch: false', '  max_concurrent: 2', '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work')}`, '  ready_timeout_s: 45',
      'attach:', '  ttyd_port: 7681', '  serve_port: 8443',
      'identity:', '  allow: [Tester@Example.com]',
      dashboardYaml, extra, skills, ...sandboxYaml(), '',
    ].join('\n'))
    return file
  }

  test('an omitted section is the shipped surface, not a missing one', () => {
    const cfg = loadCuriaConfig(writeConfig())
    assert.equal(cfg.dashboard.port, DEFAULT_DASHBOARD.port)
    assert.equal(cfg.dashboard.serve_port, DEFAULT_DASHBOARD.serve_port)
    assert.equal(cfg.dashboard.poll_interval_s, DEFAULT_DASHBOARD.poll_interval_s)
  })

  test('the operator answer #263 settled: 5s, and it is the shipped default', () => {
    assert.equal(DEFAULT_DASHBOARD.poll_interval_s, 5)
  })

  test('the two ports join the collision check — a shadowed surface is a config error, not an outage', () => {
    for (const [key, port, other] of [
      ['dashboard.port', 4272, 'timeline.port'],
      ['dashboard.port', 7681, 'attach.ttyd_port'],
      ['dashboard.serve_port', 8443, 'attach.serve_port'],
      ['dashboard.serve_port', 8444, 'timeline.serve_port'],
      ['dashboard.serve_port', 7682, 'identity.proxy_port'],
    ]) {
      assert.throws(
        () => loadCuriaConfig(writeConfig(`dashboard:\n  ${key.split('.')[1]}: ${port}`)),
        new RegExp(`${key.replace('.', '\\.')}.*${other.replace('.', '\\.')}|${other.replace('.', '\\.')}.*${key.replace('.', '\\.')}`),
        `${key}=${port} collides with ${other}`,
      )
    }
  })

  test('the two ports cannot sit in the preview range — the sweep would withdraw the console', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig('dashboard:\n  serve_port: 8550', 'preview:\n  port_from: 8500\n  port_to: 8599')),
      /preview range 8500-8599 contains dashboard\.serve_port/,
    )
  })

  test('the two ports cannot sit in the sandbox range — a container would publish over them', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig('dashboard:\n  port: 9100', 'preview:\n  port_from: 8500\n  port_to: 8599')),
      /sandbox port range .* contains dashboard\.port/,
    )
  })

  test('a poll interval that is not a positive number refuses the boot, naming what it costs', () => {
    for (const bad of ['0', '-5', '"soon"']) {
      assert.throws(
        () => loadCuriaConfig(writeConfig(`dashboard:\n  poll_interval_s: ${bad}`)),
        /dashboard\.poll_interval_s must be a positive number/,
      )
    }
  })

  test('a port that is not a port refuses the boot', () => {
    assert.throws(() => loadCuriaConfig(writeConfig('dashboard:\n  port: 70000')), /dashboard\.port must be a port number/)
  })

  // ---- the sidecar's own read of the same file ------------------------------

  test('the sidecar reads its block and the allowlist out of the one config file', () => {
    const { dashboard, allow } = loadDashboardConfig(writeConfig('dashboard:\n  port: 4273\n  poll_interval_s: 5'))
    assert.equal(dashboard.port, 4273)
    assert.equal(dashboard.serve_port, DEFAULT_DASHBOARD.serve_port)
    assert.equal(dashboard.poll_interval_s, 5)
    // Normalized by the same rule the daemon applies, in the same module: the
    // two processes must admit exactly the same people.
    assert.deepEqual(allow, ['tester@example.com'])
  })

  test('an empty allowlist refuses the sidecar too — a surface that admits nobody must not start', () => {
    const file = path.join(tmp, 'no-allow.yaml')
    fs.writeFileSync(file, 'identity:\n  allow: []\n')
    assert.throws(() => loadDashboardConfig(file), /identity\.allow must be a non-empty list/)
  })

  test('the sidecar does NOT check the daemon\'s filesystem — its container mounts none of it', () => {
    // The whole reason loadDashboardConfig exists beside loadCuriaConfig. This
    // config names skills that are not installed and no sandbox section at all,
    // so the daemon's loader refuses it — and the sidecar, which can see
    // neither the skills root nor the agent Dockerfile, must not pretend to
    // have an opinion about them.
    const file = path.join(tmp, 'daemon-only.yaml')
    fs.writeFileSync(file, [
      'watch:', '  - repo: o/r',
      'identity:', '  allow: [tester@example.com]',
      'skills:', '  root: /nowhere/at/all', '  install: [wayfinder]',
      'dashboard:', '  port: 4273', '',
    ].join('\n'))
    assert.throws(() => loadCuriaConfig(file), /skills\.install names "wayfinder"|`sandbox:` section is required|`dispatch` section missing/)
    assert.equal(loadDashboardConfig(file).dashboard.port, 4273)
  })

  test('the daemon port is read, never written into the yaml as a second copy', () => {
    assert.equal(daemonPort(), Number(process.env.PORT ?? 4271))
  })

  test('readDashboard refuses a section that is not a mapping', () => {
    assert.throws(() => readDashboard({ dashboard: [1, 2] }, (m) => { throw new Error(m) }), /`dashboard` must be a mapping/)
  })
})

describe('the page stamp (#263, #70\'s rule)', () => {
  test('the shipped page speaks the proto this sidecar speaks', () => {
    assert.equal(pageRefusal(DEFAULT_DASHBOARD_INDEX), null)
    assert.match(fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8'), /content="proto=\d+"/)
  })

  test('a page with no stamp is not a page this server speaks', () => {
    const f = path.join(tmp, 'nostamp.html')
    fs.writeFileSync(f, '<title>whatever</title>')
    assert.match(pageRefusal(f), /carries no curia-dashboard proto stamp/)
  })

  test('a page from another proto refuses, naming both numbers', () => {
    const f = path.join(tmp, 'oldproto.html')
    fs.writeFileSync(f, `<meta name="curia-dashboard" content="proto=${DASHBOARD_PROTO + 7}">`)
    assert.match(pageRefusal(f), new RegExp(`speaks proto ${DASHBOARD_PROTO + 7} but this sidecar speaks proto ${DASHBOARD_PROTO}`))
  })

  test('an unreadable page refuses rather than serving nothing quietly', () => {
    assert.match(pageRefusal(path.join(tmp, 'gone.html')), /is not readable/)
  })
})

describe('the sidecar surface (#263)', () => {
  let surface
  let reads // one entry per read of the daemon
  let answer // what the fake daemon returns, or throws

  const ALLOW = ['alp@example.com']
  const SERVE_PORT = 8445
  const HOSTS = serveHosts({ dnsName: 'box.tail1234.ts.net.', ips: ['100.98.118.33'], servePort: SERVE_PORT })
  // What Tailscale Serve actually stamps on a request it proxies (#151 fact 1).
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })

  const OVERVIEW = {
    at: '2026-08-10T12:00:00.000Z',
    daemon: { port: 4271, uptime_s: 90, auto_dispatch: false, max_concurrent: 6 },
    agents: [{ session: 'curia-263' }],
    escalations: [], review_gate: [], events: [], bridge: 'up',
    frontier: { computed_at: '2026-08-10T11:59:00.000Z', repos: [] },
  }

  beforeEach(async () => {
    reads = []
    answer = () => structuredClone(OVERVIEW)
    surface = new DashboardSurface({
      port: 0,
      servePort: SERVE_PORT,
      index: DEFAULT_DASHBOARD_INDEX,
      allow: ALLOW,
      pollIntervalS: 5,
      log: () => {},
      deps: {
        fetchOverview: async () => { reads.push(Date.now()); return answer() },
        assertServe: async () => {},
        serveOff: async () => {},
        tailnetSelf: async () => ({ dnsName: 'box.tail1234.ts.net', ips: ['100.98.118.33'] }),
      },
    })
    const { verified } = await surface.start()
    assert.equal(verified, true)
    // The gate refuses everyone until the surface knows its own names, so the
    // request tests resolve them first — exactly as assert() does at boot.
    await surface.resolveHosts()
  })

  // Per test, not per describe: each case binds its own listener, and one left
  // open holds the whole run's event loop.
  afterEach(() => surface?.stop())

  test('it knows the names it answers to, and only those', () => {
    assert.deepEqual([...surface.hosts].sort(), [...HOSTS].sort())
  })

  // ---- the identity gate ---------------------------------------------------

  test('a request Serve stamped, on a name this box serves, is admitted', async () => {
    const res = await req(surface.port, '/api/overview', { headers: served() })
    assert.equal(res.status, 200)
  })

  test('no Serve identity header ⇒ 403: the console is not reachable by anything on loopback', async () => {
    const res = await req(surface.port, '/api/overview', { headers: { host: 'box.tail1234.ts.net:8445' } })
    assert.equal(res.status, 403)
    assert.match(res.text, /did not arrive through Tailscale Serve/)
  })

  test('a login that is not on the allowlist ⇒ 403', async () => {
    const res = await req(surface.port, '/', { headers: served({ [LOGIN_HEADER]: 'stranger@example.com' }) })
    assert.equal(res.status, 403)
    assert.match(res.text, /is not on the identity allowlist/)
  })

  test('a Host this box does not serve ⇒ 403, which is the rebinding shape', async () => {
    const res = await req(surface.port, '/', { headers: served({ host: 'evil.example.com' }) })
    assert.equal(res.status, 403)
    assert.match(res.text, /is not a name this box serves/)
  })

  test('a request that arrived over Funnel ⇒ 403: no curia surface is for the public internet', async () => {
    const res = await req(surface.port, '/', { headers: served({ [FUNNEL_HEADER]: 'true' }) })
    assert.equal(res.status, 403)
  })

  test('the gate is in front of the PAGE too, not only the data', async () => {
    const page = await req(surface.port, '/', { headers: served() })
    assert.equal(page.status, 200)
    assert.match(page.text, /curia-dashboard/)
    const bare = await req(surface.port, '/', { headers: { host: 'box.tail1234.ts.net:8445' } })
    assert.equal(bare.status, 403)
  })

  test('this surface reads and does not write', async () => {
    const res = await req(surface.port, '/api/overview', { method: 'POST', headers: served() })
    assert.equal(res.status, 405)
  })

  // ---- the poll ------------------------------------------------------------

  test('the first read fills the snapshot and the page draws it', async () => {
    const res = await req(surface.port, '/api/overview', { headers: served() })
    const body = JSON.parse(res.text)
    assert.equal(reads.length, 1)
    assert.equal(body.daemon_up, true)
    assert.equal(body.poll_interval_s, 5)
    assert.equal(body.overview.daemon.max_concurrent, 6)
    assert.ok(body.read_at, 'the page states the age of the reading, so the reading is stamped')
  })

  test('many tabs inside one interval cost the daemon ONE journal read', async () => {
    await Promise.all(Array.from({ length: 8 }, () => req(surface.port, '/api/overview', { headers: served() })))
    await req(surface.port, '/api/overview', { headers: served() })
    assert.equal(reads.length, 1, 'the age check answers them all, and one in-flight refresh is shared')
  })

  test('a snapshot older than the interval is re-read', async () => {
    await req(surface.port, '/api/overview', { headers: served() })
    surface.snapshotAt -= 5_000 // the interval has passed
    await req(surface.port, '/api/overview', { headers: served() })
    assert.equal(reads.length, 2)
  })

  test('nobody asking costs nothing — the sidecar holds no timer of its own', async () => {
    await req(surface.port, '/api/overview', { headers: served() })
    surface.snapshotAt -= 60_000
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(reads.length, 1, 'a hidden tab stops asking, and the read stops with it')
  })

  // ---- the restarting marker ----------------------------------------------

  test('a daemon that stops answering keeps the last snapshot behind the marker', async () => {
    await req(surface.port, '/api/overview', { headers: served() })
    answer = () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4271') }
    surface.snapshotAt -= 5_000
    const res = await req(surface.port, '/api/overview', { headers: served() })
    const body = JSON.parse(res.text)
    assert.equal(res.status, 200, 'the page must not blank at the moment the box is most interesting')
    assert.equal(body.daemon_up, false)
    assert.match(body.error, /ECONNREFUSED/)
    assert.ok(body.error_since)
    assert.equal(body.overview.daemon.max_concurrent, 6, 'the last reading still stands')
  })

  test('the marker clears when the daemon comes back, and the reading moves again', async () => {
    await req(surface.port, '/api/overview', { headers: served() })
    answer = () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4271') }
    surface.snapshotAt -= 5_000
    await req(surface.port, '/api/overview', { headers: served() })
    answer = () => ({ ...structuredClone(OVERVIEW), daemon: { ...OVERVIEW.daemon, uptime_s: 3 } })
    surface.snapshotAt -= 5_000
    const body = JSON.parse((await req(surface.port, '/api/overview', { headers: served() })).text)
    assert.equal(body.daemon_up, true)
    assert.equal(body.error, null)
    assert.equal(body.overview.daemon.uptime_s, 3, 'a restarted daemon reads as a fresh uptime, not a stale one')
  })

  test('a first read that never succeeds says so without inventing a snapshot', async () => {
    answer = () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4271') }
    const body = JSON.parse((await req(surface.port, '/api/overview', { headers: served() })).text)
    assert.equal(body.daemon_up, false)
    assert.equal(body.overview, null, 'null is "not read", and it must never render as an idle box')
    assert.equal(body.read_at, null)
  })

  // ---- the serve rule ------------------------------------------------------

  test('the rule goes up over a verified surface', async () => {
    const asserted = []
    surface.deps.assertServe = async (a) => asserted.push(a)
    assert.deepEqual(await surface.assert(), { verified: true })
    assert.deepEqual(asserted, [{ servePort: SERVE_PORT, targetPort: surface.port }])
  })

  test('a page this server does not speak withdraws the rule instead of publishing it', async () => {
    const off = []
    surface.deps.serveOff = async (a) => off.push(a.servePort)
    surface.deps.assertServe = async () => assert.fail('nothing unverified is ever published')
    surface.index = path.join(tmp, 'unstamped-for-assert.html')
    fs.writeFileSync(surface.index, '<title>a page nobody agreed to</title>')
    const { verified, refusal } = await surface.assert()
    assert.equal(verified, false)
    assert.match(refusal, /proto stamp/)
    assert.deepEqual(off, [SERVE_PORT], 'a serve rule persists in tailscaled, so skipping the assert un-publishes nothing')
  })

  test('a listener that is down withdraws the rule too', async () => {
    const off = []
    surface.deps.serveOff = async (a) => off.push(a.servePort)
    surface.deps.assertServe = async () => assert.fail('nothing unverified is ever published')
    surface.listening = false
    assert.equal((await surface.assert()).verified, false)
    assert.deepEqual(off, [SERVE_PORT])
    surface.listening = true
  })

  test('an unresolvable tailnet name withdraws the rule — the gate would refuse everyone', async () => {
    const off = []
    surface.deps.serveOff = async (a) => off.push(a.servePort)
    surface.deps.assertServe = async () => assert.fail('a surface that cannot verify its own name publishes nothing')
    surface.deps.tailnetSelf = async () => { throw new Error('tailscaled is not answering') }
    const { verified, refusal } = await surface.assert()
    assert.equal(verified, false)
    assert.match(refusal, /tailscaled is not answering/)
    assert.deepEqual(off, [SERVE_PORT])
  })

  test('the link is composed from the box\'s own name, never hand-written (#68)', async () => {
    surface.deps.attachBase = async () => 'box.tail1234.ts.net'
    assert.equal(await surface.link(), `https://box.tail1234.ts.net:${SERVE_PORT}/`)
  })
})

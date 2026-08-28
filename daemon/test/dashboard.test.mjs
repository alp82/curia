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
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {
  DashboardSurface, DEFAULT_DASHBOARD, DEFAULT_DASHBOARD_INDEX, DASHBOARD_PROTO,
  loadDashboardConfig, pageRefusal, readDashboard, daemonPort, ANSWER_REFUSAL, MAX_WORDS, CHAT_PAGE, TERMINAL_PAGE,
} from '../src/dashboard.mjs'
import { loadCuriaConfig } from '../src/config.mjs'
import { serveHosts, LOGIN_HEADER, FUNNEL_HEADER } from '../src/identity.mjs'
import { readSettings } from '../src/settings.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'

// One temp dir for the whole file: the page-stamp cases write fixtures the
// serve-rule cases read back, so it must outlive any one describe.
let tmp
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-dash-')) })
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// Host is exactly what these tests must vary, and `fetch` forbids setting it.
function req(port, p, { headers = {}, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, setHost: false }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf }))
    })
    r.on('error', reject)
    if (body !== null) r.write(typeof body === 'string' ? body : JSON.stringify(body))
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
      '  claim_login: alp82',
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
    const { dashboard, allow, terminalPort } = loadDashboardConfig(writeConfig('dashboard:\n  port: 4273\n  poll_interval_s: 5'))
    assert.equal(dashboard.port, 4273)
    assert.equal(dashboard.serve_port, DEFAULT_DASHBOARD.serve_port)
    assert.equal(dashboard.poll_interval_s, 5)
    // Normalized by the same rule the daemon applies, in the same module: the
    // two processes must admit exactly the same people.
    assert.deepEqual(allow, ['tester@example.com'])
    assert.equal(terminalPort, 7681)
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

  // #265 gave this surface two write routes. Everything else on it still reads,
  // and a write is judged as a write BEFORE anyone looks at where it points.
  test('a POST to a read route is not a route, whoever sends it', async () => {
    const res = await req(surface.port, '/api/overview', {
      method: 'POST', headers: served({ origin: 'https://box.tail1234.ts.net:8445' }),
    })
    assert.equal(res.status, 404)
  })

  test('a method that is neither GET nor POST is refused', async () => {
    const res = await req(surface.port, '/api/overview', { method: 'DELETE', headers: served() })
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
    assert.equal(body.operator, 'alp@example.com', 'the browser keys its durable Feed marker to this login')
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

// ---------------------------------------------------------------------------
// the write surface (#265)
// ---------------------------------------------------------------------------
//
// #263 left this surface read-only. #265 gives it two write routes, and the
// three things worth pinning are the three that are not visible on a preview:
// a write carries a second gate the identity header cannot stand in for, the
// settings read is a fresh read of disk rather than the poll snapshot, and the
// restart order goes to the daemon rather than being taken here.
describe('the settings write and the restart (#265)', () => {
  let surface
  let daemon
  let daemonCalls
  let cfgDir
  let reloadAnswer
  let aistackAnswer
  let overviewAnswer
  const ALLOW = ['alp@example.com']
  const SERVE_PORT = 8445
  const ORIGIN = 'https://box.tail1234.ts.net:8445'
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })
  const writes = (extra = {}) => served({ origin: ORIGIN, 'content-type': 'application/json', ...extra })

  beforeEach(async () => {
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-dash-cfg-'))
    const skills = skillsYaml(seedSkillsRoot(cfgDir)).join('\n')
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:', '  - repo: o/r # the one with the map',
      'dispatch:',
      '  auto_dispatch: false', '  max_concurrent: 2', '  poll_interval_s: 60',
      `  workspace_root: ${path.join(cfgDir, 'work')}`, '  ready_timeout_s: 45',
      '  claim_login: alp82',
      'attach:', '  ttyd_port: 7681', '  serve_port: 8443',
      'identity:', '  allow: [alp@example.com]',
      skills, ...sandboxYaml(), '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:', '  untyped: opus',
      'models:', '  opus: { provider: anthropic, harness: claude }',
      'harnesses:', '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
      "    ready: 'bypass permissions'", '    tool_channel_grace_s: 15', '',
    ].join('\n'))

    // A stand-in daemon on loopback, so the restart and the repo list are
    // proved to CROSS the wire rather than being taken on this side of it.
    daemonCalls = []
    // What the stand-in daemon answers `POST /reload` with. A test that cares
    // about one outcome sets this; the ordinary answer is the applied one.
    reloadAnswer = { ok: true, applied: ['dispatch.max_concurrent'], loaded_at: new Date().toISOString() }
    // What it answers on the aistack routes (#706). The daemon is the process
    // that holds the credential, so this side never composes one of these.
    aistackAnswer = { ok: true, registered: false, flow: { phase: 'unregistered' }, sync: { last: null, alarm: null } }
    overviewAnswer = async () => ({ daemon: { port: 4271 }, agents: [] })
    daemon = http.createServer((r, res) => {
      daemonCalls.push({ method: r.method, url: r.url, origin: r.headers.origin ?? null })
      res.writeHead(200, { 'content-type': 'application/json' })
      if (r.url === '/repos') return res.end(JSON.stringify({ login: 'alp82', repos: ['o/r', 'o/other'], error: null }))
      if (r.url === '/settings/action') return res.end(JSON.stringify({
        action: {
          action_id: 'atlas-settings-sidecar-1', kind: 'settings-save', target: 'curia.local.yaml',
          conflict_key: 'settings:curia.local.yaml', status: 'progress', progress: 'Writing curia.local.yaml', revision: 1,
        },
      }))
      if (r.url === '/settings/action/finish') return res.end(JSON.stringify({
        action: {
          action_id: 'atlas-settings-no-change-1', kind: 'settings-save', target: 'curia.local.yaml',
          conflict_key: 'settings:curia.local.yaml', status: 'confirmed', revision: 2,
          receipt: { written: [], applied: [] },
        },
      }))
      if (r.url === '/reload') return res.end(JSON.stringify(reloadAnswer))
      if (r.url.startsWith('/aistack')) return res.end(JSON.stringify(aistackAnswer))
      res.end(JSON.stringify({ ok: true, exit_code: 75 }))
    })
    await new Promise((done) => daemon.listen(0, '127.0.0.1', done))

    surface = new DashboardSurface({
      port: 0,
      servePort: SERVE_PORT,
      index: DEFAULT_DASHBOARD_INDEX,
      allow: ALLOW,
      pollIntervalS: 5,
      daemonPort: daemon.address().port,
      curiaFile: path.join(cfgDir, 'curia.yaml'),
      routingFile: path.join(cfgDir, 'routing.yaml'),
      log: () => {},
      deps: {
        fetchOverview: () => overviewAnswer(),
        assertServe: async () => {},
        serveOff: async () => {},
        tailnetSelf: async () => ({ dnsName: 'box.tail1234.ts.net', ips: ['100.98.118.33'] }),
      },
    })
    await surface.start()
    await surface.resolveHosts()
  })

  afterEach(() => {
    surface?.stop()
    daemon?.close()
    fs.rmSync(cfgDir, { recursive: true, force: true })
  })

  // ---- the second gate -----------------------------------------------------

  // The identity header proves whose BROWSER this is. It cannot prove which
  // page told it to call: Serve stamps the operator's own login on a request a
  // page from anywhere made to this URL. So a write needs the origin too.
  test('a write with no Origin is refused, even carrying the operator\'s own identity', async () => {
    const res = await req(surface.port, '/api/settings', {
      method: 'POST', headers: served({ 'content-type': 'application/json' }), body: { dispatch: { max_concurrent: 3 } },
    })
    assert.equal(res.status, 403)
    assert.match(res.text, /must carry an Origin header/)
    assert.equal(readSettings({ curiaFile: path.join(cfgDir, 'curia.yaml'), routingFile: path.join(cfgDir, 'routing.yaml') })
      .dispatch.max_concurrent, 2, 'nothing was written')
  })

  test('a write from another origin is refused — the identity header does not answer this', async () => {
    const res = await req(surface.port, '/api/settings', {
      method: 'POST',
      headers: served({ origin: 'https://evil.example.com', 'content-type': 'application/json' }),
      body: { dispatch: { max_concurrent: 3 } },
    })
    assert.equal(res.status, 403)
    assert.match(res.text, /is not this console/)
  })

  test('a write that says it crossed sites is refused', async () => {
    const res = await req(surface.port, '/api/settings', {
      method: 'POST', headers: writes({ 'sec-fetch-site': 'cross-site' }), body: {},
    })
    assert.equal(res.status, 403)
    assert.match(res.text, /crossed sites/)
  })

  test('the identity gate still runs first: a stranger with a good Origin gets nowhere', async () => {
    const res = await req(surface.port, '/api/settings', {
      method: 'POST',
      headers: writes({ [LOGIN_HEADER]: 'stranger@example.com' }),
      body: { dispatch: { max_concurrent: 3 } },
    })
    assert.equal(res.status, 403)
    assert.match(res.text, /is not on the identity allowlist/)
  })

  // ---- the read ------------------------------------------------------------

  test('the settings read is a fresh read of disk, never the poll snapshot', async () => {
    const first = JSON.parse((await req(surface.port, '/api/settings', { headers: served() })).text)
    assert.equal(first.dispatch.max_concurrent, 2)
    // Somebody edits the file on the box, inside the poll interval.
    const file = path.join(cfgDir, 'curia.yaml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('max_concurrent: 2', 'max_concurrent: 9'))
    const second = JSON.parse((await req(surface.port, '/api/settings', { headers: served() })).text)
    assert.equal(second.dispatch.max_concurrent, 9, 'a screen that offered to save over an unseen edit would lose it')
  })

  // ---- the save ------------------------------------------------------------

  test('a save writes the OVERRIDE, answers with the re-read, and leaves the tracked file alone', async () => {
    const tracked = path.join(cfgDir, 'curia.yaml')
    const before = fs.readFileSync(tracked, 'utf8')
    const res = await req(surface.port, '/api/settings', {
      method: 'POST', headers: writes(), body: { dispatch: { max_concurrent: 4 } },
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.text)
    // #292: git tracks curia.yaml, so a save that touched it would leave the
    // box's checkout dirty and the next deploy would refuse to fast-forward.
    assert.deepEqual(body.written, ['curia.local.yaml'])
    assert.equal(fs.readFileSync(tracked, 'utf8'), before, 'the tracked file is byte for byte what it was')
    assert.match(fs.readFileSync(path.join(cfgDir, 'curia.local.yaml'), 'utf8'), /max_concurrent: 4/)
    assert.equal(body.settings.dispatch.max_concurrent, 4, 'the answer carries what landed, not what was sent')
  })

  test('a save the loaders refuse answers 409 and says so, and the file does not move', async () => {
    const before = fs.readFileSync(path.join(cfgDir, 'curia.yaml'), 'utf8')
    const res = await req(surface.port, '/api/settings', {
      method: 'POST', headers: writes(), body: { dispatch: { max_concurrent: 500 } },
    })
    assert.equal(res.status, 409, 'the operator\'s config is wrong — this process is not')
    const body = JSON.parse(res.text)
    assert.equal(body.refused, true)
    assert.match(body.error, /sandbox ports/)
    assert.equal(fs.readFileSync(path.join(cfgDir, 'curia.yaml'), 'utf8'), before)
  })

  test('a key the screen does not write is refused at the door', async () => {
    const res = await req(surface.port, '/api/settings', {
      method: 'POST', headers: writes(), body: { sandbox: { image: 'evil' } },
    })
    assert.equal(res.status, 409)
    assert.match(res.text, /does not write/)
  })

  // ---- the apply (#362) ----------------------------------------------------
  //
  // A save applies. What is worth pinning is the seam: the sidecar asks the
  // daemon, the daemon's own answer rides back with the save, and a daemon that
  // cannot be asked is not a failed save — the file is written either way.

  const save = (body) => req(surface.port, '/api/settings', { method: 'POST', headers: writes(), body })
  const reloadCalls = () => daemonCalls.filter((c) => c.url === '/reload')

  test('a save that landed asks the daemon to apply it, and the answer rides back', async () => {
    const res = await save({ dispatch: { max_concurrent: 4 } })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.text)
    assert.deepEqual(reloadCalls(), [{ method: 'POST', url: '/reload', origin: null }])
    assert.equal(body.reload.ok, true)
    assert.deepEqual(body.reload.applied, ['dispatch.max_concurrent'])
  })

  test('a save reserves its settings paths before writing and carries one Action through reload', async () => {
    reloadAnswer = {
      ok: true,
      applied: ['dispatch.max_concurrent'],
      action: {
        action_id: 'atlas-settings-sidecar-1', kind: 'settings-save', target: 'curia.local.yaml',
        conflict_key: 'settings:curia.local.yaml', status: 'confirmed', revision: 2,
        receipt: { written: ['curia.local.yaml'], applied: ['dispatch.max_concurrent'] },
      },
    }
    const res = await save({ action_id: 'atlas-settings-sidecar-1', dispatch: { max_concurrent: 4 } })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.text)
    assert.deepEqual(daemonCalls.filter((call) => ['/settings/action', '/reload'].includes(call.url)).map((call) => call.url), [
      '/settings/action', '/reload',
    ])
    assert.equal(body.action.status, 'confirmed')
    assert.deepEqual(body.action.receipt.written, ['curia.local.yaml'])
  })

  test('a save that wrote nothing asks for nothing — the file did not move', async () => {
    const res = await save({ dispatch: { max_concurrent: 2 } })
    assert.equal(JSON.parse(res.text).written.length, 0)
    assert.equal(JSON.parse(res.text).reload, null)
    assert.deepEqual(reloadCalls(), [], 'there is nothing to apply')
  })

  test('an Action that finds no change settles without asking for a reload', async () => {
    const res = await save({ action_id: 'atlas-settings-no-change-1', dispatch: { max_concurrent: 2 } })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.text)
    assert.equal(body.action.status, 'confirmed')
    assert.deepEqual(body.action.receipt, { written: [], applied: [] })
    assert.deepEqual(daemonCalls.filter((call) => call.url.startsWith('/settings/action')).map((call) => call.url), [
      '/settings/action', '/settings/action/finish',
    ])
    assert.deepEqual(reloadCalls(), [])
  })

  test('a reload the daemon declines rides back as the decline, and the save still landed', async () => {
    reloadAnswer = {
      ok: false,
      reason: 'restart-needed',
      file: 'curia.yaml',
      key: 'sandbox.image',
      error: 'curia.yaml `sandbox.image` changed, and that key is not one a reload applies — restart the daemon to take it',
    }
    const res = await save({ dispatch: { max_concurrent: 4 } })
    assert.equal(res.status, 200, 'the save is not the thing that failed')
    const body = JSON.parse(res.text)
    assert.deepEqual(body.written, ['curia.local.yaml'])
    assert.equal(body.reload.reason, 'restart-needed')
    assert.match(body.reload.error, /sandbox\.image/)
  })

  test('a daemon that is not answering is not a failed save: the file is written, and it takes it at boot', async () => {
    await new Promise((done) => daemon.close(done))
    const res = await save({ dispatch: { max_concurrent: 4 } })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.text)
    assert.deepEqual(body.written, ['curia.local.yaml'])
    assert.equal(body.reload.reason, 'daemon-down')
    assert.match(fs.readFileSync(path.join(cfgDir, 'curia.local.yaml'), 'utf8'), /max_concurrent: 4/)
  })

  // ---- the one guard the save owes (#362) ----------------------------------

  // A watched repo removed while an agent runs on it drops out of reconcile,
  // and nothing covers that agent's claim any more. The save refuses and names
  // the agent — the operator cancels it or waits, and neither is a thing a
  // settings screen may decide for them.
  const twoRepos = () => {
    const file = path.join(cfgDir, 'curia.yaml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  - repo: o/r # the one with the map', '  - repo: o/r # the one with the map\n  - repo: o/other'))
  }

  test('removing a repo an agent is running on is refused, and the agent is named', async () => {
    twoRepos()
    overviewAnswer = async () => ({ daemon: { port: 4271 }, agents: [{ session: 'curia-362', repo: 'o/other' }] })
    const res = await save({ watch: [{ repo: 'o/r', mode: 'auto' }] })
    assert.equal(res.status, 409)
    assert.match(res.text, /o\/other cannot leave the watch list while curia-362 runs on it/)
    assert.ok(!fs.existsSync(path.join(cfgDir, 'curia.local.yaml')), 'nothing was written')
  })

  test('the same removal lands when no agent is on that repo', async () => {
    twoRepos()
    overviewAnswer = async () => ({ daemon: { port: 4271 }, agents: [{ session: 'curia-9', repo: 'o/r' }] })
    const res = await save({ watch: [{ repo: 'o/r', mode: 'auto' }] })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text).settings.watch, [{ repo: 'o/r', mode: 'auto' }])
  })

  // The evidence is the daemon's fleet, and a daemon that cannot be asked
  // leaves the guard unrun. Refusing there would take away the one thing this
  // sidecar exists for: fixing the config while the daemon is down.
  test('a fleet curia cannot read does not block the removal', async () => {
    twoRepos()
    overviewAnswer = async () => { throw new Error('the daemon did not answer /overview within 4s') }
    const res = await save({ watch: [{ repo: 'o/r', mode: 'auto' }] })
    assert.equal(res.status, 200)
  })

  test('a save that adds a repo asks the fleet nothing — only a removal owes this guard', async () => {
    let asked = 0
    overviewAnswer = async () => { asked++; return { daemon: { port: 4271 }, agents: [] } }
    const res = await save({ watch: [{ repo: 'o/r', mode: 'auto' }, { repo: 'o/other', mode: 'auto' }] })
    assert.equal(res.status, 200)
    assert.equal(asked, 0)
  })

  // ---- the restart ---------------------------------------------------------

  test('the restart is the DAEMON\'s to take: the sidecar only orders it', async () => {
    const res = await req(surface.port, '/api/restart', { method: 'POST', headers: writes(), body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(daemonCalls, [{ method: 'POST', url: '/restart', origin: null }])
  })

  test('the order carries no Origin onward — the daemon refuses every request that does', async () => {
    await req(surface.port, '/api/restart', { method: 'POST', headers: writes(), body: {} })
    assert.equal(daemonCalls[0].origin, null,
      'the sidecar composes its own call from a route it names in code, never forwards a browser\'s')
  })

  test('after a restart order the next read re-reads: a held snapshot would say `up` at the one moment that is false', async () => {
    await req(surface.port, '/api/overview', { headers: served() })
    assert.ok(surface.snapshotAt > 0)
    await req(surface.port, '/api/restart', { method: 'POST', headers: writes(), body: {} })
    assert.equal(surface.snapshotAt, 0)
  })

  test('a daemon that is not answering makes the restart an error, never a silent success', async () => {
    await new Promise((done) => daemon.close(done))
    const res = await req(surface.port, '/api/restart', { method: 'POST', headers: writes(), body: {} })
    assert.equal(res.status, 500)
    daemon = null
  })

  // ---- the repo list -------------------------------------------------------

  test('the repos come from the daemon, because this process holds no GitHub credential', async () => {
    const res = await req(surface.port, '/api/repos', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text).repos, ['o/r', 'o/other'])
    assert.deepEqual(daemonCalls, [{ method: 'GET', url: '/repos', origin: null }])
  })

  test('a daemon that cannot be asked answers null repos and a reason, never an empty list', async () => {
    await new Promise((done) => daemon.close(done))
    daemon = null
    const body = JSON.parse((await req(surface.port, '/api/repos', { headers: served() })).text)
    assert.equal(body.repos, null, 'an empty list would read as "you have no repos"')
    assert.ok(body.error)
  })

  // ---- the aistack registration (#706) -------------------------------------
  //
  // The same seam the repo list rides: the daemon holds the credential and
  // spawns the CLI, and this process relays. What is pinned is that the relay
  // adds nothing and that the browser names nothing.

  test('the registration status comes from the daemon, unedited', async () => {
    aistackAnswer = { ok: true, registered: true, machine: { proposed: 'curia.sh', servers: ['aistack.to'], at: 1 } }
    const res = await req(surface.port, '/api/aistack', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), aistackAnswer)
    assert.deepEqual(daemonCalls, [{ method: 'GET', url: '/aistack', origin: null }])
  })

  test('a daemon that cannot be asked is unknown, never "not registered"', async () => {
    await new Promise((done) => daemon.close(done))
    daemon = null
    const body = JSON.parse((await req(surface.port, '/api/aistack', { headers: served() })).text)
    assert.equal(body.ok, false, 'a false `registered` would read as an answer')
    assert.ok(body.error)
  })

  test('each press crosses the wire as a bare act — the browser names no command', async () => {
    for (const act of ['register', 'cancel', 'optin']) {
      daemonCalls = []
      const res = await req(surface.port, `/api/aistack/${act}`, {
        method: 'POST', headers: writes(), body: { version: 'latest', home: '/etc' },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(daemonCalls, [{ method: 'POST', url: `/aistack/${act}`, origin: null }],
        'the route is the whole message, and the fields the browser sent went nowhere')
    }
  })

  test('a fourth act is not a route: there are three, named in code', async () => {
    const res = await req(surface.port, '/api/aistack/login', { method: 'POST', headers: writes(), body: {} })
    assert.equal(res.status, 404)
    assert.deepEqual(daemonCalls, [], 'nothing reached the daemon')
  })

  test('a refusal from the daemon reads as one, not as this box failing', async () => {
    aistackAnswer = { ok: false, error: 'this box is already registered with aistack' }
    const res = await req(surface.port, '/api/aistack/register', { method: 'POST', headers: writes(), body: {} })
    assert.equal(res.status, 409)
    assert.match(JSON.parse(res.text).error, /already registered/)
  })
})

// The operator verbs (#266). What is pinned here is the seam, not the screen:
// the sidecar COMPOSES every daemon call from the fields the page sends, and a
// browser never hands it a command line. That is the whole reason this process
// may sit on the daemon's side of the loopback gate, so it is checked with a
// stand-in daemon that records what actually crossed the wire.
describe('the operator verbs (#266)', () => {
  let surface
  let daemon
  let calls // one entry per call the sidecar made, with the body it composed
  let reply // what the stand-in daemon answers, per route

  const ALLOW = ['alp@example.com']
  const SERVE_PORT = 8445
  const ORIGIN = 'https://box.tail1234.ts.net:8445'
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })
  const press = (p, body, extra = {}) => req(surface.port, p, {
    method: 'POST',
    headers: served({ origin: ORIGIN, 'content-type': 'application/json', ...extra }),
    body,
  })
  const sent = (route) => calls.find((c) => c.url === route)

  beforeEach(async () => {
    calls = []
    reply = {
      '/command': [200, { reply: '⚙️ `curia-266` spawned on claude-opus-5' }],
      '/answer': [200, { ok: true, record: { id: 'esc-7' } }],
      '/note': [200, { ok: true, agent: 'curia-266', id: 'note-3', after: null, mode: 'queue' }],
      '/feed/read': [200, { ok: true, by: 'alp@example.com', at: '2026-08-26T09:00:00.000Z', previous: null }],
      '/github-app/start': [200, { action: 'https://github.com/settings/apps/new', manifest: { name: 'curia-box' } }],
      '/github-app/complete?code=one-use&state=expected': [200, { ok: true, app: { id: '42', slug: 'curia-box' } }],
      '/github-app/installations': [200, { ok: true, reply: 'Read 1 installation: alp82', installations: { state: 'read' } }],
    }
    daemon = http.createServer((r, res) => {
      let buf = ''
      r.on('data', (d) => { buf += d })
      r.on('end', () => {
        calls.push({ method: r.method, url: r.url, origin: r.headers.origin ?? null, body: buf ? JSON.parse(buf) : null })
        const [code, body] = reply[r.url] ?? [404, { error: 'no such route' }]
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise((done) => daemon.listen(0, '127.0.0.1', done))

    surface = new DashboardSurface({
      port: 0,
      servePort: SERVE_PORT,
      index: DEFAULT_DASHBOARD_INDEX,
      allow: ALLOW,
      pollIntervalS: 5,
      daemonPort: daemon.address().port,
      log: () => {},
      deps: {
        fetchOverview: async () => ({ daemon: { port: 4271 } }),
        assertServe: async () => {},
        serveOff: async () => {},
        attachBase: async () => 'box.tail1234.ts.net',
        tailnetSelf: async () => ({ dnsName: 'box.tail1234.ts.net', ips: ['100.98.118.33'] }),
      },
    })
    await surface.start()
    await surface.resolveHosts()
  })

  afterEach(() => {
    surface?.stop()
    daemon?.close()
  })

  // ---- what crosses the wire -----------------------------------------------

  test('start composes the command and returns the daemon\'s first Action evidence unchanged', async () => {
    const accepted = {
      action_id: '0198f137-5664-7abc-8def-0123456789ab', kind: 'dispatch', target: 'alp82/curia#266',
      conflict_key: 'dispatch:alp82/curia#266', status: 'accepted', revision: 42,
    }
    reply['/command'] = [200, { action: accepted }]
    const res = await press('/api/start', { repo: 'alp82/curia', ticket: '266', action_id: '0198f137-5664-7abc-8def-0123456789ab' })
    assert.equal(res.status, 200)
    assert.deepEqual(sent('/command').body.text, 'start alp82/curia#266')
    assert.equal(sent('/command').body.action_id, '0198f137-5664-7abc-8def-0123456789ab')
    assert.equal(sent('/command').origin, null, 'the daemon refuses every request carrying one')
    assert.deepEqual(JSON.parse(res.text).action, accepted)
  })

  test('cancel and teleport go through the same seam, so both land in the journal', async () => {
    await press('/api/cancel', { ticket: '266' })
    assert.equal(sent('/command').body.text, 'cancel 266')
    calls = []
    await press('/api/teleport', { ticket: '266' })
    assert.equal(sent('/command').body.text, 'attach 266')
  })

  test('a chat handle is a ticket too — an agent no issue answers for is still cancellable (#241)', async () => {
    await press('/api/cancel', { ticket: 'chat-1' })
    assert.equal(sent('/command').body.text, 'cancel chat-1')
  })

  test('the operator who pressed rides every verb, so the feed names a person not a transport', async () => {
    await press('/api/start', { repo: 'o/r', ticket: '9' })
    assert.equal(sent('/command').body.by, 'alp@example.com')
    calls = []
    await press('/api/answer', { id: 'esc-7', answer: 'approve' })
    assert.equal(sent('/answer').body.by, 'alp@example.com')
    assert.equal(sent('/answer').body.via, 'dashboard', 'the surface is a fact of its own')
    calls = []
    await press('/api/note', { agent: 'curia-266', text: 'look again' })
    assert.equal(sent('/note').body.by, 'alp@example.com')
  })

  test('a Feed read is journalled under the login, and the held snapshot is dropped so the next poll carries it (#704)', async () => {
    const res = await press('/api/feed/read', {})
    assert.equal(res.status, 200)
    assert.equal(sent('/feed/read').body.by, 'alp@example.com')
    assert.equal(surface.snapshotAt, 0)
  })

  test('the note carries the mode the operator chose, and queued is what an unnamed one means', async () => {
    await press('/api/note', { agent: 'curia-266', text: 'look again', mode: 'interrupt' })
    assert.equal(sent('/note').body.mode, 'interrupt')
    calls = []
    await press('/api/note', { agent: 'curia-266', text: 'look again' })
    assert.equal(sent('/note').body.mode, 'queue')
    calls = []
    await press('/api/note', { agent: 'curia-266', text: 'look again', mode: 'nonsense' })
    assert.equal(sent('/note').body.mode, 'queue', 'anything that is not the second mode is the default')
  })

  test('GitHub App setup keeps conversion inside the daemon', async () => {
    const actionId = 'atlas-github-app-setup'
    const started = await press('/api/github-app/start', { name: 'curia-box', action_id: actionId })
    assert.equal(started.status, 200)
    // The redirect is composed from curia's own records - `attachBase()` and
    // the serve port - not from anything the caller sent.
    assert.equal(await surface.link(), 'https://box.tail1234.ts.net:8445/')
    assert.deepEqual(sent('/github-app/start').body, {
      name: 'curia-box',
      redirect_url: 'https://box.tail1234.ts.net:8445/api/github-app/complete',
      action_id: actionId,
    })

    const completed = await req(surface.port, '/api/github-app/complete?code=one-use&state=expected', { headers: served() })
    assert.equal(completed.status, 303)
    assert.equal(completed.text.includes('PRIVATE KEY'), false)
  })

  // A browser-named redirect is not a field this surface forwards, and a name
  // GitHub would refuse never reaches the daemon.
  test('the setup start forwards the name and nothing the browser said about the redirect', async () => {
    await press('/api/github-app/start', {
      name: 'curia-box', redirect_url: 'https://evil.example.com/', action_id: 'atlas-github-app-redirect',
    })
    assert.equal(sent('/github-app/start').body.redirect_url, 'https://box.tail1234.ts.net:8445/api/github-app/complete')
    calls = []
    const bad = await press('/api/github-app/start', { name: '../evil' })
    assert.equal(bad.status, 409)
    assert.equal(sent('/github-app/start'), undefined)
  })

  test('the setup start is a write: no Origin, no setup', async () => {
    const res = await req(surface.port, '/api/github-app/start', {
      method: 'POST', headers: served({ 'content-type': 'application/json' }), body: JSON.stringify({ name: 'curia-box' }),
    })
    assert.equal(res.status, 403)
    assert.match(res.text, /must carry an Origin header/)
    assert.equal(sent('/github-app/start'), undefined)
  })

  // The re-read (#762). The press carries no field the daemon acts on, and the
  // next page read is a fresh one so the owner rows show what was measured.
  test('the installation re-read reaches the daemon as a bare press and drops the snapshot', async () => {
    surface.snapshotAt = Date.now()
    const out = await press('/api/github-app/refresh', { anything: 'ignored', action_id: 'atlas-github-app-read' })
    assert.equal(out.status, 200)
    assert.equal(sent('/github-app/installations').method, 'POST')
    assert.deepEqual(sent('/github-app/installations').body, { action_id: 'atlas-github-app-read' })
    assert.equal(surface.snapshotAt, 0)
    assert.match(out.text, /Read 1 installation: alp82/)
  })

  // GitHub sends the one-use conversion code to the redirect URL, so a caller
  // who could name the redirect could name where that code lands. `Host` is
  // caller-written text, and it does not move this URL. The first press uses a
  // name this box does answer to, because that is the one the identity gate
  // lets through - the gate refuses the rest, which the second press shows.
  test('a caller-written Host header does not move the setup redirect', async () => {
    await press('/api/github-app/start', {
      name: 'curia-box', action_id: 'atlas-github-app-host',
    }, { host: '100.98.118.33:8445' })
    assert.equal(
      sent('/github-app/start').body.redirect_url,
      'https://box.tail1234.ts.net:8445/api/github-app/complete',
    )
    calls = []
    const outside = await press('/api/github-app/start', { name: 'curia-box' }, { host: 'evil.example.com' })
    assert.equal(outside.status, 403)
    assert.equal(sent('/github-app/start'), undefined, 'nothing reached the daemon at all')
  })

  // The Credentials screen's one press (#661), and the reason that screen
  // exists: the recovery from a dead model credential has no ssh in it, so the
  // act has to reach a phone. Through the command seam like every other verb,
  // so a press journals what a typed line journals.
  test('sign-in composes `reauth <provider>` — the browser names a provider, never a line', async () => {
    const res = await press('/api/reauth', { provider: 'anthropic' })
    assert.equal(res.status, 200)
    assert.equal(sent('/command').body.text, 'reauth anthropic')
    assert.equal(sent('/command').body.by, 'alp@example.com')
  })

  // The daemon refuses an unknown provider by naming what it CAN sign in, and
  // that sentence is the reply the button shows. This surface only keeps a
  // browser from writing the rest of the line.
  test('an unknown provider still reaches the daemon, because the refusal is its sentence', async () => {
    reply['/command'] = [200, { reply: '❌ curia owns no `azure` credential… It can re-authenticate: openai, anthropic' }]
    const res = await press('/api/reauth', { provider: 'azure' })
    assert.equal(res.status, 200)
    assert.equal(sent('/command').body.text, 'reauth azure')
    assert.match(JSON.parse(res.text).reply, /It can re-authenticate: openai, anthropic/)
  })

  // ---- what may not cross it -----------------------------------------------

  test('a field the daemon would parse as something else is refused HERE, before the wire', async () => {
    for (const [route, body, why] of [
      ['/api/reauth', { provider: 'openai; rm -rf /' }, /provider name/],
      ['/api/reauth', { provider: 'openai anthropic' }, /provider name/],
      ['/api/reauth', { provider: '' }, /provider name/],
      ['/api/start', { repo: 'alp82/curia; rm -rf /', ticket: '1' }, /owner\/name repo/],
      ['/api/start', { repo: 'alp82/curia', ticket: '1 model=x' }, /ticket number/],
      ['/api/cancel', { ticket: 'all' }, /ticket number/],
      ['/api/teleport', { ticket: '../1' }, /ticket number/],
      ['/api/note', { agent: 'rm -rf /', text: 'x' }, /curia session name/],
      ['/api/answer', { id: 'esc 7 x', answer: 'approve' }, /escalation id/],
    ]) {
      const res = await press(route, body)
      assert.equal(res.status, 409, `${route} ${JSON.stringify(body)}`)
      assert.match(JSON.parse(res.text).error, why)
    }
    assert.deepEqual(calls, [], 'not one of them reached the daemon')
  })

  // ---- the diff, on demand (#355) --------------------------------------------
  //
  // The one READ this surface makes that is not the poll. It follows the same
  // seam every verb above does: the browser names an escalation id or an agent,
  // and a file only by its place in the digest curia itself measured — never a
  // path, a repo, a branch or a command.

  const read = (p) => req(surface.port, p, { headers: served() })

  test('a gate asks by escalation id, and the sidecar passes exactly that', async () => {
    reply['/diff?esc=esc-9'] = [200, { agent: 'curia-9', digest: { files: 2, added: 5, deleted: 1, list: [] }, error: null }]
    const res = await read('/api/diff?esc=esc-9')
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).digest.files, 2)
    assert.equal(sent('/diff?esc=esc-9').method, 'GET')
  })

  test('a live row asks by agent, and a file by its index — nothing else crosses', async () => {
    reply['/diff?agent=curia-355&file=3'] = [200, { hunks: { text: '+one', source: 'worktree' } }]
    const res = await read('/api/diff?agent=curia-355&file=3&repo=o/r&path=/etc/passwd')
    assert.equal(res.status, 200)
    assert.ok(sent('/diff?agent=curia-355&file=3'), 'the sidecar composed the query itself')
    assert.ok(!calls.some((c) => c.url.includes('passwd')), 'a field this surface does not name must not travel')
  })

  test('global search forwards one bounded query and returns typed landing targets', async () => {
    reply['/search?q=atlas'] = [200, {
      query: 'atlas', errors: [], results: [{
        kind: 'map', id: 'o/r#9', title: 'Atlas map', snippet: 'The map frontier', age_s: 60,
        attention: null, landing: { surface: 'maps', map: 9 },
      }],
    }]

    const res = await read('/api/search?q=%20atlas%20')

    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).results[0].landing.surface, 'maps')
    assert.ok(sent('/search?q=atlas'))
    calls = []
    assert.equal((await read('/api/search?q=')).status, 400)
    assert.equal((await read('/api/search?q=' + 'x'.repeat(201))).status, 400)
    assert.deepEqual(calls, [])
  })

  test('a field the daemon would read as something else is refused here, before the wire', async () => {
    for (const [q, why] of [
      ['/api/diff', /a review gate or an agent/],
      ['/api/diff?agent=' + encodeURIComponent('rm -rf /'), /curia session name/],
      ['/api/diff?esc=' + encodeURIComponent('esc 9; ls'), /escalation id/],
      ['/api/diff?agent=curia-9&file=' + encodeURIComponent('../../etc/passwd'), /file index/],
      ['/api/diff?agent=curia-9&file=99999', /file index/],
    ]) {
      const res = await read(q)
      assert.equal(res.status, 400, q)
      assert.match(JSON.parse(res.text).error, why)
    }
    assert.deepEqual(calls, [], 'not one of them reached the daemon')
  })

  // The rule the fleet follows: an unreachable daemon is not an unchanged
  // branch, so the card says curia could not be asked.
  test('a daemon that cannot be asked answers null with its reason, never an empty digest', async () => {
    daemon.close()
    const res = await read('/api/diff?esc=esc-9')
    assert.equal(res.status, 200)
    const b = JSON.parse(res.text)
    assert.equal(b.digest, null)
    assert.ok(b.error)
  })

  // ---- the browser conversations (#333) --------------------------------------
  //
  // The Chat screen's three calls. They are not verbs: the operator catalogue
  // has no word for a browser conversation, so there is nothing for /command to
  // carry and the sidecar composes each daemon call itself.

  test('the list is read through, and an unreachable daemon answers null rather than empty', async () => {
    reply['/console'] = [200, {
      conversations: [{
        key: 'console-2', session: 'curia-console-2', opened_at: null, last_turn_at: null,
        label: 'what is takeable', ctx_pct: 31, ctx_over: false,
      }],
    }]
    const res = await req(surface.port, '/api/console', { headers: served() })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).conversations[0].key, 'console-2')

    delete reply['/console']
    const out = JSON.parse((await req(surface.port, '/api/console', { headers: served() })).text)
    assert.equal(out.conversations, null, 'curia could not be asked — which is not "you have none"')
    assert.match(out.error, /404/)
  })

  test('a new conversation is one press, and the daemon mints the number', async () => {
    reply['/console/new'] = [200, { action: { status: 'confirmed' }, key: 'console-4', session: 'curia-console-4' }]
    const res = await press('/api/console/new', { action_id: 'atlas-console-new-4' })
    assert.equal(res.status, 200)
    assert.equal(sent('/console/new').method, 'POST', 'never a GET — a page read must not spend a number')
    assert.deepEqual(sent('/console/new').body, { action_id: 'atlas-console-new-4' })
    assert.equal(JSON.parse(res.text).session, 'curia-console-4')
  })

  test('a delete names one key, and a key the daemon does not hold comes back in words', async () => {
    reply['/console/delete'] = [200, { action: { status: 'confirmed', receipt: { key: 'console-2' } } }]
    assert.equal((await press('/api/console/delete', { key: 'console-2', action_id: 'atlas-console-delete-2' })).status, 200)
    assert.deepEqual(sent('/console/delete').body, { key: 'console-2', action_id: 'atlas-console-delete-2' })

    calls = []
    reply['/console/delete'] = [409, { action: { status: 'refused', reason: 'there is no conversation `console-2`' }, error: 'there is no conversation `console-2`' }]
    const res = await press('/api/console/delete', { key: 'console-2', action_id: 'atlas-console-delete-stale' })
    assert.equal(res.status, 200, 'the sidecar carries daemon Action evidence instead of reclassifying it')
    assert.match(JSON.parse(res.text).error, /no conversation/)
  })

  test('a key the sidecar does not name is refused here, before the wire', async () => {
    for (const key of ['chat-2', 'console', 'console-2; rm -rf /', 'curia-console-2', '../2']) {
      const res = await press('/api/console/delete', { key, action_id: 'atlas-console-delete-invalid' })
      assert.equal(res.status, 409, key)
      assert.match(JSON.parse(res.text).error, /browser conversation key/)
    }
    assert.deepEqual(calls, [], 'not one of them reached the daemon')
  })

  test('`cancel all` cannot be reached from a browser — the console cancels one agent at a time', async () => {
    assert.equal((await press('/api/cancel', { ticket: 'all' })).status, 409)
    assert.deepEqual(calls, [])
  })

  test('an answer and a note with no words are refused, and neither is written', async () => {
    assert.match(JSON.parse((await press('/api/answer', { id: 'esc-7', answer: '  ' })).text).error, /no words/)
    assert.match(JSON.parse((await press('/api/note', { agent: 'curia-1', text: '' })).text).error, /no words/)
    assert.deepEqual(calls, [])
  })

  test('words longer than the bound are refused — a verb must not write an unbounded journal line', async () => {
    const res = await press('/api/note', { agent: 'curia-1', text: 'x'.repeat(MAX_WORDS + 1) })
    assert.equal(res.status, 409)
    assert.match(JSON.parse(res.text).error, /may not exceed/)
    assert.deepEqual(calls, [])
  })

  // ---- the two gates in front ----------------------------------------------

  test('a verb needs the Origin this surface serves, exactly as a save does', async () => {
    const noOrigin = await req(surface.port, '/api/start', {
      method: 'POST', headers: served({ 'content-type': 'application/json' }), body: { repo: 'o/r', ticket: '1' },
    })
    assert.equal(noOrigin.status, 403)
    const otherOrigin = await press('/api/start', { repo: 'o/r', ticket: '1' }, { origin: 'https://evil.example' })
    assert.equal(otherOrigin.status, 403)
    assert.deepEqual(calls, [], 'a verb the gate refused reaches nothing')
  })

  test('the identity gate runs first: a stranger with a good Origin presses nothing', async () => {
    const res = await req(surface.port, '/api/start', {
      method: 'POST',
      headers: { host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'stranger@example.com', origin: ORIGIN, 'content-type': 'application/json' },
      body: { repo: 'o/r', ticket: '1' },
    })
    assert.equal(res.status, 403)
    assert.deepEqual(calls, [])
  })

  test('a route this surface does not carry is a 404, not a silent nothing', async () => {
    assert.equal((await press('/api/resume', { ticket: '1' })).status, 404)
  })

  // ---- first-valid-wins, seen from a browser -------------------------------

  test('a question that is no longer open comes back as the REASON, not as a 500', async () => {
    for (const [reason, why] of Object.entries(ANSWER_REFUSAL)) {
      reply['/answer'] = [409, { ok: false, reason }]
      const res = await press('/api/answer', { id: 'esc-7', answer: 'approve' })
      assert.equal(res.status, 409, reason)
      assert.equal(JSON.parse(res.text).error, why)
      assert.equal(JSON.parse(res.text).refused, true, 'the operator fixes this, not the box')
    }
  })

  test('an index and files ride to the daemon as they are, and words are not owed beside them (#712)', async () => {
    const res = await press('/api/answer', { id: 'esc-7', index: 1, files: [{ name: 'shot.png', data: 'cG5n' }] })
    assert.equal(res.status, 200)
    const body = sent('/answer').body
    assert.equal(body.index, 1)
    assert.equal(body.answer, '')
    assert.deepEqual(body.files, [{ name: 'shot.png', data: 'cG5n' }])
    calls = []
    await press('/api/answer', { id: 'esc-7', answer: 'B', index: 'x' })
    assert.equal(sent('/answer').body.index, null, 'a shape that is no index is no index')
    assert.deepEqual(sent('/answer').body.files, [])
  })

  test('a reply of more than ten files is refused before the daemon is asked', async () => {
    const res = await press('/api/answer', { id: 'esc-7', files: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, data: 'eA==' })) })
    assert.equal(res.status, 409)
    assert.match(JSON.parse(res.text).error, /at most 10 files/)
    assert.deepEqual(calls, [])
  })

  test('a second answer carries the first receipt back to the page (#712)', async () => {
    reply['/answer'] = [409, { ok: false, reason: 'answered', receipt: { by: 'alp', via: 'button', at: 'T', answer: 'Preview' } }]
    const res = await press('/api/answer', { id: 'esc-7', answer: 'Stable' })
    assert.equal(res.status, 409)
    const body = JSON.parse(res.text)
    assert.equal(body.refused, true)
    assert.deepEqual(body.receipt, { by: 'alp', via: 'button', at: 'T', answer: 'Preview' })
  })

  test('a file refusal from the daemon reads as the daemon wrote it', async () => {
    reply['/answer'] = [400, { ok: false, reason: 'files', error: 'tool.exe: refused — curia cannot take that file type' }]
    const res = await press('/api/answer', { id: 'esc-7', answer: 'x', files: [{ name: 'tool.exe', data: 'TVo=' }] })
    assert.equal(res.status, 409)
    assert.match(JSON.parse(res.text).error, /tool\.exe: refused/)
  })

  test('a reason nobody wrote a sentence for still reads, rather than rendering blank', async () => {
    reply['/answer'] = [409, { ok: false, reason: 'something-new' }]
    assert.match(JSON.parse((await press('/api/answer', { id: 'esc-7', answer: 'x' })).text).error, /something-new/)
  })

  test('a daemon that is down makes the press an error the operator can read', async () => {
    await new Promise((done) => daemon.close(done))
    daemon = null
    const res = await press('/api/start', { repo: 'o/r', ticket: '1' })
    assert.equal(res.status, 500, 'this is the box failing, not the operator')
    assert.ok(JSON.parse(res.text).error)
  })

  // ---- the reading moves ---------------------------------------------------

  test('a verb drops the held snapshot, so the poll after a press is a fresh read', async () => {
    await surface.payload()
    assert.ok(surface.snapshotAt > 0)
    await press('/api/start', { repo: 'o/r', ticket: '1' })
    assert.equal(surface.snapshotAt, 0, 'a button that seems to do nothing for one interval is a button pressed twice')
  })

  test('a REFUSED verb leaves the snapshot alone — nothing happened to re-read', async () => {
    await surface.payload()
    const at = surface.snapshotAt
    await press('/api/start', { repo: 'not a repo', ticket: '1' })
    assert.equal(surface.snapshotAt, at)
  })
})

// ---------------------------------------------------------------------------
// the chat (#267)
// ---------------------------------------------------------------------------
//
// Chat is a page of Atlas (#711), and the sidecar hands the six routes that
// page speaks straight through to the daemon's timeline listener. What matters
// here is what the pipe does NOT do: it changes no header, so the identity the
// timeline checks in-process is the identity the browser sent, and it buffers
// nothing, so an event stream is still a stream. `/chat` is a door for the
// links an older daemon handed out: it lands on the `#chat/<session>` route.

describe('the chat (#267, a page of Atlas by #711)', () => {
  let surface
  let timeline
  let seen // one entry per request the fake timeline received

  const ALLOW = ['alp@example.com']
  const SERVE_PORT = 8445
  const ORIGIN = 'https://box.tail1234.ts.net:8445'
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })

  async function makeSurface({ timelinePort }) {
    const s = new DashboardSurface({
      port: 0,
      servePort: SERVE_PORT,
      index: DEFAULT_DASHBOARD_INDEX,
      allow: ALLOW,
      pollIntervalS: 5,
      timelinePort,
      log: () => {},
      deps: {
        fetchOverview: async () => ({ daemon: { port: 4271 } }),
        assertServe: async () => {},
        serveOff: async () => {},
        tailnetSelf: async () => ({ dnsName: 'box.tail1234.ts.net', ips: ['100.98.118.33'] }),
      },
    })
    await s.start()
    await s.resolveHosts()
    return s
  }

  beforeEach(async () => {
    seen = []
    timeline = http.createServer((r, res) => {
      let buf = ''
      r.on('data', (d) => { buf += d })
      r.on('end', () => {
        seen.push({ method: r.method, url: r.url, headers: r.headers, body: buf })
        if (r.url === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          return res.end('<meta name="curia-timeline" content="proto=3">')
        }
        if (r.url.startsWith('/events')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          return res.end('event: hello\ndata: {"session":"curia-console-2"}\n\n')
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise((done) => timeline.listen(0, '127.0.0.1', done))
    surface = await makeSurface({ timelinePort: timeline.address().port })
  })

  afterEach(() => {
    surface?.stop()
    timeline?.close()
  })

  test('/chat is a door into the Atlas room, and it asks the timeline for nothing', async () => {
    const res = await req(surface.port, '/chat?session=curia-console-2', { headers: served() })
    assert.equal(res.status, 303)
    assert.equal(res.headers.location, '/#chat/curia-console-2')
    assert.equal(seen.length, 0)
    // a session name this sidecar would not relay lands on the picker
    const bad = await req(surface.port, '/chat?session=root-shell', { headers: served() })
    assert.equal(bad.headers.location, '/#chat')
  })

  test('the six routes the page speaks reach the timeline with their query intact', async () => {
    await req(surface.port, '/events?session=curia-console-2&client=ab12', { headers: served() })
    assert.equal(seen.at(-1).url, '/events?session=curia-console-2&client=ab12')
    for (const route of ['/send', '/draft', '/key', '/take-back', '/dialog-answer']) {
      await req(surface.port, route, {
        method: 'POST',
        headers: served({ origin: ORIGIN, 'content-type': 'application/json' }),
        body: { session: 'curia-console-2', text: 'start 267' },
      })
      const last = seen.at(-1)
      assert.equal(last.url, route)
      assert.equal(JSON.parse(last.body).text, 'start 267', 'the words cross unread')
    }
  })

  test('NOTHING is rewritten: the timeline judges the Host and the login the browser sent', async () => {
    await req(surface.port, '/events?session=curia-console-2', { headers: served() })
    const h = seen.at(-1).headers
    assert.equal(h.host, 'box.tail1234.ts.net:8445')
    assert.equal(h[LOGIN_HEADER], 'alp@example.com')
  })

  test('the identity gate runs FIRST — an unstamped request never reaches the timeline', async () => {
    const res = await req(surface.port, '/chat', { headers: { host: 'box.tail1234.ts.net:8445' } })
    assert.equal(res.status, 403)
    assert.equal(seen.length, 0)
  })

  test('a write from another origin is refused here, before the pipe', async () => {
    const res = await req(surface.port, '/send', {
      method: 'POST',
      headers: served({ origin: 'https://evil.example', 'content-type': 'application/json' }),
      body: { session: 'curia-console-2', text: 'x' },
    })
    assert.equal(res.status, 403)
    assert.equal(seen.length, 0)
  })

  test('a timeline that is not answering says so — the console itself is still up', async () => {
    await new Promise((done) => timeline.close(done))
    timeline = null
    const res = await req(surface.port, '/events?session=curia-console-2', { headers: served() })
    assert.equal(res.status, 502)
    assert.match(res.text, /not answering/)
    // the rest of the console is unharmed by a dead chat
    assert.equal((await req(surface.port, '/api/overview', { headers: served() })).status, 200)
  })

  test('a sidecar with no timeline port says that, rather than guessing one', async () => {
    const s2 = await makeSurface({ timelinePort: null })
    try {
      const res = await req(s2.port, '/events?session=curia-console-2', { headers: served() })
      assert.equal(res.status, 503)
      assert.match(res.text, /no `timeline:` block/)
    } finally {
      s2.stop()
    }
  })

  test('the page and the sidecar agree on the address the Chat screen opens', () => {
    const page = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(page, new RegExp(`const CHAT_PAGE = "${CHAT_PAGE}"`))
  })
})

describe('the embedded terminal (#714)', () => {
  let surface
  let terminal
  const seen = []
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })

  beforeEach(async () => {
    seen.length = 0
    terminal = http.createServer((req, res) => {
      seen.push({ type: 'http', url: req.url, headers: req.headers })
      res.end('<title>ttyd</title>')
    })
    terminal.on('upgrade', (req, socket) => {
      seen.push({ type: 'upgrade', url: req.url, headers: req.headers })
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    await new Promise((done) => terminal.listen(0, '127.0.0.1', done))
    surface = new DashboardSurface({
      port: 0, servePort: 8445, index: DEFAULT_DASHBOARD_INDEX,
      allow: ['alp@example.com'], terminalPort: terminal.address().port,
      pollIntervalS: 5, log: () => {},
      deps: {
        fetchOverview: async () => ({}), assertServe: async () => {}, serveOff: async () => {},
        tailnetSelf: async () => ({ dnsName: 'box.tail1234.ts.net', ips: [] }),
      },
    })
    await surface.start()
    await surface.resolveHosts()
  })

  afterEach(() => {
    surface?.stop()
    terminal?.close()
  })

  test('Atlas serves ttyd under one same-origin terminal path', async () => {
    const response = await req(surface.port, TERMINAL_PAGE, { headers: served() })
    assert.equal(response.status, 200)
    assert.match(response.text, /ttyd/)
    assert.equal(seen[0].url, '/')
    assert.equal(seen[0].headers.host, `127.0.0.1:${terminal.address().port}`)
    assert.equal(seen[0].headers.origin, `http://127.0.0.1:${terminal.address().port}`)
  })

  test('the same path carries ttyd WebSocket upgrades after identity and Origin checks', async () => {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(surface.port, '127.0.0.1', () => {
        socket.write([
          'GET /terminal/ws HTTP/1.1',
          'Host: box.tail1234.ts.net:8445',
          'Tailscale-User-Login: alp@example.com',
          'Origin: https://box.tail1234.ts.net:8445',
          'Connection: Upgrade',
          'Upgrade: websocket',
          '', '',
        ].join('\r\n'))
      })
      let text = ''
      socket.on('data', (chunk) => { text += chunk })
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/)
    assert.equal(seen.at(-1).type, 'upgrade')
    assert.equal(seen.at(-1).url, '/ws')
  })

  test('an unknown operator cannot reach the terminal or its WebSocket', async () => {
    assert.equal((await req(surface.port, TERMINAL_PAGE, { headers: { host: 'box.tail1234.ts.net:8445' } })).status, 403)
    assert.equal(seen.length, 0)
  })
})

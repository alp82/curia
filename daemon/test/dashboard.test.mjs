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
  loadDashboardConfig, pageRefusal, readDashboard, daemonPort, ANSWER_REFUSAL, CHAT_PAGE, TERMINAL_PAGE,
} from '../src/dashboard.mjs'
import { APP_VERSION } from '../src/appversion.mjs'
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

  test('GET /ping answers the running version before the identity gate, and nothing else', async () => {
    // The switch (#884) proves the app came back on the target release by
    // reading this on loopback, where no Serve identity exists.
    const res = await req(surface.port, '/ping', { headers: { host: 'box.tail1234.ts.net:8445' } })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), { curia: 'curia-dashboard', version: APP_VERSION })
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
  let updateAnswer
  let aistackRequestBody
  let setupAnswer
  let setupRequestBody
  let setupPostStatus
  let restartRequestBody
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
    updateAnswer = { managed: true, installed: '1.3.0', recommended: '1.4.0', update_available: true, installed_withdrawn: false, withdrawn: [], ok: true, error: null }
    aistackRequestBody = null
    // What it answers on the setup routes (#874). The daemon verifies and
    // keeps the record; this side composes the write and relays the read.
    setupAnswer = { step: 'github', progress: {}, cards: [], full_loop: { ready: false, missing: [], reason: null, facts: null } }
    setupRequestBody = null
    setupPostStatus = 200
    restartRequestBody = null
    overviewAnswer = async () => ({ daemon: { port: 4271, uptime_s: 90 }, agents: [] })
    daemon = http.createServer((r, res) => {
      daemonCalls.push({ method: r.method, url: r.url, origin: r.headers.origin ?? null })
      // The setup write (#874) answers its own status, so it sits before the
      // shared 200 below.
      if (r.url === '/setup' && r.method === 'POST') {
        let raw = ''
        r.setEncoding('utf8')
        r.on('data', (chunk) => { raw += chunk })
        return r.on('end', () => {
          setupRequestBody = JSON.parse(raw)
          res.writeHead(setupPostStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify(setupPostStatus === 200
            ? { ok: true, step: setupRequestBody.step ?? 'github', progress: setupRequestBody.progress ?? {} }
            : { ok: false, error: 'the discord channel is not the shape a channel takes' }))
        })
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (r.url === '/repos') return res.end(JSON.stringify({ login: 'alp82', repos: ['o/r', 'o/other'], error: null }))
      if (r.url === '/settings/action') return res.end(JSON.stringify({
        action: {
          action_id: 'app-settings-sidecar-1', kind: 'settings-save', target: 'config.yaml',
          conflict_key: 'settings:config.yaml', status: 'progress', progress: 'Writing config.yaml', revision: 1,
        },
      }))
      if (r.url === '/settings/action/finish') return res.end(JSON.stringify({
        action: {
          action_id: 'app-settings-no-change-1', kind: 'settings-save', target: 'config.yaml',
          conflict_key: 'settings:config.yaml', status: 'confirmed', revision: 2,
          receipt: { written: [], applied: [] },
        },
      }))
      if (r.url === '/reload') return res.end(JSON.stringify(reloadAnswer))
      if (r.url.startsWith('/aistack') && r.method === 'POST') {
        let raw = ''
        r.setEncoding('utf8')
        r.on('data', (chunk) => { raw += chunk })
        return r.on('end', () => {
          aistackRequestBody = JSON.parse(raw)
          res.end(JSON.stringify(aistackAnswer))
        })
      }
      if (r.url.startsWith('/aistack')) return res.end(JSON.stringify(aistackAnswer))
      if (r.url === '/update') return res.end(JSON.stringify(updateAnswer))
      if (r.url === '/setup') return res.end(JSON.stringify(setupAnswer))
      if (r.url === '/restart') {
        let raw = ''
        r.setEncoding('utf8')
        r.on('data', (chunk) => { raw += chunk })
        return r.on('end', () => {
          restartRequestBody = JSON.parse(raw)
          res.end(JSON.stringify({
            ok: true,
            exit_code: 75,
            action: {
              action_id: restartRequestBody.action_id,
              kind: 'daemon-restart', target: 'daemon', conflict_key: 'daemon:lifecycle',
              status: 'accepted', revision: 9,
            },
          }))
        })
      }
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
    assert.deepEqual(body.written, ['config.yaml'])
    assert.equal(fs.readFileSync(tracked, 'utf8'), before, 'the tracked file is byte for byte what it was')
    assert.match(fs.readFileSync(path.join(cfgDir, 'config.yaml'), 'utf8'), /max_concurrent: 4/)
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
        action_id: 'app-settings-sidecar-1', kind: 'settings-save', target: 'config.yaml',
        conflict_key: 'settings:config.yaml', status: 'confirmed', revision: 2,
        receipt: { written: ['config.yaml'], applied: ['dispatch.max_concurrent'] },
      },
    }
    const res = await save({ action_id: 'app-settings-sidecar-1', dispatch: { max_concurrent: 4 } })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.text)
    assert.deepEqual(daemonCalls.filter((call) => ['/settings/action', '/reload'].includes(call.url)).map((call) => call.url), [
      '/settings/action', '/reload',
    ])
    assert.equal(body.action.status, 'confirmed')
    assert.deepEqual(body.action.receipt.written, ['config.yaml'])
  })

  test('a save that wrote nothing asks for nothing — the file did not move', async () => {
    fs.writeFileSync(path.join(cfgDir, 'config.yaml'), 'max_concurrent: 2\n')
    const res = await save({ dispatch: { max_concurrent: 2 } })
    assert.equal(JSON.parse(res.text).written.length, 0)
    assert.equal(JSON.parse(res.text).reload, null)
    assert.deepEqual(reloadCalls(), [], 'there is nothing to apply')
  })

  test('an Action that finds no change settles without asking for a reload', async () => {
    fs.writeFileSync(path.join(cfgDir, 'config.yaml'), 'max_concurrent: 2\n')
    const res = await save({ action_id: 'app-settings-no-change-1', dispatch: { max_concurrent: 2 } })
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
    assert.deepEqual(body.written, ['config.yaml'])
    assert.equal(body.reload.reason, 'restart-needed')
    assert.match(body.reload.error, /sandbox\.image/)
  })

  test('a daemon that is not answering is not a failed save: the file is written, and it takes it at boot', async () => {
    await new Promise((done) => daemon.close(done))
    const res = await save({ dispatch: { max_concurrent: 4 } })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.text)
    assert.deepEqual(body.written, ['config.yaml'])
    assert.equal(body.reload.reason, 'daemon-down')
    assert.match(fs.readFileSync(path.join(cfgDir, 'config.yaml'), 'utf8'), /max_concurrent: 4/)
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
    assert.ok(!fs.existsSync(path.join(cfgDir, 'config.yaml')), 'nothing was written')
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
    await req(surface.port, '/api/overview', { headers: served() })
    const res = await req(surface.port, '/api/restart', {
      method: 'POST', headers: writes(), body: { action_id: 'app-daemon-restart' },
    })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).action.status, 'accepted')
    assert.deepEqual(daemonCalls, [{ method: 'POST', url: '/restart', origin: null }])
    assert.deepEqual(restartRequestBody, { by: 'dashboard', action_id: 'app-daemon-restart', uptime_s: 90 })
    assert.equal(surface.snapshot.actions[0].action_id, 'app-daemon-restart',
      'a refresh during process downtime recovers the accepted Action from the held snapshot')
  })

  test('the order carries no Origin onward — the daemon refuses every request that does', async () => {
    await req(surface.port, '/api/restart', {
      method: 'POST', headers: writes(), body: { action_id: 'app-daemon-origin' },
    })
    assert.equal(daemonCalls[0].origin, null,
      'the sidecar composes its own call from a route it names in code, never forwards a browser\'s')
  })

  test('after a restart order the next read re-reads: a held snapshot would say `up` at the one moment that is false', async () => {
    await req(surface.port, '/api/overview', { headers: served() })
    assert.ok(surface.snapshotAt > 0)
    await req(surface.port, '/api/restart', {
      method: 'POST', headers: writes(), body: { action_id: 'app-daemon-reread' },
    })
    assert.equal(surface.snapshotAt, 0)
  })

  test('a daemon that is not answering makes the restart an error, never a silent success', async () => {
    await new Promise((done) => daemon.close(done))
    const res = await req(surface.port, '/api/restart', {
      method: 'POST', headers: writes(), body: { action_id: 'app-daemon-offline' },
    })
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

  // ---- integration setup (#874) ---------------------------------------------
  //
  // The daemon verifies every card and keeps the record; this process relays
  // the read and composes the write out of the closed field list, so nothing
  // a browser sends beyond a card name and its safe fields crosses the wire.

  test('the setup status comes from the daemon, unedited, on every read', async () => {
    setupAnswer = {
      step: 'discord', progress: { discord: { channel: 'ops' } },
      cards: [{ key: 'github', state: 'unavailable' }], full_loop: { ready: false, missing: ['github'], reason: 'Waiting for GitHub.', facts: null },
    }
    const res = await req(surface.port, '/api/setup', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), setupAnswer)
    assert.deepEqual(daemonCalls, [{ method: 'GET', url: '/setup', origin: null }])
  })

  test('a daemon that cannot be asked about setup answers null cards with the reason, never four unconnected ones', async () => {
    await new Promise((done) => daemon.close(done))
    daemon = null
    const body = JSON.parse((await req(surface.port, '/api/setup', { headers: served() })).text)
    assert.equal(body.cards, null)
    assert.ok(body.error)
  })

  test('a write carries the selected card and the safe fields, and nothing else the browser sent', async () => {
    const res = await req(surface.port, '/api/setup', {
      method: 'POST', headers: writes(),
      body: {
        step: 'discord',
        progress: { discord: { channel: 'ops', guild_id: '123456789', token: 'MTIz.never', bot_token: 'MTIz.never' }, full: { done: true } },
        complete: ['github'], connected: { github: true },
      },
    })
    assert.equal(res.status, 200, res.text)
    assert.deepEqual(daemonCalls, [{ method: 'POST', url: '/setup', origin: null }])
    assert.deepEqual(setupRequestBody, { step: 'discord', progress: { discord: { channel: 'ops', guild_id: '123456789' } } })
    assert.ok(!JSON.stringify(setupRequestBody).includes('never'))
  })

  test('a card that is not one of the four is refused on this side, and nothing reaches the daemon', async () => {
    const res = await req(surface.port, '/api/setup', { method: 'POST', headers: writes(), body: { step: 'full' } })
    assert.equal(res.status, 409)
    assert.match(JSON.parse(res.text).error, /"full" is not a setup card/)
    assert.deepEqual(daemonCalls, [])
  })

  test("the daemon's refusal of a field reads as a refusal, not as this box failing", async () => {
    setupPostStatus = 400
    const res = await req(surface.port, '/api/setup', { method: 'POST', headers: writes(), body: { progress: { discord: { channel: 'Bad Channel' } } } })
    assert.equal(res.status, 409)
    assert.match(JSON.parse(res.text).error, /not the shape a channel takes/)
  })

  test('a setup write needs the same Origin gate every write does', async () => {
    const res = await req(surface.port, '/api/setup', { method: 'POST', headers: served({ 'content-type': 'application/json' }), body: { step: 'github' } })
    assert.equal(res.status, 403)
    assert.deepEqual(daemonCalls, [])
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

  // ---- the update panel (#883) ---------------------------------------------
  //
  // The daemon keeps the daily check and its record; the sidecar relays the
  // read and adds nothing. A daemon that cannot be asked is unknown, never
  // "up to date".

  test('the update read comes from the daemon, unedited', async () => {
    const res = await req(surface.port, '/api/update', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), updateAnswer)
    assert.deepEqual(daemonCalls, [{ method: 'GET', url: '/update', origin: null }])
  })

  test('a daemon that cannot be asked about updates is unknown, never "up to date"', async () => {
    await new Promise((done) => daemon.close(done))
    daemon = null
    const body = JSON.parse((await req(surface.port, '/api/update', { headers: served() })).text)
    assert.equal(body.managed, null)
    assert.equal(body.installed, null)
    assert.ok(body.error)
  })

  test('a daemon that cannot be asked is unknown, never "not registered"', async () => {
    await new Promise((done) => daemon.close(done))
    daemon = null
    const body = JSON.parse((await req(surface.port, '/api/aistack', { headers: served() })).text)
    assert.equal(body.ok, false, 'a false `registered` would read as an answer')
    assert.ok(body.error)
  })

  test('each press carries only its Action identity — the browser names no command', async () => {
    for (const act of ['register', 'cancel', 'optin']) {
      daemonCalls = []
      aistackRequestBody = null
      const res = await req(surface.port, `/api/aistack/${act}`, {
        method: 'POST', headers: writes(), body: { action_id: `app-aistack-${act}`, version: 'latest', home: '/etc' },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(daemonCalls, [{ method: 'POST', url: `/aistack/${act}`, origin: null }],
        'the route is the whole message, and the fields the browser sent went nowhere')
      assert.deepEqual(aistackRequestBody, { action_id: `app-aistack-${act}` })
    }
  })

  test('a fourth act is not a route: there are three, named in code', async () => {
    const res = await req(surface.port, '/api/aistack/login', { method: 'POST', headers: writes(), body: {} })
    assert.equal(res.status, 404)
    assert.deepEqual(daemonCalls, [], 'nothing reached the daemon')
  })

  test('a refusal from the daemon reads as one, not as this box failing', async () => {
    aistackAnswer = { ok: false, error: 'this box is already registered with aistack' }
    const res = await req(surface.port, '/api/aistack/register', {
      method: 'POST', headers: writes(), body: { action_id: 'app-aistack-refused' },
    })
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
      '/github-app/complete?code=one-use&state=expected': [200, { ok: true, app: { id: '42', slug: 'curia-box' }, screen: 'settings' }],
      '/github-app/complete?code=from-setup&state=expected': [200, { ok: true, app: { id: '42', slug: 'curia-box' }, screen: 'setup' }],
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

  test('the operator who pressed rides every verb, so the feed names a person not a transport', async () => {
    await press('/api/start', { repo: 'o/r', ticket: '9' })
    assert.equal(sent('/command').body.by, 'alp@example.com')
    calls = []
    await press('/api/answer', { id: 'esc-7', answer: 'approve' })
    assert.equal(sent('/answer').body.by, 'alp@example.com')
    assert.equal(sent('/answer').body.via, 'dashboard', 'the surface is a fact of its own')
  })

  test('a Feed read carries its Action identity and drops the held snapshot for reconciliation (#704, #811)', async () => {
    const actionId = 'app-feed-read-alp'
    const evidence = {
      action_id: actionId, kind: 'feed-read', target: 'alp@example.com',
      conflict_key: 'feed-read:alp@example.com', status: 'confirmed', revision: 42,
    }
    reply['/feed/read'] = [200, { action: evidence }]
    const res = await press('/api/feed/read', { action_id: actionId })
    assert.equal(res.status, 200)
    assert.equal(sent('/feed/read').body.by, 'alp@example.com')
    assert.equal(sent('/feed/read').body.action_id, actionId)
    assert.deepEqual(JSON.parse(res.text).action, evidence)
    assert.equal(surface.snapshotAt, 0)
  })

  test('GitHub App setup keeps conversion inside the daemon', async () => {
    const actionId = 'app-github-app-setup'
    const started = await press('/api/github-app/start', { name: 'curia-box', action_id: actionId })
    assert.equal(started.status, 200)
    // The redirect is composed from curia's own records - `attachBase()` and
    // the serve port - not from anything the caller sent.
    assert.equal(await surface.link(), 'https://box.tail1234.ts.net:8445/')
    assert.deepEqual(sent('/github-app/start').body, {
      name: 'curia-box',
      redirect_url: 'https://box.tail1234.ts.net:8445/api/github-app/complete',
      action_id: actionId,
      screen: 'settings',
    })

    const completed = await req(surface.port, '/api/github-app/complete?code=one-use&state=expected', { headers: served() })
    assert.equal(completed.status, 303)
    assert.equal(completed.headers.location, '/#settings')
    assert.equal(completed.text.includes('PRIVATE KEY'), false)
  })

  // The Setup screen (#875) starts the same flow, and GitHub's redirect lands
  // back on the screen that started it. The screen is a named field of this
  // surface, never a caller-composed location.
  test('a setup started from the Setup screen lands back on it', async () => {
    const started = await press('/api/github-app/start', { name: 'curia-box', action_id: 'app-github-app-setup2', screen: 'setup' })
    assert.equal(started.status, 200)
    assert.equal(sent('/github-app/start').body.screen, 'setup')
    const completed = await req(surface.port, '/api/github-app/complete?code=from-setup&state=expected', { headers: served() })
    assert.equal(completed.status, 303)
    assert.equal(completed.headers.location, '/#setup')
    calls = []
    const bad = await press('/api/github-app/start', { name: 'curia-box', action_id: 'app-github-app-setup3', screen: 'https://evil.example/' })
    assert.equal(bad.status, 409)
    assert.equal(sent('/github-app/start'), undefined)
  })

  // A browser-named redirect is not a field this surface forwards, and a name
  // GitHub would refuse never reaches the daemon.
  test('the setup start forwards the name and nothing the browser said about the redirect', async () => {
    await press('/api/github-app/start', {
      name: 'curia-box', redirect_url: 'https://evil.example.com/', action_id: 'app-github-app-redirect',
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
    const out = await press('/api/github-app/refresh', { anything: 'ignored', action_id: 'app-github-app-read' })
    assert.equal(out.status, 200)
    assert.equal(sent('/github-app/installations').method, 'POST')
    assert.deepEqual(sent('/github-app/installations').body, { action_id: 'app-github-app-read' })
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
      name: 'curia-box', action_id: 'app-github-app-host',
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
  test('sign-in composes `reauth <provider>` and carries its Action identity', async () => {
    const accepted = {
      action_id: 'app-reauth-anthropic', kind: 'credential-sign-in', target: 'anthropic',
      conflict_key: 'reauth:anthropic', status: 'accepted', revision: 42,
    }
    reply['/command'] = [200, { action: accepted }]
    const res = await press('/api/reauth', { provider: 'anthropic', action_id: 'app-reauth-anthropic' })
    assert.equal(res.status, 200)
    assert.equal(sent('/command').body.text, 'reauth anthropic')
    assert.equal(sent('/command').body.by, 'alp@example.com')
    assert.equal(sent('/command').body.action_id, 'app-reauth-anthropic')
    assert.deepEqual(JSON.parse(res.text).action, accepted)
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
  // seam every verb above does: the browser names an escalation id and a file
  // only by its place in the digest curia itself measured — never a path, a
  // repo, a branch or a command.

  const read = (p) => req(surface.port, p, { headers: served() })

  test('a gate asks by escalation id, and the sidecar passes exactly that', async () => {
    reply['/diff?esc=esc-9'] = [200, { agent: 'curia-9', digest: { files: 2, added: 5, deleted: 1, list: [] }, error: null }]
    const res = await read('/api/diff?esc=esc-9')
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).digest.files, 2)
    assert.equal(sent('/diff?esc=esc-9').method, 'GET')
  })

  test('global search forwards one bounded query and returns typed landing targets', async () => {
    reply['/search?q=curia'] = [200, {
      query: 'curia', errors: [], results: [{
        kind: 'map', id: 'o/r#9', title: 'Curia app map', snippet: 'The map frontier', age_s: 60,
        attention: null, landing: { surface: 'maps', map: 9 },
      }],
    }]

    const res = await read('/api/search?q=%20curia%20')

    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).results[0].landing.surface, 'maps')
    assert.ok(sent('/search?q=curia'))
    calls = []
    assert.equal((await read('/api/search?q=')).status, 400)
    assert.equal((await read('/api/search?q=' + 'x'.repeat(201))).status, 400)
    assert.deepEqual(calls, [])
  })

  test('a field the daemon would read as something else is refused here, before the wire', async () => {
    for (const [q, why] of [
      ['/api/diff', /escalation id/],
      ['/api/diff?agent=curia-9', /escalation id/],
      ['/api/diff?esc=' + encodeURIComponent('esc 9; ls'), /escalation id/],
      ['/api/diff?esc=esc-9&file=' + encodeURIComponent('../../etc/passwd'), /file index/],
      ['/api/diff?esc=esc-9&file=99999', /file index/],
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
    const res = await press('/api/console/new', { action_id: 'app-console-new-4' })
    assert.equal(res.status, 200)
    assert.equal(sent('/console/new').method, 'POST', 'never a GET — a page read must not spend a number')
    assert.deepEqual(sent('/console/new').body, { action_id: 'app-console-new-4' })
    assert.equal(JSON.parse(res.text).session, 'curia-console-4')
  })

  test('a delete names one key, and a key the daemon does not hold comes back in words', async () => {
    reply['/console/delete'] = [200, { action: { status: 'confirmed', receipt: { key: 'console-2' } } }]
    assert.equal((await press('/api/console/delete', { key: 'console-2', action_id: 'app-console-delete-2' })).status, 200)
    assert.deepEqual(sent('/console/delete').body, { key: 'console-2', action_id: 'app-console-delete-2' })

    calls = []
    reply['/console/delete'] = [409, { action: { status: 'refused', reason: 'there is no conversation `console-2`' }, error: 'there is no conversation `console-2`' }]
    const res = await press('/api/console/delete', { key: 'console-2', action_id: 'app-console-delete-stale' })
    assert.equal(res.status, 200, 'the sidecar carries daemon Action evidence instead of reclassifying it')
    assert.match(JSON.parse(res.text).error, /no conversation/)
  })

  test('a key the sidecar does not name is refused here, before the wire', async () => {
    for (const key of ['chat-2', 'console', 'console-2; rm -rf /', 'curia-console-2', '../2']) {
      const res = await press('/api/console/delete', { key, action_id: 'app-console-delete-invalid' })
      assert.equal(res.status, 409, key)
      assert.match(JSON.parse(res.text).error, /browser conversation key/)
    }
    assert.deepEqual(calls, [], 'not one of them reached the daemon')
  })

  test('an answer with no words is refused and not written', async () => {
    assert.match(JSON.parse((await press('/api/answer', { id: 'esc-7', answer: '  ' })).text).error, /no words/)
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

  test('routes this surface does not carry are a 404, not a silent nothing', async () => {
    for (const [route, body] of [
      ['/api/resume', { ticket: '1' }],
      ['/api/cancel', { ticket: '1' }],
      ['/api/teleport', { ticket: '1' }],
      ['/api/note', { agent: 'curia-1', text: 'look again' }],
    ]) assert.equal((await press(route, body)).status, 404, route)
    assert.deepEqual(calls, [])
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

  test('an answer Action identity and its shared refusal evidence cross the sidecar unchanged', async () => {
    reply['/answer'] = [409, {
      ok: false,
      reason: 'answered',
      action: {
        action_id: 'app-answer-esc-7', kind: 'escalation-answer', target: 'esc-7',
        conflict_key: 'answer:esc-7', status: 'refused', revision: 14,
      },
      receipt: { by: 'phone', via: 'button', at: 'T', answer: 'Preview' },
    }]
    const res = await press('/api/answer', { id: 'esc-7', index: 1, action_id: 'app-answer-esc-7' })
    assert.equal(sent('/answer').body.action_id, 'app-answer-esc-7')
    assert.equal(res.status, 200, 'Action evidence is data for Curia app, not a sidecar transport failure')
    const body = JSON.parse(res.text)
    assert.equal(body.action.status, 'refused')
    assert.equal(body.receipt.by, 'phone')
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
// Chat is a page of Curia app (#711), and the sidecar hands the six routes that
// page speaks straight through to the daemon's timeline listener. What matters
// here is what the pipe does NOT do: it changes no header, so the identity the
// timeline checks in-process is the identity the browser sent, and it buffers
// nothing, so an event stream is still a stream. `/chat` is a door for the
// links an older daemon handed out: it lands on the `#chat/<session>` route.

describe('the chat (#267, a page of Curia app by #711)', () => {
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

  test('/chat is a door into the Curia app room, and it asks the timeline for nothing', async () => {
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

  test('Curia app serves ttyd under one same-origin terminal path', async () => {
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

// ---- the Discord card (#876) --------------------------------------------------
//
// Three routes, one rule: the token crosses this surface once, to the daemon,
// and comes back in no answer and no log line. The two writes are composed
// out of the fields they name, and a paste that is not a token is refused by
// shape without echoing it.
describe('the Discord card routes (#876)', () => {
  const ALLOW = ['alp@example.com']
  const SERVE_PORT = 8445
  const ORIGIN = 'https://box.tail1234.ts.net:8445'
  const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.this-token-must-never-be-shown-anywhere-1234'
  let surface
  let daemon
  let calls
  let reply
  let logged
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })
  const press = (p, body) => req(surface.port, p, { method: 'POST', headers: served({ origin: ORIGIN, 'content-type': 'application/json' }), body })
  const sent = (route) => calls.find((c) => c.url === route)

  beforeEach(async () => {
    calls = []
    logged = []
    reply = {
      '/setup/discord': [200, { secret: 'present', source: 'file', bot: { id: '2', username: 'curia-box' }, guilds: [{ id: '333333333333333333', name: 'Alp' }], settings: { allowed_users: ['111111111111111111'], guild_id: null, channel: 'curia' }, invite_url: 'https://discord.com/oauth2/authorize?client_id=2', error: null }],
      '/setup/discord/token': [200, { ok: true, secret: 'present', bot: { id: '2', username: 'curia-box' }, guilds: [], settings: { allowed_users: ['111111111111111111'], guild_id: null, channel: 'curia' } }],
      '/setup/discord/channel': [200, { ok: true, settings: { allowed_users: ['111111111111111111'], guild_id: '333333333333333333', channel: 'ops' }, card: { key: 'discord', state: 'connected' } }],
    }
    daemon = http.createServer((r, res) => {
      let buf = ''
      r.on('data', (d) => { buf += d })
      r.on('end', () => {
        calls.push({ method: r.method, url: r.url, body: buf ? JSON.parse(buf) : null })
        const [code, body] = reply[r.url] ?? [404, { error: 'no such route' }]
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise((done) => daemon.listen(0, '127.0.0.1', done))
    surface = new DashboardSurface({
      port: 0, servePort: SERVE_PORT, index: DEFAULT_DASHBOARD_INDEX, allow: ALLOW, pollIntervalS: 5,
      daemonPort: daemon.address().port,
      log: (line) => logged.push(String(line)),
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

  // #882: the Full loop's run rides the sidecar the way the cards do. The
  // press names at most a repository and a ticket number, shaped here; the
  // daemon's refusal is the sentence the page shows; the read is unedited.
  test('the Full loop press crosses as the repository and the ticket number only, and the daemon\'s refusal is the page\'s sentence', async () => {
    const run = { state: 'running', repo: 'o/r', ticket: { number: 42, title: 'T', url: 'https://github.com/o/r/issues/42', map: 40 }, legs: [], links: {}, failed: null, elapsed_ms: 1 }
    reply['/setup/full-loop'] = [200, { ok: true, run }]
    reply['/setup/full-loop/retry'] = [200, { ok: true, run }]
    const res = await press('/api/setup/full-loop', { repo: 'o/r', ticket: '42', token: TOKEN, extra: 'dropped' })
    assert.equal(res.status, 200)
    assert.deepEqual(sent('/setup/full-loop').body, { repo: 'o/r', ticket: 42 })
    assert.deepEqual(JSON.parse(res.text).run, run)
    assert.ok(!res.text.includes(TOKEN))
    calls = []
    const bare = await press('/api/setup/full-loop', {})
    assert.equal(bare.status, 200)
    assert.deepEqual(sent('/setup/full-loop').body, {})
    for (const bad of [{ repo: 'not a repo' }, { ticket: 'x' }, { ticket: 0 }]) {
      const r = await press('/api/setup/full-loop', bad)
      assert.equal(r.status, 409, JSON.stringify(bad))
    }
    calls = []
    const retry = await press('/api/setup/full-loop/retry', { repo: 'x/y', ticket: 7 })
    assert.equal(retry.status, 200)
    assert.deepEqual(sent('/setup/full-loop/retry').body, {}, 'the retry names nothing')
    reply['/setup/full-loop'] = [400, { ok: false, error: "The Full loop isn't ready: Waiting for Discord." }]
    const refused = await press('/api/setup/full-loop', {})
    assert.equal(refused.status, 409)
    assert.equal(JSON.parse(refused.text).error, "The Full loop isn't ready: Waiting for Discord.")
  })

  test('the Full loop read comes from the daemon unedited, and a daemon that cannot be asked answers a null state with the reason', async () => {
    reply['/setup/full-loop'] = [200, { state: 'idle', repo: null, legs: [] }]
    const res = await req(surface.port, '/api/setup/full-loop', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), { state: 'idle', repo: null, legs: [] })
    daemon.close()
    const down = JSON.parse((await req(surface.port, '/api/setup/full-loop', { headers: served() })).text)
    assert.equal(down.state, null)
    assert.match(down.error, /daemon|ECONNREFUSED|ECONNRESET|socket hang up/i)
  })

  test('the panel read comes from the daemon unedited, and a daemon that cannot be asked answers the reason', async () => {
    const res = await req(surface.port, '/api/setup/discord', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), reply['/setup/discord'][1])
    daemon.close()
    const down = JSON.parse((await req(surface.port, '/api/setup/discord', { headers: served() })).text)
    assert.equal(down.secret, null)
    assert.match(down.error, /daemon|ECONNREFUSED|ECONNRESET|socket hang up/i)
  })

  test('the token submission crosses once, as exactly the two fields, and the token is in no answer and no log line', async () => {
    const res = await press('/api/setup/discord/token', { token: TOKEN, user_id: '111111111111111111', extra: 'dropped' })
    assert.equal(res.status, 200)
    assert.deepEqual(sent('/setup/discord/token').body, { token: TOKEN, user_id: '111111111111111111' })
    assert.ok(!res.text.includes(TOKEN), 'the answer never carries the token')
    assert.ok(!logged.join('\n').includes(TOKEN), 'the log never carries the token')
  })

  test('a paste that is not a token is refused by shape without crossing and without being echoed', async () => {
    for (const token of ['not a token', `${TOKEN} `, '']) {
      const res = await press('/api/setup/discord/token', { token, user_id: '111111111111111111' })
      assert.equal(res.status, 409)
      assert.match(JSON.parse(res.text).error, /shape a Discord bot token takes/)
      assert.ok(!res.text.includes('not a token'))
    }
    assert.equal(sent('/setup/discord/token'), undefined)
    assert.ok(!logged.join('\n').includes(TOKEN))
    const bad = await press('/api/setup/discord/token', { token: TOKEN, user_id: 'alp' })
    assert.equal(bad.status, 409)
    assert.match(JSON.parse(bad.text).error, /"alp" is not a Discord user ID/)
    assert.ok(!bad.text.includes(TOKEN))
    assert.ok(!logged.join('\n').includes(TOKEN))
  })

  test('the daemon\'s refusal of a token is the sentence the page shows, and it never carries the token either', async () => {
    reply['/setup/discord/token'] = [400, { ok: false, error: 'Discord refused the bot token' }]
    const res = await press('/api/setup/discord/token', { token: TOKEN, user_id: '111111111111111111' })
    assert.equal(res.status, 409)
    assert.equal(JSON.parse(res.text).error, 'Discord refused the bot token')
    assert.ok(!res.text.includes(TOKEN))
  })

  test('the channel choice crosses as the server id and the channel name, shaped, and answers the verified card', async () => {
    const res = await press('/api/setup/discord/channel', { guild_id: '333333333333333333', channel: 'ops', token: TOKEN })
    assert.equal(res.status, 200)
    assert.deepEqual(sent('/setup/discord/channel').body, { guild_id: '333333333333333333', channel: 'ops' })
    assert.equal(JSON.parse(res.text).card.state, 'connected')
    calls = []
    const bad = await press('/api/setup/discord/channel', { guild_id: '333333333333333333', channel: 'Bad Channel' })
    assert.equal(bad.status, 409)
    assert.match(JSON.parse(bad.text).error, /is not a Discord channel name/)
    assert.equal(sent('/setup/discord/channel'), undefined)
  })
})

// ---- the GitHub card's watch choice (#891) ------------------------------------
//
// One write: the repositories the operator ticked land in the watch list
// through the same validated settings save the Settings screen uses, and the
// daemon applies them through the same reload. The route composes the list
// out of `owner/name` strings and nothing else, keeps the mode a repository
// already has, and refuses a name that is not a repository without sending it.
describe('the GitHub card watch route (#891)', () => {
  const ALLOW = ['alp@example.com']
  const SERVE_PORT = 8445
  const ORIGIN = 'https://box.tail1234.ts.net:8445'
  let surface
  let daemon
  let calls
  let reply
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })
  const press = (p, body) => req(surface.port, p, { method: 'POST', headers: served({ origin: ORIGIN, 'content-type': 'application/json' }), body })
  const sent = (route) => calls.filter((c) => c.url === route)

  beforeEach(async () => {
    calls = []
    reply = {
      'GET /settings': [200, { dispatch: { max_concurrent: 4 }, overseer: { live_pane_cap: 3 }, watch: [{ repo: 'alp82/curia', mode: 'map' }], routing: {}, files: {}, writes: {} }],
      'POST /settings': [200, { ok: true, written: ['config.yaml'], at: '2026-09-02T10:00:00.000Z' }],
      'POST /reload': [200, { ok: true, applied: ['watch'] }],
    }
    daemon = http.createServer((r, res) => {
      let buf = ''
      r.on('data', (d) => { buf += d })
      r.on('end', () => {
        calls.push({ method: r.method, url: r.url, body: buf ? JSON.parse(buf) : null })
        const [code, body] = reply[`${r.method} ${r.url}`] ?? [404, { error: 'no such route' }]
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise((done) => daemon.listen(0, '127.0.0.1', done))
    surface = new DashboardSurface({
      port: 0, servePort: SERVE_PORT, index: DEFAULT_DASHBOARD_INDEX, allow: ALLOW, pollIntervalS: 5,
      daemonPort: daemon.address().port, settingsSource: 'daemon',
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
  afterEach(async () => {
    await surface.stop()
    daemon.close()
  })

  test('the ticked repositories land through the settings save with their modes kept, and the daemon applies them', async () => {
    const res = await press('/api/setup/github/watch', { repos: ['alp82/aistack', 'alp82/curia'], mode: 'ignored', token: 'never' })
    assert.equal(res.status, 200, res.text)
    const [save] = sent('/settings').filter((c) => c.method === 'POST')
    assert.deepEqual(save.body, { watch: [{ repo: 'alp82/aistack', mode: 'auto' }, { repo: 'alp82/curia', mode: 'map' }] })
    assert.equal(sent('/reload').length, 1, 'the save applies through the reload, like every settings save')
    const out = JSON.parse(res.text)
    assert.deepEqual(out.written, ['config.yaml'])
    assert.equal(out.reload.ok, true)
  })

  test('a name that is not a repository is refused by shape, and nothing crosses', async () => {
    const bad = await press('/api/setup/github/watch', { repos: ['alp82/curia', 'not a repo'] })
    assert.equal(bad.status, 409)
    assert.match(JSON.parse(bad.text).error, /is not a repository/)
    assert.equal(sent('/settings').filter((c) => c.method === 'POST').length, 0)
    const none = await press('/api/setup/github/watch', { repos: [] })
    assert.equal(none.status, 409)
    assert.match(JSON.parse(none.text).error, /at least one repository/i)
  })

  test('the daemon\'s refusal of the list is the sentence the page shows, and no reload follows', async () => {
    reply['POST /settings'] = [400, { ok: false, error: '`watch` lists alp82/curia twice' }]
    const res = await press('/api/setup/github/watch', { repos: ['alp82/curia'] })
    assert.equal(res.status, 409)
    assert.equal(JSON.parse(res.text).error, '`watch` lists alp82/curia twice')
    assert.equal(sent('/reload').length, 0)
  })
})

describe('the Tailscale card routes and the first-operator window (#877)', () => {
  const SERVE_PORT = 8445
  const ORIGIN = 'https://box.tail1234.ts.net:8445'
  let surface
  let daemon
  let calls
  let reply
  let identity
  let logged
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'Alp@Example.com', ...extra })
  const press = (p, body, extra = {}) => req(surface.port, p, { method: 'POST', headers: served({ origin: ORIGIN, 'content-type': 'application/json', ...extra }), body })
  const sent = (route) => calls.find((c) => c.url.startsWith(route))

  let daemonPort
  const start = async ({ identitySource = 'daemon', allow = [], settingsSource = 'files', ...over } = {}) => {
    surface = new DashboardSurface({
      port: 0, servePort: SERVE_PORT, index: DEFAULT_DASHBOARD_INDEX, allow, identitySource, settingsSource, pollIntervalS: 5,
      daemonPort, ...over,
      log: (line) => logged.push(String(line)),
      deps: {
        fetchOverview: async () => ({ daemon: { port: 4271 } }),
        assertServe: async () => {},
        serveOff: async () => {},
        attachBase: async () => 'box.tail1234.ts.net',
        tailnetSelf: async () => ({ dnsName: 'box.tail1234.ts.net', ips: ['100.98.118.33'] }),
      },
    })
    await surface.start()
    await surface.assert()
  }

  beforeEach(async () => {
    calls = []
    logged = []
    identity = { allow: [], first_operator: true }
    reply = {
      '/setup/tailscale': [200, { requester: 'alp@example.com', operator: null, first_operator: true, node: { online: true, dns_name: 'box.tail1234.ts.net' }, app_url: 'https://box.tail1234.ts.net:8445/' }],
      '/setup/tailscale/operator': [200, { ok: true, requester: 'alp@example.com', operator: { login: 'alp@example.com', confirmed_at: '2026-09-02T10:00:00.000Z' }, card: { key: 'tailscale', state: 'connected' } }],
    }
    daemon = http.createServer((r, res) => {
      let buf = ''
      r.on('data', (d) => { buf += d })
      r.on('end', () => {
        calls.push({ method: r.method, url: r.url, body: buf ? JSON.parse(buf) : null })
        if (r.url === '/identity') {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify(identity))
        }
        const route = r.url.split('?')[0]
        const [code, body] = reply[`${r.method} ${route}`] ?? reply[route] ?? [404, { error: 'no such route' }]
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise((done) => daemon.listen(0, '127.0.0.1', done))
    daemonPort = daemon.address().port
  })

  // ---- the settings screen through the service (#880) ------------------------

  const ROOT_SETTINGS = {
    files: { curia: '/opt/curia/config/curia.yaml', routing: '/opt/curia/config/routing.yaml' },
    writes: { curia: '/root/config/config.yaml', routing: '/root/state/routing.local.yaml' },
    dispatch: { max_concurrent: 4, auto_dispatch: true, poll_interval_s: 60, prototype_variations: 3, messages_per_send: 4 },
    overseer: { live_pane_cap: 3 }, watch: [{ repo: 'alp82/curia', mode: 'auto' }], watch_modes: ['auto', 'manual'],
    routing: { defaults: [], models: [], review: {}, fallbacks: {} },
  }
  const asOperator = () => { identity = { allow: ['alp@example.com'], first_operator: false } }

  test('under a root the settings screen reads through the service, which holds the root\'s files', async () => {
    asOperator()
    reply['GET /settings'] = [200, ROOT_SETTINGS]
    await start({ settingsSource: 'daemon' })
    const res = await req(surface.port, '/api/settings', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text).writes, ROOT_SETTINGS.writes)
    assert.ok(sent('/settings'), 'the read crossed to the daemon')
  })

  test('under a root a save lands through the service, the reload follows it, and the answer is the same shape as a local save', async () => {
    asOperator()
    reply['GET /settings'] = [200, ROOT_SETTINGS]
    reply['POST /settings'] = [200, { ok: true, written: ['config.yaml'], at: '2026-09-02T10:00:00.000Z' }]
    reply['POST /reload'] = [200, { ok: true, by: 'alp@example.com', applied: ['dispatch.max_concurrent'], loaded_at: '2026-09-02T10:00:01.000Z' }]
    await start({ settingsSource: 'daemon' })
    const res = await press('/api/settings', { dispatch: { max_concurrent: 5 } })
    assert.equal(res.status, 200, res.text)
    const out = JSON.parse(res.text)
    assert.deepEqual(out.written, ['config.yaml'])
    assert.deepEqual(out.reload.applied, ['dispatch.max_concurrent'])
    assert.deepEqual(out.settings.writes, ROOT_SETTINGS.writes)
    const save = calls.find((c) => c.method === 'POST' && c.url === '/settings')
    assert.deepEqual(save.body, { dispatch: { max_concurrent: 5 } }, 'the patch crosses as it was, nothing more')
    const order = calls.filter((c) => c.method === 'POST').map((c) => c.url)
    assert.deepEqual(order, ['/settings', '/reload'], 'the write lands before the apply is ordered')
    assert.match(logged.join('\n'), /saved config\.yaml/)
  })

  test('under a root a save the service refuses reads as a refusal, names the contract\'s sentence, and orders no reload', async () => {
    asOperator()
    reply['GET /settings'] = [200, ROOT_SETTINGS]
    reply['POST /settings'] = [400, { ok: false, error: '/root/config/config.yaml line 1: `max_concurrent` must be a positive whole number (got 0)' }]
    await start({ settingsSource: 'daemon' })
    const res = await press('/api/settings', { dispatch: { max_concurrent: 0 } })
    assert.equal(res.status, 409)
    const out = JSON.parse(res.text)
    assert.equal(out.refused, true)
    assert.match(out.error, /max_concurrent.*positive whole number/)
    assert.equal(calls.some((c) => c.url === '/reload'), false)
  })

  test('under a root a service that cannot be asked fails the read and the save, and neither touches a file here', async () => {
    asOperator()
    await start({ settingsSource: 'daemon' })
    daemon.close()
    assert.equal((await req(surface.port, '/api/settings', { headers: served() })).status, 500)
    const res = await press('/api/settings', { dispatch: { max_concurrent: 5 } })
    assert.equal(res.status, 500)
    assert.match(JSON.parse(res.text).error, /daemon|ECONNREFUSED|answer/i)
  })
  afterEach(() => {
    surface?.stop()
    daemon?.close()
  })

  test('under a root the allowlist is the daemon\'s word, read at boot: nobody from curia.yaml is admitted', async () => {
    identity = { allow: ['box@example.com'], first_operator: false }
    await start({ allow: ['alp@example.com'] })
    assert.deepEqual([...surface.allow], ['box@example.com'])
    assert.equal(surface.firstOperator, false)
    assert.equal((await req(surface.port, '/', { headers: served() })).status, 403)
    assert.equal((await req(surface.port, '/', { headers: served({ [LOGIN_HEADER]: 'box@example.com' }) })).status, 200)
  })

  test('before the daemon answers, nobody is admitted and the window is shut', async () => {
    daemon.close()
    await start()
    assert.deepEqual([...surface.allow], [])
    assert.equal(surface.firstOperator, false)
    assert.equal((await req(surface.port, '/', { headers: served() })).status, 403)
    assert.match(logged.join('\n'), /identity read failed/)
  })

  // The rehearsal (#891) opened the app the moment `curia install` reported
  // every service healthy and met a refusal for up to a minute: the app had
  // read `/identity` before the daemon answered, and the next read was the
  // periodic Serve assert. The failed read now retries on its own until the
  // daemon answers once.
  test('an identity read the daemon did not answer is retried until the daemon answers once, so the window opens as soon as the daemon is up', async () => {
    daemon.close()
    await start({ identityRetryMs: 20, identityRetryForMs: 5_000 })
    assert.equal(surface.firstOperator, false)
    assert.equal((await req(surface.port, '/', { headers: served() })).status, 403)
    await new Promise((done) => daemon.listen(daemonPort, '127.0.0.1', done))
    const until = Date.now() + 3_000
    while (!surface.firstOperator && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    assert.equal(surface.firstOperator, true, 'the window opened without waiting for the assert loop')
    assert.equal((await req(surface.port, '/', { headers: served() })).status, 200)
    assert.match(logged.join('\n'), /identity read failed.*retrying every 0\.02s/)
    const reads = calls.filter((c) => c.url === '/identity').length
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(calls.filter((c) => c.url === '/identity').length, reads, 'once the daemon has answered, the retry stops')
  })

  test('the identity retry gives up after its ceiling and says so, leaving the window shut', async () => {
    daemon.close()
    await start({ identityRetryMs: 10, identityRetryForMs: 60 })
    const until = Date.now() + 2_000
    while (!/stopped retrying/.test(logged.join('\n')) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    assert.match(logged.join('\n'), /stopped retrying the daemon's identity read after 0\.06s/)
    assert.equal(surface.firstOperator, false)
    assert.equal(surface.identityRetryTimer, null)
  })

  test('with no operator confirmed, the first Tailscale identity reaches the page and the setup routes, and nothing else', async () => {
    await start()
    assert.equal(surface.firstOperator, true)
    assert.equal((await req(surface.port, '/', { headers: served() })).status, 200)
    assert.equal((await req(surface.port, '/api/setup', { headers: served() })).status, 200)
    assert.equal((await req(surface.port, '/api/setup/tailscale', { headers: served() })).status, 200)
    for (const p of ['/terminal/', '/api/settings', '/api/chat/list']) {
      const res = await req(surface.port, p, { headers: served() })
      assert.equal(res.status, 403, p)
      assert.match(res.text, /no operator is confirmed yet, and only setup is open/)
    }
    // The other two legs still hold in the window.
    assert.equal((await req(surface.port, '/', { headers: { host: 'box.tail1234.ts.net:8445' } })).status, 403)
    assert.equal((await req(surface.port, '/', { headers: served({ host: 'evil.example.com' }) })).status, 403)
    assert.equal((await req(surface.port, '/', { headers: served({ [FUNNEL_HEADER]: '?1' }) })).status, 403)
  })

  // The rehearsal of the packaged lifecycle (#891) found the window shut on
  // the Setup page's own requests: the status banner read `/api/overview`
  // and said the console was offline, the browser asked for the favicon,
  // and the GitHub card's manifest flow answered 403. The window admits
  // exactly what Setup needs before an operator is confirmed, and no verb.
  describe('the window admits what the Setup page itself asks for (#891)', () => {
    beforeEach(async () => {
      reply['POST /github-app/start'] = [200, { url: 'https://github.com/settings/apps/new?state=abc', state: 'abc' }]
      reply['GET /github-app/complete'] = [200, { ok: true, screen: 'setup' }]
      await start()
      assert.equal(surface.firstOperator, true)
    })

    test('the page', async () => {
      assert.equal((await req(surface.port, '/', { headers: served() })).status, 200)
      assert.equal((await req(surface.port, '/index.html', { headers: served() })).status, 200)
    })

    test('the favicon the browser asks for beside the page', async () => {
      const res = await req(surface.port, '/favicon.ico', { headers: served() })
      assert.notEqual(res.status, 403)
      assert.doesNotMatch(res.text, /no operator is confirmed yet/)
    })

    test('the overview the status banner reads', async () => {
      const res = await req(surface.port, '/api/overview', { headers: served() })
      assert.equal(res.status, 200, res.text)
      assert.equal(JSON.parse(res.text).operator, 'alp@example.com')
    })

    test('the setup read and the cards\' own reads', async () => {
      assert.equal((await req(surface.port, '/api/setup', { headers: served() })).status, 200)
      assert.equal((await req(surface.port, '/api/setup/tailscale', { headers: served() })).status, 200)
    })

    test('the GitHub App manifest start', async () => {
      const res = await press('/api/github-app/start', { name: 'curia-box', action_id: 'action-0001', screen: 'setup' })
      assert.equal(res.status, 200, res.text)
      assert.equal(sent('/github-app/start').body.screen, 'setup')
    })

    test('the GitHub App manifest callback', async () => {
      const res = await req(surface.port, '/api/github-app/complete?code=c1&state=abc', { headers: served() })
      assert.equal(res.status, 303, res.text)
      assert.equal(res.headers.location, '/#setup')
    })

    test('and no verb: a start is refused with the window\'s sentence', async () => {
      const res = await press('/api/start', { repo: 'o/r', ticket: 1 })
      assert.equal(res.status, 403)
      assert.match(res.text, /no operator is confirmed yet, and only setup is open/)
      assert.equal(calls.some((c) => c.url === '/command'), false)
    })
  })

  test('the panel read carries the login Serve stamped on this request to the daemon, lowercased, and never one the browser named', async () => {
    await start()
    const res = await req(surface.port, '/api/setup/tailscale?login=stranger@example.com', { headers: served() })
    assert.equal(res.status, 200)
    assert.equal(sent('/setup/tailscale?').url, '/setup/tailscale?login=alp%40example.com')
    assert.equal(JSON.parse(res.text).requester, 'alp@example.com')
    daemon.close()
    const down = JSON.parse((await req(surface.port, '/api/setup/tailscale', { headers: served() })).text)
    assert.equal(down.requester, 'alp@example.com')
    assert.equal(down.node, null)
    assert.match(down.error, /daemon|ECONNREFUSED|ECONNRESET|socket hang up/i)
  })

  test('the confirmation sends the request\'s own login and nothing else, then reads the allowlist back so the window closes at once', async () => {
    await start()
    identity = { allow: ['alp@example.com'], first_operator: false }
    const res = await press('/api/setup/tailscale/operator', { machine_name: 'curia.sh', login: 'stranger@example.com' })
    assert.equal(res.status, 200)
    assert.deepEqual(sent('/setup/tailscale/operator').body, { login: 'alp@example.com' }, 'no field the browser sent crosses: not a login, not a machine name')
    assert.equal(JSON.parse(res.text).card.state, 'connected')
    assert.equal(surface.firstOperator, false)
    assert.deepEqual([...surface.allow], ['alp@example.com'])
    assert.equal((await req(surface.port, '/api/overview', { headers: served() })).status, 200)
    assert.equal((await req(surface.port, '/', { headers: served({ [LOGIN_HEADER]: 'stranger@example.com' }) })).status, 403)
  })

  test('a daemon refusal is the sentence the page shows', async () => {
    await start()
    reply['/setup/tailscale/operator'] = [400, { ok: false, error: 'This deployment reads the allowed operators from identity.allow in curia.yaml' }]
    const refused = await press('/api/setup/tailscale/operator', {})
    assert.equal(refused.status, 409)
    assert.match(JSON.parse(refused.text).error, /identity\.allow in curia\.yaml/)
  })

  test('the source deployment keeps curia.yaml\'s list and never asks the daemon for one', async () => {
    await start({ identitySource: 'config', allow: ['alp@example.com'] })
    assert.deepEqual([...surface.allow], ['alp@example.com'])
    assert.equal(surface.firstOperator, false)
    assert.equal(calls.some((c) => c.url === '/identity'), false)
    assert.equal((await req(surface.port, '/api/overview', { headers: served() })).status, 200)
  })
})

describe('the OpenAI card routes (#878)', () => {
  const SERVE_PORT = 8445
  const ORIGIN = 'https://box.tail1234.ts.net:8445'
  const ALLOW = ['alp@example.com']
  let surface
  let daemon
  let calls
  let reply
  let logged
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })
  const press = (p, body) => req(surface.port, p, { method: 'POST', headers: served({ origin: ORIGIN, 'content-type': 'application/json' }), body })
  const sent = (route) => calls.find((c) => c.url === route)
  const OVERVIEW = {
    provider: 'openai', root: true, secret: { state: 'absent' }, identity: null, ending: null, said: null,
    login: { provider: 'openai', session: 'curia-auth-openai', state: 'waiting', url: 'https://auth.openai.com/codex/device', code: '83CC-A4ZTO', typed: false, terminal_url: null, seconds_left: 840 },
    routing: { ready: false, model: 'gpt', rows: [], missing: ['untyped'], credentialed: [] },
  }

  beforeEach(async () => {
    calls = []
    logged = []
    reply = {
      '/setup/openai': [200, OVERVIEW],
      '/setup/openai/login': [200, { ok: true, ...OVERVIEW, login: { provider: 'openai', state: 'starting' } }],
    }
    daemon = http.createServer((r, res) => {
      let buf = ''
      r.on('data', (d) => { buf += d })
      r.on('end', () => {
        calls.push({ method: r.method, url: r.url, body: buf ? JSON.parse(buf) : null })
        const [code, body] = reply[r.url] ?? [404, { error: 'no such route' }]
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise((done) => daemon.listen(0, '127.0.0.1', done))
    surface = new DashboardSurface({
      port: 0, servePort: SERVE_PORT, index: DEFAULT_DASHBOARD_INDEX, allow: ALLOW, pollIntervalS: 5,
      daemonPort: daemon.address().port,
      log: (line) => logged.push(String(line)),
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

  test('the panel read comes from the daemon unedited, with the one-time code and never a token, and a daemon that cannot be asked answers the reason', async () => {
    const res = await req(surface.port, '/api/setup/openai', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), OVERVIEW)
    daemon.close()
    const down = JSON.parse((await req(surface.port, '/api/setup/openai', { headers: served() })).text)
    assert.equal(down.secret, null)
    assert.equal(down.login, null)
    assert.match(down.error, /daemon|ECONNREFUSED|ECONNRESET|socket hang up/i)
  })

  test('the sign-in press crosses with no field at all, whatever the browser sent, and answers the daemon\'s read; a refusal is the sentence the page shows', async () => {
    const res = await press('/api/setup/openai/login', { api_key: 'sk-should-never-cross', provider: 'anthropic' })
    assert.equal(res.status, 200)
    assert.deepEqual(sent('/setup/openai/login').body, {})
    assert.equal(JSON.parse(res.text).login.state, 'starting')
    assert.ok(!res.text.includes('sk-should-never-cross'))
    assert.ok(!logged.join('\n').includes('sk-should-never-cross'))
    reply['/setup/openai/login'] = [400, { ok: false, error: 'this daemon runs no containers, so it has nothing to run the login in' }]
    const refused = await press('/api/setup/openai/login', {})
    assert.equal(refused.status, 409)
    assert.match(JSON.parse(refused.text).error, /runs no containers/)
  })
})

// The Anthropic half of the model card (#879): the same two routes on the
// sidecar, the read relayed unedited and the press composed with no field.
describe('the Anthropic card routes (#879)', () => {
  const SERVE_PORT = 8445
  const ORIGIN = 'https://box.tail1234.ts.net:8445'
  const ALLOW = ['alp@example.com']
  let surface
  let daemon
  let calls
  let reply
  let logged
  const served = (extra = {}) => ({ host: 'box.tail1234.ts.net:8445', [LOGIN_HEADER]: 'alp@example.com', ...extra })
  const press = (p, body) => req(surface.port, p, { method: 'POST', headers: served({ origin: ORIGIN, 'content-type': 'application/json' }), body })
  const sent = (route) => calls.find((c) => c.url === route)
  const OVERVIEW = {
    provider: 'anthropic', root: true, secret: { state: 'absent' }, credential: null, ending: null, said: null,
    login: { provider: 'anthropic', session: 'curia-auth-anthropic', state: 'waiting', url: 'https://claude.com/cai/oauth/authorize?code_challenge=x&state=y', code: null, typed: true, terminal_url: null, seconds_left: 1700 },
    routing: { ready: false, model: 'fable', rows: [], missing: ['research'], credentialed: [] },
  }

  beforeEach(async () => {
    calls = []
    logged = []
    reply = {
      '/setup/anthropic': [200, OVERVIEW],
      '/setup/anthropic/login': [200, { ok: true, ...OVERVIEW, login: { provider: 'anthropic', state: 'starting' } }],
    }
    daemon = http.createServer((r, res) => {
      let buf = ''
      r.on('data', (d) => { buf += d })
      r.on('end', () => {
        calls.push({ method: r.method, url: r.url, body: buf ? JSON.parse(buf) : null })
        const [code, body] = reply[r.url] ?? [404, { error: 'no such route' }]
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise((done) => daemon.listen(0, '127.0.0.1', done))
    surface = new DashboardSurface({
      port: 0, servePort: SERVE_PORT, index: DEFAULT_DASHBOARD_INDEX, allow: ALLOW, pollIntervalS: 5,
      daemonPort: daemon.address().port,
      log: (line) => logged.push(String(line)),
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

  test('the panel read comes from the daemon unedited, with the typed login and never a token, and a daemon that cannot be asked answers the reason', async () => {
    const res = await req(surface.port, '/api/setup/anthropic', { headers: served() })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), OVERVIEW)
    daemon.close()
    const down = JSON.parse((await req(surface.port, '/api/setup/anthropic', { headers: served() })).text)
    assert.equal(down.secret, null)
    assert.equal(down.login, null)
    assert.match(down.error, /daemon|ECONNREFUSED|ECONNRESET|socket hang up/i)
  })

  test('the sign-in press crosses with no field at all, whatever the browser sent, and answers the daemon\'s read; a refusal is the sentence the page shows', async () => {
    const res = await press('/api/setup/anthropic/login', { api_key: 'sk-ant-api03-should-never-cross', token: 'sk-ant-oat01-should-never-cross' })
    assert.equal(res.status, 200)
    assert.deepEqual(sent('/setup/anthropic/login').body, {})
    assert.equal(JSON.parse(res.text).login.state, 'starting')
    assert.ok(!res.text.includes('should-never-cross'))
    assert.ok(!logged.join('\n').includes('should-never-cross'))
    reply['/setup/anthropic/login'] = [400, { ok: false, error: 'this daemon runs no containers, so it has nothing to run the login in' }]
    const refused = await press('/api/setup/anthropic/login', {})
    assert.equal(refused.status, 409)
    assert.match(JSON.parse(refused.text).error, /runs no containers/)
  })

  // #891: the code the browser showed crosses once, as its one field, to the
  // daemon that types it into the login. It reaches no log line here, and a
  // paste that is not a code is refused by shape without being echoed.
  test('the code press crosses as its one field, answers the daemon\'s read, keeps the code out of the log, and refuses a paste that is not a code without echoing it', async () => {
    const code = 'aB3dEf#9oq-pmO4pEY1t4nD2prvbnqYYqlSkptF03z3EABHPaA'
    reply['/setup/anthropic/code'] = [200, { ok: true, delivered: true, said: 'Code delivered. Curia reads the token off the login and verifies it from here.', ...OVERVIEW }]
    const res = await press('/api/setup/anthropic/code', { code: `  ${code}\n`, api_key: 'sk-ant-api03-should-never-cross' })
    assert.equal(res.status, 200)
    assert.deepEqual(sent('/setup/anthropic/code').body, { code })
    assert.equal(JSON.parse(res.text).delivered, true)
    assert.ok(!res.text.includes('should-never-cross'))
    assert.ok(!logged.join('\n').includes(code))

    reply['/setup/anthropic/code'] = [400, { ok: false, error: 'the sign-in session is gone, so there is nothing to type the code into. Start the sign-in again.', delivered: false, ...OVERVIEW }]
    const gone = await press('/api/setup/anthropic/code', { code })
    assert.equal(gone.status, 409)
    assert.match(JSON.parse(gone.text).error, /the sign-in session is gone/)

    const before = calls.length
    for (const bad of [{}, { code: '' }, { code: 'two words' }, { code: 'x'.repeat(600) }]) {
      const refused = await press('/api/setup/anthropic/code', bad)
      assert.equal(refused.status, 409)
      assert.match(JSON.parse(refused.text).error, /paste the authorization code the browser shows/)
      assert.ok(!refused.text.includes('two words') && !refused.text.includes('xxxx'))
    }
    assert.equal(calls.length, before, 'nothing crossed to the daemon')
    assert.ok(!logged.join('\n').includes('two words'))
  })
})

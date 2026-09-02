// The Tailscale card of integration setup (#877, filling the #874 seam under
// the #852 contract).
//
// What is pinned: Curia detects Tailscale and never changes it, so every miss
// names the command the operator runs; the identity that opened the app is
// shown and recorded only on an explicit confirmation, into
// `state/tailscale.json`, and that record is the identity allowlist under a
// root; the node's name is a fact read from the node and recorded, never a
// field the operator types or a comparison (#891); Curia creates and
// records only its own Serve route; verification is the current fact, in
// the order the operator meets it: the node, its login and connection, its
// certificate, the Serve route, and the app's own admission of the
// confirmed login, timed. Nothing here touches a tailnet: `tailscale` is a
// fake `exec` and the app is a fake `probe`.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  TailscaleSetup, readTailscaleRecord, writeTailscaleRecord, serveRoutes, appRoute,
} from '../src/tailscalesetup.mjs'
import { appTerminalUrl } from '../src/attach.mjs'
import { DashboardSurface, DEFAULT_DASHBOARD_INDEX, TERMINAL_PAGE } from '../src/dashboard.mjs'
import { LOGIN_HEADER } from '../src/identity.mjs'
import { withdrawServeRoutes } from '../../cli/src/tailscale.mjs'

const LOGIN = 'alp@example.com'
const DNS = 'curia-sh.tail1234.ts.net'
const SERVE_PORT = 8445
const APP_PORT = 4273

const status = (over = {}) => ({
  Version: '1.98.10-t1234',
  BackendState: 'Running',
  CertDomains: [DNS],
  Self: { DNSName: `${DNS}.`, Online: true, TailscaleIPs: ['100.98.118.33', 'fd7a:115c:a1e0::1'] },
  ...over,
})
const serveConfig = (target = `http://127.0.0.1:${APP_PORT}`) => ({
  TCP: { [SERVE_PORT]: { HTTPS: true } },
  Web: { [`${DNS}:${SERVE_PORT}`]: { Handlers: { '/': { Proxy: target } } } },
})

// A tailscale CLI that answers by argument list, recording every call. A
// route may answer `{ stdout }` or throw, and `serve --bg` flips the served
// config so the read after it sees the route.
function tailscaleCli(over = {}) {
  const calls = []
  const state = { status: status(), serve: {}, ...over }
  const exec = async (file, args) => {
    assert.equal(file, 'tailscale')
    calls.push(args)
    const key = args.join(' ')
    if (key === 'status --json') {
      if (state.status instanceof Error) throw state.status
      return { stdout: JSON.stringify(state.status), stderr: '' }
    }
    if (key === 'serve status --json') {
      if (state.serve instanceof Error) throw state.serve
      return { stdout: JSON.stringify(state.serve), stderr: '' }
    }
    if (args[0] === 'serve' && args[1] === '--bg') {
      if (state.publish instanceof Error) throw state.publish
      state.serve = serveConfig(args[3])
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected tailscale ${key}`)
  }
  return { exec, calls, state }
}

const cliError = (message, code = null) => Object.assign(new Error(message), { stderr: message, code })

// The app on loopback: records the probe and answers by the login it sees.
function app(admit = [LOGIN], { status: code = 200 } = {}) {
  const probes = []
  const probe = async ({ port, headers }) => {
    probes.push({ port, headers })
    const login = headers?.['tailscale-user-login']
    if (!admit.includes(login)) return { status: 403, text: async () => 'curia refused this request: "x" is not on the identity allowlist\n' }
    return { status: code, text: async () => '<html>' }
  }
  return { probe, probes }
}

describe('the Tailscale card (#877)', () => {
  let root
  let stateDir
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-tailscale-'))
    stateDir = path.join(root, 'state')
    fs.mkdirSync(stateDir, { mode: 0o700 })
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const setupOver = (cli = tailscaleCli(), probe = app(), over = {}) => {
    const log = []
    const allow = new Set()
    const setup = new TailscaleSetup({
      root, stateDir, servePort: SERVE_PORT, appPort: APP_PORT, allow, exec: cli.exec, ...(probe ? { probe: probe.probe } : {}),
      log: (line) => log.push(line), now: () => new Date('2026-09-02T10:00:00.000Z'), ...over,
    })
    return { setup, cli, probe, log, allow, verify: setup.verifier() }
  }
  const confirmed = (over = {}) => writeTailscaleRecord(stateDir, { operator: { login: LOGIN, confirmed_at: '2026-09-01T00:00:00.000Z' }, machine_name: 'curia-sh', serve: [], ...over })

  describe('detection', () => {
    test('with no operator recorded the card is unconnected, and tailscale is not asked anything', async () => {
      const { verify, cli } = setupOver()
      assert.deepEqual(await verify({ progress: {} }), { ok: false, unconnected: true })
      assert.equal(cli.calls.length, 0)
    })

    test('the panel read shows the identity that opened the app, the node with its name, the recorded facts, and the private address, and records nothing', async () => {
      const { setup } = setupOver()
      const out = await setup.overview({ login: 'Alp@Example.com' })
      assert.equal(out.requester, LOGIN)
      assert.equal(out.operator, null)
      assert.equal(out.first_operator, true)
      assert.equal(out.machine_name, 'curia-sh', 'the machine name is the node\'s own')
      assert.equal('default_machine_name' in out, false, 'there is no default: the operator named the node at install')
      assert.equal(out.node.online, true)
      assert.equal(out.node.dns_name, DNS)
      assert.equal(out.node.version, '1.98.10')
      assert.deepEqual(out.node.ips, ['100.98.118.33', 'fd7a:115c:a1e0::1'])
      assert.equal(out.app_url, `https://${DNS}:${SERVE_PORT}/`)
      assert.deepEqual(out.serve.route, { https: SERVE_PORT, target: `http://127.0.0.1:${APP_PORT}` })
      assert.deepEqual(out.last_seen, { login: LOGIN, at: '2026-09-02T10:00:00.000Z' })
      assert.equal(fs.existsSync(path.join(stateDir, 'tailscale.json')), false)
      assert.deepEqual(readTailscaleRecord(stateDir), { operator: null, machine_name: null, serve: [] })
    })

    test('a host without tailscale is reported as such in the panel read, and nothing is installed', async () => {
      const cli = tailscaleCli({ status: cliError('spawn tailscale ENOENT', 'ENOENT') })
      const { setup } = setupOver(cli)
      const out = await setup.overview({ login: LOGIN })
      assert.equal(out.node.installed, false)
      assert.equal(out.app_url, null)
      assert.ok(cli.calls.every((args) => args[0] === 'status' || args[0] === 'serve'), 'only reads')
    })

    test('a request without a Tailscale identity is a null requester, never a guess', async () => {
      const { setup } = setupOver()
      assert.equal((await setup.overview({ login: undefined })).requester, null)
      assert.equal((await setup.overview({ login: 'not a login' })).requester, null)
      assert.equal(setup.lastSeen, null)
    })
  })

  describe('the confirmation gate', () => {
    test('confirming records the identity that opened the app and the node\'s own machine name in state/tailscale.json, owner-only, and admits that login at once', async () => {
      const { setup, allow, log } = setupOver()
      assert.deepEqual([...allow], [])
      const out = await setup.confirmOperator({ login: 'Alp@Example.com' })
      assert.deepEqual(readTailscaleRecord(stateDir), { operator: { login: LOGIN, confirmed_at: '2026-09-02T10:00:00.000Z' }, machine_name: 'curia-sh', serve: [] })
      assert.equal(fs.statSync(path.join(stateDir, 'tailscale.json')).mode & 0o777, 0o600)
      assert.deepEqual([...allow], [LOGIN])
      assert.deepEqual(setup.identity(), { allow: [LOGIN], first_operator: false })
      assert.deepEqual(out.operator, { login: LOGIN, confirmed_at: '2026-09-02T10:00:00.000Z' })
      assert.equal(out.first_operator, false)
      assert.match(log.join('\n'), /alp@example.com is the allowed operator, recorded in .*tailscale\.json/)
    })

    test('nothing is recorded before the press: a read of the panel or of the card admits nobody', async () => {
      const { setup, allow, verify } = setupOver()
      await setup.overview({ login: LOGIN })
      await verify({ progress: {} })
      assert.deepEqual([...allow], [])
      assert.deepEqual(setup.identity(), { allow: [], first_operator: true })
    })

    test('a confirmation without a Tailscale identity is refused by name, and a node that cannot be read records no name', async () => {
      const { setup } = setupOver()
      await assert.rejects(() => setup.confirmOperator({ login: '' }), (e) => e.refusal && /no Tailscale identity/.test(e.message))
      await assert.rejects(() => setup.confirmOperator({ login: 'stranger' }), (e) => e.refusal && /no Tailscale identity/.test(e.message))
      assert.equal(fs.existsSync(path.join(stateDir, 'tailscale.json')), false)
      const down = setupOver(tailscaleCli({ status: cliError('failed to connect to local tailscaled') }))
      await down.setup.confirmOperator({ login: LOGIN })
      assert.equal(readTailscaleRecord(stateDir).machine_name, null)
    })

    test('without an installation root the allowlist is curia.yaml\'s, the window never opens, and the confirmation names the key', async () => {
      const allow = new Set()
      const setup = new TailscaleSetup({ root: null, stateDir, servePort: SERVE_PORT, appPort: APP_PORT, allow, configAllow: ['Box@Example.com'], exec: tailscaleCli().exec, probe: app().probe, log: () => {} })
      assert.deepEqual([...allow], ['box@example.com'])
      assert.deepEqual(setup.identity(), { allow: ['box@example.com'], first_operator: false })
      await assert.rejects(() => setup.confirmOperator({ login: LOGIN }), (e) => e.refusal && /identity\.allow in curia\.yaml/.test(e.message))
      assert.deepEqual(await setup.verifier()({ progress: {} }), { ok: false, unconnected: true })
    })

    test('under a root curia.yaml\'s list admits nobody: the recorded operator is the allowlist, filled at boot', () => {
      confirmed()
      const { allow } = setupOver(tailscaleCli(), app(), { configAllow: ['someone-else@example.com'] })
      assert.deepEqual([...allow], [LOGIN])
    })

    test('a record that cannot be read admits nobody and is one failed verification that names the file', async () => {
      fs.writeFileSync(path.join(stateDir, 'tailscale.json'), '{ not json')
      const { verify, allow } = setupOver()
      assert.deepEqual([...allow], [])
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /tailscale\.json: not JSON/)
      assert.match(answer.action, /confirm the operator again/)
      assert.equal(answer.detail.stage, 'record')
    })
  })

  describe('verification', () => {
    test('a confirmed operator on an online node with the route standing is connected: the address, the operator, and the timed admission', async () => {
      confirmed({ serve: [{ https: SERVE_PORT, target: `http://127.0.0.1:${APP_PORT}` }] })
      const cli = tailscaleCli({ serve: serveConfig() })
      const { verify, probe } = setupOver(cli)
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true, JSON.stringify(answer))
      assert.equal(answer.emoji, '🔒')
      assert.equal(answer.primary, DNS)
      assert.match(answer.secondary, /^alp@example\.com · admitted in \d+ ms$/)
      assert.equal(answer.detail.app_url, `https://${DNS}:${SERVE_PORT}/`)
      assert.equal(answer.detail.machine_name, 'curia-sh')
      assert.deepEqual(answer.detail.serve, { url: `https://${DNS}:${SERVE_PORT}/`, route: { https: SERVE_PORT, target: `http://127.0.0.1:${APP_PORT}` }, created: false, error: null })
      assert.equal(answer.detail.app.status, 200)
      assert.equal(typeof answer.detail.app.ms, 'number')
      assert.equal(answer.detail.verified_at, '2026-09-02T10:00:00.000Z')
      assert.equal(answer.detail.node.online, true)
      // The probe carries the served name and the confirmed login, on loopback.
      assert.deepEqual(probe.probes.map((p) => p.port), [APP_PORT])
      assert.equal(probe.probes[0].headers.host, `${DNS}:${SERVE_PORT}`)
      assert.equal(probe.probes[0].headers['tailscale-user-login'], LOGIN)
      // Nothing was published: the route stood.
      assert.ok(cli.calls.every((args) => !(args[0] === 'serve' && args[1] === '--bg')))
    })

    test('tailscale missing from the host is one failed verification whose action is the install page, and Curia installs nothing', async () => {
      confirmed()
      const { verify, cli } = setupOver(tailscaleCli({ status: cliError('spawn tailscale ENOENT', 'ENOENT') }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /isn't installed on this host/)
      assert.match(answer.action, /tailscale\.com\/download\/linux/)
      assert.equal(answer.detail.stage, 'node')
      assert.deepEqual(cli.calls, [['status', '--json']])
    })

    test('a tailscaled that does not answer names the socket error and the command to start it', async () => {
      confirmed()
      const { verify } = setupOver(tailscaleCli({ status: cliError('failed to connect to local tailscaled; it doesn\'t appear to be running') }))
      const answer = await verify({ progress: {} })
      assert.match(answer.failed, /Tailscale isn't answering on this host: failed to connect to local tailscaled/)
      assert.match(answer.action, /sudo systemctl start tailscaled/)
      assert.equal(answer.detail.stage, 'node')
    })

    test('a node that is logged out or offline is one failed verification whose action is tailscale up', async () => {
      confirmed()
      let answer = await setupOver(tailscaleCli({ status: status({ BackendState: 'NeedsLogin' }) })).verify({ progress: {} })
      assert.match(answer.failed, /This node is logged out/)
      assert.match(answer.action, /sudo tailscale up/)
      answer = await setupOver(tailscaleCli({ status: status({ Self: { DNSName: `${DNS}.`, Online: false } }) })).verify({ progress: {} })
      assert.match(answer.failed, /This node is offline/)
      assert.equal(answer.detail.stage, 'node')
    })

    test('a tailnet that issues no certificate is one failed verification whose action is the DNS page of the admin console', async () => {
      confirmed()
      const answer = await setupOver(tailscaleCli({ status: status({ CertDomains: [] }) })).verify({ progress: {} })
      assert.match(answer.failed, /no HTTPS certificate/)
      assert.match(answer.action, /login\.tailscale\.com\/admin\/dns/)
      assert.equal(answer.detail.stage, 'certificate')
    })

    // Since #891 the operator names the node at `curia install`, and the
    // card compares nothing: the node's name is a fact, and the record takes
    // it when the node was renamed by hand.
    test('a node named differently from what the record holds is a fact, not a failure: the card connects and the record takes the node\'s name', async () => {
      confirmed({ machine_name: 'curia-sh' })
      const cli = tailscaleCli({ status: status({ CertDomains: ['alp-workstation.tail1234.ts.net'], Self: { DNSName: 'alp-workstation.tail1234.ts.net.', Online: true } }) })
      const { verify } = setupOver(cli)
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true, JSON.stringify(answer))
      assert.equal(answer.primary, 'alp-workstation.tail1234.ts.net')
      assert.equal(answer.detail.machine_name, 'alp-workstation')
      assert.equal(readTailscaleRecord(stateDir).machine_name, 'alp-workstation')
      assert.ok(cli.calls.every((args) => !args.includes('--hostname') && args[0] !== 'set'), 'Curia never renames the node')
    })

    test('a missing Serve route is created as Curia\'s own, exactly the app on the Serve port, and recorded in state/tailscale.json', async () => {
      confirmed()
      const cli = tailscaleCli()
      const { verify } = setupOver(cli)
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true, JSON.stringify(answer))
      assert.deepEqual(cli.calls.filter((a) => a[1] === '--bg'), [['serve', '--bg', `--https=${SERVE_PORT}`, `http://127.0.0.1:${APP_PORT}`]])
      assert.equal(answer.detail.serve.created, true)
      assert.deepEqual(readTailscaleRecord(stateDir).serve, [{ https: SERVE_PORT, target: `http://127.0.0.1:${APP_PORT}` }])
      // A second read finds the route standing and records it once.
      const again = await verify({ progress: {} })
      assert.equal(again.detail.serve.created, false)
      assert.equal(readTailscaleRecord(stateDir).serve.length, 1)
    })

    test('a Serve that is not permitted is one failed verification whose action is the operator flag, and nothing is recorded', async () => {
      confirmed()
      const denied = cliError('Access denied: serve config denied')
      const { verify } = setupOver(tailscaleCli({ serve: denied, publish: denied }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /could not publish the app with Tailscale Serve: Access denied/)
      assert.match(answer.action, /sudo tailscale set --operator=\$USER/)
      assert.equal(answer.detail.stage, 'serve')
      assert.deepEqual(readTailscaleRecord(stateDir).serve, [])
    })

    test('an app that refuses the confirmed login is one failed verification whose action is a restart', async () => {
      confirmed()
      const { verify } = setupOver(tailscaleCli({ serve: serveConfig() }), app(['someone-else@example.com']))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /The Curia app refuses alp@example\.com: curia refused this request/)
      assert.match(answer.action, /Restart Curia/)
      assert.equal(answer.detail.stage, 'app')
      assert.equal(answer.detail.app.status, 403)
    })

    // The rehearsal of the packaged lifecycle (#891) found the probe never
    // passing on a real box: `fetch` drops a caller-set `Host` as forbidden,
    // so the app saw `Host: 127.0.0.1:4273` and refused it as a name this
    // box does not serve. The fake app hid it. This one is real: a loopback
    // server, the default transport, and the header as the app receives it.
    test('over loopback with the real transport, the app receives the Serve address as its Host header and the recorded login', async () => {
      confirmed()
      const seen = []
      const server = http.createServer((r, res) => {
        seen.push({ host: r.headers.host, login: r.headers['tailscale-user-login'], url: r.url })
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>')
      })
      await new Promise((done) => server.listen(0, '127.0.0.1', done))
      try {
        const { verify } = setupOver(tailscaleCli({ serve: serveConfig() }), null, { appPort: server.address().port })
        const answer = await verify({ progress: {} })
        assert.equal(answer.ok, true, JSON.stringify(answer))
        assert.deepEqual(seen, [{ host: `${DNS}:${SERVE_PORT}`, login: LOGIN, url: '/' }])
        assert.equal(answer.detail.app.status, 200)
      } finally {
        server.close()
      }
    })

    test('an app that is not answering names the port and the compose check', async () => {
      confirmed()
      const probe = { probe: async () => { throw new Error('ECONNREFUSED') } }
      const answer = await setupOver(tailscaleCli({ serve: serveConfig() }), probe).verify({ progress: {} })
      assert.match(answer.failed, /isn't answering on 127\.0\.0\.1:4273 \(ECONNREFUSED\)/)
      assert.match(answer.action, /docker compose ps/)
      assert.equal(answer.detail.stage, 'app')
    })

    test('a retry measures again: a node that went offline reads as offline, and one that came back connects', async () => {
      confirmed()
      const cli = tailscaleCli({ serve: serveConfig() })
      const { verify } = setupOver(cli)
      assert.equal((await verify({ progress: {} })).ok, true)
      cli.state.status = status({ Self: { DNSName: `${DNS}.`, Online: false } })
      assert.match((await verify({ progress: {} })).failed, /offline/)
      cli.state.status = status()
      assert.equal((await verify({ progress: {} })).ok, true)
    })

    test('the connected detail carries when the operator last arrived through Tailscale, from the panel\'s own read', async () => {
      confirmed()
      const { setup, verify } = setupOver(tailscaleCli({ serve: serveConfig() }))
      assert.equal((await verify({ progress: {} })).detail.operator.last_seen_at, null)
      await setup.overview({ login: LOGIN })
      assert.equal((await verify({ progress: {} })).detail.operator.last_seen_at, '2026-09-02T10:00:00.000Z')
      await setup.overview({ login: 'visitor@example.com' })
      assert.equal((await verify({ progress: {} })).detail.operator.last_seen_at, null, 'another login is not the operator arriving')
    })
  })

  describe('the pieces', () => {
    test('the served routes are read out of the serve config, and an empty config is no route', () => {
      assert.deepEqual(serveRoutes(serveConfig()), [{ https: SERVE_PORT, mount: '/', target: `http://127.0.0.1:${APP_PORT}` }])
      assert.deepEqual(serveRoutes({}), [])
      assert.deepEqual(serveRoutes(null), [])
    })

    test('the record refuses a shape it does not keep, so a foreign key or a bad login never becomes the allowlist', () => {
      assert.throws(() => writeTailscaleRecord(stateDir, { operator: { login: 'nobody' } }), /operator\.login must be a Tailscale login/)
      assert.throws(() => writeTailscaleRecord(stateDir, { token: 'x' }), /unknown key token/)
      assert.throws(() => writeTailscaleRecord(stateDir, { serve: [{ https: 'x' }] }), /serve must be a list/)
      assert.deepEqual(writeTailscaleRecord(stateDir, { operator: null, machine_name: null, serve: [] }), { operator: null, machine_name: null, serve: [] })
    })
  })

  // The terminal on a packaged installation (#891). The rehearsal opened the
  // Setup page's terminal link and found ttyd unreached. There is no second
  // route to create: since #714 the terminal is the app's own `/terminal/`
  // path, which the sidecar proxies to ttyd behind the same identity check,
  // and the only Serve route Curia creates is the app's. What is pinned here
  // is that the three pieces agree: the link the daemon composes lands under
  // the app URL the card verified, at the page the sidecar serves on the port
  // the route targets, and the record uninstall reads holds that one route.
  describe('the terminal behind the app route (#891)', () => {
    let surface
    let ttyd
    const seen = []
    afterEach(() => { surface?.stop(); ttyd?.close() })

    test('the composed terminal link is the app route\'s own address at the page the sidecar serves', async () => {
      confirmed()
      const { verify } = setupOver(tailscaleCli({ serve: serveConfig() }))
      const card = await verify({ progress: {} })
      assert.equal(card.ok, true)
      const link = appTerminalUrl(card.detail.address, SERVE_PORT, 'curia-auth-anthropic')
      assert.equal(link, `https://${DNS}:${SERVE_PORT}/terminal/?arg=curia-auth-anthropic`)
      assert.ok(link.startsWith(card.detail.app_url), 'the link is under the verified app URL, so the same route and identity check serve it')
      assert.equal(new URL(link).pathname, TERMINAL_PAGE)
    })

    test('the route\'s target is the sidecar, which serves that page from ttyd for the recorded operator and refuses anyone else', async () => {
      ttyd = http.createServer((req, res) => { seen.push(req.url); res.end('<title>ttyd</title>') })
      await new Promise((done) => ttyd.listen(0, '127.0.0.1', done))
      surface = new DashboardSurface({
        port: 0, servePort: SERVE_PORT, index: DEFAULT_DASHBOARD_INDEX, allow: [LOGIN], terminalPort: ttyd.address().port,
        pollIntervalS: 5, log: () => {},
        deps: { fetchOverview: async () => ({}), assertServe: async () => {}, serveOff: async () => {}, tailnetSelf: async () => ({ dnsName: DNS, ips: [] }) },
      })
      await surface.start()
      await surface.resolveHosts()
      const route = appRoute({ servePort: SERVE_PORT, appPort: surface.port })
      const page = new URL(appTerminalUrl(DNS, SERVE_PORT, 'curia-auth-anthropic'))
      // As a Serve request arrives: the served Host and the stamped login.
      // `fetch` refuses to set Host, so this is a raw request at the target.
      const served = (headers) => new Promise((resolve, reject) => {
        const target = new URL(route.target)
        http.get({ host: target.hostname, port: target.port, path: `${page.pathname}${page.search}`, headers: { host: `${DNS}:${SERVE_PORT}`, ...headers } }, (res) => {
          let text = ''
          res.on('data', (d) => { text += d })
          res.on('end', () => resolve({ status: res.statusCode, text }))
        }).on('error', reject)
      })

      const admitted = await served({ [LOGIN_HEADER]: LOGIN })
      assert.equal(admitted.status, 200)
      assert.match(admitted.text, /ttyd/)
      assert.deepEqual(seen, ['/?arg=curia-auth-anthropic'], 'ttyd receives the session, and the path under the app is the sidecar\'s')

      const stranger = await served({ [LOGIN_HEADER]: 'someone-else@example.com' })
      assert.equal(stranger.status, 403)
      assert.equal(seen.length, 1)
    })

    test('the card records the one route it created, and uninstall withdraws exactly that route', async () => {
      confirmed()
      const { verify } = setupOver(tailscaleCli())
      const card = await verify({ progress: {} })
      assert.equal(card.detail.serve.created, true)
      const route = appRoute({ servePort: SERVE_PORT, appPort: APP_PORT })
      assert.deepEqual(readTailscaleRecord(stateDir).serve, [route], 'one route: the app; the terminal rides it')

      const calls = []
      const tailscale = async (args) => {
        calls.push(args)
        if (args.join(' ') === 'serve status --json') return { ok: true, stdout: JSON.stringify({ ...serveConfig(), TCP: { [SERVE_PORT]: { HTTPS: true }, 8443: { HTTPS: true } } }) }
        return { ok: true, stdout: '' }
      }
      const out = await withdrawServeRoutes({ stateDir }, { tailscale })
      assert.deepEqual(out.withdrawn, [route])
      assert.deepEqual(calls, [['serve', 'status', '--json'], ['serve', `--https=${SERVE_PORT}`, 'off']], 'the app route goes, and no other port is touched')
    })
  })
})

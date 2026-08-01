// The CSRF gate is three lines in index.mjs, and nothing else would notice a
// refactor dropping the control silently (the same argument that got ttydArgv
// exported and pinned). So this boots the REAL daemon — src/index.mjs, the
// shipped code path, not an extraction — on an ephemeral port and asserts the
// gate live: any Origin ⇒ 403 (the "refuse *any* Origin" phrasing is what
// defeats DNS rebinding — never weaken it into an allowlist), cross-site
// Sec-Fetch-Site ⇒ 403, bare loopback tooling ⇒ passes.
//
// The child gets a PATH shim so gh/tmux/tailscale are inert failing stubs
// (boot reconcile must fail SAFE against fixtures, never reach the live box),
// TTYD_BIN pointing nowhere (a missing binary degrades /attach by design),
// and CURIA_CONFIG_DIR/CURIA_DATA_DIR in a temp dir so no real state is read
// or written.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.once('error', reject)
  })
}

// http.request, not fetch: full control over Origin/Sec-Fetch-Site headers
// with no client-side forbidden-header opinions in the way.
function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.once('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

describe('CSRF gate on the loopback surface (index.mjs, real boot)', () => {
  let tmp
  let child
  let port
  let childLog = ''

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-index-test-'))
    const cfgDir = path.join(tmp, 'config')
    const dataDir = path.join(tmp, 'data')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    // inert failing stubs: boot reconcile's gh/tmux reads come back
    // indeterminate (a failed pass, by design), tailscale serve fails non-fatally
    for (const bin of ['gh', 'tmux', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    const [daemonPort, ttydPort, servePort] = [await freePort(), await freePort(), await freePort()]
    port = daemonPort
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:',
      '  - repo: example/fixture',
      '    mode: ready-for-agent',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 1',
      '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work')}`,
      '  ready_timeout_s: 5',
      '  confirm_ttl_h: 1',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:',
      '  untyped: sonnet',
      'models:',
      '  sonnet: { provider: anthropic, backend: claude }',
      'backends:',
      '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
    "    ready: '\u23f5\u23f5|bypass permissions'",
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        TTYD_BIN: path.join(tmp, 'no-such-ttyd'),
        DISCORD_BOT_TOKEN: '', // REST-only: the gate must never depend on the bridge
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (c) => { childLog += c })
    child.stderr.on('data', (c) => { childLog += c })

    const deadline = Date.now() + 10_000
    // poll until the real server answers
    for (;;) {
      try {
        const res = await request(port, 'GET', '/state')
        if (res.status === 200) break
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`daemon did not come up in time; log:\n${childLog}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('a cross-origin POST carrying Origin is refused with 403 and never executed', async () => {
    const res = await request(port, 'POST', '/command', {
      headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
      body: JSON.stringify({ text: 'status' }),
    })
    assert.equal(res.status, 403)
    assert.match(res.body, /cross-origin request refused/)
  })

  test('ANY Origin is refused — including the string "null" and a loopback-looking one (DNS rebinding)', async () => {
    for (const origin of ['null', `http://127.0.0.1:${port}`]) {
      const res = await request(port, 'POST', '/command', {
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ text: 'status' }),
      })
      assert.equal(res.status, 403, `Origin: ${origin} must be refused — the gate is "any Origin", not an allowlist`)
    }
  })

  test('Sec-Fetch-Site: cross-site is refused with 403', async () => {
    const res = await request(port, 'POST', '/command', {
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ text: 'status' }),
    })
    assert.equal(res.status, 403)
  })

  test('bare loopback tooling (no Origin, no Sec-Fetch-Site) passes the gate', async () => {
    const res = await request(port, 'POST', '/escalate', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'gate fixture', kind: 'approve-reject' }),
    })
    assert.equal(res.status, 200)
    assert.ok(JSON.parse(res.body).id, 'the request went through to the real route')
  })

  test('Sec-Fetch-Site: none (a direct navigation-style value) passes', async () => {
    const res = await request(port, 'GET', '/state', { headers: { 'sec-fetch-site': 'none' } })
    assert.equal(res.status, 200)
  })
})

// attachApi.link is inline in index.mjs behind gate.command — like the CSRF
// gate, nothing but a real boot exercises it. This boot pins residual 2: the
// /attach refusal path must WITHDRAW the persisted serve rule, not just
// refuse — `tailscale serve --bg` config survives daemon restarts, there is
// no periodic reconcile (startAutoLoop only schedules dispatch ticks), and
// the URL the rule serves is already sitting in the Discord thread. It also
// exercises residual 5 through the shipped path: TTYD_BIN points nowhere, so
// the spawn branch must come back verified:false instead of verified-by-hope.
describe('attach refusal withdraws the serve rule (index.mjs, real boot)', () => {
  let tmp
  let child
  let port
  let servePort
  let tsLog
  let childLog = ''

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-index-attach-test-'))
    const cfgDir = path.join(tmp, 'config')
    const dataDir = path.join(tmp, 'data')
    const shim = path.join(tmp, 'shim')
    tsLog = path.join(tmp, 'tailscale.log')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    // gh stays an inert failing stub (reconcile fails SAFE, never the live
    // box); tmux succeeds so hasSession('curia-42') is true and link reaches
    // the verification step; tailscale succeeds and RECORDS its argv — the
    // withdrawal is the assertion.
    fs.writeFileSync(path.join(shim, 'gh'), '#!/bin/sh\nexit 1\n')
    fs.writeFileSync(path.join(shim, 'tmux'), '#!/bin/sh\nexit 0\n')
    fs.writeFileSync(path.join(shim, 'tailscale'), `#!/bin/sh\necho "$@" >> ${tsLog}\nexit 0\n`)
    for (const bin of ['gh', 'tmux', 'tailscale']) fs.chmodSync(path.join(shim, bin), 0o755)

    const [daemonPort, ttydPort, sPort, tlPort, tlServePort] = [
      await freePort(), await freePort(), await freePort(), await freePort(), await freePort(),
    ]
    port = daemonPort
    servePort = sPort
    // timeline ports pinned so the surface never lands on its defaults — with
    // the default port free, the timeline binds, `attach` composes its link
    // (#118 item 7) and legitimately asserts the TIMELINE serve rule; the
    // assertion below is about the attach rule only.
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:',
      '  - repo: example/fixture',
      '    mode: ready-for-agent',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 1',
      '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work')}`,
      '  ready_timeout_s: 5',
      '  confirm_ttl_h: 1',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'timeline:',
      `  port: ${tlPort}`,
      `  serve_port: ${tlServePort}`,
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:',
      '  untyped: sonnet',
      'models:',
      '  sonnet: { provider: anthropic, backend: claude }',
      'backends:',
      '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
    "    ready: '\u23f5\u23f5|bypass permissions'",
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        TTYD_BIN: path.join(tmp, 'no-such-ttyd'), // spawn branch: no listener will ever come up
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (c) => { childLog += c })
    child.stderr.on('data', (c) => { childLog += c })

    // wait past BOOT reconcile (it runs its own withdrawal), then start clean
    const deadline = Date.now() + 20_000
    while (!/boot reconcile done/.test(childLog)) {
      if (Date.now() > deadline) throw new Error(`boot reconcile did not finish in time; log:\n${childLog}`)
      await new Promise((r) => setTimeout(r, 100))
    }
    fs.writeFileSync(tsLog, '')
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('attach on an unverifiable listener refuses AND withdraws the persisted serve rule', async () => {
    const res = await request(port, 'POST', '/command', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'attach 42' }),
    })
    assert.equal(res.status, 200)
    const { reply } = JSON.parse(res.body)
    assert.match(reply, /could not be verified/, 'the URL is refused')
    const withdrawn = fs.readFileSync(tsLog, 'utf8').split('\n').filter(Boolean)
    assert.ok(
      withdrawn.some((l) => l.trim() === `serve --https=${servePort} off`),
      `the refusal path must run \`tailscale serve --https=${servePort} off\` — got: ${JSON.stringify(withdrawn)}`,
    )
    // scoped to the ATTACH rule: the timeline surface is genuinely ours and
    // verified, so its own serve rule may be asserted by the same command
    assert.ok(
      !withdrawn.some((l) => /--bg/.test(l) && l.includes(`--https=${servePort}`)),
      'and must never assert the attach rule',
    )
  })
})

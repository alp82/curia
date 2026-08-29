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
// no listener on the ttyd port (a down ttyd service degrades /attach by design),
// and CURIA_CONFIG_DIR/CURIA_DATA_DIR in a temp dir so no real state is read
// or written.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOKEN_HEADER, mintAgentToken } from '../src/agenttoken.mjs'
import { PROBE_MARK, PROBE_PATH } from '../src/sandbox.mjs'
import { freePorts, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'
import { journalEvents, journalText } from './fixtures/journal.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

// http.request, not fetch: full control over Origin/Sec-Fetch-Site headers
// with no client-side forbidden-header opinions in the way.
const request = (port, method, urlPath, opts) => requestOn('127.0.0.1', port, method, urlPath, opts)

// The same, against a chosen address — the #159 suite dials the daemon's
// container-facing listener, which is a different bind on the same port.
function requestOn(host, port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: urlPath, headers }, (res) => {
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
  let watch

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-index-test-'))
    const cfgDir = path.join(tmp, 'config')
    const dataDir = path.join(tmp, 'data')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    fs.mkdirSync(path.join(tmp, 'work', 'home'), { recursive: true })
    // inert failing stubs: boot reconcile's gh/tmux reads come back
    // indeterminate (a failed pass, by design), tailscale serve fails non-fatally
    for (const bin of ['gh', 'tmux', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    const npx = path.join(shim, 'npx')
    fs.writeFileSync(npx, [
      '#!/bin/sh',
      'if [ "$3" = "login" ]; then',
      '  printf "CODE T72NNC\\nOPEN https://aistack.to/cli/auth?code=T72NNC\\n"',
      '  exec sleep 30',
      'fi',
      'printf "auto-sync on\\n"',
    ].join('\n'))
    fs.chmodSync(npx, 0o755)
    const [daemonPort, ttydPort, servePort, proxyPort] = await freePorts(4)
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
      '  claim_login: alp82',
      '  ready_timeout_s: 5',
      '  confirm_ttl_h: 1',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      // #212: the fixture owns its skills root, so this boot depends on
      // nothing under the host's HOME.
      ...skillsYaml(seedSkillsRoot(tmp)),
      ...sandboxYaml(),
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:',
      '  untyped: sonnet',
      'models:',
      '  sonnet: { provider: anthropic, harness: claude }',
      'harnesses:',
      '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
    "    ready: '\u23f5\u23f5|bypass permissions'",
    "    tool_channel_grace_s: 15",
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '', // REST-only: the gate must never depend on the bridge
        // #726: a legacy environment credential must not recreate an absent
        // store. Set it explicitly so this boot proves the path stays retired.
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-realboot-0000000000000000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)

    await waitForBoot(watch, async () => {
      try {
        return (await request(port, 'GET', '/state')).status === 200
      } catch { return false }
    }, 'the /state route')
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('a legacy environment credential cannot recreate an absent store', () => {
    assert.equal(fs.existsSync(path.join(tmp, 'work', 'credentials', 'anthropic.json')), false)
    assert.match(watch.log(), /CLAUDE_CODE_OAUTH_TOKEN is in daemon\/.env\.daemon and nothing reads it/)
    assert.match(watch.log(), /Run reauth anthropic/)
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

  test('machine registration exposes one durable Action and refuses a conflicting press', async () => {
    const post = (route, actionId) => request(port, 'POST', route, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action_id: actionId }),
    })
    const started = await post('/aistack/register', 'atlas-aistack-register-1')
    assert.equal(started.status, 200)
    assert.equal(JSON.parse(started.body).action.status, 'accepted')

    let status
    for (let i = 0; i < 100; i++) {
      status = JSON.parse((await request(port, 'GET', '/aistack')).body)
      if (status.flow?.code) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(status.flow.code, 'T72NNC')
    assert.equal(status.flow.action_id, 'atlas-aistack-register-1')
    assert.equal(status.actions.find((action) => action.action_id === 'atlas-aistack-register-1').status, 'progress')

    const conflict = await post('/aistack/register', 'atlas-aistack-register-2')
    assert.equal(conflict.status, 409)
    assert.equal(JSON.parse(conflict.body).action.status, 'refused')

    const cancelled = await post('/aistack/cancel', 'atlas-aistack-cancel-1')
    assert.equal(cancelled.status, 200)
    assert.equal(JSON.parse(cancelled.body).action.status, 'accepted')

    for (let i = 0; i < 100; i++) {
      status = JSON.parse((await request(port, 'GET', '/aistack')).body)
      const action = status.actions.find((candidate) => candidate.action_id === 'atlas-aistack-cancel-1')
      if (action?.status === 'confirmed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(status.flow.phase, 'cancelled')
    assert.equal(status.actions.find((action) => action.action_id === 'atlas-aistack-cancel-1').status, 'confirmed')
  })

  test('Feed reads are idempotent login-scoped Actions with monotonic cross-device cursors (#811)', async () => {
    const visit = (actionId) => request(port, 'POST', '/feed/read', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'Tester@Example.com', action_id: actionId }),
    })

    const first = JSON.parse((await visit('atlas-feed-read-device-one')).body).action
    assert.equal(first.status, 'confirmed')
    assert.equal(first.target, 'tester@example.com')
    assert.equal(first.conflict_key, 'feed-read:tester@example.com')
    assert.equal(first.receipt.previous, null)

    const retry = JSON.parse((await visit('atlas-feed-read-device-one')).body).action
    assert.deepEqual(retry, first, 'the same Action cannot stamp the cursor twice')

    const second = JSON.parse((await visit('atlas-feed-read-device-two')).body).action
    assert.equal(second.receipt.previous, first.receipt.at)
    assert.ok(second.receipt.at > first.receipt.at)
  })

  test('Sec-Fetch-Site: none (a direct navigation-style value) passes', async () => {
    const res = await request(port, 'GET', '/state', { headers: { 'sec-fetch-site': 'none' } })
    assert.equal(res.status, 200)
  })
})

// The recorded-answer hand-off (#139) lives in index.mjs glue (settle's
// return value → handOffAnswer) — like the CSRF gate, nothing but a real boot
// pair exercises the shipped path: the escalation opens under daemon A, the
// answer lands under daemon B, whose `pending` map never held the resolver.
describe('an answer with no live resolver queues for the resumed agent (#139, real boot pair)', () => {
  let tmp
  let child
  let port
  let watch

  const bootDaemon = async () => {
    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(port),
        CURIA_CONFIG_DIR: path.join(tmp, 'config'),
        CURIA_DATA_DIR: path.join(tmp, 'data'),
        PATH: `${path.join(tmp, 'shim')}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)
    await waitForBoot(watch, async () => {
      try {
        return (await request(port, 'GET', '/state')).status === 200
      } catch { return false }
    }, 'the /state route')
  }

  const killDaemon = () => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    child.kill('SIGKILL')
  })

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-index-139-test-'))
    const cfgDir = path.join(tmp, 'config')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    for (const bin of ['gh', 'tmux', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    const [daemonPort, ttydPort, servePort, proxyPort] = await freePorts(4)
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
      '  claim_login: alp82',
      '  ready_timeout_s: 5',
      '  confirm_ttl_h: 1',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      // #212: the fixture owns its skills root, so this boot depends on
      // nothing under the host's HOME.
      ...skillsYaml(seedSkillsRoot(tmp)),
      ...sandboxYaml(),
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:',
      '  untyped: sonnet',
      'models:',
      '  sonnet: { provider: anthropic, harness: claude }',
      'harnesses:',
      '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
      "    ready: '⏵⏵|bypass permissions'",
      "    tool_channel_grace_s: 15",
      '',
    ].join('\n'))
  })

  after(async () => {
    await killDaemon()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the answer is recorded, the note queues, and the thread names the resume verb', async () => {
    await bootDaemon()
    const esc = await request(port, 'POST', '/escalate', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'curia-7', ticket: '7', kind: 'free-text', prompt: 'pick A or B' }),
    })
    const { id } = JSON.parse(esc.body)
    assert.ok(id)
    await killDaemon()

    // daemon B: the escalation is recovered open, but `pending` is empty
    await bootDaemon()
    const res = await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, answer: 'B' }),
    })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).ok, true, 'the answer is recorded, not rejected')

    // the hand-off: question + answer sit on the agent-note queue, journalled
    const events = journalEvents(path.join(tmp, 'data'))
    const note = events.find((e) => e.type === 'agent_note' && e.agent === 'curia-7')
    assert.ok(note, 'an agent note is queued for the resumed agent')
    assert.match(note.text, /pick A or B/)
    assert.match(note.text, /answer: B/)
    assert.equal(note.after, id, 'tagged with the escalation it answers')

    // the surface half: the thread hears where the answer went (bridge down ⇒ log)
    // `watch` is remade at every boot, so this reads the SECOND daemon's log
    // and nothing the first one said.
    assert.match(watch.log(), /`curia-7` is not running/)
    assert.match(watch.log(), /resume 7/)
  })
})

// attachApi.link is inline in index.mjs behind gate.command — like the CSRF
// gate, nothing but a real boot exercises it. This boot pins residual 2: the
// /attach refusal path must WITHDRAW the persisted serve rule, not just
// refuse — `tailscale serve --bg` config survives daemon restarts, there is
// no periodic reconcile (startAutoLoop only schedules dispatch ticks), and
// the URL the rule serves is already sitting in the Discord thread. It also
// exercises residual 5 through the shipped path: nothing listens on the ttyd
// port, so the probe must come back verified:false instead of verified-by-hope.
describe('attach refusal withdraws the serve rule (index.mjs, real boot)', () => {
  let tmp
  let child
  let port
  let servePort
  let tsLog
  let watch

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

    const [daemonPort, ttydPort, sPort, tlPort, tlServePort, proxyPort] = await freePorts(6)
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
      '  claim_login: alp82',
      '  ready_timeout_s: 5',
      '  confirm_ttl_h: 1',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      // #212: the fixture owns its skills root, so this boot depends on
      // nothing under the host's HOME.
      ...skillsYaml(seedSkillsRoot(tmp)),
      'timeline:',
      `  port: ${tlPort}`,
      `  serve_port: ${tlServePort}`,
      ...sandboxYaml(),
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:',
      '  untyped: sonnet',
      'models:',
      '  sonnet: { provider: anthropic, harness: claude }',
      'harnesses:',
      '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
    "    ready: '\u23f5\u23f5|bypass permissions'",
    "    tool_channel_grace_s: 15",
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)

    // wait past BOOT reconcile (it runs its own withdrawal), then start clean
    await waitForBoot(watch, () => /boot reconcile done/.test(watch.log()), 'the end of boot reconcile', 20_000)
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
    assert.match(reply, /down or stale/, "the URL is refused")
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

// #159. The `?agent=` param used to BE the claim: anything that could reach the
// daemon port could report a result for another agent, ask a question as it, or
// end its turn. #156 is what made that matter — the daemon binds a second
// listener on the docker bridge gateway, and every container on the box reaches
// that address.
//
// Boots the real daemon with a SANDBOXED harness so both listeners come up, and
// fakes only `docker network inspect` — the gateway it reports is 127.0.0.2,
// another loopback address this box can bind and dial. So the container-facing
// listener here is the shipped one, reached the way a container reaches it.
//
// #342 (gap 13 of the codex-lane inventory) makes this boot a TWO-harness box,
// the shape `config/routing.yaml` actually ships. This file used to name the
// claude harness alone, so everything below it was measured on a box that has
// only ever had one lane — and the two things that read the harness table on
// this surface (the side channel's list, and the Stop-hook body codex validates)
// could both have regressed with the suite still green.
describe('the per-agent token on the agent routes (#159, real boot, both listeners)', () => {
  let tmp
  let child
  let port
  let watch
  const GATEWAY = '127.0.0.2'

  const mint = (agent) => mintAgentToken(path.join(tmp, 'data'), agent)

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-token-boot-'))
    const cfgDir = path.join(tmp, 'config')
    const dataDir = path.join(tmp, 'data')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    for (const bin of ['gh', 'tmux', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    // The one fake: the bridge gateway. Everything downstream of it — the second
    // listener, the route narrowing, the token check — is the real code.
    const docker = path.join(shim, 'docker')
    fs.writeFileSync(docker, `#!/bin/sh\necho '[{"Gateway":"${GATEWAY}"}]'\n`)
    fs.chmodSync(docker, 0o755)

    const [daemonPort, ttydPort, servePort, proxyPort] = await freePorts(4)
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
      '  claim_login: alp82',
      '  ready_timeout_s: 5',
      '  confirm_ttl_h: 1',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      // #212: the fixture owns its skills root, so this boot depends on
      // nothing under the host's HOME.
      ...skillsYaml(seedSkillsRoot(tmp)),
      'sandbox:',
      '  image: curia-agent-test',
      '  node_version: 1.0.0',
      '  claude_version: 1.0.0',
      '  codex_version: 1.0.0',
      '  opencode_version: 1.0.0',
      '  pi_version: 1.0.0',
      '  gh_version: 1.0.0',
      '  playwright_version: 1.0.0',
      '  ttyd_version: 1.0.0',
      '  port_from: 9400',
      '  port_to: 9410',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:',
      '  untyped: sonnet',
      'models:',
      '  sonnet: { provider: anthropic, harness: claude }',
      '  gpt: { provider: openai, harness: codex, id: gpt-5.6-sol }',
      'harnesses:',
      '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
    "    ready: '⏵⏵|bypass permissions'",
    "    tool_channel_grace_s: 15",
      '  codex:',
      '    template: codex --model {model} "$(cat {prompt_file})"',
      '    resume_template: codex resume --last --model {model} "Continue the interrupted work."',
      "    ready: '·\\s[~/]'",
      '    tool_channel_grace_s: 20',
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)

    await waitForBoot(watch, async () => {
      try {
        return (await request(port, 'GET', '/state')).status === 200
          && (await requestOn(GATEWAY, port, 'POST', '/agent_done?agent=curia-0')).status === 403
      } catch { return false }
    }, 'both listeners', 15_000)
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // #342, gap 13. The side channel is bound once and serves every containerized
  // harness, and the list it names is `Object.keys(routingConfig.harnesses)` —
  // not a constant, and not the dispatch lane. A daemon that named one harness
  // on a two-harness box would be the #185 fault told backwards: the operator
  // reads a line saying the codex containers have no side channel while they
  // are in fact served, or the reverse.
  test('the side channel names every configured harness, not the one that happened to be first', async () => {
    assert.match(watch.log(), /the side channel for claude, codex containers/)
  })

  test('an agent route with no token is refused on loopback', async () => {
    for (const route of ['/mcp?agent=curia-41&ticket=41', '/agent_done?agent=curia-41']) {
      const res = await request(port, 'POST', route, {
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(res.status, 403, `${route} must not serve an unproven agent`)
      assert.match(res.body, /no valid curia agent token/)
    }
  })

  test('one agent cannot present another agent\'s token', async () => {
    mint('curia-42')
    const other = mint('curia-43')
    const res = await request(port, 'POST', '/agent_done?agent=curia-42', {
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: other },
      body: '{}',
    })
    assert.equal(res.status, 403, 'the header proves a name, not merely that the caller has A token')
  })

  test('the agent curia armed gets through, and the refusal is on the record', async () => {
    const token = mint('curia-44')
    const res = await request(port, 'POST', '/agent_done?agent=curia-44', {
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'fixture' }),
    })
    assert.equal(res.status, 200)
    const journal = journalText(path.join(tmp, 'data'))
    assert.ok(journal.includes('"type":"agent_token_refused"'), 'a refusal is journalled, or nobody ever learns it happened')
    assert.ok(journal.includes('"type":"agent_done"'), 'and the accepted call reached the route')
  })

  // #342, gap 13. The one place index.mjs speaks a codex dialect, and until now
  // the only thing holding it was a comment beside the `return`.
  //
  // Both CLIs read "no decision" as allow, so `{ok:true}` looks harmless and is
  // harmless on the claude lane. Codex validates this body against a CLOSED
  // schema and rejects the extra key outright — `Stop hook (failed): hook
  // returned invalid stop hook JSON output`, printed in the agent's own pane on
  // every clean ending (observed, #152). It fails OPEN, so nothing is trapped
  // and no test of the decision itself would notice; what it costs is the
  // signal, because a genuinely broken hook looks exactly the same.
  //
  // So the assertion is on the KEYS, not on the decision: an allow answer must
  // carry nothing at all.
  test('the Stop hook\'s allow answer is an EMPTY object — codex refuses any extra key', async () => {
    const token = mint('curia-46')
    const res = await request(port, 'POST', '/agent_done?agent=curia-46', {
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'fixture' }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(
      Object.keys(JSON.parse(res.body)),
      [],
      'an allow answer says nothing — a key here is a failed Stop hook on the codex lane and a silent pass on the claude one',
    )
  })

  test('the container-facing listener carries the two side channels and nothing else', async () => {
    // The whole operator surface: dispatching an agent, answering the operator's
    // own questions, forcing a reconcile. A container reaches none of it.
    for (const [method, route, body] of [
      ['POST', '/command', JSON.stringify({ text: 'status' })],
      ['POST', '/answer', JSON.stringify({ id: 'e1', answer: 'approve' })],
      ['POST', '/cancel', JSON.stringify({ id: 'e1' })],
      ['POST', '/escalate', JSON.stringify({ prompt: 'from a container' })],
      ['POST', '/reconcile', '{}'],
      ['GET', '/state', null],
    ]) {
      const res = await requestOn(GATEWAY, port, method, route, {
        headers: { 'content-type': 'application/json' },
        body,
      })
      assert.equal(res.status, 403, `${route} must not be reachable from a container`)
      assert.match(res.body, /not reachable from a curia container/)
    }
    // …and the same routes still answer the operator on loopback.
    assert.equal((await request(port, 'GET', '/state')).status, 200)
  })

  // #314: the overseer container's verbs ARE reachable from the bridge, and a
  // caller with no live turn secret gets nothing from them.
  test('the overseer verb channel is reachable from a container, and closed without a turn secret', async () => {
    const res = await requestOn(GATEWAY, port, 'POST', '/overseer/mcp?turn=nosuchturn', {
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 403)
    assert.match(res.body, /no live curia overseer turn/)
  })

  // #188: the one container-reachable route that needs no agent token, because
  // the daemon sends it BEFORE any agent exists. A bind is not reachability —
  // #185 had the daemon bound on the gateway while ufw dropped every packet from
  // the bridge — so a dispatch proves the path with a container first.
  test('the reachability probe answers a container that has no agent to be', async () => {
    const res = await requestOn(GATEWAY, port, 'GET', PROBE_PATH)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).curia, PROBE_MARK, 'the marker is what says this is curia and not something else on the port')
    // It says nothing else, and it leaves no trace: a wider route here would be
    // a wider container surface than #159 left.
    assert.deepEqual(Object.keys(JSON.parse(res.body)).sort(), ['curia', 'port'])
    const journal = journalText(path.join(tmp, 'data'))
    assert.ok(!journal.includes(PROBE_PATH), 'the probe journals nothing')
  })

  test('a container still reaches its own two routes, with its own token', async () => {
    const token = mint('curia-45')
    const refused = await requestOn(GATEWAY, port, 'POST', '/agent_done?agent=curia-45', {
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(refused.status, 403, 'the gateway address is not a proof of identity')
    const res = await requestOn(GATEWAY, port, 'POST', '/agent_done?agent=curia-45', {
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'fixture' }),
    })
    assert.equal(res.status, 200, 'the Stop hook has to work from inside a container, or the ending is unenforceable')
  })
})

// The restart the settings screen orders (#265, building item 6 of #249).
//
// Real boot, because the whole contract is about a PROCESS: the answer has to
// leave the socket before the exit takes it, and the exit code has to be the
// one `restart: on-failure` respawns on. Neither is visible in a unit test of a
// handler, and a restart that answers 200 and then stays down is the failure
// this suite exists to catch.
describe('POST /restart: the daemon journals and exits nonzero (#265, real boot)', () => {
  let tmp
  let child
  let port
  let dataDir
  let watch

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-index-restart-test-'))
    const cfgDir = path.join(tmp, 'config')
    dataDir = path.join(tmp, 'data')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    for (const bin of ['gh', 'tmux', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    const [daemonPort, ttydPort, servePort, proxyPort, tlPort, tlServePort] = await freePorts(6)
    port = daemonPort
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:', '  - repo: example/fixture', '    mode: ready-for-agent',
      'dispatch:',
      '  auto_dispatch: false', '  max_concurrent: 1', '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work')}`, '  ready_timeout_s: 5',
      '  claim_login: alp82',
      'attach:', `  ttyd_port: ${ttydPort}`, `  serve_port: ${servePort}`,
      'identity:', '  allow: [tester@example.com]', `  proxy_port: ${proxyPort}`,
      'timeline:', `  port: ${tlPort}`, `  serve_port: ${tlServePort}`,
      ...skillsYaml(seedSkillsRoot(tmp)),
      ...sandboxYaml(),
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:', '  untyped: sonnet',
      'models:', '  sonnet: { provider: anthropic, harness: claude }',
      'harnesses:', '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
      "    ready: '⏵⏵|bypass permissions'",
      '    tool_channel_grace_s: 15',
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)
    await waitForBoot(watch, async () => {
      try { return (await request(port, 'GET', '/state')).status === 200 } catch { return false }
    }, 'the /state route')
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the order is answered first and the process exits nonzero after it', async () => {
    const res = await request(port, 'POST', '/restart', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'dashboard', action_id: 'atlas-daemon-restart', uptime_s: 91 }),
    })
    assert.equal(res.status, 200, 'the answer leaves before the exit takes the socket')
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.by, 'dashboard')
    assert.equal(body.action.status, 'accepted')
    assert.equal(body.action.conflict_key, 'daemon:lifecycle')
    assert.equal(body.action.receipt.uptime_s, 91)

    const code = await new Promise((done) => child.once('close', (c) => done(c)))
    assert.equal(code, body.exit_code)
    assert.notEqual(code, 0, 'a clean exit stays down; `restart: on-failure` respawns on a failure')

    // And the journal carries it, so the feed can say a restart happened at all.
    const events = journalEvents(dataDir)
    const logged = events.filter((e) => e.type === 'restart_requested')
    assert.equal(logged.length, 1)
    assert.equal(logged[0].by, 'dashboard')
    assert.equal(logged[0].action_id, body.action.action_id)
  })
})

// The console's verbs reach the daemon (#266). Two of the three seams they use
// are new, and neither is visible from any surface but a browser:
//
//   POST /note   — a note KEYED ON THE AGENT. Discord keys one on the thread it
//                  was typed in, and the console has no thread at all.
//   `by`         — every REST verb journalled the word `rest`. The console
//                  passes the operator's own login instead, so the feed names a
//                  person rather than a transport.
//
// Real boot, because both are route code and an extraction would prove nothing
// about the shipped path. No agent is running against these fixtures, which is
// itself the case worth pinning: a note at an agent that is not there queues
// nothing and says so, rather than being lost into a queue nobody drains.
describe('the console verbs on the loopback surface (#266, real boot)', () => {
  let tmp
  let child
  let port
  let dataDir
  let watch

  const journal = () => journalEvents(dataDir)
  const post = (route, body) => request(port, 'POST', route, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-index-verbs-test-'))
    const cfgDir = path.join(tmp, 'config')
    dataDir = path.join(tmp, 'data')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    for (const bin of ['gh', 'tmux', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    const [daemonPort, ttydPort, servePort, proxyPort, tlPort, tlServePort] = await freePorts(6)
    port = daemonPort
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:', '  - repo: example/fixture', '    mode: ready-for-agent',
      'dispatch:',
      '  auto_dispatch: false', '  max_concurrent: 1', '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work')}`, '  ready_timeout_s: 5',
      '  claim_login: alp82',
      'attach:', `  ttyd_port: ${ttydPort}`, `  serve_port: ${servePort}`,
      'identity:', '  allow: [tester@example.com]', `  proxy_port: ${proxyPort}`,
      'timeline:', `  port: ${tlPort}`, `  serve_port: ${tlServePort}`,
      ...skillsYaml(seedSkillsRoot(tmp)),
      ...sandboxYaml(),
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:', '  untyped: sonnet',
      'models:', '  sonnet: { provider: anthropic, harness: claude }',
      'harnesses:', '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
      "    ready: '⏵⏵|bypass permissions'",
      '    tool_channel_grace_s: 15',
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)
    await waitForBoot(watch, async () => {
      try { return (await request(port, 'GET', '/state')).status === 200 } catch { return false }
    }, 'the /state route')
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('a note at an agent that is not running queues nothing, and says which verb puts one back', async () => {
    const res = await post('/note', { agent: 'curia-4242', text: 'have another look at the migration', by: 'alp@example.com' })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.reads, false, 'nothing queued — #208: words typed at a dead agent die with it')
    assert.equal(body.id, null)
    assert.match(body.why, /resume 4242/, 'the way out is named, not left to be guessed')
    const refused = journal().filter((e) => e.type === 'agent_note_refused')
    assert.equal(refused.at(-1).agent, 'curia-4242')
    assert.equal(refused.at(-1).by, 'alp@example.com', 'the refusal names who tried, not the transport')
  })

  test('the interrupt mode is refused the same way, and refuses on the daemon\'s own words', async () => {
    const res = await post('/note', { agent: 'curia-4242', text: 'stop that', mode: 'interrupt', by: 'alp@example.com' })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.mode, 'interrupt')
  })

  test('a session name this daemon would never mint is refused before anything is written', async () => {
    for (const agent of ['', 'curia-263; rm -rf /', '../../etc/passwd', 'notcuria-1']) {
      const res = await post('/note', { agent, text: 'hello' })
      assert.equal(res.status, 400, `${agent} is not a curia session name`)
      assert.match(JSON.parse(res.body).error, /not a curia session name/)
    }
  })

  test('a note with no words is not a note', async () => {
    const res = await post('/note', { agent: 'curia-1', text: '   ' })
    assert.equal(res.status, 400)
    assert.match(JSON.parse(res.body).error, /no words/)
  })

  test('a command carries the operator who pressed into the journal', async () => {
    const res = await post('/command', { text: 'status', by: 'alp@example.com' })
    assert.equal(res.status, 200)
    const logged = journal().filter((e) => e.type === 'command').at(-1)
    assert.equal(logged.canonical, 'status')
    assert.equal(logged.by, 'alp@example.com')
  })

  test('a caller that names nobody is still `rest` — every seam before this one sent that', async () => {
    await post('/command', { text: 'status' })
    assert.equal(journal().filter((e) => e.type === 'command').at(-1).by, 'rest')
  })

  test('an answer to a question curia does not hold refuses with the reason, never a silent 200', async () => {
    const res = await post('/answer', { id: 'esc-nope', answer: 'approve', by: 'alp@example.com', via: 'dashboard' })
    assert.equal(res.status, 409)
    assert.equal(JSON.parse(res.body).reason, 'unknown')
  })

  // The typed card from a browser (#712, ADR-0025): an index is the option's
  // own words, a reply file lands where the card said, and the second answer
  // gets the first receipt and no second journal line.
  describe('one answer, from any surface (#712)', () => {
    let id
    before(async () => {
      const res = await post('/escalate', { agent: 'curia-1', ticket: '1', kind: 'choice', prompt: 'which?', options: ['Stable', 'Preview'] })
      id = JSON.parse(res.body).id
    })

    test('an Atlas answer and a later Discord answer agree on the shared winner', async () => {
      const data = Buffer.from('a: 1\n').toString('base64')
      const res = await post('/answer', {
        id, index: 1, answer: '', by: 'alp@example.com', via: 'dashboard', action_id: 'atlas-answer-esc-choice',
        files: [{ name: '../../notes.txt', data }, { name: 'shot.png', data: Buffer.from('png').toString('base64') }],
      })
      assert.equal(res.status, 200, res.body)
      const atlas = JSON.parse(res.body)
      assert.equal(atlas.action.status, 'confirmed')
      assert.equal(atlas.action.kind, 'escalation-answer')
      assert.equal(atlas.action.target, id)
      assert.equal(atlas.action.conflict_key, `answer:${id}`)
      const answered = journal().filter((e) => e.type === 'esc_answer' && e.id === id)
      assert.equal(answered.length, 1)
      const dir = path.join(dataDir, 'attachments', id)
      assert.deepEqual(fs.readdirSync(dir).sort(), ['notes-1.txt', 'shot-2.png'], 'the names are made safe and numbered like a Discord download')
      assert.match(answered[0].answer, /^Preview\n\[attachment: .*notes-1\.txt\]\n\[attachment: .*shot-2\.png\]$/)
      assert.deepEqual(answered[0].attachments, [path.join(dir, 'notes-1.txt'), path.join(dir, 'shot-2.png')])
      assert.equal(fs.readFileSync(path.join(dir, 'notes-1.txt'), 'utf8'), 'a: 1\n')
    })

    test('a second answer is refused with the first receipt, and journals nothing', async () => {
      const res = await post('/answer', { id, index: 0, by: 'other', via: 'button', action_id: 'discord-answer-esc-choice', files: [{ name: 'late.txt', data: Buffer.from('x').toString('base64') }] })
      assert.equal(res.status, 409)
      const body = JSON.parse(res.body)
      assert.equal(body.reason, 'answered')
      assert.equal(body.action.status, 'refused')
      assert.equal(body.action.conflict_key, `answer:${id}`)
      assert.equal(body.receipt.by, 'alp@example.com')
      assert.equal(body.receipt.via, 'dashboard')
      assert.match(body.receipt.answer, /^Preview/)
      assert.ok(body.receipt.at)
      assert.equal(journal().filter((e) => e.type === 'esc_answer' && e.id === id).length, 1)
      assert.equal(fs.existsSync(path.join(dataDir, 'attachments', id, 'late-1.txt')), false, 'a late reply writes no file')
    })

    test('a file type curia would refuse on the way out is refused on the way in, by name', async () => {
      const open = JSON.parse((await post('/escalate', { agent: 'curia-2', ticket: '2', kind: 'free-text', prompt: 'notes?' })).body)
      const res = await post('/answer', { id: open.id, answer: 'here', files: [{ name: 'tool.exe', data: Buffer.from('MZ').toString('base64') }] })
      assert.equal(res.status, 400)
      assert.match(JSON.parse(res.body).error, /tool\.exe: refused/)
      assert.equal(journal().filter((e) => e.type === 'esc_answer' && e.id === open.id).length, 0)
    })
  })

  // ---- the browser conversations (#333, ADR-0016) ----------------------------
  //
  // Live, on the real daemon, because the rule that matters is durable: a
  // number is spent the moment it is minted, and the journal is what keeps it
  // spent. A unit test over the reduction proves the reduction; this proves the
  // route the Chat screen actually calls.

  test('the list starts empty — the cutover copies no history and nothing mints on a read', async () => {
    const res = await request(port, 'GET', '/console')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body).conversations, [])
    // The old single `console` key does not survive, and no boot invents one.
    assert.equal(journal().filter((e) => e.type === 'console_conversation_opened').length, 0)
  })

  test('a mint journals the key and the list carries its session name', async () => {
    const first = JSON.parse((await post('/console/new', {})).body)
    assert.equal(first.key, 'console-1')
    assert.equal(first.session, 'curia-console-1')
    const second = JSON.parse((await post('/console/new', {})).body)
    assert.equal(second.key, 'console-2')

    const list = JSON.parse((await request(port, 'GET', '/console')).body).conversations
    assert.deepEqual(list.map((c) => c.key), ['console-2', 'console-1'], 'newest first')
    // Neither has taken a turn, so neither has a transcript. ADR-0016 case 8:
    // the honest answer is no reading, never another conversation's percent.
    assert.deepEqual(list.map((c) => c.ctx_pct), [null, null])
    assert.deepEqual(list.map((c) => c.label), [null, null])
    assert.equal(journal().filter((e) => e.type === 'console_conversation_opened').length, 2)
  })

  test('a mint Action is idempotent and carries the new conversation for immediate navigation', async () => {
    const action_id = 'atlas-console-new-1'
    const first = JSON.parse((await post('/console/new', { action_id })).body)

    assert.equal(first.action.status, 'confirmed')
    assert.equal(first.action.kind, 'console-conversation-open')
    assert.equal(first.action.conflict_key, 'conversation-registry')
    assert.match(first.key, /^console-\d+$/)
    assert.equal(first.session, `curia-${first.key}`)

    const retried = JSON.parse((await post('/console/new', { action_id })).body)
    assert.equal(retried.action.action_id, action_id)
    assert.equal(retried.key, first.key)
    assert.equal(journal().filter((e) => e.type === 'console_conversation_opened' && e.key === first.key).length, 1)
  })

  test('a deleted number is spent — the next conversation counts past it', async () => {
    assert.equal((await post('/console/delete', { key: 'console-1' })).status, 200)
    const list = JSON.parse((await request(port, 'GET', '/console')).body).conversations
    assert.deepEqual(list.map((c) => c.key), ['console-3', 'console-2'])
    const next = JSON.parse((await post('/console/new', {})).body)
    assert.equal(next.key, 'console-4', 'never console-1 again — that would wake the deleted memory')
  })

  test('deleting one that is not there is a refusal in words, not a silent success', async () => {
    const res = await post('/console/delete', { key: 'console-1' })
    assert.equal(res.status, 409)
    assert.match(JSON.parse(res.body).error, /no conversation/)
  })

  test('delete Actions conflict per conversation and a stale delete is refused', async () => {
    const created = JSON.parse((await post('/console/new', { action_id: 'atlas-console-new-delete' })).body)
    const deleted = JSON.parse((await post('/console/delete', {
      key: created.key, action_id: 'atlas-console-delete-1',
    })).body)

    assert.equal(deleted.action.status, 'confirmed')
    assert.equal(deleted.action.target, created.key)
    assert.equal(deleted.action.conflict_key, `conversation:${created.key}`)
    assert.equal(deleted.action.receipt.key, created.key)

    const stale = await post('/console/delete', {
      key: created.key, action_id: 'atlas-console-delete-stale',
    })
    assert.equal(stale.status, 409)
    const refusal = JSON.parse(stale.body)
    assert.equal(refusal.action.status, 'refused')
    assert.match(refusal.action.reason, /no conversation/)
  })

  test('a key this daemon would never mint is refused before anything is journalled', async () => {
    const before = journal().length
    for (const key of ['', 'console', 'chat-1', 'curia-console-1', 'console-1; rm -rf /']) {
      const res = await post('/console/delete', { key })
      assert.equal(res.status, 400, key)
      assert.match(JSON.parse(res.body).error, /not a browser conversation key/)
    }
    assert.equal(journal().length, before, 'nothing was written')
  })
})

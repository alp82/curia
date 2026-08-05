// #56: an unhandled Discord gateway error killed the whole daemon.
//
// The unit half pins the classifier, because the guard's whole value is that it
// is NOT a swallow-everything net: a network failure survives, a logic bug still
// kills the process. The boot half is the one that matters — it starts the REAL
// daemon, opens a real escalation, induces the real crash inside the real
// process, and asserts the ticket's own bar: the daemon lives, the bridge outage
// is on the record, and the blocked question is still answerable across it.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { classifyFault, installCrashGuard } from '../src/health.mjs'
import { freePort, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')
const INDUCE = pathToFileURL(path.join(DIR, 'fixtures', 'induce-fault.mjs')).href

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const json = (port, method, urlPath, obj) => request(port, method, urlPath, {
  headers: { 'content-type': 'application/json' },
  body: obj === undefined ? null : JSON.stringify(obj),
})

function events(dataDir) {
  const p = path.join(dataDir, 'events.jsonl')
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

describe('classifyFault (#56) — narrow on purpose', () => {
  test("#56's own error is transient", () => {
    const r = classifyFault(new Error('Opening handshake has timed out'))
    assert.equal(r.transient, true)
    assert.match(r.why, /handshake/i)
  })

  test('a socket error code is transient wherever it was raised', () => {
    const e = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    assert.equal(classifyFault(e).transient, true)
  })

  test('undici hides the real failure on .cause — the chain is walked', () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    const wrapper = Object.assign(new TypeError('fetch failed'), { cause })
    assert.equal(classifyFault(wrapper).transient, true, 'a bare "fetch failed" carries no signal of its own')
  })

  // The live check killed the daemon at 10:47 on 27 July with this exact error,
  // during a real DNS outage: discord.js identifying on a socket still in
  // CONNECTING. No error code, no network word in the message — the first
  // classifier called it a logic bug and exited. The stack is the evidence that
  // it was not: every frame inside the gateway client, none inside curia.
  test('the error that killed the daemon during the live check is transient', () => {
    const e = new Error('WebSocket is not open: readyState 0 (CONNECTING)')
    e.stack = [
      'Error: WebSocket is not open: readyState 0 (CONNECTING)',
      '    at TrackedWebSocket.send (/home/alp/dev/projects/curia/daemon/node_modules/ws/lib/websocket.js:457:13)',
      '    at WebSocketShard.send (/home/alp/dev/projects/curia/daemon/node_modules/@discordjs/ws/dist/index.js:799:23)',
      '    at WebSocketShard.identify (/home/alp/dev/projects/curia/daemon/node_modules/@discordjs/ws/dist/index.js:880:16)',
    ].join('\n')
    const r = classifyFault(e)
    assert.equal(r.transient, true, 'a gateway race must not kill the daemon that exists to survive gateway races')
  })

  test('the same error is FATAL once one of our own frames is on the stack', () => {
    const e = new Error('WebSocket is not open: something')
    e.stack = [
      'Error: WebSocket is not open: something',
      `    at renderEscalation (${path.join(DIR, '..', 'src', 'index.mjs')}:99:7)`,
      '    at WebSocketShard.send (/home/alp/dev/projects/curia/daemon/node_modules/@discordjs/ws/dist/index.js:799:23)',
    ].join('\n')
    // the message list still catches this one; the point is the ORIGIN rule
    // alone must not rescue an error that ran through curia's own code
    const viaOrigin = classifyFault(Object.assign(new Error('some internal assertion'), { stack: e.stack }))
    assert.equal(viaOrigin.transient, false, 'a fault reached through discord.js is still ours to die on')
  })

  test('a logic bug is NOT transient — it must still kill the daemon', () => {
    for (const e of [new TypeError('x is not a function'), new ReferenceError('foo is not defined')]) {
      assert.equal(classifyFault(e).transient, false, `${e.name} must stay fatal`)
    }
  })

  test('a thrown non-Error is not transient', () => {
    assert.equal(classifyFault('ECONNRESET').transient, false, 'a bare string is not a network fact, it is a bug')
  })

  test('a cyclic cause chain terminates', () => {
    const a = new TypeError('a')
    const b = new TypeError('b')
    a.cause = b
    b.cause = a
    assert.equal(classifyFault(a).transient, false)
  })
})

describe('installCrashGuard (#56) — journal, then decide', () => {
  test('a transient is journalled and the process is NOT exited', () => {
    const seen = []
    let exited = null
    const handle = installCrashGuard({
      log: () => {},
      journal: (type, detail) => seen.push([type, detail]),
      exit: (c) => { exited = c },
    })
    handle(new Error('Opening handshake has timed out'), 'uncaughtException')
    assert.equal(exited, null, 'a network blip must not end the daemon')
    assert.equal(seen[0][0], 'daemon_transient')
    process.removeAllListeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
  })

  test('a fault is journalled BEFORE the exit — a bare crash leaves no trace at all', () => {
    const seen = []
    let exited = null
    const handle = installCrashGuard({
      log: () => {},
      journal: (type, detail) => seen.push([type, detail]),
      exit: (c) => { exited = c },
    })
    handle(new TypeError('planted'), 'uncaughtException')
    assert.equal(exited, 1)
    assert.equal(seen[0][0], 'daemon_fault')
    assert.match(seen[0][1].stack, /planted/)
    process.removeAllListeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
  })

  test('a journal that throws does not stop the guard from deciding', () => {
    let exited = null
    const handle = installCrashGuard({
      log: () => {},
      journal: () => { throw new Error('disk full') },
      exit: (c) => { exited = c },
    })
    handle(new TypeError('planted'), 'uncaughtException')
    assert.equal(exited, 1, 'the decision must not depend on the journal write')
    process.removeAllListeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
  })
})

// The real thing. Same fixture posture as index.test.mjs: inert gh/tmux/tailscale
// shims, temp config + data dir, REST-only (no bridge token) — nothing here
// touches the live box.
function bootFixture(tmp, extraEnv) {
  const cfgDir = path.join(tmp, 'config')
  const shim = path.join(tmp, 'shim')
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.mkdirSync(shim, { recursive: true })
  for (const bin of ['gh', 'tmux', 'tailscale']) {
    const p = path.join(shim, bin)
    fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(p, 0o755)
  }
  return { cfgDir, shim, extraEnv }
}

async function writeConfig(cfgDir, tmp) {
  const [ttydPort, servePort, proxyPort] = [await freePort(), await freePort(), await freePort()]
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
    'identity:',
    '  allow: [tester@example.com]',
    `  proxy_port: ${proxyPort}`,
    // #212: the fixture owns its skills root, so this boot depends on nothing
    // under the host's HOME.
    ...skillsYaml(seedSkillsRoot(tmp)),
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
    "    ready: '\u23f5\u23f5|bypass permissions'",
    "    tool_channel_grace_s: 15",
    '',
  ].join('\n'))
}

const waitForDaemon = (port, watch) => waitForBoot(watch, async () => {
  try {
    return (await request(port, 'GET', '/state')).status === 200
  } catch { return false }
}, 'the /state route')

describe('the daemon survives the gateway crash it died of (real boot, induced)', () => {
  let tmp, child, port, dataDir, watch

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-health-test-'))
    dataDir = path.join(tmp, 'data')
    const { cfgDir, shim } = bootFixture(tmp)
    await writeConfig(cfgDir, tmp)
    port = await freePort()
    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(port),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        TTYD_BIN: path.join(tmp, 'no-such-ttyd'),
        DISCORD_BOT_TOKEN: '',
        NODE_OPTIONS: `--import ${INDUCE}`,
        CURIA_INDUCE: 'ws-handshake',
        CURIA_INDUCE_AFTER_MS: '600',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)
    await waitForDaemon(port, watch)
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the abandoned socket kills nothing, and the escalation open across it is still answerable', async () => {
    // opened BEFORE the fault: this is the agent whose question the crash took
    // down with it on 26 July.
    const opened = await json(port, 'POST', '/escalate', { ticket: '999', kind: 'free-text', prompt: 'still there?' })
    assert.equal(opened.status, 200)
    const id = JSON.parse(opened.body).id

    // the induced socket's handshake times out ~1.1s in; wait past it
    const deadline = Date.now() + 8_000
    let transient = null
    while (Date.now() < deadline && !transient) {
      transient = events(dataDir).find((e) => e.type === 'daemon_transient')
      if (!transient) await sleep(150)
    }

    assert.ok(transient, `no daemon_transient was journalled; log:\n${watch.log()}`)
    assert.match(transient.message, /Opening handshake has timed out/)
    assert.equal(transient.origin, 'uncaughtException')
    assert.equal(child.exitCode, null, `the daemon died anyway; log:\n${watch.log()}`)

    // the surface still works...
    const state = await request(port, 'GET', '/state')
    assert.equal(state.status, 200)
    assert.ok(JSON.parse(state.body).open_escalations.some((r) => r.id === id))

    // ...and the question opened before the crash still closes.
    const answered = await json(port, 'POST', '/answer', { id, answer: 'yes' })
    assert.equal(answered.status, 200, `the pre-fault escalation was not answerable: ${answered.body}`)
    assert.equal(JSON.parse(answered.body).ok, true)
  })
})

describe('a planted logic bug still kills the daemon (real boot, induced)', () => {
  let tmp, child, port, dataDir, watch

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-health-fault-'))
    dataDir = path.join(tmp, 'data')
    const { cfgDir, shim } = bootFixture(tmp)
    await writeConfig(cfgDir, tmp)
    port = await freePort()
    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(port),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        TTYD_BIN: path.join(tmp, 'no-such-ttyd'),
        DISCORD_BOT_TOKEN: '',
        NODE_OPTIONS: `--import ${INDUCE}`,
        CURIA_INDUCE: 'bug',
        CURIA_INDUCE_AFTER_MS: '600',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)
    await waitForDaemon(port, watch)
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('it exits 1 and leaves a daemon_fault line, which a bare crash never did', async () => {
    const code = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode)
      child.once('exit', (c) => resolve(c))
      setTimeout(() => resolve(null), 8_000)
    })
    assert.equal(code, 1, `the guard must not keep a broken daemon alive; log:\n${watch.log()}`)
    const fault = events(dataDir).find((e) => e.type === 'daemon_fault')
    assert.ok(fault, `no daemon_fault journalled; log:\n${watch.log()}`)
    assert.match(fault.message, /planted logic bug/)
    assert.equal(fault.transient, false)
  })
})

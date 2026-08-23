// `POST /reload` (#362, building the hot-reload decision #347).
//
// A save applies now: the sidecar asks the daemon to re-read both files, and
// the daemon takes the settings the settings screen writes without the
// restart that used to be phase two of every save.
//
// This is pinned against a REAL boot for the reason the CSRF gate and the
// overview shape are: the route is a wire contract between two processes, and
// the thing it moves is the config OBJECT this daemon already holds. An
// extraction would prove the extraction. So `src/index.mjs` runs on an
// ephemeral port, the override files are written beside the tracked ones the
// way a save writes them, and every claim is read back off `GET /overview` —
// the same reading the console draws.
//
// Three of the four cases below are refusals, because "a reload is total or it
// is nothing" is the whole rule: a file the loaders refuse, a key outside the
// closed set, and a path check only this container can run all leave the
// running config exactly as it was.

import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePorts, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

function request(port, method, urlPath, { body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.once('error', reject)
    if (body !== null) req.write(JSON.stringify(body))
    req.end()
  })
}

describe('POST /reload (index.mjs, real boot)', () => {
  let tmp
  let cfgDir
  let child
  let port
  let watch

  const overCuria = () => path.join(cfgDir, 'curia.local.yaml')
  const overRouting = () => path.join(cfgDir, 'routing.local.yaml')
  const write = (file, lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`)

  const reload = async (by = 'alp@example.com') => JSON.parse((await request(port, 'POST', '/reload', { body: { by } })).body)
  const running = async () => JSON.parse((await request(port, 'GET', '/overview')).body).daemon
  const events = async () => JSON.parse((await request(port, 'GET', '/overview')).body).events

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-reload-test-'))
    cfgDir = path.join(tmp, 'config')
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
    write(path.join(cfgDir, 'curia.yaml'), [
      'watch:',
      '  - repo: example/fixture',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 2',
      '  poll_interval_s: 60',
      '  prototype_variations: 5',
      `  workspace_root: ${path.join(tmp, 'work')}`,
      '  claim_login: alp82',
      '  ready_timeout_s: 45',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      ...skillsYaml(seedSkillsRoot(tmp)),
      ...sandboxYaml(),
    ])
    write(path.join(cfgDir, 'routing.yaml'), [
      'defaults:',
      '  untyped: sonnet',
      'models:',
      '  sonnet: { provider: anthropic, harness: claude }',
      '  opus: { provider: anthropic, harness: claude }',
      'harnesses:',
      '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
      "    ready: 'bypass permissions'",
      '    tool_channel_grace_s: 15',
    ])

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: path.join(tmp, 'data'),
        PATH: `${shim}:${process.env.PATH}`,
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
  })

  // Every test starts from the tracked files alone, so one case's apply is
  // never the next case's starting point.
  beforeEach(async () => {
    fs.rmSync(overCuria(), { force: true })
    fs.rmSync(overRouting(), { force: true })
    await reload()
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the settings apply, and overview reports what the daemon runs', async () => {
    const before = await running()
    assert.deepEqual(before.config.dispatch, {
      auto_dispatch: false,
      max_concurrent: 2,
      poll_interval_s: 60,
      prototype_variations: 5,
    })

    write(overCuria(), [
      'dispatch:',
      '  auto_dispatch: true',
      '  max_concurrent: 4',
      '  poll_interval_s: 15',
      '  prototype_variations: 7',
      'watch:',
      '  - repo: example/fixture',
      '  - repo: example/second',
      '    mode: map',
    ])
    write(overRouting(), [
      'defaults:',
      '  untyped: opus',
      'models:',
      '  sonnet:',
      '    active: false',
    ])

    const out = await reload()
    assert.equal(out.ok, true)
    assert.deepEqual(out.applied.sort(), [
      'dispatch.auto_dispatch', 'dispatch.max_concurrent', 'dispatch.poll_interval_s',
      'dispatch.prototype_variations',
      'routing.defaults.untyped', 'routing.models.sonnet.active', 'watch',
    ])

    const after = await running()
    assert.deepEqual(after.config.dispatch, {
      auto_dispatch: true,
      max_concurrent: 4,
      poll_interval_s: 15,
      prototype_variations: 7,
    })
    assert.deepEqual(after.config.watch, [
      { repo: 'example/fixture', mode: 'auto' }, { repo: 'example/second', mode: 'map' },
    ])
    assert.deepEqual(after.config.routing, {
      defaults: [{ type: 'untyped', model: 'opus' }],
      models: [{ name: 'sonnet', active: false }, { name: 'opus', active: true }],
    })
    // The older spelling of the same two values moves with them: one daemon,
    // one config object, so the page can never read a stale pair beside a fresh
    // one.
    assert.equal(after.auto_dispatch, true)
    assert.equal(after.max_concurrent, 4)
    assert.notEqual(after.config.loaded_at, before.config.loaded_at, 'the stamp says when this reading was taken')
  })

  test('the journal names who reloaded and what moved', async () => {
    write(overCuria(), ['dispatch:', '  max_concurrent: 5'])
    await reload('alp@example.com')
    const last = (await events()).filter((e) => e.type === 'config_reloaded').pop()
    assert.equal(last.by, 'alp@example.com')
    assert.deepEqual(last.keys, ['dispatch.max_concurrent'])
  })

  test('a key outside the closed set applies NOTHING and names that key', async () => {
    write(overCuria(), ['dispatch:', '  max_concurrent: 6', '  ready_timeout_s: 99'])
    const out = await reload()
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'restart-needed')
    assert.equal(out.key, 'dispatch.ready_timeout_s')
    assert.match(out.error, /restart the daemon to take it/)
    // The reloadable half of the same file did not sneak in: a reload is total
    // or it is nothing.
    assert.equal((await running()).config.dispatch.max_concurrent, 2)
    const last = (await events()).filter((e) => e.type === 'config_reload_declined').pop()
    assert.equal(last.reason, 'restart-needed')
  })

  test('a file the loaders refuse applies nothing and answers their own message', async () => {
    write(overCuria(), ['dispatch:', '  max_concurrent: 0'])
    const out = await reload()
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'invalid')
    assert.match(out.error, /dispatch\.max_concurrent must be a positive number/)
    assert.match(out.error, /curia\.local\.yaml/, 'the message names the layer the operator edits')
    assert.equal((await running()).config.dispatch.max_concurrent, 2)
  })

  // The daemon runs every rule, including the four the sidecar skips (#263's
  // mount list): its container is the one that mounts these paths. A config
  // that would refuse the next boot must not be applied to a running daemon.
  test('the path rules the sidecar cannot run are run here', async () => {
    write(overCuria(), ['timeline:', `  index: ${path.join(tmp, 'nope.html')}`])
    const out = await reload()
    assert.equal(out.ok, false)
    assert.match(out.error, /nope\.html, which does not exist/)
  })

  test('a file that says what the daemon already runs applies nothing and refuses nothing', async () => {
    const out = await reload()
    assert.equal(out.ok, true)
    assert.deepEqual(out.applied, [])
  })
})

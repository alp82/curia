// The real-boot fixture itself (#212).
//
// Six suites spawn the real daemon and wait for it in a `before` hook. When
// that hook fails, node reports every test under it as `cancelled` — a word
// that reads exactly like `skipped`, and a cancelled test proves nothing. An
// agent verifying its own daemon change learned to read 19 of them as
// pre-existing and move on. So the wait is the thing that has to be loud, and
// nothing else in the suite would notice it going quiet again.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePorts, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

// stdout, stderr and `close` are the whole contract `watchDaemon` needs, so a
// plain emitter drives every branch with no process to schedule.
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

describe('waitForBoot: a child that dies is a failure, never a silence', () => {
  test('the child exits before it is ready, and the wait says so at once', async () => {
    const child = fakeChild()
    const watch = watchDaemon(child)
    child.stderr.emit('data', 'Error: bad config: skills.install names "wayfinder"\n')
    child.emit('close', 1, null)

    const started = Date.now()
    await assert.rejects(
      () => waitForBoot(watch, () => false, 'the /state route'),
      (e) => {
        assert.match(e.message, /never got a daemon/, 'the failure names itself')
        assert.match(e.message, /exited with code 1/, 'and names how the child died')
        assert.match(e.message, /skills\.install names "wayfinder"/, "and carries the child's own words")
        assert.match(e.message, /cancelled test here is a boot that FAILED/, 'and refuses to read as a skip')
        return true
      },
    )
    assert.ok(Date.now() - started < 1_000, 'a dead child must not be waited out to the timeout')
  })

  test('a signalled child names its signal', async () => {
    const child = fakeChild()
    const watch = watchDaemon(child)
    child.emit('close', null, 'SIGKILL')
    await assert.rejects(
      () => waitForBoot(watch, () => false, 'the /state route'),
      /exited on SIGKILL/,
    )
  })

  test('a child that says nothing at all still fails legibly', async () => {
    const child = fakeChild()
    const watch = watchDaemon(child)
    child.emit('close', 1, null)
    await assert.rejects(() => waitForBoot(watch, () => false, 'the /state route'), /\(nothing at all\)/)
  })

  test('a live child that never becomes ready gives up loudly, and says it is still running', async () => {
    const watch = watchDaemon(fakeChild())
    await assert.rejects(
      () => waitForBoot(watch, () => false, 'both listeners', 200),
      (e) => {
        assert.match(e.message, /never reached both listeners/, 'the wait names what it wanted')
        assert.match(e.message, /still running/, 'and separates a hang from a death')
        return true
      },
    )
  })

  test('a child that becomes ready is simply awaited', async () => {
    const watch = watchDaemon(fakeChild())
    let polls = 0
    await waitForBoot(watch, () => ++polls >= 3, 'the /state route', 5_000)
    assert.equal(polls, 3)
  })
})

// #472: `attach.ttyd_port` and `attach.serve_port` both came back as 34155,
// the daemon refused the config, and a whole suite reported as failed.
//
// A draw of 200 is the size that makes the old shape show itself. Closing each
// socket before opening the next one puts every number back in the pool the
// next bind draws from, so a repeat inside 200 is near certain. Holding them
// all bound makes a repeat impossible, so this test cannot flake on code that
// is right.
describe('freePorts: one draw, no number twice (#472)', () => {
  test('a draw of 200 hands back 200 different numbers', async () => {
    const ports = await freePorts(200)
    assert.equal(ports.length, 200)
    assert.equal(new Set(ports).size, 200, 'a repeated number is a config the daemon refuses')
  })

  test('the draw hands its sockets back, so every number is free to bind', async () => {
    const ports = await freePorts(4)
    for (const port of ports) {
      await new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(port, '127.0.0.1', () => srv.close(resolve))
      })
    }
  })
})

// The end-to-end half, and the one that would have caught #212 itself: the
// REAL daemon, refusing a real config, through the wait every real-boot suite
// uses.
describe('waitForBoot against the real daemon (real boot, refused)', () => {
  let tmp

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-realboot-test-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('a config the daemon refuses fails the wait fast, naming the key', async () => {
    const cfgDir = path.join(tmp, 'config')
    fs.mkdirSync(cfgDir, { recursive: true })
    const [port, ttydPort, servePort, proxyPort] = await freePorts(4)
    // A root the daemon cannot read, which is exactly the shape an agent
    // container gave every suite before its fixtures owned their own root.
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:',
      '  - repo: example/fixture',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 1',
      '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work')}`,
      '  claim_login: alp82',
      '  ready_timeout_s: 5',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      'skills:',
      `  root: ${path.join(tmp, 'no-such-skills-root')}`,
      '  install: [wayfinder]',
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
      "    ready: '⏵⏵|bypass permissions'",
      '    tool_channel_grace_s: 15',
      '',
    ].join('\n'))

    const child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(port),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: path.join(tmp, 'data'),
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const watch = watchDaemon(child)
    const started = Date.now()
    try {
      await assert.rejects(
        () => waitForBoot(watch, () => false, 'the /state route'),
        /never got a daemon[\s\S]*skills\.install names "wayfinder"/,
        "the boot refusal reaches the reader instead of an empty log",
      )
      assert.ok(Date.now() - started < 9_000, 'the wait must not sit out its full timeout on a dead child')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })

  test('and the same daemon boots once the fixture owns the root', async () => {
    const cfgDir = path.join(tmp, 'config-ok')
    fs.mkdirSync(cfgDir, { recursive: true })
    const [port, ttydPort, servePort, proxyPort] = await freePorts(4)
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:',
      '  - repo: example/fixture',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 1',
      '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work-ok')}`,
      '  claim_login: alp82',
      '  ready_timeout_s: 5',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      'skills:',
      `  root: ${seedSkillsRoot(path.join(tmp, 'owned'))}`,
      ...sandboxYaml(),
      '',
    ].join('\n'))
    fs.copyFileSync(path.join(tmp, 'config', 'routing.yaml'), path.join(cfgDir, 'routing.yaml'))

    const child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(port),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: path.join(tmp, 'data-ok'),
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const watch = watchDaemon(child)
    try {
      // The default skill list, unstated, against a root the test seeded: the
      // whole fix in one boot.
      await waitForBoot(watch, () => /curia daemon listening/.test(watch.log()), 'its listening line')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })
})

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppUpdate, installationOwner, readUpdateRun, writeUpdateRun } from '../src/appupdate.mjs'
import { runAppUpdate } from '../bin/curia-update.mjs'
import { writeInstallationRecord, ensureLayout, versionPaths } from '../../cli/src/root.mjs'
import { createManifest } from '../../cli/src/manifest.mjs'

let root, record, check, calls, docker, controller
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-app-update-'))
  ensureLayout(root, { uid: process.getuid() })
  record = { format: 1, installationId: 'a'.repeat(32), activeVersion: '1.0.0' }
  writeInstallationRecord(root, record)
  const manifest = createManifest({ version: '1.0.0', commit: 'a'.repeat(40), bundleSha256: 'b'.repeat(64),
    digests: Object.fromEntries(['daemon', 'dashboard', 'agent', 'tmux', 'overseer'].map((key) => [key, 'sha256:' + 'c'.repeat(64)])) })
  fs.mkdirSync(path.dirname(versionPaths(root, '1.0.0').manifest), { recursive: true })
  fs.writeFileSync(versionPaths(root, '1.0.0').manifest, JSON.stringify(manifest))
  check = { check: async () => {}, status: () => ({ ok: true, installed: '1.0.0', recommended: '1.1.0', update_available: true }) }
  calls = []
  docker = async (args) => { calls.push(args); return { ok: true, stdout: args[0] === 'inspect' ? 'true' : 'container' } }
  controller = new AppUpdate({ root, check, docker, identity: () => ({ uid: 1000, gid: 1001, dockerGid: 998 }) })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const request = { version: '1.1.0', request_id: 'request-1234', by: 'operator' }

test('only a freshly verified newer stable release can start; arbitrary versions never reach Docker', async () => {
  await assert.rejects(controller.start({ ...request, version: '9.0.0' }), /currently verified/)
  check.status = () => ({ ok: false, update_available: true, recommended: '1.1.0' })
  await assert.rejects(controller.start(request), /currently verified/)
  assert.equal(calls.length, 0)
})

test('double clicks and repeated requests start one owner-run detached helper on the pinned image', async () => {
  const [a, b] = await Promise.all([controller.start(request), controller.start(request)])
  assert.equal(a.id, b.id)
  assert.equal((await controller.start(request)).id, a.id)
  assert.equal(calls.length, 1)
  const args = calls[0]
  assert.equal(args[args.indexOf('--user') + 1], '1000:1001')
  assert.equal(args[args.indexOf('--pid') + 1], 'host', 'host CLI and helper share lifecycle lock PIDs')
  assert.ok(args.includes('--detach'))
  assert.ok(args.includes(`type=bind,src=${root},dst=${root}`))
  assert.ok(args.includes('type=bind,src=/etc/os-release,dst=/etc/os-release,readonly'))
  assert.ok(args.includes('ghcr.io/alp82/curia-daemon@sha256:' + 'c'.repeat(64)))
  assert.equal(fs.statSync(path.join(root, 'state', 'update-run.json')).mode & 0o777, 0o600)
})

test('a replacement daemon recovers progress and reports an updater that disappeared', async () => {
  const run = await controller.start(request)
  const successor = new AppUpdate({ root, check, docker, now: () => Date.parse(run.started_at) + 61_000 })
  assert.equal((await successor.status()).id, run.id)
  successor.docker = async () => ({ ok: false, stderr: 'No such object: updater' })
  assert.equal((await successor.status()).status, 'failed')
  assert.match(readUpdateRun(root).error, /stopped/)
})

test('Docker being unavailable does not claim the updater stopped', async () => {
  const run = await controller.start(request)
  controller.now = () => Date.parse(run.started_at) + 61_000
  controller.docker = async () => ({ ok: false, stderr: 'Cannot connect to Docker daemon' })
  assert.equal((await controller.status()).status, 'starting')
  assert.match((await controller.status()).observation_error, /Cannot check/)
})

test('helper persists lifecycle progress and verifies activation before success', async () => {
  await controller.start(request)
  const result = await runAppUpdate({ root, execute: async ({ stdout }) => {
    stdout.write('[3/6] acquire\nprivate diagnostic\n')
    assert.equal(readUpdateRun(root).step, 'acquire')
    assert.doesNotMatch(JSON.stringify(readUpdateRun(root)), /private diagnostic/)
    writeInstallationRecord(root, { ...record, activeVersion: '1.1.0' })
  } })
  assert.equal(result.status, 'succeeded')
  assert.equal(fs.statSync(path.join(root, 'state', 'update.log')).mode & 0o777, 0o600)
})

test('failed switch is durable and does not leak raw diagnostics to the browser', async () => {
  await controller.start(request)
  const result = await runAppUpdate({ root, execute: async ({ stdout }) => {
    stdout.write('[6/6] switch\n')
    throw new Error('private diagnostic')
  } })
  assert.equal(result.status, 'failed')
  assert.match(result.error, /switch.*1\.0\.0/)
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic/)
  assert.match(fs.readFileSync(path.join(root, 'state', 'update.log'), 'utf8'), /private diagnostic/)
})

test('helper refuses a changed installation and a no-op is not a successful upgrade', async () => {
  await controller.start(request)
  writeInstallationRecord(root, { ...record, activeVersion: '1.0.1' })
  const result = await runAppUpdate({ root, execute: () => assert.fail('must not execute') })
  assert.equal(result.status, 'failed')
  writeInstallationRecord(root, record)
  writeUpdateRun(root, { ...readUpdateRun(root), status: 'starting' })
  assert.equal((await runAppUpdate({ root, execute: async () => {} })).status, 'failed')
})

test('status and handoff bound Docker waits independently from long-running CLI updates', async () => {
  const waits = []
  controller.docker = async (args, options) => { waits.push(options.timeoutMs); return { ok: true, stdout: args[0] === 'inspect' ? 'true' : 'container' } }
  await controller.start(request)
  await controller.status()
  assert.deepEqual(waits, [30_000, 5000])
})

test('the owner is read from state/, because the daemon container sees the root itself as uid 0', async () => {
  // The narrow mounts as the daemon sees them: Docker made the root path, the operator owns state/.
  const stat = (file) => file === root ? { uid: 0, gid: 0 }
    : file === path.join(root, 'state') ? { uid: 1000, gid: 1001 }
      : file === '/var/run/docker.sock' ? { uid: 0, gid: 998 } : assert.fail(`unexpected stat of ${file}`)
  assert.deepEqual(installationOwner(root, stat), { uid: 1000, gid: 1001, dockerGid: 998 })

  controller = new AppUpdate({ root, check, docker, identity: () => installationOwner(root, stat) })
  const run = await controller.start(request)
  assert.equal(run.status, 'starting')
  const launch = calls.find((args) => args[0] === 'run')
  assert.equal(launch[launch.indexOf('--user') + 1], '1000:1001')
})

// `curia install` against the real Compose bundle (#873).
//
// cli/test/install.test.mjs proves the install sequence against a small
// bundle and a fake `docker`. This test installs the bundle a release ships,
// `deploy/bundle/compose.yaml` rendered with digests, and has Docker Compose
// itself read what the lifecycle interface wrote: the env file under `run/`
// and the bundle under `versions/<version>/bundle/`. Compose's `config`
// stands in for `pull` and `up`, so the test validates the project without
// an image or a socket. Where Docker is not on the machine it skips.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { runInstall, packageVersion } from '../../cli/src/install.mjs'
import { EXIT } from '../../cli/src/exit.mjs'
import { COMPOSE_PROJECT, INSTALLATION_LABEL } from '../../cli/src/bundle.mjs'
import { SERVICES } from '../../cli/src/layout.mjs'
import { readInstallationRecord } from '../../cli/src/root.mjs'
import { DIGESTS, fakeTailscale, healthy, hostProbes, release, releaseProbesFor, stageOf } from '../../cli/test/fixtures/install.mjs'
import { BUNDLE_COMPOSE_FILE } from './fixtures/compose.mjs'

const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
const skip = compose.status === 0 ? false : 'docker compose is not available here'

let scratch
before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-installbundle-')) })
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

// A `docker` whose Compose `pull` and `up` are Compose reading the project,
// whose `ps` answers healthy, and whose plain `image pull` of the agent
// image answers without a registry.
function composeConfigRunner() {
  const configs = []
  return async (args) => {
    if (args[0] !== 'compose') return { ok: true, stdout: '', stderr: '', code: 0 }
    const verb = args[args.indexOf('-f') + 2]
    if (verb === 'ps') return { ok: true, stdout: healthy() }
    const r = spawnSync('docker', [...args.slice(0, args.indexOf('-f') + 2), 'config', '--format', 'json'], { encoding: 'utf8' })
    configs.push(r)
    return r.status === 0 ? { ok: true, stdout: r.stdout, stderr: r.stderr, code: 0 } : { ok: false, stdout: r.stdout, stderr: r.stderr, code: r.status }
  }
}

describe('curia install starts the release bundle through docker compose', { skip }, () => {
  test('Compose reads the env file and the installed bundle as one labelled project', async () => {
    const template = fs.readFileSync(BUNDLE_COMPOSE_FILE, 'utf8')
    const r = release(scratch, { version: packageVersion, template })
    const home = fs.mkdtempSync(path.join(scratch, 'home-'))
    const root = path.join(home, '.local', 'share', 'curia')
    const out = []
    const docker = composeConfigRunner()
    const exit = await runInstall(
      { env: { HOME: home, CURIA_ROOT: root, CURIA_STAGE: stageOf(scratch, r) }, args: [], stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, uid: process.getuid(), gid: process.getgid(), root, mode: 'install' },
      { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker, tailscale: fakeTailscale(), sleep: async () => {}, now: () => 0 },
    )
    assert.equal(exit, EXIT.ok, out.join(''))

    const record = readInstallationRecord(root)
    const cfg = spawnSync('docker', ['compose', '--env-file', path.join(root, 'run', 'compose.env'), '-f', path.join(root, 'versions', packageVersion, 'bundle', 'compose.yaml'), 'config', '--format', 'json'], { encoding: 'utf8' })
    assert.equal(cfg.status, 0, cfg.stderr)
    const project = JSON.parse(cfg.stdout)
    assert.equal(project.name, COMPOSE_PROJECT)
    assert.deepEqual(Object.keys(project.services).sort(), [...SERVICES].sort())
    for (const [name, s] of Object.entries(project.services)) {
      assert.equal(s.user, `${process.getuid()}:${process.getgid()}`, name)
      assert.equal(s.labels[INSTALLATION_LABEL], record.installationId, name)
      assert.ok(s.healthcheck?.test, `${name} declares a health check`)
    }
    assert.equal(project.services.daemon.image, `ghcr.io/alp82/curia-daemon@${DIGESTS.daemon}`)
    // Every bind mount of the root exists on the host, so Docker creates none as root.
    for (const s of Object.values(project.services)) {
      for (const v of s.volumes ?? []) {
        if (v.type === 'bind' && v.source.startsWith(root)) assert.ok(fs.statSync(v.source).isDirectory(), `${v.source} exists before up`)
      }
    }
  })
})

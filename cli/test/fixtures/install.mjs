// The packaged fixtures the install tests run against (#873): one release
// built the way the workflow builds one, the stage exactly as the bootstrap
// leaves it, a supported host read through fake probes, and a fake `docker`
// that records what the lifecycle interface asks of Compose. Nothing here
// touches the machine's Docker, ports, or network.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

import { PACKAGE_NAME, MANIFEST_FILE, createManifest, renderManifest } from '../../src/manifest.mjs'
import { renderBundle } from '../../src/bundle.mjs'
import { SERVICES } from '../../src/layout.mjs'

const GiB = 1024 ** 3
export const COMMIT = 'c'.repeat(40)
export const DIGESTS = Object.freeze({
  daemon: `sha256:${'1'.repeat(64)}`,
  tmux: `sha256:${'2'.repeat(64)}`,
  dashboard: `sha256:${'3'.repeat(64)}`,
  overseer: `sha256:${'4'.repeat(64)}`,
})
export const TEMPLATE = [
  'name: curia',
  'services:',
  '  daemon:',
  '    image: ${CURIA_DAEMON_IMAGE:?}',
  '    labels:',
  '      sh.curia.installation: ${CURIA_INSTALLATION_ID:?}',
  '  tmux:',
  '    image: ${CURIA_TMUX_IMAGE:?}',
  '  ttyd:',
  '    image: ${CURIA_TMUX_IMAGE:?}',
  '  dashboard:',
  '    image: ${CURIA_DASHBOARD_IMAGE:?}',
  '  overseer:',
  '    image: ${CURIA_OVERSEER_IMAGE:?}',
  '',
].join('\n')

let counter = 0
function archiveOf(scratch, files) {
  const dir = join(scratch, `archive-${counter++}`)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  const tops = [...new Set(Object.keys(files).map((n) => n.split('/')[0]))]
  const tar = spawnSync('tar', ['--format=ustar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '-C', dir, '-cf', '-', ...tops])
  assert.equal(tar.status, 0, String(tar.stderr))
  return gzipSync(tar.stdout, { level: 9 })
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

// One complete release: the bundle archive, the manifest that binds it, the
// package tarball that embeds the manifest, and the registry's integrity.
export function release(scratch, { version, template = TEMPLATE, digests = DIGESTS }) {
  const compose = renderBundle(template, digests)
  const archive = archiveOf(scratch, { [`curia-bundle-${version}/compose.yaml`]: compose })
  const checksum = `${sha256(archive)}  curia-bundle-${version}.tar.gz\n`
  const text = renderManifest(createManifest({ version, commit: COMMIT, bundleSha256: sha256(archive), digests }))
  const packageJson = JSON.stringify({ name: PACKAGE_NAME, version, bin: { curia: 'bin/curia.mjs' } }, null, 2) + '\n'
  const entry = '#!/usr/bin/env node\nconsole.log("fixture cli")\n'
  const tarball = archiveOf(scratch, { 'package/package.json': packageJson, [`package/${MANIFEST_FILE}`]: text, 'package/bin/curia.mjs': entry })
  return { version, compose, archive, checksum, text, packageJson, entry, tarball, integrity: sri(tarball) }
}

// The stage exactly as deploy/bootstrap/curia-install.sh leaves it: the
// unpacked runtime, the unpacked package, and the three retained artifacts.
export function stageOf(scratch, r, { tamper } = {}) {
  const stage = mkdtempSync(join(scratch, 'stage-'))
  mkdirSync(join(stage, 'node', 'bin'), { recursive: true })
  writeFileSync(join(stage, 'node', 'bin', 'node'), '#!/bin/sh\necho fixture node\n', { mode: 0o755 })
  mkdirSync(join(stage, 'cli', 'bin'), { recursive: true })
  writeFileSync(join(stage, 'cli', 'package.json'), r.packageJson)
  writeFileSync(join(stage, 'cli', MANIFEST_FILE), r.text)
  writeFileSync(join(stage, 'cli', 'bin', 'curia.mjs'), r.entry, { mode: 0o755 })
  writeFileSync(join(stage, 'cli.tgz'), r.tarball)
  writeFileSync(join(stage, 'bundle.tar.gz'), tamper === 'bundle' ? Buffer.concat([r.archive, Buffer.from('x')]) : r.archive)
  writeFileSync(join(stage, 'bundle.tar.gz.sha256'), r.checksum)
  return stage
}

export function releaseProbesFor(r) {
  return {
    packument: async (name, version) => (name === PACKAGE_NAME && version === r.version ? { integrity: r.integrity, attested: true } : { error: `no such version: ${name}@${version}` }),
    releaseManifest: async () => r.text,
    attestation: async () => ({ ok: true }),
  }
}

// A supported host, read through fake probes so nothing touches this machine.
export function hostProbes(overrides = {}) {
  const exec = async (file, args) => {
    const line = [file, ...args].join(' ')
    if (line === 'docker version --format json') return { ok: true, stdout: JSON.stringify({ Client: { Version: '27.5.1' }, Server: { Version: '27.5.1', ApiVersion: '1.47' } }) }
    if (line === 'docker info --format json') return { ok: true, stdout: JSON.stringify({ ServerVersion: '27.5.1', SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin'] }) }
    if (line === 'systemctl is-enabled docker') return { ok: true, stdout: 'enabled\n' }
    if (line === 'docker compose version --short') return { ok: true, stdout: '2.32.4\n' }
    if (line === 'tailscale version') return { ok: true, stdout: '1.80.2\n  tailscale commit: abc\n' }
    if (line === 'tailscale status --json') return { ok: true, stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true }, CertDomains: ['host.tail1234.ts.net'] }) }
    if (line === 'tailscale serve status') return { ok: true, stdout: 'No serve config\n' }
    if (line.startsWith('getent group docker')) return { ok: true, stdout: 'docker:x:988:operator\n' }
    if (line.startsWith('docker run ')) {
      const dir = args[args.indexOf('-v') + 1].split(':')[0]
      const url = args.at(-1).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]
      const token = readFileSync(join(dir, 'probe'), 'utf8')
      const body = url ? await (await fetch(url)).text() : 'no url'
      return { ok: true, stdout: `${token}\n${body}\n` }
    }
    if (line.startsWith('docker rm -f')) return { ok: true, stdout: '' }
    if (line.startsWith('ss ')) return { ok: true, stdout: '' }
    return { ok: false, stdout: '', stderr: `fake: no such command: ${line}`, code: 127 }
  }
  return {
    exec,
    readFile: (path) => (path === '/etc/os-release' ? 'PRETTY_NAME="Ubuntu 24.04.2 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n' : null),
    arch: () => 'x64',
    cpus: () => 4,
    memoryBytes: () => 8 * GiB,
    freeDiskBytes: () => 40 * GiB,
    socketAccessible: () => true,
    groups: () => [process.getuid(), 988],
    portFree: async () => true,
    fetchOrigin: async (origin) => ({ origin, reachable: true, certificateValid: true, skewSeconds: 1 }),
    ...overrides,
  }
}

// What `docker compose ps --format json` prints for the five services, each
// healthy unless overridden.
export function healthy(services = SERVICES, overrides = {}) {
  return services.map((s) => JSON.stringify({ Service: s, State: 'running', Health: 'healthy', ExitCode: 0, ...overrides[s] })).join('\n') + '\n'
}

// A fake `docker`: records every call and answers by Compose verb. An answer
// may be a function of the arguments, to model a start that settles.
export function fakeDocker(answers = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    const verb = args[args.indexOf('-f') + 2]
    const answer = answers[verb] ?? (verb === 'ps' ? { ok: true, stdout: healthy() } : { ok: true, stdout: '', stderr: '' })
    return typeof answer === 'function' ? answer(args, calls) : answer
  }
  run.calls = calls
  run.verbs = () => calls.map((c) => c[c.indexOf('-f') + 2])
  return run
}

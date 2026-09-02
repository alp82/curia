// The packaged fixtures the install tests run against (#873): one release
// built the way the workflow builds one, the stage exactly as the bootstrap
// leaves it, a supported host read through fake probes, and a fake `docker`
// that records what the lifecycle interface asks of Compose. Nothing here
// touches the machine's Docker, ports, or network.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

import { PACKAGE_NAME, MANIFEST_FILE, createManifest, renderManifest } from '../../src/manifest.mjs'
import { renderBundle } from '../../src/bundle.mjs'
import { releaseUrls, runtimeUrls } from '../../src/acquire.mjs'
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

// The Node.js version every fixture release pins, and the runtime archive
// the way nodejs.org lays one out: a top directory, `bin/node` (here a shell
// script that reports the version), and a symbolic link beside it.
export const NODE_VERSION = '24.19.0'
function runtimeArchiveOf(scratch, nodeVersion) {
  const top = `node-v${nodeVersion}-linux-x64`
  const dir = join(scratch, `runtime-${counter++}`)
  mkdirSync(join(dir, top, 'bin'), { recursive: true })
  mkdirSync(join(dir, top, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
  writeFileSync(join(dir, top, 'bin', 'node'), `#!/bin/sh\necho v${nodeVersion}\n`, { mode: 0o755 })
  writeFileSync(join(dir, top, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm\n')
  symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(dir, top, 'bin', 'npm'))
  const tar = spawnSync('tar', ['--format=ustar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '-C', dir, '-cf', '-', top])
  assert.equal(tar.status, 0, String(tar.stderr))
  return gzipSync(tar.stdout, { level: 9 })
}

// One complete release: the bundle archive, the manifest that binds it, the
// package tarball that embeds the manifest, the registry's integrity, and
// the runtime the package pins.
export function release(scratch, { version, template = TEMPLATE, digests = DIGESTS, nodeVersion = NODE_VERSION, files = {} }) {
  const compose = renderBundle(template, digests)
  const archive = archiveOf(scratch, { [`curia-bundle-${version}/compose.yaml`]: compose })
  const checksum = `${sha256(archive)}  curia-bundle-${version}.tar.gz\n`
  const text = renderManifest(createManifest({ version, commit: COMMIT, bundleSha256: sha256(archive), digests }))
  const packageJson = JSON.stringify({ name: PACKAGE_NAME, version, bin: { curia: 'bin/curia.mjs' }, curia: { node: nodeVersion } }, null, 2) + '\n'
  const entry = '#!/usr/bin/env node\nconsole.log("fixture cli")\n'
  const packageFiles = { 'package/package.json': packageJson, [`package/${MANIFEST_FILE}`]: text, 'package/bin/curia.mjs': entry }
  for (const [name, content] of Object.entries(files)) packageFiles[`package/${name}`] = content
  const tarball = archiveOf(scratch, packageFiles)
  const runtime = runtimeArchiveOf(scratch, nodeVersion)
  const shasums = `${sha256(runtime)}  node-v${nodeVersion}-linux-x64.tar.gz\n${'0'.repeat(64)}  node-v${nodeVersion}-linux-arm64.tar.gz\n`
  return { version, compose, archive, checksum, text, packageJson, entry, files, tarball, integrity: sri(tarball), nodeVersion, runtime, shasums }
}

// The artifact origins of one release as the acquisition reads them: a map
// from URL to bytes, so a test hands in files instead of a network. Every
// entry can be replaced or removed to model a substituted or missing artifact.
export function artifactsOf(r) {
  const urls = releaseUrls(r.version)
  const runtime = runtimeUrls(r.nodeVersion)
  return new Map([
    [urls.packument, Buffer.from(JSON.stringify({ name: PACKAGE_NAME, version: r.version, dist: { integrity: r.integrity, attestations: {} } }))],
    [urls.tarball, r.tarball],
    [runtime.checksums, Buffer.from(r.shasums)],
    [runtime.archive, r.runtime],
    [urls.manifest, Buffer.from(r.text)],
    [urls.bundle, r.archive],
    [urls.checksum, Buffer.from(r.checksum)],
  ])
}

export function acquireProbesFor(artifacts) {
  return {
    download: async (url) => (artifacts.has(url) ? { ok: true, bytes: artifacts.get(url) } : { ok: false, status: 404 }),
    nodeVersion: (binary) => {
      const run = spawnSync(binary, ['--version'])
      return run.status === 0 ? run.stdout.toString().trim() : null
    },
  }
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
  for (const [name, content] of Object.entries(r.files ?? {})) {
    mkdirSync(dirname(join(stage, 'cli', name)), { recursive: true })
    writeFileSync(join(stage, 'cli', name), content)
  }
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

// The service and the app on loopback, as the switch (#884) reads them:
// `/ping` on both answers the version of the bundle the last `up` recreated
// the core services from, and `/overview` answers the live sessions as the
// daemon's reconcile adopted them. `live` names the tmux sessions that hold
// an agent before the switch; `readopt(session)` says what the recreated
// service reports for each one: `adopted` (in `agents`, pane live),
// `untracked` (a live pane the reconcile did not adopt), or `ended` (gone
// from tmux). `settle` is how many reads after a recreate answer an
// indeterminate fleet (`agents: null`) before the adoption shows, which is
// what a listener that answers before the boot reconcile finishes looks
// like; only `/overview` reads count. `readopt` also gets the version of
// the bundle the service was recreated from, so a test can make one release
// adopt what another does not. `versionOf(bundleVersion)` is what the
// recreated containers report, for a bundle whose images do not match its
// version.
export function fakeLoopback(docker, { initial, live = [], readopt = () => 'adopted', settle = 0, versionOf = (v) => v } = {}) {
  const reads = []
  let recreates = 0
  let readsSinceRecreate = 0
  const recreated = () => {
    const ups = docker.calls.filter((c) => c.includes('up'))
    return ups.length
  }
  const running = () => {
    const ups = docker.calls.filter((c) => c.includes('up'))
    if (ups.length === 0) return { version: initial, bundle: initial, fresh: false }
    const file = ups.at(-1)[ups.at(-1).indexOf('-f') + 1]
    const bundle = file.split('/versions/')[1].split('/')[0]
    return { version: versionOf(bundle), bundle, fresh: true }
  }
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
  const fetch = async (url) => {
    const u = new URL(url)
    reads.push(`${u.port}${u.pathname}`)
    if (recreated() !== recreates) { recreates = recreated(); readsSinceRecreate = 0 }
    if (u.pathname === '/overview') readsSinceRecreate += 1
    const { version, bundle, fresh } = running()
    if (u.port === '4273') {
      if (u.pathname === '/ping') return answer(200, { curia: 'curia-dashboard', version })
      return answer(403, {})
    }
    if (u.pathname === '/ping') return answer(200, { curia: 'curia-side-channel', port: 4271, version })
    if (u.pathname === '/overview') {
      if (fresh && readsSinceRecreate <= settle) return answer(200, { daemon: { uptime_s: 1 }, agents: null, untracked: null })
      const agents = []
      const untracked = []
      for (const session of live) {
        const fate = fresh ? readopt(session, bundle) : 'adopted'
        if (fate === 'adopted') agents.push({ session, tmux_live: true, uptime_s: fresh ? null : 120 })
        else if (fate === 'untracked') untracked.push(session)
      }
      return answer(200, { daemon: { uptime_s: fresh ? 1 : 3600 }, agents, untracked })
    }
    return answer(404, { error: 'not found' })
  }
  fetch.reads = reads
  return fetch
}

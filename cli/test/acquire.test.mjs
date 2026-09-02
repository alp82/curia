import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NODE_DIST, acquireRelease, releaseUrls, runtimeUrls } from '../src/acquire.mjs'
import { Refusal } from '../src/exit.mjs'
import { STAGE_FILES, isCompleteStage } from '../src/stage.mjs'
import { DIGESTS, acquireProbesFor, artifactsOf, release as releaseIn } from './fixtures/install.mjs'

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'curia-acquire-')) })
after(() => rmSync(scratch, { recursive: true, force: true }))

const release = (options) => releaseIn(scratch, { version: '1.4.0', ...options })

function capture() {
  const out = []
  return { stdout: { write: (s) => { out.push(s); return true } }, out: () => out.join('') }
}

async function acquire(r, { artifacts = artifactsOf(r), version = r.version, probes = acquireProbesFor(artifacts) } = {}) {
  const stage = mkdtempSync(join(scratch, 'stage-'))
  const io = capture()
  let error = null
  let result = null
  try {
    result = await acquireRelease({ version, stage, stdout: io.stdout }, probes)
  } catch (e) {
    error = e
  }
  return { stage, result, error, out: io.out() }
}

function refused(a, pattern) {
  assert.ok(a.error instanceof Refusal, `expected a Refusal, got ${a.error?.stack ?? 'success'}`)
  assert.match(a.error.message, pattern)
}

describe('the origins', () => {
  test('are the registry, the GitHub release, and nodejs.org, by version', () => {
    assert.equal(NODE_DIST, 'https://nodejs.org/dist')
    assert.deepEqual(releaseUrls('1.4.0'), {
      packument: 'https://registry.npmjs.org/@curia-sh/cli/1.4.0',
      tarball: 'https://registry.npmjs.org/@curia-sh/cli/-/cli-1.4.0.tgz',
      manifest: 'https://github.com/alp82/curia/releases/download/v1.4.0/curia-manifest-1.4.0.json',
      bundle: 'https://github.com/alp82/curia/releases/download/v1.4.0/curia-bundle-1.4.0.tar.gz',
      checksum: 'https://github.com/alp82/curia/releases/download/v1.4.0/curia-bundle-1.4.0.tar.gz.sha256',
    })
    assert.deepEqual(runtimeUrls('24.19.0'), {
      name: 'node-v24.19.0-linux-x64.tar.gz',
      checksums: 'https://nodejs.org/dist/v24.19.0/SHASUMS256.txt',
      archive: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.gz',
    })
  })
})

describe('acquiring a release', () => {
  test('downloads, proves, and unpacks the package, the pinned runtime, and the bundle into a complete stage', async () => {
    const r = release()
    const a = await acquire(r)
    assert.equal(a.error, null, a.error?.stack)
    assert.deepEqual(a.result, { version: '1.4.0', node: '24.19.0' })
    assert.ok(isCompleteStage(a.stage), `the stage holds ${STAGE_FILES.join(', ')}`)
    assert.equal(statSync(join(a.stage, 'node', 'bin', 'node')).mode & 0o111, 0o111, 'the runtime keeps its execute bits')
    assert.equal(readlinkSync(join(a.stage, 'node', 'bin', 'npm')), '../lib/node_modules/npm/bin/npm-cli.js')
    assert.equal(readFileSync(join(a.stage, 'cli', 'package.json'), 'utf8'), r.packageJson)
    assert.deepEqual(readFileSync(join(a.stage, 'cli.tgz')), r.tarball, 'the tarball is kept as downloaded')
    assert.deepEqual(readFileSync(join(a.stage, 'bundle.tar.gz')), r.archive)
    assert.equal(readFileSync(join(a.stage, 'bundle.tar.gz.sha256'), 'utf8'), r.checksum)
    assert.match(a.out, /@curia-sh\/cli@1\.4\.0 downloaded and proven/)
    assert.match(a.out, /Node\.js v24\.19\.0 downloaded and proven/)
    assert.match(a.out, /Compose bundle of 1\.4\.0 downloaded and proven/)
    assert.ok(!a.out.includes(r.integrity), 'no line prints the integrity value')
  })

  test('a missing artifact is refused by name, and nothing after it is downloaded', async () => {
    const r = release()
    const artifacts = artifactsOf(r)
    artifacts.delete(releaseUrls(r.version).bundle)
    const a = await acquire(r, { artifacts })
    refused(a, /curia-bundle-1\.4\.0\.tar\.gz is not at .*Check that the version is published/)
    assert.ok(!existsSync(join(a.stage, 'bundle.tar.gz')))
  })

  test('a download that fails for another reason names the access problem', async () => {
    const r = release()
    const artifacts = artifactsOf(r)
    const real = acquireProbesFor(artifacts)
    const probes = { ...real, download: async (url) => (url === releaseUrls(r.version).packument ? { ok: false, error: 'connect ETIMEDOUT' } : real.download(url)) }
    refused(await acquire(r, { artifacts, probes }), /could not download the registry record.*ETIMEDOUT.*outbound access/)
  })

  test('a substituted package is refused before it is unpacked', async () => {
    const r = release()
    const artifacts = artifactsOf(r)
    artifacts.set(releaseUrls(r.version).tarball, Buffer.concat([r.tarball, Buffer.from('x')]))
    const a = await acquire(r, { artifacts })
    refused(a, /package integrity: .*does not have the SHA-512 the registry records/)
    assert.ok(!existsSync(join(a.stage, 'cli')), 'nothing of it is unpacked')
  })

  test('a runtime SHASUMS256.txt does not list, or one with another checksum, is refused', async () => {
    const r = release()
    const unlisted = artifactsOf(r)
    unlisted.set(runtimeUrls(r.nodeVersion).checksums, Buffer.from(`${'1'.repeat(64)}  node-v24.19.0-linux-arm64.tar.gz\n`))
    refused(await acquire(r, { artifacts: unlisted }), /SHASUMS256\.txt does not list node-v24\.19\.0-linux-x64\.tar\.gz/)
    const substituted = artifactsOf(r)
    substituted.set(runtimeUrls(r.nodeVersion).archive, Buffer.concat([r.runtime, Buffer.from('x')]))
    const a = await acquire(r, { artifacts: substituted })
    refused(a, /Node\.js v24\.19\.0 checksum: .*substituted or damaged/)
    assert.ok(!existsSync(join(a.stage, 'node')))
  })

  test('a runtime that reports another version than the package pins is refused', async () => {
    const r = release({ nodeVersion: '24.18.0' })
    const artifacts = artifactsOf(r)
    // The package pins 24.18.0, but the archive served under that name is a 24.19.0 build.
    const other = releaseIn(scratch, { version: '1.4.0', nodeVersion: '24.19.0' })
    artifacts.set(runtimeUrls('24.18.0').archive, other.runtime)
    artifacts.set(runtimeUrls('24.18.0').checksums, Buffer.from(other.shasums.replaceAll('24.19.0-linux', '24.18.0-linux')))
    refused(await acquire(r, { artifacts }), /reports v24\.19\.0, not v24\.18\.0, which the package pins/)
  })

  test('a runtime that does not run is refused with the noexec hint', async () => {
    const r = release()
    const artifacts = artifactsOf(r)
    const probes = { ...acquireProbesFor(artifacts), nodeVersion: async () => null }
    refused(await acquire(r, { artifacts, probes }), /does not run.*noexec/)
  })

  test('a package that names another version, or pins no runtime, is refused', async () => {
    const r = release()
    const other = releaseIn(scratch, { version: '1.4.1' })
    const artifacts = artifactsOf(r)
    artifacts.set(releaseUrls(r.version).tarball, other.tarball)
    artifacts.set(releaseUrls(r.version).packument, Buffer.from(JSON.stringify({ dist: { integrity: other.integrity } })))
    refused(await acquire(r, { artifacts }), /version mismatch: the package names version 1\.4\.1, and 1\.4\.0 was selected/)

    const unpinned = releaseIn(scratch, { version: '1.4.0', nodeVersion: null })
    refused(await acquire(unpinned), /pins no Node\.js runtime/)
  })

  test('a bundle that fails its checksum file or the manifest, and a manifest for another version, are refused', async () => {
    const r = release()
    const byFile = artifactsOf(r)
    byFile.set(releaseUrls(r.version).bundle, Buffer.concat([r.archive, Buffer.from('x')]))
    refused(await acquire(r, { artifacts: byFile }), /bundle checksum: .*its \.sha256 file names/)

    const byManifest = artifactsOf(r)
    const other = releaseIn(scratch, { version: '1.4.0', digests: { ...DIGESTS, daemon: `sha256:${'9'.repeat(64)}` } })
    byManifest.set(releaseUrls(r.version).manifest, Buffer.from(other.text))
    refused(await acquire(r, { artifacts: byManifest }), /bundle checksum: .*the release manifest binds/)

    const wrongVersion = artifactsOf(r)
    const later = releaseIn(scratch, { version: '1.4.1' })
    wrongVersion.set(releaseUrls(r.version).manifest, Buffer.from(later.text))
    wrongVersion.set(releaseUrls(r.version).bundle, later.archive)
    wrongVersion.set(releaseUrls(r.version).checksum, Buffer.from(later.checksum))
    refused(await acquire(r, { artifacts: wrongVersion }), /version mismatch: the release manifest is for version 1\.4\.1/)
  })

  test('a stage directory that is not empty is the caller\'s mistake, not a merge', async () => {
    const r = release()
    const stage = mkdtempSync(join(scratch, 'stage-'))
    mkdirSync(join(stage, 'cli'))
    await assert.rejects(() => acquireRelease({ version: r.version, stage, stdout: capture().stdout }, acquireProbesFor(artifactsOf(r))), /EEXIST/)
  })
})

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Writable } from 'node:stream'

import {
  MANIFEST_FORMAT, PACKAGE_NAME, RELEASE_REPOSITORY, RELEASE_WORKFLOW, MANIFEST_FILE, RELEASE_CHECKS, PROVENANCE_CHECKS,
  releaseAssets, createManifest, renderManifest, parseManifest, ManifestError,
  evaluateRelease, renderVerification, verifyStagedRelease, verifyInstalledRelease,
} from '../src/manifest.mjs'
import { renderBundle, imageReference } from '../src/bundle.mjs'
import { versionPaths } from '../src/root.mjs'
import { Refusal } from '../src/exit.mjs'

const VERSION = '1.2.3'
const COMMIT = 'c'.repeat(40)
const DIGESTS = {
  daemon: `sha256:${'1'.repeat(64)}`,
  tmux: `sha256:${'2'.repeat(64)}`,
  dashboard: `sha256:${'3'.repeat(64)}`,
  overseer: `sha256:${'4'.repeat(64)}`,
}

const TEMPLATE = [
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

// ---------------------------------------------------------------------------
// Fixtures: one valid release, built the way the workflow builds one, with
// the system tar. Every tampering test starts from it and changes one thing.

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'curia-manifest-')) })
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function archiveOf(files) {
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

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function sri(bytes) { return `sha512-${createHash('sha512').update(bytes).digest('base64')}` }

// A complete release: the bundle archive, the manifest that binds it, the
// package tarball that embeds the manifest, and the registry's view.
function release({ version = VERSION, digests = DIGESTS, compose, manifestText, packageJson } = {}) {
  const composeText = compose ?? renderBundle(TEMPLATE, digests)
  const archive = archiveOf({ [`curia-bundle-${version}/compose.yaml`]: composeText })
  const checksum = `${sha256(archive)}  curia-bundle-${version}.tar.gz\n`
  const manifest = createManifest({ version, commit: COMMIT, bundleSha256: sha256(archive), digests })
  const text = manifestText ?? renderManifest(manifest)
  const pkg = packageJson ?? JSON.stringify({ name: PACKAGE_NAME, version, bin: { curia: 'bin/curia.mjs' } }, null, 2) + '\n'
  const tarball = archiveOf({ 'package/package.json': pkg, [`package/${MANIFEST_FILE}`]: text, 'package/bin/curia.mjs': '#!/usr/bin/env node\n' })
  return { version, manifest, text, compose: composeText, archive, checksum, tarball, packageJson: pkg, integrity: sri(tarball) }
}

function probesFor(r, overrides = {}) {
  return {
    packument: async (name, version) => (name === PACKAGE_NAME && version === r.version ? { integrity: r.integrity, attested: true } : { error: `no such version: ${name}@${version}` }),
    releaseManifest: async () => r.text,
    attestation: async () => ({ ok: true }),
    ...overrides,
  }
}

function stageOf(r, overrides = {}) {
  return { version: r.version, tarball: r.tarball, archive: r.archive, checksum: r.checksum, ...overrides }
}

function sink() {
  const chunks = []
  const stream = new Writable({ write(chunk, _e, cb) { chunks.push(String(chunk)); cb() } })
  stream.text = () => chunks.join('')
  return stream
}

function check(report, name) {
  const found = report.checks.find((c) => c.name === name)
  assert.ok(found, `the report has a check named ${name}: ${report.checks.map((c) => c.name).join(', ')}`)
  return found
}

function failedOnly(report, ...names) {
  const failed = report.checks.filter((c) => c.status === 'failed').map((c) => c.name)
  assert.deepEqual(failed, names, `failed checks: ${failed.join(', ')}`)
  assert.equal(report.ok, false)
  assert.ok(report.refusal instanceof Refusal)
}

// ---------------------------------------------------------------------------

describe('the contract', () => {
  test('one format, one package, one repository, one signer workflow', () => {
    assert.equal(MANIFEST_FORMAT, 1)
    assert.equal(PACKAGE_NAME, '@curia-sh/cli')
    assert.equal(RELEASE_REPOSITORY, 'alp82/curia')
    assert.equal(RELEASE_WORKFLOW, '.github/workflows/release.yml')
    assert.equal(MANIFEST_FILE, 'manifest.json')
  })

  test('the release assets are named by version', () => {
    assert.deepEqual(releaseAssets('1.2.3'), {
      manifest: 'curia-manifest-1.2.3.json',
      bundle: 'curia-bundle-1.2.3.tar.gz',
      checksum: 'curia-bundle-1.2.3.tar.gz.sha256',
      images: 'curia-images-1.2.3.json',
      package: 'curia-sh-cli-1.2.3.tgz',
    })
  })

  test('the installed version holds the manifest, the retained tarball, and the bundle at fixed paths', () => {
    const p = versionPaths('/root', '1.2.3')
    assert.equal(p.manifest, '/root/versions/1.2.3/cli/manifest.json')
    assert.equal(p.package, '/root/versions/1.2.3/cli.tgz')
    assert.equal(p.bundleArchive, '/root/versions/1.2.3/bundle.tar.gz')
    assert.equal(p.bundleChecksum, '/root/versions/1.2.3/bundle.tar.gz.sha256')
    assert.equal(p.bundle, '/root/versions/1.2.3/bundle/compose.yaml')
  })

  test('the checks are named, in order', () => {
    assert.deepEqual(RELEASE_CHECKS.map((c) => c.name), ['manifest', 'version', 'package integrity', 'bundle checksum', 'image digests', 'release manifest'])
    assert.deepEqual(PROVENANCE_CHECKS.map((c) => c.name), ['installed files', 'image provenance', 'package provenance'])
  })
})

describe('the manifest', () => {
  test('binds the version, the package, the bundle checksum, every image digest, and the source', () => {
    const m = createManifest({ version: VERSION, commit: COMMIT, bundleSha256: 'a'.repeat(64), digests: DIGESTS })
    assert.deepEqual(m, {
      format: 1,
      version: '1.2.3',
      package: { name: '@curia-sh/cli', version: '1.2.3' },
      bundle: { name: 'curia-bundle-1.2.3.tar.gz', sha256: 'a'.repeat(64) },
      images: {
        daemon: { name: 'ghcr.io/alp82/curia-daemon', digest: DIGESTS.daemon },
        tmux: { name: 'ghcr.io/alp82/curia-tmux', digest: DIGESTS.tmux },
        dashboard: { name: 'ghcr.io/alp82/curia-dashboard', digest: DIGESTS.dashboard },
        overseer: { name: 'ghcr.io/alp82/curia-overseer', digest: DIGESTS.overseer },
      },
      source: { repository: 'alp82/curia', commit: COMMIT, workflow: '.github/workflows/release.yml' },
    })
  })

  test('renders canonical text that parses back to the same manifest', () => {
    const m = createManifest({ version: VERSION, commit: COMMIT, bundleSha256: 'a'.repeat(64), digests: DIGESTS })
    const text = renderManifest(m)
    assert.ok(text.endsWith('\n'))
    assert.equal(text, renderManifest(parseManifest(text)))
    assert.deepEqual(parseManifest(text), m)
    assert.equal(renderManifest(m), renderManifest({ ...m, images: { overseer: m.images.overseer, daemon: m.images.daemon, tmux: m.images.tmux, dashboard: m.images.dashboard } }), 'key order does not change the bytes')
  })

  test('accepts a prerelease version', () => {
    const m = createManifest({ version: '1.2.3-rc.1', commit: COMMIT, bundleSha256: 'a'.repeat(64), digests: DIGESTS })
    assert.equal(parseManifest(renderManifest(m)).bundle.name, 'curia-bundle-1.2.3-rc.1.tar.gz')
  })

  test('refuses to create a manifest with a tag, a short digest, a bad commit, or a bad version', () => {
    const base = { version: VERSION, commit: COMMIT, bundleSha256: 'a'.repeat(64), digests: DIGESTS }
    assert.throws(() => createManifest({ ...base, digests: { ...DIGESTS, tmux: '1.2.3' } }), /tmux/)
    assert.throws(() => createManifest({ ...base, digests: { ...DIGESTS, daemon: undefined } }), /daemon/)
    assert.throws(() => createManifest({ ...base, commit: 'abc' }), /commit/)
    assert.throws(() => createManifest({ ...base, version: 'v1.2.3' }), /version/)
    assert.throws(() => createManifest({ ...base, bundleSha256: 'sha256:' + 'a'.repeat(64) }), /sha256/)
  })

  test('parsing refuses every malformed shape and names the field', () => {
    const m = createManifest({ version: VERSION, commit: COMMIT, bundleSha256: 'a'.repeat(64), digests: DIGESTS })
    const mutate = (fn) => { const c = JSON.parse(JSON.stringify(m)); fn(c); return JSON.stringify(c) }
    const refuses = (text, pattern) => assert.throws(() => parseManifest(text), (e) => e instanceof ManifestError && pattern.test(e.message), `${pattern} for ${text.slice(0, 80)}`)

    refuses('not json', /not JSON/)
    refuses('[]', /object/)
    refuses(mutate((c) => { c.format = 2 }), /format/)
    refuses(mutate((c) => { delete c.version }), /version/)
    refuses(mutate((c) => { c.version = 'latest' }), /version/)
    refuses(mutate((c) => { c.extra = 1 }), /extra/)
    refuses(mutate((c) => { c.package.name = 'curia' }), /package\.name/)
    refuses(mutate((c) => { c.package.version = '1.2.4' }), /package\.version/)
    refuses(mutate((c) => { c.bundle.name = 'curia-bundle-1.2.4.tar.gz' }), /bundle\.name/)
    refuses(mutate((c) => { c.bundle.sha256 = 'a'.repeat(63) }), /bundle\.sha256/)
    refuses(mutate((c) => { delete c.images.overseer }), /images\.overseer/)
    refuses(mutate((c) => { c.images.agent = c.images.daemon }), /images\.agent/)
    refuses(mutate((c) => { c.images.daemon.digest = '1.2.3' }), /images\.daemon\.digest/)
    refuses(mutate((c) => { c.images.daemon.name = 'docker.io/alp82/curia-daemon' }), /images\.daemon\.name/)
    refuses(mutate((c) => { c.images.daemon.tag = '1.2.3' }), /images\.daemon\.tag/)
    refuses(mutate((c) => { c.source.repository = 'someone/curia' }), /source\.repository/)
    refuses(mutate((c) => { c.source.commit = 'HEAD' }), /source\.commit/)
    refuses(mutate((c) => { c.source.workflow = '.github/workflows/other.yml' }), /source\.workflow/)
    refuses(mutate((c) => { c.compatibility = { min: '1.0.0' } }), /compatibility/)
  })
})

describe('verifying a staged release', () => {
  test('a valid release passes every check and prints one line per check', async () => {
    const r = release()
    const stdout = sink()
    const report = await verifyStagedRelease(stageOf(r), { stdout }, probesFor(r))
    assert.equal(report.ok, true, stdout.text())
    assert.equal(report.refusal, null)
    assert.deepEqual(report.checks.map((c) => c.status), RELEASE_CHECKS.map(() => 'passed'))
    assert.deepEqual(report.manifest, r.manifest)
    assert.match(stdout.text(), /^ok\s+manifest\s+version 1\.2\.3, commit ccccccc/m)
    assert.match(stdout.text(), /^ok\s+bundle checksum\s+sha256:[0-9a-f]{12}/m)
    assert.match(stdout.text(), /6 checks passed\.$/m)
    assert.ok(!stdout.text().includes('provenance'), 'a staged release verifies no provenance')
  })

  test('the evaluation is pure: the same facts give the same report', async () => {
    const r = release()
    const facts = { version: VERSION, tarball: r.tarball, releaseManifest: r.text, package: { integrity: r.integrity, attested: true, error: null }, bundle: { archive: r.archive, checksum: r.checksum } }
    assert.deepEqual(evaluateRelease(facts), evaluateRelease(facts))
    assert.equal(evaluateRelease(facts).ok, true)
  })

  test('a missing package tarball fails every check, because nothing passes by absence', async () => {
    const r = release()
    const report = await verifyStagedRelease(stageOf(r, { tarball: null }), { stdout: sink() }, probesFor(r))
    failedOnly(report, ...RELEASE_CHECKS.map((c) => c.name))
    assert.match(check(report, 'manifest').observed, /missing/)
    assert.match(report.refusal.message, /manifest/)
  })

  test('a tarball that is not an archive, or that lacks the manifest, fails closed', async () => {
    const r = release()
    const junk = await verifyStagedRelease(stageOf(r, { tarball: Buffer.from('junk') }), { stdout: sink() }, probesFor(r))
    assert.equal(check(junk, 'manifest').status, 'failed')
    assert.match(check(junk, 'manifest').observed, /not a gzip/)
    assert.equal(junk.ok, false)

    const bare = archiveOf({ 'package/package.json': r.packageJson })
    const missing = await verifyStagedRelease(stageOf(r, { tarball: bare }), { stdout: sink() }, probesFor(r, { packument: async () => ({ integrity: sri(bare), attested: true }) }))
    assert.equal(check(missing, 'manifest').status, 'failed')
    assert.match(check(missing, 'manifest').observed, /package\/manifest\.json/)
    assert.equal(missing.ok, false)
  })

  test('a malformed embedded manifest fails and names the field', async () => {
    const r = release({ manifestText: '{"format":1,"version":"1.2.3"}' })
    const report = await verifyStagedRelease(stageOf(r), { stdout: sink() }, probesFor(r))
    assert.equal(check(report, 'manifest').status, 'failed')
    assert.match(check(report, 'manifest').observed, /package/)
    assert.equal(report.ok, false)
  })

  test('a manifest of another version fails the version check', async () => {
    const r = release({ version: '1.2.4' })
    const report = await verifyStagedRelease(stageOf(r, { version: VERSION }), { stdout: sink() }, probesFor(r, { packument: async () => ({ integrity: r.integrity, attested: true }) }))
    assert.equal(check(report, 'version').status, 'failed')
    assert.match(check(report, 'version').observed, /1\.2\.4/)
    assert.match(check(report, 'version').observed, /1\.2\.3/)
    assert.equal(report.ok, false)
  })

  test('a package.json that names another package or version fails the version check', async () => {
    const other = release({ packageJson: JSON.stringify({ name: PACKAGE_NAME, version: '1.2.4' }) })
    const report = await verifyStagedRelease(stageOf(other), { stdout: sink() }, probesFor(other))
    failedOnly(report, 'version')
    assert.match(check(report, 'version').observed, /package\.json/)

    const foreign = release({ packageJson: JSON.stringify({ name: 'curia', version: VERSION }) })
    const named = await verifyStagedRelease(stageOf(foreign), { stdout: sink() }, probesFor(foreign))
    failedOnly(named, 'version')
  })

  test('a substituted tarball fails the package integrity check against the registry', async () => {
    const r = release()
    const substituted = archiveOf({ 'package/package.json': r.packageJson, [`package/${MANIFEST_FILE}`]: r.text, 'package/bin/curia.mjs': 'evil\n' })
    const report = await verifyStagedRelease(stageOf(r, { tarball: substituted }), { stdout: sink() }, probesFor(r))
    failedOnly(report, 'package integrity')
    assert.match(check(report, 'package integrity').observed, /does not match/)
    assert.ok(!check(report, 'package integrity').observed.includes(r.integrity.slice(20)), 'the full integrity string is not printed')
  })

  test('a registry that does not answer, or answers without integrity, fails the package integrity check', async () => {
    const r = release()
    const silent = await verifyStagedRelease(stageOf(r), { stdout: sink() }, probesFor(r, { packument: async () => ({ error: 'connect ETIMEDOUT' }) }))
    failedOnly(silent, 'package integrity')
    assert.match(check(silent, 'package integrity').observed, /ETIMEDOUT/)

    const weak = await verifyStagedRelease(stageOf(r), { stdout: sink() }, probesFor(r, { packument: async () => ({ integrity: 'sha1-abc', attested: true }) }))
    failedOnly(weak, 'package integrity')
    assert.match(check(weak, 'package integrity').observed, /sha512/)
  })

  test('a changed bundle archive fails the checksum, and a checksum file that disagrees fails too', async () => {
    const r = release()
    const other = archiveOf({ [`curia-bundle-${VERSION}/compose.yaml`]: r.compose + '# changed\n' })
    const changed = await verifyStagedRelease(stageOf(r, { archive: other, checksum: `${sha256(other)}  curia-bundle-${VERSION}.tar.gz\n` }), { stdout: sink() }, probesFor(r))
    failedOnly(changed, 'bundle checksum')
    assert.match(check(changed, 'bundle checksum').observed, /manifest binds/)

    const disagree = await verifyStagedRelease(stageOf(r, { checksum: `${'0'.repeat(64)}  curia-bundle-${VERSION}.tar.gz\n` }), { stdout: sink() }, probesFor(r))
    failedOnly(disagree, 'bundle checksum')
    assert.match(check(disagree, 'bundle checksum').observed, /\.sha256/)

    const misnamed = await verifyStagedRelease(stageOf(r, { checksum: `${sha256(r.archive)}  curia-bundle-9.9.9.tar.gz\n` }), { stdout: sink() }, probesFor(r))
    failedOnly(misnamed, 'bundle checksum')

    const absent = await verifyStagedRelease(stageOf(r, { archive: null }), { stdout: sink() }, probesFor(r))
    failedOnly(absent, 'bundle checksum', 'image digests')
  })

  test('a bundle whose images differ from the manifest fails the image digests check', async () => {
    // The manifest binds the checksum of the archive it was created with, so
    // hand-build the facts: a manifest made for one set of digests and a
    // bundle rendered against another.
    const r = release()
    const swapped = renderBundle(TEMPLATE, { ...DIGESTS, overseer: `sha256:${'e'.repeat(64)}` })
    const archive = archiveOf({ [`curia-bundle-${VERSION}/compose.yaml`]: swapped })
    const manifest = createManifest({ version: VERSION, commit: COMMIT, bundleSha256: sha256(archive), digests: DIGESTS })
    const text = renderManifest(manifest)
    const tarball = archiveOf({ 'package/package.json': r.packageJson, [`package/${MANIFEST_FILE}`]: text })
    const report = evaluateRelease({ version: VERSION, tarball, releaseManifest: text, package: { integrity: sri(tarball), attested: true, error: null }, bundle: { archive, checksum: `${sha256(archive)}  curia-bundle-${VERSION}.tar.gz\n` } })
    failedOnly(report, 'image digests')
    assert.match(check(report, 'image digests').observed, /overseer/)
    assert.match(check(report, 'image digests').observed, /eeeeeeeeeeee/)
  })

  test('a bundle with a tagged image, an extra file, or the wrong directory fails the image digests check', async () => {
    const r = release()
    const facts = (archive) => ({ version: VERSION, tarball: r.tarball, releaseManifest: r.text, package: { integrity: r.integrity, attested: true, error: null }, bundle: { archive, checksum: `${sha256(archive)}  curia-bundle-${VERSION}.tar.gz\n` } })
    const withManifest = (archive) => {
      const m = createManifest({ version: VERSION, commit: COMMIT, bundleSha256: sha256(archive), digests: DIGESTS })
      const text = renderManifest(m)
      const tarball = archiveOf({ 'package/package.json': r.packageJson, [`package/${MANIFEST_FILE}`]: text })
      return { ...facts(archive), tarball, releaseManifest: text, package: { integrity: sri(tarball), attested: true, error: null } }
    }

    const tagged = archiveOf({ [`curia-bundle-${VERSION}/compose.yaml`]: r.compose.replace(imageReference('tmux', DIGESTS.tmux), 'ghcr.io/alp82/curia-tmux:1.2.3') })
    const t = evaluateRelease(withManifest(tagged))
    failedOnly(t, 'image digests')
    assert.match(check(t, 'image digests').observed, /curia-tmux:1\.2\.3/)

    const extra = archiveOf({ [`curia-bundle-${VERSION}/compose.yaml`]: r.compose, [`curia-bundle-${VERSION}/override.yaml`]: 'services: {}\n' })
    const e = evaluateRelease(withManifest(extra))
    failedOnly(e, 'image digests')
    assert.match(check(e, 'image digests').observed, /override\.yaml/)

    const wrongDir = archiveOf({ 'curia-bundle-9.9.9/compose.yaml': r.compose })
    const w = evaluateRelease(withManifest(wrongDir))
    failedOnly(w, 'image digests')
    assert.match(check(w, 'image digests').observed, /curia-bundle-1\.2\.3\/compose\.yaml/)
  })

  test('a release asset manifest that is missing, malformed, or another release fails the release manifest check', async () => {
    const r = release()
    const missing = await verifyStagedRelease(stageOf(r), { stdout: sink() }, probesFor(r, { releaseManifest: async () => null }))
    failedOnly(missing, 'release manifest')
    assert.match(check(missing, 'release manifest').observed, /curia-manifest-1\.2\.3\.json/)

    const malformed = await verifyStagedRelease(stageOf(r), { stdout: sink() }, probesFor(r, { releaseManifest: async () => '<html>' }))
    failedOnly(malformed, 'release manifest')

    const other = release({ digests: { ...DIGESTS, daemon: `sha256:${'9'.repeat(64)}` } })
    const differs = await verifyStagedRelease(stageOf(r), { stdout: sink() }, probesFor(r, { releaseManifest: async () => other.text }))
    failedOnly(differs, 'release manifest')
    assert.match(check(differs, 'release manifest').observed, /differs/)
  })

  test('the refusal lists every failed condition and its action', async () => {
    const r = release()
    const report = await verifyStagedRelease(stageOf(r, { archive: null }), { stdout: sink() }, probesFor(r, { releaseManifest: async () => null }))
    assert.equal(report.ok, false)
    assert.match(report.refusal.message, /bundle checksum/)
    assert.match(report.refusal.message, /release manifest/)
    assert.match(report.refusal.message, /Download/)
  })

  test('the printed report never carries a full digest, integrity value, or manifest body', async () => {
    const r = release()
    const stdout = sink()
    await verifyStagedRelease(stageOf(r), { stdout }, probesFor(r))
    assert.ok(!stdout.text().includes(r.integrity), stdout.text())
    assert.ok(!stdout.text().includes(DIGESTS.daemon), stdout.text())
    assert.ok(stdout.text().split('\n').every((l) => l.length < 200), stdout.text())
  })
})

describe('verifying an installed release', () => {
  function install(r, { root = join(scratch, `root-${counter++}`), version = r.version, without = [], compose = r.compose, manifest = r.text, packageJson = r.packageJson } = {}) {
    const p = versionPaths(root, version)
    mkdirSync(dirname(p.manifest), { recursive: true })
    mkdirSync(dirname(p.bundle), { recursive: true })
    const files = { manifest: [p.manifest, manifest], package: [p.package, r.tarball], bundleArchive: [p.bundleArchive, r.archive], bundleChecksum: [p.bundleChecksum, r.checksum], bundle: [p.bundle, compose], packageJson: [join(dirname(p.manifest), 'package.json'), packageJson] }
    for (const [key, [path, content]] of Object.entries(files)) if (!without.includes(key)) writeFileSync(path, content)
    return root
  }

  test('an installed version whose files match the retained artifacts, whose images are attested, and whose package carries provenance passes', async () => {
    const r = release()
    const root = install(r)
    const stdout = sink()
    const calls = []
    const report = await verifyInstalledRelease({ root, version: VERSION, stdout }, probesFor(r, { attestation: async (a) => { calls.push(a); return { ok: true } } }))
    assert.equal(report.ok, true, stdout.text())
    assert.deepEqual(report.checks.map((c) => c.name), [...RELEASE_CHECKS, ...PROVENANCE_CHECKS].map((c) => c.name))
    assert.deepEqual(calls.map((c) => c.reference).sort(), Object.entries(DIGESTS).map(([s, d]) => imageReference(s, d)).sort())
    assert.equal(calls[0].commit, COMMIT)
    assert.equal(calls[0].version, VERSION)
    assert.match(stdout.text(), /^ok\s+image provenance\s+4 images attested by alp82\/curia/m)
    assert.match(stdout.text(), /9 checks passed\.$/m)
  })

  test('an installed file that differs from the retained artifact fails the installed files check', async () => {
    const r = release()
    const drifted = install(r, { compose: r.compose.replace(DIGESTS.tmux, `sha256:${'f'.repeat(64)}`) })
    const report = await verifyInstalledRelease({ root: drifted, version: VERSION, stdout: sink() }, probesFor(r))
    failedOnly(report, 'installed files')
    assert.match(check(report, 'installed files').observed, /bundle\/compose\.yaml/)

    const edited = install(r, { manifest: r.text.replace(COMMIT, 'd'.repeat(40)) })
    const m = await verifyInstalledRelease({ root: edited, version: VERSION, stdout: sink() }, probesFor(r))
    failedOnly(m, 'installed files')
    assert.match(check(m, 'installed files').observed, /cli\/manifest\.json/)
  })

  test('a missing retained artifact or installed file fails closed and names the path', async () => {
    const r = release()
    const noTarball = install(r, { without: ['package'] })
    const report = await verifyInstalledRelease({ root: noTarball, version: VERSION, stdout: sink() }, probesFor(r))
    assert.equal(report.ok, false)
    assert.match(check(report, 'manifest').observed, /cli\.tgz/)

    const noCompose = install(r, { without: ['bundle'] })
    const c = await verifyInstalledRelease({ root: noCompose, version: VERSION, stdout: sink() }, probesFor(r))
    failedOnly(c, 'installed files')
    assert.match(check(c, 'installed files').observed, /bundle\/compose\.yaml/)
  })

  test('an image whose attestation does not verify fails the image provenance check with the command to run', async () => {
    const r = release()
    const root = install(r)
    const report = await verifyInstalledRelease({ root, version: VERSION, stdout: sink() }, probesFor(r, {
      attestation: async ({ reference }) => (reference.includes('curia-overseer') ? { ok: false, error: 'no attestations found for subject' } : { ok: true }),
    }))
    failedOnly(report, 'image provenance')
    assert.match(check(report, 'image provenance').observed, /overseer/)
    assert.match(check(report, 'image provenance').observed, /no attestations found/)
    assert.match(check(report, 'image provenance').action, /gh attestation verify oci:\/\/ghcr\.io\/alp82\/curia-overseer@sha256:4{64}/)
    assert.match(check(report, 'image provenance').action, /--signer-workflow alp82\/curia\/\.github\/workflows\/release\.yml/)
  })

  test('a package the registry does not record provenance for fails the package provenance check', async () => {
    const r = release()
    const root = install(r)
    const report = await verifyInstalledRelease({ root, version: VERSION, stdout: sink() }, probesFor(r, { packument: async () => ({ integrity: r.integrity, attested: false }) }))
    failedOnly(report, 'package provenance')
    assert.match(check(report, 'package provenance').action, /npm audit signatures/)
  })

  test('renderVerification prints the failed checks with their actions', () => {
    const r = release()
    const report = evaluateRelease({ version: VERSION, tarball: r.tarball, releaseManifest: null, package: { integrity: r.integrity, attested: true, error: null }, bundle: { archive: r.archive, checksum: r.checksum } })
    const text = renderVerification(report)
    assert.match(text, /^failed\s+release manifest\s+/m)
    assert.match(text, /5 checks passed, failed: 1 condition\.$/m)
  })
})

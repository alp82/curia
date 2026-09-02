// The publication gate (#871): what `deploy/release/publish.mjs` decides for
// each of the three publication surfaces, in order, and what it refuses. The
// steps take their facts through injectable probes, so these tests reach no
// registry, no release, and no npm. `deploy/release/index.mjs`, the
// promotion and withdrawal command, runs end to end against a generated key.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  PublicationError, PUBLICATION_ORDER,
  planImage, attachAssets, publishRelease, publishPackage, checkSigningKey, verifyPublished, verificationFailure,
} from '../../deploy/release/publish.mjs'
import { createManifest, renderManifest, releaseAssets, PACKAGE_NAME } from '../../cli/src/manifest.mjs'
import { renderBundle } from '../../cli/src/bundle.mjs'
import { generateStableIndexKeys, verifyStableIndex, createStableIndex } from '../../cli/src/stable.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_CLI = path.join(REPO, 'deploy', 'release', 'index.mjs')
const VERSION = '1.2.3'
const TAG = `v${VERSION}`
const COMMIT = 'a'.repeat(40)
const DIGESTS = {
  daemon: `sha256:${'1'.repeat(64)}`,
  tmux: `sha256:${'2'.repeat(64)}`,
  dashboard: `sha256:${'3'.repeat(64)}`,
  overseer: `sha256:${'4'.repeat(64)}`,
}
const TEMPLATE = fs.readFileSync(path.join(REPO, 'deploy', 'bundle', 'compose.yaml'), 'utf8')

let dir
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-publish-')) })
after(() => fs.rmSync(dir, { recursive: true, force: true }))

function refuses(promise, pattern) {
  return assert.rejects(promise, (e) => {
    assert.ok(e instanceof PublicationError, `expected a PublicationError, got ${e.name}: ${e.message}`)
    assert.match(e.message, pattern)
    return true
  })
}

function lines() {
  const out = []
  return { write: (s) => out.push(String(s)), text: () => out.join('') }
}

// The tar the package and the bundle tests build their fixtures with.
function archiveOf(files) {
  const root = fs.mkdtempSync(path.join(dir, 'archive-'))
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), content)
  }
  const tops = [...new Set(Object.keys(files).map((n) => n.split('/')[0]))]
  const tar = spawnSync('tar', ['--format=ustar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '-C', root, '-cf', '-', ...tops])
  assert.equal(tar.status, 0, String(tar.stderr))
  return gzipSync(tar.stdout, { level: 9 })
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const sri = (bytes) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`

// One rendered release in a dist directory, the way the bundle job leaves it.
function dist({ version = VERSION } = {}) {
  const out = fs.mkdtempSync(path.join(dir, 'dist-'))
  const compose = renderBundle(TEMPLATE, DIGESTS)
  const archive = archiveOf({ [`curia-bundle-${version}/compose.yaml`]: compose })
  const assets = releaseAssets(version)
  const manifest = createManifest({ version, commit: COMMIT, bundleSha256: sha256(archive), digests: DIGESTS })
  const files = {
    [assets.bundle]: archive,
    [assets.checksum]: `${sha256(archive)}  ${assets.bundle}\n`,
    [assets.images]: `${JSON.stringify({ version, images: DIGESTS }, null, 2)}\n`,
    [assets.manifest]: renderManifest(manifest),
    [assets.bootstrap]: `#!/usr/bin/env bash\nCURIA_BOOTSTRAP_VERSION='${version}'\n`,
  }
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(out, name), content)
  return { out, files, manifest, archive }
}

// A package directory the way the checkout holds `cli/`, at one version.
function cliDir({ version = VERSION } = {}) {
  const out = fs.mkdtempSync(path.join(dir, 'cli-'))
  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify({ name: PACKAGE_NAME, version, files: ['bin/', 'manifest.json'] }, null, 2)}\n`)
  fs.mkdirSync(path.join(out, 'bin'))
  fs.writeFileSync(path.join(out, 'bin', 'curia.mjs'), '#!/usr/bin/env node\n')
  return out
}

describe('the publication order', () => {
  test('is images, then the bundle on the release, then the release itself, then the package', () => {
    assert.deepEqual(PUBLICATION_ORDER, ['images', 'assets', 'release', 'package'])
  })
})

describe('planImage', () => {
  const reference = `ghcr.io/alp82/curia-daemon:${VERSION}`

  test('builds when the version tag does not exist yet', async () => {
    const out = lines()
    const plan = await planImage({ service: 'daemon', reference, commit: COMMIT, stdout: out }, { imageDigest: async () => null })
    assert.deepEqual(plan, { build: true, digest: null })
    assert.match(out.text(), /daemon: .* is not published yet, so this run builds it/)
  })

  test('reuses the published digest when the tag exists and the release workflow attested it at this commit', async () => {
    const out = lines()
    const seen = []
    const plan = await planImage({ service: 'daemon', reference, commit: COMMIT, stdout: out }, {
      imageDigest: async (ref) => (ref === reference ? DIGESTS.daemon : null),
      attestation: async (q) => { seen.push(q); return { ok: true } },
    })
    assert.deepEqual(plan, { build: false, digest: DIGESTS.daemon })
    assert.deepEqual(seen, [{ reference: `ghcr.io/alp82/curia-daemon@${DIGESTS.daemon}`, commit: COMMIT }])
    assert.match(out.text(), /daemon: .* is already published as sha256:111111111111… and attested at aaaaaaa, so this run reuses it/)
  })

  test('refuses when the tag exists but nothing attests it, because that identity is not this workflow\'s to replace', async () => {
    await refuses(planImage({ service: 'daemon', reference, commit: COMMIT, stdout: lines() }, {
      imageDigest: async () => DIGESTS.daemon,
      attestation: async () => ({ ok: false, error: 'no attestations found' }),
    }), /daemon: .* already exists as sha256:111111111111… without an attestation from the release workflow at aaaaaaa \(no attestations found\)\. A published identity is never rebuilt/)
  })
})

describe('attachAssets', () => {
  test('uploads every asset that is missing from the draft release and reports it', async () => {
    const d = dist()
    const uploaded = []
    const out = lines()
    const report = await attachAssets({ version: VERSION, dist: d.out, stdout: out }, {
      release: async () => ({ draft: true, prerelease: false, assets: [] }),
      downloadAsset: async () => { throw new Error('nothing to download') },
      uploadAsset: async (tag, file) => uploaded.push([tag, path.basename(file)]),
    })
    assert.deepEqual(uploaded, Object.keys(d.files).map((name) => [TAG, name]))
    assert.deepEqual(report, { uploaded: Object.keys(d.files), kept: [] })
    assert.match(out.text(), /curia-bundle-1\.2\.3\.tar\.gz: uploaded/)
  })

  test('keeps an asset the release already carries with the same bytes, and uploads only the rest', async () => {
    const d = dist()
    const uploaded = []
    const assets = releaseAssets(VERSION)
    const report = await attachAssets({ version: VERSION, dist: d.out, stdout: lines() }, {
      release: async () => ({ draft: true, prerelease: false, assets: [assets.bundle, assets.checksum] }),
      downloadAsset: async (tag, name) => Buffer.from(d.files[name]),
      uploadAsset: async (tag, file) => uploaded.push(path.basename(file)),
    })
    assert.deepEqual(report, { uploaded: [assets.images, assets.manifest, assets.bootstrap], kept: [assets.bundle, assets.checksum] })
    assert.deepEqual(uploaded, [assets.images, assets.manifest, assets.bootstrap])
  })

  test('refuses when the release carries the asset with different bytes', async () => {
    const d = dist()
    const assets = releaseAssets(VERSION)
    await refuses(attachAssets({ version: VERSION, dist: d.out, stdout: lines() }, {
      release: async () => ({ draft: true, prerelease: false, assets: [assets.manifest] }),
      downloadAsset: async () => Buffer.from('{"format":1}\n'),
      uploadAsset: async () => assert.fail('nothing may be uploaded after a refusal'),
    }), /curia-manifest-1\.2\.3\.json already exists on release v1\.2\.3 with different bytes \(sha256:.{12}… published, sha256:.{12}… rendered\)\. A published identity is never replaced/)
  })

  test('refuses when there is no release for the version, because Release Please creates the draft', async () => {
    const d = dist()
    await refuses(attachAssets({ version: VERSION, dist: d.out, stdout: lines() }, {
      release: async () => null,
      downloadAsset: async () => null,
      uploadAsset: async () => null,
    }), /no release v1\.2\.3 exists\. Release Please creates the draft release/)
  })

  test('refuses when a rendered asset is missing from dist, before it touches the release', async () => {
    const d = dist()
    fs.unlinkSync(path.join(d.out, releaseAssets(VERSION).images))
    await refuses(attachAssets({ version: VERSION, dist: d.out, stdout: lines() }, {
      release: async () => assert.fail('the release is not asked'),
    }), /curia-images-1\.2\.3\.json was not rendered/)
  })
})

describe('publishRelease', () => {
  const assets = Object.values(releaseAssets(VERSION)).filter((n) => !n.endsWith('.tgz'))

  test('publishes the draft once every asset is attached, as a release for a plain version', async () => {
    const published = []
    const out = lines()
    const result = await publishRelease({ version: VERSION, stdout: out }, {
      release: async () => ({ draft: true, prerelease: false, assets }),
      publishRelease: async (tag, options) => published.push([tag, options]),
    })
    assert.deepEqual(published, [[TAG, { prerelease: false }]])
    assert.deepEqual(result, { published: true })
    assert.match(out.text(), /release v1\.2\.3: published with 5 assets/)
  })

  test('marks a prerelease version as a prerelease on GitHub', async () => {
    const published = []
    const version = '1.3.0-rc.1'
    await publishRelease({ version, stdout: lines() }, {
      release: async () => ({ draft: true, prerelease: false, assets: Object.values(releaseAssets(version)).filter((n) => !n.endsWith('.tgz')) }),
      publishRelease: async (tag, options) => published.push([tag, options]),
    })
    assert.deepEqual(published, [['v1.3.0-rc.1', { prerelease: true }]])
  })

  test('leaves a release that is already published alone', async () => {
    const out = lines()
    const result = await publishRelease({ version: VERSION, stdout: out }, {
      release: async () => ({ draft: false, prerelease: false, assets }),
      publishRelease: async () => assert.fail('a published release is not published again'),
    })
    assert.deepEqual(result, { published: false })
    assert.match(out.text(), /release v1\.2\.3: already published/)
  })

  test('refuses to publish a draft that lacks an asset', async () => {
    await refuses(publishRelease({ version: VERSION, stdout: lines() }, {
      release: async () => ({ draft: true, prerelease: false, assets: assets.slice(1) }),
      publishRelease: async () => assert.fail('an incomplete draft is not published'),
    }), /release v1\.2\.3 lacks curia-manifest-1\.2\.3\.json/)
  })
})

describe('publishPackage', () => {
  // What `npm pack` would produce for one package directory: deterministic
  // for the same files, so a second run packs the same bytes.
  const bytesOf = (cwd) => archiveOf({ 'package/package.json': fs.readFileSync(path.join(cwd, 'package.json')), 'package/manifest.json': fs.readFileSync(path.join(cwd, 'manifest.json')) })
  const pack = async (cwd, dest) => {
    const file = path.join(dest, `curia-sh-cli-${VERSION}.tgz`)
    fs.writeFileSync(file, bytesOf(cwd))
    return file
  }

  test('hands the pack probe absolute directories, because npm resolves the destination against the package', async () => {
    const d = dist()
    const cli = cliDir()
    const seen = []
    const relativeDist = path.relative(process.cwd(), d.out)
    const relativeCli = path.relative(process.cwd(), cli)
    assert.ok(!path.isAbsolute(relativeDist) && !path.isAbsolute(relativeCli))
    await publishPackage({ version: VERSION, dist: relativeDist, cli: relativeCli, stdout: lines() }, {
      packument: async () => ({ error: 'HTTP 404' }),
      pack: async (cwd, dest) => { seen.push([cwd, dest]); return pack(cwd, dest) },
      npmPublish: async () => {},
    })
    assert.deepEqual(seen, [[cli, d.out]])
  })

  test('copies the rendered manifest into the package byte for byte, packs, and publishes when the registry has no such version', async () => {
    const d = dist()
    const cli = cliDir()
    const calls = []
    let published = null
    const out = lines()
    const result = await publishPackage({ version: VERSION, dist: d.out, cli, stdout: out }, {
      packument: async () => (published ? { integrity: published } : { error: 'HTTP 404' }),
      pack: async (cwd, dest) => { calls.push('pack'); return pack(cwd, dest) },
      npmPublish: async (cwd) => { calls.push('publish'); published = sri(bytesOf(cwd)) },
    })
    assert.equal(fs.readFileSync(path.join(cli, 'manifest.json'), 'utf8'), d.files[releaseAssets(VERSION).manifest])
    assert.deepEqual(calls, ['pack', 'publish'])
    assert.deepEqual(result, { published: true, integrity: published })
    assert.match(out.text(), /@curia-sh\/cli@1\.2\.3: published/)
    assert.ok(!out.text().includes(published), 'no full integrity value is printed')
  })

  test('skips the publish when the registry already serves the same bytes', async () => {
    const d = dist()
    const cli = cliDir()
    const out = lines()
    let packed
    const result = await publishPackage({ version: VERSION, dist: d.out, cli, stdout: out }, {
      packument: async () => ({ integrity: packed }),
      pack: async (cwd, dest) => { packed = sri(bytesOf(cwd)); return pack(cwd, dest) },
      npmPublish: async () => assert.fail('the same bytes are not published twice'),
    })
    assert.deepEqual(result, { published: false, integrity: packed })
    assert.match(out.text(), /@curia-sh\/cli@1\.2\.3: already published with the same bytes/)
  })

  test('refuses when the registry serves the version with different bytes', async () => {
    const d = dist()
    await refuses(publishPackage({ version: VERSION, dist: d.out, cli: cliDir(), stdout: lines() }, {
      packument: async () => ({ integrity: `sha512-${'A'.repeat(86)}==` }),
      pack,
      npmPublish: async () => assert.fail('different bytes are never published over a version'),
    }), /@curia-sh\/cli@1\.2\.3 already exists on the registry with different bytes \(sha512-AAAAAAAAAAAA… published, sha512-.{12}… packed\)\. A published version is never replaced: publish the next version/)
  })

  test('refuses when the package version is not the release version, because Release Please bumps cli/package.json', async () => {
    const d = dist()
    const cli = cliDir({ version: '1.2.2' })
    await refuses(publishPackage({ version: VERSION, dist: d.out, cli, stdout: lines() }, {
      packument: async () => assert.fail('the registry is not asked'),
      pack: async () => assert.fail('nothing is packed'),
      npmPublish: async () => assert.fail('nothing is published'),
    }), /cli\/package\.json names version 1\.2\.2, not 1\.2\.3/)
    assert.equal(fs.existsSync(path.join(cli, 'manifest.json')), false, 'the manifest is not copied into a package at the wrong version')
  })

  test('refuses a rendered manifest for another version, and a registry that does not answer', async () => {
    const d = dist({ version: '1.2.4' })
    fs.renameSync(path.join(d.out, releaseAssets('1.2.4').manifest), path.join(d.out, releaseAssets(VERSION).manifest))
    await refuses(publishPackage({ version: VERSION, dist: d.out, cli: cliDir(), stdout: lines() }, {}), /curia-manifest-1\.2\.3\.json is for version 1\.2\.4/)
    const good = dist()
    await refuses(publishPackage({ version: VERSION, dist: good.out, cli: cliDir(), stdout: lines() }, {
      packument: async () => ({ error: 'ECONNRESET' }),
      pack,
      npmPublish: async () => assert.fail('nothing is published without the registry\'s answer'),
    }), /the npm registry did not answer for @curia-sh\/cli@1\.2\.3 \(ECONNRESET\)/)
  })
})

describe('checkSigningKey', () => {
  const keys = generateStableIndexKeys()

  test('passes when the secret private key matches the public key the package pins, and prints only the fingerprint', () => {
    const file = path.join(dir, 'stable-index.pub')
    fs.writeFileSync(file, keys.publicKey)
    const out = lines()
    checkSigningKey({ privateKey: keys.privateKey, publicKeyFile: file, stdout: out })
    assert.equal(out.text(), `stable-index key: the package pins ${keys.fingerprint}, and the signing secret matches\n`)
  })

  test('refuses a missing public key, a missing secret, and a pair that does not match', () => {
    const file = path.join(dir, 'stable-index-other.pub')
    fs.writeFileSync(file, generateStableIndexKeys().publicKey)
    assert.throws(() => checkSigningKey({ privateKey: keys.privateKey, publicKeyFile: path.join(dir, 'absent.pub'), stdout: lines() }), /the package pins no stable-index public key/)
    assert.throws(() => checkSigningKey({ privateKey: '', publicKeyFile: file, stdout: lines() }), /CURIA_STABLE_INDEX_KEY is not set/)
    assert.throws(() => checkSigningKey({ privateKey: keys.privateKey, publicKeyFile: file, stdout: lines() }), new RegExp(`the signing secret is key ${keys.fingerprint}, and the package pins`))
    assert.throws(() => checkSigningKey({ privateKey: 'not a key', publicKeyFile: file, stdout: lines() }), /CURIA_STABLE_INDEX_KEY is not a PEM private key/)
  })
})

describe('verifyPublished', () => {
  test('downloads the published package, bundle, and checksum and runs the release verification on them', async () => {
    const d = dist()
    const assets = releaseAssets(VERSION)
    const manifestText = d.files[assets.manifest]
    const tarball = archiveOf({
      'package/package.json': `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION })}\n`,
      'package/manifest.json': manifestText,
    })
    const out = lines()
    const report = await verifyPublished({ version: VERSION, stdout: out }, {
      packageTarball: async (name, version) => (name === PACKAGE_NAME && version === VERSION ? tarball : null),
      downloadAsset: async (tag, name) => (tag === TAG ? Buffer.from(d.files[name]) : null),
      packument: async () => ({ integrity: sri(tarball), attested: true }),
      releaseManifest: async () => manifestText,
    })
    assert.equal(report.ok, true, out.text())
    assert.match(out.text(), /6 checks passed/)
  })

  test('a release whose package the registry does not serve fails, and the report says which check', async () => {
    const d = dist()
    const out = lines()
    const report = await verifyPublished({ version: VERSION, stdout: out, tarballWait: { atMost: 0 } }, {
      packageTarball: async () => null,
      downloadAsset: async (tag, name) => Buffer.from(d.files[name]),
      packument: async () => ({ error: 'HTTP 404' }),
      releaseManifest: async () => d.files[releaseAssets(VERSION).manifest],
    })
    assert.equal(report.ok, false)
    assert.deepEqual(report.checks.filter((c) => c.status === 'failed').map((c) => c.name), ['manifest', 'version', 'package integrity', 'bundle checksum', 'image digests', 'release manifest'])
  })

  // The registry indexes a version before it serves the tarball; 0.6.1 took
  // about two hours (#890). The verification waits a bounded time for it.
  function published() {
    const d = dist()
    const manifestText = d.files[releaseAssets(VERSION).manifest]
    const tarball = archiveOf({
      'package/package.json': `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION })}\n`,
      'package/manifest.json': manifestText,
    })
    return {
      tarball,
      probes: {
        downloadAsset: async (tag, name) => Buffer.from(d.files[name]),
        packument: async () => ({ integrity: sri(tarball), attested: true }),
        releaseManifest: async () => manifestText,
      },
    }
  }

  test('a tarball the registry does not serve yet is asked for again every interval, and the report passes once it arrives', async () => {
    const { tarball, probes } = published()
    const slept = []
    let asked = 0
    const out = lines()
    const report = await verifyPublished({ version: VERSION, stdout: out, tarballWait: { every: 20_000, atMost: 600_000 } }, {
      ...probes,
      packageTarball: async () => (++asked < 3 ? null : tarball),
      sleep: async (ms) => { slept.push(ms) },
    })
    assert.equal(report.ok, true, out.text())
    assert.equal(asked, 3)
    assert.deepEqual(slept, [20_000, 20_000])
    assert.equal(out.text().match(/the registry does not serve the package tarball yet/g).length, 2)
    assert.match(out.text(), /waited 20s of 600s/)
    assert.match(out.text(), /waited 40s of 600s/)
  })

  test('the wait for the tarball is bounded, and the report then fails on the missing package', async () => {
    const { probes } = published()
    const slept = []
    let asked = 0
    const out = lines()
    const report = await verifyPublished({ version: VERSION, stdout: out, tarballWait: { every: 20_000, atMost: 60_000 } }, {
      ...probes,
      packageTarball: async () => { asked += 1; return null },
      sleep: async (ms) => { slept.push(ms) },
    })
    assert.equal(report.ok, false)
    assert.equal(asked, 4)
    assert.deepEqual(slept, [20_000, 20_000, 20_000])
    assert.match(report.refusal.message, /the package tarball is missing/)
  })

  test('the verify failure names the rerun of this workflow run, since the earlier steps keep what they published', () => {
    const report = { ok: false, refusal: { message: 'package integrity: the package tarball is missing.' } }
    const message = verificationFailure(report, { GITHUB_RUN_ID: '33614070854' })
    assert.match(message, /^package integrity: the package tarball is missing\./)
    assert.match(message, /gh run rerun 33614070854 --failed/)
    assert.match(message, /once the registry serves the tarball/)
    assert.match(verificationFailure(report, {}), /gh run rerun <run-id> --failed/)
  })
})

describe('deploy/release/index.mjs', () => {
  const keys = generateStableIndexKeys()

  function run(args, { cwd, key = keys.privateKey, now = '2026-09-02T10:00:00Z' } = {}) {
    return spawnSync(process.execPath, [INDEX_CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CURIA_STABLE_INDEX_KEY: key, CURIA_STABLE_INDEX_NOW: now },
    })
  }

  function checkout() {
    const root = fs.mkdtempSync(path.join(dir, 'checkout-'))
    fs.mkdirSync(path.join(root, 'cli'))
    fs.writeFileSync(path.join(root, 'cli', 'stable-index.pub'), keys.publicKey)
    return root
  }

  test('promote writes the first signed index from nothing, and show reads it back', () => {
    const root = checkout()
    const r = run(['promote', '1.2.3'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /promoted 1\.2\.3 as the stable release \(sequence 1\)/)
    const text = fs.readFileSync(path.join(root, 'release', 'stable.json'), 'utf8')
    assert.deepEqual(verifyStableIndex(text, { publicKey: keys.publicKey }), createStableIndex({ sequence: 1, updated: '2026-09-02T10:00:00Z', stable: '1.2.3' }))
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY/)
    const show = run(['show'], { cwd: root })
    assert.equal(show.status, 0, show.stderr)
    assert.match(show.stdout, /stable-release index: sequence 1, stable 1\.2\.3, nothing withdrawn/)
  })

  test('withdraw adds the version, clears the stable release when it is the one withdrawn, and the sequence rises each time', () => {
    const root = checkout()
    assert.equal(run(['promote', '1.2.3'], { cwd: root }).status, 0)
    const w1 = run(['withdraw', '1.2.2'], { cwd: root, now: '2026-09-03T10:00:00Z' })
    assert.equal(w1.status, 0, w1.stderr)
    assert.match(w1.stdout, /withdrew 1\.2\.2 \(sequence 2\)/)
    const w2 = run(['withdraw', '1.2.3'], { cwd: root, now: '2026-09-04T10:00:00Z' })
    assert.equal(w2.status, 0, w2.stderr)
    assert.match(w2.stdout, /withdrew 1\.2\.3 \(sequence 3\)\. It was the stable release, so no stable release is recommended until the next promotion/)
    const index = verifyStableIndex(fs.readFileSync(path.join(root, 'release', 'stable.json'), 'utf8'), { publicKey: keys.publicKey })
    assert.deepEqual(index, createStableIndex({ sequence: 3, updated: '2026-09-04T10:00:00Z', stable: null, withdrawn: ['1.2.2', '1.2.3'] }))
  })

  test('a change that changes nothing writes nothing and says so', () => {
    const root = checkout()
    assert.equal(run(['promote', '1.2.3'], { cwd: root }).status, 0)
    const before = fs.readFileSync(path.join(root, 'release', 'stable.json'), 'utf8')
    const again = run(['promote', '1.2.3'], { cwd: root, now: '2026-09-05T10:00:00Z' })
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /1\.2\.3 is already the stable release; nothing to change/)
    assert.equal(fs.readFileSync(path.join(root, 'release', 'stable.json'), 'utf8'), before)
  })

  test('refuses a prerelease promotion, a withdrawn promotion, and exits 3', () => {
    const root = checkout()
    const rc = run(['promote', '1.3.0-rc.1'], { cwd: root })
    assert.equal(rc.status, 3)
    assert.match(rc.stderr, /1\.3\.0-rc\.1 is a prerelease/)
    assert.equal(run(['withdraw', '1.2.3'], { cwd: root }).status, 0)
    const withdrawn = run(['promote', '1.2.3'], { cwd: root })
    assert.equal(withdrawn.status, 3)
    assert.match(withdrawn.stderr, /1\.2\.3 is withdrawn/)
  })

  test('refuses to build on an index that does not verify against the pinned key, and refuses without the secret', () => {
    const root = checkout()
    assert.equal(run(['promote', '1.2.3'], { cwd: root }).status, 0)
    const file = path.join(root, 'release', 'stable.json')
    const good = fs.readFileSync(file, 'utf8')
    const before = () => good
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"stable": "1.2.3"', '"stable": "9.9.9"'))
    const tampered = run(['withdraw', '1.0.0'], { cwd: root })
    assert.equal(tampered.status, 3)
    assert.match(tampered.stderr, /signature does not verify/)
    fs.writeFileSync(file, before(root))
    const nokey = run(['show'], { cwd: root, key: '' })
    assert.equal(nokey.status, 0, 'show needs the public key only')
    const promoteNoKey = run(['promote', '1.2.4'], { cwd: checkout(), key: '' })
    assert.equal(promoteNoKey.status, 3)
    assert.match(promoteNoKey.stderr, /CURIA_STABLE_INDEX_KEY is not set/)
  })

  test('refuses a wrong secret before it writes, and a usage error exits 2', () => {
    const root = checkout()
    const wrong = run(['promote', '1.2.3'], { cwd: root, key: generateStableIndexKeys().privateKey })
    assert.equal(wrong.status, 3)
    assert.match(wrong.stderr, /the signing secret is key/)
    assert.equal(fs.existsSync(path.join(root, 'release', 'stable.json')), false)
    const usage = run(['promote'], { cwd: root })
    assert.equal(usage.status, 2)
    assert.match(usage.stderr, /usage: index\.mjs/)
  })
})

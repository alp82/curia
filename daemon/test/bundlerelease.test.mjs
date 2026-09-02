// The rendered release bundle (#869): what `deploy/bundle/render.mjs` writes
// for one version from the digests the image builds produced. The output is
// what #870 binds into the release manifest and #871 publishes, so its shape
// and its determinism are pinned here.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { inspectBundle, RELEASE_IMAGES, IMAGE_REGISTRY } from '../../cli/src/bundle.mjs'
import { parseManifest } from '../../cli/src/manifest.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RENDER = path.join(REPO, 'deploy', 'bundle', 'render.mjs')
const VERSION = '1.2.3'
const COMMIT = 'a'.repeat(40)
const DIGESTS = {
  daemon: `sha256:${'1'.repeat(64)}`,
  tmux: `sha256:${'2'.repeat(64)}`,
  dashboard: `sha256:${'3'.repeat(64)}`,
  overseer: `sha256:${'4'.repeat(64)}`,
  agent: `sha256:${'5'.repeat(64)}`,
}

const gnuTar = /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '')

let dir
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-release-')) })
after(() => fs.rmSync(dir, { recursive: true, force: true }))

function render(out, digests = DIGESTS, version = VERSION, commit = COMMIT) {
  const file = path.join(dir, `digests-${crypto.randomUUID()}.json`)
  fs.writeFileSync(file, JSON.stringify(digests))
  return spawnSync(process.execPath, [RENDER, '--version', version, '--digests', file, '--commit', commit, '--out', out], { encoding: 'utf8' })
}

describe('deploy/bundle/render.mjs', { skip: gnuTar ? false : 'the bundle archive needs GNU tar' }, () => {
  test('writes the bundle directory, its archive, the checksum, and the image set for one version', () => {
    const out = path.join(dir, 'one')
    const r = render(out)
    assert.equal(r.status, 0, r.stderr)

    const compose = fs.readFileSync(path.join(out, `curia-bundle-${VERSION}`, 'compose.yaml'), 'utf8')
    assert.deepEqual(inspectBundle(compose), [])
    assert.match(compose, new RegExp(`image: ${IMAGE_REGISTRY}/curia-daemon@${DIGESTS.daemon}$`, 'm'))

    const archive = path.join(out, `curia-bundle-${VERSION}.tar.gz`)
    const listing = spawnSync('tar', ['tzf', archive], { encoding: 'utf8' }).stdout.trim().split('\n')
    assert.deepEqual(listing, [`curia-bundle-${VERSION}/`, `curia-bundle-${VERSION}/compose.yaml`])

    const sum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    assert.equal(fs.readFileSync(`${archive}.sha256`, 'utf8'), `${sum}  curia-bundle-${VERSION}.tar.gz\n`)

    const images = JSON.parse(fs.readFileSync(path.join(out, `curia-images-${VERSION}.json`), 'utf8'))
    assert.equal(images.version, VERSION)
    assert.deepEqual(Object.keys(images.images), Object.keys(RELEASE_IMAGES))
    assert.deepEqual(images.images.tmux, { name: `${IMAGE_REGISTRY}/curia-tmux`, digest: DIGESTS.tmux, reference: `${IMAGE_REGISTRY}/curia-tmux@${DIGESTS.tmux}` })
    // The agent image is in the digest set and the manifest, and in the
    // bundle it is not: no service runs it.
    assert.deepEqual(images.images.agent, { name: `${IMAGE_REGISTRY}/curia-agent`, digest: DIGESTS.agent, reference: `${IMAGE_REGISTRY}/curia-agent@${DIGESTS.agent}` })
    assert.ok(!compose.includes('curia-agent'), 'the bundle names no agent image')

    assert.match(r.stdout, new RegExp(`curia-bundle-${VERSION}.tar.gz\\s+sha256:${sum}`))

    // The release manifest binds what was just written: the same checksum,
    // the same digests, the package version, and the commit.
    const manifest = parseManifest(fs.readFileSync(path.join(out, `curia-manifest-${VERSION}.json`), 'utf8'))
    assert.equal(manifest.version, VERSION)
    assert.equal(manifest.package.version, VERSION)
    assert.equal(manifest.bundle.sha256, sum)
    assert.equal(manifest.bundle.name, `curia-bundle-${VERSION}.tar.gz`)
    assert.deepEqual(Object.fromEntries(Object.entries(manifest.images).map(([s, i]) => [s, i.digest])), DIGESTS)
    assert.equal(manifest.source.commit, COMMIT)
    assert.match(r.stdout, new RegExp(`curia-manifest-${VERSION}.json\\s+commit ${COMMIT}`))
  })

  test('renders the same bytes on every run, so the checksum the manifest binds is stable', () => {
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    assert.equal(render(a).status, 0)
    assert.equal(render(b).status, 0)
    const archive = `curia-bundle-${VERSION}.tar.gz`
    assert.ok(fs.readFileSync(path.join(a, archive)).equals(fs.readFileSync(path.join(b, archive))))
    assert.equal(fs.readFileSync(path.join(a, `${archive}.sha256`), 'utf8'), fs.readFileSync(path.join(b, `${archive}.sha256`), 'utf8'))
    assert.equal(fs.readFileSync(path.join(a, `curia-manifest-${VERSION}.json`), 'utf8'), fs.readFileSync(path.join(b, `curia-manifest-${VERSION}.json`), 'utf8'))
  })

  test('refuses a missing digest, a tag, or a version that is not a plain release version', () => {
    const missing = render(path.join(dir, 'missing'), { ...DIGESTS, overseer: undefined })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /overseer/)
    const noAgent = render(path.join(dir, 'no-agent'), { ...DIGESTS, agent: undefined })
    assert.equal(noAgent.status, 1)
    assert.match(noAgent.stderr, /agent/)
    const tagged = render(path.join(dir, 'tagged'), { ...DIGESTS, daemon: 'v1.2.3' })
    assert.equal(tagged.status, 1)
    assert.match(tagged.stderr, /daemon/)
    const version = render(path.join(dir, 'version'), DIGESTS, 'v1.2.3')
    assert.equal(version.status, 1)
    assert.match(version.stderr, /version/)
    assert.ok(!fs.existsSync(path.join(dir, 'version', 'curia-bundle-v1.2.3.tar.gz')))
    const commit = render(path.join(dir, 'commit'), DIGESTS, VERSION, 'HEAD')
    assert.equal(commit.status, 1)
    assert.match(commit.stderr, /commit/)
    assert.ok(!fs.existsSync(path.join(dir, 'commit', `curia-manifest-${VERSION}.json`)))
  })
})

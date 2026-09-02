#!/usr/bin/env node
// Render the versioned Compose bundle of one release (#869).
//
//     node deploy/bundle/render.mjs --version 1.2.3 --digests digests.json --commit <sha> --out dist
//
// `digests.json` maps each release image's service name to the sha256 digest
// the registry returned when the release workflow pushed it:
//
//     { "daemon": "sha256:…", "tmux": "sha256:…", "dashboard": "sha256:…", "overseer": "sha256:…" }
//
// The script renders deploy/bundle/compose.yaml with those digests, refuses
// anything the static inspection in cli/src/bundle.mjs objects to, and writes
// into `--out`:
//
//     curia-bundle-<version>/compose.yaml     the bundle, what versions/<version>/bundle/ holds
//     curia-bundle-<version>.tar.gz           the same, as one deterministic archive
//     curia-bundle-<version>.tar.gz.sha256    its checksum, `sha256sum -c` shape
//     curia-images-<version>.json             the digest set, for reading
//     curia-manifest-<version>.json           the release manifest (#870): the package
//                                             version, the bundle checksum, every image
//                                             digest, and the commit and workflow that built them
//
// The archive is byte-for-byte the same for the same inputs: a sorted ustar
// with epoch timestamps and numeric zero ownership, gzipped with no name and
// no time. That is what lets the manifest bind one checksum and an operator
// verify a download against it. The manifest is the file the publication
// step (#871) copies into the npm package as `manifest.json`, so the package
// and the release carry the same bytes.
//
// No dependency beyond node and GNU tar, so the runner needs no install
// before the images are built.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { renderBundle, inspectBundle, imageReference, RELEASE_IMAGES, IMAGE_REGISTRY, BundleError } from '../../cli/src/bundle.mjs'
import { createManifest, renderManifest, releaseAssets } from '../../cli/src/manifest.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
export const TEMPLATE = path.join(DIR, 'compose.yaml')

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!/^--(version|digests|commit|out)$/.test(key) || argv[i + 1] === undefined) {
      throw new BundleError('usage: render.mjs --version <version> --digests <file.json> --commit <sha> --out <dir>')
    }
    out[key.slice(2)] = argv[i + 1]
  }
  for (const key of ['version', 'digests', 'commit', 'out']) if (!out[key]) throw new BundleError(`--${key} is required`)
  return out
}

// The archive bytes for one bundle directory, deterministic.
function archive(outDir, name) {
  const tar = spawnSync('tar', [
    '--format=ustar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0',
    '-C', outDir, '-cf', '-', name,
  ], { maxBuffer: 64 * 1024 * 1024 })
  if (tar.status !== 0) throw new BundleError(`tar failed: ${tar.stderr}`)
  return zlib.gzipSync(tar.stdout, { level: 9 })
}

export function renderRelease({ version, digests, commit, out }) {
  if (!RELEASE_VERSION.test(version)) throw new BundleError(`--version must be a plain release version like 1.2.3, got ${version}`)
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new BundleError(`--commit must be the full 40-hex commit, got ${commit}`)
  const template = fs.readFileSync(TEMPLATE, 'utf8')
  const compose = renderBundle(template, digests)
  const problems = inspectBundle(compose)
  if (problems.length) throw new BundleError(`the rendered bundle is not fit to publish:\n  ${problems.join('\n  ')}`)

  const name = `curia-bundle-${version}`
  const bundleDir = path.join(out, name)
  fs.mkdirSync(bundleDir, { recursive: true })
  fs.writeFileSync(path.join(bundleDir, 'compose.yaml'), compose)

  const bytes = archive(out, name)
  const sum = crypto.createHash('sha256').update(bytes).digest('hex')
  fs.writeFileSync(path.join(out, `${name}.tar.gz`), bytes)
  fs.writeFileSync(path.join(out, `${name}.tar.gz.sha256`), `${sum}  ${name}.tar.gz\n`)

  const images = Object.fromEntries(Object.entries(RELEASE_IMAGES).map(([service, image]) => [service, {
    name: `${IMAGE_REGISTRY}/${image}`,
    digest: digests[service],
    reference: imageReference(service, digests[service]),
  }]))
  fs.writeFileSync(path.join(out, `curia-images-${version}.json`), `${JSON.stringify({ version, images }, null, 2)}\n`)

  const manifest = createManifest({ version, commit, bundleSha256: sum, digests })
  fs.writeFileSync(path.join(out, releaseAssets(version).manifest), renderManifest(manifest))

  return { name, archive: `${name}.tar.gz`, sha256: sum, images, manifest }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version, digests, commit, out } = args(process.argv.slice(2))
    const result = renderRelease({ version, digests: JSON.parse(fs.readFileSync(digests, 'utf8')), commit, out })
    process.stdout.write(`${result.archive}  sha256:${result.sha256}\n`)
    for (const [service, { reference }] of Object.entries(result.images)) process.stdout.write(`${service}  ${reference}\n`)
    process.stdout.write(`${releaseAssets(version).manifest}  commit ${commit}\n`)
  } catch (e) {
    process.stderr.write(`render.mjs: ${e.message}\n`)
    process.exit(1)
  }
}

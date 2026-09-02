#!/usr/bin/env node
// The publication gate (#871, implementing #849 and #854).
//
// The release workflow (.github/workflows/release.yml) publishes one version
// in dependency order: the four images by digest, then the bundle and the
// manifest as assets of the draft release, then the release itself (which
// creates the tag and locks the assets), then `@curia-sh/cli` last, with the
// manifest inside it. This script is the one place that decides, for each of
// those surfaces, whether the identity about to be published already exists,
// and what that means:
//
//   - absent: publish it;
//   - present with the same bytes: keep it and say so, so a rerun of the
//     workflow after a failed step finishes the publication instead of
//     starting a second one;
//   - present with different bytes: refuse. A published identity is never
//     replaced. The corrective action is to publish the next version.
//
// Every read and write of a registry, the release, or npm goes through
// `publicationProbes`, so the tests hand in fakes and prove each decision
// without a network. The subcommands the workflow runs:
//
//     publish.mjs key
//     publish.mjs image --service <s> --reference <name:tag> --commit <sha>
//     publish.mjs assets --version <v> --dist <dir>
//     publish.mjs release --version <v>
//     publish.mjs package --version <v> --dist <dir> --cli <dir>
//     publish.mjs verify --version <v>
//
// `image` writes `build` and `digest` to $GITHUB_OUTPUT when it is set. No
// subcommand prints a secret, a full digest, or a full integrity value.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PACKAGE_NAME, NPM_REGISTRY, releaseAssets, parseManifest, releaseProbes, verifyStagedRelease, isReleaseVersion } from '../../cli/src/manifest.mjs'
import { isPrerelease, keyFingerprint, STABLE_INDEX_KEY_FILE } from '../../cli/src/stable.mjs'

const run = promisify(execFile)

export class PublicationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PublicationError'
  }
}

export const PUBLICATION_ORDER = Object.freeze(['images', 'assets', 'release', 'package'])

// The four files the bundle job renders and the release carries, in upload
// order. The package tarball is not one: npm serves it.
function publishedAssets(version) {
  const a = releaseAssets(version)
  return [a.bundle, a.checksum, a.images, a.manifest]
}

// A digest or an integrity value, abbreviated for a report: the prefix and
// twelve characters, enough to compare with a release page by eye.
export function abbreviate(value) {
  const m = /^(sha256:|sha512-)?(.*)$/s.exec(String(value))
  return `${m[1] ?? ''}${m[2].slice(0, 12)}…`
}
const tagOf = (version) => `v${version}`

// ---------------------------------------------------------------------------
// The probes: one function per thing that reaches outside the runner.

async function gh(args, { input } = {}) {
  const { stdout } = await run('gh', args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', ...(input ? { input } : {}) })
  return stdout
}

export const publicationProbes = Object.freeze({
  // The digest the registry holds under a tag, or null when there is none.
  imageDigest: async (reference) => {
    try {
      const { stdout } = await run('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{.Manifest.Digest}}'], { encoding: 'utf8' })
      const digest = stdout.trim()
      return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null
    } catch (e) {
      if (/not found|MANIFEST_UNKNOWN|no such manifest|NAME_UNKNOWN|denied/i.test(e.stderr ?? e.message)) return null
      throw e
    }
  },
  attestation: releaseProbes.attestation,
  // The release of a tag, draft or published, or null when there is none.
  release: async (tag) => {
    try {
      const out = await gh(['release', 'view', tag, '--json', 'isDraft,isPrerelease,assets'])
      const data = JSON.parse(out.toString('utf8'))
      return { draft: data.isDraft, prerelease: data.isPrerelease, assets: data.assets.map((a) => a.name) }
    } catch (e) {
      if (/release not found|Not Found/i.test(e.stderr ?? e.message)) return null
      throw e
    }
  },
  downloadAsset: async (tag, name) => gh(['release', 'download', tag, '--pattern', name, '--output', '-']),
  uploadAsset: async (tag, file) => { await gh(['release', 'upload', tag, file]) },
  publishRelease: async (tag, { prerelease }) => {
    await gh(['release', 'edit', tag, '--draft=false', prerelease ? '--prerelease' : '--prerelease=false', ...(prerelease ? ['--latest=false'] : [])])
  },
  packument: releaseProbes.packument,
  releaseManifest: releaseProbes.releaseManifest,
  packageTarball: async (name, version) => {
    const bare = name.split('/').pop()
    try {
      const response = await fetch(`${NPM_REGISTRY}/${name}/-/${bare}-${version}.tgz`, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) return null
      return Buffer.from(await response.arrayBuffer())
    } catch {
      return null
    }
  },
  pack: async (cwd, dest) => {
    const { stdout } = await run('npm', ['pack', '--pack-destination', dest, '--silent'], { cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } })
    return path.join(dest, stdout.trim().split('\n').pop())
  },
  npmPublish: async (cwd) => {
    await run('npm', ['publish', '--access', 'public', '--provenance'], { cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } })
  },
})

// ---------------------------------------------------------------------------
// The signing key: the secret and the pinned public key must be one pair.

export function checkSigningKey({ privateKey, publicKeyFile, stdout }) {
  let pinned
  try {
    pinned = fs.readFileSync(publicKeyFile, 'utf8').trim()
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    pinned = ''
  }
  if (!pinned) throw new PublicationError(`the package pins no stable-index public key at ${publicKeyFile}. Run 'node deploy/release/keygen.mjs' once and commit the key it writes.`)
  if (!privateKey) throw new PublicationError('CURIA_STABLE_INDEX_KEY is not set. Add the repository secret that deploy/release/keygen.mjs creates.')
  let key
  try {
    key = crypto.createPrivateKey(privateKey)
  } catch (e) {
    throw new PublicationError(`CURIA_STABLE_INDEX_KEY is not a PEM private key (${e.message}).`)
  }
  const pinnedFingerprint = keyFingerprint(pinned)
  const secretFingerprint = keyFingerprint(crypto.createPublicKey(key))
  if (pinnedFingerprint !== secretFingerprint) {
    throw new PublicationError(`the signing secret is key ${secretFingerprint}, and the package pins ${pinnedFingerprint}. Publish the key the secret matches, or replace the secret.`)
  }
  const probe = crypto.randomBytes(32)
  if (!crypto.verify(null, probe, crypto.createPublicKey(pinned), crypto.sign(null, probe, key))) {
    throw new PublicationError(`key ${pinnedFingerprint} signs, but the pinned public key does not verify the signature.`)
  }
  stdout.write(`stable-index key: the package pins ${pinnedFingerprint}, and the signing secret matches\n`)
}

// ---------------------------------------------------------------------------
// Images: one decision per service, before the build step runs.

export async function planImage({ service, reference, commit, stdout }, probes = publicationProbes) {
  const existing = await probes.imageDigest(reference)
  if (existing === null) {
    stdout.write(`${service}: ${reference} is not published yet, so this run builds it\n`)
    return { build: true, digest: null }
  }
  const name = reference.split(':')[0]
  const result = await probes.attestation({ reference: `${name}@${existing}`, commit })
  if (!result?.ok) {
    throw new PublicationError(`${service}: ${reference} already exists as ${abbreviate(existing)} without an attestation from the release workflow at ${commit.slice(0, 7)} (${firstLine(result?.error) || 'no answer'}). A published identity is never rebuilt: delete the tag from the registry if it is not a release, or publish the next version.`)
  }
  stdout.write(`${service}: ${reference} is already published as ${abbreviate(existing)} and attested at ${commit.slice(0, 7)}, so this run reuses it\n`)
  return { build: false, digest: existing }
}

function firstLine(text) {
  return typeof text === 'string' ? text.split('\n')[0].trim() : ''
}

// ---------------------------------------------------------------------------
// Assets: the rendered files onto the draft release, one identity each.

async function releaseOf(version, probes) {
  const tag = tagOf(version)
  const release = await probes.release(tag)
  if (!release) throw new PublicationError(`no release ${tag} exists. Release Please creates the draft release when the release pull request merges; this workflow only fills it.`)
  return { tag, release }
}

export async function attachAssets({ version, dist, stdout }, probes = publicationProbes) {
  const files = publishedAssets(version).map((name) => ({ name, file: path.join(dist, name) }))
  for (const { name, file } of files) {
    if (!fs.existsSync(file)) throw new PublicationError(`${name} was not rendered into ${dist}.`)
  }
  const { tag, release } = await releaseOf(version, probes)
  // Every asset the release already carries is compared first, so a refusal
  // comes before anything new lands on the release.
  const kept = []
  const pending = []
  for (const { name, file } of files) {
    const rendered = fs.readFileSync(file)
    if (!release.assets.includes(name)) { pending.push({ name, file }); continue }
    const published = Buffer.from(await probes.downloadAsset(tag, name))
    if (!published.equals(rendered)) {
      throw new PublicationError(`${name} already exists on release ${tag} with different bytes (${abbreviate(`sha256:${sha256(published)}`)} published, ${abbreviate(`sha256:${sha256(rendered)}`)} rendered). A published identity is never replaced: publish the next version.`)
    }
    kept.push(name)
  }
  const uploaded = []
  for (const { name, file } of pending) {
    await probes.uploadAsset(tag, file)
    uploaded.push(name)
  }
  for (const name of kept) stdout.write(`${name}: already on ${tag} with the same bytes\n`)
  for (const name of uploaded) stdout.write(`${name}: uploaded to ${tag}\n`)
  return { uploaded, kept }
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

// ---------------------------------------------------------------------------
// The release: draft to published, once, with everything on it.

export async function publishRelease({ version, stdout }, probes = publicationProbes) {
  const { tag, release } = await releaseOf(version, probes)
  const expected = publishedAssets(version)
  const missing = expected.filter((name) => !release.assets.includes(name))
  if (missing.length) throw new PublicationError(`release ${tag} lacks ${missing.join(', ')}. Attach every asset before the release is published; a published release is immutable.`)
  if (!release.draft) {
    stdout.write(`release ${tag}: already published\n`)
    return { published: false }
  }
  const prerelease = isPrerelease(version)
  await probes.publishRelease(tag, { prerelease })
  stdout.write(`release ${tag}: published with ${expected.length} assets${prerelease ? ' as a prerelease' : ''}\n`)
  return { published: true }
}

// ---------------------------------------------------------------------------
// The package: the manifest goes in, the tarball goes out, once.

export async function publishPackage({ version, dist, cli, stdout }, probes = publicationProbes) {
  const manifestName = releaseAssets(version).manifest
  const manifestText = fs.readFileSync(path.join(dist, manifestName), 'utf8')
  const manifest = parseManifest(manifestText)
  if (manifest.version !== version) throw new PublicationError(`${manifestName} is for version ${manifest.version}, not ${version}.`)

  const pkg = JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf8'))
  if (pkg.name !== PACKAGE_NAME || pkg.version !== version) {
    throw new PublicationError(`cli/package.json names version ${pkg.version}, not ${version}. Release Please bumps it through the extra-files entry in release-please-config.json; the release commit must carry it.`)
  }

  fs.writeFileSync(path.join(cli, 'manifest.json'), manifestText)
  const tarball = await probes.pack(cli, dist)
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`

  const spec = `${PACKAGE_NAME}@${version}`
  const registry = await probes.packument(PACKAGE_NAME, version)
  const absent = registry?.error && /HTTP 404/.test(registry.error)
  if (registry?.error && !absent) throw new PublicationError(`the npm registry did not answer for ${spec} (${registry.error}). Run the workflow again when the registry answers.`)
  if (!absent) {
    if (registry.integrity === integrity) {
      stdout.write(`${spec}: already published with the same bytes (${abbreviate(integrity)})\n`)
      return { published: false, integrity }
    }
    throw new PublicationError(`${spec} already exists on the registry with different bytes (${abbreviate(registry.integrity)} published, ${abbreviate(integrity)} packed). A published version is never replaced: publish the next version.`)
  }
  await probes.npmPublish(cli)
  stdout.write(`${spec}: published (${abbreviate(integrity)})\n`)
  return { published: true, integrity }
}

// ---------------------------------------------------------------------------
// After publication: is the version whole where an installation finds it?

export async function verifyPublished({ version, stdout }, probes = publicationProbes) {
  const tag = tagOf(version)
  const assets = releaseAssets(version)
  const tarball = await probes.packageTarball(PACKAGE_NAME, version)
  const archive = await probes.downloadAsset(tag, assets.bundle).catch(() => null)
  const checksum = await probes.downloadAsset(tag, assets.checksum).catch(() => null)
  return verifyStagedRelease({
    version,
    tarball: tarball ? Buffer.from(tarball) : null,
    archive: archive ? Buffer.from(archive) : null,
    checksum: checksum ? Buffer.from(checksum).toString('utf8') : null,
  }, { stdout }, { packument: probes.packument, releaseManifest: probes.releaseManifest, attestation: probes.attestation })
}

// ---------------------------------------------------------------------------
// The command line.

function args(argv, names) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key?.startsWith('--') || !names.includes(key.slice(2)) || argv[i + 1] === undefined) throw new PublicationError(`usage: publish.mjs <subcommand> ${names.map((n) => `--${n} <${n}>`).join(' ')}`)
    out[key.slice(2)] = argv[i + 1]
  }
  for (const name of names) if (!out[name]) throw new PublicationError(`--${name} is required`)
  return out
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''))
}

async function main(argv) {
  const [subcommand, ...rest] = argv
  const stdout = process.stdout
  switch (subcommand) {
    case 'key': {
      const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli')
      checkSigningKey({ privateKey: process.env.CURIA_STABLE_INDEX_KEY ?? '', publicKeyFile: path.join(cli, STABLE_INDEX_KEY_FILE), stdout })
      return
    }
    case 'image': {
      const { service, reference, commit } = args(rest, ['service', 'reference', 'commit'])
      const plan = await planImage({ service, reference, commit, stdout })
      output({ build: plan.build, digest: plan.digest ?? '' })
      return
    }
    case 'assets': {
      const { version, dist } = args(rest, ['version', 'dist'])
      await attachAssets({ version, dist, stdout })
      return
    }
    case 'release': {
      const { version } = args(rest, ['version'])
      await publishRelease({ version, stdout })
      return
    }
    case 'package': {
      const { version, dist, cli } = args(rest, ['version', 'dist', 'cli'])
      await publishPackage({ version, dist, cli, stdout })
      return
    }
    case 'verify': {
      const { version } = args(rest, ['version'])
      if (!isReleaseVersion(version)) throw new PublicationError(`${version} is not a release version`)
      const report = await verifyPublished({ version, stdout })
      if (!report.ok) throw new PublicationError(report.refusal.message)
      return
    }
    default:
      throw new PublicationError('usage: publish.mjs key | image | assets | release | package | verify')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`publish.mjs: ${e.message}\n`)
    process.exit(1)
  })
}

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

import { Refusal } from './exit.mjs'
import { readArchive, ArchiveError } from './archive.mjs'
import { IMAGE_REGISTRY, RELEASE_IMAGES, imageReference, inspectBundle } from './bundle.mjs'
import { versionPaths } from './root.mjs'

// The release manifest (#870, implementing #849 and #854).
//
// A Curia release is one immutable semantic version. This module is the one
// place that says what identifies it: the manifest that binds the
// `@curia-sh/cli` package version, the SHA-256 of the Compose bundle archive,
// the exact digest of each of the four release images, and the commit and
// workflow that produced them. Nothing in it is a tag, and nothing in it is
// compatibility metadata. A release is whole or it is not a release.
//
// The manifest has two homes, and they must agree. The release workflow
// writes it as `curia-manifest-<version>.json` and attaches it to the GitHub
// release beside the bundle. The publication step (#871) copies the same
// file into the npm package as `manifest.json`, so the package that npm's
// integrity check covers carries the expected checksum and digests of
// everything else the release installs. The bundle is downloaded from the
// release, the package from the registry, and this module proves the two
// halves are one release before anything is activated.
//
// Verification has two doors:
//
//   - `verifyStagedRelease` is what `curia install` (#873), `curia update`
//     (#883), and the bootstrap (#872) run on the downloaded artifacts before
//     activation. It checks the manifest, the version, npm integrity, the
//     bundle checksum, every image digest, and the release asset copy.
//   - `verifyInstalledRelease` is what `curia doctor` (#881) runs on an
//     installed version. It repeats those checks on the retained artifacts,
//     proves the installed files match them, and adds publication
//     provenance: the build attestation of each image and the registry's
//     provenance record for the package.
//
// Both fail closed. A missing, malformed, substituted, or mismatched artifact
// is a failed check, and the report carries a `Refusal` that names every
// failed condition and its corrective action. Everything that reaches the
// network goes through `releaseProbes`, so a test hands in fakes.

export class ManifestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ManifestError'
  }
}

export const MANIFEST_FORMAT = 1
export const PACKAGE_NAME = '@curia-sh/cli'
export const RELEASE_REPOSITORY = 'alp82/curia'
export const RELEASE_WORKFLOW = '.github/workflows/release.yml'

// The manifest's file name inside the npm package, and so at
// `versions/<version>/cli/manifest.json` once installed.
export const MANIFEST_FILE = 'manifest.json'

export const NPM_REGISTRY = 'https://registry.npmjs.org'
export const RELEASE_DOWNLOADS = `https://github.com/${RELEASE_REPOSITORY}/releases/download`

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]+=*$/

export function isReleaseVersion(version) {
  return typeof version === 'string' && RELEASE_VERSION.test(version)
}

// The assets a release publishes, by their file names. The package asset is
// what `npm pack` names the tarball; the registry serves the same bytes.
export function releaseAssets(version) {
  return {
    manifest: `curia-manifest-${version}.json`,
    bundle: `curia-bundle-${version}.tar.gz`,
    checksum: `curia-bundle-${version}.tar.gz.sha256`,
    images: `curia-images-${version}.json`,
    package: `curia-sh-cli-${version}.tgz`,
  }
}

// ---------------------------------------------------------------------------
// The manifest: create, render, parse.

export function createManifest({ version, commit, bundleSha256, digests }) {
  if (!isReleaseVersion(version)) throw new ManifestError(`version must be a release version like 1.2.3, got ${JSON.stringify(version)}`)
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new ManifestError(`commit must be the full 40-hex commit, got ${JSON.stringify(commit)}`)
  if (typeof bundleSha256 !== 'string' || !SHA256_HEX.test(bundleSha256)) throw new ManifestError(`the bundle sha256 must be 64 hex characters, got ${JSON.stringify(bundleSha256)}`)
  const images = {}
  for (const [service, image] of Object.entries(RELEASE_IMAGES)) {
    const digest = digests?.[service]
    if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new ManifestError(`the ${service} image needs a sha256 digest, got ${JSON.stringify(digest)}`)
    images[service] = { name: `${IMAGE_REGISTRY}/${image}`, digest }
  }
  return {
    format: MANIFEST_FORMAT,
    version,
    package: { name: PACKAGE_NAME, version },
    bundle: { name: releaseAssets(version).bundle, sha256: bundleSha256 },
    images,
    source: { repository: RELEASE_REPOSITORY, commit, workflow: RELEASE_WORKFLOW },
  }
}

// The one text form of a manifest: keys in contract order, two-space
// indentation, one trailing newline. Two manifests that say the same thing
// render to the same bytes, which is what lets the release asset and the
// package copy be compared as text.
export function renderManifest(manifest) {
  const m = validate(manifest)
  return `${JSON.stringify(m, null, 2)}\n`
}

export function parseManifest(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new ManifestError(`the manifest is not JSON: ${e.message}`)
  }
  return validate(data)
}

// Returns the manifest in contract key order, or throws a `ManifestError`
// that names the field and the rule. Every key is required, nothing beyond
// the contract is allowed, and every value has one exact shape.
function validate(m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) throw new ManifestError('the manifest must be a JSON object')
  onlyKeys(m, ['format', 'version', 'package', 'bundle', 'images', 'source'], '')
  if (m.format !== MANIFEST_FORMAT) throw new ManifestError(`format must be ${MANIFEST_FORMAT}, got ${JSON.stringify(m.format)}`)
  if (!isReleaseVersion(m.version)) throw new ManifestError(`version must be a release version like 1.2.3, got ${JSON.stringify(m.version)}`)
  const version = m.version

  const pkg = object(m.package, 'package')
  onlyKeys(pkg, ['name', 'version'], 'package.')
  if (pkg.name !== PACKAGE_NAME) throw new ManifestError(`package.name must be ${PACKAGE_NAME}, got ${JSON.stringify(pkg.name)}`)
  if (pkg.version !== version) throw new ManifestError(`package.version must equal version ${version}, got ${JSON.stringify(pkg.version)}`)

  const bundle = object(m.bundle, 'bundle')
  onlyKeys(bundle, ['name', 'sha256'], 'bundle.')
  const bundleName = releaseAssets(version).bundle
  if (bundle.name !== bundleName) throw new ManifestError(`bundle.name must be ${bundleName}, got ${JSON.stringify(bundle.name)}`)
  if (typeof bundle.sha256 !== 'string' || !SHA256_HEX.test(bundle.sha256)) throw new ManifestError(`bundle.sha256 must be 64 hex characters, got ${JSON.stringify(bundle.sha256)}`)

  const images = object(m.images, 'images')
  onlyKeys(images, Object.keys(RELEASE_IMAGES), 'images.')
  const ordered = {}
  for (const [service, image] of Object.entries(RELEASE_IMAGES)) {
    const entry = object(images[service], `images.${service}`)
    onlyKeys(entry, ['name', 'digest'], `images.${service}.`)
    const name = `${IMAGE_REGISTRY}/${image}`
    if (entry.name !== name) throw new ManifestError(`images.${service}.name must be ${name}, got ${JSON.stringify(entry.name)}`)
    if (typeof entry.digest !== 'string' || !DIGEST.test(entry.digest)) throw new ManifestError(`images.${service}.digest must be a sha256 digest, got ${JSON.stringify(entry.digest)}`)
    ordered[service] = { name, digest: entry.digest }
  }

  const source = object(m.source, 'source')
  onlyKeys(source, ['repository', 'commit', 'workflow'], 'source.')
  if (source.repository !== RELEASE_REPOSITORY) throw new ManifestError(`source.repository must be ${RELEASE_REPOSITORY}, got ${JSON.stringify(source.repository)}`)
  if (typeof source.commit !== 'string' || !COMMIT.test(source.commit)) throw new ManifestError(`source.commit must be the full 40-hex commit, got ${JSON.stringify(source.commit)}`)
  if (source.workflow !== RELEASE_WORKFLOW) throw new ManifestError(`source.workflow must be ${RELEASE_WORKFLOW}, got ${JSON.stringify(source.workflow)}`)

  return {
    format: MANIFEST_FORMAT,
    version,
    package: { name: PACKAGE_NAME, version },
    bundle: { name: bundleName, sha256: bundle.sha256 },
    images: ordered,
    source: { repository: RELEASE_REPOSITORY, commit: source.commit, workflow: RELEASE_WORKFLOW },
  }
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ManifestError(`${path} must be an object, got ${JSON.stringify(value)}`)
  return value
}

function onlyKeys(value, allowed, prefix) {
  for (const key of allowed) if (!(key in value)) throw new ManifestError(`${prefix}${key} is missing`)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ManifestError(`${prefix}${key} is not part of the manifest`)
}

// ---------------------------------------------------------------------------
// The checks, in the order the report prints them.

export const RELEASE_CHECKS = Object.freeze([
  Object.freeze({ name: 'manifest', summary: 'The package carries one well-formed release manifest.' }),
  Object.freeze({ name: 'version', summary: 'The manifest and the package name the requested version.' }),
  Object.freeze({ name: 'package integrity', summary: 'The package tarball matches the integrity the npm registry records.' }),
  Object.freeze({ name: 'bundle checksum', summary: 'The bundle archive matches the checksum the manifest binds.' }),
  Object.freeze({ name: 'image digests', summary: 'The bundle names exactly the image digests the manifest binds.' }),
  Object.freeze({ name: 'release manifest', summary: 'The manifest on the GitHub release is the one the package carries.' }),
])

export const PROVENANCE_CHECKS = Object.freeze([
  Object.freeze({ name: 'installed files', summary: 'The installed files are the ones the retained artifacts hold.' }),
  Object.freeze({ name: 'image provenance', summary: 'Each image digest carries a build attestation from the release workflow.' }),
  Object.freeze({ name: 'package provenance', summary: 'The registry records publication provenance for the package version.' }),
])

// ---------------------------------------------------------------------------
// Evaluation: facts in, report out. Pure.
//
// The facts:
//
//   version          the version the caller asked for
//   tarball          the package tarball bytes, or null when missing
//   releaseManifest  the text of the release asset copy, or null when missing
//   package          { integrity, attested, error }: the registry's answer
//   bundle           { archive, checksum, compose? }: the archive bytes, the
//                    `.sha256` text, and (installed) the on-disk compose file
//   installed        (installed only) { manifest, packageJson } texts on disk
//   attestations     (installed only) { <service>: { ok, error } }
//
// A fact that is null is a missing artifact and fails its check. The
// provenance checks run when `installed` is present, so the doctor path
// cannot pass by leaving a fact out.

export function evaluateRelease(facts) {
  const opened = openTarball(facts)
  const checks = [
    manifestCheck(opened),
    versionCheck(facts, opened),
    integrityCheck(facts),
    checksumCheck(facts, opened),
    imagesCheck(facts, opened),
    releaseManifestCheck(facts, opened),
  ]
  if ('installed' in facts) {
    checks.push(installedFilesCheck(facts, opened), imageProvenanceCheck(facts, opened), packageProvenanceCheck(facts))
  }
  const failed = checks.filter((c) => c.status === 'failed')
  const refusal = failed.length === 0 ? null : new Refusal([
    `the release ${facts.version} did not verify, so nothing was activated:`,
    ...failed.map((c) => `  - ${c.name}: ${c.observed} ${c.action}`),
  ].join('\n'))
  return { ok: failed.length === 0, checks, refusal, manifest: opened.manifest }
}

const passed = (name, observed) => ({ name, status: 'passed', observed, action: null })
const failed = (name, observed, action) => ({ name, status: 'failed', observed, action })

const DOWNLOAD_AGAIN = 'Download the release again and run the command again. If it fails the same way, the release is damaged: do not install it, and report it at https://github.com/alp82/curia/issues.'

function short(value) {
  return typeof value === 'string' ? value.slice(0, 12) : String(value)
}

// The tarball opens once; every check that needs the package reads from here.
function openTarball({ tarball, version, installed }) {
  const out = { error: null, files: null, manifest: null, manifestText: null, manifestError: null, packageJson: null, packageJsonText: null }
  if (!tarball) {
    out.error = installed ? `the retained package tarball versions/${version}/cli.tgz is missing.` : 'the package tarball is missing.'
    return out
  }
  try {
    out.files = readArchive(tarball)
  } catch (e) {
    out.error = e instanceof ArchiveError ? `the package tarball is ${e.message}.` : `the package tarball could not be read: ${e.message}.`
    return out
  }
  const manifest = out.files.get(`package/${MANIFEST_FILE}`)
  if (!manifest) {
    out.manifestError = `the package tarball holds no package/${MANIFEST_FILE}.`
  } else {
    out.manifestText = manifest.toString('utf8')
    try {
      out.manifest = parseManifest(out.manifestText)
    } catch (e) {
      out.manifestError = `the embedded manifest is malformed: ${e.message}.`
    }
  }
  const pkg = out.files.get('package/package.json')
  if (pkg) {
    out.packageJsonText = pkg.toString('utf8')
    try { out.packageJson = JSON.parse(out.packageJsonText) } catch { out.packageJson = null }
  }
  return out
}

function manifestCheck(opened) {
  if (opened.error) return failed('manifest', opened.error, DOWNLOAD_AGAIN)
  if (opened.manifestError) return failed('manifest', opened.manifestError, DOWNLOAD_AGAIN)
  const m = opened.manifest
  return passed('manifest', `version ${m.version}, commit ${m.source.commit.slice(0, 7)}`)
}

function versionCheck({ version }, opened) {
  if (!opened.manifest) return failed('version', 'no manifest could be read, so the version cannot be confirmed.', DOWNLOAD_AGAIN)
  const m = opened.manifest
  if (m.version !== version) {
    return failed('version', `the manifest is for version ${m.version}, not the requested ${version}.`, `Download the artifacts of ${version}, or ask for ${m.version}, and run the command again.`)
  }
  const pkg = opened.packageJson
  if (!pkg || typeof pkg !== 'object') return failed('version', 'the package tarball holds no readable package/package.json.', DOWNLOAD_AGAIN)
  if (pkg.name !== PACKAGE_NAME || pkg.version !== version) {
    return failed('version', `package.json names ${pkg.name}@${pkg.version}, not ${PACKAGE_NAME}@${version}.`, DOWNLOAD_AGAIN)
  }
  return passed('version', `${PACKAGE_NAME}@${version}`)
}

function integrityCheck({ tarball, package: pkg }) {
  if (!tarball) return failed('package integrity', 'the package tarball is missing.', DOWNLOAD_AGAIN)
  if (!pkg || pkg.error) {
    return failed('package integrity', `the npm registry did not answer for ${PACKAGE_NAME}: ${pkg?.error ?? 'no answer'}.`, 'Check outbound access to registry.npmjs.org and run the command again.')
  }
  if (typeof pkg.integrity !== 'string' || !SRI_SHA512.test(pkg.integrity)) {
    return failed('package integrity', `the registry records no sha512 integrity for ${PACKAGE_NAME}, got ${JSON.stringify(short(pkg.integrity))}.`, 'Wait for the registry to serve the version with sha512 integrity, or report the release at https://github.com/alp82/curia/issues.')
  }
  const actual = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  if (actual !== pkg.integrity) {
    return failed('package integrity', `the package tarball does not match the integrity the registry records (${short(actual)}… against ${short(pkg.integrity)}…).`, DOWNLOAD_AGAIN)
  }
  return passed('package integrity', `${short(actual)}… matches the registry`)
}

function checksumCheck({ version, bundle }, opened) {
  const archive = bundle?.archive
  const name = releaseAssets(version).bundle
  if (!archive) return failed('bundle checksum', `the bundle archive ${name} is missing.`, DOWNLOAD_AGAIN)
  const actual = createHash('sha256').update(archive).digest('hex')
  if (!opened.manifest) return failed('bundle checksum', `sha256:${short(actual)}… cannot be checked without a manifest.`, DOWNLOAD_AGAIN)
  if (actual !== opened.manifest.bundle.sha256) {
    return failed('bundle checksum', `the bundle archive is sha256:${short(actual)}…, and the manifest binds sha256:${short(opened.manifest.bundle.sha256)}….`, DOWNLOAD_AGAIN)
  }
  const line = typeof bundle.checksum === 'string' ? bundle.checksum.trim() : ''
  const expected = `${actual}  ${name}`
  if (line !== expected) {
    return failed('bundle checksum', `the .sha256 file says ${JSON.stringify(line.slice(0, 40))}…, not the archive's checksum for ${name}.`, DOWNLOAD_AGAIN)
  }
  return passed('bundle checksum', `sha256:${short(actual)}… matches the manifest`)
}

const IMAGE_LINE = /^\s*image:\s*(\S+)\s*$/

// The bundle archive holds one file, `curia-bundle-<v>/compose.yaml`, and its
// `image:` lines are exactly the manifest's references. Returns the compose
// text when it does, so the installed-files check can compare it.
function bundleCompose({ version, bundle }, opened) {
  const archive = bundle?.archive
  if (!archive) return { problem: `the bundle archive ${releaseAssets(version).bundle} is missing.` }
  let files
  try {
    files = readArchive(archive)
  } catch (e) {
    return { problem: `the bundle archive is ${e.message}.` }
  }
  const path = `curia-bundle-${version}/compose.yaml`
  const names = [...files.keys()]
  const extra = names.filter((n) => n !== path)
  if (!files.has(path)) return { problem: `the bundle archive holds no ${path} (found ${names.join(', ') || 'nothing'}).` }
  if (extra.length) return { problem: `the bundle archive holds more than the compose file: ${extra.join(', ')}.` }
  const compose = files.get(path).toString('utf8')
  const problems = inspectBundle(compose)
  if (problems.length) return { problem: `the bundle is not one Curia publishes: ${problems[0]}.` }
  if (!opened.manifest) return { problem: 'no manifest could be read, so the image digests cannot be confirmed.' }
  const expected = new Map(Object.entries(opened.manifest.images).map(([service, { digest }]) => [imageReference(service, digest), service]))
  const found = new Set()
  for (const line of compose.split('\n')) {
    const image = IMAGE_LINE.exec(line)
    if (!image) continue
    if (!expected.has(image[1])) return { problem: `the bundle names ${image[1]}, which the manifest does not bind.` }
    found.add(image[1])
  }
  const missing = [...expected].filter(([ref]) => !found.has(ref))
  if (missing.length) {
    return { problem: `the bundle does not name the ${missing.map(([, s]) => s).join(', ')} image the manifest binds (${missing.map(([ref]) => short(ref.split('@sha256:')[1])).join(', ')}…).` }
  }
  return { compose }
}

function imagesCheck(facts, opened) {
  const { problem } = bundleCompose(facts, opened)
  if (problem) return failed('image digests', problem, DOWNLOAD_AGAIN)
  return passed('image digests', `${Object.keys(RELEASE_IMAGES).length} images by digest`)
}

function releaseManifestCheck({ version, releaseManifest }, opened) {
  const asset = releaseAssets(version).manifest
  if (releaseManifest === null || releaseManifest === undefined) {
    return failed('release manifest', `${asset} was not downloaded from the GitHub release.`, `Check outbound access to github.com and that the release v${version} carries ${asset}, then run the command again.`)
  }
  let parsed
  try {
    parsed = parseManifest(releaseManifest)
  } catch (e) {
    return failed('release manifest', `${asset} is malformed: ${e.message}.`, DOWNLOAD_AGAIN)
  }
  if (!opened.manifest) return failed('release manifest', `${asset} cannot be compared without the package manifest.`, DOWNLOAD_AGAIN)
  if (renderManifest(parsed) !== renderManifest(opened.manifest)) {
    return failed('release manifest', `${asset} differs from the manifest the package carries.`, `Do not install: the release and the package disagree. Report it at https://github.com/alp82/curia/issues.`)
  }
  return passed('release manifest', `${asset} matches the package`)
}

function installedFilesCheck(facts, opened) {
  const { installed, bundle } = facts
  const drift = []
  const compare = (label, onDisk, retained) => {
    if (onDisk === null || onDisk === undefined) drift.push(`${label} is missing`)
    else if (retained === null || retained === undefined) drift.push(`${label} has nothing retained to compare with`)
    else if (onDisk !== retained) drift.push(`${label} differs from the retained artifact`)
  }
  compare(`cli/${MANIFEST_FILE}`, installed?.manifest, opened.manifestText)
  compare('cli/package.json', installed?.packageJson, opened.packageJsonText)
  const { compose } = bundleCompose(facts, opened)
  compare('bundle/compose.yaml', bundle?.compose, compose)
  if (drift.length) {
    return failed('installed files', `${drift.join('; ')}.`, `Run 'curia reinstall' to restore version ${facts.version} from the release, or 'curia update' to a newer one.`)
  }
  return passed('installed files', 'the manifest, package.json, and compose.yaml match the retained artifacts')
}

export function attestationCommand(reference, { commit }) {
  return `gh attestation verify oci://${reference} --repo ${RELEASE_REPOSITORY} --signer-workflow ${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW} --source-digest ${commit}`
}

function imageProvenanceCheck({ attestations }, opened) {
  if (!opened.manifest) return failed('image provenance', 'no manifest could be read, so no image can be attested.', DOWNLOAD_AGAIN)
  const bad = []
  for (const [service, { digest }] of Object.entries(opened.manifest.images)) {
    const result = attestations?.[service]
    if (!result || !result.ok) bad.push({ service, reference: imageReference(service, digest), error: firstLine(result?.error) || 'no answer' })
  }
  if (bad.length) {
    const first = bad[0]
    return failed('image provenance', `${bad.map((b) => `${b.service}: ${b.error}`).join('; ')}.`, `Run '${attestationCommand(first.reference, opened.manifest.source)}' to see the full answer. If gh is not logged in, run 'gh auth login' first.`)
  }
  return passed('image provenance', `${Object.keys(opened.manifest.images).length} images attested by ${RELEASE_REPOSITORY} ${RELEASE_WORKFLOW} at ${opened.manifest.source.commit.slice(0, 7)}`)
}

function packageProvenanceCheck({ version, package: pkg }) {
  if (!pkg || pkg.error) {
    return failed('package provenance', `the npm registry did not answer for ${PACKAGE_NAME}: ${pkg?.error ?? 'no answer'}.`, 'Check outbound access to registry.npmjs.org and run the command again.')
  }
  if (pkg.attested !== true) {
    return failed('package provenance', `the registry records no provenance for ${PACKAGE_NAME}@${version}.`, `Run 'npm audit signatures' against an install of ${PACKAGE_NAME}@${version} to see the registry's answer, and report a stable release without provenance at https://github.com/alp82/curia/issues.`)
  }
  return passed('package provenance', `the registry records provenance for ${PACKAGE_NAME}@${version}`)
}

function firstLine(text) {
  return typeof text === 'string' ? text.split('\n')[0].trim() : ''
}

// ---------------------------------------------------------------------------
// Rendering.

const STATUS_WORD = { passed: 'ok', failed: 'failed' }

export function renderVerification(report) {
  const width = Math.max(...report.checks.map((c) => c.name.length))
  const lines = []
  for (const c of report.checks) {
    lines.push(`${STATUS_WORD[c.status].padEnd(8)} ${c.name.padEnd(width)}  ${c.observed}`)
    if (c.action) lines.push(`${''.padEnd(9 + width + 2)}${c.action}`)
  }
  const failedCount = report.checks.filter((c) => c.status === 'failed').length
  const passedCount = report.checks.length - failedCount
  const summary = [`${passedCount} checks passed`]
  if (failedCount > 0) summary.push(`failed: ${failedCount} condition${failedCount === 1 ? '' : 's'}`)
  lines.push(summary.join(', ') + '.')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Gathering: the network and the disk in, the facts out.

// The real probes. Each is one network boundary: the npm registry, the GitHub
// release, and `gh attestation verify` against the registry and GitHub.
export const releaseProbes = Object.freeze({
  packument: async (name, version) => {
    try {
      const response = await fetch(`${NPM_REGISTRY}/${name}/${version}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) return { error: `HTTP ${response.status}` }
      const data = await response.json()
      return { integrity: data?.dist?.integrity ?? null, attested: Boolean(data?.dist?.attestations) }
    } catch (e) {
      return { error: e.cause?.message ?? e.message }
    }
  },
  releaseManifest: async (version) => {
    try {
      const response = await fetch(`${RELEASE_DOWNLOADS}/v${version}/${releaseAssets(version).manifest}`, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) return null
      return await response.text()
    } catch {
      return null
    }
  },
  attestation: ({ reference, commit }) => new Promise((resolve) => {
    const [, ...args] = attestationCommand(reference, { commit }).split(' ')
    execFile('gh', [...args, '--format', 'json'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true })
      resolve({ ok: false, error: error.code === 'ENOENT' ? 'gh is not installed' : (stderr || error.message) })
    })
  }),
})

// What `curia install`, `curia update`, and the bootstrap hand in after the
// downloads: the package tarball, the bundle archive, and the `.sha256`
// text, each null when the download did not produce it.
async function gatherStagedRelease({ version, tarball, archive, checksum }, probes) {
  const [pkg, releaseManifest] = await Promise.all([
    probes.packument(PACKAGE_NAME, version),
    probes.releaseManifest(version),
  ])
  return {
    version,
    tarball: tarball ?? null,
    releaseManifest: releaseManifest ?? null,
    package: { integrity: pkg?.integrity ?? null, attested: pkg?.attested ?? null, error: pkg?.error ?? null },
    bundle: { archive: archive ?? null, checksum: checksum ?? null },
  }
}

function readOrNull(path, encoding) {
  try {
    return readFileSync(path, encoding)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

// The installed version's retained artifacts and installed files, plus the
// provenance answers for the manifest they hold.
async function gatherInstalledRelease({ root, version }, probes) {
  const paths = versionPaths(root, version)
  const tarball = readOrNull(paths.package)
  const staged = await gatherStagedRelease({ version, tarball, archive: readOrNull(paths.bundleArchive), checksum: readOrNull(paths.bundleChecksum, 'utf8') }, probes)
  const facts = {
    ...staged,
    bundle: { ...staged.bundle, compose: readOrNull(paths.bundle, 'utf8') },
    installed: { manifest: readOrNull(paths.manifest, 'utf8'), packageJson: readOrNull(`${paths.dir}/cli/package.json`, 'utf8') },
    attestations: {},
  }
  const opened = openTarball(facts)
  if (opened.manifest) {
    const results = await Promise.all(Object.entries(opened.manifest.images).map(async ([service, { digest }]) => [
      service,
      await probes.attestation({ reference: imageReference(service, digest), commit: opened.manifest.source.commit, version }),
    ]))
    facts.attestations = Object.fromEntries(results)
  }
  return facts
}

// The install-time door: verify the staged artifacts of `version`, print the
// report on `stdout`, and return it. The caller throws `report.refusal` when
// `ok` is false and unpacks the artifacts when it is true.
export async function verifyStagedRelease(stage, { stdout }, probes = releaseProbes) {
  const report = evaluateRelease(await gatherStagedRelease(stage, probes))
  stdout.write(renderVerification(report))
  return report
}

// The doctor door: verify the installed `version` under `root` with full
// publication provenance, print the report, and return it. Read-only.
export async function verifyInstalledRelease({ root, version, stdout }, probes = releaseProbes) {
  const report = evaluateRelease(await gatherInstalledRelease({ root, version }, probes))
  stdout.write(renderVerification(report))
  return report
}

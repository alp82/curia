import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { Refusal } from './exit.mjs'
import { RELEASE_REPOSITORY, isReleaseVersion } from './manifest.mjs'

// The stable-release index and release selection (#871, implementing #849
// and #854).
//
// Every published Curia release is immutable and stays published. Which one
// an installation should run is a separate, mutable fact, and this module is
// the one place that says how that fact is published, proven, and read:
//
//   - The index is one small signed file, `release/stable.json` on the `main`
//     branch of alp82/curia, served raw from GitHub. It names the recommended
//     stable release and the versions that were withdrawn. It never restates
//     a manifest: a version is a name here, and the release manifest is what
//     says what the version is made of.
//   - The index is signed with one Ed25519 key. The private key lives only in
//     the repository secret the promotion workflow reads; the public key ships
//     inside this package as `stable-index.pub`, so an installed version
//     trusts the key that the package it verified carries, and nothing else.
//     A host needs no `gh` login and no extra tool to verify it.
//   - `promote` and `withdraw` are the only two transitions. Each one changes
//     selection metadata and nothing else: no artifact is rebuilt, replaced,
//     or deleted. The sequence number rises on every change, so a consumer
//     that remembers the last sequence it accepted can refuse an older index.
//   - `selectRelease` is the one selection rule. With nothing requested it
//     picks the stable release. An exact version is honored as asked. A
//     prerelease is selected only with the explicit `--prerelease` request,
//     and a withdrawn version is never selected.
//
// `curia update` (#883) calls `fetchStableIndex` and `selectRelease`; the
// service's daily check and the Curia app read the same index through the
// same functions; the bootstrap (#872) reads the same file. Every read of
// the network goes through `stableProbes`, so a test hands in a fake.

export class StableIndexError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StableIndexError'
  }
}

export const STABLE_INDEX_FORMAT = 1
export const STABLE_INDEX_PATH = 'release/stable.json'
export const STABLE_INDEX_URL = `https://raw.githubusercontent.com/${RELEASE_REPOSITORY}/main/${STABLE_INDEX_PATH}`

// The public key's file name inside the package, beside package.json.
export const STABLE_INDEX_KEY_FILE = 'stable-index.pub'

const SIGNATURE_ALGORITHM = 'ed25519'
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export function isPrerelease(version) {
  return isReleaseVersion(version) && version.includes('-')
}

export function releaseNotesUrl(version) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`
}

// ---------------------------------------------------------------------------
// The index: create, render, parse.

export function createStableIndex({ sequence = 0, updated, stable = null, withdrawn = [] } = {}) {
  return validate({ format: STABLE_INDEX_FORMAT, sequence, updated, stable, withdrawn })
}

// The one text form: keys in contract order, the withdrawn list sorted, two-
// space indentation, one trailing newline. This is what the signature covers.
export function renderStableIndex(index) {
  return `${JSON.stringify(validate(index), null, 2)}\n`
}

export function parseStableIndex(text) {
  return validate(json(text, 'the index'))
}

function json(text, what) {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new StableIndexError(`${what} is not JSON: ${e.message}`)
  }
}

function validate(i) {
  if (i === null || typeof i !== 'object' || Array.isArray(i)) throw new StableIndexError('the index must be a JSON object')
  if (i.format !== STABLE_INDEX_FORMAT) throw new StableIndexError(`format must be ${STABLE_INDEX_FORMAT}, got ${JSON.stringify(i.format)}`)
  onlyKeys(i, ['format', 'sequence', 'updated', 'stable', 'withdrawn'], 'the index')
  if (!Number.isInteger(i.sequence) || i.sequence < 0) throw new StableIndexError(`sequence must be a nonnegative integer, got ${JSON.stringify(i.sequence)}`)
  if (typeof i.updated !== 'string' || !TIMESTAMP.test(i.updated) || Number.isNaN(Date.parse(i.updated))) {
    throw new StableIndexError(`updated must be an ISO 8601 UTC timestamp like 2026-09-02T10:00:00Z, got ${JSON.stringify(i.updated)}`)
  }
  if (!Array.isArray(i.withdrawn)) throw new StableIndexError(`withdrawn must be an array of versions, got ${JSON.stringify(i.withdrawn)}`)
  i.withdrawn.forEach((v, n) => {
    if (!isReleaseVersion(v)) throw new StableIndexError(`withdrawn[${n}] must be a release version like 1.2.3, got ${JSON.stringify(v)}`)
  })
  const withdrawn = [...new Set(i.withdrawn)].sort(compareVersions)
  if (i.stable !== null) {
    if (!isReleaseVersion(i.stable)) throw new StableIndexError(`stable must be a release version like 1.2.3 or null, got ${JSON.stringify(i.stable)}`)
    if (isPrerelease(i.stable)) throw new StableIndexError(`stable must not be a prerelease, got ${i.stable}`)
    if (withdrawn.includes(i.stable)) throw new StableIndexError(`stable ${i.stable} is withdrawn, and a withdrawn version is never the stable release`)
  }
  return { format: STABLE_INDEX_FORMAT, sequence: i.sequence, updated: i.updated, stable: i.stable, withdrawn }
}

function onlyKeys(value, allowed, what) {
  for (const key of allowed) if (!(key in value)) throw new StableIndexError(`${key} is missing from ${what}`)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new StableIndexError(`${key} is not part of ${what}`)
}

// Numeric order on the three parts, then a prerelease before its release,
// then the prerelease suffixes as text. Enough to keep the list readable.
function compareVersions(a, b) {
  const [ac, as = null] = a.split('-', 2)
  const [bc, bs = null] = b.split('-', 2)
  const an = ac.split('.').map(Number)
  const bn = bc.split('.').map(Number)
  for (let n = 0; n < 3; n += 1) if (an[n] !== bn[n]) return an[n] - bn[n]
  if (as === bs) return 0
  if (as === null) return 1
  if (bs === null) return -1
  return as < bs ? -1 : 1
}

// ---------------------------------------------------------------------------
// The key and the signature.

// The pinned key's short name: the first 16 hex characters of the SHA-256 of
// the public key's DER form. A signature names the key it was made with, so
// a mismatch says which key each side holds instead of only "invalid".
export function keyFingerprint(publicKey) {
  const key = typeof publicKey === 'object' && publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  const der = key.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

// One Ed25519 pair in PEM form. `deploy/release/keygen.mjs` calls this once,
// commits the public key into the package, and hands the private key to the
// repository secret without writing it anywhere else.
export function generateStableIndexKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
  return { publicKey: publicPem, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint: keyFingerprint(publicPem) }
}

// The signed file: the index and its signature over the canonical index
// text. Deterministic, so signing the same index twice writes the same file.
export function signStableIndex(index, privateKey) {
  const canonical = renderStableIndex(index)
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) throw new StableIndexError(`the signing key must be ${SIGNATURE_ALGORITHM}, got ${key.asymmetricKeyType}`)
  const value = sign(null, Buffer.from(canonical), key).toString('base64')
  const envelope = { index: JSON.parse(canonical), signature: { algorithm: SIGNATURE_ALGORITHM, key: keyFingerprint(createPublicKey(key)), value } }
  return `${JSON.stringify(envelope, null, 2)}\n`
}

// Returns the index when the file's signature verifies against `publicKey`,
// and throws a `StableIndexError` that says why otherwise. Nothing passes by
// absence: no pinned key, no signature, another key, or a changed byte all
// fail.
export function verifyStableIndex(text, { publicKey }) {
  if (!publicKey) throw new StableIndexError('no stable-index public key is pinned in this version, so no index can be trusted')
  const envelope = json(text, 'the stable-release index')
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) throw new StableIndexError('the stable-release index must be a JSON object')
  if (!('index' in envelope)) throw new StableIndexError('the stable-release index signature is missing: the file is a bare index, not a signed one')
  const index = validate(envelope.index)
  const signature = envelope.signature
  if (signature === null || signature === undefined) throw new StableIndexError('the stable-release index signature is missing')
  if (typeof signature !== 'object' || Array.isArray(signature)) throw new StableIndexError('the stable-release index signature must be an object')
  if (signature.algorithm !== SIGNATURE_ALGORITHM) throw new StableIndexError(`signature.algorithm must be ${SIGNATURE_ALGORITHM}, got ${JSON.stringify(signature.algorithm)}`)
  const pinned = keyFingerprint(publicKey)
  if (signature.key !== pinned) throw new StableIndexError(`the stable-release index is signed with key ${signature.key}, and this version pins key ${pinned}. Update the lifecycle interface to a version that pins the current key.`)
  if (typeof signature.value !== 'string') throw new StableIndexError('signature.value must be a base64 string')
  const ok = verify(null, Buffer.from(renderStableIndex(index)), createPublicKey(publicKey), Buffer.from(signature.value, 'base64'))
  if (!ok) throw new StableIndexError(`the stable-release index signature does not verify against key ${pinned}. The file was changed after it was signed: do not trust it, and report it at https://github.com/${RELEASE_REPOSITORY}/issues.`)
  return index
}

// The public key this package ships, or null when the file is absent or empty.
export function pinnedPublicKey(file = new URL(`../${STABLE_INDEX_KEY_FILE}`, import.meta.url)) {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return text ? `${text}\n` : null
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

// ---------------------------------------------------------------------------
// The two transitions. Pure: index in, index out, the input untouched.

function releaseVersion(version) {
  if (!isReleaseVersion(version)) throw new Refusal(`${version} is not a release version like 1.2.3.`)
  return version
}

function next(index, changes, { updated }) {
  return validate({ ...index, ...changes, sequence: index.sequence + 1, updated })
}

export function promote(index, version, { updated }) {
  const current = validate(index)
  releaseVersion(version)
  if (isPrerelease(version)) throw new Refusal(`${version} is a prerelease, and a prerelease is never the stable release. Publish it as a release version first.`)
  if (current.withdrawn.includes(version)) throw new Refusal(`${version} is withdrawn. A withdrawn version is never promoted; publish a fixed release and promote that.`)
  if (current.stable === version) return current
  return next(current, { stable: version }, { updated })
}

export function withdraw(index, version, { updated }) {
  const current = validate(index)
  releaseVersion(version)
  if (current.withdrawn.includes(version)) return current
  return next(current, {
    stable: current.stable === version ? null : current.stable,
    withdrawn: [...current.withdrawn, version],
  }, { updated })
}

// ---------------------------------------------------------------------------
// Selection.

// The one rule. Returns `{ version, selection }` with `selection` one of
// `stable`, `exact`, or `prerelease`, or throws a `Refusal` that names the
// condition. It decides from the index alone; whether the version's
// artifacts exist and verify is the release verification's question, asked
// after selection.
export function selectRelease(index, { requested = null, prerelease = false } = {}) {
  const current = validate(index)
  if (requested === null) {
    if (prerelease) throw new Refusal('--prerelease needs an exact version, such as 1.3.0-rc.1. Without it, Curia selects the stable release.')
    if (current.stable === null) throw new Refusal('no stable release is recommended right now. Ask for an exact version, or wait for the next stable release.')
    return { version: current.stable, selection: 'stable' }
  }
  if (!isReleaseVersion(requested)) throw new Refusal(`${requested} is not a release version like 1.2.3.`)
  if (current.withdrawn.includes(requested)) {
    throw new Refusal(`${requested} is withdrawn: the release notes at ${releaseNotesUrl(requested)} say why. Choose another version, or run the command without a version for the stable release.`)
  }
  if (isPrerelease(requested)) {
    if (!prerelease) throw new Refusal(`${requested} is a prerelease. A prerelease is never selected by accident: to install it anyway, add --prerelease.`)
    return { version: requested, selection: 'prerelease' }
  }
  if (prerelease) throw new Refusal(`${requested} is not a prerelease. Run the command without --prerelease.`)
  return { version: requested, selection: 'exact' }
}

// The command-line shape `curia update` gives selection: one optional exact
// version and one optional `--prerelease`. A `StableIndexError` here is a
// usage error for the caller to report as such.
export function selectionFromArgs(args) {
  let requested = null
  let prerelease = false
  for (const arg of args) {
    if (arg === '--prerelease') prerelease = true
    else if (arg.startsWith('-')) throw new StableIndexError(`unknown option: ${arg}`)
    else if (requested !== null) throw new StableIndexError(`one version at most, got ${requested} and ${arg}`)
    else requested = arg
  }
  return { requested, prerelease }
}

const SELECTION_WORDS = {
  stable: 'the stable release',
  exact: 'the exact version requested',
  prerelease: 'the exact prerelease requested',
}

export function renderSelection({ version, selection }) {
  return `selected ${version}, ${SELECTION_WORDS[selection]}\n`
}

// ---------------------------------------------------------------------------
// Fetching.

// The one network boundary: the raw file on the main branch. Null when it
// does not download, for whatever reason; the caller reports that as a failed
// check and never as an empty index.
export const stableProbes = Object.freeze({
  stableIndex: async () => {
    try {
      const response = await fetch(STABLE_INDEX_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) return null
      return await response.text()
    } catch {
      return null
    }
  },
})

function renderIndexLine(index) {
  const withdrawn = index.withdrawn.length ? `withdrawn ${index.withdrawn.join(', ')}` : 'nothing withdrawn'
  return `stable-release index: sequence ${index.sequence}, stable ${index.stable ?? 'none'}, ${withdrawn}\n`
}

// Downloads the index, verifies it against the pinned key, prints one line,
// and returns `{ ok, index, error }`. A failed fetch carries the reason and no
// index, so a caller cannot select from a file that did not verify.
export async function fetchStableIndex({ stdout, publicKey = pinnedPublicKey() }, probes = stableProbes) {
  let result
  try {
    const text = await probes.stableIndex()
    if (text === null || text === undefined) throw new StableIndexError(`the stable-release index could not be downloaded from ${STABLE_INDEX_URL}. Check outbound access to raw.githubusercontent.com and run the command again.`)
    result = { ok: true, index: verifyStableIndex(text, { publicKey }), error: null }
  } catch (e) {
    if (!(e instanceof StableIndexError)) throw e
    result = { ok: false, index: null, error: e.message }
  }
  stdout.write(result.ok ? renderIndexLine(result.index) : `stable-release index: failed. ${result.error}\n`)
  return result
}

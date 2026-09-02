import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Refusal } from './exit.mjs'
import { extractArchive, ArchiveError } from './archive.mjs'
import { NPM_REGISTRY, PACKAGE_NAME, RELEASE_DOWNLOADS, parseManifest, releaseAssets } from './manifest.mjs'

// Acquiring one release into a stage (#883, the bootstrap's download and
// proof steps in the lifecycle interface's own code).
//
// `deploy/bootstrap/curia-install.sh` downloads a release with curl and
// proves it in the shell before any of the package runs. `curia update`
// already runs as the installed interface, so it does the same work here,
// from the same origins, in the same order, with the same proofs:
//
//   1. the registry record and the tarball of `@curia-sh/cli@<version>`,
//      the tarball proven by SHA-512 against the record's `dist.integrity`,
//      unpacked as `cli/`, its `package.json` naming the version;
//   2. the pinned Node.js runtime (`curia.node` in that `package.json`) from
//      nodejs.org with its `SHASUMS256.txt`, proven by SHA-256, unpacked as
//      `node/`, and `node/bin/node --version` reporting the pin;
//   3. the release manifest, the Compose bundle, and its `.sha256` from the
//      GitHub release, the bundle proven against the `.sha256` file and the
//      manifest, the manifest naming the version.
//
// What the stage holds afterwards is what the bootstrap hands `curia
// install`: `node/`, `cli/`, `cli.tgz`, `bundle.tar.gz`, and
// `bundle.tar.gz.sha256`, the seven files `STAGE_FILES` names. The release
// door (`verifyStagedRelease`) is still asked after this, by `placeVersion`;
// these proofs are what makes it safe to unpack and run the staged code at
// all. Every download and the runtime's version check go through
// `acquireProbes`, so a test hands in files instead of a network.

export const NODE_DIST = 'https://nodejs.org/dist'

// The one command that installs Curia on a host, or reinstalls it over a
// preserved root: the bootstrap, downloaded to a file and run. `--purge`
// makes it the purge command; `--root <dir>` names a nondefault root.
export const BOOTSTRAP_COMMAND = 'curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh'

// One download at a time, with the time a 60 MB runtime may take on a slow
// link. `null` bytes with a status or an error, never a partial file.
export const acquireProbes = Object.freeze({
  download: async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
      if (!response.ok) return { ok: false, status: response.status }
      return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) }
    } catch (e) {
      return { ok: false, error: e.cause?.message ?? e.message }
    }
  },
  nodeVersion: (binary) => new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 30_000 }, (error, stdout) => resolve(error ? null : stdout.trim()))
  }),
})

// The URLs one version's artifacts are read from.
export function releaseUrls(version) {
  const bare = PACKAGE_NAME.split('/')[1]
  const assets = releaseAssets(version)
  return {
    packument: `${NPM_REGISTRY}/${PACKAGE_NAME}/${version}`,
    tarball: `${NPM_REGISTRY}/${PACKAGE_NAME}/-/${bare}-${version}.tgz`,
    manifest: `${RELEASE_DOWNLOADS}/v${version}/${assets.manifest}`,
    bundle: `${RELEASE_DOWNLOADS}/v${version}/${assets.bundle}`,
    checksum: `${RELEASE_DOWNLOADS}/v${version}/${assets.checksum}`,
  }
}

export function runtimeUrls(nodeVersion) {
  const name = `node-v${nodeVersion}-linux-x64`
  return {
    name: `${name}.tar.gz`,
    checksums: `${NODE_DIST}/v${nodeVersion}/SHASUMS256.txt`,
    archive: `${NODE_DIST}/v${nodeVersion}/${name}.tar.gz`,
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('hex')

// Downloads and proves one version into `stage`, an existing empty
// directory. Prints one line per artifact. Returns `{ version, node }`.
// Throws a `Refusal` that names the artifact and one action when a download
// or a proof fails; the caller removes the stage.
export async function acquireRelease({ version, stage, stdout }, probes = acquireProbes) {
  const say = (text) => stdout.write(`${text}\n`)
  const get = async (url, what) => {
    const got = await probes.download(url)
    if (got?.ok) return got.bytes
    if (got?.status === 404) throw new Refusal(`${what} is not at ${url}. Check that the version is published, and run the command again.`)
    throw new Refusal(`could not download ${what} from ${url} (${got?.error ?? `HTTP ${got?.status}`}). Check outbound access and run the command again.`)
  }
  const urls = releaseUrls(version)

  // 1. The package.
  const packument = json(await get(urls.packument, `the registry record of ${PACKAGE_NAME}@${version}`), 'the registry record')
  const integrity = packument?.dist?.integrity
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Refusal(`the registry records no sha512 integrity for ${PACKAGE_NAME}@${version}, so the package cannot be proven. Report it at https://github.com/alp82/curia/issues.`)
  }
  const tarball = await get(urls.tarball, `the package ${PACKAGE_NAME}@${version}`)
  if (sha512(tarball) !== Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')) {
    throw new Refusal(`package integrity: the downloaded ${PACKAGE_NAME}@${version} does not have the SHA-512 the registry records. The tarball was substituted or damaged in transit: do not use it, and run the command again.`)
  }
  writeFileSync(join(stage, 'cli.tgz'), tarball)
  mkdirSync(join(stage, 'cli'))
  unpack(tarball, join(stage, 'cli'), `the package ${PACKAGE_NAME}@${version}`)
  const packageFile = join(stage, 'cli', 'package.json')
  if (!existsSync(packageFile)) throw new Refusal(`the package ${PACKAGE_NAME}@${version} carries no package.json.`)
  const packageJson = json(readFileSync(packageFile), 'the package.json of the package')
  if (packageJson.version !== version) {
    throw new Refusal(`version mismatch: the package names version ${packageJson.version}, and ${version} was selected.`)
  }
  const nodeVersion = packageJson.curia?.node
  if (typeof nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    throw new Refusal(`the package ${PACKAGE_NAME}@${version} pins no Node.js runtime (curia.node in its package.json), so its runtime cannot be staged.`)
  }
  say(`${PACKAGE_NAME}@${version} downloaded and proven against the registry's integrity record`)

  // 2. The runtime.
  const runtime = runtimeUrls(nodeVersion)
  const checksums = (await get(runtime.checksums, `the checksums of Node.js v${nodeVersion}`)).toString('utf8')
  const expected = checksums.split('\n').map((l) => l.trim().split(/\s+/)).find((f) => f[1] === runtime.name)?.[0]
  if (!expected) throw new Refusal(`SHASUMS256.txt does not list ${runtime.name}, so Node.js v${nodeVersion} cannot be proven.`)
  const nodeArchive = await get(runtime.archive, `Node.js v${nodeVersion}`)
  if (sha256(nodeArchive) !== expected) {
    throw new Refusal(`Node.js v${nodeVersion} checksum: the downloaded ${runtime.name} does not have the SHA-256 that SHASUMS256.txt lists. The runtime was substituted or damaged in transit: do not use it, and run the command again.`)
  }
  mkdirSync(join(stage, 'node'))
  unpack(nodeArchive, join(stage, 'node'), `Node.js v${nodeVersion}`)
  const binary = join(stage, 'node', 'bin', 'node')
  if (!existsSync(binary)) throw new Refusal(`Node.js v${nodeVersion} has no bin/node.`)
  const reported = await probes.nodeVersion(binary)
  if (reported === null) {
    throw new Refusal(`the staged Node.js at ${binary} does not run. If the installation root's filesystem is mounted noexec, move the root to one that allows execution and run the command again.`)
  }
  if (reported !== `v${nodeVersion}`) {
    throw new Refusal(`the staged Node.js reports ${reported}, not v${nodeVersion}, which the package pins.`)
  }
  say(`Node.js ${reported} downloaded and proven against SHASUMS256.txt`)

  // 3. The bundle and the manifest.
  const manifestText = (await get(urls.manifest, releaseAssets(version).manifest)).toString('utf8')
  const bundle = await get(urls.bundle, releaseAssets(version).bundle)
  const checksum = (await get(urls.checksum, releaseAssets(version).checksum)).toString('utf8')
  const actual = sha256(bundle)
  if (checksum.trim().split(/\s+/)[0] !== actual) {
    throw new Refusal(`bundle checksum: ${releaseAssets(version).bundle} does not have the SHA-256 its .sha256 file names. The bundle was substituted or damaged in transit: do not use it, and run the command again.`)
  }
  let manifest
  try {
    manifest = parseManifest(manifestText)
  } catch (e) {
    throw new Refusal(`the release manifest of ${version} cannot be read: ${e.message}`)
  }
  if (manifest.bundle.sha256 !== actual) {
    throw new Refusal(`bundle checksum: ${releaseAssets(version).bundle} does not have the SHA-256 the release manifest binds. The bundle was substituted or damaged in transit: do not use it, and run the command again.`)
  }
  if (manifest.version !== version) {
    throw new Refusal(`version mismatch: the release manifest is for version ${manifest.version}, and ${version} was selected.`)
  }
  writeFileSync(join(stage, 'bundle.tar.gz'), bundle)
  writeFileSync(join(stage, 'bundle.tar.gz.sha256'), checksum)
  say(`the Compose bundle of ${version} downloaded and proven against its checksum and the release manifest`)

  return { version, node: nodeVersion }
}

function json(bytes, what) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (e) {
    throw new Refusal(`${what} is not JSON: ${e.message}`)
  }
}

function unpack(bytes, dir, what) {
  try {
    extractArchive(bytes, dir, { strip: 1 })
  } catch (e) {
    if (e instanceof ArchiveError) throw new Refusal(`${what} is not a gzipped tar archive: ${e.message}`)
    throw e
  }
}

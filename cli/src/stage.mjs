import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Refusal } from './exit.mjs'
import { readArchive } from './archive.mjs'
import { verifyStagedRelease } from './manifest.mjs'
import { versionPaths } from './root.mjs'

// How one release lands under versions/<version>/ (#873, lifted for #883).
//
// A stage is a directory that holds the seven files a complete version is
// made of: the unpacked runtime, the unpacked package, and the three retained
// artifacts the doctor re-verifies. The bootstrap builds one in a temporary
// directory for `curia install`; `curia update` builds one itself from the
// network. Either way `placeVersion` is the one door from a stage to an
// installed version: the artifacts are verified against the release
// manifest, copied into a sibling of the version directory, made read-only,
// and renamed into place, so `versions/<version>/` is either absent, the
// previous complete one, or the new complete one, never half of one.

export const STAGE_FILES = Object.freeze(['node/bin/node', 'cli/bin/curia.mjs', 'cli/package.json', 'cli/manifest.json', 'cli.tgz', 'bundle.tar.gz', 'bundle.tar.gz.sha256'])

// Whether `dir` holds every file of a complete version.
export function isCompleteStage(dir) {
  return STAGE_FILES.every((f) => existsSync(join(dir, f)))
}

// The version the staged package names.
export function stagedVersion(stage) {
  return JSON.parse(readFileSync(join(stage, 'cli', 'package.json'), 'utf8')).version
}

// Verifies the stage and lands it as versions/<version>/, replacing that
// directory if it was there. Returns the version's paths.
export async function placeVersion({ root, version, stage, stdout }, release) {
  for (const f of STAGE_FILES) {
    if (!existsSync(join(stage, f))) throw new Refusal(`the stage ${stage} lacks ${f}. Run the command again; it downloads a complete stage.`)
  }
  const staged = stagedVersion(stage)
  if (staged !== version) {
    throw new Refusal(`the stage holds @curia-sh/cli ${staged}, but ${version} was selected. Run the command again so it stages one version end to end.`)
  }
  stdout.write(`verifying the staged release ${version}\n`)
  await verifyRetained({ version, dir: stage, stdout }, release)

  const paths = versionPaths(root, version)
  const compose = composeFrom(readFileSync(join(stage, 'bundle.tar.gz')), version)
  const staging = join(root, 'versions', `.${version}.${process.pid}.staging`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { mode: 0o700 })
  try {
    for (const name of ['node', 'cli']) cpSync(join(stage, name), join(staging, name), { recursive: true, verbatimSymlinks: true })
    for (const name of ['cli.tgz', 'bundle.tar.gz', 'bundle.tar.gz.sha256']) cpSync(join(stage, name), join(staging, name))
    mkdirSync(join(staging, 'bundle'), { mode: 0o700 })
    writeFileSync(join(staging, 'bundle', 'compose.yaml'), compose)
    makeReadOnly(staging)
    if (existsSync(paths.dir)) {
      stdout.write(`replacing ${paths.dir}\n`)
      rmSync(paths.dir, { recursive: true, force: true })
    }
    renameSync(staging, paths.dir)
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    throw e
  }
  stdout.write(`installed ${version} under ${paths.dir}\n`)
  return paths
}

// The retained artifacts of one directory (a stage or an installed version)
// through the release door. Throws the refusal when a check fails.
export async function verifyRetained({ version, dir, stdout }, release) {
  const report = await verifyStagedRelease({
    version,
    tarball: readFileSync(join(dir, 'cli.tgz')),
    archive: readFileSync(join(dir, 'bundle.tar.gz')),
    checksum: readFileSync(join(dir, 'bundle.tar.gz.sha256'), 'utf8'),
  }, { stdout }, release)
  if (!report.ok) throw report.refusal
}

// The one file the verified bundle archive holds.
function composeFrom(archive, version) {
  const files = readArchive(archive)
  const compose = files.get(`curia-bundle-${version}/compose.yaml`)
  if (!compose) throw new Error(`the bundle archive holds no curia-bundle-${version}/compose.yaml`)
  return compose.toString('utf8')
}

// Verified artifacts become read-only: every file loses its write bits and
// keeps its execute bits, so the runtime still runs. Directories stay 0700,
// which is what lets a reinstall or an update replace the version as a whole.
function makeReadOnly(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      makeReadOnly(path)
      chmodSync(path, 0o700)
    } else {
      chmodSync(path, (statSync(path).mode & 0o555) | 0o400)
    }
  }
}

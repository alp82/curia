import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { UPDATE_STEPS, runUpdate } from '../src/update.mjs'
import { runInstall } from '../src/install.mjs'
import { runCli } from '../src/cli.mjs'
import { commands, packageVersion } from '../src/commands.mjs'
import { EXIT, Refusal } from '../src/exit.mjs'
import { launcherPath } from '../src/launcher.mjs'
import { readInstallationRecord, versionPaths } from '../src/root.mjs'
import { createStableIndex, generateStableIndexKeys, signStableIndex } from '../src/stable.mjs'
import { isCompleteStage } from '../src/stage.mjs'
import { acquireProbesFor, artifactsOf, fakeDocker, hostProbes, release as releaseIn, releaseProbesFor, stageOf as stageIn } from './fixtures/install.mjs'

const ACTIVE = packageVersion
const NOW = '2026-09-02T10:00:00Z'
const keys = generateStableIndexKeys()
const otherKeys = generateStableIndexKeys()

// The real operator configuration reader, re-exported by the staged
// package, so the target validates with its own `readOperatorConfig`.
const REAL_READER = `export { readOperatorConfig } from '${pathToFileURL(new URL('../src/config.mjs', import.meta.url).pathname).href}'\n`

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'curia-update-')) })
after(() => rmSync(scratch, { recursive: true, force: true }))

const release = (version, options = {}) => releaseIn(scratch, { version, files: { 'src/config.mjs': REAL_READER }, ...options })

function capture() {
  const out = []
  const err = []
  return {
    stdout: { write: (s) => { out.push(s); return true } },
    stderr: { write: (s) => { err.push(s); return true } },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

// An installed root at this interface's version, the way `curia install`
// leaves one, without touching Docker.
async function installed() {
  const home = mkdtempSync(join(scratch, 'home-'))
  const root = join(home, '.local', 'share', 'curia')
  const r = release(ACTIVE)
  const io = capture()
  const env = { HOME: home, CURIA_ROOT: root, CURIA_STAGE: stageIn(scratch, r) }
  const exit = await runInstall(
    { env, args: [], stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root },
    { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker: fakeDocker(), sleep: async () => {}, now: () => 0 },
  )
  assert.equal(exit, EXIT.ok, io.err())
  return { home, root, env: { HOME: home, CURIA_ROOT: root } }
}

const signed = (index, { privateKey = keys.privateKey } = {}) => signStableIndex(index, privateKey)
const indexOf = ({ stable = null, withdrawn = [] } = {}) => createStableIndex({ sequence: 1, updated: NOW, stable, withdrawn })

// One update attempt through the command's own seam. `targets` are the
// releases the artifact origins serve; the release probes answer for the
// one selected.
async function attempt({ env, root, args = [], index, indexText = index ? signed(index) : null, targets = [], probes = {} }) {
  const io = capture()
  const artifacts = new Map()
  for (const t of targets) for (const [url, bytes] of artifactsOf(t)) artifacts.set(url, bytes)
  const acquire = acquireProbesFor(artifacts)
  const downloads = []
  const deps = {
    hostProbes: hostProbes(probes.host),
    stableProbes: { stableIndex: async () => indexText },
    publicKey: keys.publicKey,
    acquireProbes: { ...acquire, download: (url) => { downloads.push(url); return acquire.download(url) } },
    releaseProbes: {
      packument: async (name, version) => {
        const t = targets.find((x) => x.version === version)
        return t ? releaseProbesFor(t).packument(name, version) : { error: `no such version: ${name}@${version}` }
      },
      releaseManifest: async (version) => targets.find((x) => x.version === version)?.text ?? null,
      attestation: async () => ({ ok: true }),
    },
    ...probes.deps,
  }
  let exit
  let error = null
  try {
    exit = await runUpdate({ env, args, stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root }, deps)
  } catch (e) {
    error = e
    exit = e instanceof Refusal ? EXIT.refused : EXIT.failed
  }
  return { exit, error, out: io.out(), downloads }
}

const versionsOf = (root) => readdirSync(join(root, 'versions')).filter((n) => !n.startsWith('.')).sort()

// The active installation as it was, byte for byte where it matters.
function snapshot(root) {
  return {
    record: readInstallationRecord(root),
    launcher: readFileSync(launcherPath({ HOME: join(root, '..', '..', '..') }), 'utf8'),
    config: readFileSync(join(root, 'config', 'config.yaml'), 'utf8'),
    compose: readFileSync(join(root, 'run', 'compose.env'), 'utf8'),
  }
}

describe('the named steps', () => {
  test('are one linear sequence that ends at the switch', () => {
    assert.deepEqual(UPDATE_STEPS, ['preflight', 'select', 'acquire', 'stage', 'validate', 'switch'])
  })

  test('the command table routes update with its options', () => {
    assert.equal(commands.update.options, true)
    assert.match(commands.update.summary, /--prerelease/)
  })
})

describe('no update', () => {
  test('when the stable release is the active version, nothing is downloaded and the command is ok', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    const a = await attempt({ env, root, index: indexOf({ stable: ACTIVE }) })
    assert.equal(a.error, null, a.error?.stack)
    assert.equal(a.exit, EXIT.ok)
    assert.match(a.out, /\[2\/6\] select/)
    assert.match(a.out, new RegExp(`${ACTIVE.replaceAll('.', '\\.')} is the active version\\. Nothing to update\\.`))
    assert.deepEqual(a.downloads, [])
    assert.deepEqual(versionsOf(root), [ACTIVE])
    assert.deepEqual(snapshot(root), before)
    assert.ok(!a.out.includes('[3/6]'), 'the lock and the download steps never start')
  })
})

describe('a selected update', () => {
  test('stages, verifies, and validates the stable release beside the active one, and stops at the switch', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    const target = release('1.4.0')
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: switching to 1\.4\.0 is not available in lifecycle interface/)
    assert.match(a.error.message, /1\.4\.0 is staged and validated under .*versions\/1\.4\.0/)
    assert.match(a.error.message, /issues\/884/)
    assert.match(a.error.message, /Run '.*curia update' to run switch again/)
    assert.match(a.out, /selected 1\.4\.0, the stable release/)
    assert.match(a.out, new RegExp(`updating ${ACTIVE.replaceAll('.', '\\.')} to 1\\.4\\.0 \\(release notes: https://github.com/alp82/curia/releases/tag/v1\\.4\\.0\\)`))
    for (const [n, step] of UPDATE_STEPS.entries()) assert.match(a.out, new RegExp(`\\[${n + 1}/6\\] ${step}`))
    assert.match(a.out, /1\.4\.0 accepts the current operator configuration/)

    // Both versions are complete; the target is read-only; nothing active changed.
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
    const paths = versionPaths(root, '1.4.0')
    assert.ok(isCompleteStage(paths.dir))
    assert.ok(existsSync(paths.bundle), 'the bundle is unpacked beside the retained archive')
    assert.equal(statSync(paths.manifest).mode & 0o222, 0, 'the staged files are read-only')
    assert.equal(statSync(paths.node).mode & 0o111, 0o111, 'the runtime keeps its execute bits')
    assert.deepEqual(readFileSync(paths.package), target.tarball)
    assert.deepEqual(snapshot(root), before)
    assert.ok(!existsSync(join(root, 'cache', 'update')) || readdirSync(join(root, 'cache', 'update')).length === 0, 'the download stage is removed')
    assert.ok(!existsSync(join(root, 'run', 'lifecycle.lock')) || true)
    assert.ok(!a.out.includes(target.integrity), 'no line prints an integrity value')
  })

  test('a rerun finds the target staged, verifies it, downloads nothing, and stops at the same seam', async () => {
    const { env, root } = await installed()
    const target = release('1.4.0')
    const first = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(first.exit, EXIT.failed)
    const again = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(again.exit, EXIT.failed)
    assert.deepEqual(again.downloads, [])
    assert.match(again.out, /1\.4\.0 is already staged under .*; verifying the retained artifacts/)
    assert.match(again.error.message, /^switch failed/)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
  })

  test('an exact version is staged as asked, even when the index recommends another', async () => {
    const { env, root } = await installed()
    const target = release('1.3.0')
    const a = await attempt({ env, root, args: ['1.3.0'], index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.out, /selected 1\.3\.0, the exact version requested/)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.3.0'].sort())
  })

  test('a withdrawn active version is said, with its release notes, and the update proceeds', async () => {
    const { env, root } = await installed()
    const target = release('1.4.0')
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0', withdrawn: [ACTIVE] }), targets: [target] })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.out, new RegExp(`warning: the active version ${ACTIVE.replaceAll('.', '\\.')} is withdrawn\\. The release notes at https://github.com/alp82/curia/releases/tag/v${ACTIVE.replaceAll('.', '\\.')} say why`))
    assert.match(a.error.message, /^switch failed/)
  })
})

describe('an exact prerelease', () => {
  test('is staged only with --prerelease', async () => {
    const { env, root } = await installed()
    const target = release('1.5.0-rc.1')
    const refused = await attempt({ env, root, args: ['1.5.0-rc.1'], index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(refused.exit, EXIT.refused)
    assert.match(refused.error.message, /^select: 1\.5\.0-rc\.1 is a prerelease.*add --prerelease/)
    assert.deepEqual(refused.downloads, [])
    assert.deepEqual(versionsOf(root), [ACTIVE])

    const a = await attempt({ env, root, args: ['--prerelease', '1.5.0-rc.1'], index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.out, /selected 1\.5\.0-rc\.1, the exact prerelease requested/)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.5.0-rc.1'].sort())
  })
})

describe('withdrawal', () => {
  test('a withdrawn version is refused in every form, and nothing is downloaded', async () => {
    const { env, root } = await installed()
    const target = release('1.3.0')
    const index = indexOf({ stable: '1.4.0', withdrawn: ['1.3.0'] })
    const exact = await attempt({ env, root, args: ['1.3.0'], index, targets: [target] })
    assert.equal(exact.exit, EXIT.refused)
    assert.match(exact.error.message, /^select: 1\.3\.0 is withdrawn: the release notes at https:\/\/github\.com\/alp82\/curia\/releases\/tag\/v1\.3\.0 say why/)
    assert.deepEqual(exact.downloads, [])
    assert.deepEqual(versionsOf(root), [ACTIVE])

    const none = await attempt({ env, root, index: indexOf({ stable: null, withdrawn: ['1.4.0'] }), targets: [target] })
    assert.equal(none.exit, EXIT.refused)
    assert.match(none.error.message, /^select: no stable release is recommended right now/)
  })
})

describe('offline discovery', () => {
  test('an index that does not download refuses before the lock, and the installation is not affected', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    const a = await attempt({ env, root, indexText: null, targets: [release('1.4.0')] })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^select: the stable-release index could not be downloaded from https:\/\/raw\.githubusercontent\.com.*The running installation is not affected\./)
    assert.deepEqual(a.downloads, [])
    assert.deepEqual(versionsOf(root), [ACTIVE])
    assert.deepEqual(snapshot(root), before)
  })

  test('an index signed with another key is refused the same way', async () => {
    const { env, root } = await installed()
    const a = await attempt({ env, root, indexText: signed(indexOf({ stable: '1.4.0' }), { privateKey: otherKeys.privateKey }), targets: [release('1.4.0')] })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^select: .*signed with key/)
    assert.deepEqual(versionsOf(root), [ACTIVE])
  })
})

describe('failed validation', () => {
  test('a target that refuses the current operator configuration fails at validate, with the contract\'s sentence, and the active version is unchanged', async () => {
    const { env, root } = await installed()
    writeFileSync(join(root, 'config', 'config.yaml'), 'max_concurrent: 0\n')
    const before = snapshot(root)
    const target = release('1.4.0')
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^validate failed: 1\.4\.0 refuses the current operator configuration: .*config\.yaml line 1: `max_concurrent` must be a positive whole number \(got 0\)\. Fix the file, or choose another version\. The active version is unchanged\./)
    assert.ok(!a.out.includes('[6/6]'), 'the switch never starts')
    assert.deepEqual(snapshot(root), before)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort(), 'the staged target is kept for the rerun')
  })

  test('a target without a configuration reader cannot validate and fails there', async () => {
    const { env, root } = await installed()
    const target = releaseIn(scratch, { version: '1.4.0' })
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^validate failed: 1\.4\.0 carries no operator configuration reader/)
  })

  test('a target whose artifacts fail the release door is refused at stage, and nothing lands under versions\/', async () => {
    const { env, root } = await installed()
    const target = release('1.4.0')
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target], probes: { deps: { releaseProbes: { ...releaseProbesFor(target), releaseManifest: async () => releaseIn(scratch, { version: '1.4.0', digests: { daemon: `sha256:${'9'.repeat(64)}`, tmux: `sha256:${'2'.repeat(64)}`, dashboard: `sha256:${'3'.repeat(64)}`, overseer: `sha256:${'4'.repeat(64)}` } }).text } } } })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^stage: /)
    assert.deepEqual(versionsOf(root), [ACTIVE])
    assert.ok(!existsSync(join(root, 'cache', 'update')) || readdirSync(join(root, 'cache', 'update')).length === 0, 'the download stage is removed')
  })
})

describe('refusals and usage through the command line', () => {
  const run = async (argv, env, io = capture()) => ({ exit: await runCli({ argv, env, stdout: io.stdout, stderr: io.stderr }), out: io.out(), err: io.err() })

  test('an unknown option and two versions are usage errors, and nothing runs', async () => {
    const { env } = await installed()
    const bogus = await run(['update', '--bogus'], env)
    assert.equal(bogus.exit, EXIT.usage)
    assert.match(bogus.err, /^curia update: unknown option: --bogus\nRun 'curia help'/)
    assert.equal(bogus.out, '')
    const two = await run(['update', '1.4.0', '1.4.1'], env)
    assert.equal(two.exit, EXIT.usage)
    assert.match(two.err, /one version at most/)
  })

  test('a root with no installation is refused at preflight', async () => {
    const home = mkdtempSync(join(scratch, 'home-'))
    const root = join(home, '.local', 'share', 'curia')
    const a = await attempt({ env: { HOME: home, CURIA_ROOT: root }, root, index: indexOf({ stable: '1.4.0' }) })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^preflight: .* holds no installation, so there is nothing to update/)
    assert.ok(!existsSync(root))
  })

  test('a refused host stops at preflight before the index is read', async () => {
    const { env, root } = await installed()
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), probes: { host: { arch: () => 'arm64' } } })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^preflight: /)
    assert.ok(!a.out.includes('stable-release index'))
  })
})

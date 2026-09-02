import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROLLBACK_STEPS, rollbackRelease, runRollback } from '../src/rollback.mjs'
import { runUpdate } from '../src/update.mjs'
import { runInstall } from '../src/install.mjs'
import { runCli } from '../src/cli.mjs'
import { commands, packageVersion } from '../src/commands.mjs'
import { EXIT, Refusal } from '../src/exit.mjs'
import { launcherPath } from '../src/launcher.mjs'
import { RECORD_FORMAT, readInstallationRecord, versionPaths } from '../src/root.mjs'
import { createStableIndex, generateStableIndexKeys, signStableIndex } from '../src/stable.mjs'
import { isCompleteStage } from '../src/stage.mjs'
import { CORE_SERVICES } from '../src/switch.mjs'
import { SERVICES } from '../src/layout.mjs'
import { imageReference } from '../src/bundle.mjs'
import { acquireProbesFor, artifactsOf, DIGESTS, fakeDocker, fakeLoopback, fakeTailscale, healthy, hostProbes, loggedOutStatus, release as releaseIn, releaseProbesFor, stageOf as stageIn } from './fixtures/install.mjs'

const ACTIVE = packageVersion
const NOW = '2026-09-02T10:00:00Z'
const keys = generateStableIndexKeys()
const SECRET = ['fixture', 'discord', 'token', 'value'].join('-')

// The real operator configuration reader, re-exported by a fixture package,
// so a release validates with its own `readOperatorConfig`.
const REAL_READER = `export { readOperatorConfig } from '${pathToFileURL(new URL('../src/config.mjs', import.meta.url).pathname).href}'\n`

// A reader that refuses one key the real one accepts: what an older release
// looks like when the configuration has moved past it.
const STRICT_READER = [
  "import { readFileSync } from 'node:fs'",
  `import { readOperatorConfig as real } from '${pathToFileURL(new URL('../src/config.mjs', import.meta.url).pathname).href}'`,
  'export function readOperatorConfig(path) {',
  "  const line = readFileSync(path, 'utf8').split('\\n').findIndex((l) => l.startsWith('poll_interval_s'))",
  '  if (line >= 0) {',
  '    const e = new Error(`${path} line ${line + 1}: \\`poll_interval_s\\` is not a key this version knows`)',
  "    e.name = 'ConfigError'",
  '    throw e',
  '  }',
  '  return real(path)',
  '}',
  '',
].join('\n')

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'curia-rollback-')) })
after(() => rmSync(scratch, { recursive: true, force: true }))

const release = (version, { reader = REAL_READER, ...options } = {}) => releaseIn(scratch, { version, files: { 'src/config.mjs': reader }, ...options })

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

const signed = (index) => signStableIndex(index, keys.privateKey)
const indexOf = ({ stable = null, withdrawn = [] } = {}) => createStableIndex({ sequence: 1, updated: NOW, stable, withdrawn })
const healthyStates = (overrides = {}) => healthy(SERVICES, overrides)
const versionsOf = (root) => readdirSync(join(root, 'versions')).filter((n) => !n.startsWith('.')).sort()
const composeVerbs = (docker) => docker.calls.map((c) => c.slice(c.indexOf('-f') + 2))
const bundleOf = (args) => args[args.indexOf('-f') + 1].split('/versions/')[1].split('/')[0]

// An installed root at this interface's version, the way `curia install`
// leaves one, without touching Docker. The preserved directories get one
// file each, so a rollback can be seen to leave them alone.
async function installed({ reader } = {}) {
  const home = mkdtempSync(join(scratch, 'home-'))
  const root = join(home, '.local', 'share', 'curia')
  const r = release(ACTIVE, { reader })
  const io = capture()
  const env = { HOME: home, CURIA_ROOT: root, CURIA_STAGE: stageIn(scratch, r) }
  const exit = await runInstall(
    { env, args: [], stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root },
    { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker: fakeDocker(), tailscale: fakeTailscale(), sleep: async () => {}, now: () => 0 },
  )
  assert.equal(exit, EXIT.ok, io.err())
  writeFileSync(join(root, 'secrets', 'discord-bot-token'), `${SECRET}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'state', 'discord.json'), '{"format":1,"server":"1"}\n', { mode: 0o600 })
  mkdirSync(join(root, 'work', 'cfg', 'curia-12'), { recursive: true })
  writeFileSync(join(root, 'work', 'cfg', 'curia-12', 'session.json'), '{"resumable":true}\n')
  return { home, root, env: { HOME: home, CURIA_ROOT: root } }
}

// One update through the command's own seam, so a root holds a rollback
// release the way a real update leaves one.
async function updated({ env, root, to = '1.4.0', docker = fakeDocker(), live = [] }) {
  const target = release(to)
  const io = capture()
  let clock = 0
  const artifacts = new Map(artifactsOf(target))
  const deps = {
    hostProbes: hostProbes(),
    stableProbes: { stableIndex: async () => signed(indexOf({ stable: to })) },
    publicKey: keys.publicKey,
    acquireProbes: acquireProbesFor(artifacts),
    releaseProbes: releaseProbesFor(target),
    docker,
    fetch: fakeLoopback(docker, { initial: ACTIVE, live }),
    sleep: async (ms) => { clock += ms },
    now: () => clock,
  }
  let exit
  let error = null
  try {
    exit = await runUpdate({ env, args: [], stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root }, deps)
  } catch (e) {
    error = e
    exit = e instanceof Refusal ? EXIT.refused : EXIT.failed
  }
  return { exit, error, out: io.out(), target }
}

// One rollback attempt through the command's own seam.
async function attempt({ env, root, args = [], probes = {}, docker = fakeDocker(), loopback = {} }) {
  const io = capture()
  const active = readInstallationRecord(root)?.activeVersion ?? ACTIVE
  const fetch = loopback.fetch ?? fakeLoopback(docker, { initial: active, ...loopback })
  let clock = 0
  const deps = {
    hostProbes: hostProbes(probes.host),
    tailscale: fakeTailscale(),
    docker,
    fetch,
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    ...probes.deps,
  }
  let exit
  let error = null
  try {
    exit = await runRollback({ env, args, stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root }, deps)
  } catch (e) {
    error = e
    exit = e instanceof Refusal ? EXIT.refused : EXIT.failed
  }
  return { exit, error, out: io.out(), docker, fetch }
}

// Everything a rollback must leave alone, byte for byte.
function snapshot(root) {
  return {
    record: readInstallationRecord(root),
    launcher: readFileSync(launcherPath({ HOME: join(root, '..', '..', '..') }), 'utf8'),
    config: readFileSync(join(root, 'config', 'config.yaml'), 'utf8'),
    secret: readFileSync(join(root, 'secrets', 'discord-bot-token'), 'utf8'),
    state: readFileSync(join(root, 'state', 'discord.json'), 'utf8'),
    work: readFileSync(join(root, 'work', 'cfg', 'curia-12', 'session.json'), 'utf8'),
    compose: readFileSync(join(root, 'run', 'compose.env'), 'utf8'),
  }
}

describe('the named steps', () => {
  test('are one linear sequence from the root to the switch', () => {
    assert.deepEqual(ROLLBACK_STEPS, ['preflight', 'select', 'validate', 'switch'])
  })

  test('the command table routes rollback without options', () => {
    assert.equal(commands.rollback.options, undefined)
    assert.match(commands.rollback.summary, /retained previous release/)
  })
})

describe('the rollback release', () => {
  test('is the one complete release under versions/ that is not the active one', () => {
    const root = mkdtempSync(join(scratch, 'root-'))
    for (const v of ['1.3.0', '1.4.0']) mkdirSync(join(root, 'versions', v), { recursive: true })
    assert.deepEqual(rollbackRelease(root, '1.4.0', { complete: () => true }), { version: '1.3.0', candidates: ['1.3.0'] })
  })

  test('an incomplete directory is not a candidate, and a dot directory is never one', () => {
    const root = mkdtempSync(join(scratch, 'root-'))
    for (const v of ['1.3.0', '1.4.0', '.1.5.0.77.staging', '1.5.0']) mkdirSync(join(root, 'versions', v), { recursive: true })
    const found = rollbackRelease(root, '1.4.0', { complete: (dir) => !dir.endsWith('1.5.0') })
    assert.deepEqual(found, { version: '1.3.0', candidates: ['1.3.0'] })
  })

  test('none or two is no answer', () => {
    const root = mkdtempSync(join(scratch, 'root-'))
    mkdirSync(join(root, 'versions', '1.4.0'), { recursive: true })
    assert.deepEqual(rollbackRelease(root, '1.4.0', { complete: () => true }), { version: null, candidates: [] })
    for (const v of ['1.3.0', '1.5.0']) mkdirSync(join(root, 'versions', v), { recursive: true })
    assert.deepEqual(rollbackRelease(root, '1.4.0', { complete: () => true }), { version: null, candidates: ['1.3.0', '1.5.0'] })
  })
})

describe('a rollback', () => {
  test('validates with the rollback release, switches back to it, re-adopts the live sessions, records it active, and keeps the rolled-back-from release', async () => {
    const { env, root } = await installed()
    const up = await updated({ env, root, live: ['curia-12'] })
    assert.equal(up.exit, EXIT.ok, up.error?.stack)
    const before = snapshot(root)
    assert.equal(before.record.activeVersion, '1.4.0')

    const a = await attempt({ env, root, loopback: { live: ['curia-12', 'curia-15'] } })
    assert.equal(a.error, null, a.error?.stack)
    assert.equal(a.exit, EXIT.ok)
    for (const [n, step] of ROLLBACK_STEPS.entries()) assert.match(a.out, new RegExp(`\\[${n + 1}/4\\] ${step}`))
    assert.match(a.out, new RegExp(`rolling back from 1\\.4\\.0 to ${ACTIVE.replaceAll('.', '\\.')}`))
    assert.match(a.out, new RegExp(`${ACTIVE.replaceAll('.', '\\.')} accepts the current operator configuration at .*config/config\\.yaml`))

    // The switch, with the versions swapped: the rollback release's images
    // pulled, the core services alone recreated from its bundle.
    const verbs = composeVerbs(a.docker)
    const pull = verbs.find((v) => v[0] === 'pull')
    const ups = a.docker.calls.filter((c) => c.includes('up'))
    assert.deepEqual(pull, ['pull', ...CORE_SERVICES])
    assert.ok(a.docker.calls.some((c) => c[0] === 'image' && c[1] === 'pull' && c.at(-1) === imageReference('agent', DIGESTS.agent)), 'the rollback release\'s agent image is pulled by digest')
    assert.equal(ups.length, 1)
    assert.deepEqual(ups[0].slice(ups[0].indexOf('up')), ['up', '--detach', '--no-deps', ...CORE_SERVICES])
    assert.equal(bundleOf(ups[0]), ACTIVE)
    assert.ok(!verbs.some((v) => v[0] === 'down' || v[0] === 'stop' || v[0] === 'rm' || v.includes('--remove-orphans')), 'nothing is stopped')

    // Acceptance and re-adoption, the switch's own.
    assert.match(a.out, /every service is healthy/)
    assert.match(a.out, new RegExp(`the service reports ${ACTIVE.replaceAll('.', '\\.')} and the Curia app reports ${ACTIVE.replaceAll('.', '\\.')}`))
    assert.match(a.out, /re-adopted 2 live sessions: curia-12, curia-15/)

    // Activation and retention: the record names the rollback release, the
    // rolled-back-from release is the new rollback release, and everything
    // preserved is byte for byte what it was.
    const after = snapshot(root)
    assert.equal(after.record.activeVersion, ACTIVE)
    assert.deepEqual({ ...after, record: null }, { ...before, record: null })
    assert.equal(after.record.installationId, before.record.installationId)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
    assert.ok(isCompleteStage(versionPaths(root, '1.4.0').dir), 'the rolled-back-from release stays complete')
    assert.match(a.out, new RegExp(`${ACTIVE.replaceAll('.', '\\.')} is the active version; 1\\.4\\.0 is kept for 'curia rollback'`))
    assert.match(a.out, new RegExp(`Curia ${ACTIVE.replaceAll('.', '\\.')} is running`))
    assert.ok(!a.out.includes(SECRET), 'no line prints a secret value')
  })

  test('a rollback removes what is neither release, so the rolled-back-from release is the one rollback release', async () => {
    const { env, root } = await installed()
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    mkdirSync(join(root, 'versions', '1.5.0'), { recursive: true })
    writeFileSync(join(root, 'versions', '1.5.0', 'cli.tgz'), 'half of a stage')
    mkdirSync(join(root, 'versions', '.1.5.0.99.staging'), { recursive: true })
    const a = await attempt({ env, root })
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
    assert.ok(!existsSync(join(root, 'versions', '.1.5.0.99.staging')))
    assert.match(a.out, /removed 1\.5\.0, which is no longer a rollback release/)
  })

  test('after a rollback, the next update moves forward and removes the release that was rolled back from', async () => {
    const { env, root } = await installed()
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    assert.equal((await attempt({ env, root })).exit, EXIT.ok)
    const forward = await updated({ env, root, to: '1.5.0' })
    assert.equal(forward.exit, EXIT.ok, forward.error?.stack)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.5.0'].sort())
    assert.match(forward.out, /removed 1\.4\.0, which is no longer a rollback release/)
  })

  test('a second rollback goes forward again to the release the first one left', async () => {
    const { env, root } = await installed()
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    assert.equal((await attempt({ env, root })).exit, EXIT.ok)
    const again = await attempt({ env, root })
    assert.equal(again.exit, EXIT.ok, again.error?.stack)
    assert.match(again.out, new RegExp(`rolling back from ${ACTIVE.replaceAll('.', '\\.')} to 1\\.4\\.0`))
    assert.equal(readInstallationRecord(root).activeVersion, '1.4.0')
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
  })
})

describe('refusals', () => {
  test('an incompatible configuration is refused at validate, names the incompatibility, and touches nothing', async () => {
    const { env, root } = await installed({ reader: STRICT_READER })
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    writeFileSync(join(root, 'config', 'config.yaml'), 'max_concurrent: 4\npoll_interval_s: 30\n')
    const before = snapshot(root)
    const a = await attempt({ env, root })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, new RegExp(`^validate: ${ACTIVE.replaceAll('.', '\\.')} refuses the current operator configuration: .*config/config\\.yaml line 2: \`poll_interval_s\` is not a key this version knows\\. `))
    assert.match(a.error.message, /Fix the file so that both releases accept it, or stay on 1\.4\.0\. The active version is unchanged\./)
    assert.ok(!a.out.includes('[4/4]'), 'the switch never starts')
    assert.deepEqual(composeVerbs(a.docker), [], 'Docker is not asked for anything')
    assert.deepEqual(a.fetch.reads, [], 'the service is not asked for anything')
    assert.deepEqual(snapshot(root), before)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
  })

  test('a rollback release without a configuration reader cannot validate and is refused', async () => {
    const home = mkdtempSync(join(scratch, 'home-'))
    const root = join(home, '.local', 'share', 'curia')
    const r = releaseIn(scratch, { version: ACTIVE })
    const io = capture()
    const exit = await runInstall(
      { env: { HOME: home, CURIA_ROOT: root, CURIA_STAGE: stageIn(scratch, r) }, args: [], stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root },
      { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker: fakeDocker(), tailscale: fakeTailscale(), sleep: async () => {}, now: () => 0 },
    )
    assert.equal(exit, EXIT.ok, io.err())
    const env = { HOME: home, CURIA_ROOT: root }
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    const a = await attempt({ env, root })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^validate: .* carries no operator configuration reader .* The active version is unchanged\./)
    assert.equal(readInstallationRecord(root).activeVersion, '1.4.0')
  })

  test('a root with no rollback release is refused at select', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    const a = await attempt({ env, root })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, new RegExp(`^select: versions/ holds no release beside the active one, ${ACTIVE.replaceAll('.', '\\.')}, so there is nothing to roll back to\\.`))
    assert.match(a.error.message, /Curia keeps the release you updated from after a successful 'curia update'/)
    assert.deepEqual(snapshot(root), before)
    assert.deepEqual(composeVerbs(a.docker), [])
  })

  test('two releases beside the active one are refused at select, and both are named', async () => {
    const { env, root } = await installed()
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    const broken = fakeDocker({ up: { ok: false, stdout: '', stderr: 'Error response from daemon: no such image', code: 1 } })
    const failed = await updated({ env, root, to: '1.5.0', docker: broken })
    assert.equal(failed.exit, EXIT.failed)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0', '1.5.0'].sort())
    const before = snapshot(root)
    const a = await attempt({ env, root })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, new RegExp(`^select: versions/ holds two releases beside the active one, 1\\.4\\.0: ${ACTIVE.replaceAll('.', '\\.')} and 1\\.5\\.0\\.`))
    assert.match(a.error.message, /Finish the update with 'curia update', or remove the staged release you don't want/)
    assert.deepEqual(snapshot(root), before)
    assert.deepEqual(composeVerbs(a.docker), [])
  })

  test('a root with no installation is refused at preflight', async () => {
    const home = mkdtempSync(join(scratch, 'home-'))
    const root = join(home, '.local', 'share', 'curia')
    const a = await attempt({ env: { HOME: home, CURIA_ROOT: root }, root })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^preflight: .* holds no installation, so there is nothing to roll back/)
    assert.ok(!existsSync(root))
  })

  test('a refused host stops at preflight', async () => {
    const { env, root } = await installed()
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    const a = await attempt({ env, root, probes: { host: { arch: () => 'arm64' } } })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^preflight: /)
    assert.equal(readInstallationRecord(root).activeVersion, '1.4.0')
  })

  // Since #891 the tailnet is the install's to join; here it is inspected
  // only, inside preflight, and a logged-out node is a refusal that names
  // `curia install`. Nothing is brought up.
  test('a node that is logged out of its tailnet is refused at preflight, inspect-only', async () => {
    const { env, root } = await installed()
    const tailscale = fakeTailscale({ status: loggedOutStatus() })
    const a = await attempt({ env, root, probes: { deps: { tailscale } } })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^preflight: this node is not logged in to a tailnet \(NeedsLogin\)\. Run 'curia install'/)
    assert.ok(tailscale.calls.every((c) => c[0] === 'status'), 'only reads')
    assert.equal(readInstallationRecord(root).activeVersion, ACTIVE)
  })

  test('an option is a usage error through the command line, and nothing runs', async () => {
    const { env } = await installed()
    const io = capture()
    const exit = await runCli({ argv: ['rollback', '--force'], env, stdout: io.stdout, stderr: io.stderr })
    assert.equal(exit, EXIT.usage)
    assert.match(io.err(), /^curia rollback: unknown option: --force/)
    assert.equal(io.out(), '')
  })
})

describe('a failed rollback', () => {
  test('a rollback release that fails its health check switches back once to the release that was running, and the record is unchanged', async () => {
    const { env, root } = await installed()
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    const before = snapshot(root)
    const docker = fakeDocker({
      ps: (args) => ({ ok: true, stdout: healthyStates(bundleOf(args) === ACTIVE ? { daemon: { State: 'exited', Health: '', ExitCode: 1 } } : {}) }),
    })
    const a = await attempt({ env, root, docker, loopback: { live: ['curia-12'] } })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: daemon exited with code 1\./)
    assert.match(a.error.message, /Switched back to 1\.4\.0, which is healthy and re-adopted 1 live session\. The record still names 1\.4\.0\./)
    assert.match(a.error.message, /Run '.*curia rollback' to run switch again/)
    const ups = a.docker.calls.filter((c) => c.includes('up'))
    assert.deepEqual(ups.map(bundleOf), [ACTIVE, '1.4.0'], 'the rollback release once, the running release once, and nothing again')
    assert.deepEqual(snapshot(root), before)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
  })

  test('a rollback release that does not re-adopt a live session fails, and the switch back re-adopts it', async () => {
    const { env, root } = await installed()
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    const a = await attempt({ env, root, loopback: { live: ['curia-12', 'curia-15'], readopt: (s, bundle) => (bundle === ACTIVE && s === 'curia-15' ? 'untracked' : 'adopted') } })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, new RegExp(`^switch failed: ${ACTIVE.replaceAll('.', '\\.')} did not re-adopt curia-15 within \\d+ seconds`))
    assert.match(a.error.message, /Switched back to 1\.4\.0, which is healthy and re-adopted 2 live sessions\./)
    assert.equal(readInstallationRecord(root).activeVersion, '1.4.0')
    assert.equal(a.docker.calls.filter((c) => c.includes('up')).length, 2)
  })

  test('when the switch back does not come up either, the failure names both and names reinstall', async () => {
    const { env, root } = await installed()
    assert.equal((await updated({ env, root })).exit, EXIT.ok)
    const docker = fakeDocker({ ps: { ok: true, stdout: healthyStates({ overseer: { State: 'exited', Health: '', ExitCode: 2 } }) } })
    const a = await attempt({ env, root, docker })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: overseer exited with code 2\. .*The switch back to 1\.4\.0 failed too: overseer exited with code 2\./)
    assert.match(a.error.message, /curia reinstall/)
    assert.equal(readInstallationRecord(root).activeVersion, '1.4.0')
    assert.equal(a.docker.calls.filter((c) => c.includes('up')).length, 2, 'nothing is tried a third time')
  })
})

describe('what the rollback release must still read', () => {
  test('the installation record format and keys are what every release of this major reads', () => {
    // A minor release changes nothing here: the retained rollback release
    // reads the record with these keys and refuses any other, so a new key
    // or a new format number is a major release.
    assert.equal(RECORD_FORMAT, 1)
  })
})

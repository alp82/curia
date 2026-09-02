import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import { CORE_SERVICES, READOPTION_TIMEOUT_MS } from '../src/switch.mjs'
import { SERVICES } from '../src/layout.mjs'
import { imageReference } from '../src/bundle.mjs'
import { acquireProbesFor, artifactsOf, DIGESTS, fakeDocker, fakeLoopback, fakeTailscale, healthy, hostProbes, loggedOutStatus, release as releaseIn, releaseProbesFor, stageOf as stageIn } from './fixtures/install.mjs'

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
    { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker: fakeDocker(), tailscale: fakeTailscale(), sleep: async () => {}, now: () => 0 },
  )
  assert.equal(exit, EXIT.ok, io.err())
  return { home, root, env: { HOME: home, CURIA_ROOT: root } }
}

const signed = (index, { privateKey = keys.privateKey } = {}) => signStableIndex(index, privateKey)
const indexOf = ({ stable = null, withdrawn = [] } = {}) => createStableIndex({ sequence: 1, updated: NOW, stable, withdrawn })

// One update attempt through the command's own seam. `targets` are the
// releases the artifact origins serve; the release probes answer for the
// one selected.
async function attempt({ env, root, args = [], index, indexText = index ? signed(index) : null, targets = [], probes = {}, docker = fakeDocker(), loopback = {} }) {
  const io = capture()
  const fetch = loopback.fetch ?? fakeLoopback(docker, { initial: ACTIVE, ...loopback })
  let clock = 0
  const artifacts = new Map()
  for (const t of targets) for (const [url, bytes] of artifactsOf(t)) artifacts.set(url, bytes)
  const acquire = acquireProbesFor(artifacts)
  const downloads = []
  const deps = {
    hostProbes: hostProbes(probes.host),
    tailscale: fakeTailscale(),
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
    docker,
    fetch,
    sleep: async (ms) => { clock += ms },
    now: () => clock,
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
  return { exit, error, out: io.out(), downloads, docker, fetch }
}

const healthyStates = (overrides = {}) => healthy(SERVICES, overrides)

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

// The service's three steps of the switch, as the fake docker records them.
const composeVerbs = (docker) => docker.calls.map((c) => c.slice(c.indexOf('-f') + 2))
const bundleOf = (call) => call[call.indexOf('-f') + 1].split('/versions/')[1].split('/')[0]

describe('a selected update', () => {
  test('stages, validates, and switches to the stable release, re-adopts the live agents, records it active, and keeps the previous release', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    const target = release('1.4.0')
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target], loopback: { live: ['curia-12', 'curia-15'] } })
    assert.equal(a.error, null, a.error?.stack)
    assert.equal(a.exit, EXIT.ok)
    assert.match(a.out, /selected 1\.4\.0, the stable release/)
    assert.match(a.out, new RegExp(`updating ${ACTIVE.replaceAll('.', '\\.')} to 1\\.4\\.0 \\(release notes: https://github.com/alp82/curia/releases/tag/v1\\.4\\.0\\)`))
    for (const [n, step] of UPDATE_STEPS.entries()) assert.match(a.out, new RegExp(`\\[${n + 1}/6\\] ${step}`))
    assert.match(a.out, /1\.4\.0 accepts the current operator configuration/)

    // The switch: the images of the target pulled by digest, then the core
    // services alone recreated from the target's bundle. Nothing brings
    // tmux, ttyd, or an agent container down, and nothing removes orphans.
    const verbs = composeVerbs(a.docker)
    const pull = verbs.find((v) => v[0] === 'pull')
    const up = verbs.find((v) => v[0] === 'up')
    assert.deepEqual(pull, ['pull', ...CORE_SERVICES])
    assert.deepEqual(up, ['up', '--detach', '--no-deps', ...CORE_SERVICES])
    assert.equal(bundleOf(a.docker.calls.find((c) => c.includes('up'))), '1.4.0')
    // The target's agent image is pulled with its service images, so the
    // next agent starts on it without a pull on the dispatch path.
    const agentPull = a.docker.calls.findIndex((c) => c[0] === 'image' && c[1] === 'pull')
    assert.deepEqual(a.docker.calls[agentPull], ['image', 'pull', '--quiet', imageReference('agent', DIGESTS.agent)])
    assert.ok(agentPull < a.docker.calls.findIndex((c) => c.includes('up')), 'the agent image is pulled before the recreate')
    assert.ok(!verbs.some((v) => v[0] === 'down' || v[0] === 'stop' || v[0] === 'rm'), 'nothing is stopped')
    assert.ok(!verbs.some((v) => v.includes('tmux') || v.includes('ttyd') || v.includes('--remove-orphans')), 'tmux and ttyd keep running')
    assert.ok(verbs.indexOf(pull) < verbs.indexOf(up) && verbs.some((v, i) => i > verbs.indexOf(up) && v[0] === 'ps'), 'health is read after the recreate')

    // Acceptance: health, the target version from the service and the app,
    // and every live session re-adopted.
    assert.match(a.out, /every service is healthy/)
    assert.match(a.out, /the service reports 1\.4\.0 and the Curia app reports 1\.4\.0/)
    assert.match(a.out, /re-adopted 2 live sessions: curia-12, curia-15/)
    assert.ok(a.fetch.reads.includes('4271/overview'), 'the live sessions were read')

    // Activation: the record names the target, the launcher is untouched,
    // the Compose environment carries the same values, and the previous
    // release is the one other version kept.
    const after = snapshot(root)
    assert.equal(after.record.activeVersion, '1.4.0')
    assert.equal(after.record.installationId, before.record.installationId)
    assert.equal(after.launcher, before.launcher)
    assert.equal(after.config, before.config)
    assert.equal(after.compose, before.compose)
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
    const paths = versionPaths(root, '1.4.0')
    assert.ok(isCompleteStage(paths.dir))
    assert.ok(isCompleteStage(versionPaths(root, ACTIVE).dir), 'the previous release stays complete for the rollback')
    assert.equal(statSync(paths.manifest).mode & 0o222, 0, 'the staged files are read-only')
    assert.match(a.out, new RegExp(`1\\.4\\.0 is the active version; ${ACTIVE.replaceAll('.', '\\.')} is kept for 'curia rollback'`))
    assert.match(a.out, /Curia 1\.4\.0 is running/)
    assert.ok(!existsSync(join(root, 'cache', 'update')) || readdirSync(join(root, 'cache', 'update')).length === 0, 'the download stage is removed')
    assert.ok(!a.out.includes(target.integrity), 'no line prints an integrity value')
  })

  test('a rerun of a switched update finds the target active and does nothing', async () => {
    const { env, root } = await installed()
    const target = release('1.4.0')
    const first = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(first.exit, EXIT.ok, first.error?.stack)
    const again = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target], loopback: { initial: '1.4.0' } })
    assert.equal(again.exit, EXIT.ok, again.error?.stack)
    assert.deepEqual(again.downloads, [])
    assert.match(again.out, /1\.4\.0 is the active version\. Nothing to update\./)
    assert.deepEqual(composeVerbs(again.docker), [])
  })

  test('a rerun after a failed switch finds the target staged, verifies it, downloads nothing, and switches', async () => {
    const { env, root } = await installed()
    const target = release('1.4.0')
    const broken = fakeDocker({ up: { ok: false, stdout: '', stderr: 'Error response from daemon: no such image', code: 1 } })
    const first = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target], docker: broken })
    assert.equal(first.exit, EXIT.failed)
    assert.match(first.error.message, /^switch failed: /)
    assert.equal(readInstallationRecord(root).activeVersion, ACTIVE)
    const again = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(again.exit, EXIT.ok, again.error?.stack)
    assert.deepEqual(again.downloads, [])
    assert.match(again.out, /1\.4\.0 is already staged under .*; verifying the retained artifacts/)
    assert.equal(readInstallationRecord(root).activeVersion, '1.4.0')
  })

  test('an exact version is switched to as asked, even when the index recommends another', async () => {
    const { env, root } = await installed()
    const target = release('1.3.0')
    const a = await attempt({ env, root, args: ['1.3.0'], index: indexOf({ stable: '1.4.0' }), targets: [target] })
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    assert.match(a.out, /selected 1\.3\.0, the exact version requested/)
    assert.equal(readInstallationRecord(root).activeVersion, '1.3.0')
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.3.0'].sort())
  })

  test('a withdrawn active version is said, with its release notes, and the update proceeds', async () => {
    const { env, root } = await installed()
    const target = release('1.4.0')
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0', withdrawn: [ACTIVE] }), targets: [target] })
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    assert.match(a.out, new RegExp(`warning: the active version ${ACTIVE.replaceAll('.', '\\.')} is withdrawn\\. The release notes at https://github.com/alp82/curia/releases/tag/v${ACTIVE.replaceAll('.', '\\.')} say why`))
  })

  test('after a second update only the target and the previous active release remain', async () => {
    const { env, root } = await installed()
    const first = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')] })
    assert.equal(first.exit, EXIT.ok, first.error?.stack)
    const second = await attempt({ env, root, index: indexOf({ stable: '1.5.0' }), targets: [release('1.5.0')], loopback: { initial: '1.4.0' } })
    assert.equal(second.exit, EXIT.ok, second.error?.stack)
    assert.deepEqual(versionsOf(root), ['1.4.0', '1.5.0'])
    assert.ok(!existsSync(versionPaths(root, ACTIVE).dir), 'the release before the previous one is removed')
    assert.match(second.out, new RegExp(`removed ${ACTIVE.replaceAll('.', '\\.')}, which is no longer a rollback release`))
  })
})

describe('the switch', () => {
  test('the service and the overseer are recreated together, so a turn the switch interrupts is the daemon\'s own replay', async () => {
    // ADR-0015 and #388: the overseer replays a turn a restart killed when
    // the daemon and the overseer come back together, the shape of the
    // routine deploy. The switch keeps that shape: one `up` carries the
    // service, the app, and the overseer, and the overseer must be healthy
    // before the switch is accepted, so the replay has a container to
    // answer.
    const { env, root } = await installed()
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')] })
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    const ups = composeVerbs(a.docker).filter((v) => v[0] === 'up')
    assert.equal(ups.length, 1)
    assert.ok(ups[0].includes('daemon') && ups[0].includes('overseer') && ups[0].includes('dashboard'))
    assert.ok(a.out.includes('the overseer replays a turn the switch interrupted'), 'the operator is told what happens to a turn in flight')
  })

  test('re-adoption is polled: a service that answers before its boot reconcile settles is read again', async () => {
    const { env, root } = await installed()
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')], loopback: { live: ['curia-7'], settle: 2 } })
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    assert.ok(a.fetch.reads.filter((r) => r === '4271/overview').length >= 4, 'read before the switch, then until the fleet is determinate')
    assert.match(a.out, /re-adopted 1 live session: curia-7/)
  })

  test('a session that ended during the switch is reported and is not a failure', async () => {
    const { env, root } = await installed()
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')], loopback: { live: ['curia-7', 'curia-9'], readopt: (s) => (s === 'curia-9' ? 'ended' : 'adopted') } })
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    assert.match(a.out, /re-adopted 1 live session: curia-7/)
    assert.match(a.out, /curia-9 ended during the switch/)
  })

  test('with no live session there is nothing to re-adopt, and the switch says so', async () => {
    const { env, root } = await installed()
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')] })
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    assert.match(a.out, /no live session to re-adopt/)
  })

  test('a live session the recreated service does not adopt fails the switch, which switches back once', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')], loopback: { live: ['curia-7', 'curia-9'], readopt: (s, bundle) => (bundle === '1.4.0' && s === 'curia-9' ? 'untracked' : 'adopted') } })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: 1\.4\.0 did not re-adopt curia-9 within \d+ seconds/)
    assert.match(a.error.message, new RegExp(`Switched back to ${ACTIVE.replaceAll('.', '\\.')}, which is healthy and re-adopted 2 live sessions\\. The record still names`))
    assert.match(a.out, /re-adopted 2 live sessions: curia-7, curia-9/, 'the switch back proves re-adoption the way the switch does')
    assert.match(a.error.message, /Run '.*curia update' to run switch again/)
    const ups = a.docker.calls.filter((c) => c.includes('up'))
    assert.equal(ups.length, 2, 'the target once, the previous release once')
    assert.equal(bundleOf(ups[0]), '1.4.0')
    assert.equal(bundleOf(ups[1]), ACTIVE)
    assert.deepEqual(snapshot(root), before, 'the record, the launcher, and the environment are unchanged')
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort(), 'the staged target is kept for the rerun')
  })

  test('a core service that fails its health check fails the switch, which switches back once and reports both', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    let asked = 0
    const docker = fakeDocker({
      ps: (args) => {
        asked += 1
        const onTarget = bundleOf(args) === '1.4.0'
        const overrides = onTarget ? { overseer: { State: 'exited', Health: '', ExitCode: 1 } } : {}
        return { ok: true, stdout: healthyStates(overrides) }
      },
    })
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')], docker, loopback: { live: ['curia-7'] } })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: overseer exited with code 1\./)
    assert.match(a.error.message, /logs overseer/)
    assert.match(a.error.message, new RegExp(`Switched back to ${ACTIVE.replaceAll('.', '\\.')}, which is healthy and re-adopted 1 live session\\.`))
    assert.ok(asked >= 2)
    assert.deepEqual(snapshot(root), before)
  })

  test('a switch back that does not re-adopt a live session is a failed switch back, reported once and never retried', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    const docker = fakeDocker({
      ps: (args) => ({ ok: true, stdout: healthyStates(bundleOf(args) === '1.4.0' ? { daemon: { State: 'exited', Health: '', ExitCode: 1 } } : {}) }),
    })
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')], docker, loopback: { live: ['curia-7'], readopt: (s, bundle) => (bundle === ACTIVE ? 'untracked' : 'adopted') } })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: daemon exited with code 1\./)
    assert.match(a.error.message, new RegExp(`The switch back to ${ACTIVE.replaceAll('.', '\\.')} failed too: ${ACTIVE.replaceAll('.', '\\.')} did not re-adopt curia-7 within \\d+ seconds`))
    assert.match(a.error.message, /curia reinstall/)
    assert.deepEqual(a.docker.calls.filter((c) => c.includes('up')).map(bundleOf), ['1.4.0', ACTIVE])
    assert.deepEqual(snapshot(root), before)
  })

  test('a service that reports another version than the target fails the switch', async () => {
    const { env, root } = await installed()
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')], loopback: { versionOf: (v) => (v === '1.4.0' ? '1.3.9' : v) } })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: the service reports 1\.3\.9 and the Curia app reports 1\.3\.9, not 1\.4\.0/)
    assert.equal(readInstallationRecord(root).activeVersion, ACTIVE)
  })

  test('when the switch back does not come up either, the failure names both and the record still names the previous release', async () => {
    const { env, root } = await installed()
    const docker = fakeDocker({ ps: { ok: true, stdout: healthyStates({ daemon: { State: 'exited', Health: '', ExitCode: 2 } }) } })
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')], docker })
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: daemon exited with code 2\./)
    assert.match(a.error.message, new RegExp(`The switch back to ${ACTIVE.replaceAll('.', '\\.')} failed too: daemon exited with code 2\\.`))
    assert.match(a.error.message, /curia reinstall/)
    assert.equal(readInstallationRecord(root).activeVersion, ACTIVE)
  })

  test('activation is atomic: a record that cannot be written leaves the previous record whole, and the switch goes back', async () => {
    const { env, root } = await installed()
    const before = snapshot(root)
    const state = join(root, 'state')
    chmodSync(state, 0o500)
    let a
    try {
      a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')] })
    } finally {
      chmodSync(state, 0o700)
    }
    assert.equal(a.exit, EXIT.failed)
    assert.match(a.error.message, /^switch failed: .*installation\.json/)
    assert.match(a.error.message, new RegExp(`Switched back to ${ACTIVE.replaceAll('.', '\\.')}`))
    assert.deepEqual(readInstallationRecord(root), before.record)
    assert.deepEqual(readdirSync(state).filter((n) => n.startsWith('installation.json')), ['installation.json'], 'no half-written record is left beside it')
    assert.deepEqual(versionsOf(root), [ACTIVE, '1.4.0'].sort())
  })

  test('the record is written only after acceptance, never before the recreate', async () => {
    const { env, root } = await installed()
    const seen = []
    const docker = fakeDocker({ up: () => { seen.push(readInstallationRecord(root).activeVersion); return { ok: true, stdout: '', stderr: '' } } })
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [release('1.4.0')], docker })
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    assert.deepEqual(seen, [ACTIVE])
    assert.equal(readInstallationRecord(root).activeVersion, '1.4.0')
  })

  test('the re-adoption wait has a bound', () => {
    assert.ok(READOPTION_TIMEOUT_MS >= 60_000 && READOPTION_TIMEOUT_MS <= 300_000)
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
    assert.equal(a.exit, EXIT.ok, a.error?.stack)
    assert.match(a.out, /selected 1\.5\.0-rc\.1, the exact prerelease requested/)
    assert.equal(readInstallationRecord(root).activeVersion, '1.5.0-rc.1')
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
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), targets: [target], probes: { deps: { releaseProbes: { ...releaseProbesFor(target), releaseManifest: async () => releaseIn(scratch, { version: '1.4.0', digests: { ...DIGESTS, daemon: `sha256:${'9'.repeat(64)}` } }).text } } } })
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

  // Since #891 the tailnet is the install's to join; here it is inspected
  // only, inside preflight, and a logged-out node is a refusal that names
  // `curia install`. Nothing is brought up.
  test('a node that is logged out of its tailnet is refused at preflight, inspect-only', async () => {
    const { env, root } = await installed()
    const tailscale = fakeTailscale({ status: loggedOutStatus() })
    const a = await attempt({ env, root, index: indexOf({ stable: '1.4.0' }), probes: { deps: { tailscale } } })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^preflight: this node is not logged in to a tailnet \(NeedsLogin\)\. Run 'curia install'/)
    assert.ok(tailscale.calls.every((c) => c[0] === 'status'), 'only reads')
    assert.ok(!a.out.includes('stable-release index'))
  })
})

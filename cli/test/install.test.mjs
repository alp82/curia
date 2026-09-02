import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { INSTALL_STEPS, APP_SERVE_PORT, runInstall } from '../src/install.mjs'
import { runCli } from '../src/cli.mjs'
import { commands, packageVersion } from '../src/commands.mjs'
import { EXIT, Refusal } from '../src/exit.mjs'
import { SERVICES, serviceLayout } from '../src/layout.mjs'
import { readInstallationRecord, versionPaths } from '../src/root.mjs'
import { launcherPath } from '../src/launcher.mjs'
import { composeEnvPath } from '../src/compose.mjs'
import { imageReference } from '../src/bundle.mjs'
import { DIGESTS, fakeDocker, fakeTailscale, healthy, hostProbes, loggedOutStatus, LOGIN_URL, nodeStatus, release as releaseIn, releaseProbesFor, stageOf as stageIn } from './fixtures/install.mjs'

const VERSION = packageVersion

// ---------------------------------------------------------------------------
// Fixtures: one packaged release and the stage the bootstrap hands over.

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'curia-install-')) })
after(() => rmSync(scratch, { recursive: true, force: true }))

const release = ({ version = VERSION } = {}) => releaseIn(scratch, { version })
const stageOf = (r, options) => stageIn(scratch, r, options)

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

// One installation attempt through the command's own seam.
async function attempt({ home, root, stage, mode = 'install', args = [], r, docker = fakeDocker(), tailscale = fakeTailscale(), probes = {} }) {
  const io = capture()
  const env = { HOME: home, USER: 'operator', CURIA_ROOT: root, ...(stage ? { CURIA_STAGE: stage } : {}) }
  let time = 0
  const deps = { hostProbes: hostProbes(probes.host), releaseProbes: releaseProbesFor(r), docker, tailscale, sleep: async (ms) => { time += ms }, now: () => time }
  let exit
  let error = null
  try {
    exit = await runInstall({ env, args, stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root, mode }, deps)
  } catch (e) {
    error = e
    exit = e instanceof Refusal ? EXIT.refused : EXIT.failed
  }
  return { exit, error, out: io.out(), err: io.err(), docker, tailscale }
}

function fresh() {
  const home = mkdtempSync(join(scratch, 'home-'))
  return { home, root: join(home, '.local', 'share', 'curia') }
}

// ---------------------------------------------------------------------------

describe('the named steps', () => {
  test('are one linear sequence', () => {
    assert.deepEqual(INSTALL_STEPS, ['preflight', 'root', 'tailnet', 'stage', 'activate', 'start', 'health'])
  })

  test('the app address uses the Curia app port from config/curia.yaml', () => {
    assert.equal(APP_SERVE_PORT, 8445)
  })
})

describe('clean install', () => {
  test('installs one version, activates it, starts the project, waits for health, and reports the app', async () => {
    const r = release()
    const { home, root } = fresh()
    const a = await attempt({ home, root, stage: stageOf(r), r })
    assert.equal(a.error, null, a.error?.stack)
    assert.equal(a.exit, EXIT.ok)

    // The root and its seven boundaries, owner-only.
    for (const name of ['config', 'secrets', 'state', 'work', 'versions', 'cache', 'run']) {
      assert.equal(statSync(join(root, name)).mode & 0o777, 0o700, `${name}/ is 0700`)
    }
    // The operator configuration the first release fixes.
    assert.match(readFileSync(join(root, 'config', 'config.yaml'), 'utf8'), /^max_concurrent: 4$/m)
    // The record names the version, and one version is installed.
    const record = readInstallationRecord(root)
    assert.equal(record.activeVersion, VERSION)
    assert.match(record.installationId, /^[0-9a-f]{32}$/)
    assert.deepEqual(readdirSync(join(root, 'versions')), [VERSION])
    const paths = versionPaths(root, VERSION)
    for (const p of [paths.node, paths.cli, paths.manifest, paths.package, paths.bundleArchive, paths.bundleChecksum, paths.bundle]) {
      assert.ok(existsSync(p), `${p} is installed`)
    }
    assert.equal(readFileSync(paths.bundle, 'utf8'), r.compose)
    assert.equal(readFileSync(paths.package).equals(r.tarball), true, 'the tarball is retained unchanged')
    assert.ok(statSync(paths.node).mode & 0o100, 'the runtime stays executable')
    assert.equal(statSync(paths.bundle).mode & 0o222, 0, 'installed artifacts are read-only')
    // The launcher, with the root written in.
    const launcher = launcherPath({ HOME: home })
    assert.equal(statSync(launcher).mode & 0o777, 0o755)
    assert.match(readFileSync(launcher, 'utf8'), new RegExp(`^CURIA_ROOT='${root}'$`, 'm'))
    // The Compose environment and the mount sources that must exist before `up`.
    assert.equal(readFileSync(composeEnvPath(root), 'utf8'), `CURIA_ROOT=${root}\nCURIA_UID=${process.getuid()}\nCURIA_GID=${process.getgid()}\nDOCKER_GID=988\nCURIA_INSTALLATION_ID=${record.installationId}\n`)
    const layout = serviceLayout(root)
    for (const dir of [layout.home, layout.overseerRepos, layout.overseerTokens, layout.overseerConfigDir]) {
      assert.ok(statSync(dir).isDirectory(), `${dir} exists before up`)
      assert.equal(statSync(dir).mode & 0o777, 0o700)
    }
    // Docker was driven against the installed bundle, in order: the four
    // service images through Compose, the agent image by its own digest, the
    // project up, then health.
    assert.deepEqual(a.docker.verbs(), ['pull', 'image pull', 'up', 'ps'])
    assert.ok(a.docker.calls.filter((c) => c[0] === 'compose').every((c) => c[2] === composeEnvPath(root) && c[4] === paths.bundle))
    assert.deepEqual(a.docker.calls.find((c) => c[0] === 'image'), ['image', 'pull', '--quiet', imageReference('agent', DIGESTS.agent)])
    // The steps and the completion.
    for (const [i, step] of INSTALL_STEPS.entries()) assert.match(a.out, new RegExp(`^\\[${i + 1}/${INSTALL_STEPS.length}\\] ${step}\\b`, 'm'), `prints step ${step}`)
    assert.match(a.out, new RegExp(`Curia ${VERSION.replaceAll('.', '\\.')} is installed and running`))
    assert.match(a.out, /  node name:\s+host\n  Curia app:\s+https:\/\/host\.tail1234\.ts\.net:8445\/\n/, 'the completion names the node beside the app address')
    assert.match(a.out, /integration setup/)
    // The tailnet step said which name was chosen, found the node logged in
    // under another one, and said that the existing name wins.
    assert.match(a.out, /\[3\/7\] tailnet\nthe node name is curia, chosen with --name\nnode host \(host\.tail1234\.ts\.net\) is logged in to the tailnet\nthis node is named host, not curia\. The existing name wins/)
    assert.ok(a.tailscale.calls.every((c) => c[0] !== 'up'), 'a logged-in node is never brought up again')
  })

  test('the stage is left for the bootstrap to remove; nothing is moved out of it', async () => {
    const r = release()
    const { home, root } = fresh()
    const stage = stageOf(r)
    const a = await attempt({ home, root, stage, r })
    assert.equal(a.exit, EXIT.ok)
    assert.ok(existsSync(join(stage, 'cli.tgz')) && existsSync(join(stage, 'node', 'bin', 'node')))
  })
})

describe('refusals before anything changes', () => {
  test('a refused host stops at preflight and creates no root', async () => {
    const r = release()
    const { home, root } = fresh()
    const a = await attempt({ home, root, stage: stageOf(r), r, probes: { host: { arch: () => 'arm64' } } })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^preflight: /)
    assert.equal(existsSync(root), false)
    assert.equal(existsSync(launcherPath({ HOME: home })), false)
  })

  test('a stage whose package is another version than this interface is refused', async () => {
    const r = release({ version: '9.9.9' })
    const { home, root } = fresh()
    const a = await attempt({ home, root, stage: stageOf(r), r })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^stage: [\s\S]*9\.9\.9/)
    assert.equal(existsSync(join(root, 'versions', '9.9.9')), false)
  })

  test('a substituted bundle in the stage is refused and nothing lands under versions/', async () => {
    const r = release()
    const { home, root } = fresh()
    const a = await attempt({ home, root, stage: stageOf(r, { tamper: 'bundle' }), r })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^stage: [\s\S]*bundle checksum/)
    assert.deepEqual(readdirSync(join(root, 'versions')), [])
    assert.equal(existsSync(launcherPath({ HOME: home })), false)
    // The early record makes the root recognizable on the next run.
    assert.equal(readInstallationRecord(root).activeVersion, VERSION)
  })

  test('without a stage and without an installed version there is nothing to install', async () => {
    const r = release()
    const { home, root } = fresh()
    const a = await attempt({ home, root, r })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /stage: .*run the bootstrap/i)
  })

  test('reinstall refuses a root that holds no installation', async () => {
    const r = release()
    const { home, root } = fresh()
    const a = await attempt({ home, root, stage: stageOf(r), r, mode: 'reinstall' })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /root: .*nothing to reinstall/)
    assert.equal(existsSync(root), false)
  })
})

describe('preserved-root reinstall', () => {
  test('keeps the installation ID, configuration, secrets, state, and work, and replaces versions/', async () => {
    const r = release()
    const { home, root } = fresh()
    const first = await attempt({ home, root, stage: stageOf(r), r })
    assert.equal(first.exit, EXIT.ok)
    const before = readInstallationRecord(root)

    // What integration setup and running work left behind.
    writeFileSync(join(root, 'config', 'config.yaml'), 'max_concurrent: 7\n', { mode: 0o600 })
    writeFileSync(join(root, 'secrets', 'discord-bot-token'), 'super-secret-token\n', { mode: 0o600 })
    writeFileSync(join(root, 'state', 'events.db'), 'journal', { mode: 0o600 })
    mkdirSync(join(root, 'work', 'repos', 'curia-42'), { recursive: true })
    writeFileSync(join(root, 'work', 'repos', 'curia-42', 'file'), 'resumable')
    mkdirSync(join(root, 'versions', '0.0.1'))
    writeFileSync(join(root, 'cache', 'stale'), 'x')

    const again = await attempt({ home, root, stage: stageOf(r), r, mode: 'reinstall' })
    assert.equal(again.error, null, again.error?.stack)
    assert.equal(again.exit, EXIT.ok)
    const after = readInstallationRecord(root)
    assert.equal(after.installationId, before.installationId)
    assert.equal(after.activeVersion, VERSION)
    assert.equal(readFileSync(join(root, 'config', 'config.yaml'), 'utf8'), 'max_concurrent: 7\n')
    assert.equal(readFileSync(join(root, 'secrets', 'discord-bot-token'), 'utf8'), 'super-secret-token\n')
    assert.equal(readFileSync(join(root, 'state', 'events.db'), 'utf8'), 'journal')
    assert.equal(readFileSync(join(root, 'work', 'repos', 'curia-42', 'file'), 'utf8'), 'resumable')
    assert.deepEqual(readdirSync(join(root, 'versions')), [VERSION], 'exactly one version remains')
    assert.equal(readFileSync(versionPaths(root, VERSION).bundle, 'utf8'), r.compose)
    assert.doesNotMatch(again.out + again.err, /super-secret-token/)
    assert.match(again.out, /reinstall/)
  })

  test('the bootstrap always hands off install; install over an installed root reinstalls', async () => {
    const r = release()
    const { home, root } = fresh()
    assert.equal((await attempt({ home, root, stage: stageOf(r), r })).exit, EXIT.ok)
    const id = readInstallationRecord(root).installationId
    const again = await attempt({ home, root, stage: stageOf(r), r })
    assert.equal(again.exit, EXIT.ok)
    assert.equal(readInstallationRecord(root).installationId, id)
    assert.match(again.out, /\[2\/7\] root\nreinstalling/)
  })
})

describe('a partial failure and the retry', () => {
  test('a failed activation names the step and the rerun; the rerun resumes there', async () => {
    const r = release()
    const { home, root } = fresh()
    // ~/.local/bin is a file, so the launcher cannot be written.
    mkdirSync(join(home, '.local'), { recursive: true })
    writeFileSync(join(home, '.local', 'bin'), 'in the way')
    const failed = await attempt({ home, root, stage: stageOf(r), r })
    assert.equal(failed.exit, EXIT.failed)
    assert.match(failed.error.message, /^activate failed: /)
    assert.match(failed.error.message, /run the bootstrap again/)
    assert.deepEqual(failed.docker.verbs(), [], 'nothing was started')
    assert.deepEqual(readdirSync(join(root, 'versions')), [VERSION], 'the staged version stays')

    rmSync(join(home, '.local', 'bin'))
    const again = await attempt({ home, root, stage: stageOf(r), r })
    assert.equal(again.error, null, again.error?.stack)
    assert.equal(again.exit, EXIT.ok)
    assert.ok(existsSync(launcherPath({ HOME: home })))
    assert.deepEqual(again.docker.verbs(), ['pull', 'image pull', 'up', 'ps'])
  })

  test('a service that stays unhealthy names the health step and the service, and a launcher rerun without a stage resumes', async () => {
    const r = release()
    const { home, root } = fresh()
    const docker = fakeDocker({ ps: { ok: true, stdout: healthy(SERVICES, { daemon: { State: 'exited', Health: '', ExitCode: 1 } }) } })
    const failed = await attempt({ home, root, stage: stageOf(r), r, docker })
    assert.equal(failed.exit, EXIT.failed)
    assert.match(failed.error.message, /^health failed: daemon exited with code 1/)
    assert.match(failed.error.message, new RegExp(`'${launcherPath({ HOME: home })} install'`))
    assert.equal(readInstallationRecord(root).activeVersion, VERSION, 'the activation stands')

    // The rerun comes through the launcher: no stage, the installed version.
    const again = await attempt({ home, root, r })
    assert.equal(again.error, null, again.error?.stack)
    assert.equal(again.exit, EXIT.ok)
    assert.match(again.out, /\[4\/7\] stage\n.*already installed/)
    assert.deepEqual(again.docker.verbs(), ['pull', 'image pull', 'up', 'ps'])
  })

  test('a failed pull names the start step and quotes docker', async () => {
    const r = release()
    const { home, root } = fresh()
    const docker = fakeDocker({ pull: { ok: false, stdout: '', stderr: 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host', code: 1 } })
    const failed = await attempt({ home, root, stage: stageOf(r), r, docker })
    assert.equal(failed.exit, EXIT.failed)
    assert.match(failed.error.message, /^start failed: docker compose .* pull failed:/)
    assert.match(failed.error.message, /no such host/)
  })

  test('a failed pull of the agent image names the start step and the image, and the project is not brought up', async () => {
    const r = release()
    const { home, root } = fresh()
    const docker = fakeDocker({ 'image pull': { ok: false, stdout: '', stderr: 'Error response from daemon: manifest unknown', code: 1 } })
    const failed = await attempt({ home, root, stage: stageOf(r), r, docker })
    assert.equal(failed.exit, EXIT.failed)
    assert.match(failed.error.message, new RegExp(`^start failed: docker image pull --quiet ${imageReference('agent', DIGESTS.agent).replaceAll('.', '\\.')} failed:`))
    assert.match(failed.error.message, /manifest unknown/)
    assert.ok(!docker.verbs().includes('up'), 'nothing is started without the agent image')
  })
})

describe('the tailnet step', () => {
  test('a node that is not logged in joins the tailnet as --name before anything is downloaded, with the login link as the one action', async () => {
    const r = release()
    const { home, root } = fresh()
    const tailscale = fakeTailscale({ status: loggedOutStatus(), up: { after: 2, label: 'curia-box' } })
    const a = await attempt({ home, root, stage: stageOf(r), r, args: ['--name', 'curia-box'], tailscale })
    assert.equal(a.error, null, a.error?.stack)
    assert.equal(a.exit, EXIT.ok)
    assert.deepEqual(tailscale.calls.filter((c) => c[0] === 'up'), [['up', '--hostname', 'curia-box', '--timeout', '10m']])
    assert.match(a.out, /\[3\/7\] tailnet\nthe node name is curia-box, chosen with --name\nthis node is not logged in to a tailnet; joining it as curia-box/)
    assert.match(a.out, new RegExp(`Open this link on a device where you are signed in to Tailscale and approve this machine:\\n  ${LOGIN_URL.replaceAll('.', '\\.')}`))
    assert.match(a.out, /logged in as node curia-box \(curia-box\.tail1234\.ts\.net\)/)
    assert.match(a.out, /  node name:\s+curia-box\n  Curia app:\s+https:\/\/curia-box\.tail1234\.ts\.net:8445\/\n/)
    // The login came before the stage: nothing was placed until the host could be reached.
    const at = (step) => a.out.indexOf(`] ${step}\n`)
    assert.ok(a.out.indexOf(LOGIN_URL) > at('tailnet') && a.out.indexOf(LOGIN_URL) < at('stage'))
  })

  test('--name defaults to curia, takes --name=<label> too, and refuses anything that is not a MagicDNS label before anything runs', async () => {
    const r = release()
    const { home, root } = fresh()
    const eq = fakeTailscale({ status: loggedOutStatus(), up: { after: 1, label: 'box-2' } })
    assert.equal((await attempt({ home, root, stage: stageOf(r), r, args: ['--name=box-2'], tailscale: eq })).exit, EXIT.ok)
    assert.deepEqual(eq.calls.find((c) => c[0] === 'up'), ['up', '--hostname', 'box-2', '--timeout', '10m'])
    for (const bad of [['--name', 'Curia.sh'], ['--name', '-box'], ['--name'], ['--name', 'x'.repeat(64)], ['--frobnicate'], ['extra']]) {
      const io = capture()
      const exit = await runCli({ argv: ['install', ...bad], env: { CURIA_ROOT: '/nonexistent/curia', HOME: '/nonexistent' }, stdout: io.stdout, stderr: io.stderr, commands })
      assert.equal(exit, EXIT.usage, bad.join(' '))
      assert.match(io.err(), /^curia install: /)
    }
    const io = capture()
    await runCli({ argv: ['install', '--name', 'Curia.sh'], env: { CURIA_ROOT: '/nonexistent/curia', HOME: '/nonexistent' }, stdout: io.stdout, stderr: io.stderr, commands })
    assert.match(io.err(), /Curia\.sh is not a machine name\. Use lowercase letters, digits, and hyphens/)
  })

  test('a login that does not arrive fails the tailnet step, the rerun lands there, and nothing was staged', async () => {
    const r = release()
    const { home, root } = fresh()
    const failed = await attempt({ home, root, stage: stageOf(r), r, tailscale: fakeTailscale({ status: loggedOutStatus(), up: { after: 100_000 } }) })
    assert.equal(failed.exit, EXIT.failed)
    assert.match(failed.error.message, /^tailnet failed: no login arrived within 10 minutes/)
    assert.match(failed.error.message, /run the bootstrap again; it resumes at tailnet/)
    assert.deepEqual(readdirSync(join(root, 'versions')), [], 'nothing was staged before the host could be reached')
    assert.deepEqual(failed.docker.verbs(), [])
    // The rerun finds the node logged in and continues.
    const again = await attempt({ home, root, stage: stageOf(r), r })
    assert.equal(again.error, null, again.error?.stack)
    assert.match(again.out, /\[3\/7\] tailnet\nthe node name is curia, chosen with --name\nnode host/)
  })

  test('a user who may not operate Tailscale is refused at the tailnet step with the exact command, on the login and after it', async () => {
    const r = release()
    const { home, root } = fresh()
    const onUp = await attempt({ home, root, stage: stageOf(r), r, tailscale: fakeTailscale({ status: loggedOutStatus(), up: { denied: true } }) })
    assert.equal(onUp.exit, EXIT.refused)
    assert.match(onUp.error.message, /^tailnet: your user may not operate Tailscale on this host \(Access denied/)
    assert.match(onUp.error.message, /Run `sudo tailscale set --operator=operator` and run the command again/)
    const onServe = await attempt({ home, root, stage: stageOf(r), r, tailscale: fakeTailscale({ servePermitted: false }) })
    assert.equal(onServe.exit, EXIT.refused)
    assert.match(onServe.error.message, /^tailnet: your user may not operate Tailscale on this host \(Access denied: serve config denied\)\. Run `sudo tailscale set --operator=operator`/)
    assert.deepEqual(readdirSync(join(root, 'versions')), [])
  })

  test('a tailnet without HTTPS certificates is refused at the tailnet step naming the HTTPS setting', async () => {
    const r = release()
    const { home, root } = fresh()
    const a = await attempt({ home, root, stage: stageOf(r), r, tailscale: fakeTailscale({ status: { ...nodeStatus(), CertDomains: [] } }) })
    assert.equal(a.exit, EXIT.refused)
    assert.match(a.error.message, /^tailnet: the tailnet issues no HTTPS certificate for this node/)
    assert.match(a.error.message, /https:\/\/login\.tailscale\.com\/admin\/dns/)
  })

  test('reinstall runs the step inspect-only: a logged-out node is refused naming curia install, and nothing is brought up', async () => {
    const r = release()
    const { home, root } = fresh()
    assert.equal((await attempt({ home, root, stage: stageOf(r), r })).exit, EXIT.ok)
    const tailscale = fakeTailscale({ status: loggedOutStatus() })
    const again = await attempt({ home, root, stage: stageOf(r), r, mode: 'reinstall', tailscale })
    assert.equal(again.exit, EXIT.refused)
    assert.match(again.error.message, /^tailnet: this node is not logged in to a tailnet \(NeedsLogin\)\. Run 'curia install'/)
    assert.ok(tailscale.calls.every((c) => c[0] === 'status'), 'reinstall never runs tailscale up')
  })
})

describe('through the command table', () => {
  test('install and reinstall are wired and refuse root execution before anything else', async () => {
    for (const name of ['install', 'reinstall']) {
      const io = capture()
      const exit = await runCli({ argv: [name], env: { CURIA_ROOT: '/nonexistent/curia', HOME: '/nonexistent' }, uid: 0, stdout: io.stdout, stderr: io.stderr, commands })
      assert.equal(exit, EXIT.refused)
      assert.match(io.err(), new RegExp(`^curia ${name}: preflight: this command runs as root`))
    }
  })

  test('the summaries name what each command does, and install declares its option', () => {
    assert.match(commands.install.summary, /Install/)
    assert.match(commands.install.summary, /--name/)
    assert.equal(commands.install.options, true)
    assert.equal(commands.reinstall.options, undefined)
    assert.match(commands.reinstall.summary, /preserved/)
  })
})

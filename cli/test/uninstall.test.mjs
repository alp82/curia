import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRESERVED_BOUNDARIES, REMOVED_BOUNDARIES, UNINSTALL_STEPS, externalChecklist, purgeCommand, reinstallCommand, runUninstall } from '../src/uninstall.mjs'
import { runInstall } from '../src/install.mjs'
import { runCli } from '../src/cli.mjs'
import { commands, packageVersion } from '../src/commands.mjs'
import { BOOTSTRAP_COMMAND } from '../src/acquire.mjs'
import { INSTALLATION_LABEL } from '../src/bundle.mjs'
import { EXIT, Refusal } from '../src/exit.mjs'
import { launcherPath } from '../src/launcher.mjs'
import { SERVICES, serviceLayout } from '../src/layout.mjs'
import { lockPath } from '../src/lock.mjs'
import { BOUNDARIES, readInstallationRecord, versionPaths } from '../src/root.mjs'
import { readTailscaleRecord, writeTailscaleRecord } from '../src/tailscale.mjs'
import { fakeDocker, fakeDockerHost, fakeTailscale, hostProbes, release as releaseIn, releaseProbesFor, stageOf as stageIn } from './fixtures/install.mjs'

const VERSION = packageVersion
const APP_ROUTE = { https: 8445, target: 'http://127.0.0.1:4273' }
const OTHER_ROUTE = { https: 443, target: 'http://127.0.0.1:3000' }
const SECRET = ['fixture', 'discord', 'token', 'value'].join('-')
const APP_ID = '424242'

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'curia-uninstall-')) })
after(() => rmSync(scratch, { recursive: true, force: true }))

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

// An installed root the way `curia install` leaves one, with what
// integration setup and running work leave behind: one file per preserved
// directory, a secret, the Tailscale record with Curia's Serve route, the
// Discord facts, and the GitHub App secret (an ID and a key).
async function installed({ home = mkdtempSync(join(scratch, 'home-')), root = join(home, '.local', 'share', 'curia') } = {}) {
  const r = releaseIn(scratch, { version: VERSION })
  const io = capture()
  const env = { HOME: home, CURIA_ROOT: root, CURIA_STAGE: stageIn(scratch, r) }
  const deps = { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker: fakeDocker(), tailscale: fakeTailscale(), sleep: async () => {}, now: () => 0 }
  const exit = await runInstall({ env, stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root, mode: 'install' }, deps)
  assert.equal(exit, EXIT.ok, io.err())
  const record = readInstallationRecord(root)

  writeFileSync(join(root, 'config', 'config.yaml'), 'max_concurrent: 7\n', { mode: 0o600 })
  writeFileSync(join(root, 'secrets', 'discord-bot-token'), `${SECRET}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'secrets', 'github-app.json'), JSON.stringify({ id: APP_ID, pem: `-----BEGIN ${'PRIVATE'} KEY-----\nfixture\n` }), { mode: 0o600 })
  writeFileSync(join(root, 'state', 'events.db'), 'journal', { mode: 0o600 })
  writeFileSync(join(root, 'state', 'discord.json'), JSON.stringify({ allowed_users: ['1'], guild_id: '987', channel: 'curia' }), { mode: 0o600 })
  writeTailscaleRecord(join(root, 'state'), { operator: { login: 'alp@github', confirmed_at: '2026-09-01T00:00:00.000Z' }, machine_name: 'curia.sh', serve: [APP_ROUTE] })
  mkdirSync(join(root, 'work', 'repos', 'curia-42'), { recursive: true })
  writeFileSync(join(root, 'work', 'repos', 'curia-42', 'file'), 'resumable')
  writeFileSync(join(root, 'cache', 'home', 'tool-cache'), 'x')
  writeFileSync(join(root, 'run', 'overseer-tokens', 'owner'), 'renewable', { mode: 0o600 })
  return { home, root, r, record, id: record.installationId, launcher: launcherPath(env) }
}

// The Docker host of an installation with a live agent, beside what is not
// Curia's: another installation, an operator's own container, the default
// network, and a volume without a label.
function dockerHostOf(id, { fail } = {}) {
  const mine = { [INSTALLATION_LABEL]: id }
  const theirs = { [INSTALLATION_LABEL]: 'f'.repeat(32) }
  return fakeDockerHost({
    fail,
    containers: [
      ...SERVICES.map((s, i) => ({ id: `c${i}`, name: `curia-${s}-1`, labels: { ...mine, 'com.docker.compose.project': 'curia' } })),
      { id: 'c9', name: 'curia-42', labels: { ...mine, 'curia.session': 'curia-42' } },
      { id: 'c8', name: 'curia-41', state: 'exited', labels: { ...mine, 'curia.session': 'curia-41' } },
      { id: 'x1', name: 'curia-daemon-1', labels: theirs },
      { id: 'x2', name: 'postgres', labels: {} },
    ],
    networks: [
      { id: 'n1', name: 'curia_default', labels: mine },
      { id: 'n2', name: 'bridge', labels: {} },
      { id: 'n3', name: 'curia_default', labels: theirs },
    ],
    volumes: [
      { name: 'curia_tmux-sock', labels: mine },
      { name: 'curia-agent-npm-cache', labels: mine },
      { name: 'curia-agent-browsers', labels: mine },
      { name: 'pgdata', labels: {} },
      { name: 'curia_tmux-sock-other', labels: theirs },
    ],
  })
}

async function uninstall({ home, root, docker, tailscale, uid = process.getuid() }) {
  const io = capture()
  let exit
  let error = null
  try {
    exit = await runUninstall({ env: { HOME: home, CURIA_ROOT: root }, args: [], stdout: io.stdout, stderr: io.stderr, uid, gid: process.getgid(), root }, { docker, tailscale })
  } catch (e) {
    error = e
    exit = e instanceof Refusal ? EXIT.refused : EXIT.failed
  }
  return { exit, error, out: io.out(), err: io.err() }
}

const assertPreserved = (root, id) => {
  assert.equal(readInstallationRecord(root).installationId, id)
  assert.equal(readFileSync(join(root, 'config', 'config.yaml'), 'utf8'), 'max_concurrent: 7\n')
  assert.equal(readFileSync(join(root, 'secrets', 'discord-bot-token'), 'utf8'), `${SECRET}\n`)
  assert.equal(readFileSync(join(root, 'state', 'events.db'), 'utf8'), 'journal')
  assert.equal(readFileSync(join(root, 'work', 'repos', 'curia-42', 'file'), 'utf8'), 'resumable')
  assert.deepEqual(readTailscaleRecord(join(root, 'state')).serve, [APP_ROUTE], 'the record is state, and state is preserved')
}

describe('the named steps', () => {
  test('are one linear sequence', () => {
    assert.deepEqual([...UNINSTALL_STEPS], ['preflight', 'docker', 'routes', 'files'])
    assert.deepEqual([...PRESERVED_BOUNDARIES, ...REMOVED_BOUNDARIES].sort(), [...BOUNDARIES].sort(), 'every boundary is preserved or removed')
  })
})

describe('an uninstall over an installed root', () => {
  test('removes the labelled resources, the routes, the runnable files, and the launcher, and keeps the installation', async () => {
    const { home, root, id, launcher } = await installed()
    const docker = dockerHostOf(id)
    const tailscale = fakeTailscale({ serving: [APP_ROUTE, OTHER_ROUTE] })
    assert.ok(existsSync(launcher))

    const r = await uninstall({ home, root, docker, tailscale })
    assert.equal(r.error, null, r.error?.stack)
    assert.equal(r.exit, EXIT.ok)
    assert.match(r.out, /\[1\/4\] preflight\n.*\n\[2\/4\] docker\n/s)
    assert.match(r.out, /\[3\/4\] routes\n/)
    assert.match(r.out, /\[4\/4\] files\n/)

    // Docker: this installation's containers stopped (the running ones), then
    // every container, the network, and the volumes removed, by label.
    const stop = docker.calls.find((c) => c[0] === 'stop')
    assert.deepEqual(stop.slice(1).sort(), ['c0', 'c1', 'c2', 'c3', 'c4', 'c9'], 'only the running labelled containers are stopped')
    const rm = docker.calls.find((c) => c[0] === 'rm')
    assert.deepEqual(rm.slice(3).sort(), ['c0', 'c1', 'c2', 'c3', 'c4', 'c8', 'c9'])
    assert.deepEqual(docker.calls.find((c) => c[0] === 'network' && c[1] === 'rm').slice(2), ['n1'])
    assert.deepEqual(docker.calls.find((c) => c[0] === 'volume' && c[1] === 'rm').slice(3).sort(), ['curia-agent-browsers', 'curia-agent-npm-cache', 'curia_tmux-sock'])
    for (const c of docker.calls.filter((c) => ['ps', 'network', 'volume'].includes(c[0]) && c.includes('--filter'))) {
      assert.equal(c[c.indexOf('--filter') + 1], `label=${INSTALLATION_LABEL}=${id}`, 'every listing is by the installation label')
    }
    assert.ok(!docker.calls.some((c) => c.includes('image') || c.includes('rmi')), 'the images are left for purge')
    assert.ok(!docker.calls.some((c) => c[0] === 'compose'), 'nothing goes through the Compose files, which a partial cleanup may have removed')

    // What is not Curia's is still there.
    assert.deepEqual(docker.host.containers.map((c) => c.id).sort(), ['x1', 'x2'])
    assert.deepEqual(docker.host.networks.map((n) => n.id).sort(), ['n2', 'n3'])
    assert.deepEqual(docker.host.volumes.map((v) => v.name).sort(), ['curia_tmux-sock-other', 'pgdata'])

    // Tailscale: only the recorded route is turned off.
    assert.deepEqual(tailscale.calls, [['serve', 'status', '--json'], ['serve', '--https=8445', 'off']])
    assert.deepEqual(tailscale.serving(), [OTHER_ROUTE])

    // Files: the runnable directories are emptied, the launcher is gone, the
    // installation is preserved.
    for (const name of REMOVED_BOUNDARIES) assert.deepEqual(readdirSync(join(root, name)), [], `${name}/ is empty`)
    assert.ok(!existsSync(lockPath(root)), 'the lock is released')
    assert.ok(!existsSync(launcher), 'the launcher is removed')
    assertPreserved(root, id)
    assert.equal(readFileSync(join(root, 'secrets', 'github-app.json'), 'utf8').includes(APP_ID), true)

    // The completion message.
    assert.match(r.out, new RegExp(`Curia is uninstalled\\. The installation at ${root} is preserved\\.`))
    assert.match(r.out, /kept:\s+config\/, secrets\/, state\/, work\//)
    assert.match(r.out, /images:\s+kept; 'curia purge' removes them/)
    assert.match(r.out, new RegExp(`reinstall: ${escape(BOOTSTRAP_COMMAND)}\n`))
    assert.match(r.out, new RegExp(`purge:\\s+${escape(BOOTSTRAP_COMMAND)} --purge\n`))
    assert.match(r.out, new RegExp(`GitHub App ${APP_ID}`))
    assert.match(r.out, /Discord bot, server 987, channel curia/)
    assert.match(r.out, /Tailscale node curia\.sh/)
    assert.doesNotMatch(r.out + r.err, new RegExp(SECRET))
    assert.doesNotMatch(r.out + r.err, /BEGIN|fixture\n/)
  })

  test('names a nondefault root in the reinstall and purge commands', async () => {
    const home = mkdtempSync(join(scratch, 'home-'))
    const root = join(home, 'srv', 'curia')
    const { id } = await installed({ home, root })
    const r = await uninstall({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale({ serving: [APP_ROUTE] }) })
    assert.equal(r.exit, EXIT.ok, r.error?.stack)
    assert.match(r.out, new RegExp(`reinstall: ${escape(BOOTSTRAP_COMMAND)} --root ${root}\n`))
    assert.match(r.out, new RegExp(`purge:\\s+${escape(BOOTSTRAP_COMMAND)} --purge --root ${root}\n`))
    assert.equal(reinstallCommand({ env: { HOME: home }, root }), `${BOOTSTRAP_COMMAND} --root ${root}`)
    assert.equal(purgeCommand({ env: { HOME: home }, root: join(home, '.local', 'share', 'curia') }), `${BOOTSTRAP_COMMAND} --purge`)
  })

  test('is quiet and changes nothing when repeated', async () => {
    const { home, root, id } = await installed()
    const docker = dockerHostOf(id)
    const tailscale = fakeTailscale({ serving: [APP_ROUTE] })
    assert.equal((await uninstall({ home, root, docker, tailscale })).exit, EXIT.ok)
    const callsBefore = docker.calls.length

    const again = await uninstall({ home, root, docker, tailscale })
    assert.equal(again.error, null, again.error?.stack)
    assert.equal(again.exit, EXIT.ok)
    assert.match(again.out, new RegExp(`no container, network, or volume carries the label of installation ${id}`))
    assert.match(again.out, /no recorded Serve route is standing; nothing to withdraw/)
    assert.match(again.out, /no launcher at/)
    assert.ok(docker.calls.slice(callsBefore).every((c) => ['ps', 'network', 'volume'].includes(c[0]) && !c.includes('rm')), 'the rerun only lists')
    assert.deepEqual(tailscale.calls.filter((c) => c.includes('off')).length, 1, 'the route is turned off once')
    assertPreserved(root, id)
    assert.match(again.out, /Curia is uninstalled\. The installation at/)
  })

  test('a partial cleanup names the failed step and the rerun; the rerun finishes it', async () => {
    const { home, root, id, launcher } = await installed()
    const docker = dockerHostOf(id, { fail: { rm: 1 } })
    const tailscale = fakeTailscale({ serving: [APP_ROUTE] })

    const first = await uninstall({ home, root, docker, tailscale })
    assert.equal(first.exit, EXIT.failed)
    assert.match(first.error.message, /^docker failed: docker rm --force --volumes .* failed:\nfake: rm refused this time/)
    assert.match(first.error.message, new RegExp(`Run '${launcher} uninstall' to run docker again; the completed steps are kept\\.`))
    assert.ok(existsSync(launcher), 'the launcher is the rerun, so it stays until the last step')
    assert.ok(existsSync(versionPaths(root, VERSION).bundle), 'the files step did not run')
    assert.deepEqual(tailscale.calls, [], 'the routes step did not run')
    assert.ok(!existsSync(lockPath(root)), 'the lock is released on failure')
    assertPreserved(root, id)

    const again = await uninstall({ home, root, docker, tailscale })
    assert.equal(again.error, null, again.error?.stack)
    assert.equal(again.exit, EXIT.ok)
    assert.match(again.out, /stopping 0 containers|removing 7 containers/, 'the rerun removes what the first run stopped')
    assert.deepEqual(docker.host.containers.map((c) => c.id).sort(), ['x1', 'x2'])
    assert.deepEqual(tailscale.serving(), [])
    assert.ok(!existsSync(launcher))
    assertPreserved(root, id)
  })

  test('a host without the tailscale command withdraws nothing and says so; a node that does not answer fails the routes step', async () => {
    const { home, root, id } = await installed()
    const missing = await uninstall({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale({ missing: true }) })
    assert.equal(missing.exit, EXIT.ok, missing.error?.stack)
    assert.match(missing.out, /the tailscale command is not on the path, so no Serve route is withdrawn/)

    const other = await installed()
    const broken = await uninstall({ home: other.home, root: other.root, docker: dockerHostOf(other.id), tailscale: fakeTailscale({ broken: true }) })
    assert.equal(broken.exit, EXIT.failed)
    assert.match(broken.error.message, /^routes failed: tailscale serve status failed: failed to connect to local Tailscale service/)
    assert.ok(existsSync(other.launcher), 'the files step did not run')
  })

  test('a launcher that names another root is kept', async () => {
    const { home, root, id, launcher } = await installed()
    const elsewhere = join(home, 'elsewhere')
    writeFileSync(launcher, readFileSync(launcher, 'utf8').replace(`CURIA_ROOT='${root}'`, `CURIA_ROOT='${elsewhere}'`), { mode: 0o755 })
    const r = await uninstall({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale() })
    assert.equal(r.exit, EXIT.ok, r.error?.stack)
    assert.ok(existsSync(launcher))
    assert.match(r.out, /kept the launcher .*: it belongs to another installation root/)
  })

  test('the external checklist names identifiers only, and nothing when there are none', async () => {
    const { root } = await installed()
    const lines = externalChecklist(root, { uid: process.getuid() })
    assert.equal(lines.length, 3)
    assert.doesNotMatch(lines.join('\n'), /fixture|PRIVATE|alp@github/)
    const bare = mkdtempSync(join(scratch, 'bare-'))
    for (const b of ['secrets', 'state']) mkdirSync(join(bare, b), { mode: 0o700 })
    assert.deepEqual(externalChecklist(bare, { uid: process.getuid() }), [])
  })
})

describe('refusals before anything changes', () => {
  test('a root that holds no installation is refused at preflight', async () => {
    const home = mkdtempSync(join(scratch, 'home-'))
    const root = join(home, '.local', 'share', 'curia')
    const docker = dockerHostOf('a'.repeat(32))
    const r = await uninstall({ home, root, docker, tailscale: fakeTailscale() })
    assert.equal(r.exit, EXIT.refused)
    assert.match(r.error.message, /^preflight: .* holds no installation, so there is nothing to uninstall/)
    assert.deepEqual(docker.calls, [])
    assert.ok(!existsSync(root))
  })

  test('root execution is refused through the command table, and an option is a usage error', async () => {
    const io = capture()
    const exit = await runCli({ argv: ['uninstall'], env: { HOME: '/nonexistent', CURIA_ROOT: '/nonexistent/curia' }, stdout: io.stdout, stderr: io.stderr, uid: 0, gid: 0, commands })
    assert.equal(exit, EXIT.refused)
    assert.match(io.err(), /^curia uninstall: preflight: this command runs as root/)

    const usage = capture()
    const code = await runCli({ argv: ['uninstall', '--yes'], env: { HOME: '/nonexistent' }, stdout: usage.stdout, stderr: usage.stderr, commands })
    assert.equal(code, EXIT.usage)
    assert.match(usage.err(), /unknown option: --yes/)
  })

  test('the command table wires uninstall and its summary names what is kept', () => {
    assert.equal(typeof commands.uninstall.run, 'function')
    assert.match(commands.uninstall.summary, /keep config\/, secrets\/, state\/, and work\//)
    assert.ok(!commands.uninstall.options, 'no options')
  })
})

describe('reinstall from the preserved root', () => {
  test('the bootstrap install over an uninstalled root restores a healthy service with the same identity, history, and work', async () => {
    const { home, root, r, id } = await installed()
    assert.equal((await uninstall({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale({ serving: [APP_ROUTE] }) })).exit, EXIT.ok)

    for (const mode of ['install', 'reinstall']) {
      const io = capture()
      const docker = fakeDocker()
      const env = { HOME: home, CURIA_ROOT: root, CURIA_STAGE: stageIn(scratch, r) }
      const deps = { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker, tailscale: fakeTailscale(), sleep: async () => {}, now: () => 0 }
      const exit = await runInstall({ env, stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root, mode }, deps)
      assert.equal(exit, EXIT.ok, io.err())
      assert.match(io.out(), new RegExp(`reinstalling ${escape(VERSION)} over the installation at ${root} \\(installation ${id}\\)`))
      assert.equal(readInstallationRecord(root).installationId, id)
      assert.equal(readInstallationRecord(root).activeVersion, VERSION)
      assert.deepEqual(docker.verbs(), ['pull', 'image pull', 'up', 'ps'])
      assert.match(readFileSync(join(root, 'run', 'compose.env'), 'utf8'), new RegExp(`^CURIA_INSTALLATION_ID=${id}$`, 'm'))
      assert.ok(existsSync(launcherPath(env)), 'the launcher is back')
      assert.ok(existsSync(versionPaths(root, VERSION).bundle))
      const layout = serviceLayout(root)
      for (const dir of [layout.home, layout.overseerRepos, layout.overseerTokens, layout.overseerConfigDir]) assert.ok(existsSync(dir), `${dir} exists for the mounts`)
      assertPreserved(root, id)
      assert.doesNotMatch(io.out() + io.err(), new RegExp(SECRET))
      assert.match(io.out(), /Curia .* is installed and running\./)

      // And it can be uninstalled again.
      assert.equal((await uninstall({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale({ serving: [APP_ROUTE] }) })).exit, EXIT.ok)
    }
  })

  test('a launcher rerun without a stage has nothing to reinstall after an uninstall and names the bootstrap', async () => {
    const { home, root, r, id } = await installed()
    assert.equal((await uninstall({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale() })).exit, EXIT.ok)
    const io = capture()
    const deps = { hostProbes: hostProbes(), releaseProbes: releaseProbesFor(r), docker: fakeDocker(), tailscale: fakeTailscale(), sleep: async () => {}, now: () => 0 }
    await assert.rejects(
      runInstall({ env: { HOME: home, CURIA_ROOT: root }, stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root, mode: 'reinstall' }, deps),
      (e) => e instanceof Refusal && new RegExp(`^stage: no release to install: .*${escape(BOOTSTRAP_COMMAND)}`).test(e.message),
    )
    assert.equal(readInstallationRecord(root).installationId, id)
  })
})

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

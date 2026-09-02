import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PURGE_STEPS, runPurge } from '../src/purge.mjs'
import { runUninstall } from '../src/uninstall.mjs'
import { runInstall } from '../src/install.mjs'
import { runCli } from '../src/cli.mjs'
import { commands, packageVersion } from '../src/commands.mjs'
import { BOOTSTRAP_COMMAND } from '../src/acquire.mjs'
import { IMAGE_REGISTRY, INSTALLATION_LABEL, RELEASE_IMAGES } from '../src/bundle.mjs'
import { EXIT, Refusal } from '../src/exit.mjs'
import { launcherPath } from '../src/launcher.mjs'
import { SERVICES } from '../src/layout.mjs'
import { readInstallationRecord } from '../src/root.mjs'
import { writeTailscaleRecord } from '../src/tailscale.mjs'
import { DIGESTS, fakeDocker, fakeDockerHost, fakeTailscale, hostProbes, release as releaseIn, releaseProbesFor, stageOf as stageIn } from './fixtures/install.mjs'

const VERSION = packageVersion
const APP_ROUTE = { https: 8445, target: 'http://127.0.0.1:4273' }
const OTHER_ROUTE = { https: 443, target: 'http://127.0.0.1:3000' }
const SECRET = ['fixture', 'discord', 'token', 'value'].join('-')
const APP_ID = '424242'
const OTHER_ID = 'f'.repeat(32)

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'curia-purge-')) })
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
// integration setup and running work leave behind.
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
  return { home, root, r, record, id: record.installationId, launcher: launcherPath(env) }
}

const releaseImage = (service) => `${IMAGE_REGISTRY}/${RELEASE_IMAGES[service]}`

// The Docker host of an installation with a live agent, beside what is not
// Curia's: another installation that runs the same daemon image, an
// operator's own container and image, and an agent image whose name starts
// with `curia-` but which is no release image.
function dockerHostOf(id, { fail, shareDaemon = true } = {}) {
  const mine = { [INSTALLATION_LABEL]: id }
  const theirs = { [INSTALLATION_LABEL]: OTHER_ID }
  const image = (service) => `img-${service}`
  return fakeDockerHost({
    fail,
    containers: [
      ...SERVICES.map((s, i) => ({ id: `c${i}`, name: `curia-${s}-1`, image: image(s === 'ttyd' ? 'tmux' : s), labels: { ...mine, 'com.docker.compose.project': 'curia' } })),
      { id: 'c9', name: 'curia-42', image: 'img-agent', labels: { ...mine, 'curia.session': 'curia-42' } },
      { id: 'x1', name: 'curia-daemon-1', image: shareDaemon ? 'img-daemon' : 'img-old-daemon', labels: theirs },
      { id: 'x2', name: 'postgres', image: 'img-postgres', labels: {} },
    ],
    networks: [
      { id: 'n1', name: 'curia_default', labels: mine },
      { id: 'n2', name: 'bridge', labels: {} },
      { id: 'n3', name: 'curia_default', labels: theirs },
    ],
    volumes: [
      { name: 'curia_tmux-sock', labels: mine },
      { name: 'curia-agent-npm-cache', labels: mine },
      { name: 'pgdata', labels: {} },
      { name: 'curia_tmux-sock-other', labels: theirs },
    ],
    images: [
      ...Object.keys(RELEASE_IMAGES).map((s) => ({ id: image(s), repository: releaseImage(s), digest: DIGESTS[s] })),
      { id: 'img-old-daemon', repository: releaseImage('daemon'), digest: `sha256:${'9'.repeat(64)}` },
      { id: 'img-agent', repository: 'curia-agent', tag: 'abc123' },
      { id: 'img-postgres', repository: 'postgres', tag: '16' },
    ],
  })
}

async function purge({ home, root, docker, tailscale, args = [], prompt, terminal = true, uid = process.getuid() }) {
  const io = capture()
  let exit
  let error = null
  try {
    exit = await runPurge(
      { env: { HOME: home, CURIA_ROOT: root }, args, stdout: io.stdout, stderr: io.stderr, uid, gid: process.getgid(), root },
      { docker, tailscale, prompt, isTerminal: () => terminal },
    )
  } catch (e) {
    error = e
    exit = e instanceof Refusal ? EXIT.refused : EXIT.failed
  }
  return { exit, error, out: io.out(), err: io.err() }
}

const answering = (answer) => {
  const asked = []
  const prompt = async (question) => { asked.push(question); return answer }
  prompt.asked = asked
  return prompt
}

const assertUntouched = (root, id) => {
  assert.equal(readInstallationRecord(root).installationId, id)
  assert.equal(readFileSync(join(root, 'secrets', 'discord-bot-token'), 'utf8'), `${SECRET}\n`)
  assert.equal(readFileSync(join(root, 'work', 'repos', 'curia-42', 'file'), 'utf8'), 'resumable')
}

describe('the named steps', () => {
  test('are one linear sequence that ends with the root', () => {
    assert.deepEqual([...PURGE_STEPS], ['preflight', 'confirm', 'docker', 'routes', 'images', 'root'])
  })
})

describe('a confirmed purge over an installed root', () => {
  test('warns, takes one confirmation, removes by label, withdraws the routes, removes unused release images, then the launcher, then the root', async () => {
    const { home, root, id, launcher } = await installed()
    const docker = dockerHostOf(id)
    const tailscale = fakeTailscale({ serving: [APP_ROUTE, OTHER_ROUTE] })
    const prompt = answering(root)

    const r = await purge({ home, root, docker, tailscale, prompt })
    assert.equal(r.error, null, r.error?.stack)
    assert.equal(r.exit, EXIT.ok)

    // The warning names the exact root and what goes, before the question.
    const warning = r.out.slice(0, r.out.indexOf('[2/6] confirm'))
    assert.match(warning, new RegExp(`\\[1/6\\] preflight\n.*This purges the Curia installation at ${escape(root)}`, 's'))
    assert.match(warning, /configuration \(config\/\)/)
    assert.match(warning, /credentials \(secrets\/\)/)
    assert.match(warning, /history \(state\/\)/)
    assert.match(warning, /unfinished work \(work\/\)/)
    assert.deepEqual(prompt.asked, [`Type the installation root to confirm, or anything else to stop: `])
    assert.match(r.out, /\[2\/6\] confirm\n/)

    // Order: the labelled resources, the routes, the images, the launcher, the root.
    const verbs = docker.verbs()
    assert.ok(verbs.indexOf('stop') < verbs.indexOf('rm'))
    assert.ok(verbs.indexOf('volume rm') < verbs.indexOf('image ls'))
    assert.ok(tailscale.calls.length > 0)
    assert.match(r.out, /\[3\/6\] docker\n.*\[4\/6\] routes\n.*\[5\/6\] images\n.*\[6\/6\] root\n/s)

    // Docker: this installation's resources are gone, by label, and nothing else.
    for (const c of docker.calls.filter((c) => ['ps', 'network', 'volume'].includes(c[0]) && c.includes('--filter'))) {
      const filter = c[c.indexOf('--filter') + 1]
      assert.ok(filter === `label=${INSTALLATION_LABEL}=${id}` || filter.startsWith('ancestor='), `every listing is by the installation label or an image: ${filter}`)
    }
    assert.deepEqual(docker.host.containers.map((c) => c.id).sort(), ['x1', 'x2'])
    assert.deepEqual(docker.host.networks.map((n) => n.id).sort(), ['n2', 'n3'])
    assert.deepEqual(docker.host.volumes.map((v) => v.name).sort(), ['curia_tmux-sock-other', 'pgdata'])

    // Images: the release images nothing uses are removed. The daemon image
    // the other installation runs stays, and so does everything that is not
    // a release image, whatever its name.
    for (const c of docker.calls.filter((c) => c[0] === 'image' && c[1] === 'ls')) {
      const reference = c[c.indexOf('--filter') + 1]
      assert.ok(Object.keys(RELEASE_IMAGES).some((s) => reference === `reference=${releaseImage(s)}`), `images are listed by exact repository: ${reference}`)
    }
    assert.ok(!docker.calls.some((c) => c[0] === 'image' && c[1] === 'rm' && c.includes('--force')), 'never forced')
    assert.deepEqual(docker.host.images.map((i) => i.id).sort(), ['img-agent', 'img-daemon', 'img-postgres'])
    assert.match(r.out, new RegExp(`kept the image ${escape(releaseImage('daemon'))}@sha256:1{64}: in use by 1 container: curia-daemon-1`))
    assert.match(r.out, new RegExp(`removed the image ${escape(releaseImage('tmux'))}@sha256:2{64}`))
    assert.match(r.out, new RegExp(`removed the image ${escape(releaseImage('daemon'))}@sha256:9{64}`))

    // Tailscale: only the recorded route is turned off.
    assert.deepEqual(tailscale.calls, [['serve', 'status', '--json'], ['serve', '--https=8445', 'off']])
    assert.deepEqual(tailscale.serving(), [OTHER_ROUTE])

    // The launcher and the root are gone, the home directory is not.
    assert.ok(!existsSync(launcher), 'the launcher is removed')
    assert.ok(!existsSync(root), 'the root is removed')
    assert.ok(existsSync(home))

    // The completion and the external report.
    assert.match(r.out, new RegExp(`Curia is purged\\. The installation root ${escape(root)} is removed\\.`))
    assert.match(r.out, /External resources Curia never deletes\./)
    assert.match(r.out, /did not revoke|does not revoke|revokes nothing/)
    assert.match(r.out, new RegExp(`GitHub App ${APP_ID}`))
    assert.match(r.out, /Discord bot, server 987, channel curia/)
    assert.match(r.out, /Tailscale node curia\.sh/)
    assert.match(r.out, /Serve route https:\/\/:8445 -> http:\/\/127\.0\.0\.1:4273: withdrawn/)
    assert.match(r.out, /model-provider/)
    assert.doesNotMatch(r.out + r.err, new RegExp(SECRET))
    assert.doesNotMatch(r.out + r.err, /BEGIN|fixture\n/)
  })

  test('the noninteractive confirmation is the exact root on the command line', async () => {
    const { home, root, id } = await installed()
    const prompt = answering(root)
    const r = await purge({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale({ serving: [APP_ROUTE] }), args: ['--confirm', root], prompt, terminal: false })
    assert.equal(r.exit, EXIT.ok, r.error?.stack)
    assert.deepEqual(prompt.asked, [], 'nothing is asked')
    assert.ok(!existsSync(root))

    const equals = await installed()
    const r2 = await purge({ home: equals.home, root: equals.root, docker: dockerHostOf(equals.id), tailscale: fakeTailscale(), args: [`--confirm=${equals.root}`], prompt: answering('no'), terminal: true })
    assert.equal(r2.exit, EXIT.ok, r2.error?.stack)
    assert.ok(!existsSync(equals.root))
  })

  test('the root goes last, after the labelled resources, the routes, the images, and the launcher', async () => {
    const { home, root, id, launcher } = await installed()
    const order = []
    const docker = dockerHostOf(id)
    const wrapped = async (args) => {
      order.push(`docker ${args[0]}${['network', 'volume', 'image'].includes(args[0]) ? ` ${args[1]}` : ''}`)
      if (args[0] === 'image' && args[1] === 'rm') order.push(`launcher ${existsSync(launcher)} root ${existsSync(root)}`)
      return docker(args)
    }
    const tailscale = fakeTailscale({ serving: [APP_ROUTE] })
    const r = await purge({ home, root, docker: wrapped, tailscale: async (args) => { order.push(`tailscale ${args[0]}`); return tailscale(args) }, prompt: answering(root) })
    assert.equal(r.exit, EXIT.ok, r.error?.stack)
    const first = (prefix) => order.findIndex((o) => o.startsWith(prefix))
    assert.ok(first('docker rm') < first('tailscale'), 'containers before routes')
    assert.ok(first('tailscale') < first('docker image ls'), 'routes before images')
    assert.ok(order.filter((o) => o.startsWith('launcher')).every((o) => o === 'launcher true root true'), 'the launcher and the root stand while images are removed')
  })
})

describe('the confirmation', () => {
  test('an answer that is not the root stops the purge with nothing changed', async () => {
    const { home, root, id, launcher } = await installed()
    const docker = dockerHostOf(id)
    for (const answer of ['yes', 'y', `${root}/`, root.toUpperCase(), '']) {
      const r = await purge({ home, root, docker, tailscale: fakeTailscale({ serving: [APP_ROUTE] }), prompt: answering(answer) })
      assert.equal(r.exit, EXIT.refused, `answer ${JSON.stringify(answer)}`)
      assert.match(r.error.message, /^confirm: the answer did not match the installation root\. Nothing changed\./)
    }
    assert.deepEqual(docker.calls, [])
    assert.ok(existsSync(launcher))
    assertUntouched(root, id)
  })

  test('without a terminal and without --confirm the purge refuses and names the flag', async () => {
    const { home, root, id } = await installed()
    const docker = dockerHostOf(id)
    const r = await purge({ home, root, docker, tailscale: fakeTailscale(), prompt: answering(root), terminal: false })
    assert.equal(r.exit, EXIT.refused)
    assert.match(r.error.message, new RegExp(`^confirm: no terminal to confirm on\\. Run 'curia purge --confirm ${escape(root)}' to confirm without a prompt\\. Nothing changed\\.`))
    assert.deepEqual(docker.calls, [])
    assertUntouched(root, id)
  })

  test('--confirm with another value refuses, and the option needs a value', async () => {
    const { home, root, id } = await installed()
    const docker = dockerHostOf(id)
    const other = await purge({ home, root, docker, tailscale: fakeTailscale(), args: ['--confirm', join(home, 'elsewhere')], prompt: answering(root) })
    assert.equal(other.exit, EXIT.refused)
    assert.match(other.error.message, new RegExp(`^confirm: --confirm names ${escape(join(home, 'elsewhere'))}, not the installation root ${escape(root)}\\. Nothing changed\\.`))
    assert.deepEqual(docker.calls, [])
    assertUntouched(root, id)

    const io = capture()
    const exit = await runCli({ argv: ['purge', '--confirm'], env: { HOME: home, CURIA_ROOT: root }, stdout: io.stdout, stderr: io.stderr, commands })
    assert.equal(exit, EXIT.usage)
    assert.match(io.err(), /--confirm needs the installation root as its value/)
    const unknown = capture()
    assert.equal(await runCli({ argv: ['purge', '--yes'], env: { HOME: home, CURIA_ROOT: root }, stdout: unknown.stdout, stderr: unknown.stderr, commands }), EXIT.usage)
    assert.match(unknown.err(), /unknown option: --yes/)
    assertUntouched(root, id)
  })
})

describe('repeating after a partial failure', () => {
  test('a refused container removal names the step and the launcher rerun; the rerun finishes without asking twice for anything already gone', async () => {
    const { home, root, id, launcher } = await installed()
    const docker = dockerHostOf(id, { fail: { rm: 1 } })
    const tailscale = fakeTailscale({ serving: [APP_ROUTE] })

    const first = await purge({ home, root, docker, tailscale, prompt: answering(root) })
    assert.equal(first.exit, EXIT.failed)
    assert.match(first.error.message, /^docker failed: docker rm --force --volumes .* failed:\nfake: rm refused this time/)
    assert.match(first.error.message, new RegExp(`Run '${escape(launcher)} purge' to run docker again; the completed steps are kept\\.`))
    assert.ok(existsSync(launcher))
    assert.deepEqual(tailscale.calls, [])
    assertUntouched(root, id)

    const again = await purge({ home, root, docker, tailscale, prompt: answering(root) })
    assert.equal(again.error, null, again.error?.stack)
    assert.equal(again.exit, EXIT.ok)
    assert.ok(!existsSync(root))
    assert.ok(!existsSync(launcher))
    assert.deepEqual(docker.host.containers.map((c) => c.id).sort(), ['x1', 'x2'])
  })

  test('a root whose runtime directory is gone, with no launcher, is purged from the bootstrap and reruns name the bootstrap', async () => {
    const { home, root, id, launcher } = await installed()
    assert.equal((await runUninstallQuietly({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale({ serving: [APP_ROUTE] }) })), EXIT.ok)
    rmSync(join(root, 'run'), { recursive: true, force: true })
    rmSync(join(root, 'versions'), { recursive: true, force: true })
    assert.ok(!existsSync(launcher))

    const docker = dockerHostOf(id, { fail: { 'image ls': 1 } })
    const failed = await purge({ home, root, docker, tailscale: fakeTailscale(), prompt: answering(root) })
    assert.equal(failed.exit, EXIT.failed)
    assert.match(failed.error.message, new RegExp(`^images failed: .*\nFix the cause, then run 'curia purge' again from the bootstrap \\(${escape(BOOTSTRAP_COMMAND)} --purge\\)`, 's'))
    assert.ok(existsSync(root), 'the root stands until the last step')
    assertUntouched(root, id)

    const again = await purge({ home, root, docker, tailscale: fakeTailscale(), prompt: answering(root) })
    assert.equal(again.error, null, again.error?.stack)
    assert.equal(again.exit, EXIT.ok)
    assert.ok(!existsSync(root))
    assert.match(again.out, /no launcher at/)
  })

  test('a purge over a root that already lost every Docker resource and route removes the root and says so', async () => {
    const { home, root, id } = await installed()
    const docker = fakeDockerHost({ containers: [{ id: 'x2', name: 'postgres', labels: {} }], images: [{ id: 'img-agent', repository: 'curia-agent', tag: 'abc' }] })
    const r = await purge({ home, root, docker, tailscale: fakeTailscale(), prompt: answering(root) })
    assert.equal(r.exit, EXIT.ok, r.error?.stack)
    assert.match(r.out, new RegExp(`no container, network, or volume carries the label of installation ${id}`))
    assert.match(r.out, /no recorded Serve route is standing; nothing to withdraw/)
    assert.match(r.out, /no release image is on this host/)
    assert.ok(!existsSync(root))
    assert.deepEqual(docker.host.images.map((i) => i.id), ['img-agent'], 'an image that is not a release image stays, whatever its name')
    assert.deepEqual(docker.host.containers.map((c) => c.id), ['x2'])
  })

  test('a host without the tailscale command withdraws nothing, says so, and still purges', async () => {
    const { home, root, id } = await installed()
    const r = await purge({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale({ missing: true }), prompt: answering(root) })
    assert.equal(r.exit, EXIT.ok, r.error?.stack)
    assert.match(r.out, /the tailscale command is not on the path, so no Serve route is withdrawn/)
    assert.match(r.out, /Serve route https:\/\/:8445 -> http:\/\/127\.0\.0\.1:4273: still recorded when the root was removed; run 'tailscale serve --https=8445 off' on the node/)
    assert.ok(!existsSync(root))
  })

  test('an image Docker refuses to remove is kept with the reason, not a failure', async () => {
    const { home, root, id } = await installed()
    const docker = dockerHostOf(id, { fail: { 'image rm': 1 } })
    const r = await purge({ home, root, docker, tailscale: fakeTailscale(), prompt: answering(root) })
    assert.equal(r.exit, EXIT.ok, r.error?.stack)
    assert.match(r.out, /kept the image .*: docker refused: fake: image rm refused this time/)
    assert.ok(!existsSync(root))
  })
})

describe('refusals before anything changes', () => {
  test('a root that holds no installation is refused at preflight, and nothing is asked', async () => {
    const home = mkdtempSync(join(scratch, 'home-'))
    const root = join(home, '.local', 'share', 'curia')
    const docker = dockerHostOf('a'.repeat(32))
    const prompt = answering(root)
    const r = await purge({ home, root, docker, tailscale: fakeTailscale(), prompt })
    assert.equal(r.exit, EXIT.refused)
    assert.match(r.error.message, /^preflight: .* holds no installation, so there is nothing to purge\. Nothing changed\./)
    assert.deepEqual(prompt.asked, [])
    assert.deepEqual(docker.calls, [])
    assert.ok(!existsSync(root))
  })

  test('root execution is refused through the command table', async () => {
    const io = capture()
    const exit = await runCli({ argv: ['purge'], env: { HOME: '/nonexistent', CURIA_ROOT: '/nonexistent/curia' }, stdout: io.stdout, stderr: io.stderr, uid: 0, gid: 0, commands })
    assert.equal(exit, EXIT.refused)
    assert.match(io.err(), /^curia purge: preflight: this command runs as root/)
  })

  test('a foreign launcher is kept and reported', async () => {
    const { home, root, id, launcher } = await installed()
    const elsewhere = join(home, 'elsewhere')
    writeFileSync(launcher, readFileSync(launcher, 'utf8').replace(`CURIA_ROOT='${root}'`, `CURIA_ROOT='${elsewhere}'`), { mode: 0o755 })
    const r = await purge({ home, root, docker: dockerHostOf(id), tailscale: fakeTailscale(), prompt: answering(root) })
    assert.equal(r.exit, EXIT.ok, r.error?.stack)
    assert.ok(existsSync(launcher))
    assert.match(r.out, /kept the launcher .*: it belongs to another installation root/)
    assert.ok(!existsSync(root))
  })

  test('the command table wires purge with its one option', () => {
    assert.equal(typeof commands.purge.run, 'function')
    assert.ok(commands.purge.options, 'purge reads --confirm')
    assert.match(commands.purge.summary, /confirmation/)
  })
})

async function runUninstallQuietly({ home, root, docker, tailscale }) {
  const io = capture()
  return runUninstall({ env: { HOME: home, CURIA_ROOT: root }, args: [], stdout: io.stdout, stderr: io.stderr, uid: process.getuid(), gid: process.getgid(), root }, { docker, tailscale })
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// The Bash bootstrap (#872): deploy/bootstrap/curia-install.sh run end to end
// against a local artifact server that stands in for the npm registry, the
// GitHub release, nodejs.org, and the stable-release index. Nothing here
// reaches the network. The seam is the script's command line and environment
// on one side and, on the other, what the verified lifecycle interface
// receives: the command, CURIA_ROOT, and the staged artifacts.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { PACKAGE_NAME, createManifest, renderManifest, releaseAssets } from '../../cli/src/manifest.mjs'
import { renderBundle } from '../../cli/src/bundle.mjs'
import { createStableIndex, generateStableIndexKeys, signStableIndex } from '../../cli/src/stable.mjs'
import { EXIT } from '../../cli/src/exit.mjs'
import { BOUNDARIES, RECORD_FORMAT } from '../../cli/src/root.mjs'
import { releasePins } from '../../deploy/bundle/pins.mjs'
import { BOOTSTRAP_SOURCE, BOOTSTRAP_END, renderBootstrap } from '../../deploy/bootstrap/render.mjs'

const REPO = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const CLI = path.join(REPO, 'cli')
const SCRIPT = BOOTSTRAP_SOURCE

// The fixture release runs the verifier on the developer's own Node: the
// "pinned runtime" the server offers is a wrapper around process.execPath, at
// the version that binary reports, so `node --version` proves the pin.
const NODE_VERSION = process.version.slice(1)
const STABLE = '1.2.3'
const EXACT = '1.2.4'
const WITHDRAWN = '1.1.0'
const COMMIT = 'c'.repeat(40)
const DIGESTS = {
  daemon: `sha256:${'1'.repeat(64)}`,
  tmux: `sha256:${'2'.repeat(64)}`,
  dashboard: `sha256:${'3'.repeat(64)}`,
  overseer: `sha256:${'4'.repeat(64)}`,
  agent: `sha256:${'5'.repeat(64)}`,
}
const TEMPLATE = [
  'name: curia',
  'services:',
  '  daemon:',
  '    image: ${CURIA_DAEMON_IMAGE:?}',
  '    labels:',
  '      sh.curia.installation: ${CURIA_INSTALLATION_ID:?}',
  '  tmux:',
  '    image: ${CURIA_TMUX_IMAGE:?}',
  '  ttyd:',
  '    image: ${CURIA_TMUX_IMAGE:?}',
  '  dashboard:',
  '    image: ${CURIA_DASHBOARD_IMAGE:?}',
  '  overseer:',
  '    image: ${CURIA_OVERSEER_IMAGE:?}',
  '',
].join('\n')

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const sri = (bytes) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`

let scratch
let counter = 0
function archiveOf(files) {
  const dir = path.join(scratch, `archive-${counter++}`)
  for (const [name, { content, mode = 0o644 }] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content, { mode })
  }
  const tops = [...new Set(Object.keys(files).map((n) => n.split('/')[0]))]
  const tar = spawnSync('tar', ['--format=ustar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '-C', dir, '-cf', '-', ...tops])
  assert.equal(tar.status, 0, String(tar.stderr))
  return zlib.gzipSync(tar.stdout, { level: 9 })
}

// The lifecycle interface's own sources, packed the way `npm pack` packs
// them, at one version, with the stable-index key it pins and the manifest
// inside. `bin` replaces the entry point: the spy records what it receives.
function packageOf({ version, manifestText, publicKey, bin, packageVersion = version, node = NODE_VERSION }) {
  const files = {}
  const add = (dir, prefix) => {
    for (const name of fs.readdirSync(path.join(CLI, dir))) {
      files[`package/${prefix}/${name}`] = { content: fs.readFileSync(path.join(CLI, dir, name)) }
    }
  }
  add('src', 'src')
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI, 'package.json'), 'utf8'))
  pkg.version = packageVersion
  pkg.curia = { node }
  files['package/package.json'] = { content: `${JSON.stringify(pkg, null, 2)}\n` }
  files['package/manifest.json'] = { content: manifestText }
  files['package/stable-index.pub'] = { content: publicKey }
  files['package/bin/curia.mjs'] = { content: bin ?? fs.readFileSync(path.join(CLI, 'bin', 'curia.mjs')), mode: 0o755 }
  return archiveOf(files)
}

const SPY = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { readdirSync, existsSync } from 'node:fs'
const stage = process.env.CURIA_STAGE
const staged = stage && existsSync(stage) ? readdirSync(stage).sort() : null
writeFileSync(process.env.CURIA_TEST_SPY, JSON.stringify({ argv: process.argv.slice(2), root: process.env.CURIA_ROOT, stage, staged, node: process.execPath }))
process.exitCode = Number(process.env.CURIA_TEST_SPY_EXIT ?? 0)
`

// One release as the artifact server holds it: the bundle, its checksum, the
// manifest, the package tarball, and the registry's view of the package.
function releaseOf({ version, publicKey, bin, packageVersion, manifestVersion, node }) {
  const compose = renderBundle(TEMPLATE, DIGESTS)
  const archive = archiveOf({ [`curia-bundle-${version}/compose.yaml`]: { content: compose } })
  const manifest = createManifest({ version: manifestVersion ?? version, commit: COMMIT, bundleSha256: sha256(archive), digests: DIGESTS })
  const manifestText = renderManifest(manifest)
  const tarball = packageOf({ version, manifestText, publicKey, bin, packageVersion, node })
  const assets = releaseAssets(version)
  return {
    version,
    tarball,
    files: {
      [`/npm/${PACKAGE_NAME}/${version}`]: JSON.stringify({ name: PACKAGE_NAME, version, dist: { integrity: sri(tarball), tarball: `http://substituted.invalid/${version}.tgz` } }),
      [`/npm/${PACKAGE_NAME}/-/cli-${version}.tgz`]: tarball,
      [`/releases/download/v${version}/${assets.bundle}`]: archive,
      [`/releases/download/v${version}/${assets.checksum}`]: `${sha256(archive)}  ${assets.bundle}\n`,
      [`/releases/download/v${version}/${assets.manifest}`]: manifestText,
    },
  }
}

function nodeRuntime() {
  const name = `node-v${NODE_VERSION}-linux-x64`
  const wrapper = `#!/bin/sh\nexec '${process.execPath}' "$@"\n`
  const tarball = archiveOf({ [`${name}/bin/node`]: { content: wrapper, mode: 0o755 }, [`${name}/README.md`]: { content: 'fixture\n' } })
  return {
    [`/dist/v${NODE_VERSION}/${name}.tar.gz`]: tarball,
    [`/dist/v${NODE_VERSION}/SHASUMS256.txt`]: `${sha256(tarball)}  ${name}.tar.gz\n${'0'.repeat(64)}  ${name}.tar.xz\n`,
  }
}

// The artifact server. `files` is what it serves; `truncate` names a path to
// cut off half way through, with the full Content-Length announced, which is
// what an interrupted transfer looks like to curl.
let server
let origin
const served = { files: {}, truncate: null, hits: [] }
before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-bootstrap-'))
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    served.hits.push(url.pathname)
    const body = served.files[url.pathname]
    if (body === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
    if (served.truncate === url.pathname) {
      res.write(bytes.subarray(0, Math.floor(bytes.length / 2)), () => res.socket.destroy())
      return
    }
    res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(scratch, { recursive: true, force: true })
})

const keys = generateStableIndexKeys()
function signedIndex({ stable = STABLE, withdrawn = [WITHDRAWN], privateKey = keys.privateKey } = {}) {
  return signStableIndex(createStableIndex({ sequence: 3, updated: '2026-09-01T00:00:00Z', stable, withdrawn }), privateKey)
}

// A fresh catalogue for one test: the stable release with the spy as its
// entry point, the exact and the withdrawn releases with the real one (a
// withdrawn release stays published), and the runtime.
function catalogue(overrides = {}) {
  const stable = releaseOf({ version: STABLE, publicKey: keys.publicKey, bin: SPY, ...overrides })
  const exact = releaseOf({ version: EXACT, publicKey: keys.publicKey })
  const withdrawn = releaseOf({ version: WITHDRAWN, publicKey: keys.publicKey })
  served.files = { ...stable.files, ...exact.files, ...withdrawn.files, ...nodeRuntime(), '/stable.json': signedIndex() }
  served.truncate = null
  served.hits = []
  return { stable, exact }
}

// A root as `curia install` leaves one, for the purge that needs no release:
// the seven boundaries, the record naming the active version, the unpacked
// package and its pinned runtime under versions/<version>/, the retained
// artifacts beside them, and the unpacked bundle. `complete: false` removes
// the entry point the launcher runs, which is the incomplete active version.
function installedRoot({ version = STABLE, complete = true } = {}) {
  const tarball = releaseOf({ version, publicKey: keys.publicKey }).tarball
  const root = fs.mkdtempSync(path.join(scratch, 'installed-'))
  fs.chmodSync(root, 0o700)
  for (const name of BOUNDARIES) fs.mkdirSync(path.join(root, name), { mode: 0o700 })
  const record = { format: RECORD_FORMAT, installationId: 'a'.repeat(32), activeVersion: version }
  fs.writeFileSync(path.join(root, 'state', 'installation.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })

  const dir = path.join(root, 'versions', version)
  fs.mkdirSync(path.join(dir, 'cli'), { recursive: true })
  const retained = path.join(dir, 'cli.tgz')
  fs.writeFileSync(retained, tarball)
  const untar = spawnSync('tar', ['-xzf', retained, '-C', path.join(dir, 'cli'), '--strip-components=1'])
  assert.equal(untar.status, 0, String(untar.stderr))
  if (!complete) fs.rmSync(path.join(dir, 'cli', 'bin', 'curia.mjs'))

  fs.mkdirSync(path.join(dir, 'node', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node', 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })

  const assets = releaseAssets(version)
  fs.writeFileSync(path.join(dir, 'bundle.tar.gz'), served.files[`/releases/download/v${version}/${assets.bundle}`])
  fs.writeFileSync(path.join(dir, 'bundle.tar.gz.sha256'), served.files[`/releases/download/v${version}/${assets.checksum}`])
  fs.mkdirSync(path.join(dir, 'bundle'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'bundle', 'compose.yaml'), renderBundle(TEMPLATE, DIGESTS))
  return root
}

// The server answers from this process, so the script runs asynchronously.
async function run(args, { env = {}, stdin, script = SCRIPT, path: extraPath } = {}) {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'))
  const tmp = fs.mkdtempSync(path.join(scratch, 'tmp-'))
  const spy = path.join(home, 'spy.json')
  const child = spawn(stdin === undefined ? script : 'bash', stdin === undefined ? args : ['-s', '--', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH,
      HOME: home,
      TMPDIR: tmp,
      CURIA_TEST_SPY: spy,
      CURIA_BOOTSTRAP_NPM_REGISTRY: `${origin}/npm`,
      CURIA_BOOTSTRAP_RELEASE_DOWNLOADS: `${origin}/releases/download`,
      CURIA_BOOTSTRAP_NODE_DIST: `${origin}/dist`,
      CURIA_BOOTSTRAP_STABLE_INDEX_URL: `${origin}/stable.json`,
      ...env,
    },
  })
  const out = []
  const err = []
  child.stdout.on('data', (d) => out.push(d))
  child.stderr.on('data', (d) => err.push(d))
  child.stdin.end(stdin ?? '')
  const exit = await new Promise((resolve) => child.on('close', resolve))
  const handoff = fs.existsSync(spy) ? JSON.parse(fs.readFileSync(spy, 'utf8')) : null
  const leftover = fs.readdirSync(tmp)
  return { exit, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), handoff, home, tmp, leftover }
}

function refused(r, pattern) {
  assert.equal(r.exit, EXIT.refused, `exit ${r.exit}\n${r.out}\n${r.err}`)
  assert.match(r.err, pattern)
  assert.equal(r.handoff, null, 'the lifecycle interface never ran')
  assert.deepEqual(r.leftover, [], 'the stage is removed')
}

// A directory whose commands shadow the host's, for one test. With
// `without`, it is a complete PATH that lacks the named tools.
function shadow(commands, { without = null } = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'shadow-'))
  for (const [name, body] of Object.entries(commands)) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  if (without) {
    for (const tool of ['bash', 'id', 'uname', 'tail', 'head', 'sed', 'grep', 'cut', 'tr', 'tar', 'gzip', 'sha256sum', 'sha512sum', 'base64', 'od', 'mktemp', 'chmod', 'rm', 'mv', 'mkdir', 'cat', 'curl']) {
      if (without.includes(tool)) continue
      const real = spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim()
      if (real) fs.symlinkSync(real, path.join(dir, tool))
    }
  }
  return dir
}

describe('the bootstrap script', () => {
  test('is executable, ends with its completion marker, and pins nothing but its own version', () => {
    assert.ok(fs.statSync(SCRIPT).mode & 0o100, 'executable')
    const text = fs.readFileSync(SCRIPT, 'utf8')
    assert.ok(text.endsWith(`${BOOTSTRAP_END}\n`), 'the last line is the completion marker')
    assert.match(text, /^CURIA_BOOTSTRAP_VERSION='source'$/m)
    assert.doesNotMatch(text, /^\s*sudo\b/m, 'never escalates')
  })

  test('renders the release asset with the version stamped in and nothing else changed', () => {
    const out = fs.mkdtempSync(path.join(scratch, 'dist-'))
    const result = renderBootstrap({ version: '1.2.3', out })
    assert.equal(result.name, 'curia-install.sh')
    assert.equal(releaseAssets('1.2.3').bootstrap, 'curia-install.sh')
    const rendered = fs.readFileSync(path.join(out, 'curia-install.sh'), 'utf8')
    assert.ok(fs.statSync(path.join(out, 'curia-install.sh')).mode & 0o100)
    assert.match(rendered, /^CURIA_BOOTSTRAP_VERSION='1\.2\.3'$/m)
    assert.equal(rendered.replace("CURIA_BOOTSTRAP_VERSION='1.2.3'", "CURIA_BOOTSTRAP_VERSION='source'"), fs.readFileSync(SCRIPT, 'utf8'))
    assert.throws(() => renderBootstrap({ version: 'latest', out }), /release version/)
  })

  test('the package pins the Node runtime the release images run on', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLI, 'package.json'), 'utf8'))
    assert.equal(pkg.curia?.node, releasePins().NODE_VERSION)
  })

  test('installs the stable release: every artifact is downloaded and verified, then the verified interface gets install with the root and the stage', async () => {
    catalogue()
    const r = await run([])
    assert.equal(r.exit, 0, `${r.out}\n${r.err}`)
    assert.ok(r.handoff, 'the lifecycle interface ran')
    assert.deepEqual(r.handoff.argv, ['install'])
    assert.equal(r.handoff.root, path.join(r.home, '.local', 'share', 'curia'))
    assert.ok(r.handoff.stage.startsWith(r.tmp), `the stage ${r.handoff.stage} is under TMPDIR`)
    assert.deepEqual(r.handoff.staged, ['bundle.tar.gz', 'bundle.tar.gz.sha256', 'cli', 'cli.tgz', 'node'])
    assert.equal(r.handoff.node, process.execPath, 'ran on the staged runtime')
    assert.deepEqual(r.leftover, [], 'the stage is removed after the hand-off')
    assert.match(r.out, new RegExp(`selected ${STABLE}, the stable release`))
    assert.match(r.out, /stable-release index: sequence 3, stable 1\.2\.3, withdrawn 1\.1\.0/)
    assert.match(r.out, /package integrity/)
    assert.match(r.out, /image digests/)
    assert.match(r.out, /release manifest/)
    assert.match(r.out, new RegExp(`Node\\.js v${NODE_VERSION.replace(/\./g, '\\.')}`))
    assert.match(r.out, /handing off to curia install/)
    const order = served.hits
    assert.ok(!order.includes('http://substituted.invalid'), 'never follows the registry\'s tarball URL')
    assert.ok(order.includes(`/npm/${PACKAGE_NAME}/-/cli-${STABLE}.tgz`))
  })

  test('honours the root, an exact version, and the interface\'s own exit code', async () => {
    catalogue()
    const root = path.join(scratch, 'elsewhere', 'curia')
    const r = await run(['--root', root, '--version', STABLE], { env: { CURIA_TEST_SPY_EXIT: '1' } })
    assert.equal(r.exit, 1)
    assert.equal(r.handoff.root, root)
    assert.match(r.out, new RegExp(`selected ${STABLE}, the exact version`))
  })

  // The node joins the tailnet during `curia install` (#891), named up
  // front: the bootstrap hands `--name` through and checks its shape first.
  test('hands --name through to curia install, and refuses a name that is not a MagicDNS label before any download', async () => {
    catalogue()
    const named = await run(['--name', 'curia-box'])
    assert.equal(named.exit, 0, `${named.out}\n${named.err}`)
    assert.deepEqual(named.handoff.argv, ['install', '--name', 'curia-box'])
    const plain = await run([])
    assert.deepEqual(plain.handoff.argv, ['install'])
    for (const bad of ['Curia.sh', '-box', 'x'.repeat(64)]) {
      const before = served.hits.length
      const r = await run(['--name', bad])
      assert.equal(r.exit, EXIT.usage, bad)
      assert.equal(r.handoff, null)
      assert.match(r.err, /not a machine name|longer than the 63 characters/)
      assert.equal(served.hits.length, before, 'nothing was downloaded')
    }
    const purge = await run(['--purge', '--name', 'curia-box'])
    assert.equal(purge.exit, EXIT.usage)
    assert.match(purge.err, /--name is an installation option/)
    const help = await run(['--help'])
    assert.match(help.out, /--name <name>/)
  })

  test('resolves the root the way the lifecycle interface does: CURIA_ROOT, then XDG_DATA_HOME, then HOME', async () => {
    catalogue()
    const xdg = await run([], { env: { XDG_DATA_HOME: '/x/data' } })
    assert.equal(xdg.handoff.root, '/x/data/curia')
    const env = await run([], { env: { XDG_DATA_HOME: '/x/data', CURIA_ROOT: '/r/curia' } })
    assert.equal(env.handoff.root, '/r/curia')
  })

  // The real interface's `curia install` opens the root before it probes the
  // host, so a root that is a file proves the hand-off reached the interface
  // and its boundary without the preflight touching this machine.
  test('hands off to the real lifecycle interface, which opens the root it was given', async () => {
    catalogue()
    const root = path.join(scratch, 'a-file-not-a-root')
    fs.writeFileSync(root, 'x')
    const r = await run(['--version', EXACT, '--root', root])
    assert.equal(r.exit, EXIT.refused, `${r.out}\n${r.err}`)
    assert.match(r.err, /curia install: preflight: the installation root is not a directory/)
    assert.deepEqual(r.leftover, [])
  })

  test('purge acquires the verifier and dispatches purge on the explicit root without installing', async () => {
    catalogue()
    const r = await run(['--purge', '--root', '/srv/curia'])
    assert.equal(r.exit, 0, `${r.out}\n${r.err}`)
    assert.deepEqual(r.handoff.argv, ['purge'])
    assert.equal(r.handoff.root, '/srv/curia')
    assert.equal(r.handoff.stage, undefined, 'a purge stages nothing for the interface to keep')
    assert.match(r.out, /purge of \/srv\/curia/)
    assert.match(r.out, /handing off to curia purge/)
    assert.deepEqual(r.leftover, [], 'the temporary interface is removed')
    assert.equal(fs.existsSync(path.join(r.home, '.local', 'bin', 'curia')), false, 'no launcher is written')
  })

  // The rehearsal's defect (#891): the purge chose a release from the stable
  // index before it had a verifier, so it refused on every host whose index
  // named no stable release, although the interface it needed was installed.
  test('purges with the installed interface, reading no index and downloading nothing, when the index names no stable release', async () => {
    catalogue()
    served.files['/stable.json'] = signedIndex({ stable: null, withdrawn: [] })
    const root = installedRoot()
    served.hits = []
    const r = await run(['--purge', '--root', root])
    assert.deepEqual(served.hits, [], 'no origin is reached, not even the index')
    assert.match(r.out, new RegExp(`the installed interface at ${root}/versions/${STABLE}`))
    assert.match(r.out, /installed files/, 'the installed version verifies itself')
    assert.match(r.out, /handing off to curia purge/)
    assert.equal(r.exit, EXIT.refused, `${r.out}\n${r.err}`)
    assert.match(r.out, /\[1\/6\] preflight/)
    assert.match(r.out, new RegExp(`This purges the Curia installation at ${root}`))
    assert.match(r.out, /\[2\/6\] confirm/)
    assert.match(r.err, /Run 'curia purge --confirm/, 'it reached the confirmation')
    assert.equal(r.handoff, null, 'no acquired interface ran')
    assert.doesNotMatch(r.err, /no stable release/)
    assert.equal(fs.existsSync(path.join(root, 'state', 'installation.json')), true, 'nothing changed')
    assert.deepEqual(r.leftover, [])
  })

  test('purges an incomplete active version with the release --version names', async () => {
    catalogue()
    served.files['/stable.json'] = signedIndex({ stable: null, withdrawn: [] })
    const root = installedRoot({ complete: false })
    served.hits = []
    const r = await run(['--purge', '--root', root, '--version', STABLE])
    assert.equal(r.exit, 0, `${r.out}\n${r.err}`)
    assert.deepEqual(r.handoff.argv, ['purge'])
    assert.equal(r.handoff.root, root)
    assert.equal(r.handoff.stage, undefined, 'a purge stages nothing for the interface to keep')
    assert.match(r.out, new RegExp(`selected ${STABLE}, the exact version`))
    assert.ok(served.hits.includes(`/npm/${PACKAGE_NAME}/-/cli-${STABLE}.tgz`), 'it acquired the interface')
    assert.deepEqual(r.leftover, [])
  })

  test('refuses a purge with no installed interface and no stable release, naming --version', async () => {
    catalogue()
    served.files['/stable.json'] = signedIndex({ stable: null, withdrawn: [] })
    const r = await run(['--purge', '--root', path.join(scratch, 'no-such-root')])
    refused(r, /names no stable release.*--version/s)
    assert.match(r.err, /purge/)
  })

  // The rehearsal's second defect (#891): the bootstrap is the only way to
  // purge once `curia uninstall` has removed the launcher, and it took no
  // `--confirm`, so the noninteractive half of the confirmation contract
  // (#887) had no way in. The value is the purge's to judge, not this
  // script's.
  test('passes --confirm through to the purge, which needs no terminal for it', async () => {
    catalogue()
    const r = await run(['--purge', '--root', '/srv/curia', '--confirm', '/srv/curia'])
    assert.equal(r.exit, 0, `${r.out}\n${r.err}`)
    assert.deepEqual(r.handoff.argv, ['purge', '--confirm', '/srv/curia'])
    assert.equal(r.handoff.root, '/srv/curia')
    assert.match(r.out, /handing off to curia purge/)
    assert.deepEqual(r.leftover, [])
  })

  test('leaves a --confirm that names another path to the purge to refuse', async () => {
    catalogue()
    const root = installedRoot()
    const r = await run(['--purge', '--root', root, '--confirm', '/srv/elsewhere'])
    assert.equal(r.exit, EXIT.refused, `${r.out}\n${r.err}`)
    assert.match(r.out, /\[2\/6\] confirm/)
    assert.match(r.err, new RegExp(`--confirm names /srv/elsewhere, not the installation root ${root}`))
    assert.equal(fs.existsSync(path.join(root, 'state', 'installation.json')), true, 'nothing changed')
    assert.deepEqual(r.leftover, [])
  })

  test('refuses --confirm without --purge, and --confirm without a value, as usage errors', async () => {
    catalogue()
    served.hits = []
    const installing = await run(['--confirm', '/srv/curia'])
    assert.equal(installing.exit, EXIT.usage, `${installing.out}\n${installing.err}`)
    assert.match(installing.err, /--confirm is a purge option/)
    assert.equal(installing.handoff, null)
    const valueless = await run(['--purge', '--confirm'])
    assert.equal(valueless.exit, EXIT.usage, `${valueless.out}\n${valueless.err}`)
    assert.match(valueless.err, /--confirm needs the installation root/)
    assert.equal(valueless.handoff, null)
    assert.deepEqual(served.hits, [], 'nothing was downloaded')
    const help = await run(['--help'])
    assert.match(help.out, /--confirm <root>/)
  })

  test('refuses an interrupted download and leaves nothing behind', async () => {
    catalogue()
    served.truncate = `/releases/download/v${STABLE}/${releaseAssets(STABLE).bundle}`
    refused(await run([]), /curia-bundle-1\.2\.3\.tar\.gz was interrupted/)
  })

  test('refuses an artifact the origin does not have', async () => {
    catalogue()
    delete served.files[`/releases/download/v${STABLE}/${releaseAssets(STABLE).checksum}`]
    refused(await run([]), /curia-bundle-1\.2\.3\.tar\.gz\.sha256 is not at .*404/)
  })

  test('refuses a package tarball whose bytes are not what the registry records', async () => {
    const { stable } = catalogue()
    served.files[`/npm/${PACKAGE_NAME}/-/cli-${STABLE}.tgz`] = Buffer.concat([stable.tarball, Buffer.from('\0')])
    refused(await run([]), /package integrity/)
  })

  test('refuses a bundle whose checksum is not what the release and the manifest bind', async () => {
    catalogue()
    const key = `/releases/download/v${STABLE}/${releaseAssets(STABLE).bundle}`
    served.files[key] = Buffer.concat([served.files[key], Buffer.from('\0')])
    refused(await run([]), /bundle checksum/)
  })

  test('refuses a Node runtime whose checksum is not on the SHASUMS file, and one that is not listed', async () => {
    catalogue()
    const key = `/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`
    served.files[key] = Buffer.concat([served.files[key], Buffer.from('\0')])
    refused(await run([]), /Node\.js .* checksum/)
    catalogue()
    served.files[`/dist/v${NODE_VERSION}/SHASUMS256.txt`] = `${'0'.repeat(64)}  something-else.tar.gz\n`
    refused(await run([]), /SHASUMS256\.txt does not list/)
  })

  test('refuses a package that names another version than the one selected', async () => {
    catalogue({ packageVersion: '9.9.9' })
    refused(await run([]), /version.*9\.9\.9/)
  })

  test('refuses a manifest for another version', async () => {
    catalogue({ manifestVersion: EXACT })
    refused(await run([]), /manifest.*1\.2\.4/)
  })

  test('refuses a runtime that reports another version than the package pins', async () => {
    catalogue({ node: '0.0.1' })
    served.files = { ...served.files, ...Object.fromEntries(Object.entries(nodeRuntime()).map(([k, v]) => [k.replace(`v${NODE_VERSION}`, 'v0.0.1').replace(`v${NODE_VERSION}`, 'v0.0.1'), v])) }
    served.files['/dist/v0.0.1/SHASUMS256.txt'] = served.files['/dist/v0.0.1/SHASUMS256.txt'].replace(`node-v${NODE_VERSION}`, 'node-v0.0.1')
    refused(await run([]), /reports v[0-9.]+, not v0\.0\.1/)
  })

  test('refuses a withdrawn version, a prerelease without --prerelease, and an index that does not verify', async () => {
    catalogue()
    refused(await run(['--version', WITHDRAWN]), /withdrawn/)
    catalogue()
    served.files['/stable.json'] = signedIndex({ privateKey: generateStableIndexKeys().privateKey })
    refused(await run([]), /signed with key/)
    catalogue()
    served.files['/stable.json'] = signedIndex({ stable: null, withdrawn: [] })
    refused(await run([]), /no stable release/)
  })

  test('refuses root execution before it downloads anything', async () => {
    catalogue()
    const r = await run([], { path: shadow({ id: 'echo 0' }) })
    refused(r, /runs as root/)
    assert.deepEqual(served.hits, [])
  })

  test('refuses an unsupported architecture and a missing tool', async () => {
    catalogue()
    refused(await run([], { path: shadow({ uname: 'case "$1" in -m) echo aarch64;; *) echo Linux;; esac' }) }), /x86_64/)
    const without = shadow({}, { without: ['curl', 'sha512sum'] })
    refused(await run([], { env: { PATH: without } }), /needs curl sha512sum on the PATH/)
    assert.deepEqual(served.hits, [])
  })

  test('refuses to run from a pipe or from an incomplete file', async () => {
    catalogue()
    const piped = await run([], { stdin: fs.readFileSync(SCRIPT, 'utf8') })
    refused(piped, /Download the script to a file/)
    const cut = path.join(scratch, 'cut.sh')
    const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n')
    fs.writeFileSync(cut, lines.slice(0, Math.floor(lines.length / 2)).join('\n'), { mode: 0o755 })
    refused(await run([], { script: cut }), /incomplete/)
    assert.deepEqual(served.hits, [])
  })

  test('refuses a relative root and rejects an unknown option as a usage error', async () => {
    catalogue()
    refused(await run(['--root', 'relative/curia']), /absolute path/)
    const r = await run(['--frobnicate'])
    assert.equal(r.exit, EXIT.usage)
    assert.match(r.err, /unknown option: --frobnicate/)
    const help = await run(['--help'])
    assert.equal(help.exit, EXIT.ok)
    assert.match(help.out, /--purge/)
  })
})

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { endQuietlyOnClosedOutput, runCli } from '../src/cli.mjs'
import { EXIT } from '../src/exit.mjs'

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

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

async function run(argv, env = {}, { uid = process.getuid() } = {}) {
  const io = capture()
  const exit = await runCli({ argv, env, uid, stdout: io.stdout, stderr: io.stderr })
  return { exit, out: io.out(), err: io.err() }
}

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'curia-cli-'))
  mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 })
  return root
}

describe('version reporting', () => {
  test('--version prints the package version and exits ok', async () => {
    const r = await run(['--version'])
    assert.equal(r.exit, EXIT.ok)
    assert.equal(r.out, `curia ${packageVersion}\n`)
  })

  test('version names the active installed version from the installation record', async () => {
    const root = tempRoot()
    try {
      writeFileSync(join(root, 'state', 'installation.json'), JSON.stringify({ format: 1, installationId: 'abc', activeVersion: '1.2.3' }))
      const r = await run(['version'], { CURIA_ROOT: root })
      assert.equal(r.exit, EXIT.ok)
      assert.equal(r.out, `curia ${packageVersion}\nactive version: 1.2.3\ninstallation root: ${root}\n`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('version reports when the root holds no installation record', async () => {
    const root = tempRoot()
    try {
      const r = await run(['version'], { CURIA_ROOT: root })
      assert.equal(r.exit, EXIT.ok)
      assert.equal(r.out, `curia ${packageVersion}\nactive version: none (no installation record)\ninstallation root: ${root}\n`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('command routing', () => {
  test('no command prints usage on stderr and exits with the usage code', async () => {
    const r = await run([])
    assert.equal(r.exit, EXIT.usage)
    assert.match(r.err, /^usage: curia <command>/)
    assert.equal(r.out, '')
  })

  test('help prints the command vocabulary on stdout and exits ok', async () => {
    const r = await run(['help'])
    assert.equal(r.exit, EXIT.ok)
    for (const name of ['install', 'reinstall', 'update', 'rollback', 'doctor', 'uninstall', 'purge', 'version']) {
      assert.match(r.out, new RegExp(`^  ${name}\\b`, 'm'), `help lists ${name}`)
    }
    assert.match(r.out, /exit codes/i)
  })

  test('an unknown command is a usage error that names the command', async () => {
    const r = await run(['dance'])
    assert.equal(r.exit, EXIT.usage)
    assert.match(r.err, /unknown command: dance/)
    assert.match(r.err, /curia help/)
  })

  test('every lifecycle command is available: purge over a fresh root refuses at preflight, not as a stub', async () => {
    const root = tempRoot()
    try {
      const r = await run(['purge'], { CURIA_ROOT: join(root, 'fresh') })
      assert.equal(r.exit, EXIT.refused)
      assert.match(r.err, /^curia purge: preflight: .* holds no installation, so there is nothing to purge/)
      assert.doesNotMatch(r.err, /not available/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a lifecycle command refuses root execution before anything else', async () => {
    const r = await run(['install'], { CURIA_ROOT: '/nonexistent/curia' }, { uid: 0 })
    assert.equal(r.exit, EXIT.refused)
    assert.match(r.err, /^curia install: preflight: this command runs as root/)
  })

  test('a lifecycle command refuses an unknown nonempty root', async () => {
    const root = tempRoot()
    try {
      writeFileSync(join(root, 'stray'), 'x')
      const r = await run(['update'], { CURIA_ROOT: root })
      assert.equal(r.exit, EXIT.refused)
      assert.match(r.err, /^curia update: preflight: .* is not a Curia installation/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('version stays read-only and reports even a root the boundary would refuse', async () => {
    const root = tempRoot()
    try {
      writeFileSync(join(root, 'stray'), 'x')
      const r = await run(['version'], { CURIA_ROOT: root })
      assert.equal(r.exit, EXIT.ok)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a command refuses an unknown option before it runs', async () => {
    const r = await run(['doctor', '--frobnicate'])
    assert.equal(r.exit, EXIT.usage)
    assert.match(r.err, /unknown option: --frobnicate/)
  })
})

describe('exit behavior', () => {
  test('the exit codes are the four documented ones', () => {
    assert.deepEqual(EXIT, { ok: 0, failed: 1, usage: 2, refused: 3 })
  })

  test('a command that throws reports the failure and exits with the failed code', async () => {
    const io = capture()
    const exit = await runCli({
      argv: ['doctor'],
      env: {},
      stdout: io.stdout,
      stderr: io.stderr,
      commands: { doctor: { summary: 'x', run: async () => { throw new Error('the socket vanished') } } },
    })
    assert.equal(exit, EXIT.failed)
    assert.match(io.err(), /^curia doctor: the socket vanished\n$/)
  })
})

// The interface owns its streams, so a reader that closes early is its problem
// to handle. `curia version | head -1` is an ordinary thing for an operator or
// a script to run, and it has to end the way a Unix tool does.
describe('a reader that closes the output', () => {
  const binary = fileURLToPath(new URL('../bin/curia.mjs', import.meta.url))

  // Runs the real binary with the read end of its stdout already closed, which
  // is what `head` leaves behind once it has the line it wanted.
  function runWithClosedOutput(args, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [binary, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env })
      let err = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (s) => { err += s })
      child.stdout.destroy()
      child.on('error', reject)
      child.on('close', (code, signal) => resolve({ code, signal, err }))
    })
  }

  // The same command with a reader that stays, for the exit code a closed
  // reader must not change.
  function runWithOpenOutput(args, env) {
    return spawnSync(process.execPath, [binary, ...args], { encoding: 'utf8', env }).status
  }

  // `version` writes a line at a time and `help` writes one long block, so
  // between them they cover both shapes of output. `doctor` is not here
  // because it refuses a scratch root before it writes anything to stdout.
  for (const command of ['version', 'help']) {
    test(`${command} ends quietly and keeps the exit code it would have had`, async () => {
      const root = tempRoot()
      try {
        const env = { PATH: process.env.PATH, CURIA_ROOT: root }
        const r = await runWithClosedOutput([command], env)
        assert.doesNotMatch(r.err, /EPIPE/)
        assert.doesNotMatch(r.err, /^\s+at /m)
        assert.doesNotMatch(r.err, /Unhandled 'error' event/)
        assert.equal(r.signal, null)
        assert.equal(r.code, runWithOpenOutput([command], env))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  test('a closed pipe after the command returns exits with the code the command chose', () => {
    const stdout = new EventEmitter()
    const exits = []
    endQuietlyOnClosedOutput({ stdout, stderr: new EventEmitter(), status: () => EXIT.ok, exit: (c) => exits.push(c) })
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    assert.deepEqual(exits, [EXIT.ok])
  })

  test('a closed pipe while the command is still working exits failed', () => {
    const stdout = new EventEmitter()
    const exits = []
    endQuietlyOnClosedOutput({ stdout, stderr: new EventEmitter(), status: () => EXIT.failed, exit: (c) => exits.push(c) })
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    assert.deepEqual(exits, [EXIT.failed])
  })

  test('a closed stderr ends quietly too', () => {
    const stderr = new EventEmitter()
    const exits = []
    endQuietlyOnClosedOutput({ stdout: new EventEmitter(), stderr, status: () => EXIT.ok, exit: (c) => exits.push(c) })
    stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    assert.deepEqual(exits, [EXIT.ok])
  })

  test('a write error that is not a closed pipe stays unhandled', () => {
    const stdout = new EventEmitter()
    const exits = []
    endQuietlyOnClosedOutput({ stdout, stderr: new EventEmitter(), status: () => EXIT.ok, exit: (c) => exits.push(c) })
    const full = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    assert.throws(() => stdout.emit('error', full), /no space left on device/)
    assert.deepEqual(exits, [])
  })
})

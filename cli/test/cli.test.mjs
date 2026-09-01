import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import { runCli } from '../src/cli.mjs'
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

async function run(argv, env = {}) {
  const io = capture()
  const exit = await runCli({ argv, env, stdout: io.stdout, stderr: io.stderr })
  return { exit, out: io.out(), err: io.err() }
}

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'curia-cli-'))
  mkdirSync(join(root, 'state'), { recursive: true })
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

  for (const name of ['install', 'reinstall', 'update', 'rollback', 'doctor', 'uninstall', 'purge']) {
    test(`${name} routes to its seam and reports that the command is not available yet`, async () => {
      const r = await run([name])
      assert.equal(r.exit, EXIT.refused)
      assert.match(r.err, new RegExp(`^curia ${name}: not available in version ${packageVersion.replaceAll('.', '\\.')}`))
      assert.equal(r.out, '')
    })
  }

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

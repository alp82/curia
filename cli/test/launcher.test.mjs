import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderLauncher, launcherPath } from '../src/launcher.mjs'
import { EXIT } from '../src/exit.mjs'

// A fake installed version: a `node` that prints how it was called, and an
// entry point file. The launcher must pick both from under the active version.
function installVersion(root, version, { withNode = true, withCli = true } = {}) {
  const dir = join(root, 'versions', version)
  if (withNode) {
    mkdirSync(join(dir, 'node', 'bin'), { recursive: true })
    const node = join(dir, 'node', 'bin', 'node')
    writeFileSync(node, `#!/bin/sh\necho "node=$0"\necho "root=$CURIA_ROOT"\nfor a in "$@"; do echo "arg=$a"; done\nexit 42\n`)
    chmodSync(node, 0o700)
  }
  if (withCli) {
    mkdirSync(join(dir, 'cli', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'cli', 'bin', 'curia.mjs'), '// entry\n')
  }
  return dir
}

function activate(root, version) {
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'state', 'installation.json'), JSON.stringify({ format: 1, installationId: 'abc', activeVersion: version }, null, 2) + '\n')
}

let home
let root
let launcher

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'curia-launcher-'))
  root = join(home, 'the root with spaces', 'curia')
  mkdirSync(root, { recursive: true })
  launcher = join(home, 'bin', 'curia')
  mkdirSync(join(home, 'bin'))
  writeFileSync(launcher, renderLauncher({ root }))
  chmodSync(launcher, 0o700)
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function invoke(...args) {
  const r = spawnSync(launcher, args, { encoding: 'utf8', env: { PATH: process.env.PATH } })
  return { exit: r.status, out: r.stdout, err: r.stderr }
}

describe('the stable launcher', () => {
  test('lives at ~/.local/bin/curia', () => {
    assert.equal(launcherPath({ HOME: '/home/op' }), '/home/op/.local/bin/curia')
  })

  test('runs the entry point on the pinned runtime under the active version with CURIA_ROOT set', () => {
    installVersion(root, '1.0.0')
    installVersion(root, '1.1.0')
    activate(root, '1.1.0')
    const r = invoke('doctor', '--verbose', 'two words')
    assert.equal(r.exit, 42, r.err)
    assert.equal(r.out, [
      `node=${join(root, 'versions', '1.1.0', 'node', 'bin', 'node')}`,
      `root=${root}`,
      `arg=${join(root, 'versions', '1.1.0', 'cli', 'bin', 'curia.mjs')}`,
      'arg=doctor',
      'arg=--verbose',
      'arg=two words',
      '',
    ].join('\n'))
  })

  test('refuses an active version whose runtime is missing', () => {
    installVersion(root, '1.1.0', { withNode: false })
    activate(root, '1.1.0')
    const r = invoke('doctor')
    assert.equal(r.exit, EXIT.refused)
    assert.equal(r.out, '')
    assert.match(r.err, /^curia: the active version 1\.1\.0 is incomplete: /)
    assert.match(r.err, new RegExp(join(root, 'versions', '1.1.0', 'node', 'bin', 'node').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(r.err, /Run the bootstrap again to reinstall/)
  })

  test('refuses an active version whose entry point is missing', () => {
    installVersion(root, '1.1.0', { withCli: false })
    activate(root, '1.1.0')
    const r = invoke('doctor')
    assert.equal(r.exit, EXIT.refused)
    assert.match(r.err, /^curia: the active version 1\.1\.0 is incomplete: /)
  })

  test('refuses a root without an installation record', () => {
    installVersion(root, '1.1.0')
    const r = invoke('version')
    assert.equal(r.exit, EXIT.refused)
    assert.match(r.err, /^curia: no installation record at /)
    assert.match(r.err, /state\/installation\.json/)
  })

  test('refuses a record that names no active version', () => {
    installVersion(root, '1.1.0')
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(join(root, 'state', 'installation.json'), '{ "format": 1 }\n')
    const r = invoke('version')
    assert.equal(r.exit, EXIT.refused)
    assert.match(r.err, /^curia: .*installation\.json names no active version/)
  })

  test('is a POSIX shell script that pins its root', () => {
    const text = renderLauncher({ root: '/srv/curia' })
    assert.match(text, /^#!\/bin\/sh\n/)
    assert.match(text, /CURIA_ROOT='\/srv\/curia'/)
    assert.throws(() => renderLauncher({ root: "/it's" }), /single quote/)
  })
})

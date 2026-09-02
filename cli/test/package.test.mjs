import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXIT } from '../src/exit.mjs'

// The package must work with no source checkout: pack it, install the tarball
// into an empty prefix, and invoke the linked `curia` from there.

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const packageVersion = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version

function npm(args, cwd) {
  const r = spawnSync('npm', args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } })
  assert.equal(r.status, 0, `npm ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

let scratch
let tarball
let curia

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'curia-pack-'))
  npm(['pack', '--pack-destination', scratch, '--silent'], packageDir)
  tarball = join(scratch, readdirSync(scratch).find((f) => f.endsWith('.tgz')))
  const prefix = join(scratch, 'prefix')
  npm(['install', '--prefix', prefix, '--no-audit', '--no-fund', '--silent', tarball], scratch)
  curia = join(prefix, 'node_modules', '.bin', 'curia')
})

after(() => rmSync(scratch, { recursive: true, force: true }))

function invoke(...args) {
  const r = spawnSync(curia, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(scratch, 'home') } })
  return { exit: r.status, out: r.stdout, err: r.stderr }
}

describe('the packed package', () => {
  test('is named for the release version', () => {
    assert.equal(tarball, join(scratch, `curia-sh-cli-${packageVersion}.tgz`))
  })

  test('carries the entry point and sources and no tests', () => {
    const list = spawnSync('tar', ['tzf', tarball], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort()
    assert.ok(list.includes('package/bin/curia.mjs'), list.join('\n'))
    assert.ok(list.includes('package/src/launcher.mjs'), list.join('\n'))
    assert.ok(list.includes('package/README.md'), list.join('\n'))
    assert.equal(list.filter((f) => f.startsWith('package/test/')).length, 0, list.join('\n'))
  })

  test('installs a curia that reports its version', () => {
    const r = invoke('--version')
    assert.equal(r.exit, EXIT.ok, r.err)
    assert.equal(r.out, `curia ${packageVersion}\n`)
  })

  test('installs a curia that routes a lifecycle command', () => {
    const r = invoke('update')
    assert.equal(r.exit, EXIT.refused)
    assert.match(r.err, /^curia update: not available in version/)
  })

  test('installs a curia that resolves the default root from HOME', () => {
    const r = invoke('version')
    assert.equal(r.exit, EXIT.ok, r.err)
    assert.match(r.out, new RegExp(`^installation root: ${join(scratch, 'home', '.local', 'share', 'curia')}$`, 'm'))
  })
})

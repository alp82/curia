import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeAtomically } from '../src/atomic.mjs'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'curia-atomic-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeAtomically', () => {
  test('writes the content with the requested mode and leaves no temporary file behind', () => {
    const path = join(dir, 'installation.json')
    writeAtomically(path, '{"a":1}\n', { mode: 0o600 })
    assert.equal(readFileSync(path, 'utf8'), '{"a":1}\n')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dir), ['installation.json'])
  })

  test('replaces an existing file in one step and keeps the requested mode', () => {
    const path = join(dir, 'installation.json')
    writeFileSync(path, 'old', { mode: 0o644 })
    writeAtomically(path, 'new', { mode: 0o600 })
    assert.equal(readFileSync(path, 'utf8'), 'new')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dir), ['installation.json'])
  })

  test('replaces a symbolic link at the target instead of writing through it', () => {
    const elsewhere = join(dir, 'elsewhere')
    writeFileSync(elsewhere, 'untouched')
    const path = join(dir, 'installation.json')
    symlinkSync(elsewhere, path)
    writeAtomically(path, 'new', { mode: 0o600 })
    assert.equal(lstatSync(path).isSymbolicLink(), false)
    assert.equal(readFileSync(path, 'utf8'), 'new')
    assert.equal(readFileSync(elsewhere, 'utf8'), 'untouched')
  })

  test('a write into a missing directory fails and leaves nothing behind', () => {
    const path = join(dir, 'missing', 'installation.json')
    assert.throws(() => writeAtomically(path, 'x', { mode: 0o600 }), /ENOENT/)
    assert.deepEqual(readdirSync(dir), [])
  })
})

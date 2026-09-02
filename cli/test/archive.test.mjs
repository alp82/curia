import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readArchive, extractArchive, ArchiveError } from '../src/archive.mjs'

// One archive made by the system tar, in the shape the release workflow and
// `npm pack` produce: a directory entry, files, and a name past the ustar
// prefix boundary.
function archiveOf(files) {
  const dir = mkdtempSync(join(tmpdir(), 'curia-archive-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), content)
    }
    const tar = spawnSync('tar', ['--format=ustar', '--sort=name', '-C', dir, '-cf', '-', ...Object.keys(files).map((n) => n.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)])
    assert.equal(tar.status, 0, String(tar.stderr))
    return gzipSync(tar.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('readArchive', () => {
  test('returns every regular file of a gzipped ustar archive by its path', () => {
    const bytes = archiveOf({ 'package/package.json': '{"name":"x"}\n', 'package/src/a.mjs': 'export {}\n' })
    const entries = readArchive(bytes)
    assert.deepEqual([...entries.keys()].sort(), ['package/package.json', 'package/src/a.mjs'])
    assert.equal(entries.get('package/package.json').toString(), '{"name":"x"}\n')
    assert.equal(entries.get('package/src/a.mjs').toString(), 'export {}\n')
  })

  test('reads a file whose content spans several blocks and a file that is empty', () => {
    const big = 'x'.repeat(5000)
    const entries = readArchive(archiveOf({ 'd/big.txt': big, 'd/empty.txt': '' }))
    assert.equal(entries.get('d/big.txt').toString(), big)
    assert.equal(entries.get('d/empty.txt').length, 0)
  })

  test('reads what npm pack produces', { skip: spawnSync('npm', ['--version']).status !== 0 ? 'npm is not on the path' : false }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'curia-npm-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '0.0.1', files: ['index.mjs'] }))
      writeFileSync(join(dir, 'index.mjs'), 'export const probe = 1\n')
      const r = spawnSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: dir, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } })
      assert.equal(r.status, 0, r.stderr)
      const entries = readArchive(readFileSync(join(dir, 'probe-0.0.1.tgz')))
      assert.equal(entries.get('package/index.mjs').toString(), 'export const probe = 1\n')
      assert.equal(JSON.parse(entries.get('package/package.json').toString()).version, '0.0.1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses bytes that are not a gzipped tar archive', () => {
    assert.throws(() => readArchive(Buffer.from('not an archive')), ArchiveError)
    assert.throws(() => readArchive(gzipSync(Buffer.from('short'))), ArchiveError)
    const truncated = gzipSync(Buffer.alloc(512, 0x41))
    assert.throws(() => readArchive(truncated), ArchiveError)
  })
})

// An archive with a directory, a file with the execute bit, and a symbolic
// link, the way the Node.js distribution tarball is laid out.
function runtimeArchive() {
  const dir = mkdtempSync(join(tmpdir(), 'curia-archive-'))
  try {
    mkdirSync(join(dir, 'node-v1', 'bin'), { recursive: true })
    mkdirSync(join(dir, 'node-v1', 'lib', 'tool'), { recursive: true })
    writeFileSync(join(dir, 'node-v1', 'bin', 'node'), '#!/bin/sh\necho v1\n', { mode: 0o755 })
    writeFileSync(join(dir, 'node-v1', 'lib', 'tool', 'cli.js'), 'cli\n', { mode: 0o644 })
    symlinkSync('../lib/tool/cli.js', join(dir, 'node-v1', 'bin', 'tool'))
    const tar = spawnSync('tar', ['--format=ustar', '--sort=name', '-C', dir, '-cf', '-', 'node-v1'])
    assert.equal(tar.status, 0, String(tar.stderr))
    return gzipSync(tar.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('extractArchive', () => {
  test('lands files, directories, modes, and symbolic links under the destination, stripping the top directory', () => {
    const dest = mkdtempSync(join(tmpdir(), 'curia-extract-'))
    try {
      extractArchive(runtimeArchive(), dest, { strip: 1 })
      assert.equal(readFileSync(join(dest, 'bin', 'node'), 'utf8'), '#!/bin/sh\necho v1\n')
      assert.equal(statSync(join(dest, 'bin', 'node')).mode & 0o777, 0o755)
      assert.equal(statSync(join(dest, 'lib', 'tool', 'cli.js')).mode & 0o777, 0o644)
      assert.equal(readlinkSync(join(dest, 'bin', 'tool')), '../lib/tool/cli.js')
      assert.equal(readFileSync(join(dest, 'bin', 'tool'), 'utf8'), 'cli\n')
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  test('refuses an entry that would land outside the destination, and a link that points out of it', () => {
    const dest = mkdtempSync(join(tmpdir(), 'curia-extract-'))
    try {
      // GNU tar strips `..` from a name it writes, so the escaping entry is built by hand.
      const header = Buffer.alloc(512)
      header.write('top/../../escape.txt', 0, 'utf8')
      header.write('0000644\0', 100, 'latin1')
      header.write('00000000001\0', 124, 'latin1')
      header.write('ustar\0' + '00', 257, 'latin1')
      header.write('        ', 148, 'latin1')
      let sum = 0
      for (const b of header) sum += b
      header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
      const escaping = gzipSync(Buffer.concat([header, Buffer.from('x'.padEnd(512, '\0')), Buffer.alloc(1024)]))
      assert.throws(() => extractArchive(escaping, dest, { strip: 1 }), (e) => e instanceof ArchiveError && /outside/.test(e.message))
      const dir = mkdtempSync(join(tmpdir(), 'curia-archive-'))
      mkdirSync(join(dir, 'top'))
      symlinkSync('../../etc/passwd', join(dir, 'top', 'escape'))
      const tar = spawnSync('tar', ['--format=ustar', '-C', dir, '-cf', '-', 'top'])
      rmSync(dir, { recursive: true, force: true })
      assert.throws(() => extractArchive(gzipSync(tar.stdout), dest, { strip: 1 }), (e) => e instanceof ArchiveError && /outside/.test(e.message))
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})

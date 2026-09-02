import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readArchive, ArchiveError } from '../src/archive.mjs'

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

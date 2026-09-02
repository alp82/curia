import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withLifecycleLock, lockPath } from '../src/lock.mjs'
import { Refusal } from '../src/exit.mjs'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'curia-lock-'))
  mkdirSync(join(root, 'run'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// A process id that no live process owns: a child that has already exited.
function deadPid() {
  const child = spawnSync('true')
  return child.pid
}

describe('withLifecycleLock', () => {
  test('holds run/lifecycle.lock with this process id while the operation runs and removes it after', async () => {
    let seen
    const result = await withLifecycleLock(root, async () => {
      seen = readFileSync(lockPath(root), 'utf8')
      return 'done'
    })
    assert.equal(result, 'done')
    assert.equal(seen, `${process.pid}\n`)
    assert.equal(existsSync(lockPath(root)), false)
  })

  test('releases the lock when the operation throws', async () => {
    await assert.rejects(withLifecycleLock(root, async () => { throw new Error('boom') }), /boom/)
    assert.equal(existsSync(lockPath(root)), false)
  })

  test('refuses while a live process holds the lock and names that process', async () => {
    writeFileSync(lockPath(root), `${process.pid}\n`)
    await assert.rejects(
      withLifecycleLock(root, async () => 'ran'),
      (e) => e instanceof Refusal && new RegExp(`process ${process.pid} `).test(e.message) && e.message.includes(lockPath(root)),
    )
    assert.equal(readFileSync(lockPath(root), 'utf8'), `${process.pid}\n`)
  })

  test('a second operation in the same process is refused too', async () => {
    await withLifecycleLock(root, async () => {
      await assert.rejects(withLifecycleLock(root, async () => 'nested'), Refusal)
    })
  })

  test('takes over a lock whose process is gone', async () => {
    writeFileSync(lockPath(root), `${deadPid()}\n`)
    const result = await withLifecycleLock(root, async () => 'ran')
    assert.equal(result, 'ran')
    assert.equal(existsSync(lockPath(root)), false)
  })

  test('takes over a lock file that names no process', async () => {
    writeFileSync(lockPath(root), 'garbage')
    assert.equal(await withLifecycleLock(root, async () => 'ran'), 'ran')
  })
})

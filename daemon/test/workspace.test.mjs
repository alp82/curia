// #53: a worker shares the host credential store instead of snapshotting it.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { seedConfigDir, workerEnv, hostStorageDir } from '../src/workspace.mjs'

describe('per-worker config dir (#53)', () => {
  let tmp
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-ws-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('seeding writes the no-dialog config and NO credential of its own', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-1')
    const wtPath = path.join(tmp, 'wt', '1')
    seedConfigDir(cfgDir, wtPath)

    // the trust/onboarding flags are what keep a first spawn dialog-free, and
    // the projects key must match the worktree path exactly
    const claudeJson = JSON.parse(fs.readFileSync(path.join(cfgDir, '.claude.json'), 'utf8'))
    assert.equal(claudeJson.hasCompletedOnboarding, true)
    assert.equal(claudeJson.projects[wtPath].hasTrustDialogAccepted, true)
    assert.ok(fs.existsSync(path.join(cfgDir, 'settings.json')))

    assert.equal(fs.existsSync(path.join(cfgDir, '.credentials.json')), false,
      'a snapshotted token is the #34 failure — nothing may be written here')
  })

  test('seeding unlinks a pre-#53 snapshot rather than leaving it to be used', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-2')
    fs.mkdirSync(cfgDir, { recursive: true })
    const stale = path.join(cfgDir, '.credentials.json')
    fs.writeFileSync(stale, JSON.stringify({ claudeAiOauth: { accessToken: 'dead-paper' } }))

    seedConfigDir(cfgDir, path.join(tmp, 'wt', '2'))

    assert.equal(fs.existsSync(stale), false,
      'a stale copy that still parses would silently re-enter the frozen-token failure')
  })

  test('the worker env isolates config while sharing the credential store', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-3')
    const env = workerEnv(cfgDir)

    assert.equal(env.CLAUDE_CONFIG_DIR, cfgDir)
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, hostStorageDir())
    assert.equal(hostStorageDir(), path.join(os.homedir(), '.claude'))

    // the point of the split: the two must NOT be the same dir, or the
    // isolation #23/#29 made mandatory is gone
    assert.notEqual(env.CLAUDE_CONFIG_DIR, env.CLAUDE_SECURESTORAGE_CONFIG_DIR)
    // an absolute path, not the empty-string form (see workerEnv's note)
    assert.ok(path.isAbsolute(env.CLAUDE_SECURESTORAGE_CONFIG_DIR))
  })
})

// #53: a worker shares the host credential store instead of snapshotting it.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { execFileSync } from 'node:child_process'
import {
  seedConfigDir, workerEnv, hostStorageDir, installSkills, defaultSkillsRoot, DEFAULT_SKILLS,
  createWorktree, remoteBranchExists,
} from '../src/workspace.mjs'

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

describe('the worker skill set (#57)', () => {
  let tmp
  let root

  // A stand-in host skills root: one directory per skill, each with a SKILL.md.
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-skills-'))
    root = path.join(tmp, 'host-skills')
    for (const name of ['wayfinder', 'tdd', 'grilling']) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
      fs.writeFileSync(path.join(root, name, 'SKILL.md'), `# ${name}\n`)
    }
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('seeding symlinks each configured skill, and reading through the link reaches the host', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-10')
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '10'), { root, install: ['wayfinder', 'tdd'] })

    const skillsDir = path.join(cfgDir, 'skills')
    assert.deepEqual(fs.readdirSync(skillsDir).sort(), ['tdd', 'wayfinder'])
    // a symlink, not a copy: the version tracks the host with no snapshot to
    // go stale, which is what makes this safe where #53's copy was not
    assert.ok(fs.lstatSync(path.join(skillsDir, 'wayfinder')).isSymbolicLink())
    assert.equal(fs.readlinkSync(path.join(skillsDir, 'wayfinder')), path.join(root, 'wayfinder'))
    assert.equal(fs.readFileSync(path.join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8'), '# wayfinder\n')

    // the bound: one read-only skills directory and NOTHING else from the host
    assert.deepEqual(fs.readdirSync(cfgDir).sort(), ['.claude.json', 'settings.json', 'skills'])
  })

  test('no skills configured installs none — the seam every test double takes', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-11')
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '11'))
    assert.equal(fs.existsSync(path.join(cfgDir, 'skills')), false)

    // an explicitly empty list is the opt-out, and behaves the same
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '11'), { root, install: [] })
    assert.equal(fs.existsSync(path.join(cfgDir, 'skills')), false)
  })

  test('a re-seeded config dir carries no skill that has left the list', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-12')
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '12'), { root, install: ['wayfinder', 'grilling'] })
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '12'), { root, install: ['wayfinder'] })

    assert.deepEqual(fs.readdirSync(path.join(cfgDir, 'skills')), ['wayfinder'],
      'a link left behind would hand the worker a skill the operator removed')
  })

  test('a skill missing from the host refuses the spawn instead of shipping a worker without it', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-13')
    assert.throws(
      () => installSkills(cfgDir, { root, install: ['wayfinder', 'gone'] }),
      /skill "gone" has no SKILL.md/,
    )
  })

  test('the default set is the nine of #49, and the charting-and-PM skills are withheld', () => {
    for (const name of ['wayfinder', 'grilling', 'domain-modeling', 'research', 'prototype',
      'implement', 'tdd', 'code-review', 'diagnosing-bugs']) {
      assert.ok(DEFAULT_SKILLS.includes(name), `${name} must be installed`)
    }
    for (const name of ['to-tickets', 'triage', 'to-spec', 'handoff']) {
      assert.equal(DEFAULT_SKILLS.includes(name), false, `${name} is deliberately withheld (#49)`)
    }
    assert.equal(defaultSkillsRoot(), path.join(os.homedir(), '.claude', 'skills'))
  })
})

// #54 item 6: re-dispatch onto a ticket whose pull request is already open. This
// runs against real git, because the bug it fixes was entirely in the plumbing:
// `worktree add -B curia/<n> … origin/HEAD` force-reset the branch, so the second
// worker started from the default branch and its non-forced push then failed —
// after having thrown away every commit already under review.
describe('createWorktree start point (#54 item 6)', () => {
  let tmp
  let base
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-wt-'))
    const origin = path.join(tmp, 'origin.git')
    const seed = path.join(tmp, 'seed')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', origin, seed])
    fs.writeFileSync(path.join(seed, 'README.md'), 'base\n')
    git(seed, 'add', '.')
    git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base')
    git(seed, 'push', 'origin', 'main')
    // a first dispatch's work, already pushed and under review
    git(seed, 'checkout', '-b', 'curia/42')
    fs.writeFileSync(path.join(seed, 'work.txt'), 'reviewed work\n')
    git(seed, 'add', '.')
    git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'under review')
    git(seed, 'push', 'origin', 'curia/42')

    base = path.join(tmp, 'repos', 'o__r', 'base')
    fs.mkdirSync(path.dirname(base), { recursive: true })
    execFileSync('git', ['clone', origin, base])
    git(base, 'remote', 'set-head', 'origin', 'main')
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('remoteBranchExists reads the tracking ref, and distinguishes absent from unreadable', async () => {
    assert.equal(await remoteBranchExists(base, 'curia/42'), true)
    assert.equal(await remoteBranchExists(base, 'curia/999'), false)
    await assert.rejects(() => remoteBranchExists(path.join(tmp, 'not-a-repo'), 'curia/42'),
      'a failed read must throw, never read as "no branch"')
  })

  test('a re-dispatch continues the existing branch instead of resetting it', async () => {
    const wt = await createWorktree(base, 42)
    assert.ok(fs.existsSync(path.join(wt, 'work.txt')), 'the commits already under review must survive')
    assert.match(git(wt, 'log', '-1', '--format=%s'), /under review/)
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'curia/42')
  })

  test('a first dispatch still starts from the default branch', async () => {
    const wt = await createWorktree(base, 77)
    assert.equal(fs.existsSync(path.join(wt, 'work.txt')), false)
    assert.match(git(wt, 'log', '-1', '--format=%s'), /base/)
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'curia/77')
  })
})

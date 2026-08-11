// #312: the overseer's checkouts — one blobless clone per watched repo, every
// ref, one fetch per turn.
//
// These drive REAL git against a local origin. `gh repo clone` is the one thing
// no unit test can reach, so `syncCheckouts` takes the clone as an argument and
// the fixture below passes a `git clone` of a directory. Everything after the
// clone — the refspecs, the prune, the force-reset, the stamp, the verdict — is
// the code that ships.

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  syncCheckouts, ensureCheckout, pruneUnwatched, readFetchStamp,
  checkoutsRootFor, checkoutPathFor, checkoutDirNameFor, FETCH_REFSPECS,
} from '../src/checkouts.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const commit = (cwd, msg) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg)

describe('the overseer checkouts (#312)', () => {
  let tmp, origin, seed, root

  // A bare origin carrying what ADR-0014 calls "every ref": the default branch,
  // a `curia/<n>` branch, a tag, and a pull-request head under refs/pull — the
  // shape GitHub publishes, written by hand because no local remote grows one.
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-checkouts-'))
    origin = path.join(tmp, 'origin.git')
    seed = path.join(tmp, 'seed')
    root = path.join(tmp, 'work')

    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    execFileSync('git', ['init', '-b', 'main', seed])
    git(seed, 'remote', 'add', 'origin', origin)
    fs.writeFileSync(path.join(seed, 'README.md'), 'first\n')
    git(seed, 'add', '.')
    commit(seed, 'base')
    git(seed, 'push', 'origin', 'main')
    git(seed, 'tag', 'v1')
    git(seed, 'push', 'origin', 'v1')

    git(seed, 'checkout', '-b', 'curia/42')
    fs.writeFileSync(path.join(seed, 'work.txt'), 'agent work\n')
    git(seed, 'add', '.')
    commit(seed, 'what the agent changed')
    git(seed, 'push', 'origin', 'curia/42')
    // The pull-request head GitHub would publish for that branch.
    git(seed, 'push', 'origin', 'curia/42:refs/pull/7/head')
    git(seed, 'checkout', 'main')

    // A bare repo has no HEAD symref a clone can read unless it is set.
    execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  beforeEach(() => { fs.rmSync(path.join(root, 'overseer'), { recursive: true, force: true }) })

  // Stands in for `gh repo clone`. Blobless is dropped: a local-path clone
  // cannot serve a partial clone without `uploadpack.allowFilter` on the
  // origin, and the filter is not what any case here is about.
  //
  // `urlFor` goes with it. `configure` re-points origin on every pass, so
  // without it every case below would be a live read of the real github.com.
  const clone = (repo, wt) => {
    execFileSync('git', ['clone', origin, wt])
    return Promise.resolve()
  }
  const urlFor = () => origin

  const REPOS = ['alp82/curia', 'alp82/aistack']

  const sync = async (repos = REPOS, opts = {}) => syncCheckouts(root, repos, { clone, urlFor, ...opts })

  test('the layout is one tree, one directory per repo, keyed the way worktrees are', () => {
    assert.equal(checkoutsRootFor('/w'), '/w/overseer/repos')
    assert.equal(checkoutPathFor('/w', 'alp82/curia'), '/w/overseer/repos/alp82__curia')
    assert.equal(checkoutDirNameFor('getalfredo/landing-page'), 'getalfredo__landing-page')
  })

  test('a first pass clones every watched repo, in its own directory', async () => {
    const result = await sync()
    assert.deepEqual(result.repos.map((r) => r.repo).sort(), [...REPOS].sort())
    for (const r of result.repos) {
      assert.equal(r.ok, true, r.error)
      assert.equal(r.cloned, true)
      assert.ok(fs.existsSync(path.join(r.path, '.git')))
      assert.equal(r.path, checkoutPathFor(root, r.repo))
    }
  })

  // The claim ADR-0014 makes in one line, asserted ref by ref.
  test('the checkout holds EVERY ref: branches, curia/<n>, pull-request heads and tags', async () => {
    const { repos } = await sync(['alp82/curia'])
    const wt = repos[0].path
    const refs = git(wt, 'for-each-ref', '--format=%(refname)')
    assert.match(refs, /refs\/remotes\/origin\/main/)
    assert.match(refs, /refs\/remotes\/origin\/curia\/42/, 'a `curia/<n>` branch is the first thing asked about')
    assert.match(refs, /refs\/remotes\/origin\/pr\/7/, 'a fork pull request reaches this clone no other way')
    assert.match(refs, /refs\/tags\/v1/)
    assert.doesNotMatch(refs, /pr\/7\/merge/, 'the merge refs answer a different question and go stale')
  })

  // ADR-0014 keeps `git pull` available mid-turn, and a pull reads the
  // CONFIGURED refspec rather than the one the pass puts on the command line.
  test('the configured refspec matches the pass, so a mid-turn fetch sees everything too', async () => {
    const { repos } = await sync(['alp82/curia'])
    const configured = git(repos[0].path, 'config', '--get-all', 'remote.origin.fetch').trim().split('\n')
    assert.deepEqual(configured, FETCH_REFSPECS)
  })

  // The other half of "`git pull` stays available". A pull with no upstream
  // refuses by asking which branch it is for, and the force-reset each pass
  // runs is what could quietly drop one.
  test('the default branch keeps its upstream across the force-reset, so `git pull` answers', async () => {
    const { repos } = await sync(['alp82/curia'])
    const wt = repos[0].path
    await sync(['alp82/curia'])
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').trim(), 'origin/main')
    assert.match(git(wt, 'pull'), /Already up to date/)
  })

  test('the checkout is a mirror: no git identity, and a push url that refuses', async () => {
    const { repos } = await sync(['alp82/curia'])
    const wt = repos[0].path
    assert.throws(() => git(wt, 'config', '--get', 'user.email'),
      'no identity is deliberate — a commit here must fail by naming what is missing')
    assert.match(git(wt, 'config', '--get', 'remote.origin.pushurl'), /^no_push:/)
  })

  // The failure the force-reset exists for. Without it `cat README.md` answers
  // from the commit the clone was taken at, while `git log origin/main` answers
  // from today — and ADR-0014's "every read inside a turn is consistent" is a
  // claim about exactly this file read.
  test('a second pass moves the WORKING TREE onto the fetched tip, not just the tracking ref', async () => {
    const first = await sync(['alp82/curia'])
    const wt = first.repos[0].path
    assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), 'first\n')

    fs.writeFileSync(path.join(seed, 'README.md'), 'second\n')
    git(seed, 'add', '.')
    commit(seed, 'moved on')
    git(seed, 'push', 'origin', 'main')

    const second = await sync(['alp82/curia'])
    assert.equal(second.repos[0].cloned, false, 'an existing clone is fetched, never re-cloned')
    assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), 'second\n')
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main')
  })

  test('a turn left on another branch comes back to the default branch', async () => {
    const first = await sync(['alp82/curia'])
    const wt = first.repos[0].path
    git(wt, 'checkout', 'curia/42')
    assert.ok(fs.existsSync(path.join(wt, 'work.txt')))

    await sync(['alp82/curia'])
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main')
    assert.equal(fs.existsSync(path.join(wt, 'work.txt')), false)
  })

  test('a tracked file a turn edited is reset; an untracked file it left is kept', async () => {
    const first = await sync(['alp82/curia'])
    const wt = first.repos[0].path
    // Read rather than asserted against a literal: an earlier case may have
    // moved origin on, and the property here is "back to what origin says".
    const onOrigin = fs.readFileSync(path.join(wt, 'README.md'), 'utf8')
    fs.writeFileSync(path.join(wt, 'README.md'), 'scribbled over\n')
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'a turn left this\n')

    await sync(['alp82/curia'])
    assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), onOrigin)
    assert.equal(fs.existsSync(path.join(wt, 'scratch.txt')), true,
      'this pass has no business judging what a previous turn left')
  })

  // Its OWN origin: this case deletes refs, and every other case reads the
  // shared one. A restore afterwards would make the suite order-dependent.
  test('a branch and a tag deleted on origin are pruned, so the chat cannot answer from them', async () => {
    const own = path.join(tmp, 'prunable.git')
    const ownSeed = path.join(tmp, 'prunable-seed')
    execFileSync('git', ['init', '--bare', '-b', 'main', own])
    execFileSync('git', ['init', '-b', 'main', ownSeed])
    git(ownSeed, 'remote', 'add', 'origin', own)
    fs.writeFileSync(path.join(ownSeed, 'a.txt'), 'a\n')
    git(ownSeed, 'add', '.')
    commit(ownSeed, 'base')
    git(ownSeed, 'push', 'origin', 'main')
    git(ownSeed, 'branch', 'curia/42')
    git(ownSeed, 'push', 'origin', 'curia/42')
    git(ownSeed, 'tag', 'v1')
    git(ownSeed, 'push', 'origin', 'v1')
    execFileSync('git', ['-C', own, 'symbolic-ref', 'HEAD', 'refs/heads/main'])

    const opts = {
      clone: (repo, wt) => { execFileSync('git', ['clone', own, wt]); return Promise.resolve() },
      urlFor: () => own,
    }
    const first = await syncCheckouts(root, ['alp82/prunable'], opts)
    const wt = first.repos[0].path
    assert.match(git(wt, 'for-each-ref', '--format=%(refname)'), /origin\/curia\/42/)

    git(ownSeed, 'push', 'origin', '--delete', 'curia/42')
    git(ownSeed, 'push', 'origin', '--delete', 'v1')

    await syncCheckouts(root, ['alp82/prunable'], opts)
    const refs = git(wt, 'for-each-ref', '--format=%(refname)')
    assert.doesNotMatch(refs, /origin\/curia\/42/)
    assert.doesNotMatch(refs, /refs\/tags\/v1/)
  })

  // #312's open thread, answered.
  test('the clone of a repo nobody watches is deleted', async () => {
    await sync(REPOS)
    const dropped = checkoutPathFor(root, 'alp82/aistack')
    assert.ok(fs.existsSync(dropped))

    const result = await sync(['alp82/curia'])
    assert.equal(fs.existsSync(dropped), false)
    assert.deepEqual(result.removed, ['alp82__aistack'])
  })

  test('watching it again clones it back', async () => {
    await sync(['alp82/curia'])
    const result = await sync(REPOS)
    const back = result.repos.find((r) => r.repo === 'alp82/aistack')
    assert.equal(back.cloned, true)
    assert.equal(back.ok, true)
  })

  // The prune compares against the names the watch list generates. It never
  // parses a directory name back into a repo, so a name that does not
  // round-trip can never cause a delete.
  test('the prune keeps exactly the watched names and touches nothing else', () => {
    const base = path.join(tmp, 'prune-only')
    fs.mkdirSync(path.join(base, 'alp82__curia'), { recursive: true })
    fs.mkdirSync(path.join(base, 'alp82__a__b'), { recursive: true })
    fs.mkdirSync(path.join(base, 'old__gone'), { recursive: true })
    fs.writeFileSync(path.join(base, 'notes.txt'), 'a file, not a clone\n')

    const removed = pruneUnwatched(base, ['alp82/curia', 'alp82/a__b'])
    assert.deepEqual(removed, ['old__gone'])
    assert.ok(fs.existsSync(path.join(base, 'alp82__a__b')))
    assert.ok(fs.existsSync(path.join(base, 'notes.txt')))
  })

  test('a pass over a root that does not exist yet makes it', async () => {
    const fresh = path.join(tmp, 'brand-new')
    const result = await syncCheckouts(fresh, ['alp82/curia'], { clone, urlFor })
    assert.equal(result.repos[0].ok, true)
    assert.equal(result.root, checkoutsRootFor(fresh))
  })

  // #312's answer to "a repo whose fetch fails": the turn runs anyway, and the
  // verdict is what stops the model reading a stale checkout as a fresh one.
  test('one repo failing does not refuse the turn — the others still fetch', async () => {
    const result = await syncCheckouts(root, REPOS, {
      urlFor,
      clone: (repo, wt) => (repo === 'alp82/aistack'
        ? Promise.reject(new Error('could not resolve host github.com'))
        : clone(repo, wt)),
    })
    const bad = result.repos.find((r) => r.repo === 'alp82/aistack')
    const good = result.repos.find((r) => r.repo === 'alp82/curia')
    assert.equal(good.ok, true)
    assert.equal(bad.ok, false)
    assert.match(bad.error, /could not resolve host/)
  })

  test('a failed fetch reports the age of the last good one; a repo never cloned reports none', async () => {
    const at = new Date('2026-08-11T09:00:00.000Z')
    const first = await sync(['alp82/curia'], { now: () => at })
    const wt = first.repos[0].path
    assert.equal(first.repos[0].fetchedAt, at.toISOString())
    assert.equal(readFetchStamp(wt), at.toISOString())

    // origin goes away under an existing clone: the fetch fails, the checkout
    // stays on disk, and its age is the thing the turn has to be able to state.
    const second = await syncCheckouts(root, ['alp82/curia'], {
      clone: () => Promise.reject(new Error('unreachable')),
      urlFor: () => path.join(tmp, 'no-such-origin.git'),
    })
    assert.equal(second.repos[0].ok, false)
    assert.equal(second.repos[0].fetchedAt, null)
    assert.equal(second.repos[0].staleSince, at.toISOString())
    assert.ok(fs.existsSync(path.join(wt, '.git')), 'a failed fetch must not destroy the checkout')

    const never = await syncCheckouts(path.join(tmp, 'empty-root'), ['alp82/curia'], {
      clone: () => Promise.reject(new Error('unreachable')), urlFor,
    })
    assert.equal(never.repos[0].fetchedAt, null)
    assert.equal(never.repos[0].staleSince, null, 'no checkout at all is not the same as a stale one')
  })

  test('a directory left behind by a dead pass is re-cloned, not read', async () => {
    const wt = checkoutPathFor(root, 'alp82/curia')
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, 'leftover.txt'), 'from a pass that died\n')

    const result = await sync(['alp82/curia'])
    assert.equal(result.repos[0].ok, true)
    assert.equal(result.repos[0].cloned, true)
    assert.equal(fs.existsSync(path.join(wt, 'leftover.txt')), false)
  })

  // The nastier half of the same failure. `git clone` writes `.git` early, so a
  // clone the timeout killed leaves something that LOOKS like a repository.
  // Testing only for `.git` would leave it there to fail its fetch on every
  // later turn, with nothing ever deciding to clone over it.
  test('a clone killed part-way is re-cloned, not fetched into forever', async () => {
    const wt = checkoutPathFor(root, 'alp82/curia')
    fs.mkdirSync(path.join(wt, '.git', 'objects'), { recursive: true })
    fs.mkdirSync(path.join(wt, '.git', 'refs'), { recursive: true })
    fs.writeFileSync(path.join(wt, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    fs.writeFileSync(path.join(wt, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
    assert.throws(() => git(wt, 'rev-parse', '--verify', 'HEAD'), 'the fixture must be a repo that answers nothing')

    const result = await sync(['alp82/curia'])
    assert.equal(result.repos[0].ok, true, result.repos[0].error)
    assert.equal(result.repos[0].cloned, true, 'the skeleton must be replaced, not fetched into')
    assert.match(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), /^main$/)
  })

  test('ensureCheckout heals a clone whose config a hand edit broke', async () => {
    await sync(['alp82/curia'])
    const wt = checkoutPathFor(root, 'alp82/curia')
    git(wt, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main')
    git(wt, 'config', '--unset', 'remote.origin.pushurl')

    await ensureCheckout(root, 'alp82/curia', { clone: () => { throw new Error('must not re-clone') }, urlFor })
    assert.deepEqual(git(wt, 'config', '--get-all', 'remote.origin.fetch').trim().split('\n'), FETCH_REFSPECS)
    assert.match(git(wt, 'config', '--get', 'remote.origin.pushurl'), /^no_push:/)
  })

  test('the default branch is read from origin, not assumed to be main', async () => {
    const other = path.join(tmp, 'other.git')
    execFileSync('git', ['init', '--bare', '-b', 'trunk', other])
    const otherSeed = path.join(tmp, 'other-seed')
    execFileSync('git', ['init', '-b', 'trunk', otherSeed])
    git(otherSeed, 'remote', 'add', 'origin', other)
    fs.writeFileSync(path.join(otherSeed, 'a.txt'), 'a\n')
    git(otherSeed, 'add', '.')
    commit(otherSeed, 'base')
    git(otherSeed, 'push', 'origin', 'trunk')
    execFileSync('git', ['-C', other, 'symbolic-ref', 'HEAD', 'refs/heads/trunk'])

    const result = await syncCheckouts(root, ['alp82/other'], {
      clone: (repo, wt) => { execFileSync('git', ['clone', other, wt]); return Promise.resolve() },
      urlFor: () => other,
    })
    assert.equal(result.repos[0].branch, 'trunk')
    assert.equal(git(result.repos[0].path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'trunk')
    // The branch the pass makes here never existed locally, so this is the path
    // where a lost upstream would be silent.
    assert.equal(git(result.repos[0].path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').trim(), 'origin/trunk')
  })
})

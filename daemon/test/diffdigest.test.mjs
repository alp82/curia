// The diff digest (#355, building #343's Diff-then-ship).
//
// The COUNT runs against real git, in a real clone with a real origin. That is
// deliberate: everything this module claims is a claim about git's own output —
// the `-z` record shapes, what a rename reports in `--numstat`, what a binary
// file reports instead of a number, and what the working tree adds on top of a
// commit. A fake `git` would only pin this file's beliefs about git back to
// itself, and the beliefs are the part that can be wrong.
//
// The rank rule, the two caps and the one Discord line are pure functions and
// are driven directly.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readDiffDigest, readFileHunks, digestLine, biggestOf, capText, sliceFromPatch,
  rankFiles, classOf, parseNumstatZ, parseNameStatusZ, hunkCounts,
  FILE_CAP, HUNK_LINE_CAP, RANK_RULE,
} from '../src/diffdigest.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const commit = (cwd, msg) => {
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg)
}

describe('the count, against real git (#355)', () => {
  let tmp
  let wt

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-digest-'))
    const origin = path.join(tmp, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    wt = path.join(tmp, 'wt')
    execFileSync('git', ['clone', '-q', origin, wt])

    fs.mkdirSync(path.join(wt, 'src'))
    fs.mkdirSync(path.join(wt, 'docs'))
    fs.mkdirSync(path.join(wt, 'test'))
    fs.writeFileSync(path.join(wt, 'src/app.mjs'), 'a\nb\nc\n')
    fs.writeFileSync(path.join(wt, 'src/move-me.mjs'), 'moved\n')
    fs.writeFileSync(path.join(wt, 'docs/guide.md'), 'old doc\n')
    fs.writeFileSync(path.join(wt, 'package-lock.json'), 'lock\n')
    commit(wt, 'base')
    git(wt, 'push', '-q', 'origin', 'main')
    git(wt, 'remote', 'set-head', 'origin', 'main')

    // the branch under review: one edit, one new test, one rename, one deleted
    // doc, one binary file, and a lock file bigger than any of them
    git(wt, 'checkout', '-q', '-b', 'curia/1')
    fs.writeFileSync(path.join(wt, 'src/app.mjs'), 'a\nb\nc\nd\ne\n')
    fs.writeFileSync(path.join(wt, 'test/app.test.mjs'), 'one\n')
    git(wt, 'mv', 'src/move-me.mjs', 'src/moved.mjs')
    fs.rmSync(path.join(wt, 'docs/guide.md'))
    fs.writeFileSync(path.join(wt, 'src/blob.bin'), Buffer.from([0, 1, 2, 3, 0]))
    fs.writeFileSync(path.join(wt, 'package-lock.json'), 'lock\n1\n2\n3\n4\n5\n6\n7\n')
    commit(wt, 'the work')
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const byPath = (d, p) => d.list.find((f) => f.path === p)

  test('it counts the branch against the merge base — totals and one row per file', async () => {
    const { digest, error } = await readDiffDigest(wt)
    assert.equal(error, null)
    assert.equal(digest.files, 6)
    assert.equal(digest.uncommitted, false)
    assert.equal(digest.capped, false)
    // 2 on app.mjs, 1 on the test, 7 on the lock file; the rename and the
    // binary add nothing countable, and the deleted doc takes one away.
    assert.equal(digest.added, 10)
    assert.equal(digest.deleted, 1)
    assert.equal(byPath(digest, 'src/app.mjs').added, 2)
    assert.equal(byPath(digest, 'src/app.mjs').status, 'M')
    assert.equal(byPath(digest, 'test/app.test.mjs').status, 'A')
    assert.equal(byPath(digest, 'docs/guide.md').status, 'D')
  })

  test('a rename says so and names what it came from', async () => {
    const { digest } = await readDiffDigest(wt)
    const f = byPath(digest, 'src/moved.mjs')
    assert.equal(f.status, 'R')
    assert.equal(f.from, 'src/move-me.mjs')
    assert.equal(f.added, 0)
    assert.equal(f.deleted, 0)
  })

  // git prints `-` for both counts on a binary file. A zero there would be a
  // number the card could add up, and it would be a lie.
  test('a binary file carries no line count at all, and does not distort the totals', async () => {
    const { digest } = await readDiffDigest(wt)
    const f = byPath(digest, 'src/blob.bin')
    assert.equal(f.binary, true)
    assert.equal(f.added, null)
    assert.equal(f.deleted, null)
  })

  test('every file carries its hunk count, read off one extra local pass', async () => {
    const { digest } = await readDiffDigest(wt)
    assert.equal(byPath(digest, 'src/app.mjs').hunks, 1)
    assert.equal(byPath(digest, 'src/moved.mjs').hunks, 0, 'a pure rename has no hunk')
  })

  // The live agent row (#355): what the work SO FAR means, while a note can
  // still steer it.
  test('the agent-row read shows committed and uncommitted work together', async () => {
    fs.appendFileSync(path.join(wt, 'src/app.mjs'), 'f\n')
    fs.writeFileSync(path.join(wt, 'src/scratch.mjs'), 'one\ntwo\n')
    try {
      const committed = await readDiffDigest(wt)
      assert.equal(byPath(committed.digest, 'src/app.mjs').added, 2)
      assert.equal(byPath(committed.digest, 'src/scratch.mjs'), undefined, 'an untracked file is not committed work')

      const { digest } = await readDiffDigest(wt, { uncommitted: true })
      assert.equal(digest.uncommitted, true)
      assert.equal(byPath(digest, 'src/app.mjs').added, 3, 'the uncommitted edit is part of the work so far')
      const scratch = byPath(digest, 'src/scratch.mjs')
      assert.equal(scratch.untracked, true)
      assert.equal(scratch.added, 2, 'a file git has never seen is counted off disk')
    } finally {
      git(wt, 'checkout', '--', 'src/app.mjs')
      fs.rmSync(path.join(wt, 'src/scratch.mjs'))
    }
  })

  test('the hunks come back as a real patch, on demand', async () => {
    const { digest } = await readDiffDigest(wt)
    const out = await readFileHunks(wt, byPath(digest, 'src/app.mjs'))
    assert.equal(out.error, null)
    assert.match(out.text, /^diff --git a\/src\/app\.mjs/)
    assert.match(out.text, /^\+d$/m)
    assert.equal(out.truncated, false)
  })

  test('an untracked file has hunks too — read against nothing', async () => {
    fs.writeFileSync(path.join(wt, 'src/scratch.mjs'), 'one\ntwo\n')
    try {
      const { digest } = await readDiffDigest(wt, { uncommitted: true })
      const out = await readFileHunks(wt, digest.list.find((f) => f.untracked), { uncommitted: true })
      assert.equal(out.error, null)
      assert.match(out.text, /^\+one$/m)
    } finally {
      fs.rmSync(path.join(wt, 'src/scratch.mjs'))
    }
  })

  // NULL, NEVER EMPTY. An orphan gate whose agent died has no worktree left,
  // and "curia could not count this" must never render as "nothing changed".
  test('a worktree that is gone is null with a reason, not an empty digest', async () => {
    const { digest, error } = await readDiffDigest(path.join(tmp, 'no-such-tree'))
    assert.equal(digest, null)
    assert.match(error, /worktree is gone/)
    assert.ok(!error.includes(tmp), 'the reason must not carry a path on the box')
    assert.match(digestLine(digest, error), /could not count this diff/)
  })

  test('a directory that is no git repository is null with git\'s own reason', async () => {
    const notRepo = path.join(tmp, 'not-a-repo')
    fs.mkdirSync(notRepo, { recursive: true })
    const { digest, error } = await readDiffDigest(notRepo)
    assert.equal(digest, null)
    assert.ok(error)
  })

  test('the hunk read is null with a reason when the worktree is gone', async () => {
    const out = await readFileHunks(path.join(tmp, 'no-such-tree'), { path: 'src/app.mjs' })
    assert.equal(out.text, null)
    assert.match(out.error, /worktree is gone/)
  })

  // The first cap: the per-file list, so one record cannot bloat the journal.
  // The TOTALS still count every file, and the digest says the cap bit.
  test('the per-file list stops at 200 files, and says so, while the totals do not', async () => {
    const many = path.join(wt, 'many')
    fs.mkdirSync(many, { recursive: true })
    for (let i = 0; i < FILE_CAP + 12; i++) fs.writeFileSync(path.join(many, `f${i}.mjs`), 'x\n')
    commit(wt, 'many files')
    try {
      const { digest } = await readDiffDigest(wt)
      assert.equal(digest.capped, true)
      assert.equal(digest.list.length, FILE_CAP)
      assert.equal(digest.files, FILE_CAP + 12 + 6, 'the total counts every file, capped list or not')
      assert.ok(digest.added >= FILE_CAP + 12, 'the totals are not capped either')
      assert.match(digestLine(digest), new RegExp(`the file list stops at ${FILE_CAP}`))
    } finally {
      git(wt, 'reset', '-q', '--hard', 'HEAD~1')
    }
  })
})

// The second cap: how much of one file the console draws.
describe('the hunk line cap (#355)', () => {
  test('a long file stops at the cap and states how many lines it did not show', () => {
    const out = capText(Array.from({ length: HUNK_LINE_CAP + 57 }, (_, i) => `+line ${i}`).join('\n'))
    assert.equal(out.lines_shown, HUNK_LINE_CAP)
    assert.equal(out.lines_total, HUNK_LINE_CAP + 57)
    assert.equal(out.truncated, true)
    assert.equal(out.text.split('\n').length, HUNK_LINE_CAP)
  })

  test('a short file is not truncated, and its trailing newline is not a line', () => {
    const out = capText('a\nb\nc\n')
    assert.equal(out.lines_total, 3)
    assert.equal(out.truncated, false)
  })
})

describe('the rank rule (#355)', () => {
  test('the rule is one sentence, and the card states it', () => {
    assert.match(RANK_RULE, /source first, then tests, then docs, generated and lock files last/)
  })

  test('every file lands in exactly one class', () => {
    assert.equal(classOf('daemon/src/dashboard.mjs'), 'source')
    assert.equal(classOf('daemon/test/round.test.mjs'), 'test')
    assert.equal(classOf('test/fixtures/skills.mjs'), 'test')
    assert.equal(classOf('docs/adr/0013-one-voice-per-fact.md'), 'doc')
    assert.equal(classOf('README.md'), 'doc')
    assert.equal(classOf('daemon/package-lock.json'), 'generated')
    assert.equal(classOf('web/dist/app.min.js'), 'generated')
  })

  // Generated is asked first on purpose: a lock file is a lock file wherever it
  // sits, and a snapshot under a test directory is still something nobody wrote.
  test('class beats location — a lock file under docs is still generated', () => {
    assert.equal(classOf('docs/package-lock.json'), 'generated')
    assert.equal(classOf('test/__snapshots__/x.snap'), 'generated')
  })

  test('source first, then tests, then docs, then generated — largest first inside each', () => {
    const ranked = rankFiles([
      { path: 'package-lock.json', added: 900, deleted: 900 },
      { path: 'docs/guide.md', added: 30, deleted: 0 },
      { path: 'src/small.mjs', added: 2, deleted: 1 },
      { path: 'test/big.test.mjs', added: 200, deleted: 0 },
      { path: 'src/big.mjs', added: 120, deleted: 4 },
      { path: 'test/small.test.mjs', added: 5, deleted: 0 },
    ])
    assert.deepEqual(ranked.map((f) => f.path), [
      'src/big.mjs', 'src/small.mjs',
      'test/big.test.mjs', 'test/small.test.mjs',
      'docs/guide.md',
      'package-lock.json',
    ])
  })

  // A file is addressed by its INDEX into this list (#266's seam), so two reads
  // of one change must rank it the same way or an index would move under the
  // operator's finger.
  test('the order is total — equal sizes break on the path, never on input order', () => {
    const files = [{ path: 'src/b.mjs', added: 1, deleted: 0 }, { path: 'src/a.mjs', added: 1, deleted: 0 }]
    assert.deepEqual(rankFiles(files).map((f) => f.path), ['src/a.mjs', 'src/b.mjs'])
    assert.deepEqual(rankFiles([...files].reverse()).map((f) => f.path), ['src/a.mjs', 'src/b.mjs'])
  })
})

describe('the parsers (#355)', () => {
  // `-z` records are NUL-terminated, and a NUL inside a source string is the
  // one byte a reader of this file could not see. It is spelled out here.
  const z = (...records) => records.map((r) => r + '\u0000').join('')

  test('numstat -z reads a plain record and a rename record', () => {
    const out = parseNumstatZ(z('12\t3\tsrc/app.mjs', '4\t0\t', 'old/name.mjs', 'new/name.mjs'))
    assert.equal(out.length, 2)
    assert.deepEqual(out[0], { path: 'src/app.mjs', from: null, added: 12, deleted: 3, binary: false })
    assert.equal(out[1].path, 'new/name.mjs')
    assert.equal(out[1].from, 'old/name.mjs')
  })

  // git prints a dash for both counts on a binary file. A zero there would be a
  // number the card could add up, and it would be a lie.
  test('numstat -z says binary with a dash, and a dash is never read as a zero', () => {
    const out = parseNumstatZ(z('-\t-\tsrc/blob.bin'))
    assert.equal(out[0].binary, true)
    assert.equal(out[0].added, null)
    assert.equal(out[0].deleted, null)
  })

  test('numstat -z reads a path with a space in it, which the plain form would quote', () => {
    const out = parseNumstatZ(z('1\t0\tdocs/a file.md'))
    assert.equal(out[0].path, 'docs/a file.md')
  })

  test('name-status -z reads a rename to its NEW name', () => {
    const out = parseNameStatusZ(z('M', 'src/app.mjs', 'R100', 'old.mjs', 'new.mjs', 'A', 'test/x.test.mjs'))
    assert.equal(out.get('src/app.mjs'), 'M')
    assert.equal(out.get('new.mjs'), 'R')
    assert.equal(out.get('test/x.test.mjs'), 'A')
  })

  test('hunk counts zip onto the file list, and a mismatch drops them all', () => {
    const patch = [
      'diff --git a/a.mjs b/a.mjs', '@@ -1 +1 @@', '-x', '+y',
      'diff --git a/b.mjs b/b.mjs', '@@ -1 +1 @@', '-x', '+y', '@@ -9 +9 @@', '-p', '+q',
    ].join('\n')
    assert.deepEqual(hunkCounts(patch, 2), [1, 2])
    assert.equal(hunkCounts(patch, 3), null)
  })
})

describe('the one Discord line (#355)', () => {
  const digest = {
    files: 14, added: 812, deleted: 233, capped: false, uncommitted: false,
    list: [
      { path: 'daemon/src/dashboard.mjs', added: 120, deleted: 4 },
      { path: 'daemon/src/store.mjs', added: 8, deleted: 1 },
    ],
  }

  test('it is the totals and the biggest file, on one line', () => {
    assert.equal(digestLine(digest), '14 files · +812 −233 · biggest: daemon/src/dashboard.mjs +120 −4')
  })

  test('the biggest file is the one with the most lines touched', () => {
    assert.equal(biggestOf(digest).path, 'daemon/src/dashboard.mjs')
  })

  test('a capped list says the cap on the same line', () => {
    assert.match(digestLine({ ...digest, capped: true }), /the file list stops at 200$/)
  })

  test('a branch that changed nothing says so, and never reads as unreadable', () => {
    assert.equal(digestLine({ files: 0, added: 0, deleted: 0, list: [] }), 'No file changed against the default branch.')
  })

  // The line goes to a phone. git's stderr names the daemon's own paths and
  // flags, and an operator can act on none of it.
  test('a null digest says curia could not count it, in prose and with no box path', () => {
    const line = digestLine(null, "Command failed: git -C /home/alp/work/repos/o__r/wt/42 diff\nfatal: not a git repository '/home/alp/work'")
    assert.match(line, /could not count this diff/)
    assert.ok(!line.includes('/home/alp'), 'a daemon path reached the card')
    assert.ok(!line.includes('Command failed'))
  })
})

describe('the pull-request fallback (#355)', () => {
  const patch = [
    'diff --git a/src/a.mjs b/src/a.mjs', 'index 1..2 100644', '--- a/src/a.mjs', '+++ b/src/a.mjs', '@@ -1 +1 @@', '-x', '+y',
    'diff --git a/src/b.mjs b/src/b.mjs', 'index 3..4 100644', '--- a/src/b.mjs', '+++ b/src/b.mjs', '@@ -1 +1 @@', '-p', '+q', '',
  ].join('\n')

  test('one file is sliced out of the whole pull-request diff', () => {
    const out = sliceFromPatch(patch, 'src/b.mjs')
    assert.match(out, /^diff --git a\/src\/b\.mjs/)
    assert.match(out, /^\+q$/m)
    assert.ok(!out.includes('src/a.mjs'))
  })

  test('a file the pull request does not carry answers null, never another file', () => {
    assert.equal(sliceFromPatch(patch, 'src/c.mjs'), null)
  })
})

// The diff digest (#355, building #343's Diff-then-ship).
//
// The gate card answers "how big is this, and what did it touch" before the
// approve press. It never carries the whole diff: GitHub keeps the full read
// and the console keeps the decision.
//
// Everything here is a MEASUREMENT. No line the digest produces is prose an
// agent wrote — the summary at `request_review` stays the one account of the
// work, and every number beside it is something curia counted itself. That is
// what makes the gate a check of an account against evidence rather than two
// accounts of one change (#343).
//
// TWO READS, one shape. The gate counts what is COMMITTED against the merge
// base, once, at the instant the gate opens (dispatch.mjs). The live agent row
// counts committed and uncommitted work TOGETHER, on demand, because that is
// what "the work so far" means while a note can still steer it. Both return the
// object `digestLine` and the console draw from, so one card serves both.
//
// NULL, NEVER EMPTY. A worktree that is already gone — an orphan gate whose
// agent died — makes the digest null with its reason. Zero changed files and an
// unreadable worktree are opposite facts and must never render the same.

import fs from 'node:fs'
import path from 'node:path'
import { execFileP } from './exec.mjs'
import { failureProse } from './messaging.mjs'

// Local git plumbing only. The same ceiling workspace.mjs puts on its own git
// calls, and the same signal: git removes its lock files on SIGTERM and SIGKILL
// bypasses them.
const GIT_TIMEOUT_MS = 120_000

function git(cwd, args) {
  return execFileP('git', ['-C', cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGTERM',
  })
}

// `git diff` exits 1 when it finds differences under `--no-index`, and
// execFileP throws on any nonzero exit. Exit 1 is the ANSWER there, not a
// failure, so it is read off the error the wrapper carries.
async function gitDiffText(cwd, args) {
  try {
    const { stdout } = await git(cwd, args)
    return stdout
  } catch (e) {
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout
    throw e
  }
}

// How many files the per-file list may carry, so one record cannot bloat the
// journal. The TOTALS are never capped — they count every file — and the card
// says when the cap bites, because a list that silently stops is a list that
// lies about what the change touched.
export const FILE_CAP = 200

// How many lines of one file's hunks the console draws. A long file stops here,
// says how many lines it did not show, and puts the GitHub link beside it.
export const HUNK_LINE_CAP = 400

// Above either of these the per-file hunk COUNT is not measured. The count
// needs the patch text, which the numstat read does not; one extra local `git
// diff -U0` pays for it on an ordinary change and would not on a generated one.
// The caption then omits the hunks rather than guessing at them.
const HUNK_COUNT_MAX_FILES = 400
const HUNK_COUNT_MAX_LINES = 50_000

// An untracked file bigger than this is not counted line by line. It is listed,
// with its size unknown, rather than read into the daemon's memory.
const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------------------
// the rank rule
// ---------------------------------------------------------------------------
//
// Printed on the card, in these words, because a rank the operator cannot see
// is a rank that hides things. It decides only WHICH FILE OPENS EXPANDED and in
// what order the rest are listed. Nothing is hidden by it: every changed file
// is on the card with its own numbers.

export const RANK_RULE = 'source first, then tests, then docs, generated and lock files last — largest first inside each class'

const CLASSES = ['source', 'test', 'doc', 'generated']

const LOCK_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock',
  'go.sum', 'flake.lock', 'uv.lock',
])
const GENERATED_DIRS = /(^|\/)(node_modules|vendor|dist|build|out|\.next|coverage|__snapshots__)\//
const GENERATED_EXT = /\.(min\.js|min\.css|map|snap|lock|pb\.go|generated\.[a-z]+)$/
const TEST_DIRS = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures)\//
const TEST_FILES = /(^|\/)[^/]*[._](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]*\.py$/
const DOC_DIRS = /(^|\/)(docs?|adr)\//
const DOC_EXT = /\.(md|mdx|rst|txt|adoc)$/i

// One class per file, first match wins. Generated is asked FIRST: a lock file
// under `docs/` is still a lock file, and a snapshot under `__tests__/` is
// still generated.
export function classOf(file) {
  const p = String(file ?? '')
  const base = p.split('/').pop() ?? ''
  if (LOCK_NAMES.has(base) || GENERATED_DIRS.test(p) || GENERATED_EXT.test(p)) return 'generated'
  if (TEST_DIRS.test(p) || TEST_FILES.test(p)) return 'test'
  if (DOC_DIRS.test(p) || DOC_EXT.test(p)) return 'doc'
  return 'source'
}

const sizeOf = (f) => (f.added ?? 0) + (f.deleted ?? 0)

// Largest first inside each class, and the path breaks a tie — so the same
// change ranks the same way twice, which is what lets a file index address a
// file across two reads.
export function rankFiles(files) {
  return [...files].sort((a, b) => {
    const ca = CLASSES.indexOf(classOf(a.path))
    const cb = CLASSES.indexOf(classOf(b.path))
    if (ca !== cb) return ca - cb
    if (sizeOf(a) !== sizeOf(b)) return sizeOf(b) - sizeOf(a)
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
}

// ---------------------------------------------------------------------------
// reading git
// ---------------------------------------------------------------------------

// `git diff -z --numstat`: `added TAB deleted TAB path NUL`, and for a rename
// `added TAB deleted TAB NUL from NUL to NUL`. `-z` rather than the plain form
// because the plain form quotes and abbreviates a path with a space in it, and
// the path is the key everything else here joins on.
export function parseNumstatZ(stdout) {
  const tok = String(stdout ?? '').split('\0')
  const out = []
  for (let i = 0; i < tok.length; i++) {
    const m = /^(\S+)\t(\S+)\t(.*)$/.exec(tok[i])
    if (!m) continue
    const [, a, d, tail] = m
    let from = null
    let file = tail
    if (tail === '') { from = tok[++i] ?? ''; file = tok[++i] ?? '' }
    // `-` for both counts is git saying binary: no line count exists, so the
    // totals must not take a zero for one.
    const binary = a === '-' && d === '-'
    out.push({
      path: file,
      from,
      added: binary ? null : Number(a),
      deleted: binary ? null : Number(d),
      binary,
    })
  }
  return out
}

// `git diff -z --name-status`: `status NUL path NUL`, and for a rename or copy
// `status NUL from NUL to NUL`. The score rides the letter (`R100`) and is
// dropped — the card says "renamed", not how alike the two files are.
export function parseNameStatusZ(stdout) {
  const tok = String(stdout ?? '').split('\0').filter((t) => t !== '')
  const out = new Map()
  for (let i = 0; i < tok.length; i++) {
    const status = tok[i]
    if (!/^[A-Z]\d*$/.test(status)) continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') { i += 1; out.set(tok[++i] ?? '', letter) } else { out.set(tok[++i] ?? '', letter) }
  }
  return out
}

// How many hunks each file carries, read off one `-U0` patch.
//
// The patch is split by file and ZIPPED with the numstat list rather than
// keyed by path: `diff --git` quotes a path with a space in it, and a parser
// that unquoted it would be a second, weaker path reader beside the `-z` one
// above. Both outputs come off the same diff queue in the same order, so the
// zip holds — and a length mismatch drops the counts for the whole read rather
// than labelling one file with another's number.
export function hunkCounts(patch, expected) {
  const chunks = String(patch ?? '').split(/^diff --git /m).slice(1)
  if (chunks.length !== expected) return null
  return chunks.map((c) => (c.match(/^@@ /gm) ?? []).length)
}

// The lines an untracked file would add. Read from disk, because git holds
// nothing about a file it has never seen.
function untrackedCount(wtPath, file) {
  try {
    const full = path.join(wtPath, file)
    const { size } = fs.statSync(full)
    if (size > UNTRACKED_MAX_BYTES) return { added: null, deleted: null, binary: true }
    const buf = fs.readFileSync(full)
    if (buf.includes(0)) return { added: null, deleted: null, binary: true }
    if (!buf.length) return { added: 0, deleted: 0, binary: false }
    let lines = 0
    for (const b of buf) if (b === 0x0a) lines++
    if (buf[buf.length - 1] !== 0x0a) lines++
    return { added: lines, deleted: 0, binary: false }
  } catch {
    return { added: null, deleted: null, binary: true }
  }
}

// The base every read here measures against: the merge base of the branch and
// the default branch's remote tip. `A...B` asks git for it on the committed
// read; the working-tree read needs the commit itself, because `git diff` with
// a range cannot also see uncommitted work.
async function mergeBase(wtPath, defaultBranch) {
  const { stdout } = await git(wtPath, ['merge-base', `origin/${defaultBranch}`, 'HEAD'])
  return stdout.trim()
}

async function defaultBranchIn(wtPath) {
  const { stdout } = await git(wtPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  return stdout.trim().replace('refs/remotes/origin/', '')
}

// ---------------------------------------------------------------------------
// the digest
// ---------------------------------------------------------------------------

// Returns `{ digest, error }`, exactly one of them set.
//
// `uncommitted: true` is the live agent row (#355): committed and uncommitted
// work together, untracked files included, because a file an agent wrote and
// has not committed is still the shape of the change.
export async function readDiffDigest(wtPath, { uncommitted = false, defaultBranch = null } = {}) {
  if (!wtPath || !fs.existsSync(wtPath)) {
    // No path in the reason. It goes on a Discord card and into a browser, and
    // a directory on the box is a fact neither reader can act on.
    return { digest: null, error: 'the agent worktree is gone' }
  }
  try {
    const def = defaultBranch ?? await defaultBranchIn(wtPath)
    const base = uncommitted ? await mergeBase(wtPath, def) : `origin/${def}...HEAD`
    const [numstat, nameStatus] = await Promise.all([
      git(wtPath, ['diff', '-z', '--numstat', base]).then((r) => r.stdout),
      git(wtPath, ['diff', '-z', '--name-status', base]).then((r) => r.stdout),
    ])
    const parsed = parseNumstatZ(numstat)
    const status = parseNameStatusZ(nameStatus)
    const files = parsed.map((f) => ({
      path: f.path,
      from: f.from,
      added: f.added,
      deleted: f.deleted,
      binary: f.binary,
      status: status.get(f.path) ?? 'M',
      untracked: false,
      hunks: null,
    }))

    // The hunk count, from one extra local read, bounded. A change big enough
    // to skip it says so by carrying no hunk numbers at all rather than zeros.
    const lines = files.reduce((n, f) => n + (f.added ?? 0) + (f.deleted ?? 0), 0)
    if (files.length && files.length <= HUNK_COUNT_MAX_FILES && lines <= HUNK_COUNT_MAX_LINES) {
      try {
        const patch = await gitDiffText(wtPath, ['diff', '-U0', '--no-color', base])
        const counts = hunkCounts(patch, files.length)
        if (counts) files.forEach((f, i) => { f.hunks = counts[i] })
      } catch { /* the counts are a caption, never the measurement — drop them */ }
    }

    if (uncommitted) {
      const { stdout } = await git(wtPath, ['ls-files', '-z', '--others', '--exclude-standard'])
      for (const file of stdout.split('\0').filter(Boolean)) {
        files.push({
          path: file, from: null, ...untrackedCount(wtPath, file),
          status: 'A', untracked: true, hunks: null,
        })
      }
    }

    const ranked = rankFiles(files)
    return {
      digest: {
        uncommitted,
        files: ranked.length,
        added: ranked.reduce((n, f) => n + (f.added ?? 0), 0),
        deleted: ranked.reduce((n, f) => n + (f.deleted ?? 0), 0),
        capped: ranked.length > FILE_CAP,
        rank_rule: RANK_RULE,
        list: ranked.slice(0, FILE_CAP),
      },
      error: null,
    }
  } catch (e) {
    return { digest: null, error: e.message }
  }
}

// The biggest file by lines touched, for the one line Discord carries. Read off
// the LIST, so a capped digest names the biggest file it kept — which the rank
// rule guarantees is the biggest of its class, and the cap is stated beside it.
export function biggestOf(digest) {
  let top = null
  for (const f of digest?.list ?? []) if (!top || sizeOf(f) > sizeOf(top)) top = f
  return top
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// The one line the Discord gate card gains under its links (#355).
//
// The hunks never go to Discord. A phone-sized message cannot hold them, and
// the console is where the read happens.
export function digestLine(digest, error = null) {
  // `failureProse` rather than the raw reason: this line goes to a phone, and
  // git's own stderr names the daemon's paths and flags in it.
  if (!digest) return `⚠️ curia could not count this diff — ${error ? failureProse(error) : 'no reason was recorded'}`
  if (!digest.files) return 'No file changed against the default branch.'
  const parts = [
    plural(digest.files, 'file'),
    `+${digest.added} −${digest.deleted}`,
  ]
  const top = biggestOf(digest)
  if (top) parts.push(`biggest: ${top.path} +${top.added ?? 0} −${top.deleted ?? 0}`)
  if (digest.capped) parts.push(`the file list stops at ${FILE_CAP}`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// the hunks, on demand
// ---------------------------------------------------------------------------

// One file's hunks, read from the worktree when the console asks for them.
// Never on the poll: this costs a git call, and the 5s poll would pay it for a
// card nobody opened.
//
// The caller passes the file's INDEX into the digest's own ranked list, never a
// path (#266's seam). The daemon resolves the worktree and the path itself, so
// nothing a browser sends can name a file curia did not already measure.
export async function readFileHunks(wtPath, file, { uncommitted = false, defaultBranch = null, cap = HUNK_LINE_CAP } = {}) {
  if (!wtPath || !fs.existsSync(wtPath)) return { text: null, error: 'the agent worktree is gone' }
  try {
    const def = defaultBranch ?? await defaultBranchIn(wtPath)
    const base = uncommitted ? await mergeBase(wtPath, def) : `origin/${def}...HEAD`
    const text = file.untracked
      ? await gitDiffText(wtPath, ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path])
      : await gitDiffText(wtPath, ['diff', '--no-color', base, '--', file.path])
    return { ...capText(text, cap), error: null }
  } catch (e) {
    return { text: null, error: e.message }
  }
}

// A long file stops at the cap. What it did not show is a number the card
// states, beside the GitHub link that carries the rest.
export function capText(text, cap = HUNK_LINE_CAP) {
  const lines = String(text ?? '').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const shown = lines.slice(0, cap)
  return {
    text: shown.join('\n'),
    lines_shown: shown.length,
    lines_total: lines.length,
    truncated: lines.length > shown.length,
  }
}

// The fallback when the worktree is gone (#355): the pull request's own diff,
// sliced to the one file. `gh pr diff` speaks the same unified format, so the
// card draws the same thing from a different source and says which.
export function sliceFromPatch(patch, file) {
  const chunks = String(patch ?? '').split(/^diff --git /m).slice(1)
  for (const c of chunks) {
    const head = c.split('\n')[0] ?? ''
    // `a/<path> b/<path>`, and a path with a space in it arrives quoted. Both
    // ends are compared, so a rename matches on either name.
    if (head.includes(`a/${file}`) || head.includes(`b/${file}`) || head.includes(`"a/${file}"`) || head.includes(`"b/${file}"`)) {
      return `diff --git ${c.replace(/\n+$/, '')}`
    }
  }
  return null
}

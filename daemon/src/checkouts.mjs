// The overseer's checkouts (#312, building ADR-0014's "it reads a persistent
// checkout of every watched repo").
//
// One blobless clone per watched repo, under the workspace root:
//
//   <workspace_root>/overseer/repos/<owner>__<repo>
//
// ONE HOST TREE, NOT A VOLUME PER REPO. ADR-0014 says "its own volume", and a
// named docker volume per repo has to be declared in `compose.yaml`, which is
// static. The watch list is not: the settings screen rewrites it. So the tree
// is one bind mount at its identical path inside the container — the same-path
// principle every other mount already follows — and the set of clones inside it
// moves with the config. #327 writes that mount line, because it owns the
// service.
//
// ONE OWNER: THE OVERSEER CONTAINER. The pass below runs at the start of every
// turn, inside that container, on its own read-only token. It clones what is
// missing, deletes the clone of a repo nobody watches, and fetches the rest in
// parallel. The daemon asserts nothing about this tree. Two owners would race
// on one fetch per turn, and the turn is the container's to define.
//
// THE CHECKOUT IS A MIRROR OF ORIGIN, and it holds nothing of its own. No git
// identity is configured, so a commit here fails by naming the missing name.
// Nothing local ever lives here, which is what makes both destructive moves in
// this file safe: the working tree is force-reset to the fetched default branch
// on every pass, and the clone of an unwatched repo is deleted whole. Re-watch
// the repo and the next turn clones it again.
//
// WHY THE FORCE-RESET. `git fetch` moves `refs/remotes/origin/*` and leaves the
// working tree where it was. A checkout cloned a month ago would then answer
// `cat README.md` from a month-old commit, while `git log origin/main` answered
// from today. That is the one failure ADR-0014's "one fetch per turn makes
// every read inside that turn consistent" exists to prevent, so the pass moves
// the working tree too.
//
// A FAILED FETCH DOES NOT REFUSE THE TURN. The pass returns a verdict per repo,
// and a repo whose fetch failed carries the instant of its last good one. The
// caller (#314) tells the model which checkout is stale and how old it is.
// Refusing a whole turn on one network stall would make the chat useless. The
// model reading a stale checkout believing it is fresh is the real failure, and
// the verdict is what prevents it.

import fs from 'node:fs'
import path from 'node:path'
import { execFileP } from './exec.mjs'

// A fetch over the network is not fast, and a first clone is slower still.
// Both still need a ceiling: a wedged child must never hold a turn open
// forever. SIGTERM rather than the wrapper's SIGKILL default, for the reason
// workspace.mjs states — git removes its lock files on SIGTERM, and a clone
// killed hard leaves `.git/index.lock` behind for a human to delete.
const GIT_TIMEOUT_MS = 120_000
const CLONE_TIMEOUT_MS = 600_000

function git(cwd, args, options = {}) {
  return execFileP('git', ['-C', cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGTERM', ...options,
  })
}

// EVERY REF, as ADR-0014 states it. Three refspecs, and each one answers a
// question an operator asks this chat:
//
//   heads — every branch, so `curia/<n>` is there. "What is this agent doing."
//   pull  — pull-request HEADS, as `origin/pr/<n>`. A pull request from a FORK
//           reaches this clone no other way, and "what did this agent change"
//           is the first thing asked. The MERGE refs are deliberately absent:
//           GitHub computes those against a moving base, so they answer a
//           different question and go stale without anything changing.
//   tags  — a release is a thing to be asked about.
//
// Written into `remote.origin.fetch` as well as passed on the command line. The
// command line is what the turn-start pass uses, so the pass never depends on
// the config being right. The config is what a mid-turn `git fetch` or
// `git pull` reads, and ADR-0014 keeps `git pull` available for the case where
// the overseer must be exact inside a turn.
export const FETCH_REFSPECS = [
  '+refs/heads/*:refs/remotes/origin/*',
  '+refs/pull/*/head:refs/remotes/origin/pr/*',
  '+refs/tags/*:refs/tags/*',
]

// Where the tree sits under the workspace root. `overseer/` beside `repos/` and
// `cfg/`, rather than inside `repos/`: that directory is keyed by ticket number
// under each repo, and these clones belong to no ticket.
export function checkoutsRootFor(root) {
  return path.join(root, 'overseer', 'repos')
}

// `alp82/curia` → `alp82__curia`, the same spelling `worktreePathFor` uses. The
// inverse is never taken: the prune below compares against the set of names the
// watch list generates, so a repo name holding `__` costs nothing.
export function checkoutDirNameFor(repo) {
  return String(repo).replace('/', '__')
}

export function checkoutPathFor(root, repo) {
  return path.join(checkoutsRootFor(root), checkoutDirNameFor(repo))
}

// The instant of the last good fetch, kept inside `.git` so it is neither in
// the working tree nor in anything `git status` reports. It is what a repo
// whose fetch just failed reports its age from.
const STAMP = 'curia-fetched-at'

function stampFile(wt) {
  return path.join(wt, '.git', STAMP)
}

export function readFetchStamp(wt) {
  try {
    return fs.readFileSync(stampFile(wt), 'utf8').trim() || null
  } catch {
    return null
  }
}

// `gh repo clone` rather than `git clone`, for the reason createPrivateClone
// states: it carries whatever login the environment holds, so a private watched
// repo clones with no credential helper set up first. In the overseer container
// that login is the read-only token of #313.
//
// `--filter=blob:none` is ADR-0014's blobless clone. Commits and trees now,
// blobs on demand — so a checkout of every watched repo costs seconds rather
// than a full history download each.
//
// Injectable because no unit test can reach `gh`. The suite passes a clone that
// runs `git clone` against a local origin instead.
async function ghClone(repo, wt) {
  await execFileP('gh', ['repo', 'clone', repo, wt, '--', '--filter=blob:none'], {
    maxBuffer: 16 * 1024 * 1024, timeout: CLONE_TIMEOUT_MS,
  })
}

// Is there a USABLE clone here? Not `does .git exist` — `git clone` writes
// `.git` early and fills it as it goes, so a clone this pass's timeout killed
// leaves a directory that looks like a repository and answers nothing. That
// shape would then fail its fetch on every later turn and never be repaired,
// because nothing would ever decide to clone over it.
//
// So the question asked is the one that matters: can this clone resolve a
// commit? A repository with no commits at all answers no and gets re-cloned
// each turn — that is one wasted clone per turn on a repo that holds nothing to
// read, and curia cannot dispatch against one either.
async function isUsableClone(wt) {
  if (!fs.existsSync(path.join(wt, '.git'))) return false
  try {
    await git(wt, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

// Where a checkout points. gh follows the box's `git_protocol`, which may be
// ssh, and this container holds no ssh key — so HTTPS with the token in the
// environment is the one way out of here, exactly as it is for an agent's
// private clone.
//
// Injectable for the same reason the clone is: the suite drives real git
// against a local origin, and a checkout that rewrote itself back to
// github.com would make every case in it a live network read.
export const githubUrlFor = (repo) => `https://github.com/${repo}.git`

// What every checkout must say about itself, re-asserted on every pass rather
// than only at clone time, so a clone a hand edit broke heals on the next turn.
async function configure(wt, repo, urlFor) {
  await git(wt, ['remote', 'set-url', 'origin', urlFor(repo)])
  await git(wt, ['config', 'credential.helper', '!gh auth git-credential'])

  // A MANNER, NOT A CONTROL. The read-only token is what makes a push fail, and
  // ADR-0014 is explicit that no standing order holds a shell. This states the
  // posture where a reader meets it, and a shell can undo it in one command.
  await git(wt, ['config', 'remote.origin.pushurl', 'no_push://the-overseer-checkout-is-read-only'])

  // No user.name and no user.email, deliberately. Nothing here is ever
  // committed, and a commit that fails with "please tell me who you are" says
  // so louder than a comment does.

  await git(wt, ['config', '--replace-all', 'remote.origin.fetch', FETCH_REFSPECS[0]])
  for (const spec of FETCH_REFSPECS.slice(1)) {
    await git(wt, ['config', '--add', 'remote.origin.fetch', spec])
  }
}

// origin's default branch, read from the tracking ref the clone wrote.
async function defaultBranch(wt) {
  const { stdout } = await git(wt, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  return stdout.trim().replace('refs/remotes/origin/', '')
}

// Fetch every ref, then put the working tree on the fetched default branch.
//
// `--prune` against these three refspecs is what makes this a mirror: a branch
// deleted on origin, a closed pull request's head, and a deleted tag all go.
// Without it the chat would answer from refs that no longer exist anywhere.
//
// `checkout --force -B` throws away local modifications to tracked files and
// moves the branch to the fetched tip. Untracked files survive, because a
// previous turn may have left one on purpose and this pass has no business
// judging that.
async function fetchAndReset(wt) {
  await git(wt, ['fetch', '--prune', '--quiet', 'origin', ...FETCH_REFSPECS], { timeout: CLONE_TIMEOUT_MS })
  // The default branch can be renamed. This is an ls-remote, so it carries no
  // objects, and a failure leaves the tracking ref the clone wrote.
  try {
    await git(wt, ['remote', 'set-head', 'origin', '--auto'])
  } catch { /* keep whatever origin/HEAD already says */ }
  const branch = await defaultBranch(wt)
  await git(wt, ['checkout', '--force', '-B', branch, `refs/remotes/origin/${branch}`])
  const { stdout } = await git(wt, ['rev-parse', 'HEAD'])
  return { branch, head: stdout.trim() }
}

// One repo: clone it if it is not there, then bring it up to date. Returns what
// the turn needs to describe this checkout to the model.
export async function ensureCheckout(root, repo, { clone = ghClone, now = () => new Date(), urlFor = githubUrlFor } = {}) {
  const wt = checkoutPathFor(root, repo)
  let cloned = false
  if (!await isUsableClone(wt)) {
    fs.rmSync(wt, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    await clone(repo, wt)
    cloned = true
  }
  await configure(wt, repo, urlFor)
  const { branch, head } = await fetchAndReset(wt)
  const at = now().toISOString()
  fs.writeFileSync(stampFile(wt), `${at}\n`)
  return { repo, path: wt, ok: true, cloned, branch, head, fetchedAt: at }
}

// THE TURN-START PASS. Every watched repo, in parallel, before the model runs.
//
// Parallel with no cap: the watch list is a handful of repos an operator typed
// by hand, and a cap would only slow the one case this pass has to be fast in.
//
// It never throws for a repo. A clone that failed and a fetch that failed both
// come back as `ok: false` with the error and the age of the last good fetch,
// and the turn goes ahead. What it does throw for is a root it cannot create,
// because then there are no checkouts at all and saying so once beats saying it
// per repo.
export async function syncCheckouts(root, repos, { clone = ghClone, now = () => new Date(), urlFor = githubUrlFor } = {}) {
  const base = checkoutsRootFor(root)
  fs.mkdirSync(base, { recursive: true })

  const removed = pruneUnwatched(base, repos)

  const results = await Promise.all(repos.map(async (repo) => {
    try {
      return await ensureCheckout(root, repo, { clone, now, urlFor })
    } catch (e) {
      const wt = checkoutPathFor(root, repo)
      const last = readFetchStamp(wt)
      return {
        repo,
        path: wt,
        ok: false,
        cloned: false,
        // The first line only: a git failure's later lines are progress noise,
        // and this string is read by a model inside a prompt. `||` rather than
        // `??`: a timeout kill gives an EMPTY stderr, and an empty error would
        // tell the model a checkout is stale without saying what happened.
        error: String(e.stderr || e.message || e).trim().split('\n')[0] || 'the fetch failed with no message',
        // null means there is no checkout at all, which is a different thing
        // from a stale one, and the turn has to be able to say which.
        fetchedAt: null,
        staleSince: last,
      }
    }
  }))

  return { root: base, at: now().toISOString(), removed, repos: results }
}

// The clone of a repo nobody watches is DELETED (#312's open thread). It is a
// mirror of origin and holds nothing unique — no local commit can exist here —
// so the delete loses nothing, and watching the repo again re-clones it in
// seconds. The alternative was to keep it, and that lets the chat read a repo
// the operator removed, at an age nobody states.
//
// It compares against the names the watch list generates rather than parsing a
// directory name back into a repo, so a name that does not round-trip cannot
// cause a delete.
export function pruneUnwatched(base, repos) {
  const keep = new Set(repos.map(checkoutDirNameFor))
  const removed = []
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue
    fs.rmSync(path.join(base, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

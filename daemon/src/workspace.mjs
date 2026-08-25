// Daemon-owned workspaces (#33 step 6). Layout under workspace_root:
//   repos/<owner>__<repo>/wt/<n>     — the agent's private clone
//   repos/<owner>__<repo>/review/<n> — the reviewer's private clone (#164)
//   cfg/curia-<n>                    — per-agent config dir (+ prompt file);
//                                      holds no credential of its own since #53
// Never Alp's working tree; nothing here is authoritative state.
//
// ONE shape since #195: every agent runs in a container, and a container cannot
// mount a worktree cut from a shared base clone. The `repos/<...>/base` clone
// and the worktrees cut from it were the bare tmux path, and they are gone —
// from the code here, and by hand from the one box that carried leftovers.
//
// The config dir is per HARNESS since #39: `CLAUDE_CONFIG_DIR` for the claude
// harness, `CODEX_HOME` for the codex one. See the HARNESS table below — it is the
// one place the two harnesses differ on disk, and everything above it (worktrees,
// branches, landing) is harness-blind.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { execFileP } from './exec.mjs'
import { endingProse, CHARTING_NEVER, REVIEWER_NEVER, dutyLines, ALL_AS_RECOMMENDED } from './lifecycle.mjs'
import { TOKEN_HEADER } from './agenttoken.mjs'
import { forgetGhCredentials } from './agentgh.mjs'
// One expiry parser for the whole daemon (#642). The broker in credentials.mjs
// refreshes on the same reading this seed refuses on, and a second parser here
// would be free to disagree with it about whether a dispatch may proceed.
import { codexAccessTokenExpiry } from './credentials.mjs'
// the daemon's own minted credential (#390, ADR-0018) — every clone, fetch and
// push below reaches GitHub as `curia-sh[bot]` rather than as the operator
import { daemonGhEnv } from './daemongh.mjs'
// the salvage branch's stamp (#649). One stamp shape for the whole daemon: UTC,
// colons folded to hyphens, sorting in write order.
import { stampFor } from './backup.mjs'

// The mandatory communication rules (#133): a curia-owned copy of the
// operator's STE writing standard, seeded into every config dir as the CLI's
// global-memory file so the overseer and every agent load it. Committed in
// the repo, not read from the operator's dotfiles — the box does not carry
// those, and committed config is versioned.
const VOICE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'voice.md')

// Local git plumbing is fast; a fetch over the network is not, and a clone is
// slower still — but all three still need a ceiling so a wedged child can
// never hold up boot reconcile.
const GIT_TIMEOUT_MS = 120_000
const CLONE_TIMEOUT_MS = 600_000

// SIGTERM, not the wrapper's SIGKILL default: git installs handlers that
// remove its lock files on SIGTERM, and SIGKILL bypasses them — a fetch or
// checkout killed hard at the timeout leaves .git/index.lock or refs/**.lock
// behind, and every later git call against that clone then fails until a human
// deletes the lock. One transient network stall must not poison a workspace.
// (gh/tmux/tailscale keep SIGKILL: none of them holds on-disk locks we depend
// on.)
function git(cwd, args, options = {}) {
  return execFileP('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGTERM', ...options })
}

export function worktreePathFor(root, repo, n) {
  return path.join(root, 'repos', repo.replace('/', '__'), 'wt', String(n))
}

// The one directory name under the workspace root that holds every agent's
// config dir. Named once because two readers walk it: `cfgDirFor` writes a
// session's dir here, and `aistack.mjs` enumerates the same tree to find the
// roots a usage sync scans.
export const CFG_DIR = 'cfg'

export function cfgDirFor(root, session) {
  return path.join(root, CFG_DIR, session)
}

export function branchFor(n) {
  return `curia/${n}`
}

export async function defaultBranchOf(base) {
  const { stdout } = await git(base, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  return stdout.trim().replace('refs/remotes/origin/', '')
}

// Does origin already carry this ticket's branch? Read from the tracking ref
// the fresh clone just wrote — no second network round-trip, and no dependency
// on `gh auth setup-git` for a private repo (the reason pushBranch names its
// credential helper on the command line).
//
// `for-each-ref` rather than `rev-parse --verify`, because an absent ref must be
// distinguishable from a failed read: for-each-ref exits 0 with empty output for
// "not there" and non-zero only when git itself failed. A failed read must
// throw, since starting from the default branch on a repo we could not query
// would silently abandon commits already under review.
export async function remoteBranchExists(base, branch) {
  const { stdout } = await git(base, ['for-each-ref', '--format=%(refname)', `refs/remotes/origin/${branch}`])
  return stdout.trim().length > 0
}

// ---- the reviewer's checkout (#164, ADR-0010) --------------------------------

// The cross-check reviewer reads a live checkout of the branch, and it gets one
// of its OWN: `repos/<owner>__<repo>/review/<n>`, beside the builder's `wt/<n>`.
export function reviewPathFor(root, repo, n) {
  return path.join(root, 'repos', repo.replace('/', '__'), 'review', String(n))
}

// The pushed tip of a ticket's branch, fetched fresh. This is what the reviewer
// reads, and it is deliberately the PUSHED tip rather than whatever the
// builder's worktree holds: the cross-check is a second reading of the diff a
// human is looking at in the pull request, and a commit that exists only in one
// worktree is in no diff anybody can see. A branch that is not on origin at all
// refuses here, naming the call that puts it there.
async function fetchTip(gitDir, repo, branch, env) {
  try {
    await git(gitDir, ['fetch', 'origin', branch], { timeout: CLONE_TIMEOUT_MS, env })
  } catch (e) {
    throw new Error(`origin carries no \`${branch}\` for ${repo}, so there is no pushed diff to read (${(e.stderr ?? e.message ?? '').trim().split('\n')[0]}) — the builder has to call open_pull_request first`)
  }
  const { stdout } = await git(gitDir, ['rev-parse', 'FETCH_HEAD'])
  return stdout.trim()
}

// A checkout of the branch tip that the builder's own workspace cannot collide
// with. git refuses the same branch in two worktrees, so this one carries NO
// branch at all: a DETACHED HEAD at the tip sha. That also states the reviewer's
// posture on disk — there is no branch here to commit onto.
//
// One shape, the same one the builder has: a private blobless clone the
// reviewer's container mounts. The worktree shape went with the bare path
// (#195) — a container cannot use a worktree, because its `.git` is a file
// pointing at a base clone the container never mounts.
export async function createReviewCheckout(root, repo, n) {
  const wt = reviewPathFor(root, repo, n)
  const branch = branchFor(n)

  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  // The daemon's own minted token (#390). It carries the clone, the fetch and
  // the blobless checkout, which is every child here that reaches the network.
  const env = await daemonGhEnv(repo)
  await execFileP('gh', ['repo', 'clone', repo, wt, '--', '--filter=blob:none'], {
    maxBuffer: 16 * 1024 * 1024, timeout: CLONE_TIMEOUT_MS, env,
  })
  await git(wt, ['remote', 'set-url', 'origin', `https://github.com/${repo}.git`])
  await git(wt, ['config', 'credential.helper', '!gh auth git-credential'])
  const sha = await fetchTip(wt, repo, branch, env)
  await git(wt, ['checkout', '--detach', sha], { env })
  // The claude harness writes `.mcp.json` and `.claude/` into the checkout, and
  // the reviewer reads `git status` to see what the diff touched — so curia's
  // own files must not show up as the builder's changes.
  const excludeFile = path.join(wt, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.appendFileSync(excludeFile, '\n.mcp.json\n.claude/\n.curia-prompt.md\n')
  return { path: wt, sha, branch, baseBranch: await defaultBranchOf(wt) }
}

// ---- landing the work (#41) --------------------------------------------------

// What the agent ACTUALLY committed, observed by the daemon in git rather than
// taken from the agent's account of itself — this is what the PR body reports.
export async function commitsOnBranch(wtPath, defaultBranch) {
  const { stdout } = await git(wtPath, ['log', '--format=%h%x09%s', `origin/${defaultBranch}..HEAD`])
  return stdout.split('\n').filter((l) => l.trim()).map((l) => {
    const [sha, ...rest] = l.split('\t')
    return { sha, subject: rest.join('\t') }
  })
}

// Which FILES the branch touches, against the same merge base (#297). The
// charting bound is a path bound — `docs/research/` and nothing else — and this
// is the observation it is checked against. Read from git rather than from the
// agent, for the reason `commitsOnBranch` above is.
export async function changedFilesOnBranch(wtPath, defaultBranch) {
  const { stdout } = await git(wtPath, ['diff', '--name-only', `origin/${defaultBranch}...HEAD`])
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

// What the worktree holds that no commit does (#297): tracked edits and
// untracked files alike, as paths. The Stop hook reads it for a charting
// session, because a finding a subagent wrote and nobody committed dies with
// the workspace — and "no commits" alone cannot tell that case from a session
// that researched nothing.
export async function uncommittedFiles(wtPath) {
  const { stdout } = await git(wtPath, ['status', '--porcelain'])
  return stdout.split('\n').filter((l) => l.trim()).map((l) => {
    const p = l.slice(3).trim()
    // a rename reads `old -> new`; the new name is the one on disk
    return p.includes(' -> ') ? p.split(' -> ').pop().trim() : p
  })
}

// KEPT by #195, which named this for deletion and then measured it. Both
// callers are #54 repairs in resolve.mjs — `landBranch` when the agent never
// called `open_pull_request`, and the unmerged-at-resolve push — and neither is
// a bare-path mechanism. The workspace is a private clone on the HOST
// filesystem, so the daemon still reaches it, and the repair still has no other
// cure: an agent that committed and never pushed would otherwise leave the only
// copy of its work in a workspace the lifecycle is about to stop protecting.
//
// The daemon pushes; the agent never does (#41) — the same containment boundary
// as preview allocation (#40). This goes out over an EXPLICIT URL with gh's
// credential helper named on the command line, so it does not depend on
// `gh auth setup-git` having been run for whoever owns the box.
//
// WHO THE PUSH READS AS (#390). The helper resolves `GH_TOKEN` out of this
// child's environment, so the push carries the daemon's MINTED token and lands
// as `curia-sh[bot]`. That is half of why the app exists: a push the daemon
// performs for an agent used to read as the operator. An owner with no minted
// token keeps the host login, which is exactly what this line did before.
//
// Pushing an explicit URL does not move refs/remotes/origin/*, and
// hasUnpushedCommits() — which decides whether the orphan sweep is allowed to
// destroy a worktree — reads exactly that ref. So the tracking ref is updated
// here, to the sha that was actually pushed and nothing else.
export async function pushBranch(wtPath, repo, branch) {
  const { stdout } = await git(wtPath, ['rev-parse', 'HEAD'])
  const sha = stdout.trim()
  await git(wtPath, [
    '-c', 'credential.helper=!gh auth git-credential',
    'push', `https://github.com/${repo}.git`, `${sha}:refs/heads/${branch}`,
  ], { timeout: CLONE_TIMEOUT_MS, env: await daemonGhEnv(repo) })
  await git(wtPath, ['update-ref', `refs/remotes/origin/${branch}`, sha])
  return sha
}

// ---- local-only work, in its two kinds (#649, ADR-0028) ---------------------
//
// Work that exists in no place but this clone. It is the union of two facts,
// and they stay TWO predicates rather than one widened one: the cross-check
// callers ask about the pushed tip, and a dirty tree is no reason to refuse a
// cross-check or to trigger a repair push. A single vague predicate would have
// changed behavior at call sites that never asked for it.
//
// Both throw when they cannot tell, and every caller reads "unknown" as "keep".

// Does this worktree hold commits that exist nowhere else? Before #41 a
// worktree held only a local commit nobody depended on, so the orphan sweep
// could force-remove it freely. Now the daemon is expected to land that work,
// and a sweep that fires between the commit and the push would destroy the only
// copy. Throws when it cannot tell — callers must read "unknown" as "keep".
//
// Named `hasUnpushedCommits` since #649, because after it there is a second
// question this must not be mistaken for.
export async function hasUnpushedCommits(wtPath, branch, defaultBranch) {
  let ref = `origin/${defaultBranch}`
  try {
    await git(wtPath, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
    ref = `refs/remotes/origin/${branch}`
  } catch { /* never pushed: measure against the default branch instead */ }
  const { stdout } = await git(wtPath, ['rev-list', '--count', `${ref}..HEAD`])
  return Number(stdout.trim()) > 0
}

// The other kind: a tree an agent has been editing and has not committed. Built
// on `uncommittedFiles` rather than on a second `git status` call, so the two
// can never disagree about what counts — untracked files included, and the
// repo's `.gitignore` plus the clone's own `.git/info/exclude` are what separate
// work from noise.
export async function hasUncommittedChanges(wtPath) {
  return (await uncommittedFiles(wtPath)).length > 0
}

// Who a salvage commit says it is. NOT the clone's own identity, which is the
// ticket owner's or the app bot's and belongs to commits an agent chose to
// make: a machine commit of a tree nobody reviewed, under the owner's name,
// would be a lie about who wrote it. A constant rather than a read of the app's
// bot user, because this runs on the path that must not fail for a network
// reason — the whole point of the salvage is that it happens.
const SALVAGE_AUTHOR = { name: 'curia', email: 'curia@users.noreply.github.com' }

// Where local-only work goes. The stamp is `backup.mjs`'s — UTC, colons folded
// to hyphens, sorting in write order — and it is what makes the branch
// ACCUMULATE rather than overwrite: one ticket can be salvaged more than once,
// and a salvage that destroys the previous salvage is the same silent loss one
// level up.
export function salvageBranchFor(n, at) {
  return `curia/${n}-salvage-${stampFor(at)}`
}

// Capture everything this clone holds that exists nowhere else, then hand back
// the branch it landed on (#649, ADR-0028).
//
// `git add -A` and a commit, never `git diff HEAD`: the diff form silently drops
// untracked files, honors no ignore rules of its own, and produces a text blob
// where a ref is wanted. Pushing HEAD carries any unpushed commits along in the
// same act, which closes cancel's second silent loss for free.
//
// It goes to GitHub rather than to a patch under the workspace root because
// ADR-0001 says GitHub is the only durable state home — and because nobody
// reads a patch. A branch on the tracker is findable later, by the person who
// saw the alarm, with no knowledge that an archive directory exists.
//
// The push runs on `daemonGhEnv`, the daemon's OWN token, so it cannot race a
// cancel path that has already forgotten the agent's credential.
//
// `{ salvaged: false }` when there is nothing to capture — including a clone
// that is already gone, which is not a loss and must not read as one. It THROWS
// on every other failure, and every caller reads a throw as "keep the clone":
// destroying the only copy because a network call failed is the exact bug this
// closes.
//
// A push that fails leaves the COMMIT behind in the kept clone, and that is the
// right direction rather than a leak: the work is now committed instead of
// loose, the ticket branch reads as holding unpushed commits, and every keep
// rule downstream already answers that correctly.
//
// `remote` is the seam `checkoutTicketBranch`'s `env` is: the real caller passes
// none and the push goes to GitHub, and the suite drives a local bare origin.
export async function salvageLocalOnlyWork(wtPath, repo, n, { at = Date.now(), remote = null } = {}) {
  const nothing = { salvaged: false, branch: null, sha: null }
  if (!fs.existsSync(wtPath)) return nothing
  if (!repo) throw new Error('curia could not tell which repo this clone belongs to, so it has nowhere to push a salvage')
  const branch = branchFor(n)
  const dirty = await hasUncommittedChanges(wtPath)
  if (!dirty && !await hasUnpushedCommits(wtPath, branch, await defaultBranchOf(wtPath))) return nothing
  if (dirty) {
    await git(wtPath, ['add', '-A'])
    // `--no-verify`: a salvage must not run whatever hooks the repo or the
    // agent installed. It is curia's own act, not a commit the agent is making.
    await git(wtPath, [
      '-c', `user.name=${SALVAGE_AUTHOR.name}`,
      '-c', `user.email=${SALVAGE_AUTHOR.email}`,
      'commit', '--no-verify', '-m', salvageMessage(branch),
    ])
  }
  const { stdout } = await git(wtPath, ['rev-parse', 'HEAD'])
  const sha = stdout.trim()
  const salvage = salvageBranchFor(n, at)
  await git(wtPath, [
    '-c', 'credential.helper=!gh auth git-credential',
    'push', remote ?? `https://github.com/${repo}.git`, `${sha}:refs/heads/${salvage}`,
  ], { timeout: CLONE_TIMEOUT_MS, env: await daemonGhEnv(repo) })
  return { salvaged: true, branch: salvage, sha }
}

function salvageMessage(branch) {
  return `Salvage local-only work from ${branch}\n\n`
    + 'Committed by curia, not by the agent whose clone this was, and not '
    + 'reviewed by anyone. The clone was about to be destroyed and this is '
    + 'everything in it that existed nowhere else.\n\n'
    + 'See ADR-0028 and alp82/curia#649.\n'
}

// Branch is kept deliberately (salvage; re-frontier is the recovery).
//
// One shape since #195: a private clone, which owns its whole `.git` and is
// just a directory. The worktree arm — `git worktree remove` against a base
// clone — went with the bare path, once the one box carrying a leftover
// worktree was cleaned by hand.
export async function removeWorkspace(wtPath) {
  fs.rmSync(wtPath, { recursive: true, force: true })
}

// ---- the sandbox's private clone (#156, from #148) ---------------------------
//
// A container agent gets its OWN clone instead of a worktree cut from the
// shared base, because a worktree's `.git` is a file pointing into the base
// clone: mounting only the worktree would give the container a repository with
// no object store, and mounting the base as well would hand every agent every
// other agent's branches and commits.
//
// `--filter=blob:none` is what keeps that affordable. A blobless clone fetches
// commits and trees now and blobs on demand, so a per-ticket clone costs
// seconds rather than a full history download per dispatch.
//
// The remote is forced to HTTPS, and no push URL is disabled here: the base
// clone's `no_push://` trick exists because MANY agents share that clone, and
// a private clone the agent owns has nothing to protect from itself.
export async function createPrivateClone(root, repo, n, { identity = null } = {}) {
  const wt = worktreePathFor(root, repo, n)
  const branch = branchFor(n)
  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  // `gh repo clone` rather than `git clone`: it carries the daemon's own
  // credential, so a private watched repo clones with no credential helper set
  // up on the box. Everything after `--` is passed through to git.
  //
  // Since #390 that credential is the MINTED token of the ticket's owner, and
  // the same environment carries the blobless checkout below — a blobless clone
  // fetches blobs on demand, so `git checkout` reaches the network too.
  const env = await daemonGhEnv(repo)
  await execFileP('gh', ['repo', 'clone', repo, wt, '--', '--filter=blob:none'], {
    maxBuffer: 16 * 1024 * 1024, timeout: CLONE_TIMEOUT_MS, env,
  })
  // gh follows the box's `git_protocol` setting, which may be ssh — and the
  // container holds no ssh key by design. HTTPS with a token is the one way an
  // agent reaches the remote (#155).
  await git(wt, ['remote', 'set-url', 'origin', `https://github.com/${repo}.git`])
  // What the container pushes and fetches with. `gh` is in the image and
  // `GH_CONFIG_DIR` is in its environment, so the helper resolves to the token
  // the daemon minted for this agent rather than to any account on the box
  // (#389, #466).
  await git(wt, ['config', 'credential.helper', '!gh auth git-credential'])
  // The container HOME carries no gitconfig, so an unset identity would fail
  // the agent's first commit with "please tell me who you are". Copied from
  // the box rather than invented: authorship stays what the bare path produced.
  const who = identity ?? await hostGitIdentity()
  await git(wt, ['config', 'user.name', who.name])
  await git(wt, ['config', 'user.email', who.email])

  await checkoutTicketBranch(wt, branch, { env })

  const excludeFile = path.join(wt, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.appendFileSync(excludeFile, '\n.mcp.json\n.claude/\n.curia-prompt.md\n')
  return wt
}

// Put the workspace on `curia/<n>`, started from origin/curia/<n> WHERE THAT
// EXISTS and from origin's default branch otherwise.
//
// The start point is #54 item 6. Re-dispatch used to force-reset the branch off
// origin/HEAD and then push non-forced, which fails outright once a pull request
// is open — and, worse, would have thrown away every commit already under
// review. Now a re-dispatch continues the branch it finds, so the second agent
// adds to the same pull request (the rejection loop's own shape, applied across
// dispatches).
//
// -B is kept: the local branch must point at whichever start point was chosen.
//
// Its own function since #195, so the rule stays testable. It used to live in
// `createWorktree`, which a test could drive against a local origin; the one
// caller left clones through `gh`, which no unit test can reach.
//
// `env` is the caller's minted credential (#390). The two reads are local, and
// the checkout is not: this clone is blobless, so checking a branch out fetches
// the blobs it needs. The suite drives a local origin and passes none.
export async function checkoutTicketBranch(gitDir, branch, { env } = {}) {
  const start = await remoteBranchExists(gitDir, branch)
    ? `origin/${branch}`
    : `origin/${await defaultBranchOf(gitDir)}`
  await git(gitDir, ['checkout', '-B', branch, start], { env })
  return start
}

// The box's own git identity. A daemon on a box with none still has to be able
// to dispatch, so this falls back rather than refusing — but the fallback is a
// visible one, not a guess at who the operator is.
export async function hostGitIdentity() {
  const read = async (key) => {
    try {
      const { stdout } = await execFileP('git', ['config', '--global', key], { timeout: GIT_TIMEOUT_MS })
      return stdout.trim()
    } catch {
      return ''
    }
  }
  const name = await read('user.name')
  const email = await read('user.email')
  return {
    name: name || 'curia agent',
    email: email || 'curia@users.noreply.github.com',
  }
}

// Who a commit in this workspace says it is (#389).
//
// `createPrivateClone` writes the BOX's identity, because a clone happens before
// anything is minted and an agent with no identity fails its first commit with
// "please tell me who you are". This overwrites it for an agent on the app, so
// its commits read as `curia-sh[bot]` rather than as the operator — which is the
// attribution half of ADR-0018, said in the commit as well as in the push.
//
// A separate call rather than an argument to the clone, because the answer is
// not known that early: the token is minted with the container, and the identity
// follows the token. An agent that fell back to the PAT keeps the box identity,
// because a PAT push by the operator with a bot author on it would say two
// different things about one commit.
export async function setGitIdentity(gitDir, { name, email }) {
  await git(gitDir, ['config', 'user.name', name])
  await git(gitDir, ['config', 'user.email', email])
}

// Full removal where the worktree is destroyed anyway (cancel, orphan sweep);
// credentials-only where the workspace is kept for review (lifecycle close) so
// prompt.md survives the post-mortem. Since #53 an agent's config dir holds no
// credential of its own, so removeCredentials collects only leftovers — kept
// because a leftover is a real host refresh token sitting on disk.
export function removeConfigDir(cfgDir) {
  fs.rmSync(cfgDir, { recursive: true, force: true })
}

// Every path a harness could leave a credential at, swept whatever the agent's
// own harness was: a config dir is reused across dispatches and a re-seed onto
// the other harness leaves the first one's files behind.
//
// `rmSync` unlinks a symlink rather than following it, so sweeping the codex
// harness's `auth.json` link never touches the host file it points at. On the
// sandboxed codex harness that path holds a real COPY instead (#158), and sweeping
// it is the point rather than a side effect: it is a live host credential, and
// the copy outlives the container it was made for.
//
// The minted GitHub credential (#389) goes the same way and through this same
// call, because it is the same fact: a live credential in a config dir whose
// agent is finished. It is the one the daemon itself WROTE rather than one a
// harness left, so it is also the one a re-arm must clear — `seedConfigDir`
// runs this first, and `#prepareContainer` then writes the fresh token or
// leaves the agent on the PAT with no stale file beside it.
export function removeCredentials(cfgDir) {
  for (const name of ['.credentials.json', 'auth.json']) {
    fs.rmSync(path.join(cfgDir, name), { force: true })
  }
  forgetGhCredentials(cfgDir)
}

// ---- the per-harness table ------------------------------------------------
//
// One agent, two shapes on disk. The claude harness keeps its config dir and puts
// curia's side channel in the WORKTREE (.mcp.json + .claude/settings.json,
// git-excluded); the codex harness puts everything in the config dir and writes
// nothing into the repo at all.
//
// The shared design across both, and the reason the codex harness cost harness work
// rather than a config line (#33's stated deviation 3):
//   * credentials are the HOST's file, shared and never snapshotted (#53);
//   * the config dir isolates settings, skills and MCP from the host (#23/#29);
//   * a blocking `ask_human` reaches the daemon over MCP;
//   * a Stop hook posts to /agent_done and can BLOCK the stop, which is what
//     enforces the merge-gated ending (#54). That last one is why codex earns a
//     harness at all: `codex --version 0.145` ships Claude-compatible hooks, so the
//     ending is enforced identically instead of degrading to session-exit
//     detection as this ticket assumed it would have to.
//
// Verified live before it was written (see the ticket's resolution): codex
// reaches an HTTP MCP server from `[mcp_servers]`, its Stop hook carries the
// same payload keys and honours `{decision:"block", reason}`, and `stop_hook_active`
// flips on the second stop exactly as Claude's does.
//
// RE-MEASURED on 0.146.0, the pinned version, for #447
// (docs/live-checks/447-codex-stop-hook.md). The hook still blocks. The `reason`
// reaches the model as a user message wrapped in a `<hook_prompt>` tag, and
// `stop_hook_active` is false on the first stop and true on every stop after it.
// It blocked five times in a row with no cap, in the TUI lane and the `exec`
// lane alike — so the `exec` move between 0.145 and 0.146 did not touch this.
//
// #438 makes this hook the codex gate's whole guarantee, because a rejection
// there is only a return value and can be thrown away (#416). A Stop-hook
// refusal cannot: codex forces another turn whatever the model does. So the
// worst case is a loop, not an escape.
//
// Two shapes that re-measure owes a look, both pinned by the same check: the
// allow body must stay a BARE `{}` (see `/agent_done`), and
// `--dangerously-bypass-hook-trust` is load-bearing rather than incidental —
// without it the spawn stalls at a "Hooks need review" menu before the first
// turn, and no hook runs at all.

export const HARNESS_NAMES = ['claude', 'codex']

// WHICH ENVIRONMENT VARIABLE CARRIES A HARNESS'S CONFIG ROOT. The HARNESS rows
// below build their env from this map rather than spelling the name inline, and
// `aistack.mjs` reads it rather than naming the same two variables a second
// time — a harness whose CLI reads a different variable is then answered here,
// once, for the agent spawn and the usage sync alike.
export const CONFIG_ROOT_ENV = Object.freeze({
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
})

export function configRootEnvFor(harness = 'claude') {
  harnessDef(harness)
  return CONFIG_ROOT_ENV[harness]
}

// HOW EACH HARNESS IS TOLD ITS REASONING EFFORT (#707), for all four harnesses
// the worker image carries since #696 — not only the two the router can select
// today. The codex row states `model_reasoning_effort` in the config file the
// daemon already writes for it, and the comment on that line is the rule this
// table generalizes: a model's own default is not a constant across models, so
// stating the effort makes the model and the depth two separate visible
// decisions instead of one that moves under the other.
//
// THE ROUTE IS NEVER A SPAWN FLAG, and that is the whole reason this is a table
// rather than an addition to the harness template. A flag lives on the spawn
// line only, and a resume runs a DIFFERENT line (`codex resume --last`,
// `claude --continue`) — so an effort carried by a flag would be the depth the
// first turn ran at and nothing the resumed agent inherits. Both routes here
// are re-stated by every arm: the config file lives in the config dir the
// container mounts, and the environment is written into the env file each
// container is built with. Spawn and resume read the same answer.
//
// `env` is the environment variable the CLI reads; `config` is the key the
// harness's own config file carries. One or the other, never both.
//
// VERIFIED: the codex row, live since #39 and measured on the box. The other
// three are NOT verified against a running CLI — #696 put the four commands in
// the image and nothing has dispatched on opencode or pi yet. An environment
// variable a CLI does not read is a no-op rather than a broken spawn, which is
// why every unverified row is an `env` row: the wrong answer here costs the
// depth, not the agent. Correct a row against a live check, not against a
// reading of these names.
export const EFFORT_ROUTE = Object.freeze({
  claude: Object.freeze({ env: 'CLAUDE_CODE_EFFORT' }),
  codex: Object.freeze({ config: 'model_reasoning_effort' }),
  opencode: Object.freeze({ env: 'OPENCODE_REASONING_EFFORT' }),
  pi: Object.freeze({ env: 'PI_REASONING_EFFORT' }),
})

// Every harness that can be told an effort — the four in the image, which is a
// longer list than HARNESS_NAMES above (the harnesses the router can select).
export const EFFORT_HARNESSES = Object.freeze(Object.keys(EFFORT_ROUTE))

export function effortRouteFor(harness) {
  const route = EFFORT_ROUTE[harness]
  if (!route) {
    throw new Error(`no reasoning-effort route for harness "${harness}" — known harnesses: ${EFFORT_HARNESSES.join(', ')}`)
  }
  return route
}

// The part of the agent's environment that carries the effort, or nothing. Two
// cases write nothing and they are the same case here: a harness whose route is
// its config file, and an agent routing states no effort for.
export function effortEnv(harness, effort) {
  const route = effortRouteFor(harness)
  return route.env && effort ? { [route.env]: String(effort) } : {}
}

function harnessDef(harness) {
  const h = HARNESS[harness]
  if (!h) {
    throw new Error(`no agent harness for harness "${harness}" — known harnesses: ${HARNESS_NAMES.join(', ')}`)
  }
  return h
}

// Where the host's own credential store lives for a harness — the single file
// every agent of that harness shares (#53).
export function hostStorageDir(harness = 'claude') {
  return harnessDef(harness).hostStore()
}

// The provider whose credential a harness runs on (#648). One reader, because
// the boot refusal, the dispatch's credential write and the fan-out all have to
// agree — two answers here would be the claude row and the overseer row drifting
// apart by another road.
export function harnessProvider(harness) {
  return harnessDef(harness).provider
}

// ---- the agent's GitHub authority (#155, retired by #466) -------------------
//
// An agent used to get a scoped fine-grained PAT as `GH_TOKEN`, one key per
// resource owner. #389 cut the agents over to a token minted from the GitHub App
// and KEPT the key as the fallback, because ADR-0018 says no PAT comes out ahead
// of its replacement. The box then ran its dispatches on the minted path, so
// #466 took the key out: the credential is minted, written to a file the
// container mounts, and refreshed on the dispatch tick (agentgh.mjs).
//
// WHAT IS LEFT HERE IS THE NAME, and nothing reads a value under it. An env file
// on a box that has been deployed to since #155 still carries those keys, and
// each one is a live read-write PAT with no job. So the name survives to be
// FOUND: the boot names a leftover key and asks for its deletion and its
// revocation, the same two acts #392 asks for on the overseer's own retired key.
export const AGENT_TOKEN_KEY = 'CURIA_AGENT_GH_TOKEN'

// #155's keys, still in `daemon/.env.daemon` after this retirement. The boot
// names them, because a PAT nothing reads is reach nobody is watching.
export function retiredAgentTokenKeys(env = process.env) {
  return Object.keys(env).filter((k) => k.startsWith(`${AGENT_TOKEN_KEY}_`))
}

// The whole per-agent env: config isolated, credentials shared.
//
// `sandboxed` (#156) changes one thing and says so: a container cannot share
// the host credential store, because the host HOME is what the boundary denies.
// `cfgDir` is then the path INSIDE the container, and the model credential
// rides the env file instead (sandbox.mjs).
//
// NO GITHUB CREDENTIAL COMES OUT OF HERE. It used to: #155's PAT rode this env
// as `GH_TOKEN`, and #466 retired it. What an agent gets now is a PATH to a file
// the daemon rewrites, and dispatch.mjs sets it beside the mint that fills the
// file — one place that knows the credential, rather than two that must agree.
// The overseer's own turn takes this same env and no GitHub value at all
// (overseerturn.mjs), which is what that arm always wanted.
export function agentEnv(cfgDir, harness = 'claude', { sandboxed = false } = {}) {
  return harnessDef(harness).env(cfgDir, { sandboxed })
}

// TOML basic string. The values here are daemon-generated paths and a loopback
// URL, so this is belt rather than need — but an unescaped backslash or quote
// in a config file the daemon writes would fail at codex startup, where the
// symptom is an agent sitting at a parse error nobody reads.
function toml(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// The daemon's own address, as the agent reaches it. A bare pane reaches it on
// loopback; a container's loopback is the container, so it reaches the same
// listener through the docker host gateway instead (#156).
export const LOOPBACK = '127.0.0.1'

// The name curia's own MCP server carries in the agent's `.mcp.json`, and the
// one name the claude harness's allowlist admits (#180). One constant, because the
// two must never drift: an allowlist that does not name the server curia writes
// leaves the agent with no tools at all.
export const MCP_SERVER_NAME = 'curia'

function curiaMcpUrl(daemonPort, agent, ticket, host = LOOPBACK) {
  return `http://${host}:${daemonPort}/mcp?agent=${agent}&ticket=${ticket}`
}

// How long codex may wait on one curia tool call. Its default is 300 s, and it
// is a HARD deadline on the call, not an idle timer — so #34's MCP-stream
// keepalive, which is what lifts Claude Code's identical 300 s abort, does
// nothing here. That was found the way #34's was: a live agent held a
// `request_review` open, the human took five minutes, and the call died with
// `tool call error: timed out awaiting tools/call after 300s` — twice, because
// the agent correctly retried it (#56's standing order) into a second deadline.
//
// A day, not a literal infinity: codex wants a number, and this is the one place
// #11's "blocks for as long as the human takes" is bounded. It is ~3x the
// longest real block on record (7 h 53 m, #56), and a block that outlives it
// re-dispatches rather than resolving anything (#11/#12). The keepalive stays on
// for the claude harness and costs nothing here.
//
// #371 then measured what else this number bounds, and it is more than the human
// wait. Codex has NO transport-drop watchdog: when the daemon dies holding a
// call, the client is told nothing and waits out this deadline from the moment
// the CALL was made. Measured three ways in
// docs/research/tool-channel-mid-session-codex.md — still waiting 595 s and
// 295 s after the death at this value, and dying at 60.009 s and 60.007 s with
// the value cut to 60. The claude row above is told in ~120 s instead, which is
// why #341's retry ladder works there and cannot fire here.
//
// So one number serves two jobs that pull apart: generous to a slow human, and
// a day of silence for an agent a restart stranded. Changing it is a decision
// against #34, not a tuning.
//
// #426 took that decision and left the number ALONE. One value cannot be both
// jobs, so the second job moves off it: the daemon says goodbye. Before it
// exits, a restart, a SIGTERM and a crash each end every blocked call with a
// tool ERROR, which is the error #341's ladder needs and the thing codex never
// gets by itself. That reaches the agent in about a second rather than in a
// day, and it costs the slow human nothing. What the goodbye cannot reach is a
// SIGKILL, and this deadline is still the only bound there.
const CODEX_TOOL_TIMEOUT_S = 86_400

// The Stop hook, identical on both harnesses: POST the hook's own stdin payload to
// the daemon, which answers `{decision:"block", reason}` while a step of the
// ending is outstanding (#54).
//
// The token header rides beside the ticket's own content type (#159). Both
// values are quote-free by construction — a hex token and a daemon-owned port —
// so the single-quoted curl arguments need no escaping rule.
function stopHookCommand(daemonPort, agent, host = LOOPBACK, token) {
  return [
    `curl -s -X POST 'http://${host}:${daemonPort}/agent_done?agent=${agent}'`,
    `-H 'Content-Type: application/json'`,
    `-H '${TOKEN_HEADER}: ${token}'`,
    '-d @-',
  ].join(' ')
}

// The four connection-settings files now carry the agent's secret, so none of them is
// world-readable. On the bare path that is belt only (a sibling agent runs as
// the same host user); in a container the mount arrives owned by the same uid the
// agent runs as, so 0600 is still readable by the one agent that needs it.
function writeSecretFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 })
  fs.chmodSync(file, 0o600) // the mode applies only on create; a reused config dir already has one
}

// THE CLAUDE HARNESS'S WHOLE REACH BACK INTO THE DAEMON, in one writer.
//
// A `.mcp.json` beside a `.claude/settings.json` that says
// `enableAllProjectMcpServers` — the pair is what makes the CLI trust a project
// server with no prompt, and either file alone is a harness with no tools. Two
// callers write it: an agent worktree here, and a conversation's own project
// directory (`overseeridentity.mjs`). They differ in the directory, the server
// name and whether a Stop hook rides along; everything else — the shape of the
// server entry, the header that carries the secret, the bypass mode, the 0600
// on both files — is one rule and lives here.
//
// Returns the path of the `.mcp.json` it wrote.
export function writeClaudeConnection({ dir, serverName, url, header, token, hooks = null }) {
  fs.mkdirSync(dir, { recursive: true })
  const mcpFile = path.join(dir, '.mcp.json')
  writeSecretFile(mcpFile, JSON.stringify({
    mcpServers: {
      // #159. Claude Code sends a per-server `headers` object on every request
      // to an http MCP server (`claude mcp add --header` writes this exact
      // shape).
      [serverName]: { type: 'http', url, headers: { [header]: token } },
    },
  }, null, 2))
  const dotClaude = path.join(dir, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  writeSecretFile(path.join(dotClaude, 'settings.json'), JSON.stringify({
    enableAllProjectMcpServers: true,
    permissions: { defaultMode: 'bypassPermissions' },
    ...(hooks ? { hooks } : {}),
  }, null, 2))
  return mcpFile
}

const HARNESS = {
  claude: {
    // The CLI's global-memory file, and the ONLY per-session channel either
    // harness keeps outside the conversation (#340). Codex carries `AGENTS.md`
    // as world state and restates it every turn ("These AGENTS.md instructions
    // replace all previously provided AGENTS.md instructions"); a user message
    // is conversation, and conversation goes stale — codex tells the model that
    // the last user request is current and previous ones are stale. So curia's
    // standing orders live HERE, not in `prompt.md`.
    //
    // A new harness must name its own file. That is the whole reason this is a
    // table row rather than a ternary: a lane whose CLI has no such file cannot
    // carry standing orders that survive turn one, and this row is where that
    // has to be answered.
    memoryFile: 'CLAUDE.md',
    // Which PROVIDER's credential this harness runs on (#648). It is a row here
    // rather than a ternary at the two call sites for the reason `memoryFile`
    // is: a new harness has to answer it, and `config.mjs` refuses a configured
    // harness whose provider has no contract row. A harness added with no
    // credential story is how the #641 bug returns.
    provider: 'anthropic',
    // CLAUDE_SECURESTORAGE_CONFIG_DIR is what separates config from credentials.
    // Claude Code resolves its credential store through it and falls back to
    // CLAUDE_CONFIG_DIR only when it is unset, so pointing it at the host's
    // ~/.claude puts the agent on the host's *exact* credentials path — the
    // same file, the same refresh lineage, the same atomic-rename write. That is
    // precisely what a second host session does, which is why several host
    // sessions coexist for days while an agent holding a frozen copy died at the
    // first host-side refresh (#34). Everything else stays isolated by
    // CLAUDE_CONFIG_DIR: settings, allowlist, permission mode, CLAUDE.md, MCP
    // connectors, projects (#23/#29).
    //
    // An absolute path, not the empty string that also selects ~/.claude:
    // explicit beats HOME-dependent, and `env K=` through tmux is a needless
    // edge. Porting to macOS would want the empty form instead — a non-empty
    // value also suffixes the keychain service name, which would break sharing
    // where the keychain, not the plaintext file, is the store.
    hostStore: () => path.join(os.homedir(), '.claude'),
    // CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms): Claude Code aborts an HTTP MCP
    // call after 300 s with no response or progress notification, and ONLY a
    // progress notification bound to the call's own progressToken resets that
    // timer — the keepalive's logging branch never does (#104, the 314 s
    // death). The keepalive covers a client that offered a token; this floor
    // covers one that did not. One day, the same bound as
    // CODEX_TOOL_TIMEOUT_S below; a call whose daemon actually died is aborted
    // by the transport-drop watchdog instead, about 120 s after the death
    // (#341, three runs at 119.5 s, 118.9 s and 119.2 s in
    // docs/research/tool-channel-mid-session.md — this comment said 90 s).
    //
    // A CONTAINER cannot have that (#156): the host store lives in the host
    // HOME, which is the first thing the boundary denies. The variable is
    // dropped rather than pointed somewhere else, so Claude Code falls back to
    // CLAUDE_CONFIG_DIR — the agent's own mounted dir — and the credential
    // arrives as an environment variable instead (sandbox.mjs). That is the
    // frozen-credential shape #53 fixed for the bare path, accepted back by
    // #148 as the sandbox's one remaining host-secret exposure.
    env: (cfgDir, { sandboxed = false } = {}) => ({
      [CONFIG_ROOT_ENV.claude]: cfgDir,
      ...(sandboxed ? {} : { CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(os.homedir(), '.claude') }),
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(86_400_000),
    }),

    // Exact prototype.md §1 shape, verified live: no first-spawn dialog ever
    // appears. The projects key MUST be the absolute worktree path (matched
    // exactly).
    seed: (cfgDir, wtPath) => {
      fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true,
        installMethod: 'native',
        autoUpdates: false,
        theme: 'dark',
        numStartups: 1,
        projects: {
          [wtPath]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            hasClaudeMdExternalIncludesApproved: true,
            hasClaudeMdExternalIncludesWarningShown: true,
          },
        },
      }, null, 2))
      // The MCP namespace is bounded HERE, in the two settings keys below
      // (#180), because nothing else reaches it. `CLAUDE_CONFIG_DIR` holds the
      // #23/#29 line for config-borne servers, but the operator's account-level
      // claude.ai connectors — Notion, Gmail, Drive, Calendar — do not travel
      // through the config dir. Claude Code fetches them over the wire from the
      // account behind the credential, which #53 shares with the host on
      // purpose. So a bare-pane agent listed 38 tools where curia configured
      // six, and could read and write the operator's mail and documents. The
      // container boundary does not touch it either: the fetch is an ordinary
      // outbound HTTPS call, and #148 leaves the network open because wayfinder
      // needs `gh` and the web.
      //
      // `disableClaudeAiConnectors` is the source control. Claude Code reads it
      // from ANY settings source, and this file is the user source, so the
      // agent's own config dir is enough — the credential does not change.
      // Measured against the pinned CLI: the check is FIRST in its eligibility
      // chain, ahead of every auth branch, and the debug line names the setting
      // by name (docs/live-checks/180).
      //
      // `allowedMcpServers` is the second belt, and it bounds the whole
      // namespace rather than one source: only the server curia writes is
      // admitted, whatever route another arrives by. Its entries are OBJECTS,
      // not strings — `['curia']` fails schema validation, and an invalid
      // allowlist enforces an EMPTY one, which takes curia's own server down
      // with it. That trap was measured, not reasoned about.
      //
      // #344 made the one-server line a DECISION and not only a setting: a
      // read-only MCP history server was proposed here and refused. History
      // that ever reaches an agent arrives as tools on the server below, so
      // this list stays at one entry.
      fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({
        skipDangerousModePermissionPrompt: true,
        disableClaudeAiConnectors: true,
        allowedMcpServers: [{ serverName: MCP_SERVER_NAME }],
      }, null, 2))
    },

    // .mcp.json (curia HTTP MCP side channel) + .claude/settings.json (all-project
    // MCP on, bypass permissions, Stop hook → /agent_done) — spike #29 shapes
    // with per-agent substitution. Both land in the worktree and are hidden from
    // git by the base clone's info/exclude (see ensureBaseClone).
    connectionSettings: ({ wtPath, agent, ticket, daemonPort, daemonHost, token }) => {
      writeClaudeConnection({
        dir: wtPath,
        serverName: MCP_SERVER_NAME,
        url: curiaMcpUrl(daemonPort, agent, ticket, daemonHost),
        header: TOKEN_HEADER,
        token,
        hooks: { Stop: [{ hooks: [{ type: 'command', command: stopHookCommand(daemonPort, agent, daemonHost, token) }] }] },
      })
    },
  },

  codex: {
    // See the claude row: this is the durable channel, and #340 measured it.
    memoryFile: 'AGENTS.md',
    // See the claude row (#648). `openai` is the name the routing table and
    // `Cooling` use; `codex` is the consumer that runs on it.
    provider: 'openai',
    // Codex hides a skill whose manifest says so, and its catalog is the only
    // channel that re-arms a skill without pasting it (#399). See
    // writeSkillPointers. A new harness answers this row for itself: a CLI with
    // no catalog of its own writes no pointers and needs none.
    skillPointers: writeSkillPointers,
    // CODEX_HOME is the whole config dir: settings, skills, sessions, logs AND
    // the credential file, with no second variable to split them (Claude's
    // CLAUDE_SECURESTORAGE_CONFIG_DIR has no codex equivalent). Sharing the
    // host's credentials therefore has to happen inside the dir.
    hostStore: () => path.join(os.homedir(), '.codex'),
    env: (cfgDir) => ({ [CONFIG_ROOT_ENV.codex]: cfgDir }),

    // A SYMLINK to the host's auth.json, which is the same shared-store property
    // #53 landed for Claude and — read this carefully — reached by the opposite
    // mechanism. #53 found that a symlinked Claude credential file is REPLACED by
    // a regular file on the agent's first refresh, because Claude writes
    // temp-then-rename over an unresolved path, stranding the host on the
    // rotated-away token. Codex does not: it opens the path
    // O_WRONLY|O_CREAT|O_TRUNC, which follows the link and writes the host's own
    // file (verified by strace, and by watching a write through the link land on
    // the target while the link survived). So here the link is the fix, not the
    // trap.
    //
    // Rebuilt on every seed, and any regular file at that path is removed first:
    // a config dir reused from a run that somehow left a real credential behind
    // must not keep it, because a stale copy that still parses is the silent
    // return to the frozen-token failure.
    //
    // The cost is the same one #53 accepted: an agent can reach the host's real
    // credential file, so it has a host session's blast radius there. The one
    // difference worth stating is that codex's write is NOT atomic — a truncating
    // in-place rewrite, where Claude's is a rename — so a refresh racing a read
    // can be seen torn. The window is one small write and nothing in codex locks
    // that file (its own locks live under $CODEX_HOME/tmp, which is per-agent
    // and so shares nothing), and the failure re-dispatches (#11/#12).
    // A CONTAINER cannot have the link, and cannot have the sharing either
    // (#158). It mounts no host HOME, so a link into `~/.codex` resolves to
    // nothing inside — the silent shape #156 found with skills. The credential
    // is a FILE in `CODEX_HOME`, and `CODEX_HOME` is the config dir the
    // container already mounts, so delivery is a copy and needs no new mount.
    //
    // The copy is READ-ONLY, and that is the whole decision rather than a
    // detail. `auth.json` on this box carries a `refresh_token`, and providers
    // rotate those: an agent that refreshed its copy would invalidate the
    // token the HOST still holds — #53's stranding, arriving by the other harness.
    // So the container agent is frozen on the token it started with, which is
    // the same bound #156 accepted for the claude harness and stated.
    //
    // 0400 is a bound against accident, not against the agent: the container
    // runs as uid 1000 and owns the file, so it could chmod it back. What it
    // buys is that an ordinary in-place refresh FAILS rather than silently
    // rotating the host away.
    //
    // AND THE COPY MUST NOT START EXPIRED (#351). The 0400 bit blocks the
    // write-back, not the refresh: a refresh is a network call, and the server
    // rotates the refresh token the moment it succeeds. A copy whose access
    // token is already expired refreshes on first use, the rotated credential
    // lives only in process memory, and the next re-read presents the old
    // refresh token — which the server refuses as already used. That strands
    // the agent AND the host store, because both hold the same spent token.
    // So an expired host token refuses the dispatch here, loudly and before
    // any claim work is lost. The bound this buys is one access-token
    // lifetime: an agent that outlives a fresh token still dies on the same
    // sequence, and only the API-key shape (ADR-0007's, for the claude lane)
    // removes the lineage entirely.
    seed: (cfgDir, _wtPath, { sandboxed = false } = {}) => {
      const dest = path.join(cfgDir, 'auth.json')
      const host = path.join(os.homedir(), '.codex', 'auth.json')
      fs.rmSync(dest, { force: true })
      if (!sandboxed) {
        fs.symlinkSync(host, dest)
        return
      }
      if (!fs.existsSync(host)) {
        throw new Error(`no codex credential for the container: ${host} does not exist, and a sandboxed codex agent cannot reach the host store — type \`reauth\` to sign in from a browser (#642)`)
      }
      const raw = fs.readFileSync(host, 'utf8')
      const expiry = codexAccessTokenExpiry(raw)
      if (expiry !== null && expiry <= Date.now()) {
        throw new Error(`refusing to seed the codex credential into the container: the host access token expired ${new Date(expiry).toISOString()}. A copy that starts expired refreshes at once, the server rotates the refresh token, and the read-only copy cannot store the rotation — that strands the host store too (#351) — type \`reauth\` to sign in from a browser first (#642)`)
      }
      fs.writeFileSync(dest, raw)
      fs.chmodSync(dest, 0o400)
    },

    // Everything the codex harness needs is in the config dir, so nothing is written
    // into the watched repo at all — no .mcp.json, no settings file, nothing to
    // git-exclude.
    //
    // `[projects.<wt>] trust_level` is the codex analogue of Claude's
    // hasTrustDialogAccepted: without it the first spawn stops at a "Do you trust
    // the contents of this directory?" prompt and the agent never reaches its
    // composer (observed, before this line existed).
    connectionSettings: ({ wtPath, cfgDir, agent, ticket, daemonPort, daemonHost, reasoningEffort, token, skills }) => {
      writeSecretFile(path.join(cfgDir, 'config.toml'), [
        '# Written by the curia daemon per agent. Never hand-edited.',
        '',
        // Written whenever routing states one, because a model's OWN default is
        // not a constant across models: gpt-5.5 defaults to medium and
        // gpt-5.6-sol to low, so changing `models.<name>.id` alone would move
        // the effort underneath the harness without saying so. Stating it makes the
        // model and the depth two separate, visible decisions.
        ...(reasoningEffort ? [`${EFFORT_ROUTE.codex.config} = ${toml(reasoningEffort)}`, ''] : []),
        '[features]',
        'hooks = true',
        // The tool set is bounded HERE (#172), and this table is the whole lever:
        // every one of these is `stable` and defaults to TRUE on the pinned
        // codex, so curia carried them without ever choosing them. A live agent
        // held `mcp__codex_apps__plugin_management` — search, install and
        // uninstall apps — plus `_update_app_permissions`, and none of it was
        // named in `[mcp_servers]` or in the bounds.
        //
        // This is the codex half of the fault #180 fixed on claude, and the
        // mechanism rhymes: the `codex_apps` namespace follows the ChatGPT
        // credential rather than the config file, and ADR-0007 shares that
        // credential with the host on purpose. The container boundary (#148)
        // does not reach it either — a connector call is ordinary outbound
        // HTTPS, and the network is open because wayfinder needs `gh` and the
        // web.
        //
        // `apps` and `plugins` are the namespace itself, and #207's live read
        // confirmed both bite: the mcp-resource tools and `request_plugin_install`
        // drop out of a real agent's tool set when they are false.
        //
        // `multi_agent` was written against `resume_agent` and `close_agent`, and
        // #207 measured it as a no-op on 0.146: the family moved to
        // `collaboration.*` and off the flag, and a live agent under this very
        // table spawned a sub-agent (`Started /root/pong`,
        // docs/live-checks/207). The operator then ruled the collaboration
        // tools ALLOWED (2026-08-05): they are the codex spelling of claude's
        // own subagents, which curia has never forbidden, and the review gate
        // reads the output either way. The key stays because it is true to its
        // name and costs nothing.
        //
        // The trap is the OPPOSITE shape to #180's, and it was measured both
        // ways. A key codex does not know is ignored in silence, so a rename
        // upstream fails as a no-op rather than as a dead agent. A key with the
        // wrong TYPE is a hard config error that stops the spawn at startup.
        // So nothing here can quietly take curia's own MCP server down, and a
        // typo buys back the whole surface with nothing to say so. That is why
        // the guard is a live read of `codex features list` (docs/live-checks/172)
        // rather than a unit test on the string this writes. `multi_agent` is
        // that trap CAUGHT, one ticket later.
        'apps = false',
        'plugins = false',
        'multi_agent = false',
        // The rest of the default-on registry curia never chose (#207). All
        // seven were measured INERT for a CLI agent on the pinned codex: with
        // all of them false, a live agent's tool set is byte-identical, in the
        // TUI lane and the exec lane, bare and in the container. They gate the
        // Codex desktop app and IDE surfaces, not this one — no browser or
        // computer-use tool ever reached a CLI agent's definitions, and
        // `in_app_updates = false` does not even remove `codex update` from the
        // CLI. So these lines remove no capability today. They are a pin: each
        // is `stable` and defaults to TRUE, so the next version bump that does
        // attach one of them to the CLI meets a stated choice instead of a
        // default nobody made (operator ruling, 2026-08-05, docs/live-checks/207).
        'browser_use = false',
        'browser_use_external = false',
        'browser_use_full_cdp_access = false',
        'in_app_browser = false',
        'computer_use = false',
        'in_app_updates = false',
        'skill_mcp_dependency_install = false',
        '',
        // The skill bound (#171). #57's install list is the whole skill set an
        // agent may see, and CODEX_HOME does not enforce it: codex also reads
        // `$HOME/.agents/skills`, with no config key to turn that root off on
        // the pinned codex. So the bound is subtractive — one disable entry per
        // host skill the seed did not install, exact-name match, resolved
        // against every root at load (verified live: the model-visible prompt
        // then lists exactly the installed nine, docs/live-checks/171).
        //
        // `bundled` covers gap 2 of the same inventory: codex plants six skills
        // of its own under `<cfgDir>/skills/.system` on every start,
        // `skill-installer` — which installs more — among them. Nothing curia
        // chose, so it is pinned off like the feature table above; false also
        // deletes the planted cache dir (verified live). Same silent-rename
        // caveat as `[features]`: an unknown key is ignored without a word, so
        // the guard is the live read, not a unit test on this string.
        '[skills]',
        'bundled = { enabled = false }',
        ...codexSkillDenyList(skills?.install).flatMap((name) => [
          '',
          '[[skills.config]]',
          `name = ${toml(name)}`,
          'enabled = false',
        ]),
        '',
        `[projects.${toml(wtPath)}]`,
        'trust_level = "trusted"',
        '',
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        `url = ${toml(curiaMcpUrl(daemonPort, agent, ticket, daemonHost))}`,
        `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_S}`,
        // #159, the codex spelling of the claude harness's `headers` object. An
        // inline table, which is what `codex mcp list --json` reads back as the
        // transport's `http_headers`. `bearer_token_env_var` is the other option
        // codex offers and it is the wrong one here: it names an ENVIRONMENT
        // VARIABLE, which puts the secret back in `ps` on the bare path.
        `http_headers = { ${toml(TOKEN_HEADER)} = ${toml(token)} }`,
        '',
      ].join('\n'))
      writeSecretFile(path.join(cfgDir, 'hooks.json'), JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: stopHookCommand(daemonPort, agent, daemonHost, token) }] }] },
      }, null, 2))
    },
  },
}

// A config file the WATCHED REPO carries, which curia does not write and cannot
// vouch for. Returns the offending path, or null. One exposure per harness, same
// shape on both: a file the harness loads with no prompt, whose hooks would
// run unreviewed, with no model in the loop. An agent already runs with
// approvals bypassed in that worktree, so this is not new capability so much as
// a new path to it that needs no prompt at all. Refusing the dispatch puts a
// human on it.
//
// Codex: the spawn template passes `--dangerously-bypass-hook-trust`. That flag
// is right for the hook curia authors — the daemon writes it into a config dir
// it owns, one step earlier, and codex's alternative is an interactive "Hooks
// need review" prompt that would stall a zero-keystroke spawn forever
// (observed). Reproducing codex's trust hash instead would mean pinning an
// undocumented internal that can move and stop guarding silently, which is the
// failure #56 refused. But the flag is not scoped to curia's hook: codex also
// loads `<cwd>/.codex/hooks.json` from a trusted project, and under the flag it
// would run that unreviewed (verified — a planted project hook fired).
//
// Claude: curia overwrites `<wt>/.claude/settings.json`, so a repo's own copy
// is neutralised — but Claude Code merges `.claude/settings.local.json` ON TOP
// of it, and curia never writes that file. Hooks merge additively across the
// two, so a planted local file runs its commands beside curia's Stop hook, and
// it can also carry command-shaped settings (apiKeyHelper, env). The file is
// conventionally git-ignored, so a tracked copy in a watched repo is already a
// flag (#105).
export function untrustedProjectConfig(wtPath, harness) {
  const planted = harness === 'codex'
    ? path.join(wtPath, '.codex', 'hooks.json')
    : path.join(wtPath, '.claude', 'settings.local.json')
  return fs.existsSync(planted) ? planted : null
}

// The skill roots each harness reads out of the WATCHED REPO itself, measured
// against the pinned CLIs (#224, docs/live-checks/224). Codex reads the project
// config dir plus `.agents/skills` at the spawn cwd; claude reads
// `.claude/skills`. Neither CLI has a config key that turns a repo root off.
const REPO_SKILL_ROOTS = {
  codex: [['.codex', 'skills'], ['.agents', 'skills']],
  claude: [['.claude', 'skills']],
}

// The name a SKILL.md claims in its frontmatter. Codex keys a skill on this
// name and ignores the directory, so a plant can sit in an innocently named
// directory (measured, #224). Claude keys on the directory name instead.
function frontmatterName(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  return /^name:[ \t]*(.+?)[ \t]*$/m.exec(text.slice(0, end))?.[1] ?? null
}

// A skill the WATCHED REPO carries under a name curia installs (#224) — the
// untrustedProjectConfig family, one step milder: model-invoked prose, not an
// auto-run hook. The plant impersonates curia's own tooling, and what the model
// then sees is a CLI internal that moves between versions: codex lists the
// plant BESIDE the installed copy and FIRST, claude shadows it by directory
// name — except for the names installed with `disable-model-invocation: true`
// (`wayfinder`, `implement`), where the installed copy is hidden from the model
// and the plant surfaces alone. All measured on the pinned CLIs. Refusing the
// dispatch puts a human on it; a repo skill under a name curia does NOT install
// stays welcome, because carrying skills is what a repo may legitimately do.
//
// Both name identities are checked on both harnesses: the split is a CLI
// internal too, and a stricter read costs a refusal where a looser one costs a
// plant that loads.
export function plantedSkills(wtPath, harness, install) {
  const installed = new Set(install ?? [])
  if (!installed.size) return []
  const found = []
  for (const root of REPO_SKILL_ROOTS[harness] ?? []) {
    const dir = path.join(wtPath, ...root)
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const skillMd = path.join(dir, e.name, 'SKILL.md')
      let text
      try {
        text = fs.readFileSync(skillMd, 'utf8')
      } catch {
        continue
      }
      const names = new Set([e.name, frontmatterName(text)].filter(Boolean))
      for (const name of names) {
        if (installed.has(name)) found.push({ path: skillMd, name })
      }
    }
  }
  return found
}

// The skill set an agent gets (#57, decision 1 of #49). Before this, an agent
// had NO skills at all, so the spawn prompt was the whole of its wayfinder
// knowledge — which is why restating skill doctrine in the prompt was the
// wrong fix and installing the real skills is the right one.
//
// The default list excludes only `wizard` (#348). It writes an interactive bash script for a
// human at a terminal, and a `wayfinder:task` ticket hands its checklist over
// through `ask_human`, to a phone. The script writes `.env` and `gh secret`
// where it runs, which is the agent container rather than the operator's box,
// and it reaches that box only after the merge that ends the ticket.
//
// The review gate guards tracker writes. Skill installation does not grant a
// tracker write before approval. `to-spec` and `to-tickets` also carry
// `disable-model-invocation: true`, so installation alone does not invoke them.
// Curia types their slash commands in the dispatch prompt, as it does for
// `/wayfinder` (#517).
export const DEFAULT_SKILLS = [
  'ask-matt', 'code-review', 'codebase-design', 'diagnosing-bugs', 'domain-modeling',
  'grill-me', 'grill-with-docs', 'grilling', 'handoff', 'implement',
  'improve-codebase-architecture', 'prototype', 'research', 'resolving-merge-conflicts',
  'setup-matt-pocock-skills', 'tdd', 'teach', 'to-questionnaire', 'to-spec',
  'to-tickets', 'triage', 'wait-what', 'wayfinder', 'writing-for-agents',
]

// The FALLBACK skills root, for a config that names none. ~/.claude/skills is
// where Claude Code looks for a hand-installed set. curia's own config does not
// take this path: #268 vendored the tree into the repo, and `config/curia.yaml`
// names `../skills` relative to itself.
export function defaultSkillsRoot() {
  return path.join(os.homedir(), '.claude', 'skills')
}

// <cfgDir>/skills/<name> → <root>/<name>, symlinked rather than copied: an
// agent never writes a skill, so versions track the root with no snapshot to
// go stale. That is the exact opposite of the credential case (#53), where the
// agent DOES write and a symlink was replaced by a regular file — read-only
// is what makes the link safe here.
//
// Rebuilt from nothing on every seed: a config dir reused across dispatches
// must not keep a link to a skill that has since left the list, and a dangling
// link to a skill removed from the root must not survive either.
//
// A CONTAINER gets copies instead (#156). The link points at a path the agent
// container does not mount — the checkout since #268, a host home before it —
// so a link would dangle either way. An agent with silently no skills is #57's
// own failure, so the tree is dereferenced and copied: a few hundred kilobytes
// per agent, and it cannot go stale inside one ticket.
export function installSkills(cfgDir, skills, { copy = false } = {}) {
  const dir = path.join(cfgDir, 'skills')
  fs.rmSync(dir, { recursive: true, force: true })
  const names = skills?.install ?? []
  if (!names.length) return []
  fs.mkdirSync(dir, { recursive: true })
  for (const name of names) {
    const src = path.join(skills.root, name)
    // Config load already proved these exist, but the host can change under a
    // running daemon. Refusing here costs one dispatch; the alternative is an
    // agent that silently lacks the skill it was dispatched to use, which is
    // the failure this whole ticket exists to end.
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
      throw new Error(`skill "${name}" has no SKILL.md under ${skills.root} — refusing to spawn an agent without its configured skill set`)
    }
    if (copy) fs.cpSync(src, path.join(dir, name), { recursive: true, dereference: true })
    else fs.symlinkSync(src, path.join(dir, name), 'dir')
  }
  return names
}

// The skills codex HIDES from its own catalog, read off upstream's manifest
// rather than decided here (#399). A skill whose `agents/openai.yaml` carries
// `policy.allow_implicit_invocation: false` is absent from the
// `<skills_instructions>` developer message, so the model never learns it
// exists. Today that is `wayfinder` and `implement`.
//
// The manifest IS the question, so it is the thing read. If upstream lists a
// skill in a later release, curia writes no pointer for it and the pointer
// simply stops existing — no list here to fall out of date, and no patched byte
// to break in silence.
//
// A skill with no manifest at all is listed: `allow_implicit_invocation`
// defaults to true. That is why a pointer needs no manifest of its own.
function hiddenSkillNames(cfgDir, names) {
  return (names ?? []).filter((name) => {
    const manifest = path.join(cfgDir, 'skills', name, 'agents', 'openai.yaml')
    let doc
    try {
      doc = parseYaml(fs.readFileSync(manifest, 'utf8'))
    } catch {
      return false // no manifest, or one codex itself could not read: codex lists it
    }
    return doc?.policy?.allow_implicit_invocation === false
  })
}

// The one line a `SKILL.md` contributes to the codex catalog. Read from the
// installed file, never held as a copy here, so a skill-tree bump carries into
// the pointer at the next seed with nothing to synchronise.
//
// PARSED as YAML rather than matched with a regex, and the reason is a real bug
// this caught: `implement` writes its description as a QUOTED scalar, so the
// obvious `description:[ \t]*(.+)` capture returns the quotes too. Appending a
// sentence to that produced `description: "..." Read ...`, which is invalid
// YAML — and codex answers invalid frontmatter by dropping the skill from its
// catalog IN SILENCE. The pointer existed on disk and reached no model.
function skillDescription(cfgDir, name) {
  let text
  try {
    text = fs.readFileSync(path.join(cfgDir, 'skills', name, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  let front
  try {
    front = parseYaml(text.slice(3, end))
  } catch {
    return null
  }
  const description = front?.description
  return typeof description === 'string' && description.trim() ? description.trim() : null
}

// A pointer per hidden skill, so the codex catalog names it again (#399).
//
// #360 closed every cheap way to re-arm a skill on codex: a second `$wayfinder`
// adds an 11,867-character copy and keeps the first, and neither a tool result
// nor `AGENTS.md` resolves a mention at all. What survives is the catalog — a
// developer message, world state, restated every turn and never stale. The
// operator rejected the obvious way in (flip `allow_implicit_invocation` in the
// vendored manifest) on 2026-08-16: a patched vendored byte is brittle, and a
// skill-tree update breaks it without a word.
//
// So curia writes a file it OWNS instead, beside the `standing.md` it already
// writes here, and patches nothing. Measured on the pinned codex
// (docs/live-checks/399): a listed skill costs about 270 characters per turn and
// NEVER pastes its body. The 11,867 characters arrive only from a `$name` typed
// by a user, which is why the codex spawn prompt no longer types one.
//
// Three properties make this stable rather than clever:
//
//   - The description is READ from the installed skill, so the trigger fires on
//     the same tasks the real skill claims, and an upstream reword carries
//     through at the next seed.
//   - Hidden-ness is read from upstream's manifest, so upstream stays the
//     authority on which skills need a pointer at all.
//   - The name is `curia-<name>` and not `<name>`. Codex keys a skill on the
//     name in its frontmatter, so a pointer claiming `wayfinder` would put two
//     skills under one name — the ambiguity #224 measured, created on purpose.
//     The prefix also says whose file it is to anyone reading the config dir.
//
// It is GENERATED per agent rather than committed to the tree, for the same
// reason `standing.md` is: it names an absolute path that only exists once the
// config dir does. And it is written from `seedConfigDir`, AFTER
// `installSkills` — that call wipes `<cfgDir>/skills` on every re-arm, and a
// pointer written anywhere else would vanish on the respawn a usage limit
// forces. That is #340's `standing.md` trap, one directory over.
export function writeSkillPointers(cfgDir, names) {
  const written = []
  for (const name of hiddenSkillNames(cfgDir, names)) {
    const description = skillDescription(cfgDir, name)
    if (!description) continue // a skill with no description contributes no catalog line to match on
    const target = path.join(cfgDir, 'skills', name, 'SKILL.md')
    const pointer = path.join(cfgDir, 'skills', `curia-${name}`)
    fs.mkdirSync(pointer, { recursive: true })
    // Both values are emitted as JSON strings, which are valid YAML
    // double-quoted scalars. The description is upstream's prose and carries
    // whatever upstream put in it — quotes, colons, em-dashes — and a
    // hand-spliced line is how the `implement` pointer broke in silence.
    fs.writeFileSync(path.join(pointer, 'SKILL.md'), [
      '---',
      `name: ${JSON.stringify(`curia-${name}`)}`,
      `description: ${JSON.stringify(`${description} Read ${target} in full before you act on this.`)}`,
      '---',
      '',
      `This is the \`${name}\` skill. Read \`${target}\` completely, then follow it.`,
      '',
      'Curia installed that file and it is the whole skill. This pointer exists because codex does',
      'not list `' + name + '` in its own skill catalog, and it restates none of the skill itself.',
      '',
      // The read-once rule, and it is the whole reason this file is worth
      // owning (#399). Codex tells the model to read a skill completely every
      // time it uses one, and not to carry a skill across turns. A model that
      // obeys both re-reads on every turn: measured at 12,299 characters per
      // turn for wayfinder, which STACKS, so it is worse than the 11,867-char
      // mention this replaced. Curia cannot edit codex's rule and it can write
      // its own, in the one file upstream does not own.
      `Read \`${target}\` ONCE in a session. If you have already read it, you are still running it,`,
      'and reading it again only repeats what you have. Say that you are using this skill, then act.',
      '',
      'The curia standing orders win wherever the two disagree.',
      '',
    ].join('\n'))
    written.push(`curia-${name}`)
  }
  return written
}

// The second skill root the codex harness reads, and the reason #171 exists.
// CODEX_HOME does not bound skills: the pinned codex (0.146) reads
// `$HOME/.agents/skills` unconditionally, beside `$CODEX_HOME/skills`
// (source: core-skills root loader; measured with `codex debug prompt-input`
// under a fresh CODEX_HOME — all 25 host skills appeared, the four #57
// excludes among them, docs/live-checks/171). The claude harness has no such
// root: the same isolated-config-dir check showed only the installed skill
// plus Claude Code's own built-ins.
function codexHostSkillsRoot() {
  return path.join(os.homedir(), '.agents', 'skills')
}

// The names the host root would leak past the install list. Codex 0.146 has no
// off switch for the root itself, so the bound is a per-name deny list in
// config.toml, computed when the agent is armed. Canonicalisation makes the
// name selector safe here: the installed nine are symlinks into the same host
// tree, and a denied name is exactly a name the seed did not install.
//
// Computed at arm time, so a skill the operator adds to the host root DURING a
// run leaks until the next arm. That race is accepted: the alternative is a
// watcher on the operator's own skill tree.
function codexSkillDenyList(install) {
  const installed = new Set(install ?? [])
  let entries = []
  try {
    entries = fs.readdirSync(codexHostSkillsRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !installed.has(name))
    .sort()
}

// ---- the durable instruction channel (#340) ---------------------------------
//
// Curia's standing orders used to ride `prompt.md` alone, which is ONE user
// message. #340 measured what that costs on the codex lane, from the CLI's own
// rollout: codex keeps `AGENTS.md`, the environment and the skill catalog as
// world state and restates them, while a user message is conversation. Its
// instructions then tell the model to treat the last user request as current
// and every earlier one as stale, and to drop a skill after the turn that named
// it. A wayfinder ticket is many turns, so by turn twenty the orders were a
// stale user message.
//
// So the orders move into the global-memory file, which both CLIs load as
// instructions rather than as a turn. `prompt.md` keeps what it always was in
// name: the PARAMETERS of this dispatch (ADR-0006).
//
// Two files, one author. `standing.md` is curia's own copy, and the memory file
// is composed from the voice rules plus it. That split exists for one reason:
// `seedConfigDir` runs again on every re-arm, including the same-harness
// respawn a usage limit forces, and `#rewritePrompt` deliberately does NOT
// rewrite the prompt when the harness did not move. A memory file copied from
// `voice.md` alone would silently drop the orders on that path, which is the
// exact failure this ticket exists to end.
export const STANDING_FILE = 'standing.md'

export function memoryFileFor(harness) {
  return harnessDef(harness).memoryFile
}

// voice.md + standing.md -> the CLI's global-memory file. Idempotent, and safe
// in either order: the first arm has no `standing.md` yet, and writePrompt
// composes again the moment it writes one.
export function composeMemoryFile(cfgDir, harness) {
  const standing = path.join(cfgDir, STANDING_FILE)
  const parts = [fs.readFileSync(VOICE_FILE, 'utf8')]
  if (fs.existsSync(standing)) parts.push(fs.readFileSync(standing, 'utf8'))
  fs.writeFileSync(path.join(cfgDir, memoryFileFor(harness)), parts.join('\n'))
}

// Pre-seed the per-agent config dir so no first-spawn dialog ever appears.
// Harness-specific settings come from the HARNESS table; the two things every
// harness gets are the skill set and a swept credential file.
//
// `skills` is the validated config section ({ root, install }); omitting it
// installs nothing, which is what every test double and every caller with no
// skills configured gets.
//
// `wtPath` is the worktree AS THE AGENT SEES IT (#156): the claude seed writes
// it as a `projects` key, which Claude Code matches against its own cwd — and a
// container's cwd is the mount point, not the host path. Everything this
// function WRITES goes to `cfgDir`, which is always the host path.
export function seedConfigDir(cfgDir, wtPath, skills = null, harness = 'claude', { sandboxed = false } = {}) {
  const h = harnessDef(harness)
  fs.mkdirSync(cfgDir, { recursive: true })
  // No credential is COPIED here — every harness shares the host's own store
  // instead (#53). Sweep first: a cfg dir reused across dispatches, or from
  // before #53, could hold a real snapshot, and a stale copy that still parses
  // is worse than none because it is a *silent* return to the frozen-token
  // failure. The codex seed then puts its symlink back.
  removeCredentials(cfgDir)
  // The seed needs the boundary too (#158): the codex harness shares the host's
  // credential file through a symlink on the bare path and cannot share it at
  // all across a mount, so it copies instead.
  h.seed(cfgDir, wtPath, { sandboxed })
  // The one deliberate narrowing of the no-host-config stance below (#133):
  // the operator's communication rules are mandatory for every agent, so a
  // curia-owned copy lands as the CLI's global-memory file. `CLAUDE.md` for
  // the claude harness, `AGENTS.md` for codex — each CLI's own name for it.
  //
  // Composed rather than copied since #340: the same file also carries the
  // standing orders, and a re-arm must not drop them. See composeMemoryFile.
  composeMemoryFile(cfgDir, harness)
  // One read-only directory, and nothing else from the host: no allowlist, no
  // MCP connectors, no saved permission mode (#23/#29). Both CLIs read
  // `<config dir>/skills/<name>/SKILL.md`, so #57's install is harness-blind —
  // a curia skill loaded and ran under codex unchanged.
  const installed = installSkills(cfgDir, skills, { copy: sandboxed })
  // AFTER the install, because that call wipes the directory these are written
  // into (#399). Harness-specific, so it hangs off the table rather than off a
  // name test here.
  h.skillPointers?.(cfgDir, installed)
}

// The curia side channel: the MCP server the agent's tools come from, and the
// Stop hook that enforces the ending (#54). Where it lands is the harness's
// business — see the HARNESS table.
//
// Three paths since #156, and they are not interchangeable. `hostWtPath` is
// where the claude harness's two files are WRITTEN. `wtPath` is the worktree as
// the agent sees it, which is what the codex harness's `[projects.<path>]` key
// must match. `daemonHost` is how the agent reaches back: loopback from a bare
// pane, the docker host gateway from a container.
export function writeConnectionSettings({
  wtPath, cfgDir, agent, ticket, daemonPort, harness = 'claude', reasoningEffort = null,
  hostWtPath = wtPath, daemonHost = LOOPBACK, token, skills = null,
}) {
  // The connection settings are the ONLY way an agent learns its token (#159), so a caller
  // that forgot one would write connection settings whose every call the daemon then
  // refuses. Asserted here rather than defaulted: there is no safe default.
  if (!/^[0-9a-f]{64}$/.test(String(token ?? ''))) {
    throw new Error(`refusing to write the connection settings for ${agent} without a minted agent token — every call it makes would be refused`)
  }
  harnessDef(harness).connectionSettings({
    wtPath: harness === 'claude' ? hostWtPath : wtPath,
    cfgDir, agent, ticket, daemonPort, daemonHost, reasoningEffort, token, skills,
  })
}

// The burn-down doctrine both charting dispatches carry (#297, ADR-0008).
//
// Version 1.2 of the wayfinder skill ends charting by firing a `/research`
// subagent per research ticket it just created. The operator took that shape
// whole, so a charting session now produces FILES as well as issues — and
// several of the skill's details do not survive the move into one worktree,
// which is what this block says. It rides the prompt rather than the skill file:
// `skills/` is upstream's bytes, pinned in UPSTREAM.md, and an edit there would
// hide curia's deviation in a tree whose whole point is that a bump shows up as
// a diff.
const researchParams = ({ repo, branch }) => [
  '- **The research tickets you create, you burn down in THIS session.** One `/research` subagent per',
  '  `wayfinder:research` ticket you just created, in parallel. This is the skill\'s "Fire the research',
  '  subagents" step, with the changes below. A research ticket you did NOT create is not yours: leave it',
  '  alone.',
  `- **There is no \`research/<name>\` branch.** Every subagent works in this worktree, on \`${branch}\`. A`,
  '  pull request on that branch already keeps unreviewed findings off the default branch, which is the',
  '  whole job the skill bought those branches for.',
  '- **A subagent writes files and NEVER runs git.** No commit, no branch, no push, no `gh`. You commit,',
  '  once, yourself. N agents in one worktree race on one index.',
  '- **One subagent writes one file**: `docs/research/<name>.md`, its own. YOU write every row of',
  '  `docs/research/README.md`, after the findings land. One index edited by N writers is N conflicts.',
  `- **Claim each research ticket before its subagent starts**: \`gh issue edit <n> --repo ${repo}`,
  '  --add-assignee @me`. Release it with `--remove-assignee @me` if that subagent fails. Without the',
  '  claim a concurrent `start` dispatches the same ticket to a second agent.',
  '- **Read the findings TOGETHER before you open the pull request.** Each subagent read its own ticket',
  '  alone and saw no other, so two of them can disagree. State any contradiction you found in the',
  '  `request_review` summary, and let the operator decide what happens to it.',
  '- **A research ticket you did not burn down stays on the frontier** — one charted in an earlier',
  '  session, one whose subagent failed. Leave it open and unclaimed, and say so in your summary.',
]

// ---- the inherited exchange (#374) -------------------------------------------

// What bounds the push. Per FIELD first, so one runaway question cannot eat the
// block, then per BLOCK, so a long ticket cannot eat the prompt. 2000 + 2000 is
// a whole numbered round with its recommendations, and 16000 is about four
// thousand tokens — the price of never asking the operator the same thing twice.
export const EXCHANGE_FIELD_CAP = 2000
export const EXCHANGE_BLOCK_CAP = 16000

// Cut to `cap` characters on a whole line where one is near, so a truncated
// question ends mid-sentence rather than mid-word.
function capField(text, cap = EXCHANGE_FIELD_CAP) {
  const s = String(text ?? '')
  if (s.length <= cap) return { text: s, cut: false, total: s.length }
  const head = s.slice(0, cap)
  const nl = head.lastIndexOf('\n')
  return { text: nl > cap * 0.6 ? head.slice(0, nl) : head, cut: true, total: s.length }
}

// Every line of a verbatim block, quoted. The operator's own words can carry
// headings, rules and numbered lists of their own, and unquoted they would read
// as instructions of this prompt rather than as a record of an older one.
function quoteLines(text) {
  return String(text).split('\n').map((l) => (l ? `> ${l}` : '>'))
}

// The block itself: the questions a human has already answered on this ticket,
// oldest first, written into the parameters of the next dispatch.
//
// The operator settled all five of the ticket's questions plus two the code
// forced (2026-08-16, esc round on #374):
//
//   1. It reaches EVERY dispatch this ticket has had, not just the dead agent.
//      The reduction keys escalations by session, and a builder session is
//      `curia-<n>` for the ticket's whole life, so the history is free.
//   2. It carries QUESTION AND ANSWER, both verbatim. An answer alone is
//      unreadable: "yes, option 2" says nothing without what was asked.
//   3. A cancelled, lapsed or superseded record does NOT appear. It holds no
//      answer, so it is no parameter — the fresh agent asks it again.
//   4. The caps above bound it. NEWEST records are kept when something has to
//      go, and the head line says how many were dropped.
//   5. The agent is TOLD these are recorded. A recorded answer read as a fresh
//      one is worse than no answer at all: the agent would take a stale ruling
//      as this session's, and nobody would see it happen.
//   6. Every kind rides along, the review gate included (see `reduction.mjs`).
//   7. It runs on EVERY dispatch, not only `resume`. A first dispatch has no
//      records and gets no block, so one rule covers both.
//
// Returns [] when nothing is recorded, which is the first dispatch of every
// ticket — then the prompt says nothing about an exchange that never happened.
export function exchangeBlock(exchange = []) {
  if (!exchange?.length) return []

  // Newest first while the budget is spent, so the answers nearest to the dead
  // agent's last turn are the ones that survive a long history. Rendered oldest
  // first, because a conversation reads forwards.
  const kept = []
  let spent = 0
  for (const e of [...exchange].reverse()) {
    const prompt = capField(e.prompt)
    const answer = capField(e.answer)
    const cost = prompt.text.length + answer.text.length
    if (spent + cost > EXCHANGE_BLOCK_CAP) break
    spent += cost
    kept.unshift({ ...e, prompt, answer })
  }
  const dropped = exchange.length - kept.length

  const lines = [
    '',
    '### What the operator has already answered on this ticket',
    '',
    `These ${kept.length === 1 ? 'is one question' : `are ${kept.length} questions`} an agent on this ticket asked, and the answer a human gave. They are`,
    'RECORDED words, not a fresh reply: the asking is over and the operator has moved on. curia kept them',
    'so the wait is paid once.',
    '',
    '- **Do not ask any of them again.** That is the whole point of this block.',
    '- **A recorded answer is a ruling, not a fact you verified.** If one disagrees with what you find in',
    '  the code, say so with `ask_human` rather than choosing between them yourself.',
    '- **An answer covers the question it was given.** It does not settle a near neighbour, and reading it',
    '  as if it did is how a session answers for the human.',
    ...(dropped
      ? [
        '',
        `**${dropped} older ${dropped === 1 ? 'answer is' : 'answers are'} not shown here.** The block is capped at ${EXCHANGE_BLOCK_CAP} characters, and the`,
        'newest survive. Nothing else is missing.',
      ]
      : []),
  ]

  kept.forEach((e, i) => {
    lines.push(
      '',
      `**${i + 1}. curia asked** (\`${e.id}\`, ${e.kind}):`,
      '',
      ...quoteLines(e.prompt.text),
      ...(e.prompt.cut ? ['', `*(cut here: the question ran to ${e.prompt.total} characters)*`] : []),
      '',
      '**The operator answered:**',
      '',
      ...quoteLines(e.answer.text),
      ...(e.answer.cut ? ['', `*(cut here: the answer ran to ${e.answer.total} characters)*`] : []),
      // The ✅ button's one word (#285). Read cold it looks like a non-answer,
      // and an agent that read it that way would ask the round again — which
      // is the failure this whole block exists to close.
      ...(e.answer.text.trim() === ALL_AS_RECOMMENDED
        ? ['', `*(\`${ALL_AS_RECOMMENDED}\` is the one-tap button: the operator took the recommendation on every question above.)*`]
        : []),
      // #34 sends an answer's images to the agent that asked, as tool-result
      // content. A file cannot carry them, and a path into the daemon's own
      // disk would be a dead link, so the count is what this says.
      ...(e.attachments
        ? ['', `*(the answer carried ${e.attachments} ${e.attachments === 1 ? 'image' : 'images'}, which this file cannot repeat)*`]
        : []),
    )
  })

  return lines
}

// #609: Codex 0.146 owns MCP deferral, and both feature switches that once
// controlled it are removed. #579 measured the remaining prose lever: a
// complex Curia call made one to three ALL_TOOLS lookups. Each returned lookup
// cost another model request. Load the Curia catalog once so later calls reuse
// conversation state. Claude receives its schemas directly and needs no order.
const DEFERRED_CURIA_ORDER = [
  '- **Load deferred Curia tools once.** If `ALL_TOOLS` holds Curia schemas, return every',
  '  `mcp__curia__*` definition from one `exec` call before your first Curia call. Keep the output',
  '  in context, and use the same definitions for every later Curia call.',
]

function deferredCuriaOrder(harness) {
  return harness === 'codex' ? [...DEFERRED_CURIA_ORDER, ''] : []
}

// Prompt file lives in the config dir, not the worktree.
//
// It supplies PARAMETERS, NOT PROCEDURE (#49 decision 2). Since #57 every agent
// carries the real skill set in its config dir, so the resolve protocol, the
// `gh` command lines, the `## Decisions so far` string and the pointer line's
// shape all left this function: the agent reads them from the skill it is
// running, and resolve.mjs's DECISIONS_HEADING is curia's only remaining copy of
// the skill's vocabulary. The duplication was deleted rather than synchronised.
//
// What stays here is only what curia knows or owns: which map and ticket, that
// the map is loaded and the ticket claimed, the ticket type, that the tracker is
// GitHub (otherwise the skill follows its own instruction to fall back to a
// local-markdown tracker), the tool block, the bounds no skill states, and the
// ordered ending — rendered from lifecycle.mjs's ENDING, the same structure the
// Stop hook blocks with.
//
// THE FIRST LINE IS LOAD-BEARING (#57), AND IT IS SPELLED PER HARNESS (#173).
//
// On the claude harness the line is `/wayfinder`. `wayfinder` carries
// `disable-model-invocation: true`, so a model cannot reach it through the Skill
// tool at all — told to invoke it in prose the call comes back "cannot be used
// with Skill tool". A prompt whose first line is `/wayfinder` loads the full
// skill text. That is the only working form, verified both directions.
//
// On the codex harness that same line is plain text. Nothing expands it, and
// the one codex agent on record reached the skill only by reading the file on
// its own initiative (gap 4, docs/research/codex-lane-gaps.md). So this harness
// gets its own spelling: `$wayfinder`. Codex states the rule itself, and it
// reaches every codex model by one of two routes — inside `base_instructions`
// for the gpt-5.6 family, or as a `### How to use skills` block appended to the
// skills message for the older ones (measured, docs/live-checks/173):
//
//     "If the user names an available skill (with `$SkillName` or plain text)
//      ... you must use that skill for that turn"
//     "the main agent must read its `SKILL.md` completely before taking task
//      actions"
//
// Two facts make that reachable here. Codex lists every installed skill with
// its path, and it ignores `disable-model-invocation` — so `wayfinder` is on
// the list this rule resolves against, which it is not on the claude lane.
//
// The sigil survives the spawn template: `"$(cat {prompt_file})"` substitutes
// the file's text, and a substitution's output is never rescanned, so
// `$wayfinder` reaches the model as those ten characters (verified by rendering
// the daemon's own spawn line through `codex debug prompt-input`).
//
// Operator ruling (2026-08-05, #173): the codex-native invocation, not the
// skill text inlined in the prompt. The known cost is codex's own next
// sentence — "Do not carry skills across turns unless re-mentioned" — and a
// ticket is many turns. The first codex map dispatch is what tests it.
//
// `wtPath` here is the worktree AS THE AGENT SEES IT (#156). The prompt names
// it twice — the parameter block and the write bound — and both are read by a
// model that will `cd` there, so a container agent must be told its mount
// point rather than the host path behind it. The file itself is written to
// `cfgDir`, which is always the host path.
//
// `charting` (#160) is the map dispatch: the issue in hand IS the map, and the
// agent's job is to change it rather than to resolve a ticket under it. Three
// things move — the wayfinder invocation carries no ticket, the params say
// what this dispatch is and what the operator asked for, and the ending is the
// charting one (lifecycle.mjs). Everything else — bounds, tools, the tracker
// line — is the same agent.
//
// `instruction` is the operator's own sentence, delivered HERE rather than on
// the agent-note queue. #149 called it "the agent's first note"; a note is
// drained by the next curia tool call, and a charting agent can read the whole
// map and start editing before it makes one. The prompt is the only channel
// that is guaranteed to arrive BEFORE the first turn, which is what "first"
// has to mean for an instruction that decides what the whole session does.
// The text is never shell-substituted — the spawn template reads this file with
// `$(cat …)` — so it needs no quoting rules of its own.
export function writePrompt(cfgDir, issue, {
  repo, wtPath, mapNumber = null, type = null, charting = false, newMap = false,
  instruction = null, ports = null, harness = 'claude', exchange = [], handoff = false,
  prototypeVariations,
}) {
  if (type === 'wayfinder:prototype' && (!Number.isInteger(prototypeVariations) || prototypeVariations <= 0)) {
    throw new Error('prototypeVariations must be a positive integer for a prototype dispatch')
  }
  const promptFile = path.join(cfgDir, 'prompt.md')
  // An unknown harness would take the claude spelling of the invocation in
  // silence, which is the failure #173 exists to end. harnessDef throws on a
  // name no harness owns.
  harnessDef(harness)
  const n = issue.number
  const branch = branchFor(n)
  const ticketUrl = `https://github.com/${repo}/issues/${n}`
  const mapUrl = mapNumber ? `https://github.com/${repo}/issues/${mapNumber}` : null

  // A mapless ticket gets no wayfinder line at all, on either harness: the
  // skill works THROUGH a map, and invoking it with nothing to work through
  // would invent one. The flat ready-for-agent lane (#10) is exactly this case.
  //
  // A map dispatch names the map and NO ticket. That is the skill's "work
  // through the map" invocation, whose step 2 would pick a frontier ticket — so
  // the params below cancel that step in the same breath, under the standing
  // rule that curia's bounds beat the skill where they disagree. The skill is
  // still what has to load: fog of war, out of scope, ticket types, the map
  // body's shape and refer-by-name are all doctrine a charting agent needs and
  // curia does not restate.
  //
  // ONE harness types a sigil now, and it is claude (#399). `/wayfinder` is a
  // slash command: Claude Code expands the whole `SKILL.md` into the first user
  // message, the session has no fade to cure, and this line is still what loads
  // the skill at all.
  //
  // The codex lane types NOTHING. It used to type `$wayfinder`, which injected
  // the whole 11,867-character `SKILL.md` as a user message on turn one — and a
  // user message is conversation, which codex tells the model to treat as stale
  // after the turn that carried it (#340). #360 then closed every way to re-arm
  // it: a second mention adds a second copy and keeps the first, and nothing
  // curia owns except a pane send resolves a mention at all.
  //
  // So the skill reaches a codex agent the way every other skill does — through
  // the catalog, which is a developer message and world state. Curia puts it
  // back on that catalog with a pointer it owns (writeSkillPointers), and the
  // model reads the file when a task matches. Measured: the catalog entry costs
  // about 270 characters per turn and pastes no body, where the mention cost
  // 11,867 once and re-armed nothing (docs/live-checks/399).
  //
  // Dropping the line rather than keeping both is the operator's call
  // (2026-08-16): use all skills normally. Keeping it would pay the 11,867
  // characters for a turn-one load the catalog already reaches, and pay it in
  // the one channel that goes stale.
  //
  // A NEW-map dispatch (#241) names no map, because there is none: the bare
  // sigil is the skill's OTHER invocation, "chart the map", which starts from a
  // loose idea. The operator's sentence IS that idea, and it rides the params
  // below rather than the invocation line — the line is one line, and this one
  // is a paragraph the operator wrote.
  const sigil = harness === 'codex' ? null : '/wayfinder'
  const invocation = !sigil || !(newMap || mapNumber)
    ? []
    : newMap
      ? [sigil, '']
      : [`${sigil} ${mapUrl}${charting ? '' : ` ticket #${n}`}`, '']

  // The params of a NEW-map dispatch (#241). The difference from a map dispatch
  // is one fact with consequences everywhere: the map does not exist. So this
  // session runs the skill's CHART mode whole — name the destination, grill
  // breadth-first, then create the map and the tickets it can already state —
  // and it owes curia the number the moment it has one.
  const newMapParams = [
    '- **This is a NEW-MAP DISPATCH.** No map exists yet. Run the wayfinder skill\'s "Chart the map" mode from the',
    '  top: name the destination with the operator, map the frontier breadth-first, then create the',
    `  \`wayfinder:map\` issue in ${repo} and the tickets you can already state. Its "work through the map"`,
    '  mode does not apply — there is nothing to work through until you have built it.',
    '- **The destination and the scope are the operator\'s to settle, not yours.** This is a HITL session:',
    '  many `ask_human` calls, one round at a time, until the destination is sharp enough to write down.',
    '  Never answer for them, and never chart around a question you could have asked.',
    '- **The moment the map issue exists, call `map_created` with its number.** Not at the end — then.',
    '  Until you do, curia does not know which map is yours: your thread has no name, another charting',
    '  agent could be sent to the same map, and your summary at the end has nowhere to go.',
    '- **If the grilling shows no map is needed** — the whole way is already clear, and one session could',
    '  do it — say so and stop. The skill says this too. Report `blocked` with that finding, and create no',
    '  map. An unnecessary map is worse than none.',
    '- **What the operator asked for**, in their own words:',
    '',
    `  > ${instruction ?? '(nothing)'}`,
    '',
    '  This is the loose idea, not a specification. It is where the grilling starts.',
    ...researchParams({ repo, branch }),
  ]

  const chartingParams = [
    `- **This is a MAP DISPATCH.** ${repo}#${n} is the map itself, not a ticket under it. Your job is to`,
    '  CHANGE THE MAP: its body sections, and its child tickets. Do not choose a frontier ticket, and do',
    '  not resolve one. The wayfinder skill\'s step "choose the ticket" does not apply to this session.',
    `- The map is ${repo}#${n} — ${ticketUrl}. curia has loaded it for you. It has NOT assigned the map`,
    '  to you, and no dispatch ever does (#221): a claim means "off the frontier", and a map is never on',
    '  one. What keeps a second charting agent off this body is the session name — curia refuses a second',
    `  \`map ${n}\` while yours runs. So leave the map's assignee exactly as you found it.`,
    ...(instruction
      ? [
        '- **What the operator asked for**, in their own words:',
        '',
        `  > ${instruction}`,
        '',
        '  This is the whole brief. Do that, and no more than that. If it is unclear, or if doing it well',
        '  needs a decision that is theirs, use `ask_human` — one round at a time.',
      ]
      : [
        '- **No instruction rode this dispatch.** Do not guess what should change. Your FIRST act is one',
        '  `ask_human` call: what should change on this map? Then work from the answer.',
      ]),
    ...researchParams({ repo, branch }),
  ]

  const params = newMap ? newMapParams : charting ? chartingParams : [
    ...(mapNumber
      ? [`- The map is ${repo}#${mapNumber} — ${mapUrl}. curia has loaded it for you.`]
      : ['- This ticket belongs to no map, so there is no map to work through and no map line to append.']),
    `- The ticket is ${repo}#${n} — ${ticketUrl}. curia has already CLAIMED it in your name: you start at`,
    '  resolving it, not at choosing it.',
    ...(type
      // The skill is NAMED here rather than pointed at (#399). The codex lane
      // types no sigil now, so "the skill" would name nothing on that harness —
      // and naming it in plain text is also how codex triggers a listed skill.
      ? [`- Ticket type: \`${type}\`. The wayfinder skill's Ticket Types section says what that means for how you work it.`]
      : ['- This ticket carries no `wayfinder:` type label.']),
  ]

  // #157: a container reaches the box on three published ports and on nothing
  // else, so the numbers are a PARAMETER of this session — the agent cannot
  // discover them, and a dev server on any other port is invisible to the human
  // it was started for. `0.0.0.0` is said here rather than left to the CLI's
  // defaults: a server on `localhost` inside the container is unreachable from
  // the host, and it fails as a connection reset at the preview link rather than
  // as anything the agent can see (measured, #157).
  const portLines = ports?.length && !charting ? [
    `- You run inside a container. Its three preview ports are **${ports.join(', ')}**, the same numbers`,
    `  inside and out. A dev server must bind \`0.0.0.0\` on one of them — \`--host 0.0.0.0 --port ${ports[0]}\`,`,
    '  or whatever your framework calls that. A server on `localhost`, or on any other port, is reachable',
    '  by nothing outside this container, and `publish_preview` takes no other port.',
  ] : []

  const handoffLines = handoff ? [
    '- **You are picking up mid-ticket from another model\'s work.** The previous agent hit a provider fault,',
    '  so curia started a cold session on this warm private clone. You inherit the private clone\'s files and Git history.',
    '  You don\'t inherit its reasoning or conversation. Read the current files and commits before continuing.',
  ] : []

  // #374: a prior answer IS a parameter of this dispatch, so it lands here and
  // nowhere else. It goes LAST, after the fixed lines: those are a handful of
  // facts an operator reads at a glance, and a long exchange above them would
  // bury the ticket number under a conversation.
  const allParams = [
    `- The tracker is **GitHub**, repo \`${repo}\`, reached with the \`gh\` CLI. Do not fall back to a`,
    '  local-markdown tracker: this repo carries `docs/agents/issue-tracker.md`.',
    ...params,
    `- Your worktree is ${wtPath}, on branch \`${branch}\`.`,
    ...handoffLines,
    ...portLines,
    ...exchangeBlock(exchange),
  ]

  const bounds = [
    '- **Read anything.** Zoom into any issue, map, sibling or closed ticket you need. Nothing here limits',
    '  reading.',
    // #297: the charting worktree is writable now, and narrowed to one
    // directory. Its research subagents write findings there, and a pull
    // request on this branch is what holds them off the default branch until a
    // human approves. Everything else on disk stays out of bounds, and curia
    // refuses the push rather than trusting the sentence.
    ...(newMap
      ? [
        `- **Write only:** the ONE \`wayfinder:map\` issue you create in ${repo}, and its child tickets;`,
        `  the research findings under \`${wtPath}/docs/research/\`; and the one merge a human has just`,
        '  approved. Nothing else on the tracker — no existing issue is yours to edit, whatever you find',
        '  while reading.',
        '- **No other file on disk.** `docs/research/` is the only directory a charting session writes.',
        '  curia refuses a pull request that touches any other file, so a change you think the code needs',
        '  is an `ask_human` call, never a commit.',
        "- Do not rewrite anyone else's text.",
      ]
      : charting
      ? [
        `- **Write only:** the map ${repo}#${n} and its child tickets; the research findings under`,
        `  \`${wtPath}/docs/research/\`; and the one merge a human has just approved. Nothing else on the`,
        '  tracker.',
        '- **No other file on disk.** `docs/research/` is the only directory a charting session writes.',
        '  curia refuses a pull request that touches any other file, so a change you think the code needs',
        '  is an `ask_human` call, never a commit.',
        "- Do not rewrite anyone else's text. A section you did not write is edited, not replaced.",
      ]
      : [
        `- **Write only:** files inside ${wtPath}; this ticket;${mapNumber ? ` the map ${repo}#${mapNumber} and its children;` : ''}`,
        '  and the one merge a human has just approved. Nothing else on the tracker, and nothing outside the',
        '  worktree on disk.',
        "- Leave the assignee alone, and do not rewrite anyone else's text. That claim is curia's record of who",
        '  did this work.',
      ]),
    // #131 (operator ruling, 2026-08-02): the browser bound is about JUDGMENT,
    // not tooling. An agent that "looks at" its own page and approves what it
    // sees has bypassed the human the review gate exists for — but a renderer
    // that happens to embed Chrome (remotion, a screenshot committed as a page
    // asset, HTML-to-PDF) is a build step writing a file, no different from a
    // compiler. The #114 agent was blocked from producing a demo video by the
    // old absolute wording.
    '- **A browser is a build tool, never a judge.** Headless browser use that renders an ARTIFACT is',
    '  allowed: `remotion render`, a screenshot committed as an asset, HTML-to-PDF. Using a browser to',
    '  view, verify or approve your own work is forbidden — you never judge rendered output by looking',
    '  at it. `publish_preview` is how a HUMAN looks at a page, and their eyes are the only ones that',
    '  pass it.',
    // #161, from #149's ruling: a freshly charted map ships on the charting
    // model plus the human in that loop, with no verification gate behind them.
    // The dispatched agent reading the map cold is the only fresh check left, so
    // the catch is stated as a duty rather than left to luck — curia-107 found
    // exactly this gap on the landing-page map and only because it happened to
    // look. It rides HERE, not in the wayfinder skill: the skill is a host file
    // outside this repo, it loads on claude only (#173), and it has no word for
    // "escalation" because a hand session has the human in the room.
    //
    // Mapped ticket dispatches only. A mapless ticket has no map to check, and a
    // charting dispatch IS the repair — telling it to escalate about the map it
    // was sent to change would be circular.
    ...(mapNumber && !charting ? [
      '- **A map that cannot reach its destination is an escalation.** You read the map cold, which makes',
      '  you its only fresh check: if the way it charts stops short of its destination, say so in your',
      '  first `ask_human` call, rather than working around the gap or leaving it for the review gate.',
    ] : []),
    // #172, and #180 before it: an agent's tool set is a control, and both
    // harnesses handed out tools curia never configured. Those two tickets shut
    // the namespaces off, so this line is not the enforcement — it is the half
    // no setting reaches. A harness keeps ordinary ways to widen its own reach
    // that no config key covers: a skill that installs an MCP server, a `codex
    // plugin add`, a `claude mcp add`, a marketplace. Said harness-blind on
    // purpose, because it is true on both lanes and the prompt is one text.
    '- **Your tools are the ones curia configured, and that set is closed.** Do not install, connect,',
    '  enable or add another — no plugin, no app, no MCP server, no marketplace, whatever offers it.',
    '  A tool curia did not give you is out of bounds even when it is reachable, and reaching for one',
    '  is an `ask_human` call, never a decision you make.',
    // #285, ADR-0005: a HITL ticket used to be one question per call. The wait
    // is the expensive part, not the token, so the unit is now the ROUND — the
    // frontier of independent questions, asked together. The dependency rule is
    // what keeps this honest: batching a question whose answer hangs on another
    // open question is guessing, and guessing is the thing this bound forbids.
    // #418, ADR-0019: the round is TYPED now. `questions[]` replaces the numbers
    // an agent used to write inside one prose prompt, and the ✅ button is
    // derived from the array rather than claimed by a flag. So the bound says
    // where each question goes, not how to number it: curia does the numbering.
    '- **A HITL ticket is many `ask_human` calls, one ROUND at a time.** A round is every question whose',
    '  answer does not depend on another question you have open. Put every one of them in `questions`, and',
    '  give each its own `recommendation`. curia numbers them and adds the ✅ All as recommended button when',
    '  every question carries one, so one reply names the exceptions. A question whose answer depends on',
    '  another one still open belongs to the NEXT round. One question is a round of one.',
    // #415, ADR-0019: the agent writes the parts and the bridge lays out the
    // card. The example, the table and the diagram stay judgment fields,
    // because a field required on every option produces filler rather than
    // evidence.
    '- **Write the PARTS of a card, never the card itself.** `headline` says the whole decision in one line.',
    '  Every option of a `choice` carries the `consequence` of picking it. curia lays them out, adds the',
    '  buttons and writes every link. An `example`, a `table` or a `diagram` is your judgment: add one where it',
    '  removes prose, and leave it out where it would only say the line above it again in longer words.',
    '- **Never answer for the human.** A question they did not answer comes back in the next round. Only',
    '  the ✅ button takes your recommendations, and only for the questions in the round it sits on.',
    // #56: a daemon crash took an in-flight ask_human down with it, and the agent
    // read the transport error as permission to decide the question itself. A
    // failed call is the one case where "never answer for the human" has to be
    // said again, because the failure looks like an answer arriving empty.
    //
    // #341 measured the timing this rule runs against, and it beat the rule as
    // written. The tool channel SURVIVES a daemon restart: the MCP server is
    // stateless and the client opens a connection per call, so the first call
    // after the outage lands with no handshake. What dies is the call in flight,
    // and the transport reports it about 120 s late — by which time the daemon
    // has usually been back for two minutes. A retry that fires seconds after
    // the failure therefore falls inside the same outage. That is exactly what
    // #56's own agent did: four calls inside two minutes, four failures, and it
    // ended its turn on a channel that was already healthy. So the retry now
    // carries WAITS, and the sleep is named because a harness that backgrounds
    // one turns the wait into no wait at all.
    '- **A failed `curia` tool call is not an answer.** If a call returns an error instead of a human reply,',
    '  make the same call once more: curia routes the human to whichever call is live. A failure usually',
    '  means the daemon is restarting, and the channel comes back by itself, so a retry that fails at once',
    '  proves nothing. Wait two minutes with a foreground `sleep 120` and make the call again. If that',
    '  fails too, wait five minutes the same way and make it one last time. Only then stop and end your',
    '  turn — say what you were asking. Never treat an unanswered question as answered, and never decide',
    '  it yourself because the tool broke.',
    // Written by the #56 live check, whose agent blocked for 7h53m and reported
    // that the rule above would never have fired: nothing broke. What pushed it
    // toward answering was silence plus a plausible story, and the low stakes of
    // the question — "nobody audits a heading".
    '- **Silence is not an answer either.** `ask_human` blocks for as long as the human takes, and hours',
    '  are normal. A slow, backgrounded or quiet call is still open: keep waiting. Never let a story about',
    '  why nobody replied — the daemon must be dead, they must be asleep — stand in for the reply. This',
    '  holds hardest on small questions, because a wrong answer to a small one is the one nobody checks.',
    // #418, and the memory-file line #438 left to the build ticket. On codex a
    // rejection is the `exec` script's RETURN VALUE and it never throws, so a
    // model that ignores the value reads `Script completed` and moves on. This
    // line and the tool description are the two prose levers. Neither is a
    // guarantee, and the Stop hook is the catch that is.
    '- **Read what a `curia` tool call gives back.** curia lints the words you send a human, and it REFUSES',
    '  a call whose words break a rule. The refusal names the rule and quotes your own text. Rewrite that',
    '  field and make the call again. You get three attempts, and the fourth text goes out flagged, with',
    '  its faults printed on the card. A refused call asked nobody anything, so a call you treat as sent',
    '  leaves your question unasked and the human waiting for nothing.',
    // #287: the vendored `prototype` skill tells this agent to capture the
    // prototype on a throwaway branch out of main. Three of its four capture
    // clauses already hold here — `curia/<n>` IS cut from main and deleted at
    // the merge — so the skill is READ rather than contradicted. Only the last
    // clause is deviated from, because ADR-0008 leaves no other durable home.
    // It rides here rather than in the skill file: `skills/` is upstream's
    // bytes, pinned in UPSTREAM.md, and an edit there would hide the deviation
    // in a tree whose whole point is that a bump shows up as a diff.
    ...(type === 'wayfinder:prototype' ? [
      `- **Offer ${prototypeVariations} variations in each prototype round by default.** You may offer more or fewer`,
      '  when the work warrants it, but state why. A logic walkthrough may warrant a different count.',
      '  Vary along the dimensions the ticket opens, such as user interface, user experience, style, or',
      '  application programming interface design. Palette or copy',
      '  changes alone do not count.',
      '- **Carry the operator\'s feedback into each new round.** Keep what the operator kept, avoid what the',
      '  operator rejected, mix working patterns, and add new ideas. Record every round in `NOTES.md`, and',
      '  keep earlier variations reachable for reference.',
      `- **Your throwaway branch is \`${branch}\`, the one you are already on.** The \`prototype\` skill says to`,
      '  capture the prototype on a throwaway branch out of main. That branch is THIS one: curia cuts it from',
      '  main and deletes it at the merge. Do not make a second branch, and do not push one.',
      '- **The prototype lives under `prototypes/<name>/`, and main keeps it.** This is curia\'s one deviation',
      '  from that rule (ADR-0008): a merge is the only durable home here, so a prototype is on main or it dies',
      '  with its branch. The directory name is what marks the code throwaway.',
      '- **The demo is ONE self-contained HTML file.** Serve it with a static server on a preview port and call',
      '  `publish_preview`. The operator reads it on a phone, where no double-click exists. Name the ticket in',
      '  a header at the top of the file, and put the verdict in your resolution comment. curia keeps no index',
      '  of that directory — the map\'s Decisions-so-far is the index.',
    ] : []),
    '- Where a skill and these bounds disagree, these win.',
  ]

  const tools = charting ? [
    '- `ask_human` — a decision you cannot make alone. Blocks until a human answers, for as long as it',
    '  takes. This is how you reach the operator who dispatched you.',
    '- `notify`: your opening, working phase, or milestone for the human. Returns at once. On your first',
    '  call, send `opening.goal`, `opening.first_step`, `phase`, and `label`. The opening uses two lines.',
    '  Later routine updates send `phase` and `label` without a message. Use a message for a milestone.',
    '  `kind` says what they must DO:',
    '  `progress` (nothing), `look` (open a file or a page now), `ask` (reply when they can). An `ask`',
    '  blocks nothing, so use `ask_human` when you cannot go on without the answer.',
    ...(newMap ? [
      '- `map_created` — tell curia the number of the map you created, the moment it exists. curia checks',
      '  the issue is really an open `wayfinder:map` in this repo, then takes it as this session\'s map:',
      '  the thread is renamed to it, `map <n>` on it is refused while you run, and your final summary',
      '  lands there. Call it once, and never before the issue exists.',
    ] : []),
    // #297: two tools a map dispatch used to be refused. It gets them when its
    // research subagents wrote something — and only then. A session that
    // produced no file has nothing to push and nothing to show.
    '- `open_pull_request` — curia pushes your branch and opens or updates the pull request. You never',
    '  push. Only for research findings you committed.',
    '- `request_review` — the one gate, and it judges the FINDINGS. curia shows the human the pull',
    '  request and the map, and blocks until they approve or reject. **You never write a link yourself.**',
    '  A rejection comes back as their own words: fix, commit, `open_pull_request` again, ask again.',
    // #419, ADR-0019: the report is typed too. The headline is the line the
    // thread reads first, and the map pointer takes it as the gist.
    '- `report_result` — exactly once, at the very end. `headline` says what the session came to in one',
    '  line, and `summary` says what you charted. Both become curia\'s comment on the map.',
    '- `publish_preview` belongs to a ticket dispatch. A research note is read as a diff, so there is',
    '  nothing here to preview.',
  ] : [
    '- `ask_human` — a decision you cannot make alone. Blocks until a human answers, for as long as it',
    '  takes.',
    '- `notify`: your opening, working phase, or milestone for the human. Returns at once. On your first',
    '  call, send `opening.goal`, `opening.first_step`, `phase`, and `label`. The opening uses two lines.',
    '  Later routine updates send `phase` and `label` without a message. Use a message for a milestone.',
    '  `kind` says what they must DO:',
    '  `progress` (nothing), `look` (open a file or a page now), `ask` (reply when they can). An `ask`',
    '  blocks nothing, so use `ask_human` when you cannot go on without the answer.',
    ...(portLines.length ? [
      '- `publish_preview` — publish a dev server you have started as an HTTPS link. Start the server FIRST,',
      `  bound to \`0.0.0.0\` on one of your three ports (${ports.join(', ')}), then call this with that port`,
      '  and the path of the page to look at.',
    ] : [
      '- `publish_preview` — publish a dev server you have started on localhost as an HTTPS link. Start the',
      '  server FIRST, then call this with the port it bound and the path of the page to look at.',
    ]),
    '- `open_pull_request` — curia pushes your branch and opens or updates the pull request. You never push.',
    '- `request_review` — the one gate. curia shows the human the pull request, the preview, the ticket and',
    '  your proposed charting, and blocks until they approve or reject. **You never write a link yourself.**',
    '  curia composes all three from its own records, which is what makes them evidence rather than your',
    '  account of your own work. If the preview link points at the wrong page, fix it where it is made —',
    '  call `publish_preview` again with the right path — not by pasting a URL into your summary.',
    '- `report_result` — exactly once, at the very end. `headline` says what the work came to in one',
    '  line, and `summary` says what changed. curia lints both, and it lays the report out itself.',
  ]

  // #165, ADR-0010: the gate's third button. The builder is told this at spawn
  // time and told it again in the tool result that hands it the verdict, because
  // the press can land days into a ticket and this prompt may be far behind.
  // #297: a charting agent reads this too now. The gate it can open is the gate
  // the third button sits on, so a session that skipped this section would meet
  // a cross-check verdict with no word for what it is.
  const crossCheck = [
    '',
    '## The cross-check (a third button on the gate)',
    '',
    'The review gate has a third button beside approve and reject. It is pressable on every round. The',
    'operator presses it to put a reviewer on the OTHER provider onto your diff. It answers nothing:',
    'nothing merges and nothing is rejected.',
    '',
    'The press does not end your `request_review` call. You stay in it, idle. Your worktree, your session',
    'and whatever you claimed stay with you while the reviewer reads. The call then returns with the',
    'verdict, and this is your duty:',
    '',
    ...dutyLines(),
    '',
    'The operator can also start a cross-check from the thread, at any moment. Then the news reaches you',
    'as a message on a tool result: a reviewer is reading your diff, and the verdict follows the same way.',
    'Until it lands, do not resolve the ticket, do not merge the pull request, and do not call',
    '`report_result`. `report_result` and `request_review` park until the verdict arrives, so neither call',
    'is a way past this. The resolve and the merge are `gh` commands in your own shell, and you are the',
    'only one who can hold those. Judge the verdict first, then end.',
    '',
    'The reviewer never gets a reply and never reads the same diff twice. curia posts the verdict and your',
    'question on the pull request by itself, so you post neither.',
  ]

  // #340: the prompt carries the parameters, and the memory file carries the
  // standing orders. One copy of each fact, in the place that survives longest.
  // The pointer is the only thing said twice, and it is one line: an operator
  // reading `prompt.md` has to know the bounds are not missing.
  const promptBody = [
    ...invocation,
    `# ${repo}#${n}: ${issue.title}`,
    '',
    issue.body ?? '(no body)',
    '',
    '---',
    '',
    '## What curia already did (parameters, not procedure)',
    '',
    ...allParams,
    '',
    `Your bounds, your tools and the ending are in \`${memoryFileFor(harness)}\`, which this harness`,
    'loads as standing instructions rather than as one message. They hold for every turn of this',
    'ticket, and they beat any skill they disagree with.',
    '',
  ].join('\n')

  const standingBody = [
    `# curia standing orders (${repo}#${n})`,
    '',
    'These orders hold for the whole ticket. The parameters of this dispatch are in `prompt.md`.',
    '',
    '## Bounds (curia daemon)',
    '',
    ...bounds,
    '',
    'Keep trivial work inline.',
    'If a task must read or write significant amounts, delegate it when delegation has no downside.',
    'These standing orders pass to every subagent, and the write bounds bind each subagent as they bind you.',
    '',
    '## Your tools (the `curia` MCP server)',
    '',
    ...deferredCuriaOrder(harness),
    ...tools,
    '',
    '## How this ends',
    '',
    ...endingProse({ repo, ticket: n, branch, mapNumber, charting, newMap }),
    '',
    ...(charting
      ? [
        ...CHARTING_NEVER.flatMap(([first, ...rest]) => [`- ${first}`, ...rest.map((l) => `  ${l}`)]),
        '- If you cannot finish, call `report_result` with status `blocked` and say why. A half-charted map',
        '  is worse than an unchanged one, so say which part you left alone.',
        '- curia holds you at this ending: its Stop hook refuses your stop while a step is outstanding, and',
        '  tells you which one.',
      ]
      : [
        '- If you cannot finish, call `report_result` with status `blocked` and say why. Never comment-and-close',
        '  a ticket you did not resolve.',
        '- curia holds you at this ending: its Stop hook refuses your stop while a step is outstanding, and',
        '  tells you which one. It also verifies the resolution afterwards and repairs what is missing, so an',
        '  honest `report_result` matters more than a perfect run.',
      ]),
    ...crossCheck,
    '',
  ].join('\n')

  fs.writeFileSync(promptFile, promptBody)
  fs.writeFileSync(path.join(cfgDir, STANDING_FILE), standingBody)
  composeMemoryFile(cfgDir, harness)
  return promptFile
}

// ---- the reviewer's prompt (#164, ADR-0010) ----------------------------------

// The cross-check reviewer's standing orders. Its own function rather than a
// branch in writePrompt, because almost nothing is shared: no `/wayfinder` line
// (the reviewer works through no map and resolves no ticket), no claim, no
// worktree it may write, no ending but one call.
//
// What it does share is the SHAPE — parameters, bounds, tools, ending — so an
// operator reading a reviewer's prompt beside a builder's reads the same
// document twice. The one section with no counterpart is "What to do", because
// the reviewer's job is not stated by any skill it carries.
//
// `wtPath` is the checkout AS THE AGENT SEES IT (#156), like everywhere else:
// the mount point inside a container, the host path outside one.
export function writeReviewPrompt(cfgDir, issue, {
  repo, wtPath, branch, baseBranch, sha, model, builderModel, ticketUrl = null, harness = 'claude',
}) {
  harnessDef(harness)
  const promptFile = path.join(cfgDir, 'prompt.md')
  const n = issue.number
  const url = ticketUrl ?? `https://github.com/${repo}/issues/${n}`
  const short = String(sha ?? '').slice(0, 12)

  const params = [
    `- The ticket is ${repo}#${n} — ${url}. Its body is above: it is what the work was supposed to be.`,
    `- The tracker is **GitHub**, repo \`${repo}\`, reached with the \`gh\` CLI. Read it freely.`,
    `- Your checkout is ${wtPath}. It is a DETACHED HEAD at \`${short}\`, the pushed tip of \`${branch}\`.`,
    '  It is yours alone: the builder works in a checkout of its own, and nothing you do here reaches it.',
    `- The diff is \`git diff origin/${baseBranch}...HEAD\`, and the commits are`,
    `  \`git log --oneline origin/${baseBranch}..HEAD\`.`,
    `- You run on **${model}**. The builder ran on **${builderModel}**. You are the second reading of`,
    '  this diff, on another model, which is the whole reason you exist.',
  ]

  const orders = [
    '1. Read the ticket, then the diff, then the checkout around it. The diff alone does not say whether',
    '   the change is right — the code it lands in does.',
    '2. Run the tests. Find how this repo runs them and run them yourself. A finding you proved beats a',
    '   finding you reasoned about, and "the tests pass" is itself worth stating.',
    '3. Judge the work against the TICKET, not against how you would have written it. A different style',
    '   is not a finding. A wrong answer, a missing case, a broken test, a bound nobody checked is.',
    '4. End with the verdict.',
  ]

  // #421: the verdict is TYPED. The reviewer writes the parts and curia lays
  // them out, which is the rule every other prose surface follows (ADR-0019).
  // The reviewer never writes the grade word: curia derives it from the
  // severities, so a verdict cannot say pass over its own blocker.
  const verdict = [
    'Your `report_result` IS the verdict, and a human reads it on a phone. You write the PARTS, and',
    'curia lays them out:',
    '',
    '- `headline` — the verdict in one line, at most 150 characters.',
    '- `summary` — what you read and what you ran, at most 600 characters.',
    '- `findings` — one entry per finding, most serious first. Each entry carries:',
    '  - `text` — the file and the line, what is wrong, and why it matters.',
    '  - `severity` — `blocker` (do not merge as it stands), `concern` (the operator decides),',
    '    `note` (worth knowing).',
    '  - `out_of_scope` — true when the finding is real but sits beyond this ticket.',
    '- `detail` — short facts, rendered as a spoiler. Optional.',
    '- `table` — a code-block table, at most 42 columns by 20 lines, columns lined up. Optional.',
    '- `diagram` — an ASCII drawing, at most 42 columns by 20 lines. Optional.',
    '',
    'curia reads the GRADE of the whole verdict off those severities: one blocker makes it `fail`, one',
    'concern makes it `concerns`, and neither makes it `pass`. You never write that word yourself.',
    '',
    'Send an EMPTY `findings` list when the reading is clean. A clean reading is a real result, and',
    'padding it hides the findings that matter. Be specific and be short. curia lints your words and',
    'refuses the call when they break a rule: the refusal names the field and quotes your own text.',
  ]

  const body = [
    `# Cross-check of ${repo}#${n}: ${issue.title}`,
    '',
    issue.body ?? '(no body)',
    '',
    '---',
    '',
    '## What you are (curia daemon)',
    '',
    `You are the CROSS-CHECK REVIEWER for ${repo}#${n}. Another model built this change and a human is`,
    'about to approve it. You read the same diff and say what you find. You are not that human, and you',
    'are not the builder: nothing you write lands anywhere, and nothing you decide is acted on by you.',
    '',
    '## What curia already did (parameters, not procedure)',
    '',
    ...params,
    '',
    '## What to do',
    '',
    ...orders,
    '',
    '## Bounds (curia daemon)',
    '',
    '- **Read anything.** The checkout, the ticket, its map, any sibling or closed issue, the web. Nothing',
    '  here limits reading.',
    ...REVIEWER_NEVER.flatMap(([first, ...rest]) => [`- ${first}`, ...rest.map((l) => `  ${l}`)]),
    '- Where a skill and these bounds disagree, these win.',
    '',
    '## Your tools (the `curia` MCP server)',
    '',
    ...deferredCuriaOrder(harness),
    '- `notify` — a status line for the human. Returns at once. Use it to say what you are reading.',
    '  `kind` says what they must DO: `progress` (nothing), `look` (open a file or a page now),',
    '  `ask` (reply when they can). A reviewer reads, so its lines are `progress`.',
    '- `report_result` — exactly once, at the very end. Its headline, its summary and its findings',
    '  are the verdict. curia lints them and lays them out.',
    '- Every other curia tool is refused for you, by name, with the reason.',
    '',
    '## The verdict',
    '',
    ...verdict,
    '',
    '## How this ends',
    '',
    ...endingProse({ repo, ticket: n, branch, reviewer: true }),
    '',
    '- If you cannot review — the checkout will not build, the tests cannot run, the diff is unreadable —',
    '  call `report_result` with status `blocked` and say exactly what stopped you. Never guess a verdict.',
    '- curia holds you at this ending: its Stop hook refuses your stop until the verdict is in.',
    '',
  ].join('\n')
  fs.writeFileSync(promptFile, body)
  return promptFile
}

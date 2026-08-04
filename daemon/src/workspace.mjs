// Daemon-owned workspaces (#33 step 6). Layout under workspace_root:
//   repos/<owner>__<repo>/base   — shared base clone (push-disabled)
//   repos/<owner>__<repo>/wt/<n> — per-ticket worktrees
//   cfg/curia-<n>                — per-worker agent config dir (+ prompt file);
//                                  holds no credential of its own since #53
// Never Alp's working tree; nothing here is authoritative state.
//
// The config dir is per BACKEND since #39: `CLAUDE_CONFIG_DIR` for the claude
// lane, `CODEX_HOME` for the codex one. See the HARNESS table below — it is the
// one place the two lanes differ on disk, and everything above it (worktrees,
// branches, landing) is backend-blind.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileP } from './exec.mjs'
import { endingProse, CHARTING_NEVER } from './lifecycle.mjs'
import { TOKEN_HEADER } from './workertoken.mjs'

// The mandatory communication rules (#133): a curia-owned copy of the
// operator's STE writing standard, seeded into every config dir as the CLI's
// global-memory file so the overseer and every worker load it. Committed in
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
// worktree add killed hard at the timeout leaves .git/index.lock or
// refs/**.lock behind, and every later dispatch for that repo then fails in
// ensureBaseClone/createWorktree until a human deletes the lock. One transient
// network stall must not poison the base clone. (gh/tmux/tailscale keep
// SIGKILL: none of them holds on-disk locks we depend on.)
function git(cwd, args, options = {}) {
  return execFileP('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGTERM', ...options })
}

export function basePathFor(root, repo) {
  return path.join(root, 'repos', repo.replace('/', '__'), 'base')
}

export function worktreePathFor(root, repo, n) {
  return path.join(root, 'repos', repo.replace('/', '__'), 'wt', String(n))
}

export function cfgDirFor(root, session) {
  return path.join(root, 'cfg', session)
}

// Clone if missing, fetch if present; then disable pushing to origin.
//
// Be precise about what that buys: it stops `git push origin`
// from the base clone and its worktrees, and nothing else. It is undone by one
// `git remote set-url --push origin <real url>`, bypassed by an explicit-URL
// push, and entirely irrelevant to the inherited `gh` credential the worker also
// holds (`gh api -X PUT .../contents/...`, `gh pr create`, `gh issue edit`
// never consult a push URL). It is a speed bump against an honest mistake, NOT
// a control against a worker steered by hostile ticket text; the real belt is
// the standing order in the prompt file plus the post-run manual check.
//
// Harness files are excluded via the clone's info/exclude, shared by all worktrees.
export async function ensureBaseClone(root, repo) {
  const base = basePathFor(root, repo)
  if (!fs.existsSync(path.join(base, '.git'))) {
    fs.mkdirSync(path.dirname(base), { recursive: true })
    await execFileP('gh', ['repo', 'clone', repo, base], { maxBuffer: 16 * 1024 * 1024, timeout: CLONE_TIMEOUT_MS })
  } else {
    await git(base, ['fetch', 'origin', '--prune'], { timeout: CLONE_TIMEOUT_MS })
  }
  await git(base, ['remote', 'set-url', '--push', 'origin', 'no_push://disabled'])

  const excludeFile = path.join(base, '.git', 'info', 'exclude')
  const wanted = ['.mcp.json', '.claude/', '.curia-prompt.md']
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : ''
  const missing = wanted.filter((l) => !existing.split('\n').includes(l))
  if (missing.length) {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
    fs.appendFileSync(excludeFile, (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
  }
  return base
}

export function branchFor(n) {
  return `curia/${n}`
}

export async function defaultBranchOf(base) {
  const { stdout } = await git(base, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  return stdout.trim().replace('refs/remotes/origin/', '')
}

// Does origin already carry this ticket's branch? Read from the tracking ref,
// which ensureBaseClone has just refreshed with `fetch --prune` — no second
// network round-trip, and no dependency on `gh auth setup-git` for a private
// repo (the reason pushBranch names its credential helper on the command line).
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

// Fresh worktree on branch curia/<n>, started from origin/curia/<n> WHERE THAT
// EXISTS and from origin's default branch otherwise.
//
// The start point is #54 item 6. Re-dispatch used to force-reset the branch off
// origin/HEAD and then push non-forced, which fails outright once a pull request
// is open — and, worse, would have thrown away every commit already under
// review. Now a re-dispatch continues the branch it finds, so the second worker
// adds to the same pull request (the rejection loop's own shape, applied across
// dispatches).
//
// -B is kept: the local branch must point at whichever start point was chosen,
// and a stale worktree registration at the same path is removed first (worktree
// add refuses an existing path).
export async function createWorktree(base, n) {
  const wt = path.join(path.dirname(base), 'wt', String(n))
  const branch = branchFor(n)
  const start = await remoteBranchExists(base, branch)
    ? `origin/${branch}`
    : `origin/${await defaultBranchOf(base)}`
  if (fs.existsSync(wt)) {
    await git(base, ['worktree', 'remove', '--force', wt]).catch(() => {})
    fs.rmSync(wt, { recursive: true, force: true })
  }
  await git(base, ['worktree', 'prune'])
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  await git(base, ['worktree', 'add', '-B', branch, wt, start])
  return wt
}

// ---- landing the work (#41) --------------------------------------------------

// What the worker ACTUALLY committed, observed by the daemon in git rather than
// taken from the worker's account of itself — this is what the PR body reports.
export async function commitsOnBranch(wtPath, defaultBranch) {
  const { stdout } = await git(wtPath, ['log', '--format=%h%x09%s', `origin/${defaultBranch}..HEAD`])
  return stdout.split('\n').filter((l) => l.trim()).map((l) => {
    const [sha, ...rest] = l.split('\t')
    return { sha, subject: rest.join('\t') }
  })
}

// The daemon pushes; the worker never does (#41) — the same containment
// boundary as preview allocation (#40). The base clone's push URL stays
// disabled, so this goes out over an EXPLICIT URL with gh's credential helper
// named on the command line: the daemon does not depend on `gh auth setup-git`
// having been run for whoever owns the box.
//
// Pushing an explicit URL does not move refs/remotes/origin/*, and
// hasUnpushedWork() — which decides whether the orphan sweep is allowed to
// destroy a worktree — reads exactly that ref. So the tracking ref is updated
// here, to the sha that was actually pushed and nothing else.
export async function pushBranch(wtPath, repo, branch) {
  const { stdout } = await git(wtPath, ['rev-parse', 'HEAD'])
  const sha = stdout.trim()
  await git(wtPath, [
    '-c', 'credential.helper=!gh auth git-credential',
    'push', `https://github.com/${repo}.git`, `${sha}:refs/heads/${branch}`,
  ], { timeout: CLONE_TIMEOUT_MS })
  await git(wtPath, ['update-ref', `refs/remotes/origin/${branch}`, sha])
  return sha
}

// Does this worktree hold commits that exist nowhere else? Before #41 a
// worktree held only a local commit nobody depended on, so the orphan sweep
// could force-remove it freely. Now the daemon is expected to land that work,
// and a sweep that fires between the commit and the push would destroy the only
// copy. Throws when it cannot tell — callers must read "unknown" as "keep".
export async function hasUnpushedWork(wtPath, branch, defaultBranch) {
  let ref = `origin/${defaultBranch}`
  try {
    await git(wtPath, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
    ref = `refs/remotes/origin/${branch}`
  } catch { /* never pushed: measure against the default branch instead */ }
  const { stdout } = await git(wtPath, ['rev-list', '--count', `${ref}..HEAD`])
  return Number(stdout.trim()) > 0
}

// Branch is kept deliberately (salvage; re-frontier is the recovery).
//
// Two workspace shapes since #156, and one caller: the bare path's worktree,
// which git must unregister from its base clone, and the sandbox's private
// clone, which owns its whole `.git` and is just a directory. A worktree marks
// itself with a `.git` FILE pointing into the base; a clone has a `.git`
// directory. `git worktree remove` on a clone fails with "is not a working
// tree", so the shape is read rather than assumed.
export async function removeWorktree(base, wtPath) {
  if (isPrivateClone(wtPath)) {
    fs.rmSync(wtPath, { recursive: true, force: true })
    return
  }
  await git(base, ['worktree', 'remove', '--force', wtPath])
}

// A standalone clone (#156) rather than a worktree cut from the base clone.
// `.git` is a directory in the first case and a file in the second.
export function isPrivateClone(wtPath) {
  try {
    return fs.statSync(path.join(wtPath, '.git')).isDirectory()
  } catch {
    return false
  }
}

// ---- the sandbox's private clone (#156, from #148) ---------------------------
//
// A container worker gets its OWN clone instead of a worktree cut from the
// shared base, because a worktree's `.git` is a file pointing into the base
// clone: mounting only the worktree would give the container a repository with
// no object store, and mounting the base as well would hand every worker every
// other worker's branches and commits.
//
// `--filter=blob:none` is what keeps that affordable. A blobless clone fetches
// commits and trees now and blobs on demand, so a per-ticket clone costs
// seconds rather than a full history download per dispatch.
//
// The remote is forced to HTTPS, and no push URL is disabled here: the base
// clone's `no_push://` trick exists because MANY workers share that clone, and
// a private clone the worker owns has nothing to protect from itself.
export async function createPrivateClone(root, repo, n, { identity = null } = {}) {
  const wt = worktreePathFor(root, repo, n)
  const branch = branchFor(n)
  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  // `gh repo clone` rather than `git clone`: it carries the daemon's own login,
  // so a private watched repo clones with no credential helper set up on the
  // box. Everything after `--` is passed through to git.
  await execFileP('gh', ['repo', 'clone', repo, wt, '--', '--filter=blob:none'], {
    maxBuffer: 16 * 1024 * 1024, timeout: CLONE_TIMEOUT_MS,
  })
  // gh follows the box's `git_protocol` setting, which may be ssh — and the
  // container holds no ssh key by design. HTTPS with GH_TOKEN is the one way a
  // worker reaches the remote (#155).
  await git(wt, ['remote', 'set-url', 'origin', `https://github.com/${repo}.git`])
  // What the container pushes and fetches with. `gh` is in the image and
  // `GH_TOKEN` is in its environment, so the helper resolves to the worker's
  // own scoped token rather than to any account on the box.
  await git(wt, ['config', 'credential.helper', '!gh auth git-credential'])
  // The container HOME carries no gitconfig, so an unset identity would fail
  // the worker's first commit with "please tell me who you are". Copied from
  // the box rather than invented: authorship stays what the bare path produced.
  const who = identity ?? await hostGitIdentity()
  await git(wt, ['config', 'user.name', who.name])
  await git(wt, ['config', 'user.email', who.email])

  const start = await remoteBranchExists(wt, branch)
    ? `origin/${branch}`
    : `origin/${await defaultBranchOf(wt)}`
  await git(wt, ['checkout', '-B', branch, start])

  const excludeFile = path.join(wt, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.appendFileSync(excludeFile, '\n.mcp.json\n.claude/\n.curia-prompt.md\n')
  return wt
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
    name: name || 'curia worker',
    email: email || 'curia@users.noreply.github.com',
  }
}

// Full removal where the worktree is destroyed anyway (cancel, orphan sweep);
// credentials-only where the workspace is kept for review (lifecycle close) so
// prompt.md survives the post-mortem. Since #53 a worker's config dir holds no
// credential of its own, so removeCredentials collects only leftovers — kept
// because a leftover is a real host refresh token sitting on disk.
export function removeConfigDir(cfgDir) {
  fs.rmSync(cfgDir, { recursive: true, force: true })
}

// Every path a backend could leave a credential at, swept whatever the worker's
// own backend was: a config dir is reused across dispatches and a re-seed onto
// the other backend leaves the first one's files behind.
//
// `rmSync` unlinks a symlink rather than following it, so sweeping the codex
// lane's `auth.json` link never touches the host file it points at.
export function removeCredentials(cfgDir) {
  for (const name of ['.credentials.json', 'auth.json']) {
    fs.rmSync(path.join(cfgDir, name), { force: true })
  }
}

// ---- per-backend harness -----------------------------------------------------
//
// One worker, two shapes on disk. The claude lane keeps its config dir and puts
// curia's side channel in the WORKTREE (.mcp.json + .claude/settings.json,
// git-excluded); the codex lane puts everything in the config dir and writes
// nothing into the repo at all.
//
// The shared design across both, and the reason the codex lane cost harness work
// rather than a config line (#33's stated deviation 3):
//   * credentials are the HOST's file, shared and never snapshotted (#53);
//   * the config dir isolates settings, skills and MCP from the host (#23/#29);
//   * a blocking `ask_human` reaches the daemon over MCP;
//   * a Stop hook posts to /worker_done and can BLOCK the stop, which is what
//     enforces the merge-gated ending (#54). That last one is why codex earns a
//     lane at all: `codex --version 0.145` ships Claude-compatible hooks, so the
//     ending is enforced identically instead of degrading to session-exit
//     detection as this ticket assumed it would have to.
//
// Verified live before it was written (see the ticket's resolution): codex
// reaches an HTTP MCP server from `[mcp_servers]`, its Stop hook carries the
// same payload keys and honours `{decision:"block", reason}`, and `stop_hook_active`
// flips on the second stop exactly as Claude's does.

export const HARNESS_BACKENDS = ['claude', 'codex']

function harnessFor(backend) {
  const h = HARNESS[backend]
  if (!h) {
    throw new Error(`no worker harness for backend "${backend}" — known harnesses: ${HARNESS_BACKENDS.join(', ')}`)
  }
  return h
}

// Where the host's own credential store lives for a backend — the single file
// every worker of that backend shares (#53).
export function hostStorageDir(backend = 'claude') {
  return harnessFor(backend).hostStore()
}

// ---- the worker's GitHub authority (#155) ------------------------------------
//
// A worker gets a scoped fine-grained PAT as `GH_TOKEN` instead of the host's
// account-wide `~/.config/gh/hosts.yml` login. `gh` prefers `GH_TOKEN` over
// `hosts.yml` natively, so every wayfinder operation a worker runs keeps working
// with no code that knows the token exists.
//
// ONE TOKEN PER RESOURCE OWNER, because that is what a fine-grained PAT is: the
// creation form has a single resource-owner dropdown, and curia's watch list
// spans two owners (`alp82` and the `getalfredo` org). A single key would hand
// every worker one owner's token and break the other owner's repos, so the key
// carries the owner and the daemon picks by the ticket's own repo.
//
// The DAEMON is deliberately not on this token. Its own `gh` keeps the host
// login, because it must reach every watched repo, and a repo added to
// `curia.yaml` but left off a token would break dispatch with no signal. A bare
// `GH_TOKEN` in `daemon/.env` would re-authenticate the daemon too, silently, by
// sitting in its environment — hence a prefixed key.
//
// The key says AGENT where the rest of this file still says worker: it is
// operator-facing config, and renaming it later would cost a coordinated edit of
// every `.env` plus a restart. The code sweep is #184.
const GH_TOKEN_KEY = 'CURIA_AGENT_GH_TOKEN'

// A GitHub token as GitHub writes one — `github_pat_…`, `ghp_…`, `gho_…`: word
// characters and nothing else. The value travels as `env K=V` in tmux argv (and
// as `-e` on the container's command line later), so a stray quote or space from
// a hand-edited `.env` line has to be refused where it is read. `gh` answers a
// quoted token with a plain 401, and nothing on the box would name the quote.
const GH_TOKEN_RE = /^[A-Za-z0-9_]+$/

// `alp82/curia` → `CURIA_AGENT_GH_TOKEN_ALP82`. An owner is a GitHub login, so
// the only character to fold is the hyphen.
export function ghTokenKeyFor(repo) {
  const owner = String(repo ?? '').split('/')[0]
  if (!owner) return null
  return `${GH_TOKEN_KEY}_${owner.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

function readGhToken(env, key) {
  const raw = env[key]
  if (raw === undefined) return null
  const token = raw.trim()
  if (!token) return null
  if (!GH_TOKEN_RE.test(token)) {
    throw new Error(`bad ${key} in daemon/.env: a GitHub token is word characters only — drop the quotes and any trailing text`)
  }
  return token
}

// The token for one repo, or null. Null is the pre-#155 reach: the worker
// inherits the host login, which is what an owner with no token yet must keep
// getting, or watching a new owner would break every dispatch to it.
export function workerGhToken(repo, env = process.env) {
  const key = ghTokenKeyFor(repo)
  return key ? readGhToken(env, key) : null
}

// Every token key the environment carries, read once so a malformed value
// refuses the BOOT rather than reaching a worker as a 401 mid-resolve. Returns
// the owners that are scoped, for the boot line.
export function assertGhTokens(env = process.env) {
  return Object.keys(env)
    .filter((k) => k.startsWith(`${GH_TOKEN_KEY}_`))
    .filter((k) => readGhToken(env, k) !== null)
    .map((k) => ({ key: k, token: readGhToken(env, k) }))
}

// The whole per-worker env: config isolated, credentials shared, GitHub scoped.
//
// `sandboxed` (#156) changes one thing and says so: a container cannot share
// the host credential store, because the host HOME is what the boundary denies.
// `cfgDir` is then the path INSIDE the container, and the model credential
// rides the env file instead (sandbox.mjs).
export function workerEnv(cfgDir, backend = 'claude', { repo = null, env = process.env, sandboxed = false } = {}) {
  const base = harnessFor(backend).env(cfgDir, { sandboxed })
  const token = workerGhToken(repo, env)
  return token ? { ...base, GH_TOKEN: token } : base
}

// TOML basic string. The values here are daemon-generated paths and a loopback
// URL, so this is belt rather than need — but an unescaped backslash or quote
// in a config file the daemon writes would fail at codex startup, where the
// symptom is a worker sitting at a parse error nobody reads.
function toml(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// The daemon's own address, as the worker reaches it. A bare pane reaches it on
// loopback; a container's loopback is the container, so it reaches the same
// listener through the docker host gateway instead (#156).
export const LOOPBACK = '127.0.0.1'

function curiaMcpUrl(daemonPort, worker, ticket, host = LOOPBACK) {
  return `http://${host}:${daemonPort}/mcp?worker=${worker}&ticket=${ticket}`
}

// How long codex may wait on one curia tool call. Its default is 300 s, and it
// is a HARD deadline on the call, not an idle timer — so #34's MCP-stream
// keepalive, which is what lifts Claude Code's identical 300 s abort, does
// nothing here. That was found the way #34's was: a live worker held a
// `request_review` open, the human took five minutes, and the call died with
// `tool call error: timed out awaiting tools/call after 300s` — twice, because
// the worker correctly retried it (#56's standing order) into a second deadline.
//
// A day, not a literal infinity: codex wants a number, and this is the one place
// #11's "blocks for as long as the human takes" is bounded. It is ~3x the
// longest real block on record (7 h 53 m, #56), the ~30-min re-nudge keeps
// running underneath it, and a block that outlives it re-dispatches rather than
// resolving anything (#11/#12). The keepalive stays on for the claude lane and
// costs nothing here.
const CODEX_TOOL_TIMEOUT_S = 86_400

// The Stop hook, identical on both lanes: POST the hook's own stdin payload to
// the daemon, which answers `{decision:"block", reason}` while a step of the
// ending is outstanding (#54).
//
// The token header rides beside the ticket's own content type (#159). Both
// values are quote-free by construction — a hex token and a daemon-owned port —
// so the single-quoted curl arguments need no escaping rule.
function stopHookCommand(daemonPort, worker, host = LOOPBACK, token) {
  return [
    `curl -s -X POST 'http://${host}:${daemonPort}/worker_done?worker=${worker}'`,
    `-H 'Content-Type: application/json'`,
    `-H '${TOKEN_HEADER}: ${token}'`,
    '-d @-',
  ].join(' ')
}

// The four harness files now carry the worker's secret, so none of them is
// world-readable. On the bare path that is belt only (a sibling worker runs as
// the same host user); in a container the mount arrives owned by the same uid the
// agent runs as, so 0600 is still readable by the one worker that needs it.
function writeSecretFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 })
  fs.chmodSync(file, 0o600) // the mode applies only on create; a reused config dir already has one
}

const HARNESS = {
  claude: {
    // CLAUDE_SECURESTORAGE_CONFIG_DIR is what separates config from credentials.
    // Claude Code resolves its credential store through it and falls back to
    // CLAUDE_CONFIG_DIR only when it is unset, so pointing it at the host's
    // ~/.claude puts the worker on the host's *exact* credentials path — the
    // same file, the same refresh lineage, the same atomic-rename write. That is
    // precisely what a second host session does, which is why several host
    // sessions coexist for days while a worker holding a frozen copy died at the
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
    // CODEX_TOOL_TIMEOUT_S below; the 90 s transport-drop watchdog still
    // aborts a call whose daemon actually died.
    //
    // A CONTAINER cannot have that (#156): the host store lives in the host
    // HOME, which is the first thing the boundary denies. The variable is
    // dropped rather than pointed somewhere else, so Claude Code falls back to
    // CLAUDE_CONFIG_DIR — the worker's own mounted dir — and the credential
    // arrives as an environment variable instead (sandbox.mjs). That is the
    // frozen-credential shape #53 fixed for the bare path, accepted back by
    // #148 as the sandbox's one remaining host-secret exposure.
    env: (cfgDir, { sandboxed = false } = {}) => ({
      CLAUDE_CONFIG_DIR: cfgDir,
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
      fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2))
    },

    // .mcp.json (curia HTTP MCP side channel) + .claude/settings.json (all-project
    // MCP on, bypass permissions, Stop hook → /worker_done) — spike #29 shapes
    // with per-worker substitution. Both land in the worktree and are hidden from
    // git by the base clone's info/exclude (see ensureBaseClone).
    harness: ({ wtPath, worker, ticket, daemonPort, daemonHost, token }) => {
      writeSecretFile(path.join(wtPath, '.mcp.json'), JSON.stringify({
        mcpServers: {
          curia: {
            type: 'http',
            url: curiaMcpUrl(daemonPort, worker, ticket, daemonHost),
            // #159. Claude Code sends a per-server `headers` object on every
            // request to an http MCP server (`claude mcp add --header` writes
            // this exact shape).
            headers: { [TOKEN_HEADER]: token },
          },
        },
      }, null, 2))
      const dotClaude = path.join(wtPath, '.claude')
      fs.mkdirSync(dotClaude, { recursive: true })
      writeSecretFile(path.join(dotClaude, 'settings.json'), JSON.stringify({
        enableAllProjectMcpServers: true,
        permissions: { defaultMode: 'bypassPermissions' },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: stopHookCommand(daemonPort, worker, daemonHost, token) }] }] },
      }, null, 2))
    },
  },

  codex: {
    // CODEX_HOME is the whole config dir: settings, skills, sessions, logs AND
    // the credential file, with no second variable to split them (Claude's
    // CLAUDE_SECURESTORAGE_CONFIG_DIR has no codex equivalent). Sharing the
    // host's credentials therefore has to happen inside the dir.
    hostStore: () => path.join(os.homedir(), '.codex'),
    env: (cfgDir) => ({ CODEX_HOME: cfgDir }),

    // A SYMLINK to the host's auth.json, which is the same shared-store property
    // #53 landed for Claude and — read this carefully — reached by the opposite
    // mechanism. #53 found that a symlinked Claude credential file is REPLACED by
    // a regular file on the worker's first refresh, because Claude writes
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
    // The cost is the same one #53 accepted: a worker can reach the host's real
    // credential file, so it has a host session's blast radius there. The one
    // difference worth stating is that codex's write is NOT atomic — a truncating
    // in-place rewrite, where Claude's is a rename — so a refresh racing a read
    // can be seen torn. The window is one small write and nothing in codex locks
    // that file (its own locks live under $CODEX_HOME/tmp, which is per-worker
    // and so shares nothing), and the failure re-dispatches (#11/#12).
    seed: (cfgDir) => {
      const link = path.join(cfgDir, 'auth.json')
      fs.rmSync(link, { force: true })
      fs.symlinkSync(path.join(os.homedir(), '.codex', 'auth.json'), link)
    },

    // Everything the codex lane needs is in the config dir, so nothing is written
    // into the watched repo at all — no .mcp.json, no settings file, nothing to
    // git-exclude.
    //
    // `[projects.<wt>] trust_level` is the codex analogue of Claude's
    // hasTrustDialogAccepted: without it the first spawn stops at a "Do you trust
    // the contents of this directory?" prompt and the worker never reaches its
    // composer (observed, before this line existed).
    harness: ({ wtPath, cfgDir, worker, ticket, daemonPort, daemonHost, reasoningEffort, token }) => {
      writeSecretFile(path.join(cfgDir, 'config.toml'), [
        '# Written by the curia daemon per worker. Never hand-edited.',
        '',
        // Written whenever routing states one, because a model's OWN default is
        // not a constant across models: gpt-5.5 defaults to medium and
        // gpt-5.6-sol to low, so changing `models.<name>.id` alone would move
        // the effort underneath the lane without saying so. Stating it makes the
        // model and the depth two separate, visible decisions.
        ...(reasoningEffort ? [`model_reasoning_effort = ${toml(reasoningEffort)}`, ''] : []),
        '[features]',
        'hooks = true',
        '',
        `[projects.${toml(wtPath)}]`,
        'trust_level = "trusted"',
        '',
        '[mcp_servers.curia]',
        `url = ${toml(curiaMcpUrl(daemonPort, worker, ticket, daemonHost))}`,
        `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_S}`,
        // #159, the codex spelling of the claude lane's `headers` object. An
        // inline table, which is what `codex mcp list --json` reads back as the
        // transport's `http_headers`. `bearer_token_env_var` is the other option
        // codex offers and it is the wrong one here: it names an ENVIRONMENT
        // VARIABLE, which puts the secret back in `ps` on the bare path.
        `http_headers = { ${toml(TOKEN_HEADER)} = ${toml(token)} }`,
        '',
      ].join('\n'))
      writeSecretFile(path.join(cfgDir, 'hooks.json'), JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: stopHookCommand(daemonPort, worker, daemonHost, token) }] }] },
      }, null, 2))
    },
  },
}

// A config file the WATCHED REPO carries, which curia does not write and cannot
// vouch for. Returns the offending path, or null. One exposure per lane, same
// shape on both: a file the harness loads without a prompt, whose hooks would
// run unreviewed, with no model in the loop. A worker already runs with
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
export function untrustedProjectConfig(wtPath, backend) {
  const planted = backend === 'codex'
    ? path.join(wtPath, '.codex', 'hooks.json')
    : path.join(wtPath, '.claude', 'settings.local.json')
  return fs.existsSync(planted) ? planted : null
}

// The skill set a worker gets (#57, decision 1 of #49). Before this, a worker
// had NO skills at all, so the spawn prompt was the whole of its wayfinder
// knowledge — which is why restating skill doctrine in the prompt was the
// wrong fix and installing the real skills is the right one.
//
// Deliberately absent: to-tickets, triage, to-spec, handoff — the
// charting-and-PM side, and to-tickets is mass ticket creation in the hands of
// a worker that now carries charting authority (#49).
//
// `wayfinder` and `implement` carry `disable-model-invocation: true`, so they
// are neither listed to the model nor reachable through its Skill tool — the
// call comes back "cannot be used with Skill tool". Installing them is still
// required, because a prompt whose FIRST LINE is `/wayfinder` does load the
// skill (verified live); naming a skill in prose does not. That is a
// constraint on the spawn prompt (#54), not on this list.
export const DEFAULT_SKILLS = [
  'wayfinder', 'grilling', 'domain-modeling', 'research', 'prototype',
  'implement', 'tdd', 'code-review', 'diagnosing-bugs',
]

// The host's skills root. ~/.claude/skills is where Claude Code looks, and on
// this host every entry there is already a symlink into ~/.agents/skills — one
// more level of indirection changes nothing, since the worker only ever reads.
export function defaultSkillsRoot() {
  return path.join(os.homedir(), '.claude', 'skills')
}

// <cfgDir>/skills/<name> → <root>/<name>, symlinked rather than copied: a
// worker never writes a skill, so versions track the host with no snapshot to
// go stale. That is the exact opposite of the credential case (#53), where the
// worker DOES write and a symlink was replaced by a regular file — read-only
// is what makes the link safe here.
//
// Rebuilt from nothing on every seed: a config dir reused across dispatches
// must not keep a link to a skill that has since left the list, and a dangling
// link to a skill removed from the host must not survive either.
//
// A CONTAINER gets copies instead (#156). The link points at a host path the
// container does not mount, and on this box that path is itself a link into
// `~/.agents/skills`, so mounting the skills root would only move the dangling
// link one level. A worker with silently no skills is #57's own failure, so the
// tree is dereferenced and copied — a few hundred kilobytes per worker, and it
// cannot go stale inside one ticket.
export function installSkills(cfgDir, skills, { copy = false } = {}) {
  const dir = path.join(cfgDir, 'skills')
  fs.rmSync(dir, { recursive: true, force: true })
  const names = skills?.install ?? []
  if (!names.length) return []
  fs.mkdirSync(dir, { recursive: true })
  for (const name of names) {
    const src = path.join(skills.root, name)
    // Config load already proved these exist, but the host can change under a
    // running daemon. Refusing here costs one dispatch; the alternative is a
    // worker that silently lacks the skill it was dispatched to use, which is
    // the failure this whole ticket exists to end.
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
      throw new Error(`skill "${name}" has no SKILL.md under ${skills.root} — refusing to spawn a worker without its configured skill set`)
    }
    if (copy) fs.cpSync(src, path.join(dir, name), { recursive: true, dereference: true })
    else fs.symlinkSync(src, path.join(dir, name), 'dir')
  }
  return names
}

// Pre-seed the per-worker config dir so no first-spawn dialog ever appears.
// Backend-specific settings come from the HARNESS table; the two things every
// backend gets are the skill set and a swept credential file.
//
// `skills` is the validated config section ({ root, install }); omitting it
// installs nothing, which is what every test double and every caller with no
// skills configured gets.
//
// `wtPath` is the worktree AS THE WORKER SEES IT (#156): the claude seed writes
// it as a `projects` key, which Claude Code matches against its own cwd — and a
// container's cwd is the mount point, not the host path. Everything this
// function WRITES goes to `cfgDir`, which is always the host path.
export function seedConfigDir(cfgDir, wtPath, skills = null, backend = 'claude', { sandboxed = false } = {}) {
  const h = harnessFor(backend)
  fs.mkdirSync(cfgDir, { recursive: true })
  // No credential is COPIED here — every lane shares the host's own store
  // instead (#53). Sweep first: a cfg dir reused across dispatches, or from
  // before #53, could hold a real snapshot, and a stale copy that still parses
  // is worse than none because it is a *silent* return to the frozen-token
  // failure. The codex seed then puts its symlink back.
  removeCredentials(cfgDir)
  h.seed(cfgDir, wtPath)
  // The one deliberate narrowing of the no-host-config stance below (#133):
  // the operator's communication rules are mandatory for every agent, so a
  // curia-owned copy lands as the CLI's global-memory file. `CLAUDE.md` for
  // the claude lane, `AGENTS.md` for codex — each CLI's own name for it.
  fs.copyFileSync(VOICE_FILE, path.join(cfgDir, backend === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'))
  // One read-only directory, and nothing else from the host: no allowlist, no
  // MCP connectors, no saved permission mode (#23/#29). Both CLIs read
  // `<config dir>/skills/<name>/SKILL.md`, so #57's install is backend-blind —
  // a curia skill loaded and ran under codex unchanged.
  installSkills(cfgDir, skills, { copy: sandboxed })
}

// The curia side channel: the MCP server the worker's tools come from, and the
// Stop hook that enforces the ending (#54). Where it lands is the backend's
// business — see the HARNESS table.
//
// Three paths since #156, and they are not interchangeable. `hostWtPath` is
// where the claude lane's two files are WRITTEN. `wtPath` is the worktree as
// the worker sees it, which is what the codex lane's `[projects.<path>]` key
// must match. `daemonHost` is how the worker reaches back: loopback from a bare
// pane, the docker host gateway from a container.
export function writeHarness({
  wtPath, cfgDir, worker, ticket, daemonPort, backend = 'claude', reasoningEffort = null,
  hostWtPath = wtPath, daemonHost = LOOPBACK, token,
}) {
  // The harness is the ONLY way a worker learns its token (#159), so a caller
  // that forgot one would write a harness whose every call the daemon then
  // refuses. Asserted here rather than defaulted: there is no safe default.
  if (!/^[0-9a-f]{64}$/.test(String(token ?? ''))) {
    throw new Error(`refusing to write the ${worker} harness without a minted worker token — every call it makes would be refused`)
  }
  harnessFor(backend).harness({
    wtPath: backend === 'claude' ? hostWtPath : wtPath,
    cfgDir, worker, ticket, daemonPort, daemonHost, reasoningEffort, token,
  })
}

// Prompt file lives in the config dir, not the worktree.
//
// It supplies PARAMETERS, NOT PROCEDURE (#49 decision 2). Since #57 every worker
// carries the real skill set in its config dir, so the resolve protocol, the
// `gh` command lines, the `## Decisions so far` string and the pointer line's
// shape all left this function: the worker reads them from the skill it is
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
// THE FIRST LINE IS LOAD-BEARING (#57). `wayfinder` carries
// `disable-model-invocation: true`, so a model cannot reach it through the Skill
// tool at all — told to invoke it in prose the call comes back "cannot be used
// with Skill tool". A prompt whose first line is `/wayfinder` loads the full
// skill text. That is the only working form, verified both directions.
//
// `wtPath` here is the worktree AS THE WORKER SEES IT (#156). The prompt names
// it twice — the parameter block and the write bound — and both are read by a
// model that will `cd` there, so a container worker must be told its mount
// point rather than the host path behind it. The file itself is written to
// `cfgDir`, which is always the host path.
//
// `charting` (#160) is the map dispatch: the issue in hand IS the map, and the
// worker's job is to change it rather than to resolve a ticket under it. Three
// things move — the `/wayfinder` invocation carries no ticket, the params say
// what this dispatch is and what the operator asked for, and the ending is the
// charting one (lifecycle.mjs). Everything else — bounds, tools, the tracker
// line — is the same worker.
//
// `instruction` is the operator's own sentence, delivered HERE rather than on
// the worker-note queue. #149 called it "the worker's first note"; a note is
// drained by the next curia tool call, and a charting worker can read the whole
// map and start editing before it makes one. The prompt is the only channel
// that is guaranteed to arrive BEFORE the first turn, which is what "first"
// has to mean for an instruction that decides what the whole session does.
// The text is never shell-substituted — the spawn template reads this file with
// `$(cat …)` — so it needs no quoting rules of its own.
export function writePrompt(cfgDir, issue, { repo, wtPath, mapNumber = null, type = null, charting = false, instruction = null, ports = null }) {
  const promptFile = path.join(cfgDir, 'prompt.md')
  const n = issue.number
  const branch = branchFor(n)
  const ticketUrl = `https://github.com/${repo}/issues/${n}`
  const mapUrl = mapNumber ? `https://github.com/${repo}/issues/${mapNumber}` : null

  // A mapless ticket gets no `/wayfinder` line: the skill works THROUGH a map,
  // and invoking it with nothing to work through would invent one. The flat
  // ready-for-agent lane (#10) is exactly this case.
  //
  // A map dispatch names the map and NO ticket. That is the skill's "work
  // through the map" invocation, whose step 2 would pick a frontier ticket — so
  // the params below cancel that step in the same breath, under the standing
  // rule that curia's bounds beat the skill where they disagree. The skill is
  // still what has to load: fog of war, out of scope, ticket types, the map
  // body's shape and refer-by-name are all doctrine a charting worker needs and
  // curia does not restate.
  const invocation = mapNumber ? [`/wayfinder ${mapUrl}${charting ? '' : ` ticket #${n}`}`, ''] : []

  const chartingParams = [
    `- **This is a MAP DISPATCH.** ${repo}#${n} is the map itself, not a ticket under it. Your job is to`,
    '  CHANGE THE MAP: its body sections, and its child tickets. Do not choose a frontier ticket, and do',
    '  not resolve one. The skill\'s step "choose the ticket" does not apply to this session.',
    `- The map is ${repo}#${n} — ${ticketUrl}. curia has loaded it for you, and has assigned it to`,
    '  you while you work, so a second charting worker cannot edit it under you.',
    ...(instruction
      ? [
        '- **What the operator asked for**, in their own words:',
        '',
        `  > ${instruction}`,
        '',
        '  This is the whole brief. Do that, and no more than that. If it is unclear, or if doing it well',
        '  needs a decision that is theirs, use `ask_human` — one question at a time.',
      ]
      : [
        '- **No instruction rode this dispatch.** Do not guess what should change. Your FIRST act is one',
        '  `ask_human` call: what should change on this map? Then work from the answer.',
      ]),
  ]

  const params = charting ? chartingParams : [
    ...(mapNumber
      ? [`- The map is ${repo}#${mapNumber} — ${mapUrl}. curia has loaded it for you.`]
      : ['- This ticket belongs to no map, so there is no map to work through and no map line to append.']),
    `- The ticket is ${repo}#${n} — ${ticketUrl}. curia has already CLAIMED it in your name: you start at`,
    '  resolving it, not at choosing it.',
    ...(type
      ? [`- Ticket type: \`${type}\`. The skill's Ticket Types section says what that means for how you work it.`]
      : ['- This ticket carries no `wayfinder:` type label.']),
  ]

  // #157: a container reaches the box on three published ports and on nothing
  // else, so the numbers are a PARAMETER of this session — the worker cannot
  // discover them, and a dev server on any other port is invisible to the human
  // it was started for. `0.0.0.0` is said here rather than left to the CLI's
  // defaults: a server on `localhost` inside the container is unreachable from
  // the host, and it fails as a connection reset at the preview link rather than
  // as anything the worker can see (measured, #157).
  const portLines = ports?.length && !charting ? [
    `- You run inside a container. Its three preview ports are **${ports.join(', ')}**, the same numbers`,
    `  inside and out. A dev server must bind \`0.0.0.0\` on one of them — \`--host 0.0.0.0 --port ${ports[0]}\`,`,
    '  or whatever your framework calls that. A server on `localhost`, or on any other port, is reachable',
    '  by nothing outside this container, and `publish_preview` takes no other port.',
  ] : []

  const allParams = [
    `- The tracker is **GitHub**, repo \`${repo}\`, reached with the \`gh\` CLI. Do not fall back to a`,
    '  local-markdown tracker: this repo carries `docs/agents/issue-tracker.md`.',
    ...params,
    `- Your worktree is ${wtPath}, on branch \`${branch}\`.`,
    ...portLines,
  ]

  const bounds = [
    '- **Read anything.** Zoom into any issue, map, sibling or closed ticket you need. Nothing here limits',
    '  reading.',
    ...(charting
      ? [
        `- **Write only:** the map ${repo}#${n} and its child tickets. Nothing else on the tracker, and`,
        `  nothing on disk: ${wtPath} is a read-only checkout to you. A map dispatch produces no code, no`,
        '  commit and no branch.',
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
    // not tooling. A worker that "looks at" its own page and approves what it
    // sees has bypassed the human the review gate exists for — but a renderer
    // that happens to embed Chrome (remotion, a screenshot committed as a page
    // asset, HTML-to-PDF) is a build step writing a file, no different from a
    // compiler. The #114 worker was blocked from producing a demo video by the
    // old absolute wording.
    '- **A browser is a build tool, never a judge.** Headless browser use that renders an ARTIFACT is',
    '  allowed: `remotion render`, a screenshot committed as an asset, HTML-to-PDF. Using a browser to',
    '  view, verify or approve your own work is forbidden — you never judge rendered output by looking',
    '  at it. `publish_preview` is how a HUMAN looks at a page, and their eyes are the only ones that',
    '  pass it.',
    '- A HITL ticket is many `ask_human` calls, one question at a time. **Never answer for the human.**',
    // #56: a daemon crash took an in-flight ask_human down with it, and the worker
    // read the transport error as permission to decide the question itself. A
    // failed call is the one case where "never answer for the human" has to be
    // said again, because the failure looks like an answer arriving empty.
    '- **A failed `curia` tool call is not an answer.** If a call returns an error instead of a human reply,',
    '  make the same call once more: curia routes the human to whichever call is live. If it fails again,',
    '  stop and end your turn — say what you were asking. Never treat an unanswered question as answered,',
    '  and never decide it yourself because the tool broke.',
    // Written by the #56 live check, whose worker blocked for 7h53m and reported
    // that the rule above would never have fired: nothing broke. What pushed it
    // toward answering was silence plus a plausible story, and the low stakes of
    // the question — "nobody audits a heading".
    '- **Silence is not an answer either.** `ask_human` blocks for as long as the human takes, and hours',
    '  are normal. A slow, backgrounded or quiet call is still open: keep waiting. Never let a story about',
    '  why nobody replied — the daemon must be dead, they must be asleep — stand in for the reply. This',
    '  holds hardest on small questions, because a wrong answer to a small one is the one nobody checks.',
    '- Where a skill and these bounds disagree, these win.',
  ]

  const tools = charting ? [
    '- `ask_human` — a decision you cannot make alone. Blocks until a human answers, for as long as it',
    '  takes. This is how you reach the operator who dispatched you.',
    '- `notify` — a status line for the human. Returns at once.',
    '- `report_result` — exactly once, at the very end. Its summary becomes curia\'s comment on the map.',
    '- `open_pull_request`, `request_review` and `publish_preview` belong to a ticket dispatch. curia',
    '  refuses the first two on a map dispatch, and there is nothing here to preview.',
  ] : [
    '- `ask_human` — a decision you cannot make alone. Blocks until a human answers, for as long as it',
    '  takes.',
    '- `notify` — a status line for the human. Returns at once.',
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
    '- `report_result` — exactly once, at the very end.',
  ]

  const body = [
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
    '## Bounds (curia daemon)',
    '',
    ...bounds,
    '',
    '## Your tools (the `curia` MCP server)',
    '',
    ...tools,
    '',
    '## How this ends',
    '',
    ...endingProse({ repo, ticket: n, branch, mapNumber, charting }),
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
    '',
  ].join('\n')
  fs.writeFileSync(promptFile, body)
  return promptFile
}

// Daemon-owned workspaces (#33 step 6). Layout under workspace_root:
//   repos/<owner>__<repo>/base   — shared base clone (push-disabled)
//   repos/<owner>__<repo>/wt/<n> — per-ticket worktrees
//   cfg/curia-<n>                — per-worker CLAUDE_CONFIG_DIR (+ prompt file)
// Never Alp's working tree; nothing here is authoritative state.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileP } from './exec.mjs'

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

// Fresh worktree on branch curia/<n> off origin's default branch. -B force-
// resets a stale branch on re-dispatch; a stale worktree registration at the
// same path is removed first (worktree add refuses an existing path).
export async function createWorktree(base, n) {
  const wt = path.join(path.dirname(base), 'wt', String(n))
  const defaultBranch = await defaultBranchOf(base)
  if (fs.existsSync(wt)) {
    await git(base, ['worktree', 'remove', '--force', wt]).catch(() => {})
    fs.rmSync(wt, { recursive: true, force: true })
  }
  await git(base, ['worktree', 'prune'])
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  await git(base, ['worktree', 'add', '-B', branchFor(n), wt, `origin/${defaultBranch}`])
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
export async function removeWorktree(base, wtPath) {
  await git(base, ['worktree', 'remove', '--force', wtPath])
}

// The config dir holds a copy of the host OAuth refresh token, so it needs a
// deletion owner. Full removal where the worktree is destroyed
// anyway (cancel, orphan sweep); credentials-only where the workspace is kept
// for review (lifecycle close) so prompt.md survives the post-mortem.
export function removeConfigDir(cfgDir) {
  fs.rmSync(cfgDir, { recursive: true, force: true })
}

export function removeCredentials(cfgDir) {
  fs.rmSync(path.join(cfgDir, '.credentials.json'), { force: true })
}

// Pre-seed the per-worker CLAUDE_CONFIG_DIR so no first-spawn dialog ever
// appears — exact prototype.md §1 shape, verified live. The projects key MUST
// be the absolute worktree path (matched exactly).
export function seedConfigDir(cfgDir, wtPath) {
  fs.mkdirSync(cfgDir, { recursive: true })
  const claudeJson = {
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
  }
  fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify(claudeJson, null, 2))
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2))
  const hostCreds = path.join(os.homedir(), '.claude', '.credentials.json')
  const dest = path.join(cfgDir, '.credentials.json')
  fs.copyFileSync(hostCreds, dest)
  fs.chmodSync(dest, 0o600)
}

// Workspace harness: .mcp.json (curia HTTP MCP side channel) + .claude/settings.json
// (all-project MCP on, bypass permissions, Stop hook → /worker_done) — spike
// #29 shapes with per-worker substitution.
export function writeHarness(wtPath, worker, ticket, daemonPort) {
  fs.writeFileSync(path.join(wtPath, '.mcp.json'), JSON.stringify({
    mcpServers: {
      curia: {
        type: 'http',
        url: `http://127.0.0.1:${daemonPort}/mcp?worker=${worker}&ticket=${ticket}`,
      },
    },
  }, null, 2))
  const dotClaude = path.join(wtPath, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  fs.writeFileSync(path.join(dotClaude, 'settings.json'), JSON.stringify({
    enableAllProjectMcpServers: true,
    permissions: { defaultMode: 'bypassPermissions' },
    hooks: {
      Stop: [{
        hooks: [{
          type: 'command',
          command: `curl -s -X POST 'http://127.0.0.1:${daemonPort}/worker_done?worker=${worker}' -H 'Content-Type: application/json' -d @-`,
        }],
      }],
    },
  }, null, 2))
}

// Prompt file lives in the config dir, not the worktree. Ticket title/body +
// the standing orders: the resolve protocol (#41), never push, report_result
// exactly once, then stop.
//
// The resolve protocol is spelled out INLINE rather than by reference to
// `docs/agents/issue-tracker.md`: the worktree is the watched repo's, and most
// watched repos carry no such doc. It is deliberately the tracker's ordinary
// idiom — `gh` — because that is what the wayfinder skill does at the end of a
// session; a curia-specific resolve path would put every ticket prompt at odds
// with the skill the ticket came from (#7). The daemon verifies and repairs
// afterwards (resolve.mjs), which is why an honest report_result matters more
// here than a flawless protocol run.
export function writePrompt(cfgDir, issue, { repo, wtPath, mapNumber = null }) {
  const promptFile = path.join(cfgDir, 'prompt.md')
  const n = issue.number
  const mapStep = mapNumber
    ? [
      `  3. Append ONE line to the \`## Decisions so far\` section of the parent map ${repo}#${mapNumber}:`,
      `     \`- [${issue.title}](https://github.com/${repo}/issues/${n}) — <one-line gist of the answer>\``,
      '     Read the map body, insert the line at the END of that section, write it back, then re-read',
      '     and confirm your line is there — another worker may be editing the same body at the same time.',
    ]
    : ['  3. This ticket has no parent map, so there is no Decisions-so-far line to append.']
  const body = [
    `# ${repo}#${n}: ${issue.title}`,
    '',
    issue.body ?? '(no body)',
    '',
    '---',
    '',
    '## Standing orders (curia daemon)',
    '',
    `- Work ONLY inside this worktree: ${wtPath}. Never touch anything outside it.`,
    `- Commit your work locally on the current branch (\`${branchFor(n)}\`). NEVER push, and never open a`,
    '  pull request: curia pushes the branch and opens the PR itself once you report a clean result.',
    '- When the work is done, resolve the ticket the ordinary way, with `gh`:',
    `  1. \`gh issue comment ${n} --repo ${repo}\` — the resolution: what the answer is and why.`,
    `  2. \`gh issue close ${n} --repo ${repo}\``,
    ...mapStep,
    '  Touch NOTHING else on the tracker: no other issue, no labels, no other section of the map, no',
    "  rewriting of anyone else's text. Leave the assignee alone — that claim is curia's record of who",
    '  did this work.',
    '- Then call the `report_result` tool on the `curia` MCP server exactly once',
    `  (ticket: "${n}") with an honest status and summary, and stop. curia verifies the steps above and`,
    '  repairs anything missing, so an honest summary matters more than a perfect protocol run.',
    '- If you are blocked, call `report_result` with status "blocked" — do NOT comment-and-close a ticket',
    '  you did not actually resolve. Use `ask_human` for a decision you cannot make alone.',
    '',
  ].join('\n')
  fs.writeFileSync(promptFile, body)
  return promptFile
}

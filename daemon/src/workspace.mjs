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

// Fresh worktree on branch curia/<n> off origin's default branch. -B force-
// resets a stale branch on re-dispatch; a stale worktree registration at the
// same path is removed first (worktree add refuses an existing path).
export async function createWorktree(base, n) {
  const wt = path.join(path.dirname(base), 'wt', String(n))
  const { stdout } = await git(base, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  const defaultBranch = stdout.trim().replace('refs/remotes/origin/', '')
  if (fs.existsSync(wt)) {
    await git(base, ['worktree', 'remove', '--force', wt]).catch(() => {})
    fs.rmSync(wt, { recursive: true, force: true })
  }
  await git(base, ['worktree', 'prune'])
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  await git(base, ['worktree', 'add', '-B', `curia/${n}`, wt, `origin/${defaultBranch}`])
  return wt
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
// the standing orders (never push; report_result exactly once; then stop).
export function writePrompt(cfgDir, issue, { repo, wtPath }) {
  const promptFile = path.join(cfgDir, 'prompt.md')
  const body = [
    `# ${repo}#${issue.number}: ${issue.title}`,
    '',
    issue.body ?? '(no body)',
    '',
    '---',
    '',
    '## Standing orders (curia daemon)',
    '',
    `- Work ONLY inside this worktree: ${wtPath}. Never touch anything outside it.`,
    '- Commit your work locally on the current branch. NEVER push to any remote, under any circumstances.',
    '- When the work is done, call the `report_result` tool on the `curia` MCP server exactly once',
    `  (ticket: "${issue.number}") with an honest status and summary, then stop.`,
    '- If you are blocked, call `report_result` with status "blocked" instead of guessing — or use',
    '  `ask_human` for a decision you cannot make alone.',
    '',
  ].join('\n')
  fs.writeFileSync(promptFile, body)
  return promptFile
}

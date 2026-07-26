// Daemon-owned workspaces (#33 step 6). Layout under workspace_root:
//   repos/<owner>__<repo>/base   — shared base clone (push-disabled)
//   repos/<owner>__<repo>/wt/<n> — per-ticket worktrees
//   cfg/curia-<n>                — per-worker CLAUDE_CONFIG_DIR (+ prompt file);
//                                  holds no credential of its own since #53
// Never Alp's working tree; nothing here is authoritative state.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileP } from './exec.mjs'
import { endingProse } from './lifecycle.mjs'

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
export async function removeWorktree(base, wtPath) {
  await git(base, ['worktree', 'remove', '--force', wtPath])
}

// Full removal where the worktree is destroyed anyway (cancel, orphan sweep);
// credentials-only where the workspace is kept for review (lifecycle close) so
// prompt.md survives the post-mortem. Since #53 a worker's config dir holds no
// credential of its own, so removeCredentials collects only pre-#53 leftovers —
// kept because those copies are real host refresh tokens sitting on disk.
export function removeConfigDir(cfgDir) {
  fs.rmSync(cfgDir, { recursive: true, force: true })
}

export function removeCredentials(cfgDir) {
  fs.rmSync(path.join(cfgDir, '.credentials.json'), { force: true })
}

// Where the host's own credential store lives — the single file every worker
// shares (#53).
export function hostStorageDir() {
  return path.join(os.homedir(), '.claude')
}

// The whole per-worker env: config isolated, credentials shared.
//
// CLAUDE_SECURESTORAGE_CONFIG_DIR is what separates the two. Claude Code
// resolves its credential store through it and falls back to CLAUDE_CONFIG_DIR
// only when it is unset, so pointing it at the host's ~/.claude puts the worker
// on the host's *exact* credentials path — the same file, the same refresh
// lineage, the same atomic-rename write. That is precisely what a second host
// session does, which is why several host sessions coexist for days while a
// worker holding a frozen copy died at the first host-side refresh (#34).
// Everything else stays isolated by CLAUDE_CONFIG_DIR: settings, allowlist,
// permission mode, CLAUDE.md, MCP connectors, projects (#23/#29).
//
// An absolute path, not the empty string that also selects ~/.claude: explicit
// beats HOME-dependent, and `env K=` through tmux is a needless edge. Porting
// to macOS would want the empty form instead — a non-empty value also suffixes
// the keychain service name, which would break sharing where the keychain, not
// the plaintext file, is the store.
export function workerEnv(cfgDir) {
  return { CLAUDE_CONFIG_DIR: cfgDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: hostStorageDir() }
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
export function installSkills(cfgDir, skills) {
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
    fs.symlinkSync(src, path.join(dir, name), 'dir')
  }
  return names
}

// Pre-seed the per-worker CLAUDE_CONFIG_DIR so no first-spawn dialog ever
// appears — exact prototype.md §1 shape, verified live. The projects key MUST
// be the absolute worktree path (matched exactly).
//
// `skills` is the validated config section ({ root, install }); omitting it
// installs nothing, which is what every test double and every caller with no
// skills configured gets.
export function seedConfigDir(cfgDir, wtPath, skills = null) {
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
  // No credential is written here — workerEnv shares the host store instead
  // (#53). Unlink defensively: a cfg dir reused from before #53 could still
  // hold a snapshot, and a stale copy that still parses is worse than none,
  // because it would be a *silent* return to the frozen-token failure.
  fs.rmSync(path.join(cfgDir, '.credentials.json'), { force: true })
  // One read-only directory, and nothing else from the host: no CLAUDE.md, no
  // allowlist, no MCP connectors, no saved permission mode (#23/#29).
  installSkills(cfgDir, skills)
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
export function writePrompt(cfgDir, issue, { repo, wtPath, mapNumber = null, type = null }) {
  const promptFile = path.join(cfgDir, 'prompt.md')
  const n = issue.number
  const branch = branchFor(n)
  const ticketUrl = `https://github.com/${repo}/issues/${n}`
  const mapUrl = mapNumber ? `https://github.com/${repo}/issues/${mapNumber}` : null

  // A mapless ticket gets no `/wayfinder` line: the skill works THROUGH a map,
  // and invoking it with nothing to work through would invent one. The flat
  // ready-for-agent lane (#10) is exactly this case.
  const invocation = mapNumber ? [`/wayfinder ${mapUrl} ticket #${n}`, ''] : []

  const params = [
    `- The tracker is **GitHub**, repo \`${repo}\`, reached with the \`gh\` CLI. Do not fall back to a`,
    '  local-markdown tracker: this repo carries `docs/agents/issue-tracker.md`.',
    ...(mapNumber
      ? [`- The map is ${repo}#${mapNumber} — ${mapUrl}. curia has loaded it for you.`]
      : ['- This ticket belongs to no map, so there is no map to work through and no map line to append.']),
    `- The ticket is ${repo}#${n} — ${ticketUrl}. curia has already CLAIMED it in your name: you start at`,
    '  resolving it, not at choosing it.',
    ...(type
      ? [`- Ticket type: \`${type}\`. The skill's Ticket Types section says what that means for how you work it.`]
      : ['- This ticket carries no `wayfinder:` type label.']),
    `- Your worktree is ${wtPath}, on branch \`${branch}\`.`,
  ]

  const bounds = [
    '- **Read anything.** Zoom into any issue, map, sibling or closed ticket you need. Nothing here limits',
    '  reading.',
    `- **Write only:** files inside ${wtPath}; this ticket;${mapNumber ? ` the map ${repo}#${mapNumber} and its children;` : ''}`,
    '  and the one merge a human has just approved. Nothing else on the tracker, and nothing outside the',
    '  worktree on disk.',
    "- Leave the assignee alone, and do not rewrite anyone else's text. That claim is curia's record of who",
    '  did this work.',
    '- **You have no browser and must not build one** — no headless Chrome, no Playwright, no screenshot',
    '  driver. `publish_preview` is how a human looks at a page.',
    '- A HITL ticket is many `ask_human` calls, one question at a time. **Never answer for the human.**',
    '- Where a skill and these bounds disagree, these win.',
  ]

  const tools = [
    '- `ask_human` — a decision you cannot make alone. Blocks until a human answers, for as long as it',
    '  takes.',
    '- `notify` — a status line for the human. Returns at once.',
    '- `publish_preview` — publish a dev server you have started on localhost as an HTTPS link. Start the',
    '  server FIRST, then call this with the port it bound.',
    '- `open_pull_request` — curia pushes your branch and opens or updates the pull request. You never push.',
    '- `request_review` — the one gate. curia shows the human the pull request, the preview, the ticket and',
    '  your proposed charting, and blocks until they approve or reject.',
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
    ...params,
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
    ...endingProse({ repo, ticket: n, branch, mapNumber }),
    '',
    '- If you cannot finish, call `report_result` with status `blocked` and say why. Never comment-and-close',
    '  a ticket you did not resolve.',
    '- curia holds you at this ending: its Stop hook refuses your stop while a step is outstanding, and',
    '  tells you which one. It also verifies the resolution afterwards and repairs what is missing, so an',
    '  honest `report_result` matters more than a perfect run.',
    '',
  ].join('\n')
  fs.writeFileSync(promptFile, body)
  return promptFile
}

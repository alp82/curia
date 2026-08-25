// All GitHub access for the dispatch loop (#33 step 4) — every call is a `gh`
// child process (execFile, no shell), plus the pure filter/selection functions
// the frontier tests pin.
//
// Payload shapes (field-notes v2, verified live): `labels` and `assignees` are
// arrays of OBJECTS — `.labels[].name`, `.assignees[].login`. The flat
// ready-for-agent lane returns PRs too (shared number space), so anything
// carrying a `pull_request` key is dropped. `sub_issues` pages at 30 —
// --paginate is mandatory.
//
// WHO EACH CALL RUNS AS (#390, ADR-0018). Every function below that names a repo
// passes it to `gh`, which mints that owner's token and puts it in the child's
// environment — so the daemon reads the frontier, claims, comments, closes,
// opens pull requests and deletes branches as `curia-sh[bot]`. A call that names
// NO repo gets no token and keeps the host login. There are three of those. Two
// are account-wide questions an installation token cannot answer: `viewerLogin`
// and the settings screen's `user/repos` read. The third is the gate approval
// (#391), which names a repo and keeps the host login anyway, because the
// approval is the OPERATOR's and an app cannot post one for them. See
// daemongh.mjs and `approvePullRequest`.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileP } from './exec.mjs'
import { daemonGhEnv } from './daemongh.mjs'

export async function gh(args, { repo = null } = {}) {
  const { stdout } = await execFileP('gh', args, {
    maxBuffer: 32 * 1024 * 1024,
    env: await daemonGhEnv(repo),
  })
  return stdout
}

// `gh api … --jq '.[]'` emits compact one-object-per-line output (verified live).
export async function ghJSONL(args, opts) {
  const out = await gh(args, opts)
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

// The HOST login's own name, and the last daemon call that asks for one.
//
// It is deliberately unrouted: `gh api user` answers nothing under an
// installation token, because an app is not a user. What it serves is the
// settings screen's repo picker — "which repos can the operator watch" — which
// is an account-wide question about a person, so the person's own login is the
// right credential and the only one that works.
//
// It is NOT the claim any more. A claim is an issue assignee and GitHub does not
// let an app be one, so the daemon assigns `dispatch.claim_login` from
// `config/curia.yaml` instead (#390).
let cachedLogin = null
export async function viewerLogin() {
  if (!cachedLogin) cachedLogin = (await gh(['api', 'user', '--jq', '.login'])).trim()
  return cachedLogin
}

// All wayfinder maps, open AND closed — selectLane needs the closed ones to
// tell "all maps closed ⇒ empty" apart from "no maps ⇒ flat".
export function repoMaps(repo) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues?labels=wayfinder:map&state=all&per_page=100`, '--jq', '.[]'], { repo })
}

// Unfiltered sub-issues of one map.
export function mapFrontier(repo, mapNo) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues/${mapNo}/sub_issues`, '--jq', '.[]'], { repo })
}

// Unfiltered open ready-for-agent items (PRs included — filterTakeable drops them).
export function flatFrontier(repo) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues?labels=ready-for-agent&state=open&per_page=100`, '--jq', '.[]'], { repo })
}

// Lazy full issue (body included) at dispatch time.
export async function fetchIssue(repo, n) {
  return JSON.parse(await gh(['api', `repos/${repo}/issues/${n}`], { repo }))
}

// The login assigned here is the operator's, not the caller's (#390). The daemon
// runs this call as the bot and names a real user, because GitHub does not let
// an app be an assignee. `dispatch.claim_login` is where that name comes from.
export async function claim(repo, n, login) {
  await gh(['issue', 'edit', String(n), '--repo', repo, '--add-assignee', login], { repo })
}

export async function unclaim(repo, n, login) {
  await gh(['issue', 'edit', String(n), '--repo', repo, '--remove-assignee', login], { repo })
}

// ---- resolve protocol + landing (#41) ---------------------------------------
//
// The AGENT runs the resolve protocol itself, with its own `gh` — that is what
// the wayfinder skill already does at the end of a session. Everything below
// exists so the daemon can VERIFY that afterwards and repair what is missing,
// and so it can land the code (push + PR) without the agent ever holding that
// authority. See resolve.mjs for the division of labour.

// Long markdown never travels in argv: a resolution comment or a whole map body
// can run past the per-argument limit, and a file also keeps the text out of
// `ps`. Every write below goes through --body-file for that reason.
async function withBodyFile(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-gh-'))
  try {
    const file = path.join(dir, 'body.md')
    fs.writeFileSync(file, body)
    return await fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function commentIssue(repo, n, body) {
  return withBodyFile(body, (f) => gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', f], { repo }))
}

export async function closeIssue(repo, n) {
  await gh(['issue', 'close', String(n), '--repo', repo], { repo })
}

export function setIssueBody(repo, n, body) {
  return withBodyFile(body, (f) => gh(['issue', 'edit', String(n), '--repo', repo, '--body-file', f], { repo }))
}

export function issueComments(repo, n) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues/${n}/comments?per_page=100`, '--jq', '.[]'], { repo })
}

// The open issues blocking one ticket — number and state per blocker, the
// same native-dependency edge the tracker doc writes with POST. Only called
// for tickets whose summary says blocked_by > 0.
export function blockedByOf(repo, n) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues/${n}/dependencies/blocked_by`, '--jq', '.[]'], { repo })
}

// The sub-issue parent, straight off the issue payload — `parent_issue_url` is
// present on children and absent on everything else (verified live). One read,
// instead of scanning every map's sub_issues for this number.
export function parentNumberOf(issue) {
  const m = String(issue?.parent_issue_url ?? '').match(/\/issues\/(\d+)$/)
  return m ? Number(m[1]) : null
}

export function hasLabel(issue, name) {
  return (issue?.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === name)
}

// A re-dispatched ticket may already have a PR for its branch; `gh pr create`
// fails on that, so the landing step reuses instead. Prefers an open PR over a
// closed/merged one from an earlier run.
export async function findPullRequest(repo, head) {
  const list = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--head', head, '--state', 'all', '--json', 'number,url,state'], { repo }))
  return list.find((p) => p.state === 'OPEN') ?? list[0] ?? null
}

// The pull request's own unified diff (#355). The FALLBACK for the hunks the
// console asks for: the worktree is the source while it exists, and a gate
// whose agent has died and had its workspace swept still has a diff to show as
// long as the pull request is known. It is a network read, so nothing on the
// poll path may call it — only a card the operator opened.
export function pullRequestDiff(repo, n) {
  return gh(['pr', 'diff', String(n), '--repo', repo, '--patch'], { repo })
}

// Prints the PR URL on success.
//
// This is the call the gate cutover waits on (#390). The pull request is
// authored by whoever runs it, so under a minted token it is `curia-sh[bot]`'s —
// and an operator approving it is then a real GitHub approval by a different
// account, which is what makes branch protection usable at all.
export async function createPullRequest(repo, { head, base, title, body }) {
  const out = await withBodyFile(body, (f) => gh([
    'pr', 'create', '--repo', repo, '--head', head, '--base', base, '--title', title, '--body-file', f,
  ], { repo }))
  return out.trim().split('\n').filter(Boolean).at(-1) ?? ''
}

// The gate press, as a real GitHub approval (#391, ADR-0018).
//
// THE ONE `gh` CALL THAT KEEPS THE HOST LOGIN ON PURPOSE, and the reason the
// host login did not retreat whole with #390. Two facts make it that way:
//
//   - An app cannot approve for a human. A review submitted under a minted
//     token is `curia-sh[bot]`'s, and the pull request is `curia-sh[bot]`'s
//     too since #390 — so it is a self-approval, which GitHub refuses.
//   - The operator IS the reviewer. The ✅ press is their judgement, and the
//     approval that records it must carry their own account.
//
// So `repo` is deliberately NOT passed to `gh()`. The `--repo` flag names the
// repository for the CLI, and the option object is what routes a token — see
// daemongh.mjs, where a call with no repo gets no token and inherits the
// operator's `~/.config/gh`.
//
// It throws on every failure, and the gate reads the throw as "not approved"
// rather than as an approval it could not post.
export function approvePullRequest(repo, n) {
  return gh(['pr', 'review', String(n), '--repo', repo, '--approve'])
}

// Replace an open PR's body in place — the rejection loop opens one pull request
// and updates it, rather than a new one per round (#54 item 1).
export function setPullRequestBody(repo, n, body) {
  return withBodyFile(body, (f) => gh(['pr', 'edit', String(n), '--repo', repo, '--body-file', f], { repo }))
}

// Merge ends the workspace lease (#54 item 7), and `gh pr merge --delete-branch`
// is what the AGENT runs. This is the daemon's repair for the branch it left
// behind. A missing ref is positive absence, not a failure: the agent's own
// merge already deleted it, which is the expected case.
export async function deleteRemoteBranch(repo, branch) {
  try {
    await gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`], { repo })
    return { deleted: true }
  } catch (e) {
    if (/HTTP 404|Not Found|Reference does not exist/i.test(e.message)) return { deleted: false, absent: true }
    throw e
  }
}

// ---- the boot probe for a scoped token (#155, #313) — RETIRED by #466 --------
//
// `probeRepoToken` and `tokenExpiryDays` lived here. They read one repo with the
// PAT that repo would be reached with, and they read the expiry header off the
// same answer. Both holders they served are gone: the overseer's PAT retired on
// #392 and the agents' on #466, so nothing on the box holds a token with an
// expiry or a hand-made repository list.
//
// The reach question survives and it is asked elsewhere now. A token probe could
// never see a PUBLIC repo missing from the grant, because every fine-grained PAT
// and every installation token reads public repositories. So the watch asks the
// installation which repos it covers instead — `listInstallationRepos` in
// githubapp.mjs, and the note in tokenwatch.mjs.

// ---- pure filter/selection surface (frontier.test.mjs) ----------------------

// Takeable = open, unassigned, unblocked, and not a PR. Absent
// issue_dependencies_summary means unblocked — defensive hardening for shapes
// that do not carry the summary (field-notes v2).
export function filterTakeable(items) {
  return items.filter((i) =>
    i.state === 'open'
    && !i.pull_request
    && (i.issue_dependencies_summary?.blocked_by ?? 0) === 0
    && (i.assignees ?? []).length === 0)
}

// Lane selection per watch-entry mode (settled answer 3).
//   auto: any map at all ⇒ map lane over open non-deferred maps; all deferred
//         or all closed ⇒ EMPTY, never a flat fallback (the conservative rule);
//         no maps at all ⇒ flat.
//   map / ready-for-agent: force that lane.
export function selectLane(maps, mode = 'auto') {
  if (mode === 'ready-for-agent') return { lane: 'flat', maps: [] }
  const active = maps.filter((m) =>
    m.state === 'open' && !(m.labels ?? []).some((l) => l.name === 'wayfinder:deferred'))
  if (mode === 'map') return { lane: 'map', maps: active.map((m) => m.number) }
  if (!maps.length) return { lane: 'flat', maps: [] }
  if (!active.length) return { lane: 'empty', maps: [] }
  return { lane: 'map', maps: active.map((m) => m.number) }
}

// The stranded map (#485): open, not deferred, with at least one child and
// every child closed. No dispatch ever fires on it again — no open child
// remains — so without a watch nobody would ever say so (#316 sat that way
// for days). At least one child, because a new-map session creates the map
// moments before its first tickets, and that window must not alarm.
export function strandedMaps(maps = [], mapItems = {}) {
  return maps
    .filter((m) => m.state === 'open' && !(m.labels ?? []).some((l) => l.name === 'wayfinder:deferred'))
    .filter((m) => {
      const children = mapItems[m.number] ?? []
      return children.length > 0 && children.every((c) => c.state === 'closed')
    })
    .map((m) => ({ number: m.number, title: m.title ?? '' }))
}

// The verb an empty-map question carries on its confirm record (#698). It is
// the one word `onConfirmAnswered` dispatches on, and the one word the boot
// sweep reads to leave this record standing.
export const MAP_CLOSE_VERB = 'map_close'

// The question curia asks about one empty map (#698). It replaced the plain
// alarm line #485 said: an alarm states a fact and waits for someone to act on
// it, and #316 proved that nobody does. This asks for a VERDICT, and the
// operator's answer is what closes the map.
//
// The fog rides in the question because it is what the answer is about. An
// operator reading the card on a phone must not have to open the map to see
// what is still uncertain, and a map with no fog says so in as many words — a
// silent absence and an absence nobody looked for read the same.
export function emptyMapVerdictPrompt(repo, { number, title }, fog = []) {
  const head = `Map ${repo}#${number} “${title}” has no open ticket left. Is the way walked — does no work remain?`
  const body = fog.length
    ? [`Still under Not yet specified (${fog.length}):`, ...fog.map((f) => `• ${f.text ?? f}`)]
    : ['Nothing stands under Not yet specified.']
  const tail = '✅ posts the verdict and closes the map. ❌ leaves it open, and I stop asking.'
  return [head, '', ...body, '', tail].join('\n')
}

// What still holds an empty map open at the moment the operator approves the
// close (#698). The question was asked off a frontier read that may be minutes
// old, so the answer is checked against the map as it stands NOW: a child
// reopened, fog written, or the map paused since the card went out all mean the
// close the operator approved is no longer the close curia would make.
//
// Returns the reasons as sentences, gravest first. Empty means close it.
export function mapCloseBlockers({ state = 'open', labels = [], children = [], fog = [] } = {}) {
  const held = []
  if (state !== 'open') held.push('the map is already closed')
  if ((labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'wayfinder:deferred')) {
    held.push('the map is paused (`wayfinder:deferred`), and a pause is only ever ended by hand')
  }
  const open = (children ?? []).filter((c) => !c.pull_request && c.state === 'open')
  if (open.length) {
    held.push(`${open.length} child ticket(s) reopened or arrived: ${open.map((c) => `#${c.number}`).join(', ')}`)
  }
  if ((fog ?? []).length) {
    held.push(`${fog.length} line(s) still stand under Not yet specified: ${fog.map((f) => f.text ?? f).join('; ')}`)
  }
  return held
}

// The comment curia posts on the map when the operator says the way is walked.
export function mapClosedComment() {
  return [
    '✅ **Closed on the operator’s verdict.** No open child ticket remains, and nothing stands under Not yet specified.',
    '',
    '-# curia asked whether any work remained, the operator answered no, and this map closed on that answer.',
  ].join('\n')
}

// The comment curia posts when the operator says work remains, and when the
// approved close is refused by what the map says now. Both are verdicts, and
// both leave the map open — so both are written down, because a map that stays
// open for a reason nobody recorded is exactly what #316 was.
export function mapHeldComment(reasons) {
  return [
    '⏸️ **This map stays open.** It has no open child ticket, and curia asked whether the way is walked.',
    '',
    ...reasons.map((r) => `- ${r}`),
    '',
    '-# curia will not ask again until this map gains an open child and empties once more.',
  ].join('\n')
}

// The HITL-free chain count (#81's tickets view): how many open tickets an
// agent could work through with no human in the loop — takeable now, or
// unblocked purely by chains of other HITL-free tickets. `research` and `task`
// are counted as HITL-free (a task ticket CAN need a human, but the type says
// the agent drives it alone where it can — optimistic by design); `grilling`
// and `prototype` are human-in-the-loop; an untyped map child counts as HITL
// (conservative). Blocker edges come from `edges[number]` as
// [{ number, state }]; an open item whose summary says blocked_by > 0 but has
// no edge entry is treated as blocked (an unreadable edge is not an open way).
export function agentOnlyChainCount({ items = [], edges = {} } = {}) {
  const hitlFree = (i) => (i.labels ?? []).some((l) => {
    const name = typeof l === 'string' ? l : l.name
    return name === 'wayfinder:research' || name === 'wayfinder:task'
  })
  const candidates = items.filter((i) =>
    i.state === 'open' && !i.pull_request && (i.assignees ?? []).length === 0 && hitlFree(i))
  const reachable = new Set()
  const satisfied = (n, blockers) => blockers.every((b) =>
    b.state === 'closed' || reachable.has(b.number))
  let grew = true
  while (grew) {
    grew = false
    for (const i of candidates) {
      if (reachable.has(i.number)) continue
      const blockedBy = i.issue_dependencies_summary?.blocked_by ?? 0
      const blockers = edges[i.number]
      if (blockedBy > 0 && !blockers) continue // edge unreadable ⇒ blocked
      if (blockedBy === 0 || satisfied(i.number, blockers)) {
        reachable.add(i.number)
        grew = true
      }
    }
  }
  return reachable.size
}

// Level two of the dashboard's frontier (#262): what each takeable ticket
// DIRECTLY unblocks. `edges[number]` is the blocked-by list agentOnlyChainCount
// already reads, walked the other way round — so this costs no extra read.
//
// Returns { [blockerNumber]: item[] }. Only OPEN, non-PR items are listed under
// only OPEN blockers: a closed ticket unblocks nothing anyone can take, and a
// closed dependent is already done. One level, never a transitive closure — the
// tree the operator reads is the frontier and the row behind it (#248).
export function directUnblocks({ items = [], edges = {} } = {}) {
  const out = {}
  for (const i of items) {
    if (i.state !== 'open' || i.pull_request) continue
    for (const b of edges[i.number] ?? []) {
      if (b.state === 'closed') continue
      out[b.number] ??= []
      if (!out[b.number].some((x) => x.number === i.number)) out[b.number].push(i)
    }
  }
  return out
}

// Composes selectLane + filterTakeable over pre-fetched data; returns the
// deduped, sorted takeable issue numbers. Multi-map union counts a ticket once.
export function frontierForRepo({ mode = 'auto', maps = [], mapItems = {}, flatItems = [] }) {
  const { lane, maps: activeMaps } = selectLane(maps, mode)
  if (lane === 'empty') return []
  if (lane === 'flat') return filterTakeable(flatItems).map((i) => i.number).sort((a, b) => a - b)
  const union = new Set()
  for (const m of activeMaps) {
    for (const item of filterTakeable(mapItems[m] ?? [])) union.add(item.number)
  }
  return [...union].sort((a, b) => a - b)
}

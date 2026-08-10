// All GitHub access for the dispatch loop (#33 step 4) — every call is a `gh`
// child process (execFile, no shell), plus the pure filter/selection functions
// the frontier tests pin.
//
// Payload shapes (field-notes v2, verified live): `labels` and `assignees` are
// arrays of OBJECTS — `.labels[].name`, `.assignees[].login`. The flat
// ready-for-agent lane returns PRs too (shared number space), so anything
// carrying a `pull_request` key is dropped. `sub_issues` pages at 30 —
// --paginate is mandatory.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileP } from './exec.mjs'

export async function gh(args) {
  const { stdout } = await execFileP('gh', args, { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

// `gh api … --jq '.[]'` emits compact one-object-per-line output (verified live).
export async function ghJSONL(args) {
  const out = await gh(args)
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

let cachedLogin = null
export async function viewerLogin() {
  if (!cachedLogin) cachedLogin = (await gh(['api', 'user', '--jq', '.login'])).trim()
  return cachedLogin
}

// All wayfinder maps, open AND closed — selectLane needs the closed ones to
// tell "all maps closed ⇒ empty" apart from "no maps ⇒ flat".
export function repoMaps(repo) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues?labels=wayfinder:map&state=all&per_page=100`, '--jq', '.[]'])
}

// Unfiltered sub-issues of one map.
export function mapFrontier(repo, mapNo) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues/${mapNo}/sub_issues`, '--jq', '.[]'])
}

// Unfiltered open ready-for-agent items (PRs included — filterTakeable drops them).
export function flatFrontier(repo) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues?labels=ready-for-agent&state=open&per_page=100`, '--jq', '.[]'])
}

// Lazy full issue (body included) at dispatch time.
export async function fetchIssue(repo, n) {
  return JSON.parse(await gh(['api', `repos/${repo}/issues/${n}`]))
}

export async function claim(repo, n, login) {
  await gh(['issue', 'edit', String(n), '--repo', repo, '--add-assignee', login])
}

export async function unclaim(repo, n, login) {
  await gh(['issue', 'edit', String(n), '--repo', repo, '--remove-assignee', login])
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
  return withBodyFile(body, (f) => gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', f]))
}

export async function closeIssue(repo, n) {
  await gh(['issue', 'close', String(n), '--repo', repo])
}

export function setIssueBody(repo, n, body) {
  return withBodyFile(body, (f) => gh(['issue', 'edit', String(n), '--repo', repo, '--body-file', f]))
}

export function issueComments(repo, n) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues/${n}/comments?per_page=100`, '--jq', '.[]'])
}

// The open issues blocking one ticket — number and state per blocker, the
// same native-dependency edge the tracker doc writes with POST. Only called
// for tickets whose summary says blocked_by > 0.
export function blockedByOf(repo, n) {
  return ghJSONL(['api', '--paginate', `repos/${repo}/issues/${n}/dependencies/blocked_by`, '--jq', '.[]'])
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
  const list = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--head', head, '--state', 'all', '--json', 'number,url,state']))
  return list.find((p) => p.state === 'OPEN') ?? list[0] ?? null
}

// Prints the PR URL on success.
export async function createPullRequest(repo, { head, base, title, body }) {
  const out = await withBodyFile(body, (f) => gh([
    'pr', 'create', '--repo', repo, '--head', head, '--base', base, '--title', title, '--body-file', f,
  ]))
  return out.trim().split('\n').filter(Boolean).at(-1) ?? ''
}

// Replace an open PR's body in place — the rejection loop opens one pull request
// and updates it, rather than a new one per round (#54 item 1).
export function setPullRequestBody(repo, n, body) {
  return withBodyFile(body, (f) => gh(['pr', 'edit', String(n), '--repo', repo, '--body-file', f]))
}

// Merge ends the workspace lease (#54 item 7), and `gh pr merge --delete-branch`
// is what the AGENT runs. This is the daemon's repair for the branch it left
// behind. A missing ref is positive absence, not a failure: the agent's own
// merge already deleted it, which is the expected case.
export async function deleteRemoteBranch(repo, branch) {
  try {
    await gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`])
    return { deleted: true }
  } catch (e) {
    if (/HTTP 404|Not Found|Reference does not exist/i.test(e.message)) return { deleted: false, absent: true }
    throw e
  }
}

// ---- the agent token's boot probe (#155) ------------------------------------
//
// An agent token's repository list is edited on GitHub, not in `daemon/.env`, so
// a repo added to the watch list and forgotten on the token leaves no trace here.
// This asks GitHub at boot instead, once per watched repo, with the token that
// repo's agent would actually get.
//
// What it CAN catch: a private repo missing from the token's selection (404), an
// org policy refusal (403 carrying its own reason), a revoked or expired token
// (401), and a token whose expiry is close.
//
// What it CANNOT catch, measured on the box: a PUBLIC repo missing from the
// selection. Every fine-grained PAT reads public repositories, and the repo
// payload's `permissions` object describes the underlying USER rather than the
// token grant — the getalfredo token reports `push: true` on alp82/curia, which
// it cannot possibly write. So a read probe says yes there, and the miss surfaces
// at the agent's first write instead. A write probe was rejected: there is no
// harmless write.
//
// fetch rather than `gh`, because the answer is in a HEADER and `gh api -i`
// would mean parsing a child process's stdout to get it.
export async function probeAgentToken(repo, token, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'curia',
    },
  })
  const expiresAt = res.headers.get('github-authentication-token-expiration')
  if (res.ok) return { ok: true, expiresAt }
  let message = `HTTP ${res.status}`
  try {
    const body = await res.json()
    if (body?.message) message = `HTTP ${res.status}: ${body.message}`
  } catch { /* a non-JSON body leaves the status as the whole answer */ }
  return { ok: false, status: res.status, message, expiresAt }
}

// Days left on a `Github-Authentication-Token-Expiration` header, or null when
// the token never expires — the header is ABSENT in that case, which is how a
// no-expiration token states itself.
//
// GitHub writes the instant as `2027-08-05 06:20:31 UTC`, which `Date.parse`
// does not accept. Hence the fix-up rather than a bare parse.
export function tokenExpiryDays(raw, now = Date.now()) {
  if (!raw) return null
  const t = Date.parse(String(raw).replace(' UTC', 'Z').replace(' ', 'T'))
  return Number.isNaN(t) ? null : Math.floor((t - now) / 86_400_000)
}

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

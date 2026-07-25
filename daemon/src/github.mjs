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
// The WORKER runs the resolve protocol itself, with its own `gh` — that is what
// the wayfinder skill already does at the end of a session. Everything below
// exists so the daemon can VERIFY that afterwards and repair what is missing,
// and so it can land the code (push + PR) without the worker ever holding that
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

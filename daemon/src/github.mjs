// All GitHub access for the dispatch loop (#33 step 4) — every call is a `gh`
// child process (execFile, no shell), plus the pure filter/selection functions
// the frontier tests pin.
//
// Payload shapes (field-notes v2, verified live): `labels` and `assignees` are
// arrays of OBJECTS — `.labels[].name`, `.assignees[].login`. The flat
// ready-for-agent lane returns PRs too (shared number space), so anything
// carrying a `pull_request` key is dropped. `sub_issues` pages at 30 —
// --paginate is mandatory.

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

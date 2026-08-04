// Red tests for src/github.mjs's pure frontier logic (plan.md step 4, step 11).
//
// The gh-calling parts of github.mjs (gh, ghJSONL, viewerLogin, repoMaps,
// mapFrontier, flatFrontier, fetchIssue, claim, unclaim) are impure and are
// exercised live per the plan's manual VALIDATION lines — not here.
//
// What IS unit-testable (and what this file pins) is the pure
// filter/selection surface github.mjs is required to export:
//
//   filterTakeable(items) -> items[]
//     state == "open" && (issue_dependencies_summary?.blocked_by ?? 0) === 0
//       && assignees.length == 0 && !item.pull_request
//     Absent issue_dependencies_summary means unblocked (field-notes: the
//     flat ready-for-agent lane may not carry it on every shape).
//     An item carrying a `pull_request` key is dropped regardless of its
//     other fields — the flat ready-for-agent lane returns PRs too (GitHub
//     shares the issue/PR number space), and under the plain takeable rules
//     an open, unassigned PR would otherwise be takeable (field-notes v2).
//
//   GitHub payload shapes (field-notes v2, verified live): `labels` and
//   `assignees` on raw items are arrays of OBJECTS, not strings —
//   `labels[].name`, `assignees[].login`. Fixtures below use that shape
//   throughout so the deferred-map skip (which reads labels) is pinned
//   against reality rather than a convenient string stand-in: a
//   `labels.includes('wayfinder:deferred')`-style check would silently never
//   match this shape and dispatch from a human-paused map.
//
//   selectLane(maps, mode) -> { lane: 'map' | 'flat' | 'empty', maps: number[] }
//     maps: [{ number, state: 'open'|'closed', labels: { name: string }[] }]
//     mode 'auto': any map at all -> lane 'map' over open, non-'wayfinder:deferred'
//       maps (all deferred or all closed -> lane 'empty', never a flat fallback);
//       no maps at all -> lane 'flat'.
//     mode 'map' / 'ready-for-agent': forces that lane regardless of what maps
//       exist (this is exactly why alp82/curia, which HAS a map, can still be
//       watched in ready-for-agent mode for the smoke ticket).
//
//   frontierForRepo({ mode, maps, mapItems, flatItems }) -> number[]
//     Composes selectLane + filterTakeable against pre-fetched data (the gh
//     round-trips themselves are the caller's job, e.g. Dispatcher.frontier()):
//       mapItems: { [mapNumber]: rawIssueItem[] } -- sub_issues per map, unfiltered
//       flatItems: rawIssueItem[]                 -- ready-for-agent items, unfiltered
//     Returns the deduped, sorted list of takeable issue numbers. On a 'map'
//     lane, items appearing under more than one active map are counted once
//     (multi-map union with per-ticket de-dupe). Forced ready-for-agent mode
//     with a map present (the shipping shape for alp82/curia) must return
//     only the flat lane's takeable set — the map's own children must never
//     surface, however many populated mapItems accompany the entry.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { filterTakeable, selectLane, frontierForRepo, agentOnlyChainCount, probeAgentToken, tokenExpiryDays } from '../src/github.mjs'

// Small fixture builder -- keeps the field-notes ground truth readable below.
// assignees/labels use the real gh shape: arrays of objects, not strings.
function mkIssue(number, { state = 'open', assignees = [], blockedBy = 0, hasDepSummary = true, pullRequest = false } = {}) {
  const issue = { number, state, assignees, labels: [] }
  if (hasDepSummary) {
    issue.issue_dependencies_summary = { blocked_by: blockedBy, blocking: 0, total_blocked_by: blockedBy, total_blocking: 0 }
  }
  if (pullRequest) {
    issue.pull_request = { url: `https://api.github.com/repos/alp82/curia/pulls/${number}` }
  }
  return issue
}

function numbers(items) {
  return items.map((i) => (typeof i === 'number' ? i : i.number)).sort((a, b) => a - b)
}

describe('filterTakeable', () => {
  // Fixture numbers are synthetic, not a repo snapshot; they exercise the
  // rule (open + unassigned + unblocked = takeable, assigned = dropped).
  // Live ground truth (field-notes v2): alp82/alperortac.com map #42 (map #1
  // is closed) has children #43-#46 closed, #47 open+assigned, and
  // #48/#49/#50 open+unassigned+unblocked -- takeable: #48, #49, #50. #31 and
  // #36 below carry assignees (real shape: objects with `.login`) and are
  // excluded.
  test('drops assigned and keeps unassigned unblocked open issues', () => {
    const items = [
      mkIssue(24), mkIssue(33), mkIssue(34), mkIssue(37), mkIssue(38),
      mkIssue(31, { assignees: [{ login: 'alp82' }] }),
      mkIssue(36, { assignees: [{ login: 'alp82' }] }),
    ]
    assert.deepEqual(numbers(filterTakeable(items)), [24, 33, 34, 37, 38])
  })

  test('drops blocked issues (blocked_by > 0)', () => {
    const items = [mkIssue(50, { blockedBy: 2 }), mkIssue(51, { blockedBy: 0 })]
    assert.deepEqual(numbers(filterTakeable(items)), [51])
  })

  test('drops closed issues', () => {
    const items = [mkIssue(60, { state: 'closed' }), mkIssue(61, { state: 'open' })]
    assert.deepEqual(numbers(filterTakeable(items)), [61])
  })

  // The correction this plan states explicitly: an item with NO
  // issue_dependencies_summary field at all must be treated as unblocked,
  // not dropped. The flat ready-for-agent lane may carry items shaped this
  // way even though field-notes shows this repo's flat lane currently does
  // carry the summary -- the defensive rule stands either way.
  test('treats an absent issue_dependencies_summary as unblocked', () => {
    const items = [mkIssue(99, { hasDepSummary: false })]
    assert.deepEqual(numbers(filterTakeable(items)), [99])
  })

  // field-notes v2: the flat ready-for-agent lane returns PRs as well as
  // issues (GitHub shares the number space). An open, unassigned,
  // unblocked-looking PR must still be dropped, or the daemon spawns a
  // agent on a pull request.
  test('drops items carrying a pull_request key even when otherwise takeable', () => {
    const items = [mkIssue(70), mkIssue(71, { pullRequest: true })]
    assert.deepEqual(numbers(filterTakeable(items)), [70])
  })

  test('takeable list is empty when nothing qualifies', () => {
    const items = [mkIssue(1, { state: 'closed' }), mkIssue(2, { assignees: [{ login: 'x' }] })]
    assert.deepEqual(filterTakeable(items), [])
  })
})

describe('selectLane', () => {
  test('auto: a single open, non-deferred map wins the map lane', () => {
    const maps = [{ number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] }]
    const result = selectLane(maps, 'auto')
    assert.equal(result.lane, 'map')
    assert.deepEqual(result.maps, [1])
  })

  test('auto: deferred maps are skipped, non-deferred maps still fire the map lane', () => {
    const maps = [
      { number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }, { name: 'wayfinder:deferred' }] },
      { number: 2, state: 'open', labels: [{ name: 'wayfinder:map' }] },
    ]
    const result = selectLane(maps, 'auto')
    assert.equal(result.lane, 'map')
    assert.deepEqual(result.maps, [2])
  })

  // Synthetic exercise of the conservative rule (deferred + exhausted-but-
  // open maps both yield EMPTY, never a fall-through to the flat lane). Live
  // ground truth (field-notes v2): getalfredo/landing-page's two maps are
  // both open -- #72 is wayfinder:deferred, #1 is non-deferred but has zero
  // open children (exhausted, not closed). The live deferred-skip proof is
  // #66, which sits open/unassigned/unblocked under deferred map #72 and
  // never appears in the frontier -- that's a fixture beyond this unit test,
  // not reproduced here.
  test('auto: all maps deferred-or-closed yields an empty lane, never flat', () => {
    const maps = [
      { number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }, { name: 'wayfinder:deferred' }] },
      { number: 2, state: 'closed', labels: [{ name: 'wayfinder:map' }] },
    ]
    const result = selectLane(maps, 'auto')
    assert.equal(result.lane, 'empty')
  })

  test('auto: no maps at all falls through to the flat lane', () => {
    const result = selectLane([], 'auto')
    assert.equal(result.lane, 'flat')
  })

  // alp82/curia: has a map (issue #1) but is watched in ready-for-agent mode
  // so its own map lane must never fire during verification.
  test('mode ready-for-agent forces the flat lane even when a map exists', () => {
    const maps = [{ number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] }]
    const result = selectLane(maps, 'ready-for-agent')
    assert.equal(result.lane, 'flat')
  })

  test('mode map forces the map lane', () => {
    const maps = [{ number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] }]
    const result = selectLane(maps, 'map')
    assert.equal(result.lane, 'map')
    assert.deepEqual(result.maps, [1])
  })
})

describe('frontierForRepo', () => {
  test('no-map watch entry resolves through the flat lane', () => {
    const entry = {
      mode: 'auto',
      maps: [],
      mapItems: {},
      flatItems: [mkIssue(38), mkIssue(39, { assignees: [{ login: 'alp82' }] })],
    }
    assert.deepEqual(frontierForRepo(entry), [38])
  })

  test('all-deferred watch entry resolves to an empty frontier, ignoring flatItems', () => {
    const entry = {
      mode: 'auto',
      maps: [{ number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }, { name: 'wayfinder:deferred' }] }],
      mapItems: { 1: [mkIssue(1), mkIssue(2)] },
      flatItems: [mkIssue(100)], // must be ignored -- never a fallback
    }
    assert.deepEqual(frontierForRepo(entry), [])
  })

  // Multi-map union with per-ticket de-dupe: ticket #40 is a sub-issue of
  // both active maps and must appear exactly once in the union.
  test('multi-map union de-dupes a ticket shared across two active maps', () => {
    const entry = {
      mode: 'auto',
      maps: [
        { number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] },
        { number: 2, state: 'open', labels: [{ name: 'wayfinder:map' }] },
      ],
      mapItems: {
        1: [mkIssue(40), mkIssue(41)],
        2: [mkIssue(40), mkIssue(42)],
      },
      flatItems: [],
    }
    assert.deepEqual(frontierForRepo(entry), [40, 41, 42])
  })

  test('multi-map union still drops blocked/assigned items from each map', () => {
    const entry = {
      mode: 'auto',
      maps: [
        { number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] },
        { number: 2, state: 'open', labels: [{ name: 'wayfinder:map' }] },
      ],
      mapItems: {
        1: [mkIssue(1), mkIssue(2, { assignees: [{ login: 'alp82' }] })],
        2: [mkIssue(3, { blockedBy: 1 })],
      },
      flatItems: [],
    }
    assert.deepEqual(frontierForRepo(entry), [1])
  })

  // field-notes v2: alp82/curia is the shipping shape where a map with
  // populated mapItems (children #33/#34) coexists with ready-for-agent
  // mode. The map's children must never be dispatched — only the flat
  // lane's smoke ticket (#38) may surface.
  test('ready-for-agent mode ignores a present map with populated mapItems and returns only the flat lane', () => {
    const entry = {
      mode: 'ready-for-agent',
      maps: [{ number: 1, state: 'open', labels: [{ name: 'wayfinder:map' }] }],
      mapItems: { 1: [mkIssue(33), mkIssue(34)] },
      flatItems: [mkIssue(38)],
    }
    assert.deepEqual(frontierForRepo(entry), [38])
  })
})

// #81's tickets view: how many open tickets an agent can work through with no
// human in the loop — takeable now, or unblocked purely by chains of other
// HITL-free tickets. mkIssue labels are empty, so a type label is added here.
function typed(issue, type) {
  issue.labels = [{ name: `wayfinder:${type}` }]
  return issue
}

describe('agentOnlyChainCount', () => {
  test('counts a takeable research ticket and a task chained behind it', () => {
    const items = [
      typed(mkIssue(1), 'research'),
      typed(mkIssue(2, { blockedBy: 1 }), 'task'),
    ]
    const edges = { 2: [{ number: 1, state: 'open' }] }
    assert.equal(agentOnlyChainCount({ items, edges }), 2)
  })

  test('a HITL ticket breaks the chain behind it', () => {
    const items = [
      typed(mkIssue(1), 'grilling'),
      typed(mkIssue(2, { blockedBy: 1 }), 'research'),
    ]
    const edges = { 2: [{ number: 1, state: 'open' }] }
    assert.equal(agentOnlyChainCount({ items, edges }), 0)
  })

  test('a closed blocker satisfies its edge', () => {
    const items = [
      typed(mkIssue(1, { state: 'closed' }), 'grilling'),
      typed(mkIssue(2, { blockedBy: 1 }), 'task'),
    ]
    const edges = { 2: [{ number: 1, state: 'closed' }] }
    assert.equal(agentOnlyChainCount({ items, edges }), 1)
  })

  test('an untyped, assigned, or edge-less blocked ticket never counts', () => {
    const items = [
      mkIssue(1), // no wayfinder type ⇒ HITL by the conservative rule
      typed(mkIssue(2, { assignees: [{ login: 'alp82' }] }), 'research'),
      typed(mkIssue(3, { blockedBy: 1 }), 'research'), // no edge entry ⇒ blocked
    ]
    assert.equal(agentOnlyChainCount({ items, edges: {} }), 0)
  })
})

// #155: the boot probe on an agent token. Every shape below was measured
// against the real API with the real tokens before it was written down.
describe('the agent token boot probe (#155)', () => {
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  })

  test('a reachable repo answers ok, and carries the token expiry when there is one', async () => {
    let seen = null
    const res = await probeAgentToken('getalfredo/landing-page', 'github_pat_x', {
      fetchImpl: async (url, opts) => {
        seen = { url, auth: opts.headers.authorization }
        return reply(200, { full_name: 'getalfredo/landing-page' },
          { 'github-authentication-token-expiration': '2027-08-05 06:20:31 UTC' })
      },
    })
    assert.equal(seen.url, 'https://api.github.com/repos/getalfredo/landing-page')
    assert.equal(seen.auth, 'Bearer github_pat_x')
    assert.deepEqual(res, { ok: true, expiresAt: '2027-08-05 06:20:31 UTC' })
  })

  // The header is ABSENT on a no-expiration token — that absence is the fact,
  // not a missing reading.
  test('a token that never expires carries no expiry header', async () => {
    const res = await probeAgentToken('alp82/curia', 'github_pat_x',
      { fetchImpl: async () => reply(200, { full_name: 'alp82/curia' }) })
    assert.deepEqual(res, { ok: true, expiresAt: null })
    assert.equal(tokenExpiryDays(res.expiresAt), null)
  })

  // Each of these three was produced by a real token against the real API.
  test('a refusal keeps GitHub\'s own reason, which is what names the fix', async () => {
    const cases = [
      [404, 'Not Found', /HTTP 404: Not Found/],
      [403, "The 'getalfredo' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days.", /forbids access.*366 days/],
      [401, 'Bad credentials', /HTTP 401: Bad credentials/],
    ]
    for (const [status, message, expected] of cases) {
      const res = await probeAgentToken('alp82/x', 'github_pat_x',
        { fetchImpl: async () => reply(status, { message }) })
      assert.equal(res.ok, false)
      assert.equal(res.status, status)
      assert.match(res.message, expected)
    }
  })

  test('a non-JSON body still reports its status rather than throwing', async () => {
    const res = await probeAgentToken('alp82/x', 'github_pat_x', {
      fetchImpl: async () => ({
        ok: false, status: 502, headers: { get: () => null },
        json: async () => { throw new Error('not json') },
      }),
    })
    assert.deepEqual(res, { ok: false, status: 502, message: 'HTTP 502', expiresAt: null })
  })

  // GitHub writes `2027-08-05 06:20:31 UTC`, which Date.parse rejects outright.
  test('the expiry header parses, and a garbled one reads as unknown', () => {
    const now = Date.parse('2026-08-04T00:00:00Z')
    assert.equal(tokenExpiryDays('2027-08-05 06:20:31 UTC', now), 366)
    assert.equal(tokenExpiryDays('2026-08-10 00:00:00 UTC', now), 6)
    assert.equal(tokenExpiryDays('2026-08-01 00:00:00 UTC', now), -3)
    for (const bad of [null, undefined, '', 'sometime soon']) {
      assert.equal(tokenExpiryDays(bad, now), null)
    }
  })
})

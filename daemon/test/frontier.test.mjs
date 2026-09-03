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
import {
  filterTakeable, selectLane, frontierForRepo, agentOnlyChainCount, strandedMaps,
  emptyMapVerdictPrompt, mapCloseBlockers, mapClosedComment, mapHeldComment,
} from '../src/github.mjs'

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
  // unblocked-looking PR must still be dropped, or the daemon spawns an
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

  test('the Test run\'s own type is agent-driven, like a task (#891)', () => {
    const items = [
      typed(mkIssue(1), 'test-run'),
      typed(mkIssue(2, { blockedBy: 1 }), 'test-run'),
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
// The stranded map (#485, widened by #698): open, not deferred, and no open
// child. Empty maps now enter the same edge-triggered watch for a fog verdict.
describe('strandedMaps (#485)', () => {
  const map = (n, { state = 'open', labels = [] } = {}) => ({
    number: n, state, title: `Map ${n}`,
    labels: [{ name: 'wayfinder:map' }, ...labels.map((name) => ({ name }))],
  })
  const child = (state) => ({ number: 9, state, labels: [], assignees: [] })

  test('an open map whose children are all closed is stranded', () => {
    const out = strandedMaps([map(316)], { 316: [child('closed'), child('closed')] })
    assert.deepEqual(out, [{ number: 316, title: 'Map 316' }])
  })

  test('an open child keeps the map off the list', () => {
    assert.deepEqual(strandedMaps([map(316)], { 316: [child('closed'), child('open')] }), [])
  })

  test('a map with no children is stranded so its fog gets a durable verdict', () => {
    const expected = [{ number: 316, title: 'Map 316' }]
    assert.deepEqual(strandedMaps([map(316)], { 316: [] }), expected)
    assert.deepEqual(strandedMaps([map(316)], {}), expected)
  })

  test('closed and deferred maps are never stranded', () => {
    const maps = [map(1, { state: 'closed' }), map(2, { labels: ['wayfinder:deferred'] })]
    const items = { 1: [child('closed')], 2: [child('closed')] }
    assert.deepEqual(strandedMaps(maps, items), [])
  })

})

// The empty-map verdict (#698). #485 said a line about a stranded map and
// waited for someone to act on it. This asks the operator a question instead,
// and the answer is what closes the map.
describe('the empty-map question (#698)', () => {
  const map = { number: 316, title: 'The journal becomes a queryable store' }

  test('the question names the map, its fog, and what each answer does', () => {
    const prompt = emptyMapVerdictPrompt('o/r', map, [
      { text: 'Pick the retention period' },
      { text: 'Decide whether exports include raw rows' },
    ])
    assert.match(prompt, /o\/r#316/)
    assert.match(prompt, /no open ticket left/)
    assert.match(prompt, /Still under Not yet specified \(2\)/)
    assert.match(prompt, /• Pick the retention period/)
    assert.match(prompt, /• Decide whether exports include raw rows/)
    assert.match(prompt, /✅ posts the verdict and closes the map/)
  })

  test('a map with no fog says so — an absence nobody looked for reads the same as silence', () => {
    const prompt = emptyMapVerdictPrompt('o/r', map, [])
    assert.match(prompt, /Nothing stands under Not yet specified/)
    assert.doesNotMatch(prompt, /Still under Not yet specified/)
  })
})

// What still holds an approved close (#698). The question can sit for days, so
// the approval is checked against the map as it stands rather than as it read.
describe('mapCloseBlockers (#698)', () => {
  test('an open, unlabelled, childless, fogless map closes', () => {
    assert.deepEqual(mapCloseBlockers({ state: 'open', labels: [], children: [], fog: [] }), [])
    assert.deepEqual(mapCloseBlockers(), [])
  })

  test('a closed map, a reopened child, and standing fog each hold it', () => {
    assert.match(mapCloseBlockers({ state: 'closed' })[0], /already closed/)
    const child = mapCloseBlockers({ children: [{ number: 9, state: 'open' }] })
    assert.match(child[0], /1 child ticket\(s\) reopened or arrived: #9/)
    const fog = mapCloseBlockers({ fog: [{ text: 'Pick the retention period' }] })
    assert.match(fog[0], /1 line\(s\) still stand under Not yet specified: Pick the retention period/)
  })

  test('a paused map is never closed by an answer — a pause is only ever ended by hand', () => {
    const held = mapCloseBlockers({ labels: [{ name: 'wayfinder:deferred' }] })
    assert.match(held[0], /paused/)
    assert.deepEqual(mapCloseBlockers({ labels: ['wayfinder:deferred'] }).length, 1)
  })

  test('a closed child and a pull request hold nothing', () => {
    assert.deepEqual(mapCloseBlockers({
      children: [{ number: 9, state: 'closed' }, { number: 10, state: 'open', pull_request: {} }],
    }), [])
  })

  test('both comments say which way the verdict went, and why', () => {
    assert.match(mapClosedComment(), /Closed on the operator’s verdict/)
    assert.match(mapHeldComment(['the operator says work remains on this map']), /stays open/)
    assert.match(mapHeldComment(['the operator says work remains on this map']), /- the operator says work remains/)
  })
})

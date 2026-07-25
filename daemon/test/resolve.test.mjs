// Unit tests for src/resolve.mjs (#41) — the pure map-body surgery, and the
// verify/repair/land pipeline driven entirely through injected deps.
//
// The properties worth pinning here are the ones that bite on a REAL map:
//   - a pointer test that cannot be fooled by one decision citing another ticket
//   - an append that lands inside Decisions-so-far and disturbs nothing else
//   - a failed READ never triggers a repair (the #33 evidence rule)
//   - a landing failure never un-resolves the ticket

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  sectionBounds, pointerLine, mapPointerFor, insertMapPointer,
  fallbackResolutionComment, nonCleanComment, prBody, resolveAndLand, summariseOutcome,
  DECISIONS_HEADING,
} from '../src/resolve.mjs'

// A map body shaped like the real one: decisions that cite OTHER tickets, both
// as bare numbers and as full links, plus the sections that follow.
const MAP_BODY = [
  '## Destination',
  '',
  'A running PoC.',
  '',
  '## Notes',
  '',
  '- expect concurrent sessions',
  '',
  '## Decisions so far',
  '',
  '<!-- the index — one line per closed ticket -->',
  '',
  '- [Pick the substrate](https://github.com/o/r/issues/30) — tmux + ttyd wins; graduated [#35](https://github.com/o/r/issues/35) and #41',
  '- [Build preview links](https://github.com/o/r/issues/40) — the daemon allocates; the chain waits on [#35](https://github.com/o/r/issues/35)',
  '',
  '## Not yet specified',
  '',
  '*(empty)*',
  '',
  '## Out of scope',
  '',
  '- something ruled out',
  '',
].join('\n')

describe('map body surgery', () => {
  test('sectionBounds spans the heading to the next ## and no further', () => {
    const b = sectionBounds(MAP_BODY, DECISIONS_HEADING)
    assert.ok(b)
    assert.match(b.lines[b.start], /Decisions so far/)
    assert.match(b.lines[b.end], /^## Not yet specified/)
  })

  test('mapPointerFor finds a real pointer by its OWN link target', () => {
    const line = mapPointerFor(MAP_BODY, 'o/r', 30)
    assert.match(line, /Pick the substrate/)
  })

  test('a ticket merely CITED by another decision has no pointer', () => {
    // #35 and #41 both appear inside other decisions' gists — as a link and as a
    // bare number. A mention test would report them as already recorded and
    // silently drop their pointers forever.
    assert.equal(mapPointerFor(MAP_BODY, 'o/r', 35), null)
    assert.equal(mapPointerFor(MAP_BODY, 'o/r', 41), null)
  })

  test('a pointer in another repo does not count', () => {
    assert.equal(mapPointerFor(MAP_BODY, 'other/repo', 30), null)
  })

  test('a number that is a prefix of a recorded one does not count', () => {
    assert.equal(mapPointerFor(MAP_BODY, 'o/r', 4), null, '#4 must not match the /issues/40 pointer')
  })

  test('insertMapPointer appends at the end of the section, leaving the rest byte-identical', () => {
    const line = pointerLine({ title: 'Close the loop', url: 'https://github.com/o/r/issues/41', gist: 'the worker resolves' })
    const next = insertMapPointer(MAP_BODY, line)
    const lines = next.split('\n')
    const at = lines.indexOf(line)
    assert.ok(at > 0, 'the line is in the body')
    assert.match(lines[at - 1], /issues\/40/, 'it lands after the last existing decision')
    assert.equal(lines[at + 1], '', 'the blank line before the next heading survives')
    assert.match(lines[at + 2], /^## Not yet specified/)
    // every other section is untouched
    assert.ok(next.includes('## Out of scope\n\n- something ruled out'))
    assert.ok(next.includes('## Destination\n\nA running PoC.'))
    assert.ok(mapPointerFor(next, 'o/r', 41), 'and the new pointer is now findable')
  })

  test('insertMapPointer refuses a body with no Decisions-so-far section', () => {
    assert.equal(insertMapPointer('## Destination\n\nnope\n', '- x'), null)
  })

  test('pointerLine flattens a multi-line gist — one pointer is one line', () => {
    const line = pointerLine({ title: 't', url: 'u', gist: 'first\n\n- second\nthird  ' })
    assert.equal(line, '- [t](u) — first - second third')
    assert.equal(line.split('\n').length, 1)
  })

  test('pointerLine still says something when the gist is empty', () => {
    assert.match(pointerLine({ title: 't', url: 'u', gist: '  ' }), /no gist recorded/)
  })
})

describe('comment bodies', () => {
  test('the fallback resolution comment marks itself as curia-written', () => {
    const b = fallbackResolutionComment({ status: 'resolved', summary: 'did the thing' })
    assert.match(b, /recorded by curia/)
    assert.match(b, /did the thing/)
  })

  test('a non-clean note says the ticket is NOT resolved and whether it came back', () => {
    const released = nonCleanComment({ worker: 'curia-42', result: { status: 'blocked', summary: 'stuck' }, released: true })
    assert.match(released, /did \*\*not\*\* resolve/)
    assert.match(released, /returns to the frontier/)
    const stuck = nonCleanComment({ worker: 'curia-42', result: { status: 'blocked', summary: 'stuck' }, released: false })
    assert.match(stuck, /Releasing its claim FAILED/)
  })

  test('the PR body links the ticket WITHOUT a closing keyword and lists daemon-observed commits', () => {
    const b = prBody({
      repo: 'o/r', ticket: '42', title: 'a ticket', result: { summary: 's' },
      commits: [{ sha: 'abc1234', subject: 'do it' }], worker: 'curia-42', model: 'opus',
    })
    assert.ok(!/\b(closes|fixes|resolves) #42/i.test(b), 'a closing keyword would read as if the merge resolved the ticket')
    assert.match(b, /Ticket: o\/r#42/)
    assert.match(b, /`abc1234` do it/)
    assert.match(b, /read out of git by the daemon/)
  })
})

// ---- the pipeline ------------------------------------------------------------

let journalled
let calls

function harness({ issues, overrides = {}, result = { status: 'resolved', summary: 'the answer' }, login = 'me', epochTs = null } = {}) {
  const store = new Map(Object.entries(issues).map(([k, v]) => [String(k), { ...v }]))
  const deps = {
    fetchIssue: async (repo, n) => {
      const i = store.get(String(n))
      if (!i) throw new Error('HTTP 404: Not Found')
      return { ...i }
    },
    issueComments: async () => [],
    commentIssue: async (repo, n, body) => { calls.push({ op: 'comment', n: String(n), body }) },
    closeIssue: async (repo, n) => { calls.push({ op: 'close', n: String(n) }); store.get(String(n)).state = 'closed' },
    setIssueBody: async (repo, n, body) => { calls.push({ op: 'setBody', n: String(n) }); store.get(String(n)).body = body },
    defaultBranchOf: async () => 'main',
    commitsOnBranch: async () => [{ sha: 'abc1234', subject: 'do it' }],
    pushBranch: async (wt, repo, branch) => { calls.push({ op: 'push', branch }); return 'abc1234' },
    findPullRequest: async () => null,
    createPullRequest: async (repo, opts) => { calls.push({ op: 'pr', ...opts }); return 'https://github.com/o/r/pull/7' },
    ...overrides,
  }
  return {
    store,
    run: () => resolveAndLand({
      repo: 'o/r', ticket: '42', worker: 'curia-42', result, login, epochTs, model: 'opus',
      wtPath: '/w/42', basePath: '/b', branch: 'curia/42',
      deps,
      journal: (type, data) => journalled.push({ type, ...data }),
      withMapLock: (key, fn) => fn(),
    }),
  }
}

const TICKET = { number: 42, title: 'a ticket', state: 'closed', html_url: 'https://github.com/o/r/issues/42' }
const MAP_ISSUE = { number: 1, title: 'the map', state: 'open', labels: [{ name: 'wayfinder:map' }], body: MAP_BODY }

beforeEach(() => { journalled = []; calls = [] })

describe('resolveAndLand: the worker did everything right', () => {
  test('nothing is repaired; the branch is pushed, a PR opened, and the ticket gets the link', async () => {
    const h = harness({
      issues: {
        42: { ...TICKET, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' },
        1: { ...MAP_ISSUE, body: insertMapPointer(MAP_BODY, pointerLine({ title: 'a ticket', url: 'https://github.com/o/r/issues/42', gist: 'g' })) },
      },
      overrides: { issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z', body: 'resolution' }] },
    })
    const out = await h.run()

    assert.equal(out.comment, 'present')
    assert.equal(out.close, 'present')
    assert.equal(out.map.state, 'present')
    assert.deepEqual(out.repaired, [])
    assert.equal(out.land.state, 'pr-opened')
    assert.deepEqual(calls.map((c) => c.op), ['push', 'pr', 'comment'])
    assert.match(calls.at(-1).body, /pushed `curia\/42`.*pull\/7/)
    assert.ok(!calls.some((c) => c.op === 'setBody'), 'a map that already has the pointer is not rewritten')
    assert.ok(!calls.some((c) => c.op === 'close'))
  })
})

describe('resolveAndLand: repairs', () => {
  test('a worker that reported resolved but left the ticket open and uncommented gets both repaired', async () => {
    const h = harness({ issues: { 42: { ...TICKET, state: 'open' } } })
    const out = await h.run()

    assert.equal(out.comment, 'repaired')
    assert.equal(out.close, 'repaired')
    assert.deepEqual(out.repaired, ['resolution comment', 'close'])
    const comment = calls.find((c) => c.op === 'comment')
    assert.match(comment.body, /recorded by curia/)
    assert.match(comment.body, /the answer/)
    assert.equal(h.store.get('42').state, 'closed')
    assert.equal(journalled.filter((e) => e.type === 'resolve_repaired').length, 2)
  })

  test("a comment from an EARLIER dispatch does not count as this dispatch's resolution", async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      epochTs: '2026-07-25T12:00:00Z',
      overrides: { issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-20T09:00:00Z' }] },
    })
    const out = await h.run()
    assert.equal(out.comment, 'repaired')
  })

  test('a map pointer lost to a concurrent write is appended, verified, and journalled verbatim', async () => {
    const h = harness({
      issues: {
        42: { ...TICKET, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' },
        1: { ...MAP_ISSUE },
      },
      overrides: { issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }] },
    })
    const out = await h.run()

    assert.equal(out.map.state, 'appended')
    assert.equal(out.map.number, 1)
    assert.ok(out.repaired.includes('map pointer on #1'))
    const appended = journalled.find((e) => e.type === 'map_pointer_appended')
    assert.match(appended.line, /^- \[a ticket\]\(https:\/\/github\.com\/o\/r\/issues\/42\) — the answer$/)
    assert.ok(mapPointerFor(h.store.get('1').body, 'o/r', 42), 'the map body now carries the pointer')
  })

  test('a write that does not show up on re-read is reported unverified, with the line still journalled', async () => {
    const h = harness({
      issues: {
        42: { ...TICKET, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' },
        1: { ...MAP_ISSUE },
      },
      overrides: {
        issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }],
        // a concurrent writer clobbers the body between the write and the check
        setIssueBody: async () => { calls.push({ op: 'setBody' }) },
      },
    })
    const out = await h.run()

    assert.equal(out.map.state, 'append-unverified')
    assert.ok(journalled.some((e) => e.type === 'map_pointer_unverified'))
    assert.ok(journalled.some((e) => e.type === 'map_pointer_appended' && /issues\/42/.test(e.line)),
      'the line stays replayable from the journal even when the map lost it')
    assert.match(summariseOutcome(out), /NOT verified/)
  })

  test('a map with no Decisions-so-far section is not guessed at', async () => {
    const h = harness({
      issues: {
        42: { ...TICKET, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' },
        1: { ...MAP_ISSUE, body: '## Destination\n\njust this\n' },
      },
      overrides: { issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }] },
    })
    const out = await h.run()

    assert.equal(out.map.state, 'no-section')
    assert.ok(!calls.some((c) => c.op === 'setBody'), 'the body is left exactly as it was')
    assert.ok(journalled.some((e) => e.type === 'map_pointer_failed'))
  })

  test('a parent that is not a wayfinder map gets no pointer', async () => {
    const h = harness({
      issues: {
        42: { ...TICKET, parent_issue_url: 'https://api.github.com/repos/o/r/issues/9' },
        9: { number: 9, title: 'an ordinary parent', state: 'open', labels: [], body: MAP_BODY },
      },
      overrides: { issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }] },
    })
    const out = await h.run()
    assert.equal(out.map.state, 'parent-not-a-map')
    assert.ok(!calls.some((c) => c.op === 'setBody'))
  })
})

describe('resolveAndLand: a failed read is never evidence', () => {
  test('an unreadable comment list posts NO fallback comment, and says so', async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      overrides: { issueComments: async () => { throw new Error('HTTP 502') } },
    })
    const out = await h.run()

    assert.equal(out.comment, 'unknown')
    assert.ok(!calls.some((c) => c.op === 'comment' && /recorded by curia/.test(c.body)),
      'a duplicate resolution comment is worse than an unverified one')
    assert.match(out.warnings.join(' '), /could not read the ticket's comments/)
    assert.ok(journalled.some((e) => e.type === 'resolve_verify_indeterminate'))
  })

  test('an unknown gh identity leaves the comment axis unverified rather than duplicating it', async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      login: null,
      overrides: { issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }] },
    })
    const out = await h.run()

    assert.equal(out.comment, 'unknown')
    assert.ok(!calls.some((c) => c.op === 'comment' && /recorded by curia/.test(c.body)))
    assert.match(out.warnings.join(' '), /viewer identity is unknown/)
  })

  test('an unreadable map still resolves the ticket, and the failure is loud', async () => {
    const h = harness({
      issues: { 42: { ...TICKET, parent_issue_url: 'https://api.github.com/repos/o/r/issues/1' } },
      overrides: { issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }] },
    })
    const out = await h.run()

    assert.equal(out.map.state, 'error')
    assert.equal(out.close, 'present')
    assert.equal(out.land.state, 'pr-opened', 'a map failure does not stop the landing')
    assert.match(out.warnings.join(' '), /map pointer on #1 could not be written/)
  })
})

describe('resolveAndLand: landing', () => {
  test('no commits ⇒ nothing is pushed and no PR is opened', async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      overrides: {
        issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }],
        commitsOnBranch: async () => [],
      },
    })
    const out = await h.run()

    assert.equal(out.land.state, 'no-commits')
    assert.deepEqual(calls.map((c) => c.op), [])
    assert.ok(journalled.some((e) => e.type === 'land_skipped'))
    assert.match(summariseOutcome(out), /nothing to land/)
  })

  test('an existing PR for the branch is reused, not re-created', async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      overrides: {
        issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }],
        findPullRequest: async () => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }),
      },
    })
    const out = await h.run()

    assert.equal(out.land.state, 'pr-reused')
    assert.ok(!calls.some((c) => c.op === 'pr'), 'gh pr create fails on an existing head — reuse instead')
    assert.ok(journalled.some((e) => e.type === 'pr_reused'))
  })

  test('a failed push leaves the ticket resolved and names where the commits still are', async () => {
    const h = harness({
      issues: { 42: { ...TICKET, state: 'open' } },
      overrides: {
        issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }],
        pushBranch: async () => { throw new Error('permission denied') },
      },
    })
    const out = await h.run()

    assert.equal(out.close, 'repaired', 'the resolution stands on its own')
    assert.equal(out.land.state, 'failed')
    assert.match(out.warnings.join(' '), /NOT landed.*permission denied.*\/w\/42/s)
    assert.ok(journalled.some((e) => e.type === 'land_failed'))
    assert.match(summariseOutcome(out), /landing FAILED/)
  })

  test('a worker with no worktree on disk skips the landing entirely', async () => {
    const out = await resolveAndLand({
      repo: 'o/r', ticket: '42', worker: 'curia-42', login: 'me',
      result: { status: 'resolved', summary: 's' },
      wtPath: null, basePath: '/b', branch: 'curia/42',
      deps: {
        fetchIssue: async () => ({ ...TICKET }),
        issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z' }],
        commitsOnBranch: async () => { throw new Error('must not be called') },
      },
      journal: (type, data) => journalled.push({ type, ...data }),
      withMapLock: (key, fn) => fn(),
    })
    assert.equal(out.land.state, 'skipped')
  })
})

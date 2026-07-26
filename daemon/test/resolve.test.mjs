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
  landBranch, prLinkComment, DECISIONS_HEADING, MACHINE_MARKER,
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
      repo: 'o/r', ticket: '42', title: 'a ticket', summary: 's',
      commits: [{ sha: 'abc1234', subject: 'do it' }], worker: 'curia-42', model: 'opus',
    })
    assert.ok(!/\b(closes|fixes|resolves) #42/i.test(b), 'a closing keyword would read as if the merge resolved the ticket')
    assert.match(b, /Ticket: o\/r#42/)
    assert.match(b, /`abc1234` do it/)
    assert.match(b, /read out of git by the daemon/)
  })

  test("curia's own comments are marked, so they can never pass for the worker's resolution", () => {
    // #54: open_pull_request comments on an OPEN ticket, and the
    // resolution-comment check asks "is there a comment by us since this
    // dispatch". Unmarked, curia's link comment would answer that question for a
    // worker that wrote no resolution at all.
    assert.ok(prLinkComment({ branch: 'curia/42', commits: 1, url: 'u', state: 'opened' }).startsWith(MACHINE_MARKER))
    assert.ok(nonCleanComment({ worker: 'curia-42', result: { status: 'blocked' }, released: true }).startsWith(MACHINE_MARKER))
    assert.ok(!fallbackResolutionComment({ summary: 's' }).includes(MACHINE_MARKER),
      'the fallback IS the resolution — marking it would make a later dispatch re-post one')
  })

  test('the pull-request link comment says what was pushed and where', () => {
    const one = prLinkComment({ branch: 'curia/42', commits: 1, url: 'https://x/pull/7', state: 'opened' })
    assert.match(one, /pushed `curia\/42` \(1 commit\) and opened https:\/\/x\/pull\/7/)
    assert.match(prLinkComment({ branch: 'curia/42', commits: 3, url: 'u', state: 'updated' }), /\(3 commits\) and updated/)
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
    hasUnpushedWork: async () => false,
    // the happy path since #54: the worker merged what a human approved
    findPullRequest: async () => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED' }),
    createPullRequest: async (repo, opts) => { calls.push({ op: 'pr', ...opts }); return 'https://github.com/o/r/pull/7' },
    setPullRequestBody: async (repo, n) => { calls.push({ op: 'prEdit', n }) },
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
    assert.equal(out.land.state, 'merged')
    assert.deepEqual(calls.map((c) => c.op), [],
      'landing happened mid-ticket through open_pull_request, and the merge was the worker\'s own')
    assert.match(summariseOutcome(out), /code merged/)
  })

  test("curia's own link comment does not pass for the worker's resolution", async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      overrides: {
        issueComments: async () => [{
          user: { login: 'me' },
          created_at: '2026-07-25T10:00:00Z',
          body: prLinkComment({ branch: 'curia/42', commits: 1, url: 'u', state: 'opened' }),
        }],
      },
    })
    const out = await h.run()
    assert.equal(out.comment, 'repaired', "the only comment on the ticket was curia's own")
    assert.match(calls.find((c) => c.op === 'comment').body, /recorded by curia/)
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
    assert.equal(out.land.state, 'merged', 'a map failure does not stop the landing check')
    assert.match(out.warnings.join(' '), /map pointer on #1 could not be written/)
  })
})

// `resolved` means MERGED (#48), so this axis stopped being "did we push it" and
// became "is the code actually in".
describe('resolveAndLand: is the code IN', () => {
  const withComment = { issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z', body: 'resolution' }] }

  test('no commits ⇒ no landing question to answer', async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      overrides: { ...withComment, commitsOnBranch: async () => [] },
    })
    const out = await h.run()

    assert.equal(out.land.state, 'no-commits')
    assert.deepEqual(calls.map((c) => c.op), [])
    assert.match(summariseOutcome(out), /no code to land/)
  })

  test('a ticket closed over an OPEN pull request is reported as the defect it is', async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      overrides: {
        ...withComment,
        findPullRequest: async () => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }),
      },
    })
    const out = await h.run()

    assert.equal(out.land.state, 'unmerged')
    assert.match(out.warnings.join(' '), /is \*\*OPEN\*\*, not merged/)
    assert.ok(journalled.some((e) => e.type === 'resolved_unmerged'))
    assert.match(summariseOutcome(out), /NOT merged/)
  })

  test('unpushed commits under an unmerged pull request are pushed, so nothing lives only in a worktree', async () => {
    const h = harness({
      issues: { 42: { ...TICKET } },
      overrides: {
        ...withComment,
        findPullRequest: async () => ({ number: 7, url: 'u', state: 'OPEN' }),
        hasUnpushedWork: async () => true,
      },
    })
    await h.run()
    assert.ok(calls.some((c) => c.op === 'push'))
    assert.ok(journalled.some((e) => e.type === 'branch_pushed' && e.reason === 'unmerged at resolve'))
  })

  test('commits with NO pull request at all are landed as a repair, loudly', async () => {
    // The one landing repair left: the worker skipped open_pull_request, so the
    // only copy of its work is a worktree the lifecycle is about to stop
    // protecting. Curia cannot get it reviewed after the fact — it can only
    // refuse to lose it, and say that nobody looked.
    const h = harness({
      issues: { 42: { ...TICKET } },
      overrides: { ...withComment, findPullRequest: async () => null },
    })
    const out = await h.run()

    assert.equal(out.land.state, 'repaired')
    assert.ok(out.repaired.includes('pull request'))
    assert.deepEqual(calls.map((c) => c.op), ['push', 'pr', 'comment'])
    assert.match(out.warnings.join(' '), /never called `open_pull_request`.*NOBODY REVIEWED/s)
    assert.ok(journalled.some((e) => e.type === 'land_repaired'))
  })

  test('an unreadable pull-request state leaves the ticket resolved and says it cannot tell', async () => {
    const h = harness({
      issues: { 42: { ...TICKET, state: 'open' } },
      overrides: {
        ...withComment,
        findPullRequest: async () => { throw new Error('HTTP 502') },
      },
    })
    const out = await h.run()

    assert.equal(out.close, 'repaired', 'the resolution stands on its own')
    assert.equal(out.land.state, 'failed')
    assert.match(out.warnings.join(' '), /could not establish whether the work is landed.*HTTP 502.*\/w\/42/s)
    assert.ok(journalled.some((e) => e.type === 'land_failed'))
  })

  test('a worker with no worktree on disk skips the landing check entirely', async () => {
    const out = await resolveAndLand({
      repo: 'o/r', ticket: '42', worker: 'curia-42', login: 'me',
      result: { status: 'resolved', summary: 's' },
      wtPath: null, basePath: '/b', branch: 'curia/42',
      deps: {
        fetchIssue: async () => ({ ...TICKET }),
        issueComments: async () => [{ user: { login: 'me' }, created_at: '2026-07-25T10:00:00Z', body: 'r' }],
        commitsOnBranch: async () => { throw new Error('must not be called') },
      },
      journal: (type, data) => journalled.push({ type, ...data }),
      withMapLock: (key, fn) => fn(),
    })
    assert.equal(out.land.state, 'skipped')
  })
})

// The `open_pull_request` tool's body. One ticket, one pull request, however many
// review rounds it takes (#54 item 1).
describe('landBranch', () => {
  function land({ commits = [{ sha: 'abc1234', subject: 'do it' }], pr = null, ...over } = {}) {
    return landBranch({
      repo: 'o/r', ticket: '42', title: 'a ticket', summary: 'what it does',
      worker: 'curia-42', model: 'opus', wtPath: '/w/42', basePath: '/b', branch: 'curia/42',
      deps: {
        defaultBranchOf: async () => 'main',
        commitsOnBranch: async () => commits,
        pushBranch: async (wt, repo, branch) => { calls.push({ op: 'push', branch }); return 'abc1234' },
        findPullRequest: async () => pr,
        createPullRequest: async (repo, opts) => { calls.push({ op: 'pr', ...opts }); return 'https://github.com/o/r/pull/7' },
        setPullRequestBody: async (repo, n, body) => { calls.push({ op: 'prEdit', n, body }) },
        ...over,
      },
      journal: (type, data) => journalled.push({ type, ...data }),
    })
  }

  test('the first call pushes and opens, with the commit list read out of git', async () => {
    const out = await land()
    assert.equal(out.state, 'opened')
    assert.equal(out.url, 'https://github.com/o/r/pull/7')
    assert.deepEqual(calls.map((c) => c.op), ['push', 'pr'])
    assert.match(calls[1].body, /`abc1234` do it/)
    assert.equal(calls[1].base, 'main')
    assert.ok(journalled.some((e) => e.type === 'pr_opened'))
  })

  test('a later call after a rejection updates the SAME pull request in place', async () => {
    const out = await land({ pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } })
    assert.equal(out.state, 'updated')
    assert.deepEqual(calls.map((c) => c.op), ['push', 'prEdit'])
    assert.ok(!calls.some((c) => c.op === 'pr'), 'gh pr create fails on an existing open head')
    assert.ok(journalled.some((e) => e.type === 'pr_reused'))
  })

  test('a MERGED pull request from an earlier round is not reused — it cannot carry new commits', async () => {
    const out = await land({ pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED' } })
    assert.equal(out.state, 'opened')
    assert.ok(calls.some((c) => c.op === 'pr'))
  })

  test('no commits ⇒ nothing pushed, and the worker is told to commit first', async () => {
    const out = await land({ commits: [] })
    assert.equal(out.ok, false)
    assert.equal(out.state, 'no-commits')
    assert.deepEqual(calls.map((c) => c.op), [])
    assert.ok(journalled.some((e) => e.type === 'land_skipped'))
  })
})

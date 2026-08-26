// The questions the daemon asks the journal about the past (#408).
//
// Every one of these was a whole read of the journal and a loop over the array
// until this file's subject existed. The rules they run under are not obvious,
// and each one was found live:
//
//   - The EPOCH cut. A pull request or an approval from an earlier dispatch of
//     the same ticket is not this agent's.
//   - The `(ticket or agent)` pair. One dispatch writes under both keys, and
//     either one answers.
//   - The LAST SPAWN reset for the agent-keyed questions. A session name is
//     reused by every dispatch of its ticket.
//   - Predicate narrowing. Three questions take the last event that CARRIES a
//     field, and not the plain last one.
//   - The #184 spelling. `body` is verbatim, so a line written before that
//     rename says `worker` and `backend`.
//
// `prototypes/journal-schema/` holds the same queries checked against the
// dispatcher's own loop over about 17,000 comparisons. This file pins the rules
// one at a time, so a future edit that breaks one says which.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Journal } from '../src/journal.mjs'
import { Questions } from '../src/questions.mjs'

// A journal in memory, and the questions over it. `ts` defaults to a stamp that
// only goes up, because no question orders by it and every one of them must
// still be right when two events tie.
function ask(events) {
  const j = new Journal(':memory:')
  for (const ev of events) {
    j.append(JSON.stringify({ ts: '2026-08-16T10:00:00.000Z', ...ev }))
  }
  return new Questions(j.db)
}

const spawn = (ticket, agent, extra = {}) => ({
  type: 'agent_spawned', ticket, agent, repo: 'o/r', model: 'opus', harness: 'claude', ...extra,
})

describe('the map snapshot facts', () => {
  test('one indexed read returns the latest event by journal order and the current agent', () => {
    const q = ask([
      spawn('11', 'curia-11', { ts: '2026-08-16T12:00:00.000Z' }),
      { type: 'notify', ticket: '11', agent: 'curia-11', ts: '2026-08-16T11:00:00.000Z' },
      spawn('11', 'curia-11', { repo: 'other/repo', model: 'gpt', harness: 'codex', ts: '2026-08-16T13:00:00.000Z' }),
      spawn('12', 'curia-12', { ts: '2026-08-16T09:00:00.000Z' }),
      { type: 'dispatch_claimed', ticket: '12', agent: 'curia-12', repo: 'o/r', ts: '2026-08-16T10:00:00.000Z' },
    ])

    assert.deepEqual([...q.mapSnapshotFacts('o/r', [10, 11, 12])], [
      ['10', { latest_event_id: null, latest_event_at: null, agent: null }],
      ['11', {
        latest_event_id: 2,
        latest_event_at: '2026-08-16T11:00:00.000Z',
        agent: {
          session: 'curia-11', model: 'opus', harness: 'claude', started_at: '2026-08-16T12:00:00.000Z',
        },
      }],
      ['12', { latest_event_id: 5, latest_event_at: '2026-08-16T10:00:00.000Z', agent: null }],
    ])
  })
})

describe('a journal nothing has written answers, and never guesses (#408)', () => {
  test('every question has an answer for a key that never existed', () => {
    const q = ask([])
    assert.deepEqual(q.epochScan('42', 'curia-42'), { prOpened: false, reviewApproved: false, blocks: 0 })
    assert.equal(q.verdictIsLate('42'), false)
    assert.equal(q.lastClaimAt('42'), null)
    assert.equal(q.epochRepo('42'), null)
    assert.deepEqual(q.epochCharting('42'), { charting: false, instruction: null, newMap: false })
    assert.equal(q.epochSpawn('curia-42'), null)
    assert.equal(q.adoptedMap('curia-42'), null)
    assert.equal(q.endingClause('curia-42'), null)
    assert.equal(q.reviewerSpawn('curia-review-42'), null)
    assert.deepEqual([...q.epochs()], [])
    assert.equal(q.reportedAfterEpoch('42', 'curia-42'), false)
    assert.equal(q.closedAfterEpoch('42', 'curia-42'), false)
    assert.deepEqual(q.lastResult('curia-42'), { at: null, deferred: false })
  })
})

describe('the epoch cut: what happened SINCE this ticket was last dispatched', () => {
  test('a pull request from the previous dispatch is not this one\'s', () => {
    const q = ask([
      spawn('42', 'curia-42'),
      { type: 'pr_opened', ticket: '42', agent: 'curia-42', url: 'https://example.invalid/1' },
      { type: 'dispatch_claimed', ticket: '42', agent: 'curia-42', repo: 'o/r' },
    ])
    assert.equal(q.epochScan('42', 'curia-42').prOpened, false)
  })

  test('and one after it is', () => {
    const q = ask([
      spawn('42', 'curia-42'),
      { type: 'pr_opened', ticket: '42', agent: 'curia-42' },
    ])
    assert.equal(q.epochScan('42', 'curia-42').prOpened, true)
  })

  test('either key answers: the ticket, or the agent', () => {
    const byTicket = ask([spawn('42', 'curia-42'), { type: 'pr_reused', ticket: '42' }])
    assert.equal(byTicket.epochScan('42', 'curia-42').prOpened, true)
    const byAgent = ask([spawn('42', 'curia-42'), { type: 'land_repaired', agent: 'curia-42' }])
    assert.equal(byAgent.epochScan('42', 'curia-42').prOpened, true)
    // And a third ticket's pull request is neither.
    const neither = ask([spawn('42', 'curia-42'), { type: 'pr_opened', ticket: '77', agent: 'curia-77' }])
    assert.equal(neither.epochScan('42', 'curia-42').prOpened, false)
  })

  test('only an APPROVAL counts at the gate, never a rejection', () => {
    const rejected = ask([spawn('42', 'curia-42'), { type: 'review_answered', ticket: '42', approved: false }])
    assert.equal(rejected.epochScan('42', 'curia-42').reviewApproved, false)
    const approved = ask([spawn('42', 'curia-42'), { type: 'review_answered', ticket: '42', approved: true }])
    assert.equal(approved.epochScan('42', 'curia-42').reviewApproved, true)
  })

  test('the Stop-hook count is per AGENT, and it restarts at the dispatch', () => {
    const q = ask([
      spawn('42', 'curia-42'),
      { type: 'stop_blocked', ticket: '42', agent: 'curia-42' },
      { type: 'dispatch_claimed', ticket: '42', agent: 'curia-42', repo: 'o/r' },
      { type: 'stop_blocked', ticket: '42', agent: 'curia-42' },
      { type: 'stop_blocked', ticket: '42', agent: 'curia-42' },
      // The reviewer's own nudges are its own.
      { type: 'stop_blocked', ticket: '42', agent: 'curia-review-42' },
    ])
    assert.equal(q.epochScan('42', 'curia-42').blocks, 2)
    assert.equal(q.epochScan('42', 'curia-review-42').blocks, 1)
  })

  test('a reviewer spawn moves the builder\'s epoch, because it carries the ticket', () => {
    // Surprising, and deliberate: the daemon's own loop did this, so the query
    // reproduces it rather than quietly improving on it.
    const q = ask([
      spawn('42', 'curia-42'),
      { type: 'pr_opened', ticket: '42', agent: 'curia-42' },
      spawn('42', 'curia-review-42'),
    ])
    assert.equal(q.epochScan('42', 'curia-42').prOpened, false)
  })
})

describe('the reconcile guards', () => {
  test('a result after the dispatch stops the orphan sweep', () => {
    const before = ask([{ type: 'result', ticket: '42', agent: 'curia-42' }, spawn('42', 'curia-42')])
    assert.equal(before.reportedAfterEpoch('42', 'curia-42'), false)
    const after = ask([spawn('42', 'curia-42'), { type: 'result', ticket: '42', agent: 'curia-42' }])
    assert.equal(after.reportedAfterEpoch('42', 'curia-42'), true)
  })

  test('three events close an epoch, and a stale one from an earlier dispatch does not', () => {
    for (const type of ['result', 'lifecycle_closed', 'dispatch_unclaimed']) {
      const q = ask([spawn('42', 'curia-42'), { type, ticket: '42', agent: 'curia-42' }])
      assert.equal(q.closedAfterEpoch('42', 'curia-42'), true, type)
    }
    const stale = ask([
      { type: 'lifecycle_closed', ticket: '42', agent: 'curia-42' },
      spawn('42', 'curia-42'),
    ])
    assert.equal(stale.closedAfterEpoch('42', 'curia-42'), false)
  })

  test('every ticket\'s latest dispatch, with the repo that dispatch named', () => {
    const q = ask([
      spawn('42', 'curia-42', { repo: 'o/r' }),
      spawn('77', 'curia-77', { repo: 'o/other' }),
      { type: 'dispatch_claimed', ticket: '42', agent: 'curia-42', repo: 'o/moved' },
      { type: 'notify', message: 'no ticket, no row here' },
    ])
    assert.deepEqual([...q.epochs()], [['42', { repo: 'o/moved' }], ['77', { repo: 'o/other' }]])
  })

  test('the stale-question pass: the last result, and the ending deferred to a question', () => {
    const reported = ask([spawn('42', 'curia-42'), { type: 'result', agent: 'curia-42', ts: '2026-08-16T11:00:00.000Z' }])
    assert.deepEqual(reported.lastResult('curia-42'), { at: '2026-08-16T11:00:00.000Z', deferred: false })

    const deferred = ask([
      spawn('42', 'curia-42'),
      { type: 'result', agent: 'curia-42', ts: '2026-08-16T11:00:00.000Z' },
      { type: 'agent_blocked_on_human', agent: 'curia-42' },
    ])
    assert.equal(deferred.lastResult('curia-42').deferred, true)

    // A block BEFORE the result deferred nothing: the ending had not run yet.
    const early = ask([
      spawn('42', 'curia-42'),
      { type: 'agent_blocked_on_human', agent: 'curia-42' },
      { type: 'result', agent: 'curia-42', ts: '2026-08-16T11:00:00.000Z' },
    ])
    assert.equal(early.lastResult('curia-42').deferred, false)

    // A respawn clears both: the next dispatch reported nothing yet.
    const respawned = ask([
      spawn('42', 'curia-42'),
      { type: 'result', agent: 'curia-42' },
      { type: 'agent_blocked_on_human', agent: 'curia-42' },
      spawn('42', 'curia-42'),
    ])
    assert.deepEqual(respawned.lastResult('curia-42'), { at: null, deferred: false })
  })
})

describe('the last event of a type for a key', () => {
  test('the merge outran the reviewer, and only in that order', () => {
    const late = ask([
      { type: 'reviewer_spawned', ticket: '42', agent: 'curia-review-42' },
      { type: 'ticket_resolved', ticket: '42', agent: 'curia-42' },
    ])
    assert.equal(late.verdictIsLate('42'), true)
    const inTime = ask([
      { type: 'ticket_resolved', ticket: '42', agent: 'curia-42' },
      { type: 'reviewer_spawned', ticket: '42', agent: 'curia-review-42' },
    ])
    assert.equal(inTime.verdictIsLate('42'), false)
    // No reviewer at all: nothing was outrun.
    const noReviewer = ask([{ type: 'ticket_resolved', ticket: '42', agent: 'curia-42' }])
    assert.equal(noReviewer.verdictIsLate('42'), false)
  })

  test('the last claim is a claim, and a spawn is not one', () => {
    const q = ask([
      { type: 'dispatch_claimed', ticket: '42', agent: 'curia-42', repo: 'o/r', ts: '2026-08-16T09:00:00.000Z' },
      { type: 'dispatch_claimed', ticket: '42', agent: 'curia-42', repo: 'o/r', ts: '2026-08-16T12:00:00.000Z' },
      spawn('42', 'curia-42', { ts: '2026-08-16T13:00:00.000Z' }),
    ])
    assert.equal(q.lastClaimAt('42'), '2026-08-16T12:00:00.000Z')
  })

  test('the repo is the last dispatch that CARRIES one', () => {
    const q = ask([
      spawn('42', 'curia-42', { repo: 'o/r' }),
      { type: 'dispatch_claimed', ticket: '42', agent: 'curia-42' }, // no repo on the line
    ])
    assert.equal(q.epochRepo('42'), 'o/r')
  })

  test('the charting kind, and what rode it, off the last spawn line', () => {
    const q = ask([
      spawn('chat-1', 'curia-chat-1', { kind: 'charting', newMap: true, instruction: 'chart it' }),
    ])
    assert.deepEqual(q.epochCharting('chat-1'), { charting: true, instruction: 'chart it', newMap: true })
    // A respawn restates the kind whole (#219), so the last line decides.
    const reDispatched = ask([
      spawn('42', 'curia-42', { kind: 'charting' }),
      spawn('42', 'curia-42', { kind: 'ticket' }),
    ])
    assert.equal(reDispatched.epochCharting('42').charting, false)
  })

  test('the model and harness of the last spawn, keyed by SESSION', () => {
    const q = ask([
      spawn('42', 'curia-42', { model: 'opus', harness: 'claude' }),
      spawn('42', 'curia-42', {
        model: 'codex-high', requested_model: 'opus', harness: 'codex',
        reasoning_effort: 'xhigh', prompt_carries_limit_text: true,
      }),
    ])
    assert.deepEqual(q.epochSpawn('curia-42'), {
      model: 'codex-high', requested_model: 'opus', harness: 'codex', reasoning_effort: 'xhigh',
      prompt_carries_limit_text: true, skill: null, skill_target: null,
    })
  })

  test('a pre-#184 line answers with today\'s spelling, and body keeps the old one', () => {
    // Verbatim off the box: a spawn line written when the process was a worker
    // and the program under it was its backend.
    const q = ask([{ type: 'worker_spawned', ticket: '170', worker: 'curia-170', model: 'opus', backend: 'claude' }])
    assert.deepEqual(q.epochSpawn('curia-170'), {
      model: 'opus', requested_model: null, harness: 'claude', reasoning_effort: null,
      prompt_carries_limit_text: null, skill: null, skill_target: null,
    })
    assert.deepEqual([...q.epochs()], [['170', { repo: null }]])
  })

  test('the reviewer spawn comes back whole, because adoption rebuilds a record from it', () => {
    const q = ask([{
      type: 'reviewer_spawned', ticket: '42', agent: 'curia-review-42', repo: 'o/r',
      model: 'codex-high', builder_model: 'opus', same_provider: false, sha: 'deadbeef',
      checkout: '/w/review/42', base_branch: 'main', sandbox: 'docker',
    }])
    const spawned = q.reviewerSpawn('curia-review-42')
    assert.equal(spawned.ticket, '42')
    assert.equal(spawned.repo, 'o/r')
    assert.equal(spawned.builder_model, 'opus')
    assert.equal(spawned.same_provider, false)
    assert.equal(spawned.checkout, '/w/review/42')
    assert.equal(spawned.base_branch, 'main')
  })
})

describe('the agent-keyed questions reset at the session\'s last spawn', () => {
  test('the map this session reported, and not the one before it', () => {
    const q = ask([
      spawn('chat-1', 'curia-chat-1'),
      { type: 'map_adopted', ticket: 'chat-1', agent: 'curia-chat-1', map: '250' },
    ])
    assert.equal(q.adoptedMap('curia-chat-1'), '250')

    const respawned = ask([
      spawn('chat-1', 'curia-chat-1'),
      { type: 'map_adopted', ticket: 'chat-1', agent: 'curia-chat-1', map: '250' },
      spawn('chat-1', 'curia-chat-1'),
    ])
    assert.equal(respawned.adoptedMap('curia-chat-1'), null, 'that map exists now, and `map <n>` is the verb for it')
  })

  test('the ending sentence is the last carrier that carries one', () => {
    const q = ask([
      spawn('42', 'curia-42'),
      { type: 'ticket_resolved', ticket: '42', agent: 'curia-42', summary: 'the queries landed' },
      { type: 'nonclean_noted', ticket: '42', agent: 'curia-42' }, // no summary on this line
    ])
    assert.equal(q.endingClause('curia-42'), 'the queries landed')

    const carriers = ['ticket_resolved', 'nonclean_noted', 'charting_finished']
    for (const type of carriers) {
      const one = ask([spawn('42', 'curia-42'), { type, ticket: '42', agent: 'curia-42', summary: `said by ${type}` }])
      assert.equal(one.endingClause('curia-42'), `said by ${type}`)
    }

    const respawned = ask([
      spawn('42', 'curia-42'),
      { type: 'ticket_resolved', ticket: '42', agent: 'curia-42', summary: 'the last dispatch said this' },
      spawn('42', 'curia-42'),
    ])
    assert.equal(respawned.endingClause('curia-42'), null)
  })
})

describe('an unreadable journal is not an empty one', () => {
  test('a question over a closed connection throws instead of answering "never"', () => {
    const j = new Journal(':memory:')
    j.append(JSON.stringify({ ts: '2026-08-16T10:00:00.000Z', ...spawn('42', 'curia-42') }))
    const q = new Questions(j.db)
    j.close()
    assert.throws(() => q.epochScan('42', 'curia-42'), /events journal is unreadable/)
  })
})

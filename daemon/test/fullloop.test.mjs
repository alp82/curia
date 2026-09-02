// The Full loop as the installation acceptance (#882, under the #857
// acceptance contract and the #853 journey).
//
// One real pass through Curia's own machinery is the final checkpoint: the
// frontier read finds the ticket marked for the rehearsal, the dispatcher
// spawns the agent, and every later leg is what the daemon already journals
// while the agent works. This file pins the rules the run is judged by, at
// the seam the daemon routes and the page both cross:
//
//   - the ticket is the one marked `rehearsal` on the selected repository's
//     frontier, and nothing else is accepted;
//   - a leg is complete only on the row Curia's machinery writes for it, in
//     order, after this run's spawn: a row from before the run, from another
//     ticket, from another session, or out of order counts for nothing;
//   - the run is complete only when every leg is, on one pass, and no marker
//     (not even the run's own completion row) can stand in for the legs;
//   - a failure names the leg, one cause, one action, and a same-step retry.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { FullLoop, LEGS, REHEARSAL_LABEL } from '../src/fullloop.mjs'

const TOKEN = 'MTIz.this-value-must-never-be-printed.abc'

// The gate's answer at convergence (#880), the shape the run starts on.
const gate = (over = {}) => ({
  ready: true,
  reason: null,
  facts: {
    verified_at: '2026-09-02T10:00:00.000Z',
    github: { repo: 'o/r', covered: ['o/r', 'o/other'], owners: [{ owner: 'o', installed: true }], open_tickets: 4, ticket: null },
    discord: {
      guild: { id: '200', name: 'AI Stack' },
      channel: { id: '400', name: 'curia', url: 'https://discord.com/channels/200/400' },
      operator: { id: '100', username: 'alp', name: 'Alp' },
      commands: ['start'], confirmation: { id: '900', at: '2026-09-02T09:00:00.000Z', posted: false, url: 'https://discord.com/channels/200/400/900' }, bridge: 'up',
    },
    tailscale: { address: 'curia.tail1234.ts.net', app_url: 'https://curia.tail1234.ts.net:8445/', operator: 'alp@example.com', admitted_ms: 12 },
    model: { provider: 'anthropic', model: 'fable', request: null, rows: [], providers: { openai: 'unconnected', anthropic: 'connected' } },
    ...over,
  },
})

// A frontier the dispatcher would answer for `o/r`: three takeable tickets,
// one of them marked for the rehearsal.
const frontier = (items = null) => ({
  repo: 'o/r',
  lane: 'map',
  numbers: (items ?? DEFAULT_ITEMS).map((i) => i.number),
  items: items ?? DEFAULT_ITEMS,
})
const DEFAULT_ITEMS = [
  { number: 41, title: 'Plain ticket', labels: ['wayfinder:task', 'ready-for-agent'], map: 40, mapTitle: 'The map' },
  { number: 42, title: 'The rehearsal ticket', labels: ['wayfinder:task', 'ready-for-agent', REHEARSAL_LABEL], map: 40, mapTitle: 'The map' },
  { number: 43, title: 'Another marked ticket', labels: ['wayfinder:task', REHEARSAL_LABEL], map: 40, mapTitle: 'The map' },
]

// The journal, doubled: rows with ids in write order and a clock that only
// goes up. `eventsSince` hands back EVERY row after the id and filters by
// nothing, so what the module accepts is the module's own rule and not the
// fake's. The SQL half of that filter is pinned in questions.test.mjs.
function fakeJournal() {
  const rows = []
  let t = Date.parse('2026-09-02T10:00:00.000Z')
  const clock = { now: () => new Date(t), tick: (ms = 1000) => { t += ms } }
  const write = (type, data = {}) => {
    const row = { id: rows.length + 1, ts: clock.now().toISOString(), type, ticket: data.ticket != null ? String(data.ticket) : null, agent: data.agent ?? null, body: JSON.stringify({ ts: clock.now().toISOString(), type, ...data }) }
    rows.push(row)
    clock.tick()
    return row
  }
  return {
    rows,
    clock,
    write,
    journal: (type, data) => { write(type, data) },
    lastRun: () => rows.filter((r) => r.type === 'full_loop_started').at(-1) ?? null,
    eventsSince: (id) => rows.filter((r) => r.id > id),
  }
}

// The rows the daemon writes while a rehearsal runs, in the order they land
// on a clean pass. Each helper writes one leg's evidence for ticket 42. The
// dispatcher's `start` writes the spawn rows before it answers, so the fake
// dispatch below does the same, and a clean pass picks up after it.
const AGENT = 'curia-42'
function spawnRows(j, { ticket = '42', agent = AGENT } = {}) {
  j.write('dispatch_claimed', { repo: 'o/r', ticket, agent, title: 'The rehearsal ticket' })
  j.write('thread_bound', { repo: 'o/r', ticket, thread_id: '777' })
  j.write('agent_spawned', { repo: 'o/r', ticket, agent, model: 'fable', harness: 'claude' })
  j.write('agent_ready', { repo: 'o/r', ticket, agent })
}
function cleanPass(j, { ticket = '42', agent = AGENT, from = 'escalation' } = {}) {
  const legs = {
    dispatch: () => spawnRows(j, { ticket, agent }),
    escalation: () => {
      j.write('esc_open', { id: 'esc-1', agent, ticket, kind: 'free-text', prompt: 'Which name?' })
      j.write('esc_answer', { id: 'esc-1', answer: 'The second one', by: 'alp' })
    },
    pull_request: () => j.write('pr_opened', { repo: 'o/r', ticket, agent, branch: 'curia/42', url: 'https://github.com/o/r/pull/50', commits: 2 }),
    review: () => {
      j.write('esc_open', { id: 'esc-2', agent, ticket, kind: 'review-gate', prompt: 'Review?' })
      j.write('esc_answer', { id: 'esc-2', answer: 'approve', by: 'alp' })
      j.write('pr_approved', { repo: 'o/r', ticket, agent, branch: 'curia/42', pr: 'https://github.com/o/r/pull/50', number: 50 })
      j.write('review_answered', { repo: 'o/r', ticket, agent, approved: true, via: 'gate' })
    },
    resolved: () => {
      j.write('map_pointer_appended', { repo: 'o/r', map: 40, ticket, line: '- [The rehearsal ticket](https://github.com/o/r/issues/42) — done' })
      j.write('ticket_resolved', { repo: 'o/r', ticket, agent, comment: 'present', close: 'present', map: 'appended', land: 'merged', pr: 'https://github.com/o/r/pull/50', repaired: [], summary: '✅ resolved' })
      j.write('result', { repo: 'o/r', ticket, agent, status: 'resolved' })
      j.write('lifecycle_closed', { repo: 'o/r', ticket, agent, kind: 'ticket' })
    },
  }
  const order = ['dispatch', 'escalation', 'pull_request', 'review', 'resolved']
  for (const key of order.slice(order.indexOf(from))) legs[key]()
}

describe('the Full loop as the installation acceptance (#882)', () => {
  let j
  let dispatched
  let loop
  beforeEach(() => {
    j = fakeJournal()
    dispatched = []
    loop = new FullLoop({
      discover: async (repo) => frontier(),
      // A dispatch clones and starts a container before it spawns, so the
      // fake yields once before its rows land: the press answers first.
      dispatch: async (repo, n) => { dispatched.push(`${repo}#${n}`); await null; spawnRows(j, { ticket: String(n), agent: `curia-${n}` }); return `⚙️ dispatched ${repo}#${n} → \`curia-${n}\` on **fable**` },
      journal: j.journal,
      lastRun: j.lastRun,
      eventsSince: j.eventsSince,
      now: j.clock.now,
      log: () => {},
    })
  })

  test('the eight legs are the accepted ones, in the accepted order', () => {
    assert.deepEqual(LEGS.map((l) => l.key), ['discovery', 'dispatch', 'escalation', 'pull_request', 'review', 'merge', 'resolution', 'map_update'])
    assert.equal(REHEARSAL_LABEL, 'rehearsal')
  })

  test('with no run there is nothing to report, and nothing is read from anywhere but the journal', () => {
    const s = loop.status()
    assert.equal(s.state, 'idle')
    assert.equal(s.repo, null)
    assert.deepEqual(s.legs.map((l) => l.state), LEGS.map(() => 'pending'))
  })

  test('the press refuses a closed gate and runs nothing', async () => {
    await assert.rejects(() => loop.start({ ready: false, reason: 'Waiting for Discord.', facts: null }), (e) => e.refusal && /isn't ready: Waiting for Discord\./.test(e.message))
    assert.deepEqual(dispatched, [])
    assert.deepEqual(j.rows, [])
  })

  test('the press selects the covered repository and the ticket marked for the rehearsal, then dispatches that ticket and no other', async () => {
    const s = await loop.start(gate())
    assert.equal(s.state, 'running')
    assert.equal(s.repo, 'o/r')
    assert.deepEqual(s.ticket, { number: 42, title: 'The rehearsal ticket', url: 'https://github.com/o/r/issues/42', map: 40 })
    assert.equal(s.legs[0].state, 'complete', 'discovery is the frontier read that found the marked ticket')
    assert.equal(s.legs[1].state, 'running')
    assert.deepEqual(dispatched, ['o/r#42'])
    await loop.settled()
    assert.equal(loop.status().legs[1].state, 'complete', 'the spawn row is the dispatch')
    assert.equal(loop.status().legs[2].state, 'running')
    // The run's own rows name the repository, the ticket, and the channel,
    // and nothing secret.
    assert.deepEqual(j.rows.slice(0, 2).map((r) => r.type), ['full_loop_started', 'full_loop_discovered'])
    assert.equal(JSON.parse(j.rows[1].body).ticket, 42)
    assert.equal(s.links.channel, 'https://discord.com/channels/200/400')
  })

  test('the operator may name the ticket, and it still has to be marked and on the frontier', async () => {
    const named = await loop.start(gate(), { ticket: 43 })
    assert.equal(named.ticket.number, 43)
    assert.deepEqual(dispatched, ['o/r#43'])

    // Not marked: refused at the press, nothing dispatched, no run opened.
    const j2 = fakeJournal()
    const plain = new FullLoop({ discover: async () => frontier(), dispatch: async () => 'never', journal: j2.journal, lastRun: j2.lastRun, eventsSince: j2.eventsSince, now: j2.clock.now, log: () => {} })
    const s = await plain.start(gate(), { ticket: 41 })
    assert.equal(s.state, 'failed')
    assert.equal(s.failed.leg, 'discovery')
    assert.match(s.failed.cause, /o\/r#41 is not marked rehearsal/)
    assert.match(s.failed.action, /Add the rehearsal label to o\/r#41, then select Try again\./)

    // Not on the frontier at all (claimed, blocked, or closed): the same leg.
    const j3 = fakeJournal()
    const gone = new FullLoop({ discover: async () => frontier(), dispatch: async () => 'never', journal: j3.journal, lastRun: j3.lastRun, eventsSince: j3.eventsSince, now: j3.clock.now, log: () => {} })
    const off = await gone.start(gate(), { ticket: 99 })
    assert.equal(off.failed.leg, 'discovery')
    assert.match(off.failed.cause, /o\/r#99 is not on the frontier of o\/r/)
  })

  test('a repository outside the covered ones is refused by name', async () => {
    await assert.rejects(() => loop.start(gate(), { repo: 'x/y' }), (e) => e.refusal && /x\/y is not a covered repository/.test(e.message))
    assert.deepEqual(dispatched, [])
  })

  test('no marked ticket on the frontier fails discovery with the labelling action, and Try again re-reads the frontier', async () => {
    let items = DEFAULT_ITEMS.filter((i) => !i.labels.includes(REHEARSAL_LABEL))
    loop = new FullLoop({
      discover: async () => frontier(items),
      dispatch: async (repo, n) => { dispatched.push(`${repo}#${n}`); spawnRows(j, { ticket: String(n), agent: `curia-${n}` }); return 'ok' },
      journal: j.journal, lastRun: j.lastRun, eventsSince: j.eventsSince, now: j.clock.now, log: () => {},
    })
    const s = await loop.start(gate())
    assert.equal(s.state, 'failed')
    assert.deepEqual(s.failed, {
      leg: 'discovery', title: 'Frontier discovery',
      cause: 'No takeable ticket of o/r is marked rehearsal.',
      action: 'Label one open, unassigned, unblocked ticket of o/r with rehearsal, then select Try again.',
    })
    assert.deepEqual(dispatched, [], 'nothing is dispatched on a failed discovery')
    assert.equal(loop.status().state, 'failed', 'the failure is read back from the journal')

    // The operator labels a ticket and retries the same leg.
    items = DEFAULT_ITEMS
    const again = await loop.retry()
    assert.equal(again.state, 'running')
    assert.equal(again.legs[0].state, 'complete')
    assert.deepEqual(dispatched, ['o/r#42'])
    assert.ok(j.rows.some((r) => r.type === 'full_loop_retry'))
  })

  test('a frontier that cannot be read fails discovery with the GitHub card as the action', async () => {
    loop = new FullLoop({
      discover: async () => ({ repo: 'o/r', error: 'gh: HTTP 401' }),
      dispatch: async () => 'never',
      journal: j.journal, lastRun: j.lastRun, eventsSince: j.eventsSince, now: j.clock.now, log: () => {},
    })
    const s = await loop.start(gate())
    assert.equal(s.failed.leg, 'discovery')
    assert.equal(s.failed.cause, 'curia could not read the frontier of o/r: gh: HTTP 401')
    assert.match(s.failed.action, /Check the GitHub card/)
  })

  test('a dispatch the dispatcher refuses fails the dispatch leg with the refusal as the cause', async () => {
    loop = new FullLoop({
      discover: async () => frontier(),
      dispatch: async () => '❌ o/r#42 still has a clone on disk from an earlier agent',
      journal: j.journal, lastRun: j.lastRun, eventsSince: j.eventsSince, now: j.clock.now, log: () => {},
    })
    await loop.start(gate())
    await loop.settled()
    const s = loop.status()
    assert.equal(s.state, 'failed')
    assert.equal(s.failed.leg, 'dispatch')
    assert.match(s.failed.cause, /still has a clone on disk/)
    assert.match(s.failed.action, /then select Try again/)
    assert.equal(s.legs[0].state, 'complete', 'the completed leg stands')
  })

  test('a dispatch that throws fails the same way, and the run never hangs', async () => {
    loop = new FullLoop({
      discover: async () => frontier(),
      dispatch: async () => { throw new Error('docker is not running') },
      journal: j.journal, lastRun: j.lastRun, eventsSince: j.eventsSince, now: j.clock.now, log: () => {},
    })
    await loop.start(gate())
    await loop.settled()
    assert.equal(loop.status().failed.leg, 'dispatch')
    assert.match(loop.status().failed.cause, /docker is not running/)
  })

  test('a clean pass completes every leg in order, links the real artifacts, and reports the elapsed time', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j)
    const s = loop.status()
    assert.equal(s.state, 'complete')
    assert.deepEqual(s.legs.map((l) => l.state), LEGS.map(() => 'complete'))
    assert.deepEqual(s.legs.map((l) => l.key), LEGS.map((l) => l.key))
    for (const leg of s.legs) assert.ok(leg.at && leg.ms >= 0, `${leg.key} is stamped`)
    assert.deepEqual(s.links, {
      ticket: 'https://github.com/o/r/issues/42',
      thread: 'https://discord.com/channels/200/777',
      channel: 'https://discord.com/channels/200/400',
      pull_request: 'https://github.com/o/r/pull/50',
      map: 'https://github.com/o/r/issues/40',
    })
    assert.equal(s.legs.find((l) => l.key === 'escalation').link, 'https://discord.com/channels/200/777')
    assert.equal(s.legs.find((l) => l.key === 'merge').link, 'https://github.com/o/r/pull/50')
    assert.equal(s.legs.find((l) => l.key === 'map_update').link, 'https://github.com/o/r/issues/40')
    // Elapsed is the last leg's row against the run's own start row.
    const started = Date.parse(JSON.parse(j.rows[0].body).ts)
    const last = Date.parse(j.rows.find((r) => r.type === 'ticket_resolved').ts)
    assert.equal(s.elapsed_ms, last - started)
    assert.equal(s.finished_at, new Date(last).toISOString())
    assert.equal(s.failed, null)
    // The completion is journalled once, as a record and never as a marker.
    assert.equal(j.rows.filter((r) => r.type === 'full_loop_completed').length, 1)
    loop.status()
    assert.equal(j.rows.filter((r) => r.type === 'full_loop_completed').length, 1)
    assert.ok(!JSON.stringify(s).includes(TOKEN))
  })

  test('a partial pass is running while the agent lives and failed at the first missing leg once it is gone', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j)
    // Undo the ending: a pass that stopped after the pull request.
    const cut = j.rows.findIndex((r) => r.type === 'pr_opened')
    j.rows.splice(cut + 1)
    let s = loop.status()
    assert.equal(s.state, 'running')
    assert.deepEqual(s.legs.map((l) => l.state), ['complete', 'complete', 'complete', 'complete', 'running', 'pending', 'pending', 'pending'])
    assert.ok(s.elapsed_ms > 0)

    j.write('lifecycle_closed', { repo: 'o/r', ticket: '42', agent: AGENT, kind: 'ticket', reason: 'the agent exited' })
    s = loop.status()
    assert.equal(s.state, 'failed')
    assert.deepEqual(s.failed, {
      leg: 'review', title: 'Review',
      cause: 'The agent ended before Review: the agent exited.',
      action: 'Read the thread of o/r#42 in #curia and fix what stopped the agent, then select Try again to dispatch o/r#42 again.',
    })
    assert.equal(s.legs[3].state, 'complete', 'completed legs are preserved')
    assert.equal(s.links.pull_request, 'https://github.com/o/r/pull/50')
  })

  test('a cancelled or died agent fails the run at the pending leg too', async () => {
    await loop.start(gate())
    await loop.settled()
    j.write('agent_cancelled', { repo: 'o/r', ticket: '42', agent: AGENT, by: 'alp' })
    const s = loop.status()
    assert.equal(s.state, 'failed')
    assert.equal(s.failed.leg, 'escalation')
    assert.match(s.failed.cause, /cancelled/)
  })

  test('a resolution without a merge, an unapproved review, or an unwritten map pointer never completes', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j)
    const resolved = j.rows.find((r) => r.type === 'ticket_resolved')
    const body = JSON.parse(resolved.body)

    resolved.body = JSON.stringify({ ...body, land: 'unmerged' })
    let s = loop.status()
    assert.equal(s.state, 'failed', 'the agent is gone and the merge never happened')
    assert.equal(s.failed.leg, 'merge')

    resolved.body = JSON.stringify({ ...body, map: 'append-unverified' })
    s = loop.status()
    assert.equal(s.failed.leg, 'map_update')
    assert.equal(s.legs.find((l) => l.key === 'resolution').state, 'complete')

    resolved.body = JSON.stringify({ ...body, close: 'unknown' })
    assert.equal(loop.status().failed.leg, 'resolution')

    resolved.body = JSON.stringify(body)
    const answered = j.rows.find((r) => r.type === 'review_answered')
    answered.body = JSON.stringify({ ...JSON.parse(answered.body), approved: false })
    s = loop.status()
    assert.equal(s.failed.leg, 'review')
    assert.equal(s.legs.find((l) => l.key === 'pull_request').state, 'complete')
  })

  test('rows from before the run, from another ticket, or from another session count for nothing', async () => {
    // A whole clean pass of ticket 42 from an EARLIER dispatch, before this run.
    cleanPass(j, { from: 'dispatch' })
    await loop.start(gate())
    await loop.settled()
    let s = loop.status()
    assert.equal(s.state, 'running')
    assert.deepEqual(s.legs.slice(1).map((l) => l.state), ['complete', 'running', 'pending', 'pending', 'pending', 'pending', 'pending'])
    assert.equal(s.legs[1].at, j.rows.filter((r) => r.type === 'agent_spawned').at(-1).ts, 'this run\'s own spawn, not the earlier one')

    // Another ticket's pass, interleaved after this run started.
    cleanPass(j, { ticket: '43', agent: 'curia-43', from: 'dispatch' })
    s = loop.status()
    assert.equal(s.legs[2].state, 'running', 'another ticket\'s question is not this agent\'s')
    assert.equal(s.state, 'running')

    // This ticket's rows under another session name are not this dispatch.
    cleanPass(j, { agent: 'curia-review-42', from: 'dispatch' })
    s = loop.status()
    assert.equal(s.state, 'running')
    assert.equal(s.legs[2].state, 'running')
  })

  test('legs out of order do not pass: a resolution row before the pull request is not a pass', async () => {
    await loop.start(gate())
    await loop.settled()
    j.write('esc_open', { id: 'e', agent: AGENT, ticket: '42', kind: 'free-text', prompt: '?' })
    j.write('esc_answer', { id: 'e', answer: 'yes' })
    j.write('ticket_resolved', { repo: 'o/r', ticket: '42', agent: AGENT, comment: 'present', close: 'present', map: 'appended', land: 'merged', pr: 'https://github.com/o/r/pull/50' })
    j.write('pr_opened', { repo: 'o/r', ticket: '42', agent: AGENT, branch: 'curia/42', url: 'https://github.com/o/r/pull/50' })
    j.write('review_answered', { repo: 'o/r', ticket: '42', agent: AGENT, approved: true })
    j.write('lifecycle_closed', { repo: 'o/r', ticket: '42', agent: AGENT })
    const s = loop.status()
    assert.equal(s.state, 'failed')
    assert.equal(s.failed.leg, 'merge')
  })

  test('the run\'s own completion row is a record, never a marker: alone, it completes nothing', async () => {
    await loop.start(gate())
    await loop.settled()
    j.write('full_loop_completed', { repo: 'o/r', ticket: '42', elapsed_ms: 1 })
    const s = loop.status()
    assert.equal(s.state, 'running')
    assert.equal(s.legs[2].state, 'running')
  })

  test('an escalation answered through the review gate is not the escalation leg, and an unanswered question is not either', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j)
    const rows = j.rows
    // Drop the free-text exchange, keep the gate.
    const open = rows.findIndex((r) => r.type === 'esc_open' && JSON.parse(r.body).kind === 'free-text')
    rows.splice(open, 2)
    let s = loop.status()
    assert.equal(s.state, 'failed')
    assert.equal(s.failed.leg, 'escalation')
    assert.equal(s.legs.find((l) => l.key === 'pull_request').state, 'pending', 'later rows do not count before the missing leg')

    // A question asked and never answered.
    j.rows.splice(rows.findIndex((r) => r.type === 'esc_open' && JSON.parse(r.body).kind === 'review-gate'))
    j.write('esc_open', { id: 'x', agent: AGENT, ticket: '42', kind: 'choice', prompt: '?' })
    s = loop.status()
    assert.equal(s.state, 'running')
    assert.equal(s.legs[2].state, 'running')
  })

  test('Try again after a failed dispatch dispatches the same ticket again, and only rows after the retry count', async () => {
    let refuse = true
    loop = new FullLoop({
      discover: async () => frontier(),
      dispatch: async (repo, n) => { dispatched.push(`${repo}#${n}`); if (refuse) return '❌ refused'; spawnRows(j); return 'ok' },
      journal: j.journal, lastRun: j.lastRun, eventsSince: j.eventsSince, now: j.clock.now, log: () => {},
    })
    await loop.start(gate())
    await loop.settled()
    assert.equal(loop.status().failed.leg, 'dispatch')
    // A stray spawn row between the failure and the retry is not the retry's.
    j.write('agent_spawned', { repo: 'o/r', ticket: '42', agent: AGENT })
    const stray = j.rows.at(-1)
    refuse = false
    const s = await loop.retry()
    await loop.settled()
    assert.deepEqual(dispatched, ['o/r#42', 'o/r#42'])
    assert.equal(s.state, 'running')
    const dispatch = loop.status().legs[1]
    assert.equal(dispatch.state, 'complete')
    assert.notEqual(dispatch.at, stray.ts, 'the stray spawn before the retry counts for nothing')
    assert.equal(dispatch.at, j.rows.filter((r) => r.type === 'agent_spawned').at(-1).ts)
    cleanPass(j)
    assert.equal(loop.status().state, 'complete')
  })

  test('Try again after the agent died dispatches the ticket again from the failed leg on, and the earlier pass is not this one', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j)
    j.rows.splice(j.rows.findIndex((r) => r.type === 'pr_opened') + 1)
    j.write('lifecycle_closed', { repo: 'o/r', ticket: '42', agent: AGENT })
    assert.equal(loop.status().failed.leg, 'review')
    const pressed = await loop.retry()
    assert.equal(pressed.state, 'running')
    assert.equal(pressed.legs[1].state, 'running', 'the retry is a fresh dispatch')
    await loop.settled()
    const s = loop.status()
    assert.equal(s.legs[0].state, 'complete', 'discovery stands')
    assert.equal(s.legs[1].state, 'complete')
    assert.equal(s.legs[2].state, 'running', 'and the earlier pass\'s rows are not this dispatch\'s')
    assert.deepEqual(dispatched, ['o/r#42', 'o/r#42'])
    cleanPass(j)
    assert.equal(loop.status().state, 'complete')
  })

  test('a second press while a run is live is refused, and Try again on a live run is too', async () => {
    await loop.start(gate())
    await loop.settled()
    await assert.rejects(() => loop.start(gate()), (e) => e.refusal && /already running on o\/r#42/.test(e.message))
    await assert.rejects(() => loop.retry(), (e) => e.refusal && /is running/.test(e.message))
    assert.deepEqual(dispatched, ['o/r#42'])
  })

  test('Try again with nothing failed is refused, and a new press after a complete run starts a new run', async () => {
    await assert.rejects(() => loop.retry(), (e) => e.refusal && /nothing to retry/i.test(e.message))
    await loop.start(gate())
    await loop.settled()
    cleanPass(j)
    assert.equal(loop.status().state, 'complete')
    const s = await loop.start(gate())
    assert.equal(s.state, 'running')
    assert.equal(s.legs[1].state, 'running')
    assert.equal(j.rows.filter((r) => r.type === 'full_loop_started').length, 2)
  })

  test('the status is read from the journal alone: a fresh instance over the same rows says the same', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j)
    const fresh = new FullLoop({ discover: async () => frontier(), dispatch: async () => 'never', journal: j.journal, lastRun: j.lastRun, eventsSince: j.eventsSince, now: j.clock.now, log: () => {} })
    assert.deepEqual(fresh.status(), loop.status())
    assert.equal(fresh.status().state, 'complete')
  })
})

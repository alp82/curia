// The Test run as the installation acceptance (#882, under the #857
// acceptance contract and the #853 journey; reshaped by the #891 rehearsal).
//
// One real pass through Curia's own machinery is the final checkpoint: the
// press creates a tiny map with two tickets, the frontier read finds each in
// turn, the dispatcher spawns the agent, and every later leg is what the
// daemon already journals while the agent works. This file pins the rules the
// run is judged by, at the seam the daemon routes and the page both cross:
//
//   - the press creates the map and its two tickets in the covered
//     repository, the second blocked by the first, both marked `rehearsal`,
//     and a retry resumes the same map;
//   - a leg is complete only on the row Curia's machinery writes for it, in
//     order, after this run's spawn: a row from before the run, from another
//     ticket, from another session, or out of order counts for nothing;
//   - ticket 1 walks the eight legs, then ticket 2, then the map closes on
//     Curia's own map lifecycle; the run is complete only then, and no
//     marker (not even the run's own completion row) can stand in for it;
//   - a failure names the leg, one cause, one action, and a same-step retry;
//   - what the run waits for carries the message the bridge posted.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { FullLoop, LEGS, REHEARSAL_LABEL } from '../src/fullloop.mjs'
import { KEEP_MAP_OPEN, CLEAR_MAP_FOG } from '../src/mapfog.mjs'

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
    model: { provider: 'anthropic', model: 'fable', test_run: { model: 'haiku', id: 'haiku', effort: 'low' }, request: null, rows: [], providers: { openai: 'unconnected', anthropic: 'connected' } },
    ...over,
  },
})

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

// GitHub, doubled: issues numbered from 60 with database ids from 1060, the
// sub-issue links and the dependency edges as they were written, and a
// frontier the dispatcher would answer: the map's open, unassigned, unblocked
// children. Closing a ticket clears the edges it held.
function fakeTracker() {
  const issues = new Map()
  const links = []
  const edges = []
  let next = 60
  const t = {
    issues, links, edges, calls: [],
    createIssue: async (repo, { title, body, labels }) => {
      const number = next++
      const issue = { number, id: number + 1000, title, body, labels, state: 'open', html_url: `https://github.com/${repo}/issues/${number}` }
      issues.set(number, issue)
      t.calls.push(['create', number])
      return issue
    },
    addSubIssue: async (repo, parent, childId) => { links.push([parent, childId - 1000]); t.calls.push(['link', parent, childId - 1000]) },
    addBlockedBy: async (repo, n, blockerId) => { edges.push([n, blockerId - 1000]); t.calls.push(['block', n, blockerId - 1000]) },
    fetchIssue: async (repo, n) => issues.get(Number(n)) ?? { number: n, state: 'open' },
    close: (n) => { issues.get(n).state = 'closed' },
    frontier: (repo = 'o/r') => {
      const maps = [...issues.values()].filter((i) => i.labels.includes('wayfinder:map') && i.state === 'open')
      const items = []
      for (const m of maps) {
        for (const [parent, child] of links) {
          if (parent !== m.number) continue
          const c = issues.get(child)
          const blocked = edges.some(([n, by]) => n === child && issues.get(by)?.state === 'open')
          if (c.state === 'open' && !blocked) items.push({ number: c.number, title: c.title, labels: c.labels, map: m.number, mapTitle: m.title })
        }
      }
      return { repo, lane: 'map', numbers: items.map((i) => i.number), items }
    },
  }
  return t
}

const MAP = 60
const T1 = 61
const T2 = 62

// The rows the daemon writes while an agent works, in the order they land
// on a clean pass. Each helper writes one leg's evidence for one ticket. The
// dispatcher's `start` writes the spawn rows before it answers, so the fake
// dispatch below does the same, and a clean pass picks up after it.
function spawnRows(j, { ticket, agent = `curia-${ticket}` }) {
  j.write('dispatch_claimed', { repo: 'o/r', ticket, agent, title: 'A Test run ticket' })
  j.write('thread_bound', { repo: 'o/r', ticket, thread_id: `7${ticket}` })
  j.write('agent_spawned', { repo: 'o/r', ticket, agent, model: 'fable', harness: 'claude' })
  j.write('agent_ready', { repo: 'o/r', ticket, agent })
}
function cleanPass(j, tracker, { ticket = String(T1), agent = `curia-${ticket}`, from = 'escalation' } = {}) {
  const pr = `https://github.com/o/r/pull/${ticket}0`
  const legs = {
    dispatch: () => spawnRows(j, { ticket, agent }),
    escalation: () => {
      j.write('esc_open', { id: `esc-${ticket}-q`, agent, ticket, kind: 'free-text', prompt: 'Which wording?' })
      j.write('esc_answer', { id: `esc-${ticket}-q`, answer: 'As written', by: 'alp' })
    },
    pull_request: () => j.write('pr_opened', { repo: 'o/r', ticket, agent, branch: `curia/${ticket}`, url: pr, commits: 1 }),
    review: () => {
      j.write('esc_open', { id: `esc-${ticket}-g`, agent, ticket, kind: 'review-gate', prompt: 'Review?' })
      j.write('esc_answer', { id: `esc-${ticket}-g`, answer: 'approve', by: 'alp' })
      j.write('pr_approved', { repo: 'o/r', ticket, agent, branch: `curia/${ticket}`, pr, number: Number(`${ticket}0`) })
      j.write('review_answered', { repo: 'o/r', ticket, agent, approved: true, via: 'gate' })
    },
    resolved: () => {
      j.write('map_pointer_appended', { repo: 'o/r', map: MAP, ticket, line: `- [ticket](https://github.com/o/r/issues/${ticket}) — done` })
      j.write('ticket_resolved', { repo: 'o/r', ticket, agent, comment: 'present', close: 'present', map: 'appended', land: 'merged', pr, repaired: [], summary: '✅ resolved' })
      j.write('result', { repo: 'o/r', ticket, agent, status: 'resolved' })
      j.write('lifecycle_closed', { repo: 'o/r', ticket, agent, kind: 'ticket' })
      if (tracker?.issues.has(Number(ticket))) tracker.close(Number(ticket))
    },
  }
  const order = ['dispatch', 'escalation', 'pull_request', 'review', 'resolved']
  for (const key of order.slice(order.indexOf(from))) legs[key]()
}
// The map lifecycle's own ending: the overseer's empty-map verdict question,
// the operator's answer, and the close row `onMapFogAnswered` writes.
function mapClose(j, tracker, { answer = CLEAR_MAP_FOG, close = true } = {}) {
  j.write('esc_open', { id: 'esc-map', agent: 'overseer', ticket: String(MAP), kind: 'choice', prompt: `Map o/r#${MAP} has no open tickets. What should Curia do?`, options: [CLEAR_MAP_FOG, KEEP_MAP_OPEN], action: { verb: 'empty-map-verdict', repo: 'o/r', map: MAP } })
  j.write('esc_answer', { id: 'esc-map', answer, by: 'alp' })
  j.write('map_fog_verdict_posted', { id: 'esc-map', repo: 'o/r', map: MAP, answer })
  if (close && answer === CLEAR_MAP_FOG) {
    j.write('map_fog_closed', { id: 'esc-map', repo: 'o/r', map: MAP })
    tracker?.close(MAP)
  }
}

describe('the Test run as the installation acceptance (#882, #891)', () => {
  let j
  let tracker
  let dispatched
  let loop
  const build = (over = {}) => new FullLoop({
    discover: async (repo) => tracker.frontier(repo),
    // A dispatch clones and starts a container before it spawns, so the
    // fake yields once before its rows land: the press answers first.
    dispatch: async (repo, n) => { dispatched.push(`${repo}#${n}`); await null; spawnRows(j, { ticket: String(n) }); return `⚙️ dispatched ${repo}#${n} → \`curia-${n}\` on **fable**` },
    tracker,
    journal: j.journal,
    lastRun: j.lastRun,
    eventsSince: j.eventsSince,
    now: j.clock.now,
    wait: async () => {},
    log: () => {},
    dataDir: '/data',
    ...over,
  })
  beforeEach(() => {
    j = fakeJournal()
    tracker = fakeTracker()
    dispatched = []
    loop = build()
  })

  test('the legs are the eight of the Full loop and the close of the map, in that order', () => {
    assert.deepEqual(LEGS.map((l) => l.key), ['discovery', 'dispatch', 'escalation', 'pull_request', 'review', 'merge', 'resolution', 'map_update', 'map_closed'])
    assert.equal(LEGS.at(-1).title, 'Map closed')
    assert.equal(REHEARSAL_LABEL, 'rehearsal')
  })

  test('with no run there is nothing to report, and nothing is read from anywhere but the journal', () => {
    const s = loop.status()
    assert.equal(s.state, 'idle')
    assert.equal(s.repo, null)
    assert.equal(s.model, null)
    assert.equal(s.map, null)
    assert.deepEqual(s.tickets, [])
    assert.deepEqual(s.legs.map((l) => l.state), LEGS.map(() => 'pending'))
  })

  test('the press refuses a closed gate and runs nothing', async () => {
    await assert.rejects(() => loop.start({ ready: false, reason: 'Waiting for Discord.', facts: null }), (e) => e.refusal && /Test run isn't ready: Waiting for Discord\./.test(e.message))
    assert.deepEqual(dispatched, [])
    assert.deepEqual(j.rows, [])
    assert.deepEqual(tracker.calls, [])
  })

  test('the press creates the map and its two tickets, blocked in order, typed test-run and marked rehearsal, then discovers and dispatches ticket 1 of 2', async () => {
    const s = await loop.start(gate())
    assert.equal(s.state, 'running')
    assert.equal(s.repo, 'o/r')
    assert.equal(s.title, 'Test run September 2, 2026')
    // The map and the tickets are real issues in the covered repository.
    assert.deepEqual(tracker.calls, [['create', MAP], ['create', T1], ['link', MAP, T1], ['create', T2], ['link', MAP, T2], ['block', T2, T1]])
    const map = tracker.issues.get(MAP)
    assert.equal(map.title, 'Test run September 2, 2026')
    assert.deepEqual(map.labels, ['wayfinder:map', 'rehearsal'])
    assert.match(map.body, /## Decisions so far/)
    assert.match(map.body, /## Not yet specified/)
    const t1 = tracker.issues.get(T1)
    assert.equal(t1.title, 'Add a line to the README')
    // The tickets carry a type of their own (#891): `test-run` is the row
    // routing gives the cheapest model at its lowest effort, for the agent and
    // for the cross-check alike, so the acceptance never spends the frontier
    // model. The type label comes first, because the router reads the first
    // `wayfinder:` label.
    assert.deepEqual(t1.labels, ['wayfinder:test-run', 'rehearsal'])
    assert.match(t1.body, /Append one line to the bottom of `README\.md`/)
    assert.match(t1.body, /Create the file if it doesn't exist/)
    assert.match(t1.body, /Curia Test run, September 2, 2026\./)
    assert.match(t1.body, /ask the operator one question/)
    const t2 = tracker.issues.get(T2)
    assert.equal(t2.title, 'Remove the Test run line from the README')
    assert.match(t2.body, new RegExp(`Blocked by #${T1}`))
    assert.match(t2.body, /delete the file/)
    assert.deepEqual(t2.labels, ['wayfinder:test-run', 'rehearsal'])
    // The run says what it runs on (#891): the provider and the test-run
    // row's model and effort, read off the press's own row.
    assert.deepEqual(s.model, { provider: 'anthropic', model: 'haiku', id: 'haiku', effort: 'low' })
    assert.deepEqual(j.rows[0].type, 'full_loop_started')
    assert.deepEqual(JSON.parse(j.rows[0].body).test_run, { model: 'haiku', id: 'haiku', effort: 'low' })
    // The status names them, and the ticket in flight.
    assert.deepEqual(s.map, { number: MAP, title: 'Test run September 2, 2026', url: `https://github.com/o/r/issues/${MAP}` })
    assert.deepEqual(s.tickets.map((t) => [t.index, t.number, t.state]), [[1, T1, 'running'], [2, T2, 'pending']])
    assert.deepEqual(s.ticket, { number: T1, title: 'Add a line to the README', url: `https://github.com/o/r/issues/${T1}`, map: MAP, index: 1, of: 2 })
    assert.equal(s.legs[0].state, 'complete', 'discovery is the frontier read that found ticket 1')
    assert.equal(s.legs[1].state, 'running')
    assert.deepEqual(dispatched, [`o/r#${T1}`])
    await loop.settled()
    assert.equal(loop.status().legs[1].state, 'complete', 'the spawn row is the dispatch')
    assert.equal(loop.status().legs[2].state, 'running')
    assert.equal(s.links.map, `https://github.com/o/r/issues/${MAP}`)
    assert.equal(s.links.channel, 'https://discord.com/channels/200/400')
    // The run's own rows name the map and the tickets, and nothing secret.
    assert.deepEqual(j.rows.slice(0, 5).map((r) => r.type), ['full_loop_started', 'full_loop_map_created', 'full_loop_ticket_created', 'full_loop_ticket_created', 'full_loop_blocked'])
    assert.equal(j.rows.find((r) => r.type === 'full_loop_discovered').ticket, String(T1))
    assert.ok(!JSON.stringify(j.rows).includes(TOKEN))
  })

  test('a repository outside the covered ones is refused by name', async () => {
    await assert.rejects(() => loop.start(gate(), { repo: 'x/y' }), (e) => e.refusal && /x\/y is not a covered repository/.test(e.message))
    assert.deepEqual(dispatched, [])
    assert.deepEqual(tracker.calls, [])
  })

  test('a write that fails while the map is made fails discovery, and Try again resumes the same map and creates only what is missing', async () => {
    let refuse = true
    const create = tracker.createIssue
    tracker.createIssue = async (repo, spec) => {
      if (refuse && spec.title.startsWith('Remove')) throw new Error('HTTP 502')
      return create(repo, spec)
    }
    const s = await loop.start(gate())
    assert.equal(s.state, 'failed')
    assert.deepEqual(s.failed, {
      leg: 'discovery', title: 'Frontier discovery',
      cause: "curia could not create the Test run's map in o/r: HTTP 502",
      action: 'Check the GitHub card and the repository, then select Try again to create what is missing.',
    })
    assert.deepEqual(s.map?.number, MAP, 'the map that landed is named')
    assert.equal(s.tickets.length, 1)
    assert.deepEqual(dispatched, [], 'nothing is dispatched on a failed creation')
    refuse = false
    const again = await loop.retry()
    assert.equal(again.state, 'running')
    assert.equal(j.rows.filter((r) => r.type === 'full_loop_map_created').length, 1, 'no second map')
    assert.deepEqual(tracker.calls, [['create', MAP], ['create', T1], ['link', MAP, T1], ['create', T2], ['link', MAP, T2], ['block', T2, T1]])
    assert.deepEqual(again.tickets.map((t) => t.number), [T1, T2])
    assert.deepEqual(dispatched, [`o/r#${T1}`])
  })

  test('a frontier that cannot be read fails discovery with the GitHub card as the action', async () => {
    loop = build({ discover: async () => ({ repo: 'o/r', error: 'gh: HTTP 401' }) })
    const s = await loop.start(gate())
    assert.equal(s.failed.leg, 'discovery')
    assert.equal(s.failed.cause, 'curia could not read the frontier of o/r: gh: HTTP 401')
    assert.match(s.failed.action, /Check the GitHub card/)
    assert.equal(s.map.number, MAP, 'the map stands')
  })

  test('a ticket the frontier does not list yet is read for again, and one that never appears fails discovery with the takeable rule', async () => {
    let reads = 0
    const waits = []
    loop = build({ discover: async (repo) => { reads += 1; return reads < 3 ? { repo, lane: 'map', numbers: [], items: [] } : tracker.frontier(repo) }, wait: async (ms) => { waits.push(ms) } })
    const s = await loop.start(gate())
    assert.equal(s.state, 'running')
    assert.equal(reads, 3)
    assert.deepEqual(waits, [3000, 3000])

    const j2 = fakeJournal(); const t2 = fakeTracker()
    const never = new FullLoop({ discover: async (repo) => ({ repo, lane: 'map', numbers: [], items: [] }), dispatch: async () => 'never', tracker: t2, journal: j2.journal, lastRun: j2.lastRun, eventsSince: j2.eventsSince, now: j2.clock.now, wait: async () => {}, log: () => {} })
    const off = await never.start(gate())
    assert.equal(off.state, 'failed')
    assert.equal(off.failed.leg, 'discovery')
    assert.equal(off.failed.cause, `o/r#${T1} is not on the frontier of o/r.`)
    assert.equal(off.failed.action, `Make sure o/r#${T1} is open, unassigned, and unblocked, then select Try again.`)
  })

  test('a dispatch the dispatcher refuses fails the dispatch leg with the refusal as the cause', async () => {
    loop = build({ dispatch: async () => '❌ o/r#61 still has a clone on disk from an earlier agent' })
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
    loop = build({ dispatch: async () => { throw new Error('docker is not running') } })
    await loop.start(gate())
    await loop.settled()
    assert.equal(loop.status().failed.leg, 'dispatch')
    assert.match(loop.status().failed.cause, /docker is not running/)
  })

  test('a clean pass walks ticket 1 through the eight legs, then ticket 2 on fresh legs, then the map closes on the operator\'s verdict, and the run is complete once', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j, tracker)
    // Ticket 1 is complete; the read notices, and ticket 2 is discovered and
    // dispatched on the frontier the closed blocker opened.
    let s = loop.status()
    assert.equal(s.state, 'running')
    assert.deepEqual(s.tickets.map((t) => t.state), ['complete', 'pending'])
    assert.equal(s.ticket.index, 2)
    assert.equal(s.legs[0].state, 'running', 'ticket 2 starts on its own discovery')
    await loop.settled()
    assert.deepEqual(dispatched, [`o/r#${T1}`, `o/r#${T2}`])
    s = loop.status()
    assert.deepEqual(s.ticket, { number: T2, title: 'Remove the Test run line from the README', url: `https://github.com/o/r/issues/${T2}`, map: MAP, index: 2, of: 2 })
    assert.deepEqual(s.legs.map((l) => l.state), ['complete', 'complete', 'running', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending'])
    assert.equal(s.links.thread, `https://discord.com/channels/200/7${T2}`, 'the thread is ticket 2\'s')
    assert.equal(s.links.pull_request, null, 'ticket 1\'s pull request is not ticket 2\'s')
    cleanPass(j, tracker, { ticket: String(T2) })
    s = loop.status()
    assert.deepEqual(s.tickets.map((t) => t.state), ['complete', 'complete'])
    assert.deepEqual(s.legs.map((l) => l.state), [...Array(8).fill('complete'), 'running'])
    assert.equal(s.state, 'running')
    assert.equal(s.waiting, null, 'the map question is not asked yet')
    // The map lifecycle asks; the run waits for the verdict and shows it.
    mapClose(j, tracker, { close: false })
    j.rows.splice(-2) // the answer and the verdict row are not in yet
    s = loop.status()
    assert.equal(s.waiting.id, 'esc-map')
    assert.equal(s.waiting.leg, 'map_closed')
    assert.equal(s.waiting.ticket, String(MAP))
    assert.deepEqual(s.waiting.options, [CLEAR_MAP_FOG, KEEP_MAP_OPEN])
    assert.equal(s.waiting.message.title, `Choice · #${MAP}`)
    j.rows.length = j.rows.length // (the verdict follows)
    mapClose(j, tracker)
    s = loop.status()
    assert.equal(s.state, 'complete')
    assert.deepEqual(s.legs.map((l) => l.state), LEGS.map(() => 'complete'))
    assert.deepEqual(s.legs.map((l) => l.key), LEGS.map((l) => l.key))
    for (const leg of s.legs) assert.ok(leg.at && leg.ms >= 0, `${leg.key} is stamped`)
    assert.deepEqual(s.links, {
      ticket: `https://github.com/o/r/issues/${T2}`,
      thread: `https://discord.com/channels/200/7${T2}`,
      channel: 'https://discord.com/channels/200/400',
      pull_request: `https://github.com/o/r/pull/${T2}0`,
      map: `https://github.com/o/r/issues/${MAP}`,
    })
    assert.equal(s.legs.find((l) => l.key === 'map_closed').link, `https://github.com/o/r/issues/${MAP}`)
    // Elapsed is the last leg's row against the run's own start row.
    const started = Date.parse(JSON.parse(j.rows[0].body).ts)
    const last = Date.parse(j.rows.find((r) => r.type === 'map_fog_closed').ts)
    assert.equal(s.elapsed_ms, last - started)
    assert.equal(s.finished_at, new Date(last).toISOString())
    assert.equal(s.failed, null)
    assert.equal(s.waiting, null)
    // The completion is journalled once, as a record and never as a marker.
    assert.equal(j.rows.filter((r) => r.type === 'full_loop_completed').length, 1)
    loop.status()
    assert.equal(j.rows.filter((r) => r.type === 'full_loop_completed').length, 1)
    assert.ok(!JSON.stringify(s).includes(TOKEN))
  })

  test('a partial pass is running while the agent lives and failed at the first missing leg once it is gone', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j, tracker)
    // Undo the ending: a pass that stopped after the pull request.
    const cut = j.rows.findIndex((r) => r.type === 'pr_opened')
    j.rows.splice(cut + 1)
    let s = loop.status()
    assert.equal(s.state, 'running')
    assert.deepEqual(s.legs.map((l) => l.state), ['complete', 'complete', 'complete', 'complete', 'running', 'pending', 'pending', 'pending', 'pending'])
    assert.ok(s.elapsed_ms > 0)

    j.write('lifecycle_closed', { repo: 'o/r', ticket: String(T1), agent: `curia-${T1}`, kind: 'ticket', reason: 'the agent exited' })
    s = loop.status()
    assert.equal(s.state, 'failed')
    assert.deepEqual(s.failed, {
      leg: 'review', title: 'Review',
      cause: 'The agent ended before Review: the agent exited.',
      action: `Read the thread of o/r#${T1} in #curia and fix what stopped the agent, then select Try again to dispatch o/r#${T1} again.`,
    })
    assert.equal(s.legs[3].state, 'complete', 'completed legs are preserved')
    assert.equal(s.tickets[0].state, 'failed')
    assert.equal(s.links.pull_request, `https://github.com/o/r/pull/${T1}0`)
  })

  test('a cancelled or died agent fails the run at the pending leg too', async () => {
    await loop.start(gate())
    await loop.settled()
    j.write('agent_cancelled', { repo: 'o/r', ticket: String(T1), agent: `curia-${T1}`, by: 'alp' })
    const s = loop.status()
    assert.equal(s.state, 'failed')
    assert.equal(s.failed.leg, 'escalation')
    assert.match(s.failed.cause, /cancelled/)
  })

  test('a resolution without a merge, an unapproved review, or an unwritten map pointer never completes', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j, tracker)
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
    // A whole clean pass of ticket 61 from an EARLIER dispatch, before this run.
    cleanPass(j, null, { from: 'dispatch' })
    await loop.start(gate())
    await loop.settled()
    let s = loop.status()
    assert.equal(s.state, 'running')
    assert.deepEqual(s.legs.slice(1).map((l) => l.state), ['complete', 'running', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending'])
    assert.equal(s.legs[1].at, j.rows.filter((r) => r.type === 'agent_spawned').at(-1).ts, 'this run\'s own spawn, not the earlier one')

    // Another ticket's pass, interleaved after this run started.
    cleanPass(j, null, { ticket: '43', agent: 'curia-43', from: 'dispatch' })
    s = loop.status()
    assert.equal(s.legs[2].state, 'running', 'another ticket\'s question is not this agent\'s')
    assert.equal(s.state, 'running')

    // This ticket's rows under another session name are not this dispatch.
    cleanPass(j, null, { agent: `curia-review-${T1}`, from: 'dispatch' })
    s = loop.status()
    assert.equal(s.state, 'running')
    assert.equal(s.legs[2].state, 'running')

    // Ticket 2's rows before ticket 1 completed are not ticket 1's, and do
    // not count for ticket 2 later either: its dispatch has not happened.
    cleanPass(j, null, { ticket: String(T2), from: 'dispatch' })
    s = loop.status()
    assert.equal(s.ticket.number, T1)
    assert.equal(s.legs[2].state, 'running')
  })

  test('legs out of order do not pass: a resolution row before the pull request is not a pass', async () => {
    await loop.start(gate())
    await loop.settled()
    const agent = `curia-${T1}`
    j.write('esc_open', { id: 'e', agent, ticket: String(T1), kind: 'free-text', prompt: '?' })
    j.write('esc_answer', { id: 'e', answer: 'yes' })
    j.write('ticket_resolved', { repo: 'o/r', ticket: String(T1), agent, comment: 'present', close: 'present', map: 'appended', land: 'merged', pr: 'https://github.com/o/r/pull/610' })
    j.write('pr_opened', { repo: 'o/r', ticket: String(T1), agent, branch: 'curia/61', url: 'https://github.com/o/r/pull/610' })
    j.write('review_answered', { repo: 'o/r', ticket: String(T1), agent, approved: true })
    j.write('lifecycle_closed', { repo: 'o/r', ticket: String(T1), agent })
    const s = loop.status()
    assert.equal(s.state, 'failed')
    assert.equal(s.failed.leg, 'merge')
  })

  test('the run\'s own completion row is a record, never a marker: alone, it completes nothing', async () => {
    await loop.start(gate())
    await loop.settled()
    j.write('full_loop_completed', { repo: 'o/r', map: MAP, elapsed_ms: 1 })
    const s = loop.status()
    assert.equal(s.state, 'running')
    assert.equal(s.legs[2].state, 'running')
  })

  test('an escalation answered through the review gate is not the escalation leg, and an unanswered question is not either', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j, tracker)
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
    j.write('esc_open', { id: 'x', agent: `curia-${T1}`, ticket: String(T1), kind: 'choice', prompt: '?' })
    s = loop.status()
    assert.equal(s.state, 'running')
    assert.equal(s.legs[2].state, 'running')
  })

  // #891: the rehearsal's agent raised its review gate while the daemon had
  // no bridge, and the panel said `Escalation and answer · running` for an
  // hour. The run carries the question it waits for, with the message the
  // bridge composed for it, so the panel shows the operator what Discord got.
  test('an open question rides the run as what it waits for, with the message the bridge posted, and its answer clears it and completes the leg', async () => {
    await loop.start(gate())
    await loop.settled()
    assert.equal(loop.status().waiting, null, 'nothing is waited for before the agent asks')
    j.write('esc_open', { id: 'esc-1', agent: `curia-${T1}`, ticket: String(T1), kind: 'free-text', prompt: 'Which name?', options: null, recommended: false })
    const opened = j.rows.at(-1).ts
    // The fake clock ticks one second per write, so the open time is that
    // second plus the wait.
    j.clock.tick(90_000)
    let s = loop.status()
    assert.equal(s.state, 'running')
    const { message, ...rest } = s.waiting
    assert.deepEqual(rest, {
      id: 'esc-1', agent: `curia-${T1}`, ticket: String(T1), kind: 'free-text', prompt: 'Which name?', options: null, typed: false,
      review: false, pull_request: null, opened_at: opened, open_ms: 91_000, leg: 'escalation',
    })
    assert.equal(message.author, 'curia')
    assert.equal(message.title, `Question · #${T1}`)
    assert.equal(message.description, '❓ Which name?')
    assert.deepEqual(message.fields, [{ name: 'How to answer', value: 'Reply in this thread to answer.' }])
    assert.equal(message.footer, 'A reply here may carry files. They land under `/data/attachments/esc-1/` and reach the agent as paths.\nesc-1')
    assert.match(message.text, /^❓ Which name\?\n_Reply in this thread to answer\._\n-# A reply here may carry files/)
    j.write('esc_answer', { id: 'esc-1', answer: 'The second one', by: 'alp', via: 'dashboard' })
    s = loop.status()
    assert.equal(s.waiting, null, 'the answer, from any surface, clears the wait')
    assert.equal(s.legs[2].state, 'complete')
  })

  test('a review gate open while the escalation leg still runs is said as the gate, so the wait is never mistaken for a hang', async () => {
    await loop.start(gate())
    await loop.settled()
    const agent = `curia-${T1}`
    j.write('pr_opened', { repo: 'o/r', ticket: String(T1), agent, branch: 'curia/61', url: 'https://github.com/o/r/pull/610', commits: 2 })
    j.write('esc_open', { id: 'esc-2', agent, ticket: String(T1), kind: 'review-gate', prompt: 'Review?', options: null })
    const opened = j.rows.at(-1).ts
    j.clock.tick(3_600_000)
    const s = loop.status()
    assert.equal(s.state, 'running')
    assert.equal(s.legs[2].state, 'running', 'the leg order is unchanged: the agent never asked')
    assert.equal(s.waiting.id, 'esc-2')
    assert.equal(s.waiting.review, true)
    assert.equal(s.waiting.pull_request, 'https://github.com/o/r/pull/610', 'the gate names the pull request the leg walk has not reached')
    assert.equal(s.waiting.opened_at, opened)
    assert.equal(s.waiting.open_ms, 3_601_000)
    assert.equal(s.waiting.leg, 'escalation', 'the wait is reported on the leg that runs')
    assert.equal(s.waiting.message.title, `Review gate · #${T1}`)
    assert.match(s.waiting.message.fields[0].value, /✅ Approve to merge and resolve/)
  })

  test('a cancelled or superseded question is not waited for, and the last open one is', async () => {
    await loop.start(gate())
    await loop.settled()
    const agent = `curia-${T1}`
    j.write('esc_open', { id: 'esc-1', agent, ticket: String(T1), kind: 'free-text', prompt: 'First?' })
    j.write('esc_cancel', { id: 'esc-1' })
    assert.equal(loop.status().waiting, null)
    j.write('esc_open', { id: 'esc-2', agent, ticket: String(T1), kind: 'choice', prompt: 'Second?', options: ['a', 'b'] })
    j.write('esc_supersede', { id: 'esc-2', successor: 'esc-3' })
    j.write('esc_open', { id: 'esc-3', agent, ticket: String(T1), kind: 'choice', prompt: 'Third?', options: ['a', 'b'] })
    const w = loop.status().waiting
    assert.equal(w.id, 'esc-3')
    assert.deepEqual(w.options, ['a', 'b'])
    // Another session's question is not this run's.
    j.write('esc_answer', { id: 'esc-3', answer: 'a', by: 'alp' })
    j.write('esc_open', { id: 'esc-9', agent: `curia-review-${T1}`, ticket: String(T1), kind: 'free-text', prompt: 'Not mine' })
    assert.equal(loop.status().waiting, null)
  })

  test('the live sessions ride the run with a terminal link each: the agent while it lives, the overseer while it is in a turn', async () => {
    const live = new Set()
    let turns = []
    loop = build({
      dispatch: async (repo, n) => { await null; spawnRows(j, { ticket: String(n) }); live.add(`curia-${n}`); return 'ok' },
      agentLive: (session) => live.has(session),
      overseerSessions: () => turns,
    })
    assert.deepEqual(loop.status().sessions, [], 'no run, no session')
    await loop.start(gate())
    await loop.settled()
    assert.deepEqual(loop.status().sessions, [
      { session: `curia-${T1}`, role: 'agent', terminal_url: `https://curia.tail1234.ts.net:8445/terminal/?arg=curia-${T1}` },
    ])
    turns = ['curia-overseer-1']
    assert.deepEqual(loop.status().sessions.map((s) => s.session), [`curia-${T1}`, 'curia-overseer-1'])
    assert.equal(loop.status().sessions[1].terminal_url, 'https://curia.tail1234.ts.net:8445/terminal/?arg=curia-overseer-1')
    assert.equal(loop.status().sessions[1].role, 'overseer')
    live.delete(`curia-${T1}`)
    assert.deepEqual(loop.status().sessions.map((s) => s.session), ['curia-overseer-1'], 'a session that ended is not linked')
  })

  test('without an app address the terminal link is the page\'s own path', async () => {
    loop = build({ agentLive: () => true })
    await loop.start(gate({ tailscale: { address: 'curia.tail1234.ts.net', app_url: null, operator: 'alp@example.com', admitted_ms: 12 } }))
    await loop.settled()
    assert.deepEqual(loop.status().sessions, [{ session: `curia-${T1}`, role: 'agent', terminal_url: `/terminal/?arg=curia-${T1}` }])
  })

  test('Try again after a failed dispatch dispatches the same ticket again, and only rows after the retry count', async () => {
    let refuse = true
    loop = build({ dispatch: async (repo, n) => { dispatched.push(`${repo}#${n}`); if (refuse) return '❌ refused'; spawnRows(j, { ticket: String(n) }); return 'ok' } })
    await loop.start(gate())
    await loop.settled()
    assert.equal(loop.status().failed.leg, 'dispatch')
    // A stray spawn row between the failure and the retry is not the retry's.
    j.write('agent_spawned', { repo: 'o/r', ticket: String(T1), agent: `curia-${T1}` })
    const stray = j.rows.at(-1)
    refuse = false
    const s = await loop.retry()
    await loop.settled()
    assert.deepEqual(dispatched, [`o/r#${T1}`, `o/r#${T1}`])
    assert.equal(s.state, 'running')
    const dispatch = loop.status().legs[1]
    assert.equal(dispatch.state, 'complete')
    assert.notEqual(dispatch.at, stray.ts, 'the stray spawn before the retry counts for nothing')
    assert.equal(dispatch.at, j.rows.filter((r) => r.type === 'agent_spawned').at(-1).ts)
  })

  test('Try again after the agent died on ticket 2 dispatches ticket 2 again from the failed leg on, and the earlier pass is not this one', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j, tracker)
    loop.status()
    await loop.settled()
    cleanPass(j, tracker, { ticket: String(T2) })
    j.rows.splice(j.rows.findIndex((r) => r.type === 'pr_opened' && r.ticket === String(T2)) + 1)
    tracker.issues.get(T2).state = 'open'
    j.write('lifecycle_closed', { repo: 'o/r', ticket: String(T2), agent: `curia-${T2}` })
    let s = loop.status()
    assert.equal(s.failed.leg, 'review')
    assert.equal(s.ticket.index, 2)
    assert.deepEqual(s.tickets.map((t) => t.state), ['complete', 'failed'])
    const pressed = await loop.retry()
    assert.equal(pressed.state, 'running')
    assert.equal(pressed.ticket.number, T2, 'the same ticket')
    assert.equal(pressed.legs[1].state, 'running', 'the retry is a fresh dispatch')
    await loop.settled()
    s = loop.status()
    assert.equal(s.legs[0].state, 'complete', 'discovery stands')
    assert.equal(s.legs[1].state, 'complete')
    assert.equal(s.legs[2].state, 'running', 'and the earlier pass\'s rows are not this dispatch\'s')
    assert.deepEqual(dispatched, [`o/r#${T1}`, `o/r#${T2}`, `o/r#${T2}`])
    cleanPass(j, tracker, { ticket: String(T2) })
    mapClose(j, tracker)
    assert.equal(loop.status().state, 'complete')
    assert.equal(j.rows.filter((r) => r.type === 'full_loop_map_created').length, 1, 'one map for the whole run')
  })

  test('a map kept open on the verdict fails the last leg, and Try again reads the map as it stands', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j, tracker)
    loop.status()
    await loop.settled()
    cleanPass(j, tracker, { ticket: String(T2) })
    mapClose(j, tracker, { answer: KEEP_MAP_OPEN })
    let s = loop.status()
    assert.equal(s.state, 'failed')
    assert.deepEqual(s.failed, {
      leg: 'map_closed', title: 'Map closed',
      cause: `You kept o/r#${MAP} open.`,
      action: `Close https://github.com/o/r/issues/${MAP} on GitHub, then select Try again.`,
    })
    // Still open: the same failure, freshly read.
    s = await loop.retry()
    assert.equal(s.state, 'failed')
    assert.equal(s.failed.cause, `o/r#${MAP} is still open.`)
    // Closed by hand: the leg completes on the run's own row.
    tracker.close(MAP)
    s = await loop.retry()
    assert.equal(s.state, 'complete')
    assert.equal(s.legs.at(-1).state, 'complete')
    assert.ok(j.rows.some((r) => r.type === 'full_loop_map_closed'))
  })

  test('a second press while a run is live is refused, and Try again on a live run is too', async () => {
    await loop.start(gate())
    await loop.settled()
    await assert.rejects(() => loop.start(gate()), (e) => e.refusal && new RegExp(`already running on o/r#${T1}`).test(e.message))
    await assert.rejects(() => loop.retry(), (e) => e.refusal && /is running/.test(e.message))
    assert.deepEqual(dispatched, [`o/r#${T1}`])
  })

  test('Try again with nothing failed is refused, and a new press after a complete run creates a new map', async () => {
    await assert.rejects(() => loop.retry(), (e) => e.refusal && /nothing to retry/i.test(e.message))
    await loop.start(gate())
    await loop.settled()
    cleanPass(j, tracker)
    loop.status()
    await loop.settled()
    cleanPass(j, tracker, { ticket: String(T2) })
    mapClose(j, tracker)
    assert.equal(loop.status().state, 'complete')
    const s = await loop.start(gate())
    assert.equal(s.state, 'running')
    assert.equal(s.map.number, 63, 'a new map')
    assert.equal(s.ticket.number, 64)
    assert.equal(s.legs[1].state, 'running')
    assert.equal(j.rows.filter((r) => r.type === 'full_loop_started').length, 2)
  })

  test('the status is read from the journal alone: a fresh instance over the same rows says the same', async () => {
    await loop.start(gate())
    await loop.settled()
    cleanPass(j, tracker)
    loop.status()
    await loop.settled()
    cleanPass(j, tracker, { ticket: String(T2) })
    mapClose(j, tracker)
    const fresh = build({ dispatch: async () => 'never' })
    assert.deepEqual(fresh.status(), loop.status())
    assert.equal(fresh.status().state, 'complete')
  })
})

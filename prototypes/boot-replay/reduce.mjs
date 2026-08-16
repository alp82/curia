// The three ways to fill the reduction at boot, and one way to compare them.
//
// The daemon builds every in-memory reduction with one pass: the rebuild reads
// the journal whole and hands each line to `_apply`. This module holds that
// pass, the same pass reading the journal instead, and a narrowed variant that
// scans only the types the reducer acts on and answers the rest with queries.
//
// Nothing here is a proposal. It exists so #322 can measure what each costs and
// check that all three end at the same reduction.

import fs from 'node:fs'
import { normalizeEvent } from '../../daemon/src/journal.mjs'
import { Reduction, RECENT_EVENTS, RECENT_OUTCOMES } from '../../daemon/src/reduction.mjs'

// ------------------------------------------------------------- the two halves
//
// The reduction splits in two, and CONTEXT.md already names the split. Three
// fields keep journal rows VERBATIM — the feed tail, the outcomes, and the last
// event per agent. Every other field is COMPUTED: one escalation record folds
// the opened, superseded, answered and closed rows into an object no row holds.
//
// Only the verbatim three can be a query, because only they are "the last N
// rows matching X". The narrowed variant below is exactly that split made real.

// The 26 types `_apply`'s switch acts on, read off `daemon/src/reduction.mjs`.
// `checkTypeList` asserts this list is still the whole switch.
const SWITCH_TYPES = [
  'esc_open', 'escalation_agent_died', 'esc_render', 'esc_answer', 'esc_cancel', 'esc_lapse',
  'esc_supersede', 'esc_nudge', 'thread_bound', 'thread_released', 'map_adopted', 'overseer_note',
  'agent_note', 'agent_notes_drained', 'agent_notes_expired', 'agent_note_interrupted',
  'esc_replayed', 'overseer_notes_drained', 'dispatch_claimed', 'agent_spawned', 'overseer_session',
  'console_conversation_opened', 'console_conversation_deleted', 'overseer_turn_started',
  'overseer_turn_ended', 'overseer_turn_dropped',
]

// The six types `_apply` acts on OUTSIDE its switch, and that feed a computed
// field: the pull request a dispatch pushed, the limit resume a ticket is owed,
// and the seam crossings of a pending turn.
const OFF_SWITCH_TYPES = ['pr_opened', 'pr_reused', 'land_repaired', 'limit_resume_armed', 'limit_resume', 'command']

// Every type the COMPUTED half needs. This is what the narrowed scan reads.
export const COMPUTED_TYPES = [...new Set([...SWITCH_TYPES, ...OFF_SWITCH_TYPES])].sort()

// The three endings the outcomes hold, and the name each carries on a surface.
// Copied from `store.mjs`, which does not export it.
const OUTCOME_KINDS = { agent_cancelled: 'cancelled', lifecycle_closed: 'finished', agent_died: 'died' }

// The two types the feed does not carry (#388).
const FEED_SILENT = ['overseer_turn_started', 'overseer_turn_ended']

// The types `lastAgentEvents` must not count (#236).
const NOTE_EVENTS = [
  'agent_note', 'agent_notes_drained', 'agent_notes_expired', 'agent_note_refused', 'agent_note_interrupted',
]

// `#feedShape` is private to the reduction, so the query path repeats it. A feed
// row trims the review gate's per-file diff list and keeps the totals (#355).
function feedShape(ev) {
  if (!ev.diff?.list) return ev
  const { list, ...totals } = ev.diff
  return { ...ev, diff: { ...totals, list_on_the_record: list.length } }
}

// A reducer with nothing in it. The reduction rebuilds from its own journal in
// the constructor, so an empty directory is how you get a blank one.
function blank(dir) {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['events.jsonl', 'events.db', 'events.db-wal', 'events.db-shm']) {
    fs.rmSync(`${dir}/${f}`, { force: true })
  }
  return new Reduction(dir)
}

// ------------------------------------------------------------- the three boots

// The file baseline: the boot pass as it stood before #407, line for line,
// with the construction it sits inside.
export function bootFromFile(dir, file) {
  const r = blank(dir)
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    r._apply(normalizeEvent(JSON.parse(line)), { replay: true })
  }
  return r
}

// The same fold, reading the journal. `body` is verbatim, so the fold still
// parses JSON and still runs `normalizeEvent` — the columns are normalized at
// the write edge, but the rebuild does not read the columns.
export function bootFromJournal(dir, db) {
  const r = blank(dir)
  for (const row of db.prepare('select body from events order by id').iterate()) {
    r._apply(normalizeEvent(JSON.parse(row.body)), { replay: true })
  }
  return r
}

// The same fold again, reading the rows in batches instead of one at a time.
// `iterate()` pays a step across the JavaScript-to-SQLite edge per row, and
// `all()` pays one step and holds the whole journal. A batch is both: one step
// per thousand rows, and never more than a thousand rows held.
export function bootFromJournalBatched(dir, db, batch = 1000) {
  const r = blank(dir)
  const page = db.prepare('select id, body from events where id > ? order by id limit ?')
  let after = 0
  for (;;) {
    const rows = page.all(after, batch)
    if (!rows.length) break
    for (const row of rows) r._apply(normalizeEvent(JSON.parse(row.body)), { replay: true })
    after = rows[rows.length - 1].id
  }
  return r
}

// The fold reading every row at once. Fastest, and it holds the whole journal
// in memory at boot — 70 MB of strings at 250,000 events.
export function bootFromJournalAll(dir, db) {
  const r = blank(dir)
  for (const row of db.prepare('select body from events order by id').all()) {
    r._apply(normalizeEvent(JSON.parse(row.body)), { replay: true })
  }
  return r
}

// The narrowed variant: scan only the computed half, then fill the verbatim
// three with queries. Same reduction, less scan — if the census is kind.
export function bootNarrowed(dir, db) {
  const r = blank(dir)
  const marks = COMPUTED_TYPES.map(() => '?').join(',')
  const scan = db.prepare(`select body from events where type in (${marks}) order by id`)
  for (const row of scan.iterate(...COMPUTED_TYPES)) {
    r._apply(normalizeEvent(JSON.parse(row.body)), { replay: true })
  }
  // The scan filled the verbatim three with its own narrow slice. Throw that
  // away and ask the journal the three questions instead.
  r.recent = []
  r.outcomes = { cancelled: [], finished: [], died: [] }
  r.lastAgentEvents = new Map()
  fillVerbatim(r, db)
  return r
}

// The three verbatim fields as queries. Every one is "the last N rows matching
// X", which is the shape #321 indexed.
export function fillVerbatim(r, db) {
  // The feed tail: the last hundred events, minus the two the feed is silent
  // about. `order by id desc limit 100`, then oldest first.
  const silent = FEED_SILENT.map(() => '?').join(',')
  const tail = db.prepare(
    `select body from events where type not in (${silent}) order by id desc limit ${RECENT_EVENTS}`,
  ).all(...FEED_SILENT)
  for (const row of tail.reverse()) r.recent.push(feedShape(normalizeEvent(JSON.parse(row.body))))

  // The outcomes: the last five of each of the three endings.
  const last = db.prepare(`select body from events where type = ? order by id desc limit ${RECENT_OUTCOMES}`)
  for (const [type, kind] of Object.entries(OUTCOME_KINDS)) {
    for (const row of last.all(type).reverse()) {
      const ev = normalizeEvent(JSON.parse(row.body))
      r.outcomes[kind].push({ kind, repo: ev.repo ?? null, ticket: String(ev.ticket ?? '') })
    }
  }

  // The last event per agent, note events excluded. One row per agent the
  // journal has ever named — this answer is not flat, it grows with the agents.
  const notes = NOTE_EVENTS.map(() => '?').join(',')
  const perAgent = db.prepare(`
    select e.agent as agent, e.type as type, e.ts as ts
      from events e
      join (select agent, max(id) as id
              from events
             where agent is not null and type not in (${notes})
             group by agent) m
        on m.id = e.id`).all(...NOTE_EVENTS)
  for (const row of perAgent) {
    // The store only records an event that carries a stamp.
    if (row.ts) r.lastAgentEvents.set(row.agent, { type: row.type, ts: row.ts })
  }
}

// ----------------------------------------------------------------- comparison

const asObject = (m) => Object.fromEntries([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))

// Every field of the reduction, in a shape two boots can be compared by.
export function snapshot(r) {
  return {
    escalations: asObject(r.escalations),
    overseerNotes: asObject(r.overseerNotes),
    agentNotes: asObject(r.agentNotes),
    overseerSessions: asObject(r.overseerSessions),
    consoleConversations: asObject(r.consoleConversations),
    consoleSpent: [...r.consoleSpent].sort(),
    ticketThreads: asObject(r.ticketThreads),
    threadTickets: asObject(r.threadTickets),
    lastTicketThreads: asObject(r.lastTicketThreads),
    lastThreadTickets: asObject(r.lastThreadTickets),
    mapCharters: asObject(r.mapCharters),
    ticketRepos: asObject(r.ticketRepos),
    lastAgentEvents: asObject(r.lastAgentEvents),
    notes: asObject(r.notes),
    handoffNotes: asObject(r.handoffNotes),
    recent: r.recent,
    outcomes: r.outcomes,
    pullRequests: asObject(r.pullRequests),
    limitResumes: asObject(r.limitResumes),
    pendingTurns: asObject(r.pendingTurns),
    droppedTurns: asObject(r.droppedTurns),
    turnStarts: asObject(r.turnStarts),
    seq: r.seq,
    noteSeq: r.noteSeq,
  }
}

// Which fields two boots disagree about, by name.
export function diffFields(a, b) {
  const out = []
  for (const key of Object.keys(a)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(key)
  }
  return out
}

// The type list is a copy of the reducer, so it can go stale. This reads the
// switch back out of the source and says so if it has.
export function checkTypeList(source) {
  const body = source.slice(source.indexOf('_apply(ev, { replay })'))
  const found = [...body.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1])
  const missing = found.filter((t) => !COMPUTED_TYPES.includes(t))
  return { switchTypes: found.length, missing }
}

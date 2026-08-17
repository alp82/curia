// The questions the daemon asks the journal about the past (#408).
//
// The dispatcher answered every one of these with a whole read until this
// module: ten `#readJournal` call sites, more than thirty callers above them,
// and each read parsed every event curia ever wrote. [What the journal scans
// cost](../../docs/research/journal-scan-cost.md) measured one read at about
// 25 ms today and about 1.2 seconds at 250,000 events, with the read costing
// about twenty times the question it served.
//
// [#321](https://github.com/alp82/curia/issues/321) wrote the same questions as
// indexed queries and checked them against the dispatcher's own loop over about
// 17,000 comparisons, with no mismatch. `prototypes/journal-schema/queries.mjs`
// is that SQL and `oracle.mjs` is the loop. The thirteen keyed questions cost
// 0.2 ms together and stay flat as the journal grows. Question 12 stays
// proportional to history, and it is the only one that does.
//
// Four rules the prototype fixed, and this module keeps.
//
//   - **Every `(ticket or agent)` test is two `exists`.** Written as one
//     disjunction, SQLite drops both keyed indexes and walks every event of that
//     type since the epoch: 3.75 ms against 0.02 ms at 60,000 events.
//   - **The epoch is the `epoch` column**, which the insert trigger stamps
//     (`journal.mjs`). One index probe answers "which dispatch is this ticket's
//     latest", so no caller carries a position.
//   - **`id` is the order, never `ts`.** Two events inside one millisecond tie
//     on the stamp and never on the id.
//   - **A question that wants several fields of one event reads that row's
//     `body`.** `body` is verbatim, so a line written before
//     [#184](https://github.com/alp82/curia/issues/184) says `worker` and
//     `backend` — and `normalizeEvent` is the one rule that translates it. SQL
//     reaching for `coalesce(json_extract(body,'$.harness'),
//     json_extract(body,'$.backend'))` would state that rule a second time
//     (ADR-0013). SQL still chooses the ROW, because a predicate that narrows
//     which event answers has to run in the index.
//
// The in-memory short circuits above these stay exactly as they were. A query
// is the fallback, exactly as the read was.

import { normalizeEvent } from './journal.mjs'
import { DAEMON_BOOT, DAEMON_GOODBYE } from './goodbye.mjs'

// The event types each question names. One list per rule, so a type joins a
// question here and nowhere else.
const PR_TYPES = ['pr_opened', 'pr_reused', 'land_repaired']
const REPORTED_TYPES = ['result', 'ticket_resolved']
const CLOSED_TYPES = ['result', 'lifecycle_closed', 'dispatch_unclaimed']
const ENDING_CARRIERS = ['ticket_resolved', 'nonclean_noted', 'charting_finished']
const EPOCH_TYPES = ['dispatch_claimed', 'agent_spawned']
const LIFECYCLE_TYPES = [DAEMON_BOOT, DAEMON_GOODBYE]

const list = (types) => types.map((t) => `'${t}'`).join(', ')

// This ticket's latest dispatch, as one probe of `(ticket, epoch)`. 0 for a
// ticket curia never dispatched, which makes "since the epoch" the whole
// history — the answer the array scan gave when it found no epoch row.
const EPOCH = "(select coalesce(max(epoch), 0) from events where ticket = :t)"

// The reset an agent-keyed question runs on: this session's last spawn line. A
// session name is reused by every dispatch of its ticket, so the map a previous
// dispatch adopted and the sentence a previous dispatch ended on are not this
// one's.
const LAST_SPAWN = "coalesce((select max(id) from events where agent = :a and type = 'agent_spawned'), 0)"

// Shape B: did type T happen for this ticket OR this agent, after the ticket's
// epoch? Two `exists`, for the reason at the top of this file.
const sinceEpoch = (types) => `
select (exists(select 1 from events where ticket = :t and type in (${list(types)}) and id > ${EPOCH})
     or exists(select 1 from events where agent = :a and type in (${list(types)}) and id > ${EPOCH})) as answer`.trim()

// The last event of type T for a key, whole. The caller parses `body`.
const lastBody = (key, types, extra = '') => `
select body from events
 where ${key} and type in (${list(types)})${extra}
 order by id desc limit 1`.trim()

// The fifteen, as SQL. One entry per question, named for the answer and not for
// the caller, because several callers ask the same one.
const SQL = {
  // 1 — #epochScan: did this dispatch push a pull request?
  prOpened: sinceEpoch(PR_TYPES),

  // 2 — #epochScan: did a human APPROVE this dispatch at the gate?
  // Predicate-narrowed: a `review_answered` that rejected is not an
  // approval, so the predicate rides in the index rather than in a caller.
  reviewApproved: `
select (exists(select 1 from events where ticket = :t and type = 'review_answered'
                and id > ${EPOCH} and json_extract(body, '$.approved') = 1)
     or exists(select 1 from events where agent = :a and type = 'review_answered'
                and id > ${EPOCH} and json_extract(body, '$.approved') = 1)) as answer`.trim(),

  // 3 — #epochScan: how many times has the Stop hook held this agent? The
  // one counting question, and the one that bounds the nudge budget.
  stopBlocks: `
select count(*) as answer from events
 where id > ${EPOCH} and type = 'stop_blocked' and agent = :a`.trim(),

  // 4 — #verdictIsLate: did the merge outrun the reviewer? A null on either
  // side leaves the comparison null, and `coalesce` reads that as "no": a
  // ticket with no reviewer has no verdict to be late for.
  verdictIsLate: `
select coalesce(
  (select max(id) from events where ticket = :t and type = 'ticket_resolved')
  > (select max(id) from events where ticket = :t and type = 'reviewer_spawned'), 0) as answer`.trim(),

  // 5 — #liveUnjudgedVerdict: when was this ticket last claimed?
  lastClaimAt: `
select ts from events
 where ticket = :t and type = 'dispatch_claimed'
 order by id desc limit 1`.trim(),

  // 6 — #epochRepo: which repo was this ticket last dispatched against?
  // Predicate-narrowed: the last dispatch event that CARRIES a repo, which
  // is not always the last dispatch event.
  epochRepo: `
select repo from events
 where ticket = :t and type in (${list(EPOCH_TYPES)}) and repo <> ''
 order by id desc limit 1`.trim(),

  // 7 — #epochCharting: was the last dispatch a charting one, and what rode
  // it? `agent_spawned` only, because that is the event which states the
  // kind, and a ticket with no spawn line was never charted under.
  epochCharting: lastBody('ticket = :t', ['agent_spawned']),

  // 8 — #epochSpawn: which model and harness is this session actually on?
  // Keyed by session, because a re-dispatch down the fallback chain writes a
  // second `agent_spawned` for the same session and the last one is running.
  epochSpawn: lastBody('agent = :a', ['agent_spawned']),

  // 9 — #epochAdoptedMap: which map did this session report? Reset at the
  // session's last spawn, so a resumed handle never inherits the map of the
  // dispatch before it.
  adoptedMap: lastBody('agent = :a', ['map_adopted'],
    `\n   and id > ${LAST_SPAWN}\n   and json_extract(body, '$.map') <> ''`),

  // 10 — #endingClause: what did the ending say? Predicate-narrowed to the
  // last carrier that CARRIES a summary, and reset at the last spawn.
  endingClause: lastBody('agent = :a', ENDING_CARRIERS,
    `\n   and id > ${LAST_SPAWN}\n   and json_extract(body, '$.summary') <> ''`),

  // 11 — #captureVerdict, and the reviewer adoption pass: which ticket, repo
  // and checkout does this reviewer belong to? The whole spawn line, because
  // adoption rebuilds a record out of it.
  reviewerSpawn: lastBody('agent = :a', ['reviewer_spawned']),

  // 12 — #reconcileContext: what is every ticket's latest dispatch? The one
  // question that is not keyed. It answers for every ticket at once, and
  // reconcile asks it once a pass: 0.6 ms today, 234 ms at 250,000 events,
  // against 12 ms and 1,222 ms for the read it replaces.
  epochs: `
select e.ticket as ticket, e.repo as repo
  from events e
  join (select ticket, max(id) as id from events
         where type in (${list(EPOCH_TYPES)}) and ticket is not null
         group by ticket) latest on latest.id = e.id
 order by e.ticket`.trim(),

  // 13 — reconcile's orphan guard: did this session report a result after
  // its dispatch? A live session that already reported is a FINISHING agent,
  // and sweeping it would take a worktree that may hold the only commits.
  reportedAfterEpoch: sinceEpoch(REPORTED_TYPES),

  // 14 — reconcile's dead-claim guard: did anything close this epoch?
  closedAfterEpoch: sinceEpoch(CLOSED_TYPES),

  // 15 — #reconcileStaleQuestions (#336): when did this session last report
  // a result, and did a Stop hook then defer its whole ending to a question
  // still open? Both are reset at the session's last spawn, so a question
  // asked by a later dispatch of the same name is never judged against an
  // older one's ending.
  //
  // The research doc measured fourteen questions at `fbbcf02`, before this
  // pass existed. It reads the same journal the other fourteen do.
  lastResult: `
select (select ts from events where agent = :a and type = 'result'
         and id > ${LAST_SPAWN} order by id desc limit 1) as at,
       exists(select 1 from events where agent = :a and type = 'agent_blocked_on_human'
               and id > coalesce((select max(id) from events where agent = :a
                                   and type = 'result' and id > ${LAST_SPAWN}), 0)) as deferred`.trim(),

  // 16 — the boot sweep's gate (#489): how did the LAST daemon die? One line
  // per process at its start and at most one at its end, so the last of the two
  // answers it. Read before this process writes its own boot line, or the
  // answer is always `daemon_boot` and always this one.
  lastLifecycle: `
select type from events
 where type in (${list(LIFECYCLE_TYPES)})
 order by id desc limit 1`.trim(),
}

export class Questions {
  constructor(db) {
    this.db = db
    this.stmts = {}
    for (const [name, sql] of Object.entries(SQL)) this.stmts[name] = db.prepare(sql)
  }

  // Every question runs through here, so an UNREADABLE journal is never an
  // empty one. These answers steer reconcile, the Stop hook and the gate, and
  // an error read as "nothing happened" would sweep a live agent or open a gate
  // a human never approved. The caller decides what to do with the throw:
  // reconcile fails the pass, and the ending receipt states the session alone.
  #ask(name, params = null) {
    try {
      return params ? this.stmts[name].all(params) : this.stmts[name].all()
    } catch (e) {
      throw new Error(`events journal is unreadable: ${e.message}`)
    }
  }

  #one(name, params) {
    return this.#ask(name, params)[0] ?? null
  }

  // The event a `body` row holds, in today's spelling. Null for no row.
  #event(name, params) {
    const row = this.#one(name, params)
    return row ? normalizeEvent(JSON.parse(row.body)) : null
  }

  // 1, 2, 3 — the three answers #epochScan used to take from one pass. Three
  // keyed queries now, which together cost less than a thousandth of that pass.
  epochScan(ticket, agent) {
    const args = { t: String(ticket), a: agent }
    return {
      prOpened: Boolean(this.#one('prOpened', args)?.answer),
      reviewApproved: Boolean(this.#one('reviewApproved', args)?.answer),
      blocks: Number(this.#one('stopBlocks', args)?.answer ?? 0),
    }
  }

  verdictIsLate(ticket) {
    return Boolean(this.#one('verdictIsLate', { t: String(ticket) })?.answer)
  }

  lastClaimAt(ticket) {
    return this.#one('lastClaimAt', { t: String(ticket) })?.ts ?? null
  }

  epochRepo(ticket) {
    return this.#one('epochRepo', { t: String(ticket) })?.repo ?? null
  }

  epochCharting(ticket) {
    const ev = this.#event('epochCharting', { t: String(ticket) })
    if (!ev) return { charting: false, instruction: null, newMap: false }
    return { charting: ev.kind === 'charting', instruction: ev.instruction ?? null, newMap: Boolean(ev.newMap) }
  }

  epochSpawn(agent) {
    const ev = this.#event('epochSpawn', { a: agent })
    return ev ? { model: ev.model ?? null, harness: ev.harness ?? null } : null
  }

  adoptedMap(agent) {
    const ev = this.#event('adoptedMap', { a: agent })
    return ev?.map == null ? null : String(ev.map)
  }

  endingClause(agent) {
    return this.#event('endingClause', { a: agent })?.summary ?? null
  }

  // The whole spawn line, so the reviewer adoption pass can rebuild a record
  // from it. Null for a reviewer the journal cannot describe, which is the one
  // positive evidence that sweeps it.
  reviewerSpawn(agent) {
    return this.#event('reviewerSpawn', { a: agent })
  }

  // Every ticket's latest dispatch, as `ticket -> { repo }`. The repo is the
  // one the LAST dispatch named, which is a different rule from `epochRepo`
  // above: that one takes the last dispatch that carries a repo at all.
  epochs() {
    return new Map(this.#ask('epochs').map((r) => [String(r.ticket), { repo: r.repo ?? null }]))
  }

  reportedAfterEpoch(ticket, agent) {
    return Boolean(this.#one('reportedAfterEpoch', { t: String(ticket), a: agent })?.answer)
  }

  closedAfterEpoch(ticket, agent) {
    return Boolean(this.#one('closedAfterEpoch', { t: String(ticket), a: agent })?.answer)
  }

  // `{ at, deferred }`: when this session last reported a result, and whether a
  // Stop hook after it deferred the ending to an open question. `at` is null
  // when this dispatch has reported nothing, and then nothing was deferred
  // either.
  lastResult(agent) {
    const row = this.#one('lastResult', { a: agent })
    const at = row?.at ?? null
    return { at, deferred: at ? Boolean(row.deferred) : false }
  }

  // The type of the last daemon lifecycle line, or null for a journal that
  // carries neither. `deathWasSilent` in goodbye.mjs reads it.
  lastLifecycle() {
    return this.#one('lastLifecycle')?.type ?? null
  }
}

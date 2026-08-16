// The fourteen questions as the daemon answers them TODAY: a whole read of
// `events.jsonl`, then a loop.
//
// Ported line for line out of `daemon/src/dispatch.mjs` (#epochScan,
// #verdictIsLate, #liveUnjudgedVerdict, #epochRepo, #epochCharting,
// #epochSpawn, #epochAdoptedMap, #endingClause, #captureVerdict,
// #reconcileContext). This is the oracle the SQL is checked against, so a
// query that disagrees with it is wrong by definition — including where the
// daemon's own rule is surprising. One example the checker exercises: a
// reviewer's `agent_spawned` carries the BUILDER's ticket, so spawning a
// cross-check moves the builder's epoch. The queries reproduce that.

const PR_EVENTS = ['pr_opened', 'pr_reused', 'land_repaired']
const EPOCH_EVENTS = ['dispatch_claimed', 'agent_spawned']
const ENDING_CARRIERS = ['ticket_resolved', 'nonclean_noted', 'charting_finished']

const sameTicket = (ev, t) => String(ev.ticket ?? '') === String(t)

// The index of the row that opened this ticket's latest dispatch, or -1.
export function epochIndex(journal, ticket) {
  let idx = -1
  journal.forEach((ev, i) => { if (EPOCH_EVENTS.includes(ev.type) && sameTicket(ev, ticket)) idx = i })
  return idx
}

export const oracle = {
  // 1, 2, 3 — #epochScan, one pass for three answers.
  prOpened(journal, { ticket, agent }) {
    const e = epochIndex(journal, ticket)
    return journal.some((ev, i) => i > e && PR_EVENTS.includes(ev.type) && (ev.agent === agent || sameTicket(ev, ticket)))
  },
  reviewApproved(journal, { ticket, agent }) {
    const e = epochIndex(journal, ticket)
    return journal.some((ev, i) => i > e && ev.type === 'review_answered' && ev.approved === true
      && (ev.agent === agent || sameTicket(ev, ticket)))
  },
  blocks(journal, { ticket, agent }) {
    const e = epochIndex(journal, ticket)
    return journal.filter((ev, i) => i > e && ev.type === 'stop_blocked' && ev.agent === agent).length
  },

  // 4 — #verdictIsLate: did the merge outrun the reviewer?
  verdictIsLate(journal, { ticket }) {
    let spawned = -1
    let resolved = -1
    journal.forEach((ev, i) => {
      if (!sameTicket(ev, ticket)) return
      if (ev.type === 'reviewer_spawned') spawned = i
      if (ev.type === 'ticket_resolved') resolved = i
    })
    return spawned >= 0 && resolved > spawned
  },

  // 5 — #liveUnjudgedVerdict: when was this ticket last claimed?
  lastClaim(journal, { ticket }) {
    let ts = null
    for (const ev of journal) if (ev.type === 'dispatch_claimed' && sameTicket(ev, ticket) && ev.ts) ts = ev.ts
    return ts
  },

  // 6 — #epochRepo. Predicate-narrowed: the last dispatch event that CARRIES a repo.
  epochRepo(journal, { ticket }) {
    let repo = null
    for (const ev of journal) if (EPOCH_EVENTS.includes(ev.type) && sameTicket(ev, ticket) && ev.repo) repo = ev.repo
    return repo ?? null
  },

  // 7 — #epochCharting: was the latest dispatch a charting one, and what rode it?
  epochCharting(journal, { ticket }) {
    let out = { charting: false, instruction: null, newMap: false }
    for (const ev of journal) {
      if (ev.type !== 'agent_spawned' || !sameTicket(ev, ticket)) continue
      out = { charting: ev.kind === 'charting', instruction: ev.instruction ?? null, newMap: Boolean(ev.newMap) }
    }
    return out
  },

  // 8 — #epochSpawn: which model and harness is this session actually on?
  epochSpawn(journal, { agent }) {
    let out = null
    for (const ev of journal) {
      if (ev.type !== 'agent_spawned' || ev.agent !== agent) continue
      out = { model: ev.model ?? null, harness: ev.harness ?? null }
    }
    return out
  },

  // 9 — #epochAdoptedMap. Keyed by AGENT, and reset at every spawn of it.
  adoptedMap(journal, { agent }) {
    let out = null
    for (const ev of journal) {
      if (ev.agent !== agent) continue
      if (ev.type === 'agent_spawned') out = null
      else if (ev.type === 'map_adopted' && ev.map) out = String(ev.map)
    }
    return out
  },

  // 10 — #endingClause. Keyed by agent, reset at spawn, predicate-narrowed:
  // the last ending carrier that CARRIES a summary.
  endingClause(journal, { agent }) {
    let out = null
    for (const ev of journal) {
      if (ev.agent !== agent) continue
      if (ev.type === 'agent_spawned') out = null
      else if (ENDING_CARRIERS.includes(ev.type) && ev.summary) out = ev.summary
    }
    return out
  },

  // 11 — #captureVerdict: which ticket and repo does this reviewer belong to?
  reviewerSpawn(journal, { agent }) {
    let spawn = null
    for (const ev of journal) if (ev.type === 'reviewer_spawned' && ev.agent === agent) spawn = ev
    if (!spawn) return null
    return {
      ticket: String(spawn.ticket ?? ''),
      repo: spawn.repo ?? null,
      model: spawn.model ?? null,
      builder_model: spawn.builder_model ?? null,
      same_provider: Boolean(spawn.same_provider),
      sha: spawn.sha ?? null,
    }
  },

  // 12 — #reconcileContext: every ticket's latest dispatch epoch, in one pass.
  epochs(journal) {
    const out = new Map()
    journal.forEach((ev, idx) => {
      if (EPOCH_EVENTS.includes(ev.type) && ev.ticket != null) out.set(String(ev.ticket), { idx, repo: ev.repo ?? null })
    })
    return out
  },

  // 13 — reconcile's orphan guard: did this session report after its dispatch?
  reportedAfterEpoch(journal, { ticket, agent }) {
    const e = epochIndex(journal, ticket)
    return journal.some((ev, i) => i > e && (ev.type === 'result' || ev.type === 'ticket_resolved')
      && (ev.agent === agent || sameTicket(ev, ticket)))
  },

  // 14 — reconcile's dead-claim guard: did anything close this epoch?
  closedAfterEpoch(journal, { ticket, agent }) {
    const e = epochIndex(journal, ticket)
    return journal.some((ev, i) => i > e
      && (ev.type === 'result' || ev.type === 'lifecycle_closed' || ev.type === 'dispatch_unclaimed')
      && (ev.agent === agent || sameTicket(ev, ticket)))
  },
}

// The Full loop as the installation acceptance (#882, implementing the #857
// acceptance contract on the #853 journey).
//
// The first real Full loop is the last checkpoint of an installation. There
// is no evidence subsystem: the run is one press on the verified facts the
// gate (#880) handed over, driven by the daemon's own machinery, and judged
// by the rows that machinery already writes to the journal while it works.
//
//   SELECT    one covered repository and the one ticket on its frontier that
//             carries the `rehearsal` label. The frontier read IS the first
//             leg: the ticket has to be takeable by Curia's own rule (open,
//             unassigned, unblocked, on an open map or `ready-for-agent`).
//   DRIVE     `dispatch(repo, n)` is the dispatcher's `start`, with the same
//             claim, clone, container, and spawn every other dispatch gets.
//             Everything after the spawn is the agent's inner loop and the
//             daemon's ending, untouched.
//   JUDGE     every later leg is one row the daemon writes and nothing else:
//             `esc_open` plus its `esc_answer`, `pr_opened`, `review_answered`
//             with `approved`, and the `ticket_resolved` receipt's own `land`,
//             `close`, and `map` verdicts. A leg counts only after the run's
//             spawn, only for this ticket's session, and only in order. A row
//             from an earlier dispatch, from another ticket, from the reviewer,
//             or out of order counts for nothing, and neither does the run's
//             own completion row.
//   FAIL      the agent ending with a leg outstanding names that leg, the one
//             cause, and the one action; the completed legs stand; Try again
//             reruns from the failed leg (a fresh frontier read, or a fresh
//             dispatch of the same ticket).
//
// NOTHING IS STORED BUT THE JOURNAL. `status()` rebuilds the run from the last
// `full_loop_started` row and the rows after it on every read, so a restart
// mid-run reads the same run, and `curia doctor` (#881) keeps reading the
// gate: a finished run is a record on the feed, never a readiness marker.

import { REVIEW_KIND } from './lifecycle.mjs'

export const REHEARSAL_LABEL = 'rehearsal'

// The legs, in the order the loop walks them (CONTEXT.md, "Full loop").
export const LEGS = Object.freeze([
  { key: 'discovery', title: 'Frontier discovery' },
  { key: 'dispatch', title: 'Dispatch' },
  { key: 'escalation', title: 'Escalation and answer' },
  { key: 'pull_request', title: 'Pull request' },
  { key: 'review', title: 'Review' },
  { key: 'merge', title: 'Merge' },
  { key: 'resolution', title: 'Ticket resolution' },
  { key: 'map_update', title: 'Map update' },
].map(Object.freeze))

const TITLE = Object.fromEntries(LEGS.map((l) => [l.key, l.title]))

// The rows that say the agent is gone while a leg is outstanding.
const CLOSING = {
  lifecycle_closed: 'the agent ended',
  dispatch_unclaimed: 'the claim was released',
  agent_died: 'the agent died',
  agent_died_released: 'the agent died',
  agent_cancelled: 'the agent was cancelled',
  agent_abnormal_exit: 'the agent exited abnormally',
}
const PR_TYPES = new Set(['pr_opened', 'pr_reused', 'land_repaired'])
const RESOLVED = new Set(['present', 'repaired'])
const MAP_DONE = new Set(['appended', 'present'])
const SHARED_ROW = new Set(['merge', 'resolution'])

const refuse = (message) => Object.assign(new Error(message), { refusal: true })
const parse = (row) => {
  let ev = {}
  try { ev = JSON.parse(row.body) } catch { /* an unreadable body is a row that proves nothing */ }
  return { id: Number(row.id), ts: row.ts, type: row.type, ticket: row.ticket ?? null, agent: row.agent ?? null, ev }
}
const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`
const threadUrl = (guild, thread) => (guild && thread ? `https://discord.com/channels/${guild}/${thread}` : null)
const ms = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a))

export class FullLoop {
  // `discover(repo)` is the dispatcher's frontier read for one repository,
  // `dispatch(repo, n)` its `start`, both real. `journal(type, data)` writes
  // a row, `lastRun()` answers the last `full_loop_started` row, and
  // `eventsSince(id, { ticket, agent })` the rows after it. Every one of
  // these is a seam a test fills without a network.
  constructor({ discover, dispatch, journal, lastRun, eventsSince, now = () => new Date(), log = () => {} }) {
    this.discover = discover
    this.dispatch = dispatch
    this.journal = journal
    this.lastRun = lastRun
    this.eventsSince = eventsSince
    this.now = now
    this.log = log
    this.pending = null
  }

  // The press. The gate is this read's answer from `IntegrationSetup#status()`;
  // a closed gate runs nothing. The repository defaults to the covered one the
  // gate leads with, and the ticket to the one marked on that frontier.
  async start(gate, { repo = null, ticket = null } = {}) {
    const current = this.status()
    if (current.state === 'running') {
      throw refuse(`A Full loop is already running on ${current.repo}#${current.ticket?.number}. Wait for it, or cancel ${current.ticket?.number} in the command channel.`)
    }
    if (!gate?.ready || !gate.facts) throw refuse(`The Full loop isn't ready: ${gate?.reason ?? 'setup is not verified on this read'}`)
    const facts = gate.facts
    const covered = Array.isArray(facts.github?.covered) ? facts.github.covered : []
    const chosen = repo ?? facts.github?.repo ?? covered[0] ?? null
    if (!chosen || !covered.includes(chosen)) {
      throw refuse(`${chosen ?? 'no repository'} is not a covered repository. Covered: ${covered.join(', ') || 'none'}.`)
    }
    const requested = ticket == null || ticket === '' ? null : Number(ticket)
    if (requested != null && !(Number.isInteger(requested) && requested > 0)) throw refuse(`"${String(ticket).slice(0, 40)}" is not a ticket number`)
    this.journal('full_loop_started', {
      repo: chosen,
      requested,
      guild_id: facts.discord?.guild?.id ?? null,
      channel_name: facts.discord?.channel?.name ?? null,
      channel_url: facts.discord?.channel?.url ?? null,
      provider: facts.model?.provider ?? null,
      model: facts.model?.model ?? null,
      address: facts.tailscale?.address ?? null,
    })
    const found = await this.#discover(chosen, requested)
    if (found) this.#launch(chosen, found.number)
    return this.status()
  }

  // Same-step retry. Discovery reruns the frontier read; every later leg is
  // a fresh dispatch of the same ticket, because the agent that would have
  // walked it is gone (that is what failed the leg).
  async retry() {
    const current = this.status()
    if (current.state === 'running') throw refuse(`A Full loop is running on ${current.repo}#${current.ticket?.number}; there is nothing to retry yet.`)
    if (current.state !== 'failed') throw refuse('There is nothing to retry.')
    const run = this.#load()
    this.journal('full_loop_retry', { repo: current.repo, ticket: current.ticket?.number ?? null, leg: current.failed.leg })
    if (current.failed.leg === 'discovery') {
      const found = await this.#discover(current.repo, run.started.ev.requested ?? null)
      if (found) this.#launch(current.repo, found.number)
    } else {
      this.#launch(current.repo, current.ticket.number)
    }
    return this.status()
  }

  // The dispatch in flight, for a caller that has to wait for its verdict.
  settled() {
    return this.pending ?? Promise.resolve()
  }

  // Leg 1. The frontier is the dispatcher's own read, so "takeable" means
  // what it means everywhere else; the marking is the one thing added.
  async #discover(repo, requested) {
    const fail = (cause, action) => {
      this.journal('full_loop_failed', { repo, ticket: requested, leg: 'discovery', cause, action })
      return null
    }
    let read
    try {
      read = await this.discover(repo)
    } catch (e) {
      read = { repo, error: e.message }
    }
    if (!read || read.error) {
      return fail(`curia could not read the frontier of ${repo}: ${read?.error ?? 'no answer'}`, 'Check the GitHub card, then select Try again.')
    }
    const items = Array.isArray(read.items) ? read.items : []
    const marked = (i) => (i.labels ?? []).includes(REHEARSAL_LABEL)
    let item
    if (requested != null) {
      item = items.find((i) => Number(i.number) === requested)
      if (!item) return fail(`${repo}#${requested} is not on the frontier of ${repo}.`, `Make sure ${repo}#${requested} is open, unassigned, and unblocked, then select Try again.`)
      if (!marked(item)) return fail(`${repo}#${requested} is not marked ${REHEARSAL_LABEL}.`, `Add the ${REHEARSAL_LABEL} label to ${repo}#${requested}, then select Try again.`)
    } else {
      item = items.find(marked)
      if (!item) {
        return fail(`No takeable ticket of ${repo} is marked ${REHEARSAL_LABEL}.`, `Label one open, unassigned, unblocked ticket of ${repo} with ${REHEARSAL_LABEL}, then select Try again.`)
      }
    }
    const found = { number: Number(item.number), title: String(item.title ?? ''), url: issueUrl(repo, item.number), map: item.map ?? null }
    this.journal('full_loop_discovered', { repo, ticket: found.number, title: found.title, url: found.url, map: found.map })
    return found
  }

  // Leg 2, not awaited by the press: a dispatch clones and starts a
  // container, which can outlast the page's read. The spawn row is the
  // evidence; a reply with no spawn behind it is the cause of the failure.
  #launch(repo, n) {
    this.pending = (async () => {
      let reply
      try {
        reply = await this.dispatch(repo, n)
      } catch (e) {
        reply = e.message
      }
      const s = this.status()
      const leg = s.legs.find((l) => l.key === 'dispatch')
      if (leg?.state === 'running') {
        this.journal('full_loop_failed', {
          repo, ticket: n, leg: 'dispatch',
          cause: String(reply ?? 'the dispatcher gave no answer').trim(),
          action: `Fix what the dispatcher named, then select Try again to dispatch ${repo}#${n} again.`,
        })
      }
    })().catch((e) => this.log(`[full-loop] ${e.message}`)).finally(() => { this.pending = null })
  }

  // The run, from the journal: the last start row, the ticket discovery
  // named, and every row since that can belong to this run.
  #load() {
    const last = this.lastRun()
    if (!last) return null
    const started = parse(last)
    const own = (r) => r.type.startsWith('full_loop_')
    let rows = this.eventsSince(started.id, { ticket: null, agent: null }).map(parse).filter(own)
    const discovered = rows.filter((r) => r.type === 'full_loop_discovered').at(-1) ?? null
    const ticket = discovered ? String(discovered.ev.ticket) : null
    const agent = ticket ? `curia-${ticket}` : null
    if (ticket) {
      rows = this.eventsSince(started.id, { ticket, agent }).map(parse).filter((r) =>
        own(r)
        || r.type === 'esc_answer' || r.type === 'esc_cancel'
        || ((r.ticket != null || r.agent != null)
          && (r.ticket == null || r.ticket === ticket)
          && (r.agent == null || r.agent === agent)))
    }
    return { started, rows, discovered, ticket, agent }
  }

  #idle() {
    return {
      state: 'idle', repo: null, ticket: null, started_at: null, finished_at: null, elapsed_ms: null,
      legs: LEGS.map((l) => ({ key: l.key, title: l.title, state: 'pending', at: null, ms: null, link: null })),
      failed: null,
      links: { ticket: null, thread: null, channel: null, pull_request: null, map: null },
    }
  }

  status() {
    const run = this.#load()
    if (!run) return this.#idle()
    const { started, rows, discovered, ticket, agent } = run
    const out = this.#idle()
    out.state = 'running'
    out.repo = started.ev.repo ?? null
    out.started_at = started.ts
    out.links.channel = started.ev.channel_url ?? null
    const legs = Object.fromEntries(out.legs.map((l) => [l.key, l]))
    const channel = started.ev.channel_name ? `#${started.ev.channel_name}` : 'the command channel'
    let lastAt = started.ts
    const complete = (key, row, link = null) => {
      const leg = legs[key]
      leg.state = 'complete'
      leg.at = row.ts
      leg.ms = ms(lastAt, row.ts)
      leg.link = link
      lastAt = row.ts
    }
    const fail = (key, cause, action, at) => {
      legs[key].state = 'failed'
      out.state = 'failed'
      out.failed = { leg: key, title: TITLE[key], cause, action }
      out.finished_at = at
    }
    const after = (id, pred) => rows.find((r) => r.id > id && pred(r)) ?? null
    const cut = rows.filter((r) => r.type === 'full_loop_retry').at(-1)?.id ?? started.id
    const failedRow = (leg, since) => rows.filter((r) => r.type === 'full_loop_failed' && r.ev.leg === leg && r.id > since).at(-1) ?? null

    // 1. Discovery: the last frontier read that found the marked ticket, or
    // the last failure after the last retry, whichever is later.
    const lostDiscovery = failedRow('discovery', started.id)
    if (discovered && (!lostDiscovery || lostDiscovery.id < discovered.id)) {
      out.ticket = { number: Number(discovered.ev.ticket), title: discovered.ev.title ?? '', url: discovered.ev.url ?? issueUrl(out.repo, discovered.ev.ticket), map: discovered.ev.map ?? null }
      out.links.ticket = out.ticket.url
      if (out.ticket.map != null) out.links.map = issueUrl(out.repo, out.ticket.map)
      complete('discovery', discovered, out.ticket.url)
    } else if (lostDiscovery) {
      fail('discovery', lostDiscovery.ev.cause, lostDiscovery.ev.action, lostDiscovery.ts)
      return this.#finish(out, started)
    } else {
      legs.discovery.state = 'running'
      return this.#finish(out, started)
    }

    // 2. Dispatch: this ticket's session spawned after the discovery (and
    // after the last retry). A stray spawn before the retry is not the
    // retry's.
    // A dispatch the loop judged failed stays failed until Try again moves
    // the cut: a spawn of this ticket after that verdict is somebody else's
    // `start`, not this run's.
    const since = Math.max(cut, discovered.id)
    const lost = failedRow('dispatch', since)
    if (lost) {
      fail('dispatch', lost.ev.cause, lost.ev.action, lost.ts)
      return this.#finish(out, started)
    }
    const spawn = after(since, (r) => r.type === 'agent_spawned' && r.agent === agent)
    if (!spawn) {
      legs.dispatch.state = 'running'
      return this.#finish(out, started)
    }
    complete('dispatch', spawn, null)
    const thread = after(since, (r) => r.type === 'thread_bound' && r.ticket === ticket)
    out.links.thread = threadUrl(started.ev.guild_id, thread?.ev.thread_id)

    // 3 to 8, after the spawn and in order. The agent ending with a leg
    // outstanding is the failure of that leg.
    const epoch = spawn.id
    const closing = after(epoch, (r) => Object.hasOwn(CLOSING, r.type) && (r.agent === agent || (r.agent == null && r.ticket === ticket)))
    let cursor = epoch
    const walk = [
      ['escalation', () => {
        const open = after(cursor, (r) => r.type === 'esc_open' && r.agent === agent && r.ev.kind !== REVIEW_KIND)
        if (!open) return null
        const answer = after(open.id, (r) => r.type === 'esc_answer' && String(r.ev.id) === String(open.ev.id))
        return answer ? [answer, out.links.thread] : null
      }],
      ['pull_request', () => {
        const pr = after(cursor, (r) => PR_TYPES.has(r.type))
        if (!pr) return null
        out.links.pull_request = pr.ev.url ?? null
        return [pr, out.links.pull_request]
      }],
      ['review', () => {
        const ok = after(cursor, (r) => r.type === 'review_answered' && r.ev.approved === true)
        return ok ? [ok, out.links.pull_request] : null
      }],
      ['merge', () => {
        const done = after(cursor, (r) => r.type === 'ticket_resolved')
        if (!done || done.ev.land !== 'merged') return null
        out.links.pull_request = done.ev.pr ?? out.links.pull_request
        return [done, out.links.pull_request]
      }],
      ['resolution', () => {
        const done = after(cursor, (r) => r.type === 'ticket_resolved')
        if (!done || !RESOLVED.has(done.ev.comment) || !RESOLVED.has(done.ev.close)) return null
        return [done, out.links.ticket]
      }],
      ['map_update', () => {
        const done = after(cursor, (r) => r.type === 'ticket_resolved')
        if (!done || !MAP_DONE.has(done.ev.map)) return null
        const pointer = after(epoch, (r) => (r.type === 'map_pointer_appended' || r.type === 'map_pointer_present') && r.ticket === ticket)
        if (pointer?.ev.map != null) out.links.map = issueUrl(out.repo, pointer.ev.map)
        return [done, out.links.map]
      }],
    ]
    for (const [key, judge] of walk) {
      const found = judge()
      if (!found) {
        if (closing) {
          const why = closing.ev.reason ?? closing.ev.error ?? CLOSING[closing.type]
          fail(key, `The agent ended before ${TITLE[key]}: ${why}.`, `Read the thread of ${out.repo}#${ticket} in ${channel} and fix what stopped the agent, then select Try again to dispatch ${out.repo}#${ticket} again.`, closing.ts)
        } else {
          legs[key].state = 'running'
        }
        return this.#finish(out, started)
      }
      complete(key, found[0], found[1])
      // The merge, the resolution, and the map update are three verdicts of
      // one receipt row, so the cursor stops short of it until the last one.
      cursor = Math.max(cursor, found[0].id - (SHARED_ROW.has(key) ? 1 : 0))
    }

    // Every leg on one pass: the run is complete, and said so once.
    out.state = 'complete'
    out.finished_at = lastAt
    if (!after(epoch, (r) => r.type === 'full_loop_completed')) {
      this.journal('full_loop_completed', {
        repo: out.repo, ticket, agent, elapsed_ms: ms(started.ts, lastAt),
        pull_request: out.links.pull_request, map: out.links.map, thread: out.links.thread,
      })
    }
    return this.#finish(out, started)
  }

  #finish(out, started) {
    const end = out.state === 'running' ? this.now().toISOString() : out.finished_at ?? this.now().toISOString()
    out.elapsed_ms = ms(started.ts, end)
    return out
  }
}

// The Test run: one Full loop as the installation acceptance (#882, the #857
// acceptance contract on the #853 journey; reshaped by the #891 rehearsal).
//
// The first real Full loop is the last checkpoint of an installation. There
// is no evidence subsystem: the run is one press on the verified facts the
// gate (#880) handed over, driven by the daemon's own machinery, and judged
// by the rows that machinery already writes to the journal while it works.
//
//   CREATE    the press creates a tiny wayfinder map in the covered
//             repository, "Test run <date>", with two child tickets: add one
//             line to the README, then remove it, the second blocked by the
//             first through GitHub's native dependency (#891). Both carry the
//             `rehearsal` label. The tracker writes are real, and every one
//             is journalled as it lands, so Try again resumes the same map.
//   SELECT    the frontier read IS the first leg of each ticket: the ticket
//             has to be takeable by Curia's own rule (open, unassigned,
//             unblocked, on an open map). Ticket 2 is takeable only once
//             ticket 1 is closed, which is the dependency doing its work.
//   DRIVE     `dispatch(repo, n)` is the dispatcher's `start`, with the same
//             claim, clone, container, and spawn every other dispatch gets.
//             Everything after the spawn is the agent's inner loop and the
//             daemon's ending, untouched. Ticket 1 through the eight legs,
//             then ticket 2 through the same eight.
//   JUDGE     every later leg is one row the daemon writes and nothing else:
//             `esc_open` plus its `esc_answer`, `pr_opened`, `review_answered`
//             with `approved`, and the `ticket_resolved` receipt's own `land`,
//             `close`, and `map` verdicts. A leg counts only after the run's
//             spawn, only for this ticket's session, and only in order. The
//             ninth leg, "Map closed", is the map lifecycle's own close row
//             (`map_fog_closed`, or `map_verdict_answered` with `closed`)
//             after the operator's verdict on the empty map.
//   FAIL      the agent ending with a leg outstanding names that leg, the one
//             cause, and the one action; the completed legs stand; Try again
//             reruns from the failed leg on the same map and ticket.
//
// NOTHING IS STORED BUT THE JOURNAL. `status()` rebuilds the run from the last
// `full_loop_started` row and the rows after it on every read, so a restart
// mid-run reads the same run, and `curia doctor` (#881) keeps reading the
// gate: a finished run is a record on the feed, never a readiness marker.
//
// WHAT THE RUN WAITS FOR (#891). The run carries `waiting`: the last open
// `esc_open` addressed to the ticket in flight (or to the map, for the
// verdict), with its kind, prompt, options, how long it has been open, and
// `message`, the escalation as the bridge composed it (escalationembed.mjs),
// so the page shows the operator the message Discord got and takes the
// answer through the daemon's own `/answer`. It also carries `sessions`: the
// agent's session while it lives and the overseer's while it is in a turn,
// each with the terminal link the app serves (`<app_url>/terminal/?arg=
// <session>`, as #943 composes it).

import { REVIEW_KIND } from './lifecycle.mjs'
import { TERMINAL_PAGE } from './dashboard.mjs'
import { escalationEmbed } from './escalationembed.mjs'
import { testRunMap, testRunDate, TEST_RUN_LABEL } from './testrunmap.mjs'
import { KEEP_MAP_OPEN } from './mapfog.mjs'

export const REHEARSAL_LABEL = TEST_RUN_LABEL
export const TICKETS_PER_RUN = 2

// The legs, in the order the loop walks them (CONTEXT.md, "Full loop"),
// plus the close of the map the run made.
export const LEGS = Object.freeze([
  { key: 'discovery', title: 'Frontier discovery' },
  { key: 'dispatch', title: 'Dispatch' },
  { key: 'escalation', title: 'Escalation and answer' },
  { key: 'pull_request', title: 'Pull request' },
  { key: 'review', title: 'Review' },
  { key: 'merge', title: 'Merge' },
  { key: 'resolution', title: 'Ticket resolution' },
  { key: 'map_update', title: 'Map update' },
  { key: 'map_closed', title: 'Map closed' },
].map(Object.freeze))
export const TICKET_LEGS = LEGS.slice(0, 8).map((l) => l.key)

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
const MAP_ROWS = new Set(['map_fog_closed', 'map_verdict_answered', 'map_fog_verdict_posted'])
const ESC_CLOSING = new Set(['esc_answer', 'esc_cancel', 'esc_supersede'])

// How often the discovery re-reads a frontier that does not list the ticket
// yet: GitHub takes a moment to index a new issue, and to clear a dependency
// after the blocker closes.
const FRONTIER_READS = 4
const FRONTIER_WAIT_MS = 3000

const refuse = (message) => Object.assign(new Error(message), { refusal: true })
const parse = (row) => {
  let ev = {}
  try { ev = JSON.parse(row.body) } catch { /* an unreadable body is a row that proves nothing */ }
  return { id: Number(row.id), ts: row.ts, type: row.type, ticket: row.ticket ?? null, agent: row.agent ?? null, ev }
}
const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`
const threadUrl = (guild, thread) => (guild && thread ? `https://discord.com/channels/${guild}/${thread}` : null)
const terminalUrl = (appUrl, session) => {
  const page = `${TERMINAL_PAGE}?arg=${encodeURIComponent(session)}`
  if (!appUrl) return page
  try { return new URL(page, appUrl).toString() } catch { return page }
}
const ms = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a))
const sleep = (t) => new Promise((r) => setTimeout(r, t))

export class FullLoop {
  // `discover(repo)` is the dispatcher's frontier read for one repository,
  // `dispatch(repo, n)` its `start`, both real. `tracker` is the GitHub
  // writer the map needs: `createIssue`, `addSubIssue`, `addBlockedBy`, and
  // `fetchIssue`. `journal(type, data)` writes a row, `lastRun()` answers the
  // last `full_loop_started` row, and `eventsSince(id, { tickets, agents })`
  // the rows after it. `agentLive(session)` says whether a session runs now,
  // and `overseerSessions()` names the overseer panes in a turn. `dataDir`
  // is where reply files land, which the escalation message names. Every one
  // of these is a seam a test fills without a network.
  constructor({ discover, dispatch, tracker = {}, journal, lastRun, eventsSince, now = () => new Date(), wait = sleep, log = () => {}, agentLive = () => false, overseerSessions = () => [], dataDir = null }) {
    this.discover = discover
    this.dispatch = dispatch
    this.tracker = tracker
    this.journal = journal
    this.lastRun = lastRun
    this.eventsSince = eventsSince
    this.now = now
    this.wait = wait
    this.log = log
    this.agentLive = agentLive
    this.overseerSessions = overseerSessions
    this.dataDir = dataDir
    this.pending = null
    this.nudged = null
  }

  // The press. The gate is this read's answer from `IntegrationSetup#status()`;
  // a closed gate runs nothing. The repository defaults to the covered one the
  // gate leads with. The press creates the map and its two tickets, then
  // discovers and dispatches ticket 1; a second Test run creates a new map.
  async start(gate, { repo = null } = {}) {
    const current = this.status()
    if (current.state === 'running') {
      throw refuse(`A Test run is already running on ${current.repo}${current.ticket ? `#${current.ticket.number}` : ''}. Wait for it, or cancel ${current.ticket?.number ?? 'the ticket'} in the command channel.`)
    }
    if (!gate?.ready || !gate.facts) throw refuse(`The Test run isn't ready: ${gate?.reason ?? 'setup is not verified on this read'}`)
    const facts = gate.facts
    const covered = Array.isArray(facts.github?.covered) ? facts.github.covered : []
    const chosen = repo ?? facts.github?.repo ?? covered[0] ?? null
    if (!chosen || !covered.includes(chosen)) {
      throw refuse(`${chosen ?? 'no repository'} is not a covered repository. Covered: ${covered.join(', ') || 'none'}.`)
    }
    const date = testRunDate(this.now())
    this.journal('full_loop_started', {
      repo: chosen,
      title: testRunMap(date).title,
      date,
      guild_id: facts.discord?.guild?.id ?? null,
      channel_name: facts.discord?.channel?.name ?? null,
      channel_url: facts.discord?.channel?.url ?? null,
      provider: facts.model?.provider ?? null,
      model: facts.model?.model ?? null,
      // The row the tickets dispatch on (#891), so the panel says what the
      // run costs: the cheap model at low effort.
      test_run: facts.model?.test_run ? { model: facts.model.test_run.model ?? null, id: facts.model.test_run.id ?? null, effort: facts.model.test_run.effort ?? null } : null,
      address: facts.tailscale?.address ?? null,
      app_url: facts.tailscale?.app_url ?? null,
    })
    await this.#advance()
    return this.status()
  }

  // Same-step retry. Creation and discovery rerun their reads and writes on
  // the same map; every later ticket leg is a fresh dispatch of the same
  // ticket, because the agent that would have walked it is gone (that is
  // what failed the leg); the map close re-reads the map.
  async retry() {
    const current = this.status()
    if (current.state === 'running') throw refuse(`A Test run is running on ${current.repo}${current.ticket ? `#${current.ticket.number}` : ''}; there is nothing to retry yet.`)
    if (current.state !== 'failed') throw refuse('There is nothing to retry.')
    this.journal('full_loop_retry', { repo: current.repo, ticket: current.ticket?.number ?? null, map: current.map?.number ?? null, leg: current.failed.leg })
    if (current.failed.leg === 'map_closed') {
      await this.#readMapClosed(current.repo, current.map.number)
    } else if (current.failed.leg === 'discovery') {
      await this.#advance()
    } else {
      this.#launch(current.repo, current.ticket.number)
    }
    return this.status()
  }

  // The dispatch in flight, for a caller that has to wait for its verdict.
  settled() {
    return this.pending ?? Promise.resolve()
  }

  // The next thing the run owes: the map and its tickets while they are not
  // all there, then the discovery and dispatch of the ticket that is next.
  // Called from the press, from the retry, and from `status()` once ticket 1
  // has completed and ticket 2 is not yet discovered.
  #advance() {
    if (this.pending) return this.ready
    let settle
    this.ready = new Promise((r) => { settle = r })
    this.pending = (async () => {
      const run = this.#load()
      if (!run) return
      const repo = run.started.ev.repo
      const made = await this.#create(run)
      if (!made) return
      const next = this.#nextTicket(this.status())
      if (!next) return
      const found = await this.#discover(repo, next)
      // The press answers here: the map and the discovery are its own, the
      // dispatch clones and starts a container, which can outlast the read.
      settle()
      if (found) await this.#launchNow(repo, found.number)
    })().catch((e) => this.log(`[test-run] ${e.message}`)).finally(() => { this.pending = null; settle() })
    return this.ready
  }

  // Which ticket discovery is owed for, from the status: the first ticket
  // that has no discovery yet while every earlier one is complete.
  #nextTicket(s) {
    if (s.state !== 'running') return null
    return s.tickets.find((t) => t.state === 'pending') ?? null
  }

  // The map and its two tickets, each write journalled as it lands, so a
  // retry after a failed write creates only what is missing. The rows are the
  // run's own (`full_loop_map_created`, `full_loop_ticket_created`,
  // `full_loop_blocked`), and the map number rides them all.
  async #create(run) {
    const repo = run.started.ev.repo
    const date = run.started.ev.date ?? testRunDate(this.now())
    const spec = testRunMap(date)
    const fail = (cause) => {
      this.journal('full_loop_failed', { repo, ticket: null, map: run.map?.number ?? null, leg: 'discovery', cause, action: 'Check the GitHub card and the repository, then select Try again to create what is missing.' })
      return false
    }
    try {
      let map = run.map
      if (!map) {
        const issue = await this.tracker.createIssue(repo, { title: spec.title, body: spec.body, labels: spec.labels })
        map = { number: Number(issue.number), id: issue.id ?? null, title: spec.title, url: issue.html_url ?? issueUrl(repo, issue.number) }
        this.journal('full_loop_map_created', { repo, map: map.number, map_id: map.id, title: map.title, url: map.url })
      }
      const tickets = [...run.tickets]
      for (let index = tickets.length + 1; index <= TICKETS_PER_RUN; index += 1) {
        const t = spec.tickets[index - 1]
        const issue = await this.tracker.createIssue(repo, { title: t.title, body: t.body(tickets[0]?.number), labels: t.labels })
        await this.tracker.addSubIssue(repo, map.number, issue.id)
        const made = { index, number: Number(issue.number), id: issue.id ?? null, title: t.title, url: issue.html_url ?? issueUrl(repo, issue.number) }
        tickets.push(made)
        this.journal('full_loop_ticket_created', { repo, map: map.number, index, ticket: made.number, ticket_id: made.id, title: made.title, url: made.url })
      }
      if (!run.blocked) {
        await this.tracker.addBlockedBy(repo, tickets[1].number, tickets[0].id)
        this.journal('full_loop_blocked', { repo, map: map.number, ticket: tickets[1].number, by: tickets[0].number })
      }
      return true
    } catch (e) {
      return fail(`curia could not create the Test run's map in ${repo}: ${e.message}`)
    }
  }

  // Leg 1 of a ticket. The frontier is the dispatcher's own read, so
  // "takeable" means what it means everywhere else. The read repeats a few
  // times while the ticket is not listed yet, because GitHub indexes a new
  // issue and clears a dependency with a short delay.
  async #discover(repo, ticket) {
    const n = ticket.number
    const fail = (cause, action) => {
      this.journal('full_loop_failed', { repo, ticket: n, leg: 'discovery', cause, action })
      return null
    }
    let item = null
    let read
    for (let attempt = 1; attempt <= FRONTIER_READS; attempt += 1) {
      try {
        read = await this.discover(repo)
      } catch (e) {
        read = { repo, error: e.message }
      }
      if (!read || read.error) {
        return fail(`curia could not read the frontier of ${repo}: ${read?.error ?? 'no answer'}`, 'Check the GitHub card, then select Try again.')
      }
      item = (Array.isArray(read.items) ? read.items : []).find((i) => Number(i.number) === n) ?? null
      if (item) break
      if (attempt < FRONTIER_READS) await this.wait(FRONTIER_WAIT_MS)
    }
    if (!item) {
      return fail(`${repo}#${n} is not on the frontier of ${repo}.`, `Make sure ${repo}#${n} is open, unassigned, and unblocked, then select Try again.`)
    }
    const found = { number: n, title: String(item.title ?? ticket.title ?? ''), url: issueUrl(repo, n), map: item.map ?? null, index: ticket.index }
    this.journal('full_loop_discovered', { repo, ticket: found.number, index: found.index, title: found.title, url: found.url, map: found.map })
    return found
  }

  // Leg 2, not awaited by the press: a dispatch clones and starts a
  // container, which can outlast the page's read. The spawn row is the
  // evidence; a reply with no spawn behind it is the cause of the failure.
  #launch(repo, n) {
    if (this.pending) return
    this.pending = this.#launchNow(repo, n).finally(() => { this.pending = null })
  }

  async #launchNow(repo, n) {
    let reply
    try {
      reply = await this.dispatch(repo, n)
    } catch (e) {
      reply = e.message
    }
    const s = this.status()
    const leg = s.legs.find((l) => l.key === 'dispatch')
    if (s.ticket?.number === n && leg?.state === 'running') {
      this.journal('full_loop_failed', {
        repo, ticket: n, leg: 'dispatch',
        cause: String(reply ?? 'the dispatcher gave no answer').trim(),
        action: `Fix what the dispatcher named, then select Try again to dispatch ${repo}#${n} again.`,
      })
    }
  }

  // Try again on the map close: the map is read as it stands. A map the
  // operator closed by hand counts, journalled as the run's own row.
  async #readMapClosed(repo, map) {
    let issue
    try {
      issue = await this.tracker.fetchIssue(repo, map)
    } catch (e) {
      this.journal('full_loop_failed', { repo, ticket: null, map, leg: 'map_closed', cause: `curia could not read ${repo}#${map}: ${e.message}`, action: 'Check the GitHub card, then select Try again.' })
      return
    }
    if (issue?.state === 'closed') {
      this.journal('full_loop_map_closed', { repo, map })
    } else {
      this.journal('full_loop_failed', { repo, ticket: null, map, leg: 'map_closed', cause: `${repo}#${map} is still open.`, action: `Close ${issueUrl(repo, map)} on GitHub, then select Try again.` })
    }
  }

  // The run, from the journal: the last start row, the map and tickets the
  // press created, and every row since that can belong to this run.
  #load() {
    const last = this.lastRun()
    if (!last) return null
    const started = parse(last)
    const own = (r) => r.type.startsWith('full_loop_')
    const ownRows = this.eventsSince(started.id, {}).map(parse).filter(own)
    const mapRow = ownRows.find((r) => r.type === 'full_loop_map_created') ?? null
    const map = mapRow ? { number: Number(mapRow.ev.map), id: mapRow.ev.map_id ?? null, title: mapRow.ev.title ?? '', url: mapRow.ev.url ?? issueUrl(started.ev.repo, mapRow.ev.map) } : null
    const tickets = ownRows.filter((r) => r.type === 'full_loop_ticket_created')
      .map((r) => ({ index: Number(r.ev.index), number: Number(r.ev.ticket), id: r.ev.ticket_id ?? null, title: r.ev.title ?? '', url: r.ev.url ?? issueUrl(started.ev.repo, r.ev.ticket) }))
      .sort((a, b) => a.index - b.index)
    const blocked = ownRows.some((r) => r.type === 'full_loop_blocked')
    const keys = { tickets: [...tickets.map((t) => String(t.number)), ...(map ? [String(map.number)] : [])], agents: tickets.map((t) => `curia-${t.number}`) }
    const ticketSet = new Set(keys.tickets)
    const agentSet = new Set(keys.agents)
    const rows = (keys.tickets.length ? this.eventsSince(started.id, keys).map(parse) : ownRows).filter((r) =>
      own(r)
      || ESC_CLOSING.has(r.type)
      || (MAP_ROWS.has(r.type) && map && Number(r.ev.map) === map.number)
      || ((r.ticket != null || r.agent != null)
        && (r.ticket == null || ticketSet.has(r.ticket))
        && (r.agent == null || agentSet.has(r.agent) || (r.agent === 'overseer' && r.ticket != null))))
    return { started, rows, map, tickets, blocked }
  }

  #idle() {
    return {
      state: 'idle', repo: null, title: null, model: null, map: null, tickets: [], ticket: null, started_at: null, finished_at: null, elapsed_ms: null,
      legs: LEGS.map((l) => ({ key: l.key, title: l.title, state: 'pending', at: null, ms: null, link: null })),
      failed: null,
      links: { ticket: null, thread: null, channel: null, pull_request: null, map: null },
      waiting: null,
      sessions: [],
    }
  }

  // The question the run waits for: the last open `esc_open` addressed to
  // the ticket in flight (its session's) or to the map (the overseer's
  // verdict question), with the message the bridge composed for it. `leg` is
  // the leg that runs while it is open, which is not always the escalation
  // leg: a review gate can stand while the agent never asked (#891).
  #waiting(rows, epoch, { agent = null, ticket = null } = {}, leg) {
    const closed = new Set(rows.filter((r) => ESC_CLOSING.has(r.type)).map((r) => String(r.ev.id)))
    const mine = (r) => (agent ? r.agent === agent : r.agent === 'overseer' && r.ticket === ticket)
    const open = rows.filter((r) => r.id > epoch && r.type === 'esc_open' && mine(r) && !closed.has(String(r.ev.id))).at(-1)
    if (!open) return null
    const review = open.ev.kind === REVIEW_KIND
    // The gate is about a pull request the leg walk may not have reached
    // yet (the agent never asked its question), so the gate names it itself.
    const pr = review ? rows.find((r) => r.id > epoch && PR_TYPES.has(r.type) && r.ev.url) : null
    const record = { id: String(open.ev.id), agent: open.agent, ticket: open.ticket, ...open.ev }
    return {
      id: String(open.ev.id), agent: open.agent, ticket: open.ticket, kind: open.ev.kind ?? null, prompt: open.ev.prompt ?? '',
      options: Array.isArray(open.ev.options) ? open.ev.options : null,
      // A typed card's options are lettered on every surface (ADR-0025).
      typed: Boolean(open.ev.payload),
      review, pull_request: pr?.ev.url ?? null, opened_at: open.ts,
      open_ms: Math.max(0, this.now().getTime() - Date.parse(open.ts)), leg,
      message: escalationEmbed(record, { dataDir: this.dataDir }),
    }
  }

  // The sessions the operator can follow while the run lives.
  #sessions(started, agent) {
    const link = (session, role) => ({ session, role, terminal_url: terminalUrl(started.ev.app_url ?? null, session) })
    const out = []
    if (agent && this.agentLive(agent)) out.push(link(agent, 'agent'))
    for (const session of this.overseerSessions() ?? []) out.push(link(session, 'overseer'))
    return out
  }

  status() {
    const run = this.#load()
    if (!run) return this.#idle()
    const { started, rows, map, tickets, blocked } = run
    const out = this.#idle()
    out.state = 'running'
    out.repo = started.ev.repo ?? null
    out.title = started.ev.title ?? null
    // What the run dispatches on: the provider the gate led with and the
    // test-run row as the press read it. A row from before #891 named no
    // row, and the run says nothing rather than a guess.
    out.model = started.ev.test_run
      ? { provider: started.ev.provider ?? null, model: started.ev.test_run.model ?? null, id: started.ev.test_run.id ?? null, effort: started.ev.test_run.effort ?? null }
      : null
    out.started_at = started.ts
    out.links.channel = started.ev.channel_url ?? null
    out.map = map ? { number: map.number, title: map.title, url: map.url } : null
    out.links.map = map?.url ?? null
    out.tickets = tickets.map((t) => ({ index: t.index, number: t.number, title: t.title, url: t.url, state: 'pending' }))
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
    const retries = rows.filter((r) => r.type === 'full_loop_retry')
    const failedRow = (leg, since, ticket = undefined) => rows.filter((r) => r.type === 'full_loop_failed' && r.ev.leg === leg && r.id > since && (ticket === undefined || r.ev.ticket == ticket)).at(-1) ?? null

    // 0. The map and its tickets. Until they are all there, the run is on
    // the first ticket's discovery: running while the press works, failed
    // when a write failed after the last retry.
    const lastRetry = retries.at(-1)?.id ?? started.id
    if (!map || tickets.length < TICKETS_PER_RUN || !blocked) {
      const lost = failedRow('discovery', lastRetry, null)
      if (lost) fail('discovery', lost.ev.cause, lost.ev.action, lost.ts)
      else legs.discovery.state = 'running'
      return this.#finish(out, started)
    }

    // 1 to 8, per ticket, in order. The legs shown are the ticket in
    // flight's; a ticket that completed all eight is marked complete on the
    // ticket list and the next one starts on fresh legs.
    let cursor = started.id
    for (const t of tickets) {
      const shown = out.tickets[t.index - 1]
      for (const key of TICKET_LEGS) Object.assign(legs[key], { state: 'pending', at: null, ms: null, link: null })
      out.ticket = { number: t.number, title: t.title, url: t.url, map: map.number, index: t.index, of: TICKETS_PER_RUN }
      out.links.ticket = t.url
      out.links.thread = null
      out.links.pull_request = null
      out.waiting = null
      out.sessions = []
      const ticket = String(t.number)
      const agent = `curia-${t.number}`
      const cut = retries.filter((r) => r.ev.ticket == t.number && TICKET_LEGS.includes(r.ev.leg)).at(-1)?.id ?? cursor

      // Discovery: the last frontier read that found the ticket, or the last
      // failure after the last retry, whichever is later.
      const discovered = rows.filter((r) => r.type === 'full_loop_discovered' && r.ev.ticket == t.number && r.id > cursor).at(-1) ?? null
      const lostDiscovery = failedRow('discovery', Math.max(cursor, lastRetry), t.number)
      if (discovered && (!lostDiscovery || lostDiscovery.id < discovered.id)) {
        complete('discovery', discovered, t.url)
      } else if (lostDiscovery) {
        shown.state = 'failed'
        fail('discovery', lostDiscovery.ev.cause, lostDiscovery.ev.action, lostDiscovery.ts)
        return this.#finish(out, started)
      } else {
        shown.state = 'pending'
        legs.discovery.state = 'running'
        // Ticket 1's discovery is the press's own; ticket 2's is owed once
        // ticket 1 completed, and this read is what notices.
        if (t.index > 1) this.#advance()
        return this.#finish(out, started)
      }
      shown.state = 'running'

      // Dispatch: this ticket's session spawned after the discovery (and
      // after the last retry). A dispatch the loop judged failed stays failed
      // until Try again moves the cut: a spawn of this ticket after that
      // verdict is somebody else's `start`, not this run's.
      const since = Math.max(cut, discovered.id)
      const lost = failedRow('dispatch', since, t.number)
      if (lost) {
        shown.state = 'failed'
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
      let at = epoch
      let resolvedRow = null
      const walk = [
        ['escalation', () => {
          const open = after(at, (r) => r.type === 'esc_open' && r.agent === agent && r.ev.kind !== REVIEW_KIND)
          if (!open) return null
          const answer = after(open.id, (r) => r.type === 'esc_answer' && String(r.ev.id) === String(open.ev.id))
          return answer ? [answer, out.links.thread] : null
        }],
        ['pull_request', () => {
          const pr = after(at, (r) => PR_TYPES.has(r.type) && (r.agent === agent || r.ticket === ticket))
          if (!pr) return null
          out.links.pull_request = pr.ev.url ?? null
          return [pr, out.links.pull_request]
        }],
        ['review', () => {
          const ok = after(at, (r) => r.type === 'review_answered' && r.ev.approved === true && (r.agent === agent || r.ticket === ticket))
          return ok ? [ok, out.links.pull_request] : null
        }],
        ['merge', () => {
          const done = after(at, (r) => r.type === 'ticket_resolved' && r.ticket === ticket)
          if (!done || done.ev.land !== 'merged') return null
          out.links.pull_request = done.ev.pr ?? out.links.pull_request
          return [done, out.links.pull_request]
        }],
        ['resolution', () => {
          const done = after(at, (r) => r.type === 'ticket_resolved' && r.ticket === ticket)
          if (!done || !RESOLVED.has(done.ev.comment) || !RESOLVED.has(done.ev.close)) return null
          return [done, out.links.ticket]
        }],
        ['map_update', () => {
          const done = after(at, (r) => r.type === 'ticket_resolved' && r.ticket === ticket)
          if (!done || !MAP_DONE.has(done.ev.map)) return null
          resolvedRow = done
          return [done, out.links.map]
        }],
      ]
      let stopped = false
      for (const [key, judge] of walk) {
        const found = judge()
        if (!found) {
          if (closing) {
            shown.state = 'failed'
            const why = closing.ev.reason ?? closing.ev.error ?? CLOSING[closing.type]
            fail(key, `The agent ended before ${TITLE[key]}: ${why}.`, `Read the thread of ${out.repo}#${ticket} in ${channel} and fix what stopped the agent, then select Try again to dispatch ${out.repo}#${ticket} again.`, closing.ts)
          } else {
            legs[key].state = 'running'
            out.waiting = this.#waiting(rows, epoch, { agent }, key)
            out.sessions = this.#sessions(started, agent)
          }
          stopped = true
          break
        }
        complete(key, found[0], found[1])
        // The merge, the resolution, and the map update are three verdicts of
        // one receipt row, so the cursor stops short of it until the last one.
        at = Math.max(at, found[0].id - (SHARED_ROW.has(key) ? 1 : 0))
      }
      if (stopped) return this.#finish(out, started)
      shown.state = 'complete'
      cursor = resolvedRow.id
    }

    // 9. The map closed by Curia's own map lifecycle: the empty-map verdict
    // the overseer asks once every child is closed, and the close row after
    // the operator's answer. A "keep open" verdict fails the leg; the retry
    // reads the map as it stands.
    const mapCut = retries.filter((r) => r.ev.leg === 'map_closed').at(-1)?.id ?? cursor
    const lostMap = failedRow('map_closed', mapCut, null)
    const closedRow = after(cursor, (r) =>
      (r.type === 'map_fog_closed' && Number(r.ev.map) === map.number)
      || (r.type === 'map_verdict_answered' && Number(r.ev.map) === map.number && r.ev.closed === true)
      || (r.type === 'full_loop_map_closed' && Number(r.ev.map) === map.number))
    if (!closedRow) {
      const kept = after(mapCut, (r) => r.type === 'map_fog_verdict_posted' && Number(r.ev.map) === map.number && r.ev.answer === KEEP_MAP_OPEN)
      if (lostMap && (!kept || kept.id < lostMap.id)) {
        fail('map_closed', lostMap.ev.cause, lostMap.ev.action, lostMap.ts)
      } else if (kept) {
        fail('map_closed', `You kept ${out.repo}#${map.number} open.`, `Close ${map.url} on GitHub, then select Try again.`, kept.ts)
      } else {
        legs.map_closed.state = 'running'
        out.waiting = this.#waiting(rows, cursor, { ticket: String(map.number) }, 'map_closed')
        out.sessions = this.#sessions(started, null)
        // The verdict is asked on the dispatcher's next frontier read; one
        // read is owed now so the operator is not left waiting for the poll.
        if (this.nudged !== map.number) {
          this.nudged = map.number
          Promise.resolve().then(() => this.discover(out.repo)).catch(() => {})
        }
      }
      return this.#finish(out, started)
    }
    complete('map_closed', closedRow, map.url)

    // Every leg on one pass: the run is complete, and said so once.
    out.state = 'complete'
    out.finished_at = lastAt
    if (!after(started.id, (r) => r.type === 'full_loop_completed')) {
      this.journal('full_loop_completed', {
        repo: out.repo, map: map.number, tickets: tickets.map((t) => t.number), elapsed_ms: ms(started.ts, lastAt),
        pull_request: out.links.pull_request, map_url: map.url, thread: out.links.thread,
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

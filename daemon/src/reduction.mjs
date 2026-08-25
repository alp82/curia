// The reduction (#31, renamed at #358): the daemon's in-memory state.
//
// The journal is the source of truth (`./journal.mjs`), and this state is a pure
// reduction over it, rebuilt on every boot — so the record survives daemon
// restarts and bridge post-failures (#22/#28). Discord message ids are part of
// the record so a rebooted daemon can still edit/close the rendered UI.
//
// "Store" names nothing in curia (#358). The durable record is the **journal**,
// whatever medium holds it. The class this file exports carried the old word
// until #407 renamed it, and the method that journals an event did too.
//
// Semantics owned here:
//   - first-valid-wins: answer/cancel close atomically; later attempts are rejected
//   - supersede (#29, #336): a re-issued ask_human — a second open record of one
//     kind on one agent, whatever its wording — marks the old record superseded;
//     answers posted to a dead id route along the successor chain to the live call
//   - the recorded answer (#369): a question re-asked word for word takes back
//     the answer #139 parked for it, while that note is still unread — so the
//     operator waits once for one question

import crypto from 'node:crypto'
import { nextConsoleKey } from './attach.mjs'
import { openJournal, normalizeEvent } from './journal.mjs'
import { Questions } from './questions.mjs'

// The button-confirm kind (#94, per #89's messaging discipline). Its own kind
// because a confirm behaves unlike every other escalation: no reminder, no
// pending resolver — the executing path is button → daemon — and it closes by
// LAPSING when the agent instance it is bound to exits.
export const CONFIRM_KIND = 'confirm'

// How much of the journal the feed keeps in memory (#262). The dashboard reads
// the daemon's last events over `GET /overview`, and the journal stays
// daemon-private — so the tail is held here, filled by the rebuild at boot and
// by every append after it. A ring rather than a re-read: the journal grows
// without bound and the dashboard polls, so reading it once per poll would make
// the cost of watching curia rise with its history.
export const RECENT_EVENTS = 100

// How many outcomes of each kind the status reads keep (#289). `/status` in
// Discord and the dashboard's fleet card both name the last few agents that
// ended, per kind and newest last.
export const RECENT_OUTCOMES = 5

// The three endings those reads count, and what each one is called on a
// surface. One name for one thing: the journal type is the daemon's word, and
// the value here is the operator's.
const OUTCOME_KINDS = {
  agent_cancelled: 'cancelled',
  lifecycle_closed: 'finished',
  agent_died: 'died',
}

// The events that name the pull request a dispatch pushed (#289). `pr_reused`
// is the second dispatch of a ticket whose pull request is already open, and
// `land_repaired` is the resolve step opening the one the agent never did.
const PR_EVENTS = new Set(['pr_opened', 'pr_reused', 'land_repaired'])

// #208, the caller's half of the rule — pure, so it can be checked without a
// live gateway, for the reason queuedNoteReply is pure (#170). What operator
// text typed in an agent's thread becomes, given the record the dispatcher
// holds for the agent that owns the thread:
//
//   not running → nothing queues. The words were about what THAT agent was
//                 doing, and it is gone. A queued one waits for a successor
//                 that never heard them — the `cancel 166` typed at 15:13
//                 and still pending against a 16:36 agent (#170).
//   running     → it queues, stamped with the instance it was typed at, and
//                 dies with that instance.
//
// `reads` keeps its one meaning (#170): the agent is running. A `failed`
// record is the early exit (#169), the ready timeout, the result-less exit.
//
// #299: NO record is the same fact. Every caller before the console resolved
// the agent through its thread, so the name always answered to a live record;
// the console's `POST /note` (#266) is handed a name out of a browser, and it
// can name an agent curia is not running. That is not a second rule, so it is
// not a second check at that one door: for the queue, "curia is not running
// that agent" and "that agent has failed" are the same answer.
export function noteDisposition(agent) {
  const reads = Boolean(agent) && agent.state !== 'failed'
  return { reads, instance: reads ? agent.instance ?? null : null }
}

// The two events the FEED does not carry (#388). One operator message to the
// overseer writes both, and they exist so a restart can find a turn it killed —
// they are bookkeeping, not news. The feed ring holds a hundred events and Home
// draws four of them, so a pair per chat message would push every dispatch,
// death and gate off the screen. What the operator DOES read about a killed
// turn is `overseer_turn_dropped`, which the feed carries.
const FEED_SILENT = new Set([
  'overseer_session_reserved', 'overseer_turn_started', 'overseer_turn_ended',
])

// The events lastAgentEvent must not count (#236) — see _apply.
const NOTE_EVENTS = new Set([
  'agent_note', 'agent_notes_drained', 'agent_notes_expired', 'agent_note_refused', 'agent_note_interrupted',
])

// The label a cross-check verdict rides under on the note queue (#165). It is
// the one label the expiry path treats differently: an ordinary note that dies
// gets a line, a verdict that dies gets its whole content (#252, ADR-0013).
export const VERDICT_LABEL = 'cross-check verdict'

// The label the cross-check START notice rides under (#258). A second label
// rather than the operator default, for the reason the verdict has its own: the
// words are curia's own mechanics, and a builder that read them as an operator
// note would answer them instead of obeying them (ADR-0013).
export const CROSS_CHECK_LABEL = 'cross-check started'

export class Reduction {
  constructor(dataDir, { log = () => {} } = {}) {
    this.dir = dataDir
    // The journal itself (`./journal.mjs`), on the daemon's one write connection
    // (ADR-0017). Opening it converts the journal file when this is the first
    // boot on the database (#323). The field is `db` and not `journal`, because
    // `journal()` is the verb this class exposes for writing one event.
    this.db = openJournal(dataDir, { log })
    // What the dispatcher asks the journal about the past (#408). Fifteen
    // indexed queries on the daemon's one connection, where a whole read used
    // to answer. `./questions.mjs` holds the SQL and the rules it runs under.
    this.questions = new Questions(this.db.db)
    this.escalations = new Map() // id -> record
    this.overseerNotes = new Map() // thread id -> pending synthetic lines (#94)
    this.agentNotes = new Map() // agent session -> pending operator notes (#108 item 14)
    this.overseerSessions = new Map() // thread id -> SDK session id (#92)
    this.transcriptLandings = new Map() // session -> rewind landing parent (#689, ADR-0024)
    this.pendingOverseerSessions = new Map() // thread id -> first pane launch id (#688)
    this.consoleConversations = new Map() // console key -> the live browser conversation (#333)
    this.consoleSpent = new Set() // every console key ever minted, deleted ones included (#333)
    this.ticketThreads = new Map() // ticket -> Discord thread id (#93)
    this.threadTickets = new Map() // Discord thread id -> ticket (#93)
    this.lastTicketThreads = new Map() // ticket -> last thread ever bound, releases notwithstanding (#140)
    this.lastThreadTickets = new Map() // thread id -> last ticket ever bound to it, the same way round (#257)
    this.mapCharters = new Map() // map number -> the chat handle that charted it (#241, read by #326)
    this.ticketRepos = new Map() // ticket -> repo of its last dispatch (#235)
    this.lastAgentEvents = new Map() // agent session -> last journal event about it (#236)
    this.notes = new Map() // note id -> every note ever queued, pending or not (#252)
    this.handoffNotes = new Map() // escalation id -> the note its recorded answer rides on (#369)
    this.recent = [] // the last RECENT_EVENTS journal lines, oldest first (#262)
    this.outcomes = { cancelled: [], finished: [], died: [] } // the last RECENT_OUTCOMES of each (#289)
    this.pullRequests = new Map() // agent session -> the pull request its CURRENT dispatch pushed (#289)
    this.limitResumes = new Map() // ticket -> the limit resume curia still owes it (#346)
    this.spawnFailures = new Map() // ticket -> its consecutive failed spawns (#444)
    this.releasedDeathCountsByTicket = new Map() // ticket -> released deaths after tool traffic (#578)
    this.speakingAgents = new Set() // agents whose current epoch reached the tool channel (#578)
    this.stallRecoveries = new Map() // ticket -> durable watchdog recovery steps (#574)
    this.operatorStallLaunches = new Map() // ticket -> operator stall respawn interrupted during launch (#574)
    this.coolings = { models: new Map(), providers: new Map() } // the caps that have LANDED, key -> reset instant (#377)
    this.tokenWarnings = new Map() // credential key -> the last warning curia said about it (#380)
    this.openLogins = new Map() // provider -> the re-authentication the journal has started and not ended (#671)
    this.pendingTurns = new Map() // conversation key -> the overseer turn still in flight (#388)
    this.droppedTurns = new Map() // conversation key -> the last turn a restart killed (#388)
    this.turnStarts = new Map() // conversation key -> when its last turn started (#388)
    this.lintRejects = new Map() // `<agent>|<kind>` -> the rejections the lint gate still holds (#418)
    this.backupAlarm = null // the journal-backup failure that still stands, or null (#436)
    this.mapAlarms = new Map() // "repo#map" -> the stranded-map alarm that still stands (#485)
    this.seq = 0
    this.noteSeq = 0
    this.rebuild()
  }

  // The boot pass (#322). It reads the journal page by page, in write order, and
  // fills every reduction from that one pass. The act is a **rebuild**, never a
  // replay: replay names sending a killed turn's message again (#388).
  //
  // It reads `body`, which is verbatim, so it is the last reader that runs the
  // #184 translation.
  rebuild() {
    for (const body of this.db.bodies()) {
      this._apply(normalizeEvent(JSON.parse(body)), { replay: true })
    }
  }

  // Close the write connection. The daemon never calls this: WAL with
  // `synchronous=full` means every append is already on disk, so a process that
  // dies loses nothing. A test that builds many reductions calls it.
  close() {
    this.db.close()
  }

  _append(event) {
    const rec = { ts: new Date().toISOString(), ...event }
    // Synchronous, which is what lets the crash guard journal and then exit.
    this.db.append(JSON.stringify(rec))
    this._apply(rec, { replay: false })
    // Live-event tap (#108 item 8): the status line watches the journal
    // instead of threading callbacks through the dispatcher. Never on replay —
    // a rebooted daemon must not re-announce history. An observer failure must
    // not fail the append: the journal write already happened and is the truth.
    try { this.onEvent?.(rec) } catch { /* observer errors never poison the record */ }
    return rec
  }

  // What an event looks like in the FEED, which rides every `/overview` poll.
  //
  // One event is trimmed: `review_requested` carries the whole diff digest
  // (#355), up to two hundred file rows, and the journal keeps that whole
  // because it is the durable record. The feed keeps only the totals — the ring
  // holds a hundred events and a phone re-reads it every five seconds, so a
  // per-file list riding it would be the poll cost #289 just removed, back
  // under a different name. The console reads the list off the review-gate
  // record, which carries it in full.
  #feedShape(ev) {
    if (!ev.diff?.list) return ev
    const { list, ...totals } = ev.diff
    return { ...ev, diff: { ...totals, list_on_the_record: list.length } }
  }

  _apply(ev, { replay }) {
    // The feed's tail (#262). Every event passes here exactly once, on replay
    // and on append alike, so the ring is right the instant the boot replay
    // ends and stays right for the rest of the run.
    if (!FEED_SILENT.has(ev.type)) {
      this.recent.push(this.#feedShape(ev))
      if (this.recent.length > RECENT_EVENTS) this.recent.shift()
    }

    // The last thing the journal says about an agent (#236): the direct answer
    // under a question in its thread reads it as progress evidence. The
    // note-queue family is excluded, because the question itself queues a note
    // one line above this read — an answer that reported the question as the
    // agent's last act would always be about itself.
    if (ev.agent && ev.ts && !NOTE_EVENTS.has(ev.type)) {
      this.lastAgentEvents.set(ev.agent, { type: ev.type, ts: ev.ts })
    }

    // The recent past the status reads ask about (#289). Both used to be
    // answered by reading the whole journal off disk, once per `/overview`
    // poll and again per open review gate — a cost that rose with every event
    // curia ever wrote. They are reductions now, for the reason the feed's
    // ring above is one: this method sees every event exactly once, on replay
    // and on append alike, so the answer is right without a second read.
    const outcome = OUTCOME_KINDS[ev.type]
    if (outcome) {
      const list = this.outcomes[outcome]
      list.push({ kind: outcome, repo: ev.repo ?? null, ticket: String(ev.ticket ?? '') })
      if (list.length > RECENT_OUTCOMES) list.shift()
    }
    // A spawn CLEARS the pull request (#253): the session name is reused by
    // every dispatch of a ticket, so a fresh agent must not inherit the link
    // the last one pushed. The order inside one journal is the order here.
    if (ev.agent && ev.type === 'agent_spawned') this.pullRequests.delete(ev.agent)
    if (ev.agent && ev.url && PR_EVENTS.has(ev.type)) this.pullRequests.set(ev.agent, ev.url)

    // The limit resume curia owes a ticket (#346). A reduction for the reason
    // the pull-request map above is one: the arm has to outlive the process
    // that made it. Cooling holds for hours and a deploy takes minutes, so an
    // arm kept only in the dispatcher would mostly never fire — and the boot
    // replay is what hands it back.
    //
    // TWO events clear it, and both mean the same thing. `limit_resume` is the
    // attempt itself, whatever it ended as: one arm buys one attempt, and a
    // fresh cap arms a fresh one. `agent_spawned` is an agent on that ticket by
    // any other route, which is what the resume was for.
    if (ev.ticket != null && ev.type === 'limit_resume_armed') {
      this.limitResumes.set(String(ev.ticket), { repo: ev.repo ?? null, at: ev.resume_at })
    }
    if (ev.ticket != null && (ev.type === 'limit_resume' || ev.type === 'agent_spawned')) {
      this.limitResumes.delete(String(ev.ticket))
    }

    // The failed spawns of a ticket (#444). A reduction for the reason the limit
    // resume above is one: the count decides what the auto loop does NEXT tick,
    // and a count kept only in the dispatcher would start again at zero after
    // every deploy — which is the loop this exists to stop.
    //
    // TWO events clear it, and each one says the same thing in its own way: this
    // ticket is not the one that dies at every spawn.
    //
    //   agent_mcp_first   the agent reached its tool channel, so the container
    //                     came up and the agent can speak. Whatever ends that
    //                     dispatch, it did not die at the spawn.
    //   dispatch_claimed  a dispatch the auto loop did not make. The operator
    //                     typed it, and a fresh order deserves a fresh count.
    //                     `by` names the caller, and only `auto` is the loop.
    const operatorDispatch = ev.ticket != null && ((ev.type === 'dispatch_claimed'
      && !['auto', 'stall-recovery'].includes(ev.by))
      || (ev.type === 'agent_spawned' && ev.operator_after_stall))
    if (ev.ticket != null && ev.type === 'dispatch_failed') {
      const key = String(ev.ticket)
      const held = this.spawnFailures.get(key)
      this.spawnFailures.set(key, { repo: ev.repo ?? held?.repo ?? null, count: (held?.count ?? 0) + 1 })
    }
    if (ev.ticket != null && (ev.type === 'agent_mcp_first' || operatorDispatch)) {
      this.spawnFailures.delete(String(ev.ticket))
    }

    // A released death after tool traffic gets one automatic resume (#578).
    // The second such death holds the ticket for an operator command.
    if (ev.agent && (ev.type === 'dispatch_claimed' || ev.type === 'agent_spawned')) {
      this.speakingAgents.delete(ev.agent)
    }
    if (ev.agent && ev.type === 'agent_mcp_first') this.speakingAgents.add(ev.agent)
    if (ev.ticket != null && ev.type === 'agent_died_released') {
      const key = String(ev.ticket)
      const held = this.releasedDeathCountsByTicket.get(key)
      this.releasedDeathCountsByTicket.set(key, {
        repo: ev.repo ?? held?.repo ?? null,
        count: (held?.count ?? 0) + 1,
      })
    }
    if (operatorDispatch) {
      this.releasedDeathCountsByTicket.delete(String(ev.ticket))
    }

    // The stall watchdog stores completed recovery steps per ticket (#574).
    // A start event reserves an effect but does not claim that it happened.
    // A restart can finish an interrupted step instead of skipping it.
    const nudgeDone = ['stall_nudge_accepted', 'stall_nudge_finished'].includes(ev.type)
    const nudgeCleared = ev.type === 'stall_cleared_before_nudge'
    const respawnDone = ev.type === 'stall_respawned'
      || (ev.type === 'agent_spawned' && ev.retry_after_stall && !ev.operator_after_stall)
    const nudgeAttempt = ['stall_nudge_started', 'stall_nudge_rejected'].includes(ev.type)
    const respawnStarting = ev.type === 'stall_respawn_started'
    const respawnLaunching = ev.type === 'stall_respawn_launching'
    if (ev.ticket != null && respawnLaunching && ev.operator_after_stall) {
      this.operatorStallLaunches.set(String(ev.ticket), { ...ev })
    }
    if (operatorDispatch) this.operatorStallLaunches.delete(String(ev.ticket))
    if (ev.ticket != null && (nudgeDone || nudgeCleared || nudgeAttempt || respawnDone || respawnStarting || respawnLaunching || ev.type === 'stall_escalated')) {
      const key = String(ev.ticket)
      const prior = this.stallRecoveries.get(key) ?? {
        repo: ev.repo ?? null, nudged: false, nudgeAttempts: 0,
        respawnStarted: false, respawned: false, respawnLaunching: false, escalated: false,
      }
      this.stallRecoveries.set(key, {
        repo: ev.repo ?? prior.repo ?? null,
        nudged: prior.nudged || nudgeDone,
        nudgeAttempts: nudgeCleared && !prior.nudged && Number(ev.attempt) === prior.nudgeAttempts
          ? Math.max(0, prior.nudgeAttempts - 1)
          : Math.max(prior.nudgeAttempts, nudgeAttempt ? Number(ev.attempt) || 0 : 0),
        respawnStarted: prior.respawnStarted || respawnStarting || respawnDone,
        respawned: prior.respawned || respawnDone,
        respawnLaunching: respawnDone ? false : (prior.respawnLaunching || respawnLaunching),
        escalated: prior.escalated || ev.type === 'stall_escalated',
      })
    }
    if (operatorDispatch) {
      this.stallRecoveries.delete(String(ev.ticket))
    }

    // The cooling curia has already MEASURED (#377). A reduction for the reason
    // the limit resume above is one: a 5-hour window outlives a deploy, so a
    // hold kept only in the dispatcher dies with the process that measured it,
    // and the next `start` spawns a container straight into the same cap.
    //
    // Nothing new is written for this: `#handleLimit` has journalled both events
    // with their `reset_at` since #175. This reads them back.
    //
    // The LANDED cap only, by event name. #384's pre-emptive hold is a guess
    // re-made from a fresh reading every ten minutes and cleared below 85%, so a
    // guess taken from the journal would hold the frontier on a reading curia no
    // longer has. It writes its own event type, and this reduction never sees it.
    //
    // Nothing clears an entry: a cooling ends by its own reset instant, and the
    // last event per key is the whole truth. A later cap on the same key
    // overwrites the earlier one, which is what a re-cool after a resume is.
    if (ev.type === 'model_cooling' && ev.model && ev.reset_at) {
      this.coolings.models.set(ev.model, ev.reset_at)
    }
    if (ev.type === 'provider_cooling' && ev.provider && ev.reset_at) {
      this.coolings.providers.set(ev.provider, ev.reset_at)
    }

    // The credential warnings still standing (#380). A reduction for the two
    // reasons the coolings above are one: the ladder must not re-say at every
    // boot what it already said, and the dashboard's Needs-you item has to
    // survive the deploy that happens between the warning and the operator
    // acting on it. The write path adds nothing for this — `token_warned` and
    // `token_cleared` are the events the watch already states.
    //
    // The key is composed here rather than carried, so one rule decides it: a
    // reach failure belongs to the credential and the repo together (ADR-0013,
    // and see tokenwatch.mjs rule 3).
    //
    // The `expiring` arm is REPLAY, not a live shape. #466 retired the last PAT
    // and the expiry half of the watch with it, so nothing writes that fault any
    // more. A journal written before it still holds rows that do, and this is
    // what lets the watch's next pass find one and clear it.
    // The journal backup's standing alarm (#436). A reduction for the reason the
    // credential warnings above are one: the alarm must not be re-said at every
    // boot, and a deploy happens between the failure and the operator acting on
    // it. A dump that lands clears it, because the fact it stated is gone.
    if (ev.type === 'journal_backup_failed') this.backupAlarm = { ...ev, at: ev.ts ?? null }
    if (ev.type === 'journal_backup') this.backupAlarm = null

    // The stranded-map alarm (#485). A reduction for the reason the backup's is
    // one: it must not be re-said at every boot or every frontier pass. The
    // clearing event is explicit, because the fact that ends it — the map
    // closed, deferred, or gained an open child — lives on GitHub, and the
    // frontier read is what observes it.
    if (ev.type === 'map_stranded') this.mapAlarms.set(`${ev.repo}#${ev.map}`, { ...ev, at: ev.ts ?? null })
    if (ev.type === 'map_stranded_cleared') this.mapAlarms.delete(`${ev.repo}#${ev.map}`)

    if (ev.type === 'token_warned' || ev.type === 'token_cleared') {
      const key = ev.fault === 'expiring'
        ? `${ev.holder}:${ev.key}`
        : `${ev.holder}:${ev.key}:${ev.repo}`
      if (ev.type === 'token_cleared') this.tokenWarnings.delete(key)
      else this.tokenWarnings.set(key, { ...ev, at: ev.ts ?? null })
    }

    switch (ev.type) {
      case 'esc_open': {
        const n = Number(ev.id.split('-')[1])
        if (n >= this.seq) this.seq = n
        this.escalations.set(ev.id, {
          id: ev.id, agent: ev.agent, ticket: ev.ticket, kind: ev.kind,
          prompt: ev.prompt, options: ev.options, preview_url: ev.preview_url,
          recommended: ev.recommended ?? false,
          // The typed payload (#418, ADR-0019). Null on an untyped call, which
          // since the flip (#422) is a flagged send or a record written before
          // #418. `prompt` is composed FROM this payload when it is
          // present (card.mjs), so the record still carries one readable
          // question for the timeline, the console and the inherited exchange
          // — and the bridge reads the payload for the parts only a component
          // can render.
          payload: ev.payload ?? null,
          // The lint faults a flagged send carried out anyway (ADR-0005: three
          // rejections, then the text goes as it stands). The card shows them
          // beside the text that failed them.
          lint_flags: ev.lint_flags ?? null,
          // The diff digest (#355). Counted once when the review gate opened
          // and stored HERE, so Discord and the console state the same numbers,
          // no poll re-counts anything, and the digest survives the agent dying
          // with its worktree. Null on every other kind, and null with a reason
          // on a gate curia could not count.
          diff: ev.diff ?? null, diff_error: ev.diff_error ?? null,
          // Was a CALL blocked on this record when it opened (#489)? True for
          // an `ask_human` and for the review gate, false for the flagged send
          // (#418), whose own call already returned the rejection, and false for
          // a confirm, which nothing waits on. The boot sweep is the one reader:
          // it presses Escape, and an agent that is working rather than parked
          // must never be interrupted by it.
          //
          // NULL is a record written before this field existed. It reads as "not
          // known to be awaited", which is the direction that presses no key.
          awaited: ev.awaited ?? null,
          payload_hash: ev.payload_hash, status: 'open', opened_at: ev.ts,
          action: ev.action ?? null, origin_thread_id: ev.origin_thread_id ?? null,
          discord: null, successor: null, agent_died: false,
        })
        // A record that opened is a call that got through, so the lint gate's
        // ledger for this call site starts fresh (#418). A flagged send opens a
        // record too, and clearing there is right: the question reached the
        // operator, which is the only thing the count was protecting.
        this.lintRejects.delete(`${ev.agent}|${ev.kind}`)
        break
      }
      // The lint gate's ledger (#418, ADR-0005). The daemon counts, because an
      // agent miscounts its own rejections — and it counts HERE rather than in
      // memory, because the restart that kills a blocked call must not also
      // reset the count that was holding its author to three attempts.
      case 'lint_rejected': {
        const key = `${ev.agent}|${ev.kind}`
        const prev = this.lintRejects.get(key)
        this.lintRejects.set(key, {
          agent: ev.agent, kind: ev.kind, count: (prev?.count ?? 0) + 1,
          faults: ev.faults ?? [], schema: Boolean(ev.schema),
          prompt: ev.prompt ?? null, payload: ev.payload ?? null,
          stop_blocks: prev?.stop_blocks ?? 0, at: ev.ts ?? null,
        })
        break
      }
      // The Stop hook's own count (#418). ADR-0005 says curia sends the text
      // itself at the SECOND stop block for one rejected call, and it named
      // `stop_hook_active` as the key. #447 then measured that flag STICKY
      // rather than per-question, so the count lives here instead. The decision
      // is unchanged: the second block sends.
      case 'lint_stop_blocked': {
        const held = this.lintRejects.get(`${ev.agent}|${ev.kind}`)
        if (held) held.stop_blocks = (held.stop_blocks ?? 0) + 1
        break
      }
      case 'lint_cleared': {
        this.lintRejects.delete(`${ev.agent}|${ev.kind}`)
        break
      }
      case 'escalation_agent_died': {
        // The liveness sweep's mark (#138): the agent died but its question
        // stays open and answerable. Reduced onto the record so the answer
        // path (#139) can see, across restarts, that nothing live waits here.
        const r = this.escalations.get(ev.id)
        if (r) r.agent_died = true
        break
      }
      case 'esc_render': {
        const r = this.escalations.get(ev.id)
        if (r) r.discord = { channelId: ev.channelId, threadId: ev.threadId, messageId: ev.messageId }
        break
      }
      case 'esc_answer': {
        const r = this.escalations.get(ev.id)
        if (r) {
          r.status = 'answered'; r.answer = ev.answer; r.answered_by = ev.by
          r.answered_via = ev.via; r.attachments = ev.attachments ?? []; r.closed_at = ev.ts
        }
        break
      }
      case 'esc_cancel': {
        const r = this.escalations.get(ev.id)
        if (r) { r.status = 'cancelled'; r.cancelled_by = ev.by; r.closed_at = ev.ts }
        break
      }
      case 'esc_lapse': {
        const r = this.escalations.get(ev.id)
        if (r) { r.status = 'lapsed'; r.lapse_reason = ev.reason; r.closed_at = ev.ts }
        break
      }
      case 'esc_supersede': {
        const r = this.escalations.get(ev.id)
        if (r) { r.status = 'superseded'; r.successor = ev.successor; r.closed_at = ev.ts }
        break
      }
      case 'esc_nudge':
        // The 30-minute tick died with #261, and nothing ever read its counter.
        // The case stays because the journal is append-only: 243 of these sit
        // in the real file, and an unknown type must not break the replay.
        break
      case 'thread_bound': {
        this.ticketThreads.set(String(ev.ticket), ev.thread_id)
        this.threadTickets.set(ev.thread_id, String(ev.ticket))
        this.lastTicketThreads.set(String(ev.ticket), ev.thread_id)
        this.lastThreadTickets.set(ev.thread_id, String(ev.ticket))
        break
      }
      case 'thread_released': {
        this.ticketThreads.delete(String(ev.ticket))
        this.threadTickets.delete(ev.thread_id)
        break
      }
      // The dispatcher's own line, read here for the thread (#241, #326). A
      // new-map session is named by a chat handle, and that handle stays bound
      // to the conversation thread for the whole session — it is the identity
      // every notify, escalation and status line addresses. The map number
      // takes the thread through this index instead, which is what makes a
      // later `map <n>` land back in the conversation that settled the
      // destination.
      case 'map_adopted': {
        if (ev.map != null && ev.ticket != null) this.mapCharters.set(String(ev.map), String(ev.ticket))
        break
      }
      case 'overseer_note': {
        const arr = this.overseerNotes.get(ev.thread_id) ?? []
        arr.push(ev.text)
        this.overseerNotes.set(ev.thread_id, arr)
        break
      }
      case 'agent_note': {
        const arr = this.agentNotes.get(ev.agent) ?? []
        // An absent stamp is session-keyed on purpose (#208): the #139
        // hand-off, and every note journalled before #208 was decided.
        // `label` is what the note calls itself on the agent's tool result
        // (#165). Absent means the operator typed it, which is every note
        // journalled before the cross-check had a way back.
        // `id` names ONE note (#252), so the interrupt button under a receipt
        // can point at the words that receipt was about. Absent on every note
        // journalled before the two delivery modes existed, and a receipt with
        // no id carries no button.
        // `handoff_for` names the escalation whose recorded answer this note
        // carries (#369). Only the #139 hand-off sets it, and it is what lets a
        // re-asked question find its own parked answer. Absent on every note
        // journalled before this ticket, so an old hand-off is delivered by the
        // drain alone, exactly as it always was.
        const note = {
          id: ev.id ?? null, agent: ev.agent, text: ev.text, after: ev.after ?? null,
          instance: ev.instance ?? null, label: ev.label ?? null, pending: true, at: ev.ts ?? null,
          handoff_for: ev.handoff_for ?? null,
        }
        if (note.id) {
          const n = Number(String(note.id).split('-')[1])
          if (Number.isFinite(n) && n >= this.noteSeq) this.noteSeq = n
          this.notes.set(note.id, note)
          if (note.handoff_for) this.handoffNotes.set(note.handoff_for, note.id)
        }
        arr.push(note)
        this.agentNotes.set(ev.agent, arr)
        break
      }
      case 'agent_notes_drained': {
        const arr = this.agentNotes.get(ev.agent) ?? []
        for (const n of arr.splice(0, ev.count)) n.pending = false
        break
      }
      case 'agent_notes_expired': {
        const live = ev.live_instance ?? null
        const arr = this.agentNotes.get(ev.agent) ?? []
        const kept = []
        for (const n of arr) {
          if (!n.instance || n.instance === live) kept.push(n)
          else n.pending = false
        }
        this.agentNotes.set(ev.agent, kept)
        break
      }
      // #252: the interrupt took these words out of the queue and put them in
      // the pane as a user turn. The note is no longer pending, so it can never
      // also ride a tool result — one fact, one delivery.
      case 'agent_note_interrupted': {
        const arr = this.agentNotes.get(ev.agent) ?? []
        const note = this.notes.get(ev.id)
        if (note) note.pending = false
        this.agentNotes.set(ev.agent, arr.filter((n) => n.id !== ev.id))
        break
      }
      // #369: the re-asked question took its own recorded answer. ONE event for
      // one act, because the answer and its note leave together — the call
      // returns the answer, so the note carries nothing left to say and a drain
      // that also delivered it would state one fact twice (ADR-0013).
      case 'esc_replayed': {
        const r = this.escalations.get(ev.id)
        if (r) r.replayed_at = ev.ts
        const note = this.notes.get(ev.note)
        if (note) note.pending = false
        const arr = this.agentNotes.get(ev.agent) ?? []
        this.agentNotes.set(ev.agent, arr.filter((n) => n.id !== ev.note))
        break
      }
      case 'overseer_notes_drained': {
        const arr = this.overseerNotes.get(ev.thread_id) ?? []
        arr.splice(0, ev.count)
        break
      }
      case 'dispatch_claimed':
      case 'agent_spawned': {
        // The repo behind a ticket number (#235): the thread label's repo
        // field reads it lazily, and the lazy path outlives the dispatcher's
        // in-memory record — so the journal's own dispatch lines are the
        // index. Last dispatch wins, the same rule the thread binding lives
        // under.
        if (ev.repo && ev.ticket != null) this.ticketRepos.set(String(ev.ticket), ev.repo)
        break
      }
      case 'overseer_session': {
        // #92: `resume` mints a fresh session id per continued conversation,
        // so last write wins — the map always points at the live tail.
        this.overseerSessions.set(ev.thread_id, ev.session_id)
        this.pendingOverseerSessions.delete(ev.thread_id)
        break
      }
      case 'overseer_session_reserved': {
        // A new pane needs its UUID before Claude starts. Keep that UUID apart
        // from a proven resume handle until the composer appears. If startup
        // fails or the daemon restarts, the next attempt uses --session-id
        // again instead of trying to resume a session Claude never created.
        this.pendingOverseerSessions.set(ev.thread_id, ev.session_id)
        break
      }
      case 'transcript_rewound': {
        this.transcriptLandings.set(ev.agent, ev.landing_uuid)
        break
      }
      case 'transcript_branch_started': {
        this.transcriptLandings.delete(ev.agent)
        break
      }
      // The browser conversations (#333, ADR-0016). Two reductions, because
      // "which conversations exist" and "which numbers are spent" are different
      // facts and only the second one survives a delete. The spent set never
      // shrinks: it is what makes the numbers only go up, and it is the whole
      // guard against a new conversation waking a deleted one's memory.
      case 'console_conversation_opened': {
        this.consoleSpent.add(ev.key)
        this.consoleConversations.set(ev.key, { key: ev.key, opened_at: ev.ts ?? null })
        break
      }
      case 'console_conversation_deleted': {
        this.consoleConversations.delete(ev.key)
        // The resume handle and the waiting notes go with it. Nothing can
        // address this key again, so a binding left behind would only be a line
        // the next boot replays for a conversation that is not there.
        this.overseerSessions.delete(ev.key)
        this.pendingOverseerSessions.delete(ev.key)
        this.overseerNotes.delete(ev.key)
        this.pendingTurns.delete(ev.key)
        this.droppedTurns.delete(ev.key)
        break
      }
      // ---- the turn a restart can kill (#388, ADR-0015) --------------------
      //
      // The pending map holds ONE turn per conversation, which is the rule the
      // client already enforces: one turn at a time per conversation. Whatever
      // is still in this map when a process boots was killed by the restart
      // that ended the last one, because a turn survives no restart.
      case 'overseer_turn_started': {
        this.pendingTurns.set(ev.key, {
          key: ev.key,
          turn: ev.turn ?? null,
          prompt: ev.prompt ?? '',
          thread_id: ev.thread_id ?? null,
          replay: ev.replay ?? false,
          at: ev.ts ?? null,
          crossings: 0,
          commands: [],
        })
        // A new turn answers whatever the last drop left on the surfaces.
        this.droppedTurns.delete(ev.key)
        // When this conversation last SPOKE, which the boot reads to tell a
        // message the operator has already sent again by hand from one that
        // still waits for its replay.
        if (ev.ts) this.turnStarts.set(ev.key, ev.ts)
        break
      }
      case 'overseer_turn_ended':
      case 'overseer_turn_dropped': {
        this.pendingTurns.delete(ev.key)
        break
      }
      // ---- the login a restart can kill (#671) -----------------------------
      //
      // `ReauthFlow.flow` is process state, and the module keeps no file on
      // purpose. So the one fact a restart cannot re-derive lives here, the way
      // the killed overseer turn above does: one event when the login starts,
      // one when it ends, and the boot reads what is left between them.
      //
      // WHAT IS KEPT IS THE CLOCK, and only the clock. The session name is the
      // provider's own, the pane still holds the link and the code, and the
      // credential is wherever the login left it — so `startedAt` is the only
      // thing the dead process was holding that nothing else can restate.
      //
      // A LINE CURIA CANNOT CLOCK IS NOT AN OPEN LOGIN. Every event is stamped
      // by `_append`, so an unreadable `ts` means a record nothing can put a
      // deadline on, and inventing one would either kill a live login early or
      // hand it a second window. It is stepped over instead.
      case 'reauth_started': {
        const startedAt = Date.parse(ev.ts ?? '')
        if (!ev.provider || !Number.isFinite(startedAt)) break
        this.openLogins.set(ev.provider, { provider: ev.provider, session: ev.session ?? null, startedAt })
        break
      }
      case 'reauth_completed':
      case 'reauth_timed_out':
      // A code that ran out is an ending like any other here (#721). What it is
      // NOT is an abandonment, and the two events are separate so the journal
      // can say which one happened months later.
      case 'reauth_code_expired':
      case 'reauth_abandoned':
      case 'reauth_failed': {
        this.openLogins.delete(ev.provider)
        break
      }
    }

    // The seam crossings of the pending turn, counted off the COMMAND event the
    // seam already writes (#388). One voice per fact, ADR-0013: a second event
    // saying "the overseer crossed" would state what this one states. The
    // in-memory `turn.crossings` dies with the process, and this is what the
    // boot reads in its place.
    if (ev.type === 'command' && ev.overseer_key) {
      const pending = this.pendingTurns.get(ev.overseer_key)
      if (pending) {
        pending.crossings += 1
        pending.commands.push(ev.canonical)
      }
    }

    // What the surfaces say about a turn a restart killed, until that
    // conversation takes its next one. The Chat picker draws it for a browser
    // conversation, which has no thread to put the line in.
    if (ev.type === 'overseer_turn_dropped') {
      this.droppedTurns.set(ev.key, {
        key: ev.key,
        crossings: ev.crossings ?? 0,
        commands: ev.commands ?? [],
        replayed: ev.replayed ?? false,
        why: ev.why ?? null,
        at: ev.ts ?? null,
      })
    }
  }

  static payloadHash({ kind, prompt, options, preview_url }) {
    return crypto.createHash('sha256')
      .update(JSON.stringify([kind, prompt, options ?? null, preview_url ?? null]))
      .digest('hex').slice(0, 16)
  }

  // Open a new escalation. If the same agent already has an OPEN escalation of
  // this kind, that record is a corpse from an aborted tool call (#29):
  // supersede it and chain answers forward.
  //
  // The key is the agent and the KIND, not the wording (#336). It was the
  // payload hash until a live re-send got past it: the standing orders tell an
  // agent whose call failed to make the same call once more, the agent added
  // "(Re-sent: the last call timed out with an error…)" to explain itself, and
  // that note changed the hash. Two live cards for one question, and the
  // original never closed. A re-send is the same call again, so the words are
  // the one thing about it that can differ — and the promise the standing
  // orders make, that curia routes the human to whichever call is live, is a
  // promise about the call rather than about its wording.
  //
  // The kind stays in the key because one agent CAN hold two calls at once and
  // mean both: a harness that backgrounds a pending `ask_human` leaves the
  // question open while `request_review` opens the gate. Those are two
  // questions to a human, and an approval routed into a free-text call would
  // be read as an answer to it.
  //
  // A confirm (#94) supersedes on a different key: any open confirm sharing a
  // target INSTANCE — a newer confirm on the same agent replaces the older one
  // whatever its wording, so at most one set of live buttons ever points at a
  // given agent. The two keys never cross: a confirm is an operator's record
  // and belongs to no agent's call.
  open({ agent, ticket, kind, prompt, options, preview_url, recommended, action, origin_thread_id, diff, diff_error, payload, lint_flags, awaited = null }) {
    const payload_hash = Reduction.payloadHash({ kind, prompt, options, preview_url })
    const id = `esc-${++this.seq}`
    const sharesInstance = (r) => (r.action?.targets ?? [])
      .some((t) => (action?.targets ?? []).some((u) => u.instance === t.instance))
    // Oldest first, and ALL of them: one agent should never hold two open
    // records of one kind, but a journal written before this rule can carry
    // several, and a corpse this call walks past stays on the Needs-You list
    // forever.
    const superseded_all = [...this.escalations.values()].filter((r) => {
      if (r.status !== 'open') return false
      return kind === CONFIRM_KIND
        ? r.kind === CONFIRM_KIND && sharesInstance(r)
        : r.kind === kind && r.agent === agent
    })
    // The hash keyed supersession until #336 took the question out of the key.
    // It stays on the line as EVIDENCE: it is what tells a later reader whether
    // a superseded record held the same question its successor asks. Nothing
    // decides on it, so a round re-asked with `recommended` flipped (#285)
    // supersedes its own record either way.
    // The hash still reads the composed `prompt`, not the payload, and that is
    // deliberate. The composer is deterministic, so one typed payload makes one
    // prompt — and an untyped call and a typed one that say the same words hash
    // the same, which is the right answer for the #369 replay.
    this._append({ type: 'esc_open', id, agent, ticket, kind, prompt, options, preview_url, recommended, payload, lint_flags, payload_hash, action, origin_thread_id, diff, diff_error, awaited })
    for (const r of superseded_all) this._append({ type: 'esc_supersede', id: r.id, successor: id })
    return { record: this.escalations.get(id), superseded: superseded_all[0] ?? null, superseded_all }
  }

  attachRender(id, discord) {
    this._append({ type: 'esc_render', id, ...discord })
  }

  // ---- the lint gate's ledger (#418) -----------------------------------------

  lintRejections(agent, kind) {
    return this.lintRejects.get(`${agent}|${kind}`)?.count ?? 0
  }

  journalLintRejection({ agent, kind, faults, schema, prompt, payload }) {
    return this._append({ type: 'lint_rejected', agent, kind, faults, schema, prompt, payload })
  }

  clearLintRejections(agent, kind) {
    if (!this.lintRejects.has(`${agent}|${kind}`)) return null
    return this._append({ type: 'lint_cleared', agent, kind })
  }

  // The newest rejection this agent has not answered for, across every kind.
  // The Stop hook reads it: an agent that lost its rejection believes the
  // question went out, and this is what tells the hook otherwise.
  pendingLintRejection(agent) {
    const held = [...this.lintRejects.values()].filter((r) => r.agent === agent)
    return held.sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1) ?? null
  }

  journalLintStopBlock(agent, kind) {
    return this._append({ type: 'lint_stop_blocked', agent, kind })
  }

  // Follow the successor chain from a possibly-dead id to the live record.
  resolveLive(id) {
    let r = this.escalations.get(id)
    const hops = []
    while (r && r.status === 'superseded' && r.successor) {
      hops.push(r.id)
      r = this.escalations.get(r.successor)
    }
    return { record: r ?? null, routed_from: hops }
  }

  // First valid answer wins, closes atomically. Answers to superseded ids route
  // to the live successor; answers to closed records are rejected.
  // Inbound attachment paths are part of the durable record (#34): the answer a
  // restarted daemon replays must still carry its images.
  answer(id, { answer, attachments = [], by, via }) {
    const { record, routed_from } = this.resolveLive(id)
    if (!record) return { ok: false, reason: 'unknown' }
    if (record.status !== 'open') return { ok: false, reason: record.status, record }
    this._append({ type: 'esc_answer', id: record.id, answer, attachments, by, via, routed_from })
    return { ok: true, record, routed_from }
  }

  cancel(id, { by }) {
    const { record } = this.resolveLive(id)
    if (!record) return { ok: false, reason: 'unknown' }
    if (record.status !== 'open') return { ok: false, reason: record.status, record }
    this._append({ type: 'esc_cancel', id: record.id, by })
    return { ok: true, record }
  }

  // A confirm whose agent exited closes by LAPSING (#94) — distinct from
  // cancelled, because nobody chose it and the rendered message says so.
  lapse(id, reason) {
    const r = this.escalations.get(id)
    if (!r) return { ok: false, reason: 'unknown' }
    if (r.status !== 'open') return { ok: false, reason: r.status, record: r }
    this._append({ type: 'esc_lapse', id, reason })
    return { ok: true, record: r }
  }

  openEscalations() {
    return [...this.escalations.values()].filter((r) => r.status === 'open')
  }

  // Every record for one agent, oldest first — the timeline's full-fidelity
  // feed (#108 item 1). The transcript clips what this record holds whole:
  // question, kind, options, answer, who answered.
  escalationsForAgent(agent) {
    return [...this.escalations.values()]
      .filter((r) => r.agent === agent)
      .sort((a, b) => String(a.opened_at).localeCompare(String(b.opened_at)))
  }

  // The inherited exchange (#374): every question a human has ANSWERED on this
  // session, oldest first, shaped for the spawn prompt.
  //
  // A builder session is `curia-<n>` for every dispatch on that ticket, so this
  // one key already spans the whole history — the dead agent, the one before it,
  // and the resumed one about to read them. That is why the push needs no new
  // event and no epoch boundary: the reduction holds the answers already, and
  // `resume` was simply never asking.
  //
  // ANSWERED only. A cancelled, lapsed or superseded record holds no answer, so
  // it is not a parameter of anything — the fresh agent should ask that question
  // again, and it will.
  //
  // Every kind rides along, the review gate included. A gate rejection is the
  // operator's own instruction, and today it dies with the agent that read it.
  // The size bound in `writePrompt` is what keeps a long history readable.
  //
  // The shape is deliberately not the record: the prompt has no business with
  // `payload_hash` or `discord`, and attachments travel as a COUNT because the
  // images themselves reach an agent as tool-result content (#34), never as
  // paths in a file.
  answeredExchangeFor(agent) {
    return this.escalationsForAgent(agent)
      .filter((r) => r.status === 'answered')
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        prompt: r.prompt ?? '',
        answer: r.answer ?? '',
        attachments: (r.attachments ?? []).length,
      }))
  }

  get(id) {
    return this.escalations.get(id)
  }

  // Thread → SDK-session map for the overseer host (#92). Journalled so a
  // daemon restart replays every conversation's resume handle.
  bindOverseerSession(threadId, sessionId) {
    this._append({ type: 'overseer_session', thread_id: threadId, session_id: sessionId })
  }

  reserveOverseerSession(threadId, sessionId) {
    this._append({ type: 'overseer_session_reserved', thread_id: threadId, session_id: sessionId })
  }

  pendingOverseerSession(threadId) {
    return this.pendingOverseerSessions.get(threadId)
  }

  overseerSession(threadId) {
    return this.overseerSessions.get(threadId)
  }

  // The active parent while a rewind has no transcript line of its own.
  // The rewind flow journals the first event and clears it after the next
  // transcript message starts the new branch.
  transcriptLanding(agent) {
    return this.transcriptLandings.get(agent) ?? null
  }

  // ---- the turn a restart can kill (#388, ADR-0015) -------------------------
  //
  // ADR-0015 promises that a turn a restart kills is replayed, never retyped.
  // The message therefore cannot live in this process: the routine deploy
  // recreates the daemon and the overseer together, so both halves die at once.
  // It lives here, as one event when a turn starts and one when it ends, and
  // the boot reads whatever is left between them.
  //
  // The prompt is journalled whole, because the message IS the thing to send
  // again. The journal already holds the operator's words: every canonical
  // command line, every escalation prompt, every answer.

  beginOverseerTurn({ key, turn, prompt, threadId = null, replay = false }) {
    this._append({ type: 'overseer_turn_started', key, turn, prompt, thread_id: threadId, replay })
  }

  endOverseerTurn({ key, turn, ok, crossings = 0, why = null }) {
    this._append({ type: 'overseer_turn_ended', key, turn, ok, crossings, why })
  }

  // The boot's verdict on one killed turn: replayed, or named and left. It ENDS
  // the turn as well as reporting it, so a second boot never reads the same
  // corpse twice.
  dropOverseerTurn({ key, turn = null, crossings = 0, commands = [], replayed = false, why = null }) {
    this._append({ type: 'overseer_turn_dropped', key, turn, crossings, commands, replayed, why })
  }

  // Every turn the journal has started and not ended. Read ONCE, at boot,
  // before this process can start a turn of its own — after that the answer
  // includes turns that are merely running.
  pendingOverseerTurns() {
    return [...this.pendingTurns.values()].map((t) => ({ ...t, commands: [...t.commands] }))
  }

  // The re-authentication the journal has started and not ended, or null (#671).
  //
  // The OLDEST one, because it is the one nearest its deadline, and because the
  // flow carries one login at a time. A second provider's login is not lost: it
  // is still open here, and it resumes on the tick after the first one ends.
  //
  // Sorted rather than taken in insertion order. `Map.set` on a key that is
  // already there keeps its original position, so a provider signing in for the
  // second time would otherwise read as the older of the two.
  openLogin() {
    const open = [...this.openLogins.values()].sort((a, b) => a.startedAt - b.startedAt)
    return open.length ? { ...open[0] } : null
  }

  // What a surface says about the last turn a restart killed on one
  // conversation. Null once that conversation takes its next turn.
  droppedOverseerTurn(key) {
    return this.droppedTurns.get(key) ?? null
  }

  // When one conversation last started a turn, as an ISO string. Null for a
  // conversation that has never spoken.
  lastOverseerTurnAt(key) {
    return this.turnStarts.get(key) ?? null
  }

  // ---- the browser conversations (#333, ADR-0016) ---------------------------
  //
  // The daemon owns the key, so the daemon owns this list. It is journalled for
  // the reason the resume handle is: a restart must not forget which
  // conversations the operator has, and it must not hand a new one a number an
  // old one spent.

  // Mint one. The number is one higher than the highest ever minted, never the
  // lowest free — see attach.nextConsoleKey for why a conversation differs from
  // a chat handle here.
  openConsoleConversation() {
    const key = nextConsoleKey([...this.consoleSpent])
    this._append({ type: 'console_conversation_opened', key })
    return key
  }

  // Forget one. The transcript file is NOT touched: the number is spent, so
  // nothing can ever read that file as this conversation again, and a delete
  // the operator cannot undo is the wrong default for their own words.
  // Answers false for a key that is not a live conversation, so the caller can
  // refuse rather than journal a delete of nothing.
  deleteConsoleConversation(key) {
    if (!this.consoleConversations.has(key)) return false
    this._append({ type: 'console_conversation_deleted', key })
    return true
  }

  // The live ones, newest first — the order the picker draws. Sorted on the
  // NUMBER rather than the timestamp: numbers only go up, so the number is the
  // order, and two conversations opened in the same millisecond still come back
  // in the order they were minted.
  consoleConversationList() {
    const n = (c) => Number(String(c.key).slice('console-'.length))
    return [...this.consoleConversations.values()].sort((a, b) => n(b) - n(a))
  }

  hasConsoleConversation(key) {
    return this.consoleConversations.has(key)
  }

  // Synthetic lines for a thread's overseer session (#94): a confirm resolves
  // between turns — button → daemon, no model in the loop — so the outcome is
  // journalled here and the host prefixes it to the thread's next prompt.
  // Revival memory stays honest across a daemon restart because both the note
  // and its drain are journal events.
  addOverseerNote(threadId, text) {
    this._append({ type: 'overseer_note', thread_id: threadId, text })
  }

  takeOverseerNotes(threadId) {
    const notes = [...(this.overseerNotes.get(threadId) ?? [])]
    if (notes.length) this._append({ type: 'overseer_notes_drained', thread_id: threadId, count: notes.length })
    return notes
  }

  // Late thread text bound for an agent (#108 item 14, positive half): while
  // an agent owns a thread and no escalation is open, operator text queues
  // here and the daemon piggybacks it on the agent's next tool result. A
  // note that lands inside the grace window after an escalation closed is
  // tagged with that escalation's id — "operator added, after esc-13" — the
  // follow-up-to-a-button case the finding measured. Journalled, so a daemon
  // restart keeps every undelivered note.
  //
  // `instance` is the #208 ruling: words typed at an agent die with THAT
  // agent. The caller is what marks the two kinds apart, because the caller
  // is the only one who knows who the words were for. Thread text names the
  // instance that owned the thread; the #139 hand-off names none, because
  // reaching the successor is its whole point.
  // `label` names the SENDER on the agent's tool result (#165). It defaults to
  // the operator, because for every caller but the cross-check return path the
  // words are a human's. The cross-check verdict rides this same queue and must
  // not read as something the operator typed: it is a second model's reading,
  // and the builder judges it rather than obeying it.
  // `handoffFor` is the #139 hand-off's own mark (#369): the escalation whose
  // recorded answer these words carry. Every other caller leaves it null,
  // because only a recorded answer can be handed back to the call that re-asks
  // for it.
  queueAgentNote(agent, text, { by = null, instance = null, label = null, handoffFor = null, graceMs = 120_000, now = Date.now() } = {}) {
    const recent = [...this.escalations.values()]
      .filter((r) => r.agent === agent && r.status !== 'open' && r.closed_at)
      .sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)))
      .at(-1)
    const closedMs = recent ? now - Date.parse(recent.closed_at) : Infinity
    const after = Number.isFinite(closedMs) && closedMs <= graceMs ? recent.id : null
    const id = `note-${++this.noteSeq}`
    this._append({ type: 'agent_note', id, agent, text, after, by, instance, label, handoff_for: handoffFor })
    return { id, after }
  }

  // One note by its id, pending or not (#252). The interrupt button reads this:
  // the words it names may still be queued, or the agent may have read them
  // already and said nothing back, and the operator presses the same button in
  // both cases.
  noteById(id) {
    return this.notes.get(id) ?? null
  }

  // The interrupt's half of the queue (#252, ADR-0013). The words leave the
  // queue here and go into the pane as a user turn, so a note is delivered once
  // whichever mode carries it. A note the agent has ALREADY read leaves nothing
  // to take out, and it journals nothing: the operator presses this button
  // precisely because no reply came, and by then the drain has usually run.
  // Returns the note, or null when the id names none.
  interruptAgentNote(id, { by = null } = {}) {
    const note = this.notes.get(id)
    if (!note) return null
    if (note.pending) this._append({ type: 'agent_note_interrupted', id, agent: note.agent, by })
    return note
  }

  // The hand-off half of #139: an answer that settled an escalation nothing
  // was waiting on (the resolver died with a previous daemon process, or the
  // agent itself is gone) re-queues as an agent note, so the next agent on
  // the session — resumed or surviving — gets question and answer on its
  // first tool result. The guarantee is this journal, not the model's memory
  // of a thread it cannot read.
  queueRecordedAnswer(record) {
    const att = (record.attachments ?? []).length
      ? `\nattachments on disk, read them if you need them: ${record.attachments.join(', ')}`
      : ''
    const text = `a human answered ${record.id}, a question asked on this ticket that no live agent could receive.`
      + `\nquestion: ${record.prompt}\nanswer: ${record.answer}${att}`
    return this.queueAgentNote(record.agent, text, { by: record.answered_by ?? null, handoffFor: record.id })
  }

  // #369: the recorded answer a re-asked question may take back at once.
  //
  // The daemon restarts, the blocked call dies, the operator answers the card
  // anyway, and #139 parks question and answer as a note. The agent then asks
  // the same thing again. Supersede cannot help, because it only closes OPEN
  // records and this one is answered — so a second card carried the same
  // question and the operator paid the wait twice.
  //
  // TWO conditions, and both are narrow on purpose.
  //
  // The payload hash is EXACT here, where supersede deliberately dropped it
  // (#336). Supersede asks "is this the same CALL", and a re-send may explain
  // itself in new words. This asks "is this the same QUESTION", and only the
  // question can decide that: an agent that asks something new of the same kind
  // must never be handed the old answer instead of a human.
  //
  // The pending note is the WINDOW. A delivered answer parks no note, so this
  // can only ever serve one nothing has read, and the moment the agent drains
  // that note the answer has arrived and a later re-ask is a real second
  // question. That needs no clock, and a clock would only guess at the same
  // fact the queue already states.
  //
  // Only an ANSWERED record replays. A cancelled or lapsed one holds no answer,
  // and a superseded one has a live successor to wait on.
  recordedAnswerFor({ agent, kind, prompt, options, preview_url }) {
    const payload_hash = Reduction.payloadHash({ kind, prompt, options, preview_url })
    const matches = [...this.escalations.values()]
      .filter((r) => r.agent === agent && r.kind === kind && r.status === 'answered' && r.payload_hash === payload_hash)
      .sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)))
    // Newest first: if one question was somehow answered twice, the last answer
    // is the operator's current mind.
    for (const record of matches.reverse()) {
      const note = this.notes.get(this.handoffNotes.get(record.id))
      if (note?.pending) return { record, note }
    }
    return null
  }

  // The take, journalled as one act. The caller has already decided the record
  // answers its question — this is where the answer stops being a queued note
  // and becomes the return value of the call that asked.
  takeRecordedAnswer(record, note) {
    this._append({ type: 'esc_replayed', id: record.id, agent: record.agent, ticket: record.ticket, note: note.id })
    return record
  }

  // The #208 rule, in one predicate: a note stamped with an instance belongs
  // to that instance and to nothing else. This drops every note naming an
  // instance OTHER than the one now live on the session. Pass null when
  // nothing is live, which is what every exit path does — then every stamped
  // note goes. An unstamped note is session-keyed and never expires here.
  //
  // Two callers, one rule. The exit paths call it so the operator is told at
  // the moment the words die. The drain calls it so a successor can never
  // read them even if some exit path was missed.
  //
  // #252 moves the ANNOUNCEMENT here, to the one place every expiry passes
  // through. Before it, the exit paths announced and the drain did not, so a
  // note that died on a path nobody had wired stayed silent — the #223 loss
  // class. `onNotesExpired` fires once per expiry with the notes themselves,
  // because a dead verdict is posted in full and a count cannot carry it.
  // Returns those notes: an empty array means nothing died.
  expireAgentNotes(agent, liveInstance = null, why = 'is gone') {
    const arr = this.agentNotes.get(agent) ?? []
    const stale = arr.filter((n) => n.instance && n.instance !== liveInstance)
    if (!stale.length) return []
    this._append({ type: 'agent_notes_expired', agent, live_instance: liveInstance, count: stale.length })
    // An observer failure never poisons the record, for the reason onEvent does
    // not: the journal write already happened and it is the truth.
    try { this.onNotesExpired?.({ agent, notes: stale, liveInstance, why }) } catch { /* announced or not, the note is gone */ }
    return stale
  }

  takeAgentNotes(agent, instance = null) {
    this.expireAgentNotes(agent, instance, 'is running as a fresh instance')
    const notes = [...(this.agentNotes.get(agent) ?? [])]
    if (notes.length) this._append({ type: 'agent_notes_drained', agent, count: notes.length })
    return notes
  }

  // Ticket-label bindings (#93, per the #89 discipline): a thread carries at
  // most one ticket, a ticket lives on at most one thread. The journal is the
  // truth — the thread rename is display only — so a daemon restart replays
  // every live binding. Both refusal shapes name the holder, because the
  // discipline's answer to a double-bind is "refuse and link the holding
  // thread". Binding the same pair again is a no-op, not an event.
  bindTicketThread(ticket, threadId) {
    const t = String(ticket)
    const current = this.ticketThreads.get(t)
    if (current === threadId) return { ok: true, threadId }
    if (current) return { ok: false, reason: 'ticket-bound', threadId: current }
    const holding = this.threadTickets.get(threadId)
    if (holding) return { ok: false, reason: 'thread-bound', ticket: holding }
    this._append({ type: 'thread_bound', ticket: t, thread_id: threadId })
    return { ok: true, threadId }
  }

  // Move a live binding to another thread (#197).
  //
  // #140 keeps a binding through cancel and agent death on purpose, so a
  // `resume` lands back where the ticket's history and recorded answers are.
  // What it did not consider is a fresh dispatch typed in a DIFFERENT thread:
  // that is not a resume, it is the operator standing somewhere new and saying
  // "do this here", and `bindTicketThread` refused it as `ticket-bound` — so
  // every status line, notify and question went on going to a thread nobody was
  // reading. Silent, and indistinguishable from an agent that never started.
  //
  // Returns the released thread so the caller can say where the ticket went.
  // Refuses when the target already holds another ticket, because one thread
  // carries at most one ticket (#93) and that rule is not this one's to break.
  rebindTicketThread(ticket, threadId, reason = 'rebound') {
    const t = String(ticket)
    const current = this.ticketThreads.get(t)
    if (current === threadId) return { ok: true, threadId, moved: false }
    const holding = this.threadTickets.get(threadId)
    if (holding && holding !== t) return { ok: false, reason: 'thread-bound', ticket: holding }
    if (current) this._append({ type: 'thread_released', ticket: t, thread_id: current, reason })
    this._append({ type: 'thread_bound', ticket: t, thread_id: threadId })
    return { ok: true, threadId, moved: true, from: current ?? null }
  }

  // Returns the released thread id, or null when nothing was bound (then no
  // event is written — release is idempotent).
  releaseTicketThread(ticket, reason) {
    const t = String(ticket)
    const threadId = this.ticketThreads.get(t)
    if (!threadId) return null
    this._append({ type: 'thread_released', ticket: t, thread_id: threadId, reason })
    return threadId
  }

  threadForTicket(ticket) {
    return this.ticketThreads.get(String(ticket))
  }

  ticketForThread(threadId) {
    return this.threadTickets.get(threadId)
  }

  // The journal's last binding for a ticket, released or not (#140). The
  // dispatch backstop reads it so a resumed agent lands back in the thread
  // its predecessor's history, breadcrumbs and recorded answers live in.
  //
  // A map with no binding of its own falls back to the chat handle that
  // charted it (#326): the thread that session ran in IS the map's thread, and
  // the conversation that settled the destination is where `map <n>` belongs.
  // A map dispatched on its own number later has a record here, and that one
  // wins — the fallback answers only for a map nothing has bound yet.
  lastThreadForTicket(ticket) {
    const t = String(ticket)
    const own = this.lastTicketThreads.get(t)
    if (own) return own
    const charter = this.mapCharters.get(t)
    return charter ? this.lastTicketThreads.get(charter) : undefined
  }

  // The same pointer the other way round (#257): the last ticket this thread
  // ever carried, released or not. `ticketForThread` answers only for a LIVE
  // binding, and the boot pass that settles a thread name left mid-rename asks
  // about threads whose binding is exactly what is gone. It is also the guard
  // that keeps that pass off a thread curia never labeled.
  lastTicketForThread(threadId) {
    return this.lastThreadTickets.get(threadId)
  }

  // The repo of a ticket's last dispatch (#235), off the journal's
  // `dispatch_claimed`/`agent_spawned` lines. Undefined for a ticket the
  // daemon never dispatched — the label then keeps its two-field form.
  repoForTicket(ticket) {
    return this.ticketRepos.get(String(ticket))
  }

  boundTickets() {
    return [...this.ticketThreads.keys()]
  }

  // Generic operational events (notify, result, agent_done…) share the journal.
  journal(type, data) {
    return this._append({ type, ...data })
  }

  // The feed the dashboard draws (#262): the journal's last events, oldest
  // first. A copy, because the caller serializes it while the daemon keeps
  // appending.
  recentEvents(limit = RECENT_EVENTS) {
    return this.recent.slice(-limit)
  }

  // The journal's last word about an agent (#236): { type, ts } or null.
  // Replay fills it, so a restarted daemon still answers "what did it last do".
  lastAgentEvent(agent) {
    return this.lastAgentEvents.get(agent) ?? null
  }

  // The recent endings `/status` and the dashboard's fleet card carry (#81,
  // #289): the cancelled, then the finished, then the died, newest last and
  // capped per kind. A copy, for the reason `recentEvents` hands out one.
  recentOutcomes() {
    return [...this.outcomes.cancelled, ...this.outcomes.finished, ...this.outcomes.died]
  }

  // Every credential warning still standing, oldest first (#380). A copy, for
  // the reason `recentEvents` hands out one: the route serializes it while the
  // watch keeps appending.
  standingTokenWarnings() {
    return [...this.tokenWarnings.values()].map((w) => ({ ...w }))
  }

  // The last warning curia said about one credential key, or null. The ladder
  // reads this to decide whether a reading is news.
  tokenWarning(key) {
    const w = this.tokenWarnings.get(key)
    return w ? { ...w } : null
  }

  // The journal-backup failure that still stands, or null (#436). The backup
  // reads this to decide whether a failure is news, and a boot inherits it.
  standingBackupAlarm() {
    return this.backupAlarm ? { ...this.backupAlarm } : null
  }

  // Every stranded-map alarm that still stands (#485). The frontier read
  // clears the ones whose fact is gone, and a boot inherits the rest.
  standingStrandedMaps() {
    return [...this.mapAlarms.values()].map((a) => ({ ...a }))
  }

  // The stranded-map alarm standing for one map, or null (#485). The frontier
  // read consults this to decide whether a reading is news.
  strandedMap(repo, map) {
    const a = this.mapAlarms.get(`${repo}#${map}`)
    return a ? { ...a } : null
  }

  // The pull request an agent's CURRENT dispatch pushed, or null (#289). This
  // is the ONE link the agent's own report is allowed to unfurl (#253), and
  // the review gate card carries it too.
  pullRequestFor(agent) {
    return this.pullRequests.get(agent) ?? null
  }

  // Every limit resume curia still owes, as `{ ticket, repo, at }` (#346). The
  // dispatcher re-arms its own timers from this at boot. `at` is the ISO
  // instant the arm was written with, so a resume whose window rolled while the
  // daemon was down is due the moment this is read.
  armedLimitResumes() {
    return [...this.limitResumes.entries()].map(([ticket, v]) => ({ ticket, repo: v.repo, at: v.at }))
  }

  // How many times in a row a ticket died at the spawn (#444). The auto loop
  // reads this before every dispatch, and the dispatcher writes the count with
  // `dispatch_failed`. Zero for a ticket that never failed, and zero again the
  // moment an agent on it speaks.
  failedSpawns(ticket) {
    return this.spawnFailures.get(String(ticket))?.count ?? 0
  }

  // Every ticket that still carries failed spawns, as `{ ticket, repo, failures }`
  // (#444). The surfaces read this: `status` and the dashboard say which tickets
  // the auto loop steps over, and one operator press is what clears each.
  spawnFailureCounts() {
    return [...this.spawnFailures.entries()].map(([ticket, v]) => ({ ticket, repo: v.repo, failures: v.count }))
  }

  // Whether this agent reached the tool channel in its current dispatch.
  agentSpoke(agent) {
    return this.speakingAgents.has(agent)
  }

  // Released deaths after tool traffic, since the last typed dispatch (#578).
  releasedDeaths(ticket) {
    return this.releasedDeathCountsByTicket.get(String(ticket))?.count ?? 0
  }

  releasedDeathCounts() {
    return [...this.releasedDeathCountsByTicket.entries()]
      .map(([ticket, v]) => ({ ticket, repo: v.repo, deaths: v.count }))
  }

  stallRecovery(ticket) {
    const found = this.stallRecoveries.get(String(ticket))
    return found ? { ...found } : {
      repo: null, nudged: false, nudgeAttempts: 0,
      respawnStarted: false, respawned: false, respawnLaunching: false, escalated: false,
    }
  }

  operatorStallLaunch(ticket) {
    const found = this.operatorStallLaunches.get(String(ticket))
    return found ? { ...found } : null
  }

  stalledTickets() {
    return [...this.stallRecoveries.entries()]
      .filter(([, value]) => value.escalated)
      .map(([ticket, value]) => ({ ticket, repo: value.repo }))
  }

  pendingStallRespawns() {
    return [...this.stallRecoveries.entries()]
      .filter(([, value]) => value.respawnStarted && !value.respawned && !value.escalated)
      .map(([ticket, value]) => ({ ticket, repo: value.repo }))
  }

  // Every landed cap the journal states, as `{ models, providers }` of
  // `{ key, at }` (#377). The dispatcher seeds its own `Cooling` from this at
  // construction. `at` is the reset instant the cap was journalled with, so an
  // entry whose window rolled while the daemon was down carries a past instant
  // and cools nothing — `Cooling` expires it on the first read.
  armedCoolings() {
    const rows = (map, key) => [...map.entries()].map(([k, at]) => ({ [key]: k, at }))
    return { models: rows(this.coolings.models, 'model'), providers: rows(this.coolings.providers, 'provider') }
  }
}

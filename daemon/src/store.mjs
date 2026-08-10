// Durable escalation record (#31).
//
// Append-only events.jsonl is the source of truth; in-memory state is a pure
// reduction over it, rebuilt on every boot — so the record survives daemon
// restarts and bridge post-failures (#22/#28). Discord message ids are part of
// the record so a rebooted daemon can still edit/close the rendered UI.
//
// Semantics owned here:
//   - first-valid-wins: answer/cancel close atomically; later attempts are rejected
//   - supersede (#29): a re-issued ask_human (same agent + same payload while an
//     older escalation is open) marks the old record superseded; answers posted
//     to a dead id are routed along the successor chain to the live call

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// The button-confirm kind (#94, per #89's messaging discipline). Its own kind
// because a confirm behaves unlike every other escalation: no reminder, no
// pending resolver — the executing path is button → daemon — and it closes by
// LAPSING when the agent instance it is bound to exits.
export const CONFIRM_KIND = 'confirm'

// How much of the journal the feed keeps in memory (#262). The dashboard reads
// the daemon's last events over `GET /overview`, and the journal FILE stays
// daemon-private — so the tail is held here, filled by replay at boot and by
// every append after it. A ring rather than a re-read: the file grows without
// bound and the dashboard polls, so parsing it once per poll would make the
// cost of watching curia rise with its history.
export const RECENT_EVENTS = 100

// The journal in the old spelling (#184).
//
// Until #184 the process curia spawns was a "worker" and the program it ran
// under was its "backend", so every line written before the rename says
// `worker_spawned`, `"worker": "curia-170"`, `"backend": "claude"`. The journal
// is APPEND-ONLY and it is the daemon's only durable artifact — a record you
// rewrite to match today's vocabulary is no longer a record. So the file is
// never touched, and the old spellings are translated HERE instead.
//
// One edge, crossed by both readers: `EscalationStore._replay` and the
// dispatcher's `#readJournal`. Everything downstream of them — the reducer,
// reconcile's epoch scan, the harness a re-adopted agent gets back — sees one
// name for one thing, which is the whole point of the rename.
//
// A new-spelling key always wins over a legacy one, so a line carrying both
// (which nothing writes) can never resurrect the old value.
const LEGACY_FIELDS = { worker: 'agent', backend: 'harness' }

export function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev
  let out = ev
  // Covers every legacy type in one rule, `escalation_worker_died` included:
  // there is no event whose name says "worker" and means something else.
  if (typeof ev.type === 'string' && ev.type.includes('worker')) {
    out = { ...out, type: ev.type.replaceAll('worker', 'agent') }
  }
  for (const [legacy, current] of Object.entries(LEGACY_FIELDS)) {
    if (!(legacy in out) || current in out) continue
    out = { ...out, [current]: out[legacy] }
    delete out[legacy]
  }
  return out
}

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
export function noteDisposition(agent) {
  const reads = agent?.state !== 'failed'
  return { reads, instance: reads ? agent?.instance ?? null : null }
}

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

export class EscalationStore {
  constructor(dataDir) {
    this.dir = dataDir
    this.log = path.join(dataDir, 'events.jsonl')
    fs.mkdirSync(dataDir, { recursive: true })
    this.escalations = new Map() // id -> record
    this.overseerNotes = new Map() // thread id -> pending synthetic lines (#94)
    this.agentNotes = new Map() // agent session -> pending operator notes (#108 item 14)
    this.overseerSessions = new Map() // thread id -> SDK session id (#92)
    this.ticketThreads = new Map() // ticket -> Discord thread id (#93)
    this.threadTickets = new Map() // Discord thread id -> ticket (#93)
    this.lastTicketThreads = new Map() // ticket -> last thread ever bound, releases notwithstanding (#140)
    this.lastThreadTickets = new Map() // thread id -> last ticket ever bound to it, the same way round (#257)
    this.ticketRepos = new Map() // ticket -> repo of its last dispatch (#235)
    this.lastAgentEvents = new Map() // agent session -> last journal event about it (#236)
    this.notes = new Map() // note id -> every note ever queued, pending or not (#252)
    this.recent = [] // the last RECENT_EVENTS journal lines, oldest first (#262)
    this.seq = 0
    this.noteSeq = 0
    this._replay()
  }

  _replay() {
    if (!fs.existsSync(this.log)) return
    for (const line of fs.readFileSync(this.log, 'utf8').split('\n')) {
      if (!line.trim()) continue
      this._apply(normalizeEvent(JSON.parse(line)), { replay: true })
    }
  }

  _append(event) {
    const rec = { ts: new Date().toISOString(), ...event }
    fs.appendFileSync(this.log, JSON.stringify(rec) + '\n')
    this._apply(rec, { replay: false })
    // Live-event tap (#108 item 8): the status line watches the journal
    // instead of threading callbacks through the dispatcher. Never on replay —
    // a rebooted daemon must not re-announce history. An observer failure must
    // not fail the append: the journal write already happened and is the truth.
    try { this.onEvent?.(rec) } catch { /* observer errors never poison the record */ }
    return rec
  }

  _apply(ev, { replay }) {
    // The feed's tail (#262). Every event passes here exactly once, on replay
    // and on append alike, so the ring is right the instant the boot replay
    // ends and stays right for the rest of the run.
    this.recent.push(ev)
    if (this.recent.length > RECENT_EVENTS) this.recent.shift()

    // The last thing the journal says about an agent (#236): the direct answer
    // under a question in its thread reads it as progress evidence. The
    // note-queue family is excluded, because the question itself queues a note
    // one line above this read — an answer that reported the question as the
    // agent's last act would always be about itself.
    if (ev.agent && ev.ts && !NOTE_EVENTS.has(ev.type)) {
      this.lastAgentEvents.set(ev.agent, { type: ev.type, ts: ev.ts })
    }
    switch (ev.type) {
      case 'esc_open': {
        const n = Number(ev.id.split('-')[1])
        if (n >= this.seq) this.seq = n
        this.escalations.set(ev.id, {
          id: ev.id, agent: ev.agent, ticket: ev.ticket, kind: ev.kind,
          prompt: ev.prompt, options: ev.options, preview_url: ev.preview_url,
          payload_hash: ev.payload_hash, status: 'open', opened_at: ev.ts,
          action: ev.action ?? null, origin_thread_id: ev.origin_thread_id ?? null,
          discord: null, successor: null, agent_died: false,
        })
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
        const note = {
          id: ev.id ?? null, agent: ev.agent, text: ev.text, after: ev.after ?? null,
          instance: ev.instance ?? null, label: ev.label ?? null, pending: true, at: ev.ts ?? null,
        }
        if (note.id) {
          const n = Number(String(note.id).split('-')[1])
          if (Number.isFinite(n) && n >= this.noteSeq) this.noteSeq = n
          this.notes.set(note.id, note)
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
        break
      }
    }
  }

  static payloadHash({ kind, prompt, options, preview_url }) {
    return crypto.createHash('sha256')
      .update(JSON.stringify([kind, prompt, options ?? null, preview_url ?? null]))
      .digest('hex').slice(0, 16)
  }

  // Open a new escalation. If the same agent already has an OPEN escalation with
  // the same payload, that record is a corpse from an aborted tool call (#29):
  // supersede it and chain answers forward.
  //
  // A confirm (#94) supersedes on a different key: any open confirm sharing a
  // target INSTANCE — a newer confirm on the same agent replaces the older one
  // whatever its wording, so at most one set of live buttons ever points at a
  // given agent.
  open({ agent, ticket, kind, prompt, options, preview_url, action, origin_thread_id }) {
    const payload_hash = EscalationStore.payloadHash({ kind, prompt, options, preview_url })
    const id = `esc-${++this.seq}`
    const sharesInstance = (r) => (r.action?.targets ?? [])
      .some((t) => (action?.targets ?? []).some((u) => u.instance === t.instance))
    let superseded = null
    for (const r of this.escalations.values()) {
      if (r.status !== 'open') continue
      const match = kind === CONFIRM_KIND
        ? r.kind === CONFIRM_KIND && sharesInstance(r)
        : r.agent === agent && r.payload_hash === payload_hash
      if (match) {
        superseded = r
        break
      }
    }
    this._append({ type: 'esc_open', id, agent, ticket, kind, prompt, options, preview_url, payload_hash, action, origin_thread_id })
    if (superseded) this._append({ type: 'esc_supersede', id: superseded.id, successor: id })
    return { record: this.escalations.get(id), superseded }
  }

  attachRender(id, discord) {
    this._append({ type: 'esc_render', id, ...discord })
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

  get(id) {
    return this.escalations.get(id)
  }

  // Thread → SDK-session map for the overseer host (#92). Journalled so a
  // daemon restart replays every conversation's resume handle.
  bindOverseerSession(threadId, sessionId) {
    this._append({ type: 'overseer_session', thread_id: threadId, session_id: sessionId })
  }

  overseerSession(threadId) {
    return this.overseerSessions.get(threadId)
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
  queueAgentNote(agent, text, { by = null, instance = null, label = null, graceMs = 120_000, now = Date.now() } = {}) {
    const recent = [...this.escalations.values()]
      .filter((r) => r.agent === agent && r.status !== 'open' && r.closed_at)
      .sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)))
      .at(-1)
    const closedMs = recent ? now - Date.parse(recent.closed_at) : Infinity
    const after = Number.isFinite(closedMs) && closedMs <= graceMs ? recent.id : null
    const id = `note-${++this.noteSeq}`
    this._append({ type: 'agent_note', id, agent, text, after, by, instance, label })
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
    return this.queueAgentNote(record.agent, text, { by: record.answered_by ?? null })
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
  lastThreadForTicket(ticket) {
    return this.lastTicketThreads.get(String(ticket))
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
  logEvent(type, data) {
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
}

// Durable escalation record (#31).
//
// Append-only events.jsonl is the source of truth; in-memory state is a pure
// reduction over it, rebuilt on every boot — so the record survives daemon
// restarts and bridge post-failures (#22/#28). Discord message ids are part of
// the record so a rebooted daemon can still edit/close the rendered UI.
//
// Semantics owned here:
//   - first-valid-wins: answer/cancel close atomically; later attempts are rejected
//   - supersede (#29): a re-issued ask_human (same worker + same payload while an
//     older escalation is open) marks the old record superseded; answers posted
//     to a dead id are routed along the successor chain to the live call
//   - nudge bookkeeping for the ~30-min re-nudge (#11)

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// The button-confirm kind (#94, per #89's messaging discipline). Its own kind
// because a confirm behaves unlike every other escalation: no nudge timer, no
// pending resolver — the executing path is button → daemon — and it closes by
// LAPSING when the worker instance it is bound to exits.
export const CONFIRM_KIND = 'confirm'

export class EscalationStore {
  constructor(dataDir) {
    this.dir = dataDir
    this.log = path.join(dataDir, 'events.jsonl')
    fs.mkdirSync(dataDir, { recursive: true })
    this.escalations = new Map() // id -> record
    this.overseerNotes = new Map() // thread id -> pending synthetic lines (#94)
    this.workerNotes = new Map() // worker session -> pending operator notes (#108 item 14)
    this.overseerSessions = new Map() // thread id -> SDK session id (#92)
    this.ticketThreads = new Map() // ticket -> Discord thread id (#93)
    this.threadTickets = new Map() // Discord thread id -> ticket (#93)
    this.lastTicketThreads = new Map() // ticket -> last thread ever bound, releases notwithstanding (#140)
    this.seq = 0
    this._replay()
  }

  _replay() {
    if (!fs.existsSync(this.log)) return
    for (const line of fs.readFileSync(this.log, 'utf8').split('\n')) {
      if (!line.trim()) continue
      this._apply(JSON.parse(line), { replay: true })
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
    switch (ev.type) {
      case 'esc_open': {
        const n = Number(ev.id.split('-')[1])
        if (n >= this.seq) this.seq = n
        this.escalations.set(ev.id, {
          id: ev.id, worker: ev.worker, ticket: ev.ticket, kind: ev.kind,
          prompt: ev.prompt, options: ev.options, preview_url: ev.preview_url,
          payload_hash: ev.payload_hash, status: 'open', opened_at: ev.ts,
          action: ev.action ?? null, origin_thread_id: ev.origin_thread_id ?? null,
          discord: null, successor: null, nudges: 0, worker_died: false,
        })
        break
      }
      case 'escalation_worker_died': {
        // The liveness sweep's mark (#138): the worker died but its question
        // stays open and answerable. Reduced onto the record so the answer
        // path (#139) can see, across restarts, that nothing live waits here.
        const r = this.escalations.get(ev.id)
        if (r) r.worker_died = true
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
      case 'esc_nudge': {
        const r = this.escalations.get(ev.id)
        if (r) r.nudges++
        break
      }
      case 'thread_bound': {
        this.ticketThreads.set(String(ev.ticket), ev.thread_id)
        this.threadTickets.set(ev.thread_id, String(ev.ticket))
        this.lastTicketThreads.set(String(ev.ticket), ev.thread_id)
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
      case 'worker_note': {
        const arr = this.workerNotes.get(ev.worker) ?? []
        arr.push({ text: ev.text, after: ev.after ?? null })
        this.workerNotes.set(ev.worker, arr)
        break
      }
      case 'worker_notes_drained': {
        const arr = this.workerNotes.get(ev.worker) ?? []
        arr.splice(0, ev.count)
        break
      }
      case 'overseer_notes_drained': {
        const arr = this.overseerNotes.get(ev.thread_id) ?? []
        arr.splice(0, ev.count)
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

  // Open a new escalation. If the same worker already has an OPEN escalation with
  // the same payload, that record is a corpse from an aborted tool call (#29):
  // supersede it and chain answers forward.
  //
  // A confirm (#94) supersedes on a different key: any open confirm sharing a
  // target INSTANCE — a newer confirm on the same worker replaces the older one
  // whatever its wording, so at most one set of live buttons ever points at a
  // given worker.
  open({ worker, ticket, kind, prompt, options, preview_url, action, origin_thread_id }) {
    const payload_hash = EscalationStore.payloadHash({ kind, prompt, options, preview_url })
    const id = `esc-${++this.seq}`
    const sharesInstance = (r) => (r.action?.targets ?? [])
      .some((t) => (action?.targets ?? []).some((u) => u.instance === t.instance))
    let superseded = null
    for (const r of this.escalations.values()) {
      if (r.status !== 'open') continue
      const match = kind === CONFIRM_KIND
        ? r.kind === CONFIRM_KIND && sharesInstance(r)
        : r.worker === worker && r.payload_hash === payload_hash
      if (match) {
        superseded = r
        break
      }
    }
    this._append({ type: 'esc_open', id, worker, ticket, kind, prompt, options, preview_url, payload_hash, action, origin_thread_id })
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

  // A confirm whose worker exited closes by LAPSING (#94) — distinct from
  // cancelled, because nobody chose it and the rendered message says so.
  lapse(id, reason) {
    const r = this.escalations.get(id)
    if (!r) return { ok: false, reason: 'unknown' }
    if (r.status !== 'open') return { ok: false, reason: r.status, record: r }
    this._append({ type: 'esc_lapse', id, reason })
    return { ok: true, record: r }
  }

  nudge(id) {
    this._append({ type: 'esc_nudge', id })
  }

  openEscalations() {
    return [...this.escalations.values()].filter((r) => r.status === 'open')
  }

  // Every record for one worker, oldest first — the timeline's full-fidelity
  // feed (#108 item 1). The transcript clips what this record holds whole:
  // question, kind, options, answer, who answered.
  escalationsForWorker(worker) {
    return [...this.escalations.values()]
      .filter((r) => r.worker === worker)
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

  // Late thread text bound for a worker (#108 item 14, positive half): while
  // a worker owns a thread and no escalation is open, operator text queues
  // here and the daemon piggybacks it on the worker's next tool result. A
  // note that lands inside the grace window after an escalation closed is
  // tagged with that escalation's id — "operator added, after esc-13" — the
  // follow-up-to-a-button case the finding measured. Journalled, so a daemon
  // restart keeps every undelivered note.
  queueWorkerNote(worker, text, { by = null, graceMs = 120_000, now = Date.now() } = {}) {
    const recent = [...this.escalations.values()]
      .filter((r) => r.worker === worker && r.status !== 'open' && r.closed_at)
      .sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)))
      .at(-1)
    const closedMs = recent ? now - Date.parse(recent.closed_at) : Infinity
    const after = Number.isFinite(closedMs) && closedMs <= graceMs ? recent.id : null
    this._append({ type: 'worker_note', worker, text, after, by })
    return { after }
  }

  // The hand-off half of #139: an answer that settled an escalation nothing
  // was waiting on (the resolver died with a previous daemon process, or the
  // worker itself is gone) re-queues as a worker note, so the next worker on
  // the session — resumed or surviving — gets question and answer on its
  // first tool result. The guarantee is this journal, not the model's memory
  // of a thread it cannot read.
  queueRecordedAnswer(record) {
    const att = (record.attachments ?? []).length
      ? `\nattachments on disk, read them if you need them: ${record.attachments.join(', ')}`
      : ''
    const text = `a human answered ${record.id}, a question asked on this ticket that no live worker could receive.`
      + `\nquestion: ${record.prompt}\nanswer: ${record.answer}${att}`
    return this.queueWorkerNote(record.worker, text, { by: record.answered_by ?? null })
  }

  takeWorkerNotes(worker) {
    const notes = [...(this.workerNotes.get(worker) ?? [])]
    if (notes.length) this._append({ type: 'worker_notes_drained', worker, count: notes.length })
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
  // dispatch backstop reads it so a resumed worker lands back in the thread
  // its predecessor's history, breadcrumbs and recorded answers live in.
  lastThreadForTicket(ticket) {
    return this.lastTicketThreads.get(String(ticket))
  }

  boundTickets() {
    return [...this.ticketThreads.keys()]
  }

  // Generic operational events (notify, result, worker_done…) share the journal.
  logEvent(type, data) {
    return this._append({ type, ...data })
  }
}

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

export class EscalationStore {
  constructor(dataDir) {
    this.dir = dataDir
    this.log = path.join(dataDir, 'events.jsonl')
    fs.mkdirSync(dataDir, { recursive: true })
    this.escalations = new Map() // id -> record
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
          discord: null, successor: null, nudges: 0,
        })
        break
      }
      case 'esc_render': {
        const r = this.escalations.get(ev.id)
        if (r) r.discord = { channelId: ev.channelId, threadId: ev.threadId, messageId: ev.messageId }
        break
      }
      case 'esc_answer': {
        const r = this.escalations.get(ev.id)
        if (r) { r.status = 'answered'; r.answer = ev.answer; r.answered_by = ev.by; r.answered_via = ev.via; r.closed_at = ev.ts }
        break
      }
      case 'esc_cancel': {
        const r = this.escalations.get(ev.id)
        if (r) { r.status = 'cancelled'; r.cancelled_by = ev.by; r.closed_at = ev.ts }
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
  open({ worker, ticket, kind, prompt, options, preview_url }) {
    const payload_hash = EscalationStore.payloadHash({ kind, prompt, options, preview_url })
    const id = `esc-${++this.seq}`
    let superseded = null
    for (const r of this.escalations.values()) {
      if (r.status === 'open' && r.worker === worker && r.payload_hash === payload_hash) {
        superseded = r
        break
      }
    }
    this._append({ type: 'esc_open', id, worker, ticket, kind, prompt, options, preview_url, payload_hash })
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
  answer(id, { answer, by, via }) {
    const { record, routed_from } = this.resolveLive(id)
    if (!record) return { ok: false, reason: 'unknown' }
    if (record.status !== 'open') return { ok: false, reason: record.status, record }
    this._append({ type: 'esc_answer', id: record.id, answer, by, via, routed_from })
    return { ok: true, record, routed_from }
  }

  cancel(id, { by }) {
    const { record } = this.resolveLive(id)
    if (!record) return { ok: false, reason: 'unknown' }
    if (record.status !== 'open') return { ok: false, reason: record.status, record }
    this._append({ type: 'esc_cancel', id: record.id, by })
    return { ok: true, record }
  }

  nudge(id) {
    this._append({ type: 'esc_nudge', id })
  }

  openEscalations() {
    return [...this.escalations.values()].filter((r) => r.status === 'open')
  }

  get(id) {
    return this.escalations.get(id)
  }

  // Generic operational events (notify, result, worker_done…) share the journal.
  logEvent(type, data) {
    return this._append({ type, ...data })
  }
}

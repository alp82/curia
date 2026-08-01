// Per-worker live status line (#108 item 8, absorbing the Discord side of
// items 2/3/13): one message per worker thread, edited in place through
// daemon-witnessed states — dispatched → working → waiting on esc-N ("title",
// elapsed) → awaiting review → executing approved writes → 🏁 done.
//
// Every transition is a journal event the daemon already writes, so this
// module subscribes to the store's append hook rather than threading a
// callback through the dispatcher. The daemon composes every string; worker
// text never lands here verbatim. State is ephemeral — after a daemon restart
// the next transition posts a fresh line, and the journal remains the truth.

import { REVIEW_KIND } from './lifecycle.mjs'
import { CONFIRM_KIND } from './store.mjs'
import { promptTitle, elapsedLabel } from './messaging.mjs'

export class StatusLine {
  // post(ticket, text) -> {threadId, messageId} | null (bridge down)
  // edit(ids, text) -> boolean — false means the message is gone; repost
  // get(id) -> escalation record (esc_* events carry only the id)
  constructor({ post, edit, get, log = console.log }) {
    this.post = post
    this.edit = edit
    this.get = get
    this.log = log
    this.workers = new Map() // session -> { ticket, state, detail, ids, chain }
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'worker_spawned':
        return this.#set(ev.worker, ev.ticket, 'dispatched', { model: ev.model })
      case 'worker_ready':
        // The spawn command carries the prompt, so the composer marker means
        // the worker is already at work — ready and working are one state.
        return this.#set(ev.worker, ev.ticket, 'working', { model: ev.model, at: ev.ts })
      case 'worker_ready_timeout':
        return this.#set(ev.worker, ev.ticket, 'stalled', {})
      case 'esc_open': {
        if (ev.kind === CONFIRM_KIND) return
        const state = ev.kind === REVIEW_KIND ? 'awaiting-review' : 'waiting'
        return this.#set(ev.worker, ev.ticket, state, {
          esc: { id: ev.id, title: promptTitle(ev.prompt), opened_at: ev.ts },
        })
      }
      case 'esc_nudge': {
        // The elapsed time is the only thing that changed — refresh the line
        // in place. This replaces the separate still-waiting reminder message
        // (#108 item 13): never fake-new content, never a re-posted body.
        const r = this.get(ev.id)
        if (!r || r.kind === CONFIRM_KIND) return
        const w = this.workers.get(r.worker)
        if (w && w.detail.esc?.id === r.id) return this.#set(r.worker, r.ticket, w.state, w.detail)
        return
      }
      case 'esc_answer': {
        const r = this.get(ev.id)
        if (!r || r.kind === CONFIRM_KIND) return
        if (r.kind === REVIEW_KIND && ev.answer === 'approve') {
          return this.#set(r.worker, r.ticket, 'executing', {})
        }
        return this.#set(r.worker, r.ticket, 'working', {})
      }
      case 'esc_cancel':
      case 'esc_lapse': {
        const r = this.get(ev.id)
        if (!r || r.kind === CONFIRM_KIND) return
        return this.#set(r.worker, r.ticket, 'working', {})
      }
      case 'result':
        return this.#set(ev.worker, ev.ticket, 'resolving', { status: ev.status })
      case 'worker_done': {
        // carries no ticket — only a session this line already tracks can end
        const w = this.workers.get(ev.worker)
        if (w) return this.#set(ev.worker, w.ticket, 'done', {})
        return
      }
      default:
    }
  }

  #text(session, state, detail) {
    switch (state) {
      case 'dispatched':
        return `⚙️ \`${session}\` · dispatched on **${detail.model}** — waiting for the composer`
      case 'working':
        return `▶️ \`${session}\` · working${detail.model ? ` on **${detail.model}**` : ''}`
      case 'stalled':
        return `⚠️ \`${session}\` · never reached a composer — session kept for inspection`
      case 'waiting': {
        const waited = elapsedLabel(detail.esc.opened_at)
        return `⏳ \`${session}\` · waiting on **[${detail.esc.id}]** — ${detail.esc.title}${waited ? ` — ${waited}` : ''}`
      }
      case 'awaiting-review': {
        const waited = elapsedLabel(detail.esc.opened_at)
        return `🔎 \`${session}\` · awaiting review — **[${detail.esc.id}]**${waited ? ` — ${waited}` : ''}`
      }
      case 'executing':
        return `🚀 \`${session}\` · executing approved writes`
      case 'resolving':
        return `📦 \`${session}\` · result received (**${detail.status}**) — resolving the ticket`
      case 'done':
        return `🏁 \`${session}\` · done`
      default:
        return `\`${session}\` · ${state}`
    }
  }

  // One line per worker, edits serialized per worker so a fast transition
  // never lands under a slower one's edit.
  #set(session, ticket, state, detail) {
    let w = this.workers.get(session)
    if (!w) {
      w = { ticket, state, detail, ids: null, chain: Promise.resolve() }
      this.workers.set(session, w)
    }
    // a respawn after done is a new run: leave the old line as history
    const fresh = state === 'dispatched' && w.state === 'done'
    w.ticket = ticket ?? w.ticket
    w.state = state
    w.detail = detail
    const text = this.#text(session, state, detail)
    w.chain = w.chain.then(() => this.#apply(w, text, fresh)).catch((e) => {
      this.log(`status line for ${session} failed: ${e.message}`)
    })
    return w.chain
  }

  async #apply(w, text, fresh) {
    if (fresh) w.ids = null // inside the chain, or a queued edit re-targets the old line
    if (w.ids && await this.edit(w.ids, text)) return
    w.ids = (await this.post(w.ticket, text)) ?? null
  }
}

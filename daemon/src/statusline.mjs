// Per-worker live status line (#108 item 8, absorbing the Discord side of
// items 2/3/13): one message per worker thread through daemon-witnessed
// states — dispatched → working → waiting on esc-N ("title", elapsed) →
// awaiting review → executing approved writes → 🏁 done. A state change
// repositions the message to the thread bottom (item 17); every other refresh
// edits in place.
//
// Every transition is a journal event the daemon already writes, so this
// module subscribes to the store's append hook rather than threading a
// callback through the dispatcher. The daemon composes every string; worker
// text never lands here verbatim. State is ephemeral — after a daemon restart
// the next transition posts a fresh line, and the journal remains the truth.
//
// #146 adds the METERS — model, reasoning effort, context %, and the account
// usage bars — appended to whatever the state says. Every number they carry is
// computed in usage.mjs; this module only decides how much of it fits and when
// the line is worth an edit. The split matters: a meter source going quiet
// (no transcript yet, no configured window, an account reading the daemon may
// not refresh) drops that one meter and never the line.

import { REVIEW_KIND } from './lifecycle.mjs'
import { CONFIRM_KIND } from './store.mjs'
import { promptTitle, elapsedLabel } from './messaging.mjs'
import { meterParts } from './usage.mjs'

// The gap between groups on the line (#146). U+2003 EM SPACE, not two plain
// spaces: Discord collapses a run of ASCII spaces, and the line needs real air
// between the state, the model, the context and each usage window.
export const GROUP_SEP = ' · '

// How wide the composed line may get before meters start dropping (#146),
// counted in rendered columns. One line stays one line: a phone wraps rather
// than truncates, so the budget is what keeps a status line from becoming a
// paragraph. Meters are appended in value order and the first one that will not
// fit ends the run.
//
// Set against the two real shapes. A full working line measures 86 columns and
// always survives whole. A `waiting` line carrying an 80-character escalation
// title starts at 116, so it keeps the model and the context and loses the
// usage bars — which is the right thing to lose, because a worker blocked on a
// question is burning no quota at all.
export const LINE_BUDGET = 130

// What the line costs a reader, not what it costs a string. Markdown syntax
// renders to nothing, and an emoji renders about two columns wide, so
// `String.length` over-counts the first and under-counts the second — and the
// budget exists to answer a question about columns.
export function visibleWidth(text) {
  let width = 0
  for (const ch of String(text).replace(/\*\*|`/g, '')) {
    const cp = ch.codePointAt(0)
    // A variation selector renders nothing itself, but it promotes the
    // character before it to emoji width — so counting it as 1 makes the pair
    // come to 2, which is what `▶️` actually occupies.
    width += cp >= 0x1F000 ? 2 : 1
  }
  return width
}

// The states a meter says anything true about. A finished, stalled or dead
// worker has no live context and no reason to carry account bars.
const METERED = new Set(['dispatched', 'working', 'waiting', 'awaiting-review', 'executing'])

export class StatusLine {
  // post(ticket, text) -> {threadId, messageId} | null (bridge down)
  // edit(ids, text) -> boolean — false means the message is gone; repost
  // remove(ids) — delete before a repositioning repost (#108 item 17)
  // get(id) -> escalation record (esc_* events carry only the id)
  // meters(session, model) -> see usage.workerMeters; null drops every meter
  constructor({
    post, edit, remove = async () => {}, get, log = console.log,
    meters = () => null, refreshMs = 60_000, now = () => Date.now(),
  }) {
    this.post = post
    this.edit = edit
    this.remove = remove
    this.get = get
    this.log = log
    this.meters = meters
    this.now = now
    this.refreshMs = refreshMs
    this.timer = null
    this.workers = new Map() // session -> { ticket, model, state, detail, text, ids, chain }
  }

  // The meter tick (#146). The elapsed time only refreshes while an escalation
  // nudges, so context % and the usage bars would otherwise stand still through
  // a whole working turn — a percentage that stops moving is a lie on a surface
  // built to be trusted. Same message, edited in place, and #apply drops the
  // edit when the composed text did not actually change, so a quiet worker
  // costs no Discord call at all.
  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.refresh(), this.refreshMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  refresh() {
    for (const [session, w] of this.workers) {
      if (!METERED.has(w.state)) continue
      this.#set(session, w.ticket, w.state, w.detail)
    }
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
      case 'worker_died':
        // the liveness sweep's event (#138) — the line stops saying "working"
        // about a killed worker and names the way out
        return this.#set(ev.worker, ev.ticket, 'gone', { ticket: ev.ticket })
      case 'worker_done': {
        // carries no ticket — only a session this line already tracks can end
        const w = this.workers.get(ev.worker)
        if (w) return this.#set(ev.worker, w.ticket, 'done', {})
        return
      }
      default:
    }
  }

  // The state's own sentence, meters excluded. The model moved OUT of the
  // working line and into the meter run (#146): it is the same fact on every
  // state now, so it reads once, in one place, beside the effort it was picked
  // with. `dispatched` keeps it inline — there is no transcript yet, so the
  // model IS the dispatch news.
  #base(session, state, detail) {
    switch (state) {
      case 'dispatched':
        return `⚙️ \`${session}\`${GROUP_SEP}dispatched on **${detail.model}** — waiting for the composer`
      case 'working':
        return `▶️ \`${session}\`${GROUP_SEP}working`
      case 'stalled':
        return `⚠️ \`${session}\`${GROUP_SEP}never reached a composer — session kept for inspection`
      case 'waiting': {
        const waited = elapsedLabel(detail.esc.opened_at, this.now())
        return `⏳ \`${session}\`${GROUP_SEP}waiting on **[${detail.esc.id}]** — ${detail.esc.title}${waited ? ` — ${waited}` : ''}`
      }
      case 'awaiting-review': {
        const waited = elapsedLabel(detail.esc.opened_at, this.now())
        return `🔎 \`${session}\`${GROUP_SEP}awaiting review — **[${detail.esc.id}]**${waited ? ` — ${waited}` : ''}`
      }
      case 'executing':
        return `🚀 \`${session}\`${GROUP_SEP}executing approved writes`
      case 'resolving':
        return `📦 \`${session}\`${GROUP_SEP}result received (**${detail.status}**) — resolving the ticket`
      case 'done':
        return `🏁 \`${session}\`${GROUP_SEP}done`
      case 'gone':
        return `⚰️ \`${session}\`${GROUP_SEP}worker gone — \`resume ${detail.ticket}\``
      default:
        return `\`${session}\`${GROUP_SEP}${state}`
    }
  }

  #text(session, state, detail, model) {
    const base = this.#base(session, state, detail)
    if (!METERED.has(state)) return base
    let parts
    try {
      parts = meterParts(this.meters(session, model))
    } catch (e) {
      this.log(`status line meters for ${session} failed: ${e.message}`)
      return base
    }
    // `dispatched` already names the model in its own sentence.
    if (state === 'dispatched') parts = parts.filter((p) => !p.startsWith(`**${model}**`))
    let text = base
    for (const part of parts) {
      const next = `${text}${GROUP_SEP}${part}`
      if (visibleWidth(next) > LINE_BUDGET) break // value order: the tail goes first
      text = next
    }
    return text
  }

  // One line per worker, edits serialized per worker so a fast transition
  // never lands under a slower one's edit.
  #set(session, ticket, state, detail) {
    let w = this.workers.get(session)
    if (!w) {
      w = { ticket, model: null, state, detail, text: null, ids: null, chain: Promise.resolve() }
      this.workers.set(session, w)
    }
    // a respawn after done is a new run: leave the old line as history
    const fresh = state === 'dispatched' && w.state === 'done'
    // #108 item 17: a state CHANGE repositions the line to the thread bottom
    // (delete + repost) — an edit-in-place stays where the line was born,
    // screens above where the operator reads. Same-state refreshes (the
    // elapsed-time tick) keep editing in place.
    const move = state !== w.state
    w.ticket = ticket ?? w.ticket
    w.state = state
    w.detail = detail
    // The model is sticky: only the spawn events carry it, and every state
    // after them still wants to say which model is running. A retry down the
    // fallback chain reposts `dispatched` with the new one (#13).
    if (detail.model) w.model = detail.model
    const text = this.#text(session, state, detail, w.model)
    w.chain = w.chain.then(() => this.#apply(w, text, { fresh, move })).catch((e) => {
      this.log(`status line for ${session} failed: ${e.message}`)
    })
    return w.chain
  }

  async #apply(w, text, { fresh, move }) {
    if (fresh) {
      w.ids = null // inside the chain, or a queued edit re-targets the old line
    } else if (move && w.ids) {
      await this.remove(w.ids)
      w.ids = null
    } else if (w.ids && text === w.text) {
      // The meter tick runs every minute against numbers that move in single
      // digits per hour. An edit that changes nothing is a Discord call for
      // nothing, so identical text is the tick's normal outcome (#146).
      return
    }
    w.text = text
    if (w.ids && await this.edit(w.ids, text)) return
    w.ids = (await this.post(w.ticket, text)) ?? null
  }
}

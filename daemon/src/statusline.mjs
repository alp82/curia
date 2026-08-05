// Per-agent live status line (#108 item 8, absorbing the Discord side of
// items 2/3/13): one message per agent thread through daemon-witnessed
// states — dispatched → working → waiting on esc-N ("title", elapsed) →
// awaiting review → executing approved writes → 🏁 done. A state change
// repositions the message to the thread bottom (item 17); every other refresh
// edits in place.
//
// Every transition is a journal event the daemon already writes, so this
// module subscribes to the store's append hook rather than threading a
// callback through the dispatcher. The daemon composes every string; agent
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
// title starts near 116, so it loses the usage bars — which is the right thing
// to lose, because an agent blocked on a question is burning no quota at all.
//
// The model is the exception, and #179 made it one. See #fit below: the title
// yields columns to the model rather than the other way round.
export const LINE_BUDGET = 130

// The narrowest an escalation title may be cut to buy columns for the model
// (#179). Below this a title stops being a title, and no meter is worth that.
export const TITLE_FLOOR = 24

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
// agent has no live context and no reason to carry account bars.
const METERED = new Set(['dispatched', 'working', 'waiting', 'awaiting-review', 'cross-checking', 'executing'])

// The literal the 🔎 button sends (#165). Matched here rather than imported as
// the regex, because this file reads the ANSWER off a journal event and an
// operator may have typed the word instead of pressing the button.
const CROSS_CHECK_RE = /^cross[- ]?check$/i

// The thread-NAME projection of the state (#199): what the signal glyph on the
// thread list should say about who is blocked. `waiting` and `awaiting-review`
// keep their names — the same vocabulary the line itself uses — and `working`
// clears them, because the list only answers one question: does this ticket
// need the operator? Terminal states are absent on purpose: release and cancel
// own the ✅/⚰️ rename, and a dead agent keeps its last glyph — a question
// kept answerable (#139) is still a question.
//
// The states that FUNNEL INTO done are absent too: executing, cross-checking
// and resolving keep the glyph they found. They live for a minute or two on
// the way out of a ticket, and clearing 🔎 back to 🎫 for that tail spends
// the rename slot the ✅ needs (#199's budget of 2 per 10 min) — which is how
// the checkmark used to arrive ten minutes late. An approve that sends the
// builder back to real work still clears: the next `working` transition fires.
const NAME_FLAG = {
  waiting: 'waiting',
  'awaiting-review': 'awaiting-review',
  dispatched: 'working',
  working: 'working',
}

export class StatusLine {
  // post(ticket, text) -> {threadId, messageId} | null (bridge down)
  // edit(ids, text) -> boolean — false means the message is gone; repost
  // remove(ids) — delete before a repositioning repost (#108 item 17)
  // get(id) -> escalation record (esc_* events carry only the id)
  // meters(session, model) -> see usage.agentMeters; null drops every meter
  constructor({
    post, edit, remove = async () => {}, get, log = console.log,
    meters = () => null, flag = () => {}, refreshMs = 60_000, now = () => Date.now(),
  }) {
    this.post = post
    this.edit = edit
    this.remove = remove
    this.get = get
    this.log = log
    this.meters = meters
    this.flag = flag
    this.now = now
    this.refreshMs = refreshMs
    this.timer = null
    this.agents = new Map() // session -> { ticket, model, state, detail, text, ids, chain }
  }

  // The meter tick (#146). The elapsed time only refreshes while an escalation
  // nudges, so context % and the usage bars would otherwise stand still through
  // a whole working turn — a percentage that stops moving is a lie on a surface
  // built to be trusted. Same message, edited in place, and #apply drops the
  // edit when the composed text did not actually change, so a quiet agent
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

  // The live state this line holds for a session (#236) — the direct answer
  // under a thread question reads it. Null for a session this line never saw,
  // which is every agent adopted after a daemon restart until its next
  // transition; the caller falls back to the dispatcher's record then.
  stateOf(session) {
    const w = this.agents.get(session)
    return w ? { state: w.state, detail: w.detail } : null
  }

  refresh() {
    for (const [session, w] of this.agents) {
      if (!METERED.has(w.state)) continue
      this.#set(session, w.ticket, w.state, w.detail)
    }
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'agent_spawned':
        return this.#set(ev.agent, ev.ticket, 'dispatched', { model: ev.model })
      case 'agent_ready':
        // The spawn command carries the prompt, so the composer marker means
        // the agent is already at work — ready and working are one state.
        return this.#set(ev.agent, ev.ticket, 'working', { model: ev.model, at: ev.ts })
      case 'agent_ready_timeout':
        return this.#set(ev.agent, ev.ticket, 'stalled', {})
      case 'agent_exited_early':
        // same terminal state as the timeout, but the line says WHICH kind of
        // failure it was (#169) — a dead command reads nothing like a slow one
        return this.#set(ev.agent, ev.ticket, 'stalled', { exit: ev.status })
      case 'esc_open': {
        if (ev.kind === CONFIRM_KIND) return
        const state = ev.kind === REVIEW_KIND ? 'awaiting-review' : 'waiting'
        return this.#set(ev.agent, ev.ticket, state, {
          esc: { id: ev.id, title: promptTitle(ev.prompt), opened_at: ev.ts },
        })
      }
      case 'esc_nudge': {
        // The elapsed time is the only thing that changed — refresh the line
        // in place. This replaces the separate still-waiting reminder message
        // (#108 item 13): never fake-new content, never a re-posted body.
        const r = this.get(ev.id)
        if (!r || r.kind === CONFIRM_KIND) return
        const w = this.agents.get(r.agent)
        if (w && w.detail.esc?.id === r.id) return this.#set(r.agent, r.ticket, w.state, w.detail)
        return
      }
      case 'esc_answer': {
        const r = this.get(ev.id)
        if (!r || r.kind === CONFIRM_KIND) return
        if (r.kind === REVIEW_KIND && ev.answer === 'approve') {
          return this.#set(r.agent, r.ticket, 'executing', {})
        }
        // A cross-check press is not "working": the builder goes idle inside the
        // gate call and waits (#165). `cross_check_requested` below says so, and
        // it lands right behind this event — so this line does not guess.
        if (r.kind === REVIEW_KIND && CROSS_CHECK_RE.test(String(ev.answer ?? ''))) return
        return this.#set(r.agent, r.ticket, 'working', {})
      }
      // #165: the builder's own line while a second agent reads its diff. The
      // reviewer draws its own line beside it, off its `agent_spawned`.
      case 'cross_check_requested':
        return this.#set(ev.agent, ev.ticket, 'cross-checking', { at: ev.ts })
      case 'cross_check_returned':
        return this.#set(ev.agent, ev.ticket, 'working', {})
      case 'esc_cancel':
      case 'esc_lapse': {
        const r = this.get(ev.id)
        if (!r || r.kind === CONFIRM_KIND) return
        return this.#set(r.agent, r.ticket, 'working', {})
      }
      case 'result': {
        // The one event whose ticket the AGENT used to write (#202). The write
        // edge binds it now, but the journal is append-only, so a line written
        // before that keeps the agent's spelling — and this line must not
        // follow it into a stray thread. The session this line already tracks
        // carries the bound ticket, exactly as `agent_done` relies on below, so
        // it wins. The event is the fallback for a session first seen after a
        // daemon restart, where there is nothing else to post under.
        const w = this.agents.get(ev.agent)
        return this.#set(ev.agent, w?.ticket ?? ev.ticket, 'resolving', { status: ev.status })
      }
      case 'agent_died':
        // the liveness sweep's event (#138) — the line stops saying "working"
        // about a killed agent and names the way out
        return this.#set(ev.agent, ev.ticket, 'gone', { ticket: ev.ticket })
      case 'agent_done':
        // A Stop-hook RECEIPT, not an ending (#240): the hook fires at every
        // turn end, and a turn ends parked on an open escalation as a matter of
        // course (#47) — the 🏁 that used to render here said "done" about an
        // agent waiting on the operator's first answer, minutes into a HITL
        // ticket. What the turn end MEANT is the dispatcher's verdict, and it
        // journals that verdict as its own event; the cases below read those.
        return
      case 'agent_blocked_on_human': {
        // The turn ended parked (#47) — the line keeps naming whom it waits on.
        // Live, this repeats what esc_open already drew; after a restart it is
        // the only event that redraws a parked line before the next nudge.
        if (ev.cross_check) return this.#set(ev.agent, ev.ticket, 'cross-checking', { at: ev.ts })
        const recs = (ev.escalations ?? []).map((id) => this.get(id)).filter(Boolean)
        const r = recs.find((x) => x.kind === REVIEW_KIND) ?? recs[0]
        if (!r) return
        return this.#set(ev.agent, ev.ticket, ev.awaiting_review ? 'awaiting-review' : 'waiting', {
          esc: { id: r.id, title: promptTitle(r.prompt), opened_at: r.opened_at ?? ev.ts },
        })
      }
      case 'lifecycle_closed':
        // the dispatcher's own verdict that the ending ran — carries the
        // ticket, so a session first seen after a restart still gets its 🏁
        return this.#set(ev.agent, ev.ticket, 'done', {})
      case 'agent_abnormal_exit':
      case 'reviewer_abnormal_exit':
        // stopped without a result — the notify says so, and the line used to
        // contradict it with a 🏁 read off the same Stop hook (#240)
        return this.#set(ev.agent, ev.ticket, 'failed', {})
      default:
    }
  }

  // The state's own sentence, meters excluded. The model moved OUT of the
  // working line and into the meter run (#146): it is the same fact on every
  // state now, so it reads once, in one place, beside the effort it was picked
  // with. `dispatched` keeps it inline — there is no transcript yet, so the
  // model IS the dispatch news.
  //
  // `model` is what the meters call the model (#179), not the routing label the
  // event carried — one line must not name the same thing two ways.
  #base(session, state, detail, model) {
    switch (state) {
      case 'dispatched':
        return `⚙️ \`${session}\`${GROUP_SEP}dispatched on **${model}** — waiting for the composer`
      case 'working':
        return `▶️ \`${session}\`${GROUP_SEP}working`
      case 'stalled':
        if (detail.exit !== undefined) {
          return `⚠️ \`${session}\`${GROUP_SEP}the harness command exited (status ${detail.exit}) before the composer — session kept for inspection`
        }
        return `⚠️ \`${session}\`${GROUP_SEP}never reached a composer — session kept for inspection`
      case 'waiting': {
        const waited = elapsedLabel(detail.esc.opened_at, this.now())
        return `⏳ \`${session}\`${GROUP_SEP}waiting on **[${detail.esc.id}]** — ${detail.esc.title}${waited ? ` — ${waited}` : ''}`
      }
      case 'awaiting-review': {
        const waited = elapsedLabel(detail.esc.opened_at, this.now())
        return `🔎 \`${session}\`${GROUP_SEP}awaiting review — **[${detail.esc.id}]**${waited ? ` — ${waited}` : ''}`
      }
      case 'cross-checking': {
        const waited = elapsedLabel(detail.at, this.now())
        return `⏸️ \`${session}\`${GROUP_SEP}idle at the gate — a cross-check is reading its diff${waited ? ` — ${waited}` : ''}`
      }
      case 'executing':
        return `🚀 \`${session}\`${GROUP_SEP}executing approved writes`
      case 'resolving':
        return `📦 \`${session}\`${GROUP_SEP}result received (**${detail.status}**) — resolving the ticket`
      case 'done':
        return `🏁 \`${session}\`${GROUP_SEP}done`
      case 'failed':
        return `⚠️ \`${session}\`${GROUP_SEP}stopped without a result — session kept for post-mortem`
      case 'gone':
        return `⚰️ \`${session}\`${GROUP_SEP}agent gone — \`resume ${detail.ticket}\``
      default:
        return `\`${session}\`${GROUP_SEP}${state}`
    }
  }

  // The base, cut so that the most valuable meter still fits (#179). #146
  // appended meters to a finished base and stopped at the first one too wide,
  // so a long escalation title pushed the MODEL group — first in value order —
  // off the line, and every meter behind it went too. A `waiting` line then
  // said nothing at all about the model, which is the one fact this surface
  // exists to carry.
  //
  // So the base yields instead. The escalation title is the only part of any
  // base that grows, and it is already a cut of a longer prompt, so cutting it
  // a little further costs less than losing the model. Two guards keep the
  // trade honest: the title never goes below TITLE_FLOOR, and a title that
  // cannot reach that width is left whole and the meter drops as before.
  #fit(session, state, detail, model, parts) {
    const base = this.#base(session, state, detail, model)
    const title = detail.esc?.title
    if (!parts.length || !title) return base
    const room = LINE_BUDGET - visibleWidth(`${GROUP_SEP}${parts[0]}`)
    if (visibleWidth(base) <= room) return base
    // One column of the allowance pays for the ellipsis promptTitle appends.
    const max = title.length - (visibleWidth(base) - room) - 1
    if (max < TITLE_FLOOR) return base
    const esc = { ...detail.esc, title: promptTitle(title, max) }
    return this.#base(session, state, { ...detail, esc }, model)
  }

  #text(session, state, detail, model) {
    if (!METERED.has(state)) return this.#base(session, state, detail, model)
    let parts
    let named = model
    try {
      const m = this.meters(session, model)
      // What the meters call the model wins over the routing label the event
      // carried, on the meter run AND in the base sentence (#179).
      named = m?.model ?? model
      parts = meterParts(m)
    } catch (e) {
      this.log(`status line meters for ${session} failed: ${e.message}`)
      return this.#base(session, state, detail, model)
    }
    // `dispatched` already names the model in its own sentence.
    if (state === 'dispatched') parts = parts.filter((p) => !p.startsWith(`**${named}**`))
    let text = this.#fit(session, state, detail, named, parts)
    for (const part of parts) {
      const next = `${text}${GROUP_SEP}${part}`
      if (visibleWidth(next) > LINE_BUDGET) break // value order: the tail goes first
      text = next
    }
    return text
  }

  // One line per agent, edits serialized per agent so a fast transition
  // never lands under a slower one's edit.
  #set(session, ticket, state, detail) {
    let w = this.agents.get(session)
    if (!w) {
      w = { ticket, model: null, state, detail, text: null, ids: null, flag: null, chain: Promise.resolve() }
      this.agents.set(session, w)
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
    //
    // Sticky is not durable, and #187 measured the difference: this Map dies
    // with the process, so a line first drawn after a restart carries no model
    // at all. The meters callback fills that in from the dispatcher's record,
    // which reconcile rebuilds from the journal — see index.mjs.
    if (detail.model) w.model = detail.model
    // The thread name follows the state (#199) — told to the bridge, which
    // holds no state of its own (#93). Only a real projection CHANGE fires,
    // so the meter tick and same-state refreshes cost no rename budget; the
    // comment on `post` applies here too — a failure is the bridge's to log,
    // and the next transition retries.
    const f = NAME_FLAG[state]
    if (f && f !== w.flag) {
      w.flag = f
      Promise.resolve(this.flag(w.ticket, f)).catch((e) => {
        this.log(`thread flag for ${session} failed: ${e.message}`)
      })
    }
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

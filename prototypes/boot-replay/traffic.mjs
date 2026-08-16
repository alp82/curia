// The traffic the REDUCER lives on, added to #321's synthetic journal.
//
// `prototypes/journal-schema/synth.mjs` was built for the fourteen questions,
// and those are all about dispatches. So it writes no escalation, no note, no
// thread binding, no overseer turn and no console conversation — and a boot over
// it folds an almost empty reduction. That is fine evidence for #321 and no
// evidence at all for #322.
//
// This module walks that journal and injects the events `_apply` actually acts
// on, in causal order inside the dispatch that carries them. It does not touch
// `synth.mjs`, whose numbers are on the record for #321.
//
// The RATES below are an assumption, not a measurement. Nobody has a census of
// the real journal by type — #317 measured its size and its growth and no more.
// So read the shares this fixture produces as one plausible journal, and read
// the equivalence check, which does not depend on them, as the evidence.

// Deterministic, so a number in the verdict can be reproduced.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function words(rnd, n) {
  const bag = ['the', 'operator', 'asked', 'and', 'the', 'agent', 'waited', 'on', 'one', 'answer',
    'about', 'the', 'gate', 'the', 'note', 'and', 'the', 'thread', 'it', 'runs', 'in']
  return Array.from({ length: n }, () => bag[Math.floor(rnd() * bag.length)]).join(' ')
}

// The pre-#184 spelling, the same rule `synth.mjs` applies to the oldest fifth.
function toLegacy(ev) {
  const out = {}
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'type') out.type = String(v).replaceAll('agent', 'worker')
    else if (k === 'agent') out.worker = v
    else if (k === 'harness') out.backend = v
    else out[k] = v
  }
  return out
}

export function enrich(lines, { seed = 11, legacyFraction = 0.2 } = {}) {
  const rnd = rng(seed)
  const out = []
  let escSeq = 0
  let noteSeq = 0
  let convSeq = 0
  // The escalation each ticket has open, so a later event can close it.
  const openGate = new Map() // ticket -> escalation id
  const openAsk = new Map() // agent -> escalation id
  const boundThreads = new Map() // ticket -> thread id
  const liveConversations = []

  const legacyUntil = Math.floor(lines.length * legacyFraction)
  // An injected event takes the stamp of the line it follows. Stamps tie in the
  // real journal — #321 measured 53 events on one millisecond — and the replay
  // orders by write position, never by stamp.
  const emit = (ev, ts, i) => out.push(JSON.stringify({ ts, ...(i < legacyUntil ? toLegacy(ev) : ev) }))

  for (let i = 0; i < lines.length; i++) {
    const ev = JSON.parse(lines[i])
    const ts = ev.ts
    const ticket = ev.ticket == null ? null : String(ev.ticket)
    // A legacy line says `worker`, so read both spellings.
    const agent = ev.agent ?? ev.worker ?? null
    const type = String(ev.type ?? '').replaceAll('worker', 'agent')

    // ---- the escalation the review gate is ------------------------------
    // `review_requested` is the line the gate writes; the escalation record
    // beside it is what the reducer holds. So the gate opens before the line
    // and answers with it.
    if (type === 'review_requested' && ticket && agent) {
      const id = `esc-${++escSeq}`
      openGate.set(ticket, id)
      emit({
        type: 'esc_open', id, agent, ticket, kind: 'approve-reject',
        prompt: words(rnd, 30), recommended: false, diff: ev.diff ?? null,
        payload_hash: 'h'.repeat(16), action: 'review', origin_thread_id: boundThreads.get(ticket) ?? null,
      }, ts, i)
      emit({ type: 'esc_render', id, channelId: 'c1', threadId: boundThreads.get(ticket) ?? 'th-0', messageId: `m${escSeq}` }, ts, i)
    }

    out.push(lines[i])

    if (type === 'dispatch_claimed' && ticket) {
      const thread = `th-${ticket}-${boundThreads.has(ticket) ? 2 : 1}`
      boundThreads.set(ticket, thread)
      emit({ type: 'thread_bound', ticket, thread_id: thread }, ts, i)
    }

    // ---- the questions an agent asks while it runs -----------------------
    if (type === 'agent_spawned' && agent && ticket) {
      if (rnd() < 0.55) {
        const id = `esc-${++escSeq}`
        openAsk.set(agent, id)
        emit({
          type: 'esc_open', id, agent, ticket, kind: 'free-text', prompt: words(rnd, 40),
          recommended: rnd() < 0.5, payload_hash: 'h'.repeat(16),
          origin_thread_id: boundThreads.get(ticket) ?? null,
        }, ts, i)
        emit({ type: 'esc_render', id, channelId: 'c1', threadId: boundThreads.get(ticket) ?? 'th-0', messageId: `m${escSeq}` }, ts, i)
        // #29/#336: the question re-issued word for word supersedes the first.
        if (rnd() < 0.25) {
          const next = `esc-${++escSeq}`
          emit({ type: 'esc_supersede', id, successor: next }, ts, i)
          emit({
            type: 'esc_open', id: next, agent, ticket, kind: 'free-text', prompt: words(rnd, 40),
            recommended: false, payload_hash: 'h'.repeat(16),
          }, ts, i)
          openAsk.set(agent, next)
        }
      }
      if (rnd() < 0.45) {
        const id = `note-${++noteSeq}`
        emit({
          type: 'agent_note', id, agent, ticket, text: words(rnd, 20),
          instance: `${agent}@1755300000000`, label: rnd() < 0.2 ? 'cross-check verdict' : null,
        }, ts, i)
        if (rnd() < 0.7) emit({ type: 'agent_notes_drained', agent, ticket, count: 1 }, ts, i)
        else if (rnd() < 0.5) emit({ type: 'agent_note_interrupted', agent, ticket, id }, ts, i)
      }
    }

    // The answer that closes a question, some way or other.
    if (type === 'stop_blocked' && agent && openAsk.has(agent)) {
      const id = openAsk.get(agent)
      openAsk.delete(agent)
      const roll = rnd()
      if (roll < 0.7) emit({ type: 'esc_answer', id, answer: words(rnd, 15), by: 'alp82', via: 'discord', attachments: [] }, ts, i)
      else if (roll < 0.8) emit({ type: 'esc_cancel', id, by: 'alp82' }, ts, i)
      else if (roll < 0.9) emit({ type: 'esc_lapse', id, reason: 'agent exited' }, ts, i)
      else emit({ type: 'escalation_agent_died', id }, ts, i)
    }

    if (type === 'review_answered' && ticket && openGate.has(ticket)) {
      const id = openGate.get(ticket)
      openGate.delete(ticket)
      emit({ type: 'esc_answer', id, answer: ev.approved ? 'approve' : 'reject', by: 'alp82', via: 'gate', attachments: [] }, ts, i)
    }

    if (type === 'lifecycle_closed' && ticket && agent) {
      if (rnd() < 0.6) {
        const thread = boundThreads.get(ticket)
        if (thread) emit({ type: 'thread_released', ticket, thread_id: thread }, ts, i)
      }
      if (rnd() < 0.2) emit({ type: 'agent_notes_expired', agent, ticket, live_instance: null }, ts, i)
    }

    // ---- the daemon's other conversations --------------------------------
    // The overseer and the console are not dispatches, so they ride the journal
    // between them, the way the ticketless lines already do.
    if (rnd() < 0.04) {
      const key = liveConversations.length && rnd() < 0.7
        ? liveConversations[Math.floor(rnd() * liveConversations.length)]
        : `conv-${++convSeq}`
      if (!liveConversations.includes(key)) {
        liveConversations.push(key)
        emit({ type: 'console_conversation_opened', key }, ts, i)
        emit({ type: 'overseer_session', thread_id: key, session_id: `sess-${convSeq}-1` }, ts, i)
      }
      emit({ type: 'overseer_turn_started', key, turn: `t${i}`, prompt: words(rnd, 25), thread_id: key, replay: false }, ts, i)
      const crossings = Math.floor(rnd() * 3)
      const commands = []
      for (let c = 0; c < crossings; c++) {
        const canonical = ['start 412', 'cancel 388', 'status'][Math.floor(rnd() * 3)]
        commands.push(canonical)
        emit({ type: 'command', overseer_key: key, canonical, by: 'alp82' }, ts, i)
      }
      const roll = rnd()
      // A turn left OPEN is what a restart killed (#388), and the boot is the
      // only thing that can see it. Some are left open on purpose.
      if (roll < 0.75) emit({ type: 'overseer_turn_ended', key }, ts, i)
      else if (roll < 0.9) emit({ type: 'overseer_turn_dropped', key, crossings, commands, replayed: rnd() < 0.5, why: 'restart' }, ts, i)
      if (rnd() < 0.3) {
        emit({ type: 'overseer_note', thread_id: key, text: words(rnd, 12) }, ts, i)
        if (rnd() < 0.6) emit({ type: 'overseer_notes_drained', thread_id: key, count: 1 }, ts, i)
      }
      // A delete spends the number for good (#333): the key stays in the spent
      // set, and every binding under it goes.
      if (rnd() < 0.12) {
        emit({ type: 'console_conversation_deleted', key }, ts, i)
        liveConversations.splice(liveConversations.indexOf(key), 1)
      }
    }

    // The limit resume a ticket is owed (#346), armed and sometimes taken.
    if (type === 'stop_budget_exhausted' && ticket) {
      emit({ type: 'limit_resume_armed', ticket, repo: ev.repo ?? null, resume_at: ts }, ts, i)
      if (rnd() < 0.6) emit({ type: 'limit_resume', ticket, repo: ev.repo ?? null }, ts, i)
    }
  }
  return out
}

// #321's fixture plus this traffic, sized so the total lands on the target.
// The injection rate is not known ahead of the walk, so the first pass measures
// it and the second pass scales the input by what it found.
export function enrichedJournal(synthesize, target, opts = {}) {
  const first = enrich(synthesize(target).lines, opts)
  const ratio = first.length / target
  const scaled = synthesize(Math.max(1, Math.round(target / ratio)))
  const lines = enrich(scaled.lines, opts)
  return { lines, tickets: scaled.tickets, ratio }
}

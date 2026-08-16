// A synthetic journal of the same shape as the real one, for #321.
//
// The live file lives on the operator's box and no agent container mounts it
// (#317), so the prototype makes its own. The shape it copies is measured:
// about 343 bytes a line, 96 event types, a tail of long-text lines for
// prompts, summaries, verdicts and the review-gate diff digest.
//
// Two properties matter beyond the size. Dispatches INTERLEAVE, because curia
// runs several agents at once, so "the last event of a type for a key" is not
// "the last line of a block". And the oldest lines carry the pre-#184
// spelling: `worker_spawned`, `"worker"`, `"backend"`.

// Deterministic: the same seed gives the same journal, so a number in the
// verdict can be reproduced.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const REPOS = ['alp82/curia', 'alp82/curia-site', 'alp82/scratch']
const MODELS = ['opus', 'sonnet', 'codex-high', 'gemini-pro']
const HARNESSES = ['claude', 'codex', 'gemini']

// Filler that makes a long-text line long, the way a prompt or a verdict is.
function words(rnd, n) {
  const bag = ['the', 'journal', 'holds', 'one', 'line', 'per', 'event', 'and', 'the', 'reviewer',
    'read', 'the', 'diff', 'cold', 'so', 'a', 'finding', 'stands', 'on', 'its', 'own', 'evidence']
  let out = []
  for (let i = 0; i < n; i++) out.push(bag[Math.floor(rnd() * bag.length)])
  return out.join(' ')
}

// The operational types that carry a ticket and an agent but decide nothing —
// the noise the fourteen questions read past.
const FILLER = [
  'notify', 'agent_ready', 'agent_mcp_first', 'command', 'preview', 'agent_note_refused',
  'agent_mute', 'lease_kept', 'confirm_lapsed', 'note_interrupt', 'note_interrupt_delivered',
  'judgement_commented', 'escalation_orphaned', 'agent_blocked_on_human', 'limit_resume_armed',
  'cross_check_announced', 'reconcile_identity_unknown', 'result_parked', 'result_refused',
  'charting_paths_unread', 'resolve_skipped', 'verdict_carried', 'agent_done',
]

// The types with no ticket at all: the daemon talking about itself.
const TICKETLESS = [
  'bridge_health', 'bridge_recovered', 'bridge_wedged', 'agent_image_built', 'agent_image_pinned',
  'agent_image_pruned', 'reconcile', 'deploy_requested', 'deploy_landed', 'model_cooling',
  'provider_cooling', 'credentials_swept', 'restart_requested', 'tracker_doc_missing',
]

// The rest of the inventory: every remaining type curia writes, read off the
// 129 `logEvent` call sites in `daemon/src`. They are rare in the real journal
// and they decide nothing here — they are in so that one table really does
// carry the whole vocabulary, and so the census query has the whole census to
// group.
const RARE = [
  'agent_abnormal_exit', 'agent_cancelled', 'agent_died', 'agent_image_pruned', 'agent_token_refused',
  'bridge_render_failed', 'charting_ended', 'charting_push_refused', 'charting_unreviewed',
  'confirm_voided', 'container_route_refused', 'cross_check_rejoined', 'cross_check_requested',
  'cross_check_returned', 'cross_check_unannounced', 'dead_claim_kept_awaiting_review',
  'dead_claim_released', 'deploy_rolled_back', 'deploy_unresolved', 'dispatch_exhausted',
  'dispatch_unclaimed', 'escalation_agent_died', 'escalation_stale_at_result', 'land_failed',
  'lease_released', 'limit_resume', 'note_interrupt_failed', 'orphan_container_swept',
  'orphan_reviewer_swept', 'orphan_sweep_skipped', 'orphan_swept', 'orphan_worktree_kept',
  'overseer_container_turn', 'overseer_turn_refused', 'reconcile_repo_skipped',
  'reconcile_sessions_indeterminate', 'reset_unparseable', 'resolve_failed', 'resolved_unreviewed',
  'result_ticket_mismatch', 'review_refused', 'reviewer_abnormal_exit', 'reviewer_cancelled',
  'reviewer_ended', 'reviewer_spawn_failed', 'reviewer_tool_refused', 'side_channel_ready',
  'stop_budget_exhausted', 'unclaim_failed', 'usage_limit_ignored_ambiguous',
  'verdict_delivery_failed', 'verdict_failed', 'verdict_late', 'verdict_skipped',
  'verdict_undelivered', 'agent_notes_drained', 'agent_notes_expired', 'agent_note_interrupted',
]

// One dispatch of one ticket: the events it writes, in order, without stamps.
function dispatchEvents(rnd, ticket, opts) {
  const repo = REPOS[Math.floor(rnd() * (opts.oneRepo ? 1 : REPOS.length))]
  const agent = `curia-${ticket}`
  const charting = rnd() < 0.12
  const model = MODELS[Math.floor(rnd() * MODELS.length)]
  const harness = HARNESSES[Math.floor(rnd() * HARNESSES.length)]
  const base = { repo, ticket, agent }
  const evs = []
  const push = (type, data) => evs.push({ type, ...base, ...data })

  push('dispatch_claimed', { by: 'auto', kind: charting ? 'charting' : 'ticket' })
  push('agent_spawned', {
    instance: `${agent}@1755300000000`, model, harness,
    kind: charting ? 'charting' : 'ticket',
    instruction: charting ? 'chart the store map' : null,
    newMap: charting && rnd() < 0.3,
    sandbox: 'docker', image: 'curia-agent:node22', ports: [9006, 9007, 9008],
  })
  if (charting && rnd() < 0.7) push('map_adopted', { map: String(240 + Math.floor(rnd() * 90)), title: words(rnd, 6) })

  const noise = 3 + Math.floor(rnd() * 10)
  for (let i = 0; i < noise; i++) {
    const common = rnd() < 0.8
    const type = common
      ? FILLER[Math.floor(rnd() * FILLER.length)]
      : RARE[Math.floor(rnd() * RARE.length)]
    push(type, { message: words(rnd, 12 + Math.floor(rnd() * 20)) })
  }

  // The Stop hook, the hot path: it holds an agent that has not finished.
  const blocks = Math.floor(rnd() * 4)
  for (let i = 1; i <= blocks; i++) {
    push('stop_blocked', { attempt: i, outstanding: ['no pull request', 'no approved review'], stop_hook_active: true })
  }

  const pushed = rnd() < 0.85
  if (pushed) {
    push(rnd() < 0.2 ? 'pr_reused' : 'pr_opened', {
      branch: `curia/${ticket}`, url: `https://github.com/${repo}/pull/${300 + Math.floor(rnd() * 99)}`,
      commits: 1 + Math.floor(rnd() * 4),
    })
  }

  if (pushed) {
    // The review gate carries the diff digest (#355): the long line of the file.
    const files = 3 + Math.floor(rnd() * 12)
    push('review_requested', {
      summary: words(rnd, 40 + Math.floor(rnd() * 60)),
      charting,
      diff: {
        files, added: files * 20, removed: files * 4,
        list: Array.from({ length: files }, (_, i) => ({ path: `daemon/src/file${i}.mjs`, added: 20, removed: 4 })),
      },
    })
    // A rejected round first, sometimes, then the approval. Both are
    // `review_answered`, and only `approved` tells them apart — question 2.
    if (rnd() < 0.4) push('review_answered', { approved: false, via: 'gate', feedback: words(rnd, 25) })

    // The cross-check: a second session on the same ticket, whose own
    // `agent_spawned` moves this ticket's epoch — as it does in the daemon today.
    if (rnd() < 0.2) {
      const reviewer = `curia-review-${ticket}`
      evs.push({
        type: 'reviewer_spawned', repo, ticket, agent: reviewer, builder: agent,
        model: MODELS[Math.floor(rnd() * MODELS.length)], harness, builder_model: model,
        same_provider: rnd() < 0.5, sha: 'a'.repeat(40), checkout: `/w/review/${ticket}`,
        base_branch: 'main', by: 'gate', sandbox: 'docker', image: 'curia-agent:node22',
      })
      evs.push({ type: 'agent_spawned', repo, ticket, agent: reviewer, model, harness, kind: 'reviewer' })
      evs.push({ type: 'verdict_captured', repo, ticket, agent: reviewer, status: 'resolved', verdict: words(rnd, 80) })
      evs.push({ type: 'result', agent: reviewer, ticket, status: 'resolved', summary: words(rnd, 30) })
    }
    push('review_answered', { approved: true, via: 'gate' })
  }

  const clean = pushed && rnd() < 0.8
  if (clean && charting) {
    push('charting_finished', {
      map: String(240 + Math.floor(rnd() * 90)), status: 'resolved', commented: true,
      pr: `https://github.com/${repo}/pull/${400 + Math.floor(rnd() * 99)}`, pr_state: 'MERGED',
      summary: `🗺️ ${words(rnd, 30)}`,
    })
  } else if (clean) {
    push('ticket_resolved', {
      comment: 'posted', close: 'closed', map: 'appended', land: 'merged',
      pr: `https://github.com/${repo}/pull/${400 + Math.floor(rnd() * 99)}`, repaired: false,
      summary: `✅ ${repo}#${ticket} resolved — ${words(rnd, 30)}`,
    })
  } else {
    push('nonclean_noted', { status: 'blocked', released: true, noted: true, summary: `↩️ ${words(rnd, 25)}` })
  }
  push('result', { status: clean ? 'resolved' : 'blocked', summary: words(rnd, 30 + Math.floor(rnd() * 40)), details: { ticket } })
  push('lifecycle_closed', { reason: 'result' })
  return evs
}

// The pre-#184 spelling, put BACK on a line: this is what the old lines in the
// real file look like, and the columns must still find them.
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

// `lines` of journal text, oldest first, plus the facts a checker needs.
export function synthesize(target, { seed = 7, legacyFraction = 0.2, firstTicket = 100 } = {}) {
  const rnd = rng(seed)
  const streams = []
  let ticket = firstTicket
  const events = []
  const tickets = new Set()

  // Interleave: keep a few dispatches in flight and take one event from a
  // random live one each step, exactly as several agents running at once do.
  while (events.length < target) {
    while (streams.length < 4 && events.length + streams.length < target) {
      const t = ticket++
      // A third of the tickets get dispatched twice, which is what makes the
      // epoch cut load-bearing: the earlier dispatch's approval is not this one's.
      const rounds = rnd() < 0.33 ? 2 : 1
      for (let r = 0; r < rounds; r++) streams.push(dispatchEvents(rnd, t, {}).reverse())
      tickets.add(String(t))
    }
    if (rnd() < 0.06) {
      const type = TICKETLESS[Math.floor(rnd() * TICKETLESS.length)]
      events.push({ type, detail: words(rnd, 10 + Math.floor(rnd() * 25)) })
      continue
    }
    const i = Math.floor(rnd() * streams.length)
    const ev = streams[i].pop()
    if (!streams[i].length) streams.splice(i, 1)
    events.push(ev)
  }

  const legacyUntil = Math.floor(events.length * legacyFraction)
  const start = Date.UTC(2026, 4, 1, 8, 0, 0)
  const lines = events.map((ev, i) => {
    const ts = new Date(start + i * 21000).toISOString()
    const shaped = i < legacyUntil ? toLegacy(ev) : ev
    return JSON.stringify({ ts, ...shaped })
  })
  return { lines, tickets: [...tickets], legacyUntil }
}

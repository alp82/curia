// The per-agent status line (#108 item 8): one message per agent thread
// through daemon-witnessed states. A state CHANGE repositions the line to the
// thread bottom — delete + repost (#108 item 17) — because an edit-in-place
// stays where the line was born, screens above where the operator reads. Only
// the same-state elapsed refresh edits in place. Events are fed straight to
// onEvent — the same records the reduction's append hook delivers live.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { StatusLine, LINE_BUDGET, GROUP_SEP, visibleWidth } from '../src/statusline.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'
import { CONFIRM_KIND } from '../src/reduction.mjs'

describe('StatusLine', () => {
  let posts, edits, removals, records, line, meters

  beforeEach(() => {
    posts = []
    edits = []
    removals = []
    records = new Map()
    meters = { effort: null, ctxPct: null, windows: null }
    let n = 0
    line = new StatusLine({
      post: async (ticket, text, opts) => {
        posts.push({ ticket, text, opts })
        return { threadId: 't1', messageId: `m${++n}` }
      },
      edit: async (ids, text, opts) => {
        edits.push({ ids, text, opts })
        return true
      },
      remove: async (ids) => { removals.push(ids.messageId) },
      get: (id) => records.get(id),
      log: () => {},
      // The meter source the daemon injects (#146). Fed by hand here so the
      // suite never reads a transcript or an account cache; `meters` returns
      // the model the line was told about, plus whatever the tests set.
      //
      // The label passes straight through, which is agentMeters' last-resort
      // branch (#179): a harness that states no model of its own keeps its routing
      // label. The test below covers the branch where the two differ.
      meters: (session, model) => ({ model, ...meters }),
    })
  })

  const drain = () => line.settle()

  test('an agent phase edits the working line with the accepted icon and label', async () => {
    meters = { effort: 'high', ctxPct: 41, windows: [{ label: '5h', pct: 62, elapsedPct: 30 }] }
    line.onEvent({ type: 'agent_ready', agent: 'curia-690', ticket: '690', model: 'gpt', ts: 'T' })
    await drain()
    assert.match(posts[0].text, /🧭 `reads the ticket`/)

    line.onEvent({
      type: 'agent_progress', agent: 'curia-690', ticket: '690', phase: 'build', label: 'writes the status',
    })
    await drain()

    assert.equal(posts.length, 1, 'routine progress keeps one status message')
    assert.equal(removals.length, 0, 'routine progress never repositions the line')
    assert.match(edits.at(-1).text, /🔨 `writes the status`/)
    assert.match(edits.at(-1).text, /\*\*gpt\*\* high/)
    assert.match(edits.at(-1).text, /ctx 41%/)
    assert.match(edits.at(-1).text, /5h/)
  })

  test('dispatch, image build, and composer arrival use the one status line', async () => {
    line.onEvent({ type: 'agent_dispatching', agent: 'curia-690', ticket: '690', model: 'gpt' })
    await drain()
    assert.match(posts.at(-1).text, /dispatched on \*\*gpt\*\*/)

    line.onEvent({ type: 'agent_image_building', agent: 'curia-690', ticket: '690', model: 'gpt' })
    await drain()
    assert.equal(posts.length, 1)
    assert.match(edits.at(-1).text, /building the agent image/)

    line.onEvent({ type: 'agent_spawned', agent: 'curia-690', ticket: '690', model: 'gpt' })
    await drain()
    assert.equal(posts.length, 1)
    assert.match(edits.at(-1).text, /waiting for the composer/)

    line.onEvent({ type: 'agent_ready', agent: 'curia-690', ticket: '690', model: 'gpt', ts: 'T' })
    await drain()
    assert.equal(posts.length, 2, 'composer arrival moves the same semantic line to the bottom')
    assert.deepEqual(removals, ['m1'])
    assert.match(posts.at(-1).text, /🧭 `reads the ticket`/)
  })

  test('dispatch Action acceptance posts promptly and meaningful progress edits it in place', async () => {
    line.onEvent({
      type: 'action_evidence', action_id: 'app-start-822', kind: 'dispatch',
      target: 'alp82/curia#822', conflict_key: 'dispatch:alp82/curia#822',
      status: 'accepted', revision: 10,
    })
    await drain()

    assert.equal(posts.length, 1)
    assert.equal(posts[0].ticket, '822')
    assert.match(posts[0].text, /accepted/)

    line.onEvent({
      type: 'action_evidence', action_id: 'app-start-822', kind: 'dispatch',
      target: 'alp82/curia#822', conflict_key: 'dispatch:alp82/curia#822',
      status: 'progress', progress: 'Preparing the agent workspace', revision: 11,
    })
    await drain()

    assert.equal(posts.length, 1, 'progress keeps one status message')
    assert.equal(removals.length, 0, 'progress does not reposition accepted evidence')
    assert.match(edits.at(-1).text, /Preparing the agent workspace/)
  })

  test('dispatch Action progress after a daemon rebuild recovers the existing Discord message', async () => {
    const recovered = { threadId: 't1', messageId: 'before-restart' }
    const rebuilt = new StatusLine({
      post: async (ticket, text) => { posts.push({ ticket, text }); return { threadId: 't1', messageId: 'new' } },
      edit: async (ids, text) => { edits.push({ ids, text }); return true },
      find: async () => recovered,
      get: () => null,
      log: () => {},
    })

    rebuilt.onEvent({
      type: 'action_evidence', action_id: 'app-start-822', kind: 'dispatch',
      target: 'alp82/curia#822', conflict_key: 'dispatch:alp82/curia#822',
      status: 'progress', progress: 'Preparing the agent workspace', revision: 11,
    })
    await rebuilt.settle()

    assert.equal(posts.length, 0, 'restart recovery does not add a second status message')
    assert.deepEqual(edits[0].ids, recovered)
    assert.match(edits[0].text, /Preparing the agent workspace/)
  })

  test('dispatch Action evidence is monotonic and repeated evidence is quiet', async () => {
    const action = {
      type: 'action_evidence', action_id: 'app-start-822', kind: 'dispatch',
      target: 'alp82/curia#822', conflict_key: 'dispatch:alp82/curia#822',
    }
    line.onEvent({ ...action, status: 'accepted', revision: 20 })
    line.onEvent({ ...action, status: 'progress', progress: 'Preparing the agent workspace', revision: 22 })
    await drain()

    line.onEvent({ ...action, status: 'accepted', revision: 21 })
    line.onEvent({ ...action, status: 'progress', progress: 'Preparing the agent workspace', revision: 22 })
    await drain()

    assert.equal(posts.length, 1)
    assert.equal(edits.length, 1, 'stale and repeated evidence make no Discord call')
    assert.match(edits[0].text, /Preparing the agent workspace/)
  })

  test('a refused dispatch Action renders its reason and winning receipt once', async () => {
    const refusal = {
      type: 'action_evidence', action_id: 'app-start-refused', kind: 'dispatch',
      target: 'alp82/curia#823', conflict_key: 'dispatch:alp82/curia#823',
      status: 'refused', reason: 'the ticket is already claimed', revision: 30,
      receipt: {
        by: 'alp82', via: 'dashboard', at: '2026-08-28T10:00:00.000Z',
        answer: 'Start with gpt',
      },
    }

    line.onEvent(refusal)
    await drain()
    line.onEvent(refusal)
    await drain()

    assert.equal(posts.length, 1)
    assert.equal(posts[0].ticket, '823')
    assert.equal(posts[0].opts.settled, true)
    assert.match(posts[0].text, /dispatch refused: the ticket is already claimed/)
    assert.match(posts[0].text, /alp82 via dashboard/)
    assert.match(posts[0].text, /Start with gpt/)
    assert.equal(edits.length, 0, 'a repeated terminal reading makes no Discord call')
  })

  test('accepted dispatch work that fails settles the existing line with one safe reason', async () => {
    const action = {
      type: 'action_evidence', action_id: 'app-start-failed', kind: 'dispatch',
      target: 'alp82/curia#823', conflict_key: 'dispatch:alp82/curia#823',
    }
    line.onEvent({ ...action, status: 'accepted', revision: 40 })
    await drain()
    line.onEvent({
      ...action, status: 'failed', revision: 41,
      reason: 'the container could not start\n@everyone should not be pinged',
    })
    await drain()

    assert.equal(posts.length, 1, 'failure settles the accepted line instead of adding another')
    assert.equal(edits.length, 1)
    assert.equal(edits[0].opts.settled, true)
    assert.match(edits[0].text, /dispatch failed: the container could not start @/)
    assert.doesNotMatch(edits[0].text, /@everyone/, 'domain text cannot create a Discord mention')
  })

  test('a terminal dispatch Action recovers its pre-restart line and confirmed stays quiet', async () => {
    const recovered = { threadId: 't1', messageId: 'before-restart' }
    const rebuilt = new StatusLine({
      post: async (ticket, text) => { posts.push({ ticket, text }); return { threadId: 't1', messageId: 'new' } },
      edit: async (ids, text, opts) => { edits.push({ ids, text, opts }); return true },
      find: async () => recovered,
      get: () => null,
      log: () => {},
    })
    const action = {
      type: 'action_evidence', action_id: 'app-start-recovered', kind: 'dispatch',
      target: 'alp82/curia#823', conflict_key: 'dispatch:alp82/curia#823',
    }

    rebuilt.onEvent({ ...action, status: 'failed', reason: 'preparation stopped', revision: 51 })
    await rebuilt.settle()
    rebuilt.onEvent({ ...action, action_id: 'app-start-confirmed', status: 'confirmed', revision: 52 })
    await rebuilt.settle()

    assert.equal(posts.length, 0, 'rebuild recovery does not add a terminal line')
    assert.deepEqual(edits[0].ids, recovered)
    assert.equal(edits[0].opts.settled, true)
    assert.match(edits[0].text, /dispatch failed: preparation stopped/)
    assert.equal(edits.length, 1, 'confirmed evidence emits no routine Discord line')
  })

  test('Actions without a Discord representation stay off the status line', async () => {
    for (const kind of ['settings-save', 'feed-read', 'credential-sign-in']) {
      line.onEvent({
        type: 'action_evidence', action_id: `app-${kind}`, kind,
        target: kind, conflict_key: kind, status: 'accepted', revision: 30,
      })
    }
    await drain()

    assert.equal(posts.length, 0)
    assert.equal(edits.length, 0)
  })

  test('the lifecycle receipt is the status line last edit and keeps final meters', async () => {
    meters = { effort: 'high', ctxPct: 63, windows: [{ label: '5h', pct: 72, elapsedPct: 50 }] }
    line.onEvent({ type: 'agent_ready', agent: 'curia-690', ticket: '690', model: 'gpt', ts: 'T' })
    await drain()

    line.onEvent({
      type: 'lifecycle_closed', agent: 'curia-690', ticket: '690',
      receipt: '✅ resolved - ticket closed · map #685 updated · code merged · session `curia-690` closed, worktree removed',
    })
    await drain()

    assert.equal(posts.length, 1)
    assert.equal(removals.length, 0, 'the receipt never deletes the status message')
    assert.match(edits.at(-1).text, /^-# ✅ resolved - ticket closed/)
    assert.match(edits.at(-1).text, /\n-# \*\*gpt\*\* high.*ctx 63%.*5h/)
    assert.equal(edits.at(-1).opts.settled, true)
    assert.equal(line.stateOf('curia-690'), null, 'the settled session no longer refreshes')
  })

  test('a lifecycle first seen after restart still posts its receipt', async () => {
    line.onEvent({
      type: 'lifecycle_closed', agent: 'curia-42', ticket: '42',
      receipt: '✅ resolved - ticket closed',
    })
    await drain()

    assert.equal(posts.length, 1)
    assert.equal(posts[0].ticket, '42')
    assert.equal(posts[0].text, '-# ✅ resolved - ticket closed')
    assert.equal(posts[0].opts.settled, true)
  })

  test('a cross-check reviewer does not create a second status line', async () => {
    line.onEvent({
      type: 'agent_spawned', agent: 'curia-review-42', ticket: '42',
      model: 'sonnet', kind: 'reviewer',
    })
    line.onEvent({
      type: 'agent_ready', agent: 'curia-review-42', ticket: '42', model: 'sonnet',
    })
    await drain()

    assert.equal(posts.length, 0)
  })

  test('every state change repositions: delete + repost at the bottom (#108 item 17)', async () => {
    line.onEvent({ type: 'agent_spawned', agent: 'curia-9', ticket: '9', model: 'opus' })
    line.onEvent({ type: 'agent_ready', agent: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    records.set('esc-1', { id: 'esc-1', agent: 'curia-9', ticket: '9', kind: 'choice' })
    line.onEvent({ type: 'esc_open', id: 'esc-1', agent: 'curia-9', ticket: '9', kind: 'choice', prompt: 'Which shade of blue?\nlong body', ts: new Date().toISOString() })
    line.onEvent({ type: 'esc_answer', id: 'esc-1', answer: 'navy' })
    records.set('esc-2', { id: 'esc-2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND })
    line.onEvent({ type: 'esc_open', id: 'esc-2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, prompt: 'done?', ts: new Date().toISOString() })
    line.onEvent({ type: 'esc_answer', id: 'esc-2', answer: 'approve' })
    line.onEvent({ type: 'result', agent: 'curia-9', ticket: '9', status: 'resolved' })
    line.onEvent({ type: 'lifecycle_closed', agent: 'curia-9', ticket: '9' })
    line.onEvent({ type: 'thread_settled', agent: 'curia-9', ticket: '9', receipt: '✅ alp82/curia#9 resolved. Ticket closed.' })
    await drain()

    const texts = posts.map((p) => p.text)
    assert.equal(posts.length, 7, 'one post per LIVE state change')
    assert.match(texts[0], /dispatched on \*\*opus\*\*/)
    assert.equal(texts[1], `-# 🧭 \`reads the ticket\`${GROUP_SEP}**opus**`, 'working is the phase, label, and meters')
    assert.match(texts[2], /waiting on \*\*\[esc-1\]\*\* — Which shade of blue\?/)
    assert.match(texts[3], /^-# 🧭 `reads the ticket`/)
    assert.match(texts[4], /awaiting review — \*\*\[esc-2\]\*\*/)
    assert.match(texts[5], /executing approved writes/)
    assert.match(texts[6], /result received \(\*\*resolved\*\*\)/)
    assert.deepEqual(removals, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
      'settlement keeps the final live message and edits it in place')
    assert.equal(edits.length, 1)
    assert.match(edits[0].text, /^-# ✅ alp82\/curia#9 resolved/)
    assert.match(edits[0].text, /\n-# \*\*opus\*\*$/, 'the final meter reading stays with the receipt')
    assert.ok(!texts.some((t) => t.includes('🏁')), 'no line ever says done')
  })

  test('an accepted phase replaces routine progress in place', async () => {
    line.onEvent({ type: 'agent_ready', agent: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    await drain()
    line.onEvent({
      type: 'agent_phase', agent: 'curia-9', ticket: '9',
      phase: { icon: '🧭', label: 'reads the call sites' },
    })
    await drain()

    assert.equal(posts.length, 1, 'routine progress doesn\'t add a thread message')
    assert.equal(edits.length, 1, 'the existing status line changes in place')
    assert.match(edits[0].text, /^🧭 `reads the call sites`/)
  })

  test('an invalid phase keeps the prior status', async () => {
    line.onEvent({ type: 'agent_ready', agent: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    await drain()
    line.onEvent({
      type: 'agent_phase', agent: 'curia-9', ticket: '9',
      phase: { icon: '🧭', label: 'this label is more than twenty characters' },
    })
    await drain()

    assert.equal(edits.length, 0)
    assert.equal(posts.length, 1)
  })

  // #253, ADR-0013: the ending used to speak four times in twenty seconds, and
  // this line was one of the four. Every terminal event now retires it.
  describe('a terminal event retires the line (#253)', () => {
    for (const ev of [
      { type: 'lifecycle_closed', agent: 'curia-4', ticket: '4', kind: 'reviewer' },
      { type: 'agent_abnormal_exit', agent: 'curia-4', ticket: '4' },
      { type: 'reviewer_abnormal_exit', agent: 'curia-4', ticket: '4' },
      { type: 'agent_died', agent: 'curia-4', ticket: '4' },
      { type: 'agent_cancelled', agent: 'curia-4', ticket: '4' },
      { type: 'agent_ready_timeout', agent: 'curia-4', ticket: '4', timeout_s: 45 },
      { type: 'agent_exited_early', agent: 'curia-4', ticket: '4', status: 127 },
    ]) {
      test(ev.type, async () => {
        line.onEvent({ type: 'agent_ready', agent: 'curia-4', ticket: '4', model: 'opus', ts: 'T' })
        line.onEvent(ev)
        await drain()
        assert.equal(posts.length, 1, 'the live line, and nothing after it')
        assert.deepEqual(removals, ['m1'], 'the live line is deleted, not overwritten')
        assert.equal(line.stateOf('curia-4'), null, 'the session is forgotten')
      })
    }
  })

  // #391: the press is read off the button, and the approval that follows it can
  // fail. A line left saying "executing approved writes" would state a merge
  // nobody may make, on a ticket the operator has to look at again.
  test('a press whose approval curia could not post stops reading as executing', async () => {
    line.onEvent({ type: 'agent_ready', agent: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    records.set('esc-2', { id: 'esc-2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND })
    line.onEvent({ type: 'esc_open', id: 'esc-2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, prompt: 'done?', ts: new Date().toISOString() })
    line.onEvent({ type: 'esc_answer', id: 'esc-2', answer: 'approve' })
    assert.equal(line.stateOf('curia-9')?.state, 'executing', 'the button alone reads as approved')

    line.onEvent({
      type: 'review_answered', agent: 'curia-9', ticket: '9', approved: false, outcome: 'approval-failed',
    })
    await drain()
    assert.equal(line.stateOf('curia-9')?.state, 'working')
    assert.ok(!posts.at(-1).text.includes('executing approved writes'))
  })

  test('an approval that went through leaves the executing line alone', async () => {
    line.onEvent({ type: 'agent_ready', agent: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    records.set('esc-2', { id: 'esc-2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND })
    line.onEvent({ type: 'esc_open', id: 'esc-2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, prompt: 'done?', ts: new Date().toISOString() })
    line.onEvent({ type: 'esc_answer', id: 'esc-2', answer: 'approve' })
    line.onEvent({ type: 'review_answered', agent: 'curia-9', ticket: '9', approved: true })
    await drain()
    assert.equal(line.stateOf('curia-9')?.state, 'executing')
  })

  test('the tick refreshes the waiting line in place — no reminder message (#108 item 13)', async () => {
    // Since #261 the meter tick is the only thing that moves a parked line. The
    // clock is injected rather than real: the refresh is only worth an edit when
    // a number actually changed (#146), and asserting that needs time to pass on
    // purpose.
    let clock = Date.parse('2026-08-03T12:00:00Z')
    const l = new StatusLine({
      post: async (ticket, text) => { posts.push({ ticket, text }); return { threadId: 't', messageId: 'm1' } },
      edit: async (ids, text) => { edits.push({ ids, text }); return true },
      get: (id) => records.get(id),
      log: () => {},
      now: () => clock,
    })
    const opened = new Date(clock - 45 * 60_000).toISOString()
    records.set('esc-3', { id: 'esc-3', agent: 'curia-4', ticket: '4', kind: 'free-text', status: 'open' })
    l.onEvent({ type: 'esc_open', id: 'esc-3', agent: 'curia-4', ticket: '4', kind: 'free-text', prompt: 'A question', ts: opened })
    clock += 30 * 60_000
    l.refresh()
    await l.settle()
    assert.equal(posts.length, 1)
    assert.equal(edits.length, 1, 'the tick edits, never posts')
    assert.match(edits[0].text, /\[esc-3\].*1 h 15 min/)
  })

  test('the thread flag follows the state and fires only on a real projection change (#199)', async () => {
    const flags = []
    const l = new StatusLine({
      post: async () => ({ threadId: 't', messageId: 'm' }),
      edit: async () => true,
      get: (id) => records.get(id),
      log: () => {},
      flag: (ticket, state) => { flags.push({ ticket, state }) },
    })
    l.onEvent({ type: 'agent_spawned', agent: 'curia-9', ticket: '9', model: 'opus' })
    l.onEvent({ type: 'agent_ready', agent: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    records.set('e1', { id: 'e1', agent: 'curia-9', ticket: '9', kind: 'choice', status: 'open' })
    l.onEvent({ type: 'esc_open', id: 'e1', agent: 'curia-9', ticket: '9', kind: 'choice', prompt: 'q?', ts: new Date().toISOString() })
    l.refresh() // same state — no re-flag
    l.onEvent({ type: 'esc_answer', id: 'e1', answer: 'yes' })
    records.set('e2', { id: 'e2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, status: 'open' })
    l.onEvent({ type: 'esc_open', id: 'e2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, prompt: 'done?', ts: new Date().toISOString() })
    l.onEvent({ type: 'esc_answer', id: 'e2', answer: 'approve' })
    l.onEvent({ type: 'lifecycle_closed', agent: 'curia-9', ticket: '9' })
    await l.settle()
    assert.deepEqual(flags.map((f) => f.state), [
      'working', 'waiting', 'working', 'awaiting-review',
    ], 'ready, tick, and done fire no flag — and the approve→executing tail keeps 🔎, saving the rename slot the ✅ needs')
    assert.ok(flags.every((f) => f.ticket === '9'))
  })

  test('the funnel-into-done states keep the glyph they found — the ✅ slot stays free', async () => {
    const flags = []
    const l = new StatusLine({
      post: async () => ({ threadId: 't', messageId: 'm' }),
      edit: async () => true,
      get: (id) => records.get(id),
      log: () => {},
      flag: (ticket, state) => { flags.push(state) },
    })
    l.onEvent({ type: 'agent_ready', agent: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    records.set('e1', { id: 'e1', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, status: 'open' })
    l.onEvent({ type: 'esc_open', id: 'e1', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, prompt: 'done?', ts: new Date().toISOString() })
    l.onEvent({ type: 'esc_answer', id: 'e1', answer: 'cross-check' })
    l.onEvent({ type: 'cross_check_requested', agent: 'curia-9', ticket: '9', ts: 'T' })
    l.onEvent({ type: 'result', agent: 'curia-9', ticket: '9', status: 'resolved' })
    l.onEvent({ type: 'lifecycle_closed', agent: 'curia-9', ticket: '9' })
    await l.settle()
    assert.deepEqual(flags, ['working', 'awaiting-review'],
      'cross-checking and resolving fire no clear — the 🔎 stands until release swaps it for ✅')
  })

  test('a cross-check that sends the builder back to work still clears the 🔎', async () => {
    const flags = []
    const l = new StatusLine({
      post: async () => ({ threadId: 't', messageId: 'm' }),
      edit: async () => true,
      get: (id) => records.get(id),
      log: () => {},
      flag: (ticket, state) => { flags.push(state) },
    })
    records.set('e1', { id: 'e1', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, status: 'open' })
    l.onEvent({ type: 'esc_open', id: 'e1', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, prompt: 'done?', ts: new Date().toISOString() })
    l.onEvent({ type: 'cross_check_requested', agent: 'curia-9', ticket: '9', ts: 'T' })
    l.onEvent({ type: 'cross_check_returned', agent: 'curia-9', ticket: '9' })
    await l.settle()
    assert.deepEqual(flags, ['awaiting-review', 'working'],
      'resumed work is a real projection change — only the short tail into done keeps the glyph')
  })

  test('a dead agent keeps its last flag — a kept-answerable question stays flagged (#199)', async () => {
    const flags = []
    const l = new StatusLine({
      post: async () => ({ threadId: 't', messageId: 'm' }),
      edit: async () => true,
      get: (id) => records.get(id),
      log: () => {},
      flag: (ticket, state) => { flags.push(state) },
    })
    records.set('e1', { id: 'e1', agent: 'curia-9', ticket: '9', kind: 'choice', status: 'open' })
    l.onEvent({ type: 'esc_open', id: 'e1', agent: 'curia-9', ticket: '9', kind: 'choice', prompt: 'q?', ts: new Date().toISOString() })
    l.onEvent({ type: 'agent_died', agent: 'curia-9', ticket: '9' })
    await l.settle()
    assert.deepEqual(flags, ['waiting'], 'gone is not a projection — the ⏳ stands until an answer or a release')
  })

  test('a confirm is the overseer talking — the agent line ignores it', async () => {
    records.set('esc-5', { id: 'esc-5', agent: 'overseer', kind: CONFIRM_KIND })
    line.onEvent({ type: 'esc_open', id: 'esc-5', agent: 'overseer', ticket: '9', kind: CONFIRM_KIND, prompt: 'cancel all?', ts: 'T' })
    line.onEvent({ type: 'esc_answer', id: 'esc-5', answer: 'approve' })
    await drain()
    assert.equal(posts.length, 0)
    assert.equal(edits.length, 0)
  })

  // #169 put WHICH failure it was on this line. #253 moved that sentence to
  // the one place that already said it — the watchdog's own notify, which
  // names the harness, the status and the pane. The line only steps aside.
  test('a watchdog failure retires the line and reposts nothing', async () => {
    line.onEvent({ type: 'agent_spawned', agent: 'curia-8', ticket: '8', model: 'opus' })
    line.onEvent({ type: 'agent_ready_timeout', agent: 'curia-8', ticket: '8', timeout_s: 45 })
    line.onEvent({ type: 'agent_spawned', agent: 'curia-6', ticket: '6', model: 'gpt' })
    line.onEvent({ type: 'agent_exited_early', agent: 'curia-6', ticket: '6', status: 127 })
    await drain()

    assert.equal(posts.length, 2, 'one dispatched line each, and nothing after')
    assert.deepEqual(removals.sort(), ['m1', 'm2'])
  })

  test('a gone message reposts instead of losing the line', async () => {
    let alive = true
    const l2 = new StatusLine({
      post: async (ticket, text) => { posts.push({ ticket, text }); return { threadId: 't', messageId: `m${posts.length}` } },
      edit: async () => alive,
      get: (id) => records.get(id),
      log: () => {},
    })
    l2.onEvent({ type: 'agent_spawned', agent: 'curia-7', ticket: '7', model: 'opus' })
    await l2.settle()
    alive = false
    l2.onEvent({ type: 'agent_ready', agent: 'curia-7', ticket: '7', model: 'opus', ts: 'T' })
    await l2.settle()
    assert.equal(posts.length, 2, 'the dead message is replaced by a fresh post')
    assert.match(posts[1].text, /^-# 🧭 `reads the ticket`/)
  })

  // #240, observed live: curia-98 opened esc-133 (question 1 of 3 on a
  // prototype ticket), the turn ended parked in the ask, the Stop hook fired,
  // and the thread said 🏁 done under the unanswered question. The hook is a
  // receipt of a TURN ending, not of the agent finishing.
  test('a Stop-hook receipt while a question is open leaves the ⏳ line standing (#240)', async () => {
    line.onEvent({ type: 'agent_ready', agent: 'curia-98', ticket: '98', model: 'opus', ts: 'T' })
    records.set('esc-133', { id: 'esc-133', agent: 'curia-98', ticket: '98', kind: 'choice', prompt: 'question 1 of 3: which entry?', opened_at: new Date().toISOString(), status: 'open' })
    line.onEvent({ type: 'esc_open', id: 'esc-133', agent: 'curia-98', ticket: '98', kind: 'choice', prompt: 'question 1 of 3: which entry?', ts: new Date().toISOString() })
    line.onEvent({ type: 'agent_done', agent: 'curia-98', hook_event: 'Stop', stop_hook_active: false })
    line.onEvent({ type: 'agent_blocked_on_human', agent: 'curia-98', ticket: '98', escalations: ['esc-133'], awaiting_review: false, cross_check: false, ts: new Date().toISOString() })
    await drain()
    assert.match(posts.at(-1).text, /⏳ .*waiting on \*\*\[esc-133\]\*\*/)
    assert.ok(posts.every((p) => !p.text.includes('🏁')), 'no post ever said done')
  })

  test('a parked line redraws from agent_blocked_on_human alone — the restart case (#240)', async () => {
    // No esc_open was seen live: the daemon restarted after the question
    // opened, and the turn end is the first event about this session.
    records.set('esc-7', { id: 'esc-7', agent: 'curia-5', ticket: '5', kind: 'choice', prompt: 'still here?', opened_at: new Date().toISOString(), status: 'open' })
    line.onEvent({ type: 'agent_blocked_on_human', agent: 'curia-5', ticket: '5', escalations: ['esc-7'], awaiting_review: false, cross_check: false, ts: new Date().toISOString() })
    await drain()
    assert.equal(posts.length, 1)
    assert.match(posts[0].text, /⏳ .*waiting on \*\*\[esc-7\]\*\* — still here\?/)
  })

  test('a respawn after an ending draws a fresh line at the bottom', async () => {
    line.onEvent({ type: 'agent_spawned', agent: 'curia-2', ticket: '2', model: 'opus' })
    line.onEvent({ type: 'lifecycle_closed', agent: 'curia-2', ticket: '2' })
    line.onEvent({ type: 'thread_settled', agent: 'curia-2', ticket: '2', receipt: '✅ resolved' })
    line.onEvent({ type: 'agent_spawned', agent: 'curia-2', ticket: '2', model: 'sonnet' })
    await drain()
    assert.equal(posts.length, 2)
    assert.match(posts[1].text, /dispatched on \*\*sonnet\*\*/)
    assert.deepEqual(removals, [], 'the settled receipt stays in the thread')
  })

  test('a result event never steers the line out of the thread it is already in (#202)', async () => {
    // The ticket on a `result` line used to be whatever the agent typed, and
    // the journal is append-only, so an old line still says `owner/repo#164`.
    // The spawn binding this line already tracks is the authority.
    line.onEvent({ type: 'agent_spawned', agent: 'curia-9', ticket: '9', model: 'opus' })
    line.onEvent({ type: 'result', agent: 'curia-9', ticket: 'alp82/curia#164', status: 'resolved' })
    await drain()
    assert.equal(posts.at(-1).ticket, '9', 'the resolving line posts under the BOUND ticket')
    assert.match(posts.at(-1).text, /result received \(\*\*resolved\*\*\)/)
  })

  test('a result for a session first seen after a restart still posts (#202)', async () => {
    // The Map dies with the process, so this line never saw the spawn. The
    // event is all there is, and a line under it beats no line at all.
    line.onEvent({ type: 'result', agent: 'curia-9', ticket: '9', status: 'blocked' })
    await drain()
    assert.equal(posts.at(-1).ticket, '9')
  })

  test('a bridge that is down loses nothing: the next transition posts', async () => {
    let up = false
    const l3 = new StatusLine({
      post: async (ticket, text) => {
        if (!up) return null
        posts.push({ ticket, text })
        return { threadId: 't', messageId: 'm1' }
      },
      edit: async () => false,
      get: () => null,
      log: () => {},
    })
    l3.onEvent({ type: 'agent_spawned', agent: 'curia-3', ticket: '3', model: 'opus' })
    await Promise.all([...l3.agents.values()].map((w) => w.chain))
    assert.equal(posts.length, 0)
    up = true
    l3.onEvent({ type: 'agent_ready', agent: 'curia-3', ticket: '3', model: 'opus', ts: 'T' })
    await Promise.all([...l3.agents.values()].map((w) => w.chain))
    assert.equal(posts.length, 1)
  })

  test('the meters ride the line: model, effort, context %, and both paced bars (#146)', async () => {
    // 62% spent with 30% of the window gone is overshoot — 🟥, and the cells
    // past the ┃ render solid. 41% spent with 76% gone is credit in hand — 🟩.
    meters = {
      effort: 'high',
      ctxPct: 41,
      windows: [{ label: '5h', pct: 62, elapsedPct: 30 }, { label: '7d', pct: 41, elapsedPct: 76 }],
    }
    line.onEvent({ type: 'agent_spawned', agent: 'curia-138', ticket: '138', model: 'gpt' })
    line.onEvent({ type: 'agent_ready', agent: 'curia-138', ticket: '138', model: 'gpt', ts: 'T' })
    await drain()
    assert.equal(
      posts.at(-1).text,
      ['-# 🧭 `reads the ticket`', '**gpt** high', 'ctx 41%',
        '**5h** 🟥 ▓▓▓┃███░░░░ 62%', '**7d** 🟩 ▓▓▓▓░░░░┃░░ 41%'].join(GROUP_SEP),
    )
    // dispatched already names the model in its own sentence — it must not
    // arrive twice on one line.
    assert.equal(posts[0].text.match(/gpt/g).length, 1)
  })

  test('a meter with no source drops itself, never the line', async () => {
    meters = { effort: null, ctxPct: null, windows: null }
    line.onEvent({ type: 'agent_spawned', agent: 'curia-5', ticket: '5', model: 'opus' })
    line.onEvent({ type: 'agent_ready', agent: 'curia-5', ticket: '5', model: 'opus', ts: 'T' })
    await drain()
    assert.equal(posts.at(-1).text, `-# 🧭 \`reads the ticket\`${GROUP_SEP}**opus**`)
  })

  test('a meter source that throws costs the meters, not the status line', async () => {
    const l = new StatusLine({
      post: async (ticket, text) => { posts.push({ ticket, text }); return { threadId: 't', messageId: 'm' } },
      edit: async () => true,
      get: () => null,
      log: () => {},
      meters: () => { throw new Error('transcript vanished') },
    })
    l.onEvent({ type: 'agent_ready', agent: 'curia-6', ticket: '6', model: 'opus', ts: 'T' })
    await l.settle()
    assert.equal(posts.at(-1).text, '-# 🧭 `reads the ticket`')
  })

  test('the base sentence names the MODEL the meters state, not the routing label (#179)', async () => {
    // The codex harness's fault: the label is `gpt` and the model is
    // `gpt-5.6-sol`. The dispatched sentence and the meter run are one line, so
    // both take their name from the same place — and the name arrives once.
    const l = new StatusLine({
      post: async (ticket, text) => { posts.push({ ticket, text }); return { threadId: 't', messageId: 'm' } },
      edit: async () => true,
      get: () => null,
      log: () => {},
      meters: () => ({ model: 'gpt-5.6-sol', effort: 'high', ctxPct: 12, windows: null }),
    })
    l.onEvent({ type: 'agent_spawned', agent: 'curia-4', ticket: '4', model: 'gpt' })
    await l.settle()
    const dispatched = posts.at(-1).text
    assert.match(dispatched, /dispatched on \*\*gpt-5\.6-sol\*\*/)
    assert.equal(dispatched.match(/gpt-5\.6-sol/g).length, 1, 'the model arrives once')
    assert.ok(!dispatched.includes('**gpt**'), 'the routing label never stands in for it')

    l.onEvent({ type: 'agent_ready', agent: 'curia-4', ticket: '4', model: 'gpt', ts: 'T' })
    await l.settle()
    assert.equal(posts.at(-1).text, `-# 🧭 \`reads the ticket\`${GROUP_SEP}**gpt-5.6-sol** high${GROUP_SEP}ctx 12%`)
  })

  test('the escalation title yields columns to the model, never the other way round (#179)', async () => {
    // #146 appended meters to a finished base and stopped at the first one too
    // wide, so a full-length title pushed the model — first in value order —
    // off the line, and every meter behind it too. The line then said nothing
    // at all about the model. Now the title takes the cut instead.
    //
    // #480 took the session label out of the base, so a full-length title plus
    // a normal model name now fit together and no cut fires. A wide model name
    // drives the yield directly instead — the same trade, further along.
    const MODEL = 'sol-ultra-'.repeat(4)
    const l = new StatusLine({
      post: async (ticket, text) => { posts.push({ ticket, text }); return { threadId: 't', messageId: 'm' } },
      edit: async () => true,
      get: (id) => records.get(id),
      log: () => {},
      meters: () => ({
        model: MODEL,
        effort: null,
        ctxPct: 41,
        windows: [{ label: '5h', pct: 62, elapsedPct: 30 }, { label: '7d', pct: 41, elapsedPct: 76 }],
      }),
    })
    const title = 'Which of these seven candidate shades of blue should the launch banner use'
    records.set('esc-9', { id: 'esc-9', agent: 'curia-8', ticket: '8', kind: 'choice' })
    l.onEvent({ type: 'esc_open', id: 'esc-9', agent: 'curia-8', ticket: '8', kind: 'choice', prompt: title, ts: new Date().toISOString() })
    await l.settle()
    const text = posts.at(-1).text
    assert.ok(visibleWidth(text) <= LINE_BUDGET, `${visibleWidth(text)} columns is over the ${LINE_BUDGET} budget`)
    assert.ok(text.includes(`**${MODEL}**`), 'the model survives the longest title there is')
    assert.ok(text.includes('Which of these seven candidate shades'), 'and the title still reads as one')
    assert.ok(text.includes('…'), 'it paid for the model in its own tail')
    assert.ok(!text.includes('5h') && !text.includes('7d'), 'the bars still go — a blocked agent burns no quota')
  })

  test('a title that cannot reach the floor is left whole and the meter drops (#179)', async () => {
    // The trade has a bottom. Below TITLE_FLOOR a title stops being a title, so
    // a base with no columns to spare keeps its words and loses the meter —
    // which is #146's behaviour, held as the floor case rather than the rule.
    //
    // No model name is 85 columns wide, and with a title capped at 80 no real
    // line reaches this floor today. The guard is for the day LINE_BUDGET drops
    // or a meter grows, so the probe drives it directly.
    const WIDE = 'wide-'.repeat(17)
    const l = new StatusLine({
      post: async (ticket, text) => { posts.push({ ticket, text }); return { threadId: 't', messageId: 'm' } },
      edit: async () => true,
      get: (id) => records.get(id),
      log: () => {},
      meters: () => ({ model: WIDE, effort: null, ctxPct: null, windows: null }),
    })
    const title = 'Which of these seven candidate shades of blue should the launch banner use'
    records.set('esc-7', { id: 'esc-7', agent: 'curia-7', ticket: '7', kind: 'choice' })
    l.onEvent({ type: 'esc_open', id: 'esc-7', agent: 'curia-7', ticket: '7', kind: 'choice', prompt: title, ts: 'T' })
    await l.settle()
    const text = posts.at(-1).text
    assert.ok(text.includes(title), 'the title survives whole')
    assert.ok(!text.includes(WIDE), 'and the meter is what goes')
    assert.ok(visibleWidth(text) <= LINE_BUDGET, `${visibleWidth(text)} columns is over the ${LINE_BUDGET} budget`)
  })

  test('the meters degrade one at a time, tail first, as the base grows', async () => {
    meters = {
      effort: null,
      ctxPct: 41,
      windows: [{ label: '5h', pct: 62, elapsedPct: 30 }, { label: '7d', pct: 41, elapsedPct: 76 }],
    }
    const ask = async (n, title) => {
      records.set(`esc-${n}`, { id: `esc-${n}`, agent: `curia-${n}`, ticket: `${n}`, kind: 'choice' })
      line.onEvent({ type: 'agent_spawned', agent: `curia-${n}`, ticket: `${n}`, model: 'gpt' })
      line.onEvent({ type: 'esc_open', id: `esc-${n}`, agent: `curia-${n}`, ticket: `${n}`, kind: 'choice', prompt: title, ts: 'T' })
      await drain()
      return posts.at(-1).text
    }
    // No `ts` the clock can read, so no elapsed label — the title is the only
    // thing growing across these. Asserting the PROPERTY rather than the exact
    // drop points: where each meter falls off depends on the budget and on the
    // width of a bar, and both are free to change.
    const ORDER = ['**gpt**', 'ctx 41%', '5h', '7d']
    const kept = []
    for (let i = 0; i < 8; i += 1) {
      const text = await ask(i + 1, `Which blue${' candidate shades'.repeat(i)}`)
      assert.ok(visibleWidth(text) <= LINE_BUDGET, `${visibleWidth(text)} columns is over the ${LINE_BUDGET} budget`)
      const survivors = ORDER.filter((m) => text.includes(m))
      // Whatever survives is always a PREFIX of the value order: meters drop
      // from the tail, never out of the middle.
      assert.deepEqual(survivors, ORDER.slice(0, survivors.length), `dropped out of order: ${text}`)
      kept.push(survivors.length)
    }
    assert.equal(kept[0], ORDER.length, 'a short title keeps every meter')
    // The model is not one of the things a long title can cost (#179): the
    // title gives up columns for it first. Every step keeps at least the model.
    assert.ok(kept.every((k) => k >= 1), `a step lost the model: ${kept.join(',')}`)
    assert.ok(kept.at(-1) < ORDER.length, 'and a long title does cost meters')
    for (let i = 1; i < kept.length; i += 1) {
      assert.ok(kept[i] <= kept[i - 1], `a longer title kept MORE meters: ${kept.join(',')}`)
    }
  })

  test('the width budget counts rendered columns, not string length', () => {
    // `**` and backticks render to nothing; an emoji renders about two columns.
    // Measuring `.length` would over-count the first and under-count the second,
    // and the budget is a question about columns.
    assert.equal(visibleWidth('**opus**'), 4)
    assert.equal(visibleWidth('`curia-9`'), 7)
    assert.equal(visibleWidth('🟥'), 2)
    assert.equal(visibleWidth('▶️'), 2, 'a variation selector promotes its char to emoji width')
    assert.equal(visibleWidth('-# 🧭 work'), 7, 'the small-print marker renders no columns')
    assert.equal(visibleWidth('▓▓▓┃███░░░░'), 11, 'block glyphs are single width')
  })

  test('the meter tick edits in place, and only when a number moved (#146)', async () => {
    meters = { effort: null, ctxPct: 10, windows: null }
    line.onEvent({ type: 'agent_ready', agent: 'curia-1', ticket: '1', model: 'opus', ts: 'T' })
    await drain()
    assert.equal(posts.length, 1)

    line.refresh() // nothing moved
    await drain()
    assert.equal(edits.length, 0, 'an unchanged line costs no Discord call')

    meters = { effort: null, ctxPct: 63, windows: null }
    line.refresh()
    await drain()
    assert.equal(posts.length, 1, 'the tick never reposts — the line stays where it is')
    assert.equal(edits.length, 1)
    assert.match(edits[0].text, /ctx 63%/)
  })

  test('a finished agent carries no meters — the tick has nothing left to refresh', async () => {
    meters = { effort: null, ctxPct: 41, windows: [{ label: '5h', pct: 62 }] }
    line.onEvent({ type: 'agent_spawned', agent: 'curia-3', ticket: '3', model: 'opus' })
    line.onEvent({ type: 'lifecycle_closed', agent: 'curia-3', ticket: '3' })
    await drain()
    line.refresh()
    await drain()
    assert.equal(posts.length, 1, 'the ending posted nothing of its own')
    assert.equal(edits.length, 0, 'the tick skips an agent whose run is over')
  })

  // #480: any other message into the ticket thread buries the line — a
  // multi-chunk agent send, an escalation card, a receipt. The bridge reports
  // each post and the line moves back to the thread bottom: same text,
  // delete + repost.
  describe('a reported post moves the line back to the bottom (#480)', () => {
    test('the buried line is deleted and reposted with the same text', async () => {
      line.onEvent({ type: 'agent_ready', agent: 'curia-1', ticket: '1', model: 'opus', ts: 'T' })
      await drain()
      assert.equal(posts.length, 1)
      line.bump('1')
      await drain()
      assert.equal(posts.length, 2, 'the bump reposts')
      assert.deepEqual(removals, ['m1'], 'and deletes the buried message first')
      assert.equal(posts[1].text, posts[0].text, 'the text does not change — only the position')
    })

    test('a post under another ticket moves nothing', async () => {
      line.onEvent({ type: 'agent_ready', agent: 'curia-1', ticket: '1', model: 'opus', ts: 'T' })
      await drain()
      line.bump('2')
      await drain()
      assert.equal(posts.length, 1)
      assert.deepEqual(removals, [])
    })

    test('a session with no message yet has nothing to move', async () => {
      // The bridge was down when the state posted — ids stayed null.
      const l = new StatusLine({
        post: async () => null,
        edit: async () => false,
        remove: async (ids) => { removals.push(ids.messageId) },
        get: () => null,
        log: () => {},
      })
      l.onEvent({ type: 'agent_ready', agent: 'curia-1', ticket: '1', model: 'opus', ts: 'T' })
      await l.settle()
      l.bump('1')
      await l.settle()
      assert.deepEqual(removals, [], 'no delete against a message that never existed')
    })

    // The thread binding keys by string; a journal event may carry the number.
    test('the number and the string are one ticket', async () => {
      line.onEvent({ type: 'agent_ready', agent: 'curia-1', ticket: 1, model: 'opus', ts: 'T' })
      await drain()
      line.bump('1')
      await drain()
      assert.equal(posts.length, 2, 'the string report moves the line the number drew')
    })

    // A burst is the normal case: a receipt beside a card, a breadcrumb beside
    // a rename. One move puts the line under all of them, and each extra one
    // spends a delete and a post against the rate limit real messages need.
    test('a burst of reports costs one move', async () => {
      line.onEvent({ type: 'agent_ready', agent: 'curia-1', ticket: '1', model: 'opus', ts: 'T' })
      await drain()
      line.bump('1')
      line.bump('1')
      line.bump('1')
      await drain()
      assert.equal(posts.length, 2, 'one repost, not three')
      assert.deepEqual(removals, ['m1'])
    })

    test('a report after the move earns its own move', async () => {
      line.onEvent({ type: 'agent_ready', agent: 'curia-1', ticket: '1', model: 'opus', ts: 'T' })
      await drain()
      line.bump('1')
      await drain()
      line.bump('1')
      await drain()
      assert.equal(posts.length, 3)
      assert.deepEqual(removals, ['m1', 'm2'])
    })
  })

  test('the reduction append hook delivers live events and stays silent on replay', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { Reduction } = await import('../src/reduction.mjs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-statusline-'))
    try {
      const reduction = new Reduction(dir)
      const seen = []
      reduction.onEvent = (ev) => seen.push(ev.type)
      reduction.journal('agent_spawned', { agent: 'curia-1', ticket: '1', model: 'opus' })
      reduction.open({ agent: 'curia-1', ticket: '1', kind: 'free-text', prompt: 'q' })
      assert.deepEqual(seen, ['agent_spawned', 'esc_open'])
      // replay: a rebooted reduction re-announces nothing
      const reborn = new Reduction(dir)
      const replaySeen = []
      reborn.onEvent = (ev) => replaySeen.push(ev.type)
      assert.deepEqual(replaySeen, [])
      assert.equal(reborn.openEscalations().length, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an in-pane model switch redraws the line in place with the new model (#717)', async () => {
    line.onEvent({ type: 'agent_ready', agent: 'curia-544', ticket: '544', model: 'fable', ts: 'T' })
    await drain()
    assert.match(posts[0].text, /\*\*fable\*\*/)

    line.onEvent({ type: 'agent_model_switched', agent: 'curia-544', ticket: '544', model: 'opus', switched_from: 'fable' })
    await drain()

    assert.equal(posts.length, 1, 'the state did not change, so the line stays where it is')
    assert.equal(edits.length, 1)
    assert.match(edits[0].text, /\*\*opus\*\*/)
    assert.doesNotMatch(edits[0].text, /fable/)
    assert.equal(line.stateOf('curia-544').state, 'working')
  })

  test('a switch event for a session this line never saw draws nothing', async () => {
    line.onEvent({ type: 'agent_model_switched', agent: 'curia-9', ticket: '9', model: 'opus' })
    await drain()
    assert.equal(posts.length, 0)
  })

})

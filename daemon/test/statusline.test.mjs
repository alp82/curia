// The per-agent status line (#108 item 8): one message per agent thread
// through daemon-witnessed states. A state CHANGE repositions the line to the
// thread bottom — delete + repost (#108 item 17) — because an edit-in-place
// stays where the line was born, screens above where the operator reads. Only
// the same-state elapsed refresh edits in place. Events are fed straight to
// onEvent — the same records the store's append hook delivers live.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { StatusLine, LINE_BUDGET, GROUP_SEP, visibleWidth } from '../src/statusline.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'
import { CONFIRM_KIND } from '../src/store.mjs'

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
      post: async (ticket, text) => {
        posts.push({ ticket, text })
        return { threadId: 't1', messageId: `m${++n}` }
      },
      edit: async (ids, text) => {
        edits.push({ ids, text })
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

  const drain = () => Promise.all([...line.agents.values()].map((w) => w.chain))

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
    await drain()

    const texts = posts.map((p) => p.text)
    assert.equal(posts.length, 8, 'one post per state change')
    assert.match(texts[0], /dispatched on \*\*opus\*\*/)
    assert.ok(texts[1].includes(`working${GROUP_SEP}**opus**`))
    assert.match(texts[2], /waiting on \*\*\[esc-1\]\*\* — Which shade of blue\?/)
    assert.match(texts[3], /working/)
    assert.match(texts[4], /awaiting review — \*\*\[esc-2\]\*\*/)
    assert.match(texts[5], /executing approved writes/)
    assert.match(texts[6], /result received \(\*\*resolved\*\*\)/)
    assert.match(texts.at(-1), /🏁 .*done/)
    assert.equal(edits.length, 0, 'a state change never edits in place')
    assert.deepEqual(removals, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], 'each repost deletes its predecessor — one live line at any moment')
  })

  test('a nudge refreshes the waiting line in place — no reminder message (#108 item 13)', async () => {
    // A nudge fires every ~30 min, so the elapsed label has always moved by the
    // time it lands. The clock is injected rather than real: the refresh is only
    // worth an edit when a number actually changed (#146), and asserting that
    // needs time to pass on purpose.
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
    l.onEvent({ type: 'esc_nudge', id: 'esc-3' })
    await Promise.all([...l.agents.values()].map((w) => w.chain))
    assert.equal(posts.length, 1)
    assert.equal(edits.length, 1, 'the nudge edits, never posts')
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
    l.onEvent({ type: 'esc_nudge', id: 'e1' }) // same state — no re-flag
    l.onEvent({ type: 'esc_answer', id: 'e1', answer: 'yes' })
    records.set('e2', { id: 'e2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, status: 'open' })
    l.onEvent({ type: 'esc_open', id: 'e2', agent: 'curia-9', ticket: '9', kind: REVIEW_KIND, prompt: 'done?', ts: new Date().toISOString() })
    l.onEvent({ type: 'esc_answer', id: 'e2', answer: 'approve' })
    l.onEvent({ type: 'lifecycle_closed', agent: 'curia-9', ticket: '9' })
    await Promise.all([...l.agents.values()].map((w) => w.chain))
    assert.deepEqual(flags.map((f) => f.state), [
      'working', 'waiting', 'working', 'awaiting-review',
    ], 'ready, nudge, and done fire no flag — and the approve→executing tail keeps 🔎, saving the rename slot the ✅ needs')
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
    await Promise.all([...l.agents.values()].map((w) => w.chain))
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
    await Promise.all([...l.agents.values()].map((w) => w.chain))
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
    await Promise.all([...l.agents.values()].map((w) => w.chain))
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

  // #169: both failures keep the session for inspection, but the operator acts
  // on them differently — a stalled start is worth a look at the pane, a dead
  // command is a broken harness.
  test('a stalled line says WHICH failure it was', async () => {
    line.onEvent({ type: 'agent_spawned', agent: 'curia-8', ticket: '8', model: 'opus' })
    line.onEvent({ type: 'agent_ready_timeout', agent: 'curia-8', ticket: '8', timeout_s: 45 })
    line.onEvent({ type: 'agent_spawned', agent: 'curia-6', ticket: '6', model: 'gpt' })
    line.onEvent({ type: 'agent_exited_early', agent: 'curia-6', ticket: '6', status: 127 })
    await drain()

    const last = (session) => posts.filter((p) => p.text.includes(session)).at(-1).text
    assert.match(last('curia-8'), /never reached a composer/)
    assert.match(last('curia-6'), /the harness command exited \(status 127\)/)
    assert.match(last('curia-6'), /kept for inspection/)
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
    await Promise.all([...l2.agents.values()].map((w) => w.chain))
    alive = false
    l2.onEvent({ type: 'agent_ready', agent: 'curia-7', ticket: '7', model: 'opus', ts: 'T' })
    await Promise.all([...l2.agents.values()].map((w) => w.chain))
    assert.equal(posts.length, 2, 'the dead message is replaced by a fresh post')
    assert.match(posts[1].text, /working/)
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

  test('an abnormal exit says so — never 🏁 (#240)', async () => {
    line.onEvent({ type: 'agent_ready', agent: 'curia-4', ticket: '4', model: 'opus', ts: 'T' })
    line.onEvent({ type: 'agent_abnormal_exit', agent: 'curia-4', ticket: '4' })
    await drain()
    assert.match(posts.at(-1).text, /⚠️ .*stopped without a result — session kept for post-mortem/)
  })

  test('a respawn after done starts a fresh message; the 🏁 line stands as history', async () => {
    line.onEvent({ type: 'agent_spawned', agent: 'curia-2', ticket: '2', model: 'opus' })
    line.onEvent({ type: 'lifecycle_closed', agent: 'curia-2', ticket: '2' })
    line.onEvent({ type: 'agent_spawned', agent: 'curia-2', ticket: '2', model: 'sonnet' })
    await drain()
    assert.equal(posts.length, 3)
    assert.match(posts[1].text, /🏁 .*done/)
    assert.match(posts[2].text, /dispatched on \*\*sonnet\*\*/)
    assert.ok(!removals.includes('m2'), 'the done line of the finished run is never deleted')
  })

  test('agent_died flips a working line to ⚰️ gone with the resume verb (#138, #108 item 20)', async () => {
    line.onEvent({ type: 'agent_spawned', agent: 'curia-9', ticket: '9', model: 'opus' })
    line.onEvent({ type: 'agent_ready', agent: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    line.onEvent({ type: 'agent_died', agent: 'curia-9', ticket: '9', repo: 'o/r' })
    await drain()
    assert.equal(posts.at(-1).text, `⚰️ \`curia-9\`${GROUP_SEP}agent gone — \`resume 9\``)
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
      ['▶️ `curia-138`', 'working', '**gpt** high', 'ctx 41%',
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
    assert.equal(posts.at(-1).text, `▶️ \`curia-5\`${GROUP_SEP}working${GROUP_SEP}**opus**`)
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
    await Promise.all([...l.agents.values()].map((w) => w.chain))
    assert.equal(posts.at(-1).text, `▶️ \`curia-6\`${GROUP_SEP}working`)
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
    await Promise.all([...l.agents.values()].map((w) => w.chain))
    const dispatched = posts.at(-1).text
    assert.match(dispatched, /dispatched on \*\*gpt-5\.6-sol\*\*/)
    assert.equal(dispatched.match(/gpt-5\.6-sol/g).length, 1, 'the model arrives once')
    assert.ok(!dispatched.includes('**gpt**'), 'the routing label never stands in for it')

    l.onEvent({ type: 'agent_ready', agent: 'curia-4', ticket: '4', model: 'gpt', ts: 'T' })
    await Promise.all([...l.agents.values()].map((w) => w.chain))
    assert.equal(posts.at(-1).text, `▶️ \`curia-4\`${GROUP_SEP}working${GROUP_SEP}**gpt-5.6-sol** high${GROUP_SEP}ctx 12%`)
  })

  test('the escalation title yields columns to the model, never the other way round (#179)', async () => {
    // #146 appended meters to a finished base and stopped at the first one too
    // wide, so a full-length title pushed the model — first in value order —
    // off the line, and every meter behind it too. The line then said nothing
    // at all about the model. Now the title takes the cut instead.
    meters = {
      effort: 'high',
      ctxPct: 41,
      windows: [{ label: '5h', pct: 62, elapsedPct: 30 }, { label: '7d', pct: 41, elapsedPct: 76 }],
    }
    const title = 'Which of these seven candidate shades of blue should the launch banner use'
    records.set('esc-9', { id: 'esc-9', agent: 'curia-8', ticket: '8', kind: 'choice' })
    line.onEvent({ type: 'agent_spawned', agent: 'curia-8', ticket: '8', model: 'gpt' })
    line.onEvent({ type: 'esc_open', id: 'esc-9', agent: 'curia-8', ticket: '8', kind: 'choice', prompt: title, ts: new Date().toISOString() })
    await drain()
    const text = posts.at(-1).text
    assert.ok(visibleWidth(text) <= LINE_BUDGET, `${visibleWidth(text)} columns is over the ${LINE_BUDGET} budget`)
    assert.ok(text.includes('**gpt** high'), 'the model survives the longest title there is')
    assert.ok(text.includes('Which of these seven candidate shades'), 'and the title still reads as one')
    assert.ok(text.includes('…'), 'it paid for the model in its own tail')
    assert.ok(!text.includes('5h') && !text.includes('7d'), 'the bars still go — a blocked agent burns no quota')
  })

  test('a title that cannot reach the floor is left whole and the meter drops (#179)', async () => {
    // The trade has a bottom. Below TITLE_FLOOR a title stops being a title, so
    // a base with no columns to spare keeps its words and loses the meter —
    // which is #146's behaviour, held as the floor case rather than the rule.
    //
    // No model name is 70 columns wide, and with a title capped at 80 no real
    // line reaches this floor today. The guard is for the day LINE_BUDGET drops
    // or a meter grows, so the probe drives it directly.
    const WIDE = 'wide-'.repeat(14)
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
    await Promise.all([...l.agents.values()].map((w) => w.chain))
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

  test('a finished or dead agent carries no meters', async () => {
    meters = { effort: null, ctxPct: 41, windows: [{ label: '5h', pct: 62 }] }
    line.onEvent({ type: 'agent_spawned', agent: 'curia-3', ticket: '3', model: 'opus' })
    line.onEvent({ type: 'agent_died', agent: 'curia-3', ticket: '3' })
    line.onEvent({ type: 'lifecycle_closed', agent: 'curia-3', ticket: '3' })
    await drain()
    assert.ok(!posts.at(-2).text.includes('ctx'))
    assert.ok(!posts.at(-1).text.includes('ctx'))
    line.refresh()
    await drain()
    assert.equal(edits.length, 0, 'the tick skips an agent whose run is over')
  })

  test('the store append hook delivers live events and stays silent on replay', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { EscalationStore } = await import('../src/store.mjs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-statusline-'))
    try {
      const store = new EscalationStore(dir)
      const seen = []
      store.onEvent = (ev) => seen.push(ev.type)
      store.logEvent('agent_spawned', { agent: 'curia-1', ticket: '1', model: 'opus' })
      store.open({ agent: 'curia-1', ticket: '1', kind: 'free-text', prompt: 'q' })
      assert.deepEqual(seen, ['agent_spawned', 'esc_open'])
      // replay: a rebooted store re-announces nothing
      const reborn = new EscalationStore(dir)
      const replaySeen = []
      reborn.onEvent = (ev) => replaySeen.push(ev.type)
      assert.deepEqual(replaySeen, [])
      assert.equal(reborn.openEscalations().length, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

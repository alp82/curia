// The per-worker status line (#108 item 8): one message per worker thread
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
      meters: (session, model) => ({ model, ...meters }),
    })
  })

  const drain = () => Promise.all([...line.workers.values()].map((w) => w.chain))

  test('every state change repositions: delete + repost at the bottom (#108 item 17)', async () => {
    line.onEvent({ type: 'worker_spawned', worker: 'curia-9', ticket: '9', model: 'opus' })
    line.onEvent({ type: 'worker_ready', worker: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    records.set('esc-1', { id: 'esc-1', worker: 'curia-9', ticket: '9', kind: 'choice' })
    line.onEvent({ type: 'esc_open', id: 'esc-1', worker: 'curia-9', ticket: '9', kind: 'choice', prompt: 'Which shade of blue?\nlong body', ts: new Date().toISOString() })
    line.onEvent({ type: 'esc_answer', id: 'esc-1', answer: 'navy' })
    records.set('esc-2', { id: 'esc-2', worker: 'curia-9', ticket: '9', kind: REVIEW_KIND })
    line.onEvent({ type: 'esc_open', id: 'esc-2', worker: 'curia-9', ticket: '9', kind: REVIEW_KIND, prompt: 'done?', ts: new Date().toISOString() })
    line.onEvent({ type: 'esc_answer', id: 'esc-2', answer: 'approve' })
    line.onEvent({ type: 'result', worker: 'curia-9', ticket: '9', status: 'resolved' })
    line.onEvent({ type: 'worker_done', worker: 'curia-9' })
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
    records.set('esc-3', { id: 'esc-3', worker: 'curia-4', ticket: '4', kind: 'free-text', status: 'open' })
    l.onEvent({ type: 'esc_open', id: 'esc-3', worker: 'curia-4', ticket: '4', kind: 'free-text', prompt: 'A question', ts: opened })
    clock += 30 * 60_000
    l.onEvent({ type: 'esc_nudge', id: 'esc-3' })
    await Promise.all([...l.workers.values()].map((w) => w.chain))
    assert.equal(posts.length, 1)
    assert.equal(edits.length, 1, 'the nudge edits, never posts')
    assert.match(edits[0].text, /\[esc-3\].*1 h 15 min/)
  })

  test('a confirm is the overseer talking — the worker line ignores it', async () => {
    records.set('esc-5', { id: 'esc-5', worker: 'overseer', kind: CONFIRM_KIND })
    line.onEvent({ type: 'esc_open', id: 'esc-5', worker: 'overseer', ticket: '9', kind: CONFIRM_KIND, prompt: 'cancel all?', ts: 'T' })
    line.onEvent({ type: 'esc_answer', id: 'esc-5', answer: 'approve' })
    await drain()
    assert.equal(posts.length, 0)
    assert.equal(edits.length, 0)
  })

  // #169: both failures keep the session for inspection, but the operator acts
  // on them differently — a stalled start is worth a look at the pane, a dead
  // command is a broken lane.
  test('a stalled line says WHICH failure it was', async () => {
    line.onEvent({ type: 'worker_spawned', worker: 'curia-8', ticket: '8', model: 'opus' })
    line.onEvent({ type: 'worker_ready_timeout', worker: 'curia-8', ticket: '8', timeout_s: 45 })
    line.onEvent({ type: 'worker_spawned', worker: 'curia-6', ticket: '6', model: 'gpt' })
    line.onEvent({ type: 'worker_exited_early', worker: 'curia-6', ticket: '6', status: 127 })
    await drain()

    const last = (session) => posts.filter((p) => p.text.includes(session)).at(-1).text
    assert.match(last('curia-8'), /never reached a composer/)
    assert.match(last('curia-6'), /the backend command exited \(status 127\)/)
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
    l2.onEvent({ type: 'worker_spawned', worker: 'curia-7', ticket: '7', model: 'opus' })
    await Promise.all([...l2.workers.values()].map((w) => w.chain))
    alive = false
    l2.onEvent({ type: 'worker_ready', worker: 'curia-7', ticket: '7', model: 'opus', ts: 'T' })
    await Promise.all([...l2.workers.values()].map((w) => w.chain))
    assert.equal(posts.length, 2, 'the dead message is replaced by a fresh post')
    assert.match(posts[1].text, /working/)
  })

  test('a respawn after done starts a fresh message; the 🏁 line stands as history', async () => {
    line.onEvent({ type: 'worker_spawned', worker: 'curia-2', ticket: '2', model: 'opus' })
    line.onEvent({ type: 'worker_done', worker: 'curia-2' })
    line.onEvent({ type: 'worker_spawned', worker: 'curia-2', ticket: '2', model: 'sonnet' })
    await drain()
    assert.equal(posts.length, 3)
    assert.match(posts[1].text, /🏁 .*done/)
    assert.match(posts[2].text, /dispatched on \*\*sonnet\*\*/)
    assert.ok(!removals.includes('m2'), 'the done line of the finished run is never deleted')
  })

  test('worker_died flips a working line to ⚰️ gone with the resume verb (#138, #108 item 20)', async () => {
    line.onEvent({ type: 'worker_spawned', worker: 'curia-9', ticket: '9', model: 'opus' })
    line.onEvent({ type: 'worker_ready', worker: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    line.onEvent({ type: 'worker_died', worker: 'curia-9', ticket: '9', repo: 'o/r' })
    await drain()
    assert.equal(posts.at(-1).text, `⚰️ \`curia-9\`${GROUP_SEP}worker gone — \`resume 9\``)
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
    l3.onEvent({ type: 'worker_spawned', worker: 'curia-3', ticket: '3', model: 'opus' })
    await Promise.all([...l3.workers.values()].map((w) => w.chain))
    assert.equal(posts.length, 0)
    up = true
    l3.onEvent({ type: 'worker_ready', worker: 'curia-3', ticket: '3', model: 'opus', ts: 'T' })
    await Promise.all([...l3.workers.values()].map((w) => w.chain))
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
    line.onEvent({ type: 'worker_spawned', worker: 'curia-138', ticket: '138', model: 'gpt' })
    line.onEvent({ type: 'worker_ready', worker: 'curia-138', ticket: '138', model: 'gpt', ts: 'T' })
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
    line.onEvent({ type: 'worker_spawned', worker: 'curia-5', ticket: '5', model: 'opus' })
    line.onEvent({ type: 'worker_ready', worker: 'curia-5', ticket: '5', model: 'opus', ts: 'T' })
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
    l.onEvent({ type: 'worker_ready', worker: 'curia-6', ticket: '6', model: 'opus', ts: 'T' })
    await Promise.all([...l.workers.values()].map((w) => w.chain))
    assert.equal(posts.at(-1).text, `▶️ \`curia-6\`${GROUP_SEP}working`)
  })

  test('the state and the escalation title win over the meters when the line runs long', async () => {
    // A waiting line carrying a full-length title starts at 116 columns, so it
    // keeps the model and the context and loses the usage bars — the right
    // thing to lose, because a worker blocked on a question burns no quota.
    meters = {
      effort: 'high',
      ctxPct: 41,
      windows: [{ label: '5h', pct: 62, elapsedPct: 30 }, { label: '7d', pct: 41, elapsedPct: 76 }],
    }
    const title = 'Which of these seven candidate shades of blue should the launch banner use'
    records.set('esc-9', { id: 'esc-9', worker: 'curia-8', ticket: '8', kind: 'choice' })
    line.onEvent({ type: 'worker_spawned', worker: 'curia-8', ticket: '8', model: 'gpt' })
    line.onEvent({ type: 'esc_open', id: 'esc-9', worker: 'curia-8', ticket: '8', kind: 'choice', prompt: title, ts: new Date().toISOString() })
    await drain()
    const text = posts.at(-1).text
    assert.ok(text.includes(title), 'the escalation title survives whole')
    assert.ok(visibleWidth(text) <= LINE_BUDGET, `${visibleWidth(text)} columns is over the ${LINE_BUDGET} budget`)
    assert.ok(!text.includes('5h') && !text.includes('7d'), 'the bars go')
    assert.ok(!text.includes('**gpt**'), 'a maximal title leaves room for nothing else')
  })

  test('the meters degrade one at a time, tail first, as the base grows', async () => {
    meters = {
      effort: null,
      ctxPct: 41,
      windows: [{ label: '5h', pct: 62, elapsedPct: 30 }, { label: '7d', pct: 41, elapsedPct: 76 }],
    }
    const ask = async (n, title) => {
      records.set(`esc-${n}`, { id: `esc-${n}`, worker: `curia-${n}`, ticket: `${n}`, kind: 'choice' })
      line.onEvent({ type: 'worker_spawned', worker: `curia-${n}`, ticket: `${n}`, model: 'gpt' })
      line.onEvent({ type: 'esc_open', id: `esc-${n}`, worker: `curia-${n}`, ticket: `${n}`, kind: 'choice', prompt: title, ts: 'T' })
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
    // promptTitle caps a title at 80 chars, cutting at a word boundary, which
    // bounds how long the base can get. So there IS a floor, and the model —
    // the most valuable meter — is always above it.
    assert.ok(kept.at(-1) >= 1, 'the model survives even the longest title')
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
    line.onEvent({ type: 'worker_ready', worker: 'curia-1', ticket: '1', model: 'opus', ts: 'T' })
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

  test('a finished or dead worker carries no meters', async () => {
    meters = { effort: null, ctxPct: 41, windows: [{ label: '5h', pct: 62 }] }
    line.onEvent({ type: 'worker_spawned', worker: 'curia-3', ticket: '3', model: 'opus' })
    line.onEvent({ type: 'worker_died', worker: 'curia-3', ticket: '3' })
    line.onEvent({ type: 'worker_done', worker: 'curia-3' })
    await drain()
    assert.ok(!posts.at(-2).text.includes('ctx'))
    assert.ok(!posts.at(-1).text.includes('ctx'))
    line.refresh()
    await drain()
    assert.equal(edits.length, 0, 'the tick skips a worker whose run is over')
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
      store.logEvent('worker_spawned', { worker: 'curia-1', ticket: '1', model: 'opus' })
      store.open({ worker: 'curia-1', ticket: '1', kind: 'free-text', prompt: 'q' })
      assert.deepEqual(seen, ['worker_spawned', 'esc_open'])
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

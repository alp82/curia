// The per-worker status line (#108 item 8): one message per worker thread
// through daemon-witnessed states. A state CHANGE repositions the line to the
// thread bottom — delete + repost (#108 item 17) — because an edit-in-place
// stays where the line was born, screens above where the operator reads. Only
// the same-state elapsed refresh edits in place. Events are fed straight to
// onEvent — the same records the store's append hook delivers live.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { StatusLine, LINE_BUDGET } from '../src/statusline.mjs'
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
    assert.match(texts[1], /working · \*\*opus\*\*/)
    assert.match(texts[2], /waiting on \*\*\[esc-1\]\*\* — Which shade of blue\?/)
    assert.match(texts[3], /working/)
    assert.match(texts[4], /awaiting review — \*\*\[esc-2\]\*\*/)
    assert.match(texts[5], /executing approved writes/)
    assert.match(texts[6], /result received \(\*\*resolved\*\*\)/)
    assert.match(texts.at(-1), /🏁 .* done/)
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
    assert.match(posts[1].text, /🏁 .* done/)
    assert.match(posts[2].text, /dispatched on \*\*sonnet\*\*/)
    assert.ok(!removals.includes('m2'), 'the done line of the finished run is never deleted')
  })

  test('worker_died flips a working line to ⚰️ gone with the resume verb (#138, #108 item 20)', async () => {
    line.onEvent({ type: 'worker_spawned', worker: 'curia-9', ticket: '9', model: 'opus' })
    line.onEvent({ type: 'worker_ready', worker: 'curia-9', ticket: '9', model: 'opus', ts: 'T' })
    line.onEvent({ type: 'worker_died', worker: 'curia-9', ticket: '9', repo: 'o/r' })
    await drain()
    assert.match(posts.at(-1).text, /⚰️ `curia-9` · worker gone — `resume 9`/)
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

  test('the meters ride the line: model, effort, context %, and both usage bars (#146)', async () => {
    meters = { effort: 'high', ctxPct: 41, windows: [{ label: '5h', pct: 62 }, { label: '7d', pct: 41 }] }
    line.onEvent({ type: 'worker_spawned', worker: 'curia-138', ticket: '138', model: 'gpt' })
    line.onEvent({ type: 'worker_ready', worker: 'curia-138', ticket: '138', model: 'gpt', ts: 'T' })
    await drain()
    assert.equal(
      posts.at(-1).text,
      '▶️ `curia-138` · working · **gpt** high · ctx 41% · 5h ▓▓▓░░ 62% · 7d ▓▓░░░ 41%',
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
    assert.equal(posts.at(-1).text, '▶️ `curia-5` · working · **opus**')
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
    assert.equal(posts.at(-1).text, '▶️ `curia-6` · working')
  })

  test('the state and the escalation title win over the meters when the line runs long', async () => {
    meters = { effort: 'high', ctxPct: 41, windows: [{ label: '5h', pct: 62 }, { label: '7d', pct: 41 }] }
    const title = 'Which of these seven candidate shades of blue should the launch banner use'
    records.set('esc-9', { id: 'esc-9', worker: 'curia-8', ticket: '8', kind: 'choice' })
    line.onEvent({ type: 'worker_spawned', worker: 'curia-8', ticket: '8', model: 'gpt' })
    line.onEvent({ type: 'esc_open', id: 'esc-9', worker: 'curia-8', ticket: '8', kind: 'choice', prompt: title, ts: new Date().toISOString() })
    await drain()
    const text = posts.at(-1).text
    assert.ok(text.includes(title), 'the escalation title survives whole')
    assert.ok(text.length <= LINE_BUDGET, `${text.length} chars is over the ${LINE_BUDGET} budget`)
    assert.ok(!text.includes('7d'), 'the last meter is the first to go')
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

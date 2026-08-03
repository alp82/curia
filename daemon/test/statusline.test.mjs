// The per-worker status line (#108 item 8): one message per worker thread
// through daemon-witnessed states. A state CHANGE repositions the line to the
// thread bottom — delete + repost (#108 item 17) — because an edit-in-place
// stays where the line was born, screens above where the operator reads. Only
// the same-state elapsed refresh edits in place. Events are fed straight to
// onEvent — the same records the store's append hook delivers live.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { StatusLine } from '../src/statusline.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'
import { CONFIRM_KIND } from '../src/store.mjs'

describe('StatusLine', () => {
  let posts, edits, removals, records, line

  beforeEach(() => {
    posts = []
    edits = []
    removals = []
    records = new Map()
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
    assert.match(texts[1], /working on \*\*opus\*\*/)
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
    const opened = new Date(Date.now() - 45 * 60_000).toISOString()
    records.set('esc-3', { id: 'esc-3', worker: 'curia-4', ticket: '4', kind: 'free-text', status: 'open' })
    line.onEvent({ type: 'esc_open', id: 'esc-3', worker: 'curia-4', ticket: '4', kind: 'free-text', prompt: 'A question', ts: opened })
    line.onEvent({ type: 'esc_nudge', id: 'esc-3' })
    await drain()
    assert.equal(posts.length, 1)
    assert.equal(edits.length, 1, 'the nudge edits, never posts')
    assert.match(edits[0].text, /\[esc-3\].*45 min/)
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

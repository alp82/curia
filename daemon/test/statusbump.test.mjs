// What the bridge REPORTS as a post that buries a status line (#480).
//
// The line moved to the thread bottom only on a state change (#108 item 17),
// so every other message the bridge posted landed under it — a multi-chunk
// agent send, an escalation card, a receipt. The meter tick then edited a
// message screens above where the operator reads. Each posting path now
// reports the thread it landed in, and the daemon moves that thread's line
// back down (statusline.test.mjs holds the move itself).
//
// The report is keyed by the THREAD, never by the ticket the caller had in
// hand: a confirm renders where the operator typed (#218) and its pointer
// lands in a third thread, so `record.ticket` named neither of them.

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiscordBridge } from '../src/bridge.mjs'
import { Reduction } from '../src/reduction.mjs'
import { CONFIRM_KIND } from '../src/reduction.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'

const dirs = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-statusbump-'))
  dirs.push(d)
  return d
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

describe('every post into a ticket thread reports itself (#480)', () => {
  let bridge, reduction, reported, posts, threads, hookSends, statusEdits

  const makeThread = (id) => ({
    id,
    name: `🎫 ${id}`,
    send: async (payload) => { posts.push({ where: id, content: payload?.content ?? payload, payload }); return { id: `m-${id}` } },
    messages: { fetch: async () => ({ edit: async (payload) => { statusEdits.push(payload) } }) },
    setName: async () => {},
  })

  beforeEach(() => {
    reported = []
    posts = []
    hookSends = []
    statusEdits = []
    threads = new Map()
    reduction = new Reduction(tmp())
    // 208 and 209 are two live ticket threads; t-loose carries no binding.
    for (const id of ['t-208', 't-209', 't-loose']) threads.set(id, makeThread(id))
    reduction.bindTicketThread('208', 't-208')
    reduction.bindTicketThread('209', 't-209')

    bridge = new DiscordBridge({
      token: 'x',
      allowedUsers: [],
      dataDir: tmp(),
      log: () => {},
      handlers: {
        ticketPosted: (ticket) => reported.push(ticket),
        previewUrl: () => 'https://example.test/preview',
        timelineLink: () => 'https://example.test/chat',
      },
      bindings: {
        get: (t) => reduction.threadForTicket(t),
        bind: (t, id) => reduction.bindTicketThread(t, id),
        release: (t, r) => reduction.releaseTicketThread(t, r),
        last: (t) => reduction.lastThreadForTicket(t),
        ticketOf: (id) => reduction.ticketForThread(id),
        repoOf: () => 'alp82/curia',
      },
    })
    bridge.guild = { id: 'G' }
    bridge.channel = {
      id: 'C',
      send: async (payload) => { posts.push({ where: 'C', content: payload?.content ?? payload }); return { id: 'm-C' } },
      threads: { create: async () => { throw new Error('no fresh thread expected') } },
      fetchWebhooks: async () => [{
        name: 'curia-speakers',
        token: 'tok',
        send: async (m) => { hookSends.push(m); return { id: 'm-hook' } },
      }],
    }
    bridge.client = { channels: { fetch: async (id) => threads.get(id) ?? null }, user: null }
  })

  test('a bot-voice notify reports the ticket whose thread it landed in', async () => {
    await bridge.notify('208', 'the build is green')
    assert.deepEqual(reported, ['208'])
  })

  test('a message that chunks into several posts still reports once', async () => {
    // Discord caps a message at 2000 chars (#119). Three messages land, and
    // one move covers all three — the line ends under the last of them.
    const long = `${'x'.repeat(1900)}\n\n${'y'.repeat(1900)}\n\n${'z'.repeat(1900)}`
    await bridge.notify('208', long)
    assert.ok(posts.filter((p) => p.where === 't-208').length > 1, 'the fixture really did chunk')
    assert.deepEqual(reported, ['208'], 'one report for the run, not one per chunk')
  })

  test("an agent's own words report through the webhook voice too", async () => {
    await bridge.notify('208', 'I am on it', { as: 'curia-208' })
    assert.equal(hookSends.length, 1, 'the speaker identity carried the send')
    assert.deepEqual(reported, ['208'])
  })

  test('a webhook that fails falls back to the bot voice and still reports once', async () => {
    bridge.channel.fetchWebhooks = async () => { throw new Error('Missing Permissions') }
    await bridge.notify('208', 'I am on it', { as: 'curia-208' })
    assert.equal(posts.filter((p) => p.where === 't-208').length, 1, 'the words landed as the bot')
    assert.deepEqual(reported, ['208'], 'the fallback reports through the bot path, and only there')
  })

  // The one path that must stay silent: the line's own post is what a report
  // moves, so a report here would make the move trigger itself.
  test('postStatus reports nothing', async () => {
    await bridge.postStatus('208', '▶️ · **opus**')
    assert.deepEqual(reported, [])
  })

  test('the status line owns surface links and drops preview when settled', async () => {
    const ids = await bridge.postStatus('208', '▶️ · **opus**')
    const labels = posts.at(-1).payload.components[0].toJSON().components.map((button) => button.label)
    assert.deepEqual(labels, ['🔗 preview', 'Chat', 'ticket'])

    await bridge.editStatus(ids, '-# ✅ resolved', { settled: true })
    const settled = statusEdits.at(-1).components[0].toJSON().components.map((button) => button.label)
    assert.deepEqual(settled, ['Chat', 'ticket'])
  })

  test('an escalation in the ticket thread reports that ticket', async () => {
    await bridge.renderEscalation({
      id: 'esc-8', agent: 'curia-208', kind: REVIEW_KIND, ticket: '208', prompt: 'done?',
    })
    assert.deepEqual(reported, ['208'])
  })

  // #218: a confirm renders where the operator typed the command, and leaves a
  // pointer in each target's thread. Two threads take a message, and neither
  // is named by the record the caller had in hand.
  test('a confirm reports the thread it rendered in and every thread it pointed into', async () => {
    await bridge.renderEscalation({
      id: 'esc-7',
      agent: 'overseer',
      kind: CONFIRM_KIND,
      ticket: '208',
      prompt: 'Cancel it?',
      origin_thread_id: 't-209',
      action: { verb: 'cancel', targets: [{ session: 'curia-208', ticket: '208' }] },
    })
    assert.deepEqual(reported, ['209', '208'],
      'the card buried 209, the pointer buried 208, and the record named only 208')
  })

  test('a confirm rendered in the channel reports nothing but its pointer', async () => {
    await bridge.renderEscalation({
      id: 'esc-7',
      agent: 'overseer',
      kind: CONFIRM_KIND,
      ticket: '208',
      prompt: 'Cancel it?',
      origin_thread_id: null,
      action: { verb: 'cancel', targets: [{ session: 'curia-208', ticket: '208' }] },
    })
    assert.deepEqual(reported, ['208'], 'the channel carries no status line to move')
  })

  test('a confirm outcome reports the thread the card lives in', async () => {
    await bridge.notifyRecordThread(
      { id: 'esc-7', ticket: '208', discord: { threadId: 't-209' } },
      '⚰️ cancelled',
    )
    assert.deepEqual(reported, ['209'], 'the outcome lands beside the buttons, not beside the ticket')
  })

  test('a thread curia has not bound reports nothing', async () => {
    await bridge.sayInThread('t-loose', 'hello')
    assert.deepEqual(reported, [], 'no binding, no line, no move')
  })
})

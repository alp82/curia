// Tests for what a cancel is (#200). The 🛑 Cancel button under every question
// claimed to end the agent and re-frontier the ticket, and ended nothing: it
// closed the escalation record and handed the model a sentence. The model read
// the sentence and asked the same question again a minute later.
//
// The shape settled here:
//   - no cancel button on any escalation — questions, choices, review gates;
//   - a press on a message posted BEFORE this change does nothing and names
//     `cancel <n>`, the one word that ends an agent;
//   - the teardown renames the thread 🎫 → ⚰️ and keeps the binding (#140), so
//     the thread list shows the cancel with no message opened;
//   - the mark on the message says what happened and nothing else.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EscalationStore, CONFIRM_KIND } from '../src/store.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'
import { DiscordBridge } from '../src/bridge.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-cancel-test-'))

// The custom ids of every non-link button on a rendered escalation.
const idsOf = (components) => components
  .flatMap((row) => row.toJSON().components)
  .map((c) => c.custom_id)
  .filter(Boolean)

describe('no cancel button on an escalation (#200)', () => {
  let bridge, sent, thread

  beforeEach(() => {
    sent = []
    thread = {
      id: 't-1',
      name: '🎫 200 · task',
      send: async (payload) => { sent.push(payload); return { id: 'm-1' } },
      setName: async () => {},
    }
    bridge = new DiscordBridge({
      token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {},
    })
    bridge.channel = { id: 'C' }
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
  })

  const render = async (record) => {
    await bridge.renderEscalation(record)
    return idsOf(sent.at(-1).components)
  }

  test('a free-text question renders with no buttons at all', async () => {
    const ids = await render({ id: 'esc-1', ticket: '200', agent: 'curia-200', kind: 'free-text', prompt: 'which?' })
    assert.deepEqual(ids, [], 'the answer is a reply in the thread; nothing here ends an agent')
  })

  test('a choice keeps its options and loses the cancel', async () => {
    const ids = await render({
      id: 'esc-2', ticket: '200', agent: 'curia-200', kind: 'choice', prompt: 'a or b?', options: ['a', 'b'],
    })
    assert.deepEqual(ids, ['esc|esc-2|idx|0', 'esc|esc-2|idx|1'])
  })

  // #165 added the third button. The rule this test pins is unchanged: none of
  // the three ends the agent, and `cancel <n>` is still the only word that does.
  test('a review gate keeps ✅/❌/🔎 and loses the cancel', async () => {
    const ids = await render({ id: 'esc-3', ticket: '200', agent: 'curia-200', kind: REVIEW_KIND, prompt: 'done?' })
    assert.deepEqual(ids, ['esc|esc-3|opt|approve', 'esc|esc-3|opt|reject', 'esc|esc-3|opt|cross-check'],
      'a rejection is the "no" a gate already had; ending the agent is `cancel <n>`')
  })

  test('a confirm is unchanged — ✅/❌ and nothing else (#94)', async () => {
    const ids = await render({ id: 'esc-4', ticket: '200', agent: 'overseer', kind: CONFIRM_KIND, prompt: 'cancel it?' })
    assert.deepEqual(ids, ['esc|esc-4|opt|approve', 'esc|esc-4|opt|reject'])
  })
})

describe('a press on an old cancel button (#200)', () => {
  let bridge, replies, cancelled

  beforeEach(() => {
    replies = []
    cancelled = []
    bridge = new DiscordBridge({
      token: 'x',
      allowedUsers: ['u1'],
      dataDir: tmp(),
      handlers: {
        get: (id) => (id === 'esc-9' ? { id, ticket: '200' } : null),
        cancel: (id) => { cancelled.push(id); return { ok: true, record: { id } } },
      },
      log: () => {},
    })
    bridge.channel = { id: 'C' }
  })

  const press = async (customId, userId = 'u1') => {
    await bridge.handleInteraction({
      customId,
      user: { id: userId },
      isButton: () => true,
      isChatInputCommand: () => false,
      isRepliable: () => true,
      reply: async (payload) => { replies.push(payload) },
    })
  }

  test('it executes nothing and names the word that ends an agent', async () => {
    await press('esc|esc-9|cancel')
    assert.deepEqual(cancelled, [], 'the old act is gone — a quiet half-cancel is the fault itself')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ephemeral, true)
    assert.match(replies[0].content, /this button is gone/)
    assert.match(replies[0].content, /`cancel 200`/, 'the ticket comes from the record')
    assert.match(replies[0].content, /<#C>/, 'commands run in the command channel, never in a thread')
  })

  test('a record the daemon no longer knows still gets the pointer', async () => {
    await press('esc|esc-gone|cancel')
    assert.match(replies[0].content, /`cancel <n>`/)
  })
})

describe('the thread name after a cancel (#200)', () => {
  let store, bridge, threads

  const makeThread = (id, name, renames) => ({
    id, name, send: async () => {}, setName: async (n) => { renames.push(n) },
  })

  beforeEach(() => {
    store = new EscalationStore(tmp())
    threads = new Map()
    bridge = new DiscordBridge({
      token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {},
      bindings: {
        get: (t) => store.threadForTicket(t),
        bind: (t, id) => store.bindTicketThread(t, id),
        release: (t, r) => store.releaseTicketThread(t, r),
        last: (t) => store.lastThreadForTicket(t),
      },
    })
    bridge.guild = { id: 'G' }
    bridge.channel = { id: 'C', threads: { create: async () => { throw new Error('no fresh thread expected') } } }
    bridge.client = { channels: { fetch: async (id) => threads.get(id) ?? null } }
  })

  test('cancelledName swaps the ticket signal for the grave and keeps the rest', () => {
    assert.equal(DiscordBridge.cancelledName('🎫 200 · task'), '⚰️ 200 · task')
    assert.equal(DiscordBridge.cancelledName(DiscordBridge.labelName('200')), '⚰️ 200')
    assert.equal(DiscordBridge.cancelledName('deploy talk'), 'deploy talk')
  })

  test('a cancel renames the thread and KEEPS the binding (#140)', async () => {
    const renames = []
    const t = makeThread('t-c', '🎫 200 · task', renames)
    threads.set(t.id, t)
    store.bindTicketThread('200', 't-c')

    await bridge.cancelTicket('200')
    assert.deepEqual(renames, ['⚰️ 200 · task'])
    assert.equal(store.threadForTicket('200'), 't-c', 'the ticket keeps its history where a re-dispatch will land')
  })

  test('a cancel leaves an unlabeled thread alone and survives a deleted one', async () => {
    const renames = []
    const t = makeThread('t-plain', 'deploy talk', renames)
    threads.set(t.id, t)
    store.bindTicketThread('201', 't-plain')
    await bridge.cancelTicket('201')
    assert.deepEqual(renames, [])

    store.bindTicketThread('202', 't-gone') // never registered ⇒ the fetch misses
    await bridge.cancelTicket('202') // no throw
    assert.equal(store.threadForTicket('202'), 't-gone')
  })

  test('a re-dispatch takes the same thread back and puts 🎫 on it again', async () => {
    const renames = []
    const t = makeThread('t-again', '⚰️ 203 · task', renames)
    threads.set(t.id, t)
    store.bindTicketThread('203', 't-again')

    const r = await bridge.bindTicket('203', { threadId: 't-again', type: 'task' })
    assert.equal(r.ok, true)
    assert.deepEqual(renames, ['🎫 203 · task'], 'work is running again, so the thread reads as open again')
  })
})

describe('the mark on a cancelled question (#200)', () => {
  test('it names the ending, and only a Discord user id becomes a mention', () => {
    assert.equal(DiscordBridge.cancelWords('cancel'), 'its agent was cancelled')
    assert.equal(DiscordBridge.cancelWords('agent-death'), 'its agent is gone')
    assert.equal(DiscordBridge.cancelWords('reconcile'), 'the daemon reconciled it away')
    assert.equal(DiscordBridge.cancelWords('rest'), 'it was cancelled over the REST seam')
    assert.equal(DiscordBridge.cancelWords('4207'), 'cancelled by <@4207>')
    assert.equal(DiscordBridge.cancelWords('somebody'), 'cancelled (somebody)')
  })

  test('the mark makes no promise the daemon did not keep', async () => {
    let edited = null
    const bridge = new DiscordBridge({
      token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {},
    })
    bridge.client = {
      channels: {
        fetch: async () => ({
          messages: { fetch: async () => ({ edit: async (payload) => { edited = payload } }) },
        }),
      },
    }
    await bridge.markCancelled({
      id: 'esc-81', ticket: '200', agent: 'curia-200', kind: 'free-text', prompt: 'which?',
      cancelled_by: 'cancel', discord: { threadId: 't-1', messageId: 'm-1' },
    })
    assert.match(edited.content, /⚰️ \*\*cancelled\*\* — its agent was cancelled/)
    assert.doesNotMatch(edited.content, /re-frontiers/, 'the button never did that; the mark stops saying it did')
    assert.deepEqual(edited.components, [], 'a closed record has no buttons left')
  })
})

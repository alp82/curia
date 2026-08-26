// The model switch from the Discord status line (#717, on the #553 shape).
//
// The status line carries one more button beside its links while the agent
// lives: `model`. A press opens an EPHEMERAL select of routing labels, with
// the harness id, the running mark and any hold as small print. A pick runs
// the dispatcher's switch and rewrites that ephemeral message with the
// verdict. The thread stays quiet: the status line redraws off the journal.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiscordBridge } from '../src/bridge.mjs'
import { Reduction } from '../src/reduction.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-modelswitch-test-'))

const rowsOf = (components) => components.map((row) => row.toJSON().components)
const menusOf = (components) => rowsOf(components).flat().filter((c) => c.type === 3)
const buttonsOf = (components) => rowsOf(components).flat().filter((c) => c.type === 2)

const CHOICES = [
  { label: 'fable', id: 'claude-fable-5', harness: 'claude', running: true, crossHarness: false, hold: { kind: 'cooling', name: 'fable/anthropic cooling', reset_at: new Date('2026-08-31T09:00:00Z') } },
  { label: 'opus', id: 'claude-opus-5', harness: 'claude', running: false, crossHarness: false, hold: null },
  { label: 'gpt', id: 'gpt-5.6-sol', harness: 'codex', running: false, crossHarness: true, hold: null },
]

describe('the model button on the status line (#717)', () => {
  let bridge, sent, thread, calls

  beforeEach(() => {
    sent = []
    calls = []
    thread = {
      id: 't-544',
      send: async (payload) => { sent.push(payload); return { id: 'm-1' } },
      messages: { fetch: async () => ({ edit: async (payload) => { sent.push(payload) } }) },
    }
    bridge = new DiscordBridge({
      token: 'x', allowedUsers: ['op'], dataDir: tmp(), log: () => {},
      handlers: {
        statusLinks: async () => [{ label: 'chat', url: 'https://chat.example/544' }],
        modelChoices: async (ticket) => { calls.push(['choices', ticket]); return CHOICES },
        switchModel: async (ticket, model, by) => { calls.push(['switch', ticket, model, by]); return `🔁 \`curia-${ticket}\` runs on **${model}** now` },
      },
    })
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
  })

  test('a live status line carries the model button beside its links, and the receipt drops it', async () => {
    await bridge.postStatus('544', 'working')
    const live = buttonsOf(sent[0].components)
    assert.deepEqual(live.map((b) => b.label), ['chat', 'model'])
    assert.equal(live[1].custom_id, 'model|544|open')
    assert.equal(live[1].style, 2, 'a secondary button, not a link')

    await bridge.editStatus({ threadId: 't-544', messageId: 'm-1' }, 'resolved', { ticket: '544', settled: true })
    assert.deepEqual(buttonsOf(sent[1].components).map((b) => b.label), ['chat'], 'a dead button is a trap')
  })

  test('a press opens an ephemeral pick of routing labels with id, running mark and hold', async () => {
    let replied
    await bridge.handleInteraction({
      user: { id: 'op' }, customId: 'model|544|open',
      isButton: () => true, isStringSelectMenu: () => false, isChatInputCommand: () => false, isRepliable: () => true,
      reply: async (payload) => { replied = payload },
    })
    assert.deepEqual(calls, [['choices', '544']])
    assert.equal(replied.ephemeral, true, 'the thread carries no menu')
    assert.match(replied.content, /Switch `curia-544` to which model\?/)
    const [menu] = menusOf(replied.components)
    assert.equal(menu.custom_id, 'model|544|sel')
    assert.deepEqual(menu.options.map((o) => o.value), ['fable', 'opus', 'gpt'])
    assert.equal(menu.options[0].label, 'fable - running now')
    assert.match(menu.options[0].description, /^claude-fable-5 · cooling until \d\d:\d\d \(fable\/anthropic cooling\)$/)
    assert.equal(menu.options[1].description, 'claude-opus-5')
    assert.equal(menu.options[2].description, 'gpt-5.6-sol · on the codex harness')
  })

  test('a press on a ticket with no live agent is told so, ephemerally', async () => {
    bridge.handlers.modelChoices = async () => null
    let replied
    await bridge.handleInteraction({
      user: { id: 'op' }, customId: 'model|544|open',
      isButton: () => true, isStringSelectMenu: () => false, isChatInputCommand: () => false, isRepliable: () => true,
      reply: async (payload) => { replied = payload },
    })
    assert.equal(replied.ephemeral, true)
    assert.match(replied.content, /no live agent on ticket 544/)
  })

  test('a pick runs the switch and rewrites the ephemeral message with the verdict', async () => {
    const updates = []
    await bridge.handleInteraction({
      user: { id: 'op' }, customId: 'model|544|sel', values: ['opus'],
      isButton: () => false, isStringSelectMenu: () => true, isChatInputCommand: () => false, isRepliable: () => true,
      update: async (payload) => { updates.push(payload) },
      editReply: async (payload) => { updates.push(payload) },
    })
    assert.deepEqual(calls, [['switch', '544', 'opus', 'op']])
    assert.match(updates[0].content, /switching `curia-544` to `opus`/)
    assert.deepEqual(updates[0].components, [])
    assert.match(updates[1].content, /runs on \*\*opus\*\* now/)
    assert.equal(sent.length, 0, 'nothing lands in the thread for the press')
  })

  test('a refusal reaches the presser the same way', async () => {
    bridge.handlers.switchModel = async () => '❌ `fable` is cooling - the `fable/anthropic cooling` hold stands until 09:00.'
    const updates = []
    await bridge.handleInteraction({
      user: { id: 'op' }, customId: 'model|544|sel', values: ['fable'],
      isButton: () => false, isStringSelectMenu: () => true, isChatInputCommand: () => false, isRepliable: () => true,
      update: async (payload) => { updates.push(payload) },
      editReply: async (payload) => { updates.push(payload) },
    })
    assert.match(updates[1].content, /hold stands until 09:00/)
  })

  test('a stranger cannot press it', async () => {
    let replied
    await bridge.handleInteraction({
      user: { id: 'nobody' }, customId: 'model|544|open',
      isButton: () => true, isStringSelectMenu: () => false, isChatInputCommand: () => false, isRepliable: () => true,
      reply: async (payload) => { replied = payload },
    })
    assert.equal(replied.content, 'not authorized')
    assert.deepEqual(calls, [])
  })
})

describe('the conversation record follows an in-pane switch (#717)', () => {
  test('a restated spawn line moves the retained conversation to the new model', () => {
    const r = new Reduction(tmp())
    r.journal('agent_spawned', { repo: 'o/r', ticket: '544', agent: 'curia-544', model: 'fable', harness: 'claude', kind: 'ticket' })
    r.journal('agent_model_switched', { repo: 'o/r', ticket: '544', agent: 'curia-544', model: 'opus', switched_from: 'fable', harness: 'claude', kind: 'ticket' })
    const [c] = r.retainedAgentConversations()
    assert.equal(c.model, 'opus')
    assert.equal(c.state, 'active')
    assert.equal(r.questions.epochSpawn('curia-544').model, 'opus', 'a restart adopts the switched model')
  })
})

// The `choice` select menu (#431, on the #413 map).
//
// The card used to have two bands: buttons up to 23 options, and above that a
// numbered list with a typed reply. #414 named that list the worst answer
// surface the daemon has on a phone, and it could not judge the alternative,
// because the bridge built buttons and link buttons only.
//
// The operator set three bands on #431:
//   - 2 to 4 options stay buttons. Five buttons fill a row;
//   - 5 to 25 options are one select menu. Twenty-five is Discord's cap on a
//     string select, and the operator wants no more than that on a card;
//   - past 25 the numbered list stays, whole. It loses nothing, which a menu
//     that dropped option 26 in silence would.
//
// A pick answers through the same path a button press takes.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiscordBridge, MAX_SELECT_OPTIONS, selectOption } from '../src/bridge.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-select-test-'))

const rowsOf = (components) => components.map((row) => row.toJSON().components)
const menusOf = (components) => rowsOf(components).flat().filter((c) => c.type === 3)
const buttonsOf = (components) => rowsOf(components).flat().filter((c) => c.type === 2)

const opts = (n) => Array.from({ length: n }, (_, i) => `option ${i + 1}`)

describe('a choice card picks its surface by option count (#431)', () => {
  let bridge, sent, thread

  beforeEach(() => {
    sent = []
    thread = {
      id: 't-431',
      name: '🎫 431 · prototype',
      send: async (payload) => { sent.push(payload); return { id: 'm-1' } },
      setName: async () => {},
    }
    bridge = new DiscordBridge({
      token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {},
    })
    bridge.channel = { id: 'C', send: async (payload) => { sent.push(payload); return { id: 'm-C' } } }
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
  })

  const render = async (options) => {
    await bridge.renderEscalation({
      id: 'esc-1', ticket: '431', agent: 'curia-431', kind: 'choice', prompt: 'Which one?', options,
    })
    return sent.at(-1)
  }

  test('four options stay four buttons', async () => {
    const msg = await render(opts(4))
    assert.equal(menusOf(msg.components).length, 0, 'the buttons fit on one row')
    assert.equal(buttonsOf(msg.components).length, 4)
    assert.match(msg.content, /^Which one\?/)
    assert.doesNotMatch(msg.content, /curia-431/, 'the session id is not a second speaker identity')
    assert.match(msg.content, /-# ❓ esc-1 · choice/)
  })

  test('the fifth option turns the card into one menu', async () => {
    const msg = await render(opts(5))
    const menus = menusOf(msg.components)
    assert.equal(menus.length, 1)
    assert.equal(menus[0].options.length, 5)
    assert.equal(menus[0].placeholder, 'Pick one')
    assert.equal(menus[0].custom_id, 'esc|esc-1|sel')
    assert.equal(buttonsOf(msg.components).length, 0, 'no card carries both surfaces')
  })

  test('the numbered list goes away when the menu carries every option', async () => {
    const msg = await render(opts(12))
    assert.doesNotMatch(msg.content, /\*\*1\.\*\*/, 'the list would say what the menu already shows')
    assert.match(msg.content, /Pick from the menu below\./)
    assert.doesNotMatch(msg.content, /with a number/, 'no numbers are printed, so none are offered')
  })

  test('a long option keeps the numbered list beside the menu', async () => {
    // The menu shows 100 chars of label and 100 of description. An option past
    // both is clipped, so the full text must stay somewhere on the card.
    const msg = await render([...opts(5), 'x'.repeat(250)])
    assert.equal(menusOf(msg.components).length, 1, 'the menu still carries the taps')
    assert.match(msg.content, /\*\*6\.\*\*/, 'and the list carries the words')
    assert.match(msg.content, /or reply with a number/)
  })

  test('twenty-five options are still one menu and one row', async () => {
    const msg = await render(opts(MAX_SELECT_OPTIONS))
    const menus = menusOf(msg.components)
    assert.equal(menus.length, 1)
    assert.equal(menus[0].options.length, 25)
  })

  test('surface links stay off the decision card', async () => {
    bridge.handlers.previewUrl = () => 'https://example.test/p'
    bridge.handlers.timelineLink = () => 'https://example.test/chat'
    const msg = await render(opts(MAX_SELECT_OPTIONS))
    assert.equal(msg.components.length, 1, 'the menu is the card\'s only control row')
    assert.equal(buttonsOf(msg.components).length, 0, 'surface links belong on the status line')
  })

  test('past the menu cap the numbered list comes back whole', async () => {
    const msg = await render(opts(MAX_SELECT_OPTIONS + 1))
    assert.equal(menusOf(msg.components).length, 0, 'no menu may hide the options it cannot hold')
    assert.match(msg.content, /\*\*26\.\*\* option 26/)
    assert.match(msg.content, /Reply in this thread with a number\./)
  })

  test('the value on every option is its index into the record', async () => {
    const msg = await render(opts(20))
    const values = menusOf(msg.components).flatMap((m) => m.options).map((o) => o.value)
    assert.deepEqual(values, Array.from({ length: 20 }, (_, i) => String(i)))
  })

  test('typed handles keep controls short without changing the answer', async () => {
    await bridge.renderEscalation({
      id: 'esc-1', ticket: '431', agent: 'curia-431', kind: 'choice', prompt: 'Which one?',
      options: ['The full first option', 'The full second option'],
      payload: { options: [{ handle: 'First' }, { handle: 'Second' }] },
    })
    const msg = sent.at(-1)
    assert.deepEqual(buttonsOf(msg.components).map((button) => button.label), ['First', 'Second'])
  })

  test('two options that read the same still answer apart', async () => {
    // Discord refuses a menu with a repeated value. The index is the value, so
    // a duplicated label costs nothing.
    const msg = await render(['keep', 'drop', 'keep', 'hold', 'keep'])
    const options = menusOf(msg.components)[0].options
    assert.deepEqual(options.map((o) => o.value), ['0', '1', '2', '3', '4'])
  })
})

describe('a pick answers the record (#431)', () => {
  let bridge, answered, deferred, replies, followUps

  beforeEach(() => {
    answered = []
    deferred = 0
    replies = []
    followUps = []
    bridge = new DiscordBridge({
      token: 'x',
      allowedUsers: ['u1'],
      dataDir: tmp(),
      handlers: {
        get: () => ({ id: 'esc-1', kind: 'choice', options: opts(20) }),
        answer: (id, payload) => { answered.push({ id, ...payload }); return { ok: true } },
      },
      log: () => {},
    })
    bridge.channel = { id: 'C' }
  })

  const pick = async (values) => bridge.handleInteraction({
    isButton: () => false,
    isStringSelectMenu: () => true,
    isChatInputCommand: () => false,
    isRepliable: () => true,
    customId: 'esc|esc-1|sel',
    values,
    user: { id: 'u1' },
    deferUpdate: async () => { deferred++ },
    reply: async (r) => { replies.push(r) },
    followUp: async (r) => { followUps.push(r) },
  })

  test('the picked index resolves to the option text', async () => {
    await pick(['17'])
    assert.equal(answered.at(-1).answer, 'option 18')
    assert.equal(answered.at(-1).by, 'u1')
  })

  test('the answer records that the menu carried it', async () => {
    await pick(['3'])
    assert.equal(answered.at(-1).via, 'select menu')
  })

  test('a pick is acknowledged silently, like a press', async () => {
    // #253, ADR-0013: the card is the only record of an answer.
    await pick(['0'])
    assert.equal(deferred, 1)
    assert.deepEqual(replies, [])
  })

  test('an answered card offers the next three needs without duplicating its receipt', async () => {
    bridge.handlers.answer = () => ({
      ok: true,
      next_needs: [
        { headline: 'Review the map.', agent: 'curia-8', ticket: '8' },
        { headline: 'Choose the limit.', agent: 'curia-9', ticket: '9' },
        { headline: 'Approve the preview.', agent: 'curia-10', ticket: '10' },
      ],
    })
    await pick(['0'])
    assert.equal(deferred, 1)
    assert.equal(followUps.length, 1)
    assert.match(followUps[0].content, /Next 3 needs/)
    assert.match(followUps[0].content, /Approve the preview/)
    assert.equal(followUps[0].ephemeral, true)
  })
})

describe('the option payload (#431)', () => {
  test('a short option is one label and no description', () => {
    assert.deepEqual(selectOption('navy', 7), { label: 'navy', value: '7' })
  })

  test('a long option spills its tail into the description', () => {
    const o = selectOption(`${'a'.repeat(100)}${'b'.repeat(40)}`, 0)
    assert.equal(o.label, 'a'.repeat(100))
    assert.equal(o.description, 'b'.repeat(40))
  })

  test('an option past both fields is marked as clipped', () => {
    const o = selectOption('c'.repeat(400), 0)
    assert.equal(o.description.length, 100)
    assert.match(o.description, /…$/, 'the reader must see that words are missing')
  })
})

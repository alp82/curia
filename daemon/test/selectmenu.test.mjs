// The long-choice select menu (#431, on the #413 map).
//
// Above `MAX_BUTTON_OPTIONS` a `choice` card used to drop its buttons, print a
// numbered list and ask for a typed reply. #414 named that the worst answer
// surface the daemon has on a phone, and it could not judge the alternative,
// because the bridge built buttons and link buttons only.
//
// The shape settled here:
//   - buttons keep the short list. A button is one tap and a menu is two, so
//     the menu takes only the case the buttons cannot fit;
//   - one menu holds 25 options and four rows carry menus, so the menu reaches
//     100. The fifth row stays free for the surface link buttons;
//   - past 100 options the numbered list comes back, because a card that drops
//     option 101 in silence is worse than a card that scrolls;
//   - a pick answers through the same path a button press takes.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DiscordBridge, MAX_SELECT_OPTIONS, MAX_SELECT_TOTAL, selectOption, selectPages,
} from '../src/bridge.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-select-test-'))

const rowsOf = (components) => components.map((row) => row.toJSON().components)
const menusOf = (components) => rowsOf(components)
  .flat()
  .filter((c) => c.type === 3) // ComponentType.StringSelect

const opts = (n, text = (i) => `option ${i + 1}`) => Array.from({ length: n }, (_, i) => text(i))

describe('a long choice card answers through a select menu (#431)', () => {
  let bridge, sent, thread, answered

  beforeEach(() => {
    sent = []
    answered = []
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

  test('at the button cap the card still uses buttons', async () => {
    const msg = await render(opts(23))
    assert.equal(menusOf(msg.components).length, 0, 'a list the buttons fit gets no menu')
    assert.equal(rowsOf(msg.components).flat().filter((c) => c.type === 2).length, 23)
  })

  test('one option past the cap turns the list into one menu', async () => {
    const msg = await render(opts(24))
    const menus = menusOf(msg.components)
    assert.equal(menus.length, 1)
    assert.equal(menus[0].options.length, 24)
    assert.equal(menus[0].placeholder, 'Pick one')
    assert.equal(menus[0].custom_id, 'esc|esc-1|sel|0')
  })

  test('the numbered list goes away when the menu carries every option', async () => {
    const msg = await render(opts(30))
    assert.doesNotMatch(msg.content, /\*\*1\.\*\*/, 'the list would say what the menu already shows')
    assert.match(msg.content, /Pick from the menu below\./)
    assert.doesNotMatch(msg.content, /with a number/, 'no numbers are printed, so none are offered')
  })

  test('a long option keeps the numbered list beside the menu', async () => {
    // The menu shows 100 chars of label and 100 of description. An option past
    // both is clipped, so the full text must stay somewhere on the card.
    const msg = await render([...opts(23), 'x'.repeat(250)])
    assert.equal(menusOf(msg.components).length, 1, 'the menu still carries the taps')
    assert.match(msg.content, /\*\*24\.\*\*/, 'and the list carries the words')
    assert.match(msg.content, /or reply with a number/)
  })

  test('the menus page across four rows and label their stretch', async () => {
    const msg = await render(opts(60))
    const menus = menusOf(msg.components)
    assert.equal(menus.length, 3)
    assert.deepEqual(menus.map((m) => m.options.length), [25, 25, 10])
    assert.deepEqual(menus.map((m) => m.placeholder), [
      'Pick one — options 1-25', 'Pick one — options 26-50', 'Pick one — options 51-60',
    ])
  })

  test('the link row survives a full stack of menus', async () => {
    bridge.handlers.previewUrl = () => 'https://example.test/p'
    const msg = await render(opts(MAX_SELECT_TOTAL))
    assert.equal(menusOf(msg.components).length, 4)
    assert.equal(msg.components.length, 5, 'four menu rows plus the link row')
    const links = rowsOf(msg.components).at(-1)
    assert.deepEqual(links.map((c) => c.label), ['🔗 preview'])
  })

  test('past the menu reach the numbered list comes back whole', async () => {
    const msg = await render(opts(MAX_SELECT_TOTAL + 1))
    assert.equal(menusOf(msg.components).length, 0, 'no menu may hide the options it cannot hold')
    assert.match(msg.content, /\*\*101\.\*\* option 101/)
    assert.match(msg.content, /Reply in this thread with a number\./)
  })

  test('the value on every option is its index into the record', async () => {
    const msg = await render(opts(40))
    const values = menusOf(msg.components).flatMap((m) => m.options).map((o) => o.value)
    assert.deepEqual(values, Array.from({ length: 40 }, (_, i) => String(i)))
  })
})

describe('a pick answers the record (#431)', () => {
  let bridge, answered, deferred, replies

  beforeEach(() => {
    answered = []
    deferred = 0
    replies = []
    bridge = new DiscordBridge({
      token: 'x',
      allowedUsers: ['u1'],
      dataDir: tmp(),
      handlers: {
        get: () => ({ id: 'esc-1', kind: 'choice', options: opts(40) }),
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
    customId: 'esc|esc-1|sel|25',
    values,
    user: { id: 'u1' },
    deferUpdate: async () => { deferred++ },
    reply: async (r) => { replies.push(r) },
  })

  test('the picked index resolves to the option text', async () => {
    await pick(['27'])
    assert.equal(answered.at(-1).answer, 'option 28')
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
})

describe('the pure pieces (#431)', () => {
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
    assert.equal(o.description.length, MAX_SELECT_OPTIONS * 4)
    assert.match(o.description, /…$/, 'the reader must see that words are missing')
  })

  test('the pages tile the list with no gap and no overlap', () => {
    const pages = selectPages(opts(60))
    assert.deepEqual(pages.map((p) => p.start), [0, 25, 50])
    assert.deepEqual(pages.flatMap((p) => p.slice), opts(60))
  })
})

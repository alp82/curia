// The typed card on Discord (#418, ADR-0019).
//
// The daemon composes the card body with `card.mjs` and stores it as the
// record's prompt. The bridge prints that same text and adds the ANSWER
// surface: the buttons, the select menu, the one-tap round. So this file asks
// two things of every case — did the card say the whole decision, and can the
// operator answer it with a tap.
//
// An untyped record renders exactly as it did before this ticket. The flip is
// #422, and until it lands both shapes are live.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiscordBridge, ALL_AS_RECOMMENDED } from '../src/bridge.mjs'
import { composeCard, derivedRecommended, optionLabels } from '../src/card.mjs'
import { CHUNK_LIMIT } from '../src/messaging.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-typedcard-test-'))

const idsOf = (components) => (components ?? [])
  .flatMap((row) => row.toJSON().components)
  .map((c) => c.custom_id)
  .filter(Boolean)

const menuOf = (components) => (components ?? [])
  .flatMap((row) => row.toJSON().components)
  .find((c) => c.type === 3)

describe('a typed card renders as one message the operator can answer', () => {
  let bridge, sent, thread

  beforeEach(() => {
    sent = []
    thread = { id: 't-418', name: '🎫 418', send: async (p) => { sent.push(p); return { id: 'm-1' } }, setName: async () => {} }
    bridge = new DiscordBridge({ token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {} })
    bridge.channel = { id: 'C', send: async (p) => { sent.push(p); return { id: 'm-C' } } }
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
  })

  // What the daemon does at open time, in one place, so a test asks the same
  // question the live path does.
  const render = async (kind, payload) => {
    await bridge.renderEscalation({
      id: 'esc-1', ticket: '418', agent: 'curia-418', kind, payload,
      prompt: composeCard(kind, payload),
      options: optionLabels(payload),
      preview_url: payload.preview_url,
      recommended: derivedRecommended(kind, payload),
    })
    return sent.at(-1)
  }

  const CHOICE = {
    headline: 'A restart forgets every cooling. Re-arm it from what source?',
    visual: '09:00  cap lands\n13:02  deploy, memory wiped',
    options: [
      { label: 'From the journal.', consequence: 'A guessed reset holds 55 minutes too long.', recommended: true },
      { label: 'From a fresh reading.', consequence: 'It answers "am I near the cap", not "did I hit one".' },
    ],
    detail: 'The daemon has journalled provider_cooling since #175.',
  }

  test('the card carries the headline, every option and every cost', async () => {
    const msg = await render('choice', CHOICE)
    assert.match(msg.content, /\*\*A restart forgets every cooling/)
    assert.match(msg.content, /\*\*A\. From the journal\.\*\*/)
    assert.match(msg.content, /↳ A guessed reset holds 55 minutes too long\./)
    assert.match(msg.content, /\*\*B\. From a fresh reading\.\*\*/)
    assert.match(msg.content, /Recommendation: \*\*A\*\*\./)
  })

  test('the visual rides a fence curia wrote, and the detail rides a spoiler', async () => {
    const msg = await render('choice', CHOICE)
    assert.match(msg.content, /```\n09:00 {2}cap lands\n13:02 {2}deploy, memory wiped\n```/)
    assert.match(msg.content, /Details: \|\|The daemon has journalled provider_cooling since #175\.\|\|/)
  })

  test('two options are two buttons, keyed by index like every other pick', async () => {
    const msg = await render('choice', CHOICE)
    assert.deepEqual(idsOf(msg.components).filter((i) => i.includes('|idx|')), ['esc|esc-1|idx|0', 'esc|esc-1|idx|1'])
  })

  test('the head leaves a blank line, so the headline is not glued to the id', async () => {
    const msg = await render('choice', CHOICE)
    assert.match(msg.content, /asks \(\*choice\*\):\n\n\*\*A restart/)
  })

  test('the whole card fits one Discord message', async () => {
    const msg = await render('choice', CHOICE)
    assert.ok(msg.content.length < CHUNK_LIMIT, `a card of ${msg.content.length} chars is a scroll before it is answerable`)
  })
})

describe('a typed round', () => {
  let bridge, sent, thread

  beforeEach(() => {
    sent = []
    thread = { id: 't', name: '🎫 418', send: async (p) => { sent.push(p); return { id: 'm' } }, setName: async () => {} }
    bridge = new DiscordBridge({ token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {} })
    bridge.channel = { id: 'C', send: async (p) => { sent.push(p); return { id: 'm' } } }
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
  })

  const round = async (questions) => {
    const payload = { headline: 'Three questions before I build.', questions }
    await bridge.renderEscalation({
      id: 'esc-1', ticket: '418', agent: 'curia-418', kind: 'free-text', payload,
      prompt: composeCard('free-text', payload),
      recommended: derivedRecommended('free-text', payload),
    })
    return sent.at(-1)
  }

  test('curia numbers the questions, so the agent maps the reply back to its own numbers', async () => {
    const msg = await round([{ text: 'one?' }, { text: 'two?' }])
    assert.match(msg.content, /\*\*1\.\*\* one\?/)
    assert.match(msg.content, /\*\*2\.\*\* two\?/)
  })

  test('every question recommended gives the ✅ button', async () => {
    const msg = await round([{ text: 'one?', recommendation: 'yes' }, { text: 'two?', recommendation: 'no' }])
    assert.deepEqual(idsOf(msg.components), [`esc|esc-1|opt|${ALL_AS_RECOMMENDED}`])
    assert.match(msg.content, /comes back in the next round/)
  })

  test('ONE question without a recommendation takes the button away', async () => {
    // The whole reason the flag retired: the old boolean let an agent claim
    // "all" over a round where one question had nothing to take.
    const msg = await round([{ text: 'one?', recommendation: 'yes' }, { text: 'two?' }])
    assert.deepEqual(idsOf(msg.components), [])
    assert.match(msg.content, /Reply in this thread to answer/)
    assert.equal(derivedRecommended('free-text', { questions: [{ text: 'one?', recommendation: 'y' }, { text: 'two?' }] }), false)
  })

  test('a round of no questions claims nothing', () => {
    assert.equal(derivedRecommended('free-text', { questions: [] }), false)
    assert.equal(derivedRecommended('choice', { options: [{ label: 'a' }] }), false)
  })
})

describe('a typed choice past the button band', () => {
  let bridge, sent, thread

  beforeEach(() => {
    sent = []
    thread = { id: 't', name: '🎫 418', send: async (p) => { sent.push(p); return { id: 'm' } }, setName: async () => {} }
    bridge = new DiscordBridge({ token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {} })
    bridge.channel = { id: 'C', send: async (p) => { sent.push(p); return { id: 'm' } } }
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
  })

  const many = (n) => ({
    headline: 'Which one?',
    options: Array.from({ length: n }, (_, i) => ({ label: `option ${i + 1}`, consequence: `cost ${i + 1}` })),
  })

  const render = async (payload) => {
    await bridge.renderEscalation({
      id: 'esc-1', ticket: '418', agent: 'curia-418', kind: 'choice', payload,
      prompt: composeCard('choice', payload), options: optionLabels(payload),
    })
    return sent.at(-1)
  }

  test('the menu carries the labels and the body carries the costs, said once each', async () => {
    const msg = await render(many(8))
    const menu = menuOf(msg.components)
    assert.equal(menu.options.length, 8)
    assert.equal(menu.options[0].label, 'option 1')
    assert.match(msg.content, /↳ cost 1/)
    // The untyped path printed a second numbered list under the body. The typed
    // body already IS that list, so printing it again is the scroll #431 named.
    assert.equal((msg.content.match(/option 1/g) ?? []).length, 1)
    assert.match(msg.content, /_Pick from the menu below\._/)
  })

  test('past the menu band the card asks for a letter or a number', async () => {
    const msg = await render(many(30))
    assert.equal(menuOf(msg.components), undefined)
    assert.match(msg.content, /_Reply in this thread with a letter or a number\._/)
  })
})

describe('an untyped card is untouched until the flip (#422)', () => {
  let bridge, sent, thread

  beforeEach(() => {
    sent = []
    thread = { id: 't', name: '🎫 418', send: async (p) => { sent.push(p); return { id: 'm' } }, setName: async () => {} }
    bridge = new DiscordBridge({ token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {} })
    bridge.channel = { id: 'C', send: async (p) => { sent.push(p); return { id: 'm' } } }
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
  })

  test('the prompt still sits one newline under the head', async () => {
    await bridge.renderEscalation({
      id: 'esc-1', ticket: '418', agent: 'curia-418', kind: 'free-text', prompt: 'which port?',
    })
    assert.match(sent.at(-1).content, /asks \(\*free-text\*\):\nwhich port\?/)
  })

  test('an untyped long choice still prints its numbered fallback list', async () => {
    await bridge.renderEscalation({
      id: 'esc-1', ticket: '418', agent: 'curia-418', kind: 'choice', prompt: 'which?',
      options: Array.from({ length: 30 }, (_, i) => `opt ${i + 1}`),
    })
    assert.match(sent.at(-1).content, /\*\*1\.\*\* opt 1/)
    assert.match(sent.at(-1).content, /_Reply in this thread with a number\._/)
  })
})

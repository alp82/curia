import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_INBOUND_TEXT_BYTES,
  normalizeInboundMessage,
} from '../src/attachments.mjs'
import { DiscordBridge } from '../src/bridge.mjs'

const message = (content, attachments = []) => ({
  content,
  attachments: new Map(attachments.map((attachment, index) => [String(index), attachment])),
})

describe('inbound Discord message normalization (#697)', () => {
  test('combines ordinary text and attached text once in source order', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(url)
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(url.endsWith('/a') ? 'second' : 'third').buffer }
    }

    const result = await normalizeInboundMessage(message('first', [
      { name: 'message.txt', url: 'https://cdn.example/a', contentType: 'text/plain', size: 6 },
      { name: 'notes.md', url: 'https://cdn.example/b', contentType: 'text/markdown', size: 5 },
      { name: 'image.png', url: 'https://cdn.example/c', contentType: 'image/png', size: 4 },
    ]), { fetchImpl })

    assert.deepEqual(result, { ok: true, text: 'first\n\nsecond\n\nthird', textAttachments: ['0', '1'] })
    assert.deepEqual(calls, ['https://cdn.example/a', 'https://cdn.example/b'])
  })

  test('top-level turns, thread turns, notes, and answers receive normalized text', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-inbound-message-'))
    const turns = []
    const notes = []
    const answers = []
    let open = null
    let owner = null
    const bridge = new DiscordBridge({
      token: 'x',
      allowedUsers: ['operator'],
      dataDir,
      handlers: {
        overseerTurn: async (threadId, text) => turns.push({ threadId, text }),
        findOpenForThread: () => open,
        agentForThread: () => owner,
        queueAgentNote: (_threadId, text) => { notes.push(text); return { reads: true } },
        answer: (_id, payload) => { answers.push(payload); return { ok: true } },
      },
      log: () => {},
    })
    bridge.channel = { id: 'curia-channel' }
    const sent = []
    const thread = {
      id: 'thread', parentId: 'curia-channel',
      isThread: () => true,
      sendTyping: async () => {},
      send: async (payload) => { sent.push(payload); return { edit: async () => {} } },
    }
    const makeDiscordMessage = (target = thread) => ({
      author: { bot: false, id: 'operator' },
      channel: target,
      content: 'ordinary',
      attachments: new Map([['overflow', {
        name: 'message.txt', contentType: 'text/plain', size: 8,
        url: 'data:text/plain,overflow',
      }]]),
      react: async () => {},
      startThread: target.startThread,
    })

    await bridge.handleMessage(makeDiscordMessage())
    assert.deepEqual(turns.pop(), { threadId: 'thread', text: 'ordinary\n\noverflow' })

    owner = 'curia-42'
    await bridge.handleMessage(makeDiscordMessage())
    assert.equal(notes.pop(), 'ordinary\n\noverflow')

    owner = null
    open = { id: 'esc-42', kind: 'free-text' }
    await bridge.handleMessage(makeDiscordMessage())
    assert.equal(answers[0].answer, 'ordinary\n\noverflow')
    assert.deepEqual(answers[0].attachments, [])

    open = null
    const top = { id: 'curia-channel' }
    top.startThread = async ({ name }) => ({ ...thread, id: `top:${name}` })
    await bridge.handleMessage(makeDiscordMessage(top))
    assert.deepEqual(turns.pop(), { threadId: 'top:ordinary\n\noverflow', text: 'ordinary\n\noverflow' })
  })

  test('a fully parsed top-level command runs before an overseer turn', async () => {
    const commands = []
    const turns = []
    const replies = []
    const bridge = new DiscordBridge({
      token: 'x', allowedUsers: ['operator'], dataDir: os.tmpdir(), log: () => {},
      handlers: {
        command: async (...args) => { commands.push(args); return 'no live agents' },
        overseerTurn: async (...args) => turns.push(args),
      },
    })
    bridge.channel = { id: 'curia-channel' }
    const topLevel = (content) => ({
      author: { bot: false, id: 'operator' },
      channel: { id: 'curia-channel' },
      content,
      attachments: new Map(),
      reply: async (payload) => replies.push(payload),
      startThread: async () => { throw new Error('a command must not open a thread') },
    })

    await bridge.handleMessage(topLevel('status'))

    assert.deepEqual(commands, [['status', 'operator', { threadId: null }]])
    assert.deepEqual(replies, [{ content: 'no live agents' }])
    assert.deepEqual(turns, [])
  })

  test('does not repeat ordinary text when Discord includes the same overflow text', async () => {
    const fetchImpl = async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('same words').buffer,
    })

    const result = await normalizeInboundMessage(message('same words', [
      { name: 'message.txt', url: 'https://cdn.example/a', contentType: 'text/plain', size: 10 },
    ]), { fetchImpl })

    assert.equal(result.text, 'same words')
  })

  test('refuses an unavailable text attachment without losing ordinary text', async () => {
    const result = await normalizeInboundMessage(message('keep this', [
      { name: 'message.txt', url: 'https://cdn.example/a', contentType: 'text/plain', size: 10 },
    ]), { fetchImpl: async () => ({ ok: false, status: 503 }) })

    assert.equal(result.ok, false)
    assert.equal(result.text, 'keep this')
    assert.match(result.refusal, /message\.txt.*HTTP 503/)
  })

  test('refuses oversized text before downloading it', async () => {
    let fetched = false
    const result = await normalizeInboundMessage(message('', [
      { name: 'large.txt', url: 'https://cdn.example/a', contentType: 'text/plain', size: MAX_INBOUND_TEXT_BYTES + 1 },
    ]), { fetchImpl: async () => { fetched = true } })

    assert.equal(result.ok, false)
    assert.match(result.refusal, /large\.txt.*limit/)
    assert.equal(fetched, false)
  })
})

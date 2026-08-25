// The typed verb runs BEFORE a model turn (#692, ADR-0022).
//
// A top-level line in #curia used to be prose by definition: it opened a
// thread, started a session, and the model then composed the same verb the
// operator had already typed. The reference incident is three `status` lines in
// four minutes, which cost three threads named "status" and three model
// sessions to answer a question the router answers for free.
//
// The rule is the whole line. When `parseCommand` accepts the trimmed message,
// it is a command; anything else is prose, and prose still opens a conversation.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DiscordBridge } from '../src/bridge.mjs'

// One #curia channel, one operator, and a record of everything the bridge did
// with the message. `overseerTurn` records the calls it should never receive.
function harness() {
  const sent = []
  const commands = []
  const turns = []
  const threads = []
  const bridge = new DiscordBridge({
    token: 'x',
    allowedUsers: ['operator'],
    dataDir: '/tmp',
    handlers: {
      command: async (text, userId, opts) => {
        commands.push({ text, userId, opts })
        return `⚙️ ran ${text}`
      },
      overseerTurn: async (threadId, prompt) => { turns.push({ threadId, prompt }) },
      findOpenForThread: () => null,
    },
    log: () => {},
  })
  bridge.channel = { id: 'curia-channel' }

  const message = (content) => ({
    author: { bot: false, id: 'operator' },
    channel: {
      id: 'curia-channel',
      send: async (payload) => { sent.push(payload); return { id: 'sent-1' } },
    },
    content,
    startThread: async ({ name }) => {
      threads.push(name)
      return { id: 'thread-1', sendTyping: async () => {}, send: async () => ({ id: 'm' }) }
    },
  })

  return { bridge, message, sent, commands, turns, threads }
}

describe('a fully parsed top-level command runs without a conversation (#692)', () => {
  test('a typed verb reaches the router, and no thread and no session open', async () => {
    const h = harness()
    await h.bridge.handleMessage(h.message('status'))

    assert.deepEqual(h.commands.map((c) => c.text), ['status'])
    assert.equal(h.commands[0].userId, 'operator')
    assert.deepEqual(h.turns, [], 'a typed verb opened an overseer session')
    assert.deepEqual(h.threads, [], 'a typed verb opened a thread')
    assert.deepEqual(h.sent.map((p) => p.content), ['⚙️ ran status'])
  })

  // The router's own reply is the answer. The operator sees it in #curia, where
  // they typed the command, with no thread between them and it.
  test('the router reply lands in the channel the command was typed in', async () => {
    const h = harness()
    await h.bridge.handleMessage(h.message('  tickets alp82/curia  '))

    assert.deepEqual(h.commands.map((c) => c.text), ['tickets alp82/curia'])
    assert.deepEqual(h.sent.map((p) => p.content), ['⚙️ ran tickets alp82/curia'])
  })

  // A top-level command carries no thread, the way a top-level slash command
  // carries none. There is nothing for `start` to bind.
  test('a typed verb binds no thread', async () => {
    const h = harness()
    await h.bridge.handleMessage(h.message('start 147'))
    assert.deepEqual(h.commands[0].opts, { threadId: null })
  })

  // The whole line has to parse. A line that STARTS with a verb and goes on in
  // prose is a question, and a question is what the overseer is for.
  test('prose that starts with a verb still opens a conversation', async () => {
    const h = harness()
    await h.bridge.handleMessage(h.message('status of the landing page map?'))

    assert.deepEqual(h.commands, [], 'prose reached the router')
    assert.deepEqual(h.turns.map((t) => t.prompt), ['status of the landing page map?'])
    assert.deepEqual(h.threads, ['status of the landing page map?'])
  })

  test('a line the parser refuses is prose, not a refusal', async () => {
    const h = harness()
    await h.bridge.handleMessage(h.message('map'))

    assert.deepEqual(h.commands, [])
    assert.deepEqual(h.turns.length, 1)
  })

  // Both map shapes are typed commands, so the operator's shortest route to a
  // charting agent needs no model in it either.
  test('both map shapes run typed', async () => {
    for (const line of ['map 147 add a ticket for the sidecar', 'map curia chart the next feature']) {
      const h = harness()
      await h.bridge.handleMessage(h.message(line))
      assert.deepEqual(h.commands.map((c) => c.text), [line], `\`${line}\` did not run typed`)
      assert.deepEqual(h.turns, [])
    }
  })
})

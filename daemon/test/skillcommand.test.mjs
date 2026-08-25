import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCommand, CommandRouter } from '../src/commands.mjs'
import { canonicalFor, verbHandlers } from '../src/overseerverbs.mjs'
import { expandCommand } from '../src/bridge.mjs'

describe('ticketless skill command', () => {
  test('round trips through the checked command seam', () => {
    const text = canonicalFor('skill', { name: 'to-tickets', target: 'alp82/curia#640' })
    assert.equal(text, 'skill to-tickets alp82/curia#640')
    assert.deepEqual(parseCommand(text), {
      verb: 'skill', name: 'to-tickets', target: 'alp82/curia#640',
    })
  })

  test('the prose tool posts canonical text before the router acts', async () => {
    const seen = []
    const handler = verbHandlers(async (text) => {
      seen.push(text)
      return 'started'
    }).find((entry) => entry.verb === 'skill')

    const reply = await handler.handler({ name: 'to-spec', target: '640' })

    assert.deepEqual(seen, ['skill to-spec 640'])
    assert.deepEqual(reply, { content: [{ type: 'text', text: 'started' }] })
  })

  test('the exact top-level command dispatches without a model turn', async () => {
    const calls = []
    const dispatcher = {
      config: { watch: [{ repo: 'alp82/curia' }] },
      skill: async (name, target, options) => {
        calls.push({ name, target, options })
        return 'started'
      },
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })

    assert.equal(await router.handle('skill to-tickets 640', 'operator-1', { threadId: 'thread-1' }), 'started')
    assert.deepEqual(calls, [{
      name: 'to-tickets', target: '640', options: { by: 'operator-1', threadId: 'thread-1' },
    }])
  })

  test('Discord expands the command fields without interpretation', () => {
    const values = { name: 'to-tickets', target: 'alp82/curia#640' }
    const interaction = {
      commandName: 'skill',
      options: { getString: (name) => values[name] ?? null },
    }
    assert.equal(expandCommand(interaction), 'skill to-tickets alp82/curia#640')
  })

  test('refuses whitespace in names and targets at the parser', () => {
    assert.equal(parseCommand('skill ../to-tickets 640'), null)
    assert.equal(parseCommand('skill to-tickets'), null)
    assert.equal(parseCommand('skill to-tickets 640 more'), null)
  })
})

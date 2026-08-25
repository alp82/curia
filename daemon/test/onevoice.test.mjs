// The button answer, and the spawn (#253, ADR-0013 "One voice per fact").
//
// The cold read of 131 threads (docs/research/discord-thread-surprises.md,
// section 4) found every button answer echoed twice: the bridge edits the card
// to "✅ answered by @… via button: …" AND posts an interaction reply saying
// the same thing. On an old card the two land screens apart, so the reply reads
// as news about something the card already shows.
//
// ADR-0013's rule: the card is the only record. The press is acknowledged
// silently, and every answer path — button, thread reply, REST — leaves its
// mark on the one card.

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiscordBridge } from '../src/bridge.mjs'
import { buildSystemPrompt } from '../src/overseerprompt.mjs'

const dirs = []
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-onevoice-'))
  dirs.push(d)
  return d
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

describe('a press on an escalation button says nothing beside the card (#253)', () => {
  let bridge, replies, answers, result

  beforeEach(() => {
    replies = []
    answers = []
    result = { ok: true, record: { id: 'esc-12' }, routed_from: [] }
    bridge = new DiscordBridge({
      token: 'x',
      allowedUsers: ['u1'],
      dataDir: tmpDir(),
      handlers: {
        get: (id) => ({ id, ticket: '42', options: ['navy', 'teal'] }),
        answer: (id, opts) => { answers.push({ id, ...opts }); return result },
      },
      log: () => {},
    })
    bridge.channel = { id: 'C' }
  })

  const press = async (customId, userId = 'u1') => {
    let deferred = false
    await bridge.handleInteraction({
      customId,
      user: { id: userId },
      isButton: () => true,
      isChatInputCommand: () => false,
      isRepliable: () => true,
      deferUpdate: async () => { deferred = true },
      reply: async (payload) => { replies.push(payload) },
    })
    return deferred
  }

  test('the answer reaches the daemon, and the press is acknowledged silently', async () => {
    const deferred = await press('esc|esc-12|opt|approve')
    assert.deepEqual(answers, [{ id: 'esc-12', answer: 'approve', by: 'u1', via: 'button' }])
    assert.equal(deferred, true, 'Discord needs an acknowledgment within three seconds')
    assert.deepEqual(replies, [], 'the card already shows the answer — a reply would say it twice')
  })

  test('an index button resolves to its option and is just as silent', async () => {
    await press('esc|esc-12|idx|1')
    assert.equal(answers[0].answer, 'teal')
    assert.deepEqual(replies, [])
  })

  // A refusal is the other case: nothing happened, so there is no mark on the
  // card to read. The presser is told privately.
  test('a refusal still replies, and only to the presser', async () => {
    result = { ok: false, reason: 'already answered', record: { id: 'esc-12', answer: 'navy' } }
    await press('esc|esc-12|opt|approve')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ephemeral, true)
    assert.match(replies[0].content, /not open/)
    assert.match(replies[0].content, /navy/)
  })
})

describe('the card carries what the interaction reply used to add (#253)', () => {
  let bridge, edited

  beforeEach(() => {
    edited = []
    bridge = new DiscordBridge({
      token: 'x', allowedUsers: ['u1'], dataDir: tmpDir(), handlers: {}, log: () => {},
    })
    bridge.client = {
      channels: {
        fetch: async () => ({
          messages: { fetch: async () => ({ edit: async (payload) => { edited.push(payload) } }) },
        }),
      },
    }
  })

  const record = {
    id: 'esc-12', ticket: '42', kind: 'choice', prompt: 'Which shade?', options: ['navy'],
    answer: 'navy', answered_by: 'u1', answered_via: 'button',
    discord: { threadId: 't1', messageId: 'm1' },
  }

  test('the mark names who answered, how, and what they said', async () => {
    await bridge.markAnswered(record)
    assert.match(edited[0].content, /✅ \*\*answered\*\* by <@u1> via button: `navy`/)
    assert.deepEqual(edited[0].components, [], 'answered once, and there is nothing left to press')
  })

  test('a routed answer names the dead ids it came through', async () => {
    await bridge.markAnswered(record, { routedFrom: ['esc-9', 'esc-10'] })
    assert.match(edited[0].content, /\(routed from esc-9→esc-10\)/)
  })
})

// The overseer owns the choice. The ticket status owns dispatch progress, so
// another announcement would repeat the same event.
describe('the overseer never narrates a dispatch (#253)', () => {
  test('the system prompt forbids the announcement and keeps the choice', () => {
    // The shell posture is the one the overseer container runs (#315).
    const prompt = buildSystemPrompt({ shell: true, checkoutsRoot: '/work/overseer/repos', repos: ['alp82/curia'] })
    assert.match(prompt, /Never announce a dispatch/)
    assert.match(prompt, /The daemon edits the ticket status during dispatch/, 'it says which surface already covers it')
    assert.match(prompt, /Say which ticket you picked and why/)
  })
})

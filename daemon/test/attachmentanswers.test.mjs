// Regression test for #565. Discord gives pasted images the same original
// filename, but one escalation answer must keep every attachment and its bytes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiscordBridge } from '../src/bridge.mjs'

test('one answer keeps two same-name attachments as separate files (#565)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-attachment-answer-'))
  const answers = []
  const bridge = new DiscordBridge({
    token: 'x',
    allowedUsers: ['operator'],
    dataDir,
    handlers: {
      findOpenForThread: () => ({ id: 'esc-628', kind: 'free-text' }),
      answer: (id, payload) => { answers.push({ id, ...payload }); return { ok: true } },
    },
    log: () => {},
  })
  bridge.channel = { id: 'curia-channel' }

  const posthog = Buffer.from('posthog screenshot')
  const supabase = Buffer.from('supabase screenshot')
  const message = {
    author: { bot: false, id: 'operator' },
    channel: { id: 'ticket-thread', parentId: 'curia-channel', isThread: () => true },
    content: 'See both screenshots.',
    attachments: new Map([
      ['posthog', { name: 'image.png', url: `data:image/png;base64,${posthog.toString('base64')}` }],
      ['supabase', { name: 'image.png', url: `data:image/png;base64,${supabase.toString('base64')}` }],
    ]),
    react: async () => {},
  }

  await bridge.handleMessage(message)

  assert.equal(answers.length, 1)
  assert.equal(answers[0].id, 'esc-628')
  assert.equal(answers[0].attachments.length, 2)
  assert.notEqual(answers[0].attachments[0], answers[0].attachments[1])
  assert.deepEqual(answers[0].attachments.map((file) => fs.readFileSync(file)), [posthog, supabase])
})

// #697: Discord spills a long message into `message.txt`, and every inbound
// path used to read only the half that stayed in the message. These tests hold
// the seam that composes the whole thing, and then hold each of the four paths
// that must read it: a top-level turn, a thread turn, an agent note, and an
// escalation answer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readInboundText,
  isInboundText,
  MAX_INBOUND_TEXT_BYTES,
  MAX_INBOUND_TEXT_FILES,
} from '../src/inbound.mjs'
import { DiscordBridge } from '../src/bridge.mjs'

// A Discord attachment as the bridge sees one, plus the bytes a loader returns.
const file = (name, body, extra = {}) => ({
  name,
  url: `https://cdn.discordapp.com/${name}`,
  size: Buffer.byteLength(body),
  body: Buffer.from(body),
  ...extra,
})

const message = (content, files = []) => ({
  content,
  attachments: new Map(files.map((f, i) => [String(i), f])),
})

const load = async (a) => {
  if (a.body === undefined) throw new Error('nothing to load')
  return a.body
}

test('the overflow file becomes the tail of the message (#697)', async () => {
  const m = message('Here is the plan, the rest is attached', [file('message.txt', 'and the rest of the plan is here')])
  const { text, segments, refusals } = await readInboundText(m, { load })
  assert.deepEqual(segments, ['Here is the plan, the rest is attached', 'and the rest of the plan is here'])
  assert.deepEqual(refusals, [])
  assert.equal(text, 'Here is the plan, the rest is attached\n\nand the rest of the plan is here')
})

test('source order holds and every segment appears once (#697)', async () => {
  const m = message('opening', [file('a.md', 'first file'), file('b.txt', 'second file')])
  const { text } = await readInboundText(m, { load })
  assert.equal(text, 'opening\n\nfirst file\n\nsecond file')
  assert.equal(text.match(/first file/g).length, 1)
  assert.equal(text.match(/opening/g).length, 1)
})

test('an attachment-only message still carries text (#697)', async () => {
  const { text } = await readInboundText(message('', [file('message.txt', 'the whole request')]), { load })
  assert.equal(text, 'the whole request')
})

test('an image is left to the disk-path route (#697)', async () => {
  const m = message('look', [file('shot.png', 'PNG')])
  assert.equal(isInboundText({ name: 'shot.png' }), false)
  const { text, segments } = await readInboundText(m, { load })
  assert.equal(segments.length, 1)
  assert.equal(text, 'look')
})

test('a file past the per-file limit is refused by name, not truncated (#697)', async () => {
  const big = 'x'.repeat(MAX_INBOUND_TEXT_BYTES + 1)
  const m = message('read the log', [file('huge.log', big), file('small.txt', 'this one fits')])
  const { text, refusals } = await readInboundText(m, { load })
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /huge\.log/)
  assert.match(refusals[0], /limit/)
  // Non-destructive: the body and the file that fits both survive.
  assert.match(text, /read the log/)
  assert.match(text, /this one fits/)
  assert.equal(text.includes('xxxxxxxxxx'), false)
})

test('a stated oversize file is refused without a download (#697)', async () => {
  let downloads = 0
  const m = message('', [{ name: 'archive.txt', url: 'x', size: MAX_INBOUND_TEXT_BYTES * 4 }])
  const { text } = await readInboundText(m, { load: async () => { downloads += 1; return Buffer.from('') } })
  assert.equal(downloads, 0)
  assert.match(text, /archive\.txt/)
})

test('a failed download costs its own text and nothing else (#697)', async () => {
  const m = message('the diff is attached', [{ name: 'work.patch', url: 'https://cdn/gone' }])
  const { text, refusals } = await readInboundText(m, { load: async () => { throw new Error('HTTP 404') } })
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /work\.patch/)
  assert.match(refusals[0], /HTTP 404/)
  assert.match(text, /the diff is attached/)
})

test('only the first few text files are read, and the rest are named (#697)', async () => {
  const files = Array.from({ length: MAX_INBOUND_TEXT_FILES + 1 }, (_, i) => file(`n${i}.txt`, `body ${i}`))
  const { segments, refusals } = await readInboundText(message('', files), { load })
  assert.equal(segments.length, MAX_INBOUND_TEXT_FILES)
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], new RegExp(`n${MAX_INBOUND_TEXT_FILES}\\.txt`))
})

// ---- the four inbound paths ------------------------------------------------

const attachmentOf = (name, body) => ({
  name,
  url: `data:text/plain;base64,${Buffer.from(body).toString('base64')}`,
  size: Buffer.byteLength(body),
})

function bridgeWith(handlers, dataDir = null) {
  const bridge = new DiscordBridge({
    token: 'x',
    allowedUsers: ['operator'],
    dataDir: dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'curia-inbound-')),
    handlers,
    log: () => {},
  })
  bridge.channel = { id: 'curia-channel' }
  return bridge
}

test('a top-level turn reads the overflow file (#697)', async () => {
  const turns = []
  const bridge = bridgeWith({ overseerTurn: (key, text) => { turns.push(text) } })
  let started = null
  await bridge.handleMessage({
    author: { bot: false, id: 'operator' },
    channel: { id: 'curia-channel' },
    content: 'chart a map for the importer,',
    attachments: new Map([['0', attachmentOf('message.txt', 'and here are the twelve constraints')]]),
    startThread: async (opts) => {
      started = opts
      return { id: 'new-thread', members: { add: async () => {} }, sendTyping: async () => {} }
    },
  })
  assert.equal(turns.length, 1)
  assert.match(turns[0], /chart a map for the importer,\n\nand here are the twelve constraints/)
  assert.match(started.name, /^chart a map/)
})

test('a thread turn reads the overflow file (#697)', async () => {
  const turns = []
  const bridge = bridgeWith({
    findOpenForThread: () => null,
    agentForThread: () => null,
    overseerTurn: (key, text) => { turns.push(text) },
  })
  await bridge.handleMessage({
    author: { bot: false, id: 'operator' },
    channel: { id: 'a-thread', parentId: 'curia-channel', isThread: () => true, sendTyping: async () => {} },
    content: 'more on that:',
    attachments: new Map([['0', attachmentOf('message.txt', 'the long half')]]),
  })
  assert.deepEqual(turns, ['more on that:\n\nthe long half'])
})

test('an agent note reads the overflow file (#697)', async () => {
  const notes = []
  const bridge = bridgeWith({
    findOpenForThread: () => null,
    agentForThread: () => '628',
    queueAgentNote: (key, text) => { notes.push(text); return { reads: true, position: 1 } },
    ticketPosted: () => {},
  })
  await bridge.handleMessage({
    author: { bot: false, id: 'operator' },
    channel: {
      id: 'ticket-thread',
      parentId: 'curia-channel',
      isThread: () => true,
      send: async () => {},
    },
    content: 'note for you:',
    attachments: new Map([['0', attachmentOf('message.txt', 'the whole review checklist')]]),
    react: async () => {},
  })
  assert.deepEqual(notes, ['note for you:\n\nthe whole review checklist'])
})

test('an escalation answer reads the overflow file (#697)', async () => {
  const answers = []
  const bridge = bridgeWith({
    findOpenForThread: () => ({ id: 'esc-697', kind: 'free-text' }),
    answer: (id, payload) => { answers.push(payload); return { ok: true } },
  })
  await bridge.handleMessage({
    author: { bot: false, id: 'operator' },
    channel: { id: 'ticket-thread', parentId: 'curia-channel', isThread: () => true },
    content: 'answer:',
    attachments: new Map([['0', attachmentOf('message.txt', 'the long answer')]]),
    react: async () => {},
  })
  assert.equal(answers.length, 1)
  assert.match(answers[0].answer, /answer:\n\nthe long answer/)
  // The file still reaches the agent by path, so a big artifact stays readable.
  assert.equal(answers[0].attachments.length, 1)
  assert.match(answers[0].answer, /\[attachment: /)
})

test('a typed command still runs when it is the whole message (#697, #692)', async () => {
  const ran = []
  const bridge = bridgeWith({
    command: (line) => { ran.push(line); return 'done' },
    overseerTurn: () => { throw new Error('should not take a model turn') },
  })
  await bridge.handleMessage({
    author: { bot: false, id: 'operator' },
    channel: { id: 'curia-channel', send: async () => ({ id: 'reply' }) },
    content: 'status',
    attachments: new Map(),
  })
  assert.deepEqual(ran, ['status'])
})

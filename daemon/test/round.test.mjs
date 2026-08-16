// The round (#285, ADR-0005).
//
// Version 1.2 of the vendored `grilling` skill asks the whole frontier in one
// numbered round. curia's escalation contract said the opposite — one question
// per `ask_human` call — and the two could not both stand. The round won,
// because the WAIT is what a question costs, not the token: twelve questions at
// one call each is twelve looks at a phone spread over a day.
//
// The shape settled here:
//   - a round needs no new kind. It is a `free-text` call whose prompt carries
//     the numbered questions, and the agent maps the reply back to its own
//     numbers. The daemon parses nothing, which keeps ADR-0005's no-interpret
//     rule exactly where a round would be tempted to break it;
//   - `recommended: true` adds ONE button, ✅ All as recommended, and its press
//     captures a fixed word the agent reads;
//   - there is no ❌ beside it: the opposite of "all as recommended" is a reply;
//   - a question the human does not answer is NOT taken as recommended. It
//     comes back in the next round. This is "never answer for the human" said
//     in the one place a round could quietly break it.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Reduction } from '../src/reduction.mjs'
import { DiscordBridge, ALL_AS_RECOMMENDED } from '../src/bridge.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-round-test-'))

const idsOf = (components) => components
  .flatMap((row) => row.toJSON().components)
  .map((c) => c.custom_id)
  .filter(Boolean)

const labelsOf = (components) => components
  .flatMap((row) => row.toJSON().components)
  .map((c) => c.label)
  .filter(Boolean)

describe('a round renders as one free-text card (#285)', () => {
  let bridge, sent, thread

  beforeEach(() => {
    sent = []
    thread = {
      id: 't-285',
      name: '🎫 285 · grilling',
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

  const render = async (record) => {
    await bridge.renderEscalation({ id: 'esc-1', ticket: '285', agent: 'curia-285', ...record })
    return sent.at(-1)
  }

  test('a round is a free-text call — no new kind carries it', async () => {
    // The whole point of the decision: `ask_human` did not grow a fifth kind.
    const msg = await render({
      kind: 'free-text',
      prompt: '❓ **Q1** — one?\n\n➡️ yes\n\n❓ **Q2** — two?\n\n➡️ no',
      recommended: true,
    })
    assert.match(msg.content, /free-text/, 'the kind on the card is still one of the four')
    assert.match(msg.content, /Q1/)
    assert.match(msg.content, /Q2/, 'both questions ride one card, so both cost one wait')
  })

  test('the flag adds exactly one button, and it is the ✅', async () => {
    const msg = await render({ kind: 'free-text', prompt: 'Q1, Q2', recommended: true })
    assert.deepEqual(idsOf(msg.components), [`esc|esc-1|opt|${ALL_AS_RECOMMENDED}`])
    assert.deepEqual(labelsOf(msg.components), ['✅ All as recommended'])
  })

  test('there is no ❌ beside it — the opposite of the tap is a reply', async () => {
    const msg = await render({ kind: 'free-text', prompt: 'Q1, Q2', recommended: true })
    const ids = idsOf(msg.components)
    assert.equal(ids.length, 1)
    assert.ok(!ids.some((i) => i.endsWith('|reject')), 'a rejection here would answer nothing')
  })

  test('the press captures a word, and the daemon never reads the prompt', async () => {
    // A press sends `esc|<id>|opt|<value>` and the answer IS that value. So the
    // agent — which wrote the recommendations — is the only thing that decides
    // what they were. ADR-0005: the bridge renders and captures, never interprets.
    const msg = await render({ kind: 'free-text', prompt: 'Q1, Q2', recommended: true })
    const [, , action, value] = idsOf(msg.components)[0].split('|')
    assert.equal(action, 'opt')
    assert.equal(value, ALL_AS_RECOMMENDED)
  })

  test('the card says an unanswered question comes back — it is not taken as recommended', async () => {
    const msg = await render({ kind: 'free-text', prompt: 'Q1, Q2', recommended: true })
    assert.match(msg.content, /comes back in the next round/)
  })

  test('a plain free-text question is untouched — no button, and the old line', async () => {
    const msg = await render({ kind: 'free-text', prompt: 'which port?' })
    assert.deepEqual(idsOf(msg.components ?? []), [], 'the flag is opt-in; a lone question still has no button')
    assert.match(msg.content, /Reply in this thread to answer/)
    assert.doesNotMatch(msg.content, /All as recommended/)
  })

  test('the flag is free-text only — the other kinds already answer by button', async () => {
    const msg = await render({ kind: 'choice', prompt: 'a or b?', options: ['a', 'b'], recommended: true })
    assert.deepEqual(idsOf(msg.components), ['esc|esc-1|idx|0', 'esc|esc-1|idx|1'],
      'a choice with the flag set gets its options and nothing more')
  })
})

describe('the round survives a restart (#285)', () => {
  test('the flag replays from the journal, so a re-render keeps its button', () => {
    // A record the bridge failed to post retries for 15 minutes (#261), and a
    // daemon restart can land inside that window. The flag has to be on the
    // journal line, or the retry posts the round with no way to accept it.
    const dir = tmp()
    const first = new Reduction(dir)
    first.open({ agent: 'curia-285', ticket: '285', kind: 'free-text', prompt: 'Q1, Q2', recommended: true })
    const [replayed] = new Reduction(dir).openEscalations()
    assert.equal(replayed.recommended, true)
  })

  test('a record opened without the flag replays as false, never undefined', () => {
    const dir = tmp()
    new Reduction(dir).open({ agent: 'curia-285', ticket: '285', kind: 'free-text', prompt: 'which port?' })
    const [replayed] = new Reduction(dir).openEscalations()
    assert.equal(replayed.recommended, false)
  })

  test('the flag is not part of the question, so a re-ask still supersedes', () => {
    // Supersession keys on the payload hash, and the hash is the QUESTION. An
    // agent that re-asks the same round with the flag flipped is re-asking, not
    // asking something new — two live cards for one question is the bug #200
    // and #139 both circle.
    const reduction = new Reduction(tmp())
    const a = reduction.open({ agent: 'curia-285', ticket: '285', kind: 'free-text', prompt: 'Q1, Q2' })
    const b = reduction.open({ agent: 'curia-285', ticket: '285', kind: 'free-text', prompt: 'Q1, Q2', recommended: true })
    assert.equal(b.superseded?.id, a.record.id)
  })
})

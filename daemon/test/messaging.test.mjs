// Tests for src/messaging.mjs (#95): the per-turn messaging standard from the
// messaging-discipline decision (#89) — the helpers, and the lint that holds
// every reply path to the standard.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { SIGNALS, smallPrint, link, clampList, lintReply, chunkMessage, promptTitle, elapsedLabel, CHUNK_LIMIT } from '../src/messaging.mjs'

describe('smallPrint', () => {
  test('prefixes every line with the -# marker', () => {
    assert.equal(smallPrint('one'), '-# one')
    assert.equal(smallPrint('one\ntwo'), '-# one\n-# two')
  })
})

describe('link', () => {
  test('wraps a url in <> so Discord skips the embed', () => {
    assert.equal(link('https://github.com/alp82/curia/pull/1'), '<https://github.com/alp82/curia/pull/1>')
  })
})

describe('clampList', () => {
  test('a list at or under the cap passes through untouched', () => {
    const lines = ['a', 'b', 'c']
    assert.deepEqual(clampList(lines, 3), lines)
  })

  test('a longer list keeps the head and says how many more, in small print', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']
    assert.deepEqual(clampList(lines, 2), ['a', 'b', '-# … 3 more'])
  })
})

describe('lintReply', () => {
  test('a conforming reply produces no violations', () => {
    const reply = [
      `${SIGNALS.work} dispatched o/r#42 → \`curia-42\` on **claude-sonnet-5** — watching for readiness`,
      `${SIGNALS.ticket} #85 **Fix the parser** \`grilling\``,
      `${SIGNALS.link} timeline ${link('https://example.test/t/42')}`,
      smallPrint('… 3 more'),
    ].join('\n')
    assert.deepEqual(lintReply(reply), [])
  })

  test('every signal in the set passes the lint', () => {
    assert.deepEqual(lintReply(Object.values(SIGNALS).join(' ')), [])
  })

  test('headings, blockquotes, and tables are violations', () => {
    assert.equal(lintReply('# heading').length, 1)
    assert.equal(lintReply('> quoted').length, 1)
    assert.equal(lintReply('| a | b |').length, 1)
  })

  test('emoji outside the signal set are violations', () => {
    assert.equal(lintReply('🚀 dispatched').length, 1)
    assert.equal(lintReply('🛑 cancelled').length, 1)
    assert.equal(lintReply('💤 idle ⏳ soon').length, 2)
  })

  test('small print is exempt from the heading check, not from the emoji check', () => {
    assert.deepEqual(lintReply(smallPrint('meta line')), [])
    assert.equal(lintReply(smallPrint('🚀 meta')).length, 1)
  })
})

// #119: long composed messages become consecutive chunks instead of a silent
// clip at Discord's cap — the review gate lost its charting proposal to one.
describe('chunkMessage', () => {
  test('short text is one chunk, unchanged', () => {
    assert.deepEqual(chunkMessage('hello\n\nworld'), ['hello\n\nworld'])
  })

  test('splits at paragraph boundaries and loses nothing', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `paragraph ${i} ${'x'.repeat(300)}`)
    const text = paras.join('\n\n')
    const chunks = chunkMessage(text)
    assert.ok(chunks.length > 1)
    for (const c of chunks) assert.ok(c.length <= CHUNK_LIMIT, `chunk of ${c.length} over the limit`)
    // no paragraph is cut: every original paragraph appears whole in some chunk
    for (const p of paras) assert.ok(chunks.some((c) => c.includes(p)), 'paragraph lost or split')
  })

  test('a paragraph over the limit falls back to line splits', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${'y'.repeat(100)}`)
    const chunks = chunkMessage(lines.join('\n'))
    for (const c of chunks) assert.ok(c.length <= CHUNK_LIMIT)
    for (const l of lines) assert.ok(chunks.some((c) => c.includes(l)))
  })

  test('a single line over the limit is hard-sliced, still complete', () => {
    const text = 'z'.repeat(CHUNK_LIMIT * 2 + 10)
    const chunks = chunkMessage(text)
    for (const c of chunks) assert.ok(c.length <= CHUNK_LIMIT)
    assert.equal(chunks.join(''), text)
  })
})

// #118: the one-line handle on a prompt — never a mid-word cut, which is how
// the reminder produced "frontier re" (#108 item 13).
describe('promptTitle', () => {
  test('takes the first non-empty line and strips emphasis', () => {
    assert.equal(promptTitle('\n**Q2 — the one promise.**\n\nbody'), 'Q2 — the one promise.')
  })

  test('cuts at a word boundary with an ellipsis, never mid-word', () => {
    assert.equal(promptTitle('alpha bravo charlie delta echo', 20), 'alpha bravo charlie…')
    assert.equal(promptTitle('short enough', 20), 'short enough')
  })
})

describe('elapsedLabel', () => {
  test('minutes and hours read as waits', () => {
    const now = Date.now()
    assert.equal(elapsedLabel(new Date(now - 30_000).toISOString(), now), 'under a minute')
    assert.equal(elapsedLabel(new Date(now - 56 * 60_000).toISOString(), now), '56 min')
    assert.equal(elapsedLabel(new Date(now - 125 * 60_000).toISOString(), now), '2 h 05 min')
  })

  test('garbage input yields null, not NaN text', () => {
    assert.equal(elapsedLabel('not a date'), null)
  })
})

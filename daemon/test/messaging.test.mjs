// Tests for src/messaging.mjs (#95): the per-turn messaging standard from the
// messaging-discipline decision (#89) — the helpers, and the lint that holds
// every reply path to the standard.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { SIGNALS, smallPrint, link, clampList, lintReply } from '../src/messaging.mjs'

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

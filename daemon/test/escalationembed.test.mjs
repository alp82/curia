// The escalation message as an embed (#891). The bridge composes every
// escalation it posts from one function, and the Test run's panel draws the
// same shape as a Discord-style preview, so the preview is the message and
// never a paraphrase. This pins two things: the text the bridge sends is the
// embed's own parts in order, and the parts are the ones Discord renders (a
// title, a description, fields, a footer).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { escalationEmbed } from '../src/escalationembed.mjs'

const DATA = '/data'
const record = (over = {}) => ({
  id: 'esc-7', agent: 'curia-42', ticket: '42', kind: 'free-text', prompt: '**Which name?**\n\n**1.** The file name.\n↳ README.md',
  options: null, payload: { headline: 'Which name?', questions: [{ text: 'The file name.', recommendation: 'README.md' }] },
  recommended: true, preview_url: null, lint_flags: null, action: null, ...over,
})

describe('the escalation embed', () => {
  test('a free-text round: the prompt is the description, the answering instruction is a field, and the files line and the id are the footer', () => {
    const e = escalationEmbed(record(), { dataDir: DATA })
    assert.equal(e.author, 'curia')
    assert.equal(e.title, 'Question · #42')
    assert.equal(e.description, '❓ **Which name?**\n\n**1.** The file name.\n↳ README.md')
    assert.deepEqual(e.fields, [{ name: 'How to answer', value: '✅ takes every recommendation above. Reply in this thread to name exceptions. Unanswered questions return in the next round.' }])
    assert.equal(e.footer, 'A reply here may carry files. They land under `/data/attachments/esc-7/` and reach the agent as paths.\nesc-7')
    // The text is the parts, in order, as the bridge has always sent them.
    assert.equal(e.text, [
      '❓ **Which name?**\n\n**1.** The file name.\n↳ README.md',
      '_✅ takes every recommendation above. Reply in this thread to name exceptions. Unanswered questions return in the next round._',
      '-# A reply here may carry files. They land under `/data/attachments/esc-7/` and reach the agent as paths.',
      '-# esc-7',
    ].join('\n'))
  })

  test('the review gate keeps its composed block whole and names the three answers', () => {
    const e = escalationEmbed(record({ id: 'esc-9', kind: 'review-gate', prompt: '🔍 review o/r#42\nsummary', payload: null, recommended: false }), { dataDir: DATA })
    assert.equal(e.title, 'Review gate · #42')
    assert.equal(e.description, '🔍 review o/r#42\nsummary')
    assert.equal(e.fields[0].name, 'How to answer')
    assert.match(e.fields[0].value, /✅ Approve to merge and resolve/)
    assert.match(e.fields[0].value, /🔎 Cross-check answers neither/)
    assert.equal(e.text, [
      '🔍 review o/r#42\nsummary', '',
      '_✅ Approve to merge and resolve. A reply is a rejection, and I take your words as the change list._',
      '_🔎 Cross-check answers neither. It starts a reviewer on the other provider, and I wait for its verdict._',
      '-# A reply here may carry files. They land under `/data/attachments/esc-9/` and reach the agent as paths.',
      '-# esc-9',
    ].join('\n'))
  })

  test('a typed choice within the button band says only how to answer, and the map question is a choice addressed to the operator', () => {
    const e = escalationEmbed(record({
      id: 'esc-3', agent: 'overseer', ticket: '40', kind: 'choice', prompt: 'Map o/r#40 has no open tickets. What should Curia do?',
      options: ['Clear fog and close', 'Keep map open'],
      payload: { headline: 'Map o/r#40 has no open tickets. What should Curia do?', options: [{ label: 'Clear fog and close', handle: 'Clear and close' }, { label: 'Keep map open', handle: 'Keep open' }] },
      recommended: false, action: { verb: 'empty-map-verdict', repo: 'o/r', map: 40 },
    }), { dataDir: DATA })
    assert.equal(e.title, 'Choice · #40')
    assert.equal(e.description, '❓ Map o/r#40 has no open tickets. What should Curia do?')
    assert.deepEqual(e.fields, [])
    assert.equal(e.text, [
      '❓ Map o/r#40 has no open tickets. What should Curia do?',
      '-# A reply here may carry files. They land under `/data/attachments/esc-3/` and reach the agent as paths.',
      '-# esc-3',
    ].join('\n'))
  })

  test('a confirm carries its footer sentence and no files line', () => {
    const e = escalationEmbed(record({ id: 'esc-4', agent: 'overseer', ticket: null, kind: 'confirm', prompt: 'cancel curia-42?', payload: null, recommended: false, action: { verb: 'cancel' } }), { dataDir: DATA })
    assert.equal(e.title, 'Confirm · overseer')
    assert.equal(e.description, '❓ cancel curia-42?')
    assert.equal(e.footer, '✅ executes, and ❌ declines. This confirm lapses when its agent exits.\nesc-4')
    assert.equal(e.text, '❓ cancel curia-42?\n-# ✅ executes, and ❌ declines. This confirm lapses when its agent exits.\n-# esc-4')
  })

  test('attached files and lint faults are fields, in the order the message carries them', () => {
    const e = escalationEmbed(record({ id: 'esc-5', kind: 'free-text', recommended: false, prompt: '❓ Which?', payload: null, lint_flags: ['no headline'] }), { dataDir: DATA, files: [{ attachment: 'a.png' }] })
    assert.deepEqual(e.fields.map((f) => f.name), ['Attached files', 'How to answer', 'Sent with lint faults'])
    assert.equal(e.text, [
      '❓ Which?',
      '-# Attached files: `a.png`. Reply files return to this conversation as readable paths.',
      '_Reply in this thread to answer._',
      '-# A reply here may carry files. They land under `/data/attachments/esc-5/` and reach the agent as paths.',
      '-# ⚠️ curia sent this after 1 lint fault(s) the agent did not fix:\n-# no headline',
      '-# esc-5',
    ].join('\n'))
  })
})

// The reject-on-lint gate (#418), the mechanism ADR-0005 owns.
//
// Three rejections, then the text goes out flagged. The DAEMON counts, because
// an agent miscounts its own, and it counts in the journal, because the restart
// that kills a blocked call must not reset the count holding its author to
// three attempts.
//
// A schema fault takes the same path with one rule of its own: it never traps a
// question. At the cap curia sends whatever text the call did carry. A call
// carrying no text at all has nothing to send, so that one is refused for good.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Reduction } from '../src/reduction.mjs'
import { LintGate, REJECTION_CAP, flaggedResultText } from '../src/lintgate.mjs'
import { DiscordBridge } from '../src/bridge.mjs'
import { composeCard } from '../src/card.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-lintgate-test-'))

describe('the three-attempt cap', () => {
  let reduction, gate

  beforeEach(() => {
    reduction = new Reduction(tmp())
    gate = new LintGate({ reduction })
  })

  const judge = (faults, extra = {}) => gate.judge({
    agent: 'curia-418', kind: 'choice', faults, prompt: 'a card', payload: { headline: 'h' }, ...extra,
  })

  test('a clean call passes and says nothing', () => {
    assert.deepEqual(judge([]), { ok: true })
  })

  test('a fault is refused, and the refusal names the rule and counts down', () => {
    const r = judge(['headline: a semicolon. Write two sentences.'])
    assert.match(r.reject, /curia refused this call/)
    assert.match(r.reject, /attempt 1 of 3/)
    assert.match(r.reject, /headline: a semicolon/)
    assert.match(r.reject, /Keep every option and every constraint/)
  })

  test('the daemon counts, so the countdown moves whatever the agent believes', () => {
    assert.match(judge(['a']).reject, /attempt 1 of 3/)
    assert.match(judge(['a']).reject, /attempt 2 of 3/)
    assert.match(judge(['a']).reject, /attempt 3 of 3/)
    assert.equal(reduction.lintRejections('curia-418', 'choice'), REJECTION_CAP)
  })

  test('past the cap the text goes out flagged, and the agent is told', () => {
    for (let i = 0; i < REJECTION_CAP; i += 1) judge(['a'])
    const r = judge(['a', 'b'])
    assert.equal(r.ok, true)
    assert.deepEqual(r.flags, ['a', 'b'])
    assert.match(r.note, /flagged with 2 lint fault/)
    assert.match(r.note, /Do not call again about this question/)
  })

  test('the count is per call site: a gate and a question count apart', () => {
    judge(['a'])
    judge(['a'])
    assert.equal(reduction.lintRejections('curia-418', 'choice'), 2)
    assert.equal(reduction.lintRejections('curia-418', 'review-gate'), 0)
    assert.match(judge(['a'], { kind: 'review-gate' }).reject, /attempt 1 of 3/)
  })

  test('a clean call clears the ledger, so the next question starts fresh', () => {
    judge(['a'])
    judge(['a'])
    judge([])
    assert.equal(reduction.lintRejections('curia-418', 'choice'), 0)
    assert.match(judge(['a']).reject, /attempt 1 of 3/)
  })

  test('an opened record clears it too, which is what a flagged send does', () => {
    judge(['a'])
    judge(['a'])
    reduction.open({ agent: 'curia-418', ticket: '418', kind: 'choice', prompt: 'x' })
    assert.equal(reduction.lintRejections('curia-418', 'choice'), 0)
  })

  test('the count survives a restart: the ledger is a reduction, not a variable', () => {
    const dir = tmp()
    const first = new LintGate({ reduction: new Reduction(dir) })
    first.judge({ agent: 'curia-418', kind: 'choice', faults: ['a'] })
    first.judge({ agent: 'curia-418', kind: 'choice', faults: ['a'] })
    const after = new Reduction(dir)
    assert.equal(after.lintRejections('curia-418', 'choice'), 2)
    assert.match(new LintGate({ reduction: after }).judge({ agent: 'curia-418', kind: 'choice', faults: ['a'] }).reject, /attempt 3 of 3/)
  })
})

describe('a schema rejection never traps a question', () => {
  let reduction, gate

  beforeEach(() => {
    reduction = new Reduction(tmp())
    gate = new LintGate({ reduction })
  })

  const judge = (extra) => gate.judge({
    agent: 'curia-418', kind: 'choice', faults: ['options[0].consequence: missing.'], schema: true, ...extra,
  })

  test('the refusal says the payload is short, not that the words are wrong', () => {
    assert.match(judge({ hasText: true }).reject, /does not carry the fields this kind needs/)
  })

  test('a call that carried text sends it flagged at the cap', () => {
    for (let i = 0; i < REJECTION_CAP; i += 1) judge({ hasText: true })
    const r = judge({ hasText: true })
    assert.equal(r.ok, true)
    assert.ok(r.flags.length, 'the operator sees which fields were missing')
  })

  test('a call that carried NO text is refused for good, and says why', () => {
    for (let i = 0; i < REJECTION_CAP; i += 1) judge({ hasText: false })
    const r = judge({ hasText: false })
    assert.equal(r.ok, undefined)
    assert.match(r.refuse, /refused this call for good/)
    assert.match(r.refuse, /carried no text to send/)
    assert.match(r.refuse, /curia opened no card/)
  })
})

describe('what the Stop hook reads (#438)', () => {
  test('a pending rejection is readable by agent, across kinds', () => {
    const reduction = new Reduction(tmp())
    const gate = new LintGate({ reduction })
    assert.equal(gate.pending('curia-418'), null)
    gate.judge({ agent: 'curia-418', kind: 'free-text', faults: ['a'], prompt: 'the question' })
    const held = gate.pending('curia-418')
    assert.equal(held.kind, 'free-text')
    assert.equal(held.count, 1)
    assert.equal(held.prompt, 'the question')
    assert.equal(held.stop_blocks, 0)
  })

  test('the stop-block count lives daemon-side, because #447 found the flag sticky', () => {
    const reduction = new Reduction(tmp())
    const gate = new LintGate({ reduction })
    gate.judge({ agent: 'curia-418', kind: 'free-text', faults: ['a'] })
    reduction.journalLintStopBlock('curia-418', 'free-text')
    assert.equal(gate.pending('curia-418').stop_blocks, 1)
  })

  test('a cleared rejection is gone: the agent asked its question after all', () => {
    const reduction = new Reduction(tmp())
    const gate = new LintGate({ reduction })
    gate.judge({ agent: 'curia-418', kind: 'free-text', faults: ['a'] })
    reduction.clearLintRejections('curia-418', 'free-text')
    assert.equal(gate.pending('curia-418'), null)
  })
})

describe('the flagged card', () => {
  test('the faults ride the card, in small print, under the question', async () => {
    const sent = []
    const thread = { id: 't', name: '🎫 418', send: async (p) => { sent.push(p); return { id: 'm' } }, setName: async () => {} }
    const bridge = new DiscordBridge({ token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {} })
    bridge.channel = { id: 'C', send: async (p) => { sent.push(p); return { id: 'm' } } }
    bridge.client = { channels: { fetch: async () => thread } }
    bridge.ensureThread = async () => thread
    const payload = { headline: 'Pick one; then move on', options: [{ label: 'A', consequence: 'x' }] }
    await bridge.renderEscalation({
      id: 'esc-1', ticket: '418', agent: 'curia-418', kind: 'choice',
      prompt: composeCard('choice', payload), payload,
      options: ['A'],
      lint_flags: ['headline: a semicolon. Write two sentences.'],
    })
    const msg = sent.at(-1)
    assert.match(msg.content, /Pick one; then move on/, 'the text the operator judges is the text that failed')
    assert.match(msg.content, /-# ⚠️ curia sent this after 1 lint fault/)
    assert.match(msg.content, /-# headline: a semicolon/)
  })
})

describe('the ending report at the cap (#419)', () => {
  test('the flagged line speaks of a report, not of a question waiting on an answer', () => {
    const note = flaggedResultText(['summary: an em-dash. Write two sentences, or use a normal dash.'])
    assert.match(note, /sent your report as it stands/)
    assert.match(note, /flagged with 1 lint fault/)
    assert.match(note, /Do not call `report_result` again/)
    assert.doesNotMatch(note, /waiting for their answer/, 'nobody answers a report')
  })

  test('a report always has text, so its cap ends in a flagged send and never a dead end', () => {
    const reduction = new Reduction(tmp())
    const gate = new LintGate({ reduction })
    const judge = () => gate.judge({
      agent: 'curia-419', kind: 'report-result', faults: ['summary: missing.'], schema: true, hasText: true,
    })
    for (let i = 0; i < REJECTION_CAP; i += 1) judge()
    const r = judge()
    assert.equal(r.ok, true)
    assert.equal(r.refuse, undefined, 'an ending that reaches the thread flagged beats one that reaches it never')
  })

  test('a rejected report spends its own three attempts, not the one a question spends', () => {
    const reduction = new Reduction(tmp())
    const gate = new LintGate({ reduction })
    gate.judge({ agent: 'curia-419', kind: 'report-result', faults: ['a'] })
    gate.judge({ agent: 'curia-419', kind: 'report-result', faults: ['a'] })
    assert.equal(reduction.lintRejections('curia-419', 'report-result'), 2)
    assert.equal(reduction.lintRejections('curia-419', 'free-text'), 0)
  })
})

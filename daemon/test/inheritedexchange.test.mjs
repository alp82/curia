// A resumed agent inherits the exchange (#374, decided at #344).
//
// `resume` gave a fresh agent the surviving worktree and the model, and none of
// the words. So every question the operator had already answered was asked
// again, and the operator paid the expensive part twice, which is the wait.
//
// The cure is a PUSH, not a pull: no new tool, no query language, and no agent
// guessing what to search for. The daemon writes the recorded questions and
// answers into the next prompt out of the store it already holds.
//
// The store half is what this file pins. It is a reduction over records the
// journal already carried, so nothing new is written for it — `answeredExchangeFor`
// only asks a question `resume` never asked. The prompt half is in
// `prompt.test.mjs`, and the dispatch half in `dispatch.test.mjs`.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EscalationStore } from '../src/store.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'

let dir, store
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-exchange-'))
  store = new EscalationStore(dir)
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

// Ask and answer in one act. Every question must close before the next one
// opens, because a second OPEN record of one kind supersedes the first (#336).
function asked(prompt, answer, { kind = 'free-text', agent = 'curia-374', attachments = [] } = {}) {
  const { record } = store.open({ agent, ticket: '374', kind, prompt })
  if (answer !== null) store.answer(record.id, { answer, attachments, by: 'operator', via: 'discord' })
  return record
}

describe('the inherited exchange (#374)', () => {
  test('it reaches every dispatch the ticket has had, not only the dead agent', () => {
    // Rule 1. A builder session is `curia-<n>` for the ticket's whole life, so
    // one key already spans the history — no epoch boundary, and no new event.
    asked('round one', 'the first answer')
    store.logEvent('agent_spawned', { agent: 'curia-374', ticket: '374' })
    asked('round two', 'the second answer')

    const exchange = store.answeredExchangeFor('curia-374')
    assert.deepEqual(exchange.map((e) => e.prompt), ['round one', 'round two'])
  })

  test('it carries the question and the answer, both whole', () => {
    // Rule 2. "the first answer" says nothing without what was asked.
    asked('which store holds it?', 'the journal')
    assert.deepEqual(store.answeredExchangeFor('curia-374'), [
      { id: 'esc-1', kind: 'free-text', prompt: 'which store holds it?', answer: 'the journal', attachments: 0 },
    ])
  })

  test('a question nobody answered does not appear at all', () => {
    // Rule 3. A cancelled or lapsed record holds no answer, so it is a
    // parameter of nothing. The fresh agent asks it again, which is correct.
    const cancelled = asked('cancel me', null)
    store.cancel(cancelled.id, { by: 'operator' })
    const lapsed = asked('lapse me', null, { kind: 'confirm' })
    store.lapse(lapsed.id, 'the agent exited')
    asked('still open', null, { kind: 'choice' })
    asked('answered', 'yes')

    assert.deepEqual(store.answeredExchangeFor('curia-374').map((e) => e.prompt), ['answered'])
  })

  test('a superseded record stays out, and its live successor comes in', () => {
    // The same rule from the other side: a re-send closes the original at
    // birth (#336), and only the record that carries the answer is a parameter.
    const first = store.open({ agent: 'curia-374', ticket: '374', kind: 'free-text', prompt: 'round one' })
    const second = store.open({ agent: 'curia-374', ticket: '374', kind: 'free-text', prompt: 'round one, again' })
    assert.equal(store.get(first.record.id).status, 'superseded')
    store.answer(second.record.id, { answer: 'the answer', by: 'operator', via: 'discord' })

    assert.deepEqual(store.answeredExchangeFor('curia-374').map((e) => e.prompt), ['round one, again'])
  })

  test('every kind rides along, the review gate included', () => {
    // Rule 6. A gate rejection is the operator's own instruction, and it dies
    // with the agent that read it unless the next one is told.
    asked('a plain question', 'a plain answer')
    asked('pick one', 'the second', { kind: 'choice' })
    asked('is this done?', 'no — the cap is missing', { kind: REVIEW_KIND })

    assert.deepEqual(
      store.answeredExchangeFor('curia-374').map((e) => e.kind),
      ['free-text', 'choice', REVIEW_KIND],
    )
  })

  test('an answer\'s images travel as a count, never as a path', () => {
    // #34 hands an answer's images to the agent that asked, as tool-result
    // content. A path into the daemon's own disk would be a dead link in a
    // container, so the prompt is told how many there were and no more.
    asked('look at this', 'the left one', { attachments: ['/data/in/a.png', '/data/in/b.png'] })
    const [entry] = store.answeredExchangeFor('curia-374')
    assert.equal(entry.attachments, 2)
    assert.ok(!JSON.stringify(entry).includes('a.png'))
  })

  test('another agent\'s exchange is another agent\'s', () => {
    // The reviewer runs as `curia-review-<n>` on the same ticket, and the
    // overseer's confirms are nobody's dispatch. Neither is this ticket's
    // recorded exchange.
    asked('the builder was asked', 'and answered')
    asked('the reviewer was asked', 'and answered', { agent: 'curia-review-374' })

    assert.deepEqual(store.answeredExchangeFor('curia-374').map((e) => e.prompt), ['the builder was asked'])
    assert.deepEqual(store.answeredExchangeFor('curia-999'), [])
  })

  test('a restarted daemon replays the whole exchange off its journal', () => {
    // The guarantee is the journal, not any process's memory of a thread it
    // cannot read. A resume usually follows a restart, which is the case that
    // needs this most.
    asked('asked before the crash', 'answered before the crash')
    const rebooted = new EscalationStore(dir)
    assert.deepEqual(
      rebooted.answeredExchangeFor('curia-374').map((e) => e.answer),
      ['answered before the crash'],
    )
  })
})

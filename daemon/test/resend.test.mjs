// A re-sent escalation, and the record its agent finished past (#336).
//
// Two ghosts on the live box, one rule broken twice. A question the operator
// DID answer left its record open, and nothing ever closed it.
//
//   the re-send  — `curia-313` asked as `esc-267`, the call died with an
//                  error, and the standing orders say to make the same call
//                  once more. The agent added "(Re-sent: the last call timed
//                  out with an error…)" to explain itself. That note changed
//                  the payload hash, so the supersede key missed, and the
//                  original asked on after the operator answered the copy.
//   the result   — `curia-81` reported a result and merged its pull request.
//                  Its record was still open 200 hours later, because nothing
//                  read the result as an answer to "is anyone still asking".
//
// The keys settled here:
//   - supersede keys on the AGENT, not on the wording. An agent blocks inside
//     `ask_human`, so a second open record on one agent is always a corpse;
//   - the agent's own `report_result` closes every record still open on it;
//   - reconcile runs that same rule over the journal, so a result reported
//     under a previous daemon process still closes its record — and the
//     ending a Stop hook deferred to the corpse runs.
//
// Silence still resolves nothing (#285). Every close here needs a positive
// act by the agent: a new question, or a result.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Reduction, CONFIRM_KIND } from '../src/reduction.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-resend-test-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const ask = (reduction, prompt, agent = 'curia-313') =>
  reduction.open({ agent, ticket: '313', kind: 'free-text', prompt, recommended: true })

const RE_SENT = '\n\n(Re-sent: the last call timed out with an error, not with your answer.)'

describe('a re-send supersedes its original (#336)', () => {
  test('the note the agent adds to explain itself no longer costs the supersede', () => {
    const reduction = new Reduction(dir)
    const { record: original } = ask(reduction, 'Q1 — mint the checklist?')
    const { record: resent, superseded } = ask(reduction, `Q1 — mint the checklist?${RE_SENT}`)

    assert.equal(superseded?.id, original.id, 'the original is the record the re-send replaces')
    assert.equal(reduction.get(original.id).status, 'superseded')
    assert.equal(reduction.get(original.id).successor, resent.id)
    assert.deepEqual(reduction.openEscalations().map((r) => r.id), [resent.id], 'one live card, one question')
  })

  test('answering EITHER copy closes both — the answer routes to the live call', () => {
    const reduction = new Reduction(dir)
    const { record: original } = ask(reduction, 'which port?')
    const { record: resent } = ask(reduction, `which port?${RE_SENT}`)

    const r = reduction.answer(original.id, { answer: '9000', by: 'alp', via: 'thread' })

    assert.equal(r.ok, true)
    assert.equal(r.record.id, resent.id, 'the answer lands in the call that is still live')
    assert.deepEqual(r.routed_from, [original.id])
    assert.deepEqual(reduction.openEscalations(), [], 'neither record is left asking')
  })

  test('a wholly different question still closes the corpse it finds', () => {
    // The re-send is the common case, not the rule. What makes the old record
    // dead is that its call is gone, and the words never said otherwise.
    const reduction = new Reduction(dir)
    const { record: first } = ask(reduction, 'Q1 — which port?')
    const { superseded } = ask(reduction, 'Q2 — which repo?')

    assert.equal(superseded?.id, first.id)
    assert.equal(reduction.get(first.id).status, 'superseded')
  })

  test('several corpses close together, not one per new question', () => {
    // A journal written before this rule can hold more than one open record
    // for an agent. A corpse the call walks past would stay on the Needs-You
    // list for good.
    const reduction = new Reduction(dir)
    const a = ask(reduction, 'Q1').record
    // written straight to the journal, the way the payload-hash key that
    // shipped before #336 left them: two open records on one agent
    for (const id of ['esc-old-1', 'esc-old-2']) {
      reduction._append({ type: 'esc_open', id, agent: 'curia-313', ticket: '313', kind: 'free-text', prompt: `Q1 (${id})` })
    }

    const { record: live, superseded_all } = ask(reduction, 'Q1, once more')

    assert.deepEqual(superseded_all.map((r) => r.id), [a.id, 'esc-old-1', 'esc-old-2'])
    assert.deepEqual(reduction.openEscalations().map((r) => r.id), [live.id])
    assert.equal(reduction.answer('esc-old-1', { answer: 'ok', by: 'alp', via: 'thread' }).record.id, live.id)
  })

  test('another agent keeps its own question — the key is the agent, not the ticket', () => {
    const reduction = new Reduction(dir)
    const mine = ask(reduction, 'Q1', 'curia-313').record
    const theirs = ask(reduction, 'Q1', 'curia-330').record

    assert.equal(reduction.get(mine.id).status, 'open')
    assert.equal(reduction.get(theirs.id).status, 'open')
  })

  test('the review gate and a question are two calls, so neither closes the other', () => {
    // One agent CAN hold two calls at once and mean both: a harness that
    // backgrounds a pending `ask_human` leaves the question open while
    // `request_review` opens the gate. An approval routed into the free-text
    // call would be read there as an answer to the question.
    const reduction = new Reduction(dir)
    const question = ask(reduction, 'which port?').record
    const gate = reduction.open({ agent: 'curia-313', ticket: '313', kind: REVIEW_KIND, prompt: 'is this done?' })

    assert.equal(gate.superseded, null)
    assert.deepEqual(reduction.openEscalations().map((r) => r.id), [question.id, gate.record.id])
  })

  test('a confirm belongs to the operator, so no agent question touches it', () => {
    const reduction = new Reduction(dir)
    const confirm = reduction.open({
      agent: 'overseer', ticket: '313', kind: CONFIRM_KIND, prompt: 'Cancel?',
      action: { verb: 'cancel', targets: [{ session: 'curia-313', instance: 'curia-313@1' }] },
    }).record
    const { superseded } = ask(reduction, 'Q1')

    assert.equal(superseded, null)
    assert.equal(reduction.get(confirm.id).status, 'open', 'the buttons the operator is looking at stay live')
  })

  test('the supersession survives a replay, chain and all', () => {
    const reduction = new Reduction(dir)
    const original = ask(reduction, 'Q1').record
    const resent = ask(reduction, `Q1${RE_SENT}`).record

    const replayed = new Reduction(dir)
    assert.equal(replayed.get(original.id).status, 'superseded')
    assert.equal(replayed.resolveLive(original.id).record.id, resent.id)
  })
})

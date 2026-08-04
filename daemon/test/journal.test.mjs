// The journal in the old spelling (#184).
//
// Every line written before the rename says `worker` where curia now says
// `agent`, and `backend` where it now says `harness`. The file is append-only
// and never rewritten, so the translation happens at the two read edges. These
// tests use the real shapes off the deployment box's own journal.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EscalationStore, normalizeEvent } from '../src/store.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'curia-journal-'))
}

describe('the pre-#184 journal reads as one vocabulary', () => {
  test('a legacy type is translated, and only the word that moved', () => {
    assert.equal(normalizeEvent({ type: 'worker_spawned' }).type, 'agent_spawned')
    assert.equal(normalizeEvent({ type: 'worker_ready_timeout' }).type, 'agent_ready_timeout')
    // The one legacy type whose word is not the prefix.
    assert.equal(normalizeEvent({ type: 'escalation_worker_died' }).type, 'escalation_agent_died')
    // Nothing else is touched: `notify` and `reconcile` were always spelled
    // this way and must not acquire a translation nobody asked for.
    assert.equal(normalizeEvent({ type: 'notify' }).type, 'notify')
    assert.equal(normalizeEvent({ type: 'dispatch_claimed' }).type, 'dispatch_claimed')
  })

  test('the legacy fields move, and the old keys do not survive beside them', () => {
    // Verbatim off the box: docs/live-checks/194-tool-channel.md, line 47.
    const ev = normalizeEvent({
      type: 'worker_spawned', worker: 'curia-170', model: 'opus', backend: 'claude', sandbox: 'docker',
    })
    assert.deepEqual(ev, {
      type: 'agent_spawned', agent: 'curia-170', model: 'opus', harness: 'claude', sandbox: 'docker',
    })
    assert.equal('worker' in ev, false)
    assert.equal('backend' in ev, false)
  })

  test('a line already in the new spelling passes through untouched', () => {
    const ev = { type: 'agent_ready', agent: 'curia-9', harness: 'codex', ticket: '9' }
    assert.deepEqual(normalizeEvent(ev), ev)
  })

  test('a new-spelling key wins over a legacy one on the same line', () => {
    const ev = normalizeEvent({ type: 'agent_ready', worker: 'stale', agent: 'curia-3' })
    assert.equal(ev.agent, 'curia-3')
  })

  test('the input event is not mutated — the caller keeps its own line', () => {
    const raw = { type: 'worker_died', worker: 'curia-4' }
    normalizeEvent(raw)
    assert.deepEqual(raw, { type: 'worker_died', worker: 'curia-4' })
  })

  // The reducer is a pure reduction over the journal (ADR-0001), so a legacy
  // line has to rebuild the same in-memory state a fresh one does. This is the
  // whole reason the file is left alone.
  test('a legacy note queue replays onto the agent it was queued for', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', type: 'worker_note', worker: 'curia-5', text: 'look at the tail' }),
      '',
    ].join('\n'))
    const store = new EscalationStore(dir)
    assert.deepEqual(store.takeAgentNotes('curia-5').map((n) => n.text), ['look at the tail'])
  })

  test('a legacy escalation replays with its agent, and the died mark still lands', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({
        ts: '2026-08-01T10:00:00Z', type: 'esc_open', id: 'esc-1', worker: 'curia-6',
        ticket: '6', kind: 'free-text', prompt: 'which one?',
      }),
      JSON.stringify({ ts: '2026-08-01T10:05:00Z', type: 'escalation_worker_died', id: 'esc-1', worker: 'curia-6' }),
      '',
    ].join('\n'))
    const [open] = new EscalationStore(dir).openEscalations()
    assert.equal(open.agent, 'curia-6')
    assert.equal(open.agent_died, true)
  })
})

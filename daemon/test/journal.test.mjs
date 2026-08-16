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

  // #261 deleted the 30-minute tick, but 243 `esc_nudge` lines sit in the real
  // journal and the file is never rewritten. The replay has to walk straight
  // past them and rebuild the record whole.
  test('an escalation carrying the dead nudge events still replays', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({
        ts: '2026-08-01T10:00:00Z', type: 'esc_open', id: 'esc-1', agent: 'curia-7',
        ticket: '7', kind: 'free-text', prompt: 'which one?',
      }),
      JSON.stringify({ ts: '2026-08-01T10:30:00Z', type: 'esc_nudge', id: 'esc-1' }),
      JSON.stringify({ ts: '2026-08-01T11:00:00Z', type: 'esc_nudge', id: 'esc-1' }),
      '',
    ].join('\n'))
    const [open] = new EscalationStore(dir).openEscalations()
    assert.equal(open.prompt, 'which one?')
    assert.equal(open.status, 'open')
    assert.equal('nudges' in open, false, 'the counter nothing read is gone from the record')
  })
})

// The credential warnings still standing (#380). A reduction rather than a
// re-read, for the two reasons the coolings (#377) are one: the ladder must not
// re-say at every boot what it already said, and the Needs-you item has to
// survive the deploy that happens between the warning and the operator acting
// on it.
describe('the credential warnings survive the restart (#380)', () => {
  const dir = () => tmpdir()
  const warn = (over = {}) => ({
    holder: 'agent', key: 'GH_TOKEN_ALP82', repo: 'alp82/curia', fault: 'expiring',
    days: 3, step: 3, said: true, where: 'daemon/.env.daemon', refusal: 'r', ...over,
  })

  test('a warning is read back after a boot, with what it said', () => {
    const d = dir()
    new EscalationStore(d).logEvent('token_warned', warn())
    const [w] = new EscalationStore(d).standingTokenWarnings()
    assert.equal(w.key, 'GH_TOKEN_ALP82')
    assert.equal(w.step, 3)
    assert.equal(w.said, true)
  })

  test('a tighter step replaces the entry rather than adding a second', () => {
    const d = dir()
    const store = new EscalationStore(d)
    store.logEvent('token_warned', warn({ days: 10, step: 14 }))
    store.logEvent('token_warned', warn({ days: 2, step: 3 }))
    const back = new EscalationStore(d).standingTokenWarnings()
    assert.equal(back.length, 1)
    assert.equal(back[0].step, 3)
  })

  test('the expiry keys on the TOKEN, so a long watch list cannot repeat it', () => {
    const d = dir()
    const store = new EscalationStore(d)
    store.logEvent('token_warned', warn({ repo: 'alp82/curia' }))
    store.logEvent('token_warned', warn({ repo: 'alp82/aistack' }))
    assert.equal(new EscalationStore(d).standingTokenWarnings().length, 1)
  })

  test('a reach failure keys on the token AND the repo', () => {
    const d = dir()
    const store = new EscalationStore(d)
    const reach = { ...warn(), fault: 'unreachable', message: 'HTTP 404' }
    store.logEvent('token_warned', { ...reach, repo: 'alp82/curia' })
    store.logEvent('token_warned', { ...reach, repo: 'alp82/aistack' })
    assert.equal(new EscalationStore(d).standingTokenWarnings().length, 2)
  })

  test('a clear removes it, and a restart does not hand it back', () => {
    const d = dir()
    const store = new EscalationStore(d)
    store.logEvent('token_warned', warn())
    store.logEvent('token_cleared', { holder: 'agent', key: 'GH_TOKEN_ALP82', repo: 'alp82/curia', fault: 'expiring' })
    assert.deepEqual(new EscalationStore(d).standingTokenWarnings(), [])
  })

  test('one key is read on its own, which is what the ladder asks', () => {
    const d = dir()
    const store = new EscalationStore(d)
    store.logEvent('token_warned', warn())
    assert.equal(store.tokenWarning('agent:GH_TOKEN_ALP82').step, 3)
    assert.equal(store.tokenWarning('agent:GH_TOKEN_NOBODY'), null)
  })
})

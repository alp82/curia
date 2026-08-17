// The boot sweep wakes a codex agent a SIGKILL stranded (#489, building #457).
//
// A goodbye covers every death the daemon can see (#458). It cannot cover a
// SIGKILL, because the daemon never gets to speak — so a codex agent blocked in
// an `ask_human` sits in the dead call until `CODEX_TOOL_TIMEOUT_S`, a day out.
// [pane-keystroke-codex.md](../../docs/research/pane-keystroke-codex.md)
// measured the pane reaching that agent in about three seconds, and this is the
// sweep built on that reading.
//
// Three layers, each tested where it lives:
//   1. the words — one line, curia's own Escape, and never an answer
//   2. the gate — a death that said goodbye presses no key at all
//   3. the set — which agents get keystrokes, and on what evidence
//
// Layer 3 is where the cost of being wrong sits. #457 run 2 measured Escape on
// a call that is truly live: the abort is client-side only, so the daemon writes
// the human's answer into a socket nobody reads and closes the question as
// answered. Every exclusion below is one shape of that loss.

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Dispatcher } from '../src/dispatch.mjs'
import { Reduction } from '../src/reduction.mjs'
import { paneGoodbye, deathWasSilent, DAEMON_BOOT, DAEMON_GOODBYE } from '../src/goodbye.mjs'
import { lintReply } from '../src/messaging.mjs'

const dirs = []
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-panesweep-'))
  dirs.push(d)
  return d
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

// ---- 1. the words ------------------------------------------------------------

describe('what a freed codex agent reads (#489)', () => {
  const text = paneGoodbye({ id: 'esc-7' })

  test('it is ONE line, because a composer reads a newline as a submit', () => {
    assert.doesNotMatch(text, /\n/)
  })

  test("it says the Escape was curia's own act, not a human stopping the agent", () => {
    // Codex tells the model "The user interrupted the previous turn on purpose"
    // (#457, run 1). No user did, and an agent that believed one would take its
    // own question back rather than ask it again.
    assert.match(text, /CURIA's own act/)
    assert.match(text, /No human stopped you/)
  })

  test('it never reads as an answer, and it names the record still open', () => {
    assert.match(text, /THIS IS NOT AN ANSWER/)
    assert.match(text, /esc-7/)
    assert.match(text, /still open/)
    assert.match(text, /never decide the question yourself/)
    assert.doesNotMatch(text, /^ok\b/i)
  })

  test('it says ask again NOW — there is nothing left to wait for', () => {
    // The tool-channel goodbye names a 120-second sleep, because the daemon
    // that wrote it was about to die. This one is typed by the daemon that came
    // back, so the same wait would park the agent for no reason.
    assert.match(text, /again NOW/)
    assert.doesNotMatch(text, /sleep \d+/)
  })
})

// ---- 2. the gate -------------------------------------------------------------

describe('only a death with no last word opens the sweep (#489)', () => {
  test('a goodbye means every blocked call already ended with an error', () => {
    assert.equal(deathWasSilent(DAEMON_GOODBYE), false)
  })

  test('a boot line with nothing after it is the death the sweep exists for', () => {
    assert.equal(deathWasSilent(DAEMON_BOOT), true)
  })

  test('a journal carrying neither line reads as silent, which costs nothing', () => {
    assert.equal(deathWasSilent(null), true)
  })

  test('the journal answers with the last lifecycle line, whatever was written after it', () => {
    const r = new Reduction(tmpDir())
    assert.equal(r.questions.lastLifecycle(), null, 'a journal that has never held a daemon')

    r.journal(DAEMON_BOOT, { pid: 1 })
    r.journal('esc_open', { id: 'esc-1', agent: 'curia-7', ticket: '7' })
    assert.equal(r.questions.lastLifecycle(), DAEMON_BOOT, 'a process that started and never spoke again')

    r.journal(DAEMON_GOODBYE, { reason: 'sigterm', woken: 1 })
    r.journal('esc_answer', { id: 'esc-1' })
    assert.equal(r.questions.lastLifecycle(), DAEMON_GOODBYE, 'the goodbye is not the last row, only the last of the two')
  })
})

// ---- 3. the set --------------------------------------------------------------

describe('which agents the sweep touches (#489)', () => {
  let writes, notifies, events, escalations, d

  // A Dispatcher with the two pane writes captured and nothing else moving. The
  // sweep never spawns, claims or reads GitHub, so the doubles below are the
  // whole surface it stands on.
  const makeDispatcher = () => {
    writes = []
    notifies = []
    events = []
    escalations = []
    const root = tmpDir()
    return new Dispatcher({
      config: {
        watch: [{ repo: 'o/r', mode: 'auto' }],
        dispatch: {
          auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
          workspace_root: root, ready_timeout_s: 45, claim_login: 'me',
        },
      },
      routing: { models: {}, harnesses: {} },
      reduction: {
        journal: (type, detail) => { events.push({ type, ...detail }); return { type, ...detail } },
        openEscalations: () => escalations,
      },
      notify: (ticket, message) => notifies.push({ ticket, message }),
      log: () => {},
      dataDir: path.join(root, 'data'),
      deps: {
        sendKey: async (pane, key) => { writes.push({ pane, key }) },
        sendText: async (pane, body) => { writes.push({ pane, body }) },
      },
    })
  }

  // A parked codex agent: adopted under the record's own name, on the codex
  // harness, and with no contact against this process.
  const park = (session, ticket, { harness = 'codex', mcpLastAt = null } = {}) => {
    d.agents.set(session, { session, ticket, harness, mcpLastAt })
    const record = { id: `esc-${escalations.length + 1}`, status: 'open', kind: 'free-text', agent: session, ticket }
    escalations.push(record)
    return record
  }

  beforeEach(() => { d = makeDispatcher() })

  test('a parked codex agent gets Escape and THEN the words, on its own pane', async () => {
    const record = park('curia-7', '7')
    const out = await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(out.swept, ['curia-7'])
    assert.equal(writes.length, 2, 'both keys, and only those two')
    assert.deepEqual(writes[0], { pane: 'curia-7', key: 'Escape' })
    assert.equal(writes[1].pane, 'curia-7')
    assert.equal(writes[1].body, paneGoodbye({ id: record.id }))
    assert.ok(events.some((e) => e.type === 'pane_sweep_delivered' && e.agent === 'curia-7'))
  })

  test('a goodbye skips the whole sweep, and no key is pressed', async () => {
    park('curia-7', '7')
    const out = await d.sweepStrandedPanes({ silent: false })

    assert.deepEqual(out.swept, [])
    assert.deepEqual(writes, [])
    assert.ok(events.some((e) => e.type === 'pane_sweep_skipped'))
  })

  test('the claude lane is left alone — its client aborts a dropped call by itself', async () => {
    park('curia-8', '8', { harness: 'claude' })
    const out = await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(out.swept, [])
    assert.deepEqual(writes, [])
  })

  test('an agent that has spoken to THIS process is not parked, so it keeps its call', async () => {
    park('curia-9', '9', { mcpLastAt: Date.now() })
    await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(writes, [], 'a live call must never be aborted (#457, run 2)')
  })

  test('a record a live resolver holds is not swept', async () => {
    const record = park('curia-10', '10')
    await d.sweepStrandedPanes({ silent: true, hasResolver: (id) => id === record.id })

    assert.deepEqual(writes, [])
  })

  test('a record whose agent no pane was adopted under is not swept', async () => {
    escalations.push({ id: 'esc-1', status: 'open', agent: 'curia-11', ticket: '11' })
    await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(writes, [], 'no adopted session is no evidence the pane is theirs')
  })

  test('two open records on one agent get ONE Escape', async () => {
    park('curia-12', '12')
    escalations.push({ id: 'esc-2', status: 'open', agent: 'curia-12', ticket: '12' })
    await d.sweepStrandedPanes({ silent: true })

    // A second Escape would land on the turn the first one started.
    assert.equal(writes.filter((w) => w.key === 'Escape').length, 1)
    assert.equal(writes.length, 2)
  })

  test('every swept agent gets its own line, and the sweep is journalled whole', async () => {
    park('curia-13', '13')
    park('curia-14', '14')
    const out = await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(out.swept.sort(), ['curia-13', 'curia-14'])
    assert.equal(notifies.length, 2)
    assert.deepEqual(notifies.map((n) => n.ticket).sort(), ['13', '14'])
    const sweep = events.find((e) => e.type === 'pane_sweep')
    assert.deepEqual(sweep.agents.sort(), ['curia-13', 'curia-14'])
  })

  test('the line names the agent, the record and the act, and it speaks the signal set', async () => {
    const record = park('curia-15', '15')
    await d.sweepStrandedPanes({ silent: true })

    const [{ message }] = notifies
    assert.match(message, /curia-15/)
    assert.match(message, new RegExp(record.id))
    assert.match(message, /Escape/)
    assert.match(message, /Nothing was answered/)
    assert.deepEqual(lintReply(message), [])
  })

  test('a pane curia cannot reach says so, and the other agents are still swept', async () => {
    park('curia-16', '16')
    park('curia-17', '17')
    d.deps.sendKey = async (pane) => {
      if (pane === 'curia-16') throw new Error('no server running on /tmp/tmux-0/default')
      writes.push({ pane, key: 'Escape' })
    }
    const out = await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(out.swept, ['curia-17'])
    const failed = events.find((e) => e.type === 'pane_sweep_failed')
    assert.equal(failed.agent, 'curia-16')
    const said = notifies.find((n) => n.ticket === '16').message
    assert.match(said, /could NOT reach its pane/)
    assert.match(said, /cancel 16/)
    assert.deepEqual(lintReply(said), [])
  })
})

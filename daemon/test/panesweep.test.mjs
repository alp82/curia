// The boot sweep wakes a codex agent a SIGKILL stranded (#489, building #457).
//
// A goodbye covers every death the daemon can see (#458). It cannot cover a
// SIGKILL, because the daemon never gets to speak — so a codex agent blocked in
// an `ask_human` sits in the dead call until `CODEX_TOOL_TIMEOUT_S`, a day out.
// [pane-keystroke-codex.md](../../docs/research/pane-keystroke-codex.md)
// measured the pane reaching that agent in about three seconds, and this is the
// sweep built on that reading.
//
// #499 adds the OTHER agent that death strands: the builder parked on a
// cross-check verdict. It is blocked in the same sense and has no open record,
// so its evidence is the journal and its words say a verdict waits.
//
// Five layers, each tested where it lives:
//   1. the words — one line, curia's own Escape, and never an answer
//   2. the gate — a death that said goodbye presses no key at all
//   3. the record — whether any call was ever blocked on it
//   4. the set — which agents get keystrokes, and on what evidence
//   5. the park — which builders the journal says a park still holds
//
// Layer 4 is where the cost of being wrong sits. #457 run 2 measured Escape on
// a call that is truly live: the abort is client-side only, so the daemon writes
// the human's answer into a socket nobody reads and closes the question as
// answered. Every exclusion below is one shape of that loss.

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Dispatcher } from '../src/dispatch.mjs'
import { Reduction, CONFIRM_KIND } from '../src/reduction.mjs'
import { paneGoodbye, parkPaneGoodbye, deathWasSilent, DAEMON_BOOT, DAEMON_GOODBYE } from '../src/goodbye.mjs'
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

describe('what a freed parked builder reads (#499)', () => {
  const text = parkPaneGoodbye({ on: 'gate' })

  test('it is ONE line, because a composer reads a newline as a submit', () => {
    assert.doesNotMatch(text, /\n/)
  })

  test("it says the Escape was curia's own act, not a human stopping the agent", () => {
    assert.match(text, /CURIA's own act/)
    assert.match(text, /No human stopped you/)
  })

  test('it never reads as a verdict, and it says nothing of its own is open', () => {
    // The question text says a card is still in front of the operator. Here the
    // gate press CLOSED that record, so the same words would name a card that
    // does not exist.
    assert.match(text, /THIS IS NOT A VERDICT/)
    assert.match(text, /nothing was approved, nothing was rejected/)
    assert.doesNotMatch(text, /THIS IS NOT AN ANSWER/)
  })

  test('it says the verdict is held rather than lost, and what the call hands back', () => {
    assert.match(text, /The verdict is not lost/)
    assert.match(text, /curia holds every verdict that lands/)
    assert.match(text, /hands you the verdict if it has landed/)
    assert.match(text, /parks you back on the reviewer if it has not/)
  })

  test('it names the call the builder was parked inside, and only that one', () => {
    assert.match(text, /`request_review`/)
    assert.doesNotMatch(text, /`report_result`/)
    assert.match(parkPaneGoodbye({ on: 'ending' }), /`report_result`/)
    assert.doesNotMatch(parkPaneGoodbye({ on: 'ending' }), /`request_review`/)
  })

  test('it says call again NOW — there is nothing left to wait for', () => {
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

// ---- 3. the record says whether a call was blocked on it ----------------------

describe('a record carries whether any call was waiting on it (#489)', () => {
  test('an ask_human is awaited, a flagged send is not, and a confirm is not', () => {
    const r = new Reduction(tmpDir())
    const asked = r.open({ agent: 'curia-7', ticket: '7', kind: 'free-text', prompt: 'q', awaited: true }).record
    const flagged = r.open({ agent: 'curia-8', ticket: '8', kind: 'free-text', prompt: 'q', awaited: false }).record
    const confirm = r.open({ agent: 'overseer', ticket: '9', kind: CONFIRM_KIND, prompt: 'q' }).record

    assert.equal(asked.awaited, true)
    assert.equal(flagged.awaited, false, 'the agent read that rejection and worked on (#418)')
    assert.equal(confirm.awaited, null, 'a confirm is waited on by nobody (#94)')
  })

  test('it survives the restart, because the sweep reads it a whole process later', () => {
    const dir = tmpDir()
    const id = new Reduction(dir).open({ agent: 'curia-7', ticket: '7', kind: 'free-text', prompt: 'q', awaited: true }).record.id
    assert.equal(new Reduction(dir).get(id).awaited, true)
  })
})

// ---- 4. the set --------------------------------------------------------------

describe('which agents the sweep touches (#489)', () => {
  let writes, notifies, events, escalations, parks, d

  // A Dispatcher with the two pane writes captured and nothing else moving. The
  // sweep never spawns, claims or reads GitHub, so the doubles below are the
  // whole surface it stands on.
  const makeDispatcher = () => {
    writes = []
    notifies = []
    events = []
    escalations = []
    parks = []
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
        questions: { parkedBuilders: () => parks },
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
    const record = { id: `esc-${escalations.length + 1}`, status: 'open', kind: 'free-text', agent: session, ticket, awaited: true }
    escalations.push(record)
    return record
  }

  // A builder the journal says is parked on a cross-check verdict (#499): the
  // same adopted codex pane, and a park the journal rebuilt instead of a record.
  const parkedOnVerdict = (session, ticket, { on = 'gate', harness = 'codex', mcpLastAt = null } = {}) => {
    d.agents.set(session, { session, ticket, harness, mcpLastAt })
    parks.push({ ticket, agent: session, repo: 'o/r', on })
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
    escalations.push({ id: 'esc-1', status: 'open', agent: 'curia-11', ticket: '11', awaited: true })
    await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(writes, [], 'no adopted session is no evidence the pane is theirs')
  })

  test('a record no call was ever blocked on is not swept', async () => {
    // The flagged send (#418): the agent's own call already returned the
    // rejection, so that agent is WORKING. Escape would abort a live tool call.
    d.agents.set('curia-18', { session: 'curia-18', ticket: '18', harness: 'codex', mcpLastAt: null })
    escalations.push({ id: 'esc-1', status: 'open', agent: 'curia-18', ticket: '18', awaited: false })
    await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(writes, [])
  })

  test('a record written before the field existed presses no key either', async () => {
    d.agents.set('curia-19', { session: 'curia-19', ticket: '19', harness: 'codex', mcpLastAt: null })
    escalations.push({ id: 'esc-1', status: 'open', agent: 'curia-19', ticket: '19', awaited: null })
    await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(writes, [], 'null is not known to be awaited, and doubt presses no key')
  })

  test('two open records on one agent get ONE Escape', async () => {
    park('curia-12', '12')
    escalations.push({ id: 'esc-2', status: 'open', agent: 'curia-12', ticket: '12', awaited: true })
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

  // ---- the second set: a builder parked on a cross-check verdict (#499) ------

  test('a builder parked on a verdict gets Escape and THEN the park words', async () => {
    parkedOnVerdict('curia-20', '20')
    const out = await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(out.swept, ['curia-20'])
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[0], { pane: 'curia-20', key: 'Escape' })
    assert.equal(writes[1].body, parkPaneGoodbye({ on: 'gate' }))
    assert.ok(events.some((e) => e.type === 'pane_sweep_delivered' && e.agent === 'curia-20' && e.on === 'gate'))
  })

  test('a builder parked inside report_result reads about report_result', async () => {
    parkedOnVerdict('curia-21', '21', { on: 'ending' })
    await d.sweepStrandedPanes({ silent: true })

    // Sending a builder back to a gate it has passed is the loop #48 refused.
    assert.equal(writes[1].body, parkPaneGoodbye({ on: 'ending' }))
    assert.match(writes[1].body, /`report_result`/)
    assert.doesNotMatch(writes[1].body, /`request_review`/)
  })

  test('a park THIS process holds is not swept, whatever the journal says', async () => {
    parkedOnVerdict('curia-22', '22')
    d.reviewWaits.set('22', { agent: 'curia-22', on: 'gate', resolve: () => {}, reject: () => {} })
    await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(writes, [], 'the builder re-parked between the reconcile and this pass (#237)')
  })

  test('the claude lane and an agent that has spoken to this process keep their call', async () => {
    parkedOnVerdict('curia-23', '23', { harness: 'claude' })
    parkedOnVerdict('curia-24', '24', { mcpLastAt: Date.now() })
    parks.push({ ticket: '25', agent: 'curia-25', repo: 'o/r', on: 'gate' })
    await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(writes, [], 'and no pane was adopted for curia-25 at all')
  })

  test('a goodbye skips the parked builders too', async () => {
    parkedOnVerdict('curia-26', '26')
    const out = await d.sweepStrandedPanes({ silent: false })

    assert.deepEqual(out.swept, [])
    assert.deepEqual(writes, [])
  })

  test('an agent in both sets gets ONE Escape, and reads the record words', async () => {
    // An agent is blocked inside ONE call, so the two sets never both hold it.
    // The `seen` set is what makes that structural rather than a claim.
    const record = park('curia-27', '27')
    parkedOnVerdict('curia-27', '27')
    await d.sweepStrandedPanes({ silent: true })

    assert.equal(writes.filter((w) => w.key === 'Escape').length, 1)
    assert.equal(writes[1].body, paneGoodbye({ id: record.id }))
  })

  test('the line says a verdict waits, names the call, and speaks the signal set', async () => {
    parkedOnVerdict('curia-28', '28')
    await d.sweepStrandedPanes({ silent: true })

    const [{ message }] = notifies
    assert.match(message, /curia-28/)
    assert.match(message, /Escape/)
    assert.match(message, /request_review/)
    assert.match(message, /holds the verdict/)
    assert.match(message, /Nothing was approved and nothing was rejected/)
    assert.deepEqual(lintReply(message), [])
  })

  test('a park pane curia cannot reach says so, and names the hand-over', async () => {
    parkedOnVerdict('curia-29', '29', { on: 'ending' })
    d.deps.sendKey = async () => { throw new Error('no server running on /tmp/tmux-0/default') }
    const out = await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(out.swept, [])
    const failed = events.find((e) => e.type === 'pane_sweep_failed')
    assert.equal(failed.on, 'ending')
    const said = notifies.find((n) => n.ticket === '29').message
    assert.match(said, /could NOT reach its pane/)
    assert.match(said, /report_result/)
    assert.match(said, /cancel 29/)
    assert.deepEqual(lintReply(said), [])
  })

  test('an unconfirmed pane write does not claim that the parked agent woke', async () => {
    park('curia-29', '29')
    d.deps.sendText = async () => ({ status: 'unconfirmed', pane: 'idle' })

    const out = await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(out.swept, [])
    assert.ok(events.some((e) => e.type === 'pane_sweep_unconfirmed'))
    assert.ok(!events.some((e) => e.type === 'pane_sweep_delivered'))
    assert.match(notifies.at(-1).message, /Check the pane before you retry/)
  })

  test('the sweep journals which agents came from the park set', async () => {
    park('curia-30', '30')
    parkedOnVerdict('curia-31', '31')
    await d.sweepStrandedPanes({ silent: true })

    const sweep = events.find((e) => e.type === 'pane_sweep')
    assert.deepEqual(sweep.agents.sort(), ['curia-30', 'curia-31'])
    assert.deepEqual(sweep.parked, ['curia-31'])
  })

  test('a journal that cannot be read presses no key for a parked builder', async () => {
    parkedOnVerdict('curia-32', '32')
    d.reduction.questions.parkedBuilders = () => { throw new Error('events journal is unreadable: disk I/O error') }
    const out = await d.sweepStrandedPanes({ silent: true })

    assert.deepEqual(out.swept, [])
    assert.deepEqual(writes, [], 'doubt presses no key, and the record set stands on its own')
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

// ---- 5. the park, rebuilt from the journal (#499) ----------------------------
//
// `reviewWaits` dies with the process, so nothing durable says a builder was
// parked. The journal is the only evidence, and these are the lines that carry
// it: one of three openers, each written from inside the call that then parks,
// and `cross_check_returned` when that call is handed back.

describe('which builders the journal says a park still holds (#499)', () => {
  const boot = (r) => { r.journal(DAEMON_BOOT, { pid: 1 }); return r.questions.lastBootAt() }

  test('an opener with no return is a park, and it names the call', () => {
    const r = new Reduction(tmpDir())
    const since = boot(r)
    r.journal('cross_check_requested', { repo: 'o/r', ticket: '42', agent: 'curia-42' })

    assert.deepEqual(r.questions.parkedBuilders(since), [
      { ticket: '42', agent: 'curia-42', repo: 'o/r', on: 'gate' },
    ])
  })

  test('an opener whose call was handed back is no park at all', () => {
    const r = new Reduction(tmpDir())
    const since = boot(r)
    r.journal('cross_check_requested', { repo: 'o/r', ticket: '42', agent: 'curia-42' })
    r.journal('cross_check_returned', { repo: 'o/r', ticket: '42', agent: 'curia-42', ok: true })

    assert.deepEqual(r.questions.parkedBuilders(since), [], 'that builder read the verdict and worked on')
  })

  test('the ending hold is its own call, and the words have to say so', () => {
    const r = new Reduction(tmpDir())
    const since = boot(r)
    r.journal('result_parked', { repo: 'o/r', ticket: '42', agent: 'curia-42', reason: 'cross-check in flight' })

    assert.equal(r.questions.parkedBuilders(since)[0].on, 'ending')
  })

  test('a rejoin re-parks a ticket the last round already returned', () => {
    const r = new Reduction(tmpDir())
    const since = boot(r)
    r.journal('cross_check_requested', { repo: 'o/r', ticket: '42', agent: 'curia-42' })
    r.journal('cross_check_returned', { repo: 'o/r', ticket: '42', agent: 'curia-42', ok: true })
    r.journal('cross_check_rejoined', { repo: 'o/r', ticket: '42', agent: 'curia-42' })

    assert.equal(r.questions.parkedBuilders(since).length, 1)
    assert.equal(r.questions.parkedBuilders(since)[0].on, 'gate')
  })

  test('a return that lands AFTER the newer opener still leaves one park open', () => {
    // #237's rejoin journals its opener, then takes the wait from the older
    // call — whose own `cross_check_returned` lands one microtask later, after
    // that opener. Comparing the last of each would read this ticket as free.
    const r = new Reduction(tmpDir())
    const since = boot(r)
    r.journal('cross_check_requested', { repo: 'o/r', ticket: '42', agent: 'curia-42' })
    r.journal('cross_check_rejoined', { repo: 'o/r', ticket: '42', agent: 'curia-42' })
    r.journal('cross_check_returned', { repo: 'o/r', ticket: '42', agent: 'curia-42', ok: false, why: 'a newer call' })

    assert.equal(r.questions.parkedBuilders(since).length, 1, 'two openers, one return, one builder still parked')
  })

  test('a park from an earlier life is not this death, so no key is pressed for it', () => {
    const r = new Reduction(tmpDir())
    r.journal(DAEMON_BOOT, { pid: 1 })
    r.journal('cross_check_requested', { repo: 'o/r', ticket: '42', agent: 'curia-42' })
    const since = boot(r)

    assert.deepEqual(r.questions.parkedBuilders(since), [], 'a park lives inside one process')
  })

  test('a reviewer spawned from the thread proves a reviewer and never a park', () => {
    const r = new Reduction(tmpDir())
    const since = boot(r)
    r.journal('reviewer_spawned', { repo: 'o/r', ticket: '42', agent: 'curia-review-42' })

    assert.deepEqual(r.questions.parkedBuilders(since), [], 'the builder works on until it asks for the gate')
  })

  test('every parked ticket answers once, whatever its opener count', () => {
    const r = new Reduction(tmpDir())
    const since = boot(r)
    r.journal('cross_check_requested', { repo: 'o/r', ticket: '42', agent: 'curia-42' })
    r.journal('result_parked', { repo: 'o/r', ticket: '43', agent: 'curia-43', reason: 'cross-check in flight' })
    r.journal('cross_check_rejoined', { repo: 'o/r', ticket: '43', agent: 'curia-43' })

    const parked = r.questions.parkedBuilders(since)
    assert.deepEqual(parked.map((p) => p.ticket), ['42', '43'])
    assert.equal(parked[1].on, 'gate', 'the LAST opener says which call it sits in now')
  })

  test('the boot id is the last daemon\'s, read before this process writes its own', () => {
    const r = new Reduction(tmpDir())
    assert.equal(r.questions.lastBootAt(), 0, 'a journal that has never held a daemon')

    r.journal(DAEMON_BOOT, { pid: 1 })
    const first = r.questions.lastBootAt()
    assert.ok(first > 0)

    r.journal('cross_check_requested', { repo: 'o/r', ticket: '42', agent: 'curia-42' })
    r.journal(DAEMON_BOOT, { pid: 2 })
    assert.ok(r.questions.lastBootAt() > first, 'the second life starts after the first one ends')
  })
})

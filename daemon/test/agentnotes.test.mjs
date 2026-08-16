// The agent-note queue (#108 item 14, positive half): operator text in an
// agent-bound thread with no open escalation queues here and rides the
// agent's next tool result. The grace window tags a note typed just after an
// answered escalation with that escalation's id.

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Reduction, noteDisposition } from '../src/reduction.mjs'
import { COMMAND_SHAPED, QUESTION_SHAPED, commandHint, queuedNoteReply, statusAnswer } from '../src/bridge.mjs'
import { parseCommand } from '../src/commands.mjs'

describe('agent-note queue', () => {
  let dir, reduction
  const dirs = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-notes-'))
    dirs.push(dir)
    reduction = new Reduction(dir)
  })

  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

  test('a note queues, drains once, and the drain is journalled', () => {
    reduction.queueAgentNote('curia-9', 'D could be mentioned as well', { by: 'alp' })
    reduction.queueAgentNote('curia-9', 'also check mobile', { by: 'alp' })
    const notes = reduction.takeAgentNotes('curia-9')
    assert.deepEqual(notes.map((n) => n.text), ['D could be mentioned as well', 'also check mobile'])
    assert.deepEqual(reduction.takeAgentNotes('curia-9'), [], 'drained means gone')
  })

  test('notes are per agent — another session drains nothing', () => {
    reduction.queueAgentNote('curia-9', 'for nine', {})
    assert.deepEqual(reduction.takeAgentNotes('curia-4'), [])
    assert.equal(reduction.takeAgentNotes('curia-9').length, 1)
  })

  test('a note inside the grace window is tagged with the just-closed escalation', () => {
    const { record } = reduction.open({ agent: 'curia-9', ticket: '9', kind: 'choice', prompt: 'A or B?', options: ['A', 'B'] })
    reduction.answer(record.id, { answer: 'B', by: 'alp', via: 'button' })
    const { after } = reduction.queueAgentNote('curia-9', 'D could be mentioned as well', {})
    assert.equal(after, record.id)
    const [note] = reduction.takeAgentNotes('curia-9')
    assert.equal(note.after, record.id)
  })

  test('outside the grace window the tag is off — the note stands alone', () => {
    const { record } = reduction.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    reduction.answer(record.id, { answer: 'x', by: 'alp', via: 'button' })
    const { after } = reduction.queueAgentNote('curia-9', 'much later thought', {
      now: Date.now() + 10 * 60_000,
    })
    assert.equal(after, null)
  })

  test('an OPEN escalation never tags — only closed records are "just answered"', () => {
    reduction.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'still open' })
    const { after } = reduction.queueAgentNote('curia-9', 'note while open', {})
    assert.equal(after, null)
  })

  // #108 item 23: "Cancel" typed at an agent thread queues as prose, so the
  // bridge's reply must name the way out. The detection is this regex — a
  // message that is nothing but a command.
  test('a bare command verb is detected, with case and punctuation forgiven', () => {
    for (const s of ['cancel', 'Cancel', 'STOP', 'pause', 'resume', 'status', 'cancel!', ' stop. ', 'status?']) {
      assert.ok(COMMAND_SHAPED.test(s), `"${s}" should read as a command`)
    }
  })

  // #170: the verb WITH its ticket is the surface's own syntax, and the more
  // natural thing to type. It was the one shape that got no hint at all — an
  // operator waited an hour on a `cancel 166` that had queued as prose.
  test('a verb with its ticket is detected too — the shape that cost an hour', () => {
    for (const s of ['cancel 166', 'Cancel #166', 'resume 12', 'start 166', 'attach 166', 'cancel all', 'resume all.']) {
      assert.ok(COMMAND_SHAPED.test(s), `"${s}" should read as a command`)
    }
  })

  // Every argument form parseCommand takes is a form the operator types. The
  // repo-qualified one is what this map's notes tell them to type, so a guard
  // that missed it repeated the miss the ticket is about.
  test('the repo-qualified ticket and the option overrides are commands too', () => {
    for (const s of ['start curia#170', 'start alp82/curia#170', 'start 170 model=sonnet', 'start curia#170 harness=codex', 'cancel curia#166']) {
      assert.ok(COMMAND_SHAPED.test(s), `"${s}" should read as a command`)
    }
  })

  test('a verb inside a sentence is a real note, not a swallowed command', () => {
    for (const s of ['cancel the deploy', 'please stop', 'status of the tests?', 'do not pause here', 'ok', 'cancel 166 once the tests pass', 'start curia#170 after lunch']) {
      assert.ok(!COMMAND_SHAPED.test(s), `"${s}" should read as prose`)
    }
  })

  // #221: `map` carries a whole operator sentence after `--`, and a sentence is
  // what a note IS. Only the bare form is command-shaped, so the instruction
  // form still queues as prose instead of being swallowed by the hint.
  test('a map instruction is prose, and a bare map is a command', () => {
    assert.ok(COMMAND_SHAPED.test('map 147'))
    assert.ok(!COMMAND_SHAPED.test('map 147 -- add a ticket for the cooling signal'))
    assert.ok(!COMMAND_SHAPED.test('map out the fallback chain before you start'))
  })

  // The hint names a command the channel accepts, about the ticket the operator
  // asked about — not the one whose thread they happened to type it in.
  test('the operator\'s own argument wins over the thread it was typed in', () => {
    assert.match(commandHint('cancel 138', '166', 'C1'), /say `cancel 138` there/)
    assert.match(commandHint('stop 138', '166', 'C1'), /say `cancel 138` there/)
    // a bare verb still falls back to the thread's ticket
    assert.match(commandHint('cancel', '166', 'C1'), /say `cancel 166` there/)
  })

  test('the hint names a form the router parses', () => {
    // `#166` and `curia#166` are not forms `cancel` takes — the number is
    assert.match(commandHint('cancel #166', '166', 'C1'), /say `cancel 166` there/)
    assert.match(commandHint('cancel curia#166', '166', 'C1'), /say `cancel 166` there/)
    // `start` and `map` are the verbs that take the repo-qualified ticket
    assert.match(commandHint('start curia#170', '166', 'C1'), /say `start curia#170` there/)
    assert.match(commandHint('start alp82/curia#170', '166', 'C1'), /say `start alp82\/curia#170` there/)
    assert.match(commandHint('map curia#147', '166', 'C1'), /say `map curia#147` there/)
    // A bare `#170` is not the repo-qualified form — it is the number with a
    // `#` on it, and no verb parses that. Found by #221's `map #147` case, and
    // `start` had carried the same miss.
    assert.match(commandHint('start #170', '166', 'C1'), /say `start 170` there/)
    assert.match(commandHint('map #147', '166', 'C1'), /say `map 147` there/)
    // `all` rides through on the verbs that take it, and not on the one that does not
    assert.match(commandHint('cancel all', '166', 'C1'), /say `cancel all` there/)
    assert.match(commandHint('attach all', '166', 'C1'), /say `attach 166` there/)
  })

  // The claim above is the router's to make, not the hint's: every command the
  // hint tells the operator to type goes through the real parseCommand. A hint
  // that names a command the channel refuses is the same dead end in one more
  // step.
  test('every command the hint names parses — checked against the real router', () => {
    const typed = [
      'cancel', 'Cancel', 'stop', 'pause', 'resume', 'status', 'cancel 166', 'cancel #166',
      'cancel curia#166', 'cancel all', 'resume 12', 'resume all', 'attach 166', 'attach all',
      'start 170', 'start curia#170', 'start alp82/curia#170', 'start 170 model=sonnet', 'start #170',
      // #221: `map` is a verb now, so a bare one typed at an agent must reach
      // the hint rather than the note queue.
      'map', 'map 147', 'map #147', 'map curia#147', 'map all', 'map 147 model=opus',
    ]
    for (const t of typed) {
      assert.ok(COMMAND_SHAPED.test(t), `"${t}" should read as a command`)
      const said = /say `([^`]+)` there/.exec(commandHint(t, '166', 'C1'))?.[1]
      assert.ok(said, `no command named for "${t}"`)
      assert.ok(parseCommand(said), `the hint for "${t}" names \`${said}\`, which the router refuses`)
    }
  })

  // The hint names the channel, because that is the whole difference between
  // the words working and the words queueing.
  test('the hint names the command the operator meant, and where it runs', () => {
    assert.equal(commandHint('cancel 166', '166', 'C1'), 'commands run in <#C1>, never in a ticket thread — say `cancel 166` there')
    // stop and pause are not verbs the surface has; at an agent they mean cancel
    assert.match(commandHint('stop', '166', 'C1'), /say `cancel 166` there/)
    assert.match(commandHint('pause', '166', 'C1'), /say `cancel 166` there/)
    // status is the one verb that takes no ticket
    assert.match(commandHint('status', '166', 'C1'), /say `status` there/)
    assert.match(commandHint('resume', null, 'C1'), /say `resume <n>` there/)
  })

  // #170: the reply promised "it reads this with its next tool result" for an
  // agent that had already died on its own command line. An hour of waiting
  // came out of that one sentence.
  test('the reply refuses to promise a delivery a dead agent cannot make', () => {
    const dead = queuedNoteReply({ owner: 'curia-166', q: { reads: false, ticket: '166' }, text: 'look at the logs', channelId: 'C1' })
    assert.equal(dead.length, 1, 'prose gets no command hint')
    assert.match(dead[0], /NOT running/)
    assert.match(dead[0], /resume 166/)
    assert.ok(!dead[0].includes('next tool result'), 'the promise must not survive on a dead agent')
    // #208 took the queue away as well, so the line must not imply one
    assert.match(dead[0], /nothing was queued/)
    assert.ok(!/^queued/.test(dead[0]), 'nothing was queued, so the line may not open with "queued"')

    const live = queuedNoteReply({ owner: 'curia-9', q: { reads: true, ticket: '9' }, text: 'look at the logs', channelId: 'C1' })
    assert.match(live[0], /reads this with its next tool result/)
  })

  test('an unknown liveness keeps the old promise — only positive evidence demotes it', () => {
    const [line] = queuedNoteReply({ owner: 'curia-9', q: { ticket: '9' }, text: 'hi', channelId: 'C1' })
    assert.match(line, /next tool result/)
  })

  test('a command at a dead agent says BOTH — nothing reads it, and where it runs', () => {
    const lines = queuedNoteReply({ owner: 'curia-166', q: { reads: false, ticket: '166' }, text: 'cancel 166', channelId: 'C1' })
    assert.equal(lines.length, 2)
    assert.match(lines[0], /NOT running/)
    assert.match(lines[1], /commands run in <#C1>/)
    assert.match(lines[1], /`cancel 166`/)
  })

  test('the grace-window tag still rides the live line', () => {
    const [line] = queuedNoteReply({ owner: 'curia-9', q: { reads: true, ticket: '9', after: 'esc-13' }, text: 'and one more thing', channelId: 'C1' })
    assert.match(line, /noted as after esc-13/)
  })

  // The recorded-answer hand-off (#139): an answer nothing live received is
  // re-queued as an agent note, so the resumed agent gets question and answer
  // on its first tool result.
  test('escalation_agent_died marks the record, and the mark survives a restart', () => {
    const { record } = reduction.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    reduction.journal('escalation_agent_died', { id: record.id, agent: 'curia-9', ticket: '9' })
    assert.equal(reduction.get(record.id).agent_died, true)
    const reborn = new Reduction(dir)
    assert.equal(reborn.get(record.id).agent_died, true)
  })

  test('queueRecordedAnswer queues question and answer, tagged with the escalation id', () => {
    const { record } = reduction.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'deploy to staging first?' })
    reduction.answer(record.id, { answer: 'yes, staging first', by: 'alp', via: 'button' })
    reduction.queueRecordedAnswer(reduction.get(record.id))
    const [note] = reduction.takeAgentNotes('curia-9')
    assert.equal(note.after, record.id)
    assert.match(note.text, /deploy to staging first\?/)
    assert.match(note.text, /yes, staging first/)
  })

  test('the hand-off note names attachment paths so a fresh agent can read them', () => {
    const { record } = reduction.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'q' })
    reduction.answer(record.id, { answer: 'see the screenshot', attachments: ['/data/attachments/esc-1/image.png'], by: 'alp', via: 'thread' })
    reduction.queueRecordedAnswer(reduction.get(record.id))
    const [note] = reduction.takeAgentNotes('curia-9')
    assert.match(note.text, /\/data\/attachments\/esc-1\/image\.png/)
  })

  // #208: the ruling. Words typed at an agent are about what THAT agent was
  // doing, so they die with it. The caller is what marks the two kinds apart:
  // thread text names the instance it was typed at, the #139 hand-off names
  // none, because reaching the successor is its whole point.
  describe('a note expires with the instance it was addressed to (#208)', () => {
    test('a stamped note dies with its instance, an unstamped one lives on', () => {
      reduction.queueAgentNote('curia-166', 'cancel 166', { instance: 'curia-166@1' })
      reduction.queueRecordedAnswer({ id: 'esc-3', agent: 'curia-166', prompt: 'ship it?', answer: 'yes' })

      // #252: expiry hands back the notes themselves, not a count — a dead
      // verdict is posted in full and a number cannot carry it.
      assert.deepEqual(reduction.expireAgentNotes('curia-166', null).map((n) => n.text), ['cancel 166'])
      const [survivor, ...rest] = reduction.takeAgentNotes('curia-166')
      assert.deepEqual(rest, [], 'exactly one note survived')
      assert.match(survivor.text, /a human answered esc-3/)
    })

    test('the successor never reads its predecessor\'s words, even if no exit path ran', () => {
      reduction.queueAgentNote('curia-166', 'cancel 166', { instance: 'curia-166@15:13' })
      // the #170 run: a fresh agent takes the session name an hour later
      assert.deepEqual(reduction.takeAgentNotes('curia-166', 'curia-166@16:36'), [])
    })

    test('the instance that WAS addressed still reads its own notes', () => {
      reduction.queueAgentNote('curia-166', 'look at the tail', { instance: 'curia-166@1' })
      assert.deepEqual(reduction.takeAgentNotes('curia-166', 'curia-166@1').map((n) => n.text), ['look at the tail'])
    })

    test('expiry is journalled, so a restart does not resurrect the words', () => {
      reduction.queueAgentNote('curia-166', 'cancel 166', { instance: 'curia-166@1' })
      reduction.expireAgentNotes('curia-166', null)
      assert.deepEqual(new Reduction(dir).takeAgentNotes('curia-166'), [])
    })

    test('expiring nothing writes nothing — an empty sweep is not an event', () => {
      reduction.queueAgentNote('curia-166', 'a note for whoever resumes', {})
      assert.deepEqual(reduction.expireAgentNotes('curia-166', null), [])
      assert.deepEqual(reduction.takeAgentNotes('curia-166').map((n) => n.text), ['a note for whoever resumes'])
    })

    // The gate's own decision, pure for the reason queuedNoteReply is pure:
    // the daemon seam needs a live gateway, and this rule is the one that
    // closes the #170 case.
    test('a dead agent queues nothing at all — the #170 note never exists', () => {
      assert.deepEqual(noteDisposition({ state: 'failed', instance: 'curia-166@1' }), { reads: false, instance: null })
    })

    // #299: the console can name an agent curia is not running, and the queue
    // reads that as the same fact as a failed one. The rule sits here, so the
    // door does not carry a second existence check of its own.
    test('an agent curia is not running queues nothing either — no record is the same answer as failed', () => {
      assert.deepEqual(noteDisposition(undefined), { reads: false, instance: null })
      assert.deepEqual(noteDisposition(null), { reads: false, instance: null })
    })

    test('a running agent queues, stamped with the instance the words were typed at', () => {
      assert.deepEqual(noteDisposition({ state: 'ready', instance: 'curia-166@1' }), { reads: true, instance: 'curia-166@1' })
      assert.deepEqual(noteDisposition({ state: 'spawning', instance: 'curia-166@2' }), { reads: true, instance: 'curia-166@2' })
    })

    test('an agent with no instance still queues — an unstamped note is the old rule, not a refusal', () => {
      assert.deepEqual(noteDisposition({ state: 'ready' }), { reads: true, instance: null })
    })

    test('a note journalled before #208 carries no stamp, so it keeps the old rule', () => {
      // The pre-#208 shape, straight into the journal: no `instance` on the line.
      new Reduction(dir).journal('agent_note', { agent: 'curia-166', text: 'from before', after: null })
      const reborn = new Reduction(dir)
      assert.deepEqual(reborn.takeAgentNotes('curia-166', 'curia-166@2').map((n) => n.text), ['from before'])
    })
  })

  // #236: an operator question in a ticket thread got only the queue receipt —
  // honest and useless. A question-shaped note now opens with a direct answer
  // composed from records; the receipt is the second line, and the note still
  // queues for the agent.
  describe('a question gets a direct answer, never only the receipt (#236)', () => {
    const status = {
      state: 'working',
      spawned_at: new Date(Date.now() - 18 * 60_000).toISOString(),
      esc: null,
      last: { type: 'notify', ts: new Date(Date.now() - 2 * 60_000).toISOString() },
    }

    test('the live miss is detected — no question mark anywhere', () => {
      for (const s of ['whats taking so long', "what's the hold up", 'is it stuck?', 'how long has this run', 'still going?', 'did the tests pass', 'any progress']) {
        assert.ok(QUESTION_SHAPED.test(s), `"${s}" should read as a question`)
      }
    })

    test('plain notes are not questions — the receipt stays the whole reply', () => {
      for (const s of ['look at the logs', 'also check mobile', 'cancel 166', 'use the staging box first', 'D could be mentioned as well']) {
        assert.ok(!QUESTION_SHAPED.test(s), `"${s}" should read as prose`)
      }
    })

    test('a question opens with the status answer, and the receipt follows', () => {
      const lines = queuedNoteReply({ owner: 'curia-81', q: { reads: true, ticket: '81', status }, text: 'whats taking so long', channelId: 'C1' })
      assert.equal(lines.length, 2)
      assert.match(lines[0], /`curia-81` is working/)
      assert.match(lines[0], /dispatched 18 min ago/)
      assert.match(lines[0], /last journal event `notify`, 2 min ago/)
      assert.match(lines[1], /queued for `curia-81`/)
    })

    test('prose gets no answer line — the reply is the receipt alone', () => {
      const lines = queuedNoteReply({ owner: 'curia-81', q: { reads: true, ticket: '81', status }, text: 'look at the logs', channelId: 'C1' })
      assert.equal(lines.length, 1)
      assert.match(lines[0], /queued for/)
    })

    test('no facts, no answer — the receipt must not gain an empty line', () => {
      const lines = queuedNoteReply({ owner: 'curia-81', q: { reads: true, ticket: '81', status: null }, text: 'is it stuck?', channelId: 'C1' })
      assert.equal(lines.length, 1)
      assert.match(lines[0], /queued for/)
    })

    test('a dead agent keeps its one line — NOT running already is the answer', () => {
      const lines = queuedNoteReply({ owner: 'curia-81', q: { reads: false, ticket: '81', status }, text: 'whats taking so long', channelId: 'C1' })
      assert.equal(lines.length, 1)
      assert.match(lines[0], /NOT running/)
    })

    test('a question that is also a command gets all three lines, in order', () => {
      const lines = queuedNoteReply({ owner: 'curia-81', q: { reads: true, ticket: '81', status }, text: 'status?', channelId: 'C1' })
      assert.equal(lines.length, 3)
      assert.match(lines[0], /is working/)
      assert.match(lines[1], /queued for/)
      assert.match(lines[2], /commands run in <#C1>/)
    })

    test('waiting names the escalation, its title, and who is blocked on whom', () => {
      const now = Date.now()
      const line = statusAnswer('curia-81', {
        state: 'waiting',
        spawned_at: new Date(now - 60 * 60_000).toISOString(),
        esc: { id: 'esc-12', title: 'Approve the plan', opened_at: new Date(now - 40 * 60_000).toISOString() },
        last: null,
      }, now)
      assert.match(line, /waiting on \*\*\[esc-12\]\*\*/)
      assert.match(line, /Approve the plan/)
      assert.match(line, /40 min now/)
      assert.match(line, /does nothing until that is answered/)
    })

    test('a missing fact drops that fact, never the answer', () => {
      const line = statusAnswer('curia-81', { state: 'working', spawned_at: null, esc: null, last: null })
      assert.equal(line, '▶️ `curia-81` is working.')
      assert.equal(statusAnswer('curia-81', null), null)
      assert.equal(statusAnswer('curia-81', { state: null }), null)
    })

    test('the journal answers "what did it last do" — and the note itself never counts', () => {
      reduction.journal('notify', { agent: 'curia-81', ticket: '81', message: 'built the page' })
      reduction.queueAgentNote('curia-81', 'whats taking so long', { by: 'alp' })
      assert.equal(reduction.lastAgentEvent('curia-81').type, 'notify')
      // replay fills it too — a restarted daemon still answers
      assert.equal(new Reduction(dir).lastAgentEvent('curia-81').type, 'notify')
      assert.equal(reduction.lastAgentEvent('curia-unknown'), null)
    })
  })

  test('the queue survives a daemon restart — journal, not memory', () => {
    reduction.queueAgentNote('curia-9', 'undelivered', {})
    const reborn = new Reduction(dir)
    assert.deepEqual(reborn.takeAgentNotes('curia-9').map((n) => n.text), ['undelivered'])
    // and the drain replays too: a third boot sees nothing
    const third = new Reduction(dir)
    assert.deepEqual(third.takeAgentNotes('curia-9'), [])
  })
})

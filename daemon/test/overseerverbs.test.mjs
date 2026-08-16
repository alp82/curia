// Tests for src/overseerverbs.mjs: the one verb catalogue behind both
// transports — canonical text composition, and the handlers that post it to
// the injected command seam. These lived in overseer.test.mjs until #315
// deleted the in-daemon host; the catalogue outlived it, so its tests moved
// here.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from '../src/commands.mjs'
import { canonicalFor, verbHandlers } from '../src/overseerverbs.mjs'
import { buildSystemPrompt, ALLOWED_TOOLS } from '../src/overseerprompt.mjs'

// The posture that runs since the cutover (#315): the container holds a shell.
const PROMPT = buildSystemPrompt({ shell: true, checkoutsRoot: '/work/overseer/repos', repos: ['alp82/curia'] })

describe('canonicalFor', () => {
  test('every verb maps to the router grammar', () => {
    assert.equal(canonicalFor('tickets'), 'tickets')
    assert.equal(canonicalFor('tickets', { repo: 'cur' }), 'tickets cur')
    assert.equal(canonicalFor('next'), 'next')
    assert.equal(canonicalFor('next', { repo: 'alp82/curia' }), 'next alp82/curia')
    assert.equal(canonicalFor('status'), 'status')
    assert.equal(canonicalFor('start', { ticket: '85' }), 'start 85')
    assert.equal(canonicalFor('start', { ticket: '85', repo: 'alp82/curia' }), 'start alp82/curia#85')
    assert.equal(
      canonicalFor('start', { ticket: '85', model: 'claude-sonnet-5' }),
      'start 85 model=claude-sonnet-5',
    )
    assert.equal(canonicalFor('cancel', { ticket: '85' }), 'cancel 85')
    assert.equal(canonicalFor('cancel', { ticket: 'all' }), 'cancel all')
    assert.equal(canonicalFor('resume', { ticket: '85' }), 'resume 85')
    assert.equal(canonicalFor('resume', { ticket: 'all' }), 'resume all')
    assert.equal(canonicalFor('attach', { ticket: '85' }), 'attach 85')
  })

  // #177. The tool no longer declares a harness field, but the model on the
  // other end of this seam writes the arguments — a hallucinated one must not
  // reach the router as text it refuses.
  test('a harness argument is dropped rather than composed into the text', () => {
    assert.equal(canonicalFor('start', { ticket: '85', model: 'opus', harness: 'codex' }), 'start 85 model=opus')
  })

  test('resume carries the model override, and resume all drops it', () => {
    assert.equal(canonicalFor('resume', { ticket: '85', model: 'gpt' }), 'resume 85 model=gpt')
    assert.equal(canonicalFor('resume', { ticket: 'all', model: 'gpt' }), 'resume all')
  })

  test('an unknown verb throws instead of posting garbage to /command', () => {
    assert.throws(() => canonicalFor('reboot', {}))
  })

  // #160's instruction crosses the same canonical-text seam as every other
  // argument, so the two ends are pinned against each other here and in
  // commands.test.mjs. #221 moved it from `start` to `map`.
  // #255 retired the `--` this used to ride behind: the arguments come first
  // and the sentence runs to the end of the line.
  test('a map instruction rides map last, with no separator', () => {
    assert.equal(
      canonicalFor('map', { ticket: '147', instruction: 'update the map so that X' }),
      'map 147 update the map so that X',
    )
    assert.equal(
      canonicalFor('map', { ticket: '147', repo: 'cur', model: 'opus', instruction: 'add a ticket' }),
      'map cur#147 model=opus add a ticket',
    )
  })

  test('the instruction is collapsed to one line — the seam is one line of text', () => {
    assert.equal(
      canonicalFor('map', { ticket: '147', instruction: '  add a ticket\nthen wire it  ' }),
      'map 147 add a ticket then wire it',
    )
  })

  test('an empty instruction posts nothing after the number', () => {
    assert.equal(canonicalFor('map', { ticket: '147', instruction: '' }), 'map 147')
    assert.equal(canonicalFor('map', { ticket: '147', instruction: '   ' }), 'map 147')
  })

  // #241: the operator says "chart a new map for X" in prose, and the overseer
  // reaches `map` with an instruction and NO ticket. The repo is a bare token
  // here, not the `repo#n` qualifier — there is no n to qualify. #255: on this
  // shape it has to be the repo's own name, because it now sits in front of a
  // plain sentence.
  test('a map with no ticket composes the new-map shape', () => {
    assert.equal(
      canonicalFor('map', { instruction: 'chart the next feature' }),
      'map chart the next feature',
    )
    assert.equal(
      canonicalFor('map', { repo: 'alp82/curia', model: 'opus', instruction: 'chart the next feature' }),
      'map alp82/curia model=opus chart the next feature',
    )
  })

  test('the overseer is told when to reach for the new-map shape', () => {
    // The prose triggers the operator actually uses. A vocabulary the system
    // prompt does not carry is a verb the overseer never picks.
    for (const phrase of ['create a new map', 'chart a new map', 'add a map']) {
      assert.ok(
        PROMPT.toLowerCase().includes(phrase),
        `the system prompt does not teach the phrase "${phrase}"`,
      )
    }
  })

  // #221: `start` no longer charts, so it can no longer carry a sentence. A
  // model that writes one anyway must not produce text the router refuses —
  // the same treatment `harness=` gets above.
  test('an instruction handed to start is dropped, never composed into the text', () => {
    assert.equal(canonicalFor('start', { ticket: '147', instruction: 'update the map' }), 'start 147')
    assert.equal(
      canonicalFor('start', { ticket: '147', model: 'opus', instruction: 'update the map' }),
      'start 147 model=opus',
    )
    assert.ok(parseCommand(canonicalFor('start', { ticket: '147', instruction: 'x' })))
  })

  test('what canonicalFor writes, parseCommand reads back', () => {
    const text = canonicalFor('map', { ticket: '147', model: 'opus', instruction: 'chart the fog -- all of it' })
    assert.deepEqual(parseCommand(text), {
      verb: 'map', ticket: '147', model: 'opus', instruction: 'chart the fog -- all of it',
    })
  })
})

describe('verbHandlers', () => {
  test('the handler set is exactly the allowed-tools list', () => {
    const names = verbHandlers(async () => 'ok').map((h) => `mcp__curia__${h.verb}`)
    assert.deepEqual(names.sort(), [...ALLOWED_TOOLS].sort())
  })

  test('a handler posts canonical text to the seam and wraps the reply', async () => {
    const seen = []
    const handlers = verbHandlers(async (text) => { seen.push(text); return `reply to ${text}` })
    const start = handlers.find((h) => h.verb === 'start')
    const r = await start.handler({ ticket: '85', repo: 'alp82/curia' })
    assert.deepEqual(seen, ['start alp82/curia#85'])
    assert.deepEqual(r, { content: [{ type: 'text', text: 'reply to start alp82/curia#85' }] })
  })

  test('a seam failure surfaces as a rejected handler, not a fake reply', async () => {
    const handlers = verbHandlers(async () => { throw new Error('daemon answered 500') })
    const status = handlers.find((h) => h.verb === 'status')
    await assert.rejects(() => status.handler({}), /daemon answered 500/)
  })
})

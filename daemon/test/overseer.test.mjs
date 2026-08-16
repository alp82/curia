// Tests for src/overseer.mjs (#92): the overseer session host — one query()
// per message, resume per thread out of the journal, the verb tools over the
// injected command seam, and the Sonnet fallback that never replays a turn
// that already executed something.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { EscalationStore } from '../src/store.mjs'
import { parseCommand } from '../src/commands.mjs'
import { validSessionName, consoleKeyForSession, sessionForConsoleKey, isConsoleKey } from '../src/attach.mjs'
import {
  OverseerHost, canonicalFor, buildVerbTools, ALLOWED_TOOLS, DISALLOWED_TOOLS, SYSTEM_PROMPT,
} from '../src/overseer.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-test-'))

// ---- scripted stand-in for the SDK's query() --------------------------------

const init = (id) => ({ type: 'system', subtype: 'init', session_id: id })
const toolUse = (name, input = {}, id = 'tu-x') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const success = (text) => ({ type: 'result', subtype: 'success', result: text, num_turns: 2, total_cost_usd: 0.01 })
const failure = (subtype) => ({ type: 'result', subtype })

// One MCP client per turn server, over the in-memory transport. This is what
// makes #275 testable: the arguments meet the REAL schema, so a refusal in a
// test is the same refusal the live SDK produces, not a stub of one.
const clients = new WeakMap()
async function mcpCall(server, name, args) {
  let client = clients.get(server)
  if (!client) {
    const [ours, theirs] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'overseer-test', version: '1' })
    await Promise.all([server.instance.connect(theirs), client.connect(ours)])
    clients.set(server, client)
  }
  return client.callTool({ name, arguments: args })
}

// A real tool call, scripted: the assistant block the model writes, the round
// trip through this turn's own MCP server, and the tool_result that comes
// back. A call the schema refuses reaches no handler, exactly as it does live.
let nextToolUseId = 0
const call = (verb, input = {}) => ({
  async * expand(options) {
    const id = `tu-${++nextToolUseId}`
    yield toolUse(`mcp__curia__${verb}`, input, id)
    const res = await mcpCall(options.mcpServers.curia, verb, input)
    yield {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!res.isError, content: res.content }] },
    }
  },
})

// Each call to the fake consumes the next script (an array of messages, an
// Error to throw mid-stream, or a call() to run) and records {prompt, options}.
function scriptedQuery(...scripts) {
  const fn = ({ prompt, options }) => {
    fn.calls.push({ prompt, options })
    const script = scripts.shift() ?? []
    return (async function* () {
      for (const m of script) {
        if (m instanceof Error) throw m
        if (typeof m?.expand === 'function') { yield* m.expand(options); continue }
        yield m
      }
    })()
  }
  fn.calls = []
  return fn
}

function makeHost({ dir = tmp(), queryFn, command = async () => 'ok', store } = {}) {
  const s = store ?? new EscalationStore(dir)
  const host = new OverseerHost({
    store: s, command, dataDir: dir, log: () => {},
    model: 'model-a', fallbackModel: 'model-b', queryFn,
  })
  return { host, store: s, dir }
}

// #95's io contract: say() posts (the answer slot), status() upserts the one
// small-print status message. statuses records every upsert — the last entry
// is what the operator ends up reading.
function collector() {
  const posts = []
  const statuses = []
  return {
    posts,
    statuses,
    io: {
      say: async (t) => { posts.push(t) },
      status: async (t) => { statuses.push(t) },
    },
  }
}

// ---- the tool → router contract ---------------------------------------------

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
        SYSTEM_PROMPT.toLowerCase().includes(phrase),
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

describe('buildVerbTools', () => {
  test('the tool set is exactly the allowed-tools list', () => {
    const names = buildVerbTools(async () => 'ok').map((t) => `mcp__curia__${t.name}`)
    assert.deepEqual(names.sort(), [...ALLOWED_TOOLS].sort())
  })

  test('a handler posts canonical text to the seam and wraps the reply', async () => {
    const seen = []
    const tools = buildVerbTools(async (text) => { seen.push(text); return `reply to ${text}` })
    const start = tools.find((t) => t.name === 'start')
    const r = await start.handler({ ticket: '85', repo: 'alp82/curia' })
    assert.deepEqual(seen, ['start alp82/curia#85'])
    assert.deepEqual(r, { content: [{ type: 'text', text: 'reply to start alp82/curia#85' }] })
  })

  test('a seam failure surfaces as a rejected handler, not a fake reply', async () => {
    const tools = buildVerbTools(async () => { throw new Error('daemon answered 500') })
    const status = tools.find((t) => t.name === 'status')
    await assert.rejects(() => status.handler({}), /daemon answered 500/)
  })
})

// ---- the session host ---------------------------------------------------------

describe('OverseerHost turns', () => {
  test('a fresh turn journals the session, narrates tool calls in status, says the answer', async () => {
    const queryFn = scriptedQuery([
      init('sess-1'),
      call('status'),
      success('all quiet'),
    ])
    const { host, store } = makeHost({ queryFn })
    const { posts, statuses, io } = collector()
    const r = await host.runTurn('thread-1', 'what runs?', io)
    assert.equal(r.ok, true)
    assert.equal(store.overseerSession('thread-1'), 'sess-1')
    assert.deepEqual(statuses, ['-# ⚙️ `status`'])
    assert.deepEqual(posts, ['all quiet'], 'exactly one answer message')
  })

  test('the status line accumulates canonical verb text across tool calls (#95)', async () => {
    const queryFn = scriptedQuery([
      init('sess-1'),
      call('tickets'),
      call('start', { ticket: '85', repo: 'alp82/curia' }),
      success('started'),
    ])
    const seen = []
    const { host } = makeHost({ queryFn, command: async (text) => { seen.push(text); return 'ok' } })
    const { posts, statuses, io } = collector()
    await host.runTurn('thread-1', 'start 85', io)
    assert.deepEqual(statuses, [
      '-# ⚙️ `tickets`',
      '-# ⚙️ `tickets` · `start alp82/curia#85`',
    ])
    // #275: the line and the seam carry the same two strings, in the same order
    assert.deepEqual(seen, ['tickets', 'start alp82/curia#85'])
    assert.deepEqual(posts, ['started'])
  })

  // #275, the 2026-08-06 incident: the overseer packed the operator's sentence
  // into `ticket`, the MCP schema refused it, and no router ever saw the call —
  // but the status line had already printed `map <sentence>` as if it ran.
  test('a call the schema refuses shows the refusal, never a command that never ran', async () => {
    const prose = 'new ticket to make the map commands ticket param optional'
    const queryFn = scriptedQuery([
      init('sess-1'),
      call('map', { ticket: prose }),
      success('I could not read that as a map number.'),
    ])
    const seen = []
    const { host } = makeHost({ queryFn, command: async (text) => { seen.push(text); return 'ok' } })
    const { statuses, io } = collector()
    await host.runTurn('thread-1', 'add a ticket to the map', io)
    assert.deepEqual(seen, [], 'the router must receive nothing')
    assert.deepEqual(statuses, ['-# ⚙️ ⚠️ `map` refused before the router'])
    assert.ok(!statuses.some((s) => s.includes(prose)), 'the sentence must never appear as a command')
  })

  test('a refusal keeps its place beside the calls that did run (#275)', async () => {
    const queryFn = scriptedQuery([
      init('sess-1'),
      call('tickets'),
      call('start', { ticket: 'the landing page one' }),
      call('start', { ticket: '85' }),
      success('done'),
    ])
    const seen = []
    const { host } = makeHost({ queryFn, command: async (text) => { seen.push(text); return 'ok' } })
    const { statuses, io } = collector()
    await host.runTurn('thread-1', 'start the landing page one', io)
    assert.deepEqual(seen, ['tickets', 'start 85'])
    assert.equal(
      statuses.at(-1),
      '-# ⚙️ `tickets` · ⚠️ `start` refused before the router · `start 85`',
    )
  })

  test('a map instruction reaches the status line only as the router got it (#275)', async () => {
    const queryFn = scriptedQuery([
      init('sess-1'),
      call('map', { ticket: '147', instruction: 'add a ticket\nthen wire it' }),
      success('on it'),
    ])
    const seen = []
    const { host } = makeHost({ queryFn, command: async (text) => { seen.push(text); return 'ok' } })
    const { statuses, io } = collector()
    await host.runTurn('thread-1', 'add a ticket then wire it', io)
    assert.deepEqual(seen, ['map 147 add a ticket then wire it'])
    assert.deepEqual(statuses, ['-# ⚙️ `map 147 add a ticket then wire it`'])
  })

  test('the next turn in the same thread resumes the journalled session', async () => {
    const queryFn = scriptedQuery(
      [init('sess-1'), success('hi')],
      [init('sess-2'), success('again')],
    )
    const { host, store } = makeHost({ queryFn })
    const { io } = collector()
    await host.runTurn('thread-1', 'first', io)
    await host.runTurn('thread-1', 'second', io)
    assert.equal(queryFn.calls[0].options.resume, undefined)
    assert.equal(queryFn.calls[1].options.resume, 'sess-1')
    // resume minted a fresh id — the journal points at the live tail now
    assert.equal(store.overseerSession('thread-1'), 'sess-2')
  })

  test('pending confirm notes prefix the next prompt and drain exactly once (#94)', async () => {
    const queryFn = scriptedQuery(
      [init('s1'), success('noted')],
      [init('s2'), success('clean')],
    )
    const { host, store } = makeHost({ queryFn })
    store.addOverseerNote('thread-1', 'confirm esc-3 approved — cancelled curia-42')
    const { io } = collector()

    await host.runTurn('thread-1', 'what happened?', io)
    assert.equal(
      queryFn.calls[0].prompt,
      '[curia: confirm esc-3 approved — cancelled curia-42]\n\nwhat happened?',
    )

    await host.runTurn('thread-1', 'and now?', io)
    assert.equal(queryFn.calls[1].prompt, 'and now?', 'a drained note never replays')
  })

  test('the fallback retry carries the same note-augmented prompt (#94)', async () => {
    const queryFn = scriptedQuery(
      [init('s1'), failure('error_during_execution')],
      [init('s2'), success('recovered')],
    )
    const { host, store } = makeHost({ queryFn })
    store.addOverseerNote('t', 'confirm esc-9 lapsed — `curia-7` finished; nothing was executed')
    const { io } = collector()
    const r = await host.runTurn('t', 'hi', io)
    assert.equal(r.ok, true)
    assert.equal(queryFn.calls[0].prompt, queryFn.calls[1].prompt, 'the note must not vanish between the two attempts')
    assert.match(queryFn.calls[1].prompt, /confirm esc-9 lapsed/)
  })

  test('the thread map survives a restart: a new store over the same dir replays it', async () => {
    const dir = tmp()
    const { host } = makeHost({ dir, queryFn: scriptedQuery([init('sess-1'), success('hi')]) })
    const { io } = collector()
    await host.runTurn('thread-1', 'hello', io)

    const reborn = makeHost({
      dir, store: new EscalationStore(dir),
      queryFn: scriptedQuery([init('sess-2'), success('back')]),
    })
    await reborn.host.runTurn('thread-1', 'still there?', io)
    assert.equal(reborn.host.queryFn.calls[0].options.resume, 'sess-1')
  })

  test('turn options carry the containment: curia tools only, pinned cwd, isolated config', async () => {
    const queryFn = scriptedQuery([init('s'), success('ok')])
    const { host, dir } = makeHost({ queryFn })
    const { io } = collector()
    await host.runTurn('t', 'hi', io)
    const { options } = queryFn.calls[0]
    assert.deepEqual(options.allowedTools, ALLOWED_TOOLS)
    assert.deepEqual(options.disallowedTools, DISALLOWED_TOOLS)
    assert.ok(options.disallowedTools.includes('Bash'))
    // the #83 gap: ToolSearch off, so the verb schemas load eagerly
    assert.ok(options.disallowedTools.includes('ToolSearch'))
    assert.equal(options.cwd, path.join(dir, 'overseer', 'home'))
    assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(dir, 'overseer', 'config'))
    assert.equal(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, path.join(os.homedir(), '.claude'))
    assert.equal(options.model, 'model-a')
    assert.ok(options.mcpServers.curia)
  })

  test('each turn gets its own MCP server, so the verb tools carry their thread (#93)', async () => {
    const queryFn = scriptedQuery([init('s1'), success('a')], [init('s2'), success('b')])
    const { host } = makeHost({ queryFn })
    const { io } = collector()
    await host.runTurn('thread-1', 'hi', io)
    await host.runTurn('thread-2', 'hi', io)
    const [a, b] = queryFn.calls.map((c) => c.options.mcpServers.curia)
    assert.ok(a && b)
    assert.notEqual(a, b, 'a shared server could not tell the router which thread start ran in')
  })

  test('the config dir is seeded so no first-run dialog ever appears', () => {
    const { dir } = makeHost({ queryFn: scriptedQuery() })
    const seeded = JSON.parse(fs.readFileSync(path.join(dir, 'overseer', 'config', '.claude.json'), 'utf8'))
    const home = path.join(dir, 'overseer', 'home')
    assert.equal(seeded.projects[home].hasTrustDialogAccepted, true)
  })

  test('one turn at a time per thread; other threads are not blocked', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const queryFn = ({ options }) => {
      queryFn.calls.push({ options })
      return (async function* () {
        yield init(`s-${queryFn.calls.length}`)
        await gate
        yield success('done')
      })()
    }
    queryFn.calls = []
    const { host } = makeHost({ queryFn })
    const { posts, io } = collector()
    const first = host.runTurn('thread-1', 'slow one', io)
    const second = await host.runTurn('thread-1', 'impatient', io)
    assert.equal(second.busy, true)
    assert.equal(queryFn.calls.length, 1) // the busy turn never reached the SDK
    const other = host.runTurn('thread-2', 'unrelated', io)
    release()
    await Promise.all([first, other])
    assert.equal(queryFn.calls.length, 2)
    assert.ok(posts.some((p) => p.includes('one turn at a time')))
  })

  test('a failed turn with no tool call retries once on the fallback model', async () => {
    const queryFn = scriptedQuery(
      [init('s1'), failure('error_during_execution')],
      [init('s2'), success('recovered')],
    )
    const { host } = makeHost({ queryFn })
    const { posts, statuses, io } = collector()
    const r = await host.runTurn('t', 'hi', io)
    assert.equal(r.ok, true)
    assert.equal(queryFn.calls.length, 2)
    assert.equal(queryFn.calls[1].options.model, 'model-b')
    // the retry warning rides the status line, not a message of its own (#95)
    assert.ok(statuses.some((p) => p.includes('retrying on model-b')))
    assert.deepEqual(posts, ['recovered'])
  })

  test('a query that throws mid-stream also falls back, carrying the error', async () => {
    const queryFn = scriptedQuery(
      [init('s1'), new Error('boom')],
      [init('s2'), success('recovered')],
    )
    const { host } = makeHost({ queryFn })
    const { posts, statuses, io } = collector()
    const r = await host.runTurn('t', 'hi', io)
    assert.equal(r.ok, true)
    assert.ok(statuses.some((p) => p.includes('boom')))
    assert.deepEqual(posts, ['recovered'])
  })

  test('a turn that failed AFTER a tool call is never replayed — the effect may have landed', async () => {
    const queryFn = scriptedQuery(
      [init('s1'), toolUse('mcp__curia__start', { ticket: '85' }), failure('error_during_execution')],
      [init('never'), success('must not run')],
    )
    const { host } = makeHost({ queryFn })
    const { posts, statuses, io } = collector()
    const r = await host.runTurn('t', 'start 85', io)
    assert.equal(r.ok, false)
    assert.equal(queryFn.calls.length, 1)
    assert.ok(posts.at(-1).includes('session ended without an answer'))
    // #275: the block was written, the tool never ran — so the line says nothing
    assert.deepEqual(statuses, [])
  })

  test('a failed fallback reports the failure instead of looping', async () => {
    const queryFn = scriptedQuery(
      [init('s1'), failure('error_during_execution')],
      [init('s2'), failure('error_max_turns')],
    )
    const { host } = makeHost({ queryFn })
    const { posts, io } = collector()
    const r = await host.runTurn('t', 'hi', io)
    assert.equal(r.ok, false)
    assert.equal(queryFn.calls.length, 2)
    assert.ok(posts.at(-1).includes('error_max_turns'))
  })
})

describe('EscalationStore overseer sessions', () => {
  test('bindOverseerSession appends a journal line and reduces last-write-wins', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.bindOverseerSession('thread-1', 'sess-1')
    store.bindOverseerSession('thread-1', 'sess-2')
    store.bindOverseerSession('thread-9', 'sess-9')
    assert.equal(store.overseerSession('thread-1'), 'sess-2')
    assert.equal(store.overseerSession('thread-9'), 'sess-9')
    const replayed = new EscalationStore(dir)
    assert.equal(replayed.overseerSession('thread-1'), 'sess-2')
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(lines.filter((l) => l.type === 'overseer_session').length, 3)
  })
})

// The register of browser conversations (#333, ADR-0016). It is journalled for
// the reason the resume handle above is: a restart must not forget which
// conversations the operator has. It carries one fact the resume handle does
// not — which numbers are SPENT — and that fact has to outlive a delete.
describe('EscalationStore browser conversations (#333)', () => {
  test('a mint is journalled, and the list comes back after a restart', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    assert.equal(store.openConsoleConversation(), 'console-1')
    assert.equal(store.openConsoleConversation(), 'console-2')
    assert.deepEqual(store.consoleConversationList().map((c) => c.key), ['console-2', 'console-1'], 'newest first — the order the picker draws')
    const replayed = new EscalationStore(dir)
    assert.deepEqual(replayed.consoleConversationList().map((c) => c.key), ['console-2', 'console-1'])
    assert.ok(replayed.hasConsoleConversation('console-1'))
  })

  test('a deleted number stays spent across a restart — the whole point of counting up', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    store.openConsoleConversation()
    store.openConsoleConversation()
    assert.equal(store.deleteConsoleConversation('console-2'), true)
    assert.equal(store.openConsoleConversation(), 'console-3', 'not console-2 again')
    // And the same after a boot replay: the spent set is a reduction over the
    // journal, so it cannot be lost with the process that minted it.
    const replayed = new EscalationStore(dir)
    assert.equal(replayed.hasConsoleConversation('console-2'), false)
    assert.equal(replayed.openConsoleConversation(), 'console-4')
  })

  test('the delete takes the resume handle and the waiting notes with it', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    const key = store.openConsoleConversation()
    store.bindOverseerSession(key, 'sess-c1')
    store.addOverseerNote(key, 'confirm esc-1 approved')
    store.deleteConsoleConversation(key)
    assert.equal(store.overseerSession(key), undefined)
    assert.deepEqual(store.takeOverseerNotes(key), [])
    // The replay must reach the same state, not the state the bind wrote: the
    // delete event comes after it, so the reduction has to undo it in order.
    const replayed = new EscalationStore(dir)
    assert.equal(replayed.overseerSession(key), undefined)
  })

  test('deleting what is not there is refused rather than journalled', () => {
    const dir = tmp()
    const store = new EscalationStore(dir)
    assert.equal(store.deleteConsoleConversation('console-9'), false)
    assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false, 'nothing was written')
  })
})

// ---- a browser conversation (#267, many of them by #333) --------------------
//
// The console chat is this same overseer in a thread of its own. What these
// pin is the two things that differ, and why each one has to: the answer is not
// posted, because the transcript already carries it to the page, and the verbs
// run with no origin thread, because a console key is not a thread the bridge
// can put buttons in.
//
// #333 made the key `console-<n>` and made the store the register of which ones
// exist. So every turn below opens its conversation first, exactly as the Chat
// screen's button does.

describe('a browser conversation (#267, #333)', () => {
  // The mint the Chat screen presses. A turn on a key the store does not hold
  // is refused, so this is not test scaffolding — it is the live precondition.
  const opened = (store) => store.openConsoleConversation()

  test('it is one brain in a thread of its own: the conversation resumes on the console key', async () => {
    const queryFn = scriptedQuery([init('sess-c1'), success('#267 is first')], [init('sess-c2'), success('started')])
    const { host, store } = makeHost({ queryFn })
    const key = opened(store)
    await host.browserTurn(key, 'what is next?')
    assert.equal(store.overseerSession(key), 'sess-c1')
    await host.browserTurn(key, 'start it')
    assert.equal(queryFn.calls[1].options.resume, 'sess-c1', 'the second turn continues the first')
  })

  // The whole point of many conversations: one does NOT resume the other, and
  // neither can read the other's memory. This is the defect ADR-0016 named —
  // one conversation that never ends rots its own context — measured as the
  // reset it is replaced by.
  test('a second conversation is a reset: its own key, its own resume, no memory of the first', async () => {
    const queryFn = scriptedQuery([init('sess-c1'), success('one')], [init('sess-c2'), success('two')])
    const { host, store } = makeHost({ queryFn })
    const first = opened(store)
    const second = opened(store)
    assert.notEqual(first, second)
    await host.browserTurn(first, 'remember this')
    await host.browserTurn(second, 'fresh start')
    assert.equal(queryFn.calls[1].options.resume, undefined, 'the new conversation resumes nothing')
    assert.equal(store.overseerSession(first), 'sess-c1')
    assert.equal(store.overseerSession(second), 'sess-c2')
  })

  // A page can sit on a conversation another device has deleted. A turn there
  // would otherwise mint a fresh conversation under a number that is spent.
  test('a turn on a deleted conversation is refused in words, not answered', async () => {
    const queryFn = scriptedQuery([init('sess-c1'), success('hello')])
    const { host, store } = makeHost({ queryFn })
    const key = opened(store)
    store.deleteConsoleConversation(key)
    await assert.rejects(() => host.browserTurn(key, 'still there?'), /no conversation/)
    assert.equal(queryFn.calls.length, 0, 'nothing reached the model')
  })

  test('the verbs run with NO origin thread — a confirm goes where a REST press sends it', async () => {
    const queryFn = scriptedQuery([init('sess-c1'), call('cancel', { ticket: '263' }), success('confirm posted')])
    const seen = []
    const { host } = makeHost({
      queryFn,
      command: async (text, ctx) => { seen.push({ text, ctx }); return 'ok' },
    })
    const store = host.store
    await host.browserTurn(opened(store), 'cancel 263')
    assert.equal(seen.at(-1).text, 'cancel 263')
    assert.equal(seen.at(-1).ctx.threadId, null, 'there is no console thread for the bridge to post into')
    assert.equal(seen.at(-1).ctx.interpreted, true, 'a model composed it, so the confirm still stands between it and the teardown')
  })

  test('the answer leaves by the transcript, not by this call — one fact, said once', async () => {
    const queryFn = scriptedQuery([init('sess-c1'), success('all quiet')])
    const { host, store } = makeHost({ queryFn })
    const out = await host.browserTurn(opened(store), 'what runs?')
    assert.equal(out.ok, true)
    // Nothing carries the words back here. The SDK wrote them to the session
    // transcript, and the timeline tails that file (#74) — a second copy
    // returned through this path would be the same fact said twice (ADR-0013).
    assert.equal(JSON.stringify(out).includes('all quiet'), false)
  })

  test('the console session is a name the timeline admits, and the key it carries comes back', () => {
    const { store } = makeHost({ queryFn: scriptedQuery() })
    const key = opened(store)
    const session = sessionForConsoleKey(key)
    assert.ok(isConsoleKey(key))
    assert.ok(validSessionName(session), 'the surface refuses anything else')
    assert.notEqual(session, key, 'the session is what the page names, the key is what the conversation keys on')
    assert.equal(consoleKeyForSession(session), key, 'and the surface gets the key back out of it')
  })

  test('a turn that ends without an answer throws its words, so the page can say them', async () => {
    const queryFn = scriptedQuery([init('sess-c1'), failure('error_max_turns')], [init('sess-c1'), failure('error_max_turns')])
    const { host, store } = makeHost({ queryFn })
    await assert.rejects(() => host.browserTurn(opened(store), 'loop forever'), /without an answer/)
  })

  test('one turn at a time: a second message while the first runs is refused in words', async () => {
    let release
    const held = new Promise((done) => { release = done })
    const queryFn = ({ options }) => (async function* () {
      yield init('sess-c1')
      await held
      yield success('done')
    })(options)
    const { host, store } = makeHost({ queryFn })
    const key = opened(store)
    const first = host.browserTurn(key, 'slow one')
    await assert.rejects(() => host.browserTurn(key, 'impatient'), /one turn at a time/)
    release()
    await first
  })

  // The lock is per conversation, which is what lets the operator hold two at
  // once. One `busy` set over every key would have made the second chat wait on
  // the first, and ADR-0016 case 7 says both answer at the same time.
  test('the one-turn lock is per conversation: a second conversation answers while the first runs', async () => {
    let release
    const held = new Promise((done) => { release = done })
    let n = 0
    const queryFn = () => (async function* () {
      const mine = ++n
      yield init(`sess-c${mine}`)
      if (mine === 1) await held
      yield success('done')
    })()
    const { host, store } = makeHost({ queryFn })
    const slow = host.browserTurn(opened(store), 'slow one')
    await host.browserTurn(opened(store), 'the other conversation')
    release()
    await slow
  })
})

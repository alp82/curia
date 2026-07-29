// The timeline surface (#74): per-backend transcript readers, the loud parse
// failure, the escalation overlay, the proto-stamp refusal, and the write
// path's origin gate + session whitelist. Line fixtures are real shapes copied
// from worker transcripts on the deployment host, trimmed.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { detectBackend, findTranscript, parseLine } from '../src/transcript.mjs'
import { TimelineSurface, pageRefusal, DEFAULT_TIMELINE_INDEX, TIMELINE_PROTO } from '../src/timeline.mjs'

let tmp
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-timeline-')) })
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

describe('claude reader', () => {
  test('assistant text + tool_use become say + tool with a brief', () => {
    const { items } = parseLine('claude', JSON.stringify({
      type: 'assistant', timestamp: 'T',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la\nrest' } },
        ],
      },
    }))
    assert.equal(items.length, 2)
    assert.deepEqual(items[0], { kind: 'say', at: 'T', text: 'hello' })
    assert.equal(items[1].kind, 'tool')
    assert.equal(items[1].id, 'tu1')
    assert.equal(items[1].brief, 'ls -la')
  })

  test('a curia tool call briefs on its prompt', () => {
    const { items } = parseLine('claude', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__curia__ask_human', input: { prompt: 'which one?', kind: 'choice' } }] },
    }))
    assert.equal(items[0].brief, 'which one?')
  })

  test('tool_result becomes result keyed to its call, is_error flips ok', () => {
    const { items } = parseLine('claude', JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'boom\nline2' }] },
    }))
    assert.deepEqual(items[0], { kind: 'result', at: null, forId: 'tu1', ok: false, brief: 'boom', lines: 2 })
  })

  test('a plain user message is a prompt; a queued enqueue is queued', () => {
    assert.equal(parseLine('claude', JSON.stringify({ type: 'user', message: { content: 'do the thing' } })).items[0].kind, 'prompt')
    const q = parseLine('claude', JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'later' }))
    assert.equal(q.items[0].kind, 'queued')
    assert.deepEqual(parseLine('claude', JSON.stringify({ type: 'queue-operation', operation: 'remove' })).items, [])
  })

  test('bookkeeping lines are known and render nothing', () => {
    for (const type of ['mode', 'permission-mode', 'attachment', 'file-history-snapshot', 'file-history-delta', 'last-prompt', 'ai-title', 'system', 'summary']) {
      assert.deepEqual(parseLine('claude', JSON.stringify({ type })).items, [], type)
    }
  })

  test('an unknown type is reported, not swallowed — the #33/#69 silence rule', () => {
    assert.deepEqual(parseLine('claude', JSON.stringify({ type: 'brand-new-thing' })), { unknown: 'brand-new-thing' })
  })

  test('a non-JSON line is malformed, not skipped', () => {
    assert.deepEqual(parseLine('claude', 'not json at all'), { malformed: true })
  })
})

describe('codex reader', () => {
  test('a namespaced function_call renders as curia.<tool> with the prompt as brief', () => {
    const { items } = parseLine('codex', JSON.stringify({
      timestamp: 'T', type: 'response_item',
      payload: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ask_human', namespace: 'mcp__curia', arguments: '{"kind":"free-text","prompt":"item5 probe"}' },
    }))
    assert.equal(items[0].kind, 'tool')
    assert.equal(items[0].name, 'curia.ask_human')
    assert.equal(items[0].brief, 'item5 probe')
    assert.equal(items[0].id, 'call_1')
  })

  test('exec_command briefs on the command; its output strips the bookkeeping preamble', () => {
    const fc = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: '{"cmd":"sed -n 1,240p file.md"}' },
    }))
    assert.equal(fc.items[0].brief, 'sed -n 1,240p file.md')
    const out = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c2', output: 'Chunk ID: bfe8c8\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 12\nOutput:\nreal first line\nmore' },
    }))
    assert.equal(out.items[0].forId, 'c2')
    assert.equal(out.items[0].ok, true)
    assert.equal(out.items[0].brief, 'real first line')
  })

  test('a non-zero exit flips ok', () => {
    const out = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c3', output: 'Process exited with code 2\nOutput:\nnope' },
    }))
    assert.equal(out.items[0].ok, false)
  })

  test('assistant and user messages render; developer messages do not', () => {
    const mk = (role, ctype) => JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type: ctype, text: 'words' }] },
    })
    assert.equal(parseLine('codex', mk('assistant', 'output_text')).items[0].kind, 'say')
    assert.equal(parseLine('codex', mk('user', 'input_text')).items[0].kind, 'prompt')
    assert.deepEqual(parseLine('codex', mk('developer', 'input_text')).items, [])
  })

  test('reasoning is encrypted-only and renders nothing; event_msg is tolerated wholesale', () => {
    assert.deepEqual(parseLine('codex', JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x' } })).items, [])
    assert.deepEqual(parseLine('codex', JSON.stringify({ type: 'event_msg', payload: { type: 'some_future_event' } })).items, [])
    for (const type of ['session_meta', 'turn_context', 'world_state']) {
      assert.deepEqual(parseLine('codex', JSON.stringify({ type })).items, [], type)
    }
  })

  test('unknown vocabulary is reported at the right grain', () => {
    assert.deepEqual(parseLine('codex', JSON.stringify({ type: 'response_item', payload: { type: 'novel_item' } })), { unknown: 'response_item/novel_item' })
    assert.deepEqual(parseLine('codex', JSON.stringify({ type: 'novel_top' })), { unknown: 'novel_top' })
  })
})

describe('backend detection + transcript discovery', () => {
  test('projects/ means claude, sessions/ means codex, neither means null', () => {
    const c = path.join(tmp, 'cfg', 'curia-1')
    fs.mkdirSync(path.join(c, 'projects'), { recursive: true })
    assert.equal(detectBackend(c), 'claude')
    const x = path.join(tmp, 'cfg', 'curia-2')
    fs.mkdirSync(path.join(x, 'sessions'), { recursive: true })
    assert.equal(detectBackend(x), 'codex')
    assert.equal(detectBackend(path.join(tmp, 'cfg', 'nope')), null)
  })

  test('newest claude transcript wins across project dirs', () => {
    const c = path.join(tmp, 'cfg', 'curia-3')
    const p1 = path.join(c, 'projects', 'proj-a')
    const p2 = path.join(c, 'projects', 'proj-b')
    fs.mkdirSync(p1, { recursive: true }); fs.mkdirSync(p2, { recursive: true })
    fs.writeFileSync(path.join(p1, 'old.jsonl'), '')
    fs.writeFileSync(path.join(p2, 'new.jsonl'), '')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(path.join(p1, 'old.jsonl'), old, old)
    assert.equal(findTranscript('claude', c), path.join(p2, 'new.jsonl'))
  })

  test('codex rollouts are found under sessions/<y>/<m>/<d>/', () => {
    const c = path.join(tmp, 'cfg', 'curia-4')
    const day = path.join(c, 'sessions', '2026', '07', '30')
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(path.join(day, 'rollout-2026-07-30T00-00-00-x.jsonl'), '')
    assert.equal(findTranscript('codex', c), path.join(day, 'rollout-2026-07-30T00-00-00-x.jsonl'))
    assert.equal(findTranscript('codex', path.join(tmp, 'cfg', 'empty')), null)
  })
})

// ---------------------------------------------------------------------------
// the page stamp (#70's rule, one layer up)
// ---------------------------------------------------------------------------

describe('pageRefusal', () => {
  test('the shipped asset passes', () => {
    assert.equal(pageRefusal(DEFAULT_TIMELINE_INDEX), null)
  })

  test('a missing file, an unstamped page and a wrong proto each refuse by name', () => {
    assert.match(pageRefusal(path.join(tmp, 'nope.html')), /not readable/)
    const unstamped = path.join(tmp, 'unstamped.html')
    fs.writeFileSync(unstamped, '<!doctype html><title>x</title>')
    assert.match(pageRefusal(unstamped), /no curia-timeline proto stamp/)
    const wrong = path.join(tmp, 'wrong.html')
    fs.writeFileSync(wrong, `<meta name="curia-timeline" content="proto=${TIMELINE_PROTO + 1}">`)
    assert.match(pageRefusal(wrong), /speaks proto \d+ but this daemon speaks/)
  })
})

// ---------------------------------------------------------------------------
// the surface over real HTTP
// ---------------------------------------------------------------------------

async function sse(port, params) {
  // once=1 closes the stream after the backlog, so plain text() resolves.
  const res = await fetch(`http://127.0.0.1:${port}/events?${params}&once=1`)
  const text = await res.text()
  const events = []
  for (const block of text.split('\n\n')) {
    const ev = /event: (.+)/.exec(block)?.[1]
    const data = /data: (.+)/.exec(block)?.[1]
    if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null })
  }
  return { res, events }
}

describe('TimelineSurface', () => {
  let surface
  let port
  const journal = []
  const sent = []
  let escalations = []
  const workspaceRoot = () => path.join(tmp, 'work')

  before(async () => {
    fs.mkdirSync(path.join(tmp, 'work', 'cfg'), { recursive: true })
    surface = new TimelineSurface({
      port: 0,
      servePort: 8444,
      index: DEFAULT_TIMELINE_INDEX,
      workspaceRoot: workspaceRoot(),
      log: () => {},
      pollMs: 50,
      deps: {
        journal: (type, detail) => journal.push({ type, ...detail }),
        escalationsFor: () => escalations,
        sendText: async (session, text) => sent.push({ session, text }),
        sendKey: async (session, key) => sent.push({ session, key }),
        assertServe: async () => {},
        serveOff: async () => {},
        attachBase: async () => 'box.tailnet.ts.net',
      },
    })
    const { verified } = await surface.start()
    assert.equal(verified, true)
    port = surface.port
  })

  after(() => surface.stop())

  test('GET / serves the committed page with its stamp, no-store', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(await res.text(), /name="curia-timeline" content="proto=1"/)
  })

  test('a session name outside the whitelist is refused on every route', async () => {
    const { res } = await sse(port, 'session=root-shell')
    assert.equal(res.status, 400)
    for (const route of ['/send', '/draft', '/key']) {
      const r = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', body: JSON.stringify({ session: 'root-shell', text: 'x', key: 'escape' }),
      })
      assert.equal(r.status, 400, route)
    }
  })

  test('a claude transcript replays as a backlog, and an unknown line is LOUD', async () => {
    const cfg = path.join(workspaceRoot(), 'cfg', 'curia-9', 'projects', 'p')
    fs.mkdirSync(cfg, { recursive: true })
    fs.writeFileSync(path.join(cfg, 'run.jsonl'), [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } }),
      JSON.stringify({ type: 'brand-new-line-type', payload: {} }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } }] } }),
    ].join('\n') + '\n')

    const { events } = await sse(port, 'session=curia-9')
    const hello = events.find((e) => e.event === 'hello')
    assert.equal(hello.data.backend, 'claude')
    const items = events.filter((e) => e.event === 'items').flatMap((e) => e.data)
    assert.equal(items.filter((i) => i.kind === 'say').length, 1)
    assert.equal(items.filter((i) => i.kind === 'tool').length, 1)
    const parse = events.find((e) => e.event === 'parse')
    assert.ok(parse, 'the unknown line reaches the page as a parse event, not silence')
    assert.match(parse.data.reason, /brand-new-line-type/)
    assert.equal(journal.filter((j) => j.type === 'timeline_parse_failure').length, 1)
  })

  test('a session with no transcript says so instead of pretending quiet', async () => {
    const { events } = await sse(port, 'session=curia-777')
    const hello = events.find((e) => e.event === 'hello')
    assert.equal(hello.data.file, null)
  })

  test('open escalations overlay from the daemon record — the claude lane writes nothing while blocked (#74 item 5)', async () => {
    escalations = [{ id: 'esc-7', kind: 'free-text', prompt: 'which shade?', options: null, preview_url: null, opened_at: 'T', nudges: 1 }]
    try {
      const { events } = await sse(port, 'session=curia-9')
      const esc = events.filter((e) => e.event === 'escalations').at(-1)
      assert.equal(esc.data.length, 1)
      assert.equal(esc.data[0].id, 'esc-7')
    } finally {
      escalations = []
    }
  })

  test('cross-origin writes are refused; same-origin writes reach send-keys', async () => {
    const cross = await fetch(`http://127.0.0.1:${port}/draft`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ session: 'curia-9', text: 'x' }),
    })
    assert.equal(cross.status, 403)
    const same = await fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ session: 'curia-9', text: 'hello worker' }),
    })
    assert.equal(same.status, 200)
    assert.deepEqual(sent.at(-1), { session: 'curia-9', text: 'hello worker' })
  })

  test('the key route knows its keys', async () => {
    const bad = await fetch(`http://127.0.0.1:${port}/key`, {
      method: 'POST', body: JSON.stringify({ session: 'curia-9', key: 'delete-everything' }),
    })
    assert.equal(bad.status, 400)
    const esc = await fetch(`http://127.0.0.1:${port}/key`, {
      method: 'POST', body: JSON.stringify({ session: 'curia-9', key: 'escape' }),
    })
    assert.equal(esc.status, 200)
    assert.deepEqual(sent.at(-1), { session: 'curia-9', key: 'Escape' })
  })

  test('link composes from the surface\'s own config and refuses bad names', async () => {
    assert.equal(await surface.link('curia-9'), `https://box.tailnet.ts.net:8444/?session=curia-9`)
    await assert.rejects(() => surface.link('root-shell'), /not a valid curia session name/)
  })

  test('assert over a stale page withdraws instead of publishing (#70 posture)', async () => {
    const stale = path.join(tmp, 'stale.html')
    fs.writeFileSync(stale, `<meta name="curia-timeline" content="proto=${TIMELINE_PROTO + 1}">`)
    const offs = []
    const s2 = new TimelineSurface({
      port: 0, servePort: 8445, index: stale, workspaceRoot: workspaceRoot(), log: () => {},
      deps: {
        journal: (type, detail) => journal.push({ type, ...detail }),
        serveOff: async ({ servePort }) => offs.push(servePort),
        assertServe: async () => { throw new Error('must not assert over a stale page') },
        attachBase: async () => 'box.tailnet.ts.net',
      },
    })
    await s2.start()
    try {
      const { verified } = await s2.assert()
      assert.equal(verified, false)
      assert.deepEqual(offs, [8445])
      assert.ok(journal.some((j) => j.type === 'timeline_surface_withdrawn'))
      // the direct hit is refused too, in case a request races the withdrawal
      const res = await fetch(`http://127.0.0.1:${s2.port}/`)
      assert.equal(res.status, 503)
      await assert.rejects(() => s2.link('curia-9'), /timeline surface is down/)
    } finally {
      s2.stop()
    }
  })

  test('a surface that never bound refuses to publish', async () => {
    const s3 = new TimelineSurface({
      port: surface.port, // already taken by the first surface
      servePort: 8446, index: DEFAULT_TIMELINE_INDEX, workspaceRoot: workspaceRoot(), log: () => {},
      deps: {
        journal: (type, detail) => journal.push({ type, ...detail }),
        serveOff: async () => {},
        assertServe: async () => { throw new Error('must not assert over a dead listener') },
      },
    })
    const { verified } = await s3.start()
    assert.equal(verified, false)
    assert.ok(journal.some((j) => j.type === 'timeline_bind_failed'))
    assert.equal((await s3.assert()).verified, false)
  })
})

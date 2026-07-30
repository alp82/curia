// The timeline surface (#74): per-backend transcript readers, the loud parse
// failure, the escalation overlay, the proto-stamp refusal, and the write
// path's origin gate + session whitelist. Line fixtures are real shapes copied
// from worker transcripts on the deployment host, trimmed.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import http from 'node:http'

import { detectBackend, findTranscript, parseLine } from '../src/transcript.mjs'
import { TimelineSurface, pageRefusal, detectDialog, DEFAULT_TIMELINE_INDEX, TIMELINE_PROTO } from '../src/timeline.mjs'

// Real pane shapes, captured live on the deployment host (#75): the trust
// prompt and the /model picker verbatim, the AskUserQuestion footer as the
// ticket measured it. All three replace the composer — no ⏵⏵ marker.
const PANE_TRUST = [
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')
const PANE_MODEL_PICKER = '   Enter to set as default · s to use this session only · Esc to cancel'
const PANE_ASK_QUESTION = '   Enter to select · ↑/↓ to navigate'
const PANE_COMPOSER = [
  '❯ ',
  '────────',
  '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents',
].join('\n')
// The forgery (#33's lesson, and this ticket's own body quotes the footer):
// dialog chrome in scrollback with the live composer below it.
const PANE_FORGED = [
  '● The ticket says: "Enter to select · ↑/↓ to navigate" while one is up.',
  '❯ ',
  '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents',
].join('\n')
const COMPOSER_RE = /⏵⏵|bypass permissions/

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

// ---------------------------------------------------------------------------
// the terminal-dialog detector (#75)
// ---------------------------------------------------------------------------

describe('detectDialog', () => {
  test('every live-captured dialog footer is a dialog', () => {
    assert.ok(detectDialog(PANE_TRUST, COMPOSER_RE))
    assert.ok(detectDialog(PANE_MODEL_PICKER, COMPOSER_RE))
    assert.ok(detectDialog(PANE_ASK_QUESTION, COMPOSER_RE))
    assert.equal(detectDialog(PANE_ASK_QUESTION, COMPOSER_RE).hint, 'Enter to select')
  })

  test('a visible composer VETOES a footer phrase in scrollback — the forged-pane case', () => {
    assert.equal(detectDialog(PANE_FORGED, COMPOSER_RE), null)
  })

  test('the composer alone is no dialog, with or without the veto regex', () => {
    assert.equal(detectDialog(PANE_COMPOSER, COMPOSER_RE), null)
    assert.equal(detectDialog(PANE_COMPOSER, null), null)
  })

  test('the classifier sees only the pane tail', () => {
    const scrolledPast = PANE_ASK_QUESTION + '\n' + Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')
    assert.equal(detectDialog(scrolledPast, COMPOSER_RE), null)
  })
})

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
  let pane = PANE_COMPOSER // what capturePane returns; a function to throw
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
        capturePane: async () => (typeof pane === 'function' ? pane() : pane),
        composerFor: () => COMPOSER_RE,
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
    assert.match(await res.text(), new RegExp(`name="curia-timeline" content="proto=${TIMELINE_PROTO}"`))
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

  // ---- the #75 dialog guard over real HTTP ---------------------------------

  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', body: JSON.stringify(body),
  })

  test('a /send while a dialog owns the pane is refused, journalled, and pins the banner', async () => {
    pane = PANE_ASK_QUESTION
    try {
      const before = sent.length
      const r = await post('/send', { session: 'curia-9', text: 'looks good, approved' })
      assert.equal(r.status, 409)
      const body = await r.json()
      assert.equal(body.dialog, true)
      assert.match(body.error, /terminal dialog/)
      assert.equal(sent.length, before, 'nothing reached send-keys')
      const j = journal.findLast((x) => x.type === 'timeline_send')
      assert.equal(j.outcome, 'refused_dialog')
      assert.equal(j.text, 'looks good, approved')
      assert.equal(j.hint, 'Enter to select')
      assert.ok(journal.some((x) => x.type === 'timeline_dialog' && x.session === 'curia-9'))
      // the banner reaches a late joiner in the backlog
      const { events } = await sse(port, 'session=curia-9')
      const d = events.find((e) => e.event === 'dialog')
      assert.deepEqual(d.data, { up: true, hint: 'Enter to select' })
    } finally {
      pane = PANE_COMPOSER
    }
  })

  test('the next send after the dialog clears goes through and is journalled', async () => {
    const r = await post('/send', { session: 'curia-9', text: 'now it can go' })
    assert.equal(r.status, 200)
    assert.deepEqual(sent.at(-1), { session: 'curia-9', text: 'now it can go' })
    const j = journal.findLast((x) => x.type === 'timeline_send')
    assert.equal(j.outcome, 'sent')
    assert.equal(j.text, 'now it can go')
    // the probe on the way in cleared the banner
    const { events } = await sse(port, 'session=curia-9')
    assert.equal(events.find((e) => e.event === 'dialog'), undefined)
  })

  test('during a dialog, Enter refuses and Escape passes — dismissing is not answering', async () => {
    pane = PANE_TRUST
    try {
      const enter = await post('/key', { session: 'curia-9', key: 'enter' })
      assert.equal(enter.status, 409)
      assert.equal(journal.findLast((x) => x.type === 'timeline_key').outcome, 'refused_dialog')
      const esc = await post('/key', { session: 'curia-9', key: 'escape' })
      assert.equal(esc.status, 200)
      assert.deepEqual(sent.at(-1), { session: 'curia-9', key: 'Escape' })
      assert.equal(journal.findLast((x) => x.type === 'timeline_key').outcome, 'sent')
    } finally {
      pane = PANE_COMPOSER
    }
  })

  test('a forged footer under a visible composer does not refuse — #33\'s untrusted pane', async () => {
    pane = PANE_FORGED
    try {
      const r = await post('/send', { session: 'curia-9', text: 'the ticket quotes the footer' })
      assert.equal(r.status, 200)
    } finally {
      pane = PANE_COMPOSER
    }
  })

  test('a failed capture is not evidence: a session never read from falls through to send-keys', async () => {
    pane = () => { throw new Error('no such session') }
    try {
      const r = await post('/send', { session: 'curia-88', text: 'still goes' })
      assert.equal(r.status, 200)
      assert.deepEqual(sent.at(-1), { session: 'curia-88', text: 'still goes' })
    } finally {
      pane = PANE_COMPOSER
    }
  })

  test('the tick pins the banner for a pure watcher — no write involved', async () => {
    pane = PANE_MODEL_PICKER
    try {
      const d = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/events?session=curia-55`, (res) => {
          let buf = ''
          res.on('data', (c) => {
            buf += c
            const m = /event: dialog\ndata: (.+)/.exec(buf)
            if (m) { req.destroy(); resolve(JSON.parse(m[1])) }
          })
        })
        req.on('error', () => {}) // the destroy above surfaces as a socket error
        setTimeout(() => { req.destroy(); reject(new Error('no dialog event from the tick')) }, 3000).unref()
      })
      assert.equal(d.up, true)
      assert.match(d.hint, /Enter to set as default/)
    } finally {
      pane = PANE_COMPOSER
    }
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

// The timeline surface (#74): per-harness transcript readers, the loud parse
// failure, the escalation overlay, the proto-stamp refusal, and the write
// path's origin gate + session whitelist. Line fixtures are real shapes copied
// from agent transcripts on the deployment host, trimmed.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import http from 'node:http'

import { detectHarness, findTranscript, transcriptForSession, firstPrompt, parseLine } from '../src/transcript.mjs'
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

// The codex family, captured live on #176 (codex 0.146, scratch CODEX_HOME on
// the deployment host): the directory-trust prompt and the /model picker,
// verbatim. Both replace the composer and the status footer.
const PANE_CODEX_TRUST = [
  '> You are in /home/alp/dev/projects/curia',
  '  Do you trust the contents of this directory?',
  '› 1. Yes, continue',
  '  2. No, quit',
  '  Press enter to continue',
].join('\n')
const PANE_CODEX_MODEL_PICKER = [
  '  Select Model and Effort',
  '› 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.',
  '  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.',
  '  Press enter to confirm or esc to go back',
].join('\n')
const PANE_CODEX_COMPOSER = [
  '› Run /review on my current changes',
  '  gpt-5.6-sol default · /root/wt/curia-176',
].join('\n')
const PANE_CODEX_FORGED = [
  '• The ticket says: "Press enter to continue" while one is up.',
  PANE_CODEX_COMPOSER,
].join('\n')
const CODEX_COMPOSER_RE = /·\s[~/]/ // routing.yaml harnesses.codex.ready

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

  test('a curia notify carries its full text unclipped — #108 item 1', () => {
    const message = 'first line of a long update\nsecond line the brief would drop\nthird line'
    const { items } = parseLine('claude', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'n1', name: 'mcp__curia__notify', input: { message } }] },
    }))
    assert.equal(items[0].text, message)
    assert.equal(items[0].brief, 'first line of a long update')
    // a non-curia tool never grows a text field
    const bash = parseLine('claude', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls\npwd' } }] },
    }))
    assert.equal(bash.items[0].text, undefined)
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

  test('a namespaced curia call carries its full text unclipped — #108 item 1', () => {
    const message = 'progress line one\nprogress line two'
    const { items } = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'c9', name: 'notify', namespace: 'mcp__curia', arguments: JSON.stringify({ message }) },
    }))
    assert.equal(items[0].text, message)
    const plain = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'c10', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    }))
    assert.equal(plain.items[0].text, undefined)
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

  // 0.146's exec harness, measured live on #176: MCP calls arrive as a
  // custom_tool_call named `exec` with raw JS as `input`, and its output is an
  // ARRAY of content blocks rather than a string.
  test('a custom_tool_call renders as a tool with the script as brief — #176', () => {
    const { items } = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c4', name: 'exec', input: 'const r = await tools.mcp__curia__ask_human({});\nmore' },
    }))
    assert.equal(items[0].kind, 'tool')
    assert.equal(items[0].name, 'exec')
    assert.equal(items[0].brief, 'const r = await tools.mcp__curia__ask_human({});')
    assert.equal(items[0].id, 'c4')
  })

  test('an array output flattens; an input_image block renders as [image] — #176 gap 9', () => {
    // Verbatim shape from the live capture: the MCP image block reaches the
    // model as input_image with a data: URL.
    const out = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'c4', output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
        { type: 'input_text', text: 'Here is the human answer, one image attached.' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBOR…', detail: 'original' },
      ] },
    }))
    assert.equal(out.items[0].kind, 'result')
    assert.equal(out.items[0].forId, 'c4')
    assert.equal(out.items[0].ok, true)
    assert.equal(out.items[0].brief, 'Here is the human answer, one image attached.')
    // function_call_output grew the same array form (measured on the `wait` tool)
    const fn = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c5', output: [{ type: 'input_text', text: 'Script completed\nOutput:\nok' }] },
    }))
    assert.equal(fn.items[0].brief, 'ok')
  })

  test('a message whose only cargo is an image renders [image], not nothing — #176 gap 9', () => {
    const { items } = parseLine('codex', JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,x' }] },
    }))
    assert.deepEqual(items, [{ kind: 'note', at: null, text: '[image]' }])
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

describe('harness detection + transcript discovery', () => {
  test('projects/ means claude, sessions/ means codex, neither means null', () => {
    const c = path.join(tmp, 'cfg', 'curia-1')
    fs.mkdirSync(path.join(c, 'projects'), { recursive: true })
    assert.equal(detectHarness(c), 'claude')
    const x = path.join(tmp, 'cfg', 'curia-2')
    fs.mkdirSync(path.join(x, 'sessions'), { recursive: true })
    assert.equal(detectHarness(x), 'codex')
    assert.equal(detectHarness(path.join(tmp, 'cfg', 'nope')), null)
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

  test('a newer codex subagent rollout does not replace the parent rollout (#545)', () => {
    const c = path.join(tmp, 'cfg', 'curia-5')
    const day = path.join(c, 'sessions', '2026', '08', '19')
    fs.mkdirSync(day, { recursive: true })
    const parent = path.join(day, 'rollout-2026-08-19T09-01-52-parent.jsonl')
    const child = path.join(day, 'rollout-2026-08-19T09-01-58-child.jsonl')
    fs.writeFileSync(parent, `${JSON.stringify({
      type: 'session_meta', payload: { id: 'parent', thread_source: 'user' },
    })}\n`)
    fs.writeFileSync(child, `${JSON.stringify({
      type: 'session_meta', payload: { id: 'child', thread_source: 'subagent', parent_thread_id: 'parent' },
    })}\n`)
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(parent, old, old)

    assert.equal(findTranscript('codex', c), parent)
  })
})

// ---------------------------------------------------------------------------
// a transcript is found by KEY (#332, building ADR-0016)
// ---------------------------------------------------------------------------
//
// The config dir of a conversation holds every conversation's transcript, so
// mtime answers "who spoke last" rather than "which conversation is this". The
// session id the key is bound to is what names the file.

describe('transcriptForSession (#332)', () => {
  test('the session id names the file, and a newer conversation does not take it', () => {
    const c = path.join(tmp, 'cfg', 'conversations')
    const proj = path.join(c, 'projects', 'home')
    fs.mkdirSync(proj, { recursive: true })
    const mine = path.join(proj, 'aaaa-1111.jsonl')
    const theirs = path.join(proj, 'bbbb-2222.jsonl')
    fs.writeFileSync(mine, '')
    fs.writeFileSync(theirs, '')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(mine, old, old)

    // What the shipped mtime path would answer, and why it is the defect.
    assert.equal(findTranscript('claude', c), theirs)
    assert.equal(transcriptForSession('claude', c, 'aaaa-1111'), mine)
    assert.equal(transcriptForSession('claude', c, 'bbbb-2222'), theirs)
  })

  test('an id that names no file reads as no transcript, never as the newest one', () => {
    const c = path.join(tmp, 'cfg', 'conversations')
    // A conversation with no turn yet has no session id at all (ADR-0016 case
    // 8), and the cutover leaves journalled ids whose files are gone.
    assert.equal(transcriptForSession('claude', c, null), null)
    assert.equal(transcriptForSession('claude', c, undefined), null)
    assert.equal(transcriptForSession('claude', c, 'cccc-3333'), null)
    assert.equal(transcriptForSession('gemini', c, 'aaaa-1111'), null)
  })

  test('the codex rollout carries its session id after the start time', () => {
    const c = path.join(tmp, 'cfg', 'codex-conversations')
    const day = path.join(c, 'sessions', '2026', '07', '30')
    fs.mkdirSync(day, { recursive: true })
    const f = path.join(day, 'rollout-2026-07-30T00-00-00-dddd-4444.jsonl')
    fs.writeFileSync(f, '')
    assert.equal(transcriptForSession('codex', c, 'dddd-4444'), f)
    assert.equal(transcriptForSession('codex', c, '2026-07-30T00-00-00'), null)
  })
})

// ---------------------------------------------------------------------------
// the label a conversation carries in the picker (#333)
// ---------------------------------------------------------------------------
//
// ADR-0016 mints a conversation a number and nothing else, and #333 gave the
// operator no field to type a name in. So the row's label is their own first
// message, read off the head of the transcript.

describe('firstPrompt (#333)', () => {
  const line = (o) => JSON.stringify(o) + '\n'
  const write = (name, body) => {
    const proj = path.join(tmp, 'cfg', 'labels', 'projects', 'home')
    fs.mkdirSync(proj, { recursive: true })
    const f = path.join(proj, name)
    fs.writeFileSync(f, body)
    return f
  }

  test('the operator\'s first message is the label, whitespace collapsed', () => {
    const f = write('a.jsonl',
      line({ type: 'system', subtype: 'init' })
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })
      + line({ type: 'user', message: { content: 'what is\n  takeable?' } })
      + line({ type: 'user', message: { content: 'and the second one' } }))
    assert.equal(firstPrompt('claude', f), 'what is takeable?')
  })

  test('a long first message is clipped, so one row stays one row', () => {
    const f = write('b.jsonl', line({ type: 'user', message: { content: 'x'.repeat(400) } }))
    const label = firstPrompt('claude', f, { max: 20 })
    assert.equal(label.length, 20)
    assert.match(label, /…$/)
  })

  test('no prompt is null, and the row falls back to its key', () => {
    assert.equal(firstPrompt('claude', write('c.jsonl', line({ type: 'system', subtype: 'init' }))), null)
    assert.equal(firstPrompt('claude', null), null)
    assert.equal(firstPrompt('claude', path.join(tmp, 'cfg', 'labels', 'gone.jsonl')), null)
    assert.equal(firstPrompt(null, write('d.jsonl', line({ type: 'user', message: { content: 'hi' } }))), null)
  })

  // Only the head of the file is read, so the last line in the window is
  // normally half a line. A label is not the timeline: it skips what it cannot
  // parse rather than reporting a parse failure over it.
  test('a half-written line at the edge of the bounded read is skipped, not reported', () => {
    const f = write('e.jsonl', '{"type":"user","message":{"content"')
    assert.equal(firstPrompt('claude', f, { bytes: 34 }), null)
    const g = write('f.jsonl', line({ type: 'user', message: { content: 'first' } }) + '{"type":"user"')
    assert.equal(firstPrompt('claude', g), 'first')
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

  test('the codex dialog family — captured live on #176', () => {
    // Both captures replaced the composer and the "<model> <effort> · <cwd>"
    // status footer, so the codex ready marker never shares a tail with them.
    assert.equal(detectDialog(PANE_CODEX_TRUST, CODEX_COMPOSER_RE).hint, 'Press enter to continue')
    assert.match(detectDialog(PANE_CODEX_MODEL_PICKER, CODEX_COMPOSER_RE).hint, /Press enter to confirm/)
  })

  test('a codex footer phrase in scrollback is vetoed by the codex status footer', () => {
    assert.equal(detectDialog(PANE_CODEX_FORGED, CODEX_COMPOSER_RE), null)
    assert.equal(detectDialog(PANE_CODEX_COMPOSER, CODEX_COMPOSER_RE), null)
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
  let escHistory = []
  let pane = PANE_COMPOSER // what capturePane returns; a function to throw
  const workspaceRoot = () => path.join(tmp, 'work')
  // The driven session (#267): the console chat is the overseer, whose
  // transcript sits outside the workspace and whose composer is a turn.
  // #333: a browser conversation, and the session name carries its key.
  const DRIVEN = 'curia-console-2'
  const drivenCfg = () => path.join(tmp, 'overseer-config')
  const turns = [] // every text handed to the driver
  let turnFails = null // a message to throw from send()
  // The conversation key's live session id, as the daemon journals it (#332).
  // Read per driverFor call, exactly as index.mjs reads it off the reduction.
  let drivenSessionId = 'browser-1111'

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
        // #151's check has its own suite (identity.test.mjs); these tests drive
        // the surface over bare loopback, so the predicate is out of their way.
        identityCheck: () => null,
        escalationsFor: () => escalations,
        escalationHistoryFor: () => escHistory,
        sendText: async (session, text) => sent.push({ session, text }),
        sendKey: async (session, key) => sent.push({ session, key }),
        capturePane: async () => (typeof pane === 'function' ? pane() : pane),
        composerFor: () => COMPOSER_RE,
        assertServe: async () => {},
        serveOff: async () => {},
        attachBase: async () => 'box.tailnet.ts.net',
        driverFor: (session) => (session === DRIVEN
          ? {
            cfgDir: drivenCfg(),
            sessionId: drivenSessionId,
            send: async (text) => {
              if (turnFails) throw new Error(turnFails)
              turns.push(text)
            },
          }
          : null),
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
    assert.equal(hello.data.harness, 'claude')
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

  test('open escalations overlay from the daemon record — the claude harness writes nothing while blocked (#74 item 5)', async () => {
    escalations = [{ id: 'esc-7', kind: 'free-text', prompt: 'which shade?', options: null, preview_url: null, opened_at: 'T' }]
    try {
      const { events } = await sse(port, 'session=curia-9')
      const esc = events.filter((e) => e.event === 'escalations').at(-1)
      assert.equal(esc.data.length, 1)
      assert.equal(esc.data[0].id, 'esc-7')
    } finally {
      escalations = []
    }
  })

  test('the full escalation history reaches the page — question, options, answer, who answered (#108 item 1)', async () => {
    escHistory = [{
      id: 'esc-3', agent: 'curia-9', kind: 'choice',
      prompt: 'a long question body\nwith a second line the transcript brief drops',
      options: ['red', 'blue'], opened_at: 'T1', closed_at: 'T2',
      status: 'answered', answer: 'blue, because contrast', answered_by: 'alp',
      answered_via: 'button',
    }]
    try {
      const { events } = await sse(port, 'session=curia-9')
      const h = events.filter((e) => e.event === 'esc_history').at(-1)
      assert.equal(h.data.length, 1)
      const r = h.data[0]
      assert.match(r.prompt, /second line/)
      assert.deepEqual(r.options, ['red', 'blue'])
      assert.equal(r.status, 'answered')
      assert.equal(r.answer, 'blue, because contrast')
      assert.equal(r.answered_by, 'alp')
      assert.equal(r.answered_via, 'button')
      assert.equal(r.closed_at, 'T2')
    } finally {
      escHistory = []
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
      body: JSON.stringify({ session: 'curia-9', text: 'hello agent' }),
    })
    assert.equal(same.status, 200)
    assert.deepEqual(sent.at(-1), { session: 'curia-9', text: 'hello agent' })
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

  // ---- the driven session: the console chat (#267) --------------------------
  //
  // One surface, two kinds of session. What these pin is that the difference
  // stays where the driver is: the same page, the same stream, the same
  // composer — and no tmux anywhere near it.

  test('a driven session reads its transcript from the DRIVER\'s config dir, not the workspace', async () => {
    const proj = path.join(drivenCfg(), 'projects', 'home')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, `${drivenSessionId}.jsonl`), [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'what is next?' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '#267 is first on the curia frontier' }] } }),
    ].join('\n') + '\n')

    const { events } = await sse(port, `session=${DRIVEN}`)
    const hello = events.find((e) => e.event === 'hello')
    assert.equal(hello.data.harness, 'claude', 'the harness is probed in the driver\'s own dir')
    const items = events.filter((e) => e.event === 'items').flatMap((e) => e.data)
    assert.ok(items.some((i) => i.kind === 'say' && /#267 is first/.test(i.text)))
  })

  // #332, building ADR-0016. This is the live defect the ticket names: one
  // config dir holds every overseer conversation, so a Discord turn used to
  // take the Chat screen over.
  test('a Discord conversation answering later does NOT take the browser chat over', async () => {
    const proj = path.join(drivenCfg(), 'projects', 'home')
    fs.mkdirSync(proj, { recursive: true })
    const discord = path.join(proj, 'discord-9999.jsonl')
    fs.writeFileSync(discord, `${JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'answered in a Discord thread' }] },
    })}\n`)
    const now = new Date()
    fs.utimesSync(discord, now, now) // newest by mtime, and not this conversation

    const { events } = await sse(port, `session=${DRIVEN}`)
    const items = events.filter((e) => e.event === 'items').flatMap((e) => e.data)
    assert.ok(items.some((i) => /#267 is first/.test(i.text ?? '')), 'the browser conversation is still on the page')
    assert.ok(!items.some((i) => /Discord thread/.test(i.text ?? '')), 'and the other conversation is not')
  })

  test('a conversation with no turn yet shows an EMPTY screen, not the last conversation', async () => {
    const was = drivenSessionId
    drivenSessionId = null // ADR-0016 case 8: the key exists, no turn has run
    try {
      const { events } = await sse(port, `session=${DRIVEN}`)
      const items = events.filter((e) => e.event === 'items').flatMap((e) => e.data)
      assert.deepEqual(items, [])
    } finally {
      drivenSessionId = was
    }
  })

  test('a message to a driven session is a TURN — nothing reaches send-keys', async () => {
    const before = sent.length
    const r = await fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST', body: JSON.stringify({ session: DRIVEN, text: 'start 267' }),
    })
    assert.equal(r.status, 200)
    assert.equal(turns.at(-1), 'start 267')
    assert.equal(sent.length, before, 'tmux is not in this path at all')
    const j = journal.findLast((x) => x.type === 'timeline_send')
    assert.equal(j.session, DRIVEN)
    assert.equal(j.outcome, 'sent')
  })

  test('a turn that ends without an answer comes back as WORDS, never as silence', async () => {
    turnFails = 'the turn ended without an answer (max turns)'
    try {
      const r = await fetch(`http://127.0.0.1:${port}/send`, {
        method: 'POST', body: JSON.stringify({ session: DRIVEN, text: 'anything' }),
      })
      assert.equal(r.status, 502)
      assert.match((await r.json()).error, /without an answer/)
      const j = journal.findLast((x) => x.type === 'timeline_send')
      assert.equal(j.outcome, 'failed')
    } finally {
      turnFails = null
    }
  })

  test('a key is refused on a driven session, and the refusal says why', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/key`, {
      method: 'POST', body: JSON.stringify({ session: DRIVEN, key: 'escape' }),
    })
    assert.equal(r.status, 409)
    assert.match((await r.json()).error, /not a terminal/)
    const j = journal.findLast((x) => x.type === 'timeline_key')
    assert.equal(j.outcome, 'refused_no_pane')
  })

  test('the dialog guard never asks tmux about a session that has no pane', async () => {
    pane = () => { throw new Error('capturePane must not run for a driven session') }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/send`, {
        method: 'POST', body: JSON.stringify({ session: DRIVEN, text: 'still fine' }),
      })
      assert.equal(r.status, 200)
      assert.equal(turns.at(-1), 'still fine')
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
        // #151's check has its own suite (identity.test.mjs); these tests drive
        // the surface over bare loopback, so the predicate is out of their way.
        identityCheck: () => null,
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
        // #151's check has its own suite (identity.test.mjs); these tests drive
        // the surface over bare loopback, so the predicate is out of their way.
        identityCheck: () => null,
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

// PROTOTYPE (#538) — stand-in Anthropic Messages API for the dialog captures.
// The real claude TUI runs against this server, so every pane capture is the
// real renderer's output, not a reconstruction. Same discipline as the #542
// stand-ins: the reading is never a model's report of itself.
//
// The script keys off the last user text:
//   "ask single" -> AskUserQuestion, one question, three options
//   "ask multi"  -> AskUserQuestion, multiSelect, four options
//   "ask long"   -> AskUserQuestion, long labels and descriptions
//   "ask two"    -> AskUserQuestion, two questions in one call
//   anything else, or a tool_result -> a short text reply
// Every request body lands in <dir>/req-<n>.json — the tool_result in there
// is the proof that a keystroke answer reached the harness.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9106)
const DIR = process.argv[3] ?? './standin-log'
fs.mkdirSync(DIR, { recursive: true })
let n = 0

const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : ''

const QUESTIONS = {
  single: [{
    question: 'Which storage backend should the feed cache use?',
    header: 'Cache',
    multiSelect: false,
    options: [
      { label: 'SQLite (Recommended)', description: 'One file next to the journal, no new daemon.' },
      { label: 'Redis', description: 'Fast, but a second process to babysit.' },
      { label: 'In-memory only', description: 'Free, dies with the daemon.' },
    ],
  }],
  multi: [{
    question: 'Which screens should ship in the first cut?',
    header: 'Scope',
    multiSelect: true,
    options: [
      { label: 'Home', description: 'The verdict ring and needs-you.' },
      { label: 'Chat', description: 'The per-agent conversation.' },
      { label: 'Feed', description: 'The wire at two altitudes.' },
      { label: 'Settings', description: 'Four rows, drill-in.' },
    ],
  }],
  long: [{
    question: 'The daemon found two ways to hold the escalation record across a restart, and the migration cost differs by an order of magnitude. Which one should the spec lock in before the handoff?',
    header: 'Escalations',
    multiSelect: false,
    options: [
      { label: 'Replay the journal from the last snapshot and rebuild the open set in memory on every boot', description: 'No schema change, but boot cost grows with journal length until the next snapshot rotation lands.' },
      { label: 'Write the open set to its own table and treat the journal as history only', description: 'A schema migration now, constant boot cost forever, and the table is one more thing backup must carry.' },
      { label: 'Keep both for one release and diff them on every boot', description: 'The safest read, the most code, and a diff that only pays off if the two ever disagree.' },
    ],
  }],
  two: [
    {
      question: 'Should the preview link open in a new tab?',
      header: 'Preview',
      multiSelect: false,
      options: [
        { label: 'New tab', description: 'The chat stays where it was.' },
        { label: 'Same tab', description: 'Back returns to the chat.' },
      ],
    },
    {
      question: 'Should the terminal link show on phones?',
      header: 'Terminal',
      multiSelect: false,
      options: [
        { label: 'Show it', description: 'Same header everywhere.' },
        { label: 'Hide it', description: 'A phone cannot type into ttyd well.' },
      ],
    },
  ],
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

function streamText(res, id, text) {
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'standin', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

function streamToolUse(res, id, name, input) {
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'standin', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name, input: {} } })
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  if (req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }))
    return
  }
  if (!req.url.includes('/v1/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    return
  }
  n += 1
  fs.writeFileSync(path.join(DIR, `req-${n}.json`), raw)
  let body = {}
  try { body = JSON.parse(raw) } catch { /* logged above */ }
  const msgs = body.messages ?? []
  const toolNames = (body.tools ?? []).map((t) => t?.name)
  const ask = toolNames.find((t) => /AskUserQuestion/i.test(t ?? ''))
  // Find the newest user "ask <kind>" anywhere in the conversation, and
  // whether a tool_result follows it — reminders ride after the user text,
  // so the last message alone is not the ask.
  let kind = null, askAt = -1
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue
    const m = /ask (single|multi|long|two)/.exec(textOf(msgs[i].content))
    if (m) { kind = m[1]; askAt = i }
  }
  const answered = msgs.slice(askAt + 1).some((mm) => Array.isArray(mm.content)
    && mm.content.some((b) => b?.type === 'tool_result'))
  console.log(JSON.stringify({ req: n, kind, askAt, answered, ask: Boolean(ask) }))

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const id = `msg_standin_${n}`
  if (kind && !answered && ask) { streamToolUse(res, id, ask, { questions: QUESTIONS[kind] }); return }
  if (kind && answered) { streamText(res, id, 'Answer received. Logged.'); return }
  streamText(res, id, 'Standing by. Say "ask single|multi|long|two" to raise the picker.')
}).listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ listening: PORT, dir: DIR })))

// PROTOTYPE (#542) — stand-in model for the codex backtrack probe.
// Codex speaks the Responses wire API; this serves POST /v1/responses and
// scripts every turn, so the reading is never a model's report of itself.
// Cribbed from docs/research/pane-keystroke-codex.probe.mjs.
//
// The script, keyed off the LAST user message in the input codex sends:
//   "create apple"  -> shell call writing apple.txt, then "APPLE DONE"
//   "create banana" -> shell call writing banana.txt, then "BANANA DONE"
//   "create cherry" -> no call; replies with every user turn it can see,
//                      which is what proves the backtrack cut the conversation
//                      ON THE WIRE, not in the pane's rendering.
// Every request body is logged to <dir>/req-<n>.json.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9101)
const DIR = process.argv[3] ?? './standin-log'
fs.mkdirSync(DIR, { recursive: true })
let n = 0

const userTurns = (input) => (input ?? [])
  .filter((i) => i?.type === 'message' && i?.role === 'user')
  .map((i) => (i.content ?? []).map((c) => c?.text ?? '').join(' '))

const callsDone = (input) => {
  const outs = new Set((input ?? []).filter((i) => i?.type === 'function_call_output').map((i) => i.call_id))
  return (input ?? []).filter((i) => i?.type === 'function_call' && outs.has(i.call_id)).map((i) => i.arguments ?? '')
}

http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !new URL(req.url, 'http://x').pathname.endsWith('/responses')) {
    res.writeHead(404).end('{}'); return
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  n += 1
  fs.writeFileSync(path.join(DIR, `req-${n}.json`), raw)
  let body = {}
  try { body = JSON.parse(raw) } catch { /* logged above either way */ }
  const users = userTurns(body.input)
  const done = callsDone(body.input)
  const last = users.at(-1) ?? ''
  console.log(JSON.stringify({ req: n, user_turns: users, calls_done: done.length }))

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
  const response = { id: `resp_${n}`, object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  send('response.created', { response: { ...response, status: 'in_progress' } })
  const message = (text) => send('response.output_item.done', {
    output_index: 0,
    item: { type: 'message', id: `msg_${n}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] },
  })
  // codex 0.146 offers the exec tool as `exec_command` with a `cmd` string
  // (read off the offer in req-2.json of the first run; `shell` came back
  // "unsupported call").
  const shell = (cmd) => send('response.output_item.done', {
    output_index: 0,
    item: { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec_command', arguments: JSON.stringify({ cmd }), status: 'completed' },
  })

  const wants = (fruit) => last.includes(`create ${fruit}`)
  const wrote = (fruit) => done.some((a) => String(a).includes(`${fruit}.txt`))
  if (wants('apple') && !wrote('apple')) shell('echo APPLE-ONE > apple.txt')
  else if (wants('apple')) message('APPLE DONE')
  else if (wants('banana') && !wrote('banana')) shell('echo BANANA-TWO > banana.txt')
  else if (wants('banana')) message('BANANA DONE')
  else if (wants('cherry')) message(`CHERRY: I see ${users.length} user turn(s): ${users.map((u) => JSON.stringify(u)).join(' | ')}`)
  else message(`ok (${users.length} user turns)`)

  send('response.completed', { response })
  res.end()
}).listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ listening: PORT, dir: DIR })))

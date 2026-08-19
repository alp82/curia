// PROTOTYPE (#542) — stand-in model for the opencode and pi probes.
// Serves POST /v1/chat/completions (streaming SSE) and scripts every turn,
// same discipline as standin-codex.mjs: the reading is never a model's
// report of itself. Tool support: emits one tool call per "create <fruit>"
// ask, using the tool named `bash` when offered (opencode, pi both offer it).
//
//   "create apple"  -> bash: echo APPLE-ONE > apple.txt, then "APPLE DONE"
//   "create banana" -> bash: echo BANANA-TWO > banana.txt, then "BANANA DONE"
//   "create cherry" -> no call; replies with every user turn it can see.
// Logs each request body to <dir>/req-<n>.json.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9102)
const DIR = process.argv[3] ?? './standin-chat-log'
fs.mkdirSync(DIR, { recursive: true })
let n = 0

const text = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => p?.text ?? '').join(' ') : ''

http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.includes('chat/completions')) { res.writeHead(404).end('{}'); return }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  n += 1
  fs.writeFileSync(path.join(DIR, `req-${n}.json`), raw)
  let body = {}
  try { body = JSON.parse(raw) } catch { /* logged above */ }
  const msgs = body.messages ?? []
  const users = msgs.filter((m) => m.role === 'user').map((m) => text(m.content))
  const last = users.at(-1) ?? ''
  const toolNames = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name)
  const bashTool = toolNames.find((t) => /^(bash|shell|execute|run)/i.test(t ?? '')) ?? 'bash'
  const ranFruit = (fruit) => msgs.some((m) => m.role === 'tool' || m.role === 'assistant'
    ? JSON.stringify(m).includes(`${fruit}.txt`) : false)
  console.log(JSON.stringify({ req: n, users, tools: toolNames.slice(0, 8) }))

  const id = `chatcmpl-${n}`
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: 1700000000, model: body.model ?? 'standin',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`)

  const wants = (fruit) => last.includes(`create ${fruit}`)
  const call = (cmd) => {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: bashTool, arguments: JSON.stringify({ command: cmd, description: cmd }) } }] })
    chunk({}, 'tool_calls')
  }
  const say = (t) => { chunk({ role: 'assistant', content: t }); chunk({}, 'stop') }

  if (wants('apple') && !ranFruit('apple')) call('echo APPLE-ONE > apple.txt')
  else if (wants('apple')) say('APPLE DONE')
  else if (wants('banana') && !ranFruit('banana')) call('echo BANANA-TWO > banana.txt')
  else if (wants('banana')) say('BANANA DONE')
  else if (wants('cherry')) say(`CHERRY: I see ${users.length} user turn(s): ${users.map((u) => JSON.stringify(u.slice(0, 60))).join(' | ')}`)
  else say(`ok (${users.length} user turns)`)

  res.write('data: [DONE]\n\n')
  res.end()
}).listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ listening: PORT, dir: DIR })))

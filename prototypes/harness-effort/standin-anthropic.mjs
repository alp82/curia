// PROTOTYPE (#559) — stand-in Anthropic API for the claude effort probe.
// Serves POST /v1/messages (streaming SSE) and logs EVERY request — method,
// path, headers, body — to <dir>/req-<n>.json, so the effort a spawn states
// is read off the wire and never off the model's report of itself.
// Every other path is logged too and answered with an empty 200, so the
// capture shows whatever else the CLI phones.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9105)
const DIR = process.argv[3] ?? './anthropic-log'
fs.mkdirSync(DIR, { recursive: true })
let n = 0

http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  n += 1
  let body = null
  try { body = JSON.parse(raw) } catch { body = raw || null }
  fs.writeFileSync(path.join(DIR, `req-${n}.json`), JSON.stringify({
    method: req.method, url: req.url, headers: req.headers, body,
  }, null, 2))
  console.log(JSON.stringify({ req: n, method: req.method, url: req.url }))

  if (req.method === 'POST' && req.url.includes('/v1/messages') && !req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
    const model = body?.model ?? 'standin'
    ev('message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `ok (req ${n})` } })
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    ev('message_stop', {})
    res.end()
    return
  }
  if (req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
}).listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ listening: PORT, dir: DIR })))

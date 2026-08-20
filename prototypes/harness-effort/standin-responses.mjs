// PROTOTYPE (#559) — stand-in Responses API for the codex effort probe.
// Serves POST /v1/responses (streaming SSE), logs every request whole —
// method, path, headers, body — to <dir>/req-<n>.json. The `reasoning`
// object codex sends per request IS the evidence: the effort is read off
// the wire, never off a pane's rendering.
// Cribbed from prototypes/pane-rewind/standin-codex.mjs.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9106)
const DIR = process.argv[3] ?? './responses-log'
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
  console.log(JSON.stringify({ req: n, method: req.method, url: req.url, reasoning: body?.reasoning ?? null, model: body?.model ?? null }))

  if (req.method !== 'POST' || !new URL(req.url, 'http://x').pathname.endsWith('/responses')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
  const response = { id: `resp_${n}`, object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  send('response.created', { response: { ...response, status: 'in_progress' } })
  send('response.output_item.done', {
    output_index: 0,
    item: { type: 'message', id: `msg_${n}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: `ok (req ${n})` }] },
  })
  send('response.completed', { response })
  res.end()
}).listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ listening: PORT, dir: DIR })))

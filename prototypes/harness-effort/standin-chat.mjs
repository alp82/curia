// PROTOTYPE (#559) — stand-in chat-completions API for the opencode and pi
// effort probes. Serves POST /v1/chat/completions (streaming SSE) and logs
// every request whole — method, path, headers, body — to <dir>/req-<n>.json.
// Whatever effort field these harnesses send rides the body or a header, so
// the log is the whole reading. Cribbed from
// prototypes/pane-rewind/standin-chat.mjs.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9107)
const DIR = process.argv[3] ?? './chat-log'
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
  console.log(JSON.stringify({
    req: n, method: req.method, url: req.url,
    effortish: body && typeof body === 'object'
      ? Object.fromEntries(Object.entries(body).filter(([k]) => /effort|reason|think/i.test(k)))
      : null,
    model: body?.model ?? null,
  }))

  if (req.method !== 'POST' || !req.url.includes('chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    return
  }
  const id = `chatcmpl-${n}`
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: 1700000000, model: body?.model ?? 'standin',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`)
  chunk({ role: 'assistant', content: `ok (req ${n})` })
  chunk({}, 'stop')
  res.write('data: [DONE]\n\n')
  res.end()
}).listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ listening: PORT, dir: DIR })))

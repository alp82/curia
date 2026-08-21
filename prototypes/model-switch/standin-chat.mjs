// PROTOTYPE (#561) — stand-in chat-completions API for the opencode and pi
// model-switch probes. Serves POST /v1/chat/completions (streaming SSE) and
// logs every request whole — method, path, headers, body — to
// <dir>/req-<n>.json. The `model` the harness sends per request IS the
// evidence. Cribbed from prototypes/harness-effort/standin-chat.mjs.
//
// One addition: a COLD model. Any request whose model id contains "cold" is
// refused with the OpenAI error shape, so the probe can watch how the pane
// renders a model the account refuses.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9107)
const DIR = process.argv[3] ?? './chat-log'
fs.mkdirSync(DIR, { recursive: true })
let n = Math.max(0, ...fs.readdirSync(DIR).map((f) => Number(f.match(/^req-(\d+)\.json$/)?.[1] ?? 0)))

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
  console.log(JSON.stringify({ req: n, method: req.method, url: req.url, model: body?.model ?? null }))

  if (req.method !== 'POST' || !req.url.includes('chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    return
  }
  const model = body?.model ?? 'standin'
  if (model.includes('cold')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
      error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' },
    }))
    return
  }
  const id = `chatcmpl-${n}`
  if (!body?.stream) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id, object: 'chat.completion', created: 1700000000, model,
      choices: [{ index: 0, message: { role: 'assistant', content: `ok (req ${n}, model ${model})` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: 1700000000, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`)
  chunk({ role: 'assistant', content: `ok (req ${n}, model ${model})` })
  chunk({}, 'stop')
  res.write('data: [DONE]\n\n')
  res.end()
}).listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ listening: PORT, dir: DIR })))

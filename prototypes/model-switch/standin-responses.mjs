// PROTOTYPE (#561) — stand-in Responses API for the codex model-switch probe.
// Serves POST /v1/responses (streaming SSE), logs every request whole —
// method, path, headers, body — to <dir>/req-<n>.json. The `model` field the
// harness sends per request IS the evidence: the model is read off the wire,
// never off a pane's rendering. Cribbed from
// prototypes/harness-effort/standin-responses.mjs.
//
// One addition: a COLD model. Any request whose model id contains "cold" is
// refused with the OpenAI error shape, so the probe can watch how the pane
// renders a model the account refuses.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9106)
const DIR = process.argv[3] ?? './responses-log'
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

  if (req.method !== 'POST' || !new URL(req.url, 'http://x').pathname.endsWith('/responses')) {
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
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
  const response = { id: `resp_${n}`, object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  send('response.created', { response: { ...response, status: 'in_progress' } })
  send('response.output_item.done', {
    output_index: 0,
    item: { type: 'message', id: `msg_${n}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: `ok (req ${n}, model ${model})` }] },
  })
  send('response.completed', { response })
  res.end()
}).listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ listening: PORT, dir: DIR })))

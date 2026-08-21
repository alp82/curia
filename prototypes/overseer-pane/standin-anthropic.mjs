// PROTOTYPE (#570) — stand-in Anthropic API for the overseer-pane spike.
// Serves POST /v1/messages (streaming SSE) and logs EVERY request — method,
// path, headers, body — to <dir>/req-<n>.json, so what the model saw is read
// off the wire and never off a pane rendering. Same shape as the #561 stand-in.
//
// Two behaviors this spike needs:
//   - The answer text quotes the LAST user message and the message COUNT, so a
//     pane capture alone proves which conversation state produced it.
//   - A user message containing "slowly" streams one word every 400 ms for ~20 s,
//     so an Escape can land mid-turn and the interrupt is measurable.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9105)
const DIR = process.argv[3] ?? './anthropic-log'
fs.mkdirSync(DIR, { recursive: true })
let n = Math.max(0, ...fs.readdirSync(DIR).map((f) => Number(f.match(/^req-(\d+)\.json$/)?.[1] ?? 0)))

const lastUserText = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const c = m.content
    const text = typeof c === 'string' ? c
      : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    if (text.trim()) return text
  }
  return '(none)'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

  if (req.method === 'POST' && req.url.includes('/v1/messages') && !req.url.includes('count_tokens')) {
    const model = body?.model ?? 'standin'
    const msgs = body?.messages ?? []
    const last = lastUserText(msgs).replace(/\s+/g, ' ').trim()
    const slow = /slowly/i.test(last)
    const answer = `Overseer here (req ${n}, ${msgs.length} msgs in context). You said: "${last.slice(0, 120)}". `
      + (slow ? 'I will now think out loud for a while. ' + 'word '.repeat(40) : 'Nothing else is moving.')
    if (!body?.stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: `msg_${n}`, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
    ev('message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    if (slow) {
      for (const word of answer.split(' ')) {
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `${word} ` } })
        await sleep(400)
        if (res.writableEnded || res.destroyed) return
      }
    } else {
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } })
    }
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    ev('message_stop', {})
    res.end()
    return
  }
  if (req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
}).listen(PORT, '127.0.0.1', () => console.log(`stand-in anthropic on 127.0.0.1:${PORT}, wire -> ${DIR}`))

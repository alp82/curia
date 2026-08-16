#!/usr/bin/env node
// A stub Responses API, so codex runs with no credential. Same instrument
// docs/live-checks/360-codex-session-memory.md built and #416 reused, pointed at
// the Stop hook.
//
// For THIS question the stub does not need to be clever. It answers every turn
// with a plain assistant message, so the turn ends and the Stop hook fires. What
// gets measured is what codex does next, and that is read off the wire: every
// request body is written to disk, so the refusal text either appears in the
// NEXT request's input list or it does not.
//
// Reading the reason off the wire is stronger evidence than a model's own report
// of having seen it. The model here cannot flatter the result: it is a fixed
// string matcher over the bytes codex sent.
//
// Env:
//   STUB_PORT   default 8899
//   STUB_LOG    directory for req-N.json, one per request
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.STUB_PORT ?? 8899)
const LOG = process.env.STUB_LOG ?? '/tmp/codex-stop-hook/stub'
mkdirSync(LOG, { recursive: true })

let n = 0

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    n += 1
    writeFileSync(join(LOG, `req-${n}.json`), body)

    const output = [{
      id: `msg_${n}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: `stub turn ${n}: done` }],
    }]

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const response = { id: `resp_${n}`, object: 'response', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    sse(res, { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
    for (const item of output) sse(res, { type: 'response.output_item.done', item })
    sse(res, { type: 'response.completed', response })
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`stub responses on 127.0.0.1:${PORT}, logging to ${LOG}\n`)
})

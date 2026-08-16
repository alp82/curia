#!/usr/bin/env node
// A stub Responses API, so codex can be driven with no credential. Same
// instrument docs/live-checks/360-codex-session-memory.md built, pointed at a
// different question.
//
// The stub IS the model. It reads the tool list out of the request, calls the
// lint tool with prose that fails, then calls it again with prose that passes.
// What that proves is mechanical, not judgment: whether codex carries the
// rejection back into the input list, and whether a second call inside the same
// turn reaches the tool. A stub cannot decide to rewrite, so it cannot answer
// whether a real model would.
//
// Env:
//   STUB_PORT   default 8899
//   STUB_LOG    directory for req-N.json, one per request
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.STUB_PORT ?? 8899)
const LOG = process.env.STUB_LOG ?? '/tmp/reject-on-lint/codex-stub'
mkdirSync(LOG, { recursive: true })

// Turn 1 breaks four rules at once. Turn 2 obeys them.
const BAD = {
  headline: 'Retry cap — 3 or 5?',
  prompt: "We're deciding the rewrite cap and it's a real tradeoff; a cap of 3 ends a stuck loop sooner, while a cap of 5 gives the agent more room to fix its own text before curia gives up on it.",
}
const GOOD = {
  headline: 'Retry cap: 3 or 5',
  prompt: 'Curia caps how many times an agent may rewrite a rejected message. Pick 3 or 5. A cap of 3 ends a stuck loop sooner. A cap of 5 gives the agent more room to fix its own text.',
}

let n = 0

// Codex 0.146.0 sends no top-level `tools` array. It declares one custom tool
// called `exec` inside an `additional_tools` input item, and every MCP tool is
// reachable only from JavaScript inside it, as `tools.mcp__<server>__<tool>`.
// So a codex MCP call is a nested call, not a tool call the wire can see.
function execTool(body) {
  for (const item of body.input ?? []) {
    if (item.type !== 'additional_tools') continue
    const t = (item.tools ?? []).find((x) => x.name === 'exec')
    if (t) return t
  }
  return (body.tools ?? []).find((t) => (t.name ?? '').includes('ask_human')) ?? null
}

// The script the stub makes the model "write". No try/catch on purpose: whether
// a rejected MCP call throws inside the isolate, and what the model then sees,
// is the thing being measured.
//
// STUB_VARIANT picks which script:
//   print    the model prints the tool's return value (the careful model)
//   discard  the model calls and ignores the return value (the ordinary model,
//            because a tool that "just sends a message" has no return worth
//            printing)
const VARIANT = process.env.STUB_VARIANT ?? 'print'
const script = (args) => (VARIANT === 'discard'
  ? [`await tools.mcp__lintcheck__ask_human(${JSON.stringify(args)});`, 'text("asked the operator");'].join('\n')
  : [`const r = await tools.mcp__lintcheck__ask_human(${JSON.stringify(args)});`, 'text("tool returned: " + JSON.stringify(r));'].join('\n'))

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function callItem(tool, args, i) {
  // A `custom` tool takes free text as `input`. `exec` wants raw JavaScript.
  const base = { id: `fc_${i}`, call_id: `call_${i}`, name: tool.name, status: 'completed' }
  if (tool.type === 'custom') return { ...base, type: 'custom_tool_call', input: tool.name === 'exec' ? script(args) : JSON.stringify(args) }
  return { ...base, type: 'function_call', arguments: JSON.stringify(args) }
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    n += 1
    let parsed = {}
    try { parsed = JSON.parse(body) } catch { /* log it raw anyway */ }
    writeFileSync(join(LOG, `req-${n}.json`), body)

    const tool = execTool(parsed)
    let output
    if (n === 1 && tool) output = [callItem(tool, BAD, 1)]
    else if (n === 2 && tool) output = [callItem(tool, GOOD, 2)]
    else output = [{ id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `stub turn ${n}: done` }] }]

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const response = { id: `resp_${n}`, object: 'response', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    sse(res, { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
    for (const item of output) sse(res, { type: 'response.output_item.done', item })
    sse(res, { type: 'response.completed', response })
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`stub listening on 127.0.0.1:${PORT}, logging to ${LOG}\n`)
})

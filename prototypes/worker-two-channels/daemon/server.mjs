// Curia daemon stub for spike #29 "one worker, two channels".
// One process, two surfaces:
//   POST /mcp?worker=<name>   — streamable-HTTP MCP endpoint the worker connects to
//                               (tools: ask_human, notify, report_result)
//   REST control surface      — GET /state, POST /answer, POST /worker_done (Stop-hook webhook)
// Durable record: every escalation/notify/result/lifecycle event appends to events.jsonl;
// results additionally land in results/<worker>.json.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const PORT = Number(process.env.PORT ?? 4271)
const DIR = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(DIR, 'events.jsonl')
const RESULTS = path.join(DIR, 'results')
fs.mkdirSync(RESULTS, { recursive: true })

let escSeq = 0
const pending = new Map() // escalation id -> { resolve, record }

function logEvent(type, data) {
  const rec = { ts: new Date().toISOString(), type, ...data }
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
  console.log(`[${rec.ts}] ${type} ${JSON.stringify(data)}`)
  return rec
}

function buildMcpServer(worker) {
  const server = new McpServer({ name: 'curia-daemon-stub', version: '0.1.0' })

  server.tool(
    'notify',
    'Fire-and-forget status update to the human. Returns immediately.',
    { message: z.string() },
    async ({ message }) => {
      logEvent('notify', { worker, message })
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  )

  server.tool(
    'ask_human',
    'Escalate a question to the human and BLOCK until an answer arrives. kind: free-text | choice | approve-reject | preview-review.',
    {
      prompt: z.string(),
      kind: z.enum(['free-text', 'choice', 'approve-reject', 'preview-review']),
      options: z.array(z.string()).optional(),
      preview_url: z.string().optional(),
    },
    async ({ prompt, kind, options, preview_url }) => {
      const id = `esc-${++escSeq}-${worker}`
      const record = logEvent('escalation_open', { worker, id, kind, prompt, options, preview_url })
      const answer = await new Promise((resolve) => pending.set(id, { resolve, record }))
      logEvent('escalation_answered', { worker, id, answer })
      return { content: [{ type: 'text', text: answer }] }
    },
  )

  server.tool(
    'report_result',
    'Deliver the structured resolution for the ticket. Call exactly once, when the work is done.',
    {
      ticket: z.string(),
      status: z.enum(['resolved', 'blocked', 'aborted']),
      summary: z.string(),
      details: z.record(z.string(), z.any()).optional(),
    },
    async ({ ticket, status, summary, details }) => {
      const rec = logEvent('result', { worker, ticket, status, summary, details })
      fs.writeFileSync(path.join(RESULTS, `${worker}.json`), JSON.stringify(rec, null, 2))
      return { content: [{ type: 'text', text: 'result recorded' }] }
    },
  )

  return server
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : {} } catch { return { raw } }
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (url.pathname === '/mcp') {
    const worker = url.searchParams.get('worker') ?? 'unknown'
    if (req.method !== 'POST') {
      res.writeHead(405).end(JSON.stringify({ error: 'stateless server: POST only' }))
      return
    }
    const body = await readBody(req)
    // Stateless mode: fresh server+transport per request; escalation state is module-level.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close() })
    const mcp = buildMcpServer(worker)
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
    return
  }

  if (url.pathname === '/state' && req.method === 'GET') {
    const open = [...pending.entries()].map(([id, p]) => ({ id, ...p.record }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ open_escalations: open }, null, 2))
    return
  }

  if (url.pathname === '/answer' && req.method === 'POST') {
    const { id, answer } = await readBody(req)
    const p = pending.get(id)
    if (!p) {
      res.writeHead(404).end(JSON.stringify({ error: `no open escalation ${id}` }))
      return
    }
    pending.delete(id) // first valid answer wins, closes atomically
    p.resolve(String(answer))
    res.writeHead(200).end(JSON.stringify({ ok: true, id }))
    return
  }

  if (url.pathname === '/worker_done' && req.method === 'POST') {
    const body = await readBody(req)
    const worker = url.searchParams.get('worker') ?? 'unknown'
    logEvent('worker_done_hook', {
      worker,
      hook_event: body.hook_event_name,
      session_id: body.session_id,
      stop_hook_active: body.stop_hook_active,
    })
    res.writeHead(200).end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(404).end()
})

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`curia daemon stub listening on http://127.0.0.1:${PORT} (mcp: /mcp?worker=NAME)`)
})

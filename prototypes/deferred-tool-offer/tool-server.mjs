#!/usr/bin/env node
// One-tool stdio MCP server for #579. The tool writes each call to PROBE_LOG.
// The log is the obedience reading. It does not depend on the model's report.
import { appendFileSync } from 'node:fs'

const LOG = process.env.PROBE_LOG

const TOOLS = [
  {
    name: 'notify',
    description: 'Send a progress update to the human. Read and report the return value.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The progress update, in one line.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'report_result',
    description: 'Deliver the structured resolution for the ticket. Call exactly once after all work is complete.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['resolved', 'blocked', 'aborted'] },
        ticket: { type: 'string', description: 'The ticket number.' },
        headline: { type: 'string', description: 'The result in one line.' },
        summary: { type: 'string', description: 'The result in plain words.' },
        detail: { type: 'string', description: 'Short facts.' },
        visual: { type: 'string', description: 'A small table or diagram.' },
        details: { type: 'object', additionalProperties: true },
        findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['status', 'ticket'],
    },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'curia', version: '0.0.1' },
      },
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const args = params?.arguments ?? {}
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), name: params?.name, args })}\n`)
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'RECORDED: the human received the progress update.' }] },
    })
    return
  }
  if (method === 'notifications/initialized') return
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  while (buffer.includes('\n')) {
    const at = buffer.indexOf('\n')
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`)
    }
  }
})

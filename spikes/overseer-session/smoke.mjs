// Headless smoke test for the spike: one query() with the curia tools, no
// Discord. Verifies the SDK loop, the config-dir/credential posture, and one
// Haiku tool call against the live daemon. Run: node smoke.mjs [resume-id]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(DIR, 'home')
const CONFIG = path.join(DIR, 'config')
const DAEMON = 'http://127.0.0.1:4271'
fs.mkdirSync(HOME, { recursive: true })

async function daemonCommand(text) {
  const res = await fetch(`${DAEMON}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const body = await res.json()
  return body.reply
}

const curia = createSdkMcpServer({
  name: 'curia',
  version: '0.0.1',
  tools: [
    tool('status', 'Show the live workers.', {}, async () => ({ content: [{ type: 'text', text: await daemonCommand('status') }] })),
    tool('tickets', 'List takeable tickets.', { repo: z.string().optional() },
      async ({ repo }) => ({ content: [{ type: 'text', text: await daemonCommand(`frontier${repo ? ' ' + repo : ''}`) }] })),
  ],
})

const resume = process.argv[2]
const t0 = Date.now()
const q = query({
  prompt: resume ? 'What did I ask you before, and what was the answer?' : 'Is curia working on anything right now?',
  options: {
    cwd: HOME,
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(os.homedir(), '.claude') },
    model: 'claude-haiku-4-5',
    resume,
    systemPrompt: 'You are the curia overseer. Answer from tool output only. Be brief.',
    mcpServers: { curia },
    allowedTools: ['mcp__curia__status', 'mcp__curia__tickets'],
    disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
    maxTurns: 6,
  },
})

for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') console.log('session:', msg.session_id, 'model:', msg.model)
  if (msg.type === 'assistant') {
    for (const b of msg.message.content ?? []) {
      if (b.type === 'tool_use') console.log('tool_use:', b.name, JSON.stringify(b.input))
    }
  }
  if (msg.type === 'result') {
    console.log('---')
    console.log('subtype:', msg.subtype, '| turns:', msg.num_turns, '| cost:', msg.total_cost_usd, '| wall:', ((Date.now() - t0) / 1000).toFixed(1) + 's')
    console.log(msg.result)
  }
}

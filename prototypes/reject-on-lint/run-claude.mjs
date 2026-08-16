#!/usr/bin/env node
// Runs one scenario of the #416 live check against the claude harness.
//
// The child is a BARE harness on purpose. No CLAUDE.md, no skills, no built-in
// tools, no settings from this container. Its only way to act is the one MCP
// tool, so what it does after a rejection is the harness and the model, not
// curia's standing orders. That is the floor the daemon has to design against.
//
// Usage:
//   node run-claude.mjs <name> <carriage> <policy> <model> [budgetUsd] [timeoutS]
//
// Writes three files into out/<name>/:
//   stream.jsonl  every stream-json event the CLI emitted
//   calls.jsonl   one line per tool call, written by lint-server.mjs
//   summary.json  the counted result
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const [name, carriage = 'tool-error', policy = 'lint', model = 'opus', budget = '1.5', timeoutS = '900'] = process.argv.slice(2)
if (!name) {
  console.error('usage: run-claude.mjs <name> <carriage> <policy> <model> [budgetUsd] [timeoutS]')
  process.exit(2)
}

// The evidence lands in the repo. The child's HOME and cwd do NOT: a cwd under
// /workspace makes the CLI walk up to curia's own `.mcp.json`, and the child
// then sees the real curia server. SANDBOX_ROOT keeps it outside.
const outDir = join(HERE, 'out', name)
const sandboxRoot = process.env.SANDBOX_ROOT ?? '/tmp/reject-on-lint'
mkdirSync(outDir, { recursive: true })
const callsLog = join(outDir, 'calls.jsonl')
const streamLog = join(outDir, 'stream.jsonl')
writeFileSync(callsLog, '')
writeFileSync(streamLog, '')

// A throwaway home and config dir. The child must not read this container's
// own claude state, or the measurement carries curia's prompt inside it.
const sandbox = join(sandboxRoot, name)
mkdirSync(join(sandbox, 'cfg'), { recursive: true })
mkdirSync(join(sandbox, 'cwd'), { recursive: true })

// The credential the container already holds. Read, never printed.
function oauthToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN
  const f = '/cfg/container.env'
  if (!existsSync(f)) throw new Error('no CLAUDE_CODE_OAUTH_TOKEN and no /cfg/container.env')
  const line = readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))
  if (!line) throw new Error('/cfg/container.env carries no CLAUDE_CODE_OAUTH_TOKEN')
  return line.slice('CLAUDE_CODE_OAUTH_TOKEN='.length).trim()
}

// The server is planted as a PROJECT `.mcp.json`, the way curia plants its own
// (`workspace.mjs` connectionSettings). `--mcp-config` was the first try and it
// is the wrong instrument: the CLI connects those servers "fully async
// (nonblocking)", so turn one can start before the tool exists, and the agent
// then answers that it has no such tool. A project server is up before the
// first turn.
const cwd = join(sandbox, 'cwd')
writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
  mcpServers: {
    lintcheck: {
      type: 'stdio',
      command: process.execPath,
      args: [join(HERE, 'lint-server.mjs')],
      env: { LINT_CARRIAGE: carriage, LINT_MODE: policy, LINT_LOG: callsLog },
    },
  },
}, null, 2))
mkdirSync(join(cwd, '.claude'), { recursive: true })
writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({
  enableAllProjectMcpServers: true,
  permissions: { defaultMode: 'bypassPermissions' },
}, null, 2))

// The task. It never states the voice rules: the agent meets them only through
// the rejection. It also never says "retry" — that is the thing being measured.
// TASK_VARIANT picks the question the child asks.
//
//   cap      the question is itself about a retry cap of 3 or 5
//   neutral  a question with no numbers in it
//
// The `cap` task carries a confound, found after the first ping-pong runs: the
// numbers 3 and 5 sit in the task text, so an agent deciding when to stop
// retrying can anchor on them. The sonnet run said so in as many words. The
// `neutral` task exists to measure the stopping point without that anchor.
const TASKS = {
  cap: [
    'Use the lintcheck ask_human tool to ask the operator one question.',
    '',
    'The question: curia caps how many times an agent may rewrite a rejected message. Should the cap be 3 or 5?',
    'Give the operator both options and one consequence for each. A cap of 3 ends a stuck loop sooner. A cap of 5 gives the agent more room to fix its own text.',
    '',
    'Write the headline and the prompt yourself. Report what the tool said back.',
  ],
  neutral: [
    'Use the lintcheck ask_human tool to ask the operator one question.',
    '',
    'The question: when a ticket closes, should curia withdraw the preview link, or keep it alive?',
    'Give the operator both options and one consequence for each. Withdrawing frees the port and stops a stale page. Keeping it alive lets the operator re-read the page after the merge.',
    '',
    'Write the headline and the prompt yourself. Report what the tool said back.',
  ],
}
const TASK = (TASKS[process.env.TASK_VARIANT ?? 'cap'] ?? TASKS.cap).join('\n')
writeFileSync(join(cwd, 'TASK.md'), `${TASK}\n`)

// The Read is a warm-up, not part of the measurement. The CLI connects MCP
// servers after it builds turn one, so a one-turn task can run before the tool
// exists. One cheap turn puts the tool on the list before the agent needs it.
const PROMPT = 'Read ./TASK.md and do exactly what it says.'

const args = [
  '-p', PROMPT,
  '--output-format', 'stream-json',
  '--verbose',
  '--model', model,
  // The built-in set is cut to Read. `--tools ""` empties the MCP tools too,
  // which leaves the agent with nothing to call and measures nothing.
  '--tools', 'Read',
  '--allowedTools', 'mcp__lintcheck__ask_human Read',
  '--permission-mode', 'bypassPermissions',
  '--max-budget-usd', budget,
  '--no-session-persistence',
  '--setting-sources', 'project',
]

const env = {
  PATH: process.env.PATH,
  HOME: sandbox,
  CLAUDE_CONFIG_DIR: join(sandbox, 'cfg'),
  CLAUDE_CODE_OAUTH_TOKEN: oauthToken(),
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  TERM: 'dumb',
}

const child = spawn('claude', args, { cwd: join(sandbox, 'cwd'), env, stdio: ['ignore', 'pipe', 'pipe'] })

const events = []
let buf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    events.push(line)
    try { events[events.length - 1] = JSON.parse(line) } catch { /* keep the raw line */ }
  }
})
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => { stderr += c })

const killer = setTimeout(() => {
  console.error(`[${name}] timeout after ${timeoutS}s — killing`)
  child.kill('SIGKILL')
}, Number(timeoutS) * 1000)

child.on('close', (code) => {
  clearTimeout(killer)
  writeFileSync(streamLog, events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n'))

  const calls = existsSync(callsLog)
    ? readFileSync(callsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []

  const toolUses = []
  const toolResults = []
  let finalText = ''
  let result = null
  for (const e of events) {
    if (typeof e === 'string') continue
    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_use') toolUses.push({ name: b.name, input: b.input })
        if (b.type === 'text') finalText = b.text
      }
    }
    if (e.type === 'user') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_result') toolResults.push({ is_error: b.is_error === true, content: b.content })
      }
    }
    if (e.type === 'result') result = e
  }

  const summary = {
    name, carriage, policy, model,
    task: process.env.TASK_VARIANT ?? 'cap',
    exit_code: code,
    tool_calls: calls.length,
    rejected: calls.filter((c) => !c.ok).length,
    accepted: calls.filter((c) => c.ok).length,
    accepted_on_call: calls.findIndex((c) => c.ok) + 1 || null,
    distinct_prompts: new Set(calls.map((c) => JSON.stringify(c.args))).size,
    tool_result_is_error: toolResults.map((r) => r.is_error),
    num_turns: result?.num_turns ?? null,
    cost_usd: result?.total_cost_usd ?? null,
    result_subtype: result?.subtype ?? null,
    final_text: (result?.result ?? finalText ?? '').slice(0, 4000),
    stderr: stderr.slice(-2000),
  }
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
})

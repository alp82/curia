#!/usr/bin/env node
// Compare one real-model tool task on the pane and exec lanes for #579.
//
// Usage: node run.mjs <name> <pane|exec>
//
// The rig copies the active Codex credential into a throwaway CODEX_HOME.
// It reads obedience from the MCP server log. It reads tool-search events and
// token use from the rollout. The model's final report is not evidence.
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const [name, lane] = process.argv.slice(2)
if (!name || !['pane', 'exec'].includes(lane)) {
  console.error('usage: node run.mjs <name> <pane|exec>')
  process.exit(2)
}

const MODEL = process.env.MODEL ?? 'gpt-5.6-sol'
const EFFORT = process.env.EFFORT ?? 'high'
const TASK = process.env.TASK ?? 'notify'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300_000)
const AUTH = process.env.CODEX_AUTH
  ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
if (!existsSync(AUTH)) {
  console.error(`Codex credential not found: ${AUTH}`)
  process.exit(2)
}

const outDir = join(HERE, 'out', name)
const runRoot = join(process.env.PROBE_ROOT ?? '/tmp/curia-579', name)
const codexHome = join(runRoot, 'codex')
const cwd = join(runRoot, 'worktree')
const callsLog = join(outDir, 'calls.jsonl')
rmSync(outDir, { recursive: true, force: true })
rmSync(runRoot, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
mkdirSync(codexHome, { recursive: true })
mkdirSync(cwd, { recursive: true })
spawnSync('git', ['init', '-q'], { cwd })
writeFileSync(join(cwd, 'README.md'), '# Throwaway worktree\n')
writeFileSync(callsLog, '')
copyFileSync(AUTH, join(codexHome, 'auth.json'))

const toml = (value) => JSON.stringify(String(value))
writeFileSync(join(codexHome, 'config.toml'), [
  '# Written by prototypes/deferred-tool-offer/run.mjs. Throwaway.',
  `model = ${toml(MODEL)}`,
  `model_reasoning_effort = ${toml(EFFORT)}`,
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  '[features]',
  'hooks = true',
  'apps = false',
  'plugins = false',
  'multi_agent = false',
  'browser_use = false',
  'browser_use_external = false',
  'browser_use_full_cdp_access = false',
  'in_app_browser = false',
  'computer_use = false',
  'in_app_updates = false',
  'skill_mcp_dependency_install = false',
  '',
  '[skills]',
  'bundled = { enabled = false }',
  '',
  `[projects.${toml(cwd)}]`,
  'trust_level = "trusted"',
  '',
  '[mcp_servers.curia]',
  `command = ${toml(process.execPath)}`,
  `args = [${toml(join(HERE, 'tool-server.mjs'))}]`,
  `env = { PROBE_LOG = ${toml(callsLog)} }`,
  '',
].join('\n'))

const SENTINEL = `curia-579-${name}`
const expected = TASK === 'report'
  ? {
      name: 'report_result',
      args: {
        status: 'resolved',
        ticket: '579',
        headline: SENTINEL,
        summary: 'The measurement is complete.',
      },
    }
  : { name: 'notify', args: { message: SENTINEL } }
const prompt = TASK === 'report'
  ? [
      'Use the Curia tool that delivers a structured ticket result exactly once.',
      'Set status to resolved.',
      'Set ticket to "579".',
      `Use exactly ${JSON.stringify(SENTINEL)} as the headline.`,
      'Use exactly "The measurement is complete." as the summary.',
      'Report the tool result, then stop.',
      'Do not use another tool.',
    ].join(' ')
  : [
      'Use the curia notify tool exactly once.',
      `Use exactly ${JSON.stringify(SENTINEL)} as the message field.`,
      'Report the tool result, then stop.',
      'Do not use another tool.',
    ].join(' ')
writeFileSync(join(runRoot, 'prompt.md'), `${prompt}\n`)

const childEnv = {
  PATH: process.env.PATH,
  HOME: runRoot,
  CODEX_HOME: codexHome,
  TERM: lane === 'pane' ? 'xterm-256color' : 'dumb',
}
const flags = [
  '--model', MODEL,
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
]
let log = ''
let child = null
const tmuxSession = `curia579-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-')

if (lane === 'pane') {
  spawnSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
  const command = `codex ${flags.map((part) => part.startsWith('--') ? part : JSON.stringify(part)).join(' ')} "$(cat ${JSON.stringify(join(runRoot, 'prompt.md'))})"`
  writeFileSync(join(outDir, 'spawn.txt'), `${command}\n`)
  const envArgs = Object.entries(childEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  const started = spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, '-x', '200', '-y', '50', ...envArgs, command], { encoding: 'utf8' })
  if (started.status !== 0) {
    console.error(started.stderr)
    process.exit(2)
  }
} else {
  child = spawn('codex', ['exec', '--skip-git-repo-check', ...flags, prompt], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  writeFileSync(join(outDir, 'spawn.txt'), `codex exec --skip-git-repo-check ${flags.join(' ')} ${JSON.stringify(prompt)}\n`)
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
}

function rolloutFiles() {
  const files = []
  const sessions = join(codexHome, 'sessions')
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  if (existsSync(sessions)) walk(sessions)
  return files
}

function newestRollout() {
  return rolloutFiles().sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1) ?? null
}

function rolloutMtime() {
  const file = newestRollout()
  return file ? statSync(file).mtimeMs : 0
}

const deadline = Date.now() + TIMEOUT_MS
let lastMtime = 0
let lastChange = Date.now()
let exitCode = null
let exited = false
if (child) child.on('close', (code) => { exitCode = code; exited = true })

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const mtime = rolloutMtime()
  if (mtime !== lastMtime) {
    lastMtime = mtime
    lastChange = Date.now()
  }
  const called = readFileSync(callsLog, 'utf8').trim().length > 0
  if (lane === 'exec' && exited) break
  if (lane === 'pane' && called && Date.now() - lastChange > 12_000) break
}

if (lane === 'pane') {
  const pane = spawnSync('tmux', ['capture-pane', '-p', '-t', tmuxSession, '-S', '-300'], { encoding: 'utf8' })
  log = pane.stdout ?? ''
  spawnSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
} else if (!exited) {
  child.kill('SIGKILL')
  exitCode = 137
}
writeFileSync(join(outDir, 'codex.log'), log)

const rolloutFile = newestRollout()
const rolloutRaw = rolloutFile ? readFileSync(rolloutFile, 'utf8') : ''
writeFileSync(join(outDir, 'rollout.jsonl'), rolloutRaw)
const rollout = rolloutRaw.split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line) } catch { return null }
}).filter(Boolean)
const payloads = rollout.map((line) => line.payload).filter(Boolean)
const calls = readFileSync(callsLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const toolSearches = payloads.filter((payload) => payload.type === 'tool_search_call')
const toolSearchOutputs = payloads.filter((payload) => payload.type === 'tool_search_output')
const execCalls = payloads.filter((payload) => payload.type === 'custom_tool_call' && payload.name === 'exec')
const tokenEvents = payloads.filter((payload) => payload.type === 'token_count')
const tokens = tokenEvents.at(-1)?.info?.total_token_usage ?? null
const assistantMessages = payloads
  .filter((payload) => payload.type === 'message' && payload.role === 'assistant')
  .map((payload) => (payload.content ?? []).map((item) => item.text ?? '').join('\n'))
const summary = {
  name,
  lane,
  codex_version: spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
  model: MODEL,
  effort: EFFORT,
  task: TASK,
  exit_code: exitCode,
  sentinel: SENTINEL,
  obeyed: calls.length === 1
    && calls[0]?.name === expected.name
    && Object.entries(expected.args).every(([key, value]) => calls[0]?.args?.[key] === value),
  tool_calls: calls,
  discovery_mode: toolSearches.length
    ? 'tool_search'
    : execCalls.some((payload) => String(payload.input ?? '').includes('ALL_TOOLS')) ? 'exec_catalog' : 'none',
  tool_searches: toolSearches.map((payload) => ({ query: payload.arguments?.query ?? null })),
  tool_search_outputs: toolSearchOutputs.length,
  model_turns: tokenEvents.length,
  turn_tokens: tokenEvents.map((payload) => payload.info?.last_token_usage ?? null),
  tokens,
  final_message: assistantMessages.at(-1) ?? null,
  timed_out: Date.now() >= deadline,
}
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))

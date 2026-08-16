#!/usr/bin/env node
// Runs one scenario of the #447 live check: does the codex Stop hook still block
// on 0.146.0?
//
// Usage:
//   node run.mjs <name> [lane] [options]
//
// lane:
//   tui    the daemon's own spawn template, in a tmux pane (the DEFAULT, because
//          it is what config/routing.yaml actually spawns)
//   exec   `codex exec`, the non-interactive lane, for contrast
//
// Env knobs:
//   BLOCKS=N        how many stops the stub daemon refuses (default 2)
//   NO_TRUST_FLAG=1 drop `--dangerously-bypass-hook-trust` from the spawn, to
//                   measure what that flag is actually carrying
//   STUB_PORT / HOOK_PORT   give each concurrent run its own pair
//
// Everything is disposable: a throwaway CODEX_HOME, a throwaway worktree, and
// two stub servers on loopback. Nothing touches the real daemon or the real
// worktree.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const [name, lane = 'tui'] = process.argv.slice(2)
if (!name) {
  console.error('usage: run.mjs <name> [tui|exec]')
  process.exit(2)
}

const STUB_PORT = process.env.STUB_PORT ?? '8899'
const HOOK_PORT = process.env.HOOK_PORT ?? '8901'
const BLOCKS = process.env.BLOCKS ?? '2'
const NO_TRUST_FLAG = process.env.NO_TRUST_FLAG === '1'

// The sentinel is the whole measurement for item 1. It is a string no model and
// no CLI would emit on its own, so finding it on the wire can only mean the
// hook's `reason` travelled there.
const SENTINEL = 'CURIA-BLOCK-SENTINEL'
const REASON = `${SENTINEL}: the ending is not done. Call report_result before you stop.`

const outDir = join(HERE, 'out', name)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const stubLog = join(outDir, 'requests')
const hookLog = join(outDir, 'stops.jsonl')
mkdirSync(stubLog, { recursive: true })

const sandboxRoot = process.env.SANDBOX_ROOT ?? '/tmp/codex-stop-hook'
const runRoot = join(sandboxRoot, name)
rmSync(runRoot, { recursive: true, force: true })
const codexHome = join(runRoot, 'codex')
const cwd = join(runRoot, 'wt')
mkdirSync(codexHome, { recursive: true })
mkdirSync(cwd, { recursive: true })

// A throwaway worktree, as #207 ran it. A git repo, because codex checks.
spawnSync('git', ['init', '-q'], { cwd })
writeFileSync(join(cwd, 'README.md'), '# throwaway\n')

const toml = (s) => JSON.stringify(String(s))

// The config the DAEMON writes, trimmed to what this question needs:
// `hooks = true` from its `[features]` table, the trusted-project entry, and a
// model provider pointed at the stub instead of at the real API.
writeFileSync(join(codexHome, 'config.toml'), [
  '# Written by prototypes/codex-stop-hook/run.mjs. Throwaway.',
  'model_provider = "fake"',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  '[features]',
  'hooks = true',
  '',
  '[model_providers.fake]',
  'name = "fake"',
  `base_url = "http://127.0.0.1:${STUB_PORT}/v1"`,
  'wire_api = "responses"',
  'env_key = "FAKE_KEY"',
  '',
  `[projects.${toml(cwd)}]`,
  'trust_level = "trusted"',
  '',
].join('\n'))

// The Stop hook EXACTLY as daemon/src/workspace.mjs writes it: same file name,
// same nesting, same `curl -d @-` that posts the hook's own stdin payload.
const hookCommand = [
  `curl -s -X POST 'http://127.0.0.1:${HOOK_PORT}/agent_done?agent=probe'`,
  `-H 'Content-Type: application/json'`,
  '-d @-',
].join(' ')
writeFileSync(join(codexHome, 'hooks.json'), `${JSON.stringify({
  hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand }] }] },
}, null, 2)}\n`)

const servers = []
function startServer(file, env) {
  const p = spawn(process.execPath, [join(HERE, file)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', (c) => process.stdout.write(`[${file}] ${c}`))
  p.stderr.on('data', (c) => process.stderr.write(`[${file}] ${c}`))
  servers.push(p)
  return p
}
startServer('stub-responses.mjs', { STUB_PORT, STUB_LOG: stubLog })
startServer('stub-daemon.mjs', { HOOK_PORT, HOOK_LOG: hookLog, BLOCKS, REASON, EXTRA_KEY: process.env.EXTRA_KEY ?? '0' })
await new Promise((r) => setTimeout(r, 700))

const PROMPT = 'Say the word done and stop. Do not use any tool.'
const MODEL = 'gpt-5.5'

// The daemon's own spawn template, from config/routing.yaml.
const flags = [
  '--model', MODEL,
  '--dangerously-bypass-approvals-and-sandbox',
  ...(NO_TRUST_FLAG ? [] : ['--dangerously-bypass-hook-trust']),
]

const childEnv = { PATH: process.env.PATH, HOME: runRoot, CODEX_HOME: codexHome, FAKE_KEY: 'stub', TERM: 'xterm-256color' }
const tmuxSession = `stophook-${name}`
let log = ''

async function readStops() {
  if (!existsSync(hookLog)) return []
  return readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

if (lane === 'tui') {
  // A tmux pane, as the daemon spawns it. The prompt rides as argv, from a file,
  // exactly as `"$(cat {prompt_file})"` does.
  const promptFile = join(runRoot, 'prompt.md')
  writeFileSync(promptFile, PROMPT)
  spawnSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
  const cmd = `codex ${flags.map((f) => (f.startsWith('--') ? f : JSON.stringify(f))).join(' ')} "$(cat ${JSON.stringify(promptFile)})"`
  writeFileSync(join(outDir, 'spawn.txt'), `${cmd}\n`)
  const envArgs = Object.entries(childEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, '-x', '200', '-y', '50', ...envArgs, cmd])

  // Wait for the stops to land, then a beat for the pane to settle.
  const deadline = Date.now() + 90_000
  let stops = []
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    stops = await readStops()
    if (stops.length > Number(BLOCKS)) break
  }
  await new Promise((r) => setTimeout(r, 4000))
  const pane = spawnSync('tmux', ['capture-pane', '-p', '-t', tmuxSession, '-S', '-200'], { encoding: 'utf8' })
  log = pane.stdout ?? ''
  spawnSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
} else {
  const child = spawn('codex', ['exec', '--skip-git-repo-check', ...flags, PROMPT], {
    cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  writeFileSync(join(outDir, 'spawn.txt'), `codex exec --skip-git-repo-check ${flags.join(' ')} ${JSON.stringify(PROMPT)}\n`)
  child.stdout.on('data', (c) => { log += c })
  child.stderr.on('data', (c) => { log += c })
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  await new Promise((r) => child.on('close', () => { clearTimeout(killer); r() }))
}

writeFileSync(join(outDir, 'codex.log'), log)
for (const p of servers) p.kill('SIGKILL')
await new Promise((r) => setTimeout(r, 200))

const stops = await readStops()
const requests = existsSync(stubLog)
  ? readdirSync(stubLog).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => ({ file: f, body: readFileSync(join(stubLog, f), 'utf8') }))
  : []

// Item 1: the reason reaches the MODEL. Read off the wire, not from a report.
const sentinelRequests = requests
  .map((r, i) => ({ request: i + 1, hit: r.body.includes(SENTINEL) }))
  .filter((r) => r.hit).map((r) => r.request)

// What shape the reason arrived in, for the record.
let sentinelItem = null
for (const r of requests) {
  let parsed = null
  try { parsed = JSON.parse(r.body) } catch { continue }
  for (const item of parsed.input ?? []) {
    if (JSON.stringify(item).includes(SENTINEL)) { sentinelItem = item; break }
  }
  if (sentinelItem) break
}

const summary = {
  name,
  lane,
  codex_version: spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
  hook_trust_flag: !NO_TRUST_FLAG,
  blocks_configured: Number(BLOCKS),
  // 1. did the hook fire, and did the refusal reach the model?
  stops_seen: stops.length,
  turns_seen: requests.length,
  reason_reached_model_in_requests: sentinelRequests,
  reason_item_type: sentinelItem?.type ?? null,
  reason_item: sentinelItem,
  // 2. does stop_hook_active flip on the second stop?
  stop_hook_active_by_stop: stops.map((s) => ({ stop: s.stop, stop_hook_active: s.stop_hook_active })),
  payload_keys: stops[0]?.keys ?? null,
  codex_log_tail: log.slice(-2000),
}
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ ...summary, reason_item: undefined, codex_log_tail: undefined }, null, 2))

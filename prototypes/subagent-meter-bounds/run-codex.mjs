#!/usr/bin/env node
// The codex lane of #544: spawn_agent under curia's own config, with the model
// stubbed (no codex credential exists in an agent container — the #447
// precedent). Three questions, all mechanical, all read off disk or off the
// wire, so the stub costs nothing that matters here:
//
//   1. WHERE does the spawned child write its rollout — the parent's file, its
//      own file under sessions/, or nowhere?
//   2. WHAT does the daemon's own meter (`findTranscript` + `codexTail`) report
//      while the child runs and after it ends? A poller samples the exact code
//      `daemon/src/usage.mjs` runs, four times a second, into timeline.jsonl.
//   3. DOES the child receive the standing orders? Curia's orders live in
//      `$CODEX_HOME/AGENTS.md`; this rig plants a sentinel there and greps the
//      child's own request bodies for it. What a real model would DO with the
//      orders is model behavior and out of a stub's reach — the run measures
//      what the child was GIVEN, and whether anything blocks its write outside
//      the worktree.
//
// Usage: node run-codex.mjs <name> [discover]
//   discover: unscripted stub; the value is out/<name>/requests/req-*.json,
//   which carries the tool schemas codex 0.146.0 actually advertises.
//
// Env knobs: STUB_PORT (default 8899), SANDBOX_ROOT (default /tmp/curia-544).
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, appendFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { findTranscript } = await import(join(HERE, '../../daemon/src/transcript.mjs'))
const { readTranscriptMeters } = await import(join(HERE, '../../daemon/src/usage.mjs'))

const [name, mode = 'scripted'] = process.argv.slice(2)
if (!name) {
  console.error('usage: run-codex.mjs <name> [discover]')
  process.exit(2)
}
const DISCOVER = mode === 'discover'
const STUB_PORT = process.env.STUB_PORT ?? '8899'

const SENTINEL = 'CURIA-544-ORDERS-SENTINEL'

const outDir = join(HERE, 'out', name)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const stubLog = join(outDir, 'requests')
mkdirSync(stubLog, { recursive: true })
const timelineFile = join(outDir, 'timeline.jsonl')

const sandboxRoot = process.env.SANDBOX_ROOT ?? '/tmp/curia-544'
const runRoot = join(sandboxRoot, name)
rmSync(runRoot, { recursive: true, force: true })
const codexHome = join(runRoot, 'codex')
const cwd = join(runRoot, 'wt')
const outsideTarget = join(runRoot, 'outside-probe.txt') // outside the worktree, inside the throwaway root
mkdirSync(codexHome, { recursive: true })
mkdirSync(cwd, { recursive: true })

spawnSync('git', ['init', '-q'], { cwd })
writeFileSync(join(cwd, 'README.md'), '# throwaway\n')

const toml = (s) => JSON.stringify(String(s))

// The config the daemon writes (workspace.mjs connectionSettings), trimmed of
// what needs a live daemon: no [mcp_servers.curia] (the stub has no MCP server
// to offer) and no hooks.json (the Stop hook is #447's question, not this
// one). The [features] table is curia's, verbatim — multi_agent = false
// included, so the run re-measures #207's no-op on the way through.
writeFileSync(join(codexHome, 'config.toml'), [
  '# Written by prototypes/subagent-meter-bounds/run-codex.mjs. Throwaway.',
  'model_provider = "fake"',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  '[features]',
  'hooks = true',
  'apps = false',
  'plugins = false',
  // Curia writes `multi_agent = false`, measured a no-op on a live account
  // (#207). Under a stub provider no account-side flag overrides the local
  // key, so MULTI_AGENT=1 flips it (plus multi_agent_v2) to get the
  // collaboration tools at all — see the finding for what that means.
  ...(process.env.MULTI_AGENT === '1' ? ['multi_agent = true', 'multi_agent_v2 = true'] : ['multi_agent = false']),
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
  '[model_providers.fake]',
  'name = "fake"',
  `base_url = "http://127.0.0.1:${STUB_PORT}/v1"`,
  'wire_api = "responses"',
  'env_key = "FAKE_KEY"',
  '',
].join('\n'))

// The memory file, where curia's standing orders live for a codex agent
// (workspace.mjs memoryFileFor: AGENTS.md in the config dir). The sentinel is
// the measurement: it appears in the child's request bodies or it does not.
writeFileSync(join(codexHome, 'AGENTS.md'), [
  `# curia standing orders (${SENTINEL})`,
  '',
  '## Bounds (curia daemon)',
  '',
  `- **Write only:** files inside ${cwd}. Nothing outside the worktree on disk.`,
  '',
].join('\n'))

const stub = spawn(process.execPath, [join(HERE, 'stub-responses.mjs')], {
  env: {
    ...process.env, STUB_PORT, STUB_LOG: stubLog, DISCOVER: DISCOVER ? '1' : '0', OUTSIDE_TARGET: outsideTarget,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
stub.stdout.on('data', (c) => process.stdout.write(`[stub] ${c}`))
stub.stderr.on('data', (c) => process.stderr.write(`[stub] ${c}`))
await new Promise((r) => setTimeout(r, 700))

// The daemon's own spawn template, from config/routing.yaml.
const PROMPT = DISCOVER
  ? 'Say the word done and stop. Do not use any tool.'
  : 'PARENT-544: delegate the task your model knows about to a subagent, wait for it, then stop.'
const MODEL = 'gpt-5.5'
const promptFile = join(runRoot, 'prompt.md')
writeFileSync(promptFile, PROMPT)

const flags = ['--model', MODEL, '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']
const cmd = `codex ${flags.map((f) => (f.startsWith('--') ? f : JSON.stringify(f))).join(' ')} "$(cat ${JSON.stringify(promptFile)})"`
writeFileSync(join(outDir, 'spawn.txt'), `${cmd}\n`)

const childEnv = { PATH: process.env.PATH, HOME: runRoot, CODEX_HOME: codexHome, FAKE_KEY: 'stub', TERM: 'xterm-256color' }
const tmuxSession = `sub544-${name}`
spawnSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
const envArgs = Object.entries(childEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`])
spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, '-x', '200', '-y', '50', ...envArgs, cmd])

// The meter poller: EXACTLY what the daemon reads, on a cadence. Every sample
// says which file newest-by-mtime picked and what codexTail read off it.
let lastSample = ''
const poller = setInterval(() => {
  try {
    const file = findTranscript('codex', codexHome)
    const { ctx } = readTranscriptMeters('codex', file)
    const sample = JSON.stringify({ file: file ? relative(codexHome, file) : null, tokens: ctx?.tokens ?? null })
    if (sample !== lastSample) {
      lastSample = sample
      appendFileSync(timelineFile, `${JSON.stringify({ at: new Date().toISOString(), ...JSON.parse(sample) })}\n`)
    }
  } catch { /* a torn write mid-poll is codex's documented non-atomicity; skip the sample */ }
}, 250)

// Wait until the wire goes quiet: no new stub request for 15 s, or 120 s total.
const deadline = Date.now() + 120_000
const reqCount = () => readdirSync(stubLog).length
let last = 0
let lastChange = Date.now()
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000))
  const c = reqCount()
  if (c !== last) { last = c; lastChange = Date.now() }
  if (c > 0 && Date.now() - lastChange > 15_000) break
}
clearInterval(poller)
const pane = spawnSync('tmux', ['capture-pane', '-p', '-t', tmuxSession, '-S', '-200'], { encoding: 'utf8' })
writeFileSync(join(outDir, 'pane.txt'), pane.stdout ?? '')
spawnSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
stub.kill('SIGKILL')

// ---- read the run ---------------------------------------------------------

// Every rollout file codex wrote, with its token_count trail.
function rollouts() {
  const found = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.jsonl')) found.push(p)
    }
  }
  if (existsSync(join(codexHome, 'sessions'))) walk(join(codexHome, 'sessions'))
  return found.map((p) => {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    const counts = []
    let marker = null
    for (const line of lines) {
      if (!marker && line.includes('PARENT-544')) marker = 'parent'
      if (!marker && line.includes('CHILD-544')) marker = 'child'
      if (!line.includes('"token_count"')) continue
      try {
        const e = JSON.parse(line)
        if (e?.payload?.type === 'token_count') {
          counts.push({ at: e.timestamp ?? null, input_tokens: e.payload.info?.last_token_usage?.input_tokens ?? null })
        }
      } catch { /* torn line */ }
    }
    return {
      file: relative(codexHome, p), marker, lines: lines.length, mtime: new Date(statSync(p).mtimeMs).toISOString(), token_counts: counts,
    }
  })
}

const requests = readdirSync(stubLog).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  .map((f) => ({ file: f, body: readFileSync(join(stubLog, f), 'utf8') }))
const childRequests = requests.filter((r) => !r.body.includes('PARENT-544') && r.body.includes('CHILD-544'))

const files = rollouts()
const parentFile = files.find((f) => f.marker === 'parent')
const summary = {
  name,
  mode,
  codex_version: spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
  requests_seen: requests.length,
  child_requests_seen: childRequests.length,
  rollout_files: files,
  // 1. the file layout
  child_usage_in_parent_rollout: parentFile ? parentFile.token_counts.some((c) => c.input_tokens === 2222) : null,
  // 2. what the daemon's meter picked, over time — the timeline file holds it
  final_findTranscript_pick: (() => { const f = findTranscript('codex', codexHome); return f ? relative(codexHome, f) : null })(),
  final_codexTail_tokens: readTranscriptMeters('codex', findTranscript('codex', codexHome)).ctx?.tokens ?? null,
  // 3. the standing orders, on the child's own wire
  child_saw_orders_sentinel: childRequests.length ? childRequests.some((r) => r.body.includes(SENTINEL)) : null,
  // the out-of-bounds write
  outside_probe_written: existsSync(outsideTarget),
  outside_probe_content: existsSync(outsideTarget) ? readFileSync(outsideTarget, 'utf8').trim() : null,
}
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))

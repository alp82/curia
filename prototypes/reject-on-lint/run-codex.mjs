#!/usr/bin/env node
// Runs one scenario of the #416 live check against the codex harness, with the
// stub Responses API standing in for the model.
//
// Usage:
//   node run-codex.mjs <name> <carriage> [port]
//
// Writes into out/<name>/:
//   calls.jsonl   one line per tool call, from lint-server.mjs
//   req-N.json    the request body codex sent for turn N, from the stub
//   codex.log     the CLI's own output
//   summary.json  the counted result
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const [name, carriage = 'tool-error', port = '8899'] = process.argv.slice(2)
if (!name) {
  console.error('usage: run-codex.mjs <name> <carriage> [port]')
  process.exit(2)
}

const outDir = join(HERE, 'out', name)
mkdirSync(outDir, { recursive: true })
const callsLog = join(outDir, 'calls.jsonl')
writeFileSync(callsLog, '')
const stubLog = join(outDir, 'requests')
mkdirSync(stubLog, { recursive: true })

const sandboxRoot = process.env.SANDBOX_ROOT ?? '/tmp/reject-on-lint'
const codexHome = join(sandboxRoot, name, 'codex')
const cwd = join(sandboxRoot, name, 'cwd')
mkdirSync(codexHome, { recursive: true })
mkdirSync(cwd, { recursive: true })

const toml = (s) => JSON.stringify(String(s))
writeFileSync(join(codexHome, 'config.toml'), [
  'model_provider = "fake"',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  '[model_providers.fake]',
  'name = "fake"',
  `base_url = "http://127.0.0.1:${port}/v1"`,
  'wire_api = "responses"',
  'env_key = "FAKE_KEY"',
  '',
  '[mcp_servers.lintcheck]',
  `command = ${toml(process.execPath)}`,
  `args = [${toml(join(HERE, 'lint-server.mjs'))}]`,
  `env = { LINT_CARRIAGE = ${toml(carriage)}, LINT_MODE = "lint", LINT_LOG = ${toml(callsLog)} }`,
  '',
  `[projects.${toml(cwd)}]`,
  'trust_level = "trusted"',
  '',
].join('\n'))

const stub = spawn(process.execPath, [join(HERE, 'stub-responses.mjs')], {
  env: { ...process.env, STUB_PORT: port, STUB_LOG: stubLog, STUB_VARIANT: process.env.STUB_VARIANT ?? 'print' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
stub.stdout.on('data', (c) => process.stdout.write(`[stub] ${c}`))
stub.stderr.on('data', (c) => process.stderr.write(`[stub] ${c}`))

await new Promise((r) => setTimeout(r, 500))

const child = spawn('codex', [
  'exec',
  '--skip-git-repo-check',
  'Use the lintcheck ask_human tool to ask the operator whether the rewrite cap should be 3 or 5.',
], {
  cwd,
  env: { PATH: process.env.PATH, HOME: join(sandboxRoot, name), CODEX_HOME: codexHome, FAKE_KEY: 'stub', TERM: 'dumb' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let log = ''
child.stdout.on('data', (c) => { log += c })
child.stderr.on('data', (c) => { log += c })

const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)

child.on('close', (code) => {
  clearTimeout(killer)
  stub.kill('SIGKILL')
  writeFileSync(join(outDir, 'codex.log'), log)

  const calls = existsSync(callsLog)
    ? readFileSync(callsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const requests = readdirSync(stubLog).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => JSON.parse(readFileSync(join(stubLog, f), 'utf8')))

  // The question the stub can answer: does the rejection reach the model, and
  // in what item shape? Read it out of the NEXT request's input list.
  const carried = []
  for (const [i, r] of requests.entries()) {
    for (const item of r.input ?? []) {
      const text = JSON.stringify(item)
      if (text.includes('REJECTED')) carried.push({ request: i + 1, item_type: item.type, item })
    }
  }

  const summary = {
    name, carriage,
    exit_code: code,
    requests: requests.length,
    tool_calls: calls.length,
    rejected: calls.filter((c) => !c.ok).length,
    accepted: calls.filter((c) => c.ok).length,
    // Codex names its callable tools in `client_metadata`, not in a `tools`
    // array. That is where the MCP namespacing shows up.
    tool_names: Object.keys(JSON.parse(requests[0]?.client_metadata?.['x-codex-turn-metadata'] ?? '{}').code_mode_tool_names ?? {})
      .filter((k) => k.includes('ask_human')),
    variant: process.env.STUB_VARIANT ?? 'print',
    rejection_carried_in: carried.map((c) => ({ request: c.request, item_type: c.item_type })),
    rejection_item: carried[0]?.item ?? null,
    codex_log_tail: log.slice(-1500),
  }
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
})

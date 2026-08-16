#!/usr/bin/env node
// Runs one scenario of the #416 / #448 live check on the codex harness.
//
// Two lanes, one instrument.
//
//   stub (default)  a stub Responses API stands in for the model, so the run
//                   needs no credential and can run inside a container. This is
//                   the #416 arm. It answers the mechanics and not the judgment.
//   REAL=1          a real codex model on the real endpoint, with the operator's
//                   own credential. This is the #448 arm, and it answers the
//                   judgment: does the model rewrite after a rejection, and does
//                   it print the `exec` script's return value by itself.
//
// The real lane runs on the box, never in an agent container: #438 settled that
// no codex credential goes into one.
//
// Usage:
//   node run-codex.mjs <name> <carriage> [port]
//   REAL=1 node run-codex.mjs <name> <carriage>
//
// Env knobs (both lanes):
//   LINT_MODE=lint|always|until:N|cap:N   the rejecter's policy (default lint)
//   LINT_TOOL_DESC=plain|read-return      the tool description (default plain)
//   TASK_VARIANT=cap|neutral              the question the agent asks (default cap)
//
// Env knobs (real lane only):
//   MODEL=gpt-5.6-sol      the model, the one config/routing.yaml spawns
//   EFFORT=high            the reasoning effort routing.yaml states
//   CODEX_AUTH=<path>      the credential to copy in (default ~/.codex/auth.json)
//   TIMEOUT_MS=900000      how long to wait for the session
//
// Writes into out/<name>/:
//   calls.jsonl   one line per tool call, from lint-server.mjs
//   codex.log     the CLI's own output
//   rollout.jsonl the session transcript codex wrote (real lane)
//   req-N.json    the request body codex sent for turn N (stub lane)
//   summary.json  the counted result
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const [name, carriage = 'tool-error', port = '8899'] = process.argv.slice(2)
if (!name) {
  console.error('usage: run-codex.mjs <name> <carriage> [port]')
  process.exit(2)
}

const REAL = process.env.REAL === '1'
const LINT_MODE = process.env.LINT_MODE ?? 'lint'
const TOOL_DESC = process.env.LINT_TOOL_DESC ?? 'plain'
const TASK_VARIANT = process.env.TASK_VARIANT ?? 'cap'
const MODEL = process.env.MODEL ?? 'gpt-5.6-sol'
const EFFORT = process.env.EFFORT ?? 'high'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? (REAL ? 1_800_000 : 120_000))

const outDir = join(HERE, 'out', name)
mkdirSync(outDir, { recursive: true })
const callsLog = join(outDir, 'calls.jsonl')
writeFileSync(callsLog, '')
const stubLog = join(outDir, 'requests')
mkdirSync(stubLog, { recursive: true })

// The whole sandbox goes first. A re-run under the same name would otherwise
// keep the last session's rollout, and the reading below takes the newest file
// it finds. A run that dies before it writes one would then be read as the run
// before it.
const sandboxRoot = process.env.SANDBOX_ROOT ?? '/tmp/reject-on-lint'
const codexHome = join(sandboxRoot, name, 'codex')
const cwd = join(sandboxRoot, name, 'cwd')
rmSync(join(sandboxRoot, name), { recursive: true, force: true })
mkdirSync(codexHome, { recursive: true })
mkdirSync(cwd, { recursive: true })

// The task. It never states the voice rules: the agent meets them only through
// the rejection. It never says "retry" either — that is the thing measured.
// The `cap` task names 3 and 5, which an agent can anchor its own stopping
// point on, so a ping-pong run wants `neutral` (#416 section 2).
const TASKS = {
  cap: [
    'Use the lintcheck ask_human tool to ask the operator one question.',
    'The question: curia caps how many times an agent may rewrite a rejected message. Should the cap be 3 or 5?',
    'Give the operator both options and one consequence for each. A cap of 3 ends a stuck loop sooner. A cap of 5 gives the agent more room to fix its own text.',
    'Write the headline and the prompt yourself. Report what the tool said back.',
  ],
  neutral: [
    'Use the lintcheck ask_human tool to ask the operator one question.',
    'The question: when a ticket closes, should curia withdraw the preview link, or keep it alive?',
    'Give the operator both options and one consequence for each. Withdrawing frees the port and stops a stale page. Keeping it alive lets the operator re-read the page after the merge.',
    'Write the headline and the prompt yourself. Report what the tool said back.',
  ],
}
const TASK = (TASKS[TASK_VARIANT] ?? TASKS.cap).join(' ')

// The credential. A COPY, not a symlink: codex refreshes the token in place and
// this dir is thrown away, so the operator's own auth.json must not be the file
// under the run.
const authSrc = process.env.CODEX_AUTH ?? join(homedir(), '.codex', 'auth.json')
if (REAL) {
  if (!existsSync(authSrc)) {
    console.error(`REAL=1 needs a codex credential. Not found: ${authSrc}`)
    console.error('Run this on the box, where the operator is logged in. Never in an agent container (#438).')
    process.exit(2)
  }
  copyFileSync(authSrc, join(codexHome, 'auth.json'))
}

const toml = (s) => JSON.stringify(String(s))

// TOML is order-sensitive: every top-level key must precede the first table, or
// it silently joins that table instead. An `approval_policy` that lands inside
// `[model_providers.fake]` reads as unset, and the run then dies on an approval
// prompt nobody answers.
const topKeys = REAL
  // The real lane takes codex's own default provider and the credential beside
  // it. The model and the effort are the ones config/routing.yaml spawns.
  ? [`model = ${toml(MODEL)}`, `model_reasoning_effort = ${toml(EFFORT)}`]
  : ['model_provider = "fake"']
const providerTable = REAL ? [] : [
  '[model_providers.fake]',
  'name = "fake"',
  `base_url = "http://127.0.0.1:${port}/v1"`,
  'wire_api = "responses"',
  'env_key = "FAKE_KEY"',
  '',
]

writeFileSync(join(codexHome, 'config.toml'), [
  '# Written by prototypes/reject-on-lint/run-codex.mjs. Throwaway.',
  ...topKeys,
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  ...providerTable,
  '[mcp_servers.lintcheck]',
  `command = ${toml(process.execPath)}`,
  `args = [${toml(join(HERE, 'lint-server.mjs'))}]`,
  `env = { LINT_CARRIAGE = ${toml(carriage)}, LINT_MODE = ${toml(LINT_MODE)}, LINT_TOOL_DESC = ${toml(TOOL_DESC)}, LINT_LOG = ${toml(callsLog)} }`,
  '',
  `[projects.${toml(cwd)}]`,
  'trust_level = "trusted"',
  '',
].join('\n'))

let stub = null
if (!REAL) {
  stub = spawn(process.execPath, [join(HERE, 'stub-responses.mjs')], {
    env: { ...process.env, STUB_PORT: port, STUB_LOG: stubLog, STUB_VARIANT: process.env.STUB_VARIANT ?? 'print' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  stub.stdout.on('data', (c) => process.stdout.write(`[stub] ${c}`))
  stub.stderr.on('data', (c) => process.stderr.write(`[stub] ${c}`))
  await new Promise((r) => setTimeout(r, 500))
}

const child = spawn('codex', ['exec', '--skip-git-repo-check', TASK], {
  cwd,
  env: {
    PATH: process.env.PATH,
    HOME: join(sandboxRoot, name),
    CODEX_HOME: codexHome,
    TERM: 'dumb',
    ...(REAL ? {} : { FAKE_KEY: 'stub' }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let log = ''
child.stdout.on('data', (c) => { log += c })
child.stderr.on('data', (c) => { log += c })

const killer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)

// ------------------------------------------------------------ the reading --
// The stub lane reads the request bodies it captured. The real lane cannot: the
// requests go to the real endpoint. It reads the ROLLOUT instead — the session
// transcript codex writes under CODEX_HOME/sessions. That file carries the
// `exec` script the model wrote, byte for byte, and the output codex handed
// back for it. So both lanes read the wire and neither reads the model's own
// account of itself.
function newestRollout() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) found.push(full)
    }
  }
  const sessions = join(codexHome, 'sessions')
  if (!existsSync(sessions)) return null
  walk(sessions)
  if (!found.length) return null
  return found.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1)
}

function readRollout() {
  const file = newestRollout()
  if (!file) return null
  const raw = readFileSync(file, 'utf8')
  writeFileSync(join(outDir, 'rollout.jsonl'), raw)
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

// Did the tool's return value reach the model? Read it off the output codex
// sent back for the script, not off the script's source. A script can print and
// still be given nothing, and the output item is what the next turn sees.
function scriptRows(rollout) {
  const rows = []
  const scripts = new Map()
  for (const line of rollout) {
    const p = line?.payload
    if (p?.type === 'custom_tool_call' && p.name === 'exec') scripts.set(p.call_id, p.input ?? '')
    if (p?.type === 'custom_tool_call_output') {
      const text = (p.output ?? []).map((o) => o.text ?? '').join('\n')
      const source = scripts.get(p.call_id) ?? ''
      rows.push({
        call_id: p.call_id,
        // The header before `Output:`. It says whether the isolate completed or
        // failed, and reading a rejection without it invites a wrong story
        // about a script that threw.
        outcome: text.split('Output:\n')[0].trim(),
        // Everything after the `Output:` header is what the script printed.
        printed: text.split('Output:\n').slice(1).join('Output:\n').trim(),
        carries_rejection: text.includes('REJECTED'),
        carries_accept: text.includes('ACCEPTED') || text.includes('SENT WITH A LINT WARNING'),
        script: source,
      })
    }
  }
  return rows
}

child.on('close', (code) => {
  clearTimeout(killer)
  stub?.kill('SIGKILL')
  writeFileSync(join(outDir, 'codex.log'), log)

  const calls = existsSync(callsLog)
    ? readFileSync(callsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const rollout = readRollout() ?? []
  const scripts = scriptRows(rollout)
  const assistant = rollout
    .filter((l) => l?.payload?.type === 'message' && l.payload.role === 'assistant')
    .map((l) => (l.payload.content ?? []).map((c) => c.text ?? '').join('\n'))
  const tokens = rollout.filter((l) => l?.payload?.type === 'token_count').at(-1)?.payload?.info?.total_token_usage ?? null
  const firstAccepted = calls.findIndex((c) => c.ok)

  const summary = {
    name,
    lane: REAL ? 'real' : 'stub',
    carriage,
    policy: LINT_MODE,
    tool_desc: TOOL_DESC,
    task: TASK_VARIANT,
    model: REAL ? MODEL : 'stub',
    effort: REAL ? EFFORT : null,
    exit_code: code,
    tool_calls: calls.length,
    rejected: calls.filter((c) => !c.ok).length,
    accepted: calls.filter((c) => c.ok).length,
    // The #448 question 1, mechanically: after a rejection, did the model call
    // again, and did the next text pass?
    passed_on_attempt: firstAccepted === -1 ? null : firstAccepted + 1,
    // The #448 question 2, mechanically: did the script's return value reach
    // the model at all?
    scripts: scripts.map((s) => ({
      call_id: s.call_id,
      carries_rejection: s.carries_rejection,
      carries_accept: s.carries_accept,
      printed_chars: s.printed.length,
    })),
    return_value_reached_model: scripts.some((s) => s.carries_rejection || s.carries_accept),
    scripts_full: scripts,
    final_message: assistant.at(-1) ?? null,
    tokens,
    codex_log_tail: log.slice(-1500),
  }

  if (!REAL) {
    // The stub lane keeps its own evidence: the request bodies it captured, and
    // the item shape the rejection travelled in.
    const requests = readdirSync(stubLog).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((f) => JSON.parse(readFileSync(join(stubLog, f), 'utf8')))
    const carried = []
    for (const [i, r] of requests.entries()) {
      for (const item of r.input ?? []) {
        const text = JSON.stringify(item)
        if (text.includes('REJECTED')) carried.push({ request: i + 1, item_type: item.type, item })
      }
    }
    summary.requests = requests.length
    summary.variant = process.env.STUB_VARIANT ?? 'print'
    // Codex names its callable tools in `client_metadata`, not in a `tools`
    // array. That is where the MCP namespacing shows up.
    summary.tool_names = Object.keys(JSON.parse(requests[0]?.client_metadata?.['x-codex-turn-metadata'] ?? '{}').code_mode_tool_names ?? {})
      .filter((k) => k.includes('ask_human'))
    summary.rejection_carried_in = carried.map((c) => ({ request: c.request, item_type: c.item_type }))
    summary.rejection_item = carried[0]?.item ?? null
  }

  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ ...summary, scripts_full: `<${scripts.length} scripts, see summary.json>` }, null, 2))
})

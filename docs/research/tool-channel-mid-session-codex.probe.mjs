// The codex half of what a harness does when the daemon dies UNDER it (#371).
//
// [tool-channel-mid-session.probe.mjs](tool-channel-mid-session.probe.mjs)
// measured the claude harness and said so: an agent container carries no codex
// credential, so that probe cannot run there. This file removes the credential
// from the path. It stands in for the MODEL as well as the daemon, so the codex
// CLI under test is the real one and the thing it talks to is not.
//
// That is the same trade the claude probe already made in the other direction.
// Its deviation 2 reads "the model is haiku. The transport is what is under
// test, and it carries no model." Here the transport is still the real codex MCP
// client, with the real `tool_timeout_sec` the daemon writes, and the model is a
// script.
//
// The stand-in daemon is the claude probe's, unchanged in shape: it serves
// `POST /mcp?agent=&ticket=` with a stateless `StreamableHTTPServerTransport`
// and the `x-curia-agent-token` header, exactly as `daemon/src/index.mjs` does.
// The agent reaches it through the `config.toml` that `daemon/src/workspace.mjs`
// writes for a codex agent, with `tool_timeout_sec` at the daemon's own day.
//
// Two cases, the claude probe's two:
//   drop     the daemon dies while it holds a blocking `ask_human`, and is back
//            5 s later. Measures what the agent is told, and how long it waits.
//   refused  the daemon dies with no call in flight and stays down 20 s while
//            the agent retries. Measures whether the tools come back by
//            themselves.
//
// Run:  node docs/research/tool-channel-mid-session-codex.probe.mjs <drop|refused> [scratch-dir]
// Needs the `codex` binary and `npm ci` in `daemon/`. It needs NO credential of
// any kind, which is the whole point of it.
//
// PROBE_CAP_S bounds the drop case. Codex bounds one tool call at 24 hours, so a
// client that never notices the drop would hang the probe for a day; the cap
// ends the run and the reading is then "still waiting at the cap".
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)

// The MCP SDK is the daemon's dependency and this file lives outside its
// package, so it is resolved from `daemon/package.json` rather than imported by
// name. Run `npm ci` in `daemon/` first.
const dep = createRequire(path.join(SELF, '../../../daemon/package.json'))
const load = async (spec) => import(pathToFileURL(dep.resolve(spec)).href)
const { McpServer } = await load('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = await load('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = await load('zod')

const PORT = Number(process.env.PROBE_PORT ?? 9010)
const MODEL_PORT = Number(process.env.PROBE_MODEL_PORT ?? 9011)
const TOKEN = 'probe-token'
const TOKEN_HEADER = 'x-curia-agent-token'
const AGENT = 'curia-371'
// The value `daemon/src/workspace.mjs` writes as CODEX_TOOL_TIMEOUT_S. A day.
const TOOL_TIMEOUT_S = Number(process.env.PROBE_TOOL_TIMEOUT_S ?? 86_400)
const CAP_MS = Number(process.env.PROBE_CAP_S ?? 900) * 1000

// ---- the stand-in daemon ---------------------------------------------------

function log(dir, entry) {
  fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`)
}

// The daemon dies once, under the tool this case names, and the flag file is
// what keeps the respawned process from dying again.
function maybeDie(dir, tool, dieUnder, afterMs) {
  const flag = path.join(dir, 'died')
  if (tool !== dieUnder || fs.existsSync(flag)) return
  fs.writeFileSync(flag, String(Date.now()))
  setTimeout(() => {
    log(dir, { ev: 'daemon_dies', while_holding: tool })
    process.exit(1)
  }, afterMs)
}

function buildMcpServer(dir, dieUnder, afterMs) {
  const s = new McpServer({ name: 'curia', version: '0.0.1' })
  s.tool('notify', 'Fire-and-forget status line.', { message: z.string() }, async ({ message }) => {
    log(dir, { ev: 'tool', tool: 'notify', message })
    maybeDie(dir, 'notify', dieUnder, afterMs)
    return { content: [{ type: 'text', text: `noted: ${message}` }] }
  })
  s.tool('ask_human', 'Blocking question to a human.', { prompt: z.string() }, async ({ prompt }) => {
    log(dir, { ev: 'tool', tool: 'ask_human', prompt })
    maybeDie(dir, 'ask_human', dieUnder, afterMs)
    // Blocks the way the real one does: an answer takes as long as a human takes.
    await new Promise((r) => setTimeout(r, 300_000))
    return { content: [{ type: 'text', text: 'the human said: go ahead' }] }
  })
  return s
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { return {} }
}

function serve(dir, dieUnder, afterMs) {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (url.pathname !== '/mcp') { res.writeHead(404).end('{}'); return }
    const body = await readBody(req)
    log(dir, {
      ev: 'request', method: req.method, rpc: body?.method ?? null, id: body?.id ?? null,
      tool: body?.params?.name ?? null, token_ok: req.headers[TOKEN_HEADER] === TOKEN,
    })
    if (req.method !== 'POST') { res.writeHead(405).end('{}'); return }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close() })
    const mcp = buildMcpServer(dir, dieUnder, afterMs)
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }).listen(PORT, '127.0.0.1', () => log(dir, { ev: 'listening', port: PORT }))
}

// ---- the stand-in model ----------------------------------------------------

// Codex speaks the Responses wire API and no other: `wire_api = "chat"` is
// refused by the pinned CLI with "no longer supported". So this serves
// `POST /v1/responses` and streams the three events codex needs to accept a
// turn — created, one output item, completed.
//
// What it replaces is the model's JUDGEMENT, not the harness. The claude probe
// wrote its steps in a prompt and trusted haiku to follow them; this one names
// the same steps as function calls. That is the point in the `refused` case,
// where the claude run ended because its model gave up after 25 tries — a
// reading of a model's patience rather than of a transport.
//
// A script has the opposite problem: it answers in milliseconds. Its first run
// of `refused` spent every attempt inside one second and finished before the
// daemon had even died. So each step carries a pause, standing in for the
// seconds a model takes, and the retry budget is a wall clock rather than a
// count: 40 attempts at a second each outlive the 20 s outage.
const THINK_MS = Number(process.env.PROBE_THINK_MS ?? 300)
const RETRY_MAX = Number(process.env.PROBE_RETRY_MAX ?? 40)

function nextStep(which, calls) {
  const n = calls.length
  const last = calls[n - 1]
  if (which === 'drop') {
    // 1. notify one   2. ask_human (the daemon dies under it)   3. notify two
    // 4. notify three, then say what happened.
    if (n === 0) return { tool: 'notify', args: { message: 'one' }, waitMs: THINK_MS }
    if (n === 1) return { tool: 'ask_human', args: { prompt: 'blocking' }, waitMs: THINK_MS }
    if (n === 2) return { tool: 'notify', args: { message: 'two' }, waitMs: THINK_MS }
    if (n === 3) return { tool: 'notify', args: { message: 'three' }, waitMs: THINK_MS }
    return { done: true }
  }
  // refused: one call that succeeds, then call again until THAT one succeeds.
  if (n === 0) return { tool: 'notify', args: { message: 'one' }, waitMs: THINK_MS }
  const retries = n - 1
  if (retries > 0 && last?.ok) return { done: true }
  if (retries >= RETRY_MAX) return { done: true }
  // The daemon dies a second after the first call, so the first retry waits past
  // that death rather than racing it.
  return { tool: 'notify', args: { message: 'two' }, waitMs: retries === 0 ? 2500 : 1000 }
}

// The stand-in daemon answers `notify` with this text, so its presence in a
// function_call_output is what "the call succeeded" means here.
const OK_MARK = 'noted:'

// The pinned codex (0.146) does not offer an MCP tool as a function of its own.
// It offers the SERVER as one tool of type `namespace`, named `mcp__curia`, with
// the server's tools nested inside it. The name the model calls is the two
// joined by the same double underscore — `mcp__curia__notify`, the
// `mcp__<server>__<tool>` identifier the CLI's own prompt text names. So the
// names are read off the offer rather than spelled here, and a codex that
// changes this shape breaks loudly at the lookup below.
function toolNames(tools) {
  return (tools ?? []).flatMap((t) => (
    t?.type === 'namespace' ? (t.tools ?? []).map((n) => `${t.name}__${n.name}`) : [t?.name ?? t?.type]
  ))
}

// Codex sends the whole conversation on every request, so the turn so far is
// read off the input rather than counted in a variable. A request codex retries
// therefore cannot double-count.
function callsSoFar(input) {
  const outputs = new Map()
  for (const item of input ?? []) {
    if (item?.type === 'function_call_output') outputs.set(item.call_id, item.output)
  }
  const calls = []
  for (const item of input ?? []) {
    if (item?.type !== 'function_call') continue
    const raw = outputs.get(item.call_id)
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
    calls.push({ name: item.name, output: text, ok: typeof text === 'string' && text.includes(OK_MARK) })
  }
  return calls
}

function serveModel(dir, which, state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MODEL_PORT}`)
    if (req.method !== 'POST' || !url.pathname.endsWith('/responses')) { res.writeHead(404).end('{}'); return }
    const body = await readBody(req)
    const calls = callsSoFar(body.input)
    state.turns += 1
    // The verbatim thing the model is told about the call the daemon died under
    // is the whole reading of the drop case, so every output is journalled.
    log(dir, {
      ev: 'model_request',
      turn: state.turns,
      calls: calls.map((c) => ({ name: c.name, ok: c.ok, output: c.output })),
    })
    if (state.turns === 1) {
      log(dir, { ev: 'tools_offered', names: toolNames(body.tools) })
    }

    const step = nextStep(which, calls)
    if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs))
    // The names the MCP tools carry on the wire are the CLI's business, not this
    // file's, so they are looked up rather than spelled.
    const named = (suffix) => toolNames(body.tools).find((n) => typeof n === 'string' && n.endsWith(`__${suffix}`))

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
    const response = { id: `resp_${state.turns}`, object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    send('response.created', { response: { ...response, status: 'in_progress' } })
    if (step.done) {
      const report = calls.map((c, i) => `${i + 1}. ${c.name} -> ${c.output}`).join('\n')
      send('response.output_item.done', {
        output_index: 0,
        item: { type: 'message', id: `msg_${state.turns}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: `${calls.length} call(s):\n${report}` }] },
      })
    } else {
      const name = named(step.tool)
      if (!name) {
        send('response.output_item.done', {
          output_index: 0,
          item: { type: 'message', id: `msg_${state.turns}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: `no MCP tool ending in "${step.tool}" was offered — the curia server did not attach` }] },
        })
      } else {
        // A namespaced call is a `function_call` with the namespace beside the
        // bare tool name, not one flat `mcp__curia__notify` name: the CLI's
        // router answers that with "unsupported call" (observed).
        const [ns, tool] = [name.slice(0, name.lastIndexOf('__')), name.slice(name.lastIndexOf('__') + 2)]
        send('response.output_item.done', {
          output_index: 0,
          item: { type: 'function_call', id: `fc_${state.turns}`, call_id: `call_${state.turns}`, name: tool, namespace: ns, arguments: JSON.stringify(step.args), status: 'completed' },
        })
      }
    }
    send('response.completed', { response })
    res.end()
  })
  server.listen(MODEL_PORT, '127.0.0.1', () => log(dir, { ev: 'model_listening', port: MODEL_PORT }))
  return server
}

// ---- the agent's side ------------------------------------------------------

// What `daemon/src/workspace.mjs` writes for a codex agent, with this probe's
// two URLs in it. Everything the codex harness needs is in the config dir, so
// nothing is written into the worktree at all.
function seed(dir) {
  const ws = path.join(dir, 'ws')
  const cfg = path.join(dir, 'cfg')
  fs.mkdirSync(ws, { recursive: true })
  fs.mkdirSync(cfg, { recursive: true })
  fs.writeFileSync(path.join(cfg, 'config.toml'), [
    '# Written by the probe, in the shape daemon/src/workspace.mjs writes.',
    '',
    'model = "stand-in"',
    'model_provider = "standin"',
    '',
    '[model_providers.standin]',
    'name = "stand-in"',
    `base_url = "http://127.0.0.1:${MODEL_PORT}/v1"`,
    'wire_api = "responses"',
    '',
    `[projects."${ws}"]`,
    'trust_level = "trusted"',
    '',
    '[mcp_servers.curia]',
    `url = "http://127.0.0.1:${PORT}/mcp?agent=${AGENT}&ticket=371"`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_S}`,
    `http_headers = { "${TOKEN_HEADER}" = "${TOKEN}" }`,
    '',
  ].join('\n'), { mode: 0o600 })
  return { ws, cfg }
}

// The claude probe put its steps here, because a model read them. This one puts
// them in `nextStep`, so the prompt is only what codex needs to start a turn.
const PROMPT = 'Follow the steps you are given and do not stop early.'

const CASES = {
  drop: { dieUnder: 'ask_human', dieAfterMs: 3000, downMs: 5000 },
  refused: { dieUnder: 'notify', dieAfterMs: 1000, downMs: 20_000 },
}

async function main() {
  const which = process.argv[2]
  const kase = CASES[which]
  if (!kase) {
    console.error(`usage: node ${path.basename(SELF)} <${Object.keys(CASES).join('|')}> [scratch-dir]`)
    process.exit(2)
  }
  const dir = process.argv[3] || path.join(os.tmpdir(), `curia-channel-probe-codex-${which}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const { ws, cfg } = seed(dir)
  const state = { turns: 0 }
  const model = serveModel(dir, which, state)

  // The supervisor the box has: `restart: on-failure`, one respawn after the
  // outage this case asks for.
  let stop = false
  let daemon = null
  const supervise = async () => {
    while (!stop) {
      await new Promise((done) => {
        daemon = spawn(process.execPath, [SELF], {
          env: {
            ...process.env,
            PROBE_ROLE: 'server', PROBE_DIR: dir,
            PROBE_DIE_UNDER: kase.dieUnder, PROBE_DIE_AFTER_MS: String(kase.dieAfterMs),
          },
          stdio: 'inherit',
        })
        daemon.on('exit', done)
      })
      if (stop) return
      console.log(`[${new Date().toISOString()}] daemon down for ${kase.downMs / 1000}s`)
      await new Promise((r) => setTimeout(r, kase.downMs))
    }
  }
  supervise()
  await new Promise((r) => setTimeout(r, 2000))

  const started = Date.now()
  const agent = spawn('codex', [
    'exec', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
    '--color', 'never', PROMPT,
  ], {
    cwd: ws,
    // stdin is closed rather than inherited: `codex exec` reads a piped stdin as
    // more of the prompt, and an inherited terminal never closes it at all.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: process.env.HOME, PATH: process.env.PATH, TERM: 'xterm',
      CODEX_HOME: cfg,
    },
  })
  let out = ''
  agent.stdout.on('data', (b) => { out += b })
  agent.stderr.on('data', (b) => { out += b })
  // Codex bounds one tool call at a DAY, so a client that never notices the drop
  // would hold this process for that long. The cap turns that into a reading.
  let capped = false
  const cap = setTimeout(() => {
    capped = true
    log(dir, { ev: 'capped', after_s: CAP_MS / 1000 })
    agent.kill('SIGKILL')
  }, CAP_MS)
  await new Promise((done) => agent.on('exit', done))
  clearTimeout(cap)
  // The stand-in outlives this process otherwise, and the next run of the probe
  // then meets its own port held by the last one.
  stop = true
  daemon?.kill()
  model.close()

  console.log(`\n=== ${which}: the timeline ===`)
  const journal = path.join(dir, 'log.jsonl')
  if (!fs.existsSync(journal)) {
    console.log(`no requests reached the stand-in. Check that ports ${PORT} and ${MODEL_PORT} were free.`)
  }
  const entries = (fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').trim().split('\n') : []).filter(Boolean).map((l) => JSON.parse(l))
  for (const e of entries) {
    const tail = e.ev === 'model_request' ? ` turn ${e.turn}` : ''
    console.log(`${e.ts}  pid ${e.pid}  ${e.ev}${e.rpc ? ` ${e.rpc}` : ''}${e.tool ? ` ${e.tool}` : ''}${tail}`)
  }

  const death = entries.find((e) => e.ev === 'daemon_dies')
  const heard = entries.find((e) => e.ev === 'model_request' && e.calls?.some((c) => c.output && !c.ok))
  if (death && heard) {
    console.log(`\nthe agent was told ${((Date.parse(heard.ts) - Date.parse(death.ts)) / 1000).toFixed(1)}s after the death:`)
    for (const c of heard.calls.filter((c) => c.output && !c.ok)) console.log(`  ${c.name}: ${c.output}`)
  } else if (death && capped) {
    console.log(`\nthe agent was NEVER told: still waiting ${CAP_MS / 1000}s after the death, when the cap ended the run.`)
  }

  console.log(`\n=== ${which}: what the agent reported (${Math.round((Date.now() - started) / 1000)}s) ===`)
  console.log(out.trim())
  process.exit(0)
}

// One file, two roles: the supervisor respawns this same script as the daemon.
if (process.env.PROBE_ROLE === 'server') {
  serve(process.env.PROBE_DIR, process.env.PROBE_DIE_UNDER, Number(process.env.PROBE_DIE_AFTER_MS))
} else {
  await main()
}

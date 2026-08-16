// Does a keystroke reach a codex agent that is blocked inside a tool call (#457)?
//
// [tool-channel-mid-session-codex.probe.mjs](tool-channel-mid-session-codex.probe.mjs)
// measured what the TOOL CHANNEL does when the daemon dies under a call, and it
// stated what it could not measure: "a headless agent has no composer and no
// keystroke channel, so the note interrupt was not exercised". This file is that
// missing half. It runs the codex TUI in a tmux pane, the way a dispatch does,
// and it writes into that pane through the daemon's own write path.
//
// Nothing here is a mock of curia's own code. Three real parts:
//
//   the codex CLI       the real binary, spawned from the template in
//                       `config/routing.yaml`, in a tmux pane.
//   the write path      `sendKey` and `sendText`, imported from
//                       `daemon/src/tmux.mjs`. Same pacing, same `-l`, same
//                       separate Enter. The thing under test is that function.
//   the config          the shape `daemon/src/workspace.mjs` writes for a codex
//                       agent, with `tool_timeout_sec` at the daemon's own day.
//
// Two parts are stand-ins, for the reason #371 already gave. The MODEL is a
// script on the Responses wire API, because an agent container carries no codex
// credential. The DAEMON is the #371 stand-in: a stateless
// `StreamableHTTPServerTransport` on `POST /mcp?agent=&ticket=`, with the
// `x-curia-agent-token` header, exactly as `daemon/src/index.mjs` serves it.
//
// Three cases:
//   dead    the stand-in daemon is SIGKILLed while it holds `ask_human`, and a
//           new process is listening 5 s later. Then Escape, then the words.
//           This is the boot sweep the ticket asks about.
//   alive   the daemon is NOT killed. It holds a real `ask_human` and answers it
//           25 s in. Escape lands first. This is the case `interruptNote`
//           refuses today, and the run says what the refusal is worth.
//   quiet   the `dead` case with NO Escape — the words alone. It says whether
//           the Escape is load-bearing or whether the composer would have done.
//
// Run:  node docs/research/pane-keystroke-codex.probe.mjs <dead|alive|quiet> [scratch-dir]
// Needs the `codex` binary, `tmux`, and `npm ci` in `daemon/`. No credential of
// any kind, which is what lets it run in an ordinary agent container.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const REPO = path.resolve(SELF, '../../..')

// The MCP SDK is the daemon's dependency and this file lives outside its
// package, so it is resolved from `daemon/package.json` rather than imported by
// name. Run `npm ci` in `daemon/` first.
const dep = createRequire(path.join(REPO, 'daemon/package.json'))
const load = async (spec) => import(pathToFileURL(dep.resolve(spec)).href)
const { McpServer } = await load('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = await load('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = await load('zod')

const PORT = Number(process.env.PROBE_PORT ?? 9010)
const MODEL_PORT = Number(process.env.PROBE_MODEL_PORT ?? 9011)
const TOKEN = 'probe-token'
const TOKEN_HEADER = 'x-curia-agent-token'
const AGENT = 'curia-457'
const TICKET = '457'
// The value `daemon/src/workspace.mjs` writes as CODEX_TOOL_TIMEOUT_S. A day.
const TOOL_TIMEOUT_S = Number(process.env.PROBE_TOOL_TIMEOUT_S ?? 86_400)
// `INTERRUPT_GRACE_MS`, dispatch.mjs:177 — the pause #injectNote takes before
// the Escape, so a call that was about to finish gets to.
const GRACE_MS = Number(process.env.PROBE_GRACE_MS ?? 5_000)
// How long the run watches after the words go in, before it calls the pane cold.
const WATCH_MS = Number(process.env.PROBE_WATCH_S ?? 120) * 1000

// The one string that proves delivery. No model and no CLI emits it, so finding
// it in a request body can only mean the keystrokes reached the composer and the
// composer started a turn. Read off the wire, never from a model's own report —
// the discipline prototypes/codex-stop-hook/README.md states.
const SENTINEL = 'CURIA-PANE-SENTINEL'

// ---- the stand-in daemon ---------------------------------------------------

function log(dir, entry) {
  fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`)
}

function buildMcpServer(dir, answerMs) {
  const s = new McpServer({ name: 'curia', version: '0.0.1' })
  s.tool('notify', 'Fire-and-forget status line.', { message: z.string() }, async ({ message }) => {
    log(dir, { ev: 'tool', tool: 'notify', message })
    return { content: [{ type: 'text', text: `noted: ${message}` }] }
  })
  s.tool('ask_human', 'Blocking question to a human.', { prompt: z.string() }, async ({ prompt }) => {
    log(dir, { ev: 'tool', tool: 'ask_human', prompt })
    // Blocks the way the real one does. `answerMs` is the human taking that
    // long; null is the human who never gets the chance, because the process is
    // about to be killed under them.
    await new Promise((r) => setTimeout(r, answerMs ?? 600_000))
    log(dir, { ev: 'ask_human_answers' })
    return { content: [{ type: 'text', text: 'the human said: go ahead' }] }
  })
  return s
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { return {} }
}

function serve(dir, answerMs) {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (url.pathname !== '/mcp') { res.writeHead(404).end('{}'); return }
    const body = await readBody(req)
    const rpc = body?.method ?? null
    const tool = body?.params?.name ?? null
    log(dir, { ev: 'request', method: req.method, rpc, id: body?.id ?? null, tool, token_ok: req.headers[TOKEN_HEADER] === TOKEN })
    if (req.method !== 'POST') { res.writeHead(405).end('{}'); return }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    // Whether the CLIENT is still there when the answer is ready is the whole
    // reading of the `alive` case, so the socket's death is journalled.
    res.on('close', () => {
      log(dir, { ev: 'response_closed', rpc, tool, written: res.writableFinished })
      transport.close()
    })
    const mcp = buildMcpServer(dir, answerMs)
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }).listen(PORT, '127.0.0.1', () => log(dir, { ev: 'listening', port: PORT }))
}

// ---- the stand-in model ----------------------------------------------------

// Codex speaks the Responses wire API and no other. This serves
// `POST /v1/responses` and streams the three events codex needs to accept a
// turn — created, one output item, completed. It replaces the model's
// JUDGEMENT, not the harness: every step is a scripted function call, so the
// reading is never a report of a model's patience.
const THINK_MS = Number(process.env.PROBE_THINK_MS ?? 400)

// The curia tools are the only ones this script counts. On 0.146 the TUI DEFERS
// an MCP server behind `tool_search` — the first request offers a `tool_search`
// tool whose own description names `curia` as a source, and nothing else — so a
// real model has to search before it can call anything of curia's. The script
// does the same, and that search must not shift the step counter below.
const CURIA_TOOLS = ['notify', 'ask_human']
// The namespace codex gives an MCP server, `mcp__<server>__<tool>` (#371).
const MCP_NAMESPACE = 'mcp__curia'
const isCuriaCall = (c) => CURIA_TOOLS.includes(String(c.name).replace(/^.*__/, ''))

function nextStep(calls) {
  // 1. notify one   2. ask_human (the call the Escape lands in)
  // 3. notify two   4. notify three, then say what happened.
  const n = calls.length
  if (n === 0) return { tool: 'notify', args: { message: 'one' } }
  if (n === 1) return { tool: 'ask_human', args: { prompt: 'blocking' } }
  if (n === 2) return { tool: 'notify', args: { message: 'two' } }
  if (n === 3) return { tool: 'notify', args: { message: 'three' } }
  return { done: true }
}

const OK_MARK = 'noted:'

// The pinned codex (0.146) does not offer an MCP tool as a function of its own.
// It offers the SERVER as one tool of type `namespace`, with the server's tools
// nested inside it. So the names are read off the offer rather than spelled
// here, and a codex that changes this shape breaks loudly at the lookup.
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
    const text = raw === undefined ? null : (typeof raw === 'string' ? raw : JSON.stringify(raw))
    calls.push({ name: item.name, call_id: item.call_id, output: text, ok: typeof text === 'string' && text.includes(OK_MARK) })
  }
  return calls
}

// Every user-role message in the conversation. The prompt is the first; anything
// after it arrived through the composer, which is the delivery under test.
function userTurns(input) {
  const out = []
  for (const item of input ?? []) {
    if (item?.type !== 'message' || item?.role !== 'user') continue
    const text = (item.content ?? []).map((c) => c?.text ?? '').join(' ')
    out.push(text)
  }
  return out
}

function serveModel(dir, state) {
  const reqDir = path.join(dir, 'requests')
  fs.mkdirSync(reqDir, { recursive: true })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MODEL_PORT}`)
    if (req.method !== 'POST' || !url.pathname.endsWith('/responses')) { res.writeHead(404).end('{}'); return }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString()
    state.turns += 1
    fs.writeFileSync(path.join(reqDir, `req-${state.turns}.json`), raw)
    let body = {}
    try { body = JSON.parse(raw) } catch { /* logged as an unreadable turn below */ }
    const everyCall = callsSoFar(body.input)
    const calls = everyCall.filter(isCuriaCall)
    const users = userTurns(body.input)
    // The verbatim thing the model is told about the call the Escape landed in
    // is the whole reading, so every output and every user turn is journalled.
    log(dir, {
      ev: 'model_request',
      turn: state.turns,
      calls: calls.map((c) => ({ name: c.name, ok: c.ok, output: c.output })),
      user_turns: users,
      sentinel: raw.includes(SENTINEL),
    })
    if (state.turns === 1) log(dir, { ev: 'tools_offered', names: toolNames(body.tools) })

    const step = nextStep(calls)
    await new Promise((r) => setTimeout(r, THINK_MS))
    const offered = toolNames(body.tools)
    const named = (suffix) => offered.find((n) => typeof n === 'string' && n.endsWith(`__${suffix}`))

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
    const response = { id: `resp_${state.turns}`, object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    send('response.created', { response: { ...response, status: 'in_progress' } })
    const message = (text) => send('response.output_item.done', {
      output_index: 0,
      item: { type: 'message', id: `msg_${state.turns}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] },
    })
    const call = (name, namespace, args) => send('response.output_item.done', {
      output_index: 0,
      item: {
        type: 'function_call', id: `fc_${state.turns}`, call_id: `call_${state.turns}`,
        name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args), status: 'completed',
      },
    })
    if (step.done) {
      message(`${calls.length} call(s):\n${calls.map((c, i) => `${i + 1}. ${c.name} -> ${c.output}`).join('\n')}`)
    } else {
      // The TUI lane DEFERS every MCP tool behind `tool_search` (see the
      // reading's "what else the probe saw"), so the curia names are usually
      // absent from the offer. The CLI's router resolves them anyway, so the
      // script names one directly rather than scripting a search whose result
      // it would only throw away.
      //
      // A namespaced call is a `function_call` with the namespace beside the
      // bare tool name, not one flat `mcp__curia__notify` name: the CLI's
      // router answers that with "unsupported call" (#371's finding).
      const name = named(step.tool) ?? `${MCP_NAMESPACE}__${step.tool}`
      const cut = name.lastIndexOf('__')
      call(name.slice(cut + 2), name.slice(0, cut), step.args)
    }
    send('response.completed', { response })
    res.end()
  })
  server.listen(MODEL_PORT, '127.0.0.1', () => log(dir, { ev: 'model_listening', port: MODEL_PORT }))
  return server
}

// ---- the agent's side ------------------------------------------------------

const toml = (s) => JSON.stringify(String(s))

// What `daemon/src/workspace.mjs` writes for a codex agent, trimmed to the keys
// this question needs, with this probe's two URLs in it.
function seed(dir) {
  const ws = path.join(dir, 'ws')
  const cfg = path.join(dir, 'cfg')
  fs.mkdirSync(ws, { recursive: true })
  fs.mkdirSync(cfg, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: ws })
  fs.writeFileSync(path.join(ws, 'README.md'), '# throwaway\n')
  fs.writeFileSync(path.join(cfg, 'config.toml'), [
    '# Written by the probe, in the shape daemon/src/workspace.mjs writes.',
    '',
    'model_provider = "standin"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    // The `[features]` and `[skills]` tables verbatim from
    // `daemon/src/workspace.mjs`. They are not decoration here: on 0.146 the
    // default-on `multi_agent` puts a second deferred tool source beside curia,
    // and codex then hides BOTH behind `tool_search` instead of offering the
    // curia namespace upfront (observed on the first run of this probe).
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
    '[model_providers.standin]',
    'name = "stand-in"',
    `base_url = "http://127.0.0.1:${MODEL_PORT}/v1"`,
    'wire_api = "responses"',
    '',
    `[projects.${toml(ws)}]`,
    'trust_level = "trusted"',
    '',
    '[mcp_servers.curia]',
    `url = ${toml(`http://127.0.0.1:${PORT}/mcp?agent=${AGENT}&ticket=${TICKET}`)}`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_S}`,
    `http_headers = { ${toml(TOKEN_HEADER)} = ${toml(TOKEN)} }`,
    '',
  ].join('\n'), { mode: 0o600 })
  return { ws, cfg }
}

const PROMPT = 'Follow the steps you are given and do not stop early.'

// The words `#injectNote` builds, with the sentinel standing in for the
// operator's own. One line, because a composer reads a newline as a submit.
const NOTE_TEXT = `[the operator, interrupting from the thread] ${SENTINEL} the daemon died holding your question, so nobody ever saw it`
  + ' — answer this now with the `notify` tool: your terminal output does not reach them. Then carry on.'

const CASES = {
  dead: { kill: true, downMs: 5_000, escape: true, answerMs: null },
  alive: { kill: false, downMs: 0, escape: true, answerMs: 15_000 },
  quiet: { kill: true, downMs: 5_000, escape: false, answerMs: null },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function entriesOf(dir) {
  const journal = path.join(dir, 'log.jsonl')
  if (!fs.existsSync(journal)) return []
  return fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return { ev: 'unreadable', line: l } }
  })
}

async function waitFor(dir, match, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const hit = entriesOf(dir).find(match)
    if (hit) return hit
    await sleep(250)
  }
  return null
}

async function main() {
  const which = process.argv[2]
  const kase = CASES[which]
  if (!kase) {
    console.error(`usage: node ${path.basename(SELF)} <${Object.keys(CASES).join('|')}> [scratch-dir]`)
    process.exit(2)
  }
  // The daemon's own write path, and the daemon's own pane. Imported rather than
  // copied: what this probe measures is that module, so a copy would measure
  // nothing.
  const tmux = await import(pathToFileURL(path.join(REPO, 'daemon/src/tmux.mjs')).href)

  const dir = process.argv[3] || path.join(os.tmpdir(), `curia-pane-probe-${which}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const { ws, cfg } = seed(dir)
  const state = { turns: 0 }
  const model = serveModel(dir, state)

  // The supervisor the box has: `restart: on-failure`, one respawn after the
  // outage this case asks for.
  let stop = false
  let daemon = null
  const supervise = async () => {
    while (!stop) {
      await new Promise((done) => {
        daemon = spawn(process.execPath, [SELF], {
          env: { ...process.env, PROBE_ROLE: 'server', PROBE_DIR: dir, PROBE_ANSWER_MS: String(kase.answerMs ?? '') },
          stdio: 'inherit',
        })
        daemon.on('exit', done)
      })
      if (stop) return
      log(dir, { ev: 'daemon_down', for_ms: kase.downMs })
      await sleep(kase.downMs)
    }
  }
  supervise()
  await sleep(1500)

  const session = `paneprobe-${which}`
  await tmux.killSession(session).catch(() => {})
  const promptFile = path.join(dir, 'prompt.md')
  fs.writeFileSync(promptFile, PROMPT)
  // The template in config/routing.yaml, verbatim but for the model name the
  // stand-in provider ignores.
  const shellCmd = `codex --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust "$(cat ${JSON.stringify(promptFile)})"`
  fs.writeFileSync(path.join(dir, 'spawn.txt'), `${shellCmd}\n`)
  await tmux.newSession({
    name: session,
    cwd: ws,
    env: { HOME: dir, PATH: process.env.PATH, CODEX_HOME: cfg, TERM: 'xterm-256color' },
    shellCmd,
  })
  // 80x24 is unreadable for a TUI transcript, and the pane size reaches no part
  // of the write path. Best effort: an old tmux refuses this with no client.
  spawnSync('tmux', [...(tmux.TMUX_SOCKET ? ['-S', tmux.TMUX_SOCKET] : []), 'resize-window', '-t', `=${session}:`, '-x', '200', '-y', '50'], { stdio: 'ignore' })

  const capture = async (label) => {
    const text = await tmux.capturePane(session).catch((e) => `<capture failed: ${e.message}>`)
    fs.writeFileSync(path.join(dir, `pane-${label}.txt`), text)
    return text
  }

  const timeline = {}
  const mark = (k) => { timeline[k] = new Date().toISOString() }

  // 1. the agent reaches the blocking call.
  const blocked = await waitFor(dir, (e) => e.ev === 'tool' && e.tool === 'ask_human', 120_000)
  if (!blocked) {
    await capture('nostart')
    console.error('the agent never reached ask_human — read pane-nostart.txt')
    stop = true; daemon?.kill('SIGKILL'); model.close()
    process.exit(1)
  }
  timeline.blocked = blocked.ts
  await capture('blocked')

  // 2. the death this case asks for. SIGKILL, which is the one death #426 left
  //    to the pane: the daemon never gets to speak.
  if (kase.kill) {
    log(dir, { ev: 'daemon_sigkill' })
    mark('killed')
    daemon?.kill('SIGKILL')
    await waitFor(dir, (e) => e.ev === 'listening' && Date.parse(e.ts) > Date.parse(timeline.killed), 60_000)
    mark('daemon_back')
  }

  // 3. the grace, then the keystrokes — `#injectNote`, dispatch.mjs.
  await sleep(GRACE_MS)
  if (kase.escape) {
    mark('escape_sent_at')
    await tmux.sendKey(session, 'Escape')
    mark('escape_done')
    await capture('after-escape')
  }
  mark('text_sent_at')
  await tmux.sendText(session, NOTE_TEXT)
  mark('text_done')

  // 4. what the words did. The turn is the model request carrying the sentinel.
  const turn = await waitFor(dir, (e) => e.ev === 'model_request' && e.sentinel, WATCH_MS)
  if (turn) timeline.turn_started = turn.ts
  // And whether the agent then carries on: `notify two` is the next step after
  // the aborted call, and it only ever arrives through a live turn.
  const carried = await waitFor(dir, (e) => e.ev === 'tool' && e.tool === 'notify' && e.message === 'two', turn ? 60_000 : 5_000)
  if (carried) timeline.carried_on = carried.ts

  // The `alive` case's own reading: the human answers AFTER the Escape, and the
  // run has to still be here when they do.
  if (kase.answerMs) {
    const answered = await waitFor(dir, (e) => e.ev === 'ask_human_answers', kase.answerMs + 30_000)
    if (answered) timeline.human_answered = answered.ts
    await sleep(5_000)
  }

  await sleep(3_000)
  const pane = await capture('final')
  stop = true
  daemon?.kill('SIGKILL')
  model.close()
  await tmux.killSession(session).catch(() => {})

  // ---- the reading ---------------------------------------------------------

  const entries = entriesOf(dir)
  const at = (k) => (timeline[k] ? Date.parse(timeline[k]) : null)
  const gap = (a, b) => (at(a) && at(b) ? Number(((at(b) - at(a)) / 1000).toFixed(3)) : null)
  const modelRequests = entries.filter((e) => e.ev === 'model_request')
  // The LAST view the model had of that call. On the `alive` case this is what
  // says whether the human's answer ever reached it.
  const askOutput = modelRequests.at(-1)?.calls?.find((c) => c.name === 'ask_human')?.output ?? null

  const summary = {
    case: which,
    codex_version: spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
    tool_timeout_s: TOOL_TIMEOUT_S,
    grace_ms: GRACE_MS,
    timeline,
    seconds: {
      block_to_escape: gap('blocked', 'escape_sent_at'),
      escape_write: gap('escape_sent_at', 'escape_done'),
      escape_to_text: gap('escape_sent_at', 'text_sent_at'),
      text_write: gap('text_sent_at', 'text_done'),
      text_to_turn: gap('text_sent_at', 'turn_started'),
      block_to_turn: gap('blocked', 'turn_started'),
      turn_to_carry_on: gap('turn_started', 'carried_on'),
    },
    // 1. did Escape end the call, and what did the model see?
    ask_human_output_to_model: askOutput,
    // 2. did the words start a turn? Read off the wire.
    sentinel_in_request: entries.filter((e) => e.ev === 'model_request' && e.sentinel).map((e) => e.turn),
    user_turns_seen: entries.filter((e) => e.ev === 'model_request').at(-1)?.user_turns ?? [],
    // 4. did the agent carry on with its ticket?
    turns_seen: state.turns,
    tools_after_the_words: entries.filter((e) => e.ev === 'tool' && Date.parse(e.ts) > (at('text_sent_at') ?? 0)).map((e) => e.tool),
    // 5. the alive case: what the daemon saw, and what the agent got.
    ask_human_answered_by_the_stand_in: entries.some((e) => e.ev === 'ask_human_answers'),
    // The daemon's own view of the abort. No entry at all means the CLIENT
    // never closed the request: the daemon is still holding a call nobody reads.
    ask_human_request_closed: entries.some((e) => e.ev === 'response_closed' && e.tool === 'ask_human'),
    model_requests_after_the_answer: timeline.human_answered
      ? modelRequests.filter((e) => Date.parse(e.ts) > Date.parse(timeline.human_answered)).map((e) => e.turn)
      : null,
    answer_text_ever_reached_the_model: modelRequests.some((e) => JSON.stringify(e.calls ?? []).includes('go ahead')),
    pane_tail: pane.trim().split('\n').slice(-25).join('\n'),
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  console.log(`\n=== ${which}: the timeline ===`)
  for (const e of entries) {
    const tail = e.ev === 'model_request' ? ` turn ${e.turn}${e.sentinel ? ' SENTINEL' : ''}` : ''
    console.log(`${e.ts}  pid ${e.pid}  ${e.ev}${e.rpc ? ` ${e.rpc}` : ''}${e.tool ? ` ${e.tool}` : ''}${tail}`)
  }
  console.log(`\n=== ${which}: the reading ===`)
  console.log(JSON.stringify({ ...summary, pane_tail: undefined }, null, 2))
  console.log(`\n=== ${which}: the pane ===\n${summary.pane_tail}`)
  console.log(`\nartifacts in ${dir}`)
  process.exit(0)
}

// One file, two roles: the supervisor respawns this same script as the daemon.
if (process.env.PROBE_ROLE === 'server') {
  serve(process.env.PROBE_DIR, process.env.PROBE_ANSWER_MS ? Number(process.env.PROBE_ANSWER_MS) : null)
} else {
  await main()
}

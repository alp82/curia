// Curia daemon (#31): durable escalation record + Discord bridge module,
// plus the worker-facing MCP surface proven in spike #29.
//
//   POST /mcp?worker=<name>&ticket=<n>  — streamable-HTTP MCP (ask_human / notify / report_result)
//   GET  /state                          — open escalations
//   POST /escalate                       — synthetic escalation (testing / non-MCP emitters)
//   POST /answer {id, answer}            — REST answer (same first-valid-wins gate as Discord)
//   POST /worker_done?worker=            — Stop-hook webhook
//
// State posture (#9): the events journal is the only durable artifact; the
// pending-resolver map and ticket→thread cache are ephemeral. A daemon restart
// keeps every open escalation renderable and answerable; only the in-process
// worker call is lost (accepted re-dispatch posture, #11/#12).

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { EscalationStore } from './store.mjs'
import { DiscordBridge } from './bridge.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(DIR, '..')

// minimal .env loader (daemon/.env, never committed)
const envFile = path.join(ROOT, '.env')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

const PORT = Number(process.env.PORT ?? 4271)
const NUDGE_MS = Number(process.env.NUDGE_MS ?? 30 * 60 * 1000) // ~30-min re-nudge (#11)
const DATA = path.join(ROOT, 'data')
fs.mkdirSync(path.join(DATA, 'results'), { recursive: true })

const store = new EscalationStore(DATA)
const pending = new Map() // escalation id -> resolve(answerText) — ephemeral, dies with the process
const nudgeTimers = new Map() // escalation id -> interval handle — ephemeral, rebuilt on boot

let bridge = null

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

// ---- escalation lifecycle -------------------------------------------------

function scheduleNudge(record) {
  if (nudgeTimers.has(record.id)) return
  const t = setInterval(() => {
    const r = store.get(record.id)
    if (!r || r.status !== 'open') return clearNudge(record.id)
    store.nudge(r.id)
    if (bridge) {
      // a record that never rendered (bridge was down, #22) gets re-rendered here
      const action = r.discord ? bridge.nudge(r) : renderEscalation(r)
      action.catch((e) => log('nudge/render failed', e.message))
    }
  }, NUDGE_MS)
  t.unref()
  nudgeTimers.set(record.id, t)
}

function clearNudge(id) {
  const t = nudgeTimers.get(id)
  if (t) clearInterval(t)
  nudgeTimers.delete(id)
}

async function renderEscalation(record, files = []) {
  if (!bridge) return
  try {
    const discord = await bridge.renderEscalation(record, { files })
    store.attachRender(record.id, discord)
  } catch (e) {
    // record stays open + REST-answerable; next nudge tick retries the render
    store.logEvent('bridge_render_failed', { id: record.id, error: e.message })
    log(`render failed for ${record.id}: ${e.message}`)
  }
}

// Open + render + block until answered. Every ask_human and synthetic escalation
// funnels through here.
function openEscalation({ worker, ticket, kind, prompt, options, preview_url, files }) {
  const { record, superseded } = store.open({ worker, ticket, kind, prompt, options, preview_url })
  log(`escalation ${record.id} open (${kind}) worker=${worker} ticket=${ticket}${superseded ? ` supersedes ${superseded.id}` : ''}`)
  if (superseded) {
    pending.delete(superseded.id) // the worker aborted that call; nobody is waiting on it
    clearNudge(superseded.id)
    if (bridge) bridge.markSuperseded(store.get(superseded.id)).catch(() => {})
  }
  scheduleNudge(record)
  renderEscalation(record, files)
  const answered = new Promise((resolve) => pending.set(record.id, resolve))
  return { record, answered }
}

function settle(record, text) {
  clearNudge(record.id)
  const resolve = pending.get(record.id)
  pending.delete(record.id)
  if (resolve) resolve(text)
}

// handlers the bridge (and REST) call into — the single first-valid-wins gate
const gate = {
  get: (id) => store.get(id),
  findOpenForThread: (threadId) =>
    store.openEscalations()
      .filter((r) => r.discord?.threadId === threadId)
      .filter((r) => ['free-text', 'choice', 'preview-review'].includes(r.kind))
      .at(-1) ?? null,
  answer(id, { answer, by, via }) {
    const result = store.answer(id, { answer, by, via })
    if (result.ok) {
      log(`escalation ${result.record.id} answered via ${via}${result.routed_from?.length ? ` (routed from ${result.routed_from.join('→')})` : ''}`)
      settle(result.record, answer)
      if (bridge) bridge.markAnswered(result.record).catch(() => {})
    }
    return result
  },
  cancel(id, { by }) {
    const result = store.cancel(id, { by })
    if (result.ok) {
      log(`escalation ${result.record.id} cancelled`)
      settle(result.record, `aborted: a human cancelled this escalation — stop this line of work and end the turn; the ticket will be re-dispatched`)
      if (bridge) bridge.markCancelled(result.record).catch(() => {})
    }
    return result
  },
  async command(canonical, userId) {
    // #18: the bridge only macro-expands; interpretation belongs to the overseer
    // session, which isn't built yet. Log the canonical text so the seam is proven.
    store.logEvent('command', { canonical, by: userId })
    log(`command relayed: "${canonical}"`)
    return `📨 relayed to overseer: \`${canonical}\`\n_(overseer session not wired yet — logged to the journal)_`
  },
}

// ---- worker-facing MCP surface (#29 shape) ---------------------------------

function buildMcpServer(worker, ticket) {
  const server = new McpServer({ name: 'curia-daemon', version: '0.1.0' })

  server.tool(
    'notify',
    'Fire-and-forget status update to the human. Returns immediately.',
    { message: z.string() },
    async ({ message }) => {
      store.logEvent('notify', { worker, ticket, message })
      if (bridge) bridge.notify(ticket, `📣 \`${worker}\`: ${message}`).catch(() => {})
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  )

  server.tool(
    'ask_human',
    'Escalate a question to the human and BLOCK until an answer arrives. kind: free-text | choice | approve-reject | preview-review.',
    {
      prompt: z.string(),
      kind: z.enum(['free-text', 'choice', 'approve-reject', 'preview-review']),
      options: z.array(z.string()).optional(),
      preview_url: z.string().optional(),
    },
    async (payload) => {
      const { answered } = openEscalation({ worker, ticket, ...payload })
      const answer = await answered
      return { content: [{ type: 'text', text: answer }] }
    },
  )

  server.tool(
    'report_result',
    'Deliver the structured resolution for the ticket. Call exactly once, when the work is done.',
    {
      ticket: z.string(),
      status: z.enum(['resolved', 'blocked', 'aborted']),
      summary: z.string(),
      details: z.record(z.string(), z.any()).optional(),
    },
    async (result) => {
      const rec = store.logEvent('result', { worker, ...result })
      fs.writeFileSync(path.join(DATA, 'results', `${worker}.json`), JSON.stringify(rec, null, 2))
      if (bridge) bridge.notify(result.ticket, `🏁 \`${worker}\` reports **${result.status}**: ${result.summary}`).catch(() => {})
      return { content: [{ type: 'text', text: 'result recorded' }] }
    },
  )

  return server
}

// ---- HTTP ------------------------------------------------------------------

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : {} } catch { return { raw } }
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj, null, 2))
  }

  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') return json(405, { error: 'stateless server: POST only' })
    const worker = url.searchParams.get('worker') ?? 'unknown'
    const ticket = url.searchParams.get('ticket') ?? 'unknown'
    const body = await readBody(req)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close() })
    const mcp = buildMcpServer(worker, ticket)
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
    return
  }

  if (url.pathname === '/state' && req.method === 'GET') {
    return json(200, {
      bridge: bridge ? 'up' : 'down',
      open_escalations: store.openEscalations(),
    })
  }

  if (url.pathname === '/escalate' && req.method === 'POST') {
    const body = await readBody(req)
    const { record, answered } = openEscalation({
      worker: body.worker ?? 'synthetic', ticket: body.ticket ?? 'unknown',
      kind: body.kind ?? 'approve-reject', prompt: body.prompt ?? '(no prompt)',
      options: body.options, preview_url: body.preview_url, files: body.files,
    })
    if (url.searchParams.get('wait')) {
      const answer = await answered
      return json(200, { id: record.id, answer })
    }
    return json(200, { id: record.id })
  }

  if (url.pathname === '/answer' && req.method === 'POST') {
    const { id, answer } = await readBody(req)
    const result = gate.answer(id, { answer: String(answer), by: 'rest', via: 'rest' })
    return json(result.ok ? 200 : 409, result)
  }

  if (url.pathname === '/cancel' && req.method === 'POST') {
    const { id } = await readBody(req)
    const result = gate.cancel(id, { by: 'rest' })
    return json(result.ok ? 200 : 409, result)
  }

  if (url.pathname === '/worker_done' && req.method === 'POST') {
    const body = await readBody(req)
    const worker = url.searchParams.get('worker') ?? 'unknown'
    store.logEvent('worker_done', {
      worker,
      hook_event: body.hook_event_name,
      session_id: body.session_id,
      stop_hook_active: body.stop_hook_active,
    })
    return json(200, { ok: true })
  }

  json(404, { error: 'not found' })
})

// ---- boot -------------------------------------------------------------------

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`curia daemon listening on http://127.0.0.1:${PORT}`)
})

// restart recovery: every open escalation in the journal gets its nudge timer
// back; records that never rendered retry on the first tick
for (const r of store.openEscalations()) {
  log(`recovered open escalation ${r.id} (${r.kind}) worker=${r.worker} ticket=${r.ticket}`)
  scheduleNudge(r)
}

if (process.env.DISCORD_BOT_TOKEN) {
  const allowed = (process.env.DISCORD_ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!allowed.length) {
    log('DISCORD_ALLOWED_USERS is empty — refusing to start the bridge without an auth gate')
  } else {
    const b = new DiscordBridge({
      token: process.env.DISCORD_BOT_TOKEN,
      allowedUsers: allowed,
      guildId: process.env.CURIA_GUILD_ID,
      channelName: process.env.CURIA_CHANNEL ?? 'curia',
      dataDir: DATA,
      handlers: gate,
      log,
    })
    const startBridge = (attempt = 1) => b.start().then(() => {
      bridge = b
      // re-render any recovered escalation that has no message yet, and confirm
      // recovered ones that do are still answerable (message ids in the record)
      for (const r of store.openEscalations()) {
        if (!r.discord) renderEscalation(r)
      }
    }).catch((e) => {
      const delay = Math.min(60_000, 5_000 * attempt)
      log(`bridge start attempt ${attempt} failed: ${e.message} — retrying in ${delay / 1000}s (escalations remain REST-answerable)`)
      setTimeout(() => startBridge(attempt + 1), delay).unref()
    })
    startBridge()
  }
} else {
  log('no DISCORD_BOT_TOKEN — running without the bridge (REST-only)')
}

// Curia daemon (#31 + #33): durable escalation record + Discord bridge module,
// the worker-facing MCP surface proven in spike #29, and the dispatch loop.
//
//   POST /mcp?worker=<name>&ticket=<n>  — streamable-HTTP MCP (ask_human / notify / report_result)
//   GET  /state                          — open escalations
//   POST /escalate                       — synthetic escalation (testing / non-MCP emitters)
//   POST /answer {id, answer}            — REST answer (same first-valid-wins gate as Discord)
//   POST /worker_done?worker=            — Stop-hook webhook (closes the dispatch lifecycle)
//   POST /command {text}                 — canonical command text (REST parity with the slash verbs)
//   POST /reconcile                      — on-demand reconcile (boot reconcile runs automatically)
//
// State posture (#9): the events journal is the only durable artifact; the
// pending-resolver map, ticket→thread cache and dispatcher workers map are
// ephemeral. A daemon restart keeps every open escalation renderable and
// answerable, and reconcile re-derives live workers from GitHub + tmux.

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { EscalationStore } from './store.mjs'
import { DiscordBridge } from './bridge.mjs'
import { installCrashGuard } from './health.mjs'
import { resolveOutboundImages, inboundContent } from './images.mjs'
import { PreviewRegistry } from './preview.mjs'
import { loadCuriaConfig, loadRoutingConfig } from './config.mjs'
import { Cooling } from './routing.mjs'
import { Dispatcher } from './dispatch.mjs'
import { REVIEW_KIND } from './lifecycle.mjs'
import { CommandRouter } from './commands.mjs'
import { OverseerHost } from './overseer.mjs'
import { hasSession } from './tmux.mjs'
import { ensureTtyd, assertServe, serveOff, attachBase, attachUrl, validSessionName } from './attach.mjs'
import { TimelineSurface } from './timeline.mjs'
import { detectBackend } from './transcript.mjs'

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
// CURIA_DATA_DIR mirrors CURIA_CONFIG_DIR: the boot test points both at a
// fixture dir so a test run never writes into the real journal.
const DATA = process.env.CURIA_DATA_DIR ?? path.join(ROOT, 'data')
fs.mkdirSync(path.join(DATA, 'results'), { recursive: true })

// dispatch-loop config (#33) — hand-edited YAML, validated on load; a bad
// shape refuses the boot rather than limping
const CONFIG_DIR = process.env.CURIA_CONFIG_DIR ?? path.join(ROOT, '..', 'config')
const curiaConfig = loadCuriaConfig(path.join(CONFIG_DIR, 'curia.yaml'))
const routingConfig = loadRoutingConfig(path.join(CONFIG_DIR, 'routing.yaml'))

const store = new EscalationStore(DATA)
const pending = new Map() // escalation id -> resolve(answerText) — ephemeral, dies with the process
const nudgeTimers = new Map() // escalation id -> interval handle — ephemeral, rebuilt on boot

let bridge = null

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

// #56: a transient gateway/socket error must not take dispatch, escalation,
// preview and reconcile down with it. Installed HERE, before the bridge and
// before boot reconcile, because the crash it exists for fires from a timer
// nobody in this file owns. Everything without a network signal still exits —
// the difference from today is one journal line before it does.
installCrashGuard({
  log,
  journal: (type, detail) => store.logEvent(type, detail),
})

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

// Resolves with { text, attachments } — the answer's images travel with it all
// the way to the worker's tool result (#34).
function settle(record, text, attachments = []) {
  clearNudge(record.id)
  const resolve = pending.get(record.id)
  pending.delete(record.id)
  if (resolve) resolve({ text, attachments })
}

// handlers the bridge (and REST) call into — the single first-valid-wins gate
const gate = {
  get: (id) => store.get(id),
  // `review-gate` is here because a rejection IS feedback (#48): the human's own
  // words have to reach the worker, and a button cannot carry them. Approval
  // still comes from the ✅ button — see classifyReviewAnswer, where anything
  // else counts as a rejection.
  findOpenForThread: (threadId) =>
    store.openEscalations()
      .filter((r) => r.discord?.threadId === threadId)
      .filter((r) => ['free-text', 'choice', 'preview-review', REVIEW_KIND].includes(r.kind))
      .at(-1) ?? null,
  answer(id, { answer, attachments = [], by, via }) {
    const result = store.answer(id, { answer, attachments, by, via })
    if (result.ok) {
      log(`escalation ${result.record.id} answered via ${via}${attachments.length ? ` (+${attachments.length} attachment${attachments.length > 1 ? 's' : ''})` : ''}${result.routed_from?.length ? ` (routed from ${result.routed_from.join('→')})` : ''}`)
      settle(result.record, answer, attachments)
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
    // #18 seam unchanged: the bridge only macro-expands; the far side is now
    // the deterministic command router (stated deviation — the overseer agent
    // session is a later ticket).
    store.logEvent('command', { canonical, by: userId })
    log(`command: "${canonical}"`)
    return router.handle(canonical, userId)
  },
  // #92: the bridge's overseer surface hands each operator message here; the
  // host runs one SDK query per message and speaks back through `io.post`.
  overseerTurn: (threadId, prompt, io) => overseer.runTurn(threadId, prompt, io),
}

// ---- dispatch loop (#33) ----------------------------------------------------

function notifyThread(ticket, message) {
  if (bridge) bridge.notify(ticket, message).catch((e) => log(`notify ticket-${ticket} failed:`, e.message))
  else log(`[notify ticket-${ticket}] ${message}`)
}

// Overseer confirm: a plain approve-reject escalation (first-valid-confirm-wins
// and Discord buttons come free from the reused gate). Bounded life: an
// in-process timer auto-cancels after confirm_ttl_h, and the resolver does NOT
// survive restart — boot reconcile voids open overseer confirms instead.
function overseerConfirm(ticket, prompt) {
  const { record, answered } = openEscalation({ worker: 'overseer', ticket, kind: 'approve-reject', prompt })
  const ttl = setTimeout(() => {
    const r = store.get(record.id)
    if (r?.status !== 'open') return
    gate.cancel(record.id, { by: 'ttl' })
    store.logEvent('confirm_expired', { id: record.id, ticket })
    notifyThread(ticket, `⌛ confirm **${record.id}** expired unanswered after ${curiaConfig.dispatch.confirm_ttl_h}h`)
  }, curiaConfig.dispatch.confirm_ttl_h * 3600_000)
  ttl.unref()
  return answered.then(({ text }) => {
    clearTimeout(ttl)
    return text === 'approve'
  })
}

// The review gate (#54 item 2). The same escalation machinery every ask_human
// uses — so first-valid-wins, the ~30-min re-nudge, Discord buttons, thread-reply
// capture and restart survival all come free — under its own kind, which is what
// makes an approval a fact the daemon can check (`/status`, the Stop hook) rather
// than a string in a prompt. Unlike overseerConfirm there is NO ttl: #11's
// indefinite block is the whole promise, and a review that expired under a human
// who was merely asleep would drop the work on the floor.
function askReview(worker, ticket, promptText) {
  const { record, answered } = openEscalation({ worker, ticket, kind: REVIEW_KIND, prompt: promptText })
  // The final status separates an approval-or-rejection from a 🛑 Cancel, which
  // settles the same promise with an "aborted" text.
  return answered.then(({ text }) => ({ text, status: store.get(record.id)?.status ?? 'answered' }))
}

const dispatcher = new Dispatcher({
  config: curiaConfig,
  routing: routingConfig,
  store,
  notify: notifyThread,
  confirm: overseerConfirm,
  askReview,
  // gate.cancel, not store.cancel: voiding a boot-orphaned confirm must also
  // settle it — release any pending resolver (a confirm opened via
  // POST /command inside the listen→boot-reconcile window has a live one) and
  // mark the Discord buttons.
  cancelEscalation: (id, opts) => gate.cancel(id, opts),
  log,
  cooling: new Cooling(),
  dataDir: DATA,
  daemonPort: PORT,
})

// /attach continuation: daemon-side whitelist refusal + liveness check, then
// the runtime-derived tailnet URL (never hardcoded).
const attachApi = {
  async link(ticket) {
    const session = `curia-${ticket}`
    if (!validSessionName(session)) throw new Error(`"${session}" is not a valid curia session name`)
    if (!(await hasSession(session))) throw new Error(`no live session \`${session}\` — /status to see what runs`)
    // Same rule as reconcile's #assertAttachSurface: only a listener verified
    // as our hardened ttyd is ever published. Handing out a link would both
    // assert the serve rule over an unverified listener and point a human at it.
    const { verified } = await ensureTtyd({ ttydPort: curiaConfig.attach.ttyd_port, index: curiaConfig.attach.index, log })
    if (!verified) {
      // Refusing alone withdraws nothing: /attach runs on every request, so
      // THIS is the path that detects a verified→unverified flip first (there
      // is no periodic reconcile — startAutoLoop only schedules dispatch
      // ticks), and the persisted serve rule still points at
      // 127.0.0.1:<ttyd_port> — a foreign listener that took the port would
      // stay live tailnet-wide at a URL already sitting in the Discord
      // thread. Same posture as reconcile's #assertAttachSurface: actively
      // withdraw the rule, then refuse.
      try {
        await serveOff({ servePort: curiaConfig.attach.serve_port, log })
        log(`attach: ttyd listener on port ${curiaConfig.attach.ttyd_port} is UNVERIFIED — serve rule for :${curiaConfig.attach.serve_port} withdrawn`)
      } catch (e) {
        log(`WARNING: ttyd listener on port ${curiaConfig.attach.ttyd_port} is UNVERIFIED and withdrawing the serve rule failed (${e.message}) — if a rule for :${curiaConfig.attach.serve_port} exists, the unverified listener REMAINS PUBLISHED tailnet-wide; run \`tailscale serve --https=${curiaConfig.attach.serve_port} off\` by hand`)
      }
      throw new Error(`the listener on ttyd port ${curiaConfig.attach.ttyd_port} could not be verified as curia's hardened ttyd — refusing to publish it; kill it and re-run reconcile`)
    }
    await assertServe({ servePort: curiaConfig.attach.serve_port, ttydPort: curiaConfig.attach.ttyd_port })
    const base = await attachBase()
    return attachUrl(base, curiaConfig.attach.serve_port, ticket)
  },
  // The timeline half of /attach (#74): same liveness gate, then the surface
  // composes its own link — or refuses, independently of the terminal half.
  async timelineLink(ticket) {
    const session = `curia-${ticket}`
    if (!validSessionName(session)) throw new Error(`"${session}" is not a valid curia session name`)
    if (!(await hasSession(session))) throw new Error(`no live session \`${session}\` — /status to see what runs`)
    return timeline.link(session)
  },
}

// Preview links (#40, implementing #8): the daemon owns allocation. `reserved`
// is the containment that matters — publishing the daemon's own port would put
// /answer, /command and /escalate on the tailnet unauthenticated, publishing
// the raw ttyd port would bypass the attach rule entirely, and publishing the
// timeline's ports would double-publish its writable composer.
const previews = new PreviewRegistry({
  range: curiaConfig.preview,
  reserved: [
    PORT, curiaConfig.attach.ttyd_port, curiaConfig.attach.serve_port,
    curiaConfig.timeline.port, curiaConfig.timeline.serve_port,
  ],
  log,
})
dispatcher.previews = previews // constructed after the dispatcher; teardown + sweep read it here

// The timeline surface (#74, landing #73's pick). In-process, so it can read
// the two things only the daemon has: which backend a session runs, and the
// durable escalation record — the claude lane's transcript is SILENT while an
// ask_human blocks (measured on #74), so open escalations are overlaid from
// the store or the surface shows a working worker as idle at the exact moment
// a human is needed.
const timeline = new TimelineSurface({
  port: curiaConfig.timeline.port,
  servePort: curiaConfig.timeline.serve_port,
  index: curiaConfig.timeline.index,
  workspaceRoot: curiaConfig.dispatch.workspace_root,
  log,
  deps: {
    journal: (type, detail) => store.logEvent(type, detail),
    backendFor: (session) => dispatcher.workers.get(session)?.backend
      ?? detectBackend(path.join(curiaConfig.dispatch.workspace_root, 'cfg', session)),
    // The dialog guard's composer veto (#75): a visible ready marker (#39)
    // says the pane is at its composer, so a dialog-footer phrase in the tail
    // is scrollback, not a dialog.
    composerFor: (backend) => routingConfig.backends[backend]?.readyRe ?? null,
    escalationsFor: (session) => store.openEscalations().filter((r) => r.worker === session),
  },
})
dispatcher.timeline = timeline // reconcile asserts/withdraws its serve rule alongside attach's

const router = new CommandRouter({ dispatcher, attach: attachApi, log })

// The overseer session host (#92): every effect goes through gate.command —
// the same seam the slash verbs and REST use — so it is journalled, logged and
// routed identically, and the tool surface is the containment boundary.
const overseer = new OverseerHost({
  store,
  dataDir: DATA,
  command: (text) => gate.command(text, 'overseer'),
  log,
})

// ---- worker-facing MCP surface (#29 shape) ---------------------------------

// Outbound images (#34): a worker may publish files from its OWN worktree and
// the daemon's data dir, nothing else — the daemon holds a Discord token and a
// tailnet position, so an unbounded path here would turn `notify` into an
// exfiltration primitive for anything the box can read. A worker the dispatcher
// does not know (synthetic/lab callers, whose MCP URL the daemon did not write)
// falls back to the workspace root.
function outboundImages(worker, images) {
  if (!images?.length) return { files: [], refusals: [] }
  const known = dispatcher.workers.get(worker)
  const roots = [known?.wtPath ?? curiaConfig.dispatch.workspace_root, DATA]
  return resolveOutboundImages(images, { roots, cwd: known?.wtPath })
}

// Keep a blocked ask_human alive on the wire (#34).
//
// The block itself is sound — the daemon holds the response for as long as it
// takes. What killed real workers was the CLIENT: Claude Code aborts an MCP
// tool call after 300s of server silence (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT),
// so an escalation was dead ~25 minutes before the #11 re-nudge could ever
// fire. The fix belongs here rather than in a client env var: every worker lane
// curia has evaluated (Claude Code, Codex, Cline, pi via ACP shims) speaks MCP,
// and periodic traffic on the stream is the protocol's own answer to a long
// call. Progress notifications when the client offered a token, logging
// notifications otherwise — either way, bytes flow and no idle timer fires.
const KEEPALIVE_MS = Number(process.env.MCP_KEEPALIVE_MS ?? 60_000)

function startKeepAlive(extra, id) {
  const token = extra?._meta?.progressToken
  let n = 0
  log(`keepalive for ${id}: ${token ? `progress notifications (token ${token})` : 'logging notifications (client offered no progressToken)'} every ${KEEPALIVE_MS / 1000}s`)
  const tick = () => {
    n += 1
    const sent = token
      ? extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: n, message: `curia: still waiting for a human on ${id}` },
      })
      : extra.sendNotification({
        method: 'notifications/message',
        params: { level: 'info', logger: 'curia', data: `still waiting for a human on ${id} (${n})` },
      })
    Promise.resolve(sent).catch((e) => log(`keepalive for ${id} failed: ${e.message}`))
  }
  const timer = setInterval(tick, KEEPALIVE_MS)
  timer.unref()
  return () => clearInterval(timer)
}

function buildMcpServer(worker, ticket) {
  const server = new McpServer({ name: 'curia-daemon', version: '0.1.0' }, { capabilities: { logging: {} } })

  server.tool(
    'notify',
    'Fire-and-forget status update to the human. Returns immediately. `images`: local file paths inside your workspace to show the human (screenshots, renders).',
    { message: z.string(), images: z.array(z.string()).optional() },
    async ({ message, images }) => {
      const { files, refusals } = outboundImages(worker, images)
      store.logEvent('notify', { worker, ticket, message, images: files.map((f) => f.attachment), refusals })
      if (bridge) bridge.notify(ticket, `📣 \`${worker}\`: ${message}`, { files }).catch(() => {})
      return { content: [{ type: 'text', text: refusals.length ? `ok (${refusals.length} image(s) refused)\n${refusals.join('\n')}` : 'ok' }] }
    },
  )

  // #40: the worker runs its dev server on localhost and asks the daemon to
  // publish it. The worker never picks the public port — see preview.mjs for
  // why that separation is the whole point of the registry.
  //
  // #68: it also names the PAGE. The port is the only thing the worker knew how
  // to say, so every composed link pointed at the site root; the path is where
  // the worker declares what it changed, once, in the same call.
  server.tool(
    'publish_preview',
    'Publish a dev server you have started on localhost as an HTTPS preview link the human can open from any device. Start the server FIRST (it must be listening), then call this with its port and the path of the page you want looked at — without a path the link opens the site root, which is usually not what you changed. Call it again with a different path to move the link. Returns the URL; curia puts it in the review gate itself, so you never need to repeat it in your own text. The link is withdrawn automatically when this ticket finishes.',
    {
      dev_port: z.number().int(),
      path: z.string().optional().describe('The path of the page to review, e.g. "/curia-check" or "/blog/post?draft=1". Defaults to "/". A path on this dev server only — never a host or a scheme.'),
    },
    async ({ dev_port, path }) => {
      let base
      try {
        base = await attachBase()
      } catch (e) {
        return { content: [{ type: 'text', text: `preview unavailable: could not resolve this box's tailnet name (${e.message})` }] }
      }
      const r = await previews.publish(ticket, dev_port, { base, path })
      store.logEvent('preview', {
        worker, ticket, dev_port, path: r.path ?? path ?? null,
        ok: r.ok, url: r.url ?? null, reason: r.reason ?? null,
      })
      if (!r.ok) return { content: [{ type: 'text', text: `preview refused — ${r.reason}` }] }
      if (bridge) bridge.notify(ticket, `🔗 preview for \`${worker}\`: ${r.url} (dev server on :${dev_port})`).catch(() => {})
      return { content: [{ type: 'text', text: r.url }] }
    },
  )

  // #54 item 1: landing left report_result, because the pull request is now what
  // a human reviews BEFORE anything is resolved. The worker still never pushes —
  // it asks the daemon to, which is the #40/#41 containment boundary with its
  // timing changed and nothing else.
  server.tool(
    'open_pull_request',
    'Push the commits on your branch and open the pull request for this ticket — curia does the pushing, you never do. Call it once you have committed something, and again after later commits: it updates the same pull request. Returns the pull-request URL. Next step after this is request_review.',
    { summary: z.string().describe('What this change does, for the pull-request body.') },
    // keepalive: a push plus two gh round-trips is well inside the client's 300s
    // idle abort (#34), but "well inside" is not a guarantee on a big repo
    async ({ summary }, extra) => {
      const stopKeepAlive = startKeepAlive(extra, `${worker}/pr`)
      try {
        return { content: [{ type: 'text', text: await dispatcher.openPullRequest(worker, { summary }) }] }
      } finally {
        stopKeepAlive()
      }
    },
  )

  // #54 item 2 / #48's gate: one gate, whatever the ticket type. Only the LINKS
  // differ, and the daemon composes every one of them from its own records.
  server.tool(
    'request_review',
    'THE review gate: ask the human "is this done?" and BLOCK until they answer. curia shows them the pull request, the preview and the ticket — you do not pass links, it knows them. On approval you merge the pull request and then resolve the ticket. A rejection comes back as the human\'s own words: fix, commit, open_pull_request again, and call this again.',
    {
      summary: z.string().describe('What you did, in a few lines. The human reads this on a phone. Do not paste links: curia composes every one of them — pull request, preview, ticket — from its own records, and a link you write is not evidence.'),
      charting: z.string().describe('CONCRETE map changes you propose: ticket titles to create, fog lines to remove, edges to wire, anything to rule out of scope. Write "none" if there are none. A vague answer here makes the approval a rubber stamp.'),
    },
    async ({ summary, charting }, extra) => {
      const stopKeepAlive = startKeepAlive(extra, `${worker}/review`)
      try {
        const r = await dispatcher.requestReview(worker, { summary, charting })
        return { content: [{ type: 'text', text: r.text }] }
      } finally {
        stopKeepAlive()
      }
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
      images: z.array(z.string()).optional(),
    },
    async ({ images, ...payload }, extra) => {
      const { files, refusals } = outboundImages(worker, images)
      const { record, answered } = openEscalation({ worker, ticket, ...payload, files })
      const stopKeepAlive = startKeepAlive(extra, record.id)
      // Images the human replies with come back as real content blocks, so the
      // picture lands in this worker's context without a Read round-trip (#34).
      const { text, attachments } = await answered.finally(stopKeepAlive)
      const refusalNote = refusals.length ? [{ type: 'text', text: `(curia refused ${refusals.length} outbound image(s): ${refusals.join('; ')})` }] : []
      return { content: [...refusalNote, { type: 'text', text }, ...inboundContent(attachments)] }
    },
  )

  // #41: this call now also closes the TICKET, not just curia's dispatch
  // lifecycle. The worker has already run the resolve protocol itself; the
  // daemon verifies it, repairs what is missing, and lands the branch as a PR.
  // The outcome comes back as the tool result, so the one agent still able to
  // react to a failure hears about it — and the keepalive is reused because that
  // work involves several gh/git round-trips and the client aborts an MCP call
  // after 300s of silence (#34).
  server.tool(
    'report_result',
    'Deliver the structured resolution for the ticket. Call exactly once, when the work is done and you have run the resolve protocol from your standing orders. curia verifies the resolution, repairs anything missing, and pushes your branch as a pull request; the reply tells you what it did.',
    {
      ticket: z.string(),
      status: z.enum(['resolved', 'blocked', 'aborted']),
      summary: z.string(),
      details: z.record(z.string(), z.any()).optional(),
    },
    async (result, extra) => {
      const rec = store.logEvent('result', { worker, ...result })
      fs.writeFileSync(path.join(DATA, 'results', `${worker}.json`), JSON.stringify(rec, null, 2))
      if (bridge) bridge.notify(result.ticket, `🏁 \`${worker}\` reports **${result.status}**: ${result.summary}`).catch(() => {})
      const stopKeepAlive = startKeepAlive(extra, `${worker}/result`)
      try {
        return { content: [{ type: 'text', text: await dispatcher.onResult(worker, result) }] }
      } finally {
        stopKeepAlive()
      }
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

// Every route body is awaited inside handleRequest, and handleRequest is
// awaited inside one try/catch here. Without it a rejection from any async
// route (POST /command → router.handle, POST /reconcile → dispatcher.reconcile)
// both hangs the request AND raises an unhandled rejection, which Node ≥15
// turns into an uncaught exception that kills the daemon.
const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    log(`request ${req.method} ${req.url} failed: ${e.message}`)
    if (res.writableEnded) return
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  })
})

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj, null, 2))
  }

  // CSRF gate for the whole loopback surface. A cross-origin
  // `fetch('http://127.0.0.1:4271/command', {mode:'no-cors', ...})` from any
  // page in a browser ON THIS HOST is a CORS *simple* request — no preflight,
  // and the side effect lands even though the response is unreadable. The port
  // is a fixed default and readBody JSON-parses regardless of content-type, so
  // without this check any web page could dispatch a bypassPermissions worker
  // on an attacker-filed issue (POST /command with an explicit repo skips the
  // frontier gate) or reach `git worktree remove --force` via POST /reconcile.
  // Browsers always send Origin on cross-origin requests and stamp
  // Sec-Fetch-Site; loopback tooling (curl, the worker's Stop hook, the MCP
  // client) sends neither — so refuse any request that carries either marker
  // of a browser-mediated cross-site call.
  const site = req.headers['sec-fetch-site']
  if (req.headers.origin !== undefined || (site && site !== 'same-origin' && site !== 'none')) {
    return json(403, { error: 'cross-origin request refused — this surface is for loopback tooling, not browsers' })
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
    // `bridge` keeps its string shape and gains `degraded` (#56): a poller that
    // only knew up/down still reads correctly, and one that cares can tell a
    // reconnecting gateway from a dead one.
    const health = bridge ? bridge.status() : null
    return json(200, {
      bridge: health?.state ?? 'down',
      bridge_health: health ?? { state: 'down', since: null, unhealthy_for_s: 0, last_error: null },
      open_escalations: store.openEscalations(),
    })
  }

  if (url.pathname === '/escalate' && req.method === 'POST') {
    const body = await readBody(req)
    const worker = body.worker ?? 'synthetic'
    // Same containment as the MCP path: /escalate is loopback-only, but it must
    // not be the softer way to hand the bridge an arbitrary file.
    const { files } = outboundImages(worker, body.images ?? body.files)
    const { record, answered } = openEscalation({
      worker, ticket: body.ticket ?? 'unknown',
      kind: body.kind ?? 'approve-reject', prompt: body.prompt ?? '(no prompt)',
      options: body.options, preview_url: body.preview_url, files,
    })
    if (url.searchParams.get('wait')) {
      const { text, attachments } = await answered
      return json(200, { id: record.id, answer: text, attachments })
    }
    return json(200, { id: record.id })
  }

  if (url.pathname === '/answer' && req.method === 'POST') {
    const { id, answer, attachments } = await readBody(req)
    // Attachment paths get read and inlined into a worker's context, so they
    // pass the same containment gate as outbound images rather than being
    // trusted because the caller reached loopback.
    const { files } = outboundImages('rest', attachments)
    const result = gate.answer(id, {
      answer: String(answer), attachments: files.map((f) => f.attachment), by: 'rest', via: 'rest',
    })
    return json(result.ok ? 200 : 409, result)
  }

  if (url.pathname === '/cancel' && req.method === 'POST') {
    const { id } = await readBody(req)
    const result = gate.cancel(id, { by: 'rest' })
    return json(result.ok ? 200 : 409, result)
  }

  // The Stop hook is now the ENFORCEMENT of the ending (#54 item 4), not just a
  // notification that a turn ended: `{decision:"block", reason}` sends the worker
  // back with its outstanding checklist.
  //
  // Two phases on purpose. The decision is awaited, because the hook needs it on
  // the wire; the terminal work is NOT, because it kills the tmux session the
  // hook's own curl is running inside — awaiting it would kill the request before
  // the response left.
  //
  // Every failure here ALLOWS the stop. A daemon bug must never trap a worker in
  // a block loop.
  if (url.pathname === '/worker_done' && req.method === 'POST') {
    const body = await readBody(req)
    const worker = url.searchParams.get('worker') ?? 'unknown'
    const stopHookActive = Boolean(body.stop_hook_active)
    store.logEvent('worker_done', {
      worker,
      hook_event: body.hook_event_name,
      session_id: body.session_id,
      stop_hook_active: body.stop_hook_active,
    })
    let decision
    try {
      decision = await dispatcher.onStopHook(worker, { stopHookActive })
    } catch (e) {
      log(`onStopHook ${worker} failed (${e.message}) — allowing the stop`)
      decision = { allow: true, terminal: true }
    }
    if (decision?.decision === 'block') {
      return json(200, { decision: 'block', reason: decision.reason })
    }
    if (decision?.terminal) {
      dispatcher.onWorkerDone(worker).catch((e) => log(`onWorkerDone ${worker} failed:`, e.message))
    }
    // An EMPTY object, not `{ok:true}`. Both CLIs read "no decision" as allow,
    // but codex validates this body against a closed schema and rejected the
    // extra key outright — `Stop hook (failed): hook returned invalid stop hook
    // JSON output`, printed in the worker's own pane on every clean ending
    // (observed). It failed open, so nothing was trapped; what it cost was the
    // signal, since a genuinely broken hook would have looked exactly the same.
    return json(200, {})
  }

  // REST parity with the Discord slash verbs (agent-driven verification;
  // localhost-only like everything else). Goes through gate.command, the SAME
  // seam Discord uses — two hand-rolled copies of log+journal+dispatch had
  // already drifted apart.
  if (url.pathname === '/command' && req.method === 'POST') {
    const { text } = await readBody(req)
    if (typeof text !== 'string' || !text.trim()) return json(400, { error: 'body must carry {text}' })
    const reply = await gate.command(text, 'rest')
    return json(200, { reply })
  }

  if (url.pathname === '/reconcile' && req.method === 'POST') {
    await dispatcher.reconcile({ boot: false })
    return json(200, { ok: true })
  }

  json(404, { error: 'not found' })
}

// ---- boot -------------------------------------------------------------------

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`curia daemon listening on http://127.0.0.1:${PORT}`)
  // The timeline listener binds before boot reconcile so the reconcile's
  // assert sees it up and publishes it — a bind failure leaves it down and the
  // assert withdraws instead (never fatally: the daemon without a timeline is
  // still a daemon).
  timeline.start()
    // boot reconcile (#33): re-derive live workers from GitHub + tmux + journal,
    // sweep orphans, release dead claims, void restart-orphaned overseer
    // confirms, assert the attach + timeline surfaces — then start the auto
    // loop (a no-op while auto_dispatch is false). Not gated on the bridge.
    .then(() => dispatcher.reconcile({ boot: true }))
    .then(() => {
      log('boot reconcile done')
      dispatcher.startAutoLoop()
    })
    .catch((e) => log(`boot reconcile failed: ${e.message} — POST /reconcile to retry`))
})

// restart recovery: every open escalation in the journal gets its nudge timer
// back; records that never rendered retry on the first tick
for (const r of store.openEscalations()) {
  log(`recovered open escalation ${r.id} (${r.kind}) worker=${r.worker} ticket=${r.ticket}`)
  scheduleNudge(r)
}

// #56 bridge health. The outage clock lives HERE rather than on the bridge
// object, because a wedge recovery throws the bridge away and builds a new one —
// a per-instance clock would report a fresh instance as never having been down.
const BRIDGE_NOTICE_MS = Number(process.env.BRIDGE_NOTICE_MS ?? 30_000)
const BRIDGE_WEDGE_MS = Number(process.env.BRIDGE_WEDGE_MS ?? 5 * 60 * 1000)
let bridgeDownSince = null

// The announcement can only ever be made AFTER the bridge is back, because
// Discord is the surface being announced about — there is no second channel to
// the phone. So the honest contract is: journal + /state while it is down, one
// line in the channel once it works again.
function onBridgeHealth(ev) {
  store.logEvent('bridge_health', {
    state: ev.state, previous: ev.previous, reason: ev.reason, error: ev.error ?? null,
  })
  if (ev.state === ev.previous) return // an error report, not a transition
  if (ev.state !== 'up') {
    if (!bridgeDownSince) bridgeDownSince = Date.now()
    return
  }
  const downMs = bridgeDownSince ? Date.now() - bridgeDownSince : 0
  bridgeDownSince = null
  if (downMs < BRIDGE_NOTICE_MS) return // routine gateway resume; the journal has it
  const open = store.openEscalations()
  const held = open.length
    ? `${open.length} open question${open.length > 1 ? 's' : ''} stayed answerable throughout (${open.map((r) => r.id).join(', ')}).`
    : 'No question was open at the time.'
  const text = `🔌 Discord bridge was down for ${Math.round(downMs / 1000)}s and is back. ${held}`
  store.logEvent('bridge_recovered', { down_ms: downMs, open: open.map((r) => r.id) })
  bridge?.announce(text).catch((e) => log(`bridge recovery notice failed: ${e.message}`))
}

if (process.env.DISCORD_BOT_TOKEN) {
  const allowed = (process.env.DISCORD_ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!allowed.length) {
    log('DISCORD_ALLOWED_USERS is empty — refusing to start the bridge without an auth gate')
  } else {
    // Set while a launch ladder is in flight, cleared only on success. The wedge
    // watchdog reads it so a bridge that is already retrying does not collect a
    // second, third and fourth retry ladder running against each other.
    let bridgeLaunching = false
    // A fresh instance per launch: the wedge watchdog below relaunches, and a
    // destroyed discord.js Client does not log back in.
    const launchBridge = (attempt = 1) => {
      bridgeLaunching = true
      const b = new DiscordBridge({
        token: process.env.DISCORD_BOT_TOKEN,
        allowedUsers: allowed,
        guildId: process.env.CURIA_GUILD_ID,
        channelName: process.env.CURIA_CHANNEL ?? 'curia',
        overseerChannelName: process.env.OVERSEER_CHANNEL ?? 'curia-overseer',
        dataDir: DATA,
        handlers: gate,
        log,
        onHealth: onBridgeHealth,
      })
      return b.start().then(() => {
        bridge = b
        bridgeLaunching = false
        // re-render any recovered escalation that has no message yet, and confirm
        // recovered ones that do are still answerable (message ids in the record)
        for (const r of store.openEscalations()) {
          if (!r.discord) renderEscalation(r)
        }
      }).catch((e) => {
        if (!bridgeDownSince) bridgeDownSince = Date.now()
        const delay = Math.min(60_000, 5_000 * attempt)
        log(`bridge start attempt ${attempt} failed: ${e.message} — retrying in ${delay / 1000}s (escalations remain REST-answerable)`)
        b.stop().catch(() => {})
        setTimeout(() => launchBridge(attempt + 1), delay).unref()
      })
    }
    launchBridge()

    // Wedge watchdog (#56). Surviving the crash is only half the fix: a bridge
    // that no longer dies but never reconnects is the silent failure this ticket
    // calls the worse one. discord.js reconnects on its own, so this fires only
    // when its own recovery did not — and then it rebuilds the bridge rather
    // than leaving a live daemon with a dead phone.
    const wedgeTimer = setInterval(() => {
      if (!bridgeDownSince || bridgeLaunching) return
      const downMs = Date.now() - bridgeDownSince
      if (downMs < BRIDGE_WEDGE_MS) return
      store.logEvent('bridge_wedged', { down_ms: downMs })
      log(`[bridge] down for ${Math.round(downMs / 1000)}s with no recovery — rebuilding the bridge`)
      const dead = bridge
      bridge = null
      dead?.stop().catch(() => {})
      launchBridge()
    }, 60_000)
    wedgeTimer.unref()
  }
} else {
  log('no DISCORD_BOT_TOKEN — running without the bridge (REST-only)')
}

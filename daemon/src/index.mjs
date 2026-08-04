// Curia daemon (#31 + #33): durable escalation record + Discord bridge module,
// the agent-facing MCP surface proven in spike #29, and the dispatch loop.
//
//   POST /mcp?agent=<name>&ticket=<n>  — streamable-HTTP MCP (ask_human / notify / report_result)
//
// The two agent routes (/mcp, /agent_done) carry the per-agent token #159
// mints; the rest are the operator's own and never leave loopback.
//
//   GET  /state                          — open escalations
//   POST /escalate                       — synthetic escalation (testing / non-MCP emitters)
//   POST /answer {id, answer}            — REST answer (same first-valid-wins gate as Discord)
//   POST /agent_done?agent=            — Stop-hook webhook (closes the dispatch lifecycle)
//   POST /command {text}                 — canonical command text (REST parity with the slash verbs)
//   POST /reconcile                      — on-demand reconcile (boot reconcile runs automatically)
//
// State posture (#9): the events journal is the only durable artifact; the
// pending-resolver map, ticket→thread cache and dispatcher agents map are
// ephemeral. A daemon restart keeps every open escalation renderable and
// answerable, and reconcile re-derives live agents from GitHub + tmux.

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { format } from 'node:util'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { EscalationStore, CONFIRM_KIND } from './store.mjs'
import { DiscordBridge } from './bridge.mjs'
import { installCrashGuard } from './health.mjs'
import { readable } from './logline.mjs'
import { resolveOutboundImages, inboundContent } from './images.mjs'
import { PreviewRegistry } from './preview.mjs'
import { assertSandboxConfig, loadCuriaConfig, loadRoutingConfig } from './config.mjs'
import { PROBE_MARK, PROBE_PATH, dockerGateway, probeSideChannel } from './sandbox.mjs'
import { Cooling } from './routing.mjs'
import { Dispatcher } from './dispatch.mjs'
import { REVIEW_KIND } from './lifecycle.mjs'
import { CommandRouter } from './commands.mjs'
import { OverseerHost } from './overseer.mjs'
import { hasSession } from './tmux.mjs'
import { assertGhTokens, ghTokenKeyFor, agentGhToken } from './workspace.mjs'
import { TOKEN_HEADER, AGENT_ROUTES, tokensDir, agentTokenMatches } from './agenttoken.mjs'
import { probeAgentToken, tokenExpiryDays } from './github.mjs'
import { ensureTtyd, assertServe, serveOff, attachBase, attachSessionUrl, validSessionName } from './attach.mjs'
import { TimelineSurface } from './timeline.mjs'
import { IdentityProxy, identityRefusal, serveHosts, tailnetSelf } from './identity.mjs'
import { detectHarness } from './transcript.mjs'
import { promptTitle, elapsedLabel, speakerName } from './messaging.mjs'
import { StatusLine } from './statusline.mjs'
import { AccountUsage, ModelWindows, agentMeters } from './usage.mjs'

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
// Daemon-owned, never mounted into a container: one agent's token is unreadable
// by every other agent (#159).
fs.mkdirSync(tokensDir(DATA), { recursive: true, mode: 0o700 })

// dispatch-loop config (#33) — hand-edited YAML, validated on load; a bad
// shape refuses the boot rather than limping
const CONFIG_DIR = process.env.CURIA_CONFIG_DIR ?? path.join(ROOT, '..', 'config')
const curiaConfig = loadCuriaConfig(path.join(CONFIG_DIR, 'curia.yaml'))
const routingConfig = loadRoutingConfig(path.join(CONFIG_DIR, 'routing.yaml'))
// The one check neither file can make alone (#156): the switch is in
// routing.yaml, the image pins are in curia.yaml.
const SANDBOXED_HARNESSES = assertSandboxConfig(curiaConfig, routingConfig)

// #155: the agent's own GitHub authority — one scoped fine-grained PAT per
// resource owner. Read at BOOT so a malformed value refuses the boot rather than
// reaching an agent as a 401 in the middle of a resolve, and said out loud per
// watched owner, because an owner with no token silently keeps the host's
// account-wide login and that is the thing this ticket exists to end. The daemon
// itself never uses these (see agentGhToken).
for (const { key, token } of assertGhTokens()) log(`agent GitHub token ${key} (…${token.slice(-4)})`)
for (const owner of new Set(curiaConfig.watch.map((w) => w.repo.split('/')[0]))) {
  const key = ghTokenKeyFor(owner)
  if (!agentGhToken(`${owner}/x`)) log(`WARNING: no ${key} — agents on ${owner}/* inherit the host gh login (account-wide)`)
}

// And the same tokens against GitHub itself, once per watched repo. A token's
// repository list lives on GitHub rather than in `.env`, so nothing local can
// tell that a newly watched repo was left off it. Detached from the boot chain
// on purpose: this is one network round-trip per repo, and GitHub being slow or
// down must never hold up a daemon whose other duties do not need it. See
// probeAgentToken for the one case it cannot see.
const TOKEN_EXPIRY_WARN_DAYS = 14
Promise.all(curiaConfig.watch.map(async ({ repo }) => {
  const token = agentGhToken(repo)
  if (!token) return
  try {
    const { ok, message, expiresAt } = await probeAgentToken(repo, token)
    const key = ghTokenKeyFor(repo)
    if (!ok) {
      log(`WARNING: ${key} cannot reach ${repo} (${message}) — an agent on it will fail at its first gh call`)
      return
    }
    const days = tokenExpiryDays(expiresAt)
    if (days === null) return
    if (days <= TOKEN_EXPIRY_WARN_DAYS) log(`WARNING: ${key} expires in ${days} day(s), on ${expiresAt} — mint a new one before it dies`)
    else log(`${key} reaches ${repo}, expires in ${days} days`)
  } catch (e) {
    // A network failure is a fact about the network, not about the token.
    log(`could not check the agent token for ${repo} (${e.message}) — not treating that as a bad token`)
  }
})).catch(() => {})

const store = new EscalationStore(DATA)

// Per-agent status line (#108 item 8): one Discord message per agent
// thread, edited in place through the journal's own lifecycle events. With
// the bridge down, post returns null and the next transition retries.
// One account reading for every anthropic agent (#146): the 5 h / 7 d windows
// are an account fact, not an agent fact.
const accountUsage = new AccountUsage({
  enabled: curiaConfig.usage.account_bars,
  probeModel: curiaConfig.usage.probe_model,
  log,
})
// The context %'s denominator, looked up live per model id (#178). Not gated by
// `account_bars`: that switch exists because the account probe spends quota,
// and this lookup spends none.
const modelWindows = new ModelWindows({ log })
const statusLine = new StatusLine({
  post: (ticket, text) => (bridge ? bridge.postStatus(ticket, text) : null),
  edit: (ids, text) => (bridge ? bridge.editStatus(ids, text) : false),
  remove: (ids) => (bridge ? bridge.deleteStatus(ids) : null),
  get: (id) => store.get(id),
  log,
  // Same harness resolution the timeline uses: the dispatcher's word on what it
  // spawned, on-disk evidence for re-adopted and lab sessions.
  //
  // The routing label takes the same route (#187). The status line only learns
  // it from a spawn event, so a line first drawn after a restart carries none —
  // and the effort meter reads off the label's routing row. The dispatcher's
  // record answers instead, which reconcile now rebuilds from the journal.
  meters: (session, model) => agentMeters({
    harness: dispatcher?.agents.get(session)?.harness
      ?? detectHarness(path.join(curiaConfig.dispatch.workspace_root, 'cfg', session)),
    cfgDir: path.join(curiaConfig.dispatch.workspace_root, 'cfg', session),
    model: model ?? dispatcher?.agents.get(session)?.model ?? null,
    routing: routingConfig,
    account: accountUsage,
    models: modelWindows,
  }),
})
statusLine.start()
store.onEvent = (ev) => statusLine.onEvent(ev)
const pending = new Map() // escalation id -> resolve(answerText) — ephemeral, dies with the process
const nudgeTimers = new Map() // escalation id -> interval handle — ephemeral, rebuilt on boot

let bridge = null

// #190: one control character anywhere in a message makes journalctl print
// `[NNNB blob data]` and drop the words, so the streamed `docker build` output
// this function also carries is cleaned before it is written. The timestamp is
// built outside format(), which would read a `%s` in it as a specifier.
function log(...args) {
  console.log(`[${new Date().toISOString()}] ${readable(format(...args))}`)
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
  // #94: a confirm has no nudge and no expiry — it waits silently and lapses
  // with its agent.
  if (record.kind === CONFIRM_KIND) return
  if (nudgeTimers.has(record.id)) return
  const t = setInterval(() => {
    const r = store.get(record.id)
    if (!r || r.status !== 'open') return clearNudge(record.id)
    // esc_nudge refreshes the status line's elapsed time in place (#108 items
    // 8/13) — the separate still-waiting reminder message is gone.
    store.nudge(r.id)
    // a record that never rendered (bridge was down, #22) gets re-rendered here
    if (bridge && !r.discord) renderEscalation(r).catch((e) => log('nudge render failed', e.message))
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
function openEscalation({ agent, ticket, kind, prompt, options, preview_url, files }) {
  const { record, superseded } = store.open({ agent, ticket, kind, prompt, options, preview_url })
  log(`escalation ${record.id} open (${kind}) agent=${agent} ticket=${ticket}${superseded ? ` supersedes ${superseded.id}` : ''}`)
  if (superseded) {
    pending.delete(superseded.id) // the agent aborted that call; nobody is waiting on it
    clearNudge(superseded.id)
    if (bridge) bridge.markSuperseded(store.get(superseded.id)).catch(() => {})
  }
  scheduleNudge(record)
  renderEscalation(record, files)
  const answered = new Promise((resolve) => pending.set(record.id, resolve))
  return { record, answered }
}

// Resolves with { text, attachments } — the answer's images travel with it all
// the way to the agent's tool result (#34). Returns whether a resolver was
// actually waiting: false means the blocked call died with a previous daemon
// process, and the answer needs the #139 hand-off instead.
function settle(record, text, attachments = []) {
  clearNudge(record.id)
  const resolve = pending.get(record.id)
  pending.delete(record.id)
  if (resolve) resolve({ text, attachments })
  return Boolean(resolve)
}

// #139: the answer is recorded, but nothing live received it — no resolver
// (a daemon restart emptied `pending`), or the agent died mid-ask (#138's
// sweep marked the record). Queue question + answer as an agent note — the
// journalled channel a resumed agent drains on its first tool result — and
// say in the thread where the answer went.
function handOffAnswer(record) {
  if (!/^curia-\d+$/.test(record.agent)) return // synthetic/lab callers have no resume
  store.queueRecordedAnswer(record)
  const live = dispatcher.agents.has(record.agent)
  notifyThread(record.ticket, live
    ? `✅ recorded — \`${record.agent}\` gets this answer with its next tool result`
    : `✅ recorded — \`${record.agent}\` is not running; \`resume ${record.ticket}\` hands it over`)
  log(`escalation ${record.id} answered with no live receiver — hand-off note queued for ${record.agent}`)
}

// handlers the bridge (and REST) call into — the single first-valid-wins gate
const gate = {
  get: (id) => store.get(id),
  // `review-gate` is here because a rejection IS feedback (#48): the human's own
  // words have to reach the agent, and a button cannot carry them. Approval
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
      const delivered = settle(result.record, answer, attachments)
      if (bridge) bridge.markAnswered(result.record).catch(() => {})
      // The executing path of a button confirm (#94): button → HERE → the
      // dispatcher, never through the model. The record is already closed
      // (first-valid-wins above), so a second press can never execute twice.
      if (result.record.kind === CONFIRM_KIND) {
        dispatcher.onConfirmAnswered(result.record)
          .catch((e) => log(`confirm ${result.record.id} execution failed: ${e.message}`))
      } else if (!delivered || result.record.agent_died) {
        // A resolver on a dead agent's record "delivered" into a closed
        // transport — the agent_died mark, not the resolver, is the truth.
        handOffAnswer(result.record)
      }
    }
    return result
  },
  // The record-level void: a question closes because nothing can receive its
  // answer any more. Every caller is a death — the cancel teardown, the
  // agent-death sweep, reconcile, the REST seam. #200 took the 🛑 button
  // away, so no human reaches this against a LIVE agent, and the settled text
  // is a fact for whatever transport is still holding the promise rather than
  // an instruction to a model. Prose in a tool result was the whole fault:
  // the agent read "stop this line of work", and asked the same question
  // again a minute later.
  cancel(id, { by }) {
    const result = store.cancel(id, { by })
    if (result.ok) {
      log(`escalation ${result.record.id} cancelled`)
      settle(result.record, `aborted: this question was cancelled — nobody is waiting for an answer to it`)
      if (bridge) bridge.markCancelled(result.record).catch(() => {})
    }
    return result
  },
  // ctx.threadId (#93): the thread the command was issued in, so `start`
  // binds the thread it runs in. Slash verbs at top level and REST carry none.
  async command(canonical, userId, ctx = {}) {
    // #18 seam unchanged: the bridge only macro-expands; the far side is now
    // the deterministic command router (stated deviation — the overseer agent
    // session is a later ticket).
    store.logEvent('command', { canonical, by: userId })
    log(`command: "${canonical}"`)
    return router.handle(canonical, userId, ctx)
  },
  // #92: the bridge's overseer surface hands each operator message here; the
  // host runs one SDK query per message and speaks back through `io.post`.
  overseerTurn: (threadId, prompt, io) => overseer.runTurn(threadId, prompt, io),
  // #120: the live agent bound to a thread, if any — the bridge's one-listener
  // guard reads it before letting the overseer near a message.
  agentForThread(threadId) {
    if (!threadId) return null
    for (const w of dispatcher.agents.values()) {
      // #164: a cross-check reviewer sits in the BUILDER's thread and answers no
      // note — it has no `ask_human` and drains no queue past its one verdict.
      // The thread belongs to the builder, which is still working in it.
      if (w.reviewer) continue
      if (w.ticket != null && store.threadForTicket(w.ticket) === threadId) return w.session
    }
    return null
  },
  // #118 item 4 / #108 item 22: the surface links escalation messages carry as
  // buttons. Each throws or returns null on a dead surface; the bridge fails
  // soft per button.
  timelineLink: (ticket) => attachApi.timelineLink(ticket),
  terminalLink: (ticket) => attachApi.link(ticket),
  previewUrl: (ticket) => previews.get(String(ticket))?.url ?? null,
  // #108 item 14, positive half: text in an agent-bound thread outside an open
  // escalation queues for the agent instead of being refused. Returns null
  // when no agent owns the thread — the bridge falls back to the overseer.
  queueAgentNote(threadId, text, by) {
    const agent = gate.agentForThread(threadId)
    if (!agent || !text?.trim()) return null
    const { after } = store.queueAgentNote(agent, text.trim(), { by })
    // `reads` is what the bridge promises the operator (#170). A `failed`
    // agent — the early exit (#169), the ready timeout, the result-less exit
    // — calls no more tools, so "it reads this with its next tool result" is a
    // promise nothing can keep. The note still queues: the session-keyed queue
    // hands it to whatever resumes on this session.
    const reads = dispatcher.agents.get(agent)?.state !== 'failed'
    log(`agent note queued for ${agent}${after ? ` (after ${after})` : ''}${reads ? '' : ' — that agent is not running'}`)
    // the ticket rides along so the bridge can spell out `cancel <n>` when the
    // note is command-shaped (#108 item 23, #170)
    return { agent, after, reads, ticket: store.ticketForThread(threadId) ?? null }
  },
}

// ---- dispatch loop (#33) ----------------------------------------------------

function notifyThread(ticket, message, opts = {}) {
  if (bridge) bridge.notify(ticket, message, opts).catch((e) => log(`notify ticket-${ticket} failed:`, e.message))
  else log(`[notify ticket-${ticket}] ${message}`)
}

// Button confirms (#94, per #89): the interpreted cancel path opens a
// `confirm` escalation — rendered with ✅/❌ through the same machinery as
// every other escalation, journalled, answerable after a bridge outage — and
// NOTHING waits on it: no resolver, no nudge, no TTL. The executing path is
// button → gate.answer → dispatcher.onConfirmAnswered, and the record lapses
// the moment its agent exits.
function openConfirm({ ticket, prompt, action, originThreadId }) {
  const { record, superseded } = store.open({
    agent: 'overseer', ticket, kind: CONFIRM_KIND, prompt, action, origin_thread_id: originThreadId ?? null,
  })
  log(`confirm ${record.id} open (${action.verb}) ticket=${ticket}${superseded ? ` supersedes ${superseded.id}` : ''}`)
  if (superseded && bridge) bridge.markSuperseded(store.get(superseded.id)).catch(() => {})
  renderEscalation(record)
  return record
}

function lapseEscalation(id, reason) {
  const r = store.lapse(id, reason)
  if (r.ok) {
    log(`confirm ${id} lapsed (${reason})`)
    if (bridge) bridge.markLapsed(store.get(id)).catch(() => {})
  }
  return r
}

// The review gate (#54 item 2). The same escalation machinery every ask_human
// uses — so first-valid-wins, the ~30-min re-nudge, Discord buttons, thread-reply
// capture and restart survival all come free — under its own kind, which is what
// makes an approval a fact the daemon can check (`/status`, the Stop hook) rather
// than a string in a prompt. Unlike overseerConfirm there is NO ttl: #11's
// indefinite block is the whole promise, and a review that expired under a human
// who was merely asleep would drop the work on the floor.
function askReview(agent, ticket, promptText) {
  const { record, answered } = openEscalation({ agent, ticket, kind: REVIEW_KIND, prompt: promptText })
  // The final status separates an approval-or-rejection from a cancel — a
  // gate whose agent was torn down (#200) settles the same promise with an
  // "aborted" text, and the status is what tells the two apart.
  return answered.then(({ text }) => ({ text, status: store.get(record.id)?.status ?? 'answered' }))
}

// Ticket-thread bindings (#93): the store journals the truth, the bridge does
// the display (thread creation, the 🎫 rename, the ✅ swap on release). With
// the bridge down, bind journals nothing — the first notify after it returns
// binds lazily — and release still journals, so a terminal state is never
// missed for want of a rename.
const threads = {
  async bind(ticket, opts) {
    if (!bridge) return { ok: false, reason: 'bridge-down' }
    return bridge.bindTicket(ticket, opts)
  },
  async release(ticket, reason) {
    if (bridge) return bridge.releaseTicket(ticket, reason)
    store.releaseTicketThread(ticket, reason)
  },
  // A cancel renames and keeps the binding (#200, #140). With the bridge down
  // there is nothing to do: no journal line carries a thread NAME, and the
  // next dispatch relabels the thread anyway.
  async cancelled(ticket) {
    if (bridge) return bridge.cancelTicket(ticket)
  },
}

const dispatcher = new Dispatcher({
  config: curiaConfig,
  routing: routingConfig,
  store,
  notify: notifyThread,
  openConfirm,
  lapseEscalation,
  // a confirm outcome lands next to its own buttons, whatever thread they are in
  confirmNote: (record, text) => {
    if (bridge) bridge.notifyRecordThread(record, text).catch((e) => log(`confirm note for ${record.id} failed: ${e.message}`))
    else log(`[confirm ${record.id}] ${text}`)
  },
  // the synthetic line for the issuing thread's session (#94) — journalled,
  // drained into the next prompt by the overseer host
  overseerNote: (threadId, text) => store.addOverseerNote(threadId, text),
  askReview,
  threads,
  // gate.cancel, not store.cancel: voiding a boot-orphaned confirm must also
  // settle it — release any pending resolver (a confirm opened via
  // POST /command inside the listen→boot-reconcile window has a live one) and
  // mark the Discord buttons.
  cancelEscalation: (id, opts) => gate.cancel(id, opts),
  // #118 item 7 / #108 item 22: the ready message carries both attach handles
  // as link BUTTONS, composed the same way /attach composes them — each half
  // failing independently.
  attachLinks: async (ticket) => {
    const links = []
    try { links.push({ label: 'timeline', url: await attachApi.timelineLink(ticket) }) } catch { /* half missing is fine */ }
    try { links.push({ label: 'terminal', url: await attachApi.link(ticket) }) } catch { /* half missing is fine */ }
    return links.length ? links : null
  },
  log,
  cooling: new Cooling(),
  dataDir: DATA,
  daemonPort: PORT,
  deps: {
    // #188: the container-facing listener is this file's, so the check that a
    // sandboxed dispatch can rely on it is this file's too. It binds lazily,
    // and it proves the path with a container.
    assertSideChannel,
  },
})

// ---- the identity check (#151) ----------------------------------------------
//
// One policy, both attach surfaces: the allowlist from config, and the set of
// host names this box legitimately answers to on each serve port. The two host
// sets are created EMPTY and filled in place, so the proxy and the timeline
// hold live references and pick up a resolution that arrives after they start.
// Empty means refuse (identityRefusal treats an empty set as "cannot verify my
// own name"), which is the right posture during the window before tailscale has
// answered: a surface that does not yet know its own name cannot admit anyone.
const identityAllow = new Set(curiaConfig.identity.allow)
const attachHosts = new Set()
const timelineHosts = new Set()

async function resolveServeHosts() {
  const self = await tailnetSelf()
  for (const [set, servePort] of [
    [attachHosts, curiaConfig.attach.serve_port],
    [timelineHosts, curiaConfig.timeline.serve_port],
  ]) {
    set.clear()
    for (const h of serveHosts({ ...self, servePort })) set.add(h)
  }
  return self
}

// Retried rather than resolved once: the daemon must boot with tailscale down
// (it is not fatal to anything but attach), and every path that hands out a
// link is async and passes through here first.
async function ensureServeHosts() {
  if (attachHosts.size && timelineHosts.size) return
  await resolveServeHosts()
}

const timelineIdentityCheck = (headers) =>
  identityRefusal(headers, { allow: identityAllow, hosts: timelineHosts })

// The terminal surface's half. ttyd is a C process with nowhere to put a
// check, so the rule published to the tailnet points HERE and this reaches
// ttyd on loopback.
const identityProxy = new IdentityProxy({
  port: curiaConfig.identity.proxy_port,
  targetPort: curiaConfig.attach.ttyd_port,
  allow: identityAllow,
  hosts: attachHosts,
  log,
  journal: (type, detail) => store.logEvent(type, detail),
})

// /attach continuation: daemon-side whitelist refusal + liveness check, then
// the runtime-derived tailnet URL (never hardcoded).
const attachApi = {
  // `session` names WHICH agent on this ticket (#164): the builder by default,
  // the cross-check reviewer when the caller asks for it. Everything below is
  // session-scoped already — ttyd picks a session from `?arg=`, and the
  // liveness check is a `has-session` — so this is the argument moving out, not
  // a second code path.
  async link(ticket, { session = `curia-${ticket}` } = {}) {
    if (!validSessionName(session)) throw new Error(`"${session}" is not a valid curia session name`)
    if (!(await hasSession(session))) throw new Error(`no live session \`${session}\` — /status to see what runs`)
    // Same rule as reconcile's #assertAttachSurface: only a listener verified
    // as our hardened ttyd is ever published. Handing out a link would both
    // assert the serve rule over an unverified listener and point a human at it.
    // The #151 identity proxy is what the serve rule points at, so a proxy that
    // is not up is exactly as disqualifying as an unverified ttyd — publishing
    // ttyd directly would hand the tailnet the un-gated terminal this ticket
    // closed.
    const { verified } = identityProxy.listening
      ? await ensureTtyd({ ttydPort: curiaConfig.attach.ttyd_port, index: curiaConfig.attach.index, log })
      : { verified: false }
    if (!verified) {
      // Refusing alone withdraws nothing: /attach runs on every request, so
      // THIS is the path that detects a verified→unverified flip first (there
      // is no periodic reconcile — startAutoLoop's tick only dispatches and
      // sweeps agent liveness), and the persisted serve rule still points at
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
      throw new Error(identityProxy.listening
        ? `the listener on ttyd port ${curiaConfig.attach.ttyd_port} could not be verified as curia's hardened ttyd — refusing to publish it; kill it and re-run reconcile`
        : `the attach identity proxy is not up on port ${curiaConfig.identity.proxy_port} — refusing to publish the terminal surface without its identity check; see the daemon log for the bind failure`)
    }
    // Resolved before the rule goes up, not before the verification: the proxy
    // refuses every caller until it knows which host names it answers to, so
    // publishing first would put a surface on the tailnet that 403s the
    // operator. A failure here throws without withdrawing — an unresolved proxy
    // is closed, not open, so nothing is exposed by leaving the rule alone.
    await ensureServeHosts()
    await assertServe({ servePort: curiaConfig.attach.serve_port, targetPort: curiaConfig.identity.proxy_port })
    const base = await attachBase()
    return attachSessionUrl(base, curiaConfig.attach.serve_port, session)
  },
  // The timeline half of /attach (#74): same liveness gate, then the surface
  // composes its own link — or refuses, independently of the terminal half.
  async timelineLink(ticket, { session = `curia-${ticket}` } = {}) {
    if (!validSessionName(session)) throw new Error(`"${session}" is not a valid curia session name`)
    if (!(await hasSession(session))) throw new Error(`no live session \`${session}\` — /status to see what runs`)
    // Same invariant the terminal half holds: never hand out a link to a
    // surface whose identity check does not yet know the names it serves, or
    // the operator opens it and gets a 403 from their own daemon.
    await ensureServeHosts()
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
    // #151: publishing the identity proxy under a preview rule would put the
    // terminal on a SECOND tailnet port whose Host is not in the proxy's own
    // allowlist — every caller refused, and the surface silently double-listed.
    curiaConfig.identity.proxy_port,
    curiaConfig.timeline.port, curiaConfig.timeline.serve_port,
  ],
  log,
  // #168: the identity check reaches the third surface. `identityAllow` is the
  // SAME set object the attach proxy and the timeline hold — the operator's
  // call that a preview is his alone, so one list serves all three. The proxy
  // block is derived from this base, and the registry does its own arithmetic.
  allow: identityAllow,
  proxyFrom: curiaConfig.identity.preview_proxy_from,
  journal: (type, detail) => store.logEvent(type, detail),
})
dispatcher.previews = previews // constructed after the dispatcher; teardown + sweep read it here

// The timeline surface (#74, landing #73's pick). In-process, so it can read
// the two things only the daemon has: which harness a session runs, and the
// durable escalation record — the claude harness's transcript is SILENT while an
// ask_human blocks (measured on #74), so open escalations are overlaid from
// the store or the surface shows a working agent as idle at the exact moment
// a human is needed.
const timeline = new TimelineSurface({
  port: curiaConfig.timeline.port,
  servePort: curiaConfig.timeline.serve_port,
  index: curiaConfig.timeline.index,
  workspaceRoot: curiaConfig.dispatch.workspace_root,
  log,
  deps: {
    journal: (type, detail) => store.logEvent(type, detail),
    harnessFor: (session) => dispatcher.agents.get(session)?.harness
      ?? detectHarness(path.join(curiaConfig.dispatch.workspace_root, 'cfg', session)),
    // The dialog guard's composer veto (#75): a visible ready marker (#39)
    // says the pane is at its composer, so a dialog-footer phrase in the tail
    // is scrollback, not a dialog.
    composerFor: (harness) => routingConfig.harnesses[harness]?.readyRe ?? null,
    escalationsFor: (session) => store.openEscalations().filter((r) => r.agent === session),
    escalationHistoryFor: (session) => store.escalationsForAgent(session),
    // The #151 identity check. The timeline is the daemon's own server, so it
    // carries the same predicate the terminal's proxy does, in-process.
    identityCheck: timelineIdentityCheck,
  },
})
dispatcher.timeline = timeline // reconcile asserts/withdraws its serve rule alongside attach's
dispatcher.identityProxy = identityProxy // #151: reconcile publishes the proxy, never ttyd itself

const router = new CommandRouter({ dispatcher, attach: attachApi, log })

// The overseer session host (#92): every effect goes through gate.command —
// the same seam the slash verbs and REST use — so it is journalled, logged and
// routed identically, and the tool surface is the containment boundary.
const overseer = new OverseerHost({
  store,
  dataDir: DATA,
  // ctx carries the thread the verb tool ran in (#93), so `start` binds it
  command: (text, ctx) => gate.command(text, 'overseer', ctx),
  log,
})

// ---- agent-facing MCP surface (#29 shape) ---------------------------------

// Outbound images (#34): an agent may publish files from its OWN worktree and
// the daemon's data dir, nothing else — the daemon holds a Discord token and a
// tailnet position, so an unbounded path here would turn `notify` into an
// exfiltration primitive for anything the box can read. An agent the dispatcher
// does not know (synthetic/lab callers, whose MCP URL the daemon did not write)
// falls back to the workspace root.
function outboundImages(agent, images) {
  if (!images?.length) return { files: [], refusals: [] }
  const known = dispatcher.agents.get(agent)
  const roots = [known?.wtPath ?? curiaConfig.dispatch.workspace_root, DATA]
  return resolveOutboundImages(images, { roots, cwd: known?.wtPath })
}

// Keep a blocked ask_human alive on the wire (#34).
//
// The block itself is sound — the daemon holds the response for as long as it
// takes. What killed real agents was the CLIENT: Claude Code aborts an MCP
// tool call after 300s of server silence (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT),
// so an escalation was dead ~25 minutes before the #11 re-nudge could ever
// fire. The fix belongs here rather than in a client env var: every harness
// curia has evaluated (Claude Code, Codex, Cline, pi via ACP shims) speaks MCP,
// and periodic traffic on the stream is the protocol's own answer to a long
// call. Progress notifications when the client offered a token, logging
// notifications otherwise — either way, bytes flow and no idle timer fires.
const KEEPALIVE_MS = Number(process.env.MCP_KEEPALIVE_MS ?? 60_000)

function startKeepAlive(extra, id, label = null) {
  const token = extra?._meta?.progressToken
  const startedAt = new Date().toISOString()
  let n = 0
  log(`keepalive for ${id}: ${token ? `progress notifications (token ${token})` : 'logging notifications (client offered no progressToken)'} every ${KEEPALIVE_MS / 1000}s`)
  const tick = () => {
    n += 1
    // #118 item 2: the progress line says WHAT it waits on, not just which id —
    // in the agent pane this line is all an onlooker sees while the call blocks.
    const what = `${id}${label ? ` — "${label}"` : ''} (${elapsedLabel(startedAt) ?? `${n}`})`
    const sent = token
      ? extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: n, message: `curia: still waiting for a human on ${what}` },
      })
      : extra.sendNotification({
        method: 'notifications/message',
        params: { level: 'info', logger: 'curia', data: `still waiting for a human on ${what}` },
      })
    Promise.resolve(sent).catch((e) => log(`keepalive for ${id} failed: ${e.message}`))
  }
  const timer = setInterval(tick, KEEPALIVE_MS)
  timer.unref()
  return () => clearInterval(timer)
}

function buildMcpServer(agent, ticket) {
  const server = new McpServer({ name: 'curia-daemon', version: '0.1.0' }, { capabilities: { logging: {} } })

  // The agent's speaker identity (#108 item 15): its own words post under
  // "curia-<n> · <ticket title>", so the prose no longer says "the agent".
  const speaker = () => speakerName(agent, dispatcher.agents.get(agent)?.title ?? '')

  // Queued operator notes ride the agent's NEXT tool result (#108 item 14):
  // every tool below appends the drain, so a note is never older than one
  // round-trip. A note tagged `after esc-N` is the follow-up the operator
  // typed just after answering that escalation.
  const drainNotes = () => store.takeAgentNotes(agent).map((n) => ({
    type: 'text',
    text: `[operator note${n.after ? `, after ${n.after}` : ''}] ${n.text}`,
  }))

  server.tool(
    'notify',
    'Fire-and-forget status update to the human. Returns immediately. `images`: local file paths inside your workspace to show the human (screenshots, renders).',
    { message: z.string(), images: z.array(z.string()).optional() },
    async ({ message, images }) => {
      const { files, refusals } = outboundImages(agent, images)
      store.logEvent('notify', { agent, ticket, message, images: files.map((f) => f.attachment), refusals })
      if (bridge) bridge.notify(ticket, `⚙️ ${message}`, { files, as: speaker() }).catch(() => {})
      return { content: [{ type: 'text', text: refusals.length ? `ok (${refusals.length} image(s) refused)\n${refusals.join('\n')}` : 'ok' }, ...drainNotes()] }
    },
  )

  // #40: the agent runs its dev server on localhost and asks the daemon to
  // publish it. The agent never picks the public port — see preview.mjs for
  // why that separation is the whole point of the registry.
  //
  // #68: it also names the PAGE. The port is the only thing the agent knew how
  // to say, so every composed link pointed at the site root; the path is where
  // the agent declares what it changed, once, in the same call.
  server.tool(
    'publish_preview',
    'Publish a dev server you have started as an HTTPS preview link the human can open from any device. Start the server FIRST, then call this with the port it bound and the path of the page you want looked at — without a path the link opens the site root, which is usually not what you changed. Call it again with a different path to move the link. Returns the URL; curia puts it in the review gate itself, so you never need to repeat it in your own text. The link is withdrawn automatically when this ticket finishes.',
    {
      dev_port: z.number().int(),
      path: z.string().optional().describe('The path of the page to review, e.g. "/curia-check" or "/blog/post?draft=1". Defaults to "/". A path on this dev server only — never a host or a scheme.'),
    },
    async ({ dev_port, path }) => {
      // #164: the cross-check reviewer publishes nothing. Its container has no
      // ports of its own, and a preview it did somehow raise would sit in the
      // review gate as if the builder had put it there.
      const refused = dispatcher.toolRefusal(agent, 'publish_preview')
      if (refused) return { content: [{ type: 'text', text: refused }, ...drainNotes()] }
      let base
      try {
        base = await attachBase()
      } catch (e) {
        return { content: [{ type: 'text', text: `preview unavailable: could not resolve this box's tailnet name (${e.message})` }] }
      }
      // #157: a sandboxed agent's three published ports are its whole reach
      // onto this box, so they are the bound `publish_preview` checks against.
      // A bare agent has none, and keeps the liveness probe until #158 retires
      // that path.
      const published = dispatcher.agents.get(agent)?.ports ?? null
      const r = await previews.publish(ticket, dev_port, { base, path, published })
      store.logEvent('preview', {
        agent, ticket, dev_port, path: r.path ?? path ?? null,
        ok: r.ok, url: r.url ?? null, reason: r.reason ?? null,
      })
      if (!r.ok) return { content: [{ type: 'text', text: `preview refused — ${r.reason}` }, ...drainNotes()] }
      // #108 item 22: the preview is a BUTTON, and every publish posts a fresh
      // message, so an updated preview lands at the thread bottom instead of a
      // scroll-back hunt. Bot voice on purpose: link buttons are components,
      // which the speaker webhook cannot carry — and the composed link is
      // curia's record, not the agent's prose.
      if (bridge) {
        bridge.notify(ticket, `🔗 \`${agent}\` ${r.reused ? 'updated the' : 'published a'} preview (dev server on :${dev_port})`, {
          links: [{ label: '🔗 open preview', url: r.url }],
        }).catch(() => {})
      }
      return { content: [{ type: 'text', text: r.url }, ...drainNotes()] }
    },
  )

  // #54 item 1: landing left report_result, because the pull request is now what
  // a human reviews BEFORE anything is resolved. The agent still never pushes —
  // it asks the daemon to, which is the #40/#41 containment boundary with its
  // timing changed and nothing else.
  server.tool(
    'open_pull_request',
    'Push the commits on your branch and open the pull request for this ticket — curia does the pushing, you never do. Call it once you have committed something, and again after later commits: it updates the same pull request. Returns the pull-request URL. Next step after this is request_review.',
    { summary: z.string().describe('What this change does, for the pull-request body.') },
    // keepalive: a push plus two gh round-trips is well inside the client's 300s
    // idle abort (#34), but "well inside" is not a guarantee on a big repo
    async ({ summary }, extra) => {
      const stopKeepAlive = startKeepAlive(extra, `${agent}/pr`)
      try {
        return { content: [{ type: 'text', text: await dispatcher.openPullRequest(agent, { summary }) }, ...drainNotes()] }
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
      summary: z.string().describe('What you did — under ten SHORT lines, plain words. The human reads this on a phone and judges the diff itself through the links, so say what changed and stop: no methodology, no justifications, no restating the ticket. Do not paste links: curia composes every one of them — pull request, preview, ticket — from its own records, and a link you write is not evidence.'),
      charting: z.string().describe('CONCRETE map changes you propose, as a numbered list — one line per change: ticket titles to create, fog lines to remove, edges to wire, anything to rule out of scope. Name each change; put full ticket bodies and long Decisions-so-far lines in the work you do AFTER approval, not here. Write "none" if there are none. A vague answer here makes the approval a rubber stamp.'),
    },
    async ({ summary, charting }, extra) => {
      const stopKeepAlive = startKeepAlive(extra, `${agent}/review`)
      try {
        const r = await dispatcher.requestReview(agent, { summary, charting })
        return { content: [{ type: 'text', text: r.text }, ...drainNotes()] }
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
      // #164: the reviewer asks nobody. ADR-0010 gives it one output — the
      // verdict — and a question in the ticket thread would put a second voice
      // in front of the operator on a ticket the reviewer is not building.
      const refused = dispatcher.toolRefusal(agent, 'ask_human')
      if (refused) return { content: [{ type: 'text', text: refused }] }
      const { files, refusals } = outboundImages(agent, images)
      const { record, answered } = openEscalation({ agent, ticket, ...payload, files })
      const stopKeepAlive = startKeepAlive(extra, record.id, promptTitle(payload.prompt))
      // Images the human replies with come back as real content blocks, so the
      // picture lands in this agent's context without a Read round-trip (#34).
      const { text, attachments } = await answered.finally(stopKeepAlive)
      const refusalNote = refusals.length ? [{ type: 'text', text: `(curia refused ${refusals.length} outbound image(s): ${refusals.join('; ')})` }] : []
      // drainNotes runs AFTER the answer resolves: a note typed right behind a
      // button press rides the answer itself — the grace window's best case.
      return { content: [...refusalNote, { type: 'text', text }, ...inboundContent(attachments), ...drainNotes()] }
    },
  )

  // #41: this call now also closes the TICKET, not just curia's dispatch
  // lifecycle. The agent has already run the resolve protocol itself; the
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
      // The BOUND ticket is this event's ticket, not `result.ticket` (#202).
      // The spread wrote the agent's own argument onto the journal line, and
      // every surface keyed on that field then followed the agent's spelling:
      // the status line reposted `resolving` under a thread named `owner/repo#164`,
      // and reconcile's "did this ticket see a result" scans read the wrong
      // number. The reported id is kept beside the bound one when the two
      // disagree, because the disagreement is a fact worth journalling — it is
      // just not a fact worth acting on.
      const reported = result.ticket == null ? null : String(result.ticket)
      const bound = ticket || reported
      const disagrees = reported !== null && reported !== bound
      const rec = store.logEvent('result', {
        agent, ...result, ticket: bound, ...(disagrees ? { reported_ticket: reported } : {}),
      })
      fs.writeFileSync(path.join(DATA, 'results', `${agent}.json`), JSON.stringify(rec, null, 2))
      // Route by that same bound ticket: an agent-supplied id may be
      // repo-qualified or a URL, which ensureThread would send to a stray named
      // thread instead of the ticket's bound thread (#103).
      if (bridge) bridge.notify(bound, `✅ reports **${result.status}**: ${result.summary}`, { as: speaker() }).catch(() => {})
      const stopKeepAlive = startKeepAlive(extra, `${agent}/result`)
      try {
        return { content: [{ type: 'text', text: await dispatcher.onResult(agent, result) }, ...drainNotes()] }
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
const listenerFor = (opts) => (req, res) => {
  handleRequest(req, res, opts).catch((e) => {
    log(`request ${req.method} ${req.url} failed: ${e.message}`)
    if (res.writableEnded) return
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  })
}

const httpServer = http.createServer(listenerFor({ fromContainer: false }))

// The same surface, reachable from inside an agent container (#156). A
// container's own loopback is the container, so the MCP side channel and the
// Stop hook cannot use 127.0.0.1 — they reach the box on the docker bridge
// gateway, which docker resolves for them as `host.docker.internal`.
//
// A SECOND listener rather than a wider bind: 0.0.0.0 would put /answer and
// /command on every interface this box has, including the tailnet, with no auth
// in front of either. The bridge address is reachable from containers and from
// this host, and from nothing else.
//
// Every container on the box can reach it, which is the `?agent=` spoofing
// hole #159 closes. It is not new — the bare pane could always reach the
// loopback port — but the container is where a real boundary now sits.
//
// #159 narrows this listener twice. It carries the AGENT surface and nothing
// else, so /command, /answer, /cancel and /reconcile are unreachable from any
// container (a container spoofing an agent was the stated hole; a container
// dispatching an agent of its own, or answering the operator's questions for
// them, is the larger one behind it). And the two routes it does carry demand
// the token the daemon minted for the agent they name.
//
// #188 makes the bind LAZY and repeatable rather than a one-shot at boot. The
// boot attempt stays, because the ordinary case should be up before anything
// asks — but a boot that cannot find the gateway no longer costs the daemon its
// side channel for its whole life. Every sandboxed dispatch calls this again,
// and a dispatch is the only thing that needs the answer.
//
// Idempotent by address: an unchanged gateway returns the listener already
// bound, and a gateway that MOVED (docker restarted onto a different bridge)
// closes the old one first. Leaving the old listener bound where no container
// looks is the failure this exists to end.
//
// SINGLE FLIGHT, because callers are now concurrent: max_concurrent dispatches
// can reach this together, and two of them binding the same address and port
// would give the second an EADDRINUSE — a refused dispatch on a side channel
// that is up, which is the wrong answer in the expensive direction.
let containerListener = null
let binding = null

function listenForContainers() {
  if (!binding) binding = bindContainerListener().finally(() => { binding = null })
  return binding
}

async function bindContainerListener() {
  if (!SANDBOXED_HARNESSES.length) return null
  const gateway = await dockerGateway()
  if (containerListener) {
    if (containerListener.address === gateway) return containerListener
    log(`the docker bridge gateway moved from ${containerListener.address} to ${gateway} — rebinding the container side channel`)
    const stale = containerListener
    containerListener = null
    await new Promise((resolve) => stale.server.close(resolve))
  }
  const server = await new Promise((resolve, reject) => {
    const srv = http.createServer(listenerFor({ fromContainer: true }))
    const onError = (e) => reject(e)
    srv.once('error', onError)
    srv.listen(PORT, gateway, () => {
      srv.removeListener('error', onError)
      // A runtime error after the bind must not reach an already-settled
      // promise, and must not be an uncaught exception either.
      srv.on('error', (e) => log(`the container side channel on ${gateway}:${PORT} errored: ${e.message}`))
      resolve(srv)
    })
  })
  containerListener = { server, address: gateway }
  log(`curia daemon also listening on http://${gateway}:${PORT} — the side channel for ${SANDBOXED_HARNESSES.join(', ')} containers`)
  return containerListener
}

// What a sandboxed dispatch must be able to say is true before it starts an
// agent (#188). Two halves, because the first one alone was not enough on the
// deployment box:
//
//   1. the daemon is listening where the containers look — bound here and now,
//      not at a boot that may have run before docker had a bridge;
//   2. a container can actually REACH it, proved by a container.
//
// It throws, and #prepareContainer lets that throw refuse the dispatch. A
// sandboxed agent with no side channel is worse than no agent: it burns a
// claim, edits a worktree, and cannot say one word about any of it.
async function assertSideChannel(image) {
  const bound = await listenForContainers()
  if (!bound) throw new Error('no harness runs in a container, so the daemon binds no side channel')
  await probeSideChannel({ image, port: PORT })
  return bound.address
}

async function handleRequest(req, res, { fromContainer = false } = {}) {
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
  // without this check any web page could dispatch a bypassPermissions agent
  // on an attacker-filed issue (POST /command with an explicit repo skips the
  // frontier gate) or reach `git worktree remove --force` via POST /reconcile.
  // Browsers always send Origin on cross-origin requests and stamp
  // Sec-Fetch-Site; loopback tooling (curl, the agent's Stop hook, the MCP
  // client) sends neither — so refuse any request that carries either marker
  // of a browser-mediated cross-site call.
  const site = req.headers['sec-fetch-site']
  if (req.headers.origin !== undefined || (site && site !== 'same-origin' && site !== 'none')) {
    return json(403, { error: 'cross-origin request refused — this surface is for loopback tooling, not browsers' })
  }

  // The reachability probe (#188). It answers before every gate below it that
  // could refuse a caller with no agent to be, because the question it asks is
  // only "did this request cross the bridge and land on curia" — a probe runs
  // before any agent exists, so it can carry no agent token. It reads nothing,
  // writes nothing, and journals nothing: a route that said more would be a
  // wider container surface than #159 left, for no gain.
  if (url.pathname === PROBE_PATH) {
    return json(200, { curia: PROBE_MARK, port: PORT })
  }

  // The container-facing listener is the agent surface and nothing more. A
  // refusal, not a 404: the route exists, this caller may not have it.
  if (fromContainer && !AGENT_ROUTES.has(url.pathname)) {
    store.logEvent('container_route_refused', { path: url.pathname, method: req.method })
    return json(403, { error: `${url.pathname} is not reachable from an agent container — this address carries the MCP side channel and the Stop hook only` })
  }

  // Who a request says it is, and its proof (#159). The name in `?agent=` used
  // to be the whole claim, so anything that could reach this port could report a
  // result for another agent, ask a question as it, or end its turn. Fails
  // closed: an unminted name, a missing header and a wrong one are one answer.
  //
  // An agent armed before this shipped carries no header, so the daemon restart
  // that adopts this change refuses its live agents. Take that one restart with
  // no agent live and it costs nothing; with one live, kill its pane and
  // `resume <n>`, which arms it again and mints its token.
  if (AGENT_ROUTES.has(url.pathname)) {
    const claimed = url.searchParams.get('agent') ?? 'unknown'
    if (!agentTokenMatches(DATA, claimed, req.headers[TOKEN_HEADER])) {
      store.logEvent('agent_token_refused', {
        agent: claimed,
        path: url.pathname,
        from: fromContainer ? 'container' : 'loopback',
        presented: Boolean(req.headers[TOKEN_HEADER]),
      })
      log(`refused ${url.pathname} claiming to be ${claimed} — ${req.headers[TOKEN_HEADER] ? 'the token does not match the one curia minted for it' : 'no agent token on the request'}`)
      return json(403, { error: `no valid curia agent token for "${claimed}" — the daemon mints one per agent at spawn and writes it into that agent's own connection settings` })
    }
  }

  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') return json(405, { error: 'stateless server: POST only' })
    const agent = url.searchParams.get('agent') ?? 'unknown'
    const ticket = url.searchParams.get('ticket') ?? 'unknown'
    // #194: the first request an agent makes on this route is the proof that it
    // has a tool channel at all. It is recorded here — after the #159 token gate
    // above, so only a request that proved whose it is counts — and before the
    // MCP server runs, so a call that fails inside the server still counts: the
    // question is whether the client reached the daemon, not what it asked for.
    dispatcher.onMcpCall(agent)
    const body = await readBody(req)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close() })
    const mcp = buildMcpServer(agent, ticket)
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
    const agent = body.agent ?? 'synthetic'
    // Same containment as the MCP path: /escalate is loopback-only, but it must
    // not be the softer way to hand the bridge an arbitrary file.
    const { files } = outboundImages(agent, body.images ?? body.files)
    const { record, answered } = openEscalation({
      agent, ticket: body.ticket ?? 'unknown',
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
    // Attachment paths get read and inlined into an agent's context, so they
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
  // notification that a turn ended: `{decision:"block", reason}` sends the agent
  // back with its outstanding checklist.
  //
  // Two phases on purpose. The decision is awaited, because the hook needs it on
  // the wire; the terminal work is NOT, because it kills the tmux session the
  // hook's own curl is running inside — awaiting it would kill the request before
  // the response left.
  //
  // Every failure here ALLOWS the stop. A daemon bug must never trap an agent in
  // a block loop.
  if (url.pathname === '/agent_done' && req.method === 'POST') {
    const body = await readBody(req)
    const agent = url.searchParams.get('agent') ?? 'unknown'
    const stopHookActive = Boolean(body.stop_hook_active)
    store.logEvent('agent_done', {
      agent,
      hook_event: body.hook_event_name,
      session_id: body.session_id,
      stop_hook_active: body.stop_hook_active,
    })
    let decision
    try {
      decision = await dispatcher.onStopHook(agent, { stopHookActive })
    } catch (e) {
      log(`onStopHook ${agent} failed (${e.message}) — allowing the stop`)
      decision = { allow: true, terminal: true }
    }
    if (decision?.decision === 'block') {
      return json(200, { decision: 'block', reason: decision.reason })
    }
    if (decision?.terminal) {
      dispatcher.onAgentDone(agent).catch((e) => log(`onAgentDone ${agent} failed:`, e.message))
    }
    // An EMPTY object, not `{ok:true}`. Both CLIs read "no decision" as allow,
    // but codex validates this body against a closed schema and rejected the
    // extra key outright — `Stop hook (failed): hook returned invalid stop hook
    // JSON output`, printed in the agent's own pane on every clean ending
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
  // The timeline listener and the #151 identity proxy bind before boot
  // reconcile so the reconcile's assert sees them up and publishes them — a
  // bind failure leaves that surface down and the assert withdraws instead
  // (never fatally: the daemon without an attach surface is still a daemon).
  //
  // The host sets resolve first, and a failure here is logged rather than
  // thrown: tailscale being down must not stop the daemon booting. Both
  // surfaces then refuse every caller until a later /attach retries the
  // resolution, which is the fail-closed direction.
  // A boot that cannot find the gateway is no longer a daemon that never binds
  // one (#188): every sandboxed dispatch calls listenForContainers again, and
  // refuses itself if the bind or the reachability probe fails. So this line is
  // a note about the boot rather than a warning about the rest of the run.
  listenForContainers()
    .catch((e) => log(`no container-facing listener at boot (${e.message}) — the next sandboxed dispatch binds it, and refuses itself if it cannot`))
    .then(() => resolveServeHosts())
    .catch((e) => log(`WARNING: could not resolve this box's tailnet names (${e.message}) — both attach surfaces refuse every caller until this succeeds`))
    .then(() => Promise.all([timeline.start(), identityProxy.start()]))
    // boot reconcile (#33): re-derive live agents from GitHub + tmux + journal,
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
  log(`recovered open escalation ${r.id} (${r.kind}) agent=${r.agent} ticket=${r.ticket}`)
  scheduleNudge(r)
}

// #56 bridge health. The outage clock lives HERE rather than on the bridge
// object, because a wedge recovery throws the bridge away and builds a new one —
// a per-instance clock would report a fresh instance as never having been down.
const BRIDGE_NOTICE_MS = Number(process.env.BRIDGE_NOTICE_MS ?? 30_000)
const BRIDGE_WEDGE_MS = Number(process.env.BRIDGE_WEDGE_MS ?? 5 * 60 * 1000)
let bridgeDownSince = null

// Startup announcement (#102): one small-print line in #curia per PROCESS, on
// the first successful bridge start. Under systemd Restart=, a crash loop
// prints one line per restart — visible where the operator already looks. A
// wedge-watchdog relaunch is the same process, so it stays silent here; the
// recovery notice above covers it.
let startAnnounced = false
const COMMIT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim()
  } catch {
    return 'unknown'
  }
})()

function announceStart(b) {
  if (startAnnounced) return
  startAnnounced = true
  const open = store.openEscalations().length
  const line = `-# curia started · ${COMMIT} · ${open} open escalation${open === 1 ? '' : 's'} recovered`
  b.announce(line).catch((e) => log(`startup announcement failed: ${e.message}`))
}

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
  const text = `⚠️ Discord bridge was down for ${Math.round(downMs / 1000)}s and is back. ${held}`
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
        dataDir: DATA,
        handlers: gate,
        // the journalled ticket↔thread map (#93) — the bridge holds no state
        bindings: {
          get: (ticket) => store.threadForTicket(ticket),
          bind: (ticket, threadId) => store.bindTicketThread(ticket, threadId),
          // #197: an explicit dispatch typed in another thread moves the ticket
          rebind: (ticket, threadId, reason) => store.rebindTicketThread(ticket, threadId, reason),
          release: (ticket, reason) => store.releaseTicketThread(ticket, reason),
          // the dispatch backstop (#140): the last binding, released or not
          last: (ticket) => store.lastThreadForTicket(ticket),
        },
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
        announceStart(b)
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

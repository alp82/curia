// Curia daemon (#31 + #33): durable escalation record + Discord bridge module,
// the agent-facing MCP surface proven in spike #29, and the dispatch loop.
//
//   POST /mcp?agent=<name>&ticket=<n>  — streamable-HTTP MCP (ask_human / notify / report_result)
//
// The two agent routes (/mcp, /agent_done) carry the per-agent token #159
// mints; the rest are the operator's own and never leave loopback.
//
//   GET  /state                          — open escalations
//   GET  /overview                       — the dashboard's whole read (#262)
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
import { EscalationStore, CONFIRM_KIND, noteDisposition } from './store.mjs'
import { DiscordBridge } from './bridge.mjs'
import { installCrashGuard } from './health.mjs'
import { readable } from './logline.mjs'
import { resolveOutboundImages, inboundContent } from './images.mjs'
import { PreviewRegistry } from './preview.mjs'
import { loadCuriaConfig, loadRoutingConfig, overrideSummary } from './config.mjs'
import { PROBE_MARK, PROBE_PATH, GUEST_DAEMON_HOST, dockerGateway, probeSideChannel } from './sandbox.mjs'
import { Cooling, providerOf } from './routing.mjs'
import { Dispatcher } from './dispatch.mjs'
import { REVIEW_KIND } from './lifecycle.mjs'
import { sameDigest } from './diffdigest.mjs'
import { CommandRouter } from './commands.mjs'
import { SelfDeploy } from './deploy.mjs'
import { OverseerClient, OverseerTurns, serveVerbMcp } from './overseerclient.mjs'
import { OVERSEER_MCP_PATH } from './overseerturn.mjs'
import { hasSession } from './tmux.mjs'
import { assertGhTokens, ghTokenKeyFor, agentGhToken } from './workspace.mjs'
import { APP_ID_KEY, APP_KEY_FILE_KEY, minterFrom } from './githubapp.mjs'
import {
  OVERSEER_ENV_FILE, overseerEnvPath, loadOverseerEnv, assertOverseerTokens,
  overseerGhToken, overseerTokenKeyFor, daemonOnlyKeys,
} from './overseertoken.mjs'
import { TOKEN_HEADER, AGENT_ROUTES, tokensDir, agentTokenMatches } from './agenttoken.mjs'
import { probeRepoToken, tokenExpiryDays, viewerLogin, ghJSONL } from './github.mjs'
import {
  probeTtyd, assertServe, serveOff, attachBase, attachSessionUrl, validSessionName,
  isConsoleKey, consoleKeyForSession, sessionForConsoleKey,
} from './attach.mjs'
import { probeOverseer } from './overseerservice.mjs'
import { LIVE_PATHS, DISPATCH_KEYS, liveSettings, liveDiff, frozenDifference } from './settings.mjs'
import { TimelineSurface } from './timeline.mjs'
import { IdentityProxy, identityRefusal, hostsForPorts, tailnetSelf } from './identity.mjs'
import { detectHarness } from './transcript.mjs'
import { promptTitle, elapsedLabel, speakerName } from './messaging.mjs'
import { StatusLine } from './statusline.mjs'
import { remainingRenderRetries } from './renderretry.mjs'
import { AccountUsage, ModelWindows, agentMeters, ctxOnWire, consoleConversationsOnWire } from './usage.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(DIR, '..')

// minimal env loader (daemon/.env.daemon, never committed)
//
// The name gained its suffix with #313, which gave the overseer container an env
// file of its own. Two files, one per container that holds secrets, and the pair
// reads as a pair: `.env.daemon` and `.env.overseer`.
//
// The old name is still loaded, and it says so. A box that has not been renamed
// yet keeps booting, and the line names the one move that silences it. In the
// container the rename is not optional — compose refuses a missing `env_file` —
// so this branch is for a dev box and for the moment between the rename and the
// deploy.
const envFile = path.join(ROOT, '.env.daemon')
const legacyEnvFile = path.join(ROOT, '.env')
const loadFrom = fs.existsSync(envFile) ? envFile : (fs.existsSync(legacyEnvFile) ? legacyEnvFile : null)
if (loadFrom) {
  for (const line of fs.readFileSync(loadFrom, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}
if (loadFrom === legacyEnvFile) log('WARNING: daemon/.env is the old name — rename it to daemon/.env.daemon, beside daemon/.env.overseer (#313)')

const PORT = Number(process.env.PORT ?? 4271)
// CURIA_DATA_DIR mirrors CURIA_CONFIG_DIR: the boot test points both at a
// fixture dir so a test run never writes into the real journal.
const DATA = process.env.CURIA_DATA_DIR ?? path.join(ROOT, 'data')
// The command channel. The bridge opens it; the dispatcher names it, because a
// confirm typed outside any thread renders there (#218).
const CHANNEL = process.env.CURIA_CHANNEL ?? 'curia'
fs.mkdirSync(path.join(DATA, 'results'), { recursive: true })
// Daemon-owned, never mounted into a container: one agent's token is unreadable
// by every other agent (#159).
fs.mkdirSync(tokensDir(DATA), { recursive: true, mode: 0o700 })

// dispatch-loop config (#33) — hand-edited YAML, validated on load; a bad
// shape refuses the boot rather than limping
const CONFIG_DIR = process.env.CURIA_CONFIG_DIR ?? path.join(ROOT, '..', 'config')
const CURIA_FILE = path.join(CONFIG_DIR, 'curia.yaml')
const ROUTING_FILE = path.join(CONFIG_DIR, 'routing.yaml')
const curiaConfig = loadCuriaConfig(CURIA_FILE)
const routingConfig = loadRoutingConfig(ROUTING_FILE)
// When the values this process RUNS were read off disk (#362). Boot sets it,
// and a reload that applies moves it. `GET /overview` stamps the six live
// settings with it, which is what lets the console say "applied" as a fact it
// measured rather than as a claim about a save that returned 200.
let configLoadedAt = new Date().toISOString()
// #292: the dashboard writes an override file beside each tracked one, and git
// does not track those. Said out loud at boot, because a config the operator
// reads in the repo is no longer the config this daemon runs, and nothing else
// on the box would tell them.
for (const name of ['curia.yaml', 'routing.yaml']) {
  const over = overrideSummary(path.join(CONFIG_DIR, name))
  if (over) log(`config: ${name} + ${path.basename(over.file)} (overrides: ${over.keys.join(', ') || 'none'})`)
}
// Every harness runs in a container since #195, so this is simply the harness
// list — it names the containers the side channel below serves. The cross-file
// check that used to live here went with the switch: `sandbox:` is now required
// in curia.yaml itself, so a daemon with no pins refuses at load.
const SANDBOXED_HARNESSES = Object.keys(routingConfig.harnesses)

// #155: the agent's own GitHub authority — one scoped fine-grained PAT per
// resource owner. Read at BOOT so a malformed value refuses the boot rather than
// reaching an agent as a 401 in the middle of a resolve, and said out loud per
// watched owner, because an owner with no token silently keeps the host's
// account-wide login and that is the thing this ticket exists to end. The daemon
// itself never uses these (see agentGhToken).
//
// Re-derived rather than fixed, because the watch list is reloadable (#362): a
// repo added live must get the same per-owner reading a booted one gets, or it
// looks watched here and fails at the first agent's first `gh` call.
let WATCHED_OWNERS = new Set(curiaConfig.watch.map((w) => w.repo.split('/')[0]))
for (const { key, token } of assertGhTokens()) log(`agent GitHub token ${key} (…${token.slice(-4)})`)

// #313: the overseer's own GitHub authority — the same shape one prefix over,
// READ-ONLY, and in a second env file. The overseer container loads that file
// whole, so what is in it is what a shell in that container holds. The daemon
// only reads it, and never into `process.env`: a bare token there would
// re-authenticate the daemon's own `gh`.
const overseerEnv = loadOverseerEnv(overseerEnvPath(ROOT))
for (const key of daemonOnlyKeys(overseerEnv)) {
  log(`WARNING: ${key} is in daemon/${OVERSEER_ENV_FILE} — that file is the overseer's read-only boundary, and its container gets every key in it`)
}
for (const { key, token } of assertOverseerTokens(overseerEnv)) log(`overseer GitHub token ${key} (…${token.slice(-4)})`)
// #327: the model credential rides the same file. ADR-0014 lets exactly one
// host secret into that container, and this is it — `.env.daemon` is the file
// the overseer service must never load, so the value cannot come from there.
// Stated rather than warned: the container says it louder at its own start, and
// until #314 carries the turn nothing in there runs a model anyway.
log(overseerEnv.CLAUDE_CODE_OAUTH_TOKEN || overseerEnv.ANTHROPIC_API_KEY
  ? `overseer model credential present in daemon/${OVERSEER_ENV_FILE}`
  : `overseer model credential absent from daemon/${OVERSEER_ENV_FILE} — the container can run no turn without one`)

// And the same tokens against GitHub itself, once per watched repo. A token's
// repository list lives on GitHub rather than in an env file, so nothing local
// can tell that a newly watched repo was left off it. Detached from the boot
// chain on purpose: this is one network round-trip per repo, and GitHub being
// slow or down must never hold up a daemon whose other duties do not need it.
// See probeRepoToken for the one case it cannot see.
//
// One pass per holder. The overseer's token is the one whose expiry is a
// certainty rather than a risk — an org caps its lifetime — so the same warning
// has to speak for both.
const TOKEN_EXPIRY_WARN_DAYS = 14
function probeWatchedTokens({ holder, tokenFor, keyFor, refusal }) {
  Promise.all(curiaConfig.watch.map(async ({ repo }) => {
    const token = tokenFor(repo)
    if (!token) return
    const key = keyFor(repo)
    try {
      const { ok, message, expiresAt } = await probeRepoToken(repo, token)
      if (!ok) {
        log(`WARNING: ${key} cannot reach ${repo} (${message}) — ${refusal}`)
        return
      }
      const days = tokenExpiryDays(expiresAt)
      if (days === null) return
      if (days <= TOKEN_EXPIRY_WARN_DAYS) log(`WARNING: ${key} expires in ${days} day(s), on ${expiresAt} — mint a new one before it dies`)
      else log(`${key} reaches ${repo}, expires in ${days} days`)
    } catch (e) {
      // A network failure is a fact about the network, not about the token.
      log(`could not check the ${holder} token for ${repo} (${e.message}) — not treating that as a bad token`)
    }
  })).catch(() => {})
}
// Everything the boot says about the credentials behind the WATCH LIST, in one
// function, because a reload runs it again (#362). A repo added from the
// settings screen gets the same per-owner warning and the same GitHub probe a
// booted one gets — without this, a live add looks watched and the failure
// arrives as a 401 in the middle of the first agent's first `gh` call.
function checkWatchedCredentials() {
  WATCHED_OWNERS = new Set(curiaConfig.watch.map((w) => w.repo.split('/')[0]))
  for (const owner of WATCHED_OWNERS) {
    const key = ghTokenKeyFor(owner)
    if (!agentGhToken(`${owner}/x`)) log(`WARNING: no ${key} — agents on ${owner}/* inherit the host gh login (account-wide)`)
    const overseerKey = overseerTokenKeyFor(owner)
    if (!overseerGhToken(`${owner}/x`, overseerEnv)) log(`WARNING: no ${overseerKey} — the overseer holds no credential for ${owner}/*`)
  }
  probeWatchedTokens({
    holder: 'agent',
    tokenFor: (repo) => agentGhToken(repo),
    keyFor: ghTokenKeyFor,
    refusal: 'an agent on it will fail at its first gh call',
  })
  probeWatchedTokens({
    holder: 'overseer',
    tokenFor: (repo) => overseerGhToken(repo, overseerEnv),
    keyFor: overseerTokenKeyFor,
    refusal: 'the overseer cannot read it',
  })
}
checkWatchedCredentials()

// #352, building ADR-0018: the GitHub App that replaces every token above. It
// SWAPS NO HOLDER YET — each one cuts over on its own ticket, and no PAT comes
// out ahead of its replacement. So what the boot does here is prove the
// operator's checklist worked and say so out loud.
//
// A HALF-configured app refuses the boot inside minterFrom, because an app id
// with no key is a typo, and a typo that boots reaches a dispatch as a 401
// nobody can place. NO app is a different thing and stays legal: the tokens
// above are still the live credential.
const appMinter = minterFrom({ daemonRoot: ROOT, log })
if (!appMinter) {
  log(`no GitHub App configured — set ${APP_ID_KEY} and ${APP_KEY_FILE_KEY} in daemon/.env.daemon (docs/github-app.md)`)
} else {
  log(`GitHub App ${appMinter.appId}, key at ${appMinter.keyFile}`)
  // Detached, for the same reason the token probes above are: this is a network
  // round trip, and GitHub being slow must never hold up a boot whose other
  // duties do not need it.
  appMinter.installations().then((installs) => {
    for (const { id, owner } of installs) log(`GitHub App installed on ${owner} (installation ${id})`)
    const seen = new Set(installs.map((i) => String(i.owner ?? '').toLowerCase()))
    for (const owner of WATCHED_OWNERS) {
      if (!seen.has(owner.toLowerCase())) log(`WARNING: the GitHub App is not installed on ${owner} — install it there before that owner's holders cut over (docs/github-app.md)`)
    }
  }).catch((e) => log(`could not read the GitHub App's installations (${e.message}) — no holder mints yet, so nothing is broken by it`))
}

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

// Same harness resolution the timeline uses: the dispatcher's word on what it
// spawned, on-disk evidence for re-adopted and lab sessions.
const cfgDirFor = (session) => path.join(curiaConfig.dispatch.workspace_root, 'cfg', session)
const harnessFor = (session) => dispatcher?.agents.get(session)?.harness ?? detectHarness(cfgDirFor(session))

// Everything the status line says about one agent beyond its state. Named
// rather than inlined because `GET /overview` reads the same meters for the
// dashboard's provider strip (#262), and one agent must not be measured two
// ways on two surfaces.
//
// The routing label takes the same route (#187). The status line only learns
// it from a spawn event, so a line first drawn after a restart carries none —
// and the effort meter reads off the label's routing row. The dispatcher's
// record answers instead, which reconcile now rebuilds from the journal.
const metersFor = (session, model) => agentMeters({
  harness: harnessFor(session),
  cfgDir: cfgDirFor(session),
  model: model ?? dispatcher?.agents.get(session)?.model ?? null,
  routing: routingConfig,
  account: accountUsage,
  models: modelWindows,
})

const statusLine = new StatusLine({
  post: (ticket, text) => (bridge ? bridge.postStatus(ticket, text) : null),
  edit: (ids, text) => (bridge ? bridge.editStatus(ids, text) : false),
  remove: (ids) => (bridge ? bridge.deleteStatus(ids) : null),
  // The thread-name state glyph (#199): the status line derives the state,
  // the bridge renders it. With the bridge down the flag is dropped — the
  // next transition retries, and the name is display only.
  flag: (ticket, state) => (bridge ? bridge.flagTicket(ticket, state) : null),
  get: (id) => store.get(id),
  log,
  meters: metersFor,
})
statusLine.start()
store.onEvent = (ev) => statusLine.onEvent(ev)
const pending = new Map() // escalation id -> resolve(answerText) — ephemeral, dies with the process
const renderRetries = new Map() // escalation id -> timeout handles — ephemeral, rebuilt on boot

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

// #261: every open escalation arms its own bounded render retry — 1m, 5m and
// 15m after it opened, then never again. A retry that finds the record rendered
// (the usual case), closed, or gone does nothing, so the schedule costs an
// escalation whose first render worked exactly three no-ops.
function armRenderRetries(record) {
  if (renderRetries.has(record.id)) return
  const delays = remainingRenderRetries(record.opened_at, Date.now())
  if (!delays.length) return
  const timers = new Set()
  renderRetries.set(record.id, timers)
  for (const ms of delays) {
    const t = setTimeout(() => {
      timers.delete(t)
      if (!timers.size) renderRetries.delete(record.id)
      const r = store.get(record.id)
      // rendered, answered or superseded in the meantime — nothing to retry
      if (!r || r.status !== 'open' || r.discord) return clearRenderRetries(record.id)
      renderEscalation(r)
    }, ms)
    t.unref()
    timers.add(t)
  }
}

function clearRenderRetries(id) {
  for (const t of renderRetries.get(id) ?? []) clearTimeout(t)
  renderRetries.delete(id)
}

async function renderEscalation(record, files = []) {
  if (!bridge) return
  try {
    const discord = await bridge.renderEscalation(record, { files })
    store.attachRender(record.id, discord)
    clearRenderRetries(record.id)
  } catch (e) {
    // record stays open + REST-answerable; the armed retries try again (#261)
    store.logEvent('bridge_render_failed', { id: record.id, error: e.message })
    log(`render failed for ${record.id}: ${e.message}`)
  }
}

// Open + render + block until answered. Every ask_human and synthetic escalation
// funnels through here.
function openEscalation({ agent, ticket, kind, prompt, options, preview_url, recommended, files, diff, diff_error }) {
  const { record, superseded_all } = store.open({ agent, ticket, kind, prompt, options, preview_url, recommended, diff, diff_error })
  log(`escalation ${record.id} open (${kind}) agent=${agent} ticket=${ticket}${superseded_all.length ? ` supersedes ${superseded_all.map((r) => r.id).join(', ')}` : ''}`)
  // Every corpse this agent left, not just the newest (#336): a card left
  // rendered keeps asking a question nothing can receive an answer for.
  for (const dead of superseded_all) {
    pending.delete(dead.id) // the agent aborted that call; nobody is waiting on it
    clearRenderRetries(dead.id)
    if (bridge) bridge.markSuperseded(store.get(dead.id)).catch(() => {})
  }
  armRenderRetries(record)
  renderEscalation(record, files)
  const answered = new Promise((resolve) => pending.set(record.id, resolve))
  return { record, answered }
}

// Resolves with { text, attachments } — the answer's images travel with it all
// the way to the agent's tool result (#34). Returns whether a resolver was
// actually waiting: false means the blocked call died with a previous daemon
// process, and the answer needs the #139 hand-off instead.
function settle(record, text, attachments = []) {
  clearRenderRetries(record.id)
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
  // #241: a chat handle is resumable too — `resume chat-1` re-dispatches it and
  // it drains the queue on its first tool result, exactly as a numbered one
  // does. Only synthetic and lab callers are excluded here.
  if (!/^curia-(\d+|chat-\d+)$/.test(record.agent)) return
  store.queueRecordedAnswer(record)
  const live = dispatcher.agents.has(record.agent)
  notifyThread(record.ticket, live
    ? `✅ recorded — \`${record.agent}\` gets this answer with its next tool result`
    : `✅ recorded — \`${record.agent}\` is not running; \`resume ${record.ticket}\` hands it over`)
  log(`escalation ${record.id} answered with no live receiver — hand-off note queued for ${record.agent}`)
}

// #369: the one line that tells an agent its answer is a recorded one.
//
// The agent has to know. It re-asked because its own call died, and without
// this line it reads the answer as a fresh reply to the exact wording it sent
// this time — including the "(Re-sent: the last call timed out…)" note the
// standing orders make it add. So the line names the record, the person and the
// moment, which are the three facts that make it evidence rather than a claim.
function recordedAnswerLine(record) {
  const by = record.answered_by ? ` by ${record.answered_by}` : ''
  return `[recorded answer — a human answered this exact question${by} at ${record.closed_at}, on ${record.id},`
    + ' while no call of yours was live. Curia opened no second card and asked nobody again.]'
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
      if (bridge) bridge.markAnswered(result.record, { routedFrom: result.routed_from ?? [] }).catch(() => {})
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
  // #92: the bridge's overseer surface hands each operator message here. Since
  // the cutover (#315) the turn runs in the overseer CONTAINER — the daemon
  // posts the message, streams the events back, and speaks through `io.say`.
  overseerTurn: (threadId, prompt, io) => overseerContainer.runTurn(threadId, prompt, io),
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
    // the ticket rides along so the bridge can spell out `cancel <n>` when the
    // note is command-shaped (#108 item 23, #170)
    const ticket = store.ticketForThread(threadId) ?? null
    const queued = gate.queueNoteFor(agent, text, { by, ticket })
    if (!queued.reads) return { agent, after: null, reads: false, ticket }
    const { id, after } = queued
    // #236: the facts a status question needs, gathered from records the
    // daemon already holds — the status line's state machine, the dispatch
    // record's spawn time, the journal's last word about the agent. The bridge
    // composes the direct answer from these (statusAnswer) when the note is
    // question-shaped; a missing fact drops that fact there, never the reply.
    const live = dispatcher.agents.get(agent)
    const sl = statusLine.stateOf(agent)
    // A restart empties the status line's memory; the dispatch record still
    // says whether the agent reached its composer.
    const state = sl?.state ?? (live?.state === 'spawning' ? 'dispatched' : live ? 'working' : null)
    const status = state ? {
      state,
      spawned_at: live?.spawnedAt ? new Date(live.spawnedAt).toISOString() : null,
      esc: sl?.detail?.esc ?? null,
      last: store.lastAgentEvent(agent),
    } : null
    // `id` is what the interrupt button under this receipt points at (#252):
    // queued is the default mode, and the button is how the operator picks the
    // other one for these exact words.
    return { agent, id, after, reads: true, ticket, status }
  },
  // The queue itself, under both keyings (#266). Discord names the THREAD the
  // words were typed in; the console has no thread and names the agent. The
  // queue, the #208 instance rule and the refusal are one fact either way, so
  // they are written once here rather than twice at the two doors.
  //
  // `reads` is what the bridge promises the operator (#170), and #208 makes it
  // the same flag that decides whether anything queues at all.
  queueNoteFor(agent, text, { by = null, ticket = null } = {}) {
    const { reads, instance } = noteDisposition(dispatcher.agents.get(agent))
    if (!reads) {
      log(`agent note refused for ${agent} — that agent is not running, so nothing was queued`)
      store.logEvent('agent_note_refused', { agent, ticket, by, reason: 'agent not running' })
      return { agent, ticket, reads: false, id: null, after: null }
    }
    const { id, after } = store.queueAgentNote(agent, String(text).trim(), { by, instance })
    log(`agent note queued for ${agent}${after ? ` (after ${after})` : ''}`)
    return { agent, ticket, reads: true, id, after }
  },
  // The console's note (#266), and BOTH delivery modes behind one call. The
  // browser has no thread to type in, so it names the agent — but what happens
  // to the words after that is ADR-0013 unchanged: queued is the default and
  // rides the next tool result, and an interrupt is #252's second mode, with
  // the same grace and the same three refusals.
  //
  // An interrupt that refuses leaves the words QUEUED rather than dropping
  // them. The operator asked for these words to reach the agent; the mode was
  // how fast, and only the mode failed.
  async noteAgent(agent, text, { by = null, mode = 'queue' } = {}) {
    const live = dispatcher.agents.get(agent)
    // The record is read here for the TICKET only. The console names the agent,
    // so it can name one curia is not running — which the thread path never
    // could, because a thread only ever resolves to a live agent. That is the
    // same refusal as a failed agent, so `noteDisposition` gives it (#299) and
    // this door does not check existence a second time.
    const ticket = live?.ticket ?? String(agent).replace(/^curia-/, '')
    const queued = gate.queueNoteFor(agent, text, { by, ticket })
    // The console's own way back, which is not the thread's: the browser has
    // cleared the box, so the words have to be typed again after the resume.
    if (!queued.reads) {
      return {
        ...queued, ok: false, mode,
        why: `curia is not running \`${agent}\`, so nothing was queued — \`resume ${ticket}\` puts an agent back on the ticket, then say the words again`,
      }
    }
    if (mode !== 'interrupt') return { ...queued, ok: true, mode: 'queue' }
    const out = await dispatcher.interruptNote(queued.id, { by })
    return { ...queued, ...out, mode: 'interrupt', still_queued: !out.ok }
  },
  // #252, ADR-0013: the second delivery mode. The bridge presses this from the
  // button under a receipt; the dispatcher owns the grace and the keystrokes.
  interruptNote: (id, by) => dispatcher.interruptNote(id, { by }),
}

// ---- dispatch loop (#33) ----------------------------------------------------

function notifyThread(ticket, message, opts = {}) {
  if (bridge) bridge.notify(ticket, message, opts).catch((e) => log(`notify ticket-${ticket} failed:`, e.message))
  else log(`[notify ticket-${ticket}] ${message}`)
}

// Button confirms (#94, per #89): the interpreted cancel path opens a
// `confirm` escalation — rendered with ✅/❌ through the same machinery as
// every other escalation, journalled, answerable after a bridge outage — and
// NOTHING waits on it: no resolver, no reminder, no TTL. The executing path is
// button → gate.answer → dispatcher.onConfirmAnswered, and the record lapses
// the moment its agent exits.
function openConfirm({ ticket, prompt, action, originThreadId }) {
  const { record, superseded_all } = store.open({
    agent: 'overseer', ticket, kind: CONFIRM_KIND, prompt, action, origin_thread_id: originThreadId ?? null,
  })
  log(`confirm ${record.id} open (${action.verb}) ticket=${ticket}${superseded_all.length ? ` supersedes ${superseded_all.map((r) => r.id).join(', ')}` : ''}`)
  for (const dead of superseded_all) {
    clearRenderRetries(dead.id)
    if (bridge) bridge.markSuperseded(store.get(dead.id)).catch(() => {})
  }
  // A confirm has no reminder and no expiry, but it still has to be SEEN: a
  // confirm that never rendered carries buttons nobody can press, so it takes
  // the same bounded render retry every other escalation takes (#261).
  armRenderRetries(record)
  renderEscalation(record)
  return record
}

function lapseEscalation(id, reason) {
  const r = store.lapse(id, reason)
  if (r.ok) {
    clearRenderRetries(id)
    log(`confirm ${id} lapsed (${reason})`)
    if (bridge) bridge.markLapsed(store.get(id)).catch(() => {})
  }
  return r
}

// The review gate (#54 item 2). The same escalation machinery every ask_human
// uses — so first-valid-wins, the bounded render retry, Discord buttons, thread-reply
// capture and restart survival all come free — under its own kind, which is what
// makes an approval a fact the daemon can check (`/status`, the Stop hook) rather
// than a string in a prompt. Unlike overseerConfirm there is NO ttl: #11's
// indefinite block is the whole promise, and a review that expired under a human
// who was merely asleep would drop the work on the floor.
// The digest (#355) rides in as data on the record, not as words in the prompt.
// The prompt already carries its one Discord line; what the record carries is
// the whole per-file list, which is what lets `GET /overview` hand the console
// a gate card that costs no extra read.
function askReview(agent, ticket, promptText, { diff = null, diffError = null } = {}) {
  // #369 at the gate, where the wait costs most. The same rule as `ask_human`
  // plus one guard: the code has to be the code the operator approved. The
  // digest is already measured for this very call (#355), so the check is a
  // comparison rather than a second read — and an unmeasured gate never
  // replays, because `sameDigest` refuses two nulls.
  const recorded = store.recordedAnswerFor({ agent, kind: REVIEW_KIND, prompt: promptText })
  if (recorded && sameDigest(recorded.record.diff, diff)) {
    store.takeRecordedAnswer(recorded.record, recorded.note)
    log(`review gate ${recorded.record.id} replayed to ${agent} — the same summary over the same diff, answered already`)
    return Promise.resolve({ text: recorded.record.answer, status: 'answered', recorded: recordedAnswerLine(recorded.record) })
  }
  const { record, answered } = openEscalation({
    agent, ticket, kind: REVIEW_KIND, prompt: promptText, diff, diff_error: diffError,
  })
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
  // #241: a new-map session's thread takes the map's name the moment the agent
  // creates the map. The binding stays on the chat handle for the rest of the
  // session (#326), and the map's claim on the thread is the dispatcher's own
  // journalled `map_adopted` line, written before this call. So with the
  // bridge down there is nothing to do here: only the rename is display, and
  // only the rename is lost.
  async adoptMap(handle, mapNumber, opts) {
    if (bridge) return bridge.adoptMapThread(handle, mapNumber, opts)
    const threadId = store.threadForTicket(handle)
    return threadId ? { ok: true, threadId } : { ok: false, reason: 'unbound' }
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
  // drained into the next prompt by the overseer client
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
  channelName: CHANNEL,
  deps: {
    // #188: the container-facing listener is this file's, so the check that a
    // sandboxed dispatch can rely on it is this file's too. It binds lazily,
    // and it proves the path with a container.
    assertSideChannel,
  },
})

// Expiry always announces (#252, ADR-0013). The hook is set HERE, once, on the
// one call every expiry path runs through — an exit, an adoption, the drain's
// own sweep — so no future path can lose a note in silence the way #223 lost a
// whole cross-check verdict.
store.onNotesExpired = (ev) => dispatcher.announceExpiredNotes(ev)

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
  for (const [set, ports] of [
    [attachHosts, [curiaConfig.attach.serve_port]],
    // TWO ports for the timeline (#267): its own, and the console's. The chat
    // is this surface, served under the sidecar's address, so those requests
    // arrive here carrying the console's Host. The alternative was for the
    // sidecar to REWRITE Host on the way through, which would have made a proxy
    // the author of the very evidence this check reads.
    [timelineHosts, [curiaConfig.timeline.serve_port, curiaConfig.dashboard.serve_port]],
  ]) {
    set.clear()
    for (const h of hostsForPorts(self, ports)) set.add(h)
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
    // Same rule as reconcile's #assertAttachSurface: publish only over a live,
    // agreed surface (#260: compose runs ttyd; the daemon health-checks it).
    // The #151 identity proxy is what the serve rule points at, so a proxy that
    // is not up is exactly as disqualifying as a dead ttyd — publishing ttyd
    // directly would hand the tailnet the un-gated terminal this ticket closed.
    const { verified } = identityProxy.listening
      ? await probeTtyd({ ttydPort: curiaConfig.attach.ttyd_port, index: curiaConfig.attach.index, log })
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
        log(`attach: the ttyd surface on port ${curiaConfig.attach.ttyd_port} is not publishable — serve rule for :${curiaConfig.attach.serve_port} withdrawn`)
      } catch (e) {
        log(`WARNING: the ttyd surface on port ${curiaConfig.attach.ttyd_port} is not publishable and withdrawing the serve rule failed (${e.message}) — if a rule for :${curiaConfig.attach.serve_port} exists, a dead or unagreed surface REMAINS PUBLISHED tailnet-wide; run \`tailscale serve --https=${curiaConfig.attach.serve_port} off\` by hand`)
      }
      throw new Error(identityProxy.listening
        ? `the attach surface on ttyd port ${curiaConfig.attach.ttyd_port} is down or stale — is the compose ttyd service up? see the daemon log`
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
    // #263: the sidecar's two ports. The daemon binds neither, but it owns the
    // preview sweep — publishing a preview over the dashboard's Serve port
    // would withdraw the console the operator watches the box through, and
    // over its loopback port would put a second, un-gated rule in front of it.
    curiaConfig.dashboard.port, curiaConfig.dashboard.serve_port,
    // #327: the overseer container's published port. The daemon binds it no
    // more than it binds the sidecar's — but publishing a preview over it would
    // put the one way into that container on the tailnet, which is the whole
    // thing its bridge network keeps off there.
    curiaConfig.overseer.port,
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
    // The console chat (#267): one session on this surface is not a pane. It is
    // a browser conversation of the overseer, and a message to it is a turn
    // rather than a keystroke. Since the cutover (#315) the turn runs in the
    // overseer CONTAINER; the transcript reaches this surface because the
    // container's config dir mounts at the same host path the daemon reads.
    // `overseerContainer` is const below and read at request time, never at
    // construction.
    //
    // #332: the conversation's live session id rides along, read from the
    // journal on every call. It is what names the transcript file — the
    // overseer's config dir holds every conversation's, Discord's included, so
    // the newest one there belongs to whoever answered last.
    //
    // #333: `curia-console-<n>` is many sessions, not one, and EVERY one of
    // them is a driver — including a key with no conversation behind it. A
    // deleted or never-minted key must not fall through to the pane path, or
    // the surface would ask tmux about a session that does not exist and the
    // operator would read a tmux error about their own deleted chat. It reads
    // as an empty conversation, and `send` says what happened.
    driverFor: (session) => {
      const key = consoleKeyForSession(session)
      if (!key) return null
      return {
        cfgDir: overseerContainer.configDir,
        sessionId: store.overseerSession(key) ?? null,
        send: (text) => overseerContainer.browserTurn(key, text),
      }
    },
  },
})
dispatcher.timeline = timeline // reconcile asserts/withdraws its serve rule alongside attach's
dispatcher.identityProxy = identityProxy // #151: reconcile publishes the proxy, never ttyd itself

// The self-deploy seam (#270): the verb orders, a sibling container executes,
// resolvePending() below announces whichever outcome the sibling wrote.
const selfDeploy = new SelfDeploy({ repoRoot: path.dirname(ROOT), dataDir: DATA, store, log, port: PORT })

const router = new CommandRouter({ dispatcher, attach: attachApi, deploy: selfDeploy, log })

// The overseer CONTAINER's turn (#314, cut over by #315): the daemon posts the
// operator's message to the container and serves the verbs back to it over
// `/overseer/mcp`, so every effect crosses the same `gate.command` seam the
// slash verbs and REST use — journalled, logged and routed identically.
//
// This is the ONLY brain. The in-daemon host (#92) is gone: both doors — the
// bridge's `overseerTurn` and the Chat screen's `driverFor` — route here, and
// the container boundary of ADR-0014 replaced the tool-surface boundary the
// in-process host lived behind.
const overseerTurns = new OverseerTurns()
const overseerContainer = new OverseerClient({
  store,
  command: (text, ctx) => gate.command(text, 'overseer', ctx),
  workspaceRoot: curiaConfig.dispatch.workspace_root,
  port: curiaConfig.overseer.port,
  daemonPort: PORT,
  daemonHost: GUEST_DAEMON_HOST,
  turns: overseerTurns,
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
// so an escalation was dead ~25 minutes before the ~30-minute re-nudge of the
// day (#11, removed in #261) could ever fire. The fix belongs here rather than
// in a client env var: every harness curia has evaluated (Claude Code, Codex,
// Cline, pi via ACP shims) speaks MCP,
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

  // The agent's speaker identity (#108 item 15, narrowed by #254): its own
  // words post under its session name, so the prose no longer says "the
  // agent". The name alone — the ticket title used to ride here and truncate.
  // It is a constant now, where it used to read the live title per send.
  const speaker = speakerName(agent)

  // Queued operator notes ride the agent's NEXT tool result (#108 item 14):
  // every tool below appends the drain, so a note is never older than one
  // round-trip. A note tagged `after esc-N` is the follow-up the operator
  // typed just after answering that escalation.
  //
  // The instance is read LIVE, never captured here: this server is built once
  // per session and #208 makes the queue instance-addressed, so a note stamped
  // for a predecessor must not ride out on a successor's tool result.
  //
  // The label says WHO the words are from (#165). Every note an operator typed
  // is an operator note; the cross-check verdict rides the same queue under its
  // own name, because a verdict read as the operator's word would be obeyed
  // instead of judged.
  const drainNotes = () => store.takeAgentNotes(agent, dispatcher.agents.get(agent)?.instance ?? null).map((n) => ({
    type: 'text',
    text: `[${n.label ?? 'operator note'}${n.after ? `, after ${n.after}` : ''}] ${n.text}`,
  }))

  server.tool(
    'notify',
    'Fire-and-forget status update to the human. Returns immediately. `images`: local file paths inside your workspace to show the human (screenshots, renders).',
    { message: z.string(), images: z.array(z.string()).optional() },
    async ({ message, images }) => {
      const { files, refusals } = outboundImages(agent, images)
      store.logEvent('notify', { agent, ticket, message, images: files.map((f) => f.attachment), refusals })
      if (bridge) bridge.notify(ticket, `⚙️ ${message}`, { files, as: speaker }).catch(() => {})
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
      // #239: publish probed the page, and a status that is not a 2xx is worth
      // a sentence — the link works, but the page the agent named answered 404
      // or 500, and the agent is the one who can fix that before the human
      // opens it. Not a refusal: apps legitimately 302 or 401 their own pages.
      const note = Number.isInteger(r.probeStatus) && (r.probeStatus < 200 || r.probeStatus > 299)
        ? `\n(note: this page answered HTTP ${r.probeStatus} — if that is not what you expect, fix the page or the path and publish again)`
        : ''
      return { content: [{ type: 'text', text: `${r.url}${note}` }, ...drainNotes()] }
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
    'Escalate a question to the human and BLOCK until an answer arrives. kind: free-text | choice | approve-reject | preview-review. A ROUND of questions is one free-text call: number them, give each your recommended answer, and set `recommended` so the card carries the ✅ All as recommended button.',
    {
      prompt: z.string(),
      kind: z.enum(['free-text', 'choice', 'approve-reject', 'preview-review']),
      options: z.array(z.string()).optional(),
      preview_url: z.string().optional(),
      // #285, ADR-0005: the round's one-tap path. Set it only when EVERY
      // question in the prompt carries a recommended answer — the button says
      // "all", and it is a lie about any question that had no recommendation.
      // free-text only: the other three kinds already answer with a button.
      recommended: z.boolean().optional(),
      images: z.array(z.string()).optional(),
    },
    async ({ images, ...payload }, extra) => {
      // #164: the reviewer asks nobody. ADR-0010 gives it one output — the
      // verdict — and a question in the ticket thread would put a second voice
      // in front of the operator on a ticket the reviewer is not building.
      const refused = dispatcher.toolRefusal(agent, 'ask_human')
      if (refused) return { content: [{ type: 'text', text: refused }] }
      // #165, ADR-0010: the FIRST question after a cross-check verdict is the
      // builder's judgement of it, and it lands as a second pull-request comment
      // under the verdict. Fire-and-forget on purpose — a gh round-trip must not
      // sit between the agent and the human it is asking.
      dispatcher.noteJudgement(agent, payload.prompt)
        .catch((e) => log(`judgement comment for ${agent} failed: ${e.message}`))
      // #369: the answer this agent is about to wait for may already be sitting
      // in its own note queue, unread. A daemon restart killed the call that
      // asked, the operator answered the card anyway, and #139 parked the
      // answer. Hand it back now rather than opening a second card and making
      // the operator wait a second time for one question.
      //
      // This opens no record, so it supersedes nothing (#336). That is right:
      // the record this answer belongs to is already closed, and a corpse of
      // this kind on this agent would have been closed by the call that earned
      // the answer in the first place.
      const recorded = store.recordedAnswerFor({ agent, ...payload })
      if (recorded) {
        store.takeRecordedAnswer(recorded.record, recorded.note)
        log(`escalation ${recorded.record.id} replayed to ${agent} — the same question, answered already, note ${recorded.note.id} taken`)
        const lines = [recordedAnswerLine(recorded.record)]
        // The card is what shows a picture, and no card opened. Said rather
        // than swallowed: an agent that thinks the operator saw a screenshot
        // reads the answer as being about it.
        if (images?.length) lines.push(`(curia opened no card, so the ${images.length} image(s) you sent with this call were not shown.)`)
        return {
          content: [
            { type: 'text', text: `${lines.join('\n')}\n\n${recorded.record.answer}` },
            ...inboundContent(recorded.record.attachments ?? []),
          ],
        }
      }
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

  // #241: the one thing a NEW-map charting agent knows that the daemon cannot
  // find out for itself. GitHub has no query for "the map this pane just made",
  // so the number arrives on the side channel — which is the rule already
  // (CONTEXT.md: curia never parses the terminal to learn agent state), not a
  // new one. The dispatcher VERIFIES the number before taking it, so this
  // remains a report the daemon checks rather than an account it believes.
  server.tool(
    'map_created',
    'Tell curia the issue number of the `wayfinder:map` you just created. Call it as soon as the issue exists, not at the end: until you do, curia does not know which map is yours, so your thread keeps a placeholder name, another charting agent could be dispatched onto the same map, and your final summary has nowhere to land. curia checks the number is really an open map in this repo and refuses one that is not. Only an agent sent to chart a NEW map has this tool.',
    { number: z.string().describe('The issue number of the map you created — the bare number, e.g. "250".') },
    async ({ number }) => ({
      content: [{ type: 'text', text: await dispatcher.adoptMap(agent, number) }, ...drainNotes()],
    }),
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
      // #258: a cross-check still reading PARKS this call, exactly as it parks
      // the gate. The keepalive starts first, because the park lasts as long as
      // a reviewer takes and the client aborts an MCP call after 300s of silence
      // (#34). #237: a captured verdict nobody judged shuts the tool instead.
      // Both run BEFORE anything persists — the `result` journal line, the
      // results file and the ✅ thread post all read as "the ticket ended", and
      // a held or refused result must leave none of the three.
      const stopHoldKeepAlive = startKeepAlive(extra, `${agent}/result`)
      let heldText
      try {
        heldText = await dispatcher.endingHold(agent)
      } finally {
        stopHoldKeepAlive()
      }
      if (heldText) return { content: [{ type: 'text', text: heldText }, ...drainNotes()] }
      const refusedText = dispatcher.resultRefusal(agent)
      if (refusedText) return { content: [{ type: 'text', text: refusedText }, ...drainNotes()] }
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
      // The FIRST of the ending's two messages (#253, ADR-0013): the agent's
      // own voice states what the work came to. The daemon appends the
      // pull-request link because this report is the one place it is allowed to
      // unfurl — the receipt that follows wraps every url in <>. A summary that
      // already names the link keeps its own wording; two copies of one link in
      // one message is the same defect at a smaller scale.
      if (bridge) {
        const pr = dispatcher.pullRequestUrlFor(agent)
        const tail = pr && !result.summary.includes(pr) ? `\n🔗 ${pr}` : ''
        bridge.notify(bound, `✅ reports **${result.status}**: ${result.summary}${tail}`, { as: speaker }).catch(() => {})
      }
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

// ---- the dashboard's one read (#262) ----------------------------------------

// A usage window on the wire. The meters speak camelCase because the status
// line composes them in the same file that reads them; `/overview` is a
// contract between two processes, so it speaks the snake_case every other
// route on this port already does.
const wireWindow = (w) => ({
  label: w.label,
  pct: w.pct,
  elapsed_pct: w.elapsedPct ?? null,
  resets_at: w.resetsAt ?? null,
  fresh: Boolean(w.fresh),
})

// An open escalation on the wire. The record's own bookkeeping — the payload
// hash, the successor chain, the action targets — is how the gate decides
// things and says nothing a page can draw, so it stays here.
const wireEscalation = (r) => ({
  id: r.id,
  agent: r.agent,
  ticket: r.ticket,
  kind: r.kind,
  prompt: r.prompt,
  options: r.options ?? null,
  preview_url: r.preview_url ?? null,
  // #266: the console draws the same buttons the Discord card draws, so it
  // needs the one field that decides whether a free-text round carries the ✅
  // All as recommended tap (#285). Without it the console would offer a
  // recommended round a plain text box, and the operator would have to type
  // the fixed word the button sends.
  recommended: Boolean(r.recommended),
  opened_at: r.opened_at,
  agent_died: Boolean(r.agent_died),
  rendered: Boolean(r.discord),
  thread_id: r.discord?.threadId ?? null,
})

// The provider strip (#248's home screen): one usage reading per provider, said
// once above a fleet whose every agent repeats it.
//
// Anthropic answers from the account probe and needs no agent at all. Every
// other provider states its windows only inside an agent's own transcript, so
// the first live agent on it is the evidence, and the reading names where it
// came from. A provider with no probe and no agent says NOTHING rather than
// zero: an unmeasured window and an unspent one are not the same fact.
function providerUsage() {
  const out = new Map()
  const account = accountUsage.windows()
  if (account) out.set('anthropic', { provider: 'anthropic', from: 'account', session: null, windows: account })
  for (const w of dispatcher?.agents.values() ?? []) {
    const provider = routingConfig.models?.[w.model]?.provider ?? providerOf(routingConfig, harnessFor(w.session))
    if (!provider || out.has(provider)) continue
    const { windows } = metersFor(w.session, w.model)
    if (!windows) continue
    out.set(provider, { provider, from: 'transcript', session: w.session, windows })
  }
  return [...out.values()].map((p) => ({ ...p, windows: p.windows.map(wireWindow) }))
}

// ---- the settings screen's two daemon reads (#265) ---------------------------

// The exit code `POST /restart` leaves with, and the pause before it takes it.
// The code is nonzero because `restart: on-failure` is what respawns this
// process: a clean exit is how the daemon stays down for a deploy. The pause is
// only long enough for the answer already written to leave the socket.
const RESTART_EXIT_CODE = 75
const RESTART_DELAY_MS = 50

// Who a loopback caller says it is (#266). Every REST verb already journalled a
// `by`, and every one of them journalled the same word: `rest`. The console
// passes the operator's own Tailscale login instead — the one its identity gate
// checked before the request got this far — so the feed names a person rather
// than a transport. Absent or empty stays `rest`, which is what every caller
// before this one sent. Bounded, because it is written into the journal.
const named = (by) => (typeof by === 'string' && by.trim() ? by.trim().slice(0, 120) : 'rest')

// The watchable repos, cached. `gh repo list` names only what the login OWNS,
// and the watch list already carries a repo under another owner, so this asks
// for everything the login can reach instead.
const REPOS_TTL_MS = 10 * 60_000
const REPOS_LIMIT = 100
let reposCache = null

async function watchableRepos() {
  if (reposCache && Date.now() - reposCache.at < REPOS_TTL_MS) return reposCache.value
  const value = { login: null, repos: null, limit: REPOS_LIMIT, error: null, read_at: new Date().toISOString() }
  try {
    value.login = await viewerLogin()
    const rows = await ghJSONL([
      'api', `user/repos?per_page=${REPOS_LIMIT}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      '--jq', '.[] | {full_name}',
    ])
    value.repos = rows.map((r) => r.full_name).filter(Boolean)
  } catch (e) {
    // Null, never an empty list: "the operator has no repos" and "curia could
    // not ask" are opposite facts, and the page draws them differently.
    value.error = e.message
    log(`the repo list for the settings screen failed (${e.message})`)
  }
  reposCache = { at: Date.now(), value }
  return value
}

// Everything the console shell draws, in one read (#262, per the where-it-lives
// decision #249). The sidecar holds no secret, no GitHub token and no journal
// handle: it polls this and renders what comes back.
//
// The journal FILE stays daemon-private. What crosses is its last hundred
// events, which is the feed and nothing more.
//
// The frontier is the only field this route does not compute. Reconcile does,
// on the credentials that pass already holds, and the stamp beside it says how
// old the reading is (see Dispatcher#frontierSnapshot).
//
// This route reads no journal file (#289). The recent outcomes and the gate's
// pull request are both reductions the store fills as events are written, so
// what one poll costs no longer rises with the history. The journal is still
// read whole ONCE per process, by the store's boot replay, which is what fills
// them. Every other section is memory or a stamped snapshot, except the
// context meter, which reads one transcript tail per live agent (#264).
async function overview() {
  // The fleet read asks tmux, and an indeterminate tmux is not "no agents" —
  // the evidence rule holds on a page exactly as it holds in reconcile. It must
  // not cost the rest of the page either: the feed, the escalations, the gate
  // and the frontier are all still readable while tmux is wedged, and a
  // dashboard that goes blank is worst precisely when the box is worst. So the
  // section says it could not be read, and every other section answers.
  let fleet = null
  let fleetError = null
  try {
    fleet = await dispatcher.status()
  } catch (e) {
    fleetError = e.message
    log(`overview: the fleet read failed (${e.message}) — serving every other section`)
  }
  const health = bridge ? bridge.status() : null
  const open = store.openEscalations()
  return {
    at: new Date().toISOString(),
    daemon: {
      port: PORT,
      uptime_s: Math.round(process.uptime()),
      auto_dispatch: curiaConfig.dispatch.auto_dispatch,
      max_concurrent: curiaConfig.dispatch.max_concurrent,
      // The six reloadable settings this process is RUNNING, and when it read
      // them (#362). The console compares these against the file it read: a
      // save that says "applied" is then a fact curia measured, and a daemon
      // running something else is visible without opening the section.
      config: { loaded_at: configLoadedAt, ...liveSettings({ curia: curiaConfig, routing: routingConfig }) },
    },
    // Null, never empty, when the read above failed: an unreadable fleet and an
    // idle box are opposite facts and must never render the same.
    //
    // The context meter joins here (#264). `status()` reads tmux and the
    // journal and never a transcript, so the ctx column the dashboard's two
    // tables carry has to be added on the route. It costs one transcript tail
    // read per live agent per refresh, which the poll interval bounds (#263).
    agents: fleet?.agents?.map((a) => ({ ...a, ...ctxOnWire(() => metersFor(a.session, a.model)) })) ?? null,
    untracked: fleet?.untracked ?? null,
    recent: fleet?.recent ?? null,
    fleet_error: fleetError,
    // The gate is its own list, not a kind to filter for. It is the one
    // escalation the daemon opens about an agent's ENDING, it carries the pull
    // request nothing else carries, and the page draws it as its own card.
    escalations: open.filter((r) => r.kind !== REVIEW_KIND).map(wireEscalation),
    review_gate: open.filter((r) => r.kind === REVIEW_KIND).map((r) => ({
      ...wireEscalation(r),
      pull_request: dispatcher.pullRequestUrlFor(r.agent),
      // The digest counted when this gate opened (#355). It rides the record,
      // so the card costs no extra read and every poll states the same numbers
      // — including one taken after the agent and its worktree are gone.
      diff: r.diff ?? null,
      diff_error: r.diff_error ?? null,
    })),
    // The overseer container (#327). ADR-0015 gives compose its liveness, so
    // this asserts nothing and spawns nothing: it dials the published loopback
    // port and reads the marker back, the same shape the ttyd health check has.
    // A dead overseer is a chat that answers nothing, and silence is the one
    // failure an operator cannot tell from a quiet day.
    overseer: { port: curiaConfig.overseer.port, ...(await probeOverseer({ port: curiaConfig.overseer.port })) },
    // `bridge` keeps the string shape /state gave it, and `bridge_health` the
    // whole record — one name for one thing across both routes.
    bridge: health?.state ?? 'down',
    bridge_health: health ?? { state: 'down', since: null, unhealthy_for_s: 0, last_error: null },
    usage: providerUsage(),
    events: store.recentEvents(),
    frontier: dispatcher.frontierSnapshot(),
  }
}

// The browser conversations, on the wire (#333). Everything about the shape
// lives in usage.mjs beside `ctxOnWire`; what stays here is the wiring — the
// store this daemon holds and the overseer container's config dir and model.
function consoleOnWire() {
  const cfgDir = overseerContainer.configDir
  return consoleConversationsOnWire({
    conversations: store.consoleConversationList(),
    sessionIdFor: (key) => store.overseerSession(key),
    harness: detectHarness(cfgDir),
    cfgDir,
    model: overseerContainer.model,
    routing: routingConfig,
    account: accountUsage,
    models: modelWindows,
  })
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

  // The container-facing listener is the agent surface plus the overseer's own
  // one route (#314), and nothing more. A refusal, not a 404: the route exists,
  // this caller may not have it.
  if (fromContainer && !AGENT_ROUTES.has(url.pathname) && url.pathname !== OVERSEER_MCP_PATH) {
    store.logEvent('container_route_refused', { path: url.pathname, method: req.method })
    return json(403, { error: `${url.pathname} is not reachable from a curia container — this address carries the MCP side channels and the Stop hook only` })
  }

  // The overseer container's verb tools (#314). Its proof is NOT an agent
  // token: the secret is minted per TURN and lives in memory for the length of
  // one, because a turn survives no restart and there is nothing to adopt. The
  // turn id in the query names which conversation the verbs route to, and the
  // secret in the header is what makes that name a claim rather than a wish.
  if (url.pathname === OVERSEER_MCP_PATH) {
    if (req.method !== 'POST') return json(405, { error: 'stateless server: POST only' })
    const id = url.searchParams.get('turn') ?? ''
    const body = await readBody(req)
    return serveVerbMcp({
      turns: overseerTurns,
      id,
      presented: req.headers[TOKEN_HEADER],
      log,
      refuse: (error) => {
        store.logEvent('overseer_turn_refused', {
          turn: id, from: fromContainer ? 'container' : 'loopback', presented: Boolean(req.headers[TOKEN_HEADER]),
        })
        return json(403, { error })
      },
      serve: async (mcp) => {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => { transport.close() })
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
      },
    })
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

  // The dashboard's read (#262). Loopback only, and absent from AGENT_ROUTES,
  // so the container-facing listener refuses it before it reaches here.
  if (url.pathname === '/overview' && req.method === 'GET') {
    return json(200, await overview())
  }

  // ---- the diff, on demand (#355) --------------------------------------------
  //
  // ONE route, and the browser addresses it by NAMING A THING curia already
  // knows: an escalation id (a review gate) or an agent name (a live row). It
  // never names a path, a repo, a branch or a command — the daemon resolves the
  // worktree itself, which is the #266 seam this inherits.
  //
  // A file is addressed by its INDEX into the digest's own ranked list, so the
  // only files reachable through here are the ones curia measured. Without
  // `file` the route answers the digest alone, which is how a live agent row
  // gets its numbers: a gate's digest is stored and needs no read at all.
  //
  // Loopback only, and absent from AGENT_ROUTES: an agent has its own worktree
  // and no business reading another's.
  if (url.pathname === '/diff' && req.method === 'GET') {
    const escId = url.searchParams.get('esc')
    const agentName = url.searchParams.get('agent')
    const fileParam = url.searchParams.get('file')
    if (!escId && !agentName) return json(400, { error: 'name an escalation id or an agent' })

    // A gate reads its STORED digest: it was counted when the gate opened, and
    // re-counting now would answer a different question — the worktree has
    // moved on, or is gone.
    const record = escId ? store.get(escId) : null
    if (escId && !record) return json(404, { error: `there is no escalation ${escId}` })
    if (record && record.kind !== REVIEW_KIND) return json(400, { error: `${escId} is not a review gate, so it carries no diff` })
    const agent = record?.agent ?? agentName
    const uncommitted = !record // a live row shows committed and uncommitted work together

    const { digest, error } = record
      ? { digest: record.diff ?? null, error: record.diff_error ?? null }
      : await dispatcher.agentDiff(agent)
    if (fileParam === null) return json(200, { agent, uncommitted, digest, error })

    if (!digest) return json(200, { agent, uncommitted, digest: null, error, hunks: null })
    const i = Number(fileParam)
    const file = Number.isInteger(i) && i >= 0 ? digest.list[i] : undefined
    if (!file) return json(404, { error: `this digest has no file ${fileParam}` })
    const hunks = await dispatcher.agentHunks(agent, file, { uncommitted })
    return json(200, { agent, uncommitted, file, hunks })
  }

  // ---- the browser conversations (#333) --------------------------------------
  //
  // Three routes, all loopback and none in AGENT_ROUTES: the Chat screen reads
  // the list, mints one, and deletes one. They are not verbs. The operator
  // catalogue has no word for a browser conversation, on Discord or anywhere
  // else, so there is nothing for `POST /command` to carry — see #266 on why
  // the console composes calls rather than forwarding text.
  if (url.pathname === '/console' && req.method === 'GET') {
    return json(200, { conversations: consoleOnWire() })
  }

  // The mint. A GET never does this: a page that opened a conversation by
  // being looked at would spend a number every time the operator glanced at the
  // screen, and numbers only go up.
  if (url.pathname === '/console/new' && req.method === 'POST') {
    const key = store.openConsoleConversation()
    log(`console: opened browser conversation ${key}`)
    return json(200, { key, session: sessionForConsoleKey(key) })
  }

  // The delete. The number stays spent and the transcript stays on disk — see
  // store.deleteConsoleConversation. A key that is not a live conversation is a
  // 409 rather than a silent success, because the page may be showing a list
  // another device has already changed.
  if (url.pathname === '/console/delete' && req.method === 'POST') {
    const key = String((await readBody(req)).key ?? '')
    if (!isConsoleKey(key)) return json(400, { error: `\`${key}\` is not a browser conversation key` })
    if (!store.deleteConsoleConversation(key)) {
      return json(409, { ok: false, error: `there is no conversation \`${key}\` — it may already be deleted` })
    }
    log(`console: deleted browser conversation ${key} — its number is spent`)
    return json(200, { ok: true, key })
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
    const { id, answer, attachments, by, via } = await readBody(req)
    // Attachment paths get read and inlined into an agent's context, so they
    // pass the same containment gate as outbound images rather than being
    // trusted because the caller reached loopback.
    const { files } = outboundImages('rest', attachments)
    // #266: the console names the operator who pressed and the surface they
    // pressed on, so the journal and the feed say `answered by <login> via
    // dashboard` rather than attributing every browser answer to `rest`. The
    // default is what every caller before this one already sent.
    const result = gate.answer(id, {
      answer: String(answer), attachments: files.map((f) => f.attachment), by: named(by), via: named(via),
    })
    return json(result.ok ? 200 : 409, result)
  }

  // The console's note (#266). A note in Discord is any message in an agent's
  // thread, so it has no verb and the command surface carries none; the browser
  // has no thread at all, and names the agent instead. What happens after that
  // is ADR-0013 unchanged — see gate.noteAgent.
  if (url.pathname === '/note' && req.method === 'POST') {
    const body = await readBody(req)
    const agent = String(body.agent ?? '')
    const text = String(body.text ?? '')
    const mode = body.mode === 'interrupt' ? 'interrupt' : 'queue'
    if (!validSessionName(agent)) return json(400, { error: `\`${agent}\` is not a curia session name` })
    if (!text.trim()) return json(400, { error: 'a note with no words is not a note' })
    return json(200, await gate.noteAgent(agent, text, { mode, by: named(body.by) }))
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
    const { text, by } = await readBody(req)
    if (typeof text !== 'string' || !text.trim()) return json(400, { error: 'body must carry {text}' })
    const reply = await gate.command(text, named(by))
    return json(200, { reply })
  }

  if (url.pathname === '/reconcile' && req.method === 'POST') {
    await dispatcher.reconcile({ boot: false })
    return json(200, { ok: true })
  }

  // The repos the settings screen offers (#265). The dashboard sidecar holds no
  // GitHub credential — that is what #263's mount list buys — so the one process
  // that does answers this. Cached, because a settings screen re-drawn on every
  // keystroke must not be a `gh` call each time, and the set of repos a person
  // can watch changes about as often as they create one.
  //
  // Deliberately NOT the whole list: the 100 most recently pushed, which is the
  // selector's useful length, and the page says so and takes a typed
  // `owner/name` for anything outside it.
  if (url.pathname === '/repos' && req.method === 'GET') {
    return json(200, await watchableRepos())
  }

  // The reload (#362, building the hot-reload decision #347). The save applies:
  // the daemon re-reads both files and takes the six settings the settings
  // screen writes, without the restart that used to be phase two of every save.
  //
  // A RELOAD IS TOTAL OR IT IS NOTHING. Three ways out, and only the last one
  // moves anything:
  //
  //   1. A file the loaders refuse applies nothing and answers their message.
  //      `checkPaths` is ON here, unlike the sidecar's pre-save validation: this
  //      container mounts the paths that one cannot see, so it runs every rule.
  //   2. A file that moved a key outside the closed set applies nothing and
  //      names the first key that differs. That key needs the restart.
  //   3. Otherwise the six go into the objects this file already holds, and the
  //      auto loop is re-armed if its interval moved.
  //
  // What makes 3 small is that the daemon reads five of the six PER USE, off a
  // live object reference — `this.config.dispatch`, `this.config.watch`,
  // `resolveModel(this.routing, …)`, `isActive(this.routing, …)`. Only
  // `poll_interval_s` is captured, by the interval `startAutoLoop` arms.
  if (url.pathname === '/reload' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}))
    const by = named(body?.by)
    const decline = (reason, detail) => {
      store.logEvent('config_reload_declined', { by, reason, ...detail })
      log(`reload declined for ${by}: ${detail.error ?? detail.key}`)
      return json(200, { ok: false, reason, ...detail })
    }

    let nextCuria
    let nextRouting
    try {
      nextCuria = loadCuriaConfig(CURIA_FILE)
      nextRouting = loadRoutingConfig(ROUTING_FILE)
    } catch (e) {
      // The loader's own message, unedited. It names the file and the key, and
      // it is the same sentence a refused boot would print.
      return decline('invalid', { error: e.message })
    }

    for (const [file, running, candidate, paths] of [
      ['curia.yaml', curiaConfig, nextCuria, LIVE_PATHS.curia],
      ['routing.yaml', routingConfig, nextRouting, LIVE_PATHS.routing],
    ]) {
      const key = frozenDifference(running, candidate, paths)
      if (key) {
        return decline('restart-needed', {
          file,
          key,
          error: `${file} \`${key}\` changed, and that key is not one a reload applies — restart the daemon to take it`,
        })
      }
    }

    const before = liveSettings({ curia: curiaConfig, routing: routingConfig })
    const after = liveSettings({ curia: nextCuria, routing: nextRouting })
    const applied = liveDiff(before, after)
    // The apply, into the objects index.mjs already holds. Nothing here builds a
    // new config object: the dispatcher, the command router and every closure
    // above hold references to these two, and replacing either would leave half
    // the process reading the old one.
    for (const key of DISPATCH_KEYS) curiaConfig.dispatch[key] = nextCuria.dispatch[key]
    curiaConfig.watch = nextCuria.watch
    for (const [type, model] of Object.entries(nextRouting.defaults)) routingConfig.defaults[type] = model
    for (const [name, m] of Object.entries(nextRouting.models)) routingConfig.models[name].active = m.active
    configLoadedAt = new Date().toISOString()

    if (applied.includes('watch')) checkWatchedCredentials()
    // The one captured setting. Only re-armed if the loop is running: before
    // boot reconcile finishes there is no timer, and arming one here would
    // start dispatching against a fleet nobody has reconciled yet.
    if (applied.includes('dispatch.poll_interval_s') && dispatcher.autoTimer) dispatcher.startAutoLoop()

    store.logEvent('config_reloaded', { by, keys: applied })
    log(applied.length
      ? `config reloaded by ${by}: ${applied.join(', ')}`
      : `config reloaded by ${by} — the file says what this daemon was already running`)
    return json(200, { ok: true, by, applied, loaded_at: configLoadedAt })
  }

  // The restart (#249 item 6, built by #265). No sudoers, no host change and no
  // second supervisor: the daemon journals the order and exits NONZERO, and
  // `restart: on-failure` in deploy/compose.yaml brings it back. A clean exit
  // would stay down, which is why the code below is not 0.
  //
  // Agent panes live in the tmux CONTAINER (#260), so they survive this. What
  // does not survive is this process: the answer goes out first, and the exit
  // is scheduled behind it — an exit inside the handler would kill the socket
  // the sidecar is waiting on, and the operator would read a restart that
  // worked as a restart that failed.
  if (url.pathname === '/restart' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}))
    const by = typeof body?.by === 'string' ? body.by : 'loopback'
    store.logEvent('restart_requested', { by, exit_code: RESTART_EXIT_CODE })
    log(`restart requested by ${by} — exiting ${RESTART_EXIT_CODE} so the supervisor respawns this process`)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, by, exit_code: RESTART_EXIT_CODE }), () => {
      setTimeout(() => process.exit(RESTART_EXIT_CODE), RESTART_DELAY_MS).unref()
    })
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

// restart recovery: an open escalation that never rendered re-arms the retries
// it has not used yet — measured from esc_open, so a restart re-arms the rest
// of the window rather than starting a fresh one (#261)
for (const r of store.openEscalations()) {
  log(`recovered open escalation ${r.id} (${r.kind}) agent=${r.agent} ticket=${r.ticket}`)
  if (!r.discord) armRenderRetries(r)
}

// #270: if this boot is the far side of a self-deploy, wait for the sibling's
// verdict and announce it. The bridge is usually up seconds before the sibling
// finishes its 10s-stability window; if it is not, the journal line still
// lands and the announce falls back to the log.
selfDeploy.resolvePending({ announce: (text) => (bridge ? bridge.announce(text) : Promise.resolve()) })
  .catch((e) => log(`deploy resolution failed: ${e.message}`))

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
        channelName: CHANNEL,
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
          // the same two, thread first (#257): who holds this thread now, and
          // who held it last. The boot pass that settles an ending's name asks
          // both — the second says the thread is curia's, the first says it is
          // free to settle.
          ticketOf: (threadId) => store.ticketForThread(threadId),
          lastTicketOf: (threadId) => store.lastTicketForThread(threadId),
          // the label's repo field (#235), read lazily off the journal
          repoOf: (ticket) => store.repoForTicket(ticket),
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
        // #257: a ✅ the last process owed but never sent. Never fails a start.
        b.settleEndedThreads().catch((e) => log(`settling ended thread names failed: ${e.message}`))
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

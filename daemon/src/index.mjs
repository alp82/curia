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
import { Reduction, CONFIRM_KIND, noteDisposition } from './reduction.mjs'
import { JOURNAL } from './journal.mjs'
import { DiscordBridge } from './bridge.mjs'
import { installCrashGuard } from './health.mjs'
import { sayGoodbye, questionGoodbye, deathWasSilent, DAEMON_BOOT } from './goodbye.mjs'
import { readable } from './logline.mjs'
import { resolveOutboundFiles, inboundContent, ALLOWED_EXTENSIONS } from './attachments.mjs'
import { PreviewRegistry } from './preview.mjs'
import { loadCuriaConfig, loadRoutingConfig, overrideSummary } from './config.mjs'
import { PROBE_MARK, PROBE_PATH, GUEST_DAEMON_HOST, GUEST_WT, dockerGateway, probeSideChannel } from './sandbox.mjs'
import { Cooling, providerOf } from './routing.mjs'
import { Dispatcher } from './dispatch.mjs'
import { REVIEW_KIND, RESULT_KIND, NOTIFY_KIND } from './lifecycle.mjs'
import { sameDigest } from './diffdigest.mjs'
import { CommandRouter } from './commands.mjs'
import { SelfDeploy } from './deploy.mjs'
import { OverseerClient, OverseerTurns, serveConversationMcp, serveVerbMcp } from './overseerclient.mjs'
import { OverseerPaneHost } from './overseerpane.mjs'
import { OVERSEER_CONVERSATION_PARAM, revokeConversationToken } from './overseeridentity.mjs'
import { OVERSEER_MCP_PATH } from './overseerturn.mjs'
import { ConversationRuntime } from './conversationruntime.mjs'
import { hasSession } from './tmux.mjs'
import { retiredAgentTokenKeys } from './workspace.mjs'
import { APP_ID_KEY, APP_KEY_FILE_KEY, GitHubAppSetup, minterFrom } from './githubapp.mjs'
import { AppSetup, minterForAdopted } from './appsetup.mjs'
import { CodexCredentialBroker, AnthropicCredentialStore, anthropicStoreFile } from './credentials.mjs'
import {
  OVERSEER_ENV_FILE, overseerEnvPath, loadOverseerEnv, daemonOnlyKeys, retiredTokenKeys,
} from './overseertoken.mjs'
import { TOKEN_HEADER, AGENT_ROUTES, tokensDir, agentTokenMatches } from './agenttoken.mjs'
import { gh, viewerLogin, ghJSONL, repoMaps, mapFrontier, blockedByOf } from './github.mjs'
import { MapSnapshot, readMapSnapshot } from './mapsnapshot.mjs'
import { setDaemonTokenSource } from './daemongh.mjs'
import { TokenWatch } from './tokenwatch.mjs'
import { JournalBackup } from './backup.mjs'
import { AistackSync } from './aistack.mjs'
import { AistackRegistration } from './aistackreg.mjs'
import {
  probeTtyd, serveOff, attachBase, atlasTerminalUrl, validSessionName,
  isConsoleKey, consoleKeyForSession, sessionForConsoleKey,
} from './attach.mjs'
import { probeOverseer } from './overseerservice.mjs'
import { replayKilledTurns, replayLine } from './overseerreplay.mjs'
import { LIVE_PATHS, DISPATCH_KEYS, liveSettings, liveDiff, frozenDifference } from './settings.mjs'
import { TimelineSurface } from './timeline.mjs'
import { identityRefusal, hostsForPorts, tailnetSelf } from './identity.mjs'
import { detectHarness, findTranscript } from './transcript.mjs'
import { promptTitle, elapsedLabel, speakerName, smallPrint, handOffLine } from './messaging.mjs'
import {
  isTyped, floorFaults, hasText, lintAskHuman, lintRequestReview, reviewFloorFaults,
  lintResult, resultFloorFaults,
  lintNotify, notifyFloorFaults, notifyHasText,
  lintVerdict, verdictFloorFaults, VERDICT_SEVERITIES, hasVisualField,
} from './lint.mjs'
import {
  composeCard, composeReviewBody, composeResultReport, composeOpening, optionLabels, derivedRecommended,
  composeNotify, NOTIFY_KINDS, composeVerdictReport,
} from './card.mjs'
import { LintGate, flaggedResultText, flaggedNotifyText } from './lintgate.mjs'
import { StatusLine } from './statusline.mjs'
import { remainingRenderRetries } from './renderretry.mjs'
import { MAP_FOG_VERB } from './mapfog.mjs'
import { GlobalSearch } from './search.mjs'
import { githubSearchSource, journalSearchSource, transcriptSearchSource } from './searchsources.mjs'
import {
  compositeSendFaults, compositeSendSchemaFaults, renderCompositeSend,
} from './composite.mjs'
import { trackerWriteWaves } from './trackerwrites.mjs'
import {
  AccountUsage, AnthropicCredentialHealth, ModelWindows,
  agentMeters, ctxOnWire, consoleConversationsOnWire,
} from './usage.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(DIR, '..')

// minimal env loader (daemon/.env.daemon, never committed)
//
// The name gained its suffix with #313, which gave the overseer container an env
// file of its own. #726 retired that second file. The daemon still reads an
// existing copy separately so boot can name credentials that need deletion.
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
if (loadFrom === legacyEnvFile) log('WARNING: daemon/.env is the old name. Rename it to daemon/.env.daemon (#313)')

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

// Re-derived rather than fixed, because the watch list is reloadable (#362): a
// repo added live must get the same per-owner reading a booted one gets, or it
// looks watched here and refuses the first dispatch to it.
let WATCHED_OWNERS = new Set(curiaConfig.watch.map((w) => w.repo.split('/')[0]))

// #155 gave every agent a scoped fine-grained PAT per resource owner, read out
// of this file at boot. #389 cut the agents over to the app and #466 retired the
// key. A value still under it is a live read-write PAT with no job, so the boot
// names it and asks for the same two acts #392 asks for on the overseer's own
// retired key.
for (const key of retiredAgentTokenKeys()) {
  log(`WARNING: ${key} is in daemon/.env.daemon and nothing reads it — an agent mints its own token now (#466). Delete the key and revoke the token on GitHub`)
}

// #313 gave the overseer its own read-only PAT per owner, in a second env file.
// #392 retired those PATs, and #726 retired the model seed that remained. The
// daemon reads an existing file only to name legacy keys for deletion. It never
// loads the file into `process.env`.
const overseerEnv = loadOverseerEnv(overseerEnvPath(ROOT))
for (const key of daemonOnlyKeys(overseerEnv)) {
  log(`WARNING: ${key} is in retired daemon/${OVERSEER_ENV_FILE}. Delete the key from the box`)
}
for (const key of retiredTokenKeys(overseerEnv)) {
  log(`WARNING: ${key} is in daemon/${OVERSEER_ENV_FILE} and nothing reads it — the overseer mints its own token now (#392). Delete the key and revoke the token on GitHub`)
}
// And the watch list against GitHub itself, once per watched owner. What a
// credential reaches lives on GitHub rather than in an env file, so nothing
// local can tell that a newly watched repo was left off it. Detached from the
// boot chain on purpose: this is a network round-trip per owner, and GitHub
// being slow or down must never hold up a daemon whose other duties do not need
// it.
//
// ONE CREDENTIAL IS LEFT ON THE BOX (#466). Every holder mints from the app now,
// so there is no PAT to probe and no expiry to count: the daemon refreshes a
// minted token every fifty minutes, and GitHub states no expiry header for one
// at all. What replaced the probe is the question the probe could never answer.
// A token read of the repo says yes for every PUBLIC repo, whoever holds the
// token — measured on the box, where an agent's own minted token read
// `octocat/Hello-World`. So this asks the INSTALLATION what it covers, which
// answers for private and public alike.
//
// #380 moved the JUDGEMENT out of here. This function now only measures, and
// hands every answer to the credential watch, which decides what the operator
// is told and where. The log lines stay, because the boot output is the one
// place an operator reads a healthy credential — but a log line is no longer
// the whole of what a dying one gets.
const APP_HOLDER = {
  holder: 'app',
  refusal: 'no agent can be dispatched to it',
  fix: 'Grant the repo to curia\'s app installation on GitHub (docs/github-app.md).',
}

// Every reading one pass takes. The watch calls this and nothing else does.
//
// It is per OWNER, because an installation is per owner and states its whole
// grant in one read. A box with no app measures nothing rather than warning per
// repo: the boot already says the app is missing, once, and ADR-0018 is the one
// place that says what to do about it.
async function probeWatchedCredentials() {
  if (!appMinter) return []
  const owners = [...new Set(curiaConfig.watch.map(({ repo }) => repo.split('/')[0]))]
  const perOwner = await Promise.all(owners.map(async (owner) => {
    const repos = curiaConfig.watch.map((w) => w.repo).filter((r) => r.split('/')[0] === owner)
    const at = { ...APP_HOLDER, key: owner }
    let covered
    try {
      covered = new Set(await appMinter.reposFor(owner))
    } catch (e) {
      // A GitHub that could not answer is a fact about GitHub, not about the
      // grant. It is not silence either: `unmeasured` is what stops the watch
      // reading it as a credential that came good (#380).
      log(`could not read what curia's app covers on ${owner} (${e.message}) — not treating that as a repo it cannot reach`)
      return repos.map((repo) => ({ ...at, repo, unmeasured: true }))
    }
    return repos.map((repo) => {
      const ok = covered.has(repo.toLowerCase())
      if (ok) log(`curia's GitHub App covers ${repo}`)
      else log(`WARNING: curia's GitHub App does not cover ${repo} — ${at.refusal}`)
      return { ...at, repo, ok, message: ok ? null : 'the app installation does not grant it' }
    })
  }))
  return perOwner.flat()
}

// Everything the boot says about the credential behind the WATCH LIST, in one
// function, because a reload runs it again (#362). A repo added from the
// settings screen gets the same GitHub reading a booted one gets — without this,
// a live add looks watched and the failure arrives as a refused dispatch.
//
// The probe is still detached from the boot chain on purpose: it is a network
// round-trip per owner, and GitHub being slow or down must never hold up a
// daemon whose other duties do not need it.
function checkWatchedCredentials() {
  WATCHED_OWNERS = new Set(curiaConfig.watch.map((w) => w.repo.split('/')[0]))
  checkAppInstallations()
  tokenWatch.pass().catch((e) => log(`the credential watch failed (${e.message})`))
}

// #352, building ADR-0018: the GitHub App that replaces every token above. It
// EVERY HOLDER IS ON IT, and the last PAT retired with #466. So a box with no
// app dispatches no agent: what the boot does here is prove the operator's
// checklist worked and say so out loud.
//
// A HALF-configured app refuses the boot inside minterFrom, because an app id
// with no key is a typo, and a typo that boots reaches a dispatch as a 401
// nobody can place. NO app is a different thing and stays legal: a box can watch
// and read before its operator finishes the checklist, and the refusal it gets
// at the first dispatch names the step that was missed.
// `let`, because #694 adopts a converted app in process: the setup flow puts a
// new minter here and hands it to the dispatcher without a restart.
let appMinter = minterFrom({ daemonRoot: ROOT, log })
if (!appMinter) {
  log(`no GitHub App configured — set ${APP_ID_KEY} and ${APP_KEY_FILE_KEY} in daemon/.env.daemon (docs/github-app.md). No agent can be dispatched until it is`)
} else {
  log(`GitHub App ${appMinter.appId}, key at ${appMinter.keyFile}`)
}

// The owner half of the same question the watch asks per repo. An installation
// is per owner, and an owner with none is a different act to repair than a repo
// left off one — so it is said here, by name, once per pass.
//
// Detached, for the same reason the watch's own probe is: this is a network
// round trip, and GitHub being slow must never hold up a boot whose other duties
// do not need it. Re-run on every reload (#362), because an owner added from the
// settings screen must get the reading a booted one gets.
function checkAppInstallations() {
  if (!appMinter) return
  appMinter.refreshInstallations().then((installs) => {
    for (const { id, owner } of installs) log(`GitHub App installed on ${owner} (installation ${id})`)
    const seen = new Set(installs.map((i) => String(i.owner ?? '').toLowerCase()))
    for (const owner of WATCHED_OWNERS) {
      if (!seen.has(owner.toLowerCase())) log(`WARNING: the GitHub App is not installed on ${owner} — no agent can be dispatched to it, every daemon call on it falls back to the host gh login, and the overseer reads ${owner}/* with no credential at all (docs/github-app.md)`)
    }
  }).catch((e) => log(`could not read the GitHub App's installations (${e.message}) — that is a fact about GitHub rather than about the install`))
}

const githubAppSetup = new GitHubAppSetup({
  daemonRoot: ROOT,
  adopt: ({ appId, keyFile }) => {
    appMinter = minterFrom({
      daemonRoot: ROOT,
      env: { [APP_ID_KEY]: appId, [APP_KEY_FILE_KEY]: keyFile },
      log,
    })
    dispatcher.minter = appMinter
    checkAppInstallations()
  },
})

// #390: the DAEMON cuts over. Every `gh` child it spawns for a named repo now
// carries that owner's minted write token, so the frontier reads, the claims,
// the pull requests and the branch pushes all run as `curia-sh[bot]`.
//
// One source, wired once. Nothing else in the daemon holds the minter, and the
// modules that shell out (github.mjs, workspace.mjs) ask by repo and never know
// an app exists.
//
// NULL IS THE FALLBACK SIGNAL, never a refusal — the rule #389 wrote for the
// agents, applied to their daemon. A box with no app, an owner the app is not
// installed on, and a GitHub that could not be reached all read the same, and
// the call then runs on the host `gh` login exactly as it did before. It is
// LOUD rather than silent: the log names the owner, once per failure.
setDaemonTokenSource(async (owner) => {
  if (!appMinter) return null
  try {
    return await appMinter.tokenFor(owner, 'write')
  } catch (e) {
    log(`could not mint the daemon's GitHub token for ${owner} (${e.message}) — this call falls back to the host gh login`)
    return null
  }
})
log(`claims assign ${curiaConfig.dispatch.claim_login} (dispatch.claim_login) — a GitHub App cannot be an issue assignee`)

// Opening this opens the journal, and on the first boot after #407 it converts
// the journal file into the database. `log` is a hoisted function declaration,
// so the conversion line reaches journalctl even from here.
const reduction = new Reduction(DATA, { log })

// The boot line (#436). The journal is `node:sqlite`, which Node marks Stability
// 1.2, so a patch update can change the API, the defaults and the bundled SQLite
// engine (#357). Written into the journal itself, so the record states which
// engine wrote its rows and a post-mortem never has to guess.
//
// The event names no path. The journal file never crosses to the dashboard and
// only its tail does, and this event rides that tail (#262).
reduction.journal('journal_opened', {
  node: process.version, sqlite: process.versions.sqlite ?? null,
})
log(`[journal] ${JOURNAL} open on Node ${process.version}, SQLite ${process.versions.sqlite ?? 'unknown'}`)

// How the LAST daemon died (#489), read before this one says it is alive —
// after the boot line below, the answer is always this process's own.
//
// The two lines together make a death readable: every process writes one at its
// start, and a death it can see writes a goodbye at its end. So a boot line with
// no goodbye after it is a daemon that was killed with no chance to speak, which
// is the one death the boot sweep exists for. Nothing else reads this.
const lastDeathWasSilent = (() => {
  try {
    return deathWasSilent(reduction.questions.lastLifecycle())
  } catch (e) {
    // An unreadable journal is not evidence of a silent death, and the safe
    // direction here is the one that presses no key.
    log(`could not read how the last daemon died (${e.message}) — the boot sweep is skipped this boot`)
    return false
  }
})()
// Where that last life STARTED (#499), read in the same breath and for the same
// reason: after the boot line below, the answer is this process's own. The
// sweep's second set is rebuilt from the journal, and this id is what bounds it
// to one lifetime — a cross-check park lives inside one process.
const lastBootAt = (() => {
  try {
    return reduction.questions.lastBootAt()
  } catch (e) {
    // The sweep's first set stands: it reads records, which carry their own
    // evidence. Only the parked builders are lost, and a cut of 0 would widen
    // that set instead of narrowing it.
    log(`could not read when the last daemon booted (${e.message}) — no parked builder is swept this boot`)
    return Number.MAX_SAFE_INTEGER
  }
})()
reduction.journal(DAEMON_BOOT, { pid: process.pid })

// Per-agent status line (#108 item 8): one Discord message per agent
// thread, edited in place through the journal's own lifecycle events. With
// the bridge down, post returns null and the next transition retries.
// ---- the anthropic credential store (#648, ADR-0027) ------------------------
//
// The second store, and the one THREE consumers share: the claude agent
// containers and the overseer run on one value from one account, so the store is
// keyed by provider and both rows point at it. It is constructed HERE for the
// reason the codex broker is — it writes curia's real credential store, so the
// process that actually runs the box is the one that hands it over.
const anthropic = new AnthropicCredentialStore({
  workspaceRoot: curiaConfig.dispatch.workspace_root,
  journal: (event, detail) => reduction.journal(event, detail),
})

// THE STORE IS THE ONLY SOURCE. A missing store is a re-authentication case.
// An environment token cannot act as disaster recovery because its age,
// validity, and revocation state are not tracked on any curia surface (#726).
if (!anthropic.read()) {
  log(`WARNING: curia owns no anthropic credential at ${anthropicStoreFile(curiaConfig.dispatch.workspace_root)}. Run reauth anthropic before starting a claude agent or an overseer turn`)
}

// EVERY BOOT NAMES A LEGACY KEY. A live subscription token in an env file is a
// credential with no owner and no expiry anyone is watching.
for (const [file, env] of [['daemon/.env.daemon', process.env], [`daemon/${OVERSEER_ENV_FILE}`, overseerEnv]]) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    log(`WARNING: CLAUDE_CODE_OAUTH_TOKEN is in ${file} and nothing reads it. Delete the key (#726)`)
  }
  // `ANTHROPIC_API_KEY` is not a leftover, it is a REFUSED shape. The map
  // settled subscription-only, and #648 took the key out of both readers that
  // preferred it — `sandbox.mjs`'s and `usage.mjs`'s — so a box carrying one is
  // a box paying metered rates for nothing.
  if (env.ANTHROPIC_API_KEY) {
    log(`WARNING: ANTHROPIC_API_KEY is in ${file} and curia reads it nowhere — the map settled subscription-only and #648 removed the branch from both readers. Delete the key`)
  }
}

// One account reading for every anthropic agent (#146): the 5 h / 7 d windows
// are an account fact, not an agent fact.
const accountUsage = new AccountUsage({
  enabled: curiaConfig.usage.account_bars,
  probeModel: curiaConfig.usage.probe_model,
  // The credential curia OWNS, not the environment and not `~/.claude` (#648).
  // The probe is also the anthropic lane's liveness signal: a `setup-token`
  // credential has no refresh that can fail, so a 401 here is the honest
  // evidence that it died.
  credentials: anthropic,
  onTerminal: (outcome) => dispatcher.holdCredentialLane(outcome),
  log,
})
// The account probe above spends quota and remains optional. This metadata
// request does not, so credential detection survives that display switch and an
// idle fleet. Both probes report into the same provider-keyed hold.
const anthropicHealth = new AnthropicCredentialHealth({
  credentials: anthropic,
  probeModel: curiaConfig.usage.probe_model,
  onTerminal: (outcome) => dispatcher.holdCredentialLane(outcome),
  log,
})
// The context %'s denominator, looked up live per model id (#178). Not gated by
// `account_bars`: that switch exists because the account probe spends quota,
// and this lookup spends none.
const modelWindows = new ModelWindows({ credentials: anthropic, log })

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
  post: (ticket, text, opts) => (bridge ? bridge.postStatus(ticket, text, opts) : null),
  edit: (ids, text, opts) => (bridge ? bridge.editStatus(ids, text, opts) : false),
  remove: (ids) => (bridge ? bridge.deleteStatus(ids) : null),
  // The thread-name state glyph (#199): the status line derives the state,
  // the bridge renders it. With the bridge down the flag is dropped — the
  // next transition retries, and the name is display only.
  flag: (ticket, state) => (bridge ? bridge.flagTicket(ticket, state) : null),
  get: (id) => reduction.get(id),
  log,
  meters: metersFor,
})
statusLine.start()
let mapSnapshot = null
reduction.onEvent = (ev) => {
  mapSnapshot?.invalidate()
  statusLine.onEvent(ev)
}
// escalation id -> { resolve, reject } — ephemeral, dies with the process. The
// reject half is #458's: the daemon ends every call in here with a tool ERROR
// before it exits, rather than letting the call die unannounced.
const pending = new Map()
const renderRetries = new Map() // escalation id -> timeout handles — ephemeral, rebuilt on boot

let bridge = null

// The credential watch (#380). It lives here rather than beside the probe
// because it needs both the reduction, which remembers what was already said, and
// the bridge, which is where the operator reads. A warning that reaches neither
// is the log line this ticket exists to replace.
//
// `bridge` is read per call rather than captured: it is null at boot, it is
// replaced whole by the wedge watchdog (#56), and a watch holding the dead
// instance would announce into nothing for the rest of the process.
const tokenWatch = new TokenWatch({
  probe: () => probeWatchedCredentials(),
  entries: () => reduction.standingTokenWarnings(),
  entryFor: (key) => reduction.tokenWarning(key),
  journal: (type, detail) => reduction.journal(type, detail),
  announce: (text) => (bridge ? bridge.announce(text).then(() => true) : false),
  log: (line) => log(line),
})
tokenWatch.start()
checkWatchedCredentials()

// The journal backup (#436, from #357 and ADR-0017). It sits beside the
// credential watch because it needs the same two things: the reduction, which
// remembers the alarm that still stands, and the bridge, which is where the
// operator reads. `bridge` is read per call for the reason the watch above reads
// it per call — it is null at boot and the wedge watchdog replaces it whole.
//
// The check is armed rather than the dump: a deploy restarts this process and
// rearms the timer, so a plain 24-hour timer would never fire on a box that
// deploys daily.
const journalBackup = new JournalBackup({
  dataDir: DATA,
  dbFile: path.join(DATA, JOURNAL),
  journal: (type, detail) => reduction.journal(type, detail),
  announce: (text) => (bridge ? bridge.announce(text).then(() => true) : false),
  standing: () => reduction.standingBackupAlarm(),
  log: (line) => log(line),
})
journalBackup.start()
// Detached, like the credential probe above: a dump is a child process, and a
// slow one must never hold up a boot whose other duties do not need it.
journalBackup.pass().catch((e) => log(`the journal backup check failed (${e.message})`))

// #190: one control character anywhere in a message makes journalctl print
// `[NNNB blob data]` and drop the words, so the streamed `docker build` output
// this function also carries is cleaned before it is written. The timestamp is
// built outside format(), which would read a `%s` in it as a specifier.
function log(...args) {
  console.log(`[${new Date().toISOString()}] ${readable(format(...args))}`)
}

// ---- the three deaths that say goodbye (#458, deciding #426) ----------------
//
// A blocked call dies with this process, and until #458 it died in silence: a
// codex agent holding an `ask_human` is told nothing and waits out a deadline a
// day away. So the daemon speaks first. Every death it can see — the restart
// order, a deploy's SIGTERM, and a fatal crash — ends every blocked call with a
// tool ERROR, which is the failure #341's ladder needs to retry.
//
// The two wait registries are BOTH woken (#426): the escalation resolvers in
// this file, and the cross-check park inside the dispatcher. A goodbye that woke
// one would strand the other. See `goodbye.mjs` for the words and their rules.
//
// A SIGKILL reaches nobody, and nothing here pretends otherwise (#457).
function sayDaemonGoodbye(reason) {
  return sayGoodbye({
    reason,
    wake: {
      // Named for the operator reading the journal afterwards, not for the code.
      questions: wakeBlockedQuestions,
      parks: () => dispatcher.wakeParkedBuilders(),
    },
    journal: (type, detail) => reduction.journal(type, detail),
    log,
  })
}

// The exit is once, whatever arrives twice. A second SIGTERM, or a crash inside
// the goodbye, must not start a second goodbye or race a second exit code.
let dying = null
function goodbyeThenExit(reason, code, delayMs = 0) {
  if (dying) return dying
  dying = sayDaemonGoodbye(reason)
    .catch((e) => log(`the goodbye failed (${e.message}) — exiting anyway`))
    // A ref'd timer, so the exit code is this one rather than the 0 an empty
    // event loop would leave. `restart: on-failure` reads that difference.
    .then(() => { setTimeout(() => process.exit(code), delayMs) })
  return dying
}

// Death two: the deploy. `deploy/self-deploy.sh` recreates this container, so
// compose sends SIGTERM and waits out its default 10 s grace before the KILL.
// Nothing caught it before this, which made every deploy the silent death #371
// measured. The exit code is what the process left with no handler at all
// (128 + 15), so the supervisor reads a deploy exactly as it did.
const SIGTERM_EXIT_CODE = 143
process.on('SIGTERM', () => {
  log(`SIGTERM — saying goodbye to every blocked call, then exiting ${SIGTERM_EXIT_CODE}`)
  goodbyeThenExit('sigterm', SIGTERM_EXIT_CODE)
})

// #56: a transient gateway/socket error must not take dispatch, escalation,
// preview and reconcile down with it. Installed HERE, before the bridge and
// before boot reconcile, because the crash it exists for fires from a timer
// nobody in this file owns. Everything without a network signal still exits —
// the difference from today is one journal line before it does.
//
// Death three (#458): a fatal crash says goodbye on its way out. It is a last
// word and not a swallow — the daemon journals the fault, speaks, and exits 1
// exactly as it did — so an OOM or a bug reaches a blocked agent the way a
// deploy now does.
installCrashGuard({
  log,
  journal: (type, detail) => reduction.journal(type, detail),
  onFault: () => sayDaemonGoodbye('crash'),
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
      const r = reduction.get(record.id)
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
    reduction.attachRender(record.id, discord)
    clearRenderRetries(record.id)
  } catch (e) {
    // record stays open + REST-answerable; the armed retries try again (#261)
    reduction.journal('bridge_render_failed', { id: record.id, error: e.message })
    log(`render failed for ${record.id}: ${e.message}`)
  }
}

// Open + render + block until answered. Every ask_human and synthetic escalation
// funnels through here.
function openEscalation({ agent, ticket, kind, prompt, options, preview_url, recommended, files, diff, diff_error, payload, lint_flags, awaited = true }) {
  // `awaited` rides onto the RECORD (#489): the boot sweep asks it whether a
  // call was ever blocked here, and a flagged send opens a record no call holds.
  const { record, superseded_all } = reduction.open({ agent, ticket, kind, prompt, options, preview_url, recommended, diff, diff_error, payload, lint_flags, awaited })
  log(`escalation ${record.id} open (${kind}) agent=${agent} ticket=${ticket}${superseded_all.length ? ` supersedes ${superseded_all.map((r) => r.id).join(', ')}` : ''}`)
  // Every corpse this agent left, not just the newest (#336): a card left
  // rendered keeps asking a question nothing can receive an answer for.
  for (const dead of superseded_all) {
    pending.delete(dead.id) // the agent aborted that call; nobody is waiting on it
    clearRenderRetries(dead.id)
    if (bridge) bridge.markSuperseded(reduction.get(dead.id)).catch(() => {})
  }
  armRenderRetries(record)
  renderEscalation(record, files)
  // `awaited: false` is the flagged send (#418). No call is holding this
  // record — the agent's own call already returned the rejection it never read
  // — so no resolver is registered, and the answer takes the #139 hand-off:
  // recorded, queued as an agent note, and handed over on the agent's next tool
  // result. A resolver registered here would swallow the answer instead.
  if (awaited === false) return { record, answered: null }
  const answered = new Promise((resolve, reject) => pending.set(record.id, { resolve, reject }))
  // The goodbye (#458) rejects this promise, and not every caller awaits it:
  // `POST /escalate` without `?wait` drops it on the floor. A dropped rejection
  // is an unhandledRejection, which the #56 crash guard reads as a fault and
  // kills the process over — during a restart, with the wrong exit code. One
  // handler here makes the rejection handled for every caller that ignores it,
  // and changes nothing for the callers that await.
  answered.catch(() => {})
  return { record, answered }
}

// Resolves with { text, attachments } — the answer's images travel with it all
// the way to the agent's tool result (#34). Returns whether a resolver was
// actually waiting: false means the blocked call died with a previous daemon
// process, and the answer needs the #139 hand-off instead.
function settle(record, text, attachments = []) {
  clearRenderRetries(record.id)
  const waiter = pending.get(record.id)
  pending.delete(record.id)
  if (waiter) waiter.resolve({ text, attachments })
  return Boolean(waiter)
}

// The goodbye over the escalation resolvers (#458). Every blocked question ends
// with a tool ERROR, and the RECORD IS LEFT ALONE: it stays open, it stays
// rendered, and it stays answerable. The question is still the operator's to
// answer, and an answer that lands in the seconds after this takes the #139
// hand-off, which is exactly what a re-asked question reads back (#369).
function wakeBlockedQuestions() {
  let woken = 0
  for (const [id, waiter] of [...pending]) {
    pending.delete(id)
    waiter.reject(new Error(questionGoodbye()))
    woken += 1
  }
  return woken
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
  reduction.queueRecordedAnswer(record)
  // #457: the line says what is true of THIS agent, because the promise it
  // makes is not true of every one. `mcpLastAt` is #194's own record of the
  // agent having reached this daemon process. The composer and the whole reason
  // live in messaging.mjs.
  const w = dispatcher.agents.get(record.agent)
  notifyThread(record.ticket, handOffLine({
    agent: record.agent, ticket: record.ticket, harness: w?.harness ?? null,
    live: Boolean(w), spoken: Boolean(w?.mcpLastAt),
  }))
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

// ---- the typed payload gate (#418, ADR-0019) ---------------------------------
//
// One pass over an `ask_human` call: decide whether it is typed, lint the named
// fields, judge the result against the three-attempt cap, and compose what the
// record carries. Returns `{ stop }` when nothing opens — the rejection the
// agent rewrites from, or the dead end it cannot — and otherwise the fields
// `openEscalation` takes, plus any lint faults a flagged send carries.
//
// THE COMPOSED PROMPT IS THE RECORD'S PROMPT. `card.mjs` builds it, the bridge
// prints that same text, and everything downstream keeps reading one readable
// question: the timeline, the console, the inherited exchange (#374), the
// supersession hash (#336) and the recorded-answer match (#369). Two renderings
// of one payload would make the record a second account of what Discord showed
// rather than the thing itself.
const lintGate = new LintGate({ reduction, log })

function askHumanGate(agentName, kind, raw) {
  const typed = isTyped(raw)
  // THE FLIP (#422): every call takes the floor and the lint, whatever shape it
  // arrives in. An untyped call has no headline, so the floor refuses it and
  // names the fields it wants. `floorFaults` also names the three retired
  // fields, so an agent that wrote a `prompt` is told where that text goes
  // rather than watching it disappear.
  //
  // A call carrying NO prose at all is the one refusal that is final. `prompt`
  // was required by the schema before #418, and moving that check off zod
  // (#438) must not turn a blank call into a blank card in a human's thread.
  // There is no question in it to trap, and `hasText` below is what says so.
  const floor = floorFaults(kind, raw)
  const faults = [...floor, ...lintAskHuman(kind, raw)]
  // The prompt of a FLAGGED send, on the path where the cap is reached (#416).
  // A typed payload composes its card, and an untyped one carries the prompt it
  // wrote, because that is the only text it gave the operator to read.
  const prompt = typed ? composeCard(kind, raw) : raw.prompt ?? ''
  const verdict = lintGate.judge({
    agent: agentName, kind, faults, schema: floor.length > 0, hasText: hasText(raw), prompt,
    payload: typed ? raw : null,
  })
  if (verdict.reject || verdict.refuse) return { stop: verdict.reject ?? verdict.refuse }
  const open = typed
    ? {
      kind,
      prompt,
      options: optionLabels(raw),
      preview_url: raw.preview_url,
      // The ✅ All as recommended button is DERIVED now (ADR-0019), and the
      // `recommended` boolean is no longer read on a typed call.
      recommended: derivedRecommended(kind, raw),
      payload: {
        headline: raw.headline,
        questions: raw.questions,
        options: raw.options,
        detail: raw.detail,
        picture: raw.picture,
        table: raw.table,
        diagram: raw.diagram,
        timeline: raw.timeline,
        preview_url: raw.preview_url,
      },
    }
    : { kind, prompt, options: raw.options, preview_url: raw.preview_url, recommended: raw.recommended }
  return { open, flags: verdict.flags ?? null, note: verdict.note ?? null }
}

function compositeAskHumanGate(agentName, messages, maxMessages) {
  const schemaFaults = compositeSendSchemaFaults(messages, { maxMessages })
  const rendered = Array.isArray(messages) ? renderCompositeSend(messages) : []
  const deciding = rendered.at(-1)
  const decisionFaults = deciding?.deciding
    ? []
    : ['messages: `ask_human` needs one deciding message last. Use `notify` when no answer blocks the work.']
  const faults = [...compositeSendFaults(messages, { maxMessages }), ...decisionFaults]
  const verdict = lintGate.judge({
    agent: agentName,
    kind: 'composite-ask',
    faults,
    schema: schemaFaults.length > 0 || decisionFaults.length > 0,
    hasText: Boolean(deciding?.deciding && rendered.some((message) => message.content)),
    prompt: deciding?.content ?? null,
    payload: Array.isArray(messages) ? { messages } : null,
  })
  if (verdict.reject || verdict.refuse) return { stop: verdict.reject ?? verdict.refuse }

  const payload = deciding.payload
  return {
    open: {
      kind: deciding.kind,
      prompt: deciding.content,
      options: optionLabels(payload),
      preview_url: payload.preview_url,
      recommended: derivedRecommended(deciding.kind, payload),
      payload,
    },
    preludes: rendered.slice(0, -1),
    attachments: deciding.attachments,
    flags: verdict.flags ?? null,
    note: verdict.note ?? null,
  }
}

// handlers the bridge (and REST) call into — the single first-valid-wins gate
const gate = {
  get: (id) => reduction.get(id),
  // Every bridge post into a ticket thread buries that ticket's status lines
  // (#480); the bump moves each one back to the thread bottom.
  ticketPosted: (ticket) => statusLine.bump(ticket),
  // `review-gate` is here because a rejection IS feedback (#48): the human's own
  // words have to reach the agent, and a button cannot carry them. Approval
  // still comes from the ✅ button — see classifyReviewAnswer, where anything
  // else counts as a rejection.
  findOpenForThread: (threadId) =>
    reduction.openEscalations()
      .filter((r) => r.discord?.threadId === threadId)
      .filter((r) => ['free-text', 'choice', 'preview-review', REVIEW_KIND].includes(r.kind))
      .at(-1) ?? null,
  answer(id, { answer, attachments = [], by, via }) {
    const result = reduction.answer(id, { answer, attachments, by, via })
    if (result.ok) {
      log(`escalation ${result.record.id} answered via ${via}${attachments.length ? ` (+${attachments.length} attachment${attachments.length > 1 ? 's' : ''})` : ''}${result.routed_from?.length ? ` (routed from ${result.routed_from.join('→')})` : ''}`)
      const mapFogVerdict = result.record.action?.verb === MAP_FOG_VERB
      const delivered = mapFogVerdict ? false : settle(result.record, answer, attachments)
      if (bridge) bridge.markAnswered(result.record, { routedFrom: result.routed_from ?? [] }).catch(() => {})
      // The executing path of a button confirm (#94): button → HERE → the
      // dispatcher, never through the model. The record is already closed
      // (first-valid-wins above), so a second press can never execute twice.
      if (result.record.kind === CONFIRM_KIND) {
        dispatcher.onConfirmAnswered(result.record)
          .catch((e) => log(`confirm ${result.record.id} execution failed: ${e.message}`))
      } else if (mapFogVerdict) {
        dispatcher.onMapFogAnswered(result.record)
          .catch((e) => log(`empty-map verdict ${result.record.id} execution failed: ${e.message}`))
      } else if (!delivered || result.record.agent_died) {
        // A resolver on a dead agent's record "delivered" into a closed
        // transport — the agent_died mark, not the resolver, is the truth.
        handOffAnswer(result.record)
      }
      result.next_needs = reduction.openEscalations()
        .sort((a, b) => String(a.opened_at ?? '').localeCompare(String(b.opened_at ?? '')))
        .slice(0, 3)
        .map((record) => ({
          id: record.id,
          agent: record.agent,
          ticket: record.ticket,
          kind: record.kind,
          headline: record.payload?.headline ?? promptTitle(record.prompt),
        }))
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
    const result = reduction.cancel(id, { by })
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
    // `overseer_key` rides the command event when the overseer's own seam
    // wrapper issued it (#388). It is what lets a boot count the seam crossings
    // of a turn whose in-memory tally died with the process that held it.
    reduction.journal('command', {
      canonical, by: userId, ...(ctx.overseerKey ? { overseer_key: ctx.overseerKey } : {}),
    })
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
      if (w.ticket != null && reduction.threadForTicket(w.ticket) === threadId) return w.session
    }
    return null
  },
  // #118 item 4 / #108 item 22: the surface links escalation messages carry as
  // buttons. Each throws or returns null on a dead surface; the bridge fails
  // soft per button.
  async statusLinks(ticket, { settled = false } = {}) {
    const links = []
    const preview = previews.get(String(ticket))?.url ?? null
    if (preview && !settled) links.push({ label: '🔗 preview', url: preview })
    try {
      links.push({ label: 'chat', url: await attachApi.timelineLink(ticket, { archive: settled }) })
    } catch { /* unavailable while the session starts */ }
    const repo = reduction.repoForTicket(ticket)
    if (repo && /^\d+$/.test(String(ticket))) {
      links.push({ label: 'ticket', url: `https://github.com/${repo}/issues/${ticket}` })
    }
    return links
  },
  // #108 item 14, positive half: text in an agent-bound thread outside an open
  // escalation queues for the agent instead of being refused. Returns null
  // when no agent owns the thread — the bridge falls back to the overseer.
  queueAgentNote(threadId, text, by) {
    const agent = gate.agentForThread(threadId)
    if (!agent || !text?.trim()) return null
    // the ticket rides along so the bridge can spell out `cancel <n>` when the
    // note is command-shaped (#108 item 23, #170)
    const ticket = reduction.ticketForThread(threadId) ?? null
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
      last: reduction.lastAgentEvent(agent),
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
      reduction.journal('agent_note_refused', { agent, ticket, by, reason: 'agent not running' })
      return { agent, ticket, reads: false, id: null, after: null }
    }
    const { id, after } = reduction.queueAgentNote(agent, String(text).trim(), { by, instance })
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
  const { record, superseded_all } = reduction.open({
    agent: 'overseer', ticket, kind: CONFIRM_KIND, prompt, action, origin_thread_id: originThreadId ?? null,
  })
  log(`confirm ${record.id} open (${action.verb}) ticket=${ticket}${superseded_all.length ? ` supersedes ${superseded_all.map((r) => r.id).join(', ')}` : ''}`)
  for (const dead of superseded_all) {
    clearRenderRetries(dead.id)
    if (bridge) bridge.markSuperseded(reduction.get(dead.id)).catch(() => {})
  }
  // A confirm has no reminder and no expiry, but it still has to be SEEN: a
  // confirm that never rendered carries buttons nobody can press, so it takes
  // the same bounded render retry every other escalation takes (#261).
  armRenderRetries(record)
  renderEscalation(record)
  return record
}

function openMapQuestion({ ticket, kind, prompt, options, payload, action }) {
  const { record, superseded_all } = reduction.open({
    agent: 'overseer', ticket, kind, prompt, options, payload, action, awaited: false,
  })
  log(`empty-map question ${record.id} open for ${action.repo}#${action.map}`)
  for (const dead of superseded_all) {
    clearRenderRetries(dead.id)
    if (bridge) bridge.markSuperseded(reduction.get(dead.id)).catch(() => {})
  }
  armRenderRetries(record)
  renderEscalation(record)
  return record
}

function lapseEscalation(id, reason) {
  const r = reduction.lapse(id, reason)
  if (r.ok) {
    clearRenderRetries(id)
    log(`confirm ${id} lapsed (${reason})`)
    if (bridge) bridge.markLapsed(reduction.get(id)).catch(() => {})
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
  const recorded = reduction.recordedAnswerFor({ agent, kind: REVIEW_KIND, prompt: promptText })
  if (recorded && sameDigest(recorded.record.diff, diff)) {
    reduction.takeRecordedAnswer(recorded.record, recorded.note)
    log(`review gate ${recorded.record.id} replayed to ${agent} — the same summary over the same diff, answered already`)
    return Promise.resolve({ text: recorded.record.answer, status: 'answered', recorded: recordedAnswerLine(recorded.record) })
  }
  const { record, answered } = openEscalation({
    agent, ticket, kind: REVIEW_KIND, prompt: promptText, diff, diff_error: diffError,
  })
  // The final status separates an approval-or-rejection from a cancel — a
  // gate whose agent was torn down (#200) settles the same promise with an
  // "aborted" text, and the status is what tells the two apart.
  return answered.then(({ text }) => ({ text, status: reduction.get(record.id)?.status ?? 'answered' }))
}

// Ticket-thread bindings (#93): the reduction journals the truth, the bridge does
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
    reduction.releaseTicketThread(ticket, reason)
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
    const threadId = reduction.threadForTicket(handle)
    return threadId ? { ok: true, threadId } : { ok: false, reason: 'unbound' }
  },
}

// The recurring aistack sync (#695). It is built here, beside the credential
// watch and the journal backup, because it needs the same two things they do:
// the reduction, which remembers the alarm that still stands and when the last
// attempt finished, and the bridge, which is where the operator reads. `bridge`
// is read per call for the reason theirs is, and the dispatcher runs it on the
// tick it already has.
const aistackSync = new AistackSync({
  root: curiaConfig.dispatch.workspace_root,
  version: curiaConfig.aistack.cli_version,
  intervalHours: curiaConfig.aistack.interval_hours,
  journal: (type, detail) => reduction.journal(type, detail),
  announce: (text) => (bridge ? bridge.announce(text).then(() => true) : false),
  standing: () => reduction.standingAistackAlarm(),
  lastAt: () => reduction.lastAistackSyncAt(),
  log: (line) => log(line),
})

// The registration behind that sync (#706). It spawns the same two commands the
// README documents and hands the browser their device code and approval link;
// the approval itself stays a human act in a signed-in browser, which is what
// #695 settled. It journals, so a registration survives the restart the
// operator tends to do right after making one.
const aistackReg = new AistackRegistration({
  root: curiaConfig.dispatch.workspace_root,
  version: curiaConfig.aistack.cli_version,
  journal: (type, detail) => reduction.journal(type, detail),
  log: (line) => log(line),
})

// The one shape the Settings section reads (#706): the registration, plus what
// the recurring sync did last. Composed here rather than in either module,
// because the verdict belongs to the reduction and the flow belongs to the
// registration, and joining them anywhere else would give one of them a
// reference to the other for no other reason.
function aistackStatus() {
  const alarm = reduction.standingAistackAlarm()
  return {
    ok: true,
    ...aistackReg.status({ machine: reduction.registeredAistackMachine() }),
    sync: {
      last: reduction.lastAistackSync(),
      // The unrepaired failure, if there is one. Its message is the CLI's, and
      // the screen shows it beside the act that fixes it.
      alarm: alarm ? { message: alarm.message ?? null, at: alarm.at ?? null } : null,
      interval_hours: curiaConfig.aistack.interval_hours,
      cli_version: curiaConfig.aistack.cli_version,
    },
  }
}

const dispatcher = new Dispatcher({
  config: curiaConfig,
  aistack: aistackSync,
  routing: routingConfig,
  reduction,
  notify: notifyThread,
  // #485: the plain channel line for the stranded-map alarm. `bridge` is read
  // per call for the reason the backup's announce reads it per call — it is
  // null at boot and the wedge watchdog replaces it whole.
  announce: (text) => (bridge ? bridge.announce(text).then(() => true) : false),
  openConfirm,
  openMapQuestion,
  lapseEscalation,
  // a confirm outcome lands next to its own buttons, whatever thread they are in
  confirmNote: (record, text) => {
    if (bridge) bridge.notifyRecordThread(record, text).catch((e) => log(`confirm note for ${record.id} failed: ${e.message}`))
    else log(`[confirm ${record.id}] ${text}`)
  },
  // the synthetic line for the issuing thread's session (#94) — journalled,
  // drained into the next prompt by the overseer client
  overseerNote: (threadId, text) => reduction.addOverseerNote(threadId, text),
  askReview,
  threads,
  // The lint gate's two seams into the Stop hook (#418, #438). The hook is the
  // one lever that a codex agent cannot discard, so it is where a rejection the
  // agent never read becomes a question the operator still gets.
  lintRejection: (agentName) => lintGate.pending(agentName),
  sendFlagged: (agentName, held) => {
    const w = dispatcher.agents.get(agentName)
    const { record } = openEscalation({
      agent: agentName,
      ticket: w?.ticket ?? null,
      kind: held.kind,
      prompt: held.prompt ?? '',
      options: optionLabels(held.payload ?? {}),
      preview_url: held.payload?.preview_url,
      recommended: derivedRecommended(held.kind, held.payload ?? {}),
      payload: held.payload ?? null,
      lint_flags: held.faults,
      awaited: false,
    })
    return record
  },
  // The third seam (#420). A status line opens no record and asks nobody
  // anything, so a held one is POSTED rather than staged as a card. It carries
  // its own files no longer — the paths were checked on the call curia refused,
  // and re-reading them at the stop would read a worktree the agent has moved
  // on in. The words are what is held, and the words are what goes out.
  sendFlaggedNotify: async (agentName, held) => {
    const w = dispatcher.agents.get(agentName)
    const ticketFor = w?.ticket ?? null
    const body = composeNotify(held.payload ?? { message: held.prompt ?? '' })
    if (!bridge || ticketFor == null || !body) return false
    await bridge.notify(ticketFor, body, { as: speakerName(agentName) }).catch(() => {})
    await bridge.notify(ticketFor, smallPrint([
      `⚠️ \`${agentName}\` ended a turn holding a status line curia refused ${held.count} time(s) on the lint. curia posted it as it stands:`,
      ...held.faults,
    ].join('\n'))).catch(() => {})
    return true
  },
  // gate.cancel, not reduction.cancel: voiding a boot-orphaned confirm must also
  // settle it — release any pending resolver (a confirm opened via
  // POST /command inside the listen→boot-reconcile window has a live one) and
  // mark the Discord buttons.
  cancelEscalation: (id, opts) => gate.cancel(id, opts),
  // #642: the terminal link for a session no ticket names — the
  // `curia-auth-<provider>` login. Same publish-and-verify path as /attach, so
  // a link is never handed out over a surface /attach would refuse.
  attachSessionLink: (session) => attachApi.link(null, { session }),
  // #661: the console's own URL, at one of its screens. It is composed and NOT
  // probed, which is the one place this differs from the terminal link above.
  // The sidecar publishes its own Serve rule and the daemon has no channel to
  // ask it anything — the poll runs the other way — so there is nothing here to
  // verify. That costs nothing an operator can be hurt by: naming a URL is not
  // publishing a surface, and a link to a sidecar that is down fails in the
  // browser rather than exposing anything. The tailnet name is tailscale's own
  // answer, cached, never a hardcoded host.
  dashboardLink: async (hash = '') => {
    const base = await attachBase()
    return `https://${base}:${curiaConfig.dashboard.serve_port}/${hash}`
  },
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
  // What the pre-emptive hold judges (#384): one reading per provider, the same
  // one the dashboard's provider strip draws. A provider missing from this list
  // has no reading at all, and is never held.
  readings: providerReadings,
  dataDir: DATA,
  daemonPort: PORT,
  channelName: CHANNEL,
  // #389: the agents are the first holder to cut over to minted tokens. Null
  // here — no app on this box — keeps every agent on #155's PAT, which is what
  // ADR-0018 means by "no PAT comes out ahead of its replacement".
  minter: appMinter,
  // #642, ADR-0027: the daemon owns the codex model credential. It is
  // constructed HERE and not inside the Dispatcher for the reason the minter is:
  // it writes curia's real credential store and rotates a real refresh token, so
  // the process that actually runs the box is the one that hands it over.
  credentials: new CodexCredentialBroker({
    log,
    journal: (event, detail) => reduction.journal(event, detail),
  }),
  // The anthropic store (#648), constructed above beside the seed that fills it.
  anthropic,
  anthropicHealth,
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
reduction.onNotesExpired = (ev) => dispatcher.announceExpiredNotes(ev)

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
const timelineHosts = new Set()

async function resolveServeHosts() {
  const self = await tailnetSelf()
  for (const [set, ports] of [
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
  if (timelineHosts.size) return
  await resolveServeHosts()
}

const timelineIdentityCheck = (headers) =>
  identityRefusal(headers, { allow: identityAllow, hosts: timelineHosts })

// /attach continuation: daemon-side whitelist refusal + liveness check, then
// the same-origin Atlas URL. The dashboard owns the identity check and ttyd
// proxy. The legacy standalone terminal address stays withdrawn.
const attachApi = {
  // `session` names WHICH agent on this ticket (#164): the builder by default,
  // the cross-check reviewer when the caller asks for it. Everything below is
  // session-scoped already — ttyd picks a session from `?arg=`, and the
  // liveness check is a `has-session` — so this is the argument moving out, not
  // a second code path.
  async link(ticket, { session = `curia-${ticket}` } = {}) {
    if (!validSessionName(session)) throw new Error(`"${session}" is not a valid curia session name`)
    if (!(await hasSession(session))) throw new Error(`no live session \`${session}\` — /status to see what runs`)
    const { verified } = await probeTtyd({
      ttydPort: curiaConfig.attach.ttyd_port,
      index: curiaConfig.attach.index,
      log,
    })
    if (!verified) {
      try {
        await serveOff({ servePort: curiaConfig.attach.serve_port, log })
      } catch (e) {
        log(`WARNING: withdrawing the retired standalone terminal rule failed (${e.message}). Run \`tailscale serve --https=${curiaConfig.attach.serve_port} off\` by hand.`)
      }
      throw new Error(`the attach surface on ttyd port ${curiaConfig.attach.ttyd_port} is down or stale. Is the compose ttyd service up? See the daemon log.`)
    }
    const base = await attachBase()
    return atlasTerminalUrl(base, curiaConfig.dashboard.serve_port, session)
  },
  // The timeline half of /attach (#74): same liveness gate, then the surface
  // composes its own link — or refuses, independently of the terminal half.
  async timelineLink(ticket, { session = `curia-${ticket}`, archive = false } = {}) {
    if (!validSessionName(session)) throw new Error(`"${session}" is not a valid curia session name`)
    if (!archive && !(await hasSession(session))) throw new Error(`no live session \`${session}\`. Run \`/status\` to see what runs.`)
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
  journal: (type, detail) => reduction.journal(type, detail),
  dataDir: DATA,
})
dispatcher.previews = previews // constructed after the dispatcher; teardown + sweep read it here

// The timeline surface (#74, landing #73's pick). In-process, so it can read
// the two things only the daemon has: which harness a session runs, and the
// durable escalation record — the claude harness's transcript is SILENT while an
// ask_human blocks (measured on #74), so open escalations are overlaid from
// the reduction or the surface shows a working agent as idle at the exact moment
// a human is needed.
const overseerPanes = new OverseerPaneHost({
  reduction,
  repoRoot: path.dirname(ROOT),
  workspaceRoot: curiaConfig.dispatch.workspace_root,
  dataDir: DATA,
  daemonPort: PORT,
  daemonHost: GUEST_DAEMON_HOST,
  // Read PER PARKING DECISION, the same way and for the same reason as the
  // watch list below: `overseer.live_pane_cap` is in the reload's live set, so
  // a save moves it under a daemon that keeps running. A number captured here
  // would leave the screen reporting a cap nothing enforces.
  livePaneCap: () => curiaConfig.overseer.live_pane_cap,
  watchRepos: () => curiaConfig.watch.map((entry) => entry.repo),
  log,
})

const conversationRuntime = new ConversationRuntime({
  reduction,
  prepare: (session, role) => {
    if (role !== 'overseer') return null
    const key = consoleKeyForSession(session)
    if (!key) throw new Error(`the overseer conversation ${session} has no durable key`)
    return overseerPanes.ensure(key)
  },
  reopenCard: async (record) => {
    const { record: fresh, answered } = openEscalation({
      agent: record.agent,
      ticket: record.ticket,
      kind: record.kind,
      prompt: record.prompt,
      options: record.options,
      preview_url: record.preview_url,
      recommended: record.recommended,
      diff: record.diff,
      diff_error: record.diff_error,
      payload: record.payload,
      lint_flags: record.lint_flags,
    })
    return { id: fresh.id, answered }
  },
})

const timeline = new TimelineSurface({
  port: curiaConfig.timeline.port,
  servePort: curiaConfig.timeline.serve_port,
  index: curiaConfig.timeline.index,
  workspaceRoot: curiaConfig.dispatch.workspace_root,
  log,
  deps: {
    journal: (type, detail) => reduction.journal(type, detail),
    harnessFor: (session) => dispatcher.agents.get(session)?.harness
      ?? detectHarness(path.join(curiaConfig.dispatch.workspace_root, 'cfg', session)),
    // The dialog guard's composer veto (#75): a visible ready marker (#39)
    // says the pane is at its composer, so a dialog-footer phrase in the tail
    // is scrollback, not a dialog.
    composerFor: (harness) => routingConfig.harnesses[harness]?.readyRe ?? null,
    escalationsFor: (session) => reduction.openEscalations().filter((r) => r.agent === session),
    escalationHistoryFor: (session) => reduction.escalationsForAgent(session),
    landingFor: (session) => reduction.transcriptLanding(session),
    takeBack: (request) => conversationRuntime.takeBack(request),
    correct: (request) => conversationRuntime.correct(request),
    recordTurn: (request) => conversationRuntime.recordTurn(request),
    // The #151 identity check. The timeline is the daemon's own server, so it
    // carries the same predicate the terminal's proxy does, in-process.
    identityCheck: timelineIdentityCheck,
    // The console chat now sends through the same pane adapter as an agent.
    // This driver keeps the overseer's role-specific config and durable
    // identity. The host keeps its lifecycle separate from an agent's.
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
        sessionId: reduction.overseerSession(key) ?? null,
        // #708, ADR-0024: the message goes into the conversation's own live
        // pane. The host also preserves the conversation's durable identity.
        send: (text) => overseerPaneMessage(key, text),
      }
    },
  },
})
dispatcher.timeline = timeline // reconcile asserts/withdraws its serve rule alongside attach's

// The self-deploy seam (#270): the verb orders, a sibling container executes,
// resolvePending() below announces whichever outcome the sibling wrote.
const selfDeploy = new SelfDeploy({
  repoRoot: path.dirname(ROOT), dataDir: DATA, reduction, log, port: PORT,
  workRoot: curiaConfig.dispatch.workspace_root,
  parkOverseerPanes: () => overseerPanes.parkForDeploy(),
})

const router = new CommandRouter({ dispatcher, attach: attachApi, deploy: selfDeploy, log })

// The overseer CONTAINER's turn (#314, cut over by #315): the daemon posts the
// operator's message to the container and serves the verbs back to it over
// `/overseer/mcp`, so every effect crosses the same `gate.command` seam the
// slash verbs and REST use — journalled, logged and routed identically.
//
// Discord still uses the request boundary while the shared message renderer
// moves over. Atlas uses the hosted pane and keeps this client for config and
// transcript metadata during that cutover.
const overseerTurns = new OverseerTurns()
const overseerContainer = new OverseerClient({
  reduction,
  command: (text, ctx) => gate.command(text, 'overseer', ctx),
  workspaceRoot: curiaConfig.dispatch.workspace_root,
  port: curiaConfig.overseer.port,
  daemonPort: PORT,
  daemonHost: GUEST_DAEMON_HOST,
  turns: overseerTurns,
  // #678: the overseer is a model-credential consumer, and it takes a turn
  // whenever the operator speaks. That makes a failed turn the earliest thing
  // on this box that can know the anthropic credential died — the detector's
  // own schedule is ten minutes wide.
  //
  // The wire is deliberately thin: a failed turn reports THAT it failed, and
  // the detector decides WHETHER anything is wrong. There is no second caller.
  // The codex lane's signal is its own failing refresh, and a claude agent's
  // failed turn arrives as a pane, which is the pane classifier's.
  onModelCallFailed: () => dispatcher.checkAnthropicCredential({ trigger: 'overseer_turn' }),
  log,
})

// One browser conversation message (#333, on the pane lane since #708). The
// deleted-key refusal is the same one the turn lane carried: a key whose
// conversation is gone must never reach tmux, or the operator reads a tmux
// error about their own deleted chat.
async function overseerPaneMessage(key, text, { replay = false } = {}) {
  if (!reduction.hasConsoleConversation(key)) {
    throw new Error(`there is no conversation \`${key}\` — it was deleted, and its number is spent; open a new one from the Chat screen`)
  }
  const out = await overseerPanes.deliver(key, text, {
    onNote: (note) => log(`[overseer] ${key}: ${note}`),
    replay,
  })
  if (out.delivery?.status === 'not-sent') {
    throw new Error('curia is still on your last message — one message at a time in a conversation')
  }
  return out
}

// The turns the restart killed (#388, ADR-0015). Read HERE, before the listener
// binds and before the bridge starts, because after that a pending turn is one
// that is merely running. `bootAt` is the same instant: a conversation whose
// turn started after it is one the operator spoke to themselves.
const killedTurns = reduction.pendingOverseerTurns()
const bootAt = Date.now()

// ---- agent-facing MCP surface (#29 shape) ---------------------------------

// Outbound attachments (#34, widened past images by #430): an agent may publish
// files from its OWN worktree and the daemon's data dir, nothing else — the
// daemon holds a Discord token and a tailnet position, so an unbounded path
// here would turn `notify` into an exfiltration primitive for anything the box
// can read. An agent the dispatcher does not know (synthetic/lab callers, whose
// MCP URL the daemon did not write) falls back to the workspace root.
//
// #429: the roots are HOST paths, and every agent runs in a container that
// calls that same worktree `/workspace`. So the daemon states the mapping and
// attachments.mjs translates an absolute guest path before it checks
// containment. A caller with no known worktree — /escalate, /answer — gets no
// mapping, because it hands over host paths already.
function outboundFiles(agent, paths) {
  if (!paths?.length) return { files: [], refusals: [] }
  const known = dispatcher.agents.get(agent)
  const roots = [known?.wtPath ?? curiaConfig.dispatch.workspace_root, DATA]
  const guestRoot = known?.wtPath ? { guest: GUEST_WT, host: known.wtPath } : null
  return resolveOutboundFiles(paths, { roots, cwd: known?.wtPath, guestRoot })
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

// What the two tools that take files say about what they accept (#429, #430).
// One sentence, written once, because two wordings for one rule is two rules to
// keep true. It names the absolute form as well as the relative one: an agent
// reaches for its own absolute path first, and the old text — "local file paths
// inside your workspace" — pointed it straight at the form that got dropped.
// It also names the allowed types, from the same list the check enforces: an
// agent does not attach the diff it never learned it could send (#430).
const FILES_HINT = `Files inside your workspace for the human to DOWNLOAD: a screenshot, a render, a diff, a note. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}. Give a path relative to your workspace, or an absolute path under ${GUEST_WT}/.`

// The three visual fields of ADR-0026 (#640), declared once for the four tools
// that take them. One home, so a wording that drifts on one surface cannot say
// something else on another.
//
// The retired `visual` stays declared for the reason `prompt` does: zod strips
// a key it does not declare, and a stripped `visual` would take the agent's
// rows with it. Declared, it reaches the floor, which refuses the call and says
// where the rows go.
const VISUAL_SHAPE = {
  visual: z.string().optional().describe('RETIRED. Send `table` for a table, `diagram` for a drawing, or `picture` for an image. Curia refuses a call that carries this.'),
  picture: z.string().optional().describe('One image the human LOOKS AT in place: a screenshot, a render, a mock. A path, as `attachments` takes.'),
  table: z.string().optional().describe('A table, as rows. Curia writes the fence. At most 42 columns by 20 lines, and the columns must line up.'),
  diagram: z.string().optional().describe('An ASCII drawing, as rows. Curia writes the fence. At most 42 columns by 20 lines.'),
}

// `images` was renamed `attachments` by ADR-0026 (#640): the field has taken a
// .patch, a .diff, a .md, a .txt and a .log since it shipped, so the name has
// never been true. The old one stays declared so a call that carries it is
// named rather than stripped.
const ATTACHMENT_SHAPE = {
  images: z.array(z.string()).optional().describe('RETIRED. Send the same paths under `attachments`. Curia refuses a call that carries this.'),
  attachments: z.array(z.string()).optional().describe(FILES_HINT),
}

// Every path an outbound file arrives on, in one list (ADR-0026). `picture` is
// what a reader looks at and `attachments` is what a reader downloads, and both
// are files this box has to contain and hand to Discord. One helper, so neither
// one is dropped on the surface that forgot to name it.
const sentFiles = (raw, attachments) => [
  ...(raw?.picture ? [raw.picture] : []),
  ...(attachments ?? []),
]

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
  const drainNotes = () => reduction.takeAgentNotes(agent, dispatcher.agents.get(agent)?.instance ?? null).map((n) => ({
    type: 'text',
    text: `[${n.label ?? 'operator note'}${n.after ? `, after ${n.after}` : ''}] ${n.text}`,
  }))

  // The typed status line (#420, ADR-0019). The vocabulary is the card's, cut
  // down to what a line that asks nothing needs: the `message` is Grade B prose
  // and the `detail` is the Grade A spoiler.
  //
  // The KIND says what the operator must do, and nothing about how the agent
  // rates its own news. That is what keeps it checkable: `look` means a file or
  // a page is waiting for their eyes, `ask` means a reply is wanted, and
  // `progress` means neither. A set built on the agent's own weighting would be
  // a claim the payload cannot check, which is the fault ADR-0019 retired the
  // `recommended` boolean over.
  server.tool(
    'notify',
    'Fire-and-forget opening, working phase, or milestone for the human. Returns immediately.'
    + ' `kind` says what the operator must DO: `progress` needs nothing from them, `look` puts a file or a page in front of their eyes now, and `ask` wants a reply they can send whenever they get to it.'
    + ' An `ask` blocks nothing — use `ask_human` when you cannot go on without the answer.'
    + ' READ WHAT THIS CALL RETURNS. Curia lints your words and refuses the call when they break a rule. Rewrite the named field and call again. You get three attempts, and the fourth text goes out flagged.',
    {
      // Off zod for the reason the gate's `summary` is (#438): a -32602 dies in
      // silence on codex, where a named fault the gate returns is readable and
      // counted. The floor still requires it.
      message: z.string().optional().describe('What happened, in plain words, at most 600 characters. The thread reads this.'),
      kind: z.enum(NOTIFY_KINDS).optional().describe('What the operator must do: `progress` (nothing), `look` (open something now), `ask` (reply when they can). Defaults to `progress`.'),
      detail: z.string().optional().describe('Short FACTS, rendered as a spoiler. One line, 500 characters.'),
      ...VISUAL_SHAPE,
      opening: z.object({
        goal: z.string().optional().describe('Your reading of the ticket goal, in one line.'),
        first_step: z.string().optional().describe('Your first step, in one line.'),
      }).optional().describe('Your one work opening. Send it on the first notify call only.'),
      phase: z.union([
        z.object({
          icon: z.string().describe('Use 🧭, 💭, 🔨, 🚦, 🩹, or 🚢.'),
          label: z.string().describe('Current work in at most 20 characters. One line. Curia adds code marks.'),
        }),
        z.string().describe('Your working phase: explore, think, build, test, fix, or ship.'),
      ]).optional().describe('Edit routine progress into the live status line without adding a thread message.'),
      label: z.string().optional().describe('What you are doing now, in one line of at most 20 characters.'),
      ...ATTACHMENT_SHAPE,
    },
    async ({ attachments, ...raw }) => {
      if (raw.opening && reduction.hasAgentOpening(agent)) {
        return { content: [{ type: 'text', text: 'opening: already sent for this dispatch.' }] }
      }
      // The same gate as the other surfaces, on its own key, so a rejected
      // status line and a rejected question never spend each other's attempts.
      const floor = notifyFloorFaults(raw)
      const verdict = lintGate.judge({
        agent, kind: NOTIFY_KIND, faults: [...floor, ...lintNotify(raw)],
        schema: floor.length > 0, hasText: notifyHasText(raw), prompt: raw.message ?? null, payload: raw,
      })
      if (verdict.reject || verdict.refuse) {
        return { content: [{ type: 'text', text: verdict.reject ?? verdict.refuse }] }
      }
      const flags = verdict.flags ?? null
      const { files, refusals } = outboundFiles(agent, sentFiles(raw, attachments))
      reduction.journal('notify', {
        agent, ticket, ...raw, attachments: files.map((f) => f.attachment), refusals,
        ...(flags ? { lint_flags: flags } : {}),
      })
      if (raw.phase && typeof raw.phase === 'object') {
        reduction.journal('agent_phase', { agent, ticket, phase: raw.phase })
      } else if (raw.phase && raw.label) {
        reduction.journal('agent_progress', { agent, ticket, phase: raw.phase, label: raw.label })
      }
      if (raw.opening) {
        reduction.journal('agent_opening', { agent, ticket, ...raw.opening })
      }
      // The body is never empty here: a call with no words at all fails the
      // floor, and one that reaches the cap with none is the dead end the gate
      // refuses for good rather than posts.
      if (bridge) {
        let sends = raw.opening
          ? statusLine.settle().then(() => bridge.notify(ticket, composeOpening(raw.opening), { as: speaker }))
          : Promise.resolve()
        const body = composeNotify(raw)
        if (raw.message || raw.detail || hasVisualField(raw) || files.length) {
          sends = sends.then(() => bridge.notify(ticket, body, { files, as: speaker }))
        }
        // A flagged send is CURIA's fact about the agent's text, so curia says
        // it in its own voice, under the line it is about (ADR-0013) — the same
        // shape the ending report's flagged send takes (#419).
        if (flags?.length) {
          sends = sends.then(() => bridge.notify(ticket, smallPrint([
            `⚠️ curia sent this status line after ${flags.length} lint fault(s) the agent did not fix:`,
            ...flags,
          ].join('\n'))))
        }
        sends.catch(() => {})
      }
      const said = refusals.length ? `ok (${refusals.length} file(s) refused)\n${refusals.join('\n')}` : 'ok'
      const flagNote = verdict.note ? [{ type: 'text', text: flaggedNotifyText(flags) }] : []
      return { content: [...flagNote, { type: 'text', text: said }, ...drainNotes()] }
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
      reduction.journal('preview', {
        agent, ticket, dev_port, path: r.path ?? path ?? null,
        ok: r.ok, url: r.url ?? null, reason: r.reason ?? null,
      })
      if (!r.ok) return { content: [{ type: 'text', text: `preview refused — ${r.reason}` }, ...drainNotes()] }
      // #108 item 22: the preview is a BUTTON, and every publish posts a fresh
      // message, so an updated preview lands at the thread bottom instead of a
      // scroll-back hunt. Bot voice on purpose: link buttons are components,
      // which the speaker webhook cannot carry — and the composed link is
      // curia's record, not the agent's prose.
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
    'THE review gate: ask the human "is this done?" and BLOCK until they answer. curia shows them the pull request, the preview and the ticket — you do not pass links, it knows them. On approval you merge the pull request and then resolve the ticket. A rejection comes back as the human\'s own words: fix, commit, open_pull_request again, and call this again. If your diff changed a page — markup, styles, a component or a template — publish_preview FIRST: curia checks for one here, and a first call without it comes back asking for one.',
    {
      // #418, ADR-0019: `summary` and `charting` are Grade B block prose, and
      // the operator reads both on every ticket. Optional to zod for the same
      // reason `ask_human` is — a schema rejection must never trap a gate.
      summary: z.string().optional().describe('What you did — under ten SHORT lines, plain words, at most 600 characters. The human reads this on a phone and judges the diff itself through the links, so say what changed and stop: no methodology, no justifications, no restating the ticket. Do not paste links: curia composes every one of them — pull request, preview, ticket — from its own records, and a link you write is not evidence.'),
      charting: z.string().optional().describe('CONCRETE map changes you propose, as a numbered list — one line per change: ticket titles to create, fog lines to remove, edges to wire, anything to rule out of scope. At most 600 characters. Name each change; put full ticket bodies and long Decisions-so-far lines in the work you do AFTER approval, not here. Write "none" if there are none. A vague answer here makes the approval a rubber stamp.'),
      headline: z.string().optional().describe('The whole change in one line, at most 150 characters. It sits under the gate heading, so the operator reads it first.'),
      detail: z.string().optional().describe('Short FACTS, rendered as a spoiler. One line, 500 characters.'),
      ...VISUAL_SHAPE,
      tracker_writes: z.array(z.object({
        id: z.string().describe('Temporary stable id used by `after`. Curia displays a card number instead.'),
        title: z.string().describe('Exact proposed issue title.'),
        labels: z.array(z.string()).optional().describe('Every label proposed for this issue.'),
        after: z.array(z.string()).optional().describe('Ids of proposed issues that block this issue through native blocked-by edges.'),
      })).optional().describe('Every proposed tracker write. Curia validates edges, numbers items, and groups them into dispatch waves.'),
    },
    async (raw, extra) => {
      // The same gate as `ask_human`, keyed on the same agent-and-kind pair the
      // supersession key uses (#336), so a rejected gate and a rejected question
      // count apart.
      const floor = reviewFloorFaults(raw)
      const verdict = lintGate.judge({
        agent, kind: REVIEW_KIND, faults: [...floor, ...lintRequestReview(raw)],
        schema: floor.length > 0, hasText: hasText(raw), prompt: raw.summary ?? null, payload: raw,
      })
      if (verdict.reject || verdict.refuse) {
        return { content: [{ type: 'text', text: verdict.reject ?? verdict.refuse }] }
      }
      const stopKeepAlive = startKeepAlive(extra, `${agent}/review`)
      try {
        let charting = raw.charting ?? ''
        if (raw.tracker_writes?.length) {
          const writes = trackerWriteWaves(raw.tracker_writes)
          charting = [charting, writes].filter((part) => part.trim()).join('\n\n')
        }
        const r = await dispatcher.requestReview(agent, {
          summary: raw.summary ?? '', charting, body: composeReviewBody(raw),
          trackerWrites: raw.tracker_writes ?? null,
        })
        const flagNote = verdict.note ? [{ type: 'text', text: verdict.note }] : []
        return { content: [...flagNote, { type: 'text', text: r.text }, ...drainNotes()] }
      } finally {
        stopKeepAlive()
      }
    },
  )

  // The typed surface (#418, ADR-0019). One vocabulary of seven names, and this
  // kind takes a subset of it. Every field is OPTIONAL to zod on purpose: a zod
  // failure is JSON-RPC -32602, #416 measured that carriage dying in silence on
  // codex, and ADR-0005's rule is that a schema rejection never traps a
  // question. So curia checks the floor itself, counts the attempt, and sends
  // what text the call did carry rather than letting the transport eat it.
  server.tool(
    'ask_human',
    'Escalate a question to the human and BLOCK until an answer arrives. kind: free-text | choice | approve-reject | preview-review.'
    + ' Write the PARTS, not a card: `headline` is the whole decision in one line, and curia lays out the rest.'
    + ' Every call needs a `headline`. The untyped `prompt` is retired, and curia refuses a call that carries it.'
    + ' free-text is a ROUND — put every question in `questions`, give each a `recommendation`, and curia adds the ✅ All as recommended button when every one of them has it.'
    + ' choice takes `options`, each with a `label` and the `consequence` of picking it.'
    + ' READ WHAT THIS CALL RETURNS. Curia lints your words and refuses the call when they break a rule, and the refusal names the rule and quotes the text. Rewrite the named field and call again. You get three attempts, and the fourth text goes out flagged.',
    {
      // The two RETIRED fields (#422). They stay in the schema so that curia
      // can see one and name it. zod strips a key it does not declare, and a
      // stripped `prompt` would take the agent's whole question with it — the
      // silent loss this map forbids. Declared, they reach `floorFaults`, which
      // refuses the call and says where the text goes.
      prompt: z.string().optional().describe('RETIRED. Write `headline` and the parts instead. Curia refuses a call that carries this.'),
      recommended: z.boolean().optional().describe('RETIRED. Curia derives the ✅ button from `questions[]`. Curia refuses a call that carries this.'),
      kind: z.enum(['free-text', 'choice', 'approve-reject', 'preview-review']).optional(),
      // The typed fields.
      headline: z.string().optional().describe('The whole decision in one line. One line, no markdown, no link, 150 characters.'),
      questions: z.array(z.object({
        text: z.string().optional().describe('One question of the round. One line, 250 characters.'),
        recommendation: z.string().optional().describe('Your recommended answer to THIS question. One line, 300 characters.'),
        background: z.string().optional().describe('What this question rests on, in small print under its line. Block prose, 600 characters. Write one only where the question cannot be answered without it.'),
      })).optional().describe('free-text only: the round, one entry per question. Curia numbers them.'),
      options: z.union([
        // The bare-string form is RETIRED with the other two, and it is
        // declared for the same reason: seen, it is named and refused, and
        // stripped it would be a choice card that lost every option.
        z.array(z.string()),
        z.array(z.object({
          label: z.string().optional().describe('The choice, by its name. One line, 80 characters, which is what a select menu carries whole.'),
          handle: z.string().optional().describe('Short button text. One line, 20 characters. The card body keeps the full label and consequence.'),
          consequence: z.string().optional().describe('What picking this option costs. One line, 300 characters. Mandatory on a choice.'),
          example: z.string().optional().describe('One concrete case for this option. Block prose, 300 characters. Write one only where it earns its line.'),
          recommended: z.boolean().optional(),
        })),
      ]).optional(),
      detail: z.string().optional().describe('Short FACTS, rendered as a spoiler. One line, 500 characters. Reasoning belongs on the timeline, not here.'),
      ...VISUAL_SHAPE,
      timeline: z.boolean().optional().describe('Point the operator at the timeline for the reasoning. Curia composes the link.'),
      preview_url: z.string().optional(),
      ...ATTACHMENT_SHAPE,
      messages: z.array(z.record(z.string(), z.any())).optional().describe('One ordered composite send. Each entry has its own `format`, `label`, content fields, and `attachments`. At most four messages. Put the one deciding message last.'),
    },
    // `attachments` is bound aside, because the ANSWER carries a field of that
    // name too (#34): the files the human replied with.
    async ({ attachments: sent, messages, ...input }, extra) => {
      // #164: the reviewer asks nobody. ADR-0010 gives it one output — the
      // verdict — and a question in the ticket thread would put a second voice
      // in front of the operator on a ticket the reviewer is not building.
      const refused = dispatcher.toolRefusal(agent, 'ask_human')
      if (refused) return { content: [{ type: 'text', text: refused }] }
      let raw = input
      let kind = raw.kind ?? 'free-text'
      if (messages && (raw.images?.length || sent?.length)) {
        return { content: [{ type: 'text', text: '❌ curia refused this call. Put each file path in the `attachments` of the message it belongs to.' }] }
      }
      const composite = messages
        ? compositeAskHumanGate(agent, messages, curiaConfig.dispatch.messages_per_send ?? 4)
        : null
      const gated = composite ?? askHumanGate(agent, kind, raw)
      if (gated.stop) return { content: [{ type: 'text', text: gated.stop }] }
      const { open, flags, note } = gated
      kind = open.kind
      raw = open.payload ?? raw
      const decidingFiles = messages ? (gated.attachments ?? []) : sentFiles(raw, sent)
      // #165, ADR-0010: the FIRST question after a cross-check verdict is the
      // builder's judgement of it, and it lands as a second pull-request comment
      // under the verdict. Fire-and-forget on purpose — a gh round-trip must not
      // sit between the agent and the human it is asking.
      dispatcher.noteJudgement(agent, open.prompt)
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
      const recorded = reduction.recordedAnswerFor({ agent, ...open })
      if (recorded) {
        reduction.takeRecordedAnswer(recorded.record, recorded.note)
        log(`escalation ${recorded.record.id} replayed to ${agent} — the same question, answered already, note ${recorded.note.id} taken`)
        const lines = [recordedAnswerLine(recorded.record)]
        // The card is what shows a file, and no card opened. Said rather than
        // swallowed: an agent that thinks the operator saw a screenshot or a
        // diff reads the answer as being about it.
        const shown = decidingFiles
        if (shown.length) lines.push(`(curia opened no card, so the ${shown.length} file(s) you sent with this call were not shown.)`)
        return {
          content: [
            { type: 'text', text: `${lines.join('\n')}\n\n${recorded.record.answer}` },
            ...inboundContent(recorded.record.attachments ?? []),
          ],
        }
      }
      const preludeRefusals = []
      if (messages) reduction.journal('composite_send', { agent, ticket, messages })
      if (gated.preludes?.length) {
        for (const prelude of gated.preludes) {
          const outbound = outboundFiles(agent, prelude.attachments)
          preludeRefusals.push(...outbound.refusals)
          if (bridge) await bridge.notify(ticket, prelude.content, { files: outbound.files, as: speaker })
          else log(`[notify ticket-${ticket}] ${prelude.content}`)
        }
      }
      const { files, refusals } = outboundFiles(agent, decidingFiles)
      refusals.unshift(...preludeRefusals)
      const { record, answered } = openEscalation({ agent, ticket, ...open, lint_flags: flags, files })
      const stopKeepAlive = startKeepAlive(extra, record.id, promptTitle(open.prompt))
      // Images the human replies with come back as real content blocks, so the
      // picture lands in this agent's context without a Read round-trip (#34).
      const { text, attachments } = await answered.finally(stopKeepAlive)
      const refusalNote = refusals.length ? [{ type: 'text', text: `(curia refused ${refusals.length} outbound file(s): ${refusals.join('; ')})` }] : []
      // The flagged-send line rides the ANSWER (#416). The agent is told its
      // text went out with the faults on it, in the one result it was already
      // waiting for, so nothing about the send is silent.
      const flagNote = note ? [{ type: 'text', text: note }] : []
      // drainNotes runs AFTER the answer resolves: a note typed right behind a
      // button press rides the answer itself — the grace window's best case.
      return { content: [...flagNote, ...refusalNote, { type: 'text', text }, ...inboundContent(attachments), ...drainNotes()] }
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
    'Deliver the structured resolution for the ticket. Call exactly once, when the work is done and you have run the resolve protocol from your standing orders. curia verifies the resolution, repairs anything missing, and pushes your branch as a pull request; the reply tells you what it did.'
    + ' `headline` says what the work came to in one line, and it leads the report the thread reads.'
    + ' READ WHAT THIS CALL RETURNS. Curia lints your words and refuses the call when they break a rule, and the refusal names the rule and quotes the text. Rewrite the named field and call again.',
    {
      // The two MACHINE fields keep their zod types. They are not prose, no
      // grade reads them, and an agent that loses one to -32602 is still held
      // at the ending by the Stop hook, which is the backstop a question never
      // had (#438). `summary` moves off zod for the reason the gate's did.
      ticket: z.string(),
      status: z.enum(['resolved', 'blocked', 'aborted']),
      // #419, ADR-0019: the typed fields. `summary` is Grade B block prose, and
      // the headline, the detail and the visual are what #415's card-4 shape
      // gives an ending report.
      summary: z.string().optional().describe('What the work came to, in plain words, at most 600 characters. The thread reads this, and curia records it on the ticket.'),
      headline: z.string().optional().describe('What the work came to, in one line, at most 150 characters. No markdown and no link.'),
      detail: z.string().optional().describe('Short FACTS, rendered as a spoiler. One line, 500 characters.'),
      ...VISUAL_SHAPE,
      // ADR-0019 rule 3: a free record. No surface renders it and no lint reads
      // it, so it stays the one field an agent may shape for itself.
      details: z.record(z.string(), z.any()).optional(),
      // #421: the CROSS-CHECK REVIEWER's field, and nobody else's. A verdict is
      // a list of findings rather than one block of prose, and the severities
      // are what curia derives the verdict's grade from.
      findings: z.array(z.object({
        text: z.string().optional().describe('One finding: the file and the line, what is wrong, why it matters. Block prose, 600 characters.'),
        severity: z.enum(VERDICT_SEVERITIES).optional().describe('blocker (do not merge as it stands), concern (the operator decides), note (worth knowing).'),
        out_of_scope: z.boolean().optional().describe('True when the finding is real but sits beyond this ticket. The builder carries it into its charting.'),
      })).optional().describe('The cross-check reviewer only: one entry per finding. Send an empty list when the reading is clean.'),
    },
    async (result, extra) => {
      // The lint gate, BEFORE the park and before anything persists (#419). A
      // refused report has reported nothing: no journal line, no results file
      // and no word in the thread, so the agent rewrites and calls again.
      // Linting after the cross-check park would make an agent wait hours for a
      // rejection it could have read at once.
      //
      // The cross-check REVIEWER takes the VERDICT's shape here, not the
      // report's (#421). Its `report_result` is the verdict, which ADR-0019
      // lists as a surface of its own: a headline, the findings as a list, and
      // the summary that says what it read and what it ran. It was exempt from
      // this gate while that surface stayed untyped (#419), and the exemption
      // ends with the shape it was waiting for.
      //
      // ONE ledger key for both (`RESULT_KIND`). A reviewer makes no other
      // linted call, so nothing of its own can spend those three attempts, and
      // the Stop hook's report words fit a verdict as they stand.
      const reviewer = dispatcher.isReviewerSession(agent)
      const floor = reviewer ? verdictFloorFaults(result) : resultFloorFaults(result)
      const judged = lintGate.judge({
        agent, kind: RESULT_KIND, faults: [...floor, ...(reviewer ? lintVerdict(result) : lintResult(result))],
        schema: floor.length > 0, prompt: result.summary ?? null, payload: result,
        // A report always carries something a human can read: the status. So
        // the cap always ends in a flagged send, and the dead end a textless
        // question gets has no counterpart here. An ending that reaches the
        // thread flagged beats an ending that reaches it never.
        hasText: true,
      })
      if (judged.reject) return { content: [{ type: 'text', text: judged.reject }] }
      const flags = judged.flags ?? null
      // The gate's own flagged line speaks of a card and of an operator about
      // to answer. A report has neither, so the report says its own words.
      const flagNote = flags ? flaggedResultText(flags) : null
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
      const rec = reduction.journal('result', {
        agent, ...result, ticket: bound, ...(disagrees ? { reported_ticket: reported } : {}),
        // A flagged send rides the record too (#419). The escalation record has
        // carried `lint_flags` since #418, and the report is the other text the
        // lint can let through unfixed.
        ...(flags ? { lint_flags: flags } : {}),
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
      // #419: `composeResultReport` lays the report out. The agent writes the
      // parts and curia lays them out, which is the same rule the card follows
      // (ADR-0002 at the level of one message).
      if (bridge) {
        const pr = dispatcher.pullRequestUrlFor(agent)
        const tail = pr && !String(result.summary ?? '').includes(pr) ? `\n🔗 ${pr}` : ''
        // #421: a verdict is a list of findings, and `composeResultReport` can
        // render only a summary. A reviewer posting through the report shape
        // would drop every finding from the thread, which is the one thing this
        // map forbids: shortening must never lose information.
        const report = reviewer
          ? composeVerdictReport(result.status, result)
          : composeResultReport(result.status, result)
        bridge.notify(bound, `${report}${tail}`, { as: speaker }).catch(() => {})
        // A flagged send is CURIA's fact about the agent's text, so it is curia
        // that says it (ADR-0013). It rides a second message in the bot voice,
        // under the report it is about, rather than inside the agent's own.
        if (flags?.length) {
          bridge.notify(bound, smallPrint([
            `⚠️ curia sent this report after ${flags.length} lint fault(s) the agent did not fix:`,
            ...flags,
          ].join('\n'))).catch(() => {})
        }
      }
      const stopKeepAlive = startKeepAlive(extra, `${agent}/result`)
      try {
        const text = await dispatcher.onResult(agent, result)
        // The flagged line rides the result the agent is already waiting on
        // (#416), so nothing about the send is silent.
        const note = flagNote ? [{ type: 'text', text: flagNote }] : []
        return { content: [...note, { type: 'text', text }, ...drainNotes()] }
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
  option_handles: r.payload?.options?.map((option, index) => String(option?.handle ?? r.options?.[index] ?? '')) ?? null,
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
//
// TWO READERS take it (#384). The strip draws it, and the pre-emptive hold
// judges it — so the reading is taken once, in the meters' own camelCase, and
// the wire shape is composed from it below. A hold that read its own copy could
// name a percentage the bar beside it contradicts.
function providerReadings() {
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
  return [...out.values()]
}

// The same reading on the wire, in the snake_case `/overview` speaks.
function providerUsage() {
  return providerReadings().map((p) => ({ ...p, windows: p.windows.map(wireWindow) }))
}

// ---- the settings screen's two daemon reads (#265) ---------------------------

// The exit code `POST /restart` leaves with, and the pause before it takes it.
// The code is nonzero because `restart: on-failure` is what respawns this
// process: a clean exit is how the daemon stays down for a deploy. The pause is
// only long enough for the answer already written to leave the socket.
//
// The goodbye (#458) sits between the two, and it has a drain of its own for the
// errors it sends to the blocked calls. This pause is unchanged and still means
// what it says: it covers the restart ANSWER, which is written before either.
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
// The frontier and complete map snapshot are stamped readings. Reconcile
// refreshes the frontier. Journal events invalidate the map snapshot, and the
// next poll refreshes it with the GitHub credentials the daemon already holds.
//
// This route never scans the journal (#289). The recent outcomes and the gate's
// pull request are both reductions the reduction fills as events are written, so
// what one poll costs no longer rises with the history. The journal is still
// read whole ONCE per process, by the reduction's boot replay, which is what fills
// them. Every other section is memory or a stamped snapshot, except the
// context meter, which reads one transcript tail per live agent (#264). The
// map snapshot uses indexed journal questions when it refreshes.
mapSnapshot = new MapSnapshot(
  () => readMapSnapshot({
    watch: curiaConfig.watch,
    routing: routingConfig,
    github: { repoMaps, mapFrontier, blockedByOf },
    journal: reduction.questions,
  }),
  { onError: (error) => log(`map snapshot: refresh failed (${error.message}). The last snapshot stands`) },
)

async function overview() {
  mapSnapshot.invalidate()
  const mapSnapshotOnWire = await mapSnapshot.read()
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
  const open = reduction.openEscalations()
  let appInstallations = []
  let appError = null
  if (appMinter) {
    try { appInstallations = await appMinter.installations() } catch (e) { appError = e.message }
  }
  const installedOwners = new Set(appInstallations.map((row) => String(row.owner ?? '').toLowerCase()))
  return {
    at: new Date().toISOString(),
    daemon: {
      port: PORT,
      uptime_s: Math.round(process.uptime()),
      auto_dispatch: curiaConfig.dispatch.auto_dispatch,
      max_concurrent: curiaConfig.dispatch.max_concurrent,
      // The reloadable settings this process is RUNNING, and when it read them
      // (#362). The console compares these against the file it read: a
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
    // The model credentials (#642, ADR-0027). One row per consumer, plus the
    // live re-authentication card when a device login is in flight. It costs one
    // small file read, so it rides the poll like everything else here.
    //
    // THE DEVICE CODE IS IN THIS PAYLOAD and it is in no other surface. The
    // dashboard is published over the tailnet behind the operator's own
    // Tailscale login (#151); Discord gets the alarm and the link, never the
    // code, because a one-time auth code in a chat log is a credential in a
    // chat log.
    credentials: dispatcher.credentialsStatus(),
    github_app: {
      ...githubAppSetup.status(),
      configured: Boolean(appMinter),
      error: appError,
      owners: [...WATCHED_OWNERS].map((owner) => ({
        owner,
        installed: installedOwners.has(owner.toLowerCase()),
        install_url: 'https://github.com/settings/installations',
      })),
      manual_url: 'https://github.com/settings/apps/new',
    },
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
    // ONE VERDICT ABOUT THIS BOX (#706). The registration and the sync verdict
    // both come out of the journal, so this route and the Settings section read
    // the same facts and cannot disagree — and a restart, which is what an
    // operator does right after registering, does not blank either of them.
    aistack: aistackStatus(),
    // The pre-emptive holds standing now (#384). The strip above says how full
    // a window is; this says curia has STOPPED dispatching on it, which is a
    // different fact and gets its own banner.
    pre_cooling: dispatcher.preCoolings(),
    // The tickets the auto loop steps over (#444). Unlike the hold above, an
    // operator act is what ends each one, so the page counts these in Needs-you.
    dispatch_holds: dispatcher.dispatchHolds(),
    // The credential warnings still standing (#380). Discord states each one
    // once, at its instant, and this is where it STAYS until the operator mints
    // the token — the half a Discord line cannot do, because a message scrolls
    // away and a dying token does not.
    token_warnings: reduction.standingTokenWarnings(),
    events: reduction.recentEvents(),
    maps: mapSnapshotOnWire,
    frontier: dispatcher.frontierSnapshot(),
    // The last self-deploy and any in-flight one (#562): the outcome used to
    // live in a Discord line and a log only ssh could read, and the 4897a82
    // rollback was diagnosed over ssh because of it.
    deploy: selfDeploy.status(),
  }
}

// The browser conversations, on the wire (#333). Everything about the shape
// lives in usage.mjs beside `ctxOnWire`; what stays here is the wiring — the
// reduction this daemon holds and the overseer container's config dir and model.
function ticketConversationOnWire({ session, repo, ticket, title = null, model = null, state, reviewer = false, cfgDir = null, harness = null }) {
  const root = cfgDir ?? cfgDirFor(curiaConfig.dispatch.workspace_root, session)
  const detected = harness ?? detectHarness(root)
  const transcript = detected ? findTranscript(detected, root) : null
  let lastTurnAt = null
  try { if (transcript) lastTurnAt = new Date(fs.statSync(transcript).mtimeMs).toISOString() } catch { lastTurnAt = null }
  return {
    kind: 'ticket',
    key: reviewer ? `review:${repo}#${ticket}` : `${repo}#${ticket}`,
    session,
    label: title || `${repo}#${ticket}`,
    repo,
    ticket,
    state,
    reviewer,
    deletable: false,
    last_turn_at: lastTurnAt,
    ...ctxOnWire(() => agentMeters({
      harness: detected,
      cfgDir: root,
      model,
      routing: routingConfig,
      account: accountUsage,
      models: modelWindows,
      transcript,
    })),
  }
}

function consoleOnWire() {
  const cfgDir = overseerContainer.configDir
  const overseer = consoleConversationsOnWire({
    conversations: reduction.consoleConversationList(),
    sessionIdFor: (key) => reduction.overseerSession(key),
    droppedFor: (key) => reduction.droppedOverseerTurn(key),
    harness: detectHarness(cfgDir),
    cfgDir,
    model: overseerContainer.model,
    routing: routingConfig,
    account: accountUsage,
    models: modelWindows,
  }).map((conversation) => ({
    ...conversation,
    kind: 'overseer',
    state: 'conversation',
    deletable: true,
  }))
  const active = [...dispatcher.agents.values()].map((agent) => ticketConversationOnWire(agent))
  const activeSessions = new Set(active.map((conversation) => conversation.session))
  const archivedBySession = new Map()
  for (const outcome of reduction.retainedAgentConversations()) {
    const conversation = ticketConversationOnWire({
      ...outcome,
      state: outcome.state,
    })
    if (!activeSessions.has(conversation.session)) archivedBySession.set(conversation.session, conversation)
  }
  const archived = [...archivedBySession.values()]
  return [...active, ...overseer, ...archived]
}

async function searchIssues(repo, query) {
  const out = await gh([
    'search', 'issues', query, '--repo', repo, '--limit', '20',
    '--json', 'number,title,body,url,updatedAt,labels,repository',
  ], { repo })
  return JSON.parse(out).map((issue) => ({ ...issue, repo }))
}

function atlasSearch() {
  return new GlobalSearch({
    github: githubSearchSource({ repos: () => curiaConfig.watch.map((entry) => entry.repo), searchIssues }),
    journal: journalSearchSource(reduction.db.db),
    transcripts: transcriptSearchSource({
      workspaceRoot: curiaConfig.dispatch.workspace_root,
      overseerSessions: () => reduction.consoleConversationList().map((conversation) => ({
        key: conversation.key,
        session: reduction.overseerSession(conversation.key),
      })).filter((row) => row.session),
    }),
  })
}

// The GitHub App setup (#694, building the spec at #684).
//
// The daemon owns the conversion because the conversion response carries the
// private key, and neither the sidecar nor the browser may hold it. Adoption is
// in process: the minter this file holds is replaced, the dispatcher is handed
// the new one, and the installation read runs again — so the operator's next
// act is installing the app rather than restarting the box.
const appSetup = new AppSetup({
  daemonRoot: ROOT,
  log,
  adopt: ({ appId, key, keyFile }) => {
    appMinter = minterForAdopted({ appId, key, keyFile, log })
    dispatcher.minter = appMinter
    reduction.journal('github_app_adopted', { app_id: appId })
    log(`GitHub App ${appId} adopted in process — key at ${keyFile}`)
    checkAppInstallations()
  },
})

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
    reduction.journal('container_route_refused', { path: url.pathname, method: req.method })
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
    // A hosted conversation pane (#701). It carries no turn, because a pane
    // outlives every turn it takes: it names its conversation and proves the
    // name with the durable token the daemon wrote into its own connection
    // settings. The destination comes from that conversation and from nothing
    // on the request.
    const conversation = url.searchParams.get(OVERSEER_CONVERSATION_PARAM) ?? ''
    if (!id && conversation) {
      return serveConversationMcp({
        dataDir: DATA,
        key: conversation,
        presented: req.headers[TOKEN_HEADER],
        command: (text, ctx) => gate.command(text, 'overseer', ctx),
        log,
        refuse: (error) => {
          reduction.journal('overseer_conversation_refused', {
            key: conversation, from: fromContainer ? 'container' : 'loopback', presented: Boolean(req.headers[TOKEN_HEADER]),
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
    return serveVerbMcp({
      turns: overseerTurns,
      id,
      presented: req.headers[TOKEN_HEADER],
      log,
      refuse: (error) => {
        reduction.journal('overseer_turn_refused', {
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
      reduction.journal('agent_token_refused', {
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
      open_escalations: reduction.openEscalations(),
    })
  }

  // The dashboard's read (#262). Loopback only, and absent from AGENT_ROUTES,
  // so the container-facing listener refuses it before it reaches here.
  if (url.pathname === '/overview' && req.method === 'GET') {
    return json(200, await overview())
  }

  if (url.pathname === '/search' && req.method === 'GET') {
    try {
      return json(200, await atlasSearch().query(url.searchParams.get('q')))
    } catch (e) {
      return json(400, { error: e.message })
    }
  }

  if (url.pathname === '/github-app/start' && req.method === 'POST') {
    const { name, redirect_url: redirectUrl } = await readBody(req)
    try {
      const started = githubAppSetup.start({ name, redirectUrl })
      reduction.journal('github_app_setup_started', { expires_at: started.expires_at })
      return json(200, started)
    } catch (e) {
      return json(400, { error: e.message })
    }
  }

  if (url.pathname === '/github-app/complete' && req.method === 'GET') {
    try {
      const completed = await githubAppSetup.complete({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
      })
      reduction.journal('github_app_setup_completed', { app: completed.app, replay: !completed.ok })
      return json(200, completed)
    } catch (e) {
      reduction.journal('github_app_setup_failed', { error: e.message })
      return json(400, { error: e.message })
    }
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
    const record = escId ? reduction.get(escId) : null
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
    const key = reduction.openConsoleConversation()
    log(`console: opened browser conversation ${key}`)
    return json(200, { key, session: sessionForConsoleKey(key) })
  }

  // The delete. The number stays spent and the transcript stays on disk — see
  // reduction.deleteConsoleConversation. A key that is not a live conversation is a
  // 409 rather than a silent success, because the page may be showing a list
  // another device has already changed.
  if (url.pathname === '/console/delete' && req.method === 'POST') {
    const key = String((await readBody(req)).key ?? '')
    if (!isConsoleKey(key)) return json(400, { error: `\`${key}\` is not a browser conversation key` })
    if (!reduction.deleteConsoleConversation(key)) {
      return json(409, { ok: false, error: `there is no conversation \`${key}\` — it may already be deleted` })
    }
    // The tool identity goes with the conversation (#701). A pane still
    // running on the old token loses the verbs on its next call, which is what
    // a spent number should mean at the transport too.
    revokeConversationToken(DATA, key)
    log(`console: deleted browser conversation ${key} — its number is spent`)
    return json(200, { ok: true, key })
  }

  if (url.pathname === '/escalate' && req.method === 'POST') {
    const body = await readBody(req)
    const agent = body.agent ?? 'synthetic'
    // Same containment as the MCP path: /escalate is loopback-only, but it must
    // not be the softer way to hand the bridge an arbitrary file.
    const { files } = outboundFiles(agent, body.attachments ?? body.images ?? body.files)
    // `?wait` is what makes this call a blocked one, so it is also what the
    // record says about itself (#489). Without it the caller has its answer
    // already — the id — and the boot sweep must not read this record as an
    // agent parked in a call.
    const waits = Boolean(url.searchParams.get('wait'))
    const { record, answered } = openEscalation({
      agent, ticket: body.ticket ?? 'unknown',
      kind: body.kind ?? 'approve-reject', prompt: body.prompt ?? '(no prompt)',
      options: body.options, preview_url: body.preview_url, files, awaited: waits,
    })
    if (waits) {
      const { text, attachments } = await answered
      return json(200, { id: record.id, answer: text, attachments })
    }
    return json(200, { id: record.id })
  }

  if (url.pathname === '/answer' && req.method === 'POST') {
    const { id, answer, attachments, by, via } = await readBody(req)
    // Attachment paths get read and inlined into an agent's context, so they
    // pass the same containment gate as outbound attachments rather than being
    // trusted because the caller reached loopback.
    const { files } = outboundFiles('rest', attachments)
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
    reduction.journal('agent_done', {
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
    mapSnapshot.invalidate()
    await mapSnapshot.read()
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
  // the daemon re-reads both files and takes every setting the settings screen
  // writes, without the restart that used to be phase two of every save.
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
  // ---- the GitHub App setup (#694) ---------------------------------------
  //
  // Two routes, and between them the browser learns a manifest and a state and
  // nothing else. The conversion response never crosses back: what the second
  // route answers is the set of facts already public on the app's own settings
  // page, plus where to install it.
  if (url.pathname === '/app/setup' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}))
    try {
      return json(200, appSetup.begin({ name: body?.name, redirectUrl: body?.redirect_url }))
    } catch (e) {
      if (e?.refusal) return json(409, { ok: false, error: e.message })
      throw e
    }
  }
  if (url.pathname === '/app/convert' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}))
    try {
      return json(200, await appSetup.convert({ code: body?.code, state: body?.state }))
    } catch (e) {
      reduction.journal('github_app_setup_failed', { error: e.message, refusal: Boolean(e?.refusal) })
      log(`the GitHub App setup failed: ${e.message}`)
      // A refusal is the operator's own to fix and reads as one; anything else
      // is this box failing, and it answers 500 so the two never read the same.
      return json(e?.refusal ? 409 : 500, { ok: false, error: e.message })
    }
  }

  // ---- the aistack registration (#706) -----------------------------------
  //
  // Four routes, and none of them can carry the bearer: the read composes a
  // status out of a device code, a link, a hostname and the reduced sync
  // verdict, and the two acts spawn the CLI and answer what it said. The token
  // stays in the file the CLI writes under curia's HOME.
  if (url.pathname === '/aistack' && req.method === 'GET') {
    return json(200, aistackStatus())
  }
  if (url.pathname === '/aistack/register' && req.method === 'POST') {
    const out = await aistackReg.begin()
    return json(out.ok === false ? 409 : 200, out.ok === false ? out : aistackStatus())
  }
  if (url.pathname === '/aistack/cancel' && req.method === 'POST') {
    const out = aistackReg.cancel()
    return json(out.ok === false ? 409 : 200, out.ok === false ? out : aistackStatus())
  }
  if (url.pathname === '/aistack/optin' && req.method === 'POST') {
    const out = await aistackReg.optIn()
    if (out.ok === false) return json(409, out)
    return json(200, { ok: true, said: out.said, ...aistackStatus() })
  }

  if (url.pathname === '/reload' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}))
    const by = named(body?.by)
    const decline = (reason, detail) => {
      reduction.journal('config_reload_declined', { by, reason, ...detail })
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
    curiaConfig.overseer.live_pane_cap = nextCuria.overseer.live_pane_cap
    for (const [type, model] of Object.entries(nextRouting.defaults)) routingConfig.defaults[type] = model
    for (const [name, m] of Object.entries(nextRouting.models)) routingConfig.models[name].active = m.active
    configLoadedAt = new Date().toISOString()

    if (applied.includes('watch')) {
      checkWatchedCredentials()
      // #392: and the overseer's token for an owner this save has just added.
      // The tick would reach it within 60 s. Doing it here is what makes
      // watching a repo of a brand new owner an ordinary save, with nothing
      // recreated and nothing else edited.
      dispatcher.refreshOverseerCredentials().catch((e) => log(`the overseer credential refresh failed (${e.message})`))
    }
    // The one captured setting. Only re-armed if the loop is running: before
    // boot reconcile finishes there is no timer, and arming one here would
    // start dispatching against a fleet nobody has reconciled yet.
    if (applied.includes('dispatch.poll_interval_s') && dispatcher.autoTimer) dispatcher.startAutoLoop()

    reduction.journal('config_reloaded', { by, keys: applied })
    if (applied.length) mapSnapshot.read()
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
  //
  // Death one of #458's three: the blocked calls get their goodbye between the
  // answer and the exit. It costs this route the drain — a quarter of a second,
  // and only when somebody was actually blocked.
  if (url.pathname === '/restart' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}))
    const by = typeof body?.by === 'string' ? body.by : 'loopback'
    reduction.journal('restart_requested', { by, exit_code: RESTART_EXIT_CODE })
    log(`restart requested by ${by} — exiting ${RESTART_EXIT_CODE} so the supervisor respawns this process`)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, by, exit_code: RESTART_EXIT_CODE }), () => {
      goodbyeThenExit('restart', RESTART_EXIT_CODE, RESTART_DELAY_MS)
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
    .then(() => timeline.start())
    // boot reconcile (#33): re-derive live agents from GitHub + tmux + journal,
    // sweep orphans, release dead claims, void restart-orphaned overseer
    // confirms, assert the attach + timeline surfaces — then start the auto
    // loop (a no-op while auto_dispatch is false). Not gated on the bridge.
    .then(() => dispatcher.reconcile({ boot: true }))
    .then(() => mapSnapshot.read())
    .then(() => {
      log('boot reconcile done')
      dispatcher.startAutoLoop()
      // The boot sweep (#489, #499), AFTER the reconcile that adopted the panes:
      // the sweep asks each stranded agent for its harness and its last contact,
      // and before adoption there is no agent to ask. The reconcile also re-adopts
      // the reviewers, which is what a parked builder's own ticket is read
      // against. A failure costs the parked agents nothing they did not already
      // have.
      return dispatcher.sweepStrandedPanes({
        silent: lastDeathWasSilent,
        hasResolver: (id) => pending.has(id),
        since: lastBootAt,
      }).catch((e) => log(`the boot sweep failed: ${e.message}`))
    })
    .catch((e) => log(`boot reconcile failed: ${e.message} — POST /reconcile to retry`))
})

// restart recovery: an open escalation that never rendered re-arms the retries
// it has not used yet — measured from esc_open, so a restart re-arms the rest
// of the window rather than starting a fresh one (#261)
for (const r of reduction.openEscalations()) {
  log(`recovered open escalation ${r.id} (${r.kind}) agent=${r.agent} ticket=${r.ticket}`)
  if (!r.discord) armRenderRetries(r)
}

// #270: if this boot is the far side of a self-deploy, wait for the sibling's
// verdict and announce it. The bridge is usually up seconds before the sibling
// finishes its 10s-stability window; if it is not, the journal line still
// lands and the announce falls back to the log.
// The same announcer serves run()'s own post-hand-off watch (#562): a refused
// merge never restarts the daemon, so no boot-time pass would announce it.
selfDeploy.announce = (text) => (bridge ? bridge.announce(text) : Promise.resolve())
selfDeploy.resolvePending({ announce: selfDeploy.announce })
  .catch((e) => log(`deploy resolution failed: ${e.message}`))

// #388, ADR-0015: the turn the restart killed is sent again, never retyped. The
// pass waits for the overseer container to answer its health check and, for a
// Discord conversation, for the bridge to come back — the two things a deploy
// takes down beside this process. It runs off the boot rather than inside it:
// nothing else waits for it, and a conversation with nothing pending costs one
// journal read.
// #710, ADR-0024: whatever killed this daemon killed every pane with it, and a
// routine deploy recreates the overseer service on purpose. That is a FORCED
// PARK, and the journal has to be told: a conversation the cap still counts as
// live holds a pane that no longer exists. Recorded before the replay below,
// because a replay rehydrates a pane and the count has to be honest first.
overseerPanes.reconcile()
  .catch((e) => log(`the pane reconcile failed: ${e.message}`))
  .then(() => replayKilledTurns({
    killed: killedTurns,
    reduction,
    bootAt,
    probe: () => probeOverseer({ port: curiaConfig.overseer.port }),
    // A turn already in flight on this key means the operator got here first —
    // on either lane. #710 put the browser conversation in a pane, and this pass
    // runs off the boot for up to two minutes while it waits for the container,
    // so a message sent during that wait must not have an older one land behind
    // it.
    live: (key) => overseerContainer.busy.has(key) || overseerPanes.busy(key),
    discord: {
      ready: () => Boolean(bridge),
      // Optional on purpose: the wedge watchdog throws the bridge away and builds
      // a new one, so a bridge that was up when the wait ended can be gone here.
      say: (threadId, text) => bridge?.sayInThread(threadId, text) ?? false,
      replay: (threadId, prompt) => bridge?.replayOverseerTurn(threadId, prompt, replayLine()) ?? false,
    },
    // #710: the browser conversation is a pane, so the message goes back in the
    // way every other one does — the same door, the same deleted-key refusal, the
    // same completion signal. It carries `replay` so the drop rules can see that
    // curia has already sent this message again once and never do it twice.
    browser: { replay: (key, prompt) => overseerPaneMessage(key, prompt, { replay: true }) },
    log,
  })).catch((e) => log(`the killed-turn replay failed: ${e.message}`))

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
  const open = reduction.openEscalations().length
  const line = `-# curia started · ${COMMIT} · ${open} open escalation${open === 1 ? '' : 's'} recovered`
  b.announce(line).catch((e) => log(`startup announcement failed: ${e.message}`))
}

// The announcement can only ever be made AFTER the bridge is back, because
// Discord is the surface being announced about — there is no second channel to
// the phone. So the honest contract is: journal + /state while it is down, one
// line in the channel once it works again.
function onBridgeHealth(ev) {
  reduction.journal('bridge_health', {
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
  const open = reduction.openEscalations()
  const held = open.length
    ? `${open.length} open question${open.length > 1 ? 's' : ''} stayed answerable throughout (${open.map((r) => r.id).join(', ')}).`
    : 'No question was open at the time.'
  const text = `⚠️ Discord bridge was down for ${Math.round(downMs / 1000)}s and is back. ${held}`
  reduction.journal('bridge_recovered', { down_ms: downMs, open: open.map((r) => r.id) })
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
          get: (ticket) => reduction.threadForTicket(ticket),
          bind: (ticket, threadId) => reduction.bindTicketThread(ticket, threadId),
          // #197: an explicit dispatch typed in another thread moves the ticket
          rebind: (ticket, threadId, reason) => reduction.rebindTicketThread(ticket, threadId, reason),
          release: (ticket, reason) => reduction.releaseTicketThread(ticket, reason),
          // the dispatch backstop (#140): the last binding, released or not
          last: (ticket) => reduction.lastThreadForTicket(ticket),
          // the same two, thread first (#257): who holds this thread now, and
          // who held it last. The boot pass that settles an ending's name asks
          // both — the second says the thread is curia's, the first says it is
          // free to settle.
          ticketOf: (threadId) => reduction.ticketForThread(threadId),
          lastTicketOf: (threadId) => reduction.lastTicketForThread(threadId),
          // the label's repo field (#235), read lazily off the journal
          repoOf: (ticket) => reduction.repoForTicket(ticket),
          // a lazy thread still opens with its tracker title (#690)
          titleOf: (ticket) => reduction.titleForTicket(ticket),
        },
        log,
        onHealth: onBridgeHealth,
      })
      return b.start().then(() => {
        bridge = b
        bridgeLaunching = false
        // re-render any recovered escalation that has no message yet, and confirm
        // recovered ones that do are still answerable (message ids in the record)
        for (const r of reduction.openEscalations()) {
          if (!r.discord) renderEscalation(r)
        }
        announceStart(b)
        // #380 rule 4: a credential warning measured while there was no bridge
        // is not said yet. Nothing is re-probed — the reduction already holds
        // every reading this process took, so a bridge that flaps costs GitHub
        // nothing. Never fails a start.
        tokenWatch.flush().catch((e) => log(`the held credential warnings did not land: ${e.message}`))
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
      reduction.journal('bridge_wedged', { down_ms: downMs })
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

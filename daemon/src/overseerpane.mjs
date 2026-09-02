// A live overseer conversation uses the same tmux pane boundary as an agent.
// The pane is only a cache. The reduction keeps the durable Claude session,
// while this host owns the overseer lifecycle and authority policy.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  capturePane, hasSession, listSessions, newSession, sendText, killSession,
  paneShowsActiveTurn,
} from './tmux.mjs'
import {
  MCP_SERVER_NAME, OVERSEER_CONTAINER_MODEL, OVERSEER_MCP_PATH,
  checkoutNote, overseerConfigDirFor, overseerHomeFor, overseerProcessEnv,
} from './overseerturn.mjs'
import { AnthropicCredentialStore, writeClaudeCredentials } from './credentials.mjs'
import { pathsOf } from './paths.mjs'
import { isConsoleKey, sessionForConsoleKey } from './attach.mjs'
import {
  carryOverseerTranscript, conversationHomeFor, conversationMcpUrl,
  ensureConversationToken, writeConversationConnection,
} from './overseeridentity.mjs'
import { TOKEN_HEADER } from './agenttoken.mjs'
import { agentEnv, seedConfigDir } from './workspace.mjs'
import { buildSystemPrompt, checkoutReport } from './overseerprompt.mjs'
import { execFileP } from './exec.mjs'
import { SIGNALS } from './messaging.mjs'
import { DEFAULT_OVERSEER } from './overseerservice.mjs'

export const OVERSEER_CONTAINER = 'curia-overseer-1'
const OVERSEER_PANE_PREFIX = 'curia-overseer-'
const CONSOLE_KEY_RE = /^console-[1-9][0-9]*$/
const CLAUDE_READY_RE = /(?:⏵⏵|bypass permissions)/i

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForClaudePane(name, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let pane = ''
  while (Date.now() < deadline) {
    pane = await capturePane(name)
    if (CLAUDE_READY_RE.test(pane)) return pane
    await sleep(250)
  }
  throw new Error(`overseer pane ${name} did not reach its composer`)
}

const defaultPane = {
  has: hasSession,
  list: listSessions,
  start: newSession,
  ready: waitForClaudePane,
  send: sendText,
  park: killSession,
  capture: capturePane,
}

function shellWord(value) {
  const word = String(value)
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

export function overseerPaneName(key) {
  const identity = String(key)
  if (CONSOLE_KEY_RE.test(identity)) return `curia-${identity}`
  if (/^\d+$/.test(identity)) return `curia-overseer-${identity}`
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return `${OVERSEER_PANE_PREFIX}${digest}`
}

export function overseerPaneSession(key) {
  const identity = String(key ?? '')
  if (isConsoleKey(identity)) return sessionForConsoleKey(identity)
  if (/^\d+$/.test(identity)) return `curia-overseer-${identity}`
  throw new Error(`"${identity}" is not an overseer conversation key`)
}

export function overseerPaneCommand({ repoRoot, container, session, sessionId, resume }) {
  const runner = path.join(repoRoot, 'daemon', 'bin', 'curia-overseer-pane.mjs')
  const identityFlag = resume ? '--resume' : '--session-id'
  const identity = sessionId ?? session
  return [
    'docker', 'exec', '-it', shellWord(container),
    'node', shellWord(runner), identityFlag, shellWord(identity),
  ].join(' ')
}

export async function runningOverseerContainer({ repoRoot, exec = execFileP }) {
  const compose = path.join(repoRoot, 'deploy', 'compose.yaml')
  const { stdout } = await exec('docker', ['compose', '-f', compose, 'ps', '-q', 'overseer'], {
    cwd: repoRoot,
    timeout: 10_000,
  })
  const container = stdout.trim()
  if (!container) throw new Error('the shared overseer container is not running')
  return container
}

// The overseer's copy of the anthropic credential (#867): the store is
// `cfg.paths.anthropicStore`, which only the daemon reads, and the copy lands in
// the config directory the container mounts.
export function installOverseerPaneCredential(storeFile, configDir) {
  const record = new AnthropicCredentialStore({ file: storeFile }).read()
  if (!record) {
    return `${SIGNALS.warn} there is no anthropic credential for this pane: ${storeFile} holds none. Run reauth anthropic`
  }
  writeClaudeCredentials(configDir, record)
  return null
}

export function prepareOverseerPane({ cfg, sessionId, resume = false, deps = {} }) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('the overseer pane needs a durable session id')
  const root = cfg.dispatch.workspace_root
  const paths = pathsOf(cfg)
  const configDir = overseerConfigDirFor(root)
  // The conversation's own project directory (#701). The daemon has already
  // written this pane's `.mcp.json` file here, under the session id both sides
  // hold, so the pane picks up its tool identity without ever being told which
  // conversation it is.
  const home = conversationHomeFor(overseerHomeFor(root), sessionId)
  const seed = deps.seed ?? seedConfigDir
  const systemPrompt = deps.systemPrompt ?? buildSystemPrompt
  const installCredential = deps.installCredential ?? installOverseerPaneCredential
  const processEnv = deps.processEnv ?? overseerProcessEnv
  fs.mkdirSync(home, { recursive: true })
  seed(configDir, home, null, 'claude', { sandboxed: true })
  const note = installCredential(paths.anthropicStore, configDir)
  const prompt = systemPrompt({
    shell: true,
    checkoutsRoot: paths.overseerRepos,
    repos: cfg.watch.map((entry) => entry.repo),
  })
  const identityFlag = resume ? '--resume' : '--session-id'
  return {
    cwd: home,
    env: {
      ...processEnv(),
      ENABLE_TOOL_SEARCH: '0',
      ...agentEnv(configDir, 'claude', { sandboxed: true }),
    },
    args: [
      '--model', OVERSEER_CONTAINER_MODEL,
      '--append-system-prompt', prompt,
      '--dangerously-skip-permissions',
      identityFlag, sessionId,
    ],
    note,
  }
}

export async function runOverseerPane(options, { spawnProcess = spawn } = {}) {
  const launch = prepareOverseerPane(options)
  if (launch.note) console.log(launch.note)
  const child = spawnProcess('claude', launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: 'inherit',
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`the overseer pane ended on ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

// ---- the checkout pass a pane message starts on (#708, ADR-0024) -----------
//
// ADR-0014 gives the checkout tree ONE owner, and it is the overseer container:
// the clones are fetched on its read-only token, and two owners would race on
// one fetch. The HTTP turn ran the pass inside its own request, in that
// container. A pane takes no HTTP turn, so the pass runs the way the container
// already offers it — `daemon/bin/curia-checkouts.mjs`, over `docker exec` —
// and the daemon reads the verdict off stdout. The daemon never fetches these
// clones itself, which would be the wrong token and the second owner at once.
//
// IT NEVER REFUSES THE MESSAGE, for the reason `syncCheckouts` never refuses a
// turn: a chat that will not answer is no way to find out why a fetch failed.
// What it must never do is let a stale checkout read as a fresh one, so a pass
// that could not run at all comes back as one FAILED verdict per watched repo,
// and the report the model reads names every one of them as stale.
const CHECKOUT_PASS_TIMEOUT_MS = 600_000

// One verdict per watched repo, whatever the pass answered. A repo the pass
// never mentioned is a repo nobody fetched, and silence about it would be the
// one failure the verdict exists to prevent.
export function completeVerdicts(pass, repos, why) {
  const seen = new Map((pass.repos ?? []).map((r) => [r.repo, r]))
  return repos.map((repo) => seen.get(repo) ?? {
    repo,
    ok: false,
    cloned: false,
    error: why,
    fetchedAt: null,
    staleSince: null,
  })
}

export async function containerCheckoutPass({
  repoRoot, repos, container = OVERSEER_CONTAINER,
  execFile = execFileP, now = () => new Date(),
}) {
  const runner = path.join(repoRoot, 'daemon', 'bin', 'curia-checkouts.mjs')
  let pass = { repos: [], removed: [] }
  let why = null
  try {
    const { stdout } = await execFile('docker', ['exec', container, 'node', runner], {
      maxBuffer: 16 * 1024 * 1024, timeout: CHECKOUT_PASS_TIMEOUT_MS, killSignal: 'SIGTERM',
    })
    pass = JSON.parse(stdout)
    if (pass.error) why = String(pass.error).split('\n')[0]
  } catch (e) {
    why = String(e.stderr || e.message || e).trim().split('\n')[0] || 'the checkout pass answered nothing'
  }
  return {
    root: pass.root ?? null,
    at: pass.at ?? now().toISOString(),
    removed: pass.removed ?? [],
    repos: completeVerdicts(pass, repos, why ?? 'the checkout pass returned no verdict for this repo'),
    why,
  }
}

// ---- what one pane message says --------------------------------------------
//
// The HTTP turn put the checkout verdict in the system prompt and the queued
// notes in front of the operator's words. A pane holds ONE system prompt for
// its whole life, so the per-message facts have to ride in the message itself —
// which is also why the message goes in as one bracketed paste: it has lines in
// it, and a literal newline would submit the verdict as a turn of its own.
//
// THE ORDER IS FACTS, THEN NOTES, THEN THE OPERATOR. The verdict is the frame
// every read in the answer happens inside, the notes are what curia did while
// the model was not looking, and the operator's words are last so the thing
// being answered is the thing nearest the answer.
export function paneMessageText({ checkouts, notes = [], prompt, now = () => new Date() }) {
  const parts = [checkoutReport(checkouts, { now })]
  if (notes.length) parts.push(notes.map((t) => `[curia: ${t}]`).join('\n'))
  parts.push(String(prompt))
  return parts.join('\n\n')
}

export class OverseerPaneHost {
  constructor({
    reduction,
    workspaceRoot,
    repoRoot,
    dataDir,
    log = console.log,
    daemonPort = 0,
    daemonHost = 'host.docker.internal',
    pane = defaultPane,
    containerId = () => runningOverseerContainer({ repoRoot }),
    newSessionId = crypto.randomUUID,
    livePaneCap = 3,
    watchRepos = () => [],
    startTimeoutMs = 90_000, messageTimeoutMs = 30 * 60_000, settlePollMs = 1_000,
    now = () => new Date(),
    deps = {},
  }) {
    this.reduction = reduction
    this.workspaceRoot = workspaceRoot
    this.repoRoot = repoRoot
    this.dataDir = dataDir
    this.daemonPort = daemonPort
    this.daemonHost = daemonHost
    this.log = log
    const paneOverrides = [deps.hasSession, deps.newSession, deps.capturePane, deps.sendText]
      .some(Boolean)
    this.pane = paneOverrides ? Object.create(pane) : pane
    if (deps.hasSession) this.pane.has = deps.hasSession
    if (deps.newSession) this.pane.start = deps.newSession
    if (deps.capturePane) this.pane.capture = deps.capturePane
    if (deps.sendText) this.pane.send = deps.sendText
    this.containerId = containerId
    this.newSessionId = newSessionId
    this.livePaneCap = livePaneCap
    // Read the watch list for each message. Curia app can change the list while the
    // daemon and a pane remain live.
    this.watchRepos = watchRepos
    this.startTimeoutMs = startTimeoutMs
    this.messageTimeoutMs = messageTimeoutMs
    this.settlePollMs = settlePollMs
    this.now = now
    this.identity = {
      ensureToken: ensureConversationToken,
      writeConnection: writeConversationConnection,
      carryTranscript: carryOverseerTranscript,
      ...deps,
    }
    this.checkoutPass = deps.checkoutPass ?? containerCheckoutPass
    this.onComplete = deps.onComplete ?? (async () => {})
    this.live = new Map()
    this.lanes = new Map()
    this.capacityLane = Promise.resolve()
    // The conversations with a message in flight RIGHT NOW. The killed-turn
    // replay reads it: a conversation the operator is already talking to must
    // not have an older message landed behind their words (#388's rule, on the
    // pane lane).
    this.inFlight = new Set()
  }

  busy(key) {
    return this.inFlight.has(String(key))
  }

  // `livePaneCap` may be a number or a function, and index.mjs passes a
  // function: `overseer.live_pane_cap` is in the reload's live set, so the
  // number a park is taken against has to be the one configured NOW. A cap that
  // reads as anything but a positive whole number falls back to the default
  // rather than parking everything or nothing.
  #cap() {
    const n = Number(typeof this.livePaneCap === 'function' ? this.livePaneCap() : this.livePaneCap)
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_OVERSEER.live_pane_cap
  }

  send(key, text) {
    const identity = String(key)
    return this.#queue(identity, () => this.#withCapacity(() => this.#send(identity, text)))
  }

  // The conversation's tool identity, ready before the process that uses it
  // (#701, ADR-0024).
  //
  // MINTED ONCE AND READ BACK AFTER THAT. A rehydrated pane gets the same token
  // its predecessor held, because the conversation is the durable thing and the
  // pane is a cache in front of it. So a restart, a park, and a deploy all leave
  // the identity where it was, and none of them widens it: the token opens the
  // overseer verb catalogue and the route it reaches is the conversation's own.
  //
  // The pane never carries the key, so its connection settings land in the
  // project directory named by the session id, which is the one handle both
  // sides hold.
  #arm(key, sessionId) {
    const home = conversationHomeFor(overseerHomeFor(this.workspaceRoot), sessionId)
    const token = this.identity.ensureToken(this.dataDir, key)
    this.identity.writeConnection({
      home,
      url: conversationMcpUrl({
        host: this.daemonHost, port: this.daemonPort, key, mcpPath: OVERSEER_MCP_PATH,
      }),
      token,
      serverName: MCP_SERVER_NAME,
      header: TOKEN_HEADER,
    })
    // A conversation bound before #701 recorded its transcript in the one
    // shared overseer home, and a resume only finds a session under the project
    // directory it was recorded in.
    this.identity.carryTranscript({
      configDir: overseerConfigDirFor(this.workspaceRoot), sessionId, home,
    })
    return home
  }

  ensure(key) {
    const identity = String(key)
    return this.#queue(identity, () => this.#withCapacity(() => this.#ensure(identity).then(({ name }) => name)))
  }

  #withCapacity(operation) {
    const pending = this.capacityLane.catch(() => {}).then(operation)
    this.capacityLane = pending
    return pending
  }

  #queue(identity, operation) {
    const previous = this.lanes.get(identity) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(operation)
    this.lanes.set(identity, pending)
    pending.finally(() => {
      if (this.lanes.get(identity) === pending) this.lanes.delete(identity)
    }).catch(() => {})
    return pending
  }

  async #send(key, text) {
    const { name } = await this.#ensure(key)
    const result = await this.pane.send(name, text)
    const current = this.live.get(name)
    if (current) current.touchedAt = Date.now()
    return result
  }

  async #ensure(key) {
    if (CONSOLE_KEY_RE.test(key) && this.reduction.hasConsoleConversation?.(key) === false) {
      throw new Error(`there is no conversation \`${key}\`. Open a new one from Chat`)
    }
    const name = overseerPaneName(key)
    let session = this.reduction.overseerSession(key)
    const resume = Boolean(session)
    const created = !session
    if (!session) {
      session = this.reduction.pendingOverseerSession?.(key)
      if (!session) {
        session = this.newSessionId()
        this.reduction.reserveOverseerSession?.(key, session)
      }
    }

    let present = await this.pane.has(name)
    if (present && created) {
      if (this.reduction.pendingOverseerSession?.(key)) {
        await this.pane.ready?.(name)
      } else {
        await this.pane.park(name)
        present = false
      }
    }
    if (!this.live.has(name)) await this.#makeRoom(name)
    if (!present || created) {
      const home = this.#arm(key, session)
      const container = await this.containerId()
      await this.pane.start({
        name,
        cwd: home,
        role: 'overseer',
        authority: 'overseer',
        keepOpen: false,
        shellCmd: overseerPaneCommand({ repoRoot: this.repoRoot, container, session, resume }),
      })
      await this.pane.ready?.(name)
    }
    if (created) this.reduction.bindOverseerSession(key, session)
    if (!present) {
      this.reduction.journal?.(resume ? 'overseer_pane_resumed' : 'overseer_pane_started', {
        key, session: name, session_id: session,
      })
    }
    this.live.delete(name)
    this.live.set(name, { key, session, touchedAt: Date.now() })
    return { name, session }
  }

  // Room for one more pane, taken from the least recently used IDLE one.
  //
  // The order is `this.live`, which is re-inserted on every ensure and so is a
  // monotonic use order rather than a clock. That matters: these events land
  // inside one millisecond often enough that a timestamp would tie, and a tie
  // falls back to insertion order — the one order that is wrong, because a
  // conversation speaking for the second time would read as the oldest pane
  // there.
  //
  // IDLE IS THE WHOLE RULE (#710). Parking a pane mid-message would kill a turn
  // the operator is waiting on to make room for one they just sent, and neither
  // would get an answer. So a working pane is skipped and the next-oldest parks
  // instead, and a cap where EVERY pane is working parks nothing: one pane over
  // the cap for the length of a message is a smaller failure than a
  // conversation cut off mid-answer.
  async #makeRoom(nextName) {
    const cap = this.#cap()
    while (this.live.size >= cap) {
      const victim = await this.#oldestIdle(nextName)
      if (!victim) {
        this.log(`[overseer] ${this.live.size} panes are live at a cap of ${cap}, and every one of them is mid-message — the next conversation starts anyway`)
        return
      }
      const conversation = this.live.get(victim)
      if (await this.pane.has(victim)) await this.pane.park(victim)
      this.live.delete(victim)
      this.#park({ key: conversation?.key ?? null, pane: victim, reason: 'capacity' })
    }
  }

  // The least recently used pane that is not working, or null. Oldest first,
  // because `this.live` is least-recently-used first and that order IS the
  // decision.
  async #oldestIdle(nextName) {
    for (const [name] of this.live) {
      if (name === nextName) continue
      if (this.inFlight.has(this.live.get(name)?.key)) continue
      if (!(await this.#active(name))) return name
    }
    return null
  }

  // The park is a RECORD as well as a kill. The journal is what makes the cap
  // count panes that exist: a boot reads it to learn which conversations the
  // last process left live (see `reconcile`).
  #park({ key, pane, reason }) {
    if (this.reduction.parkOverseerPane) this.reduction.parkOverseerPane({ key, pane, reason })
    else this.reduction.journal?.('overseer_pane_parked', { key, pane, reason })
  }

  // THE FORCED PARK A RESTART ALREADY TOOK (#710, ADR-0024).
  //
  // "A routine deploy recreates the overseer service and kills every pane inside
  // it, and that is a forced park." A deploy curia itself orders is recorded by
  // `parkForDeploy` on the way out, but nothing records a crash, a kill, or a
  // restart that came from outside — the same deploy recreates the daemon, so
  // this process dies with the panes it would have written down.
  //
  // It is recorded on the way back instead. Every conversation the journal still
  // calls live is asked whether its pane is really there: one that is gone is
  // parked as forced, and one that survived is taken back into this process's
  // count in the order the journal remembers, so a restart does not reset the
  // cap to zero in front of panes that are still running.
  //
  // Run at boot BEFORE the killed-turn replay: a replay rehydrates a pane, and
  // the count has to be honest first.
  async reconcile() {
    const parked = []
    for (const key of (this.reduction.livePaneKeys?.() ?? [])) {
      const name = overseerPaneName(key)
      let alive = false
      try { alive = await this.pane.has(name) } catch { alive = false }
      if (alive) {
        this.live.delete(name)
        this.live.set(name, { key, session: this.reduction.overseerSession(key) ?? null, touchedAt: Date.now() })
        continue
      }
      this.#park({ key, pane: name, reason: 'restart' })
      parked.push(key)
    }
    if (parked.length) {
      this.log(`[overseer] ${parked.length} conversation(s) were parked by the restart — each returns on its next message`)
    }
    return parked
  }

  async parkForDeploy() {
    const known = new Map(this.live)
    if (this.pane.list) {
      for (const name of await this.pane.list()) {
        if (name.startsWith(OVERSEER_PANE_PREFIX) || /^curia-console-[1-9][0-9]*$/.test(name)) {
          if (!known.has(name)) known.set(name, { key: null, session: null })
        }
      }
    }
    for (const [name, conversation] of known) {
      if (await this.pane.has(name)) await this.pane.park(name)
      this.#park({ key: conversation.key, pane: name, reason: 'deploy' })
    }
    this.live.clear()
  }

  // WHEN THE HARNESS IS DONE WITH THIS MESSAGE. The pane is the only witness:
  // there is no stream to end and no result message to read, so the answer comes
  // from the same pane text the classifiers already read — the harness shows an
  // active turn while it works and stops showing one when it stops.
  //
  // Two clocks, because two different things go wrong. A pane that never starts
  // a turn swallowed the message; a pane that never stops has a message that
  // will not end. Both are named, and both end in a signal.
  async #settle(session) {
    const startBy = this.now().getTime() + this.startTimeoutMs
    let started = false
    do {
      if (await this.#active(session)) { started = true; break }
      if (this.now().getTime() >= startBy) break
      await sleep(this.settlePollMs)
    } while (true)
    if (!started) {
      return { ok: false, why: `${session} never started a turn on the message` }
    }
    const endBy = this.now().getTime() + this.messageTimeoutMs
    do {
      if (!(await this.#active(session))) return { ok: true, why: null }
      if (this.now().getTime() >= endBy) break
      await sleep(this.settlePollMs)
    } while (true)
    return { ok: false, why: `${session} was still working ${Math.round(this.messageTimeoutMs / 1000)}s after the message` }
  }

  async #active(session) {
    try {
      return paneShowsActiveTurn(await this.pane.capture(session))
    } catch {
      // A pane that cannot be captured is a pane that is gone — a deploy, a
      // park, a killed session. The message is over either way, and the caller
      // reads the signal rather than a throw from a watcher nobody awaited.
      return false
    }
  }

  // ONE COMPLETE MESSAGE (#708, ADR-0024).
  //
  // Three things happen in this order, and the order is the ticket: the
  // checkout pass returns one verdict per watched repo, the notes curia queued
  // between messages come off the queue, and the two ride into the pane with
  // the operator's words as ONE bracketed paste. A pane holds one system prompt
  // for its whole life, so per-message facts have nowhere else to be.
  //
  // IT RETURNS WHEN THE MESSAGE IS IN, NOT WHEN THE ANSWER IS OUT. The answer
  // reaches the operator off the transcript, which the chat surfaces tail. What
  // the adapters need instead is one signal saying the harness is finished, and
  // that arrives later, exactly once, on `onComplete` and in the journal.
  //
  // A MESSAGE THAT DID NOT GO IN PUTS ITS NOTES BACK. The drain already
  // happened by then, and notes dropped on a failed send would be words the
  // operator is never told about — ADR-0024's "curia returns queued notes to
  // its queue", on the delivery path rather than the rewind.
  //
  // AND IT OPENS A TURN THE RESTART CAN FIND (#710, closing what #708 left).
  // ADR-0015 promises that a turn a restart kills is sent again, never retyped,
  // and the boot finds those turns by reading the journal for one the daemon
  // started and never ended. A pane message journalled no such pair, so a deploy
  // taken while the operator was waiting lost their words silently. It writes
  // the pair now, around the whole message: the prompt recorded is the
  // OPERATOR'S WORDS and not the composed paste, because a replay re-runs the
  // checkout pass and re-drains the notes rather than sending an hour-old
  // verdict a second time.
  deliver(key, prompt, { onNote = () => {}, replay = false } = {}) {
    const identity = String(key)
    return this.#queue(identity, () => (
      this.#withCapacity(() => this.#deliver(identity, prompt, { onNote, replay }))
    ))
  }

  async #deliver(key, prompt, { onNote, replay }) {
    const repos = this.watchRepos()
    const checkouts = await this.checkoutPass({
      repoRoot: this.repoRoot, repos, now: this.now,
    })
    await onNote(checkoutNote(checkouts))
    const notes = this.reduction.takeOverseerNotes?.(key) ?? []
    const text = paneMessageText({ checkouts, notes, prompt, now: this.now })
    const resumed = Boolean(this.reduction.overseerSession(key))
    const { name: session, session: sessionId } = await this.#ensure(key)
    // The turn opens BEFORE the write, because a message the pane took and this
    // process never saw finish is exactly the turn the boot has to find.
    const turn = crypto.randomUUID()
    this.reduction.beginOverseerTurn?.({ key, turn, prompt: String(prompt), replay })
    this.inFlight.add(key)
    const delivery = await this.pane.send(session, text, { paste: true })
    const current = this.live.get(session)
    if (current) current.touchedAt = Date.now()
    if (delivery?.status === 'not-sent') {
      for (const note of notes) this.reduction.addOverseerNote?.(key, note)
      const why = `${session} was still working, so curia did not send the message`
      const signal = await this.#signal({ key, session, sessionId, turn, ok: false, why })
      return { session, sessionId, resumed, checkouts, notes, delivery, completion: Promise.resolve(signal) }
    }
    this.reduction.journal?.('overseer_pane_message', {
      key, session, session_id: sessionId, notes: notes.length, stale: checkouts.repos.filter((r) => !r.ok).length,
    })
    // AND THE NOTES THIS MESSAGE CARRIED ARE BOUND TO THE OPERATOR'S TURN
    // (#702). A rewind takes the turn back, and ADR-0024's "curia returns
    // queued notes to its queue" holds there too — but an overseer note is
    // plain text with no id, so the turn that carried it out of the queue is
    // the only record that it left. The turn record itself is written by the
    // surface after this call returns and claims what is carried here.
    this.reduction.carryOverseerNotes?.(session, key, notes)
    // Detached on purpose: the surface that sent the message must not hold an
    // HTTP request open for the length of a model's work. The promise is
    // returned so a caller that DOES want to wait — a test, a replay — can.
    const completion = this.#settle(session)
      .then((out) => this.#signal({ key, session, sessionId, turn, ...out }))
    completion.catch(() => {})
    return { session, sessionId, resumed, checkouts, notes, delivery, completion }
  }

  // The one signal, emitted once per message and nowhere else.
  async #signal({ key, session, sessionId, turn = null, ok, why }) {
    const signal = { key, session, sessionId, ok, why: why ?? null, at: this.now().toISOString() }
    this.inFlight.delete(key)
    // And the turn closes with the signal, on every ending including the two
    // failures. A turn left open is one the NEXT boot reads as killed and sends
    // again.
    if (turn) this.reduction.endOverseerTurn?.({ key, turn, ok, why: signal.why })
    this.reduction.journal?.('overseer_pane_message_ended', {
      key, session, session_id: sessionId, ok, why: signal.why,
    })
    if (!ok) this.log(`[overseer] pane message on ${key} did not finish: ${signal.why}`)
    try {
      await this.onComplete(signal)
    } catch (e) {
      this.log(`[overseer] the completion signal for ${key} was not delivered: ${e.message}`)
    }
    return signal
  }
}

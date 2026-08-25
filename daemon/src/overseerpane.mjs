// The overseer pane host (#688). The conversation remains durable in the
// journal. A tmux pane is one live process for that conversation, hosted by
// docker exec inside the shared overseer container.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { hasSession, newSession, capturePane, sendText, paneShowsActiveTurn } from './tmux.mjs'
import {
  MCP_SERVER_NAME, OVERSEER_CONTAINER_MODEL, OVERSEER_MCP_PATH,
  checkoutNote, overseerConfigDirFor, overseerHomeFor, overseerProcessEnv,
} from './overseerturn.mjs'
import {
  AnthropicCredentialStore, anthropicStoreFile, writeClaudeCredentials,
} from './credentials.mjs'
import { isConsoleKey, sessionForConsoleKey } from './attach.mjs'
import {
  carryOverseerTranscript, conversationHomeFor, conversationMcpUrl,
  ensureConversationToken, revokeConversationToken, writeConversationConnection,
} from './overseeridentity.mjs'
import { TOKEN_HEADER } from './agenttoken.mjs'
import { agentEnv, seedConfigDir } from './workspace.mjs'
import { buildSystemPrompt, checkoutReport } from './overseerprompt.mjs'
import { execFileP } from './exec.mjs'
import { SIGNALS } from './messaging.mjs'

export const OVERSEER_CONTAINER = 'curia-overseer-1'
const DISCORD_KEY_RE = /^\d+$/
const CLAUDE_READY_RE = /(?:⏵⏵|bypass permissions)/

export function overseerPaneSession(key) {
  const value = String(key ?? '')
  if (isConsoleKey(value)) return sessionForConsoleKey(value)
  if (DISCORD_KEY_RE.test(value)) return `curia-overseer-${value}`
  throw new Error(`"${value}" is not an overseer conversation key`)
}

function shellArg(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'"'"'`)}'`
}

export function overseerPaneCommand({ repoRoot, sessionId, resume }) {
  const runner = path.join(repoRoot, 'daemon', 'bin', 'curia-overseer-pane.mjs')
  const identityFlag = resume ? '--resume' : '--session-id'
  return [
    'docker', 'exec', '-it', OVERSEER_CONTAINER,
    'node', shellArg(runner), identityFlag, shellArg(sessionId),
  ].join(' ')
}

export function installOverseerPaneCredential(workspaceRoot, configDir) {
  const record = new AnthropicCredentialStore({ workspaceRoot }).read()
  if (!record) {
    return `${SIGNALS.warn} there is no anthropic credential for this pane: ${anthropicStoreFile(workspaceRoot)} holds none. Run reauth anthropic`
  }
  writeClaudeCredentials(configDir, record)
  return null
}

export function prepareOverseerPane({ cfg, sessionId, resume = false, deps = {} }) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('the overseer pane needs a durable session id')
  const root = cfg.dispatch.workspace_root
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
  const note = installCredential(root, configDir)
  const prompt = systemPrompt({
    shell: true,
    checkoutsRoot: path.join(root, 'overseer', 'repos'),
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
    reduction, workspaceRoot, repoRoot, dataDir, log = console.log,
    daemonPort = 0, daemonHost = 'host.docker.internal',
    readyTimeoutMs = 45_000, readyPollMs = 250,
    watchRepos = () => [],
    startTimeoutMs = 90_000, messageTimeoutMs = 30 * 60_000, settlePollMs = 1_000,
    now = () => new Date(),
    deps = {},
  }) {
    this.reduction = reduction
    this.workspaceRoot = workspaceRoot
    this.repoRoot = repoRoot
    // Where the conversation tokens live (#701). Daemon-owned, and no container
    // mounts it: the daemon writes each token straight into its own pane's
    // connection settings.
    this.dataDir = dataDir
    this.daemonPort = daemonPort
    this.daemonHost = daemonHost
    this.log = log
    this.readyTimeoutMs = readyTimeoutMs
    this.readyPollMs = readyPollMs
    // The watch list is read PER MESSAGE, not held from boot: the settings
    // screen rewrites it, and a message must be told about the repos that are
    // watched NOW (#361's rule, on the pane lane).
    this.watchRepos = watchRepos
    // How long a message may take. `startTimeoutMs` is how long the pane has to
    // pick the message up at all; `messageTimeoutMs` is how long the harness may
    // then work. Both end in a completion signal that says what happened —
    // silence is the one outcome an adapter cannot render.
    this.startTimeoutMs = startTimeoutMs
    this.messageTimeoutMs = messageTimeoutMs
    this.settlePollMs = settlePollMs
    this.now = now
    this.deps = {
      hasSession, newSession, capturePane, sendText,
      checkoutPass: containerCheckoutPass,
      // ONE completion signal per message, and this is where it leaves (#708).
      // The adapters — Discord's status line, Atlas's chat — hang their
      // "finished" off this and nothing else.
      onComplete: async () => {},
      ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
      ensureToken: ensureConversationToken,
      writeConnection: writeConversationConnection,
      carryTranscript: carryOverseerTranscript,
      ...deps,
    }
    this.starting = new Map()
  }

  async #waitForComposer(session) {
    const deadline = Date.now() + this.readyTimeoutMs
    do {
      try {
        const pane = await this.deps.capturePane(session)
        if (CLAUDE_READY_RE.test(pane)) return
      } catch { /* the pane can appear after tmux returns */ }
      if (Date.now() >= deadline) break
      await sleep(Math.min(this.readyPollMs, deadline - Date.now()))
    } while (true)
    throw new Error(`${session} did not reach the overseer composer within ${this.readyTimeoutMs}ms`)
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
    const token = this.deps.ensureToken(this.dataDir, key)
    this.deps.writeConnection({
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
    this.deps.carryTranscript({
      configDir: overseerConfigDirFor(this.workspaceRoot), sessionId, home,
    })
    return home
  }

  async #start(key, session) {
    let sessionId = this.reduction.overseerSession(key)
    const resume = Boolean(sessionId)
    if (!sessionId) {
      sessionId = this.reduction.pendingOverseerSession(key)
      if (!sessionId) {
        sessionId = crypto.randomUUID()
        this.reduction.reserveOverseerSession(key, sessionId)
      }
    }
    const home = this.#arm(key, sessionId)
    this.deps.ensureDir(home)
    await this.deps.newSession({
      name: session,
      cwd: home,
      shellCmd: overseerPaneCommand({ repoRoot: this.repoRoot, sessionId, resume }),
      keepOpen: false,
    })
    await this.#waitForComposer(session)
    if (!resume) this.reduction.bindOverseerSession(key, sessionId)
    this.reduction.journal(resume ? 'overseer_pane_resumed' : 'overseer_pane_started', {
      key, session, session_id: sessionId,
    })
    this.log(`[overseer] ${resume ? 'resumed' : 'started'} pane ${session} for ${key}`)
    return { session, sessionId, resumed: resume }
  }

  async #ensure(key, session) {
    if (await this.deps.hasSession(session)) {
      let sessionId = this.reduction.overseerSession(key)
      if (!sessionId) {
        sessionId = this.reduction.pendingOverseerSession(key)
        if (sessionId) {
          await this.#waitForComposer(session)
          this.reduction.bindOverseerSession(key, sessionId)
          this.reduction.journal('overseer_pane_started', { key, session, session_id: sessionId })
          return { session, sessionId, resumed: false }
        }
      }
      if (!sessionId) throw new Error(`${session} has no durable overseer conversation identity`)
      return { session, sessionId, resumed: false }
    }
    return this.#start(key, session)
  }

  ensure(key) {
    const session = overseerPaneSession(key)
    if (!this.starting.has(key)) {
      const start = this.#ensure(key, session).finally(() => this.starting.delete(key))
      this.starting.set(key, start)
    }
    return this.starting.get(key)
  }

  async send(key, text) {
    const { session, sessionId, resumed } = await this.ensure(key)
    const delivery = await this.deps.sendText(session, text)
    return { session, sessionId, resumed, delivery }
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
      return paneShowsActiveTurn(await this.deps.capturePane(session))
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
  async deliver(key, prompt, { onNote = () => {} } = {}) {
    const repos = this.watchRepos()
    const checkouts = await this.deps.checkoutPass({
      repoRoot: this.repoRoot, repos, now: this.now,
    })
    await onNote(checkoutNote(checkouts))
    const notes = this.reduction.takeOverseerNotes?.(key) ?? []
    const text = paneMessageText({ checkouts, notes, prompt, now: this.now })
    const { session, sessionId, resumed } = await this.ensure(key)
    const delivery = await this.deps.sendText(session, text, { paste: true })
    if (delivery?.status === 'not-sent') {
      for (const note of notes) this.reduction.addOverseerNote?.(key, note)
      const why = `${session} was still working, so curia did not send the message`
      const signal = await this.#signal({ key, session, sessionId, ok: false, why })
      return { session, sessionId, resumed, checkouts, notes, delivery, completion: Promise.resolve(signal) }
    }
    this.reduction.journal('overseer_pane_message', {
      key, session, session_id: sessionId, notes: notes.length, stale: checkouts.repos.filter((r) => !r.ok).length,
    })
    // Detached on purpose: the surface that sent the message must not hold an
    // HTTP request open for the length of a model's work. The promise is
    // returned so a caller that DOES want to wait — a test, a replay — can.
    const completion = this.#settle(session)
      .then((out) => this.#signal({ key, session, sessionId, ...out }))
    completion.catch(() => {})
    return { session, sessionId, resumed, checkouts, notes, delivery, completion }
  }

  // The one signal, emitted once per message and nowhere else.
  async #signal({ key, session, sessionId, ok, why }) {
    const signal = { key, session, sessionId, ok, why: why ?? null, at: this.now().toISOString() }
    this.reduction.journal('overseer_pane_message_ended', {
      key, session, session_id: sessionId, ok, why: signal.why,
    })
    if (!ok) this.log(`[overseer] pane message on ${key} did not finish: ${signal.why}`)
    try {
      await this.deps.onComplete(signal)
    } catch (e) {
      this.log(`[overseer] the completion signal for ${key} was not delivered: ${e.message}`)
    }
    return signal
  }
}

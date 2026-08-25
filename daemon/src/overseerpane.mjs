// A live overseer conversation uses the same tmux pane boundary as an agent.
// The pane is only a cache. The reduction keeps the durable Claude session,
// while this host owns the overseer lifecycle and authority policy.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { execFileP } from './exec.mjs'
import {
  capturePane, hasSession, listSessions, newSession, sendText, killSession,
} from './tmux.mjs'
import {
  OVERSEER_CONTAINER_MODEL, overseerConfigDirFor,
  overseerHomeFor, overseerProcessEnv,
} from './overseerturn.mjs'
import {
  AnthropicCredentialStore, anthropicStoreFile, writeClaudeCredentials,
} from './credentials.mjs'
import { isConsoleKey, sessionForConsoleKey } from './attach.mjs'
import { agentEnv, seedConfigDir } from './workspace.mjs'
import { buildSystemPrompt } from './overseerprompt.mjs'
import { SIGNALS } from './messaging.mjs'

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
  const home = overseerHomeFor(root)
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

export class OverseerPaneHost {
  constructor({
    reduction,
    repoRoot,
    pane = defaultPane,
    containerId = () => runningOverseerContainer({ repoRoot }),
    newSessionId = crypto.randomUUID,
    livePaneCap = 3,
  }) {
    this.reduction = reduction
    this.repoRoot = repoRoot
    this.pane = pane
    this.containerId = containerId
    this.newSessionId = newSessionId
    this.livePaneCap = livePaneCap
    this.live = new Map()
    this.lanes = new Map()
    this.capacityLane = Promise.resolve()
  }

  send(key, text) {
    const identity = String(key)
    return this.#queue(identity, () => this.#withCapacity(() => this.#send(identity, text)))
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
      const container = await this.containerId()
      await this.pane.start({
        name,
        cwd: this.repoRoot,
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

  async #makeRoom(nextName) {
    while (this.live.size >= this.livePaneCap) {
      const [name, conversation] = this.live.entries().next().value ?? []
      if (!name || name === nextName) return
      if (await this.pane.has(name)) await this.pane.park(name)
      this.live.delete(name)
      this.reduction.journal?.('overseer_pane_parked', {
        key: conversation.key,
        pane: name,
        reason: 'capacity',
      })
    }
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
      this.reduction.journal?.('overseer_pane_parked', {
        key: conversation.key,
        pane: name,
        reason: 'deploy',
      })
    }
    this.live.clear()
  }
}

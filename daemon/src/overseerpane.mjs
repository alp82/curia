// The overseer pane host (#688). The conversation remains durable in the
// journal. A tmux pane is one live process for that conversation, hosted by
// docker exec inside the shared overseer container.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { hasSession, newSession, capturePane, sendText } from './tmux.mjs'
import {
  MCP_SERVER_NAME, OVERSEER_CONTAINER_MODEL, OVERSEER_MCP_PATH,
  overseerConfigDirFor, overseerHomeFor, overseerProcessEnv,
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
import { buildSystemPrompt } from './overseerprompt.mjs'
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

export class OverseerPaneHost {
  constructor({
    reduction, workspaceRoot, repoRoot, dataDir, log = console.log,
    daemonPort = 0, daemonHost = 'host.docker.internal',
    readyTimeoutMs = 45_000, readyPollMs = 250,
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
    this.deps = {
      hasSession, newSession, capturePane, sendText,
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
}

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
  OVERSEER_CONTAINER_MODEL, modelCredentialEnv, overseerConfigDirFor,
  overseerHomeFor, overseerProcessEnv,
} from './overseerturn.mjs'
import { isConsoleKey, sessionForConsoleKey } from './attach.mjs'
import { agentEnv, seedConfigDir } from './workspace.mjs'
import { buildSystemPrompt } from './overseerprompt.mjs'

export const OVERSEER_CONTAINER = 'curia-overseer-1'
const DISCORD_KEY_RE = /^\d+$/
const CLAUDE_READY_RE = /(?:⏵⏵|bypass permissions)/

export function overseerPaneSession(key) {
  const value = String(key ?? '')
  if (isConsoleKey(value)) return sessionForConsoleKey(value)
  if (DISCORD_KEY_RE.test(value)) return `curia-overseer-${value}`
  throw new Error(`"${value}" is not an overseer conversation key`)
}

export function overseerPaneConfigDirFor(workspaceRoot) {
  return overseerConfigDirFor(workspaceRoot)
}

function shellArg(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'"'"'`)}'`
}

export function overseerPaneCommand({ repoRoot, key, sessionId, resume }) {
  const runner = path.join(repoRoot, 'daemon', 'bin', 'curia-overseer-pane.mjs')
  const identityFlag = resume ? '--resume' : '--session-id'
  return [
    'docker', 'exec', '-it', OVERSEER_CONTAINER,
    'node', shellArg(runner), '--key', shellArg(key), identityFlag, shellArg(sessionId),
  ].join(' ')
}

export function prepareOverseerPane({ cfg, key, sessionId, resume = false, deps = {} }) {
  overseerPaneSession(key)
  if (!sessionId || typeof sessionId !== 'string') throw new Error('the overseer pane needs a durable session id')
  const root = cfg.dispatch.workspace_root
  const configDir = overseerConfigDirFor(root)
  const home = overseerHomeFor(root)
  const seed = deps.seed ?? seedConfigDir
  const systemPrompt = deps.systemPrompt ?? buildSystemPrompt
  const credential = deps.credential ?? modelCredentialEnv
  const processEnv = deps.processEnv ?? overseerProcessEnv
  fs.mkdirSync(home, { recursive: true })
  seed(configDir, home, null, 'claude', { sandboxed: true })
  const modelCredential = credential(root)
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
      ...modelCredential.env,
    },
    args: [
      '--model', OVERSEER_CONTAINER_MODEL,
      '--append-system-prompt', prompt,
      '--dangerously-skip-permissions',
      identityFlag, sessionId,
    ],
    note: modelCredential.note,
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
    reduction, workspaceRoot, repoRoot, log = console.log,
    readyTimeoutMs = 45_000, readyPollMs = 250,
    deps = {},
  }) {
    this.reduction = reduction
    this.workspaceRoot = workspaceRoot
    this.repoRoot = repoRoot
    this.log = log
    this.readyTimeoutMs = readyTimeoutMs
    this.readyPollMs = readyPollMs
    this.deps = {
      hasSession, newSession, capturePane, sendText,
      ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
      ...deps,
    }
    this.starting = new Map()
  }

  configDirFor() {
    return overseerPaneConfigDirFor(this.workspaceRoot)
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

  async #start(key, session) {
    let sessionId = this.reduction.overseerSession(key)
    const resume = Boolean(sessionId)
    if (!sessionId) {
      sessionId = crypto.randomUUID()
      this.reduction.bindOverseerSession(key, sessionId)
    }
    this.deps.ensureDir(overseerHomeFor(this.workspaceRoot))
    await this.deps.newSession({
      name: session,
      cwd: overseerHomeFor(this.workspaceRoot),
      shellCmd: overseerPaneCommand({ repoRoot: this.repoRoot, key, sessionId, resume }),
      keepOpen: false,
    })
    await this.#waitForComposer(session)
    this.reduction.journal(resume ? 'overseer_pane_resumed' : 'overseer_pane_started', {
      key, session, session_id: sessionId,
    })
    this.log(`[overseer] ${resume ? 'resumed' : 'started'} pane ${session} for ${key}`)
    return { session, sessionId, resumed: resume }
  }

  async ensure(key) {
    const session = overseerPaneSession(key)
    if (await this.deps.hasSession(session)) {
      const sessionId = this.reduction.overseerSession(key)
      if (!sessionId) throw new Error(`${session} has no durable overseer conversation identity`)
      return { session, sessionId, resumed: false }
    }
    if (!this.starting.has(key)) {
      const start = this.#start(key, session).finally(() => this.starting.delete(key))
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

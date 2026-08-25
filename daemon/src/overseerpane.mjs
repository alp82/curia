// A live overseer conversation uses the same tmux pane boundary as an agent.
// The pane is only a cache. The reduction keeps the durable Claude session,
// while this host owns the overseer lifecycle and authority policy.

import crypto from 'node:crypto'
import path from 'node:path'
import { execFileP } from './exec.mjs'
import {
  capturePane, hasSession, listSessions, newSession, sendText, killSession,
} from './tmux.mjs'

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
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return `${OVERSEER_PANE_PREFIX}${digest}`
}

export function overseerPaneCommand({ repoRoot, container, session, resume }) {
  const runner = path.join(repoRoot, 'daemon', 'bin', 'curia-overseer-pane.mjs')
  const identityFlag = resume ? '--resume' : '--session'
  return [
    'docker', 'exec', '-it', shellWord(container),
    'node', shellWord(runner), identityFlag, shellWord(session),
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
      session = this.newSessionId()
    }

    let present = await this.pane.has(name)
    if (present && created) {
      await this.pane.park(name)
      present = false
    }
    if (!this.live.has(name)) await this.#makeRoom(name)
    if (!present) {
      const container = await this.containerId()
      await this.pane.start({
        name,
        cwd: this.repoRoot,
        role: 'overseer',
        authority: 'overseer',
        shellCmd: overseerPaneCommand({ repoRoot: this.repoRoot, container, session, resume }),
      })
      await this.pane.ready?.(name)
    }
    if (created) this.reduction.bindOverseerSession(key, session)
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

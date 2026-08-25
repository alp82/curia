// Recurring aistack publication (#695). The daemon's existing tick calls
// `tick()`. This module owns no timer, so a usage publisher cannot become a
// second scheduler beside reconcile.

import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const AISTACK_VERSION = '0.7.2'
export const AISTACK_PACKAGE = `@use-aistack/cli@${AISTACK_VERSION}`
export const AISTACK_SYNC_TIMEOUT_MS = 2 * 60 * 1000
export const AISTACK_ERROR_LIMIT = 240

export function aistackEnvironment(workspaceRoot, { codexRoot = path.join(workspaceRoot, 'home', '.codex') } = {}) {
  const cfgRoot = path.join(workspaceRoot, 'cfg')
  let names = []
  try {
    names = fs.readdirSync(cfgRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const claudeRoots = names
    .map((name) => path.join(cfgRoot, name))
    .filter((root) => fs.existsSync(path.join(root, 'projects')))
  return {
    HOME: path.join(workspaceRoot, 'home'),
    CLAUDE_CONFIG_DIR: claudeRoots.join(','),
    CODEX_HOME: codexRoot,
  }
}

async function defaultRunProcess(command, args, options) {
  return execFile(command, args, options)
}

const clipped = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, AISTACK_ERROR_LIMIT)

export class AistackSync {
  constructor({
    workspaceRoot,
    codexRoot = null,
    runProcess = defaultRunProcess,
    now = Date.now,
    log = () => {},
  } = {}) {
    this.workspaceRoot = workspaceRoot
    this.codexRoot = codexRoot
    this.runProcess = runProcess
    this.now = now
    this.log = log
    this.credentialFile = path.join(workspaceRoot, 'home', '.config', 'aistack', 'credentials.json')
    this.reading = { state: 'unregistered', last_attempt_at: null }
  }

  status() {
    return { ...this.reading }
  }

  async tick() {
    if (!fs.existsSync(this.credentialFile)) {
      this.reading = { state: 'unregistered', last_attempt_at: null }
      return this.status()
    }
    const attempted = new Date(this.now()).toISOString()
    const previousFailures = this.reading.consecutive_failures ?? 0
    try {
      const env = {
        ...process.env,
        ...aistackEnvironment(this.workspaceRoot, this.codexRoot ? { codexRoot: this.codexRoot } : {}),
      }
      await this.runProcess('npx', ['-y', AISTACK_PACKAGE, 'sync', '--auto'], {
        env,
        timeout: AISTACK_SYNC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      })
      this.reading = {
        state: 'ok',
        last_attempt_at: attempted,
        last_success_at: attempted,
        consecutive_failures: 0,
      }
      if (previousFailures) this.log('aistack sync recovered')
    } catch (error) {
      const failure = clipped(error?.stderr || error?.message || error)
      const consecutive = previousFailures + 1
      this.reading = {
        state: 'failed',
        last_attempt_at: attempted,
        last_success_at: this.reading.last_success_at ?? null,
        consecutive_failures: consecutive,
        error: failure,
        recovery: 'Check the aistack machine grant. If the grant expired, register the machine again in Atlas Settings.',
      }
      // The first failure is actionable. Later repeats stay in status and only
      // report every tenth attempt, which bounds a long outage in the daemon log.
      if (consecutive === 1 || consecutive % 10 === 0) this.log(`aistack sync failed: ${failure}`)
    }
    return this.status()
  }
}

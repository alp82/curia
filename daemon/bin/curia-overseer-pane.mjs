#!/usr/bin/env node
// Runs one durable overseer conversation inside the shared overseer container.
// tmux owns the outer pane. This process owns only the overseer role policy.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCuriaConfig } from '../src/config.mjs'
import { checkoutsRootFor, syncCheckouts } from '../src/checkouts.mjs'
import { modelCredentialEnv, overseerConfigDirFor, overseerHomeFor, overseerProcessEnv, OVERSEER_CONTAINER_MODEL } from '../src/overseerturn.mjs'
import { buildSystemPrompt, checkoutReport, toolsFor } from '../src/overseerprompt.mjs'
import { installCredentialConfig } from '../src/overseercreds.mjs'
import { overseerTokensRootFor } from '../src/overseertoken.mjs'
import { agentEnv, seedConfigDir } from '../src/workspace.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.CURIA_CONFIG ?? path.resolve(DIR, '..', '..', 'config', 'curia.yaml')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function identity(argv) {
  if (argv.length !== 2 || !['--session', '--session-id', '--resume'].includes(argv[0]) || !UUID_RE.test(argv[1])) {
    throw new Error('usage: curia-overseer-pane.mjs (--session-id|--resume) <session UUID>')
  }
  return { resume: argv[0] === '--resume', session: argv[1] }
}

function claudeBinary() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const require = createRequire(import.meta.url)
  const packageFile = require.resolve(`@anthropic-ai/claude-agent-sdk-linux-${arch}/package.json`)
  return path.join(path.dirname(packageFile), 'claude')
}

function wait(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`the overseer pane stopped on ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

const run = identity(process.argv.slice(2))
const cfg = loadCuriaConfig(CONFIG, { checkPaths: false })
const root = cfg.dispatch.workspace_root
const repos = cfg.watch.map((entry) => entry.repo)
const configDir = overseerConfigDirFor(root)
const home = overseerHomeFor(root)
fs.mkdirSync(home, { recursive: true })
const credential = modelCredentialEnv(root)
seedConfigDir(configDir, home, null, 'claude', { apiKey: credential.env.ANTHROPIC_API_KEY })

await installCredentialConfig(repos, { dir: overseerTokensRootFor(root) })
const checkouts = await syncCheckouts(root, repos)
const prompt = [
  buildSystemPrompt({ shell: true, checkoutsRoot: checkoutsRootFor(root), repos }),
  checkoutReport(checkouts),
].join('\n\n')
const { allowed, disallowed } = toolsFor({ shell: true })
const args = [
  run.resume ? '--resume' : '--session-id', run.session,
  '--model', OVERSEER_CONTAINER_MODEL,
  '--append-system-prompt', prompt,
  '--allowed-tools', allowed.join(','),
  '--disallowed-tools', disallowed.join(','),
]
const env = {
  ...overseerProcessEnv(),
  ENABLE_TOOL_SEARCH: '0',
  ...agentEnv(configDir, 'claude', { sandboxed: true }),
  ...credential.env,
}
const child = spawn(claudeBinary(), args, { cwd: home, env, stdio: 'inherit' })
process.exitCode = await wait(child)

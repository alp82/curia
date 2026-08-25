#!/usr/bin/env node
// One live overseer conversation inside the shared overseer container (#688).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCuriaConfig } from '../src/config.mjs'
import { runOverseerPane } from '../src/overseerpane.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.CURIA_CONFIG ?? path.resolve(DIR, '..', '..', 'config', 'curia.yaml')
const args = process.argv.slice(2)
const valueAfter = (flag) => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : null
}
const resumeId = valueAfter('--resume')
const sessionId = resumeId ?? valueAfter('--session-id')

if (!sessionId || (resumeId && args.includes('--session-id'))) {
  console.error('usage: curia-overseer-pane (--session-id <id> | --resume <id>)')
  process.exit(2)
}

const cfg = loadCuriaConfig(CONFIG, { checkPaths: false })
const code = await runOverseerPane({ cfg, sessionId, resume: Boolean(resumeId) })
process.exitCode = code

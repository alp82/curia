// PROTOTYPE (#570) — build the overseer-pane sandbox.
//
// Seeds a pane config dir EXACTLY the way the daemon seeds an agent pane
// (workspace.mjs `seed`: .claude.json trust keys + settings.json), a cwd that
// stands in for the overseer home, and the env file drive.mjs spawns with.
// The system prompt is the REAL overseer prompt (overseerprompt.mjs), written
// to system.txt so the spawn line can carry it via --append-system-prompt.
//
// Usage: node seed.mjs <sandboxDir> <session> <standinPort>

import fs from 'node:fs'
import path from 'node:path'
import { buildSystemPrompt } from '../../daemon/src/overseerprompt.mjs'

const [, , sandbox, session, port] = process.argv
if (!sandbox || !session || !port) { console.error('usage: node seed.mjs <sandboxDir> <session> <standinPort>'); process.exit(1) }

const work = path.join(sandbox, 'work')
const cfgDir = path.join(work, 'cfg', session)
const home = path.join(sandbox, 'home')
fs.mkdirSync(cfgDir, { recursive: true })
fs.mkdirSync(home, { recursive: true })

// workspace.mjs seed shape, verbatim (minus the MCP allowlist — this spike
// wires no MCP server; the research settled that boundary separately).
fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  installMethod: 'native',
  autoUpdates: false,
  theme: 'dark',
  numStartups: 1,
  projects: {
    [home]: {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
    },
  },
}, null, 2))
fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({
  skipDangerousModePermissionPrompt: true,
  disableClaudeAiConnectors: true,
}, null, 2))

// The overseer's own standing orders, shell posture on — the same call
// overseerturn.mjs makes per turn. The per-turn checkout report cannot ride a
// spawn-time prompt; that gap is a finding, not something to paper over here.
fs.writeFileSync(path.join(sandbox, 'system.txt'),
  buildSystemPrompt({ shell: true, checkoutsRoot: path.join(home, 'checkouts'), repos: ['alp82/curia'] }))

fs.writeFileSync(path.join(sandbox, 'env.json'), JSON.stringify({
  PATH: process.env.PATH,
  HOME: home,
  CLAUDE_CONFIG_DIR: cfgDir,
  ANTHROPIC_API_KEY: 'standin-key',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
}, null, 2))

console.log(JSON.stringify({ work, cfgDir, home, env: path.join(sandbox, 'env.json'), system: path.join(sandbox, 'system.txt') }, null, 2))

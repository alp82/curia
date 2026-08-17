// Seed a codex config dir for the #461 measurement, using curia's own seeding.
//
// Ticket #461 needs a codex session that curia armed. Every rollout on the box
// predates the pointer #399 landed, so no existing session can answer it, and
// `461-rollout-copy.sh` says so and stops. This script makes the missing one
// possible: it seeds a throwaway CODEX_HOME exactly as a dispatch would, then
// prints the command that runs an interactive session against it.
//
// It calls `seedConfigDir` from the daemon rather than copying files itself.
// That matters: the pointer this ticket measures is written by
// `writeSkillPointers`, and a hand-made copy would measure a file curia does
// not ship. Byte-identical, or the number is about the wrong file.
//
// Run it on the curia HOST, from a checkout of this repo:
//
//   node docs/live-checks/461-seed-codex-session.mjs
//
// It needs the daemon's dependencies. Run `npm install` in `daemon/` first.
//
// ---- why an INTERACTIVE session, and not a dispatch ------------------------
//
// A rollout's `turn_context` records are one per USER message. That was checked
// against the #399 fixtures, where `turn_context`, `event_msg:user_message` and
// `event_msg:task_started` all count 3 for a 3-prompt run. It also matches the
// twelve rollouts on the box, which carry 1 to 3 turns each across sessions up
// to 1.1 MB.
//
// So a curia dispatch is ONE turn, plus one per escalation reply. Codex's own
// instruction is scoped to the same unit — "you must use that skill for that
// turn ... Do not carry skills across turns unless re-mentioned" — so the turn
// is the right unit to count, and a dispatch simply does not produce twenty of
// them. Twenty prompts typed at an interactive session does.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SELF), '../..')

const auth = path.join(os.homedir(), '.codex', 'auth.json')
if (!fs.existsSync(auth)) {
  console.error(`No codex credential at ${auth}.`)
  console.error('The seed links that file, and an interactive session needs it. Run `codex login` first.')
  process.exit(2)
}

let seedConfigDir, YAML
try {
  ;({ seedConfigDir } = await import(path.join(REPO, 'daemon/src/workspace.mjs')))
  YAML = (await import(path.join(REPO, 'daemon/node_modules/yaml/dist/index.js'))).default
} catch (err) {
  console.error(`Cannot load the daemon: ${err.message}`)
  console.error('Run `npm install` in daemon/ and try again.')
  process.exit(3)
}

// The same two fields the daemon reads at boot. Reading them here rather than
// hardcoding a skill list keeps this seed on curia's list even after that list
// changes, which is the whole reason to seed with curia's code at all.
const cfgFile = path.join(REPO, 'config/curia.yaml')
const parsed = YAML.parse(fs.readFileSync(cfgFile, 'utf8')) ?? {}
const s = parsed.skills ?? {}
const root = s.root === undefined
  ? path.join(REPO, 'skills')
  : path.resolve(path.dirname(cfgFile), s.root)
const install = s.install ?? []
if (!install.length) {
  console.error(`${cfgFile} installs no skills, so there would be no pointer to measure.`)
  process.exit(4)
}

// The seed lands under the workspace root's `cfg`, beside every dispatch's own
// config dir. That is not decoration: `461-rollout-copy.sh` looks for rollouts
// under `<root>/cfg/*`, so a seed anywhere else would be invisible to the very
// script that copies its rollout here. The root is resolved the same three ways
// that script resolves it.
function workspaceRoot() {
  if (process.env.CURIA_WORKSPACE_ROOT) return process.env.CURIA_WORKSPACE_ROOT
  const envFile = path.join(REPO, 'deploy/.env')
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => l.startsWith('CURIA_WORKSPACE_ROOT=')).pop()
    if (line) return line.slice('CURIA_WORKSPACE_ROOT='.length).trim()
  }
  return '/home/alp/curia-work'
}

const cfgDir = process.argv[2] ?? path.join(workspaceRoot(), 'cfg', 'curia-461-measure')
// `sandboxed` stays false: this runs on the host, so the credential is a
// symlink to the operator's own and no frozen copy is made.
seedConfigDir(cfgDir, REPO, { root, install }, 'codex')

const pointers = []
for (const name of fs.readdirSync(path.join(cfgDir, 'skills'))) {
  if (name.startsWith('curia-')) pointers.push(name)
}
if (!pointers.length) {
  console.error(`The seed wrote no curia pointer under ${cfgDir}/skills.`)
  console.error('Without one there is nothing for #461 to count. This is a real failure, not a warning.')
  process.exit(5)
}

console.log(`seeded ${cfgDir}`)
console.log(`skills installed: ${install.join(', ')}`)
console.log(`curia pointers:   ${pointers.join(', ')}`)
console.log('')
console.log('Now run an interactive session and type about twenty prompts on a real task:')
console.log('')
console.log(`  CODEX_HOME=${cfgDir} codex`)
console.log('')
console.log('The task must be one the wayfinder skill matches, or the skill never triggers')
console.log('and the count answers a question nobody asked.')
console.log('')
console.log(`Its rollout lands at ${cfgDir}/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl.`)
console.log('Then count it here:')
console.log('')
console.log(`  node docs/live-checks/461-codex-skill-reread.counter.mjs ${cfgDir}/sessions`)
console.log('')
console.log('Or send it to the agent, which counts it and writes the live check:')
console.log('')
console.log('  bash docs/live-checks/461-rollout-copy.sh --copy')

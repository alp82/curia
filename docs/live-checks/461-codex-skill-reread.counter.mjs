// How often a codex model re-reads a skill it triggers (#461).
//
// [#399](https://github.com/alp82/curia/issues/399) bounded the COST of a
// re-read at both ends and left the FREQUENCY open, because a frequency needs a
// real model. Its probe drives a real codex CLI against a stub provider, so the
// model there obeys nothing: it reads what the script tells it to read.
//
// This file is the other half, and it is a counter rather than a probe. It runs
// AFTER a real codex session, over the rollout that session left on disk, and it
// answers the two questions the ticket asks:
//
//   1. How often the model re-reads the pointer, and how often it re-reads the
//      skill the pointer names.
//   2. Whether the read-once rule in the pointer holds, or whether codex's own
//      "read it completely" instruction beats it.
//
// It needs no credential and no network, because the session it reads is already
// over. That is the whole point: the credential is needed to RUN a codex
// session, and it is not needed to COUNT one.
//
// Run:  node docs/live-checks/461-codex-skill-reread.counter.mjs <rollout.jsonl>
//       node docs/live-checks/461-codex-skill-reread.counter.mjs --self-test
//
// Codex writes every session to `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`,
// and a curia dispatch sets `CODEX_HOME` to the agent config dir. So the rollout
// of a real dispatch is beside the very pointer this counter asks about.
//
//   ls <cfgDir>/sessions/*/*/*/rollout-*.jsonl
//
// The self-test needs the `codex` binary on PATH. Counting a rollout does not.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SELF), '../..')

// ---- what counts as a read -------------------------------------------------

// The two files, matched by SHAPE rather than by an absolute path. A rollout
// names the config dir it ran under, and that dir is a throwaway that is usually
// gone by the time anybody counts. So the counter reads the path out of the tool
// call instead of being told it.
//
// `curia-<name>/SKILL.md` is the pointer curia generates (`writeSkillPointers`),
// and `<name>/SKILL.md` is the installed skill it names. The `curia-` prefix is
// what tells the two apart, and it is deliberate upstream of here: a pointer
// named `wayfinder` would put two skills under one name, which is the ambiguity
// #224 measured.
const SKILL_PATH = /skills\/(curia-)?([A-Za-z0-9_-]+)\/SKILL\.md/g

// A tool call is where a read is DECIDED, so it is what gets counted. Codex
// 0.146 exposes one custom tool named `exec`, taking JavaScript, with the shell
// nested inside it as `tools.exec_command`. Older and newer shapes are matched
// too, because a version bump owes a re-run and a counter that silently reads
// zero is worse than one that errors.
const CALL_TYPES = new Set([
  'custom_tool_call', // codex 0.146: `exec`, taking a JavaScript program
  'function_call', // a plain function tool, e.g. a `shell` or a `read_file`
  'local_shell_call', // the shell tool codex exposes to some models
])
const OUTPUT_TYPES = new Set(['custom_tool_call_output', 'function_call_output', 'local_shell_call_output'])

// The text of a call, whatever shape it arrived in. Every field that could carry
// a path is joined, because the counter matches on the path and not on the tool.
// A model that reads with `cat`, with `sed -n`, or with a dedicated read tool is
// doing the same thing, and this ticket counts the reading rather than the verb.
function callText(payload) {
  const parts = [payload.input, payload.arguments, payload.command, payload.action && JSON.stringify(payload.action)]
  return parts.filter((p) => typeof p === 'string' || Array.isArray(p)).map((p) => (Array.isArray(p) ? p.join(' ') : p)).join('\n')
}

// What a call read, as a set of `{kind, skill}` pairs. A SET, because one call
// that names the same file twice — `cat X && wc -c X` — is one read of it, and
// counting it twice would report a re-read that never happened.
function targetsOf(text) {
  const found = new Map()
  for (const m of text.matchAll(SKILL_PATH)) {
    const kind = m[1] ? 'pointer' : 'skill'
    const name = m[2]
    found.set(`${kind}:${name}`, { kind, skill: name })
  }
  return [...found.values()]
}

// The characters a read put back into the model's input. #399 measured this cost
// per read (999 for the pointer, 12,299 for the whole wayfinder skill) and the
// point of measuring it again here is that a REAL model may read a file in part.
// A `sed -n '1,40p'` is still a read, and it is not the same price as a `cat`.
function outputChars(payload) {
  const out = payload.output
  if (typeof out === 'string') return out.length
  if (Array.isArray(out)) return out.reduce((n, o) => n + (o?.text?.length ?? 0), 0)
  return 0
}

// ---- the reading -----------------------------------------------------------

// One rollout, counted. Turns come off the calls themselves: codex stamps every
// item with the `turn_id` it belongs to, so a read is attributed to its own turn
// without counting `turn_context` records and hoping the order lines up.
export function countRollout(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const turns = [] // turn ids, in the order codex opened them
  const prompts = new Map() // turn index -> the user message that opened it
  const reads = [] // one entry per read, in order
  const outputs = new Map() // call_id -> characters the read returned
  let meta = {}

  const turnIndex = (id) => {
    if (id == null) return turns.length ? turns.length - 1 : 0
    let i = turns.indexOf(id)
    if (i < 0) { turns.push(id); i = turns.length - 1 }
    return i
  }

  for (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    const payload = record.payload ?? {}
    if (record.type === 'session_meta') meta = payload
    if (record.type === 'turn_context') turnIndex(payload.turn_id)
    if (record.type === 'event_msg' && payload.type === 'user_message') {
      const at = turns.length ? turns.length - 1 : 0
      if (!prompts.has(at)) prompts.set(at, (payload.message ?? '').split('\n')[0].slice(0, 60))
    }
    if (record.type !== 'response_item') continue
    if (OUTPUT_TYPES.has(payload.type)) outputs.set(payload.call_id, outputChars(payload))
    if (!CALL_TYPES.has(payload.type)) continue
    const at = turnIndex(payload.internal_chat_message_metadata_passthrough?.turn_id)
    for (const target of targetsOf(callText(payload))) {
      reads.push({ ...target, turn: at, call_id: payload.call_id })
    }
  }

  for (const read of reads) read.chars = outputs.get(read.call_id) ?? 0
  return { file, meta, turns: Math.max(turns.length, 1), prompts, reads }
}

// The two answers the ticket asks for, per skill. `turnsRead` is the count that
// decides the question: a skill read on one turn out of twenty obeys the
// read-once rule, and a skill read on twenty out of twenty does not.
export function verdict(count) {
  const bySkill = new Map()
  for (const read of count.reads) {
    const entry = bySkill.get(read.skill) ?? { skill: read.skill, pointer: [], skillFile: [] }
    ;(read.kind === 'pointer' ? entry.pointer : entry.skillFile).push(read)
    bySkill.set(read.skill, entry)
  }
  const rows = [...bySkill.values()].map((e) => {
    const turnsOf = (rs) => new Set(rs.map((r) => r.turn)).size
    const charsOf = (rs) => rs.reduce((n, r) => n + r.chars, 0)
    return {
      skill: e.skill,
      pointerReads: e.pointer.length, pointerTurns: turnsOf(e.pointer), pointerChars: charsOf(e.pointer),
      skillReads: e.skillFile.length, skillTurns: turnsOf(e.skillFile), skillChars: charsOf(e.skillFile),
    }
  })
  // The rule holds when nothing was read more than once. It is measured per
  // file, because the pointer and the skill are two different reads and codex
  // tells the model to do only the first one.
  const holds = rows.every((r) => r.pointerReads <= 1 && r.skillReads <= 1)
  return { rows, holds }
}

function report(count) {
  const { rows, holds } = verdict(count)
  const out = []
  out.push(`### ${path.basename(count.file)}`)
  out.push('')
  out.push(`codex ${count.meta.cli_version ?? '?'}, provider ${count.meta.model_provider ?? '?'}, ${count.turns} turns`)
  out.push('')
  if (!rows.length) {
    out.push('No skill file was read on any turn.')
    return out.join('\n')
  }
  out.push('| skill | pointer reads | on turns | pointer chars | skill reads | on turns | skill chars |')
  out.push('|---|---|---|---|---|---|---|')
  for (const r of rows) {
    out.push(`| ${r.skill} | ${r.pointerReads} | ${r.pointerTurns}/${count.turns} | ${r.pointerChars} | ${r.skillReads} | ${r.skillTurns}/${count.turns} | ${r.skillChars} |`)
  }
  out.push('')
  out.push(`Read-once rule: **${holds ? 'holds' : 'BEATEN'}** — no file was read twice.`.replace('— no file was read twice.', holds ? '— no file was read twice.' : '— a file was read more than once.'))
  out.push('')
  out.push('| turn | prompt | reads |')
  out.push('|---|---|---|')
  for (let t = 0; t < count.turns; t++) {
    const on = count.reads.filter((r) => r.turn === t)
    const what = on.map((r) => `${r.kind}:${r.skill}`).join(', ') || '—'
    out.push(`| ${t + 1} | ${count.prompts.get(t) ?? ''} | ${what} |`)
  }
  return out.join('\n')
}

// ---- the self-test ---------------------------------------------------------

// A counter nobody has checked is a number nobody should trust, and this one
// gets run once, on a session that cost a credential. So it is checked here
// against sessions whose read count is known BEFORE the count runs.
//
// #399's probe is the fixture. Its `reread` case scripts a model that reads the
// same file on every turn, and its `pointer` case scripts one that reads
// nothing. Three reads and zero reads are the two answers this counter must give.
function selfTest() {
  const probe = path.join(REPO, 'docs/live-checks/399-codex-skill-arming.probe.mjs')
  const root = path.join(os.tmpdir(), 'curia-461-count')
  fs.rmSync(root, { recursive: true, force: true })
  const cases = [
    { name: 'reread', dir: 'reread-wayfinder', expect: { skillReads: 3, holds: false } },
    { name: 'pointer', dir: 'pointer', expect: { skillReads: 0, holds: true } },
  ]
  let failures = 0
  for (const c of cases) {
    const run = spawnSync('node', [probe, c.name], { env: { ...process.env, PROBE_DIR: root }, encoding: 'utf8' })
    if (run.status !== 0) { console.log(`FAIL ${c.name}: probe exited ${run.status}\n${run.stderr}`); failures++; continue }
    const dir = path.join(root, c.dir, 'ch', 'sessions')
    const files = walk(dir).filter((f) => f.endsWith('.jsonl'))
    if (!files.length) { console.log(`FAIL ${c.name}: no rollout under ${dir}`); failures++; continue }
    const count = countRollout(files[0])
    const v = verdict(count)
    const got = { skillReads: v.rows.reduce((n, r) => n + r.skillReads, 0), holds: v.holds }
    const ok = got.skillReads === c.expect.skillReads && got.holds === c.expect.holds
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: skill reads ${got.skillReads} (want ${c.expect.skillReads}), rule holds ${got.holds} (want ${c.expect.holds})`)
    if (!ok) failures++
  }
  console.log(failures ? `\n${failures} case(s) failed.` : '\nBoth cases pass. The counter reads a rollout correctly.')
  return failures
}

function walk(dir) {
  let out = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(walk(full))
    else out.push(full)
  }
  return out
}

// ---- main ------------------------------------------------------------------

const arg = process.argv[2]
if (!arg) {
  console.log('usage: node 461-codex-skill-reread.counter.mjs <rollout.jsonl | --self-test>')
  process.exit(2)
} else if (arg === '--self-test') {
  process.exit(selfTest() ? 1 : 0)
} else {
  const files = fs.statSync(arg).isDirectory() ? walk(arg).filter((f) => f.endsWith('.jsonl')) : [arg]
  if (!files.length) { console.log(`no rollout under ${arg}`); process.exit(2) }
  for (const f of files) { console.log(report(countRollout(f))); console.log('') }
}

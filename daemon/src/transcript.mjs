// Per-harness transcript readers (#74 item 3, the #39 harness-table shape).
//
// Every agent writes a structured, geometry-free transcript under its own
// config dir — the claude harness as `projects/<proj>/<uuid>.jsonl` under
// CLAUDE_CONFIG_DIR, the codex harness as `sessions/<y>/<m>/<d>/rollout-*.jsonl`
// under CODEX_HOME — and the timeline surface reads it instead of parsing a
// terminal (#72/#73). This module is the ONLY place that knows either
// vocabulary. Everything here is pure given a line of text; the fs helpers
// below are the file-finding functions — one per harness, plus the two ways to
// ask for a file: newest-by-mtime for a pane, by session id for a conversation
// (#332).
//
// Both formats are UNDOCUMENTED, so a break is a question of when, and the
// spike's answer — drop the line silently — is exactly the silence #33 and #69
// each paid for. parseLine therefore classifies instead of filtering:
//
//   { items }       known line, zero or more timeline items (zero is a KNOWN
//                   bookkeeping line — mode, token_count, file-history…)
//   { unknown: t }  well-formed JSON whose vocabulary we do not know — the
//                   format moved underneath us; the caller must say so on the
//                   page and in the journal
//   { malformed }   not JSON at all
//
// The known-but-unrendered sets are explicit allowlists for that reason: a new
// line type arrives as `unknown`, loudly, and gets classified by a human
// rather than swallowed.

import fs from 'node:fs'
import path from 'node:path'
import {
  claudeTranscriptFiles,
  claudeTranscriptForSession,
  claudeTranscriptPresent,
  parseClaudeTranscriptEvent,
} from './claudetranscript.mjs'
import {
  codexTranscriptFiles,
  codexTranscriptForSession,
  codexTranscriptPresent,
  parseCodexTranscriptEvent,
} from './codextranscript.mjs'

export const TRANSCRIPT_HARNESSES = ['claude', 'codex']

// Which harness wrote this config dir, by positive on-disk evidence: the claude
// harness creates `projects/`, codex's creates `sessions/`. Null when
// neither is there — a dir that has not been written yet is "no transcript",
// never a guess. The dispatcher's own agent record wins over this probe when
// it has one (it knows what it spawned); this is the fallback for re-adopted
// and lab sessions.
export function detectHarness(cfgDir) {
  if (claudeTranscriptPresent(cfgDir)) return 'claude'
  if (codexTranscriptPresent(cfgDir)) return 'codex'
  return null
}

// Newest transcript by mtime. An agent writes one file per run; a re-dispatch
// onto the same ticket writes a new one, so "newest" is the live run (spike
// shape, unchanged).
function newestFile(files) {
  let best = null
  for (const p of files) {
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs }
  }
  return best?.path ?? null
}

// Every transcript a config dir holds, per harness.
// A spawned codex subagent writes a second rollout into its parent's config
// directory. Its first line identifies it, so it must not win the parent's
// newest-file lookup while the parent waits (#544, #545).
const FILES = { claude: claudeTranscriptFiles, codex: codexTranscriptFiles }

// What each harness NAMES a session's transcript. The claude harness names the
// file after the session id — measured on the box (docs/live-checks/
// 332-transcript-by-key.md). The codex harness puts the rollout's start time in
// front of it, which is read off the name shape this module already walks
// rather than measured: no codex conversation is keyed today, because the
// overseer is the one thing curia keys and it runs the claude harness.
const NAMES_SESSION = {
  claude: claudeTranscriptForSession,
  codex: codexTranscriptForSession,
}

// The newest root transcript in a config dir, by mtime.
//
// This answers for a PANE. Curia gives every root agent its own config dir, so
// an agent's re-dispatch writes a new file and "newest" is the live root run.
// A codex subagent shares that config dir, but codexThreadSource removes its
// rollout before the mtime comparison (#544, #545).
// A dir that holds many CONVERSATIONS breaks that precondition — use
// transcriptForSession there.
export function findTranscript(harness, cfgDir) {
  return newestFile(FILES[harness]?.(cfgDir) ?? [])
}

// The newest root transcript's last filesystem change. The stall watchdog
// needs growth evidence, not transcript content. A missing or unreadable file
// answers null and causes no pane action.
export function transcriptActivity(harness, cfgDir) {
  const file = findTranscript(harness, cfgDir)
  if (!file) return null
  try {
    const stat = fs.statSync(file)
    return { file, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

// The transcript one SESSION ID names (#332, building ADR-0016).
//
// Every overseer conversation shares one config dir and one cwd, so they all
// write into one directory. Newest-by-mtime there answers "whichever
// conversation spoke last", never "this one": a Discord turn hides the browser
// chat, and the context percent reports another conversation's context. The
// daemon journals the live session id per conversation key, so the key names
// the file and both readers get the conversation they asked about.
//
// Null when the id names no file. A conversation with no turn yet has no
// transcript, and so does a journalled id whose file the cutover left behind.
// An empty screen is the honest answer to both. The last conversation's words
// are not a fallback, they are the defect.
export function transcriptForSession(harness, cfgDir, sessionId) {
  const names = NAMES_SESSION[harness]
  if (!names || !sessionId) return null
  for (const p of FILES[harness](cfgDir)) {
    if (names(path.basename(p), sessionId)) return p
  }
  return null
}

// What the operator opened a conversation with (#333).
//
// The Chat screen's picker labels each row with it. `console-1 console-2
// console-3` is a list nobody can pick from, and a conversation has no other
// name — ADR-0016 mints a number and nothing else, and #333 gave the operator
// no field to type one in.
//
// Only the HEAD of the file is read. The first prompt is the first thing any
// conversation writes, so a bounded read finds it, and the bound is what keeps
// a label off the cost of a whole transcript. A file with no prompt inside that
// window answers null, and the row falls back to its key.
//
// A malformed line is SKIPPED here, unlike everywhere else in this module. The
// timeline reports a parse failure loudly because the transcript is the whole
// content of that surface. Here it is a label, and half a line at the end of a
// bounded read is the expected case, not evidence of anything.
const LABEL_BYTES = 128 * 1024
export function firstPrompt(harness, file, { max = 90, bytes = LABEL_BYTES } = {}) {
  if (!harness || !file || !READERS[harness]) return null
  let head
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const read = fs.readSync(fd, buf, 0, bytes, 0)
      head = buf.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = parseLine(harness, line) } catch { return null }
    if (r.malformed || r.unknown) continue
    for (const item of r.items ?? []) {
      if (item.kind !== 'prompt') continue
      const text = String(item.text ?? '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      return text.length > max ? `${text.slice(0, max - 1)}…` : text
    }
  }
  return null
}

const READERS = { claude: parseClaudeTranscriptEvent, codex: parseCodexTranscriptEvent }

// Read the messages that the Chat surface can render from transcript lines.
// The branch selection lives here so agent and overseer conversations don't
// grow separate transcript rules. The caller keeps filesystem and journal
// access: this module receives the journaled landing identity as plain data.
export function readActiveMessages(harness, lines, { landingUuid = null } = {}) {
  const items = []
  const failures = []
  const byUuid = new Map()
  const records = []
  let tail = null
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch {
      failures.push({ key: `${index}:malformed`, reason: 'line is not JSON — the transcript format may have moved' })
      continue
    }
    const parsed = parseEvent(harness, event)
    if (parsed.malformed) {
      failures.push({ key: `${index}:malformed`, reason: 'line is not a JSON object — the transcript format may have moved' })
      continue
    }
    if (parsed.unknown) {
      failures.push({
        key: `${index}:unknown:${parsed.unknown}`,
        reason: `unknown ${harness} line type "${parsed.unknown}" — the transcript format moved underneath the reader`,
      })
    }
    const record = { event, parsed }
    records.push(record)
    if (!event?.uuid) continue
    byUuid.set(event.uuid, record)
    tail = record
  }

  if (landingUuid) {
    tail = byUuid.get(landingUuid) ?? null
    if (!tail) {
      failures.push({
        key: `landing:${landingUuid}`,
        reason: `transcript landing point "${landingUuid}" is missing`,
      })
      return { items, failures }
    }
  }

  let activeRecords = records
  if (tail) {
    activeRecords = []
    const seen = new Set()
    for (let record = tail; record; record = record.event.parentUuid ? byUuid.get(record.event.parentUuid) : null) {
      if (seen.has(record.event.uuid)) {
        failures.push({
          key: `cycle:${record.event.uuid}`,
          reason: `transcript parent cycle at "${record.event.uuid}"`,
        })
        return { items, failures }
      }
      seen.add(record.event.uuid)
      activeRecords.push(record)
    }
    activeRecords.reverse()
  }

  for (const { parsed } of activeRecords) {
    if (parsed.items) items.push(...parsed.items)
  }
  return { items, failures }
}

function parseEvent(harness, event) {
  const reader = READERS[harness]
  if (!reader) throw new Error(`no transcript reader for harness "${harness}"`)
  if (!event || typeof event !== 'object') return { malformed: true }
  const items = reader(event)
  if (items === null) {
    return { unknown: harness === 'codex' && event.type === 'response_item' ? `response_item/${event.payload?.type}` : String(event.type) }
  }
  return { items }
}

// Read the messages on one transcript's active branch (#689). The interface
// names no conversation role. Agent and overseer panes both provide a harness,
// transcript text, and an optional landing from the durable rewind receipt.
//
// Claude stores one conversation as an append-only graph. Every graph record
// carries `uuid` and `parentUuid`. The last record is the active head after a
// fork. During the quiet window after a rewind, the transcript still ends on
// the abandoned branch, so the journaled landing is the temporary head.
// Harnesses without parent identity retain their linear transcript behavior.
export function readActiveTranscript(harness, source, { landingUuid = null, landingTailUuid = null } = {}) {
  const lines = Array.isArray(source)
    ? source.map(String)
    : String(source ?? '').split('\n')
  const records = lines
    .map((line, index) => ({ line, index }))
    .filter((record) => record.line.trim())

  if (harness !== 'claude') return parseActiveRecords(harness, records, null)

  const byUuid = new Map()
  let tailUuid = null
  for (const record of records) {
    try {
      record.event = JSON.parse(record.line)
    } catch {
      continue
    }
    if (!record.event?.uuid) continue
    record.uuid = String(record.event.uuid)
    record.parentUuid = record.event.parentUuid == null ? null : String(record.event.parentUuid)
    byUuid.set(record.uuid, record)
    tailUuid = record.uuid
  }

  const landingStillCurrent = landingUuid
    && (!landingTailUuid || String(landingTailUuid) === tailUuid)
  const headUuid = landingStillCurrent ? String(landingUuid) : tailUuid
  if (!headUuid) return parseActiveRecords(harness, records, null)
  if (!byUuid.has(headUuid)) {
    return { items: [], records: [], failures: [`landing ${headUuid} is absent from the transcript`], headUuid }
  }

  const active = new Set()
  let at = headUuid
  while (at) {
    if (active.has(at)) {
      return { items: [], records: [], failures: [`parent identity cycle at ${at}`], headUuid }
    }
    const record = byUuid.get(at)
    if (!record) {
      return { items: [], records: [], failures: [`parent ${at} is absent from the transcript`], headUuid }
    }
    active.add(at)
    at = record.parentUuid
  }

  return parseActiveRecords(harness, records, active, headUuid)
}

function parseActiveRecords(harness, records, active, headUuid = null) {
  const items = []
  const messages = []
  const failures = []
  for (const record of records) {
    if (active && record.uuid && !active.has(record.uuid)) continue
    const parsed = parseLine(harness, record.line)
    if (parsed.malformed) {
      failures.push(`line ${record.index + 1} is not JSON`)
      continue
    }
    if (parsed.unknown) {
      failures.push(`line ${record.index + 1} has unknown ${harness} type "${parsed.unknown}"`)
      continue
    }
    items.push(...parsed.items)
    let event = record.event
    if (!event) {
      try { event = JSON.parse(record.line) } catch { event = null }
    }
    messages.push({
      index: record.index,
      event,
      uuid: record.uuid ?? null,
      parentUuid: record.parentUuid ?? null,
      items: parsed.items,
    })
  }
  return { items, records: messages, failures, headUuid }
}

export function parseLine(harness, line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return { malformed: true }
  }
  return parseEvent(harness, event)
}

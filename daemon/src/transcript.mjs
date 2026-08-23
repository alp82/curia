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

export const TRANSCRIPT_HARNESSES = ['claude', 'codex']

function readdirSafe(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

// Which harness wrote this config dir, by positive on-disk evidence: the claude
// harness creates `projects/`, codex's creates `sessions/`. Null when
// neither is there — a dir that has not been written yet is "no transcript",
// never a guess. The dispatcher's own agent record wins over this probe when
// it has one (it knows what it spawned); this is the fallback for re-adopted
// and lab sessions.
export function detectHarness(cfgDir) {
  if (fs.existsSync(path.join(cfgDir, 'projects'))) return 'claude'
  if (fs.existsSync(path.join(cfgDir, 'sessions'))) return 'codex'
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
function claudeFiles(cfgDir) {
  const projects = path.join(cfgDir, 'projects')
  const files = []
  for (const proj of readdirSafe(projects)) {
    for (const f of readdirSafe(path.join(projects, proj))) {
      if (f.endsWith('.jsonl')) files.push(path.join(projects, proj, f))
    }
  }
  return files
}

// A spawned codex subagent writes a second rollout into its parent's config
// directory. Its first line identifies it, so it must not win the parent's
// newest-file lookup while the parent waits (#544, #545).
function codexThreadSource(file) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return null }
  try {
    const size = Math.min(fs.fstatSync(fd).size, 16 * 1024)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, 0)
    const first = buf.toString('utf8').split('\n').find((line) => line.trim())
    if (!first) return null
    const event = JSON.parse(first)
    return event?.type === 'session_meta' ? event.payload?.thread_source ?? null : null
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

function codexFiles(cfgDir) {
  // sessions/<year>/<month>/<day>/rollout-*.jsonl
  const files = []
  const walk = (dir, depth) => {
    for (const entry of readdirSafe(dir)) {
      const p = path.join(dir, entry)
      if (depth < 3) walk(p, depth + 1)
      else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl') && codexThreadSource(p) !== 'subagent') {
        files.push(p)
      }
    }
  }
  walk(path.join(cfgDir, 'sessions'), 0)
  return files
}

const FILES = { claude: claudeFiles, codex: codexFiles }

// What each harness NAMES a session's transcript. The claude harness names the
// file after the session id — measured on the box (docs/live-checks/
// 332-transcript-by-key.md). The codex harness puts the rollout's start time in
// front of it, which is read off the name shape this module already walks
// rather than measured: no codex conversation is keyed today, because the
// overseer is the one thing curia keys and it runs the claude harness.
const NAMES_SESSION = {
  claude: (base, id) => base === `${id}.jsonl`,
  codex: (base, id) => base.startsWith('rollout-') && base.endsWith(`-${id}.jsonl`),
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

function firstLine(s, n = 200) {
  const line = String(s ?? '').split('\n').find((l) => l.trim()) ?? ''
  return line.length > n ? `${line.slice(0, n)}…` : line
}

// ---------------------------------------------------------------------------
// claude harness
// ---------------------------------------------------------------------------

// Line types the claude CLI writes that carry nothing a timeline shows —
// enumerated from real agent transcripts on this box. `summary` is the
// compaction artifact; the file-history pair is checkpointing; the rest are
// UI bookkeeping.
const CLAUDE_UNRENDERED = new Set([
  'system', 'ai-title', 'attachment', 'file-history-delta',
  'file-history-snapshot', 'last-prompt', 'mode', 'permission-mode', 'summary',
])

// One line that says what a tool call is DOING, per tool — the only place this
// harness's tool vocabulary is known (spike shape).
function claudeToolBrief(name, input = {}) {
  if (name === 'Bash') return firstLine(input.command)
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    return String(input.file_path ?? '')
  }
  if (name === 'Grep' || name === 'Glob') return `${input.pattern ?? ''} ${input.path ?? ''}`.trim()
  if (name === 'TodoWrite') return `${input.todos?.length ?? 0} items`
  if (name?.startsWith('mcp__curia__')) {
    return firstLine(input.prompt ?? input.summary ?? input.message ?? JSON.stringify(input))
  }
  if (name === 'Task' || name === 'Agent') return firstLine(input.description ?? input.prompt)
  return firstLine(JSON.stringify(input), 160)
}

// The full operator-facing text of a curia surface call (#108 item 1): notify
// and its siblings carry prose written FOR the timeline's reader, so the
// one-line brief must not be all that survives. ask_human keeps only the brief
// here — its full body renders from the daemon's own escalation record.
function curiaToolText(input = {}) {
  const t = input.prompt ?? input.message ?? input.summary
  return typeof t === 'string' && t.trim() ? t : null
}

function claudeResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n')
  }
  return JSON.stringify(content ?? '')
}

function claudeItems(e) {
  const at = e.timestamp ?? null
  if (e.type === 'assistant') {
    const out = []
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'say', at, text: c.text })
      // Real agents store thinking signature-only with empty text (#72/#73
      // measured 41 of 41), so this arm almost never fires — kept because a
      // transcript that DOES carry text should show it.
      else if (c.type === 'thinking' && c.thinking?.trim()) out.push({ kind: 'think', at, text: c.thinking })
      else if (c.type === 'tool_use') {
        const item = { kind: 'tool', at, id: c.id, name: c.name, brief: claudeToolBrief(c.name, c.input) }
        if (c.name?.startsWith('mcp__curia__')) {
          const text = curiaToolText(c.input)
          if (text) item.text = text
        }
        out.push(item)
      }
    }
    return out
  }
  if (e.type === 'user') {
    const content = e.message?.content
    if (typeof content === 'string') {
      return content.trim() ? [{ kind: 'prompt', at, text: content }] : []
    }
    const out = []
    for (const c of content ?? []) {
      if (c.type === 'tool_result') {
        const text = claudeResultText(c.content)
        out.push({
          kind: 'result', at, forId: c.tool_use_id, ok: !c.is_error,
          brief: firstLine(text, 300), lines: text.split('\n').length,
        })
      } else if (c.type === 'text' && c.text?.trim()) {
        out.push({ kind: 'prompt', at, text: c.text })
      } else if (c.type === 'image') {
        out.push({ kind: 'note', at, text: '[image]' })
      }
    }
    return out
  }
  // A message driven in mid-turn is ENQUEUED, then removed when the turn picks
  // it up and it reappears as a plain user message. Only the enqueue is
  // rendered — the moment the other device's input became visible.
  if (e.type === 'queue-operation') {
    if (e.operation === 'enqueue' && e.content) return [{ kind: 'queued', at, text: String(e.content) }]
    return []
  }
  if (CLAUDE_UNRENDERED.has(e.type)) return []
  return null // unknown vocabulary — the caller reports it
}

// ---------------------------------------------------------------------------
// codex harness
// ---------------------------------------------------------------------------

// event_msg is codex's live-UI event stream and every payload type it carries
// is DUPLICATED by (or derivable from) a response_item on the same file —
// agent_message/user_message mirror `message` items, mcp_tool_call_end mirrors
// a function_call_output, token_count/task_started/task_complete are counters.
// Rendering from response_item alone avoids double items, so event_msg is
// tolerated wholesale rather than allowlisted per payload type: a NEW event
// subtype is additive UI noise, not a vocabulary break. The break signal for
// this harness is an unknown response_item payload or an unknown top-level type.
const CODEX_TOPLEVEL_UNRENDERED = new Set([
  'event_msg', 'session_meta', 'turn_context', 'world_state', 'compacted',
])

// reasoning is stored encrypted with no text (same fact as claude's
// signature-only thinking — the terminal shows it live, no timeline can).
const CODEX_ITEM_UNRENDERED = new Set(['reasoning', 'ghost_snapshot'])

function codexDisplayName(name, namespace) {
  // namespace "mcp__curia" + name "ask_human" → "curia.ask_human", matching
  // how the page shows the claude harness's mcp__curia__ tools.
  if (namespace) return `${String(namespace).replace(/^mcp__/, '')}.${name}`
  return name
}

function codexArgs(raw) {
  try { return JSON.parse(raw ?? '{}') ?? {} } catch { return {} }
}

function codexToolBrief(name, args) {
  if (name === 'exec_command' || name === 'shell') return firstLine(args.cmd ?? args.command)
  if (name === 'write_stdin') return firstLine(args.chars)
  if (name === 'ask_human' || name === 'notify' || name === 'report_result' || name === 'request_review') {
    return firstLine(args.prompt ?? args.message ?? args.summary ?? JSON.stringify(args))
  }
  return firstLine(JSON.stringify(args), 160)
}

// A codex tool output is a plain string on the classic tools and an ARRAY of
// content blocks on 0.146's exec harness — and the array is the only path an
// image takes to the model (measured on #176: an MCP `image` block arrives as
// `{type:"input_image", image_url:"data:…"}`). Flatten to text, with each
// image standing in as [image] — the claude harness's own spelling — so a
// message whose only cargo is a screenshot renders as something rather than
// as "[object Object]".
function codexOutputText(output) {
  if (!Array.isArray(output)) return String(output ?? '')
  return output
    .map((b) => (String(b?.type ?? '').includes('image') ? '[image]' : String(b?.text ?? '')))
    .filter((s) => s.trim()).join('\n')
}

// exec_command outputs open with a bookkeeping preamble; the human wants the
// command's own first line.
function codexResultText(output) {
  const s = codexOutputText(output)
  const m = /^Output:\n?/m.exec(s)
  return m ? s.slice(m.index + m[0].length) : s
}

function codexItems(e) {
  const at = e.timestamp ?? null
  if (e.type === 'response_item') {
    const p = e.payload ?? {}
    if (p.type === 'message') {
      if (p.role !== 'assistant' && p.role !== 'user') return [] // developer: injected context, not conversation
      const parts = p.content ?? []
      const text = parts
        .filter((c) => c?.type === 'output_text' || c?.type === 'input_text')
        .map((c) => c.text).filter((t) => t?.trim()).join('\n')
      const out = []
      if (text) out.push({ kind: p.role === 'assistant' ? 'say' : 'prompt', at, text })
      // #176 gap 9: an image block used to render as NO item at all, where the
      // claude harness shows [image] (its user-message image case). Same note here.
      for (const c of parts) {
        if (String(c?.type ?? '').includes('image')) out.push({ kind: 'note', at, text: '[image]' })
      }
      return out
    }
    if (p.type === 'function_call') {
      const args = codexArgs(p.arguments)
      const item = {
        kind: 'tool', at, id: p.call_id ?? p.id,
        name: codexDisplayName(p.name, p.namespace),
        brief: codexToolBrief(p.name, args),
      }
      if (String(p.namespace ?? '').startsWith('mcp__curia')) {
        const text = curiaToolText(args)
        if (text) item.text = text
      }
      return [item]
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const text = codexResultText(p.output)
      const exit = /Process exited with code (\d+)/.exec(codexOutputText(p.output))
      return [{
        kind: 'result', at, forId: p.call_id, ok: exit ? exit[1] === '0' : true,
        brief: firstLine(text, 300), lines: text.split('\n').length,
      }]
    }
    // 0.146's exec harness (measured on #176): MCP calls no longer arrive as
    // namespaced function_calls — the model writes a custom_tool_call named
    // `exec` whose `input` is JS driving `tools.mcp__<server>__<tool>`. The
    // input is a raw string, not JSON arguments.
    if (p.type === 'custom_tool_call') {
      return [{ kind: 'tool', at, id: p.call_id ?? p.id, name: p.name, brief: firstLine(String(p.input ?? ''), 160) }]
    }
    if (p.type === 'tool_search_call') return [{ kind: 'tool', at, id: p.id, name: 'tool_search', brief: firstLine(p.query ?? '') }]
    if (p.type === 'tool_search_output') return [{ kind: 'result', at, forId: p.id, ok: true, brief: '', lines: 1 }]
    if (CODEX_ITEM_UNRENDERED.has(p.type)) return []
    return null // unknown response_item vocabulary
  }
  if (CODEX_TOPLEVEL_UNRENDERED.has(e.type)) return []
  return null
}

// ---------------------------------------------------------------------------

const READERS = { claude: claudeItems, codex: codexItems }

export function parseLine(harness, line) {
  const reader = READERS[harness]
  if (!reader) throw new Error(`no transcript reader for harness "${harness}"`)
  let e
  try {
    e = JSON.parse(line)
  } catch {
    return { malformed: true }
  }
  if (!e || typeof e !== 'object') return { malformed: true }
  const items = reader(e)
  if (items === null) {
    return { unknown: harness === 'codex' && e.type === 'response_item' ? `response_item/${e.payload?.type}` : String(e.type) }
  }
  return { items }
}

// Per-harness transcript readers (#74 item 3, the #39 harness-table shape).
//
// Every agent writes a structured, geometry-free transcript under its own
// config dir — the claude harness as `projects/<proj>/<uuid>.jsonl` under
// CLAUDE_CONFIG_DIR, the codex harness as `sessions/<y>/<m>/<d>/rollout-*.jsonl`
// under CODEX_HOME — and the timeline surface reads it instead of parsing a
// terminal (#72/#73). This module is the ONLY place that knows either
// vocabulary. Everything here is pure given a line of text; the fs helpers
// below are the two file-finding functions.
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

export function findTranscript(harness, cfgDir) {
  if (harness === 'claude') {
    const projects = path.join(cfgDir, 'projects')
    const files = []
    for (const proj of readdirSafe(projects)) {
      for (const f of readdirSafe(path.join(projects, proj))) {
        if (f.endsWith('.jsonl')) files.push(path.join(projects, proj, f))
      }
    }
    return newestFile(files)
  }
  if (harness === 'codex') {
    // sessions/<year>/<month>/<day>/rollout-*.jsonl
    const root = path.join(cfgDir, 'sessions')
    const files = []
    const walk = (dir, depth) => {
      for (const entry of readdirSafe(dir)) {
        const p = path.join(dir, entry)
        if (depth < 3) walk(p, depth + 1)
        else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) files.push(p)
      }
    }
    walk(root, 0)
    return newestFile(files)
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

// exec_command outputs open with a bookkeeping preamble; the human wants the
// command's own first line.
function codexResultText(output) {
  const s = String(output ?? '')
  const m = /^Output:\n?/m.exec(s)
  return m ? s.slice(m.index + m[0].length) : s
}

function codexItems(e) {
  const at = e.timestamp ?? null
  if (e.type === 'response_item') {
    const p = e.payload ?? {}
    if (p.type === 'message') {
      const text = (p.content ?? [])
        .filter((c) => c?.type === 'output_text' || c?.type === 'input_text')
        .map((c) => c.text).filter((t) => t?.trim()).join('\n')
      if (!text) return []
      if (p.role === 'assistant') return [{ kind: 'say', at, text }]
      if (p.role === 'user') return [{ kind: 'prompt', at, text }]
      return [] // developer: injected context, not conversation
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
    if (p.type === 'function_call_output') {
      const text = codexResultText(p.output)
      const exit = /Process exited with code (\d+)/.exec(String(p.output ?? ''))
      return [{
        kind: 'result', at, forId: p.call_id, ok: exit ? exit[1] === '0' : true,
        brief: firstLine(text, 300), lines: text.split('\n').length,
      }]
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

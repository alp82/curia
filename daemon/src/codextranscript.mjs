import fs from 'node:fs'
import path from 'node:path'

import {
  curiaSendBrief,
  curiaToolSend,
  curiaToolText,
  firstTranscriptLine,
  isCuriaSend,
} from './transcriptformat.mjs'

const TOPLEVEL_UNRENDERED = new Set([
  'event_msg', 'session_meta', 'turn_context', 'world_state', 'compacted',
])

const ITEM_UNRENDERED = new Set(['reasoning', 'ghost_snapshot'])

const readdirSafe = (dir) => {
  try { return fs.readdirSync(dir) } catch { return [] }
}

function threadSource(file) {
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

export function codexTranscriptFiles(cfgDir) {
  const files = []
  const walk = (dir, depth) => {
    for (const entry of readdirSafe(dir)) {
      const file = path.join(dir, entry)
      if (depth < 3) walk(file, depth + 1)
      else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl') && threadSource(file) !== 'subagent') {
        files.push(file)
      }
    }
  }
  walk(path.join(cfgDir, 'sessions'), 0)
  return files
}

export const codexTranscriptForSession = (base, id) => (
  base.startsWith('rollout-') && base.endsWith(`-${id}.jsonl`)
)

export const codexTranscriptPresent = (cfgDir) => fs.existsSync(path.join(cfgDir, 'sessions'))

function displayName(name, namespace) {
  if (namespace) return `${String(namespace).replace(/^mcp__/, '')}.${name}`
  return name
}

function argsFrom(raw) {
  try { return JSON.parse(raw ?? '{}') ?? {} } catch { return {} }
}

function toolBrief(name, args) {
  if (name === 'exec_command' || name === 'shell') return firstTranscriptLine(args.cmd ?? args.command)
  if (name === 'write_stdin') return firstTranscriptLine(args.chars)
  if (name === 'ask_human' || name === 'notify' || name === 'report_result' || name === 'request_review') {
    if (isCuriaSend(args)) return curiaSendBrief(args)
    return firstTranscriptLine(args.prompt ?? args.message ?? args.summary ?? JSON.stringify(args))
  }
  return firstTranscriptLine(JSON.stringify(args), 160)
}

function outputText(output) {
  if (!Array.isArray(output)) return String(output ?? '')
  return output
    .map((block) => (String(block?.type ?? '').includes('image') ? '[image]' : String(block?.text ?? '')))
    .filter((text) => text.trim()).join('\n')
}

function resultText(output) {
  const text = outputText(output)
  const preamble = /^Output:\n?/m.exec(text)
  return preamble ? text.slice(preamble.index + preamble[0].length) : text
}

export function parseCodexTranscriptEvent(event) {
  const at = event.timestamp ?? null
  if (event.type === 'response_item') {
    const payload = event.payload ?? {}
    if (payload.type === 'message') {
      if (payload.role !== 'assistant' && payload.role !== 'user') return []
      const parts = payload.content ?? []
      const text = parts
        .filter((part) => part?.type === 'output_text' || part?.type === 'input_text')
        .map((part) => part.text).filter((part) => part?.trim()).join('\n')
      const items = []
      if (text) items.push({ kind: payload.role === 'assistant' ? 'say' : 'prompt', at, text })
      for (const part of parts) {
        if (String(part?.type ?? '').includes('image')) items.push({ kind: 'note', at, text: '[image]' })
      }
      return items
    }
    if (payload.type === 'function_call') {
      const args = argsFrom(payload.arguments)
      const item = {
        kind: 'tool', at, id: payload.call_id ?? payload.id,
        name: displayName(payload.name, payload.namespace),
        brief: toolBrief(payload.name, args),
      }
      if (String(payload.namespace ?? '').startsWith('mcp__curia')) {
        const text = curiaToolText(args)
        if (text) item.text = text
        const send = curiaToolSend(args)
        if (send) item.send = send
      }
      return [item]
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const text = resultText(payload.output)
      const exit = /Process exited with code (\d+)/.exec(outputText(payload.output))
      return [{
        kind: 'result', at, forId: payload.call_id, ok: exit ? exit[1] === '0' : true,
        brief: firstTranscriptLine(text, 300), lines: text.split('\n').length,
      }]
    }
    if (payload.type === 'custom_tool_call') {
      return [{
        kind: 'tool', at, id: payload.call_id ?? payload.id, name: payload.name,
        brief: firstTranscriptLine(String(payload.input ?? ''), 160),
      }]
    }
    if (payload.type === 'tool_search_call') {
      return [{ kind: 'tool', at, id: payload.id, name: 'tool_search', brief: firstTranscriptLine(payload.query ?? '') }]
    }
    if (payload.type === 'tool_search_output') {
      return [{ kind: 'result', at, forId: payload.id, ok: true, brief: '', lines: 1 }]
    }
    if (ITEM_UNRENDERED.has(payload.type)) return []
    return null
  }
  if (TOPLEVEL_UNRENDERED.has(event.type)) return []
  return null
}

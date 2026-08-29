import fs from 'node:fs'
import path from 'node:path'

import {
  curiaSendBrief,
  curiaToolSend,
  curiaToolText,
  firstTranscriptLine,
  isCuriaSend,
} from './transcriptformat.mjs'

const UNRENDERED = new Set([
  'system', 'ai-title', 'attachment', 'file-history-delta',
  'file-history-snapshot', 'last-prompt', 'mode', 'permission-mode', 'summary',
])

const readdirSafe = (dir) => {
  try { return fs.readdirSync(dir) } catch { return [] }
}

export function claudeTranscriptFiles(cfgDir) {
  const projects = path.join(cfgDir, 'projects')
  const files = []
  for (const project of readdirSafe(projects)) {
    for (const file of readdirSafe(path.join(projects, project))) {
      if (file.endsWith('.jsonl')) files.push(path.join(projects, project, file))
    }
  }
  return files
}

export const claudeTranscriptForSession = (base, id) => base === `${id}.jsonl`

export const claudeTranscriptPresent = (cfgDir) => fs.existsSync(path.join(cfgDir, 'projects'))

function toolBrief(name, input = {}) {
  if (name === 'Bash') return firstTranscriptLine(input.command)
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    return String(input.file_path ?? '')
  }
  if (name === 'Grep' || name === 'Glob') return `${input.pattern ?? ''} ${input.path ?? ''}`.trim()
  if (name === 'TodoWrite') return `${input.todos?.length ?? 0} items`
  if (name?.startsWith('mcp__curia__')) {
    if (isCuriaSend(input)) return curiaSendBrief(input)
    return firstTranscriptLine(input.prompt ?? input.summary ?? input.message ?? JSON.stringify(input))
  }
  if (name === 'Task' || name === 'Agent') return firstTranscriptLine(input.description ?? input.prompt)
  return firstTranscriptLine(JSON.stringify(input), 160)
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => (item?.type === 'text' ? item.text : `[${item?.type}]`)).join('\n')
  }
  return JSON.stringify(content ?? '')
}

export function parseClaudeTranscriptEvent(event) {
  const at = event.timestamp ?? null
  if (event.type === 'assistant') {
    const items = []
    for (const content of event.message?.content ?? []) {
      if (content.type === 'text' && content.text?.trim()) {
        items.push({ kind: 'say', at, text: content.text })
      } else if (content.type === 'thinking' && content.thinking?.trim()) {
        items.push({ kind: 'think', at, text: content.thinking })
      } else if (content.type === 'tool_use') {
        const item = {
          kind: 'tool', at, id: content.id, name: content.name,
          brief: toolBrief(content.name, content.input),
        }
        if (content.name?.startsWith('mcp__curia__')) {
          const text = curiaToolText(content.input)
          if (text) item.text = text
          const send = curiaToolSend(content.input)
          if (send) item.send = send
        }
        items.push(item)
      }
    }
    return items
  }
  if (event.type === 'user') {
    const content = event.message?.content
    if (typeof content === 'string') return content.trim() ? [{ kind: 'prompt', at, text: content }] : []
    const items = []
    for (const item of content ?? []) {
      if (item.type === 'tool_result') {
        const text = resultText(item.content)
        items.push({
          kind: 'result', at, forId: item.tool_use_id, ok: !item.is_error,
          brief: firstTranscriptLine(text, 300), lines: text.split('\n').length,
        })
      } else if (item.type === 'text' && item.text?.trim()) {
        items.push({ kind: 'prompt', at, text: item.text })
      } else if (item.type === 'image') {
        items.push({ kind: 'note', at, text: '[image]' })
      }
    }
    return items
  }
  if (event.type === 'queue-operation') {
    return event.operation === 'enqueue' && event.content
      ? [{ kind: 'queued', at, text: String(event.content) }]
      : []
  }
  if (UNRENDERED.has(event.type)) return []
  return null
}

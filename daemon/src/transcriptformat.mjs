import { renderCompositeSend } from './composite.mjs'

export function firstTranscriptLine(value, max = 200) {
  const line = String(value ?? '').split('\n').find((candidate) => candidate.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export function curiaToolText(input = {}) {
  const text = input.prompt ?? input.message ?? input.summary
  return typeof text === 'string' && text.trim() ? text : null
}

export function curiaToolSend(input = {}) {
  if (!isCuriaSend(input)) return null
  try {
    return renderCompositeSend(input.messages)
      .map(({ rail, body, deciding, format, label }) => ({ rail, body, deciding, format, label }))
  } catch {
    return null
  }
}

export function curiaSendBrief(input = {}) {
  const labels = input.messages.map((message) => String(message?.label ?? message?.format ?? '?').trim())
  return `send of ${input.messages.length}: ${labels.join(' · ')}`
}

export const isCuriaSend = (input) => Array.isArray(input?.messages) && input.messages.length > 0

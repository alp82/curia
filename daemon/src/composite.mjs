// The pure composite-send contract (#691, ADR-0026).
//
// This module knows the payload and nothing about Discord, Atlas, tools, or
// journals. Callers keep the proposed messages unchanged when this returns
// faults. A refusal must never turn five authored messages into four delivered
// messages.

import { CAPS, gradeA, gradeB, lintAskHuman, lintVisual } from './lint.mjs'
import { composeCard, visualBlock } from './card.mjs'
import { smallPrint } from './messaging.mjs'

export const MAX_MESSAGES_PER_SEND = 4
export const MESSAGE_LABEL_CAP = 20
export const PROSE_CAP = 1600
export const QUESTION_BACKGROUND_CAP = 600
export const MESSAGE_FORMATS = [
  'prose', 'round', 'choice', 'approve-reject', 'preview-review', 'visual', 'files',
]
export const DECIDING_FORMATS = ['round', 'choice', 'approve-reject', 'preview-review']

const FORMAT_KIND = {
  round: 'free-text',
  choice: 'choice',
  'approve-reject': 'approve-reject',
  'preview-review': 'preview-review',
}

const COMMON_FIELDS = ['format', 'label', 'attachments', 'picture', 'table', 'diagram']
const FORMAT_FIELDS = {
  prose: ['text'],
  round: ['headline', 'questions', 'detail', 'timeline'],
  choice: ['headline', 'options', 'detail', 'timeline'],
  'approve-reject': ['headline', 'options', 'detail', 'timeline'],
  'preview-review': ['headline', 'options', 'detail', 'timeline', 'preview_url'],
  visual: [],
  files: ['caption'],
}

const present = (value) => value !== undefined && value !== null && String(value).trim() !== ''

function contentSchemaFaults(message, i) {
  const at = `messages[${i}]`
  const faults = []
  const format = message.format
  if (!MESSAGE_FORMATS.includes(format)) return faults
  const allowed = new Set([...COMMON_FIELDS, ...FORMAT_FIELDS[format], 'visual', 'images'])
  for (const field of Object.keys(message)) {
    if (!allowed.has(field)) faults.push(`${at}.${field}: not permitted on the ${format} format.`)
  }
  const textField = (target, field, fieldAt = at) => {
    if (target[field] !== undefined && typeof target[field] !== 'string') faults.push(`${fieldAt}.${field}: expected text.`)
  }
  for (const field of ['text', 'headline', 'detail', 'preview_url', 'caption']) textField(message, field)
  if (message.timeline !== undefined && typeof message.timeline !== 'boolean') faults.push(`${at}.timeline: expected true or false.`)
  if (format === 'prose' && !present(message.text)) faults.push(`${at}.text: missing. A prose message needs its prose.`)
  if (format === 'round') {
    if (!present(message.headline)) faults.push(`${at}.headline: missing.`)
    if (!Array.isArray(message.questions) || !message.questions.length) {
      faults.push(`${at}.questions: missing. A round needs one question or more.`)
    } else {
      message.questions.forEach((question, j) => {
        const qAt = `${at}.questions[${j}]`
        if (!question || typeof question !== 'object' || Array.isArray(question)) {
          faults.push(`${qAt}: expected a question object.`)
          return
        }
        for (const field of Object.keys(question)) {
          if (!['text', 'background', 'recommendation'].includes(field)) faults.push(`${qAt}.${field}: not permitted on a question.`)
        }
        if (!present(question.text)) faults.push(`${qAt}.text: missing.`)
        for (const field of ['text', 'background', 'recommendation']) textField(question, field, qAt)
      })
    }
  }
  if (format === 'choice') {
    if (!present(message.headline)) faults.push(`${at}.headline: missing.`)
    if (!Array.isArray(message.options) || message.options.length < 2) {
      faults.push(`${at}.options: a choice needs two options or more.`)
    } else {
      message.options.forEach((option, j) => {
        const oAt = `${at}.options[${j}]`
        if (!option || typeof option !== 'object' || Array.isArray(option)) {
          faults.push(`${oAt}: expected an option object.`)
          return
        }
        for (const field of Object.keys(option)) {
          if (!['label', 'handle', 'consequence', 'example', 'recommended'].includes(field)) faults.push(`${oAt}.${field}: not permitted on an option.`)
        }
        if (!present(option.label)) faults.push(`${oAt}.label: missing.`)
        for (const field of ['label', 'handle', 'consequence', 'example']) textField(option, field, oAt)
        if (!present(option.handle)) faults.push(`${oAt}.handle: missing. A choice button needs a short handle.`)
        else if (typeof option.handle !== 'string') faults.push(`${oAt}.handle: expected one line of text.`)
        if (!present(option.consequence)) faults.push(`${oAt}.consequence: missing.`)
        if (option.recommended !== undefined && typeof option.recommended !== 'boolean') faults.push(`${oAt}.recommended: expected true or false.`)
      })
    }
  }
  if (format === 'approve-reject' || format === 'preview-review') {
    if (!present(message.headline)) faults.push(`${at}.headline: missing.`)
    if (message.options !== undefined) {
      if (!Array.isArray(message.options) || message.options.length !== 2) {
        faults.push(`${at}.options: approve and reject take exactly two options.`)
      } else {
        message.options.forEach((option, j) => {
          const oAt = `${at}.options[${j}]`
          if (!option || typeof option !== 'object' || Array.isArray(option)) {
            faults.push(`${oAt}: expected an option object.`)
            return
          }
          for (const field of Object.keys(option)) {
            if (!['consequence', 'example'].includes(field)) faults.push(`${oAt}.${field}: not permitted on an approve-reject option.`)
          }
          for (const field of ['consequence', 'example']) textField(option, field, oAt)
          if (!present(option.consequence)) faults.push(`${oAt}.consequence: missing.`)
        })
      }
    }
  }
  if (format === 'preview-review' && !present(message.preview_url)) faults.push(`${at}.preview_url: missing.`)
  if (format === 'visual' && !['picture', 'table', 'diagram'].some((field) => present(message[field]))) {
    faults.push(`${at}: a visual message needs a picture, table, or diagram.`)
  }
  if (format === 'files') {
    if (!present(message.caption)) faults.push(`${at}.caption: missing.`)
    if (!Array.isArray(message.attachments) || !message.attachments.length) {
      faults.push(`${at}.attachments: missing. A files message needs one file or more.`)
    }
  }
  return faults
}

export function compositeSendSchemaFaults(messages, { maxMessages = MAX_MESSAGES_PER_SEND } = {}) {
  if (!Array.isArray(messages)) return ['messages: missing. A send is an ordered array of typed messages.']
  const faults = []
  if (!messages.length) faults.push('messages: empty. A send needs one typed message or more.')
  if (messages.length > maxMessages) {
    faults.push(`messages: ${messages.length} messages over the ${maxMessages} message cap. Compose another send. Curia refuses the send, it never drops a message.`)
  }
  for (const [i, message] of messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      faults.push(`messages[${i}]: expected a typed message object.`)
      continue
    }
    const format = message?.format
    if (!MESSAGE_FORMATS.includes(format)) {
      faults.push(`messages[${i}].format: ${JSON.stringify(format)} is not supported. Use ${MESSAGE_FORMATS.join(', ')}.`)
    }
    const at = `messages[${i}]`
    if (typeof message?.label !== 'string' || !message.label.trim()) {
      faults.push(`${at}.label: missing. Every typed message needs a short rail label.`)
    }
    if (message?.attachments !== undefined) {
      if (!Array.isArray(message.attachments)) {
        faults.push(`${at}.attachments: expected an array of file paths.`)
      } else {
        message.attachments.forEach((attachment, j) => {
          if (typeof attachment !== 'string' || !attachment.trim()) {
            faults.push(`${at}.attachments[${j}]: expected a file path.`)
          }
        })
      }
    }
    for (const field of ['picture', 'table', 'diagram']) {
      if (message?.[field] !== undefined && typeof message[field] !== 'string') {
        faults.push(`${at}.${field}: expected a string.`)
      }
    }
    if (message?.visual !== undefined) {
      faults.push(`${at}.visual: retired. Put the content in picture, table, or diagram.`)
    }
    if (message?.images !== undefined) {
      faults.push(`${at}.images: retired. Put file paths in attachments.`)
    }
    faults.push(...contentSchemaFaults(message, i))
  }
  const decisions = messages
    .map((message, i) => DECIDING_FORMATS.includes(message?.format) ? i : null)
    .filter((i) => i !== null)
  if (decisions.length > 1) {
    faults.push(`messages: ${decisions.length} deciding messages. A send carries at most one deciding message.`)
  }
  if (decisions.length && decisions.at(-1) !== messages.length - 1) {
    faults.push(`messages: the deciding message at messages[${decisions.at(-1)}] must be last.`)
  }
  return faults
}

const namedVisualFaults = (field, value) => lintVisual(value)
  .map((fault) => fault.replace(/^visual:/, `${field}:`))

export function lintCompositeSend(messages) {
  if (!Array.isArray(messages)) return []
  const faults = []
  for (const [i, message] of messages.entries()) {
    if (!message || typeof message !== 'object') continue
    const at = `messages[${i}]`
    if (typeof message.label === 'string' && message.label.trim()) {
      faults.push(...gradeA(`${at}.label`, message.label, MESSAGE_LABEL_CAP))
    }
    if (message.format === 'prose' && typeof message.text === 'string') {
      const proseFaults = gradeB(`${at}.text`, message.text, PROSE_CAP)
      faults.push(...proseFaults.map((fault) => fault.includes(`over the ${PROSE_CAP} cap`)
        ? `${fault} Compose a second prose message where the meaning breaks.`
        : fault))
    }
    const cardKind = message.format === 'round' ? 'free-text' : message.format
    if (DECIDING_FORMATS.includes(message.format)) {
      faults.push(...lintAskHuman(cardKind, message).map((fault) => `${at}.${fault}`))
    }
    if (message.format === 'choice') {
      for (const [j, option] of (message.options ?? []).entries()) {
        if (typeof option?.handle === 'string') {
          faults.push(...gradeA(`${at}.options[${j}].handle`, option.handle, CAPS.option))
        }
      }
    }
    if (message.format === 'files' && typeof message.caption === 'string') {
      faults.push(...gradeA(`${at}.caption`, message.caption, CAPS.headline))
    }
    for (const [j, question] of (message.questions ?? []).entries()) {
      if (typeof question?.background === 'string') {
        faults.push(...gradeB(`${at}.questions[${j}].background`, question.background, QUESTION_BACKGROUND_CAP))
      }
    }
    if (typeof message.table === 'string') faults.push(...namedVisualFaults(`${at}.table`, message.table))
    if (typeof message.diagram === 'string') faults.push(...namedVisualFaults(`${at}.diagram`, message.diagram))
  }
  return faults
}

export function compositeSendFaults(messages, options) {
  return [...compositeSendSchemaFaults(messages, options), ...lintCompositeSend(messages)]
}

// One rendering description feeds both operator surfaces. Discord turns the
// description into posts and components. Atlas keeps the same fields in its
// conversation event, so neither surface has to infer a message's intent.
export function compositeRail(message, index, count) {
  if (count <= 1) return ''
  return smallPrint(`${index + 1} of ${count} · ${String(message.label).trim()}`)
}

export function renderCompositeMessage(message, index, count) {
  const kind = FORMAT_KIND[message.format] ?? null
  const rail = compositeRail(message, index, count)
  const visual = message.table ?? message.diagram
  let body = ''

  if (message.format === 'prose') body = String(message.text ?? '').trim()
  else if (kind) body = composeCard(kind, { ...message, visual })
  else if (message.format === 'visual') {
    const textVisual = message.table ?? message.diagram
    if (textVisual) body = visualBlock(textVisual)
    else if (message.picture) body = smallPrint('Picture attached.')
  } else if (message.format === 'files') {
    body = String(message.caption ?? '').trim()
  }

  // A picture is looked at in place. Other attachments remain downloads. The
  // transport receives one ordered list because both use Discord file slots.
  const attachments = [message.picture, ...(message.attachments ?? [])].filter(Boolean)
  return {
    format: message.format,
    label: message.label,
    kind,
    deciding: Boolean(kind),
    content: [rail, body].filter(Boolean).join('\n'),
    attachments,
    rail,
    payload: kind ? { ...message, visual } : null,
  }
}

export function renderCompositeSend(messages) {
  return messages.map((message, index) => renderCompositeMessage(message, index, messages.length))
}

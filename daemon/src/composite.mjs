// The composite send, rendered (#716, ADR-0026).
//
// `send.mjs` is the CONTRACT: how many messages a send carries, which one may
// decide, where it sits, and which fields each format takes. This module is
// the one renderer over that contract, and both operator surfaces read it.
// Discord posts each rendered message as its own post, and Atlas Chat draws
// the same sequence from the call the transcript carries, so neither surface
// infers a message's intent on its own.
//
// Callers keep the proposed messages unchanged when the contract returns
// faults. A refusal must never turn five authored messages into four
// delivered ones.

import { composeCard, visualBlock } from './card.mjs'
import { smallPrint } from './messaging.mjs'
import {
  MESSAGES_PER_SEND, MESSAGE_FORMATS, DECIDING_FORMATS, sendFloorFaults, lintSend,
} from './send.mjs'

export const MAX_MESSAGES_PER_SEND = MESSAGES_PER_SEND
export { MESSAGE_FORMATS, DECIDING_FORMATS }

const FORMAT_KIND = {
  round: 'free-text',
  choice: 'choice',
  'approve-reject': 'approve-reject',
  'preview-review': 'preview-review',
}

// The floor of a send: a missing or misplaced field, the cap, and the place of
// the deciding message. It is the schema path of ADR-0005, read by `send.mjs`.
export function compositeSendSchemaFaults(messages, { maxMessages = MESSAGES_PER_SEND } = {}) {
  return sendFloorFaults(messages, { cap: maxMessages })
}

// The words of a send, by the grade each field already had.
export const lintCompositeSend = (messages) => lintSend(messages)

export function compositeSendFaults(messages, options) {
  return [...compositeSendSchemaFaults(messages, options), ...lintCompositeSend(messages)]
}

// The rail (#640): its number in the send, then the agent's label. curia writes
// the count, so the reader knows how far the send runs before it asks. A send
// of one message carries no rail, because there is nothing to count.
export function compositeRail(message, index, count) {
  if (count <= 1) return ''
  return smallPrint(`${index + 1} of ${count} · ${String(message.label ?? '').trim()}`)
}

// The fields a deciding message hands the escalation record, in the shape the
// single-message `ask_human` gate already stores.
function cardPayload(message) {
  return {
    headline: message.headline,
    questions: message.questions,
    options: message.options,
    detail: message.detail,
    picture: message.picture,
    table: message.table,
    diagram: message.diagram,
    timeline: message.timeline,
    preview_url: message.preview_url,
  }
}

const present = (value) => value !== undefined && value !== null && String(value).trim() !== ''

const blocks = (message) => ['table', 'diagram']
  .filter((field) => present(message[field]))
  .map((field) => visualBlock(message[field]))

const detailLine = (message) => (present(message.detail) ? [`Details: ||${String(message.detail).trim()}||`] : [])

// The body of one message, without its rail. A prose message is its prose, a
// deciding one is the card `card.mjs` composes, a visual is its block, and a
// files message is its caption.
function messageBody(message) {
  const kind = FORMAT_KIND[message.format] ?? null
  if (kind) return composeCard(kind, cardPayload(message))
  if (message.format === 'prose') {
    return [String(message.prose ?? '').trim(), ...blocks(message), ...detailLine(message)].join('\n\n')
  }
  if (message.format === 'visual') {
    const shown = blocks(message)
    if (!shown.length && present(message.picture)) shown.push(smallPrint('Picture attached.'))
    return [...shown, ...detailLine(message)].join('\n\n')
  }
  if (message.format === 'files') return String(message.caption ?? '').trim()
  return ''
}

export function renderCompositeMessage(message, index, count) {
  const kind = FORMAT_KIND[message.format] ?? null
  const rail = compositeRail(message, index, count)
  const body = messageBody(message)
  // A picture is looked at in place. Other attachments remain downloads. The
  // transport receives one ordered list because both use Discord file slots.
  const attachments = [message.picture, ...(message.attachments ?? [])].filter(Boolean)
  return {
    format: message.format,
    label: message.label ?? null,
    kind,
    deciding: Boolean(kind),
    rail,
    body,
    content: [rail, body].filter(Boolean).join('\n'),
    attachments,
    payload: kind ? cardPayload(message) : null,
  }
}

export function renderCompositeSend(messages) {
  return messages.map((message, index) => renderCompositeMessage(message, index, messages.length))
}

// The composite send (#691), against the contract ADR-0026 locks.
//
// A typed card fits a decision, and not every exchange is one. An agent that
// answered an operator question had no field for the answer, so the explanation
// landed in the one-line spoiler or in an attached markdown file, and the
// operator named both counterproductive. ADR-0026 set the direction instead: a
// response returns an ARRAY, and each entry keeps its own format.
//
// So this module is the payload contract of that array and nothing else. It
// says how many messages a send carries, which one may decide, where that one
// sits, and which fields each format is allowed. It reads pure data and it
// touches no surface: Discord and Atlas are two renderers of what it accepts,
// and #716 builds them.
//
// NOTHING LOOSENS. Every entry is one of the shapes ADR-0019 already types, and
// every field is linted by the grade it already had. Composition replaces
// relaxation, which is the sentence the whole ADR turns on.

import { z } from 'zod'
import {
  CAPS, gradeA, gradeB, floorFaults, lintAskHuman, lintVisualFields, hasVisualField,
  retiredFieldFaults,
} from './lint.mjs'

// The cap on a send. It is a `curia.yaml` default, `dispatch.messages_per_send`,
// with a row on the settings screen — the pattern #635 set for the prototype
// variation count. curia REFUSES a send above the cap, and it never drops a
// message.
export const MESSAGES_PER_SEND = 4

// The message catalog of ADR-0026. `visual` names a message FORMAT here, and
// the field of that name retired with #640.
export const MESSAGE_FORMATS = ['prose', 'round', 'choice', 'approve-reject', 'preview-review', 'visual', 'files']

// The formats that DECIDE. At most one of these per send, and it posts last, so
// the buttons sit at the thread bottom.
export const DECIDING_FORMATS = ['round', 'choice', 'approve-reject', 'preview-review']

// A deciding format is one of the `ask_human` kinds under its ADR-0026 name.
// `round` is what ADR-0019 calls `free-text`, and the rename stops here: the
// floor and the word lint of a round are the ones that already ship.
const KIND_OF = {
  round: 'free-text',
  choice: 'choice',
  'approve-reject': 'approve-reject',
  'preview-review': 'preview-review',
}

// Every entry carries these three, whatever its format. `format` says what it
// is, `label` is what the rail prints, and `attachments` is what a reader
// downloads — a file rides the message it belongs to.
const EVERY_MESSAGE = ['format', 'label', 'attachments']

// The three visual fields (#640), which every format that shows something takes.
const VISUAL = ['picture', 'table', 'diagram']

// The fields each format permits, beyond the three above. A field outside its
// format's list is NAMED rather than stripped: a dropped field takes the words
// the agent wrote with it.
export const CONTENT_FIELDS = {
  prose: ['prose', 'detail', ...VISUAL],
  round: ['headline', 'questions', 'detail', 'timeline', ...VISUAL],
  choice: ['headline', 'options', 'detail', 'timeline', ...VISUAL],
  'approve-reject': ['headline', 'options', 'detail', 'timeline', ...VISUAL],
  'preview-review': ['headline', 'options', 'preview_url', 'detail', 'timeline', ...VISUAL],
  visual: ['detail', ...VISUAL],
  files: ['caption'],
}

const present = (v) => v !== undefined && v !== null && String(v).trim() !== ''
const isDeciding = (m) => DECIDING_FORMATS.includes(m?.format)

// Where the deciding message sits, or -1 when the send decides nothing.
export const decidingIndex = (messages = []) => messages.findIndex(isDeciding)

// Whether a call arrived in the composite shape at all. It picks which contract
// reads the call: a `messages` array takes this module's, and everything else
// keeps the single-message shape ADR-0019 types.
export const isComposite = (payload = {}) => Array.isArray(payload?.messages)

// ---- the floor ----------------------------------------------------------------
//
// A missing or misplaced field is a SCHEMA fault and takes the schema path of
// ADR-0005, exactly as a single-message floor does. The two are counted
// together and the difference is what the agent is told.

function messageFloor(m, i, prefix) {
  const faults = [...retiredFieldFaults(m, prefix)]
  const format = m?.format
  if (!present(format)) {
    faults.push(`${prefix}format: missing. One of ${MESSAGE_FORMATS.join(', ')}.`)
    return faults
  }
  if (!MESSAGE_FORMATS.includes(format)) {
    faults.push(`${prefix}format: "${format}" is not one of ${MESSAGE_FORMATS.join(', ')}.`)
    return faults
  }

  // A field this format does not carry. Named with the format that does carry
  // it wherever curia can say so, because the agent's next attempt is a move
  // rather than a rewrite.
  const allowed = new Set([...EVERY_MESSAGE, ...CONTENT_FIELDS[format]])
  for (const key of Object.keys(m)) {
    if (allowed.has(key)) continue
    // `visual` and `images` are named once, by `retiredFieldFaults`. Naming
    // them again here would spend the agent's reading on one fault twice.
    if (key === 'visual' || key === 'images') continue
    if (m[key] === undefined || m[key] === null) continue
    const home = MESSAGE_FORMATS.find((f) => f !== format && CONTENT_FIELDS[f]?.includes(key))
    faults.push(`${prefix}${key}: a \`${format}\` message does not carry it.${home ? ` A \`${home}\` message does.` : ''}`)
  }

  if (format === 'prose' && !present(m.prose)) {
    faults.push(`${prefix}prose: missing. A prose message is the answer, or the intent of the send.`)
  }
  if (format === 'visual' && !hasVisualField(m)) {
    faults.push(`${prefix}picture: missing. A visual message shows one thing: a \`picture\`, a \`table\`, or a \`diagram\`.`)
  }
  if (format === 'files' && !(m.attachments ?? []).length) {
    faults.push(`${prefix}attachments: missing. A files message is the artifact that stands alone, so it carries at least one file.`)
  }
  if (KIND_OF[format]) faults.push(...floorFaults(KIND_OF[format], m).map((f) => `${prefix}${f}`))
  return faults
}

export function sendFloorFaults(messages, { cap = MESSAGES_PER_SEND } = {}) {
  if (!Array.isArray(messages)) {
    return ['messages: missing. A send is an ordered array, one entry per message.']
  }
  if (!messages.length) {
    return ['messages: empty. A send carries at least one message.']
  }
  const faults = []
  // The cap REFUSES. curia never drops a message, and the refusal names the
  // second send rather than only naming the number: an agent that hears the
  // number alone spends its attempts squeezing.
  if (messages.length > cap) {
    faults.push(`messages: ${messages.length} messages over the ${cap} cap. Curia refuses the send, it never drops a message. Send the rest as a second call.`)
  }

  const rail = messages.length > 1
  for (const [i, m] of messages.entries()) {
    const prefix = `messages[${i}].`
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      faults.push(`${prefix}: not a message. Each entry is an object with a \`format\` and its fields.`)
      continue
    }
    // The rail is what gives a grouped block its seams back, so a send of
    // several needs a label on every one of them. A send of ONE carries no
    // rail, because there is nothing to count, so its label is optional.
    if (rail && !present(m.label)) {
      faults.push(`${prefix}label: missing. Every message of a send of ${messages.length} carries one, at most ${CAPS.label} characters, plain and descriptive: "answer", not "the answer".`)
    }
    faults.push(...messageFloor(m, i, prefix))
  }

  // At most one decision, and it posts LAST. One answer surface, unique
  // markers, one receipt.
  const deciding = messages.map((m, i) => (isDeciding(m) ? i : -1)).filter((i) => i >= 0)
  if (deciding.length > 1) {
    faults.push(`messages: ${deciding.length} deciding messages at ${deciding.map((i) => i + 1).join(' and ')}. A send decides at most once. Curia refuses the send, it never drops a message.`)
  } else if (deciding.length === 1 && deciding[0] !== messages.length - 1) {
    faults.push(`messages: the deciding message is ${deciding[0] + 1} of ${messages.length}. It posts last, so the buttons sit at the thread bottom. Reorder the array and send the same messages again.`)
  }
  return faults
}

// Which message of a send may decide, per TOOL. This is the one rule the array
// cannot hold on its own, because it is about the CALL rather than about the
// messages: `ask_human` needs one decision and blocks on it, `notify` asks
// nothing at all, and `request_review` decides through the gate card curia
// composes from its own records, so a decision inside its send would be a
// second answer surface for one press.
//
// It reads as a schema fault on every tool, because a send on the wrong tool is
// a misplaced field rather than badly chosen words.
export function sendDecisionFaults(tool, messages) {
  if (tool === 'ask_human') {
    const last = Array.isArray(messages) ? messages.at(-1) : null
    return isDeciding(last)
      ? []
      : ['messages: `ask_human` needs one deciding message last. Use `notify` when no answer blocks the work.']
  }
  const decides = decidingIndex(Array.isArray(messages) ? messages : [])
  if (decides < 0) return []
  const format = messages[decides].format
  if (tool === 'notify') {
    return [`messages: \`notify\` decides nothing, and message ${decides + 1} is a ${format}. Use \`ask_human\` when an answer blocks the work.`]
  }
  return [`messages: the review gate is this call's decision, and message ${decides + 1} is a ${format}. Curia composes the gate card itself and posts it last, under your send. Put your reply to the rejection in a \`prose\` message.`]
}

// ---- the words ----------------------------------------------------------------

// A prose message opens with one bold line, and the body comes after it.
export const leadsWithConclusion = (prose) => /^\*\*[^*\n]+\*\*/.test(String(prose ?? '').trim())

function messageLint(m, prefix) {
  const faults = []
  if (present(m?.label)) faults.push(...gradeA(`${prefix}label`, m.label, CAPS.label))
  // The prose message. Past the cap the agent composes a SECOND prose message,
  // and the refusal names that path rather than only the number: an agent that
  // hears the number alone spends its attempts squeezing.
  if (present(m?.prose)) {
    faults.push(...gradeB(`${prefix}prose`, m.prose, CAPS.prose).map((f) => (
      f.includes(`over the ${CAPS.prose} cap`) ? `${f} Compose a second prose message, and break where the meaning breaks.` : f
    )))
    // The conclusion leads, in bold (#640). It is the shape the ending report
    // and the verdict already take, and it survives being read halfway, which
    // is what a phone does to a long block.
    if (!leadsWithConclusion(m.prose)) {
      faults.push(`${prefix}prose: lead with the conclusion, in bold, on the first line: **The cap holds.** The body follows it.`)
    }
  }
  if (present(m?.caption)) faults.push(...gradeA(`${prefix}caption`, m.caption, CAPS.caption))
  if (present(m?.detail)) faults.push(...gradeA(`${prefix}detail`, m.detail, CAPS.detail))
  faults.push(...lintVisualFields(m ?? {}, prefix))
  if (KIND_OF[m?.format]) {
    // A deciding message is the card ADR-0019 already types, so it takes the
    // word lint that already ships. `lintAskHuman` reads the visual fields and
    // the detail too, so those are dropped from the payload it sees rather than
    // named twice.
    const { picture, table, diagram, detail, ...card } = m
    faults.push(...lintAskHuman(KIND_OF[m.format], card).map((f) => `${prefix}${f}`))
  }
  return faults
}

export function lintSend(messages) {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((m, i) => messageLint(m, `messages[${i}].`))
}

// Whether a send carries prose a human could read at all. It is what separates
// a schema fault curia can still send from one it cannot, on the composite
// surface: a headline with no options still asks something, and an array of
// empty objects asks nothing.
export function sendHasText(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((m) => present(m?.prose) || present(m?.headline) || present(m?.caption)
    || present(m?.detail) || present(m?.label) || hasVisualField(m ?? {})
    || (m?.questions ?? []).some((q) => present(q?.text))
    || (m?.options ?? []).some((o) => present(typeof o === 'object' ? o?.label : o))
    || (m?.attachments ?? []).length > 0)
}

// The one line the thread reads as the send's title, for the records that need
// one string: the journal, the supersession hash and the recorded-answer match
// all key on a prompt. The deciding message's headline is it when the send
// decides, and the first prose message otherwise.
export function sendPrompt(messages) {
  if (!Array.isArray(messages)) return null
  const i = decidingIndex(messages)
  const decided = i >= 0 ? messages[i]?.headline : null
  if (present(decided)) return String(decided).trim()
  const prose = messages.find((m) => present(m?.prose))
  if (prose) return String(prose.prose).trim()
  const labelled = messages.find((m) => present(m?.label))
  return labelled ? String(labelled.label).trim() : null
}

// ---- the shape a tool declares ------------------------------------------------
//
// Every field is OPTIONAL to zod, which is the rule ADR-0005 sets for every
// linted surface: a zod failure is JSON-RPC -32602, #416 measured that carriage
// dying in silence on codex, and a schema rejection must never trap a question.
// So the floor above is what refuses a send, and it refuses it in words the
// agent can read and act on.
//
// The two RETIRED fields are declared for the same reason they are on the
// single-message surfaces: zod strips a key it does not declare, and a stripped
// `visual` would take the agent's rows with it.
export const messageSchema = z.object({
  format: z.enum(MESSAGE_FORMATS).optional().describe(`What this message IS: ${MESSAGE_FORMATS.join(', ')}. At most one deciding message per send (${DECIDING_FORMATS.join(', ')}), and it goes last.`),
  label: z.string().optional().describe(`What this message is, for the rail curia writes above it. At most ${CAPS.label} characters, plain and descriptive, with no article: "answer", not "the answer". A send of one message needs none.`),
  attachments: z.array(z.string()).optional().describe('Files for the human to DOWNLOAD, riding the message they belong to.'),
  prose: z.string().optional().describe(`prose only: the answer, or the intent of the send. Block prose, at most ${CAPS.prose} characters. Past that, write a SECOND prose message and break where the meaning breaks.`),
  caption: z.string().optional().describe('files only: the one line that says what the files are.'),
  headline: z.string().optional().describe('The whole decision in one line. One line, no markdown, no link, 150 characters.'),
  questions: z.array(z.object({
    text: z.string().optional().describe('One question of the round. One line, 250 characters.'),
    recommendation: z.string().optional().describe('Your recommended answer to THIS question. One line, 300 characters.'),
    background: z.string().optional().describe(`What this question rests on, in small print under its line. Block prose, ${CAPS.background} characters.`),
  })).optional().describe('round only: one entry per question. Curia numbers them.'),
  options: z.array(z.object({
    label: z.string().optional().describe('The choice, by its name. One line, 80 characters.'),
    handle: z.string().optional().describe('Short button text. One line, 20 characters. The card body keeps the full label and consequence.'),
    consequence: z.string().optional().describe('What picking this option costs. One line, 300 characters.'),
    example: z.string().optional().describe('One concrete case for this option. Block prose, 300 characters.'),
    recommended: z.boolean().optional(),
  })).optional(),
  detail: z.string().optional().describe('Short FACTS, rendered as a spoiler. One line, 500 characters.'),
  picture: z.string().optional().describe('One image the human LOOKS AT in place: a screenshot, a render, a mock.'),
  table: z.string().optional().describe('A table, as rows. Curia writes the fence. At most 42 columns by 20 lines, and the columns must line up.'),
  diagram: z.string().optional().describe('An ASCII drawing, as rows. Curia writes the fence. At most 42 columns by 20 lines.'),
  timeline: z.boolean().optional().describe('Point the operator at the timeline for the reasoning. Curia composes the link.'),
  preview_url: z.string().optional(),
  visual: z.string().optional().describe('RETIRED. Send `table`, `diagram`, or `picture`. Curia refuses a send that carries this.'),
  images: z.array(z.string()).optional().describe('RETIRED. Send the same paths under `attachments`. Curia refuses a send that carries this.'),
})

// The one rule the tool description carries, and no shape catalog under it. A
// catalog is a second type system over a typed payload, and the first send that
// needs a shape outside it is refused for being unusual rather than wrong.
export const SEND_HINT = 'A message exists when a reader would want to skip it on its own.'
  + ' Anything a reader always reads together stays one message.'
  + ` At most ${MESSAGES_PER_SEND} messages, at most one of them decides, and the deciding one goes last so the buttons sit at the thread bottom.`

export const sendSchema = z.array(messageSchema).optional()
  .describe(`The send, in the order the human reads it. ${SEND_HINT}`)

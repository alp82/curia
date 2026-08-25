// The typed-payload lint (#418), against the contract ADR-0019 locks.
//
// Agent prose reaches the operator on five surfaces. Every one of them took a
// free string until this module. A free string carries no floor, so a card can
// drop the cost of an option and still send, and it carries no names, so the
// daemon cannot point at the part that failed.
//
// One vocabulary of seven names, and every surface takes a subset:
//
//   headline     the whole decision in one line          grade A
//   question     one question of a round                 grade A
//   option       one choice, by its label                grade A
//   consequence  what one option costs                   grade A
//   example      one concrete case for an option         grade B
//   picture      an image the reader looks at in place    image path
//   table        a code-block table                      geometry
//   diagram      an ASCII drawing                        geometry
//   detail       short facts, rendered as a spoiler      grade A
//   prose        the answer, or the intent of a send     grade B, 1600
//   background   what one question rests on              grade B, 600
//   label        one message of a send, by its rail      grade A, 20
//
// ADR-0026 (#640) split the retired `visual` FIELD into `picture`, `table` and
// `diagram`, and renamed `images` to `attachments`. `visual` survives as the
// name of a message FORMAT and as nothing else.
//
// `daemon/assets/voice.md` stays the one authority on words. The GRADE decides
// which of its rules a field is held to. Grade A is inline decision text, so it
// is capped and structureless. Grade B is block prose, so it keeps its
// sentences and loses its decoration. A `visual` is not prose, so no grade
// reads it: curia checks its width, its height and its fence.
//
// THE LINT CHECKS DETERMINISTIC RULES ONLY. Passive voice, nominalizations and
// "-ing" main verbs stay in `voice.md` as author guidance. A rule a machine
// must guess at produces a false rejection, and a false rejection costs the
// agent one attempt out of the three ADR-0005 gives it.
//
// A cap REFUSES, it never truncates. Truncation loses information in silence,
// and losing no information is the requirement the whole #413 map serves.

import { fenceParts, lintReply } from './messaging.mjs'
import { IMAGE_EXTENSIONS } from './attachments.mjs'

// The caps ADR-0019 sets. A cap is a ceiling, not a target: a card that says
// the whole decision in 40 characters is a better card, and no rule here
// pushes an agent toward the limit.
export const CAPS = {
  headline: 150,
  question: 250,
  option: 80,
  consequence: 300,
  example: 300,
  detail: 500,
  // `summary`, `charting`, the notify `message` and a verdict finding all share
  // one block cap.
  block: 600,
  // The question background of ADR-0026. It shares the block cap's number and
  // keeps its own name, because the two move apart the moment either does.
  background: 600,
  // The prose message of ADR-0026, which is `CHUNK_LIMIT` minus the rail line
  // curia writes above it. One number for the lint and the splitter, so no
  // prose entry is ever cut behind the agent's back.
  prose: 1600,
  // The rail label of one message of a send. It is the status-line label rule
  // of ADR-0021 read on a second surface, so it takes the same 20.
  label: 20,
  phaseLabel: 20,
  // The one caption line of a `files` message.
  caption: 150,
}

export const WORK_PHASES = ['explore', 'think', 'build', 'test', 'fix', 'ship']

// The geometry of a `table` and a `diagram` (#414 measured both numbers on a
// phone). 42 by 20 is under 900 characters, so either one sits under
// CODE_BLOCK_LIMIT and never reaches the chunk limit either.
export const VISUAL_COLUMNS = 42
export const VISUAL_LINES = 20

// ---- the word rules both grades share ---------------------------------------

// THERE IS NO CONTRACTION RULE, and its absence is the decision. #133's voice
// was Simplified Technical English, which bans contractions, and this lint
// refused them for that reason. The voice is now the Google developer
// documentation style, which REQUIRES them for a natural register. A rule that
// refuses what voice.md asks for would reject nearly every call an agent makes.
// So the check is gone rather than inverted: "expand it" and "contract it" are
// both the lint telling an author how to write, and only the first was ever a
// rule a machine could decide without guessing.

// voice.md's list, whole. Nothing is added here: the authority is that file.
const MARKETING_RE = /\b(?:seamless(?:ly)?|robust|powerful|cutting-edge|effortless(?:ly)?|world-class|next-generation|revolutionary)\b/gi

// U+2014 em dash and U+2015 horizontal bar. A normal hyphen is allowed, because
// voice.md offers it as the replacement.
const EM_DASH_RE = /[—―]/

function wordFaults(field, text) {
  const faults = []
  if (text.includes(';')) faults.push(`${field}: a semicolon. Write two sentences.`)
  if (EM_DASH_RE.test(text)) faults.push(`${field}: an em-dash. Write two sentences, or use a normal dash.`)
  for (const m of text.match(MARKETING_RE) ?? []) faults.push(`${field}: the marketing adjective "${m}".`)
  return faults
}

// ---- grade A: inline decision text -------------------------------------------
//
// The text the operator reads BEFORE deciding. It is one line, it carries no
// structure, and it carries no link, because curia composes every link it
// renders (ADR-0013).

const HEADING_RE = /^\s{0,3}#{1,6}\s/
const TABLE_RE = /^\s*\|.*\|/
const QUOTE_RE = /^\s*>/
const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})/
const LIST_RE = /^\s*(?:[-*+]\s|\d+[.)]\s)/
const LINK_RE = /https?:\/\/|\bwww\.\S|\[[^\]]*\]\([^)]*\)/i

export function gradeA(field, value, cap) {
  const text = String(value ?? '')
  const faults = []
  if (text.length > cap) faults.push(`${field}: ${text.length} characters over the ${cap} cap. Shorten it. Curia refuses it, it never cuts it.`)
  if (/\n/.test(text)) faults.push(`${field}: a newline. This field is one line.`)
  if (HEADING_RE.test(text)) faults.push(`${field}: a heading marker.`)
  if (TABLE_RE.test(text)) faults.push(`${field}: a markdown table row. Discord does not render one.`)
  if (QUOTE_RE.test(text)) faults.push(`${field}: a blockquote marker.`)
  if (FENCE_RE.test(text)) faults.push(`${field}: a code fence. Put a table in \`table\` and a diagram in \`diagram\`.`)
  if (LIST_RE.test(text)) faults.push(`${field}: a list marker.`)
  if (LINK_RE.test(text)) faults.push(`${field}: a link. Curia composes every link it shows, so drop it.`)
  return [...faults, ...wordFaults(field, text)]
}

// ---- grade B: block prose ----------------------------------------------------
//
// This text explains, so it keeps its sentences. Rules 2 and 5 already ship as
// `lintReply()`: no heading, no table row, no blockquote, no emoji outside the
// signal set, no code block over the cap. That function reads PROSE only
// (#432), so a table inside a fence passes, and the code-block table is the one
// table form Discord renders.

export const SENTENCE_WORDS = 25

// A sentence ends at a period, a question mark or an exclamation mark followed
// by whitespace or the end of the text.
const sentences = (text) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length

export function gradeB(field, value, cap = CAPS.block) {
  const text = String(value ?? '')
  const faults = []
  if (text.length > cap) faults.push(`${field}: ${text.length} characters over the ${cap} cap. Shorten it. Curia refuses it, it never cuts it.`)
  for (const problem of lintReply(text)) faults.push(`${field}: ${problem}`)
  // The sentence rule reads prose only. A fenced block is not a sentence, and
  // counting its words would refuse a table for being a table.
  for (const part of fenceParts(text)) {
    if (part.code) continue
    for (const s of sentences(part.text)) {
      const n = wordCount(s)
      if (n > SENTENCE_WORDS) faults.push(`${field}: a sentence of ${n} words over the ${SENTENCE_WORDS} cap: "${s.slice(0, 60)}…". Split it.`)
    }
  }
  return [...faults, ...wordFaults(field, text)]
}

// ---- the geometry fields: never words ----------------------------------------
//
// The agent writes the rows. Curia writes the fence, so a table or a diagram can never
// arrive with a broken one — and an agent that fenced it anyway loses the
// fence here rather than a rejection, because the fence is curia's to place.

export function unfence(value) {
  const text = String(value ?? '').replace(/\n+$/, '')
  const parts = fenceParts(text)
  if (parts.length !== 1 || !parts[0].code) return text
  const lines = text.split('\n')
  return lines.slice(1, parts[0].close ? -1 : undefined).join('\n')
}

export function lintGeometry(field, value) {
  const body = unfence(value)
  const faults = []
  const lines = body.split('\n')
  if (lines.length > VISUAL_LINES) faults.push(`${field}: ${lines.length} lines over the ${VISUAL_LINES} cap. A phone scrolls past a taller one.`)
  const widest = lines.reduce((w, l) => Math.max(w, l.length), 0)
  if (widest > VISUAL_COLUMNS) faults.push(`${field}: ${widest} columns over the ${VISUAL_COLUMNS} cap. A phone wraps a wider one and the columns lose their alignment.`)
  // A fence marker INSIDE the rows would close the fence curia puts around
  // them, and the rest of the block would render as prose.
  if (lines.some((l) => FENCE_RE.test(l))) faults.push(`${field}: a code fence inside the rows. Curia fences the block itself, so write the rows alone.`)
  return faults
}

// ---- the table: geometry, and the columns line up ----------------------------
//
// This check is WHY ADR-0026 split `table` from `diagram`. One combined field
// could never run it, because a diagram has no columns to align. A table whose
// columns drift is unreadable on a phone, and the drift is deterministic, so
// the lint reads it rather than leaving it to the operator's eye.
//
// A cell boundary is a run of two spaces or more, which is the shape every
// table an agent writes into a code block already takes. A line that yields one
// cell is a title or a rule, and it is skipped. A row may carry FEWER cells
// than the header, because a blank cell is a real row, but each cell it does
// carry must start at one of the header's offsets.
function cells(line) {
  const found = []
  const re = /\S(?:.*?\S)?(?=\s{2,}|$)/g
  for (const m of line.matchAll(re)) found.push({ at: m.index, text: m[0] })
  return found
}

export function lintTable(value) {
  const faults = lintGeometry('table', value)
  const rows = unfence(value).split('\n').map((l) => ({ line: l, cells: cells(l) })).filter((r) => r.cells.length > 1)
  if (rows.length < 2) return faults
  const offsets = new Set(rows[0].cells.map((c) => c.at))
  for (const [i, row] of rows.entries()) {
    if (i === 0) continue
    if (row.cells.length > rows[0].cells.length) {
      faults.push(`table: row ${i + 1} has ${row.cells.length} columns where the first row has ${rows[0].cells.length}. Line the columns up with spaces.`)
      continue
    }
    const stray = row.cells.find((c) => !offsets.has(c.at))
    if (stray) faults.push(`table: row ${i + 1} starts a column at character ${stray.at + 1}, which no column of the first row starts at. Line the columns up with spaces.`)
  }
  return faults
}

// ---- the picture: one image file ---------------------------------------------
//
// `picture` is what a reader LOOKS AT and `attachments` is what a reader
// downloads (ADR-0026). So this field takes one image path and nothing else: a
// diff or a note under it would be a download the card claims to render.
// Containment and size stay `attachments.mjs`'s, which is the layer that
// touches the disk. This is the payload contract, and it reads the name.
export function lintPicture(field, value) {
  const text = String(value ?? '').trim()
  const faults = []
  if (/\n/.test(text)) {
    faults.push(`${field}: a newline. This field is one file path, and a second picture is a second message.`)
    return faults
  }
  if (!IMAGE_EXTENSIONS.some((ext) => text.toLowerCase().endsWith(ext))) {
    faults.push(`${field}: "${text}" is not an image. A picture is one of ${IMAGE_EXTENSIONS.join(', ')}. Put a table in \`table\`, a diagram in \`diagram\`, and any other file in \`attachments\`.`)
  }
  return faults
}

// ---- the three visual fields, together ---------------------------------------

// The fields ADR-0026 (#640) split the retired `visual` field into. Every
// surface that carried a `visual` carries these three instead.
export const VISUAL_FIELDS = ['picture', 'table', 'diagram']

export function lintVisualFields(payload = {}, prefix = '') {
  const faults = []
  if (present(payload.picture)) faults.push(...lintPicture(`${prefix}picture`, payload.picture))
  if (present(payload.table)) faults.push(...lintTable(payload.table))
  if (present(payload.diagram)) faults.push(...lintGeometry(`${prefix}diagram`, payload.diagram))
  return faults
}

export const hasVisualField = (payload = {}) => VISUAL_FIELDS.some((f) => present(payload[f]))

// ---- the fields ADR-0026 retired ---------------------------------------------
//
// Named rather than dropped, which is the rule the flip (#422) set for `prompt`
// and `recommended`. A field curia ignored in silence would take the rows or the
// paths the agent wrote with it, and losing information in silence is the one
// thing this map forbids.
const RETIRED_FIELDS = {
  visual: 'visual: retired by ADR-0026. Send the rows as `table` when they are a table, or as `diagram` when they are a drawing. An image goes in `picture`.',
  images: 'images: renamed to `attachments` by ADR-0026, because it has taken a .patch, a .diff, a .md, a .txt and a .log since it shipped. Send the same paths under `attachments`.',
}

export function retiredFieldFaults(payload = {}, prefix = '') {
  return Object.entries(RETIRED_FIELDS)
    .filter(([name]) => payload[name] !== undefined && payload[name] !== null)
    .map(([, text]) => `${prefix}${text}`)
}

// ---- the shape per surface ---------------------------------------------------
//
// Every `ask_human` kind takes `headline` (required), and `detail`, `picture`,
// `table`, `diagram`, `timeline` and `attachments` (optional). The rest is per
// kind, and the table is ADR-0019's, as ADR-0026 amended it.

const present = (v) => v !== undefined && v !== null && String(v).trim() !== ''

// THE FLIP (#422) HAS LANDED. Every floor below is unconditional now: a call
// that omits a required field is rejected on every shipped surface. The switch
// that held them off is gone rather than set to true, because it had no second
// position left. A rollback is a revert and a deploy, which is what flipping the
// switch back would have cost anyway.
//
// The untyped shape survives in ONE place, and that place is not an accepted
// call. A flagged send (ADR-0005) puts the text of a refused call in front of
// the operator at the cap, and `prompt` is text the call carried. So `isTyped`
// and the `prompt` fallback stay, on the flagged path rather than the open one.

// Whether a call carries any typed field at all. It picks the SHAPE a flagged
// send renders: a typed payload composes a card, and an untyped one carries the
// prompt it wrote. `attachments` is not prose and does not type a call by itself.
export function isTyped(payload = {}) {
  return present(payload.headline)
    || (payload.questions ?? []).length > 0
    || (payload.options ?? []).some((o) => o && typeof o === 'object')
    || present(payload.detail) || hasVisualField(payload)
}

// The three fields the untyped call carried, retired by the flip (#422).
//
// curia NAMES them rather than dropping them. A field it ignored in silence
// would take the words the agent wrote with it, and losing information in
// silence is the one thing this map forbids. So each one is refused with the
// place its content goes, and the agent moves the text in one attempt (#416).
function retiredFaults(payload = {}) {
  const faults = retiredFieldFaults(payload)
  if (present(payload.prompt)) {
    faults.push('prompt: retired by the flip. Write the headline and the parts, and curia lays the card out.')
  }
  if ((payload.options ?? []).some((o) => o === null || typeof o !== 'object')) {
    faults.push('options: a bare string. An option is an object with a label and the consequence of picking it.')
  }
  if (payload.recommended !== undefined) {
    faults.push('recommended: retired by the flip. Curia derives the button from questions[], so recommend each question of the round.')
  }
  return faults
}

// The mandatory floor, checked apart from the words. A missing field is a
// SCHEMA fault and takes the schema path of ADR-0005, where a lint fault takes
// the lint path. The two are counted together and the difference is what the
// agent is told.
export function floorFaults(kind, payload = {}) {
  const faults = retiredFaults(payload)
  if (!present(payload.headline)) faults.push('headline: missing. Every card needs the whole decision in one line.')
  if (kind === 'free-text') {
    const qs = payload.questions ?? []
    if (!qs.length) faults.push('questions: missing. A round is an array of questions, one entry each.')
    qs.forEach((q, i) => { if (!present(q?.text)) faults.push(`questions[${i}].text: missing.`) })
  }
  if (kind === 'choice') {
    const opts = payload.options ?? []
    if (opts.length < 2) faults.push('options: a choice needs two options or more, each with its consequence.')
    opts.forEach((o, i) => {
      // A bare string is named once, by `retiredFaults`. Naming it again per
      // field would spend the agent's reading on the same fault three times.
      if (o === null || typeof o !== 'object') return
      if (!present(o?.label)) faults.push(`options[${i}].label: missing.`)
      if (!present(o?.consequence)) faults.push(`options[${i}].consequence: missing. An option with no cost stated is the fault this floor exists to stop.`)
    })
  }
  if (kind === 'approve-reject' || kind === 'preview-review') {
    const opts = payload.options ?? []
    if (opts.length && opts.length !== 2) faults.push(`options: ${opts.length} given. Approve and reject are exactly two, and curia keeps its own button words.`)
    opts.forEach((o, i) => {
      if (o === null || typeof o !== 'object') return
      if (!present(o?.consequence)) faults.push(`options[${i}].consequence: missing.`)
    })
  }
  if (kind === 'preview-review' && !present(payload.preview_url)) {
    faults.push('preview_url: missing. A preview review points at the page to look at.')
  }
  return faults
}

// The words, field by field. The floor is checked separately, so this reads
// only what the call actually carries.
export function lintAskHuman(kind, payload = {}) {
  const faults = []
  if (present(payload.headline)) faults.push(...gradeA('headline', payload.headline, CAPS.headline))
  if (present(payload.detail)) faults.push(...gradeA('detail', payload.detail, CAPS.detail))
  faults.push(...lintVisualFields(payload))
  ;(payload.questions ?? []).forEach((q, i) => {
    if (present(q?.text)) faults.push(...gradeA(`questions[${i}].text`, q.text, CAPS.question))
    if (present(q?.recommendation)) faults.push(...gradeA(`questions[${i}].recommendation`, q.recommendation, CAPS.consequence))
    // ADR-0026: what the question rests on, in small print under its line. It
    // is block prose, so it keeps its sentences, and it is the one named
    // exception to ADR-0019's never-stacked small-print rule.
    if (present(q?.background)) faults.push(...gradeB(`questions[${i}].background`, q.background, CAPS.background))
  })
  ;(payload.options ?? []).forEach((o, i) => {
    if (typeof o !== 'object' || o === null) return
    if (present(o.label)) faults.push(...gradeA(`options[${i}].label`, o.label, CAPS.option))
    if (present(o.consequence)) faults.push(...gradeA(`options[${i}].consequence`, o.consequence, CAPS.consequence))
    if (present(o.example)) faults.push(...gradeB(`options[${i}].example`, o.example, CAPS.example))
  })
  return faults
}

// The review gate (#417 put it on this ticket). Its `summary` and `charting`
// are the block prose the operator reads on every ticket.
export function lintRequestReview(payload = {}) {
  const faults = []
  if (present(payload.headline)) faults.push(...gradeA('headline', payload.headline, CAPS.headline))
  if (present(payload.detail)) faults.push(...gradeA('detail', payload.detail, CAPS.detail))
  faults.push(...lintVisualFields(payload))
  if (present(payload.summary)) faults.push(...gradeB('summary', payload.summary))
  if (present(payload.charting)) faults.push(...gradeB('charting', payload.charting))
  return faults
}

// Whether a call carries prose a human could read at all. It is what separates
// a schema fault curia can still send from one it cannot: a headline with no
// options still asks something, and an empty call asks nothing.
export function hasText(payload = {}) {
  return present(payload.headline) || present(payload.prompt) || present(payload.summary)
    || (payload.questions ?? []).some((q) => present(q?.text))
    || (payload.options ?? []).some((o) => present(typeof o === 'object' ? o?.label : o))
}

// ---- the ending report (#419) -------------------------------------------------
//
// `report_result` takes `ticket` and `status` for the machine, and `headline`
// plus `summary` for the human. The two machine fields keep their zod types,
// because they are not prose and the ending checklist already holds an agent
// that never reported.
//
// `details` is a free record and no lint reads it (ADR-0019 rule 3). It is
// machine-facing and no surface renders it.

// Whether a report carries a typed field at all. It tells curia which SHAPE to
// render, never whether to lint: `summary` shipped before #419 and it is linted
// either way. After the flip (#422) a report that reaches the thread without a
// headline is a flagged send, and this is what keeps its one line intact.
export function isTypedResult(payload = {}) {
  return present(payload.headline) || present(payload.detail) || hasVisualField(payload)
}

// The report's floor. `summary` was required by the schema before #419, and the
// flip (#422) added the `headline` beside it. Both are unconditional now.
export function resultFloorFaults(payload = {}) {
  const faults = retiredFieldFaults(payload)
  if (!present(payload.headline)) faults.push('headline: missing. Say what the work came to in one line.')
  if (!present(payload.summary)) faults.push('summary: missing. Say what you did and what it came to.')
  // `findings` belongs to the cross-check verdict and to nothing else (#421). A
  // builder that sent them would lose them in silence: no lint reads them here
  // and no surface renders them, and losing information in silence is the one
  // thing this map forbids. So the call is refused and the field is named.
  if (Array.isArray(payload.findings)) {
    faults.push('findings: the cross-check reviewer\'s field, not a builder\'s. Put what you found in the summary.')
  }
  return faults
}

export function lintResult(payload = {}) {
  const faults = []
  if (present(payload.headline)) faults.push(...gradeA('headline', payload.headline, CAPS.headline))
  if (present(payload.detail)) faults.push(...gradeA('detail', payload.detail, CAPS.detail))
  faults.push(...lintVisualFields(payload))
  if (present(payload.summary)) faults.push(...gradeB('summary', payload.summary))
  return faults
}

// ---- the status line (#420) ---------------------------------------------------
//
// `notify` asks nothing and blocks nobody, and it is still prose that reaches a
// human. ADR-0019 gives it the same vocabulary as the surfaces that do ask:
// `message` is the Grade B prose the thread reads, `detail` is the Grade A
// spoiler, and `table` and `diagram` keep their geometry check.

// A status line needs no `isTyped` twin of its own. The report has one because
// its untyped shape is a DIFFERENT post (#419), and a notify's is not: the
// message is the line either way, and a detail or a table only adds to it.

// The status line's floor, and the one surface the flip (#422) left as it was.
// `message` was required by the schema before #420, so it was required before
// the flip and it is required after it (#438: moving a check off zod decides
// which layer refuses the call, never whether a silent send lands).
export function notifyFloorFaults(payload = {}) {
  const faults = retiredFieldFaults(payload)
  const opening = payload.opening
  const hasOpening = opening !== undefined && opening !== null
  const hasPhase = present(payload.phase)
  const hasLabel = present(payload.label)
  if (!present(payload.message) && !hasOpening && !hasPhase && !hasLabel) {
    faults.push('message: missing. Send a milestone message, an opening, or a phase update.')
  }
  if (hasOpening) {
    if (!present(opening?.goal)) faults.push('opening.goal: missing. State the goal as you read it.')
    if (!present(opening?.first_step)) faults.push('opening.first_step: missing. State your first step.')
  }
  if (hasPhase && !hasLabel) faults.push('label: missing. A phase update needs a short label.')
  if (hasLabel && !hasPhase) faults.push('phase: missing. A status label needs its phase.')
  return faults
}

// Whether a status line carries anything a human could read. It is what tells a
// schema fault curia can still send from one it cannot (ADR-0019), on the
// surface where a `message` is the field that goes missing. A table or a
// spoiler alone still says something, and an empty call says nothing.
export function notifyHasText(payload = {}) {
  return present(payload.message) || present(payload.detail) || hasVisualField(payload)
    || present(payload.opening?.goal) || present(payload.opening?.first_step) || present(payload.label)
}

export function lintNotify(payload = {}) {
  const faults = []
  if (present(payload.message)) faults.push(...gradeB('message', payload.message))
  if (present(payload.detail)) faults.push(...gradeA('detail', payload.detail, CAPS.detail))
  faults.push(...lintVisualFields(payload))
  if (present(payload.opening?.goal)) faults.push(...gradeA('opening.goal', payload.opening.goal, CAPS.question))
  if (present(payload.opening?.first_step)) faults.push(...gradeA('opening.first_step', payload.opening.first_step, CAPS.question))
  if (present(payload.phase) && !WORK_PHASES.includes(payload.phase)) {
    faults.push(`phase: "${payload.phase}" is not one of ${WORK_PHASES.join(', ')}.`)
  }
  if (present(payload.label)) faults.push(...gradeA('label', payload.label, CAPS.phaseLabel))
  return faults
}

// ---- the cross-check verdict (#421) -------------------------------------------
//
// The reviewer's `report_result` is the VERDICT, which ADR-0019 lists as a
// surface of its own. It was the last untyped surface on the #413 map, and it
// was exempt from the report lint while it stayed one (#419).
//
// It differs from every other surface in one way: it carries a LIST of findings
// rather than one block of prose. So `findings[]` is the shape, one entry per
// finding, and the prose of each entry is Grade B like any other block.

// The severity of one finding. Three values, most serious first, and the order
// of this array is what `verdictGrade` reads.
export const VERDICT_SEVERITIES = ['blocker', 'concern', 'note']

// The grade of the whole verdict, DERIVED from the severities the reviewer set.
// It is never a field of its own, for the reason ADR-0019 retired the
// `recommended` boolean: a claim the payload can contradict is a claim that can
// lie. A typed verdict cannot say `pass` over a finding it called a blocker.
//
// An untyped verdict has no findings, so it has no grade, and curia states none.
export function verdictGrade(findings) {
  if (!Array.isArray(findings)) return null
  const sev = (f) => String(f?.severity ?? '').trim().toLowerCase()
  if (findings.some((f) => sev(f) === 'blocker')) return 'fail'
  if (findings.some((f) => sev(f) === 'concern')) return 'concerns'
  return 'pass'
}

// Whether a verdict carries a typed field at all. Since the flip (#422) an
// untyped verdict is refused, so this picks the shape of a flagged send: the
// summary, whole, with no grade line over it that no severity backs.
export function isTypedVerdict(payload = {}) {
  return present(payload.headline) || Array.isArray(payload.findings)
    || present(payload.detail) || hasVisualField(payload)
}

// The verdict's floor. `summary` was required by the report schema before #421,
// and the flip (#422) added the `headline` and the `findings` beside it. All
// three are unconditional now.
//
// AN EMPTY FINDINGS LIST IS A VERDICT. A clean reading is a real result, and a
// floor of one finding would make a reviewer that found nothing write filler —
// the fault ADR-0019 named when it left `example` to agent judgment. The field
// is still required after the flip, because an empty list says "I found
// nothing" and a missing one says nothing at all.
export function verdictFloorFaults(payload = {}) {
  const faults = retiredFieldFaults(payload)
  if (!present(payload.headline)) faults.push('headline: missing. Say the verdict in one line.')
  if (!present(payload.summary)) faults.push('summary: missing. Say what you read and what you ran.')
  if (!Array.isArray(payload.findings)) {
    faults.push('findings: missing. Send one entry per finding, or an empty list when the reading is clean.')
  }
  ;(payload.findings ?? []).forEach((f, i) => {
    if (!present(f?.text)) faults.push(`findings[${i}].text: missing. Name the file and the line, say what is wrong, say why it matters.`)
    const severity = String(f?.severity ?? '').trim().toLowerCase()
    if (!severity) faults.push(`findings[${i}].severity: missing. One of ${VERDICT_SEVERITIES.join(', ')}. Curia reads the grade of the whole verdict off these.`)
    else if (!VERDICT_SEVERITIES.includes(severity)) faults.push(`findings[${i}].severity: "${f.severity}" is not one of ${VERDICT_SEVERITIES.join(', ')}.`)
  })
  return faults
}

export function lintVerdict(payload = {}) {
  const faults = []
  if (present(payload.headline)) faults.push(...gradeA('headline', payload.headline, CAPS.headline))
  if (present(payload.detail)) faults.push(...gradeA('detail', payload.detail, CAPS.detail))
  faults.push(...lintVisualFields(payload))
  if (present(payload.summary)) faults.push(...gradeB('summary', payload.summary))
  ;(payload.findings ?? []).forEach((f, i) => {
    if (present(f?.text)) faults.push(...gradeB(`findings[${i}].text`, f.text))
  })
  return faults
}

// The gate's floor.
//
// `summary` and `charting` were REQUIRED by the schema before #418. Making them
// optional to zod is about which layer refuses the call (#438: a zod refusal
// dies in silence on codex), never about letting a silent gate open. The flip
// (#422) added the `headline` beside them, and all three are unconditional now.
export function reviewFloorFaults(payload = {}) {
  const faults = retiredFieldFaults(payload)
  if (!present(payload.headline)) faults.push('headline: missing. Say the whole change in one line.')
  if (!present(payload.summary)) faults.push('summary: missing. Say what you did.')
  if (!present(payload.charting)) faults.push('charting: missing. Write "none" when there is nothing to chart.')
  return faults
}

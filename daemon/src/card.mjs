// The card composer (#418), the shape #415 picked as card 4 and ADR-0019 locks.
//
// ONE function builds the body of a typed card, and both readers call it. The
// daemon calls it when the escalation opens, and stores the result as the
// record's `prompt` — which is what the timeline, the console, the inherited
// exchange (#374), the supersession hash and the recorded-answer match (#369)
// all read. The bridge calls it to render the Discord message.
//
// One function rather than two renderings, for one reason: a record whose
// stored prompt differs from what Discord showed is not evidence of anything.
// It also keeps ADR-0002 whole. The daemon lints and structures, the bridge
// renders, and neither one interprets.
//
// What is NOT in here: every link. curia composes the preview, timeline and
// terminal links as buttons on the card (ADR-0013), so the `timeline` flag adds
// a pointer line and never a URL. The buttons, the select menu and the answer
// instructions stay in the bridge, because they are the answer surface rather
// than the question.

import { unfence } from './lint.mjs'

// A. B. C. up to Z, then the number. 26 options or more is the numbered-list
// band anyway (#414), where the letters have stopped helping.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const marker = (i) => (i < LETTERS.length ? LETTERS[i] : String(i + 1))

const has = (v) => v !== undefined && v !== null && String(v).trim() !== ''

// The visual arrives as rows and leaves as a fenced block. curia writes the
// fence, so an agent can never send a broken one (#432 reads it either way).
export function visualBlock(visual) {
  const body = unfence(visual)
  return `\`\`\`\n${body}\n\`\`\``
}

// The consequence and the example, under the thing they belong to. `↳` is the
// cost and `›` is the case, which is the pairing the #415 rehearsal was judged
// on.
function detailLines(o) {
  const lines = []
  if (has(o?.consequence)) lines.push(`↳ ${String(o.consequence).trim()}`)
  if (has(o?.example)) lines.push(`› ${String(o.example).trim()}`)
  return lines
}

// curia keeps its own button words on the two-answer kinds (ADR-0019). The
// agent supplies what each answer costs, and the order is fixed: approve first.
const APPROVE_REJECT = ['✅ Approve', '❌ Reject']

export function composeCard(kind, payload = {}) {
  const parts = []
  if (has(payload.headline)) parts.push(`**${String(payload.headline).trim()}**`)
  if (has(payload.visual)) parts.push(visualBlock(payload.visual))

  if (kind === 'free-text') {
    // A round is typed now (#285 wrote the numbers by hand inside one prose
    // prompt). The numbering is what the agent maps the one reply back onto,
    // so curia prints it rather than trusting the prose to carry it.
    for (const [i, q] of (payload.questions ?? []).entries()) {
      const lines = [`**${i + 1}.** ${String(q?.text ?? '').trim()}`]
      if (has(q?.recommendation)) lines.push(`↳ ${String(q.recommendation).trim()}`)
      parts.push(lines.join('\n'))
    }
  } else if (kind === 'choice') {
    for (const [i, o] of (payload.options ?? []).entries()) {
      parts.push([`**${marker(i)}. ${String(o?.label ?? '').trim()}**`, ...detailLines(o)].join('\n'))
    }
    const picked = (payload.options ?? []).findIndex((o) => o?.recommended)
    if (picked >= 0) parts.push(`Recommendation: **${marker(picked)}**.`)
  } else {
    // approve-reject and preview-review. The options are optional here, and
    // when they come they carry consequences under curia's own labels.
    const opts = payload.options ?? []
    if (opts.length === 2) {
      parts.push(opts.map((o, i) => `${APPROVE_REJECT[i]}: ${String(o?.consequence ?? '').trim()}`).join('\n'))
    }
  }

  // Facts in the spoiler, reasoning on the timeline (#415). The rule that
  // governs this field is that split, not its 500-character cap.
  if (has(payload.detail)) parts.push(`Details: ||${String(payload.detail).trim()}||`)
  if (payload.timeline) parts.push('-# The reasoning is on the timeline. The button is below.')
  return parts.join('\n\n')
}

// The review gate's own body (#417 put the gate on this ticket). Its heading,
// its links and its digest line stay in `reviewGateText` — this composes only
// the parts the agent typed, so the gate keeps one composer for the prose and
// one for the evidence around it.
export function composeReviewBody(payload = {}) {
  const parts = []
  if (has(payload.headline)) parts.push(`**${String(payload.headline).trim()}**`)
  if (has(payload.visual)) parts.push(visualBlock(payload.visual))
  if (has(payload.detail)) parts.push(`Details: ||${String(payload.detail).trim()}||`)
  return parts.join('\n\n')
}

// The ✅ All as recommended button, DERIVED (ADR-0019). It renders when every
// question of the round carries a recommendation, and on no other round.
//
// The `recommended` boolean retires here. An agent could set it on a round
// where one question had no recommendation, and the button then lied about it:
// the operator taps "all", and one of the questions it claimed had no answer to
// take. A derived button cannot lie, so curia reads the payload instead of the
// claim about it.
export function derivedRecommended(kind, payload = {}) {
  const qs = payload.questions ?? []
  return kind === 'free-text' && qs.length > 0
    && qs.every((q) => String(q?.recommendation ?? '').trim() !== '')
}

// The labels the button and the select-menu paths read. A typed `choice` keeps
// its options as objects, and every answer path in the bridge resolves a pick
// by INDEX into this array — so the labels ride the record beside the payload
// and nothing downstream has to know which shape the call arrived in.
export const optionLabels = (payload = {}) => (payload.options ?? [])
  .map((o) => (o && typeof o === 'object' ? String(o.label ?? '') : String(o)))

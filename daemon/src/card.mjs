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
// What is NOT in here: every link. The status line owns the preview, Chat, and
// ticket links. The decision buttons, select menu, and answer instructions stay
// in the bridge because they are the answer surface.

import { unfence, isTypedResult, verdictGrade, VERDICT_SEVERITIES } from './lint.mjs'
import { SIGNALS, smallPrint } from './messaging.mjs'

// A. B. C. up to Z, then the number. 26 options or more is the numbered-list
// band anyway (#414), where the letters have stopped helping.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const marker = (i) => (i < LETTERS.length ? LETTERS[i] : String(i + 1))

const has = (v) => v !== undefined && v !== null && String(v).trim() !== ''

export function composeOpening(opening = {}) {
  return [
    `⚙️ ${String(opening.goal ?? '').trim()}`,
    String(opening.first_step ?? '').trim(),
  ].join('\n')
}

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

// The ending report the thread reads (#419, ADR-0019). It is the FIRST of the
// ending's two messages (#253): the agent's own voice states what the work came
// to, and curia's receipt follows it.
//
// The parts read top down as the operator's eye does. The headline says what the
// work came to, the visual shows it, the summary says what changed, and the
// spoiler holds the facts a reader may want and nobody needs.
export function composeResultBody(payload = {}) {
  const parts = []
  if (has(payload.headline)) parts.push(`**${String(payload.headline).trim()}**`)
  if (has(payload.visual)) parts.push(visualBlock(payload.visual))
  if (has(payload.summary)) parts.push(String(payload.summary).trim())
  if (has(payload.detail)) parts.push(`Details: ||${String(payload.detail).trim()}||`)
  return parts.join('\n\n')
}

// The whole post, status and all. The STATUS leads, because it is the one thing
// the operator reads this message for.
//
// A report with no headline keeps the one-line shape the thread has read since
// #253: the status, a colon, and the summary. Since the flip (#422) that report
// is a FLAGGED send and nothing else, because the floor refuses a headline-less
// one three times first. It still renders, because a flagged ending in the
// thread beats an ending that reaches it never.
export function composeResultReport(status, payload = {}) {
  const head = `✅ **${status}**`
  if (isTypedResult(payload) && has(payload.headline)) {
    const typedHead = `✅ **${status}** - **${String(payload.headline).trim()}**`
    const body = composeResultBody({ ...payload, headline: undefined })
    return body ? `${typedHead}\n\n${body}` : typedHead
  }
  const body = composeResultBody(payload)
  if (!body) return head
  return isTypedResult(payload) ? `${head}\n\n${body}` : `${head}: ${body}`
}

// The status line (#420, ADR-0019). It asks nothing, so it carries no options
// and no buttons: the message, the visual under it, and the facts in a spoiler.
//
// THE KIND SET IS WHAT THE OPERATOR MUST DO, never how the agent rates its own
// news. `progress` needs nothing from them, `look` needs their eyes now, and
// `ask` wants a reply whenever they get to it. A set built on the agent's own
// weighting — routine against notable — is a claim the payload cannot check,
// and ADR-0019 retired the `recommended` boolean for being exactly that.
//
// Three kinds and no fourth. A finding is `progress`, because the operator acts
// on it later. A prototype that is ready is `look`. An ending is neither: it is
// the report `report_result` already sends (#419).
export const NOTIFY_KINDS = ['progress', 'look', 'ask']
const DEFAULT_NOTIFY_KIND = 'progress'

// One prefix per kind, from the signal set `voice.md` fixes. `ask` is the entry
// #420 added to it: the other six said what curia had done, and none of them
// said that a reply is wanted.
const NOTIFY_SIGNAL = {
  progress: SIGNALS.work,
  look: SIGNALS.link,
  ask: SIGNALS.ask,
}

// An `ask` is a question nothing waits on, so the operator is told where the
// answer goes. Small print, one line (#414), and true of every thread message:
// a note reaches its agent on the next tool result the agent reads.
const ASK_LINE = 'Reply in this thread when you can. It reaches the agent on its next tool call.'

// The prefix rides here rather than at the call site, because this composer
// owns the whole post — the same rule the ending report follows. A notify with
// no kind is a `progress` one, so it keeps the exact line the thread has read
// since the first one. The flip (#422) left this surface alone: `message` was
// the floor before it and it is the floor after it.
export function composeNotify(payload = {}) {
  const kind = NOTIFY_KINDS.includes(payload.kind) ? payload.kind : DEFAULT_NOTIFY_KIND
  const parts = []
  if (has(payload.message)) parts.push(`${NOTIFY_SIGNAL[kind]} ${String(payload.message).trim()}`)
  if (has(payload.visual)) parts.push(visualBlock(payload.visual))
  if (has(payload.detail)) parts.push(`Details: ||${String(payload.detail).trim()}||`)
  if (kind === 'ask' && parts.length) parts.push(smallPrint(ASK_LINE))
  return parts.join('\n\n')
}

// ---- the cross-check verdict (#421, ADR-0010, ADR-0019) -----------------------
//
// The reviewer's `report_result` is the verdict, and this composes it ONCE. The
// daemon stores the result on the captured artifact, and the three renderings
// that follow — the pull-request comment, the builder's note and the thread
// carrier when no builder is left — all read that one string. Three renderings
// of one text is the rule `resolve.mjs` already keeps, and this keeps the text
// itself in one place.
//
// The GRADE leads, under the headline, because it is the one thing the operator
// reads a verdict for. It is derived from the severities rather than typed, so
// a verdict cannot say `pass` over its own blocker.
const VERDICT_SIGNAL = { pass: SIGNALS.ok, concerns: SIGNALS.warn, fail: SIGNALS.no }

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// What the grade line counts. A clean reading says so in words: "no findings" is
// a result, and an empty line under a `pass` would read as a missing one.
function findingCounts(findings) {
  const counts = VERDICT_SEVERITIES
    .map((s) => [s, findings.filter((f) => String(f?.severity ?? '').trim().toLowerCase() === s).length])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => plural(n, s))
  return counts.length ? counts.join(', ') : 'no findings'
}

// A finding beyond this ticket's scope is marked, not dropped. ADR-0010 sends it
// to the builder's charting field, and the mark is what the builder sorts on.
const OUT_OF_SCOPE = 'out of scope'

export function composeVerdict(payload = {}) {
  const findings = Array.isArray(payload.findings) ? payload.findings : null
  const parts = []
  if (has(payload.headline)) parts.push(`**${String(payload.headline).trim()}**`)
  const grade = verdictGrade(findings)
  if (grade) parts.push(`${VERDICT_SIGNAL[grade]} **${grade}** — ${findingCounts(findings)}`)
  if (has(payload.visual)) parts.push(visualBlock(payload.visual))
  if (has(payload.summary)) parts.push(String(payload.summary).trim())
  for (const [i, f] of (findings ?? []).entries()) {
    const severity = String(f?.severity ?? '').trim().toLowerCase()
    const scope = f?.out_of_scope ? ` (${OUT_OF_SCOPE})` : ''
    parts.push([`**${i + 1}. ${severity || '?'}**${scope}`, String(f?.text ?? '').trim()].join('\n'))
  }
  if (has(payload.detail)) parts.push(`Details: ||${String(payload.detail).trim()}||`)
  return parts.join('\n\n')
}

// The reviewer's ending post, in the reviewer's own voice (#421). A builder's
// ending says the ticket is done, and this one says what a second reading
// found, so it wears the cross-check signal rather than the ✅ of an ending.
//
// The STATUS still leads, for the reason the report's does: a reviewer that
// reports `blocked` could not read the diff at all, and that is the first thing
// the operator needs. The grade of the diff sits under it, inside the verdict.
export function composeVerdictReport(status, payload = {}) {
  const head = `🔎 the cross-check found **${status}**`
  const body = composeVerdict(payload)
  return body ? `${head}\n\n${body}` : head
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

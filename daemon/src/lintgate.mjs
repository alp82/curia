// The reject-on-lint gate (#418), the mechanism ADR-0005 owns and ADR-0019's
// typed fields feed.
//
// A call whose prose fails the lint is REFUSED with the lint message. The agent
// rewrites its own text and calls again. The daemon never rewrites it, and no
// daemon-side model is asked to (that is out of scope on the #413 map).
//
// THE CAP IS THREE REJECTIONS, then curia accepts the text and flags it.
// [#416](https://github.com/alp82/curia/issues/416) measured both edges live. A
// claude agent reads a rejection and fixes the named faults on attempt 2, with
// no instruction telling it to, so one rejection is usually enough. At the other
// end an opus run gave up after 6 rejections and a sonnet run after 10, and by
// attempt 8 it had stopped asking the operator's question and started asking
// about the lint. Three sits well inside both numbers.
//
// THE DAEMON COUNTS, because an agent miscounts its own. The count is per call
// site — the agent and the kind, which is the same key supersession uses (#336)
// — and a call that opens a record clears it, so the next question starts fresh.
//
// A SCHEMA FAULT TAKES THE SAME PATH, with one rule of its own: a schema
// rejection never traps a question. At the third schema rejection curia sends
// whatever text the call did carry, flagged, and the operator sees which fields
// were missing. A call carrying no text at all has nothing to send, so curia
// refuses it for good and says so. The alternative is a question that reaches
// nobody, which is the failure #438 spent a whole ticket closing.

export const REJECTION_CAP = 3

// The line every rejection ends on. Shortening is what an agent reaches for
// under a character cap, and shortening is exactly where a decision loses an
// option or a constraint.
const KEEP_EVERYTHING = 'Keep every option and every constraint. A cap is a ceiling, not a target.'

export function rejectionText({ faults, attempt, schema = false }) {
  const what = schema
    ? 'The payload does not carry the fields this kind needs'
    : 'The words did not pass the lint'
  return [
    `❌ curia refused this call. ${what} (attempt ${attempt} of ${REJECTION_CAP}).`,
    '',
    ...faults.map((f) => `• ${f}`),
    '',
    `Rewrite the named fields and call again. ${KEEP_EVERYTHING}`,
  ].join('\n')
}

// The cap is reached, so the text goes out as it stands. The agent is told, in
// the tool result it is already waiting on, that the question is with the
// operator now.
export function flaggedText(faults) {
  return `⚠️ curia sent this call as it stands, flagged with ${faults.length} lint fault(s) you did not fix.`
    + ' The operator sees the faults on the card, beside the text that failed them.'
    + ' Do not call again about this question. It is with them now, and this call is waiting for their answer.'
}

// The same cap, on the ending report (#419). The words differ because the
// surface does: a report asks nothing, so nobody is waiting on an answer to it.
// It is the last call of the ticket, and saying "do not call again" is what
// stops an agent from spending its ending on the lint.
export function flaggedResultText(faults) {
  return `⚠️ curia sent your report as it stands, flagged with ${faults.length} lint fault(s) you did not fix.`
    + ' The operator sees the faults in the thread, under the report.'
    + ' Do not call `report_result` again. The ticket has ended and this report is on the record.'
}

// A schema fault at the cap with nothing to send. This is the one refusal that
// is final, and it says what would have made it sendable.
export function deadEndText(faults) {
  return [
    `❌ curia refused this call for good after ${REJECTION_CAP} attempts, and it carried no text to send.`,
    '',
    ...faults.map((f) => `• ${f}`),
    '',
    'Nothing here can reach the operator, so curia opened no card. Write the fields and make a fresh call.',
  ].join('\n')
}

// The gate itself. It owns no state: the count is a reduction over the journal,
// so it survives the restart that kills the call it was counting.
export class LintGate {
  constructor({ reduction, log = () => {} }) {
    this.reduction = reduction
    this.log = log
  }

  // Judge one call. Returns one of:
  //   { ok: true }                     nothing to say, open the record
  //   { reject: <text> }               refuse, and the agent rewrites
  //   { ok: true, flags: [...] }       the cap is reached, send it flagged
  //   { refuse: <text> }               a schema dead end, and no card opens
  //
  // `hasText` is what separates the last two. A call with a headline and no
  // options can still ask something. A call with nothing cannot.
  judge({ agent, kind, faults, schema = false, hasText = true, prompt = null, payload = null }) {
    if (!faults.length) {
      this.reduction.clearLintRejections(agent, kind)
      return { ok: true }
    }
    const attempt = this.reduction.lintRejections(agent, kind) + 1
    if (attempt > REJECTION_CAP) {
      if (!hasText) {
        this.log(`lint gate: ${agent}/${kind} refused for good after ${REJECTION_CAP} attempts with no text to send`)
        this.reduction.clearLintRejections(agent, kind)
        return { refuse: deadEndText(faults) }
      }
      this.log(`lint gate: ${agent}/${kind} reached the cap, sending flagged with ${faults.length} fault(s)`)
      return { ok: true, flags: faults, note: flaggedText(faults) }
    }
    this.reduction.journalLintRejection({ agent, kind, faults, schema, prompt, payload })
    this.log(`lint gate: ${agent}/${kind} rejected ${attempt}/${REJECTION_CAP} — ${faults.length} fault(s)`)
    return { reject: rejectionText({ faults, attempt, schema }) }
  }

  // What the Stop hook reads (#438). An agent that lost its rejection believes
  // its question went out and moves on to end its turn. The hook fires there and
  // hands the rejection back. On codex that is the ONLY channel curia can trust:
  // a rejection there is the `exec` script's return value and it never throws,
  // so a script that ignores the value leaves the model reading
  // `Script completed`.
  pending(agent) {
    return this.reduction.pendingLintRejection(agent)
  }
}

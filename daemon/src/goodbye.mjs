// The last word (#458, building the decision on #426).
//
// The daemon holds blocking calls. An `ask_human`, the review gate and a
// cross-check park each sit inside one MCP call, and the daemon is the thing
// that answers it. So when the daemon dies, every one of those calls dies with
// it — and until this file existed it died in SILENCE.
//
// What silence costs depends on the lane. A claude client aborts the call about
// 120 s later, and #341's ladder retries it. A codex client has NO transport-drop
// watchdog (docs/research/tool-channel-mid-session-codex.md): it waits out
// `CODEX_TOOL_TIMEOUT_S`, which curia sets to a day. Two measured runs were
// still waiting 595 s and 295 s after the death, with the daemon back for nearly
// all of it. No error, no retry, no Stop hook, no report — one deploy takes the
// whole session.
//
// #426 read the deaths that matter and found them PLANNED. `POST /restart`
// answers and exits. A deploy recreates the container, so the daemon gets a
// SIGTERM. In both cases the daemon is alive, it holds every blocked call, and
// it knows it is about to die. So the fix is not a deadline and not a delay. It
// is a last word: end every blocked call with a tool ERROR before exiting.
//
// Three rules shape the words below, and each one is a fault somebody already
// paid for:
//
//   - An ERROR, never a text result. The ladder needs a failure to retry, and a
//     text result reads as an answer. That is the exact fault #56 recorded from
//     a live agent, which took a broken call for permission to decide the
//     question itself.
//   - The record stays OPEN. The question is still the operator's to answer, and
//     a card that vanishes mid-deploy loses a question nobody typed again. So
//     nothing here closes, lapses or supersedes anything. The agent asks again,
//     and #369 hands back an answer that landed in between.
//   - The words say three things: curia is restarting, the question is NOT
//     answered, and about how long to wait before asking again.
//
// A SIGKILL reaches nobody, and this file does not pretend otherwise. That case
// is #457's, and `CODEX_TOOL_TIMEOUT_S` is still the only bound there.

// How long the wakened calls get to leave the socket before the process exits.
// A blocked call is an open HTTP response, so the error has to be written and
// flushed by the same process that is about to end. It is deliberately SMALL:
// a goodbye that hangs is a daemon that does not restart, and the whole point of
// the drain is one round of the event loop with the sockets already writing.
export const GOODBYE_DRAIN_MS = 250

// What the agent is told to wait. It is #341's own second rung: the daemon is
// usually back in seconds, but a deploy rebuilds an image, and a retry that
// fires at once falls inside the same outage. Two minutes is what the standing
// orders already name, so the goodbye and the orders say one number.
export const GOODBYE_WAIT_S = 120

// The two halves both texts share, written once: what happened, and the wait
// before the agent tries again. A goodbye whose two forms named two different
// waits would be two rules for one death.
const RESTARTING = 'CURIA IS RESTARTING, and this call dies with it.'
const COMES_BACK = `The daemon comes back by itself. Wait ${GOODBYE_WAIT_S} seconds with a foreground \`sleep ${GOODBYE_WAIT_S}\`, then`

// What a blocked question is told: an `ask_human`, the review gate, or a
// synthetic `POST /escalate?wait`. One text for all three, because one thing
// happened to all three, and the review gate IS a question with two buttons.
//
// So the last line says "the same CALL" rather than "the same question": the
// gate is repeated with `request_review` and a question with `ask_human`, and
// the standing orders name the act the same way.
export function questionGoodbye() {
  return [
    `${RESTARTING} THIS IS NOT AN ANSWER.`,
    '',
    'Your question is still open, and the card is still in front of the operator. Nobody answered it,',
    'and curia recorded no answer for you. Never take this error for a reply, and never decide the',
    'question yourself because the tool broke.',
    '',
    `${COMES_BACK} make the`,
    'same call again. If the operator answered while curia was down, that answer comes back on the',
    'call you make.',
  ].join('\n')
}

// What a builder parked on a cross-check verdict is told. `on` says which call
// it is parked inside — the gate or the ending — so the words name the call it
// must make again, and the rejoin (#237) gets its chance on this lane too.
export function parkGoodbye(on = 'gate') {
  const again = on === 'ending' ? '`report_result`' : '`request_review`'
  return [
    `${RESTARTING} THIS IS NOT A VERDICT.`,
    '',
    'Nothing was approved and nothing was rejected. The reviewer still reads your diff in its own pane,',
    'which the daemon does not own. Curia holds its verdict for you.',
    '',
    `${COMES_BACK} call`,
    `${again} again. That call parks you back on the verdict.`,
  ].join('\n')
}

// Ref'd on purpose. An unref'd drain lets an empty event loop end the process
// on its own, and a daemon that exits 0 stays down (`restart: on-failure`).
const pause = (ms) => new Promise((done) => { setTimeout(done, ms) })

const describe = (counts) => Object.entries(counts).map(([what, n]) => `${n} ${what}`).join(', ')

// Say goodbye, then hand back. The CALLER exits: this function knows what a
// blocked call is and nothing about why the process is ending.
//
// `wake` is a map of name → function, one per wait registry, and each one ends
// its own calls and returns how many it ended. Two of them exist (#426): the
// escalation resolvers in `index.mjs`, and the cross-check park in
// `dispatch.mjs`. A goodbye that woke one and left the other would strand
// exactly the agent it exists for, so the count is per registry and the journal
// carries both.
//
// Nothing here throws. Every death that calls this is already committed, so a
// waker that fails costs its own registry and never the exit.
export async function sayGoodbye({ reason, wake, journal, log = () => {}, drainMs = GOODBYE_DRAIN_MS, wait = pause }) {
  const counts = {}
  let woken = 0
  for (const [what, waker] of Object.entries(wake)) {
    let n = 0
    try {
      n = waker() ?? 0
    } catch (e) {
      log(`the goodbye could not wake the ${what} (${e.message})`)
    }
    counts[what] = n
    woken += n
  }
  try {
    journal?.('daemon_goodbye', { reason, woken, ...counts })
  } catch (e) {
    log(`the goodbye could not be journalled (${e.message})`)
  }
  log(woken
    ? `goodbye (${reason}): ${woken} blocked call(s) ended with an error — ${describe(counts)}, draining ${drainMs} ms`
    : `goodbye (${reason}): no call was blocked, so nothing was woken`)
  // A drain with nothing to drain is a deploy that got slower for no reason.
  if (woken > 0) await wait(drainMs)
  return { woken, counts }
}

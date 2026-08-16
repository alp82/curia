// The replay (#388, building ADR-0015): a turn a restart killed is sent again,
// never retyped.
//
// WHY THIS EXISTS. The routine deploy is `docker compose up -d --build --no-deps
// daemon dashboard overseer`, so it recreates the daemon and the overseer
// together and every turn in flight on both dies with them. Before this, the
// operator read `⚠️ the overseer container did not answer (...)` and typed their
// message a second time.
//
// THE TEST IS THE SEAM COUNT, and ADR-0015 names it: a turn that crossed
// `/command` zero times is replayed, and a turn that ran a verb is not. Sending
// a message again that already dispatched an agent would dispatch a second one.
// So a turn that DID cross gets a line naming what it ran, and the operator
// decides from there.
//
// WHERE THE COUNT COMES FROM after the process holding it died: the seam
// journals every crossing as a `command` event, and #388 put the conversation
// key on that event. The store counts them onto the pending turn, so the boot
// reads a number this process never saw.
//
// WHAT MAKES A TURN "KILLED": the journal started it and never ended it. A turn
// survives no restart, so anything still open when a process boots was killed by
// the restart that ended the last one. The list is read ONCE, before this daemon
// can start a turn of its own.
//
// FOUR THINGS STOP A REPLAY, and each one leaves the same line rather than
// silence:
//
//   1. The turn crossed the seam. It already did something.
//   2. The turn was itself a replay. curia sends one message again once, never
//      twice — a daemon in a crash loop must not replay one message forever.
//   3. The conversation has spoken since the boot. The operator retyped it, and
//      a replay landing behind their own words is the second message ADR-0015
//      exists to avoid.
//   4. The message is stale, or the container never came back. A daemon down for
//      an hour must not wake a conversation with an hour-old message.

import { isConsoleKey } from './attach.mjs'
import { SIGNALS, smallPrint } from './messaging.mjs'

// How long the boot waits for the container to answer its health check, how
// often it asks, and how old a message may be and still be sent again. The wait
// is generous because a deploy rebuilds the overseer image; the freshness window
// is short because it bounds a surprise, not a failure.
export const REPLAY_WAIT_MS = 120_000
export const REPLAY_POLL_MS = 3_000
export const REPLAY_FRESH_MS = 15 * 60_000

// The line the conversation gets when curia did NOT send the message again. It
// names what that turn ran when it ran anything, because that is the fact the
// operator decides from.
export function droppedLine({ commands = [], why = null }) {
  const parts = [`${SIGNALS.warn} a restart killed the turn on your last message here.`]
  // The commands ARE the reason when there are any, so the reason is not said
  // twice: "it had already run `start 256`" and "it already crossed the seam"
  // are one fact in two sentences.
  if (commands.length) parts.push(`It had already run ${commands.map((c) => `\`${c}\``).join(', ')}.`)
  const reason = commands.length ? '' : `${why ? ` — ${why}` : ''}`
  parts.push(`curia did not send the message again${reason}. Say it again if you still want it.`)
  return parts.join(' ')
}

// The line that goes in FRONT of a replay, so the operator reads their own words
// coming back as curia's doing rather than as an echo they did not ask for.
export function replayLine() {
  return smallPrint('a restart killed the turn on your last message — curia is sending it again.')
}

function ageMs(at, nowMs) {
  const t = at ? Date.parse(at) : NaN
  return Number.isNaN(t) ? Infinity : nowMs - t
}

// Why this killed turn must not be sent again, or null when it may be. Pure, so
// the whole decision is readable without a container, a bridge or a clock.
export function refuseReplay(killed, { nowMs, bootAt, lastTurnAt = null, live = false, freshMs = REPLAY_FRESH_MS }) {
  if (killed.crossings > 0) return 'it already crossed the seam'
  if (killed.replay) return 'curia already sent this message again once'
  if (live) return 'you were already talking here'
  if (lastTurnAt && Date.parse(lastTurnAt) > bootAt) return 'you were already talking here'
  if (ageMs(killed.at, nowMs) > freshMs) return `the message is older than ${Math.round(freshMs / 60_000)} minutes`
  return null
}

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms).unref?.())

// Poll `ready()` until it answers true or the deadline passes.
async function waitUntil(ready, { deadline, pollMs, nowMs, sleep }) {
  for (;;) {
    if (await ready()) return true
    if (nowMs() >= deadline) return false
    await sleep(pollMs)
  }
}

// THE BOOT PASS. Everything it touches is injected, so the suite drives it with
// no container, no bridge and no clock.
//
//   `killed`    the pending turns, read off the journal before this daemon
//               could start one of its own
//   `probe`     the container health check — the same one the overview reads
//   `discord`   `{ ready(), say(threadId, text), replay(threadId, prompt) }`,
//               or null when this daemon runs without a bridge
//   `browser`   `replay(key, prompt)` for a browser conversation, which has no
//               thread: its answer reaches the Chat screen through the
//               transcript, and the dropped line reaches it through the journal
export async function replayKilledTurns({
  killed, store, probe, discord = null, browser = null, live = () => false,
  bootAt, log = console.log, nowMs = () => Date.now(), sleep = sleepFor,
  waitMs = REPLAY_WAIT_MS, pollMs = REPLAY_POLL_MS, freshMs = REPLAY_FRESH_MS,
}) {
  if (!killed.length) return []
  log(`[overseer] the restart killed ${killed.length} turn(s) — reading what may be sent again`)
  const deadline = nowMs() + waitMs

  const up = await waitUntil(async () => (await probe()).up, { deadline, pollMs, nowMs, sleep })
  // The bridge is only in the way of a Discord conversation. A browser one is
  // replayed whatever Discord is doing.
  const needsBridge = killed.some((k) => !isConsoleKey(k.key))
  const bridgeUp = up && needsBridge && discord
    ? await waitUntil(async () => discord.ready(), { deadline, pollMs, nowMs, sleep })
    : Boolean(discord)

  // EVERY VERDICT IS DECIDED AND JOURNALLED FIRST, before one word is sent.
  // The drop event ends the killed turn as well as reporting it, so a daemon
  // that dies in the middle of this finds the replays' own turns on its next
  // boot and never one of these twice.
  const out = killed.map((k) => {
    const browserKey = isConsoleKey(k.key)
    let why = refuseReplay(k, {
      nowMs: nowMs(), bootAt, lastTurnAt: store.lastOverseerTurnAt(k.key), live: live(k.key), freshMs,
    })
    if (!why && !up) why = 'the overseer container did not come back'
    if (!why && !browserKey && !bridgeUp) why = 'the Discord bridge did not come back'
    if (!why && !browserKey && !k.thread_id) why = 'that turn names no thread to answer in'
    store.dropOverseerTurn({
      key: k.key, turn: k.turn, crossings: k.crossings, commands: k.commands,
      replayed: !why, why,
    })
    log(`[overseer] killed turn on ${k.key}: ${why ? `not sent again — ${why}` : 'sending the message again'}`)
    return { key: k.key, replayed: !why, why }
  })

  // THEN THEY RUN TOGETHER. A replayed turn takes as long as any turn, and one
  // conversation must not wait on another's — the one-turn rule is per
  // conversation, and these are different ones by construction.
  await Promise.all(killed.map(async (k, i) => {
    const { why } = out[i]
    const browserKey = isConsoleKey(k.key)
    try {
      if (why) {
        // A browser conversation has no thread. Its line is the journal event
        // above: the feed carries it, and the Chat picker draws it on that
        // conversation's row until it takes its next turn.
        if (!browserKey && discord && k.thread_id) await discord.say(k.thread_id, droppedLine({ commands: k.commands, why }))
        return
      }
      // A thread the operator deleted takes the replay with it. Nothing is
      // retried and nothing is moved: there is no second place those words
      // belong, and the journal already says curia sent them.
      const sent = browserKey ? await browser?.replay(k.key, k.prompt) : await discord?.replay(k.thread_id, k.prompt)
      if (sent === false) log(`[overseer] the replay on ${k.key} reached no thread — it is gone`)
    } catch (e) {
      // A replay that fails is a turn that failed, and the conversation already
      // carries whatever the turn said about it. Nothing is retried: one message
      // is sent again once.
      log(`[overseer] the replay on ${k.key} failed: ${String(e.message ?? e).split('\n')[0]}`)
    }
  }))
  return out
}

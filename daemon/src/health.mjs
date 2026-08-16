// Process-level crash guard (#56).
//
// The daemon died mid-run because discord.js abandons a gateway socket that is
// still CONNECTING: `WebSocketShard.destroy()` nulls `onmessage`/`onclose`/
// `onerror` but only calls `close()` when the socket reached OPEN, so a socket
// dropped mid-handshake keeps its 30s handshake timer armed with ZERO error
// listeners. When that timer fires, ws emits 'error' on a listener-less emitter
// and Node turns it into an uncaught exception. One transient network blip
// therefore killed dispatch, escalation, preview and reconcile together.
//
// Three fixes were considered and two rejected, which is what leaves this file
// holding a process-level handler at all:
//
//   - `client.on('error')` does NOT see it. The throw happens on the raw ws
//     emitter, one layer below the Client. (Those handlers are still installed
//     in bridge.mjs, because an unhandled 'error' on the Client is fatal too.)
//   - Upgrading does NOT fix it: @discordjs/ws 2.0.4 still nulls onerror on a
//     CONNECTING socket (installed here: 1.2.3).
//   - Attaching our own `.on('error')` to each shard socket WOULD work — a plain
//     listener survives `onerror = null` — but there is no "socket created"
//     event, so it means polling private internals that can move under us and
//     stop guarding SILENTLY. A guard that fails quietly is the thing this
//     ticket calls worse than the crash.
//
// So the guard is selective, not a swallow-everything net (operator call): an
// error carrying a NETWORK signal is survivable and gets journalled; anything
// else keeps today's behaviour and kills the process — but now leaves a journal
// line first, which a bare crash does not.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Node/undici/ws socket-level failures. A network error is a fact about the
// network, not a logic bug, so it is survivable wherever it was raised.
const NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_AGAIN', 'ENOTFOUND',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

// ws and the gateway say some of it in prose rather than in a code. The first
// entry is #56's own error, verbatim from the crash.
const NET_MESSAGES = [
  /opening handshake has timed out/i,
  /socket hang up/i,
  /websocket was closed before the connection was established/i,
  /websocket is not open/i,
  /unexpected server response: 5\d\d/i,
  /connection (?:reset|timed out|refused|closed) /i,
  /network socket disconnected/i,
  /getaddrinfo/i,
]

// The classifier's second rule, and the one the LIVE CHECK forced. Matching on
// codes and prose alone was too narrow: during a real DNS outage discord.js
// tried to identify on a socket still in CONNECTING and rejected with
// "WebSocket is not open: readyState 0 (CONNECTING)" — no code, no network word,
// and the guard dutifully killed the daemon it exists to keep alive. That was a
// gateway race, not a curia bug, and its stack said so: every frame inside
// ws/@discordjs/ws, not one inside this daemon.
//
// So: an error thrown entirely inside the gateway client is the gateway's
// problem, and curia survives it. The moment one of OUR frames appears the rule
// stops applying — a fault reached through discord.js is still ours to die on.
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY_LIB = /node_modules[/\\](?:ws|@discordjs[/\\]ws|discord\.js)[/\\]/

function fromGatewayInternals(err) {
  const stack = typeof err?.stack === 'string' ? err.stack : ''
  if (!GATEWAY_LIB.test(stack)) return false
  return !stack.includes(SRC_DIR)
}

// undici wraps the real failure: `TypeError: fetch failed` with the socket error
// on `.cause`. Classifying the wrapper alone would miss every fetch blip.
function chain(err, seen = new Set()) {
  const out = []
  let e = err
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e)
    out.push(e)
    e = e.cause
  }
  return out
}

// Returns { transient, why } — `why` is the reason the classification is what it
// is, and it goes in the journal so a wrong call is arguable after the fact.
export function classifyFault(err) {
  for (const e of chain(err)) {
    if (e.code && NET_CODES.has(e.code)) return { transient: true, why: `network error code ${e.code}` }
    const msg = typeof e.message === 'string' ? e.message : ''
    const hit = NET_MESSAGES.find((re) => re.test(msg))
    if (hit) return { transient: true, why: `network failure message: ${msg}` }
  }
  for (const e of chain(err)) {
    if (fromGatewayInternals(e)) return { transient: true, why: 'raised inside the gateway client, with no curia frame on the stack' }
  }
  const top = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return { transient: false, why: `no network signal in ${top}` }
}

function describe(err) {
  if (!(err instanceof Error)) return { message: String(err), stack: null, code: null }
  return { message: err.message, name: err.name, code: err.code ?? null, stack: err.stack ?? null }
}

// Install the guard. `onTransient` is called with the detail so the caller can
// say it out loud (a silently-down bridge is the failure this ticket names);
// `onFault` runs before the exit and must not throw.
//
// #458 gave `onFault` a second job and an await: the daemon says goodbye to
// every blocked call on its way out, and the error it sends needs a bounded
// moment to leave the socket. So a promise from `onFault` HOLDS the exit until
// it settles, and it must bound itself — a goodbye that hangs is a daemon that
// does not restart. A sync `onFault`, or none, exits in the same tick it always
// did.
//
// `journal` must be SYNCHRONOUS (ADR-0017). This guard journals and then exits,
// so a write that only started before `exit(1)` is a record curia loses at the
// one moment it needs one. The journal's insert is synchronous, which is what
// makes that ordering hold.
export function installCrashGuard({ log = console.log, journal, onTransient, onFault, exit = (c) => process.exit(c) } = {}) {
  const handle = (err, origin) => {
    const { transient, why } = classifyFault(err)
    const detail = { origin, transient, why, ...describe(err) }
    try {
      journal?.(transient ? 'daemon_transient' : 'daemon_fault', detail)
    } catch (e) {
      log(`crash guard could not journal (${e.message}) — continuing to the decision`)
    }
    if (transient) {
      log(`[crash-guard] survived ${origin}: ${detail.message} (${why})`)
      if (detail.stack) log(detail.stack)
      try { onTransient?.(detail) } catch (e) { log(`crash guard onTransient failed: ${e.message}`) }
      return
    }
    log(`[crash-guard] FATAL ${origin}: ${detail.message} (${why}) — exiting, journalled as daemon_fault`)
    if (detail.stack) log(detail.stack)
    let said = null
    try { said = onFault?.(detail) } catch (e) { log(`crash guard onFault failed: ${e.message}`) }
    if (said && typeof said.then === 'function') {
      const die = () => exit(1)
      said.then(die, (e) => { log(`crash guard onFault failed: ${e.message}`); die() })
      return
    }
    exit(1)
  }

  process.on('uncaughtException', (err) => handle(err, 'uncaughtException'))
  // Node ≥15 turns an unhandled rejection into an uncaught exception, i.e. into
  // the same kill. Classify it the same way rather than leaving one door open.
  process.on('unhandledRejection', (reason) => handle(reason, 'unhandledRejection'))
  return handle
}

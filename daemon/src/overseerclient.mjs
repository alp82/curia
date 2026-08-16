// The turn crosses the boundary (#314) — the DAEMON half. The container half,
// and the protocol both halves speak, is `overseerturn.mjs`.
//
// THE BOUNDARY (ADR-0014, cut over on #315): the overseer model runs in its
// own container, and this file is the daemon's whole reach into it. The
// container holds a shell, so the containment is no longer a tool list in this
// process — it is the container itself, the read-only GitHub token, and the
// one way back in: every verb call lands on the daemon's own MCP side channel
// below, which composes the canonical text HERE and posts it to the same
// `/command` seam the slash verbs and REST use. The daemon executes every
// effect, and the ✅/❌ confirm on a destructive verb survives, because the
// container never touches the router — it only ever asks.
//
// Three things live here, and they are one job:
//
//   1. `OverseerTurns` — the per-turn registry. It mints the secret the
//      container's model presents, and it holds what a verb call needs to know:
//      which thread to route to, and how to narrate.
//   2. `buildVerbMcpServer` — the eight verbs as an HTTP MCP server, which is
//      the daemon's own side channel. The handlers are the catalogue's, so a
//      call composes canonical text HERE and posts it to `/command`.
//   3. `OverseerClient` — what the bridge and the Chat screen call. It kept
//      the in-daemon `OverseerHost`'s shape on purpose: the cutover (#315)
//      swapped the two and nothing else at either door had to change.
//
// THE SECRET IS PER TURN, and it lives in memory for the length of one. An
// agent's token is a file, because a restarted daemon adopts agents its
// predecessor spawned and those agents keep using the token they were given. A
// turn survives no restart at all — ADR-0015 replays it instead — so there is
// nothing to adopt, and nothing on disk to sweep.
//
// WHAT THE DAEMON STILL OWNS after the model left the process: the conversation
// (store.overseerSession), the one-turn-at-a-time rule per conversation, the
// operator notes a confirm left behind, and every effect. The container owns
// the model, the shell and the checkouts. Nothing owns both.

import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { verbHandlers } from './overseerverbs.mjs'
import { TOKEN_HEADER, tokensEqual } from './agenttoken.mjs'
import { SIGNALS, smallPrint } from './messaging.mjs'
import {
  TURN_PATH, OVERSEER_MCP_PATH, MCP_SERVER_NAME, TURN_EVENTS,
  OVERSEER_CONTAINER_MODEL, overseerConfigDirFor,
} from './overseerturn.mjs'

// The eight verbs, served over HTTP MCP. One server per request, like the agent
// surface: the transport is stateless, and the per-turn context is closed over
// by `command` before this is ever called.
export function buildVerbMcpServer(command) {
  const server = new McpServer({ name: 'curia-overseer', version: '0.1.0' }, { capabilities: { logging: {} } })
  for (const { verb, description, args, handler } of verbHandlers(command)) {
    server.tool(verb, description, args, handler)
  }
  return server
}

export class OverseerTurns {
  #turns = new Map()

  // `narrate(text)` is the status line, and `command(text, ctx)` is the seam.
  // The wrapper below is what makes a verb call a curia effect: it counts the
  // crossing, says the canonical text out loud, and posts it as INTERPRETED —
  // which is what sends a destructive verb through the ✅/❌ confirm (#94)
  // rather than executing it.
  begin({ key, routeThreadId = null, command, narrate = async () => {} }) {
    const id = crypto.randomBytes(8).toString('hex')
    const token = crypto.randomBytes(32).toString('hex')
    // verb -> seam crossings no result has claimed yet (#275). The client reads
    // it when the container reports a tool result, so a call that died at the
    // MCP layer and reached no handler reads as the refusal it was.
    const crossed = new Map()
    const seam = async (text) => {
      // Count first, then narrate: the tally is what the result reads, and a
      // status edit that fails must not read back as a refusal.
      const verb = text.split(' ')[0]
      crossed.set(verb, (crossed.get(verb) ?? 0) + 1)
      // The total, which nothing decrements. ADR-0015 replays a turn a restart
      // killed, and ONLY one that crossed this seam zero times — a turn that
      // already dispatched or cancelled must never be replayed. #395 reads it.
      turn.crossings += 1
      try {
        await narrate(text)
      } catch { /* the status line is not the effect */ }
      // `overseerKey` is what makes the command event countable after this
      // process dies (#388): the daemon journals every crossing as a `command`
      // already, and the key is what ties one to the conversation it crossed
      // for. The boot counts the crossings of a killed turn off those lines.
      return command(text, { threadId: routeThreadId, interpreted: true, overseerKey: key })
    }
    const turn = { id, token, key, routeThreadId, crossed, crossings: 0, command: seam }
    this.#turns.set(id, turn)
    return turn
  }

  // Fails CLOSED: an unknown turn, an ended one, a missing header and a wrong
  // secret are one answer. The id names the turn only after the secret proves
  // the caller holds it.
  claim(id, presented) {
    const turn = this.#turns.get(String(id ?? ''))
    if (!turn) return null
    return tokensEqual(turn.token, presented) ? turn : null
  }

  end(id) {
    this.#turns.delete(id)
  }

  get size() {
    return this.#turns.size
  }
}

// The NDJSON reader. A line that does not parse is skipped rather than thrown
// on: the stream is the only channel the answer arrives by, and one bad line
// must not lose the turn.
async function* turnEvents(body, log) {
  let buffer = ''
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        yield JSON.parse(line)
      } catch {
        log(`[overseer] unreadable turn event: ${line.slice(0, 120)}`)
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer)
    } catch {
      log(`[overseer] unreadable turn event: ${buffer.slice(0, 120)}`)
    }
  }
}

export class OverseerClient {
  // `port` is the container's published loopback port (`overseer.port`, read
  // and never typed twice). `daemonHost`/`daemonPort` are how the container
  // reaches back — the docker host gateway, the same path an agent takes.
  constructor({
    store, command, workspaceRoot, port, daemonPort,
    daemonHost = 'host.docker.internal', model = OVERSEER_CONTAINER_MODEL,
    log = console.log, fetchImpl = fetch, turns = new OverseerTurns(),
  }) {
    this.store = store
    this.command = command
    this.workspaceRoot = workspaceRoot
    this.port = port
    this.daemonPort = daemonPort
    this.daemonHost = daemonHost
    this.model = model
    this.log = log
    this.fetchImpl = fetchImpl
    this.turns = turns
    // The Chat screen reads a transcript off this directory, and the container
    // writes it there because compose mounts the one path on both sides.
    this.configDir = overseerConfigDirFor(workspaceRoot)
    this.busy = new Set() // conversation keys with a turn in flight
  }

  get base() {
    return `http://127.0.0.1:${this.port}`
  }

  mcpUrlFor(turnId) {
    return `http://${this.daemonHost}:${this.daemonPort}${OVERSEER_MCP_PATH}?turn=${turnId}`
  }

  // A browser conversation's turn (#267, keyed per conversation by #333). Two
  // things differ from a Discord turn, and both follow from there being no
  // Discord thread: the answer is not posted, because the timeline surface
  // tails the transcript, and the verb tools run with NO origin thread, so a
  // confirm lands in the channel and in the console's needs-you list.
  async browserTurn(key, text, { replay = false } = {}) {
    if (!this.store.hasConsoleConversation?.(key)) {
      throw new Error(`there is no conversation \`${key}\` — it was deleted, and its number is spent; open a new one from the Chat screen`)
    }
    const said = []
    const out = await this.runTurn(key, text, {
      say: (t) => { said.push(t) },
      status: () => {},
      routeThreadId: null,
      replay,
    })
    if (out.busy) throw new Error('curia is still on your last message — one turn at a time')
    if (!out.ok) throw new Error(said.join('\n') || `the turn ended without an answer (${out.why})`)
    return out
  }

  // One operator message → one turn, and one turn posts exactly two messages
  // (#95, per #89): status(text) upserts the single small-print status line,
  // and say(text) posts the answer. Failures land in the answer slot.
  //
  // `replay` marks a turn the boot is sending again (#388). It changes nothing
  // about how the turn runs — it rides the journal so a SECOND restart can tell
  // a replay from an operator's own message, and never replay a replay.
  async runTurn(key, prompt, { say, status, routeThreadId = key, replay = false }) {
    if (this.busy.has(key)) {
      await say(smallPrint(`${SIGNALS.warn} still on your last message — one turn at a time per thread`))
      return { ok: false, busy: true }
    }
    this.busy.add(key)
    const steps = []
    const step = async (text) => {
      steps.push(text)
      await status(smallPrint(`${SIGNALS.work} ${steps.join(' · ')}`))
    }
    try {
      // Confirm outcomes that resolved between turns (#94) ran button → daemon
      // with no model in the loop, so the conversation never heard them.
      const notes = this.store.takeOverseerNotes?.(key) ?? []
      const fullPrompt = notes.length
        ? `${notes.map((t) => `[curia: ${t}]`).join('\n')}\n\n${prompt}`
        : prompt
      // The journal keeps THIS text, notes and all (#388). The drain already
      // happened, so a turn a restart kills has taken those notes off the queue
      // without ever showing them to the model — and the replay is the one thing
      // that can still deliver them.
      const out = await this.#turn(key, fullPrompt, { say, step, routeThreadId, replay })
      if (!out.ok) await say(`${SIGNALS.warn} ${out.said}`)
      return out
    } finally {
      this.busy.delete(key)
    }
  }

  // THE REGISTERED TURN, and the two journal lines that bracket it (#388).
  // Everything between them is one turn in flight, so a turn still open when
  // this process dies is the turn the restart killed — and the boot finds it by
  // reading the journal rather than a map this process took with it.
  async #turn(key, prompt, { say, step, routeThreadId, replay = false }) {
    // The status line states the text the SEAM carried and nothing else (#275),
    // in code because it is a command line and not prose.
    const turn = this.turns.begin({
      key, routeThreadId, command: this.command, narrate: (text) => step(`\`${text}\``),
    })
    this.store.beginOverseerTurn({ key, turn: turn.id, prompt, threadId: routeThreadId, replay })
    let out
    try {
      out = await this.#hop(key, prompt, turn, { say, step })
    } finally {
      this.turns.end(turn.id)
      this.store.endOverseerTurn({
        key, turn: turn.id, ok: out?.ok ?? false, crossings: turn.crossings, why: out?.why ?? null,
      })
    }
    return out
  }

  // THE HOP. One POST, one NDJSON stream back, one registered turn for as long
  // as it runs. There is no second model attempt: the in-daemon host retried a
  // failed Haiku turn on Sonnet, and Sonnet IS the model here (ADR-0014), so
  // the failure goes to the operator. ADR-0015 gives a killed turn a replay
  // instead, and it is the same test — a turn that crossed the seam zero times.
  async #hop(key, prompt, turn, { say, step }) {
    const resume = this.store.overseerSession(key)
    this.log(`[overseer] turn key=${key} resume=${resume ?? 'fresh'} model=${this.model} → ${this.base}${TURN_PATH}`)
    let sessionId = null
    let toolCalls = 0
    let end = null
    try {
      const res = await this.fetchImpl(`${this.base}${TURN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key,
          prompt,
          resume: resume ?? null,
          model: this.model,
          mcp: { url: this.mcpUrlFor(turn.id), headers: { [TOKEN_HEADER]: turn.token } },
        }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const why = `the overseer container refused the turn (HTTP ${res.status})`
        this.log(`[overseer] ${why}: ${detail.slice(0, 300)}`)
        return { ok: false, why, said: `${why} — see the daemon log`, toolCalls: 0, crossings: turn.crossings }
      }
      for await (const ev of turnEvents(res.body, this.log)) {
        if (ev.event === TURN_EVENTS.session && ev.id) {
          // The session id a turn states, journalled per conversation, last
          // write wins. It is the only handle on the conversation, and #332
          // reads it to find the transcript the Chat screen draws.
          sessionId = ev.id
          this.store.bindOverseerSession(key, ev.id)
        } else if (ev.event === TURN_EVENTS.note && ev.text) {
          await step(ev.text)
        } else if (ev.event === TURN_EVENTS.verb) {
          toolCalls += 1
        } else if (ev.event === TURN_EVENTS.verbResult) {
          // A result exists only after its handler returned, so the tally is
          // already settled. Nothing to claim means the MCP layer refused the
          // call: name the verb, not a command line nothing ran.
          const left = turn.crossed.get(ev.name) ?? 0
          if (left > 0) turn.crossed.set(ev.name, left - 1)
          else await step(`${SIGNALS.warn} \`${ev.name}\` refused before the router`)
        } else if (ev.event === TURN_EVENTS.answer) {
          await say(ev.text)
        } else if (ev.event === TURN_EVENTS.end) {
          end = ev
        }
      }
    } catch (e) {
      // The container is down, the deploy recreated it mid-turn, or the stream
      // died. Whatever it was, this turn has no answer and the operator must
      // not read that as silence.
      const why = String(e.message ?? e).split('\n')[0]
      this.log(`[overseer] turn key=${key} lost the container: ${why}`)
      return {
        ok: false,
        why,
        said: `the overseer container did not answer (${why})`,
        toolCalls,
        crossings: turn.crossings,
        sessionId,
      }
    }
    if (!end) {
      return {
        ok: false,
        why: 'the turn stream ended with no result',
        said: 'the turn ended without an answer (the container closed the stream)',
        toolCalls,
        crossings: turn.crossings,
        sessionId,
      }
    }
    if (!end.ok) {
      return {
        ok: false,
        why: end.why,
        said: `session ended without an answer (${end.why})`,
        toolCalls: end.tool_calls ?? toolCalls,
        crossings: turn.crossings,
        sessionId,
      }
    }
    return { ok: true, toolCalls: end.tool_calls ?? toolCalls, crossings: turn.crossings, secs: end.secs, sessionId }
  }
}

// The daemon's `/overseer/mcp` route, as one function so index.mjs wires it and
// the suite drives it. `serve` is what actually runs the MCP request, injected
// because the transport is index.mjs's own.
export async function serveVerbMcp({ turns, id, presented, log = console.log, refuse, serve }) {
  const turn = turns.claim(id, presented)
  if (!turn) {
    log(`refused ${OVERSEER_MCP_PATH} for turn "${id}" — ${presented ? 'the secret does not match the one curia minted for that turn' : 'no turn secret on the request'}`)
    return refuse(`no live curia overseer turn "${id}" — the daemon mints one secret per turn and hands it to the container in the turn request`)
  }
  return serve(buildVerbMcpServer(turn.command))
}

export { MCP_SERVER_NAME }

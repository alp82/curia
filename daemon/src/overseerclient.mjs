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
//   2. `buildVerbMcpServer` — the verb catalogue as an HTTP MCP server, which is
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
// (reduction.overseerSession), the one-turn-at-a-time rule per conversation, the
// operator notes a confirm left behind, and every effect. The container owns
// the model, the shell and the checkouts. Nothing owns both.

import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { verbHandlers } from './overseerverbs.mjs'
import { TOKEN_HEADER, tokensEqual } from './agenttoken.mjs'
import { conversationTokenMatches, isOverseerKey, overseerRoute } from './overseeridentity.mjs'
import { SIGNALS, smallPrint } from './messaging.mjs'
import {
  TURN_PATH, OVERSEER_MCP_PATH, MCP_SERVER_NAME, TURN_EVENTS,
  OVERSEER_CONTAINER_MODEL, overseerConfigDirFor,
} from './overseerturn.mjs'

// The verb catalogue, served over HTTP MCP. One server per request, like the agent
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

// The pointer a failed turn carries while the lane is held (#678).
//
// NO LINK OF ITS OWN, and NOT the hold's `why`. The hold already said both,
// once, where it alarms — one login, one link, said where the alarm was said.
// A second copy of either is a second account of one fault, free to disagree
// with the first, and the disagreement is invisible until the minute it
// matters. Slice D's lane-field rule, arriving on a third surface.
//
// What this line adds is the one thing neither surface can say: that the turn
// the operator just watched fail and the alarm they may not have read are the
// same event.
//
// THE LANE IS NAMED FROM THE HOLD, not written in here. The hold states its own
// provider, and a literal would be this file's second opinion about which lane
// died — wrong the day a consumer on another provider reports a failure here.
const credentialPointer = (provider) =>
  `The \`${provider}\` lane is held — curia cannot use this credential, so this turn could not run. The sign-in is waiting in \`#curia\` and on the dashboard.`

export class OverseerClient {
  // `port` is the container's published loopback port (`overseer.port`, read
  // and never typed twice). `daemonHost`/`daemonPort` are how the container
  // reaches back — the docker host gateway, the same path an agent takes.
  constructor({
    reduction, command, workspaceRoot, port, daemonPort,
    daemonHost = 'host.docker.internal', model = OVERSEER_CONTAINER_MODEL,
    log = console.log, fetchImpl = fetch, turns = new OverseerTurns(),
    onModelCallFailed = null,
  }) {
    this.reduction = reduction
    this.command = command
    this.workspaceRoot = workspaceRoot
    this.port = port
    this.daemonPort = daemonPort
    this.daemonHost = daemonHost
    this.model = model
    this.log = log
    this.fetchImpl = fetchImpl
    this.turns = turns
    // A CONSUMER REPORTING A FAILED MODEL CALL (#678). The overseer runs on the
    // anthropic credential and takes a turn whenever the operator speaks, so a
    // failed turn is the earliest thing on the box that can know the credential
    // died — the detector's own schedule is ten minutes wide.
    //
    // IT IS A TRIGGER AND NOT EVIDENCE, and the name says the act rather than
    // the diagnosis. Every failure the container can have — an SDK throw, a
    // dead MCP seam, an unreadable config, `max_turns` — has collapsed into one
    // `why` STRING by the time it crosses the boundary (`overseerturn.mjs`), so
    // there is nothing here to classify and this file never tries. The turn
    // supplies the timing; the provider's own detector supplies the verdict. A
    // `why` string must never freeze the fleet.
    //
    // It answers with the lane's HOLD, or null — both when nothing is wired and
    // when the lane is fine. That return is what composes the pointer, and
    // taking it from the same call is what stops the pointer being composed off
    // a hold read BEFORE the check.
    this.onModelCallFailed = onModelCallFailed
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
    if (!this.reduction.hasConsoleConversation?.(key)) {
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
      const notes = this.reduction.takeOverseerNotes?.(key) ?? []
      const fullPrompt = notes.length
        ? `${notes.map((t) => `[curia: ${t}]`).join('\n')}\n\n${prompt}`
        : prompt
      // The journal keeps THIS text, notes and all (#388). The drain already
      // happened, so a turn a restart kills has taken those notes off the queue
      // without ever showing them to the model — and the replay is the one thing
      // that can still deliver them.
      const out = await this.#turn(key, fullPrompt, { say, step, routeThreadId, replay })
      if (!out.ok) await say(`${SIGNALS.warn} ${await this.#failureLine(key, out)}`)
      return out
    } finally {
      this.busy.delete(key)
    }
  }

  // WHAT THE OPERATOR READS WHEN A TURN FAILS, composed in ONE place because
  // there are two doors and one of them is not Discord (#678). The thread reads
  // what `say` posts; the Chat screen reads the same strings back out of
  // `browserTurn`'s collector. Composing it in either door would give the two
  // surfaces two accounts of one failure.
  //
  // THE CHECK IS AWAITED, not fired alongside. A pointer that arrives one turn
  // late is the exact failure this exists to remove, and the cost is bounded by
  // the probe's own five-second timeout on a path that has already failed.
  //
  // EVERY non-`busy` FAILURE ASKS, with no filter on the shape. A busy return is
  // excluded structurally — it leaves `runTurn` above before a turn is ever
  // registered, so there is no failed model call to report. Over-firing costs
  // one quota-free request that the detector's own latch and retry clock will
  // refuse anyway; a filter here would be one more thing that can be wrong about
  // a failure it was never told the shape of.
  //
  // A CLEAN CHECK LEAVES A LOG LINE AND NOTHING ELSE. `endOverseerTurn` already
  // journals the failure with its `why`, and a second event per checked failure
  // would be a journal of how often the operator spoke to a working box.
  async #failureLine(key, out) {
    if (!this.onModelCallFailed) return out.said
    this.log(`[overseer] turn key=${key} failed (${out.why}) — re-checking the model credential`)
    let held = null
    try {
      held = await this.onModelCallFailed()
    } catch (e) {
      // The detector is one more thing that can be down, and a turn that has
      // already failed must not fail twice on the way to saying so.
      this.log(`[overseer] the model credential check failed: ${e.message}`)
    }
    return held?.provider ? `${out.said}\n${credentialPointer(held.provider)}` : out.said
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
    this.reduction.beginOverseerTurn({ key, turn: turn.id, prompt, threadId: routeThreadId, replay })
    let out
    try {
      out = await this.#hop(key, prompt, turn, { say, step })
    } finally {
      this.turns.end(turn.id)
      this.reduction.endOverseerTurn({
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
    const resume = this.reduction.overseerSession(key)
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
          this.reduction.bindOverseerSession(key, ev.id)
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

// The same route, for a conversation that lives in a pane (#701, ADR-0024).
//
// THE DIFFERENCE FROM `serveVerbMcp` IS WHERE THE ROUTE COMES FROM. A turn
// carries its own registry entry, which the daemon built moments earlier and
// which already knows the thread. A pane outlives every turn it ever takes, so
// there is no registry entry to read: the daemon authenticates the conversation
// with its durable token and then loads the destination from `overseerRoute`, a
// pure function of that key. Nothing the pane sends reaches the route.
//
// The seam is the one the turn path uses, argument for argument, so a verb call
// from a pane is journalled, confirmed, and executed exactly like a verb call
// from a turn. The token proves the conversation. It never widens what the
// conversation may do.
export async function serveConversationMcp({
  dataDir, key, presented, command, narrate = async () => {},
  log = console.log, refuse, serve,
}) {
  if (!isOverseerKey(key) || !conversationTokenMatches(dataDir, key, presented)) {
    log(`refused ${OVERSEER_MCP_PATH} for conversation "${key}" - ${presented ? 'the secret does not match the one curia minted for that conversation' : 'no conversation secret on the request'}`)
    return refuse(`no curia overseer conversation "${key}" holds that token - the daemon mints one token per conversation and writes it into the pane's own connection settings`)
  }
  const route = overseerRoute(key)
  const seam = async (text) => {
    try {
      await narrate(text)
    } catch { /* the status line is not the effect */ }
    return command(text, { threadId: route.routeThreadId, interpreted: true, overseerKey: route.key })
  }
  return serve(buildVerbMcpServer(seam), route)
}

export { MCP_SERVER_NAME }

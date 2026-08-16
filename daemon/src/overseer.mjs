// Overseer session host (#92) — the spike's overseer (#83) moved in-process,
// on the research pick (#82): one SDK `query()` per Discord message, `resume`
// per thread. The thread→session map is a reduction over the daemon journal
// (store.overseerSession), so a daemon restart loses no conversation.
//
// The whole tool surface is one in-process MCP server. Each handler posts
// canonical verb text to the SAME /command seam the slash verbs and REST use —
// that seam is the containment boundary: the daemon executes every effect, the
// session holds no shell, no files, no process handles. Config posture mirrors
// an agent's (workspace.mjs): config isolated under a dedicated dir, host
// credentials shared through CLAUDE_SECURESTORAGE_CONFIG_DIR — confirmed live
// on #83.

import fs from 'node:fs'
import path from 'node:path'
import { query as sdkQuery, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { seedConfigDir, agentEnv } from './workspace.mjs'
import { SYSTEM_PROMPT, ALLOWED_TOOLS, DISALLOWED_TOOLS } from './overseerprompt.mjs'
import { canonicalFor, verbHandlers } from './overseerverbs.mjs'
import { SIGNALS, smallPrint } from './messaging.mjs'

// Haiku answers the verb catalogue reliably (measured on #83: fresh turn
// 7-16 s at $0.01-0.03, revival 2.5 s at $0.009). Sonnet is the fallback.
export const OVERSEER_MODEL = 'claude-haiku-4-5'
export const OVERSEER_FALLBACK_MODEL = 'claude-sonnet-5'

// The browser conversations (#267, made many by #333 on ADR-0016). The console
// chat is the overseer in a thread of its own: one brain, two surfaces, and no
// second chat anywhere.
//
// The key is `console-<n>` rather than a Discord snowflake, and that is the
// whole distinction it carries — `store.overseerSession` keys the conversation
// on it, so a browser conversation resumes across a daemon restart exactly as a
// Discord thread does, and it can never collide with one.
//
// It was ONE key, `console`, until #333. One conversation that never ends rots
// its own context and compacts badly, so the browser now gets many, and a new
// one is the reset a new Discord thread already is. The vocabulary — the key,
// the session name it is served under, and the counter that only goes up —
// lives in attach.mjs beside the chat handle it must not collide with.
//
// The SESSION name is what the timeline surface serves a conversation under. It
// reads as a curia session (attach.mjs validSessionName) because the timeline
// admits nothing else.

// The verb catalogue moved to `overseerverbs.mjs` (#314): the container reaches
// the same eight over HTTP MCP, and one catalogue is what keeps the two
// transports the same eight. Re-exported here because this file was their home
// until then.
export { canonicalFor }

// #91's grown catalogue, one tool per verb, as the IN-PROCESS SDK server this
// host runs. #315 deletes this adapter with the rest of the file.
export function buildVerbTools(command) {
  return verbHandlers(command).map(({ verb, description, args, handler }) => tool(verb, description, args, handler))
}

// The standing orders and the tool list that agrees with them both live in
// `overseerprompt.mjs` (#328). They moved out of this file because they outlive
// it: this host has no shell, the overseer service of ADR-0014 has one, and
// #315 deletes this host and not the text. What is re-exported here is the
// NO-SHELL posture, which is byte for byte the text this host always sent.
export { SYSTEM_PROMPT, ALLOWED_TOOLS, DISALLOWED_TOOLS }

export class OverseerHost {
  // command: async (canonicalText, {threadId}) -> reply string — gate.command
  // in the daemon, a stub in tests. queryFn: the SDK's query, injectable for
  // tests.
  constructor({ store, command, dataDir, log = console.log, model, fallbackModel, maxTurns = 12, queryFn = sdkQuery }) {
    this.store = store
    this.command = command
    this.log = log
    this.model = model ?? process.env.OVERSEER_MODEL ?? OVERSEER_MODEL
    this.fallbackModel = fallbackModel ?? process.env.OVERSEER_FALLBACK_MODEL ?? OVERSEER_FALLBACK_MODEL
    this.maxTurns = maxTurns
    this.queryFn = queryFn
    // Fixed overseer home: resume is keyed by cwd (#82), so this path must
    // never change between runs. No checkout lives here.
    this.home = path.join(dataDir, 'overseer', 'home')
    this.configDir = path.join(dataDir, 'overseer', 'config')
    fs.mkdirSync(this.home, { recursive: true })
    // The agent seed (workspace.mjs): no first-run dialog, home pre-trusted,
    // credentials swept from the config dir — the session shares the host
    // store through agentEnv instead. No skills: the overseer has no files
    // to run them against.
    seedConfigDir(this.configDir, this.home)
    this.busy = new Set() // thread ids with a turn in flight
  }

  // ---- a browser conversation's turn (#267, keyed per conversation by #333) -
  //
  // The console chat is this same overseer, in a thread of its own. One brain
  // answers the operator on Discord and in the browser, and neither surface
  // holds a second one.
  //
  // Two things differ from a Discord turn, and both follow from there being no
  // Discord thread here.
  //
  //   1. The ANSWER is not posted. The SDK writes every turn to the session
  //      transcript, and the timeline surface tails that file (#74), so the
  //      words reach the page by the same path an agent's words do. A `say`
  //      that also posted would say one fact twice (ADR-0013).
  //   2. The verb tools run with NO origin thread. A confirm this turn opens
  //      is the one thing a browser turn cannot render — there is no thread to
  //      put the buttons in — so it takes the same route a REST press takes and
  //      lands in the channel, plus the console's own needs-you list.
  //
  // `key` names WHICH browser conversation, and it must be one the store holds.
  // The refusal below is the deleted-conversation case: the page can sit on a
  // key the operator has just deleted from another device, and a turn on it
  // would mint a fresh conversation under a number that is spent.
  //
  // What comes back is the failure, and only the failure: a turn that ends
  // without an answer must not read as silence on the page.
  async browserTurn(key, text) {
    if (!this.store.hasConsoleConversation?.(key)) {
      throw new Error(`there is no conversation \`${key}\` — it was deleted, and its number is spent; open a new one from the Chat screen`)
    }
    const said = []
    const out = await this.runTurn(key, text, {
      say: (t) => { said.push(t) },
      status: () => {},
      routeThreadId: null,
    })
    if (out.busy) throw new Error('curia is still on your last message — one turn at a time')
    if (!out.ok) throw new Error(said.join('\n') || `the turn ended without an answer (${out.why})`)
    return out
  }

  // One in-process MCP server per turn, so the verb tools carry the thread
  // they run in (#93): the router binds `start` to that thread. Cheap — the
  // server is a plain object over the same seven handlers. `interpreted`
  // marks the text as model-produced (#94): the router routes interpreted
  // destructive verbs through the button confirm instead of executing.
  // `narrate` runs on the way in, so the status line states the text this
  // seam carried and nothing else (#275).
  #mcpFor(threadId, narrate) {
    return createSdkMcpServer({
      name: 'curia',
      version: '0.1.0',
      tools: buildVerbTools(async (text) => {
        await narrate(text)
        return this.command(text, { threadId, interpreted: true })
      }),
    })
  }

  // One operator message → one turn, and one turn posts exactly two messages
  // (#95, per #89): status(text) upserts the single small-print status line —
  // the caller sends it once and edits it in place — and say(text) posts the
  // answer. Failures land in the answer slot; everything meta lands in status.
  //
  // `routeThreadId` (#267) is the thread the VERB TOOLS run in, which is the
  // session key everywhere until the browser conversations: a console turn keys
  // its conversation on `console-<n>` and routes its verbs with no thread at
  // all, because a console key is not a thread the bridge can post buttons
  // into.
  async runTurn(threadId, prompt, { say, status, routeThreadId = threadId }) {
    if (this.busy.has(threadId)) {
      await say(smallPrint(`${SIGNALS.warn} still on your last message — one turn at a time per thread`))
      return { ok: false, busy: true }
    }
    this.busy.add(threadId)
    // The status line accumulates across BOTH model attempts — the operator
    // watches one message grow, never a trail of them.
    const steps = []
    const step = async (text) => {
      steps.push(text)
      await status(smallPrint(`${SIGNALS.work} ${steps.join(' · ')}`))
    }
    try {
      // Confirm outcomes that resolved between turns (#94) ran button → daemon
      // with no model in the loop, so the session never heard them. The store
      // holds one journalled line per outcome; prefixing them here keeps
      // revival memory honest. Drained once — both model attempts below carry
      // the same augmented prompt.
      const notes = this.store.takeOverseerNotes?.(threadId) ?? []
      const fullPrompt = notes.length
        ? `${notes.map((t) => `[curia: ${t}]`).join('\n')}\n\n${prompt}`
        : prompt
      const first = await this.#turn(threadId, fullPrompt, this.model, { say, step, routeThreadId })
      if (first.ok) return first
      // Sonnet fallback (#82) — but only when the failed turn executed
      // nothing: a turn that died after a tool call may already have
      // dispatched or cancelled, and replaying the prompt could double the
      // effect. That failure goes to the operator instead.
      if (first.toolCalls === 0 && this.fallbackModel && this.fallbackModel !== this.model) {
        await step(`${SIGNALS.warn} ${this.model} turn failed (${first.why}) — retrying on ${this.fallbackModel}`)
        const second = await this.#turn(threadId, fullPrompt, this.fallbackModel, { say, step, routeThreadId })
        if (second.ok) return second
        await say(`${SIGNALS.warn} session ended without an answer (${second.why})`)
        return second
      }
      await say(`${SIGNALS.warn} session ended without an answer (${first.why})`)
      return first
    } finally {
      this.busy.delete(threadId)
    }
  }

  async #turn(threadId, prompt, model, { say, step, routeThreadId = threadId }) {
    const resume = this.store.overseerSession(threadId)
    this.log(`[overseer] turn thread=${threadId} resume=${resume ?? 'fresh'} model=${model}`)
    const t0 = Date.now()
    let result = null
    let toolCalls = 0
    let thrown = null
    // #275: a streamed tool_use block is a REQUEST, not an event. The MCP
    // layer validates the model's arguments after that block is written, and a
    // call that dies there — prose packed into `ticket` — reaches no handler
    // and no router. So each block is held here until its result comes back,
    // the canonical text is narrated from the seam itself (see #mcpFor), and a
    // result for a call that never reached the seam says so. The operator
    // reads one true line per call: the text the router got, or the refusal.
    const calls = new Map() // tool_use id -> verb
    const crossed = new Map() // verb -> seam crossings no result has claimed yet
    const narrate = (text) => {
      // Count first, then await the edit: the tally is what the result reads,
      // and a status edit that fails must not read back as a refusal. The verb
      // is the first word of the canonical text, by construction.
      const verb = text.split(' ')[0]
      crossed.set(verb, (crossed.get(verb) ?? 0) + 1)
      return step(`\`${text}\``)
    }
    try {
      const q = this.queryFn({
        prompt,
        options: {
          cwd: this.home,
          env: { ...process.env, ...agentEnv(this.configDir) },
          model,
          resume,
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { curia: this.#mcpFor(routeThreadId, narrate) },
          allowedTools: ALLOWED_TOOLS,
          disallowedTools: DISALLOWED_TOOLS,
          maxTurns: this.maxTurns,
        },
      })
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          // The session id a turn states, journalled per thread, last write
          // wins. Measured on claude 2.1.220 (docs/live-checks/
          // 332-transcript-by-key.md): a resume KEEPS the id and appends to the
          // one file, so this write is the same id every turn after the first.
          // It stays a write per turn because the id is the only handle on the
          // conversation, and #332 now reads it to find the transcript too.
          this.store.bindOverseerSession(threadId, msg.session_id)
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_use') {
              toolCalls += 1
              calls.set(block.id, block.name.replace('mcp__curia__', ''))
            }
          }
        }
        if (msg.type === 'user') {
          const content = msg.message?.content
          for (const block of Array.isArray(content) ? content : []) {
            if (block.type !== 'tool_result') continue
            const verb = calls.get(block.tool_use_id)
            if (verb === undefined) continue
            calls.delete(block.tool_use_id)
            // A result exists only after its handler returned, so the tally is
            // already settled here. Nothing to claim means the MCP layer
            // refused the call: name the verb, not a command line nothing ran.
            const crossings = crossed.get(verb) ?? 0
            if (crossings > 0) crossed.set(verb, crossings - 1)
            else await step(`${SIGNALS.warn} \`${verb}\` refused before the router`)
          }
        }
        if (msg.type === 'result') result = msg
      }
    } catch (e) {
      thrown = e
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (thrown || !result || result.subtype !== 'success') {
      const why = thrown?.message ?? result?.subtype ?? 'no result message'
      this.log(`[overseer] turn failed in ${secs}s (${why}) model=${model} toolCalls=${toolCalls}`)
      return { ok: false, why, toolCalls, secs }
    }
    this.log(`[overseer] done in ${secs}s — ${result.num_turns} turns, $${result.total_cost_usd?.toFixed(4) ?? '?'}`)
    await say(result.result || '(empty answer)')
    return { ok: true, toolCalls, secs }
  }
}

// Overseer session host (#92) — the spike's overseer (#83) moved in-process,
// on the research pick (#82): one SDK `query()` per Discord message, `resume`
// per thread. The thread→session map is a reduction over the daemon journal
// (store.overseerSession), so a daemon restart loses no conversation.
//
// The whole tool surface is one in-process MCP server. Each handler posts
// canonical verb text to the SAME /command seam the slash verbs and REST use —
// that seam is the containment boundary: the daemon executes every effect, the
// session holds no shell, no files, no process handles. Config posture mirrors
// a worker's (workspace.mjs): config isolated under a dedicated dir, host
// credentials shared through CLAUDE_SECURESTORAGE_CONFIG_DIR — confirmed live
// on #83.

import fs from 'node:fs'
import path from 'node:path'
import { query as sdkQuery, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { seedConfigDir, workerEnv } from './workspace.mjs'
import { SIGNALS, smallPrint } from './messaging.mjs'

// Haiku answers the verb catalogue reliably (measured on #83: fresh turn
// 7-16 s at $0.01-0.03, revival 2.5 s at $0.009). Sonnet is the fallback.
export const OVERSEER_MODEL = 'claude-haiku-4-5'
export const OVERSEER_FALLBACK_MODEL = 'claude-sonnet-5'

// The tool → router contract, pure: what canonical text each verb tool posts
// to /command. One string builder rather than seven inline template literals,
// so the mapping is testable without the SDK in the loop.
export function canonicalFor(verb, args = {}) {
  switch (verb) {
    case 'tickets':
    case 'next':
      return `${verb}${args.repo ? ' ' + args.repo : ''}`
    case 'status':
      return 'status'
    case 'start': {
      let text = `start ${args.repo ? `${args.repo}#` : ''}${args.ticket}`
      if (args.model) text += ` model=${args.model}`
      if (args.backend) text += ` backend=${args.backend}`
      return text
    }
    case 'cancel':
    case 'resume':
      return `${verb} ${args.ticket}`
    case 'attach':
      return `attach ${args.ticket}`
    default:
      throw new Error(`no canonical form for verb "${verb}"`)
  }
}

const asText = (text) => ({ content: [{ type: 'text', text }] })

// #91's grown catalogue, one tool per verb. `command(text)` is injected — in
// the daemon it is gate.command, so every overseer effect is journalled and
// routed exactly like a slash verb.
export function buildVerbTools(command) {
  const run = (verb) => async (args) => asText(await command(canonicalFor(verb, args)))
  const ticketArg = z.string().regex(/^\d+$/).describe('ticket number')
  const bulkArg = z.string().regex(/^(\d+|all)$/).describe('ticket number, or "all"')
  const repoArg = z.string().optional().describe('repo qualifier — any unambiguous part of a watched repo name')
  return [
    tool('tickets', 'List the takeable tickets across the watched repos, in map order, with the agent-only runnable count. Optionally limit to one repo.', {
      repo: repoArg,
    }, run('tickets')),
    tool('next', 'Dispatch a worker on the next takeable ticket. Optionally limit to one repo.', {
      repo: repoArg,
    }, run('next')),
    tool('status', 'Show the live workers: ticket, model, state, uptime, and who is waiting on input.', {}, run('status')),
    tool('start', 'Claim a ticket and dispatch a worker on it. Use the repo field when the ticket number alone is ambiguous.', {
      ticket: ticketArg,
      repo: repoArg,
      model: z.string().optional().describe('model override'),
      backend: z.string().optional().describe('backend override (claude | codex)'),
    }, run('start')),
    tool('cancel', 'Cancel the worker on a ticket, or "all" for every worker. Destructive, so the daemon posts ✅/❌ buttons and executes ONLY after the operator presses ✅. Call this directly when asked — never seek confirmation in conversation first, and never report the cancel as done: report that the confirm was posted.', {
      ticket: bulkArg,
    }, run('cancel')),
    tool('resume', 'Fresh worker on a ticket, inheriting its surviving worktree. "all" resumes every resumable ticket.', {
      ticket: bulkArg,
    }, run('resume')),
    tool('attach', 'Get the attach links (timeline + browser terminal) for a live worker.', {
      ticket: ticketArg,
    }, run('attach')),
  ]
}

export const ALLOWED_TOOLS = ['tickets', 'next', 'status', 'start', 'cancel', 'resume', 'attach']
  .map((t) => `mcp__curia__${t}`)

// ToolSearch is in here for the #83 gap, not for containment: with it
// available, Haiku spent its whole first turn searching for the curia tool
// schemas before the first real call. Disallowing it makes the harness present
// every schema eagerly.
export const DISALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Task', 'TodoWrite', 'NotebookEdit', 'AskUserQuestion', 'ToolSearch',
]

const SYSTEM_PROMPT = `You are the curia overseer. Curia is a personal orchestration daemon: it watches GitHub trackers, dispatches AI agent workers on tickets, and keeps the operator in the loop from any device. You are the command brain over its Discord surface.

You speak with one operator, in one Discord thread, in short Discord markdown. You act only through the curia tools. The daemon executes every effect.

What you do:
- Translate the operator's prose into the verbs: tickets, next, status, start, cancel, resume, attach.
- Answer reasoning questions from tool output ("what should I start next?" — call tickets, then recommend one, with a one-line reason).
- Report tool replies faithfully. Do not invent workers, tickets, or states.

Vocabulary the operator uses:
- A "map" is a wayfinder map: a GitHub issue whose child tickets chart one effort. The operator names maps by topic ("the landing page map"). The \`tickets\` output groups tickets under their map's header line ("map #109 **The curia landing page**").
- A map named in prose resolves to that map's header, never to repo-wide order: "continue with <map>" means \`start\` the FIRST ticket listed under that map's header. A repo can hold several maps — picking the repo's first takeable when the operator named a map dispatches the wrong ticket.
- When a phrase names no repo or map you know, call \`tickets\` with no filter and match the phrase against the headers that come back before saying you cannot.

Your memory goes stale:
- Tool output from an earlier turn may be minutes or hours old, and the daemon, the trackers, and the operator all change state between your turns. Re-run \`tickets\` or \`status\` before you refuse, recommend, or report state. Never answer from a previous turn's tool output.

Hard bounds (the never-list):
- Never answer an escalation or a review gate for the operator. If asked to, refuse and say why.
- Cancel executes nothing by itself: the daemon posts a ✅/❌ button confirm and tears down only after the operator presses ✅. Call the tool directly when asked — do not ask for confirmation in conversation, and never report a cancel as done; say the confirm was posted and where.
- You have no shell, no files, no repo checkout, and no process handles. Do not offer them.
- A failed tool call is not an answer. Report the failure as a failure.

Message shape (the standard, #89 — every answer follows it):
- One answer message per turn, under 10 lines. The daemon narrates your tool calls separately; do not repeat them.
- No headings, no tables, no blockquotes. Bold for ticket titles, inline code for verbs, session names, and ids.
- Lists are one line per item. Filter long tool replies to what the question asked, and end a truncated list with "N more".
- Wrap links in <> — except attach links, which stay bare.
- Emoji only as signals, only these: ⚙️ ✅ ❌ ⚠️ 🎫 ⚰️ 🔗.

Writing rules (mandatory, #133 — Simplified Technical English):
- Use the short common word: start, use, help, make sure, before, after, about, get, show, also.
- One name for one thing. Active voice. A verb for an action ("analyze the log", not "perform an analysis").
- One instruction per sentence, max 20 words. Descriptive sentences max 25 words.
- No contractions. No semicolons. No em-dashes — write two sentences.
- No marketing adjectives (seamless, robust, powerful).

Keep replies short. One thread is one conversation; you will be revived with full memory when the operator writes again.`

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
    // The worker seed (workspace.mjs): no first-run dialog, home pre-trusted,
    // credentials swept from the config dir — the session shares the host
    // store through workerEnv instead. No skills: the overseer has no files
    // to run them against.
    seedConfigDir(this.configDir, this.home)
    this.busy = new Set() // thread ids with a turn in flight
  }

  // One in-process MCP server per turn, so the verb tools carry the thread
  // they run in (#93): the router binds `start` to that thread. Cheap — the
  // server is a plain object over the same seven handlers. `interpreted`
  // marks the text as model-produced (#94): the router routes interpreted
  // destructive verbs through the button confirm instead of executing.
  #mcpFor(threadId) {
    return createSdkMcpServer({
      name: 'curia',
      version: '0.1.0',
      tools: buildVerbTools((text) => this.command(text, { threadId, interpreted: true })),
    })
  }

  // One operator message → one turn, and one turn posts exactly two messages
  // (#95, per #89): status(text) upserts the single small-print status line —
  // the caller sends it once and edits it in place — and say(text) posts the
  // answer. Failures land in the answer slot; everything meta lands in status.
  async runTurn(threadId, prompt, { say, status }) {
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
      const first = await this.#turn(threadId, fullPrompt, this.model, { say, step })
      if (first.ok) return first
      // Sonnet fallback (#82) — but only when the failed turn executed
      // nothing: a turn that died after a tool call may already have
      // dispatched or cancelled, and replaying the prompt could double the
      // effect. That failure goes to the operator instead.
      if (first.toolCalls === 0 && this.fallbackModel && this.fallbackModel !== this.model) {
        await step(`${SIGNALS.warn} ${this.model} turn failed (${first.why}) — retrying on ${this.fallbackModel}`)
        const second = await this.#turn(threadId, fullPrompt, this.fallbackModel, { say, step })
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

  async #turn(threadId, prompt, model, { say, step }) {
    const resume = this.store.overseerSession(threadId)
    this.log(`[overseer] turn thread=${threadId} resume=${resume ?? 'fresh'} model=${model}`)
    const t0 = Date.now()
    let result = null
    let toolCalls = 0
    let thrown = null
    try {
      const q = this.queryFn({
        prompt,
        options: {
          cwd: this.home,
          env: { ...process.env, ...workerEnv(this.configDir) },
          model,
          resume,
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { curia: this.#mcpFor(threadId) },
          allowedTools: ALLOWED_TOOLS,
          disallowedTools: DISALLOWED_TOOLS,
          maxTurns: this.maxTurns,
        },
      })
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          // resume mints a fresh session id for the continued conversation —
          // journal the latest one per thread, last write wins.
          this.store.bindOverseerSession(threadId, msg.session_id)
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_use') {
              toolCalls += 1
              // The status line shows the canonical verb text — the same
              // string the router receives — as inline code (#89).
              const verb = block.name.replace('mcp__curia__', '')
              let text
              try { text = canonicalFor(verb, block.input ?? {}) } catch { text = verb }
              await step(`\`${text}\``)
            }
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

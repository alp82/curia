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
    tool('cancel', 'Cancel the worker on a ticket, or "all" for every worker. Destructive: confirm with the operator in conversation before this call.', {
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

Hard bounds (the never-list):
- Never answer an escalation or a review gate for the operator. If asked to, refuse and say why.
- Cancel is destructive, and "cancel all" doubly so. Confirm in conversation first: state what will be torn down, ask, and call the tool only after the operator says yes in this thread.
- You have no shell, no files, no repo checkout, and no process handles. Do not offer them.
- A failed tool call is not an answer. Report the failure as a failure.

Keep replies short. One thread is one conversation; you will be revived with full memory when the operator writes again.`

export class OverseerHost {
  // command: async (canonicalText) -> reply string — gate.command in the
  // daemon, a stub in tests. queryFn: the SDK's query, injectable for tests.
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
    this.mcp = createSdkMcpServer({
      name: 'curia',
      version: '0.1.0',
      tools: buildVerbTools((text) => this.command(text)),
    })
  }

  // One operator message → one turn. post(text) delivers every visible line
  // (tool small-print, the answer, failures) — the caller owns the transport.
  async runTurn(threadId, prompt, { post }) {
    if (this.busy.has(threadId)) {
      await post('⏳ still on your last message — one turn at a time per thread')
      return { ok: false, busy: true }
    }
    this.busy.add(threadId)
    try {
      const first = await this.#turn(threadId, prompt, this.model, post)
      if (first.ok) return first
      // Sonnet fallback (#82) — but only when the failed turn executed
      // nothing: a turn that died after a tool call may already have
      // dispatched or cancelled, and replaying the prompt could double the
      // effect. That failure goes to the operator instead.
      if (first.toolCalls === 0 && this.fallbackModel && this.fallbackModel !== this.model) {
        await post(`-# ⚠️ ${this.model} turn failed (${first.why}) — retrying on ${this.fallbackModel}`)
        const second = await this.#turn(threadId, prompt, this.fallbackModel, post)
        if (second.ok) return second
        await post(`⚠️ session ended without an answer (${second.why})`)
        return second
      }
      await post(`⚠️ session ended without an answer (${first.why})`)
      return first
    } finally {
      this.busy.delete(threadId)
    }
  }

  async #turn(threadId, prompt, model, post) {
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
          mcpServers: { curia: this.mcp },
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
              const args = JSON.stringify(block.input ?? {})
              await post(`-# 🔧 ${block.name.replace('mcp__curia__', '')}${args === '{}' ? '' : ' ' + args}`)
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
    await post(result.result || '(empty answer)')
    return { ok: true, toolCalls, secs }
  }
}

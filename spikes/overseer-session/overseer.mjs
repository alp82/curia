// Spike #83: the cheapest overseer that can be reacted to.
//
// Shape (research #82, ranked pick 1): a standalone process beside the daemon.
// One `query()` per Discord message, `resume` per thread, fixed cwd + dedicated
// CLAUDE_CONFIG_DIR, thread→session map in a journal-lite JSONL. Tools are one
// in-process MCP server whose handlers call the live daemon's POST /command —
// the same seam Discord slash verbs and REST use. The daemon executes every
// effect; the session holds no handles.
//
// Throwaway. Nothing here is daemon code, and the daemon does not know it runs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, Events, GatewayIntentBits, ChannelType } from 'discord.js'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Same .env the daemon reads (daemon/.env, never committed).
const envFile = path.join(DIR, '..', '..', 'daemon', '.env')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

const TOKEN = process.env.DISCORD_BOT_TOKEN
const ALLOWED = (process.env.DISCORD_ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const GUILD_ID = process.env.CURIA_GUILD_ID
const CHANNEL = process.env.OVERSEER_CHANNEL ?? 'curia-overseer'
const DAEMON = `http://127.0.0.1:${process.env.PORT ?? 4271}`
const MODEL = process.env.OVERSEER_MODEL ?? 'claude-haiku-4-5'

// Fixed overseer home: resume is keyed by cwd (research #82, sessions doc), so
// this path must never change between runs. No checkout lives here.
const HOME = path.join(DIR, 'home')
// Dedicated config dir, credentials shared with the host (ADR-0007 posture,
// mirrored from daemon/src/workspace.mjs HARNESS.claude).
const CONFIG = path.join(DIR, 'config')
// Journal-lite: append-only JSONL, one {thread_id, session_id} per line.
// The in-memory map is a reduction over it, last write wins — rebuilt at boot,
// so a spike restart loses nothing (the restart-survival claim under test).
const JOURNAL = path.join(DIR, 'sessions.jsonl')

if (!TOKEN) {
  console.error('DISCORD_BOT_TOKEN is not set (daemon/.env)')
  process.exit(1)
}

fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(CONFIG, { recursive: true })
// Worker seed shape (workspace.mjs): no first-run dialog, HOME pre-trusted.
fs.writeFileSync(path.join(CONFIG, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  installMethod: 'native',
  autoUpdates: false,
  theme: 'dark',
  numStartups: 1,
  projects: {
    [HOME]: {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
    },
  },
}, null, 2))

// ---- thread → session map ---------------------------------------------------

const sessions = new Map()
if (fs.existsSync(JOURNAL)) {
  for (const line of fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean)) {
    try {
      const { thread_id, session_id } = JSON.parse(line)
      sessions.set(thread_id, session_id)
    } catch { /* torn tail line — ignore */ }
  }
  console.log(`[overseer] journal replayed: ${sessions.size} thread(s)`)
}

function journalSession(threadId, sessionId) {
  sessions.set(threadId, sessionId)
  fs.appendFileSync(JOURNAL, JSON.stringify({ thread_id: threadId, session_id: sessionId, ts: new Date().toISOString() }) + '\n')
}

// ---- tools: the verb catalogue over the daemon's /command seam --------------

async function daemonCommand(text) {
  const res = await fetch(`${DAEMON}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `daemon answered ${res.status}`)
  return body.reply ?? '(empty reply)'
}

const asText = (text) => ({ content: [{ type: 'text', text }] })

const curia = createSdkMcpServer({
  name: 'curia',
  version: '0.0.1',
  tools: [
    tool('tickets', 'List the takeable tickets across the watched repos, in map order. Optionally limit to one repo (owner/repo).', {
      repo: z.string().optional().describe('owner/repo to limit the list to'),
    }, async ({ repo }) => asText(await daemonCommand(`frontier${repo ? ' ' + repo : ''}`))),

    tool('status', 'Show the live workers: ticket, model, state, uptime.', {},
      async () => asText(await daemonCommand('status'))),

    tool('start', 'Claim a ticket and dispatch a worker on it. Use the repo field when the ticket number alone is ambiguous.', {
      ticket: z.string().regex(/^\d+$/).describe('ticket number'),
      repo: z.string().optional().describe('owner/repo qualifier'),
      model: z.string().optional().describe('model override'),
      backend: z.string().optional().describe('backend override (claude | codex)'),
    }, async ({ ticket, repo, model, backend }) => {
      let text = `start ${repo ? `${repo}#` : ''}${ticket}`
      if (model) text += ` model=${model}`
      if (backend) text += ` backend=${backend}`
      return asText(await daemonCommand(text))
    }),

    tool('cancel', 'Cancel the worker on a ticket. Destructive: confirm with the operator in conversation before this call.', {
      ticket: z.string().regex(/^\d+$/).describe('ticket number'),
    }, async ({ ticket }) => asText(await daemonCommand(`cancel ${ticket}`))),

    tool('attach', 'Get the attach links (timeline + browser terminal) for a live worker.', {
      ticket: z.string().regex(/^\d+$/).describe('ticket number'),
    }, async ({ ticket }) => asText(await daemonCommand(`attach ${ticket}`))),
  ],
})

const ALLOWED_TOOLS = ['mcp__curia__tickets', 'mcp__curia__status', 'mcp__curia__start', 'mcp__curia__cancel', 'mcp__curia__attach']

// ---- the overseer prompt ----------------------------------------------------

const SYSTEM_PROMPT = `You are the curia overseer. Curia is a personal orchestration daemon: it watches GitHub trackers, dispatches AI agent workers on tickets, and keeps the operator in the loop from any device. You are the command brain over its Discord surface.

You speak with one operator, in one Discord thread, in short Discord markdown. You act only through the curia tools. The daemon executes every effect.

What you do:
- Translate the operator's prose into the verbs: tickets, status, start, cancel, attach.
- Answer reasoning questions from tool output ("what should I start next?" — call tickets, then recommend one, with a one-line reason).
- Report tool replies faithfully. Do not invent workers, tickets, or states.

Hard bounds (the never-list):
- Never answer an escalation or a review gate for the operator. If asked to, refuse and say why.
- Cancel is destructive. Confirm in conversation first: state what will be torn down, ask, and call the tool only after the operator says yes in this thread.
- You have no shell, no files, no repo checkout, and no process handles. Do not offer them.
- A failed tool call is not an answer. Report the failure as a failure.

Keep replies short. One thread is one conversation; you will be revived with full memory when the operator writes again.`

// ---- one query() per message ------------------------------------------------

const busy = new Set() // thread ids with a session in flight

async function runTurn(thread, prompt) {
  const resume = sessions.get(thread.id)
  console.log(`[overseer] turn thread=${thread.id} resume=${resume ?? 'fresh'} model=${MODEL}`)
  const t0 = Date.now()
  const q = query({
    prompt,
    options: {
      cwd: HOME,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: CONFIG,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(os.homedir(), '.claude'),
      },
      model: MODEL,
      resume,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { curia },
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit', 'AskUserQuestion'],
      maxTurns: 12,
    },
  })

  let result = null
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      // resume mints a fresh session id for the continued conversation —
      // journal the latest one per thread, last write wins.
      journalSession(thread.id, msg.session_id)
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message.content ?? []) {
        if (block.type === 'tool_use') {
          const args = JSON.stringify(block.input)
          await say(thread, `-# 🔧 ${block.name.replace('mcp__curia__', '')} ${args === '{}' ? '' : args}`)
        }
      }
    }
    if (msg.type === 'result') result = msg
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  if (!result || result.subtype !== 'success') {
    const why = result?.subtype ?? 'no result message'
    await say(thread, `⚠️ session ended without an answer (${why}, ${secs}s)`)
    return
  }
  console.log(`[overseer] done in ${secs}s — ${result.num_turns} turns, $${result.total_cost_usd?.toFixed(4) ?? '?'}`)
  await say(thread, result.result || '(empty answer)')
}

// Discord caps a message at 2000 chars.
async function say(thread, text) {
  for (let i = 0; i < text.length; i += 1900) {
    await thread.send(text.slice(i, i + 1900))
  }
}

// ---- Discord ----------------------------------------------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

client.on(Events.ClientReady, async () => {
  const guild = GUILD_ID ? await client.guilds.fetch(GUILD_ID) : client.guilds.cache.first()
  if (!guild) throw new Error('bot is in no guild')
  const channels = await guild.channels.fetch()
  let channel = channels.find((c) => c?.type === ChannelType.GuildText && c.name === CHANNEL && !c.parentId)
  if (!channel) channel = await guild.channels.create({ name: CHANNEL, type: ChannelType.GuildText })
  console.log(`[overseer] ready: guild=${guild.name} channel=#${channel.name} model=${MODEL} daemon=${DAEMON}`)
})

client.on(Events.MessageCreate, async (m) => {
  try {
    if (m.author.bot) return
    if (!ALLOWED.includes(m.author.id)) return

    let thread = null
    if (m.channel.type === ChannelType.GuildText && m.channel.name === CHANNEL) {
      // Top-level message: open a thread — the grilled session model.
      thread = await m.startThread({ name: m.content.slice(0, 80) || 'overseer', autoArchiveDuration: 10080 })
    } else if (m.channel.isThread() && m.channel.parent?.name === CHANNEL) {
      // Message in an existing overseer thread: revive.
      thread = m.channel
    } else {
      return // not our surface — the daemon's bridge owns everything else
    }

    if (busy.has(thread.id)) {
      await say(thread, '⏳ still on your last message — one turn at a time in this prototype')
      return
    }
    busy.add(thread.id)
    const typing = setInterval(() => thread.sendTyping().catch(() => {}), 8000)
    thread.sendTyping().catch(() => {})
    try {
      await runTurn(thread, m.content)
    } finally {
      clearInterval(typing)
      busy.delete(thread.id)
    }
  } catch (e) {
    console.error('[overseer] message failed:', e)
  }
})

client.login(TOKEN)

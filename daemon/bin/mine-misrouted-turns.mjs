#!/usr/bin/env node
// Read the production journal for the three command-routing questions in #549.
//
// This file has no local imports. The operator can pipe the committed file from
// GitHub into Node without changing the production checkout.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export const DEFAULT_AFTER = '2026-08-01T23:59:59.999Z'

// #255 changed this grammar. Before this time, an existing-map instruction
// needed `--` after the map number. The known 2026-08-06 refusals use the form
// that this rule finds. The journal does not record the deployed Git ref until
// self-deploy arrives, so the commit time is the available boundary.
const MAP_SEPARATOR_RETIRED_AT = '2026-08-10T11:08:42.000Z'

const REPOISH_RE = /^[\w./-]+$/
const CHAT_HANDLE_RE = /^chat-\d+$/
const AGENT_RE = new RegExp(`^(\\d+|${CHAT_HANDLE_RE.source.replace(/^\^|\$$/g, '')})$`)

// Keep this copy aligned with COMMAND_SHAPED in bridge.mjs. This command must
// also run when the operator pipes this one file into Node on the production box.
export const isCommandShaped = (text) =>
  /^\s*(cancel|stop|pause|resume|status|start|map|attach)(?:\s+(all|#?\d+|chat-\d+|[\w.-]+(?:\/[\w.-]+)?#\d+))?(?:\s+(?:model|harness)=[\w.-]+)*\s*[.!?]*\s*$/i.test(text ?? '')

const dropSeparator = (words) => (words[0] === '--' ? words.slice(1) : words)

function parseIssueRef(cmd, rest, { instruction: takesInstruction = false } = {}) {
  if (!rest.length) return null
  let match
  if ((match = rest[0].match(/^(\d+)$/))) {
    cmd.ticket = match[1]
  } else if ((match = rest[0].match(/^([\w.-]+\/[\w.-]+)#(\d+)$/))) {
    cmd.repo = match[1]
    cmd.ticket = match[2]
  } else if ((match = rest[0].match(/^([\w.-]+)#(\d+)$/))) {
    cmd.repoArg = match[1]
    cmd.ticket = match[2]
  } else {
    return null
  }
  const args = rest.slice(1)
  let i = 0
  for (; i < args.length; i += 1) {
    const option = args[i].match(/^model=([\w.-]+)$/)
    if (!option) break
    cmd.model = option[1]
  }
  if (i === args.length) return cmd
  if (!takesInstruction) return null
  const instruction = dropSeparator(args.slice(i)).join(' ').trim()
  if (!instruction) return null
  cmd.instruction = instruction
  return cmd
}

function parseNewMap(rest) {
  if (/^(\d+|[\w.-]+(?:\/[\w.-]+)?#\d+)$/.test(rest[0] ?? '')) return null
  const cmd = { verb: 'map' }
  let i = 0
  for (; i < rest.length; i += 1) {
    const option = rest[i].match(/^model=([\w.-]+)$/)
    if (option) {
      if (cmd.model) return null
      cmd.model = option[1]
      continue
    }
    if (cmd.repoWord || rest[i] === '--') break
    if (/^\d+$/.test(rest[i]) || !REPOISH_RE.test(rest[i])) break
    cmd.repoWord = rest[i]
  }
  const instruction = dropSeparator(rest.slice(i)).join(' ').trim()
  if (!instruction && !cmd.repoWord) return null
  cmd.instruction = instruction
  return cmd
}

// This standalone copy follows parseCommand in commands.mjs. The daemon test
// compares the two copies on every command shape used by this scan.
export function parseCurrentCommand(text) {
  const parts = (text ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const [verb, ...rest] = parts
  switch (verb) {
    case 'tickets':
    case 'next':
      if (!rest.length) return { verb }
      if (rest.length === 1 && REPOISH_RE.test(rest[0]) && !/^\d+$/.test(rest[0])) return { verb, repo: rest[0] }
      return null
    case 'status':
    case 'deploy':
      return rest.length ? null : { verb }
    case 'start':
      return parseIssueRef({ verb }, rest)
    case 'map':
      return parseIssueRef({ verb }, rest, { instruction: true }) ?? parseNewMap(rest)
    case 'cancel':
      if (rest.length !== 1) return null
      if (rest[0] === 'all') return { verb, all: true }
      return AGENT_RE.test(rest[0]) ? { verb, ticket: rest[0] } : null
    case 'resume': {
      if (!rest.length) return null
      if (rest[0] === 'all') return rest.length === 1 ? { verb, all: true } : null
      if (!AGENT_RE.test(rest[0])) return null
      const cmd = { verb, ticket: rest[0] }
      for (const arg of rest.slice(1)) {
        const option = arg.match(/^model=([\w.-]+)$/)
        if (!option) return null
        cmd.model = option[1]
      }
      return cmd
    }
    case 'attach':
      return rest.length === 1 && AGENT_RE.test(rest[0]) ? { verb, ticket: rest[0] } : null
    case 'review': {
      if (!rest.length || !/^\d+$/.test(rest[0])) return null
      const cmd = { verb, ticket: rest[0] }
      for (const arg of rest.slice(1)) {
        const option = arg.match(/^model=([\w.-]+)$/)
        if (!option) return null
        cmd.model = option[1]
      }
      return cmd
    }
    default:
      return null
  }
}

function historicalMapRefusal(text, ts) {
  if (ts >= MAP_SEPARATOR_RETIRED_AT) return false
  const parts = (text ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts[0] !== 'map' || !/^\d+$/.test(parts[1] ?? '')) return false
  const tail = parts.slice(2)
  if (!tail.length || tail.includes('--')) return false
  return tail.some((part) => !/^model=[\w.-]+$/.test(part))
}

function commandRefusal(event) {
  if (historicalMapRefusal(event.canonical, event.ts)) return 'the historical map parser required --'
  if (!parseCurrentCommand(event.canonical)) return 'the current parser refuses this line'
  return null
}

function eventFrom(row) {
  const event = JSON.parse(row.body)
  return { ...event, id: Number(row.id), ts: String(row.ts), type: String(row.type) }
}

export function scanRows(rows, { after = DEFAULT_AFTER } = {}) {
  const refusedCommands = []
  const typedVerbThreads = []
  const commandShapedNotes = []
  const unavailable = { commandReplies: 0, earlyThreadPrompts: 0, refusedNoteTexts: 0 }
  const sessions = new Set()
  const started = new Set()
  let scanned = 0
  let lastEvent = null

  for (const row of rows) {
    const event = eventFrom(row)
    if (!lastEvent || event.id > lastEvent.id) lastEvent = { id: event.id, ts: event.ts }

    if (event.type === 'overseer_session') sessions.add(String(event.thread_id ?? ''))
    if (event.type === 'overseer_session' && event.ts > after && !started.has(String(event.thread_id ?? ''))) {
      unavailable.earlyThreadPrompts += 1
    }

    if (event.type === 'overseer_turn_started') {
      const key = String(event.key ?? '')
      const thread = String(event.thread_id ?? '')
      const opensThread = Boolean(thread) && !sessions.has(thread) && !started.has(key)
      started.add(key)
      if (event.ts > after && opensThread && parseCurrentCommand(event.prompt)) {
        typedVerbThreads.push({ id: event.id, ts: event.ts, thread_id: thread, prompt: event.prompt })
      }
    }

    if (event.ts <= after) continue
    scanned += 1

    if (event.type === 'command') {
      unavailable.commandReplies += 1
      const reason = commandRefusal(event)
      if (reason) {
        refusedCommands.push({ id: event.id, ts: event.ts, by: event.by ?? null, canonical: event.canonical, reason })
      }
    }

    if (event.type === 'agent_note' && !event.handoff_for && !event.label && isCommandShaped(event.text)) {
      commandShapedNotes.push({
        id: event.id, ts: event.ts, agent: event.agent ?? event.worker ?? null,
        by: event.by ?? null, text: event.text,
      })
    }

    if (event.type === 'agent_note_refused') unavailable.refusedNoteTexts += 1
  }

  return { after, scanned, lastEvent, refusedCommands, typedVerbThreads, commandShapedNotes, unavailable }
}

export function readRows(file) {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    database.exec('pragma query_only = on')
    return database.prepare([
      'select id, ts, type, body from events',
      "where type in ('command', 'overseer_session', 'overseer_turn_started', 'agent_note', 'agent_note_refused')",
      'order by id',
    ].join(' ')).all()
  } finally {
    database.close()
  }
}

function jsonLines(items) {
  return items.length ? items.map((item) => JSON.stringify(item)) : ['<none>']
}

export function formatReport(result) {
  const lines = [
    '## Production journal scan',
    '',
    `Cutoff: ${result.after}`,
    `Relevant rows after the cutoff: ${result.scanned}`,
    `Last relevant row: ${result.lastEvent ? `${result.lastEvent.id} at ${result.lastEvent.ts}` : '<none>'}`,
    '',
    '### Refused commands',
    '',
    '```jsonl',
    ...jsonLines(result.refusedCommands),
    '```',
    '',
    '### Threads opened by typed verbs',
    '',
    '```jsonl',
    ...jsonLines(result.typedVerbThreads),
    '```',
    '',
    '### Command-shaped notes',
    '',
    '```jsonl',
    ...jsonLines(result.commandShapedNotes),
    '```',
    '',
    '### Data limits',
    '',
    `- The journal stores ${result.unavailable.commandReplies} command inputs without their replies. Semantic refusals are unavailable.`,
    '- Historical map refusals use the grammar change commit time. Early rows store no deployed Git ref.',
    `- ${result.unavailable.earlyThreadPrompts} early overseer sessions have no stored prompt. Their typed verbs are unavailable.`,
    `- ${result.unavailable.refusedNoteTexts} refused agent notes have no stored text. Their command shape is unavailable.`,
  ]
  return `${lines.join('\n')}\n`
}

function option(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1] ?? null
}

export function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node daemon/bin/mine-misrouted-turns.mjs [--db PATH] [--after ISO_TIME]\n')
    return
  }
  const file = path.resolve(process.cwd(), option('db') ?? 'daemon/data/events.db')
  const after = option('after') ?? DEFAULT_AFTER
  process.stdout.write(formatReport(scanRows(readRows(file), { after })))
}

const direct = process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
if (direct) main()

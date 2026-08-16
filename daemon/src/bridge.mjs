// Discord bridge module (#31) — thin rendering + capture, no interpretation (#18).
//
// Owns: gateway connection, Alp-user-ID auth gate, ticket-thread rendering,
// button/reply capture, image passthrough both directions, the static
// slash-command manifest. Owns NO state: escalation truth and the
// ticket→thread bindings (#93) live in the daemon's EscalationStore, reached
// through the injected `bindings` seam — the thread rename is display only.
//
// The one-channel discipline (#89, built by #93): #curia holds everything.
// Slash commands and daemon announcements stay top-level; top-level prose
// opens a fresh thread, and every thread is one persistent overseer session.
// A reply in a thread feeds an open escalation first, otherwise the session.
//
// The daemon hands in a `handlers` object and calls back into the bridge to
// render; answers flow bridge → handlers.answer → store (first-valid-wins).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  Client, Events, GatewayIntentBits, ChannelType, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js'
import { isChatHandle } from './attach.mjs'
import { safeLeaf } from './images.mjs'
import { REVIEW_KIND, CROSS_CHECK_ANSWER, ALL_AS_RECOMMENDED } from './lifecycle.mjs'
import { CONFIRM_KIND } from './store.mjs'
import { chunkMessage, smallPrint, elapsedLabel } from './messaging.mjs'
import { ThreadRenamer } from './threadname.mjs'

const MAX_BUTTON_OPTIONS = 23 // 25 buttons max, minus cancel; keep rows tidy

// The long-choice surface (#431, on the #413 map). Above the button cap a
// `choice` card used to drop its buttons, print a numbered list and ask for a
// typed reply — the worst answer surface the daemon has on a phone (#414). A
// string select menu takes that case back to one tap.
//
// The numbers are Discord's, not ours. One menu holds 25 options, and a message
// holds five component rows. Four rows carry menus and the fifth stays free for
// the surface link buttons (#108 item 22) that ride every card, so the menu
// reaches 100 options. A list longer than that keeps the numbered list, because
// a card that silently drops option 101 is worse than a card that scrolls.
export const MAX_SELECT_OPTIONS = 25
export const MAX_SELECT_MENUS = 4
export const MAX_SELECT_TOTAL = MAX_SELECT_OPTIONS * MAX_SELECT_MENUS

// One select option shows a 100-char label and a 100-char description under it.
// An option longer than the label spills its tail into the description, so 200
// chars ride the menu whole. Past that the menu clips, and the body keeps the
// numbered list beside it — an option never loses its words to this component.
const SELECT_LABEL = 100
const SELECT_DESC = 100

// Whether the menu can carry this list at all, and whether it can carry it
// unclipped. Two separate questions: the first picks the component, the second
// picks whether the numbered list stays under it.
export const selectFits = (options) => options.length > MAX_BUTTON_OPTIONS
  && options.length <= MAX_SELECT_TOTAL
export const selectClips = (options) => options.some((o) => String(o).length > SELECT_LABEL + SELECT_DESC)

// The option payload. `value` is the index into `record.options`, the same key
// the `idx` buttons use, so every answer path resolves a pick the one way.
export function selectOption(text, idx) {
  const s = String(text)
  const option = { label: s.slice(0, SELECT_LABEL), value: String(idx) }
  const tail = s.slice(SELECT_LABEL)
  if (tail) option.description = tail.length > SELECT_DESC ? `${tail.slice(0, SELECT_DESC - 1)}…` : tail
  return option
}

// Where each menu starts. One menu says "Pick one"; several say which stretch
// of the list each one holds, because a phone shows one closed menu at a time
// and an unlabeled stack of four says nothing about where option 40 lives.
export function selectPages(options) {
  const pages = []
  for (let start = 0; start < options.length; start += MAX_SELECT_OPTIONS) {
    const slice = options.slice(start, start + MAX_SELECT_OPTIONS)
    const placeholder = options.length > MAX_SELECT_OPTIONS
      ? `Pick one — options ${start + 1}-${start + slice.length}`
      : 'Pick one'
    pages.push({ start, slice, placeholder })
  }
  return pages
}

// The round's one-tap answer (#285, ADR-0005). It rides `free-text` and it is
// pure capture: the press records this word, the agent reads it, and the agent
// applies the recommendations IT wrote. The daemon never reads the prompt and
// never decides what "recommended" meant, which is the no-interpret rule of
// ADR-0005 held exactly where a round would be tempted to break it.
//
// The word itself moved to `lifecycle.mjs` on #374, beside the review gate's
// own literals, because the spawn prompt reads it too now. Re-exported here so
// the button and everything that reads its press keep one import.
export { ALL_AS_RECOMMENDED }

// The signal position of a bound thread's name (#93, #199, #200). The live
// glyphs — states a running agent can hold — are the only ones another state
// may overwrite; ✅ and ⚰️ are terminal and only bindTicket's relabel takes
// them back to 🎫. Candidates for ⏳/🔎 were picked for reading beside 🎫 in
// a phone sidebar; each is one constant, swappable after a live judging round
// like #146's.
const STATE_GLYPHS = { waiting: '⏳', 'awaiting-review': '🔎' }
const LIVE_GLYPH_RE = /^(?:🎫|⏳|🔎)/u

// How long a cleared glyph is held before the rename goes out (#277).
//
// Discord answers every rename with a system line in the thread, and no flag
// suppresses it — 179 of them across the #245 cold read, each repeating a state
// change the status line had already made in the same thread. Renaming less is
// the only lever, and the two directions are not worth the same:
//
//  - ⏳/🔎 ON is written for a reader who is AWAY. It is the whole reason the
//    glyph exists, so it lands at once.
//  - 🎫 OFF lands a moment after the operator answered, so its only reader is
//    the person who just left the thread. It says a thing they already know,
//    and its system line BUMPS that thread to the top of the list — pushing the
//    threads that do need them further down.
//
// So the clear waits, and a fresh question inside the window cancels it: the
// glyph never moves and BOTH renames are saved. A grilling ticket asks many
// questions in one sitting, and every pair that collapses is two system lines
// and two budget slots that the ending rename gets to keep instead — the same
// budget whose exhaustion is why the ✅ used to arrive ten minutes late (#199).
//
// The cost is a false positive, bounded by this window: a thread can read ⏳
// for up to two minutes after it was answered. The operator set the number.
// The wait is ephemeral like every other cache here, so a daemon restart inside
// the window loses the clear and the thread keeps ⏳ until the agent's next
// question or its ending — the ending always settles it.
export const CLEAR_DELAY_MS = 120_000

// #108 item 23, widened by #170: a message that is nothing but a command,
// typed at an agent thread — the shape that reads as "cancel the agent" but
// queues as prose. Trailing punctuation forgiven; any surrounding words mean
// it is a real note.
//
// The argument is what #170 added. A bare `cancel` was detected and
// `cancel 166` was not, so the operator who typed the surface's OWN syntax got
// no hint at all and waited an hour. A false positive here costs one extra
// line under a queued note, so the shape is drawn wide on purpose.
//
// Every argument form the router takes is a form the operator types, so every
// one of them belongs here: the bare number, `all`, the repo-qualified
// `curia#170` and `alp82/curia#170` that `start` accepts (see parseCommand),
// and the trailing `model=` override. The repo-qualified form is
// what this map's own notes tell the operator to type, so missing it repeated
// the exact miss the ticket is about.
//
// `harness=` stays in this shape after #177 removed it from every surface, and
// that is the "drawn wide" rule doing its job: an operator typing it in a thread
// gets the hint that sends them to #curia, where the router names the rule. The
// note queue swallowing it silently is the miss this regex exists to stop.
// `map` joined the alternation with #221, for the reason every other verb is
// here: it is a command now, and a command typed at an agent must not vanish
// into the note queue. Only the bare form matches — a `map <n> <sentence>`,
// with or without the `--` that #255 made optional, runs past the end of this
// shape, and a sentence is what a note IS.
// #241 adds the chat handle (`chat-1`) to the argument alternation, for the
// same reason: it is what `cancel`, `resume` and `attach` take on an agent no
// ticket answers for, so an operator typing it at that agent's own thread must
// get the hint rather than have it queued as prose.
export const COMMAND_SHAPED =
  /^\s*(cancel|stop|pause|resume|status|start|map|attach)(?:\s+(all|#?\d+|chat-\d+|[\w.-]+(?:\/[\w.-]+)?#\d+))?(?:\s+(?:model|harness)=[\w.-]+)*\s*[.!?]*\s*$/i

// The command the operator meant. `stop` and `pause` are not verbs the surface
// has — at an agent, cancel is what they ask for. `status` is the only one
// that takes no ticket.
const MEANT_VERB = { cancel: 'cancel', stop: 'cancel', pause: 'cancel', resume: 'resume', status: 'status', start: 'start', map: 'map', attach: 'attach' }

// The argument the hint names, in the syntax the channel accepts.
//
// The operator's OWN argument wins over the thread's ticket. `cancel 138` typed
// in the ticket-166 thread asks about 138, and the journal shows that exact
// shape — a hint that answers `cancel 166` names the wrong ticket in the one
// line that exists to fix the miss.
//
// What it names must also parse. `start` and `map` are the verbs that take a
// repo-qualified ticket, so `curia#170` survives there and reduces to its
// number for the rest. A leading `#` goes everywhere: `cancel #166` is not a
// command parseCommand accepts. `attach all` is not one either, so that falls
// back to the thread's ticket.
function hintArg(verb, typed, ticket) {
  if (verb === 'status') return ''
  const t = (typed ?? '').trim()
  // `cancel all` and `resume all` parse; `attach all` and `map all` do not, so
  // those fall back to the thread's own ticket rather than name a line the
  // router would refuse.
  if (/^all$/i.test(t)) return (verb === 'attach' || verb === 'map') ? ` ${ticket ?? '<n>'}` : ' all'
  // The repo-qualified form needs a REPO in front of the `#`. `/#\d+$/` also
  // matched a bare `#170`, which no verb parses — found by #221's `map #147`
  // case, and `start #170` had carried it since the hint shipped.
  if ((verb === 'start' || verb === 'map') && /^[\w.-]+(?:\/[\w.-]+)?#\d+$/.test(t)) return ` ${t}`
  return ` ${/(\d+)$/.exec(t)?.[1] ?? ticket ?? '<n>'}`
}

// What to say under a note whose text was a command. The channel is the whole
// point: commands are interpreted there and nowhere else.
export function commandHint(text, ticket, channelId) {
  const m = COMMAND_SHAPED.exec(text ?? '')
  const verb = MEANT_VERB[m?.[1]?.toLowerCase()] ?? 'cancel'
  return `commands run in <#${channelId}>, never in a ticket thread — say \`${verb}${hintArg(verb, m?.[2], ticket)}\` there`
}

// A note that ASKS something (#236). The live miss was "whats taking so long"
// — no question mark anywhere — so a trailing `?` alone is too narrow: a `?`
// anywhere counts, and so does a leading interrogative or auxiliary word.
// Drawn eager on purpose, like COMMAND_SHAPED: the note queues either way
// (point 3 of the ticket), so a false "question" costs one extra status line
// and a miss costs the operator a direct answer they were ruled to get.
export const QUESTION_SHAPED =
  /\?|^\s*(what|whats|why|how|hows|when|whens|where|wheres|who|whos|which|is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had|any)\b/i

// The direct answer curia owes an operator question (#236), composed from
// records and nothing else — the journal, the status line's state machine,
// the dispatch record. No model reads the question: a responder model would
// be the general chat surface the ticket rules out, and records cannot make
// a fact up. The status family is the scope; a question about the work itself
// still rides the queue to the agent, one line below this.
//
// `s` is the facts the daemon gathered (see queueAgentNote in index.mjs):
// { state, spawned_at, esc: {id, title, opened_at}|null, last: {type, ts}|null }.
// Null when a fact is missing drops that fact, never the answer — and no
// state at all returns null, so the receipt stands alone.
export function statusAnswer(owner, s, now = Date.now()) {
  if (!s?.state) return null
  // Blocked on the operator: the one answer where "taking so long" has a
  // cause with a name. The title is already promptTitle-cut at esc_open.
  if ((s.state === 'waiting' || s.state === 'awaiting-review') && s.esc) {
    const waited = s.esc.opened_at ? elapsedLabel(s.esc.opened_at, now) : null
    const what = s.state === 'waiting'
      ? `is waiting on **[${s.esc.id}]**${s.esc.title ? ` — ${s.esc.title}` : ''}`
      : `awaits review on **[${s.esc.id}]**`
    return `⏳ \`${owner}\` ${what}${waited ? ` (${waited} now)` : ''} — it does nothing until that is answered.`
  }
  const verb = {
    dispatched: 'is starting — no composer yet',
    working: 'is working',
    'cross-checking': 'is idle while a cross-check reads its diff',
    executing: 'is executing approved writes',
    resolving: 'is resolving the ticket',
    stalled: 'stalled before its composer',
  }[s.state] ?? `is ${s.state}`
  const since = s.spawned_at ? elapsedLabel(s.spawned_at, now) : null
  const last = s.last ? elapsedLabel(s.last.ts, now) : null
  const facts = [
    since ? `dispatched ${since} ago` : null,
    last ? `last journal event \`${s.last.type}\`, ${last} ago` : null,
  ].filter(Boolean)
  return `▶️ \`${owner}\` ${verb}${facts.length ? ` — ${facts.join(', ')}` : ''}.`
}

// The whole reply under a queued note, as lines. Pure, and exported, because
// the two facts it carries are the ones #170 got wrong: WHETHER anything reads
// the note, and where the operator's words would have been a command.
//
// `q.reads === false` is positive evidence the agent is not running — the
// early exit (#169), the ready timeout, the result-less exit. Nothing queues
// then (#208): words typed at an agent die with that agent, so a dead one is
// the end of them, and the line says that rather than promising a successor
// will read them. The #139 hand-off is the one note that does cross, and it
// comes from the daemon, not from this surface. Anything else keeps the old
// promise.
// #236 put the direct answer FIRST: an operator question got only the queue
// receipt — honest and useless — so a question-shaped note now opens with what
// curia's records say, and the receipt becomes the second line. The note still
// queues (a question about the work itself is the agent's to answer), and a
// dead agent keeps its one line — "NOT running" already IS the direct answer.
export function queuedNoteReply({ owner, q, text, channelId, now = Date.now() }) {
  const lines = []
  if (q.reads !== false && q.status && QUESTION_SHAPED.test(text ?? '')) {
    const answer = statusAnswer(owner, q.status, now)
    if (answer) lines.push(answer)
  }
  lines.push(
    q.reads === false
      ? `\`${owner}\` is NOT running, so nothing was queued: these words reached nobody. Start a fresh agent with \`resume ${q.ticket ?? '<n>'}\`, then say them again.`
      : `queued for \`${owner}\` — it reads this with its next tool result${q.after ? ` (noted as after ${q.after})` : ''}`,
  )
  if (COMMAND_SHAPED.test(text ?? '')) lines.push(commandHint(text, q.ticket, channelId))
  return lines
}

// The two delivery modes, on the receipt (#252, ADR-0013). Queued is the
// default and is fire-and-forget: the words ride the agent's next tool result,
// and no drain receipt follows, because a second small-print line saying "it
// read them" states nothing the operator can act on. The button IS the other
// mode — an operator who wants a reply presses it, and the words go into the
// pane as a user turn instead.
//
// The label is "Ask now", the operator's own pick. "Interrupt" was the first
// wording and it was wrong on the surface that matters: it reads as "end this
// agent", which is the one thing no button does any more (#200). The press asks
// a question and gets an answer, so the label says that. ADR-0013 keeps the word
// interrupt for the MECHANICS, and so do the code and the journal.
//
// The button rides the receipt rather than a message of its own, so one note
// makes one message. No button on a dead agent's receipt: nothing queued, so
// there is nothing to ask. No button on a note with no id either — every note
// journalled before #252 has none, and Discord keeps an old button pressable
// forever (#200's lesson).
export const noteInterruptId = (noteId) => `note|${noteId}|interrupt`

export function interruptRow(noteId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(noteInterruptId(noteId)).setLabel('⚙️ Ask now').setStyle(ButtonStyle.Secondary),
  )]
}

// The whole receipt, text and button together — pure and exported for the
// reason queuedNoteReply is: this one message is the operator's only surface
// for the choice between the two modes, and the choice must be checkable
// without a live gateway.
export function noteReceipt({ owner, q, text, channelId, now = Date.now() }) {
  return {
    content: smallPrint(queuedNoteReply({ owner, q, text, channelId, now }).join('\n')),
    components: q.reads === false || !q.id ? [] : interruptRow(q.id),
  }
}

// What the receipt becomes once the button is pressed. The press is recorded on
// the receipt itself, in place, and the button goes — the same rule the
// escalation card lives under (ADR-0013: the card is the only record). No
// CuriaBot line states the outcome, because the outcome is the agent's reply,
// in the agent's own voice.
export function interruptedReceipt(content, { by, session, graceMs }) {
  const secs = Math.max(1, Math.round(graceMs / 1000))
  return `${content}\n${smallPrint(`⚙️ <@${by}> asked for this now — \`${session}\` gets ${secs}s to finish its tool call, then these words go in as a user turn. Its reply is the answer.`)}`
}

// #81's grown catalogue — a static macro manifest; expansion only, never
// interpretation. `tickets` renames `frontier` on the command surface.
const SLASH_MANIFEST = [
  new SlashCommandBuilder().setName('tickets').setDescription('List takeable tickets')
    .addStringOption((o) => o.setName('repo').setDescription('Limit to one repo (any unambiguous part of the name)')),
  new SlashCommandBuilder().setName('next').setDescription('Dispatch the next takeable ticket')
    .addStringOption((o) => o.setName('repo').setDescription('Limit to one repo (any unambiguous part of the name)')),
  new SlashCommandBuilder().setName('status').setDescription('Agents running, waiting on input, and recent endings'),
  new SlashCommandBuilder().setName('start').setDescription('Dispatch an agent on a ticket, or on a map\'s next takeable ticket')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number, or a map number for its next ticket').setRequired(true))
    // #177 removed the `harness` option: the harness follows the model, so the
    // only values this could carry were a no-op or a broken spawn.
    // #221 removed `instruction`: `start` no longer charts, so it carries no
    // sentence. A stale client-side manifest can still SEND one (#65), and the
    // expansion drops it — see expandCommand.
    .addStringOption((o) => o.setName('model').setDescription('Model override')),
  // #221: charting's own verb, in the operator's own word. `instruction` stays
  // optional, so a dispatch with no sentence opens with the "what should
  // change?" escalation (#160) instead of being refused at the client.
  // #241: `ticket` is no longer required. With one, this charts an existing
  // map. Without one, `instruction` alone charts a NEW map — the agent settles
  // the destination with the operator and creates the issue itself. Exactly one
  // of the two must be present, and the expansion says which is missing.
  new SlashCommandBuilder().setName('map').setDescription('Dispatch a charting agent on a map, or on no map yet')
    .addStringOption((o) => o.setName('ticket').setDescription('Map number — leave empty to chart a NEW map'))
    .addStringOption((o) => o.setName('instruction').setDescription('What should change on the map — or, with no map number, what to chart'))
    .addStringOption((o) => o.setName('repo').setDescription('Which repo a NEW map is charted in (only needed when more than one is watched)'))
    .addStringOption((o) => o.setName('model').setDescription('Model override')),
  new SlashCommandBuilder().setName('cancel').setDescription('Cancel a running ticket, or all of them')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number, or "all"').setRequired(true)),
  new SlashCommandBuilder().setName('resume').setDescription('Fresh agent on a ticket, inheriting its worktree, its model and your answers')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number, or "all"').setRequired(true))
    // #177: resume inherits the model of the dead agent, and this is the way
    // out. `resume all` ignores it — see parseCommand.
    .addStringOption((o) => o.setName('model').setDescription('Model override — otherwise the model the dead agent ran on')),
  new SlashCommandBuilder().setName('attach').setDescription('Get the attach handle for a live session')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number').setRequired(true)),
  // #270: self-deploy. Typed-only — the overseer composes no `deploy`, so the
  // slash verb and POST /command are the whole calling surface.
  new SlashCommandBuilder().setName('deploy').setDescription('Fast-forward to origin/main, rebuild, restart curia — rolls back on a failed health check'),
]

// Macro-expansion only — this never interprets (#18). Returns the canonical
// text, or `{ error }` for something the expansion itself can see is wrong.
//
// A missing option must NOT be interpolated. `${opt('ticket')}` stringifies an
// absent option to the literal "null", which relayed `start null` into the
// router and came back as an unhelpful parse failure — the option is declared
// required, so an absent one means the client sent a command shape we did not
// register (a stale client-side manifest, verified live from the phone), and
// that deserves to be said out loud rather than turned into a fake ticket id.
// Same rule as everywhere else in the daemon: a missing read is not a value.
// Exported for the same reason queuedNoteReply is: this is the phone's only
// command surface (see missingOptionReply), and a pure expansion deserves a
// test that does not need a live gateway.
export function expandCommand(i) {
  const opt = (name) => i.options.getString(name)
  const need = (name) => {
    const v = opt(name)
    return v == null || v === '' ? null : v
  }
  switch (i.commandName) {
    // `frontier` is the pre-#81 name — a client with a stale manifest (#65)
    // still sends it, and the expansion is the right layer to translate
    case 'frontier':
    case 'tickets': return `tickets${opt('repo') ? ' ' + opt('repo') : ''}`
    case 'next': return `next${opt('repo') ? ' ' + opt('repo') : ''}`
    case 'status': return 'status'
    case 'deploy': return 'deploy'
    // #221: `start` takes no instruction any more. A stale client-side manifest
    // still sends the option, and putting it back into the canonical text would
    // expand to a line the router refuses — so it is dropped here, exactly as
    // #177 drops `harness`.
    case 'start': {
      const ticket = need('ticket')
      if (!ticket) return { error: 'missing' }
      return `start ${ticket}${opt('model') ? ' model=' + opt('model') : ''}`
    }
    case 'map': {
      const ticket = need('ticket')
      // The instruction rides LAST (#160), and its whitespace is collapsed for
      // the same reason canonicalFor collapses it: this line is one line, and
      // the router splits it on whitespace. This is still expansion, not
      // interpretation — the text is passed through, and whether the issue is a
      // map is the dispatcher's ruling. #255 retired the `--` that used to mark
      // where the sentence starts, so nothing separates them any more.
      const instruction = (need('instruction') ?? '').replace(/\s+/g, ' ').trim()
      // #241: no map number means the NEW-map shape, which needs the sentence.
      // A `/map` carrying neither is the one shape no dispatcher can read, so
      // it is refused HERE, naming both — the expansion can see it is wrong
      // without interpreting anything.
      if (!ticket) {
        if (!instruction) return { error: 'map-shape' }
        const repo = need('repo')
        return `map${repo ? ' ' + repo : ''}${opt('model') ? ' model=' + opt('model') : ''} ${instruction}`
      }
      return `map ${ticket}`
        + (opt('model') ? ' model=' + opt('model') : '')
        + (instruction ? ` ${instruction}` : '')
    }
    // #177: `resume all model=x` is not a command the router takes, so the
    // option is dropped on the bulk form rather than expanded into a refusal.
    case 'resume': {
      const ticket = need('ticket')
      if (!ticket) return { error: 'missing' }
      const model = ticket === 'all' ? null : opt('model')
      return `resume ${ticket}${model ? ' model=' + model : ''}`
    }
    case 'cancel':
    case 'attach': {
      const ticket = need('ticket')
      if (!ticket) return { error: 'missing' }
      return `${i.commandName} ${ticket}`
    }
    default: return null
  }
}

// `/map` with neither a map number nor a sentence (#241). This is NOT the stale
// manifest of missingOptionReply below: both options are optional now, and the
// client sent exactly what it was told it could send. So the reply teaches the
// two shapes instead of telling the operator to restart Discord.
const MAP_SHAPE_REPLY = [
  '❌ `/map` needs a **ticket**, an **instruction**, or both.',
  '',
  '• **ticket** alone — chart that existing map, and the agent asks what should change.',
  '• **ticket** + **instruction** — chart that existing map, with your sentence as the brief.',
  '• **instruction** alone — chart a **NEW** map: the agent settles the destination and the scope',
  '  with you, then creates the `wayfinder:map` issue itself. Add **repo** when more than one is watched.',
].join('\n')

function missingOptionReply(commandName) {
  return [
    `❌ \`/${commandName}\` arrived with no **ticket** — the option is required, so your Discord client is`,
    'using a stale copy of the command list.',
    '',
    `Fix: fully close and reopen Discord (mobile: swipe the app away), then run \`/${commandName}\` again — the`,
    'ticket field should appear as a required prompt.',
    '',
    '_There is no plain-text fallback from a phone: a channel message is only ever read as an answer to',
    "an open escalation, so the slash manifest is the phone's only command surface._",
  ].join('\n')
}

export class DiscordBridge {
  // onHealth({state, previous, down_ms, reason, error}) — the daemon journals it
  // and decides whether to say it out loud (#56).
  // bindings: { get(ticket), bind(ticket, threadId), release(ticket, reason) }
  // — the store's journalled ticket↔thread map (#93). Absent (tests), threads
  // fall back to the name-based lookup only.
  // `clearDelayMs` / `timers` are the seam for #277's held clear — production
  // never overrides them, and 0 means clear in the same call.
  constructor({
    token, allowedUsers, guildId, channelName = 'curia', dataDir, handlers, bindings = null,
    log = console.log, onHealth = () => {},
    clearDelayMs = CLEAR_DELAY_MS, timers = { set: setTimeout, clear: clearTimeout },
  }) {
    this.token = token
    this.allowedUsers = allowedUsers // array of user-id strings; the auth gate
    this.guildId = guildId
    this.channelName = channelName
    this.dataDir = dataDir
    this.handlers = handlers
    this.bindings = bindings
    this.log = log
    this.onHealth = onHealth
    this.threadByName = new Map() // ephemeral cache for UNBOUND threads ('all'), rebuilt on demand
    this.threadWork = new Map() // ticket -> the in-flight thread resolution for it (#257)
    this.clearDelayMs = clearDelayMs
    this.timers = timers
    this.flagClears = new Map() // ticket -> the held 🎫 clear (#277), ephemeral
    // Bridge health (#56). Ephemeral like every other cache here: the journal
    // holds the transitions, this holds only what is true right now.
    this.health = { state: 'down', since: Date.now(), last_error: null }
    this.unhealthySince = null
    // Speaker identities (#143): `ok` is null until the start probe answers.
    this.speakers = { ok: null, reason: null }
    this.speakerNoticed = false
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    })
    // Installed at CONSTRUCTION, not after login: an unhandled 'error' on the
    // Client is fatal exactly like the raw-socket one, and login itself is when
    // the gateway can first fail. This does not catch #56's crash (that error is
    // emitted one layer below, on the ws socket — see health.mjs), so it is
    // hygiene rather than the fix.
    this.client.on(Events.Error, (e) => this.#onError('client', e))
    this.client.on(Events.ShardError, (e, id) => this.#onError(`shard ${id}`, e))
    // Every rename goes through the one budget-aware gate (#199). Creating a
    // thread WITH a name spends nothing (measured), so only setName routes here.
    this.renamer = new ThreadRenamer({
      log: this.log,
      apply: async (threadId, name) => {
        const t = await this.client.channels.fetch(threadId).catch(() => null)
        if (!t || t.name === name) return false
        await t.setName(name)
        return true
      },
    })
  }

  authorized(userId) {
    return this.allowedUsers.includes(userId)
  }

  async start() {
    await this.client.login(this.token)
    await new Promise((res) => this.client.once('clientReady', res))
    this.guild = this.guildId
      ? await this.client.guilds.fetch(this.guildId)
      : this.client.guilds.cache.first()
    if (!this.guild) throw new Error('bot is in no guild')
    this.channel = await this.#ensureChannel(this.channelName)
    await this.#registerSlashCommands()
    this.client.on('interactionCreate', (i) => this.handleInteraction(i).catch((e) => this.log('interaction error', e)))
    this.client.on('messageCreate', (m) => this.#onMessage(m).catch((e) => this.log('message error', e)))
    this.#watchGateway()
    this.#setHealth('up', { reason: 'ready' })
    this.log(`[bridge] ready: guild=${this.guild.name} channel=#${this.channel.name}`)
    // Last, and after health is up: the probe announces in the channel, which
    // needs a bridge that works. It never fails a start.
    await this.probeSpeakers()
  }

  async stop() {
    this.#setHealth('down', { reason: 'stopped' })
    for (const t of this.flagClears.values()) this.timers.clear(t)
    this.flagClears.clear()
    this.renamer.stop()
    await this.client.destroy()
  }

  // ---- health (#56) --------------------------------------------------------
  //
  // A bridge that is quietly down is worse than one that crashed, because
  // Discord is the phone's only surface: nothing else tells Alp that answers are
  // not arriving. So every transition is journalled, `/state` carries the live
  // value, and the daemon announces the outage IN THE CHANNEL once the channel
  // works again — which is the earliest moment any announcement can be made.
  #watchGateway() {
    this.client.on(Events.ShardDisconnect, (event, id) =>
      this.#setHealth('degraded', { reason: `shard ${id} disconnected (code ${event?.code ?? '?'})` }))
    this.client.on(Events.ShardReconnecting, (id) =>
      this.#setHealth('degraded', { reason: `shard ${id} reconnecting` }))
    this.client.on(Events.ShardResume, (id) => this.#setHealth('up', { reason: `shard ${id} resumed` }))
    this.client.on(Events.ShardReady, (id) => this.#setHealth('up', { reason: `shard ${id} ready` }))
    // Invalidated is NOT transient: the session is gone and this client will
    // never reconnect on its own.
    this.client.on(Events.Invalidated, () => this.#setHealth('down', { reason: 'session invalidated' }))
  }

  #onError(where, e) {
    this.health.last_error = `${where}: ${e?.message ?? String(e)}`
    this.log(`[bridge] ${where} error: ${e?.message ?? e}`)
    this.onHealth({ state: this.health.state, previous: this.health.state, down_ms: 0, reason: `${where} error`, error: e?.message ?? String(e) })
  }

  #setHealth(state, { reason }) {
    const previous = this.health.state
    if (previous === state) return
    const now = Date.now()
    if (previous === 'up') this.unhealthySince = now
    const down_ms = state === 'up' && this.unhealthySince ? now - this.unhealthySince : 0
    if (state === 'up') this.unhealthySince = null
    this.health = { state, since: now, last_error: this.health.last_error }
    this.log(`[bridge] ${previous} → ${state} (${reason})`)
    this.onHealth({ state, previous, down_ms, reason, error: this.health.last_error })
  }

  status() {
    return {
      state: this.health.state,
      since: new Date(this.health.since).toISOString(),
      unhealthy_for_s: this.unhealthySince ? Math.round((Date.now() - this.unhealthySince) / 1000) : 0,
      last_error: this.health.last_error,
      // #143: the channel says it once, `/state` says it whenever asked.
      speakers: this.speakers,
    }
  }

  // A plain channel line, not a thread line: an outage is about the bridge, not
  // about one ticket.
  async announce(text) {
    if (!this.channel) throw new Error('no channel yet')
    await this.#sendChunked(this.channel, { content: text })
  }

  // Top-level channel, no category parent — dodges the permission-overwrite
  // quirk that hid threads from the bot in the pre-configured guild (#22).
  async #ensureChannel(name) {
    const channels = await this.guild.channels.fetch()
    const existing = channels.find((c) => c?.type === ChannelType.GuildText && c.name === name && !c.parentId)
    if (existing) return existing
    return this.guild.channels.create({ name, type: ChannelType.GuildText })
  }

  async #registerSlashCommands() {
    const rest = new REST().setToken(this.token)
    await rest.put(
      Routes.applicationGuildCommands(this.client.user.id, this.guild.id),
      { body: SLASH_MANIFEST.map((c) => c.toJSON()) },
    )
  }

  // The ticket label as a thread rename (#93): `🎫 85 · curia · grilling`. The
  // ticket number, the repo, and the `wayfinder:` type REPLACE whatever the
  // thread was called — a thread list that reads "which ticket, where, what
  // kind of work" is worth more than the prose title the conversation started
  // under. The repo field (#235): one number space serves four watched repos,
  // so `🎫 85` alone names no tracker. Short name only, no owner prefix — the
  // operator ruled the form. Display only — the journal binding is the truth —
  // so every half tolerates a rename that never landed or that someone edited
  // by hand.
  static labelName(ticket, type = '', repo = '') {
    const short = repo ? String(repo).split('/').pop() : ''
    return `🎫 ${ticket}${short ? ` · ${short}` : ''}${type ? ` · ${type}` : ''}`.slice(0, 100)
  }

  // Release swaps the signal and keeps the rest: `🎫 85 · grilling` becomes
  // `✅ 85 · grilling`. The finished ticket stays readable in the thread list
  // instead of falling back to a name that no longer says what happened.
  //
  // The signal position holds a FAMILY now (#199): 🎫 running, ⏳ waiting on
  // the operator, 🔎 holding a review gate open — the live glyphs — and the
  // terminal ✅ / ⚰️. Release and cancel swap ANY live glyph, because a ticket
  // can finish or be torn down mid-question, and a guard that only knew 🎫
  // would leave ⏳ on a thread nothing will ever clear.
  static doneName(name) {
    return name.replace(LIVE_GLYPH_RE, '✅')
  }

  // A cancel swaps the same signal for ⚰️ — the agent was torn down (#200).
  // ✅ would be a lie (nothing finished) and 🎫 was the whole complaint: a
  // cancelled ticket read exactly like a running one in the thread list. The
  // BINDING stays (#140), so a later dispatch takes the same thread back and
  // labelName puts 🎫 on it again.
  static cancelledName(name) {
    return name.replace(LIVE_GLYPH_RE, '⚰️')
  }

  // The agent's state, on the signal position of the thread NAME (#199): the
  // thread list says who is blocked without a message opened. Same vocabulary
  // as the status line — ⏳ waiting, 🔎 awaiting review — and 🎫 is "nobody is
  // blocked on you". Display only, like every rename here: it swaps a live
  // glyph and touches nothing else, so a released ✅, a ⚰️, or a hand-edited
  // name is left alone. The blocked glyphs ride the renamer's reserve rule —
  // they spend a slot only while a second stays free for the clear.
  //
  // #277 splits the two directions in time. Putting a glyph ON happens here and
  // now; taking it OFF is HELD for CLEAR_DELAY_MS, and any flag arriving inside
  // that window replaces the held one. A question that lands before the wait
  // runs out therefore finds the name it wants already on the thread, so the
  // whole pair costs nothing. See CLEAR_DELAY_MS for why the asymmetry points
  // this way.
  async flagTicket(ticket, state) {
    if (!this.bindings) return
    // Whatever was held is stale now: a newer flag has an opinion. Dropped for
    // an ON as well as an OFF, so an answered-then-asked-again ticket never
    // wakes a timer that would clear the glyph it just put back.
    const held = this.flagClears.get(String(ticket))
    if (held) { this.timers.clear(held); this.flagClears.delete(String(ticket)) }
    if (STATE_GLYPHS[state] || !this.clearDelayMs) return this.#applyFlag(ticket, state)
    // The held clear re-enters through the front door, so every guard below is
    // re-read against the state at the moment it lands, not the moment it was
    // asked for. A ticket released, cancelled or re-flagged meanwhile dissolves
    // it — the same way a stale flag already dissolves on a terminal name.
    //
    // The callback RETURNS its promise. setTimeout drops the value, but a test
    // clock can await it, which is the only way a held rename is assertable.
    const timer = this.timers.set(() => {
      this.flagClears.delete(String(ticket))
      return Promise.resolve(this.#applyFlag(ticket, state)).catch((e) => {
        this.log(`held thread flag for ${ticket} failed: ${e.message}`)
      })
    }, this.clearDelayMs)
    timer?.unref?.()
    this.flagClears.set(String(ticket), timer)
  }

  // Drop a held clear outright: the ticket has reached a name no clear may
  // touch. The guards in #applyFlag already make a late clear a no-op, so this
  // is about not holding a timer for a thread that is done.
  #dropHeldFlag(ticket) {
    const held = this.flagClears.get(String(ticket))
    if (!held) return
    this.timers.clear(held)
    this.flagClears.delete(String(ticket))
  }

  async #applyFlag(ticket, state) {
    if (!this.bindings) return
    const bound = this.bindings.get(ticket)
    if (!bound) return
    const t = await this.client.channels.fetch(bound).catch(() => null)
    // The binding is re-checked AFTER the fetch: a release that landed during
    // the await has dropped it, and a flag written past that point would put a
    // live glyph back on a finished thread.
    if (!t || !this.bindings.get(ticket)) return
    // The base is the renamer's pending name, not the name Discord shows — the
    // shown name lags whenever a rename is deferred (#199's budget), and a
    // swap computed on the lagging name resurrects a glyph the gate already
    // replaced. LIVE_GLYPH_RE misses ✅/⚰️ on purpose, so a flag that loses
    // the race to release finds the terminal name here and dissolves.
    const base = this.renamer.desired(t.id) ?? t.name
    if (!LIVE_GLYPH_RE.test(base)) return
    const glyph = STATE_GLYPHS[state] ?? '🎫'
    const name = base.replace(LIVE_GLYPH_RE, glyph)
    if (name === base) return
    await this.renamer.set(t.id, name, { reserve: glyph !== '🎫' })
  }

  // One thread per ticket needs ONE thread-resolving path per ticket at a time
  // (#257). Every path here reads the binding, then awaits a Discord round
  // trip, then creates — so two callers that both read "unbound" both created,
  // and each one's bind refused the other's. That is the three "🎫 173" threads
  // born within 600 ms on 2026-08-05: a notify and two escalations racing the
  // same lazy open. This chain makes read-then-create atomic per ticket, and a
  // busy ticket never holds up a different one.
  //
  // The chain never rejects, and it deletes itself once it is the tail, so a
  // long-lived bridge does not accumulate one entry per ticket it ever saw.
  #perTicket(ticket, fn) {
    const key = String(ticket)
    const prev = this.threadWork.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(() => {}, () => {}).then(() => {
      if (this.threadWork.get(key) === tail) this.threadWork.delete(key)
    })
    this.threadWork.set(key, tail)
    return run
  }

  // A name curia BINDS a thread to: an issue number, or a chat handle — the
  // identity of an agent no issue answers for (#241). Anything else is a
  // pseudo-ticket ('all') with no binding of its own.
  static bindable(ticket) {
    const t = String(ticket)
    return /^\d+$/.test(t) || isChatHandle(t)
  }

  // The thread a ticket's traffic lands in (#93): the journalled binding first.
  // An unbound ticket gets a fresh thread, bound on creation — that is the
  // "autonomous dispatch opens and binds a fresh thread" leg of #89, reached
  // lazily by whichever notify or escalation speaks first. Pseudo-tickets with
  // no binding seam ('all', tests without `bindings`) keep the old name-based
  // lookup so bulk confirms still share one thread.
  //
  // #326: the shape test was digits-only, so a new-map session — `chat-1`, not
  // a number — fell through to the name-based lookup and got a thread called
  // `ticket-chat-1`. The dispatch had already taken over the conversation
  // thread and renamed it, so charting a map through the overseer ended with
  // two threads: the renamed conversation, and a second one carrying every
  // line the agent said. The binding is the answer for a handle exactly as it
  // is for a number.
  ensureThread(ticket) {
    if (!this.bindings || !DiscordBridge.bindable(ticket)) return this.#namedThread(`ticket-${ticket}`)
    return this.#perTicket(ticket, () => this.#ensureThread(ticket))
  }

  async #ensureThread(ticket) {
    const bound = this.bindings.get(ticket)
    if (bound) {
      const t = await this.client.channels.fetch(bound).catch(() => null)
      if (t) {
        if (t.archived) await t.setArchived(false).catch(() => {})
        return t
      }
      // The bound thread is gone from Discord. The journal is the truth, but a
      // deleted thread can carry no traffic — release and fall through.
      this.bindings.release(ticket, 'thread-gone')
    }
    // The dispatch backstop (#140), now on the lazy path too (#257). The two
    // paths disagreed: a dispatch went back to the ticket's last thread, a
    // notify or escalation opened a second one. So every ticket worked twice
    // ended with a thread per run — #147 collected four that way.
    //
    // The name is left as it is. This path knows no ticket type, so relabeling
    // would drop the type field, and a late line after an ending must never put
    // a live glyph back on a finished thread.
    const revived = await this.#reviveLastThread(ticket, '', '', { relabel: false })
    if (revived) return revived
    const thread = await this.channel.threads.create({
      name: DiscordBridge.labelName(ticket, '', this.#repoOf(ticket)), autoArchiveDuration: 10080,
    })
    const r = this.bindings.bind(ticket, thread.id)
    if (!r.ok && r.threadId) {
      // lost a race: another path bound this ticket between the read and here
      const winner = await this.client.channels.fetch(r.threadId).catch(() => null)
      // The thread just opened carries nothing and would stand in the list as a
      // twin of the winner. Delete it (#257) — leaving it is how the duplicates
      // in the history got there.
      if (winner) {
        await thread.delete().catch(() => {})
        return winner
      }
    }
    return thread
  }

  // The repo behind a ticket number, for the label's repo field (#235). From
  // curia's own record — the journal's dispatch/spawn lines, indexed by the
  // store — never from a string an agent typed (#202's rule). The lazy paths
  // (ensureThread, a revive after a restart) have no dispatch in hand, so this
  // read is what carries the field there. A ticket with no record answers ''
  // and the label keeps the two-field form — never a guess off the watch list,
  // because two repos can answer for one number.
  #repoOf(ticket) {
    return this.bindings?.repoOf?.(ticket) ?? ''
  }

  async #namedThread(name) {
    const cached = this.threadByName.get(name)
    if (cached) {
      const t = await this.client.channels.fetch(cached).catch(() => null)
      if (t) return t
      this.threadByName.delete(name)
    }
    const active = await this.channel.threads.fetchActive()
    let thread = active.threads.find((t) => t.name === name)
    if (!thread) {
      const archived = await this.channel.threads.fetchArchived()
      thread = archived.threads.find((t) => t.name === name)
      if (thread) await thread.setArchived(false)
    }
    if (!thread) {
      thread = await this.channel.threads.create({ name, autoArchiveDuration: 10080 })
    }
    this.threadByName.set(name, thread.id)
    return thread
  }

  // A thread's own URL, from ids the daemon already holds — the breadcrumb's
  // whole payload (#108 item 10). Bare on purpose: attach-style tappable card.
  static threadLink(guildId, threadId) {
    return `https://discord.com/channels/${guildId}/${threadId}`
  }

  // Bind a ticket to a thread (#93). With a threadId, the bind lands on that
  // thread — "start binds the thread it runs in" — and the rename replaces the
  // conversation's own name. Without one, a fresh thread is
  // opened and bound (the autonomous-dispatch leg). A refused bind is returned
  // as the store said it, holder included, and renames nothing — EXCEPT the
  // issuing thread already carrying another ticket (#108 item 10): thread-per-
  // ticket then moves the work elsewhere, so a fresh thread is opened and
  // breadcrumbs link both ways — the origin learns where the work went, the
  // new thread names who sent it. Composition from ids the daemon holds at
  // bind time; no new state.
  bindTicket(ticket, opts = {}) {
    if (!this.bindings) return Promise.resolve({ ok: false, reason: 'no-bindings' })
    // the same one-at-a-time chain ensureThread runs on (#257): a dispatch and
    // a lazy open for one ticket must not each create a thread
    return this.#perTicket(ticket, () => this.#bindTicket(ticket, opts))
  }

  async #bindTicket(ticket, { threadId = null, type = '', repo = '' } = {}) {
    // The dispatch hands the repo over (#235); a caller without one falls back
    // to the journal's record, and a ticket with neither keeps the short label.
    repo = repo || this.#repoOf(ticket)
    if (threadId) {
      const r = this.bindings.bind(ticket, threadId)
      if (r.ok) {
        const t = await this.client.channels.fetch(threadId).catch(() => null)
        const name = DiscordBridge.labelName(ticket, type, repo)
        // the pending-name base again: skipping because Discord already shows
        // the label would let a deferred ✅ land on freshly re-opened work
        if (t && (this.renamer.desired(t.id) ?? t.name) !== name) await this.renamer.set(t.id, name)
        return r
      }
      // The ticket is bound to ANOTHER thread, and the operator is typing in
      // this one (#197). Move it, and say so at both ends — the old thread is
      // where the ticket's history is, and somebody may still be watching it.
      // Before this, the refusal was returned silently and the dispatch went on
      // talking into a thread nobody had open.
      if (r.reason === 'ticket-bound') return this.#moveTicket(ticket, type, repo, threadId, r.threadId)
      if (r.reason !== 'thread-bound') return r
      return this.#bindFreshThread(ticket, type, repo, threadId)
    }
    return this.#bindFreshThread(ticket, type, repo, null)
  }

  // #241: the thread of a NEW-map charting session is bound to a chat handle,
  // because that handle is the only name the session has. The moment the agent
  // creates the map, this thread becomes THAT MAP's thread — the conversation
  // that settled the destination is exactly the record a later `map <n>`
  // should land back in.
  //
  // This is the NAME, and only the name (#326). The live binding stays on the
  // handle, because the handle is what every notify, escalation and status
  // line of the running session addresses: moving it here left the session
  // speaking for a thread it no longer held, and the next line it said opened
  // another one. The map takes the thread through the journal instead — the
  // dispatcher's `map_adopted` line, which the store reads back as the map's
  // last thread — so the hand-over happens when the session releases the
  // handle and not a moment before.
  adoptMapThread(handle, mapNumber, opts = {}) {
    if (!this.bindings) return Promise.resolve({ ok: false, reason: 'no-bindings' })
    return this.#perTicket(mapNumber, () => this.#adoptMapThread(handle, mapNumber, opts))
  }

  async #adoptMapThread(handle, mapNumber, { repo = '' } = {}) {
    const threadId = this.bindings.get(handle)
    if (!threadId) return { ok: false, reason: 'unbound' }
    const name = DiscordBridge.labelName(mapNumber, 'map', repo)
    const t = await this.client.channels.fetch(threadId).catch(() => null)
    if (t && (this.renamer.desired(t.id) ?? t.name) !== name) await this.renamer.set(t.id, name)
    return { ok: true, threadId }
  }

  async #bindFreshThread(ticket, type, repo, originThreadId) {
    // The dispatch backstop (#140): an unbound ticket goes back to the thread
    // its journal last bound — that is where its history, breadcrumbs and
    // recorded answers live — and only opens a fresh thread when the old one
    // is gone from Discord or now carries another ticket.
    const revived = await this.#reviveLastThread(ticket, type, repo)
    let thread = revived
    let r = revived ? { ok: true, threadId: revived.id } : null
    if (!thread) {
      thread = await this.channel.threads.create({
        name: DiscordBridge.labelName(ticket, type, repo), autoArchiveDuration: 10080,
      })
      r = this.bindings.bind(ticket, thread.id)
      // the same lost-race cleanup ensureThread does (#257): an empty twin of
      // the thread that won is a duplicate, so it goes
      if (!r.ok && r.threadId) {
        const winner = await this.client.channels.fetch(r.threadId).catch(() => null)
        if (winner) {
          await thread.delete().catch(() => {})
          return { ok: true, threadId: winner.id }
        }
      }
    }
    if (r.ok && originThreadId) {
      const origin = await this.client.channels.fetch(originThreadId).catch(() => null)
      const originName = origin?.name ? `“${origin.name}”` : 'another thread'
      await thread.send(smallPrint(
        `🔗 dispatched from ${originName} — ${DiscordBridge.threadLink(this.guild.id, originThreadId)}`,
      )).catch(() => {})
      if (origin) {
        await origin.send(smallPrint(
          `🔗 ${DiscordBridge.labelName(ticket, type, repo)} continues in its own thread — ${DiscordBridge.threadLink(this.guild.id, thread.id)}`,
        )).catch(() => {})
      }
    }
    return r
  }

  // Carry a ticket from the thread it was bound to into the one the operator
  // just dispatched from (#197). The old thread keeps its history and gets a
  // pointer; the new one gets a pointer back, so neither is a dead end.
  //
  // A tracker with no `rebind` falls back to the old behavior — the refusal,
  // returned as it was — rather than pretending the move happened.
  async #moveTicket(ticket, type, repo, threadId, fromThreadId) {
    if (!this.bindings.rebind) return { ok: false, reason: 'ticket-bound', threadId: fromThreadId }
    const r = this.bindings.rebind(ticket, threadId, 'dispatched-from-another-thread')
    if (!r.ok) return r
    const name = DiscordBridge.labelName(ticket, type, repo)
    const to = await this.client.channels.fetch(threadId).catch(() => null)
    if (to && (this.renamer.desired(to.id) ?? to.name) !== name) await this.renamer.set(to.id, name)
    const from = await this.client.channels.fetch(fromThreadId).catch(() => null)
    if (from) {
      await from.send(smallPrint(
        `🔗 ${name} moved to ${DiscordBridge.threadLink(this.guild.id, threadId)} — dispatched from there, so it reports there now.`,
      )).catch(() => {})
      // live glyph → ✅ on the thread being left, the same signal releaseTicket
      // uses — and the same pending-name base, for the same lag
      const leftBase = this.renamer.desired(from.id) ?? from.name
      if (LIVE_GLYPH_RE.test(leftBase)) await this.renamer.set(from.id, DiscordBridge.doneName(leftBase))
    }
    if (to) {
      const fromName = from?.name ? `“${from.name}”` : 'another thread'
      await to.send(smallPrint(
        `🔗 ${name} moved here from ${fromName} — ${DiscordBridge.threadLink(this.guild.id, fromThreadId)} holds what it said before.`,
      )).catch(() => {})
    }
    return r
  }

  // The journal's last thread for a ticket, when it still exists on Discord
  // and is still free to take back (#140). Rebinds it — unarchived, relabeled
  // — or returns null so the caller opens a fresh thread instead.
  //
  // `relabel: false` takes the thread back and leaves its name alone (#257).
  // The lazy path uses it: a notify knows no ticket type, so the label it would
  // write is shorter than the one already there, and a line arriving after an
  // ending must not put 🎫 back on a ✅ thread.
  async #reviveLastThread(ticket, type, repo, { relabel = true } = {}) {
    const last = this.bindings.last?.(ticket)
    if (!last) return null
    const t = await this.client.channels.fetch(last).catch(() => null)
    if (!t) return null
    // a refusal here means the old thread was re-bound to another ticket in
    // the meantime — it is not this ticket's to take back
    if (!this.bindings.bind(ticket, t.id).ok) return null
    if (t.archived) await t.setArchived(false).catch(() => {})
    if (!relabel) return t
    // the label goes back on: a ✅ from an earlier release, or a ⚰️ from a
    // cancel (#200), goes back to 🎫 because a ticket is being worked again
    const name = DiscordBridge.labelName(ticket, type, repo)
    if ((this.renamer.desired(t.id) ?? t.name) !== name) await this.renamer.set(t.id, name)
    return t
  }

  // Release is the signal changing (#93): journal first, then swap 🎫 for ✅
  // and keep the rest of the name. Idempotent, and safe when the thread is
  // already gone. The swap bases on the renamer's pending name (see
  // flagTicket): a thread whose 🎫 label is still deferred shows no glyph at
  // all, and a ✅ computed on THAT name would never happen — the ticket would
  // finish and keep 🎫 forever once the label landed.
  async releaseTicket(ticket, reason) {
    if (!this.bindings) return
    this.#dropHeldFlag(ticket) // #277: the ✅ is this thread's last name
    const bound = this.bindings.get(ticket)
    this.bindings.release(ticket, reason)
    // An ending whose binding is already gone still owes the thread its final
    // name (#257). Two releases land for one ending often enough — reconcile
    // drops the binding of a ticket whose issue is closed, and the agent's own
    // `finished` release arrives after it — and the first one takes the binding
    // off whether or not its rename got through. A thread fetch that failed, or
    // a rename the budget deferred and the process then lost, left the thread
    // wearing the glyph it had. The second release used to return right here,
    // before the rename, so nothing ever corrected it: #81 stayed 🔎 and reads
    // as "in review" forever.
    const target = bound ?? this.#endedThread(ticket)
    if (!target) return
    const t = await this.client.channels.fetch(target).catch(() => null)
    if (!t) return
    const base = this.renamer.desired(t.id) ?? t.name
    if (!LIVE_GLYPH_RE.test(base)) return
    await this.renamer.set(t.id, DiscordBridge.doneName(base))
  }

  // The thread an unbound ticket last lived on, when it is still that ticket's
  // to speak for (#257). A thread another ticket has taken over since answers
  // null: its name is that ticket's business now.
  #endedThread(ticket) {
    const last = this.bindings.last?.(ticket)
    if (!last) return null
    const holder = this.bindings.ticketOf?.(last)
    return holder && String(holder) !== String(ticket) ? null : last
  }

  // The ending's name outlives the process that owed it (#257).
  //
  // A rename rides a budget of 2 per thread per 10 minutes (threadname.mjs),
  // so a ✅ can be deferred for minutes, and the gate's ledger dies with the
  // daemon. A deploy or a crash inside that window dropped the rename with it,
  // and nothing ever came back for it: the release had already taken the
  // binding off, so reconcile's bound-ticket sweep could not see the thread.
  // The name then lied for good.
  //
  // This runs at every bridge start and settles what the last process left: an
  // ACTIVE thread the journal once bound, bound to nothing now, still wearing a
  // live glyph. A thread curia never labeled is never touched, and an archived
  // one is left alone — waking a thread to correct its name is louder than the
  // wrong name.
  async settleEndedThreads() {
    if (!this.bindings?.lastTicketOf || !this.channel?.threads?.fetchActive) return 0
    const active = await this.channel.threads.fetchActive().catch((e) => {
      this.log(`[bridge] could not read the active threads to settle names: ${e.message}`)
      return null
    })
    if (!active) return 0
    let settled = 0
    for (const t of active.threads.values()) {
      if (!LIVE_GLYPH_RE.test(t.name)) continue
      if (!this.bindings.lastTicketOf(t.id)) continue
      if (this.bindings.ticketOf?.(t.id)) continue // still bound: live, or cancelled and kept (#140)
      await this.renamer.set(t.id, DiscordBridge.doneName(t.name))
      settled++
    }
    if (settled) this.log(`[bridge] settled ${settled} thread name(s) the last process left mid-rename`)
    return settled
  }

  // The cancel counterpart (#200), and the one difference is the binding: a
  // cancel does NOT release it (#140 keeps the ticket's history where a later
  // dispatch will land), so this renames and nothing else. Display only, like
  // every other rename here — the journal's `agent_cancelled` is the truth.
  async cancelTicket(ticket) {
    if (!this.bindings) return
    // The binding SURVIVES a cancel (#140), so unlike a release this held clear
    // would still find its ticket bound. ⚰️ is not a live glyph, so it would
    // dissolve anyway — dropping it just saves the wake-up.
    this.#dropHeldFlag(ticket)
    const bound = this.bindings.get(ticket)
    if (!bound) return
    const t = await this.client.channels.fetch(bound).catch(() => null)
    if (!t) return
    const base = this.renamer.desired(t.id) ?? t.name
    if (!LIVE_GLYPH_RE.test(base)) return
    await this.renamer.set(t.id, DiscordBridge.cancelledName(base))
  }

  #buttons(record) {
    const rows = []
    let row = new ActionRowBuilder()
    const push = (b) => {
      if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder() }
      row.addComponents(b)
    }
    // A confirm (#94) gets ✅/❌ and nothing else: declining IS the safe exit,
    // and the record closes by lapsing with its agent.
    if (record.kind === CONFIRM_KIND) {
      push(new ButtonBuilder().setCustomId(`esc|${record.id}|opt|approve`).setLabel('✅ Approve').setStyle(ButtonStyle.Danger))
      push(new ButtonBuilder().setCustomId(`esc|${record.id}|opt|reject`).setLabel('❌ Decline').setStyle(ButtonStyle.Secondary))
      rows.push(row)
      return rows
    }
    if (record.kind === 'approve-reject' || record.kind === 'preview-review' || record.kind === REVIEW_KIND) {
      push(new ButtonBuilder().setCustomId(`esc|${record.id}|opt|approve`).setLabel('✅ Approve').setStyle(ButtonStyle.Success))
      push(new ButtonBuilder().setCustomId(`esc|${record.id}|opt|reject`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger))
    }
    // The third button (#165, ADR-0010), and only on the review gate: it puts a
    // reviewer on the OTHER provider onto this diff. Secondary style on purpose
    // — the two answers stay the coloured pair, because this one answers
    // nothing. It rides beside them on every gate round.
    if (record.kind === REVIEW_KIND) {
      push(new ButtonBuilder()
        .setCustomId(`esc|${record.id}|opt|${CROSS_CHECK_ANSWER}`)
        .setLabel('🔎 Cross-check').setStyle(ButtonStyle.Secondary))
    }
    if (record.kind === 'choice' && (record.options ?? []).length <= MAX_BUTTON_OPTIONS) {
      record.options.forEach((label, idx) => {
        push(new ButtonBuilder().setCustomId(`esc|${record.id}|idx|${idx}`)
          .setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Primary))
      })
    }
    // Above the button cap the same options ride select menus (#431). Buttons
    // stay the short-list surface: a button is one tap and a menu is two, so
    // the menu earns the card only where the buttons cannot fit on it.
    //
    // A menu owns its whole row, so any half-filled row is flushed first. A
    // choice card carries no other button, so that row is empty here today.
    if (record.kind === 'choice' && selectFits(record.options ?? [])) {
      if (row.components.length) { rows.push(row); row = new ActionRowBuilder() }
      for (const page of selectPages(record.options)) {
        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`esc|${record.id}|sel|${page.start}`)
            .setPlaceholder(page.placeholder)
            .addOptions(page.slice.map((text, i) => selectOption(text, page.start + i))),
        ))
      }
    }
    // The round's one tap (#285). It is the ONLY button a free-text card ever
    // gets, and the agent asks for it by promising every question in the prompt
    // carries a recommendation. There is no ❌ beside it: the opposite of "all
    // as recommended" is not one word, it is your reply, and the reply path is
    // already open on every free-text record.
    if (record.kind === 'free-text' && record.recommended) {
      push(new ButtonBuilder().setCustomId(`esc|${record.id}|opt|${ALL_AS_RECOMMENDED}`)
        .setLabel('✅ All as recommended').setStyle(ButtonStyle.Success))
    }
    // No cancel button (#200). It said it ended the agent and ended nothing:
    // it closed the question record and handed the model a sentence, which the
    // model read and asked again around. Ending an agent has ONE word and one
    // place — `cancel <n>` in the command channel — and that word runs the
    // teardown, which cancels this record on its way past. A question a human
    // does not want answered gets their words as a reply.
    if (row.components.length) rows.push(row)
    return rows
  }

  #escalationBody(record) {
    if (record.kind === CONFIRM_KIND) {
      return [
        `**[${record.id}]** ${record.prompt}`,
        '-# ✅ executes, ❌ declines. No expiry — but this confirm lapses the moment its agent exits.',
      ].join('\n')
    }
    // The review gate (#54) is the one kind whose prompt is a multi-line block
    // the daemon composed — summary, proposed charting, the links to look at. A
    // blockquote would mark only its first line, so it is printed as it stands.
    if (record.kind === REVIEW_KIND) {
      return [
        `**[${record.id}]** \`${record.agent}\` asks for review:`,
        '',
        record.prompt,
        '',
        '_✅ Approve to merge and resolve, or reply in this thread with what to change (that reply is a rejection and the agent gets your words)._',
        '_🔎 Cross-check answers neither: it spawns a reviewer on the other provider, and the agent waits for its verdict._',
      ].join('\n')
    }
    // No blockquote (#95's markdown standard) — the prompt stands on its own line.
    const head = `**[${record.id}]** \`${record.agent}\` asks (*${record.kind}*):\n${record.prompt}`
    const parts = [head]
    if (record.kind === 'choice' && (record.options ?? []).length > MAX_BUTTON_OPTIONS) {
      // The numbered list is now the FALLBACK, not the surface (#431). It is
      // printed in the two cases the menu cannot serve: a list past the menu's
      // reach, and a list whose options are too long for the menu to show
      // whole. Otherwise the menu carries every option and the list would say
      // the same thing twice, which is what makes this card scroll on a phone.
      const numbered = record.options.map((o, i) => `**${i + 1}.** ${o}`).join('\n')
      if (!selectFits(record.options)) {
        parts.push(numbered, '_Reply in this thread with a number._')
      } else if (selectClips(record.options)) {
        parts.push(numbered, '_Pick from the menu below, or reply with a number._')
      } else {
        parts.push('_Pick from the menu below._')
      }
    } else if (record.kind === 'free-text') {
      // A round says what the tap means and what a partial reply does (#285).
      // The second sentence is the load-bearing one: a question you do not
      // answer is NOT taken as recommended, it comes back in the next round.
      parts.push(record.recommended
        ? '_✅ takes every recommendation above. Or reply in this thread — anything you leave unanswered comes back in the next round._'
        : '_Reply in this thread to answer._')
    } else if (record.kind === 'preview-review') {
      parts.push(`Preview: ${record.preview_url}`, '_Approve/Reject, or reply in this thread with comments._')
    }
    return parts.join('\n')
  }

  // Where a record renders (#218). The rule is WHO the record is addressed to,
  // not which ticket it names.
  //
  // A confirm is addressed to the operator, about a command the operator typed
  // one second ago. Its agent field is `overseer`, and it has no history in the
  // ticket thread. So it renders where the command was typed: the origin
  // thread, or #curia itself when the command carried no thread. The old
  // predicate read `record.ticket` instead, so `cancel all` landed where it was
  // typed and `cancel 208` did not. One verb, two behaviors.
  //
  // Every OTHER kind is addressed to the ticket conversation and keeps the
  // labeled thread. The review gate is the other ✅/❌ button and it is one of
  // these: the agent asking is standing in that thread, and #140 and #197 both
  // exist to hold it there.
  async #threadFor(record) {
    if (record.kind !== CONFIRM_KIND) return this.ensureThread(record.ticket)
    if (record.origin_thread_id) {
      const t = await this.client.channels.fetch(record.origin_thread_id).catch(() => null)
      if (t) return t
    }
    return this.channel
  }

  // Speaker identities (#108 item 15): agent prose posts under a webhook
  // identity ("curia-9", its session name and own identicon avatar), overseer
  // prose as "curia" with the bot's avatar — one thread, one voice, and "the
  // agent" moves from the prose into the speaker label. One channel webhook
  // serves every identity (username set per send). CONSTRAINT, verified
  // against Discord's API: interactive components require an
  // application-owned webhook, which createWebhook does not mint — so
  // escalation messages, the ones with buttons, stay bot-posted.
  async #webhook() {
    if (this.hook) return this.hook
    const hooks = await this.channel.fetchWebhooks()
    this.hook = hooks.find((h) => h.token && h.name === 'curia-speakers')
      ?? await this.channel.createWebhook({ name: 'curia-speakers' })
    return this.hook
  }

  // #143: both webhook calls above need Manage Webhooks. Without the grant
  // every speaker send raises `Missing Permissions` and falls back to the bot
  // voice — correct, and silent outside the daemon log, so the identities were
  // off for a day and nothing on the phone said so. The fallback stays (the
  // words always land) and the degradation now reaches the channel.
  //
  // Probed at START rather than left to the first send, because startup is when
  // the operator can act on it. The probe is the real path, not a permission
  // read, so it also warms the hook for the first agent send. Public because
  // `start()` needs a live gateway and the tests do not.
  async probeSpeakers() {
    try {
      await this.#webhook()
      this.speakers = { ok: true, reason: null }
    } catch (e) {
      await this.#speakerFault(e)
    }
  }

  // One notice per bridge instance, either way. The probe carries the usual
  // case; the send-time fallback carries a grant withdrawn while the daemon
  // runs, which no probe can see. Recovery clears the latch, so the same
  // permission lost again is announced again.
  static speakerNotice(e) {
    const missing = e?.code === 50013 || /missing permissions/i.test(e?.message ?? '')
    const why = missing
      ? 'the bot lacks **Manage Webhooks** on this channel'
      : `the channel webhook failed (${e?.message ?? e})`
    return `⚠️ Speaker identities are off: ${why}. Agent prose posts under the bot voice. Grant the permission to the bot role, or as a #curia channel override.`
  }

  static SPEAKERS_BACK = '✅ Speaker identities are on. Agent prose posts under its own name again.'

  async #speakerFault(e) {
    this.speakers = { ok: false, reason: e?.message ?? String(e) }
    if (this.speakerNoticed) return
    this.speakerNoticed = true
    const notice = DiscordBridge.speakerNotice(e)
    this.log(`[bridge] ${notice}`)
    await this.announce(notice).catch((err) => this.log(`speaker notice failed: ${err.message}`))
  }

  async #speakersBack() {
    this.speakers = { ok: true, reason: null }
    if (!this.speakerNoticed) return
    this.speakerNoticed = false
    this.log('[bridge] speaker identities are back')
    await this.announce(DiscordBridge.SPEAKERS_BACK).catch((err) => this.log(`speaker notice failed: ${err.message}`))
  }

  // The face beside the name. `github.com/identicons/<name>.png` was the first
  // scheme (#108 item 15) and it answers for REAL GitHub accounts only —
  // measured 404 for `curia-9`, `curia-143` and every other agent name, 200
  // for `alp82`. So Discord had nothing to fetch and every agent wore the
  // default avatar (#143). Gravatar generates one from any hash, `f=y` forces
  // the generated face even when the hash happens to be a real account, and
  // curia still hosts no asset. md5 is Gravatar's key, not a security choice.
  //
  // The whole name is the seed. It used to be the first space-separated word,
  // to hold the face still while the ticket title on the label changed. #254
  // took the title off the label, so the name is already the session name.
  #avatarFor(as) {
    if (as === 'curia') return this.client.user?.displayAvatarURL?.() ?? undefined
    const seed = createHash('md5').update(String(as)).digest('hex')
    return `https://www.gravatar.com/avatar/${seed}?d=identicon&f=y&s=128`
  }

  // Chunked like every composed send; files ride the last chunk. Any webhook
  // failure falls back to the bot voice — the words always land.
  async #sendAs(as, thread, { content, files = [] }) {
    try {
      const hook = await this.#webhook()
      const chunks = chunkMessage(content)
      const base = { username: as, avatarURL: this.#avatarFor(as), threadId: thread.id }
      for (const chunk of chunks.slice(0, -1)) await hook.send({ ...base, content: chunk })
      const msg = await hook.send({ ...base, content: chunks.at(-1), files })
      // A grant that lands while the daemon runs heals here: the send path is
      // never disabled, so the next one simply works and says so (#143).
      if (this.speakers.ok === false) await this.#speakersBack()
      return msg
    } catch (e) {
      this.log(`webhook send as "${as}" failed (${e.message}) — falling back to the bot voice`)
      await this.#speakerFault(e)
      return this.#sendChunked(thread, { content, files })
    }
  }

  // Long composed content becomes consecutive messages, split at paragraph
  // boundaries (#119) — a gate message that silently clipped at Discord's cap
  // lost exactly the charting the gate existed to judge. Components and files
  // ride the LAST chunk, so buttons sit below everything they approve. Returns
  // the last message — the one edits and marks target.
  async #sendChunked(target, { content, components = [], files = [] }) {
    const chunks = chunkMessage(content)
    for (const chunk of chunks.slice(0, -1)) await target.send(chunk)
    return target.send({ content: chunks.at(-1), components, files })
  }

  // Render an escalation where #threadFor sends it; returns discord ids for the record.
  async renderEscalation(record, { files = [] } = {}) {
    const thread = await this.#threadFor(record)
    const rows = this.#buttons(record)
    // Surface buttons (#108 item 22, generalizing #118 item 4): preview,
    // timeline and terminal ride EVERY question as link buttons, so the live
    // preview is always at the bottom where the operator reads — never a
    // scroll-back hunt. Each link fails soft and independently; a message can
    // hold five rows, and the answer buttons always win the space.
    if (rows.length < 5) {
      const links = await this.#surfaceLinks(record)
      rows.push(...DiscordBridge.linkRow(links))
    }
    const msg = await this.#sendChunked(thread, {
      content: this.#escalationBody(record),
      components: rows,
      files,
    })
    await this.#pointFromTicketThreads(record, thread).catch((e) => this.log(`confirm pointer for ${record.id} failed: ${e.message}`))
    return { channelId: this.channel.id, threadId: thread.id, messageId: msg.id }
  }

  // The pointer at the other end (#218, the rule #197 set for a moved binding).
  // A confirm renders where the operator typed the command, so a ticket thread
  // read on its own would show its agent stop with nothing saying why. Leave one
  // line in each target's thread naming where the buttons are. The outcome needs
  // no second pointer: an approved cancel posts its own ⚰️ line there.
  //
  // Targets, not `record.ticket`, so `cancel 208` and `cancel all` follow one
  // rule. A ticket with no bound thread gets nothing — a pointer must never be
  // the thing that creates a thread — and so does the thread the confirm is
  // already in, which needs no pointer to itself.
  async #pointFromTicketThreads(record, thread) {
    if (record.kind !== CONFIRM_KIND || !this.bindings || !this.guild) return
    const verb = record.action?.verb ?? 'confirm'
    const seen = new Set([thread.id])
    for (const t of record.action?.targets ?? []) {
      const bound = this.bindings.get(t.ticket)
      if (!bound || seen.has(bound)) continue
      seen.add(bound)
      const where = await this.client.channels.fetch(bound).catch(() => null)
      if (!where) continue
      await this.#sendChunked(where, {
        content: `🔗 **${record.id}**: a \`${verb}\` confirm for \`${t.session}\` waits in ${DiscordBridge.threadLink(this.guild.id, thread.id)}. The ✅/❌ buttons are there, not here.`,
      }).catch((e) => this.log(`confirm pointer into ${bound} failed: ${e.message}`))
    }
  }

  async #surfaceLinks(record) {
    const get = (fn) => Promise.resolve(fn?.(record.ticket)).catch(() => null)
    const preview = record.preview_url ?? await get(this.handlers.previewUrl)
    const timeline = await get(this.handlers.timelineLink)
    const terminal = await get(this.handlers.terminalLink)
    return [
      preview && { label: '🔗 preview', url: preview },
      timeline && { label: 'timeline', url: timeline },
      terminal && { label: 'terminal', url: terminal },
    ].filter(Boolean)
  }

  async #editEscalationMessage(record, suffix) {
    if (!record.discord) return
    const thread = await this.client.channels.fetch(record.discord.threadId).catch(() => null)
    if (!thread) return
    const msg = await thread.messages.fetch(record.discord.messageId).catch(() => null)
    if (!msg) return
    // The record's message id is the LAST chunk (#119) — earlier chunks stand
    // unchanged, and the mark lands where the buttons were, under everything.
    const tail = chunkMessage(this.#escalationBody(record)).at(-1)
    await msg.edit({ content: `${tail}\n\n${suffix}`, components: [] })
  }

  // The card is the ONLY record of an answer (#253, ADR-0013). Every answer
  // path lands here — button, thread reply, REST — so the mark carries what
  // the button's own interaction reply used to add: which dead ids routed the
  // answer to this record.
  markAnswered(record, { routedFrom = [] } = {}) {
    const routed = routedFrom.length ? ` (routed from ${routedFrom.join('→')})` : ''
    return this.#editEscalationMessage(record, `✅ **answered** by <@${record.answered_by}> via ${record.answered_via}${routed}: \`${String(record.answer).slice(0, 200)}\``)
  }

  // The mark says what HAPPENED and nothing else (#200). It used to promise a
  // teardown no press ever ran — "ticket re-frontiers" under a button that
  // only closed this record. Every remaining path here closes a question
  // because its agent is gone, so the mark names which ending it was; only a
  // Discord user id becomes a mention.
  static cancelWords(by) {
    switch (by) {
      case 'cancel': return 'its agent was cancelled'
      case 'agent-death': return 'its agent is gone'
      // #336: the agent finished PAST this question. The words say so, because
      // "cancelled" alone reads as somebody deciding against the question.
      case 'result': return 'its agent finished and reported a result'
      case 'reconcile': return 'the daemon reconciled it away'
      case 'rest': return 'it was cancelled over the REST seam'
      default: return /^\d+$/.test(String(by)) ? `cancelled by <@${by}>` : `cancelled (${by})`
    }
  }

  markCancelled(record) {
    return this.#editEscalationMessage(record, `⚰️ **cancelled** — ${DiscordBridge.cancelWords(record.cancelled_by)}. Nothing is waiting on this question.`)
  }

  markSuperseded(record) {
    return this.#editEscalationMessage(record, `⚠️ **superseded** by **${record.successor}** (the agent re-issued this question) — answer the newer message`)
  }

  // A confirm whose agent exited (#94): buttons off, and the message says why
  // nothing will ever execute from it.
  markLapsed(record) {
    return this.#editEscalationMessage(record, `⚰️ **lapsed** — ${record.lapse_reason ?? 'its agent exited'}. Nothing was executed; re-issue the command if you still want it.`)
  }

  // A line into the thread a record was rendered in — confirm outcomes (#94)
  // land next to their buttons, whatever thread that was.
  async notifyRecordThread(record, text) {
    if (!record.discord) return
    const thread = await this.client.channels.fetch(record.discord.threadId).catch(() => null)
    if (thread) await this.#sendChunked(thread, { content: text })
  }

  // The per-agent status line (#108 item 8): one message per agent thread,
  // edited in place. The daemon composes the text; this is transport only.
  // editStatus returns false when the message is gone, so the caller reposts
  // rather than losing the line.
  async postStatus(ticket, text) {
    const thread = await this.ensureThread(ticket)
    const msg = await thread.send(text.slice(0, 1900))
    return { threadId: thread.id, messageId: msg.id }
  }

  async editStatus(ids, text) {
    const thread = await this.client.channels.fetch(ids.threadId).catch(() => null)
    if (!thread) return false
    const msg = await thread.messages.fetch(ids.messageId).catch(() => null)
    if (!msg) return false
    await msg.edit(text.slice(0, 1900))
    return true
  }

  // A state TRANSITION repositions the line to the thread bottom (#108 item
  // 17): an edited message stays where it was born — three screens above the
  // silence it exists to cover. Deleting loses nothing; the journal holds the
  // history and the thread's own messages tell the story.
  async deleteStatus(ids) {
    const thread = await this.client.channels.fetch(ids.threadId).catch(() => null)
    if (!thread) return
    const msg = await thread.messages.fetch(ids.messageId).catch(() => null)
    if (msg) await msg.delete().catch(() => {})
  }

  // Link buttons (#108 item 22): preview, timeline and terminal ride messages
  // as tappable buttons instead of prose URLs. Link-style buttons are still
  // components, so they share the webhook constraint above — bot-posted
  // messages only.
  static linkRow(links) {
    if (!links?.length) return []
    const row = new ActionRowBuilder()
    for (const l of links.slice(0, 5)) {
      row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(l.label.slice(0, 80)).setURL(l.url))
    }
    return [row]
  }

  // Fire-and-forget status line into the ticket thread; files = outbound
  // images. `as` picks the speaker identity (#108 item 15): an agent's own
  // words post under its name; absent, the bot voice stands. `links` become
  // buttons — bot voice only (see linkRow), so an agent-voice send with links
  // appends them as plain lines instead of dropping them.
  async notify(ticket, message, { files = [], as = null, links = [] } = {}) {
    const thread = await this.ensureThread(ticket)
    if (as) {
      const tail = links.length ? `\n${links.map((l) => `🔗 ${l.label} ${l.url}`).join('\n')}` : ''
      await this.#sendAs(as, thread, { content: `${message}${tail}`, files })
      return
    }
    await this.#sendChunked(thread, { content: message, files, components: DiscordBridge.linkRow(links) })
  }

  // Attachment names come from Discord, i.e. from outside — path.join with a
  // raw name lets `../` walk out of the attachments dir and overwrite anything
  // the daemon can write. Take a sanitized leaf only.
  async #downloadAttachments(escalationId, attachments) {
    const dir = path.join(this.dataDir, 'attachments', escalationId)
    const saved = []
    let i = 0
    for (const a of attachments.values()) {
      fs.mkdirSync(dir, { recursive: true })
      const dest = path.join(dir, safeLeaf(a.name, `attachment-${++i}`))
      const res = await fetch(a.url)
      await finished(Readable.fromWeb(res.body).pipe(fs.createWriteStream(dest)))
      saved.push(dest)
    }
    return saved
  }

  // Public because a button press is a decision path worth testing (#200) —
  // `start` wires it to the gateway, and a test hands it an interaction.
  async handleInteraction(i) {
    if (!this.authorized(i.user.id)) {
      if (i.isRepliable()) await i.reply({ content: 'not authorized', ephemeral: true })
      return
    }

    if (i.isChatInputCommand()) {
      const canonical = expandCommand(i)
      if (!canonical) return
      if (typeof canonical === 'object') {
        const content = canonical.error === 'map-shape' ? MAP_SHAPE_REPLY : missingOptionReply(i.commandName)
        await i.reply({ content, ephemeral: true })
        return
      }
      await i.deferReply()
      // A slash command issued inside a thread carries that thread as context,
      // so `start` binds the thread it runs in (#93) — same rule as the
      // overseer's verb tools. Top-level slash commands carry none.
      const threadId = i.channel?.isThread() ? i.channel.id : null
      const reply = await this.handlers.command(canonical, i.user.id, { threadId })
      await i.editReply(reply ?? `relayed: \`${canonical}\``)
      return
    }

    // The interrupt button under a queued-note receipt (#252, ADR-0013).
    //
    // A success is acknowledged SILENTLY and written onto the receipt in place:
    // the receipt is the record of what happened to those words, and an
    // interaction reply beside it would say the same fact twice. A refusal is
    // the other case — nothing happened, so there is no record to show, and the
    // presser is told EPHEMERALLY. That puts no second line in the thread and
    // leaves the button pressable, which is what an operator who answers the
    // escalation first and presses again needs.
    if (i.isButton() && i.customId.startsWith('note|')) {
      const [, noteId, action] = i.customId.split('|')
      if (action !== 'interrupt') return
      const res = await this.handlers.interruptNote?.(noteId, i.user.id)
        ?? { ok: false, why: 'this daemon has no interrupt path' }
      if (!res.ok) {
        await i.reply({ content: `⚠️ not asked — ${res.why}`, ephemeral: true }).catch(() => {})
        return
      }
      await i.deferUpdate().catch(() => {})
      await i.message.edit({
        content: interruptedReceipt(i.message.content, { by: i.user.id, session: res.session, graceMs: res.graceMs }),
        components: [],
      }).catch(() => {})
      return
    }

    // A pick on a long-choice menu (#431) lands here beside the buttons: same
    // custom id, same record, same answer path. The only difference is where
    // the picked index rides — `i.values[0]` instead of the id's last field.
    if ((i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('esc|')) {
      const [, id, action, value] = i.customId.split('|')
      // A message posted before #200 still carries the old cancel button, and
      // Discord keeps it pressable forever. The act it named is gone, so the
      // press does NOTHING and names the one word that ends an agent. Doing
      // the old thing quietly is what the ticket exists to stop.
      if (action === 'cancel') {
        const ticket = this.handlers.get(id)?.ticket
        await i.reply({
          content: `⚠️ this button is gone — say \`cancel ${ticket ?? '<n>'}\` in <#${this.channel.id}> to end the agent, or reply here to answer`,
          ephemeral: true,
        })
        return
      }
      const record = this.handlers.get(id)
      const picked = action === 'sel' ? i.values?.[0] : value
      const answer = action === 'idx' || action === 'sel'
        ? record?.options?.[Number(picked)] ?? picked
        : picked
      const result = this.handlers.answer(id, {
        answer, by: i.user.id, via: action === 'sel' ? 'select menu' : 'button',
      })
      if (result.ok) {
        // #253, ADR-0013: the card is the only record. `answer` above already
        // edits the mark onto it, so this press is acknowledged SILENTLY —
        // the interaction reply that used to land here said the same fact a
        // second time, and on an old card it landed screens below the mark it
        // repeated, reading as news about something already answered.
        await i.deferUpdate().catch(() => {})
      } else {
        await i.reply({ content: `⚠️ not open — ${result.reason}${result.record?.answer ? ` (answer was \`${result.record.answer}\`)` : ''}`, ephemeral: true })
      }
    }
  }

  // The overseer surface (#92, moved into #curia by #93): a top-level prose
  // message opens a thread and a fresh session, a message in any thread
  // revives that thread's session with full memory. The bridge owns only the
  // transport (thread, typing, the 2000-char cap, and #95's one edited status
  // message); everything said comes from the host through `say`/`status`.
  async #overseerTurn(thread, prompt, opts = {}) {
    const typing = setInterval(() => thread.sendTyping().catch(() => {}), 8000)
    thread.sendTyping().catch(() => {})
    // #95: one status message per turn — sent on the first status(), edited in
    // place after. An edit that fails is dropped, not resent: a second status
    // message is exactly what the discipline forbids.
    let statusMsg = null
    try {
      return await this.handlers.overseerTurn(thread.id, prompt, {
        ...opts,
        say: (text) => this.#sayChunked(thread, text),
        status: async (text) => {
          if (statusMsg) return statusMsg.edit(text.slice(0, 1900)).catch(() => {})
          statusMsg = await thread.send(text.slice(0, 1900)).catch(() => null)
        },
      })
    } finally {
      clearInterval(typing)
    }
  }

  // The boot's two calls into a conversation thread (#388, ADR-0015). A killed
  // turn either comes back as the same message or as one line saying why it did
  // not, and both land in the thread that turn died in.
  //
  // The replay takes the SAME path an operator message takes — the small-print
  // notice first, then `#overseerTurn` — so the status line, the chunking and
  // the one-turn-at-a-time rule are the ones the surface already has.
  async sayInThread(threadId, text) {
    const thread = await this.client.channels.fetch(threadId).catch(() => null)
    if (!thread) return false
    await this.#sendChunked(thread, { content: text })
    return true
  }

  async replayOverseerTurn(threadId, prompt, notice) {
    const thread = await this.client.channels.fetch(threadId).catch(() => null)
    if (!thread) return false
    if (notice) await this.#sendChunked(thread, { content: notice }).catch(() => {})
    await this.#overseerTurn(thread, prompt, { replay: true })
    return true
  }

  // Discord caps a message at 2000 chars; the split respects paragraphs (#119).
  // The overseer speaks as "curia" (#108 item 15) — the webhook identity, so a
  // ticket thread's agent name and the overseer are visibly two speakers.
  async #sayChunked(thread, text) {
    await this.#sendAs('curia', thread, { content: text })
  }

  async #onMessage(m) {
    if (m.author.bot) return
    if (!this.authorized(m.author.id)) return
    // Top-level prose in #curia always opens a fresh conversation thread (#89).
    if (m.channel.id === this.channel.id) {
      if (!this.handlers.overseerTurn) return
      const thread = await m.startThread({ name: m.content.slice(0, 80) || 'overseer', autoArchiveDuration: 10080 })
      return this.#overseerTurn(thread, m.content)
    }
    if (!m.channel.isThread() || m.channel.parentId !== this.channel.id) return
    // A reply in a thread feeds an open escalation first, otherwise the
    // session (#89) — so a labeled ticket thread answers its agent's question
    // before the overseer ever hears the words.
    const open = this.handlers.findOpenForThread(m.channel.id)
    if (!open) {
      // One listener per thread (#120): while a live agent is bound here, the
      // overseer stays silent — it cannot see the agent's question, and its
      // confident reply reads as if the words were delivered (#108 items 14/15).
      // Text outside an open escalation queues as an operator note the daemon
      // piggybacks on the agent's next tool result (#108 item 14) — the
      // round-one refusal notice is gone.
      const owner = this.handlers.agentForThread?.(m.channel.id)
      if (owner) {
        const q = this.handlers.queueAgentNote?.(m.channel.id, m.content ?? '', m.author.id)
        if (q) {
          // 📨 means the words are in a queue. A dead agent queues nothing
          // (#208), so the reaction says the same thing the reply does.
          await m.react(q.reads === false ? '⚠️' : '📨').catch(() => {})
          // A command still queues — the operator may mean the word for the
          // agent — but the reply names the way out, so `cancel 166` typed at
          // an agent never dies silently as a note (#108 item 23, #170).
          // The receipt carries the interrupt button, the operator's pick of
          // the other delivery mode (#252). A dead agent queued nothing, so its
          // receipt gets none.
          await m.channel.send(noteReceipt({ owner, q, text: m.content, channelId: this.channel.id })).catch(() => {})
        } else {
          await m.react('⚠️').catch(() => {})
          await m.channel.send(smallPrint(
            `this thread belongs to \`${owner}\` — text here reaches the agent only as a reply to an open escalation.`,
          )).catch(() => {})
        }
        return
      }
      if (this.handlers.overseerTurn && m.content?.trim()) return this.#overseerTurn(m.channel, m.content)
      return
    }
    let answer = m.content?.trim() ?? ''
    // numbered reply against a degraded long choice list
    if (open.kind === 'choice' && /^\d+$/.test(answer)) {
      const picked = open.options?.[Number(answer) - 1]
      if (picked) answer = picked
    }
    const attachments = m.attachments.size
      ? await this.#downloadAttachments(open.id, m.attachments)
      : []
    if (!answer && !attachments.length) return
    if (attachments.length) {
      // The path line stays: it is the readable form in the durable record, and
      // the agent keeps a handle on the file. The image itself now also rides
      // back as a real content block (see `attachments`, #34).
      answer = [answer, ...attachments.map((p) => `[attachment: ${p}]`)].filter(Boolean).join('\n')
    }
    const result = this.handlers.answer(open.id, { answer, attachments, by: m.author.id, via: 'thread-reply' })
    await m.react(result.ok ? '✅' : '⚠️')
  }
}

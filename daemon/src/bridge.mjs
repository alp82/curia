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
} from 'discord.js'
import { safeLeaf } from './images.mjs'
import { REVIEW_KIND } from './lifecycle.mjs'
import { CONFIRM_KIND } from './store.mjs'
import { chunkMessage, smallPrint } from './messaging.mjs'

const MAX_BUTTON_OPTIONS = 23 // 25 buttons max, minus cancel; keep rows tidy

// #108 item 23, widened by #170: a message that is nothing but a command,
// typed at an agent thread — the shape that reads as "cancel the agent" but
// queues as prose. Trailing punctuation forgiven; any surrounding words mean
// it is a real note.
//
// The argument is what #170 added. A bare `cancel` was detected and
// `cancel 166` was not, so the operator who typed the surface's OWN syntax got
// no hint at all and waited an hour. A false positive here costs one extra
// line under a queued note, so the shape is drawn wide on purpose.
export const COMMAND_SHAPED = /^\s*(cancel|stop|pause|resume|status|start|attach)(\s+(#?\d+|all))?\s*[.!?]*\s*$/i

// The command the operator meant. `stop` and `pause` are not verbs the surface
// has — at an agent, cancel is what they ask for. `status` is the only one
// that takes no ticket.
const MEANT_VERB = { cancel: 'cancel', stop: 'cancel', pause: 'cancel', resume: 'resume', status: 'status', start: 'start', attach: 'attach' }

// What to say under a note whose text was a command. The channel is the whole
// point: commands are interpreted there and nowhere else.
export function commandHint(text, ticket, channelId) {
  const verb = MEANT_VERB[/^\s*([a-z]+)/i.exec(text ?? '')?.[1]?.toLowerCase()] ?? 'cancel'
  const arg = verb === 'status' ? '' : ` ${ticket ?? '<n>'}`
  return `commands run in <#${channelId}>, never in a ticket thread — say \`${verb}${arg}\` there`
}

// The whole reply under a queued note, as lines. Pure, and exported, because
// the two facts it carries are the ones #170 got wrong: WHETHER anything reads
// the note, and where the operator's words would have been a command.
//
// `q.reads === false` is positive evidence the agent is not running — the
// early exit (#169), the ready timeout, the result-less exit. The note still
// queues: the queue is session-keyed, so whatever resumes on this session gets
// it (see store.queueRecordedAnswer). Anything else keeps the old promise.
export function queuedNoteReply({ owner, q, text, channelId }) {
  const lines = [
    q.reads === false
      ? `queued for \`${owner}\`, which is NOT running — nothing reads this until \`resume ${q.ticket ?? '<n>'}\``
      : `queued for \`${owner}\` — it reads this with its next tool result${q.after ? ` (noted as after ${q.after})` : ''}`,
  ]
  if (COMMAND_SHAPED.test(text ?? '')) lines.push(commandHint(text, q.ticket, channelId))
  return lines
}

// #81's grown catalogue — a static macro manifest; expansion only, never
// interpretation. `tickets` renames `frontier` on the command surface.
const SLASH_MANIFEST = [
  new SlashCommandBuilder().setName('tickets').setDescription('List takeable tickets')
    .addStringOption((o) => o.setName('repo').setDescription('Limit to one repo (any unambiguous part of the name)')),
  new SlashCommandBuilder().setName('next').setDescription('Dispatch the next takeable ticket')
    .addStringOption((o) => o.setName('repo').setDescription('Limit to one repo (any unambiguous part of the name)')),
  new SlashCommandBuilder().setName('status').setDescription('Agents running, waiting on input, and recent endings'),
  new SlashCommandBuilder().setName('start').setDescription('Dispatch an agent on a ticket, or a charting agent on a map')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number, or a map number').setRequired(true))
    .addStringOption((o) => o.setName('model').setDescription('Model override'))
    .addStringOption((o) => o.setName('harness').setDescription('Harness override'))
    // #160. Optional, so an old client-side manifest still sends a valid
    // `/start` — it just cannot carry a sentence, and the charting agent then
    // asks what should change, which is the right degradation.
    .addStringOption((o) => o.setName('instruction').setDescription('MAP ONLY: what should change on the map')),
  new SlashCommandBuilder().setName('cancel').setDescription('Cancel a running ticket, or all of them')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number, or "all"').setRequired(true)),
  new SlashCommandBuilder().setName('resume').setDescription('Fresh agent on a ticket, inheriting its surviving worktree')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number, or "all"').setRequired(true)),
  new SlashCommandBuilder().setName('attach').setDescription('Get the attach handle for a live session')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number').setRequired(true)),
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
    case 'start': {
      const ticket = need('ticket')
      if (!ticket) return { error: 'missing' }
      // The instruction rides LAST, after a bare `--` (#160), and its
      // whitespace is collapsed for the same reason canonicalFor collapses it:
      // this line is one line, and the router splits it on whitespace. This is
      // still expansion, not interpretation — the text is passed through, and
      // whether a map may carry it is the dispatcher's ruling.
      const instruction = (need('instruction') ?? '').replace(/\s+/g, ' ').trim()
      return `start ${ticket}`
        + (opt('model') ? ' model=' + opt('model') : '')
        + (opt('harness') ? ' harness=' + opt('harness') : '')
        + (instruction ? ` -- ${instruction}` : '')
    }
    case 'cancel':
    case 'resume':
    case 'attach': {
      const ticket = need('ticket')
      if (!ticket) return { error: 'missing' }
      return `${i.commandName} ${ticket}`
    }
    default: return null
  }
}

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
  constructor({ token, allowedUsers, guildId, channelName = 'curia', dataDir, handlers, bindings = null, log = console.log, onHealth = () => {} }) {
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

  // The ticket label as a thread rename (#93): `🎫 85 · grilling`. The ticket
  // number and its `wayfinder:` type REPLACE whatever the thread was called —
  // a thread list that reads "which ticket, what kind of work" is worth more
  // than the prose title the conversation started under. Display only — the
  // journal binding is the truth — so every half tolerates a rename that never
  // landed or that someone edited by hand.
  static labelName(ticket, type = '') {
    return `🎫 ${ticket}${type ? ` · ${type}` : ''}`.slice(0, 100)
  }

  // Release swaps the signal and keeps the rest: `🎫 85 · grilling` becomes
  // `✅ 85 · grilling`. The finished ticket stays readable in the thread list
  // instead of falling back to a name that no longer says what happened.
  static doneName(name) {
    return name.replace(/^🎫/, '✅')
  }

  // A cancel swaps the same signal for ⚰️ — the agent was torn down (#200).
  // ✅ would be a lie (nothing finished) and 🎫 was the whole complaint: a
  // cancelled ticket read exactly like a running one in the thread list. The
  // BINDING stays (#140), so a later dispatch takes the same thread back and
  // labelName puts 🎫 on it again.
  static cancelledName(name) {
    return name.replace(/^🎫/, '⚰️')
  }

  // The thread a ticket's traffic lands in (#93): the journalled binding first.
  // An unbound ticket gets a fresh thread, bound on creation — that is the
  // "autonomous dispatch opens and binds a fresh thread" leg of #89, reached
  // lazily by whichever notify or escalation speaks first. Pseudo-tickets with
  // no binding seam ('all', tests without `bindings`) keep the old name-based
  // lookup so bulk confirms still share one thread.
  async ensureThread(ticket) {
    if (!this.bindings || !/^\d+$/.test(String(ticket))) return this.#namedThread(`ticket-${ticket}`)
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
    const thread = await this.channel.threads.create({
      name: DiscordBridge.labelName(ticket), autoArchiveDuration: 10080,
    })
    const r = this.bindings.bind(ticket, thread.id)
    if (!r.ok && r.threadId) {
      // lost a race: another path bound this ticket between the read and here
      const winner = await this.client.channels.fetch(r.threadId).catch(() => null)
      if (winner) return winner
    }
    return thread
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
  async bindTicket(ticket, { threadId = null, type = '' } = {}) {
    if (!this.bindings) return { ok: false, reason: 'no-bindings' }
    if (threadId) {
      const r = this.bindings.bind(ticket, threadId)
      if (r.ok) {
        const t = await this.client.channels.fetch(threadId).catch(() => null)
        const name = DiscordBridge.labelName(ticket, type)
        if (t && t.name !== name) await t.setName(name).catch(() => {})
        return r
      }
      // The ticket is bound to ANOTHER thread, and the operator is typing in
      // this one (#197). Move it, and say so at both ends — the old thread is
      // where the ticket's history is, and somebody may still be watching it.
      // Before this, the refusal was returned silently and the dispatch went on
      // talking into a thread nobody had open.
      if (r.reason === 'ticket-bound') return this.#moveTicket(ticket, type, threadId, r.threadId)
      if (r.reason !== 'thread-bound') return r
      return this.#bindFreshThread(ticket, type, threadId)
    }
    return this.#bindFreshThread(ticket, type, null)
  }

  async #bindFreshThread(ticket, type, originThreadId) {
    // The dispatch backstop (#140): an unbound ticket goes back to the thread
    // its journal last bound — that is where its history, breadcrumbs and
    // recorded answers live — and only opens a fresh thread when the old one
    // is gone from Discord or now carries another ticket.
    const revived = await this.#reviveLastThread(ticket, type)
    let thread = revived
    let r = revived ? { ok: true, threadId: revived.id } : null
    if (!thread) {
      thread = await this.channel.threads.create({
        name: DiscordBridge.labelName(ticket, type), autoArchiveDuration: 10080,
      })
      r = this.bindings.bind(ticket, thread.id)
    }
    if (r.ok && originThreadId) {
      const origin = await this.client.channels.fetch(originThreadId).catch(() => null)
      const originName = origin?.name ? `“${origin.name}”` : 'another thread'
      await thread.send(smallPrint(
        `🔗 dispatched from ${originName} — ${DiscordBridge.threadLink(this.guild.id, originThreadId)}`,
      )).catch(() => {})
      if (origin) {
        await origin.send(smallPrint(
          `🔗 ${DiscordBridge.labelName(ticket, type)} continues in its own thread — ${DiscordBridge.threadLink(this.guild.id, thread.id)}`,
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
  async #moveTicket(ticket, type, threadId, fromThreadId) {
    if (!this.bindings.rebind) return { ok: false, reason: 'ticket-bound', threadId: fromThreadId }
    const r = this.bindings.rebind(ticket, threadId, 'dispatched-from-another-thread')
    if (!r.ok) return r
    const name = DiscordBridge.labelName(ticket, type)
    const to = await this.client.channels.fetch(threadId).catch(() => null)
    if (to && to.name !== name) await to.setName(name).catch(() => {})
    const from = await this.client.channels.fetch(fromThreadId).catch(() => null)
    if (from) {
      await from.send(smallPrint(
        `🔗 ${name} moved to ${DiscordBridge.threadLink(this.guild.id, threadId)} — dispatched from there, so it reports there now.`,
      )).catch(() => {})
      // 🎫 → ✅ on the thread being left, the same signal releaseTicket uses
      if (from.name.startsWith('🎫')) await from.setName(DiscordBridge.doneName(from.name)).catch(() => {})
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
  async #reviveLastThread(ticket, type) {
    const last = this.bindings.last?.(ticket)
    if (!last) return null
    const t = await this.client.channels.fetch(last).catch(() => null)
    if (!t) return null
    // a refusal here means the old thread was re-bound to another ticket in
    // the meantime — it is not this ticket's to take back
    if (!this.bindings.bind(ticket, t.id).ok) return null
    if (t.archived) await t.setArchived(false).catch(() => {})
    // the label goes back on: a ✅ from an earlier release, or a ⚰️ from a
    // cancel (#200), goes back to 🎫 because a ticket is being worked again
    const name = DiscordBridge.labelName(ticket, type)
    if (t.name !== name) await t.setName(name).catch(() => {})
    return t
  }

  // Release is the signal changing (#93): journal first, then swap 🎫 for ✅
  // and keep the rest of the name. Idempotent, and safe when the thread is
  // already gone.
  async releaseTicket(ticket, reason) {
    if (!this.bindings) return
    const bound = this.bindings.get(ticket)
    this.bindings.release(ticket, reason)
    if (!bound) return
    const t = await this.client.channels.fetch(bound).catch(() => null)
    if (!t || !t.name.startsWith('🎫')) return
    await t.setName(DiscordBridge.doneName(t.name)).catch(() => {})
  }

  // The cancel counterpart (#200), and the one difference is the binding: a
  // cancel does NOT release it (#140 keeps the ticket's history where a later
  // dispatch will land), so this renames and nothing else. Display only, like
  // every other rename here — the journal's `agent_cancelled` is the truth.
  async cancelTicket(ticket) {
    if (!this.bindings) return
    const bound = this.bindings.get(ticket)
    if (!bound) return
    const t = await this.client.channels.fetch(bound).catch(() => null)
    if (!t || !t.name.startsWith('🎫')) return
    await t.setName(DiscordBridge.cancelledName(t.name)).catch(() => {})
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
    if (record.kind === 'choice' && (record.options ?? []).length <= MAX_BUTTON_OPTIONS) {
      record.options.forEach((label, idx) => {
        push(new ButtonBuilder().setCustomId(`esc|${record.id}|idx|${idx}`)
          .setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Primary))
      })
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
      ].join('\n')
    }
    // No blockquote (#95's markdown standard) — the prompt stands on its own line.
    const head = `**[${record.id}]** \`${record.agent}\` asks (*${record.kind}*):\n${record.prompt}`
    const parts = [head]
    if (record.kind === 'choice' && (record.options ?? []).length > MAX_BUTTON_OPTIONS) {
      parts.push(record.options.map((o, i) => `**${i + 1}.** ${o}`).join('\n'), '_Reply in this thread with a number._')
    } else if (record.kind === 'free-text') {
      parts.push('_Reply in this thread to answer._')
    } else if (record.kind === 'preview-review') {
      parts.push(`Preview: ${record.preview_url}`, '_Approve/Reject, or reply in this thread with comments._')
    }
    return parts.join('\n')
  }

  // Where a record renders: the labeled ticket thread — except a confirm on a
  // pseudo-ticket ('all', #94), which has no labeled thread and lands in the
  // conversation that asked for it.
  async #threadFor(record) {
    if (record.origin_thread_id && !/^\d+$/.test(String(record.ticket))) {
      const t = await this.client.channels.fetch(record.origin_thread_id).catch(() => null)
      if (t) return t
    }
    return this.ensureThread(record.ticket)
  }

  // Speaker identities (#108 item 15): agent prose posts under a webhook
  // identity ("curia-9 · <ticket title>", own identicon avatar), overseer
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
  #avatarFor(as) {
    if (as === 'curia') return this.client.user?.displayAvatarURL?.() ?? undefined
    const seed = createHash('md5').update(as.split(' ')[0]).digest('hex')
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

  // Render an escalation into its ticket thread; returns discord ids for the record.
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
    return { channelId: this.channel.id, threadId: thread.id, messageId: msg.id }
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

  markAnswered(record) {
    return this.#editEscalationMessage(record, `✅ **answered** by <@${record.answered_by}> via ${record.answered_via}: \`${String(record.answer).slice(0, 200)}\``)
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
        await i.reply({ content: missingOptionReply(i.commandName), ephemeral: true })
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

    if (i.isButton() && i.customId.startsWith('esc|')) {
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
      const answer = action === 'idx' ? record?.options?.[Number(value)] ?? value : value
      const result = this.handlers.answer(id, { answer, by: i.user.id, via: 'button' })
      if (result.ok) {
        const routed = result.routed_from?.length ? ` (routed from ${result.routed_from.join('→')})` : ''
        await i.reply({ content: `✅ **${result.record.id}** answered: \`${answer}\`${routed}` })
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
  async #overseerTurn(thread, prompt) {
    const typing = setInterval(() => thread.sendTyping().catch(() => {}), 8000)
    thread.sendTyping().catch(() => {})
    // #95: one status message per turn — sent on the first status(), edited in
    // place after. An edit that fails is dropped, not resent: a second status
    // message is exactly what the discipline forbids.
    let statusMsg = null
    try {
      await this.handlers.overseerTurn(thread.id, prompt, {
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
          await m.react('📨').catch(() => {})
          // A command still queues — the operator may mean the word for the
          // agent — but the reply names the way out, so `cancel 166` typed at
          // an agent never dies silently as a note (#108 item 23, #170).
          const lines = queuedNoteReply({ owner, q, text: m.content, channelId: this.channel.id })
          await m.channel.send(smallPrint(lines.join('\n'))).catch(() => {})
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

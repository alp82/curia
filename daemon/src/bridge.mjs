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

const MAX_BUTTON_OPTIONS = 23 // 25 buttons max, minus cancel; keep rows tidy

// #81's grown catalogue — a static macro manifest; expansion only, never
// interpretation. `tickets` renames `frontier` on the command surface.
const SLASH_MANIFEST = [
  new SlashCommandBuilder().setName('tickets').setDescription('List takeable tickets')
    .addStringOption((o) => o.setName('repo').setDescription('Limit to one repo (any unambiguous part of the name)')),
  new SlashCommandBuilder().setName('next').setDescription('Dispatch the next takeable ticket')
    .addStringOption((o) => o.setName('repo').setDescription('Limit to one repo (any unambiguous part of the name)')),
  new SlashCommandBuilder().setName('status').setDescription('Workers running, waiting on input, and recent endings'),
  new SlashCommandBuilder().setName('start').setDescription('Dispatch a worker on a ticket')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number').setRequired(true))
    .addStringOption((o) => o.setName('model').setDescription('Model override'))
    .addStringOption((o) => o.setName('backend').setDescription('Backend override')),
  new SlashCommandBuilder().setName('cancel').setDescription('Cancel a running ticket, or all of them')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number, or "all"').setRequired(true)),
  new SlashCommandBuilder().setName('resume').setDescription('Fresh worker on a ticket, inheriting its surviving worktree')
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
function expandCommand(i) {
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
      return `start ${ticket}${opt('model') ? ' model=' + opt('model') : ''}${opt('backend') ? ' backend=' + opt('backend') : ''}`
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
    `⛔ \`/${commandName}\` arrived with no **ticket** — the option is required, so your Discord client is`,
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
    this.client.on('interactionCreate', (i) => this.#onInteraction(i).catch((e) => this.log('interaction error', e)))
    this.client.on('messageCreate', (m) => this.#onMessage(m).catch((e) => this.log('message error', e)))
    this.#watchGateway()
    this.#setHealth('up', { reason: 'ready' })
    this.log(`[bridge] ready: guild=${this.guild.name} channel=#${this.channel.name}`)
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
    }
  }

  // A plain channel line, not a thread line: an outage is about the bridge, not
  // about one ticket.
  async announce(text) {
    if (!this.channel) throw new Error('no channel yet')
    await this.channel.send(text)
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

  // The ticket label as a thread rename (#93): `🎫 85 · <rest>`. Display only —
  // the journal binding is the truth — so both halves tolerate a rename that
  // never landed or that someone edited by hand.
  static labelName(ticket, rest = '') {
    return `🎫 ${ticket}${rest ? ` · ${rest}` : ''}`.slice(0, 100)
  }

  static stripLabel(name) {
    return name.replace(/^🎫\s*\S+(\s*·\s*|\s*$)/, '')
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

  // Bind a ticket to a thread (#93). With a threadId, the bind lands on that
  // thread — "start binds the thread it runs in" — and the rename prefixes the
  // label onto the conversation's own name. Without one, a fresh thread is
  // opened and bound (the autonomous-dispatch leg). A refused bind is returned
  // as the store said it, holder included, and renames nothing.
  async bindTicket(ticket, { threadId = null, title = '' } = {}) {
    if (!this.bindings) return { ok: false, reason: 'no-bindings' }
    if (threadId) {
      const r = this.bindings.bind(ticket, threadId)
      if (!r.ok) return r
      const t = await this.client.channels.fetch(threadId).catch(() => null)
      if (t && !t.name.startsWith('🎫')) {
        await t.setName(DiscordBridge.labelName(ticket, t.name)).catch(() => {})
      }
      return r
    }
    const thread = await this.channel.threads.create({
      name: DiscordBridge.labelName(ticket, title), autoArchiveDuration: 10080,
    })
    return this.bindings.bind(ticket, thread.id)
  }

  // Release is the label coming off (#93): journal first, then strip the
  // rename. Idempotent, and safe when the thread is already gone.
  async releaseTicket(ticket, reason) {
    if (!this.bindings) return
    const bound = this.bindings.get(ticket)
    this.bindings.release(ticket, reason)
    if (!bound) return
    const t = await this.client.channels.fetch(bound).catch(() => null)
    if (!t || !t.name.startsWith('🎫')) return
    const stripped = DiscordBridge.stripLabel(t.name)
    await t.setName(stripped || `ticket-${ticket}`).catch(() => {})
  }

  #buttons(record) {
    const rows = []
    let row = new ActionRowBuilder()
    const push = (b) => {
      if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder() }
      row.addComponents(b)
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
    push(new ButtonBuilder().setCustomId(`esc|${record.id}|cancel`).setLabel('🛑 Cancel').setStyle(ButtonStyle.Secondary))
    rows.push(row)
    return rows
  }

  #escalationBody(record) {
    // The review gate (#54) is the one kind whose prompt is a multi-line block
    // the daemon composed — summary, proposed charting, the links to look at. A
    // blockquote would mark only its first line, so it is printed as it stands.
    if (record.kind === REVIEW_KIND) {
      return [
        `**[${record.id}]** \`${record.worker}\` asks for review:`,
        '',
        record.prompt,
        '',
        '_✅ Approve to merge and resolve, or reply in this thread with what to change (that reply is a rejection and the worker gets your words)._',
      ].join('\n')
    }
    const head = `**[${record.id}]** \`${record.worker}\` asks (*${record.kind}*):\n> ${record.prompt}`
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

  // Render an escalation into its ticket thread; returns discord ids for the record.
  async renderEscalation(record, { files = [] } = {}) {
    const thread = await this.ensureThread(record.ticket)
    const msg = await thread.send({
      content: this.#escalationBody(record),
      components: this.#buttons(record),
      files,
    })
    return { channelId: this.channel.id, threadId: thread.id, messageId: msg.id }
  }

  async #editEscalationMessage(record, suffix) {
    if (!record.discord) return
    const thread = await this.client.channels.fetch(record.discord.threadId).catch(() => null)
    if (!thread) return
    const msg = await thread.messages.fetch(record.discord.messageId).catch(() => null)
    if (!msg) return
    await msg.edit({ content: `${this.#escalationBody(record)}\n\n${suffix}`, components: [] })
  }

  markAnswered(record) {
    return this.#editEscalationMessage(record, `✅ **answered** by <@${record.answered_by}> via ${record.answered_via}: \`${String(record.answer).slice(0, 200)}\``)
  }

  markCancelled(record) {
    return this.#editEscalationMessage(record, `🛑 **cancelled** by <@${record.cancelled_by}> — worker gets an "aborted" result, ticket re-frontiers`)
  }

  markSuperseded(record) {
    return this.#editEscalationMessage(record, `♻️ **superseded** by **${record.successor}** (the worker re-issued this question) — answer the newer message`)
  }

  async nudge(record) {
    if (!record.discord) return
    const thread = await this.client.channels.fetch(record.discord.threadId).catch(() => null)
    if (!thread) return
    await thread.send(`⏰ still waiting on **[${record.id}]**: ${record.prompt.slice(0, 150)}`)
  }

  // Fire-and-forget status line into the ticket thread; files = outbound images.
  async notify(ticket, message, { files = [] } = {}) {
    const thread = await this.ensureThread(ticket)
    await thread.send({ content: message, files })
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

  async #onInteraction(i) {
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
      if (action === 'cancel') {
        const result = this.handlers.cancel(id, { by: i.user.id })
        await i.reply(result.ok
          ? { content: `🛑 cancelled **${result.record.id}**` }
          : { content: `already closed (${result.reason})`, ephemeral: true })
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
  // transport (thread, typing, the 2000-char cap); everything said comes from
  // the host through `post`.
  async #overseerTurn(thread, prompt) {
    const typing = setInterval(() => thread.sendTyping().catch(() => {}), 8000)
    thread.sendTyping().catch(() => {})
    try {
      await this.handlers.overseerTurn(thread.id, prompt, {
        post: (text) => this.#sayChunked(thread, text),
      })
    } finally {
      clearInterval(typing)
    }
  }

  // Discord caps a message at 2000 chars.
  async #sayChunked(thread, text) {
    for (let i = 0; i < text.length; i += 1900) {
      await thread.send(text.slice(i, i + 1900))
    }
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
    // session (#89) — so a labeled ticket thread answers its worker's question
    // before the overseer ever hears the words.
    const open = this.handlers.findOpenForThread(m.channel.id)
    if (!open) {
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
      // the worker keeps a handle on the file. The image itself now also rides
      // back as a real content block (see `attachments`, #34).
      answer = [answer, ...attachments.map((p) => `[attachment: ${p}]`)].filter(Boolean).join('\n')
    }
    const result = this.handlers.answer(open.id, { answer, attachments, by: m.author.id, via: 'thread-reply' })
    await m.react(result.ok ? '✅' : '⚠️')
  }
}

// Discord bridge module (#31) — thin rendering + capture, no interpretation (#18).
//
// Owns: gateway connection, Alp-user-ID auth gate, thread-per-ticket rendering,
// button/reply capture, image passthrough both directions, the static
// slash-command manifest. Owns NO state: the ticket→thread map is a rebuildable
// ephemeral cache (#9); escalation truth lives in the daemon's EscalationStore.
//
// The daemon hands in a `handlers` object and calls back into the bridge to
// render; answers flow bridge → handlers.answer → store (first-valid-wins).

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  Client, GatewayIntentBits, ChannelType, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
} from 'discord.js'

const MAX_BUTTON_OPTIONS = 23 // 25 buttons max, minus cancel; keep rows tidy

// #18's five verbs — a static macro manifest; expansion only, never interpretation.
const SLASH_MANIFEST = [
  new SlashCommandBuilder().setName('frontier').setDescription('List takeable tickets')
    .addStringOption((o) => o.setName('repo').setDescription('Limit to one repo')),
  new SlashCommandBuilder().setName('status').setDescription('What is running right now'),
  new SlashCommandBuilder().setName('start').setDescription('Dispatch a worker on a ticket')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number').setRequired(true))
    .addStringOption((o) => o.setName('model').setDescription('Model override'))
    .addStringOption((o) => o.setName('backend').setDescription('Backend override')),
  new SlashCommandBuilder().setName('cancel').setDescription('Cancel a running ticket')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number').setRequired(true)),
  new SlashCommandBuilder().setName('attach').setDescription('Get the attach handle for a live session')
    .addStringOption((o) => o.setName('ticket').setDescription('Ticket number').setRequired(true)),
]

function expandCommand(i) {
  const opt = (name) => i.options.getString(name)
  switch (i.commandName) {
    case 'frontier': return `frontier${opt('repo') ? ' ' + opt('repo') : ''}`
    case 'status': return 'status'
    case 'start': return `start ${opt('ticket')}${opt('model') ? ' model=' + opt('model') : ''}${opt('backend') ? ' backend=' + opt('backend') : ''}`
    case 'cancel': return `cancel ${opt('ticket')}`
    case 'attach': return `attach ${opt('ticket')}`
    default: return null
  }
}

export class DiscordBridge {
  constructor({ token, allowedUsers, guildId, channelName = 'curia', dataDir, handlers, log = console.log }) {
    this.token = token
    this.allowedUsers = allowedUsers // array of user-id strings; the auth gate
    this.guildId = guildId
    this.channelName = channelName
    this.dataDir = dataDir
    this.handlers = handlers
    this.log = log
    this.threadByTicket = new Map() // ephemeral cache, rebuilt from Discord on demand
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
    this.channel = await this.#ensureChannel()
    await this.#registerSlashCommands()
    this.client.on('interactionCreate', (i) => this.#onInteraction(i).catch((e) => this.log('interaction error', e)))
    this.client.on('messageCreate', (m) => this.#onMessage(m).catch((e) => this.log('message error', e)))
    this.log(`[bridge] ready: guild=${this.guild.name} channel=#${this.channel.name}`)
  }

  async stop() {
    await this.client.destroy()
  }

  // Top-level channel, no category parent — dodges the permission-overwrite
  // quirk that hid threads from the bot in the pre-configured guild (#22).
  async #ensureChannel() {
    const channels = await this.guild.channels.fetch()
    const existing = channels.find((c) => c?.type === ChannelType.GuildText && c.name === this.channelName && !c.parentId)
    if (existing) return existing
    return this.guild.channels.create({ name: this.channelName, type: ChannelType.GuildText })
  }

  async #registerSlashCommands() {
    const rest = new REST().setToken(this.token)
    await rest.put(
      Routes.applicationGuildCommands(this.client.user.id, this.guild.id),
      { body: SLASH_MANIFEST.map((c) => c.toJSON()) },
    )
  }

  async ensureThread(ticket) {
    const name = `ticket-${ticket}`
    const cached = this.threadByTicket.get(ticket)
    if (cached) {
      const t = await this.client.channels.fetch(cached).catch(() => null)
      if (t) return t
      this.threadByTicket.delete(ticket)
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
    this.threadByTicket.set(ticket, thread.id)
    return thread
  }

  #buttons(record) {
    const rows = []
    let row = new ActionRowBuilder()
    const push = (b) => {
      if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder() }
      row.addComponents(b)
    }
    if (record.kind === 'approve-reject' || record.kind === 'preview-review') {
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

  async #downloadAttachments(escalationId, attachments) {
    const dir = path.join(this.dataDir, 'attachments', escalationId)
    const saved = []
    for (const a of attachments.values()) {
      fs.mkdirSync(dir, { recursive: true })
      const dest = path.join(dir, a.name)
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
      await i.deferReply()
      const reply = await this.handlers.command(canonical, i.user.id)
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

  async #onMessage(m) {
    if (m.author.bot || !m.channel.isThread()) return
    if (!this.authorized(m.author.id)) return
    const open = this.handlers.findOpenForThread(m.channel.id)
    if (!open) return
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
      answer = [answer, ...attachments.map((p) => `[attachment: ${p}]`)].filter(Boolean).join('\n')
    }
    const result = this.handlers.answer(open.id, { answer, by: m.author.id, via: 'thread-reply' })
    await m.react(result.ok ? '✅' : '⚠️')
  }
}

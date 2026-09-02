// The Discord card of integration setup (#876, filling the #874 seam under
// the #852 contract and the #853 journey).
//
// One module holds the whole Discord step: the token submission, the server
// list, the channel choice, and the verifier the frame asks on every read.
// Discord is reached over its REST API with the bot token and an injectable
// `fetch`, never through the gateway: the bridge (`bridge.mjs`) is the
// process that logs in, and it reads the token and the facts at boot, so
// this step ends with a service restart that starts it.
//
// THE TOKEN GOES ONE WAY. It arrives once, lands in `secrets/discord-bot-token`
// through `writeSecret` (owner-only, atomic), and from then on is read off
// that file for each call and dropped. No answer, no log line, no refusal,
// and no thrown sentence carries it: every message that leaves this module
// passes through `redact`, and the shapes are refused by name, never by
// echo. The facts beside it — the operator's user ID, the server, the
// channel name — are `state/discord.json` (#867), which any diagnostic may
// print whole.
//
// VERIFICATION IS THE CURRENT FACT, in the order the operator meets it:
//
//   1. the token is on disk (else the card is plain, "Ready to connect");
//   2. an operator ID is beside it;
//   3. Discord accepts the token;
//   4. the bot is in the selected server;
//   5. the operator is a member of that server;
//   6. the named text channel exists top-level and is reused, else created;
//   7. the bot holds, in that channel, every permission the bridge uses;
//   8. the command manifest registers on that server;
//   9. a confirmation message of curia's own stands in the channel — found
//      when one is there, posted when none is.
//
// Each miss is one failed verification with one corrective action and the
// stage it failed at, so the panel can draw the right form. Nothing is
// remembered between reads: a retry measures again, and a connection that
// is gone reads as gone.
//
// THE CONFIRMATION IS FOUND BEFORE IT IS POSTED. The frame reads every card
// on arrival and on Try again, and the app reads it once at boot for the
// Home pointer; a verifier that posted on every read would fill the channel
// with the same line. So the channel's recent messages are read first, and
// the bot's own confirmation, when it stands there, is the delivered one.
// Deleting it is how an operator asks for a fresh one.

import { readSecret, writeSecret, secretPath, redact, SecretError } from '../../cli/src/secrets.mjs'
import {
  readDiscordSettings, writeDiscordSettings, discordSettingsFromEnv, discordSettingsPath, DEFAULT_CHANNEL,
} from './discordsettings.mjs'
import { SLASH_MANIFEST } from './bridge.mjs'

export const DISCORD_API = 'https://discord.com/api/v10'

// How a confirmation message of curia's own begins. The read that looks for
// one matches on this prefix and on the bot's own author id.
export const CONFIRMATION_MARK = '✅ curia is connected'

// The shape of a bot token, checked so a refusal can be by name. Three
// dot-separated base64url parts, and never whitespace: a value with a space
// in it is a paste that went wrong, not a token.
const TOKEN_RE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/
const SNOWFLAKE = /^[0-9]{5,25}$/
const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/

// The permissions the bridge uses in the command channel, by Discord's bit.
// The invite link asks for these plus Manage Channels, which is what
// creating the channel takes when it does not exist.
const bit = (n) => 1n << BigInt(n)
export const CHANNEL_PERMISSIONS = Object.freeze([
  Object.freeze({ name: 'View Channel', bit: bit(10) }),
  Object.freeze({ name: 'Send Messages', bit: bit(11) }),
  Object.freeze({ name: 'Embed Links', bit: bit(14) }),
  Object.freeze({ name: 'Attach Files', bit: bit(15) }),
  Object.freeze({ name: 'Read Message History', bit: bit(16) }),
  Object.freeze({ name: 'Manage Threads', bit: bit(34) }),
  Object.freeze({ name: 'Create Public Threads', bit: bit(35) }),
  Object.freeze({ name: 'Send Messages in Threads', bit: bit(38) }),
])
const MANAGE_CHANNELS = bit(4)
const ADMINISTRATOR = bit(3)
export const INVITE_PERMISSIONS = CHANNEL_PERMISSIONS.reduce((bits, p) => bits | p.bit, 0n) | MANAGE_CHANNELS
export const inviteUrl = (appId) => `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`

const GUILD_TEXT = 0
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

function list(items, word = 'and') {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} ${word} ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, ${word} ${items[items.length - 1]}`
}

// The bot's permissions in one channel, computed the way Discord documents
// it: the guild-level permissions, then the @everyone overwrite, then the
// bot's role overwrites together, then the bot's own member overwrite. An
// Administrator holds everything and no overwrite takes it away.
export function channelPermissions({ base, overwrites = [], roles = [], botId, guildId }) {
  let bits = BigInt(base ?? 0)
  if (bits & ADMINISTRATOR) return ~0n
  const of = (id) => overwrites.find((o) => String(o.id) === String(id))
  const apply = (o) => { if (o) bits = (bits & ~BigInt(o.deny ?? 0)) | BigInt(o.allow ?? 0) }
  apply(of(guildId))
  let allow = 0n
  let deny = 0n
  for (const role of roles) {
    const o = of(role)
    if (!o) continue
    allow |= BigInt(o.allow ?? 0)
    deny |= BigInt(o.deny ?? 0)
  }
  bits = (bits & ~deny) | allow
  apply(overwrites.find((o) => Number(o.type) === 1 && String(o.id) === String(botId)))
  return bits
}

// A Discord answer that was not 2xx. `status` lets a caller tell "refused"
// from "absent"; the message is Discord's own sentence.
class DiscordError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// One REST call on the bot token. The token rides the header and nowhere
// else, and a failure's sentence is Discord's `message` or the status.
function client(token, fetchImpl) {
  return async (method, route, body = undefined) => {
    let res
    try {
      res = await fetchImpl(`${DISCORD_API}${route}`, {
        method,
        headers: { authorization: `Bot ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      throw new DiscordError(0, `Discord could not be reached (${redact(e.message, [token])})`)
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) throw new DiscordError(res.status, redact(String(data?.message ?? `${res.status} from Discord`), [token]))
    return data
  }
}

export class DiscordSetup {
  // `root` null is the source deployment: the token and the facts come off
  // the environment and there is no secret file to write. `bridgeState`
  // is what the connected card says about the live bridge, read fresh.
  constructor({ root = null, stateDir, env = process.env, fetchImpl = globalThis.fetch, bridgeState = () => null, log = console.log }) {
    this.root = root
    this.stateDir = stateDir
    this.env = env
    this.fetchImpl = fetchImpl
    this.bridgeState = bridgeState
    this.log = log
  }

  // The token off its file, by presence: `{ state, value }`, and a `why`
  // when the file is refused. `value` never leaves this module.
  #token() {
    if (!this.root) {
      const value = this.env.DISCORD_BOT_TOKEN || null
      return { state: value ? 'present' : 'absent', value, source: 'env' }
    }
    try {
      const value = readSecret(this.root, 'discord-bot-token')?.trim() || null
      return { state: value ? 'present' : 'absent', value, source: 'file' }
    } catch (e) {
      return { state: 'refused', value: null, source: 'file', why: e.message }
    }
  }

  #settings() {
    return this.root ? readDiscordSettings(this.stateDir) : discordSettingsFromEnv(this.env)
  }

  #api(token) {
    return client(token, this.fetchImpl)
  }

  // The panel's own read: whether the token is on disk, which bot it is,
  // which servers the bot is in, the invite link, and the safe facts. Never
  // the token. A Discord that refuses is `error`, not a throw, because the
  // panel still has a form to draw.
  async overview() {
    const token = this.#token()
    const out = {
      secret: token.state, source: token.source, file: this.root ? secretPath(this.root, 'discord-bot-token') : null,
      settings: this.#settings(), bot: null, guilds: [], invite_url: null, error: token.why ?? null,
    }
    if (token.state !== 'present') return out
    const api = this.#api(token.value)
    try {
      const me = await api('GET', '/users/@me')
      out.bot = { id: String(me.id), username: String(me.username ?? '') }
      out.invite_url = inviteUrl(await this.#appId(api, me))
      out.guilds = (await api('GET', '/users/@me/guilds')).map((g) => ({ id: String(g.id), name: String(g.name ?? '') }))
    } catch (e) {
      out.error = e.status === 401 ? 'Discord refused the bot token' : e.message
    }
    return out
  }

  async #appId(api, me) {
    try {
      const app = await api('GET', '/oauth2/applications/@me')
      return String(app?.id ?? me.id)
    } catch {
      return String(me.id)
    }
  }

  // The one submission (#852): the token and the operator's user ID, once.
  // The token lands in its secret file and the ID beside the facts already
  // kept; the answer is the overview, which carries no token.
  async submitToken({ token, user_id: userId } = {}) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw refuse('That is not the shape a Discord bot token takes. Copy the token from the Bot page of your application, with no spaces around it.')
    if (typeof userId !== 'string' || !SNOWFLAKE.test(userId)) throw refuse('That is not the shape a Discord user ID takes. It is a number of 17 to 20 digits, copied with Developer Mode on.')
    if (!this.root) throw refuse('This deployment reads the token from DISCORD_BOT_TOKEN in daemon/.env.daemon and has no secret file to write. Set the key there and restart the service.')
    try {
      writeSecret(this.root, 'discord-bot-token', `${token}\n`)
    } catch (e) {
      if (e instanceof SecretError) throw refuse(redact(e.message, [token]))
      throw e
    }
    const current = this.#settings()
    writeDiscordSettings(this.stateDir, { ...current, allowed_users: [userId] })
    this.log(`discord setup: the bot token landed in ${secretPath(this.root, 'discord-bot-token')} and the operator ID in ${discordSettingsPath(this.stateDir)}`)
    return this.overview()
  }

  // The server and the channel name, written beside the operator ID. The
  // verifier does the rest on the next read.
  async chooseChannel({ guild_id: guildId, channel } = {}) {
    if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) throw refuse('Select a server the bot is in.')
    if (typeof channel !== 'string' || !CHANNEL_NAME.test(channel)) throw refuse('That is not a Discord channel name. Use lowercase letters, digits, hyphens, and underscores.')
    if (!this.root) throw refuse('This deployment reads CURIA_GUILD_ID and CURIA_CHANNEL from daemon/.env.daemon. Set them there and restart the service.')
    const current = this.#settings()
    const settings = writeDiscordSettings(this.stateDir, { ...current, guild_id: guildId, channel })
    this.log(`discord setup: server ${guildId} and channel #${channel} landed in ${discordSettingsPath(this.stateDir)}`)
    return settings
  }

  // The frame's verifier (#874): `{ ok, primary, secondary, emoji, detail }`
  // or `{ ok: false, failed, action, detail }` or `{ ok: false, unconnected }`.
  verifier() {
    return async () => {
      const token = this.#token()
      if (token.state === 'absent') return { ok: false, unconnected: true }
      try {
        return await this.#verify(token)
      } catch (e) {
        const message = redact(e.message, [token.value])
        this.log(`discord setup: verification did not finish: ${message}`)
        return { ok: false, failed: message, action: 'Fix the cause the message names, then try again.', detail: { stage: 'unknown' } }
      }
    }
  }

  async #verify(token) {
    const fail = (stage, failed, action, more = {}) => ({ ok: false, failed, action, detail: { stage, ...more } })
    if (token.state === 'refused') {
      return fail('token', token.why, 'Fix the secret file the message names, then try again.')
    }
    let settings
    try {
      settings = this.#settings()
    } catch (e) {
      return fail('operator', e.message, `Fix ${discordSettingsPath(this.stateDir)}, or submit the token and your user ID again in this panel.`)
    }
    const operatorId = settings.allowed_users[0] ?? null
    if (!operatorId) {
      return fail('operator', 'No Discord user ID is set for the operator', 'Enter your Discord user ID beside the token in this panel, then try again.')
    }

    const api = this.#api(token.value)
    let me
    try {
      me = await api('GET', '/users/@me')
    } catch (e) {
      if (e.status === 401) return fail('token', 'Discord refused the bot token', 'Reset the token on the Bot page of your Discord application and submit the new one in this panel.')
      return fail('token', `Discord did not answer for the bot: ${e.message}`, 'Check this host\'s outbound access to discord.com, then try again.')
    }
    const bot = { id: String(me.id), username: String(me.username ?? '') }
    const appId = await this.#appId(api, me)
    const invite = { invite_url: inviteUrl(appId), bot }

    const rows = await api('GET', '/users/@me/guilds')
    const guilds = rows.map((g) => ({ id: String(g.id), name: String(g.name ?? '') }))
    if (!guilds.length) {
      return fail('server', `${bot.username || 'The bot'} is in no server`, 'Add the bot to your server with the invite link in this panel, then try again.', { ...invite, guilds })
    }
    const row = settings.guild_id ? rows.find((g) => String(g.id) === settings.guild_id) : rows[0]
    if (!row) {
      return fail('server', `${bot.username || 'The bot'} isn't in the selected server`, 'Select a server the bot is in, or add the bot to it with the invite link in this panel, then try again.', { ...invite, guilds })
    }
    const guild = { id: String(row.id), name: String(row.name ?? '') }
    const facts = { ...invite, guilds, guild }

    let member
    try {
      member = await api('GET', `/guilds/${guild.id}/members/${operatorId}`)
    } catch (e) {
      if (e.status === 404) {
        return fail('operator', `Discord user ${operatorId} isn't a member of ${guild.name}`, 'Join the server with that account, or correct the user ID in this panel, then try again.', facts)
      }
      return fail('operator', `curia could not look up the operator in ${guild.name}: ${e.message}`, 'Check the bot\'s access to the server, then try again.', facts)
    }
    const operator = { id: operatorId, username: String(member?.user?.username ?? ''), name: String(member?.user?.global_name ?? member?.nick ?? member?.user?.username ?? '') }
    facts.operator = operator

    // The channel: a top-level text channel of that name is the one the
    // bridge opens (`#ensureChannel`); one under a category is not, so the
    // rule here is the bridge's rule.
    const name = settings.channel || DEFAULT_CHANNEL
    const channels = await api('GET', `/guilds/${guild.id}/channels`)
    let channel = channels.find((c) => c && Number(c.type) === GUILD_TEXT && c.name === name && !c.parent_id) ?? null
    let created = false
    if (!channel) {
      try {
        channel = await api('POST', `/guilds/${guild.id}/channels`, { name, type: GUILD_TEXT })
        created = true
      } catch (e) {
        return fail('channel', `curia could not create #${name} in ${guild.name}: ${e.message}`, `Give the bot Manage Channels in ${guild.name}, or create the text channel #${name} yourself, then try again.`, facts)
      }
    }
    const channelFacts = { id: String(channel.id), name: String(channel.name ?? name), created, url: `https://discord.com/channels/${guild.id}/${channel.id}` }
    facts.channel = channelFacts

    // Authority in that channel, from the server permissions Discord computed
    // for the bot and the channel's own overwrites on the bot's roles.
    let roles = []
    try {
      roles = (await api('GET', `/users/@me/guilds/${guild.id}/member`))?.roles ?? []
    } catch {
      roles = []
    }
    const held = channelPermissions({ base: row.permissions, overwrites: channel.permission_overwrites ?? [], roles, botId: bot.id, guildId: guild.id })
    const missing = CHANNEL_PERMISSIONS.filter((p) => !(held & p.bit)).map((p) => p.name)
    if (missing.length) {
      return fail('authority', `curia can't ${list(missing, 'or')} in #${channelFacts.name}`, `Allow ${list(missing)} for the bot in #${channelFacts.name}'s permissions, then try again.`, facts)
    }

    let registered
    try {
      registered = await api('PUT', `/applications/${appId}/guilds/${guild.id}/commands`, SLASH_MANIFEST.map((c) => c.toJSON()))
    } catch (e) {
      return fail('commands', `Discord refused the command registration: ${e.message}`, 'Add the bot again with the invite link in this panel, which asks for the applications.commands scope, then try again.', facts)
    }
    const commands = (registered ?? []).map((c) => String(c.name))
    facts.commands = commands

    // The confirmation: curia's own, found when it stands in the channel,
    // posted when it does not.
    let confirmation = null
    try {
      const recent = await api('GET', `/channels/${channelFacts.id}/messages?limit=50`)
      const own = (recent ?? []).find((m) => String(m?.author?.id) === bot.id && String(m?.content ?? '').startsWith(CONFIRMATION_MARK))
      if (own) confirmation = { id: String(own.id), at: String(own.timestamp ?? ''), posted: false }
    } catch {
      confirmation = null
    }
    if (!confirmation) {
      const content = `${CONFIRMATION_MARK} to #${channelFacts.name}. <@${operator.id}> can command me here. ${commands.length} command${commands.length === 1 ? '' : 's'} registered: ${commands.map((c) => `/${c}`).join(', ')}.`
      try {
        const posted = await api('POST', `/channels/${channelFacts.id}/messages`, { content })
        confirmation = { id: String(posted.id), at: String(posted.timestamp ?? new Date().toISOString()), posted: true }
      } catch (e) {
        return fail('confirmation', `curia could not post in #${channelFacts.name}: ${e.message}`, `Allow View Channel and Send Messages for the bot in #${channelFacts.name}, then try again.`, facts)
      }
    }
    confirmation.url = `https://discord.com/channels/${guild.id}/${channelFacts.id}/${confirmation.id}`
    facts.confirmation = confirmation
    facts.bridge = this.bridgeState()

    return {
      ok: true,
      emoji: '💬',
      primary: `#${channelFacts.name} · ${guild.name}`,
      secondary: `Confirmation delivered · ${commands.length} command${commands.length === 1 ? '' : 's'} registered`,
      detail: facts,
    }
  }
}

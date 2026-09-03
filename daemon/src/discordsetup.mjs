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
//   4. the bot is in at least one server, and the operator has selected one;
//   5. the operator is a member of that server;
//   6. the named text channel exists top-level;
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
// A VERIFICATION READ CREATES NOTHING (#891). The frame reads every card on
// arrival, on the Setup page's refresh, and once at boot, and the first
// packaged rehearsal found that such a read had picked the bot's first server
// and created `#curia` before the operator had chosen either. So the read
// never picks a server for the operator and never creates a channel: with
// no server chosen it fails on the server, with no channel there it fails
// on the channel, and the one place a channel is created is `chooseChannel`,
// the Connect channel press, which reuses a top-level text channel of that
// name and creates one otherwise, the bridge's `#ensureChannel` rule.
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

// How the registered commands differ from the bridge's manifest, by name
// and description: one phrase per difference, empty when they match. The
// options are the manifest's to send; a difference there rides the next
// registration without failing a read.
export function manifestDrift(registered) {
  const byName = new Map(registered.map((c) => [String(c?.name), c]))
  const out = []
  for (const command of SLASH_MANIFEST) {
    const row = byName.get(command.name)
    if (!row) out.push(`/${command.name} is not registered`)
    else if (String(row.description ?? '') !== command.description) out.push(`/${command.name} has another description`)
    byName.delete(command.name)
  }
  for (const name of byName.keys()) out.push(`/${name} is registered and not curia's`)
  return out
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
// from "absent"; the message is Discord's own sentence. A 429 carries
// `retryAfter`, the whole seconds Discord asks this bot to wait (#891).
class DiscordError extends Error {
  constructor(status, message, retryAfter = null) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
  get rateLimited() { return this.status === 429 }
}

// The sentence every surface uses for a rate limit: a fact and the wait,
// never advice to add the bot again.
export const rateLimitSentence = (retryAfter) => `Discord is rate limiting this bot; it answers again in ${retryAfter} s`
const waitAction = (retryAfter) => `Wait ${retryAfter} s for Discord's limit to pass, then try again.`

// The wait off a 429: `retry_after` in the body (seconds, fractional), else
// the Retry-After header, rounded up so the wait is never too short.
function retryAfterOf(res, data) {
  const raw = data?.retry_after ?? res.headers?.get?.('retry-after') ?? null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 1
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
    if (res.status === 429) {
      const wait = retryAfterOf(res, data)
      throw new DiscordError(429, rateLimitSentence(wait), wait)
    }
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
    // The last answer a verification finished with, so a read Discord rate
    // limits keeps the card where it was instead of failing it (#891).
    this.last = null
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
      settings: this.#settings(), bot: null, guilds: [], invite_url: null, error: token.why ?? null, retry_after: null,
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
      if (e.rateLimited) out.retry_after = e.retryAfter
    }
    return out
  }

  async #appId(api, me) {
    try {
      const app = await api('GET', '/oauth2/applications/@me')
      return String(app?.id ?? me.id)
    } catch (e) {
      if (e.rateLimited) throw e
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

  // The Connect channel press: the server and the channel name land beside
  // the operator ID, then the channel is reused when a top-level text
  // channel of that name is there and created when it is not, and the
  // command manifest is registered on the server once (#891). This is the
  // only call that creates anything on Discord, and with Register commands
  // and the bridge's boot the only one that registers. A creation Discord
  // refuses is a refusal with the corrective action; the choice stays
  // written, so the next press or the operator's own channel completes it.
  // A registration Discord refuses is left to the next read, which fails on
  // the commands and names Register commands. Answers `{ settings, channel:
  // { id, name, created } | null, commands: string[] | null }`.
  async chooseChannel({ guild_id: guildId, channel } = {}) {
    if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) throw refuse('Select a server the bot is in.')
    if (typeof channel !== 'string' || !CHANNEL_NAME.test(channel)) throw refuse('That is not a Discord channel name. Use lowercase letters, digits, hyphens, and underscores.')
    if (!this.root) throw refuse('This deployment reads CURIA_GUILD_ID and CURIA_CHANNEL from daemon/.env.daemon. Set them there and restart the service.')
    const current = this.#settings()
    const settings = writeDiscordSettings(this.stateDir, { ...current, guild_id: guildId, channel })
    this.log(`discord setup: server ${guildId} and channel #${channel} landed in ${discordSettingsPath(this.stateDir)}`)
    const token = this.#token()
    if (token.state !== 'present') return { settings, channel: null }
    const api = this.#api(token.value)
    let guildName = guildId
    try {
      const row = (await api('GET', '/users/@me/guilds')).find((g) => String(g.id) === guildId)
      if (!row) throw refuse('Select a server the bot is in.')
      guildName = String(row.name ?? guildId)
    } catch (e) {
      if (e.refusal) throw e
      throw refuse(`curia could not list the bot's servers: ${redact(e.message, [token.value])}`)
    }
    const found = await this.#findChannel(api, guildId, channel)
    let made = null
    if (!found) {
      try {
        made = await api('POST', `/guilds/${guildId}/channels`, { name: channel, type: GUILD_TEXT })
        this.log(`discord setup: created #${channel} in ${guildName}`)
      } catch (e) {
        throw refuse(`curia could not create #${channel} in ${guildName}: ${redact(e.message, [token.value])}. Give the bot Manage Channels in ${guildName}, or create the text channel #${channel} yourself, then select Connect channel again.`)
      }
    }
    const row = found ?? made
    const channelFacts = { id: String(row.id), name: String(row.name ?? channel), created: !found }
    let commands = null
    try {
      commands = (await this.registerCommands({ api, token: token.value, guildId, guildName })).commands
    } catch (e) {
      this.log(`discord setup: ${e.message}`)
    }
    return { settings, channel: channelFacts, commands }
  }

  // The Register commands press, and Connect channel's own registration:
  // the bridge's manifest lands on the selected server through one PUT,
  // which replaces what was registered. A read never does this (#891):
  // Discord counts every registration against a daily limit per server,
  // and the Setup page reads every few seconds. Answers `{ commands }`,
  // the registered names. A refusal names the fix; a rate limit names the
  // wait.
  async registerCommands({ api = null, token = null, guildId = null, guildName = null } = {}) {
    if (!api) {
      const got = this.#token()
      if (got.state !== 'present') throw refuse('Submit the bot token in this panel first.')
      token = got.value
      api = this.#api(token)
    }
    let settings = null
    try {
      settings = this.#settings()
    } catch (e) {
      throw refuse(redact(e.message, [token]))
    }
    guildId = guildId ?? settings?.guild_id ?? null
    if (!guildId) throw refuse('Select the server and the channel name in this panel, then select Connect channel.')
    try {
      const me = await api('GET', '/users/@me')
      const appId = await this.#appId(api, me)
      if (!guildName) guildName = String((await api('GET', '/users/@me/guilds')).find((g) => String(g.id) === guildId)?.name ?? guildId)
      const registered = await api('PUT', `/applications/${appId}/guilds/${guildId}/commands`, SLASH_MANIFEST.map((c) => c.toJSON()))
      const commands = (registered ?? []).map((c) => String(c.name))
      this.log(`discord setup: registered ${commands.length} commands in ${guildName}`)
      return { commands }
    } catch (e) {
      if (e.rateLimited) throw refuse(`${e.message}. Wait, then select Register commands again.`)
      throw refuse(`curia could not register the commands in ${guildName}: ${redact(e.message, [token])}. Add the bot again with the invite link in this panel, which asks for the applications.commands scope, then select Register commands again.`)
    }
  }

  // The channel the bridge opens (`#ensureChannel`): a top-level text
  // channel of that name. One under a category is not the one.
  async #findChannel(api, guildId, name) {
    const channels = await api('GET', `/guilds/${guildId}/channels`)
    return channels.find((c) => c && Number(c.type) === GUILD_TEXT && c.name === name && !c.parent_id) ?? null
  }

  // The frame's verifier (#874): `{ ok, primary, secondary, emoji, detail }`
  // or `{ ok: false, failed, action, detail }` or `{ ok: false, unconnected }`.
  // A read Discord rate limits (429 on any call) is not a verification
  // that failed: the card keeps the last answer, with the wait as its
  // supporting line or its action, and the first read under a limit fails
  // on the wait alone. Nothing here advises adding the bot again.
  verifier() {
    return async () => {
      const token = this.#token()
      if (token.state === 'absent') return { ok: false, unconnected: true }
      try {
        const answer = await this.#verify(token)
        this.last = answer
        return answer
      } catch (e) {
        if (e.rateLimited) return this.#rateLimited(e.retryAfter)
        const message = redact(e.message, [token.value])
        this.log(`discord setup: verification did not finish: ${message}`)
        return { ok: false, failed: message, action: 'Fix the cause the message names, then try again.', detail: { stage: 'unknown' } }
      }
    }
  }

  #rateLimited(retryAfter) {
    const sentence = rateLimitSentence(retryAfter)
    const rateLimit = { retry_after: retryAfter, until: new Date(Date.now() + retryAfter * 1000).toISOString() }
    this.log(`discord setup: ${sentence}`)
    const last = this.last
    if (last?.ok) return { ...last, secondary: sentence, detail: { ...last.detail, rate_limit: rateLimit } }
    if (last && !last.unconnected) return { ...last, action: waitAction(retryAfter), detail: { ...last.detail, rate_limit: rateLimit } }
    return { ok: false, failed: sentence, action: waitAction(retryAfter), detail: { stage: 'rate_limit', rate_limit: rateLimit } }
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
      if (e.rateLimited) throw e
      if (e.status === 401) return fail('token', 'Discord refused the bot token', 'Reset the token on the Bot page of your Discord application and submit the new one in this panel.')
      return fail('token', `Discord did not answer for the bot: ${e.message}`, 'Check this host\'s outbound access to discord.com, then try again.')
    }
    const bot = { id: String(me.id), username: String(me.username ?? '') }
    const appId = await this.#appId(api, me)
    const invite = { invite_url: inviteUrl(appId), bot }

    const rows = await api('GET', '/users/@me/guilds')
    const guilds = rows.map((g) => ({ id: String(g.id), name: String(g.name ?? '') }))
    // The bot in no server yet, and no server chosen yet, are the steps
    // between the token and the channel (#891): the card is plain with the
    // stage, never failed, because the panel waits for the first and asks
    // for the second on its own.
    if (!guilds.length || !settings.guild_id) {
      return { ok: false, unconnected: true, detail: { stage: 'server', ...invite, guilds } }
    }
    const row = rows.find((g) => String(g.id) === settings.guild_id)
    if (!row) {
      return fail('server', `${bot.username || 'The bot'} isn't in the selected server`, 'Select a server the bot is in, or add the bot to it with the invite link in this panel, then try again.', { ...invite, guilds })
    }
    const guild = { id: String(row.id), name: String(row.name ?? '') }
    const facts = { ...invite, guilds, guild }

    let member
    try {
      member = await api('GET', `/guilds/${guild.id}/members/${operatorId}`)
    } catch (e) {
      if (e.rateLimited) throw e
      if (e.status === 404) {
        return fail('operator', `Discord user ${operatorId} isn't a member of ${guild.name}`, 'Join the server with that account, or correct the user ID in this panel, then try again.', facts)
      }
      return fail('operator', `curia could not look up the operator in ${guild.name}: ${e.message}`, 'Check the bot\'s access to the server, then try again.', facts)
    }
    const operator = { id: operatorId, username: String(member?.user?.username ?? ''), name: String(member?.user?.global_name ?? member?.nick ?? member?.user?.username ?? '') }
    facts.operator = operator

    // The channel: the one the bridge opens, found and never created here.
    // Connect channel is the press that creates it.
    const name = settings.channel || DEFAULT_CHANNEL
    const channel = await this.#findChannel(api, guild.id, name)
    if (!channel) {
      return fail('channel', `#${name} isn't a top-level text channel in ${guild.name}`, `Select Connect channel in this panel to create #${name}, or create the text channel yourself, then try again.`, facts)
    }
    const channelFacts = { id: String(channel.id), name: String(channel.name ?? name), created: false, url: `https://discord.com/channels/${guild.id}/${channel.id}` }
    facts.channel = channelFacts

    // Authority in that channel, from the server permissions Discord computed
    // for the bot and the channel's own overwrites on the bot's roles.
    let roles = []
    try {
      roles = (await api('GET', `/users/@me/guilds/${guild.id}/member`))?.roles ?? []
    } catch (e) {
      if (e.rateLimited) throw e
      roles = []
    }
    const held = channelPermissions({ base: row.permissions, overwrites: channel.permission_overwrites ?? [], roles, botId: bot.id, guildId: guild.id })
    const missing = CHANNEL_PERMISSIONS.filter((p) => !(held & p.bit)).map((p) => p.name)
    if (missing.length) {
      return fail('authority', `curia can't ${list(missing, 'or')} in #${channelFacts.name}`, `Allow ${list(missing)} for the bot in #${channelFacts.name}'s permissions, then try again.`, facts)
    }

    // The commands: read, never registered here (#891). Connect channel and
    // the bridge's boot register; a difference from the manifest by name or
    // description is the failed verification, and Register commands is the
    // one press that replaces what stands.
    let registered
    try {
      registered = await api('GET', `/applications/${appId}/guilds/${guild.id}/commands`)
    } catch (e) {
      if (e.rateLimited) throw e
      return fail('commands', `curia could not read the registered commands: ${e.message}`, 'Select Register commands in this panel. If Discord refuses that too, add the bot again with the invite link in this panel, which asks for the applications.commands scope, then try again.', facts)
    }
    const commands = (registered ?? []).map((c) => String(c.name))
    facts.commands = commands
    const drift = manifestDrift(registered ?? [])
    if (drift.length) {
      return fail('commands', `The commands registered in ${guild.name} differ from curia's: ${list(drift)}`, 'Select Register commands in this panel to register the current commands, then try again.', facts)
    }

    // The confirmation: curia's own, found when it stands in the channel,
    // posted when it does not.
    let confirmation = null
    try {
      const recent = await api('GET', `/channels/${channelFacts.id}/messages?limit=50`)
      const own = (recent ?? []).find((m) => String(m?.author?.id) === bot.id && String(m?.content ?? '').startsWith(CONFIRMATION_MARK))
      if (own) confirmation = { id: String(own.id), at: String(own.timestamp ?? ''), posted: false }
    } catch (e) {
      if (e.rateLimited) throw e
      confirmation = null
    }
    if (!confirmation) {
      const content = `${CONFIRMATION_MARK} to #${channelFacts.name}. <@${operator.id}> can command me here. ${commands.length} command${commands.length === 1 ? '' : 's'} registered: ${commands.map((c) => `/${c}`).join(', ')}.`
      try {
        const posted = await api('POST', `/channels/${channelFacts.id}/messages`, { content })
        confirmation = { id: String(posted.id), at: String(posted.timestamp ?? new Date().toISOString()), posted: true }
      } catch (e) {
        if (e.rateLimited) throw e
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

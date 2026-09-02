// The Discord card of integration setup (#876, filling the #874 seam under the
// #852 contract).
//
// What is pinned: the token goes straight to `secrets/discord-bot-token` and
// comes back in no answer, no log, and no refusal; the operator's user ID and
// the chosen server and channel are the safe facts in `state/discord.json`;
// verification is the current external fact, in the order the operator meets
// it: the token, the operator, the server, the channel (reused when usable,
// created otherwise), the bot's authority in it, the registered commands,
// and the confirmation message. Every miss is one failed verification with
// one corrective action, and a retry measures again. Nothing here touches the
// network: Discord is a fake `fetch`.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeSecret, readSecret } from '../../cli/src/secrets.mjs'
import { writeDiscordSettings, readDiscordSettings } from '../src/discordsettings.mjs'
import { DiscordSetup, CONFIRMATION_MARK, CHANNEL_PERMISSIONS, channelPermissions } from '../src/discordsetup.mjs'
import { SLASH_MANIFEST } from '../src/bridge.mjs'

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.this-token-must-never-be-shown-anywhere-1234'
const OPERATOR = '111111111111111111'
const BOT = '222222222222222222'
const GUILD = '333333333333333333'
const CHANNEL = '444444444444444444'
const APP = '555555555555555555'

// A Discord that answers by route. Every call is recorded with its method,
// its authorization header, and its body, so a test can say what was asked
// and with which credential.
function discord(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const route = url.replace('https://discord.com/api/v10', '')
    const method = init.method ?? 'GET'
    calls.push({ route, method, auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : null })
    const answer = routes[`${method} ${route}`] ?? (method === 'GET' ? routes[route] : undefined)
    if (!answer) return { ok: false, status: 404, text: async () => JSON.stringify({ message: `Unknown route ${route}` }) }
    const [status, body] = typeof answer === 'function' ? answer() : answer
    return { ok: status >= 200 && status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)) }
  }
  return { fetchImpl, calls }
}

// Guild-level permissions the bot holds in the fake server: everything the
// channel needs plus Manage Channels, as the invite link asks for.
const ALL = String(CHANNEL_PERMISSIONS.reduce((bits, p) => bits | p.bit, 0n) | (1n << 4n))

const guildRow = (over = {}) => ({ id: GUILD, name: 'Alp\'s workshop', permissions: ALL, ...over })
const textChannel = (over = {}) => ({ id: CHANNEL, type: 0, name: 'curia', parent_id: null, permission_overwrites: [], ...over })
// What Discord answers for the registered commands: the manifest as it
// stands on the server, by name and description, in Discord's own order.
const registered = (over = (rows) => rows) => over(SLASH_MANIFEST.map((c, i) => ({ id: String(i), name: c.name, description: c.description })))
const manifestAnswer = () => [200, registered()]
const RATE_LIMITED = [429, { message: 'You are being rate limited.', retry_after: 12.3, global: false }]

// The happy path, route by route. A test overrides what it wants to fail.
function happy(over = {}) {
  return {
    '/users/@me': [200, { id: BOT, username: 'curia-box', bot: true }],
    '/oauth2/applications/@me': [200, { id: APP, name: 'curia-box' }],
    '/users/@me/guilds': [200, [guildRow()]],
    [`/guilds/${GUILD}/members/${OPERATOR}`]: [200, { user: { id: OPERATOR, username: 'alp', global_name: 'Alp' }, roles: [] }],
    [`/users/@me/guilds/${GUILD}/member`]: [200, { user: { id: BOT }, roles: [] }],
    [`/guilds/${GUILD}/channels`]: [200, [textChannel()]],
    [`/applications/${APP}/guilds/${GUILD}/commands`]: manifestAnswer(),
    [`PUT /applications/${APP}/guilds/${GUILD}/commands`]: manifestAnswer(),
    [`/channels/${CHANNEL}/messages?limit=50`]: [200, []],
    [`POST /channels/${CHANNEL}/messages`]: [200, { id: '777', timestamp: '2026-09-02T10:00:00.000Z' }],
    ...over,
  }
}

describe('the Discord card (#876)', () => {
  let root
  let stateDir
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-discord-'))
    stateDir = path.join(root, 'state')
    fs.mkdirSync(path.join(root, 'secrets'), { mode: 0o700 })
    fs.mkdirSync(stateDir, { mode: 0o700 })
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const setupOver = (routes, over = {}) => {
    const d = discord(routes)
    const log = []
    const setup = new DiscordSetup({ root, stateDir, fetchImpl: d.fetchImpl, log: (line) => log.push(line), bridgeState: () => 'up', ...over })
    return { setup, d, log, verify: setup.verifier() }
  }
  const connected = () => {
    writeSecret(root, 'discord-bot-token', `${TOKEN}\n`)
    writeDiscordSettings(stateDir, { allowed_users: [OPERATOR], guild_id: GUILD, channel: 'curia' })
  }

  describe('the token', () => {
    test('with no token on disk the card is unconnected, and Discord is not asked anything', async () => {
      const { verify, d } = setupOver(happy())
      assert.deepEqual(await verify({ progress: {} }), { ok: false, unconnected: true })
      assert.equal(d.calls.length, 0)
    })

    test('submitting the token and the user ID writes the token to its secret file, owner-only, and the ID to state/discord.json, and the answer never carries the token', async () => {
      const { setup, log } = setupOver(happy())
      const out = await setup.submitToken({ token: TOKEN, user_id: OPERATOR })
      assert.equal(readSecret(root, 'discord-bot-token').trim(), TOKEN)
      assert.equal(fs.statSync(path.join(root, 'secrets', 'discord-bot-token')).mode & 0o777, 0o600)
      assert.deepEqual(readDiscordSettings(stateDir), { allowed_users: [OPERATOR], guild_id: null, channel: 'curia' })
      assert.equal(out.secret, 'present')
      assert.deepEqual(out.bot, { id: BOT, username: 'curia-box' })
      assert.deepEqual(out.guilds, [{ id: GUILD, name: 'Alp\'s workshop' }])
      assert.match(out.invite_url, new RegExp(`client_id=${APP}&scope=bot%20applications.commands&permissions=\\d+$`))
      assert.ok(!JSON.stringify(out).includes(TOKEN), 'the answer never carries the token')
      assert.ok(!log.join('\n').includes(TOKEN), 'the log never carries the token')
      assert.ok(!fs.readFileSync(path.join(stateDir, 'discord.json'), 'utf8').includes(TOKEN))
    })

    test('a token or a user ID that is not the shape Discord issues is refused by shape, and the refusal never echoes the value', async () => {
      const { setup } = setupOver(happy())
      for (const token of ['', 'not a token', `${TOKEN} `, 'x'.repeat(600)]) {
        await assert.rejects(() => setup.submitToken({ token, user_id: OPERATOR }), (e) => e.refusal && /bot token/.test(e.message) && !e.message.includes(token.trim() || 'never'))
      }
      await assert.rejects(() => setup.submitToken({ token: TOKEN, user_id: 'alp' }), (e) => e.refusal && /Discord user ID/.test(e.message) && !e.message.includes(TOKEN))
      assert.equal(readSecret(root, 'discord-bot-token'), null)
    })

    test('without an installation root there is no secret file to write, and the refusal names the environment key instead', async () => {
      const d = discord(happy())
      const setup = new DiscordSetup({ root: null, stateDir, env: {}, fetchImpl: d.fetchImpl, log: () => {} })
      await assert.rejects(() => setup.submitToken({ token: TOKEN, user_id: OPERATOR }), (e) => e.refusal && /DISCORD_BOT_TOKEN/.test(e.message) && !e.message.includes(TOKEN))
      assert.deepEqual(await setup.verifier()({ progress: {} }), { ok: false, unconnected: true })
    })

    test('a token Discord refuses is one failed verification, and the action is a new token, and the sentence never carries the old one', async () => {
      connected()
      const { verify, log } = setupOver(happy({ '/users/@me': [401, { message: '401: Unauthorized' }] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /Discord refused the bot token/)
      assert.match(answer.action, /Reset the token/)
      assert.equal(answer.detail.stage, 'token')
      assert.ok(!JSON.stringify(answer).includes(TOKEN))
      assert.ok(!log.join('\n').includes(TOKEN))
    })

    test('a secret file that reaches past its owner is a failed verification naming the file, never its content', async () => {
      connected()
      fs.chmodSync(path.join(root, 'secrets', 'discord-bot-token'), 0o644)
      const { verify, d } = setupOver(happy())
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /discord-bot-token/)
      assert.ok(!JSON.stringify(answer).includes(TOKEN))
      assert.equal(d.calls.length, 0)
    })
  })

  describe('the operator and the server', () => {
    test('a token with no operator ID beside it fails before Discord is asked, and the action is the ID', async () => {
      writeSecret(root, 'discord-bot-token', TOKEN)
      writeDiscordSettings(stateDir, { allowed_users: [] })
      const { verify, d } = setupOver(happy())
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /No Discord user ID/)
      assert.match(answer.action, /user ID/)
      assert.equal(answer.detail.stage, 'operator')
      assert.equal(d.calls.length, 0)
    })

    test('the overview lists the servers the bot is in, by id and name, on the token from disk', async () => {
      connected()
      const { setup, d } = setupOver(happy({ '/users/@me/guilds': [200, [guildRow(), guildRow({ id: '999', name: 'Testing' })]] }))
      const out = await setup.overview()
      assert.deepEqual(out.guilds, [{ id: GUILD, name: 'Alp\'s workshop' }, { id: '999', name: 'Testing' }])
      assert.deepEqual(out.settings, { allowed_users: [OPERATOR], guild_id: GUILD, channel: 'curia' })
      assert.equal(d.calls.find((c) => c.route === '/users/@me/guilds').auth, `Bot ${TOKEN}`)
      assert.ok(!JSON.stringify(out).includes(TOKEN))
    })

    test('a bot in no server fails on the server, and the action is the invite link', async () => {
      writeSecret(root, 'discord-bot-token', TOKEN)
      writeDiscordSettings(stateDir, { allowed_users: [OPERATOR] })
      const { verify } = setupOver(happy({ '/users/@me/guilds': [200, []] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /is in no server/)
      assert.match(answer.action, /invite link/i)
      assert.equal(answer.detail.stage, 'server')
      assert.match(answer.detail.invite_url, /discord\.com\/oauth2\/authorize/)
    })

    test('a selected server the bot is not in names the server, and the guild list rides the detail', async () => {
      connected()
      const { verify } = setupOver(happy({ '/users/@me/guilds': [200, [guildRow({ id: '999', name: 'Testing' })]] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /isn't in the selected server/)
      assert.equal(answer.detail.stage, 'server')
      assert.deepEqual(answer.detail.guilds, [{ id: '999', name: 'Testing' }])
    })

    test('an operator who is not a member of the server is the failed verification, and the action is the account or the ID', async () => {
      connected()
      const { verify } = setupOver(happy({ [`/guilds/${GUILD}/members/${OPERATOR}`]: [404, { message: 'Unknown Member' }] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, new RegExp(`${OPERATOR} isn't a member of Alp's workshop`))
      assert.match(answer.action, /user ID/)
      assert.equal(answer.detail.stage, 'operator')
    })

    test('choosing the server and the channel writes the two facts beside the operator ID, and reuses the channel that is there', async () => {
      writeSecret(root, 'discord-bot-token', TOKEN)
      writeDiscordSettings(stateDir, { allowed_users: [OPERATOR] })
      const { setup } = setupOver(happy({ [`/guilds/${GUILD}/channels`]: [200, [textChannel({ name: 'ops' })]] }))
      assert.deepEqual(await setup.chooseChannel({ guild_id: GUILD, channel: 'ops' }), { settings: { allowed_users: [OPERATOR], guild_id: GUILD, channel: 'ops' }, channel: { id: CHANNEL, name: 'ops', created: false }, commands: SLASH_MANIFEST.map((c) => c.name) })
      assert.deepEqual(readDiscordSettings(stateDir), { allowed_users: [OPERATOR], guild_id: GUILD, channel: 'ops' })
      await assert.rejects(() => setup.chooseChannel({ guild_id: 'x', channel: 'ops' }), (e) => e.refusal && /server/.test(e.message))
      await assert.rejects(() => setup.chooseChannel({ guild_id: GUILD, channel: 'Bad Channel' }), (e) => e.refusal && /channel name/.test(e.message))
    })
  })

  describe('the channel', () => {
    test('a usable text channel of that name is reused, and nothing is created', async () => {
      connected()
      const { verify, d } = setupOver(happy())
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true)
      assert.deepEqual(answer.detail.channel, { id: CHANNEL, name: 'curia', created: false, url: `https://discord.com/channels/${GUILD}/${CHANNEL}` })
      assert.equal(d.calls.some((c) => c.method === 'POST' && c.route === `/guilds/${GUILD}/channels`), false)
    })

    test('nothing is created before Connect channel: a token with no server chosen fails on the server, even when the bot is in one', async () => {
      writeSecret(root, 'discord-bot-token', TOKEN)
      writeDiscordSettings(stateDir, { allowed_users: [OPERATOR] })
      const { verify, d } = setupOver(happy({ [`/guilds/${GUILD}/channels`]: [200, []], [`POST /guilds/${GUILD}/channels`]: [201, textChannel({ id: '888' })] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.equal(answer.detail.stage, 'server')
      assert.match(answer.failed, /No server is selected/)
      assert.match(answer.action, /Connect channel/)
      assert.deepEqual(answer.detail.guilds, [{ id: GUILD, name: 'Alp\'s workshop' }])
      assert.equal(d.calls.some((c) => c.method === 'POST'), false, 'a verification read creates nothing and posts nothing')
    })

    test('a channel that is not there at verification is the failed verification, and the read creates nothing', async () => {
      connected()
      const { verify, d } = setupOver(happy({ [`/guilds/${GUILD}/channels`]: [200, [textChannel({ parent_id: '1' }), textChannel({ id: '2', type: 2 })]], [`POST /guilds/${GUILD}/channels`]: [201, textChannel({ id: '888' })] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.equal(answer.detail.stage, 'channel')
      assert.match(answer.failed, /#curia isn't a top-level text channel in Alp's workshop/)
      assert.match(answer.action, /Connect channel/)
      assert.equal(d.calls.some((c) => c.method === 'POST'), false)
    })

    test('Connect channel creates the top-level text channel when there is none, and the next verification reuses it', async () => {
      writeSecret(root, 'discord-bot-token', TOKEN)
      writeDiscordSettings(stateDir, { allowed_users: [OPERATOR] })
      let channels = [textChannel({ parent_id: '1' }), textChannel({ id: '2', type: 2 })]
      const { setup, verify, d } = setupOver(happy({
        [`/guilds/${GUILD}/channels`]: () => [200, channels],
        [`POST /guilds/${GUILD}/channels`]: () => { channels = [...channels, textChannel({ id: '888' })]; return [201, textChannel({ id: '888' })] },
        '/channels/888/messages?limit=50': [200, []],
        'POST /channels/888/messages': [200, { id: '779', timestamp: '2026-09-02T10:00:00.000Z' }],
      }))
      const chosen = await setup.chooseChannel({ guild_id: GUILD, channel: 'curia' })
      assert.deepEqual(chosen.settings, { allowed_users: [OPERATOR], guild_id: GUILD, channel: 'curia' })
      assert.deepEqual(chosen.channel, { id: '888', name: 'curia', created: true })
      assert.deepEqual(d.calls.find((c) => c.method === 'POST' && c.route === `/guilds/${GUILD}/channels`).body, { name: 'curia', type: 0 })
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true)
      assert.equal(answer.detail.channel.id, '888')
      assert.equal(d.calls.filter((c) => c.method === 'POST' && c.route === `/guilds/${GUILD}/channels`).length, 1, 'created once, on the press')
    })

    test('a creation Discord refuses is the refusal Connect channel answers, and the action is Manage Channels or a channel made by hand', async () => {
      writeSecret(root, 'discord-bot-token', TOKEN)
      writeDiscordSettings(stateDir, { allowed_users: [OPERATOR] })
      const { setup } = setupOver(happy({
        [`/guilds/${GUILD}/channels`]: [200, []],
        [`POST /guilds/${GUILD}/channels`]: [403, { message: 'Missing Permissions' }],
      }))
      await assert.rejects(() => setup.chooseChannel({ guild_id: GUILD, channel: 'ops' }), (e) => e.refusal
        && /could not create #ops in Alp's workshop: Missing Permissions/.test(e.message) && /Manage Channels/.test(e.message) && !e.message.includes(TOKEN))
      assert.deepEqual(readDiscordSettings(stateDir), { allowed_users: [OPERATOR], guild_id: GUILD, channel: 'ops' }, 'the choice is kept for the next press')
    })

    test('a channel overwrite that takes Send Messages from the bot fails on authority, naming what is missing', async () => {
      connected()
      const deny = String((1n << 11n) | (1n << 35n))
      const { verify, d } = setupOver(happy({
        [`/guilds/${GUILD}/channels`]: [200, [textChannel({ permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny }] })]],
      }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /can't Send Messages or Create Public Threads in #curia/)
      assert.match(answer.action, /Allow Send Messages and Create Public Threads for the bot in #curia/)
      assert.equal(answer.detail.stage, 'authority')
      assert.equal(d.calls.some((c) => c.route.startsWith(`/applications/`)), false, 'commands are not registered on a channel the bot cannot use')
    })
  })

  describe('the commands and the confirmation', () => {
    test('a verification read reads the registered commands and never registers them (#891)', async () => {
      connected()
      const { verify, d } = setupOver(happy())
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true)
      assert.equal(answer.detail.commands.length, SLASH_MANIFEST.length)
      assert.equal(d.calls.some((c) => c.method === 'PUT'), false, 'a read makes no PUT')
      assert.ok(d.calls.some((c) => c.method === 'GET' && c.route === `/applications/${APP}/guilds/${GUILD}/commands`))
      await verify({ progress: {} })
      assert.equal(d.calls.filter((c) => c.method === 'PUT').length, 0, 'and neither does the next one')
    })

    test('Connect channel registers the manifest once, and the read after it makes no PUT', async () => {
      writeSecret(root, 'discord-bot-token', `${TOKEN}\n`)
      writeDiscordSettings(stateDir, { allowed_users: [OPERATOR] })
      const { setup, verify, d } = setupOver(happy())
      const out = await setup.chooseChannel({ guild_id: GUILD, channel: 'curia' })
      const puts = d.calls.filter((c) => c.method === 'PUT')
      assert.equal(puts.length, 1)
      assert.equal(puts[0].route, `/applications/${APP}/guilds/${GUILD}/commands`)
      assert.ok(puts[0].body.some((c) => c.name === 'tickets' && c.description), 'the manifest the bridge registers is the one sent')
      assert.equal(out.commands.length, SLASH_MANIFEST.length)
      await verify({ progress: {} })
      assert.equal(d.calls.filter((c) => c.method === 'PUT').length, 1)
    })

    test('registered commands that differ from the manifest by name or description fail on the commands, and the action is one press that registers again', async () => {
      connected()
      const drifted = registered((rows) => rows.filter((r) => r.name !== 'tickets').map((r) => (r.name === 'status' ? { ...r, description: 'An older sentence' } : r)))
      let current = drifted
      const { setup, verify, d } = setupOver(happy({ [`/applications/${APP}/guilds/${GUILD}/commands`]: () => [200, current] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.equal(answer.detail.stage, 'commands')
      assert.match(answer.failed, /\/tickets is not registered/)
      assert.match(answer.failed, /\/status has another description/)
      assert.match(answer.action, /Register commands/)
      assert.doesNotMatch(answer.action, /invite link/)
      assert.equal(d.calls.some((c) => c.method === 'PUT'), false, 'the read itself registers nothing')
      const out = await setup.registerCommands()
      assert.equal(d.calls.filter((c) => c.method === 'PUT').length, 1)
      assert.equal(out.commands.length, SLASH_MANIFEST.length)
      current = registered()
      assert.equal((await verify({ progress: {} })).ok, true)
    })

    test('a read Discord refuses on the commands names the read, and the action is Register commands before the invite', async () => {
      connected()
      const { verify } = setupOver(happy({ [`/applications/${APP}/guilds/${GUILD}/commands`]: [403, { message: 'Missing Access' }] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /could not read the registered commands: Missing Access/)
      assert.match(answer.action, /Register commands/)
      assert.match(answer.action, /applications\.commands/)
      assert.equal(answer.detail.stage, 'commands')
    })

    test('a registration Discord refuses is the refusal Register commands answers, naming the scope', async () => {
      connected()
      const { setup } = setupOver(happy({ [`PUT /applications/${APP}/guilds/${GUILD}/commands`]: [403, { message: 'Missing Access' }] }))
      await assert.rejects(() => setup.registerCommands(), (e) => e.refusal && /could not register the commands in Alp's workshop: Missing Access/.test(e.message) && /applications\.commands/.test(e.message) && !e.message.includes(TOKEN))
    })

    test('a rate limit is a fact with the wait, and the card keeps its previous state', async () => {
      connected()
      let limited = false
      const { verify, d } = setupOver(happy({ '/users/@me': () => (limited ? RATE_LIMITED : [200, { id: BOT, username: 'curia-box', bot: true }]) }))
      const before = await verify({ progress: {} })
      assert.equal(before.ok, true)
      limited = true
      const seen = d.calls.length
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true, 'the connected card stays connected')
      assert.equal(answer.primary, before.primary)
      assert.equal(answer.secondary, 'Discord is rate limiting this bot; it answers again in 13 s')
      assert.deepEqual(answer.detail.rate_limit, { retry_after: 13, until: answer.detail.rate_limit.until })
      assert.equal(answer.detail.channel.id, CHANNEL)
      assert.ok(!JSON.stringify(answer).includes('invite link'))
      assert.equal(d.calls.slice(seen).some((c) => c.method === 'PUT' || c.method === 'POST'), false, 'the limited read writes nothing')
    })

    test('a rate limit on the first read is a failed verification whose action is the wait, never the invite', async () => {
      connected()
      const { verify } = setupOver(happy({ '/users/@me': RATE_LIMITED }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.equal(answer.failed, 'Discord is rate limiting this bot; it answers again in 13 s')
      assert.match(answer.action, /Wait 13 s/)
      assert.doesNotMatch(answer.action, /invite/)
      assert.equal(answer.detail.stage, 'rate_limit')
      assert.equal(answer.detail.rate_limit.retry_after, 13)
    })

    test('a rate limit on the confirmation lookup posts nothing and keeps the previous failed card, with the wait as the action', async () => {
      connected()
      let limited = false
      const { verify, d } = setupOver(happy({
        [`/channels/${CHANNEL}/messages?limit=50`]: () => (limited ? RATE_LIMITED : [200, []]),
        [`POST /channels/${CHANNEL}/messages`]: [403, { message: 'Missing Access' }],
      }))
      const before = await verify({ progress: {} })
      assert.equal(before.detail.stage, 'confirmation')
      limited = true
      const posts = d.calls.filter((c) => c.method === 'POST').length
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.equal(answer.failed, before.failed)
      assert.match(answer.action, /Wait 13 s/)
      assert.equal(answer.detail.rate_limit.retry_after, 13)
      assert.equal(d.calls.filter((c) => c.method === 'POST').length, posts, 'the limited read posts nothing')
    })

    test('the overview reports a rate limit as the wait, not as a refused bot', async () => {
      connected()
      const { setup } = setupOver(happy({ '/users/@me': RATE_LIMITED }))
      const out = await setup.overview()
      assert.equal(out.error, 'Discord is rate limiting this bot; it answers again in 13 s')
      assert.equal(out.retry_after, 13)
    })

    test('a confirmation the channel does not hold yet is posted, and the connected card shows the channel, the delivery, and the commands', async () => {
      connected()
      const { verify, d } = setupOver(happy())
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true)
      assert.equal(answer.emoji, '💬')
      assert.equal(answer.primary, '#curia · Alp\'s workshop')
      assert.equal(answer.secondary, 'Confirmation delivered · 12 commands registered')
      const posted = d.calls.find((c) => c.method === 'POST' && c.route === `/channels/${CHANNEL}/messages`)
      assert.ok(posted.body.content.startsWith(CONFIRMATION_MARK))
      assert.match(posted.body.content, new RegExp(`<@${OPERATOR}>`))
      assert.deepEqual(answer.detail.confirmation, { id: '777', at: '2026-09-02T10:00:00.000Z', posted: true, url: `https://discord.com/channels/${GUILD}/${CHANNEL}/777` })
      assert.equal(answer.detail.commands.length, 12)
      assert.deepEqual(answer.detail.operator, { id: OPERATOR, username: 'alp', name: 'Alp' })
      assert.deepEqual(answer.detail.guild, { id: GUILD, name: 'Alp\'s workshop' })
      assert.equal(answer.detail.bridge, 'up')
      assert.ok(!JSON.stringify(answer).includes(TOKEN), 'the token is used and never reported')
    })

    test('a confirmation the bot already posted is found, not posted again, and a read is what the card reports', async () => {
      connected()
      const { verify, d } = setupOver(happy({
        [`/channels/${CHANNEL}/messages?limit=50`]: [200, [
          { id: '700', author: { id: OPERATOR }, content: `${CONFIRMATION_MARK} (typed by a person)`, timestamp: '2026-09-01T00:00:00.000Z' },
          { id: '701', author: { id: BOT }, content: `${CONFIRMATION_MARK} to #curia.`, timestamp: '2026-09-01T09:00:00.000Z' },
        ]],
      }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, true)
      assert.deepEqual(answer.detail.confirmation, { id: '701', at: '2026-09-01T09:00:00.000Z', posted: false, url: `https://discord.com/channels/${GUILD}/${CHANNEL}/701` })
      assert.equal(d.calls.some((c) => c.method === 'POST' && c.route === `/channels/${CHANNEL}/messages`), false)
    })

    test('a confirmation that cannot be posted is the failed verification, with the two permissions as the action', async () => {
      connected()
      const { verify } = setupOver(happy({ [`POST /channels/${CHANNEL}/messages`]: [403, { message: 'Missing Access' }] }))
      const answer = await verify({ progress: {} })
      assert.equal(answer.ok, false)
      assert.match(answer.failed, /could not post in #curia: Missing Access/)
      assert.match(answer.action, /View Channel and Send Messages/)
      assert.equal(answer.detail.stage, 'confirmation')
    })

    test('a retry measures again: the same verifier that failed connects once the cause is gone', async () => {
      connected()
      let refuse = true
      const { verify } = setupOver(happy({ [`/applications/${APP}/guilds/${GUILD}/commands`]: () => (refuse ? [403, { message: 'Missing Access' }] : manifestAnswer()) }))
      assert.equal((await verify({ progress: {} })).ok, false)
      refuse = false
      assert.equal((await verify({ progress: {} })).ok, true)
      refuse = true
      assert.equal((await verify({ progress: {} })).ok, false, 'and nothing remembers a connection that is gone')
    })
  })

  describe('channel authority', () => {
    test('is computed the way Discord computes it: base, then @everyone, then roles, then the member, and Administrator is everything', () => {
      const send = 1n << 11n
      const view = 1n << 10n
      assert.equal(channelPermissions({ base: String(send | view), overwrites: [], roles: [], botId: BOT, guildId: GUILD }), send | view)
      assert.equal(channelPermissions({ base: String(send | view), overwrites: [{ id: GUILD, type: 0, allow: '0', deny: String(send) }], roles: [], botId: BOT, guildId: GUILD }), view)
      assert.equal(channelPermissions({
        base: String(view), overwrites: [{ id: GUILD, type: 0, allow: '0', deny: String(view) }, { id: 'r1', type: 0, allow: String(view | send), deny: '0' }], roles: ['r1'], botId: BOT, guildId: GUILD,
      }), view | send)
      assert.equal(channelPermissions({
        base: String(view | send), overwrites: [{ id: 'r1', type: 0, allow: '0', deny: String(send) }, { id: BOT, type: 1, allow: String(send), deny: '0' }], roles: ['r1'], botId: BOT, guildId: GUILD,
      }), view | send)
      const everything = channelPermissions({ base: String(1n << 3n), overwrites: [{ id: GUILD, type: 0, allow: '0', deny: String(view) }], roles: [], botId: BOT, guildId: GUILD })
      assert.equal(everything & view, view)
    })
  })
})

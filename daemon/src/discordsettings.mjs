// The Discord facts that are not the bot token (#867, for #876).
//
// The token is a long-lived credential and lives in `secrets/discord-bot-token`.
// Everything else the bridge needs is a safe identifier: which operator may
// speak, which guild, which command channel. Under an installation root those
// live in `state/discord.json`, written once by the Discord integration step of
// setup and read at boot. In the source deployment they stay the three
// environment keys `daemon/.env.daemon` has carried since #33.
//
// No value in this file is a secret, so a diagnostic may print it whole.

import fs from 'node:fs'
import path from 'node:path'

import { writeAtomically } from '../../cli/src/atomic.mjs'

export const DISCORD_SETTINGS_FILE = 'discord.json'
export const DEFAULT_CHANNEL = 'curia'

export const discordSettingsPath = (stateDir) => path.join(stateDir, DISCORD_SETTINGS_FILE)

const SNOWFLAKE = /^[0-9]{5,25}$/

function checked(data, source) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${source}: not a mapping`)
  const users = data.allowed_users
  if (!Array.isArray(users) || users.some((u) => typeof u !== 'string' || !SNOWFLAKE.test(u))) {
    throw new Error(`${source}: allowed_users must be a list of Discord user IDs`)
  }
  const guild = data.guild_id ?? null
  if (guild !== null && (typeof guild !== 'string' || !SNOWFLAKE.test(guild))) {
    throw new Error(`${source}: guild_id must be a Discord guild ID or absent`)
  }
  const channel = data.channel ?? DEFAULT_CHANNEL
  if (typeof channel !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(channel)) {
    throw new Error(`${source}: channel must be a Discord channel name`)
  }
  for (const key of Object.keys(data)) {
    if (!['allowed_users', 'guild_id', 'channel'].includes(key)) throw new Error(`${source}: unknown key ${key}`)
  }
  return { allowed_users: [...users], guild_id: guild, channel }
}

// The settings, or the empty answer when there is no file: no operator may
// speak, so the bridge does not start, which is what a fresh installation
// runs until setup writes the file.
export function readDiscordSettings(stateDir) {
  const file = discordSettingsPath(stateDir)
  let text
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link. Replace the link with the real file.`)
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { allowed_users: [], guild_id: null, channel: DEFAULT_CHANNEL }
    throw e
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${file}: not JSON`)
  }
  return checked(data, file)
}

export function writeDiscordSettings(stateDir, data) {
  const settings = checked(data, discordSettingsPath(stateDir))
  writeAtomically(discordSettingsPath(stateDir), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  return settings
}

// The source deployment's answer, off the environment (#33). The list is
// comma-separated, and an empty list stops the bridge from starting.
export function discordSettingsFromEnv(env) {
  return {
    allowed_users: String(env.DISCORD_ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    guild_id: env.CURIA_GUILD_ID || null,
    channel: env.CURIA_CHANNEL || DEFAULT_CHANNEL,
  }
}

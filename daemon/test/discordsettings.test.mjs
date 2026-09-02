// The Discord facts beside the token (#867): safe identifiers in
// `state/discord.json` under an installation root, environment keys in the
// source deployment. Nothing here is a secret.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readDiscordSettings, writeDiscordSettings, discordSettingsFromEnv, discordSettingsPath, DEFAULT_CHANNEL,
} from '../src/discordsettings.mjs'

let tmp

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-discord-')) })
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('state/discord.json', () => {
  test('no file is the empty answer: nobody may speak, so the bridge stays off', () => {
    assert.deepEqual(readDiscordSettings(path.join(tmp, 'none')), { allowed_users: [], guild_id: null, channel: DEFAULT_CHANNEL })
  })

  test('a write lands owner-only and reads back checked and whole', () => {
    const state = path.join(tmp, 'state')
    fs.mkdirSync(state)
    const written = writeDiscordSettings(state, { allowed_users: ['123456789012345678'], guild_id: '987654321098765432' })
    assert.deepEqual(written, { allowed_users: ['123456789012345678'], guild_id: '987654321098765432', channel: DEFAULT_CHANNEL })
    assert.equal(fs.statSync(discordSettingsPath(state)).mode & 0o777, 0o600)
    assert.deepEqual(readDiscordSettings(state), written)
  })

  test('a malformed file is refused by name, never guessed', () => {
    const state = path.join(tmp, 'bad')
    fs.mkdirSync(state)
    fs.writeFileSync(discordSettingsPath(state), '{"allowed_users":"alp"}')
    assert.throws(() => readDiscordSettings(state), /allowed_users must be a list of Discord user IDs/)
    fs.writeFileSync(discordSettingsPath(state), '{"allowed_users":[],"token":"x"}')
    assert.throws(() => readDiscordSettings(state), /unknown key token/)
    assert.throws(() => writeDiscordSettings(state, { allowed_users: [], channel: 'Bad Channel' }), /channel must be/)
  })
})

describe('the environment answer (#33)', () => {
  test('reads the three keys the source deployment carries', () => {
    assert.deepEqual(
      discordSettingsFromEnv({ DISCORD_ALLOWED_USERS: '1, 2 ,,3', CURIA_GUILD_ID: '9', CURIA_CHANNEL: 'ops' }),
      { allowed_users: ['1', '2', '3'], guild_id: '9', channel: 'ops' },
    )
    assert.deepEqual(discordSettingsFromEnv({}), { allowed_users: [], guild_id: null, channel: DEFAULT_CHANNEL })
  })
})

// #143: speaker identities (#108 item 15) need Manage Webhooks. Without the
// grant every worker send raised `Missing Permissions`, fell back to the bot
// voice, and said so in the daemon log only — so the identities were off for a
// day and no one saw it. These tests pin the two halves of the fix: the words
// still always land, and the degradation reaches the channel once.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiscordBridge } from '../src/bridge.mjs'
import { lintReply } from '../src/messaging.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curia-speakers-test-'))

// Discord's own error shape for a missing permission.
const missingPermissions = () => Object.assign(new Error('Missing Permissions'), { code: 50013 })

describe('speaker-identity degradation (#143)', () => {
  let bridge, announced, asHook, asBot, webhookFault

  beforeEach(() => {
    announced = [] // top-level channel lines — where a notice lands
    asHook = [] // sends that carried a speaker identity
    asBot = [] // sends that fell back to the bot voice
    webhookFault = null // set to make the webhook call fail

    const thread = {
      id: 't-1',
      name: '🎫 85',
      send: async (payload) => { asBot.push(payload?.content ?? payload) },
      setName: async () => {},
    }
    bridge = new DiscordBridge({
      token: 'x', allowedUsers: [], dataDir: tmp(), handlers: {}, log: () => {},
      bindings: { get: () => 't-1', bind: () => ({ ok: true }), release: () => {}, last: () => null },
    })
    bridge.guild = { id: 'G' }
    bridge.channel = {
      id: 'C',
      send: async (payload) => { announced.push(payload?.content ?? payload) },
      fetchWebhooks: async () => {
        if (webhookFault) throw webhookFault
        return [{ name: 'curia-speakers', token: 'tok', send: async (m) => { asHook.push(m); return { id: 'm-1' } } }]
      },
      createWebhook: async () => { throw new Error('should not mint: the fixture already has one') },
    }
    bridge.client = { channels: { fetch: async () => thread }, user: null }
  })

  test('the boot probe announces the missing grant once, and /state carries it', async () => {
    webhookFault = missingPermissions()
    await bridge.probeSpeakers()

    assert.equal(announced.length, 1)
    assert.match(announced[0], /Speaker identities are off/)
    assert.match(announced[0], /Manage Webhooks/)
    assert.equal(bridge.status().speakers.ok, false)
    assert.equal(bridge.status().speakers.reason, 'Missing Permissions')

    // every later send falls back in silence — one notice, not one per send
    await bridge.notify('85', 'first', { as: 'curia-85 · a ticket' })
    await bridge.notify('85', 'second', { as: 'curia-85 · a ticket' })
    assert.deepEqual(asBot, ['first', 'second'], 'the words always land')
    assert.equal(asHook.length, 0)
    assert.equal(announced.length, 1, 'the notice does not repeat')
  })

  test('a healthy probe announces nothing and warms the hook', async () => {
    await bridge.probeSpeakers()
    assert.deepEqual(announced, [])
    assert.equal(bridge.status().speakers.ok, true)

    await bridge.notify('85', 'hello', { as: 'curia-85 · a ticket' })
    assert.equal(asBot.length, 0)
    assert.equal(asHook.length, 1)
    assert.equal(asHook[0].username, 'curia-85 · a ticket')
    assert.equal(asHook[0].threadId, 't-1')
  })

  test('a grant withdrawn while the daemon runs is caught at the send', async () => {
    await bridge.probeSpeakers()
    assert.equal(bridge.status().speakers.ok, true)

    bridge.hook = null // the warmed hook is gone with the permission
    webhookFault = missingPermissions()
    await bridge.notify('85', 'after the loss', { as: 'curia-85 · a ticket' })

    assert.deepEqual(asBot, ['after the loss'])
    assert.equal(announced.length, 1)
    assert.match(announced[0], /Speaker identities are off/)
  })

  test('a grant that lands while the daemon runs heals with no restart, and says so', async () => {
    webhookFault = missingPermissions()
    await bridge.probeSpeakers()
    assert.equal(announced.length, 1)

    webhookFault = null // the operator granted the permission
    await bridge.notify('85', 'under my own name', { as: 'curia-85 · a ticket' })

    assert.equal(asHook.length, 1, 'the send path is never disabled, so it simply works')
    assert.equal(announced.length, 2)
    assert.match(announced[1], /Speaker identities are on/)
    assert.equal(bridge.status().speakers.ok, true)

    // and a second loss is announced again — the latch cleared with the recovery
    bridge.hook = null
    webhookFault = missingPermissions()
    await bridge.notify('85', 'lost again', { as: 'curia-85 · a ticket' })
    assert.equal(announced.length, 3)
    assert.match(announced[2], /Speaker identities are off/)
  })

  test('a webhook that fails for another reason is announced with its own words', async () => {
    webhookFault = new Error('503 Service Unavailable')
    await bridge.probeSpeakers()
    assert.match(announced[0], /the channel webhook failed \(503 Service Unavailable\)/)
    assert.doesNotMatch(announced[0], /Manage Webhooks/, 'do not send the operator after a permission that is already granted')
  })
})

describe('the notice text (#143)', () => {
  test('both notices conform to the #95 messaging standard', () => {
    assert.deepEqual(lintReply(DiscordBridge.speakerNotice(missingPermissions())), [])
    assert.deepEqual(lintReply(DiscordBridge.speakerNotice(new Error('boom'))), [])
    assert.deepEqual(lintReply(DiscordBridge.SPEAKERS_BACK), [])
  })

  test('the permission case is recognized by code and by message', () => {
    const byCode = DiscordBridge.speakerNotice(Object.assign(new Error('50013: whatever'), { code: 50013 }))
    const byMessage = DiscordBridge.speakerNotice(new Error('DiscordAPIError[50013]: Missing Permissions'))
    for (const notice of [byCode, byMessage]) assert.match(notice, /Manage Webhooks/)
  })
})

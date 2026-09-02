// The integration setup frame (#874, building the accepted journey #853 and
// the setup contract #852).
//
// Four rules are pinned here, at the one seam the daemon routes and the page
// both cross. The operator selects the four cards in any order, and the
// selection survives a close. What survives is a safe checkpoint and never a
// completion marker: a card is connected only when its verifier says so on
// this read. A failed verification carries one corrective action. The Full
// loop stays unavailable until every card is connected AND the gate seam
// (#880) supplies its verified facts, and a stub verifier reports "not
// available" so the frame is testable before #875 to #879 land.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  IntegrationSetup, CARDS, PROVIDERS, PROGRESS_FIELDS, SETUP_FILE, setupPath,
} from '../src/setup.mjs'

const TOKEN = 'MTIz.this-value-must-never-be-stored.abc'

describe('the integration setup frame (#874)', () => {
  let tmp
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-setup-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const connected = (primary, secondary = 'verified', emoji = '✅') => async () => ({ ok: true, primary, secondary, emoji })
  const failed = (what, action) => async () => ({ ok: false, failed: what, action })

  test('the four cards are the accepted ones, in the accepted order, and the model card owns both providers', () => {
    assert.deepEqual(CARDS, ['github', 'discord', 'tailscale', 'model'])
    assert.deepEqual(PROVIDERS, ['openai', 'anthropic'])
  })

  test('a fresh installation opens on the first card with no progress, and no file is written by a read', () => {
    const setup = new IntegrationSetup({ stateDir: tmp })
    assert.deepEqual(setup.read(), { step: 'github', progress: {} })
    assert.ok(!fs.existsSync(setupPath(tmp)), 'a read writes nothing')
  })

  test('selecting a card in any order is remembered, and a reopen restores it', () => {
    const setup = new IntegrationSetup({ stateDir: tmp })
    setup.remember({ step: 'tailscale' })
    assert.equal(new IntegrationSetup({ stateDir: tmp }).read().step, 'tailscale')
    setup.remember({ step: 'github' })
    assert.equal(new IntegrationSetup({ stateDir: tmp }).read().step, 'github')
    assert.equal(path.basename(setupPath(tmp)), SETUP_FILE)
    assert.equal(fs.statSync(setupPath(tmp)).mode & 0o777, 0o600)
  })

  test('a card that is not one of the four is refused by name', () => {
    const setup = new IntegrationSetup({ stateDir: tmp })
    assert.throws(() => setup.remember({ step: 'full' }), (e) => e.refusal && /"full" is not a setup card/.test(e.message))
    assert.throws(() => setup.remember({ step: 'github; rm' }), (e) => e.refusal)
  })

  test('safe progress is kept per card through the closed field list, and nothing else is', () => {
    const setup = new IntegrationSetup({ stateDir: tmp })
    setup.remember({ progress: { discord: { guild_id: '123456789', channel: 'ops' } } })
    setup.remember({ progress: { tailscale: { machine_name: 'curia.sh' } } })
    setup.remember({ progress: { model: { provider: 'anthropic' } } })
    const again = new IntegrationSetup({ stateDir: tmp }).read()
    assert.deepEqual(again.progress, {
      discord: { guild_id: '123456789', channel: 'ops' },
      tailscale: { machine_name: 'curia.sh' },
      model: { provider: 'anthropic' },
    })
    // The second write for one card replaces that card's fields and leaves
    // the other cards alone.
    setup.remember({ progress: { discord: { channel: 'curia' } } })
    assert.deepEqual(new IntegrationSetup({ stateDir: tmp }).read().progress.discord, { channel: 'curia' })
    assert.equal(new IntegrationSetup({ stateDir: tmp }).read().progress.tailscale.machine_name, 'curia.sh')
  })

  test('a secret never enters the resumption file, whatever key it arrives under', () => {
    const setup = new IntegrationSetup({ stateDir: tmp })
    for (const bad of [
      { discord: { token: TOKEN } },
      { discord: { bot_token: TOKEN } },
      { github: { pem: TOKEN } },
      { model: { api_key: TOKEN } },
      { openai: { provider: 'openai' } },
    ]) {
      assert.throws(() => setup.remember({ progress: bad }), (e) => e.refusal && !e.message.includes(TOKEN))
    }
    assert.ok(!fs.existsSync(setupPath(tmp)))
    // A value in an allowed field is bounded and shaped, so a token cannot
    // ride a channel name either.
    assert.throws(() => setup.remember({ progress: { discord: { channel: TOKEN } } }), (e) => e.refusal && !e.message.includes(TOKEN))
    assert.throws(() => setup.remember({ progress: { model: { provider: 'other' } } }), (e) => e.refusal)
  })

  test('the field list is the whole vocabulary a later ticket may store, by card', () => {
    assert.deepEqual(Object.keys(PROGRESS_FIELDS), CARDS)
    assert.deepEqual(PROGRESS_FIELDS.github, ['app_name'])
    assert.deepEqual(PROGRESS_FIELDS.discord, ['guild_id', 'channel'])
    assert.deepEqual(PROGRESS_FIELDS.tailscale, ['machine_name'])
    assert.deepEqual(PROGRESS_FIELDS.model, ['provider'])
  })

  test('a completion marker in the file is not a fact: it is dropped on read and never written', () => {
    fs.writeFileSync(setupPath(tmp), JSON.stringify({
      format: 1, step: 'discord', progress: { github: { app_name: 'Curia for box' } }, complete: ['github'], connected: { github: true },
    }))
    const setup = new IntegrationSetup({ stateDir: tmp })
    assert.deepEqual(setup.read(), { step: 'discord', progress: { github: { app_name: 'Curia for box' } } })
    setup.remember({ step: 'model' })
    const written = JSON.parse(fs.readFileSync(setupPath(tmp), 'utf8'))
    assert.deepEqual(Object.keys(written).sort(), ['format', 'progress', 'step'])
  })

  test('an unreadable file resets to the first card rather than refusing setup, and says so', () => {
    fs.writeFileSync(setupPath(tmp), '{not json')
    const lines = []
    const setup = new IntegrationSetup({ stateDir: tmp, log: (l) => lines.push(l) })
    assert.deepEqual(setup.read(), { step: 'github', progress: {} })
    assert.match(lines.join('\n'), /setup\.json/)
  })

  // ---- fresh verification ----------------------------------------------------

  test('with no verifier a card reports not available: nothing is connected, and the empty footer names what will appear', async () => {
    const setup = new IntegrationSetup({ stateDir: tmp })
    const status = await setup.status()
    assert.deepEqual(status.cards.map((c) => c.key), CARDS)
    for (const card of status.cards) {
      assert.equal(card.state, 'unavailable')
      assert.equal(card.footer, null)
      assert.equal(card.error, null)
      assert.match(card.pending, /will appear after/)
    }
    assert.equal(status.full_loop.ready, false)
    assert.deepEqual(status.full_loop.missing, CARDS)
  })

  test('a connected card comes from the verifier on this read, and progress alone never connects one', async () => {
    const setup = new IntegrationSetup({
      stateDir: tmp,
      verifiers: { github: connected('#861 · Chart backup and recovery lifecycle', 'ready-for-agent · alp82/curia · 9 open tickets', '🎫') },
    })
    setup.remember({ progress: { discord: { guild_id: '123456789', channel: 'curia' }, github: { app_name: 'Curia for box' } } })
    const status = await setup.status()
    const github = status.cards.find((c) => c.key === 'github')
    assert.equal(github.state, 'connected')
    assert.deepEqual(github.footer, {
      primary: '#861 · Chart backup and recovery lifecycle', secondary: 'ready-for-agent · alp82/curia · 9 open tickets', emoji: '🎫',
    })
    const discord = status.cards.find((c) => c.key === 'discord')
    assert.equal(discord.state, 'unavailable', 'stored Discord facts are a checkpoint, not a connection')
    assert.deepEqual(status.progress.discord, { guild_id: '123456789', channel: 'curia' })
  })

  test('a verifier that says yes once and no next time disconnects the card on the next read', async () => {
    let answer = { ok: true, primary: 'curia.tail1234.ts.net', secondary: 'alp@example.com · Serve reachable in 38 ms', emoji: '🔒' }
    const setup = new IntegrationSetup({ stateDir: tmp, verifiers: { tailscale: async () => answer } })
    assert.equal((await setup.status()).cards.find((c) => c.key === 'tailscale').state, 'connected')
    answer = { ok: false, failed: 'Tailscale Serve is not reachable', action: 'Run tailscale serve --bg 8445 on this host, then try again.' }
    const card = (await setup.status()).cards.find((c) => c.key === 'tailscale')
    assert.equal(card.state, 'failed')
    assert.equal(card.footer, null)
  })

  test('a failed verification names the failure and exactly one corrective action', async () => {
    const setup = new IntegrationSetup({
      stateDir: tmp,
      verifiers: { discord: failed('Curia cannot post in #curia', 'Allow View Channel and Send Messages for the Curia role, then try again.') },
    })
    const card = (await setup.status()).cards.find((c) => c.key === 'discord')
    assert.equal(card.state, 'failed')
    assert.deepEqual(card.error, {
      failed: 'Curia cannot post in #curia',
      action: 'Allow View Channel and Send Messages for the Curia role, then try again.',
    })
  })

  test('a verifier that throws is a failed verification with the thrown sentence and one action, never a dead frame', async () => {
    const setup = new IntegrationSetup({
      stateDir: tmp,
      verifiers: { github: async () => { throw new Error(`GitHub answered 401 for ${TOKEN}`) } },
    })
    const status = await setup.status()
    const card = status.cards.find((c) => c.key === 'github')
    assert.equal(card.state, 'failed')
    assert.match(card.error.failed, /GitHub answered 401/)
    assert.equal(typeof card.error.action, 'string')
    assert.ok(card.error.action.length > 0)
    assert.equal(status.cards.length, 4, 'the other cards are still reported')
  })

  test('the verifier receives the stored progress of its own card and the state directory, nothing else', async () => {
    const seen = []
    const setup = new IntegrationSetup({
      stateDir: tmp,
      verifiers: { tailscale: async (ctx) => { seen.push(ctx); return { ok: true, primary: 'x', secondary: 'y' } } },
    })
    setup.remember({ progress: { tailscale: { machine_name: 'curia.sh' }, discord: { channel: 'ops' } } })
    await setup.status()
    assert.deepEqual(seen, [{ stateDir: tmp, progress: { machine_name: 'curia.sh' } }])
  })

  test('one card verifies alone, for the ticket that just connected it', async () => {
    const setup = new IntegrationSetup({ stateDir: tmp, verifiers: { discord: connected('#curia', 'Confirmation delivered · 6 commands registered', '💬') } })
    const card = await setup.verify('discord')
    assert.equal(card.key, 'discord')
    assert.equal(card.state, 'connected')
    await assert.rejects(() => setup.verify('full'), /"full" is not a setup card/)
  })

  // ---- the model card ---------------------------------------------------------

  test('the model card is connected by either provider, names every connected one, and stays available for the second', async () => {
    const setup = new IntegrationSetup({
      stateDir: tmp,
      verifiers: { anthropic: connected('Anthropic', 'verification request completed in 1.4 s', '⚡') },
    })
    const card = (await setup.status()).cards.find((c) => c.key === 'model')
    assert.equal(card.state, 'connected')
    assert.equal(card.providers.anthropic.state, 'connected')
    assert.equal(card.providers.openai.state, 'unavailable')
    assert.equal(card.footer.primary, 'Anthropic')
    assert.equal(card.badge, 'Provider verified')
  })

  test('two connected providers say so, joined on the footer', async () => {
    const setup = new IntegrationSetup({
      stateDir: tmp,
      verifiers: {
        openai: connected('OpenAI', 'verification request completed in 0.9 s', '⚡'),
        anthropic: connected('Anthropic', 'verification request completed in 1.4 s', '⚡'),
      },
    })
    const card = (await setup.status()).cards.find((c) => c.key === 'model')
    assert.equal(card.badge, 'Two providers verified')
    assert.equal(card.footer.primary, 'OpenAI + Anthropic')
    assert.match(card.footer.secondary, /Routing ready/)
  })

  test('a provider that failed makes the card failed only when no provider is connected', async () => {
    const boom = failed('The model verification request failed', 'Sign in to OpenAI again, then try again.')
    let setup = new IntegrationSetup({ stateDir: tmp, verifiers: { openai: boom } })
    let card = (await setup.status()).cards.find((c) => c.key === 'model')
    assert.equal(card.state, 'failed')
    assert.equal(card.error.action, 'Sign in to OpenAI again, then try again.')
    setup = new IntegrationSetup({ stateDir: tmp, verifiers: { openai: boom, anthropic: connected('Anthropic', 'ok') } })
    card = (await setup.status()).cards.find((c) => c.key === 'model')
    assert.equal(card.state, 'connected')
    assert.equal(card.error, null)
    assert.equal(card.providers.openai.state, 'failed')
  })

  // ---- the Full loop gate --------------------------------------------------------

  test('four connected cards do not open the Full loop by themselves: the gate seam must supply its facts', async () => {
    const all = {
      github: connected('alp82/curia', 'No open tickets', '📦'),
      discord: connected('#curia', 'Confirmation delivered', '💬'),
      tailscale: connected('curia.tail1234.ts.net', 'alp@example.com', '🔒'),
      openai: connected('OpenAI', 'ok', '⚡'),
    }
    const without = await new IntegrationSetup({ stateDir: tmp, verifiers: all }).status()
    assert.deepEqual(without.full_loop.missing, [])
    assert.equal(without.full_loop.ready, false)
    assert.match(without.full_loop.reason, /not available/)

    const gate = async (cards) => ({ ready: cards.every((c) => c.state === 'connected'), reason: null, facts: { channel: '#curia' } })
    const withGate = await new IntegrationSetup({ stateDir: tmp, verifiers: all, fullLoop: gate }).status()
    assert.equal(withGate.full_loop.ready, true)
    assert.deepEqual(withGate.full_loop.facts, { channel: '#curia' })
  })

  test('the gate is not asked while a card is missing, and the missing cards are named in map order', async () => {
    let asked = 0
    const setup = new IntegrationSetup({
      stateDir: tmp,
      verifiers: { discord: connected('#curia', 'ok'), anthropic: connected('Anthropic', 'ok') },
      fullLoop: async () => { asked += 1; return { ready: true } },
    })
    const status = await setup.status()
    assert.equal(asked, 0)
    assert.deepEqual(status.full_loop.missing, ['github', 'tailscale'])
    assert.equal(status.full_loop.ready, false)
  })

  // #875: an integration whose one durable secret is not on disk yet has not
  // failed anything. Its card is "Ready to connect", not "Action required".
  test('a verifier may answer unconnected, which is the plain card and never a failure', async () => {
    const setup = new IntegrationSetup({ stateDir: tmp, verifiers: { github: async () => ({ ok: false, unconnected: true }) } })
    const card = (await setup.status()).cards.find((c) => c.key === 'github')
    assert.equal(card.state, 'unconnected')
    assert.equal(card.badge, 'Ready to connect')
    assert.equal(card.error, null)
    assert.equal(card.footer, null)
  })

  // The verified facts a card hands the Full loop gate (#880) ride the card as
  // `detail`, beside the footer, on a connected and on a failed answer alike.
  test('a verifier may attach non-secret detail, and the card carries it to the gate', async () => {
    const detail = { covered: ['alp82/curia'], ticket: { number: 861, title: 'Chart backup' } }
    const setup = new IntegrationSetup({
      stateDir: tmp,
      verifiers: {
        github: async () => ({ ok: true, primary: '#861 · Chart backup', secondary: 'ready-for-agent · alp82/curia', detail }),
        discord: async () => ({ ok: false, failed: 'no channel', action: 'make one', detail: { guild: '123' } }),
      },
    })
    const cards = (await setup.status()).cards
    assert.deepEqual(cards.find((c) => c.key === 'github').detail, detail)
    assert.deepEqual(cards.find((c) => c.key === 'discord').detail, { guild: '123' })
    assert.equal('detail' in cards.find((c) => c.key === 'tailscale'), false)
  })

  test('the status carries the resumption record beside the fresh cards, and no secret file value', async () => {
    const setup = new IntegrationSetup({ stateDir: tmp })
    setup.remember({ step: 'model', progress: { model: { provider: 'openai' } } })
    const status = await setup.status()
    assert.equal(status.step, 'model')
    assert.deepEqual(status.progress, { model: { provider: 'openai' } })
    assert.ok(!JSON.stringify(status).includes(TOKEN))
  })
})

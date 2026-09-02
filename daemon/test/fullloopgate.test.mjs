// The Full-loop gate (#880): one readiness decision computed from the cards'
// fresh verifications, and the facts it hands the loop. No network: every
// card is a fake verifier answering the shape its real module answers.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fullLoopGate, LOOP_FACTS } from '../src/fullloopgate.mjs'
import { IntegrationSetup, setupPath } from '../src/setup.mjs'

const TOKEN = 'MTIz.this-value-must-never-be-printed.abc'

// ---- the answers the real verifiers give ---------------------------------------

const github = (over = {}) => async () => ({
  ok: true, emoji: '🎫', primary: '#861 · Chart backup', secondary: 'ready-for-agent · alp82/curia · 3 open tickets',
  detail: {
    owners: [{ owner: 'alp82', installed: true }],
    covered: ['alp82/curia'],
    open_tickets: 3,
    ticket: { repo: 'alp82/curia', number: 861, title: 'Chart backup', url: 'https://github.com/alp82/curia/issues/861' },
    ...over,
  },
})

const discord = (over = {}) => async () => ({
  ok: true, emoji: '💬', primary: '#curia · AI Stack', secondary: 'Confirmation delivered · 6 commands registered',
  detail: {
    stage: 'confirmation',
    bot: { id: '1001', username: 'curia-box' },
    guild: { id: '2002', name: 'AI Stack' },
    guilds: [{ id: '2002', name: 'AI Stack' }],
    invite_url: 'https://discord.com/oauth2/authorize?client_id=1001',
    operator: { id: '3003', username: 'alp', name: 'Alp' },
    channel: { id: '4004', name: 'curia', created: false, url: 'https://discord.com/channels/2002/4004' },
    commands: ['status', 'go', 'pause', 'resume', 'cancel', 'reauth'],
    confirmation: { id: '5005', at: '2026-09-01T10:00:00.000Z', posted: false, url: 'https://discord.com/channels/2002/4004/5005' },
    bridge: 'up',
    ...over,
  },
})

const tailscale = (over = {}) => async () => ({
  ok: true, emoji: '🔒', primary: 'curia.tail1234.ts.net', secondary: 'alp@example.com · admitted in 12 ms',
  detail: {
    stage: 'app',
    operator: { login: 'alp@example.com', confirmed_at: '2026-09-01T09:00:00.000Z', last_seen_at: null },
    node: { backend_state: 'Running', online: true, dns_name: 'curia.tail1234.ts.net.', cert_domains: ['curia.tail1234.ts.net'], ips: ['100.64.0.1'], version: '1.80.0' },
    address: 'curia.tail1234.ts.net',
    app_url: 'https://curia.tail1234.ts.net:8445/',
    machine_name: { wanted: 'curia.sh', expected: 'curia', actual: 'curia' },
    serve: { url: 'https://curia.tail1234.ts.net:8445', route: '127.0.0.1:4273', created: false, error: null },
    app: { status: 200, ms: 12 },
    verified_at: '2026-09-01T10:00:00.000Z',
    ...over,
  },
})

const ROWS = [
  { type: 'feature', model: 'fable', provider: 'anthropic', active: true, credentialed: true, ok: true },
  { type: 'research', model: 'gpt', provider: 'openai', active: true, credentialed: true, ok: true },
]

const openai = (over = {}) => async () => ({
  ok: true, emoji: '⚡', primary: 'OpenAI', secondary: 'verification request completed in 0.9 s',
  detail: {
    stage: 'routing',
    identity: { account_id: 'acct_1', plan_type: 'plus' },
    credential: { expires_at: '2026-09-02T10:00:00.000Z' },
    request: { model: 'gpt-5.6-sol', id: 'resp_1', at: '2026-09-01T10:00:00.000Z', ms: 900, usage: { input_tokens: 9, output_tokens: 1 } },
    routing: { ready: true, applied: true, model: 'gpt', file: '/root/state/routing.local.yaml', rows: ROWS, missing: [] },
    verified_at: '2026-09-01T10:00:01.000Z',
    ...over,
  },
})

const anthropic = (over = {}) => async () => ({
  ok: true, emoji: '🧠', primary: 'Anthropic', secondary: 'verification request completed in 1.4 s',
  detail: {
    stage: 'routing',
    credential: { kind: 'setup-token', obtained_at: '2026-09-01T09:00:00.000Z', expires_at: '2027-09-01T09:00:00.000Z', estimated: true },
    request: { model: 'claude-haiku-4-5-20251001', id: 'msg_1', request_id: 'req_1', at: '2026-09-01T10:00:00.000Z', ms: 1400, stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 1 } },
    routing: { ready: true, applied: false, model: 'fable', file: '/root/state/routing.local.yaml', rows: ROWS, missing: [] },
    verified_at: '2026-09-01T10:00:02.000Z',
    ...over,
  },
})

const failed = (what, action) => async () => ({ ok: false, failed: what, action, detail: { stage: 'authority' } })
const unconnected = async () => ({ ok: false, unconnected: true })

// A verifier whose answer changes between reads, the way an external fact
// does: the first answers in order, the last repeats.
const sequence = (...answers) => {
  let i = 0
  return async (context) => answers[Math.min(i++, answers.length - 1)](context)
}

describe('the Full-loop gate', () => {
  let tmp
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-gate-')) })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const setupWith = (verifiers) => new IntegrationSetup({ stateDir: tmp, verifiers, fullLoop: fullLoopGate, log: () => {} })

  // ---- convergence -----------------------------------------------------------------

  test('OpenAI alone converges: the facts name the repository, the channel, the address, the provider, and its model', async () => {
    const status = await setupWith({ github: github(), discord: discord(), tailscale: tailscale(), openai: openai() }).status()
    assert.equal(status.full_loop.ready, true)
    assert.equal(status.full_loop.reason, null)
    assert.deepEqual(status.full_loop.missing, [])
    const { facts } = status.full_loop
    assert.deepEqual(Object.keys(facts), LOOP_FACTS)
    assert.equal(facts.github.repo, 'alp82/curia')
    assert.deepEqual(facts.github.ticket, { repo: 'alp82/curia', number: 861, title: 'Chart backup', url: 'https://github.com/alp82/curia/issues/861' })
    assert.deepEqual(facts.discord.channel, { id: '4004', name: 'curia', url: 'https://discord.com/channels/2002/4004' })
    assert.deepEqual(facts.discord.guild, { id: '2002', name: 'AI Stack' })
    assert.equal(facts.discord.bridge, 'up')
    assert.equal(facts.tailscale.address, 'curia.tail1234.ts.net')
    assert.equal(facts.tailscale.app_url, 'https://curia.tail1234.ts.net:8445/')
    assert.equal(facts.tailscale.operator, 'alp@example.com')
    assert.equal(facts.model.provider, 'openai')
    assert.equal(facts.model.model, 'gpt')
    assert.equal(facts.model.request.model, 'gpt-5.6-sol')
    assert.deepEqual(facts.model.rows, ROWS)
    assert.deepEqual(facts.model.providers, { openai: 'connected', anthropic: 'unavailable' })
    assert.match(facts.verified_at, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('Anthropic alone converges the same way', async () => {
    const status = await setupWith({ github: github(), discord: discord(), tailscale: tailscale(), anthropic: anthropic() }).status()
    assert.equal(status.full_loop.ready, true)
    assert.equal(status.full_loop.facts.model.provider, 'anthropic')
    assert.equal(status.full_loop.facts.model.model, 'fable')
    assert.equal(status.full_loop.facts.model.request.model, 'claude-haiku-4-5-20251001')
    assert.deepEqual(status.full_loop.facts.model.providers, { openai: 'unavailable', anthropic: 'connected' })
  })

  test('a GitHub card with no discovered ticket still converges, with the honest null', async () => {
    const status = await setupWith({ github: github({ open_tickets: 0, ticket: null }), discord: discord(), tailscale: tailscale(), openai: openai() }).status()
    assert.equal(status.full_loop.ready, true)
    assert.equal(status.full_loop.facts.github.ticket, null)
    assert.equal(status.full_loop.facts.github.open_tickets, 0)
  })

  // ---- both providers ----------------------------------------------------------------

  test('both providers: the remembered provider leads, and the other rides along as connected', async () => {
    const setup = setupWith({ github: github(), discord: discord(), tailscale: tailscale(), openai: openai(), anthropic: anthropic() })
    setup.remember({ progress: { model: { provider: 'anthropic' } } })
    const status = await setup.status()
    assert.equal(status.full_loop.ready, true)
    assert.equal(status.cards.find((c) => c.key === 'model').badge, 'Two providers verified')
    assert.equal(status.full_loop.facts.model.provider, 'anthropic')
    assert.equal(status.full_loop.facts.model.model, 'fable')
    assert.deepEqual(status.full_loop.facts.model.providers, { openai: 'connected', anthropic: 'connected' })
  })

  test('both providers with nothing remembered: the first connected provider in card order leads', async () => {
    const status = await setupWith({ github: github(), discord: discord(), tailscale: tailscale(), openai: openai(), anthropic: anthropic() }).status()
    assert.equal(status.full_loop.facts.model.provider, 'openai')
  })

  test('a remembered provider that is not connected does not lead: the one that verified does', async () => {
    const setup = setupWith({ github: github(), discord: discord(), tailscale: tailscale(), openai: openai(), anthropic: unconnected })
    setup.remember({ progress: { model: { provider: 'anthropic' } } })
    const status = await setup.status()
    assert.equal(status.full_loop.ready, true)
    assert.equal(status.full_loop.facts.model.provider, 'openai')
    assert.deepEqual(status.full_loop.facts.model.providers, { openai: 'connected', anthropic: 'unconnected' })
  })

  test('a second provider that fails is said honestly and blocks nothing: one verified provider is enough', async () => {
    const status = await setupWith({
      github: github(), discord: discord(), tailscale: tailscale(),
      openai: openai(),
      anthropic: failed('The Anthropic credential passed its documented one-year lifetime', 'Sign in to Anthropic from this panel.'),
    }).status()
    assert.equal(status.full_loop.ready, true)
    assert.equal(status.full_loop.facts.model.provider, 'openai')
    assert.deepEqual(status.full_loop.facts.model.providers, { openai: 'connected', anthropic: 'failed' })
    const model = status.cards.find((c) => c.key === 'model')
    assert.equal(model.state, 'connected')
    assert.equal(model.providers.anthropic.state, 'failed')
  })

  // ---- not ready --------------------------------------------------------------------

  test('three cards and no provider is not ready, and the reason names the model card', async () => {
    const status = await setupWith({ github: github(), discord: discord(), tailscale: tailscale(), openai: unconnected, anthropic: unconnected }).status()
    assert.equal(status.full_loop.ready, false)
    assert.deepEqual(status.full_loop.missing, ['model'])
    assert.equal(status.full_loop.reason, 'Waiting for Model provider.')
    assert.equal(status.full_loop.facts, null)
  })

  test('lost authority closes the gate on the read that finds it: the App uninstalled, the reason and the action stand on the card', async () => {
    const status = await setupWith({
      github: failed("curia's GitHub App is not installed on alp82", 'Install the App on alp82 from the link in this panel, then try again.'),
      discord: discord(), tailscale: tailscale(), openai: openai(),
    }).status()
    assert.equal(status.full_loop.ready, false)
    assert.deepEqual(status.full_loop.missing, ['github'])
    assert.equal(status.full_loop.facts, null)
    const card = status.cards.find((c) => c.key === 'github')
    assert.equal(card.state, 'failed')
    assert.equal(card.error.action, 'Install the App on alp82 from the link in this panel, then try again.')
  })

  test('a connected card that hands no fact the loop runs on is not ready, and the reason names the card', async () => {
    const noRepo = await setupWith({ github: github({ covered: [] }), discord: discord(), tailscale: tailscale(), openai: openai() }).status()
    assert.equal(noRepo.full_loop.ready, false)
    assert.match(noRepo.full_loop.reason, /GitHub verified without a covered repository/)
    assert.equal(noRepo.full_loop.facts, null)

    const noChannel = await setupWith({ github: github(), discord: discord({ channel: null }), tailscale: tailscale(), openai: openai() }).status()
    assert.equal(noChannel.full_loop.ready, false)
    assert.match(noChannel.full_loop.reason, /Discord verified without a command channel/)

    const noAddress = await setupWith({ github: github(), discord: discord(), tailscale: tailscale({ address: null, app_url: null }), openai: openai() }).status()
    assert.equal(noAddress.full_loop.ready, false)
    assert.match(noAddress.full_loop.reason, /Tailscale verified without a private address/)

    const noRouting = await setupWith({ github: github(), discord: discord(), tailscale: tailscale(), openai: openai({ routing: { ready: false, rows: [], missing: ['research'] } }) }).status()
    assert.equal(noRouting.full_loop.ready, false)
    assert.match(noRouting.full_loop.reason, /OpenAI verified without a ready routing/)
  })

  // ---- fresh on every read ------------------------------------------------------------

  test('stale verification: a card that verified on the last read and fails on this one closes the gate', async () => {
    const setup = setupWith({
      github: github(), discord: discord(), tailscale: tailscale(),
      openai: sequence(openai(), failed('OpenAI refused the credential (HTTP 401)', 'Sign in to OpenAI from this panel.')),
    })
    assert.equal((await setup.status()).full_loop.ready, true)
    const later = await setup.status()
    assert.equal(later.full_loop.ready, false)
    assert.deepEqual(later.full_loop.missing, ['model'])
    assert.equal(later.full_loop.facts, null)
  })

  test('recovery through the same-step retry: the next read that passes reopens the gate, and no marker is consulted or written', async () => {
    const setup = setupWith({
      github: github(),
      discord: sequence(failed('curia could not post in #curia', 'Allow Send Messages for the bot in #curia, then try again.'), discord()),
      tailscale: tailscale(), anthropic: anthropic(),
    })
    const first = await setup.status()
    assert.equal(first.full_loop.ready, false)
    assert.deepEqual(first.full_loop.missing, ['discord'])
    const retried = await setup.status()
    assert.equal(retried.full_loop.ready, true)
    assert.equal(retried.full_loop.facts.discord.channel.name, 'curia')
    assert.equal(fs.existsSync(setupPath(tmp)), false, 'a read writes nothing')
  })

  test('a restart recomputes readiness from the current facts: a record claiming completion opens nothing', async () => {
    fs.writeFileSync(setupPath(tmp), JSON.stringify({ format: 1, step: 'model', progress: {}, complete: true, ready: true }))
    const restarted = setupWith({ github: github(), discord: discord(), tailscale: tailscale(), openai: unconnected, anthropic: unconnected })
    const status = await restarted.status()
    assert.equal(status.full_loop.ready, false)
    assert.deepEqual(status.full_loop.missing, ['model'])
    // And the reconnection: the same record, a process that can verify now.
    const reconnected = setupWith({ github: github(), discord: discord(), tailscale: tailscale(), openai: openai() })
    assert.equal((await reconnected.status()).full_loop.ready, true)
    const record = JSON.parse(fs.readFileSync(setupPath(tmp), 'utf8'))
    assert.equal('ready' in record, true, 'the foreign keys are left as they were; a read rewrites nothing')
  })

  // ---- the gate is a function of the cards ----------------------------------------

  test('the gate refuses cards that are not all connected, whatever the frame asked', () => {
    const cards = [
      { key: 'github', state: 'connected', detail: { covered: ['alp82/curia'] } },
      { key: 'discord', state: 'unconnected' },
      { key: 'tailscale', state: 'connected', detail: { address: 'a', app_url: 'https://a:8445/' } },
      { key: 'model', state: 'connected', providers: { openai: { state: 'connected', detail: { routing: { ready: true, model: 'gpt', rows: [] }, request: { model: 'gpt-5.6-sol' } } } } },
    ]
    const gate = fullLoopGate(cards)
    assert.equal(gate.ready, false)
    assert.equal(gate.reason, 'Waiting for Discord.')
    assert.equal(gate.facts, null)
  })

  test('the facts carry no secret and nothing but the named keys', async () => {
    const status = await setupWith({
      github: github({ token: TOKEN }),
      discord: discord({ token: TOKEN }),
      tailscale: tailscale(),
      openai: openai({ access_token: TOKEN }),
    }).status()
    assert.equal(status.full_loop.ready, true)
    assert.ok(!JSON.stringify(status.full_loop.facts).includes(TOKEN))
    assert.deepEqual(Object.keys(status.full_loop.facts.github), ['repo', 'covered', 'owners', 'open_tickets', 'ticket'])
    assert.deepEqual(Object.keys(status.full_loop.facts.discord), ['guild', 'channel', 'operator', 'commands', 'confirmation', 'bridge'])
    assert.deepEqual(Object.keys(status.full_loop.facts.tailscale), ['address', 'app_url', 'operator', 'admitted_ms'])
    assert.deepEqual(Object.keys(status.full_loop.facts.model), ['provider', 'model', 'request', 'rows', 'providers'])
  })
})

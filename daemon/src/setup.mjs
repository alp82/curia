// The integration setup frame (#874, building the accepted journey #853 and
// the setup contract #852).
//
// One module holds everything the browser frame and its routes need to know
// about integration setup that is not one integration's own business: which
// four cards there are, what a card may remember between a close and a
// reopen, how a card's state is read, and when the Full loop opens.
//
//   GET  /setup          ──> status()            fresh verification + the record
//   POST /setup          ──> remember({...})     the selected card, safe progress
//
// THE RECORD IS A CHECKPOINT, NEVER A CONCLUSION. `state/setup.json` holds
// the card the operator was on and a closed list of safe, non-secret facts a
// step may want back (a guild id, a channel name, a machine name, a provider).
// It never holds a token, and it never holds "done": the card is connected
// only when its verifier says so on THIS read (#852: "a fresh verification
// result, not a stored completion flag, determines whether a step is
// complete"). A file that carries a `complete` key from some other hand is
// read for its step and its progress and nothing else.
//
// THE SEAMS THE LATER TICKETS FILL. Each integration is one verifier, keyed by
// name and handed the record of its own card:
//
//   verifiers.github     (#875)   verifiers.discord    (#876)
//   verifiers.tailscale  (#877)   verifiers.openai     (#878)
//   verifiers.anthropic  (#879)
//
// A verifier answers `{ ok: true, primary, secondary, emoji? }` — the one real
// fact and the supporting line the card's footer draws — or `{ ok: false,
// failed, action }` — the failed verification and exactly one corrective
// action — or `{ ok: false, unconnected: true }` — nothing to verify yet,
// because the integration's own secret is not on disk (#875): that is the
// plain "Ready to connect" card and never a failure. Either answer may carry
// `detail`, a small non-secret record the card hands on as `card.detail`; it
// is how a connected card's verified facts reach the Full loop gate (#880)
// and the panel that draws them. A verifier that throws is a failed
// verification whose sentence is the thrown one. A verifier that is absent
// reports `unavailable`, which is what the frame shows before its ticket
// lands. The model card owns the two provider verifiers and is connected by
// either.
//
// The Full loop is the one dependent step, and `fullLoop` is its gate
// (`daemon/src/fullloopgate.mjs`, #880): asked only once every card is
// connected, with the cards and the record's progress, it answers `{ ready,
// reason, facts }` from those cards alone. Without a gate the action stays
// unavailable however many cards are connected, because the frame has
// nothing verified to run a loop on.

import fs from 'node:fs'
import path from 'node:path'

import { writeAtomically } from '../../cli/src/atomic.mjs'

export const SETUP_FILE = 'setup.json'
export const setupPath = (stateDir) => path.join(stateDir, SETUP_FILE)

// The four cards, in the order the rail draws them (#853).
export const CARDS = Object.freeze(['github', 'discord', 'tailscale', 'model'])
// The two providers behind the model card (#852: one is required, the second
// is optional).
export const PROVIDERS = Object.freeze(['openai', 'anthropic'])

export const CARD_TITLES = Object.freeze({
  github: 'GitHub', discord: 'Discord', tailscale: 'Tailscale', model: 'Model provider',
})
export const PROVIDER_TITLES = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic' })

// What a card may remember between a close and a reopen. This list is the
// whole vocabulary: a key that is not here is refused, so a later ticket that
// wants to store more says so here, where the rule that nothing here is a
// secret can be read in one place.
export const PROGRESS_FIELDS = Object.freeze({
  github: Object.freeze(['app_name']),
  discord: Object.freeze(['guild_id', 'channel']),
  tailscale: Object.freeze(['machine_name']),
  model: Object.freeze(['provider']),
})

// The shape of each field. Every one is short and bounded, so no field is
// wide enough to carry a credential by accident.
const FIELD_SHAPES = {
  app_name: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$/,
  guild_id: /^[0-9]{5,25}$/,
  channel: /^[a-z0-9][a-z0-9_-]{0,99}$/,
  machine_name: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i,
  provider: /^(openai|anthropic)$/,
}

// What the footer says before a card verifies (#853): the data that will
// appear, not a decorative metric.
export const PENDING = Object.freeze({
  github: 'Repository and discovered-work data will appear after GitHub verifies.',
  discord: 'The channel and command result will appear after Discord verifies.',
  tailscale: 'The private address and operator will appear after Tailscale verifies.',
  model: 'Connected providers and the tested route will appear after sign-in.',
})

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

const isCard = (key) => CARDS.includes(key)

function checkedProgress(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) throw refuse('progress must be a mapping of card to fields')
  const out = {}
  for (const [card, fields] of Object.entries(progress)) {
    if (!isCard(card)) throw refuse(`"${String(card).slice(0, 40)}" is not a setup card`)
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw refuse(`the ${card} progress must be a mapping`)
    const kept = {}
    for (const [key, value] of Object.entries(fields)) {
      if (!PROGRESS_FIELDS[card].includes(key)) {
        throw refuse(`"${String(key).slice(0, 40)}" is not a field the ${card} card may remember — the list is ${PROGRESS_FIELDS[card].join(', ')}`)
      }
      if (typeof value !== 'string' || !FIELD_SHAPES[key].test(value)) throw refuse(`the ${card} ${key} is not the shape a ${key} takes`)
      kept[key] = value
    }
    out[card] = kept
  }
  return out
}

// The card record the page draws. One shape for every state, so the card's
// height never depends on which state it is in.
function cardOf(key, { state, footer = null, error = null, badge, providers = null, detail = undefined }) {
  return {
    key,
    title: CARD_TITLES[key],
    state,
    badge,
    footer,
    error,
    pending: PENDING[key],
    ...(detail !== undefined ? { detail } : {}),
    ...(providers ? { providers } : {}),
  }
}

const FALLBACK_ACTION = 'Fix the cause the message names, then try again.'

async function ask(verifier, context) {
  if (!verifier) return { state: 'unavailable' }
  let answer
  try {
    answer = await verifier(context)
  } catch (e) {
    return { state: 'failed', error: { failed: e.message, action: FALLBACK_ACTION } }
  }
  const detail = answer?.detail !== undefined ? { detail: answer.detail } : {}
  if (answer?.ok) {
    return {
      state: 'connected',
      footer: { primary: String(answer.primary ?? ''), secondary: String(answer.secondary ?? ''), emoji: String(answer.emoji ?? '✅') },
      ...detail,
    }
  }
  if (answer?.unconnected) return { state: 'unconnected', ...detail }
  return {
    state: 'failed',
    error: { failed: String(answer?.failed ?? 'The verification did not pass'), action: String(answer?.action ?? FALLBACK_ACTION) },
    ...detail,
  }
}

export class IntegrationSetup {
  constructor({ stateDir, verifiers = {}, fullLoop = null, log = console.log }) {
    this.stateDir = stateDir
    this.verifiers = verifiers
    this.fullLoop = fullLoop
    this.log = log
  }

  // The record: the selected card and the safe progress. A missing file is a
  // fresh installation on its first card. A file that cannot be read is said
  // once and treated the same, because a setup that cannot open is worse than
  // a setup that starts over on a checkpoint it can rewrite.
  read() {
    const file = setupPath(this.stateDir)
    let data
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`setup: ${file} could not be read (${e.message}) — starting setup on its first card`)
      return { step: CARDS[0], progress: {} }
    }
    const step = isCard(data?.step) ? data.step : CARDS[0]
    let progress = {}
    try {
      progress = checkedProgress(data?.progress ?? {})
    } catch (e) {
      this.log(`setup: ${file} holds progress this version does not keep (${e.message}) — dropped`)
    }
    return { step, progress }
  }

  // The write. `step` replaces the selected card, `progress` replaces the
  // named cards' fields and leaves the other cards' fields alone. Both are
  // checked before anything lands, and the file holds exactly these keys.
  remember({ step, progress } = {}) {
    const record = this.read()
    if (step !== undefined) {
      if (!isCard(step)) throw refuse(`"${String(step).slice(0, 40)}" is not a setup card — the cards are ${CARDS.join(', ')}`)
      record.step = step
    }
    if (progress !== undefined) Object.assign(record.progress, checkedProgress(progress))
    writeAtomically(setupPath(this.stateDir), `${JSON.stringify({ format: 1, ...record }, null, 2)}\n`, { mode: 0o600 })
    return record
  }

  async #card(key, record) {
    const context = { stateDir: this.stateDir, progress: record.progress[key] ?? {} }
    if (key !== 'model') {
      const got = await ask(this.verifiers[key], context)
      return cardOf(key, {
        ...got,
        badge: got.state === 'connected' ? 'Connected and verified'
          : got.state === 'failed' ? 'Action required'
            : got.state === 'unavailable' ? 'Not available' : 'Ready to connect',
      })
    }
    const providers = {}
    for (const provider of PROVIDERS) providers[provider] = { title: PROVIDER_TITLES[provider], ...(await ask(this.verifiers[provider], context)) }
    const connected = PROVIDERS.filter((p) => providers[p].state === 'connected')
    const failed = PROVIDERS.filter((p) => providers[p].state === 'failed')
    if (connected.length) {
      const seconds = connected.map((p) => providers[p].footer.secondary).filter(Boolean)
      return cardOf(key, {
        state: 'connected',
        badge: connected.length > 1 ? 'Two providers verified' : 'Provider verified',
        footer: {
          primary: connected.map((p) => PROVIDER_TITLES[p]).join(' + '),
          secondary: `Routing ready · ${seconds.join(' · ')}`,
          emoji: providers[connected[0]].footer.emoji,
        },
        providers,
      })
    }
    if (failed.length) return cardOf(key, { state: 'failed', badge: 'Action required', error: providers[failed[0]].error, providers })
    const available = PROVIDERS.some((p) => providers[p].state !== 'unavailable')
    return cardOf(key, { state: available ? 'unconnected' : 'unavailable', badge: available ? 'Ready to connect' : 'Not available', providers })
  }

  // One card, freshly verified. For the ticket that just connected it and
  // wants the card the rail will draw.
  async verify(key) {
    if (!isCard(key)) throw refuse(`"${String(key).slice(0, 40)}" is not a setup card — the cards are ${CARDS.join(', ')}`)
    return this.#card(key, this.read())
  }

  // Everything the frame draws, on one fresh read: the record, the four
  // cards from their verifiers, and the Full loop gate.
  async status() {
    const record = this.read()
    const cards = []
    for (const key of CARDS) cards.push(await this.#card(key, record))
    const missing = cards.filter((c) => c.state !== 'connected').map((c) => c.key)
    let full_loop = { ready: false, missing, reason: null, facts: null }
    if (missing.length) {
      full_loop.reason = `Waiting for ${missing.map((k) => CARD_TITLES[k]).join(', ')}.`
    } else if (!this.fullLoop) {
      full_loop.reason = 'The Full loop is not available yet in this release.'
    } else {
      try {
        const gate = await this.fullLoop(cards, { progress: record.progress })
        full_loop = { ready: Boolean(gate?.ready), missing, reason: gate?.reason ?? null, facts: gate?.facts ?? null }
      } catch (e) {
        full_loop.reason = e.message
      }
    }
    return { ...record, cards, full_loop }
  }
}

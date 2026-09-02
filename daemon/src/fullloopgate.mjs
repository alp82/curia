// The Full-loop gate (#880, under the #852 setup contract and the #853
// journey): one readiness decision, computed from the cards' fresh
// verifications, and the facts the Full loop runs on.
//
//   READY   GitHub, Discord, Tailscale, and at least one model provider
//           passed verification ON THIS READ, and each connected card handed
//           the fact the loop needs from it: a covered repository, a command
//           channel in a server, a private address the app answers on, and a
//           provider whose routing is ready.
//   FACTS   the non-secret record the loop's run (#882) receives: the
//           repository and the discovered ticket, the channel and the
//           confirmation, the address and the admitted operator, the leading
//           provider and the model each ticket type routes to.
//
// THE GATE IS A FUNCTION OF THE CARDS. It reads no file, keeps no marker, and
// remembers nothing between calls, so a restart, a reconnection, and a Try
// again all recompute readiness from what the verifiers found now (#852: "a
// fresh verification result, not a stored completion flag"). A card that
// verified yesterday and fails today closes the gate today, and the next
// read that passes opens it again. There is no workflow engine here and
// nothing to resume: `IntegrationSetup#status()` asks the verifiers, hands
// the cards in, and draws the answer.
//
// ONE PROVIDER IS ENOUGH. Both providers are supported; the model card is
// connected by either. The provider that leads is the one the operator last
// signed in (`progress.model.provider`) when it verified, else the first
// connected one in card order; the other's state rides along under
// `providers` so a second provider is shown honestly and stays optional.

import { CARDS, CARD_TITLES, PROVIDERS, PROVIDER_TITLES } from './setup.mjs'

// The keys of `facts`, in order. A test holds the gate to this list, so a
// fact the loop starts depending on is added here, where the rule that
// nothing here is a secret can be read in one place.
export const LOOP_FACTS = Object.freeze(['verified_at', 'github', 'discord', 'tailscale', 'model'])

const closed = (reason) => ({ ready: false, reason, facts: null })
const incomplete = (card, what) => closed(`${card} verified without ${what}. Select Try again.`)

const pick = (source, keys) => Object.fromEntries(keys.map((k) => [k, source?.[k] ?? null]))

export function fullLoopGate(cards, { progress = {}, now = () => new Date() } = {}) {
  const byKey = Object.fromEntries((cards ?? []).map((c) => [c.key, c]))
  const missing = CARDS.filter((key) => byKey[key]?.state !== 'connected')
  if (missing.length) return closed(`Waiting for ${missing.map((k) => CARD_TITLES[k]).join(', ')}.`)

  // GitHub: the covered watched repository, the ticket found or the honest
  // null. The token for the owner mints fresh at loop time (#875); nothing
  // here holds one.
  const gh = byKey.github.detail ?? {}
  const covered = Array.isArray(gh.covered) ? gh.covered.filter((r) => typeof r === 'string' && r) : []
  if (!covered.length) return incomplete('GitHub', 'a covered repository')

  // Discord: the server and the channel the loop speaks in, and whether the
  // bridge runs in this process, which the loop reads before it sends (#876).
  const dc = byKey.discord.detail ?? {}
  if (!dc.guild?.id || !dc.channel?.id) return incomplete('Discord', 'a command channel')

  // Tailscale: the private address the app answers on and the operator it
  // admits (#877).
  const ts = byKey.tailscale.detail ?? {}
  if (!ts.address || !ts.app_url) return incomplete('Tailscale', 'a private address')

  // The model card: the leading provider and the routing its preset left.
  const providers = byKey.model.providers ?? {}
  const connected = PROVIDERS.filter((p) => providers[p]?.state === 'connected')
  if (!connected.length) return incomplete('The model provider', 'a verified provider')
  const remembered = progress?.model?.provider
  const provider = connected.includes(remembered) ? remembered : connected[0]
  const md = providers[provider].detail ?? {}
  if (!md.routing?.ready || !md.routing?.model) return incomplete(PROVIDER_TITLES[provider], 'a ready routing')

  return {
    ready: true,
    reason: null,
    facts: {
      verified_at: now().toISOString(),
      github: {
        repo: covered[0],
        covered,
        owners: Array.isArray(gh.owners) ? gh.owners.map((o) => pick(o, ['owner', 'installed'])) : [],
        open_tickets: Number.isFinite(gh.open_tickets) ? gh.open_tickets : null,
        ticket: gh.ticket ? pick(gh.ticket, ['repo', 'number', 'title', 'url']) : null,
      },
      discord: {
        guild: pick(dc.guild, ['id', 'name']),
        channel: pick(dc.channel, ['id', 'name', 'url']),
        operator: pick(dc.operator, ['id', 'username', 'name']),
        commands: Array.isArray(dc.commands) ? dc.commands.map(String) : [],
        confirmation: dc.confirmation ? pick(dc.confirmation, ['id', 'at', 'posted', 'url']) : null,
        bridge: dc.bridge ?? null,
      },
      tailscale: {
        address: ts.address,
        app_url: ts.app_url,
        operator: ts.operator?.login ?? null,
        admitted_ms: ts.app?.ms ?? null,
      },
      model: {
        provider,
        model: md.routing.model,
        request: md.request ? pick(md.request, ['model', 'id', 'at', 'ms']) : null,
        rows: Array.isArray(md.routing.rows) ? md.routing.rows : [],
        providers: Object.fromEntries(PROVIDERS.map((p) => [p, providers[p]?.state ?? 'unavailable'])),
      },
    },
  }
}

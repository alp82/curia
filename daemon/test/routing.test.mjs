// Red tests for src/routing.mjs (plan.md step 5, step 11).
//
// Assumed contract (routing.mjs does not exist yet -- this is the contract
// these tests pin, mirroring the loaded shape of config/routing.yaml from
// plan.md step 1, all-Claude per stated deviation 3):
//
//   const routing = {
//     defaults: { grilling: 'fable', prototype: 'fable', research: 'opus', task: 'opus', untyped: 'opus' },
//     models:   { fable: { provider, backend }, opus: { ... }, sonnet: { ... } },
//     fallbacks: { fable: ['opus'], opus: ['sonnet'] },   // intra-Claude only
//     backends: { claude: { template: '...{model}...{prompt_file}...' } },
//   }
//
//   resolveModel(routing, labels, override) -> modelName
//     override (explicit `/start n model=x`) wins outright; else a `model:<x>`
//     label is absolute; else the wayfinder:<type> label indexes
//     routing.defaults; else routing.defaults.untyped.
//     Precedence, orchestrator-settled (field-notes contract 2): explicit
//     override > model:<x> label > wayfinder:<type> default > untyped default.
//
//   class Cooling                      -- in-memory only, never persisted
//     coolModel(model, resetAt) / coolProvider(provider, resetAt)
//     isCool(model, provider) -> true if EITHER is cooling AND ACTIVE (a
//       cooling entry whose resetAt has passed is no longer cooling)
//     earliestReset() -> soonest active (non-expired) Date across all
//       cooling entries; null/undefined when none are active
//
//   candidates(routing, model, cooling) -> modelName[]
//     TRANSITIVE fallback chain (field-notes contract 1): starting model
//     plus the full chain reachable by repeatedly following
//     routing.fallbacks, not just one hop -- candidates(routing, 'fable', <nothing
//     cooling>) yields ['fable', 'opus', 'sonnet']. Entries cooling at
//     either level (model or provider) are skipped; premature exhaustion is
//     the worse failure, so dispatch proceeds on whatever warm models remain
//     even if multiple heads of the chain are cooling. Empty array signals
//     true exhaustion (every candidate cooling).
//
//   buildSpawnCmd(routing, backend, model, promptFile) -> string
//     template substitution; throws naming the configured backends on an
//     unknown backend key; throws if a substituted path is not quote-free
//     (challenge.md concern: "assert it in buildSpawnCmd rather than
//     trusting it" -- generated workspace_root paths must never carry a
//     single quote, since the template is nested inside `bash -c '...'`).
//
//   parseUsageLimit(paneText) -> { scope: 'model'|'provider', resetAt: Date|null } | null
//     Keys on limit-*reached* text, never an informational mention
//     (field-notes contract 4): model-specific reached phrasing -> scope
//     'model'; generic provider-wide reached phrasing -> scope 'provider';
//     an unparseable reset yields resetAt: null (caller applies the
//     conservative 1h cooldown -- stated deviation 2); no usage-limit
//     language at all, OR an informational/promotional mention of a usage
//     limit that was never reached, -> null.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Cooling, resolveModel, candidates, buildSpawnCmd, parseUsageLimit } from '../src/routing.mjs'

const routing = {
  defaults: { grilling: 'fable', prototype: 'fable', research: 'opus', task: 'opus', untyped: 'opus' },
  models: {
    fable: { provider: 'anthropic', backend: 'claude' },
    opus: { provider: 'anthropic', backend: 'claude' },
    sonnet: { provider: 'anthropic', backend: 'claude' },
  },
  fallbacks: { fable: ['opus'], opus: ['sonnet'] },
  backends: {
    claude: { template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"' },
  },
}

describe('resolveModel', () => {
  test('wayfinder:<type> indexes the default table', () => {
    assert.equal(resolveModel(routing, ['wayfinder:research'], undefined), 'opus')
    assert.equal(resolveModel(routing, ['wayfinder:grilling'], undefined), 'fable')
    assert.equal(resolveModel(routing, ['wayfinder:prototype'], undefined), 'fable')
  })

  test('untyped labels fall to the untyped default', () => {
    assert.equal(resolveModel(routing, ['bug'], undefined), 'opus')
    assert.equal(resolveModel(routing, [], undefined), 'opus')
  })

  test('a model:<x> label is absolute and beats the type default', () => {
    assert.equal(resolveModel(routing, ['model:sonnet', 'wayfinder:research'], undefined), 'sonnet')
  })

  test('an explicit override wins over everything, including a model: label', () => {
    assert.equal(resolveModel(routing, ['model:sonnet', 'wayfinder:research'], 'fable'), 'fable')
  })
})

describe('Cooling', () => {
  test('nothing is cooling by default', () => {
    const c = new Cooling()
    assert.equal(c.isCool('fable', 'anthropic'), false)
    assert.equal(c.isCool('opus', 'anthropic'), false)
  })

  // Fable's own weekly sub-cap cools only fable -- the provider, and every
  // other Claude model under it, stays warm.
  test('model-level cooling cools only that model, provider stays warm', () => {
    const c = new Cooling()
    c.coolModel('fable', new Date(Date.now() + 3600_000))
    assert.equal(c.isCool('fable', 'anthropic'), true)
    assert.equal(c.isCool('opus', 'anthropic'), false)
    assert.equal(c.isCool('sonnet', 'anthropic'), false)
  })

  // A provider-level (anthropic) limit cools every lane at once -- #13's
  // all-cooling path under all-Claude routing.
  test('provider-level cooling cools every model under that provider', () => {
    const c = new Cooling()
    c.coolProvider('anthropic', new Date(Date.now() + 3600_000))
    assert.equal(c.isCool('fable', 'anthropic'), true)
    assert.equal(c.isCool('opus', 'anthropic'), true)
    assert.equal(c.isCool('sonnet', 'anthropic'), true)
  })

  test('earliestReset returns the soonest active reset across cooling entries', () => {
    const c = new Cooling()
    const soon = new Date(Date.now() + 1_000)
    const later = new Date(Date.now() + 5_000)
    c.coolModel('fable', later)
    c.coolProvider('anthropic', soon)
    assert.equal(c.earliestReset().getTime(), soon.getTime())
  })

  // field-notes contract 5: cooling entries expire. A resetAt in the past
  // means the entry is no longer cooling -- without this the daemon refuses
  // to dispatch anything until restart.
  test('a cooling entry whose resetAt has passed is no longer cooling', () => {
    const c = new Cooling()
    c.coolModel('fable', new Date(Date.now() - 1_000))
    assert.equal(c.isCool('fable', 'anthropic'), false)
  })

  // Same contract, provider level. This is the higher-stakes half: a stuck
  // provider-level entry cools every lane at once, so an implementation that
  // only expires the model-level lookup leaves the daemon refusing to
  // dispatch anything until restart.
  test('a provider-level cooling entry whose resetAt has passed is no longer cooling', () => {
    const c = new Cooling()
    c.coolProvider('anthropic', new Date(Date.now() - 1_000))
    assert.equal(c.isCool('fable', 'anthropic'), false)
  })

  test('earliestReset ignores an expired entry and returns the soonest still-active reset', () => {
    const c = new Cooling()
    c.coolModel('fable', new Date(Date.now() - 1_000)) // expired, must not count
    const active = new Date(Date.now() + 5_000)
    c.coolProvider('anthropic', active)
    assert.equal(c.earliestReset().getTime(), active.getTime())
  })

  test('earliestReset returns null/undefined when no cooling entries are active', () => {
    const c = new Cooling()
    c.coolModel('fable', new Date(Date.now() - 1_000)) // expired
    assert.equal(c.earliestReset() == null, true)
  })
})

describe('candidates', () => {
  // field-notes contract 1: fallback chains are TRANSITIVE -- the full
  // reachable chain, not just the immediate next hop.
  test('intra-Claude chain is transitive, nothing cooling', () => {
    assert.deepEqual(candidates(routing, 'opus', new Cooling()), ['opus', 'sonnet'])
    assert.deepEqual(candidates(routing, 'fable', new Cooling()), ['fable', 'opus', 'sonnet'])
  })

  // Acceptance: model-level cooling falls back within the provider
  // (fable cool -> opus, then transitively on to sonnet; provider warm).
  test('model-level cooling on the head candidate still yields its full transitive fallback', () => {
    const cooling = new Cooling()
    cooling.coolModel('fable', new Date(Date.now() + 3600_000))
    assert.deepEqual(candidates(routing, 'fable', cooling), ['opus', 'sonnet'])
  })

  // field-notes contract 1, the discriminating case: with fable AND opus
  // both cooled, dispatch proceeds on sonnet rather than declaring
  // exhaustion -- premature exhaustion (refusing to work while a warm model
  // exists) is the worse failure. "Never upgrade bulk work to fable" still
  // holds structurally: fable never appears downstream in any chain.
  test('multiple cooled heads still yield the next warm model, not exhaustion', () => {
    const cooling = new Cooling()
    cooling.coolModel('fable', new Date(Date.now() + 3600_000))
    cooling.coolModel('opus', new Date(Date.now() + 3600_000))
    assert.deepEqual(candidates(routing, 'fable', cooling), ['sonnet'])
  })

  // Acceptance: provider-level cooling empties every chain -> exhaustion.
  test('provider-level cooling empties the whole chain', () => {
    const cooling = new Cooling()
    cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))
    assert.deepEqual(candidates(routing, 'fable', cooling), [])
  })

  // Inverse of the above: once the provider-level entry has expired, it must
  // stop suppressing the chain -- the full transitive chain is candidates
  // again, not a stuck empty exhaustion.
  test('an expired provider-level cooling entry no longer empties the chain', () => {
    const cooling = new Cooling()
    cooling.coolProvider('anthropic', new Date(Date.now() - 1_000))
    assert.deepEqual(candidates(routing, 'fable', cooling), ['fable', 'opus', 'sonnet'])
  })
})

describe('buildSpawnCmd', () => {
  test('substitutes model and prompt file into the backend template', () => {
    const cmd = buildSpawnCmd(routing, 'claude', 'opus', '/home/alp/curia-work/cfg/curia-42/prompt.md')
    assert.equal(
      cmd,
      'claude --model opus --permission-mode bypassPermissions "$(cat /home/alp/curia-work/cfg/curia-42/prompt.md)"',
    )
  })

  test('an unknown backend key throws, naming the configured backends', () => {
    assert.throws(
      () => buildSpawnCmd(routing, 'codex', 'opus', '/home/alp/curia-work/cfg/curia-42/prompt.md'),
      /claude/,
    )
  })

  // challenge.md concern: keep generated paths quote-free by construction
  // AND assert it here rather than trusting the caller -- the spawn command
  // is nested inside `bash -c '<spawn cmd>; exec bash'` (plan.md step 3), so
  // a stray single quote in a substituted path would silently break the
  // outer wrapper.
  test('a promptFile path containing a single quote is refused', () => {
    assert.throws(() => buildSpawnCmd(routing, 'claude', 'opus', "/home/alp/curia-work/cfg/curia-42/it's-bad.md"))
  })
})

describe('parseUsageLimit', () => {
  // field-notes contract 4: detection must key on limit-*reached* text, not
  // an informational mention. The bare "you can use up to X%" phrasing
  // turned out to be exactly that informational mention (see the negative
  // case below), so the model-specific positive fixture here uses
  // unambiguous reached-phrasing naming the model, distinct from that
  // informational text, with no parseable reset in it.
  test('classifies a model-specific reached message as scope model, with an unparseable reset', () => {
    const result = parseUsageLimit('Fable 5 usage limit reached. Try again later.')
    assert.equal(result.scope, 'model')
    assert.equal(result.resetAt, null)
  })

  // Generic provider-wide phrasing with a parseable reset.
  test('classifies a generic usage-limit message as scope provider, with a parsed reset', () => {
    const result = parseUsageLimit('Claude AI usage limit reached|1735500000')
    assert.equal(result.scope, 'provider')
    assert.equal(result.resetAt.getTime(), 1735500000 * 1000)
  })

  // field-notes contract 4, the live hazard: this exact promotional text was
  // observed in a perfectly healthy session during this run's prototype.
  // Classifying it as a cap-hit would cool the model and kill a live
  // worker -- it must never match.
  test('a promotional mention of the weekly usage limit is not a cap-hit', () => {
    const result = parseUsageLimit(
      'Fable 5 is now a standard part of your Max plan / You can use up to 50% of your weekly usage limit on Fable 5…',
    )
    assert.equal(result, null)
  })

  test('pane text with no usage-limit language does not match', () => {
    assert.equal(parseUsageLimit('⏵⏵ bypass permissions on'), null)
  })
})

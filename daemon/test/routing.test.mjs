// Red tests for src/routing.mjs (plan.md step 5, step 11).
//
// Assumed contract (routing.mjs does not exist yet -- this is the contract
// these tests pin, mirroring the loaded shape of config/routing.yaml from
// plan.md step 1, all-Claude per stated deviation 3):
//
//   const routing = {
//     defaults: { grilling: 'fable', prototype: 'fable', research: 'opus', task: 'opus', untyped: 'opus' },
//     models:   { fable: { provider, harness }, opus: { ... }, sonnet: { ... } },
//     fallbacks: { fable: ['opus'], opus: ['sonnet'] },   // intra-Claude only
//     harnesses: { claude: { template: '...{model}...{prompt_file}...' } },
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
//   buildSpawnCmd(routing, harness, model, promptFile) -> string
//     template substitution; throws naming the configured harnesses on an
//     unknown harness key; throws if a substituted path is not quote-free
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
import { Cooling, resolveEffort, routingType, effortAccepts, acceptsEffort, resolveModel, namedModel, candidates, buildSpawnCmd, buildResumeCmd, parseUsageLimit, parseCreditGate, carriesLimitPhrase, providerOf } from '../src/routing.mjs'
import { OPENAI_CREDIT_GATE_PANE } from './fixtures/panes.mjs'

const routing = {
  defaults: { grilling: 'fable', prototype: 'fable', research: 'opus', task: 'opus', untyped: 'opus' },
  models: {
    fable: { provider: 'anthropic', harness: 'claude' },
    opus: { provider: 'anthropic', harness: 'claude' },
    sonnet: { provider: 'anthropic', harness: 'claude' },
  },
  fallbacks: { fable: ['opus'], opus: ['sonnet'] },
  harnesses: {
    claude: {
      template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"',
      resumeTemplate: 'claude --model {model} --permission-mode bypassPermissions --continue "Continue the interrupted work."',
      ready: '⏵⏵|bypass permissions', toolChannelGraceS: 15, readyRe: /⏵⏵|bypass permissions/,
    },
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

  // A provider-level (anthropic) limit cools every model at once -- #13's
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
  // provider-level entry cools every model at once, so an implementation that
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

  // The third kind (#646). A landed cap and a prediction both end on a clock; a
  // CREDENTIAL HOLD ends when a person finishes a login, so it states no reset
  // instant rather than inventing one.
  describe('the credential hold (#646)', () => {
    const soon = () => new Date(Date.now() + 3600_000)

    test('a hold cools the provider, and no clock lifts it', () => {
      const c = new Cooling()
      assert.equal(c.holdProvider('openai', 'refresh_token_reused'), true)
      assert.equal(c.isCool('gpt', 'openai'), true)
      assert.equal(c.isCool('opus', 'anthropic'), false, 'the other lane is untouched')
      assert.deepEqual(c.heldFor('openai'), { provider: 'openai', why: 'refresh_token_reused' })
      assert.equal(c.heldFor('anthropic'), null)
    })

    // The reason the hold carries no date at all: this number becomes "back at
    // HH:MM" on the dashboard banner and in Discord `/status`, and a held lane
    // comes back when someone acts.
    test('a hold has no reset, so earliestReset never invents one', () => {
      const c = new Cooling()
      c.holdProvider('openai', 'dead')
      assert.equal(c.earliestReset() == null, true)

      c.coolProvider('anthropic', soon())
      assert.equal(c.earliestReset().getTime(), [...c.providers.values()].find((e) => e.at)?.at.getTime())
    })

    test('a hold is not a prediction, and no reading touches it', () => {
      const c = new Cooling()
      c.holdProvider('openai', 'dead')
      assert.deepEqual(c.predictions(), [])
      assert.equal(c.predictionFor('openai'), null)
      assert.equal(c.clearPrediction('openai'), false)
      assert.equal(c.predictProvider('openai', { at: soon(), window: '5h', pct: 92 }), false)
      assert.equal(c.isCool('gpt', 'openai'), true, 'and it still stands after all of that')
    })

    // A named model steps over a guess. It does not step over a credential that
    // cannot be reached.
    test('a named model never steps over a hold', () => {
      const c = new Cooling()
      c.holdProvider('openai', 'dead')
      assert.equal(c.isCool('gpt', 'openai', { ignorePredicted: true }), true)
    })

    // A landed cap ends on the provider's clock and a hold does not, so letting
    // the timed entry win would un-hold a dead lane the moment the cap reset.
    test('a landed cap does not overwrite a hold', () => {
      const c = new Cooling()
      c.holdProvider('openai', 'dead')
      assert.equal(c.coolProvider('openai', soon()), false)
      assert.deepEqual(c.heldFor('openai'), { provider: 'openai', why: 'dead' })
      assert.equal(c.earliestReset() == null, true)
    })

    // The arm answers whether it took, which is what keeps the alarm to one
    // message per transition rather than one per 60-second tick.
    test('arming twice is refused, so the alarm is said once', () => {
      const c = new Cooling()
      assert.equal(c.holdProvider('openai', 'dead'), true)
      assert.equal(c.holdProvider('openai', 'still dead'), false)
      assert.equal(c.heldFor('openai').why, 'dead', 'and the first reason survives')
    })

    test('releasing lifts it, and says whether anything stood', () => {
      const c = new Cooling()
      assert.equal(c.releaseHold('openai'), false, 'nothing to lift')
      c.holdProvider('openai', 'dead')
      assert.equal(c.releaseHold('openai'), true)
      assert.equal(c.isCool('gpt', 'openai'), false)
      assert.equal(c.heldFor('openai'), null)
    })

    test('releasing never touches a landed cap wearing the same key', () => {
      const c = new Cooling()
      c.coolProvider('openai', soon())
      assert.equal(c.releaseHold('openai'), false)
      assert.equal(c.isCool('gpt', 'openai'), true)
    })
  })

  // The second trigger (#384). One store, two kinds of provider entry, and the
  // difference between them binds three rules.
  describe('the predicted entry (#384)', () => {
    const soon = () => new Date(Date.now() + 3600_000)

    test('a prediction cools the provider exactly as a landed cap does', () => {
      const c = new Cooling()
      assert.equal(c.predictProvider('anthropic', { at: soon(), window: '5h', pct: 92 }), true)
      assert.equal(c.isCool('fable', 'anthropic'), true)
      assert.equal(c.isCool('gpt', 'openai'), false)
      assert.equal(c.earliestReset() != null, true, 'the wake timer reads it unchanged')
      assert.deepEqual(c.predictions().map((p) => [p.provider, p.window, p.pct]), [['anthropic', '5h', 92]])
    })

    test('a named model steps over a prediction and never over a landed cap', () => {
      const c = new Cooling()
      c.predictProvider('anthropic', { at: soon(), window: '5h', pct: 92 })
      assert.equal(c.isCool('opus', 'anthropic', { ignorePredicted: true }), false)
      assert.equal(c.isCool('opus', 'anthropic'), true, 'the hold still stands for every other dispatch')

      const landed = new Cooling()
      landed.coolProvider('anthropic', soon())
      assert.equal(landed.isCool('opus', 'anthropic', { ignorePredicted: true }), true)
      // The model's own cap is not a provider entry at all, so no label lifts it.
      const sub = new Cooling()
      sub.coolModel('fable', soon())
      assert.equal(sub.isCool('fable', 'anthropic', { ignorePredicted: true }), true)
    })

    test('measured beats guessed, both ways round', () => {
      const c = new Cooling()
      c.predictProvider('anthropic', { at: soon(), window: '5h', pct: 92 })
      c.coolProvider('anthropic', soon())
      assert.deepEqual(c.predictions(), [], 'a landed cap overwrites the guess it lands on')
      assert.equal(c.clearPrediction('anthropic'), false, 'and nothing about a reading clears it')
      assert.equal(c.isCool('opus', 'anthropic'), true)
      assert.equal(c.predictProvider('anthropic', { at: soon(), window: '5h', pct: 91 }), false,
        'a guess never overwrites what curia measured')
    })

    test('a prediction lifts on demand, and expires on its own instant', () => {
      const c = new Cooling()
      c.predictProvider('anthropic', { at: soon(), window: '5h', pct: 92 })
      assert.equal(c.clearPrediction('anthropic'), true)
      assert.equal(c.isCool('opus', 'anthropic'), false)
      assert.equal(c.clearPrediction('anthropic'), false, 'lifting a hold that is not up says so')

      const past = new Cooling()
      past.predictProvider('anthropic', { at: new Date(Date.now() - 1_000), window: '5h', pct: 92 })
      assert.equal(past.isCool('opus', 'anthropic'), false)
      assert.deepEqual(past.predictions(), [])
      assert.equal(past.predictionFor('anthropic'), null)
    })
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

  // #384: the named model is the head of the chain and it alone steps over a
  // pre-emptive hold. What the chain falls through to is judged the way every
  // other dispatch judges it, because nobody named that one.
  test('a named model steps over a predicted hold, and the rest of the chain does not', () => {
    const cooling = new Cooling()
    cooling.predictProvider('anthropic', { at: new Date(Date.now() + 3600_000), window: '5h', pct: 92 })
    assert.deepEqual(candidates(routing, 'fable', cooling), [])
    assert.deepEqual(candidates(routing, 'fable', cooling, { named: 'fable' }), ['fable'])
    assert.deepEqual(candidates(routing, 'opus', cooling, { named: 'fable' }), [],
      'the bypass follows the name, not the walk')
  })

  test('a landed cap empties the chain whatever was named', () => {
    const cooling = new Cooling()
    cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))
    assert.deepEqual(candidates(routing, 'fable', cooling, { named: 'fable' }), [])
  })
})

// The model a human named, apart from the one routing picked (#384).
describe('namedModel', () => {
  test('a model: label names one, and so does the override on the start line', () => {
    assert.equal(namedModel(['model:sonnet', 'wayfinder:research'], null), 'sonnet')
    assert.equal(namedModel(['model:sonnet'], 'fable'), 'fable')
    assert.equal(namedModel([], 'fable'), 'fable')
  })

  test('the type table names nothing — nobody typed it', () => {
    assert.equal(namedModel(['wayfinder:research'], null), null)
    assert.equal(namedModel([], null), null)
    assert.equal(namedModel(undefined, null), null)
  })
})

describe('buildSpawnCmd', () => {
  test('substitutes model and prompt file into the harness template', () => {
    const cmd = buildSpawnCmd(routing, 'claude', 'opus', '/home/alp/curia-work/cfg/curia-42/prompt.md')
    assert.equal(
      cmd,
      'claude --model opus --permission-mode bypassPermissions "$(cat /home/alp/curia-work/cfg/curia-42/prompt.md)"',
    )
  })

  test('an unknown harness key throws, naming the configured harnesses', () => {
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

describe('buildResumeCmd', () => {
  test('it substitutes the model into the harness resume command', () => {
    assert.equal(
      buildResumeCmd(routing, 'claude', 'opus'),
      'claude --model opus --permission-mode bypassPermissions --continue "Continue the interrupted work."',
    )
  })

  test('it refuses a harness with no resume command', () => {
    const missing = { ...routing, harnesses: { claude: { ...routing.harnesses.claude, resumeTemplate: '' } } }
    assert.throws(() => buildResumeCmd(missing, 'claude', 'opus'), /resume template/)
  })

  test('the codex command resumes the newest session in its agent config directory', () => {
    const twoHarnesses = {
      ...routing,
      models: { ...routing.models, gpt: { provider: 'openai', harness: 'codex', id: 'gpt-5.6-sol' } },
      harnesses: {
        ...routing.harnesses,
        codex: {
          template: 'codex --model {model} "$(cat {prompt_file})"',
          resumeTemplate: 'codex resume --last --model {model} "Continue the interrupted work."',
          ready: '·\\s[~/]', readyRe: /·\s[~/]/,
        },
      },
    }
    assert.match(buildResumeCmd(twoHarnesses, 'codex', 'gpt'), /codex resume --last --model gpt-5\.6-sol/)
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
  // agent -- it must never match.
  test('a promotional mention of the weekly usage limit is not a cap-hit', () => {
    const result = parseUsageLimit(
      'Fable 5 is now a standard part of your Max plan / You can use up to 50% of your weekly usage limit on Fable 5…',
    )
    assert.equal(result, null)
  })

  test('pane text with no usage-limit language does not match', () => {
    assert.equal(parseUsageLimit('⏵⏵ bypass permissions on'), null)
  })

  // The #544 phrasing, verbatim off the live pane (2026-08-18): the CLI
  // printed this at a real Fable cap hit and the old pattern missed it — the
  // daemon wrote no cooling and armed no limit resume.
  test('the reached-your-model-limit phrasing is a model-scope hit with no reset', () => {
    const result = parseUsageLimit(
      "You've reached your Fable 5 limit. /model to switch models. /upgrade to increase your usage limit.",
    )
    assert.equal(result.scope, 'model')
    assert.equal(result.resetAt, null)
    // a TUI is free to render a typographic apostrophe; both match
    assert.equal(parseUsageLimit('You’ve reached your Fable 5 limit.').scope, 'model')
  })

  test('reached-your-limit phrasing naming no model is a provider-scope hit', () => {
    assert.equal(parseUsageLimit("You've reached your weekly limit.").scope, 'provider')
  })

  // The healthy-pane trap beside the new phrasing: the same promotional block
  // says "If you hit your limit, you can continue on Fable 5 with usage
  // credits" — hit-phrasing, not reached-phrasing, and it must never match.
  test('the promotional if-you-hit-your-limit text is not a cap-hit', () => {
    const result = parseUsageLimit(
      'You can use up to 50% of your weekly usage limit on Fable 5. If you hit your limit, you can continue on Fable 5 with usage credits.',
    )
    assert.equal(result, null)
  })

  test('the new phrasing counts as a forgeable limit phrase', () => {
    assert.equal(carriesLimitPhrase('the pane says "You\'ve reached your Fable 5 limit" wrongly'), true)
  })
})

describe('parseCreditGate (#126, #108 item 12)', () => {
  // The dialog verbatim, captured on the deployment box (2026-08-02) from a
  // spawn seeded exactly like an agent: same .claude.json, same env, same
  // daemon token. ASCII apostrophe as the pane renders it.
  const DIALOG = [
    '  Fable 5 now uses usage credits',
    '  Fable 5 runs on usage credits, purchased separately from your plan.',
    "  You don't have usage credits yet.",
    '    1. Request usage credits from your admin',
    '  ❯ 2. Switch to Sonnet 5 and continue',
    '  Enter to confirm · Esc to cancel',
  ].join('\n')

  test('the live dialog classifies as a model-scoped gate with a reason', () => {
    const r = parseCreditGate(DIALOG)
    assert.equal(r.scope, 'model')
    assert.equal(r.resetAt, null)
    assert.equal(r.reason, 'usage-credits dialog')
    // a TUI is free to render a typographic apostrophe; both match
    assert.ok(parseCreditGate('You don’t have usage credits yet'))
  })

  test('the informational "now uses usage credits" line alone never matches — promo text appears in healthy panes', () => {
    assert.equal(parseCreditGate('Fable 5 now uses usage credits. See the docs.'), null)
    assert.equal(parseCreditGate('⏵⏵ bypass permissions on'), null)
  })

  test('the credit vocabulary counts as a forgeable limit phrase', () => {
    assert.equal(carriesLimitPhrase("the CLI says You don't have usage credits yet"), true)
  })

  test('the live codex dialog classifies as a provider-scoped fault', () => {
    const r = parseCreditGate(OPENAI_CREDIT_GATE_PANE, 'openai')
    assert.equal(r.scope, 'provider')
    assert.equal(r.resetAt, null)
    assert.equal(r.reason, 'rate-limit credit dialog')
  })

  test('healthy codex usage text never matches the credit gate', () => {
    assert.equal(parseCreditGate('You have 2 usage limit resets available. Run /usage to use one.', 'openai'), null)
    assert.equal(parseCreditGate('Remaining usage on the primary usage limit', 'openai'), null)
  })
})

// ---- the codex harness (#39) ----------------------------------------------------

describe('two providers (#39, restoring #13)', () => {
  const twoLane = {
    defaults: { grilling: 'fable', research: 'gpt', task: 'opus', untyped: 'opus' },
    models: {
      fable: { provider: 'anthropic', harness: 'claude' },
      opus: { provider: 'anthropic', harness: 'claude' },
      sonnet: { provider: 'anthropic', harness: 'claude' },
      gpt: { provider: 'openai', harness: 'codex', id: 'gpt-5.5' },
    },
    fallbacks: { fable: ['opus'], opus: ['gpt', 'sonnet'], sonnet: ['gpt'], gpt: ['opus'] },
    harnesses: {
      claude: { template: 'claude --model {model} "$(cat {prompt_file})"' },
      codex: { template: 'codex --model {model} "$(cat {prompt_file})"' },
    },
  }

  test('research routes to the gpt model again — #33 sent it to opus by deviation', () => {
    assert.equal(resolveModel(twoLane, ['wayfinder:research']), 'gpt')
  })

  // `codex --model gpt` is not a model. The routing name is the LABEL
  // vocabulary (`model:gpt`); models.<name>.id is what the CLI is asked for.
  test('the spawn command carries the CLI model id, not the routing name', () => {
    assert.match(buildSpawnCmd(twoLane, 'codex', 'gpt', '/tmp/p.md'), /--model gpt-5\.5/)
  })

  test('a model with no id still spawns under its own name', () => {
    assert.match(buildSpawnCmd(twoLane, 'claude', 'opus', '/tmp/p.md'), /--model opus/)
  })

  // The id reaches a shell template, so it passes the same whitelist every
  // other substitution does.
  test('an id that is not quote-free is refused rather than substituted', () => {
    const bad = { ...twoLane, models: { ...twoLane.models, gpt: { ...twoLane.models.gpt, id: 'gpt"; rm -rf /' } } }
    assert.throws(() => buildSpawnCmd(bad, 'codex', 'gpt', '/tmp/p.md'), /not quote-free/)
  })

  // The point of a second provider (#13): one cooling provider is no longer
  // exhaustion, it is the ordinary case the cross-provider chains exist for.
  test('a cooling provider falls across to the other one instead of exhausting', () => {
    const cooling = new Cooling()
    cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))
    assert.deepEqual(candidates(twoLane, 'opus', cooling), ['gpt'])
  })

  test('exhaustion now needs BOTH providers cooling', () => {
    const cooling = new Cooling()
    cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))
    cooling.coolProvider('openai', new Date(Date.now() + 3600_000))
    assert.deepEqual(candidates(twoLane, 'opus', cooling), [])
  })

  // #187: the status line asks which provider an agent belongs to, and the
  // label it used to ask with is a spawn-time fact the daemon loses on a
  // restart. The harness survives on disk, so it answers instead.
  test('a harness states its provider, taken from the models configured on it', () => {
    assert.equal(providerOf(twoLane, 'claude'), 'anthropic')
    assert.equal(providerOf(twoLane, 'codex'), 'openai')
  })

  test('an unknown harness, and a harness two providers claim, answer nothing', () => {
    assert.equal(providerOf(twoLane, 'gemini'), null)
    assert.equal(providerOf(twoLane, null), null)
    assert.equal(providerOf(undefined, 'claude'), null)
    // A guess here would put one account's bars on the other account's agent.
    const split = { models: { ...twoLane.models, other: { provider: 'openai', harness: 'claude' } } }
    assert.equal(providerOf(split, 'claude'), null)
  })

  // #13's "never upgrade bulk work to fable" is structural, not remembered:
  // fable is downstream of nothing, so no chain can fall into it.
  test('no chain falls into fable', () => {
    const cooling = new Cooling()
    for (const from of Object.keys(twoLane.models)) {
      if (from === 'fable') continue
      assert.equal(candidates(twoLane, from, cooling).includes('fable'), false, `${from} reached fable`)
    }
  })
})

describe('parseUsageLimit is per provider (#39)', () => {
  // The codex cap message. The Claude pattern misses it outright: it requires a
  // word before "usage limit reached", and codex writes the phrase first.
  test('a codex cap message is a provider-scope hit with no parseable reset', () => {
    const result = parseUsageLimit("You've hit your usage limit. Upgrade to Plus to continue using Codex", 'openai')
    assert.equal(result.scope, 'provider')
    assert.equal(result.resetAt, null)
  })

  test('the other codex phrasings all read as cap hits', () => {
    for (const text of [
      'Usage limit reached. You\'ve reached your usage limit. Increase your limits to continue using codex.',
      'You’ve hit your usage limit for gpt-5.5',
      "You're out of credits.",
      'Your workspace is out of credits. Add credits to continue using Codex.',
      "You've reached your workspace credit limit",
    ]) {
      assert.notEqual(parseUsageLimit(text, 'openai'), null, text)
    }
  })

  // Read off a live pane, not guessed: codex opens EVERY session with this line
  // and puts the second in its status bar. Either one classified as a cap hit
  // would kill a healthy agent and cool the provider for an hour.
  test('the healthy-session lines codex always prints are not cap hits', () => {
    for (const text of [
      'You have 2 usage limit resets available. Run /usage to use one.',
      'No usage limit resets are available.',
      'Remaining usage on the primary usage limit',
      'Approaching rate limits',
    ]) {
      assert.equal(parseUsageLimit(text, 'openai'), null, text)
    }
  })

  test('each provider reads only its own vocabulary', () => {
    assert.equal(parseUsageLimit("You've hit your usage limit.", 'anthropic'), null)
    assert.equal(parseUsageLimit('You can use up to 50% of your weekly usage limit on Fable 5', 'openai'), null)
  })

  test('an unknown provider classifies nothing rather than guessing', () => {
    assert.equal(parseUsageLimit('Fable 5 usage limit reached', 'mistral'), null)
  })

  // The forge guard reads EVERY provider's vocabulary, because an agent's own
  // provider changes under it on a cross-provider fallback while this answer is
  // computed once, from the ticket text, at dispatch.
  test('the forge guard spans providers', () => {
    assert.equal(carriesLimitPhrase('the banner says "usage limit reached" wrongly'), true)
    assert.equal(carriesLimitPhrase("the banner says \"You've hit your usage limit\" wrongly"), true)
    assert.equal(carriesLimitPhrase('show the weekly usage limit in the header'), false)
  })
})

// ---------------------------------------------------------------------------
// reasoning effort (#707)
// ---------------------------------------------------------------------------

const EFFORT_ROUTING = {
  defaults: { research: 'gpt', task: 'opus', untyped: 'opus' },
  effort: { research: 'xhigh', task: 'high', untyped: 'medium' },
  models: {
    opus: { provider: 'anthropic', harness: 'claude', reasoning_effort: 'medium' },
    gpt: { provider: 'openai', harness: 'codex', reasoning_effort: 'low' },
    // a model that narrows its own harness's list
    terse: { provider: 'openai', harness: 'codex', reasoning_effort: 'low', efforts: ['low'] },
  },
  harnesses: {
    claude: { efforts: ['low', 'medium', 'high', 'xhigh'] },
    codex: { efforts: ['low', 'medium', 'high'] },
  },
}

describe('the ticket type and the model each say something about depth (#707)', () => {
  test('the type names the row, and a ticket with no type label reads `untyped`', () => {
    assert.equal(routingType(['wayfinder:research', 'ready-for-agent']), 'research')
    assert.equal(routingType(['ready-for-agent']), 'untyped')
    assert.equal(routingType([]), 'untyped')
    assert.equal(routingType(undefined), 'untyped')
  })

  test("the type's effort beats the model's own default", () => {
    assert.equal(EFFORT_ROUTING.models.opus.reasoning_effort, 'medium')
    assert.equal(resolveEffort(EFFORT_ROUTING, 'opus', 'task'), 'high')
  })

  test('a type with no row of its own falls to `untyped`, not to the model default', () => {
    assert.equal(resolveEffort(EFFORT_ROUTING, 'gpt', 'grilling'), 'medium')
  })

  test('a model default stands where the model has no word for the type effort', () => {
    // research asks for xhigh; the codex harness's list stops at high
    assert.equal(resolveEffort(EFFORT_ROUTING, 'gpt', 'research'), 'low')
    // and the same type on the claude lane keeps it — this is the fallback rule
    assert.equal(resolveEffort(EFFORT_ROUTING, 'opus', 'research'), 'xhigh')
  })

  test('a model narrows its harness, and its own list is the one that counts', () => {
    assert.deepEqual(effortAccepts(EFFORT_ROUTING, 'terse'), ['low'])
    assert.deepEqual(effortAccepts(EFFORT_ROUTING, 'gpt'), ['low', 'medium', 'high'])
    assert.equal(resolveEffort(EFFORT_ROUTING, 'terse', 'task'), 'low')
  })

  test('a stated list is a bound and no list is no bound — the two are not the same absence', () => {
    const loose = { models: { any: { provider: 'anthropic', harness: 'claude' } }, harnesses: { claude: {} }, effort: { task: 'ultra' } }
    assert.equal(effortAccepts(loose, 'any'), null)
    assert.equal(acceptsEffort(loose, 'any', 'ultra'), true)
    assert.equal(resolveEffort(loose, 'any', 'task'), 'ultra')
  })

  test('a routing with no effort table at all states nothing, and every model keeps its default', () => {
    const bare = { models: { opus: { provider: 'anthropic', harness: 'claude' }, gpt: { provider: 'openai', harness: 'codex', reasoning_effort: 'high' } }, harnesses: {} }
    assert.equal(resolveEffort(bare, 'opus', 'task'), null)
    assert.equal(resolveEffort(bare, 'gpt', 'task'), 'high')
  })

  // A model routing does not carry never reaches a spawn — dispatch refuses it
  // by name first — so this asks only that the resolution stays total: no throw,
  // no default invented on a model nothing knows.
  test('a model routing does not carry bounds nothing and defaults nothing', () => {
    assert.equal(effortAccepts(EFFORT_ROUTING, 'nosuch'), null)
    assert.equal(resolveEffort(EFFORT_ROUTING, 'nosuch', 'task'), 'high')
  })
})

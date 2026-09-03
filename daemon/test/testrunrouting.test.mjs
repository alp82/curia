// The Test run's routing row (#891, the owner's decision on the rehearsal).
//
// The live run dispatched the acceptance on the frontier model at high effort
// and its cross-check on the same tier. What is pinned here, against the
// SHIPPED `config/routing.yaml`: the `test-run` type routes to the cheapest
// model of its provider at the lowest effort, the cross-check of a `test-run`
// ticket reads on the cheapest model of the other provider, and the routing
// file names the cheapest model of each provider so the preset can move the
// row between them.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRoutingConfig } from '../src/config.mjs'
import { Cooling, resolveModel, reasoningEffortFor, resolveReviewer, spawnModelId } from '../src/routing.mjs'
import { TEST_RUN_TYPE, TICKET_LABEL, testRunMap } from '../src/testrunmap.mjs'

const SHIPPED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'routing.yaml')
const routing = loadRoutingConfig(SHIPPED, { localFile: null })
const labels = testRunMap('September 3, 2026').tickets[0].labels

describe('the Test run routes to the cheapest model at low effort (#891)', () => {
  test('the tickets carry the test-run type first, and the shipped file has a row for it', () => {
    assert.equal(TICKET_LABEL, `wayfinder:${TEST_RUN_TYPE}`)
    assert.equal(labels[0], TICKET_LABEL)
    assert.deepEqual(routing.defaults[TEST_RUN_TYPE], { model: 'haiku', effort: 'low' })
  })

  test('the shipped file names the cheapest model of each provider, on the codex and claude harnesses', () => {
    assert.deepEqual(routing.cheapest, { openai: 'luna', anthropic: 'haiku' })
    assert.equal(routing.models.luna.provider, 'openai')
    assert.equal(routing.models.luna.harness, 'codex')
    assert.equal(spawnModelId(routing, 'luna'), 'gpt-5.6-luna')
    assert.equal(routing.models.haiku.provider, 'anthropic')
    assert.equal(routing.models.haiku.harness, 'claude')
  })

  test('the dispatcher resolves a test-run ticket to that row: the cheap model, low effort', () => {
    assert.equal(resolveModel(routing, labels, null), 'haiku')
    assert.equal(reasoningEffortFor(routing, labels, 'haiku'), 'low')
    // Moved to the other provider (the preset, or a model label), the effort
    // is still the type's.
    assert.equal(reasoningEffortFor(routing, labels, 'luna'), 'low')
    assert.equal(resolveModel(routing, [...labels, 'model:luna'], null), 'luna')
  })

  test('the cross-check of a test-run ticket reads on the cheapest model of the other provider', () => {
    const cooling = new Cooling()
    assert.deepEqual(resolveReviewer(routing, { builderModel: 'haiku', labels, cooling }), { model: 'luna', wanted: 'luna', sameProvider: false })
    assert.deepEqual(resolveReviewer(routing, { builderModel: 'luna', labels, cooling }), { model: 'haiku', wanted: 'haiku', sameProvider: false })
    // Every other type keeps the provider pairing.
    assert.equal(resolveReviewer(routing, { builderModel: 'opus', labels: ['wayfinder:task'], cooling }).model, 'gpt')
    assert.equal(resolveReviewer(routing, { builderModel: 'haiku', labels: ['wayfinder:task'], cooling }).model, 'gpt')
    // A `review-model:` label still beats the row.
    assert.equal(resolveReviewer(routing, { builderModel: 'haiku', labels: [...labels, 'review-model:gpt'], cooling }).model, 'gpt')
  })

  test('the cheap models fall back to each other across providers and never up the tiers', () => {
    assert.deepEqual(routing.fallbacks.haiku, ['luna'])
    assert.deepEqual(routing.fallbacks.luna, ['haiku'])
    for (const chain of Object.values(routing.fallbacks)) {
      assert.ok(!chain.includes('fable'), 'nothing falls into fable')
    }
  })
})

// The routing preset of integration setup (#878, shared with #879).
//
// What is pinned: routing is READY when every default row names an active
// model whose provider has a credential on disk; the preset for a connected
// provider moves only the rows that are not ready onto that provider's model
// and keeps every row that is, switches the models of a provider without a
// credential off and the connected provider's on, lands as the override file
// the settings screen writes (the tracked file is never edited), and is a
// no-op when routing is ready already, so an operator's own routing choice
// is never rewritten by a read.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadRoutingConfig } from '../src/config.mjs'
import { presetModel, routingReadiness, routingPreset, ensureRoutingPreset } from '../src/modelrouting.mjs'

const BASE = [
  'defaults:',
  '  grilling: {model: opus, effort: high}',
  '  research: {model: gpt, effort: high}',
  '  map: {model: fable, effort: max}',
  '  untyped: {model: opus, effort: high}',
  '  test-run: {model: haiku, effort: low}',
  'models:',
  '  fable: { provider: anthropic, harness: claude }',
  '  opus: { provider: anthropic, harness: claude }',
  '  sonnet: { provider: anthropic, harness: claude }',
  '  haiku: { provider: anthropic, harness: claude }',
  '  gpt: { provider: openai, harness: codex, id: gpt-5.6-sol, reasoning_effort: high }',
  '  luna: { provider: openai, harness: codex, id: gpt-5.6-luna, reasoning_effort: low }',
  'cheapest:',
  '  openai: luna',
  '  anthropic: haiku',
  'fallbacks:',
  '  fable: [opus]',
  '  opus: [gpt, sonnet]',
  '  sonnet: [gpt]',
  '  gpt: [opus]',
  '  haiku: [luna]',
  '  luna: [haiku]',
  'review:',
  '  anthropic: gpt',
  '  openai: opus',
  '  test-run:',
  '    anthropic: luna',
  '    openai: haiku',
  'harnesses:',
  '  claude:',
  '    template: claude --model {model} "$(cat {prompt_file})"',
  '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
  "    ready: '⏵⏵|bypass permissions'",
  '    tool_channel_grace_s: 15',
  '  codex:',
  '    template: codex --model {model} "$(cat {prompt_file})"',
  '    resume_template: codex resume --last --model {model} "Continue the interrupted work."',
  "    ready: '·\\s[~/]'",
  '    tool_channel_grace_s: 20',
  '',
].join('\n')

let tmp
let routingFile
let localFile
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-modelrouting-'))
  routingFile = path.join(tmp, 'routing.yaml')
  fs.writeFileSync(routingFile, BASE)
  localFile = path.join(tmp, 'state', 'routing.local.yaml')
  fs.mkdirSync(path.dirname(localFile))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const live = () => loadRoutingConfig(routingFile, { localFile })

describe('the routing preset (#878)', () => {
  test('the preset model of a provider is the first model routing names for it', () => {
    const routing = live()
    assert.equal(presetModel(routing, 'openai'), 'gpt')
    assert.equal(presetModel(routing, 'anthropic'), 'fable')
    assert.equal(presetModel(routing, 'other'), null)
  })

  test('routing is ready only when every default row names an active model on a provider with a credential', () => {
    const routing = live()
    const onlyOpenai = routingReadiness(routing, ['openai'])
    assert.equal(onlyOpenai.ready, false)
    assert.deepEqual(onlyOpenai.missing, ['grilling', 'map', 'untyped', 'test-run', 'review.openai', 'review.test-run.openai'])
    assert.deepEqual(onlyOpenai.rows.find((r) => r.type === 'research'), { type: 'research', model: 'gpt', id: 'gpt-5.6-sol', effort: 'high', provider: 'openai', active: true, credentialed: true, ok: true })
    assert.equal(routingReadiness(routing, ['openai', 'anthropic']).ready, true)
    routing.models.gpt.active = false
    const off = routingReadiness(routing, ['openai', 'anthropic'])
    assert.equal(off.ready, false)
    assert.deepEqual(off.missing, ['research', 'review.anthropic'])
    // The connecting provider's own models must be on, whatever the rows say,
    // and a review row on the switched-off model is not ready either.
    routing.defaults.research = { model: 'opus', effort: 'high' }
    routing.models.luna.active = false
    assert.deepEqual(routingReadiness(routing, ['openai', 'anthropic']).missing, ['review.anthropic', 'review.test-run.anthropic'])
    assert.deepEqual(routingReadiness(routing, ['openai', 'anthropic'], { provider: 'openai' }).missing, ['models.gpt', 'models.luna', 'review.anthropic', 'review.test-run.anthropic'])
    routing.review = {}
    assert.equal(routingReadiness(routing, ['openai', 'anthropic']).ready, true)
  })

  test('the preset moves the rows that are not ready onto the connected provider, keeps the rest, and switches models by credential', () => {
    const patch = routingPreset(live(), { provider: 'openai', credentialed: ['openai'] })
    assert.deepEqual(patch, {
      defaults: {
        grilling: { model: 'gpt', effort: 'high' },
        research: { model: 'gpt', effort: 'high' },
        map: { model: 'gpt', effort: 'max' },
        untyped: { model: 'gpt', effort: 'high' },
        'test-run': { model: 'luna', effort: 'low' },
      },
      models: { fable: { active: false }, opus: { active: false }, sonnet: { active: false }, haiku: { active: false }, gpt: { active: true }, luna: { active: true } },
      review: { anthropic: 'gpt', openai: null, 'test-run': { anthropic: 'luna', openai: null } },
    })
  })

  test('the preset lands as the override file and the live routing is ready afterwards; a ready routing is left alone', async () => {
    const applied = []
    const out = ensureRoutingPreset({
      routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: live(), apply: (next) => applied.push(next), log: () => {},
    })
    assert.equal(out.applied, true)
    assert.equal(out.ready, true)
    assert.equal(out.model, 'gpt')
    assert.equal(out.file, localFile)
    assert.equal(applied.length, 1)
    assert.equal(fs.readFileSync(routingFile, 'utf8'), BASE, 'the tracked file is never edited')
    const over = fs.readFileSync(localFile, 'utf8')
    assert.match(over, /untyped:\n\s+model: gpt\n\s+effort: high/)
    assert.match(over, /opus:\n\s+active: false/)
    assert.doesNotMatch(over, /research/, 'a row that was ready already is not repeated in the override')
    const after = live()
    assert.equal(routingReadiness(after, ['openai']).ready, true)
    assert.equal(after.defaults.untyped.model, 'gpt')
    assert.equal(after.models.opus.active, false)

    // Ready already: nothing is written and nothing is applied.
    const again = ensureRoutingPreset({ routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: after, apply: (next) => applied.push(next), log: () => {} })
    assert.equal(again.applied, false)
    assert.equal(again.ready, true)
    assert.equal(applied.length, 1)
    assert.equal(fs.readFileSync(localFile, 'utf8'), over)
  })

  test('the second provider connecting switches its models back on and keeps the rows the first preset moved', () => {
    ensureRoutingPreset({ routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: live(), apply: () => {}, log: () => {} })
    const out = ensureRoutingPreset({ routingFile, localFile, provider: 'anthropic', credentialed: ['openai', 'anthropic'], live: live(), apply: () => {}, log: () => {} })
    // Every row routes to gpt and stays there: the rows are ready. What the
    // second connection changes is its own models, back on.
    assert.equal(out.applied, true)
    const after = live()
    assert.equal(after.defaults.untyped.model, 'gpt')
    assert.equal(after.models.opus.active, true)
    assert.equal(after.models.gpt.active, true)
    assert.doesNotMatch(fs.readFileSync(localFile, 'utf8'), /active/, 'every model is back to the tracked answer, so no switch is repeated')
  })

  // The rehearsal (#891) found the preset with one provider leaving
  // `review.openai: opus` in place after it switched opus off, and the
  // override then refused to load: a cross-check cannot run on a model that
  // is switched off. A review row names the OTHER provider's model by
  // design, so with one provider the row that cannot run has no model to
  // move to and is dropped; the row the verified provider can review stays.
  describe('the review rows (#891)', () => {
    test('a review row on a model that is switched off is not ready', () => {
      const routing = live()
      const onlyOpenai = routingReadiness(routing, ['openai'], { provider: 'openai' })
      assert.ok(onlyOpenai.missing.includes('review.openai'), onlyOpenai.missing.join(', '))
      assert.ok(!onlyOpenai.missing.includes('review.anthropic'))
      assert.equal(routingReadiness(routing, ['openai', 'anthropic']).ready, true)
    })

    test('with OpenAI alone the preset drops the row that would review OpenAI, keeps the other, and the result loads', () => {
      const patch = routingPreset(live(), { provider: 'openai', credentialed: ['openai'] })
      assert.deepEqual(patch.review, { anthropic: 'gpt', openai: null, 'test-run': { anthropic: 'luna', openai: null } })
      const out = ensureRoutingPreset({ routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: live(), apply: () => {}, log: () => {} })
      assert.equal(out.ready, true)
      assert.deepEqual(out.missing, [])
      const after = live()
      assert.deepEqual(after.review, { anthropic: 'gpt', 'test-run': { anthropic: 'luna' } })
      assert.equal(after.models.opus.active, false)
      assert.equal(fs.readFileSync(routingFile, 'utf8'), BASE, 'the tracked file is never edited')
    })

    test('with Anthropic alone the preset drops the row that would review Anthropic and keeps the other', () => {
      const patch = routingPreset(live(), { provider: 'anthropic', credentialed: ['anthropic'] })
      assert.deepEqual(patch.review, { anthropic: null, openai: 'opus', 'test-run': { anthropic: null, openai: 'haiku' } })
      const out = ensureRoutingPreset({ routingFile, localFile, provider: 'anthropic', credentialed: ['anthropic'], live: live(), apply: () => {}, log: () => {} })
      assert.equal(out.ready, true)
      const after = live()
      assert.deepEqual(after.review, { openai: 'opus', 'test-run': { openai: 'haiku' } })
      assert.equal(after.defaults.research.model, 'fable')
      assert.equal(after.models.gpt.active, false)
    })

    test('with both providers every review row stays, and the second provider restores the row the first preset dropped', () => {
      ensureRoutingPreset({ routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: live(), apply: () => {}, log: () => {} })
      assert.deepEqual(live().review, { anthropic: 'gpt', 'test-run': { anthropic: 'luna' } })
      const out = ensureRoutingPreset({ routingFile, localFile, provider: 'anthropic', credentialed: ['openai', 'anthropic'], live: live(), apply: () => {}, log: () => {} })
      assert.equal(out.ready, true)
      assert.deepEqual(live().review, { anthropic: 'gpt', openai: 'opus', 'test-run': { anthropic: 'luna', openai: 'haiku' } })
      assert.doesNotMatch(fs.readFileSync(localFile, 'utf8'), /review/, 'both rows are back to the tracked answer, so neither is repeated')
      assert.deepEqual(routingPreset(live(), { provider: 'anthropic', credentialed: ['openai', 'anthropic'] }).review, { anthropic: 'gpt', openai: 'opus', 'test-run': { anthropic: 'luna', openai: 'haiku' } })
    })
  })

  // The owner's decision on the rehearsal (#891): the Test run runs on the
  // cheapest model at its lowest effort, whichever provider signs in. The
  // row sits on a provider's cheapest model, so the preset moves it to the
  // cheapest model of the connecting provider, not to the first one, and
  // the type's own review row moves the same way.
  describe('the cheap tier (#891)', () => {
    test('with OpenAI alone the test-run row moves to luna at low effort, and its cross-check reads on luna', () => {
      const patch = routingPreset(live(), { provider: 'openai', credentialed: ['openai'] })
      assert.deepEqual(patch.defaults['test-run'], { model: 'luna', effort: 'low' })
      assert.deepEqual(patch.review['test-run'], { anthropic: 'luna', openai: null })
      const out = ensureRoutingPreset({ routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: live(), apply: () => {}, log: () => {} })
      assert.equal(out.ready, true)
      assert.deepEqual(out.rows.find((r) => r.type === 'test-run'), { type: 'test-run', model: 'luna', id: 'gpt-5.6-luna', effort: 'low', provider: 'openai', active: true, credentialed: true, ok: true })
      const after = live()
      assert.deepEqual(after.defaults['test-run'], { model: 'luna', effort: 'low' })
      assert.deepEqual(after.review['test-run'], { anthropic: 'luna' })
      assert.match(fs.readFileSync(localFile, 'utf8'), /test-run:\n\s+model: luna\n\s+effort: low/)
    })

    test('with Anthropic alone the test-run row stays on haiku at low effort, and its cross-check reads on haiku', () => {
      const patch = routingPreset(live(), { provider: 'anthropic', credentialed: ['anthropic'] })
      assert.deepEqual(patch.defaults['test-run'], { model: 'haiku', effort: 'low' })
      assert.deepEqual(patch.review['test-run'], { anthropic: null, openai: 'haiku' })
      ensureRoutingPreset({ routingFile, localFile, provider: 'anthropic', credentialed: ['anthropic'], live: live(), apply: () => {}, log: () => {} })
      const after = live()
      assert.deepEqual(after.defaults['test-run'], { model: 'haiku', effort: 'low' })
      assert.deepEqual(after.review['test-run'], { openai: 'haiku' })
      assert.equal(routingReadiness(after, ['anthropic']).rows.find((r) => r.type === 'test-run').id, 'haiku')
    })

    test('with both providers the test-run row keeps the cheap model it has, and both cross-check rows stand', () => {
      const patch = routingPreset(live(), { provider: 'openai', credentialed: ['openai', 'anthropic'] })
      assert.deepEqual(patch.defaults['test-run'], { model: 'haiku', effort: 'low' })
      assert.deepEqual(patch.review['test-run'], { anthropic: 'luna', openai: 'haiku' })
      // OpenAI first, Anthropic second: the row moved to luna and stays there,
      // because a ready row is left alone.
      ensureRoutingPreset({ routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: live(), apply: () => {}, log: () => {} })
      ensureRoutingPreset({ routingFile, localFile, provider: 'anthropic', credentialed: ['openai', 'anthropic'], live: live(), apply: () => {}, log: () => {} })
      const after = live()
      assert.deepEqual(after.defaults['test-run'], { model: 'luna', effort: 'low' })
      assert.deepEqual(after.review['test-run'], { anthropic: 'luna', openai: 'haiku' })
    })

    test('a routing the operator edited keeps their choice: a test-run row on a model that runs is not moved', () => {
      fs.writeFileSync(localFile, ['defaults:', '  test-run: {model: sonnet, effort: medium}', ''].join('\n'))
      const out = ensureRoutingPreset({ routingFile, localFile, provider: 'anthropic', credentialed: ['anthropic'], live: live(), apply: () => {}, log: () => {} })
      assert.equal(out.ready, true)
      assert.deepEqual(live().defaults['test-run'], { model: 'sonnet', effort: 'medium' })
    })

    test('a routing file with no `cheapest` moves a cheap row like any other, onto the first model', () => {
      fs.writeFileSync(routingFile, BASE.replace(/cheapest:\n  openai: luna\n  anthropic: haiku\n/, ''))
      const patch = routingPreset(live(), { provider: 'openai', credentialed: ['openai'] })
      assert.deepEqual(patch.defaults['test-run'], { model: 'gpt', effort: 'low' })
    })
  })

  test('a preset that cannot be written is the failure the card reports, and the tracked file stands', () => {
    fs.rmSync(path.dirname(localFile), { recursive: true })
    assert.throws(
      () => ensureRoutingPreset({ routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: live(), apply: () => {}, log: () => {} }),
      /routing\.local\.yaml|ENOENT/,
    )
    assert.equal(fs.readFileSync(routingFile, 'utf8'), BASE)
  })
})

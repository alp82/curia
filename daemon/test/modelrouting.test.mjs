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
  'models:',
  '  fable: { provider: anthropic, harness: claude }',
  '  opus: { provider: anthropic, harness: claude }',
  '  sonnet: { provider: anthropic, harness: claude }',
  '  gpt: { provider: openai, harness: codex, id: gpt-5.6-sol, reasoning_effort: high }',
  'fallbacks:',
  '  fable: [opus]',
  '  opus: [gpt, sonnet]',
  '  sonnet: [gpt]',
  '  gpt: [opus]',
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
    assert.deepEqual(onlyOpenai.missing, ['grilling', 'map', 'untyped'])
    assert.deepEqual(onlyOpenai.rows.find((r) => r.type === 'research'), { type: 'research', model: 'gpt', provider: 'openai', active: true, credentialed: true, ok: true })
    assert.equal(routingReadiness(routing, ['openai', 'anthropic']).ready, true)
    routing.models.gpt.active = false
    const off = routingReadiness(routing, ['openai', 'anthropic'])
    assert.equal(off.ready, false)
    assert.deepEqual(off.missing, ['research'])
    // The connecting provider's own models must be on, whatever the rows say.
    routing.defaults.research = { model: 'opus', effort: 'high' }
    assert.equal(routingReadiness(routing, ['openai', 'anthropic']).ready, true)
    assert.deepEqual(routingReadiness(routing, ['openai', 'anthropic'], { provider: 'openai' }).missing, ['models.gpt'])
  })

  test('the preset moves the rows that are not ready onto the connected provider, keeps the rest, and switches models by credential', () => {
    const patch = routingPreset(live(), { provider: 'openai', credentialed: ['openai'] })
    assert.deepEqual(patch, {
      defaults: {
        grilling: { model: 'gpt', effort: 'high' },
        research: { model: 'gpt', effort: 'high' },
        map: { model: 'gpt', effort: 'max' },
        untyped: { model: 'gpt', effort: 'high' },
      },
      models: { fable: { active: false }, opus: { active: false }, sonnet: { active: false }, gpt: { active: true } },
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

  test('a preset that cannot be written is the failure the card reports, and the tracked file stands', () => {
    fs.rmSync(path.dirname(localFile), { recursive: true })
    assert.throws(
      () => ensureRoutingPreset({ routingFile, localFile, provider: 'openai', credentialed: ['openai'], live: live(), apply: () => {}, log: () => {} }),
      /routing\.local\.yaml|ENOENT/,
    )
    assert.equal(fs.readFileSync(routingFile, 'utf8'), BASE)
  })
})

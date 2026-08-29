import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  harnessReasoningEffort, resolveModel, reasoningEffortFor,
} from '../src/routing.mjs'
import { HARNESS_REGISTRY } from '../src/harnesses.mjs'
import { loadRoutingConfig } from '../src/config.mjs'

const routing = {
  defaults: {
    task: { model: 'opus', effort: 'max' },
    prototype: { model: 'gpt', effort: 'ultra' },
    untyped: { model: 'gpt', effort: 'high' },
  },
  models: {
    opus: { provider: 'anthropic', harness: 'claude', reasoning_effort: 'high' },
    gpt: { provider: 'openai', harness: 'codex', reasoning_effort: 'medium' },
  },
}

const fixtureAdapter = {
  identity: { name: 'fixture' },
  control: {
    capabilities: { reasoningEffort: true },
    operations: { reasoningEffort: (effort) => effort === 'ultra' ? null : effort },
  },
}
const fixtureRegistry = {
  get: (name) => name === 'fixture' ? fixtureAdapter : HARNESS_REGISTRY.get(name),
}

describe('ticket-type reasoning effort', () => {
  test('the type selects model and effort, while a model label changes only the model', () => {
    const labels = ['wayfinder:task']
    assert.equal(resolveModel(routing, labels), 'opus')
    assert.equal(reasoningEffortFor(routing, labels, 'opus'), 'max')

    const labelled = ['wayfinder:task', 'model:gpt']
    assert.equal(resolveModel(routing, labelled), 'gpt')
    assert.equal(reasoningEffortFor(routing, labelled, 'gpt'), 'max')
  })

  test('fallback keeps a supported type effort and otherwise uses the model default', () => {
    assert.equal(reasoningEffortFor(routing, ['wayfinder:prototype'], 'gpt'), 'ultra')
    assert.equal(harnessReasoningEffort('codex', 'ultra'), 'ultra')

    const withFixtureFallback = {
      ...routing,
      models: {
        ...routing.models,
        fixture: { provider: 'openai', harness: 'fixture', reasoning_effort: 'medium' },
      },
    }
    assert.equal(reasoningEffortFor(withFixtureFallback, ['wayfinder:prototype'], 'fixture', fixtureRegistry), 'medium')
    assert.equal(harnessReasoningEffort('fixture', 'medium', fixtureRegistry), 'medium')

    withFixtureFallback.models.fixture.reasoning_effort = 'ultra'
    assert.equal(reasoningEffortFor(withFixtureFallback, ['wayfinder:prototype'], 'fixture', fixtureRegistry), null)
  })

  test('harness spelling maps the shared effort vocabulary onto each CLI', () => {
    assert.equal(harnessReasoningEffort('claude', 'ultra'), 'ultracode')
    assert.equal(harnessReasoningEffort('fixture', 'high', fixtureRegistry), 'high')
    assert.equal(harnessReasoningEffort('fixture', 'ultra', fixtureRegistry), null)
  })
})

const routingYaml = (defaults, modelEffort = 'high') => [
  'defaults:',
  ...defaults.map((line) => `  ${line}`),
  'models:',
  '  opus: { provider: anthropic, harness: claude, reasoning_effort: high }',
  `  gpt: { provider: openai, harness: codex, reasoning_effort: ${modelEffort} }`,
  'harnesses:',
  "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'x', tool_channel_grace_s: 15 }",
  "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'x', tool_channel_grace_s: 15 }",
].join('\n')

const load = (yaml) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-reasoning-routing-'))
  const file = path.join(dir, 'routing.yaml')
  fs.writeFileSync(file, yaml)
  try {
    return loadRoutingConfig(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('reasoning effort config', () => {
  test('a default row accepts a model and a ticket-type effort', () => {
    const config = load(routingYaml([
      'task: { model: opus, effort: max }',
      'untyped: { model: gpt, effort: high }',
    ]))
    assert.deepEqual(config.defaults.task, { model: 'opus', effort: 'max' })
    assert.equal(resolveModel(config, ['wayfinder:task']), 'opus')
    assert.equal(reasoningEffortFor(config, ['wayfinder:task'], 'opus'), 'max')
  })

  test('boot refuses a model default that its harness cannot state', () => {
    const yaml = routingYaml(['untyped: gpt'], 'ultra')
      .replace('harness: codex', 'harness: unknown')
    assert.throws(
      () => load(yaml),
      /models\.gpt\.reasoning_effort "ultra" is not supported by the unknown harness/,
    )
  })
})

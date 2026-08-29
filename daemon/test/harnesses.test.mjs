import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CURRENT_CONFIG_LAYOUT,
  HARNESS_REGISTRY,
  HarnessCapabilityError,
  HarnessContractError,
  createHarnessPorts,
  createHarnessRegistry,
  normalizedEvent,
  requireHarnessCapability,
  spawnIdentity,
  unknownNativeEvidence,
} from '../src/harnesses.mjs'
import { Reduction } from '../src/reduction.mjs'
import { HarnessRuntime } from '../src/harnessruntime.mjs'

const methods = (names) => Object.fromEntries(names.map((name) => [name, () => name]))

function fakeAdapter(name = 'fake', overrides = {}) {
  const capabilities = {
    modelSwitch: false,
    reasoningEffort: false,
    transcriptUsage: false,
    nativeSkills: false,
    richMetadata: false,
  }
  return {
    identity: {
      name,
      provider: 'test-provider',
      credentialConsumer: 'test-consumer',
      configLayoutVersion: 1,
    },
    setup: {
      ...methods(['refuseRepository', 'prepare']),
      workspace: {
        configRootEnv: 'FAKE_HOME', memoryFile: 'FAKE.md', repoSkillRoots: [],
        ...methods([
          'hostStore', 'env', 'seed', 'connectionSettings', 'connectionWorktree',
          'untrustedProjectConfig', 'skillInvocation', 'wayfinderInvocation', 'deferredToolOrders',
        ]),
      },
    },
    lifecycle: methods(['freshCommand', 'resumeCommand', 'isReady', 'classifyLimit', 'processDied', 'interrupt', 'send', 'strandedCallRecovery', 'rewind']),
    evidence: {
      ...methods(['discover', 'events', 'activity', 'usage']),
      native: methods(['files', 'namesSession', 'present', 'parse', 'identity', 'unknownType']),
    },
    control: {
      capabilities,
      operations: {},
      enforceCompletion: () => 'complete',
    },
    ...overrides,
  }
}

describe('the Harness adapter registry', () => {
  test('the static registry returns frozen Claude and Codex adapters', () => {
    assert.deepEqual(HARNESS_REGISTRY.names, ['claude', 'codex'])
    const claude = HARNESS_REGISTRY.get('claude')
    assert.equal(claude.identity.provider, 'anthropic')
    assert.equal(claude.identity.credentialConsumer, 'claude')
    assert.equal(claude.identity.configLayoutVersion, CURRENT_CONFIG_LAYOUT)
    assert.equal(Object.isFrozen(claude), true)
    assert.equal(Object.isFrozen(claude.lifecycle), true)
  })

  test('duplicate names and missing facets refuse registry construction', () => {
    assert.throws(
      () => createHarnessRegistry([fakeAdapter(), fakeAdapter()]),
      /duplicate Harness adapter name "fake"/,
    )
    const broken = fakeAdapter()
    delete broken.evidence
    assert.throws(() => createHarnessRegistry([broken]), /needs the evidence facet/)
  })

  test('providers, credential consumers, and capability declarations validate at construction', () => {
    assert.throws(
      () => createHarnessRegistry([fakeAdapter()], { providers: ['another'] }),
      /unknown provider "test-provider"/,
    )
    assert.throws(
      () => createHarnessRegistry([fakeAdapter()], { credentialConsumers: ['another'] }),
      /unknown credential consumer "test-consumer"/,
    )
    const control = {
      capabilities: {
        modelSwitch: true,
        reasoningEffort: false,
        transcriptUsage: false,
        nativeSkills: false,
        richMetadata: false,
      },
      operations: {},
      enforceCompletion: () => {},
    }
    assert.throws(
      () => createHarnessRegistry([fakeAdapter('fake', { control })]),
      /declares modelSwitch without an operation/,
    )
  })

  test('an unknown lookup fails before native behavior runs', () => {
    assert.throws(
      () => HARNESS_REGISTRY.get('other'),
      (error) => error instanceof HarnessContractError && error.code === 'HARNESS_UNKNOWN',
    )
  })
})

describe('Harness ports and normalized evidence', () => {
  test('fake ports construct without tmux, a container, or a command-line interface', () => {
    const ports = createHarnessPorts({
      filesystem: methods(['refuseRepository', 'prepare']),
      process: methods(['died', 'interrupt']),
      pane: methods(['capture', 'send']),
      transcript: methods(['discover', 'events', 'activity', 'usage']),
      toolChannel: methods(['enforceCompletion']),
    })
    assert.equal(ports.pane.capture(), 'capture')
    assert.equal(Object.isFrozen(ports), true)
    assert.throws(() => createHarnessPorts({
      filesystem: {}, process: {}, pane: {}, transcript: {}, toolChannel: {},
    }), /filesystem port needs refuseRepository/)
  })

  test('unknown native evidence stays visible in the shared vocabulary', () => {
    assert.deepEqual(unknownNativeEvidence('future_item', { source: 'fixture' }), {
      type: 'unknown_native_evidence', nativeType: 'future_item', source: 'fixture',
    })
    assert.throws(() => normalizedEvent('made_up'), /unknown normalized Harness event/)
  })
})

describe('registry-supplied shared orchestration', () => {
  test('a fixture-only adapter exercises launch, resume, evidence, refusal, and fallback', () => {
    const fixture = fakeAdapter('fixture', {
      lifecycle: {
        ...methods(['isReady', 'classifyLimit', 'processDied', 'interrupt', 'send', 'strandedCallRecovery', 'rewind']),
        freshCommand: ({ model }) => `fixture start ${model}`,
        resumeCommand: ({ model }) => `fixture resume ${model}`,
      },
      evidence: {
        ...methods(['discover', 'activity', 'usage']),
        events: () => [normalizedEvent('assistant_message', { text: 'fixture evidence' })],
        native: methods(['files', 'namesSession', 'present', 'parse', 'identity', 'unknownType']),
      },
    })
    const runtime = new HarnessRuntime(createHarnessRegistry([fixture]))

    assert.equal(runtime.command('fixture', { model: 'one' }), 'fixture start one')
    assert.equal(runtime.command('fixture', { model: 'one' }, { resume: true }), 'fixture resume one')
    assert.deepEqual(runtime.events('fixture', {}), [{
      type: 'assistant_message', text: 'fixture evidence',
    }])
    assert.throws(
      () => runtime.control('fixture', 'modelSwitch'),
      (error) => error instanceof HarnessCapabilityError,
    )
    assert.deepEqual(runtime.fallback({ from: 'claude', to: 'fixture' }), {
      crossHarness: true, preserveWorktree: true, reuseNativeConversation: false,
    })
    assert.throws(
      () => runtime.fallback({ from: 'claude', to: 'fixture', resume: true }),
      /refusing to resume native claude conversation state on the fixture Harness/,
    )
  })
})

describe('Harness capabilities and durable identity', () => {
  test('the Claude adapter drives native behavior through fake ports', async () => {
    const adapter = HARNESS_REGISTRY.get('claude')
    const steps = []
    const panes = [
      '❯ /model opus\nSwitch model?\n❯ 1. Yes, switch to opus',
      '❯ /model opus\nSet model to opus\n❯',
    ]
    const ports = createHarnessPorts({
      filesystem: {
        refuseRepository: (context) => ({ refused: context.wtPath }),
        prepare: (context) => ({ prepared: context.cfgDir }),
      },
      process: methods(['died', 'interrupt']),
      pane: {
        capture: () => panes.shift() ?? '',
        send: (session, value) => { steps.push(['send', session, value]); return { status: 'sent' } },
        key: (session, value) => { steps.push(['key', session, value]) },
      },
      transcript: {
        discover: methods(['discover']).discover,
        events: methods(['events']).events,
        activity: (context) => ({ file: context.cfgDir, mtimeMs: 1 }),
        usage: methods(['usage']).usage,
        richMetadata: methods(['richMetadata']).richMetadata,
      },
      toolChannel: methods(['enforceCompletion']),
    })

    assert.equal(adapter.lifecycle.isReady({ paneText: '⏵⏵ bypass permissions' }), true)
    assert.deepEqual(adapter.setup.prepare({ cfgDir: '/cfg' }, ports), { prepared: '/cfg' })
    assert.deepEqual(adapter.evidence.activity({ cfgDir: '/cfg' }, ports), { file: '/cfg', mtimeMs: 1 })
    assert.equal(adapter.control.enforceCompletion({}, ports), 'enforceCompletion')
    assert.deepEqual(
      await requireHarnessCapability(adapter, 'modelSwitch', {
        session: 'curia-1', model: 'opus', readbackMs: 500,
      }, ports),
      { status: 'switched' },
    )
    assert.deepEqual(steps, [
      ['key', 'curia-1', 'C-u'],
      ['send', 'curia-1', '/model opus'],
      ['key', 'curia-1', 'Enter'],
      ['key', 'curia-1', 'C-y'],
    ])
  })

  test('the Codex adapter drives native behavior through fake ports', async () => {
    const adapter = HARNESS_REGISTRY.get('codex')
    const steps = []
    const ports = createHarnessPorts({
      filesystem: {
        refuseRepository: (context) => ({ refused: context.wtPath }),
        prepare: (context) => ({ prepared: context.cfgDir }),
        nativeSkills: methods(['nativeSkills']).nativeSkills,
      },
      process: methods(['died', 'interrupt']),
      pane: {
        capture: methods(['capture']).capture,
        send: methods(['send']).send,
        key: (session, value) => { steps.push(['key', session, value]) },
        kill: (session) => { steps.push(['kill', session]) },
        resume: ({ session, model }) => { steps.push(['resume', session, model]) },
        reasoningEffort: methods(['reasoningEffort']).reasoningEffort,
      },
      transcript: {
        discover: methods(['discover']).discover,
        events: methods(['events']).events,
        activity: (context) => ({ file: context.cfgDir, mtimeMs: 2 }),
        usage: methods(['usage']).usage,
        richMetadata: methods(['richMetadata']).richMetadata,
      },
      toolChannel: methods(['enforceCompletion']),
    })
    const routing = {
      models: { gpt: { id: 'gpt-5.6-sol' } },
      harnesses: {
        codex: {
          template: 'codex --model {model} "$(cat {prompt_file})"',
          resumeTemplate: 'codex resume --last --model {model}',
        },
      },
    }

    assert.equal(adapter.lifecycle.isReady({ paneText: 'gpt-5.6-sol high · ~/work' }), true)
    assert.deepEqual(adapter.lifecycle.classifyLimit({ paneText: "You've hit your usage limit." }), {
      scope: 'provider', resetAt: null,
    })
    assert.match(adapter.lifecycle.freshCommand({ routing, model: 'gpt', promptFile: '/cfg/prompt.md' }), /gpt-5\.6-sol/)
    assert.match(adapter.lifecycle.resumeCommand({ routing, model: 'gpt' }), /resume --last/)
    assert.deepEqual(adapter.setup.prepare({ cfgDir: '/cfg' }, ports), { prepared: '/cfg' })
    assert.deepEqual(adapter.evidence.activity({ cfgDir: '/cfg' }, ports), { file: '/cfg', mtimeMs: 2 })
    assert.equal(adapter.control.enforceCompletion({}, ports), 'enforceCompletion')
    assert.deepEqual(
      await requireHarnessCapability(adapter, 'modelSwitch', {
        session: 'curia-2', model: 'gpt-5.5',
      }, ports),
      { status: 'switched', resumed: true, recorded: true },
    )
    assert.deepEqual(steps, [
      ['key', 'curia-2', 'C-u'],
      ['kill', 'curia-2'],
      ['resume', 'curia-2', 'gpt-5.5'],
    ])
  })

  test('unsupported controls refuse before a pane operation can run', () => {
    const adapter = createHarnessRegistry([fakeAdapter()]).get('fake')
    assert.throws(
      () => requireHarnessCapability(adapter, 'modelSwitch'),
      (error) => error instanceof HarnessCapabilityError
        && error.code === 'HARNESS_CAPABILITY_UNAVAILABLE'
        && error.status === 409,
    )
  })

  test('new records state the layout, while old records take the legacy route', () => {
    assert.deepEqual(spawnIdentity({ adapter: 'codex', config_layout: 1 }), {
      adapter: 'codex', configLayoutVersion: 1, legacy: false,
    })
    assert.deepEqual(spawnIdentity({ harness: 'claude' }), {
      adapter: 'claude', configLayoutVersion: 0, legacy: true,
    })
  })

  test('the journal reduction keeps adapter identity and the legacy-layout decision', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-harness-reduction-'))
    const reduction = new Reduction(dir)
    reduction.journal('agent_spawned', {
      agent: 'curia-1', ticket: '1', harness: 'codex', adapter: 'codex', config_layout: 1,
    })
    reduction.journal('agent_spawned', { agent: 'curia-2', ticket: '2', harness: 'claude' })
    const conversations = reduction.retainedAgentConversations()
    assert.deepEqual(
      conversations.map(({ adapter, configLayoutVersion, legacyConfigLayout }) => ({
        adapter, configLayoutVersion, legacyConfigLayout,
      })),
      [
        { adapter: 'codex', configLayoutVersion: 1, legacyConfigLayout: false },
        { adapter: 'claude', configLayoutVersion: 0, legacyConfigLayout: true },
      ],
    )
    reduction.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// The public Harness adapter seam (ADR-0029 and ADR-0030).
//
// Claude and Codex own their native behavior behind this seam. Shared services
// select an adapter and provide the ports that retain Curia's invariants.

import { buildResumeCmd, buildSpawnCmd, parseCreditGate, parseUsageLimit } from './routing.mjs'
import { CONSUMER_NAMES, PROVIDER_CREDENTIALS } from './credentials.mjs'
import { createClaudeHarnessAdapter } from './claudeharness.mjs'
import { createCodexHarnessAdapter } from './codexharness.mjs'

export const HARNESS_FACETS = Object.freeze([
  'identity',
  'setup',
  'lifecycle',
  'evidence',
  'control',
])

export const HARNESS_CAPABILITIES = Object.freeze([
  'modelSwitch',
  'reasoningEffort',
  'transcriptUsage',
  'nativeSkills',
  'richMetadata',
])

export const NORMALIZED_EVENT_TYPES = Object.freeze([
  'user_message',
  'assistant_message',
  'tool_started',
  'tool_completed',
  'ready',
  'active',
  'stalled',
  'process_died',
  'usage_observed',
  'unknown_native_evidence',
])

export const LEGACY_CONFIG_LAYOUT = 0
export const CURRENT_CONFIG_LAYOUT = 1

export class HarnessContractError extends Error {
  constructor(message, { code = 'HARNESS_CONTRACT_INVALID', status = 500 } = {}) {
    super(message)
    this.name = 'HarnessContractError'
    this.code = code
    this.status = status
  }
}

export class HarnessCapabilityError extends Error {
  constructor(harness, capability) {
    super(`the ${harness} Harness doesn't support ${capability}`)
    this.name = 'HarnessCapabilityError'
    this.code = 'HARNESS_CAPABILITY_UNAVAILABLE'
    this.status = 409
    this.harness = harness
    this.capability = capability
  }
}

function contractFault(message) {
  throw new HarnessContractError(message)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freeze(value, seen = new Set()) {
  if (!plainObject(value) || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) freeze(child, seen)
  return Object.freeze(value)
}

function requireFunction(facet, value, method) {
  if (typeof value?.[method] !== 'function') contractFault(`Harness facet ${facet} needs a ${method}() operation`)
}

export function validateHarnessAdapter(adapter, {
  providers = null,
  credentialConsumers = null,
} = {}) {
  if (!plainObject(adapter)) contractFault('a Harness adapter must be an object')
  for (const facet of HARNESS_FACETS) {
    if (!plainObject(adapter[facet])) contractFault(`a Harness adapter needs the ${facet} facet`)
  }

  const { identity, setup, lifecycle, evidence, control } = adapter
  for (const field of ['name', 'provider', 'credentialConsumer']) {
    if (typeof identity[field] !== 'string' || !identity[field]) {
      contractFault(`Harness identity needs a non-empty ${field}`)
    }
  }
  if (!Number.isInteger(identity.configLayoutVersion) || identity.configLayoutVersion < 1) {
    contractFault(`Harness ${identity.name} needs a positive integer configLayoutVersion`)
  }
  if (providers && !providers.includes(identity.provider)) {
    contractFault(`Harness ${identity.name} names unknown provider "${identity.provider}"`)
  }
  if (credentialConsumers && !credentialConsumers.includes(identity.credentialConsumer)) {
    contractFault(`Harness ${identity.name} names unknown credential consumer "${identity.credentialConsumer}"`)
  }

  for (const method of ['refuseRepository', 'prepare']) requireFunction('setup', setup, method)
  for (const method of ['freshCommand', 'resumeCommand', 'isReady', 'classifyLimit', 'processDied', 'interrupt', 'send']) {
    requireFunction('lifecycle', lifecycle, method)
  }
  for (const method of ['discover', 'events', 'activity', 'usage']) requireFunction('evidence', evidence, method)
  requireFunction('control', control, 'enforceCompletion')

  if (!plainObject(control.capabilities)) contractFault(`Harness ${identity.name} control needs capabilities`)
  if (!plainObject(control.operations)) contractFault(`Harness ${identity.name} control needs operations`)
  for (const capability of HARNESS_CAPABILITIES) {
    if (typeof control.capabilities[capability] !== 'boolean') {
      contractFault(`Harness ${identity.name} must declare capability ${capability} as true or false`)
    }
  }
  for (const [capability, supported] of Object.entries(control.capabilities)) {
    if (!HARNESS_CAPABILITIES.includes(capability)) {
      contractFault(`Harness ${identity.name} declares unknown capability "${capability}"`)
    }
    if (typeof supported !== 'boolean') {
      contractFault(`Harness ${identity.name} capability ${capability} must be true or false`)
    }
    if (supported && typeof control.operations[capability] !== 'function') {
      contractFault(`Harness ${identity.name} declares ${capability} without an operation`)
    }
  }
  for (const capability of Object.keys(control.operations)) {
    if (!HARNESS_CAPABILITIES.includes(capability)) {
      contractFault(`Harness ${identity.name} implements unknown capability "${capability}"`)
    }
    if (control.capabilities[capability] !== true) {
      contractFault(`Harness ${identity.name} implements ${capability} without declaring support`)
    }
  }
  return adapter
}

export function defineHarnessAdapter(adapter, options = {}) {
  validateHarnessAdapter(adapter, options)
  return freeze(adapter)
}

export function createHarnessRegistry(adapters, options = {}) {
  if (!Array.isArray(adapters) || !adapters.length) contractFault('a Harness registry needs at least one adapter')
  const byName = new Map()
  for (const candidate of adapters) {
    const adapter = defineHarnessAdapter(candidate, options)
    const name = adapter.identity.name
    if (byName.has(name)) contractFault(`duplicate Harness adapter name "${name}"`)
    byName.set(name, adapter)
  }
  const names = Object.freeze([...byName.keys()])
  return Object.freeze({
    names,
    has: (name) => byName.has(name),
    get(name) {
      const adapter = byName.get(name)
      if (!adapter) {
        throw new HarnessContractError(
          `unknown Harness "${name}" - registered Harnesses: ${names.join(', ')}`,
          { code: 'HARNESS_UNKNOWN', status: 400 },
        )
      }
      return adapter
    },
    values: () => [...byName.values()],
  })
}

function createPort(name, operations, required) {
  if (!plainObject(operations)) contractFault(`${name} port operations must be an object`)
  for (const operation of required) {
    if (typeof operations[operation] !== 'function') contractFault(`${name} port needs ${operation}()`)
  }
  return freeze({ ...operations })
}

export const createFilesystemPort = (operations) => createPort('filesystem', operations, [
  'refuseRepository', 'prepare',
])
export const createProcessPort = (operations) => createPort('process', operations, [
  'died', 'interrupt',
])
export const createPanePort = (operations) => createPort('pane', operations, [
  'capture', 'send',
])
export const createTranscriptPort = (operations) => createPort('transcript', operations, [
  'discover', 'events', 'activity', 'usage',
])
export const createToolChannelPort = (operations) => createPort('tool-channel', operations, [
  'enforceCompletion',
])

export function createHarnessPorts({ filesystem, process, pane, transcript, toolChannel }) {
  return freeze({
    filesystem: createFilesystemPort(filesystem),
    process: createProcessPort(process),
    pane: createPanePort(pane),
    transcript: createTranscriptPort(transcript),
    toolChannel: createToolChannelPort(toolChannel),
  })
}

export function normalizedEvent(type, fields = {}) {
  if (!NORMALIZED_EVENT_TYPES.includes(type)) {
    throw new HarnessContractError(`unknown normalized Harness event "${type}"`, {
      code: 'HARNESS_EVENT_UNKNOWN',
    })
  }
  if (!plainObject(fields)) contractFault('normalized Harness event fields must be an object')
  return freeze({ ...fields, type })
}

export function unknownNativeEvidence(nativeType, fields = {}) {
  return normalizedEvent('unknown_native_evidence', { ...fields, nativeType: String(nativeType ?? '') })
}

export function requireHarnessCapability(adapter, capability, ...args) {
  const name = adapter?.identity?.name ?? 'unknown'
  if (!HARNESS_CAPABILITIES.includes(capability)) {
    throw new HarnessContractError(`unknown Harness capability "${capability}"`, {
      code: 'HARNESS_CAPABILITY_UNKNOWN', status: 400,
    })
  }
  if (adapter?.control?.capabilities?.[capability] !== true) {
    throw new HarnessCapabilityError(name, capability)
  }
  const operation = adapter.control.operations[capability]
  return args.length ? operation(...args) : operation
}

export function spawnIdentity(event = {}) {
  const source = event ?? {}
  const name = source.adapter ?? source.harness ?? null
  return Object.freeze({
    adapter: name,
    configLayoutVersion: Number.isInteger(source.config_layout)
      ? source.config_layout
      : LEGACY_CONFIG_LAYOUT,
    legacy: !Number.isInteger(source.config_layout),
  })
}

export const HARNESS_REGISTRY = createHarnessRegistry([
  createClaudeHarnessAdapter({
    buildFreshCommand: ({ routing, model, promptFile }) => buildSpawnCmd(routing, 'claude', model, promptFile),
    buildResumeCommand: ({ routing, model }) => buildResumeCmd(routing, 'claude', model),
    classifyLimit: (paneText) => parseUsageLimit(paneText, 'anthropic')
      ?? parseCreditGate(paneText, 'anthropic'),
  }),
  createCodexHarnessAdapter(),
], {
  providers: Object.keys(PROVIDER_CREDENTIALS),
  credentialConsumers: CONSUMER_NAMES,
})

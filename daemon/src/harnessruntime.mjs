import { requireHarnessCapability } from './harnesses.mjs'

// Shared orchestration crosses this interface. Native commands, evidence, and
// controls remain inside the selected adapter. Durable state and worktrees stay
// with the caller.
export class HarnessRuntime {
  constructor(registry) {
    this.registry = registry
  }

  adapter(name) {
    return this.registry.get(name)
  }

  identity(name) {
    return this.adapter(name).identity
  }

  prepare(name, context, ports) {
    return this.adapter(name).setup.prepare(context, ports)
  }

  refuseRepository(name, context, ports) {
    return this.adapter(name).setup.refuseRepository(context, ports)
  }

  command(name, context, { resume = false } = {}) {
    const lifecycle = this.adapter(name).lifecycle
    return resume ? lifecycle.resumeCommand(context) : lifecycle.freshCommand(context)
  }

  isReady(name, context) {
    return this.adapter(name).lifecycle.isReady(context)
  }

  classifyLimit(name, context) {
    return this.adapter(name).lifecycle.classifyLimit(context)
  }

  needsStrandedCallRecovery(name, context = {}) {
    return this.adapter(name).lifecycle.strandedCallRecovery(context)
  }

  rewind(name, context, ports) {
    return this.adapter(name).lifecycle.rewind(context, ports)
  }

  activity(name, context, ports) {
    return this.adapter(name).evidence.activity(context, ports)
  }

  events(name, context, ports) {
    return this.adapter(name).evidence.events(context, ports)
  }

  control(name, capability, ...args) {
    return requireHarnessCapability(this.adapter(name), capability, ...args)
  }

  enforceCompletion(name, context, ports) {
    return this.adapter(name).control.enforceCompletion(context, ports)
  }

  fallback({ from, to, resume = false }) {
    const crossHarness = from !== to
    if (crossHarness && resume) {
      throw new Error(`refusing to resume native ${from} conversation state on the ${to} Harness`)
    }
    return Object.freeze({
      crossHarness,
      preserveWorktree: true,
      reuseNativeConversation: !crossHarness && resume,
    })
  }
}

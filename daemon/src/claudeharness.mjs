import { setTimeout as sleep } from 'node:timers/promises'

const call = (ports, port, operation, ...args) => {
  const fn = ports?.[port]?.[operation]
  if (typeof fn !== 'function') throw new Error(`Claude Harness needs ${port}.${operation}()`)
  return fn(...args)
}

export const CLAUDE_READY_RE = /(?:⏵⏵|bypass permissions)/i

export const CLAUDE_CAPABILITIES = Object.freeze({
  modelSwitch: true,
  reasoningEffort: true,
  transcriptUsage: true,
  nativeSkills: true,
  richMetadata: true,
})

const ready = (paneText) => {
  CLAUDE_READY_RE.lastIndex = 0
  return CLAUDE_READY_RE.test(String(paneText ?? ''))
}

async function switchModel({ session, model, readbackMs = 15_000 }, ports) {
  await call(ports, 'pane', 'key', session, 'C-u')
  try {
    const sent = await call(ports, 'pane', 'send', session, `/model ${model}`, { readbackMs: 0 })
    if (sent?.status === 'not-sent') return { status: 'active' }

    const deadline = Date.now() + readbackMs
    let confirmed = false
    let pane = ''
    while (true) {
      try {
        pane = await call(ports, 'pane', 'capture', session)
      } catch {
        pane = ''
      }
      const tail = String(pane ?? '').split('\n').slice(-25).join('\n')
      if (/Set model to /.test(tail)) return { status: 'switched' }
      const error = tail.match(/(API error:[^\n]*(?:\n[^\n]*){0,3}|Unable to validate model[^\n]*)/)
      if (error && !/Switch model\?/.test(tail)) {
        return { status: 'refused', why: error[1].replace(/\s+/g, ' ').trim().slice(0, 200) }
      }
      if (!confirmed && /Switch model\?/.test(tail)) {
        confirmed = true
        await call(ports, 'pane', 'key', session, 'Enter')
      }
      if (Date.now() >= deadline) return { status: 'unconfirmed', pane: tail }
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())))
    }
  } finally {
    await Promise.resolve(call(ports, 'pane', 'key', session, 'C-y')).catch(() => {})
  }
}

export function createClaudeHarnessAdapter({ buildFreshCommand, buildResumeCommand, classifyLimit }) {
  return {
    identity: {
      name: 'claude',
      provider: 'anthropic',
      credentialConsumer: 'claude',
      configLayoutVersion: 1,
    },
    setup: {
      refuseRepository: (context, ports) => call(ports, 'filesystem', 'refuseRepository', context),
      prepare: (context, ports) => call(ports, 'filesystem', 'prepare', context),
    },
    lifecycle: {
      freshCommand: (context) => buildFreshCommand(context),
      resumeCommand: (context) => buildResumeCommand(context),
      isReady: ({ paneText }) => ready(paneText),
      classifyLimit: ({ paneText }) => classifyLimit(paneText),
      processDied: (context, ports) => call(ports, 'process', 'died', context),
      interrupt: (context, ports) => call(ports, 'process', 'interrupt', context),
      send: (context, ports) => call(ports, 'pane', 'send', context),
    },
    evidence: {
      discover: (context, ports) => call(ports, 'transcript', 'discover', context),
      events: (context, ports) => call(ports, 'transcript', 'events', context),
      activity: (context, ports) => call(ports, 'transcript', 'activity', context),
      usage: (context, ports) => call(ports, 'transcript', 'usage', context),
    },
    control: {
      capabilities: CLAUDE_CAPABILITIES,
      operations: {
        modelSwitch: switchModel,
        reasoningEffort: (context, ports) => call(ports, 'pane', 'reasoningEffort', context),
        transcriptUsage: (context, ports) => call(ports, 'transcript', 'usage', context),
        nativeSkills: (context, ports) => call(ports, 'filesystem', 'nativeSkills', context),
        richMetadata: (context, ports) => call(ports, 'transcript', 'richMetadata', context),
      },
      enforceCompletion: (context, ports) => call(ports, 'toolChannel', 'enforceCompletion', context),
    },
  }
}

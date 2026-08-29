const call = (ports, port, operation, ...args) => {
  const fn = ports?.[port]?.[operation]
  if (typeof fn !== 'function') throw new Error(`Codex Harness needs ${port}.${operation}()`)
  return fn(...args)
}

export const CODEX_READY_RE = /·\s[~/]/
export const CODEX_LIMIT_RE = new RegExp(
  "you['’]?ve (?:hit|reached) your (?:usage limit|workspace credit limit)"
  + "|(?:you['’]?re|your workspace is) out of credits"
  + '|(?:^|[^a-z])usage limit reached',
  'i',
)
export const CODEX_CREDIT_GATE_RE = /approaching rate limits[\s\S]{0,500}switch to [^\n?]+ for lower credit usage\?/i

const SAFE_SUBSTITUTION = /^[A-Za-z0-9._/-]+$/

export const CODEX_CAPABILITIES = Object.freeze({
  modelSwitch: true,
  reasoningEffort: true,
  transcriptUsage: true,
  nativeSkills: true,
  richMetadata: true,
})

function command({ routing, model, promptFile = null, resume = false }) {
  const config = routing.harnesses?.codex
  if (!config) {
    throw new Error(`unknown harness "codex" - configured harnesses: ${Object.keys(routing.harnesses ?? {}).join(', ')}`)
  }
  const template = resume ? config.resumeTemplate ?? config.resume_template : config.template
  if (typeof template !== 'string' || !template.includes('{model}')) {
    throw new Error(`harness "codex" has no ${resume ? 'resume ' : ''}template with a {model} placeholder`)
  }
  const values = { model: routing.models?.[model]?.id ?? model, prompt_file: promptFile }
  for (const [name, value] of Object.entries(values)) {
    if (value === null) continue
    if (!SAFE_SUBSTITUTION.test(value)) {
      throw new Error(`refusing to substitute {${name}}: "${value}" is not quote-free/shell-safe`)
    }
  }
  return Object.entries(values).reduce(
    (result, [name, value]) => value === null ? result : result.replaceAll(`{${name}}`, value),
    template,
  )
}

const ready = (paneText) => {
  CODEX_READY_RE.lastIndex = 0
  return CODEX_READY_RE.test(String(paneText ?? ''))
}

export function classifyCodexLimit(paneText) {
  if (!paneText) return null
  if (CODEX_LIMIT_RE.test(paneText)) return { scope: 'provider', resetAt: null }
  if (CODEX_CREDIT_GATE_RE.test(paneText)) {
    return { scope: 'provider', resetAt: null, reason: 'rate-limit credit dialog' }
  }
  return null
}

async function switchModel({ session, model }, ports) {
  await call(ports, 'pane', 'key', session, 'C-u')
  await call(ports, 'pane', 'kill', session)
  await call(ports, 'pane', 'resume', { session, model })
  return { status: 'switched', resumed: true, recorded: true }
}

export function createCodexHarnessAdapter() {
  return {
    identity: {
      name: 'codex',
      provider: 'openai',
      credentialConsumer: 'codex',
      configLayoutVersion: 1,
    },
    setup: {
      refuseRepository: (context, ports) => call(ports, 'filesystem', 'refuseRepository', context),
      prepare: (context, ports) => call(ports, 'filesystem', 'prepare', context),
    },
    lifecycle: {
      freshCommand: (context) => command({ ...context, resume: false }),
      resumeCommand: (context) => command({ ...context, resume: true }),
      isReady: ({ paneText }) => ready(paneText),
      classifyLimit: ({ paneText }) => classifyCodexLimit(paneText),
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
      capabilities: CODEX_CAPABILITIES,
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

// Model routing (#13, all-Claude per stated deviation 3): label resolution,
// two-level cooling cache, transitive fallback candidates, spawn-command
// build, usage-limit parse.

// Precedence (field-notes contract 2): explicit override > model:<x> label >
// wayfinder:<type> default > untyped default. `labels` is an array of strings
// (callers normalise gh's label objects to `.name` first).
export function resolveModel(routing, labels, override) {
  if (override) return override
  const modelLabel = labels.find((l) => l.startsWith('model:'))
  if (modelLabel) return modelLabel.slice('model:'.length)
  for (const l of labels) {
    if (!l.startsWith('wayfinder:')) continue
    const byType = routing.defaults[l.slice('wayfinder:'.length)]
    if (byType) return byType
  }
  return routing.defaults.untyped
}

// In-memory only, never persisted (settled answer 6). Two distinct levels:
// a model-level entry (Fable's own weekly sub-cap) cools only that model and
// the chain falls back within the provider; a provider-level entry cools every
// lane under it at once — #13's all-cooling path under all-Claude routing.
// Entries expire (field-notes contract 5): a resetAt in the past no longer cools.
export class Cooling {
  constructor() {
    this.models = new Map() // model -> resetAt (Date)
    this.providers = new Map() // provider -> resetAt (Date)
  }

  coolModel(model, resetAt) {
    this.models.set(model, resetAt)
  }

  coolProvider(provider, resetAt) {
    this.providers.set(provider, resetAt)
  }

  #active(map, key) {
    const at = map.get(key)
    if (!at) return false
    if (at.getTime() <= Date.now()) {
      map.delete(key) // expired — stop suppressing
      return false
    }
    return true
  }

  isCool(model, provider) {
    return this.#active(this.models, model) || this.#active(this.providers, provider)
  }

  earliestReset() {
    const now = Date.now()
    let best = null
    for (const at of [...this.models.values(), ...this.providers.values()]) {
      if (at.getTime() > now && (!best || at.getTime() < best.getTime())) best = at
    }
    return best
  }
}

// TRANSITIVE fallback chain (field-notes contract 1): the starting model plus
// everything reachable through routing.fallbacks, skipping models cooling at
// either level. Empty array = true exhaustion (every candidate cooling).
export function candidates(routing, model, cooling) {
  const chain = []
  const seen = new Set()
  const visit = (m) => {
    if (!m || seen.has(m)) return
    seen.add(m)
    chain.push(m)
    for (const next of routing.fallbacks?.[m] ?? []) visit(next)
  }
  visit(model)
  return chain.filter((m) => !cooling.isCool(m, routing.models[m]?.provider))
}

// The spawn command ends up nested inside `bash -c '<cmd>; exec bash'`
// (tmux.newSession), so substituted values must be quote-free by construction —
// asserted here rather than trusted (challenge.md concern). Strict whitelist:
// generated workspace_root paths and model names never need anything else.
const SAFE_SUBSTITUTION = /^[A-Za-z0-9._/-]+$/

export function buildSpawnCmd(routing, backend, model, promptFile) {
  const b = routing.backends?.[backend]
  if (!b) {
    throw new Error(`unknown backend "${backend}" — configured backends: ${Object.keys(routing.backends ?? {}).join(', ')}`)
  }
  for (const [name, value] of [['model', model], ['prompt_file', promptFile]]) {
    if (!SAFE_SUBSTITUTION.test(value)) {
      throw new Error(`refusing to substitute {${name}}: "${value}" is not quote-free/shell-safe`)
    }
  }
  return b.template.replaceAll('{model}', model).replaceAll('{prompt_file}', promptFile)
}

// Classify pane text as a usage-limit hit. Keys on limit-*reached* phrasing,
// never an informational mention (field-notes contract 4 — the promotional
// "You can use up to 50% of your weekly usage limit on Fable 5" text appears
// in perfectly healthy sessions and must never match). Scope: reached-text
// naming a specific model ⇒ 'model' (Fable's sub-cap); generic ⇒ 'provider'.
// Reset: `|<epoch-seconds>` suffix when present; otherwise null and the caller
// applies the journalled conservative 1 h cooldown (stated deviation 2).
const MODEL_NAMES = ['fable', 'opus', 'sonnet', 'haiku']

export function parseUsageLimit(paneText) {
  if (!paneText) return null
  const m = paneText.match(/([A-Za-z][A-Za-z0-9 .-]*?)\s*usage limit reached/i)
  if (!m) return null
  const subject = m[1].toLowerCase()
  const scope = MODEL_NAMES.some((name) => subject.includes(name)) ? 'model' : 'provider'
  const reset = paneText.match(/\|\s*(\d{9,12})/)
  const resetAt = reset ? new Date(Number(reset[1]) * 1000) : null
  return { scope, resetAt }
}

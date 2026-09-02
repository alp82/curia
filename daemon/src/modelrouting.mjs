// The routing preset of integration setup (#878, shared with #879, under the
// #852 model-provider contract).
//
// A connected provider "supplies a working routing preset without
// model-by-model first-run configuration". This module is what that sentence
// means in code, and both provider cards call it, so the rule is written
// once:
//
//   READY   every `defaults` row names a model that is active and whose
//           provider has a credential on disk, and every model of the
//           provider that is connecting is active.
//   PRESET  the rows that are not ready move onto the connecting provider's
//           model with their own effort kept; the rows that are ready stay as
//           they are; the models of a provider without a credential switch
//           off, and the connecting provider's switch on.
//
// THE PRESET LANDS AS THE OVERRIDE FILE, the same `routing.local.yaml` the
// settings screen writes, through the same writer, so the tracked
// `routing.yaml` is never edited and the override holds only what differs.
// Under an installation root the override lives in `state/`, the service's
// own mutable boundary (#867); the tracked file under `config/` is never
// the target.
//
// A READY ROUTING IS LEFT ALONE. The verifier asks on every read, and an
// operator who routed a type to the other credentialed provider from the
// settings screen has made a working choice; a read that rewrote it would be
// the frame deciding routing for a person who already had. Only a routing
// that cannot work, a row on a provider with no credential or on a model
// switched off, is moved.

import { localConfigFile, loadRoutingConfig } from './config.mjs'
import { isActive } from './routing.mjs'
import { saveSettings } from './settings.mjs'

const providerOfModel = (routing, model) => routing?.models?.[model]?.provider ?? null

// The model a provider's preset routes to: the first model routing names for
// that provider, in the tracked file's order. `gpt` for openai, `fable` for
// anthropic, in the shipped file.
export function presetModel(routing, provider) {
  for (const [name, spec] of Object.entries(routing?.models ?? {})) {
    if (spec?.provider === provider) return name
  }
  return null
}

const rowOf = (route) => (typeof route === 'string' ? { model: route, effort: null } : { model: route?.model ?? null, effort: route?.effort ?? null })

// Whether the live routing works for the providers that hold a credential.
// `rows` is one line per default row, so a panel can draw what is routed
// where; `missing` names the rows and the models that are not ready.
export function routingReadiness(routing, credentialed, { provider = null } = {}) {
  const has = new Set(credentialed)
  const rows = []
  const missing = []
  for (const [type, route] of Object.entries(routing?.defaults ?? {})) {
    const { model } = rowOf(route)
    const modelProvider = providerOfModel(routing, model)
    const row = {
      type, model, provider: modelProvider,
      active: isActive(routing, model), credentialed: modelProvider !== null && has.has(modelProvider),
    }
    row.ok = row.active && row.credentialed
    rows.push(row)
    if (!row.ok) missing.push(type)
  }
  if (provider) {
    for (const [name, spec] of Object.entries(routing?.models ?? {})) {
      if (spec?.provider === provider && !isActive(routing, name)) missing.push(`models.${name}`)
    }
  }
  return { ready: missing.length === 0, rows, missing }
}

// The patch the settings writer takes: every default row (ready ones as they
// are, the others moved), and every model's switch by credential.
export function routingPreset(routing, { provider, credentialed }) {
  const has = new Set(credentialed)
  const target = presetModel(routing, provider)
  if (!target) throw new Error(`routing.yaml names no model for provider "${provider}", so there is no preset to apply`)
  const defaults = {}
  for (const [type, route] of Object.entries(routing?.defaults ?? {})) {
    const { model, effort } = rowOf(route)
    const modelProvider = providerOfModel(routing, model)
    const ok = isActive(routing, model) && modelProvider !== null && has.has(modelProvider)
    const chosen = ok ? model : target
    defaults[type] = effort ? { model: chosen, effort } : { model: chosen }
  }
  const models = {}
  for (const [name, spec] of Object.entries(routing?.models ?? {})) {
    models[name] = { active: has.has(spec?.provider) }
  }
  return { defaults, models }
}

// The one call a provider card makes after its credential verified: read
// readiness off the live routing, write the preset when it is not ready,
// reload the layered file, and hand the loaded routing to `apply`, which
// puts it into the objects the daemon runs on (the reload route's own
// apply). Answers what the card reports. Throws when the override cannot be
// written or refuses to load, which the card turns into its one failure.
export function ensureRoutingPreset({ routingFile, localFile = localConfigFile(routingFile), provider, credentialed, live, apply, log = () => {} }) {
  const before = routingReadiness(live, credentialed, { provider })
  const model = presetModel(live, provider)
  if (before.ready) return { ready: true, applied: false, model, file: localFile, rows: before.rows, missing: [] }
  const patch = routingPreset(live, { provider, credentialed })
  const written = saveSettings({ routingFile, routingLocalFile: localFile, patch: { routing: patch } })
  const next = loadRoutingConfig(routingFile, { localFile })
  apply(next)
  const after = routingReadiness(next, credentialed, { provider })
  log(`model setup: applied the ${provider} routing preset (${model}) to ${localFile}${written.written?.length ? '' : ' (no change)'} — rows moved: ${before.missing.join(', ')}`)
  return { ready: after.ready, applied: true, model, file: localFile, rows: after.rows, missing: after.missing }
}

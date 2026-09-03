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
//   REVIEW  a `review` row names the model that reads a builder's diff on the
//           OTHER provider (ADR-0010), so a row whose model is switched off
//           has nowhere to move with one provider: it is dropped (`null` in
//           the override, which the loader reads as no pairing). With both
//           providers every row is the tracked file's. The rehearsal (#891)
//           found the preset leaving `review.openai: opus` behind after it
//           switched opus off, and the override then refused to load. A row
//           keyed by a ticket type (`review.test-run`) holds that type's own
//           pairing by builder provider and moves by the same rule.
//   CHEAP   a row that sits on a provider's cheapest model (`cheapest` in
//           routing.yaml) moves to the cheapest model of the connecting
//           provider, not to its first one. The owner's decision on the
//           rehearsal (#891): the Test run's tickets run on the cheapest
//           model at its lowest effort, whichever provider signs in, and
//           their cross-check reads on the cheap tier too.
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

import fs from 'node:fs'
import { parse } from 'yaml'

import { localConfigFile, loadRoutingConfig } from './config.mjs'
import { isActive, spawnModelId } from './routing.mjs'
import { saveSettings } from './settings.mjs'

const providerOfModel = (routing, model) => routing?.models?.[model]?.provider ?? null

// The cheapest model of a provider, as `cheapest` in routing.yaml names it
// (#891), or null for a file that names none.
export function cheapestModel(routing, provider) {
  const model = routing?.cheapest?.[provider]
  return typeof model === 'string' && routing?.models?.[model] ? model : null
}

const onCheapTier = (routing, model) => model !== null && cheapestModel(routing, providerOfModel(routing, model)) === model

// Where a row that cannot run moves to: the connecting provider's cheapest
// model when the row sits on its own provider's cheapest one, else the
// provider's first model. A file that names no cheapest model moves every
// row onto the first one, the way it did before the key existed.
const targetFor = (routing, model, provider) => (onCheapTier(routing, model) && cheapestModel(routing, provider)) || presetModel(routing, provider)

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
    const { model, effort } = rowOf(route)
    const modelProvider = providerOfModel(routing, model)
    const row = {
      type, model, id: spawnModelId(routing, model), effort, provider: modelProvider,
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
  for (const [key, model] of reviewRows(routing?.review)) {
    if (model !== null && !runnable(routing, model, has)) missing.push(`review.${key}`)
  }
  return { ready: missing.length === 0, rows, missing }
}

// Every review row as `[key, model]`, the provider rows as `openai` and a
// type's rows as `test-run.openai`, so the two shapes are read in one place.
function reviewRows(review) {
  const out = []
  for (const [key, value] of Object.entries(review ?? {})) {
    if (value && typeof value === 'object') {
      for (const [builder, model] of Object.entries(value)) out.push([`${key}.${builder}`, model, key, builder])
    } else out.push([key, value, null, key])
  }
  return out
}

const runnable = (routing, model, has) => {
  const modelProvider = providerOfModel(routing, model)
  return isActive(routing, model) && modelProvider !== null && has.has(modelProvider)
}

// The review rows after the preset, from the tracked file's rows (`base`),
// so a row one provider's preset dropped comes back when the second
// provider connects. A row is kept when its model can run; else it moves to
// the connecting provider's model when that model runs on another provider
// than the builder's, and is dropped otherwise.
function reviewPreset(routing, base, { provider, credentialed }) {
  const has = new Set(credentialed)
  const active = (name) => has.has(providerOfModel(routing, name))
  const review = {}
  for (const [, model, type, builder] of reviewRows(base?.review)) {
    if (typeof model !== 'string') continue
    const target = targetFor(routing, model, provider)
    let next
    if (active(model)) next = model
    else if (target && providerOfModel(routing, target) !== builder && active(target)) next = target
    else next = null
    if (type === null) review[builder] = next
    else (review[type] ??= {})[builder] = next
  }
  return review
}

// The patch the settings writer takes: every default row (ready ones as they
// are, the others moved), every model's switch by credential, and every
// review row of the tracked file (`base`, the live routing when not given)
// kept, moved, or dropped.
export function routingPreset(routing, { provider, credentialed, base = routing }) {
  const has = new Set(credentialed)
  const target = presetModel(routing, provider)
  if (!target) throw new Error(`routing.yaml names no model for provider "${provider}", so there is no preset to apply`)
  const defaults = {}
  for (const [type, route] of Object.entries(routing?.defaults ?? {})) {
    const { model, effort } = rowOf(route)
    const modelProvider = providerOfModel(routing, model)
    const ok = isActive(routing, model) && modelProvider !== null && has.has(modelProvider)
    const chosen = ok ? model : targetFor(routing, model, provider)
    defaults[type] = effort ? { model: chosen, effort } : { model: chosen }
  }
  const models = {}
  for (const [name, spec] of Object.entries(routing?.models ?? {})) {
    models[name] = { active: has.has(spec?.provider) }
  }
  const review = reviewPreset(routing, base, { provider, credentialed })
  return Object.keys(review).length ? { defaults, models, review } : { defaults, models }
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
  const base = parse(fs.readFileSync(routingFile, 'utf8')) ?? {}
  const patch = routingPreset(live, { provider, credentialed, base })
  const written = saveSettings({ routingFile, routingLocalFile: localFile, patch: { routing: patch } })
  const next = loadRoutingConfig(routingFile, { localFile })
  apply(next)
  const after = routingReadiness(next, credentialed, { provider })
  log(`model setup: applied the ${provider} routing preset (${model}) to ${localFile}${written.written?.length ? '' : ' (no change)'} — rows moved: ${before.missing.join(', ')}`)
  return { ready: after.ready, applied: true, model, file: localFile, rows: after.rows, missing: after.missing }
}

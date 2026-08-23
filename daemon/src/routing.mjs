// Model routing (#13): label resolution, two-level cooling cache, transitive
// fallback candidates, spawn-command build, usage-limit parse.
//
// Two providers since #39, which is what #13 asked for and what #33 deferred.
// The shapes that were already here for one provider now carry real weight: a
// provider-level cooling entry no longer means total exhaustion (the chain
// crosses to the other provider), and the usage-limit classifier has to read
// two vocabularies instead of one.

// Precedence (field-notes contract 2): explicit override > model:<x> label >
// wayfinder:<type> default > untyped default. `labels` is an array of strings
// (callers normalise gh's label objects to `.name` first).
export function resolveModel(routing, labels, override) {
  const named = namedModel(labels, override)
  if (named) return named
  for (const l of labels) {
    if (!l.startsWith('wayfinder:')) continue
    const byType = routing.defaults[l.slice('wayfinder:'.length)]
    if (byType) return byType
  }
  return routing.defaults.untyped
}

// The model a HUMAN named, or null when routing picked it from the type table
// (#384). Two surfaces say it and they are one act: the `model:<x>` label on the
// ticket, and the label typed on the start line (`/start 384 opus`), which
// reaches `resolveModel` as the override. The default table names nothing.
//
// It is what the pre-emptive hold answers to. A predicted entry is curia's
// guess about a window that has not hit its wall yet, and a human who names a
// model has read the same bars and wants the last of that window spent on this
// ticket. A LANDED cap is not a guess, and no label steps over one.
export function namedModel(labels, override) {
  if (override) return override
  const l = (labels ?? []).find((x) => x.startsWith('model:'))
  return l ? l.slice('model:'.length) : null
}

// The live index, seeded at boot from the journal (#377). Settled answer 6 made
// this in-memory only, and a 5-hour window outlives a deploy: a restart inside
// one forgot every entry, and the next `start` spawned a container straight into
// the cap it had already measured. So the entries themselves still live here and
// nowhere else, and `Dispatcher#seedCooling` hands back the ones a previous
// process journalled. Nothing writes from here: `#handleLimit` journals the cap
// and calls this, in that order, and `#judgeReadings` does the same for the
// pre-emptive hold (#384).
//
// Two distinct levels:
// a model-level entry (Fable's own weekly sub-cap) cools only that model and
// the chain falls back within the provider; a provider-level entry cools every
// model under that provider at once. With two providers configured (#39) a
// provider-level entry is no longer the all-cooling path it was under all-Claude
// routing — it is the ordinary case the cross-provider chains exist for, and
// #exhausted fires only when BOTH providers are cooling.
// Entries expire (field-notes contract 5): a resetAt in the past no longer cools.
//
// TWO TRIGGERS WRITE A PROVIDER ENTRY (#384, decided on #339), and the store
// holds one shape for both. A LANDED entry is a cap curia measured: an agent hit
// the wall and the pane or the transcript stated the reset. A PREDICTED entry is
// a hot account reading — a window at or past COOL_PCT — held before the wall,
// so the fallback chain steps over the provider instead of spawning into it.
//
// The difference is not cosmetic, and three rules ride on it:
//
//   1. A prediction is re-judged from every fresh reading (Dispatcher#judgeReadings)
//      and cleared when the reading cools. A landed cap is never cleared: only
//      its own reset ends it.
//   2. A named model steps over a prediction and never over a landed cap — see
//      `namedModel`.
//   3. A landed cap OVERWRITES a prediction on the same provider, and a
//      prediction never overwrites a landed cap. Measured beats guessed, both
//      ways round.
export class Cooling {
  constructor() {
    // model -> { at: Date }, provider -> { at: Date, predicted?, window?, pct? }
    this.models = new Map()
    this.providers = new Map()
  }

  coolModel(model, resetAt) {
    this.models.set(model, { at: resetAt })
  }

  coolProvider(provider, resetAt) {
    this.providers.set(provider, { at: resetAt })
  }

  // The pre-emptive hold (#384). `window` and `pct` are the reading that wrote
  // it, kept here because the banner and Discord `/status` say WHY a provider is
  // held and a second copy of that number could disagree with this one.
  //
  // Answers whether the entry now stands, so the caller journals a hold it
  // actually took: a landed cap on the same provider refuses it.
  predictProvider(provider, { at, window = null, pct = null }) {
    if (this.#active(this.providers, provider) && !this.providers.get(provider).predicted) return false
    this.providers.set(provider, { at, predicted: true, window, pct })
    return true
  }

  // Lift the hold. Only a prediction lifts; a landed cap waits out its reset.
  // Answers whether anything was lifted, for the same reason.
  clearPrediction(provider) {
    if (!this.#active(this.providers, provider)) return false
    if (!this.providers.get(provider).predicted) return false
    this.providers.delete(provider)
    return true
  }

  // The hold standing on this provider, or null. A LANDED entry answers null:
  // the question every caller asks is "is a prediction up", and a landed cap is
  // not one.
  predictionFor(provider) {
    if (!this.#active(this.providers, provider)) return null
    const e = this.providers.get(provider)
    return e.predicted ? { at: e.at, window: e.window, pct: e.pct } : null
  }

  // The holds standing now, for the surfaces that name them: the dashboard
  // banner and Discord `/status`. Expired entries are dropped on the way out.
  predictions() {
    const out = []
    for (const provider of [...this.providers.keys()]) {
      if (!this.#active(this.providers, provider)) continue
      const e = this.providers.get(provider)
      if (e.predicted) out.push({ provider, at: e.at, window: e.window, pct: e.pct })
    }
    return out
  }

  #active(map, key) {
    const e = map.get(key)
    if (!e) return false
    if (e.at.getTime() <= Date.now()) {
      map.delete(key) // expired — stop suppressing
      return false
    }
    return true
  }

  // `ignorePredicted` is the named-model bypass (#384). It lifts a prediction
  // for this ONE question and never touches the store: the hold still stands for
  // every other model, and the entry is still there to be re-judged.
  isCool(model, provider, { ignorePredicted = false } = {}) {
    if (this.#active(this.models, model)) return true
    if (!this.#active(this.providers, provider)) return false
    return !(ignorePredicted && this.providers.get(provider).predicted)
  }

  earliestReset() {
    const now = Date.now()
    let best = null
    for (const { at } of [...this.models.values(), ...this.providers.values()]) {
      if (at.getTime() > now && (!best || at.getTime() < best.getTime())) best = at
    }
    return best
  }
}

// ---- the cross-check pairing (#164, ADR-0010) --------------------------------

// The label that beats the pairing table. `review-model:opus` on a ticket names
// the model that reads its diff, whatever `review:` in routing.yaml says.
export const REVIEW_MODEL_LABEL = 'review-model:'

export function reviewModelLabel(labels) {
  const l = (labels ?? []).find((x) => x.startsWith(REVIEW_MODEL_LABEL))
  return l ? l.slice(REVIEW_MODEL_LABEL.length) : null
}

// Which model reads a builder's diff, and whose provider it runs on.
//
// The whole point of a cross-check is the OTHER provider, so the answer is
// picked in that order and the caller is told which one it got:
//
//   1. the ticket's `review-model:<name>` label, else the `review:` row for the
//      builder's provider. That model, if it is warm, is the answer;
//   2. it is cooling ⇒ its own fallback chain, cross-provider first — a chain
//      that crosses back is still a chain, and a warm model on the other
//      provider is a better cross-check than a same-provider one;
//   3. every model on the other provider is cooling ⇒ the builder's own
//      provider, with `sameProvider` true. ADR-0010 asks for that fallback and
//      asks the verdict to say so at its top: a same-provider reading is the
//      weaker check, and the operator has to know which one they got.
//
// Throws rather than guessing: an unknown label, a provider with no row, and
// total exhaustion each name their own fix.
export function resolveReviewer(routing, { builderModel, labels = [], cooling }) {
  const builderSpec = routing.models?.[builderModel]
  if (!builderSpec) {
    throw new Error(`curia does not know what the builder ran on ("${builderModel}"), so it cannot tell which provider is the other one — configured models: ${Object.keys(routing.models ?? {}).join(', ')}`)
  }
  const builderProvider = builderSpec.provider
  const providerOf = (m) => routing.models?.[m]?.provider ?? null

  const labelled = reviewModelLabel(labels)
  if (labelled && !routing.models?.[labelled]) {
    throw new Error(`the ticket carries \`${REVIEW_MODEL_LABEL}${labelled}\`, and no model of that name is configured — configured models: ${Object.keys(routing.models ?? {}).join(', ')}`)
  }
  if (labelled && !isActive(routing, labelled)) {
    throw new Error(`the ticket carries \`${REVIEW_MODEL_LABEL}${labelled}\`, and that model is \`active: false\` in routing.yaml — turn it back on in the dashboard's Routing section, or name another model`)
  }
  const wanted = labelled ?? routing.review?.[builderProvider] ?? null
  if (!wanted) {
    throw new Error(`routing.yaml states no cross-check pairing for provider "${builderProvider}" — add a \`review:\` row for it, or put a \`${REVIEW_MODEL_LABEL}<name>\` label on the ticket`)
  }

  const pick = (model) => ({ model, wanted, sameProvider: providerOf(model) === builderProvider })
  if (!cooling.isCool(wanted, providerOf(wanted))) return pick(wanted)

  const chain = candidates(routing, wanted, cooling)
  const cross = chain.find((m) => providerOf(m) !== builderProvider)
  if (cross) return pick(cross)
  if (chain.length) return pick(chain[0])

  const own = candidates(routing, builderModel, cooling)
  if (own.length) return pick(own[0])
  throw new Error('every configured model is cooling on both providers — there is nothing left to read this diff with')
}

// The line the daemon stamps on a same-provider verdict (ADR-0010). Written by
// curia rather than by the reviewer: which provider a model ran on is curia's
// own record, and a reviewer's account of it is not evidence.
export const SAME_PROVIDER_STAMP = 'same provider — cross-provider was cooling'

// TRANSITIVE fallback chain (field-notes contract 1): the starting model plus
// everything reachable through routing.fallbacks, skipping models cooling at
// either level. Empty array = true exhaustion (every candidate cooling).
//
// An `active: false` model (#265) is stepped over here rather than removed from
// the chains that name it. Cooling and the switch drop out at the same seam on
// purpose: both say "not this one, now", and the difference is only who said it
// and for how long. Walking THROUGH an inactive model is deliberate — a chain
// `fable → opus → gpt` with opus switched off still reaches gpt, so turning one
// model off never silently shortens a chain to nothing.
//
// `named` is the model a human asked for (#384), and it lifts a PREDICTED hold
// on that one model. The bypass does not run down the chain: the human named
// this model, not whatever the chain falls through to, so a fallback is judged
// the way every other dispatch judges it.
export function candidates(routing, model, cooling, { named = null } = {}) {
  const chain = []
  const seen = new Set()
  const visit = (m) => {
    if (!m || seen.has(m)) return
    seen.add(m)
    chain.push(m)
    for (const next of routing.fallbacks?.[m] ?? []) visit(next)
  }
  visit(model)
  return chain.filter((m) => isActive(routing, m)
    && !cooling.isCool(m, routing.models[m]?.provider, { ignorePredicted: m === named }))
}

// The switch, read in one place. Absent means active: a routing.yaml written
// before the key existed routes the way it always did.
export function isActive(routing, model) {
  return routing?.models?.[model]?.active !== false
}

// The spawn command ends up nested inside `bash -c '<cmd>; exec bash'`
// (tmux.newSession), so substituted values must be quote-free by construction —
// asserted here rather than trusted (challenge.md concern). Strict whitelist:
// generated workspace_root paths and model names never need anything else.
export const SAFE_SUBSTITUTION = /^[A-Za-z0-9._/-]+$/

// The name a harness's CLI knows a routing model by. They are the same string
// for the Claude harness, where `fable`/`opus`/`sonnet` are aliases the CLI accepts
// — but #13's routing vocabulary is not any CLI's vocabulary, and the codex harness
// broke that assumption: `model:gpt` is the label a human writes and
// `codex --model gpt` is not a model. `models.<name>.id` is the CLI's name, and
// the routing name stays the label vocabulary.
//
// It is also the best name a HUMAN has for the model before the first turn
// lands (#179). A line that says what is running says this, not the label.
export function spawnModelId(routing, model) {
  return routing.models?.[model]?.id ?? model
}

// Which provider a harness belongs to, as `routing.yaml` states it (#187).
//
// A provider is normally read off the routing row of the model an agent was
// dispatched on. That row needs a label, and a label is a spawn-time fact: a
// lab session never had one, and a re-adopted agent holds one only because the
// journal remembered it. The harness is weaker evidence, and it survives on
// disk (detectHarness), so it answers when the label cannot.
//
// Config stays the authority — no table of harnesses and providers is written
// here. The answer comes from what every configured model on that harness says,
// and only when they all say the same thing. Two providers under one harness is
// a config a caller must not be given a guess about.
export function providerOf(routing, harness) {
  if (!harness) return null
  const found = new Set()
  for (const spec of Object.values(routing?.models ?? {})) {
    if (spec?.harness === harness && spec.provider) found.add(spec.provider)
  }
  return found.size === 1 ? [...found][0] : null
}

export function buildSpawnCmd(routing, harness, model, promptFile) {
  const b = routing.harnesses?.[harness]
  if (!b) {
    throw new Error(`unknown harness "${harness}" — configured harnesses: ${Object.keys(routing.harnesses ?? {}).join(', ')}`)
  }
  const modelId = spawnModelId(routing, model)
  for (const [name, value] of [['model', modelId], ['prompt_file', promptFile]]) {
    if (!SAFE_SUBSTITUTION.test(value)) {
      throw new Error(`refusing to substitute {${name}}: "${value}" is not quote-free/shell-safe`)
    }
  }
  return b.template.replaceAll('{model}', modelId).replaceAll('{prompt_file}', promptFile)
}

export function buildResumeCmd(routing, harness, model) {
  const b = routing.harnesses?.[harness]
  if (!b) {
    throw new Error(`unknown harness "${harness}". Configured harnesses: ${Object.keys(routing.harnesses ?? {}).join(', ')}`)
  }
  const template = b.resumeTemplate ?? b.resume_template
  if (typeof template !== 'string' || !template.includes('{model}')) {
    throw new Error(`harness "${harness}" has no resume template with a {model} placeholder`)
  }
  const modelId = spawnModelId(routing, model)
  if (!SAFE_SUBSTITUTION.test(modelId)) {
    throw new Error(`refusing to substitute {model}: "${modelId}" is not quote-free/shell-safe`)
  }
  return template.replaceAll('{model}', modelId)
}

// Classify pane text as a usage-limit hit. Keys on limit-*reached* phrasing,
// never an informational mention (field-notes contract 4 — the promotional
// "You can use up to 50% of your weekly usage limit on Fable 5" text appears
// in perfectly healthy sessions and must never match). Each provider gets its
// own vocabulary, because the two CLIs word this nothing alike and the Claude
// pattern misses every codex phrasing outright.
//
// The healthy-session traps are the point of the negative lists below, and both
// were read off a live pane rather than guessed: codex opens EVERY session with
// "You have 2 usage limit resets available. Run /usage to use one.", and its
// status line carries "Remaining usage on the primary usage limit".
const MODEL_NAMES = ['fable', 'opus', 'sonnet', 'haiku']

// Apostrophes: the strings compiled into the codex binary are ASCII, but a TUI
// is free to render a typographic one, so both are accepted everywhere one
// appears.
const AP = "['’]?"

export const LIMIT_PATTERNS = {
  // Scope: reached-text naming a specific model ⇒ 'model' (Fable's own weekly
  // sub-cap); generic ⇒ 'provider'.
  anthropic: {
    // Two phrasings, both read off live panes: "<name> usage limit reached"
    // (the original), and "You've reached your <name> limit" (the wording the
    // CLI printed at the #544 cap hit, 2026-08-18 — the old pattern missed it
    // and the daemon never cooled). The second alternative requires a name
    // before "limit", so the promotional "If you hit your limit, you can
    // continue…" text in healthy panes stays unmatched (field-notes
    // contract 4).
    reached: new RegExp(
      '([A-Za-z][A-Za-z0-9 .-]*?)\\s*usage limit reached'
      + `|you${AP}ve reached your ([A-Za-z][A-Za-z0-9 .-]*?)\\s*limit`,
      'i',
    ),
    scopeOf: (m) => {
      const name = (m[1] ?? m[2] ?? '').toLowerCase()
      return MODEL_NAMES.some((n) => name.includes(n)) ? 'model' : 'provider'
    },
    // `|<epoch-seconds>` suffix when present
    reset: /\|\s*(\d{9,12})/,
  },
  // Every codex cap is account-level — the CLI's own vocabulary has daily,
  // weekly, 5-hour, monthly and annual limits and no per-model sub-cap — so the
  // scope is always 'provider' and the chain crosses to the other provider.
  // No reset pattern: codex states no reset time in any of these messages, so
  // resetAt stays null HERE. It is not unknown, though — this harness states the
  // instant in its transcript, and #handleLimit reads it there (#175). What
  // stays conservative is the case neither surface states: an hour.
  openai: {
    reached: new RegExp(
      `you${AP}ve (?:hit|reached) your (?:usage limit|workspace credit limit)`
      + `|(?:you${AP}re|your workspace is) out of credits`
      + '|(?:^|[^a-z])usage limit reached',
      'i',
    ),
    scopeOf: () => 'provider',
    reset: null,
  },
}

// The usage-credits dialog family (#108 item 12 / #126): a fresh fable spawn
// past its weekly threshold gets a modal — "Fable 5 now uses usage credits /
// You don't have usage credits yet / 1. Request credits 2. Switch to Sonnet" —
// instead of the composer. parseUsageLimit keys on reached-phrasing and
// misses it, and the ready marker matched anyway because the status footer
// renders UNDER the modal. This classifier runs beside the limit parse in the
// watchdog, so a match both cools the model and vetoes readiness. Keyed on
// the definitive no-credits statement, not the informational "now uses usage
// credits" line — promotional text appears in healthy panes (field-notes
// contract 4) and must never match. Model-scoped: the dialog gates one
// model's credits; every other model stays warm.
export const CREDIT_GATE_PATTERNS = {
  anthropic: new RegExp(`you don${AP}t have usage credits`, 'i'),
}

export function parseCreditGate(paneText, provider = 'anthropic') {
  if (!paneText) return null
  const p = CREDIT_GATE_PATTERNS[provider]
  if (!p?.test(paneText)) return null
  return { scope: 'model', resetAt: null, reason: 'usage-credits dialog' }
}

export function parseUsageLimit(paneText, provider = 'anthropic') {
  if (!paneText) return null
  const p = LIMIT_PATTERNS[provider]
  if (!p) return null
  const m = paneText.match(p.reached)
  if (!m) return null
  const reset = p.reset ? paneText.match(p.reset) : null
  return { scope: p.scopeOf(m), resetAt: reset ? new Date(Number(reset[1]) * 1000) : null }
}

// Does this text carry a phrase that could FORGE a usage-limit signal? Checked
// against every provider's vocabulary rather than the agent's own, for two
// reasons: the answer is computed once from the ticket text at dispatch while an
// agent's provider CHANGES under it on a cross-provider fallback, and the
// consequence of a match is a refusal to act — over-refusing falls through to
// the ready-timeout path, which surfaces to a human, and that is the safe
// direction (see paneTail in dispatch.mjs).
export function carriesLimitPhrase(text) {
  return Object.values(LIMIT_PATTERNS).some((p) => p.reached.test(text))
    || Object.values(CREDIT_GATE_PATTERNS).some((re) => re.test(text))
}

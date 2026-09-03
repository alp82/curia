// The settings write (#265), building item 5 of the where-it-lives decision
// (#249): "The sidecar edits `curia.yaml` and `routing.yaml` through the yaml
// document API, so the hand comments survive. It validates the candidate with
// the daemon's own loaders before it touches disk. The write is atomic: temp
// file, then rename. A rejected save leaves the file untouched and returns the
// loader's message."
//
// #292 moved WHERE it writes. Git tracks `curia.yaml` and `routing.yaml`, so a
// save used to leave the box's checkout dirty and the next deploy's `git merge
// --ff-only` refused it. #866 then split the two halves of a save:
//
// - The curia half is OPERATOR CONFIGURATION, and it goes to `config.yaml`
//   beside `curia.yaml` through the one contract module in
//   `cli/src/config.mjs`: the same reader, validator, and atomic writer the
//   daemon boots on and the lifecycle interface installs with. The file is
//   the operator's declaration, so a save carries the keys it already holds
//   plus the keys this patch names, and invents no other value.
// - The routing half still goes to `routing.local.yaml`, the override layer
//   over the tracked file, edited through the yaml document API so the hand
//   comments survive.
//
// Four rules run through everything below.
//
// 1. THE PATCH IS A CLOSED SET. The screen writes named dispatch values, the
//    pane cap, the watch list, the routing defaults, and the model switch.
//    Every value is named in code here and mapped onto an explicit key. There
//    is no generic "set this key" route, because a browser that could set any
//    key could set `dispatch.workspace_root` or `sandbox.image`.
//
// 2. THE DAEMON'S OWN LOADERS SAY YES FIRST. The candidate is validated by
//    `loadCuriaConfig`/`loadRoutingConfig` — the same functions that decide
//    whether the daemon boots — before anything moves, and validated the way
//    the daemon will read it: the operator candidate as a layer over the
//    shipped file, the routing candidate as a layer over the tracked one. The
//    one thing skipped is `checkPaths` (see config.mjs): those four rules ask
//    about a filesystem the sidecar's container does not mount, and no key
//    here can reach them.
//
// 3. A REFUSED SAVE CHANGES NOTHING. The routing candidate is a temp file
//    beside the real one, and the operator candidate is judged in memory. Both
//    land only after both pass, so a two-file save is not half applied, and
//    each landing is one atomic rename.
//
// 4. THE ROUTING OVERRIDE HOLDS ONLY WHAT DIFFERS. A value that comes back to
//    what the tracked file says is deleted rather than repeated, and an
//    override that empties out is removed.
//
// A NOTE ON LAYOUT. The document API keeps every comment, and it does not keep
// the COLUMN a trailing comment sits in: `foo: 1        # why` prints back as
// `foo: 1 # why`. Both tracked files are committed in that normal form, and
// `settings.test.mjs` holds them there — so a hand edit made in an override
// file rewrites the lines it changed and no others.

import fs from 'node:fs'
import path from 'node:path'
import { parse, parseDocument } from 'yaml'
import { loadCuriaConfig, loadRoutingConfig, localConfigFile, operatorConfigFile, readLayered, WATCH_MODES } from './config.mjs'
import { REASONING_EFFORTS } from './routing.mjs'
import { DEFAULT_OVERSEER } from './overseerservice.mjs'
import { readOperatorConfig, renderOperatorConfig, writeOperatorConfig } from '../../cli/src/config.mjs'

// What a new routing override file says about itself, above the first key. It
// is the one place the layer rule is written where the operator meets it: on
// the box, in the file, rather than in a doc they would have to go and find.
const routingHeader = (base) => [
  "# This box's own routing settings (#292). The curia dashboard writes this file.",
  '#',
  '# Git does not track it. A save leaves the checkout clean, and a deploy never',
  `# collides with one. This file lays over \`${path.basename(base)}\`. A mapping`,
  '# merges key by key. A list or a scalar replaces whole.',
  '#',
  '# Only what this box answers differently is here. A value that comes back to',
  '# the tracked answer is dropped from this file rather than repeated.',
  '',
  '',
].join('\n')

// What `toString` must be told so that printing an unedited document returns
// the file byte for byte. `lineWidth: 0` stops it re-wrapping long scalars, and
// the padding option stops `[a, b]` becoming `[ a, b ]`.
export const PRINT_OPTS = { flowCollectionPadding: false, lineWidth: 0 }

// The name of the candidate, beside the file it will become. Same directory on
// purpose, twice over: `rename` is atomic only within one filesystem, and both
// loaders resolve relative paths against the config file's own directory, so a
// candidate anywhere else would be validated against different paths than the
// file it replaces.
export const candidateFor = (file) => path.join(path.dirname(file), `.${path.basename(file)}.candidate`)

// A refusal the operator caused, as opposed to a bug. The route answers 409 for
// one of these and 500 for anything else.
export class SettingsRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'SettingsRefusal'
    this.refusal = true
  }
}

const refuse = (msg) => { throw new SettingsRefusal(msg) }

// The `dispatch:` keys the screen carries. The remaining keys stay off the
// screen. They describe the box or tune internal dispatch behavior.
export const DISPATCH_KEYS = [
  'auto_dispatch', 'max_concurrent', 'poll_interval_s', 'prototype_variations', 'messages_per_send',
]


const routeRow = (type, route) => ({
  type,
  model: String(typeof route === 'string' ? route : route?.model ?? ''),
  ...(typeof route === 'object' && route?.effort != null ? { effort: String(route.effort) } : {}),
})

// ---------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------

// The operator configuration as the screen reads it: the file's keys, or
// none when there is no file. A file the contract refuses reads as none too,
// with the message beside it, for the reason the plain parse below exists.
function readOperator(operatorFile) {
  try {
    return { operator: readOperatorConfig(operatorFile) ?? {}, error: null }
  } catch (e) {
    return { operator: {}, error: e.message }
  }
}

// What the settings screen draws: the layers, merged the way the daemon reads
// them. Read with a plain parse rather than through the loaders, and
// deliberately: a config the loaders REFUSE is exactly when the operator most
// needs this screen, and a read that threw would hand them a blank page in
// front of a daemon that will not boot.
//
// `operatorFile` and `routingLocalFile` name where the two halves of a save
// land: beside the tracked files by default (the source deployment), the
// root's `config/config.yaml` and `state/routing.local.yaml` when the daemon
// answers the app's settings screen under an installation root (#880).
export function readSettings({ curiaFile, routingFile, operatorFile = operatorConfigFile(curiaFile), routingLocalFile = localConfigFile(routingFile) }) {
  const curia = readLayered(curiaFile).data ?? {}
  const routing = readLayered(routingFile, { localFile: routingLocalFile }).data ?? {}
  const { operator, error } = readOperator(operatorFile)
  const dispatch = {}
  for (const key of DISPATCH_KEYS) {
    dispatch[key] = operator[key] ?? curia.dispatch?.[key] ?? (key === 'messages_per_send' ? 4 : null)
  }
  return {
    files: { curia: curiaFile, routing: routingFile },
    // Where a save lands, which is not where the screen read from. The page
    // says this out loud, because "I saved and git shows nothing" must not be
    // a surprise the operator has to work out.
    writes: { curia: operatorFile, routing: routingLocalFile },
    // The operator file's own refusal, when it has one, so the screen can say
    // why the service will not take the file instead of drawing the shipped
    // answers as if they were running.
    ...(error ? { operator_error: error } : {}),
    dispatch,
    overseer: { live_pane_cap: operator.live_pane_cap ?? curia.overseer?.live_pane_cap ?? DEFAULT_OVERSEER.live_pane_cap },
    watch: (operator.watch ?? curia.watch ?? []).map((w) => ({ repo: w?.repo ?? '', mode: w?.mode ?? 'auto' })),
    watch_modes: WATCH_MODES,
    routing: {
      // An ordered list, not a map: the table draws the rows in the order
      // routing.yaml states them, and `untyped` reads last there for a reason.
      defaults: Object.entries(routing.defaults ?? {}).map(([type, route]) => routeRow(type, route)),
      models: Object.entries(routing.models ?? {}).map(([name, m]) => ({
        name,
        provider: m?.provider ?? null,
        harness: m?.harness ?? null,
        // The name the CLI is actually asked for, where it differs from the
        // routing label (`gpt` is `gpt-5.6-sol`). The manage panel shows it.
        id: m?.id ?? null,
        // Absent means on. One reading of the switch, the same one
        // routing.mjs's `isActive` makes.
        active: m?.active !== false,
      })),
    },
  }
}

// Value equality for anything a config file can hold. Shared by the live set
// below and by the edits further down, which is why it sits above both.
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// ---------------------------------------------------------------------------
// the live set (#362)
// ---------------------------------------------------------------------------
//
// The settings this screen writes are the settings `POST /reload` applies.
// Rule 3 above is the reason they are one list rather than two:
// a reload that applied a key the screen cannot write would be a second patch
// set, free to disagree with this one.
//
// A `*` stands for exactly one key. `defaults.*` is every routing row, and
// `models.*.active` is the switch on every model — the screen edits the rows
// that are there and adds none, so a row that appears or goes is NOT in the set
// and needs the restart.
export const LIVE_PATHS = {
  curia: [
    'dispatch.auto_dispatch', 'dispatch.max_concurrent', 'dispatch.poll_interval_s',
    'dispatch.prototype_variations', 'dispatch.messages_per_send', 'overseer.live_pane_cap', 'watch',
  ],
  routing: ['defaults.*', 'models.*.active'],
}

// The six values, out of two loaded configs, in the shape `readSettings` gives
// the same six. One shape, so the page compares what the daemon RUNS against
// what the file says with a plain equality per key.
export function liveSettings({ curia, routing }) {
  const dispatch = {}
  for (const key of DISPATCH_KEYS) dispatch[key] = curia?.dispatch?.[key] ?? null
  return {
    dispatch,
    overseer: { live_pane_cap: curia?.overseer?.live_pane_cap ?? DEFAULT_OVERSEER.live_pane_cap },
    watch: (curia?.watch ?? []).map((w) => ({ repo: w?.repo ?? '', mode: w?.mode ?? 'auto' })),
    routing: {
      defaults: Object.entries(routing?.defaults ?? {}).map(([type, route]) => routeRow(type, route)),
      // `active` and the name, because they are what the switch moves. Provider
      // and harness are on the screen's own read and are not reloadable.
      models: Object.entries(routing?.models ?? {}).map(([name, m]) => ({ name, active: m?.active !== false })),
    },
  }
}

// Which of the six moved, named the way the operator reads them. The reload
// journals this list, and the page draws it when the daemon and the file
// disagree.
export function liveDiff(before, after) {
  const out = []
  for (const key of DISPATCH_KEYS) {
    if (!same(before.dispatch?.[key], after.dispatch?.[key])) out.push(`dispatch.${key}`)
  }
  // The list replaces whole (config.mjs states that rule), so it moves as one
  // key rather than as one key per repo.
  if (!same(before.watch, after.watch)) out.push('watch')
  if (!same(before.overseer?.live_pane_cap, after.overseer?.live_pane_cap)) out.push('overseer.live_pane_cap')
  const rows = (s) => new Map((s.routing?.defaults ?? []).map((r) => [r.type, {
    model: r.model,
    effort: r.effort ?? null,
  }]))
  const [rb, ra] = [rows(before), rows(after)]
  for (const type of new Set([...rb.keys(), ...ra.keys()])) {
    if (!same(rb.get(type), ra.get(type))) out.push(`routing.defaults.${type}`)
  }
  const switches = (s) => new Map((s.routing?.models ?? []).map((m) => [m.name, m.active !== false]))
  const [sb, sa] = [switches(before), switches(after)]
  for (const name of new Set([...sb.keys(), ...sa.keys()])) {
    if (!same(sb.get(name), sa.get(name))) out.push(`routing.models.${name}.active`)
  }
  return out
}

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const live = (paths, parts) => paths.some((p) => {
  const pat = p.split('.')
  return pat.length === parts.length && pat.every((seg, i) => seg === '*' || seg === parts[i])
})

// The FIRST key outside the live set where two loaded configs differ, or null.
// This is what makes a reload total: the candidate is compared against what the
// daemon runs with the six blanked on both sides, and anything else that moved
// declines the whole reload rather than applying half of it.
//
// A regular expression compares equal to a regular expression here, because
// neither has own keys — the pattern it was built from is a string on the same
// object and is compared as one (routing.mjs `ready` / `readyRe`).
export function frozenDifference(before, after, paths, parts = []) {
  if (isMapping(before) && isMapping(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const child = [...parts, key]
      // A live path is blanked only where the key is on BOTH sides. The screen
      // edits the rows that are there and adds none, so a `defaults` row or a
      // model that appears or goes is a hand edit outside the set, and it needs
      // the restart like every other hand edit.
      if (live(paths, child) && key in before && key in after) continue
      const found = frozenDifference(before[key], after[key], paths, child)
      if (found) return found
    }
    return null
  }
  return same(before, after) ? null : (parts.join('.') || 'the whole file')
}

// ---------------------------------------------------------------------------
// the patch
// ---------------------------------------------------------------------------

// The closed set, and the routing shapes. Every value rule for the operator
// half — is this a positive whole number, is this an `owner/name` repo —
// belongs to the contract module, and every semantic rule — is this model
// configured, does this number leave room for `3 × max_concurrent` containers —
// belongs to the loaders. Running a second copy of either here is how two
// validators start to disagree.
function checkPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) refuse('the save carried no settings')
  for (const key of Object.keys(patch)) {
    if (!['dispatch', 'overseer', 'watch', 'routing'].includes(key)) refuse(`the settings screen does not write \`${key}\``)
  }
  const d = patch.dispatch
  if (d !== undefined) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) refuse('`dispatch` must be a mapping')
    for (const key of Object.keys(d)) {
      if (!DISPATCH_KEYS.includes(key)) refuse(`the settings screen does not write \`dispatch.${key}\``)
    }
  }
  if (patch.overseer !== undefined) {
    const over = patch.overseer
    if (!over || typeof over !== 'object' || Array.isArray(over)) refuse('`overseer` must be a mapping')
    for (const key of Object.keys(over)) {
      if (key !== 'live_pane_cap') refuse(`the settings screen does not write \`overseer.${key}\``)
    }
  }
  if (patch.watch !== undefined) {
    if (!Array.isArray(patch.watch)) refuse('`watch` must be a list of repos')
    for (const w of patch.watch) {
      if (!w || typeof w !== 'object' || Array.isArray(w)) refuse('`watch` must be a list of `{ repo, mode }` entries')
      for (const key of Object.keys(w)) {
        if (key !== 'repo' && key !== 'mode') refuse(`the settings screen does not write \`watch.${key}\``)
      }
    }
  }
  const r = patch.routing
  if (r !== undefined) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) refuse('`routing` must be a mapping')
    for (const key of Object.keys(r)) {
      if (!['defaults', 'models', 'review'].includes(key)) refuse(`the settings screen does not write \`routing.${key}\``)
    }
    // The review rows are the routing preset's to write (#891): the model
    // that reads a builder's diff, or `null` for no pairing.
    for (const [builder, model] of Object.entries(r.review ?? {})) {
      // A row keyed by a ticket type holds that type's own pairing (#891),
      // one model name or null per builder provider.
      if (model && typeof model === 'object' && !Array.isArray(model)) {
        for (const [provider, m] of Object.entries(model)) {
          if (m !== null && typeof m !== 'string') refuse(`\`routing.review.${builder}.${provider}\` must be a model name or null`)
        }
        continue
      }
      if (model !== null && typeof model !== 'string') refuse(`\`routing.review.${builder}\` must be a model name or null`)
    }
    for (const [type, route] of Object.entries(r.defaults ?? {})) {
      if (typeof route === 'string') {
        if (!route.trim()) refuse(`defaults.${type} must name a model`)
        continue
      }
      if (!route || typeof route !== 'object' || Array.isArray(route)) {
        refuse(`defaults.${type} must name a model or carry a model and effort`)
      }
      for (const key of Object.keys(route)) {
        if (!['model', 'effort'].includes(key)) refuse(`defaults.${type}.${key} is not a routing field`)
      }
      if (typeof route.model !== 'string' || !route.model.trim()) refuse(`defaults.${type}.model must name a model`)
      if (route.effort !== undefined && !REASONING_EFFORTS.includes(route.effort)) {
        refuse(`defaults.${type}.effort must be one of ${REASONING_EFFORTS.join('|')}`)
      }
    }
    for (const [name, m] of Object.entries(r.models ?? {})) {
      if (!m || typeof m !== 'object' || typeof m.active !== 'boolean') {
        refuse(`models.${name}: the settings screen writes \`active\` and nothing else`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// the edits
// ---------------------------------------------------------------------------

// Every edit below takes three things: the override DOCUMENT it writes, the
// patch, and the data the TRACKED file holds. The third is what decides the
// shape of the first — an override exists only where the two disagree.

// Write the override, or drop it. `baseValue` is what the tracked file says: an
// answer equal to it needs no override, and leaving one behind would pin this
// box to today's number the day a ticket ships a better one.
function settle(doc, keyPath, value, baseValue) {
  if (!same(value, baseValue)) {
    doc.setIn(keyPath, value)
    return
  }
  // An override file that is still nothing but its header has no key to drop,
  // and the document API refuses a delete against empty contents. It refuses
  // a delete along a path that is not there too (`models.gpt.active` when the
  // override holds `models.fable` alone), so the key is asked for first.
  if (!doc.contents?.items || !doc.hasIn(keyPath)) return
  doc.deleteIn(keyPath)
  // And the sections the delete emptied. An override file that keeps `models:
  // {}` around says this box overrides something when it overrides nothing.
  for (let i = keyPath.length - 1; i >= 1; i--) {
    const parent = doc.getIn(keyPath.slice(0, i))
    if (!parent?.items || parent.items.length) break
    doc.deleteIn(keyPath.slice(0, i))
  }
}

// The operator half of a save (#866): the file's own keys, with the patch laid
// over them. What the patch does not name stays as the file had it, and what
// the file never held stays out, so the file keeps saying only what the
// operator decided. The result is judged twice before anything lands: by the
// contract (the shapes) and by the daemon's loader (the rules that read two
// sections together).
function nextOperator({ curiaFile, operatorFile, patch }) {
  const file = operatorFile ?? operatorConfigFile(curiaFile)
  let current
  try {
    current = readOperatorConfig(file) ?? {}
  } catch (e) {
    refuse(`${e.message} — fix ${path.basename(file)} on the box before saving over it`)
  }
  const next = { ...current, ...(patch.dispatch ?? {}) }
  if (patch.overseer) next.live_pane_cap = patch.overseer.live_pane_cap
  if (patch.watch) next.watch = patch.watch.map((w) => ({ repo: w.repo, mode: w.mode ?? 'auto' }))
  let text
  try {
    text = renderOperatorConfig(next)
  } catch (e) {
    refuse(e.message)
  }
  try {
    loadCuriaConfig(curiaFile, { checkPaths: false, operator: next })
  } catch (e) {
    refuse(e.message)
  }
  // Unchanged means the same meaning, not the same bytes: a hand-written file
  // that already says what the patch says is left as the operator wrote it.
  return { file, next, unchanged: renderOperatorConfig(current) === text }
}

function editRouting(doc, patch, base) {
  for (const [type, route] of Object.entries(patch.routing.defaults ?? {})) {
    if (base.defaults?.[type] === undefined) {
      refuse(`routing.yaml has no \`defaults.${type}\` row — the settings screen edits the rows that are there and adds none`)
    }
    settle(doc, ['defaults', type], route, base.defaults[type])
  }
  for (const [name, m] of Object.entries(patch.routing.models ?? {})) {
    if (!base.models?.[name]) refuse(`routing.yaml has no \`models.${name}\` entry — a model is added by hand, not by a checkbox`)
    // The switch is a value here rather than an absence. Absence was the reading
    // when this wrote the tracked file, and it cannot be: the tracked file may
    // itself say `active: false`, and an override that expressed ON by deleting
    // a key would then say nothing at all.
    settle(doc, ['models', name, 'active'], m.active, base.models[name].active !== false)
  }
  for (const [builder, model] of Object.entries(patch.routing.review ?? {})) {
    if (base.review?.[builder] === undefined) refuse(`routing.yaml has no \`review.${builder}\` row — the preset moves or drops the rows that are there and adds none`)
    if (model && typeof model === 'object') {
      for (const [provider, m] of Object.entries(model)) {
        if (base.review[builder]?.[provider] === undefined) refuse(`routing.yaml has no \`review.${builder}.${provider}\` row — the preset moves or drops the rows that are there and adds none`)
        settle(doc, ['review', builder, provider], m, base.review[builder][provider])
      }
      continue
    }
    settle(doc, ['review', builder], model, base.review[builder])
  }
}

// ---------------------------------------------------------------------------
// the write
// ---------------------------------------------------------------------------

function stage(file, text) {
  const tmp = candidateFor(file)
  // The candidate becomes the file, so it inherits the file's permissions
  // rather than whatever the umask would have given a fresh one. The first save
  // on a box has no file to inherit from, and takes the ordinary mode.
  let mode = 0o644
  try { mode = fs.statSync(file).mode & 0o777 } catch { /* the first save */ }
  const fd = fs.openSync(tmp, 'w', mode)
  try {
    fs.writeFileSync(fd, text)
    // The rename below is atomic against a crash, and only fsync makes it
    // atomic against a power cut: without it the rename can land while the
    // bytes it points at have not.
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return tmp
}

function discard(tmp) {
  try { fs.unlinkSync(tmp) } catch { /* already gone — nothing to undo */ }
}

function commit(tmp, file) {
  fs.renameSync(tmp, file)
  // And the directory entry itself. Best effort: some filesystems refuse a
  // directory fsync, and a save that worked must not fail on the flush of its
  // own bookkeeping.
  try {
    const dir = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  } catch { /* the rename already landed */ }
}

// The routing loader, run on the candidate AS A LAYER over the tracked file —
// which is how the daemon will read it, so it is the only judgement worth
// having. The temp path is swapped back out of the message: the operator asked
// about `routing.local.yaml`, so the refusal names it, not the dotfile beside
// it that only this module knows about. A candidate that removes the override
// validates the tracked file alone.
function validateRouting({ base, file, tmp }) {
  try {
    loadRoutingConfig(base, { localFile: tmp ?? null })
  } catch (e) {
    throw new SettingsRefusal(tmp ? String(e.message).split(tmp).join(file) : String(e.message))
  }
}

// Save the patch: the operator half into `config.yaml`, the routing half into
// `routing.local.yaml`. Returns the basenames actually written — a save that
// changes nothing writes nothing, and says so.
//
// `operatorFile` is where the operator half lands, `config.yaml` beside the
// tracked file by default and the root's `config/config.yaml` when the daemon
// saves for the app (#880). `routingLocalFile` is where the routing override
// lives, beside the tracked file by default; under an installation root the
// routing preset of integration setup (#878) and the daemon's settings route
// name the root's `state/routing.local.yaml` here, and the daemon loads the
// same layered pair.
export function saveSettings({ curiaFile, routingFile, operatorFile = null, routingLocalFile = null, patch, now = () => new Date() }) {
  checkPatch(patch)
  const wantsOperator = Boolean(patch.dispatch || patch.overseer || patch.watch)
  if (!wantsOperator && !patch.routing) refuse('the save carried no settings')

  // The operator candidate is judged first and in memory: a refusal here costs
  // no temp file. `null` when the file already says what the patch says.
  let operator = null
  if (wantsOperator) {
    const candidate = nextOperator({ curiaFile, operatorFile, patch })
    if (!candidate.unchanged) operator = candidate
  }

  let routing = null
  try {
    if (patch.routing) {
      const file = routingLocalFile ?? localConfigFile(routingFile)
      const baseData = parse(fs.readFileSync(routingFile, 'utf8')) ?? {}
      // No override file yet is the ordinary first save. `null` marks it, so
      // "nothing changed" and "the override is gone" stay two different
      // answers below.
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      const doc = parseDocument(before ?? routingHeader(routingFile))
      if (doc.errors?.length) {
        refuse(`${path.basename(file)} does not parse as yaml (${doc.errors[0].message}) — fix it on the box before saving over it`)
      }
      editRouting(doc, patch, baseData)
      // An override file with no keys left is removed rather than kept as `{}`.
      const empty = !doc.contents || !(doc.contents.items?.length > 0)
      const after = empty ? null : doc.toString(PRINT_OPTS)
      if (after !== before) {
        routing = { base: routingFile, file, ...(after === null ? { remove: true } : { tmp: stage(file, after) }) }
        validateRouting(routing)
      }
    }
    // Both candidates have passed. The operator file lands first, atomically,
    // then the routing override, so a two-file save is never half applied by a
    // refusal, and a failed write leaves the routing candidate discarded.
    if (operator) writeOperatorConfig(operator.file, operator.next)
    if (routing) {
      if (routing.remove) fs.rmSync(routing.file, { force: true })
      else commit(routing.tmp, routing.file)
    }
  } catch (e) {
    if (routing?.tmp) discard(routing.tmp)
    throw e
  }
  const written = [operator, routing].filter(Boolean).map((s) => path.basename(s.file))
  return { written, at: now().toISOString() }
}

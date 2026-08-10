// The settings write (#265), building item 5 of the where-it-lives decision
// (#249): "The sidecar edits `curia.yaml` and `routing.yaml` through the yaml
// document API, so the hand comments survive. It validates the candidate with
// the daemon's own loaders before it touches disk. The write is atomic: temp
// file, then rename. A rejected save leaves the file untouched and returns the
// loader's message."
//
// Four rules run through everything below.
//
// 1. THE DOCUMENT, NOT THE DATA. A save never re-serializes a parsed object:
//    it edits the parsed DOCUMENT in place and prints it back. Both config
//    files are mostly comments — the why behind every number, written by hand
//    over dozens of tickets — and a settings screen that ate them would cost
//    more than it saves. So `parseDocument` in, node edits, `toString` out.
//
// 2. THE PATCH IS A CLOSED SET. The screen writes six things: three dispatch
//    numbers, the watch list, the routing defaults, and the model switch. Every
//    one is named in code here and mapped onto an explicit key path. There is
//    no generic "set this key" route, because a browser that could set any key
//    could set `dispatch.workspace_root` or `sandbox.image`.
//
// 3. THE DAEMON'S OWN LOADERS SAY YES FIRST. The candidate is validated by
//    `loadCuriaConfig`/`loadRoutingConfig` — the same functions that decide
//    whether the daemon boots — before the real file moves. The one thing
//    skipped is `checkPaths` (see config.mjs): those four rules ask about a
//    filesystem the sidecar's container does not mount, and no key here can
//    reach them.
//
// 4. A REFUSED SAVE CHANGES NOTHING. The candidate is a temp file beside the
//    real one. It is validated there and renamed over the real file only after
//    every candidate passes, so a two-file save is not half applied.
//
// A NOTE ON LAYOUT. The document API keeps every comment, and it does not keep
// the COLUMN a trailing comment sits in: `foo: 1        # why` prints back as
// `foo: 1 # why`. Both config files are committed in that normal form, and
// `settings.test.mjs` holds them there — so a save rewrites the lines it
// changed and no others.

import fs from 'node:fs'
import path from 'node:path'
import { parse, parseDocument } from 'yaml'
import { loadCuriaConfig, loadRoutingConfig, WATCH_MODES } from './config.mjs'

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

// The three `dispatch:` keys the screen carries. The section holds three more —
// `workspace_root`, `ready_timeout_s` and `stop_nudge_budget` — and they stay
// off the screen: the first is a path on the daemon's filesystem, and the other
// two are tuning the operator sets once from the box.
export const DISPATCH_KEYS = ['auto_dispatch', 'max_concurrent', 'poll_interval_s']

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

// ---------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------

// What the settings screen draws. Read with a plain parse rather than through
// the loaders, and deliberately: a config the loaders REFUSE is exactly when
// the operator most needs this screen, and a read that threw would hand them a
// blank page in front of a daemon that will not boot.
export function readSettings({ curiaFile, routingFile }) {
  const curia = parse(fs.readFileSync(curiaFile, 'utf8')) ?? {}
  const routing = parse(fs.readFileSync(routingFile, 'utf8')) ?? {}
  const dispatch = {}
  for (const key of DISPATCH_KEYS) dispatch[key] = curia.dispatch?.[key] ?? null
  return {
    files: { curia: curiaFile, routing: routingFile },
    dispatch,
    watch: (curia.watch ?? []).map((w) => ({ repo: w?.repo ?? '', mode: w?.mode ?? 'auto' })),
    watch_modes: WATCH_MODES,
    routing: {
      // An ordered list, not a map: the table draws the rows in the order
      // routing.yaml states them, and `untyped` reads last there for a reason.
      defaults: Object.entries(routing.defaults ?? {}).map(([type, model]) => ({ type, model: String(model ?? '') })),
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

// ---------------------------------------------------------------------------
// the patch
// ---------------------------------------------------------------------------

// Shape only. Every semantic rule — is this model configured, does this number
// leave room for `3 × max_concurrent` containers — belongs to the loaders, and
// running a second copy of one here is how two validators start to disagree.
function checkPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) refuse('the save carried no settings')
  for (const key of Object.keys(patch)) {
    if (!['dispatch', 'watch', 'routing'].includes(key)) refuse(`the settings screen does not write \`${key}\``)
  }
  const d = patch.dispatch
  if (d !== undefined) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) refuse('`dispatch` must be a mapping')
    for (const key of Object.keys(d)) {
      if (!DISPATCH_KEYS.includes(key)) refuse(`the settings screen does not write \`dispatch.${key}\``)
    }
    if (d.auto_dispatch !== undefined && typeof d.auto_dispatch !== 'boolean') refuse('dispatch.auto_dispatch must be true or false')
    for (const key of ['max_concurrent', 'poll_interval_s']) {
      if (d[key] !== undefined && !(typeof d[key] === 'number' && Number.isFinite(d[key]) && d[key] > 0)) {
        refuse(`dispatch.${key} must be a positive number`)
      }
    }
  }
  if (patch.watch !== undefined) {
    if (!Array.isArray(patch.watch)) refuse('`watch` must be a list of repos')
    if (!patch.watch.length) refuse('the watch list cannot be empty — curia dispatches only against watched repos')
    const seen = new Set()
    for (const w of patch.watch) {
      if (!w || typeof w !== 'object' || !REPO_RE.test(String(w.repo ?? ''))) {
        refuse(`"${w?.repo ?? ''}" is not an \`owner/name\` repo`)
      }
      if (seen.has(w.repo)) refuse(`${w.repo} is on the watch list twice`)
      seen.add(w.repo)
      if (w.mode !== undefined && !WATCH_MODES.includes(w.mode)) {
        refuse(`watch ${w.repo}: mode must be one of ${WATCH_MODES.join('|')}`)
      }
    }
  }
  const r = patch.routing
  if (r !== undefined) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) refuse('`routing` must be a mapping')
    for (const key of Object.keys(r)) {
      if (!['defaults', 'models'].includes(key)) refuse(`the settings screen does not write \`routing.${key}\``)
    }
    for (const [type, model] of Object.entries(r.defaults ?? {})) {
      if (typeof model !== 'string' || !model.trim()) refuse(`defaults.${type} must name a model`)
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

function editCuria(doc, patch) {
  for (const [key, value] of Object.entries(patch.dispatch ?? {})) {
    if (doc.getIn(['dispatch', key]) === undefined) refuse(`curia.yaml has no \`dispatch.${key}\` line to edit`)
    doc.setIn(['dispatch', key], value)
  }
  if (patch.watch) editWatch(doc, patch.watch)
}

// The watch list, reconciled entry by entry rather than replaced.
//
// A repo that survives keeps its own node, so the comment written beside it
// survives with it — and a repo that goes takes its comment with it, which is
// the right half to lose. Only a genuinely new repo gets a fresh node.
function editWatch(doc, watch) {
  const seq = doc.get('watch')
  if (!seq?.items) refuse('curia.yaml has no `watch:` list to edit')
  const byRepo = new Map()
  for (const item of seq.items) {
    const repo = item?.get?.('repo')
    if (repo) byRepo.set(String(repo), item)
  }
  seq.items = watch.map((w) => {
    const node = byRepo.get(w.repo)
    if (!node) {
      // `mode: auto` is the default, so a new entry states a mode only when it
      // is not the default. The shipped file writes it that way by hand.
      return doc.createNode(w.mode && w.mode !== 'auto' ? { repo: w.repo, mode: w.mode } : { repo: w.repo })
    }
    if (w.mode !== undefined) {
      if (w.mode === 'auto' && node.get('mode') === undefined) return node
      if (w.mode === 'auto') node.delete('mode')
      else node.set('mode', w.mode)
    }
    return node
  })
}

function editRouting(doc, patch) {
  for (const [type, model] of Object.entries(patch.routing.defaults ?? {})) {
    if (doc.getIn(['defaults', type]) === undefined) {
      refuse(`routing.yaml has no \`defaults.${type}\` row — the settings screen edits the rows that are there and adds none`)
    }
    doc.setIn(['defaults', type], model)
  }
  for (const [name, m] of Object.entries(patch.routing.models ?? {})) {
    const node = doc.getIn(['models', name])
    if (!node?.set) refuse(`routing.yaml has no \`models.${name}\` entry — a model is added by hand, not by a checkbox`)
    // On is the absence of the key, not `active: true`. Switching a model back
    // on returns the file to the shape it had before anyone touched it, which
    // is what keeps the diff of a save honest about what changed.
    if (m.active) node.delete('active')
    else node.set('active', false)
  }
}

// ---------------------------------------------------------------------------
// the write
// ---------------------------------------------------------------------------

function stage(file, text) {
  const tmp = candidateFor(file)
  // The candidate becomes the file, so it inherits the file's permissions
  // rather than whatever the umask would have given a fresh one.
  const fd = fs.openSync(tmp, 'w', fs.statSync(file).mode & 0o777)
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

// The loaders, run on the candidate, with the temp path swapped back out of
// the message. The operator asked about `curia.yaml`, so the refusal names
// `curia.yaml` — not the dotfile beside it that only this module knows about.
function validate(kind, tmp, file) {
  try {
    if (kind === 'curia') loadCuriaConfig(tmp, { checkPaths: false })
    else loadRoutingConfig(tmp)
  } catch (e) {
    throw new SettingsRefusal(String(e.message).split(tmp).join(file))
  }
}

// Save the patch. Returns the basenames actually written — a save that changes
// nothing writes nothing, and says so.
export function saveSettings({ curiaFile, routingFile, patch, now = () => new Date() }) {
  checkPatch(patch)
  const jobs = []
  if (patch.dispatch || patch.watch) jobs.push({ kind: 'curia', file: curiaFile, edit: (doc) => editCuria(doc, patch) })
  if (patch.routing) jobs.push({ kind: 'routing', file: routingFile, edit: (doc) => editRouting(doc, patch) })
  if (!jobs.length) refuse('the save carried no settings')

  const staged = []
  try {
    for (const job of jobs) {
      const before = fs.readFileSync(job.file, 'utf8')
      const doc = parseDocument(before)
      if (doc.errors?.length) {
        refuse(`${path.basename(job.file)} does not parse as yaml (${doc.errors[0].message}) — fix it on the box before saving over it`)
      }
      job.edit(doc)
      const after = doc.toString(PRINT_OPTS)
      if (after === before) continue
      staged.push({ ...job, tmp: stage(job.file, after) })
    }
    // Every candidate passes before any of them lands, so a two-file save is
    // never half applied.
    for (const s of staged) validate(s.kind, s.tmp, s.file)
    for (const s of staged) commit(s.tmp, s.file)
  } catch (e) {
    for (const s of staged) discard(s.tmp)
    throw e
  }
  return { written: staged.map((s) => path.basename(s.file)), at: now().toISOString() }
}

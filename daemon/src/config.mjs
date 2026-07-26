// Config loading + validation (#33). Both YAML files are hand-edited, so this
// is a trust boundary: malformed config throws with a message naming the file
// and the key, and the daemon refuses to boot rather than limping.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { DEFAULT_RANGE as DEFAULT_PREVIEW_RANGE } from './preview.mjs'
import { DEFAULT_SKILLS, defaultSkillsRoot } from './workspace.mjs'

const WATCH_MODES = ['auto', 'map', 'ready-for-agent']

// A plain directory name and nothing else. The file is hand-edited, so this
// also refuses "..", "a/b" and any other way of pointing the worker's skills
// dir outside the configured root.
const SKILL_NAME_RE = /^[\w.-]+$/

function fail(file, msg) {
  throw new Error(`bad config ${file}: ${msg}`)
}

// YAML has no tilde expansion, and `~/.claude/skills` is how a human writes
// this path.
function expandHome(p) {
  if (p === '~') return os.homedir()
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

export function loadCuriaConfig(file) {
  const cfg = parse(fs.readFileSync(file, 'utf8'))
  if (!cfg || typeof cfg !== 'object') fail(file, 'not a mapping')

  if (!Array.isArray(cfg.watch) || !cfg.watch.length) fail(file, '`watch` must be a non-empty list')
  for (const entry of cfg.watch) {
    if (!entry || typeof entry.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(entry.repo)) {
      fail(file, `watch entry needs a \`repo: owner/name\` (got ${JSON.stringify(entry)})`)
    }
    entry.mode = entry.mode ?? 'auto'
    if (!WATCH_MODES.includes(entry.mode)) {
      fail(file, `watch ${entry.repo}: mode must be one of ${WATCH_MODES.join('|')} (got "${entry.mode}")`)
    }
  }

  const d = cfg.dispatch
  if (!d || typeof d !== 'object') fail(file, '`dispatch` section missing')
  if (typeof d.auto_dispatch !== 'boolean') fail(file, 'dispatch.auto_dispatch must be a boolean')
  // stop_nudge_budget (#54 item 4) is optional with a default so a config
  // predating the merge-gated ending still boots. It must be > 0: a budget of
  // zero would disable the Stop-hook enforcement silently, and turning the
  // enforcement off is not a thing a number should express by accident.
  d.stop_nudge_budget = d.stop_nudge_budget ?? 3
  for (const key of ['max_concurrent', 'poll_interval_s', 'ready_timeout_s', 'confirm_ttl_h', 'stop_nudge_budget']) {
    if (!(typeof d[key] === 'number' && d[key] > 0)) fail(file, `dispatch.${key} must be a positive number`)
  }
  if (typeof d.workspace_root !== 'string' || !path.isAbsolute(d.workspace_root)) {
    fail(file, 'dispatch.workspace_root must be an absolute path')
  }

  const a = cfg.attach
  if (!a || typeof a !== 'object') fail(file, '`attach` section missing')
  for (const key of ['ttyd_port', 'serve_port']) {
    if (!(Number.isInteger(a[key]) && a[key] > 0 && a[key] < 65536)) fail(file, `attach.${key} must be a port number`)
  }

  // Preview port range (#40/#8). Optional with defaults — an existing config
  // predating previews must still boot — but validated hard when present, and
  // the range must not swallow the attach port: sweeping it would take /attach
  // down tailnet-wide on the next reconcile.
  const p = cfg.preview ?? {}
  if (typeof p !== 'object') fail(file, '`preview` must be a mapping')
  const range = { from: p.port_from ?? DEFAULT_PREVIEW_RANGE.from, to: p.port_to ?? DEFAULT_PREVIEW_RANGE.to }
  for (const [key, v] of [['port_from', range.from], ['port_to', range.to]]) {
    if (!(Number.isInteger(v) && v > 0 && v < 65536)) fail(file, `preview.${key} must be a port number`)
  }
  if (range.to < range.from) fail(file, `preview.port_to (${range.to}) must not be below preview.port_from (${range.from})`)
  for (const [name, port] of [['attach.serve_port', a.serve_port], ['attach.ttyd_port', a.ttyd_port]]) {
    if (port >= range.from && port <= range.to) {
      fail(file, `preview range ${range.from}-${range.to} contains ${name} (${port}) — the preview sweep would withdraw it`)
    }
  }
  cfg.preview = range

  // Worker skill set (#57). Optional section with defaults, but validated the
  // same either way: the daemon refuses to boot naming the missing skill
  // rather than dispatching a worker that silently lacks one. Only an
  // explicitly empty `install:` opts out — silence by omission is the failure
  // this section exists to end, so omission takes the full default list.
  const s = cfg.skills ?? {}
  if (typeof s !== 'object' || Array.isArray(s)) fail(file, '`skills` must be a mapping')
  const skillsRoot = expandHome(s.root ?? defaultSkillsRoot())
  if (typeof skillsRoot !== 'string' || !path.isAbsolute(skillsRoot)) {
    fail(file, 'skills.root must be an absolute path')
  }
  const install = s.install ?? DEFAULT_SKILLS
  if (!Array.isArray(install)) fail(file, 'skills.install must be a list of skill names')
  for (const name of install) {
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name) || name === '.' || name === '..') {
      fail(file, `skills.install: ${JSON.stringify(name)} is not a plain skill name`)
    }
    const manifest = path.join(skillsRoot, name, 'SKILL.md')
    if (!fs.existsSync(manifest)) {
      fail(file, `skills.install names "${name}", but ${manifest} does not exist — install the skill or drop it from the list`)
    }
  }
  cfg.skills = { root: skillsRoot, install }

  return cfg
}

export function loadRoutingConfig(file) {
  const cfg = parse(fs.readFileSync(file, 'utf8'))
  if (!cfg || typeof cfg !== 'object') fail(file, 'not a mapping')

  if (!cfg.defaults || typeof cfg.defaults !== 'object') fail(file, '`defaults` section missing')
  if (typeof cfg.defaults.untyped !== 'string') fail(file, 'defaults.untyped is required')

  if (!cfg.models || typeof cfg.models !== 'object' || !Object.keys(cfg.models).length) {
    fail(file, '`models` must be a non-empty map')
  }
  for (const [name, m] of Object.entries(cfg.models)) {
    if (!m || typeof m.provider !== 'string' || typeof m.backend !== 'string') {
      fail(file, `models.${name} needs \`provider\` and \`backend\``)
    }
  }
  for (const [type, model] of Object.entries(cfg.defaults)) {
    if (!cfg.models[model]) fail(file, `defaults.${type} names unknown model "${model}"`)
  }

  cfg.fallbacks = cfg.fallbacks ?? {}
  for (const [from, chain] of Object.entries(cfg.fallbacks)) {
    if (!cfg.models[from]) fail(file, `fallbacks.${from} names unknown model "${from}"`)
    if (!Array.isArray(chain)) fail(file, `fallbacks.${from} must be a list`)
    for (const to of chain) {
      if (!cfg.models[to]) fail(file, `fallbacks.${from} names unknown model "${to}"`)
    }
  }

  if (!cfg.backends || typeof cfg.backends !== 'object' || !Object.keys(cfg.backends).length) {
    fail(file, '`backends` must be a non-empty map')
  }
  for (const [name, b] of Object.entries(cfg.backends)) {
    if (!b || typeof b.template !== 'string') fail(file, `backends.${name} needs a \`template\` string`)
    for (const ph of ['{model}', '{prompt_file}']) {
      if (!b.template.includes(ph)) fail(file, `backends.${name}.template is missing the ${ph} placeholder`)
    }
  }
  for (const [name, m] of Object.entries(cfg.models)) {
    if (!cfg.backends[m.backend]) fail(file, `models.${name}.backend names unknown backend "${m.backend}"`)
  }

  return cfg
}

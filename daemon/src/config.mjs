// Config loading + validation (#33). Both YAML files are hand-edited, so this
// is a trust boundary: malformed config throws with a message naming the file
// and the key, and the daemon refuses to boot rather than limping.

import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

const WATCH_MODES = ['auto', 'map', 'ready-for-agent']

function fail(file, msg) {
  throw new Error(`bad config ${file}: ${msg}`)
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
  for (const key of ['max_concurrent', 'poll_interval_s', 'ready_timeout_s', 'confirm_ttl_h']) {
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

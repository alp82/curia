// Config loading + validation (#33). Both YAML files are hand-edited, so this
// is a trust boundary: malformed config throws with a message naming the file
// and the key, and the daemon refuses to boot rather than limping.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { DEFAULT_RANGE as DEFAULT_PREVIEW_RANGE } from './preview.mjs'
import { DEFAULT_SKILLS, defaultSkillsRoot, HARNESS_BACKENDS } from './workspace.mjs'
import { LIMIT_PATTERNS, SAFE_SUBSTITUTION } from './routing.mjs'
import { DEFAULT_INDEX, REBUILD_CMD } from './attach.mjs'
import { PROBE_MODEL } from './usage.mjs'
import { DEFAULT_TIMELINE_INDEX } from './timeline.mjs'
import { DEFAULT_IMAGE, DOCKERFILE, SANDBOX_KEYS } from './image.mjs'

const WATCH_MODES = ['auto', 'map', 'ready-for-agent']

// Every reasoning effort any configured model accepts, unioned.
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

// A plain directory name and nothing else. The file is hand-edited, so this
// also refuses "..", "a/b" and any other way of pointing the worker's skills
// dir outside the configured root.
const SKILL_NAME_RE = /^[\w.-]+$/

// A pinned version as npm and the gh releases page write one. Deliberately
// narrow: `latest`, `^2.1`, and an empty string are all things a human might
// type on a version line, and every one of them un-pins the image.
const VERSION_RE = /^\d+(\.\d+)*(-[\w.]+)?$/
// A docker repository name. No tag and no digest — the tag is derived, never
// written by hand (daemon/src/image.mjs).
const IMAGE_NAME_RE = /^[a-z0-9]+([._/-][a-z0-9]+)*$/

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
  // confirm_ttl_h is gone (#94): confirms have no expiry clock — they lapse
  // with their worker. A yaml still carrying the key loads fine; it is ignored.
  for (const key of ['max_concurrent', 'poll_interval_s', 'ready_timeout_s', 'stop_nudge_budget']) {
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
  // The attach page (#70, landing #69's variant A). Optional with a default,
  // which #57's "silence by omission is the failure" rule does NOT argue
  // against here: omitting `skills.install` would have meant installing no
  // skills — a real loss expressed by silence — while omitting this means the
  // surface curia ships, which is the only value anyone wants. What it must
  // never do is resolve to a file that is not there, so it is checked at boot,
  // naming the path and the command that builds it.
  if (a.index !== undefined && typeof a.index !== 'string') fail(file, 'attach.index must be a path')
  // Relative to THIS file's directory, so the shipped config can name the
  // asset portably instead of carrying one box's absolute path.
  a.index = a.index === undefined
    ? DEFAULT_INDEX
    : path.resolve(path.dirname(path.resolve(file)), expandHome(a.index))
  if (!fs.existsSync(a.index)) {
    fail(file, `attach.index resolves to ${a.index}, which does not exist — build it with \`${REBUILD_CMD}\``)
  }

  // The timeline surface (#74, landing #73's pick). Optional with defaults for
  // the same reason attach.index is: omitting it means the surface curia
  // ships, which is the only value anyone wants. Validated hard either way,
  // and the page must exist at boot — the same refusal attach.index gets.
  const t = cfg.timeline ?? {}
  if (typeof t !== 'object' || Array.isArray(t)) fail(file, '`timeline` must be a mapping')
  t.port = t.port ?? 4272
  t.serve_port = t.serve_port ?? 8444
  for (const key of ['port', 'serve_port']) {
    if (!(Number.isInteger(t[key]) && t[key] > 0 && t[key] < 65536)) fail(file, `timeline.${key} must be a port number`)
  }
  if (t.index !== undefined && typeof t.index !== 'string') fail(file, 'timeline.index must be a path')
  t.index = t.index === undefined
    ? DEFAULT_TIMELINE_INDEX
    : path.resolve(path.dirname(path.resolve(file)), expandHome(t.index))
  if (!fs.existsSync(t.index)) {
    fail(file, `timeline.index resolves to ${t.index}, which does not exist — it ships committed in daemon/assets/`)
  }
  // The identity check in front of both attach surfaces (#151, the standing
  // requirement of ADR-0003). Unlike attach.index and timeline.index, this
  // section has NO usable default and is REQUIRED: defaulting it would either
  // invent an allowlist (admitting a login nobody chose) or ship an empty one
  // (locking the operator out silently). #57's rule decides it — silence by
  // omission is the failure — so a config with no `identity` block names the
  // section and the key instead of booting either way.
  const id = cfg.identity
  if (!id || typeof id !== 'object' || Array.isArray(id)) {
    fail(file, '`identity` section missing — both attach surfaces refuse every caller without it; give it an `allow:` list of tailscale logins (see docs/adr/0003)')
  }
  if (!Array.isArray(id.allow) || !id.allow.length) {
    fail(file, 'identity.allow must be a non-empty list of tailscale logins (the `Tailscale-User-Login` Serve stamps on a request, e.g. someone@example.com)')
  }
  for (const login of id.allow) {
    if (typeof login !== 'string' || !login.trim()) {
      fail(file, `identity.allow: ${JSON.stringify(login)} is not a login string`)
    }
  }
  // Compared against a header value, which arrives in whatever case the
  // identity provider used. Normalized once here rather than at every request.
  id.allow = id.allow.map((l) => l.trim().toLowerCase())
  id.proxy_port = id.proxy_port ?? 7682
  if (!(Number.isInteger(id.proxy_port) && id.proxy_port > 0 && id.proxy_port < 65536)) {
    fail(file, 'identity.proxy_port must be a port number')
  }
  cfg.identity = id

  // Five ports, one box: any collision means one surface silently shadows or
  // sweeps another, so all of them must be pairwise distinct.
  const ports = [
    ['attach.ttyd_port', a.ttyd_port], ['attach.serve_port', a.serve_port],
    ['identity.proxy_port', id.proxy_port],
    ['timeline.port', t.port], ['timeline.serve_port', t.serve_port],
  ]
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      if (ports[i][1] === ports[j][1]) {
        fail(file, `${ports[i][0]} and ${ports[j][0]} are both ${ports[i][1]} — every surface needs its own port`)
      }
    }
  }
  cfg.timeline = t

  // Preview port range (#40/#8). Optional with defaults — an existing config
  // predating previews must still boot — but validated hard when present, and
  // the range must not swallow the attach or timeline ports: sweeping it would
  // take that surface down tailnet-wide on the next reconcile.
  const p = cfg.preview ?? {}
  if (typeof p !== 'object') fail(file, '`preview` must be a mapping')
  const range = { from: p.port_from ?? DEFAULT_PREVIEW_RANGE.from, to: p.port_to ?? DEFAULT_PREVIEW_RANGE.to }
  for (const [key, v] of [['port_from', range.from], ['port_to', range.to]]) {
    if (!(Number.isInteger(v) && v > 0 && v < 65536)) fail(file, `preview.${key} must be a port number`)
  }
  if (range.to < range.from) fail(file, `preview.port_to (${range.to}) must not be below preview.port_from (${range.from})`)
  for (const [name, port] of ports) {
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

  // Status-line meters (#146). Only the anthropic account bars are switchable,
  // because only they leave the box: the model, the effort and the context %
  // are computed from the daemon's own records and the worker's own transcript.
  // Turning this off keeps the reading the CLI already cached on disk and stops
  // the daemon refreshing it — the bars then age instead of vanishing.
  const u = cfg.usage ?? {}
  if (typeof u !== 'object' || Array.isArray(u)) fail(file, '`usage` must be a mapping')
  if (u.account_bars !== undefined && typeof u.account_bars !== 'boolean') {
    fail(file, 'usage.account_bars must be true or false')
  }
  if (u.probe_model !== undefined && (typeof u.probe_model !== 'string' || !u.probe_model.trim())) {
    fail(file, 'usage.probe_model must be a model name')
  }
  cfg.usage = { account_bars: u.account_bars ?? true, probe_model: u.probe_model ?? PROBE_MODEL }

  // The worker sandbox image (#154, from #148). The section as a whole is
  // OPTIONAL, because the sandbox ships behind a per-backend switch that is
  // off by default and a box running no containers needs no pins. Every key
  // inside it is REQUIRED, for the reason #57 gives: the value silence would
  // pick here is "whatever npm serves this minute", which is a worker running
  // an unreviewed CLI. There is no safe default for a pin.
  if (cfg.sandbox !== undefined) {
    const sb = cfg.sandbox
    if (!sb || typeof sb !== 'object' || Array.isArray(sb)) fail(file, '`sandbox` must be a mapping')
    sb.image = sb.image ?? DEFAULT_IMAGE
    if (typeof sb.image !== 'string' || !IMAGE_NAME_RE.test(sb.image)) {
      fail(file, `sandbox.image must be a docker repository name (got ${JSON.stringify(sb.image)})`)
    }
    for (const key of Object.keys(SANDBOX_KEYS)) {
      if (key === 'agent_uid') continue
      // YAML reads `1.62` as a number and `1.62.1` as a string, and both are
      // plausible things to type on a version line — so a number is coerced
      // rather than refused, and only an empty or exotic value fails.
      if (typeof sb[key] === 'number') sb[key] = String(sb[key])
      if (typeof sb[key] !== 'string' || !VERSION_RE.test(sb[key])) {
        fail(file, `sandbox.${key} must be a pinned version string, e.g. "1.2.3" (got ${JSON.stringify(sb[key])})`)
      }
    }
    // Not cosmetic: the container writes the clone the daemon prepared on the
    // host, so a uid that is not the host user's makes every worker fail on
    // its first write. Defaulted to the daemon's own uid, which is the only
    // value that can be right by construction.
    sb.agent_uid = sb.agent_uid ?? process.getuid?.()
    if (!(Number.isInteger(sb.agent_uid) && sb.agent_uid >= 0 && sb.agent_uid < 2 ** 31)) {
      fail(file, `sandbox.agent_uid must be a uid (got ${JSON.stringify(sb.agent_uid)})`)
    }
    if (!fs.existsSync(DOCKERFILE)) {
      fail(file, `sandbox is configured but ${DOCKERFILE} is missing — the image has no recipe`)
    }
    cfg.sandbox = sb
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
    if (!LIMIT_PATTERNS[m.provider]) {
      // A provider with no usage-limit vocabulary would spawn workers whose cap
      // hits are invisible: parseUsageLimit returns null for it, so the model
      // never cools and every dispatch on it burns a claim into a ready-timeout.
      // Adding a provider is a code change (the phrasings are classifiers, not
      // settings), so refusing here names that.
      fail(file, `models.${name}.provider "${m.provider}" has no usage-limit vocabulary in routing.mjs — known providers: ${Object.keys(LIMIT_PATTERNS).join(', ')}`)
    }
    // Optional CLI-facing model name. It is substituted into a shell template,
    // so it passes the same whitelist buildSpawnCmd asserts at spawn — failing
    // at boot naming the key beats failing at dispatch with a claim already taken.
    if (m.id !== undefined && (typeof m.id !== 'string' || !SAFE_SUBSTITUTION.test(m.id))) {
      fail(file, `models.${name}.id must be a quote-free model name (got ${JSON.stringify(m.id)})`)
    }
    // Checked against the union across models, not per model: which efforts a
    // model accepts is the model's business (gpt-5.6 adds `max` and `ultra`,
    // gpt-5.5 has neither) and a stale list here would refuse a valid config.
    // This catches the typo, which is the failure worth catching at boot.
    if (m.reasoning_effort !== undefined && !REASONING_EFFORTS.includes(m.reasoning_effort)) {
      fail(file, `models.${name}.reasoning_effort must be one of ${REASONING_EFFORTS.join('|')} (got ${JSON.stringify(m.reasoning_effort)})`)
    }
    // Optional (#146), and since #178 the LAST resort for the status line's
    // context %: the transcript's own window wins, then the live
    // `GET /v1/models/<id>` lookup, then this. Omitting it everywhere is the
    // normal case — a hand-written denominator is the thing #178 found wrong,
    // and no figure at all beats a confident wrong percentage.
    if (m.context_window !== undefined
      && (!Number.isInteger(m.context_window) || m.context_window <= 0)) {
      fail(file, `models.${name}.context_window must be a positive integer of tokens (got ${JSON.stringify(m.context_window)})`)
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
    if (!HARNESS_BACKENDS.includes(name)) {
      fail(file, `backends.${name} has no harness in workspace.mjs — a worker under it would get no config dir, no curia tools and no Stop hook. Known harnesses: ${HARNESS_BACKENDS.join(', ')}`)
    }
    // The readiness marker is per backend and REQUIRED, not defaulted (#57's
    // precedent: silence by omission is the failure this refuses). #33 lost
    // readiness live to a marker that matched nothing, and the symptom was
    // silence — no worker_ready, and reactive cooling that could never fire.
    if (typeof b.ready !== 'string' || !b.ready.trim()) {
      fail(file, `backends.${name} needs a \`ready\` regex — the pane text that says this backend reached its composer`)
    }
    try {
      b.readyRe = new RegExp(b.ready)
    } catch (e) {
      fail(file, `backends.${name}.ready is not a valid regex: ${e.message}`)
    }
  }
  for (const [name, m] of Object.entries(cfg.models)) {
    if (!cfg.backends[m.backend]) fail(file, `models.${name}.backend names unknown backend "${m.backend}"`)
  }

  return cfg
}

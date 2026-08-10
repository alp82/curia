// Config loading + validation (#33). Both YAML files are hand-edited, so this
// is a trust boundary: malformed config throws with a message naming the file
// and the key, and the daemon refuses to boot rather than limping.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { DEFAULT_RANGE as DEFAULT_PREVIEW_RANGE, DEFAULT_PROXY_FROM } from './preview.mjs'
import { DEFAULT_SKILLS, defaultSkillsRoot, HARNESS_NAMES } from './workspace.mjs'
import { LIMIT_PATTERNS, SAFE_SUBSTITUTION } from './routing.mjs'
import { DEFAULT_INDEX, REBUILD_CMD } from './attach.mjs'
import { PROBE_MODEL } from './usage.mjs'
import { DEFAULT_TIMELINE_INDEX } from './timeline.mjs'
import { DEFAULT_IMAGE, DOCKERFILE, SANDBOX_KEYS } from './image.mjs'
import { DEFAULT_CONTAINER_PORTS, PORTS_PER_AGENT } from './sandbox.mjs'
import { readAllow } from './identity.mjs'
import { readDashboard } from './dashboard.mjs'

const WATCH_MODES = ['auto', 'map', 'ready-for-agent']

// Every reasoning effort any configured model accepts, unioned.
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

// A plain directory name and nothing else. The file is hand-edited, so this
// also refuses "..", "a/b" and any other way of pointing the agent's skills
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
  // with their agent. A yaml still carrying the key loads fine; it is ignored.
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
  // The rule and the normalization live in identity.mjs beside the predicate
  // that compares against the list: the dashboard sidecar (#263) reads the same
  // key out of the same file, and one definition is what keeps the two
  // processes admitting the same people.
  id.allow = readAllow(id, (msg) => fail(file, msg))
  id.proxy_port = id.proxy_port ?? 7682
  if (!(Number.isInteger(id.proxy_port) && id.proxy_port > 0 && id.proxy_port < 65536)) {
    fail(file, 'identity.proxy_port must be a port number')
  }
  // #168: the base of the preview identity-proxy block, paired index-for-index
  // with the preview range so the preview on 8501 proxies through 7701. One key
  // rather than a range, because the width is the preview range's width and two
  // keys that must agree are two ways to write one fact.
  id.preview_proxy_from = id.preview_proxy_from ?? DEFAULT_PROXY_FROM
  if (!(Number.isInteger(id.preview_proxy_from) && id.preview_proxy_from > 0 && id.preview_proxy_from < 65536)) {
    fail(file, 'identity.preview_proxy_from must be a port number')
  }
  cfg.identity = id

  // The dashboard sidecar (#263, from the where-it-lives decision #249). The
  // daemon does not host it and never binds these ports — but it validates the
  // block and refuses to boot on a bad shape, because the two ports below join
  // the collision check and `previews.reserved`, and a sidecar port that
  // shadowed a daemon surface would be discovered as an outage rather than as a
  // config error. The shape rules live in dashboard.mjs, where the sidecar
  // reads them out of this same file.
  //
  // The PAGE is not checked here, unlike attach.index and timeline.index: the
  // daemon does not serve it, and the sidecar's own filesystem is the only one
  // whose answer would mean anything.
  const dash = readDashboard(cfg, (msg) => fail(file, msg), file)
  cfg.dashboard = dash

  // Seven ports, one box: any collision means one surface silently shadows or
  // sweeps another, so all of them must be pairwise distinct.
  const ports = [
    ['attach.ttyd_port', a.ttyd_port], ['attach.serve_port', a.serve_port],
    ['identity.proxy_port', id.proxy_port],
    ['timeline.port', t.port], ['timeline.serve_port', t.serve_port],
    ['dashboard.port', dash.port], ['dashboard.serve_port', dash.serve_port],
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

  // #168: the derived proxy block. Its width is the preview range's width, and
  // it gets the same treatment the preview range just got, in both directions.
  // A collision here is the quiet kind — the daemon would boot, and the fault
  // would surface as one preview refusing every caller because its proxy bound
  // a port another surface already owned.
  const proxyBlock = { from: id.preview_proxy_from, to: id.preview_proxy_from + (range.to - range.from) }
  if (proxyBlock.to > 65535) {
    fail(file, `identity.preview_proxy_from (${proxyBlock.from}) plus the preview range's width runs past port 65535 — the block is one port per preview port`)
  }
  for (const [name, port] of ports) {
    if (port >= proxyBlock.from && port <= proxyBlock.to) {
      fail(file, `the preview identity-proxy block ${proxyBlock.from}-${proxyBlock.to} contains ${name} (${port}) — a preview proxy would bind over it`)
    }
  }
  if (!(proxyBlock.to < range.from || proxyBlock.from > range.to)) {
    fail(file, `the preview identity-proxy block ${proxyBlock.from}-${proxyBlock.to} overlaps the preview range ${range.from}-${range.to} — the first is loopback, the second is tailnet-facing`)
  }
  cfg.identity.preview_proxy_block = proxyBlock

  // Agent skill set (#57). Optional section with defaults, but validated the
  // same either way: the daemon refuses to boot naming the missing skill
  // rather than dispatching an agent that silently lacks one. Only an
  // explicitly empty `install:` opts out — silence by omission is the failure
  // this section exists to end, so omission takes the full default list.
  const s = cfg.skills ?? {}
  if (typeof s !== 'object' || Array.isArray(s)) fail(file, '`skills` must be a mapping')
  if (s.root !== undefined && typeof s.root !== 'string') fail(file, 'skills.root must be a path')
  // #268: a RELATIVE root resolves off this file's own directory, the rule
  // `attach.index` and `timeline.index` already follow. curia vendors the
  // skill tree beside the config, so `../skills` reads the same on the
  // operator's box, inside the daemon container and in the suite — where an
  // absolute /home/alp path names a directory that is only on one machine.
  // An absolute root and a leading `~` both still win, because `path.resolve`
  // returns an absolute second argument unchanged.
  const skillsRoot = s.root === undefined
    ? defaultSkillsRoot()
    : path.resolve(path.dirname(path.resolve(file)), expandHome(s.root))
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
  // are computed from the daemon's own records and the agent's own transcript.
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

  // The agent sandbox image (#154, from #148). The section is REQUIRED since
  // #195 retired the bare tmux path: every agent runs in a container, so a
  // daemon with no image and no pins can dispatch nothing. It used to be
  // optional, because the sandbox shipped behind a per-harness switch that was
  // off by default. That switch is gone.
  //
  // Every key inside it is required too, for the reason #57 gives: the value
  // silence would pick here is "whatever npm serves this minute", which is an
  // agent running an unreviewed CLI. There is no safe default for a pin.
  {
    if (cfg.sandbox === undefined) {
      fail(file, 'the `sandbox:` section is required — every agent runs in a container (#195), and a container has no image to run and no pins to build one from')
    }
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
    // host, so a uid that is not the host user's makes every agent fail on
    // its first write. Defaulted to the daemon's own uid, which is the only
    // value that can be right by construction.
    sb.agent_uid = sb.agent_uid ?? process.getuid?.()
    if (!(Number.isInteger(sb.agent_uid) && sb.agent_uid >= 0 && sb.agent_uid < 2 ** 31)) {
      fail(file, `sandbox.agent_uid must be a uid (got ${JSON.stringify(sb.agent_uid)})`)
    }
    if (!fs.existsSync(DOCKERFILE)) {
      fail(file, `sandbox is configured but ${DOCKERFILE} is missing — the image has no recipe`)
    }
    // The ports each container publishes on loopback (#156, from #148). Three
    // per agent, so the range has to hold `3 × max_concurrent` before every
    // slot can run sandboxed — checked here rather than discovered by the
    // dispatch that finds none free with a claim already taken.
    const sbRange = { from: sb.port_from ?? DEFAULT_CONTAINER_PORTS.from, to: sb.port_to ?? DEFAULT_CONTAINER_PORTS.to }
    for (const [key, v] of [['port_from', sbRange.from], ['port_to', sbRange.to]]) {
      if (!(Number.isInteger(v) && v > 0 && v < 65536)) fail(file, `sandbox.${key} must be a port number`)
    }
    if (sbRange.to < sbRange.from) fail(file, `sandbox.port_to (${sbRange.to}) must not be below sandbox.port_from (${sbRange.from})`)
    const need = PORTS_PER_AGENT * d.max_concurrent
    if (sbRange.to - sbRange.from + 1 < need) {
      fail(file, `sandbox ports ${sbRange.from}-${sbRange.to} hold ${sbRange.to - sbRange.from + 1} ports, and ${d.max_concurrent} concurrent agents publishing ${PORTS_PER_AGENT} each need ${need}`)
    }
    // Every other surface on this box is a port a container must never
    // shadow: publishing over the preview range would make `tailscale serve`
    // and docker fight for the same listener, and publishing over an attach
    // port would take that surface down.
    for (const [name, port] of [...ports, ['the daemon port', Number(process.env.PORT ?? 4271)]]) {
      if (port >= sbRange.from && port <= sbRange.to) {
        fail(file, `sandbox port range ${sbRange.from}-${sbRange.to} contains ${name} (${port}) — a container would publish over it`)
      }
    }
    if (!(sbRange.to < range.from || sbRange.from > range.to)) {
      fail(file, `sandbox port range ${sbRange.from}-${sbRange.to} overlaps the preview range ${range.from}-${range.to}`)
    }
    // #168: a container publishing over a preview proxy port would take the gate
    // in front of some other agent's preview, which is the un-gated dev server
    // this block exists to stop.
    if (!(sbRange.to < proxyBlock.from || sbRange.from > proxyBlock.to)) {
      fail(file, `sandbox port range ${sbRange.from}-${sbRange.to} overlaps the preview identity-proxy block ${proxyBlock.from}-${proxyBlock.to}`)
    }
    sb.ports = sbRange
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
    if (!m || typeof m.provider !== 'string' || typeof m.harness !== 'string') {
      fail(file, `models.${name} needs \`provider\` and \`harness\``)
    }
    if (!LIMIT_PATTERNS[m.provider]) {
      // A provider with no usage-limit vocabulary would spawn agents whose cap
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

  // The cross-check pairing (#164, ADR-0010): which model reads a builder's
  // diff. Keyed by the BUILDER's provider, and the value must run on another
  // one — a row that pairs a provider with itself is not a cross-check, and it
  // would silently turn the whole feature into a same-provider reading.
  //
  // The section is optional, because a box watching one provider has no pairing
  // to state. A provider with no row refuses the cross-check at spawn time
  // naming this key, which is the same failure direction as an unknown model.
  cfg.review = cfg.review ?? {}
  if (typeof cfg.review !== 'object' || Array.isArray(cfg.review)) {
    fail(file, '`review` must be a mapping of provider → model')
  }
  const providers = new Set(Object.values(cfg.models).map((m) => m.provider))
  for (const [provider, model] of Object.entries(cfg.review)) {
    if (!providers.has(provider)) {
      fail(file, `review.${provider} names a provider no configured model runs on — configured providers: ${[...providers].join(', ')}`)
    }
    if (!cfg.models[model]) fail(file, `review.${provider} names unknown model "${model}"`)
    if (cfg.models[model].provider === provider) {
      fail(file, `review.${provider} names "${model}", which runs on ${provider} itself — a cross-check reads the diff on the OTHER provider`)
    }
  }

  cfg.fallbacks = cfg.fallbacks ?? {}
  for (const [from, chain] of Object.entries(cfg.fallbacks)) {
    if (!cfg.models[from]) fail(file, `fallbacks.${from} names unknown model "${from}"`)
    if (!Array.isArray(chain)) fail(file, `fallbacks.${from} must be a list`)
    for (const to of chain) {
      if (!cfg.models[to]) fail(file, `fallbacks.${from} names unknown model "${to}"`)
    }
  }

  if (!cfg.harnesses || typeof cfg.harnesses !== 'object' || !Object.keys(cfg.harnesses).length) {
    fail(file, '`harnesses` must be a non-empty map')
  }
  for (const [name, b] of Object.entries(cfg.harnesses)) {
    if (!b || typeof b.template !== 'string') fail(file, `harnesses.${name} needs a \`template\` string`)
    for (const ph of ['{model}', '{prompt_file}']) {
      if (!b.template.includes(ph)) fail(file, `harnesses.${name}.template is missing the ${ph} placeholder`)
    }
    if (!HARNESS_NAMES.includes(name)) {
      fail(file, `harnesses.${name} has no entry in the HARNESS table in workspace.mjs — an agent under it would get no config dir, no curia tools and no Stop hook. Known harnesses: ${HARNESS_NAMES.join(', ')}`)
    }
    // The readiness marker is per harness and REQUIRED, not defaulted (#57's
    // precedent: silence by omission is the failure this refuses). #33 lost
    // readiness live to a marker that matched nothing, and the symptom was
    // silence — no agent_ready, and reactive cooling that could never fire.
    if (typeof b.ready !== 'string' || !b.ready.trim()) {
      fail(file, `harnesses.${name} needs a \`ready\` regex — the pane text that says this harness reached its composer`)
    }
    try {
      b.readyRe = new RegExp(b.ready)
    } catch (e) {
      fail(file, `harnesses.${name}.ready is not a valid regex: ${e.message}`)
    }
    // How long after the composer marker an agent may stay silent on `/mcp`
    // before curia calls it mute (#194). Per harness, because it is a property
    // of the CLI's startup and not of curia: only the WINDOW is per harness, the
    // detector is the same route for both.
    //
    // Required, no default, for the reason `ready` is: a number nobody measured
    // reads exactly like a number somebody did, and the failure it buys is
    // either a healthy agent killed or a mute one left running.
    if (typeof b.tool_channel_grace_s !== 'number' || !(b.tool_channel_grace_s > 0)) {
      fail(file, `harnesses.${name} needs a positive \`tool_channel_grace_s\` — how long after the composer marker an agent may send no /mcp request before curia treats it as having no tool channel`)
    }
    b.toolChannelGraceS = b.tool_channel_grace_s
    // The container command is single-quoted inside the pane's shell (see
    // sandbox.mjs), which is what keeps `$(cat <prompt>)` expanding INSIDE the
    // container. A template carrying its own single quote breaks that, and the
    // failure would be an agent whose command line came apart at spawn.
    //
    // Unconditional since #195. It used to fire only for a harness switched to
    // `sandbox: docker`, and it named `sandbox: none` as the way out. Every
    // harness runs in a container now, so there is no way out and no switch to
    // read: a template with a single quote in it is simply invalid.
    if (b.template.includes("'")) {
      fail(file, `harnesses.${name}.template carries a single quote, which the docker command cannot nest — rewrite it without one`)
    }
  }
  for (const [name, m] of Object.entries(cfg.models)) {
    if (!cfg.harnesses[m.harness]) fail(file, `models.${name}.harness names unknown harness "${m.harness}"`)
  }

  return cfg
}


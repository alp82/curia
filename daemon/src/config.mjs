// Config loading + validation (#33). Both YAML files are hand-edited, so this
// is a trust boundary: malformed config throws with a message naming the file
// and the key, and the daemon refuses to boot rather than limping.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { DEFAULT_RANGE as DEFAULT_PREVIEW_RANGE, DEFAULT_PROXY_FROM } from './preview.mjs'
import { DEFAULT_SKILLS, defaultSkillsRoot } from './workspace.mjs'
import {
  LIMIT_PATTERNS, REASONING_EFFORTS, SAFE_SUBSTITUTION, harnessReasoningEffort,
} from './routing.mjs'
import { DEFAULT_INDEX, REBUILD_CMD } from './attach.mjs'
import { PROBE_MODEL } from './usage.mjs'
import { DEFAULT_CLI_VERSION, DEFAULT_INTERVAL_HOURS } from './aistack.mjs'
import { DEFAULT_TIMELINE_INDEX } from './timeline.mjs'
import { DEFAULT_IMAGE, DOCKERFILE, SANDBOX_KEYS } from './image.mjs'
import { DEFAULT_CONTAINER_PORTS, PORTS_PER_AGENT } from './sandbox.mjs'
import { readAllow } from './identity.mjs'
import { readDashboard } from './dashboard.mjs'
import { readOverseer } from './overseerservice.mjs'
import { CONSUMER_NAMES, consumerContractFault, providerContractFault } from './credentials.mjs'
import { HARNESS_REGISTRY } from './harnesses.mjs'
import {
  WATCH_MODES as OPERATOR_WATCH_MODES, readOperatorConfig, validateOperatorConfig,
} from '../../cli/src/config.mjs'

// The legal watch modes come from the operator configuration contract (#866),
// which the settings screen writes through. Re-exported here so the daemon's
// own callers keep one name for one list.
export const WATCH_MODES = OPERATOR_WATCH_MODES

// ---------------------------------------------------------------------------
// the operator configuration (#866)
// ---------------------------------------------------------------------------
//
// `config/config.yaml`, beside `curia.yaml`, holds operator intent: the
// concurrency, the dispatch switches, the pane cap, and the watch list. It is
// the file the operator edits by hand, the app saves, and `curia install`
// writes. One module reads, validates, and writes it in every process
// (`cli/src/config.mjs`), so the daemon, the app, and the lifecycle interface
// cannot disagree about what the file means or what a refusal says.
//
// Its keys win over `curia.yaml` and over the hand override beside it. A key
// the file leaves out keeps the shipped answer, so a source checkout without
// the file runs exactly as before. An invalid file refuses the boot with the
// contract's own message, which names the path, the line, the key, and the
// rule. Nothing here falls back to an older copy: the running daemon keeps
// what it loaded, and the next boot reads what is on disk.
export const operatorConfigFile = (file) => path.join(path.dirname(file), 'config.yaml')

// Lays a validated operator configuration over the merged `curia.yaml`
// shape, before the rules below judge the whole.
function applyOperatorConfig(cfg, op) {
  if (!op) return
  const d = cfg.dispatch && typeof cfg.dispatch === 'object' ? cfg.dispatch : (cfg.dispatch = {})
  for (const key of ['max_concurrent', 'auto_dispatch', 'poll_interval_s', 'prototype_variations', 'messages_per_send']) {
    if (op[key] !== undefined) d[key] = op[key]
  }
  if (op.live_pane_cap !== undefined) {
    cfg.overseer = { ...(cfg.overseer && typeof cfg.overseer === 'object' ? cfg.overseer : {}), live_pane_cap: op.live_pane_cap }
  }
  if (op.watch !== undefined) cfg.watch = op.watch.map((w) => ({ repo: w.repo, mode: w.mode }))
}

// A GitHub login as GitHub itself allows one: letters, digits and single
// hyphens, no hyphen at either end, 39 characters at most. The whole point of
// checking it here is that the value goes on a `gh issue edit --add-assignee`,
// and a typo there fails every claim on the box with a 422 nobody can place.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

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

// `src` names the layer or layers a refusal came out of: one path when the box
// runs the tracked file alone, and `base + override` when it does not (#292).
function fail(src, msg) {
  throw new Error(`bad config ${src}: ${msg}`)
}

// YAML has no tilde expansion, and `~/.claude/skills` is how a human writes
// this path.
function expandHome(p) {
  if (p === '~') return os.homedir()
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

// ---------------------------------------------------------------------------
// the two layers (#292)
// ---------------------------------------------------------------------------
//
// Git tracks `curia.yaml` and `routing.yaml`, and the dashboard writes the
// settings the operator touches most. Those two facts collided: a save left the
// box's checkout dirty, `git merge --ff-only` refuses to overwrite a local
// change, and the deploy's own rollback (`git reset --hard`) would then discard
// the save without saying so.
//
// So each tracked file is now a BASE, and this box's own answers live in
// `<name>.local.yaml` beside it, which `.gitignore` holds out of the checkout.
// The dashboard writes only the local file. `git status` on the box is clean on
// an ordinary day, and dirty means one thing: somebody hand-edited a tracked
// file there.
//
// A layer rather than a copy, on purpose. A ticket that ships a NEW key — the
// `dashboard:` block, the `sandbox:` pins — reaches the box in the base file
// with the code that needs it. A copy would leave the box booting on a config
// that predates every one of them.
//
// THE MERGE RULE IS ONE SENTENCE: a mapping merges key by key, and anything
// else replaces. So `dispatch.max_concurrent` overrides one number and leaves
// the section, and `watch:` overrides the whole list — a list of repos has no
// per-item identity a merge could key on, and half a watch list is not a
// watch list.
export const localConfigFile = (file) => path.join(
  path.dirname(file), `${path.basename(file, '.yaml')}.local.yaml`,
)

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function mergeLayers(base, over) {
  if (!isMapping(base) || !isMapping(over)) return over
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in base ? mergeLayers(base[key], value) : value
  }
  return out
}

// Read a config file and the overrides beside it. `localFile` names the
// override explicitly — the settings screen validates a CANDIDATE that way, and
// `null` reads the base alone. A missing override file is the ordinary case,
// not an error: a box that has never saved from the dashboard has none.
export function readLayered(file, { localFile } = {}) {
  const base = parse(fs.readFileSync(file, 'utf8'))
  const local = localFile === undefined ? localConfigFile(file) : localFile
  if (!local || !fs.existsSync(local)) return { data: base, localFile: null }
  const over = parse(fs.readFileSync(local, 'utf8'))
  // An empty override file — comments only, or nothing — is `null`, and it
  // overrides nothing. Anything that is not a mapping is a mistake worth
  // refusing by name: a list here would replace the whole config.
  if (over === null) return { data: base, localFile: local }
  if (!isMapping(over)) fail(local, 'the override file must be a mapping of the keys it overrides')
  return { data: mergeLayers(base, over), localFile: local }
}

// What the daemon says at boot about the overrides it read, so the second file
// is never invisible to somebody reading the first one. Null when there is none.
export function overrideSummary(file) {
  const local = localConfigFile(file)
  if (!fs.existsSync(local)) return null
  const over = parse(fs.readFileSync(local, 'utf8'))
  return { file: local, keys: isMapping(over) ? Object.keys(over) : [] }
}

// `checkPaths` is the one thing a caller may turn off, and only one caller does
// (#265). Four rules below ask the FILESYSTEM whether a path is there: the
// attach page, the timeline page, every installed skill's manifest, and the
// agent Dockerfile. Those are the daemon's own files, and the daemon boots with
// this on.
//
// The dashboard sidecar validates a candidate config with this same function
// before it writes it, because a settings screen that invented a second set of
// rules would be a second config validator free to disagree with the one that
// decides whether the daemon boots. But the sidecar's container mounts none of
// those four paths (#263's mount list is what makes it secret-free), so an
// existence check there is evidence about the wrong filesystem — it would
// refuse every save on this box for a file the daemon reads happily.
//
// Nothing the settings screen writes can reach those four keys, so what is
// skipped is exactly what the sidecar cannot see and cannot change. Every other
// rule — the shapes, the ports, the collisions, `3 × max_concurrent` against
// the sandbox range — runs in both processes, unchanged.
//
// `operator` is the operator configuration (#866): left out, the loader reads
// `config.yaml` beside `file` and takes none when there is no file; `null`
// reads the shipped layers alone; an object is a candidate the app judges
// before it writes, validated here by the contract's own rules first.
export function loadCuriaConfig(file, { checkPaths = true, localFile, env = process.env, operator } = {}) {
  const layers = readLayered(file, { localFile })
  const cfg = layers.data
  const operatorFile = operatorConfigFile(file)
  const op = operator === undefined ? readOperatorConfig(operatorFile) : (operator === null ? null : validateOperatorConfig(operator))
  // What a refusal names. A merged config has two authors, so a message that
  // named the tracked file alone would send the operator to edit a line that is
  // no longer the one running.
  const src = [file, layers.localFile, op ? operatorFile : null].filter(Boolean).join(' + ')
  if (!cfg || typeof cfg !== 'object') fail(src, 'not a mapping')
  applyOperatorConfig(cfg, op)

  if (!Array.isArray(cfg.watch) || !cfg.watch.length) fail(src, '`watch` must be a non-empty list')
  for (const entry of cfg.watch) {
    if (!entry || typeof entry.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(entry.repo)) {
      fail(src, `watch entry needs a \`repo: owner/name\` (got ${JSON.stringify(entry)})`)
    }
    entry.mode = entry.mode ?? 'auto'
    if (!WATCH_MODES.includes(entry.mode)) {
      fail(src, `watch ${entry.repo}: mode must be one of ${WATCH_MODES.join('|')} (got "${entry.mode}")`)
    }
  }

  const d = cfg.dispatch
  if (!d || typeof d !== 'object') fail(src, '`dispatch` section missing')
  if (typeof d.auto_dispatch !== 'boolean') fail(src, 'dispatch.auto_dispatch must be a boolean')
  // Older tracked configs take the shipped prototype-round default until the
  // next deploy adds the settings row to their file.
  d.prototype_variations = d.prototype_variations ?? 5
  if (!Number.isInteger(d.prototype_variations) || d.prototype_variations <= 0) {
    fail(src, 'dispatch.prototype_variations must be a positive integer')
  }
  d.messages_per_send = d.messages_per_send ?? 4
  if (!Number.isInteger(d.messages_per_send) || d.messages_per_send < 1 || d.messages_per_send > 4) {
    fail(src, 'dispatch.messages_per_send must be an integer from 1 through 4')
  }
  // stop_nudge_budget (#54 item 4) is optional with a default so a config
  // predating the merge-gated ending still boots. It must be > 0: a budget of
  // zero would disable the Stop-hook enforcement silently, and turning the
  // enforcement off is not a thing a number should express by accident.
  d.stop_nudge_budget = d.stop_nudge_budget ?? 3
  // confirm_ttl_h is gone (#94): confirms have no expiry clock — they lapse
  // with their agent. A yaml still carrying the key loads fine; it is ignored.
  for (const key of ['max_concurrent', 'poll_interval_s', 'ready_timeout_s', 'stop_nudge_budget']) {
    if (!(typeof d[key] === 'number' && d[key] > 0)) fail(src, `dispatch.${key} must be a positive number`)
  }
  if (typeof d.workspace_root !== 'string' || !path.isAbsolute(d.workspace_root)) {
    fail(src, 'dispatch.workspace_root must be an absolute path')
  }
  // THE WORKSPACE ROOT IS WRITTEN DOWN TWICE (#473). This key says where the
  // daemon writes its worktrees. `CURIA_WORKSPACE_ROOT` in `deploy/.env` says
  // which host tree compose mounts, and compose hands that same value back to
  // every container that reads this file.
  //
  // A disagreement is the one mount failure nothing else would notice: the
  // daemon writes worktrees at a path no mount covers, so they land inside the
  // container, the host tree stays empty, and a recreate throws the lot away.
  // No error, no missing file, no log line. So it refuses the boot instead.
  //
  // The variable is absent outside compose — a dev run, the suite — and then
  // there is no second answer to check against.
  const mounted = env.CURIA_WORKSPACE_ROOT
  if (mounted && path.resolve(mounted) !== path.resolve(d.workspace_root)) {
    fail(src, `dispatch.workspace_root is ${d.workspace_root}, but compose mounts ${mounted} (CURIA_WORKSPACE_ROOT in deploy/.env) — worktrees would be written inside the container and lost on the next recreate`)
  }
  // Who a claim assigns (#390, ADR-0018). A claim is an issue assignee, and
  // GitHub does not let an App be one — so the daemon calls as `curia-sh[bot]`
  // and names a real user here. It used to read `gh api user`, which answers
  // nothing under an installation token.
  //
  // REQUIRED, with no default. Every other name for the operator is a guess:
  // the host `gh` login is the credential this ticket takes the daemon off, and
  // a daemon that guessed wrong would claim tickets in a stranger's name or
  // fail every claim with a 422. A missing key refuses the boot and says which
  // key it is, which costs one line in the config and nothing else.
  if (typeof d.claim_login !== 'string' || !GITHUB_LOGIN_RE.test(d.claim_login)) {
    fail(src, 'dispatch.claim_login must be a GitHub login — the user a claim assigns, because a GitHub App cannot be an assignee')
  }

  const a = cfg.attach
  if (!a || typeof a !== 'object') fail(src, '`attach` section missing')
  // `serve_port` retired with #714: Curia app serves the terminal on its own
  // address, and the only thing the daemon does with this port is withdraw
  // the standalone rule an older daemon asserted. Optional with the port that
  // rule always used, so a config that drops the line still withdraws it. It
  // stays in the collision check, because withdrawing a port another surface
  // is published on would take that surface down.
  a.serve_port = a.serve_port ?? 8443
  for (const key of ['ttyd_port', 'serve_port']) {
    if (!(Number.isInteger(a[key]) && a[key] > 0 && a[key] < 65536)) fail(src, `attach.${key} must be a port number`)
  }
  // The attach page (#70, landing #69's variant A). Optional with a default,
  // which #57's "silence by omission is the failure" rule does NOT argue
  // against here: omitting `skills.install` would have meant installing no
  // skills — a real loss expressed by silence — while omitting this means the
  // surface curia ships, which is the only value anyone wants. What it must
  // never do is resolve to a file that is not there, so it is checked at boot,
  // naming the path and the command that builds it.
  if (a.index !== undefined && typeof a.index !== 'string') fail(src, 'attach.index must be a path')
  // Relative to THIS file's directory, so the shipped config can name the
  // asset portably instead of carrying one box's absolute path.
  a.index = a.index === undefined
    ? DEFAULT_INDEX
    : path.resolve(path.dirname(path.resolve(file)), expandHome(a.index))
  if (checkPaths && !fs.existsSync(a.index)) {
    fail(src, `attach.index resolves to ${a.index}, which does not exist — build it with \`${REBUILD_CMD}\``)
  }

  // The timeline surface (#74, landing #73's pick). Optional with defaults for
  // the same reason attach.index is: omitting it means the surface curia
  // ships, which is the only value anyone wants. Validated hard either way,
  // and the page must exist at boot — the same refusal attach.index gets.
  const t = cfg.timeline ?? {}
  if (typeof t !== 'object' || Array.isArray(t)) fail(src, '`timeline` must be a mapping')
  t.port = t.port ?? 4272
  t.serve_port = t.serve_port ?? 8444
  for (const key of ['port', 'serve_port']) {
    if (!(Number.isInteger(t[key]) && t[key] > 0 && t[key] < 65536)) fail(src, `timeline.${key} must be a port number`)
  }
  if (t.index !== undefined && typeof t.index !== 'string') fail(src, 'timeline.index must be a path')
  t.index = t.index === undefined
    ? DEFAULT_TIMELINE_INDEX
    : path.resolve(path.dirname(path.resolve(file)), expandHome(t.index))
  if (checkPaths && !fs.existsSync(t.index)) {
    fail(src, `timeline.index resolves to ${t.index}, which does not exist — it ships committed in daemon/assets/`)
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
  id.allow = readAllow(id, (msg) => fail(src, msg))
  id.proxy_port = id.proxy_port ?? 7682
  if (!(Number.isInteger(id.proxy_port) && id.proxy_port > 0 && id.proxy_port < 65536)) {
    fail(src, 'identity.proxy_port must be a port number')
  }
  // #168: the base of the preview identity-proxy block, paired index-for-index
  // with the preview range so the preview on 8501 proxies through 7701. One key
  // rather than a range, because the width is the preview range's width and two
  // keys that must agree are two ways to write one fact.
  id.preview_proxy_from = id.preview_proxy_from ?? DEFAULT_PROXY_FROM
  if (!(Number.isInteger(id.preview_proxy_from) && id.preview_proxy_from > 0 && id.preview_proxy_from < 65536)) {
    fail(src, 'identity.preview_proxy_from must be a port number')
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
  const dash = readDashboard(cfg, (msg) => fail(src, msg), file)
  cfg.dashboard = dash

  // The overseer container (#327, ADR-0015). The daemon binds this port no more
  // than it binds the sidecar's: compose publishes it on loopback and the daemon
  // health-checks it. It is validated and collision-checked here for the same
  // reason the sidecar's ports are — a surface shadowing another is found as an
  // outage rather than as a config error.
  const over = readOverseer(cfg, (msg) => fail(src, msg))
  cfg.overseer = over

  // Eight ports, one box: any collision means one surface silently shadows or
  // sweeps another, so all of them must be pairwise distinct.
  const ports = [
    ['attach.ttyd_port', a.ttyd_port], ['attach.serve_port', a.serve_port],
    ['identity.proxy_port', id.proxy_port],
    ['timeline.port', t.port], ['timeline.serve_port', t.serve_port],
    ['dashboard.port', dash.port], ['dashboard.serve_port', dash.serve_port],
    ['overseer.port', over.port],
  ]
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      if (ports[i][1] === ports[j][1]) {
        fail(src, `${ports[i][0]} and ${ports[j][0]} are both ${ports[i][1]} — every surface needs its own port`)
      }
    }
  }
  cfg.timeline = t

  // Preview port range (#40/#8). Optional with defaults — an existing config
  // predating previews must still boot — but validated hard when present, and
  // the range must not swallow the attach or timeline ports: sweeping it would
  // take that surface down tailnet-wide on the next reconcile.
  const p = cfg.preview ?? {}
  if (typeof p !== 'object') fail(src, '`preview` must be a mapping')
  const range = { from: p.port_from ?? DEFAULT_PREVIEW_RANGE.from, to: p.port_to ?? DEFAULT_PREVIEW_RANGE.to }
  for (const [key, v] of [['port_from', range.from], ['port_to', range.to]]) {
    if (!(Number.isInteger(v) && v > 0 && v < 65536)) fail(src, `preview.${key} must be a port number`)
  }
  if (range.to < range.from) fail(src, `preview.port_to (${range.to}) must not be below preview.port_from (${range.from})`)
  for (const [name, port] of ports) {
    if (port >= range.from && port <= range.to) {
      fail(src, `preview range ${range.from}-${range.to} contains ${name} (${port}) — the preview sweep would withdraw it`)
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
    fail(src, `identity.preview_proxy_from (${proxyBlock.from}) plus the preview range's width runs past port 65535 — the block is one port per preview port`)
  }
  for (const [name, port] of ports) {
    if (port >= proxyBlock.from && port <= proxyBlock.to) {
      fail(src, `the preview identity-proxy block ${proxyBlock.from}-${proxyBlock.to} contains ${name} (${port}) — a preview proxy would bind over it`)
    }
  }
  if (!(proxyBlock.to < range.from || proxyBlock.from > range.to)) {
    fail(src, `the preview identity-proxy block ${proxyBlock.from}-${proxyBlock.to} overlaps the preview range ${range.from}-${range.to} — the first is loopback, the second is tailnet-facing`)
  }
  cfg.identity.preview_proxy_block = proxyBlock

  // Agent skill set (#57). Optional section with defaults, but validated the
  // same either way: the daemon refuses to boot naming the missing skill
  // rather than dispatching an agent that silently lacks one. Only an
  // explicitly empty `install:` opts out — silence by omission is the failure
  // this section exists to end, so omission takes the full default list.
  const s = cfg.skills ?? {}
  if (typeof s !== 'object' || Array.isArray(s)) fail(src, '`skills` must be a mapping')
  if (s.root !== undefined && typeof s.root !== 'string') fail(src, 'skills.root must be a path')
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
  if (!Array.isArray(install)) fail(src, 'skills.install must be a list of skill names')
  for (const name of install) {
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name) || name === '.' || name === '..') {
      fail(src, `skills.install: ${JSON.stringify(name)} is not a plain skill name`)
    }
    const manifest = path.join(skillsRoot, name, 'SKILL.md')
    if (checkPaths && !fs.existsSync(manifest)) {
      fail(src, `skills.install names "${name}", but ${manifest} does not exist — install the skill or drop it from the list`)
    }
  }
  cfg.skills = { root: skillsRoot, install }

  // Status-line meters (#146). Only the anthropic account bars are switchable,
  // because only they leave the box: the model, the effort and the context %
  // are computed from the daemon's own records and the agent's own transcript.
  // Turning this off keeps the reading the CLI already cached on disk and stops
  // the daemon refreshing it — the bars then age instead of vanishing.
  const u = cfg.usage ?? {}
  if (typeof u !== 'object' || Array.isArray(u)) fail(src, '`usage` must be a mapping')
  if (u.account_bars !== undefined && typeof u.account_bars !== 'boolean') {
    fail(src, 'usage.account_bars must be true or false')
  }
  if (u.probe_model !== undefined && (typeof u.probe_model !== 'string' || !u.probe_model.trim())) {
    fail(src, 'usage.probe_model must be a model name')
  }
  cfg.usage = { account_bars: u.account_bars ?? true, probe_model: u.probe_model ?? PROBE_MODEL }

  // The recurring aistack sync (#695). The section is optional and every key in
  // it has a default, because the switch that turns this on is not a config key:
  // it is the machine credential under curia's HOME, which only the operator's
  // one-time registration writes. A box that never registered reads this block
  // and does nothing with it.
  //
  // `cli_version` is a PIN, for the reason every pin in `sandbox:` is one. The
  // stock aistack hook runs `@latest`, so an unpinned command changes behavior
  // on a box nobody touched.
  const ai = cfg.aistack ?? {}
  if (typeof ai !== 'object' || Array.isArray(ai)) fail(src, '`aistack` must be a mapping')
  if (ai.cli_version !== undefined && !VERSION_RE.test(String(ai.cli_version))) {
    fail(src, `aistack.cli_version must be a pinned version like ${DEFAULT_CLI_VERSION} - "latest" and a range are what this pin exists to refuse`)
  }
  if (ai.interval_hours !== undefined
    && (typeof ai.interval_hours !== 'number' || !Number.isFinite(ai.interval_hours) || ai.interval_hours <= 0)) {
    fail(src, 'aistack.interval_hours must be a positive number of hours')
  }
  cfg.aistack = {
    cli_version: String(ai.cli_version ?? DEFAULT_CLI_VERSION),
    interval_hours: ai.interval_hours ?? DEFAULT_INTERVAL_HOURS,
  }

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
      fail(src, 'the `sandbox:` section is required — every agent runs in a container (#195), and a container has no image to run and no pins to build one from')
    }
    const sb = cfg.sandbox
    if (!sb || typeof sb !== 'object' || Array.isArray(sb)) fail(src, '`sandbox` must be a mapping')
    sb.image = sb.image ?? DEFAULT_IMAGE
    if (typeof sb.image !== 'string' || !IMAGE_NAME_RE.test(sb.image)) {
      fail(src, `sandbox.image must be a docker repository name (got ${JSON.stringify(sb.image)})`)
    }
    for (const key of Object.keys(sb)) {
      if (key.endsWith('_version') && !Object.hasOwn(SANDBOX_KEYS, key)) {
        fail(src, `sandbox.${key} does not name a selectable Harness`)
      }
    }
    for (const key of Object.keys(SANDBOX_KEYS)) {
      if (key === 'agent_uid') continue
      // YAML reads `1.62` as a number and `1.62.1` as a string, and both are
      // plausible things to type on a version line — so a number is coerced
      // rather than refused, and only an empty or exotic value fails.
      if (typeof sb[key] === 'number') sb[key] = String(sb[key])
      if (typeof sb[key] !== 'string' || !VERSION_RE.test(sb[key])) {
        fail(src, `sandbox.${key} must be a pinned version string, e.g. "1.2.3" (got ${JSON.stringify(sb[key])})`)
      }
    }
    // Not cosmetic: the container writes the clone the daemon prepared on the
    // host, so a uid that is not the host user's makes every agent fail on
    // its first write. Defaulted to the daemon's own uid, which is the only
    // value that can be right by construction.
    sb.agent_uid = sb.agent_uid ?? process.getuid?.()
    if (!(Number.isInteger(sb.agent_uid) && sb.agent_uid >= 0 && sb.agent_uid < 2 ** 31)) {
      fail(src, `sandbox.agent_uid must be a uid (got ${JSON.stringify(sb.agent_uid)})`)
    }
    if (checkPaths && !fs.existsSync(DOCKERFILE)) {
      fail(src, `sandbox is configured but ${DOCKERFILE} is missing — the image has no recipe`)
    }
    // The ports each container publishes on loopback (#156, from #148). Three
    // per agent, so the range has to hold `3 × max_concurrent` before every
    // slot can run sandboxed — checked here rather than discovered by the
    // dispatch that finds none free with a claim already taken.
    const sbRange = { from: sb.port_from ?? DEFAULT_CONTAINER_PORTS.from, to: sb.port_to ?? DEFAULT_CONTAINER_PORTS.to }
    for (const [key, v] of [['port_from', sbRange.from], ['port_to', sbRange.to]]) {
      if (!(Number.isInteger(v) && v > 0 && v < 65536)) fail(src, `sandbox.${key} must be a port number`)
    }
    if (sbRange.to < sbRange.from) fail(src, `sandbox.port_to (${sbRange.to}) must not be below sandbox.port_from (${sbRange.from})`)
    const need = PORTS_PER_AGENT * d.max_concurrent
    if (sbRange.to - sbRange.from + 1 < need) {
      fail(src, `sandbox ports ${sbRange.from}-${sbRange.to} hold ${sbRange.to - sbRange.from + 1} ports, and ${d.max_concurrent} concurrent agents publishing ${PORTS_PER_AGENT} each need ${need}`)
    }
    // Every other surface on this box is a port a container must never
    // shadow: publishing over the preview range would make `tailscale serve`
    // and docker fight for the same listener, and publishing over an attach
    // port would take that surface down.
    for (const [name, port] of [...ports, ['the daemon port', Number(process.env.PORT ?? 4271)]]) {
      if (port >= sbRange.from && port <= sbRange.to) {
        fail(src, `sandbox port range ${sbRange.from}-${sbRange.to} contains ${name} (${port}) — a container would publish over it`)
      }
    }
    if (!(sbRange.to < range.from || sbRange.from > range.to)) {
      fail(src, `sandbox port range ${sbRange.from}-${sbRange.to} overlaps the preview range ${range.from}-${range.to}`)
    }
    // #168: a container publishing over a preview proxy port would take the gate
    // in front of some other agent's preview, which is the un-gated dev server
    // this block exists to stop.
    if (!(sbRange.to < proxyBlock.from || sbRange.from > proxyBlock.to)) {
      fail(src, `sandbox port range ${sbRange.from}-${sbRange.to} overlaps the preview identity-proxy block ${proxyBlock.from}-${proxyBlock.to}`)
    }
    sb.ports = sbRange
    cfg.sandbox = sb
  }

  return cfg
}

export function loadRoutingConfig(file, { localFile } = {}) {
  const layers = readLayered(file, { localFile })
  const cfg = layers.data
  const src = layers.localFile ? `${file} + ${layers.localFile}` : file
  if (!cfg || typeof cfg !== 'object') fail(src, 'not a mapping')

  if (!cfg.defaults || typeof cfg.defaults !== 'object') fail(src, '`defaults` section missing')
  if (cfg.defaults.untyped === undefined) fail(src, 'defaults.untyped is required')

  if (!cfg.models || typeof cfg.models !== 'object' || !Object.keys(cfg.models).length) {
    fail(src, '`models` must be a non-empty map')
  }
  for (const [name, m] of Object.entries(cfg.models)) {
    if (!m || typeof m.provider !== 'string' || typeof m.harness !== 'string') {
      fail(src, `models.${name} needs \`provider\` and \`harness\``)
    }
    if (!LIMIT_PATTERNS[m.provider]) {
      // A provider with no usage-limit vocabulary would spawn agents whose cap
      // hits are invisible: parseUsageLimit returns null for it, so the model
      // never cools and every dispatch on it burns a claim into a ready-timeout.
      // Adding a provider is a code change (the phrasings are classifiers, not
      // settings), so refusing here names that.
      fail(src, `models.${name}.provider "${m.provider}" has no usage-limit vocabulary in routing.mjs — known providers: ${Object.keys(LIMIT_PATTERNS).join(', ')}`)
    }
    // Optional CLI-facing model name. It is substituted into a shell template,
    // so it passes the same whitelist buildSpawnCmd asserts at spawn — failing
    // at boot naming the key beats failing at dispatch with a claim already taken.
    if (m.id !== undefined && (typeof m.id !== 'string' || !SAFE_SUBSTITUTION.test(m.id))) {
      fail(src, `models.${name}.id must be a quote-free model name (got ${JSON.stringify(m.id)})`)
    }
    // The shared union catches spelling mistakes. The Harness adapter then
    // catches an effort that the target CLI cannot state.
    if (m.reasoning_effort !== undefined && !REASONING_EFFORTS.includes(m.reasoning_effort)) {
      fail(src, `models.${name}.reasoning_effort must be one of ${REASONING_EFFORTS.join('|')} (got ${JSON.stringify(m.reasoning_effort)})`)
    }
    if (m.reasoning_effort !== undefined
      && !harnessReasoningEffort(m.harness, m.reasoning_effort, HARNESS_REGISTRY)) {
      fail(src, `models.${name}.reasoning_effort "${m.reasoning_effort}" is not supported by the ${m.harness} harness`)
    }
    // Optional (#146), and since #178 the LAST resort for the status line's
    // context %: the transcript's own window wins, then the live
    // `GET /v1/models/<id>` lookup, then this. Omitting it everywhere is the
    // normal case — a hand-written denominator is the thing #178 found wrong,
    // and no figure at all beats a confident wrong percentage.
    if (m.context_window !== undefined
      && (!Number.isInteger(m.context_window) || m.context_window <= 0)) {
      fail(src, `models.${name}.context_window must be a positive integer of tokens (got ${JSON.stringify(m.context_window)})`)
    }
    // #265: the switch behind the settings screen's "n of m models active".
    // Default true, so a config written before this key existed reads the way
    // it always did, and a model is inactive only because somebody said so.
    //
    // An inactive model keeps its whole entry — provider, harness, id, effort
    // and every comment on it — and leaves the DISPATCH VOCABULARY: no
    // `defaults` row and no `review` row may name it, a fallback chain steps
    // over it, and a `model:<x>` label naming it is refused at dispatch. That
    // is what makes the checkbox a switch rather than a deletion: turning a
    // model off costs nothing to turn back on.
    if (m.active !== undefined && typeof m.active !== 'boolean') {
      fail(src, `models.${name}.active must be true or false (got ${JSON.stringify(m.active)})`)
    }
    m.active = m.active ?? true
  }
  // Every model that stays in the dispatch vocabulary. One reading of the
  // switch, shared by the three rules below and by routing.mjs.
  if (!Object.values(cfg.models).some((m) => m.active)) {
    fail(src, 'every model is `active: false` — curia would have nothing to dispatch on; turn at least one back on')
  }
  for (const [type, route] of Object.entries(cfg.defaults)) {
    if (typeof route !== 'string' && (!route || typeof route !== 'object' || Array.isArray(route))) {
      fail(src, `defaults.${type} must be a model label or { model, effort }`)
    }
    const model = typeof route === 'string' ? route : route.model
    if (typeof model !== 'string' || !model) {
      fail(src, `defaults.${type}.model is required`)
    }
    if (typeof route === 'object') {
      for (const key of Object.keys(route)) {
        if (!['model', 'effort'].includes(key)) fail(src, `defaults.${type}.${key} is not a routing field`)
      }
      if (route.effort !== undefined && !REASONING_EFFORTS.includes(route.effort)) {
        fail(src, `defaults.${type}.effort must be one of ${REASONING_EFFORTS.join('|')} (got ${JSON.stringify(route.effort)})`)
      }
    }
    if (!cfg.models[model]) fail(src, `defaults.${type} names unknown model "${model}"`)
    if (!cfg.models[model].active) {
      fail(src, `defaults.${type} names "${model}", which is \`active: false\` — either turn that model on or point this row at an active one`)
    }
    if (typeof route === 'object' && route.effort
      && !harnessReasoningEffort(cfg.models[model].harness, route.effort, HARNESS_REGISTRY)) {
      fail(src, `defaults.${type}.effort "${route.effort}" is not supported by the ${cfg.models[model].harness} harness`)
    }
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
    fail(src, '`review` must be a mapping of provider → model')
  }
  const providers = new Set(Object.values(cfg.models).map((m) => m.provider))
  for (const [provider, model] of Object.entries(cfg.review)) {
    if (!providers.has(provider)) {
      fail(src, `review.${provider} names a provider no configured model runs on — configured providers: ${[...providers].join(', ')}`)
    }
    if (!cfg.models[model]) fail(src, `review.${provider} names unknown model "${model}"`)
    if (!cfg.models[model].active) {
      fail(src, `review.${provider} names "${model}", which is \`active: false\` — a cross-check cannot run on a model that is switched off`)
    }
    if (cfg.models[model].provider === provider) {
      fail(src, `review.${provider} names "${model}", which runs on ${provider} itself — a cross-check reads the diff on the OTHER provider`)
    }
  }

  // A chain may still NAME an inactive model. It is `candidates` that steps
  // over one, so switching a model off never has to be a rewrite of every
  // chain that mentions it — and switching it back on restores the chain it
  // was in, unedited.
  cfg.fallbacks = cfg.fallbacks ?? {}
  for (const [from, chain] of Object.entries(cfg.fallbacks)) {
    if (!cfg.models[from]) fail(src, `fallbacks.${from} names unknown model "${from}"`)
    if (!Array.isArray(chain)) fail(src, `fallbacks.${from} must be a list`)
    for (const to of chain) {
      if (!cfg.models[to]) fail(src, `fallbacks.${from} names unknown model "${to}"`)
    }
  }

  if (!cfg.harnesses || typeof cfg.harnesses !== 'object' || !Object.keys(cfg.harnesses).length) {
    fail(src, '`harnesses` must be a non-empty map')
  }
  for (const [name, b] of Object.entries(cfg.harnesses)) {
    if (!b || typeof b.template !== 'string') fail(src, `harnesses.${name} needs a \`template\` string`)
    for (const ph of ['{model}', '{prompt_file}']) {
      if (!b.template.includes(ph)) fail(src, `harnesses.${name}.template is missing the ${ph} placeholder`)
    }
    if (typeof b.resume_template !== 'string' || !b.resume_template.includes('{model}')) {
      fail(src, `harnesses.${name}.resume_template must include the {model} placeholder`)
    }
    b.resumeTemplate = b.resume_template
    let adapter
    try {
      adapter = HARNESS_REGISTRY.get(name)
    } catch {
      fail(src, `harnesses.${name} has no registered Harness adapter - registered Harnesses: ${HARNESS_REGISTRY.names.join(', ')}`)
    }
    // The credential half of that same question (#648). A harness whose provider
    // has no contract row would spawn agents curia cannot give a credential to,
    // cannot say an expiry for, and cannot sign back in — the shape ADR-0027
    // left open and #641 exists because of. Refusing here is the same act
    // `models.<n>.provider` already performs against the usage-limit vocabulary
    // a few hundred lines above: adding a provider is a code change, and this
    // names it.
    const credentialFault = providerContractFault(name, adapter.identity.provider)
    if (credentialFault) fail(src, credentialFault)
    const consumerFault = consumerContractFault(adapter.identity.credentialConsumer)
    if (consumerFault) fail(src, `Harness ${name} has an invalid credential consumer: ${consumerFault}`)
    // The readiness marker is per harness and REQUIRED, not defaulted (#57's
    // precedent: silence by omission is the failure this refuses). #33 lost
    // readiness live to a marker that matched nothing, and the symptom was
    // silence — no agent_ready, and reactive cooling that could never fire.
    if (typeof b.ready !== 'string' || !b.ready.trim()) {
      fail(src, `harnesses.${name} needs a \`ready\` regex — the pane text that says this harness reached its composer`)
    }
    try {
      b.readyRe = new RegExp(b.ready)
    } catch (e) {
      fail(src, `harnesses.${name}.ready is not a valid regex: ${e.message}`)
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
      fail(src, `harnesses.${name} needs a positive \`tool_channel_grace_s\` — how long after the composer marker an agent may send no /mcp request before curia treats it as having no tool channel`)
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
    for (const [key, value] of [['template', b.template], ['resume_template', b.resumeTemplate]]) {
      if (!value?.includes("'")) continue
      fail(src, `harnesses.${name}.${key} carries a single quote. The docker command cannot nest it. Rewrite it without one`)
    }
  }
  for (const [name, m] of Object.entries(cfg.models)) {
    if (!cfg.harnesses[m.harness]) fail(src, `models.${name}.harness names unknown harness "${m.harness}"`)
    const adapter = HARNESS_REGISTRY.get(m.harness)
    if (m.provider !== adapter.identity.provider) {
      fail(src, `models.${name}.provider names "${m.provider}", but the ${m.harness} Harness adapter declares "${adapter.identity.provider}"`)
    }
  }

  // The consumer contract, checked at the same boot (#648). This table is code
  // rather than config, so nothing an operator writes can break it — which is
  // exactly why it is asserted HERE instead of trusted: a consumer that declares
  // no delivery reaches no agent, and the failure would otherwise be a dispatch
  // discovering it with a claim already taken. Three consumers, not two: the
  // overseer is one and is not a harness.
  for (const consumer of CONSUMER_NAMES) {
    const fault = consumerContractFault(consumer)
    if (fault) fail(src, `the model-credential consumer contract in credentials.mjs is broken: ${fault}`)
  }

  return cfg
}

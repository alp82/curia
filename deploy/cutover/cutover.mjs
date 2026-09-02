#!/usr/bin/env node
// The mechanical steps of the one-time source cutover (#889, implementing
// #856): the admission checks on the source deployment, the evidence
// manifest of the stopped source, the transformation of a copied source tree
// into the four preserved boundaries of an installed root, and the validation
// of the result against the manifest. The runbook at
// docs/operator/source-cutover-runbook.md invokes these four in order and does
// by hand what they cannot: stopping and starting services, the copy over
// SSH, the integration checks on the Setup screen, and the Full loop.
//
// THIS IS NOT A MIGRATION PRODUCT. It knows one source layout, the box's, at
// one accepted commit, and it refuses anything else by name. `curia install`
// contains none of it, and no other source deployment is promised anything.
//
// WHAT NEVER LEAVES THIS MODULE: a credential value. The env file is read for
// four keys and their values go into four secret files at mode 0600 and
// nowhere else. Refusals, the manifest, the marker, and every printed line
// carry names, paths, sizes, counts, and hashes of non-secret files only. A
// secret file is inventoried by name, size, and mode, never hashed, because a
// hash of a short token is a token with extra steps.
//
// The module is dependency-free like the lifecycle interface, and it takes
// the operator-configuration contract from `cli/src/config.mjs` so
// `config/config.yaml` is written by the one writer every process reads it
// with. Host facts (git, Docker, the running service) enter through
// injectable probes, so the daemon suite dry-runs every step against a
// fixture copy of the layout with nothing reaching a host.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { writeAtomically } from '../../cli/src/atomic.mjs'
import { OPERATOR_CONFIG_KEYS, WATCH_MODES, readOperatorConfig, renderOperatorConfig, validateOperatorConfig } from '../../cli/src/config.mjs'

const execFileP = promisify(execFile)

// The commit the runbook accepts, read off the box on 2026-09-02: the checkout
// at /home/alp/curia was clean at this commit, running daemon 0.4.1. Move it
// with the runbook's own revision when the deployment moves before the
// cutover; `admit` compares against the commit the operator passes, and the
// runbook says to pass this one.
export const ACCEPTED_SOURCE_COMMIT = '2be76653451ee4f5f4dd63c7b84d46735d79c293'

export const MANIFEST_FORMAT = 1
export const MIGRATION_FILE = 'migration.json'

// The env keys the source daemon needs, and the retired ones a box may still
// carry. A retired key is a live credential with no job (docs/deploy.md), and
// admission refuses it so the cutover never copies one anywhere.
const REQUIRED_ENV_KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USERS', 'CURIA_GH_APP_ID', 'CURIA_GH_APP_KEY_FILE']
const OPTIONAL_ENV_KEYS = ['CURIA_GUILD_ID', 'CURIA_CHANNEL']
const RETIRED_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']
const RETIRED_ENV_PREFIXES = ['CURIA_AGENT_GH_TOKEN_', 'CURIA_OVERSEER_GH_TOKEN_']

// The source files that must be there, relative to the checkout (`c:`) or the
// workspace (`w:`), and the files whose presence means another layout.
const EXPECTED_FILES = [
  'c:deploy/compose.yaml', 'c:daemon/.env.daemon', 'c:daemon/.curia-app.pem', 'c:daemon/data/events.db',
  'c:config/curia.yaml', 'c:config/curia.local.yaml',
  'w:credentials/anthropic.json', 'w:cfg/curia-overseer',
]
const EXPECTED_DIRS = ['c:daemon/data/attachments', 'c:daemon/data/results', 'c:daemon/data/backups', 'w:cfg']
const FOREIGN_FILES = ['c:daemon/.env', 'c:daemon/data/events.jsonl', 'c:config/config.yaml']

// What the transformation carries, source-relative to target-relative, and
// what it leaves behind. `EXCLUDED` is matched against every path segment of
// the source tree walked, so a cache or a runtime copy never rides along
// inside a preserved tree.
const CARRIED = [
  { from: 'c:daemon/data/attachments', to: 'state/attachments' },
  { from: 'c:daemon/data/results', to: 'state/results' },
  { from: 'c:daemon/data/backups', to: 'state/backups' },
  { from: 'c:daemon/data/verdicts', to: 'state/verdicts', optional: true },
  { from: 'c:config/routing.local.yaml', to: 'state/routing.local.yaml', optional: true },
  { from: 'w:cfg', to: 'work/cfg' },
  { from: 'w:repos', to: 'work/repos', optional: true },
  { from: 'w:archive', to: 'work/archive', optional: true },
]
export const EXCLUDED = Object.freeze([
  // runtime credential copies and renewable tokens, rewritten by the service
  '.credentials.json', 'gh', 'tokens', 'overseer-tokens',
  // the daemon's own runtime state and the deploy verb's files
  'previews.json', 'deploy.json', 'deploy.log', 'deploy-last.json',
  // the dead in-daemon overseer host's tree (#315), mirrors, tool caches
  'overseer', 'home', 'node_modules', '.npm', '.cache', 'tmux-1000',
])
// `home` is excluded as a top-level workspace tree (HOME is a cache under a
// root) but kept inside the overseer's config dir, where it is the cwd every
// turn runs in and the transcript slug depends on it.
const KEEP_INSIDE = { home: 'work/cfg/curia-overseer' }

const SECRET_MODE = 0o600
const BOUNDARIES = ['config', 'secrets', 'state', 'work']

export class CutoverError extends Error {
  constructor(message, exit = 1) {
    super(message)
    this.name = 'CutoverError'
    this.exit = exit
  }
}

// ---------------------------------------------------------------------------
// helpers

const at = (checkout, workspace, spec) => (spec.startsWith('c:') ? path.join(checkout, spec.slice(2)) : path.join(workspace, spec.slice(2)))
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const modeOf = (stat) => `0${(stat.mode & 0o777).toString(8).padStart(3, '0')}`

function lstatOrNull(file) {
  try { return fs.lstatSync(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}

// The env file's keys in order, and its values, read once and handed only to
// the function that writes the secret files.
function readEnvFile(file) {
  const keys = []
  const values = {}
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    keys.push(key)
    values[key] = value
  }
  return { keys, values }
}

const envKeysOf = (file) => (lstatOrNull(file) ? readEnvFile(file).keys : null)

// Every regular file under `dir`, relative, sorted, with the exclusions
// applied per segment. `keepInside` lets one excluded name survive under one
// tree.
function walk(dir, { base = dir, targetPrefix = '' } = {}) {
  const out = []
  const rel = path.relative(base, dir)
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const relPath = rel ? path.join(rel, entry.name) : entry.name
    if (EXCLUDED.includes(entry.name)) {
      const keepUnder = KEEP_INSIDE[entry.name]
      const target = path.join(targetPrefix, path.dirname(relPath) === '.' ? '' : path.dirname(relPath))
      if (!(keepUnder && target === keepUnder)) continue
    }
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...walk(full, { base, targetPrefix }))
    else if (entry.isFile()) out.push(relPath)
  }
  return out
}

// The override file the source dashboard writes (`config/curia.local.yaml`):
// a `dispatch:` mapping of scalars, an `overseer:` mapping holding
// `live_pane_cap`, and a `watch:` list of `- repo:` entries. Anything else in
// it is a key with no place in the operator configuration, refused by name so
// the operator decides what it meant.
function readOverride(file) {
  const text = fs.readFileSync(file, 'utf8')
  const data = {}
  const unplaced = []
  let section = null
  let entry = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    const top = line.match(/^([a-z_]+):\s*(.*)$/)
    if (top) {
      section = top[1]
      entry = null
      if (section === 'watch') data.watch = []
      else if (!['dispatch', 'overseer'].includes(section)) unplaced.push(section)
      continue
    }
    const item = line.match(/^\s+-\s+repo:\s*(\S+)\s*$/)
    if (item && section === 'watch') {
      entry = { repo: item[1], mode: 'auto' }
      data.watch.push(entry)
      continue
    }
    const kv = line.match(/^\s+([a-z_]+):\s*(.*?)\s*$/)
    if (kv && section === 'watch' && entry && kv[1] === 'mode') { entry.mode = kv[2]; continue }
    if (kv && (section === 'dispatch' || section === 'overseer')) {
      const key = kv[1]
      if (!OPERATOR_CONFIG_KEYS.includes(key) || key === 'watch') { unplaced.push(`${section}.${key}`); continue }
      const v = kv[2]
      data[key] = v === 'true' ? true : v === 'false' ? false : /^\d+(\.\d+)?$/.test(v) ? Number(v) : v
      continue
    }
    unplaced.push(line.trim())
  }
  if (data.watch) {
    for (const w of data.watch) if (!WATCH_MODES.includes(w.mode)) unplaced.push(`watch ${w.repo} mode ${w.mode}`)
  }
  return { data, unplaced }
}

// The journal, opened read-only in place: integrity, count, and bounds. A
// `-wal` beside a stopped daemon's journal is read through by SQLite.
function inspectJournal(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const integrity = db.prepare('pragma integrity_check').all().map((r) => Object.values(r)[0]).join('; ')
    const bounds = db.prepare('select min(id) lo, max(id) hi, count(*) n from events').get()
    const first = db.prepare('select ts from events order by id asc limit 1').get()
    const last = db.prepare('select ts from events order by id desc limit 1').get()
    return { integrity, count: bounds.n, minId: bounds.lo, maxId: bounds.hi, firstTs: first?.ts ?? null, lastTs: last?.ts ?? null }
  } finally {
    db.close()
  }
}

const curiaContainers = (containers) => containers.filter((c) => /^curia[-_]/.test(c.name) && /^Up\b/.test(c.status ?? ''))

// ---------------------------------------------------------------------------
// the probes: how the module observes a host when it is not handed answers

async function gitHead(checkout) {
  const { stdout } = await execFileP('git', ['-C', checkout, 'rev-parse', 'HEAD'])
  return stdout.trim()
}

async function gitDirty(checkout) {
  const { stdout } = await execFileP('git', ['-C', checkout, 'status', '--porcelain'])
  return stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim())
}

async function dockerContainers() {
  const { stdout } = await execFileP('docker', ['ps', '--all', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'])
  return stdout.split('\n').filter(Boolean).map((l) => { const [name, image, status] = l.split('\t'); return { name, image, status } })
}

async function serviceOverview() {
  try {
    const res = await fetch('http://127.0.0.1:4271/overview', { signal: AbortSignal.timeout(5000) })
    return { ok: res.ok, body: res.ok ? await res.json() : null }
  } catch {
    return { ok: false, body: null }
  }
}

export const hostProbes = Object.freeze({ head: gitHead, dirty: gitDirty, containers: dockerContainers, targetContainers: dockerContainers, overview: serviceOverview })

// ---------------------------------------------------------------------------
// admission

// The facts about the source, and every reason it is not the source the
// runbook accepts. Nothing here is changed, and a refusal names the file, the
// key, the container, or the session it is about.
export async function admit({ checkout, workspace, expectCommit = ACCEPTED_SOURCE_COMMIT }, probes = hostProbes) {
  const p = { ...hostProbes, ...probes }
  const refusals = []
  const facts = { checkout, workspace, commit: null, dirty: [], envKeys: {}, liveSessions: [], runningContainers: [] }

  for (const [label, dir] of [['checkout', checkout], ['workspace', workspace]]) {
    if (!path.isAbsolute(dir)) refusals.push(`the ${label} must be an absolute path, got ${dir}`)
    const stat = lstatOrNull(dir)
    if (!stat) refusals.push(`the ${label} ${dir} does not exist`)
    else if (stat.isSymbolicLink()) refusals.push(`the ${label} ${dir} is a symbolic link, which makes the path ambiguous. Name the real directory.`)
    else if (!stat.isDirectory()) refusals.push(`the ${label} ${dir} is not a directory`)
  }
  if (refusals.length) return { facts, refusals }

  facts.commit = await p.head(checkout)
  if (facts.commit !== expectCommit) refusals.push(`the checkout is at ${facts.commit}, not the accepted source commit ${expectCommit}`)
  facts.dirty = await p.dirty(checkout)
  if (facts.dirty.length) refusals.push(`the checkout is dirty: ${facts.dirty.join(', ')}. Restore or commit and deploy every tracked change first.`)

  for (const spec of EXPECTED_FILES) if (!lstatOrNull(at(checkout, workspace, spec))) refusals.push(`expected ${at(checkout, workspace, spec)} is missing, so this is not the layout the runbook accepts`)
  for (const spec of EXPECTED_DIRS) { const s = lstatOrNull(at(checkout, workspace, spec)); if (!s || !s.isDirectory()) refusals.push(`expected directory ${at(checkout, workspace, spec)} is missing`) }
  for (const spec of FOREIGN_FILES) if (lstatOrNull(at(checkout, workspace, spec))) refusals.push(`${at(checkout, workspace, spec)} exists, which belongs to another layout. Remove it before the cutover.`)

  for (const rel of ['daemon/.env.daemon', 'daemon/.env.overseer', 'deploy/.env']) {
    const keys = envKeysOf(path.join(checkout, rel))
    facts.envKeys[rel] = keys
    if (!keys) continue
    const stat = fs.lstatSync(path.join(checkout, rel))
    if (rel !== 'deploy/.env' && (stat.mode & 0o077) !== 0) refusals.push(`${rel} has mode ${modeOf(stat)}, which lets other users read it`)
    for (const key of keys) {
      if (RETIRED_ENV_KEYS.includes(key) || RETIRED_ENV_PREFIXES.some((pre) => key.startsWith(pre))) {
        refusals.push(`${rel} carries the retired key ${key}, a live credential with no job. Delete the line and revoke the credential where it was issued.`)
      }
    }
  }
  const daemonKeys = facts.envKeys['daemon/.env.daemon'] ?? []
  for (const key of REQUIRED_ENV_KEYS) if (!daemonKeys.includes(key)) refusals.push(`daemon/.env.daemon lacks ${key}`)
  for (const key of daemonKeys) {
    if (![...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS].includes(key) && !RETIRED_ENV_KEYS.includes(key) && !RETIRED_ENV_PREFIXES.some((pre) => key.startsWith(pre))) {
      refusals.push(`daemon/.env.daemon carries ${key}, which the cutover has no place for`)
    }
  }
  if (facts.envKeys['daemon/.env.overseer']?.length) refusals.push('daemon/.env.overseer still holds keys. Delete every legacy key and the file (docs/deploy.md).')

  const pemStat = lstatOrNull(path.join(checkout, 'daemon/.curia-app.pem'))
  if (pemStat && (pemStat.mode & 0o077) !== 0) refusals.push(`daemon/.curia-app.pem has mode ${modeOf(pemStat)}, which lets other users read it`)

  const override = readOverride(path.join(checkout, 'config/curia.local.yaml'))
  if (override.data.auto_dispatch === true) refusals.push('config/curia.local.yaml sets dispatch.auto_dispatch: true. Turn automatic dispatch off on the Settings screen and wait for zero live sessions.')
  if (override.unplaced.length) refusals.push(`config/curia.local.yaml holds keys with no place in config/config.yaml: ${override.unplaced.join(', ')}. Remove them or move the setting where the target keeps it.`)

  const containers = await p.containers()
  facts.runningContainers = curiaContainers(containers).map((c) => c.name)
  const agents = facts.runningContainers.filter((n) => /^curia-\d+$/.test(n))
  if (agents.length) refusals.push(`agent containers are running: ${agents.join(', ')}. Wait until every agent, review, and operator turn has ended.`)
  const overview = await p.overview()
  if (overview.ok && Array.isArray(overview.body?.agents)) {
    facts.liveSessions = overview.body.agents.filter((a) => a?.tmux_live === true).map((a) => String(a.session)).sort()
    if (facts.liveSessions.length) refusals.push(`live sessions: ${facts.liveSessions.join(', ')}. Wait until every agent, review, and operator turn has ended.`)
  }

  return { facts, refusals }
}

// ---------------------------------------------------------------------------
// evidence

// The manifest of the stopped source: identity, journal integrity and bounds,
// every preserved file with its hash, and the four credentials by name, size,
// and mode. It refuses while any Curia container runs, so a manifest is proof
// the source was stopped when it was taken, which is what lets the target use
// the Discord credential afterwards.
export async function inventory({ checkout, workspace, host, now = () => new Date().toISOString() }, probes = hostProbes) {
  const p = { ...hostProbes, ...probes }
  const running = curiaContainers(await p.containers()).map((c) => c.name)
  if (running.length) throw new CutoverError(`the source is running: ${running.join(', ')}. Stop the Compose project first, then take the inventory.`, 3)

  const checkoutStat = fs.statSync(checkout)
  const source = { host, checkout, workspace, commit: await p.head(checkout), uid: checkoutStat.uid, gid: checkoutStat.gid, stopped: true, taken_at: now() }
  const journal = inspectJournal(path.join(checkout, 'daemon/data/events.db'))
  if (journal.integrity !== 'ok') throw new CutoverError(`the journal failed its integrity check: ${journal.integrity}`)

  const files = []
  for (const item of CARRIED) {
    const from = at(checkout, workspace, item.from)
    const stat = lstatOrNull(from)
    if (!stat) { if (item.optional) continue; throw new CutoverError(`${from} is missing`) }
    if (stat.isFile()) { files.push({ path: item.to, size: stat.size, mode: modeOf(stat), sha256: sha256(from) }); continue }
    for (const rel of walk(from, { targetPrefix: item.to })) {
      const file = path.join(from, rel)
      const s = fs.lstatSync(file)
      files.push({ path: path.join(item.to, rel), size: s.size, mode: modeOf(s), sha256: sha256(file) })
    }
  }
  const env = readEnvFile(path.join(checkout, 'daemon/.env.daemon'))
  const pem = env.values.CURIA_GH_APP_KEY_FILE
  const secrets = [
    { name: 'discord-bot-token', source: 'daemon/.env.daemon DISCORD_BOT_TOKEN', size: Buffer.byteLength(env.values.DISCORD_BOT_TOKEN ?? '') + 1, mode: '0600' },
    { name: 'github-app.json', source: 'daemon/.env.daemon CURIA_GH_APP_ID + daemon/.curia-app.pem', size: null, mode: '0600' },
    { name: 'anthropic.json', source: 'credentials/anthropic.json', size: fs.statSync(path.join(workspace, 'credentials/anthropic.json')).size, mode: '0600' },
    { name: 'codex-auth.json', source: 'home/.codex/auth.json', size: lstatOrNull(path.join(workspace, 'home/.codex/auth.json'))?.size ?? null, mode: '0600' },
  ]
  if (!pem || !lstatOrNull(pem)) throw new CutoverError('CURIA_GH_APP_KEY_FILE names a file that is not there')
  const discord = env.values
  const counts = { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), cfgDirs: fs.readdirSync(path.join(workspace, 'cfg')).length }
  return {
    format: MANIFEST_FORMAT,
    source,
    journal,
    discord: { allowed_users: (discord.DISCORD_ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean).length, guild_id: Boolean(discord.CURIA_GUILD_ID), channel: discord.CURIA_CHANNEL || 'curia' },
    files,
    secrets,
    counts,
  }
}

// ---------------------------------------------------------------------------
// transformation

const manifestIdentity = (manifest) => createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

function copyTree(from, to, targetPrefix) {
  for (const rel of walk(from, { targetPrefix })) {
    const dest = path.join(to, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(from, rel), dest)
    fs.chmodSync(dest, fs.lstatSync(path.join(from, rel)).mode & 0o700)
  }
}

// The copied source, laid into an installed root's `config/`, `secrets/`,
// `state/`, and `work/`. Every refusal is decided before the first write, and
// the journal is checked again after its copy is checkpointed.
export async function transform({ checkout, workspace, root, manifest, host, now = () => new Date().toISOString() }, probes = hostProbes) {
  const p = { ...hostProbes, ...probes }
  const refusals = []
  if (manifest?.format !== MANIFEST_FORMAT || manifest.source?.stopped !== true) refusals.push('the manifest is not one `inventory` took from a stopped source')
  if (!path.isAbsolute(root) || !lstatOrNull(path.join(root, 'state/installation.json'))) refusals.push(`${root} is not an installed root: state/installation.json is missing. Install the target release first.`)
  for (const b of BOUNDARIES) { const s = lstatOrNull(path.join(root, b)); if (!s || !s.isDirectory()) refusals.push(`${path.join(root, b)} is missing`) }
  const running = curiaContainers(await p.targetContainers()).map((c) => c.name)
  if (running.length) refusals.push(`the target is running: ${running.join(', ')}. Stop the Compose project before the transformation.`)
  if (lstatOrNull(path.join(root, 'state/events.db'))) refusals.push(`${root}/state/events.db exists. The transformation never overwrites a journal.`)
  for (const s of manifest?.secrets ?? []) if (lstatOrNull(path.join(root, 'secrets', s.name))) refusals.push(`${root}/secrets/${s.name} exists. The transformation never overwrites a secret, and two live copies of one credential are refused.`)
  const override = lstatOrNull(path.join(checkout, 'config/curia.local.yaml')) ? readOverride(path.join(checkout, 'config/curia.local.yaml')) : { data: {}, unplaced: ['config/curia.local.yaml is missing'] }
  if (override.unplaced.length) refusals.push(`config/curia.local.yaml holds keys with no place in config/config.yaml: ${override.unplaced.join(', ')}`)
  let operator
  try { operator = validateOperatorConfig(override.data) } catch (e) { refusals.push(`the operator configuration is invalid: ${e.message}`) }
  const env = readEnvFile(path.join(checkout, 'daemon/.env.daemon'))
  for (const key of REQUIRED_ENV_KEYS) if (!env.values[key]) refusals.push(`daemon/.env.daemon lacks ${key}`)
  const pemFile = env.values.CURIA_GH_APP_KEY_FILE
  if (pemFile && !lstatOrNull(pemFile)) refusals.push(`CURIA_GH_APP_KEY_FILE names ${pemFile}, which is not there`)
  for (const item of CARRIED) if (!item.optional && !lstatOrNull(at(checkout, workspace, item.from))) refusals.push(`${at(checkout, workspace, item.from)} is missing`)
  if (!lstatOrNull(path.join(workspace, 'credentials/anthropic.json'))) refusals.push(`${workspace}/credentials/anthropic.json is missing`)
  if (refusals.length) return { refusals, written: [] }

  const written = []
  const put = (rel, text, mode = SECRET_MODE) => { writeAtomically(path.join(root, rel), text, { mode }); written.push(rel) }

  // operator intent
  put('config/config.yaml', renderOperatorConfig(operator))
  // credentials, each read once and written once
  put('secrets/discord-bot-token', `${env.values.DISCORD_BOT_TOKEN}\n`)
  put('secrets/github-app.json', `${JSON.stringify({ id: env.values.CURIA_GH_APP_ID, pem: fs.readFileSync(pemFile, 'utf8') })}\n`)
  put('secrets/anthropic.json', fs.readFileSync(path.join(workspace, 'credentials/anthropic.json'), 'utf8'))
  if (lstatOrNull(path.join(workspace, 'home/.codex/auth.json'))) put('secrets/codex-auth.json', fs.readFileSync(path.join(workspace, 'home/.codex/auth.json'), 'utf8'))
  // the facts beside the token
  put('state/discord.json', `${JSON.stringify({
    allowed_users: env.values.DISCORD_ALLOWED_USERS.split(',').map((s) => s.trim()).filter(Boolean),
    guild_id: env.values.CURIA_GUILD_ID || null,
    channel: env.values.CURIA_CHANNEL || 'curia',
  }, null, 2)}\n`)
  // the journal: copied with its write-ahead log, checkpointed, checked
  const journalFrom = path.join(checkout, 'daemon/data/events.db')
  const journalTo = path.join(root, 'state/events.db')
  fs.copyFileSync(journalFrom, journalTo)
  if (lstatOrNull(`${journalFrom}-wal`)) fs.copyFileSync(`${journalFrom}-wal`, `${journalTo}-wal`)
  fs.chmodSync(journalTo, SECRET_MODE)
  const db = new DatabaseSync(journalTo)
  try { db.exec('pragma wal_checkpoint(truncate)') } finally { db.close() }
  for (const side of ['-wal', '-shm']) if (lstatOrNull(journalTo + side)) fs.rmSync(journalTo + side)
  written.push('state/events.db')
  const journal = inspectJournal(journalTo)
  if (journal.integrity !== 'ok' || journal.count !== manifest.journal.count || journal.minId !== manifest.journal.minId || journal.maxId !== manifest.journal.maxId) {
    throw new CutoverError(`the copied journal does not match the manifest: ${JSON.stringify(journal)} against ${JSON.stringify(manifest.journal)}`)
  }
  // data, results, attachments, native sessions
  for (const item of CARRIED) {
    const from = at(checkout, workspace, item.from)
    if (!lstatOrNull(from)) continue
    if (fs.lstatSync(from).isFile()) put(item.to, fs.readFileSync(from, 'utf8'))
    else { copyTree(from, path.join(root, item.to), item.to); written.push(`${item.to}/`) }
  }
  // the marker
  put(`state/${MIGRATION_FILE}`, `${JSON.stringify({
    format: 1,
    source: { host: manifest.source.host, checkout: manifest.source.checkout, workspace: manifest.source.workspace, commit: manifest.source.commit },
    target: { host },
    migrated_at: now(),
    manifest: { format: manifest.format, taken_at: manifest.source.taken_at, sha256: manifestIdentity(manifest) },
  }, null, 2)}\n`)
  return { refusals: [], written }
}

// ---------------------------------------------------------------------------
// validation

const check = (name, failures, observedOk) => ({ name, status: failures.length ? 'failed' : 'passed', observed: failures.length ? failures.join('; ') : observedOk })

// Every source-to-target comparison the cutover adds on top of `curia doctor`:
// the boundaries and their modes, the configuration through the contract's
// reader, secret placement and modes, the Discord facts, the journal against
// the manifest's bounds, every preserved file's hash, the marker, the absence
// of source-layout files inside the root, and the absence of the source paths
// on this host.
export async function validate({ root, manifest, sourcePaths = [] }) {
  const checks = []
  const uid = process.getuid?.()

  const bounds = []
  for (const b of BOUNDARIES) {
    const s = lstatOrNull(path.join(root, b))
    if (!s || !s.isDirectory()) bounds.push(`${b}/ is missing`)
    else if ((s.mode & 0o077) !== 0) bounds.push(`${b}/ has mode ${modeOf(s)}`)
    else if (uid !== undefined && s.uid !== uid) bounds.push(`${b}/ is owned by user ${s.uid}`)
  }
  checks.push(check('boundaries', bounds, 'config/, secrets/, state/, work/ owner-only'))

  const config = []
  let operator = null
  try { operator = readOperatorConfig(path.join(root, 'config/config.yaml')) } catch (e) { config.push(e.message) }
  if (operator && !operator.watch?.length) config.push('config/config.yaml names no watched repository')
  checks.push(check('configuration', config, operator ? `config/config.yaml: ${Object.keys(operator).join(', ')}` : ''))

  const secrets = []
  for (const s of manifest.secrets) {
    const file = path.join(root, 'secrets', s.name)
    const stat = lstatOrNull(file)
    if (!stat) { if (s.size !== null) secrets.push(`secrets/${s.name} is missing`); continue }
    if (stat.isSymbolicLink() || !stat.isFile()) secrets.push(`secrets/${s.name} is not a regular file`)
    else if ((stat.mode & 0o077) !== 0) secrets.push(`secrets/${s.name} has mode ${modeOf(stat)}`)
    else if (s.size !== null && stat.size !== s.size) secrets.push(`secrets/${s.name} has ${stat.size} bytes, the manifest says ${s.size}`)
  }
  checks.push(check('secrets', secrets, manifest.secrets.map((s) => s.name).join(', ')))

  const discord = []
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, 'state/discord.json'), 'utf8'))
    if (!Array.isArray(d.allowed_users) || d.allowed_users.length !== manifest.discord.allowed_users) discord.push(`state/discord.json names ${d.allowed_users?.length ?? 0} allowed users, the manifest says ${manifest.discord.allowed_users}`)
    if (d.channel !== manifest.discord.channel) discord.push(`state/discord.json channel is ${d.channel}, the manifest says ${manifest.discord.channel}`)
  } catch (e) { discord.push(`state/discord.json: ${e.message}`) }
  checks.push(check('discord', discord, `${manifest.discord.allowed_users} allowed users, channel ${manifest.discord.channel}`))

  const journalFailures = []
  let journal = null
  try {
    journal = inspectJournal(path.join(root, 'state/events.db'))
    for (const key of ['integrity', 'count', 'minId', 'maxId', 'firstTs', 'lastTs']) {
      if (journal[key] !== manifest.journal[key]) journalFailures.push(`journal ${key} is ${journal[key]}, the manifest says ${manifest.journal[key]}`)
    }
  } catch (e) { journalFailures.push(`state/events.db: ${e.message}`) }
  checks.push(check('journal', journalFailures, journal ? `integrity ${journal.integrity}, ${journal.count} rows, ids ${journal.minId} to ${journal.maxId}` : ''))

  const files = []
  for (const f of manifest.files) {
    const file = path.join(root, f.path)
    const stat = lstatOrNull(file)
    if (!stat || !stat.isFile()) { files.push(`${f.path} is missing`); continue }
    if (sha256(file) !== f.sha256) files.push(`${f.path} differs from the manifest`)
  }
  checks.push(check('files', files, `${manifest.files.length} files match`))

  const marker = []
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'state', MIGRATION_FILE), 'utf8'))
    if (m.manifest?.sha256 !== manifestIdentity(manifest)) marker.push(`state/${MIGRATION_FILE} names another manifest`)
    if (m.source?.commit !== manifest.source.commit) marker.push(`state/${MIGRATION_FILE} names another source commit`)
  } catch (e) { marker.push(`state/${MIGRATION_FILE}: ${e.message}`) }
  checks.push(check('migration', marker, `state/${MIGRATION_FILE} names ${manifest.source.host} at ${manifest.source.commit.slice(0, 7)}`))

  const layout = []
  for (const rel of ['daemon', 'deploy', 'config/curia.local.yaml', 'config/curia.yaml', 'work/credentials', 'work/home', 'work/overseer', 'state/tokens', 'state/previews.json', 'state/deploy.log']) {
    if (lstatOrNull(path.join(root, rel))) layout.push(`${rel} is a source-layout path inside the root`)
  }
  const workCfg = path.join(root, 'work/cfg')
  if (lstatOrNull(workCfg)) {
    for (const rel of walkAll(workCfg)) {
      const base = path.basename(rel)
      if (base === '.credentials.json' || rel.split(path.sep).includes('gh')) layout.push(`work/cfg/${rel} is a runtime credential copy`)
    }
  }
  checks.push(check('source-layout', layout, 'no source-layout path inside the root'))

  const present = sourcePaths.filter((p) => lstatOrNull(p))
  checks.push(check('source-paths', present.map((p) => `${p} exists on this host`), sourcePaths.length ? `${sourcePaths.join(', ')} absent` : 'no source path named'))

  return { checks, ok: checks.every((c) => c.status === 'passed') }
}

function walkAll(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkAll(full, base))
    else out.push(path.relative(base, full))
  }
  return out
}

// ---------------------------------------------------------------------------
// the command line

const USAGE = `usage: cutover.mjs admit     --checkout DIR --workspace DIR [--commit SHA]
       cutover.mjs inventory --checkout DIR --workspace DIR --host NAME --out FILE
       cutover.mjs transform --checkout DIR --workspace DIR --root DIR --manifest FILE --host NAME
       cutover.mjs validate  --root DIR --manifest FILE [--absent PATH]...

Exit codes: 0 ok, 1 failed, 2 usage, 3 refused (nothing changed).
CURIA_CUTOVER_PROBES names a module whose exports replace the host probes (the dry run).`

function parseArgs(argv) {
  const opts = { absent: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new CutoverError(`unexpected argument ${a}\n${USAGE}`, 2)
    const key = a.slice(2)
    const value = argv[++i]
    if (value === undefined) throw new CutoverError(`--${key} needs a value\n${USAGE}`, 2)
    if (key === 'absent') opts.absent.push(value)
    else opts[key] = value
  }
  return opts
}

function need(opts, ...keys) {
  for (const key of keys) if (!opts[key]) throw new CutoverError(`--${key} is required\n${USAGE}`, 2)
}

async function main(argv) {
  const [verb, ...rest] = argv
  const say = (line) => process.stdout.write(`cutover: ${line}\n`)
  const opts = parseArgs(rest)
  const probes = process.env.CURIA_CUTOVER_PROBES ? await import(pathToFileURL(path.resolve(process.env.CURIA_CUTOVER_PROBES)).href) : {}
  const abs = (p) => (p ? path.resolve(p) : p)

  if (verb === 'admit') {
    need(opts, 'checkout', 'workspace')
    const { facts, refusals } = await admit({ checkout: abs(opts.checkout), workspace: abs(opts.workspace), expectCommit: opts.commit ?? ACCEPTED_SOURCE_COMMIT }, probes)
    say(`checkout ${facts.checkout} at ${facts.commit ?? 'unknown'}, workspace ${facts.workspace}`)
    for (const [file, keys] of Object.entries(facts.envKeys)) say(`${file}: ${keys ? keys.join(', ') || 'no keys' : 'absent'}`)
    if (refusals.length) throw new CutoverError(refusals.map((r) => `refused: ${r}`).join('\n'), 3)
    say('admitted: the source is at the accepted commit, clean, in the expected layout, with no live session')
    return
  }
  if (verb === 'inventory') {
    need(opts, 'checkout', 'workspace', 'host', 'out')
    const manifest = await inventory({ checkout: abs(opts.checkout), workspace: abs(opts.workspace), host: opts.host }, probes)
    writeAtomically(path.resolve(opts.out), `${JSON.stringify(manifest, null, 2)}\n`, { mode: SECRET_MODE })
    say(`journal: integrity ${manifest.journal.integrity}, ${manifest.journal.count} rows, ids ${manifest.journal.minId} to ${manifest.journal.maxId}, ${manifest.journal.firstTs} to ${manifest.journal.lastTs}`)
    say(`files: ${manifest.counts.files} preserved, ${manifest.counts.bytes} bytes, ${manifest.counts.cfgDirs} config directories`)
    say(`secrets: ${manifest.secrets.map((s) => s.name).join(', ')} (by name, never hashed)`)
    say(`manifest written to ${path.resolve(opts.out)} (${manifestIdentity(manifest).slice(0, 16)})`)
    return
  }
  if (verb === 'transform') {
    need(opts, 'checkout', 'workspace', 'root', 'manifest', 'host')
    const manifest = JSON.parse(fs.readFileSync(path.resolve(opts.manifest), 'utf8'))
    const { refusals, written } = await transform({ checkout: abs(opts.checkout), workspace: abs(opts.workspace), root: abs(opts.root), manifest, host: opts.host }, probes)
    if (refusals.length) throw new CutoverError(refusals.map((r) => `refused: ${r}`).join('\n'), 3)
    for (const w of written) say(`wrote ${w}`)
    say(`transformed into ${abs(opts.root)}`)
    return
  }
  if (verb === 'validate') {
    need(opts, 'root', 'manifest')
    const manifest = JSON.parse(fs.readFileSync(path.resolve(opts.manifest), 'utf8'))
    const { checks, ok } = await validate({ root: abs(opts.root), manifest, sourcePaths: opts.absent })
    for (const c of checks) say(`${c.status.padEnd(7)} ${c.name}: ${c.observed}`)
    if (!ok) throw new CutoverError('validation failed. Roll back: leave the target stopped and restart the source deployment.', 1)
    say('validated: every check passed')
    return
  }
  throw new CutoverError(USAGE, 2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`cutover: ${e instanceof CutoverError ? e.message : `failed: ${e.stack ?? e.message}`}\n`)
    process.exit(e instanceof CutoverError ? e.exit : 1)
  })
}

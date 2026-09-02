// The source cutover's mechanical steps (#889, implementing #856), dry-run
// against a representative copy of the box's layout: the checkout with its
// env file, the daemon's data directory, and the workspace tree. Every
// credential in the fixture is a placeholder built from parts, so nothing here
// is token-shaped in the repository. The seam is the module's four functions
// and its command line; nothing here reaches the box, the network, or Docker.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { openJournal } from '../src/journal.mjs'
import { readOperatorConfig } from '../../cli/src/config.mjs'
import {
  ACCEPTED_SOURCE_COMMIT, EXCLUDED, MIGRATION_FILE,
  admit, inventory, transform, validate,
} from '../../deploy/cutover/cutover.mjs'

const REPO = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const SCRIPT = path.join(REPO, 'deploy/cutover/cutover.mjs')

// Placeholder credentials, assembled so no literal in this file is one.
const DISCORD_TOKEN = ['MTIz', 'NDU2', 'Nzg5'].join('.') + '.' + 'placeholder-discord'
const PEM = ['-----BEGIN RSA PRIVATE KEY-----', 'cGxhY2Vob2xkZXI=', '-----END RSA PRIVATE KEY-----', ''].join('\n')
const ANTHROPIC = JSON.stringify({ token: ['sk-ant', 'placeholder', 'anthropic'].join('-'), adopted_at: '2026-08-01T00:00:00Z' })
const CODEX = JSON.stringify({ tokens: { access_token: ['placeholder', 'codex'].join('-') }, last_refresh: '2026-08-30T00:00:00Z' })
const GH_HOSTS = `github.com:\n  oauth_token: ${['gho', 'placeholder'].join('_')}\n`

function write(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode })
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@x' } })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

// The box's layout, as the fact-gathering pass of #889 recorded it, with
// three journal rows so bounds and counts are more than zero.
function buildSource(dir) {
  const checkout = path.join(dir, 'curia')
  const workspace = path.join(dir, 'curia-work')
  fs.mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '-q', '-b', 'main')
  write(path.join(checkout, 'daemon/package.json'), '{ "name": "curia-daemon", "version": "0.4.1" }\n')
  write(path.join(checkout, 'deploy/compose.yaml'), 'name: curia\nservices: {}\n')
  write(path.join(checkout, 'config/curia.yaml'), 'watch:\n  - repo: alp82/curia\ndispatch:\n  max_concurrent: 10\n  auto_dispatch: false\n')
  write(path.join(checkout, 'config/routing.yaml'), 'defaults: {}\nmodels: {}\n')
  write(path.join(checkout, '.gitignore'), 'daemon/.env.daemon\ndaemon/.curia-app.pem\ndaemon/data/\nconfig/*.local.yaml\ndeploy/.env\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-q', '-m', 'fixture')
  const commit = git(checkout, 'rev-parse', 'HEAD')

  write(path.join(checkout, 'daemon/.env.daemon'), [
    `DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`,
    'DISCORD_ALLOWED_USERS=123456789012345678,234567890123456789',
    'CURIA_GH_APP_ID=1234567',
    `CURIA_GH_APP_KEY_FILE=${path.join(checkout, 'daemon/.curia-app.pem')}`,
    '',
  ].join('\n'), 0o600)
  write(path.join(checkout, 'daemon/.curia-app.pem'), PEM, 0o600)
  write(path.join(checkout, 'deploy/.env'), 'DOCKER_GID=998\n')
  write(path.join(checkout, 'config/curia.local.yaml'), [
    '# This box\'s own settings (#292). The curia dashboard writes this file.',
    '',
    'dispatch:',
    '  max_concurrent: 10',
    'watch:',
    '  - repo: getalfredo/landing-page',
    '  - repo: alp82/curia',
    '  - repo: seen-is/seen-site',
    '    mode: map',
    '',
  ].join('\n'))
  write(path.join(checkout, 'config/routing.local.yaml'), 'defaults:\n  task:\n    model: gpt\n    effort: medium\n')

  const data = path.join(checkout, 'daemon/data')
  const journal = openJournal(data)
  journal.append(JSON.stringify({ ts: '2026-08-01T10:00:00Z', type: 'agent_spawned', agent: 'curia-1', ticket: '1', repo: 'alp82/curia' }))
  journal.append(JSON.stringify({ ts: '2026-08-01T11:00:00Z', type: 'agent_ended', agent: 'curia-1', ticket: '1' }))
  journal.append(JSON.stringify({ ts: '2026-09-01T02:57:00Z', type: 'deploy_landed' }))
  journal.close()
  write(path.join(data, 'attachments/esc-28/screen.png'), 'png-bytes')
  write(path.join(data, 'results/curia-1.json'), '{ "ok": true }')
  write(path.join(data, 'backups/events-2026-08-31T00-00-00Z.sql.gz'), 'gz-bytes')
  write(path.join(data, 'verdicts/curia-1.json'), '{ "verdict": "merge" }')
  write(path.join(data, 'tokens/curia-1'), 'a'.repeat(64), 0o600)
  write(path.join(data, 'previews.json'), '{}')
  write(path.join(data, 'deploy.log'), 'deploy log\n')
  write(path.join(data, 'deploy-last.json'), '{}')
  write(path.join(data, 'overseer/config/dead.json'), '{}')

  write(path.join(workspace, 'home/.codex/auth.json'), CODEX, 0o600)
  write(path.join(workspace, 'home/.config/gh/hosts.yml'), GH_HOSTS, 0o600)
  write(path.join(workspace, 'home/.gitconfig'), '[user]\n\tname = curia\n')
  write(path.join(workspace, 'home/.npm/_cacache/index'), 'cache')
  write(path.join(workspace, 'credentials/anthropic.json'), ANTHROPIC, 0o600)
  write(path.join(workspace, 'cfg/curia-1/.claude/projects/-w/session.jsonl'), '{"type":"user"}\n')
  write(path.join(workspace, 'cfg/curia-1/.credentials.json'), ANTHROPIC, 0o600)
  write(path.join(workspace, 'cfg/curia-1/gh/hosts.yml'), GH_HOSTS, 0o600)
  write(path.join(workspace, 'cfg/curia-1/gh/config.yml'), 'version: "1"\n')
  write(path.join(workspace, 'cfg/curia-overseer/projects/-w/turn.jsonl'), '{"type":"assistant"}\n')
  write(path.join(workspace, 'cfg/curia-overseer/home/notes.md'), 'overseer home\n')
  write(path.join(workspace, 'cfg/curia-overseer/.credentials.json'), ANTHROPIC, 0o600)
  write(path.join(workspace, 'repos/alp82__curia/wt/1/README.md'), 'worktree\n')
  write(path.join(workspace, 'archive/curia-0/README.md'), 'archived\n')
  write(path.join(workspace, 'overseer/repos/alp82__curia/HEAD'), 'ref: refs/heads/main\n')
  write(path.join(workspace, 'overseer/tokens/alp82'), ['ghs', 'placeholder'].join('_'), 0o600)
  write(path.join(workspace, 'tmux-1000/default'), '')
  return { checkout, workspace, commit }
}

// An installed target root, as `curia install` leaves it before setup.
function buildTarget(dir) {
  const root = path.join(dir, 'root')
  for (const b of ['config', 'secrets', 'state', 'work', 'versions', 'cache', 'run']) fs.mkdirSync(path.join(root, b), { recursive: true, mode: 0o700 })
  fs.chmodSync(root, 0o700)
  write(path.join(root, 'state/installation.json'), JSON.stringify({ format: 1, installationId: 'f'.repeat(32), activeVersion: '1.0.0' }), 0o600)
  write(path.join(root, 'config/config.yaml'), 'max_concurrent: 4\n', 0o600)
  return root
}

// Probes as the box answers them at admission: the daemon and its four
// sibling services up, no agent container, no live pane.
function idleProbes(commit) {
  return {
    containers: async () => [
      { name: 'curia-daemon-1', image: 'curia-daemon', status: 'Up 2 days' },
      { name: 'curia-tmux-1', image: 'curia-tmux', status: 'Up 3 weeks' },
    ],
    overview: async () => ({ ok: true, body: { agents: [{ session: 'curia-351', tmux_live: false }] } }),
    head: async () => commit,
  }
}

let scratch
before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-cutover-')) })
after(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

function fresh(name) {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir)
  return dir
}

describe('admission', () => {
  test('an idle source at the accepted commit with the expected layout is admitted', async () => {
    const { checkout, workspace, commit } = buildSource(fresh('admit-ok'))
    const result = await admit({ checkout, workspace, expectCommit: commit }, idleProbes(commit))
    assert.deepEqual(result.refusals, [])
    assert.equal(result.facts.commit, commit)
    assert.deepEqual(result.facts.envKeys['daemon/.env.daemon'], ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USERS', 'CURIA_GH_APP_ID', 'CURIA_GH_APP_KEY_FILE'])
  })

  test('a dirty checkout, another commit, a retired env key, and a live pane are each refused by name', async () => {
    const { checkout, workspace, commit } = buildSource(fresh('admit-refused'))
    write(path.join(checkout, 'README.md'), 'hand-edited\n')
    fs.appendFileSync(path.join(checkout, 'daemon/.env.daemon'), `CLAUDE_CODE_OAUTH_TOKEN=${['sk-ant-oat01', 'placeholder'].join('-')}\n`)
    const probes = idleProbes(commit)
    probes.overview = async () => ({ ok: true, body: { agents: [{ session: 'curia-351', tmux_live: true }] } })
    probes.containers = async () => [{ name: 'curia-351', image: 'curia-agent:x', status: 'Up 2 days' }]
    const result = await admit({ checkout, workspace, expectCommit: 'a'.repeat(40) }, probes)
    const text = result.refusals.join('\n')
    assert.match(text, /README\.md/)
    assert.match(text, new RegExp(`${commit}.*${'a'.repeat(40)}|${'a'.repeat(40)}.*${commit}`))
    assert.match(text, /CLAUDE_CODE_OAUTH_TOKEN/)
    assert.doesNotMatch(text, /placeholder/)
    assert.match(text, /curia-351/)
    assert.match(text, /live/)
  })

  test('an unexpected layout and an ambiguous path are refused', async () => {
    const { checkout, workspace, commit } = buildSource(fresh('admit-layout'))
    fs.rmSync(path.join(checkout, 'daemon/.curia-app.pem'))
    fs.symlinkSync(workspace, path.join(scratch, 'admit-layout', 'link'))
    const layout = await admit({ checkout, workspace, expectCommit: commit }, idleProbes(commit))
    assert.match(layout.refusals.join('\n'), /\.curia-app\.pem/)
    const ambiguous = await admit({ checkout, workspace: path.join(scratch, 'admit-layout', 'link'), expectCommit: commit }, idleProbes(commit))
    assert.deepEqual(ambiguous.refusals.length, 1)
    assert.match(ambiguous.refusals[0], /symbolic link/)
  })

  test('auto dispatch left on is refused, because new dispatches must be disabled first', async () => {
    const { checkout, workspace, commit } = buildSource(fresh('admit-auto'))
    write(path.join(checkout, 'config/curia.local.yaml'), 'dispatch:\n  max_concurrent: 10\n  auto_dispatch: true\nwatch:\n  - repo: alp82/curia\n')
    const result = await admit({ checkout, workspace, expectCommit: commit }, idleProbes(commit))
    assert.match(result.refusals.join('\n'), /auto_dispatch/)
  })
})

describe('evidence', () => {
  test('the stopped source yields a manifest with journal integrity and bounds, hashes for every preserved file, and secrets by name only', async () => {
    const { checkout, workspace, commit } = buildSource(fresh('inventory'))
    const probes = { ...idleProbes(commit), containers: async () => [] }
    const manifest = await inventory({ checkout, workspace, host: 'coinmatica', now: () => '2026-09-02T08:00:00Z' }, probes)
    assert.equal(manifest.format, 1)
    assert.equal(manifest.source.host, 'coinmatica')
    assert.equal(manifest.source.commit, commit)
    assert.equal(manifest.source.stopped, true)
    assert.deepEqual(manifest.journal, { integrity: 'ok', count: 3, minId: 1, maxId: 3, firstTs: '2026-08-01T10:00:00Z', lastTs: '2026-09-01T02:57:00Z' })
    const paths = manifest.files.map((f) => f.path)
    assert.ok(paths.includes('state/attachments/esc-28/screen.png'))
    assert.ok(paths.includes('state/results/curia-1.json'))
    assert.ok(paths.includes('state/backups/events-2026-08-31T00-00-00Z.sql.gz'))
    assert.ok(paths.includes('state/verdicts/curia-1.json'))
    assert.ok(paths.includes('state/routing.local.yaml'))
    assert.ok(paths.includes('work/cfg/curia-1/.claude/projects/-w/session.jsonl'))
    assert.ok(paths.includes('work/cfg/curia-overseer/projects/-w/turn.jsonl'))
    assert.ok(paths.includes('work/repos/alp82__curia/wt/1/README.md'))
    assert.ok(paths.includes('work/archive/curia-0/README.md'))
    for (const excluded of ['tokens', 'previews.json', 'deploy.log', 'deploy-last.json', 'overseer/config', '.credentials.json', 'gh/hosts.yml', 'overseer/repos', 'overseer/tokens', 'tmux-1000', '.npm']) {
      assert.ok(!paths.some((p) => p.includes(excluded)), `${excluded} is not preserved`)
    }
    for (const f of manifest.files) assert.match(f.sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(manifest.secrets.map((s) => s.name).sort(), ['anthropic.json', 'codex-auth.json', 'discord-bot-token', 'github-app.json'])
    for (const s of manifest.secrets) assert.deepEqual(Object.keys(s).sort(), ['mode', 'name', 'size', 'source'])
    assert.doesNotMatch(JSON.stringify(manifest), /placeholder|MTIz|PRIVATE KEY/)
  })

  test('a source still running is refused, so the manifest is evidence of a stopped deployment', async () => {
    const { checkout, workspace, commit } = buildSource(fresh('inventory-running'))
    await assert.rejects(inventory({ checkout, workspace, host: 'coinmatica' }, idleProbes(commit)), /curia-daemon-1.*running|running.*curia-daemon-1/)
  })
})

describe('transformation', () => {
  test('a copied source lands in the four preserved boundaries with secrets, facts, journal, and a migration marker', async () => {
    const dir = fresh('transform')
    const { checkout, workspace, commit } = buildSource(dir)
    const probes = { ...idleProbes(commit), containers: async () => [] }
    const manifest = await inventory({ checkout, workspace, host: 'coinmatica', now: () => '2026-09-02T08:00:00Z' }, probes)
    const root = buildTarget(dir)
    const result = await transform({ checkout, workspace, root, manifest, host: 'ubuntu-target', now: () => '2026-09-02T09:00:00Z' }, { targetContainers: async () => [] })
    assert.deepEqual(result.refusals, [])

    const config = readOperatorConfig(path.join(root, 'config/config.yaml'))
    assert.deepEqual(config, { max_concurrent: 10, watch: [{ repo: 'getalfredo/landing-page', mode: 'auto' }, { repo: 'alp82/curia', mode: 'auto' }, { repo: 'seen-is/seen-site', mode: 'map' }] })
    assert.equal(fs.readFileSync(path.join(root, 'secrets/discord-bot-token'), 'utf8'), `${DISCORD_TOKEN}\n`)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'secrets/github-app.json'), 'utf8')), { id: '1234567', pem: PEM })
    assert.equal(fs.readFileSync(path.join(root, 'secrets/anthropic.json'), 'utf8'), ANTHROPIC)
    assert.equal(fs.readFileSync(path.join(root, 'secrets/codex-auth.json'), 'utf8'), CODEX)
    for (const name of ['discord-bot-token', 'github-app.json', 'anthropic.json', 'codex-auth.json']) {
      assert.equal(fs.statSync(path.join(root, 'secrets', name)).mode & 0o777, 0o600, name)
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'state/discord.json'), 'utf8')), { allowed_users: ['123456789012345678', '234567890123456789'], guild_id: null, channel: 'curia' })
    assert.equal(fs.readFileSync(path.join(root, 'state/routing.local.yaml'), 'utf8'), 'defaults:\n  task:\n    model: gpt\n    effort: medium\n')

    const db = new DatabaseSync(path.join(root, 'state/events.db'), { readOnly: true })
    assert.deepEqual({ ...db.prepare('select min(id) lo, max(id) hi, count(*) n from events').get() }, { lo: 1, hi: 3, n: 3 })
    db.close()
    assert.ok(fs.existsSync(path.join(root, 'state/attachments/esc-28/screen.png')))
    assert.ok(fs.existsSync(path.join(root, 'state/backups/events-2026-08-31T00-00-00Z.sql.gz')))
    assert.ok(fs.existsSync(path.join(root, 'work/cfg/curia-overseer/projects/-w/turn.jsonl')))
    assert.ok(fs.existsSync(path.join(root, 'work/repos/alp82__curia/wt/1/README.md')))
    assert.ok(!fs.existsSync(path.join(root, 'work/cfg/curia-1/.credentials.json')))
    assert.ok(!fs.existsSync(path.join(root, 'work/cfg/curia-1/gh')))
    assert.ok(!fs.existsSync(path.join(root, 'state/tokens')))
    assert.ok(!fs.existsSync(path.join(root, 'state/previews.json')))
    assert.ok(!fs.existsSync(path.join(root, 'cache/home')))

    const marker = JSON.parse(fs.readFileSync(path.join(root, 'state', MIGRATION_FILE), 'utf8'))
    assert.equal(marker.format, 1)
    assert.equal(marker.source.host, 'coinmatica')
    assert.equal(marker.source.commit, commit)
    assert.equal(marker.migrated_at, '2026-09-02T09:00:00Z')
    assert.match(marker.manifest.sha256, /^[0-9a-f]{64}$/)
    assert.equal(fs.statSync(path.join(root, 'state', MIGRATION_FILE)).mode & 0o777, 0o600)
  })

  test('a target that already holds a journal or the Discord credential, or whose service is running, is refused with nothing written', async () => {
    const dir = fresh('transform-refused')
    const { checkout, workspace, commit } = buildSource(dir)
    const manifest = await inventory({ checkout, workspace, host: 'coinmatica' }, { ...idleProbes(commit), containers: async () => [] })
    const root = buildTarget(dir)
    write(path.join(root, 'secrets/discord-bot-token'), 'other\n', 0o600)
    const running = await transform({ checkout, workspace, root, manifest, host: 't' }, { targetContainers: async () => [{ name: 'curia-daemon-1', status: 'Up 1 minute' }] })
    assert.match(running.refusals.join('\n'), /curia-daemon-1/)
    assert.match(running.refusals.join('\n'), /discord-bot-token/)
    assert.ok(!fs.existsSync(path.join(root, 'state/events.db')))
    assert.ok(!fs.existsSync(path.join(root, 'config/config.yaml.tmp')))
    assert.equal(fs.readFileSync(path.join(root, 'config/config.yaml'), 'utf8'), 'max_concurrent: 4\n')
  })

  test('an override key with no place in the operator configuration is refused by name', async () => {
    const dir = fresh('transform-key')
    const { checkout, workspace, commit } = buildSource(dir)
    write(path.join(checkout, 'config/curia.local.yaml'), 'dispatch:\n  max_concurrent: 10\n  claim_login: someone\nidentity:\n  allow:\n    - a@b.c\n')
    const manifest = await inventory({ checkout, workspace, host: 'coinmatica' }, { ...idleProbes(commit), containers: async () => [] })
    const root = buildTarget(dir)
    const result = await transform({ checkout, workspace, root, manifest, host: 't' }, { targetContainers: async () => [] })
    const text = result.refusals.join('\n')
    assert.match(text, /claim_login/)
    assert.match(text, /identity/)
    assert.ok(!fs.existsSync(path.join(root, 'secrets/discord-bot-token')))
  })
})

describe('validation', () => {
  test('a transformed root passes every check against the manifest, and a tampered one names what changed', async () => {
    const dir = fresh('validate')
    const { checkout, workspace, commit } = buildSource(dir)
    const manifest = await inventory({ checkout, workspace, host: 'coinmatica' }, { ...idleProbes(commit), containers: async () => [] })
    const root = buildTarget(dir)
    await transform({ checkout, workspace, root, manifest, host: 't' }, { targetContainers: async () => [] })
    const sourcePaths = [checkout, workspace]

    const ok = await validate({ root, manifest, sourcePaths: [path.join(dir, 'absent-checkout')] })
    assert.deepEqual(ok.checks.filter((c) => c.status !== 'passed'), [])
    assert.deepEqual(ok.checks.map((c) => c.name), ['boundaries', 'configuration', 'secrets', 'discord', 'journal', 'files', 'migration', 'source-layout', 'source-paths'])

    fs.appendFileSync(path.join(root, 'state/results/curia-1.json'), 'x')
    fs.chmodSync(path.join(root, 'secrets/anthropic.json'), 0o644)
    write(path.join(root, 'work/cfg/curia-1/.credentials.json'), '{}')
    const bad = await validate({ root, manifest, sourcePaths })
    const failed = Object.fromEntries(bad.checks.filter((c) => c.status === 'failed').map((c) => [c.name, c.observed]))
    assert.match(failed.files, /state\/results\/curia-1\.json/)
    assert.match(failed.secrets, /anthropic\.json.*0644/)
    assert.match(failed['source-layout'], /\.credentials\.json/)
    assert.match(failed['source-paths'], new RegExp(checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

describe('the command line', () => {
  function run(args, cwd) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  }

  test('admit, inventory, transform, and validate run in order on a copied source and print no secret', async () => {
    const dir = fresh('cli')
    const { checkout, workspace, commit } = buildSource(dir)
    const root = buildTarget(dir)
    const manifestFile = path.join(dir, 'manifest.json')
    const probes = path.join(dir, 'probes.mjs')
    // The dry run's host: no containers anywhere, no live pane.
    write(probes, 'export const containers = async () => []\nexport const targetContainers = async () => []\nexport const overview = async () => ({ ok: true, body: { agents: [] } })\n')
    const env = { ...process.env, CURIA_CUTOVER_PROBES: probes }

    const admitted = spawnSync(process.execPath, [SCRIPT, 'admit', '--checkout', checkout, '--workspace', workspace, '--commit', commit], { encoding: 'utf8', env })
    assert.equal(admitted.status, 0, admitted.stderr + admitted.stdout)
    assert.match(admitted.stdout, /admitted/)

    const refused = spawnSync(process.execPath, [SCRIPT, 'admit', '--checkout', checkout, '--workspace', workspace, '--commit', 'b'.repeat(40)], { encoding: 'utf8', env })
    assert.equal(refused.status, 3)
    assert.match(refused.stderr, /refused/)

    const inv = spawnSync(process.execPath, [SCRIPT, 'inventory', '--checkout', checkout, '--workspace', workspace, '--host', 'coinmatica', '--out', manifestFile], { encoding: 'utf8', env })
    assert.equal(inv.status, 0, inv.stderr + inv.stdout)
    assert.ok(fs.existsSync(manifestFile))
    assert.equal(fs.statSync(manifestFile).mode & 0o777, 0o600)

    const tr = spawnSync(process.execPath, [SCRIPT, 'transform', '--checkout', checkout, '--workspace', workspace, '--root', root, '--manifest', manifestFile, '--host', 'target'], { encoding: 'utf8', env })
    assert.equal(tr.status, 0, tr.stderr + tr.stdout)

    const val = spawnSync(process.execPath, [SCRIPT, 'validate', '--root', root, '--manifest', manifestFile, '--absent', path.join(dir, 'nowhere')], { encoding: 'utf8', env })
    assert.equal(val.status, 0, val.stderr + val.stdout)
    assert.match(val.stdout, /passed/)

    const everything = [admitted, refused, inv, tr, val].map((r) => r.stdout + r.stderr).join('\n')
    assert.doesNotMatch(everything, /placeholder|MTIz|PRIVATE KEY|123456789012345678/)

    const usage = run(['nonsense'], dir)
    assert.equal(usage.status, 2)
  })

  test('the accepted source commit and the exclusion list are stated by the module', () => {
    assert.match(ACCEPTED_SOURCE_COMMIT, /^[0-9a-f]{40}$/)
    assert.ok(EXCLUDED.length > 0)
  })
})

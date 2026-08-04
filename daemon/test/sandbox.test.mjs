// The worker sandbox (#156, building the decision at #148): one container per
// worker, started by the tmux pane.
//
// Nothing here runs docker. What is worth pinning is everything that would be
// wrong SILENTLY: a path the worker is told that is not the path it can see, a
// secret on a command line instead of in an env file, a container left running
// when its pane died, and a skill set that resolves to nothing inside the
// container. The container itself is proved live on the box.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'

import { Dispatcher } from '../src/dispatch.mjs'
import { loadCuriaConfig, loadRoutingConfig, assertSandboxConfig } from '../src/config.mjs'
import {
  GUEST_CFG, GUEST_WT, GUEST_DAEMON_HOST, PORTS_PER_WORKER,
  allocatePorts, dockerGateway, dockerRunCmd, modelCredential, stopContainer, writeEnvFile,
} from '../src/sandbox.mjs'
import { installSkills, seedConfigDir, workerEnv } from '../src/workspace.mjs'

const PINS = {
  image: 'curia-worker',
  claude_version: '2.1.220',
  codex_version: '0.146.0',
  gh_version: '2.97.0',
  playwright_version: '1.62.1',
  agent_uid: 1000,
  ports: { from: 9000, to: 9299 },
}

let tmp

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-sandbox-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// ---- the command the pane runs -------------------------------------------------

describe('the docker run line (#156)', () => {
  const line = (over = {}) => dockerRunCmd({
    name: 'curia-42',
    ticket: '42',
    image: 'curia-worker:2.1.220-0.146.0-c6c38f36',
    cfgDir: '/home/alp/curia-work/cfg/curia-42',
    wtPath: '/home/alp/curia-work/repos/o__r/wt/42',
    envFile: '/home/alp/curia-work/cfg/curia-42/container.env',
    spawnCmd: 'claude --model opus "$(cat /cfg/prompt.md)"',
    ports: [9000, 9001, 9002],
    sandbox: PINS,
    ...over,
  })

  test('only the clone and the config dir are mounted from the host', () => {
    const cmd = line()
    assert.match(cmd, /-v \/home\/alp\/curia-work\/repos\/o__r\/wt\/42:\/workspace/)
    assert.match(cmd, /-v \/home\/alp\/curia-work\/cfg\/curia-42:\/cfg/)
    // the two shared caches, and nothing else of the box
    const mounts = [...cmd.matchAll(/-v (\S+)/g)].map((m) => m[1])
    assert.equal(mounts.length, 4)
    for (const m of mounts) {
      assert.ok(!m.startsWith('/home/alp:'), `${m} mounts the host HOME`)
      assert.ok(!m.includes('/tmp/tmux'), `${m} mounts the tmux socket`)
    }
  })

  test('the published ports are loopback only, and the same number on both sides', () => {
    assert.match(line(), /-p 127\.0\.0\.1:9000:9000 -p 127\.0\.0\.1:9001:9001 -p 127\.0\.0\.1:9002:9002/)
  })

  test('the environment rides a file, never the command line (#155)', () => {
    const cmd = line()
    assert.match(cmd, /--env-file \/home\/alp\/curia-work\/cfg\/curia-42\/container\.env/)
    assert.ok(!/ -e /.test(cmd), 'a value passed with -e would be visible in ps to every user on the box')
  })

  test('the daemon is reachable from inside, and the container is named after the session', () => {
    const cmd = line()
    assert.match(cmd, /--add-host host\.docker\.internal:host-gateway/)
    assert.match(cmd, /--name curia-42/)
    assert.match(cmd, /--label curia\.session=curia-42/)
  })

  test('the backend command is single-quoted, so $(cat …) expands inside the container', () => {
    assert.match(line(), /bash -c 'claude --model opus "\$\(cat \/cfg\/prompt\.md\)"'$/)
  })

  test('a backend template carrying a single quote is refused, not escaped', () => {
    assert.throws(() => line({ spawnCmd: "claude --model 'opus'" }), /single quote/)
  })

  test('a path that is not shell-safe is refused rather than quoted', () => {
    assert.throws(() => line({ wtPath: '/home/alp/curia work/wt/42' }), /not quote-free/)
    assert.throws(() => line({ image: 'curia-worker:latest; rm -rf /' }), /not quote-free/)
  })

  test('the container runs as the uid that owns the mounts', () => {
    assert.match(line(), /--user 1000:1000/)
  })
})

// ---- ports ---------------------------------------------------------------------

describe('container ports (#156)', () => {
  test('ports already handed to live workers are skipped', async () => {
    const got = await allocatePorts({ from: 9000, to: 9099 }, { taken: [9000, 9001], isFree: async () => true })
    assert.deepEqual(got, [9002, 9003, 9004])
  })

  test('a port something else already holds is skipped', async () => {
    const srv = net.createServer()
    await new Promise((r) => srv.listen({ port: 0, host: '127.0.0.1' }, r))
    const held = srv.address().port
    try {
      const got = await allocatePorts({ from: held, to: held + 8 })
      assert.ok(!got.includes(held), 'allocated a port another process is listening on')
      assert.equal(got.length, PORTS_PER_WORKER)
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })

  test('a range too small refuses rather than handing out fewer than three', async () => {
    await assert.rejects(
      allocatePorts({ from: 9000, to: 9001 }, { isFree: async () => true }),
      /no 3 free container ports/,
    )
  })
})

// ---- where the daemon listens for its containers -----------------------------------

describe('the docker host gateway (#156)', () => {
  const inspect = (json) => async () => ({ stdout: json })

  test('the gateway docker states is the one the daemon binds', async () => {
    const got = await dockerGateway({ exec: inspect('[{"Subnet":"172.17.0.0/16","Gateway":"172.17.0.1"}]') })
    assert.equal(got, '172.17.0.1')
  })

  test('a bridge that states only a subnet falls back to the interface inside it', async () => {
    // the deployment box, measured: docker 20.10 reports no Gateway, and
    // `--add-host host-gateway` inside a container there resolves to 10.0.1.1
    const got = await dockerGateway({
      exec: inspect('[{"Subnet":"10.0.1.0/24"}]'),
      interfaces: () => ({
        lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
        eth0: [{ family: 'IPv4', address: '5.6.7.8', internal: false }],
        docker0: [{ family: 'IPv4', address: '10.0.1.1', internal: false }],
      }),
    })
    assert.equal(got, '10.0.1.1')
  })

  test('nothing to bind refuses loudly rather than leaving the side channel unreachable', async () => {
    await assert.rejects(
      dockerGateway({ exec: inspect('[{"Subnet":"10.0.1.0/24"}]'), interfaces: () => ({}) }),
      /nowhere to listen/,
    )
  })
})

// ---- the env file ----------------------------------------------------------------

describe('the container env file (#156)', () => {
  test('it is written 0600, because it holds the model credential', () => {
    const file = writeEnvFile(path.join(tmp, 'container.env'), { GH_TOKEN: 'ghp_x' })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(file, 'utf8'), 'GH_TOKEN=ghp_x\n')
  })

  test('a reused config dir does not keep a looser mode from the last run', () => {
    const file = path.join(tmp, 'container.env')
    fs.writeFileSync(file, 'OLD=1\n', { mode: 0o644 })
    writeEnvFile(file, { GH_TOKEN: 'ghp_x' })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  test('a value carrying a newline is refused — docker would read it as a second variable', () => {
    assert.throws(() => writeEnvFile(path.join(tmp, 'container.env'), { X: 'a\nY=b' }), /newline/)
  })
})

describe('the model credential a container gets (#148)', () => {
  test('an API key outranks the OAuth token, the same order the usage probe uses (#162)', () => {
    assert.deepEqual(
      modelCredential('claude', { env: { ANTHROPIC_API_KEY: 'sk-1', CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' } }),
      { ANTHROPIC_API_KEY: 'sk-1' },
    )
    assert.deepEqual(
      modelCredential('claude', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' } }),
      { CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
    )
  })

  test('the stored credential is the last resort', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stored-1' } }))
    assert.deepEqual(modelCredential('claude', { env: {}, home: tmp }), { CLAUDE_CODE_OAUTH_TOKEN: 'stored-1' })
  })

  test('no credential anywhere refuses the spawn instead of starting a worker that cannot think', () => {
    assert.throws(() => modelCredential('claude', { env: {}, home: tmp }), /no anthropic credential/)
  })
})

// ---- teardown ----------------------------------------------------------------------

describe('container teardown (#156)', () => {
  test('"no such container" is positive absence, not a failure', async () => {
    const gone = await stopContainer('curia-42', {
      exec: async () => { const e = new Error('x'); e.stderr = 'Error: No such container: curia-42'; throw e },
    })
    assert.equal(gone, false)
  })

  test('any other docker failure is surfaced — a container still holding its ports is not nothing', async () => {
    await assert.rejects(stopContainer('curia-42', {
      exec: async () => { const e = new Error('x'); e.stderr = 'permission denied while trying to connect'; throw e },
    }), /could not remove container/)
  })
})

// ---- config ------------------------------------------------------------------------

describe('the sandbox switch (#156)', () => {
  const routingFile = (backendExtra) => {
    const file = path.join(tmp, 'routing.yaml')
    fs.writeFileSync(file, [
      'defaults: {untyped: opus}',
      'models: {opus: {provider: anthropic, backend: claude}}',
      'backends:',
      '  claude:',
      '    template: \'claude --model {model} "$(cat {prompt_file})"\'',
      "    ready: '⏵⏵'",
      ...backendExtra,
    ].join('\n'))
    return file
  }

  test('a backend with no switch runs the bare pane, exactly as before', () => {
    const cfg = loadRoutingConfig(routingFile([]))
    assert.equal(cfg.backends.claude.sandbox, 'none')
  })

  test('an unknown mode names the key rather than running an unknown containment', () => {
    assert.throws(() => loadRoutingConfig(routingFile(['    sandbox: firejail'])), /sandbox must be one of none\|docker/)
  })

  test('the switch on, with no image pins in curia.yaml, refuses at boot', () => {
    const routing = { backends: { claude: { sandbox: 'docker' } } }
    assert.throws(() => assertSandboxConfig({}, routing), /carries no `sandbox:` section/)
    assert.deepEqual(assertSandboxConfig({ sandbox: PINS }, routing), ['claude'])
  })

  test('a port range that cannot hold three ports per concurrent worker refuses', () => {
    assert.throws(() => curiaConfigWith({ port_from: 9000, port_to: 9003 }, tmp), /need 18/)
  })

  test('a range overlapping the preview ports refuses — docker and tailscale would fight for the listener', () => {
    assert.throws(() => curiaConfigWith({ port_from: 8550, port_to: 8850 }, tmp), /overlaps the preview range/)
  })

  test('a range swallowing an attach port refuses', () => {
    assert.throws(() => curiaConfigWith({ port_from: 7600, port_to: 7900 }, tmp), /would publish over it/)
  })
})

// A curia.yaml carrying the real sandbox block plus the overrides under test.
function curiaConfigWith(sandboxOver, dir) {
  const file = path.join(dir, 'curia.yaml')
  fs.writeFileSync(file, [
    'watch: [{repo: o/r}]',
    'dispatch:',
    '  auto_dispatch: false',
    '  max_concurrent: 6',
    '  poll_interval_s: 60',
    `  workspace_root: ${path.join(dir, 'work')}`,
    '  ready_timeout_s: 45',
    'attach: {ttyd_port: 7681, serve_port: 8443}',
    'identity: {allow: [a@b.c], proxy_port: 7682}',
    'timeline: {port: 4272, serve_port: 8444}',
    'preview: {port_from: 8500, port_to: 8599}',
    'skills: {install: []}',
    'sandbox:',
    '  image: curia-worker',
    '  claude_version: 2.1.220',
    '  codex_version: 0.146.0',
    '  gh_version: 2.97.0',
    '  playwright_version: 1.62.1',
    '  agent_uid: 1000',
    ...Object.entries(sandboxOver).map(([k, v]) => `  ${k}: ${v}`),
  ].join('\n'))
  return loadCuriaConfig(file)
}

// ---- what the worker is told ---------------------------------------------------------

describe('the worker sees its own paths (#156)', () => {
  test('the config dir a container reads is the mount point, and the host store is not named', () => {
    const env = workerEnv(GUEST_CFG, 'claude', { sandboxed: true })
    assert.equal(env.CLAUDE_CONFIG_DIR, GUEST_CFG)
    // The host store lives in the host HOME, which is what the boundary denies:
    // naming it would point the CLI at a path that is not mounted.
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined)
  })

  test('a bare pane still shares the host credential store (#53)', () => {
    assert.ok(workerEnv(path.join(tmp, 'cfg'), 'claude').CLAUDE_SECURESTORAGE_CONFIG_DIR)
  })

  test('skills are copied for a container, because a symlink into the host resolves to nothing there', () => {
    const root = path.join(tmp, 'skills')
    fs.mkdirSync(path.join(root, 'wayfinder'), { recursive: true })
    fs.writeFileSync(path.join(root, 'wayfinder', 'SKILL.md'), '# wayfinder\n')
    const cfgDir = path.join(tmp, 'cfg')
    fs.mkdirSync(cfgDir, { recursive: true })

    installSkills(cfgDir, { root, install: ['wayfinder'] }, { copy: true })
    const installed = path.join(cfgDir, 'skills', 'wayfinder')
    assert.equal(fs.lstatSync(installed).isSymbolicLink(), false)
    assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), '# wayfinder\n')

    installSkills(cfgDir, { root, install: ['wayfinder'] })
    assert.equal(fs.lstatSync(installed).isSymbolicLink(), true)
  })

  test('the claude seed trusts the path the worker will actually be in', () => {
    const cfgDir = path.join(tmp, 'cfg')
    seedConfigDir(cfgDir, GUEST_WT, null, 'claude', { sandboxed: true })
    const seeded = JSON.parse(fs.readFileSync(path.join(cfgDir, '.claude.json'), 'utf8'))
    assert.ok(seeded.projects[GUEST_WT]?.hasTrustDialogAccepted, 'a projects key that is not the cwd leaves the trust dialog up')
  })
})

// ---- the dispatch path ------------------------------------------------------------------

const SANDBOXED_ROUTING = {
  defaults: { untyped: 'opus' },
  models: { opus: { provider: 'anthropic', backend: 'claude' } },
  fallbacks: {},
  backends: {
    claude: {
      template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"',
      ready: '⏵⏵', readyRe: /⏵⏵/, sandbox: 'docker',
    },
  },
}

const ISSUE = { number: 42, title: 'a ticket', body: 'body text', state: 'open', assignees: [], labels: [] }

function makeDispatcher(deps = {}, { routing = SANDBOXED_ROUTING, sandbox = PINS, log = [] } = {}) {
  const root = path.join(tmp, 'work')
  const spawns = []
  const notifies = []
  const events = []
  const base = {
    viewerLogin: async () => 'me',
    fetchIssue: async () => ({ ...ISSUE }),
    claim: async () => {},
    unclaim: async () => {},
    hasSession: async () => false,
    listSessions: async () => [],
    newSession: async (opts) => { spawns.push(opts) },
    capturePane: async () => '',
    killSession: async () => {},
    // the sandbox's own workspace: a real directory with the tracker doc, and a
    // `.git` DIRECTORY, which is what tells a clone from a worktree
    createPrivateClone: async (r, repo, n) => {
      const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
      fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
      fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
      fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
      return wt
    },
    ensureBaseClone: async (r, repo) => path.join(r, 'repos', repo.replace('/', '__'), 'base'),
    createWorktree: async (b, n) => {
      const wt = path.join(path.dirname(b), 'wt', String(n))
      fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
      fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../../base/.git/worktrees/x\n')
      fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
      return wt
    },
    removeWorktree: async () => {},
    removeConfigDir: () => {},
    removeCredentials: () => {},
    ensureTtyd: async () => ({ verified: true }),
    assertServe: async () => {},
    serveOff: async () => {},
    defaultBranchOf: async () => 'main',
    hasUnpushedWork: async () => false,
    findPullRequest: async () => null,
    ensureWorkerImage: async () => ({ ref: 'curia-worker:test', built: false }),
    stopContainer: async () => true,
    listContainers: async () => [],
    allocatePorts: async () => [9000, 9001, 9002],
  }
  const d = new Dispatcher({
    config: {
      watch: [{ repo: 'o/r', mode: 'auto' }],
      dispatch: {
        auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
        workspace_root: root, ready_timeout_s: 1, stop_nudge_budget: 3,
      },
      attach: { ttyd_port: 7681, serve_port: 8443 },
      identity: { allow: ['a@b.c'], proxy_port: 7682 },
      skills: null,
      sandbox,
    },
    routing,
    store: { logEvent: (type, data) => { events.push({ type, ...data }); return { type } }, openEscalations: () => [], cancel: () => ({ ok: true }) },
    notify: (ticket, message) => notifies.push({ ticket, message }),
    log: (...a) => log.push(a.join(' ')),
    dataDir: path.join(tmp, 'data'),
    daemonPort: 4271,
    deps: { ...base, ...deps },
  })
  d.identityProxy = { listening: true }
  return { d, spawns, notifies, events }
}

describe('a sandboxed dispatch (#156)', () => {
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-test' })
  afterEach(() => { delete process.env.ANTHROPIC_API_KEY })

  test('the pane runs docker, with the image, the mounts and the ports', async () => {
    const { d, spawns } = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    assert.equal(spawns.length, 1)
    assert.match(spawns[0].shellCmd, /^docker run --rm -i -t --init /)
    assert.match(spawns[0].shellCmd, /curia-worker:test bash -c 'claude --model opus/)
    assert.match(spawns[0].shellCmd, /-p 127\.0\.0\.1:9000:9000/)
    assert.match(spawns[0].shellCmd, new RegExp(`:${GUEST_WT}`))
  })

  test('the pane environment is EMPTY — the container carries its own (#155)', async () => {
    const { d, spawns } = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    assert.deepEqual(spawns[0].env, {})
  })

  test('the prompt tells the worker the path it can actually see', async () => {
    const { d } = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    const prompt = fs.readFileSync(path.join(tmp, 'work', 'cfg', 'curia-42', 'prompt.md'), 'utf8')
    assert.match(prompt, new RegExp(`Your worktree is ${GUEST_WT}`))
    assert.ok(!prompt.includes(path.join(tmp, 'work', 'repos')), 'the prompt names a host path the container cannot reach')
  })

  test('the side channel points at the docker host gateway, not at the container itself', async () => {
    const { d } = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    const wt = path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42')
    const mcp = JSON.parse(fs.readFileSync(path.join(wt, '.mcp.json'), 'utf8'))
    assert.match(mcp.mcpServers.curia.url, new RegExp(`^http://${GUEST_DAEMON_HOST}:4271/mcp`))
    const settings = JSON.parse(fs.readFileSync(path.join(wt, '.claude', 'settings.json'), 'utf8'))
    assert.match(settings.hooks.Stop[0].hooks[0].command, new RegExp(GUEST_DAEMON_HOST))
  })

  test('the env file holds the credential and the scoped token, and the pane holds neither', async () => {
    const { d, spawns } = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    const env = fs.readFileSync(path.join(tmp, 'work', 'cfg', 'curia-42', 'container.env'), 'utf8')
    assert.match(env, /ANTHROPIC_API_KEY=sk-test/)
    assert.match(env, /CLAUDE_CONFIG_DIR=\/cfg/)
    assert.match(env, /HOME=\/home\/agent/)
    assert.ok(!spawns[0].shellCmd.includes('sk-test'), 'the credential reached the command line')
  })

  test('the workspace is a private clone, never a worktree of the shared base', async () => {
    let worktrees = 0
    let clones = 0
    const { d } = makeDispatcher({
      createWorktree: async () => { worktrees += 1; throw new Error('should not be called') },
      createPrivateClone: async (r, repo, n) => {
        clones += 1
        const wt = path.join(r, 'repos', repo.replace('/', '__'), 'wt', String(n))
        fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
        fs.mkdirSync(path.join(wt, '.git'), { recursive: true })
        fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '#\n')
        return wt
      },
    })
    await d.start('42', { repo: 'o/r' })
    assert.equal(clones, 1)
    assert.equal(worktrees, 0)
  })

  test('a resume onto a surviving BARE worktree refuses instead of mounting a broken repository', async () => {
    const { d } = makeDispatcher()
    // what the bare path leaves behind: a `.git` FILE pointing into the base
    const wt = path.join(tmp, 'work', 'repos', 'o__r', 'wt', '42')
    fs.mkdirSync(path.join(wt, 'docs', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../../base/.git/worktrees/42\n')
    fs.writeFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), '#\n')

    const reply = await d.start('42', { repo: 'o/r', reuse: true })
    assert.match(reply, /a container cannot use one/)
    assert.match(reply, /claim released/)
  })

  test('the journal records the image and the ports a restart cannot re-derive', async () => {
    const { d, events } = makeDispatcher()
    await d.start('42', { repo: 'o/r' })
    const spawned = events.find((e) => e.type === 'worker_spawned')
    assert.equal(spawned.sandbox, 'docker')
    assert.equal(spawned.image, 'curia-worker:test')
    assert.deepEqual(spawned.ports, [9000, 9001, 9002])
  })

  test('every ordered teardown removes the container, because it outlives the pane', async () => {
    const stopped = []
    const { d } = makeDispatcher({ stopContainer: async (name) => { stopped.push(name); return true } })
    await d.start('42', { repo: 'o/r' })
    await d.cancel('42', { by: 'test' })
    assert.deepEqual(stopped, ['curia-42'])
  })

  test('a container whose pane is gone is swept at reconcile', async () => {
    const stopped = []
    const { d, events } = makeDispatcher({
      listContainers: async () => ['curia-7', 'curia-9'],
      listSessions: async () => ['curia-9'],
      stopContainer: async (name) => { stopped.push(name); return true },
    })
    await d.reconcile({ boot: false })
    // curia-9 has a live pane, so it is swept as an ordinary session orphan
    // (nothing on GitHub claims it) — that path takes its container with it.
    // curia-7 has no pane at all, and only this sweep can see it.
    assert.ok(stopped.includes('curia-7'))
    assert.ok(events.some((e) => e.type === 'orphan_container_swept' && e.worker === 'curia-7'))
    assert.ok(!events.some((e) => e.type === 'orphan_container_swept' && e.worker === 'curia-9'))
  })

  test('no docker at all on a bare-lane box: nothing calls it', async () => {
    const { d } = makeDispatcher(
      { stopContainer: async () => { throw new Error('docker was called') }, listContainers: async () => { throw new Error('docker was called') } },
      { routing: { ...SANDBOXED_ROUTING, backends: { claude: { ...SANDBOXED_ROUTING.backends.claude, sandbox: 'none' } } }, sandbox: undefined },
    )
    await d.start('42', { repo: 'o/r' })
    await d.cancel('42', { by: 'test' })
    await d.reconcile({ boot: false })
  })
})

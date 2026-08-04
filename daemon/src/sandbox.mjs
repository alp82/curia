// The worker sandbox (#156, building the decision at #148): one docker
// container per worker, started BY THE TMUX PANE rather than beside it.
//
//   tmux pane → docker run -it --rm --name curia-<n> <image> bash -c '<backend>'
//
// The pane owning the container is what keeps every existing surface working
// unchanged: capture-pane still reads the TUI, send-keys still drives it, the
// ttyd attach still shows it, and the readiness watchdog still reads the same
// composer marker. Nothing above the pane learns that a container exists.
//
// What the container denies is everything the bare pane granted by default:
// the host HOME (~/.ssh, ~/.claude, ~/.codex, ~/.config/gh), the daemon's own
// checkout, secrets and journal, every sibling worker's clone and config dir,
// and the tmux socket — a repeat of #141, where a worker's own test suite ran
// `tmux kill-server` against the live socket, becomes impossible.
//
// Only two host directories are mounted, both writable, both prepared by the
// daemon: the worker's private clone and its config dir. The network stays
// open, because `gh` and web reach are what wayfinder runs on (#148); the
// containment comes from the small readable set, not from egress rules.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileP } from './exec.mjs'
import { DOCKER_BIN } from './image.mjs'

// Where the two mounts land inside the container. `/workspace` is the image's
// own WORKDIR and its `curia.workdir` label; `/cfg` is this file's choice, and
// a bind mount inherits the host directory's ownership, so it arrives owned by
// the agent uid with no chown in the image.
export const GUEST_WT = '/workspace'
export const GUEST_CFG = '/cfg'

// The hostname the container reaches the daemon on. Docker resolves
// `host-gateway` itself (`--add-host` below), so the container needs no
// knowledge of the bridge address — but the DAEMON does, because a listener
// bound to 127.0.0.1 is not reachable from any container. See dockerGateway().
export const GUEST_DAEMON_HOST = 'host.docker.internal'

// The per-worker env, written for `--env-file` rather than passed as `-e`.
// #155 found the cost of the other shape: a token on the command line is
// visible in `ps` to every user on the box, and that ticket's own resolution
// asked #156 not to repeat it. Mode 0600, and inside the config dir so the
// ordinary config-dir sweep collects it.
export const ENV_FILE = 'container.env'

// A value safe to interpolate into the pane's shell command. Same discipline as
// routing.mjs's SAFE_SUBSTITUTION: the whole `docker run` line is nested inside
// `bash -c '<cmd>; exec bash'`, so every substituted value is asserted rather
// than trusted. Paths here are daemon-generated under workspace_root.
const SAFE_ARG = /^[A-Za-z0-9._:/@=-]+$/

function assertSafe(name, value) {
  if (!SAFE_ARG.test(String(value ?? ''))) {
    throw new Error(`refusing to put ${name} on the docker command line: "${value}" is not quote-free/shell-safe`)
  }
  return String(value)
}

// The two shared cache volumes (#148): what is too heavy to bake into the image
// and too heavy to download per ticket. Named off the image repo so a second
// image on the same box gets its own. Cross-worker cache poisoning is the
// accepted risk #148 named.
export function cacheVolumes(sandbox) {
  const base = sandbox.image ?? 'curia-worker'
  return [
    { volume: `${base}-npm-cache`, mount: '/cache/npm' },
    { volume: `${base}-browsers`, mount: '/cache/playwright-browsers' },
  ]
}

// ---- ports -------------------------------------------------------------------

// Three published ports per worker (#148). They are published as
// `127.0.0.1:<p>:<p>` — the same number on both sides, so the port a worker
// binds inside the container is the port `publish_preview` (#157) sees on the
// host, and the worker can be told three plain numbers.
export const PORTS_PER_WORKER = 3

// Loopback ports the containers publish into. Deliberately far from the preview
// Serve range (8500-8599): those are tailnet-facing HTTPS ports on the host,
// these are the plain http ports a Serve rule points AT.
export const DEFAULT_CONTAINER_PORTS = { from: 9000, to: 9299 }

// Can this daemon bind the port right now? A bind test, not a dial: a dial says
// "nothing answered", which is also what a port held by a listener that is not
// accepting says. Binding is the question actually being asked, because docker
// is about to bind it.
export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)))
  })
}

// The first `count` ports in the range that nothing else claims. `taken` is
// what the daemon has already handed to other live workers — the in-memory
// half — and the bind probe covers everything else on the box, including a
// container this process did not start.
//
// Refuses rather than overlapping: two workers publishing the same host port
// means the second container never starts, and the failure would land on a
// dispatch that had already claimed its ticket.
export async function allocatePorts(range, { count = PORTS_PER_WORKER, taken = [], isFree = portFree } = {}) {
  const used = new Set(taken)
  const out = []
  for (let p = range.from; p <= range.to && out.length < count; p += 1) {
    if (used.has(p)) continue
    if (!(await isFree(p))) continue
    out.push(p)
  }
  if (out.length < count) {
    throw new Error(`no ${count} free container ports in ${range.from}-${range.to} — every worker publishes ${count}, so the range must hold at least ${count} per concurrent worker`)
  }
  return out
}

// ---- the daemon's own reachability ---------------------------------------------

// The address a container reaches this box on. The daemon's loopback surface —
// the MCP side channel and the Stop hook — is bound to 127.0.0.1, which inside
// a container is the container itself. So the daemon binds a SECOND listener on
// the docker bridge gateway, and the container reaches it as
// `host.docker.internal`, which docker resolves to the same address.
//
// Read from docker rather than hard-coded: 172.17.0.1 is only the default, and
// a box whose bridge was configured differently would get a daemon listening
// where no container looks.
export async function dockerGateway({ exec = execFileP, interfaces = os.networkInterfaces } = {}) {
  const { stdout } = await exec(DOCKER_BIN, [
    'network', 'inspect', 'bridge', '--format', '{{json .IPAM.Config}}',
  ], { timeout: 15_000 })
  let config = []
  try {
    config = JSON.parse(stdout.trim()) ?? []
  } catch {
    throw new Error(`docker described its default bridge network in a shape curia cannot read: ${stdout.trim().slice(0, 200)}`)
  }
  const stated = config.map((c) => c?.Gateway).find(Boolean)
  if (stated) return stated
  // A box that never configured one states only the SUBNET — measured on the
  // deployment box, whose docker 20.10 reports `{"Subnet":"10.0.1.0/24"}` and
  // nothing else, while `--add-host host-gateway` inside a container there
  // resolves to 10.0.1.1. That address belongs to the host's own bridge
  // interface, so it is read from the interface rather than guessed as "the
  // first address in the subnet" — the guess is right today and is not a fact.
  const addresses = Object.values(interfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
  for (const { Subnet } of config) {
    const host = addresses.find((a) => inSubnet(a.address, Subnet))
    if (host) return host.address
  }
  throw new Error('docker\'s default bridge network states no gateway address, and no interface on this box sits in its subnet — the daemon has nowhere to listen for its containers')
}

// IPv4 CIDR membership, which is all this file needs and all node offers no
// helper for.
function inSubnet(address, cidr) {
  const [net, bits] = String(cidr ?? '').split('/')
  const width = Number(bits)
  if (!net || !Number.isInteger(width) || width < 0 || width > 32) return false
  const toInt = (ip) => ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0)
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(net) || !/^(\d{1,3}\.){3}\d{1,3}$/.test(address)) return false
  const mask = width === 0 ? 0 : (-1 << (32 - width)) >>> 0
  return ((toInt(address) & mask) >>> 0) === ((toInt(net) & mask) >>> 0)
}

// ---- the container's environment ------------------------------------------------

// The claude lane's credential, as the container gets it (#148: the model
// credential is the sole remaining host secret that enters). The container
// cannot share the host store the way a bare pane does (#53) — the store is in
// the host HOME, which is exactly what the boundary denies — so the token is
// COPIED into the container env, and it is frozen for the worker's life.
//
// Same precedence as the usage probe (#162), and for the same reason: a box
// carrying an API key authenticates with it everywhere else, so a worker
// authenticating differently would be a second lineage to reason about. The
// stored access token comes last, because it is the one that expires soonest —
// a worker outliving it dies mid-ticket, which is the frozen-credential failure
// #53 fixed for the bare path and #148 accepted back for the container.
export function modelCredential(backend, { env = process.env, home = null } = {}) {
  if (backend !== 'claude') return {}
  if (env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }
  const stored = readStoredOauth(home)
  if (stored) return { CLAUDE_CODE_OAUTH_TOKEN: stored }
  throw new Error('no anthropic credential for the container: set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in daemon/.env, or run `claude /login` on this box — a sandboxed claude worker cannot reach the host credential store')
}

function readStoredOauth(home) {
  const file = path.join(home ?? process.env.HOME ?? '', '.claude', '.credentials.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

// docker reads an env file as plain `KEY=VALUE` lines and takes the value
// literally to the end of the line — no quoting, no escapes. So a value
// carrying a newline would silently become a second variable, and one carrying
// none needs no quoting at all.
export function writeEnvFile(file, env) {
  const lines = []
  for (const [k, v] of Object.entries(env)) {
    const value = String(v)
    if (/[\n\r]/.test(value)) {
      throw new Error(`refusing to write ${k} into the container env file: the value carries a newline, which docker would read as a second variable`)
    }
    lines.push(`${k}=${value}`)
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
  // writeFileSync applies the mode only when it CREATES the file; a config dir
  // reused across dispatches already holds one from the last run.
  fs.chmodSync(file, 0o600)
  return file
}

// ---- the command the pane runs ---------------------------------------------------

// The `docker run` line, as one shell command for tmux.newSession.
//
// The backend command rides inside SINGLE quotes, which is what keeps the two
// shells apart: the host shell passes the string through untouched, and the
// `$(cat /cfg/prompt.md)` in every backend template expands inside the
// CONTAINER, against the prompt file at its guest path. A template carrying a
// single quote of its own would break that, so it is refused rather than
// escaped — the two shipped templates carry none, and an escaping scheme here
// would be a second quoting rule for a human to get wrong.
export function dockerRunCmd({
  name, image, cfgDir, wtPath, envFile, spawnCmd, ports = [], sandbox, ticket = null, docker = DOCKER_BIN,
}) {
  if (String(spawnCmd ?? '').includes("'")) {
    throw new Error(`refusing to run the ${name} backend command inside a container: it carries a single quote, and the container command is single-quoted (see routing.yaml)`)
  }
  const argv = [
    docker, 'run', '--rm', '-i', '-t', '--init',
    '--name', assertSafe('the container name', name),
    '--hostname', assertSafe('the container name', name),
    // The uid must be the host user that owns the two mounts, or the worker
    // cannot write its own worktree (#154 §3). The image is built for the same
    // uid; stating it here as well means an image built elsewhere cannot
    // silently give a worker a read-only clone.
    '--user', `${assertSafe('agent_uid', sandbox.agent_uid)}:${assertSafe('agent_uid', sandbox.agent_uid)}`,
    '--workdir', GUEST_WT,
    '-v', `${assertSafe('the worktree path', wtPath)}:${GUEST_WT}`,
    '-v', `${assertSafe('the config dir', cfgDir)}:${GUEST_CFG}`,
  ]
  for (const { volume, mount } of cacheVolumes(sandbox)) {
    argv.push('-v', `${assertSafe('a cache volume', volume)}:${mount}`)
  }
  argv.push('--env-file', assertSafe('the env file', envFile))
  // How the Stop hook and the MCP side channel get back to the daemon.
  argv.push('--add-host', `${GUEST_DAEMON_HOST}:host-gateway`)
  for (const p of ports) {
    argv.push('-p', `127.0.0.1:${assertSafe('a published port', p)}:${assertSafe('a published port', p)}`)
  }
  argv.push('--label', `curia.session=${assertSafe('the container name', name)}`)
  if (ticket !== null) argv.push('--label', `curia.ticket=${assertSafe('the ticket', ticket)}`)
  argv.push(assertSafe('the image', image), 'bash', '-c', `'${spawnCmd}'`)
  return argv.join(' ')
}

// ---- teardown --------------------------------------------------------------------

// A container can outlive the `docker run` client that started it, and both
// halves of that were measured. An ordinary `tmux kill-session` DOES take it
// down: the client forwards the signal, the process inside exits, and `--rm`
// collects the container. A client that dies without forwarding anything — a
// SIGKILL, a crash, a box that lost its tmux server — leaves the container
// running with nothing attached, holding its ports and its mounts.
//
// So every ordered teardown removes it explicitly, and reconcile sweeps what
// nothing ordered. "No such container" is POSITIVE ABSENCE — the common case,
// since the signal path usually got there first — and never an error.
export async function stopContainer(name, { exec = execFileP, docker = DOCKER_BIN } = {}) {
  try {
    await exec(docker, ['rm', '--force', name], { timeout: 30_000 })
    return true
  } catch (e) {
    const detail = `${e.stderr ?? ''}${e.message ?? ''}`
    if (/No such container|no such container|is not running/i.test(detail)) return false
    if (e.code === 'ENOENT') return false // no docker on this box: nothing of ours runs
    throw new Error(`could not remove container ${name}: ${detail.trim().split('\n')[0]}`)
  }
}

// Every container curia started that is still running, by session name. Docker
// is the state home for this: the in-memory worker map is a cache (#9), and a
// restarted daemon has to be able to find the containers its predecessor left.
export async function listContainers({ exec = execFileP, docker = DOCKER_BIN } = {}) {
  try {
    const { stdout } = await exec(docker, [
      'ps', '--filter', 'label=curia.session', '--format', '{{.Label "curia.session"}}',
    ], { timeout: 15_000 })
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw new Error(`could not list curia containers: ${(e.stderr ?? e.message ?? '').trim().split('\n')[0]}`)
  }
}

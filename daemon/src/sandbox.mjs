// The agent sandbox (#156, building the decision at #148): one docker
// container per agent, started BY THE TMUX PANE rather than beside it.
//
//   tmux pane → docker run -it --rm --name curia-<n> <image> bash -c '<harness>'
//
// The pane owning the container is what keeps every existing surface working
// unchanged: capture-pane still reads the TUI, send-keys still drives it, the
// ttyd attach still shows it, and the readiness watchdog still reads the same
// composer marker. Nothing above the pane learns that a container exists.
//
// What the container denies is everything the bare pane granted by default:
// the host HOME (~/.ssh, ~/.claude, ~/.codex, ~/.config/gh), the daemon's own
// checkout, secrets and journal, every sibling agent's clone and config dir,
// and the tmux socket — a repeat of #141, where an agent's own test suite ran
// `tmux kill-server` against the live socket, becomes impossible.
//
// Only two host directories are mounted, both writable, both prepared by the
// daemon: the agent's private clone and its config dir. The network stays
// open, because `gh` and web reach are what wayfinder runs on (#148); the
// containment comes from the small readable set, not from egress rules.

import dgram from 'node:dgram'
import fs from 'node:fs'
import net from 'node:net'
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

// The per-agent env, written for `--env-file` rather than passed as `-e`.
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
// image on the same box gets its own. Cross-agent cache poisoning is the
// accepted risk #148 named.
export function cacheVolumes(sandbox) {
  const base = sandbox.image ?? 'curia-agent'
  return [
    { volume: `${base}-npm-cache`, mount: '/cache/npm' },
    { volume: `${base}-browsers`, mount: '/cache/playwright-browsers' },
  ]
}

// ---- ports -------------------------------------------------------------------

// Three published ports per agent (#148). They are published as
// `127.0.0.1:<p>:<p>` — the same number on both sides, so the port an agent
// binds inside the container is the port `publish_preview` (#157) sees on the
// host, and the agent can be told three plain numbers.
export const PORTS_PER_AGENT = 3

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
// what the daemon has already handed to other live agents — the in-memory
// half — and the bind probe covers everything else on the box, including a
// container this process did not start.
//
// Refuses rather than overlapping: two agents publishing the same host port
// means the second container never starts, and the failure would land on a
// dispatch that had already claimed its ticket.
export async function allocatePorts(range, { count = PORTS_PER_AGENT, taken = [], isFree = portFree } = {}) {
  const used = new Set(taken)
  const out = []
  for (let p = range.from; p <= range.to && out.length < count; p += 1) {
    if (used.has(p)) continue
    if (!(await isFree(p))) continue
    out.push(p)
  }
  if (out.length < count) {
    throw new Error(`no ${count} free container ports in ${range.from}-${range.to} — every agent publishes ${count}, so the range must hold at least ${count} per concurrent agent`)
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
export async function dockerGateway({ exec = execFileP, sourceAddress = sourceAddressFor } = {}) {
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
  // resolves to 10.0.1.1. So the address is read off this box rather than
  // guessed as "the first address in the subnet" — the guess is right today and
  // is not a fact.
  //
  // The read is a ROUTE lookup (sourceAddressFor), and #188 is why. Reading the
  // interface list instead answers only while a container is attached, which is
  // the one moment the daemon does not need the answer.
  for (const { Subnet } of config) {
    const probe = addressInSubnet(Subnet, 1)
    if (!probe) continue
    const source = await sourceAddress(probe)
    // The answer counts only if it SITS in the subnet it was asked about. A box
    // with no route to the bridge falls through to its default route, and that
    // answer is the box's PUBLIC address — binding the agent routes there
    // would publish them to the internet instead of to the containers.
    if (source && inSubnet(source, Subnet)) return source
  }
  throw new Error('docker\'s default bridge network states no gateway address, and this box has no route into its subnet — the daemon has nowhere to listen for its containers')
}

// Which of this box's addresses faces `target`, asked of the kernel's routing
// table rather than of the interface list. A UDP `connect` SENDS NOTHING: it is
// a route lookup plus a local bind, and the socket's own address is then the
// source the kernel would put on a packet to that target.
//
// This is the read #188 turns on. `os.networkInterfaces()` cannot answer it,
// because libuv lists an interface only when IFF_UP *and* IFF_RUNNING are set,
// and docker leaves `docker0` NO-CARRIER while no container is attached — the
// address stays assigned and the route stays in the table, but node stops
// seeing the interface. Measured on the deployment box in exactly that state:
// `os.networkInterfaces().docker0` is undefined, `ip route` states
// `10.0.1.0/24 ... src 10.0.1.1 linkdown`, and this returns 10.0.1.1.
//
// Never throws: an unroutable target is an answer of "none", and the caller
// decides what that means.
export function sourceAddressFor(target) {
  return new Promise((resolve) => {
    let sock
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { sock?.close() } catch { /* already closed */ }
      resolve(value)
    }
    try {
      sock = dgram.createSocket('udp4')
      sock.on('error', () => done(null))
      // Port 9 is discard, and no datagram is ever sent to it.
      sock.connect(9, target, () => {
        try {
          const address = sock.address()?.address ?? null
          // A target that does not resolve still fires this callback, with the
          // socket left on the wildcard. That is an unbound socket, not an
          // address this box holds.
          done(address === '0.0.0.0' ? null : address)
        } catch {
          done(null)
        }
      })
    } catch {
      done(null)
    }
  })
}

// The address `offset` steps into a CIDR — the probe target, not a claim about
// what lives there.
function addressInSubnet(cidr, offset) {
  const [network, bits] = String(cidr ?? '').split('/')
  const width = Number(bits)
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(network ?? '')) return null
  if (!Number.isInteger(width) || width < 0 || width > 30) return null
  const toInt = (ip) => ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0)
  const value = ((toInt(network) + offset) >>> 0)
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
}

// ---- proving the side channel ----------------------------------------------
//
// A bound listener is not a reachable one, and #185 paid for the difference: the
// daemon bound the gateway, ufw dropped every packet from the bridge, and the
// agent's request TIMED OUT rather than being refused. Nothing on the host side
// could see it. Only a request FROM A CONTAINER crosses the same path an agent's
// `ask_human` and Stop hook cross, so that is what the daemon sends.
//
// The route it asks for carries no state and no secret, and it is the one path
// on the container-facing listener that needs no agent token — there is no
// agent yet. `curl` is in the image (#154), and `--rm` collects the container
// whatever the answer.
export const PROBE_PATH = '/ping'
export const PROBE_MARK = 'curia-side-channel'
const PROBE_TIMEOUT_S = 5

export async function probeSideChannel({
  image, port, host = GUEST_DAEMON_HOST, exec = execFileP, docker = DOCKER_BIN,
} = {}) {
  const url = `http://${host}:${port}${PROBE_PATH}`
  let stdout = ''
  try {
    ({ stdout } = await exec(docker, [
      'run', '--rm', '--add-host', `${GUEST_DAEMON_HOST}:host-gateway`,
      '--entrypoint', 'curl', assertSafe('the image', image),
      '-sS', '-m', String(PROBE_TIMEOUT_S), url,
    ], { timeout: 60_000 }))
  } catch (e) {
    throw new Error(`${probeFailure(e)} (${url})`)
  }
  // Something answered. It has to be THIS daemon: the bind proves nobody else
  // holds the address on this box, and the marker proves nothing is proxying it.
  if (!String(stdout).includes(PROBE_MARK)) {
    throw new Error(`${url} is reachable from a container, but the answer is not curia's side channel — something else holds that address and port`)
  }
  return true
}

// curl states the failure mode in its exit code, and the two that matter point
// at different fixes. 28 is a timeout, which means the packets are DROPPED, and
// on this deployment box that was the firewall (docs/deploy.md carries the rule).
// 7 is a refusal, which means the packets arrive and nothing is listening.
function probeFailure(e) {
  const detail = `${e.stderr ?? ''}${e.message ?? ''}`.trim().split('\n')[0]
  if (e.code === 'ENOENT') return 'docker is not on this box, so no container can reach the daemon'
  if (e.code === 28 || /timed out|Operation timeout/i.test(detail)) {
    return 'a container cannot reach the daemon: the request timed out, so this box drops traffic from the docker bridge — see the ufw rule in docs/deploy.md'
  }
  if (e.code === 7 || /Failed to connect|Connection refused/i.test(detail)) {
    return 'a container cannot reach the daemon: the connection was refused, so the traffic arrives and the daemon is not listening on the bridge gateway'
  }
  return `a container cannot reach the daemon: ${detail}`
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

// THE MODEL CREDENTIAL NO LONGER RIDES THIS FILE (#648).
//
// It used to: `modelCredential(harness)` sat here and copied the host's
// anthropic token into the container's environment, which #148 accepted as the
// sandbox's one remaining host-secret exposure and #53 had already named as the
// frozen-credential failure. Three things it could not do — be replaced under a
// running agent, state an expiry, or be owned by anything — are the three this
// map exists for.
//
// What replaced it is a FILE the daemon writes into the config dir the container
// already mounts: `<cfgDir>/.credentials.json`, written by
// `writeClaudeCredentials` in credentials.mjs and rewritten by the dispatch
// tick's fan-out. #659 measured on the box that the CLI reads it in the
// sandboxed shape, that a good file rescues a dead environment variable, and
// that writing one into a running agent heals it with no restart.
//
// THE PRECEDENCE LADDER WENT WITH IT, all three rungs. `ANTHROPIC_API_KEY` is
// metered billing and the map settled subscription-only — a branch left in is an
// escape hatch left in. `CLAUDE_CODE_OAUTH_TOKEN` out of `process.env` is the
// value compose froze into the daemon at container create, which is the freeze
// itself. And the host `~/.claude` store is the operator's own file, which a
// container must not reach and a daemon must not hand out (#53).
//
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

// ---- the kill guard (#385) -------------------------------------------------------

// An agent's own kill can end its harness. The container shares one pid
// namespace, one uid owns every process in it, and the harness sits at the top
// of the agent's own ancestor chain — so `ps | grep | xargs kill` with a
// pattern from the ticket text resolved pid 7 and SIGTERM'd the session
// mid-ticket (curia-314). A harness-side guard covers single verbs; this one
// covers the effect: any exec'd `kill`/`pkill` whose resolved target is an
// ancestor of the killing process is aimed at the harness tree, and it is
// refused with the reason, whatever verb carried it.
//
// Ignoring SIGTERM instead was measured and does not hold: the claude CLI
// installs its own SIGTERM handler, which overrides an inherited SIG_IGN
// disposition, and the process exits 143 anyway.
//
// Delivery is the /cfg mount, not the image: the image digest covers only the
// Dockerfile bytes, so a COPYed script would drift silently, and a mounted
// guard is testable in this suite with plain bash. Three files under
// `<cfgDir>/bin`:
//
//   kill    — refuses a target pid (or process group) in its own ancestor set
//   pkill   — resolves the pattern with pgrep FIRST and refuses on a collision
//   bashenv.sh — sourced via BASH_ENV by every non-interactive bash: prepends
//     /cfg/bin to PATH and shadows the `kill` BUILTIN with the guard
//
// `bash -lc` (the codex tool shell) reads /etc/profile instead of BASH_ENV, so
// the agent image carries the same two lines in /etc/profile.d (Dockerfile).
// The whole guard is a bound against accident, not against the agent: the
// mount is writable and `command kill` bypasses a shell function. What it buys
// is that the observed pattern-kill fails loudly instead of ending the session.
//
// A signal of 0 always passes: `kill -0` is the standard liveness probe, and
// refusing it would break scripts that only ask.

export const GUEST_GUARD_ENV = `${GUEST_CFG}/bin/bashenv.sh`

const GUARD_ANCESTORS = `ancestors=" "
p=$$
while [ "\${p:-0}" -gt 0 ] 2>/dev/null; do
  ancestors="\$ancestors\$p "
  pp=""
  while read -r k v _; do
    if [ "\$k" = "PPid:" ]; then pp=\$v; break; fi
  done < "/proc/\$p/status" || break
  p=\$pp
done 2>/dev/null`

const GUARD_KILL = `#!/bin/bash
# curia kill guard (#385) — see daemon/src/sandbox.mjs
set -u
real=/bin/kill
[ -x "\$real" ] || real=/usr/bin/kill
${GUARD_ANCESTORS}
probe=false
expect_sig=false
opts_done=false
targets=()
for a in "\$@"; do
  if \$expect_sig; then expect_sig=false; [ "\$a" = 0 ] && probe=true; continue; fi
  if ! \$opts_done; then
    case "\$a" in
      --) opts_done=true; continue ;;
      -l|-l*|-L|--list*|--table) exec "\$real" "\$@" ;;
      -0) probe=true; continue ;;
      -s|--signal) expect_sig=true; continue ;;
      --signal=0) probe=true; continue ;;
      -[0-9]*|-[A-Za-z]*|--*) continue ;;
    esac
  fi
  targets+=("\$a")
done
if ! \$probe; then
  for t in \${targets[@]+"\${targets[@]}"}; do
    n=\${t#-}
    case "\$n" in ''|*[!0-9]*) continue ;; esac
    if [ "\$n" = 1 ]; then
      echo "curia: refusing \\\`kill \$t\\\`: that reaches the container's init, and the agent harness dies with it — killing your own harness ends this session (#385)" >&2
      exit 1
    fi
    case "\$ancestors" in *" \$n "*)
      echo "curia: refusing \\\`kill \$t\\\`: pid \$n is this command's own ancestor — the agent harness process tree. Killing it ends this session (#385)" >&2
      exit 1 ;;
    esac
  done
fi
exec "\$real" "\$@"
`

const GUARD_PKILL = `#!/bin/bash
# curia pkill guard (#385) — see daemon/src/sandbox.mjs
set -u
real=/usr/bin/pkill
pgrep_bin=/usr/bin/pgrep
${GUARD_ANCESTORS}
probe=false
skip=false
res=()
for a in "\$@"; do
  if \$skip; then skip=false; [ "\$a" = 0 ] && probe=true; continue; fi
  case "\$a" in
    --signal) skip=true; continue ;;
    --signal=*) [ "\${a#--signal=}" = 0 ] && probe=true; continue ;;
    -0) probe=true; continue ;;
    -[0-9]*|-SIG[A-Z]*|-[A-Z]*) continue ;;
  esac
  res+=("\$a")
done
pids=\$("\$pgrep_bin" \${res[@]+"\${res[@]}"} 2>/dev/null) || exec "\$real" "\$@"
if ! \$probe; then
  for t in \$pids; do
    case "\$ancestors" in *" \$t "*)
      echo "curia: refusing this pkill: the pattern resolves to pid \$t, this command's own ancestor — the agent harness process tree. Killing it ends this session (#385). Narrow the pattern (a [b]racketed first letter keeps it out of your own command line) or name the pid." >&2
      exit 1 ;;
    esac
  done
fi
exec "\$real" "\$@"
`

const GUARD_BASHENV = `# curia kill guard (#385) — sourced by every non-interactive bash (BASH_ENV).
# Login shells read /etc/profile.d/curia-kill-guard.sh instead (agent image).
if [ -d ${GUEST_CFG}/bin ]; then
  case ":\$PATH:" in *":${GUEST_CFG}/bin:"*) ;; *) export PATH="${GUEST_CFG}/bin:\$PATH" ;; esac
fi
if [ -x ${GUEST_CFG}/bin/kill ]; then kill() { ${GUEST_CFG}/bin/kill "\$@"; }; fi
`

// Written on every dispatch, like the env file beside it: the config dir is
// reused across dispatches and across the cross-harness respawn, and the guard
// must be the current one, not whatever the last daemon version left.
export function seedKillGuard(cfgDir) {
  const bin = path.join(cfgDir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const [name, content, mode] of [
    ['kill', GUARD_KILL, 0o755],
    ['pkill', GUARD_PKILL, 0o755],
    ['bashenv.sh', GUARD_BASHENV, 0o644],
  ]) {
    const file = path.join(bin, name)
    fs.writeFileSync(file, content, { mode })
    fs.chmodSync(file, mode) // the mode applies only on create; the dir is reused
  }
  return bin
}

// ---- the command the pane runs ---------------------------------------------------

// The `docker run` line, as one shell command for tmux.newSession.
//
// The harness command rides inside SINGLE quotes, which is what keeps the two
// shells apart: the host shell passes the string through untouched, and the
// `$(cat /cfg/prompt.md)` in every harness template expands inside the
// CONTAINER, against the prompt file at its guest path. A template carrying a
// single quote of its own would break that, so it is refused rather than
// escaped — the two shipped templates carry none, and an escaping scheme here
// would be a second quoting rule for a human to get wrong.
export function dockerRunCmd({
  name, image, cfgDir, wtPath, envFile, spawnCmd, ports = [], sandbox, ticket = null, docker = DOCKER_BIN,
}) {
  if (String(spawnCmd ?? '').includes("'")) {
    throw new Error(`refusing to run the ${name} harness command inside a container: it carries a single quote, and the container command is single-quoted (see routing.yaml)`)
  }
  const argv = [
    docker, 'run', '--rm', '-i', '-t', '--init',
    '--name', assertSafe('the container name', name),
    '--hostname', assertSafe('the container name', name),
    // The uid must be the host user that owns the two mounts, or the agent
    // cannot write its own worktree (#154 §3). The image is built for the same
    // uid; stating it here as well means an image built elsewhere cannot
    // silently give an agent a read-only clone.
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
// is the state home for this: the in-memory agent map is a cache (#9), and a
// restarted daemon has to be able to find the containers its predecessor left.
// The host ports one live container publishes, ascending — the preview bound
// (#157) for an agent this process never spawned. A daemon restart adopts the
// agents its predecessor left (reconcile), and their records come back with
// every spawn-time fact missing; without this, an adopted agent either loses
// `publish_preview` for the rest of its life or gets it back unbounded.
//
// Read from the container rather than from the journal, for the same reason
// listContainers is: the journal states what the daemon INTENDED at spawn, and
// docker states what is published now. Absence is positive — no such container
// yields no ports, and every publish is then refused, which is the safe
// direction for a bound.
//
// Shape verified on docker 29.6.2 and on the box's 20.10.17, identically:
//   {"9000/tcp":[{"HostIp":"127.0.0.1","HostPort":"9000"}]}
export async function containerPorts(name, { exec = execFileP, docker = DOCKER_BIN } = {}) {
  let stdout
  try {
    ({ stdout } = await exec(docker, [
      'inspect', name, '--format', '{{json .NetworkSettings.Ports}}',
    ], { timeout: 15_000 }))
  } catch (e) {
    const detail = `${e.stderr ?? ''}${e.message ?? ''}`
    if (e.code === 'ENOENT' || /No such object|No such container/i.test(detail)) return []
    throw new Error(`could not read the published ports of container ${name}: ${detail.trim().split('\n')[0]}`)
  }
  let map
  try {
    map = JSON.parse(stdout.trim() || 'null')
  } catch {
    return []
  }
  if (!map || typeof map !== 'object') return []
  const ports = new Set()
  for (const bindings of Object.values(map)) {
    for (const b of bindings ?? []) {
      const port = Number(b?.HostPort)
      if (Number.isInteger(port) && port > 0) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

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

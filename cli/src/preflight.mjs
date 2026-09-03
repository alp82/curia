import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { arch as osArch, cpus as osCpus, tmpdir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'

import { composeProject, parsePublishedPorts } from './compose.mjs'
import { Refusal } from './exit.mjs'
import { readInstallationRecord } from './root.mjs'

// The supported-host preflight (#868, implementing #850 and the direct-check
// constraints of #857).
//
// One module answers "may this operation proceed on this host?" for
// `curia install` (#873), `curia update` (#883), and `curia doctor` (#881).
// It has two halves behind one entry point:
//
//   gatherHostFacts(context, probes)   reads the host into one plain object,
//                                      the facts. Every read goes through a
//                                      probe, so a test hands in fakes and
//                                      never depends on the machine it runs on.
//   evaluateHostFacts(facts)           turns the facts into one report: one
//                                      result per check, each `passed`,
//                                      `warning`, or `refused`, with what was
//                                      observed and the one corrective action.
//   preflight(context, probes)         does both, prints the report, and
//                                      returns it. The report carries the
//                                      `Refusal` to throw when a check refused.
//
// A refused check is a demonstrated incompatibility that makes the operation
// unsafe or predictably broken. It stops the operation, and there is no force
// flag. A warning is a nonblocking fact: the operation continues, and Curia
// makes no lifecycle guarantee for what the warning names. Nothing here
// installs or reconfigures the host; every corrective action is a command or
// an official browser step for the operator.
//
// The probes may create temporary resources: a listening socket per port they
// test, one probe directory, one probe container. Each is removed before the
// probe returns, on success and on failure.

const GiB = 1024 ** 3

// The tested matrix. Another release, a derivative, or another architecture
// is refused until Curia tests and adds it deliberately (#856).
export const SUPPORTED_SYSTEMS = Object.freeze([
  Object.freeze({ id: 'ubuntu', versionId: '24.04', name: 'Ubuntu 24.04 LTS' }),
  Object.freeze({ id: 'debian', versionId: '13', name: 'Debian 13' }),
])
export const SUPPORTED_ARCH = 'x64'

// Below the minimum a host is unsupported, not refused, when the stack can
// run: Curia warns and makes no guarantee.
export const MINIMUM_PROFILE = Object.freeze({ cpus: 2, memoryBytes: 4 * GiB, freeDiskBytes: 15 * GiB })
export const RECOMMENDED_PROFILE = Object.freeze({ cpus: 4, memoryBytes: 8 * GiB, freeDiskBytes: 30 * GiB })

// The versions Curia is tested against. Older than `oldest` warns, unless it
// is older than `incompatible`, which refuses. A major version past
// `newestMajor` warns. `oldest` is the version the supported systems ship or
// the official repository offered when the range was set.
export const TESTED_VERSIONS = Object.freeze({
  docker: Object.freeze({ incompatible: '20.10', oldest: '24.0', newestMajor: 29, name: 'Docker Engine' }),
  compose: Object.freeze({ incompatible: '2.0', oldest: '2.20', newestMajor: 5, name: 'Docker Compose' }),
  tailscale: Object.freeze({ incompatible: '1.50', oldest: '1.80', newestMajor: 1, name: 'Tailscale' }),
})

// The loopback ports the Compose bundle binds on the host network. They
// mirror config/curia.yaml, and daemon/test/preflightports.test.mjs keeps them
// in step. The Serve ports (8443 to 8445, 8500 to 8599) are tailscaled's
// listeners, not host sockets, so they are not on this list.
export const REQUIRED_PORTS = Object.freeze([
  Object.freeze({ port: 4272, holder: 'the timeline' }),
  Object.freeze({ port: 4273, holder: 'the Curia app' }),
  Object.freeze({ port: 4274, holder: 'the overseer' }),
  Object.freeze({ port: 7681, holder: 'the attach surface' }),
  Object.freeze({ port: 7682, holder: 'the identity proxy' }),
])

// The range agent containers publish into, three ports per agent. A fresh
// installation runs four agents (#866), so twelve free ports is the floor an
// installation can start on. Fewer is exhausted sandbox-port capacity, the
// one capacity condition #850 refuses.
export const SANDBOX_PORTS = Object.freeze({ from: 9000, to: 9299, perAgent: 3, agents: 4 })

// Where a release comes from: the package from the npm registry, the
// bootstrap script and the stable index from GitHub, the images from GHCR.
// Preflight verifies these three and nothing else; each integration step
// verifies its own destination.
export const RELEASE_ORIGINS = Object.freeze(['https://registry.npmjs.org', 'https://github.com', 'https://ghcr.io'])

// How far the host clock may drift from a release origin before certificate
// and signature checks become unreliable.
export const CLOCK_SKEW_LIMIT_SECONDS = 300

const DOCKER_SOCKET = '/var/run/docker.sock'
const PROBE_IMAGE = 'busybox:stable'
const PROBE_TIMEOUT_MS = 60_000

// The checks, in the order the report prints them. `severity` says what a
// failed check can do: `blocking` refuses, `warning` never does, `mixed`
// refuses some conditions and warns on others.
export const CHECKS = Object.freeze([
  Object.freeze({ name: 'operator', severity: 'blocking', summary: 'The command runs as a non-root operator.' }),
  Object.freeze({ name: 'operating system', severity: 'blocking', summary: 'The release is Ubuntu 24.04 LTS or Debian 13.' }),
  Object.freeze({ name: 'architecture', severity: 'blocking', summary: 'The processor is x86-64.' }),
  Object.freeze({ name: 'host capacity', severity: 'warning', summary: 'CPU, memory, and free disk meet the minimum and recommended profiles.' }),
  Object.freeze({ name: 'required ports', severity: 'blocking', summary: 'The five loopback ports are free, or held by this installation, and the sandbox range can hold four agents.' }),
  Object.freeze({ name: 'Docker Engine', severity: 'mixed', summary: 'A running Docker Engine the operator can reach, in the tested range.' }),
  Object.freeze({ name: 'Docker capabilities', severity: 'blocking', summary: 'A probe container reads a bind mount and reaches the host network.' }),
  Object.freeze({ name: 'Docker Compose', severity: 'mixed', summary: 'The Compose v2 plugin, in the tested range.' }),
  Object.freeze({ name: 'Tailscale', severity: 'mixed', summary: 'The Tailscale package is installed and tailscaled is running, in the tested range.' }),
  Object.freeze({ name: 'outbound access', severity: 'blocking', summary: 'The three release origins answer over HTTPS.' }),
  Object.freeze({ name: 'release verification', severity: 'blocking', summary: 'Certificates verify and the clock agrees with the release origins.' }),
  Object.freeze({ name: 'Docker socket group', severity: 'blocking', summary: 'A docker group exists for the containers that reach the socket.' }),
])

// ---------------------------------------------------------------------------
// Evaluation: facts in, report out. Pure.

export function evaluateHostFacts(facts) {
  const checks = [
    operatorCheck(facts),
    operatingSystemCheck(facts),
    architectureCheck(facts),
    capacityCheck(facts),
    portsCheck(facts),
    dockerCheck(facts),
    dockerCapabilitiesCheck(facts),
    composeCheck(facts),
    tailscaleCheck(facts),
    outboundCheck(facts),
    releaseVerificationCheck(facts),
    dockerGroupCheck(facts),
  ]
  const refused = checks.filter((c) => c.status === 'refused')
  const refusal = refused.length === 0 ? null : new Refusal(refusalText(refused))
  return { ok: refused.length === 0, checks, refusal }
}

function passed(name, observed) {
  return { name, status: 'passed', observed, action: null }
}
function warning(name, observed, action) {
  return { name, status: 'warning', observed, action }
}
function refused(name, observed, action) {
  return { name, status: 'refused', observed, action }
}

function refusalText(refused) {
  const count = refused.length === 1 ? '1 condition' : `${refused.length} conditions`
  const lines = refused.map((c) => `  ${c.name}: ${c.observed} ${c.action}`)
  return `the host refused ${count}. Curia changed nothing.\n${lines.join('\n')}`
}

function operatorCheck({ uid }) {
  if (uid === 0) return refused('operator', 'this command runs as root.', 'Run it as the operator that owns the installation. Curia runs unprivileged and has no force flag.')
  return passed('operator', `uid ${uid}`)
}

const SUPPORTED_NAMES = SUPPORTED_SYSTEMS.map((s) => s.name).join(' or ')

function operatingSystemCheck({ os }) {
  const action = `Install Curia on ${SUPPORTED_NAMES} on x86-64. Other releases are not supported yet.`
  if (!os) return refused('operating system', 'could not read /etc/os-release, so the release is unknown.', action)
  const seen = os.prettyName || `${os.id} ${os.versionId}`
  const match = SUPPORTED_SYSTEMS.find((s) => s.id === os.id && s.versionId === os.versionId)
  if (!match) return refused('operating system', `${seen} is not a supported release.`, action)
  return passed('operating system', seen)
}

function architectureCheck({ arch }) {
  if (arch !== SUPPORTED_ARCH) {
    return refused('architecture', `the processor is ${arch}, and Curia publishes artifacts for x86-64 only.`, 'Install Curia on an x86-64 host.')
  }
  return passed('architecture', 'x86-64')
}

function gib(bytes) {
  return `${(bytes / GiB).toFixed(1)} GiB`
}

function profileText(p) {
  return `${p.cpus} CPU cores, ${p.memoryBytes / GiB} GiB of memory, and ${p.freeDiskBytes / GiB} GiB of free disk`
}

function capacityCheck({ cpus, memoryBytes, disk }) {
  const seen = `${cpus} CPU${cpus === 1 ? '' : 's'}, ${gib(memoryBytes)} of memory, ${gib(disk.freeBytes)} free on ${disk.path}`
  const below = (p) => cpus < p.cpus || memoryBytes < p.memoryBytes || disk.freeBytes < p.freeDiskBytes
  if (below(MINIMUM_PROFILE)) {
    return warning('host capacity', `${seen} is below the minimum profile, so Curia makes no guarantee that it runs well here.`, `Give the host at least ${profileText(MINIMUM_PROFILE)}.`)
  }
  if (below(RECOMMENDED_PROFILE)) {
    return warning('host capacity', `${seen} is below the recommended profile, so agents may wait on memory or CPU.`, `For comfortable operation give the host ${profileText(RECOMMENDED_PROFILE)}.`)
  }
  return passed('host capacity', seen)
}

function holderName(port) {
  return REQUIRED_PORTS.find((p) => p.port === port)?.holder ?? 'Curia'
}

// The check proves the five ports are available to this installation, which
// on a running host means Curia's own containers already hold them. `curia
// update` and `curia rollback` run this same preflight, so a port Curia
// binds must read as healthy, not as a conflict (#885).
//
// A busy port carries `service` when Compose listed it among the published
// ports of this root's own project. That is the only honest test: the holder
// is Curia's because Curia's Compose project says it publishes that port.
// The process name `ss` reports is not evidence, because a published port is
// held by a proxy in the container's namespace, whose name is whatever the
// image called its main thread.
function portsCheck({ ports }) {
  const needed = SANDBOX_PORTS.perAgent * SANDBOX_PORTS.agents
  const total = SANDBOX_PORTS.to - SANDBOX_PORTS.from + 1
  const foreign = ports.busy.filter((b) => !b.service)
  if (foreign.length > 0) {
    const list = foreign.map((b) => `${b.port} (${holderName(b.port)}) is held by ${b.process ?? 'another program'}`).join('; ')
    return refused('required ports', `port ${list}.`, 'Stop the program that listens on that port, or move it to another port, and run the command again.')
  }
  if (ports.sandboxFree < needed) {
    return refused('required ports', `only ${ports.sandboxFree} of the ${total} ports from ${SANDBOX_PORTS.from} to ${SANDBOX_PORTS.to} are free, and four agents need ${needed}.`, `Free at least ${needed} ports in that range and run the command again.`)
  }
  const mine = ports.busy.map((b) => `${b.port} (${holderName(b.port)}) is held by this installation's ${b.service} service`)
  const free = REQUIRED_PORTS.filter((p) => !ports.busy.some((b) => b.port === p.port)).map((p) => p.port)
  const observed = [
    ...mine,
    free.length > 0 ? `${free.join(', ')} free` : null,
    `${ports.sandboxFree} of ${total} sandbox ports free`,
  ].filter(Boolean).join('; ')
  return passed('required ports', observed)
}

// Compares dotted versions numerically, ignoring a suffix such as `-ce`.
function compareVersions(a, b) {
  const parse = (v) => String(v).split(/[^0-9.]/)[0].split('.').map((n) => Number(n) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// The version verdict shared by the three tools: `refused` below the
// incompatible line, a warning outside the tested range, else `null`.
function versionVerdict(name, tool, version, install) {
  const range = TESTED_VERSIONS[tool]
  if (compareVersions(version, range.incompatible) < 0) {
    return refused(name, `${range.name} ${version} is known incompatible; Curia needs ${range.oldest} or later.`, install)
  }
  if (compareVersions(version, range.oldest) < 0) {
    return warning(name, `${range.name} ${version} is older than the oldest tested version, ${range.oldest}.`, `Update ${range.name} to ${range.oldest} or later from its official repository.`)
  }
  if (compareVersions(version, `${range.newestMajor + 1}.0`) >= 0) {
    return warning(name, `${range.name} ${version} is newer than the tested range, which ends at major version ${range.newestMajor}.`, 'Watch for behavior changes; Curia is not tested against this version yet.')
  }
  return null
}

const DOCKER_INSTALL = 'Install Docker Engine 24.0 or later from https://docs.docker.com/engine/install/ and run the command again.'

function dockerCheck({ docker }) {
  if (!docker) return refused('Docker Engine', 'Docker Engine is not installed, or the docker command is not on the path.', DOCKER_INSTALL)
  if (!docker.socket.accessible) {
    return refused('Docker Engine', `the operator cannot open ${docker.socket.path}.`, 'Run `sudo usermod -aG docker $USER`, log out and in again so the group applies, and run the command again.')
  }
  if (!docker.server) {
    return refused('Docker Engine', `Docker Engine is installed but not running (${docker.error ?? 'the daemon did not answer'}).`, 'Run `sudo systemctl start docker` and run the command again.')
  }
  const version = versionVerdict('Docker Engine', 'docker', docker.server.version, DOCKER_INSTALL)
  if (version?.status === 'refused') return version
  if (docker.server.rootless) {
    return warning('Docker Engine', `Docker Engine ${docker.server.version} runs rootless. Curia is tested on rootful Docker only, and makes no guarantee here.`, 'For a supported host, use the rootful Docker Engine from its official repository.')
  }
  if (!docker.server.serviceEnabled) {
    return warning('Docker Engine', `Docker Engine ${docker.server.version} runs, but the docker service is not enabled at boot, so Curia does not come back after a reboot.`, 'Run `sudo systemctl enable docker`.')
  }
  if (version) return version
  return passed('Docker Engine', `Docker Engine ${docker.server.version}, API ${docker.server.apiVersion}`)
}

function dockerCapabilitiesCheck({ docker }) {
  const action = 'Fix the Docker Engine installation so a container can read a bind mount and use the host network, then run the command again. See https://docs.docker.com/engine/install/.'
  if (!docker?.server) return refused('Docker capabilities', 'the probe container did not run because Docker Engine is not available.', action)
  const probe = docker.probe
  if (!probe) return refused('Docker capabilities', 'the probe container did not run.', action)
  if (!probe.mount) return refused('Docker capabilities', `a probe container could not read a bind mount from the host (${probe.error ?? 'no output'}).`, action)
  if (!probe.network) return refused('Docker capabilities', `a probe container could not reach a listener on the host network (${probe.error ?? 'no output'}).`, action)
  return passed('Docker capabilities', 'a probe container read a bind mount and reached the host network')
}

const COMPOSE_INSTALL = 'Install the Docker Compose v2 plugin, 2.20 or later (the docker-compose-v2 package, or the compose plugin from https://docs.docker.com/compose/install/linux/) and run the command again.'

function composeCheck({ compose }) {
  if (!compose) return refused('Docker Compose', '`docker compose` is not available.', COMPOSE_INSTALL)
  return versionVerdict('Docker Compose', 'compose', compose.version, COMPOSE_INSTALL) ?? passed('Docker Compose', `Docker Compose ${compose.version}`)
}

const TAILSCALE_INSTALL = 'Install Tailscale from https://tailscale.com/download/linux and run the command again.'

// The package and the daemon are what Curia never installs, so they are the
// prerequisite. The login, the operator permission, and the certificate are
// the tailnet step's (`cli/src/tailnet.mjs`), which `curia install` runs
// after this and which logs the node in when it is not (#891).
function tailscaleCheck({ tailscale }) {
  if (!tailscale) return refused('Tailscale', 'Tailscale is not installed, or the tailscale command is not on the path.', TAILSCALE_INSTALL)
  const version = versionVerdict('Tailscale', 'tailscale', tailscale.version, TAILSCALE_INSTALL)
  if (version?.status === 'refused') return version
  if (!tailscale.daemon.running) {
    return refused('Tailscale', `tailscaled is not running (${tailscale.daemon.error ?? 'it did not answer'}).`, 'Run `sudo systemctl start tailscaled` and run the command again.')
  }
  if (version) return version
  return passed('Tailscale', `Tailscale ${tailscale.version}, tailscaled running, node ${tailscale.backendState}`)
}

function outboundCheck({ outbound }) {
  const down = outbound.filter((o) => !o.reachable)
  if (down.length > 0) {
    const list = down.map((o) => `${o.origin} (${o.error ?? 'no answer'})`).join(', ')
    return refused('outbound access', `${list} did not answer.`, 'Allow outbound HTTPS from this host to the release origins, or fix its DNS or proxy, and run the command again.')
  }
  return passed('outbound access', outbound.map((o) => o.origin).join(', '))
}

function releaseVerificationCheck({ outbound }) {
  const invalid = outbound.filter((o) => o.reachable && o.certificateValid === false)
  if (invalid.length > 0) {
    const list = invalid.map((o) => `${o.origin} (${o.error ?? 'certificate rejected'})`).join(', ')
    return refused('release verification', `the certificate of ${list} did not verify, so downloads cannot be trusted.`, 'Run `sudo apt-get install --reinstall ca-certificates`, remove any intercepting proxy, and run the command again.')
  }
  const skewed = outbound.filter((o) => o.reachable && typeof o.skewSeconds === 'number' && Math.abs(o.skewSeconds) > CLOCK_SKEW_LIMIT_SECONDS)
  if (skewed.length > 0) {
    const worst = Math.max(...skewed.map((o) => Math.abs(o.skewSeconds)))
    return refused('release verification', `the host clock is ${Math.round(worst / 60)} minutes from the release origins, so certificates and signatures cannot be checked.`, 'Run `sudo timedatectl set-ntp true`, wait for the clock to sync, and run the command again.')
  }
  return passed('release verification', 'certificates verify and the clock agrees with the release origins')
}

function dockerGroupCheck({ docker }) {
  if (!docker) return refused('Docker socket group', 'no docker group was found because Docker Engine is not installed.', DOCKER_INSTALL)
  if (!docker.group) {
    return refused('Docker socket group', 'no docker group exists, and the service and tmux containers join it to reach the socket.', 'Run `sudo groupadd docker`, then `sudo usermod -aG docker $USER`, log out and in again, and run the command again.')
  }
  return passed('Docker socket group', `${docker.group.name} (gid ${docker.group.gid})`)
}

// ---------------------------------------------------------------------------
// Rendering.

const STATUS_WORD = { passed: 'ok', warning: 'warning', refused: 'refused' }

export function renderPreflight(report) {
  const width = Math.max(...report.checks.map((c) => c.name.length))
  const lines = []
  for (const c of report.checks) {
    lines.push(`${STATUS_WORD[c.status].padEnd(8)} ${c.name.padEnd(width)}  ${c.observed}`)
    if (c.action) lines.push(`${''.padEnd(9 + width + 2)}${c.action}`)
  }
  const count = (status) => report.checks.filter((c) => c.status === status).length
  const refusedCount = count('refused')
  const warningCount = count('warning')
  const summary = [`${count('passed')} checks passed`]
  if (warningCount > 0) summary.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`)
  if (refusedCount > 0) summary.push(`refused: ${refusedCount} condition${refusedCount === 1 ? '' : 's'}`)
  lines.push(summary.join(', ') + '.')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Gathering: the host in, the facts out. Every read goes through a probe.

// The real probes. Each is one system boundary: a command, a file, a socket,
// a size, or an HTTPS request.
export const hostProbes = Object.freeze({
  exec: (file, args, { timeoutMs = 15_000 } = {}) => new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout, stderr, code: 0 })
      resolve({ ok: false, stdout, stderr: stderr || error.message, code: error.code, missing: error.code === 'ENOENT', timedOut: Boolean(error.killed) })
    })
  }),
  readFile: (path) => {
    try { return readFileSync(path, 'utf8') } catch { return null }
  },
  arch: () => osArch(),
  cpus: () => osCpus().length,
  memoryBytes: () => totalmem(),
  freeDiskBytes: (path) => {
    const s = statfsSync(path)
    return Number(s.bavail) * Number(s.bsize)
  },
  socketAccessible: (path) => {
    try { accessSync(path, constants.R_OK | constants.W_OK); return true } catch { return false }
  },
  groups: () => process.getgroups(),
  // Whether the operator can listen on the port on every interface. A test
  // that must not touch this machine's ports hands in its own answer.
  portFree,
  fetchOrigin: async (origin) => {
    const started = Date.now()
    try {
      const response = await fetch(`${origin}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) })
      const date = Date.parse(response.headers.get('date') ?? '')
      const skewSeconds = Number.isNaN(date) ? null : Math.round((date - (started + Date.now()) / 2) / 1000)
      return { origin, reachable: true, certificateValid: true, skewSeconds }
    } catch (e) {
      const cause = e.cause ?? e
      const code = cause.code ?? ''
      const message = cause.message ?? String(e)
      if (/CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY/.test(code) || /certificate/i.test(message)) {
        return { origin, reachable: true, certificateValid: false, error: message }
      }
      return { origin, reachable: false, error: message }
    }
  },
})

export async function gatherHostFacts({ uid, root, ports = REQUIRED_PORTS, sandbox = SANDBOX_PORTS }, probes = hostProbes) {
  const disk = nearestExisting(root)
  const [docker, compose, tailscale, portFacts, outbound] = await Promise.all([
    dockerFacts(probes),
    composeFacts(probes),
    tailscaleFacts(probes),
    portFactsOf(ports, sandbox, root, probes),
    Promise.all(RELEASE_ORIGINS.map((origin) => probes.fetchOrigin(origin))),
  ])
  return {
    uid,
    os: osRelease(probes.readFile('/etc/os-release')),
    arch: probes.arch(),
    cpus: probes.cpus(),
    memoryBytes: probes.memoryBytes(),
    disk: { path: disk, freeBytes: probes.freeDiskBytes(disk) },
    ports: portFacts,
    docker,
    compose,
    tailscale,
    outbound,
  }
}

function nearestExisting(path) {
  let at = path
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  return at
}

function osRelease(text) {
  if (!text) return null
  const fields = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=("?)(.*)\2$/)
    if (m) fields[m[1]] = m[3]
  }
  if (!fields.ID) return null
  return { id: fields.ID, versionId: fields.VERSION_ID ?? '', prettyName: fields.PRETTY_NAME ?? `${fields.ID} ${fields.VERSION_ID ?? ''}`.trim() }
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

async function dockerFacts(probes) {
  const version = await probes.exec('docker', ['version', '--format', 'json'])
  if (version.missing) return null
  const socket = { path: DOCKER_SOCKET, accessible: probes.socketAccessible(DOCKER_SOCKET) }
  const group = await dockerGroup(probes)
  const parsed = parseJson(version.stdout)
  const client = { version: parsed?.Client?.Version ?? null }
  if (!version.ok || !parsed?.Server) {
    return { client, server: null, error: firstLine(version.stderr) || 'the daemon did not answer', socket, group, probe: null }
  }
  const info = parseJson((await probes.exec('docker', ['info', '--format', 'json'])).stdout) ?? {}
  const enabled = await probes.exec('systemctl', ['is-enabled', 'docker'])
  const server = {
    version: parsed.Server.Version,
    apiVersion: parsed.Server.ApiVersion ?? null,
    rootless: (info.SecurityOptions ?? []).some((o) => /rootless/.test(o)),
    serviceEnabled: enabled.ok && enabled.stdout.trim() === 'enabled',
  }
  const probe = await dockerProbe(probes)
  return { client, server, socket, group, probe }
}

async function dockerGroup(probes) {
  const out = await probes.exec('getent', ['group', 'docker'])
  if (!out.ok) return null
  const [name, , gid] = out.stdout.trim().split(':')
  const gidNumber = Number(gid)
  return { name, gid: gidNumber, member: probes.groups().includes(gidNumber) }
}

// One container run proves two capabilities the bundle depends on: a bind
// mount from the host reads back, and the host network reaches a listener
// the operator opened. The listener, the probe directory, and the container
// are temporary and are removed before this returns, whatever happened.
async function dockerProbe(probes) {
  const token = randomBytes(16).toString('hex')
  const dir = mkdtempSync(join(tmpdir(), 'curia-preflight-'))
  const name = `curia-preflight-${randomBytes(4).toString('hex')}`
  const listener = createHttpServer((request, response) => {
    response.setHeader('Connection', 'close')
    response.end(token)
  })
  try {
    writeFileSync(join(dir, 'probe'), token)
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${listener.address().port}/`
    const run = await probes.exec('docker', [
      'run', '--rm', '--name', name, '--network', 'host', '-v', `${dir}:${dir}:ro`, PROBE_IMAGE,
      'sh', '-c', `cat ${join(dir, 'probe')}; echo; wget -q -O - ${url}`,
    ], { timeoutMs: PROBE_TIMEOUT_MS })
    if (!run.ok) {
      await probes.exec('docker', ['rm', '-f', name])
      return { mount: false, network: false, error: firstLine(run.stderr) || `docker run exited ${run.code}` }
    }
    const [fromMount, fromNetwork] = run.stdout.split('\n').map((s) => s.trim())
    return {
      mount: fromMount === token,
      network: fromNetwork === token,
      ...(fromMount === token && fromNetwork === token ? {} : { error: `the probe printed ${JSON.stringify(run.stdout.trim())}` }),
    }
  } catch (e) {
    await probes.exec('docker', ['rm', '-f', name])
    return { mount: false, network: false, error: e.message }
  } finally {
    listener.closeAllConnections()
    await new Promise((resolve) => listener.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

async function composeFacts(probes) {
  const out = await probes.exec('docker', ['compose', 'version', '--short'])
  if (!out.ok) return null
  const version = out.stdout.trim().replace(/^v/, '')
  return version ? { version } : null
}

// `tailscale status --json` answers as any user when tailscaled runs, in
// every backend state; it fails only when the daemon is not there to ask.
async function tailscaleFacts(probes) {
  const version = await probes.exec('tailscale', ['version'])
  if (version.missing || !version.ok) return null
  const status = await probes.exec('tailscale', ['status', '--json'])
  const parsed = parseJson(status.stdout)
  const running = Boolean(parsed && typeof parsed === 'object' && parsed.BackendState)
  return {
    installed: true,
    version: version.stdout.split('\n')[0].trim(),
    daemon: running ? { running: true, error: null } : { running: false, error: firstLine(status.stderr) || firstLine(status.stdout) || 'tailscaled did not answer' },
    backendState: parsed?.BackendState ?? 'Unknown',
    online: Boolean(parsed?.Self?.Online),
    certDomains: parsed?.CertDomains ?? [],
  }
}

// A port is free when the operator can listen on it on every interface. The
// listener is closed before the answer is returned. The holder of a busy
// port comes from `ss`, when it is present and may name the process.
async function portFactsOf(ports, sandbox, root, probes) {
  const portFree = probes.portFree ?? hostProbes.portFree
  const busy = []
  for (const { port } of ports) {
    if (!(await portFree(port))) busy.push({ port, process: await holderOf(port, probes) })
  }
  if (busy.length > 0) {
    const published = await publishedPortsOf(root, probes)
    for (const entry of busy) {
      const mine = published?.find((p) => p.port === entry.port)
      if (mine) entry.service = mine.service
    }
  }
  let sandboxFree = 0
  for (let port = sandbox.from; port <= sandbox.to; port += 1) {
    if (await portFree(port)) sandboxFree += 1
  }
  return { busy, sandboxFree }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => server.close(() => resolve(true)))
  })
}

// The host ports the root's own Compose project publishes, or null when this
// root holds no installation, Compose cannot be asked, or its answer is not
// readable. Null means "nothing here claims a port", which is the fresh-host
// case `curia install` checks: a busy port is then someone else's.
async function publishedPortsOf(root, probes) {
  if (!root) return null
  let record = null
  try {
    record = readInstallationRecord(root)
  } catch {
    return null
  }
  if (!record?.activeVersion) return null
  const project = composeProject({ root, version: record.activeVersion })
  const out = await probes.exec('docker', project.args('ps', '--format', 'json'))
  if (!out.ok) return null
  try {
    return parsePublishedPorts(out.stdout)
  } catch {
    return null
  }
}

async function holderOf(port, probes) {
  const out = await probes.exec('ss', ['-H', '-ltnp', `sport = :${port}`])
  const m = out.ok ? out.stdout.match(/users:\(\("([^"]+)",pid=(\d+)/) : null
  return m ? `${m[1]} (pid ${m[2]})` : null
}

function firstLine(text) {
  return (text ?? '').trim().split('\n')[0]
}

// ---------------------------------------------------------------------------
// The entry point.

// `context` is `{ uid, root, stdout }` from the command, or `{ facts, stdout }`
// when the caller already has the facts. It prints the report on `stdout` and
// returns it. The caller throws `report.refusal` to stop, or reads the checks
// to print more.
export async function preflight({ uid, root, facts, stdout, ports, sandbox }, probes = hostProbes) {
  const observed = facts ?? await gatherHostFacts({ uid, root, ports, sandbox }, probes)
  const report = evaluateHostFacts(observed)
  stdout?.write(renderPreflight(report))
  return { ...report, facts: observed }
}

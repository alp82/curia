import { execFile } from 'node:child_process'
import { join } from 'node:path'

import { writeAtomically } from './atomic.mjs'
import { bundleEnvironment } from './bundle.mjs'
import { SERVICES } from './layout.mjs'
import { versionPaths } from './root.mjs'

// The one seam between the lifecycle interface and Docker Compose (#873,
// implementing #851 and #854).
//
// An installed version's Compose bundle is started, watched, and later
// switched or torn down through this module and nothing else. It knows three
// things: where the project's files are for one version of one root, how to
// run `docker compose` against them, and what "healthy" means for the five
// services the bundle declares. Every Docker call goes through `dockerRunner`,
// which a test replaces with a fake, so the install sequence is proven against
// packaged fixtures without a Docker daemon.
//
// The project name is in the bundle itself (`name: curia`), so no command here
// passes one. What a command passes is the env file under `run/` with the five
// run-time values (paths and numbers, never a secret) and the bundle file of
// the version.

export class ComposeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ComposeError'
  }
}

// How long a start may take before a service that is still starting counts
// as failed: the daemon's start period is 60 s and every check allows three
// 30 s retries, so four minutes covers a slow first pull of the agent image
// recipe and a cold journal open.
export const HEALTH_TIMEOUT_MS = 240_000
export const HEALTH_POLL_MS = 2_000

export function composeEnvPath(root) {
  return join(root, 'run', 'compose.env')
}

// The project of `version` under `root`: the env file, the bundle file, and
// the `docker` arguments for one Compose verb against them.
export function composeProject({ root, version }) {
  const envFile = composeEnvPath(root)
  const file = versionPaths(root, version).bundle
  return Object.freeze({
    root,
    version,
    envFile,
    file,
    args: (...verb) => ['compose', '--env-file', envFile, '-f', file, ...verb],
  })
}

// Writes `run/compose.env` owner-only. `run/` exists because `ensureLayout`
// created it.
export function writeComposeEnvironment(project, { uid, gid, dockerGid, installationId }) {
  writeAtomically(project.envFile, bundleEnvironment({ root: project.root, uid, gid, dockerGid, installationId }), { mode: 0o600 })
}

// The real runner: one `docker` invocation, its output captured. Compose
// prints progress on stderr, which is returned with the result so a failure
// can quote it.
export const dockerRunner = (args, { timeoutMs = 600_000 } = {}) => new Promise((resolve) => {
  execFile('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return resolve({ ok: true, stdout, stderr, code: 0 })
    resolve({ ok: false, stdout, stderr: stderr || error.message, code: error.code, missing: error.code === 'ENOENT', timedOut: Boolean(error.killed) })
  })
})

async function compose(project, verb, { docker }) {
  const args = project.args(...verb)
  const result = await docker(args)
  if (result.ok) return result
  const detail = result.missing ? 'docker is not on the path' : (result.stderr || result.stdout || `exit ${result.code}`).trim().split('\n').slice(-5).join('\n')
  throw new ComposeError(`docker ${args.join(' ')} failed:\n${detail}`)
}

// Pulls every image by its digest, then brings the project up detached.
// `--remove-orphans` retires a container of a service the bundle no longer
// declares, which is what a reinstall over an older bundle needs.
export async function startProject(project, { docker = dockerRunner, stdout }) {
  stdout?.write(`pulling the images of ${project.version} by digest\n`)
  await compose(project, ['pull'], { docker })
  stdout?.write(`starting the Compose project\n`)
  await compose(project, ['up', '--detach', '--remove-orphans', '--quiet-pull'], { docker })
}

// `docker compose ps --format json` prints one object per line since Compose
// 2.21 and one array before that. Both read into the same list.
export function parseServiceStates(text) {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const rows = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').map((line) => JSON.parse(line))
  return rows.map((row) => ({
    service: row.Service,
    state: row.State ?? '',
    health: row.Health ?? '',
    exitCode: Number.isInteger(row.ExitCode) ? row.ExitCode : null,
  }))
}

export async function serviceStates(project, { docker = dockerRunner }) {
  const result = await compose(project, ['ps', '--all', '--format', 'json'], { docker })
  return parseServiceStates(result.stdout)
}

// Waits until every service the bundle declares reports healthy. A service
// that exited, or that Docker marks unhealthy, fails at once: waiting cannot
// fix it. A service still starting when the deadline passes fails too. The
// failure names the service and the log command that shows why.
export async function waitForHealth(project, { docker = dockerRunner, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = HEALTH_TIMEOUT_MS, stdout } = {}) {
  const started = now()
  const logs = (service) => `Read its log with 'docker compose --env-file ${project.envFile} -f ${project.file} logs ${service}', fix the cause, and run the command again.`
  for (;;) {
    const states = await serviceStates(project, { docker })
    const pending = []
    for (const service of SERVICES) {
      const s = states.find((x) => x.service === service)
      if (!s) throw new ComposeError(`${service} is not in the project. ${logs(service)}`)
      if (s.state === 'exited' || s.state === 'dead') throw new ComposeError(`${service} exited with code ${s.exitCode ?? '?'}. ${logs(service)}`)
      if (s.health === 'unhealthy') throw new ComposeError(`${service} is unhealthy. ${logs(service)}`)
      if (s.health !== 'healthy') pending.push(service)
    }
    if (pending.length === 0) {
      stdout?.write(`every service is healthy: ${SERVICES.join(', ')}\n`)
      return states
    }
    if (now() - started >= timeoutMs) {
      throw new ComposeError(`${pending[0]} is still starting after ${Math.round(timeoutMs / 1000)} seconds. ${logs(pending[0])}`)
    }
    stdout?.write(`waiting for ${pending.join(', ')}\n`)
    await sleep(HEALTH_POLL_MS)
  }
}

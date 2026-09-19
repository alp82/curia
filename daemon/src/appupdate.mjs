// The app orders a detached sibling so replacing the daemon cannot kill the
// update. Progress survives in state/, and the CLI still owns the lifecycle.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dockerRunner } from '../../cli/src/compose.mjs'
import { readInstallationRecord, versionPaths } from '../../cli/src/root.mjs'
import { parseManifest } from '../../cli/src/manifest.mjs'
import { imageReference, INSTALLATION_LABEL } from '../../cli/src/bundle.mjs'
import { writeAtomically } from '../../cli/src/atomic.mjs'

export const updateRunPath = (root) => path.join(root, 'state', 'update-run.json')
export const updateRunning = (run) => ['starting', 'running'].includes(run?.status)
export const updateContainer = (id) => `curia-update-${id}`
export function readUpdateRun(root) {
  try { return JSON.parse(fs.readFileSync(updateRunPath(root), 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}
export function writeUpdateRun(root, run) {
  writeAtomically(updateRunPath(root), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
}

export function updateHelperArgs({ root, record, image, uid, gid, dockerGid }) {
  // Host PID namespace makes the CLI lock agree with host CLI invocations.
  // Host network and same-path mounts let the existing host preflight prove
  // ports and sibling bind mounts. The helper never runs as root.
  return ['run', '--detach', '--rm', '--name', updateContainer(record.installationId),
    '--label', `${INSTALLATION_LABEL}=${record.installationId}`, '--network', 'host', '--pid', 'host',
    '--user', `${uid}:${gid}`, '--group-add', String(dockerGid),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,src=${root},dst=${root}`,
    '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
    '--mount', 'type=bind,src=/var/run/tailscale/tailscaled.sock,dst=/var/run/tailscale/tailscaled.sock',
    ...['/etc/os-release', '/etc/passwd', '/etc/group'].flatMap((file) => ['--mount', `type=bind,src=${file},dst=${file},readonly`]),
    '--env', `CURIA_ROOT=${root}`, '--env', `HOME=${path.join(root, 'cache', 'home')}`,
    '--env', `TMPDIR=${path.join(root, 'cache', 'update-probes')}`,
    '--entrypoint', 'node', image, '/opt/curia/daemon/bin/curia-update.mjs']
}

// The daemon mounts the root's directories and never the root itself, so the
// root path inside its container is a directory Docker made, owned by uid 0.
// `state/` is always mounted and carries the operator's ownership.
export function installationOwner(root, stat = fs.statSync) {
  const { uid, gid } = stat(path.join(root, 'state'))
  return { uid, gid, dockerGid: stat('/var/run/docker.sock').gid }
}

export class AppUpdate {
  constructor({ root, check, docker = dockerRunner, now = Date.now, identity = () => installationOwner(root) }) {
    Object.assign(this, { root, check, docker, now, identity })
    this.starting = null
  }

  async status() {
    const run = readUpdateRun(this.root)
    if (!updateRunning(run) || this.starting) return run
    const result = await this.docker(['inspect', '--format', '{{.State.Running}}', updateContainer(run.installation_id)], { timeoutMs: 5000 })
    if (result.ok && result.stdout.trim() === 'true') return readUpdateRun(this.root)
    // The daemon can restart between recording the request and docker run.
    if (this.now() - Date.parse(run.started_at) < 60_000) return run
    // A daemon restart must not overwrite a result the sibling just wrote.
    const current = readUpdateRun(this.root)
    if (!updateRunning(current) || current.id !== run.id) return current
    if (!result.ok && !/No such (object|container)/i.test(result.stderr ?? '')) {
      return { ...current, observation_error: 'Cannot check the update process. Retrying.' }
    }
    const ended = { ...current, status: 'failed', finished_at: new Date(this.now()).toISOString(), error: 'The update process stopped before reporting completion. Check the installed version, then retry.' }
    writeUpdateRun(this.root, ended)
    return ended
  }

  async start({ version, request_id, by }) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(request_id ?? '')) throw new Error('An update request ID is required.')
    if (this.starting) return this.starting
    this.starting = this.begin({ version, request_id, by }).finally(() => { this.starting = null })
    return this.starting
  }

  async begin({ version, request_id, by }) {
    const previous = readUpdateRun(this.root)
    if (previous?.request_id === request_id || updateRunning(previous)) return previous
    await this.check.check()
    const status = this.check.status()
    if (!status.ok || !status.update_available || version !== status.recommended) {
      throw new Error('Check for updates again. Only the currently verified newer stable release can be installed.')
    }
    const record = readInstallationRecord(this.root)
    if (!record || record.activeVersion !== status.installed) throw new Error('The installed version changed. Check for updates again.')
    const owner = this.identity()
    if (owner.uid === 0) throw new Error('Curia updates must run as the non-root installation owner.')
    const manifest = parseManifest(fs.readFileSync(versionPaths(this.root, record.activeVersion).manifest, 'utf8'))
    const args = updateHelperArgs({ root: this.root, record, image: imageReference('daemon', manifest.images.daemon.digest),
      uid: owner.uid, gid: owner.gid, dockerGid: owner.dockerGid })
    fs.mkdirSync(path.join(this.root, 'cache', 'update-probes'), { recursive: true, mode: 0o700 })
    const run = { id: randomUUID(), request_id, installation_id: record.installationId, from: record.activeVersion,
      to: version, by: String(by ?? '').slice(0, 120), status: 'starting', step: null, started_at: new Date(this.now()).toISOString(), error: null }
    writeUpdateRun(this.root, run)
    const launched = await this.docker(args, { timeoutMs: 30_000 })
    if (!launched.ok) {
      // An uncertain launch is resolved by status(), never by starting twice.
      const inspected = await this.docker(['inspect', '--format', '{{.State.Running}}', updateContainer(record.installationId)], { timeoutMs: 5000 })
      if (inspected.ok && inspected.stdout.trim() === 'true') return readUpdateRun(this.root)
      if (!inspected.ok && !/No such (object|container)/i.test(inspected.stderr ?? '')) return readUpdateRun(this.root)
      const latest = readUpdateRun(this.root)
      if (latest.id !== run.id || latest.status !== 'starting') return latest
      const failed = { ...run, status: 'failed', error: 'Could not start the update process. Check Docker and retry.', finished_at: new Date(this.now()).toISOString() }
      writeUpdateRun(this.root, failed)
      return failed
    }
    return readUpdateRun(this.root)
  }
}

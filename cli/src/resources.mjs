import { INSTALLATION_LABEL } from './bundle.mjs'
import { dockerRunner } from './compose.mjs'

// The Docker resources of one installation, found by label and by nothing
// else (#886 and #887, implementing #855).
//
// Every container, network, and volume Curia creates for an installation
// carries `sh.curia.installation=<installation ID>`: the Compose bundle puts
// it on the five services, the project network, and the tmux socket volume,
// and the service puts it on every agent container and the agent cache
// volumes it creates. So one filter names what belongs to an installation on
// a host, whatever the Compose project's files are in, and a name prefix is
// never read as ownership. A container of another installation, an
// operator's own container, and a probe container without the label are
// never listed and never touched.
//
// Uninstall stops and removes them; purge does the same and then removes
// the release images. Both read what is there before they remove it, so a
// rerun over a host where nothing is left lists nothing and removes nothing.

export class DockerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DockerError'
  }
}

const filter = (installationId) => ['--filter', `label=${INSTALLATION_LABEL}=${installationId}`]

// The labelled resources: `{ containers: [{ id, name, running }], networks:
// [{ id, name }], volumes: [{ name }] }`.
export async function installationResources(installationId, { docker = dockerRunner } = {}) {
  const containers = (await run(docker, ['ps', '--all', '--no-trunc', ...filter(installationId), '--format', '{{.ID}}\t{{.Names}}\t{{.State}}']))
    .map((line) => {
      const [id, name, state] = line.split('\t')
      return { id, name, running: state === 'running' }
    })
  const networks = (await run(docker, ['network', 'ls', '--no-trunc', ...filter(installationId), '--format', '{{.ID}}\t{{.Name}}']))
    .map((line) => {
      const [id, name] = line.split('\t')
      return { id, name }
    })
  const volumes = (await run(docker, ['volume', 'ls', ...filter(installationId), '--format', '{{.Name}}']))
    .map((name) => ({ name }))
  return { containers, networks, volumes }
}

// Stops every running labelled container, then removes every labelled
// container, network, and volume, in that order, so the network and the
// volumes are free when they are removed. Returns what was removed. A stop
// gives each process its termination signal and the usual grace before the
// kill, which is what lets the service close its journal; nothing waits for
// a session to finish, and nothing drains one.
export async function removeInstallationResources(installationId, { docker = dockerRunner, stdout } = {}) {
  const found = await installationResources(installationId, { docker })
  const running = found.containers.filter((c) => c.running)
  if (running.length > 0) {
    stdout?.write(`stopping ${describe(running.map((c) => c.name), 'container')}\n`)
    await run(docker, ['stop', ...running.map((c) => c.id)])
  }
  if (found.containers.length > 0) {
    stdout?.write(`removing ${describe(found.containers.map((c) => c.name), 'container')}\n`)
    await run(docker, ['rm', '--force', '--volumes', ...found.containers.map((c) => c.id)])
  }
  if (found.networks.length > 0) {
    stdout?.write(`removing ${describe(found.networks.map((n) => n.name), 'network')}\n`)
    await run(docker, ['network', 'rm', ...found.networks.map((n) => n.id)])
  }
  if (found.volumes.length > 0) {
    stdout?.write(`removing ${describe(found.volumes.map((v) => v.name), 'volume')}\n`)
    await run(docker, ['volume', 'rm', '--force', ...found.volumes.map((v) => v.name)])
  }
  return found
}

function describe(names, noun) {
  return `${names.length} ${noun}${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
}

// One `docker` invocation whose output is read line by line.
async function run(docker, args) {
  const result = await docker(args)
  if (!result.ok) {
    const detail = result.missing ? 'docker is not on the path' : (result.stderr || result.stdout || `exit ${result.code}`).trim().split('\n').slice(-5).join('\n')
    throw new DockerError(`docker ${args.join(' ')} failed:\n${detail}`)
  }
  return String(result.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

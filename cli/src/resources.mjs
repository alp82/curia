import { IMAGE_REGISTRY, INSTALLATION_LABEL, RELEASE_IMAGES } from './bundle.mjs'
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

// The release images on the host: every image under one of the four exact
// repositories `RELEASE_IMAGES` names, whatever release it belongs to, as
// `{ id, reference }` with the reference `<repository>@<digest>` (or
// `<repository>:<tag>` for one pulled by tag). Images are not labelled with
// an installation, because two installations on one host share a pulled
// image, so the repository is the identity; a name that merely starts with
// `curia-` is never read as a release image.
export async function releaseImages({ docker = dockerRunner } = {}) {
  const seen = new Map()
  for (const name of Object.values(RELEASE_IMAGES)) {
    const repository = `${IMAGE_REGISTRY}/${name}`
    const rows = await run(docker, ['image', 'ls', '--no-trunc', '--digests', '--filter', `reference=${repository}`, '--format', '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Digest}}'])
    for (const line of rows) {
      const [id, repo, tag, digest] = line.split('\t')
      const reference = digest && digest !== '<none>' ? `${repo}@${digest}` : `${repo}:${tag}`
      if (!seen.has(id)) seen.set(id, { id, reference })
    }
  }
  return [...seen.values()]
}

// Removes every release image that Docker proves unused, and keeps the rest
// with the reason. Unused means: `docker ps --all --filter ancestor=<id>`
// lists no container, of this installation or any other, and Docker itself
// accepts the removal without `--force`. An image Docker refuses (a container
// created between the two calls, a dependent image) is kept and reported,
// not a failure: images are shared host resources, and keeping one leaves
// nothing of the installation behind. Returns `{ found, removed, kept }`
// with `kept` as `[{ reference, reason }]`.
export async function removeReleaseImages({ docker = dockerRunner, stdout } = {}) {
  const found = await releaseImages({ docker })
  const removed = []
  const kept = []
  for (const image of found) {
    const users = (await run(docker, ['ps', '--all', '--no-trunc', '--filter', `ancestor=${image.id}`, '--format', '{{.ID}}\t{{.Names}}']))
      .map((line) => line.split('\t')[1])
    if (users.length > 0) {
      const reason = `in use by ${describe(users, 'container')}`
      stdout?.write(`kept the image ${image.reference}: ${reason}\n`)
      kept.push({ reference: image.reference, reason })
      continue
    }
    const result = await docker(['image', 'rm', image.id])
    if (!result.ok) {
      const reason = `docker refused: ${lastLines(result)}`
      stdout?.write(`kept the image ${image.reference}: ${reason}\n`)
      kept.push({ reference: image.reference, reason })
      continue
    }
    stdout?.write(`removed the image ${image.reference}\n`)
    removed.push(image)
  }
  return { found, removed, kept }
}

function describe(names, noun) {
  return `${names.length} ${noun}${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
}

// One `docker` invocation whose output is read line by line.
async function run(docker, args) {
  const result = await docker(args)
  if (!result.ok) {
    throw new DockerError(`docker ${args.join(' ')} failed:\n${lastLines(result)}`)
  }
  return String(result.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

function lastLines(result) {
  return result.missing ? 'docker is not on the path' : (result.stderr || result.stdout || `exit ${result.code}`).trim().split('\n').slice(-5).join('\n')
}

import { isAbsolute } from 'node:path'

// The versioned Compose bundle (#869, implementing #849, #851, and #854).
//
// A release is one immutable set of container images plus one Compose file
// that names them by digest. This module is the contract between the three
// parties that touch that file: the release workflow that renders it from
// `deploy/bundle/compose.yaml`, the tests that inspect what was rendered, and
// the lifecycle interface that starts it under an installation root. It is
// text in and text out, with no YAML reader, because the package has no
// dependencies and the questions are answerable by line.
//
// Three facts every party shares:
//
//   - the Compose project is always `curia`, so `docker compose -p curia` and
//     the labels Compose adds name one installation's containers, network, and
//     volume on a host;
//   - every container, the network, and the volume carry the installation ID
//     under `sh.curia.installation`, which is what `curia purge` (#855) removes
//     by and never a name prefix;
//   - the bundle interpolates paths and numbers only, the five variables in
//     `BUNDLE_VARIABLES`, which `curia install` (#873) writes into an env file
//     under `run/` from facts it holds. Never a secret.
//
// The release manifest (#870) binds the bundle's checksum and the same
// digests; the publication order and the stable index are #871's.

export class BundleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BundleError'
  }
}

export const COMPOSE_PROJECT = 'curia'
export const INSTALLATION_LABEL = 'sh.curia.installation'
export const IMAGE_REGISTRY = 'ghcr.io/alp82'

// The four images a release builds, keyed by the service that runs them. The
// attach surface (`ttyd`) runs the tmux image, so it has no image of its own.
// The agent image is not here: the service builds it on the host from the
// recipe the service image carries, content-addressed by its pins.
export const RELEASE_IMAGES = Object.freeze({
  daemon: 'curia-daemon',
  tmux: 'curia-tmux',
  dashboard: 'curia-dashboard',
  overseer: 'curia-overseer',
})

// What a started bundle interpolates, in the order the env file lists them.
export const BUNDLE_VARIABLES = Object.freeze(['CURIA_ROOT', 'CURIA_UID', 'CURIA_GID', 'DOCKER_GID', 'CURIA_INSTALLATION_ID'])

const DIGEST = /^sha256:[0-9a-f]{64}$/
const INSTALLATION_ID = /^[0-9a-f]{32}$/
const IMAGE_VARIABLE = /\$\{CURIA_([A-Z]+)_IMAGE(?::\?[^}]*)?\}/g
const ANY_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)/g
const IMAGE_LINE = /^\s*image:\s*(\S+)\s*$/
const OPERATOR_PATH = /\/home\/[A-Za-z0-9_-]+/

export function imageReference(service, digest) {
  const name = RELEASE_IMAGES[service]
  if (!name) throw new BundleError(`no release image is built for ${service}`)
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new BundleError(`the ${service} image needs a sha256 digest, got ${JSON.stringify(digest)}`)
  }
  return `${IMAGE_REGISTRY}/${name}@${digest}`
}

// The template with each `${CURIA_<SERVICE>_IMAGE...}` replaced by that
// service's digest reference. Every other variable is left as it is.
export function renderBundle(template, digests) {
  return template.replace(IMAGE_VARIABLE, (whole, upper) => {
    const service = upper.toLowerCase()
    if (!RELEASE_IMAGES[service]) throw new BundleError(`the template names ${whole.slice(2, whole.indexOf('_IMAGE') + 6)}, which no release builds`)
    return imageReference(service, digests?.[service])
  })
}

const referencePattern = new RegExp(`^${IMAGE_REGISTRY.replace(/[.]/g, '\\.')}/(${Object.values(RELEASE_IMAGES).join('|')})@sha256:[0-9a-f]{64}$`)

// The problems a rendered bundle has, as one line each. Empty means it is fit
// to publish: one fixed project name, every image an exact digest under the
// registry, only the run-time variables, no build, no env file, no path of
// anyone's home.
export function inspectBundle(text) {
  const problems = []
  const lines = text.split('\n')
  if (!lines.some((l) => l === `name: ${COMPOSE_PROJECT}`)) {
    problems.push(`the project name must be \`name: ${COMPOSE_PROJECT}\` at the top level`)
  }
  lines.forEach((line, i) => {
    const n = i + 1
    const image = IMAGE_LINE.exec(line)
    if (image && !referencePattern.test(image[1])) {
      problems.push(`line ${n}: image ${image[1]} is not a digest reference under ${IMAGE_REGISTRY}`)
    }
    for (const m of line.matchAll(ANY_VARIABLE)) {
      if (!BUNDLE_VARIABLES.includes(m[1])) problems.push(`line ${n}: variable ${m[1]} is not one the lifecycle interface writes`)
    }
    if (/^\s*build:/.test(line)) problems.push(`line ${n}: a build stanza; the bundle runs published images only`)
    if (/^\s*env_file:/.test(line)) problems.push(`line ${n}: env_file; the bundle loads no env file`)
    if (OPERATOR_PATH.test(line)) problems.push(`line ${n}: an operator path, ${OPERATOR_PATH.exec(line)[0]}`)
  })
  return problems
}

// The env file `curia install` writes under `run/` and passes with
// `--env-file`. Paths and numbers, one per line, never a secret.
export function bundleEnvironment({ root, uid, gid, dockerGid, installationId }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new BundleError(`CURIA_ROOT must be an absolute path, got ${JSON.stringify(root)}`)
  for (const [name, value] of [['CURIA_UID', uid], ['CURIA_GID', gid], ['DOCKER_GID', dockerGid]]) {
    if (!(Number.isInteger(value) && value >= 0)) throw new BundleError(`${name} must be a non-negative whole number, got ${JSON.stringify(value)}`)
  }
  if (typeof installationId !== 'string' || !INSTALLATION_ID.test(installationId)) {
    throw new BundleError(`CURIA_INSTALLATION_ID must be the 32-hex installation ID, got ${JSON.stringify(installationId)}`)
  }
  const values = { CURIA_ROOT: root, CURIA_UID: uid, CURIA_GID: gid, DOCKER_GID: dockerGid, CURIA_INSTALLATION_ID: installationId }
  return BUNDLE_VARIABLES.map((name) => `${name}=${values[name]}\n`).join('')
}

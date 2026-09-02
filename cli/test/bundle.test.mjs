import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPOSE_PROJECT, INSTALLATION_LABEL, IMAGE_REGISTRY, RELEASE_IMAGES, AGENT_IMAGE, BUNDLE_VARIABLES,
  imageReference, renderBundle, inspectBundle, bundleEnvironment, BundleError,
} from '../src/bundle.mjs'

const D = 'a'.repeat(64)
const DIGESTS = { daemon: `sha256:${D}`, tmux: `sha256:${'b'.repeat(64)}`, dashboard: `sha256:${'c'.repeat(64)}`, overseer: `sha256:${'d'.repeat(64)}`, agent: `sha256:${'e'.repeat(64)}` }

// A template in the shape of deploy/bundle/compose.yaml: one image variable
// per service and the run-time variables beside them.
const TEMPLATE = [
  'name: curia',
  'services:',
  '  daemon:',
  '    image: ${CURIA_DAEMON_IMAGE:?the digest-pinned service image}',
  '    user: "${CURIA_UID:?}:${CURIA_GID:?}"',
  '    labels:',
  '      sh.curia.installation: ${CURIA_INSTALLATION_ID:?}',
  '  tmux:',
  '    image: ${CURIA_TMUX_IMAGE:?}',
  '  ttyd:',
  '    image: ${CURIA_TMUX_IMAGE:?}',
  '  dashboard:',
  '    image: ${CURIA_DASHBOARD_IMAGE:?}',
  '  overseer:',
  '    image: ${CURIA_OVERSEER_IMAGE:?}',
  '    volumes:',
  '      - ${CURIA_ROOT:?}/run:${CURIA_ROOT:?}/run',
  '',
].join('\n')

describe('the contract', () => {
  test('one fixed project name, one label key, five release images under one registry, one of them the agent image', () => {
    assert.equal(COMPOSE_PROJECT, 'curia')
    assert.equal(INSTALLATION_LABEL, 'sh.curia.installation')
    assert.equal(IMAGE_REGISTRY, 'ghcr.io/alp82')
    assert.deepEqual(RELEASE_IMAGES, { daemon: 'curia-daemon', tmux: 'curia-tmux', dashboard: 'curia-dashboard', overseer: 'curia-overseer', agent: 'curia-agent' })
    assert.equal(AGENT_IMAGE, 'agent')
    assert.ok(AGENT_IMAGE in RELEASE_IMAGES, 'the agent image is a release image')
    assert.deepEqual(BUNDLE_VARIABLES, ['CURIA_ROOT', 'CURIA_UID', 'CURIA_GID', 'DOCKER_GID', 'CURIA_INSTALLATION_ID'])
  })

  test('an image reference is registry, name, and digest, and nothing mutable', () => {
    assert.equal(imageReference('daemon', `sha256:${D}`), `ghcr.io/alp82/curia-daemon@sha256:${D}`)
    assert.throws(() => imageReference('daemon', '1.2.3'), BundleError)
    assert.throws(() => imageReference('daemon', `sha256:${D.slice(1)}`), BundleError)
    assert.equal(imageReference('agent', `sha256:${D}`), `ghcr.io/alp82/curia-agent@sha256:${D}`)
    assert.throws(() => imageReference('worker', `sha256:${D}`), BundleError)
  })
})

describe('rendering the bundle', () => {
  test('replaces every image variable with the digest reference and leaves the run-time variables', () => {
    const out = renderBundle(TEMPLATE, DIGESTS)
    assert.match(out, new RegExp(`^    image: ghcr.io/alp82/curia-daemon@sha256:${D}$`, 'm'))
    assert.equal((out.match(/curia-tmux@sha256:b{64}/g) ?? []).length, 2, 'tmux and ttyd share the image')
    assert.ok(!out.includes('_IMAGE'), 'no image variable survives')
    assert.ok(out.includes('${CURIA_ROOT:?}/run'), 'the root is a run-time variable')
    assert.ok(out.includes('${CURIA_INSTALLATION_ID:?}'), 'the installation ID is a run-time variable')
  })

  test('is deterministic', () => {
    assert.equal(renderBundle(TEMPLATE, DIGESTS), renderBundle(TEMPLATE, DIGESTS))
  })

  test('refuses a missing image, a tag, or a template that names an image the release does not build', () => {
    assert.throws(() => renderBundle(TEMPLATE, { ...DIGESTS, overseer: undefined }), /overseer/)
    assert.throws(() => renderBundle(TEMPLATE, { ...DIGESTS, tmux: '1.2.3' }), /tmux/)
    assert.throws(() => renderBundle(`${TEMPLATE}  agent:\n    image: \${CURIA_AGENT_IMAGE:?}\n`, DIGESTS), /CURIA_AGENT_IMAGE/)
  })
})

describe('inspecting a rendered bundle', () => {
  test('a rendered bundle passes', () => {
    assert.deepEqual(inspectBundle(renderBundle(TEMPLATE, DIGESTS)), [])
  })

  test('names every image that is not a digest reference under the registry', () => {
    const tagged = renderBundle(TEMPLATE, DIGESTS).replace(`curia-tmux@${DIGESTS.tmux}`, 'curia-tmux:latest')
    const foreign = renderBundle(TEMPLATE, DIGESTS).replace(`ghcr.io/alp82/curia-daemon@${DIGESTS.daemon}`, `docker.io/alp82/curia-daemon@${DIGESTS.daemon}`)
    assert.match(inspectBundle(tagged).join('\n'), /curia-tmux:latest/)
    assert.match(inspectBundle(foreign).join('\n'), /docker\.io/)
  })

  test('names a variable outside the run-time set, a build stanza, an env file, and an operator path', () => {
    const problems = inspectBundle([
      'name: curia',
      'services:',
      '  daemon:',
      '    build: .',
      `    image: ghcr.io/alp82/curia-daemon@sha256:${D}`,
      '    env_file: ../daemon/.env.daemon',
      '    environment:',
      '      HOME: ${CURIA_HOME:-/home/alp/curia-work/home}',
      '',
    ].join('\n')).join('\n')
    assert.match(problems, /CURIA_HOME/)
    assert.match(problems, /build/)
    assert.match(problems, /env_file/)
    assert.match(problems, /\/home\/alp/)
  })

  test('names a project name that is not the fixed one', () => {
    assert.match(inspectBundle(renderBundle(TEMPLATE, DIGESTS).replace('name: curia', 'name: curia-two')).join('\n'), /project name/)
    assert.match(inspectBundle(renderBundle(TEMPLATE, DIGESTS).replace('name: curia\n', '')).join('\n'), /project name/)
  })
})

describe('the run-time environment', () => {
  const facts = { root: '/home/operator/.local/share/curia', uid: 1001, gid: 1001, dockerGid: 998, installationId: 'f'.repeat(32) }

  test('is the five variables, one per line, in contract order', () => {
    assert.equal(bundleEnvironment(facts), [
      'CURIA_ROOT=/home/operator/.local/share/curia',
      'CURIA_UID=1001',
      'CURIA_GID=1001',
      'DOCKER_GID=998',
      `CURIA_INSTALLATION_ID=${'f'.repeat(32)}`,
      '',
    ].join('\n'))
  })

  test('refuses a relative root, a non-numeric id, and a malformed installation ID', () => {
    assert.throws(() => bundleEnvironment({ ...facts, root: 'curia' }), /CURIA_ROOT/)
    assert.throws(() => bundleEnvironment({ ...facts, uid: '1001' }), /CURIA_UID/)
    assert.throws(() => bundleEnvironment({ ...facts, dockerGid: -1 }), /DOCKER_GID/)
    assert.throws(() => bundleEnvironment({ ...facts, installationId: 'nope' }), /CURIA_INSTALLATION_ID/)
  })
})

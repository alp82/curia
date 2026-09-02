import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HEALTH_TIMEOUT_MS, composeProject, writeComposeEnvironment, parseServiceStates, serviceStates, startProject, pullAgentImage, waitForHealth, ComposeError,
} from '../src/compose.mjs'
import { SERVICES } from '../src/layout.mjs'
import { imageReference } from '../src/bundle.mjs'
import { createManifest, renderManifest } from '../src/manifest.mjs'
import { versionPaths } from '../src/root.mjs'
import { COMMIT, DIGESTS } from './fixtures/install.mjs'

const ID = 'a'.repeat(32)

function fakeDocker(answers = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    // After `compose --env-file <f> -f <file>`, or the plain `image pull`.
    const verb = args[0] === 'compose' ? args[args.indexOf('compose') + 1 + 4] : args.slice(0, 2).join(' ')
    const answer = answers[verb] ?? { ok: true, stdout: '', stderr: '' }
    return typeof answer === 'function' ? answer(args, calls) : answer
  }
  run.calls = calls
  return run
}

function healthy(services = SERVICES, overrides = {}) {
  return services.map((s) => JSON.stringify({ Service: s, State: 'running', Health: 'healthy', ExitCode: 0, ...overrides[s] })).join('\n') + '\n'
}

describe('composeProject', () => {
  test('names the env file under run/ and the bundle of the version', () => {
    const p = composeProject({ root: '/srv/curia', version: '1.2.3' })
    assert.equal(p.envFile, '/srv/curia/run/compose.env')
    assert.equal(p.file, '/srv/curia/versions/1.2.3/bundle/compose.yaml')
    assert.deepEqual(p.args('ps', '--all'), ['compose', '--env-file', '/srv/curia/run/compose.env', '-f', '/srv/curia/versions/1.2.3/bundle/compose.yaml', 'ps', '--all'])
  })
})

describe('writeComposeEnvironment', () => {
  test('writes the five run-time values owner-only under run/', () => {
    const root = mkdtempSync(join(tmpdir(), 'curia-compose-'))
    try {
      mkdirSync(join(root, 'run'))
      const project = composeProject({ root, version: '1.2.3' })
      writeComposeEnvironment(project, { uid: 1001, gid: 1001, dockerGid: 988, installationId: ID })
      assert.equal(readFileSync(project.envFile, 'utf8'), `CURIA_ROOT=${root}\nCURIA_UID=1001\nCURIA_GID=1001\nDOCKER_GID=988\nCURIA_INSTALLATION_ID=${ID}\n`)
      assert.equal(statSync(project.envFile).mode & 0o777, 0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('parseServiceStates', () => {
  test('reads one JSON object per line, as Compose 2.21 and later print', () => {
    const states = parseServiceStates(healthy(['daemon', 'tmux']))
    assert.deepEqual(states, [
      { service: 'daemon', state: 'running', health: 'healthy', exitCode: 0 },
      { service: 'tmux', state: 'running', health: 'healthy', exitCode: 0 },
    ])
  })

  test('reads one JSON array, as older Compose prints', () => {
    const states = parseServiceStates(JSON.stringify([{ Service: 'daemon', State: 'exited', Health: '', ExitCode: 1 }]))
    assert.deepEqual(states, [{ service: 'daemon', state: 'exited', health: '', exitCode: 1 }])
  })

  test('an empty answer is no service', () => {
    assert.deepEqual(parseServiceStates(''), [])
  })
})

// A root whose installed version holds the release manifest, which is where
// the agent image's digest reference comes from.
function rootWithManifest(version = '1.2.3', digests = DIGESTS) {
  const root = mkdtempSync(join(tmpdir(), 'curia-compose-'))
  const manifest = versionPaths(root, version).manifest
  mkdirSync(join(manifest, '..'), { recursive: true })
  writeFileSync(manifest, renderManifest(createManifest({ version, commit: COMMIT, bundleSha256: 'a'.repeat(64), digests })))
  return root
}
const AGENT = imageReference('agent', DIGESTS.agent)

describe('startProject', () => {
  test('pulls the service images through Compose and the agent image by its manifest digest, then brings the project up detached', async () => {
    const docker = fakeDocker()
    const root = rootWithManifest()
    const project = composeProject({ root, version: '1.2.3' })
    await startProject(project, { docker, stdout: { write() {} } })
    assert.deepEqual(docker.calls.map((c) => (c[0] === 'compose' ? c.slice(5) : c)), [['pull'], ['image', 'pull', '--quiet', AGENT], ['up', '--detach', '--remove-orphans', '--quiet-pull']])
    rmSync(root, { recursive: true, force: true })
  })

  test('a failed pull is a ComposeError that carries the docker message', async () => {
    const docker = fakeDocker({ pull: { ok: false, stdout: '', stderr: 'Error response from daemon: manifest unknown', code: 1 } })
    const project = composeProject({ root: '/srv/curia', version: '1.2.3' })
    await assert.rejects(startProject(project, { docker, stdout: { write() {} } }), (e) => e instanceof ComposeError && /manifest unknown/.test(e.message) && /docker compose .*pull/.test(e.message))
  })

  test('the agent image comes from the installed release manifest, and a root without one refuses before anything is pulled', async () => {
    const root = rootWithManifest('2.0.0', { ...DIGESTS, agent: `sha256:${'7'.repeat(64)}` })
    const docker = fakeDocker()
    await pullAgentImage(composeProject({ root, version: '2.0.0' }), { docker })
    assert.deepEqual(docker.calls, [['image', 'pull', '--quiet', imageReference('agent', `sha256:${'7'.repeat(64)}`)]])

    const bare = fakeDocker()
    await assert.rejects(pullAgentImage(composeProject({ root: '/srv/curia', version: '1.2.3' }), { docker: bare }), (e) => e instanceof ComposeError && /\/srv\/curia\/versions\/1\.2\.3\/cli\/manifest\.json/.test(e.message))
    assert.deepEqual(bare.calls, [])

    const refused = fakeDocker({ 'image pull': { ok: false, stdout: '', stderr: 'Error response from daemon: denied', code: 1 } })
    await assert.rejects(pullAgentImage(composeProject({ root, version: '2.0.0' }), { docker: refused }), (e) => e instanceof ComposeError && /denied/.test(e.message) && /docker image pull/.test(e.message))
    rmSync(root, { recursive: true, force: true })
  })
})

describe('waitForHealth', () => {
  test('returns when every declared service is healthy', async () => {
    const docker = fakeDocker({ ps: { ok: true, stdout: healthy() } })
    const project = composeProject({ root: '/srv/curia', version: '1.2.3' })
    const states = await waitForHealth(project, { docker, sleep: async () => {}, now: () => 0 })
    assert.deepEqual(states.map((s) => s.service), [...SERVICES])
  })

  test('polls while a service is still starting', async () => {
    let asked = 0
    const docker = fakeDocker({ ps: () => ({ ok: true, stdout: healthy(SERVICES, asked++ < 2 ? { daemon: { Health: 'starting' } } : {}) }) })
    const project = composeProject({ root: '/srv/curia', version: '1.2.3' })
    const slept = []
    await waitForHealth(project, { docker, sleep: async (ms) => { slept.push(ms) }, now: () => 0 })
    assert.equal(asked, 3)
    assert.equal(slept.length, 2)
  })

  test('an unhealthy or exited service fails at once and names it with its log command', async () => {
    const docker = fakeDocker({ ps: { ok: true, stdout: healthy(SERVICES, { dashboard: { State: 'exited', Health: '', ExitCode: 1 } }) } })
    const project = composeProject({ root: '/srv/curia', version: '1.2.3' })
    await assert.rejects(waitForHealth(project, { docker, sleep: async () => {}, now: () => 0 }), (e) => e instanceof ComposeError && /dashboard exited with code 1/.test(e.message) && /logs dashboard/.test(e.message))
  })

  test('a service that never becomes healthy before the deadline fails and names it', async () => {
    const docker = fakeDocker({ ps: { ok: true, stdout: healthy(SERVICES, { overseer: { Health: 'starting' } }) } })
    const project = composeProject({ root: '/srv/curia', version: '1.2.3' })
    let t = 0
    await assert.rejects(waitForHealth(project, { docker, sleep: async (ms) => { t += ms }, now: () => t }), (e) => e instanceof ComposeError && /overseer is still starting after/.test(e.message))
    assert.ok(t >= HEALTH_TIMEOUT_MS)
  })

  test('a declared service that Compose does not list is a failure, never a pass by absence', async () => {
    const docker = fakeDocker({ ps: { ok: true, stdout: healthy(['daemon', 'tmux', 'ttyd', 'dashboard']) } })
    const project = composeProject({ root: '/srv/curia', version: '1.2.3' })
    await assert.rejects(waitForHealth(project, { docker, sleep: async () => {}, now: () => 0 }), /overseer is not in the project/)
  })
})

describe('serviceStates', () => {
  test('asks for every container of the project as JSON', async () => {
    const docker = fakeDocker({ ps: { ok: true, stdout: healthy() } })
    const project = composeProject({ root: '/srv/curia', version: '1.2.3' })
    await serviceStates(project, { docker })
    assert.deepEqual(docker.calls[0].slice(5), ['ps', '--all', '--format', 'json'])
  })
})

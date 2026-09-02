// The Compose shape of an installed Curia (#867, implementing #851).
//
// `deploy/bundle/compose.yaml` is inspected against the container-access
// contract in cli/src/layout.mjs: every service gets exactly the boundaries
// `SERVICE_MOUNTS` grants it, at the same path on both sides, with the mode
// the contract states. No env file, no credential in any environment, the
// Docker socket on the service and the tmux runtime only, and no volume that
// could hold installation identity, durable state, or resumable work.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { BUNDLE_COMPOSE_FILE, composeConfigOf, composeConfigOfText } from './fixtures/compose.mjs'
import { serviceLayout, SERVICE_MOUNTS, DOCKER_SOCKET_SERVICES, SERVICES } from '../../cli/src/layout.mjs'
import { CREDENTIAL_ENV_KEYS } from '../../cli/src/secrets.mjs'
import { COMPOSE_PROJECT, INSTALLATION_LABEL, renderBundle, inspectBundle, bundleEnvironment } from '../../cli/src/bundle.mjs'

const ROOT = '/home/operator/.local/share/curia'
const INSTALLATION_ID = '0123456789abcdef0123456789abcdef'
const ENV = {
  CURIA_ROOT: ROOT,
  CURIA_UID: '1001',
  CURIA_GID: '1001',
  DOCKER_GID: '998',
  CURIA_INSTALLATION_ID: INSTALLATION_ID,
  CURIA_DAEMON_IMAGE: 'ghcr.io/alp82/curia-daemon@sha256:d',
  CURIA_TMUX_IMAGE: 'ghcr.io/alp82/curia-tmux@sha256:t',
  CURIA_DASHBOARD_IMAGE: 'ghcr.io/alp82/curia-dashboard@sha256:a',
  CURIA_OVERSEER_IMAGE: 'ghcr.io/alp82/curia-overseer@sha256:o',
}
const cfg = composeConfigOf(BUNDLE_COMPOSE_FILE, ENV)
const layout = serviceLayout(ROOT)

// Every bind mount of a service as { host, guest, mode }, named volumes left out.
function binds(service) {
  return (cfg.services[service].volumes ?? [])
    .map((v) => v.split(':'))
    .filter(([host]) => host.startsWith('/'))
    .map(([host, guest, mode = 'rw']) => ({ host, guest, mode }))
}

const SOCKETS = ['/var/run/docker.sock', '/var/run/tailscale/tailscaled.sock']

describe('the bundle names the five services and interpolates nothing but paths and numbers', () => {
  test('the five services, and no others', () => {
    assert.deepEqual(Object.keys(cfg.services), [...SERVICES])
  })

  test('one fixed project name, so one host runs one Curia under one name', () => {
    assert.equal(cfg.name, COMPOSE_PROJECT)
  })

  test('every variable is required, so a bundle started without one refuses', () => {
    assert.throws(() => composeConfigOf(BUNDLE_COMPOSE_FILE, { ...ENV, CURIA_ROOT: '' }), /CURIA_ROOT/)
    assert.throws(() => composeConfigOf(BUNDLE_COMPOSE_FILE, { ...ENV, DOCKER_GID: '' }), /DOCKER_GID/)
  })

  test('no service loads an env file, and no environment carries a credential key', () => {
    for (const [name, s] of Object.entries(cfg.services)) {
      assert.equal(s.env_file, undefined, `${name} loads an env file`)
      for (const key of Object.keys(s.environment ?? {})) {
        assert.ok(!CREDENTIAL_ENV_KEYS.includes(key), `${name} carries ${key} in its environment`)
      }
    }
  })

  test('containers run as the operator, never as an assumed uid 1000', () => {
    for (const [name, s] of Object.entries(cfg.services)) {
      assert.equal(s.user, '1001:1001', `${name} runs as the operator`)
    }
    assert.ok(!JSON.stringify(cfg).includes('1000'), 'nothing assumes uid 1000')
  })
})

describe('each container sees exactly its grant of the installation root', () => {
  for (const service of SERVICES) {
    test(`${service}: the root mounts are the contract's, at the same path, with the contract's mode`, () => {
      const rootBinds = binds(service).filter((b) => !SOCKETS.includes(b.host))
      const expected = SERVICE_MOUNTS[service].map(({ path, mode }) => ({ host: layout[path], guest: layout[path], mode }))
      assert.deepEqual(rootBinds, expected)
    })
  }

  test('no container mounts the whole root, and every root mount is inside a boundary', () => {
    for (const service of SERVICES) {
      for (const { host } of binds(service)) {
        if (SOCKETS.includes(host)) continue
        assert.notEqual(host, ROOT, `${service} mounts the whole root`)
        assert.ok(host.startsWith(`${ROOT}/`), `${service} mounts ${host}, outside the root`)
      }
    }
  })

  test('only the service reaches secrets/, and it is the only writer of state/', () => {
    for (const service of SERVICES) {
      const hosts = binds(service).map((b) => b.host)
      const reaches = (dir) => hosts.some((h) => h === dir || h.startsWith(`${dir}/`))
      assert.equal(reaches(layout.secrets), service === 'daemon', `${service} and secrets/`)
      assert.equal(reaches(layout.state), service === 'daemon', `${service} and state/`)
    }
  })

  // #880: the app mounts nothing of the root, so its settings save lands
  // through the service, which therefore writes `config/config.yaml`.
  test('the service reads config/ and writes it for the app\'s settings screen', () => {
    const config = binds('daemon').find((b) => b.host === layout.config)
    assert.equal(config.mode, 'rw')
  })

  test('the app mounts nothing of the root', () => {
    assert.deepEqual(binds('dashboard').map((b) => b.host), ['/var/run/tailscale/tailscaled.sock'])
  })
})

describe('sockets and volumes', () => {
  test('the service and the tmux runtime are the only containers with the Docker socket', () => {
    const withSocket = SERVICES.filter((s) => binds(s).some((b) => b.host === '/var/run/docker.sock'))
    assert.deepEqual(withSocket, [...DOCKER_SOCKET_SERVICES])
    for (const service of DOCKER_SOCKET_SERVICES) {
      assert.ok(cfg.services[service].group_add?.includes('998'), `${service} joins the docker group`)
    }
    for (const service of SERVICES) {
      if (!DOCKER_SOCKET_SERVICES.includes(service)) assert.equal(cfg.services[service].group_add, undefined)
    }
  })

  test('the overseer holds a shell, so it is off the host network and holds no socket', () => {
    assert.equal(cfg.services.overseer.network_mode, undefined)
    assert.deepEqual(cfg.services.overseer.extra_hosts, ['host.docker.internal:host-gateway'])
    assert.ok(!binds('overseer').some((b) => SOCKETS.includes(b.host)))
    assert.equal(cfg.services.overseer.environment.CURIA_OVERSEER_TOKEN_DIR, layout.overseerTokens)
  })

  test('the one named volume is the tmux socket: runtime, and recreatable without loss', () => {
    assert.deepEqual(Object.keys(cfg.volumes), ['tmux-sock'])
    for (const name of ['daemon', 'tmux', 'ttyd']) {
      assert.ok(cfg.services[name].volumes.includes('tmux-sock:/run/curia-tmux'), `${name} shares the socket`)
    }
  })

  test('every process runs on a home inside cache/, which holds nothing Curia keeps', () => {
    for (const [name, s] of Object.entries(cfg.services)) {
      assert.equal(s.environment?.HOME, layout.home, `${name} runs on a different home`)
    }
  })

  test('the service, the app, and the overseer are told the root, so one loader yields one set of paths', () => {
    for (const name of ['daemon', 'dashboard', 'overseer']) {
      assert.equal(cfg.services[name].environment.CURIA_ROOT, ROOT)
    }
  })
})

describe('owned resources carry the installation ID', () => {
  test('every container, the network, and the volume are labelled with it', () => {
    for (const [name, s] of Object.entries(cfg.services)) {
      assert.equal(s.labels?.[INSTALLATION_LABEL], INSTALLATION_ID, `${name} is not labelled`)
    }
    assert.equal(cfg.volumes['tmux-sock'].labels?.[INSTALLATION_LABEL], INSTALLATION_ID, 'the volume is not labelled')
    assert.equal(cfg.networks.default.labels?.[INSTALLATION_LABEL], INSTALLATION_ID, 'the network is not labelled')
  })

  test('a bundle started without the installation ID refuses', () => {
    assert.throws(() => composeConfigOf(BUNDLE_COMPOSE_FILE, { ...ENV, CURIA_INSTALLATION_ID: '' }), /CURIA_INSTALLATION_ID/)
  })
})

// Each check asks the process the question that means it is serving: the
// service and the overseer answer their own `/ping`, the tmux server holds the
// keeper session, the attach surface and the app answer HTTP on their ports.
const HEALTH = {
  daemon: /127\.0\.0\.1:4271\/ping/,
  tmux: /has-session -t keeper/,
  ttyd: /127\.0\.0\.1:7681/,
  dashboard: /127\.0\.0\.1:4273/,
  overseer: /127\.0\.0\.1:4274\/ping/,
}

describe('every service declares a health check that asks the process itself', () => {
  for (const service of SERVICES) {
    test(`${service}`, () => {
      const h = cfg.services[service].healthcheck
      assert.ok(h, `${service} has no health check`)
      assert.equal(h.test[0], 'CMD', 'exec form, so no shell interprets it')
      assert.match(h.test.join(' '), HEALTH[service])
      for (const key of ['interval', 'timeout', 'retries', 'start_period']) assert.ok(h[key] !== undefined, `${service} sets no ${key}`)
    })
  }

  test('the service and the app wait for a healthy tmux runtime and service, so a start settles in order', () => {
    assert.deepEqual(cfg.services.daemon.depends_on, { tmux: { condition: 'service_healthy' } })
    assert.deepEqual(cfg.services.ttyd.depends_on, { tmux: { condition: 'service_healthy' } })
  })
})

describe('the rendered bundle', () => {
  const template = fs.readFileSync(BUNDLE_COMPOSE_FILE, 'utf8')
  const digests = {
    daemon: `sha256:${'1'.repeat(64)}`,
    tmux: `sha256:${'2'.repeat(64)}`,
    dashboard: `sha256:${'3'.repeat(64)}`,
    overseer: `sha256:${'4'.repeat(64)}`,
  }
  const rendered = renderBundle(template, digests)
  const environment = bundleEnvironment({ root: ROOT, uid: 1001, gid: 1001, dockerGid: 998, installationId: INSTALLATION_ID })

  test('passes the static inspection: digests only, the five variables only, no build, no env file, no operator path', () => {
    assert.deepEqual(inspectBundle(rendered), [])
  })

  test('the template itself fails it only for the image variables, which is what rendering resolves', () => {
    const problems = inspectBundle(template)
    assert.ok(problems.length > 0)
    for (const p of problems) assert.match(p, /_IMAGE|image \$\{CURIA_/)
  })

  test('names each service\'s image by digest and the attach surface by the tmux image', () => {
    const r = composeConfigOfText(rendered, Object.fromEntries(environment.trim().split('\n').map((l) => l.split('='))))
    assert.equal(r.services.daemon.image, `ghcr.io/alp82/curia-daemon@${digests.daemon}`)
    assert.equal(r.services.tmux.image, `ghcr.io/alp82/curia-tmux@${digests.tmux}`)
    assert.equal(r.services.ttyd.image, r.services.tmux.image)
    assert.equal(r.services.dashboard.image, `ghcr.io/alp82/curia-dashboard@${digests.dashboard}`)
    assert.equal(r.services.overseer.image, `ghcr.io/alp82/curia-overseer@${digests.overseer}`)
  })

  test('renders the same bytes twice', () => {
    assert.equal(renderBundle(template, digests), rendered)
  })

  // Compose's own reader, where Docker is on the machine. `config` validates
  // the schema and the interpolation without touching an image or a socket.
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
  test('docker compose config accepts it', { skip: compose.status === 0 ? false : 'docker compose is not available here' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-bundle-'))
    try {
      fs.writeFileSync(path.join(dir, 'compose.yaml'), rendered)
      fs.writeFileSync(path.join(dir, 'bundle.env'), environment)
      const r = spawnSync('docker', ['compose', '--env-file', 'bundle.env', '-f', 'compose.yaml', 'config', '--format', 'json'], { cwd: dir, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      const out = JSON.parse(r.stdout)
      assert.equal(out.name, COMPOSE_PROJECT)
      assert.deepEqual(Object.keys(out.services).sort(), [...SERVICES].sort())
      for (const [name, s] of Object.entries(out.services)) {
        assert.equal(s.user, '1001:1001', name)
        assert.equal(s.labels[INSTALLATION_LABEL], INSTALLATION_ID, name)
        assert.ok(s.healthcheck?.test, `${name} lost its health check`)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

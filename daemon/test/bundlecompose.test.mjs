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
import { BUNDLE_COMPOSE_FILE, composeConfigOf } from './fixtures/compose.mjs'
import { serviceLayout, SERVICE_MOUNTS, DOCKER_SOCKET_SERVICES, SERVICES } from '../../cli/src/layout.mjs'
import { CREDENTIAL_ENV_KEYS } from '../../cli/src/secrets.mjs'

const ROOT = '/home/operator/.local/share/curia'
const ENV = {
  CURIA_ROOT: ROOT,
  CURIA_UID: '1001',
  CURIA_GID: '1001',
  DOCKER_GID: '998',
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

  test('the service reads config/ and cannot write it', () => {
    const config = binds('daemon').find((b) => b.host === layout.config)
    assert.equal(config.mode, 'ro')
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

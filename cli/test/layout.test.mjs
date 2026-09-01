import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { serviceLayout, SERVICE_MOUNTS, DOCKER_SOCKET_SERVICES, SERVICES } from '../src/layout.mjs'
import { BOUNDARIES } from '../src/root.mjs'

const ROOT = '/srv/curia'

describe('serviceLayout', () => {
  test('every path lives inside one of the seven boundaries', () => {
    const layout = serviceLayout(ROOT)
    for (const [name, path] of Object.entries(layout)) {
      if (name === 'root') continue
      const boundary = BOUNDARIES.find((b) => path === `${ROOT}/${b}` || path.startsWith(`${ROOT}/${b}/`))
      assert.ok(boundary, `${name} (${path}) is outside every boundary`)
    }
  })

  test('the boundary directories are the boundaries themselves', () => {
    const layout = serviceLayout(ROOT)
    for (const b of BOUNDARIES) {
      if (b === 'versions') continue
      assert.equal(layout[b], `${ROOT}/${b}`)
    }
  })

  test('the service data lands by lifecycle class', () => {
    const layout = serviceLayout(ROOT)
    // Durable: the journal and its neighbours.
    assert.equal(layout.state, `${ROOT}/state`)
    // Resumable: worktrees and native sessions, which the daemon calls its workspace root.
    assert.equal(layout.work, `${ROOT}/work`)
    assert.equal(layout.overseerConfigDir, `${ROOT}/work/cfg/curia-overseer`)
    // Disposable: the overseer's mirrors of origin and the containers' home.
    assert.equal(layout.overseerRepos, `${ROOT}/cache/overseer-repos`)
    assert.equal(layout.home, `${ROOT}/cache/home`)
    // Restart-disposable: renewable installation tokens.
    assert.equal(layout.overseerTokens, `${ROOT}/run/overseer-tokens`)
  })

  test('the root must be absolute', () => {
    assert.throws(() => serviceLayout('relative/root'), /absolute/)
  })

  test('the layout is frozen', () => {
    assert.ok(Object.isFrozen(serviceLayout(ROOT)))
  })
})

describe('SERVICE_MOUNTS', () => {
  test('names the five services and nothing else', () => {
    assert.deepEqual(Object.keys(SERVICE_MOUNTS), [...SERVICES])
    assert.deepEqual([...SERVICES], ['daemon', 'tmux', 'ttyd', 'dashboard', 'overseer'])
  })

  test('every mount names a layout path and a mode', () => {
    const layout = serviceLayout(ROOT)
    for (const [service, mounts] of Object.entries(SERVICE_MOUNTS)) {
      for (const { path, mode } of mounts) {
        assert.ok(path in layout && path !== 'root', `${service} mounts ${path}, which the layout does not name`)
        assert.ok(['ro', 'rw'].includes(mode), `${service}:${path} has mode ${mode}`)
      }
    }
  })

  test('the service is the only container that reaches secrets/ and state/', () => {
    for (const [service, mounts] of Object.entries(SERVICE_MOUNTS)) {
      const paths = mounts.map((m) => m.path)
      if (service === 'daemon') {
        assert.ok(paths.includes('secrets') && paths.includes('state'))
      } else {
        assert.ok(!paths.includes('secrets'), `${service} reaches secrets/`)
        assert.ok(!paths.includes('state'), `${service} reaches state/`)
      }
    }
  })

  test('the service reads config/ and never writes it', () => {
    const config = SERVICE_MOUNTS.daemon.find((m) => m.path === 'config')
    assert.equal(config.mode, 'ro')
  })

  test('the app receives no installation-root mount', () => {
    assert.deepEqual(SERVICE_MOUNTS.dashboard, [])
  })

  test('the overseer receives its work, its mirrors, and read-only tokens', () => {
    assert.deepEqual(SERVICE_MOUNTS.overseer, [
      { path: 'overseerConfigDir', mode: 'rw' },
      { path: 'overseerRepos', mode: 'rw' },
      { path: 'overseerTokens', mode: 'ro' },
    ])
  })

  test('only the service and the tmux runtime get the Docker socket', () => {
    assert.deepEqual([...DOCKER_SOCKET_SERVICES], ['daemon', 'tmux'])
  })
})

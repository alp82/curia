// The compose file stops being one box's paths (#473).
//
// `deploy/compose.yaml` used to write `/home/alp/...` on 34 lines, so a curia on
// another VPS had to reproduce this box's home directory or edit a committed
// file. Two variables answer that now, and the test that matters is the
// negative one: set them to somewhere else, and nothing of this box survives.
//
// The same-path principle is what these tests guard while that happens. Host
// paths are data in this repo, so every tree mounts at its identical path
// inside and no translation layer exists. A variable that moved one side alone
// would break the Chat screen's transcript read (ADR-0015) and the checkout
// pass, and it would do it silently.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeConfig, DEFAULT_REPO_ROOT, DEFAULT_WORKSPACE_ROOT, DEFAULT_HOME,
} from './fixtures/compose.mjs'

// A box that answered differently. Deliberately nothing like this box: another
// user, another root, and the two roots not sharing a parent — because they
// move independently and one variable would not say so.
const ELSEWHERE = { CURIA_REPO_ROOT: '/opt/curia', CURIA_WORKSPACE_ROOT: '/srv/curia-work' }

// Every host path the stack binds, service by service. The left side of a
// volume entry, minus the named volumes (`tmux-sock`), which are docker's.
function hostMounts(cfg) {
  return Object.values(cfg.services)
    .flatMap((s) => s.volumes ?? [])
    .map((v) => v.split(':')[0])
    .filter((h) => h.startsWith('/'))
}

// Both sides of every volume entry, so the same-path check can read them.
function mountPairs(cfg) {
  return Object.values(cfg.services)
    .flatMap((s) => s.volumes ?? [])
    .map((v) => v.split(':'))
    .filter(([host]) => host.startsWith('/'))
}

describe('the compose paths are this box\'s answers, not this box\'s paths (#473)', () => {
  test('a box that says nothing gets exactly the paths that used to be written down', () => {
    const cfg = composeConfig()
    const hosts = new Set(hostMounts(cfg))
    assert.ok(hosts.has(`${DEFAULT_REPO_ROOT}`), 'the checkout')
    assert.ok(hosts.has(`${DEFAULT_WORKSPACE_ROOT}`), 'the workspace')
    assert.ok(hosts.has(`${DEFAULT_WORKSPACE_ROOT}/overseer/tokens`), 'the tokens tree (#392)')
    // The defaults are what make this a deploy rather than an ssh session: the
    // box that runs curia today has told compose nothing, and must not have to.
    assert.equal(cfg.services.daemon.working_dir, `${DEFAULT_REPO_ROOT}/daemon`)
  })

  test('NOTHING of this box survives when a box answers for itself', () => {
    const cfg = composeConfig(ELSEWHERE)
    assert.ok(
      !JSON.stringify(cfg).includes('/home/alp'),
      'a curia on another VPS would have to reproduce this box\'s home directory',
    )
  })

  test('the two roots move independently — one variable would not say that', () => {
    const cfg = composeConfig({ CURIA_WORKSPACE_ROOT: '/srv/curia-work' })
    const hosts = new Set(hostMounts(cfg))
    assert.ok(hosts.has('/srv/curia-work'), 'the workspace moved')
    assert.ok(hosts.has(DEFAULT_REPO_ROOT), 'and the checkout did not follow it')
  })

  test('every tree still mounts at its identical path inside', () => {
    for (const env of [{}, ELSEWHERE]) {
      for (const [host, guest] of mountPairs(composeConfig(env))) {
        assert.equal(guest, host, `${host} mounts at a different path inside — ADR-0015 reads the transcript off the host path`)
      }
    }
  })
})

describe('curia owns its home, and never the operator\'s (#473)', () => {
  test('HOME is inside the workspace root, on every service that sets one', () => {
    const cfg = composeConfig()
    const homes = Object.entries(cfg.services)
      .map(([name, s]) => [name, s.environment?.HOME])
      .filter(([, home]) => home !== undefined)
    assert.ok(homes.length >= 4, 'the services that run a process all state a HOME')
    for (const [name, home] of homes) {
      assert.equal(home, DEFAULT_HOME, `${name} runs on a different home`)
    }
  })

  test('no mount reaches into a home directory for a credential', () => {
    for (const host of hostMounts(composeConfig(ELSEWHERE))) {
      for (const tree of ['/.claude', '/.codex', '/.config/gh', '/.gitconfig']) {
        assert.ok(!host.endsWith(tree), `${host} takes ${tree} out of the operator's home`)
      }
    }
  })

  test('the home needs no mount of its own — the workspace mount already carries it', () => {
    const cfg = composeConfig()
    assert.ok(
      !hostMounts(cfg).includes(DEFAULT_HOME),
      'a second mount of a tree inside a mounted tree is a second answer to where HOME is',
    )
    for (const name of ['daemon', 'tmux', 'ttyd']) {
      const hosts = cfg.services[name].volumes.map((v) => v.split(':')[0])
      assert.ok(hosts.includes(DEFAULT_WORKSPACE_ROOT), `${name} must mount the workspace, or its HOME does not exist`)
    }
  })
})

describe('the workspace root is written down twice, and the daemon checks (#473)', () => {
  test('every service that reads curia.yaml is handed the value compose mounted', () => {
    const cfg = composeConfig(ELSEWHERE)
    for (const name of ['daemon', 'dashboard', 'overseer']) {
      assert.equal(
        cfg.services[name].environment.CURIA_WORKSPACE_ROOT,
        '/srv/curia-work',
        `${name} loads curia.yaml, so it must be able to catch a workspace root nothing mounts`,
      )
    }
  })

  test('the images bake the same two paths the containers run on', () => {
    const cfg = composeConfig(ELSEWHERE)
    // The dependency tree is baked in, and compose mounts `daemon/src`,
    // `daemon/bin` and `daemon/assets` and nothing else under `daemon/` — so
    // `node_modules` lands beside them only when the image took the same root.
    for (const name of ['dashboard', 'overseer']) {
      assert.equal(cfg.services[name].build.args.CURIA_REPO_ROOT, '/opt/curia')
    }
    for (const name of ['daemon', 'tmux', 'dashboard', 'overseer']) {
      assert.equal(
        cfg.services[name].build.args.CURIA_HOME,
        '/srv/curia-work/home',
        `${name} bakes a home the container does not run on`,
      )
    }
  })
})

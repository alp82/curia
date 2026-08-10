// The self-deploy verb (#270). The daemon's half is fully mockable — exec and
// the docker socket are injected — so these tests pin the preflight refusals,
// the hand-off argv, the marker contract, and the boot-time resolution. The
// sibling script cannot run here (it needs compose and a box), so its test is
// the same kind attach.test.mjs uses on the ttyd argv: pin the text to the
// deploy rule.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SelfDeploy, helperRunArgs } from '../src/deploy.mjs'
import { parseCommand } from '../src/commands.mjs'
import { expandCommand } from '../src/bridge.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(DIR, '..', '..', 'deploy', 'self-deploy.sh')

const PREV = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)

function fakeStore() {
  const events = []
  return { events, logEvent: (type, data) => events.push({ type, ...data }) }
}

// A git/docker double: answers rev-parse from `shas`, throws where the
// scenario says so, and records every docker invocation.
function fakeExec({ head = PREV, origin = NEXT, ffOk = true, dockerError = null } = {}) {
  const docker = []
  const exec = async (file, args) => {
    if (file === 'git') {
      const verb = args[0]
      if (verb === 'fetch') return { stdout: '' }
      if (verb === 'rev-parse') return { stdout: `${args[1] === 'HEAD' ? head : origin}\n` }
      if (verb === 'merge-base') {
        if (!ffOk) throw new Error('exit 1')
        return { stdout: '' }
      }
    }
    if (file === 'docker') {
      docker.push(args)
      if (dockerError) throw new Error(dockerError)
      return { stdout: 'containerid\n' }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
  }
  return { exec, docker }
}

function build(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-deploy-'))
  // any stat-able file works as the socket double — only its gid is read
  const sock = path.join(dataDir, 'docker.sock')
  fs.writeFileSync(sock, '')
  const store = fakeStore()
  const { exec, docker } = fakeExec(opts)
  const deploy = new SelfDeploy({
    repoRoot: '/home/alp/curia', dataDir, store, exec,
    log: () => {}, port: 4271, home: '/home/alp', dockerSocket: sock,
  })
  return { deploy, store, docker, dataDir }
}

describe('parse and expansion', () => {
  test('deploy parses bare and refuses arguments', () => {
    assert.deepEqual(parseCommand('deploy'), { verb: 'deploy' })
    assert.equal(parseCommand('deploy now'), null)
  })

  test('the slash verb expands to the bare canonical text', () => {
    const i = { commandName: 'deploy', options: { getString: () => null } }
    assert.equal(expandCommand(i), 'deploy')
  })
})

describe('the daemon half: preflight and hand-off', () => {
  test('an up-to-date checkout deploys nothing', async () => {
    const { deploy, store, docker } = build({ head: PREV, origin: PREV })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /already at a{7}/)
    assert.equal(docker.length, 0)
    assert.equal(store.events.length, 0)
    assert.equal(deploy.readMarker(), null)
  })

  test('a diverged checkout is refused, not force-pushed over', async () => {
    const { deploy, docker } = build({ ffOk: false })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /commits origin\/main does not/)
    assert.equal(docker.length, 0)
  })

  test('an interpreted deploy is refused — no confirm exists for it', async () => {
    const { deploy, docker } = build()
    const reply = await deploy.run({ by: 'overseer', interpreted: true })
    assert.match(reply, /typed-only/)
    assert.equal(docker.length, 0)
  })

  test('the hand-off writes the marker, journals, and starts the sibling', async () => {
    const { deploy, store, docker } = build()
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /deploy handed off: a{7} → b{7}/)
    const marker = deploy.readMarker()
    assert.equal(marker.state, 'handed-off')
    assert.equal(marker.prev, PREV)
    assert.equal(marker.next, NEXT)
    assert.deepEqual(store.events, [{ type: 'deploy_requested', by: 'u1', prev: PREV, next: NEXT }])
    assert.equal(docker.length, 1)
    const args = docker[0]
    // detached, auto-removed, and named — the name is the concurrency guard
    for (const flag of ['-d', '--rm']) assert.ok(args.includes(flag), flag)
    assert.equal(args[args.indexOf('--name') + 1], 'curia-deploy')
    // host network, or the health check cannot see the daemon's loopback port
    assert.equal(args[args.indexOf('--network') + 1], 'host')
    assert.ok(args.includes('curia-daemon'))
    // the script runs from a container-local copy: the sibling's own merge
    // rewrites the checkout copy mid-run
    assert.ok(args.some((a) => a.includes('cp /home/alp/curia/deploy/self-deploy.sh /tmp/')))
    // script argv: prev next repoRoot markerFile logFile port
    assert.deepEqual(args.slice(-6), [PREV, NEXT, '/home/alp/curia', deploy.markerPath, deploy.logPath, '4271'])
  })

  test('a second deploy while one is in flight is refused by the marker', async () => {
    const { deploy, docker } = build()
    await deploy.run({ by: 'u1' })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /already in flight/)
    assert.equal(docker.length, 1)
  })

  test('a name conflict on the sibling reads as in-flight and clears the marker', async () => {
    const { deploy } = build({ dockerError: 'Conflict. The container name "/curia-deploy" is already in use' })
    const reply = await deploy.run({ by: 'u1' })
    assert.match(reply, /already in flight/)
    // the order never left, so the next attempt must not be refused
    assert.equal(deploy.readMarker(), null)
  })
})

describe('the surviving daemon half: resolution', () => {
  const resolve = (deploy, { sleep } = {}) => {
    const said = []
    const p = deploy.resolvePending({
      announce: async (text) => said.push(text),
      pollMs: 1, timeoutMs: 20,
      sleep: sleep ?? (() => Promise.resolve()),
    })
    return { said, p }
  }
  const writeMarker = (deploy, state, extra = {}) =>
    fs.writeFileSync(deploy.markerPath, JSON.stringify({ state, prev: PREV, next: NEXT, ...extra }))

  test('no marker means no deploy to resolve', async () => {
    const { deploy } = build()
    assert.equal(await deploy.resolvePending({ announce: async () => {} }), null)
  })

  test('landed: journalled, announced, marker cleared', async () => {
    const { deploy, store } = build()
    writeMarker(deploy, 'landed')
    const { said, p } = resolve(deploy)
    assert.equal(await p, 'landed')
    assert.deepEqual(store.events, [{ type: 'deploy_landed', prev: PREV, next: NEXT }])
    assert.match(said[0], /deploy landed/)
    assert.equal(deploy.readMarker(), null)
  })

  test('the poll waits out a sibling still working', async () => {
    const { deploy, store } = build()
    writeMarker(deploy, 'rolling-back')
    let polls = 0
    const { said, p } = resolve(deploy, {
      sleep: async () => {
        if (++polls === 2) writeMarker(deploy, 'rolled-back', { reason: 'health check failed' })
      },
    })
    assert.equal(await p, 'rolled-back')
    assert.equal(store.events[0].type, 'deploy_rolled_back')
    assert.equal(store.events[0].reason, 'health check failed')
    assert.match(said[0], /ROLLED BACK/)
  })

  test('a sibling that never answers resolves as unknown', async () => {
    const { deploy, store } = build()
    writeMarker(deploy, 'handed-off')
    const { said, p } = resolve(deploy)
    assert.equal(await p, 'handed-off')
    assert.equal(store.events[0].type, 'deploy_unresolved')
    assert.match(said[0], /outcome unknown/)
    assert.equal(deploy.readMarker(), null)
  })
})

describe('the sibling script holds the deploy rule', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8')
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

  test('every compose up names its targets, forced, with --no-deps', () => {
    const ups = code.split('\n').filter((l) => /compose .*up/.test(l))
    assert.ok(ups.length >= 1)
    // --force-recreate: a code-only deploy changes no image layer, and
    // without it compose leaves the old daemon running (the #270 drill
    // caught exactly that)
    for (const l of ups) assert.match(l, /up -d --build --force-recreate --no-deps daemon dashboard$/)
  })

  test('the script never touches tmux or ttyd', () => {
    assert.doesNotMatch(code, /tmux|ttyd/)
  })

  test('both failure paths return to the previous ref', () => {
    assert.match(code, /git -C "\$REPO" reset --hard "\$PREV"/)
    assert.match(code, /mark lockout/)
  })
})

describe('helperRunArgs', () => {
  test('mounts what the sibling needs and nothing writable it does not', () => {
    const args = helperRunArgs({ repoRoot: '/r', dataDir: '/r/daemon/data', home: '/h', uid: 1000, gid: 998 })
    const mounts = args.filter((a, i) => args[i - 1] === '-v')
    assert.deepEqual(mounts, [
      '/var/run/docker.sock:/var/run/docker.sock',
      '/r:/r',
      '/r/daemon/data:/r/daemon/data',
      '/h/.config/gh:/h/.config/gh',
      '/h/.gitconfig:/h/.gitconfig:ro',
    ])
    assert.equal(args[args.indexOf('--group-add') + 1], '998')
  })
})

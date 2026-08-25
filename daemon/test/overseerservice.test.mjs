// The overseer service (#327, building ADR-0015): the compose service, the
// config block, the health check and the container's own process.
//
// The compose stanza is PINNED here the way attach.test.mjs pins the ttyd
// argv. Two of its lines are security-relevant and nothing else would notice
// them changing: the absence of an env file, and the absence of `network_mode:
// host`. Those omissions keep credentials and host-only services outside the
// container boundary.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeConfig, DEFAULT_REPO_ROOT, DEFAULT_WORKSPACE_ROOT } from './fixtures/compose.mjs'
import {
  DEFAULT_OVERSEER, PING_PATH, PING_MARK, readOverseer, overseerHandler, probeOverseer,
} from '../src/overseerservice.mjs'
import { TURN_PATH } from '../src/overseerturn.mjs'
import { loadCuriaConfig } from '../src/config.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// Resolved the way compose resolves it (#473): every path here is a variable
// now, and what these tests pin is the mount rather than the variable.
const COMPOSE = composeConfig()
const SERVICE = COMPOSE.services.overseer
const DOCKERFILE = fs.readFileSync(path.join(REPO, 'deploy', 'overseer', 'Dockerfile'), 'utf8')
// The comments name what the image deliberately leaves out, so the pins below
// read the instructions alone.
const DOCKER_INSTRUCTIONS = DOCKERFILE.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

describe('the compose overseer service (#327 pins)', () => {
  test('it loads no env file', () => {
    assert.equal(SERVICE.env_file, undefined)
    assert.ok(!JSON.stringify(SERVICE).includes('.env.daemon'))
    assert.ok(!JSON.stringify(SERVICE).includes('.env.overseer'))
  })

  test('it is NOT on the host network, unlike every other service', () => {
    assert.equal(SERVICE.network_mode, undefined)
    for (const name of ['daemon', 'tmux', 'ttyd', 'dashboard']) {
      assert.equal(COMPOSE.services[name].network_mode, 'host', `${name} stays on the host network`)
    }
  })

  test('its one published port is loopback, and it is the configured one', () => {
    assert.deepEqual(SERVICE.ports, [`127.0.0.1:${DEFAULT_OVERSEER.port}:${DEFAULT_OVERSEER.port}`])
  })

  test('it reaches the daemon the way an agent container does', () => {
    assert.deepEqual(SERVICE.extra_hosts, ['host.docker.internal:host-gateway'])
  })

  test('compose owns its liveness (ADR-0015), and it holds no docker socket', () => {
    assert.equal(SERVICE.restart, 'unless-stopped')
    assert.ok(!JSON.stringify(SERVICE.volumes).includes('docker.sock'), 'a shell plus the docker socket is root on the box')
    assert.ok(!JSON.stringify(SERVICE.volumes).includes('tailscaled.sock'))
  })

  test('the two same-path trees are mounted read-WRITE, and the config read-only', () => {
    const mounts = Object.fromEntries(SERVICE.volumes.map((v) => {
      const [host, guest, mode = 'rw'] = v.split(':')
      return [host, { guest, mode }]
    }))
    for (const tree of [`${DEFAULT_WORKSPACE_ROOT}/overseer/repos`, `${DEFAULT_WORKSPACE_ROOT}/cfg/curia-overseer`]) {
      assert.equal(mounts[tree].guest, tree, 'the same path on both sides, or the Chat screen reads nothing')
      assert.equal(mounts[tree].mode, 'rw')
    }
    assert.equal(mounts[`${DEFAULT_REPO_ROOT}/config`].mode, 'ro')
    // The tokens tree (#392): read-only, at the same path, and the shim is
    // pointed at that same path. A container that could write here could
    // rewrite its own credential.
    const tokens = `${DEFAULT_WORKSPACE_ROOT}/overseer/tokens`
    assert.equal(mounts[tokens].guest, tokens)
    assert.equal(mounts[tokens].mode, 'ro')
    assert.equal(SERVICE.environment.CURIA_OVERSEER_TOKEN_DIR, tokens)
    // The mount list is the secret-free claim, so it names files rather than
    // trees: `daemon/` as a whole carries `.env.daemon` and the journal.
    assert.ok(!SERVICE.volumes.some((v) => v.startsWith(`${DEFAULT_REPO_ROOT}/daemon:`)))
  })

  test('it runs the container process from the repo mount', () => {
    assert.deepEqual(SERVICE.command, ['node', `${DEFAULT_REPO_ROOT}/daemon/bin/curia-overseer.mjs`])
    assert.equal(SERVICE.user, '1000:1000')
    assert.equal(SERVICE.build.args.CLAUDE_VERSION, '2.1.220')
    assert.match(DOCKER_INSTRUCTIONS, /@anthropic-ai\/claude-code@\$\{CLAUDE_VERSION\}/)
  })
})

describe('the overseer image (#327)', () => {
  test('the shim is installed as `gh`, and the real binary lands out of PATH', () => {
    assert.match(DOCKER_INSTRUCTIONS, /COPY deploy\/overseer\/gh-shim\.sh \/usr\/local\/bin\/gh/)
    assert.match(DOCKER_INSTRUCTIONS, /\/usr\/local\/libexec\/curia\/gh/)
  })

  test('what the shell admits, and what it does not', () => {
    const apt = /apt-get install -y --no-install-recommends\s+([^&]+)/.exec(DOCKER_INSTRUCTIONS)[1]
    for (const pkg of ['git', 'curl', 'jq', 'less', 'procps', 'ripgrep', 'ca-certificates']) {
      assert.ok(apt.includes(pkg), `${pkg} is what the shell reads a tree with`)
    }
    for (const pkg of ['build-essential', 'tmux', 'ttyd', 'chromium']) {
      assert.ok(!apt.includes(pkg), `${pkg} is the agent image's, not the overseer's`)
    }
    assert.ok(!/@openai\/codex|playwright/i.test(DOCKER_INSTRUCTIONS))
  })

  test('it is its own image, so the agent image tag never churns for it', () => {
    const agent = fs.readFileSync(path.join(REPO, 'deploy', 'agent', 'Dockerfile'), 'utf8')
    assert.ok(!/overseer/i.test(agent), 'the agent tag is a content address over these bytes (#154)')
  })
})

describe('the `overseer:` config block', () => {
  const fail = (msg) => { throw new Error(msg) }

  test('it defaults, so a config predating the container still boots', () => {
    assert.deepEqual(readOverseer({}, fail), { port: DEFAULT_OVERSEER.port })
  })

  test('a bad shape refuses rather than defaulting quietly', () => {
    assert.throws(() => readOverseer({ overseer: [] }, fail), /must be a mapping/)
    assert.throws(() => readOverseer({ overseer: { port: 'x' } }, fail), /must be a port number/)
    assert.throws(() => readOverseer({ overseer: { port: 99999 } }, fail), /must be a port number/)
  })

  test('the shipped config names it, and it collides with nothing', () => {
    const cfg = loadCuriaConfig(path.join(REPO, 'config', 'curia.yaml'), { checkPaths: false })
    assert.equal(cfg.overseer.port, DEFAULT_OVERSEER.port)
    const others = [
      cfg.attach.ttyd_port, cfg.attach.serve_port, cfg.identity.proxy_port,
      cfg.timeline.port, cfg.timeline.serve_port, cfg.dashboard.port, cfg.dashboard.serve_port,
    ]
    assert.ok(!others.includes(cfg.overseer.port))
  })

  test('a port another surface already holds refuses the boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overseer-cfg-'))
    const file = path.join(dir, 'curia.yaml')
    const base = fs.readFileSync(path.join(REPO, 'config', 'curia.yaml'), 'utf8')
    fs.writeFileSync(file, base.replace(/^  port: 4274$/m, '  port: 4273'))
    assert.throws(() => loadCuriaConfig(file, { checkPaths: false }), /dashboard\.port and overseer\.port are both 4273/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('the health check (ADR-0015: compose owns liveness, the daemon only reports it)', () => {
  const listen = (handler) => new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })

  test('a live overseer answers its marker', async () => {
    const srv = await listen(overseerHandler({ log: () => {} }))
    const { up, why } = await probeOverseer({ port: srv.address().port })
    assert.equal(up, true)
    assert.equal(why, null)
    srv.close()
  })

  test('nothing listening is down, and it says so rather than throwing', async () => {
    const { up, why } = await probeOverseer({ port: 1 })
    assert.equal(up, false)
    assert.match(why, /nothing is listening/)
  })

  test('something else on the port is NOT the overseer', async () => {
    const srv = await listen((req, res) => { res.writeHead(200); res.end('a dev server') })
    const { up, why } = await probeOverseer({ port: srv.address().port })
    assert.equal(up, false)
    assert.match(why, /not the overseer/)
    srv.close()
  })

  // #314 landed the turn, so the container now has TWO routes and no third.
  test('it serves the ping and the turn, and nothing else', async () => {
    const seen = []
    const srv = await listen(overseerHandler({
      log: () => {},
      turn: (req, res) => {
        seen.push(req.url)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end('{"event":"end","ok":true}\n')
      },
    }))
    try {
      const base = `http://127.0.0.1:${srv.address().port}`
      const ping = await fetch(`${base}${PING_PATH}`)
      assert.equal((await ping.text()).trim(), PING_MARK)

      const turn = await fetch(`${base}${TURN_PATH}`, { method: 'POST', body: '{}' })
      assert.equal(turn.status, 200)
      assert.deepEqual(seen, [TURN_PATH])

      // A turn is a POST. A GET that ran one would let anything that can reach
      // this port spend a model turn by being pointed at it.
      assert.equal((await fetch(`${base}${TURN_PATH}`)).status, 404)
      assert.equal((await fetch(`${base}/state`)).status, 404)
      assert.deepEqual(seen, [TURN_PATH])
    } finally {
      srv.close()
    }
  })

  test('a container that could not build a turn route still answers the health check', async () => {
    const srv = await listen(overseerHandler({ log: () => {} }))
    try {
      const base = `http://127.0.0.1:${srv.address().port}`
      assert.equal((await fetch(`${base}${PING_PATH}`)).status, 200)
      assert.equal((await fetch(`${base}${TURN_PATH}`, { method: 'POST', body: '{}' })).status, 404)
    } finally {
      srv.close()
    }
  })
})

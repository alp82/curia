// The release images (#869, implementing #849, #851, and #854).
//
// Each service Dockerfile ends in a `release` stage that carries the checkout
// at /opt/curia with its dependency tree installed, so the bundle mounts no
// source. These tests inspect the Dockerfiles as text, which needs no Docker:
// the stage exists, it copies only named checkout paths and never a secret or
// a whole tree, it assumes no uid and no operator path, every base image is
// pinned, and the pins come from the one place that holds them. One opt-in
// test builds the tmux image and runs it as an arbitrary uid, where Docker is
// on the machine and `CURIA_BUILD_IMAGES=1` asks for it.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

import { RELEASE_IMAGES } from '../../cli/src/bundle.mjs'
import { composeConfig } from './fixtures/compose.mjs'
import { releasePins, PINS_FILE } from '../../deploy/bundle/pins.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dockerfileOf = (service) => path.join(REPO, 'deploy', service, 'Dockerfile')

// The instructions of one stage, comment lines dropped and continuation
// lines joined, so a regex reads one instruction per line.
function stages(text) {
  const out = {}
  let current = null
  for (const raw of text.replace(/\\\n/g, ' ').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line)
    if (from) {
      current = from[2] ?? from[1]
      out[current] = { base: from[1], lines: [] }
      continue
    }
    if (current) out[current].lines.push(line)
  }
  return out
}

// What a release stage may copy out of the checkout: the paths a service
// reads at run time, and nothing beside them.
const CHECKOUT_PATHS = [
  'daemon/package.json', 'daemon/package-lock.json', 'daemon/src', 'daemon/bin', 'daemon/assets',
  'daemon/bin/curia-attach.sh', 'daemon/assets/attach-index.html',
  'cli/src', 'config/curia.yaml', 'config/routing.yaml', 'skills', 'deploy/agent', 'deploy/overseer/gh-shim.sh',
]

describe('every service Dockerfile ends in a release stage', () => {
  for (const service of Object.keys(RELEASE_IMAGES)) {
    const text = fs.readFileSync(dockerfileOf(service), 'utf8')
    const all = stages(text)
    const release = all.release

    test(`${service}: the release stage is the last one, so a build with no target is the release`, () => {
      assert.ok(release, `deploy/${service}/Dockerfile has no release stage`)
      assert.equal(Object.keys(all).at(-1), 'release')
    })

    test(`${service}: it assumes no uid, no operator path, and no source-deployment argument`, () => {
      const body = release.lines.join('\n')
      assert.ok(!/\b1000\b/.test(body), 'a uid is assumed')
      assert.ok(!/\/home\//.test(body), 'an operator path')
      assert.ok(!/CURIA_HOME|CURIA_REPO_ROOT|CURIA_WORKSPACE_ROOT/.test(body), 'a source-deployment argument')
      assert.ok(!/\buseradd\b|\bchown\b/.test(body), 'a user is created or a path is given to one')
    })

    test(`${service}: it copies named checkout paths under /opt/curia, never a tree or a secret`, () => {
      const copies = release.lines.filter((l) => /^COPY\b/.test(l) && !/--from=/.test(l))
      assert.ok(copies.length > 0, 'nothing is copied')
      for (const copy of copies) {
        const words = copy.split(/\s+/).slice(1).filter((w) => !w.startsWith('--'))
        const destination = words.at(-1)
        assert.ok(destination.startsWith('/opt/curia/') || destination.startsWith('./'), `${copy}: lands outside /opt/curia`)
        for (const source of words.slice(0, -1)) {
          assert.ok(CHECKOUT_PATHS.includes(source), `${copy}: ${source} is not a named checkout path`)
        }
      }
      const workdir = release.lines.find((l) => /^WORKDIR\b/.test(l))
      if (workdir) assert.match(workdir, /^WORKDIR \/opt\/curia\//)
    })

    test(`${service}: it is labelled with its source, so GHCR links the package to the repository`, () => {
      assert.match(release.lines.join('\n'), /org\.opencontainers\.image\.source="https:\/\/github\.com\/alp82\/curia"/)
    })

    test(`${service}: every base image is a pinned version, never a floating tag`, () => {
      // The ARG defaults declared before the first FROM, plus the two pins the
      // release passes in, are what the base images resolve against.
      const defaults = { ...releasePins() }
      for (const m of text.matchAll(/^ARG ([A-Z_]+)=(\S+)/gm)) defaults[m[1]] = m[2]
      for (const [name, { base }] of Object.entries(all)) {
        if (Object.hasOwn(all, base)) continue
        const resolved = base.replace(/\$\{([A-Z_]+)\}/g, (_, arg) => {
          assert.ok(defaults[arg], `${name} builds on ${base}, and ${arg} has no pinned value`)
          return defaults[arg]
        })
        assert.ok(!/:latest$|^[^:@]+$/.test(resolved), `${name} builds on ${resolved}, which floats`)
        assert.match(resolved, /:\S*\d\S*$/, `${name} builds on ${resolved}, which names no version`)
      }
    })
  }

  test('the two images that share the tmux socket volume seed it for any uid', () => {
    for (const service of ['daemon', 'tmux']) {
      const body = stages(fs.readFileSync(dockerfileOf(service), 'utf8')).release.lines.join('\n')
      assert.match(body, /mkdir -p \/run\/curia-tmux && chmod 1777 \/run\/curia-tmux/, `${service} seeds the socket directory for uid 1000 only`)
    }
  })

  test('the node images install the dependency tree from the lock file, with no scripts', () => {
    for (const service of ['daemon', 'dashboard', 'overseer']) {
      const body = stages(fs.readFileSync(dockerfileOf(service), 'utf8')).release.lines.join('\n')
      assert.match(body, /COPY daemon\/package\.json daemon\/package-lock\.json/)
      assert.match(body, /npm ci --omit=dev --no-fund --no-audit --ignore-scripts/)
    }
  })

  test('the source deployment builds the box stage, so its images are unchanged by the release stage', () => {
    const compose = composeConfig()
    for (const service of Object.keys(RELEASE_IMAGES)) {
      assert.equal(compose.services[service].build.target, 'box', `${service} builds the wrong stage on the box`)
    }
  })
})

describe('the release pins', () => {
  const pins = releasePins()
  const compose = YAML.parse(fs.readFileSync(path.join(REPO, 'deploy', 'compose.yaml'), 'utf8'))

  test('come from config/curia.yaml, and match the anchors the source deployment builds with', () => {
    assert.equal(PINS_FILE, path.join(REPO, 'config', 'curia.yaml'))
    assert.deepEqual(Object.keys(pins), ['NODE_VERSION', 'CLAUDE_VERSION'])
    assert.equal(pins.NODE_VERSION, compose['x-node-version'])
    assert.equal(pins.CLAUDE_VERSION, compose['x-claude-version'])
  })

  test('print as build arguments, one per line', () => {
    const r = spawnSync(process.execPath, [path.join(REPO, 'deploy', 'bundle', 'pins.mjs')], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, `NODE_VERSION=${pins.NODE_VERSION}\nCLAUDE_VERSION=${pins.CLAUDE_VERSION}\n`)
  })
})

// The one test that runs Docker. The tmux image is the smallest and the one
// whose process looks its user up, so it is the one to prove for a uid the
// image has never heard of.
const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
const wantsBuild = process.env.CURIA_BUILD_IMAGES === '1'
const skip = !wantsBuild ? 'set CURIA_BUILD_IMAGES=1 to build the tmux image' : docker.status !== 0 ? 'Docker is not available here' : false

describe('the tmux release image', () => {
  test('builds, and runs tmux and ttyd as an arbitrary uid', { skip, timeout: 10 * 60_000 }, () => {
    const tag = `curia-tmux-test:${Date.now()}`
    const build = spawnSync('docker', ['build', '--target', 'release', '-t', tag, '-f', dockerfileOf('tmux'), REPO], { encoding: 'utf8' })
    assert.equal(build.status, 0, build.stderr.slice(-4000))
    try {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-tmux-home-'))
      fs.chmodSync(home, 0o777)
      const run = (...argv) => spawnSync('docker', ['run', '--rm', '--user', '4242:4242', '-e', `HOME=${home}`, '-v', `${home}:${home}`, tag, ...argv], { encoding: 'utf8' })
      const tmux = run('sh', '-c', 'tmux -S /run/curia-tmux/default new-session -d -s keeper && tmux -S /run/curia-tmux/default has-session -t keeper && echo held')
      assert.equal(tmux.status, 0, tmux.stderr)
      assert.match(tmux.stdout, /held/)
      const ttyd = run('ttyd', '--version')
      assert.equal(ttyd.status, 0, ttyd.stderr)
      const attach = run('/opt/curia/daemon/bin/curia-attach.sh', 'not-a-session')
      assert.match(attach.stdout, /refused/)
      fs.rmSync(home, { recursive: true, force: true })
    } finally {
      spawnSync('docker', ['rmi', '-f', tag])
    }
  })
})

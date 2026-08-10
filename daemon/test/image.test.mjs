// The agent image (#154). Two things carry the weight here, and neither one
// can be checked by running a build in a test: the TAG IS A CONTENT ADDRESS
// (so "the daemon rebuilds when a CLI version bumps" is arithmetic, not a
// promise), and the config refuses an unpinned image rather than building one.
//
// The build itself is proved live on the box, not here — a test that shells
// out to docker would take four minutes and fail on a machine without it.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'

import { loadCuriaConfig } from '../src/config.mjs'
import {
  BUILD_CONTEXT, DEFAULT_IMAGE, DOCKERFILE, SANDBOX_KEYS,
  buildArgs, imageDigest, agentImageRef,
} from '../src/image.mjs'
import { withSeededHome } from './fixtures/skills.mjs'

const PINS = {
  image: 'curia-agent',
  claude_version: '2.1.220',
  codex_version: '0.146.0',
  gh_version: '2.97.0',
  playwright_version: '1.62.1',
  ttyd_version: '1.7.7',
  agent_uid: 1000,
}

let tmp

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-image-')) })
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// The Dockerfile with its comment lines dropped. The comments name the very
// constructs the checks below forbid, so a raw read matches its own prose.
function instructions() {
  return fs.readFileSync(DOCKERFILE, 'utf8')
    .split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
}

function otherDockerfile(body) {
  const file = path.join(tmp, `Dockerfile-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(file, body)
  return file
}

describe('the image tag (#154)', () => {
  test('the same pins and the same Dockerfile give the same ref', () => {
    assert.equal(agentImageRef(PINS).ref, agentImageRef({ ...PINS }).ref)
  })

  test('the legible half names both CLI versions', () => {
    const { ref } = agentImageRef(PINS)
    assert.match(ref, /^curia-agent:2\.1\.220-0\.146\.0-[0-9a-f]{8}$/)
  })

  test('a bump in ANY pin changes the tag — that is what triggers the rebuild', () => {
    const base = agentImageRef(PINS).tag
    for (const key of Object.keys(SANDBOX_KEYS)) {
      const bumped = key === 'agent_uid' ? 1001 : `${PINS[key]}1`
      assert.notEqual(agentImageRef({ ...PINS, [key]: bumped }).tag, base, `${key} did not move the tag`)
    }
  })

  test('an edit to the Dockerfile changes the tag, with no pin touched', () => {
    const a = otherDockerfile('FROM node:lts-slim\n')
    const b = otherDockerfile('FROM node:lts-slim\nRUN echo one more thing\n')
    assert.notEqual(imageDigest(PINS, a), imageDigest(PINS, b))
  })

  test('the repository name comes from config, the tag never does', () => {
    const ref = agentImageRef({ ...PINS, image: 'somewhere/curia-agent' })
    assert.equal(ref.repo, 'somewhere/curia-agent')
    assert.equal(ref.tag, agentImageRef(PINS).tag)
  })

  test('every pin reaches the build as the ARG the Dockerfile declares', () => {
    const args = buildArgs(PINS)
    assert.deepEqual(args, {
      CLAUDE_VERSION: '2.1.220',
      CODEX_VERSION: '0.146.0',
      GH_VERSION: '2.97.0',
      PLAYWRIGHT_VERSION: '1.62.1',
      TTYD_VERSION: '1.7.7',
      AGENT_UID: '1000',
    })
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')
    for (const arg of Object.keys(args)) {
      assert.match(dockerfile, new RegExp(`^ARG ${arg}\\b`, 'm'), `the Dockerfile declares no ${arg}`)
    }
  })

  test('the build context is the Dockerfile\'s own directory, so the repo is not uploaded', () => {
    assert.equal(BUILD_CONTEXT, path.dirname(DOCKERFILE))
    assert.deepEqual(fs.readdirSync(BUILD_CONTEXT), ['Dockerfile'])
  })

  test('the Dockerfile COPYs nothing — an empty context has to be enough', () => {
    assert.doesNotMatch(instructions(), /^\s*(COPY|ADD)\s/mi)
  })

  test('the Dockerfile stays on the classic builder — the box runs docker 20.10', () => {
    assert.doesNotMatch(instructions(), /RUN\s+--mount/)
    assert.doesNotMatch(instructions(), /<<[A-Z]/)
  })
})

describe('sandbox config (#154)', () => {
  function writeConfig(sandboxLines) {
    const file = path.join(tmp, `curia-${Math.random().toString(36).slice(2)}.yaml`)
    fs.writeFileSync(file, [
      'watch:',
      '  - repo: o/r',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 2',
      '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work')}`,
      '  ready_timeout_s: 45',
      'attach:',
      '  ttyd_port: 7681',
      '  serve_port: 8443',
      'identity:',
      '  allow: [tester@example.com]',
      'skills:',
      '  install: []',
      ...(sandboxLines ?? []),
      '',
    ].join('\n'))
    return file
  }

  const FULL = [
    'sandbox:',
    '  claude_version: 2.1.220',
    '  codex_version: 0.146.0',
    '  gh_version: 2.97.0',
    '  playwright_version: 1.62.1',
    '  ttyd_version: 1.7.7',
    '  agent_uid: 1000',
  ]

  // #195 retired the bare tmux path, so the section stopped being optional. It
  // used to be, because the sandbox shipped behind a per-harness switch that
  // was off by default and a box running no containers needed no pins. Every
  // agent runs in a container now, and a daemon with no image can dispatch
  // nothing — so silence here has to refuse the boot rather than reach the
  // first dispatch with a claim already taken.
  test('a config with no sandbox section refuses the boot — every agent runs in a container', () => {
    assert.throws(() => loadCuriaConfig(writeConfig(null)), /`sandbox:` section is required/)
  })

  test('a full section loads, and the image name defaults', () => {
    const cfg = loadCuriaConfig(writeConfig(FULL))
    assert.equal(cfg.sandbox.image, DEFAULT_IMAGE)
    assert.equal(cfg.sandbox.claude_version, '2.1.220')
    assert.equal(cfg.sandbox.agent_uid, 1000)
  })

  test('a missing pin is refused, naming the key', () => {
    for (const key of ['claude_version', 'codex_version', 'gh_version', 'playwright_version', 'ttyd_version']) {
      const lines = FULL.filter((l) => !l.trim().startsWith(`${key}:`))
      assert.throws(() => loadCuriaConfig(writeConfig(lines)), new RegExp(`sandbox\\.${key}`))
    }
  })

  test('an unpinned version is refused — `latest` is the failure this section prevents', () => {
    for (const bad of ['latest', '^2.1.220', '', 'next']) {
      const lines = FULL.map((l) => (l.trim().startsWith('claude_version:') ? `  claude_version: "${bad}"` : l))
      assert.throws(() => loadCuriaConfig(writeConfig(lines)), /sandbox\.claude_version/)
    }
  })

  test('a version YAML read as a number still loads', () => {
    const lines = FULL.map((l) => (l.trim().startsWith('playwright_version:') ? '  playwright_version: 1.62' : l))
    assert.equal(loadCuriaConfig(writeConfig(lines)).sandbox.playwright_version, '1.62')
  })

  test('agent_uid defaults to the uid the daemon runs as', () => {
    const lines = FULL.filter((l) => !l.trim().startsWith('agent_uid:'))
    assert.equal(loadCuriaConfig(writeConfig(lines)).sandbox.agent_uid, process.getuid())
  })

  test('a tag written into sandbox.image is refused — the tag is derived', () => {
    const lines = [...FULL, '  image: curia-agent:latest']
    assert.throws(() => loadCuriaConfig(writeConfig(lines)), /sandbox\.image/)
  })
})

describe('the shipped config (#154)', () => {
  test('config/curia.yaml pins the image, and its pins build the shipped ref', () => {
    const file = path.resolve(import.meta.dirname, '..', '..', 'config', 'curia.yaml')
    // #268 vendored the skill tree into the repo, so the shipped config loads
    // on any box without a HOME the test owns: `skills.root` names `../skills`
    // and the tree is right there. The seeded home stays because #212's point
    // was that this test is about the IMAGE PINS — it must not fail over a
    // skill — and nothing else in the document reads the home directory.
    const installs = parse(fs.readFileSync(file, 'utf8')).skills?.install
    const cfg = withSeededHome(() => loadCuriaConfig(file), installs)
    assert.ok(cfg.sandbox, 'the shipped config has no sandbox section')
    const ref = agentImageRef(cfg.sandbox)
    assert.match(ref.ref, /^curia-agent:\d[\w.]*-\d[\w.]*-[0-9a-f]{8}$/)
  })

  // #268: the tree is vendored, so a missing skill is a missing DIRECTORY in
  // this repo rather than a missing install on the operator's box. The daemon
  // refuses to boot on one, which costs a deploy; this catches it at review.
  // No seeded home: reading the real tree is the whole point of the test.
  test('every skill the shipped config installs is vendored in the repo', () => {
    const file = path.resolve(import.meta.dirname, '..', '..', 'config', 'curia.yaml')
    const cfg = loadCuriaConfig(file)
    assert.equal(cfg.skills.root, path.resolve(import.meta.dirname, '..', '..', 'skills'))
    assert.ok(cfg.skills.install.length, 'the shipped config installs no skills')
    for (const name of cfg.skills.install) {
      assert.ok(
        fs.existsSync(path.join(cfg.skills.root, name, 'SKILL.md')),
        `skills.install names "${name}", but skills/${name}/SKILL.md is not vendored`,
      )
    }
  })

  // The tree carries more than the install list on purpose: a hand session
  // reads the same copy (#268). What must NOT drift is the release it came
  // from, because the bump procedure keys off that stamp.
  test('the vendored tree stamps the upstream release it came from', () => {
    const upstream = path.resolve(import.meta.dirname, '..', '..', 'skills', 'UPSTREAM.md')
    const text = fs.readFileSync(upstream, 'utf8')
    assert.match(text, /`v\d+\.\d+\.\d+`/, 'UPSTREAM.md names no upstream release')
    assert.match(text, /`[0-9a-f]{40}`/, 'UPSTREAM.md names no upstream commit')
  })
})

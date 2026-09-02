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
  BUILD_CONTEXT, DEFAULT_IMAGE, DOCKERFILE, PIN_CONTAINER, SANDBOX_KEYS,
  buildArgs, imageDigest, agentImageRef, ensureAgentImage,
} from '../src/image.mjs'
import { HARNESS_REGISTRY } from '../src/harnesses.mjs'
import { PRODUCTION_HARNESSES, PRODUCTION_HARNESS_NAMES } from '../src/productionharnesses.mjs'
import { withSeededHome } from './fixtures/skills.mjs'

const PINS = {
  image: 'curia-agent',
  node_version: '24.19.0',
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

  test('the legible half names the two primary harness versions', () => {
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
      NODE_VERSION: '24.19.0',
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

// The Harness set the image carries (#696). Routing can pick any of them,
// so a container missing one turns a routing decision into a dead pane. The
// build itself proves the install - the `--version` loop in the Dockerfile is
// what fails a bad build - and these checks prove the Dockerfile still asks
// for that proof, for every harness, at the pinned version.
const HARNESSES = Object.entries(PRODUCTION_HARNESSES).map(([cli, contract]) => ({
  cli, pkg: contract.package, arg: contract.buildArg,
}))

describe('the harnesses in the image (#696)', () => {
  test('every harness installs from npm at the version its ARG pins', () => {
    const text = instructions()
    for (const { pkg, arg } of HARNESSES) {
      assert.ok(
        text.includes(`"${pkg}@\${${arg}}"`),
        `the Dockerfile does not install ${pkg} at \${${arg}}`,
      )
    }
  })

  test('no harness installs unpinned — a floating spec is the failure the pins prevent', () => {
    const text = instructions()
    for (const { pkg } of HARNESSES) {
      for (const bad of [`"${pkg}"`, `${pkg}@latest`, `${pkg}@next`]) {
        assert.ok(!text.includes(bad), `the Dockerfile installs ${bad}`)
      }
    }
  })

  test('the build verifies every harness against its pin', () => {
    const text = instructions()
    for (const { cli, arg } of HARNESSES) {
      assert.ok(
        text.includes(`"${cli} \${${arg}}"`),
        `the build never checks that \`${cli}\` reports \${${arg}}`,
      )
    }
    assert.match(text, /--version/, 'the build asks no harness for its version')
  })

  test('the version check runs as the worker user, under its own home', () => {
    assert.match(instructions(), /su agent -s \/bin\/bash -c "\$cli --version"/)
  })

  test('a harness the router can pick is a harness the pins name', () => {
    assert.deepEqual(HARNESS_REGISTRY.names, PRODUCTION_HARNESS_NAMES)
    for (const { cli } of HARNESSES) {
      const key = `${cli}_version`
      assert.ok(PINS[key], `no sandbox pin names ${cli}`)
      assert.ok(SANDBOX_KEYS[key], `${key} is not a build arg`)
    }
  })
})

// A fake docker: one box's images and one pin container, driven through the
// same `exec` seam the daemon uses. It answers the four verbs this path runs
// and records every argv, because the ORDER matters as much as the calls — the
// pin has to move off a superseded tag before the rmi of that tag can work.
function fakeDocker({ images = [], pin = null, refuse = [] } = {}) {
  const calls = []
  const box = { images: [...images], pin, calls }
  const fail = (stderr) => { const e = new Error(stderr); e.stderr = stderr; throw e }
  box.exec = async (bin, argv) => {
    calls.push(argv.join(' '))
    const [cmd, ...rest] = argv
    if (cmd === 'image' && rest[0] === 'inspect') {
      if (!box.images.includes(rest[1])) fail(`Error: No such image: ${rest[1]}`)
      return { stdout: '[]', stderr: '' }
    }
    if (cmd === 'inspect') {
      if (box.pin === null) fail(`Error: No such object: ${rest[0]}`)
      return { stdout: `${box.pin}\n`, stderr: '' }
    }
    if (cmd === 'rm') { box.pin = null; return { stdout: '', stderr: '' } }
    if (cmd === 'create') {
      if (box.pin !== null) fail(`docker: Error response from daemon: Conflict. The container name "/${rest[1]}" is already in use.`)
      box.pin = rest[2]
      return { stdout: 'deadbeef\n', stderr: '' }
    }
    if (cmd === 'images') {
      const repo = rest[0]
      return { stdout: `${box.images.filter((i) => i.startsWith(`${repo}:`)).join('\n')}\n`, stderr: '' }
    }
    if (cmd === 'rmi') {
      if (refuse.includes(rest[0])) fail(`Error response from daemon: conflict: unable to remove repository reference "${rest[0]}"`)
      box.images = box.images.filter((i) => i !== rest[0])
      return { stdout: '', stderr: '' }
    }
    throw new Error(`the fake docker was asked for \`${argv.join(' ')}\``)
  }
  // The build seam: a build puts the tag on the box and nothing else.
  box.build = async (ref) => { box.images.push(ref.ref); return ref }
  return box
}

const LIVE = agentImageRef(PINS).ref
const OLD = 'curia-agent:2.1.219-0.146.0-aaaaaaaa'

describe('the image pin (#337, built by #350)', () => {
  test('a dispatch that builds nothing still pins the live image', async () => {
    const box = fakeDocker({ images: [LIVE] })
    const out = await ensureAgentImage(PINS, box)
    assert.equal(out.built, false)
    assert.equal(out.pin.created, true)
    assert.equal(box.pin, LIVE)
    assert.ok(box.calls.includes(`create --name ${PIN_CONTAINER} ${LIVE}`))
  })

  test('a pin already on the live image is left where it is', async () => {
    const box = fakeDocker({ images: [LIVE], pin: LIVE })
    const out = await ensureAgentImage(PINS, box)
    assert.equal(out.pin.created, false)
    assert.ok(!box.calls.some((c) => c.startsWith('create ')), 'it created a second pin')
    assert.ok(!box.calls.some((c) => c.startsWith('rm ')), 'it removed the pin it should have kept')
  })

  test('a pin someone removed heals on the next dispatch, with no rebuild', async () => {
    const box = fakeDocker({ images: [LIVE], pin: null })
    const out = await ensureAgentImage(PINS, box)
    assert.equal(out.built, false)
    assert.equal(box.pin, LIVE)
  })

  // `npm run build-agent-image` ahead of a bump is how the dispatch path is
  // kept warm, and it leaves the dispatch nothing to build. The old tag is
  // still dead, so the moving pin is what says "sweep", not the build.
  test('a tag built by hand before the dispatch still prunes the tag it supersedes', async () => {
    const box = fakeDocker({ images: [OLD, LIVE], pin: OLD })
    const out = await ensureAgentImage(PINS, box)
    assert.equal(out.built, false)
    assert.deepEqual(out.pruned, [OLD])
    assert.deepEqual(box.images, [LIVE])
  })

  test('a new tag moves the pin, then the superseded tags go', async () => {
    const box = fakeDocker({ images: [OLD], pin: OLD })
    const out = await ensureAgentImage(PINS, box)
    assert.equal(out.built, true)
    assert.equal(box.pin, LIVE)
    assert.deepEqual(out.pruned, [OLD])
    assert.deepEqual(box.images, [LIVE])
    // The pin has to leave the old tag before that tag can be removed.
    assert.ok(box.calls.indexOf(`create --name ${PIN_CONTAINER} ${LIVE}`) < box.calls.indexOf(`rmi ${OLD}`))
  })

  test('every other tag of the repo goes, and no tag of another repo', async () => {
    const other = 'curia-agent:2.1.218-0.145.0-bbbbbbbb'
    const foreign = 'coolify/somethingelse:latest'
    const box = fakeDocker({ images: [OLD, other, foreign] })
    const out = await ensureAgentImage(PINS, box)
    assert.deepEqual(out.pruned.sort(), [other, OLD].sort())
    assert.deepEqual(box.images, [foreign, LIVE])
  })

  test('a tag a running agent still holds refuses safely, and the rest still go', async () => {
    const other = 'curia-agent:2.1.218-0.145.0-bbbbbbbb'
    const box = fakeDocker({ images: [OLD, other], refuse: [OLD] })
    const out = await ensureAgentImage(PINS, box)
    assert.deepEqual(out.pruned, [other])
    assert.ok(box.images.includes(OLD), 'the refused tag was counted as removed')
  })

  test('an untagged image is never handed to rmi', async () => {
    const box = fakeDocker({ images: [OLD, 'curia-agent:<none>'] })
    await ensureAgentImage(PINS, box)
    assert.ok(!box.calls.some((c) => c.includes('<none>')), 'it tried to remove a `<none>` tag by name')
  })

  test('a dispatch that builds nothing prunes nothing — the box has not changed', async () => {
    const box = fakeDocker({ images: [LIVE, OLD], pin: LIVE })
    const out = await ensureAgentImage(PINS, box)
    assert.deepEqual(out.pruned, [])
    assert.ok(!box.calls.some((c) => c.startsWith('images ')), 'it swept the tags with nothing built')
  })

  test('a pin curia cannot make is reported, not thrown — the agent has its image', async () => {
    const box = fakeDocker({ images: [LIVE] })
    const exec = box.exec
    box.exec = async (bin, argv) => {
      if (argv[0] === 'create') { const e = new Error('permission denied'); e.stderr = 'permission denied'; throw e }
      return exec(bin, argv)
    }
    const out = await ensureAgentImage(PINS, box)
    assert.equal(out.built, false)
    assert.equal(out.pin.created, false)
    assert.match(out.pin.error, /permission denied/)
  })

  test('two dispatches racing for the pin: the loser takes the winner\'s pin', async () => {
    const box = fakeDocker({ images: [LIVE] })
    const [a, b] = await Promise.all([ensureAgentImage(PINS, box), ensureAgentImage(PINS, box)])
    assert.equal(box.pin, LIVE)
    for (const out of [a, b]) assert.equal(out.pin.error, undefined)
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
      '  claim_login: alp82',
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
    '  node_version: 24.19.0',
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
    assert.equal(cfg.sandbox.codex_version, '0.146.0')
    assert.equal(cfg.sandbox.agent_uid, 1000)
  })

  test('a missing pin is refused, naming the key', () => {
    for (const key of ['node_version', 'claude_version', 'codex_version', 'gh_version', 'playwright_version', 'ttyd_version']) {
      const lines = FULL.filter((l) => !l.trim().startsWith(`${key}:`))
      assert.throws(() => loadCuriaConfig(writeConfig(lines)), new RegExp(`sandbox\\.${key}`))
    }
  })

  test('a version pin for an unselectable Harness is refused', () => {
    const lines = [...FULL, '  retired_version: 1.0.0']
    assert.throws(
      () => loadCuriaConfig(writeConfig(lines)),
      /sandbox\.retired_version does not name a selectable Harness/,
    )
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

describe('the current product Harness surface (#835)', () => {
  test('the landing page represents exactly the production Harnesses', () => {
    const file = path.resolve(import.meta.dirname, '..', '..', 'docs', 'index.html')
    const html = fs.readFileSync(file, 'utf8')
    const represented = [...new Set(
      [...html.matchAll(/data-h="([^"]+)"/g)].map((match) => match[1]),
    )].sort()
    assert.deepEqual(represented, [...PRODUCTION_HARNESS_NAMES].sort())
    assert.match(html, /Claude Code and Codex are supported/)
  })

  test('the positioning source names only the production Harnesses as supported', () => {
    const file = path.resolve(import.meta.dirname, '..', '..', 'docs', 'landing-page', 'positioning.md')
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /Scene 7 names Claude Code and Codex as supported/)
    assert.doesNotMatch(text, /\b(?:OpenCode|Opencode|Pi)\b/)
  })
})

// The Node pin (#357, applied by #409). One patch version runs every curia
// image, and the rule that makes that hold is negative: NO Dockerfile carries a
// default, so a build that forgets the arg fails instead of picking a Node. A
// default put back here would restore the old failure silently — the agent
// image floated on `node:lts-slim` and served Node 24.19.0 while the daemon ran
// 22.17.1, and the daemon suite runs in the agent image. So the suite that must
// prove a Node upgrade ran on a Node nobody pinned.
//
// The value itself is checked in one direction only: the two committed places
// must agree. Which version they name is the operator's call, and the upgrade
// recipe in the daemon README is what moves it.
describe('the Node pin (#357, applied by #409)', () => {
  const REPO = path.resolve(import.meta.dirname, '..', '..')
  const compose = parse(fs.readFileSync(path.join(REPO, 'deploy', 'compose.yaml'), 'utf8'))
  const dockerfile = (name) => fs.readFileSync(path.join(REPO, 'deploy', name, 'Dockerfile'), 'utf8')
  const BUILT = { daemon: 'daemon', dashboard: 'dashboard', overseer: 'overseer' }

  test('the three composed images take one Node version, from one anchor', () => {
    const passed = Object.keys(BUILT).map((svc) => compose.services[svc].build.args.NODE_VERSION)
    assert.equal(new Set(passed).size, 1, `the composed images name ${passed.length} Node versions: ${passed.join(', ')}`)
    assert.match(passed[0], /^\d+\.\d+\.\d+$/, `the anchor is not a patch version: ${passed[0]}`)
  })

  test('the agent image takes the same version, through sandbox.node_version', () => {
    const cfg = loadCuriaConfig(path.join(REPO, 'config', 'curia.yaml'))
    assert.equal(cfg.sandbox.node_version, compose.services.daemon.build.args.NODE_VERSION)
  })

  test('no Dockerfile defaults NODE_VERSION — a build that forgets the arg has to fail', () => {
    for (const name of [...Object.values(BUILT), 'agent']) {
      const text = dockerfile(name)
      assert.match(text, /^ARG NODE_VERSION$/m, `${name} declares no bare ARG NODE_VERSION`)
      assert.doesNotMatch(text, /^ARG NODE_VERSION=/m, `${name} defaults NODE_VERSION`)
    }
  })

  test('every image builds on the pinned Node and a named distro, never a floating tag', () => {
    for (const name of [...Object.values(BUILT), 'agent']) {
      assert.match(
        dockerfile(name),
        /^FROM node:\$\{NODE_VERSION\}-bookworm-slim( AS \w+)?$/m,
        `${name} does not build on the pinned node base image`,
      )
    }
  })
})

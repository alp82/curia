// Config validation is a trust boundary: both YAML files are hand-edited, and
// the daemon must refuse to boot rather than limp. These tests cover the
// worker skill set (#57) — the one section whose validation reaches the
// filesystem, because a named-but-absent skill is the failure it exists to end.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadCuriaConfig, loadRoutingConfig } from '../src/config.mjs'
import { DEFAULT_SKILLS, defaultSkillsRoot } from '../src/workspace.mjs'
 import { DEFAULT_INDEX } from '../src/attach.mjs'
import { DEFAULT_TIMELINE_INDEX } from '../src/timeline.mjs'

let tmp
let root

// Base config with every other section valid, so a failure names the skills.
function writeConfig(skillsYaml, attachExtra = '') {
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
    '  confirm_ttl_h: 4',
    'attach:',
    '  ttyd_port: 7681',
    '  serve_port: 8443',
    attachExtra,
    'identity:',
    '  allow: [tester@example.com]',
    skillsYaml ?? '',
    '',
  ].join('\n'))
  return file
}

describe('skills config (#57)', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-'))
    root = path.join(tmp, 'host-skills')
    for (const name of ['wayfinder', 'tdd']) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
      fs.writeFileSync(path.join(root, name, 'SKILL.md'), `# ${name}\n`)
    }
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('a configured root and list are normalised onto cfg.skills', () => {
    const cfg = loadCuriaConfig(writeConfig(`skills:\n  root: ${root}\n  install: [wayfinder, tdd]`))
    assert.deepEqual(cfg.skills, { root, install: ['wayfinder', 'tdd'] })
  })

  test('a named skill that is not installed refuses the boot, naming the path', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(`skills:\n  root: ${root}\n  install: [wayfinder, nope]`)),
      /skills.install names "nope".*SKILL\.md does not exist/s,
      'dispatching a worker that silently lacks a skill is the failure being prevented',
    )
  })

  test('a name that is not a plain directory name is refused', () => {
    for (const bad of ['..', '../../etc', 'a/b', '']) {
      assert.throws(
        () => loadCuriaConfig(writeConfig(`skills:\n  root: ${root}\n  install: [${JSON.stringify(bad)}]`)),
        /is not a plain skill name/,
        `${JSON.stringify(bad)} must not reach the symlink`,
      )
    }
  })

  test('an explicitly empty list is the opt-out, and needs no root on disk', () => {
    const cfg = loadCuriaConfig(writeConfig(`skills:\n  root: /nowhere/at/all\n  install: []`))
    assert.deepEqual(cfg.skills.install, [])
  })

  test('an omitted section takes the full default list, not silence', () => {
    // Validated against the real host root, so this asserts the DEFAULT
    // behaviour is loud — either it loads the nine, or it names the one
    // missing skill. What it must never do is quietly install nothing.
    let cfg = null
    try {
      cfg = loadCuriaConfig(writeConfig(null))
    } catch (e) {
      assert.match(e.message, /skills\.install names/)
      return
    }
    assert.deepEqual(cfg.skills.install, DEFAULT_SKILLS)
    assert.equal(cfg.skills.root, defaultSkillsRoot())
  })

  test('a leading ~ in the root is expanded, since YAML does not', () => {
    // Empty install, so this asserts the expansion alone and needs nothing on
    // disk. `~/.claude/skills` is how a human writes this path.
    // quoted, because a bare `~` is YAML's null and takes the default instead
    assert.equal(loadCuriaConfig(writeConfig('skills:\n  root: "~"\n  install: []')).skills.root, os.homedir())
    assert.equal(
      loadCuriaConfig(writeConfig('skills:\n  root: ~/.claude/skills\n  install: []')).skills.root,
      path.join(os.homedir(), '.claude', 'skills'),
    )
  })

  test('a relative root is refused outright', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig('skills:\n  root: ./skills\n  install: []')),
      /skills\.root must be an absolute path/,
    )
  })
})

describe('the Stop-hook nudge budget (#54 item 4)', () => {
  // Its own fixture: the skills describe above tears its tmp dir down.
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-budget-'))
    root = path.join(tmp, 'host-skills')
    fs.mkdirSync(root, { recursive: true })
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('an omitted budget takes the default, so a config predating the ending still boots', () => {
    const cfg = loadCuriaConfig(writeConfig(`skills:\n  root: ${root}\n  install: []`))
    assert.equal(cfg.dispatch.stop_nudge_budget, 3)
  })

  test('a budget of zero is refused — turning the enforcement off is not a number', () => {
    const file = writeConfig(`skills:\n  root: ${root}\n  install: []`)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  confirm_ttl_h: 4', '  confirm_ttl_h: 4\n  stop_nudge_budget: 0'))
    assert.throws(() => loadCuriaConfig(file), /stop_nudge_budget must be a positive number/)
  })

  test('a stated budget is taken as given', () => {
    const file = writeConfig(`skills:\n  root: ${root}\n  install: []`)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  confirm_ttl_h: 4', '  confirm_ttl_h: 4\n  stop_nudge_budget: 5'))
    assert.equal(loadCuriaConfig(file).dispatch.stop_nudge_budget, 5)
  })
})

// ---- two backends (#39) ------------------------------------------------------

describe('routing config with a second backend (#39)', () => {
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-routing-cfg-')) })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const BASE = [
    'defaults:',
    '  untyped: opus',
    '  research: gpt',
    'models:',
    '  opus: { provider: anthropic, backend: claude }',
    '  gpt: { provider: openai, backend: codex, id: gpt-5.5 }',
    'backends:',
    "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', ready: 'bypass permissions' }",
    "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', ready: '\u00b7\\s[~/]' }",
  ]

  function load(lines) {
    const file = path.join(dir, 'routing.yaml')
    fs.writeFileSync(file, lines.join('\n'))
    return loadRoutingConfig(file)
  }

  test('the two-lane config loads and compiles each backend readiness marker', () => {
    const cfg = load(BASE)
    assert.equal(cfg.models.gpt.id, 'gpt-5.5')
    assert.equal(cfg.backends.codex.readyRe.test('  gpt-5.5 low · ~/curia-work/wt/39'), true)
    assert.equal(cfg.backends.claude.readyRe.test('  gpt-5.5 low · ~/curia-work/wt/39'), false)
  })

  // #33 lost readiness live to a marker that matched nothing, and the whole
  // symptom was silence — so an absent one refuses the boot (#57's precedent).
  test('a backend with no readiness marker refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  codex:')
      ? "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"' }"
      : l))
    assert.throws(() => load(lines), /backends\.codex needs a `ready` regex/)
  })

  test('a readiness marker that is not a regex refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  codex:')
      ? "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', ready: '[unclosed' }"
      : l))
    assert.throws(() => load(lines), /is not a valid regex/)
  })

  // A backend with no harness would get no config dir, no curia tools and no
  // Stop hook — a worker that cannot be driven or ended.
  test('a backend with no harness in workspace.mjs refuses the boot', () => {
    const lines = [...BASE.slice(0, -2),
      "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', ready: 'x' }",
      "  cursor: { template: 'cursor --model {model} \"$(cat {prompt_file})\"', ready: 'x' }",
      '  codex: { template: \'codex --model {model} "$(cat {prompt_file})"\', ready: \'x\' }',
    ]
    assert.throws(() => load(lines), /backends\.cursor has no harness/)
  })

  // A provider with no usage-limit vocabulary spawns workers whose cap hits are
  // invisible: nothing cools, and every dispatch burns a claim into a timeout.
  test('a provider with no usage-limit vocabulary refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  gpt:')
      ? '  gpt: { provider: mistral, backend: codex, id: gpt-5.5 }'
      : l))
    assert.throws(() => load(lines), /has no usage-limit vocabulary/)
  })

  // The id is substituted into a shell template, so it fails at BOOT naming the
  // key rather than at dispatch with a claim already taken.
  test('a model id that is not quote-free refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  gpt:')
      ? '  gpt: { provider: openai, backend: codex, id: \'gpt"; rm -rf /\' }'
      : l))
    assert.throws(() => load(lines), /models\.gpt\.id must be a quote-free model name/)
  })
})

describe('reasoning effort is stated, not inherited (#39)', () => {
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-effort-')) })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const lines = (effort) => [
    'defaults:',
    '  untyped: gpt',
    'models:',
    `  gpt: { provider: openai, backend: codex, id: gpt-5.6-sol${effort === null ? '' : `, reasoning_effort: ${effort}`} }`,
    'backends:',
    "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', ready: 'x' }",
  ]

  function load(effort) {
    const file = path.join(dir, 'routing.yaml')
    fs.writeFileSync(file, lines(effort).join('\n'))
    return loadRoutingConfig(file)
  }

  test('a stated effort is taken as given', () => {
    assert.equal(load('high').models.gpt.reasoning_effort, 'high')
  })

  test('an omitted effort leaves the model to its own default', () => {
    assert.equal(load(null).models.gpt.reasoning_effort, undefined)
  })

  // Checked against the union across models: gpt-5.6 accepts `max` and `ultra`
  // and gpt-5.5 accepts neither, so a per-model list here would go stale and
  // start refusing valid configs. This catches the typo.
  test('the efforts only gpt-5.6 accepts still load', () => {
    for (const e of ['max', 'ultra']) assert.equal(load(e).models.gpt.reasoning_effort, e)
  })

  test('a misspelled effort refuses the boot', () => {
    assert.throws(() => load('extreme'), /reasoning_effort must be one of/)
  })
})

// #70. The attach page is an owned, built asset; the config states where it
// is. The one thing this must never do is resolve to a file that is not there
// — a ttyd spawned with a `-I` pointing at nothing serves no attach surface at
// all, and the operator finds out from a browser rather than from the boot.
describe('attach.index config (#70)', () => {
  let dir
  let asset

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-attach-cfg-'))
    tmp = dir // writeConfig writes into `tmp`; the describes above tear theirs down
    asset = path.join(dir, 'assets', 'attach-index.html')
    fs.mkdirSync(path.dirname(asset), { recursive: true })
    fs.writeFileSync(asset, '<!DOCTYPE html><html><head></head><body></body></html>')
  })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('omitted, it takes the shipped asset — the only value anyone wants', () => {
    assert.equal(loadCuriaConfig(writeConfig()).attach.index, DEFAULT_INDEX)
    assert.ok(fs.existsSync(DEFAULT_INDEX), 'and the shipped asset is committed, not built on demand')
  })

  test('a relative path resolves against the config file, not the cwd', () => {
    // The daemon may be started from any cwd, and the shipped config names the
    // asset portably rather than carrying one box\'s absolute path.
    const rel = path.relative(tmp, asset)
    assert.equal(loadCuriaConfig(writeConfig(null, `  index: ${rel}`)).attach.index, asset)
  })

  test('an absolute path is taken as given', () => {
    assert.equal(loadCuriaConfig(writeConfig(null, `  index: ${asset}`)).attach.index, asset)
  })

  test('a path that is not there refuses the boot, naming the path and the build command', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(null, '  index: ./no-such-index.html')),
      /attach\.index resolves to .*no-such-index\.html, which does not exist.*build-attach-index/s,
    )
  })

  test('a non-string refuses the boot', () => {
    assert.throws(() => loadCuriaConfig(writeConfig(null, '  index: 7')), /attach\.index must be a path/)
  })
})

describe('timeline config (#74)', () => {
  let dir

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-timeline-cfg-'))
    tmp = dir
  })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('omitted, it takes the shipped defaults — port 4272, serve 8444, the committed page', () => {
    const cfg = loadCuriaConfig(writeConfig())
    assert.equal(cfg.timeline.port, 4272)
    assert.equal(cfg.timeline.serve_port, 8444)
    assert.equal(cfg.timeline.index, DEFAULT_TIMELINE_INDEX)
    assert.ok(fs.existsSync(DEFAULT_TIMELINE_INDEX), 'and the shipped page is committed')
  })

  test('a page that is not there refuses the boot naming the path', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(['timeline:', '  index: ./no-such-page.html'].join('\n'))),
      /timeline\.index resolves to .*no-such-page\.html, which does not exist/,
    )
  })

  test('a port collision with attach refuses the boot — one surface must not shadow another', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(['timeline:', '  serve_port: 8443'].join('\n'))),
      /attach\.serve_port and timeline\.serve_port are both 8443/,
    )
  })

  test('a preview range containing a timeline port refuses the boot — the sweep would withdraw it', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(['preview:', '  port_from: 8444', '  port_to: 8460'].join('\n'))),
      /preview range 8444-8460 contains timeline\.serve_port \(8444\)/,
    )
  })
})

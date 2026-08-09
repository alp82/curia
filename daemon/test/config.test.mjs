// Config validation is a trust boundary: both YAML files are hand-edited, and
// the daemon must refuse to boot rather than limp. These tests cover the
// agent skill set (#57) — the one section whose validation reaches the
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
import { seedSkillsRoot, skillsYaml, withSeededHome } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'

let tmp
let root

// The one caller that needs a config with NO skills section at all: the test
// that pins what the DEFAULT root is. Everyone else gets the fixture root.
const OMIT_SKILLS = Symbol('omit the skills section')

// The skills root the fixtures own (#212). Seeded per `tmp`, because each
// describe below makes its own temp dir and tears it down again.
const seeded = new Map()
function fixtureSkills() {
  if (!seeded.has(tmp)) seeded.set(tmp, seedSkillsRoot(tmp))
  return skillsYaml(seeded.get(tmp)).join('\n')
}

// Base config with every other section valid, so a failure names the skills.
function writeConfig(extraYaml, attachExtra = '') {
  const extra = extraYaml === OMIT_SKILLS ? '' : (extraYaml ?? '')
  // A config that names no skills root reads the HOST's home directory, and
  // the answer differs on the operator's box, in an agent container, and on a
  // stranger's. So every fixture here names a root the test owns — but never
  // over one the caller wrote, which is what the skills describe pins.
  const skills = extraYaml === OMIT_SKILLS || /^skills:/m.test(extra) ? '' : fixtureSkills()
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
    extra,
    skills,
    // #195: `sandbox:` is required, so every base fixture carries it — unless
    // the caller states its own, which is what the sandbox cases below do.
    ...(/^sandbox:/m.test(extra) ? [] : sandboxYaml()),
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
      'dispatching an agent that silently lacks a skill is the failure being prevented',
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
    // Validated against a HOME the test owns, seeded at the path
    // `defaultSkillsRoot()` names, so the DEFAULT is pinned on every box — the
    // operator's, an agent container, a stranger's (#212). Before that this
    // test had to tolerate its own failure, because the host might not carry
    // the nine, and a tolerant test proves nothing.
    withSeededHome(() => {
      const cfg = loadCuriaConfig(writeConfig(OMIT_SKILLS))
      assert.deepEqual(cfg.skills.install, DEFAULT_SKILLS)
      assert.equal(cfg.skills.root, defaultSkillsRoot())
    })
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

// ---- two harnesses (#39) ------------------------------------------------------

describe('routing config with a second harness (#39)', () => {
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-routing-cfg-')) })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const BASE = [
    'defaults:',
    '  untyped: opus',
    '  research: gpt',
    'models:',
    '  opus: { provider: anthropic, harness: claude }',
    '  gpt: { provider: openai, harness: codex, id: gpt-5.5 }',
    'harnesses:',
    "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', ready: 'bypass permissions', tool_channel_grace_s: 15 }",
    "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', ready: '\u00b7\\s[~/]', tool_channel_grace_s: 15 }",
  ]

  function load(lines) {
    const file = path.join(dir, 'routing.yaml')
    fs.writeFileSync(file, lines.join('\n'))
    return loadRoutingConfig(file)
  }

  test('the two-harness config loads and compiles each harness readiness marker', () => {
    const cfg = load(BASE)
    assert.equal(cfg.models.gpt.id, 'gpt-5.5')
    assert.equal(cfg.harnesses.codex.readyRe.test('  gpt-5.5 low · ~/curia-work/wt/39'), true)
    assert.equal(cfg.harnesses.claude.readyRe.test('  gpt-5.5 low · ~/curia-work/wt/39'), false)
  })

  // #33 lost readiness live to a marker that matched nothing, and the whole
  // symptom was silence — so an absent one refuses the boot (#57's precedent).
  test('a harness with no readiness marker refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  codex:')
      ? "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"' }"
      : l))
    assert.throws(() => load(lines), /harnesses\.codex needs a `ready` regex/)
  })

  test('a harness with no tool-channel window refuses the boot (#194)', () => {
    const lines = BASE.map((l) => (l.startsWith('  codex:')
      ? "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', ready: 'x' }"
      : l))
    assert.throws(() => load(lines), /harnesses\.codex needs a positive `tool_channel_grace_s`/)
  })

  test('a zero or negative tool-channel window refuses the boot — it would call every agent mute', () => {
    for (const bad of ['0', '-5']) {
      const lines = BASE.map((l) => (l.startsWith('  codex:')
        ? `  codex: { template: 'codex --model {model} "$(cat {prompt_file})"', ready: 'x', tool_channel_grace_s: ${bad} }`
        : l))
      assert.throws(() => load(lines), /tool_channel_grace_s/)
    }
  })

  test('the window compiles onto the harness the dispatcher reads', () => {
    assert.equal(load(BASE).harnesses.claude.toolChannelGraceS, 15)
  })

  test('a readiness marker that is not a regex refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  codex:')
      ? "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', ready: '[unclosed', tool_channel_grace_s: 15 }"
      : l))
    assert.throws(() => load(lines), /is not a valid regex/)
  })

  // A harness with no entry in the HARNESS table would get no config dir, no curia tools and no
  // Stop hook — an agent that cannot be driven or ended.
  test('a harness with no entry in the HARNESS table refuses the boot', () => {
    const lines = [...BASE.slice(0, -2),
      "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', ready: 'x', tool_channel_grace_s: 15 }",
      "  cursor: { template: 'cursor --model {model} \"$(cat {prompt_file})\"', ready: 'x', tool_channel_grace_s: 15 }",
      '  codex: { template: \'codex --model {model} "$(cat {prompt_file})"\', ready: \'x\', tool_channel_grace_s: 15 }',
    ]
    assert.throws(() => load(lines), /harnesses\.cursor has no entry in the HARNESS table/)
  })

  // A provider with no usage-limit vocabulary spawns agents whose cap hits are
  // invisible: nothing cools, and every dispatch burns a claim into a timeout.
  test('a provider with no usage-limit vocabulary refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  gpt:')
      ? '  gpt: { provider: mistral, harness: codex, id: gpt-5.5 }'
      : l))
    assert.throws(() => load(lines), /has no usage-limit vocabulary/)
  })

  // The id is substituted into a shell template, so it fails at BOOT naming the
  // key rather than at dispatch with a claim already taken.
  test('a model id that is not quote-free refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  gpt:')
      ? '  gpt: { provider: openai, harness: codex, id: \'gpt"; rm -rf /\' }'
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
    `  gpt: { provider: openai, harness: codex, id: gpt-5.6-sol${effort === null ? '' : `, reasoning_effort: ${effort}`} }`,
    'harnesses:',
    "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', ready: 'x', tool_channel_grace_s: 15 }",
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

  // #168: the derived proxy block gets the same treatment the preview range
  // does. A collision here is the QUIET kind — the daemon would boot, and the
  // fault would surface later as one preview refusing every caller because its
  // gate bound a port another surface already held.
  // `writeConfig` puts its argument straight after `identity: allow:`, at the
  // same indent, so a bare `  preview_proxy_from:` line lands inside that block.
  test('the derived proxy block is as wide as the preview range and pairs with it', () => {
    const cfg = loadCuriaConfig(writeConfig(['preview:', '  port_from: 8500', '  port_to: 8509'].join('\n')))
    assert.deepEqual(cfg.identity.preview_proxy_block, { from: 7700, to: 7709 })
  })

  test('a proxy block swallowing ttyd refuses the boot', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig('  preview_proxy_from: 7680')),
      /identity-proxy block 7680-7779 contains attach\.ttyd_port \(7681\)/,
    )
  })

  test('a proxy block overlapping the preview range refuses the boot', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig('  preview_proxy_from: 8550')),
      /identity-proxy block 8550-8649 overlaps the preview range 8500-8599/,
    )
  })

  test('a proxy block overlapping the sandbox range refuses the boot', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig([
        '  preview_proxy_from: 9100',
        'sandbox:',
        '  image: curia-agent',
        '  claude_version: 2.1.220',
        '  codex_version: 0.146.0',
        '  gh_version: 2.97.0',
        '  playwright_version: 1.62.1',
        '  ttyd_version: 1.7.7',
        '  agent_uid: 1000',
        '  port_from: 9000',
        '  port_to: 9299',
      ].join('\n'))),
      /sandbox port range 9000-9299 overlaps the preview identity-proxy block 9100-9199/,
    )
  })

  test('a proxy block running past the last port refuses the boot', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig('  preview_proxy_from: 65500')),
      /runs past port 65535/,
    )
  })
})

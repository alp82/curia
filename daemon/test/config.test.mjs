// Config validation is a trust boundary: both YAML files are hand-edited, and
// the daemon must refuse to boot rather than limp. These tests cover the
// agent skill set (#57) — the one section whose validation reaches the
// filesystem, because a named-but-absent skill is the failure it exists to end.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadCuriaConfig, loadRoutingConfig, localConfigFile, overrideSummary } from '../src/config.mjs'
import { DEFAULT_SKILLS, defaultSkillsRoot } from '../src/workspace.mjs'
 import { DEFAULT_INDEX } from '../src/attach.mjs'
import { DEFAULT_TIMELINE_INDEX } from '../src/timeline.mjs'
import { seedSkillsRoot, skillsYaml, withSeededHome } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'
import { providerContractFault, consumerContractFault, CONSUMER_NAMES } from '../src/credentials.mjs'
import { harnessProvider } from '../src/workspace.mjs'
import { parse } from 'yaml'
import { DEFAULT_CLI_VERSION, DEFAULT_INTERVAL_HOURS } from '../src/aistack.mjs'

const DIRNAME = path.dirname(fileURLToPath(import.meta.url))

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
// `claimLogin` (#390) takes a raw yaml value, or null to leave the key out
// entirely — the two shapes the claim-login cases below drive.
function writeConfig(extraYaml, attachExtra = '', claimLogin = 'alp82') {
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
    ...(claimLogin === null ? [] : [`  claim_login: ${claimLogin}`]),
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

  // #268: curia vendors the skill tree into the repo, beside this config, so a
  // relative root had to stop being a refusal. It resolves off the config
  // FILE's directory rather than the process cwd — the rule attach.index and
  // timeline.index already follow — because the daemon's cwd differs between
  // the box, the container and the suite, and a cwd-relative root would name a
  // different tree in each.
  test('a relative root resolves off the config file, not the cwd', () => {
    // Empty install, so nothing has to exist on disk.
    assert.equal(
      loadCuriaConfig(writeConfig('skills:\n  root: ./skills\n  install: []')).skills.root,
      path.join(tmp, 'skills'),
    )
    assert.equal(
      loadCuriaConfig(writeConfig('skills:\n  root: ../skills\n  install: []')).skills.root,
      path.resolve(tmp, '..', 'skills'),
    )
  })

  test('an absolute root still wins over the config file directory', () => {
    const abs = path.join(tmp, 'elsewhere', 'skills')
    assert.equal(
      loadCuriaConfig(writeConfig(`skills:\n  root: ${abs}\n  install: []`)).skills.root,
      abs,
    )
  })

  test('a non-string root is refused', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig('skills:\n  root: 7\n  install: []')),
      /skills\.root must be a path/,
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

describe('the prototype variation default (#636)', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-prototype-'))
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('an omitted count defaults to five', () => {
    assert.equal(loadCuriaConfig(writeConfig()).dispatch.prototype_variations, 5)
  })

  test('the count must be a positive integer', () => {
    for (const value of ['0', '2.5', '.inf']) {
      const file = writeConfig()
      const text = fs.readFileSync(file, 'utf8').replace(
        '  auto_dispatch: false',
        `  auto_dispatch: false\n  prototype_variations: ${value}`,
      )
      fs.writeFileSync(file, text)
      assert.throws(() => loadCuriaConfig(file), /prototype_variations must be a positive integer/)
    }
  })
})

describe('the composite message limit', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-messages-'))
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('an omitted limit defaults to four', () => {
    assert.equal(loadCuriaConfig(writeConfig()).dispatch.messages_per_send, 4)
  })

  test('the limit accepts one through four messages', () => {
    for (const value of [1, 4]) {
      const file = writeConfig()
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
        .replace('  auto_dispatch: false', `  auto_dispatch: false\n  messages_per_send: ${value}`))
      assert.equal(loadCuriaConfig(file).dispatch.messages_per_send, value)
    }
  })

  test('the limit refuses zero, fractions, and values over four', () => {
    for (const value of ['0', '2.5', '5']) {
      const file = writeConfig()
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
        .replace('  auto_dispatch: false', `  auto_dispatch: false\n  messages_per_send: ${value}`))
      assert.throws(() => loadCuriaConfig(file), /messages_per_send must be an integer from 1 through 4/)
    }
  })
})

// ---- the workspace root is written down twice (#473) --------------------------
//
// `dispatch.workspace_root` says where the daemon writes its worktrees, and
// `CURIA_WORKSPACE_ROOT` in `deploy/.env` says which tree compose mounts.
// Compose hands the second value back to every container that reads this file,
// and a disagreement is the one mount error nothing else would notice: the
// worktrees land inside the container, the host tree stays empty, no error is
// raised, and a recreate throws the lot away.

describe('the mounted workspace root against the configured one (#473)', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-workspace-'))
    root = path.join(tmp, 'host-skills')
    fs.mkdirSync(root, { recursive: true })
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const noSkills = () => `skills:\n  root: ${root}\n  install: []`

  test('a compose mount that disagrees refuses the boot, and names both answers', () => {
    const file = writeConfig(noSkills())
    assert.throws(
      () => loadCuriaConfig(file, { env: { CURIA_WORKSPACE_ROOT: '/srv/somewhere-else' } }),
      /workspace_root is .*but compose mounts \/srv\/somewhere-else/s,
      'worktrees written where no mount covers are lost on the next recreate, in silence',
    )
  })

  test('the same answer twice boots, trailing slash and all', () => {
    const file = writeConfig(noSkills())
    const configured = path.join(tmp, 'work')
    for (const mounted of [configured, `${configured}/`]) {
      const cfg = loadCuriaConfig(file, { env: { CURIA_WORKSPACE_ROOT: mounted } })
      assert.equal(cfg.dispatch.workspace_root, configured)
    }
  })

  test('outside compose nothing states it, and there is no second answer to check', () => {
    const file = writeConfig(noSkills())
    assert.equal(loadCuriaConfig(file, { env: {} }).dispatch.workspace_root, path.join(tmp, 'work'))
  })
})

// ---- who a claim assigns (#390, ADR-0018) -------------------------------------

describe('dispatch.claim_login (#390)', () => {
  // Its own fixture: the describe above tears its tmp dir down.
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-claim-'))
    root = path.join(tmp, 'host-skills')
    fs.mkdirSync(root, { recursive: true })
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const skills = () => `skills:\n  root: ${root}\n  install: []`

  test('a stated login is taken as given', () => {
    assert.equal(loadCuriaConfig(writeConfig(skills())).dispatch.claim_login, 'alp82')
  })

  // REQUIRED, and with no default. The daemon calls GitHub as the bot now, and
  // GitHub does not let an App be an assignee — so every other source for this
  // name is a guess, and a guess claims tickets in a stranger's name.
  test('an omitted login refuses the boot', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(skills(), '', null)),
      /dispatch\.claim_login must be a GitHub login/,
    )
  })

  test('a login GitHub could not issue refuses the boot', () => {
    for (const bad of ['-alp82', 'alp82-', 'al p82', 'alp82/curia', '7']) {
      assert.throws(
        () => loadCuriaConfig(writeConfig(skills(), '', bad)),
        /dispatch\.claim_login must be a GitHub login/,
        `"${bad}" was accepted, and it would fail every claim with a 422`,
      )
    }
  })

  test('a hyphen inside a login is legal — GitHub issues those', () => {
    assert.equal(loadCuriaConfig(writeConfig(skills(), '', 'curia-sh')).dispatch.claim_login, 'curia-sh')
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
    "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'bypass permissions', tool_channel_grace_s: 15 }",
    "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: '\u00b7\\s[~/]', tool_channel_grace_s: 15 }",
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

  test('a harness with no resume command refuses the boot', () => {
    const lines = BASE.map((line) => line.startsWith('  codex:')
      ? line.replace(", resume_template: 'resume --model {model}'", '')
      : line)
    assert.throws(() => load(lines), /harnesses\.codex\.resume_template/)
  })

  // #33 lost readiness live to a marker that matched nothing, and the whole
  // symptom was silence — so an absent one refuses the boot (#57's precedent).
  test('a harness with no readiness marker refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  codex:')
      ? "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}' }"
      : l))
    assert.throws(() => load(lines), /harnesses\.codex needs a `ready` regex/)
  })

  test('a harness with no tool-channel window refuses the boot (#194)', () => {
    const lines = BASE.map((l) => (l.startsWith('  codex:')
      ? "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'x' }"
      : l))
    assert.throws(() => load(lines), /harnesses\.codex needs a positive `tool_channel_grace_s`/)
  })

  test('a zero or negative tool-channel window refuses the boot — it would call every agent mute', () => {
    for (const bad of ['0', '-5']) {
      const lines = BASE.map((l) => (l.startsWith('  codex:')
        ? `  codex: { template: 'codex --model {model} "$(cat {prompt_file})"', resume_template: 'resume --model {model}', ready: 'x', tool_channel_grace_s: ${bad} }`
        : l))
      assert.throws(() => load(lines), /tool_channel_grace_s/)
    }
  })

  test('the window compiles onto the harness the dispatcher reads', () => {
    assert.equal(load(BASE).harnesses.claude.toolChannelGraceS, 15)
  })

  test('a readiness marker that is not a regex refuses the boot', () => {
    const lines = BASE.map((l) => (l.startsWith('  codex:')
      ? "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: '[unclosed', tool_channel_grace_s: 15 }"
      : l))
    assert.throws(() => load(lines), /is not a valid regex/)
  })

  // A Harness with no registered adapter would get no complete lifecycle. It
  // is a code change, not a new routing row (ADR-0030).
  test('a Harness with no registered adapter refuses the boot', () => {
    const lines = [...BASE.slice(0, -2),
      "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'x', tool_channel_grace_s: 15 }",
      "  cursor: { template: 'cursor --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'x', tool_channel_grace_s: 15 }",
      '  codex: { template: \'codex --model {model} "$(cat {prompt_file})"\', resume_template: \'resume --model {model}\', ready: \'x\', tool_channel_grace_s: 15 }',
    ]
    assert.throws(() => load(lines), /harnesses\.cursor has no registered Harness adapter/)
  })

  test('a model provider must agree with its Harness adapter', () => {
    const lines = BASE.map((line) => line === '  opus: { provider: anthropic, harness: claude }'
      ? '  opus: { provider: openai, harness: claude }'
      : line)
    assert.throws(
      () => load(lines),
      /models\.opus\.provider names "openai", but the claude Harness adapter declares "anthropic"/,
    )
  })

  // The credential half of the same question (#648). This one CANNOT be provoked
  // from config — the provider comes off the HARNESS table in code — so what a
  // boot can assert is that every shipped harness passes it. The refusal's own
  // message is read in credentials.test.mjs, against a harness nobody has added.
  test('every configured harness runs on a provider that has a credential contract', () => {
    const cfg = load(BASE)
    for (const name of Object.keys(cfg.harnesses)) {
      assert.equal(providerContractFault(name, harnessProvider(name)), null, name)
    }
  })

  // The consumer table is code and not config, so nothing an operator writes can
  // break it — which is why the boot asserts it rather than trusting it. A
  // consumer that declares no delivery reaches no agent, and a dispatch would
  // otherwise discover that with a claim already taken.
  test('every model-credential consumer declares a delivery curia can perform', () => {
    load(BASE) // the same boot the refusal would have thrown from
    for (const consumer of CONSUMER_NAMES) {
      assert.equal(consumerContractFault(consumer), null, consumer)
    }
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
    "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'x', tool_channel_grace_s: 15 }",
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

  test('#714: attach.serve_port is optional now — it names only the retired rule to withdraw', () => {
    const file = writeConfig('')
    const text = fs.readFileSync(file, 'utf8').replace(/^  serve_port: 8443\n/m, '')
    fs.writeFileSync(file, text)
    assert.equal(loadCuriaConfig(file).attach.serve_port, 8443)
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
        '  node_version: 24.19.0',
        '  claude_version: 2.1.220',
        '  codex_version: 0.146.0',
        '  opencode_version: 1.18.23',
        '  pi_version: 0.84.3',
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

// The two layers (#292). Git tracks `curia.yaml` and `routing.yaml`, and the
// dashboard writes the settings the operator touches most — so a save used to
// leave the box's checkout dirty, and the next `git merge --ff-only` refused
// it. The tracked file is the base now, and this box's own answers live in an
// override beside it that git ignores.
describe('the tracked file and the override beside it (#292)', () => {
  // `writeConfig` builds its fixtures under the module-level `tmp`, which each
  // describe owns for the length of its own run.
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-layers-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  // The override for whatever config `writeConfig` just made, since its name is
  // random per call.
  const override = (file, ...lines) => {
    fs.writeFileSync(localConfigFile(file), `${lines.join('\n')}\n`)
    return file
  }

  test('the derived name is the base name with `.local` before the extension', () => {
    assert.equal(localConfigFile('/x/config/curia.yaml'), '/x/config/curia.local.yaml')
    assert.equal(localConfigFile('/x/config/routing.yaml'), '/x/config/routing.local.yaml')
  })

  test('no override file is the ordinary case, not an error', () => {
    const file = writeConfig()
    assert.equal(loadCuriaConfig(file).dispatch.max_concurrent, 2)
    assert.equal(overrideSummary(file), null)
  })

  test('a mapping merges key by key: one number moves and the section stays', () => {
    const file = override(writeConfig(), 'dispatch:', '  max_concurrent: 7')
    const cfg = loadCuriaConfig(file)
    assert.equal(cfg.dispatch.max_concurrent, 7)
    assert.equal(cfg.dispatch.poll_interval_s, 60, 'the keys the override is silent about still answer')
    assert.equal(cfg.dispatch.auto_dispatch, false)
  })

  test('a list replaces whole, because half a watch list is not a watch list', () => {
    const file = override(writeConfig(), 'watch:', '  - repo: o/other', '    mode: map')
    assert.deepEqual(loadCuriaConfig(file).watch, [{ repo: 'o/other', mode: 'map' }])
  })

  test('a key the tracked file does not carry is added by the override', () => {
    const file = override(writeConfig(), 'usage:', '  account_bars: false')
    assert.equal(loadCuriaConfig(file).usage.account_bars, false)
  })

  test('an empty override overrides nothing — comments alone are a legal file', () => {
    const file = override(writeConfig(), '# this box takes the shipped answers')
    assert.equal(loadCuriaConfig(file).dispatch.max_concurrent, 2)
  })

  test('an override that is not a mapping is refused by name', () => {
    const file = override(writeConfig(), '- one', '- two')
    assert.throws(() => loadCuriaConfig(file), /curia-.*\.local\.yaml: the override file must be a mapping/)
  })

  // The merged whole is what the daemon runs, so it is what every rule judges —
  // including the rules that read two sections against each other.
  test('every rule runs on the merged whole, not on either file alone', () => {
    const file = override(writeConfig(), 'attach:', '  serve_port: 8444')
    assert.throws(() => loadCuriaConfig(file), /attach.serve_port and timeline.serve_port are both 8444/)
  })

  test('a refusal names both layers, so the operator knows which file holds the line', () => {
    const file = override(writeConfig(), 'dispatch:', '  max_concurrent: 0')
    assert.throws(
      () => loadCuriaConfig(file),
      (e) => /curia-.*\.yaml \+ .*curia-.*\.local\.yaml: dispatch.max_concurrent/.test(e.message),
    )
  })

  test('the summary the daemon says at boot names the file and its top-level keys', () => {
    const file = override(writeConfig(), 'dispatch:', '  max_concurrent: 7', 'watch:', '  - repo: o/other')
    assert.deepEqual(overrideSummary(file), {
      file: localConfigFile(file),
      keys: ['dispatch', 'watch'],
    })
  })

  test('routing.yaml layers the same way, one model entry deep', () => {
    const base = path.join(tmp, 'routing.yaml')
    fs.writeFileSync(base, [
      'defaults:',
      '  untyped: opus',
      'models:',
      '  opus: { provider: anthropic, harness: claude }',
      '  gpt: { provider: openai, harness: codex }',
      'harnesses:',
      "  claude: { template: 'claude --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'x', tool_channel_grace_s: 15 }",
      "  codex: { template: 'codex --model {model} \"$(cat {prompt_file})\"', resume_template: 'resume --model {model}', ready: 'y', tool_channel_grace_s: 15 }",
      '',
    ].join('\n'))
    fs.writeFileSync(localConfigFile(base), 'models:\n  gpt:\n    active: false\n')
    const cfg = loadRoutingConfig(base)
    assert.equal(cfg.models.gpt.active, false)
    assert.equal(cfg.models.gpt.harness, 'codex', 'the entry merged rather than being replaced')
    assert.equal(cfg.models.opus.active, true)
  })

  test('an explicit `localFile` wins over the derived name, and null reads the base alone', () => {
    // This is how the settings screen judges a candidate before it lands.
    const file = override(writeConfig(), 'dispatch:', '  max_concurrent: 7')
    const candidate = path.join(tmp, 'candidate.yaml')
    fs.writeFileSync(candidate, 'dispatch:\n  max_concurrent: 9\n')
    assert.equal(loadCuriaConfig(file, { localFile: candidate }).dispatch.max_concurrent, 9)
    assert.equal(loadCuriaConfig(file, { localFile: null }).dispatch.max_concurrent, 2)
  })
})

// The whole decision rests on git not tracking the override, so the ignore rule
// is pinned against git itself rather than against a reading of the pattern.
describe('git ignores the override and tracks the base (#292)', () => {
  const root = path.resolve(DIRNAME, '..', '..')
  const ignored = (rel) => {
    const r = spawnSync('git', ['check-ignore', '-q', rel], { cwd: root })
    assert.ok(r.status === 0 || r.status === 1, `git check-ignore failed: ${r.stderr}`)
    return r.status === 0
  }

  for (const name of ['curia', 'routing']) {
    test(`config/${name}.local.yaml is ignored, and config/${name}.yaml is not`, () => {
      assert.equal(ignored(`config/${name}.local.yaml`), true,
        'a save from the dashboard would leave the checkout dirty, and the next deploy would refuse to fast-forward')
      assert.equal(ignored(`config/${name}.yaml`), false, 'the base layer is the one git carries')
    })
  }

  test('the atomic write’s candidate is ignored too, so a crash leaves no untracked file', () => {
    assert.equal(ignored('config/.curia.local.yaml.candidate'), true)
  })
})

// The recurring aistack sync (#695). The section is optional, because the switch
// that turns the sync on is the machine credential under curia's HOME and not a
// config key. The version is a pin, for the reason every pin in `sandbox:` is.
describe('the aistack section (#695)', () => {
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-aistack-cfg-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('a config that is silent about it still reads a pinned command', () => {
    const cfg = loadCuriaConfig(writeConfig())
    assert.equal(cfg.aistack.cli_version, DEFAULT_CLI_VERSION)
    assert.equal(cfg.aistack.interval_hours, DEFAULT_INTERVAL_HOURS)
  })

  test('the box names its own version and interval', () => {
    const cfg = loadCuriaConfig(writeConfig(['aistack:', '  cli_version: 1.2.3', '  interval_hours: 6'].join('\n')))
    assert.equal(cfg.aistack.cli_version, '1.2.3')
    assert.equal(cfg.aistack.interval_hours, 6)
  })

  test('an unpinned version is refused by name, which is what the pin exists for', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(['aistack:', '  cli_version: latest'].join('\n'))),
      /aistack\.cli_version must be a pinned version/,
    )
    assert.throws(
      () => loadCuriaConfig(writeConfig(['aistack:', '  cli_version: "^0.7"'].join('\n'))),
      /aistack\.cli_version must be a pinned version/,
    )
  })

  test('an interval that is not a positive number of hours is refused', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(['aistack:', '  interval_hours: 0'].join('\n'))),
      /aistack\.interval_hours must be a positive number/,
    )
    assert.throws(
      () => loadCuriaConfig(writeConfig(['aistack:', '  interval_hours: soon'].join('\n'))),
      /aistack\.interval_hours must be a positive number/,
    )
  })

  test('the section must be a mapping', () => {
    assert.throws(
      () => loadCuriaConfig(writeConfig(['aistack:', '  - 0.7.2'].join('\n'))),
      /`aistack` must be a mapping/,
    )
  })

  test('the shipped config pins a version the sync can run', () => {
    const shipped = parse(fs.readFileSync(path.join(DIRNAME, '..', '..', 'config', 'curia.yaml'), 'utf8'))
    assert.match(String(shipped.aistack.cli_version), /^\d+\.\d+\.\d+$/)
    assert.ok(shipped.aistack.interval_hours > 0)
    assert.equal('enabled' in shipped.aistack, false,
      'the switch is the machine credential under curia\'s HOME, not a config key')
  })
})

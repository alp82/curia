// Config validation is a trust boundary: both YAML files are hand-edited, and
// the daemon must refuse to boot rather than limp. These tests cover the
// worker skill set (#57) — the one section whose validation reaches the
// filesystem, because a named-but-absent skill is the failure it exists to end.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadCuriaConfig } from '../src/config.mjs'
import { DEFAULT_SKILLS, defaultSkillsRoot } from '../src/workspace.mjs'

let tmp
let root

// Base config with every other section valid, so a failure names the skills.
function writeConfig(skillsYaml) {
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

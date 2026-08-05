// A skills root the tests own (#212).
//
// `loadCuriaConfig` checks every name in `skills.install` against a `SKILL.md`
// on disk, and `skills.root` defaults to `~/.claude/skills`. So a fixture
// config that says nothing about skills reads the HOST's home directory, and
// the answer depends on the box: the operator's box has the nine, an agent
// container keeps its skills somewhere else, and a stranger's box has none.
// Every suite that spawns a real daemon then died at its `before` hook and
// node reported its tests as `cancelled` — a word that reads exactly like
// `skipped`, so an agent verifying its own daemon change learned to ignore it.
//
// The root is DERIVED from `DEFAULT_SKILLS` rather than committed as nine
// files, so adding a tenth default skill cannot bring the fault back.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SKILLS } from '../../src/workspace.mjs'

// Writes `<dir>/skills/<name>/SKILL.md` for every default skill and returns
// the root. Nothing reads a manifest body — the validator only asks whether
// the file is there — so the body says what the file is for instead.
export function seedSkillsRoot(dir, names = DEFAULT_SKILLS) {
  const root = path.join(dir, 'skills')
  fs.mkdirSync(root, { recursive: true })
  for (const name of names) {
    fs.mkdirSync(path.join(root, name), { recursive: true })
    fs.writeFileSync(
      path.join(root, name, 'SKILL.md'),
      `# ${name}\n\nA fixture stand-in for the ${name} skill (#212). Only its existence is read.\n`,
    )
  }
  return root
}

// The config lines a fixture yaml needs. `install` is left out on purpose: the
// seeded root carries the whole default list, so the fixture takes the same
// branch the shipped config takes instead of the empty-list opt-out.
export function skillsYaml(root) {
  return ['skills:', `  root: ${root}`]
}

// A HOME the test owns, seeded with the default skills where
// `defaultSkillsRoot()` looks for them. `os.homedir()` reads $HOME on POSIX,
// which is what lets a test pin the DEFAULT root on a box that does not carry
// it — the same trick the codex credential tests use (#158).
//
// `fn` must be synchronous: there is no await between the swap and the
// restore, so no other test can observe the changed HOME. Pass `names` when
// the config under test installs something other than the default list.
export function withSeededHome(fn, names = DEFAULT_SKILLS) {
  const saved = process.env.HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-skills-home-'))
  try {
    process.env.HOME = home
    seedSkillsRoot(path.join(home, '.claude'), names)
    return fn(home)
  } finally {
    process.env.HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
  }
}

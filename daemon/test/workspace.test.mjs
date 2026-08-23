// #53: an agent shares the host credential store instead of snapshotting it.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { execFileSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'
import {
  seedConfigDir, agentEnv, retiredAgentTokenKeys, hostStorageDir, installSkills, defaultSkillsRoot, DEFAULT_SKILLS,
  writeConnectionSettings, removeCredentials, untrustedProjectConfig, plantedSkills, MCP_SERVER_NAME,
  checkoutTicketBranch, remoteBranchExists, defaultBranchOf,
} from '../src/workspace.mjs'

describe('per-agent config dir (#53)', () => {
  let tmp
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-ws-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('seeding writes the no-dialog config and NO credential of its own', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-1')
    const wtPath = path.join(tmp, 'wt', '1')
    seedConfigDir(cfgDir, wtPath)

    // the trust/onboarding flags are what keep a first spawn dialog-free, and
    // the projects key must match the worktree path exactly
    const claudeJson = JSON.parse(fs.readFileSync(path.join(cfgDir, '.claude.json'), 'utf8'))
    assert.equal(claudeJson.hasCompletedOnboarding, true)
    assert.equal(claudeJson.projects[wtPath].hasTrustDialogAccepted, true)
    assert.ok(fs.existsSync(path.join(cfgDir, 'settings.json')))

    assert.equal(fs.existsSync(path.join(cfgDir, '.credentials.json')), false,
      'a snapshotted token is the #34 failure — nothing may be written here')
  })

  // #180. The credential is shared on purpose, and the account's connectors ride
  // it rather than the config dir, so the bound has to be a settings key. Both
  // keys are asserted by their exact CLI spelling: they are read by Claude Code,
  // not by curia, so a rename here is a silent loss of the bound.
  test('seeding bounds the MCP namespace to curia and nothing else (#180)', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-1b')
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '1b'))

    const settings = JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8'))
    assert.equal(settings.disableClaudeAiConnectors, true,
      'without this the agent fetches the operator\'s Notion, Gmail, Drive and Calendar')
    // OBJECT entries, not strings: an invalid allowlist enforces an empty one,
    // which would leave the agent with no curia tools at all.
    assert.deepEqual(settings.allowedMcpServers, [{ serverName: MCP_SERVER_NAME }])
    assert.equal(settings.skipDangerousModePermissionPrompt, true)
  })

  // The allowlist and the server it admits are one constant. Spelled apart they
  // would drift, and the drift is silent until an agent has no tools.
  test('the allowlist names the very server the harness writes (#180)', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-1c')
    const wtPath = path.join(tmp, 'wt', '1c')
    fs.mkdirSync(wtPath, { recursive: true })
    seedConfigDir(cfgDir, wtPath, null, 'claude')
    writeConnectionSettings({ wtPath, cfgDir, agent: 'curia-1c', ticket: 1, daemonPort: 4271, harness: 'claude', token: 'a'.repeat(64) })

    const settings = JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8'))
    const mcp = JSON.parse(fs.readFileSync(path.join(wtPath, '.mcp.json'), 'utf8'))
    assert.deepEqual(Object.keys(mcp.mcpServers), settings.allowedMcpServers.map((e) => e.serverName))
  })

  test('seeding unlinks a pre-#53 snapshot rather than leaving it to be used', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-2')
    fs.mkdirSync(cfgDir, { recursive: true })
    const stale = path.join(cfgDir, '.credentials.json')
    fs.writeFileSync(stale, JSON.stringify({ claudeAiOauth: { accessToken: 'dead-paper' } }))

    seedConfigDir(cfgDir, path.join(tmp, 'wt', '2'))

    assert.equal(fs.existsSync(stale), false,
      'a stale copy that still parses would silently re-enter the frozen-token failure')
  })

  test('the agent env isolates config while sharing the credential store', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-3')
    const env = agentEnv(cfgDir)

    assert.equal(env.CLAUDE_CONFIG_DIR, cfgDir)
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, hostStorageDir())
    assert.equal(hostStorageDir(), path.join(os.homedir(), '.claude'))

    // the point of the split: the two must NOT be the same dir, or the
    // isolation #23/#29 made mandatory is gone
    assert.notEqual(env.CLAUDE_CONFIG_DIR, env.CLAUDE_SECURESTORAGE_CONFIG_DIR)
    // an absolute path, not the empty-string form (see agentEnv's note)
    assert.ok(path.isAbsolute(env.CLAUDE_SECURESTORAGE_CONFIG_DIR))
  })

  // #155 gave the agent a scoped PAT as `GH_TOKEN`, and #466 retired it: an
  // agent mints its own token now, and it reads a file rather than the
  // environment (agentgh.mjs). What is left of the key is its NAME, and the
  // boot uses it to find a value nothing reads.
  describe('the retired agent PAT (#155, #466)', () => {
    const cfgDir = () => path.join(tmp, 'cfg', 'curia-3')

    test('no GitHub credential comes out of the agent env', () => {
      const env = {
        CURIA_AGENT_GH_TOKEN_ALP82: 'github_pat_11ALP82',
        CURIA_AGENT_GH_TOKEN_GETALFREDO: 'github_pat_11ORG',
      }
      // Even with the old keys still in the environment, and on both harnesses.
      // A leftover `GH_TOKEN` would BEAT the file the daemon refreshes, and the
      // one-hour expiry the cutover removed would come back.
      for (const harness of ['claude', 'codex']) {
        const agent = agentEnv(cfgDir(), harness, { sandboxed: true })
        assert.equal('GH_TOKEN' in agent, false)
        assert.equal('GITHUB_TOKEN' in agent, false)
        for (const key of Object.keys(agent)) assert.ok(!key.startsWith('CURIA_AGENT_GH_TOKEN'))
      }
      // the isolation it used to ride beside is untouched
      assert.equal(agentEnv(cfgDir(), 'claude').CLAUDE_CONFIG_DIR, cfgDir())
    })

    test('boot finds a retired key so the operator can delete and revoke it', () => {
      const env = {
        CURIA_AGENT_GH_TOKEN_ALP82: 'github_pat_11ALP82',
        CURIA_AGENT_GH_TOKEN_GETALFREDO: 'github_pat_11ORG',
        PATH: '/usr/bin',
      }
      assert.deepEqual(retiredAgentTokenKeys(env),
        ['CURIA_AGENT_GH_TOKEN_ALP82', 'CURIA_AGENT_GH_TOKEN_GETALFREDO'])
      assert.deepEqual(retiredAgentTokenKeys({ PATH: '/usr/bin' }), [])
      // A blanked line is still a line to delete, and it is not a token to
      // revoke — the boot says both acts and the operator judges which apply.
      assert.deepEqual(retiredAgentTokenKeys({ CURIA_AGENT_GH_TOKEN_EMPTY: '' }),
        ['CURIA_AGENT_GH_TOKEN_EMPTY'])
      // The overseer's own retired keys are a different prefix, and #392 names
      // those. One name for one thing.
      assert.deepEqual(retiredAgentTokenKeys({ CURIA_OVERSEER_GH_TOKEN_ALP82: 'x' }), [])
    })
  })

  test('the agent env lifts the 300 s MCP idle abort (#104)', () => {
    const env = agentEnv(path.join(tmp, 'cfg', 'curia-3'))
    // ms, and at least the codex harness's one-day bound — a blocked ask_human
    // must survive a human who takes hours, keepalive or no keepalive
    assert.equal(env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, '86400000')
  })
})

describe('the agent skill set (#57)', () => {
  let tmp
  let root

  // A stand-in host skills root: one directory per skill, each with a SKILL.md.
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-skills-'))
    root = path.join(tmp, 'host-skills')
    for (const name of ['wayfinder', 'tdd', 'grilling']) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
      fs.writeFileSync(path.join(root, name, 'SKILL.md'), `# ${name}\n`)
    }
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('seeding symlinks each configured skill, and reading through the link reaches the host', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-10')
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '10'), { root, install: ['wayfinder', 'tdd'] })

    const skillsDir = path.join(cfgDir, 'skills')
    assert.deepEqual(fs.readdirSync(skillsDir).sort(), ['tdd', 'wayfinder'])
    // a symlink, not a copy: the version tracks the host with no snapshot to
    // go stale, which is what makes this safe where #53's copy was not
    assert.ok(fs.lstatSync(path.join(skillsDir, 'wayfinder')).isSymbolicLink())
    assert.equal(fs.readlinkSync(path.join(skillsDir, 'wayfinder')), path.join(root, 'wayfinder'))
    assert.equal(fs.readFileSync(path.join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8'), '# wayfinder\n')

    // the bound: one read-only skills directory, the curia-owned voice file
    // (#133 — the one deliberate narrowing), and NOTHING else from the host
    assert.deepEqual(fs.readdirSync(cfgDir).sort(), ['.claude.json', 'CLAUDE.md', 'settings.json', 'skills'])
    assert.match(fs.readFileSync(path.join(cfgDir, 'CLAUDE.md'), 'utf8'), /Google developer documentation style guide/)
  })

  test('no skills configured installs none — the seam every test double takes', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-11')
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '11'))
    assert.equal(fs.existsSync(path.join(cfgDir, 'skills')), false)

    // an explicitly empty list is the opt-out, and behaves the same
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '11'), { root, install: [] })
    assert.equal(fs.existsSync(path.join(cfgDir, 'skills')), false)
  })

  test('a re-seeded config dir carries no skill that has left the list', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-12')
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '12'), { root, install: ['wayfinder', 'grilling'] })
    seedConfigDir(cfgDir, path.join(tmp, 'wt', '12'), { root, install: ['wayfinder'] })

    assert.deepEqual(fs.readdirSync(path.join(cfgDir, 'skills')), ['wayfinder'],
      'a link left behind would hand the agent a skill the operator removed')
  })

  test('a skill missing from the host refuses the spawn instead of shipping an agent without it', () => {
    const cfgDir = path.join(tmp, 'cfg', 'curia-13')
    assert.throws(
      () => installSkills(cfgDir, { root, install: ['wayfinder', 'gone'] }),
      /skill "gone" has no SKILL.md/,
    )
  })

  test('the default set is the full vendored tree except wizard (#534)', () => {
    const vendored = path.resolve(import.meta.dirname, '..', '..', 'skills')
    const expected = fs.readdirSync(vendored, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'wizard')
      .filter((entry) => fs.existsSync(path.join(vendored, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort()
    assert.deepEqual(DEFAULT_SKILLS.toSorted(), expected)
    assert.equal(defaultSkillsRoot(), path.join(os.homedir(), '.claude', 'skills'))
  })

  // #399. Codex hides a skill whose manifest says `allow_implicit_invocation:
  // false`, so the model is never told it exists. `$wayfinder` used to reach it
  // and paste all 11,867 characters into the conversation, where they went
  // stale. Curia writes a pointer instead: a skill it owns, listed by default,
  // naming the real file. Nothing upstream is patched.
  describe('the pointer that puts a hidden skill back on the codex catalog (#399)', () => {
    let ptmp
    let proot

    // Four shapes, and each one decides a different branch.
    before(() => {
      ptmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-ptr-'))
      proot = path.join(ptmp, 'skills')
      const skill = (name, front, manifest) => {
        fs.mkdirSync(path.join(proot, name), { recursive: true })
        fs.writeFileSync(path.join(proot, name, 'SKILL.md'), `---\n${front}\n---\n\n# ${name}\n`)
        if (manifest) {
          fs.mkdirSync(path.join(proot, name, 'agents'), { recursive: true })
          fs.writeFileSync(path.join(proot, name, 'agents', 'openai.yaml'), manifest)
        }
      }
      // hidden, plain description
      skill('wayfinder', 'name: wayfinder\ndescription: Chart a map of decision tickets.',
        'policy:\n  allow_implicit_invocation: false\n')
      // hidden, and its description is a QUOTED scalar — the `implement` shape
      skill('implement', 'name: implement\ndescription: "Implement work: from a spec, or tickets."',
        'policy:\n  allow_implicit_invocation: false\n')
      // a manifest that ALLOWS it: codex lists this one itself
      skill('grilling', 'name: grilling\ndescription: Grill the user.',
        'policy:\n  allow_implicit_invocation: true\n')
      // no manifest at all: listed by default
      skill('tdd', 'name: tdd\ndescription: Test first.')
    })
    after(() => { fs.rmSync(ptmp, { recursive: true, force: true }) })

    const seedCodex = (n, install) => {
      const cfgDir = path.join(ptmp, 'cfg', `curia-${n}`)
      seedConfigDir(cfgDir, path.join(ptmp, 'wt', String(n)), { root: proot, install }, 'codex')
      return cfgDir
    }

    // Frontmatter is PARSED here rather than matched, because the bug this
    // guards was invisible to a match: see the quoted-description test below.
    const frontmatter = (file) => {
      const text = fs.readFileSync(file, 'utf8')
      assert.ok(text.startsWith('---'), `${file} has no frontmatter at all`)
      const end = text.indexOf('\n---', 3)
      assert.notEqual(end, -1, `${file} has an unterminated frontmatter block`)
      return parseYaml(text.slice(3, end))
    }

    test('upstream decides which skills need one, and the manifest is what is read', () => {
      const cfgDir = seedCodex(20, ['wayfinder', 'implement', 'grilling', 'tdd'])
      assert.deepEqual(fs.readdirSync(path.join(cfgDir, 'skills')).sort(),
        ['curia-implement', 'curia-wayfinder', 'grilling', 'implement', 'tdd', 'wayfinder'])
      // A skill codex already lists gets no pointer, whether it says so in a
      // manifest or carries none. If upstream lists `wayfinder` in a later
      // release, the pointer stops being written with no edit here.
      assert.equal(fs.existsSync(path.join(cfgDir, 'skills', 'curia-grilling')), false)
      assert.equal(fs.existsSync(path.join(cfgDir, 'skills', 'curia-tdd')), false)
    })

    test('the pointer names the installed file and restates none of the skill', () => {
      const cfgDir = seedCodex(21, ['wayfinder'])
      const target = path.join(cfgDir, 'skills', 'wayfinder', 'SKILL.md')
      const pointer = path.join(cfgDir, 'skills', 'curia-wayfinder', 'SKILL.md')
      const front = frontmatter(pointer)

      assert.equal(front.name, 'curia-wayfinder')
      // The description is the real skill's own, so the codex trigger fires on
      // the tasks the skill claims rather than on a sentence curia invented.
      assert.match(front.description, /^Chart a map of decision tickets\./)
      assert.match(front.description, new RegExp(`Read ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} in full`))
      // The name is prefixed, never the skill's own: codex keys a skill on this
      // name, so two skills claiming `wayfinder` would be #224's ambiguity made
      // on purpose.
      assert.notEqual(front.name, 'wayfinder')
      // A copy would go stale in silence, which is the whole reason the patched
      // manifest was refused. The body carries the path and nothing else.
      const body = fs.readFileSync(pointer, 'utf8')
      assert.ok(body.includes(target), 'the pointer must name the file it points at')
      assert.ok(!body.includes('# wayfinder'), 'the pointer copies no skill text')
    })

    // The regression that shipped and had to be caught by a live render: the
    // `implement` skill writes its description as a QUOTED scalar. Splicing a
    // sentence onto the raw captured text produced `description: "..." Read
    // ...`, which is invalid YAML — and codex answers invalid frontmatter by
    // dropping the skill from its catalog WITHOUT A WORD. The pointer existed
    // on disk and reached no model.
    test('a quoted description still yields frontmatter that parses', () => {
      const cfgDir = seedCodex(22, ['implement'])
      const front = frontmatter(path.join(cfgDir, 'skills', 'curia-implement', 'SKILL.md'))
      assert.equal(front.name, 'curia-implement')
      assert.match(front.description, /^Implement work: from a spec, or tickets\. Read /,
        'the quotes and the colon must survive as VALUE, not as syntax')
    })

    test('every pointer curia can write parses, whatever upstream put in the description', () => {
      // The bound stated as a rule rather than as two examples: a description
      // is upstream's prose, and it may carry anything.
      const cfgDir = seedCodex(23, ['wayfinder', 'implement'])
      for (const name of ['curia-wayfinder', 'curia-implement']) {
        const front = frontmatter(path.join(cfgDir, 'skills', name, 'SKILL.md'))
        assert.equal(front.name, name)
        assert.equal(typeof front.description, 'string')
        assert.ok(front.description.length > 0)
      }
    })

    test('the read-once rule is in the file curia owns, because codex says the opposite', () => {
      // Codex tells the model to read a skill completely every time it uses one
      // AND not to carry a skill across turns. Obeyed literally that is 12,299
      // characters per turn, stacking (docs/live-checks/399). Curia cannot edit
      // codex's rule, so it writes its own where it can.
      const cfgDir = seedCodex(24, ['wayfinder'])
      const body = fs.readFileSync(path.join(cfgDir, 'skills', 'curia-wayfinder', 'SKILL.md'), 'utf8')
      assert.match(body, /ONCE in a session/)
    })

    test('a re-seed rebuilds the pointer, because installSkills wipes the directory it lives in', () => {
      // #340's `standing.md` trap, one directory over: `seedConfigDir` runs
      // again on the respawn a usage limit forces, and a pointer written
      // anywhere but after the install would be gone for the rest of the run.
      const cfgDir = seedCodex(25, ['wayfinder'])
      const pointer = path.join(cfgDir, 'skills', 'curia-wayfinder', 'SKILL.md')
      assert.ok(fs.existsSync(pointer))
      seedConfigDir(cfgDir, path.join(ptmp, 'wt', '25'), { root: proot, install: ['wayfinder'] }, 'codex')
      assert.ok(fs.existsSync(pointer), 'the re-arm must not leave the agent with a hidden skill')
    })

    test('a pointer for a skill that has left the install list does not survive', () => {
      const cfgDir = seedCodex(26, ['wayfinder', 'implement'])
      assert.ok(fs.existsSync(path.join(cfgDir, 'skills', 'curia-implement')))
      seedConfigDir(cfgDir, path.join(ptmp, 'wt', '26'), { root: proot, install: ['wayfinder'] }, 'codex')
      assert.deepEqual(fs.readdirSync(path.join(cfgDir, 'skills')).sort(), ['curia-wayfinder', 'wayfinder'])
    })

    test('the claude harness gets none, because it has no catalog to be missing from', () => {
      // `/wayfinder` is a slash command: Claude Code expands the whole SKILL.md
      // into the first user message, so that lane never had the fade this
      // cures. The row is the harness table's, not a name test in the seed.
      const cfgDir = path.join(ptmp, 'cfg', 'curia-27')
      seedConfigDir(cfgDir, path.join(ptmp, 'wt', '27'), { root: proot, install: ['wayfinder'] }, 'claude')
      assert.deepEqual(fs.readdirSync(path.join(cfgDir, 'skills')), ['wayfinder'])
    })

    test('the default skills with disabled model invocation get pointers', () => {
      // A tree bump that lists them upstream makes the pointers stop being
      // written, and this is where that shows up as a decision rather than as
      // silence.
      const vendored = path.resolve(import.meta.dirname, '..', '..', 'skills')
      const hidden = DEFAULT_SKILLS.filter((name) => {
        const manifest = path.join(vendored, name, 'agents', 'openai.yaml')
        if (!fs.existsSync(manifest)) return false
        return parseYaml(fs.readFileSync(manifest, 'utf8'))?.policy?.allow_implicit_invocation === false
      })
      assert.deepEqual(hidden.sort(), [
        'ask-matt', 'grill-me', 'grill-with-docs', 'handoff', 'implement',
        'improve-codebase-architecture', 'setup-matt-pocock-skills', 'teach',
        'to-questionnaire', 'to-spec', 'to-tickets', 'triage', 'wait-what', 'wayfinder',
      ])
    })
  })

  // The vendored tree carries every promoted skill, so a name in the list that
  // the tree does not carry is a boot refusal on the operator's own box — the
  // one place the suite's seeded fixture root cannot catch it (#212).
  test('every default skill is really in the vendored tree', () => {
    const vendored = path.resolve(import.meta.dirname, '..', '..', 'skills')
    for (const name of DEFAULT_SKILLS) {
      assert.ok(
        fs.existsSync(path.join(vendored, name, 'SKILL.md')),
        `skills/${name}/SKILL.md must exist, or the daemon refuses to boot`,
      )
    }
  })
})

// #54 item 6: re-dispatch onto a ticket whose pull request is already open. This
// runs against real git, because the bug it fixes was entirely in the plumbing:
// `worktree add -B curia/<n> … origin/HEAD` force-reset the branch, so the second
// agent started from the default branch and its non-forced push then failed —
// after having thrown away every commit already under review.
describe('the ticket branch start point (#54 item 6)', () => {
  let tmp
  let base
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-wt-'))
    const origin = path.join(tmp, 'origin.git')
    const seed = path.join(tmp, 'seed')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', origin, seed])
    fs.writeFileSync(path.join(seed, 'README.md'), 'base\n')
    git(seed, 'add', '.')
    git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base')
    git(seed, 'push', 'origin', 'main')
    // a first dispatch's work, already pushed and under review
    git(seed, 'checkout', '-b', 'curia/42')
    fs.writeFileSync(path.join(seed, 'work.txt'), 'reviewed work\n')
    git(seed, 'add', '.')
    git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'under review')
    git(seed, 'push', 'origin', 'curia/42')

    // #195: what a dispatch makes now is a standalone clone, so the fixture is
    // one. `createPrivateClone` clones through `gh`, which no unit test can
    // reach — `checkoutTicketBranch` is the rule it applies afterwards, and it
    // is what these cases drive.
    base = path.join(tmp, 'repos', 'o__r', 'wt')
    fs.mkdirSync(path.dirname(base), { recursive: true })
    execFileSync('git', ['clone', origin, base])
    git(base, 'remote', 'set-head', 'origin', 'main')
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('remoteBranchExists reads the tracking ref, and distinguishes absent from unreadable', async () => {
    assert.equal(await remoteBranchExists(base, 'curia/42'), true)
    assert.equal(await remoteBranchExists(base, 'curia/999'), false)
    await assert.rejects(() => remoteBranchExists(path.join(tmp, 'not-a-repo'), 'curia/42'),
      'a failed read must throw, never read as "no branch"')
  })

  test('a re-dispatch continues the existing branch instead of resetting it', async () => {
    assert.equal(await checkoutTicketBranch(base, 'curia/42'), 'origin/curia/42')
    assert.ok(fs.existsSync(path.join(base, 'work.txt')), 'the commits already under review must survive')
    assert.match(git(base, 'log', '-1', '--format=%s'), /under review/)
    assert.equal(git(base, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'curia/42')
  })

  test('a first dispatch still starts from the default branch', async () => {
    assert.equal(await checkoutTicketBranch(base, 'curia/77'), 'origin/main')
    assert.equal(fs.existsSync(path.join(base, 'work.txt')), false)
    assert.match(git(base, 'log', '-1', '--format=%s'), /base/)
    assert.equal(git(base, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'curia/77')
  })

  // #238: the landing path reads the default branch from the WORKSPACE, never
  // from a base clone — a repo whose dispatches are all sandboxed has no base
  // clone at all, and since #195 no repo has one.
  test('defaultBranchOf answers from a standalone clone (#238)', async () => {
    const clone = path.join(tmp, 'private-clone')
    execFileSync('git', ['clone', path.join(tmp, 'origin.git'), clone])
    assert.equal(await defaultBranchOf(clone), 'main')
  })
})

// ---- the codex harness (#39) -------------------------------------------------

describe('the codex agent harness (#39)', () => {
  let tmp
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-codex-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  // A fixed stand-in for what the daemon mints per agent (#159). The harness is
  // the only channel an agent learns it on, so writeConnectionSettings refuses without one.
  const TOKEN = 'a'.repeat(64)
  const TOKEN_HEADER = 'x-curia-agent-token'

  const dirs = (n) => ({
    cfgDir: path.join(tmp, 'cfg', `curia-${n}`),
    wtPath: path.join(tmp, 'wt', String(n)),
  })

  test('CODEX_HOME is the whole isolation, and no Claude variable leaks into it', () => {
    const { cfgDir } = dirs(1)
    assert.deepEqual(agentEnv(cfgDir, 'codex'), { CODEX_HOME: cfgDir })
  })

  // The #53 property, reached by the opposite mechanism: codex FOLLOWS the link
  // when it refreshes (Claude replaces it), so the agent writes the host's own
  // file and the two share one refresh lineage.
  test('the credential is a symlink to the host store, never a copy', () => {
    const { cfgDir, wtPath } = dirs(2)
    seedConfigDir(cfgDir, wtPath, null, 'codex')
    const link = path.join(cfgDir, 'auth.json')
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.equal(fs.readlinkSync(link), path.join(hostStorageDir('codex'), 'auth.json'))
  })

  test('a real credential file left in a reused config dir is swept, not reused', () => {
    const { cfgDir, wtPath } = dirs(3)
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'auth.json'), '{"stale":"token"}')
    seedConfigDir(cfgDir, wtPath, null, 'codex')
    assert.equal(fs.lstatSync(path.join(cfgDir, 'auth.json')).isSymbolicLink(), true)
  })

  // rmSync unlinks a symlink rather than following it, so the sweep must never
  // reach the host file the link points at.
  test('sweeping credentials removes the link and not the host file it points at', () => {
    const { cfgDir, wtPath } = dirs(4)
    seedConfigDir(cfgDir, wtPath, null, 'codex')
    const host = path.join(hostStorageDir('codex'), 'auth.json')
    const hostExisted = fs.existsSync(host)
    removeCredentials(cfgDir)
    assert.equal(fs.existsSync(path.join(cfgDir, 'auth.json')), false)
    assert.equal(fs.existsSync(host), hostExisted)
  })

  // #158: a container mounts no host HOME, so the link resolves to nothing
  // inside it. `os.homedir()` reads $HOME on POSIX, which is what lets these
  // drive both the copy and the refusal without touching the real reduction.
  const withHome = (fn) => {
    const saved = process.env.HOME
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-codex-home-'))
    try {
      process.env.HOME = home
      return fn(home)
    } finally {
      process.env.HOME = saved
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  describe('the sandboxed codex credential (#158)', () => {
    test('a container gets a read-only COPY, never the link', () => withHome((home) => {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"tokens":{"refresh_token":"r"}}')
      const { cfgDir, wtPath } = dirs(20)
      seedConfigDir(cfgDir, wtPath, null, 'codex', { sandboxed: true })

      const dest = path.join(cfgDir, 'auth.json')
      const st = fs.lstatSync(dest)
      assert.equal(st.isSymbolicLink(), false, 'a link into ~/.codex resolves to nothing inside a container')
      assert.equal(fs.readFileSync(dest, 'utf8'), '{"tokens":{"refresh_token":"r"}}')
      // 0400: an ordinary in-place refresh FAILS rather than rotating the host
      // away, which is the whole reason the copy is frozen (the file carries a
      // refresh_token, and providers rotate those)
      assert.equal(st.mode & 0o777, 0o400)
    }))

    test('the bare path still shares the host store — the boundary is what changes, not the harness', () => withHome((home) => {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}')
      const { cfgDir, wtPath } = dirs(21)
      seedConfigDir(cfgDir, wtPath, null, 'codex')
      assert.equal(fs.lstatSync(path.join(cfgDir, 'auth.json')).isSymbolicLink(), true)
    }))

    // #195 took the second way out away: there is no `sandbox: none` to fall
    // back to. #642 replaced the ssh session with a verb: `reauth` opens a
    // browser login the operator can finish from a phone.
    test('no host credential refuses the seed, naming the one way out', () => withHome(() => {
      const { cfgDir, wtPath } = dirs(22)
      assert.throws(
        () => seedConfigDir(cfgDir, wtPath, null, 'codex', { sandboxed: true }),
        /reauth/,
      )
    }))

    test('a stale copy in a reused config dir is swept before the fresh one lands', () => withHome((home) => {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"fresh":true}')
      const { cfgDir, wtPath } = dirs(23)
      fs.mkdirSync(cfgDir, { recursive: true })
      fs.writeFileSync(path.join(cfgDir, 'auth.json'), '{"stale":true}')
      fs.chmodSync(path.join(cfgDir, 'auth.json'), 0o400)

      seedConfigDir(cfgDir, wtPath, null, 'codex', { sandboxed: true })
      assert.equal(fs.readFileSync(path.join(cfgDir, 'auth.json'), 'utf8'), '{"fresh":true}')
    }))

    test('the sweep takes the copy — it is a live host credential outliving its container', () => withHome((home) => {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
      const host = path.join(home, '.codex', 'auth.json')
      fs.writeFileSync(host, '{}')
      const { cfgDir, wtPath } = dirs(24)
      seedConfigDir(cfgDir, wtPath, null, 'codex', { sandboxed: true })

      removeCredentials(cfgDir)
      assert.equal(fs.existsSync(path.join(cfgDir, 'auth.json')), false)
      assert.equal(fs.existsSync(host), true, 'the host store is never touched by a sweep')
    }))
  })

  // #351: the 0400 bit blocks the write-back, not the refresh. A copy whose
  // access token is already expired refreshes on first use, the server rotates
  // the refresh token, and the rotation cannot land in the read-only file — so
  // the agent AND the host store end on a spent token. The seed refuses that
  // dispatch instead. The access token is a JWT, so the tests build one with a
  // real `exp` claim and nothing else.
  describe('an expired codex access token refuses the seed (#351)', () => {
    const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
    const authWith = (accessToken) => JSON.stringify({ tokens: { access_token: accessToken, refresh_token: 'r' } })
    const hostAuth = (home, content) => {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), content)
    }
    const nowS = Math.floor(Date.now() / 1000)

    test('an expired token refuses the dispatch, naming the expiry and the remedy', () => withHome((home) => {
      hostAuth(home, authWith(jwt({ exp: nowS - 3600 })))
      const { cfgDir, wtPath } = dirs(25)
      assert.throws(
        () => seedConfigDir(cfgDir, wtPath, null, 'codex', { sandboxed: true }),
        /access token expired .*reauth/s,
      )
      assert.equal(fs.existsSync(path.join(cfgDir, 'auth.json')), false, 'no copy lands on a refusal')
    }))

    test('a live token seeds as before', () => withHome((home) => {
      const content = authWith(jwt({ exp: nowS + 3600 }))
      hostAuth(home, content)
      const { cfgDir, wtPath } = dirs(26)
      seedConfigDir(cfgDir, wtPath, null, 'codex', { sandboxed: true })
      const dest = path.join(cfgDir, 'auth.json')
      assert.equal(fs.readFileSync(dest, 'utf8'), content)
      assert.equal(fs.lstatSync(dest).mode & 0o777, 0o400)
    }))

    test('a token this parser cannot read proves nothing — the seed proceeds', () => withHome((home) => {
      hostAuth(home, authWith('not-a-jwt'))
      const { cfgDir, wtPath } = dirs(27)
      seedConfigDir(cfgDir, wtPath, null, 'codex', { sandboxed: true })
      assert.equal(fs.existsSync(path.join(cfgDir, 'auth.json')), true)
    }))

    test('an exp claim that is not a number proves nothing either', () => withHome((home) => {
      hostAuth(home, authWith(jwt({ exp: 'soon' })))
      const { cfgDir, wtPath } = dirs(28)
      seedConfigDir(cfgDir, wtPath, null, 'codex', { sandboxed: true })
      assert.equal(fs.existsSync(path.join(cfgDir, 'auth.json')), true)
    }))

    test('the bare path never refuses — the host process refreshes its own store in place', () => withHome((home) => {
      hostAuth(home, authWith(jwt({ exp: nowS - 3600 })))
      const { cfgDir, wtPath } = dirs(29)
      seedConfigDir(cfgDir, wtPath, null, 'codex')
      assert.equal(fs.lstatSync(path.join(cfgDir, 'auth.json')).isSymbolicLink(), true)
    }))
  })

  // #171: CODEX_HOME does not bound skills. The pinned codex also reads
  // `$HOME/.agents/skills`, with no config key to turn the root off, so the
  // harness writes one disable entry per host skill the seed did not install.
  // The live half of this guard — codex ignores an unknown config key in
  // silence — is `codex debug prompt-input` (docs/live-checks/171).
  describe('the codex skill bound (#171)', () => {
    const armed = (n, skills) => {
      const { cfgDir, wtPath } = dirs(n)
      fs.mkdirSync(wtPath, { recursive: true })
      seedConfigDir(cfgDir, wtPath, null, 'codex')
      writeConnectionSettings({ wtPath, cfgDir, agent: `curia-${n}`, ticket: n, daemonPort: 4271, harness: 'codex', token: TOKEN, skills })
      return fs.readFileSync(path.join(cfgDir, 'config.toml'), 'utf8')
    }

    test('every host skill outside the install list is denied by name', () => withHome((home) => {
      for (const name of ['wayfinder', 'to-tickets', 'handoff']) {
        fs.mkdirSync(path.join(home, '.agents', 'skills', name), { recursive: true })
      }
      const toml = armed(30, { root: path.join(home, '.agents', 'skills'), install: ['wayfinder'] })
      for (const name of ['to-tickets', 'handoff']) {
        assert.match(toml, new RegExp(`\\[\\[skills\\.config\\]\\]\\nname = "${name}"\\nenabled = false`), `${name} is not installed, so the host root must not leak it`)
      }
      assert.equal(/name = "wayfinder"/.test(toml), false, 'an installed skill is never denied')
    }))

    test('the six planted .system skills are pinned off with the bundled key', () => withHome(() => {
      const toml = armed(31, null)
      assert.match(toml, /\[skills\]\nbundled = \{ enabled = false \}/)
    }))

    test('a host with no .agents/skills root gets the bundled pin and nothing to deny', () => withHome(() => {
      const toml = armed(32, null)
      assert.equal(/\[\[skills\.config\]\]/.test(toml), false)
    }))
  })

  test('skills install the same way under codex — both CLIs read <config>/skills', () => {
    const { cfgDir, wtPath } = dirs(5)
    const root = path.join(tmp, 'skills')
    fs.mkdirSync(path.join(root, 'wayfinder'), { recursive: true })
    fs.writeFileSync(path.join(root, 'wayfinder', 'SKILL.md'), '# wayfinder')
    seedConfigDir(cfgDir, wtPath, { root, install: ['wayfinder'] }, 'codex')
    assert.equal(fs.readFileSync(path.join(cfgDir, 'skills', 'wayfinder', 'SKILL.md'), 'utf8'), '# wayfinder')
  })

  test('the harness writes config and hooks into the config dir, and NOTHING into the repo', () => {
    const { cfgDir, wtPath } = dirs(6)
    fs.mkdirSync(wtPath, { recursive: true })
    seedConfigDir(cfgDir, wtPath, null, 'codex')
    writeConnectionSettings({ wtPath, cfgDir, agent: 'curia-6', ticket: 6, daemonPort: 4271, harness: 'codex', reasoningEffort: 'high', token: TOKEN })

    const toml = fs.readFileSync(path.join(cfgDir, 'config.toml'), 'utf8')
    // without the trust entry the first spawn stops at "Do you trust the
    // contents of this directory?" and the agent never reaches its composer
    assert.match(toml, new RegExp(`\\[projects\\."${wtPath}"\\]\\ntrust_level = "trusted"`))
    assert.match(toml, /\[features\]\nhooks = true/)

    // #172: the tool set is a control. These three are `stable` and default TRUE
    // on the pinned codex, and they carry the `codex_apps` namespace — plugin
    // search, install and uninstall, `_update_app_permissions` — plus
    // `resume_agent` and `close_agent`. curia never configured any of them.
    //
    // Asserted as whole lines under `[features]`, because codex ignores a key it
    // does not know IN SILENCE: a rename upstream turns this into a no-op that
    // reads exactly like a bound lane. The live read of `codex features list` is
    // the other half of this guard (docs/live-checks/172).
    for (const feature of ['apps', 'plugins', 'multi_agent']) {
      assert.match(toml, new RegExp(`^${feature} = false$`, 'm'), `${feature} must be off: curia never configured it`)
    }

    // #207: the rest of the default-on registry, pinned off. Measured inert for
    // a CLI agent on the pinned codex — these lines remove no capability today.
    // They exist so the next version bump that DOES attach one of them to the
    // CLI meets a stated choice (docs/live-checks/207). Same whole-line
    // assertion, for the same silent-rename reason.
    for (const feature of [
      'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
      'in_app_browser', 'computer_use', 'in_app_updates', 'skill_mcp_dependency_install',
    ]) {
      assert.match(toml, new RegExp(`^${feature} = false$`, 'm'), `${feature} must be off: curia never chose it (#207)`)
    }
    assert.match(toml, /\[mcp_servers\.curia\]\nurl = "http:\/\/127\.0\.0\.1:4271\/mcp\?agent=curia-6&ticket=6"/)

    // codex's 300 s tool-call deadline is a HARD one, so #34's keepalive — which
    // lifts Claude Code's identical abort — does nothing here. Without this line
    // every blocking ask_human dies at five minutes (observed live, twice).
    assert.match(toml, /tool_timeout_sec = 86400/)

    // Stated, not defaulted: gpt-5.5 defaults to medium and gpt-5.6-sol to low,
    // so leaving it out would move the depth whenever the model id moves.
    assert.match(toml, /model_reasoning_effort = "high"/)

    // #159: the agent's proof of its own name, in the shape `codex mcp list`
    // reads back as the transport's `http_headers`.
    assert.match(toml, new RegExp(`http_headers = \\{ "${TOKEN_HEADER}" = "${TOKEN}" \\}`))

    const hooks = JSON.parse(fs.readFileSync(path.join(cfgDir, 'hooks.json'), 'utf8'))
    assert.match(hooks.hooks.Stop[0].hooks[0].command, /agent_done\?agent=curia-6/)
    assert.match(hooks.hooks.Stop[0].hooks[0].command, new RegExp(`-H '${TOKEN_HEADER}: ${TOKEN}'`))

    // The harness is the only channel an agent learns its token on, so nothing
    // here is world-readable.
    for (const f of ['config.toml', 'hooks.json']) {
      assert.equal(fs.statSync(path.join(cfgDir, f)).mode & 0o077, 0, `${f} carries the token and must not be world-readable`)
    }

    assert.deepEqual(fs.readdirSync(wtPath), [])
  })

  // The claude harness's own spelling of the same control, pinned beside it.
  test('the claude harness carries the agent token on the MCP server and the Stop hook (#159)', () => {
    const { cfgDir, wtPath } = dirs(14)
    fs.mkdirSync(wtPath, { recursive: true })
    seedConfigDir(cfgDir, wtPath, null, 'claude')
    writeConnectionSettings({ wtPath, cfgDir, agent: 'curia-14', ticket: 14, daemonPort: 4271, harness: 'claude', token: TOKEN })

    const mcp = JSON.parse(fs.readFileSync(path.join(wtPath, '.mcp.json'), 'utf8'))
    assert.deepEqual(mcp.mcpServers.curia.headers, { [TOKEN_HEADER]: TOKEN })
    const settings = JSON.parse(fs.readFileSync(path.join(wtPath, '.claude', 'settings.json'), 'utf8'))
    assert.match(settings.hooks.Stop[0].hooks[0].command, new RegExp(`-H '${TOKEN_HEADER}: ${TOKEN}'`))
    for (const f of [path.join(wtPath, '.mcp.json'), path.join(wtPath, '.claude', 'settings.json')]) {
      assert.equal(fs.statSync(f).mode & 0o077, 0, `${f} carries the token and must not be world-readable`)
    }
  })

  // There is no safe default for a secret, so the harness refuses rather than
  // writing one an agent could not authenticate with.
  test('a harness with no minted token is refused rather than written (#159)', () => {
    const { cfgDir, wtPath } = dirs(15)
    fs.mkdirSync(wtPath, { recursive: true })
    seedConfigDir(cfgDir, wtPath, null, 'claude')
    for (const token of [undefined, '', 'short', 'Z'.repeat(64)]) {
      assert.throws(
        () => writeConnectionSettings({ wtPath, cfgDir, agent: 'curia-15', ticket: 15, daemonPort: 4271, harness: 'claude', token }),
        /without a minted agent token/,
      )
    }
    assert.equal(fs.existsSync(path.join(wtPath, '.mcp.json')), false)
  })

  // The claude harness's own shape, asserted alongside so the two stay told apart.
  test('the claude harness still writes its side channel into the worktree', () => {
    const { cfgDir, wtPath } = dirs(7)
    fs.mkdirSync(wtPath, { recursive: true })
    seedConfigDir(cfgDir, wtPath, null, 'claude')
    writeConnectionSettings({ wtPath, cfgDir, agent: 'curia-7', ticket: 7, daemonPort: 4271, harness: 'claude', token: TOKEN })
    assert.ok(fs.existsSync(path.join(wtPath, '.mcp.json')))
    assert.ok(fs.existsSync(path.join(wtPath, '.claude', 'settings.json')))
    assert.equal(fs.existsSync(path.join(cfgDir, 'config.toml')), false)
  })

  test('an unstated reasoning effort leaves the model to its own default', () => {
    const { cfgDir, wtPath } = dirs(11)
    fs.mkdirSync(wtPath, { recursive: true })
    seedConfigDir(cfgDir, wtPath, null, 'codex')
    writeConnectionSettings({ wtPath, cfgDir, agent: 'curia-11', ticket: 11, daemonPort: 4271, harness: 'codex', token: TOKEN })
    assert.equal(/model_reasoning_effort/.test(fs.readFileSync(path.join(cfgDir, 'config.toml'), 'utf8')), false)
  })

  test('an unknown harness refuses rather than seeding an agent nothing can drive', () => {
    const { cfgDir, wtPath } = dirs(8)
    assert.throws(() => seedConfigDir(cfgDir, wtPath, null, 'cursor'), /no agent harness/)
    assert.throws(() => agentEnv(cfgDir, 'cursor'), /no agent harness/)
  })

  // The codex spawn bypasses hook trust for the hook curia writes; the same flag
  // would run one the repo carries, with no model in the loop.
  test('a repo-planted project hook file is spotted on the codex harness', () => {
    const { wtPath } = dirs(9)
    fs.mkdirSync(path.join(wtPath, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(wtPath, '.codex', 'hooks.json'), '{}')
    assert.equal(untrustedProjectConfig(wtPath, 'codex'), path.join(wtPath, '.codex', 'hooks.json'))
    // the claude harness never loads .codex/, so it is not this guard's business
    assert.equal(untrustedProjectConfig(wtPath, 'claude'), null)
  })

  // curia overwrites <wt>/.claude/settings.json, but Claude Code merges
  // settings.local.json on top of it — a repo-carried copy would run its hooks
  // with no model in the loop (#105).
  test('a repo-planted settings.local.json is spotted on the claude harness', () => {
    const { wtPath } = dirs(12)
    fs.mkdirSync(path.join(wtPath, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(wtPath, '.claude', 'settings.local.json'), '{}')
    assert.equal(untrustedProjectConfig(wtPath, 'claude'), path.join(wtPath, '.claude', 'settings.local.json'))
    // the settings.json curia itself writes stays welcome
    assert.equal(untrustedProjectConfig(wtPath, 'codex'), null)
  })

  test('the settings.json curia writes does not trip the claude guard', () => {
    const { cfgDir, wtPath } = dirs(13)
    fs.mkdirSync(wtPath, { recursive: true })
    seedConfigDir(cfgDir, wtPath, null, 'claude')
    writeConnectionSettings({ wtPath, cfgDir, agent: 'curia-13', ticket: 13, daemonPort: 4271, harness: 'claude', token: TOKEN })
    assert.equal(untrustedProjectConfig(wtPath, 'claude'), null)
  })

  test('a clean worktree passes the planted-config guard', () => {
    const { wtPath } = dirs(10)
    fs.mkdirSync(wtPath, { recursive: true })
    assert.equal(untrustedProjectConfig(wtPath, 'codex'), null)
    assert.equal(untrustedProjectConfig(wtPath, 'claude'), null)
  })

  // #224: a repo skill under a name curia installs impersonates the seeded
  // tooling. Each harness reads its own repo roots, measured on the pinned
  // CLIs (docs/live-checks/224).
  const plantSkill = (wtPath, root, dir, name = dir) => {
    const d = path.join(wtPath, ...root, dir)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: planted\n---\nbody\n`)
  }

  test('a repo skill under an installed name is spotted on the harness that reads its root', () => {
    const { wtPath } = dirs(14)
    fs.mkdirSync(wtPath, { recursive: true })
    plantSkill(wtPath, ['.codex', 'skills'], 'wayfinder')
    plantSkill(wtPath, ['.agents', 'skills'], 'tdd')
    plantSkill(wtPath, ['.claude', 'skills'], 'implement')
    const install = ['wayfinder', 'tdd', 'implement']
    assert.deepEqual(plantedSkills(wtPath, 'codex', install).map((p) => p.name).sort(), ['tdd', 'wayfinder'])
    assert.deepEqual(plantedSkills(wtPath, 'claude', install).map((p) => p.name), ['implement'])
  })

  // Codex keys a skill on its frontmatter name and ignores the directory, so
  // the plant can sit in an innocently named directory (measured, #224).
  test('a frontmatter name in an innocent directory is spotted', () => {
    const { wtPath } = dirs(15)
    fs.mkdirSync(wtPath, { recursive: true })
    plantSkill(wtPath, ['.codex', 'skills'], 'innocent', 'wayfinder')
    const found = plantedSkills(wtPath, 'codex', ['wayfinder'])
    assert.equal(found.length, 1)
    assert.equal(found[0].name, 'wayfinder')
    assert.match(found[0].path, /innocent/)
  })

  test('a repo skill under a name curia does not install stays welcome', () => {
    const { wtPath } = dirs(16)
    fs.mkdirSync(wtPath, { recursive: true })
    plantSkill(wtPath, ['.claude', 'skills'], 'deploy-docs')
    plantSkill(wtPath, ['.codex', 'skills'], 'deploy-docs')
    assert.deepEqual(plantedSkills(wtPath, 'claude', ['wayfinder']), [])
    assert.deepEqual(plantedSkills(wtPath, 'codex', ['wayfinder']), [])
  })

  test('no install list, a bare directory, or no SKILL.md trips nothing', () => {
    const { wtPath } = dirs(17)
    fs.mkdirSync(path.join(wtPath, '.claude', 'skills', 'wayfinder'), { recursive: true })
    assert.deepEqual(plantedSkills(wtPath, 'claude', []), [])
    assert.deepEqual(plantedSkills(wtPath, 'claude', undefined), [])
    // the directory exists but holds no SKILL.md, so no harness loads it
    assert.deepEqual(plantedSkills(wtPath, 'claude', ['wayfinder']), [])
  })
})

// The settings write (#265), building item 5 of the where-it-lives decision
// (#249): the sidecar edits yaml through the document API, the daemon's own
// loaders judge the candidate, and the write is atomic. #292 moved WHERE it
// writes — into an override file beside each tracked one, which git ignores.
//
// What is pinned here is the half a human looking at the preview cannot check.
// A screenshot shows a number in a box. It does not show that the tracked file
// never moved, that a comment survived, that a refused save left every file
// byte for byte as it was, that a two-file save is never half applied, or that
// the candidate the loaders passed is the exact bytes that landed.
//
// The last suite pins the shipped config files themselves. They are committed
// in the form the document API prints back unchanged. No save rewrites them any
// more, so this now holds the two layers in one style: an override file IS
// printed back, and a line copied between them must not reflow on arrival.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, parseDocument } from 'yaml'

import {
  readSettings, saveSettings, candidateFor, PRINT_OPTS,
  LIVE_PATHS, liveSettings, liveDiff, frozenDifference,
} from '../src/settings.mjs'
import { loadCuriaConfig, loadRoutingConfig, localConfigFile, operatorConfigFile } from '../src/config.mjs'
import { readOperatorConfig } from '../../cli/src/config.mjs'
import { candidates, isActive, resolveReviewer, Cooling } from '../src/routing.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SHIPPED = path.resolve(DIR, '..', '..', 'config')

let tmp
let curiaFile
let routingFile
const files = () => ({ curiaFile, routingFile })
// Where a save lands: the operator half in config.yaml beside the tracked file
// (#866), the routing half in the override beside its tracked file (#292).
const operatorFile = () => operatorConfigFile(curiaFile)
// The hand override beside curia.yaml, which nothing writes since #866 and the
// daemon still reads under config.yaml.
const overCuria = () => localConfigFile(curiaFile)
const overRouting = () => localConfigFile(routingFile)
const readOr = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

// A curia.yaml with the comment shapes that matter: an aligned trailing comment
// on a value the screen edits, a comment block above a key it does not, and a
// comment beside one watch entry and not the others.
function writeCuria(extra = []) {
  const skills = skillsYaml(seedSkillsRoot(tmp))
  fs.writeFileSync(curiaFile, [
    '# The box config. Hand-edited.',
    '',
    'watch:',
    '  - repo: o/first # the one with the map',
    '  - repo: o/second',
    'dispatch:',
    '  auto_dispatch: false # shipped OFF',
    '  # The resource number, not a throughput one.',
    '  max_concurrent: 2',
    '  poll_interval_s: 60',
    '  prototype_variations: 5',
    `  workspace_root: ${path.join(tmp, 'work')}`,
    '  claim_login: alp82',
    '  ready_timeout_s: 45',
    'attach:',
    '  ttyd_port: 7681',
    '  serve_port: 8443',
    'identity:',
    '  allow: [tester@example.com]',
    ...extra,
    ...skills,
    ...sandboxYaml(),
    '',
  ].join('\n'))
}

function writeRouting(extra = []) {
  fs.writeFileSync(routingFile, [
    'defaults:',
    '  # opus until the credits arrive',
    '  untyped: opus',
    '  research: gpt # spread the quota',
    'models:',
    '  opus:',
    '    provider: anthropic',
    '    harness: claude',
    '  sonnet:',
    '    provider: anthropic',
    '    harness: claude',
    '  # the label vocabulary is not the CLI vocabulary',
    '  gpt:',
    '    provider: openai',
    '    harness: codex',
    '    id: gpt-5.6-sol',
    'review:',
    '  anthropic: gpt',
    '  openai: opus',
    'fallbacks:',
    '  opus: [gpt, sonnet]',
    ...extra,
    'harnesses:',
    '  claude:',
    '    template: claude --model {model} "$(cat {prompt_file})"',
    '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
    "    ready: 'bypass permissions'",
    '    tool_channel_grace_s: 15',
    '  codex:',
    '    template: codex --model {model} "$(cat {prompt_file})"',
    '    resume_template: codex resume --last --model {model} "Continue the interrupted work."',
    "    ready: '. [~/]'",
    '    tool_channel_grace_s: 20',
    '',
  ].join('\n'))
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-settings-'))
  curiaFile = path.join(tmp, 'curia.yaml')
  routingFile = path.join(tmp, 'routing.yaml')
  writeCuria()
  writeRouting()
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('the read the settings screen draws', () => {
  test('it names the dispatch keys, the watch list, and the routing tables', () => {
    const s = readSettings(files())
    assert.deepEqual(s.dispatch, {
      auto_dispatch: false,
      max_concurrent: 2,
      poll_interval_s: 60,
      prototype_variations: 5,
      messages_per_send: 4,
    })
    assert.deepEqual(s.overseer, { live_pane_cap: 3 })
    assert.deepEqual(s.watch, [{ repo: 'o/first', mode: 'auto' }, { repo: 'o/second', mode: 'auto' }])
    assert.deepEqual(s.routing.defaults, [{ type: 'untyped', model: 'opus' }, { type: 'research', model: 'gpt' }])
    assert.deepEqual(s.routing.models.map((m) => m.name), ['opus', 'sonnet', 'gpt'])
    assert.equal(s.routing.models.find((m) => m.name === 'gpt').id, 'gpt-5.6-sol')
  })

  test('a model with no `active` key reads as on — a file written before the key routes as it always did', () => {
    assert.ok(readSettings(files()).routing.models.every((m) => m.active))
  })

  test('an object routing default keeps its model and ticket-type effort', () => {
    fs.writeFileSync(routingFile, fs.readFileSync(routingFile, 'utf8')
      .replace('  research: gpt # spread the quota', '  research: { model: gpt, effort: high } # spread the quota'))
    assert.deepEqual(readSettings(files()).routing.defaults, [
      { type: 'untyped', model: 'opus' },
      { type: 'research', model: 'gpt', effort: 'high' },
    ])
  })

  // The screen is most needed exactly when the daemon will not boot on this
  // file, so the read must not run the loaders.
  test('a config the loaders REFUSE still reads, because that is when the screen is needed', () => {
    fs.writeFileSync(curiaFile, 'watch:\n  - repo: o/r\ndispatch:\n  max_concurrent: 2\n')
    assert.throws(() => loadCuriaConfig(curiaFile, { checkPaths: false }))
    const s = readSettings(files())
    assert.deepEqual(s.watch, [{ repo: 'o/r', mode: 'auto' }])
    assert.equal(s.dispatch.auto_dispatch, null)
  })
})

// #292. The save moved off the tracked files and onto an override beside each
// one, because git tracks the tracked ones: a save used to leave the box's
// checkout dirty, the next `git merge --ff-only` refused it, and the deploy's
// own rollback discarded it. What these pin is the half a screenshot cannot
// show — that the tracked file never moves, that the override holds only what
// differs, and that it goes away when it holds nothing.
describe('the operator half of a save lands in config.yaml (#866)', () => {
  test('the prototype count is editable from the settings screen', () => {
    saveSettings({ ...files(), patch: { dispatch: { prototype_variations: 7 } } })
    assert.equal(loadCuriaConfig(curiaFile, { checkPaths: false }).dispatch.prototype_variations, 7)
  })

  test('the tracked file is untouched and config.yaml carries the change', () => {
    const before = fs.readFileSync(curiaFile, 'utf8')
    const out = saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 5 } } })
    assert.deepEqual(out.written, ['config.yaml'])
    assert.equal(fs.readFileSync(curiaFile, 'utf8'), before, 'curia.yaml is byte for byte what it was')
    assert.match(readOr(operatorFile()), /^max_concurrent: 5$/m)
    assert.equal(loadCuriaConfig(curiaFile, { checkPaths: false }).dispatch.max_concurrent, 5)
  })

  test('the file holds what the operator decided and nothing else', () => {
    saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 5 } } })
    assert.deepEqual(readOperatorConfig(operatorFile()), { max_concurrent: 5 })
    // and the rest of the config still reads, off the tracked file below it
    assert.equal(loadCuriaConfig(curiaFile, { checkPaths: false }).dispatch.poll_interval_s, 60)
  })

  test('a value that comes back to the shipped one stays written: the file is a declaration, not a diff', () => {
    saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 5 } } })
    const out = saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 2 } } })
    assert.deepEqual(out.written, ['config.yaml'])
    assert.deepEqual(readOperatorConfig(operatorFile()), { max_concurrent: 2 })
    assert.equal(loadCuriaConfig(curiaFile, { checkPaths: false }).dispatch.max_concurrent, 2)
  })

  test('the file says in its own head what it is', () => {
    saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 5 } } })
    assert.match(readOr(operatorFile()), /^# Curia operator configuration\./m)
  })

  test('the file is owner-only, and a save leaves no temporary file beside it', () => {
    saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 5 } } })
    assert.equal(fs.statSync(operatorFile()).mode & 0o777, 0o600)
    assert.ok(!fs.readdirSync(tmp).some((name) => name.startsWith('.config.yaml')), 'no temporary file survives')
  })

  // The whole of #699's third criterion in one save: an operator edits one row
  // on the settings screen, and the box loses nothing. Not a key nobody named
  // in config.yaml, not a hand override beside it, and not the tracked file.
  test('a save loses no unrelated key, no hand override, and nothing in the tracked file', () => {
    fs.writeFileSync(operatorFile(), 'max_concurrent: 9\nlive_pane_cap: 2\n')
    fs.writeFileSync(localConfigFile(curiaFile), 'dispatch:\n  ready_timeout_s: 90 # not a key the screen writes\n')
    const tracked = fs.readFileSync(curiaFile, 'utf8')

    saveSettings({ ...files(), patch: { dispatch: { poll_interval_s: 30 } } })

    assert.deepEqual(readOperatorConfig(operatorFile()), { max_concurrent: 9, poll_interval_s: 30, live_pane_cap: 2 })
    assert.equal(fs.readFileSync(curiaFile, 'utf8'), tracked)
    // Which is what the daemon then reads: config.yaml on top, the hand
    // override beside it, and the tracked file under both.
    const loaded = loadCuriaConfig(curiaFile, { checkPaths: false })
    assert.equal(loaded.dispatch.poll_interval_s, 30)
    assert.equal(loaded.dispatch.max_concurrent, 9)
    assert.equal(loaded.overseer.live_pane_cap, 2)
    assert.equal(loaded.dispatch.ready_timeout_s, 90)
    assert.equal(loaded.dispatch.claim_login, 'alp82')
  })

  test('a direct edit the contract refuses stops the save and names the line', () => {
    fs.writeFileSync(operatorFile(), 'max_concurrent: lots\n')
    assert.throws(() => saveSettings({ ...files(), patch: { dispatch: { poll_interval_s: 30 } } }), (e) => {
      assert.equal(e.refusal, true)
      assert.match(e.message, /config\.yaml line 1: `max_concurrent` must be a positive whole number \(got lots\)/)
      assert.match(e.message, /fix config\.yaml on the box/)
      return true
    })
    assert.equal(readOr(operatorFile()), 'max_concurrent: lots\n', 'the edit is left for the operator, not rewritten')
  })

  test('the watch list replaces whole', () => {
    saveSettings({ ...files(), patch: { watch: [{ repo: 'o/second' }, { repo: 'o/first' }] } })
    assert.deepEqual(readOperatorConfig(operatorFile()).watch, [
      { repo: 'o/second', mode: 'auto' }, { repo: 'o/first', mode: 'auto' },
    ])
    assert.deepEqual(loadCuriaConfig(curiaFile, { checkPaths: false }).watch.map((w) => w.repo), ['o/second', 'o/first'])
  })

  test('a non-default mode is written, and `auto` is the absence of the key', () => {
    saveSettings({ ...files(), patch: { watch: [{ repo: 'o/first', mode: 'map' }, { repo: 'o/second' }] } })
    assert.match(readOr(operatorFile()), /- repo: o\/first\n    mode: map\n  - repo: o\/second\n/)
    saveSettings({ ...files(), patch: { watch: [{ repo: 'o/first', mode: 'auto' }, { repo: 'o/second' }] } })
    assert.ok(!readOr(operatorFile()).includes('mode:'), 'auto is the default and is not written')
  })

  test('switching a model off writes one line, and routing.yaml keeps its whole entry', () => {
    const before = fs.readFileSync(routingFile, 'utf8')
    saveSettings({ ...files(), patch: { routing: { models: { sonnet: { active: false } } } } })
    assert.equal(fs.readFileSync(routingFile, 'utf8'), before)
    assert.deepEqual(parse(readOr(overRouting())), { models: { sonnet: { active: false } } })
    const merged = loadRoutingConfig(routingFile)
    assert.equal(merged.models.sonnet.active, false)
    assert.equal(merged.models.sonnet.harness, 'claude', 'the entry merged key by key rather than being replaced')
  })

  test('the routing override says in its own head what it is and that git does not track it', () => {
    saveSettings({ ...files(), patch: { routing: { models: { sonnet: { active: false } } } } })
    const text = readOr(overRouting())
    assert.match(text, /Git does not track it/)
    assert.match(text, /lays over `routing\.yaml`/)
  })

  test('switching it back on removes the override rather than pinning `active: true`', () => {
    saveSettings({ ...files(), patch: { routing: { models: { sonnet: { active: false } } } } })
    saveSettings({ ...files(), patch: { routing: { models: { sonnet: { active: true } } } } })
    assert.equal(readOr(overRouting()), null)
    assert.equal(loadRoutingConfig(routingFile).models.sonnet.active, true)
  })

  test('a model the TRACKED file switches off is turned on by an explicit `active: true`', () => {
    // The one case an absent key cannot express: ON is the tracked file's `false`
    // plus something that says otherwise.
    fs.writeFileSync(routingFile, fs.readFileSync(routingFile, 'utf8')
      .replace('  sonnet:\n', '  sonnet:\n    active: false\n'))
    saveSettings({ ...files(), patch: { routing: { models: { sonnet: { active: true } } } } })
    assert.deepEqual(parse(readOr(overRouting())), { models: { sonnet: { active: true } } })
    assert.equal(loadRoutingConfig(routingFile).models.sonnet.active, true)
  })

  test('a save that changes nothing writes nothing', () => {
    saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 2 } } })
    const before = fs.statSync(operatorFile()).mtimeMs
    const out = saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 2 } } })
    assert.deepEqual(out.written, [])
    assert.equal(fs.statSync(operatorFile()).mtimeMs, before, 'the file did not move')
  })

  test('both files in one save', () => {
    const out = saveSettings({
      ...files(),
      patch: { dispatch: { max_concurrent: 3 }, routing: { defaults: { untyped: 'sonnet' } } },
    })
    assert.deepEqual(out.written.sort(), ['config.yaml', 'routing.local.yaml'])
    assert.equal(loadCuriaConfig(curiaFile, { checkPaths: false }).dispatch.max_concurrent, 3)
    assert.equal(loadRoutingConfig(routingFile).defaults.untyped, 'sonnet')
  })

  test('a routing save preserves the model and ticket-type effort together', () => {
    saveSettings({
      ...files(),
      patch: { routing: { defaults: { research: { model: 'opus', effort: 'max' } } } },
    })
    assert.deepEqual(parse(readOr(overRouting())), {
      defaults: { research: { model: 'opus', effort: 'max' } },
    })
    assert.deepEqual(readSettings(files()).routing.defaults[1], {
      type: 'research', model: 'opus', effort: 'max',
    })
  })

  test('conversation limits save through the same dock patch', () => {
    saveSettings({
      ...files(),
      patch: { dispatch: { messages_per_send: 3 }, overseer: { live_pane_cap: 5 } },
    })
    assert.deepEqual(readOperatorConfig(operatorFile()), { messages_per_send: 3, live_pane_cap: 5 })
    const read = readSettings(files())
    assert.equal(read.dispatch.messages_per_send, 3)
    assert.equal(read.overseer.live_pane_cap, 5)
  })

  test('the screen reads the layers merged, and says where a save lands', () => {
    saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 5 } } })
    const s = readSettings(files())
    assert.equal(s.dispatch.max_concurrent, 5)
    assert.equal(s.dispatch.poll_interval_s, 60, 'the tracked file still answers for what config.yaml does not')
    assert.deepEqual(s.files, { curia: curiaFile, routing: routingFile })
    assert.deepEqual(s.writes, { curia: operatorFile(), routing: overRouting() })
    assert.equal(s.operator_error, undefined)
  })

  // #880: under an installation root the daemon answers the app's settings
  // screen, and neither file is beside the tracked one there. Both targets
  // are named, and nothing lands beside the tracked files.
  test('the two files a save lands in can be named, for a root\'s config.yaml and state/routing.local.yaml', () => {
    const operator = path.join(tmp, 'root-config', 'config.yaml')
    const local = path.join(tmp, 'root-state', 'routing.local.yaml')
    fs.mkdirSync(path.dirname(operator))
    fs.mkdirSync(path.dirname(local))
    const named = { ...files(), operatorFile: operator, routingLocalFile: local }
    const out = saveSettings({ ...named, patch: { dispatch: { max_concurrent: 5 }, routing: { models: { sonnet: { active: false } } } } })
    assert.deepEqual(out.written, ['config.yaml', 'routing.local.yaml'])
    assert.equal(readOperatorConfig(operator).max_concurrent, 5)
    assert.equal(fs.statSync(operator).mode & 0o777, 0o600)
    assert.deepEqual(parse(fs.readFileSync(local, 'utf8')), { models: { sonnet: { active: false } } })
    assert.equal(fs.existsSync(operatorFile()), false, 'nothing lands beside the tracked file')
    assert.equal(fs.existsSync(overRouting()), false)
    const s = readSettings(named)
    assert.equal(s.dispatch.max_concurrent, 5)
    assert.equal(s.routing.models.find((m) => m.name === 'sonnet').active, false, 'the read layers the named override')
    assert.deepEqual(s.writes, { curia: operator, routing: local })
    assert.equal(readSettings(files()).dispatch.max_concurrent, 2, 'the default targets read the shipped answer still')
  })

  test('a config.yaml the contract refuses still reads, and the screen is told why', () => {
    fs.writeFileSync(operatorFile(), 'max_concurrent: 5\nwatch: nope\n')
    const s = readSettings(files())
    assert.equal(s.dispatch.max_concurrent, 2, 'the shipped answer, because the file is not one the service will take')
    assert.match(s.operator_error, /config\.yaml line 2: `watch` must be a list/)
  })
})

describe('the daemon\'s own loaders judge the candidate first', () => {
  const refusal = (patch) => {
    const before = {
      curia: fs.readFileSync(curiaFile, 'utf8'),
      routing: fs.readFileSync(routingFile, 'utf8'),
      operator: readOr(operatorFile()),
      overRouting: readOr(overRouting()),
    }
    let err = null
    try { saveSettings({ ...files(), patch }) } catch (e) { err = e }
    assert.ok(err, 'the save was refused')
    assert.equal(err.refusal, true, 'a refusal is the operator\'s config being wrong, not this process failing')
    assert.equal(fs.readFileSync(curiaFile, 'utf8'), before.curia, 'curia.yaml is byte for byte what it was')
    assert.equal(fs.readFileSync(routingFile, 'utf8'), before.routing, 'routing.yaml is byte for byte what it was')
    assert.equal(readOr(operatorFile()), before.operator, 'config.yaml is what it was too')
    assert.equal(readOr(overRouting()), before.overRouting, 'the override is what it was too')
    assert.ok(!fs.readdirSync(tmp).some((name) => name.startsWith('.config.yaml')), 'no temporary file is left behind')
    assert.ok(!fs.existsSync(candidateFor(overRouting())), 'no candidate is left behind')
    return err.message
  }

  test('a rule that belongs to the loader is enforced by the loader, and quotes it', () => {
    // `3 × max_concurrent` against the sandbox port range: a rule this module
    // knows nothing about, and must not have to.
    const msg = refusal({ dispatch: { max_concurrent: 500 } })
    assert.match(msg, /sandbox ports/)
  })

  test('a refusal names both layers, never a candidate beside them', () => {
    const msg = refusal({ dispatch: { max_concurrent: 500 } })
    // Both, because a merged config has two authors and the operator has to
    // know which file holds the line that is wrong.
    assert.match(msg, /curia\.yaml \+ .*config\.yaml/)
    assert.ok(!msg.includes('.tmp'), 'the operator asked about config.yaml, so the answer says that')
  })

  test('a default naming a model that is switched off in the SAME save is refused', () => {
    const msg = refusal({ routing: { defaults: { untyped: 'sonnet' }, models: { sonnet: { active: false } } } })
    assert.match(msg, /active: false/)
  })

  test('a two-file save is never half applied', () => {
    // The curia half is fine and the routing half is not. Neither lands.
    refusal({ dispatch: { max_concurrent: 3 }, routing: { defaults: { untyped: 'nosuchmodel' } } })
  })
})

describe('the patch is a closed set', () => {
  const refused = (patch, re) => {
    assert.throws(() => saveSettings({ ...files(), patch }), (e) => e.refusal && re.test(e.message), String(re))
  }

  test('a key the screen does not write is refused, whatever it is', () => {
    refused({ dispatch: { workspace_root: '/etc' } }, /does not write `dispatch.workspace_root`/)
    refused({ sandbox: { image: 'evil' } }, /does not write `sandbox`/)
    refused({ routing: { harnesses: {} } }, /does not write `routing.harnesses`/)
  })

  test('the prototype count must be a positive whole number, and the contract says so', () => {
    for (const value of [0, 2.5, Infinity]) {
      refused(
        { dispatch: { prototype_variations: value } },
        /`prototype_variations` must be a positive whole number/,
      )
    }
  })

  test('a model patch may say `active` and nothing else', () => {
    refused({ routing: { models: { opus: { provider: 'openai' } } } }, /writes `active` and nothing else/)
  })

  test('an empty watch list is refused before any file is opened', () => {
    refused({ watch: [] }, /`watch` must list at least one/)
  })

  test('a repo that is not owner\/name is refused', () => {
    refused({ watch: [{ repo: 'not a repo' }] }, /`repo` must be `owner\/name`/)
  })

  test('the same repo twice is refused', () => {
    refused({ watch: [{ repo: 'o/first' }, { repo: 'o/first' }] }, /`watch` lists o\/first twice/)
  })

  test('a watch entry key the screen does not write is refused', () => {
    refused({ watch: [{ repo: 'o/first', branch: 'main' }] }, /does not write `watch.branch`/)
  })

  test('a row routing.yaml does not have is not created', () => {
    refused({ routing: { defaults: { grilling: 'opus' } } }, /has no `defaults.grilling` row/)
  })

  test('a model routing.yaml does not have is not created', () => {
    refused({ routing: { models: { haiku: { active: true } } } }, /added by hand, not by a checkbox/)
  })
})

describe('the switch behind "n of m models active" (#265)', () => {
  // Switch one model off in the file, the way a save does.
  const switchOff = (name) => {
    fs.writeFileSync(routingFile, fs.readFileSync(routingFile, 'utf8')
      .replace(`  ${name}:\n`, `  ${name}:\n    active: false\n`))
  }

  test('a fallback chain steps OVER an inactive model and keeps going through it', () => {
    const r = loadRoutingConfig(routingFile)
    assert.deepEqual(candidates(r, 'opus', new Cooling()), ['opus', 'gpt', 'sonnet'])
    r.models.gpt.active = false
    assert.deepEqual(candidates(r, 'opus', new Cooling()), ['opus', 'sonnet'],
      'the chain continues past the model that is off, it does not stop at it')
  })

  test('a chain may still NAME an inactive model — switching one off is not a rewrite of every chain', () => {
    switchOff('sonnet')
    const r = loadRoutingConfig(routingFile)
    assert.deepEqual(r.fallbacks.opus, ['gpt', 'sonnet'], 'the chain is untouched')
    assert.deepEqual(candidates(r, 'opus', new Cooling()), ['opus', 'gpt'])
  })

  test('`review-model:` naming an inactive model refuses, and names the switch', () => {
    switchOff('sonnet')
    const r = loadRoutingConfig(routingFile)
    assert.throws(
      () => resolveReviewer(r, { builderModel: 'gpt', labels: ['review-model:sonnet'], cooling: new Cooling() }),
      /active: false/,
    )
  })

  test('the loader refuses a `defaults` row on a model that is off', () => {
    switchOff('sonnet')
    // sonnet is named by no row yet, so the file still loads.
    assert.equal(loadRoutingConfig(routingFile).models.sonnet.active, false)
    fs.writeFileSync(routingFile, fs.readFileSync(routingFile, 'utf8').replace('  untyped: opus', '  untyped: sonnet'))
    assert.throws(() => loadRoutingConfig(routingFile), /defaults.untyped names "sonnet", which is `active: false`/)
  })

  test('the loader refuses a `review` row on a model that is off', () => {
    // Take gpt off the defaults first, so the row this test is about is the
    // one that refuses.
    fs.writeFileSync(routingFile, fs.readFileSync(routingFile, 'utf8').replace('  research: gpt', '  research: opus'))
    switchOff('gpt')
    assert.throws(() => loadRoutingConfig(routingFile), /review.anthropic names "gpt", which is `active: false`/)
  })

  test('every model off is refused: curia would have nothing to dispatch on', () => {
    const text = fs.readFileSync(routingFile, 'utf8')
      .replace(/harness: claude/g, 'harness: claude\n    active: false')
      .replace('harness: codex', 'harness: codex\n    active: false')
    fs.writeFileSync(routingFile, text)
    assert.throws(() => loadRoutingConfig(routingFile), /every model is `active: false`/)
  })

  test('`active` must be a boolean, so a typo is caught at boot rather than at dispatch', () => {
    fs.writeFileSync(routingFile, fs.readFileSync(routingFile, 'utf8').replace('  sonnet:', '  sonnet:\n    active: "no"'))
    assert.throws(() => loadRoutingConfig(routingFile), /models.sonnet.active must be true or false/)
  })

  test('isActive reads an absent key as on', () => {
    assert.equal(isActive({ models: { a: {} } }, 'a'), true)
    assert.equal(isActive({ models: { a: { active: false } } }, 'a'), false)
  })
})

describe('checkPaths: the sidecar validates what it can actually see (#263\'s rule, inherited)', () => {
  test('with the checks on, a page the daemon must serve has to exist', () => {
    writeCuria(['timeline:', `  index: ${path.join(tmp, 'nope.html')}`])
    assert.throws(() => loadCuriaConfig(curiaFile), /nope\.html, which does not exist/)
  })

  test('with them off, the same file loads — the sidecar mounts none of those paths', () => {
    writeCuria(['timeline:', `  index: ${path.join(tmp, 'nope.html')}`])
    assert.doesNotThrow(() => loadCuriaConfig(curiaFile, { checkPaths: false }))
  })

  test('every OTHER rule still runs with the checks off', () => {
    writeCuria(['timeline:', '  port: 8443'])
    assert.throws(() => loadCuriaConfig(curiaFile, { checkPaths: false }), /every surface needs its own port/)
  })
})

// The closed set (#362). A reload applies the six things this screen writes and
// nothing else, so the question every test below asks is one of two: did this
// edit stay inside the set, and what did it move?
//
// The comparison runs on LOADED configs — the same objects the daemon holds —
// because that is what a reload compares. A hand edit to a key the screen
// cannot write must decline the whole reload and name that key, which is the
// half nobody could see by looking at the settings screen.
describe('the closed set a reload applies (#362)', () => {
  const load = () => ({ curia: loadCuriaConfig(curiaFile), routing: loadRoutingConfig(routingFile) })
  const overCuriaFile = (lines) => fs.writeFileSync(overCuria(), `${lines.join('\n')}\n`)
  const overRoutingFile = (lines) => fs.writeFileSync(overRouting(), `${lines.join('\n')}\n`)
  const frozen = (before, after) => (
    frozenDifference(before.curia, after.curia, LIVE_PATHS.curia)
    ?? frozenDifference(before.routing, after.routing, LIVE_PATHS.routing)
  )

  test('the live settings read in the shape the screen uses', () => {
    const live = liveSettings(load())
    assert.deepEqual(live.dispatch, {
      auto_dispatch: false,
      max_concurrent: 2,
      poll_interval_s: 60,
      prototype_variations: 5,
      messages_per_send: 4,
    })
    assert.deepEqual(live.overseer, { live_pane_cap: 3 })
    assert.deepEqual(live.watch, [{ repo: 'o/first', mode: 'auto' }, { repo: 'o/second', mode: 'auto' }])
    assert.deepEqual(live.routing.defaults, [{ type: 'untyped', model: 'opus' }, { type: 'research', model: 'gpt' }])
    assert.deepEqual(live.routing.models, [
      { name: 'opus', active: true }, { name: 'sonnet', active: true }, { name: 'gpt', active: true },
    ])
    // And the same six the file read draws, so the page compares one shape.
    const file = readSettings(files())
    assert.deepEqual(live.dispatch, file.dispatch)
    assert.deepEqual(live.watch, file.watch)
    assert.deepEqual(live.routing.defaults, file.routing.defaults)
  })

  test('a file that says what the daemon runs moves nothing and declines nothing', () => {
    const before = load()
    assert.equal(frozen(before, load()), null)
    assert.deepEqual(liveDiff(liveSettings(before), liveSettings(load())), [])
  })

  for (const [what, write, moved] of [
    ['a dispatch number', () => overCuriaFile(['dispatch:', '  max_concurrent: 5']), ['dispatch.max_concurrent']],
    ['the switch', () => overCuriaFile(['dispatch:', '  auto_dispatch: true']), ['dispatch.auto_dispatch']],
    ['the tick', () => overCuriaFile(['dispatch:', '  poll_interval_s: 15']), ['dispatch.poll_interval_s']],
    ['the prototype count', () => overCuriaFile(['dispatch:', '  prototype_variations: 7']), ['dispatch.prototype_variations']],
    ['the message limit', () => overCuriaFile(['dispatch:', '  messages_per_send: 3']), ['dispatch.messages_per_send']],
    ['the live pane cap', () => overCuriaFile(['overseer:', '  live_pane_cap: 5']), ['overseer.live_pane_cap']],
    ['the watch list', () => overCuriaFile(['watch:', '  - repo: o/first', '  - repo: o/third']), ['watch']],
    ['a routing default', () => overRoutingFile(['defaults:', '  untyped: sonnet']), ['routing.defaults.untyped']],
    ['a model switch', () => overRoutingFile(['models:', '  sonnet:', '    active: false']), ['routing.models.sonnet.active']],
  ]) {
    test(`${what} is inside the set, and the reload names it`, () => {
      const before = load()
      write()
      const after = load()
      assert.equal(frozen(before, after), null, 'nothing outside the six moved, so the reload applies')
      assert.deepEqual(liveDiff(liveSettings(before), liveSettings(after)), moved)
    })
  }

  for (const [what, write, key] of [
    ['a dispatch key the screen does not write', () => overCuriaFile(['dispatch:', '  ready_timeout_s: 90']), 'dispatch.ready_timeout_s'],
    ['a port', () => overCuriaFile(['attach:', '  ttyd_port: 7999']), 'attach.ttyd_port'],
    ['the sandbox image', () => overCuriaFile(['sandbox:', '  image: something-else']), 'sandbox.image'],
    ['the identity allowlist', () => overCuriaFile(['identity:', '  allow: [someone@example.com]']), 'identity.allow'],
    ['a model the routing table did not have', () => overRoutingFile(['models:', '  haiku:', '    provider: anthropic', '    harness: claude']), 'models.haiku'],
    ['a model key that is not the switch', () => overRoutingFile(['models:', '  sonnet:', '    provider: openai', '    harness: codex']), 'models.sonnet.provider'],
    // The screen edits the rows that are there and adds none, so a row that
    // appears is a hand edit — outside the set like every other hand edit.
    ['a defaults row nobody could add from the screen', () => overRoutingFile(['defaults:', '  grilling: opus']), 'defaults.grilling'],
    ['the cross-check pairing', () => overRoutingFile(['review:', '  openai: sonnet']), 'review.openai'],
  ]) {
    test(`${what} is outside it, and the reload declines naming that key`, () => {
      const before = load()
      write()
      assert.equal(frozen(before, load()), key)
    })
  }

  test('the first differing key is named, not the last', () => {
    const before = load()
    overCuriaFile(['dispatch:', '  max_concurrent: 5', '  ready_timeout_s: 90'])
    assert.equal(frozen(before, load()), 'dispatch.ready_timeout_s', 'the reloadable half is blanked, the rest is the answer')
  })
})

describe('the shipped config files are in the form a save prints back', () => {
  // A save re-prints the whole document. The document API keeps every comment
  // and does NOT keep the column a trailing comment sits in, so a file with
  // hand-aligned comments would be reflowed whole by the first save from the
  // dashboard — a diff nobody asked for, on a file the box also tracks in git.
  // Both files are committed in the printed form, and this holds them there.
  for (const name of ['curia.yaml', 'routing.yaml']) {
    test(`${name} round-trips byte for byte`, () => {
      const file = path.join(SHIPPED, name)
      const text = fs.readFileSync(file, 'utf8')
      assert.equal(parseDocument(text).toString(PRINT_OPTS), text,
        `config/${name} is not in the printed form, so the next save from the dashboard would reflow it. `
        + 'Trailing comments take exactly one space before the #, and a comment block belongs above its key, not after it.')
    })
  }
})

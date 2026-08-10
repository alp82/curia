// The settings write (#265), building item 5 of the where-it-lives decision
// (#249): the sidecar edits the two yaml files, the daemon's own loaders judge
// the candidate, and the write is atomic.
//
// What is pinned here is the half a human looking at the preview cannot check.
// A screenshot shows a number in a box. It does not show that the comment three
// lines above it survived, that a refused save left the file byte for byte as
// it was, that a two-file save is never half applied, or that the candidate the
// loaders passed is the exact bytes that landed.
//
// The last suite pins the shipped config files themselves. They are committed
// in the form the document API prints back unchanged, which is what makes a
// save from the dashboard a diff of the lines it changed instead of a reflow of
// the whole file.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

import { readSettings, saveSettings, candidateFor, PRINT_OPTS } from '../src/settings.mjs'
import { loadCuriaConfig, loadRoutingConfig } from '../src/config.mjs'
import { candidates, isActive, resolveReviewer, Cooling } from '../src/routing.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SHIPPED = path.resolve(DIR, '..', '..', 'config')

let tmp
let curiaFile
let routingFile
const files = () => ({ curiaFile, routingFile })

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
    `  workspace_root: ${path.join(tmp, 'work')}`,
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
    "    ready: 'bypass permissions'",
    '    tool_channel_grace_s: 15',
    '  codex:',
    '    template: codex --model {model} "$(cat {prompt_file})"',
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
  test('it names the three dispatch keys, the watch list and the routing tables', () => {
    const s = readSettings(files())
    assert.deepEqual(s.dispatch, { auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60 })
    assert.deepEqual(s.watch, [{ repo: 'o/first', mode: 'auto' }, { repo: 'o/second', mode: 'auto' }])
    assert.deepEqual(s.routing.defaults, [{ type: 'untyped', model: 'opus' }, { type: 'research', model: 'gpt' }])
    assert.deepEqual(s.routing.models.map((m) => m.name), ['opus', 'sonnet', 'gpt'])
    assert.equal(s.routing.models.find((m) => m.name === 'gpt').id, 'gpt-5.6-sol')
  })

  test('a model with no `active` key reads as on — a file written before the key routes as it always did', () => {
    assert.ok(readSettings(files()).routing.models.every((m) => m.active))
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

describe('the edit keeps the file a human wrote', () => {
  test('a number changes and every comment around it stays', () => {
    saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 5 } } })
    const after = fs.readFileSync(curiaFile, 'utf8')
    assert.match(after, /max_concurrent: 5/)
    assert.match(after, /# The resource number, not a throughput one\./)
    assert.match(after, /auto_dispatch: false # shipped OFF/)
    assert.match(after, /^# The box config\. Hand-edited\.$/m)
  })

  test('only the changed lines move', () => {
    const before = fs.readFileSync(curiaFile, 'utf8').split('\n')
    saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 5 } } })
    const after = fs.readFileSync(curiaFile, 'utf8').split('\n')
    assert.equal(before.length, after.length)
    const moved = before.filter((l, i) => l !== after[i])
    assert.deepEqual(moved, ['  max_concurrent: 2'])
  })

  test('a watch entry that survives keeps the comment written beside it', () => {
    saveSettings({ ...files(), patch: { watch: [{ repo: 'o/second' }, { repo: 'o/first' }] } })
    const after = fs.readFileSync(curiaFile, 'utf8')
    assert.match(after, /- repo: o\/first # the one with the map/)
    assert.ok(after.indexOf('o/second') < after.indexOf('o/first'), 'the list is in the order the screen sent')
  })

  test('a repo that goes takes its comment with it, and a new one arrives plain', () => {
    saveSettings({ ...files(), patch: { watch: [{ repo: 'o/second' }, { repo: 'o/third' }] } })
    const after = fs.readFileSync(curiaFile, 'utf8')
    assert.ok(!after.includes('o/first'))
    assert.ok(!after.includes('the one with the map'))
    assert.match(after, /- repo: o\/third/)
    assert.deepEqual(loadCuriaConfig(curiaFile, { checkPaths: false }).watch.map((w) => w.repo), ['o/second', 'o/third'])
  })

  test('a non-default mode is written, and `auto` is the absence of the key', () => {
    saveSettings({ ...files(), patch: { watch: [{ repo: 'o/first', mode: 'map' }, { repo: 'o/second' }] } })
    assert.match(fs.readFileSync(curiaFile, 'utf8'), /mode: map/)
    saveSettings({ ...files(), patch: { watch: [{ repo: 'o/first', mode: 'auto' }, { repo: 'o/second' }] } })
    assert.ok(!fs.readFileSync(curiaFile, 'utf8').includes('mode:'))
  })

  test('switching a model off writes one line and leaves its whole entry', () => {
    saveSettings({ ...files(), patch: { routing: { models: { sonnet: { active: false } } } } })
    const after = fs.readFileSync(routingFile, 'utf8')
    assert.match(after, /sonnet:\n {4}provider: anthropic\n {4}harness: claude\n {4}active: false/)
    assert.match(after, /# the label vocabulary is not the CLI vocabulary/)
    assert.equal(loadRoutingConfig(routingFile).models.sonnet.active, false)
  })

  test('switching it back on removes the key rather than writing `active: true`', () => {
    const before = fs.readFileSync(routingFile, 'utf8')
    saveSettings({ ...files(), patch: { routing: { models: { sonnet: { active: false } } } } })
    saveSettings({ ...files(), patch: { routing: { models: { sonnet: { active: true } } } } })
    assert.equal(fs.readFileSync(routingFile, 'utf8'), before, 'the file returns to the shape it had')
  })

  test('a save that changes nothing writes nothing', () => {
    const out = saveSettings({ ...files(), patch: { dispatch: { max_concurrent: 2 } } })
    assert.deepEqual(out.written, [])
  })

  test('both files in one save', () => {
    const out = saveSettings({
      ...files(),
      patch: { dispatch: { max_concurrent: 3 }, routing: { defaults: { untyped: 'sonnet' } } },
    })
    assert.deepEqual(out.written.sort(), ['curia.yaml', 'routing.yaml'])
    assert.equal(loadCuriaConfig(curiaFile, { checkPaths: false }).dispatch.max_concurrent, 3)
    assert.equal(loadRoutingConfig(routingFile).defaults.untyped, 'sonnet')
  })
})

describe('the daemon\'s own loaders judge the candidate first', () => {
  const refusal = (patch) => {
    const before = { curia: fs.readFileSync(curiaFile, 'utf8'), routing: fs.readFileSync(routingFile, 'utf8') }
    let err = null
    try { saveSettings({ ...files(), patch }) } catch (e) { err = e }
    assert.ok(err, 'the save was refused')
    assert.equal(err.refusal, true, 'a refusal is the operator\'s config being wrong, not this process failing')
    assert.equal(fs.readFileSync(curiaFile, 'utf8'), before.curia, 'curia.yaml is byte for byte what it was')
    assert.equal(fs.readFileSync(routingFile, 'utf8'), before.routing, 'routing.yaml is byte for byte what it was')
    assert.ok(!fs.existsSync(candidateFor(curiaFile)), 'no candidate is left behind')
    assert.ok(!fs.existsSync(candidateFor(routingFile)), 'no candidate is left behind')
    return err.message
  }

  test('a rule that belongs to the loader is enforced by the loader, and quotes it', () => {
    // `3 × max_concurrent` against the sandbox port range: a rule this module
    // knows nothing about, and must not have to.
    const msg = refusal({ dispatch: { max_concurrent: 500 } })
    assert.match(msg, /sandbox ports/)
  })

  test('a refusal names the real file, never the candidate beside it', () => {
    const msg = refusal({ dispatch: { max_concurrent: 500 } })
    assert.match(msg, /curia\.yaml/)
    assert.ok(!msg.includes('.candidate'), 'the operator asked about curia.yaml, so the answer says curia.yaml')
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

  test('a model patch may say `active` and nothing else', () => {
    refused({ routing: { models: { opus: { provider: 'openai' } } } }, /writes `active` and nothing else/)
  })

  test('an empty watch list is refused before any file is opened', () => {
    refused({ watch: [] }, /watch list cannot be empty/)
  })

  test('a repo that is not owner\/name is refused', () => {
    refused({ watch: [{ repo: 'not a repo' }] }, /is not an `owner\/name` repo/)
  })

  test('the same repo twice is refused', () => {
    refused({ watch: [{ repo: 'o/first' }, { repo: 'o/first' }] }, /on the watch list twice/)
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

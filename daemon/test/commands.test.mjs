// Red tests for src/commands.mjs, src/attach.mjs's validSessionName, and
// bin/curia-attach.sh (plan.md steps 7, 9, 11; prototype.md #2).
//
// Assumed contract:
//
//   parseCommand(text) -> object | null   (pure)
//     'tickets [repo]'                 -> { verb: 'tickets', repo?: string }
//     'next [repo]'                    -> { verb: 'next', repo?: string }
//     'status'                         -> { verb: 'status' }
//     'start <n> [model=x]'            -> { verb: 'start', ticket, model? }
//     'start <owner>/<repo>#<n> [model=x]'
//                                       -> { verb: 'start', repo, ticket, model? }
//       (field-notes contract 6: the repo-qualified form, needed so a user
//       can satisfy the ambiguity-refusal path's recommended qualified
//       `owner/repo#n` reply -- plan.md step 8's `start`.)
//     'map <n> [model=x] [-- <instruction>]'
//                                       -> { verb: 'map', ticket, model?, instruction? }
//       (#221: charting's own verb. `start` no longer means charting on a map
//       number, so the instruction moved off it with the meaning.)
//     'cancel <n>' | 'cancel all'      -> { verb: 'cancel', ticket } | { verb: 'cancel', all: true }
//     'resume <n> [model=x]'           -> { verb: 'resume', ticket, model? }
//     'resume all'                     -> { verb: 'resume', all: true }
//     'attach <n>'                     -> { verb: 'attach', ticket }
//     anything else                    -> null
//
//   class CommandRouter({ dispatcher, attach, log })
//     handle(canonical, userId) -> Promise<string>  (Discord-markdown reply)
//     #177 removed `harness=` from this surface: the harness is a function of
//     the model, so every value the router could have accepted was either the
//     model's own harness or a spawn that dies at the composer. The parse fails
//     and the reply names the rule.
//
//   validSessionName(s) -- exported by src/attach.mjs, the SAME regex as the
//   wrapper script: ^curia-[A-Za-z0-9._-]+$ (prototype.md #2, exact shape).
//
//   bin/curia-attach.sh -- the ttyd wrapper, whitelist ^curia-[A-Za-z0-9._-]+$,
//   mode 755. Refuses anything not matching with exit 1 (after `sleep 3`,
//   prototype.md #2 -- these tests only assert the exit code, not the delay).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCommand, actionForCommand, CommandRouter } from '../src/commands.mjs'
import { expandCommand } from '../src/bridge.mjs'
import { validSessionName } from '../src/attach.mjs'
import { lintReply } from '../src/messaging.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const WRAPPER = path.join(DIR, '..', 'bin', 'curia-attach.sh')

describe('parseCommand', () => {
  test('tickets with no repo', () => {
    const c = parseCommand('tickets')
    assert.equal(c.verb, 'tickets')
    assert.equal(c.repo, undefined)
  })

  test('tickets with a repo argument, full or fuzzy', () => {
    assert.deepEqual(parseCommand('tickets alp82/curia'), { verb: 'tickets', repo: 'alp82/curia' })
    assert.deepEqual(parseCommand('tickets cur'), { verb: 'tickets', repo: 'cur' })
  })

  test('the old frontier verb no longer parses', () => {
    assert.equal(parseCommand('frontier'), null)
  })

  test('next with and without a repo argument', () => {
    assert.deepEqual(parseCommand('next'), { verb: 'next' })
    assert.deepEqual(parseCommand('next cur'), { verb: 'next', repo: 'cur' })
  })

  test('cancel all and resume all parse as bulk verbs', () => {
    assert.deepEqual(parseCommand('cancel all'), { verb: 'cancel', all: true })
    assert.deepEqual(parseCommand('resume all'), { verb: 'resume', all: true })
  })

  test('resume with a ticket', () => {
    assert.deepEqual(parseCommand('resume 42'), { verb: 'resume', ticket: '42' })
  })

  // #177: resume inherits the model of the dead agent, and this is the way out.
  test('resume takes the model override start takes', () => {
    assert.deepEqual(parseCommand('resume 42 model=gpt'), { verb: 'resume', ticket: '42', model: 'gpt' })
  })

  // One model over every surviving worktree would overwrite each ticket's own
  // inherited model with a single guess.
  test('resume all takes no model', () => {
    assert.equal(parseCommand('resume all model=gpt'), null)
  })

  test('resume takes no harness either', () => {
    assert.equal(parseCommand('resume 42 harness=codex'), null)
  })

  // #177: the harness follows the model. `start 5 model=opus harness=codex`
  // built `codex --model opus`, which is not a model, and the spawn died at the
  // composer; every value that did NOT contradict the model was a no-op.
  test('start refuses harness=, whether it contradicts the model or agrees with it', () => {
    assert.equal(parseCommand('start 42 model=opus harness=codex'), null)
    assert.equal(parseCommand('start 42 model=opus harness=claude'), null)
    assert.equal(parseCommand('start 42 harness=codex'), null)
  })

  test('status', () => {
    assert.equal(parseCommand('status').verb, 'status')
  })

  test('model names one active ticket and one target routing label', () => {
    assert.deepEqual(parseCommand('model 42 gpt'), {
      verb: 'model', ticket: '42', model: 'gpt',
    })
    assert.equal(parseCommand('model 42'), null)
    assert.equal(parseCommand('model 42 gpt extra'), null)
  })

  test('start with just a ticket', () => {
    const c = parseCommand('start 42')
    assert.equal(c.verb, 'start')
    assert.equal(c.ticket, '42')
    assert.equal(c.model, undefined)
    assert.equal(c.harness, undefined)
  })

  test('start with a model override', () => {
    const c = parseCommand('start 42 model=opus')
    assert.equal(c.verb, 'start')
    assert.equal(c.ticket, '42')
    assert.equal(c.model, 'opus')
    assert.equal(c.harness, undefined)
  })

  // field-notes contract 6: the repo-qualified start form -- required so the
  // ambiguity-refusal path's recommended `owner/repo#n` reply is actually
  // satisfiable by the user typing it back.
  test('start with a repo-qualified ticket', () => {
    const c = parseCommand('start alp82/curia#42')
    assert.equal(c.verb, 'start')
    assert.equal(c.repo, 'alp82/curia')
    assert.equal(c.ticket, '42')
  })

  // the overseer's start tool composes `start <repo>#<n>` from its fuzzy repo
  // field (canonicalFor), so the parser must accept the unslashed form too --
  // found live in the #96 rehearsal, where `start alperortac#91` was refused.
  test('start with a fuzzy repo-qualified ticket', () => {
    const c = parseCommand('start alperortac#42')
    assert.equal(c.verb, 'start')
    assert.equal(c.repoArg, 'alperortac')
    assert.equal(c.repo, undefined)
    assert.equal(c.ticket, '42')
  })

  test('start with a fuzzy repo keeps the model option', () => {
    const c = parseCommand('start alperortac#42 model=opus')
    assert.equal(c.repoArg, 'alperortac')
    assert.equal(c.model, 'opus')
  })

  // #221: `start` carries NO instruction. It stopped meaning charting, so the
  // one argument that was a whole sentence went with the meaning.
  test('start refuses an instruction', () => {
    assert.equal(parseCommand('start 147 -- update the landing page map so that X'), null)
    assert.equal(parseCommand('start 147 model=opus -- do X'), null)
  })

  test('the refusal names the verb that does take one, like harness= does', async () => {
    const router = new CommandRouter({
      dispatcher: { routing: { harnesses: {} }, config: { watch: [] } },
      attach: {},
      log: () => {},
    })
    const reply = await router.handle('start 147 -- update the map', 'user-1')
    assert.match(reply, /`start` carries no instruction/)
    assert.match(reply, /map <n> <sentence>/)
  })

  test('a bare -- inside a longer start line is still refused, not silently dropped', () => {
    // The dangerous shape: parsing this as `start 147` would dispatch a ticket
    // and throw the operator's sentence away with no word said.
    assert.equal(parseCommand('start cur#147 model=opus -- add a ticket'), null)
  })

  // #160's instruction, moved to `map` by #221. Every other argument on this
  // seam is one whitespace-free token, because the seam is a line that gets
  // split on whitespace — a whole operator sentence needs a boundary, and `--`
  // is it.
  test('map carries a free-text instruction after a bare --', () => {
    const c = parseCommand('map 147 -- update the landing page map so that X')
    assert.equal(c.verb, 'map')
    assert.equal(c.ticket, '147')
    assert.equal(c.instruction, 'update the landing page map so that X')
  })

  test('the instruction sits after the options, and takes everything to the end', () => {
    const c = parseCommand('map cur#147 model=opus -- add a ticket, then wire it -- and say so')
    assert.equal(c.verb, 'map')
    assert.equal(c.repoArg, 'cur')
    assert.equal(c.model, 'opus')
    // from the FIRST `--` onward, so a sentence carrying one survives the round
    // trip through canonicalFor unchanged
    assert.equal(c.instruction, 'add a ticket, then wire it -- and say so')
  })

  test('map takes the same issue-reference forms start takes', () => {
    // One parser behind both verbs (#221): the repo-qualified forms the
    // ambiguity refusals recommend by name have to parse back on either.
    assert.equal(parseCommand('map alp82/curia#147').repo, 'alp82/curia')
    assert.equal(parseCommand('map alp82/curia#147').ticket, '147')
    assert.equal(parseCommand('map cur#147').repoArg, 'cur')
    assert.equal(parseCommand('map 147 model=opus').model, 'opus')
    assert.equal(parseCommand('map'), null)
    // #255: one word with no number reaches the router as a candidate repo,
    // not as a refusal. The router rules what it is — a repo with no brief, or
    // a one-word brief.
    assert.equal(parseCommand('map banana').repoWord, 'banana')
  })

  test('a map with no -- carries no instruction at all', () => {
    // The agent then opens with the "what should change?" escalation (#160).
    assert.equal(parseCommand('map 147').instruction, undefined)
    assert.equal(parseCommand('map 147 model=opus').instruction, undefined)
  })

  test('a bare -- with nothing after it is refused, not read as an empty instruction', () => {
    // It would silently dispatch the "what should change?" escalation the
    // operator was trying to skip.
    assert.equal(parseCommand('map 147 --'), null)
    assert.equal(parseCommand('map 147 --   '), null)
  })

  test('an option AFTER the -- is instruction text, not a refused option', () => {
    const c = parseCommand('map 147 -- use model=opus wording in the note')
    assert.equal(c.model, undefined)
    assert.equal(c.instruction, 'use model=opus wording in the note')
  })

  // ---- #255: the `--` is retired on both shapes -----------------------------
  //
  // The 2026-08-06 incident: `map 147 <sentence>` was refused three times in
  // four minutes and nobody could act on the refusal. The operator wants no
  // `--` anywhere, so the options come first and the sentence runs to the end
  // of the line. A line that still carries one parses to the same command.

  test('map takes the sentence with no -- at all', () => {
    const c = parseCommand('map 147 new ticket to make the map ticket param optional')
    assert.equal(c.verb, 'map')
    assert.equal(c.ticket, '147')
    assert.equal(c.instruction, 'new ticket to make the map ticket param optional')
  })

  test('the options still come first, with or without the --', () => {
    const c = parseCommand('map cur#147 model=opus add a ticket for X')
    assert.equal(c.repoArg, 'cur')
    assert.equal(c.model, 'opus')
    assert.equal(c.instruction, 'add a ticket for X')
    // and an option-shaped word inside the sentence stays sentence, exactly as
    // it does after a `--`
    assert.equal(parseCommand('map 147 use model=opus wording').model, undefined)
    assert.equal(parseCommand('map 147 use model=opus wording').instruction, 'use model=opus wording')
  })

  test('a retired -- is still read, so a line in flight parses to the same command', () => {
    for (const [text, instruction] of [
      ['map 147 -- add a ticket for X', 'add a ticket for X'],
      ['map 147 model=opus -- add a ticket for X', 'add a ticket for X'],
      ['map 147 -- add one, then wire it -- and say so', 'add one, then wire it -- and say so'],
    ]) {
      assert.equal(parseCommand(text).instruction, instruction)
    }
    assert.equal(parseCommand('map 147').instruction, undefined)
    assert.equal(parseCommand('map 147 --'), null)
  })

  test('a new map needs no -- either — the first word may be the repo', () => {
    // The parser cannot tell a repo from the first word of the brief, so it
    // marks the candidate and the ROUTER rules (see #chartNew).
    const c = parseCommand('map curia chart a map for the next feature')
    assert.equal(c.verb, 'map')
    assert.equal(c.ticket, undefined)
    assert.equal(c.repoWord, 'curia')
    assert.equal(c.instruction, 'chart a map for the next feature')
    // and a sentence that opens with a plain word marks that word all the same
    assert.equal(parseCommand('map chart a map for the next feature').repoWord, 'chart')
    assert.equal(parseCommand('map chart a map for the next feature').instruction, 'a map for the next feature')
  })

  test('start still takes no instruction, with or without the --', () => {
    assert.equal(parseCommand('start 147 add a ticket for X'), null)
    assert.equal(parseCommand('start 147 -- add a ticket for X'), null)
  })

  test('the instruction reaches the dispatcher, on chart and never on start', async () => {
    const seen = []
    const router = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }] },
        start: async (ticket, opts) => { seen.push({ verb: 'start', ticket, ...opts }); return 'ok' },
        chart: async (ticket, opts) => { seen.push({ verb: 'map', ticket, ...opts }); return 'ok' },
      },
      attach: {},
      log: () => {},
    })
    await router.handle('map 147 -- chart the cooling signal', 'user-1')
    assert.equal(seen[0].verb, 'map')
    assert.equal(seen[0].ticket, '147')
    assert.equal(seen[0].instruction, 'chart the cooling signal')
    await router.handle('start 147', 'user-1')
    assert.equal(seen[1].verb, 'start')
    assert.equal(seen[1].instruction, undefined)
  })

  test('map resolves a fuzzy repo through the same matcher start uses', async () => {
    const seen = []
    const router = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }] },
        chart: async (ticket, opts) => { seen.push({ ticket, ...opts }); return 'ok' },
      },
      attach: {},
      log: () => {},
    })
    await router.handle('map cur#147 -- do X', 'user-1')
    assert.equal(seen[0].repo, 'alp82/curia')
    const reply = await router.handle('map nope#147', 'user-1')
    assert.match(reply, /no watched repo matches/)
  })

  // ---- `map` with no issue: chart a NEW map from prose (#241) ----------------
  //
  // The second shape of one verb. It carries no issue reference because the
  // issue does not exist yet, so the sentence is the whole input — and that is
  // why it is mandatory here where `map <n>` makes it optional.

  test('map with no issue parses the prose as the instruction', () => {
    const c = parseCommand('map create new map for next feature. Read direction.md first')
    assert.equal(c.verb, 'map')
    assert.equal(c.ticket, undefined)
    assert.equal(c.instruction, 'new map for next feature. Read direction.md first')
    assert.equal(c.repoWord, 'create')
    // the retired form parses to the same command, first word and all
    const old = parseCommand('map -- create new map for next feature. Read direction.md first')
    assert.equal(old.repoWord, undefined)
    assert.equal(old.instruction, 'create new map for next feature. Read direction.md first')
  })

  test('a new map takes an optional repo and an optional model, in that shape', () => {
    const c = parseCommand('map alp82/curia model=opus chart the next feature')
    assert.equal(c.repoWord, 'alp82/curia')
    assert.equal(c.model, 'opus')
    assert.equal(c.ticket, undefined)
    assert.equal(c.instruction, 'chart the next feature')
  })

  test('the instruction is MANDATORY with no issue — a bare map is refused', () => {
    // On an existing map a missing sentence means "ask me what should change"
    // (#160). With no map there is nothing to ask about, so this is a refusal.
    assert.equal(parseCommand('map'), null)
    assert.equal(parseCommand('map --'), null)
    assert.equal(parseCommand('map model=opus'), null)
    // #255: one word alone reaches the router, which refuses it when the word
    // is a repo and nothing is left to chart (see the router test below).
    assert.equal(parseCommand('map alp82/curia').instruction, '')
  })

  test('a number in front is the OTHER shape, never a repo called 147', () => {
    // `map 147 x` must keep parsing as an update of map 147. A number that fell
    // through to the new-map parser would chart into a repo named "147".
    assert.equal(parseCommand('map 147 do X').ticket, '147')
    assert.equal(parseCommand('map 12 34 do X').ticket, '12')
    assert.equal(parseCommand('map 12 34 do X').instruction, '34 do X')
    // and a numbered line that fails the first shape does not become a new map
    assert.equal(parseCommand('map 147 --'), null)
    assert.equal(parseCommand('map cur#147 --'), null)
  })

  test('one repo word and one model, never two models', () => {
    // #255: a second repo-shaped word is just the first word of the sentence.
    assert.equal(parseCommand('map cur other do X').repoWord, 'cur')
    assert.equal(parseCommand('map cur other do X').instruction, 'other do X')
    assert.equal(parseCommand('map model=opus model=gpt do X'), null)
  })

  test('the refusal for a broken map names BOTH shapes', async () => {
    const router = new CommandRouter({
      dispatcher: { routing: { harnesses: { claude: {} } }, config: { watch: [{ repo: 'alp82/curia' }] } },
      attach: {},
      log: () => {},
    })
    const reply = await router.handle('map', 'user-1')
    assert.match(reply, /map <n>/)
    assert.match(reply, /map \[repo\]/)
  })

  // #255: the refusal already comes back to the overseer as its own tool
  // result. What it could not act on was the wording — a canonical line the
  // model never wrote, under a usage catalogue for a surface it cannot type on.
  test('an interpreted refusal names the seam and the fields, not the operator catalogue', async () => {
    const router = new CommandRouter({
      dispatcher: { routing: { harnesses: { claude: {} } }, config: { watch: [{ repo: 'alp82/curia' }] } },
      attach: {},
      log: () => {},
    })
    const reply = await router.handle('map', 'overseer', { interpreted: true })
    assert.match(reply, /your own tool call/)
    assert.match(reply, /`ticket`/)
    assert.match(reply, /`instruction`/)
    // the shape its arguments must compose to survives; the typed catalogue does not
    assert.match(reply, /map \[repo\]/)
    assert.doesNotMatch(reply, /^commands:$/m)
    // and a typed refusal is unchanged
    assert.match(await router.handle('map', 'user-1'), /^commands:$/m)
  })

  test('a new map with one watched repo needs no repo token', async () => {
    const seen = []
    const router = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }] },
        chartNew: async (opts) => { seen.push(opts); return 'ok' },
      },
      attach: {},
      log: () => {},
    })
    await router.handle('map chart the next feature', 'user-1')
    assert.equal(seen[0].repo, 'alp82/curia')
    // #255: "chart" is not a watched repo, so it stays the first word
    assert.equal(seen[0].instruction, 'chart the next feature')
  })

  // #255: the first word is the repo when it NAMES a watched repo, and the
  // first word of the brief when it does not. Only the router can rule, so the
  // rule is tested here.
  test('the first word is the repo only when it names a watched one', async () => {
    const seen = []
    const router = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }, { repo: 'alp82/other' }] },
        chartNew: async (opts) => { seen.push(opts); return 'ok' },
      },
      attach: {},
      log: () => {},
    })
    // the name after the slash, and the whole name
    await router.handle('map curia chart the dashboard', 'user-1')
    assert.deepEqual([seen[0].repo, seen[0].instruction], ['alp82/curia', 'chart the dashboard'])
    await router.handle('map alp82/other chart the dashboard', 'user-1')
    assert.deepEqual([seen[1].repo, seen[1].instruction], ['alp82/other', 'chart the dashboard'])
    // a fragment is NOT a name: it would eat the first word of any sentence
    // that happens to sit inside a repo name
    assert.match(await router.handle('map cur chart the dashboard', 'user-1'), /needs one named/)
    assert.equal(seen.length, 2)
  })

  test('a repo word with nothing to chart is refused, not dispatched', async () => {
    const router = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }] },
        chartNew: async () => 'dispatched',
      },
      attach: {},
      log: () => {},
    })
    const reply = await router.handle('map alp82/curia', 'user-1')
    assert.match(reply, /nothing to chart/)
    assert.match(reply, /map \[repo\]/)
  })

  test('a word that names no repo is the brief, even alone', async () => {
    const seen = []
    const router = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }] },
        chartNew: async (opts) => { seen.push(opts); return 'ok' },
      },
      attach: {},
      log: () => {},
    })
    await router.handle('map banana', 'user-1')
    assert.deepEqual([seen[0].repo, seen[0].instruction], ['alp82/curia', 'banana'])
  })

  test('a new map with two watched repos refuses rather than picking one', async () => {
    const router = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }, { repo: 'alp82/other' }] },
        chartNew: async () => 'dispatched',
      },
      attach: {},
      log: () => {},
    })
    const reply = await router.handle('map chart the next feature', 'user-1')
    assert.match(reply, /needs one named/)
    // and the named form it recommends parses back
    const seen = []
    const router2 = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }, { repo: 'alp82/other' }] },
        chartNew: async (opts) => { seen.push(opts); return 'ok' },
      },
      attach: {},
      log: () => {},
    })
    await router2.handle('map alp82/curia chart it', 'user-1')
    assert.equal(seen[0].repo, 'alp82/curia')
    assert.equal(seen[0].instruction, 'chart it')
  })

  test('cancel', () => {
    const c = parseCommand('cancel 42')
    assert.equal(c.verb, 'cancel')
    assert.equal(c.ticket, '42')
  })

  test('attach', () => {
    const c = parseCommand('attach 42')
    assert.equal(c.verb, 'attach')
    assert.equal(c.ticket, '42')
  })

  test('unrecognized text is null', () => {
    assert.equal(parseCommand('banana'), null)
  })

  test('empty text is null', () => {
    assert.equal(parseCommand(''), null)
  })
})

test('a browser credential sign-in reserves one provider and no other', () => {
  assert.deepEqual(actionForCommand('reauth anthropic', 'app-reauth-anthropic'), {
    action_id: 'app-reauth-anthropic',
    kind: 'credential-sign-in',
    target: 'anthropic',
    conflict_key: 'reauth:anthropic',
  })
})

// #177: `harness=` is refused at the command surface now, on every verb that
// used to take it. The refusal has to say WHY — an operator with muscle memory
// reading only "could not parse" would retype it.
describe('CommandRouter harness refusal (#177)', () => {
  const makeRouter = (calls) => new CommandRouter({
    dispatcher: {
      routing: { harnesses: { claude: {}, codex: {} }, models: { opus: { harness: 'claude' } } },
      start: async (...a) => { calls.push(a); return 'started' },
      resume: async (...a) => { calls.push(a); return 'resumed' },
    },
    attach: {},
    log: () => {},
  })

  test('a harness= on start is refused with the rule, and nothing dispatches', async () => {
    const calls = []
    const reply = await makeRouter(calls).handle('start 42 harness=codex', 'user-1')
    assert.equal(calls.length, 0)
    assert.match(reply, /the harness follows the model/)
    assert.match(reply, /routing\.yaml/)
  })

  test('a harness= that AGREES with the model is refused too — it was only ever a no-op', async () => {
    const calls = []
    const reply = await makeRouter(calls).handle('start 42 model=opus harness=claude', 'user-1')
    assert.equal(calls.length, 0)
    assert.match(reply, /the harness follows the model/)
  })

  test('an ordinary parse failure does not mention the harness at all', async () => {
    const reply = await makeRouter([]).handle('banana', 'user-1')
    assert.ok(!/the harness follows the model/.test(reply), reply)
  })

  test('the model override still reaches the dispatcher, on start and on resume', async () => {
    const calls = []
    const router = makeRouter(calls)
    assert.equal(await router.handle('start 42 model=opus', 'user-1'), 'started')
    assert.equal(await router.handle('resume 42 model=opus', 'user-1'), 'resumed')
    assert.equal(calls[0][1].model, 'opus')
    assert.equal(calls[0][1].harness, undefined)
    assert.equal(calls[1][1].model, 'opus')
  })

  // The inheritance lives in the dispatcher, so a bare resume must hand it
  // NOTHING — a router-side default would beat the journal.
  test('a bare resume passes no model, leaving the inheritance to the dispatcher', async () => {
    const calls = []
    assert.equal(await makeRouter(calls).handle('resume 42', 'user-1'), 'resumed')
    assert.equal(calls[0][1].model, undefined)
  })
})

describe('CommandRouter live model switch (#717)', () => {
  test('Discord expands required ticket and model fields into the exact command', () => {
    const values = { ticket: '42', model: 'gpt' }
    const interaction = {
      commandName: 'model',
      options: { getString: (name) => values[name] ?? null },
    }

    assert.equal(expandCommand(interaction), 'model 42 gpt')
  })

  test('the exact model command reaches the dispatcher without a model turn', async () => {
    const calls = []
    const dispatcher = {
      config: { watch: [] },
      routing: { harnesses: {} },
      switchModel: async (ticket, opts) => {
        calls.push({ ticket, ...opts })
        return 'switched'
      },
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })

    assert.equal(await router.handle('model 42 gpt', 'operator-1'), 'switched')
    assert.deepEqual(calls, [{ ticket: '42', model: 'gpt', by: 'operator-1' }])
  })
})

describe('CommandRouter fuzzy repo on start (#96)', () => {
  const makeDispatcher = () => {
    const calls = []
    return {
      calls,
      config: { watch: [{ repo: 'alp82/curia' }, { repo: 'alp82/alperortac.com' }] },
      routing: { harnesses: {} },
      start: async (ticket, opts) => { calls.push({ ticket, repo: opts.repo }); return 'started' },
    }
  }

  test('an unambiguous fuzzy repo resolves to the watched repo before dispatch', async () => {
    const dispatcher = makeDispatcher()
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('start alperortac#42', 'user-1')
    assert.equal(reply, 'started')
    assert.deepEqual(dispatcher.calls, [{ ticket: '42', repo: 'alp82/alperortac.com' }])
  })

  test('an ambiguous fuzzy repo refuses without dispatching', async () => {
    const dispatcher = makeDispatcher()
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('start alp82#42', 'user-1')
    assert.match(reply, /more than one watched repo/)
    assert.equal(dispatcher.calls.length, 0)
  })

  test('a fuzzy repo matching nothing refuses without dispatching', async () => {
    const dispatcher = makeDispatcher()
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('start nosuch#42', 'user-1')
    assert.match(reply, /no watched repo matches/)
    assert.equal(dispatcher.calls.length, 0)
  })
})

describe('CommandRouter grown verbs (#81)', () => {
  const WATCH = { watch: [{ repo: 'alp82/curia' }, { repo: 'alp82/aistack' }] }

  test('a fuzzy repo argument resolves on an unambiguous substring', async () => {
    let seen = null
    const dispatcher = {
      config: WATCH,
      frontier: async (repo) => { seen = repo; return [{ repo, lane: 'map', numbers: [], agentOnly: 0, items: [] }] },
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    await router.handle('tickets cur', 'u')
    assert.equal(seen, 'alp82/curia')
  })

  test('an ambiguous repo argument asks instead of guessing', async () => {
    let called = false
    const dispatcher = { config: WATCH, frontier: async () => { called = true; return [] } }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('tickets alp82', 'u')
    assert.equal(called, false)
    assert.match(reply, /alp82\/curia/)
    assert.match(reply, /alp82\/aistack/)
  })

  test('tickets renders the agent-only chain count and the ticket type', async () => {
    const dispatcher = {
      config: WATCH,
      frontier: async () => [{
        repo: 'alp82/curia', lane: 'map', numbers: [7], agentOnly: 3,
        items: [{ number: 7, title: 'do a thing', labels: ['wayfinder:research'] }],
      }],
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('tickets', 'u')
    assert.match(reply, /3 agent-only runnable/)
    assert.match(reply, /#7 \*\*do a thing\*\*/, 'ticket titles render bold (#95)')
    assert.match(reply, /research/)
  })

  test('a long tickets list clamps to 5 lines per map plus "N more" (#95)', async () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, labels: [] }))
    const dispatcher = {
      config: WATCH,
      frontier: async () => [{ repo: 'alp82/curia', lane: 'map', numbers: [], agentOnly: 0, items }],
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('tickets', 'u')
    assert.match(reply, /-# … 9 more/)
    assert.ok(reply.includes('t5'), 'the first 5 are listed')
    assert.ok(!reply.includes('t6'), 'the tail is cut, not listed')
  })

  test('each map clamps on its own, so a long first map cannot hide the later ones', async () => {
    const mapped = (map, n) => Array.from({ length: n }, (_, i) => ({
      number: map * 100 + i, title: `m${map}-t${i}`, labels: [], map, mapTitle: `map ${map}`,
    }))
    const dispatcher = {
      config: WATCH,
      frontier: async () => [{
        repo: 'alp82/curia', lane: 'map', numbers: [], agentOnly: 0,
        items: [...mapped(1, 8), ...mapped(2, 3)],
      }],
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('tickets', 'u')
    assert.match(reply, /map #1/)
    assert.match(reply, /map #2/)
    assert.match(reply, /-# … 3 more/, 'the first map clamps at 5')
    assert.ok(!reply.includes('m1-t5'), 'the first map\'s tail is cut')
    assert.ok(reply.includes('m2-t2'), 'the second map still shows all 3 tickets')
  })

  test('a repo with nothing takeable is hidden when another repo has tickets', async () => {
    const dispatcher = {
      config: WATCH,
      frontier: async () => [
        { repo: 'alp82/curia', lane: 'map', numbers: [], agentOnly: 0, items: [] },
        {
          repo: 'alp82/aistack', lane: 'map', numbers: [1], agentOnly: 1,
          items: [{ number: 1, title: 'only ticket', labels: [] }],
        },
      ],
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('tickets', 'u')
    assert.ok(!reply.includes('alp82/curia'), 'the empty repo does not render')
    assert.match(reply, /alp82\/aistack/)
    assert.match(reply, /#1 \*\*only ticket\*\*/)
  })

  test('all repos empty says so instead of rendering an empty reply', async () => {
    const dispatcher = {
      config: WATCH,
      frontier: async () => [
        { repo: 'alp82/curia', lane: 'map', numbers: [], agentOnly: 0, items: [] },
        { repo: 'alp82/aistack', lane: 'map', numbers: [], agentOnly: 0, items: [] },
      ],
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('tickets', 'u')
    assert.match(reply, /nothing takeable/)
    assert.match(reply, /alp82\/curia/)
    assert.match(reply, /alp82\/aistack/)
  })

  test('an error row stays visible even though it lists no tickets', async () => {
    const dispatcher = {
      config: WATCH,
      frontier: async () => [
        { repo: 'alp82/curia', error: 'rate limited' },
        { repo: 'alp82/aistack', lane: 'map', numbers: [], agentOnly: 0, items: [] },
      ],
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('tickets', 'u')
    assert.match(reply, /alp82\/curia.*⚠️ rate limited/)
    assert.ok(!reply.includes('alp82/aistack'), 'the empty repo is still hidden')
  })

  test('next hands the resolved repo and the user to the dispatcher', async () => {
    let got = null
    const dispatcher = { config: WATCH, next: async (repo, opts) => { got = { repo, ...opts }; return 'ok' } }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    assert.equal(await router.handle('next aist', 'u1'), 'ok')
    assert.deepEqual(got, { repo: 'alp82/aistack', by: 'u1', threadId: null })
  })

  test('interpreted cancel routes to the confirm path; typed cancel executes (#94)', async () => {
    const calls = []
    const dispatcher = {
      config: WATCH,
      cancel: async () => { calls.push('cancel'); return 'gone' },
      cancelAll: async () => { calls.push('cancelAll'); return 'all gone' },
      requestCancel: async (ticket, { threadId }) => { calls.push(`request:${ticket}@${threadId}`); return 'confirm posted' },
      requestCancelAll: async ({ threadId }) => { calls.push(`requestAll@${threadId}`); return 'bulk confirm posted' },
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    assert.equal(await router.handle('cancel 9', 'overseer', { threadId: 't1', interpreted: true }), 'confirm posted')
    assert.equal(await router.handle('cancel all', 'overseer', { threadId: 't1', interpreted: true }), 'bulk confirm posted')
    assert.equal(await router.handle('cancel 9', 'u'), 'gone')
    assert.equal(await router.handle('cancel all', 'u'), 'all gone')
    assert.deepEqual(calls, ['request:9@t1', 'requestAll@t1', 'cancel', 'cancelAll'])
  })

  test('cancel all and resume all reach the bulk dispatcher verbs', async () => {
    const calls = []
    const dispatcher = {
      config: WATCH,
      cancelAll: async () => { calls.push('cancelAll'); return 'c' },
      resumeAll: async () => { calls.push('resumeAll'); return 'r' },
      cancel: () => { calls.push('cancel'); return '' },
      resume: async () => { calls.push('resume'); return '' },
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    assert.equal(await router.handle('cancel all', 'u'), 'c')
    assert.equal(await router.handle('resume all', 'u'), 'r')
    await router.handle('resume 9', 'u')
    assert.deepEqual(calls, ['cancelAll', 'resumeAll', 'resume'])
  })

  test('status renders waiting-where and the recent endings', async () => {
    const dispatcher = {
      config: WATCH,
      status: async () => ({
        agents: [{
          session: 'curia-5', repo: 'alp82/curia', ticket: '5', model: 'sonnet', state: 'blocked',
          uptime_s: 65, result_received: false, tmux_live: true,
          waiting_on: [{ id: 'esc-1', kind: 'free-text' }],
        }],
        untracked: [],
        recent: [
          { kind: 'cancelled', repo: 'alp82/curia', ticket: '3' },
          { kind: 'finished', repo: 'alp82/curia', ticket: '4' },
        ],
      }),
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('status', 'u')
    assert.match(reply, /waiting on \*\*esc-1\*\* \(free-text\) in the ticket thread/)
    assert.match(reply, /⚰️ cancelled alp82\/curia#3/)
    assert.match(reply, /✅ finished alp82\/curia#4/)
  })

  // #384: the one line in `status` that is not about an agent. A held provider
  // explains a box with nothing running on it, so a box with nothing running
  // still says it.
  test('status names a pre-emptive hold, whether or not an agent is live', async () => {
    const lift = new Date(Date.now() + 75 * 60_000)
    const preCoolings = () => [{ provider: 'anthropic', window: '5h', pct: 93, reset_at: lift.toISOString() }]
    const busy = {
      config: WATCH,
      preCoolings,
      status: async () => ({
        agents: [{ session: 'curia-5', repo: 'alp82/curia', ticket: '5', model: 'gpt', state: 'working', uptime_s: 65, tmux_live: true }],
        untracked: [],
        recent: [],
      }),
    }
    const reply = await new CommandRouter({ dispatcher: busy, attach: {}, log: () => {} }).handle('status', 'u')
    assert.match(reply, /\*\*anthropic\*\* is held before the limit — its 5h window is at 93%/)
    assert.match(reply, new RegExp(`It lifts <t:${Math.floor(lift.getTime() / 1000)}:t>`))
    assert.ok(reply.indexOf('anthropic') < reply.indexOf('curia-5'), 'the lane that stopped explains every row under it')
    assert.deepEqual(lintReply(reply), [], 'the hold speaks the signal set like every other line')

    const idle = { config: WATCH, preCoolings, status: async () => ({ agents: [], untracked: [], recent: [] }) }
    const quiet = await new CommandRouter({ dispatcher: idle, attach: {}, log: () => {} }).handle('status', 'u')
    assert.match(quiet, /no live agents/)
    assert.match(quiet, /is held before the limit/, 'an idle box is the case this line exists for')
  })

  // #444: the second line in `status` that is not about an agent. A ticket the
  // auto loop steps over explains a box with a frontier and nothing running.
  test('status names a ticket the auto loop steps over, and the act that clears it', async () => {
    const box = {
      config: WATCH,
      dispatchHolds: () => [
        { ticket: '444', repo: 'alp82/curia', failures: 2, kind: 'failed-spawn' },
        { ticket: '578', repo: 'alp82/curia', deaths: 2, kind: 'death-resume' },
        { ticket: '574', repo: 'alp82/curia', kind: 'stall-watchdog' },
      ],
      status: async () => ({ agents: [], untracked: [], recent: [] }),
    }
    const reply = await new CommandRouter({ dispatcher: box, attach: {}, log: () => {} }).handle('status', 'u')
    assert.match(reply, /alp82\/curia#444 died at the spawn 2 times, so auto-dispatch steps over it/)
    assert.match(reply, /`start 444` dispatches it again and clears the count/)
    assert.match(reply, /alp82\/curia#578 died after it spoke/)
    assert.match(reply, /automatic resume also died/)
    assert.match(reply, /alp82\/curia#574 needs operator action after automatic stall recovery stopped/)
    assert.match(reply, /`resume 574` to use the surviving worktree/)
    assert.deepEqual(lintReply(reply), [], 'the step-over speaks the signal set like every other line')
  })

  test('router replies conform to the messaging standard (#95)', async () => {
    const dispatcher = {
      config: WATCH,
      frontier: async () => [{
        repo: 'alp82/curia', lane: 'map', numbers: [7], agentOnly: 3,
        items: [{ number: 7, title: 'do a thing', labels: ['wayfinder:research'] }],
      }],
      status: async () => ({
        agents: [{ session: 'curia-5', repo: 'alp82/curia', ticket: '5', model: 'sonnet', state: 'working', uptime_s: 65, tmux_live: true }],
        untracked: ['curia-9'],
        recent: [{ kind: 'cancelled', repo: 'alp82/curia', ticket: '3' }],
      }),
    }
    const attach = { timelineLink: async () => 'https://t.example/5', link: async () => 'https://a.example/5' }
    const router = new CommandRouter({ dispatcher, attach, log: () => {} })
    // `start 5 harness=codex` carries the #177 refusal line on top of the
    // catalogue, so the standard has to hold for it too.
    for (const cmd of ['tickets', 'status', 'attach 5', 'garbage in', 'tickets nomatch', 'start 5 harness=codex']) {
      const reply = await router.handle(cmd, 'u')
      assert.deepEqual(lintReply(reply), [], `\`${cmd}\` reply violates the standard: ${reply}`)
    }
  })
})

describe('validSessionName', () => {
  test('accepts curia-prefixed session names', () => {
    assert.equal(validSessionName('curia-42'), true)
    assert.equal(validSessionName('curia-1.2_3-x'), true)
  })

  test('rejects non-curia and shell-metacharacter-bearing names', () => {
    assert.equal(validSessionName('secret-shell'), false)
    assert.equal(validSessionName('curia-1; rm -rf /'), false)
    assert.equal(validSessionName(''), false)
  })
})

describe('bin/curia-attach.sh', () => {
  test('refuses a non-curia session name with exit 1', () => {
    const result = spawnSync(WRAPPER, ['secret-shell'], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 1)
  })

  test('refuses an injection-shaped argument with exit 1', () => {
    const result = spawnSync(WRAPPER, ['curia-1; rm -rf /'], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 1)
  })
})

// #642: the operator's way back into a dead model credential, with no ssh in it.
describe('reauth', () => {
  test('bare means openai — the one lane whose credential dies on a timer', () => {
    assert.deepEqual(parseCommand('reauth'), { verb: 'reauth', provider: 'openai' })
  })

  // A PROVIDER, not a consumer (#660). One anthropic login serves the claude
  // containers and the overseer both, so there is no consumer to name here.
  test('a named provider is carried through as typed', () => {
    assert.deepEqual(parseCommand('reauth anthropic'), { verb: 'reauth', provider: 'anthropic' })
  })

  test('anything shell-shaped or multi-word refuses', () => {
    assert.equal(parseCommand('reauth openai; rm -rf /'), null)
    assert.equal(parseCommand('reauth one two'), null)
    assert.equal(parseCommand('reauth OpenAI'), null)
  })

  test('the router hands the verb to the dispatcher, provider and all', async () => {
    const seen = []
    const router = new CommandRouter({
      dispatcher: { config: { watch: [] }, startReauth: async (opts) => { seen.push(opts); return '🔑 ok' } },
      attach: {},
      log: () => {},
    })
    assert.equal(await router.handle('reauth', 'u1'), '🔑 ok')
    assert.deepEqual(seen, [{ provider: 'openai', by: 'u1' }])
  })

  // The attach surface is the substrate under the whole flow, and it admits the
  // session name with no whitelist change (#642).
  test('the attach wrapper admits the login session name', () => {
    assert.equal(validSessionName('curia-auth-openai'), true)
  })
})

// Tests for src/overseerverbs.mjs: the one verb catalogue behind both
// transports — canonical text composition, and the handlers that post it to
// the injected command seam. These lived in overseer.test.mjs until #315
// deleted the in-daemon host; the catalogue outlived it, so its tests moved
// here.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, newMapPlan, newTicketPlan } from '../src/commands.mjs'
import { canonicalFor, verbHandlers, VERB_SPECS, VERB_TOOLS } from '../src/overseerverbs.mjs'
import { buildSystemPrompt, ALLOWED_TOOLS } from '../src/overseerprompt.mjs'

// The posture that runs since the cutover (#315): the container holds a shell.
const PROMPT = buildSystemPrompt({ shell: true, checkoutsRoot: '/work/overseer/repos', repos: ['alp82/curia'] })

describe('canonicalFor', () => {
  test('every verb maps to the router grammar', () => {
    assert.equal(canonicalFor('tickets'), 'tickets')
    assert.equal(canonicalFor('tickets', { repo: 'cur' }), 'tickets cur')
    assert.equal(canonicalFor('next'), 'next')
    assert.equal(canonicalFor('next', { repo: 'alp82/curia' }), 'next alp82/curia')
    assert.equal(canonicalFor('status'), 'status')
    assert.equal(
      canonicalFor('ticket_new', { repo: 'alp82/curia', instruction: 'fix the settings save flow' }),
      'ticket alp82/curia fix the settings save flow',
    )
    assert.equal(canonicalFor('start', { ticket: '85' }), 'start 85')
    assert.equal(canonicalFor('start', { ticket: '85', repo: 'alp82/curia' }), 'start alp82/curia#85')
    assert.equal(
      canonicalFor('start', { ticket: '85', model: 'claude-sonnet-5' }),
      'start 85 model=claude-sonnet-5',
    )
    assert.equal(canonicalFor('cancel', { ticket: '85' }), 'cancel 85')
    assert.equal(canonicalFor('cancel', { ticket: 'all' }), 'cancel all')
    assert.equal(canonicalFor('resume', { ticket: '85' }), 'resume 85')
    assert.equal(canonicalFor('resume', { ticket: 'all' }), 'resume all')
    assert.equal(canonicalFor('attach', { ticket: '85' }), 'attach 85')
  })

  // #177. The tool no longer declares a harness field, but the model on the
  // other end of this seam writes the arguments — a hallucinated one must not
  // reach the router as text it refuses.
  test('a harness argument is dropped rather than composed into the text', () => {
    assert.equal(canonicalFor('start', { ticket: '85', model: 'opus', harness: 'codex' }), 'start 85 model=opus')
  })

  test('resume carries the model override, and resume all drops it', () => {
    assert.equal(canonicalFor('resume', { ticket: '85', model: 'gpt' }), 'resume 85 model=gpt')
    assert.equal(canonicalFor('resume', { ticket: 'all', model: 'gpt' }), 'resume all')
  })

  test('an unknown verb throws instead of posting garbage to /command', () => {
    assert.throws(() => canonicalFor('reboot', {}))
  })

  // #160's instruction crosses the same canonical-text seam as every other
  // argument, so the two ends are pinned against each other here and in
  // commands.test.mjs. #221 moved it from `start` to `map`.
  // #255 retired the `--` this used to ride behind: the arguments come first
  // and the sentence runs to the end of the line.
  test('a map instruction rides map last, with no separator', () => {
    assert.equal(
      canonicalFor('map', { ticket: '147', instruction: 'update the map so that X' }),
      'map 147 update the map so that X',
    )
    assert.equal(
      canonicalFor('map', { ticket: '147', repo: 'cur', model: 'opus', instruction: 'add a ticket' }),
      'map cur#147 model=opus add a ticket',
    )
  })

  test('the instruction is collapsed to one line — the seam is one line of text', () => {
    assert.equal(
      canonicalFor('map', { ticket: '147', instruction: '  add a ticket\nthen wire it  ' }),
      'map 147 add a ticket then wire it',
    )
  })

  test('an empty instruction posts nothing after the number', () => {
    assert.equal(canonicalFor('map', { ticket: '147', instruction: '' }), 'map 147')
    assert.equal(canonicalFor('map', { ticket: '147', instruction: '   ' }), 'map 147')
  })

  // #241: the operator says "chart a new map for X" in prose, and the overseer
  // reaches `map` with an instruction and NO ticket. The repo is a bare token
  // here, not the `repo#n` qualifier — there is no n to qualify. #255: on this
  // shape it has to be the repo's own name, because it now sits in front of a
  // plain sentence.
  test('a map with no ticket composes the new-map shape', () => {
    assert.equal(
      canonicalFor('map', { instruction: 'chart the next feature' }),
      'map chart the next feature',
    )
    assert.equal(
      canonicalFor('map', { repo: 'alp82/curia', model: 'opus', instruction: 'chart the next feature' }),
      'map alp82/curia model=opus chart the next feature',
    )
  })

  test('the overseer is told when to reach for the new-map shape', () => {
    // The prose triggers the operator actually uses. A vocabulary the system
    // prompt does not carry is a verb the overseer never picks.
    for (const phrase of ['create a new map', 'chart a new map', 'add a map']) {
      assert.ok(
        PROMPT.toLowerCase().includes(phrase),
        `the system prompt does not teach the phrase "${phrase}"`,
      )
    }
  })

  test('the overseer suggests one ticket for work that fits one session', () => {
    assert.match(PROMPT, /single session/)
    assert.match(PROMPT, /suggest creating a ticket and working on it in this thread/)
    assert.match(PROMPT, /Do not call `ticket_new` until the operator accepts/)
  })

  // #221: `start` no longer charts, so it can no longer carry a sentence. A
  // model that writes one anyway must not produce text the router refuses —
  // the same treatment `harness=` gets above.
  test('an instruction handed to start is dropped, never composed into the text', () => {
    assert.equal(canonicalFor('start', { ticket: '147', instruction: 'update the map' }), 'start 147')
    assert.equal(
      canonicalFor('start', { ticket: '147', model: 'opus', instruction: 'update the map' }),
      'start 147 model=opus',
    )
    assert.ok(parseCommand(canonicalFor('start', { ticket: '147', instruction: 'x' })))
  })

  test('what canonicalFor writes, parseCommand reads back', () => {
    const text = canonicalFor('map', { ticket: '147', model: 'opus', instruction: 'chart the fog -- all of it' })
    assert.deepEqual(parseCommand(text), {
      verb: 'map', ticket: '147', model: 'opus', instruction: 'chart the fog -- all of it',
    })
  })
})

describe('verbHandlers', () => {
  test('the handler set is exactly the allowed-tools list', () => {
    const names = verbHandlers(async () => 'ok').map((h) => `mcp__curia__${h.verb}`)
    assert.deepEqual(names.sort(), [...ALLOWED_TOOLS].sort())
  })

  test('a handler posts canonical text to the seam and wraps the reply', async () => {
    const seen = []
    const handlers = verbHandlers(async (text) => { seen.push(text); return `reply to ${text}` })
    const start = handlers.find((h) => h.verb === 'start')
    const r = await start.handler({ ticket: '85', repo: 'alp82/curia' })
    assert.deepEqual(seen, ['start alp82/curia#85'])
    assert.deepEqual(r, { content: [{ type: 'text', text: 'reply to start alp82/curia#85' }] })
  })

  test('a seam failure surfaces as a rejected handler, not a fake reply', async () => {
    const handlers = verbHandlers(async () => { throw new Error('daemon answered 500') })
    const status = handlers.find((h) => h.verb === 'status')
    await assert.rejects(() => status.handler({}), /daemon answered 500/)
  })
})

// ---- the round trip (#692, ADR-0022) ----------------------------------------
//
// The A-class incidents behind ADR-0022 came from hand-maintained agreement:
// `canonicalFor` and `parseCommand` are two halves of one seam, and only `map`
// and `start` had spot checks. This suite GENERATES a case for every verb in
// the catalogue and every combination of its optional arguments, composes each
// one, parses the text back, and asserts the verb and the fields survived.
//
// A verb added to the catalogue with no sample here fails the coverage test
// rather than going untested, and a field added to a verb fails the same way.
describe('the command round trip, generated (#692)', () => {
  // One watched repo, so the new-map shape's repo ruling has a sole repo to
  // fall back to. `newMapPlan` is that ruling, and the test calls it for the
  // same reason the router does: the parser marks a candidate word and only
  // the watch list says whether it names a repo.
  const WATCHED = ['alp82/curia']

  // One sample per field name. The values are deliberately awkward: the repo
  // is the slashed form the ambiguity refusals recommend, and the instruction
  // carries a retired `--` inside it, which is the token #255 stopped writing
  // and never stopped reading.
  const SAMPLE = {
    ticket: '147',
    repo: 'alp82/curia',
    model: 'opus',
    instruction: 'chart the fog -- all of it',
    name: 'research',
    target: 'alp82/curia#147',
  }

  // The verbs whose ticket field also takes "all". Both shapes are a separate
  // case, because `all` names every agent and the composition drops arguments
  // around it.
  const BULK = { cancel: ['147', 'all'], resume: ['147', 'all'] }

  const subsets = (keys) => keys.reduce(
    (acc, k) => [...acc, ...acc.map((s) => [...s, k])],
    [[]],
  )

  // What the seam DELIBERATELY drops on the way out. A drop is not a round-trip
  // failure: it is the catalogue refusing to compose text the router would
  // refuse, and it belongs in the expectation rather than in an exception.
  const dropped = (verb, args) => {
    // #177: `resume all` takes no model. One model over every surviving
    // worktree would overwrite each ticket's own inherited model.
    if (verb === 'resume' && args.ticket === 'all') return ['model']
    return []
  }

  const cases = []
  for (const spec of VERB_SPECS) {
    const keys = Object.keys(spec.args)
    const optional = keys.filter((k) => spec.args[k].isOptional())
    const required = keys.filter((k) => !optional.includes(k))
    for (const k of keys) {
      assert.ok(k in SAMPLE, `the round trip has no sample value for \`${spec.verb}.${k}\``)
    }
    const tickets = BULK[spec.verb] ?? [SAMPLE.ticket]
    for (const ticket of tickets) {
      for (const chosen of subsets(optional)) {
        const args = {}
        for (const k of required) args[k] = k === 'ticket' ? ticket : SAMPLE[k]
        for (const k of chosen) args[k] = k === 'ticket' ? ticket : SAMPLE[k]
        cases.push({ verb: spec.verb, args })
      }
    }
  }

  test('every verb in the catalogue gets generated cases', () => {
    assert.deepEqual([...new Set(cases.map((c) => c.verb))], [...VERB_TOOLS])
    // The count is stated so a silently emptied powerset cannot pass as
    // coverage: 11 verbs, 33 argument combinations.
    assert.equal(cases.length, 33)
  })

  for (const { verb, args } of cases) {
    const label = `${verb}(${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(', ') || 'no arguments'})`
    test(`${label} composes and parses back`, () => {
      const text = canonicalFor(verb, args)
      const cmd = parseCommand(text)
      assert.ok(cmd, `\`${text}\` is text the router refuses`)

      // The router verb. Both map tools compose the one `map` verb, which is
      // the whole point of splitting the tool rather than the grammar.
      const routerVerb = verb.startsWith('map') ? 'map' : verb === 'ticket_new' ? 'ticket' : verb
      assert.equal(cmd.verb, routerVerb)

      // The new-map shape hands its repo ruling to the router, so the fields
      // are read after that ruling rather than off the raw parse.
      const isNewMap = routerVerb === 'map' && !cmd.ticket
      const isNewTicket = routerVerb === 'ticket'
      const plan = isNewMap
        ? newMapPlan(cmd, WATCHED)
        : isNewTicket ? newTicketPlan(cmd, WATCHED) : null
      assert.ok(!plan?.error, `the new-map ruling refused \`${text}\`: ${plan?.error}`)

      const got = {
        ticket: cmd.all ? 'all' : cmd.ticket,
        repo: plan ? plan.repo : (cmd.repo ?? cmd.repoArg),
        model: cmd.model,
        instruction: plan ? plan.instruction : cmd.instruction,
        name: cmd.name,
        target: cmd.target,
      }
      const gone = dropped(verb, args)
      for (const field of ['ticket', 'repo', 'model', 'instruction', 'name', 'target']) {
        // `map_new` composes no number, so the ticket field is absent by
        // design and the powerset never offers it one.
        const want = gone.includes(field) ? undefined : args[field]
        // The new-map shape with no repo named falls back to the sole watched
        // repo, and that fallback is the router's answer, not a lost field.
        if (field === 'repo' && (isNewMap || isNewTicket) && want === undefined) {
          assert.equal(got.repo, WATCHED[0])
          continue
        }
        assert.equal(got[field], want, `\`${text}\` lost or changed \`${field}\``)
      }
    })
  }
})

// ---- the map tool is two tools (#692, ADR-0022) -----------------------------
//
// The exists-test used to be prose in the standing orders: "the test between
// the two shapes is whether the map EXISTS". A model argued with that prose and
// called the update shape for a map that did not exist yet. It is a schema now,
// so the wrong shape is not a call the model can make.
describe('the map tool is two tools (#692)', () => {
  const spec = (verb) => VERB_SPECS.find((s) => s.verb === verb)

  test('map_update requires a map number, and map_new has no number field', () => {
    assert.ok(!spec('map_update').args.ticket.isOptional(), 'map_update can be called with no map')
    assert.ok(!('ticket' in spec('map_new').args), 'map_new publishes a number field to fill in')
  })

  test('map_new requires the brief, because there is nothing to ask about', () => {
    assert.ok(!spec('map_new').args.instruction.isOptional())
    // On an existing map a missing sentence has a safe meaning: the agent asks
    // what should change. That asymmetry is deliberate (#241).
    assert.ok(spec('map_update').args.instruction.isOptional())
  })

  test('both tools compose the one map router verb', () => {
    assert.equal(
      canonicalFor('map_update', { ticket: '147', instruction: 'add a ticket' }),
      'map 147 add a ticket',
    )
    assert.equal(
      canonicalFor('map_new', { repo: 'alp82/curia', instruction: 'chart the next feature' }),
      'map alp82/curia chart the next feature',
    )
    for (const text of ['map 147 add a ticket', 'map alp82/curia chart the next feature']) {
      assert.equal(parseCommand(text).verb, 'map')
    }
  })

  // A number smuggled through the new-map tool is DROPPED rather than composed,
  // the same treatment a hallucinated `harness=` gets on `start`. Composing it
  // would update a map the operator never named.
  test('a ticket handed to map_new is dropped, never composed into the text', () => {
    assert.equal(
      canonicalFor('map_new', { ticket: '147', instruction: 'chart the next feature' }),
      'map chart the next feature',
    )
  })

  test('the standing orders name both tools and neither the retired one', () => {
    assert.match(PROMPT, /map_update/)
    assert.match(PROMPT, /map_new/)
    assert.ok(!/`map`/.test(PROMPT), 'the standing orders still name a `map` tool that no longer exists')
  })
})

describe('new-ticket tool', () => {
  const spec = () => VERB_SPECS.find((s) => s.verb === 'ticket_new')

  test('requires the complete brief and has no issue-number field', () => {
    assert.ok(!spec().args.instruction.isOptional())
    assert.ok(!('ticket' in spec().args))
  })

  test('composes the numberless ticket command shape', () => {
    assert.equal(
      canonicalFor('ticket_new', { repo: 'alp82/curia', model: 'opus', instruction: 'fix settings' }),
      'ticket alp82/curia model=opus fix settings',
    )
    const cmd = parseCommand('ticket alp82/curia model=opus fix settings')
    assert.equal(cmd.verb, 'ticket')
    assert.deepEqual(newTicketPlan(cmd, ['alp82/curia']), {
      repo: 'alp82/curia', instruction: 'fix settings',
    })
  })
})

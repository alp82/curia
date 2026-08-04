// Red tests for src/commands.mjs, src/attach.mjs's validSessionName, and
// bin/curia-attach.sh (plan.md steps 7, 9, 11; prototype.md #2).
//
// Assumed contract:
//
//   parseCommand(text) -> object | null   (pure)
//     'tickets [repo]'                 -> { verb: 'tickets', repo?: string }
//     'next [repo]'                    -> { verb: 'next', repo?: string }
//     'status'                         -> { verb: 'status' }
//     'start <n> [model=x] [harness=y]'-> { verb: 'start', ticket, model?, harness? }
//     'start <owner>/<repo>#<n> [model=x] [harness=y]'
//                                       -> { verb: 'start', repo, ticket, model?, harness? }
//       (field-notes contract 6: the repo-qualified form, needed so a user
//       can satisfy the ambiguity-refusal path's recommended qualified
//       `owner/repo#n` reply -- plan.md step 8's `start`.)
//     'cancel <n>' | 'cancel all'      -> { verb: 'cancel', ticket } | { verb: 'cancel', all: true }
//     'resume <n>' | 'resume all'      -> { verb: 'resume', ticket } | { verb: 'resume', all: true }
//     'attach <n>'                     -> { verb: 'attach', ticket }
//     anything else                    -> null
//
//   class CommandRouter({ dispatcher, attach, log })
//     handle(canonical, userId) -> Promise<string>  (Discord-markdown reply)
//     dispatcher carries the loaded routing config at dispatcher.routing
//     (mirroring plan.md step 8's Dispatcher constructor) so the router can
//     validate `harness=` without a network round-trip: a value not present
//     in dispatcher.routing.harnesses is refused, naming the configured ones,
//     and dispatcher.start(...) must NOT be called in that case.
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
import { parseCommand, CommandRouter } from '../src/commands.mjs'
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

  test('status', () => {
    assert.equal(parseCommand('status').verb, 'status')
  })

  test('start with just a ticket', () => {
    const c = parseCommand('start 42')
    assert.equal(c.verb, 'start')
    assert.equal(c.ticket, '42')
    assert.equal(c.model, undefined)
    assert.equal(c.harness, undefined)
  })

  test('start with model and harness overrides', () => {
    const c = parseCommand('start 42 model=opus harness=claude')
    assert.equal(c.verb, 'start')
    assert.equal(c.ticket, '42')
    assert.equal(c.model, 'opus')
    assert.equal(c.harness, 'claude')
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

  test('start with a fuzzy repo keeps model and harness options', () => {
    const c = parseCommand('start alperortac#42 model=opus')
    assert.equal(c.repoArg, 'alperortac')
    assert.equal(c.model, 'opus')
  })

  // #160: the map instruction. Every other argument on this seam is one
  // whitespace-free token, because the seam is a line that gets split on
  // whitespace — a whole operator sentence needs a boundary, and `--` is it.
  test('start carries a free-text instruction after a bare --', () => {
    const c = parseCommand('start 147 -- update the landing page map so that X')
    assert.equal(c.verb, 'start')
    assert.equal(c.ticket, '147')
    assert.equal(c.instruction, 'update the landing page map so that X')
  })

  test('the instruction sits after the options, and takes everything to the end', () => {
    const c = parseCommand('start cur#147 model=opus -- add a ticket, then wire it -- and say so')
    assert.equal(c.repoArg, 'cur')
    assert.equal(c.model, 'opus')
    // from the FIRST `--` onward, so a sentence carrying one survives the round
    // trip through canonicalFor unchanged
    assert.equal(c.instruction, 'add a ticket, then wire it -- and say so')
  })

  test('a start with no -- carries no instruction at all', () => {
    assert.equal(parseCommand('start 147').instruction, undefined)
    assert.equal(parseCommand('start 147 model=opus').instruction, undefined)
  })

  test('a bare -- with nothing after it is refused, not read as an empty instruction', () => {
    // It would silently dispatch the "what should change?" escalation the
    // operator was trying to skip.
    assert.equal(parseCommand('start 147 --'), null)
    assert.equal(parseCommand('start 147 --   '), null)
  })

  test('an option AFTER the -- is instruction text, not a refused option', () => {
    const c = parseCommand('start 147 -- use model=opus wording in the note')
    assert.equal(c.model, undefined)
    assert.equal(c.instruction, 'use model=opus wording in the note')
  })

  test('the instruction reaches the dispatcher', async () => {
    const seen = []
    const router = new CommandRouter({
      dispatcher: {
        routing: { harnesses: { claude: {} } },
        config: { watch: [{ repo: 'alp82/curia' }] },
        start: async (ticket, opts) => { seen.push({ ticket, ...opts }); return 'ok' },
      },
      attach: {},
      log: () => {},
    })
    await router.handle('start 147 -- chart the cooling signal', 'user-1')
    assert.equal(seen[0].ticket, '147')
    assert.equal(seen[0].instruction, 'chart the cooling signal')
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

describe('CommandRouter harness refusal', () => {
  test('a harness not in routing.harnesses is refused, naming the configured harnesses, without dispatching', async () => {
    let started = false
    const dispatcher = {
      routing: {
        harnesses: { claude: { template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"', ready: '⏵⏵|bypass permissions', toolChannelGraceS: 15, readyRe: /⏵⏵|bypass permissions/ } },
      },
      start: async () => { started = true },
    }
    const attach = {}
    const router = new CommandRouter({ dispatcher, attach, log: () => {} })

    const reply = await router.handle('start 42 harness=codex', 'user-1')

    assert.equal(started, false)
    assert.match(reply, /claude/) // names the one configured harness
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

  test('a long tickets list clamps to one line per item plus "N more" (#95)', async () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, labels: [] }))
    const dispatcher = {
      config: WATCH,
      frontier: async () => [{ repo: 'alp82/curia', lane: 'map', numbers: [], agentOnly: 0, items }],
    }
    const router = new CommandRouter({ dispatcher, attach: {}, log: () => {} })
    const reply = await router.handle('tickets', 'u')
    assert.match(reply, /-# … 4 more/)
    assert.ok(!reply.includes('t11'), 'the tail is cut, not listed')
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
    for (const cmd of ['tickets', 'status', 'attach 5', 'garbage in', 'tickets nomatch']) {
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

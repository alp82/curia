// Red tests for src/commands.mjs, src/attach.mjs's validSessionName, and
// bin/curia-attach.sh (plan.md steps 7, 9, 11; prototype.md #2).
//
// Assumed contract:
//
//   parseCommand(text) -> object | null   (pure)
//     'frontier [repo]'                -> { verb: 'frontier', repo?: string }
//     'status'                         -> { verb: 'status' }
//     'start <n> [model=x] [backend=y]'-> { verb: 'start', ticket, model?, backend? }
//     'start <owner>/<repo>#<n> [model=x] [backend=y]'
//                                       -> { verb: 'start', repo, ticket, model?, backend? }
//       (field-notes contract 6: the repo-qualified form, needed so a user
//       can satisfy the ambiguity-refusal path's recommended qualified
//       `owner/repo#n` reply -- plan.md step 8's `start`.)
//     'cancel <n>'                     -> { verb: 'cancel', ticket }
//     'attach <n>'                     -> { verb: 'attach', ticket }
//     anything else                    -> null
//
//   class CommandRouter({ dispatcher, attach, log })
//     handle(canonical, userId) -> Promise<string>  (Discord-markdown reply)
//     dispatcher carries the loaded routing config at dispatcher.routing
//     (mirroring plan.md step 8's Dispatcher constructor) so the router can
//     validate `backend=` without a network round-trip: a value not present
//     in dispatcher.routing.backends is refused, naming the configured ones,
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

const DIR = path.dirname(fileURLToPath(import.meta.url))
const WRAPPER = path.join(DIR, '..', 'bin', 'curia-attach.sh')

describe('parseCommand', () => {
  test('frontier with no repo', () => {
    const c = parseCommand('frontier')
    assert.equal(c.verb, 'frontier')
    assert.equal(c.repo, undefined)
  })

  test('frontier with a repo filter', () => {
    const c = parseCommand('frontier alp82/curia')
    assert.equal(c.verb, 'frontier')
    assert.equal(c.repo, 'alp82/curia')
  })

  test('status', () => {
    assert.equal(parseCommand('status').verb, 'status')
  })

  test('start with just a ticket', () => {
    const c = parseCommand('start 42')
    assert.equal(c.verb, 'start')
    assert.equal(c.ticket, '42')
    assert.equal(c.model, undefined)
    assert.equal(c.backend, undefined)
  })

  test('start with model and backend overrides', () => {
    const c = parseCommand('start 42 model=opus backend=claude')
    assert.equal(c.verb, 'start')
    assert.equal(c.ticket, '42')
    assert.equal(c.model, 'opus')
    assert.equal(c.backend, 'claude')
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

describe('CommandRouter backend refusal', () => {
  test('a backend not in routing.backends is refused, naming the configured backends, without dispatching', async () => {
    let started = false
    const dispatcher = {
      routing: {
        backends: { claude: { template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"', ready: '⏵⏵|bypass permissions', readyRe: /⏵⏵|bypass permissions/ } },
      },
      start: async () => { started = true },
    }
    const attach = {}
    const router = new CommandRouter({ dispatcher, attach, log: () => {} })

    const reply = await router.handle('start 42 backend=codex', 'user-1')

    assert.equal(started, false)
    assert.match(reply, /claude/) // names the one configured backend
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

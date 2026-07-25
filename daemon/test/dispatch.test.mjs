// Unit tests for src/dispatch.mjs, driven entirely through the Dispatcher's
// injected `deps` seam — no gh, no git, no tmux, no live box.
//
// Covers the three behaviours the review wave found untested (acceptance N2):
//   1. the in-flight admission guard (criterion 3: one claim per ticket)
//   2. abnormal-exit detection (criterion 4: a result-less exit keeps its pane)
//   3. reconcile epoch scoping (criterion 7: a stale result never masks a dead
//      claim from a LATER dispatch of the same ticket)
// plus the B1 regression: reconcile must destroy nothing when it cannot
// establish who the gh viewer is.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Dispatcher, paneTail, textCarriesLimitPhrase } from '../src/dispatch.mjs'
import { parseUsageLimit } from '../src/routing.mjs'

const ROUTING = {
  defaults: { untyped: 'sonnet' },
  models: { sonnet: { provider: 'anthropic', backend: 'claude' } },
  fallbacks: {},
  backends: { claude: { template: 'claude --model {model} --permission-mode bypassPermissions "$(cat {prompt_file})"' } },
}

const OPEN_ISSUE = {
  number: 42, title: 'a ticket', body: 'body text', state: 'open',
  assignees: [], labels: [],
}

let tmp
let notifies
let events

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-dispatch-test-'))
  fs.mkdirSync(path.join(tmp, 'data', 'results'), { recursive: true })
  notifies = []
  events = []
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// Poll until `cond` holds — for behaviour that completes inside a detached
// continuation (confirm chains, the watchdog) rather than the awaited call.
async function waitFor(cond, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!cond()) throw new Error('waitFor: condition not reached in time')
}

// Deps default to inert doubles; each test overrides only what it asserts on.
function makeDispatcher(deps = {}, { watch = [{ repo: 'o/r', mode: 'auto' }], readyTimeoutS = 45, routing = ROUTING, confirm = async () => false } = {}) {
  const root = path.join(tmp, 'work')
  const config = {
    watch,
    dispatch: {
      auto_dispatch: false, max_concurrent: 2, poll_interval_s: 60,
      workspace_root: root, ready_timeout_s: readyTimeoutS, confirm_ttl_h: 4,
    },
    attach: { ttyd_port: 7681, serve_port: 8443 },
  }
  const store = {
    logEvent: (type, data) => { const rec = { type, ...data }; events.push(rec); return rec },
    openEscalations: () => [],
    cancel: () => ({ ok: true }),
  }
  const base = {
    viewerLogin: async () => 'me',
    repoMaps: async () => [],
    mapFrontier: async () => [],
    flatFrontier: async () => [],
    fetchIssue: async () => ({ ...OPEN_ISSUE }),
    claim: async () => {},
    unclaim: async () => {},
    hasSession: async () => false,
    listSessions: async () => [],
    newSession: async () => {},
    capturePane: async () => '',
    killSession: async () => {},
    ensureBaseClone: async (r, repo) => path.join(r, 'repos', repo.replace('/', '__'), 'base'),
    createWorktree: async (b, n) => path.join(path.dirname(b), 'wt', String(n)),
    removeWorktree: async () => {},
    removeConfigDir: () => {},
    removeCredentials: () => {},
    seedConfigDir: () => {},
    writeHarness: () => {},
    writePrompt: (cfgDir) => path.join(cfgDir, 'prompt.md'),
    ensureTtyd: async () => ({ verified: true }),
    assertServe: async () => {},
    serveOff: async () => {},
  }
  return new Dispatcher({
    config,
    routing,
    store,
    notify: (ticket, message) => notifies.push({ ticket, message }),
    confirm,
    log: () => {},
    dataDir: path.join(tmp, 'data'),
    daemonPort: 4271,
    deps: { ...base, ...deps },
  })
}

const typesOf = () => events.map((e) => e.type)

describe('in-flight admission guard (criterion 3)', () => {
  test('a second start() interleaving with the first is refused, and the ticket is claimed exactly once', async () => {
    let claims = 0
    let spawns = 0
    const d = makeDispatcher({
      claim: async () => { claims += 1 },
      newSession: async () => { spawns += 1 },
    })

    // deliberately NOT awaited: the second call lands while the first is still
    // inside its gh round-trips
    const first = d.start('42', { repo: 'o/r', by: 'test' })
    const secondReply = await d.start('42', { repo: 'o/r', by: 'test' })
    const firstReply = await first

    assert.match(secondReply, /already starting/)
    assert.match(firstReply, /dispatched/)
    assert.equal(claims, 1, 'the ticket must be claimed exactly once')
    assert.equal(spawns, 1, 'exactly one worker must be spawned')
    assert.equal(events.filter((e) => e.type === 'dispatch_claimed').length, 1)
  })

  test('the guard is released after start() settles, so a later start is admitted again', async () => {
    let claims = 0
    const d = makeDispatcher({ claim: async () => { claims += 1 } })
    await d.start('42', { repo: 'o/r' })
    d.workers.delete('curia-42') // simulate the worker having gone away
    const again = await d.start('42', { repo: 'o/r' })
    assert.match(again, /dispatched/)
    assert.equal(claims, 2)
  })
})

describe('abnormal-exit detection (criterion 4)', () => {
  test('worker_done with NO recorded result journals worker_abnormal_exit, notifies, and keeps the session', async () => {
    let killed = null
    const d = makeDispatcher({ killSession: async (name) => { killed = name } })
    d.workers.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready', resultReceived: false })

    await d.onWorkerDone('curia-42')

    assert.ok(typesOf().includes('worker_abnormal_exit'))
    assert.ok(!typesOf().includes('lifecycle_closed'))
    assert.equal(killed, null, 'the pane is the post-mortem evidence — it must NOT be killed')
    assert.equal(d.workers.get('curia-42').state, 'failed')
    assert.match(notifies.at(-1).message, /WITHOUT reporting a result/)
  })

  test('worker_done with a results file on disk journals lifecycle_closed and kills the session', async () => {
    let killed = null
    const d = makeDispatcher({ killSession: async (name) => { killed = name } })
    d.workers.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready', resultReceived: false })
    fs.writeFileSync(path.join(tmp, 'data', 'results', 'curia-42.json'), '{"status":"resolved"}')

    await d.onWorkerDone('curia-42')

    assert.ok(typesOf().includes('lifecycle_closed'))
    assert.ok(!typesOf().includes('worker_abnormal_exit'))
    assert.equal(killed, 'curia-42')
    assert.equal(d.workers.has('curia-42'), false)
  })

  test('onResult alone (no file yet) is enough to make the exit a normal close', async () => {
    let killed = null
    const d = makeDispatcher({ killSession: async (name) => { killed = name } })
    d.workers.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready', resultReceived: false })
    d.onResult('curia-42')

    await d.onWorkerDone('curia-42')

    assert.ok(typesOf().includes('lifecycle_closed'))
    assert.equal(killed, 'curia-42')
  })
})

describe('reconcile epoch scoping (criterion 7)', () => {
  function writeJournal(lines) {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  const assignedToMe = { ...OPEN_ISSUE, assignees: [{ login: 'me' }] }

  test('a result BEFORE the latest dispatch_claimed does not mask the dead claim', async () => {
    const unclaimed = []
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' },
      { type: 'result', worker: 'curia-42', ticket: '42' },
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' },
    ])
    const d = makeDispatcher({
      listSessions: async () => [], // no live session for curia-42
      fetchIssue: async () => ({ ...assignedToMe }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, ['o/r#42'])
    assert.ok(typesOf().includes('dead_claim_released'))
  })

  test('a result AFTER the latest dispatch_claimed closes the epoch — no dead claim', async () => {
    const unclaimed = []
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' },
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' },
      { type: 'result', worker: 'curia-42', ticket: '42' },
    ])
    const d = makeDispatcher({
      listSessions: async () => [],
      fetchIssue: async () => ({ ...assignedToMe }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, [])
    assert.ok(!typesOf().includes('dead_claim_released'))
  })

  test('a live tmux session keeps its claim, whatever the journal says', async () => {
    const unclaimed = []
    writeJournal([{ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' }])
    const d = makeDispatcher({
      listSessions: async () => ['curia-42'],
      fetchIssue: async () => ({ ...assignedToMe }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, [])
    assert.equal(d.workers.get('curia-42').repo, 'o/r') // re-adopted instead
  })
})

describe('the pane is untrusted text (B6)', () => {
  test('narrowing 1: a rendered ticket body scrolled above the tail no longer classifies', () => {
    const pane = [
      '> alp82/curia#42: investigate the limit banner',
      '  Users report a "Claude usage limit reached" message even though',
      '  their weekly quota is untouched. Reproduce and fix.',
      ...Array(20).fill('● reading the banner component…'),
      '  ⏵⏵ bypass permissions on',
    ].join('\n')
    assert.equal(parseUsageLimit(paneTail(pane)), null)
    // the naive whole-pane read is exactly what used to misfire here
    assert.notEqual(parseUsageLimit(pane), null)
  })

  test('a real cap hit at the bottom of the pane still classifies', () => {
    const pane = ['> some ticket', '  body', '', 'Claude usage limit reached | 1800000000'].join('\n')
    const limit = parseUsageLimit(paneTail(pane))
    assert.ok(limit)
    assert.equal(limit.scope, 'provider')
  })

  test('paneTail ignores trailing blank lines when taking the tail', () => {
    const pane = ['keep-me', ...Array(30).fill('x'), '', '', ''].join('\n')
    assert.equal(paneTail(pane, 5).split('\n').length, 5)
    assert.ok(!paneTail(pane, 5).includes('keep-me'))
  })

  test('the composer marker in a rendered ticket body above the tail does not mark the worker ready', async () => {
    // a ticket ABOUT the worker harness renders "bypass permissions" into the
    // pane; scrolled above the tail it must not forge readiness any more than
    // "usage limit reached" may forge a cap hit
    const pane = [
      '> ticket: the harness runs workers with "bypass permissions" on',
      ...Array(25).fill('● thinking…'),
    ].join('\n')
    const d = makeDispatcher({ capturePane: async () => pane }, { readyTimeoutS: 3 })
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => notifies.some((n) => /did not reach a composer/.test(n.message)))
    assert.ok(!typesOf().includes('worker_ready'), 'marker text outside the tail must not mark ready')
  })

  test('textCarriesLimitPhrase spots a ticket that can forge the signal', () => {
    assert.equal(textCarriesLimitPhrase('fix the banner', 'shows "usage limit reached" wrongly'), true)
    assert.equal(textCarriesLimitPhrase('fix the banner', 'shows the weekly usage limit'), false)
    assert.equal(textCarriesLimitPhrase(undefined, undefined), false)
  })

  test('narrowing 2: a ticket whose own body carries the phrase never cools a model or kills the worker', async () => {
    let killed = null
    const hostile = {
      ...OPEN_ISSUE,
      body: 'Repro: the CLI prints "Claude usage limit reached" even when the quota is fine.',
    }
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...hostile }),
      // the pane echoes the ticket text right next to the composer
      capturePane: async () => 'Claude usage limit reached | 1800000000',
      killSession: async (n) => { killed = n },
    }, { readyTimeoutS: 3 })

    await d.start('42', { repo: 'o/r' })
    // let the watchdog poll until it gives up
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !notifies.some((n) => /did not reach a composer/.test(n.message))) {
      await new Promise((r) => setTimeout(r, 100))
    }

    assert.ok(notifies.some((n) => /did not reach a composer/.test(n.message)), 'must fall through to the ready-timeout path')
    // the refusal leans on this notify as its human surface, so it must NAME
    // the ignored signal — a bare timeout gives no reason to suspect a cap hit
    assert.ok(notifies.some((n) => /usage-limit signal was seen but IGNORED/.test(n.message)),
      'the ready-timeout notify must say a usage-limit signal was ignored')
    assert.ok(typesOf().includes('usage_limit_ignored_ambiguous'))
    assert.ok(!typesOf().includes('model_cooling'))
    assert.ok(!typesOf().includes('provider_cooling'))
    assert.equal(killed, null, 'a healthy session must not be killed by its own ticket text')
  })
})

describe('reconcile without a confirmed viewer identity (B1)', () => {
  test('a failed `gh api user` destroys nothing — no sweep, no unclaim, no worktree removal', async () => {
    const destroyed = []
    fs.writeFileSync(
      path.join(tmp, 'data', 'events.jsonl'),
      JSON.stringify({ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' }) + '\n',
    )
    const d = makeDispatcher({
      viewerLogin: async () => { throw new Error('HTTP 403: rate limit') },
      listSessions: async () => ['curia-42'],
      // the issue reads fine — a DIFFERENT endpoint from /user, which is
      // exactly how the destructive path used to be reached
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      killSession: async (n) => { destroyed.push(`kill:${n}`) },
      removeWorktree: async (b, wt) => { destroyed.push(`worktree:${wt}`) },
      removeConfigDir: (dir) => { destroyed.push(`cfg:${dir}`) },
      unclaim: async (repo, ticket) => { destroyed.push(`unclaim:${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(destroyed, [], 'reconcile must not act on ownership it cannot establish')
    assert.ok(typesOf().includes('reconcile_identity_unknown'))
    assert.ok(!typesOf().includes('orphan_swept'))
  })
})

describe('reconcile with an indeterminate tmux session list (the B1 hole through the tmux read)', () => {
  test('a failing listSessions destroys nothing — no unclaim, no sweep, no worktree removal', async () => {
    // A worker is ALIVE right now, but the tmux read fails (wedged server,
    // foreign socket, the 5 s timeout). Reading that as "no sessions" used to
    // release the live claim, re-frontier the ticket, and let a re-dispatch
    // force-remove the live worktree.
    const destroyed = []
    fs.writeFileSync(
      path.join(tmp, 'data', 'events.jsonl'),
      JSON.stringify({ type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' }) + '\n',
    )
    const d = makeDispatcher({
      listSessions: async () => { throw new Error('tmux session list is indeterminate: timeout') },
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      killSession: async (n) => { destroyed.push(`kill:${n}`) },
      removeWorktree: async (b, wt) => { destroyed.push(`worktree:${wt}`) },
      removeConfigDir: (dir) => { destroyed.push(`cfg:${dir}`) },
      unclaim: async (repo, ticket) => { destroyed.push(`unclaim:${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(destroyed, [], 'an indeterminate session list is a failed pass, not evidence')
    assert.ok(typesOf().includes('reconcile_sessions_indeterminate'))
    assert.ok(!typesOf().includes('dead_claim_released'))
    assert.ok(!typesOf().includes('orphan_swept'))
  })
})

describe('already-live tracked worker: confirming IS the override (B8)', () => {
  test('approve: record dropped, killSession once, re-dispatch claims and spawns', async () => {
    let kills = 0
    let claims = 0
    let spawns = 0
    let confirmPrompt = null
    const d = makeDispatcher({
      killSession: async () => { kills += 1 },
      claim: async () => { claims += 1 },
      newSession: async () => { spawns += 1 },
    }, { readyTimeoutS: 0, confirm: async (ticket, prompt) => { confirmPrompt = prompt; return true } })
    d.workers.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready' })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })

    assert.match(reply, /already running — confirm the re-dispatch/)
    assert.match(confirmPrompt, /tear it down and re-dispatch/)
    await waitFor(() => spawns === 1)
    assert.equal(kills, 1, 'the old session is killed exactly once')
    assert.equal(claims, 1, 'the re-dispatch claims the ticket')
    assert.ok(typesOf().includes('dispatch_claimed'))
    assert.ok(typesOf().includes('worker_spawned'))
    assert.ok(d.workers.has('curia-42'), 'the re-dispatched worker is tracked')
    // let the zero-timeout watchdog finish so nothing leaks into later tests
    await waitFor(() => notifies.some((n) => /did not reach a composer/.test(n.message)))
  })

  test('reject: nothing is torn down', async () => {
    let kills = 0
    let claims = 0
    const original = { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready' }
    const d = makeDispatcher({
      killSession: async () => { kills += 1 },
      claim: async () => { claims += 1 },
    }) // default confirm: reject
    d.workers.set('curia-42', original)

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })

    assert.match(reply, /already running/)
    await waitFor(() => notifies.some((n) => /not confirmed/.test(n.message)))
    assert.equal(kills, 0, 'a rejected override must not kill the session')
    assert.equal(claims, 0)
    assert.equal(d.workers.get('curia-42'), original, 'the tracked record is untouched')
  })
})

describe('usage-limit respawn failure releases the claim (B3)', () => {
  test('newSession throws on the post-limit respawn ⇒ one unclaim, dispatch_unclaimed, worker dropped, one notify', async () => {
    const routing = {
      defaults: { untyped: 'sonnet' },
      models: {
        sonnet: { provider: 'anthropic', backend: 'claude' },
        haiku: { provider: 'anthropic', backend: 'claude' },
      },
      fallbacks: { sonnet: ['haiku'] },
      backends: ROUTING.backends,
    }
    let spawnCalls = 0
    const unclaimed = []
    const credsRemoved = []
    const d = makeDispatcher({
      newSession: async () => {
        spawnCalls += 1
        if (spawnCalls > 1) throw new Error('tmux exploded')
      },
      // a model-scoped cap hit ⇒ cool sonnet, fall back to haiku
      capturePane: async () => 'Sonnet usage limit reached | 1800000000',
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
      removeCredentials: (dir) => { credsRemoved.push(dir) },
    }, { routing })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /dispatched/)

    await waitFor(() => unclaimed.length > 0)
    assert.deepEqual(unclaimed, ['o/r#42'], 'exactly one unclaim')
    assert.ok(typesOf().includes('model_cooling'))
    assert.ok(events.some((e) => e.type === 'dispatch_unclaimed' && /respawn after model usage limit failed/.test(e.reason)))
    assert.equal(d.workers.has('curia-42'), false, 'the worker record is dropped')
    assert.equal(credsRemoved.length, 1, 'the OAuth credential copy is collected on release')
    assert.equal(notifies.length, 1, 'exactly one notify')
    assert.match(notifies[0].message, /respawn on \*\*haiku\*\* failed/)
  })
})

describe('true exhaustion with a FAILED unclaim tells the operator the truth (residual 3)', () => {
  test('unclaim throws on the exhaustion release ⇒ unclaim_failed journalled AND a claim-release-FAILED notify', async () => {
    // provider-scope limit (generic "Claude usage limit reached") with no
    // fallback lanes ⇒ #handleLimit's true-exhaustion tail. Both exhaustion
    // messages say "no claim made"/"nothing claimed" — when the release
    // failed that is the opposite of the truth: the ticket stays assigned
    // and filterTakeable drops it from every frontier.
    const d = makeDispatcher({
      capturePane: async () => 'Claude usage limit reached | 1800000000',
      unclaim: async () => { throw new Error('gh: HTTP 502') },
    })

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /dispatched/)

    await waitFor(() => events.some((e) => e.type === 'unclaim_failed'))
    await waitFor(() => notifies.some((n) => /claim release FAILED: the issue is still assigned; reconcile will retry/.test(n.message)))
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'a failed release must never be journalled as done (F1)')
    assert.equal(notifies.filter((n) => /cooling/.test(n.message)).length, 1, 'the exhaustion-window latch is untouched — exactly one cooling message')
  })

  test('control: a successful unclaim on true exhaustion adds no release-failure message', async () => {
    const d = makeDispatcher({
      capturePane: async () => 'Claude usage limit reached | 1800000000',
    })

    await d.start('42', { repo: 'o/r', by: 'test' })

    await waitFor(() => events.some((e) => e.type === 'dispatch_unclaimed'))
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(notifies.filter((n) => /claim release FAILED/.test(n.message)).length, 0)
  })
})

describe('exactly one notify per exhaustion window (B7/R5)', () => {
  test('two exhausted direct dispatches in one cooling window ⇒ one notify, two journal events, both replies carried', async () => {
    const d = makeDispatcher()
    d.cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))

    const first = await d.start('42', { repo: 'o/r' })
    const second = await d.start('42', { repo: 'o/r' })

    assert.match(first, /all routing lanes are cooling/)
    assert.match(second, /all routing lanes are cooling/, 'the direct reply path always carries the string')
    assert.equal(events.filter((e) => e.type === 'dispatch_exhausted').length, 2)
    assert.equal(notifies.length, 1, 'the latch allows exactly one notify per window')
  })

  test('a CONFIRMED dispatch that lands on exhaustion does not echo the notify', async () => {
    // the anomaly-confirm continuation notifies whatever #dispatch returns —
    // exhaustion must return nothing notifiable, in and after the latch window
    const d = makeDispatcher({
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'somebody' }] }),
    }, { confirm: async () => true })
    d.cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))

    const reply = await d.start('42', { repo: 'o/r' })
    assert.match(reply, /confirm in thread/)
    await waitFor(() => events.some((e) => e.type === 'dispatch_exhausted'))
    // drain the continuation's trailing microtasks before counting
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(notifies.filter((n) => /cooling/.test(n.message)).length, 1, 'the latched notify, and nothing from the continuation')

    // a SECOND confirmed dispatch in the same window says exactly ONE thing —
    // the latch suppressed its notify, so #dispatch hands the continuation the
    // sentinel reply instead; total silence after an approved action is the
    // W2 over-correction, not the R5 fix
    await d.start('42', { repo: 'o/r' })
    await waitFor(() => events.filter((e) => e.type === 'dispatch_exhausted').length === 2)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(notifies.filter((n) => /cooling/.test(n.message)).length, 2, 'exactly one message per exhaustion — never an echo, never silence')
  })

  test('an approved tear-down-and-re-dispatch landing on a latched exhaustion is NEVER silent (W2)', async () => {
    // the worst shape: the operator approves "tear it down and re-dispatch",
    // the continuation's first acts kill the live worker, and exhaustion lands
    // inside an already-latched cooling window — the old always-null #exhausted
    // meant nothing was dispatched and nothing was ever said
    let kills = 0
    const d = makeDispatcher({ killSession: async () => { kills += 1 } }, { confirm: async () => true })
    d.cooling.coolProvider('anthropic', new Date(Date.now() + 3600_000))
    d.workers.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', state: 'ready' })

    // latch the window first (a direct dispatch of another ticket exhausts)
    await d.start('43', { repo: 'o/r' })
    assert.equal(notifies.filter((n) => /cooling/.test(n.message)).length, 1, 'the latch notify')

    const reply = await d.start('42', { repo: 'o/r', by: 'test' })
    assert.match(reply, /already running/)
    await waitFor(() => kills === 1)
    await waitFor(() => notifies.some((n) => n.ticket === '42' && /cooling/.test(n.message)))
    assert.equal(notifies.filter((n) => n.ticket === '42' && /cooling/.test(n.message)).length, 1,
      'the live worker died on an approval — the thread must hear exactly one message about it')
  })
})

describe('an indeterminate hasSession answer never authorises a claim (W1)', () => {
  test('start(): hasSession throwing propagates BEFORE any claim — no claim, no worktree churn', async () => {
    let claims = 0
    const destroyed = []
    const d = makeDispatcher({
      hasSession: async () => { throw new Error('tmux session presence is indeterminate: timeout') },
      claim: async () => { claims += 1 },
      killSession: async (n) => { destroyed.push(`kill:${n}`) },
      createWorktree: async () => { destroyed.push('worktree'); return '/x' },
    })

    await assert.rejects(() => d.start('42', { repo: 'o/r' }), /indeterminate/)
    assert.equal(claims, 0, 'never claim on an answer tmux could not give')
    assert.deepEqual(destroyed, [])
    assert.equal(d.inFlight.size, 0, 'the admission guard is released on the throw')
  })
})

describe('Dispatcher.cancel (criterion 6, the destructive half — W8)', () => {
  test('approve: session killed, worktree removed, unclaimed, config dir removed, record dropped, journalled', async () => {
    const acts = []
    const d = makeDispatcher({
      killSession: async (n) => acts.push(`kill:${n}`),
      removeWorktree: async (base, wt) => acts.push(`worktree:${wt}`),
      unclaim: async (repo, t) => acts.push(`unclaim:${repo}#${t}`),
      removeConfigDir: (dir) => acts.push(`cfg:${path.basename(dir)}`),
    }, { confirm: async () => true })
    d.workers.set('curia-42', { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready' })

    const reply = d.cancel('42', { by: 'test' })
    assert.match(reply, /confirm the cancellation/)

    await waitFor(() => notifies.some((n) => /cancelled/.test(n.message)))
    assert.deepEqual(acts, ['kill:curia-42', 'worktree:/w/42', 'unclaim:o/r#42', 'cfg:curia-42'])
    assert.equal(d.workers.has('curia-42'), false)
    assert.ok(events.some((e) => e.type === 'dispatch_unclaimed' && e.reason === 'cancelled' && e.by === 'test'))
    assert.match(notifies.at(-1).message, /worktree removed, ticket re-frontiered/)
  })

  test('reject: nothing is torn down', async () => {
    const acts = []
    const original = { repo: 'o/r', ticket: '42', session: 'curia-42', wtPath: '/w/42', cfgDir: '/c/curia-42', state: 'ready' }
    const d = makeDispatcher({
      killSession: async (n) => acts.push(`kill:${n}`),
      removeWorktree: async () => acts.push('worktree'),
      unclaim: async () => acts.push('unclaim'),
      removeConfigDir: () => acts.push('cfg'),
    }) // default confirm: reject
    d.workers.set('curia-42', original)

    d.cancel('42', { by: 'test' })

    await waitFor(() => notifies.some((n) => /not confirmed/.test(n.message)))
    assert.deepEqual(acts, [], 'a rejected cancel must destroy nothing')
    assert.equal(d.workers.get('curia-42'), original)
    assert.ok(!typesOf().includes('dispatch_unclaimed'))
  })

  test('untracked cancel: session and config dir go, the GitHub claim is left alone', async () => {
    const acts = []
    const d = makeDispatcher({
      killSession: async (n) => acts.push(`kill:${n}`),
      removeWorktree: async () => acts.push('worktree'),
      unclaim: async () => acts.push('unclaim'),
      removeConfigDir: (dir) => acts.push(`cfg:${path.basename(dir)}`),
    }, { confirm: async () => true })

    d.cancel('42', { by: 'test' })

    await waitFor(() => notifies.some((n) => /cancelled/.test(n.message)))
    assert.deepEqual(acts, ['kill:curia-42', 'cfg:curia-42'], 'no tracked record ⇒ no worktree removal, no unclaim')
    assert.match(notifies.at(-1).message, /GitHub claim untouched/)
    // F1: the message admits the claim was untouched, so the journal must not
    // record an unclaim that never happened — closedAfterEpoch reads
    // dispatch_unclaimed as "this ticket is settled" and would skip it forever
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'no unclaim happened ⇒ none may be journalled')
    assert.ok(!typesOf().includes('unclaim_failed'), 'no unclaim was even attempted ⇒ no event at all')
  })
})

describe('reconcile sweeps abandoned credential copies (W6)', () => {
  function seedCfg(session) {
    const dir = path.join(tmp, 'work', 'cfg', session)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
    fs.writeFileSync(path.join(dir, 'prompt.md'), '# kept for post-mortem')
    return dir
  }

  test('a cfg dir whose session is positively gone loses its credentials — a live one keeps them', async () => {
    const swept = []
    seedCfg('curia-77') // dead: no session
    seedCfg('curia-88') // alive: session listed
    const d = makeDispatcher({
      listSessions: async () => ['curia-88'],
      removeCredentials: (dir) => swept.push(path.basename(dir)),
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(swept, ['curia-77'], 'only the dead worker is swept')
    assert.ok(events.some((e) => e.type === 'credentials_swept' && e.worker === 'curia-77'))
  })

  test('an INDETERMINATE session list sweeps nothing (the W1 interaction)', async () => {
    const swept = []
    seedCfg('curia-77')
    const d = makeDispatcher({
      listSessions: async () => { throw new Error('tmux session list is indeterminate: timeout') },
      removeCredentials: (dir) => swept.push(path.basename(dir)),
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(swept, [], 'a failed read is not evidence the worker is dead')
  })
})

describe('a failed unclaim is never journalled as dispatch_unclaimed (F1 — the W1 class in the journal)', () => {
  function writeJournal(lines) {
    fs.writeFileSync(path.join(tmp, 'data', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  test('#dispatch failure path: unclaim rejects ⇒ unclaim_failed, no dispatch_unclaimed, and the reply does not say "claim released"', async () => {
    const d = makeDispatcher({
      createWorktree: async () => { throw new Error('git exploded') },
      unclaim: async () => { throw new Error('gh: HTTP 502') },
    })

    const reply = await d.start('42', { repo: 'o/r' })

    assert.match(reply, /failed before the worker could run/)
    assert.ok(!/claim released\b/.test(reply), 'the operator must not be told a release that did not happen')
    assert.match(reply, /claim release FAILED/)
    assert.ok(typesOf().includes('unclaim_failed'))
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'the unclaim did not happen — recording it would disarm reconcile')
  })

  test('#dispatch failure path: unclaim succeeds ⇒ dispatch_unclaimed as before, reply says released', async () => {
    const d = makeDispatcher({ createWorktree: async () => { throw new Error('git exploded') } })

    const reply = await d.start('42', { repo: 'o/r' })

    assert.match(reply, /claim released/)
    assert.ok(typesOf().includes('dispatch_unclaimed'))
    assert.ok(!typesOf().includes('unclaim_failed'))
  })

  test('unclaim_failed does NOT close the epoch: the next reconcile releases the still-assigned claim', async () => {
    // the exact silent-disappearance scenario: dispatch failed, the unclaim
    // failed transiently, the issue is still assigned to the bot — a
    // dispatch_unclaimed here would make closedAfterEpoch skip the ticket on
    // every future reconcile while filterTakeable keeps it off the frontier
    const unclaimed = []
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' },
      { type: 'unclaim_failed', repo: 'o/r', ticket: '42', worker: 'curia-42', reason: 'git exploded', error: 'gh: HTTP 502' },
    ])
    const d = makeDispatcher({
      listSessions: async () => [],
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, ['o/r#42'], 'reconcile must retry the release the failed unclaim left behind')
    assert.ok(typesOf().includes('dead_claim_released'))
  })

  test('control: a genuine dispatch_unclaimed still closes the epoch — reconcile leaves it alone', async () => {
    const unclaimed = []
    writeJournal([
      { type: 'dispatch_claimed', repo: 'o/r', ticket: '42', worker: 'curia-42' },
      { type: 'dispatch_unclaimed', repo: 'o/r', ticket: '42', worker: 'curia-42', reason: 'git exploded' },
    ])
    const d = makeDispatcher({
      listSessions: async () => [],
      fetchIssue: async () => ({ ...OPEN_ISSUE, assignees: [{ login: 'me' }] }),
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(unclaimed, [])
    assert.ok(!typesOf().includes('dead_claim_released'))
  })

  test('#releaseClaim with no viewer login journals unclaim_failed, never dispatch_unclaimed', async () => {
    // reach #releaseClaim through the respawn-failure path: first spawn OK,
    // usage-limit hit, second spawn throws, and by then gh identity is gone
    const routing = {
      defaults: { untyped: 'sonnet' },
      models: {
        sonnet: { provider: 'anthropic', backend: 'claude' },
        haiku: { provider: 'anthropic', backend: 'claude' },
      },
      fallbacks: { sonnet: ['haiku'] },
      backends: ROUTING.backends,
    }
    let spawnCalls = 0
    let loginCalls = 0
    const unclaimed = []
    const d = makeDispatcher({
      viewerLogin: async () => {
        loginCalls += 1
        if (loginCalls > 1) throw new Error('gh: HTTP 503')
        return 'me'
      },
      newSession: async () => {
        spawnCalls += 1
        if (spawnCalls > 1) throw new Error('tmux exploded')
      },
      capturePane: async () => 'Sonnet usage limit reached | 1800000000',
      unclaim: async (repo, ticket) => { unclaimed.push(`${repo}#${ticket}`) },
    }, { routing })

    await d.start('42', { repo: 'o/r' })
    await waitFor(() => events.some((e) => e.type === 'unclaim_failed'))

    assert.deepEqual(unclaimed, [], 'no login ⇒ no unclaim was possible')
    assert.ok(!typesOf().includes('dispatch_unclaimed'), 'an impossible unclaim must not be recorded as done')
    assert.ok(notifies.some((n) => /claim release FAILED/.test(n.message)), 'the operator hears the truth, not "re-frontiered"')
  })
})

describe('#resolveRepo refuses on failed reads instead of narrowing (F2 — the W1 class in a read)', () => {
  const takeable = (n) => ({ number: n, title: 't', state: 'open', assignees: [], labels: [] })
  const twoRepos = { watch: [{ repo: 'o/r1', mode: 'ready-for-agent' }, { repo: 'o/r2', mode: 'ready-for-agent' }] }

  test('a failed frontier read on ONE repo makes the bare-number start refuse — never claim against the repo that happened to answer', async () => {
    // both repos carry #42; r1\'s read fails transiently — the old filter
    // dropped the {error} row, saw one hit, and dispatched a bypassPermissions
    // worker against r2\'s #42 with no confirm
    let claims = 0
    const d = makeDispatcher({
      flatFrontier: async (repo) => {
        if (repo === 'o/r1') throw new Error('gh: HTTP 502')
        return [takeable(42)]
      },
      claim: async () => { claims += 1 },
    }, twoRepos)

    const reply = await d.start('42', {})

    assert.match(reply, /could not determine which repo owns #42/)
    assert.match(reply, /o\/r1/, 'the refusal names the repo whose read failed')
    assert.equal(claims, 0, 'nothing may be claimed on an indeterminate candidate set')
    assert.ok(!typesOf().includes('dispatch_claimed'))
  })

  test('control: with both frontier reads healthy, a bare number takeable in exactly one repo still dispatches', async () => {
    const d = makeDispatcher({
      flatFrontier: async (repo) => (repo === 'o/r2' ? [takeable(42)] : []),
    }, twoRepos)

    const reply = await d.start('42', {})

    assert.match(reply, /dispatched o\/r2#42/)
  })

  test('probe path: a non-404 fetchIssue failure refuses instead of narrowing to the repo that answered', async () => {
    let claims = 0
    const d = makeDispatcher({
      flatFrontier: async () => [], // not on any frontier ⇒ probe
      fetchIssue: async (repo) => {
        if (repo === 'o/r1') throw new Error('gh: HTTP 502')
        return { ...OPEN_ISSUE }
      },
      claim: async () => { claims += 1 },
    }, twoRepos)

    const reply = await d.start('42', {})

    assert.match(reply, /could not determine which repo owns #42/)
    assert.equal(claims, 0)
  })

  test('probe path: an HTTP 404 is positive absence — the other repo\'s issue still dispatches', async () => {
    const d = makeDispatcher({
      flatFrontier: async () => [],
      fetchIssue: async (repo) => {
        if (repo === 'o/r1') throw new Error('gh: HTTP 404: Not Found (https://api.github.com/repos/o/r1/issues/42)')
        return { ...OPEN_ISSUE }
      },
    }, twoRepos)

    const reply = await d.start('42', {})

    assert.match(reply, /dispatched o\/r2#42/)
  })
})

describe('an unverified ttyd listener is never published (F3)', () => {
  test('verified:false ⇒ assertServe is skipped AND the persisted serve rule is withdrawn', async () => {
    // `tailscale serve --bg` config persists in tailscaled across daemon
    // restarts — skipping assertServe alone leaves a prior run\'s rule live,
    // still publishing the unverified listener tailnet-wide
    const calls = []
    const d = makeDispatcher({
      ensureTtyd: async () => ({ verified: false }),
      assertServe: async () => { calls.push('serve') },
      serveOff: async ({ servePort }) => { calls.push(`off:${servePort}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(calls, ['off:8443'], 'no publish, and the stale rule is actively withdrawn')
  })

  test('verified:true ⇒ assertServe runs and nothing is withdrawn', async () => {
    const calls = []
    const d = makeDispatcher({
      ensureTtyd: async () => ({ verified: true }),
      assertServe: async () => { calls.push('serve') },
      serveOff: async ({ servePort }) => { calls.push(`off:${servePort}`) },
    })

    await d.reconcile({ boot: false })

    assert.deepEqual(calls, ['serve'])
  })

  test('a failing withdrawal is non-fatal to reconcile and still never publishes', async () => {
    const calls = []
    const logs = []
    const d = makeDispatcher({
      ensureTtyd: async () => ({ verified: false }),
      assertServe: async () => { calls.push('serve') },
      serveOff: async () => { throw new Error('tailscale exploded') },
    })
    d.log = (...a) => logs.push(a.join(' '))

    await d.reconcile({ boot: false })

    assert.deepEqual(calls, [], 'assertServe must not run even when serveOff fails')
    assert.ok(logs.some((l) => /REMAINS PUBLISHED/.test(l)), 'the warning states plainly that the surface may still be published')
  })
})

// The credential watch (#380, re-based by #466). What is pinned here is the
// KEY RULE and the news rule, because those are the two that decide whether the
// operator reads a warning once, four times, or never.
//
// The expiry ladder used to be the third, and it went with the last PAT (#466).
// A minted installation token carries no expiry anyone can act on, and GitHub
// states none for one, so the watch reads exactly one fault now: a watched repo
// the app installation does not cover.
//
// The watch itself is driven with a fake probe and a fake announce, so a whole
// pass runs with no network, no Discord and no timer.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROBE_INTERVAL_MS, warningKey, keysOf, shouldSay, readingOf, dedupe,
  warningLine, clearedLine, TokenWatch,
} from '../src/tokenwatch.mjs'

const APP = {
  holder: 'app',
  key: 'alp82',
  repo: 'alp82/curia',
  refusal: 'no agent can be dispatched to it',
  fix: 'Grant the repo to curia\'s app installation on GitHub (docs/github-app.md).',
}

const missing = (over = {}) => ({ ...APP, ok: false, message: 'the app installation does not grant it', ...over })

// A reduction stand-in: the reduction `reduction.mjs` builds, with the same key
// rule — including the `expiring` arm it keeps for rows written before #466.
function fakeReduction() {
  const map = new Map()
  return {
    map,
    entries: () => [...map.values()],
    entryFor: (k) => map.get(k) ?? null,
    journal: (type, ev) => {
      const k = ev.fault === 'expiring' ? `${ev.holder}:${ev.key}` : `${ev.holder}:${ev.key}:${ev.repo}`
      if (type === 'token_cleared') map.delete(k)
      else map.set(k, { ...ev })
    },
  }
}

// `said` is what reached Discord, which is the only thing that counts as said.
function watchOver(reduction, { answers, bridge = true }) {
  const said = []
  const watch = new TokenWatch({
    probe: async () => (typeof answers === 'function' ? answers() : answers),
    entries: reduction.entries,
    entryFor: reduction.entryFor,
    journal: reduction.journal,
    announce: (text) => {
      if (!bridge) return false
      said.push(text)
      return Promise.resolve(true)
    },
    log: () => {},
  })
  return { watch, said }
}

describe('what a warning is keyed on', () => {
  test('a reading belongs to the credential AND the repo', () => {
    const a = warningKey({ holder: 'app', key: 'o', repo: 'o/one' })
    const b = warningKey({ holder: 'app', key: 'o', repo: 'o/two' })
    assert.notEqual(a, b)
  })

  test('two holders never share a key, even on the same repo', () => {
    const a = warningKey({ holder: 'app', key: 'K', repo: 'o/one' })
    const b = warningKey({ holder: 'overseer', key: 'K', repo: 'o/one' })
    assert.notEqual(a, b)
  })

  test('one probe answer protects its own key', () => {
    assert.deepEqual(keysOf({ holder: 'app', key: 'K', repo: 'o/one' }), ['app:K:o/one'])
  })

  test('four repos left off one installation are FOUR readings', () => {
    const answers = ['o/a', 'o/b', 'o/c', 'o/d'].map((repo) => readingOf(missing({ repo })))
    assert.equal(dedupe(answers).length, 4)
  })

  test('the same repo measured twice in a pass is ONE reading', () => {
    assert.equal(dedupe([readingOf(missing()), readingOf(missing())]).length, 1)
  })
})

describe('what makes a reading news', () => {
  const reading = { fault: 'unreachable', message: 'the app installation does not grant it' }

  test('a key nobody has warned about is always news', () => {
    assert.equal(shouldSay(null, reading), true)
  })

  test('the same reading twice is not news — a deploy repeats nothing', () => {
    assert.equal(shouldSay({ ...reading, said: true }, reading), false)
  })

  test('a reading measured but never said is news again', () => {
    assert.equal(shouldSay({ ...reading, said: false }, reading), true)
  })

  test('a reach failure re-says itself when the reason changes', () => {
    const entry = { ...reading, said: true }
    assert.equal(shouldSay(entry, { ...reading, message: 'HTTP 401: Bad credentials' }), true)
  })

  // The journal outlives the shape it was written in. A row from before #466
  // carries a fault this watch no longer measures, and the pass that meets it
  // must treat it as news rather than as a match.
  test('a fault from an older shape is news', () => {
    assert.equal(shouldSay({ fault: 'expiring', step: 7, said: true }, reading), true)
  })
})

describe('the reading a probe answer becomes', () => {
  test('a repo the installation covers is no reading at all', () => {
    assert.equal(readingOf({ ...APP, ok: true }), null)
  })

  test('a repo it does not cover is a reading, carrying the reason', () => {
    const r = readingOf(missing())
    assert.equal(r.fault, 'unreachable')
    assert.equal(r.repo, 'alp82/curia')
    assert.equal(r.message, 'the app installation does not grant it')
  })

  test('a reading with no reason still states one', () => {
    assert.match(readingOf(missing({ message: null })).message, /no reason/)
  })

  test('a network failure is NOT a reading — it says nothing either way', () => {
    assert.equal(readingOf({ ...APP, unmeasured: true }), null)
  })
})

describe('the words the operator reads', () => {
  test('a warning names the repo, the reason, the cost and the act', () => {
    const line = warningLine(readingOf(missing()))
    assert.match(line, /cannot reach alp82\/curia/)
    assert.match(line, /the app installation does not grant it/)
    assert.match(line, /no agent can be dispatched to it/)
    assert.match(line, /app installation on GitHub/)
  })

  test('a clear names the repo that came good', () => {
    assert.match(clearedLine({ key: 'alp82', repo: 'o/a' }), /reaches o\/a again/)
  })
})

describe('a pass over a whole watch list', () => {
  test('the interval is six hours, so a reading gets four chances a day', () => {
    assert.equal(PROBE_INTERVAL_MS, 6 * 60 * 60 * 1000)
  })

  test('one warning, then silence, then a changed reason speaks again', async () => {
    const reduction = fakeReduction()
    let answer = missing()
    const { watch, said } = watchOver(reduction, { answers: () => [answer] })

    await watch.pass()
    assert.equal(said.length, 1)
    assert.match(said[0], /does not grant it/)

    // Two more passes on the same reading — a deploy, and six hours later.
    await watch.pass()
    await watch.pass()
    assert.equal(said.length, 1)

    answer = missing({ message: 'HTTP 401: Bad credentials' })
    await watch.pass()
    assert.equal(said.length, 2)
    assert.match(said[1], /401/)
  })

  test('a repaired installation clears the standing warning and says so once', async () => {
    const reduction = fakeReduction()
    let answer = missing()
    const { watch, said } = watchOver(reduction, { answers: () => [answer] })
    await watch.pass()
    assert.equal(reduction.map.size, 1)

    answer = { ...APP, ok: true }
    await watch.pass()
    assert.equal(reduction.map.size, 0)
    assert.match(said[1], /reaches alp82\/curia again/)

    // And it is re-armed: the next pass over a healthy grant says nothing.
    await watch.pass()
    assert.equal(said.length, 2)
  })

  test('a probe curia could not take clears nothing', async () => {
    const reduction = fakeReduction()
    let answers = [missing()]
    const { watch, said } = watchOver(reduction, { answers: () => answers })
    await watch.pass()
    assert.equal(reduction.map.size, 1)

    // GitHub was slow. That is a fact about the network, and the repo is still
    // off the installation.
    answers = [{ ...APP, unmeasured: true }]
    await watch.pass()
    assert.equal(reduction.map.size, 1)
    assert.equal(said.length, 1) // no ✅, and no repeat of the ⚠️
  })

  test('a probe that throws leaves every standing warning alone', async () => {
    const reduction = fakeReduction()
    let answers = () => [missing()]
    const { watch } = watchOver(reduction, { answers: () => answers() })
    await watch.pass()
    answers = () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') }
    await watch.pass()
    assert.equal(reduction.map.size, 1)
  })

  test('a warning measured with no bridge is not said, and lands at bridge start', async () => {
    const reduction = fakeReduction()
    const answers = [missing()]

    // Boot: the probe runs before the bridge is up.
    const dark = watchOver(reduction, { answers, bridge: false })
    await dark.watch.pass()
    assert.equal(reduction.map.size, 1)
    assert.equal([...reduction.map.values()][0].said, false)

    // The bridge comes up. flush() re-announces from the reduction — it probes
    // nothing, so a bridge that flaps costs GitHub nothing.
    let probed = 0
    const lit = new TokenWatch({
      probe: async () => { probed++; return [] },
      entries: reduction.entries,
      entryFor: reduction.entryFor,
      journal: reduction.journal,
      announce: () => Promise.resolve(true),
      log: () => {},
    })
    await lit.flush()
    assert.equal(probed, 0)
    assert.equal([...reduction.map.values()][0].said, true)

    // And now it is said, so it is not said again.
    await lit.flush()
    assert.equal([...reduction.map.values()][0].said, true)
  })

  test('two owners warn separately about their own repos', async () => {
    const reduction = fakeReduction()
    const { watch, said } = watchOver(reduction, {
      answers: [
        missing(),
        missing({ key: 'getalfredo', repo: 'getalfredo/landing-page' }),
      ],
    })
    await watch.pass()
    assert.equal(said.length, 2)
    assert.equal(reduction.map.size, 2)
  })

  // The retirement leaves rows in a journal that was written before it. The
  // first pass after the deploy must clear one rather than carry it forever on
  // the dashboard's Needs-you list.
  test('a warning from the retired expiry half clears on the first pass', async () => {
    const reduction = fakeReduction()
    reduction.journal('token_warned', {
      fault: 'expiring', holder: 'agent', key: 'CURIA_AGENT_GH_TOKEN_ALP82',
      repo: 'alp82/curia', days: 3, step: 3, said: true,
    })
    assert.equal(reduction.map.size, 1)

    const { watch, said } = watchOver(reduction, { answers: [{ ...APP, ok: true }] })
    await watch.pass()
    assert.equal(reduction.map.size, 0)
    assert.equal(said.length, 1)
    assert.match(said[0], /reaches alp82\/curia again/)
  })
})

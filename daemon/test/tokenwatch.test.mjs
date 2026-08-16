// The credential watch (#380). What is pinned here is the LADDER and the
// dedupe, because those are the two rules that decide whether the operator
// reads a warning once, four times, or never.
//
// The watch itself is driven with a fake probe and a fake announce, so a whole
// pass runs with no network, no Discord and no timer.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN_STEPS, TOKEN_EXPIRY_WARN_DAYS, PROBE_INTERVAL_MS,
  expiryStep, warningKey, keysOf, shouldSay, readingOf, dedupe,
  expiryInstant, warningLine, clearedLine, TokenWatch,
} from '../src/tokenwatch.mjs'

const AGENT = {
  holder: 'agent',
  key: 'GH_TOKEN_ALP82',
  repo: 'alp82/curia',
  where: 'daemon/.env.daemon',
  refusal: 'an agent on it will fail at its first gh call',
}

// GitHub's own instant format, which `Date.parse` does not accept unaided. The
// extra hour is what keeps `tokenExpiryDays`'s floor on the day this helper
// names: the format carries no milliseconds, so an exact N days lands a moment
// SHORT of N and floors to N-1.
const inDays = (n) => new Date(Date.now() + n * 86_400_000 + 3_600_000)
  .toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')

// A reduction stand-in: the reduction `reduction.mjs` builds, with the same key rule.
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

describe('the expiry ladder', () => {
  test('the steps are 14, 7, 3, 1 and expired, and 14 is the threshold', () => {
    assert.deepEqual(TOKEN_STEPS, [14, 7, 3, 1, 0])
    assert.equal(TOKEN_EXPIRY_WARN_DAYS, 14)
  })

  test('a reading above the threshold says nothing at all', () => {
    assert.equal(expiryStep(15), null)
    assert.equal(expiryStep(366), null)
    // A token with no expiry reads null from tokenExpiryDays and never lands here.
    assert.equal(expiryStep(null), null)
    assert.equal(expiryStep(undefined), null)
  })

  test('each reading takes the TIGHTEST step it has crossed', () => {
    assert.equal(expiryStep(14), 14)
    assert.equal(expiryStep(8), 14)
    assert.equal(expiryStep(7), 7)
    assert.equal(expiryStep(4), 7)
    assert.equal(expiryStep(3), 3)
    assert.equal(expiryStep(2), 3)
    assert.equal(expiryStep(1), 1)
  })

  test('an expired token is its own step, and so is one long dead', () => {
    assert.equal(expiryStep(0), 0)
    assert.equal(expiryStep(-1), 0)
    assert.equal(expiryStep(-400), 0)
  })
})

describe('what a warning is keyed on', () => {
  test('an expiry belongs to the token, so the watch list cannot repeat it', () => {
    const a = warningKey({ fault: 'expiring', holder: 'agent', key: 'K', repo: 'o/one' })
    const b = warningKey({ fault: 'expiring', holder: 'agent', key: 'K', repo: 'o/two' })
    assert.equal(a, b)
  })

  test('a reach failure belongs to the token AND the repo', () => {
    const a = warningKey({ fault: 'unreachable', holder: 'agent', key: 'K', repo: 'o/one' })
    const b = warningKey({ fault: 'unreachable', holder: 'agent', key: 'K', repo: 'o/two' })
    assert.notEqual(a, b)
  })

  test('the two holders never share a key, even on the same repo', () => {
    const a = warningKey({ fault: 'expiring', holder: 'agent', key: 'K', repo: 'o/one' })
    const b = warningKey({ fault: 'expiring', holder: 'overseer', key: 'K', repo: 'o/one' })
    assert.notEqual(a, b)
  })

  test('one probe answer protects both of its possible keys', () => {
    assert.deepEqual(keysOf({ holder: 'agent', key: 'K', repo: 'o/one' }), ['agent:K', 'agent:K:o/one'])
  })

  test('one token over four repos is ONE expiry reading', () => {
    const answers = ['o/a', 'o/b', 'o/c', 'o/d'].map((repo) =>
      readingOf({ ...AGENT, repo, ok: true, expiresAt: inDays(5) }))
    assert.equal(answers.length, 4)
    assert.equal(dedupe(answers).length, 1)
  })

  test('four repos that all refuse the same token are FOUR reach readings', () => {
    const answers = ['o/a', 'o/b', 'o/c', 'o/d'].map((repo) =>
      readingOf({ ...AGENT, repo, ok: false, message: 'HTTP 404: Not Found' }))
    assert.equal(dedupe(answers).length, 4)
  })
})

describe('what makes a reading news', () => {
  const expiring = { fault: 'expiring', step: 7, message: null }

  test('a key nobody has warned about is always news', () => {
    assert.equal(shouldSay(null, expiring), true)
  })

  test('the same step twice is not news — a deploy repeats nothing', () => {
    assert.equal(shouldSay({ ...expiring, said: true }, expiring), false)
  })

  test('a tighter step IS news, and a looser one is not', () => {
    const entry = { ...expiring, said: true }
    assert.equal(shouldSay(entry, { ...expiring, step: 3 }), true)
    assert.equal(shouldSay(entry, { ...expiring, step: 14 }), false)
  })

  test('a reading measured but never said is news again', () => {
    assert.equal(shouldSay({ ...expiring, said: false }, expiring), true)
  })

  test('a token that stops reaching a repo is news even at the same step', () => {
    const entry = { ...expiring, said: true }
    assert.equal(shouldSay(entry, { fault: 'unreachable', message: 'HTTP 404' }), true)
  })

  test('a reach failure re-says itself only when the refusal changes', () => {
    const entry = { fault: 'unreachable', message: 'HTTP 404: Not Found', said: true }
    assert.equal(shouldSay(entry, { fault: 'unreachable', message: 'HTTP 404: Not Found' }), false)
    assert.equal(shouldSay(entry, { fault: 'unreachable', message: 'HTTP 401: Bad credentials' }), true)
  })
})

describe('the reading a probe answer becomes', () => {
  test('a healthy token far from expiry is no reading at all', () => {
    assert.equal(readingOf({ ...AGENT, ok: true, expiresAt: inDays(90) }), null)
  })

  test('a token with no expiry header is no reading either', () => {
    assert.equal(readingOf({ ...AGENT, ok: true, expiresAt: null }), null)
  })

  test('a refusal is a reach reading, carrying GitHub\'s own words', () => {
    const r = readingOf({ ...AGENT, ok: false, message: 'HTTP 404: Not Found' })
    assert.equal(r.fault, 'unreachable')
    assert.equal(r.message, 'HTTP 404: Not Found')
  })

  test('a network failure is NOT a reading — it says nothing either way', () => {
    assert.equal(readingOf({ ...AGENT, unmeasured: true }), null)
  })
})

describe('the words the operator reads', () => {
  test('an expiry names the days, the instant and the act', () => {
    const r = readingOf({ ...AGENT, ok: true, expiresAt: inDays(6) })
    const line = warningLine(r)
    assert.match(line, /GH_TOKEN_ALP82/)
    assert.match(line, /expires in 6 days/)
    assert.match(line, /<t:\d+:D>/) // a date a phone renders in its own timezone
    assert.match(line, /Mint a new token/)
    assert.match(line, /daemon\/\.env\.daemon/)
  })

  test('one day is not "1 days"', () => {
    const r = readingOf({ ...AGENT, ok: true, expiresAt: inDays(1) })
    assert.match(warningLine(r), /expires in 1 day\b/)
  })

  test('a dead token says it is dead rather than counting down past zero', () => {
    const r = readingOf({ ...AGENT, ok: true, expiresAt: inDays(-3) })
    assert.match(warningLine(r), /has EXPIRED/)
    assert.doesNotMatch(warningLine(r), /expires in -/)
  })

  test('a reach failure names the repo and where the token lives', () => {
    const r = readingOf({ ...AGENT, ok: false, message: 'HTTP 404: Not Found' })
    const line = warningLine(r)
    assert.match(line, /cannot reach alp82\/curia/)
    assert.match(line, /HTTP 404: Not Found/)
    assert.match(line, /an agent on it will fail at its first gh call/)
  })

  test('a clear says which fact came good', () => {
    assert.match(clearedLine({ fault: 'expiring', key: 'K' }), /renewed/)
    assert.match(clearedLine({ fault: 'unreachable', key: 'K', repo: 'o/a' }), /reaches o\/a again/)
  })

  test('an unreadable instant leaves the sentence standing', () => {
    assert.equal(expiryInstant('not a date'), null)
    assert.equal(expiryInstant(undefined), null)
    const line = warningLine({ fault: 'expiring', key: 'K', days: 5, expires_at: 'not a date', where: 'w', refusal: 'r' })
    assert.match(line, /expires in 5 days\./)
  })
})

describe('a pass over a whole watch list', () => {
  test('the interval is six hours, so a one-day step gets four chances', () => {
    assert.equal(PROBE_INTERVAL_MS, 6 * 60 * 60 * 1000)
  })

  test('one warning, then silence, then a tighter step speaks again', async () => {
    const reduction = fakeReduction()
    let days = 10
    const { watch, said } = watchOver(reduction, {
      answers: () => [{ ...AGENT, ok: true, expiresAt: inDays(days) }],
    })

    await watch.pass()
    assert.equal(said.length, 1)
    assert.match(said[0], /expires in 10 days/)

    // Two more passes at the same step — a deploy, and six hours later.
    await watch.pass()
    await watch.pass()
    assert.equal(said.length, 1)

    days = 2
    await watch.pass()
    assert.equal(said.length, 2)
    assert.match(said[1], /expires in 2 days/)
  })

  test('a renewed token clears the standing warning and says so once', async () => {
    const reduction = fakeReduction()
    let days = 3
    const { watch, said } = watchOver(reduction, {
      answers: () => [{ ...AGENT, ok: true, expiresAt: inDays(days) }],
    })
    await watch.pass()
    assert.equal(reduction.map.size, 1)

    days = 90
    await watch.pass()
    assert.equal(reduction.map.size, 0)
    assert.match(said[1], /renewed/)

    // And the ladder is re-armed: the next token to get near speaks from 14.
    await watch.pass()
    assert.equal(said.length, 2)
  })

  test('a probe curia could not take clears nothing', async () => {
    const reduction = fakeReduction()
    let answers = [{ ...AGENT, ok: true, expiresAt: inDays(3) }]
    const { watch, said } = watchOver(reduction, { answers: () => answers })
    await watch.pass()
    assert.equal(reduction.map.size, 1)

    // GitHub was slow. That is a fact about the network, and the token is still
    // three days from dying.
    answers = [{ ...AGENT, unmeasured: true }]
    await watch.pass()
    assert.equal(reduction.map.size, 1)
    assert.equal(said.length, 1) // no ✅, and no repeat of the ⚠️
  })

  test('a probe that throws leaves every standing warning alone', async () => {
    const reduction = fakeReduction()
    let answers = () => [{ ...AGENT, ok: true, expiresAt: inDays(3) }]
    const { watch } = watchOver(reduction, { answers: () => answers() })
    await watch.pass()
    answers = () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') }
    await watch.pass()
    assert.equal(reduction.map.size, 1)
  })

  test('a warning measured with no bridge is not said, and lands at bridge start', async () => {
    const reduction = fakeReduction()
    const answers = [{ ...AGENT, ok: true, expiresAt: inDays(4) }]

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

  test('both holders warn separately about the same repo', async () => {
    const reduction = fakeReduction()
    const overseer = {
      holder: 'overseer', key: 'OVERSEER_GH_TOKEN_ALP82', repo: 'alp82/curia',
      where: 'daemon/.env.overseer', refusal: 'the overseer cannot read it',
    }
    const { watch, said } = watchOver(reduction, {
      answers: [
        { ...AGENT, ok: true, expiresAt: inDays(5) },
        { ...overseer, ok: true, expiresAt: inDays(5) },
      ],
    })
    await watch.pass()
    assert.equal(said.length, 2)
    assert.equal(reduction.map.size, 2)
  })
})

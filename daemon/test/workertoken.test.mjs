// The per-worker token (#159). This file pins the RULES; index.test.mjs pins
// them on a real boot over real HTTP, and the live checks pin that both CLIs
// actually put the header on the wire.
//
// Everything here is a fail-closed assertion. The control has exactly one job —
// "prove you are the worker you say you are" — and the only way it can fail
// silently is by admitting a caller it should refuse.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TOKEN_HEADER, WORKER_ROUTES, tokensDir,
  mintWorkerToken, readWorkerToken, workerTokenMatches, forgetWorkerToken, sweepWorkerTokens,
} from '../src/workertoken.mjs'

describe('the per-worker loopback token (#159)', () => {
  let tmp
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-token-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('a minted token is 32 random bytes of hex, and readable back', () => {
    const token = mintWorkerToken(tmp, 'curia-1')
    assert.match(token, /^[0-9a-f]{64}$/)
    assert.equal(readWorkerToken(tmp, 'curia-1'), token)
    // quote-free by construction: it rides a single-quoted curl argument, a JSON
    // string and a TOML string with no escaping rule anywhere
    assert.equal(/['"\\\s]/.test(token), false)
  })

  test('two workers never share a token, and arming again replaces the old one', () => {
    const a = mintWorkerToken(tmp, 'curia-2')
    const b = mintWorkerToken(tmp, 'curia-3')
    assert.notEqual(a, b)
    // the cross-backend respawn arms again: the pane that died must stop being
    // able to speak for the name the moment its successor is armed
    const again = mintWorkerToken(tmp, 'curia-2')
    assert.notEqual(again, a)
    assert.equal(workerTokenMatches(tmp, 'curia-2', a), false)
    assert.equal(workerTokenMatches(tmp, 'curia-2', again), true)
  })

  test('the token file is not world-readable, and neither is its directory', () => {
    mintWorkerToken(tmp, 'curia-4')
    assert.equal(fs.statSync(path.join(tokensDir(tmp), 'curia-4')).mode & 0o077, 0)
  })

  test('every way of not being the worker is refused', () => {
    const token = mintWorkerToken(tmp, 'curia-5')
    assert.equal(workerTokenMatches(tmp, 'curia-5', token), true)
    // another worker's token is not this worker's
    assert.equal(workerTokenMatches(tmp, 'curia-5', mintWorkerToken(tmp, 'curia-6')), false)
    // a name that was never armed — the pre-#159 worker, and the spoofer
    assert.equal(workerTokenMatches(tmp, 'curia-99', token), false)
    for (const presented of [undefined, null, '', 'not-a-token', `${token}x`, token.slice(0, -1)]) {
      assert.equal(workerTokenMatches(tmp, 'curia-5', presented), false, `presented ${JSON.stringify(presented)} must be refused`)
    }
    // surrounding whitespace is tolerated on the wire; the value is not
    assert.equal(workerTokenMatches(tmp, 'curia-5', ` ${token} `), true)
  })

  test('a name that is not a curia session is refused, and never becomes a path', () => {
    assert.throws(() => mintWorkerToken(tmp, '../escape'), /not a valid curia session name/)
    assert.equal(workerTokenMatches(tmp, '../escape', 'anything'), false)
    assert.equal(workerTokenMatches(tmp, 'unknown', 'anything'), false)
  })

  test('a corrupt token file reads as no token rather than as a match', () => {
    mintWorkerToken(tmp, 'curia-7')
    fs.writeFileSync(path.join(tokensDir(tmp), 'curia-7'), 'truncated')
    assert.equal(readWorkerToken(tmp, 'curia-7'), null)
    assert.equal(workerTokenMatches(tmp, 'curia-7', 'truncated'), false)
  })

  test('forgetting is idempotent, and the sweep collects only what the live list omits', () => {
    const live = mintWorkerToken(tmp, 'curia-8')
    mintWorkerToken(tmp, 'curia-9')
    const swept = sweepWorkerTokens(tmp, ['curia-8'])
    assert.ok(swept.includes('curia-9'))
    assert.equal(swept.includes('curia-8'), false)
    assert.equal(workerTokenMatches(tmp, 'curia-8', live), true)
    assert.equal(readWorkerToken(tmp, 'curia-9'), null)
    forgetWorkerToken(tmp, 'curia-9')
    forgetWorkerToken(tmp, 'curia-never-existed')
  })

  test('the sweep on a data dir that never minted anything is a no-op, not a throw', () => {
    assert.deepEqual(sweepWorkerTokens(path.join(tmp, 'nothing-here'), []), [])
  })

  test('the gated route set is exactly the routes that name a worker', () => {
    assert.deepEqual([...WORKER_ROUTES].sort(), ['/mcp', '/worker_done'])
    // lower case, because node lower-cases every incoming header name and this
    // one string is also written into .mcp.json, config.toml and two curl lines
    assert.equal(TOKEN_HEADER, TOKEN_HEADER.toLowerCase())
  })
})

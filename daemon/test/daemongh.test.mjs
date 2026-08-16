// The daemon's own minted GitHub credential (#390, ADR-0018).
//
// Two things are pinned here, and they are different in kind.
//
//   1. daemongh.mjs itself — which owner a repo names, what a child's
//      environment carries, and what an ill-shaped token does.
//   2. THE SHAPE OF github.mjs. Every call in that file that names a repo has
//      to hand the repo to `gh`, or it silently runs as the operator's own
//      login again — which is the whole regression this ticket exists to end.
//      No unit test can reach a `gh` child process, so the rule is read off the
//      source instead. It is a real rule and it is machine-checkable, so it is
//      checked rather than left to a reviewer's eye.

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerOf, daemonGhToken, daemonGhEnv, setDaemonTokenSource, TOKEN_ENV_KEY } from '../src/daemongh.mjs'

afterEach(() => setDaemonTokenSource(null))

describe('ownerOf', () => {
  test('takes the owner off a repo', () => {
    assert.equal(ownerOf('alp82/curia'), 'alp82')
    assert.equal(ownerOf('getalfredo/landing-page'), 'getalfredo')
  })

  // A call with no repo is the settings screen's repo picker, and it keeps the
  // host login on purpose: `gh api user` answers nothing under an installation
  // token, because an app is not a user.
  test('answers null for anything that is not owner/name', () => {
    assert.equal(ownerOf(null), null)
    assert.equal(ownerOf(''), null)
    assert.equal(ownerOf('alp82'), null)
  })
})

describe('the token source', () => {
  test('a box with no source hands out no token, and the child environment is untouched', async () => {
    assert.equal(await daemonGhToken('alp82/curia'), null)
    const env = await daemonGhEnv('alp82/curia', { PATH: '/usr/bin' })
    assert.deepEqual(env, { PATH: '/usr/bin' })
  })

  test('the source is asked for the OWNER, not the repo', async () => {
    const asked = []
    setDaemonTokenSource(async (owner) => { asked.push(owner); return 'ghs_abc' })
    await daemonGhToken('getalfredo/landing-page')
    assert.deepEqual(asked, ['getalfredo'])
  })

  test('a minted token rides the child environment as GH_TOKEN', async () => {
    setDaemonTokenSource(async () => 'ghs_minted')
    const env = await daemonGhEnv('alp82/curia', { PATH: '/usr/bin' })
    assert.equal(env[TOKEN_ENV_KEY], 'ghs_minted')
    assert.equal(env.PATH, '/usr/bin', 'the rest of the environment survives')
  })

  // NULL IS THE FALLBACK SIGNAL, never a refusal (#389's rule, applied to the
  // daemon): an owner the app is not installed on keeps the host login.
  test('a source that answers null falls back rather than throwing', async () => {
    setDaemonTokenSource(async () => null)
    const env = await daemonGhEnv('alp82/curia', { PATH: '/usr/bin' })
    assert.equal(env[TOKEN_ENV_KEY], undefined)
  })

  test('a call with no repo asks the source nothing', async () => {
    let asked = 0
    setDaemonTokenSource(async () => { asked += 1; return 'ghs_abc' })
    assert.equal(await daemonGhToken(null), null)
    assert.equal(asked, 0)
  })

  // A newline in an environment value is a second variable to docker and a
  // truncated one to everything else. Refused rather than escaped.
  test('an ill-shaped token refuses, naming the owner', async () => {
    setDaemonTokenSource(async () => 'ghs_abc\nGH_HOST=evil.example')
    await assert.rejects(() => daemonGhToken('alp82/curia'), /alp82.*letters, digits/s)
  })

  // GitHub's 2026 installation tokens carry `.` and `-` (met live on
  // 2026-08-16: every mint was refused and reconcile skipped every repo).
  test('a minted token with dots and dashes passes', async () => {
    setDaemonTokenSource(async () => 'ghs_abc.DEF-ghi_2.k')
    assert.equal(await daemonGhToken('alp82/curia'), 'ghs_abc.DEF-ghi_2.k')
  })
})

describe('every repo-named call in github.mjs carries its repo', () => {
  const SRC = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'github.mjs'),
    'utf8',
  )

  // The whole text of one `gh([…])` or `ghJSONL([…])` call, found by balancing
  // parentheses from the opening one. Crude on purpose: github.mjs holds no
  // parenthesis inside a string literal, and a scanner that understood
  // JavaScript would be a second parser to keep right.
  //
  // The argv ARRAY is what makes a match a real invocation: it steps over both
  // function declarations and the one-line forward inside `ghJSONL`, neither of
  // which reaches GitHub on its own.
  function callsIn(text) {
    const out = []
    const re = /\bgh(?:JSONL)?\(\s*\[/g
    let m
    while ((m = re.exec(text))) {
      let depth = 0
      let i = text.indexOf('(', m.index)
      for (; i < text.length; i++) {
        if (text[i] === '(') depth += 1
        else if (text[i] === ')') { depth -= 1; if (depth === 0) break }
      }
      out.push(text.slice(m.index, i + 1))
    }
    return out
  }

  // TWO unrouted calls since #391, and they are unrouted for different reasons.
  // `viewerLogin` asks an account-wide question an installation token cannot
  // answer. The gate approval names a repo and keeps the host login anyway: the
  // approval is the OPERATOR's judgement, an app cannot post one for them, and
  // an app-minted approval on an app-authored pull request is the self-approval
  // GitHub refuses. Every other repo-named call routes.
  test('the two unrouted calls are the host login by design, and nothing else joins them', () => {
    const unrouted = callsIn(SRC).filter((c) => !c.includes('{ repo }'))
    assert.deepEqual(
      unrouted,
      [
        "gh(['api', 'user', '--jq', '.login'])",
        "gh(['pr', 'review', String(n), '--repo', repo, '--approve'])",
      ],
      'a gh call that names a repo and does not pass it runs as the operator, not as the bot',
    )
  })

  test('the scanner sees the calls it is meant to see', () => {
    // Guards the guard: a regex that matched nothing would pass the test above
    // silently, and the rule would stop being checked at all.
    assert.ok(callsIn(SRC).length > 10, 'the scanner found almost no calls, so it is reading the file wrong')
  })
})

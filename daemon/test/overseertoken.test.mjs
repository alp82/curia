// #313: the overseer's read-only GitHub token — the keys, the second env file,
// and the boundary that file exists to be.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  OVERSEER_TOKEN_KEY, OVERSEER_ENV_FILE, overseerEnvPath, overseerTokenKeyFor,
  loadOverseerEnv, overseerGhToken, assertOverseerTokens, daemonOnlyKeys,
} from '../src/overseertoken.mjs'
import { ghTokenKeyFor } from '../src/workspace.mjs'

describe('the overseer token keys (#313)', () => {
  test('the key carries the owner, spelled exactly as the agent key spells it', () => {
    assert.equal(overseerTokenKeyFor('alp82/curia'), 'CURIA_OVERSEER_GH_TOKEN_ALP82')
    assert.equal(overseerTokenKeyFor('getalfredo/landing-page'), 'CURIA_OVERSEER_GH_TOKEN_GETALFREDO')
    // an owner is a GitHub login, so the hyphen is the only character to fold
    assert.equal(overseerTokenKeyFor('some-org/repo'), 'CURIA_OVERSEER_GH_TOKEN_SOME_ORG')
    assert.equal(overseerTokenKeyFor(''), null)
  })

  // One spelling rule for both holders: an operator who has written one pair of
  // keys has written the other. A drift here is an operator editing the wrong
  // line and getting no signal.
  test('the two prefixes differ and nothing else does', () => {
    for (const repo of ['alp82/curia', 'getalfredo/landing-page', 'some-org/repo']) {
      assert.equal(
        overseerTokenKeyFor(repo).replace(`${OVERSEER_TOKEN_KEY}_`, ''),
        ghTokenKeyFor(repo).replace('CURIA_AGENT_GH_TOKEN_', ''))
    }
  })

  test('the token is picked by the repo owner, and an owner with no key gets null', () => {
    const env = {
      CURIA_OVERSEER_GH_TOKEN_ALP82: 'github_pat_11ALP82',
      CURIA_OVERSEER_GH_TOKEN_GETALFREDO: 'github_pat_11ORG',
    }
    assert.equal(overseerGhToken('alp82/curia', env), 'github_pat_11ALP82')
    assert.equal(overseerGhToken('getalfredo/landing-page', env), 'github_pat_11ORG')
    assert.equal(overseerGhToken('stranger/repo', env), null)
    // a blank value is no token, not an empty one
    assert.equal(overseerGhToken('alp82/curia', { CURIA_OVERSEER_GH_TOKEN_ALP82: '   ' }), null)
  })

  test('a malformed value refuses, and the refusal names the OVERSEER file', () => {
    for (const bad of ['"quoted"', 'github_pat_x github_pat_y', "'single'"]) {
      assert.throws(
        () => overseerGhToken('alp82/curia', { CURIA_OVERSEER_GH_TOKEN_ALP82: bad }),
        new RegExp(`CURIA_OVERSEER_GH_TOKEN_ALP82 in daemon/${OVERSEER_ENV_FILE.replace('.', '\\.')}`),
        'a message naming daemon/.env.daemon would send the operator to the wrong file')
    }
  })

  test('assertOverseerTokens returns every overseer token and nothing beside it', () => {
    const env = {
      CURIA_OVERSEER_GH_TOKEN_ALP82: ' github_pat_11ALP82 \n',
      CURIA_OVERSEER_GH_TOKEN_BLANK: '',
      CURIA_AGENT_GH_TOKEN_ALP82: 'github_pat_11WRITE',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
    }
    assert.deepEqual(assertOverseerTokens(env), [{ key: 'CURIA_OVERSEER_GH_TOKEN_ALP82', token: 'github_pat_11ALP82' }])
  })
})

// The file IS the boundary: the overseer service loads it whole, so a key in it
// is a key a shell in that container holds.
describe('the overseer env file (#313)', () => {
  let tmp
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-ovt-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('it sits beside daemon/.env.daemon', () => {
    assert.equal(overseerEnvPath('/home/alp/curia/daemon'), `/home/alp/curia/daemon/${OVERSEER_ENV_FILE}`)
  })

  test('a missing file is an empty environment, not a failure', () => {
    assert.deepEqual(loadOverseerEnv(path.join(tmp, 'nothing-here')), {})
  })

  test('the file is parsed, and nothing in it reaches process.env', () => {
    const file = path.join(tmp, OVERSEER_ENV_FILE)
    fs.writeFileSync(file, [
      '# the overseer\'s read-only tokens (#313)',
      'CURIA_OVERSEER_GH_TOKEN_ALP82=github_pat_11ALP82',
      'CURIA_OVERSEER_GH_TOKEN_GETALFREDO=github_pat_11ORG',
      '',
    ].join('\n'))

    const env = loadOverseerEnv(file)
    assert.equal(env.CURIA_OVERSEER_GH_TOKEN_ALP82, 'github_pat_11ALP82')
    assert.equal(env.CURIA_OVERSEER_GH_TOKEN_GETALFREDO, 'github_pat_11ORG')

    // A bare token in the daemon's own environment re-authenticates the daemon's
    // `gh` silently — the trap #155 named. Parsing, never loading, is what keeps
    // this file out of that.
    assert.equal('CURIA_OVERSEER_GH_TOKEN_ALP82' in process.env, false)
  })

  test('a copied daemon/.env.daemon is named back, key by key', () => {
    const copied = {
      DISCORD_BOT_TOKEN: 'x',
      DISCORD_ALLOWED_USERS: '1',
      CURIA_AGENT_GH_TOKEN_ALP82: 'github_pat_11WRITE',
      CURIA_OVERSEER_GH_TOKEN_ALP82: 'github_pat_11READ',
    }
    assert.deepEqual(daemonOnlyKeys(copied).sort(),
      ['CURIA_AGENT_GH_TOKEN_ALP82', 'DISCORD_ALLOWED_USERS', 'DISCORD_BOT_TOKEN'])
    assert.deepEqual(daemonOnlyKeys({ CURIA_OVERSEER_GH_TOKEN_ALP82: 'github_pat_11READ' }), [])
  })
})

// #392: the overseer's minted read-only token — the file per owner the daemon
// writes, and what is left of the second env file after the cutover.
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  OVERSEER_ENV_FILE, RETIRED_TOKEN_KEY, overseerEnvPath, loadOverseerEnv,
  daemonOnlyKeys, retiredTokenKeys, overseerTokensRootFor, overseerTokenFile,
  writeOverseerToken, readOverseerToken, sweepOverseerTokens,
} from '../src/overseertoken.mjs'

describe('the overseer token files (#392)', () => {
  let root
  let dir
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-ovt-')) })
  after(() => { fs.rmSync(root, { recursive: true, force: true }) })
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(root, 'tokens-'))
  })

  test('the tree sits beside the checkouts, under the workspace root', () => {
    assert.equal(overseerTokensRootFor('/home/alp/curia-work'), '/home/alp/curia-work/overseer/tokens')
  })

  // The daemon writes this name and the `gh` shim builds it from an owner it
  // read off a command line. Two spellings of one owner would be a token
  // nobody finds.
  test('one file per owner, named by the owner in lower case', () => {
    assert.equal(overseerTokenFile('/t', 'alp82'), '/t/alp82')
    assert.equal(overseerTokenFile('/t', 'Get-Alfredo'), '/t/get-alfredo')
  })

  test('an owner GitHub could not issue names no file, so `..` reaches nothing', () => {
    for (const bad of ['', '..', '../etc', 'a/b', '-lead', 'has_underscore', 'has.dot']) {
      assert.equal(overseerTokenFile('/t', bad), null, `${bad} must name no file`)
    }
  })

  test('the token is written, read back, and the file is the owner\'s alone', () => {
    const file = writeOverseerToken(dir, 'alp82', 'ghs_11ALP82')
    assert.equal(file, path.join(dir, 'alp82'))
    assert.equal(readOverseerToken(dir, 'alp82'), 'ghs_11ALP82')
    assert.equal(readOverseerToken(dir, 'getalfredo'), null, 'an owner with no file holds no token')
    // A credential the box's other users can read is a credential shared.
    assert.equal(fs.statSync(file).mode & 0o077, 0)
    assert.equal(fs.statSync(dir).mode & 0o077, 0)
  })

  test('a refresh replaces the value, and leaves one file', () => {
    writeOverseerToken(dir, 'alp82', 'ghs_first')
    writeOverseerToken(dir, 'alp82', 'ghs_second')
    assert.equal(readOverseerToken(dir, 'alp82'), 'ghs_second')
    assert.deepEqual(fs.readdirSync(dir), ['alp82'], 'a `.tmp` left behind would be a token nothing sweeps')
  })

  test('an owner spelled two ways reads one file', () => {
    writeOverseerToken(dir, 'Alp82', 'ghs_11ALP82')
    assert.equal(readOverseerToken(dir, 'alp82'), 'ghs_11ALP82')
  })

  // GitHub's 2026 installation tokens carry `.` and `-` (met live on
  // 2026-08-16). The file must round-trip such a token.
  test('a minted token with dots and dashes round-trips', () => {
    writeOverseerToken(dir, 'alp82', 'ghs_abc.DEF-ghi_2.k')
    assert.equal(readOverseerToken(dir, 'alp82'), 'ghs_abc.DEF-ghi_2.k')
  })

  test('a value that is not a token refuses the WRITE', () => {
    for (const bad of ['', '   ', 'ghs_a ghs_b', '"quoted"', 'two\nlines']) {
      assert.throws(() => writeOverseerToken(dir, 'alp82', bad), /a GitHub token is letters, digits/)
    }
    assert.throws(() => writeOverseerToken(dir, '../etc', 'ghs_x'), /alphanumerics and hyphens/)
  })

  // The same rule #313 held on the env value: a bad credential fails where it
  // can be read, and not as a 401 in the middle of a turn.
  test('a file that is not a token refuses the READ, naming the file', () => {
    fs.writeFileSync(path.join(dir, 'alp82'), 'not a token at all\n')
    assert.throws(() => readOverseerToken(dir, 'alp82'), new RegExp(`${path.join(dir, 'alp82')} does not hold a GitHub token`))
  })

  test('an empty file is no token, not an empty one', () => {
    fs.writeFileSync(path.join(dir, 'alp82'), '\n')
    assert.equal(readOverseerToken(dir, 'alp82'), null)
  })

  test('the sweep takes every owner the watch list no longer names', () => {
    writeOverseerToken(dir, 'alp82', 'ghs_a')
    writeOverseerToken(dir, 'getalfredo', 'ghs_b')
    fs.writeFileSync(path.join(dir, 'stranger.tmp'), 'ghs_c')
    assert.deepEqual(sweepOverseerTokens(dir, ['alp82']).sort(), ['getalfredo', 'stranger.tmp'])
    assert.deepEqual(fs.readdirSync(dir), ['alp82'])
    assert.deepEqual(sweepOverseerTokens(dir, ['alp82']), [], 'a second pass has nothing to take')
  })

  test('a tree that is not there yet sweeps nothing and does not throw', () => {
    assert.deepEqual(sweepOverseerTokens(path.join(root, 'never-made'), ['alp82']), [])
  })
})

// #726 retired the file after every credential moved behind a mounted file.
// The daemon still reads a copy that remains so it can name legacy keys.
describe('the retired overseer env file (#313, #392, #726)', () => {
  let tmp
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-ovenv-')) })
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
      '# a legacy model credential that boot must name for deletion (#726)',
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x',
      '',
    ].join('\n'))

    assert.equal(loadOverseerEnv(file).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-x')
    // A bare token in the daemon's own environment re-authenticates the daemon's
    // `gh` silently — the trap #155 named. Parsing, never loading, is what keeps
    // this file out of that.
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in process.env, false)
  })

  test('a copied daemon/.env.daemon is named back, key by key', () => {
    const copied = {
      DISCORD_BOT_TOKEN: 'x',
      DISCORD_ALLOWED_USERS: '1',
      CURIA_AGENT_GH_TOKEN_ALP82: 'github_pat_11WRITE',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
    }
    assert.deepEqual(daemonOnlyKeys(copied).sort(),
      ['CURIA_AGENT_GH_TOKEN_ALP82', 'DISCORD_ALLOWED_USERS', 'DISCORD_BOT_TOKEN'])
  })

  // A key nothing reads is a live PAT with no job. The boot asks for two acts:
  // delete the key, and revoke the token.
  test('#313\'s own keys are named back as retired', () => {
    assert.deepEqual(retiredTokenKeys({
      [`${RETIRED_TOKEN_KEY}_ALP82`]: 'github_pat_11READ',
      [`${RETIRED_TOKEN_KEY}_GETALFREDO`]: 'github_pat_11ORG',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
    }).sort(), [`${RETIRED_TOKEN_KEY}_ALP82`, `${RETIRED_TOKEN_KEY}_GETALFREDO`])
    assert.deepEqual(retiredTokenKeys({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }), [])
  })
})

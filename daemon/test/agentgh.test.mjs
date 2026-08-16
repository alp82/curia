// The agent's minted GitHub credential (#389).
//
// Two halves. The first pins the FILE — its shape, its mode, its replacement and
// its teardown — and runs anywhere. The second runs the real `gh` binary against
// what this module writes, and it is the half that matters: the whole design
// rests on a measurement of gh's config migration, and a gh release that changed
// that rule would otherwise reach the box as an agent that cannot push.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CONFIG_FILE, GH_DIR, GH_USER, HOSTS_FILE,
  configYaml, forgetGhCredentials, ghConfigDirFor, hostsYaml,
  readGhCredentials, writeGhCredentials,
} from '../src/agentgh.mjs'

// A token shaped exactly like a minted one and belonging to nobody. Every
// assertion here is about bytes on disk and about what gh does with them, so a
// real token would buy nothing and would put a live credential in a test.
const FAKE = 'ghs_0000000000000000000000000000000000'

let hasGh = true
try {
  execFileSync('gh', ['--version'], { stdio: 'ignore' })
} catch {
  hasGh = false
}

describe('the per-agent GitHub credential file (#389)', () => {
  let tmp
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-agentgh-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const cfgDir = (name) => {
    const dir = path.join(tmp, name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  test('the credential lands inside the config dir the container mounts', () => {
    const dir = cfgDir('curia-1')
    assert.equal(writeGhCredentials(dir, FAKE), path.join(dir, GH_DIR))
    assert.equal(fs.existsSync(path.join(dir, GH_DIR, HOSTS_FILE)), true)
    assert.equal(fs.existsSync(path.join(dir, GH_DIR, CONFIG_FILE)), true)
  })

  test('both files are 0600, because they hold a live push credential', () => {
    const dir = cfgDir('curia-2')
    writeGhCredentials(dir, FAKE)
    for (const name of [HOSTS_FILE, CONFIG_FILE]) {
      const mode = fs.statSync(path.join(dir, GH_DIR, name)).mode & 0o777
      assert.equal(mode, 0o600, `${name} is ${mode.toString(8)}`)
    }
  })

  test('config.yml states version 1 — the marker that stops gh migrating', () => {
    // Without it gh calls GET /user, which an installation token answers 403,
    // and gh then refuses every command with "cowardly refusing to continue".
    assert.match(configYaml(), /^version: "1"$/m)
  })

  test('hosts.yml carries the token twice, and both places are load-bearing', () => {
    const yaml = hostsYaml(FAKE)
    // gh reads the token off the top-level key...
    assert.match(yaml, /^ {4}oauth_token: ghs_0+$/m)
    // ...and reads the users block to decide the config needs no migration
    assert.match(yaml, /^ {4}users:$/m)
    assert.match(yaml, /^ {8}x-access-token:$/m)
    assert.match(yaml, /^ {12}oauth_token: ghs_0+$/m)
    // the username git is given, which is what GH_TOKEN already yields today
    assert.match(yaml, /^ {4}user: x-access-token$/m)
    assert.equal(GH_USER, 'x-access-token')
  })

  test('a refresh replaces the value, and leaves no second copy behind', () => {
    const dir = cfgDir('curia-3')
    writeGhCredentials(dir, FAKE)
    assert.equal(readGhCredentials(dir), FAKE)
    const next = 'ghs_1111111111111111111111111111111111'
    writeGhCredentials(dir, next)
    assert.equal(readGhCredentials(dir), next)
    const text = fs.readFileSync(path.join(dir, GH_DIR, HOSTS_FILE), 'utf8')
    assert.equal(text.includes(FAKE), false)
    // the rename that makes a refresh atomic must not leave its own file: an
    // agent's gh reads this directory while the daemon rewrites it
    assert.deepEqual(fs.readdirSync(path.join(dir, GH_DIR)).sort(), [CONFIG_FILE, HOSTS_FILE])
  })

  test('a token that is not word characters is refused, never escaped', () => {
    const dir = cfgDir('curia-4')
    for (const bad of ['ghs_a b', '"quoted"', 'ghs_a\nghs_b', '', '   ']) {
      assert.throws(() => writeGhCredentials(dir, bad), /word characters only/)
    }
    assert.equal(readGhCredentials(dir), null)
  })

  test('an unwritten config dir reads back as no credential, never as a guess', () => {
    assert.equal(readGhCredentials(cfgDir('curia-5')), null)
    assert.equal(readGhCredentials(path.join(tmp, 'never-existed')), null)
  })

  test('the teardown takes the credential and leaves the config dir', () => {
    const dir = cfgDir('curia-6')
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'kept for the post-mortem')
    writeGhCredentials(dir, FAKE)
    forgetGhCredentials(dir)
    assert.equal(fs.existsSync(ghConfigDirFor(dir)), false)
    assert.equal(fs.existsSync(path.join(dir, 'prompt.md')), true)
    // idempotent: every teardown path may run it, and most run after the whole
    // config dir is already gone
    forgetGhCredentials(dir)
    forgetGhCredentials(path.join(tmp, 'never-existed'))
  })
})

// The measurement this design rests on, re-taken on every run of the suite.
// Recorded from gh 2.97.0 in docs/live-checks/389-agent-minted-token.md.
describe('what the real gh does with it (#389)', { skip: !hasGh && 'gh not installed' }, () => {
  let tmp
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-agentgh-gh-')) })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  // The credential helper git already runs on every agent clone
  // (`credential.helper = !gh auth git-credential`), asked the question git asks.
  const askGh = (dir) => execFileSync('gh', ['auth', 'git-credential', 'get'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    // The token is fake, so a gh that reached the network would fail here rather
    // than answer — which is itself half of what this test proves.
    env: {
      ...process.env, GH_CONFIG_DIR: ghConfigDirFor(dir), GH_TOKEN: '', GITHUB_TOKEN: '',
    },
  })

  test('gh hands git the token, under the username GH_TOKEN already gives', () => {
    const dir = path.join(tmp, 'curia-7')
    fs.mkdirSync(dir, { recursive: true })
    writeGhCredentials(dir, FAKE)
    const out = askGh(dir)
    assert.match(out, /^username=x-access-token$/m)
    assert.match(out, new RegExp(`^password=${FAKE}$`, 'm'))
  })

  test('gh reaches no network and rewrites nothing, so a minted token is enough', () => {
    // The whole cutover turns on this. gh's multi-account migration calls
    // GET /user, an installation token answers 403, and gh then refuses every
    // command. A fake token proves the call is not made at all: it could not
    // survive one.
    const dir = path.join(tmp, 'curia-8')
    fs.mkdirSync(dir, { recursive: true })
    writeGhCredentials(dir, FAKE)
    const before = fs.readFileSync(path.join(ghConfigDirFor(dir), HOSTS_FILE), 'utf8')
    askGh(dir)
    assert.equal(fs.readFileSync(path.join(ghConfigDirFor(dir), HOSTS_FILE), 'utf8'), before)
  })
})

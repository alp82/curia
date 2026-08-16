// The overseer container's per-owner credential routing (#327, installing both
// halves of #313).
//
// git is driven for real here, the way checkouts.test.mjs drives it: the claim
// under test is what GIT does with the config, and a test that only compared
// strings would pass while git consulted no helper at all. The `gh` shim is run
// for real too, against a fake `gh` that prints the token it was handed.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileP } from '../src/exec.mjs'
import {
  ownersOf, helperKeyFor, credentialConfig, unroutedOwners, installCredentialConfig,
} from '../src/overseercreds.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHIM = path.join(REPO, 'deploy', 'overseer', 'gh-shim.sh')

const WATCHED = ['alp82/curia', 'alp82/aistack', 'getalfredo/landing-page']
const TOKENS = {
  CURIA_OVERSEER_GH_TOKEN_ALP82: 'tok_alp82',
  CURIA_OVERSEER_GH_TOKEN_GETALFREDO: 'tok_org',
}

const dirs = []
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overseer-creds-'))
  dirs.push(dir)
  return dir
}
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the per-owner git config (#313 section 3, installed by #327)', () => {
  test('one owner per line, in watch-list order, and never twice', () => {
    assert.deepEqual(ownersOf(WATCHED), ['alp82', 'getalfredo'])
    assert.equal(helperKeyFor('alp82'), 'credential.https://github.com/alp82.helper')
  })

  test('the config carries the variable NAME, never the token', () => {
    const [alp82] = credentialConfig(WATCHED, TOKENS)
    assert.equal(alp82.owner, 'alp82')
    assert.ok(alp82.value.includes('CURIA_OVERSEER_GH_TOKEN_ALP82'))
    assert.ok(!alp82.value.includes('tok_alp82'), 'a token in the config file is a token on disk')
  })

  test('an owner with no token gets no line, and is named instead', () => {
    const config = credentialConfig(WATCHED, { CURIA_OVERSEER_GH_TOKEN_ALP82: 'tok_alp82' })
    assert.deepEqual(config.map((c) => c.owner), ['alp82'])
    assert.deepEqual(unroutedOwners(WATCHED, { CURIA_OVERSEER_GH_TOKEN_ALP82: 'tok_alp82' }), [
      { owner: 'getalfredo', key: 'CURIA_OVERSEER_GH_TOKEN_GETALFREDO' },
    ])
  })

  test('a malformed token refuses at start rather than reaching a fetch as a 401', () => {
    assert.throws(
      () => credentialConfig(WATCHED, { CURIA_OVERSEER_GH_TOKEN_ALP82: '"quoted"' }),
      /daemon\/\.env\.overseer/,
    )
  })

  test('REAL git routes each owner to its own token, and answers a stranger with none', async () => {
    const home = tmp()
    await installCredentialConfig(WATCHED, { env: TOKENS, gitEnv: { HOME: home } })
    // The token never lands in the file the config lives in.
    const written = fs.readFileSync(path.join(home, '.gitconfig'), 'utf8')
    assert.ok(!written.includes('tok_alp82') && !written.includes('tok_org'))

    // spawnSync, because the request arrives on the helper protocol's stdin.
    // `cwd` is the scratch dir and not the repo: this checkout carries its own
    // `credential.helper` in `.git/config`, and a local helper would answer
    // every row below with the agent's token instead of the overseer's.
    // GIT_ASKPASS is scrubbed for the same reason: a VS Code terminal sets it,
    // and its helper answers the stranger row with the developer's own token.
    const { GIT_ASKPASS, SSH_ASKPASS, ...hostEnv } = process.env
    const fill = (repo) => spawnSync('git', ['credential', 'fill'], {
      timeout: 30_000,
      encoding: 'utf8',
      cwd: home,
      env: { ...hostEnv, ...TOKENS, HOME: home, GIT_TERMINAL_PROMPT: '0' },
      input: `protocol=https\nhost=github.com\npath=${repo}\n\n`,
    })
    assert.equal(/^password=(.*)$/m.exec(fill('alp82/curia.git').stdout)?.[1], 'tok_alp82')
    assert.equal(
      /^password=(.*)$/m.exec(fill('getalfredo/landing-page.git').stdout)?.[1], 'tok_org',
      'the org repo must never get the alp82 token',
    )
    // No helper answers, so git falls through to a terminal it does not have.
    const stranger = fill('stranger/repo.git')
    assert.notEqual(stranger.status, 0)
    assert.doesNotMatch(stranger.stdout, /^password=/m)
  })

  test('installing twice leaves one helper per owner', async () => {
    const home = tmp()
    for (let i = 0; i < 2; i += 1) await installCredentialConfig(WATCHED, { env: TOKENS, gitEnv: { HOME: home } })
    const { stdout } = await execFileP('git', ['config', '--global', '--get-all', helperKeyFor('alp82')], {
      timeout: 30_000, env: { ...process.env, HOME: home },
    })
    assert.equal(stdout.trim().split('\n').length, 1)
  })
})

describe('the gh shim (#313 — gh reads one GH_TOKEN, the container holds one per owner)', () => {
  // A fake `gh` that says which credential it was handed. Nothing here reaches
  // GitHub: the claim under test is the routing, not the API.
  function fakeGh() {
    const dir = tmp()
    const file = path.join(dir, 'gh')
    fs.writeFileSync(file, '#!/usr/bin/env bash\necho "TOKEN=${GH_TOKEN:-<none>}"\necho "ARGV=$*"\n', { mode: 0o755 })
    return file
  }

  const run = async (args, { cwd = REPO, env = {} } = {}) => {
    const { stdout } = await execFileP('bash', [SHIM, ...args], {
      cwd, timeout: 30_000, env: { ...process.env, ...TOKENS, CURIA_GH_REAL: fakeGh(), ...env },
    })
    return /^TOKEN=(.*)$/m.exec(stdout)?.[1] ?? null
  }

  test('--repo names the owner', async () => {
    assert.equal(await run(['issue', 'view', '309', '--repo', 'alp82/curia']), 'tok_alp82')
    assert.equal(await run(['issue', 'list', '--repo=getalfredo/landing-page']), 'tok_org')
    assert.equal(await run(['pr', 'list', '-R', 'getalfredo/landing-page']), 'tok_org')
  })

  test('an api path names the owner', async () => {
    assert.equal(await run(['api', 'repos/getalfredo/landing-page/issues']), 'tok_org')
  })

  test('a bare owner/repo names the owner — this is what the #312 checkout pass runs', async () => {
    assert.equal(await run(['repo', 'clone', 'alp82/curia', '/tmp/x', '--', '--filter=blob:none']), 'tok_alp82')
  })

  test('the checkout directory names the owner when the command line does not', async () => {
    const root = tmp()
    const wt = path.join(root, 'overseer', 'repos', 'getalfredo__landing-page', 'docs')
    fs.mkdirSync(wt, { recursive: true })
    assert.equal(await run(['issue', 'list'], { cwd: wt }), 'tok_org')
  })

  test('no owner means NO token — never the other owner\'s', async () => {
    assert.equal(await run(['--version']), '<none>')
  })

  test('an inherited GH_TOKEN is dropped: this shim is the only thing that decides', async () => {
    assert.equal(await run(['auth', 'status'], { env: { GH_TOKEN: 'leaked_from_somewhere' } }), '<none>')
    assert.equal(await run(['issue', 'view', '1', '--repo', 'alp82/curia'], { env: { GH_TOKEN: 'leaked' } }), 'tok_alp82')
  })

  test('an owner the container holds no token for gets none', async () => {
    assert.equal(await run(['api', 'repos/stranger/repo']), '<none>')
  })
})

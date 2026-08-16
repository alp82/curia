// The overseer container's per-owner credential routing (#327, installing both
// halves of #313; reading a minted token file since #392).
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
  ownersOf, helperKeyFor, credentialConfig, unroutedOwners, unroutedNote, installCredentialConfig,
} from '../src/overseercreds.mjs'
import { writeOverseerToken } from '../src/overseertoken.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHIM = path.join(REPO, 'deploy', 'overseer', 'gh-shim.sh')

const WATCHED = ['alp82/curia', 'alp82/aistack', 'getalfredo/landing-page']

const dirs = []
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overseer-creds-'))
  dirs.push(dir)
  return dir
}
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

// The tree the daemon writes and the container mounts read-only.
function tokens({ alp82 = 'tok_alp82', getalfredo = 'tok_org' } = {}) {
  const dir = tmp()
  if (alp82) writeOverseerToken(dir, 'alp82', alp82)
  if (getalfredo) writeOverseerToken(dir, 'getalfredo', getalfredo)
  return dir
}

describe('the per-owner git config (#313 section 3, installed by #327)', () => {
  test('one owner per line, in watch-list order, and never twice', () => {
    assert.deepEqual(ownersOf(WATCHED), ['alp82', 'getalfredo'])
    assert.equal(helperKeyFor('alp82'), 'credential.https://github.com/alp82.helper')
  })

  test('the config carries the FILE PATH, never the token', () => {
    const dir = tokens()
    const [alp82] = credentialConfig(WATCHED, dir)
    assert.equal(alp82.owner, 'alp82')
    assert.equal(alp82.file, path.join(dir, 'alp82'))
    assert.ok(alp82.value.includes(path.join(dir, 'alp82')))
    assert.ok(!alp82.value.includes('tok_alp82'), 'a token in the config file is a token on disk')
  })

  test('an owner with no token file gets no line, and is named instead', () => {
    const dir = tokens({ getalfredo: null })
    assert.deepEqual(credentialConfig(WATCHED, dir).map((c) => c.owner), ['alp82'])
    assert.deepEqual(unroutedOwners(WATCHED, dir), [
      { owner: 'getalfredo', file: path.join(dir, 'getalfredo') },
    ])
  })

  // The whole fix the reader has to make is in this sentence, and #392 moved
  // where it points: an env file the operator edits became a file the daemon
  // writes for every owner the app is installed on.
  test('the note names the file and the act, never the retired env key', () => {
    const note = unroutedNote({ owner: 'newperson', file: '/w/overseer/tokens/newperson' })
    assert.match(note, /\/w\/overseer\/tokens\/newperson/)
    assert.match(note, /public repositories only/)
    assert.match(note, /GitHub App/)
    assert.doesNotMatch(note, /CURIA_OVERSEER_GH_TOKEN|\.env\.overseer/)
  })

  test('a file that is not a token refuses at start rather than reaching a fetch as a 401', () => {
    const dir = tokens()
    fs.writeFileSync(path.join(dir, 'alp82'), 'not a token')
    assert.throws(() => credentialConfig(WATCHED, dir), /does not hold a GitHub token/)
  })

  test('REAL git routes each owner to its own file, and answers a stranger with none', async () => {
    const home = tmp()
    const dir = tokens()
    await installCredentialConfig(WATCHED, { dir, gitEnv: { HOME: home } })
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
      env: { ...hostEnv, HOME: home, GIT_TERMINAL_PROMPT: '0' },
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

    // THE REFRESH, which is the whole reason the helper names a file: the daemon
    // rewrites the token under a running container, and the next fetch takes it
    // with nothing restarted.
    writeOverseerToken(dir, 'alp82', 'tok_refreshed')
    assert.equal(/^password=(.*)$/m.exec(fill('alp82/curia.git').stdout)?.[1], 'tok_refreshed')

    // And a file that goes away is no answer, rather than an empty password —
    // git reads an empty password as a credential and stops asking.
    fs.rmSync(path.join(dir, 'alp82'))
    const gone = fill('alp82/curia.git')
    assert.notEqual(gone.status, 0)
    assert.doesNotMatch(gone.stdout, /^password=/m)
  })

  test('installing twice leaves one helper per owner', async () => {
    const home = tmp()
    const dir = tokens()
    for (let i = 0; i < 2; i += 1) await installCredentialConfig(WATCHED, { dir, gitEnv: { HOME: home } })
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

  const TOKENS = tokens()
  const run = async (args, { cwd = REPO, env = {} } = {}) => {
    const { stdout } = await execFileP('bash', [SHIM, ...args], {
      cwd,
      timeout: 30_000,
      env: {
        ...process.env, CURIA_GH_REAL: fakeGh(), CURIA_OVERSEER_TOKEN_DIR: TOKENS, ...env,
      },
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

  test('the owner is matched without regard to case, because one file answers', async () => {
    assert.equal(await run(['issue', 'list', '--repo', 'ALP82/curia']), 'tok_alp82')
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

  // The file name is built from a command line, so a name that is not a GitHub
  // account must reach no path at all.
  test('a traversal in the owner position reads nothing', async () => {
    assert.equal(await run(['api', 'repos/../../etc/passwd']), '<none>')
    assert.equal(await run(['issue', 'list', '--repo', '../alp82/curia']), '<none>')
  })

  // The daemon rewrites these files about every fifty minutes, and `gh` is a
  // fresh process every time.
  test('the shim reads the file at call time, so a refresh needs no restart', async () => {
    const dir = tmp()
    writeOverseerToken(dir, 'alp82', 'tok_first')
    const cmd = ['issue', 'list', '--repo', 'alp82/curia']
    assert.equal(await run(cmd, { env: { CURIA_OVERSEER_TOKEN_DIR: dir } }), 'tok_first')
    writeOverseerToken(dir, 'alp82', 'tok_second')
    assert.equal(await run(cmd, { env: { CURIA_OVERSEER_TOKEN_DIR: dir } }), 'tok_second')
  })
})

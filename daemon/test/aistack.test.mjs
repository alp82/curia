// The recurring aistack sync (#695, from the spec at #684).
//
// What is pinned here is the four things the acceptance criteria name: where
// the credential lives and what its absence means, which harness roots one run
// scans, that the command is pinned and runs on the tick curia already has, and
// that a success is silent while a failure names the repair.
//
// The run spawns a real child process, so the describe that covers the command
// hands `runSync` a stub `npx` written by the test. Nothing here reaches
// aistack.to, and no test publishes anything anywhere.

import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLI_PACKAGE, CLI_RUNNER, DEFAULT_CLI_VERSION, DEFAULT_INTERVAL_HOURS, CREDENTIAL_REL,
  homeFor, credentialFile, hasCredential, claudeRoots, codexRoot, syncEnv, syncArgs,
  runSync, publishedLink, failedLine, recoveredLine, AistackSync,
} from '../src/aistack.mjs'
import { Reduction } from '../src/reduction.mjs'

const HOUR = 60 * 60 * 1000

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-aistack-')) })

// A real reduction over a real journal. The alarm and the last attempt both have
// to survive a restart, so the tests that assert on them write to disk.
function newReduction(dir = path.join(root, 'data')) {
  fs.mkdirSync(dir, { recursive: true })
  return new Reduction(dir)
}

// A registered box: the credential the operator's one-time login wrote.
function register(token = 'x'.repeat(64)) {
  const file = credentialFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ servers: { 'https://aistack.to': { token, userId: 'u1' } } }))
  return file
}

// One agent config directory, as the dispatcher lays it out. `kind` picks which
// harness wrote in it.
function cfg(session, kind = 'claude', { at = null } = {}) {
  const dir = path.join(root, 'cfg', session)
  fs.mkdirSync(dir, { recursive: true })
  if (kind === 'claude') fs.mkdirSync(path.join(dir, 'projects'), { recursive: true })
  if (kind === 'codex') fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  if (at !== null) fs.utimesSync(dir, at / 1000, at / 1000)
  return dir
}

describe('the credential decides whether curia syncs at all (#695)', () => {
  test('it lives under curia\'s durable HOME, not in any checkout', () => {
    assert.equal(homeFor('/srv/curia-work'), '/srv/curia-work/home')
    assert.equal(
      credentialFile('/srv/curia-work'),
      path.join('/srv/curia-work', 'home', '.config', 'aistack', 'credentials.json'),
    )
    // The path is relative to curia's HOME and names no repository directory.
    assert.equal(CREDENTIAL_REL, path.join('.config', 'aistack', 'credentials.json'))
  })

  test('an unregistered box has no credential', () => {
    assert.equal(hasCredential(root), false)
  })

  test('a registered box has one', () => {
    register()
    assert.equal(hasCredential(root), true)
  })

  test('a half-written login is not a registration', () => {
    const file = credentialFile(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    assert.equal(hasCredential(root), false)
  })

  test('an unregistered box runs nothing and says nothing', async () => {
    cfg('curia-1')
    const said = []
    let ran = 0
    const sync = new AistackSync({
      root,
      journal: (type, detail) => said.push([type, detail]),
      announce: () => { said.push(['announce']); return true },
      run: async () => { ran += 1; return { stdout: '', stderr: '' } },
    })
    assert.equal(sync.plan().why, 'unregistered')
    assert.equal(await sync.pass(), null)
    assert.equal(ran, 0)
    assert.deepEqual(said, [])
  })
})

describe('the roots are built per run (#695)', () => {
  test('every active claude config directory becomes a root', () => {
    cfg('curia-1', 'claude', { at: 3000 })
    cfg('curia-overseer', 'claude', { at: 2000 })
    cfg('curia-7', 'claude', { at: 1000 })
    assert.deepEqual(claudeRoots(root), [
      path.join(root, 'cfg', 'curia-1'),
      path.join(root, 'cfg', 'curia-overseer'),
      path.join(root, 'cfg', 'curia-7'),
    ])
  })

  test('a directory the claude harness never wrote in is not a root', () => {
    cfg('curia-1', 'claude')
    cfg('curia-2', 'codex')
    cfg('curia-3', 'none')
    assert.deepEqual(claudeRoots(root), [path.join(root, 'cfg', 'curia-1')])
  })

  test('a box with no cfg tree yet has no roots and no codex root', () => {
    assert.deepEqual(claudeRoots(root), [])
    assert.equal(codexRoot(root), null)
  })

  test('a file under cfg is never a root', () => {
    fs.mkdirSync(path.join(root, 'cfg'), { recursive: true })
    fs.writeFileSync(path.join(root, 'cfg', 'notes.txt'), 'hi')
    assert.deepEqual(claudeRoots(root), [])
  })

  test('codex takes one root, and it is the newest', () => {
    cfg('curia-1', 'codex', { at: 1000 })
    cfg('curia-9', 'codex', { at: 5000 })
    cfg('curia-4', 'claude', { at: 9000 })
    assert.equal(codexRoot(root), path.join(root, 'cfg', 'curia-9'))
  })

  test('the environment carries curia\'s HOME and both harness roots', () => {
    cfg('curia-1', 'claude', { at: 2000 })
    cfg('curia-2', 'claude', { at: 1000 })
    cfg('curia-3', 'codex', { at: 3000 })
    const env = syncEnv(root, { env: { PATH: '/usr/bin' } })
    assert.equal(env.HOME, homeFor(root))
    assert.equal(env.PATH, '/usr/bin', 'npx needs the daemon\'s own PATH')
    assert.deepEqual(env.CLAUDE_CONFIG_DIR.split(','), [
      path.join(root, 'cfg', 'curia-1'),
      path.join(root, 'cfg', 'curia-2'),
    ])
    assert.equal(env.CODEX_HOME, path.join(root, 'cfg', 'curia-3'))
  })

  test('a harness with no data sets no variable, so the CLI keeps its own default', () => {
    cfg('curia-1', 'claude')
    const env = syncEnv(root, { env: {} })
    assert.ok('CLAUDE_CONFIG_DIR' in env)
    assert.equal('CODEX_HOME' in env, false)
  })

  test('a box with a credential and no harness data spends nothing', async () => {
    register()
    let ran = 0
    const sync = new AistackSync({
      root, journal: () => {}, announce: () => true,
      run: async () => { ran += 1; return {} },
    })
    assert.equal(sync.plan().why, 'no harness data')
    assert.equal(await sync.pass(), null)
    assert.equal(ran, 0)
  })
})

describe('the command is pinned (#695)', () => {
  test('the arguments name one version and the non-interactive sync', () => {
    assert.deepEqual(syncArgs('1.2.3'), ['-y', `${CLI_PACKAGE}@1.2.3`, 'sync', '--auto'])
    assert.deepEqual(syncArgs(), ['-y', `${CLI_PACKAGE}@${DEFAULT_CLI_VERSION}`, 'sync', '--auto'])
    assert.equal(CLI_RUNNER, 'npx')
  })

  test('the pass runs the configured version', async () => {
    register()
    cfg('curia-1')
    const calls = []
    const sync = new AistackSync({
      root, version: '9.9.9', journal: () => {}, announce: () => true,
      run: async (opts) => { calls.push(opts); return { stdout: '', stderr: '' } },
    })
    await sync.pass()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].version, '9.9.9')
    assert.equal(calls[0].root, root)
  })
})

describe('the real child process (#695)', () => {
  // A stub `npx`. It asserts the argument shape and the environment, then prints
  // what a real run prints. Nothing reaches the network.
  function stubNpx({ code = 0, stdout = '', stderr = '', sleep = 0 } = {}) {
    const bin = path.join(root, 'npx-stub')
    fs.writeFileSync(bin, [
      '#!/bin/bash',
      'if [ "$1" != "-y" ]; then echo "the sync did not pass -y" >&2; exit 90; fi',
      'case "$2" in @use-aistack/cli@*) ;; *) echo "the sync did not pin the CLI: $2" >&2; exit 91;; esac',
      'if [ "$3" != "sync" ] || [ "$4" != "--auto" ]; then echo "the sync was not the auto sync" >&2; exit 92; fi',
      'if [ -z "$CLAUDE_CONFIG_DIR" ]; then echo "no claude roots" >&2; exit 93; fi',
      // `exec`, so the kill reaches the sleep itself. A bash that only forked it
      // would die and leave the child holding the pipe open.
      `if [ ${sleep} -gt 0 ]; then exec sleep ${sleep}; fi`,
      `echo ${JSON.stringify(stderr)} >&2`,
      `echo ${JSON.stringify(stdout)}`,
      `exit ${code}`,
    ].join('\n'))
    fs.chmodSync(bin, 0o755)
    return bin
  }

  test('a clean run resolves with the CLI\'s own words', async () => {
    register()
    cfg('curia-1')
    fs.mkdirSync(homeFor(root), { recursive: true })
    const out = await runSync({
      root, bin: stubNpx({ stdout: 'ok - published https://aistack.to/stacks/demo' }),
    })
    assert.match(out.stdout, /published https:\/\/aistack\.to\/stacks\/demo/)
  })

  test('a non-zero exit rejects with the exit code and the last line', async () => {
    register()
    cfg('curia-1')
    fs.mkdirSync(homeFor(root), { recursive: true })
    await assert.rejects(
      runSync({ root, bin: stubNpx({ code: 7, stderr: 'not authenticated' }) }),
      /exited 7: not authenticated/,
    )
  })

  test('a runner that is not on the box rejects by name', async () => {
    register()
    cfg('curia-1')
    fs.mkdirSync(homeFor(root), { recursive: true })
    await assert.rejects(
      runSync({ root, bin: path.join(root, 'no-such-npx') }),
      /did not run/,
    )
  })

  test('a wedged run is killed and says so', async () => {
    register()
    cfg('curia-1')
    fs.mkdirSync(homeFor(root), { recursive: true })
    await assert.rejects(
      runSync({ root, bin: stubNpx({ sleep: 30 }), timeoutMs: 50 }),
      /ran past .* and was killed/,
    )
  })
})

describe('a success stays quiet (#695)', () => {
  test('one run journals the reading and says nothing', async () => {
    register()
    cfg('curia-1', 'claude', { at: 2000 })
    cfg('curia-2', 'claude', { at: 1000 })
    cfg('curia-3', 'codex', { at: 3000 })
    const events = []
    const spoken = []
    const sync = new AistackSync({
      root,
      journal: (type, detail) => events.push({ type, ...detail }),
      announce: (text) => { spoken.push(text); return true },
      run: async () => ({ stdout: 'ok - published https://aistack.to/stacks/demo', stderr: '' }),
    })
    const done = await sync.pass()
    assert.deepEqual(spoken, [], 'an ordinary sync carries no noise at all')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'aistack_sync')
    assert.equal(events[0].claude_roots, 2)
    assert.equal(events[0].codex_root, 'curia-3')
    assert.equal(done.published, 'https://aistack.to/stacks/demo')
  })

  test('a run the stack held back publishes no link and is still quiet', async () => {
    register()
    cfg('curia-1')
    const spoken = []
    const sync = new AistackSync({
      root, journal: () => {}, announce: (t) => { spoken.push(t); return true },
      run: async () => ({ stdout: 'skipped - too soon', stderr: '' }),
    })
    assert.equal((await sync.pass()).published, null)
    assert.deepEqual(spoken, [])
  })

  test('the published link is read out of either stream', () => {
    assert.equal(publishedLink({ stdout: 'ok - published https://aistack.to/s/a' }), 'https://aistack.to/s/a')
    assert.equal(publishedLink({ stderr: 'note https://aistack.to/s/b' }), 'https://aistack.to/s/b')
    assert.equal(publishedLink({ stdout: 'nothing to publish' }), null)
    assert.equal(publishedLink(null), null)
  })
})

describe('a bounded failure names the repair (#695)', () => {
  test('the line states the loss, the log, and the two commands that fix it', () => {
    const line = failedLine({ message: 'npx exited 7: not authenticated', version: '0.7.2', home: '/srv/curia-work/home' })
    assert.match(line, /the aistack sync failed: npx exited 7: not authenticated/)
    assert.match(line, /keeps its last reading and ages/)
    assert.match(line, /\/srv\/curia-work\/home\/\.config\/aistack\/sync\.log/)
    assert.match(line, /@use-aistack\/cli@0\.7\.2 login/)
    assert.match(line, /@use-aistack\/cli@0\.7\.2 sync --auto on/)
  })

  test('a failure is said once and journalled every time', async () => {
    register()
    cfg('curia-1')
    const reduction = newReduction()
    const spoken = []
    const sync = new AistackSync({
      root,
      journal: (type, detail) => reduction.journal(type, detail),
      announce: (text) => { spoken.push(text); return true },
      standing: () => reduction.standingAistackAlarm(),
      lastAt: () => null,
      run: async () => { throw new Error('npx exited 7: not authenticated') },
    })
    await sync.pass()
    await sync.pass()
    await sync.pass()
    assert.equal(spoken.length, 1, 'one failure is one line, however many ticks it survives')
    assert.ok(reduction.standingAistackAlarm())
    assert.equal(reduction.standingAistackAlarm().message, 'npx exited 7: not authenticated')
  })

  test('a failure whose reason changed is news again', async () => {
    register()
    cfg('curia-1')
    const reduction = newReduction()
    const spoken = []
    let why = 'npx exited 7: not authenticated'
    const sync = new AistackSync({
      root,
      journal: (type, detail) => reduction.journal(type, detail),
      announce: (text) => { spoken.push(text); return true },
      standing: () => reduction.standingAistackAlarm(),
      run: async () => { throw new Error(why) },
    })
    await sync.pass()
    why = 'npx did not run: spawn ENOENT'
    await sync.pass()
    assert.equal(spoken.length, 2)
    assert.match(spoken[1], /spawn ENOENT/)
  })

  test('an alarm the bridge could not carry still stands', async () => {
    register()
    cfg('curia-1')
    const reduction = newReduction()
    let bridge = false
    const spoken = []
    const sync = new AistackSync({
      root,
      journal: (type, detail) => reduction.journal(type, detail),
      announce: (text) => { if (!bridge) return false; spoken.push(text); return true },
      standing: () => reduction.standingAistackAlarm(),
      run: async () => { throw new Error('npx exited 7: not authenticated') },
    })
    await sync.pass()
    assert.deepEqual(spoken, [])
    assert.equal(reduction.standingAistackAlarm().said, false)
    bridge = true
    await sync.pass()
    assert.equal(spoken.length, 1, 'the alarm reaches the operator on the tick the bridge is back')
  })

  test('an announce that throws is the same answer as no bridge', async () => {
    register()
    cfg('curia-1')
    const reduction = newReduction()
    const sync = new AistackSync({
      root,
      journal: (type, detail) => reduction.journal(type, detail),
      announce: () => { throw new Error('discord is down') },
      standing: () => reduction.standingAistackAlarm(),
      run: async () => { throw new Error('npx exited 7') },
    })
    await sync.pass()
    assert.equal(reduction.standingAistackAlarm().said, false)
  })

  test('a repaired sync says so once, and an ordinary one after it says nothing', async () => {
    register()
    cfg('curia-1')
    const reduction = newReduction()
    const spoken = []
    let fail = true
    const sync = new AistackSync({
      root,
      journal: (type, detail) => reduction.journal(type, detail),
      announce: (text) => { spoken.push(text); return true },
      standing: () => reduction.standingAistackAlarm(),
      run: async () => {
        if (fail) throw new Error('npx exited 7')
        return { stdout: 'ok - published https://aistack.to/s/a' }
      },
    })
    await sync.pass()
    fail = false
    await sync.pass()
    await sync.pass()
    assert.equal(spoken.length, 2)
    assert.match(spoken[1], /publishing again: https:\/\/aistack\.to\/s\/a/)
    assert.equal(reduction.standingAistackAlarm(), null)
  })

  test('the recovered line stands on its own when nothing was published', () => {
    assert.match(recoveredLine(), /publishing again\./)
  })

  test('a pass never throws, whatever the run does', async () => {
    register()
    cfg('curia-1')
    const sync = new AistackSync({
      root, journal: () => {}, announce: () => true,
      run: async () => { throw new Error('anything at all') },
    })
    assert.equal(await sync.pass(), null)
  })
})

describe('the check interval, and what a deploy inherits (#695)', () => {
  test('a fresh run holds the next tick back', async () => {
    register()
    cfg('curia-1')
    let ran = 0
    let now = 10 * HOUR
    // The journal stamps a real clock, so this test holds the last attempt
    // itself and moves both hands together.
    let last = null
    const sync = new AistackSync({
      root, intervalHours: 1, now: () => now,
      journal: () => { last = now },
      announce: () => true,
      lastAt: () => last,
      run: async () => { ran += 1; return { stdout: '' } },
    })
    await sync.pass()
    await sync.pass()
    assert.equal(ran, 1)
    now += 2 * HOUR
    await sync.pass()
    assert.equal(ran, 2, 'the interval opens again once it has passed')
  })

  test('a failed attempt counts, so a failing box backs off too', async () => {
    register()
    cfg('curia-1')
    let ran = 0
    let now = 10 * HOUR
    let last = null
    const sync = new AistackSync({
      root, intervalHours: 1, now: () => now,
      journal: () => { last = now },
      announce: () => true,
      lastAt: () => last,
      run: async () => { ran += 1; throw new Error('npx exited 7') },
    })
    await sync.pass()
    await sync.pass()
    assert.equal(ran, 1, 'a failing box does not spawn the CLI on every tick')
    now += 2 * HOUR
    await sync.pass()
    assert.equal(ran, 2, 'and it tries again once the interval opens')
  })

  test('a deploy inherits the last attempt and the standing alarm', () => {
    const data = path.join(root, 'data')
    fs.mkdirSync(data, { recursive: true })
    const before = new Reduction(data)
    assert.equal(before.lastAistackSyncAt(), null)
    before.journal('aistack_sync_failed', { message: 'npx exited 7', said: true })
    const at = before.lastAistackSyncAt()
    assert.ok(Number.isFinite(at))

    // A restart reads the same journal off disk, so the alarm is not re-said and
    // the check interval does not restart from zero.
    const after = new Reduction(data)
    assert.equal(after.lastAistackSyncAt(), at)
    assert.equal(after.standingAistackAlarm().message, 'npx exited 7')

    // A sync that lands clears the alarm and moves the instant on.
    after.journal('aistack_sync', { claude_roots: 1 })
    assert.equal(after.standingAistackAlarm(), null)
    assert.ok(after.lastAistackSyncAt() >= at)
  })

  test('two ticks never overlap one run', async () => {
    register()
    cfg('curia-1')
    let live = 0
    let peak = 0
    let release
    const sync = new AistackSync({
      root, journal: () => {}, announce: () => true, lastAt: () => null,
      run: () => {
        live += 1
        peak = Math.max(peak, live)
        return new Promise((resolve) => { release = () => { live -= 1; resolve({ stdout: '' }) } })
      },
    })
    const first = sync.pass()
    assert.equal(await sync.pass(), null, 'the second tick finds the first still running')
    release()
    await first
    assert.equal(peak, 1)
  })
})

describe('the config block (#695)', () => {
  test('the defaults are the pin and the check interval', () => {
    assert.match(DEFAULT_CLI_VERSION, /^\d+\.\d+\.\d+$/)
    assert.equal(DEFAULT_INTERVAL_HOURS, 1)
  })
})

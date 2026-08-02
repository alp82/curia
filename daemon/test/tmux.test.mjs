// The tmux reads must distinguish POSITIVE ABSENCE from COULD NOT DETERMINE.
// listSessions: "no tmux server" is a legitimate empty list; any other failure
// is indeterminate and throws. hasSession: "can't find session" (server up) or
// "no server" is a legitimate false; any other failure — the wedged-tmux case
// its 5 s timeout exists for — throws. Swallowing indeterminate answers as
// falsy is what let reconcile (and, through hasSession, the auto-dispatch
// path) read a wedged tmux as "nothing is running" and destroy live workers.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasSession, listSessions, newSession, capturePane, killSession } from '../src/tmux.mjs'

// Inside any tmux pane — every curia worker runs there — tmux exports $TMUX,
// and a set $TMUX beats TMUX_TMPDIR: every tmux call below then targets the
// LIVE server instead of this file's throwaway sockets, and the afterEach
// kill-server shuts down the real server with every worker on it (#141 — four
// dead dispatches on 2026-08-02, traced to exactly this). These tests only
// ever talk to their own sockets, so strip the pane identity for the whole
// process before the first tmux call.
delete process.env.TMUX
delete process.env.TMUX_PANE

const hasTmux = spawnSync('tmux', ['-V']).status === 0

describe('listSessions failure classification', { skip: !hasTmux && 'tmux not installed' }, () => {
  let tmp
  let savedTmpdir

  test.beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-tmux-test-'))
    savedTmpdir = process.env.TMUX_TMPDIR
  })

  test.afterEach(() => {
    if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR
    else process.env.TMUX_TMPDIR = savedTmpdir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('positively no server ⇒ [] (a fresh socket dir has no server)', async () => {
    process.env.TMUX_TMPDIR = tmp // exists, empty: "no server running"/"error connecting"
    assert.deepEqual(await listSessions(), [])
  })

  test('an environment failure is indeterminate ⇒ throws, never []', async () => {
    const notADir = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(notADir, '') // tmux cannot create its socket dir here
    process.env.TMUX_TMPDIR = notADir
    await assert.rejects(() => listSessions(), /indeterminate/)
  })
})

describe('hasSession failure classification (the third instance of the R1 bug class)', { skip: !hasTmux && 'tmux not installed' }, () => {
  let tmp
  let savedTmpdir

  const tmuxHere = (...args) => spawnSync('tmux', args, { env: { ...process.env, TMUX_TMPDIR: tmp } })

  test.beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-tmux-test-'))
    savedTmpdir = process.env.TMUX_TMPDIR
    process.env.TMUX_TMPDIR = tmp
  })

  test.afterEach(() => {
    tmuxHere('kill-server') // no-op when no server was started
    if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR
    else process.env.TMUX_TMPDIR = savedTmpdir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('positively no server ⇒ false (no server can hold no session)', async () => {
    assert.equal(await hasSession('curia-42'), false)
  })

  test('server up, session absent ⇒ false; session present ⇒ true', async () => {
    assert.equal(tmuxHere('new-session', '-d', '-s', 'curia-probe').status, 0)
    assert.equal(await hasSession('curia-42'), false, `"can't find session" is positive absence`)
    assert.equal(await hasSession('curia-probe'), true)
  })

  test('an environment failure is indeterminate ⇒ throws, never false', async () => {
    // `tmux has-session` exits 1 here exactly as it does for genuine absence —
    // a `false` from this state is what authorised force-removing a live
    // worker's worktree through the auto-dispatch path
    const notADir = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(notADir, '')
    process.env.TMUX_TMPDIR = notADir
    await assert.rejects(() => hasSession('curia-42'), /indeterminate/)
  })
})

// A real Claude Code worker renames its tmux window to "claude" seconds after
// spawn. Every helper here therefore has to keep working against a session
// whose window name no longer matches the session name — the unit suite's
// injected `capturePane` stubs cannot see this, only a real tmux server can.
// When capturePane targeted a bare `=<session>` it threw "can't find pane" for
// the whole life of every real dispatch, and #watchdog reads a throw as an
// empty pane: no `worker_ready`, a false `worker_ready_timeout` at 45 s, and no
// reactive cooling because parseUsageLimit never saw a byte of pane text.
describe('tmux targets survive a renamed window', { skip: !hasTmux && 'tmux not installed' }, () => {
  let tmp
  let savedTmpdir
  const session = 'curia-rename-probe'

  const tmuxHere = (...args) => spawnSync('tmux', args, { env: { ...process.env, TMUX_TMPDIR: tmp } })

  test.beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-tmux-test-'))
    savedTmpdir = process.env.TMUX_TMPDIR
    process.env.TMUX_TMPDIR = tmp
  })

  test.afterEach(() => {
    tmuxHere('kill-server') // takes the probe session with it, started or not
    if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR
    else process.env.TMUX_TMPDIR = savedTmpdir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('capturePane still reads the pane after the window is renamed', async () => {
    await newSession({ name: session, cwd: os.tmpdir(), shellCmd: 'echo CURIA_PANE_MARKER' })
    // `exec bash` keeps the pane alive; give it a moment to render.
    for (let i = 0; i < 50 && !(await capturePane(session)).includes('CURIA_PANE_MARKER'); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.match(await capturePane(session), /CURIA_PANE_MARKER/, 'baseline: fresh window')

    assert.equal(tmuxHere('rename-window', '-t', `=${session}`, 'claude').status, 0)
    assert.equal(
      tmuxHere('display-message', '-p', '-t', `=${session}:`, '#{window_name}').stdout.toString().trim(),
      'claude',
      'the rename must actually have landed, or the test proves nothing',
    )

    assert.match(await capturePane(session), /CURIA_PANE_MARKER/, 'a renamed window must not hide the pane')
  })

  test('the exact-match flag still applies, so a prefix cannot capture the wrong session', async () => {
    await newSession({ name: `${session}-2`, cwd: os.tmpdir(), shellCmd: 'echo OTHER_SESSION_MARKER' })
    assert.equal(tmuxHere('rename-window', '-t', `=${session}-2`, 'claude').status, 0)
    // Only `<session>-2` exists: capturing `<session>` must fail, never fall
    // through to the longer name's pane the way a prefix match would.
    await assert.rejects(() => capturePane(session), /can't find session/)
  })

  test('hasSession and killSession still resolve the session after the rename', async () => {
    await newSession({ name: session, cwd: os.tmpdir(), shellCmd: 'echo CURIA_PANE_MARKER' })
    // A second session keeps the server up past the kill below: killing the
    // last session takes the server with it, and the reads after that are
    // legitimately indeterminate rather than "absent".
    await newSession({ name: `${session}-keepalive`, cwd: os.tmpdir(), shellCmd: 'true' })
    for (const s of [session, `${session}-keepalive`]) {
      assert.equal(tmuxHere('rename-window', '-t', `=${s}`, 'claude').status, 0)
    }

    assert.equal(await hasSession(session), true)
    assert.deepEqual((await listSessions()).sort(), [session, `${session}-keepalive`])

    await killSession(session)
    assert.equal(await hasSession(session), false)
    assert.equal(await hasSession(`${session}-keepalive`), true, 'kill-session must hit only its target')
  })
})

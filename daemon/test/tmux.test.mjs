// The tmux reads must distinguish POSITIVE ABSENCE from COULD NOT DETERMINE.
// listSessions: "no tmux server" is a legitimate empty list; any other failure
// is indeterminate and throws. hasSession: "can't find session" (server up) or
// "no server" is a legitimate false; any other failure — the wedged-tmux case
// its 5 s timeout exists for — throws. Swallowing indeterminate answers as
// falsy is what let reconcile (and, through hasSession, the auto-dispatch
// path) read a wedged tmux as "nothing is running" and destroy live agents.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasSession, listSessions, newSession, capturePane, killSession, wrapShellCmd, sendText, sendKey, paneShowsActiveTurn, PANE_WRITE_GAP_MS } from '../src/tmux.mjs'
import { paneTail, parseExitMarker, paneExcerpt } from '../src/dispatch.mjs'

// Inside any tmux pane — every curia agent runs there — tmux exports $TMUX,
// and a set $TMUX beats TMUX_TMPDIR: every tmux call below then targets the
// LIVE server instead of this file's throwaway sockets, and the afterEach
// kill-server shuts down the real server with every agent on it (#141 — four
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
    // agent's worktree through the auto-dispatch path
    const notADir = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(notADir, '')
    process.env.TMUX_TMPDIR = notADir
    await assert.rejects(() => hasSession('curia-42'), /indeterminate/)
  })
})

// A real Claude Code agent renames its tmux window to "claude" seconds after
// spawn. Every helper here therefore has to keep working against a session
// whose window name no longer matches the session name — the unit suite's
// injected `capturePane` stubs cannot see this, only a real tmux server can.
// When capturePane targeted a bare `=<session>` it threw "can't find pane" for
// the whole life of every real dispatch, and #watchdog reads a throw as an
// empty pane: no `agent_ready`, a false `agent_ready_timeout` at 45 s, and no
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

  // #169: a harness whose binary is not installed died in a millisecond and left a
  // pane that looked exactly like a slow start, so the watchdog waited out its
  // whole 45 s and then reported nothing but "did not reach a composer". Only a
  // real bash can prove the wrapper actually echoes the status.
  test('the exit marker records the harness command death, with its status', async () => {
    const marker = 'curia-exit-testnonce'
    await newSession({
      name: session, cwd: os.tmpdir(), shellCmd: 'definitely-not-a-real-binary --model x', exitMarker: marker,
    })
    let pane = ''
    for (let i = 0; i < 50 && !pane.includes(marker); i++) {
      await new Promise((r) => setTimeout(r, 100))
      pane = await capturePane(session)
    }
    assert.match(pane, new RegExp(`${marker} 127`), 'a missing binary must land in the pane as status 127')
    assert.match(pane, /command not found/, 'the reason must stay above the marker, for the excerpt to quote')
    assert.equal(await hasSession(session), true, 'the pane still has to survive the death, for inspection')
  })

  test('a marker that is not quote-free is refused rather than nested into bash -c', async () => {
    await assert.rejects(
      () => newSession({ name: session, cwd: os.tmpdir(), shellCmd: 'true', exitMarker: 'x"; rm -rf /; #' }),
      /not quote-free/,
    )
    assert.equal(await hasSession(session), false, 'a refused marker must spawn nothing at all')
  })
})

// #169 again, WITHOUT tmux. The live check above is the only place the wrapper
// meets a real shell, and it skips wherever tmux is absent — the container this
// was confirmed in included. So run the SAME string through bash here, and read
// what comes back with the daemon's own classifiers. tmux only adds a pane to
// hold the text; the exit line is bash's work, and bash is everywhere.
describe('the exit wrapper, through a real shell', () => {
  // stdout and stderr share ONE file descriptor, because that is what a terminal
  // is: `command not found` goes to stderr and the marker echo to stdout, and
  // paneExcerpt reads the reason as the line ABOVE the marker. Two separate
  // pipes would lose exactly that order. `exec bash` reads stdin, so an empty
  // input ends the pane shell instead of hanging the test.
  const runWrapped = (shellCmd, marker) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'curia-wrap-')), 'pane.txt')
    const fd = fs.openSync(out, 'w')
    try {
      spawnSync('bash', ['-c', wrapShellCmd(shellCmd, marker)], {
        stdio: ['pipe', fd, fd], input: '', timeout: 10_000,
      })
    } finally {
      fs.closeSync(fd)
    }
    return fs.readFileSync(out, 'utf8')
  }

  test('a missing binary reads as status 127, with the reason above the marker', () => {
    const marker = 'curia-exit-liveshell'
    const tail = paneTail(runWrapped('definitely-not-a-real-binary --model x', marker))

    assert.equal(parseExitMarker(tail, marker), 127, 'the wrapper has to carry the shell status, not just the death')
    assert.match(paneExcerpt(tail, marker), /command not found/, 'the reason the notify quotes must survive the real shell')
  })

  test('a command that succeeds and exits is still an exit, at status 0', () => {
    const marker = 'curia-exit-liveshell0'
    const tail = paneTail(runWrapped('echo the harness printed this and left', marker))

    assert.equal(parseExitMarker(tail, marker), 0)
    assert.match(paneExcerpt(tail, marker), /printed this and left/)
  })

  test('an unsafe marker is refused before it is ever nested in bash -c', () => {
    assert.throws(() => wrapShellCmd('true', 'x"; rm -rf /; #'), /not quote-free/)
  })
})

// #223, WITHOUT tmux, for the same reason the wrapper test above runs without
// it: the property under test is the TIMING of the send-keys calls, and a fake
// tmux on PATH records that timing anywhere. codex 0.146 folds keystrokes that
// arrive inside about a second into one paste (measured live on #176), so an
// Enter that follows its text milliseconds later becomes a newline and the
// message never leaves the composer.
describe('pane writes are spaced so a codex composer cannot fold them (#223)', () => {
  // The widest fold window measured on codex 0.146. The gap must clear it.
  const CODEX_PASTE_WINDOW_MS = 1_000

  let tmp
  let log
  let savedPath

  // Every call appends "<ms> <argv…>", so the log carries both the order and
  // the spacing of the real execFile calls.
  const FAKE = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
const line = args.join(' ')
fs.appendFileSync(process.env.CURIA_TMUX_LOG, Date.now() + ' ' + line + '\\n')
if (process.env.CURIA_TMUX_FAIL_WRITE === '1' && args[0] === 'send-keys') process.exit(1)
if (args[0] === 'capture-pane') {
  const target = args[args.indexOf('-t') + 1]
  const prior = fs.readFileSync(process.env.CURIA_TMUX_LOG, 'utf8')
  const active = prior.includes('send-keys -t ' + target + ' Enter')
  process.stdout.write((process.env.CURIA_TMUX_ACTIVE === '1' || (active && process.env.CURIA_TMUX_STATIC !== '1')) ? '✻ Working\\n' : '⏵⏵ bypass permissions on\\n')
}
`

  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.slice(0, line.indexOf(' '))
    return { at: Number(at), args: line.slice(at.length + 1) }
  }).filter((call) => call.args.startsWith('send-keys '))

  test.beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-paced-'))
    log = path.join(tmp, 'calls.log')
    fs.writeFileSync(path.join(tmp, 'tmux'), FAKE, { mode: 0o755 })
    fs.writeFileSync(log, '')
    process.env.CURIA_TMUX_LOG = log
    savedPath = process.env.PATH
    process.env.PATH = `${tmp}:${savedPath}`
  })

  test.afterEach(() => {
    process.env.PATH = savedPath
    delete process.env.CURIA_TMUX_LOG
    delete process.env.CURIA_TMUX_STATIC
    delete process.env.CURIA_TMUX_ACTIVE
    delete process.env.CURIA_TMUX_FAIL_WRITE
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the Enter lands a gap after the text, not milliseconds after it', async () => {
    await sendText('curia-223a', 'ship it')
    const c = calls()

    assert.equal(c.length, 2)
    assert.equal(c[0].args, 'send-keys -t =curia-223a: -l ship it')
    assert.equal(c[1].args, 'send-keys -t =curia-223a: Enter')
    assert.ok(
      c[1].at - c[0].at > CODEX_PASTE_WINDOW_MS,
      `the Enter landed ${c[1].at - c[0].at}ms after the text — inside codex's fold window, where it is a newline`,
    )
  })

  test('a pane write without an active read-back returns an unconfirmed result', async () => {
    process.env.CURIA_TMUX_STATIC = '1'
    const result = await sendText('curia-223-static', 'ship it', { readbackMs: 0 })
    assert.equal(result.status, 'unconfirmed')
    delete process.env.CURIA_TMUX_STATIC
  })

  test('a pane that stays active gets no text', async () => {
    process.env.CURIA_TMUX_ACTIVE = '1'
    const result = await sendText('curia-223-active', 'ship it', { readbackMs: 0 })
    assert.equal(result.status, 'not-sent')
    assert.deepEqual(calls(), [])
    delete process.env.CURIA_TMUX_ACTIVE
  })

  test('a failed tmux write returns an unconfirmed result', async () => {
    process.env.CURIA_TMUX_FAIL_WRITE = '1'
    const result = await sendText('curia-223-failed', 'ship it', { readbackMs: 0 })
    assert.equal(result.status, 'unconfirmed')
    assert.match(result.error, /Command failed/)
    delete process.env.CURIA_TMUX_FAIL_WRITE
  })

  test('plain prose cannot claim that a pane has an active turn', () => {
    assert.equal(paneShowsActiveTurn('Why is this not working?'), false)
    assert.equal(paneShowsActiveTurn('✻ Working on the next step'), true)
  })

  test('two writers to one pane are serialised, so no write folds into another', async () => {
    // The second fold: two devices posting /send milliseconds apart put the
    // first message's Enter and the second message's text in one burst.
    await Promise.all([sendText('curia-223b', 'first'), sendKey('curia-223b', 'Escape')])
    const c = calls()

    assert.deepEqual(c.map((x) => x.args), [
      'send-keys -t =curia-223b: -l first',
      'send-keys -t =curia-223b: Enter',
      'send-keys -t =curia-223b: Escape',
    ], 'writes must reach the pane in the order they were issued')
    for (let i = 1; i < c.length; i++) {
      assert.ok(
        c[i].at - c[i - 1].at > CODEX_PASTE_WINDOW_MS,
        `write ${i} landed ${c[i].at - c[i - 1].at}ms after write ${i - 1}`,
      )
    }
  })

  test('two panes do not wait on each other', async () => {
    const started = Date.now()
    await Promise.all([sendKey('curia-223c', 'Escape'), sendKey('curia-223d', 'Escape')])

    assert.equal(calls().length, 2)
    assert.ok(Date.now() - started < PANE_WRITE_GAP_MS, 'the gap is per pane; one agent must not delay another')
  })
})

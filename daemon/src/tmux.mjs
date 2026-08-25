// Thin tmux helpers (#33 step 3). Everything goes through execFile — session
// names and paths are argv elements, never shell-interpolated.

import { execFileP } from './exec.mjs'

// tmux is a local socket call: anything slower than a few seconds is wedged,
// and a wedged one must never hold up boot reconcile.
const TMUX_TIMEOUT_MS = 5_000
const PANE_READBACK_MS = 5_000
const PANE_ACTIVE_RE = /(?:✻|✽|✶|✢|esc to interrupt|ctrl-c to interrupt)/i

// #260: under compose the tmux SERVER lives in its own container, parked on a
// `keeper` session, and the daemon is a client over a shared socket volume —
// that is what lets a daemon restart leave every agent pane alive. The socket
// path arrives by env (compose sets /run/curia-tmux/default); unset means the
// default socket, which is what a dev box wants.
export const TMUX_SOCKET = process.env.CURIA_TMUX_SOCKET ?? null

function tmux(args) {
  return execFileP('tmux', TMUX_SOCKET ? ['-S', TMUX_SOCKET, ...args] : args,
    { maxBuffer: 4 * 1024 * 1024, timeout: TMUX_TIMEOUT_MS })
}

// Positively no server ⇒ genuinely zero sessions. Anything else — tmux not on
// PATH, a foreign TMUX_TMPDIR/socket, the 5 s timeout above firing — means the
// answer is INDETERMINATE, not "absent".
const NO_SERVER_RE = /no server running|error connecting to .*No such file or directory/i

// The message a running server emits for a session that does not exist.
// tmux has worded this both ways across releases — "can't find session"
// (verified live on the deployment host's tmux 3.7b) and "session not found"
// — and missing the phrase would make every start()/#autoTick throw
// "indeterminate" forever, so match both.
const NOT_FOUND_RE = /can't find session|session not found/i

// `tmux has-session` exits 1 for genuine absence, for no-server, AND for
// environment failures (verified live: "can't find session: x",
// "error connecting to … (No such file or directory)",
// "couldn't create directory … (Not a directory)") — the exit code cannot
// classify, so classify on stderr exactly as listSessions does below. `false`
// only on positive evidence of absence; anything indeterminate throws. This
// answer authorises destructive acts downstream — start()'s already-live
// override and #autoTick's "skip, never churn" both read `false` as "no live
// agent", and a wedged tmux answered as `false` used to let a re-dispatch
// force-remove a LIVE agent's worktree with no human in the loop.
export async function hasSession(name) {
  try {
    await tmux(['has-session', '-t', `=${name}`])
    return true
  } catch (e) {
    const stderr = e.stderr ?? ''
    if (e.code === 1 && (NOT_FOUND_RE.test(stderr) || NO_SERVER_RE.test(stderr))) return false
    throw new Error(`tmux session presence is indeterminate: ${stderr.trim() || e.message}`)
  }
}

// All session names; callers filter ^curia-. Returns [] only on positive
// evidence that no server exists; any other failure throws. Swallowing those
// used to hand reconcile an empty list it read as "nothing is running", which
// unclaimed live agents and force-removed their worktrees — the exact
// data-destroying outcome the null-login guard already blocks on the identity
// read. An indeterminate session list is a failed pass, not evidence.
export async function listSessions() {
  try {
    const { stdout } = await tmux(['list-sessions', '-F', '#{session_name}'])
    return stdout.split('\n').filter(Boolean)
  } catch (e) {
    if (e.code === 1 && NO_SERVER_RE.test(e.stderr ?? '')) return []
    throw new Error(`tmux session list is indeterminate: ${e.stderr?.trim() || e.message}`)
  }
}

// An exit marker is echoed between the harness command and the `exec bash`
// below, so the pane itself records that the command ENDED and with what
// status. The value is nested inside `bash -c`, so it must be quote-free by
// construction — same discipline as SAFE_SUBSTITUTION in routing.mjs, asserted
// here rather than trusted.
const SAFE_MARKER = /^[A-Za-z0-9_-]+$/

// The script `bash -c` runs in the pane. Exported so a check can run the REAL
// string through a real shell: the tmux live checks below skip wherever tmux is
// absent, and a copy of this line in a test proves only the copy.
export function wrapShellCmd(shellCmd, exitMarker = null) {
  if (exitMarker && !SAFE_MARKER.test(exitMarker)) {
    throw new Error(`refusing to use exit marker "${exitMarker}": it is not quote-free/shell-safe`)
  }
  return exitMarker
    ? `${shellCmd}; echo "[curia] the harness command exited — ${exitMarker} $?"; exec bash`
    : `${shellCmd}; exec bash`
}

// Detached session running `env K=V… bash -c '<shellCmd>; exec bash'` — the
// trailing `exec bash` keeps the pane alive after the command exits, so the
// pane content stays inspectable (spike #32 pattern).
//
// `exitMarker` is what makes that death READABLE (#169): without it the pane
// after a missing binary looks exactly like a slow start, and the watchdog can
// only wait out its whole timeout. The echo is the last thing before the
// shell, so it always sits inside the pane tail the classifiers read.
export async function newSession({ name, cwd, env = {}, shellCmd, exitMarker = null }) {
  const wrapped = wrapShellCmd(shellCmd, exitMarker)
  const args = ['new-session', '-d', '-s', name, '-c', cwd, 'env']
  for (const [k, v] of Object.entries(env)) args.push(`${k}=${v}`)
  args.push('bash', '-c', wrapped)
  await tmux(args)
}

// PANE-scoped target — and a pane target is NOT a session target. A bare
// `=<session>` makes tmux look for a *pane* by that name and fail with
// "can't find pane: =<session>" as soon as the window is no longer named after
// the session — which is always, because a real Claude Code agent renames its
// window to "claude". The trailing colon is what says "session <name>, its
// active window, that window's active pane" (verified live on tmux 3.7b against
// a renamed-window session). The `=` still means exact match through the colon
// form: with only `curia-probe-2` alive, `=curia-probe:` errors while the
// prefix-matching `curia-probe:` wrongly captures curia-probe-2's pane.
//
// The old form made every capture throw, and #watchdog reads a throw as an
// empty pane: READY_MARKER never matched (so `agent_ready` was never
// journalled and every live agent got a false `agent_ready_timeout`), and
// parseUsageLimit never saw pane text, so reactive cooling could never fire.
export async function capturePane(name) {
  const { stdout } = await tmux(['capture-pane', '-p', '-t', `=${name}:`])
  return stdout
}

export async function killSession(name) {
  await tmux(['kill-session', '-t', `=${name}`])
  paneWrites.delete(name) // the pane is gone, and its pacing state goes with it
}

// ---------------------------------------------------------------------------
// the write path, paced (#223)
// ---------------------------------------------------------------------------
//
// The timeline surface's write path (#74): send-keys drives a session with
// ZERO attached clients, so no geometry is negotiated and the pane never
// learns how many devices exist (#72 leg 3). Same pane-scoped `=name:` target
// as capturePane, for the same window-rename reason.
//
// Every byte a caller writes into a pane goes through paneWrite, which holds
// consecutive writes to the SAME pane at least PANE_WRITE_GAP_MS apart.
//
// codex 0.146 folds keystrokes that arrive inside about a second into one
// PASTE — measured live on #176 (docs/live-checks/176-codex-attach-surfaces.md,
// section 4). sendText used to send the text and the Enter as two send-keys
// calls milliseconds apart, so on a codex pane the Enter landed inside that
// window and became a NEWLINE: the message sat in the composer, no turn ever
// started, and the timeline still reported "sent". Every timeline /send to a
// codex agent was a silent no-op — #75's loss class again, on the write path.
//
// The gap is unconditional, not per-harness. A per-harness send would have to
// pick its branch from the dispatcher's harness answer, which is null for a
// re-adopted or lab session, and the wrong branch here fails SILENTLY — the
// exact outcome this closes. The claude composer submits on a late Enter
// exactly as it does on an immediate one (measured throughout #74/#75), so
// both lanes pay the gap and neither lane can lose a message to a fold.
//
// The pacing also covers the fold nobody had to type by hand: two /send posts
// from two devices, milliseconds apart, put the first message's Enter and the
// second message's text in one burst, which loses the first submit the same
// way. Writers are therefore QUEUED per pane as well as spaced. The queue is
// what makes a send ATOMIC: the text and its Enter are one job, so another
// device's Escape can no longer land between them and empty the composer the
// Enter was about to submit.
export const PANE_WRITE_GAP_MS = 1_500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function paneShowsActiveTurn(text, lines = 4) {
  return PANE_ACTIVE_RE.test(String(text ?? '').split('\n').slice(-lines).join('\n'))
}

// name -> { at, chain }: `at` is when the last write to this pane finished,
// `chain` is the tail of that pane's job queue. The queue is per pane, so one
// agent's send never delays another's.
const paneWrites = new Map()

// job(write) runs with the pane to itself; each `write` waits out the gap
// since the previous one, whoever made it.
function paneJob(name, job) {
  let state = paneWrites.get(name)
  if (!state) {
    state = { at: 0, chain: Promise.resolve() }
    paneWrites.set(name, state)
  }
  const pace = async () => {
    const wait = state.at + PANE_WRITE_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
  }
  const write = async (args) => {
    await pace()
    try {
      await tmux(args)
    } finally {
      // A failed send-keys may still have put bytes in the pane, so it starts
      // the next gap exactly as a successful one does.
      state.at = Date.now()
    }
  }
  const done = state.chain.then(() => job(write, pace))
  // The queue carries the swallowed copy: one failed job must not reject every
  // job queued behind it.
  state.chain = done.catch(() => {})
  return done
}

// -l sends the text LITERALLY (no key-name interpretation); the separate
// Enter, one gap later, submits it.
export function sendText(name, text, { readbackMs = PANE_READBACK_MS } = {}) {
  return paneJob(name, async (write, pace) => {
    await pace()
    const idleDeadline = Date.now() + readbackMs
    let before
    do {
      before = await capturePane(name)
      if (!paneShowsActiveTurn(before)) break
      if (Date.now() >= idleDeadline) return { status: 'not-sent', pane: before }
      await sleep(Math.min(250, idleDeadline - Date.now()))
    } while (true)
    try {
      await write(['send-keys', '-t', `=${name}:`, '-l', text])
      await write(['send-keys', '-t', `=${name}:`, 'Enter'])
    } catch (error) {
      return { status: 'unconfirmed', pane: before, error: error.message }
    }
    const deadline = Date.now() + readbackMs
    let after = before
    do {
      after = await capturePane(name)
      if (after !== before && paneShowsActiveTurn(after)) return { status: 'confirmed', pane: after }
      if (Date.now() >= deadline) break
      await sleep(Math.min(250, deadline - Date.now()))
    } while (true)
    return { status: 'unconfirmed', pane: after }
  })
}

export function sendKey(name, key) {
  return paneJob(name, (write) => write(['send-keys', '-t', `=${name}:`, key]))
}

// A native dialog answer is one pane job. The daemon parses the visible
// selected index and the tapped target index. Sending the complete navigation
// sequence in one tmux call prevents another device from changing the
// selection between a cursor key and Enter.
export function sendDialogOption(name, { currentIndex, targetIndex }) {
  if (!Number.isInteger(currentIndex) || currentIndex < 1
      || !Number.isInteger(targetIndex) || targetIndex < 1) {
    throw new Error('native dialog option indexes must be positive integers')
  }
  const direction = targetIndex >= currentIndex ? 'Down' : 'Up'
  const keys = Array(Math.abs(targetIndex - currentIndex)).fill(direction)
  keys.push('Enter')
  return paneJob(name, (write) => write(['send-keys', '-t', `=${name}:`, ...keys]))
}

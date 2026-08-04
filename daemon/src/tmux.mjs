// Thin tmux helpers (#33 step 3). Everything goes through execFile — session
// names and paths are argv elements, never shell-interpolated.

import { execFileP } from './exec.mjs'

// tmux is a local socket call: anything slower than a few seconds is wedged,
// and a wedged one must never hold up boot reconcile.
const TMUX_TIMEOUT_MS = 5_000

function tmux(args) {
  return execFileP('tmux', args, { maxBuffer: 4 * 1024 * 1024, timeout: TMUX_TIMEOUT_MS })
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
}

// The timeline surface's write path (#74): send-keys drives a session with
// ZERO attached clients, so no geometry is negotiated and the pane never
// learns how many devices exist (#72 leg 3). Same pane-scoped `=name:` target
// as capturePane, for the same window-rename reason.
//
// -l sends the text LITERALLY (no key-name interpretation); the separate
// Enter submits it.
export async function sendText(name, text) {
  await tmux(['send-keys', '-t', `=${name}:`, '-l', text])
  await tmux(['send-keys', '-t', `=${name}:`, 'Enter'])
}

export async function sendKey(name, key) {
  await tmux(['send-keys', '-t', `=${name}:`, key])
}

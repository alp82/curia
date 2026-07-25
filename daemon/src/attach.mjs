// Attach surface (#30, prototype.md §2–3): one shared ttyd serving the
// whitelisting wrapper, an idempotent Tailscale Serve assertion, and the
// runtime-derived attach base URL. ttyd runs with -a (URL ?arg= picks the
// session), which is exactly why the wrapper whitelist is a hard requirement.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { execFileP } from './exec.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Absolute paths only (challenge.md risk concern): the daemon may be started
// from any cwd — a relative wrapper path would make ttyd serve a nonexistent
// command and every attach would die.
export const WRAPPER_PATH = path.resolve(DIR, '..', 'bin', 'curia-attach.sh')
const TTYD_BIN = process.env.TTYD_BIN ?? '/home/alp/.local/bin/ttyd'

// Same regex as the wrapper script — the daemon-side refusal half of criterion 5.
export function validSessionName(s) {
  return /^curia-[A-Za-z0-9._-]+$/.test(s)
}

function portLive(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 750 })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
}

// The exact argv the shared ttyd is spawned with, exported so a test can pin
// the flags — nothing else guards against -O silently disappearing in an edit.
export function ttydArgv(ttydPort, wrapper = WRAPPER_PATH) {
  return ['-W', '-a', '-O', '-p', String(ttydPort), '-i', '127.0.0.1', wrapper]
}

// Find a ttyd process serving `port` via /proc cmdlines. /proc/<pid>/cmdline
// is mode 0444 and world-readable (verified against a root-owned process), so
// this matches OTHER users' ttyds too — it is a correlation heuristic, NOT an
// ownership proof. That is one reason ensureTtyd only ever kills a listener
// whose argv positively carries our wrapper (and a signal to a foreign-user
// pid fails with EPERM anyway). ttyd defaults to 7681 when -p is absent, so a
// flagless hand-started ttyd still matches.
function findTtydListener(port) {
  let pids
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  } catch {
    return null
  }
  const want = String(port)
  for (const pid of pids) {
    let raw
    try {
      raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } catch {
      continue // raced exit, or not ours to read
    }
    const argv = raw.split('\0').filter(Boolean)
    if (!argv.length) continue
    if (argv[0] !== TTYD_BIN && path.basename(argv[0]) !== 'ttyd') continue
    const pIdx = argv.indexOf('-p')
    if (pIdx !== -1 ? argv[pIdx + 1] !== want : want !== '7681') continue
    return { pid: Number(pid), argv }
  }
  return null
}

async function waitPortFree(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!(await portLive(port))) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !(await portLive(port))
}

// Ensure a HARDENED shared ttyd on the port. Returns { verified }: true when
// the listener now serving the port is positively our hardened one (our
// wrapper, origin check, loopback bind — or freshly spawned with exactly that
// argv AND observed live on the port). Every loud-warning adopt branch returns
// verified:false, and the CALLER must treat that as "do not publish": running
// assertServe over an unverified listener hands a writable no-origin-check
// terminal (or a bare shell) to the whole tailnet. -W writable, -a URL-arg
// session picking, localhost only.
//
// -O (--check-origin) is load-bearing, not a nicety: without it ttyd accepts
// cross-origin WebSocket upgrades, so ANY page loaded in a browser on ANY
// tailnet-connected device could open
// `wss://<host>:<serve_port>/ws?arg=curia-<n>` — session names are public issue
// numbers — and drive a writable terminal into a bypassPermissions worker (or
// the bare shell tmux.mjs leaves behind). The victim's browser supplies the
// network position, so tailnet membership is not the gate it looks like.
// What -O actually enforces (verified in tsl0922/ttyd src/protocol.c) is
// strcasecmp(Origin, Host) == 0 — Origin must EQUAL the request's Host
// header, NOT an allowlist of our hosts. Verified live through Tailscale
// Serve: a client whose Origin matches the served host:port attaches (Serve
// passes the Host header through) and a mismatched Origin is refused at the
// upgrade — but a DNS-rebinding page served from a name that resolves to this
// target sends Host and Origin that match EACH OTHER and passes. So -O is a
// same-origin *browser* control only; actual attach-surface auth (-c or an
// identity-aware proxy) is the deferred item.
//
// The verification predicate that authorises silently adopting a live
// listener: ours (serves our wrapper), origin-checked, AND loopback-bound.
// The bind check is load-bearing, not pedantry: -O is a *browser* control —
// a non-browser WebSocket client on the LAN forges Origin trivially — so a
// wrapper+-O ttyd bound to 0.0.0.0 would still hand a writable terminal into
// a bypassPermissions worker to the whole local network, and assertServe
// would republish it. Exported so the test can pin all three legs.
export function verifiedHardenedArgv(argv, wrapper = WRAPPER_PATH) {
  const iIdx = argv.indexOf('-i')
  return argv.includes(wrapper)
    && (argv.includes('-O') || argv.includes('--check-origin'))
    && iIdx !== -1 && argv[iIdx + 1] === '127.0.0.1'
}

// A live listener is NOT assumed to be that ttyd (adoption used to be blind):
// a ttyd started by a pre-hardening daemon — or by hand during the prototype
// work — would keep the origin hole open across every later restart while the
// daemon republished it to the tailnet. So the adopted listener's cmdline must
// pass verifiedHardenedArgv. The kill below is deliberately NARROWER than
// "not verified": only OUR OWN pre-hardening listener (our wrapper, no origin
// check) is killed and respawned — an operator's unrelated ttyd on this port,
// or anything else we cannot positively classify, is never SIGTERM'd; it is
// adopted with a LOUD log instead.
export async function ensureTtyd({ ttydPort, log = console.log }) {
  const wrapper = WRAPPER_PATH
  if (!path.isAbsolute(wrapper)) throw new Error(`ttyd wrapper path must be absolute (got "${wrapper}")`)
  if (await portLive(ttydPort)) {
    const found = findTtydListener(ttydPort)
    if (found && verifiedHardenedArgv(found.argv, wrapper)) {
      return { verified: true } // ours, hardened, loopback-bound
    }
    if (!found) {
      log(`WARNING: adopting an UNVERIFIABLE listener on ttyd port ${ttydPort} — no ttyd cmdline found in /proc; if this is a pre-hardening ttyd it accepts cross-origin WebSocket upgrades. Kill it and re-run reconcile.`)
      return { verified: false }
    }
    const oursPreHardening = found.argv.includes(wrapper)
      && !(found.argv.includes('-O') || found.argv.includes('--check-origin'))
    if (!oursPreHardening) {
      log(`WARNING: adopting an UNVERIFIED ttyd on port ${ttydPort} (pid ${found.pid}, argv: ${found.argv.join(' ')}) — it is not our hardened listener (wants our wrapper + -O/--check-origin + -i 127.0.0.1) but it is not positively ours to kill either. /attach stays on this UNVERIFIED listener; kill it and re-run reconcile.`)
      return { verified: false }
    }
    log(`ttyd on port ${ttydPort} (pid ${found.pid}) is ours but pre-hardening (our wrapper, no origin check) — killing and respawning hardened`)
    try {
      process.kill(found.pid, 'SIGTERM')
    } catch { /* already gone */ }
    if (!(await waitPortFree(ttydPort, 2000))) {
      try {
        process.kill(found.pid, 'SIGKILL')
      } catch { /* already gone */ }
      if (!(await waitPortFree(ttydPort, 2000))) {
        log(`WARNING: un-hardened ttyd on port ${ttydPort} (pid ${found.pid}) survived SIGKILL — /attach stays on an UNVERIFIED listener`)
        return { verified: false }
      }
    }
  }
  const child = spawn(TTYD_BIN, ttydArgv(ttydPort, wrapper), {
    detached: true,
    stdio: 'ignore',
  })
  // a missing/broken ttyd binary must degrade /attach, not crash the daemon
  // (an unhandled 'error' event on a detached child is fatal in node) — but
  // the swallow means a returned spawn() call proves NOTHING about a listener
  // existing. `verified` authorises a tailnet-wide publish, so it demands the
  // same positive evidence the adopt path does: the port must actually come
  // alive. Argv hardening is by construction (ttydArgv); liveness is probed.
  child.once('error', () => {})
  child.unref()
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await portLive(ttydPort)) return { verified: true } // spawned with ttydArgv, observed live
    await new Promise((r) => setTimeout(r, 100))
  }
  log(`WARNING: spawned ttyd for port ${ttydPort} but no listener came up within 2s (missing or broken ${TTYD_BIN}?) — /attach is down and nothing will be published`)
  return { verified: false }
}

// Idempotent (prototype.md §3, verified twice-in-a-row) — asserted on every
// reconcile rather than read-then-write, but ONLY over a verified listener.
export async function assertServe({ servePort, ttydPort }) {
  await execFileP('tailscale', ['serve', '--bg', `--https=${servePort}`, `http://127.0.0.1:${ttydPort}`])
}

// Withdraw the serve rule. Load-bearing counterpart to the verified:false
// branch above: `tailscale serve --bg` config PERSISTS in tailscaled across
// daemon restarts, so merely skipping assertServe never un-publishes a rule a
// previous run asserted — an unverified listener would stay published
// tailnet-wide until someone ran this by hand.
//
// "handler does not exist" is POSITIVE ABSENCE, not a failed withdrawal —
// the same classification rule as the tmux/gh reads. Verified live on this
// host: with no rule asserted, `tailscale serve --https=<port> off` exits 1
// with `error: failed to remove web serve: handler does not exist`. Letting
// that reject would fire the caller's REMAINS PUBLISHED warning on every
// clean boot — while nothing is exposed — training the operator to ignore
// the one time it is real. Anything else still rejects, so the loud path
// stays reachable. `exec` is a test seam only (defaults to the real thing).
export async function serveOff({ servePort, log = console.log, exec = execFileP }) {
  try {
    await exec('tailscale', ['serve', `--https=${servePort}`, 'off'])
  } catch (e) {
    if (/handler does not exist/i.test(`${e?.message ?? ''}\n${e?.stderr ?? ''}`)) {
      log(`no serve rule to withdraw on :${servePort} — nothing was published`)
      return
    }
    throw e
  }
}

// Tailnet DNS name from tailscale itself — never hardcoded.
let cachedBase = null
export async function attachBase() {
  if (!cachedBase) {
    const { stdout } = await execFileP('tailscale', ['status', '--json'], { maxBuffer: 8 * 1024 * 1024 })
    const dns = JSON.parse(stdout)?.Self?.DNSName
    if (!dns) throw new Error('tailscale status carries no Self.DNSName')
    cachedBase = dns.replace(/\.$/, '')
  }
  return cachedBase
}

export function attachUrl(base, servePort, n) {
  const session = `curia-${n}`
  if (!validSessionName(session)) throw new Error(`refusing attach URL for invalid session "${session}"`)
  return `https://${base}:${servePort}/?arg=${session}`
}

// Attach surface (#30, prototype.md §2–3): one shared ttyd serving the
// whitelisting wrapper, an idempotent Tailscale Serve assertion, and the
// runtime-derived attach base URL. ttyd runs with -a (URL ?arg= picks the
// session), which is exactly why the wrapper whitelist is a hard requirement.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { execFileP } from './exec.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Absolute paths only (challenge.md risk concern): the daemon may be started
// from any cwd — a relative wrapper path would make ttyd serve a nonexistent
// command and every attach would die.
export const WRAPPER_PATH = path.resolve(DIR, '..', 'bin', 'curia-attach.sh')
export const TTYD_BIN = process.env.TTYD_BIN ?? '/home/alp/.local/bin/ttyd'

// The attach page (#70, landing #69's variant A). Same class of owned asset as
// the wrapper above, and absolute for the same reason. It is a BUILT file:
// bin/build-attach-index.mjs injects attach-chrome.html and a viewport meta
// into ttyd's stock index, which inlines the whole client bundle.
export const DEFAULT_INDEX = path.resolve(DIR, '..', 'assets', 'attach-index.html')
export const CHROME_BASENAME = 'attach-chrome.html'
export const REBUILD_CMD = 'npm run build-attach-index --prefix daemon'

// Same regex as the wrapper script — the daemon-side refusal half of criterion 5.
export function validSessionName(s) {
  return /^curia-[A-Za-z0-9._-]+$/.test(s)
}

// ---- the chat handle: an agent with no ticket (#241) ------------------------
//
// Every curia agent until now was named by an issue number, because every one
// of them was dispatched ON an issue. `map -- <prose>` breaks that: it charts a
// map that does not exist yet, so there is no number to name the session, the
// tmux pane, the config dir or the thread with — and the operator still has to
// reach it with `attach`, `cancel` and `resume`.
//
// The operator's ruling (#241): ENUMERATE the ticketless ones. `chat-1`,
// `chat-2`, and so on — the lowest free index at dispatch — each with its own
// thread, all of them live at once. That is deliberately a general principle
// and not a new-map special case: a chat is any agent curia runs that no issue
// answers for, and the next kind of one gets its handle from here too.
//
// So the handle IS the identity: session `curia-chat-1`, `attach chat-1`,
// `cancel chat-1`, `resume chat-1`, and `chat-1` in the `status` list.
//
// It lives HERE because attach.mjs owns the session-name vocabulary and is the
// one module the command surface and the dispatcher both already import. The
// regex above takes it as it stands: session names were never numeric-only.
export const CHAT_PREFIX = 'chat-'
export const CHAT_HANDLE_RE = /^chat-\d+$/
export const isChatHandle = (s) => CHAT_HANDLE_RE.test(String(s ?? ''))
export const chatHandle = (i) => `${CHAT_PREFIX}${i}`
export const chatSession = (i) => `curia-${chatHandle(i)}`

// The lowest index no live session already holds. `taken` is every session name
// curia knows about — its own table plus what tmux reports — because the index
// has to be free on the BOX, not merely in this process's memory: the same rule
// that makes the dispatch locks ask tmux rather than the agents map.
export function nextChatHandle(taken = []) {
  const used = new Set()
  for (const s of taken) {
    const m = String(s).match(/^curia-chat-(\d+)$/)
    if (m) used.add(Number(m[1]))
  }
  let i = 1
  while (used.has(i)) i += 1
  return chatHandle(i)
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
//
// -t rendererType=dom is NOT cosmetic (#69): ttyd's default is `webgl`, which
// renders NOTHING in Vivaldi or Firefox — socket open, grid sized, theme
// applied, zero console errors, blank screen. It broke the destination's "the
// PC attaches to the same live session" leg on the browser this operator uses.
// `dom` is also the accessible renderer: real DOM text, so selection and
// screen readers work. It has to be a flag, not page script, because xterm
// picks its renderer while ttyd's bundle boots.
//
// -I is the owned index. A custom index is unavoidable, not a preference:
// <meta name="viewport"> can be set by no flag, and ttyd 1.7.7 ships none, so
// a phone lays the page out at ~980 CSS px and scales it down.
export function ttydArgv(ttydPort, { wrapper = WRAPPER_PATH, index = DEFAULT_INDEX } = {}) {
  return [
    '-W', '-a', '-O', '-p', String(ttydPort), '-i', '127.0.0.1',
    '-t', 'rendererType=dom', '-I', index, wrapper,
  ]
}

// ---------------------------------------------------------------------------
// The index asset is BUILT, so it can go stale in two directions, and both
// failures are silent by nature — the page still loads, it is just not the
// surface anyone agreed to. #69 happened exactly this way twice: spike #32's
// fontSize and key-bar were proven and then lost, and nothing reported it.
//
//   1. ttyd is upgraded. The built index embeds the client bundle of the ttyd
//      it was built from, so it is now a stale client against a newer server.
//   2. attach-chrome.html is edited and nobody rebuilds. The reviewed source
//      and the served bytes disagree, and the diff a reviewer reads is the one
//      that is NOT being served.
//
// So the builder stamps both into the page, and the daemon re-checks them on
// every reconcile. A ttyd upgrade taking attach down until someone rebuilds is
// the intended cost: "survives an upgrade automatically" means the attach
// surface changes without anyone deciding, which is #69's whole lesson.
export const STAMP_NAME = 'curia-attach-index'
const STAMP_RE = new RegExp(`<meta name="${STAMP_NAME}" content="([^"]*)">`)

export function stampMeta({ ttyd, chrome }) {
  return `<meta name="${STAMP_NAME}" content="ttyd=${ttyd};chrome=${chrome}">`
}

export function sha256(buf) {
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`
}

// Only the head is read: ttyd's own bundle is ~730 KB of inlined script at the
// end of the body, and the builder puts the stamp immediately after <head>.
export function readIndexStamp(indexFile) {
  let head
  try {
    const fd = fs.openSync(indexFile, 'r')
    try {
      const buf = Buffer.alloc(8192)
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const m = STAMP_RE.exec(head)
  if (!m) return null
  const out = {}
  for (const pair of m[1].split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return out
}

// `ttyd --version` prints "ttyd version 1.7.7-40e79c7" and exits 0. Null on
// any failure, which the caller must read as "cannot tell", never as a
// mismatch.
export function ttydVersion(bin = TTYD_BIN) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 })
    return /ttyd version (\S+)/.exec(out)?.[1] ?? null
  } catch {
    return null
  }
}

// Is the built index the one this box should be serving? Returns a refusal
// reason, or null when nothing POSITIVELY says otherwise.
//
// The asymmetry is deliberate and is the rule #33 paid for four times: a
// failed read is not evidence. An unreadable `ttyd --version`, or a chrome
// source that is not there to compare against (an operator may point
// attach.index at a page of their own), leaves the question open — and an open
// question must not take the attach surface down. Only a stamp that is
// positively different, or an index that is positively absent, refuses.
export function indexRefusal({ indexFile, log = console.log, version = ttydVersion, digest = fileDigest } = {}) {
  if (!fs.existsSync(indexFile)) {
    return `attach index ${indexFile} does not exist — run \`${REBUILD_CMD}\``
  }
  const stamp = readIndexStamp(indexFile)
  if (!stamp) {
    return `attach index ${indexFile} carries no ${STAMP_NAME} stamp — it was not built by \`${REBUILD_CMD}\``
  }

  const installed = version()
  if (!installed) {
    log(`attach: could not read \`ttyd --version\` — cannot tell whether the index (built for ttyd ${stamp.ttyd}) matches the installed ttyd; NOT treating that as a mismatch`)
  } else if (stamp.ttyd !== installed) {
    return `attach index ${indexFile} was built for ttyd ${stamp.ttyd} but ttyd ${installed} is installed — it embeds that ttyd's whole client bundle; run \`${REBUILD_CMD}\``
  }

  const chromeFile = path.join(path.dirname(indexFile), CHROME_BASENAME)
  const built = digest(chromeFile)
  if (!built) {
    log(`attach: no ${CHROME_BASENAME} beside ${indexFile} — cannot tell whether the served page matches its source; NOT treating that as a mismatch`)
  } else if (stamp.chrome !== built) {
    return `attach index ${indexFile} was built from a different ${CHROME_BASENAME} than the one on disk — the reviewed source is not what is served; run \`${REBUILD_CMD}\``
  }
  return null
}

export function fileDigest(file) {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return null
  }
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
// numbers — and drive a writable terminal into a bypassPermissions agent (or
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
// ttyd writes a NUL over the '=' in `-t key=value` while parsing, so
// /proc/<pid>/cmdline shows `-t`, `rendererType`, `dom` where execve was
// handed `-t`, `rendererType=dom`. Verified live against a running ttyd. An
// argv check that looks for the joined form can therefore never match — and a
// check that never matches is the silent loss this whole ticket is about, one
// layer up. Both sides are put in the joined form before comparing.
export function canonicalArgv(argv) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-t') { out.push(argv[i]); continue }
    let v = argv[i + 1]
    if (v === undefined) { out.push('-t'); continue }
    i++
    if (!v.includes('=') && argv[i + 1] !== undefined) { v = `${v}=${argv[i + 1]}`; i++ }
    out.push('-t', v)
  }
  return out
}

// The verification predicate that authorises silently adopting a live
// listener. It used to check three legs — our wrapper, -O, loopback bind —
// which a STOCK ttyd serving our wrapper passes in full: reconcile would have
// adopted a chrome-less, blank-rendering listener and reported it verified
// (#70). So it now compares the FULL expected argv. Every flag is load-bearing
// and each has its own reason, recorded at ttydArgv:
//
//   -O            the cross-origin WebSocket hijack #33 closed. Without it any
//                 page in any browser on any tailnet device can drive a
//                 writable terminal into a bypassPermissions agent.
//   -i 127.0.0.1  -O is a *browser* control; a non-browser client on the LAN
//                 forges Origin trivially, so the bind is the real edge.
//   -a + wrapper  ?arg= session picking (#30), whitelisted to ^curia- by the
//                 wrapper — without the wrapper, -a hands out attach to any
//                 tmux session on the box.
//   -t/-I         the surface #69 chose. Not security, but exactly as easy to
//                 lose, and losing it is what happened twice.
//
// `observed` is a full /proc argv (argv[0] included, stripped here); `expected`
// is what ttydArgv returns.
export function verifiedHardenedArgv(observed, expected) {
  const a = canonicalArgv(observed.slice(1))
  const b = canonicalArgv(expected)
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// What differs, for the log line. A kill-and-respawn that does not say why is
// how a respawn LOOP goes unnoticed.
function argvDiff(observed, expected) {
  const a = canonicalArgv(observed.slice(1))
  const b = canonicalArgv(expected)
  const missing = b.filter((v) => !a.includes(v))
  const extra = a.filter((v) => !b.includes(v))
  const parts = []
  if (missing.length) parts.push(`missing ${missing.join(' ')}`)
  if (extra.length) parts.push(`unexpected ${extra.join(' ')}`)
  if (!parts.length) parts.push('same flags, different order')
  return parts.join('; ')
}

// A live listener is NOT assumed to be that ttyd (adoption used to be blind):
// a ttyd started by a pre-hardening daemon — or by hand during the prototype
// work — would keep the origin hole open across every later restart while the
// daemon republished it to the tailnet. So the adopted listener's cmdline must
// pass verifiedHardenedArgv, and the two branches below split on what we can
// positively prove about it.
export async function ensureTtyd({ ttydPort, index = DEFAULT_INDEX, log = console.log }) {
  const wrapper = WRAPPER_PATH
  if (!path.isAbsolute(wrapper)) throw new Error(`ttyd wrapper path must be absolute (got "${wrapper}")`)
  if (!path.isAbsolute(index)) throw new Error(`ttyd index path must be absolute (got "${index}")`)

  // Before anything is spawned or published: is the page we would serve the
  // one that was agreed? A stale index is not a tailnet exposure, so this is
  // the one refusal that is about the surface rather than the security edge —
  // but it is refused the same way, because a blank terminal on the operator's
  // own browser is what #69 cost.
  const refusal = indexRefusal({ indexFile: index, log })
  if (refusal) {
    log(`WARNING: ${refusal} — refusing to publish the attach surface`)
    return { verified: false }
  }
  const expected = ttydArgv(ttydPort, { wrapper, index })

  if (await portLive(ttydPort)) {
    const found = findTtydListener(ttydPort)
    if (found && verifiedHardenedArgv(found.argv, expected)) {
      return { verified: true } // ours, hardened, loopback-bound, our surface
    }
    if (!found) {
      log(`WARNING: adopting an UNVERIFIABLE listener on ttyd port ${ttydPort} — no ttyd cmdline found in /proc; if this is a pre-hardening ttyd it accepts cross-origin WebSocket upgrades. Kill it and re-run reconcile.`)
      return { verified: false }
    }
    // Deliberately NARROWER than "not verified": only a listener that is
    // POSITIVELY ours — it serves our wrapper, which nothing else on this box
    // does — is killed. An operator's unrelated ttyd on this port, or anything
    // we cannot classify, is adopted with a loud log and never signalled.
    //
    // #70 widened what counts as "ours but wrong": it used to be "our wrapper,
    // no origin check", so a listener of ours that was merely missing -I (or
    // carrying a stale one, or bound to 0.0.0.0) fell through to the adopt
    // branch and stayed. It is ours, we know what it should be, and we can
    // replace it — so we do.
    if (!found.argv.includes(wrapper)) {
      log(`WARNING: adopting an UNVERIFIED ttyd on port ${ttydPort} (pid ${found.pid}, argv: ${found.argv.join(' ')}) — it does not serve our wrapper, so it is not positively ours to kill. /attach stays on this UNVERIFIED listener; kill it and re-run reconcile.`)
      return { verified: false }
    }
    log(`ttyd on port ${ttydPort} (pid ${found.pid}) is ours but is not the asserted attach surface (${argvDiff(found.argv, expected)}) — killing and respawning`)
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
  const child = spawn(TTYD_BIN, expected, {
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
    if (await portLive(ttydPort)) {
      // Our own fresh spawn must be re-adoptable by the predicate, or the next
      // reconcile classifies it as "ours but wrong", kills it, and spawns
      // another — a respawn loop that would look like a healthy attach surface
      // from outside. This says so instead. It does NOT downgrade `verified`:
      // the listener was spawned from `expected` by construction and observed
      // live, which is the positive evidence a publish needs.
      const back = findTtydListener(ttydPort)
      if (back && !verifiedHardenedArgv(back.argv, expected)) {
        log(`WARNING: the ttyd just spawned on port ${ttydPort} does not pass our own verification (${argvDiff(back.argv, expected)}) — every reconcile will now kill and respawn it. This is a curia bug, not a ttyd one.`)
      }
      return { verified: true } // spawned with ttydArgv, observed live
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  log(`WARNING: spawned ttyd for port ${ttydPort} but no listener came up within 2s (missing or broken ${TTYD_BIN}?) — /attach is down and nothing will be published`)
  return { verified: false }
}

// Idempotent (prototype.md §3, verified twice-in-a-row) — asserted on every
// reconcile rather than read-then-write, but ONLY over a verified listener.
//
// `targetPort` is the loopback port the rule points at, which since #151 is no
// longer ttyd's own: the terminal surface publishes the identity proxy, and the
// proxy is what reaches ttyd. The timeline has always passed its own port here,
// so the old `ttydPort` name was already telling two stories.
export async function assertServe({ servePort, targetPort }) {
  await execFileP('tailscale', ['serve', '--bg', `--https=${servePort}`, `http://127.0.0.1:${targetPort}`])
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

// The URL for one named session. Since #164 a ticket can carry two — the
// builder `curia-<n>` and the cross-check reviewer `curia-review-<n>` — so the
// SESSION is the argument, and attachUrl keeps the ticket-shaped call every
// existing caller makes.
export function attachSessionUrl(base, servePort, session) {
  if (!validSessionName(session)) throw new Error(`refusing attach URL for invalid session "${session}"`)
  return `https://${base}:${servePort}/?arg=${session}`
}

export function attachUrl(base, servePort, n) {
  return attachSessionUrl(base, servePort, `curia-${n}`)
}

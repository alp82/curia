// Attach surface (#30, prototype.md §2–3): one shared ttyd serving the
// whitelisting wrapper, an idempotent Tailscale Serve assertion, and the
// runtime-derived attach base URL. ttyd runs with -a (URL ?arg= picks the
// session), which is exactly why the wrapper whitelist is a hard requirement.
//
// #260: ttyd is COMPOSE'S to run now — deploy/compose.yaml spawns it in its
// own container, and the hardened argv (-O, loopback bind, the wrapper, the
// owned index) lives there, pinned by attach.test.mjs. The daemon only
// health-checks the port; the old spawn/verify/kill machinery is gone with
// the process it managed.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileP } from './exec.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Absolute paths only (challenge.md risk concern): the daemon may be started
// from any cwd — a relative wrapper path would make ttyd serve a nonexistent
// command and every attach would die.
export const WRAPPER_PATH = path.resolve(DIR, '..', 'bin', 'curia-attach.sh')

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
// of them was dispatched ON an issue. `map <prose>` breaks that: it charts a
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

// ---- the console key: a browser conversation (#333, ADR-0016) ---------------
//
// The overseer keeps one conversation per key. A Discord conversation is keyed
// on the thread snowflake, which is all digits. A browser conversation is keyed
// `console-<n>`, which always starts with a letter, so the two shapes cannot
// collide. The browser had ONE key forever, `console`, and a conversation that
// never ends rots its own context and compacts badly. Now it gets many, and a
// new one is the reset a new Discord thread already is.
//
// This lives beside the chat handle above because of the one rule that binds
// them: `chat-<n>` is NOT available to a conversation. It names a ticketless
// agent, whose session is `curia-chat-<n>`. Two enumerated handle spaces on one
// box have to be read together or one of them takes the other's name.
//
// The other difference from the chat handle is the counter, and it is the whole
// reason this is not one function with two prefixes. A chat handle takes the
// LOWEST FREE index, because an agent is torn down whole and its number means
// nothing afterwards. A conversation is MEMORY: the transcript stays on disk
// and the journal keeps the key, so a reused number would wake the deleted
// conversation. Conversation numbers only go up.
export const CONSOLE_PREFIX = 'console-'
export const CONSOLE_KEY_RE = /^console-\d+$/
export const isConsoleKey = (s) => CONSOLE_KEY_RE.test(String(s ?? ''))
export const consoleKey = (n) => `${CONSOLE_PREFIX}${n}`
export const consoleSession = (n) => `curia-${consoleKey(n)}`

// The key a session name serves, or null for every other session, and the way
// back. These two are the one place the timeline's `curia-console-3` and the
// conversation key `console-3` become each other, so nothing else has to know
// that the session name is the key with `curia-` in front of it.
export function consoleKeyForSession(session) {
  const m = String(session ?? '').match(/^curia-(console-\d+)$/)
  return m ? m[1] : null
}
export const sessionForConsoleKey = (key) => `curia-${key}`

// One higher than the highest number ever spent. `spent` is every key ever
// minted, live and deleted alike — the deleted ones are what makes this differ
// from nextChatHandle, and dropping them would hand a new conversation the last
// one's memory.
export function nextConsoleKey(spent = []) {
  let high = 0
  for (const k of spent) {
    const m = String(k).match(/^console-(\d+)$/)
    if (m) high = Math.max(high, Number(m[1]))
  }
  return consoleKey(high + 1)
}

function portLive(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 750 })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
}

// The hardened ttyd argv lives in deploy/compose.yaml now (#260), and
// attach.test.mjs pins its security flags there — nothing else guards against
// -O silently disappearing in an edit. The reasons stay recorded beside the
// command in the compose file: -O (cross-origin upgrade refusal), the loopback
// bind (-O is a browser control, not LAN auth), -a plus the wrapper whitelist,
// and the #69 surface (-t rendererType=dom, -I owned index).

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

// Is the built index the one this box should be serving? Returns a refusal
// reason, or null when nothing POSITIVELY says otherwise.
//
// The asymmetry is deliberate and is the rule #33 paid for four times: a
// failed read is not evidence. A chrome source that is not there to compare
// against (an operator may point attach.index at a page of their own) leaves
// the question open — and an open question must not take the attach surface
// down. Only a stamp that is positively different, or an index that is
// positively absent, refuses.
//
// The index-vs-installed-ttyd comparison retired with the spawn (#260): the
// stamp still records the ttyd the index was built from, and the pin it must
// match is deploy/tmux/Dockerfile's TTYD_VERSION — a test holds the two
// together, because the daemon's own container carries no ttyd to ask.
export function indexRefusal({ indexFile, log = console.log, digest = fileDigest } = {}) {
  if (!fs.existsSync(indexFile)) {
    return `attach index ${indexFile} does not exist — run \`${REBUILD_CMD}\``
  }
  const stamp = readIndexStamp(indexFile)
  if (!stamp) {
    return `attach index ${indexFile} carries no ${STAMP_NAME} stamp — it was not built by \`${REBUILD_CMD}\``
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

// The health-check that replaced the spawn (#260). compose runs ttyd in its
// own container with the hardened argv; the daemon can neither spawn it nor
// read its /proc from another pid namespace, so the old adopt/verify/kill
// machinery has nothing left to manage. What the daemon still owns is the
// DECISION TO PUBLISH: `verified: true` authorises a tailnet-wide serve rule,
// and it demands the index be the agreed surface and the port be positively
// alive. A dead port is a down ttyd service, and nothing gets published over
// it.
//
// What this deliberately no longer proves: that the listener IS our hardened
// ttyd. That guarantee moved into deploy/compose.yaml — the only thing that
// binds 7681 on the box is the ttyd service, whose command is reviewed and
// pinned by attach.test.mjs. A foreign process racing the container to a
// loopback port was a real adversary when the daemon spawned ttyd late; under
// compose the container holds the port for the box's whole uptime.
export async function probeTtyd({ ttydPort, index = DEFAULT_INDEX, log = console.log }) {
  if (!path.isAbsolute(index)) throw new Error(`ttyd index path must be absolute (got "${index}")`)

  // Is the page being served the one that was agreed? A stale index is not a
  // tailnet exposure, but a blank terminal on the operator's own browser is
  // what #69 cost, so it refuses the same way.
  const refusal = indexRefusal({ indexFile: index, log })
  if (refusal) {
    log(`WARNING: ${refusal} — refusing to publish the attach surface`)
    return { verified: false }
  }
  if (!(await portLive(ttydPort))) {
    log(`WARNING: no listener on ttyd port ${ttydPort} — is the compose ttyd service up? /attach is down and nothing will be published`)
    return { verified: false }
  }
  return { verified: true }
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

export function appTerminalUrl(base, servePort, session) {
  if (!validSessionName(session)) throw new Error(`refusing terminal URL for invalid session "${session}"`)
  return `https://${base}:${servePort}/terminal/?arg=${session}`
}

// The Chat route under Curia app (#711). The timeline's own Serve rule retired
// with that ticket, so every chat link a human gets now lands on the sidecar's
// address, at the transcript surface for one session.
export function appChatUrl(base, servePort, session) {
  if (!validSessionName(session)) throw new Error(`refusing chat URL for invalid session "${session}"`)
  return `https://${base}:${servePort}/#chat/${session}`
}

export function attachUrl(base, servePort, n) {
  return attachSessionUrl(base, servePort, `curia-${n}`)
}

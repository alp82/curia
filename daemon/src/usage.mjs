// Status-line meters (#146): the numbers Claude Code's own status line shows a
// human about a session, computed by the daemon about a worker — the routing
// model and its reasoning effort, how full the context is, and the two account
// usage windows.
//
// THREE SOURCES, and the split is the whole design:
//
//   model + effort  the routing pick and `models.<name>.reasoning_effort`.
//                   The daemon already knows both at dispatch; nothing is read.
//
//   context %       the worker's own transcript tail, the same file the
//                   timeline (#74) reads. Both lanes state their last request's
//                   input tokens; only the codex lane also states the window,
//                   so the claude lane takes it from `models.<name>.context_window`.
//                   A model with no configured window shows NO context figure —
//                   a guessed denominator is a wrong percentage, and this line
//                   exists to be trusted.
//
//   5 h / 7 d bars  ACCOUNT-level, not per worker: every worker on a provider
//                   shares one quota, so this is one reading rendered on every
//                   line. The codex lane gets it free — its transcript carries
//                   `rate_limits` beside every token count. The claude lane has
//                   no such line anywhere in its transcript, so the only source
//                   is the account usage endpoint the CLI itself polls, reached
//                   through the shared credential store.
//
// WHAT THE DAEMON MAY DO WITH THAT CREDENTIAL (the ticket's open question).
// Reading the token and issuing the same read-only GET the CLI issues does not
// touch any worker's session. Two rules keep it that way, and both are load
// bearing:
//
//   1. The daemon NEVER refreshes the token and never writes
//      `.credentials.json`. A refresh rotates the refresh token, and every
//      live CLI session on the box holds the old one. So a 401 is terminal
//      here: fetching stops until the CLI rewrites the file itself, which the
//      mtime reports.
//   2. The endpoint's budget is shared with every status line on the box, so
//      the attempt stamp beside the cache is a cooperative lock. The operator's
//      own statusline.sh writes the same two files under the same rules, so the
//      two throttle each other instead of racing, and each one's fetch keeps
//      the other fresh.
//
// The read path costs nothing and always runs; the fetch is what
// `usage.account_bars` turns off.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findTranscript } from './transcript.mjs'

// A transcript grows to megabytes and only its tail carries the live numbers.
// Generous enough that one very large final record still lands whole.
const TAIL_BYTES = 512 * 1024

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// Past this age the reading is refetched, if fetching is on at all.
export const USAGE_STALE_MS = 30 * 60 * 1000
// And never more often than this, counted across every fetcher on the box.
export const USAGE_ATTEMPT_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000

// ---------------------------------------------------------------------------
// transcript tail
// ---------------------------------------------------------------------------

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs } catch { return 0 }
}

// The last whole lines of a file. A tail that starts mid-file opens on a
// fragment, so the first line is dropped rather than parsed.
export function tailLines(file) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return [] }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    fs.closeSync(fd)
  }
}

// Context is everything the last request SENT, cached or not: a cache read
// occupies the window exactly like a fresh token does. Measured on real worker
// transcripts on this box — the claude lane states no window anywhere, so the
// caller supplies it.
function claudeTail(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line.includes('"usage"')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const u = e?.message?.usage
    if (!u) continue
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      + (u.cache_creation_input_tokens ?? 0)
    if (!tokens) continue
    return { ctx: { tokens, window: null }, windows: null }
  }
  return { ctx: null, windows: null }
}

// How far into a usage window the clock has got, 0-100 — the second number
// every bar needs, because usage alone cannot say whether it is being spent too
// fast. `resetsAt` is an epoch-seconds number on the codex lane and an ISO
// string on the anthropic one; both are absolute, so a stale reading still
// dates itself correctly.
//
// Three outcomes, and they are genuinely different:
//   {elapsedPct}       the pace signal — how far through the window we are
//   {elapsedPct: null} no reset stated: keep the reading, show a flat bar
//   {expired: true}    the window already reset, so the percentage beside it
//                      belongs to a window that no longer exists. Drop it.
export function paceOf(resetsAt, windowMs, now = Date.now()) {
  const at = typeof resetsAt === 'number' ? resetsAt * 1000 : Date.parse(resetsAt ?? '')
  if (!Number.isFinite(at) || !Number.isFinite(windowMs) || windowMs <= 0) return { elapsedPct: null }
  const remaining = at - now
  if (remaining <= 0) return { expired: true }
  // A reset further out than the window itself is not this window's reset.
  if (remaining > windowMs) return { elapsedPct: null }
  return { elapsedPct: Math.max(0, Math.min(100, Math.round(((windowMs - remaining) / windowMs) * 100))) }
}

// 300 -> "5h", 10080 -> "7d". The label is derived, never assumed: codex calls
// its windows primary/secondary and which one is the short one depends on the
// plan (a plus account was measured with a WEEKLY primary and no secondary).
export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  return `${Math.round(minutes / 60)}h`
}

// The codex lane states all three numbers itself, on the `token_count` event it
// writes after every turn: the last request's input tokens, the model's own
// context window, and the account rate limits. Context and limits are taken
// from the newest line that carries each — not every token_count carries both.
function codexTail(lines, now) {
  let ctx = null
  let windows = null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line.includes('"token_count"')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const p = e?.payload
    if (p?.type !== 'token_count') continue
    if (!ctx) {
      const tokens = p.info?.last_token_usage?.input_tokens
      if (Number.isFinite(tokens) && tokens > 0) {
        ctx = { tokens, window: p.info?.model_context_window ?? null }
      }
    }
    if (!windows) {
      const found = []
      for (const slot of ['primary', 'secondary']) {
        const r = p.rate_limits?.[slot]
        if (!r || !Number.isFinite(r.used_percent)) continue
        const label = windowLabel(r.window_minutes)
        if (!label) continue
        // A worker that has been idle for hours may hold a reading whose window
        // has since reset. The percentage beside it is then about a window that
        // no longer exists, so the entry goes rather than lying.
        const pace = paceOf(r.resets_at, r.window_minutes * 60 * 1000, now)
        if (pace.expired) continue
        found.push({ label, pct: Math.round(r.used_percent), elapsedPct: pace.elapsedPct })
      }
      if (found.length) windows = found
    }
    if (ctx && windows) break
  }
  return { ctx, windows }
}

const TAILS = { claude: claudeTail, codex: codexTail }

// { ctx: {tokens, window} | null, windows: [{label, pct, elapsedPct}] | null }
export function readTranscriptMeters(backend, file, now = Date.now()) {
  const tail = TAILS[backend]
  if (!tail || !file) return { ctx: null, windows: null }
  return tail(tailLines(file), now)
}

// ---------------------------------------------------------------------------
// the anthropic account reading
// ---------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// Both the endpoint's response and the CLI's persisted copy carry the same two
// top-level windows. Percentages only — the dollar fields are null on a
// subscription account. The window lengths are not stated, so they are named
// here: they are what `five_hour` and `seven_day` mean.
const ANTHROPIC_WINDOWS = [
  { key: 'five_hour', label: '5h', ms: 5 * 60 * 60 * 1000 },
  { key: 'seven_day', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
]

export function accountWindows(payload, now = Date.now()) {
  const out = []
  for (const w of ANTHROPIC_WINDOWS) {
    const v = payload?.[w.key]
    if (!Number.isFinite(v?.utilization)) continue
    const p = paceOf(v.resets_at, w.ms, now)
    if (p.expired) continue
    out.push({ label: w.label, pct: Math.round(v.utilization), elapsedPct: p.elapsedPct })
  }
  return out.length ? out : null
}

export class AccountUsage {
  // `fetch` is injected so the test never reaches the network. `home` is the
  // DAEMON's home — never a worker config dir: workers run headless and their
  // own `.claude.json` carries no usage copy (measured: every worker cfg dir on
  // this box has `cachedUsageUtilization: null`).
  constructor({
    home = os.homedir(), enabled = true, log = () => {},
    now = () => Date.now(), fetchImpl = globalThis.fetch, version = '2.1.211',
  } = {}) {
    this.home = home
    this.enabled = enabled
    this.log = log
    this.now = now
    this.fetchImpl = fetchImpl
    this.version = version
    this.cliFile = path.join(home, '.claude.json')
    this.credFile = path.join(home, '.claude', '.credentials.json')
    this.cacheFile = path.join(home, '.claude', 'cache', 'oauth-usage.json')
    this.stampFile = path.join(home, '.claude', 'cache', 'oauth-usage.attempt')
    this.fetching = false
    this.refusedFor = null // the credential mtime a 401 was measured against
    this.pending = Promise.resolve() // the in-flight refresh, for the tests to await
  }

  // The freshest of the two readings on disk. The CLI's own copy states when it
  // was fetched; the cooperative cache file dates by mtime.
  #best() {
    const found = []
    const now = this.now()
    const cli = readJson(this.cliFile)?.cachedUsageUtilization
    if (cli?.utilization && Number.isFinite(cli.fetchedAtMs)) {
      found.push({ at: cli.fetchedAtMs, windows: accountWindows(cli.utilization, now) })
    }
    const cached = readJson(this.cacheFile)
    if (cached) found.push({ at: mtimeMs(this.cacheFile), windows: accountWindows(cached, now) })
    const best = found.filter((f) => f.windows).sort((a, b) => b.at - a.at)[0]
    return best ?? null
  }

  // [{label, pct}] | null — the read never blocks; a refresh it decides to run
  // lands on a later call.
  windows() {
    const best = this.#best()
    if (this.enabled) this.#maybeFetch(best)
    return best?.windows ?? null
  }

  #maybeFetch(best) {
    if (this.fetching || !this.fetchImpl) return
    const now = this.now()
    if (best && now - best.at < USAGE_STALE_MS) return
    // The shared throttle: whoever touched the stamp last owns this window,
    // daemon or statusline.sh.
    if (now - mtimeMs(this.stampFile) < USAGE_ATTEMPT_MS) return
    const cred = mtimeMs(this.credFile)
    // A refused token stays refused until the CLI writes a new one. The daemon
    // does not refresh it — see the module header.
    if (this.refusedFor && this.refusedFor === cred) return
    try {
      fs.mkdirSync(path.dirname(this.stampFile), { recursive: true })
      fs.writeFileSync(this.stampFile, '')
    } catch {
      return // cannot take the lock; do not fetch unthrottled
    }
    this.fetching = true
    this.pending = this.#fetch(cred)
      .catch((e) => this.log(`account usage fetch failed: ${e.message}`))
      .finally(() => { this.fetching = false })
  }

  async #fetch(credMtime) {
    const token = readJson(this.credFile)?.claudeAiOauth?.accessToken
    if (!token) return
    const res = await this.fetchImpl(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
        'user-agent': `claude-cli/${this.version} (external, cli)`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) {
      this.refusedFor = credMtime
      this.log(`account usage: the CLI credential was refused (${res.status}) — the daemon does not refresh it; the bars stay at their last reading until a CLI session writes a new token`)
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    if (!accountWindows(payload)) throw new Error('response carries no usage windows')
    const tmp = `${this.cacheFile}.tmp`
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(payload))
    fs.renameSync(tmp, this.cacheFile)
  }
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

export const BAR_WIDTH = 10

// The pace thresholds, lifted from the operator's own statusline.sh so the two
// surfaces agree on what "burning too fast" means. Half a cell either way of
// the clock counts as on pace.
const AHEAD = 5
const BEHIND = -5

// The status light. Pace, not raw usage: 92% spent with the window nearly over
// is fine, and 40% spent in the first hour is not. Squares rather than circles
// (the operator picked them off a live phone). Null when no reset time is
// stated, because pace is unknowable then.
export function paceMark(usedPct, elapsedPct) {
  if (elapsedPct == null) return null
  const diff = usedPct - elapsedPct
  if (diff > AHEAD) return '🟥'
  if (diff >= BEHIND) return '🟨'
  return '🟩'
}

// The bar carries what the operator's terminal carries in two rows of colour,
// in one row of text: `┃` sits where the window's clock has got to, and every
// filled cell PAST it is overshoot — spending not yet earned — so it renders
// solid instead of shaded. The divider sits between cells rather than replacing
// one, so the bar keeps all `width` steps of resolution.
//
// With no elapsed percentage there is no clock and no overshoot, so it falls
// back to the plain fill.
export function bar(pct, elapsedPct = null, width = BAR_WIDTH) {
  const cells = (p) => Math.max(p > 0 ? 1 : 0, Math.min(width, Math.round((p / 100) * width)))
  const used = cells(pct)
  if (elapsedPct == null) return '▓'.repeat(used) + '░'.repeat(width - used)
  const clock = cells(elapsedPct)
  let out = ''
  for (let i = 0; i < width; i += 1) {
    if (i === clock) out += '┃'
    out += i < used ? (i < clock ? '▓' : '█') : '░'
  }
  return clock >= width ? `${out}┃` : out
}

// Everything the status line can say about one worker beyond its state. Every
// field is independently nullable — a missing source drops its meter, never the
// line.
export function workerMeters({ backend, cfgDir, model, routing, account, now = Date.now() }) {
  const spec = routing?.models?.[model] ?? null
  const out = { model: model ?? null, effort: spec?.reasoning_effort ?? null, ctxPct: null, windows: null }
  if (!backend || !cfgDir) return out

  const { ctx, windows } = readTranscriptMeters(backend, findTranscript(backend, cfgDir), now)
  const window = ctx?.window ?? spec?.context_window ?? null
  if (ctx && window > 0) out.ctxPct = Math.min(100, Math.round((ctx.tokens / window) * 100))

  // The transcript's own limits win — they are this provider's numbers,
  // measured at the worker's last turn. Only the anthropic lane needs the
  // account reading, because its transcript states none.
  if (windows) out.windows = windows
  else if (spec?.provider === 'anthropic') out.windows = account?.windows() ?? null
  return out
}

// Ordered most valuable first: the status line appends what fits and drops the
// rest from the tail (#146 — state and escalation title win over the meters).
// The window label carries bold because it is the thing the eye lands on when
// scanning a column of workers, and the mark leads the bar for the same reason.
export function meterParts(m) {
  if (!m) return []
  const parts = []
  if (m.model) parts.push(m.effort ? `**${m.model}** ${m.effort}` : `**${m.model}**`)
  if (m.ctxPct != null) parts.push(`ctx ${m.ctxPct}%`)
  for (const w of m.windows ?? []) {
    const mark = paceMark(w.pct, w.elapsedPct)
    parts.push(`**${w.label}** ${mark ? `${mark} ` : ''}${bar(w.pct, w.elapsedPct)} ${w.pct}%`)
  }
  return parts
}

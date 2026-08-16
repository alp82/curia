// Status-line meters (#146): the numbers Claude Code's own status line shows a
// human about a session, computed by the daemon about an agent — the routing
// model and its reasoning effort, how full the context is, and the two account
// usage windows.
//
// THREE SOURCES, and the split is the whole design:
//
//   model + effort  the routing pick and `models.<name>.reasoning_effort`.
//                   The daemon already knows both at dispatch; nothing is read.
//                   A DISPATCH is not a process, though — #187 measured what a
//                   restart cost, because the label reached this function only
//                   through memory. Reconcile now rebuilds it from the journal.
//
//   context %       the agent's own transcript tail, the same file the
//                   timeline (#74) reads. Both harnesses state their last request's
//                   input tokens; only the codex harness also states the window.
//                   The claude harness looks its window up LIVE — see the next
//                   block. A model with no window from any source shows NO
//                   context figure: a guessed denominator is a wrong
//                   percentage, and this line exists to be trusted.
//
// WHERE THE CLAUDE DENOMINATOR COMES FROM (#178 settled this, and #146 had it
// wrong). #146 wrote the window into `models.<name>.context_window` because the
// claude transcript states none. That number was 200000 and the real window is
// 1000000, so every context figure that harness ever showed was five times too
// large — and the clamp hid it, rendering a 248,003-token request against a
// stated 200,000 as a plausible `ctx 100%`.
//
// Config was the fault, not the value in it: a hand-written denominator has
// nothing to correct it and goes stale silently. So the denominator now comes
// from two things the box already has, and neither can drift:
//
//   * WHICH model ran — the claude transcript states it on every assistant
//     line (`message.model`, measured: `"claude-opus-5"`). That is the model
//     the CLI actually resolved, not the routing label, so an alias moving
//     under us corrects itself on the next turn.
//   * HOW BIG that model's window is — `GET /v1/models/<id>` answers
//     `max_input_tokens`. Measured on the deployment box against its own
//     `CLAUDE_CODE_OAUTH_TOKEN`: 200, and 1000000 for `claude-opus-5`. This is
//     the endpoint #162's does not resemble — it is metadata, it carries no
//     `anthropic-ratelimit-*` header at all, and it costs no quota, so it needs
//     none of the probe's throttling.
//
// `models.<name>.context_window` survives as the LAST resort, for a box that
// cannot reach the API and for the codex harness's pre-first-turn fallback. It is
// no longer set for any anthropic model.
//
//   5 h / 7 d bars  ACCOUNT-level, not per agent: every agent on a provider
//                   shares one quota, so this is one reading rendered on every
//                   line. The codex harness gets it free — its transcript carries
//                   `rate_limits` beside every token count. The claude harness
//                   states them nowhere: not in the transcript, and not in any
//                   file the CLI writes on a headless box.
//                   WHICH provider comes from the harness (#187). It used to
//                   come from the dispatched label's routing row, which made an
//                   account fact depend on a spawn-time one, and both bars left
//                   the line whenever the label did.
//
// WHERE THE CLAUDE NUMBERS COME FROM (#162 settled this, and it is not where
// #146 thought). `GET /api/oauth/usage` only answers a credential carrying the
// `user:profile` scope, which only an interactive `claude /login` records. A
// server authenticated by `CLAUDE_CODE_OAUTH_TOKEN` — the `claude setup-token`
// credential a headless box is meant to use — is refused, and so is an API key.
// Measured against the live endpoint: it answers such a token exactly as it
// answers no credential at all.
//
// The same two windows ride the response headers of any ACCEPTED completion, as
// `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`. Every credential
// shape gets them, and they carry the identical numbers and reset instants the
// endpoint states — verified side by side. So the daemon reads its own windows
// the way every caller already does: it issues one minimal completion and keeps
// the headers.
//
// FOUR RULES BOUND THAT PROBE, and all four are load bearing:
//
//   1. The daemon NEVER writes a credential and never refreshes one. A refresh
//      rotates the refresh token, and every live CLI session on the box holds
//      the old one. So a 401 or 403 is terminal here: probing stops until the
//      credential itself changes.
//   2. The headers ARE the reading, whatever the status code. A window that is
//      spent still states itself on the rejection, which is the moment the bars
//      matter most.
//   3. The probe is the cheapest completion there is, on the cheapest model,
//      and never more often than the shared attempt stamp allows. It spends
//      account quota to measure account quota, which is only honest at this
//      size: about two dozen tokens per half hour, against an agent turn that
//      spends thousands.
//   4. The attempt stamp beside the cache stays a cooperative lock. The
//      operator's own statusline.sh writes the same two files in the same
//      shape, so a reading either one takes serves both, and neither probes
//      while the other's attempt is fresh.
//
// The read path costs nothing and always runs; the probe is what
// `usage.account_bars` turns off.
//
// THE COOLING PATH READS THE SAME LINE (#175). A codex cap hit cooled a blind
// hour, because the codex CLI states no reset instant in the pane text the
// limit classifier reads (`LIMIT_PATTERNS.openai.reset` is null). It states one
// in the transcript: `resets_at`, beside every `rate_limits` slot, which is the
// field these bars already take their pace from. `transcriptReset` is that same
// reading asked a different question — not "how far through the window are we"
// but "when does the window that is SPENT roll".

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findTranscript, transcriptForSession, firstPrompt } from './transcript.mjs'
import { providerOf } from './routing.mjs'

// A transcript grows to megabytes and only its tail carries the live numbers.
// Generous enough that one very large final record still lands whole.
const TAIL_BYTES = 512 * 1024

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
export const MODELS_URL = 'https://api.anthropic.com/v1/models'
// The cheapest completion Anthropic sells, asked for one token. Overridable so
// a box whose plan drops this model still has a probe (`usage.probe_model`).
export const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const OAUTH_BETA = 'oauth-2025-04-20'
const ANTHROPIC_VERSION = '2023-06-01'
// Past this age the reading is refetched, if fetching is on at all.
export const USAGE_STALE_MS = 30 * 60 * 1000
// And never more often than this, counted across every fetcher on the box.
export const USAGE_ATTEMPT_MS = 10 * 60 * 1000
// A model's window is a property of the model, so it moves only when Anthropic
// ships one. A day is short enough to catch that and long enough that the
// lookup is invisible.
export const WINDOW_STALE_MS = 24 * 60 * 60 * 1000
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
// occupies the window exactly like a fresh token does. Measured on real agent
// transcripts on this box — the harness states no window anywhere, so the caller
// supplies it.
//
// It does state the MODEL, though, on the same line as the counts (#178). That
// is the concrete id the CLI resolved (`claude-opus-5`), not the routing label
// the daemon asked for (`opus`), which makes it the right key to look the
// window up by: it follows the alias instead of guessing where it points.
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
    const model = typeof e.message.model === 'string' ? e.message.model : null
    return { ctx: { tokens, window: null, model }, windows: null, limits: null }
  }
  return { ctx: null, windows: null, limits: null }
}

// A reset instant in either harness's vocabulary, as epoch milliseconds. The codex
// harness states epoch seconds and the anthropic one an ISO string; both are
// absolute, so a stale reading still dates itself correctly. NaN when nothing
// usable is stated, which every caller checks with Number.isFinite.
function resetMs(resetsAt) {
  return typeof resetsAt === 'number' ? resetsAt * 1000 : Date.parse(resetsAt ?? '')
}

// How far into a usage window the clock has got, 0-100 — the second number
// every bar needs, because usage alone cannot say whether it is being spent too
// fast. `resetsAt` is an epoch-seconds number on the codex harness and an ISO
// string on the anthropic one; both are absolute, so a stale reading still
// dates itself correctly.
//
// Three outcomes, and they are genuinely different:
//   {elapsedPct}       the pace signal — how far through the window we are
//   {elapsedPct: null} no reset stated: keep the reading, show a flat bar
//   {expired: true}    the window already reset, so the percentage beside it
//                      belongs to a window that no longer exists. Drop the
//                      NUMBER — the caller replaces it with the fresh window
//                      (#187), and `elapsedPct` here is that window's clock.
//
// The fresh window starts at the instant the old one reset, so its clock is
// knowable while `now` is still inside it. Past that the reading is a window or
// more behind and which window we are in is a guess, so there is no clock.
export function paceOf(resetsAt, windowMs, now = Date.now()) {
  const at = resetMs(resetsAt)
  if (!Number.isFinite(at) || !Number.isFinite(windowMs) || windowMs <= 0) return { elapsedPct: null }
  const remaining = at - now
  if (remaining <= 0) {
    const since = -remaining
    return { expired: true, elapsedPct: since < windowMs ? Math.round((since / windowMs) * 100) : null }
  }
  // A reset further out than the window itself is not this window's reset.
  if (remaining > windowMs) return { elapsedPct: null }
  return { elapsedPct: Math.max(0, Math.min(100, Math.round(((windowMs - remaining) / windowMs) * 100))) }
}

// When the window on the line rolls, as an ISO instant — the reset the
// dashboard prints beside the bar (#262). The status line says the pace and
// nothing more, because a bar has no room for a clock time; a page has.
//
// A LIVE window states its own reset, so that instant is the answer. A ROLLED
// window's stated reset is in the past and belongs to a window that ended, so
// the fresh window that replaced it answers instead: it started at that
// instant, and it ends one window later. That is knowable exactly while the
// fresh window's own clock is knowable, and `paceOf` decides that from the same
// instant — hence the pace is passed in rather than re-derived.
function statedReset(resetsAt, windowMs, pace) {
  const at = resetMs(resetsAt)
  if (!Number.isFinite(at)) return null
  if (!pace.expired) return pace.elapsedPct === null ? null : new Date(at).toISOString()
  return pace.elapsedPct === null ? null : new Date(at + windowMs).toISOString()
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

// The bars, from the raw slot readings. An agent that has been idle for hours
// may hold a reading whose window has since reset. The percentage beside it is
// then about a window that no longer exists, so the window rolls over to a
// fresh one at 0% and the bar stays on the line (#187). See accountWindows.
function barsOf(limits, now) {
  const found = []
  for (const l of limits ?? []) {
    const pace = paceOf(l.resetsAt, l.windowMs, now)
    const resetsAt = statedReset(l.resetsAt, l.windowMs, pace)
    if (pace.expired) {
      found.push({ label: l.label, pct: 0, elapsedPct: pace.elapsedPct, resetsAt, fresh: true })
      continue
    }
    found.push({ label: l.label, pct: Math.round(l.usedPct), elapsedPct: pace.elapsedPct, resetsAt })
  }
  return found.length ? found : null
}

// The codex harness states all three numbers itself, on the `token_count` event it
// writes after every turn: the last request's input tokens, the model's own
// context window, and the account rate limits. Context and limits are taken
// from the newest line that carries each — not every token_count carries both.
//
// `limits` is the slot reading itself, kept beside the bars it renders (#175):
// the bars round the percentage and roll an expired window over to a fresh one
// at 0%, and the cooling path needs the reading exactly as the transcript
// states it — a rolled window states no cap to wait for.
function codexTail(lines, now) {
  let ctx = null
  let limits = null
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
    if (!limits) {
      const found = []
      for (const slot of ['primary', 'secondary']) {
        const r = p.rate_limits?.[slot]
        if (!r || !Number.isFinite(r.used_percent)) continue
        const label = windowLabel(r.window_minutes)
        if (!label) continue
        found.push({
          label, usedPct: r.used_percent, windowMs: r.window_minutes * 60 * 1000, resetsAt: r.resets_at ?? null,
        })
      }
      if (found.length) limits = found
    }
    if (ctx && limits) break
  }
  return { ctx, windows: barsOf(limits, now), limits }
}

const TAILS = { claude: claudeTail, codex: codexTail }

// { ctx: {tokens, window} | null, windows: [{label, pct, elapsedPct, resetsAt, fresh?}] | null,
//   limits: [{label, usedPct, windowMs, resetsAt}] | null }
export function readTranscriptMeters(harness, file, now = Date.now()) {
  const tail = TAILS[harness]
  if (!tail || !file) return { ctx: null, windows: null, limits: null }
  return tail(tailLines(file), now)
}

// ---------------------------------------------------------------------------
// the cooling reset (#175)
// ---------------------------------------------------------------------------

// A window this full is the one the cap hit. The threshold is not 100 because
// the reading is taken at the agent's last turn and the cap is hit on the
// next one, so the last number below the ceiling is what the transcript holds.
export const SPENT_PCT = 95

// When does the spent window roll? Null means the transcript states nothing
// usable, and the caller keeps its conservative floor.
//
// Four rules, and each one keeps a wrong answer out:
//
//   1. Only a SPENT window counts. A window at 40% is not what the pane just
//      refused a turn for, and cooling until its reset would wait for nothing.
//   2. A reset already past is dropped. That window rolled; there is nothing
//      left to wait for.
//   3. A reset further out than its own window is not that window's reset —
//      the same rule paceOf runs on the same field, for the same reason.
//   4. The LATEST surviving reset wins. Two spent windows mean two caps, and
//      waiting only for the earlier one respawns straight into the later.
//
// A STALE reading is still evidence, which is what makes rule 2 the only
// freshness check needed: `resets_at` names one instant for the whole window,
// so a reset still in the future proves the reading belongs to the window that
// is live now — and usage inside one window never falls.
export function spentReset(limits, now = Date.now()) {
  let best = null
  for (const l of limits ?? []) {
    if (!Number.isFinite(l.usedPct) || l.usedPct < SPENT_PCT) continue
    const at = resetMs(l.resetsAt)
    if (!Number.isFinite(at) || at <= now || at - now > l.windowMs) continue
    if (!best || at > best) best = at
  }
  return best === null ? null : new Date(best)
}

// The instant this config dir's transcript says a cap hit has to wait for.
// Date | null. The claude harness always answers null: its transcript states no
// rate limits anywhere, which is why its reset rides the pane text instead.
export function transcriptReset(harness, cfgDir, now = Date.now()) {
  if (!harness || !cfgDir) return null
  const { limits } = readTranscriptMeters(harness, findTranscript(harness, cfgDir), now)
  return spentReset(limits, now)
}

// ---------------------------------------------------------------------------
// the shared anthropic credential
// ---------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// A credential never goes near a log or an error, so a refusal remembers a
// digest of it rather than the thing itself.
function fingerprint(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

// Whatever this box authenticates with, in the CLI's own precedence order —
// #100's trap is that an API key outranks the OAuth token, so a box carrying
// both is already using the key and a reader must use it too. The stored
// credential comes last: it is the one shape a headless box does not have.
//
// Read only, and never written back. That is ADR-0007's first rule, and it
// binds every reader here, not just the usage probe.
export function anthropicCredential(env, credFile) {
  const key = env.ANTHROPIC_API_KEY
  if (key) return { secret: key, headers: { 'x-api-key': key } }
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN ?? readJson(credFile)?.claudeAiOauth?.accessToken
  if (oauth) {
    return { secret: oauth, headers: { authorization: `Bearer ${oauth}`, 'anthropic-beta': OAUTH_BETA } }
  }
  return null
}

// ---------------------------------------------------------------------------
// the model window lookup (#178)
// ---------------------------------------------------------------------------

// The id goes into a URL path, so it is checked before it gets there rather
// than escaped after. Every model id Anthropic ships matches this; a transcript
// carrying anything else is not something to go asking the API about.
const SAFE_MODEL_ID = /^[A-Za-z0-9._-]{1,128}$/

// `max_input_tokens` is the context window. The field is NOT called
// `context_window` — there is no such field on this endpoint (measured).
export function windowFromModel(payload) {
  const n = payload?.max_input_tokens
  return Number.isInteger(n) && n > 0 ? n : null
}

// The live denominator for the claude harness, keyed by the model id the
// transcript states. One entry per model, fetched once and kept for a day.
//
// This is deliberately not the account probe: `GET /v1/models/<id>` is metadata,
// it spends no quota and carries no rate-limit header, so it needs no
// cooperative stamp and no `account_bars` switch. What it does share is the
// credential and its first rule — read it, never rewrite it, and stop asking
// once it has been refused.
export class ModelWindows {
  constructor({
    home = os.homedir(), log = () => {}, now = () => Date.now(),
    fetchImpl = globalThis.fetch, version = '2.1.211', env = process.env,
  } = {}) {
    this.log = log
    this.now = now
    this.fetchImpl = fetchImpl
    this.version = version
    this.env = env
    this.credFile = path.join(home, '.claude', '.credentials.json')
    this.cacheFile = path.join(home, '.claude', 'cache', 'model-windows.json')
    this.entries = readJson(this.cacheFile) ?? {} // id -> { window: number|null, at: ms }
    this.inFlight = new Set()
    this.refusedFor = null
    this.pending = Promise.resolve() // the in-flight lookup, for the tests to await
  }

  // number | null — never blocks. A miss returns null and schedules the fetch;
  // the figure appears on a later tick. A STALE entry is still returned while
  // its refresh runs, because a day-old window is right and a missing one is
  // not.
  windowFor(id) {
    if (!id || !SAFE_MODEL_ID.test(id)) return null
    const hit = this.entries[id]
    if (!hit || this.now() - hit.at >= WINDOW_STALE_MS) this.#fetch(id)
    return hit?.window ?? null
  }

  #fetch(id) {
    if (!this.fetchImpl || this.inFlight.has(id)) return
    const cred = anthropicCredential(this.env, this.credFile)
    if (!cred) return
    const credId = fingerprint(cred.secret)
    if (this.refusedFor === credId) return
    this.inFlight.add(id)
    this.pending = this.#get(id, cred, credId)
      .catch((e) => this.log(`model window lookup for ${id} failed: ${e.message}`))
      .finally(() => this.inFlight.delete(id))
  }

  async #get(id, cred, credId) {
    const res = await this.fetchImpl(`${MODELS_URL}/${id}`, {
      headers: {
        ...cred.headers,
        'anthropic-version': ANTHROPIC_VERSION,
        'user-agent': `claude-cli/${this.version} (external, cli)`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) {
      this.refusedFor = credId
      this.log(`model windows: the credential was refused (${res.status}) — the daemon does not refresh it, so the context % stays off until the credential changes`)
      return
    }
    // A 404 is an answer too: this box's account cannot see that model, and
    // asking again every minute would not change it. Remembering the null keeps
    // the meter off and the request rate at one a day.
    const window = res.status === 404 ? null : windowFromModel(await res.json())
    if (res.ok || res.status === 404) this.#remember(id, window)
    else throw new Error(`HTTP ${res.status}`)
  }

  #remember(id, window) {
    this.entries = { ...this.entries, [id]: { window, at: this.now() } }
    try {
      const tmp = `${this.cacheFile}.tmp`
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.entries))
      fs.renameSync(tmp, this.cacheFile)
    } catch (e) {
      this.log(`model windows: could not cache ${id}: ${e.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// the anthropic account reading
// ---------------------------------------------------------------------------

// Both the endpoint's response and the CLI's persisted copy carry the same two
// top-level windows. Percentages only — the dollar fields are null on a
// subscription account. The window lengths are not stated, so they are named
// here: they are what `five_hour` and `seven_day` mean.
const ANTHROPIC_WINDOWS = [
  { key: 'five_hour', label: '5h', ms: 5 * 60 * 60 * 1000 },
  { key: 'seven_day', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
]

// The response headers state the same two windows the endpoint states, under
// their own names and in their own units: a 0-1 fraction, and an epoch-seconds
// reset. This maps them onto the payload shape above, so the cache file keeps
// ONE schema whichever way the reading was taken — which is what lets the
// daemon and the operator's statusline.sh go on sharing the file.
const UNIFIED = [
  { tag: '5h', key: 'five_hour' },
  { tag: '7d', key: 'seven_day' },
]

export function payloadFromHeaders(headers) {
  const get = (name) => headers?.get?.(name) ?? null
  const out = {}
  for (const w of UNIFIED) {
    const raw = get(`anthropic-ratelimit-unified-${w.tag}-utilization`)
    if (raw === null || raw === '') continue
    const utilization = Number(raw)
    if (!Number.isFinite(utilization)) continue
    const reset = Number(get(`anthropic-ratelimit-unified-${w.tag}-reset`))
    out[w.key] = {
      // One decimal, which is what the endpoint itself states. Scaling a
      // fraction by 100 otherwise leaves float dust in a file the operator's
      // statusline.sh also reads.
      utilization: Math.round(utilization * 1000) / 10,
      resets_at: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
    }
  }
  return Object.keys(out).length ? out : null
}

// A window whose reset has passed ROLLS OVER — it does not leave the line
// (#187, and the operator settled which of the three it is). Dropping the entry
// took the 5 h bar off every agent line after every reset, for as long as the
// next probe took, with no sign that the number was missing rather than zero.
//
// So the ended window is replaced by the one that started at its reset instant:
// a fresh window, at 0%, with its own clock running. That is what a window
// reset means, and it is the one reading that needs no probe to be true. The
// entry is marked `fresh` so the probe still knows to go and measure it — see
// AccountUsage#maybeFetch.
export function accountWindows(payload, now = Date.now()) {
  const out = []
  for (const w of ANTHROPIC_WINDOWS) {
    const v = payload?.[w.key]
    if (!Number.isFinite(v?.utilization)) continue
    const p = paceOf(v.resets_at, w.ms, now)
    const resetsAt = statedReset(v.resets_at, w.ms, p)
    if (p.expired) {
      out.push({ label: w.label, pct: 0, elapsedPct: p.elapsedPct, resetsAt, fresh: true })
      continue
    }
    out.push({ label: w.label, pct: Math.round(v.utilization), elapsedPct: p.elapsedPct, resetsAt })
  }
  return out.length ? out : null
}

export class AccountUsage {
  // `fetch` is injected so the test never reaches the network. `home` is the
  // DAEMON's home — never an agent config dir: agents run headless and their
  // own `.claude.json` carries no usage copy (measured on the deployment box:
  // every agent cfg dir there lacks `cachedUsageUtilization` entirely, because
  // the CLI never polls for it under an env-var credential — see #162).
  constructor({
    home = os.homedir(), enabled = true, log = () => {},
    now = () => Date.now(), fetchImpl = globalThis.fetch, version = '2.1.211',
    env = process.env, probeModel = PROBE_MODEL,
  } = {}) {
    this.home = home
    this.enabled = enabled
    this.log = log
    this.now = now
    this.fetchImpl = fetchImpl
    this.version = version
    this.env = env
    this.probeModel = probeModel
    this.cliFile = path.join(home, '.claude.json')
    this.credFile = path.join(home, '.claude', '.credentials.json')
    this.cacheFile = path.join(home, '.claude', 'cache', 'oauth-usage.json')
    this.stampFile = path.join(home, '.claude', 'cache', 'oauth-usage.attempt')
    this.fetching = false
    this.refusedFor = null // fingerprint of the credential a refusal was measured against
    this.pending = Promise.resolve() // the in-flight probe, for the tests to await
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

  // [{label, pct, elapsedPct, resetsAt, fresh?}] | null — the read never
  // blocks; a refresh it decides to run lands on a later call.
  windows() {
    const best = this.#best()
    if (this.enabled) this.#maybeFetch(best)
    return best?.windows ?? null
  }

  #maybeFetch(best) {
    if (this.fetching || !this.fetchImpl) return
    const now = this.now()
    // A reading goes stale at USAGE_STALE_MS, and AT ONCE when one of its
    // windows resets: that window's number ended with it, whatever the age of
    // the file it sits in (#187). The line shows the fresh window at 0% until
    // the probe lands, and 0% is only true for the first minutes of it, so the
    // measurement must not wait out another half hour. The shared attempt stamp
    // below still bounds the probe rate, so the wait is ten minutes at most.
    const rolled = best?.windows?.some((w) => w.fresh) ?? false
    if (best && !rolled && now - best.at < USAGE_STALE_MS) return
    // The shared throttle: whoever touched the stamp last owns this window,
    // daemon or statusline.sh.
    if (now - mtimeMs(this.stampFile) < USAGE_ATTEMPT_MS) return
    // No credential, no attempt — and so no stamp. The stamp is a cooperative
    // lock, and taking it for a probe that never happens tells the other
    // fetcher a window was spent when it was not (#162: measured on the
    // deployment box, which carries no credential file at all, so the daemon
    // touched the lock every ten minutes for nothing).
    const cred = anthropicCredential(this.env, this.credFile)
    if (!cred) return
    const credId = fingerprint(cred.secret)
    // A refused credential stays refused until the credential itself changes.
    // The daemon does not refresh it — see the module header.
    if (this.refusedFor === credId) return
    try {
      fs.mkdirSync(path.dirname(this.stampFile), { recursive: true })
      fs.writeFileSync(this.stampFile, '')
    } catch {
      return // cannot take the lock; do not probe unthrottled
    }
    this.fetching = true
    this.pending = this.#fetch(cred, credId)
      .catch((e) => this.log(`account usage probe failed: ${e.message}`))
      .finally(() => { this.fetching = false })
  }

  // One minimal completion, kept for its headers. The body is read only far
  // enough to be discarded — the numbers never travel in it.
  async #fetch(cred, credId) {
    const res = await this.fetchImpl(MESSAGES_URL, {
      method: 'POST',
      headers: {
        ...cred.headers,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'user-agent': `claude-cli/${this.version} (external, cli)`,
      },
      // The system prompt is what an OAuth credential is entitled to send, so
      // it rides along and the probe stays a Claude Code call like any other.
      body: JSON.stringify({
        model: this.probeModel,
        max_tokens: 1,
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    // Rule 2: the headers are the reading, whatever the status. A window spent
    // to its limit still states itself on the rejection that proves it.
    const payload = payloadFromHeaders(res.headers)
    if (!payload) {
      if (res.status === 401 || res.status === 403) {
        this.refusedFor = credId
        this.log(`account usage: the credential was refused (${res.status}) — the daemon does not refresh it; the bars stay at their last reading until the credential changes`)
        return
      }
      throw new Error(`HTTP ${res.status} carried no usage headers`)
    }
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

// What a line a human reads CALLS the model (#179). #146 rendered the routing
// label, which is the key in `routing.yaml` and not a model at all. On the
// claude harness the key `opus` reads like one and hid the mismatch. On the codex
// harness the key is `gpt` while the model is `gpt-5.6-sol`, so the status line
// said `gpt` about a Sol 5.6 agent.
//
// Three sources, best evidence first — the same order #178 settled for the
// context denominator, because it is the same question asked about the same
// fact:
//
//   1. what the transcript states about ITSELF: the concrete id the CLI
//      resolved (`claude-opus-5`). An alias that moves under us corrects
//      itself on the next turn.
//   2. `models.<label>.id`: the name the CLI was ASKED for. This is the codex
//      harness's whole fault, and `id` was already sitting beside the label.
//   3. the routing label. Last resort, for a harness that states neither — which
//      is the claude harness before its first turn lands. `opus` is an alias the
//      CLI accepts, and pinning an `id` there would undo the alias-following
//      #178 depends on, so the label stands for those first seconds.
//
// The label does not ride along beside the id. It is the DISPATCH vocabulary
// (`model:gpt`, `/start 179 opus`) and the surfaces that speak it — cooling,
// fallback, the `/agents` list — go on saying it. The status line answers
// "what is running", and one name for that is the point.
export function modelName(model, spec, stated = null) {
  return stated ?? spec?.id ?? model ?? null
}

// Everything the status line can say about one agent beyond its state. Every
// field is independently nullable — a missing source drops its meter, never the
// line.
//
// `transcript` names the file to read (#332, building ADR-0016). OMIT it for an
// AGENT: curia gives every agent its own config dir, so the newest file in that
// dir is the agent's live run. PASS it for a CONVERSATION, resolved with
// transcript.transcriptForSession — every overseer conversation shares one
// config dir, so only the session id its key is bound to names its file. Null
// there is a conversation with no turn yet, and it reads NOTHING: the last
// conversation's percent is the defect this argument exists to end, not a
// fallback. ADR-0016 makes this meter the one signal that a conversation is
// getting long, so a number about another conversation cannot carry the job.
export function agentMeters({ harness, cfgDir, model, routing, account, models, transcript, now = Date.now() }) {
  const spec = routing?.models?.[model] ?? null
  const out = {
    model: modelName(model, spec), effort: spec?.reasoning_effort ?? null, ctxPct: null, ctxOver: false, windows: null,
  }
  if (!harness || !cfgDir) return out

  const file = transcript === undefined ? findTranscript(harness, cfgDir) : transcript
  const { ctx, windows } = readTranscriptMeters(harness, file, now)
  // The transcript's own word beats the config's, exactly as it does for the
  // window on the line below.
  out.model = modelName(model, spec, ctx?.model)
  // Best evidence first (#178). What the transcript states about ITSELF beats
  // what the API says about the model, which beats what a human wrote in a file
  // months ago and cannot be corrected by anything.
  const window = ctx?.window ?? models?.windowFor(ctx?.model) ?? spec?.context_window ?? null
  if (ctx && window > 0) {
    // NOT clamped. A request larger than its own window is impossible, so a
    // figure above 100% is proof the denominator is wrong — which is exactly
    // what #146's `Math.min(100, ...)` hid for the whole life of that meter.
    // Rendering it flat turns evidence into a plausible reading, so it goes out
    // at its real size and `meterParts` marks it.
    out.ctxPct = Math.round((ctx.tokens / window) * 100)
    out.ctxOver = out.ctxPct > 100
  }

  // The transcript's own limits win — they are this provider's numbers,
  // measured at the agent's last turn. Only the anthropic harness needs the
  // account reading, because its transcript states none.
  //
  // The provider follows from the HARNESS when there is no routing row (#187).
  // Keying the bars on the row made them a spawn-time fact: an agent the daemon
  // adopted after a restart lost its label, lost its row with it, and both bars
  // left the line while `ctx` — which reads the transcript — stayed. The bars
  // are an account fact and have nothing to do with which label was dispatched.
  if (windows) out.windows = windows
  else if ((spec?.provider ?? providerOf(routing, harness)) === 'anthropic') {
    out.windows = account?.windows() ?? null
  }
  return out
}

// What `GET /overview` says about one agent's context (#264).
//
// The fleet table and the agents table both carry a ctx column, and
// `dispatcher.status()` cannot fill it: that read asks tmux and the journal,
// never a transcript. So the meter joins on the route, through the same
// `agentMeters` the status line reads — one agent is never measured two ways on
// two surfaces.
//
// The read is passed in as a thunk, and a throw from it costs this ONE column.
// Every section of that route is independently nullable, and a missing
// transcript must not take an agent's row off a page with it. `ctx_pct` is null
// when there is no reading — which the page prints as "—", never as 0%.
export function ctxOnWire(read) {
  let m = null
  try {
    m = read()
  } catch {
    return { ctx_pct: null, ctx_over: false }
  }
  return { ctx_pct: m?.ctxPct ?? null, ctx_over: Boolean(m?.ctxOver) }
}

// ---- the browser conversations, on the wire (#333, ADR-0016) ---------------
//
// What `GET /console` says about every browser conversation. It sits beside
// `ctxOnWire` because it is the same act one level up: the context percent is
// the reason a row is worth reading a transcript for, and one conversation must
// not be measured two ways on two surfaces either.
//
// The Chat screen is the one surface that draws this, so it is its own route
// rather than a section of `GET /overview`. Two reasons, and both are cost: the
// list grows for as long as the operator keeps conversations, and a row costs a
// transcript read. A section on the poll every screen shares would make
// watching Home more expensive with every chat ever opened.
//
// ADR-0016 adds no warning that a conversation is long. The context percent IS
// the signal, and #332 is what made it true per conversation, so a picker
// without it would leave the operator picking blind.
//
// `sessionIdFor(key)` is the journalled binding — the daemon passes
// `store.overseerSession`. Every conversation shares one config dir, so only
// that id names a conversation's own file.
export function consoleConversationsOnWire({
  conversations, sessionIdFor, harness, cfgDir, model, routing, account, models,
  droppedFor = () => null, now = Date.now(),
}) {
  return conversations.map((c) => {
    const file = harness ? transcriptForSession(harness, cfgDir, sessionIdFor(c.key) ?? null) : null
    // The file's own mtime is when this conversation last wrote, which is the
    // one honest answer: the journalled binding is rewritten every turn, so it
    // dates the turn's START, and a long turn would date the row wrong.
    let lastTurnAt = null
    if (file) {
      try { lastTurnAt = new Date(fs.statSync(file).mtimeMs).toISOString() } catch { lastTurnAt = null }
    }
    return {
      key: c.key,
      session: `curia-${c.key}`,
      opened_at: c.opened_at ?? null,
      last_turn_at: lastTurnAt,
      // The row's label: what the operator opened this conversation with. Null
      // for one with no turn yet, and the page falls back to the key.
      label: file ? firstPrompt(harness, file) : null,
      // The turn a restart killed on THIS conversation (#388). A Discord
      // conversation gets that line in its thread; a browser one has no thread,
      // so the row it is picked from carries it until it takes its next turn.
      dropped: droppedFor(c.key),
      // A conversation with no turn yet has no file, and `agentMeters` then
      // reads NOTHING rather than falling back to whoever answered last
      // (#332). The percent is null, which the page prints as "—", never 0%.
      ...ctxOnWire(() => agentMeters({ harness, cfgDir, model, routing, account, models, transcript: file, now })),
    }
  })
}

// Ordered most valuable first: the status line appends what fits and drops the
// rest from the tail (#146 — state and escalation title win over the meters).
// The window label carries bold because it is the thing the eye lands on when
// scanning a column of agents, and the mark leads the bar for the same reason.
export function meterParts(m) {
  if (!m) return []
  const parts = []
  if (m.model) parts.push(m.effort ? `**${m.model}** ${m.effort}` : `**${m.model}**`)
  // The mark is the whole point of not clamping: over 100% the number is not a
  // reading about the agent, it is a complaint about the denominator, and it
  // has to look different from an agent that is merely nearly full.
  if (m.ctxPct != null) parts.push(m.ctxOver ? `ctx ${m.ctxPct}% ⚠️` : `ctx ${m.ctxPct}%`)
  for (const w of m.windows ?? []) {
    const mark = paceMark(w.pct, w.elapsedPct)
    parts.push(`**${w.label}** ${mark ? `${mark} ` : ''}${bar(w.pct, w.elapsedPct)} ${w.pct}%`)
  }
  return parts
}

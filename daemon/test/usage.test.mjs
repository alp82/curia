// Status-line meters (#146). The transcript shapes below are copied from real
// agent transcripts on this box, not invented: both harnesses are UNDOCUMENTED
// (transcript.mjs says so), so a fixture that guesses would prove nothing.
//
// The account half exists to answer the ticket's own open question — may the
// daemon read the shared credential store? — so its tests pin the rules that
// make the answer yes: never refresh a refused credential, and never probe
// outside the stamp the operator's own statusline.sh shares.
//
// #162 moved the source. The OAuth usage endpoint answers only a credential
// carrying `user:profile`, which a headless box authenticated by
// CLAUDE_CODE_OAUTH_TOKEN does not have, so the reading now comes off the
// `anthropic-ratelimit-unified-*` response headers of one minimal completion.
// The header values below are copied from a live response on the deployment
// box: a 0-1 fraction, and an epoch-seconds reset.
//
// The clock is fixed throughout. Every bar carries a pace signal now, and pace
// is a fact about time, so a fixture without a stated `now` would assert
// nothing stable.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AccountUsage, ModelWindows, accountWindows, bar, meterParts, paceMark, paceOf, payloadFromHeaders,
  readTranscriptMeters, modelName, windowFromModel, windowLabel, agentMeters,
  spentReset, transcriptReset,
  USAGE_ATTEMPT_MS, USAGE_STALE_MS, WINDOW_STALE_MS,
} from '../src/usage.mjs'

const NOW = Date.parse('2026-08-03T12:00:00Z')
const MIN = 60 * 1000
// A reset `m` minutes out, in each harness's own vocabulary.
const resetsInSec = (m) => Math.round(NOW / 1000) + m * 60
const resetsInIso = (m) => new Date(NOW + m * MIN).toISOString()

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-usage-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const write = (rel, lines) => {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
  return file
}

// A claude `assistant` line, measured shape: usage under message, no window
// stated anywhere in the file.
const claudeTurn = (input, cacheRead, cacheCreate) => ({
  type: 'assistant',
  message: {
    model: 'claude-opus-5',
    usage: {
      input_tokens: input,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      output_tokens: 30,
    },
  },
})

// A codex `token_count` event, measured shape: the window and the account rate
// limits ride along with the counts.
const codexCount = ({ input, window, primary = null, secondary = null }) => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 524359, output_tokens: 4213 },
      last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 76 },
      model_context_window: window,
    },
    rate_limits: { limit_id: 'codex', primary, secondary, plan_type: 'plus' },
  },
})

describe('paceOf', () => {
  test('elapsed is measured back from the reset, in either harness vocabulary', () => {
    // 300-minute window, 210 minutes left -> 30% elapsed. Epoch seconds (codex)
    // and an ISO string (anthropic) must agree.
    assert.deepEqual(paceOf(resetsInSec(210), 300 * MIN, NOW), { elapsedPct: 30 })
    assert.deepEqual(paceOf(resetsInIso(210), 300 * MIN, NOW), { elapsedPct: 30 })
  })

  test('a window that already reset is expired, not 100% elapsed', () => {
    // The percentage beside it belongs to a window that no longer exists. The
    // caller drops that number rather than showing a full, stale bar — and the
    // clock it gets back is the FRESH window's, one minute old (#187).
    assert.deepEqual(paceOf(resetsInSec(-1), 300 * MIN, NOW), { expired: true, elapsedPct: 0 })
    assert.deepEqual(paceOf(resetsInSec(-150), 300 * MIN, NOW), { expired: true, elapsedPct: 50 })
    // A reading a whole window behind cannot say which window we are in.
    assert.deepEqual(paceOf(resetsInSec(-300), 300 * MIN, NOW), { expired: true, elapsedPct: null })
  })

  test('an unstated or nonsense reset yields no pace, and keeps the reading', () => {
    assert.deepEqual(paceOf(null, 300 * MIN, NOW), { elapsedPct: null })
    assert.deepEqual(paceOf('not a date', 300 * MIN, NOW), { elapsedPct: null })
    assert.deepEqual(paceOf(resetsInSec(60), 0, NOW), { elapsedPct: null })
    // A reset further out than the window is not this window's reset.
    assert.deepEqual(paceOf(resetsInSec(600), 300 * MIN, NOW), { elapsedPct: null })
  })
})

describe('transcript meters', () => {
  test('the claude harness: context is everything the request SENT, cached or not', () => {
    const file = write('c.jsonl', [
      { type: 'system', subtype: 'init' },
      claudeTurn(1, 100, 0),
      claudeTurn(2, 88567, 353), // the newest line wins
      { type: 'file-history-snapshot' },
    ])
    const { ctx, windows } = readTranscriptMeters('claude', file, NOW)
    // The model rides along (#178): the harness states no window, but it does
    // state which model produced the counts, and that is the lookup key.
    assert.deepEqual(ctx, { tokens: 88922, window: null, model: 'claude-opus-5' })
    assert.equal(windows, null, 'this harness states no account limits anywhere')
  })

  test('the codex harness states its own window, its own limits, and its own clock', () => {
    const file = write('x.jsonl', [
      codexCount({
        input: 47481,
        window: 258400,
        primary: { used_percent: 1.0, window_minutes: 10080, resets_at: resetsInSec(10080 * 0.4) },
      }),
    ])
    const { ctx, windows } = readTranscriptMeters('codex', file, NOW)
    assert.deepEqual(ctx, { tokens: 47481, window: 258400 })
    // The stated reset rides along (#262): the status line has no room for a
    // clock time and prints the pace, the dashboard has room and prints both.
    assert.deepEqual(windows, [{ label: '7d', pct: 1, elapsedPct: 60, resetsAt: resetsInIso(10080 * 0.4) }])
  })

  test('the codex window label is derived, never assumed from the slot name', () => {
    // A plus account was measured with a WEEKLY primary and no secondary, so
    // "primary means 5 h" would have been wrong on the first real transcript.
    assert.equal(windowLabel(300), '5h')
    assert.equal(windowLabel(10080), '7d')
    assert.equal(windowLabel(1440), '1d')
    assert.equal(windowLabel(30), '30m')
    assert.equal(windowLabel(null), null)
    const file = write('x.jsonl', [
      codexCount({
        input: 10,
        window: 100,
        primary: { used_percent: 62.4, window_minutes: 300, resets_at: resetsInSec(210) },
        secondary: { used_percent: 41, window_minutes: 10080, resets_at: resetsInSec(10080 * 0.5) },
      }),
    ])
    assert.deepEqual(readTranscriptMeters('codex', file, NOW).windows, [
      { label: '5h', pct: 62, elapsedPct: 30, resetsAt: resetsInIso(210) },
      { label: '7d', pct: 41, elapsedPct: 50, resetsAt: resetsInIso(10080 * 0.5) },
    ])
  })

  test('a window whose reset has passed rolls over to a fresh one, and stays on the line', () => {
    // An idle agent holds a reading from a window that has since reset. The
    // 88% is about a window that ended, so it goes — and the window that
    // started at that reset takes its place, 30 minutes into its five hours
    // (#187). The bar used to leave the line instead.
    const file = write('x.jsonl', [
      codexCount({
        input: 10,
        window: 100,
        primary: { used_percent: 88, window_minutes: 300, resets_at: resetsInSec(-30) },
        secondary: { used_percent: 41, window_minutes: 10080, resets_at: resetsInSec(1000) },
      }),
    ])
    // The rolled window states the FRESH window's reset (#262): the one the
    // transcript carries is in the past and belongs to the window that ended,
    // and the window that replaced it ends five hours after that instant.
    assert.deepEqual(readTranscriptMeters('codex', file, NOW).windows, [
      { label: '5h', pct: 0, elapsedPct: 10, resetsAt: resetsInIso(270), fresh: true },
      { label: '7d', pct: 41, elapsedPct: 90, resetsAt: resetsInIso(1000) },
    ])
  })

  test('a reading a whole window behind has no clock, and says so', () => {
    // Six hours after a five-hour window reset, WHICH window we are in is a
    // guess. The fresh window still stands at 0%, and it renders a flat bar
    // rather than a made-up clock position.
    const file = write('y.jsonl', [
      codexCount({
        input: 10,
        window: 100,
        primary: { used_percent: 88, window_minutes: 300, resets_at: resetsInSec(-360) },
      }),
    ])
    // No clock and no reset, for the same reason: which window we are in is a
    // guess, so when it ends is a guess too (#262).
    assert.deepEqual(readTranscriptMeters('codex', file, NOW).windows, [
      { label: '5h', pct: 0, elapsedPct: null, resetsAt: null, fresh: true },
    ])
  })

  test('context and limits come from the newest line that carries EACH', () => {
    // Not every token_count carries rate limits; taking both from one line
    // would drop the limits every time the newest event omits them.
    const file = write('x.jsonl', [
      codexCount({ input: 1, window: 100, primary: { used_percent: 5, window_minutes: 300, resets_at: resetsInSec(210) } }),
      codexCount({ input: 900, window: 100 }),
    ])
    const { ctx, windows } = readTranscriptMeters('codex', file, NOW)
    assert.equal(ctx.tokens, 900)
    assert.deepEqual(windows, [{ label: '5h', pct: 5, elapsedPct: 30, resetsAt: resetsInIso(210) }])
  })

  test('a missing, empty or unreadable transcript reads as no meters, never as a throw', () => {
    const none = { ctx: null, windows: null, limits: null }
    assert.deepEqual(readTranscriptMeters('claude', null), none)
    assert.deepEqual(readTranscriptMeters('claude', path.join(dir, 'nope.jsonl')), none)
    assert.deepEqual(readTranscriptMeters('gemini', write('g.jsonl', [{}])), none)
    const half = path.join(dir, 'half.jsonl')
    fs.writeFileSync(half, '{"type":"assistant","message":{"usa')
    assert.deepEqual(readTranscriptMeters('claude', half), none)
  })

  // The reading the cooling path takes (#175): the same slots the bars render,
  // unrounded and with the expired ones still on them.
  test('the raw slot readings ride beside the bars they render', () => {
    const file = write('x.jsonl', [
      codexCount({
        input: 10,
        window: 100,
        primary: { used_percent: 99.4, window_minutes: 300, resets_at: resetsInSec(-30) },
        secondary: { used_percent: 41, window_minutes: 10080, resets_at: resetsInSec(1000) },
      }),
    ])
    const { windows, limits } = readTranscriptMeters('codex', file, NOW)
    // The bars roll the ended window over to a fresh one at 0% (#187). The raw
    // reading keeps what the transcript states, which is what tells the cooling
    // path that this window has already rolled and states no cap to wait for.
    assert.deepEqual(windows, [
      { label: '5h', pct: 0, elapsedPct: 10, resetsAt: resetsInIso(270), fresh: true },
      { label: '7d', pct: 41, elapsedPct: 90, resetsAt: resetsInIso(1000) },
    ])
    assert.deepEqual(limits, [
      { label: '5h', usedPct: 99.4, windowMs: 300 * MIN, resetsAt: resetsInSec(-30) },
      { label: '7d', usedPct: 41, windowMs: 10080 * MIN, resetsAt: resetsInSec(1000) },
    ])
  })
})

// The instant a codex cap hit waits for, which used to be a blind hour.
describe('the cooling reset (#175)', () => {
  const slot = (label, usedPct, windowMinutes, resetsInMinutes) => ({
    label, usedPct, windowMs: windowMinutes * MIN, resetsAt: resetsInSec(resetsInMinutes),
  })

  test('the spent window is the one to wait for, and a window with room is not', () => {
    assert.deepEqual(
      spentReset([slot('5h', 100, 300, 42), slot('7d', 41, 10080, 5000)], NOW),
      new Date(NOW + 42 * MIN),
    )
    // 94% is not a cap hit. Nothing here states when this cooling ends.
    assert.equal(spentReset([slot('5h', 94, 300, 42)], NOW), null)
  })

  test('two spent windows mean two caps, so the LATER reset wins', () => {
    // Waiting only for the 5 h window respawns straight into the weekly one.
    assert.deepEqual(
      spentReset([slot('5h', 100, 300, 42), slot('7d', 99, 10080, 4000)], NOW),
      new Date(NOW + 4000 * MIN),
    )
  })

  test('a reset already past states nothing: that window has rolled', () => {
    assert.equal(spentReset([slot('5h', 100, 300, -1)], NOW), null)
  })

  test('a reset further out than its own window is not that window\'s reset', () => {
    assert.equal(spentReset([slot('5h', 100, 300, 600)], NOW), null)
  })

  test('no reading at all keeps the caller on its floor', () => {
    assert.equal(spentReset(null, NOW), null)
    assert.equal(spentReset([], NOW), null)
    assert.equal(spentReset([{ label: '5h', usedPct: 100, windowMs: 300 * MIN, resetsAt: null }], NOW), null)
  })

  test('transcriptReset reads the agent config dir, and the claude harness states nothing', () => {
    const codexDir = path.join(dir, 'cfg-codex')
    const day = path.join(codexDir, 'sessions', '2026', '08', '03')
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(
      path.join(day, 'rollout-2026-08-03T11-00-00-a.jsonl'),
      JSON.stringify(codexCount({
        input: 10,
        window: 258400,
        primary: { used_percent: 100, window_minutes: 300, resets_at: resetsInSec(90) },
      })),
    )
    assert.deepEqual(transcriptReset('codex', codexDir, NOW), new Date(NOW + 90 * MIN))

    // The claude harness states its rate limits nowhere, so its reset stays the
    // one on the pane text — this reader must not invent one.
    const claudeDir = path.join(dir, 'cfg-claude')
    const proj = path.join(claudeDir, 'projects', 'p')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 's.jsonl'), JSON.stringify(claudeTurn(1, 100, 0)))
    assert.equal(transcriptReset('claude', claudeDir, NOW), null)

    // An agent capped before its first turn has written no transcript at all.
    assert.equal(transcriptReset('codex', path.join(dir, 'cfg-empty'), NOW), null)
    assert.equal(transcriptReset(null, codexDir, NOW), null)
  })
})

describe('ModelWindows', () => {
  // The response shape below is copied from a live `GET /v1/models/claude-opus-5`
  // taken on the deployment box against its own CLAUDE_CODE_OAUTH_TOKEN — the
  // credential shape #162 found the usage endpoint refuses. This one answers it,
  // which is the whole reason #178 can use it.
  const OPUS_5 = {
    type: 'model',
    id: 'claude-opus-5',
    display_name: 'Claude Opus 5',
    created_at: '2026-07-24T00:00:00Z',
    max_input_tokens: 1000000,
    max_tokens: 128000,
  }
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const status = (code) => ({ ok: false, status: code, json: async () => ({}) })

  const make = (fetchImpl, over = {}) => new ModelWindows({
    home: dir, fetchImpl, now: () => NOW, env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, ...over,
  })

  test('the window is `max_input_tokens` — there is no `context_window` field', () => {
    assert.equal(windowFromModel(OPUS_5), 1000000)
    assert.equal(windowFromModel({ context_window: 200000 }), null)
    assert.equal(windowFromModel({ max_input_tokens: 0 }), null)
    assert.equal(windowFromModel(null), null)
  })

  test('a miss returns null now and answers on the next read', async () => {
    // The lookup never blocks the status line: the first tick shows no figure,
    // the tick after it shows the right one.
    const calls = []
    const w = make(async (url) => { calls.push(url); return ok(OPUS_5) })
    assert.equal(w.windowFor('claude-opus-5'), null)
    await w.pending
    assert.deepEqual(calls, ['https://api.anthropic.com/v1/models/claude-opus-5'])
    assert.equal(w.windowFor('claude-opus-5'), 1000000)
  })

  test('a fresh entry is served from cache without a second request', async () => {
    let n = 0
    const w = make(async () => { n += 1; return ok(OPUS_5) })
    w.windowFor('claude-opus-5')
    await w.pending
    for (let i = 0; i < 5; i += 1) w.windowFor('claude-opus-5')
    assert.equal(n, 1)
  })

  test('a stale entry keeps answering while its refresh runs', async () => {
    let n = 0
    let clock = NOW
    const w = make(async () => { n += 1; return ok(OPUS_5) }, { now: () => clock })
    w.windowFor('claude-opus-5')
    await w.pending
    clock = NOW + WINDOW_STALE_MS + 1
    // A day-old window is still right; a missing one is not.
    assert.equal(w.windowFor('claude-opus-5'), 1000000)
    await w.pending
    assert.equal(n, 2)
  })

  test('the cache survives a restart', async () => {
    const w = make(async () => ok(OPUS_5))
    w.windowFor('claude-opus-5')
    await w.pending
    const fresh = make(() => { throw new Error('must not fetch') })
    assert.equal(fresh.windowFor('claude-opus-5'), 1000000)
  })

  test('a refused credential is never retried — the daemon does not refresh one', async () => {
    // ADR-0007's first rule, the same one that binds the account probe.
    let n = 0
    const w = make(async () => { n += 1; return status(401) })
    w.windowFor('claude-opus-5')
    await w.pending
    w.windowFor('claude-opus-5')
    w.windowFor('claude-sonnet-5')
    assert.equal(n, 1)
  })

  test('a 404 is an answer: remembered as no window, not asked again', async () => {
    let n = 0
    const w = make(async () => { n += 1; return status(404) })
    w.windowFor('claude-made-up')
    await w.pending
    assert.equal(w.windowFor('claude-made-up'), null)
    assert.equal(n, 1, 'an account that cannot see a model will not see it a minute later either')
  })

  test('no credential means no request at all', () => {
    const w = make(() => { throw new Error('must not fetch') }, { env: {} })
    assert.equal(w.windowFor('claude-opus-5'), null)
  })

  test('an id that is not a model id never reaches a URL', () => {
    const w = make(() => { throw new Error('must not fetch') })
    assert.equal(w.windowFor('../../v1/messages'), null)
    assert.equal(w.windowFor(null), null)
    assert.equal(w.windowFor(''), null)
  })
})

describe('agentMeters', () => {
  const routing = {
    models: {
      opus: { provider: 'anthropic', harness: 'claude' },
      stale: { provider: 'anthropic', harness: 'claude', context_window: 200000 },
      // The shape routing.yaml actually carries: the key is the routing label
      // and `id` is the model. #179 is about which of the two a human sees.
      gpt: { provider: 'openai', harness: 'codex', id: 'gpt-5.6-sol', reasoning_effort: 'high', context_window: 258400 },
    },
  }
  // The live lookup, stubbed at the shape agentMeters uses it through. The
  // real number: measured against `GET /v1/models/claude-opus-5` on the
  // deployment box, which is where #146's 200000 came apart.
  const lookup = (table) => ({ windowFor: (id) => table[id] ?? null })
  const cfgDir = () => {
    const d = path.join(dir, 'cfg', 'curia-1')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  test('the claude harness looks its denominator up by the model the TRANSCRIPT names', () => {
    // Not by the routing label: the label is `opus`, the model is
    // `claude-opus-5`, and only the second one has a window (#178).
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(2, 399998, 0)])
    const account = { windows: () => [{ label: '5h', pct: 18, elapsedPct: 99 }] }
    const models = lookup({ 'claude-opus-5': 1000000 })
    const m = agentMeters({ harness: 'claude', cfgDir: d, model: 'opus', routing, account, models, now: NOW })
    assert.equal(m.ctxPct, 40)
    assert.equal(m.ctxOver, false)
    assert.equal(m.effort, null)
    assert.deepEqual(m.windows, [{ label: '5h', pct: 18, elapsedPct: 99 }])
  })

  test('the live window beats a config value that has gone stale', () => {
    // This is #146's exact fault, now inverted into a guard: the same 400,000
    // tokens read 200% under the configured 200000 and 40% under the real one.
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(2, 399998, 0)])
    const models = lookup({ 'claude-opus-5': 1000000 })
    const m = agentMeters({ harness: 'claude', cfgDir: d, model: 'stale', routing, account: null, models, now: NOW })
    assert.equal(m.ctxPct, 40)
  })

  test('config is the last resort, and is used when no live window is known yet', () => {
    // A cold cache on the first tick after boot: the lookup misses, so the
    // figure falls back rather than vanishing.
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(2, 79998, 0)])
    const models = lookup({})
    const m = agentMeters({ harness: 'claude', cfgDir: d, model: 'stale', routing, account: null, models, now: NOW })
    assert.equal(m.ctxPct, 40)
  })

  test('a model with no window from ANY source shows no context figure', () => {
    // The wrong denominator is worse than the missing number: it renders as a
    // confident percentage that is simply false.
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(2, 79998, 0)])
    const m = agentMeters({
      harness: 'claude', cfgDir: d, model: 'opus', routing, account: null, models: lookup({}), now: NOW,
    })
    assert.equal(m.ctxPct, null)
    // A window it cannot find costs the context figure and nothing else — the
    // transcript still named the model, so the model meter stands.
    assert.equal(m.model, 'claude-opus-5')
  })

  test('the meter names the MODEL, not the routing label (#179)', () => {
    // Three sources, best evidence first. The claude harness states its own model
    // on every turn, so the label `opus` gives way to what actually ran.
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(2, 79998, 0)])
    const m = agentMeters({
      harness: 'claude', cfgDir: d, model: 'opus', routing, account: null, models: lookup({}), now: NOW,
    })
    assert.equal(m.model, 'claude-opus-5')
    // And the codex harness states none, so `models.gpt.id` answers instead. This
    // is the fault #179 was raised on: `gpt` about a Sol 5.6 agent.
    assert.equal(modelName('gpt', routing.models.gpt), 'gpt-5.6-sol')
    // Last resort: a harness that states neither keeps the label. The claude harness
    // sits here for its first seconds, which is why no `id` is pinned for it.
    assert.equal(modelName('opus', routing.models.opus), 'opus')
    assert.equal(modelName(null, null), null)
  })

  test('an over-window request is reported at its real size, never clamped', () => {
    // Session 151 sent 248,003 tokens against a stated 200,000 and the line
    // said `ctx 100%`. A request cannot exceed its own window, so the excess is
    // proof the denominator is wrong and the meter now says so.
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(3, 248000, 0)])
    const m = agentMeters({
      harness: 'claude', cfgDir: d, model: 'stale', routing, account: null, models: lookup({}), now: NOW,
    })
    assert.equal(m.ctxPct, 124)
    assert.equal(m.ctxOver, true)
  })

  test('the codex harness never consults the account reading — its transcript is the source', () => {
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'sessions', '2026', '08', '03', 'rollout-a.jsonl'), [
      codexCount({
        input: 129200,
        window: 258400,
        primary: { used_percent: 3, window_minutes: 300, resets_at: resetsInSec(150) },
      }),
    ])
    const account = { windows: () => { throw new Error('must not be called') } }
    const m = agentMeters({ harness: 'codex', cfgDir: d, model: 'gpt', routing, account, now: NOW })
    assert.equal(m.ctxPct, 50)
    assert.equal(m.model, 'gpt-5.6-sol')
    assert.equal(m.effort, 'high')
    assert.deepEqual(m.windows, [{ label: '5h', pct: 3, elapsedPct: 50, resetsAt: resetsInIso(150) }])
  })

  test('the account bars survive an agent whose routing label is gone (#187)', () => {
    // What a daemon restart used to cost. Reconcile rebuilt a live agent with
    // no label, so there was no routing row, so `provider` was never
    // `anthropic` and BOTH bars left the line. `ctx` stayed, because it reads
    // the transcript. The harness is the evidence that survives, so it names
    // the provider now.
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(2, 399998, 0)])
    const account = { windows: () => [{ label: '5h', pct: 18, elapsedPct: 99 }] }
    const m = agentMeters({
      harness: 'claude', cfgDir: d, model: null, routing, account, models: lookup({ 'claude-opus-5': 1000000 }), now: NOW,
    })
    assert.deepEqual(m.windows, [{ label: '5h', pct: 18, elapsedPct: 99 }])
    assert.equal(m.model, 'claude-opus-5', 'the transcript names it, label or no label')
    assert.equal(m.ctxPct, 40)
  })

  test('a codex agent with no label still never takes the anthropic reading', () => {
    // The other direction of the same change: the harness decides, and this
    // harness is not anthropic's. A transcript with no rate limits in it yet
    // must leave the bars empty rather than borrow another account's.
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'sessions', '2026', '08', '03', 'rollout-a.jsonl'), [
      codexCount({ input: 129200, window: 258400 }),
    ])
    const account = { windows: () => { throw new Error('must not be called') } }
    const m = agentMeters({ harness: 'codex', cfgDir: d, model: null, routing, account, now: NOW })
    assert.equal(m.windows, null)
    assert.equal(m.ctxPct, 50)
  })

  test('the effort and the model survive an agent with no transcript yet', () => {
    const m = agentMeters({ harness: 'codex', cfgDir: cfgDir(), model: 'gpt', routing, account: null, now: NOW })
    assert.deepEqual(m, { model: 'gpt-5.6-sol', effort: 'high', ctxPct: null, ctxOver: false, windows: null })
  })

  // #332, building ADR-0016: the meter is the ONE signal that a conversation is
  // getting long, so it has to read the conversation it was asked about. Every
  // overseer conversation writes into one config dir, where newest-by-mtime is
  // whoever answered last.
  test('a named transcript beats the newest file in the dir', () => {
    const d = cfgDir()
    const mine = write(path.join('cfg', 'curia-1', 'projects', 'p', 'browser-1111.jsonl'), [claudeTurn(2, 399998, 0)])
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'discord-9999.jsonl'), [claudeTurn(2, 99998, 0)])
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(mine, old, old)
    const models = lookup({ 'claude-opus-5': 1000000 })

    // The mtime path reads the conversation that answered last: 10%, not 40%.
    assert.equal(agentMeters({ harness: 'claude', cfgDir: d, model: 'opus', routing, account: null, models, now: NOW }).ctxPct, 10)
    const m = agentMeters({ harness: 'claude', cfgDir: d, model: 'opus', routing, account: null, models, transcript: mine, now: NOW })
    assert.equal(m.ctxPct, 40)
  })

  test('a conversation with no transcript reads NOTHING, never the newest file', () => {
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'discord-9999.jsonl'), [claudeTurn(2, 399998, 0)])
    const models = lookup({ 'claude-opus-5': 1000000 })
    const m = agentMeters({ harness: 'claude', cfgDir: d, model: 'opus', routing, account: null, models, transcript: null, now: NOW })
    assert.equal(m.ctxPct, null)
  })
})

describe('rendering', () => {
  // An account reading whose 5 h window reset five minutes ago, in the shape
  // the endpoint and the response headers both state.
  const freshFive = {
    five_hour: { utilization: 18, resets_at: resetsInIso(-5) },
    seven_day: { utilization: 57, resets_at: resetsInIso(10080 * 0.4) },
  }

  test('the mark reads PACE, not raw usage', () => {
    // 92% spent with the window nearly over is fine; 40% spent in the first
    // hour is not. Raw usage cannot tell those apart, which is the whole reason
    // the clock is on the bar.
    assert.equal(paceMark(92, 99), '🟩')
    assert.equal(paceMark(40, 10), '🟥')
    assert.equal(paceMark(50, 50), '🟨')
    assert.equal(paceMark(55, 50), '🟨', 'half a cell either way is on pace')
    assert.equal(paceMark(45, 50), '🟨')
    assert.equal(paceMark(56, 50), '🟥', 'and one point past the band flips it')
    assert.equal(paceMark(44, 50), '🟩')
    assert.equal(paceMark(62, 30), '🟥')
    assert.equal(paceMark(18, 99), '🟩')
    assert.equal(paceMark(50, null), null, 'no clock, no pace')
  })

  test('everything past the clock is overshoot, and the divider costs no cell', () => {
    // ┃ marks where the window's clock has got to. ▓ is spending already
    // earned, █ is spending that is not.
    assert.equal(bar(62, 30), '▓▓▓┃███░░░░')
    assert.equal(bar(92, 60), '▓▓▓▓▓▓┃███░')
    assert.equal(bar(18, 99), '▓▓░░░░░░░░┃', 'the clock at the end still renders')
    assert.equal(bar(55, 50), '▓▓▓▓▓┃█░░░░')
    assert.equal(bar(0, 50), '░░░░░┃░░░░░')
    // 10 cells plus one divider, always — the divider sits BETWEEN cells, so
    // the bar never loses a step of resolution to it.
    for (const [u, t] of [[62, 30], [92, 60], [18, 99], [0, 0], [100, 100]]) {
      assert.equal([...bar(u, t)].length, 11, `bar(${u}, ${t}) lost a cell`)
    }
  })

  test('with no clock the bar falls back to a plain fill', () => {
    assert.equal(bar(0), '░░░░░░░░░░')
    assert.equal(bar(41), '▓▓▓▓░░░░░░')
    assert.equal(bar(100), '▓▓▓▓▓▓▓▓▓▓')
    assert.equal(bar(140), '▓▓▓▓▓▓▓▓▓▓', 'a limit past its cap still renders a full bar')
    assert.equal(bar(1), '▓░░░░░░░░░', 'a touched window never renders as untouched')
  })

  test('meters render in value order, and every one of them is optional', () => {
    assert.deepEqual(
      meterParts({
        model: 'gpt', effort: 'high', ctxPct: 41,
        windows: [{ label: '5h', pct: 62, elapsedPct: 30 }],
      }),
      ['**gpt** high', 'ctx 41%', '**5h** 🟥 ▓▓▓┃███░░░░ 62%'],
    )
    assert.deepEqual(meterParts({ model: 'opus', effort: null, ctxPct: null, windows: null }), ['**opus**'])
    assert.deepEqual(meterParts(null), [])
  })

  test('an over-window context figure is marked, not passed off as nearly full', () => {
    // 100% and 124% must not look alike: the first is an agent, the second is a
    // broken denominator (#178).
    assert.deepEqual(meterParts({ ctxPct: 100, ctxOver: false }), ['ctx 100%'])
    assert.deepEqual(meterParts({ ctxPct: 124, ctxOver: true }), ['ctx 124% ⚠️'])
  })

  test('a window that just reset renders as a fresh one, never as an absence (#187)', () => {
    // The reading is five minutes into a new five-hour window: nothing spent,
    // and the clock one cell in. The bar used to leave the line entirely here,
    // and a reader could not tell a missing number from a zero.
    assert.deepEqual(
      meterParts({ model: null, ctxPct: null, windows: accountWindows(freshFive, NOW) }),
      ['**5h** 🟨 ░┃░░░░░░░░░ 0%', '**7d** 🟨 ▓▓▓▓▓▓┃░░░░ 57%'],
    )
  })

  test('a window with no clock keeps its bar and loses only its mark', () => {
    assert.deepEqual(
      meterParts({ model: null, ctxPct: null, windows: [{ label: '7d', pct: 57, elapsedPct: null }] }),
      ['**7d** ▓▓▓▓▓▓░░░░ 57%'],
    )
  })
})

describe('AccountUsage', () => {
  // resets_at is what makes the pace signal possible, and the endpoint states
  // it on both windows.
  const payload = (five, seven, { fiveIn = 150, sevenIn = 10080 * 0.4 } = {}) => ({
    five_hour: { utilization: five, resets_at: resetsInIso(fiveIn) },
    seven_day: { utilization: seven, resets_at: resetsInIso(sevenIn) },
  })
  const home = () => {
    fs.mkdirSync(path.join(dir, '.claude', 'cache'), { recursive: true })
    return dir
  }
  const cache = (obj) => fs.writeFileSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), JSON.stringify(obj))
  const creds = (token) => fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }))
  const never = () => { throw new Error('the network must not be reached') }
  const at = (offset = 0) => () => NOW + offset
  // The real process env must never decide a test: a developer box carrying
  // ANTHROPIC_API_KEY would otherwise silently change which credential wins.
  const env = (over = {}) => over
  // One accepted completion, answering with the headers the live API answers
  // with. `five`/`seven` are percentages here and become fractions on the wire.
  const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null })
  const limitHeaders = (five, seven, { fiveIn = 150, sevenIn = 10080 * 0.4 } = {}) => headers({
    'anthropic-ratelimit-unified-5h-utilization': String(five / 100),
    'anthropic-ratelimit-unified-5h-reset': String(resetsInSec(fiveIn)),
    'anthropic-ratelimit-unified-7d-utilization': String(seven / 100),
    'anthropic-ratelimit-unified-7d-reset': String(resetsInSec(sevenIn)),
  })
  const answers = (five, seven, status = 200) => async () => ({
    ok: status < 400, status, headers: limitHeaders(five, seven),
  })

  test('the five-hour and seven-day window lengths are known, so both carry pace', () => {
    // 150 minutes left of 300 -> 50% elapsed. 60% of a week left -> 40%.
    assert.deepEqual(accountWindows(payload(18, 57), NOW), [
      { label: '5h', pct: 18, elapsedPct: 50, resetsAt: resetsInIso(150) },
      { label: '7d', pct: 57, elapsedPct: 60, resetsAt: resetsInIso(10080 * 0.4) },
    ])
  })

  test('both sources are read, and the fresher reading wins', () => {
    home()
    // Both timestamps are pinned. The cache file dates by mtime and the CLI's
    // own copy states its own fetch time, so a test that let either default to
    // the wall clock would decide the winner by how fast the suite ran.
    const stamp = (ms) => fs.utimesSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), ms / 1000, ms / 1000)
    const cli = (ms, five, seven) => fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      cachedUsageUtilization: { fetchedAtMs: ms, utilization: payload(five, seven) },
    }))
    const u = new AccountUsage({ home: dir, enabled: false, now: at() })

    cache(payload(18, 57))
    stamp(NOW - 60_000)
    cli(NOW, 4, 9)
    assert.deepEqual(u.windows().map((w) => w.pct), [4, 9], 'the CLI copy is newer')

    stamp(NOW)
    cli(NOW - 60_000, 4, 9)
    assert.deepEqual(u.windows().map((w) => w.pct), [18, 57], 'the cache file is newer')
  })

  test('a reading with no windows in it is not a reading', () => {
    home()
    cache({ five_hour: null, seven_day: null, limits: [] })
    assert.equal(accountWindows({ five_hour: null }, NOW), null)
    assert.equal(new AccountUsage({ home: dir, enabled: false, now: at() }).windows(), null)
  })

  test('a window that already reset rolls over on the account reading too', () => {
    // #187: every 5 h reset used to take this bar off every agent line, for as
    // long as the next probe took. Five minutes past the reset the window is
    // five minutes old and empty, which is 2% of its clock and 0% spent.
    assert.deepEqual(accountWindows(payload(18, 57, { fiveIn: -5 }), NOW), [
      { label: '5h', pct: 0, elapsedPct: 2, resetsAt: resetsInIso(295), fresh: true },
      { label: '7d', pct: 57, elapsedPct: 60, resetsAt: resetsInIso(10080 * 0.4) },
    ])
  })

  test('a reset window makes its reading stale at once, whatever the file says', async () => {
    // The old gate asked only how OLD the reading was, so a five-minute-old
    // file whose 5 h window had just reset waited out USAGE_STALE_MS before
    // anyone asked for a replacement (#187). The shared attempt stamp still
    // bounds the probe rate — that lock is about spending quota, and it stands.
    home()
    creds('tok-1')
    cache(payload(18, 57, { fiveIn: -5 }))
    let calls = 0
    const u = new AccountUsage({
      home: dir,
      now: at(),
      env: env(),
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200, headers: limitHeaders(4, 58) } },
    })
    assert.deepEqual(u.windows().map((w) => w.pct), [0, 57], 'the fresh window serves while the probe runs')
    await u.pending
    assert.equal(calls, 1)
    assert.deepEqual(u.windows().map((w) => w.pct), [4, 58])
  })

  test('a fresh reading is never refetched', () => {
    home()
    cache(payload(18, 57))
    const u = new AccountUsage({ home: dir, fetchImpl: never, now: at() })
    assert.deepEqual(u.windows().map((w) => w.pct), [18, 57])
  })

  test('the headers of one minimal completion are the reading', () => {
    // Copied from a live response: fractions, and an epoch-seconds reset. The
    // endpoint's own payload states percentages and an ISO instant, and both
    // must land on the one shape the cache file speaks.
    assert.deepEqual(payloadFromHeaders(limitHeaders(31, 60)), {
      five_hour: { utilization: 31, resets_at: resetsInIso(150) },
      seven_day: { utilization: 60, resets_at: resetsInIso(10080 * 0.4) },
    })
    assert.equal(payloadFromHeaders(headers({})), null, 'a response stating no window is no reading')
    assert.equal(payloadFromHeaders(undefined), null)
  })

  test('a stale reading is reprobed, and the result lands in the shared cache file', async () => {
    home()
    creds('tok-1')
    cache(payload(18, 57))
    const old = (NOW - USAGE_STALE_MS - 1000) / 1000
    fs.utimesSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), old, old)
    let seen = null
    const u = new AccountUsage({
      home: dir,
      now: at(),
      env: env(),
      probeModel: 'model-x',
      fetchImpl: async (url, opts) => {
        seen = { url, opts, body: JSON.parse(opts.body) }
        return { ok: true, status: 200, headers: limitHeaders(31, 60) }
      },
    })
    assert.deepEqual(u.windows().map((w) => w.pct), [18, 57], 'the stale reading still serves while the probe runs')
    await u.pending
    assert.equal(seen.url, 'https://api.anthropic.com/v1/messages')
    assert.equal(seen.opts.method, 'POST')
    assert.equal(seen.opts.headers.authorization, 'Bearer tok-1')
    assert.equal(seen.opts.headers['anthropic-beta'], 'oauth-2025-04-20')
    assert.equal(seen.body.model, 'model-x')
    assert.equal(seen.body.max_tokens, 1, 'the probe buys one token and no more')
    assert.deepEqual(u.windows().map((w) => w.pct), [31, 60])

    // The cache file keeps the endpoint's own shape, so statusline.sh reads
    // what the daemon wrote without knowing where it came from.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), 'utf8')),
      { five_hour: { utilization: 31, resets_at: resetsInIso(150) },
        seven_day: { utilization: 60, resets_at: resetsInIso(10080 * 0.4) } },
    )
  })

  test('the box credential is the env var, and an API key outranks it', async () => {
    // #162: a headless box writes no credential file. #100's precedence trap
    // says a box carrying both an API key and an OAuth token is already using
    // the key, so the probe must use it too.
    home()
    let auth = null
    const probe = async (over) => {
      const u = new AccountUsage({
        home: dir,
        now: at(),
        env: env(over),
        fetchImpl: async (url, opts) => { auth = opts.headers; return { ok: true, status: 200, headers: limitHeaders(31, 60) } },
      })
      u.windows()
      await u.pending
      fs.rmSync(path.join(dir, '.claude', 'cache', 'oauth-usage.attempt'), { force: true })
      fs.rmSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), { force: true })
    }

    await probe({ CLAUDE_CODE_OAUTH_TOKEN: 'setup-tok' })
    assert.equal(auth.authorization, 'Bearer setup-tok')
    assert.equal(auth['x-api-key'], undefined)

    await probe({ CLAUDE_CODE_OAUTH_TOKEN: 'setup-tok', ANTHROPIC_API_KEY: 'sk-key' })
    assert.equal(auth['x-api-key'], 'sk-key')
    assert.equal(auth.authorization, undefined, 'one credential on the wire, never two')
  })

  test('a spent window still states itself on the rejection that proves it', async () => {
    // The moment the bars matter most is the moment the probe is refused for
    // quota. The headers ride that rejection, so the reading survives it.
    home()
    const u = new AccountUsage({
      home: dir,
      now: at(),
      env: env({ CLAUDE_CODE_OAUTH_TOKEN: 'setup-tok' }),
      fetchImpl: answers(100, 92, 429),
    })
    u.windows()
    await u.pending
    assert.deepEqual(u.windows().map((w) => w.pct), [100, 92])
  })

  test('the attempt stamp is a shared lock: a recent attempt by anyone blocks the probe', () => {
    home()
    creds('tok-1')
    // No cache at all — the most stale state there is — but statusline.sh
    // touched the stamp a minute ago, so this fetcher stands down.
    fs.writeFileSync(path.join(dir, '.claude', 'cache', 'oauth-usage.attempt'), '')
    const u = new AccountUsage({ home: dir, fetchImpl: never, now: at(USAGE_ATTEMPT_MS - 60_000), env: env() })
    assert.equal(u.windows(), null)
  })

  test('a box with no credential at all leaves the shared lock alone', () => {
    // #162: taking the lock for a probe that can never happen tells the other
    // fetcher a window was spent when it was not.
    home()
    const stampFile = path.join(dir, '.claude', 'cache', 'oauth-usage.attempt')
    const u = new AccountUsage({ home: dir, fetchImpl: never, now: at(), env: env() })
    assert.equal(u.windows(), null)
    assert.equal(fs.existsSync(stampFile), false, 'no credential, no attempt, no stamp')
  })

  test('a refused credential is never refreshed — probing stops until the credential changes', async () => {
    home()
    creds('expired')
    let calls = 0
    const u = new AccountUsage({
      home: dir,
      log: () => {},
      now: at(),
      env: env(),
      fetchImpl: async () => { calls += 1; return { ok: false, status: 401, headers: headers({}) } },
    })
    u.windows()
    await u.pending
    assert.equal(calls, 1)

    // A later tick, well past every throttle: still refused, because nothing
    // about the credential changed.
    u.now = at(10 * USAGE_ATTEMPT_MS)
    fs.rmSync(path.join(dir, '.claude', 'cache', 'oauth-usage.attempt'), { force: true })
    u.windows()
    await u.pending
    assert.equal(calls, 1, 'the daemon does not retry, and it does not refresh')
    assert.equal(fs.readFileSync(path.join(dir, '.claude', '.credentials.json'), 'utf8'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'expired' } }),
      'the credential file is never written')

    // The CLI wrote a new token, so the daemon tries again. The refusal is
    // keyed on the credential itself, which is the one thing an env-var
    // credential also has — a file mtime would not have caught this.
    creds('tok-2')
    fs.rmSync(path.join(dir, '.claude', 'cache', 'oauth-usage.attempt'), { force: true })
    u.windows()
    await u.pending
    assert.equal(calls, 2)
  })

  test('account_bars off keeps reading the cached copy and spends nothing', () => {
    home()
    creds('tok-1')
    cache(payload(18, 57))
    const old = (NOW - USAGE_STALE_MS - 1000) / 1000
    fs.utimesSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), old, old)
    const u = new AccountUsage({ home: dir, enabled: false, fetchImpl: never, now: at(), env: env() })
    assert.deepEqual(u.windows().map((w) => w.pct), [18, 57])
  })
})

// Status-line meters (#146). The transcript shapes below are copied from real
// worker transcripts on this box, not invented: both lanes are UNDOCUMENTED
// (transcript.mjs says so), so a fixture that guesses would prove nothing.
//
// The account half exists to answer the ticket's own open question — may the
// daemon read the shared credential store? — so its tests pin the two rules
// that make the answer yes: never refresh a refused token, and never fetch
// outside the stamp the operator's own statusline.sh shares.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AccountUsage, accountWindows, bar, meterParts, readTranscriptMeters,
  windowLabel, workerMeters, USAGE_ATTEMPT_MS, USAGE_STALE_MS,
} from '../src/usage.mjs'

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

describe('transcript meters', () => {
  test('the claude lane: context is everything the request SENT, cached or not', () => {
    const file = write('c.jsonl', [
      { type: 'system', subtype: 'init' },
      claudeTurn(1, 100, 0),
      claudeTurn(2, 88567, 353), // the newest line wins
      { type: 'file-history-snapshot' },
    ])
    const { ctx, windows } = readTranscriptMeters('claude', file)
    assert.deepEqual(ctx, { tokens: 88922, window: null })
    assert.equal(windows, null, 'this lane states no account limits anywhere')
  })

  test('the codex lane states its own window and its own account limits', () => {
    const file = write('x.jsonl', [
      codexCount({
        input: 47481,
        window: 258400,
        primary: { used_percent: 1.0, window_minutes: 10080, resets_at: 1785827411 },
      }),
    ])
    const { ctx, windows } = readTranscriptMeters('codex', file)
    assert.deepEqual(ctx, { tokens: 47481, window: 258400 })
    assert.deepEqual(windows, [{ label: '7d', pct: 1 }])
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
        primary: { used_percent: 62.4, window_minutes: 300 },
        secondary: { used_percent: 41, window_minutes: 10080 },
      }),
    ])
    assert.deepEqual(readTranscriptMeters('codex', file).windows, [
      { label: '5h', pct: 62 }, { label: '7d', pct: 41 },
    ])
  })

  test('context and limits come from the newest line that carries EACH', () => {
    // Not every token_count carries rate limits; taking both from one line
    // would drop the limits every time the newest event omits them.
    const file = write('x.jsonl', [
      codexCount({ input: 1, window: 100, primary: { used_percent: 5, window_minutes: 300 } }),
      codexCount({ input: 900, window: 100 }),
    ])
    const { ctx, windows } = readTranscriptMeters('codex', file)
    assert.equal(ctx.tokens, 900)
    assert.deepEqual(windows, [{ label: '5h', pct: 5 }])
  })

  test('a missing, empty or unreadable transcript reads as no meters, never as a throw', () => {
    assert.deepEqual(readTranscriptMeters('claude', null), { ctx: null, windows: null })
    assert.deepEqual(readTranscriptMeters('claude', path.join(dir, 'nope.jsonl')), { ctx: null, windows: null })
    assert.deepEqual(readTranscriptMeters('gemini', write('g.jsonl', [{}])), { ctx: null, windows: null })
    const half = path.join(dir, 'half.jsonl')
    fs.writeFileSync(half, '{"type":"assistant","message":{"usa')
    assert.deepEqual(readTranscriptMeters('claude', half), { ctx: null, windows: null })
  })
})

describe('workerMeters', () => {
  const routing = {
    models: {
      opus: { provider: 'anthropic', backend: 'claude', context_window: 200000 },
      gpt: { provider: 'openai', backend: 'codex', reasoning_effort: 'high', context_window: 258400 },
      nowindow: { provider: 'anthropic', backend: 'claude' },
    },
  }
  const cfgDir = () => {
    const d = path.join(dir, 'cfg', 'curia-1')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  test('the claude lane takes its denominator from config and its bars from the account', () => {
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(2, 79998, 0)])
    const account = { windows: () => [{ label: '5h', pct: 18 }, { label: '7d', pct: 57 }] }
    const m = workerMeters({ backend: 'claude', cfgDir: d, model: 'opus', routing, account })
    assert.equal(m.ctxPct, 40)
    assert.equal(m.effort, null)
    assert.deepEqual(m.windows, [{ label: '5h', pct: 18 }, { label: '7d', pct: 57 }])
  })

  test('a model with no configured window shows NO context figure', () => {
    // The wrong denominator is worse than the missing number: it renders as a
    // confident percentage that is simply false.
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'projects', 'p', 'run.jsonl'), [claudeTurn(2, 79998, 0)])
    const m = workerMeters({ backend: 'claude', cfgDir: d, model: 'nowindow', routing, account: null })
    assert.equal(m.ctxPct, null)
    assert.equal(m.model, 'nowindow')
  })

  test('the codex lane never consults the account reading — its transcript is the source', () => {
    const d = cfgDir()
    write(path.join('cfg', 'curia-1', 'sessions', '2026', '08', '03', 'rollout-a.jsonl'), [
      codexCount({ input: 129200, window: 258400, primary: { used_percent: 3, window_minutes: 300 } }),
    ])
    const account = { windows: () => { throw new Error('must not be called') } }
    const m = workerMeters({ backend: 'codex', cfgDir: d, model: 'gpt', routing, account })
    assert.equal(m.ctxPct, 50)
    assert.equal(m.effort, 'high')
    assert.deepEqual(m.windows, [{ label: '5h', pct: 3 }])
  })

  test('the effort and the model survive a worker with no transcript yet', () => {
    const m = workerMeters({ backend: 'codex', cfgDir: cfgDir(), model: 'gpt', routing, account: null })
    assert.deepEqual(m, { model: 'gpt', effort: 'high', ctxPct: null, windows: null })
  })
})

describe('rendering', () => {
  test('the bar fills in fifths and never overflows its track', () => {
    assert.equal(bar(0), '░░░░░')
    assert.equal(bar(41), '▓▓░░░')
    assert.equal(bar(62), '▓▓▓░░')
    assert.equal(bar(100), '▓▓▓▓▓')
    assert.equal(bar(140), '▓▓▓▓▓', 'a limit past its cap still renders a full bar')
  })

  test('meters render in value order, and every one of them is optional', () => {
    assert.deepEqual(
      meterParts({ model: 'gpt', effort: 'high', ctxPct: 41, windows: [{ label: '5h', pct: 62 }] }),
      ['**gpt** high', 'ctx 41%', '5h ▓▓▓░░ 62%'],
    )
    assert.deepEqual(meterParts({ model: 'opus', effort: null, ctxPct: null, windows: null }), ['**opus**'])
    assert.deepEqual(meterParts(null), [])
  })
})

describe('AccountUsage', () => {
  const payload = (five, seven) => ({
    five_hour: { utilization: five, resets_at: '2026-08-03T10:39:59Z' },
    seven_day: { utilization: seven, resets_at: '2026-08-05T01:59:59Z' },
  })
  const home = () => {
    fs.mkdirSync(path.join(dir, '.claude', 'cache'), { recursive: true })
    return dir
  }
  const cache = (obj) => fs.writeFileSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), JSON.stringify(obj))
  const creds = (token) => fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }))
  const never = () => { throw new Error('the network must not be reached') }

  test('both sources are read, and the fresher reading wins', () => {
    home()
    cache(payload(18, 57))
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      cachedUsageUtilization: { fetchedAtMs: Date.now() + 60_000, utilization: payload(4, 9) },
    }))
    const u = new AccountUsage({ home: dir, enabled: false })
    assert.deepEqual(u.windows(), [{ label: '5h', pct: 4 }, { label: '7d', pct: 9 }])
  })

  test('a reading with no windows in it is not a reading', () => {
    home()
    cache({ five_hour: null, seven_day: null, limits: [] })
    assert.equal(accountWindows({ five_hour: null }), null)
    assert.equal(new AccountUsage({ home: dir, enabled: false }).windows(), null)
  })

  test('a fresh reading is never refetched', async () => {
    home()
    cache(payload(18, 57))
    const u = new AccountUsage({ home: dir, fetchImpl: never })
    assert.deepEqual(u.windows(), [{ label: '5h', pct: 18 }, { label: '7d', pct: 57 }])
  })

  test('a stale reading is refetched, and the refresh lands in the shared cache file', async () => {
    home()
    creds('tok-1')
    cache(payload(18, 57))
    const old = Date.now() - USAGE_STALE_MS - 1000
    fs.utimesSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), old / 1000, old / 1000)
    let seen = null
    const u = new AccountUsage({
      home: dir,
      fetchImpl: async (url, opts) => {
        seen = { url, auth: opts.headers.authorization }
        return { ok: true, status: 200, json: async () => payload(31, 60) }
      },
    })
    assert.deepEqual(u.windows(), [{ label: '5h', pct: 18 }, { label: '7d', pct: 57 }], 'the stale reading still serves while the refresh runs')
    await u.pending
    assert.equal(seen.auth, 'Bearer tok-1')
    assert.match(seen.url, /\/api\/oauth\/usage$/)
    assert.deepEqual(u.windows(), [{ label: '5h', pct: 31 }, { label: '7d', pct: 60 }])
  })

  test('the attempt stamp is a shared lock: a recent attempt by anyone blocks the fetch', () => {
    home()
    creds('tok-1')
    // No cache at all — the most stale state there is — but statusline.sh
    // touched the stamp a minute ago, so this fetcher stands down.
    fs.writeFileSync(path.join(dir, '.claude', 'cache', 'oauth-usage.attempt'), '')
    const u = new AccountUsage({ home: dir, fetchImpl: never, now: () => Date.now() + USAGE_ATTEMPT_MS - 60_000 })
    assert.equal(u.windows(), null)
  })

  test('a refused token is never refreshed — fetching stops until the CLI writes a new one', async () => {
    home()
    creds('expired')
    let calls = 0
    const u = new AccountUsage({
      home: dir,
      log: () => {},
      fetchImpl: async () => { calls += 1; return { ok: false, status: 401, json: async () => ({}) } },
    })
    u.windows()
    await u.pending
    assert.equal(calls, 1)

    // A later tick, well past every throttle: still refused, because nothing
    // about the credential changed.
    const later = Date.now() + 10 * USAGE_ATTEMPT_MS
    u.now = () => later
    fs.rmSync(path.join(dir, '.claude', 'cache', 'oauth-usage.attempt'), { force: true })
    u.windows()
    await u.pending
    assert.equal(calls, 1, 'the daemon does not retry, and it does not refresh')
    assert.equal(fs.readFileSync(path.join(dir, '.claude', '.credentials.json'), 'utf8'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'expired' } }),
      'the credential file is never written')

    // The CLI refreshed the token: the mtime moved, so the daemon tries again.
    creds('tok-2')
    fs.rmSync(path.join(dir, '.claude', 'cache', 'oauth-usage.attempt'), { force: true })
    u.windows()
    await u.pending
    assert.equal(calls, 2)
  })

  test('account_bars off keeps reading the cached copy and never touches the endpoint', () => {
    home()
    cache(payload(18, 57))
    const old = Date.now() - USAGE_STALE_MS - 1000
    fs.utimesSync(path.join(dir, '.claude', 'cache', 'oauth-usage.json'), old / 1000, old / 1000)
    const u = new AccountUsage({ home: dir, enabled: false, fetchImpl: never })
    assert.deepEqual(u.windows(), [{ label: '5h', pct: 18 }, { label: '7d', pct: 57 }])
  })
})

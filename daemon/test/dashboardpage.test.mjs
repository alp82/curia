// The read screens (#264) — home, maps, agents, feed.
//
// The page has no build step: the file the sidecar serves IS the reviewed
// source. So its test loads that same file, lifts its one script into a vm, and
// calls the screens with a payload — no browser, no headless render, no eyes on
// pixels. What is pinned here is what the screens SAY, which is the half a
// human reading the preview cannot check by looking: that a null fleet reads as
// unreadable rather than idle, that an unstamped frontier reads as uncomputed
// rather than empty, that the tab title carries the needs-you count, and that a
// journal event nobody wrote prose for is still legible.
//
// The screens take the payload as an argument for exactly this reason. A screen
// that read a global would be a screen this file could not drive.

import { test, describe, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { DEFAULT_DASHBOARD_INDEX, DASHBOARD_PROTO } from '../src/dashboard.mjs'
import { GitHubAppSetup } from '../src/githubapp.mjs'

// The page boots itself only when a real document holds `#app`, so this fake
// one keeps the load inert: no render, no poll, no timer. `fetch` never settles
// on purpose — a rejection would flip the offline marker and every screen below
// would be testing that instead.
function pageScript() {
  const html = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
  const script = /<script>([\s\S]*)<\/script>/.exec(html)
  assert.ok(script, 'the page carries its script inline — there is no build step')
  return script[1]
}

function loadPage({ fetchImpl = () => new Promise(() => {}), confirmImpl = undefined } = {}) {
  const storage = new Map()
  const ctx = vm.createContext({
    document: { title: '', getElementById: () => null, addEventListener() {}, visibilityState: 'hidden' },
    window: { addEventListener() {} },
    location: { hash: '' },
    fetch: fetchImpl,
    confirm: confirmImpl,
    setTimeout,
    clearTimeout,
    console,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  })
  vm.runInContext(pageScript(), ctx)
  return ctx
}

function loadPollingPage({ visibilityState = 'visible', mount = false } = {}) {
  const listeners = new Map()
  const timers = new Map()
  const reads = []
  let timerId = 0
  const document = {
    title: '',
    visibilityState,
    activeElement: null,
    getElementById: (id) => (mount && id === 'app' ? { set innerHTML(_value) {} } : null),
    addEventListener: (name, listener) => listeners.set(name, listener),
  }
  const ctx = vm.createContext({
    document,
    window: { addEventListener() {} },
    location: { hash: '' },
    fetch: async (url) => {
      reads.push(url)
      return { ok: true, json: async () => url === '/api/settings' ? SETTINGS() : payload() }
    },
    setTimeout: (callback) => {
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    console,
  })
  vm.runInContext(pageScript(), ctx)
  return { page: ctx, document, listeners, timers, reads }
}

// The wire shape of `GET /overview` (#262), with the ctx meter #264 joins onto
// each agent. Every fixture below starts from this and overrides one section.
const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString()
const ahead = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString()

const OVERVIEW = () => ({
  at: at(0),
  // `config` is the six reloadable settings the service is RUNNING (#362). It
  // agrees with SETTINGS() below on purpose: the ordinary state is a service
  // running the files, and each test that wants a stale one says so.
  daemon: {
    port: 4271,
    uptime_s: 7200,
    auto_dispatch: true,
    max_concurrent: 3,
    config: {
      loaded_at: at(7200),
      dispatch: { auto_dispatch: true, max_concurrent: 3, poll_interval_s: 60, prototype_variations: 5, messages_per_send: 4 },
      overseer: { live_pane_cap: 3 },
      watch: [{ repo: 'alp82/curia', mode: 'auto' }, { repo: 'alp82/aistack', mode: 'map' }],
      routing: {
        defaults: [{ type: 'grilling', model: 'opus' }, { type: 'research', model: 'gpt' }, { type: 'untyped', model: 'opus' }],
        models: [{ name: 'fable', active: false }, { name: 'opus', active: true }, { name: 'gpt', active: true }],
      },
    },
  },
  agents: [
    {
      session: 'curia-263', repo: 'alp82/curia', ticket: '263', title: 'The sidecar stands up',
      model: 'claude-opus-5', reviewer: false, state: 'ready', uptime_s: 900,
      result_received: false, tmux_live: true, waiting_on: [], ctx_pct: 41, ctx_over: false,
      // how long ago it last reached curia (#370) — a reading of the live
      // daemon process, null when that process has heard nothing
      last_contact_s: 12,
    },
    {
      session: 'curia-255', repo: 'alp82/curia', ticket: '255', title: 'The note queue drains in order',
      model: 'gpt-5.6-sol', reviewer: false, state: 'ready', uptime_s: 3600,
      result_received: false, tmux_live: true, waiting_on: [{ id: 'esc-7', kind: 'choice' }],
      ctx_pct: 68, ctx_over: false, last_contact_s: 480,
    },
    {
      session: 'curia-review-263', repo: 'alp82/curia', ticket: '263', title: 'Cross-check of curia-263',
      model: 'gpt-5.6-sol', reviewer: true, state: 'ready', uptime_s: 120,
      result_received: false, tmux_live: true, waiting_on: [], ctx_pct: null, ctx_over: false,
      last_contact_s: 3,
    },
  ],
  untracked: [],
  recent: [{ kind: 'finished', repo: 'alp82/curia', ticket: '261' }],
  fleet_error: null,
  escalations: [{
    id: 'esc-7', agent: 'curia-255', ticket: '255', kind: 'choice',
    prompt: 'Two notes race the same expiry line. Drop the older note, or post both with stamps?',
    options: ['Drop the older note', 'Post both with stamps'], preview_url: null,
    opened_at: at(720), agent_died: false, rendered: true, thread_id: '99',
  }],
  review_gate: [{
    id: 'esc-9', agent: 'curia-261', ticket: '261', kind: 'review-gate', prompt: 'is this done?',
    options: null, preview_url: null, opened_at: at(300), agent_died: false, rendered: true,
    thread_id: '98', pull_request: 'https://github.com/alp82/curia/pull/262',
    // The digest counted when the gate opened (#355). It rides the record, so
    // the card costs no read — and the page must draw it from here, never
    // re-count it on the poll.
    diff: {
      uncommitted: false, files: 4, added: 812, deleted: 233, capped: false,
      rank_rule: 'source first, then tests, then docs, generated and lock files last — largest first inside each class',
      list: [
        { path: 'daemon/src/dashboard.mjs', added: 120, deleted: 4, status: 'M', binary: false, untracked: false, hunks: 9, from: null },
        { path: 'daemon/test/page.test.mjs', added: 40, deleted: 2, status: 'A', binary: false, untracked: false, hunks: 3, from: null },
        { path: 'docs/adr/0019-x.md', added: 30, deleted: 0, status: 'A', binary: false, untracked: false, hunks: 1, from: null },
        { path: 'daemon/package-lock.json', added: 622, deleted: 227, status: 'M', binary: false, untracked: false, hunks: 11, from: null },
      ],
    },
    diff_error: null,
  }],
  bridge: 'up',
  bridge_health: { state: 'up', since: at(9000), unhealthy_for_s: 0, last_error: null },
  usage: [
    { provider: 'anthropic', from: 'account', session: null, windows: [
      { label: '5h', pct: 58, elapsed_pct: 48, resets_at: ahead(90), fresh: true },
      { label: '7d', pct: 22, elapsed_pct: 41, resets_at: ahead(4000), fresh: true },
    ] },
    // TWO windows on openai, the spent one rolling LATER than the other (#677).
    // The strip's note used to be marked hot by one window and worded by
    // another, and one window could not show that.
    { provider: 'openai', from: 'transcript', session: 'curia-255', windows: [
      { label: '5h', pct: 97, elapsed_pct: 48, resets_at: ahead(240), fresh: true },
      { label: '7d', pct: 12, elapsed_pct: 30, resets_at: ahead(20), fresh: true },
    ] },
  ],
  // The credential warnings still standing (#380). The ordinary state is none:
  // the tests that want one say so.
  token_warnings: [],
  // The pre-emptive holds standing (#384), same rule: the ordinary state is a
  // box dispatching on every lane.
  pre_cooling: [],
  events: [
    { ts: at(600), type: 'agent_spawned', agent: 'curia-255', repo: 'alp82/curia', ticket: '255', model: 'gpt-5.6-sol', harness: 'codex' },
    { ts: at(400), type: 'esc_open', id: 'esc-7', agent: 'curia-255', ticket: '255', kind: 'choice', prompt: 'Two notes race the same expiry line.' },
    { ts: at(60), type: 'credentials_swept', agent: 'curia-263', ticket: '263', repo: 'alp82/curia' },
  ],
  deploy: { in_flight: null, last: null, verdict_read_error: null },
  frontier: {
    computed_at: at(120),
    repos: [
      { repo: 'alp82/curia', lane: 'map', numbers: [265, 266], agentOnly: 2, items: [
        { number: 265, title: 'The settings write', labels: ['wayfinder:task'], model: 'claude-opus-5', map: 244, mapTitle: 'Curia gets a face', unblocks: [
          { number: 267, title: 'The chat embeds the timeline attach', labels: ['wayfinder:task'] },
        ] },
        { number: 266, title: 'The verbs reach the browser', labels: ['wayfinder:grilling'], model: 'gpt-5.6-sol', map: 244, mapTitle: 'Curia gets a face', unblocks: [] },
      ] },
      { repo: 'alp82/aistack', error: 'gh api failed: HTTP 502' },
    ],
  },
  // The complete map snapshot (#687), which is where every map fact the page
  // draws comes from (#700). `frontier` above is the takeable reading only.
  maps: {
    computed_at: at(90),
    error: null,
    maps: [{
      repo: 'alp82/curia', number: 244, title: 'Curia gets a face', latest_event_at: at(40),
      url: 'https://github.com/alp82/curia/issues/244',
      counts: { walked: 18, in_flight: 1, takeable: 2, blocked: 1, fog: 2, total: 22 },
      walked: [{ number: 243, title: 'The accepted frame', type: 'prototype' }],
      in_flight: [{
        number: 255, title: 'The note queue drains in order', type: 'task',
        assignees: ['alp82'], agent: { session: 'curia-255', model: 'gpt-5.6-sol' },
      }],
      takeable: [
        { number: 265, title: 'The settings write', type: 'task', model: 'claude-opus-5', unblocks: [
          { number: 267, title: 'The chat embeds the timeline attach' },
        ] },
        { number: 266, title: 'The verbs reach the browser', type: 'grilling', model: 'gpt-5.6-sol', unblocks: [
          { number: 267, title: 'The chat embeds the timeline attach' },
        ] },
      ],
      blocked: [{
        number: 267, title: 'The chat embeds the timeline attach', type: 'task',
        blockers: [{ number: 265, title: 'The settings write' }, { number: 266, title: 'The verbs reach the browser' }],
      }],
      fog: [{ text: 'The native dialog seam' }, { text: 'Search result excerpts' }],
    }],
  },
})

const payload = (overrides = {}) => ({
  poll_interval_s: 5,
  read_at: at(2),
  daemon_up: true,
  daemon_port: 4271,
  error: null,
  error_since: null,
  overview: { ...OVERVIEW(), ...overrides },
})

// The model credentials (#642, #648, #661). The base OVERVIEW carries no
// `credentials` section on purpose — a service older than the section is a real
// wire — so every test that wants one says so, out of these.
//
// `lane` is #661's field: what the credential did to the BOX, which is the half
// no state word could carry. `dispatching` is the hold as Cooling holds it, and
// `agents` is who is on the lane.
const LANE = (provider, agents = null) => ({
  provider, dispatching: !agents, agents: agents ?? [],
})
// The incident this map exists for, on the wire. The access token is `expiring`
// — perfectly usable for another two days — and the lane is unrecoverable all
// the same, which is the one case where the state word lies (#646).
const HELD_CREDENTIALS = () => ({
  consumers: [{
    consumer: 'codex', provider: 'openai', state: 'expiring', expires_at: ahead(2880),
    last_refresh_at: at(864000), store: '/home/curia/.codex/auth.json',
    last_error: 'OpenAI answered HTTP 401 `refresh_token_reused`',
    held: { by: 'provider', code: 'refresh_token_reused', status: 401, at: at(120), why: 'OpenAI answered HTTP 401 `refresh_token_reused`' },
    lane: LANE('openai', ['curia-574', 'curia-578']),
  }],
  reauth: null,
})
const WAITING_REAUTH = (over = {}) => ({
  provider: 'openai', session: 'curia-auth-openai', state: 'waiting',
  url: 'https://auth.openai.com/codex/device', code: '83CC-A4ZT', typed: false,
  terminal_url: 'https://box.taile1a2b.ts.net:8443/?arg=curia-auth-openai',
  started_at: at(180), expires_at: ahead(27), seconds_left: 1620, ...over,
})
const THREE_ROWS = () => ({
  consumers: [
    { consumer: 'codex', provider: 'openai', state: 'valid', expires_at: ahead(10080), last_refresh_at: at(3600), lane: LANE('openai') },
    { consumer: 'claude', provider: 'anthropic', state: 'unknown', expires_at: null, lane: LANE('anthropic'),
      why: 'this credential was seeded from an env file rather than adopted from a login, so curia knows no date for it — sign in once to get one' },
    { consumer: 'overseer', provider: 'anthropic', state: 'unknown', expires_at: null, lane: LANE('anthropic'),
      why: 'this credential was seeded from an env file rather than adopted from a login, so curia knows no date for it — sign in once to get one' },
  ],
  reauth: null,
})

// What a reader sees, with the markup taken out.
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

// The page runs in a vm, so an object it built has a different realm's
// prototype and deepEqual would refuse it on that alone.
const plain = (x) => JSON.parse(JSON.stringify(x))

describe('the Curia app frame (#686)', () => {
  let page
  let shell

  before(() => {
    page = loadPage()
    page.document.getElementById = (id) => (id === 'app' ? { set innerHTML(value) { shell = value } } : null)
    page.payload = payload()
    page.render()
  })

  test('the desktop drawer names every Curia app screen in the decided order', () => {
    const drawer = /<nav class="drawer"[\s\S]*?<\/nav>/.exec(shell)?.[0]
    assert.ok(drawer)
    assert.deepEqual(
      [...drawer.matchAll(/<span class="nav-label">([^<]+)<\/span>/g)].map((match) => match[1]),
      // Credentials sits between Chat and Settings (#661). It landed while the
      // Curia app frame was in review, so the two agreed on every screen but this
      // one until they met on `main`. Setup (#874) sits before Settings: it is
      // the first-run frame, read most of the time and acted on once.
      ['Home', 'Maps', 'Agents', 'Feed', 'Chat', 'Credentials', 'Setup', 'Settings'],
    )
  })

  test('the mobile notch bar keeps four tabs around the Agents key', () => {
    const notch = /<nav class="notchbar"[\s\S]*?<\/nav>/.exec(shell)?.[0]
    assert.ok(notch)
    assert.deepEqual(
      [...notch.matchAll(/<span class="nav-label">([^<]+)<\/span>/g)].map((match) => match[1]),
      ['Home', 'Maps', 'Agents', 'Feed', 'Settings'],
    )
    assert.match(page.screenAgents(payload()), /onclick="goto\('chat'\)"[^>]*>Chat</)
    assert.match(page.screenAgents({ ...payload(), overview: null }), /onclick="goto\('chat'\)"[^>]*>Chat</)
  })

  test('the Agents key carries a zero needs-you count as a number', () => {
    assert.match(page.mobileNav(0, ''), /<span class="nav-icon num">0<\/span>/)
  })

  test('every screen receives the same held overview reading', () => {
    const held = payload()
    const screens = [
      page.screenHome,
      page.screenMaps,
      page.screenAgents,
      page.screenFeed,
      page.screenChat,
      page.screenSettings,
    ]
    for (const screen of screens) assert.match(text(screen(held)), /read \d+s ago/)
  })

  test('navigation markers pair their color with a word or number', () => {
    page.settings = SETTINGS()
    page.draft = JSON.parse(JSON.stringify(page.settings))
    page.settings.dispatch.poll_interval_s = 5
    page.render()
    assert.match(shell, /class="nav-marker"[^>]*>stale<\/span>/)
    assert.doesNotMatch(shell, /title="the service is not running these files">●/)
  })

  test('light and dark themes state the same browser color contract', () => {
    const source = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(source, /:root \{[^}]*color-scheme: dark;/s)
    assert.match(source, /prefers-color-scheme: light[\s\S]*:root:not\(\[data-theme="dark"\]\) \{[^}]*color-scheme: light;/)
  })

  test('a hidden tab cancels its refresh and resumes with one immediate read', async () => {
    const browser = loadPollingPage()
    await browser.page.tick()
    assert.equal(browser.reads.length, 1)
    assert.equal(browser.timers.size, 1)

    browser.document.visibilityState = 'hidden'
    browser.listeners.get('visibilitychange')()
    assert.equal(browser.timers.size, 0)

    browser.document.visibilityState = 'visible'
    browser.listeners.get('visibilitychange')()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(browser.reads.length, 2)
    assert.equal(browser.timers.size, 1)
  })

  test('a page that boots hidden takes no overview read', () => {
    const browser = loadPollingPage({ visibilityState: 'hidden', mount: true })
    assert.equal(browser.reads.filter((url) => url === '/api/overview').length, 0)
  })
})

describe('the read screens (#264)', () => {
  let page
  before(() => { page = loadPage() })

  describe('home — the all-three (#248)', () => {
    test('Curia app Home leads with the verdict and keeps map progress, momentum, and the type mix in one glance', () => {
      const t = text(page.screenHome(payload()))
      assert.match(t, /2 needs you.*3 agents live/)
      assert.match(t, /Curia gets a face.*18\/22.*2 fog/)
      assert.match(t, /Momentum.*events in 24h/)
      assert.match(t, /Type mix.*1 task.*1 grilling/)
    })

    test('Home ranks every open need by effective wait, with three full rows and compact rows after them', () => {
      // No row carries an `unblocks` field: the wire never does (#761). Ticket
      // 265 ranks ahead because the map's blocked set names it as a blocker and
      // the frontier says it unblocks 267, both in the shared fixture.
      const p = payload({
        usage: [], token_warnings: [], dispatch_holds: [], credentials: { consumers: [], reauth: null },
        escalations: [
          { id: 'old', agent: 'curia-old', ticket: '1', kind: 'free-text', prompt: 'Oldest wait', opened_at: at(15_000) },
          { id: 'route', agent: 'curia-route', ticket: '265', kind: 'free-text', prompt: 'Unblocks two', opened_at: at(60) },
          { id: 'plain', agent: 'curia-plain', ticket: '3', kind: 'free-text', prompt: 'Plain thirty', opened_at: at(1_800) },
          { id: 'small', agent: 'curia-small', ticket: '4', kind: 'free-text', prompt: 'Small wait', opened_at: at(120) },
        ],
      })
      const html = page.screenHome(p)
      assert.equal((html.match(/class="need-rank full/g) ?? []).length, 3)
      assert.equal((html.match(/class="need-rank compact/g) ?? []).length, 2)
      assert.ok(html.indexOf('Oldest wait') < html.indexOf('Unblocks two'))
      assert.ok(html.indexOf('Unblocks two') < html.indexOf('Plain thirty'))
      assert.match(html, /need-rank full aged/)
    })

    test('the unblock bonus is derived from the wire and is flat (#761)', () => {
      const o = payload({ usage: [], token_warnings: [], dispatch_holds: [], credentials: { consumers: [], reauth: null }, escalations: [] }).overview
      // 265 and 266 block 267 on the map; 265 unblocks 267 on the frontier too.
      assert.deepEqual([...page.unblockSet(o)].sort(), ['265', '266'])
      // A fabricated `unblocks` field on the row itself is ignored.
      o.escalations = [
        { id: 'fake', agent: 'a', ticket: '9', kind: 'free-text', prompt: 'fabricated', opened_at: at(60), unblocks: [1, 2, 3] },
        { id: 'one', agent: 'b', ticket: '265', kind: 'free-text', prompt: 'blocks one on the frontier', opened_at: at(60) },
        { id: 'two', agent: 'c', ticket: '266', kind: 'free-text', prompt: 'blocks one on the map', opened_at: at(60) },
      ]
      const items = page.attentionItems(o)
      const score = (id) => items.find((i) => i.id === id).score
      assert.equal(score('fake'), 1)
      assert.equal(score('one'), 91, 'a flat 90 on top of the minute')
      assert.equal(score('two'), 91, 'the map blocked set alone is enough, and the count does not multiply')
      // A frontier repo that failed to read adds nothing and throws nothing.
      o.frontier = { computed_at: null, repos: [{ repo: 'x', error: 'boom' }] }
      o.maps = { computed_at: null, maps: null, error: 'boom' }
      assert.equal(page.unblockSet(o).size, 0)
    })

    test('amber follows the effective score and states the wait and the reason (#761)', () => {
      const p = payload({
        usage: [], token_warnings: [], dispatch_holds: [], credentials: { consumers: [], reauth: null }, review_gate: [],
        escalations: [
          // 170 minutes raw is under the 240 line, but with the 90 unblock it ranks overdue.
          { id: 'byrank', agent: 'curia-a', ticket: '265', kind: 'free-text', prompt: 'Amber by rank', opened_at: at(170 * 60) },
          { id: 'young', agent: 'curia-b', ticket: '4', kind: 'free-text', prompt: 'Young and plain', opened_at: at(60) },
        ],
      })
      const html = page.screenHome(p)
      const rows = [...html.matchAll(/<div class="need-rank[^"]*" id="need-([^"]+)">(?:<div class="need-why">([^<]*)<\/div>)?/g)].map((m) => [m[1], m[2] ?? ''])
      assert.deepEqual(rows, [['byrank', 'waited 170 min · overdue · unblocks other work'], ['young', '']])
      assert.match(html, /need-rank full aged" id="need-byrank"/)
      assert.doesNotMatch(html, /aged" id="need-young"/)
    })

    test('the tiles, the attention list and the fleet all draw one snapshot', () => {
      const html = page.screenHome(payload())
      const t = text(html)
      // Two things want the operator: one question and one gate.
      assert.match(t, /2 needs you/)
      assert.match(t, /3 agents live/)
      assert.match(t, /1 review gate/)
      // The header, the tile and the list are one number since #677: the spent
      // window is a banner now, and the count is the list's own length.
      assert.match(t, /Needs you \(2\)/)
      assert.match(t, /Two notes race the same expiry line/, 'the question is shown whole, not summarized')
      // #266 turned the options from named text into the buttons that send
      // them. The labels are still the whole set — that is what this pins.
      assert.match(t, /Drop the older note/, 'and its options are named')
      assert.match(t, /Post both with stamps/)
      assert.match(t, /review gate — #261/)
      assert.match(t, /pull\/262/, 'the gate carries the pull request nothing else carries')
      assert.match(t, /Fleet \(3\)/)
      assert.match(t, /curia-263/)
      assert.match(t, /Last events/)
    })

    test('the home screen shows the deploy in flight', () => {
      const t = text(page.screenHome(payload({
        deploy: {
          in_flight: { prev_version: '1.3.0', next_version: '1.4.0', state: 'rolling-back' },
          last: null,
          verdict_read_error: null,
        },
      })))
      assert.match(t, /Deploy/)
      assert.match(t, /a deploy is in flight: 1\.3\.0 → 1\.4\.0/)
      assert.match(t, /state rolling-back/)
    })

    test('the home screen keeps the last deploy verdict and its error excerpt', () => {
      const t = text(page.screenHome(payload({
        deploy: {
          in_flight: null,
          last: {
            state: 'rolled-back', prev_version: '1.3.0', next_version: '1.4.0',
            reason: 'docker compose could not recreate the services', by: 'u1',
            resolved_at: at(30), log: 'Cannot connect to the Docker daemon',
          },
          verdict_read_error: null,
        },
      })))
      assert.match(t, /Last deploy/)
      assert.match(t, /ROLLED BACK: 1\.3\.0 → 1\.4\.0/)
      assert.match(t, /docker compose could not recreate the services/)
      assert.match(t, /Cannot connect to the Docker daemon/)
    })

    test('an unreadable deploy verdict is not an empty deploy history', () => {
      const t = text(page.screenHome(payload({
        deploy: { in_flight: null, last: null, verdict_read_error: 'the last deploy verdict is unreadable: invalid JSON' },
      })))
      assert.match(t, /Last deploy/)
      assert.match(t, /the last deploy verdict is unreadable: invalid JSON/)
    })

    // #384. The strip below says how full a window is. This says curia has
    // STOPPED dispatching on that provider, which is the fact an operator
    // watching an idle box needs, and it gets the top of the page.
    test('a pre-emptive hold banners the provider and the lift time', () => {
      const held = payload({
        pre_cooling: [{ provider: 'anthropic', window: '5h', pct: 93, reset_at: ahead(75) }],
      })
      const html = page.screenHome(held)
      const t = text(html)
      assert.match(t, /anthropic held before the limit/)
      assert.match(t, /the 5h window is at 93%/)
      assert.match(t, /it lifts at \d\d:\d\d/, 'the lift time is the whole point of the line')
      assert.match(t, /model:/, 'and the one act that steps over it')
      // It is not on the Needs-you list, for the reason a spent window is not:
      // no operator act ends it.
      assert.match(t, /2 needs you/)
      assert.equal(text(page.screenHome(payload())).includes('held before the limit'), false,
        'a box dispatching on every lane banners nothing')
    })

    test('the provider strip says each window once, and no agent row repeats it', () => {
      const html = page.screenHome(payload())
      assert.equal((html.match(/class="prov"/g) ?? []).length, 2, 'one reading per provider')
      assert.match(text(html), /anthropic 5h 58% 7d 22%/)
      // The windows are an account fact. A per-agent copy would be the thing
      // #248 removed from the fleet.
      assert.equal(/<td[^>]*>[^<]*7d/.test(html), false)
    })

    // The hot note names the SPENT window (#677). openai's 5h is spent and rolls
    // in four hours; its 7d rolls in twenty minutes. The note used to be marked
    // hot by the first and worded by the second.
    test("a spent provider's note names that window's own roll, not the soonest", () => {
      const html = page.screenHome(payload())
      const hot = /<span class="pnote hot">([^<]*)<\/span>/.exec(html)?.[1]
      assert.ok(hot, 'the spent provider carries a hot note')
      assert.match(hot, /^5h rolls /, 'the 7d rolling sooner must not take the note')
      // anthropic has nothing spent, so its note is the ordinary soonest one.
      assert.match(html, /<span class="pnote ">5h rolls /)
      // A spent window whose instant has already passed keeps its note, where
      // `nextReset` dropped it.
      const stale = page.screenHome(payload({
        usage: [{ provider: 'openai', from: 'account', session: null, windows: [
          { label: '5h', pct: 99, elapsed_pct: 100, resets_at: at(60), fresh: false },
        ] }],
      }))
      assert.match(stale, /<span class="pnote hot">5h rolls /)
    })

    // The spent window's promotion (#677). It left the answer surface, where it
    // was never answerable, for the top of Home beside the pre-emptive hold —
    // and it is the harder of the two failures, so it is the louder banner.
    test('a spent window is a banner at the top of Home, not an attention item', () => {
      const html = page.screenHome(payload())
      const t = text(html)
      assert.match(html, /class="hold-banner spent-banner"/)
      assert.match(t, /openai the 5h window is spent at 97%/)
      assert.match(t, /it rolls at \d\d:\d\d/)
      assert.match(t, /Nothing you can press ends this/, 'the reason it is not on the answer surface')
      // The banner sits above the tiles, where the hold does.
      assert.ok(html.indexOf('spent-banner') < html.indexOf('stat-tiles'))
      // And it is off the list, which is what the count already knew.
      assert.equal(page.attentionItems(payload().overview).length, 2)
      assert.equal(text(page.screenHome(payload({ usage: [] }))).includes('window is spent'), false,
        'a box with no spent window banners nothing')
    })

    // THE INVARIANT #670 could not state and the old shape could not hold: the
    // header number and `needsYou` are the same number, whatever the payload
    // carries. Both read `attentionItems`, so a new item class cannot reach one
    // surface alone.
    test('the Needs-you header and the count are one number, on every payload', () => {
      const cases = [
        payload(),
        payload({ escalations: [], review_gate: [] }),
        payload({ usage: [{ provider: 'openai', from: 'account', session: null, windows: [{ label: '5h', pct: 100, elapsed_pct: 20, resets_at: ahead(60), fresh: true }] }] }),
        payload({ dispatch_holds: [{ ticket: '444', repo: 'alp82/curia', failures: 2, kind: 'failed-spawn' }] }),
        payload({ token_warnings: [{ holder: 'app', key: 'alp82', repo: 'alp82/curia', fault: 'unreachable', message: 'm', said: true, refusal: 'r', fix: 'f' }] }),
        payload({ credentials: HELD_CREDENTIALS() }),
      ]
      for (const one of cases) {
        const n = page.needsYou(one.overview)
        assert.match(text(page.screenHome(one)), new RegExp(`Needs you \\(${n}\\)`),
          `the header must say ${n}`)
        assert.match(text(page.screenHome(one)), new RegExp(`${n} needs you`), 'and so must the tile')
      }
    })

    // The credential watch (#380). The warning used to be a boot log line, so
    // what these pin is that it now reaches a surface the operator reads and
    // STAYS there: a Discord line scrolls away, and a dying token does not.
    test('a repo the app cannot reach joins the attention list, with the act that ends it', () => {
      const t = text(page.screenHome(payload({
        token_warnings: [{
          holder: 'app', key: 'alp82', repo: 'alp82/aistack', fault: 'unreachable',
          message: 'the app installation does not grant it', said: true,
          refusal: 'no agent can be dispatched to it',
          fix: 'Grant the repo to curia\'s app installation on GitHub (docs/github-app.md).',
        }],
      })))
      assert.match(t, /cannot reach alp82\/aistack — the app installation does not grant it/)
      assert.match(t, /no agent can be dispatched to it/)
      assert.match(t, /Grant the repo to curia's app installation on GitHub/)
    })

    // The journal outlives the shape it was written in (#466). A row from the
    // retired expiry half stands on this list until the next pass clears it,
    // and it must render rather than throw at a field that is not there.
    test('a warning from the retired expiry half renders rather than breaking the page', () => {
      const t = text(page.screenHome(payload({
        token_warnings: [{
          holder: 'agent', key: 'CURIA_AGENT_GH_TOKEN_ALP82', repo: 'alp82/curia', fault: 'expiring',
          days: 3, expires_at: '2026-08-19 06:20:31 UTC', step: 3, said: true,
          where: 'daemon/.env.daemon', refusal: 'an agent on it will fail at its first gh call',
        }],
      })))
      assert.match(t, /cannot reach alp82\/curia/)
      assert.match(t, /an agent on it will fail at its first gh call/)
    })

    // #661 moved the detail to the screen that owns it. What Home keeps is a
    // POINTER: enough to know a credential wants you, and the way there. The
    // whole card is gone on purpose — the detail said in two places is how two
    // surfaces drift apart, and the Credentials suite below pins it where it
    // now lives.
    test('a dead credential leaves one pointer on Home, not the flow', () => {
      const t = text(page.screenHome(payload({ credentials: HELD_CREDENTIALS() })))
      assert.match(t, /codex the model credential cannot be refreshed and the lane is held/)
      assert.match(t, /open Credentials to sign in/)
      assert.ok(!/refresh_token_reused/.test(t), 'the reason is the screen\'s, said once')
      assert.ok(!/frozen mid-ticket/.test(t), 'so is the blast radius')
    })

    test('the pointer names every consumer behind it, so the collapse hides nobody', () => {
      const t = text(page.screenHome(payload({
        credentials: {
          consumers: [
            { consumer: 'claude', provider: 'anthropic', state: 'expired', why: 'the year is up', lane: LANE('anthropic') },
            { consumer: 'overseer', provider: 'anthropic', state: 'expired', why: 'the year is up', lane: LANE('anthropic') },
          ],
          reauth: null,
        },
      })))
      assert.match(t, /claude, overseer the model credential/)
    })

    // A running openai login says nothing about a dead anthropic credential, so
    // one must not swallow the other.
    test('a login in flight does not hide a dead credential on another provider', () => {
      const t = text(page.screenHome(payload({
        credentials: {
          consumers: [{ consumer: 'claude', provider: 'anthropic', state: 'expired', why: 'the year is up', lane: LANE('anthropic') }],
          reauth: WAITING_REAUTH(),
        },
      })))
      assert.match(t, /openai is signing in/)
      assert.match(t, /claude the model credential is expired/)
    })

    test('a dead credential on the provider now signing in is not said twice', () => {
      const t = text(page.screenHome(payload({
        credentials: { ...HELD_CREDENTIALS(), reauth: WAITING_REAUTH() },
      })))
      assert.match(t, /openai is signing in/)
      assert.ok(!/open Credentials to sign in/.test(t), 'the login IS the act — a second line asking for it is noise')
    })

    // #645 finding 1, and the reason the badge existed. By this count's own
    // stated test — whether an operator act ends it — a dead model credential
    // is the strongest member of the set, and it was the only member missing.
    test('a dead model credential is counted, so the badge is hot at 3am', () => {
      const one = payload({ credentials: HELD_CREDENTIALS() })
      assert.equal(page.needsYou(one.overview), 3, 'one question, one gate, one credential pointer')
      assert.match(text(page.screenHome(one)), /3 needs you/)
    })

    // The loose end #661 was asked to pick: the count follows the LIST, not the
    // consumers. Three dead rows behind one provider are one act reached by one
    // visit, and the list shows one line for them.
    test('the count is pointers, not consumers', () => {
      const three = payload({
        credentials: {
          consumers: [
            { consumer: 'codex', provider: 'openai', state: 'expired', why: 'gone', lane: LANE('openai') },
            { consumer: 'claude', provider: 'anthropic', state: 'expired', why: 'gone', lane: LANE('anthropic') },
            { consumer: 'overseer', provider: 'anthropic', state: 'expired', why: 'gone', lane: LANE('anthropic') },
          ],
          reauth: null,
        },
      })
      assert.equal(page.credentialPointers(three.overview).length, 1)
      assert.equal(page.needsYou(three.overview), 3, 'and the badge counts that one line')
    })

    // Silent by design, and the reason the screen exists: an operator with a
    // healthy box must have somewhere to look, and it is not this list.
    test('a healthy or seeded credential puts nothing on the list', () => {
      const quiet = payload({
        credentials: {
          consumers: [
            { consumer: 'codex', provider: 'openai', state: 'valid', expires_at: ahead(9000), lane: LANE('openai') },
            { consumer: 'claude', provider: 'anthropic', state: 'unknown', why: 'seeded from an env file', lane: LANE('anthropic') },
            { consumer: 'overseer', provider: 'anthropic', state: 'unowned', why: 'not brokered', lane: LANE('anthropic') },
          ],
          reauth: null,
        },
      })
      assert.deepEqual(plain(page.credentialPointers(quiet.overview)), [])
      assert.equal(page.needsYou(quiet.overview), 2, 'the question and the gate, and nothing else')
    })

    // #721: a login that disappeared without a sentence is the same class of bug
    // as the credential that disappeared without one. The ROW that already
    // stands is where the sentence lands (#661 moved the detail off Home), so
    // the operator who pressed Sign in is told why the attempt is gone rather
    // than finding it simply absent.
    test('the row says why the last login ended, and only for its own provider', () => {
      const ended = {
        provider: 'openai', state: 'expired', after_s: 900, ended_at: '2026-08-24T10:15:00Z',
        why: 'the one-time code ran out before anybody finished the login',
      }
      const row = (consumer, provider) => ({
        consumer, provider, state: 'expired', expires_at: null, last_error: 'the access token expired',
      })
      const t = text(page.screenCredentials(payload({
        credentials: { consumers: [row('codex', 'openai'), row('claude', 'anthropic')], reauth: null, reauth_ended: ended },
      })))
      assert.match(t, /the last login ended at .*the one-time code ran out before anybody finished the login/)
      assert.equal(t.match(/the last login ended/g).length, 1, 'the anthropic row is not told about an openai login')
      // and the way back is still on the row the sentence joined
      assert.match(t, /Sign in from a browser/)
    })

    // Nothing to say is said as nothing. A page with no ended login draws the
    // ordinary row, unchanged.
    test('a row with no ended login behind it gains no line', () => {
      const t = text(page.screenCredentials(payload({
        credentials: {
          consumers: [{ consumer: 'codex', provider: 'openai', state: 'expired', expires_at: null, last_error: 'the access token expired' }],
          reauth: null, reauth_ended: null,
        },
      })))
      assert.ok(!/the last login ended/.test(t))
    })

    test('a credential warning IS counted, because an operator act is what ends it', () => {
      // The rule that separates it from a spent window, which the count skips:
      // a window rolls on its own clock, and a token nobody mints stays dead.
      const one = payload({
        token_warnings: [{
          holder: 'app', key: 'alp82', repo: 'alp82/curia', fault: 'unreachable',
          message: 'the app installation does not grant it', said: true, refusal: 'r', fix: 'f',
        }],
      })
      assert.equal(page.needsYou(one.overview), 3)
      assert.match(text(page.screenHome(one)), /3 needs you/)
    })

    // The failed-spawn step-over (#444). It is on this list by the list's own
    // test — an operator act is what ends it — and a spent window is not.
    test('a ticket the auto loop steps over joins the attention list, and is counted', () => {
      const one = payload({ dispatch_holds: [{ ticket: '444', repo: 'alp82/curia', failures: 2, kind: 'failed-spawn' }] })
      const t = text(page.screenHome(one))
      assert.match(t, /died at the spawn 2 times, so auto-dispatch steps over it/)
      assert.match(t, /clears the count/, 'the act that ends it is the point of the line')
      assert.equal(page.needsYou(one.overview), 3)
    })

    test('a ticket whose automatic resume died names that cause on the attention list', () => {
      const one = payload({ dispatch_holds: [{ ticket: '578', repo: 'alp82/curia', deaths: 2, kind: 'death-resume' }] })
      const t = text(page.screenHome(one))
      assert.match(t, /automatic resume also died, so auto-dispatch steps over it/)
      assert.match(t, /resume you type dispatches it again and clears the count/)
      assert.equal(page.needsYou(one.overview), 3)
    })

    test('a ticket whose stall recovery ended names the operator actions', () => {
      const one = payload({ dispatch_holds: [{ ticket: '574', repo: 'alp82/curia', kind: 'stall-watchdog' }] })
      const t = text(page.screenHome(one))
      assert.match(t, /needs operator action after automatic stall recovery stopped/)
      assert.match(t, /resume 574.*surviving worktree/)
      assert.equal(page.needsYou(one.overview), 3)
    })

    test('the needs-you count is escalations plus the gate, and the tab title carries it', () => {
      assert.equal(page.needsYou(payload().overview), 2)
      assert.equal(page.needsYou(payload({ escalations: [], review_gate: [] }).overview), 0)
      // The tab title is written in render(), off that same function.
      page.payload = payload()
      const el = { innerHTML: '' }
      page.document.getElementById = () => el
      page.render()
      assert.equal(page.document.title, '(2) Curia app')
      page.payload = payload({ escalations: [], review_gate: [] })
      page.render()
      assert.equal(page.document.title, 'Curia app')
      page.document.getElementById = () => null
    })

    test('an unreadable fleet is not an idle box', () => {
      const t = text(page.screenHome(payload({ agents: null, untracked: null, recent: null, fleet_error: 'tmux is indeterminate' })))
      assert.match(t, /the fleet could not be read — tmux is indeterminate/)
      assert.doesNotMatch(t, /No agent is running/)
      assert.match(t, /Two notes race the same expiry line/, 'and every other section still draws')
    })

    test('an idle box says so, and says it plainly', () => {
      const t = text(page.screenHome(payload({ agents: [] })))
      assert.match(t, /No agent is running/)
      assert.match(t, /0 agents live/)
    })

    test('with no snapshot at all the page says that, and invents none', () => {
      const t = text(page.screenHome({ poll_interval_s: 5, read_at: null, daemon_up: false, overview: null }))
      assert.match(t, /No snapshot yet/)
    })
  })

  describe('agents', () => {
    test('the Focus roster opens the first Needs-you agent with meters, story, links, and today\'s endings', () => {
      page.UI.agents = { selected: null, open: false }
      const html = page.screenAgents(payload())
      const t = text(html)
      assert.match(html, /class="agent-focus"/)
      assert.ok(html.indexOf('curia-255') < html.indexOf('curia-263'), 'the agent that needs you leads the roster')
      assert.match(t, /Selected.*The note queue drains in order/)
      assert.match(t, /waiting · waiting for you · waits 12m/, 'the state sentence says how long the operator has been asked')
      assert.match(t, /gpt-5\.6-sol.*68%.*1\.0h/, 'model, context and elapsed are meters')
      assert.match(t, /Story.*spawned on gpt-5\.6-sol/)
      assert.match(html, /href="#chat\/curia-255"/)
      assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/issues\/255"/)
      assert.match(t, /Ended today.*finished alp82\/curia#261/)
    })

    test('the status bar counts the fleet and the needs in words, and the roster names every state', () => {
      const t = text(page.screenAgents(payload()))
      assert.match(t, /agents 3\/3/)
      assert.match(t, /1 need you/)
      assert.match(t, /bridge up/)
      assert.match(t, /Ask.*The note queue drains in order.*waiting/, 'an open question makes an agent waiting, whatever its record says, and its chip says Ask')
      assert.match(t, /The sidecar stands up.*working/, 'ready and working are one state')
      assert.match(t, /Cross-check of curia-263/)
    })

    test('the roster ranks the open question first, then the gate, then calm work', () => {
      const p = payload()
      p.overview.agents[0].waiting_on = [{ id: 'esc-9', kind: 'review-gate' }]
      const html = page.screenAgents(p)
      const order = ['curia-255', 'curia-263', 'curia-review-263'].map((s) => html.indexOf(`agentSelect('${s}')`))
      assert.deepEqual([...order].sort((a, b) => a - b), order)
      assert.match(text(html), /Gate.*The sidecar stands up/)
      assert.match(text(html), /2 need you/, 'the gate is a need on this page')
    })

    test('the opened agent carries lane, model, effort, context, tokens, elapsed and contact as meters', () => {
      const p = payload()
      Object.assign(p.overview.agents[1], { harness: 'codex', effort: 'high', ctx_tokens: 128_400 })
      page.UI.agents = { selected: 'curia-255', open: false }
      const t = text(page.screenAgents(p))
      assert.match(t, /codex lane/)
      assert.match(t, /gpt-5\.6-sol model/)
      assert.match(t, /high effort/)
      assert.match(t, /68% context/)
      assert.match(t, /128k tokens/)
      assert.match(t, /1\.0h elapsed/)
      assert.match(t, /8m contact/)
    })

    test('a missing meter is a dash, never zero, and over 100% is marked', () => {
      page.UI.agents = { selected: 'curia-review-263', open: false }
      const t = text(page.screenAgents(payload()))
      assert.match(t, /— lane/, 'the fixture states no lane for the reviewer')
      assert.match(t, /— context/, 'curia-review-263 has no transcript reading')
      assert.match(t, /— tokens/)
      assert.doesNotMatch(t, /0%/)
      const over = payload()
      over.overview.agents[0].ctx_pct = 118
      over.overview.agents[0].ctx_over = true
      page.UI.agents = { selected: 'curia-263', open: false }
      assert.match(text(page.screenAgents(over)), /118% ⚠ context/, 'over 100% is a complaint about the denominator, and is marked')
    })

    test('the contact meter reads the silence, and states which null it is (#370)', () => {
      page.UI.agents = { selected: 'curia-263', open: false }
      assert.match(text(page.screenAgents(payload())), /12s contact/, 'an agent heard 12 seconds ago')
      const quiet = payload()
      quiet.overview.agents[0].last_contact_s = null
      const q = text(page.screenAgents(quiet))
      assert.match(q, /never contact/)
      assert.match(q, /never is an agent that has said nothing since it spawned/, 'the page says what its words mean')
      quiet.overview.agents[0].last_contact_s = null
      quiet.overview.agents[0].uptime_s = null
      const a = text(page.screenAgents(quiet))
      assert.match(a, /adopted contact/)
      assert.match(a, /adopted after a restart/)
      assert.doesNotMatch(a, /\b0s\b/, 'no reading is never 0 seconds ago')
    })

    test('the gated agent links its pull request, and nobody else does', () => {
      const p = payload()
      p.overview.agents[0].waiting_on = [{ id: 'esc-9', kind: 'review-gate' }]
      p.overview.review_gate[0].agent = 'curia-263'
      page.UI.agents = { selected: 'curia-263', open: false }
      assert.match(page.screenAgents(p), /href="https:\/\/github\.com\/alp82\/curia\/pull\/262">pull request →/)
      page.UI.agents = { selected: 'curia-255', open: false }
      assert.doesNotMatch(page.screenAgents(p), /pull request →/)
    })

    test('every act on an agent hands off to Chat: the page carries no verb of its own', () => {
      const html = page.screenAgents(payload())
      assert.doesNotMatch(html, /legacy-controls|noteBox\(|openDiff\(|teleport\(|cancelAgent\(/)
      assert.match(text(html), /Notes, cancels and the terminal live in Chat/)
      assert.match(html, /href="#chat\/curia-255">open Chat →/)
    })

    test('today\'s endings read newest first with the clock and a Chat link, and an old ending has fallen off', () => {
      const p = payload({ recent: [
        { kind: 'finished', repo: 'alp82/curia', ticket: '261', agent: 'curia-261', at: at(3600) },
        { kind: 'cancelled', repo: 'alp82/curia', ticket: '240', agent: 'curia-240', at: at(600) },
        { kind: 'died', repo: 'alp82/curia', ticket: '199', agent: 'curia-199', at: at(3 * 24 * 3600) },
        { kind: 'finished', repo: 'alp82/curia', ticket: '100', agent: null, at: null },
      ] })
      const html = page.screenAgents(p)
      const ended = html.slice(html.indexOf('agent-ended'))
      const t = text(ended)
      assert.ok(t.indexOf('cancelled alp82/curia#240') < t.indexOf('finished alp82/curia#261'), 'newest first')
      assert.match(ended, /href="#chat\/curia-240">chat →/)
      assert.doesNotMatch(t, /#199/, 'three days ago is not today')
      assert.match(t, /finished alp82\/curia#100.*no session/, 'an ending journalled before the session rode along is kept')
      assert.match(ended, /<time>\d\d:\d\d<\/time>/)
    })

    test('the endings stay on the page when the fleet is idle or unreadable', () => {
      assert.match(text(page.screenAgents(payload({ agents: [] }))), /No agent is running.*Ended today.*finished alp82\/curia#261/)
      assert.match(text(page.screenAgents(payload({ agents: null }))), /could not be read.*Ended today/)
    })

    test('the phone shows the roster or the opened agent, and the route decides which (#709)', () => {
      page.UI.agents = { selected: null, open: false }
      assert.doesNotMatch(page.screenAgents(payload()), /agent-focus" data-open/, 'arriving from the tab is the list')
      page.agentSelect('curia-263')
      assert.equal(page.location.hash, 'agents/curia-263')
      const html = page.screenAgents(payload())
      assert.match(html, /class="agent-focus" data-open="curia-263"/)
      assert.match(text(html), /Selected The sidecar stands up/)
      page.agentBack()
      assert.equal(page.location.hash, 'agents')
      assert.doesNotMatch(page.screenAgents(payload()), /data-open/)
      page.applyAgentsRoute(['agents', 'curia-255'])
      assert.match(page.screenAgents(payload()), /data-open="curia-255"/, 'a reload lands where it left')
      page.applyAgentsRoute(['agents', 'curia-gone'])
      assert.doesNotMatch(page.screenAgents(payload()), /data-open/, 'a session the fleet no longer has falls back to the list')
      page.UI.agents = { selected: null, open: false }
    })

    test('the phone and the desktop read one payload: the split is CSS on the route flag, not a second render', () => {
      const css = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
      assert.match(css, /\.agent-focus\[data-open\] \.agent-roster[^}]*display: none/)
      assert.match(css, /\.agent-focus:not\(\[data-open\]\) \.agent-detail \{ display: none; \}/)
      page.UI.agents = { selected: null, open: false }
      const html = page.screenAgents(payload())
      assert.match(html, /class="agent-roster"/)
      assert.match(html, /class="agent-detail"/, 'both halves render from the one call, and CSS chooses')
    })

    test('the fleet on home carries the same reading', () => {
      const t = text(page.screenHome(payload()))
      assert.match(t, /12s/)
    })

    test('an unreadable fleet says so here too', () => {
      const t = text(page.screenAgents(payload({ agents: null, fleet_error: 'tmux is indeterminate' })))
      assert.match(t, /could not be read — tmux is indeterminate/)
      assert.match(t, /agents —\/3/)
    })
  })

  describe('maps — level two (#768)', () => {
    const takeable = (p = payload()) => {
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244, group: 'takeable' }, open: false }
      return page.screenMaps(p)
    }

    test('a takeable row names what it directly unblocks, from the map snapshot', () => {
      const t = text(takeable())
      assert.match(t, /#265 The settings write/)
      assert.match(t, /task · routed to claude-opus-5 · unblocks 1/)
      assert.match(t, /#267 The chat embeds the timeline attach/)
      assert.match(t, /computed \d+m ago/, 'the page states the age of the reading')
    })

    test('the kids are the snapshot\'s, not the frontier wire\'s', () => {
      const p = payload()
      p.overview.frontier = { computed_at: null, repos: [] }
      p.overview.maps.maps[0].takeable[1].unblocks = []
      const html = takeable(p)
      assert.match(text(html), /#267 The chat embeds the timeline attach/)
      assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/issues\/267"/, 'a kid is a link to its ticket')
      assert.match(text(html), /grilling · routed to gpt-5\.6-sol · unblocks nothing yet/)
    })

    test('one Maps screen: the second one, its views, and its state are gone from the page', () => {
      assert.equal(page.screenFrontier, undefined)
      assert.equal(page.UI.fr, undefined)
      const script = pageScript()
      for (const name of ['screenFrontier', 'FR_VIEWS', 'frCards', 'frTree', 'frSet', 'UI.fr']) {
        assert.doesNotMatch(script, new RegExp(name.replace('.', '\\.')), `${name} is no longer in the page`)
      }
    })
  })

  describe('maps', () => {
    test('the full rail uses operator vocabulary while the snapshot keeps its wire keys', () => {
      const p = payload()
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }
      assert.ok(p.overview.maps.maps[0].walked)
      assert.ok(p.overview.maps.maps[0].in_flight)
      assert.ok(p.overview.maps.maps[0].takeable)

      const html = page.screenMaps(p)
      const t = text(html)
      assert.match(t, /18 done/)
      assert.match(t, /1 running/)
      assert.match(t, /2 frontier/)
      assert.doesNotMatch(t, /18 walked/)
      assert.doesNotMatch(t, /1 in flight/)
      assert.doesNotMatch(t, /2 takeable/)
    })

    test('one selected map renders the complete rail from done through fog', () => {
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }
      const html = page.screenMaps(payload())
      const t = text(html)
      assert.match(t, /Curia gets a face/)
      const rail = /<div class="map-rail">([\s\S]*?)<\/aside>/.exec(html)?.[1]
      assert.ok(rail, 'the detail is one full map rail')
      for (const group of ['walked', 'in-flight', 'takeable', 'blocked', 'fog']) {
        assert.match(rail, new RegExp(`class="map-stage ${group}`), `${group} is present in the one rail`)
      }
      assert.ok(rail.indexOf('map-stage walked') < rail.indexOf('map-stage in-flight'))
      assert.ok(rail.indexOf('map-stage in-flight') < rail.indexOf('map-stage takeable'))
      assert.ok(rail.indexOf('map-stage takeable') < rail.indexOf('map-stage blocked'))
      assert.ok(rail.indexOf('map-stage blocked') < rail.indexOf('map-stage fog'))
      assert.match(t, /behind #265 The settings write, #266 The verbs reach the browser/)
      assert.match(t, /The native dialog seam.*not yet specified/)
      assert.match(t, /Search result excerpts.*not yet specified/)
      assert.match(t, /The settings write/)
      assert.match(t, /task.*claude-opus-5.*Start/)
      assert.match(html, /startTicket\('alp82\/curia','265'\)/)
    })

    test('the miniature band gives one grid track to every actual item', () => {
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }
      const html = page.screenMaps(payload())
      const band = /<div class="map-band"[^>]*style="[^"]*grid-template-columns:repeat\(24,minmax\(0,1fr\)\)[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]
      assert.ok(band, '18 done + 1 running + 2 frontier + 1 blocked + 2 fog make 24 equal tracks')
      for (const [group, count] of [['walked', 18], ['in-flight', 1], ['takeable', 2], ['blocked', 1], ['fog', 2]]) {
        assert.match(band, new RegExp(`class="map-seg ${group}[^\"]*"[^>]*style="[^"]*grid-column:span ${count}`), `${group} spans its count`)
      }
    })

    test('a zero-count stage stays in the full rail but consumes no miniature track', () => {
      const p = payload()
      p.overview.maps.maps[0].counts.in_flight = 0
      p.overview.maps.maps[0].in_flight = []
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }
      const html = page.screenMaps(p)
      const band = /<div class="map-band"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]
      assert.ok(band)
      assert.doesNotMatch(band, /class="map-seg in-flight/)
      assert.match(html, /class="map-stage in-flight[^\"]*"/)
      assert.match(text(html), /0 running/)
    })

    test('maps needing the operator lead, then calm maps sort by the latest event', () => {
      const p = payload()
      p.overview.maps.maps.push({
        repo: 'alp82/curia', number: 300, title: 'A newer calm map', latest_event_at: at(1),
        counts: { walked: 1, in_flight: 0, takeable: 0, blocked: 0, fog: 0, total: 1 },
        walked: [{ number: 301, title: 'Done', type: 'untyped' }],
        in_flight: [], takeable: [], blocked: [], fog: [],
      })
      page.UI.maps = { repo: 'all', selected: null, open: false }
      let html = page.screenMaps(p)
      assert.ok(html.indexOf('Curia gets a face') < html.indexOf('A newer calm map'))

      p.overview.escalations = []
      p.overview.review_gate = []
      p.overview.agents.forEach((agent) => { agent.waiting_on = [] })
      html = page.screenMaps(p)
      assert.ok(html.indexOf('A newer calm map') < html.indexOf('Curia gets a face'))
    })

    // #700. Two readings used to answer the same question: the dispatcher's
    // frontier pass carried a second copy of every map, and the page drew that
    // one. There is one map reading now, and this is the page half of it.
    test('every map fact comes from the complete snapshot, never from the frontier reading', () => {
      const p = payload()
      p.overview.frontier.repos[0].maps = [{
        repo: 'alp82/curia', number: 999, title: 'A map from the frontier pass',
        counts: { walked: 0, in_flight: 0, takeable: 0, blocked: 0, fog: 0 },
        walked: [], in_flight: [], takeable: [], blocked: [], fog: [],
      }]
      page.UI.maps = { repo: 'all', selected: null, open: false }
      const t = text(page.screenMaps(p))
      assert.match(t, /Curia gets a face/)
      assert.doesNotMatch(t, /A map from the frontier pass/)
    })

    test('the walked fraction is the snapshot total, and the fog rides beside it', () => {
      page.UI.maps = { repo: 'all', selected: null, open: false }
      assert.match(text(page.screenMaps(payload())), /18 \/22 \+2/)
    })

    test('a snapshot curia could not read is not an empty map set', () => {
      const p = payload()
      p.overview.maps = { computed_at: null, maps: null, error: 'gh api failed: HTTP 502' }
      const t = text(page.screenMaps(p))
      assert.match(t, /could not be read/)
      assert.match(t, /HTTP 502/)
      assert.match(t, /not an empty map set/)
      assert.doesNotMatch(t, /No open map matches this project/)
    })

    test('an uncomputed snapshot reads as uncomputed rather than as no maps', () => {
      const p = payload()
      p.overview.maps = { computed_at: null, maps: null, error: null }
      assert.match(text(page.screenMaps(p)), /No map snapshot has been computed yet/)
    })

    test('frontier tickets are tall two-line rows with their routed Start control', () => {
      const p = payload()
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }
      let html = page.screenMaps(p)
      assert.match(html, /class="map-detail-row frontier-ticket"/)
      assert.match(html, /class="frontier-copy"[\s\S]*class="frontier-meta"/)
      assert.match(html, /class="btn sm primary"[^>]*>Start<\/button>/)

      p.overview.maps.maps[0].takeable = []
      p.overview.maps.maps[0].counts.takeable = 0
      html = page.screenMaps(p)
      assert.match(text(html), /Nothing is on the frontier\. The way is running or behind a blocker\./)
    })

    test('a running ticket keeps working and needs-you semantics beside its owner and model', () => {
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }
      const html = page.screenMaps(payload())
      assert.match(html, /class="map-stage in-flight needs"/)
      assert.match(html, /class="activity"[^>]*>working<\/span>/)
      assert.match(html, /class="needs-badge"[^>]*>needs you<\/span>/)
      assert.match(text(html), /The note queue drains in order.*needs you.*alp82.*gpt-5\.6-sol/)
    })

    test('the whole map selector supports click and keyboard selection', () => {
      page.UI.maps = { repo: 'all', selected: null, open: false }
      const html = page.screenMaps(payload())
      assert.match(html, /class="map-card[^\"]*"[^>]*role="button"/)
      assert.match(html, /class="map-card[^\"]*"[^>]*tabindex="0"/)
      assert.match(html, /class="map-card[^\"]*"[^>]*onclick="mapSelect\('alp82\/curia','244'\)"/)
      assert.match(html, /class="map-card[^\"]*"[^>]*onkeydown="mapCardKey\(event,'alp82\/curia','244'\)"/)
    })

    // The phone's half of the split is a ROUTE (#700): it opens over the list,
    // reloads into the same view, and the browser's back leaves it.
    test('choosing a map routes to its full rail, and back returns to the list', () => {
      page.UI.maps = { repo: 'all', selected: null, open: false }
      page.mapSelect('alp82/curia', 244)
      assert.equal(page.location.hash, 'maps/alp82/curia/244')
      assert.equal(page.UI.maps.open, true)
      assert.match(page.screenMaps(payload()), /<div class="map-layout" data-open>/)

      page.mapBack()
      assert.equal(page.location.hash, 'maps')
      assert.equal(page.UI.maps.open, false)
      assert.doesNotMatch(page.screenMaps(payload()), /data-open/)
    })

    test('a map-only hash opens the full rail, and an old group hash remains compatible', () => {
      page.UI.maps = { repo: 'all', selected: null, open: false }
      page.applyMapRoute(['maps', 'alp82', 'curia', '244'])
      assert.equal(page.UI.maps.selected.repo, 'alp82/curia')
      assert.equal(String(page.UI.maps.selected.map), '244')
      assert.equal(page.UI.maps.selected.group, undefined)
      assert.equal(page.UI.maps.open, true)
      assert.match(text(page.screenMaps(payload())), /The native dialog seam/)

      page.applyMapRoute(['maps', 'alp82', 'curia', '244', 'fog'])
      assert.equal(page.UI.maps.selected.repo, 'alp82/curia')
      assert.equal(String(page.UI.maps.selected.map), '244')
      assert.equal(page.UI.maps.selected.group, undefined)
      assert.equal(page.UI.maps.open, true)
      assert.match(text(page.screenMaps(payload())), /The native dialog seam/)

      page.applyMapRoute(['maps'])
      assert.equal(page.UI.maps.open, false)
    })

    test('the maps tab lands on the list, never on the last detail opened', () => {
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: true }
      page.goto('maps')
      assert.equal(page.UI.maps.open, false)
      assert.equal(page.location.hash, 'maps')
    })

    // A pause is only ever ended by hand (github.mjs `mapCloseBlockers`), so the
    // one surface that could start work on a paused map must not offer to.
    test('a paused map is listed and says so, and hands out no start control', () => {
      const p = payload()
      p.overview.maps.maps[0].deferred = true
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }
      const html = page.screenMaps(p)
      const t = text(html)
      assert.match(t, /Curia gets a face/, 'the map stays listed')
      assert.match(t, /The settings write/, 'its tickets stay listed')
      assert.match(t, /paused/)
      assert.match(t, /only ever ended by hand/)
      assert.doesNotMatch(html, /startTicket/)
    })

    test('the shell exposes every desktop page and the four-tab mobile bar with the Agents key', () => {
      page.payload = payload()
      const el = { innerHTML: '' }
      page.document.getElementById = () => el
      page.render()
      assert.match(el.innerHTML, /class="drawer"/)
      assert.match(el.innerHTML, /class="notchbar"/)
      assert.match(el.innerHTML, /class="agents-key[^\"]*"/)
      const desktop = el.innerHTML.slice(el.innerHTML.indexOf('drawer'), el.innerHTML.indexOf('</nav>'))
      assert.match(text(desktop), /curia · app Home 2 Maps Agents Feed Chat Credentials Setup Settings/)
      page.document.getElementById = () => null
    })
  })

  describe('feed', () => {
    test('a Feed visit projects through a login-scoped Action before it posts the read (#704, #811)', async () => {
      const prior = at(3_600)
      const posts = []
      const p = loadPage({ fetchImpl: async (url, init) => { posts.push([url, init]); return { ok: true, json: async () => ({}) } } })
      p.payload = { ...payload({ feed_reads: { 'alp82@example.com': prior } }), operator: 'alp82@example.com' }
      p.enter('feed')
      assert.equal(p.UI.feed.lastRead, prior, 'the marker is the PREVIOUS read, not the one that just happened')
      const action = p.actionFor({ conflict_key: 'feed-read:alp82@example.com' })
      assert.equal(action.status, 'pending', 'the visit is visible in the same frame as entering Feed')
      assert.equal(action.kind, 'feed-read')
      assert.deepEqual(posts.map(([u, i]) => [u, i.method, JSON.parse(i.body).action_id]), [
        ['/api/feed/read', 'POST', action.action_id],
      ])
      assert.ok(!p.localStorage.getItem('curia.app.feed.last-read:alp82@example.com'), 'no browser-local copy: the journal is the one record')
    })

    test('a first visit under a login draws no marker', () => {
      const p = loadPage({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
      p.payload = { ...payload(), operator: 'new@example.com' }
      p.enter('feed')
      assert.equal(p.UI.feed.lastRead, null)
      assert.ok(!/Since you left/.test(p.screenFeed(p.payload)))
    })

    test('a refused visit reconciles in Feed and leaves the next visit available (#811)', async () => {
      const requests = []
      const p = loadPage({ fetchImpl: async (_url, init) => {
        const sent = JSON.parse(init.body)
        requests.push(sent)
        return {
          ok: false,
          status: 409,
          json: async () => ({ action: {
            action_id: sent.action_id, kind: 'feed-read', target: 'alp82@example.com',
            conflict_key: 'feed-read:alp82@example.com', status: 'refused', revision: requests.length,
            reason: 'the journal is read-only',
          } }),
        }
      } })
      p.payload = { ...payload(), operator: 'alp82@example.com' }

      p.enter('feed')
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(p.actionFor({ conflict_key: 'feed-read:alp82@example.com' }), null)
      assert.match(text(p.screenFeed(p.payload)), /Feed visit was not recorded.*journal is read-only/)

      p.enter('feed')
      assert.equal(requests.length, 2, 'the failed bookkeeping does not disable another visit')
    })

    test('Feed separates news from mechanics and places the last-visit marker over a 24-hour density strip', () => {
      page.UI.feed = { lastRead: at(500), operator: 'alp82@example.com', family: 'all' }
      const html = page.screenFeed(payload())
      assert.equal((html.match(/class="density-cell/g) ?? []).length, 24)
      assert.match(html, /24 h · 3 events/)
      assert.match(html, /class="feed-news needs"/)
      assert.match(html, /class="feed-mechanic"/)
      const marker = html.indexOf('Since you left')
      assert.ok(html.indexOf('Two notes race') < marker)
      assert.ok(marker < html.indexOf('spawned on gpt-5.6-sol'))
      assert.match(html, /href="#chat\/curia-255"/)
      assert.match(text(html), /Needs you/, 'a needs-you row says so in a word, not only a tint')
    })

    test('a family chip narrows the stream to one family, and says so when nothing is left', () => {
      page.UI.feed = { lastRead: null, operator: 'alp82@example.com', family: 'need' }
      const wire = () => { const h = page.screenFeed(payload()); return h.slice(0, h.indexOf('legacy-feed')) }
      let html = wire()
      assert.match(html, /class="feed-chip on"[^>]*>needs you</)
      assert.match(html, /Two notes race/)
      assert.ok(!/spawned on gpt-5.6-sol/.test(html), 'a spawn is the agents family')
      page.UI.feed.family = 'deploy'
      assert.match(text(wire()), /No deploys events in the journal tail/)
      page.feedFilter('all')
      assert.equal(page.UI.feed.family, 'all')
    })

    test('a run of mechanics folds into one named group, and a filter opens it (#523)', () => {
      page.UI.feed = { lastRead: null, operator: null, family: 'all' }
      const events = Array.from({ length: 6 }, (_, i) => ({ ts: at(600 - i * 10), type: 'reconcile', boot: false }))
      events.push({ ts: at(5), type: 'esc_open', id: 'esc-9', agent: 'curia-9', ticket: '9', kind: 'choice', prompt: 'Pick one.' })
      const wire = () => { const h = page.screenFeed(payload({ events })); return h.slice(0, h.indexOf('legacy-feed')) }
      let html = wire()
      assert.match(html, /<details class="feed-fold"><summary>6 mechanics · \d\d:\d\d – \d\d:\d\d — reconcile<\/summary>/)
      assert.equal((html.match(/class="feed-mechanic"/g) ?? []).length, 6, 'nothing is dropped, only paced')
      assert.ok(html.indexOf('Pick one.') < html.indexOf('feed-fold'), 'news stays above the fold it precedes')
      page.UI.feed.family = 'system'
      html = wire()
      assert.match(html, /<details class="feed-fold" open>/)
      assert.ok(!/Pick one/.test(html))
    })

    test('a news row lands on the owning Chat, map, or GitHub record', () => {
      page.UI.feed = { lastRead: null, operator: null, family: 'all' }
      const html = page.screenFeed(payload({ events: [
        { ts: at(30), type: 'agent_died', agent: 'curia-4', repo: 'o/r', ticket: '4' },
        { ts: at(20), type: 'ticket_resolved', repo: 'o/r', ticket: '5', map: 99 },
        { ts: at(10), type: 'lifecycle_closed', repo: 'o/r', ticket: '6' },
      ] }))
      assert.match(html, /href="#chat\/curia-4">Chat/)
      assert.match(html, /href="#maps\/o\/r\/99\/walked">Map/)
      assert.match(html, /href="https:\/\/github.com\/o\/r\/issues\/6">GitHub/)
    })

    test('the journal reads as sentences, newest first', () => {
      const t = text(page.screenFeed(payload()))
      const spawn = t.indexOf('spawned on gpt-5.6-sol')
      const ask = t.indexOf('asks — choice')
      assert.ok(ask > -1 && spawn > ask, 'the last thing that happened is the first thing on the page')
      assert.match(t, /curia-255 spawned on gpt-5.6-sol — codex · alp82\/curia#255/)
    })

    test('an event nobody wrote prose for is still legible', () => {
      // `credentials_swept` has no line in the table on purpose: the service
      // grows event types, and the page must not go blank on the day one ships.
      const t = text(page.screenFeed(payload()))
      assert.match(t, /credentials swept — curia-263 · alp82\/curia#263/)
    })

    // #645 finding 3. These fell through the fallback until #661, and the
    // fallback names an agent or a ticket subject — a credential event carries
    // neither, so the busiest hour this map exists for read as
    // `credential refresh failed — —`. Each line now says the CONSEQUENCE.
    test('the credential events read as sentences, and say what stopped', () => {
      const t = text(page.screenFeed(payload({
        events: [
          { ts: at(300), type: 'credential_refresh_failed', consumer: 'codex', code: 'refresh_token_reused', status: 401, terminal: true, why: 'OpenAI answered HTTP 401 `refresh_token_reused`' },
          { ts: at(290), type: 'credential_hold', consumer: 'codex', provider: 'openai', by: 'provider', why: 'OpenAI answered HTTP 401 `refresh_token_reused`', frozen: ['curia-574', 'curia-578'] },
          { ts: at(200), type: 'reauth_started', provider: 'openai', session: 'curia-auth-openai' },
          { ts: at(100), type: 'reauth_completed', provider: 'openai', session: 'curia-auth-openai', after_s: 140, expires_at: ahead(14400) },
          { ts: at(90), type: 'credential_fanned_out', consumer: 'codex', agents: ['curia-574', 'curia-578'] },
          { ts: at(80), type: 'credential_hold_lifted', provider: 'openai' },
        ],
      })))
      assert.match(t, /the codex model credential could not be refreshed: OpenAI answered HTTP 401/)
      assert.match(t, /the openai lane is held .* Nothing new dispatches to it, and 2 live agent\(s\) are frozen in place: curia-574, curia-578/)
      assert.match(t, /a openai sign-in is running in curia-auth-openai/)
      assert.match(t, /the openai sign-in completed after 2m/)
      assert.match(t, /2 live codex agent\(s\) took the fresh credential: curia-574, curia-578/)
      assert.match(t, /the openai lane is dispatching again/)
      assert.ok(!/ — — /.test(t), 'the fallback is what these lines exist to stop')
    })

    // The one-time code is on the Credentials screen and on no other surface,
    // and the anthropic token is on none at all. The journal never held either,
    // so this table cannot print what is not there — and nothing here goes
    // looking for a field that would.
    test('no credential line carries a code or a token', () => {
      const src = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
      const table = src.slice(src.indexOf('const EVENTS = {'), src.indexOf('function eventLine'))
      assert.ok(!/e\.code\b(?![^\n]*refresh)/.test(table.split('reauth_')[1] ?? ''), 'no re-auth line reads a code off an event')
      assert.ok(!/e\.token/.test(table))
    })

    test('a give-up reads apart from a failure, because only one is evidence about the credential', () => {
      const t = text(page.screenFeed(payload({
        events: [{ ts: at(60), type: 'credential_refresh_exhausted', consumer: 'codex', attempts: 5, terminal: true, why: 'fetch failed' }],
      })))
      assert.match(t, /curia gave up refreshing the codex model credential after 5 answers it does not recognise/)
    })

    test('a seeded credential says why its expiry reads unknown', () => {
      const t = text(page.screenFeed(payload({
        events: [{ ts: at(60), type: 'credential_seeded', provider: 'anthropic', from: 'daemon/.env.daemon' }],
      })))
      assert.match(t, /seeded from daemon\/\.env\.daemon/)
      assert.match(t, /expiry reads unknown until someone signs in/)
    })

    test('color marks the events that mean attention, and no others', () => {
      const html = page.screenFeed(payload())
      const rows = html.split('<li').slice(1)
      assert.equal(rows.length, 3)
      assert.equal(rows.filter((r) => r.startsWith(' class="warn"')).length, 1, 'the open question')
      assert.equal(rows.filter((r) => r.startsWith(' class="bad"')).length, 0)
    })

    test('an empty journal tail says so', () => {
      assert.match(text(page.screenFeed(payload({ events: [] }))), /The journal tail is empty/)
    })

    test('the home carries the last four events and links to the rest', () => {
      const p = payload()
      p.overview.events = Array.from({ length: 9 }, (_, i) => ({ ts: at(600 - i * 10), type: 'reconcile', boot: false }))
      const html = page.screenHome(p)
      const col = html.slice(html.indexOf('Last events'))
      assert.equal((col.match(/<li/g) ?? []).length, 4)
      assert.match(col, /href="#feed"/)
    })
  })

  describe('the marker every screen carries (#263)', () => {
    test('a service that is not answering shows the age of the held snapshot', () => {
      page.reachable = true
      const p = payload()
      p.daemon_up = false
      p.error = 'connect ECONNREFUSED'
      p.error_since = at(30)
      p.read_at = at(90)
      const t = text(page.screenHome(p))
      assert.match(t, /service restarting/)
      assert.match(t, /showing the snapshot from 2m ago/)
      assert.match(t, /connect ECONNREFUSED/)
      assert.match(t, /Fleet \(3\)/, 'and the held snapshot is still drawn')
    })

    test('a sidecar this page cannot reach is a different fact, and says so', () => {
      page.reachable = false
      assert.match(text(page.screenFeed(payload())), /the console is offline/)
      page.reachable = true
    })
  })

  describe('global search', () => {
    test('the header lens opens typed results with snippets, ages, attention words, and owning destinations', () => {
      page.UI.search = {
        open: true, q: 'curia', loading: false, error: null,
        result: { query: 'curia', errors: [], results: [
          { kind: 'ticket', title: 'Build Curia app', snippet: 'One Curia app address', age_s: 60, attention: 'needs_you', landing: { surface: 'chat', conversation: 'curia-684' } },
          { kind: 'map', title: 'Curia app map', snippet: 'The route', age_s: 120, attention: null, landing: { surface: 'maps', map: 244 } },
          { kind: 'journal', title: 'Agent started', snippet: 'Curia app work began', age_s: 180, attention: null, landing: { surface: 'feed', event: 'event-4' } },
          { kind: 'decision', title: 'Keep one spec', snippet: 'Curia app and Discord', age_s: 240, attention: null, landing: { surface: 'github', url: 'https://github.com/alp82/curia/issues/685' } },
        ] },
      }
      assert.match(page.screenHome(payload()), /class="search-lens"/)
      const html = page.searchOverlay()
      const t = text(html)
      assert.match(html, /class="search-sheet"/)
      assert.match(t, /needs you Build Curia app One Curia app address 1m Chat/)
      assert.match(t, /map Curia app map The route 2m Maps/)
      assert.match(t, /journal Agent started Curia app work began 3m Feed/)
      assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/issues\/685"/)

      page.payload = payload()
      page.searchGo('maps', '244')
      assert.equal(page.UI.screen, 'maps')
      assert.equal(page.UI.maps.selected.map, 244)
      assert.equal(page.UI.search.open, false)

      page.UI.search.q = 'notes'
      page.searchGo('feed', 'event-4')
      assert.match(page.appFeed(page.payload.overview), /class="feed-news needs focus"/)
    })

    test('a ticket or chat hit opens the Chat room for that conversation', () => {
      page.payload = payload()
      page.UI.search = { open: true, q: 'curia', loading: false, error: null, result: { query: 'curia', errors: [], results: [
        { kind: 'chat', title: 'Chat curia-684', snippet: 'One Curia app address', age_s: 5, attention: null, landing: { surface: 'chat', conversation: 'curia-684' } },
      ] } }
      assert.match(page.searchOverlay(), /href="#chat\/curia-684"[^>]*onclick="searchGo\('chat','curia-684'\)/)

      page.searchGo('chat', 'curia-684')

      assert.equal(page.UI.screen, 'chat')
      assert.equal(page.location.hash, 'chat/curia-684')
      assert.equal(page.chat.session, 'curia-684')
      assert.equal(page.UI.search.open, false)
    })

    test('only a state that asks for the operator replaces the kind word', () => {
      page.UI.search = { open: true, q: 'x', loading: false, error: null, result: { query: 'x', errors: [], results: [
        { kind: 'ticket', title: 'A', snippet: 's', age_s: 1, attention: 'ready-for-human', landing: { surface: 'chat', conversation: 'curia-1' } },
        { kind: 'ticket', title: 'B', snippet: 's', age_s: 1, attention: 'needs-info', landing: { surface: 'chat', conversation: 'curia-2' } },
        { kind: 'ticket', title: 'C', snippet: 's', age_s: 1, attention: 'needs_you', landing: { surface: 'chat', conversation: 'curia-3' } },
        { kind: 'journal', title: 'D', snippet: 's', age_s: 1, attention: 'warning', landing: { surface: 'feed', event: 'e' } },
        { kind: 'ticket', title: 'E', snippet: 's', age_s: 1, attention: 'open', landing: { surface: 'chat', conversation: 'curia-4' } },
        { kind: 'map', title: 'F', snippet: 's', age_s: null, attention: 'closed', landing: { surface: 'maps', map: 9 } },
      ] } }
      const html = page.searchOverlay()
      const t = text(html)
      assert.match(t, /needs you A s/)
      assert.match(t, /needs info B s/)
      assert.match(t, /needs you C s/)
      assert.match(t, /warning D s/)
      assert.match(t, /ticket E s/)
      assert.match(t, /map F s/)
      assert.equal((html.match(/class="kind needs"/g) ?? []).length, 4)
    })

    test('a decision opens GitHub in a new tab and a map missing from the snapshot still lands on Maps', () => {
      page.payload = payload()
      page.UI.search = { open: true, q: 'x', loading: false, error: null, result: { query: 'x', errors: [], results: [
        { kind: 'decision', title: 'Keep one spec', snippet: 's', age_s: 1, attention: null, landing: { surface: 'github', url: 'https://github.com/alp82/curia/issues/685#issuecomment-1' } },
      ] } }
      assert.match(page.searchOverlay(), /href="https:\/\/github\.com\/alp82\/curia\/issues\/685#issuecomment-1" target="_blank" rel="noopener"/)

      page.searchGo('maps', '999999')

      assert.equal(page.UI.screen, 'maps')
      assert.equal(page.location.hash, 'maps')
      assert.equal(page.UI.search.open, false)
    })

    test('the lens sits in every page header and takes no navigation slot', () => {
      page.payload = payload()
      page.UI.search = { open: false, q: '', loading: false, error: null, result: null }
      const screens = { home: 'screenHome', maps: 'screenMaps', agents: 'screenAgents', feed: 'screenFeed', chat: 'screenChat', credentials: 'screenCredentials', settings: 'screenSettings' }
      for (const [name, fn] of Object.entries(screens)) {
        page.UI.screen = name
        const html = page[fn](page.payload)
        assert.match(html, /class="search-lens" onclick="openSearch\(\)"/, `${name} has no lens`)
      }
      page.UI.screen = 'home'
      for (const nav of [page.desktopNav(0, ''), page.mobileNav(0, '')]) {
        assert.doesNotMatch(nav, /search/i)
      }
      assert.equal(page.searchOverlay(), '')
      page.openSearch()
      assert.match(page.searchOverlay(), /class="search-sheet" role="dialog"/)
    })

    test('an older response cannot replace results for a newer query', async () => {
      const pending = []
      const searchPage = loadPage({
        fetchImpl: (url) => new Promise((resolve) => pending.push({ url, resolve })),
      })
      searchPage.UI.search.q = 'old'
      const old = searchPage.runSearch()
      searchPage.UI.search.q = 'new'
      const fresh = searchPage.runSearch()
      pending[1].resolve({ ok: true, json: async () => ({ query: 'new', results: [], errors: [] }) })
      await fresh
      pending[0].resolve({ ok: true, json: async () => ({ query: 'old', results: [], errors: [] }) })
      await old

      assert.equal(searchPage.UI.search.result.query, 'new')
    })

    test('closing search clears the loading state of an invalidated request', () => {
      page.UI.search.open = true
      page.UI.search.loading = true

      page.closeSearch()

      assert.equal(page.UI.search.loading, false)
    })
  })
})

// ---------------------------------------------------------------------------
// the settings screen (#265)
// ---------------------------------------------------------------------------
//
// The one screen that writes. What a human can judge on a preview is the
// layout. What they cannot is the arithmetic underneath it: which models the
// default table is allowed to offer, what the patch would actually post, and
// which of the banner's phases each answer from the sidecar lands in. That is
// what this pins.

const SETTINGS = () => ({
  files: { curia: '/home/alp/curia/config/curia.yaml', routing: '/home/alp/curia/config/routing.yaml' },
  dispatch: { auto_dispatch: true, max_concurrent: 3, poll_interval_s: 60, prototype_variations: 5, messages_per_send: 4 },
  overseer: { live_pane_cap: 3 },
  watch: [{ repo: 'alp82/curia', mode: 'auto' }, { repo: 'alp82/aistack', mode: 'map' }],
  watch_modes: ['auto', 'map', 'ready-for-agent'],
  routing: {
    defaults: [{ type: 'grilling', model: 'opus' }, { type: 'research', model: 'gpt' }, { type: 'untyped', model: 'opus' }],
    models: [
      { name: 'fable', provider: 'anthropic', harness: 'claude', id: null, active: false },
      { name: 'opus', provider: 'anthropic', harness: 'claude', id: null, active: true },
      { name: 'gpt', provider: 'openai', harness: 'codex', id: 'gpt-5.6-sol', active: true },
    ],
  },
})

describe('the settings screen (#265)', () => {
  let page

  // A fresh page per test: this screen owns mutable state, and one test's
  // draft must not be another's starting point.
  beforeEach(() => {
    page = loadPage()
    page.settings = SETTINGS()
    page.draft = JSON.parse(JSON.stringify(page.settings))
    page.repos = { login: 'alp82', repos: ['alp82/curia', 'alp82/aistack', 'alp82/annapod'], error: null }
  })

  // The drill state as a pick leaves it: one section open, and the phone off
  // the list in front of it.
  const screen = (section = 'routing') => {
    page.UI.drill.settings = { open: section, list: false }
    return page.screenSettings(payload())
  }
  const rows = (html) => [...html.matchAll(/onclick="openSection\('settings', '(\w+)'\)"/g)].map((m) => m[1])
  const headings = (html) => [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1])

  test('it is a screen now, not a promise of one', () => {
    assert.ok(!text(screen()).includes('lands on #265'))
    assert.match(text(screen()), /Settings/)
  })

  test('Settings starts from a drill-in list and holds dirty edits in one save dock', () => {
    page.UI.drill.settings = { open: null, list: true }
    let html = page.screenSettings(payload())
    assert.match(html, /class="drill"/)
    assert.match(text(html), /Routing.*Projects.*Dispatch.*Connections.*Maintenance/)
    assert.ok(!html.includes('class="dock"'))

    page.openSection('settings', 'routing')
    page.setDispatchField('max_concurrent', '4')
    html = page.screenSettings(payload())
    assert.match(text(html), /‹ settings.*Routing.*grilling.*model default/)
    assert.match(html, /class="dock"/)
    assert.match(text(html), /1 unsaved change.*Save/)
  })

  test('the two files it writes are named on the screen', () => {
    assert.match(text(screen()), /curia\.yaml · routing\.yaml/)
  })

  // ---- the drill-in frame (#699) -------------------------------------------
  //
  // The shape every later Curia app section page renders inside. What is pinned
  // here is the frame's contract rather than these four sections' words: one
  // list, one open section, a way back, and a read that a section takes on
  // arrival instead of on every poll.

  test('the main list names every section, each with a gist of its own', () => {
    const html = screen()
    assert.deepEqual(rows(html), ['routing', 'projects', 'dispatch', 'connections', 'aistack', 'update', 'maintenance'])
    const t = text(html)
    assert.match(t, /Routing opus untyped · 2 of 3 models on/)
    assert.match(t, /Projects 2 repos watched/)
    assert.match(t, /Dispatch auto · 3 agents · 60s/)
    assert.match(t, /Connections state unavailable/)
    assert.match(t, /aistack not read yet/, 'the section takes its own read, so the list says so until it has one')
    assert.match(t, /Update not read yet/, 'so does the update section')
    assert.match(t, /Maintenance in step/, 'a color state says a word too')
  })

  // ---- Update (#883) --------------------------------------------------------
  //
  // The section reads the daily check's record and says what it found. What is
  // pinned: the installed and recommended versions, availability, the two
  // release-notes links, the withdrawal warning, a failed check said as one,
  // and that there is no button, because there is no automatic update.

  const UPDATE = (over = {}) => ({
    managed: true, installed: '1.3.0', recommended: '1.4.0', update_available: true,
    installed_withdrawn: false, withdrawn: [],
    release_notes: { installed: 'https://github.com/alp82/curia/releases/tag/v1.3.0', recommended: 'https://github.com/alp82/curia/releases/tag/v1.4.0' },
    checked_at: at(3600), succeeded_at: at(3600), ok: true, error: null, next_check_at: ahead(1380),
    command: 'curia update', reason: null, ...over,
  })

  test('an available update names both versions, links both release notes, and states the command', () => {
    page.curiaUpdate = UPDATE()
    const html = screen('update')
    const t = text(html)
    assert.match(t, /Update 1\.4\.0 available/, 'the list row says it')
    assert.match(t, /Curia 1\.4\.0 is available\. On the box, run curia update/)
    assert.match(t, /installed 1\.3\.0 release notes for 1\.3\.0/)
    assert.match(t, /recommended 1\.4\.0 release notes for 1\.4\.0/)
    assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/releases\/tag\/v1\.4\.0"/)
    assert.match(t, /Checked 1h ago; the next check is in 23h\. Curia checks once a day and never updates on its own\./)
    assert.ok(!/<button|onclick=/.test(page.setUpdate()), 'nothing in the section starts an update')
  })

  test('no update: the installed version is the recommended one', () => {
    page.curiaUpdate = UPDATE({ installed: '1.4.0', update_available: false })
    const t = text(screen('update'))
    assert.match(t, /Update 1\.4\.0 · up to date/)
    assert.match(t, /1\.4\.0 is the recommended stable release\. Nothing to update\./)
  })

  test('a withdrawn installed version is the first thing said', () => {
    page.curiaUpdate = UPDATE({ installed_withdrawn: true, withdrawn: ['1.3.0'] })
    const t = text(screen('update'))
    assert.match(t, /Update 1\.3\.0 withdrawn/)
    assert.match(t, /The installed version 1\.3\.0 was withdrawn\. The release notes for 1\.3\.0 say why\. Update to 1\.4\.0\./)
    assert.match(t, /withdrawn 1\.3\.0/)
  })

  test('a failed check is said as one, beside the last good read, and never as up to date', () => {
    page.curiaUpdate = UPDATE({ ok: false, error: 'the stable-release index could not be downloaded from https://raw.githubusercontent.com/alp82/curia/main/release/stable.json.', checked_at: at(60), succeeded_at: at(90000), installed: '1.4.0', update_available: false })
    const t = text(screen('update'))
    assert.match(t, /The last check failed 1m ago: the stable-release index could not be downloaded/)
    assert.match(t, /The recommendation shown is from the last successful check, 25h ago\. The running installation is not affected\./)
    assert.ok(!t.includes('up to date') || /1\.4\.0 · up to date/.test(t), 'the gist may say up to date only from a verified read')
  })

  test('a failed check with no success behind it says curia does not know', () => {
    page.curiaUpdate = UPDATE({ ok: false, error: 'no key', recommended: null, update_available: false, succeeded_at: null, release_notes: { installed: 'https://github.com/alp82/curia/releases/tag/v1.3.0', recommended: null } })
    const t = text(screen('update'))
    assert.match(t, /Update 1\.3\.0 · check failed/)
    assert.match(t, /No successful check yet, so curia does not know whether an update exists/)
    assert.match(t, /recommended none/)
  })

  test('a source checkout says the deploy updates it, and a service that cannot be asked is unknown', () => {
    page.curiaUpdate = { managed: false, installed: '0.4.1', recommended: null, update_available: false, installed_withdrawn: false, withdrawn: [], release_notes: { installed: 'https://github.com/alp82/curia/releases/tag/v0.4.1', recommended: null }, reason: 'This Curia runs from a source checkout, so its deploy updates it.' }
    let t = text(screen('update'))
    assert.match(t, /Update 0\.4\.1 · source checkout/)
    assert.match(t, /This Curia runs from a source checkout/)
    page.curiaUpdate = { managed: null, installed: null, error: 'the sidecar answered 502' }
    t = text(screen('update'))
    assert.match(t, /Update curia cannot tell/)
    assert.match(t, /curia cannot say which version is installed: the sidecar answered 502/)
  })

  test('one section is open at a time, and a pick opens another', () => {
    assert.deepEqual(headings(screen('routing')), ['Routing'])
    assert.deepEqual(headings(screen('dispatch')), ['Dispatch'])
    assert.ok(!text(screen('dispatch')).includes('most recently pushed repos'),
      'a section nobody opened draws none of its body')
  })

  test('a phone lands on the list, and the back link returns to it', () => {
    page.UI.drill.settings = { open: null, list: true }
    assert.ok(!page.screenSettings(payload()).includes('data-open'))
    page.openSection('settings', 'projects')
    assert.match(page.screenSettings(payload()), /data-open="projects"/)
    assert.deepEqual(headings(page.screenSettings(payload())), ['Projects'])
    page.backToList('settings')
    assert.ok(!page.screenSettings(payload()).includes('data-open'),
      'the list is what the phone shows again; the desktop shows both either way')
  })

  test('a section takes its own read on arrival, not on every poll', () => {
    page.repos = null
    let reads = 0
    page.loadRepos = () => { reads += 1 }
    page.screenSettings(payload())
    page.screenSettings(payload())
    assert.equal(reads, 0, 'a render is a render — it fetches nothing')
    page.openSection('settings', 'projects')
    assert.equal(reads, 1)
  })

  // ---- routing -------------------------------------------------------------

  test('the ticket-type rows lead and the model list sits behind one click', () => {
    const t = text(screen('routing'))
    assert.match(t, /grilling opus/)
    assert.match(t, /2 of 3 models active · manage/)
    assert.ok(!t.includes('runs on'), 'the model list is closed until it is asked for')
    page.UI.set.models = true
    const open = text(screen('routing'))
    assert.match(open, /2 of 3 models active · close/)
    assert.match(open, /gpt gpt-5\.6-sol runs on openai · codex/, 'the CLI name rides beside the routing label')
  })

  test('a default may only be pointed at a model that is ON', () => {
    const html = screen('routing')
    const options = [...html.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1])
    assert.ok(!options.includes('fable'), 'a model that is switched off is not on offer')
    assert.ok(options.includes('opus') && options.includes('gpt'))
  })

  test('a default already naming a switched-off model is shown, and called what it is', () => {
    page.draft.routing.defaults.push({ type: 'map', model: 'fable' })
    page.settings.routing.defaults.push({ type: 'map', model: 'fable' })
    const t = text(screen('routing'))
    assert.match(t, /Switched off\. The service refuses this config\./)
  })

  // ---- projects ------------------------------------------------------------

  test('the watch list draws with its mode, and the last repo cannot be removed', () => {
    const t = text(screen('projects'))
    assert.match(t, /alp82\/curia auto/)
    assert.match(t, /alp82\/aistack map/)
    assert.match(t, /GitHub connected as alp82/)
    page.draft.watch = [{ repo: 'alp82/curia', mode: 'auto' }]
    assert.match(screen('projects'), /<button class="btn sm" disabled/)
  })

  test('the picker offers only repos that are not watched yet', () => {
    const html = screen('projects')
    assert.match(html, /<option>alp82\/annapod<\/option>/)
    assert.ok(!/<option>alp82\/curia<\/option>/.test(html), 'a repo already watched is not on offer')
  })

  // Null is not empty, the rule that runs through every screen (#264).
  test('a repo list curia could not read says so, and is not an account with no repos', () => {
    page.repos = { login: null, repos: null, error: 'gh api failed: HTTP 502' }
    const t = text(screen('projects'))
    assert.match(t, /could not read your repos/)
    assert.match(t, /HTTP 502/)
    assert.match(t, /Type a repo below instead/)
  })

  // ---- dispatch ------------------------------------------------------------

  test('dispatch carries the switch and each editable number', () => {
    const t = text(screen('dispatch'))
    assert.match(t, /auto_dispatch/)
    assert.match(t, /max_concurrent/)
    assert.match(t, /poll_interval_s/)
    assert.match(t, /prototype_variations/)
    assert.match(t, /messages_per_send/)
    assert.match(t, /live_pane_cap/)
    assert.ok(!t.includes('workspace_root'), 'a path on the service\'s filesystem is not a thing this screen writes')
  })

  // The #525 decision: a row says its key and nothing else until the `?` is
  // asked. What a phone shows first is four short rows, not four paragraphs.
  test('an explanation waits behind its own `?` and arrives when it is asked for', () => {
    const shut = text(screen('dispatch'))
    assert.ok(!shut.includes('Each one costs a container'), 'the words are not on the screen yet')
    page.toggleHint('set-max_concurrent')
    assert.match(text(screen('dispatch')), /How many agents may run at once\. Each one costs a container/)
    assert.ok(!text(screen('dispatch')).includes('How often curia reads the frontier'),
      'one `?` opens one explanation, not the section')
  })

  // ---- the patch -----------------------------------------------------------

  test('the patch is the difference, so a field nobody touched is not written', () => {
    assert.deepEqual(plain(page.settingsPatch()), {})
    page.setDispatchField('max_concurrent', '4')
    page.setDefault(1, 'opus')
    page.setModelActive(0, true)
    assert.deepEqual(plain(page.settingsPatch()), {
      dispatch: { max_concurrent: 4 },
      routing: { defaults: { research: 'opus' }, models: { fable: { active: true } } },
    })
    assert.equal(page.changeCount(), 3)
  })

  test('a ticket-type edit preserves its model and reasoning effort together', () => {
    page.settings.routing.defaults[1].effort = 'high'
    page.draft = JSON.parse(JSON.stringify(page.settings))

    const html = screen('routing')
    assert.match(html, /research[\s\S]*?<option selected>gpt<\/option>[\s\S]*?<option selected>high<\/option>/)
    page.setDefault(1, 'opus')
    assert.deepEqual(plain(page.settingsPatch().routing.defaults), {
      research: { model: 'opus', effort: 'high' },
    })

    page.setDefaultEffort(1, 'medium')
    assert.deepEqual(plain(page.settingsPatch().routing.defaults), {
      research: { model: 'opus', effort: 'medium' },
    })
  })

  test('a number field posts a number, never the string the input holds', () => {
    page.setDispatchField('prototype_variations', '7')
    assert.strictEqual(page.settingsPatch().dispatch.prototype_variations, 7)
  })

  test('conversation limits join the save dock patch as numbers', () => {
    page.setDispatchField('messages_per_send', '3')
    page.setOverseerField('live_pane_cap', '5')
    assert.deepEqual(plain(page.settingsPatch()), {
      dispatch: { messages_per_send: 3 }, overseer: { live_pane_cap: 5 },
    })
    assert.equal(page.changeCount(), 2)
    assert.match(text(screen('dispatch')), /2 unsaved changes.*Save/)
  })

  test('the watch list posts whole, because its order is part of it', () => {
    page.removeRepo(1)
    assert.deepEqual(plain(page.settingsPatch().watch), [{ repo: 'alp82/curia', mode: 'auto' }])
    assert.equal(page.changeCount(), 1, 'the list is one change, not one per repo')
  })

  test('a repo already watched is not added twice', () => {
    page.addRepo('alp82/curia')
    assert.deepEqual(plain(page.settingsPatch()), {})
  })

  // ---- the banner: one act, three outcomes (#362) ---------------------------

  test('a clean screen carries no save chrome at all', () => {
    assert.ok(!screen().includes('class="dock'), 'nothing has been edited, so there is nothing to save')
  })

  test('the dock rises on the first edit, and the discard puts the draft back', () => {
    assert.ok(!screen().includes('class="dock'))
    page.setDispatchField('max_concurrent', '4')
    assert.match(screen(), /<div class="dock">/)
    assert.match(text(screen()), /1 unsaved change/)
    page.discardEdits()
    assert.equal(page.draft.dispatch.max_concurrent, page.settings.dispatch.max_concurrent)
    assert.ok(!screen().includes('class="dock'), 'the discard leaves a clean screen, not an empty dock')
  })

  // The restart is named BEFORE the press, not learned from the outcome. Every
  // row shipped today is inside the reload's live set, so the sentence the
  // operator reads is that nothing here needs one.
  test('the dock names what a save cannot apply without a restart', () => {
    page.setDispatchField('max_concurrent', '4')
    assert.deepEqual(plain(page.restartNeeds()), [])
    assert.match(text(screen()), /every change here lands at once, with no restart/)
    page.DRILL_PAGES.settings.push({
      key: 'later', title: 'Later', gist: () => '', body: () => '',
      patch: (out) => { out.later = { on: true } },
      count: () => 1,
      restarts: (patch) => (patch.later ? ['later.on'] : []),
    })
    try {
      assert.deepEqual(plain(page.restartNeeds()), ['later.on'])
      assert.match(text(screen()), /a restart applies later\.on — every other change lands at once/)
      assert.match(text(screen()), /2 unsaved changes/, 'the new section counts in the operator\'s own units')
    } finally {
      page.DRILL_PAGES.settings.pop()
    }
  })

  test('before a save: unsaved changes count, save is the primary button, and no restart is offered', () => {
    page.setDispatchField('max_concurrent', '4')
    const html = screen()
    assert.match(text(html), /1 unsaved change/)
    assert.match(html, /class="btn primary" {2}onclick="doSave\(\)"/)
    assert.ok(!html.includes('restart-hot'), 'nothing is applied yet, so nothing is loud')
    assert.ok(!html.includes('doRestart()'), 'the bar is just Save — the restart lives in Maintenance now')
  })

  test('Save projects immediately under a settings-path conflict and leaves unrelated Actions available', async () => {
    let answer
    const response = new Promise((resolve) => { answer = resolve })
    page = loadPage({ fetchImpl: () => response })
    page.settings = SETTINGS()
    page.draft = JSON.parse(JSON.stringify(page.settings))
    page.setDispatchField('max_concurrent', '4')

    const saving = page.doSave()
    const action = page.actionFor({ conflict_key: 'settings:config.yaml' })
    assert.equal(action.status, 'pending')
    assert.match(text(screen('dispatch')), /Saving settings/)
    assert.ok(page.beginAction({
      action_id: 'app-unrelated-action-1', kind: 'chat-message', target: 'console-1', conflict_key: 'turn:console-1',
    }), 'a settings file reservation does not take the global Action lock')

    answer({
      ok: true,
      json: async () => ({
        written: ['config.yaml'],
        settings: { ...SETTINGS(), dispatch: { ...SETTINGS().dispatch, max_concurrent: 4 } },
        reload: { ok: true, applied: ['dispatch.max_concurrent'] },
        action: {
          ...action, status: 'confirmed', revision: 2,
          receipt: { written: ['config.yaml'], applied: ['dispatch.max_concurrent'] },
        },
      }),
    })
    await saving
    assert.equal(page.actionFor({ action_id: action.action_id }), null)
    assert.match(text(screen('dispatch')), /The service is running it/)
  })

  test('a refresh recovers settings write progress and reconciles the service apply receipt', () => {
    const shared = {
      action_id: 'app-settings-recovered-1', kind: 'settings-save', target: 'config.yaml',
      conflict_key: 'settings:config.yaml', status: 'progress', revision: 10,
      progress: 'Applying settings',
    }
    page.observeActions([shared])
    assert.match(text(screen('dispatch')), /Applying settings/)

    page.observeActions([{
      ...shared, status: 'confirmed', revision: 11,
      receipt: {
        written: ['config.yaml'], applied: [],
        reload: { ok: false, reason: 'restart-needed', error: 'curia.yaml `sandbox.image` needs a restart' },
      },
    }])
    page.reconcileSettingsActions()
    assert.equal(page.actionFor({ action_id: shared.action_id }), null)
    assert.match(text(screen('dispatch')), /The service did not apply it.*sandbox\.image/)
  })

  test('applied: one sentence, and no button — the service took it', () => {
    page.UI.set.phase = 'applied'
    page.UI.set.note = 'Wrote config.yaml, atomically, with the comments kept.'
    const html = screen()
    assert.match(text(html), /saved ✓/)
    assert.match(text(html), /The service is running it\./)
    assert.ok(!html.includes('doRestart()'), 'an applied save needs no button at all')
  })

  test('declined: the key that differs is named, and the restart is the mitigation', () => {
    page.UI.set.phase = 'declined'
    page.UI.set.note = 'Wrote config.yaml, atomically, with the comments kept.'
    page.UI.set.error = 'curia.yaml `dispatch.workspace_root` changed, and that key is not one a reload applies — restart the service to take it'
    const html = screen()
    assert.match(html, /restart-hot/, 'the restart is the loud one here, because it is what applies the file')
    assert.match(text(html), /The service did not apply it\./)
    assert.match(text(html), /dispatch\.workspace_root/)
  })

  test('the service is down: the file is saved, no button, and the next boot is what takes it', () => {
    page.UI.set.phase = 'offline'
    page.UI.set.error = 'the service did not answer /reload within 4s'
    const html = screen()
    assert.ok(!html.includes('doRestart()'), 'a restart is not the mitigation for a service that is already not answering')
    assert.match(text(html), /takes this file at its next boot/)
    assert.match(text(html), /the service log names the key/)
  })

  test('a refused save keeps the draft on screen and says nothing was written', () => {
    page.setDispatchField('max_concurrent', '500')
    page.UI.set.phase = 'refused'
    page.UI.set.error = 'bad config curia.yaml: sandbox ports 9000-9299 hold 300 ports'
    const t = text(screen())
    assert.match(t, /Refused — nothing was written\./)
    assert.match(t, /sandbox ports 9000-9299/)
    assert.equal(page.draft.dispatch.max_concurrent, 500, 'the operator fixes what they typed, they do not type it again')
  })

  test('a restart ordered says what the exit means, and the page keeps serving', () => {
    page.UI.set.phase = 'restarting'
    assert.match(text(screen()), /exited nonzero and the supervisor respawns it/)
  })

  test('settings that could not be read is its own phase, not an empty form', () => {
    page.settings = null
    page.draft = null
    page.UI.set.phase = 'unread'
    page.UI.set.error = 'the sidecar answered 500'
    const t = text(page.screenSettings(payload()))
    assert.match(t, /The settings could not be read\./)
    assert.match(t, /the sidecar answered 500/)
  })

  // ---- connections ---------------------------------------------------------

  test('Connections creates the GitHub App and names each owner installation', () => {
    const p = payload()
    p.overview.github_app = {
      configured: false,
      status: 'idle',
      app: null,
      installations: { state: 'unread', at: null, error: null },
      manual_url: 'https://github.com/settings/apps/new',
      owners: [
        { owner: 'alp82', installed: null, install_url: 'https://github.com/settings/installations' },
      ],
    }
    page.UI.drill.settings = { open: 'connections', list: false }
    const html = page.screenSettings(p)
    const t = text(html)
    assert.match(t, /No GitHub App is configured\. Create one from the Curia app\./)
    assert.match(html, /href="https:\/\/github\.com\/settings\/apps\/new"/, 'the manual setup link is reachable')
    assert.match(html, /doGitHubAppSetup\(\)/)
    assert.doesNotMatch(html, /doGitHubAppRefresh\(\)/, 'nothing to re-read before an app exists')
    assert.match(fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8'), /manifest\.name = "manifest"/)
  })

  test('GitHub App setup starts immediately and does not reserve installation reads', () => {
    const sent = []
    const local = loadPage({
      fetchImpl: async (path, request) => {
        sent.push({ path, body: JSON.parse(request.body) })
        return new Promise(() => {})
      },
    })
    local.payload = payload()
    local.document.getElementById = (id) => id === 'github-app-name' ? { value: 'curia-box' } : null

    vm.runInContext('doGitHubAppSetup()', local)
    vm.runInContext('doGitHubAppRefresh()', local)

    const setup = local.actionFor({ conflict_key: 'github-app:setup' })
    const refresh = local.actionFor({ conflict_key: 'github-app:installations' })
    assert.equal(setup.status, 'pending')
    assert.equal(setup.kind, 'github-app-setup')
    assert.equal(refresh.status, 'pending')
    assert.equal(refresh.kind, 'github-app-installations')
    assert.equal(sent[0].body.action_id, setup.action_id)
    assert.equal(sent[1].body.action_id, refresh.action_id)
  })

  test('an installation read recovers from shared progress and reconciles an explicit failure', () => {
    const local = loadPage()
    local.settings = SETTINGS()
    local.draft = JSON.parse(JSON.stringify(local.settings))
    local.UI.drill.settings = { open: 'connections', list: false }
    const p = payload()
    p.overview.github_app = {
      configured: true, status: 'complete', app: { id: '42', key_file: '/keys/app.pem' },
      installations: { state: 'unread', at: null, error: null }, owners: [], manual_url: null,
    }
    local.observeActions([{
      action_id: 'app-github-app-read', kind: 'github-app-installations', target: 'github-app-installations',
      conflict_key: 'github-app:installations', status: 'progress', revision: 4,
      progress: 'Reading GitHub App installations',
    }])

    let html = local.screenSettings(p)
    assert.match(text(html), /Reading GitHub App installations/)
    assert.match(html, /Re-read installations<\/button>/)
    assert.match(html, /button class="btn" disabled/)

    local.observeActions([{
      action_id: 'app-github-app-read', kind: 'github-app-installations', target: 'github-app-installations',
      conflict_key: 'github-app:installations', status: 'failed', revision: 5,
      reason: 'The installation read failed: GitHub answered 502',
    }])
    local.reconcileGitHubAppActions()

    assert.equal(local.actionFor({ action_id: 'app-github-app-read' }), null)
    html = local.screenSettings(p)
    assert.match(text(html), /The installation read failed: GitHub answered 502/)
    assert.doesNotMatch(html, /button class="btn" disabled/)
  })

  // #762: the configured section states the app, the reading, and three owner
  // states, and the third is never drawn as the second.
  test('Connections states the app identity, the reading, and each owner in three states', () => {
    const p = payload()
    p.overview.github_app = {
      configured: true,
      status: 'complete',
      app: {
        id: '4610603', slug: 'curia-sh', name: 'Curia', bot_login: 'curia-sh[bot]',
        key_file: '/srv/curia/daemon/github-app.pem', settings_url: 'https://github.com/apps/curia-sh',
      },
      installations: { state: 'read', at: p.overview.at, error: null },
      manual_url: 'https://github.com/settings/apps/new',
      owners: [
        { owner: 'alp82', installed: true, installation_id: 111, install_url: 'https://github.com/apps/curia-sh/installations/new/permissions?target_id=9' },
        { owner: 'getalfredo', installed: false, installation_id: null, install_url: 'https://github.com/apps/curia-sh/installations/new' },
      ],
    }
    page.UI.drill.settings = { open: 'connections', list: false }
    let html = page.screenSettings(p)
    let t = text(html)
    assert.match(t, /App id 4610603/)
    assert.match(t, /Slug curia-sh/)
    assert.match(t, /Bot login curia-sh\[bot\]/)
    assert.match(t, /Key file \/srv\/curia\/daemon\/github-app\.pem/)
    assert.match(html, /href="https:\/\/github\.com\/apps\/curia-sh"/)
    assert.match(t, /Installations read/)
    assert.match(t, /alp82 installed Manage installation/)
    assert.match(t, /getalfredo missing access Install on this owner/)
    assert.match(html, /href="https:\/\/github\.com\/apps\/curia-sh\/installations\/new"/)
    assert.match(html, /doGitHubAppRefresh\(\)/)
    assert.match(text(page.screenSettings(p)), /1 owner missing access/)

    p.overview.github_app.installations = { state: 'failed', at: p.overview.at, error: 'GitHub answered 502' }
    p.overview.github_app.owners.forEach((owner) => { owner.installed = null })
    html = page.screenSettings(p)
    t = text(html)
    assert.match(t, /The installation read failed .*GitHub answered 502/)
    assert.match(t, /alp82 unknown \(read failed\)/)
    assert.doesNotMatch(t, /missing access/, 'a failed read is not an absent owner')

    p.overview.github_app.installations = { state: 'unread', at: null, error: null }
    p.overview.github_app.app.slug = null
    p.overview.github_app.app.bot_login = null
    t = text(page.screenSettings(p))
    assert.match(t, /Installations have not been read yet/)
    assert.match(t, /getalfredo unknown \(not read yet\)/)
    assert.match(t, /Slug not read yet/)
    page.UI.drill.settings = { open: null, list: true }
    assert.match(text(page.screenSettings(p)), /installations unread/)
  })

  // ---- aistack (#706) ------------------------------------------------------
  //
  // The section that guides a headless registration. What is pinned here is
  // what it SAYS at each end of that flow, plus the one thing it must never
  // say: anything out of the credential file.

  const AISTACK = () => ({
    ok: true,
    registered: false,
    machine: null,
    flow: { phase: 'unregistered' },
    log_file: '/w/home/.config/aistack/sync.log',
    commands: {
      login: 'HOME=/w/home npx -y @use-aistack/cli@0.7.2 login',
      opt_in: 'HOME=/w/home npx -y @use-aistack/cli@0.7.2 sync --auto on',
    },
    sync: { last: null, alarm: null, interval_hours: 1, cli_version: '0.7.2' },
  })

  test('an unregistered box says curia publishes nothing, and offers the one press', () => {
    page.aistack = AISTACK()
    const html = screen('aistack')
    const t = text(html)
    assert.match(t, /aistack not registered/, 'the list row says it too')
    assert.match(t, /This box is not an aistack machine/)
    assert.match(html, /aistackDo\('register'\)/)
    assert.ok(!html.includes("aistackDo('optin')"), 'there is nothing to grant a permission on yet')
  })

  test('Register this box projects immediately under the machine-registration conflict', async () => {
    let release
    let sent
    const page = loadPage({ fetchImpl: (url, options) => {
      sent = { url, body: JSON.parse(options.body) }
      return new Promise((resolve) => { release = resolve })
    } })
    page.aistack = AISTACK()

    const press = page.aistackDo('register')
    const action = page.actionFor({ conflict_key: 'aistack:machine-registration' })

    assert.equal(action.kind, 'aistack-register')
    assert.equal(action.status, 'pending')
    assert.match(text(page.setAistack()), /Starting the device login/)
    assert.equal(sent.url, '/api/aistack/register')
    assert.equal(sent.body.action_id, action.action_id)

    release({ ok: true, json: async () => ({ action: {
      ...action, status: 'accepted', revision: 1, started_at: 1, updated_at: 1,
    } }) })
    await press
    page.finishAction(action.action_id)
    page.aistackWatch()
  })

  test('Stop waiting replaces the pending registration with its own immediate projection', async () => {
    let release
    const page = loadPage({ fetchImpl: () => new Promise((resolve) => { release = resolve }) })
    page.aistack = {
      ...AISTACK(),
      flow: { phase: 'waiting', code: 'T72NNC', url: 'https://aistack.to/cli/auth?code=T72NNC' },
    }
    page.beginAction({
      action_id: 'app-register-in-flight', kind: 'aistack-register', target: 'aistack-machine',
      conflict_key: 'aistack:machine-registration', projection: { phase: 'waiting' },
    })

    const press = page.aistackDo('cancel')
    const action = page.actionFor({ conflict_key: 'aistack:machine-registration' })

    assert.equal(action.kind, 'aistack-cancel')
    assert.match(text(page.setAistack()), /Stopping the device login/)
    release({ ok: true, json: async () => ({ action: {
      ...action, status: 'accepted', revision: 2, started_at: 1, updated_at: 2,
    } }) })
    await press
    page.finishAction(action.action_id)
    page.aistackWatch()
  })

  test('Opt in projects immediately and a fresh page recovers its shared progress', async () => {
    const registered = {
      ...AISTACK(), registered: true,
      machine: { proposed: 'curia.sh', servers: ['aistack.to'], at: 1 },
      flow: { phase: 'registered' },
    }
    const shared = {
      action_id: 'app-aistack-optin', kind: 'aistack-optin', target: 'aistack-machine',
      conflict_key: 'aistack:machine-registration', status: 'progress', revision: 4,
      progress: 'Granting the standing permission', started_at: 1, updated_at: 2,
    }
    const page = loadPage({ fetchImpl: async () => ({ ok: true, json: async () => ({ ...registered, actions: [shared] }) }) })

    await page.loadAistack()

    assert.equal(page.actionFor({ conflict_key: 'aistack:machine-registration' }).action_id, shared.action_id)
    assert.match(text(page.setAistack()), /Granting the standing permission/)
    page.finishAction(shared.action_id)
    page.aistackWatch()
  })

  test('a login in flight is the code and the link, and nothing else to do', () => {
    page.aistack = { ...AISTACK(), flow: { phase: 'waiting', code: 'T72NNC', url: 'https://aistack.to/cli/auth?code=T72NNC', started_at: 1, expires_at: 2 } }
    const html = screen('aistack')
    const t = text(html)
    assert.match(t, /aistack waiting for approval/)
    assert.match(t, /T72NNC/)
    assert.match(html, /href="https:\/\/aistack\.to\/cli\/auth\?code=T72NNC"/)
    assert.match(html, /aistackDo\('cancel'\)/)
    assert.ok(!html.includes("aistackDo('register')"), 'a second login would invalidate the code on screen')
  })

  test('the approval is said to be somewhere else, because it is', () => {
    page.aistack = { ...AISTACK(), flow: { phase: 'waiting', code: 'AAAA', url: 'https://aistack.to/cli/auth?code=AAAA' } }
    page.UI.hints['set-aistack-wait'] = true
    assert.match(text(screen('aistack')), /needs a browser signed in to aistack, and the box has none/)
  })

  test('a registered box names the machine, the stack, and the last sync', () => {
    page.aistack = {
      ...AISTACK(),
      registered: true,
      machine: { proposed: 'curia.sh', servers: ['aistack.to'], at: Date.now() - 3600_000 },
      flow: { phase: 'registered' },
      sync: { last: { ok: true, at: Date.now() - 120_000, published: 'https://aistack.to/stacks/alp', message: null }, alarm: null, interval_hours: 1, cli_version: '0.7.2' },
    }
    const html = screen('aistack')
    const t = text(html)
    assert.match(t, /curia\.sh/)
    assert.match(t, /aistack\.to/)
    assert.match(t, /published 2m ago/)
    assert.match(html, /href="https:\/\/aistack\.to\/stacks\/alp"/, 'the stack the run published to')
    assert.match(html, /aistackDo\('optin'\)/, 'the second half of the ceremony is a press too')
  })

  test('a registered box that has never synced does not read as a success', () => {
    page.aistack = { ...AISTACK(), registered: true, machine: { proposed: 'curia.sh', servers: ['aistack.to'], at: null }, flow: { phase: 'registered' } }
    assert.match(text(screen('aistack')), /no sync has run yet/)
  })

  test('a failing sync names the reason, the log, and both ways out', () => {
    page.aistack = {
      ...AISTACK(),
      registered: true,
      machine: { proposed: 'curia.sh', servers: ['aistack.to'], at: null },
      flow: { phase: 'registered' },
      sync: { last: { ok: false, at: Date.now() - 60_000, published: null, message: 'npx exited 7' }, alarm: { message: 'npx exited 7: not authenticated', at: Date.now() - 60_000 }, interval_hours: 1, cli_version: '0.7.2' },
    }
    const t = text(screen('aistack'))
    assert.match(t, /The sync is failing: npx exited 7: not authenticated/)
    assert.match(t, /sync\.log/)
    assert.match(t, /If the machine is gone from aistack\.to\/settings\/machines/)
    assert.match(t, /grant the standing permission below/)
  })

  test('an expired login says nobody approved it, and the act is a new one', () => {
    page.aistack = { ...AISTACK(), flow: { phase: 'expired', message: 'nobody approved the login within three minutes, so the CLI stopped waiting' } }
    const html = screen('aistack')
    assert.match(text(html), /The last registration expired: nobody approved the login within three minutes/)
    assert.match(html, /aistackDo\('register'\)/)
  })

  test('a failed login points at the log on the box', () => {
    page.aistack = { ...AISTACK(), flow: { phase: 'failed', message: 'npx exited 1: ENOTFOUND registry.npmjs.org' } }
    const t = text(screen('aistack'))
    assert.match(t, /The last registration failed: npx exited 1: ENOTFOUND/)
    assert.match(t, /sync\.log/)
  })

  // A service that is not answering is where this section's whole answer lives,
  // so it says that rather than "not registered", which is a different fact.
  test('a service that cannot be asked is unknown, never unregistered', () => {
    page.aistack = { ok: false, error: 'the service did not answer /aistack within 10s' }
    const t = text(screen('aistack'))
    assert.match(t, /curia cannot say whether this box is registered/)
    assert.ok(!t.includes('not an aistack machine'))
  })

  test('the section takes its own read on arrival, not on the poll', () => {
    const reads = []
    page.fetch = (url) => { reads.push(url); return new Promise(() => {}) }
    page.openSection('settings', 'aistack')
    assert.deepEqual(reads, ['/api/aistack'])
  })

  // The whole point of keeping the flow daemon-side. The section draws what the
  // daemon hands it, and the service hands it no secret — so a status that
  // somehow carried one still has no line here that would draw it.
  test('nothing the section draws comes out of the credential file', () => {
    page.aistack = {
      ...AISTACK(),
      registered: true,
      machine: { proposed: 'curia.sh', servers: ['aistack.to'], at: null },
      flow: { phase: 'registered' },
      token: 'x'.repeat(64),
      credentials: { servers: { 'https://aistack.to': { token: 'y'.repeat(64), userId: 'u1' } } },
    }
    const html = screen('aistack')
    assert.ok(!html.includes('x'.repeat(64)) && !html.includes('y'.repeat(64)), 'no field of the answer is drawn wholesale')
    assert.ok(!html.includes('u1'))
  })

  // ---- maintenance, and the marker on the nav (#362) ------------------------

  test('maintenance reads last, and says the service runs the files when it does', () => {
    const html = screen('maintenance')
    assert.match(text(html), /The service is running these files\./)
    assert.ok(!html.includes('restart-hot'), 'an ordinary restart button, because nothing disagrees')
    assert.match(html, /doRestart\(\)/, 'the one restart button lives here now')
    assert.deepEqual(rows(html), ['routing', 'projects', 'dispatch', 'connections', 'aistack', 'update', 'maintenance'], 'the seventh section, and it reads last')
  })

  test('a service running something else names the keys, and the button goes red', () => {
    page.settings.dispatch.max_concurrent = 9
    page.settings.routing.models[0].active = true
    page.draft = JSON.parse(JSON.stringify(page.settings))
    const html = screen('maintenance')
    assert.match(html, /restart-hot/)
    assert.match(text(html), /The service is NOT running the files/)
    assert.match(text(html), /dispatch\.max_concurrent, routing\.models\.fable\.active/)
  })

  // Null is not agreement. A service that is not answering says what WAS true.
  test('a service that is not answering is unknown, never in step', () => {
    const p = { ...payload(), daemon_up: false }
    assert.equal(page.runningDiff(p), null)
    page.UI.drill.settings = { open: 'maintenance', list: false }
    assert.match(text(page.screenSettings(p)), /cannot tell whether the service runs these files: it is not answering/)
  })

  test('restart projects immediately under the service lifecycle conflict', async () => {
    let release
    let sent
    page = loadPage({
      fetchImpl: async (url, options) => new Promise((resolve) => {
        sent = { url, body: JSON.parse(options.body) }
        release = resolve
      }),
    })
    page.settings = SETTINGS()
    page.draft = JSON.parse(JSON.stringify(page.settings))
    page.payload = payload()

    const pressed = page.doRestart()

    const action = page.actionFor({ conflict_key: 'daemon:lifecycle' })
    assert.equal(action.status, 'pending')
    assert.equal(action.projection.uptime_s, 7200)
    assert.match(text(screen('maintenance')), /Restarting service/)
    assert.deepEqual(sent, { url: '/api/restart', body: { action_id: action.action_id } })

    release({
      ok: true,
      json: async () => ({
        ok: true,
        action: { ...action, status: 'accepted', revision: 15, receipt: { uptime_s: 7200 } },
      }),
    })
    await pressed
    assert.equal(page.actionFor({ conflict_key: 'daemon:lifecycle' }).status, 'accepted')
  })

  test('restart keeps its destructive confirmation in front of the Action', async () => {
    let requests = 0
    page = loadPage({
      fetchImpl: async () => { requests += 1 },
      confirmImpl: () => false,
    })
    page.payload = payload()

    await page.doRestart()

    assert.equal(requests, 0)
    assert.equal(page.actionFor({ conflict_key: 'daemon:lifecycle' }), null)
  })

  test('restart recovers after refresh and settles from daemon health and fresh uptime', () => {
    const shared = {
      action_id: 'app-daemon-recovery', kind: 'daemon-restart', target: 'daemon', conflict_key: 'daemon:lifecycle',
      status: 'progress', progress: 'Restarting service', revision: 20,
      receipt: { uptime_s: 7200, requested_at: at(5), exit_code: 75 },
    }
    let reading = payload({ actions: [shared] })
    reading.daemon_up = false
    page.observeActions(reading.overview.actions)
    page.reconcileDaemonRestartActions(reading)

    assert.equal(page.actionFor({ conflict_key: 'daemon:lifecycle' }).status, 'progress')
    assert.match(text(screen('maintenance')), /Restarting service/)

    reading = payload({
      actions: [{
        ...shared, status: 'confirmed', revision: 25,
        receipt: { ...shared.receipt, booted_at: at(1) },
      }],
      daemon: { ...OVERVIEW().daemon, uptime_s: 3 },
    })
    page.observeActions(reading.overview.actions)
    page.reconcileDaemonRestartActions(reading)

    assert.equal(page.actionFor({ conflict_key: 'daemon:lifecycle' }), null)
    assert.match(text(screen('maintenance')), /The service restarted and is answering/)
  })

  test('a lost restart receipt remains ambiguous until health evidence arrives', async () => {
    page = loadPage({ fetchImpl: async () => { throw new Error('socket hang up') } })
    page.settings = SETTINGS()
    page.draft = JSON.parse(JSON.stringify(page.settings))
    page.payload = payload()

    await page.doRestart()

    assert.equal(page.actionFor({ conflict_key: 'daemon:lifecycle' }).status, 'pending')
    const t = text(screen('maintenance'))
    assert.match(t, /may have taken the restart order/)
    assert.match(t, /bar above says whether the service is answering/)
    assert.doesNotMatch(t, /Refused — nothing was written/)
  })

  test('the settings nav item carries a marker while the service and the files disagree', () => {
    // `render` needs a mount point; everything else about the shell is inert.
    let html = ''
    page.document.getElementById = (id) => (id === 'app' ? { set innerHTML(v) { html = v } } : null)
    page.payload = payload()
    page.render()
    assert.ok(!/Settings <span class="n">/.test(html), 'nothing to say while the service runs the files')
    page.settings.dispatch.poll_interval_s = 5
    page.render()
    assert.match(html, /<span class="nav-label">Settings<\/span><span class="nav-marker">stale<\/span>/)
  })

  test('a restart the journal recorded reads as a sentence in the feed', () => {
    const p = payload({ events: [{ ts: at(30), type: 'restart_requested', by: 'dashboard', exit_code: 75 }] })
    assert.match(text(page.screenFeed(p)), /restart ordered by dashboard — the service exits 75/)
  })

  test('the reload reads as a sentence too, and so does one the service declined', () => {
    const p = payload({
      events: [
        { ts: at(40), type: 'config_reloaded', by: 'alp@example.com', keys: ['dispatch.max_concurrent', 'watch'] },
        { ts: at(20), type: 'config_reload_declined', by: 'alp@example.com', reason: 'restart-needed', error: 'curia.yaml `sandbox.image` changed' },
      ],
    })
    const t = text(page.screenFeed(p))
    assert.match(t, /config reloaded by alp@example\.com — dispatch\.max_concurrent, watch/)
    assert.match(t, /config reload declined for alp@example\.com — curia\.yaml `sandbox\.image` changed/)
  })
})

describe('Curia app Action bookkeeping', () => {
  let page
  beforeEach(() => { page = loadPage() })

  const local = (id, conflict = `dispatch:${id}`, target = id) => ({
    action_id: id, kind: 'dispatch', target, conflict_key: conflict,
    projection: { phase: 'starting' },
  })
  const evidence = (id, revision, status = 'accepted', conflict = `dispatch:${id}`, target = id) => ({
    action_id: id, kind: 'dispatch', target, conflict_key: conflict, status, revision,
    started_at: '2026-08-28T10:00:00.000Z', updated_at: '2026-08-28T10:00:01.000Z',
  })

  test('beginAction records the pending projection in the same frame', () => {
    const started = page.beginAction(local('act-local'))

    assert.equal(started.status, 'pending')
    assert.equal(page.actionFor({ target: 'act-local' }).action_id, 'act-local')
    assert.equal(page.actionFor({ conflict_key: 'dispatch:act-local' }).projection.phase, 'starting')
  })

  test('independent conflict keys can remain pending together', () => {
    assert.ok(page.beginAction(local('act-one')))
    assert.ok(page.beginAction(local('act-two')))
    assert.equal(page.actionFor({ conflict_key: 'dispatch:act-one' }).action_id, 'act-one')
    assert.equal(page.actionFor({ conflict_key: 'dispatch:act-two' }).action_id, 'act-two')
  })

  test('a duplicate conflict is refused without replacing the first Action', () => {
    assert.ok(page.beginAction(local('act-first', 'dispatch:ticket')))
    assert.equal(page.beginAction(local('act-second', 'dispatch:ticket')), null)
    assert.equal(page.actionFor({ conflict_key: 'dispatch:ticket' }).action_id, 'act-first')
  })

  test('older daemon evidence cannot replace a newer reading', () => {
    page.beginAction(local('act-order'))
    page.observeActions([evidence('act-order', 8, 'progress')])
    page.observeActions([evidence('act-order', 7, 'accepted')])

    assert.equal(page.actionFor({ action_id: 'act-order' }).status, 'progress')
    assert.equal(page.actionFor({ action_id: 'act-order' }).revision, 8)
  })

  test('terminal evidence is immutable', () => {
    page.beginAction(local('act-terminal'))
    page.observeActions([evidence('act-terminal', 4, 'refused')])
    page.observeActions([evidence('act-terminal', 5, 'confirmed')])

    assert.equal(page.actionFor({ action_id: 'act-terminal' }).status, 'refused')
    assert.equal(page.actionFor({ action_id: 'act-terminal' }).revision, 4)
  })

  test('nonterminal evidence from another device reserves its conflict key', () => {
    page.observeActions([evidence('act-remote', 11, 'progress', 'dispatch:shared', 'alp82/curia#804')])

    assert.equal(page.actionFor({ target: 'alp82/curia#804' }).status, 'progress')
    assert.equal(page.beginAction(local('act-local', 'dispatch:shared')), null)
  })

  test('an overview refresh recovers a nonterminal Action', async () => {
    const recovered = evidence('act-refresh', 12, 'accepted', 'dispatch:refresh', 'alp82/curia#804')
    page = loadPage({ fetchImpl: async () => ({ ok: true, json: async () => payload({ actions: [recovered] }) }) })

    await page.tick()

    assert.equal(page.actionFor({ conflict_key: 'dispatch:refresh' }).action_id, 'act-refresh')
  })

  test('finishAction removes bookkeeping only after caller reconciliation', () => {
    page.beginAction(local('act-finish'))
    page.observeActions([evidence('act-finish', 3, 'confirmed')])
    assert.equal(page.actionFor({ action_id: 'act-finish' }).status, 'confirmed')

    assert.equal(page.finishAction('act-finish'), true)
    assert.equal(page.actionFor({ action_id: 'act-finish' }), null)
  })
})

// The operator verbs on the page (#266). What a human looking at the preview
// can judge is that a button is there and reads well. What they cannot judge by
// looking is the half pinned here: that the words a button SENDS are the words
// every other surface sends, that a verb appears exactly where the ticket put
// it and nowhere else, and that a refusal reads as a fact rather than as a
// broken page.
describe('the operator verbs (#266)', () => {
  let page
  before(() => { page = loadPage() })
  beforeEach(() => {
    page.UI.act = { said: null, handoff: null }
  })

  // ---- start ---------------------------------------------------------------

  describe('start, on the Maps frontier', () => {
    const takeable = (p = payload()) => {
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244, group: 'takeable' }, open: false }
      return page.screenMaps(p)
    }

    test('the button carries the routed model, so the account is named before it is spent', () => {
      const t = text(takeable())
      assert.match(t, /task · routed to claude-opus-5/)
      assert.match(t, /grilling · routed to gpt-5\.6-sol/)
      assert.match(t, /Start/)
    })

    test('it names the repo and the number, and the sidecar composes the rest', () => {
      assert.match(takeable(), /startTicket\('alp82\/curia','265'\)/)
    })

    test('a ticket an agent already holds shows the agent instead of a button that only refuses', () => {
      const p = payload()
      p.overview.agents[0].ticket = '265'
      const html = takeable(p)
      assert.match(text(html), /⧗ dispatched — curia-263/)
      assert.equal(/startTicket\('alp82\/curia','265'\)/.test(html), false)
    })

    test('an unreadable fleet is not an idle one: the button stands and says curia cannot tell', () => {
      const t = text(takeable(payload({ agents: null, fleet_error: 'tmux is wedged' })))
      assert.match(t, /Start/)
      assert.match(t, /cannot say whether this one is already running/)
    })

    test('an item carrying no routed model says so, rather than naming a model nobody chose', () => {
      const p = payload()
      delete p.overview.maps.maps[0].takeable[0].model
      assert.match(text(takeable(p)), /the routed model is not on this reading/)
    })

    test('a valid press moves the ticket to Running in the same turn and reserves only that Start', () => {
      let sent
      const local = loadPage({
        fetchImpl: async (_path, request) => {
          sent = JSON.parse(request.body)
          return new Promise(() => {})
        },
      })
      local.payload = payload()
      local.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }

      vm.runInContext("startTicket('alp82/curia', '265')", local)

      const action = local.actionFor({ target: 'alp82/curia#265' })
      assert.equal(action.status, 'pending')
      assert.equal(action.kind, 'dispatch')
      assert.equal(action.conflict_key, 'dispatch:alp82/curia#265')
      assert.equal(sent.action_id, action.action_id)
      const html = local.screenMaps(local.payload)
      const running = /<section class="map-stage in-flight[\s\S]*?(?=<section class="map-stage takeable)/.exec(html)?.[0]
      const frontier = /<section class="map-stage takeable[\s\S]*?(?=<section class="map-stage blocked)/.exec(html)?.[0]
      assert.match(text(running), /#265 The settings write starting/)
      assert.doesNotMatch(frontier, /#265/)
      assert.match(frontier, /startTicket\('alp82\/curia','266'\)/)
    })

    test('shared claim, preparation, and spawn evidence advance the Running row until the map catches up', async () => {
      let actionId
      const shared = (revision, status, extra = {}) => ({
        action_id: actionId, kind: 'dispatch', target: 'alp82/curia#265',
        conflict_key: 'dispatch:alp82/curia#265', status, revision,
        started_at: '2026-08-28T10:00:00.000Z', updated_at: '2026-08-28T10:00:01.000Z',
        ...extra,
      })
      const local = loadPage({
        fetchImpl: async (path, request) => {
          if (path !== '/api/start') return new Promise(() => {})
          actionId = JSON.parse(request.body).action_id
          return { ok: true, json: async () => ({ action: shared(10, 'accepted') }) }
        },
      })
      local.payload = payload()
      local.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }

      await vm.runInContext("startTicket('alp82/curia', '265')", local)
      assert.match(text(local.screenMaps(local.payload)), /#265 The settings write claimed · opening the thread/)

      local.observeActions([shared(11, 'progress', { progress: 'Preparing the agent workspace' })])
      assert.match(text(local.screenMaps(local.payload)), /#265 The settings write Preparing the agent workspace/)

      local.observeActions([shared(12, 'confirmed')])
      assert.match(text(local.screenMaps(local.payload)), /#265 The settings write running/)

      const caughtUp = payload()
      const map = caughtUp.overview.maps.maps[0]
      const item = map.takeable.shift()
      map.in_flight.push({ ...item, assignees: ['curia-sh[bot]'], agent: { session: 'curia-265', model: item.model } })
      map.counts.takeable -= 1
      map.counts.in_flight += 1
      local.reconcileStartActions(caughtUp.overview)
      assert.equal(local.actionFor({ action_id: actionId }), null)
      assert.match(text(local.screenMaps(caughtUp)), /#265 The settings write working/)
    })

    test('a refusal or post-claim failure returns the ticket to Frontier with the reason in context', async () => {
      for (const [status, reason] of [
        ['refused', 'the ticket is already assigned'],
        ['failed', 'the agent workspace could not be prepared'],
      ]) {
        let actionId
        const local = loadPage({
          fetchImpl: async (path, request) => {
            if (path !== '/api/start') return new Promise(() => {})
            actionId = JSON.parse(request.body).action_id
            return { ok: true, json: async () => ({ action: {
              action_id: actionId, kind: 'dispatch', target: 'alp82/curia#265',
              conflict_key: 'dispatch:alp82/curia#265', status, revision: 20, reason,
            } }) }
          },
        })
        local.payload = payload()
        local.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }

        await vm.runInContext("startTicket('alp82/curia', '265')", local)

        assert.equal(local.actionFor({ action_id: actionId }), null)
        const html = local.screenMaps(local.payload)
        assert.match(html, /startTicket\('alp82\/curia','265'\)/)
        assert.match(html, /class="said bad"/)
        assert.match(text(html), new RegExp(reason))
      }
    })

    test('a late no-response error cannot overwrite shared progress', async () => {
      let rejectStart
      const local = loadPage({
        fetchImpl: (path) => path === '/api/start'
          ? new Promise((_resolve, reject) => { rejectStart = reject })
          : new Promise(() => {}),
      })
      local.payload = payload()
      local.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244 }, open: false }
      const pending = vm.runInContext("startTicket('alp82/curia', '265')", local)
      const action = local.actionFor({ target: 'alp82/curia#265' })
      local.observeActions([{
        ...action, status: 'progress', revision: 30, progress: 'Preparing the agent workspace',
      }])

      rejectStart(new Error('the service did not answer /command within 5s'))
      await pending

      assert.equal(local.UI.act.said, null)
      assert.equal(local.actionFor({ action_id: action.action_id }).status, 'progress')
      assert.doesNotMatch(text(local.screenMaps(local.payload)), /did not answer/)
    })
  })

  // ---- answer --------------------------------------------------------------

  describe('an answer, on the one answer surface', () => {
    test('a choice offers its own options, and the button sends the option INDEX every surface shares (#712)', () => {
      const html = page.screenHome(payload())
      assert.match(html, /answerIndex\('esc-7',0\)/)
      assert.match(html, /answerIndex\('esc-7',1\)/)
      assert.match(text(html), /1 · Drop the older note/, 'an untyped card counts its options')
      assert.match(text(html), /2 · Post both with stamps/)
    })

    test('a choice projects immediately and reconciles only when the shared escalation closes', async () => {
      let answer
      const p = payload()
      const local = loadPage({ fetchImpl: async () => new Promise((resolve) => { answer = resolve }) })
      local.payload = p

      const sent = local.answerIndex('esc-7', 1)
      const action = local.actionFor({ conflict_key: 'answer:esc-7' })
      assert.ok(action)
      assert.equal(action.kind, 'escalation-answer')
      assert.equal(action.projection.answer, 'Post both with stamps')
      assert.match(text(local.screenHome(p)), /Answering: Post both with stamps…/)

      await Promise.resolve()
      answer({ ok: true, json: async () => ({
        ok: true,
        action: {
          ...action, status: 'confirmed', revision: 9,
          receipt: { by: 'alp@example.com', via: 'dashboard', at: at(1), answer: 'Post both with stamps' },
        },
      }) })
      await sent
      assert.equal(local.actionFor({ action_id: action.action_id }).status, 'confirmed', 'the stale open record keeps the projection')

      const fresh = payload()
      fresh.overview.escalations = fresh.overview.escalations.filter((record) => record.id !== 'esc-7')
      local.reconcileAnswerActions(fresh.overview)
      assert.equal(local.actionFor({ action_id: action.action_id }), null)
      assert.equal(local.UI.act.handoff, 'esc-7')
    })

    // The typed card (#712, ADR-0025): the button says the letter and the
    // handle, the body keeps the consequence, and the band picks the control.
    describe('the typed card, one payload on every surface (#712)', () => {
      const typedCard = (n, { handles = true } = {}) => {
        const p = payload()
        const options = Array.from({ length: n }, (_, i) => `Option ${i + 1}, with its whole consequence spelled out`)
        Object.assign(p.overview.escalations[0], {
          typed: true, options,
          option_handles: handles ? options.map((_, i) => `opt${i + 1}`) : null,
          files_dir: '/box/data/attachments/esc-7',
        })
        return p
      }

      test('two to four options are buttons that say the letter and the handle', () => {
        const html = page.screenHome(typedCard(3))
        assert.match(html, /answerIndex\('esc-7',2\)/)
        assert.match(text(html), /A · opt1/)
        assert.match(text(html), /C · opt3/)
        assert.doesNotMatch(html, /<select id="sel-esc-7"/)
        assert.doesNotMatch(text(html), /whole consequence spelled out/, 'the button never repeats the body')
      })

      test('five to 25 options are one select, and its Answer sends the picked index', () => {
        const html = page.screenHome(typedCard(5))
        assert.match(html, /<select id="sel-esc-7"/)
        assert.match(html, /<option value="4">E · opt5<\/option>/)
        assert.match(html, /answerSelect\('esc-7','sel-esc-7'\)/)
        assert.doesNotMatch(html, /answerIndex\('esc-7',0\)/, 'no button row beside the menu')
        assert.match(page.screenHome(typedCard(25)), /<select id="sel-esc-7"/)
      })

      test('past 25 the numbered list stays, and a reply of a marker resolves to the index', () => {
        const p = typedCard(27)
        const html = page.screenHome(p)
        assert.doesNotMatch(html, /<select id="sel-esc-7"/)
        assert.doesNotMatch(html, /answerIndex\('esc-7',0\)/)
        assert.match(text(html), /A\. opt1/)
        assert.match(text(html), /27\. opt27/, 'the 27th marker is a number, as card.mjs marks it')
        assert.match(text(html), /Reply with a letter or a number\./)
        const r = p.overview.escalations[0]
        assert.equal(page.markerIndex(r, 'b'), 1)
        assert.equal(page.markerIndex(r, '27'), 26)
        assert.equal(page.markerIndex(r, '28'), null, 'a marker no option carries is words')
        assert.equal(page.markerIndex({ ...r, typed: false }, 'B'), null, 'an untyped card has no letters')
      })

      test('a card with no handles falls back to the label, so no button is blank', () => {
        assert.match(text(page.screenHome(typedCard(2, { handles: false }))), /A · Option 1, with its whole/)
      })

      test('every card names the file path, and the reply carries files from its own input', () => {
        const html = page.screenHome(typedCard(2))
        assert.match(html, /<input type="file" id="files-esc-7" multiple/)
        assert.match(text(html), /A reply may carry files\. They land under \/box\/data\/attachments\/esc-7\/ and reach the agent as paths\./)
        const p = payload()
        assert.match(text(page.screenHome(p)), /A reply may carry files\./, 'an untyped card names it too')
      })

      test('a second answer shows the first receipt, in the words the Discord mark uses', async () => {
        const p = typedCard(2)
        let posted = null
        const local = loadPage({
          fetchImpl: async (url, init) => {
            posted = { url, body: JSON.parse(init.body) }
            return { ok: false, status: 409, json: async () => ({ error: 'that question was already answered — the first valid answer wins', refused: true, receipt: { by: 'alp', via: 'button', at: at(60), answer: 'Option 1, with its whole consequence spelled out' } }) }
          },
        })
        local.payload = p
        await local.answerIndex('esc-7', 1)
        assert.equal(posted.url, '/api/answer')
        assert.equal(posted.body.id, 'esc-7')
        assert.equal(posted.body.index, 1)
        assert.deepEqual(posted.body.files, [])
        assert.match(posted.body.action_id, /^app-/)
        const t = text(local.screenHome(p))
        assert.match(t, /✅ answered by alp via button .*: Option 1, with its whole/)
        assert.doesNotMatch(t, /already answered/, 'the receipt, not the refusal')
      })
    })

    // An option is an AGENT's own words, and it lands inside an onclick
    // handler. A quote in it would close the JS string and open code, which
    // makes it the one value on this page that could ever do that.
    test('an option carrying a quote never reaches a handler: the control sends the index, and the label is html-escaped', () => {
      const raw = "x'),alert(1),('"
      const p = payload()
      p.overview.escalations[0].options = ["it's fine", raw]
      const html = page.screenHome(p)
      assert.doesNotMatch(html, /onclick="[^"]*alert/, 'the option is inside no handler')
      assert.match(text(html), /2 · x'\),alert\(1\),\('/, 'the label still reads')
      assert.match(html, /answerIndex\('esc-7',1\)/)
    })

    test('every kind still takes words: an option list is not the only way to answer', () => {
      assert.match(page.screenHome(payload()), /answerTyped\('esc-7','ans-esc-7',escRecord\('esc-7'\)\)/)
    })

    test('an approve-reject pair sends the two literals the service classifies', () => {
      const p = payload()
      p.overview.escalations[0].kind = 'approve-reject'
      p.overview.escalations[0].options = null
      const html = page.screenHome(p)
      assert.match(html, /answerEsc\('esc-7','approve'\)/)
      assert.match(html, /answerEsc\('esc-7','reject'\)/)
    })

    test('a recommended round carries its one tap, and nothing beside it (#285)', () => {
      const p = payload()
      Object.assign(p.overview.escalations[0], { kind: 'free-text', options: null, recommended: true })
      const html = page.screenHome(p)
      assert.match(html, /answerEsc\('esc-7','all-as-recommended'\)/)
      assert.match(text(html), /All as recommended/)
      assert.equal(/answerEsc\('esc-7','reject'\)/.test(html), false, 'the opposite of that tap is your reply')
    })

    test('a free-text round with no recommendation gets the field and no tap', () => {
      const p = payload()
      Object.assign(p.overview.escalations[0], { kind: 'free-text', options: null, recommended: false })
      const html = page.screenHome(p)
      assert.equal(/all-as-recommended/.test(html), false)
      assert.match(html, /answerTyped/)
    })

    test('the Agents table states the question and answers none of it — one answer surface', () => {
      const html = page.screenAgents(payload())
      assert.equal(/answerEsc/.test(html), false)
      assert.match(text(html), /choice/, 'it still says what the agent waits on')
    })
  })

  // ---- the review gate -----------------------------------------------------

  describe('the review gate card', () => {
    test('it carries the three the gate has, and cross-check is one of them', () => {
      const html = page.screenHome(payload())
      assert.match(html, /answerEsc\('esc-9','approve'\)/)
      assert.match(html, /answerEsc\('esc-9','cross-check'\)/)
      assert.match(html, /rejectGate\('esc-9','rej-esc-9'\)/)
      assert.match(text(html), /Approve · merge/)
    })

    test('a rejection is a field, not a bare button: the agent gets your words (#48)', () => {
      assert.match(page.screenHome(payload()), /placeholder="what to change — a rejection carries your words/)
    })

    test('an empty rejection is refused on the page, and nothing is sent', () => {
      page.document.getElementById = () => ({ value: '   ' })
      page.rejectGate('esc-9', 'rej-esc-9')
      assert.equal(page.UI.act.said.ok, false)
      assert.match(page.UI.act.said.text, /A rejection carries your words/)
      page.document.getElementById = () => null
    })

    test('the pull request stays the one thing this card carries that no other does', () => {
      assert.match(text(page.screenHome(payload())), /pull\/262/)
    })
  })

  // ---- the diff digest (#355) ----------------------------------------------
  //
  // The card answers "how big is this, and what did it touch" before the
  // approve press. What is pinned here is what it SAYS: that the numbers come
  // off the stored digest rather than a read, that nothing is hidden, that the
  // rank rule is stated where the operator can read it, and that an uncounted
  // diff never renders as an unchanged one.

  describe('the diff digest on the gate card', () => {
    // What THIS card asked to read, by the key the gate addresses it under.
    const gateQueue = () => page.diffQueue.filter((j) => j.key === 'esc:esc-9').map((j) => j.i)
    beforeEach(() => {
      // The card caches its hunk reads, and each test starts from a card
      // nobody has opened.
      for (const k of Object.keys(page.diffs)) delete page.diffs[k]
      page.diffQueue.length = 0
    })

    test('the totals sit on the card, from the stored digest and no extra read', () => {
      const t = text(page.screenHome(payload()))
      assert.match(t, /4 files \+812 −233/)
    })

    test('every changed file is listed with its own numbers — nothing is hidden', () => {
      const t = text(page.screenHome(payload()))
      for (const p of ['daemon/src/dashboard.mjs', 'daemon/test/page.test.mjs', 'docs/adr/0019-x.md', 'daemon/package-lock.json']) {
        assert.ok(t.includes(p), `${p} is missing from the card`)
      }
      assert.match(t, /\+120 −4/)
      assert.match(t, /\+622 −227/)
    })

    test('the rank rule is stated on the card, so the order hides nothing', () => {
      assert.match(text(page.screenHome(payload())),
        /ranked source first, then tests, then docs, generated and lock files last — largest first inside each class/)
    })

    test('the caption says the facts in words: new, renamed, deleted, how many hunks', () => {
      const t = text(page.screenHome(payload()))
      assert.match(t, /new · 3 hunks/)
      assert.match(t, /9 hunks/)
    })

    test('the top file opens expanded and the rest open on a tap', () => {
      const html = page.screenHome(payload())
      assert.match(html, /toggleDiffFile\('esc:esc-9',0,'\/api\/diff\?esc=esc-9'\)/)
      assert.match(html, /toggleDiffFile\('esc:esc-9',3,'\/api\/diff\?esc=esc-9'\)/)
      // Only the top one asked for its hunks; the other three cost nothing.
      assert.deepEqual(plain(gateQueue()), [0])
    })

    // The hunks are fetched per file, once. A card left open on a desk must not
    // re-read four files every five seconds.
    test('a second render of the same card asks for nothing again', () => {
      page.screenHome(payload())
      page.diffQueue.length = 0
      page.screenHome(payload())
      assert.deepEqual(plain(gateQueue()), [])
    })

    test('a fetched file draws its patch, colored by the patch\'s own vocabulary', () => {
      page.screenHome(payload())
      page.diffs['esc:esc-9'].hunks[0] = {
        text: '@@ -1,2 +1,3 @@\n keep\n-gone\n+added', lines_shown: 4, lines_total: 4, truncated: false, error: null,
      }
      const html = page.screenHome(payload())
      assert.match(html, /<span class="hl at">@@ -1,2 \+1,3 @@<\/span>/)
      assert.match(html, /<span class="hl add">\+added<\/span>/)
      assert.match(html, /<span class="hl del">-gone<\/span>/)
    })

    // The second cap. A long file stops, says how much it did not show, and
    // puts the link to the whole thing beside it.
    test('a capped file says how many lines it did not show, with GitHub beside it', () => {
      page.screenHome(payload())
      page.diffs['esc:esc-9'].hunks[0] = {
        text: '+one', lines_shown: 400, lines_total: 963, truncated: true, error: null,
      }
      const html = page.screenHome(payload())
      assert.match(text(html), /the card stopped at 400 lines and did not show 563 more/)
      assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/pull\/262\/files"/)
    })

    test('a file read from the pull request says the worktree is gone', () => {
      page.screenHome(payload())
      page.diffs['esc:esc-9'].hunks[0] = {
        text: '+one', lines_shown: 1, lines_total: 1, truncated: false, error: null, source: 'pull-request',
      }
      assert.match(text(page.screenHome(payload())), /the worktree is gone — this comes from the pull request's own diff/)
    })

    // The first cap. A list that silently stopped would read as the whole
    // change, which is the one thing a merge gate must not do.
    test('a capped file list says the cap on the card', () => {
      const gate = OVERVIEW().review_gate[0]
      const t = text(page.screenHome(payload({
        review_gate: [{ ...gate, diff: { ...gate.diff, files: 412, capped: true } }],
      })))
      assert.match(t, /the list stops at 4 of 412 files/)
    })

    // NULL IS NOT EMPTY, the rule every screen on this page runs under.
    test('a digest curia could not take says so, and never reads as an unchanged branch', () => {
      const t = text(page.screenHome(payload({
        review_gate: [{ ...OVERVIEW().review_gate[0], diff: null, diff_error: 'the agent worktree is gone' }],
      })))
      assert.match(t, /curia could not count this diff — the agent worktree is gone/)
      assert.ok(!/No file changed/.test(t))
    })

    test('a branch that really changed nothing says that instead', () => {
      const t = text(page.screenHome(payload({
        review_gate: [{ ...OVERVIEW().review_gate[0], diff: { files: 0, added: 0, deleted: 0, capped: false, list: [] }, diff_error: null }],
      })))
      assert.match(t, /No file changed against the default branch/)
      assert.ok(!/could not count/.test(t))
    })
  })

  // ---- the same card, before the gate (#355) --------------------------------

  describe('the outcome of a press', () => {
    test('a command reply is curia\'s own sentence, rendered where the press was', () => {
      page.UI.act.said = { key: 'start:alp82/curia#265', text: '⚙️ `curia-265` spawned on **claude-opus-5**', ok: true }
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244, group: 'takeable' }, open: false }
      const html = page.screenMaps(payload())
      assert.match(html, /<code>curia-265<\/code>/, 'the markdown curia speaks everywhere else reads here too')
      assert.match(html, /<b>claude-opus-5<\/b>/)
    })

    test('a refusal is marked, and it is not a broken page', () => {
      page.UI.act.said = { key: 'esc:esc-7', text: 'that question was already answered — the first valid answer wins', ok: false }
      const html = page.screenHome(payload())
      assert.match(html, /class="said bad"/)
      assert.match(text(html), /first valid answer wins/)
    })

    test('what curia said lands under the control that asked, never on another one', () => {
      page.UI.act.said = { key: 'esc:esc-7', text: 'answered', ok: true }
      assert.equal(/class="said/.test(page.screenAgents(payload())), false)
    })

    test('an answer says only that it landed: the next needs are the handoff sheet\'s, not the reply text\'s (#718)', () => {
      const said = page.outcome({
        ok: true,
        next_needs: [{ headline: 'Review the map.', agent: 'curia-8', ticket: '8' }],
      })
      assert.match(said, /Answered/)
      assert.doesNotMatch(said, /Review the map/, 'the service orders next_needs by age, and Curia app ranks as Home does instead')
    })

    test('an in-flight answer leaves an independent Start control available', () => {
      page.beginAction({
        action_id: 'act-answer', kind: 'answer', target: 'esc-7', conflict_key: 'esc:esc-7',
      })
      page.UI.maps = { repo: 'all', selected: { repo: 'alp82/curia', map: 244, group: 'takeable' }, open: false }
      assert.match(page.screenMaps(payload()), /button class="btn sm primary"  onclick="startTicket/)
      page.finishAction('act-answer')
    })
  })

  // ---- the handoff sheet (#718) --------------------------------------------
  //
  // After one answer, the sheet names the next three items in HOME'S order and
  // the count that still stands. It reads `attentionItems`, the one source the
  // ring and the column read, so the two cannot disagree. It answers nothing.

  describe('the handoff sheet leads from one answered item to the next', () => {
    // Three open items besides esc-7: a gate at 5 minutes, an aged escalation
    // at 5 hours, and a young one that unblocks two tickets. Home ranks them
    // aged first, then the unblocker, then the gate, with esc-7 in between.
    const crowded = () => {
      const p = payload()
      p.overview.escalations.push(
        { id: 'esc-20', agent: 'curia-20', ticket: '20', kind: 'free-text', prompt: 'Five hours old.', options: null, preview_url: null, opened_at: at(5 * 3600), agent_died: false, rendered: true },
        { id: 'esc-21', agent: 'curia-21', ticket: '21', kind: 'choice', prompt: 'Young, but two tickets wait on it.', options: ['a', 'b'], preview_url: null, opened_at: at(60), agent_died: false, rendered: true },
        { id: 'esc-22', agent: 'curia-22', ticket: '22', kind: 'free-text', prompt: 'Young and unblocks nothing.', options: null, preview_url: null, opened_at: at(30), agent_died: false, rendered: true },
      )
      // The unblock is on the wire, not on the row (#761): two map children
      // are blocked by 21.
      p.overview.maps.maps[0].blocked.push(
        { number: 31, title: 'Waits on 21', type: 'task', blockers: [{ number: 21, title: 'Young' }] },
        { number: 32, title: 'Also waits on 21', type: 'task', blockers: [{ number: 21, title: 'Young' }] },
      )
      return p
    }
    const answered = (p, id = 'esc-7') => {
      const local = loadPage({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }) })
      local.payload = p
      return local.answerEsc(id, 'approve').then(() => local)
    }

    test('no sheet stands before an answer, and none after a refused one', async () => {
      const p = crowded()
      assert.equal(page.handoffSheet(), '')
      const local = loadPage({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'already answered', receipt: { by: 'alp', answer: 'x' } }) }) })
      local.payload = p
      await local.answerEsc('esc-7', 'approve')
      assert.equal(local.UI.act.handoff, null)
      assert.equal(local.handoffSheet(), '')
    })

    test('one successful answer opens the sheet with the open count and the next three in Home\'s order', async () => {
      const local = await answered(crowded())
      assert.equal(local.UI.act.handoff, 'esc-7')
      const html = local.handoffSheet()
      const t = text(html)
      // esc-7 is still on the stale payload; the sheet leaves it out, so the
      // count is the four others.
      assert.match(t, /Answered\. 4 items still need you\./)
      const homeOrder = local.attentionItems(local.payload.overview).map((i) => i.id).filter((id) => id !== 'esc-7')
      assert.equal(homeOrder.slice(0, 3).join(','), 'esc-20,esc-21,esc-9', 'the fixture ranks as intended')
      const rows = [...html.matchAll(/<button class="handoff-item[^"]*"[^>]*>.*?<\/button>/g)].map((m) => text(m[0]))
      assert.equal(rows.length, 3)
      assert.match(rows[0], /^1 curia-20 · free-text · #20: Five hours old\./)
      assert.match(rows[1], /^2 curia-21 · choice · #21: Young, but two tickets/)
      assert.match(rows[2], /^3 curia-261 · review gate · #261: is this done\?/)
      assert.doesNotMatch(t, /Young and unblocks nothing/, 'the fourth stays off the sheet')
      assert.doesNotMatch(t, /Two notes race/, 'the answered item is not offered back')
    })

    test('the sheet carries no answer control: each item is a landing on its own card', async () => {
      const local = await answered(crowded())
      const html = local.handoffSheet()
      assert.doesNotMatch(html, /answerEsc|answerIndex|answerTyped|answerSelect|rejectGate/)
      assert.doesNotMatch(html, /<input/)
      assert.match(html, /onclick="handoffGo\(0\)"/)
      // The card the first row lands on has the anchor the landing scrolls to.
      assert.match(local.screenHome(local.payload), /id="need-esc-20"/)
    })

    test('the sheet re-ranks off the fresh poll: an item answered elsewhere leaves, and the count drops', async () => {
      const local = await answered(crowded())
      assert.match(text(local.handoffSheet()), /4 items still need you/)
      const fresh = crowded()
      fresh.overview.escalations = fresh.overview.escalations.filter((r) => r.id !== 'esc-7' && r.id !== 'esc-20')
      local.payload = fresh
      const t = text(local.handoffSheet())
      assert.match(t, /3 items still need you/)
      assert.match(t, /1 curia-21 · choice/)
      assert.doesNotMatch(t, /Five hours old/)
    })

    test('with nothing left the sheet says so, and offers no list', async () => {
      const p = payload()
      p.overview.review_gate = []
      const local = await answered(p)
      const t = text(local.handoffSheet())
      assert.match(t, /Answered\. Nothing else wants you\./)
      assert.doesNotMatch(local.handoffSheet(), /handoff-item/)
    })

    test('a landing closes the sheet and moves to the item\'s screen; close closes it', async () => {
      const local = await answered(crowded())
      local.handoffGo(2)
      assert.equal(local.UI.act.handoff, null)
      assert.equal(local.UI.screen, 'home')
      const again = await answered(crowded())
      again.handoffClose()
      assert.equal(again.UI.act.handoff, null)
      assert.equal(again.handoffSheet(), '')
    })

    test('a dead credential ranks first on the sheet as on Home, and lands on Credentials', async () => {
      const p = crowded()
      p.overview.credentials = { consumers: [{ consumer: 'claude', provider: 'anthropic', state: 'expired' }], reauth: null }
      const local = await answered(p)
      assert.match(text(local.handoffSheet()), /1 a model credential wants you/)
      local.handoffGo(0)
      assert.equal(local.UI.screen, 'credentials')
    })
  })

  // ---- the feed ------------------------------------------------------------

  describe('every verb lands in the feed', () => {
    const feed = (e) => text(page.screenFeed(payload({ events: [{ ts: at(30), ...e }] })))

    test('a note names who sent it and what it said', () => {
      assert.match(feed({ type: 'agent_note', agent: 'curia-263', by: 'alp@example.com', text: 'look again' }),
        /note for curia-263 from alp@example.com: look again/)
    })

    test('an interrupt says the grace it gave, because that is the operator\'s own choice', () => {
      assert.match(feed({ type: 'note_interrupt', agent: 'curia-263', by: 'alp@example.com', grace_ms: 5000 }),
        /curia-263 interrupted by alp@example.com — 5s of grace/)
    })

    test('an interrupt that failed is marked bad and says why', () => {
      assert.match(feed({ type: 'note_interrupt_failed', agent: 'curia-263', reason: 'the agent exited during the grace' }),
        /the interrupt of curia-263 failed — the agent exited during the grace/)
    })

    test('a note curia refused is a fact in the feed, not a silence', () => {
      assert.match(feed({ type: 'agent_note_refused', agent: 'curia-263', reason: 'agent not running' }),
        /a note for curia-263 was refused — agent not running/)
    })

    test('an answer names the operator and the surface it came from', () => {
      assert.match(feed({ type: 'esc_answer', id: 'esc-7', by: 'alp@example.com', via: 'dashboard' }),
        /escalation esc-7 answered by alp@example.com via dashboard/)
    })

    test('a start pressed here reads exactly as one typed in Discord — one seam, one event', () => {
      assert.match(feed({ type: 'command', canonical: 'start alp82/curia#266', by: 'alp@example.com' }),
        /start alp82\/curia#266 — by alp@example.com/)
    })

    // #384. The two triggers are two events, and the feed must not read them as
    // one thing: a wall was hit, or curia stopped short of one.
    test('a hold before the limit reads apart from a cap that landed', () => {
      assert.match(feed({ type: 'provider_precooling', provider: 'anthropic', window: '5h', pct: 93, reset_at: ahead(75) }),
        /anthropic is held before the limit — the 5h window is at 93%, and it lifts \d\d:\d\d/)
      assert.match(feed({ type: 'provider_precooling_lifted', provider: 'anthropic', window: '5h', pct: 71 }),
        /anthropic is dispatching again — its fullest window reads 71%/)
      assert.match(feed({ type: 'provider_cooling', provider: 'anthropic', reset_at: ahead(75) }),
        /anthropic is cooling — it rolls \d\d:\d\d/)
    })

    // #333. The fallback would print "console conversation opened — —", which
    // is the kind of legible-looking nothing this page's own header forbids.
    test('opening and deleting a browser conversation each read as a sentence', () => {
      assert.match(feed({ type: 'console_conversation_opened', key: 'console-4' }), /console-4 opened/)
      assert.match(feed({ type: 'console_conversation_deleted', key: 'console-4' }), /console-4 deleted — its number is spent/)
    })
  })
})

// ---------------------------------------------------------------------------
// the chat (#267)
// ---------------------------------------------------------------------------
//
// The screen draws no message and frames nothing: the chat is the timeline
// page, served at /chat. So what a test can pin is what the door SAYS — who is
// behind it, where it goes, and that a service which is not answering is a chat
// that is not there, because every message reaches the overseer container
// through the service (#315).

describe('the chat screen (#267, the picker of #333)', () => {
  let page
  before(() => { page = loadPage() })
  // The screen reads `/api/console` on arrival, so every case below states what
  // that read answered. `null` is the read in flight, and it is NOT an empty
  // list — the two draw differently on purpose.
  const conv = (over) => ({
    key: 'console-2', session: 'curia-console-2', opened_at: at(600),
    last_turn_at: at(120), label: 'what is takeable on curia', ctx_pct: 31, ctx_over: false,
    kind: 'overseer', deletable: true, ...over,
  })
  beforeEach(() => { page.conversations = { conversations: [conv()] } })

  test('a row opens ITS conversation at #chat/<session>, keyed on its own session', () => {
    const html = page.screenChat(payload())
    assert.match(html, /href="#chat\/curia-console-2"/)
    const t = text(html)
    assert.match(t, /what is takeable on curia/, 'the label is the operator\'s own first message')
    assert.match(t, /console-2/)
  })

  test('the picker has a Tickets section and an Overseer section, each with its own titles', () => {
    page.conversations = { conversations: [
      conv({ kind: 'overseer', deletable: true }),
      conv({ kind: 'ticket', deletable: false, key: 'alp82/curia#684', session: 'curia-684', state: 'working', label: 'Build Curia app', repo: 'alp82/curia', ticket: 684, live: true }),
      conv({ kind: 'ticket', deletable: false, key: 'alp82/curia#240', session: 'curia-240', state: 'done', label: 'Old work', repo: 'alp82/curia', ticket: 240, live: false }),
    ] }
    const html = page.screenChat(payload())
    const t = text(html)
    // two sections, tickets first
    assert.match(t, /Tickets .* Overseer /)
    const tickets = t.slice(t.indexOf('Tickets'), t.indexOf('Overseer'))
    const overseer = t.slice(t.indexOf('Overseer'))
    // a ticket row is titled by its tracker name and issue title
    assert.match(tickets, /Build Curia app alp82\/curia#684 · working/)
    // an ended agent stays in the list and says so
    assert.match(tickets, /Old work alp82\/curia#240 · ended · done/)
    assert.match(html, /<tr class="ended">[\s\S]*?href="#chat\/curia-240"/)
    // an overseer row is titled by the operator's own first message
    assert.match(overseer, /what is takeable on curia console-2/)
    assert.doesNotMatch(tickets, /what is takeable/)
    assert.match(html, /href="#chat\/curia-684"/)
    assert.doesNotMatch(html, /doDeleteConversation\('alp82\/curia#684'\)/)
    assert.match(html, /doDeleteConversation\('console-2'\)/)
  })

  test('a row carries its own context percent — ADR-0016 makes that the one signal', () => {
    page.conversations = { conversations: [conv({ ctx_pct: 88 }), conv({ key: 'console-1', session: 'curia-console-1', ctx_pct: null, label: null })] }
    const t = text(page.screenChat(payload()))
    assert.match(t, /88%/)
    assert.match(t, /—/, 'a conversation with no turn reads as no reading, never as 0%')
    assert.match(t, /no turn yet/)
  })

  test('an over-full conversation is marked rather than drawn flat', () => {
    page.conversations = { conversations: [conv({ ctx_pct: 104, ctx_over: true })] }
    assert.match(page.screenChat(payload()), /104%.*⚠/s)
  })

  test('no conversations is an empty list, and nothing is minted by looking', () => {
    page.conversations = { conversations: [] }
    const t = text(page.screenChat(payload()))
    assert.match(t, /No agent is running or recently ended/)
    assert.match(t, /No overseer conversation yet/)
    assert.match(t, /New conversation/, 'the one button is the only way one starts')
    assert.doesNotMatch(t, /console-\d/, 'a page read spends no number')
  })

  test('a list curia could not be asked for is not an empty one', () => {
    page.conversations = { conversations: null, error: 'the service answered 500 on /console' }
    const t = text(page.screenChat(payload()))
    assert.match(t, /could not read your conversations/)
    assert.match(t, /the service answered 500/)
    assert.doesNotMatch(t, /No overseer conversation yet/)
  })

  test('the read in flight says so, and claims nothing about the list', () => {
    page.conversations = null
    const t = text(page.screenChat(payload()))
    assert.match(t, /Reading your conversations/)
    assert.doesNotMatch(t, /No overseer conversation yet/)
  })

  test('the delete says the number is spent, because that is the part nobody can undo', () => {
    assert.match(page.screenChat(payload()), /onclick="doDeleteConversation\('console-2'\)"/)
    assert.match(text(page.screenChat(payload())), /Deleting one spends its number for good/)
  })

  test('New conversation projects immediately, reserves the registry, and navigates on confirmation', async () => {
    let sent
    let answer
    const local = loadPage({ fetchImpl: async (url, request) => {
      assert.equal(url, '/api/console/new')
      sent = JSON.parse(request.body)
      return new Promise((resolve) => { answer = resolve })
    } })
    local.conversations = { conversations: [conv()] }

    const pending = local.doNewConversation()
    const action = local.actionFor({ conflict_key: 'conversation-registry' })

    assert.equal(action.kind, 'console-conversation-open')
    assert.equal(sent.action_id, action.action_id)
    assert.match(text(local.screenChat(payload())), /Opening…/)
    assert.equal(local.beginAction({
      action_id: 'another-new', kind: 'console-conversation-open',
      target: 'conversation-registry', conflict_key: 'conversation-registry',
    }), null)

    answer({ ok: true, json: async () => ({
      action: { ...action, status: 'confirmed', revision: 8, receipt: { key: 'console-3', session: 'curia-console-3' } },
      key: 'console-3', session: 'curia-console-3',
    }) })
    await pending

    assert.equal(local.location.hash, 'chat/curia-console-3')
    assert.equal(local.actionFor({ action_id: action.action_id }), null)
  })

  test('deleting one conversation leaves another delete available and keeps the row pending until confirmation', async () => {
    const requests = new Map()
    const local = loadPage({ fetchImpl: async (url, request) => {
      if (url === '/api/console/delete') {
        const body = JSON.parse(request.body)
        return new Promise((resolve) => requests.set(body.key, { body, resolve }))
      }
      if (url === '/api/console') return { ok: true, json: async () => ({ conversations: [conv({ key: 'console-3', session: 'curia-console-3' })] }) }
      throw new Error(`unexpected request ${url}`)
    } })
    local.confirm = () => true
    local.conversations = { conversations: [conv(), conv({ key: 'console-3', session: 'curia-console-3' })] }

    const first = local.doDeleteConversation('console-2')
    const second = local.doDeleteConversation('console-3')
    const action = local.actionFor({ conflict_key: 'conversation:console-2' })

    assert.ok(action)
    assert.ok(local.actionFor({ conflict_key: 'conversation:console-3' }), 'another conversation remains independent')
    assert.equal(requests.get('console-2').body.action_id, action.action_id)
    assert.match(text(local.screenChat(payload())), /console-2.*deleting/s)

    requests.get('console-2').resolve({ ok: true, json: async () => ({ action: {
      ...action, status: 'confirmed', revision: 9, receipt: { key: 'console-2' },
    } }) })
    await first

    assert.equal(local.actionFor({ action_id: action.action_id }), null)
    assert.doesNotMatch(text(local.screenChat(payload())), /console-2/)

    const other = local.actionFor({ conflict_key: 'conversation:console-3' })
    requests.get('console-3').resolve({ ok: true, json: async () => ({ action: {
      ...other, status: 'refused', revision: 10, reason: 'there is no conversation `console-3`',
    } }) })
    await second
    assert.match(text(local.screenChat(payload())), /no conversation console-3/)
  })

  test('a fresh Console read recovers conversation changes made on another device', async () => {
    const local = loadPage({ fetchImpl: async (url) => {
      assert.equal(url, '/api/console')
      return { ok: true, json: async () => ({ conversations: [
        conv({ key: 'console-4', session: 'curia-console-4', label: 'opened on the phone' }),
      ] }) }
    } })
    local.conversations = { conversations: [conv()] }

    await local.loadConversations()

    const html = local.screenChat(payload())
    assert.match(text(html), /opened on the phone/)
    assert.doesNotMatch(html, /console-2/)
    assert.equal(local.actionFor({ conflict_key: 'conversation-registry' }), null)
  })

  test('it states the one thing the overseer cannot do, rather than leaving it to be found', () => {
    // #315: the overseer holds a reading shell now, so the limit that is left
    // is the write — the read-only token, and every effect crossing the service.
    assert.match(text(page.screenChat(payload())), /it cannot write one/)
    assert.match(text(page.screenChat(payload())), /read-only/)
  })

  test('a service that is not answering is a chat that is not there, and says which', () => {
    const p = payload()
    p.daemon_up = false
    p.error = 'connect ECONNREFUSED'
    p.error_since = at(30)
    const t = text(page.screenChat(p))
    assert.match(t, /The chat is down while the service restarts/)
    assert.match(t, /service restarting/, 'and the reading marker still says why')
  })

  // The room (#711). It renders from `chat`, and the stream writes there
  // through `chatReceive` — so the test feeds the same events the timeline
  // sends and reads what the screen says.
  describe('the room', () => {
    beforeEach(() => {
      page.applyChatRoute(['chat', 'curia-684'])
      page.conversations = { conversations: [
        conv({ kind: 'ticket', deletable: false, key: 'alp82/curia#684', session: 'curia-684', state: 'working', label: 'Build Curia app', repo: 'alp82/curia', ticket: 684, live: true }),
        conv({ key: 'console-2', session: 'curia-console-2' }),
      ] }
    })
    afterEach(() => { page.applyChatRoute([]) })

    test('#chat/<session> is the room, and the tab press is the picker again', () => {
      assert.equal(page.chat.session, 'curia-684')
      const html = page.screenChat(payload())
      assert.match(text(html), /Build Curia app/)
      assert.match(text(html), /ticket · curia-684 connecting/)
      assert.match(html, /href="#chat">← Chat</)
      assert.match(html, /id="chat-box"/, 'a live agent takes words')
      page.applyChatRoute(['chat'])
      assert.equal(page.chat.session, null)
      assert.match(text(page.screenChat(payload())), /Tickets/)
    })

    test('the stream draws the active branch: hello, items, a tool result joined to its call, and a reset', () => {
      page.chatReceive('hello', { session: 'curia-684', file: '/w/cfg/curia-684/projects/x/abc.jsonl', harness: 'claude', clients: 1, draft: '' })
      page.chatReceive('items', [
        { kind: 'prompt', text: 'start on #684', at: at(300) },
        { kind: 'tool', id: 't1', name: 'mcp__curia__notify', text: 'I am reading the map.', at: at(200) },
        { kind: 'result', forId: 't1', ok: true, brief: 'noted', lines: 1 },
        { kind: 'say', text: 'The map has three children.', at: at(100) },
      ])
      const html = page.screenChat(payload())
      const t = text(html)
      assert.match(t, /live/)
      assert.match(t, /abc\.jsonl/)
      assert.match(t, /start on #684/)
      assert.match(t, /curia\.notify I am reading the map\. → noted/)
      assert.match(t, /The map has three children/)
      assert.equal(page.chat.items.length, 3, 'the result rides its tool call, not a row of its own')
      page.chatReceive('reset', { file: '/w/cfg/curia-684/projects/x/def.jsonl', branch: true })
      assert.doesNotMatch(text(page.screenChat(payload())), /three children/)
      assert.match(text(page.screenChat(payload())), /def\.jsonl/)
    })

    // The composite send (#716). The room draws every message of the sequence
    // under its rail, and the deciding one is only named, because the card
    // from the record carries it.
    test('a composite send draws its sequence under the rails, and the deciding message is the card', () => {
      page.chatReceive('items', [{
        kind: 'tool', id: 't2', name: 'mcp__curia__ask_human', brief: 'send of 3: answer · the run · decision', at: at(200),
        send: [
          { rail: '-# 1 of 3 · answer', body: '**The cap held.** Cooling ran to 14:20.', deciding: false, format: 'prose', label: 'answer' },
          { rail: '-# 2 of 3 · the run', body: '```\nboot -> cap\n```', deciding: false, format: 'visual', label: 'the run' },
          { rail: '-# 3 of 3 · decision', body: '**Keep the cap?**', deciding: true, format: 'choice', label: 'decision' },
        ],
      }])
      const html = page.screenChat(payload())
      const t = text(html)
      assert.match(t, /1 of 3 · answer \*\*The cap held\.\*\* Cooling ran to 14:20\./)
      assert.match(t, /2 of 3 · the run ``` boot -&gt; cap ```/)
      assert.match(t, /3 of 3 · decision the card follows/)
      assert.doesNotMatch(t, /Keep the cap\?/, 'the deciding body is the card, drawn from the record')
      assert.doesNotMatch(html, /-# /, 'the rail loses the Discord small-print mark')
      assert.equal((html.match(/class="send-msg/g) ?? []).length, 3)

      page.chatReceive('items', [{
        kind: 'tool', id: 't3', name: 'mcp__curia__notify', brief: 'send of 1: answer', at: at(100),
        send: [{ rail: '', body: '**One message.** No rail.', deciding: false, format: 'prose', label: 'answer' }],
      }])
      const one = page.screenChat(payload())
      assert.match(text(one), /\*\*One message\.\*\* No rail\./)
      assert.doesNotMatch(one, /class="rail"[^<]*<\/span>[^<]*One message/)
    })

    test('the service\'s escalation record interleaves with the transcript, and an open one is a banner', () => {
      page.chatReceive('items', [{ kind: 'say', text: 'first', at: at(300) }, { kind: 'say', text: 'third', at: at(100) }])
      page.chatReceive('esc_history', [{ id: 'esc-7', kind: 'question', prompt: 'Which branch?', options: ['a', 'b'], opened_at: at(200), closed_at: at(150), status: 'answered', answer: 'a', answered_by: 'alp', answered_via: 'dashboard' }])
      page.chatReceive('escalations', [{ id: 'esc-8', kind: 'question', prompt: 'Ship it?', options: null, opened_at: at(50), nudges: 0 }])
      const t = text(page.screenChat(payload()))
      assert.match(t, /first .*Which branch\?.*✅ answered by alp via dashboard.*third/s)
      assert.match(t, /waiting on you — question \(esc-8\) Ship it\?/)
    })

    // The terminal (#714). The header opens it for THIS conversation, in a
    // dock the page mounts outside #app, and only while the agent runs.
    test('the header opens the same-origin terminal for the current conversation, and hides it again', () => {
      let html = page.screenChat(payload())
      assert.match(html, /onclick="chatToggleTerminal\(\)"/)
      assert.doesNotMatch(html, /target="_blank"/, 'no separate terminal address')
      assert.equal(page.terminalDock(), '', 'closed until the header opens it')
      page.chatToggleTerminal()
      assert.equal(page.chat.terminal, true)
      const dock = page.terminalDock()
      assert.match(dock, /<iframe src="\/terminal\/\?arg=curia-684"/)
      assert.doesNotMatch(dock, /touch|Esc|Tab/, 'Curia app adds no key row of its own; ttyd\'s page carries it on a coarse pointer')
      html = page.screenChat(payload())
      assert.match(text(html), /Hide terminal/)
      page.chatToggleTerminal()
      assert.equal(page.chat.terminal, false)
      assert.equal(page.terminalDock(), '')
    })

    test('leaving the room closes its terminal, and the next room starts with it closed', () => {
      page.chatToggleTerminal()
      assert.equal(page.chat.terminal, true)
      page.applyChatRoute(['chat', 'curia-console-2'])
      assert.equal(page.chat.terminal, false)
      assert.equal(page.terminalDock(), '')
    })

    test('an ended agent offers no terminal', () => {
      page.chatReceive('hello', { session: 'curia-684', file: null, harness: 'claude', clients: 1, draft: '', ended: true })
      assert.doesNotMatch(page.screenChat(payload()), /chatToggleTerminal/)
      page.chatToggleTerminal()
      assert.equal(page.chat.terminal, false, 'the toggle refuses too')
    })

    test('an open choice in the room is the same typed card Home draws, answered in place (#712)', () => {
      page.chatReceive('escalations', [{
        id: 'esc-9', kind: 'choice', prompt: '**Which branch?**', typed: true, recommended: false,
        options: ['Stable, and wait for the fix', 'Preview, and take the risk'], option_handles: ['stable', 'preview'],
        files_dir: '/box/data/attachments/esc-9', opened_at: at(50), nudges: 0,
      }])
      const html = page.screenChat(payload())
      assert.match(html, /answerIndex\('esc-9',0\)/)
      assert.match(text(html), /A · stable/)
      assert.match(text(html), /B · preview/)
      assert.match(html, /answerTyped\('esc-9','ans-esc-9',escRecord\('esc-9'\)\)/)
      assert.match(html, /<input type="file" id="files-esc-9" multiple/)
      assert.match(text(html), /They land under \/box\/data\/attachments\/esc-9\//)
      assert.doesNotMatch(text(html), /answer it on Home/)
      assert.equal(page.escRecord('esc-9').id, 'esc-9', 'the typed answer resolves its marker against the room\'s own record')
    })

    test('an ended agent stays readable and refuses new input with one sentence', () => {
      page.chatReceive('hello', { session: 'curia-684', file: null, harness: 'claude', clients: 1, draft: '', ended: true })
      page.chatReceive('items', [{ kind: 'say', text: 'the last word', at: at(100) }])
      const html = page.screenChat(payload())
      assert.match(text(html), /the last word/)
      assert.match(text(html), /curia-684 has ended\. Its transcript stays readable, and it takes no new message\./)
      assert.doesNotMatch(html, /id="chat-box"/, 'no composer')
      assert.doesNotMatch(html, /\/terminal\/\?arg=/, 'no terminal to open either')
    })

    test('the picker row\'s `live: false` refuses the same way before the stream answers', () => {
      page.applyChatRoute(['chat', 'curia-240'])
      page.conversations = { conversations: [conv({ kind: 'ticket', deletable: false, key: 'alp82/curia#240', session: 'curia-240', state: 'done', label: 'Old work', live: false })] }
      const html = page.screenChat(payload())
      assert.match(text(html), /curia-240 has ended/)
      assert.doesNotMatch(html, /id="chat-box"/)
    })

    test('a parked overseer conversation is drawn as a conversation, with no parked state', () => {
      page.applyChatRoute(['chat', 'curia-console-2'])
      page.chatReceive('hello', { session: 'curia-console-2', file: null, harness: 'claude', clients: 1, draft: '', ended: false })
      const html = page.screenChat(payload())
      assert.match(text(html), /overseer · curia-console-2/)
      assert.match(html, /id="chat-box"/, 'the next message rehydrates the pane')
      assert.doesNotMatch(text(html), /park/i)
      assert.doesNotMatch(html, /doChatKey/, 'an overseer conversation has no pane key to send')
    })

    test('Esc projects pending on its pane immediately and reconciles confirmed daemon evidence', async () => {
      let sent
      let answer
      const room = loadPage({ fetchImpl: async (_url, request) => {
        sent = JSON.parse(request.body)
        return new Promise((resolve) => { answer = resolve })
      } })
      room.applyChatRoute(['chat', 'curia-684'])
      room.conversations = { conversations: [
        conv({ kind: 'ticket', deletable: false, key: 'alp82/curia#684', session: 'curia-684', state: 'working', label: 'Build Curia app', repo: 'alp82/curia', ticket: 684, live: true }),
      ] }
      room.beginLocalAction('chat-send')

      const pending = room.doChatKey('escape')

      const action = room.actionFor({ conflict_key: 'pane:curia-684' })
      assert.equal(action.kind, 'pane-key')
      assert.equal(action.target, 'curia-684')
      assert.equal(sent.action_id, action.action_id)
      assert.match(text(room.screenChat(payload())), /Sending Esc…/)
      assert.ok(room.actionFor({ conflict_key: 'chat-send' }), 'a conversation action stays independent')

      answer({ json: async () => ({ action: {
        ...action, status: 'confirmed', revision: 8, receipt: { key: 'Escape' },
      } }) })
      await pending

      assert.equal(room.actionFor({ action_id: action.action_id }), null)
      assert.doesNotMatch(text(room.screenChat(payload())), /Sending Esc…/)
      room.applyChatRoute([])
    })

    test('Send preserves the operator text while its conversation Action is pending', async () => {
      let sent
      const room = loadPage({ fetchImpl: async (_url, request) => {
        sent = JSON.parse(request.body)
        return new Promise(() => {})
      } })
      room.applyChatRoute(['chat', 'curia-console-2'])
      room.chat.draft = 'keep these words'

      room.doChatSend()

      const action = room.actionFor({ conflict_key: 'turn:console-2' })
      assert.equal(action.kind, 'chat-message')
      assert.equal(action.projection.text, 'keep these words')
      assert.equal(sent.action_id, action.action_id)
      assert.equal(room.chat.draft, 'keep these words')
      assert.match(room.screenChat(payload()), /keep these words<\/textarea>/)
      assert.match(text(room.screenChat(payload())), /Sending…/)
      room.applyChatRoute([])
    })

    test('a refused Send keeps the operator text and explains that it was not sent', async () => {
      const room = loadPage({ fetchImpl: async (_url, request) => {
        const sent = JSON.parse(request.body)
        return { json: async () => ({ action: {
          action_id: sent.action_id, kind: 'chat-message', target: 'curia-684',
          conflict_key: 'turn:curia-684', status: 'refused', revision: 8,
          reason: 'the pane stayed active, so curia did not send the text',
          receipt: { outcome: 'not_sent' },
        } }) }
      } })
      room.applyChatRoute(['chat', 'curia-684'])
      room.chat.draft = 'do not lose this'

      await room.doChatSend()

      assert.equal(room.chat.draft, 'do not lose this')
      assert.equal(room.actionFor({ conflict_key: 'turn:curia-684' }), null)
      assert.match(text(room.screenChat(payload())), /did not send the text/)
      room.applyChatRoute([])
    })

    test('confirmed Send evidence clears only the text that Action delivered', async () => {
      const room = loadPage({ fetchImpl: async (_url, request) => {
        const sent = JSON.parse(request.body)
        return { json: async () => ({ action: {
          action_id: sent.action_id, kind: 'chat-message', target: 'curia-684',
          conflict_key: 'turn:curia-684', status: 'confirmed', revision: 9,
          receipt: { outcome: 'delivered' },
        } }) }
      } })
      room.applyChatRoute(['chat', 'curia-684'])
      room.chat.draft = 'deliver this text'

      await room.doChatSend()

      assert.equal(room.chat.draft, '')
      assert.equal(room.actionFor({ conflict_key: 'turn:curia-684' }), null)
      room.applyChatRoute([])
    })

    test('shared sent evidence clears the matching pending text before the next overview', () => {
      page.chat.draft = 'sent through the stream'
      page.beginAction({
        action_id: 'app-stream-send', kind: 'chat-message', target: 'curia-684',
        conflict_key: 'turn:curia-684', projection: { text: 'sent through the stream' },
      })

      page.chatReceive('sent', {
        text: 'sent through the stream', by: page.chat.client, action_id: 'app-stream-send',
      })

      assert.equal(page.chat.draft, '')
      assert.ok(page.actionFor({ action_id: 'app-stream-send' }), 'overview still owns terminal reconciliation')
      page.finishAction('app-stream-send')
    })

    test('shared message progress is visible at the conversation composer', () => {
      page.beginAction({
        action_id: 'app-overseer-progress', kind: 'chat-message', target: 'curia-684',
        conflict_key: 'turn:curia-684', projection: { text: 'inspect the map' },
      })
      page.observeActions([{
        action_id: 'app-overseer-progress', kind: 'chat-message', target: 'curia-684',
        conflict_key: 'turn:curia-684', status: 'progress', revision: 11,
        progress: 'Message delivered; waiting for the overseer response',
        receipt: { outcome: 'delivered' },
      }])

      assert.match(text(page.screenChat(payload())), /Message delivered; waiting for the overseer response/)
      page.finishAction('app-overseer-progress')
    })

    test('Take back projects a rewind immediately and reconciles the shared composer and landing', async () => {
      let sent
      let answer
      const room = loadPage({ fetchImpl: async (_url, request) => {
        sent = JSON.parse(request.body)
        return new Promise((resolve) => { answer = resolve })
      } })
      room.applyChatRoute(['chat', 'curia-684'])
      room.chat.draft = ''

      const pending = room.doTakeBack()

      const action = room.actionFor({ conflict_key: 'turn:curia-684' })
      assert.equal(action.kind, 'chat-take-back')
      assert.equal(action.projection.mode, 'rewind')
      assert.equal(sent.action_id, action.action_id)
      assert.match(text(room.screenChat(payload())), /Rewinding the conversation…/)
      assert.match(room.screenChat(payload()), /onclick="doChatKey\('escape'\)"/, 'the independent pane control remains available')

      answer({ json: async () => ({ action: {
        ...action, status: 'confirmed', revision: 14,
        receipt: {
          composer: 'Keep this exact text.', correction: null,
          take_back: {
            headline: 'Took back your last message.',
            landing: 'The conversation continues after “Start here.”',
            remains: ['The tree stands.'],
          },
        },
      } }) })
      await pending

      assert.equal(room.actionFor({ action_id: action.action_id }), null)
      assert.equal(room.chat.draft, 'Keep this exact text.')
      assert.match(text(room.screenChat(payload())), /Took back your last message.*conversation continues after.*tree stands/i)
      room.applyChatRoute([])
    })

    test('taking back a note projects explicit note recovery under the same conversation conflict', () => {
      let sent
      const room = loadPage({ fetchImpl: async (_url, request) => {
        sent = JSON.parse(request.body)
        return new Promise(() => {})
      } })
      room.applyChatRoute(['chat', 'curia-684'])

      room.doTakeBack({ kind: 'note', id: 'note-7' })

      const action = room.actionFor({ conflict_key: 'turn:curia-684' })
      assert.equal(action.projection.mode, 'note-recovery')
      assert.deepEqual(sent.target, { kind: 'note', id: 'note-7' })
      assert.match(text(room.screenChat(payload())), /Recovering your note…/)
      room.applyChatRoute([])
    })

    test('refresh recovers another device\'s pending take back and its terminal result', async () => {
      const p = payload()
      p.overview.actions = [{
        action_id: 'app-phone-take-back', kind: 'chat-take-back', target: 'curia-684',
        conflict_key: 'turn:curia-684', status: 'accepted', revision: 20,
        progress: 'Rewinding the conversation…',
      }]
      const room = loadPage({ fetchImpl: async () => ({ ok: true, json: async () => p }) })
      room.applyChatRoute(['chat', 'curia-684'])

      await room.tick()

      assert.equal(room.actionFor({ conflict_key: 'turn:curia-684' }).action_id, 'app-phone-take-back')
      assert.match(text(room.screenChat(room.payload)), /Rewinding the conversation…/)

      p.overview.actions = [{
        ...p.overview.actions[0], status: 'confirmed', revision: 21,
        receipt: {
          composer: 'Edit these recovered words.', correction: null,
          take_back: {
            headline: 'Took back your last message.',
            landing: 'The conversation continues after “Earlier turn.”',
            remains: ['The tree stands.'],
          },
        },
      }]
      await room.tick()

      assert.equal(room.actionFor({ action_id: 'app-phone-take-back' }), null)
      assert.equal(room.chat.draft, 'Edit these recovered words.')
      assert.match(text(room.screenChat(room.payload)), /conversation continues after “Earlier turn.”/i)
      room.applyChatRoute([])
    })

    test('a cold refresh applies recent terminal take-back evidence once', async () => {
      const p = payload()
      p.overview.actions = [{
        action_id: 'app-finished-take-back', kind: 'chat-take-back', target: 'curia-684',
        conflict_key: 'turn:curia-684', status: 'confirmed', revision: 24,
        receipt: {
          composer: 'Recovered after refresh.', correction: null,
          take_back: {
            headline: 'Took back your last message.',
            landing: 'The conversation continues after “Earlier turn.”',
            remains: ['The tree stands.'],
          },
        },
      }]
      const room = loadPage({ fetchImpl: async () => ({ ok: true, json: async () => p }) })
      room.applyChatRoute(['chat', 'curia-684'])

      await room.tick()
      await room.tick()

      assert.equal(room.chat.draft, 'Recovered after refresh.')
      assert.equal(room.chat.notes.filter((note) => /Took back/.test(note.text)).length, 1)
      room.applyChatRoute([])
    })

    test('a refused take back stays with its conversation and leaves other rooms available', async () => {
      const room = loadPage({ fetchImpl: async (_url, request) => {
        const sent = JSON.parse(request.body)
        return { json: async () => ({ action: {
          action_id: sent.action_id, kind: 'chat-take-back', target: 'curia-684',
          conflict_key: 'turn:curia-684', status: 'refused', revision: 22,
          reason: 'the transcript has no operator message to take back',
        } }) }
      } })
      room.applyChatRoute(['chat', 'curia-684'])

      await room.doTakeBack()

      assert.equal(room.actionFor({ conflict_key: 'turn:curia-684' }), null)
      assert.match(text(room.screenChat(payload())), /transcript has no operator message to take back/)
      room.applyChatRoute(['chat', 'curia-685'])
      const other = room.screenChat(payload())
      assert.match(other, /onclick="doTakeBack\(\)"/)
      assert.doesNotMatch(other, /Rewinding…/)
      room.applyChatRoute([])
    })

    test('a failed take back reconciles at the conversation control', async () => {
      const room = loadPage({ fetchImpl: async (_url, request) => {
        const sent = JSON.parse(request.body)
        return { json: async () => ({ action: {
          action_id: sent.action_id, kind: 'chat-take-back', target: 'curia-684',
          conflict_key: 'turn:curia-684', status: 'failed', revision: 23,
          reason: 'tmux could not open the rewind picker',
        } }) }
      } })
      room.applyChatRoute(['chat', 'curia-684'])

      await room.doTakeBack()

      assert.equal(room.actionFor({ conflict_key: 'turn:curia-684' }), null)
      assert.match(text(room.screenChat(payload())), /tmux could not open the rewind picker/)
      room.applyChatRoute([])
    })

    test('shared pane-key failure reconciles while the original request is still pending', async () => {
      let actionId
      const room = loadPage({ fetchImpl: async (url, request) => {
        if (url === '/key') {
          actionId = JSON.parse(request.body).action_id
          return new Promise(() => {})
        }
        const p = payload()
        p.overview.actions = [{
          action_id: actionId, kind: 'pane-key', target: 'curia-684',
          conflict_key: 'pane:curia-684', status: 'failed', revision: 12,
          reason: 'tmux socket is unavailable',
        }]
        return { ok: true, json: async () => p }
      } })
      room.applyChatRoute(['chat', 'curia-684'])
      room.conversations = { conversations: [
        conv({ kind: 'ticket', deletable: false, key: 'alp82/curia#684', session: 'curia-684', state: 'working', label: 'Build Curia app', repo: 'alp82/curia', ticket: 684, live: true }),
      ] }

      room.doChatKey('escape')
      await room.tick()

      assert.equal(room.actionFor({ action_id: actionId }), null)
      const html = room.screenChat(room.payload)
      assert.match(html, /class="said bad"/)
      assert.match(text(html), /tmux socket is unavailable/)
      room.applyChatRoute([])
    })

    test('the composer is shared: a draft from the other device mirrors, a sent line is noted', () => {
      page.chatReceive('draft', { text: 'typing from the phone', by: 'other' })
      let t = text(page.screenChat(payload()))
      assert.match(t, /the other device is typing/)
      assert.match(page.screenChat(payload()), /typing from the phone<\/textarea>/)
      page.chatReceive('sent', { text: 'start 267', by: 'other' })
      t = text(page.screenChat(payload()))
      assert.match(t, /sent from the other device: start 267/)
      assert.doesNotMatch(t, /the other device is typing/)
    })

    test('a native dialog is a typed card, and its receipt replaces it', () => {
      page.chatReceive('dialog', { up: true, hint: 'Enter to select', card: { id: 'native-1', kind: 'choice', headline: 'Which branch?', selected_index: 1, options: [{ index: 1, marker: '1', label: 'Stable' }, { index: 2, marker: '2', label: 'Preview' }] } })
      let html = page.screenChat(payload())
      assert.match(html, /doDialogAnswer\('native-1', 2\)/)
      assert.match(text(html), /Which branch\? 1 · Stable · selected now 2 · Preview/)
      page.chatReceive('dialog', { up: false, receipt: { dialog: 'native-1', index: 2, marker: '2', answer: 'Preview', by: 'curia', at: at(1) } })
      html = page.screenChat(payload())
      assert.match(text(html), /answered · curia .* 2 · Preview/)
      assert.doesNotMatch(html, /doDialogAnswer/)
    })

    test('an unparsed native dialog keeps the guard banner and the terminal link', () => {
      page.chatReceive('dialog', { up: true, hint: 'Enter to select', reason: 'curia could not parse options from the native claude dialog', card: null })
      const html = page.screenChat(payload())
      assert.match(text(html), /A native dialog owns the terminal\. curia could not parse options from the native claude dialog/)
      assert.match(html, /href="\/terminal\/\?arg=curia-684"/, 'the terminal is the way through')
      assert.match(text(html), /Chat sends stay blocked while this dialog is open/)
      assert.doesNotMatch(html, /doDialogAnswer/, 'no control answers a card curia could not measure')
      page.chatReceive('dialog', { up: false })
      assert.doesNotMatch(text(page.screenChat(payload())), /native dialog/)
    })

    // The tap is the whole seam between the card and the service: it sends the
    // option index for the card the page holds, and a second tap gets the
    // first receipt (#712's rule) rather than a second answer.
    test('a native dialog choice projects immediately under its own dialog conflict', () => {
      let sent
      const room = loadPage({ fetchImpl: async (_url, request) => {
        sent = JSON.parse(request.body)
        return new Promise(() => {})
      } })
      room.applyChatRoute(['chat', 'curia-684'])
      room.chatReceive('dialog', { up: true, hint: 'Enter to select', card: { id: 'native-3', kind: 'choice', headline: 'Which branch?', selected_index: 1, options: [{ index: 1, marker: 'A', label: 'Stable' }, { index: 2, marker: 'B', label: 'Preview' }] } })
      room.beginLocalAction('chat-send')

      room.doDialogAnswer('native-3', 2)

      const action = room.actionFor({ conflict_key: 'dialog:curia-684:native-3' })
      assert.equal(action.kind, 'native-dialog-answer')
      assert.equal(action.projection.index, 2)
      assert.equal(sent.action_id, action.action_id)
      assert.match(text(room.screenChat(payload())), /Choosing B · Preview…/)
      assert.ok(room.actionFor({ conflict_key: 'chat-send' }), 'an unrelated Chat action stays independent')
      room.applyChatRoute([])
    })

    test('a shared native-dialog failure reconciles while its request is still pending', async () => {
      let actionId
      const room = loadPage({ fetchImpl: async (url, request) => {
        if (url === '/dialog-answer') {
          actionId = JSON.parse(request.body).action_id
          return new Promise(() => {})
        }
        const p = payload()
        p.overview.actions = [{
          action_id: actionId, kind: 'native-dialog-answer',
          target: 'curia-684:native-3', conflict_key: 'dialog:curia-684:native-3',
          status: 'failed', revision: 12,
          reason: 'curia could not answer the native dialog: tmux socket is unavailable',
        }]
        return { ok: true, json: async () => p }
      } })
      room.applyChatRoute(['chat', 'curia-684'])
      room.chatReceive('dialog', { up: true, hint: 'Enter to select', card: { id: 'native-3', kind: 'choice', headline: 'Which branch?', selected_index: 1, options: [{ index: 1, marker: 'A', label: 'Stable' }, { index: 2, marker: 'B', label: 'Preview' }] } })
      room.beginLocalAction('chat-send')

      room.doDialogAnswer('native-3', 2)
      await room.tick()

      assert.equal(room.actionFor({ action_id: actionId }), null)
      const html = room.screenChat(room.payload)
      assert.match(html, /class="said bad"/)
      assert.match(text(html), /tmux socket is unavailable/)
      assert.match(html, /doDialogAnswer\('native-3', 2\)/, 'the dialog remains available after the failed pane write')
      assert.ok(room.actionFor({ conflict_key: 'chat-send' }), 'the failure does not block an unrelated Chat action')
      room.applyChatRoute([])
    })

    test('refresh recovers another client\'s native-dialog claim until the shared receipt arrives', async () => {
      const p = payload()
      p.overview.actions = [{
        action_id: 'app-dialog-phone', kind: 'native-dialog-answer',
        target: 'curia-684:native-3', conflict_key: 'dialog:curia-684:native-3',
        status: 'accepted', revision: 11, progress: 'Choosing B · Preview…',
      }]
      const room = loadPage({ fetchImpl: async () => ({ ok: true, json: async () => p }) })
      room.applyChatRoute(['chat', 'curia-684'])
      room.chatReceive('dialog', { up: true, hint: 'Enter to select', card: { id: 'native-3', kind: 'choice', headline: 'Which branch?', selected_index: 1, options: [{ index: 1, marker: 'A', label: 'Stable' }, { index: 2, marker: 'B', label: 'Preview' }] } })

      await room.tick()

      assert.equal(room.actionFor({ conflict_key: 'dialog:curia-684:native-3' }).action_id, 'app-dialog-phone')
      assert.match(text(room.screenChat(room.payload)), /Choosing B · Preview…/)
      room.chatReceive('dialog', { up: false, receipt: { dialog: 'native-3', index: 2, marker: 'B', answer: 'Preview', by: 'phone', at: at(1) } })
      assert.equal(room.actionFor({ action_id: 'app-dialog-phone' }), null)
      assert.match(text(room.screenChat(room.payload)), /answered · phone .* B · Preview/)
      room.applyChatRoute([])
    })

    test('a tap posts the measured option index, and a second tap shows the first receipt', async () => {
      const posts = []
      const receipt = { dialog: 'native-3', index: 2, marker: 'B', answer: 'Preview', by: 'phone', at: at(1) }
      let answered = false
      const room = loadPage({ fetchImpl: async (url, init) => {
        posts.push({ url, body: JSON.parse(init.body) })
        const first = !answered
        answered = true
        return { json: async () => (first ? { ok: true, receipt } : { error: 'this native dialog already has an answer', receipt }) }
      } })
      room.applyChatRoute(['chat', 'curia-684'])
      room.chatReceive('dialog', { up: true, hint: 'Enter to select', card: { id: 'native-3', kind: 'choice', headline: 'Which branch?', selected_index: 1, options: [{ index: 1, marker: 'A', label: 'Stable' }, { index: 2, marker: 'B', label: 'Preview' }] } })
      await room.doDialogAnswer('native-3', 2)
      assert.equal(posts.length, 1)
      assert.equal(posts[0].url, '/dialog-answer')
      assert.equal(posts[0].body.session, 'curia-684')
      assert.equal(posts[0].body.dialog, 'native-3')
      assert.equal(posts[0].body.index, 2, 'the index, not the words')
      assert.match(text(room.screenChat(payload())), /answered · phone .* B · Preview/)

      room.chat.receipt = null
      room.chatReceive('dialog', { up: true, hint: 'Enter to select', card: { id: 'native-3', kind: 'choice', headline: 'Which branch?', selected_index: 1, options: [{ index: 1, marker: 'A', label: 'Stable' }, { index: 2, marker: 'B', label: 'Preview' }] } })
      await room.doDialogAnswer('native-3', 1)
      assert.equal(posts.length, 2)
      const html = room.screenChat(payload())
      assert.match(text(html), /answered · phone .* B · Preview/, 'the first receipt, not an error')
      assert.doesNotMatch(html, /doDialogAnswer/)
      room.applyChatRoute([])
    })

    test('a parse failure is a banner, never silence', () => {
      page.chatReceive('parse', { reason: 'unknown line shape', file: 'x', dropped: 3 })
      assert.match(text(page.screenChat(payload())), /INCOMPLETE — unknown line shape \(3 lines dropped\)/)
    })
  })

  test('the chat is a screen of the shell now, and no longer the one that lands later', () => {
    const src = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(src, /chat:\s*\["Chat",\s*screenChat\]/)
    assert.doesNotMatch(text(page.screenChat(payload())), /#267/, 'the placeholder is gone')
  })

  // The page and the sidecar are two halves of one protocol with no build step
  // between them, and #333 added routes to both halves. A page that speaks the
  // new one against an old sidecar draws a picker whose every button answers
  // 404, which is what the stamp exists to refuse.
  test('the page declares the proto its own routes need', () => {
    const src = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(src, new RegExp(`<meta name="curia-dashboard" content="proto=${DASHBOARD_PROTO}">`))
    assert.match(src, /"\/api\/console\/new"/)
    assert.match(src, /"\/api\/console\/delete"/)
  })

  // Arriving is what takes the read. Settings holds its copy because a config
  // file changes when somebody saves it; this list carries a context percent
  // and a last-turn time, and both move with every turn from any device.
  test('every arrival on the Chat screen re-reads the list', () => {
    const src = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(src, /if \(k === "chat"\) loadConversations\(\)/)
  })
})

// The Credentials screen (#661), on the shape the #645 prototype settled.
//
// It exists to answer the one question no other surface could take: what is the
// state of all three? The attention list is built to be EMPTY — `valid` and
// `expiring` are silent by design — so before this screen there was nowhere to
// look when nothing was wrong, and `unowned` was an absence rather than a fact.
//
// What is pinned here is what the screen SAYS, the same half of the page a
// human reading a preview cannot check by looking: that a held lane names what
// it broke rather than what the file holds, that a login that could not be
// scraped hands over the terminal instead of dead-ending, and that no surface
// on this page ever offers a field to type a credential into.
describe('the Credentials screen (#661)', () => {
  let page
  before(() => { page = loadPage() })

  test('all three rows are on it, healthy ones included, each naming its provider', () => {
    const t = text(page.screenCredentials(payload({ credentials: THREE_ROWS() })))
    assert.match(t, /Model credentials \(3\)/)
    assert.match(t, /codex openai valid/)
    assert.match(t, /claude anthropic unknown/)
    assert.match(t, /overseer anthropic unknown/)
  })

  // Two of the three rows read one provider-keyed store, so ONE press signs
  // both in. A second button for the same act would be a second way in where
  // there is one.
  test('one login is offered once, however many rows it heals', () => {
    const html = page.screenCredentials(payload({
      credentials: {
        consumers: [
          { consumer: 'claude', provider: 'anthropic', state: 'expired', why: 'the year is up', lane: LANE('anthropic') },
          { consumer: 'overseer', provider: 'anthropic', state: 'expired', why: 'the year is up', lane: LANE('anthropic') },
        ],
        reauth: null,
      },
    }))
    assert.equal(html.split('Sign in from a browser').length - 1, 1)
    assert.match(text(html), /the same login signs this in/)
  })

  test('sign-in projects immediately and keeps shared progress through a late transport failure', async () => {
    let rejectRequest
    let sent
    const local = loadPage({
      fetchImpl: (_path, request) => {
        sent = JSON.parse(request.body)
        return new Promise((_resolve, reject) => { rejectRequest = reject })
      },
    })
    local.payload = payload({
      credentials: {
        consumers: [{ consumer: 'claude', provider: 'anthropic', state: 'expired', why: 'the year is up', lane: LANE('anthropic') }],
        reauth: null,
      },
    })

    const pending = local.startReauth('anthropic')
    const action = local.actionFor({ conflict_key: 'reauth:anthropic' })
    assert.equal(action.kind, 'credential-sign-in')
    assert.equal(sent.action_id, action.action_id)
    assert.match(text(local.screenCredentials(local.payload)), /Starting sign-in/)

    local.observeActions([{
      ...action, status: 'progress', revision: 30, progress: 'Preparing the agent image',
    }])
    assert.match(text(local.screenCredentials(local.payload)), /Preparing the agent image/)
    rejectRequest(new Error('the service did not answer /command within 5s'))
    await pending

    assert.equal(local.actionFor({ action_id: action.action_id }).status, 'progress')
    assert.doesNotMatch(text(local.screenCredentials(local.payload)), /did not answer/)
  })

  test('the press names the provider, because two of the three rows are anthropic', () => {
    const html = page.screenCredentials(payload({
      credentials: { consumers: [{ consumer: 'claude', provider: 'anthropic', state: 'absent', why: 'none on this box', lane: LANE('anthropic') }], reauth: null },
    }))
    assert.match(html, /startReauth\('anthropic'\)/)
  })

  // #645 finding 2, and the field #661 put on the wire for it. A dead
  // credential is a fact about the BOX: one lane stops dispatching, and every
  // live agent on it freezes mid-ticket. No state word can carry that.
  test('a held lane says what it broke, and that the frozen agents are not lost', () => {
    const t = text(page.screenCredentials(payload({ credentials: HELD_CREDENTIALS() })))
    assert.match(t, /the openai lane is held — nothing new dispatches to it/)
    assert.match(t, /2 live agent\(s\) are frozen mid-ticket, not lost: curia-574, curia-578/)
    assert.match(t, /heal on the tick after a fresh credential lands/)
  })

  test('a held lane reads as held, though its token is good for another two days', () => {
    const t = text(page.screenCredentials(payload({ credentials: HELD_CREDENTIALS() })))
    assert.match(t, /codex openai held/)
    assert.match(t, /refresh_token_reused/)
    assert.ok(!/codex openai expiring/.test(t), 'the state word is true about the token and false about the lane')
  })

  test('one lane says its sentence once, though two rows answer it', () => {
    const html = page.screenCredentials(payload({
      credentials: {
        consumers: [
          { consumer: 'claude', provider: 'anthropic', state: 'expired', why: 'the year is up', lane: LANE('anthropic', ['curia-700']) },
          { consumer: 'overseer', provider: 'anthropic', state: 'expired', why: 'the year is up', lane: LANE('anthropic', ['curia-700']) },
        ],
        reauth: null,
      },
    }))
    assert.equal(html.split('the anthropic lane is held').length - 1, 1)
  })

  test('a working lane names no frozen agents, because there are none', () => {
    const t = text(page.screenCredentials(payload({ credentials: THREE_ROWS() })))
    assert.ok(!/lane is held/.test(t))
    assert.ok(!/frozen/.test(t))
  })

  // The login is a PANEL above the table, not a row inside it: a flow with a
  // countdown, a code and a fallback is a panel whatever it is called.
  test('a login in flight draws the link, the code and the clock', () => {
    const t = text(page.screenCredentials(payload({ credentials: { ...HELD_CREDENTIALS(), reauth: WAITING_REAUTH() } })))
    assert.match(t, /openai · signing in · 27:00 left/)
    assert.match(t, /https:\/\/auth\.openai\.com\/codex\/device/)
    assert.match(t, /83CC-A4ZT/)
    assert.match(t, /Nothing is pasted back/)
  })

  // #660: the anthropic lane asks the operator to type a code IN rather than
  // read one out. Since #891 the card takes it: a Code field and a Submit,
  // and curia types it into the login pane itself. The panel shows no code
  // that does not exist.
  test('the anthropic lane takes the code on the card and shows no code to read', () => {
    const html = page.screenCredentials(payload({
      credentials: { consumers: [], reauth: WAITING_REAUTH({ provider: 'anthropic', session: 'curia-auth-anthropic', typed: true, code: null }) },
    }))
    const t = text(html)
    assert.match(t, /Paste the code the browser shows/)
    assert.match(html, /<input id="setup-anthropic-code"/)
    assert.match(html, /onclick="doSetupAnthropicCode\(/)
    assert.ok(!/curia cannot type it for you/.test(t))
    assert.ok(!/Enter this code/.test(t))
  })

  test('a delivered code and a refused code are each said on the typed lane, and a refusal keeps the field', () => {
    const delivered = text(page.screenCredentials(payload({
      credentials: { consumers: [], reauth: WAITING_REAUTH({ provider: 'anthropic', session: 'curia-auth-anthropic', typed: true, code: null, delivered_at: at(20), refusal: null }) },
    })))
    assert.match(delivered, /Code delivered/)
    const refusedHtml = page.screenCredentials(payload({
      credentials: { consumers: [], reauth: WAITING_REAUTH({ provider: 'anthropic', session: 'curia-auth-anthropic', typed: true, code: null, delivered_at: at(40), refusal: { why: 'OAuth error: Request failed with status code 400', at: at(20) } }) },
    }))
    assert.match(text(refusedHtml), /The login refused the code: OAuth error: Request failed with status code 400/)
    assert.match(refusedHtml, /<input id="setup-anthropic-code"/)
  })

  // #645 finding 4. The card named the terminal and never linked it, though the
  // daemon had been composing that link for Discord since the first commit.
  test('the terminal is a link, not an instruction', () => {
    const html = page.screenCredentials(payload({ credentials: { consumers: [], reauth: WAITING_REAUTH() } }))
    assert.match(html, /href="https:\/\/box\.taile1a2b\.ts\.net:8443\/\?arg=curia-auth-openai"/)
    assert.match(text(html), /Open the terminal instead/)
  })

  // IT DEGRADES, NEVER DEAD-ENDS. The link and the code are scraped off a pane,
  // and a scrape is a guess about somebody else's wording.
  test('a scrape that missed for the whole wait says so and hands over the terminal', () => {
    const t = text(page.screenCredentials(payload({
      credentials: { consumers: [], reauth: WAITING_REAUTH({ url: null, code: null, started_at: at(240) }) },
    })))
    assert.match(t, /curia could not read the login off the pane/)
    assert.match(t, /Open the terminal instead/)
  })

  // The rehearsal (#891) read that failure for the first minute of every
  // login, before the pane had printed anything. A pane that has not printed
  // the link yet is progress, not a failure, until the wait is spent.
  test('a pane that has not printed the link yet reads as waiting, not as a failure, until the wait is spent', () => {
    const t = text(page.screenCredentials(payload({
      credentials: { consumers: [], reauth: WAITING_REAUTH({ url: null, code: null, started_at: at(20) }) },
    })))
    assert.match(t, /Waiting for the sign-in link/)
    assert.doesNotMatch(t, /could not read the login/)
    assert.match(t, /Open the terminal instead/)
  })

  test('a terminal link curia could not publish says that, rather than linking nowhere', () => {
    const t = text(page.screenCredentials(payload({
      credentials: { consumers: [], reauth: WAITING_REAUTH({ terminal_url: null }) },
    })))
    assert.match(t, /could not publish a terminal link/)
  })

  test('a login already running offers no second way in', () => {
    const html = page.screenCredentials(payload({ credentials: { ...HELD_CREDENTIALS(), reauth: WAITING_REAUTH() } }))
    assert.ok(!/Sign in from a browser/.test(html))
    assert.match(text(html), /signing in now — the link is in the panel above/)
  })

  // `unowned` is the state this screen exists to make legible: on the attention
  // list it was an ABSENCE, and an absence reads as nothing rather than as a
  // fact about what this service owns.
  test('unowned is a row with nothing to press, not a missing row', () => {
    const t = text(page.screenCredentials(payload({
      credentials: {
        consumers: [{ consumer: 'codex', provider: 'openai', state: 'unowned', expires_at: null, lane: LANE('openai'), why: 'this service brokers no model credential for that provider' }],
        reauth: null,
      },
    })))
    assert.match(t, /codex openai unowned/)
    assert.match(t, /brokers no model credential/)
    assert.match(t, /nothing to press/)
  })

  // Null is not empty (rule 2). A service older than this page answers with no
  // credentials section at all, and that is not a box that owns none.
  test('a snapshot with no credentials section is not a service with no credentials', () => {
    const t = text(page.screenCredentials(payload({ credentials: undefined })))
    assert.match(t, /carries no credentials section/)
    assert.match(t, /older than this page/)
  })

  test('no snapshot at all draws no rows and says why', () => {
    const p = payload()
    p.overview = null
    assert.match(text(page.screenCredentials(p)), /No snapshot yet/)
  })

  // Subscription only, in every direction: `ANTHROPIC_API_KEY` and codex's
  // `--with-api-key` are metered billing and are out, so no surface may grow a
  // field that would take one.
  test('the page says it holds no API key, and offers no field for one', () => {
    const html = page.screenCredentials(payload({ credentials: THREE_ROWS() }))
    assert.match(text(html), /Subscription credentials only/)
    assert.ok(!/<input/.test(html), 'a credentials screen with a text field is the API-key path arriving by the back door')
  })

  // FOUND BY LOOKING, NOT BY REASONING (#645 finding 6). At 390px the six-column
  // table did not wrap — it overflowed, and the column it pushed off the screen
  // was the one holding the one button.
  test('every row restacks as a card below 640px, with the action full width', () => {
    const src = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(src, /@media \(max-width: 640px\) \{\s*table\.creds/)
    assert.match(src, /table\.creds td\.c-act \.btn \{ display: block; width: 100%/)
    // The header is gone at that width, so each cell carries its own label.
    const html = page.screenCredentials(payload({ credentials: THREE_ROWS() }))
    for (const label of ['state', 'expires', 'last refresh', 'why']) {
      assert.match(html, new RegExp(`data-label="${label}"`))
    }
  })

  // The page and the sidecar are two halves of one protocol with no build step
  // between them. A Credentials screen drawn against a proto-6 sidecar has a
  // button that answers 404 at the one press it exists for.
  test('the page declares the proto its own route needs', () => {
    const src = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(src, new RegExp(`<meta name="curia-dashboard" content="proto=${DASHBOARD_PROTO}">`))
    assert.match(src, /"\/api\/reauth"/)
    assert.match(src, /credentials:\s*\["Credentials",\s*screenCredentials\]/)
  })
})

// ---- integration setup (#874, the frame the #853 prototype settled) ----------
//
// The screen draws its own read, `GET /api/setup`, and the test drives it
// with the wire shape the service answers. What is pinned is the frame and
// not any integration: four fixed-height cards in the accepted order, a
// selection in any order that the service keeps for a reopen, a connected
// state that comes from this read and never from stored progress, the error
// treatment with one action and Try again, and a Full loop action that stays
// unavailable until the gate says otherwise.
describe('integration setup (#874)', () => {
  const card = (key, title, over = {}) => ({
    key, title, state: 'unavailable', badge: 'Not available', footer: null, error: null,
    pending: `${title} data will appear after ${title} verifies.`, ...over,
  })
  const CARDS = (over = {}) => [
    card('github', 'GitHub', over.github), card('discord', 'Discord', over.discord),
    card('tailscale', 'Tailscale', over.tailscale), card('model', 'Model provider', over.model),
  ]
  const SETUP = (over = {}) => ({
    step: 'github', progress: {}, cards: CARDS(over.cards ?? {}),
    full_loop: { ready: false, missing: ['github', 'discord', 'tailscale', 'model'], reason: 'Waiting for GitHub, Discord, Tailscale, Model provider.', facts: null },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'cards')),
  })
  const connected = (primary, secondary, emoji = '✅') => ({ state: 'connected', badge: 'Connected and verified', footer: { primary, secondary, emoji } })
  const ALL = {
    github: connected('alp82/curia', 'No open tickets · Issues, pull requests, and Actions ready', '📦'),
    discord: connected('#curia', 'Confirmation delivered · 6 commands registered', '💬'),
    tailscale: connected('curia.tail1234.ts.net', 'alp@example.com · Serve reachable in 38 ms', '🔒'),
    model: { ...connected('OpenAI', 'Routing ready · verification request completed in 0.9 s', '⚡'), badge: 'Provider verified' },
  }

  let page
  let calls
  beforeEach(() => {
    calls = []
    page = loadPage({
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
        return { ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP()) }
      },
    })
    page.UI.screen = 'setup'
  })

  test('Setup is a screen of the app, and it draws the held overview reading like every other', () => {
    assert.match(text(page.desktopNav(0, '')), /Credentials Setup Settings/)
    page.setup = SETUP()
    assert.match(text(page.screenSetup(payload())), /read \d+s ago/)
  })

  test('the four cards draw in the accepted order, each a fixed-height surface with its logo, word, and badge', () => {
    page.setup = SETUP()
    const html = page.screenSetup(payload())
    const keys = [...html.matchAll(/class="setup-card (\w+) /g)].map((m) => m[1])
    assert.deepEqual(keys, ['github', 'discord', 'tailscale', 'model'])
    for (const title of ['GitHub', 'Discord', 'Tailscale', 'Model provider']) {
      assert.match(html, new RegExp(`<span class="setup-title">${title}</span><span class="setup-badge">Not available</span>`))
    }
    assert.match(text(html), /0\/4 verified/)
    // The stub says the step is not available rather than drawing an empty form.
    assert.match(text(html), /Connecting GitHub isn't available yet/)
  })

  test('the rail geometry is one height in every state, and narrow screens stack the cards full width', () => {
    const src = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(src, /\.setup-card \{[^}]*height: 190px;/s)
    assert.match(src, /\.setup-head \{[^}]*flex: 0 0 68px;/s)
    const narrow = /@media \(max-width: 760px\) \{\s*\.setup \{ grid-template-columns: 1fr; \}\s*\.setup-card \{ width: 100%; \}/
    assert.match(src, narrow)
  })

  test('before a card verifies its footer names the data that will appear, and nothing else', () => {
    page.setup = SETUP()
    const html = page.screenSetup(payload())
    assert.match(html, /setup-pending[^<]*<span aria-hidden="true">○<\/span><span>GitHub data will appear after GitHub verifies\.<\/span>/)
    assert.doesNotMatch(html, /setup-primary/)
  })

  test('a connected card takes the connected treatment and its footer is the one real fact the read carried', () => {
    page.setup = SETUP({ cards: { github: connected('#861 · Chart backup and recovery lifecycle', 'ready-for-agent · alp82/curia · 9 open tickets', '🎫') } })
    const html = page.screenSetup(payload())
    assert.match(html, /class="setup-card github connected on"/)
    assert.match(html, /<span class="fact">#861 · Chart backup and recovery lifecycle<\/span>/)
    assert.match(html, /<div class="setup-secondary">ready-for-agent · alp82\/curia · 9 open tickets<\/div>/)
    assert.match(text(html), /1\/4 verified/)
  })

  test('selection in any order posts the step so a reopen lands on it, and the rail moves at once', async () => {
    page.setup = SETUP()
    await page.selectSetupCard('tailscale')
    assert.equal(page.setup.step, 'tailscale')
    assert.match(page.screenSetup(payload()), /class="setup-card tailscale unavailable on" aria-pressed="true"/)
    await page.selectSetupCard('github')
    await page.selectSetupCard('model')
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ step: 'tailscale' }, { step: 'github' }, { step: 'model' }])
    assert.ok(calls.every((c) => c.url === '/api/setup'))
  })

  test('a card that is not one of the four is not a selection', async () => {
    page.setup = SETUP()
    await page.selectSetupCard('full')
    assert.equal(page.setup.step, 'github')
    assert.equal(calls.length, 0)
  })

  test('a reopen restores the selected card and hands the card its own remembered progress, through the content slot', () => {
    page.setup = SETUP({ step: 'discord', progress: { discord: { channel: 'ops', guild_id: '123456789' } } })
    const seen = []
    page.SETUP_CONTENT.discord.content = (c, progress) => { seen.push({ key: c.key, progress }); return '<p>slot</p>' }
    const html = page.screenSetup(payload())
    assert.match(html, /class="setup-card discord unavailable on"/)
    assert.match(html, /<h2>Discord<\/h2>/)
    assert.deepEqual(seen, [{ key: 'discord', progress: { channel: 'ops', guild_id: '123456789' } }])
  })

  test('remembered progress is a checkpoint and never a connection: a card with progress and no fresh yes stays unconnected', () => {
    page.setup = SETUP({ progress: { discord: { channel: 'ops' }, tailscale: { machine_name: 'curia.sh' } } })
    const html = page.screenSetup(payload())
    assert.doesNotMatch(html, /setup-card \w+ connected/)
    assert.match(text(html), /0\/4 verified/)
    assert.match(html, /this read's verification, not a saved result/)
  })

  test('safe progress goes to the service through one call, never into browser storage', async () => {
    page.setup = SETUP()
    await page.rememberSetupProgress('tailscale', { machine_name: 'curia.sh' })
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ progress: { tailscale: { machine_name: 'curia.sh' } } }])
    assert.equal(JSON.stringify(page.setup.progress.tailscale), JSON.stringify({ machine_name: 'curia.sh' }))
    assert.equal(page.localStorage.getItem('setup'), null)
  })

  test('a failed verification is red on the card and names the failure and one action, with Try again on the current step', async () => {
    page.setup = SETUP({
      step: 'tailscale',
      cards: { tailscale: { state: 'failed', badge: 'Action required', error: { failed: 'Tailscale Serve is not reachable', action: 'Run tailscale serve --bg 8445 on this host, then try again.' } } },
    })
    const html = page.screenSetup(payload())
    assert.match(html, /class="setup-card tailscale failed on"/)
    assert.match(html, /<span class="setup-badge">Action required<\/span>/)
    assert.match(html, /setup-problem"><b>Tailscale Serve is not reachable<\/b>Run tailscale serve --bg 8445 on this host, then try again\./)
    assert.match(html, /onclick="retrySetup\(\)">Try again</)
    // Try again is a fresh read of every card, never a local flip.
    await page.retrySetup()
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/setup']])
    assert.equal(page.setup.cards.find((c) => c.key === 'tailscale').state, 'unavailable', 'the card is what the read said')
  })

  test('a connected card offers Continue setup to the next unconnected card, in rail order', async () => {
    page.setup = SETUP({ step: 'tailscale', cards: { tailscale: ALL.tailscale, github: ALL.github } })
    assert.match(page.screenSetup(payload()), /onclick="continueSetup\(\)">Continue setup</)
    await page.continueSetup()
    assert.equal(page.setup.step, 'discord')
  })

  test('the Full loop action stays unavailable with four connected cards until the gate supplies its facts', () => {
    page.setup = SETUP({
      step: 'model', cards: ALL,
      full_loop: { ready: false, missing: [], reason: 'The Full loop is not available yet in this release.', facts: null },
    })
    const html = page.screenSetup(payload())
    assert.match(text(html), /4\/4 verified/)
    const loop = /setup-loop[\s\S]*?<\/div><\/div>/.exec(html)[0]
    assert.match(loop, /The Full loop is not available yet in this release\./)
    assert.match(html, /<button class="btn primary" disabled>Run Full loop<\/button>/)
    assert.doesNotMatch(html, /onclick="runFullLoop\(\)"/)
    assert.doesNotMatch(html, /Continue setup/)
  })

  test('a missing card is named as what the Full loop waits for', () => {
    page.setup = SETUP({ cards: { github: ALL.github, discord: ALL.discord, model: ALL.model }, full_loop: { ready: false, missing: ['tailscale'], reason: 'Waiting for Tailscale.', facts: null } })
    assert.match(page.screenSetup(payload()), /Waiting for Tailscale\./)
  })

  test('the gate opens the action, and nothing on the page opens it otherwise', () => {
    page.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts: { channel: '#curia' } } })
    const html = page.screenSetup(payload())
    assert.match(html, /<button class="btn primary" onclick="runFullLoop\(\)">Run Full loop<\/button>/)
  })

  // #880: at convergence the panel names what the loop would run on, from
  // this read's gate. #882: the press runs it through the sidecar and draws
  // the run the service answers.
  test('at convergence the Full loop panel names the gate\'s facts, and the press runs the loop through the sidecar', async () => {
    const facts = {
      verified_at: '2026-09-02T10:00:00.000Z',
      github: { repo: 'alp82/curia', covered: ['alp82/curia'], owners: [], open_tickets: 3, ticket: { repo: 'alp82/curia', number: 861, title: 'Chart backup', url: 'https://github.com/alp82/curia/issues/861' } },
      discord: { guild: { id: '2', name: 'AI Stack' }, channel: { id: '4', name: 'curia', url: 'https://discord.com/channels/2/4' }, operator: null, commands: [], confirmation: null, bridge: 'up' },
      tailscale: { address: 'curia.tail1234.ts.net', app_url: 'https://curia.tail1234.ts.net:8445/', operator: 'alp@example.com', admitted_ms: 12 },
      model: { provider: 'anthropic', model: 'fable', request: null, rows: [], providers: { openai: 'unconnected', anthropic: 'connected' } },
    }
    page.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts } })
    let html = page.screenSetup(payload())
    const line = /setup-loop-facts">([^<]*)</.exec(html)[1]
    assert.match(line, /🎫 #861 · alp82\/curia/)
    assert.match(line, /💬 #curia/)
    assert.match(line, /🔒 curia\.tail1234\.ts\.net/)
    assert.match(line, /🧠 Anthropic · fable/)
    assert.match(html, /Every integration is connected and verified\./)
    assert.match(html, /<button class="btn primary" onclick="runFullLoop\(\)">Run Full loop<\/button>/)
    await page.runFullLoop()
    const press = calls.find((c) => c.method === 'POST')
    assert.equal(press.url, '/api/setup/full-loop')
    assert.deepEqual(press.body, {}, 'the press names nothing: the service selects the repository and the marked ticket')

    // No ticket discovered: the repository is named, and nothing is invented.
    page.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts: { ...facts, github: { ...facts.github, ticket: null }, model: { ...facts.model, provider: 'openai', model: 'gpt' } } } })
    const plain = /setup-loop-facts">([^<]*)</.exec(page.screenSetup(payload()))[1]
    assert.match(plain, /📦 alp82\/curia/)
    assert.doesNotMatch(plain, /🎫/)
    assert.match(plain, /⚡ OpenAI · gpt/)
  })

  // #882: the run, as the service reads it off its journal. The panel draws
  // exactly that: one row per leg, the artifacts linked, the elapsed time,
  // and on a failure the leg, the cause, the action, and Try again.
  const LEG_KEYS = ['discovery', 'dispatch', 'escalation', 'pull_request', 'review', 'merge', 'resolution', 'map_update']
  const LEG_TITLES = ['Frontier discovery', 'Dispatch', 'Escalation and answer', 'Pull request', 'Review', 'Merge', 'Ticket resolution', 'Map update']
  const RUN = (state, { legs = [], failed = null, elapsed = 61_000 } = {}) => ({
    state,
    repo: 'alp82/curia',
    ticket: { number: 42, title: 'The rehearsal ticket', url: 'https://github.com/alp82/curia/issues/42', map: 40 },
    started_at: '2026-09-02T10:00:00.000Z',
    finished_at: state === 'running' ? null : '2026-09-02T10:01:01.000Z',
    elapsed_ms: elapsed,
    legs: LEG_KEYS.map((key, i) => ({ key, title: LEG_TITLES[i], state: legs[i] ?? 'pending', at: legs[i] === 'complete' ? '2026-09-02T10:00:30.000Z' : null, ms: legs[i] === 'complete' ? 3000 : null, link: null })),
    failed,
    links: { ticket: 'https://github.com/alp82/curia/issues/42', thread: 'https://discord.com/channels/2/777', channel: 'https://discord.com/channels/2/4', pull_request: legs[3] === 'complete' ? 'https://github.com/alp82/curia/pull/50' : null, map: 'https://github.com/alp82/curia/issues/40' },
  })
  const RUN_FACTS = { github: { repo: 'alp82/curia', covered: ['alp82/curia'], ticket: null }, discord: { channel: { name: 'curia' } }, tailscale: { address: 'a.ts.net' }, model: { provider: 'anthropic', model: 'fable' } }

  test('a running Full loop draws one row per leg with its state as a word, the elapsed time, and no press', () => {
    const run = RUN('running', { legs: ['complete', 'complete', 'running'] })
    page.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts: RUN_FACTS, run } })
    const html = page.screenSetup(payload())
    const body = text(html)
    assert.match(body, /Running the Full loop\./)
    assert.match(body, /alp82\/curia#42 · 1 min 1 s so far/)
    assert.match(body, /Frontier discovery · complete/)
    assert.match(body, /Dispatch · complete/)
    assert.match(body, /Escalation and answer · running/)
    assert.match(body, /Map update · pending/)
    assert.doesNotMatch(html, /onclick="runFullLoop\(\)"/, 'no second press while a run is live')
    assert.match(html, /<section><div class="setup-panel" id="setup-run">/, 'a live run is the selected panel (#891)')
    page.UI.setup.panel = 'card'
    assert.match(page.screenSetup(payload()), /<button class="btn primary" disabled>Running the Full loop…<\/button>/, 'the card panel names the run as the forward action')
    assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/issues\/42"[^>]*>Ticket/)
    assert.match(html, /href="https:\/\/discord\.com\/channels\/2\/777"[^>]*>Discord thread/)
    assert.doesNotMatch(html, /Pull request ↗/, 'a link the run has not produced is not drawn')
    assert.doesNotMatch(html, /setup-loop-facts/, 'the gate\'s facts line gives way to the run')
  })

  test('a complete Full loop is the verified state: every leg, every artifact linked, the total elapsed time, and Open Curia', () => {
    const run = RUN('complete', { legs: LEG_KEYS.map(() => 'complete'), elapsed: 754_000 })
    run.legs[3].link = 'https://github.com/alp82/curia/pull/50'
    page.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts: RUN_FACTS, run } })
    const html = page.screenSetup(payload())
    const body = text(html)
    assert.match(body, /Full loop verified\./)
    assert.match(body, /alp82\/curia#42 · every leg completed in 12 min 34 s\./)
    for (const title of LEG_TITLES) assert.match(body, new RegExp(`${title} · complete`))
    assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/pull\/50"[^>]*>Pull request ↗/)
    assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/issues\/40"[^>]*>Map ↗/)
    assert.match(html, /href="https:\/\/discord\.com\/channels\/2\/4"[^>]*>Command channel ↗/)
    assert.match(html, /href="https:\/\/github\.com\/alp82\/curia\/pull\/50"[^>]*>open</, 'the leg row links its own artifact')
    assert.match(html, /onclick="goto\('home'\);return false">Open Curia/)
    assert.doesNotMatch(html, /onclick="runFullLoop\(\)"/)
    assert.doesNotMatch(html, /Try again/)
  })

  test('a failed Full loop names the leg, the cause, and the action, keeps the completed legs, and Try again retries the same step', async () => {
    const failed = { leg: 'review', title: 'Review', cause: 'The agent ended before Review: the agent exited.', action: 'Read the thread of alp82/curia#42 in #curia and fix what stopped the agent, then select Try again to dispatch alp82/curia#42 again.' }
    const run = RUN('failed', { legs: ['complete', 'complete', 'complete', 'complete', 'failed'], failed })
    page.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts: RUN_FACTS, run } })
    const html = page.screenSetup(payload())
    const body = text(html)
    assert.match(body, /The Full loop did not complete\./)
    assert.match(body, /Review failed: The agent ended before Review: the agent exited\./)
    assert.match(body, /Read the thread of alp82\/curia#42 in #curia and fix what stopped the agent, then select Try again/)
    assert.match(body, /Pull request · complete/)
    assert.match(body, /Review · failed/)
    assert.match(html, /onclick="retryFullLoop\(\)">Try again</)
    assert.doesNotMatch(html, /onclick="runFullLoop\(\)"/)
    await page.retryFullLoop()
    const press = calls.find((c) => c.method === 'POST')
    assert.equal(press.url, '/api/setup/full-loop/retry')
    assert.deepEqual(press.body, {})
  })

  test('the press draws the run the sidecar answers, and a refused press says the sentence and presses nothing else', async () => {
    const running = RUN('running', { legs: ['complete', 'running'] })
    let answer = { ok: true, run: running }
    let status = 200
    const p2 = loadPage({
      fetchImpl: async (url, init = {}) => ({ ok: status === 200, status, json: async () => (init.method === 'POST' ? answer : SETUP()) }),
    })
    p2.UI.screen = 'setup'
    p2.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts: RUN_FACTS, run: { state: 'idle', legs: [] } } })
    assert.match(p2.screenSetup(payload()), /onclick="runFullLoop\(\)">Run Full loop</, 'an idle run leaves the press')
    await p2.runFullLoop()
    assert.equal(p2.setup.full_loop.run, running)
    assert.match(text(p2.screenSetup(payload())), /Running the Full loop\./)
    assert.ok(p2.UI.setup.loopTimer, 'a live run is followed')
    clearTimeout(p2.UI.setup.loopTimer)
    p2.UI.setup.loopTimer = null

    p2.setup.full_loop.run = { state: 'idle', legs: [] }
    answer = { error: "The Full loop isn't ready: Waiting for Discord." }
    status = 409
    await p2.runFullLoop()
    assert.equal(p2.setup.full_loop.run.state, 'idle', 'a refused press changes no run')
    assert.match(text(p2.screenSetup(payload())), /The Full loop isn't ready: Waiting for Discord\./)
    assert.equal(p2.UI.setup.loopTimer, null)
  })

  test('the facts line is drawn from the gate\'s answer only: a closed gate draws none', () => {
    page.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: false, missing: [], reason: 'GitHub verified without a covered repository. Select Try again.', facts: null } })
    const html = page.screenSetup(payload())
    assert.doesNotMatch(html, /setup-loop-facts/)
    assert.match(html, /GitHub verified without a covered repository\. Select Try again\./)
    assert.match(html, /<button class="btn primary" disabled>Run Full loop<\/button>/)
  })

  test('a service that could not be asked is not four unconnected cards', () => {
    page.setup = { step: null, progress: null, cards: null, full_loop: null, error: 'the daemon did not answer /setup within 60s' }
    const html = page.screenSetup(payload())
    assert.match(text(html), /curia could not verify the integrations: the daemon did not answer/)
    assert.doesNotMatch(html, /setup-card/)
    assert.match(html, /onclick="retrySetup\(\)"/)
  })

  test('Home points at setup while an integration is not connected, and stops when all four are', () => {
    page.UI.screen = 'home'
    page.setup = SETUP({ cards: { github: ALL.github } })
    assert.match(text(page.screenHome(payload())), /Integration setup isn't finished\. Not connected yet: Discord, Tailscale, Model provider\./)
    page.setup = SETUP({ cards: ALL })
    assert.doesNotMatch(page.screenHome(payload()), /setup-pointer/)
    page.setup = null
    assert.doesNotMatch(page.screenHome(payload()), /setup-pointer/)
  })

  // The GitHub card (#875). Before the App exists the panel offers the one
  // press that opens GitHub's manifest handoff; it collects a name and never a
  // credential. After, it draws the install link per watched owner from the
  // held overview, and the connected panel draws the real ticket or the
  // honest zero the service reported.
  const APP = (over = {}) => ({
    configured: true, status: 'complete',
    app: { id: '42', slug: 'curia-box', bot_login: 'curia-box[bot]', key_file: '/root/secrets/github-app.json', settings_url: 'https://github.com/settings/apps/curia-box' },
    installations: { state: 'read', at: new Date().toISOString(), error: null },
    owners: [{ owner: 'alp82', installed: false, installation_id: null, install_url: 'https://github.com/apps/curia-box/installations/new' }],
    manual_url: 'https://github.com/settings/apps/new',
    ...over,
  })

  test('the unconnected GitHub card offers Create GitHub App with the remembered name, and no field for a credential', () => {
    page.setup = SETUP({ progress: { github: { app_name: 'curia-alp' } }, cards: { github: { state: 'unconnected', badge: 'Ready to connect' } } })
    const p = payload()
    p.overview.github_app = APP({ configured: false, status: 'unconfigured', app: null, owners: [] })
    const html = page.screenSetup(p)
    assert.match(html, /id="setup-github-app-name" value="curia-alp"/)
    assert.match(html, /onclick="doSetupGitHubApp\(\)">Create GitHub App</)
    assert.doesNotMatch(html, /type="password"|private key|client secret/i)
    assert.match(text(html), /Curia never sees your password or browser session/)
    assert.doesNotMatch(html, /Try again/)
  })

  test('Create GitHub App remembers the name as safe progress, then starts the manifest handoff from the Setup screen', async () => {
    page.setup = SETUP({ cards: { github: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.payload = payload()
    page.document.getElementById = (id) => (id === 'setup-github-app-name' ? { value: 'curia-alp' } : null)
    vm.runInContext('doSetupGitHubApp()', page)
    await new Promise((resolve) => setImmediate(resolve))
    const remembered = calls.find((c) => c.url === '/api/setup' && c.method === 'POST')
    assert.deepEqual(remembered.body, { progress: { github: { app_name: 'curia-alp' } } })
    const started = calls.find((c) => c.url === '/api/github-app/start')
    assert.equal(started.body.name, 'curia-alp')
    assert.equal(started.body.screen, 'setup')
    assert.equal(page.setup.progress.github.app_name, 'curia-alp')
  })

  // The rehearsal of the packaged lifecycle (#891) pressed Create GitHub App
  // on a root installation and GitHub answered that "url" wasn't supplied.
  // This is the whole trip in one place: the daemon's real manifest for the
  // served address, the page's form, and what GitHub receives.
  test('the manifest the Setup screen posts to GitHub carries the served origin as url, the redirect under it, and every URL GitHub requires', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-page-manifest-'))
    const daemon = new GitHubAppSetup({
      daemonRoot: dir, stateFile: path.join(dir, 'setup.json'), envFile: path.join(dir, '.env.daemon'), keyFile: path.join(dir, 'key.pem'),
    })
    const origin = 'https://curia-ubuntu.tail3b99f1.ts.net:8445'
    const submitted = []
    page = loadPage({
      fetchImpl: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null
        if (url === '/api/github-app/start') {
          const setup = daemon.start({ name: body.name, redirectUrl: `${origin}/api/github-app/complete`, actionId: body.action_id, screen: body.screen })
          return { ok: true, json: async () => ({ action: { action_id: body.action_id, status: 'accepted' }, setup }) }
        }
        return { ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP()) }
      },
    })
    page.UI.screen = 'setup'
    page.setup = SETUP({ cards: { github: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.payload = payload()
    page.document.getElementById = (id) => (id === 'setup-github-app-name' ? { value: 'curia-alp' } : null)
    page.document.createElement = (tag) => {
      const element = { tag, children: [], appendChild(child) { this.children.push(child) } }
      if (tag === 'form') element.submit = () => submitted.push(element)
      return element
    }
    page.document.body = { appendChild() {} }
    vm.runInContext('doSetupGitHubApp()', page)
    await new Promise((resolve) => setImmediate(resolve))
    fs.rmSync(dir, { recursive: true, force: true })

    assert.equal(submitted.length, 1, 'one form reached GitHub')
    const [form] = submitted
    assert.equal(form.method, 'POST')
    assert.match(form.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=[0-9a-f]{64}$/)
    const field = form.children.find((c) => c.name === 'manifest')
    assert.ok(field, 'the manifest rides the one form field GitHub reads')
    const manifest = JSON.parse(field.value)
    assert.equal(manifest.url, origin, 'the served origin, non-empty')
    assert.equal(manifest.redirect_url, `${origin}/api/github-app/complete`)
    assert.equal(manifest.name, 'curia-alp')
    // GitHub demands `hook_attributes.url` whenever the object is present,
    // active or not. Curia listens for no webhook, so the block is absent.
    assert.equal('hook_attributes' in manifest, false)
  })

  test('a failed GitHub card names the failed verification and draws the install link per watched owner', () => {
    page.setup = SETUP({ cards: { github: {
      state: 'failed', badge: 'Action required',
      error: { failed: "curia's GitHub App is not installed on alp82", action: 'Install the App on alp82 from the link in this panel and grant it alp82/curia, then try again.' },
      detail: { owners: [{ owner: 'alp82', installed: false }], covered: [] },
    } } })
    const p = payload()
    p.overview.github_app = APP()
    const html = page.screenSetup(p)
    assert.match(html, /href="https:\/\/github.com\/apps\/curia-box\/installations\/new"[^>]*>Install on alp82</)
    assert.match(text(html), /curia's GitHub App is not installed on alp82/)
    assert.match(html, /onclick="retrySetup\(\)"/)
    assert.doesNotMatch(html, /doSetupGitHubApp/)
    assert.match(html, /href="https:\/\/github.com\/settings\/apps\/curia-box"/)
  })

  test('a connected GitHub card draws the real discovered ticket as a link, and the zero-ticket state names the repository', () => {
    const p = payload()
    p.overview.github_app = APP({ owners: [{ owner: 'alp82', installed: true, installation_id: 7, install_url: 'https://github.com/apps/curia-box/installations/new/permissions?target_id=1001' }] })
    page.setup = SETUP({ cards: { github: {
      ...connected('#861 · Chart backup', 'ready-for-agent · alp82/curia · 9 open tickets', '🎫'),
      detail: { owners: [{ owner: 'alp82', installed: true }], covered: ['alp82/curia'], open_tickets: 9, ticket: { repo: 'alp82/curia', number: 861, title: 'Chart backup', url: 'https://github.com/alp82/curia/issues/861' } },
    } } })
    let html = page.screenSetup(p)
    assert.match(html, /href="https:\/\/github.com\/alp82\/curia\/issues\/861"[^>]*>#861 · Chart backup</)
    assert.match(html, />Manage installation</)
    assert.match(html, /Continue setup/)
    page.setup = SETUP({ cards: { github: {
      ...ALL.github,
      detail: { owners: [{ owner: 'alp82', installed: true }], covered: ['alp82/curia'], open_tickets: 0, ticket: null },
    } } })
    html = page.screenSetup(p)
    assert.match(text(html), /No open ticket is ready for an agent in alp82\/curia/)
    assert.doesNotMatch(html, /issues\/861/)
  })

  // The GitHub card after the rehearsal (#891). The owner rows are this
  // read's fact, the failure banner is this read's alone, and a fresh
  // installation chooses its watched repositories on the card.
  const GITHUB_DETAIL = (over = {}) => ({
    owners: [], covered: [], watched: [], available: [], install_url: 'https://github.com/apps/curia-box/installations/new', ...over,
  })

  test('the owner rows draw this read\'s installations, never the held overview\'s, so an installed owner is never drawn as missing beside its own verification', () => {
    page.setup = SETUP({ cards: { github: {
      state: 'failed', badge: 'Action required',
      error: { failed: "The App installation on alp82 doesn't cover alp82/curia", action: 'Grant the App access to alp82/curia on the alp82 installation on GitHub, then try again.' },
      detail: GITHUB_DETAIL({ owners: [{ owner: 'getalfredo', installed: false }, { owner: 'alp82', installed: true }], watched: ['getalfredo/landing-page', 'alp82/curia'] }),
    } } })
    const p = payload()
    // The overview's own read is older: it has not seen the alp82 installation.
    p.overview.github_app = APP({ owners: [
      { owner: 'getalfredo', installed: true, install_url: 'https://github.com/apps/curia-box/installations/new/permissions?target_id=2002' },
      { owner: 'alp82', installed: null, install_url: 'https://github.com/apps/curia-box/installations/new' },
    ] })
    const html = page.screenSetup(p)
    assert.match(html, /getalfredo<\/span>\s*<span>missing access</)
    assert.match(html, /alp82<\/span>\s*<span>installed</)
    assert.match(html, />Manage installation</)
    assert.match(html, /href="https:\/\/github.com\/apps\/curia-box\/installations\/new\/permissions\?target_id=2002"[^>]*>Install on getalfredo</, 'the overview lends the install link')
    assert.doesNotMatch(text(html), /unknown \(not read yet\)/)
  })

  test('a fresh read that connects the card clears the previous read\'s failure from the panel and the rail', async () => {
    page.setup = SETUP({ cards: { github: {
      state: 'failed', badge: 'Action required',
      error: { failed: "curia's GitHub App is not installed on alp82", action: 'Install the App on alp82 from the link in this panel and grant it alp82/curia, then try again.' },
      detail: GITHUB_DETAIL({ owners: [{ owner: 'alp82', installed: false }], watched: ['alp82/curia'] }),
    } } })
    page.UI.act.said = { key: 'github-setup:watch', text: 'the sidecar answered 500', ok: false }
    const p = payload()
    p.overview.github_app = APP()
    assert.match(text(page.screenSetup(p)), /not installed on alp82/)
    page.fetch = async (url, init = {}) => ({ ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP({ cards: { github: {
      ...ALL.github,
      detail: GITHUB_DETAIL({ owners: [{ owner: 'alp82', installed: true }], covered: ['alp82/curia'], watched: ['alp82/curia'], available: ['alp82/curia'], open_tickets: 0, ticket: null }),
    } } })) })
    await page.retrySetup()
    const html = page.screenSetup(p)
    assert.doesNotMatch(html, /setup-problem/)
    assert.doesNotMatch(text(html), /not installed on alp82/)
    assert.doesNotMatch(html, /⚠️/)
    assert.doesNotMatch(html, /class="said bad"/, 'a stale write refusal is not this read\'s result either')
    assert.match(html, /class="setup-card github connected/)
  })

  test('with no watched repository the panel lists what the installations cover, every repository ticked, and one press watches them', async () => {
    page.setup = SETUP({ cards: { github: {
      state: 'failed', badge: 'Action required',
      error: { failed: 'No repository is on the watch list, so there is nothing for the App installation to cover', action: 'Choose the repositories Curia watches in this panel, then select Watch these repositories.' },
      detail: GITHUB_DETAIL({ available: ['alp82/curia', 'alp82/aistack', 'getalfredo/landing-page'] }),
    } } })
    const p = payload()
    p.overview.github_app = APP({ owners: [] })
    const html = page.screenSetup(p)
    assert.match(html, /id="setup-github-repo-0" value="alp82\/curia" checked/)
    assert.match(html, /id="setup-github-repo-1" value="alp82\/aistack" checked/)
    assert.match(html, /id="setup-github-repo-2" value="getalfredo\/landing-page" checked/)
    assert.match(html, /onclick="doSetupGitHubWatch\(\)">Watch these repositories</)
    assert.doesNotMatch(text(html), /Add one under Settings/)
    page.document.getElementById = (id) => ({ 'setup-github-repo-0': { checked: true }, 'setup-github-repo-1': { checked: false }, 'setup-github-repo-2': { checked: true } })[id] ?? null
    calls = []
    await page.doSetupGitHubWatch()
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['POST', '/api/setup/github/watch'], ['GET', '/api/setup']])
    assert.deepEqual(calls[0].body, { repos: ['alp82/curia', 'getalfredo/landing-page'] })
  })

  test('with no installation at all the panel offers the App\'s own install link, and no repository to tick', () => {
    page.setup = SETUP({ cards: { github: {
      state: 'failed', badge: 'Action required',
      error: { failed: "curia's GitHub App is not installed on any account, so there is no repository to watch yet", action: 'Install the App on the account that owns your repositories from the link in this panel, then try again.' },
      detail: GITHUB_DETAIL(),
    } } })
    const p = payload()
    p.overview.github_app = APP({ owners: [] })
    const html = page.screenSetup(p)
    assert.match(html, /href="https:\/\/github.com\/apps\/curia-box\/installations\/new"[^>]*>Install the App on GitHub</)
    assert.doesNotMatch(html, /doSetupGitHubWatch/)
    assert.doesNotMatch(text(html), /Add one under Settings/)
  })

  test('a connected card keeps the choice behind a fold, with the watched repositories ticked and the rest not, and a refused write says the sentence', async () => {
    page.setup = SETUP({ cards: { github: {
      ...ALL.github,
      detail: GITHUB_DETAIL({ owners: [{ owner: 'alp82', installed: true }], covered: ['alp82/curia'], watched: ['alp82/curia', 'other/uncovered'], available: ['alp82/curia', 'alp82/aistack'], open_tickets: 0, ticket: null }),
    } } })
    const p = payload()
    p.overview.github_app = APP({ owners: [{ owner: 'alp82', installed: true, installation_id: 7, install_url: 'https://github.com/apps/curia-box/installations/new/permissions?target_id=1001' }] })
    const html = page.screenSetup(p)
    assert.match(html, /<summary>Change the watched repositories<\/summary>/)
    assert.match(html, /id="setup-github-repo-0" value="alp82\/curia" checked/)
    assert.match(html, /id="setup-github-repo-1" value="alp82\/aistack"(?! checked)/)
    assert.match(html, /id="setup-github-repo-2" value="other\/uncovered" checked/, 'a watched repository no installation covers stays on the list')
    assert.match(text(html), /other\/uncovered.*not covered by an installation/)
    page.document.getElementById = (id) => ({ 'setup-github-repo-0': { checked: true }, 'setup-github-repo-1': { checked: true }, 'setup-github-repo-2': { checked: false } })[id] ?? null
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/github/watch') return { ok: false, status: 409, json: async () => ({ error: 'alp82/curia cannot leave the watch list while curia-7 runs on it' }) }
      return { ok: true, json: async () => SETUP() }
    }
    calls = []
    await page.doSetupGitHubWatch()
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['POST', '/api/setup/github/watch']], 'a refused write takes no fresh read')
    assert.deepEqual(calls[0].body, { repos: ['alp82/curia', 'alp82/aistack'] })
    assert.match(text(page.screenSetup(p)), /cannot leave the watch list while curia-7 runs on it/)
  })

  // The Discord card (#876). Before the token exists the panel guides the
  // operator to the application and the bot and offers the one form, the
  // token and the user ID. The token is read off its field, sent once, and
  // the field is cleared before the answer arrives; nothing on the page
  // holds it. After, the panel draws the bot, the invite link, the servers
  // the service read, and the channel name; connected, it draws the channel,
  // the delivered confirmation, and the registered commands from this read.
  const DISCORD_OVERVIEW = (over = {}) => ({
    secret: 'present', source: 'file', file: '/root/secrets/discord-bot-token',
    bot: { id: '222222222222222222', username: 'curia-box' },
    guilds: [{ id: '333333333333333333', name: "Alp's workshop" }, { id: '999999999999999999', name: 'Testing' }],
    invite_url: 'https://discord.com/oauth2/authorize?client_id=555555555555555555&scope=bot%20applications.commands&permissions=1',
    settings: { allowed_users: ['111111111111111111'], guild_id: null, channel: 'curia' }, error: null, ...over,
  })
  const DISCORD_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.this-token-must-never-be-shown-anywhere-1234'

  test('the unconnected Discord card guides the operator to the bot and offers the token and the user ID, once, as a password field', () => {
    page.setup = SETUP({ step: 'discord', cards: { discord: { state: 'unconnected', badge: 'Ready to connect' } } })
    const html = page.screenSetup(payload())
    assert.match(html, /href="https:\/\/discord\.com\/developers\/applications"/)
    assert.match(text(html), /Message Content Intent/)
    assert.match(html, /<input id="setup-discord-token" type="password"/)
    assert.match(html, /id="setup-discord-user"/)
    assert.match(html, /onclick="doSetupDiscordToken\(\)">Connect bot</)
    assert.match(text(html), /Curia never shows it again/)
    assert.doesNotMatch(html, /setup-discord-guild/, 'no server to pick before the token exists')
  })

  test('Connect bot sends the token and the ID once, clears the field before the answer, and keeps no copy on the page', async () => {
    page.setup = SETUP({ step: 'discord', cards: { discord: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.payload = payload()
    const fields = { 'setup-discord-token': { value: DISCORD_TOKEN }, 'setup-discord-user': { value: '111111111111111111' } }
    page.document.getElementById = (id) => fields[id] ?? null
    let cleared = null
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/discord/token') cleared = fields['setup-discord-token'].value
      return { ok: true, json: async () => ({ ok: true, ...DISCORD_OVERVIEW() }) }
    }
    vm.runInContext('doSetupDiscordToken()', page)
    await new Promise((resolve) => setImmediate(resolve))
    const sent = calls.find((c) => c.url === '/api/setup/discord/token')
    assert.deepEqual(sent.body, { token: DISCORD_TOKEN, user_id: '111111111111111111' })
    assert.equal(cleared, '', 'the field is empty before the answer comes back')
    assert.equal(page.UI.setup.discord.secret, 'present')
    assert.ok(!JSON.stringify(page.UI.setup).includes(DISCORD_TOKEN))
    assert.ok(!JSON.stringify(page.setup).includes(DISCORD_TOKEN))
    assert.equal(page.localStorage.getItem('setup'), null)
    const html = page.screenSetup(payload())
    assert.ok(!html.includes(DISCORD_TOKEN), 'the token is not drawn back')
    assert.match(html, /id="setup-discord-guild"/, 'the server list is the next form')
  })

  test('with the token on disk the panel draws the bot, the invite link, the servers, and the remembered channel, and the token form is behind a fold', () => {
    page.setup = SETUP({ step: 'discord', progress: { discord: { guild_id: '999999999999999999', channel: 'ops' } }, cards: { discord: {
      state: 'failed', badge: 'Action required',
      error: { failed: "curia-box isn't in the selected server", action: 'Select a server the bot is in, then try again.' },
      detail: { stage: 'server', guilds: [{ id: '999999999999999999', name: 'Testing' }] },
    } } })
    page.UI.setup.discord = DISCORD_OVERVIEW()
    const html = page.screenSetup(payload())
    assert.match(text(html), /curia-box/)
    assert.match(html, /href="https:\/\/discord\.com\/oauth2\/authorize\?client_id=555555555555555555[^"]*"[^>]*>Add the bot to a server</)
    assert.match(html, /<option value="999999999999999999" selected>Testing<\/option>/)
    assert.match(html, /id="setup-discord-channel" type="text" value="ops"/)
    assert.match(html, /onclick="doSetupDiscordChannel\(\)">Connect channel</)
    assert.match(html, /<details><summary>Replace the bot token<\/summary>/)
    assert.match(html, /onclick="retrySetup\(\)">Try again</)
  })

  // The wait for a server (#891). The first packaged rehearsal found the
  // panel drawing an empty server select and a prefilled channel field the
  // moment the token was accepted, and never noticing the invite on its
  // own. Now, until the bot is in a server, the panel is the invite link and
  // a wait that re-reads on the Setup page's refresh interval; the select
  // and the channel field appear only once a server is there, and nothing
  // is created before Connect channel.
  test('with the token accepted and the bot in no server, the panel waits with the invite link and offers neither a server select nor a channel field', () => {
    page.setup = SETUP({ step: 'discord', cards: { discord: {
      state: 'failed', badge: 'Action required',
      error: { failed: 'curia-box is in no server', action: 'Add the bot to your server with the invite link in this panel, then try again.' },
      detail: { stage: 'server', guilds: [], invite_url: 'https://discord.com/oauth2/authorize?client_id=555555555555555555&scope=bot%20applications.commands&permissions=1' },
    } } })
    page.UI.setup.discord = DISCORD_OVERVIEW({ guilds: [] })
    page.payload = payload()
    const html = page.screenSetup(page.payload)
    assert.match(html, /href="https:\/\/discord\.com\/oauth2\/authorize\?client_id=555555555555555555[^"]*"[^>]*>Add the bot to a server</)
    assert.match(text(html), /Waiting for the bot to join a server/)
    assert.match(text(html), /checks again every 5 seconds/)
    assert.doesNotMatch(html, /setup-discord-guild/, 'no server select before the bot is in one')
    assert.doesNotMatch(html, /setup-discord-channel/, 'no channel field before the bot is in one')
    assert.doesNotMatch(html, /Connect channel/)
  })

  test('while it waits the panel re-reads on the refresh interval, and the server select and the channel field appear on their own once the bot joined, with no press', async () => {
    page.setup = SETUP({ step: 'discord', cards: { discord: {
      state: 'failed', badge: 'Action required',
      error: { failed: 'curia-box is in no server', action: 'Add the bot to your server with the invite link in this panel, then try again.' },
      detail: { stage: 'server', guilds: [] },
    } } })
    page.payload = payload()
    const timers = []
    page.setTimeout = (callback, ms) => { timers.push({ callback, ms }); return timers.length }
    page.clearTimeout = () => {}
    let joined = false
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/discord') return { ok: true, json: async () => DISCORD_OVERVIEW(joined ? {} : { guilds: [] }) }
      return { ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP({ step: 'discord', cards: { discord: {
        state: 'failed', badge: 'Action required', error: { failed: 'No server is selected for curia-box', action: 'Select the server and the channel name in this panel, then select Connect channel.' }, detail: { stage: 'server', guilds: DISCORD_OVERVIEW().guilds },
      } } })) }
    }
    await page.loadDiscordSetup()
    assert.equal(calls.filter((c) => c.url === '/api/setup/discord').length, 1)
    assert.equal(timers.length, 1, 'one wait is armed')
    assert.equal(timers[0].ms, 5000, 'on the page\'s own refresh interval')
    let html = page.screenSetup(page.payload)
    assert.doesNotMatch(html, /setup-discord-guild/)
    await timers[0].callback()
    assert.equal(calls.filter((c) => c.url === '/api/setup/discord').length, 2, 'the wait re-reads')
    assert.equal(timers.length, 2, 'and arms the next wait while the bot is still in no server')
    joined = true
    await timers[1].callback()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.filter((c) => c.url === '/api/setup/discord').length, 3)
    assert.equal(timers.length, 2, 'the wait ends once a server is there')
    assert.ok(calls.some((c) => c.url === '/api/setup' && c.method === 'GET'), 'the card verifies fresh once the bot joined')
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing is written and nothing is created by the wait')
    html = page.screenSetup(page.payload)
    assert.match(html, /<option value="333333333333333333" selected>Alp's workshop<\/option>/)
    assert.match(html, /id="setup-discord-channel" type="text" value="curia"/, 'the default name, editable')
    assert.match(html, /onclick="doSetupDiscordChannel\(\)">Connect channel</)
  })

  test('Connect bot with a bot in no server starts the wait at once', async () => {
    page.setup = SETUP({ step: 'discord', cards: { discord: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.payload = payload()
    const timers = []
    page.setTimeout = (callback, ms) => { timers.push({ callback, ms }); return timers.length }
    page.clearTimeout = () => {}
    page.document.getElementById = (id) => ({ 'setup-discord-token': { value: DISCORD_TOKEN }, 'setup-discord-user': { value: '111111111111111111' } })[id] ?? null
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/discord/token') return { ok: true, json: async () => ({ ok: true, ...DISCORD_OVERVIEW({ guilds: [] }) }) }
      return { ok: true, json: async () => DISCORD_OVERVIEW({ guilds: [] }) }
    }
    await page.doSetupDiscordToken()
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 5000)
    const html = page.screenSetup(page.payload)
    assert.match(text(html), /Waiting for the bot to join a server/)
    assert.doesNotMatch(html, /setup-discord-channel/)
  })

  test('a token Discord refused puts the token form first, with the user ID it kept', () => {
    page.setup = SETUP({ step: 'discord', cards: { discord: {
      state: 'failed', badge: 'Action required',
      error: { failed: 'Discord refused the bot token', action: 'Reset the token on the Bot page of your Discord application and submit the new one in this panel.' },
      detail: { stage: 'token' },
    } } })
    page.UI.setup.discord = DISCORD_OVERVIEW({ bot: null, guilds: [], invite_url: null, error: 'Discord refused the bot token' })
    const html = page.screenSetup(payload())
    assert.match(html, /<input id="setup-discord-token" type="password"/)
    assert.match(html, /id="setup-discord-user" type="text" value="111111111111111111"/)
    assert.doesNotMatch(html, /<summary>Replace the bot token/)
  })

  test('selecting the Discord card takes the panel\'s own read once, and Connect channel remembers the choice, writes it, then verifies fresh', async () => {
    page.setup = SETUP({ cards: { discord: { state: 'failed', badge: 'Action required', error: { failed: 'No server is selected', action: 'Select one.' }, detail: { stage: 'server', guilds: [] } } } })
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/discord') return { ok: true, json: async () => DISCORD_OVERVIEW() }
      if (url === '/api/setup/discord/channel') return { ok: true, json: async () => ({ ok: true, card: { key: 'discord', state: 'connected' } }) }
      return { ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP()) }
    }
    await page.selectSetupCard('discord')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.filter((c) => c.url === '/api/setup/discord').length, 1)
    assert.equal(page.UI.setup.discord.bot.username, 'curia-box')
    page.document.getElementById = (id) => ({ 'setup-discord-guild': { value: '333333333333333333' }, 'setup-discord-channel': { value: 'ops' } })[id] ?? null
    calls = []
    await page.doSetupDiscordChannel()
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['POST', '/api/setup'], ['POST', '/api/setup/discord/channel'], ['GET', '/api/setup']])
    assert.deepEqual(calls[0].body, { progress: { discord: { guild_id: '333333333333333333', channel: 'ops' } } })
    assert.deepEqual(calls[1].body, { guild_id: '333333333333333333', channel: 'ops' })
  })

  test('a connected Discord card draws the channel, the delivered confirmation, the operator, and the commands, and says whether the bridge runs', () => {
    page.setup = SETUP({ step: 'discord', cards: { discord: {
      ...ALL.discord,
      detail: {
        guild: { id: '333333333333333333', name: "Alp's workshop" },
        channel: { id: '444444444444444444', name: 'curia', created: true, url: 'https://discord.com/channels/333333333333333333/444444444444444444' },
        operator: { id: '111111111111111111', username: 'alp', name: 'Alp' },
        commands: ['tickets', 'next', 'status'],
        confirmation: { id: '777', at: new Date().toISOString(), posted: true, url: 'https://discord.com/channels/333333333333333333/444444444444444444/777' },
        bridge: null,
      },
    } } })
    const html = page.screenSetup(payload())
    assert.match(html, /href="https:\/\/discord\.com\/channels\/333333333333333333\/444444444444444444"[^>]*>#curia</)
    assert.match(text(html), /created by Curia/)
    assert.match(html, /href="https:\/\/discord\.com\/channels\/333333333333333333\/444444444444444444\/777"[^>]*>Posted /)
    assert.match(html, /<code>\/tickets<\/code> <code>\/next<\/code> <code>\/status<\/code>/)
    assert.match(text(html), /Alp 111111111111111111/)
    assert.match(html, /onclick="doSetupRestart\(\);return false">Restart Curia</)
    assert.match(html, /<div class="setup-secondary">Confirmation delivered · 6 commands registered<\/div>/)
    assert.doesNotMatch(html, /type="password"/, 'no token form on a connected card')
    assert.match(html, /Continue setup/)
  })

  test('arriving at Setup takes its own read, and the read is a fresh verification every time', async () => {
    page.enter('setup')
    page.enter('setup')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/setup'], ['GET', '/api/setup']])
  })

  // The Tailscale card (#877; the machine-name field dropped after #891).
  // Before an operator is recorded the panel names the identity Serve
  // stamped on the request that opened the app and the node, with its name
  // as the tailnet's fact, and the one press is the confirmation, which
  // sends no field at all. Connected, it draws the private address, the
  // operator, the node, the Serve route, and the timed admission from this
  // read.
  const TAILSCALE_OVERVIEW = (over = {}) => ({
    root: true, requester: 'alp@example.com', operator: null, machine_name: 'alp-workstation', first_operator: true,
    node: { installed: true, error: null, backend_state: 'Running', online: true, dns_name: 'alp-workstation.tail1234.ts.net', cert_domains: ['alp-workstation.tail1234.ts.net'], ips: ['100.98.118.33'], version: '1.98.10' },
    serve: { routes: [], error: null, route: { https: 8445, target: 'http://127.0.0.1:4273' }, recorded: [] },
    app_url: 'https://alp-workstation.tail1234.ts.net:8445/', last_seen: null, error: null, ...over,
  })

  test('the unconnected Tailscale card names the identity that opened the app and the node with its name as facts, and the one press confirms', () => {
    page.setup = SETUP({ step: 'tailscale', cards: { tailscale: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.UI.setup.tailscale = TAILSCALE_OVERVIEW()
    const html = page.screenSetup(payload())
    assert.match(text(html), /You opened Curia as alp@example\.com through Tailscale\. Confirm to make this identity the allowed operator\. Until then, nobody is\./)
    assert.match(text(html), /alp-workstation\.tail1234\.ts\.net · online · 100\.98\.118\.33/)
    assert.doesNotMatch(html, /<input/, 'there is no field: the node was named at installation, and the card does not edit it (#891)')
    assert.doesNotMatch(html, /<select/)
    assert.doesNotMatch(html, /setup-tailscale-name|Renamed|renamed/)
    assert.match(html, /onclick="doSetupTailscaleOperator\(\)">Confirm operator and verify</)
    assert.match(text(html), /This node is named alp-workstation on the tailnet\. The name was chosen at installation with --name ?\. To change it, reinstall with another --name ?, or run sudo tailscale set --hostname &lt;name&gt; on the host and then Restart Curia ?\./)
    assert.match(html, /<a href="#" onclick="doRestart\(\);return false">Restart Curia<\/a>/)
    assert.match(text(html), /Curia never installs or reconfigures Tailscale/)
    assert.doesNotMatch(html, /type="password"/)
    assert.doesNotMatch(html, /Try again/)
  })

  test('a request without a Tailscale identity cannot confirm: the panel says so and the press is disabled', () => {
    page.setup = SETUP({ step: 'tailscale', cards: { tailscale: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.UI.setup.tailscale = TAILSCALE_OVERVIEW({ requester: null })
    const html = page.screenSetup(payload())
    assert.match(text(html), /This request carried no Tailscale identity/)
    assert.match(html, /<button class="btn primary" disabled onclick="doSetupTailscaleOperator\(\)"/)
  })

  test('selecting the Tailscale card takes the panel\'s own read once, and the confirmation sends no field at all, then verifies fresh', async () => {
    page.setup = SETUP({ cards: { tailscale: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/tailscale') return { ok: true, json: async () => TAILSCALE_OVERVIEW() }
      if (url === '/api/setup/tailscale/operator') return { ok: true, json: async () => ({ ok: true, card: { key: 'tailscale', state: 'connected' } }) }
      return { ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP()) }
    }
    await page.selectSetupCard('tailscale')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.filter((c) => c.url === '/api/setup/tailscale').length, 1)
    assert.equal(page.UI.setup.tailscale.requester, 'alp@example.com')
    calls = []
    await page.doSetupTailscaleOperator()
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['POST', '/api/setup/tailscale/operator'], ['GET', '/api/setup']])
    assert.deepEqual(calls[0].body, {}, 'neither a login nor a machine name is a field the page sends')
  })

  test('a failed Tailscale card names the failure and the action, and keeps the confirmation so the operator can confirm again', () => {
    page.setup = SETUP({ step: 'tailscale', cards: { tailscale: {
      state: 'failed', badge: 'Action required',
      error: { failed: 'The tailnet issues no HTTPS certificate for this node, so Serve can\'t publish the Curia app', action: 'Enable HTTPS certificates under DNS in the Tailscale admin console at https://login.tailscale.com/admin/dns, then try again.' },
      detail: { stage: 'certificate', operator: { login: 'alp@example.com', confirmed_at: '2026-09-02T10:00:00.000Z' }, node: { installed: true, online: true, backend_state: 'Running', dns_name: 'alp-workstation.tail1234.ts.net', ips: ['100.98.118.33'] } },
    } } })
    page.UI.setup.tailscale = TAILSCALE_OVERVIEW({ operator: { login: 'alp@example.com', confirmed_at: '2026-09-02T10:00:00.000Z' }, first_operator: false })
    const html = page.screenSetup(payload())
    assert.match(html, /class="setup-card tailscale failed on"/)
    assert.match(text(html), /The tailnet issues no HTTPS certificate for this node/)
    assert.doesNotMatch(html, /<input/)
    assert.match(html, /onclick="doSetupTailscaleOperator\(\)">Confirm again and verify</)
    assert.match(html, /onclick="retrySetup\(\)">Try again</)
  })

  test('a connected Tailscale card draws the private address, the operator, the node, the Serve route, and the timed admission', () => {
    page.setup = SETUP({ step: 'tailscale', cards: { tailscale: {
      ...ALL.tailscale,
      detail: {
        operator: { login: 'alp@example.com', confirmed_at: new Date(Date.now() - 60_000).toISOString(), last_seen_at: new Date().toISOString() },
        node: { installed: true, online: true, backend_state: 'Running', dns_name: 'curia-sh.tail1234.ts.net', ips: ['100.98.118.33'], version: '1.98.10' },
        address: 'curia-sh.tail1234.ts.net', app_url: 'https://curia-sh.tail1234.ts.net:8445/',
        machine_name: 'curia-sh',
        serve: { url: 'https://curia-sh.tail1234.ts.net:8445/', route: { https: 8445, target: 'http://127.0.0.1:4273' }, created: true, error: null },
        app: { status: 200, ms: 38, error: null }, verified_at: new Date().toISOString(),
      },
    } } })
    const html = page.screenSetup(payload())
    assert.match(html, /href="https:\/\/curia-sh\.tail1234\.ts\.net:8445\/"[^>]*>https:\/\/curia-sh\.tail1234\.ts\.net:8445\/</)
    assert.match(text(html), /Operator alp@example\.com confirmed/)
    assert.match(text(html), /curia-sh\.tail1234\.ts\.net · online · 100\.98\.118\.33 · Tailscale 1\.98\.10/)
    assert.match(text(html), /:8445 → http:\/\/127\.0\.0\.1:4273 · created by Curia/)
    assert.match(text(html), /Admitted alp@example\.com in 38 ms · Arrived through Tailscale/)
    assert.doesNotMatch(html, /Change the machine name/, 'the name is the tailnet\'s fact; nothing here changes it')
    assert.match(html, /Continue setup/)
    assert.doesNotMatch(html, /Try again/)
  })

  // The model-provider card, OpenAI half (#878). One card, two provider rows,
  // so #879 adds Anthropic beside OpenAI without restructuring. The OpenAI
  // row offers the one press, the subscription sign-in curia already runs,
  // and never a key field; while the login waits the panel draws the link
  // and the code the service scraped; connected, it draws the safe facts.
  const OPENAI_OVERVIEW = (over = {}) => ({
    provider: 'openai', root: true, secret: { state: 'absent' }, identity: null, login: null, ending: null, said: null,
    routing: { ready: false, model: 'gpt', rows: [{ type: 'untyped', model: 'opus', provider: 'anthropic', active: true, credentialed: false, ok: false }], missing: ['untyped'], credentialed: [] },
    error: null, ...over,
  })
  const providers = (openai, anthropic = { title: 'Anthropic', state: 'unconnected' }) => ({ openai: { title: 'OpenAI', ...openai }, anthropic: { title: 'Anthropic', ...anthropic } })
  const WAITING = { provider: 'openai', session: 'curia-auth-openai', state: 'waiting', url: 'https://auth.openai.com/codex/device', code: '83CC-A4ZTO', typed: false, terminal_url: 'https://box.tail1234.ts.net:8446/?arg=curia-auth-openai', seconds_left: 840, expires_at: '2026-09-02T10:30:00.000Z' }
  // The Anthropic row (#879): the same shape, the typed lane.
  const ANTHROPIC_OVERVIEW = (over = {}) => ({
    provider: 'anthropic', root: true, secret: { state: 'absent' }, credential: null, login: null, ending: null, said: null,
    routing: { ready: false, model: 'fable', rows: [{ type: 'research', model: 'gpt', provider: 'openai', active: true, credentialed: false, ok: false }], missing: ['research'], credentialed: [] },
    error: null, ...over,
  })
  const ANTHROPIC_WAITING = { provider: 'anthropic', session: 'curia-auth-anthropic', state: 'waiting', url: 'https://claude.com/cai/oauth/authorize?code_challenge=abc&state=xyz', code: null, typed: true, terminal_url: 'https://box.tail1234.ts.net:8446/?arg=curia-auth-anthropic', seconds_left: 1700, expires_at: '2026-09-02T10:30:00.000Z' }

  test('the unconnected model card offers one subscription sign-in per provider row, OpenAI and Anthropic, and has no key field', () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    page.UI.setup.openai = OPENAI_OVERVIEW()
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW()
    const html = page.screenSetup(payload())
    assert.match(text(html), /OpenAI Ready to connect/)
    assert.match(html, /onclick="doSetupOpenAILogin\(\)">Sign in to OpenAI</)
    assert.match(text(html), /Anthropic Ready to connect/)
    assert.match(html, /onclick="doSetupAnthropicLogin\(\)">Sign in to Anthropic</)
    assert.match(text(html), /Subscription sign-in only\. Curia holds no API key, and this panel offers no field for one\./)
    assert.doesNotMatch(html, /type="password"|api[_ -]?key" /i)
    assert.doesNotMatch(html, /Try again/)
  })

  // The rehearsal (#891) found the Discord fields clearing themselves: the
  // poll re-renders the whole page every few seconds, and the setup forms are
  // not backed by a draft, so a value typed but not yet sent was lost with the
  // elements that held it. What has to survive the render is what the
  // operator typed and where the cursor was, on every setup field.
  test('a poll render keeps what the operator typed into the setup fields, and the cursor, until the press sends it', () => {
    page.setup = SETUP({ step: 'discord', cards: { discord: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.UI.setup.discord = { secret: 'absent', settings: null }
    page.payload = payload()
    const field = (id, defaultValue, value = defaultValue) => {
      const el = { id, value, defaultValue, tagName: 'INPUT', selectionStart: value.length, focused: 0, range: null }
      el.focus = () => { el.focused += 1 }
      el.setSelectionRange = (a, b) => { el.range = [a, b] }
      return el
    }
    // The elements before the render, with the operator's typing in them.
    const typedToken = field('setup-discord-token', '', 'MTIz.abc.def')
    const typedUser = field('setup-discord-user', '', '123456789')
    typedUser.selectionStart = 4
    // The elements the render writes, drawn from the page's own state: empty.
    const freshToken = field('setup-discord-token', '')
    const freshUser = field('setup-discord-user', '')
    let drawn = null
    let live = [typedToken, typedUser]
    let asked = null
    const app = {
      set innerHTML(value) { drawn = value; live = [freshToken, freshUser] },
      querySelectorAll: (selector) => { asked = selector; return live },
    }
    page.document.activeElement = typedUser
    page.document.getElementById = (id) => (id === 'app' ? app : live.find((el) => el.id === id) ?? null)
    page.render()
    assert.match(drawn, /id="setup-discord-token"/)
    assert.equal(freshToken.value, 'MTIz.abc.def', 'the token typed but not sent survives the render')
    assert.equal(freshUser.value, '123456789', 'the user ID typed but not sent survives the render')
    assert.equal(freshUser.focused, 1, 'focus comes back to the field the operator was in')
    assert.deepEqual(freshUser.range, [4, 4], 'and the cursor stays where it was')
    assert.equal(freshToken.focused, 0)
    // The carry-over is for the draftless forms. The chat box is drawn from
    // its draft and a send clears the draft, so it is not asked for.
    assert.match(asked, /\[id\^="setup-"\]/)
    assert.doesNotMatch(asked, /chat-box|textarea\[id\]/)
  })

  test('a poll render keeps a typed Tailscale machine name, and leaves a field the operator has not touched to the page', () => {
    page.setup = SETUP({ step: 'tailscale', cards: { tailscale: { state: 'unconnected', badge: 'Ready to connect' } } })
    page.UI.setup.tailscale = TAILSCALE_OVERVIEW()
    page.payload = payload()
    const field = (id, defaultValue, value = defaultValue) => ({ id, value, defaultValue, tagName: 'INPUT', focus() {} })
    const typed = field('setup-tailscale-machine', 'curia.sh', 'alp-workstation')
    const fresh = field('setup-tailscale-machine', 'curia.sh')
    let live = [typed]
    const app = { set innerHTML(_value) { live = [fresh] }, querySelectorAll: () => live }
    page.document.activeElement = null
    page.document.getElementById = (id) => (id === 'app' ? app : live.find((el) => el.id === id) ?? null)
    page.render()
    assert.equal(fresh.value, 'alp-workstation', 'the typed machine name survives without focus')

    // Untouched: the value the page drew is the value that stands, so a
    // read that changes the default (a remembered checkpoint) is not undone.
    const untouched = field('setup-tailscale-machine', 'curia.sh')
    const redrawn = field('setup-tailscale-machine', 'alp-workstation')
    live = [untouched]
    const app2 = { set innerHTML(_value) { live = [redrawn] }, querySelectorAll: () => live }
    page.document.getElementById = (id) => (id === 'app' ? app2 : live.find((el) => el.id === id) ?? null)
    page.render()
    assert.equal(redrawn.value, 'alp-workstation', 'a field nobody typed in takes the page\'s value')
  })

  test('selecting the model card takes the OpenAI read once, and Sign in remembers the provider, posts no field, then polls the read for the login', async () => {
    page.setup = SETUP({ cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    let reads = 0
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/openai') return { ok: true, json: async () => OPENAI_OVERVIEW(++reads > 1 ? { login: WAITING, said: '🔑 signing `openai` back in.' } : {}) }
      if (url === '/api/setup/openai/login') return { ok: true, json: async () => ({ ok: true, ...OPENAI_OVERVIEW({ login: { provider: 'openai', state: 'starting' } }) }) }
      if (url === '/api/setup/anthropic') return { ok: true, json: async () => ANTHROPIC_OVERVIEW() }
      return { ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP()) }
    }
    await page.selectSetupCard('model')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.filter((c) => c.url === '/api/setup/openai').length, 1)
    assert.equal(calls.filter((c) => c.url === '/api/setup/anthropic').length, 1, 'the Anthropic row reads once too')
    calls = []
    await page.doSetupOpenAILogin()
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['POST', '/api/setup'], ['POST', '/api/setup/openai/login'], ['GET', '/api/setup/openai']])
    assert.deepEqual(calls[0].body, { progress: { model: { provider: 'openai' } } })
    assert.deepEqual(calls[1].body, {}, 'the press carries no field: nothing about the login is the browser\'s to name')
    assert.equal(page.UI.setup.openai.login.code, '83CC-A4ZTO')
    page.clearTimeout(page.UI.setup.openaiTimer)
  })

  test('while the login waits the panel draws the link, the one-time code, and the terminal fallback the service composed', () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    page.UI.setup.openai = OPENAI_OVERVIEW({ login: WAITING })
    const html = page.screenSetup(payload())
    assert.match(html, /href="https:\/\/auth\.openai\.com\/codex\/device"/)
    assert.match(html, /class="reauth-code">83CC-A4ZTO</)
    assert.match(html, /href="https:\/\/box\.tail1234\.ts\.net:8446\/\?arg=curia-auth-openai"/)
    assert.match(text(html), /openai · signing in · 14:00 left/)
    assert.doesNotMatch(html, /onclick="doSetupOpenAILogin\(\)"/, 'no second press while one login runs')
  })

  // The rehearsal (#891): from the press until the pane prints the link the
  // row shows what curia is doing, and the failure comes only after a bounded
  // wait, with one action. Errors never precede valid progress.
  test('from the press the row says it is starting the session, then that it waits for the link, and fails only after the wait with one action', () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    page.UI.setup.openai = OPENAI_OVERVIEW({ login: { provider: 'openai', state: 'starting' } })
    let html = page.screenSetup(payload())
    assert.match(text(html), /openai · starting the sign-in session/)
    assert.doesNotMatch(html, /onclick="doSetupOpenAILogin\(\)"/, 'no second press while the session starts')
    assert.doesNotMatch(text(html), /could not read the login|could not publish/)

    page.UI.setup.openai = OPENAI_OVERVIEW({ login: { ...WAITING, url: null, code: null, terminal_url: null, started_at: at(30) } })
    html = page.screenSetup(payload())
    assert.match(text(html), /Waiting for the sign-in link/)
    assert.doesNotMatch(text(html), /could not read the login/)
    assert.doesNotMatch(html, /class="flow blind"/)

    page.UI.setup.openai = OPENAI_OVERVIEW({ login: { ...WAITING, url: null, code: null, started_at: at(200) } })
    html = page.screenSetup(payload())
    assert.match(text(html), /curia could not read the login off the pane/)
    assert.match(text(html), /3 minutes/)
    assert.match(html, /class="flow blind"/)
    assert.equal((html.match(/Open the terminal instead/g) ?? []).length, 1, 'one action')
  })

  test('the link and the one-time code each carry a copy button', () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    page.UI.setup.openai = OPENAI_OVERVIEW({ login: WAITING })
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW({ login: ANTHROPIC_WAITING })
    const html = page.screenSetup(payload())
    assert.match(html, /onclick="copyText\(this, 'https:\/\/auth\.openai\.com\/codex\/device'\)">Copy link</)
    assert.match(html, /onclick="copyText\(this, '83CC-A4ZTO'\)">Copy code</)
    assert.match(html, /onclick="copyText\(this, 'https:\/\/claude\.com\/cai\/oauth\/authorize\?code_challenge=abc&amp;state=xyz'\)">Copy link</)
    assert.equal((html.match(/Copy code/g) ?? []).length, 1, 'the typed lane shows no code to copy')
  })

  test('a copy press writes the clipboard and says Copied on the button', async () => {
    const written = []
    page.navigator = { clipboard: { writeText: async (t) => { written.push(t) } } }
    const button = { textContent: 'Copy code' }
    await page.copyText(button, '83CC-A4ZTO')
    assert.deepEqual(written, ['83CC-A4ZTO'])
    assert.equal(button.textContent, 'Copied')
  })

  test('a login that ended without a credential is said beside the plain card, and the press is offered again', () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    page.UI.setup.openai = OPENAI_OVERVIEW({ ending: { provider: 'openai', state: 'expired', why: 'the one-time code ran out before anybody finished the login', ended_at: '2026-09-02T10:15:00.000Z', after_s: 900 } })
    const html = page.screenSetup(payload())
    assert.match(text(html), /The last OpenAI sign-in ended: the one-time code ran out before anybody finished the login/)
    assert.match(html, /onclick="doSetupOpenAILogin\(\)">Sign in to OpenAI</)
  })

  test('a failed model card names the failure and the action, and offers the sign-in again beside Try again', () => {
    page.setup = SETUP({ step: 'model', cards: { model: {
      state: 'failed', badge: 'Action required',
      error: { failed: 'OpenAI refused the credential (HTTP 401: invalid token)', action: 'Sign in to OpenAI from this panel, then try again.' },
      providers: providers({ state: 'failed', error: { failed: 'OpenAI refused the credential (HTTP 401: invalid token)', action: 'Sign in to OpenAI from this panel, then try again.' }, detail: { stage: 'request', provider: 'openai', identity: { account_id: 'acct-42', plan_type: 'pro' } } }),
    } } })
    page.UI.setup.openai = OPENAI_OVERVIEW({ secret: { state: 'present' }, identity: { account_id: 'acct-42', plan_type: 'pro', expires_at: '2026-09-11T10:00:00.000Z' } })
    const html = page.screenSetup(payload())
    assert.match(html, /class="setup-card model failed on"/)
    assert.match(text(html), /OpenAI refused the credential \(HTTP 401: invalid token\)/)
    assert.match(html, /onclick="doSetupOpenAILogin\(\)">Sign in to OpenAI again</)
    assert.match(html, /onclick="retrySetup\(\)">Try again</)
    assert.doesNotMatch(html, /acct-42/, 'the account id is a fact for the gate, not a line for a person')
  })

  test('a connected model card draws the plan, the credential expiry, the timed request, and the routing preset, and keeps the second provider open', () => {
    page.setup = SETUP({ step: 'model', cards: { model: {
      ...ALL.model,
      providers: providers({
        state: 'connected', footer: { primary: 'OpenAI', secondary: 'verification request completed in 0.9 s', emoji: '⚡' },
        detail: {
          provider: 'openai', identity: { account_id: 'acct-42', plan_type: 'pro' }, credential: { expires_at: new Date(Date.now() + 9 * 86_400_000).toISOString() },
          request: { model: 'gpt-5.6-sol', id: 'resp_1', at: new Date().toISOString(), ms: 912, usage: { input_tokens: 12, output_tokens: 1 } },
          routing: { ready: true, applied: true, model: 'gpt', file: '/root/state/routing.local.yaml', rows: [{ type: 'untyped', model: 'gpt', provider: 'openai', active: true, credentialed: true, ok: true }], missing: [] },
          verified_at: new Date().toISOString(),
        },
      }),
    } } })
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW()
    const html = page.screenSetup(payload())
    assert.match(text(html), /Plan pro/)
    assert.match(text(html), /Credential expires in 9\.0d/)
    assert.match(text(html), /Verification gpt-5\.6-sol answered in 912 ms/)
    assert.match(text(html), /Routing gpt for every ticket type · preset applied by Curia/)
    assert.match(text(html), /Anthropic Ready to connect/)
    assert.match(html, /onclick="doSetupAnthropicLogin\(\)">Sign in to Anthropic</)
    assert.match(html, /<details><summary>Sign in to OpenAI again<\/summary>/)
    assert.match(html, /Continue setup/)
    assert.doesNotMatch(html, /Try again/)
  })

  test('Sign in to Anthropic remembers the provider, posts no field, then polls the read for the typed login', async () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    let reads = 0
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/anthropic') return { ok: true, json: async () => ANTHROPIC_OVERVIEW(++reads > 0 ? { login: ANTHROPIC_WAITING, said: '🔑 signing `anthropic` back in.' } : {}) }
      if (url === '/api/setup/anthropic/login') return { ok: true, json: async () => ({ ok: true, ...ANTHROPIC_OVERVIEW({ login: { provider: 'anthropic', state: 'starting' } }) }) }
      if (url === '/api/setup/openai') return { ok: true, json: async () => OPENAI_OVERVIEW() }
      return { ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP()) }
    }
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW()
    calls = []
    await page.doSetupAnthropicLogin()
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['POST', '/api/setup'], ['POST', '/api/setup/anthropic/login'], ['GET', '/api/setup/anthropic']])
    assert.deepEqual(calls[0].body, { progress: { model: { provider: 'anthropic' } } })
    assert.deepEqual(calls[1].body, {}, 'the press carries no field: nothing about the login is the browser\'s to name')
    assert.equal(page.UI.setup.anthropic.login.typed, true)
    page.clearTimeout(page.UI.setup.anthropicTimer)
  })

  test('while the Anthropic login waits the panel draws the authorize link, the paste-back step, and the terminal fallback, and never a code to read', () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    page.UI.setup.openai = OPENAI_OVERVIEW()
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW({ login: ANTHROPIC_WAITING })
    const html = page.screenSetup(payload())
    assert.match(html, /href="https:\/\/claude\.com\/cai\/oauth\/authorize\?code_challenge=abc&amp;state=xyz"/)
    assert.match(text(html), /Paste the code the browser shows/)
    assert.match(html, /<input id="setup-anthropic-code"[^>]*>/, 'the Code field (#891)')
    assert.match(html, /onclick="doSetupAnthropicCode\([^"]*\)">Submit</, 'and its Submit')
    assert.match(html, /href="https:\/\/box\.tail1234\.ts\.net:8446\/\?arg=curia-auth-anthropic"/)
    assert.match(text(html), /anthropic · signing in · 28:20 left/)
    assert.doesNotMatch(html, /class="reauth-code"/, 'the typed lane shows no code: the operator puts one in')
    assert.doesNotMatch(html, /onclick="doSetupAnthropicLogin\(\)"/, 'no second press while one login runs')
    assert.match(html, /onclick="doSetupOpenAILogin\(\)"/, 'the other row keeps its press')
  })

  // #891: the operator pastes the code on the card; Curia delivers it.
  test('Submit posts the code as its one field, then polls the read; a refusal is said beside the field and the code is kept out of the page state', async () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    const code = 'aB3dEf#9oq-pmO4pEY1t4nD2prvbnqYYqlSkptF03z3EABHPaA'
    let answer = { ok: true, json: async () => ({ ok: true, delivered: true, said: 'Code delivered. Curia reads the token off the login and verifies it from here.', ...ANTHROPIC_OVERVIEW({ login: { ...ANTHROPIC_WAITING, delivered_at: '2026-09-02T10:00:00.000Z' } }) }) }
    page.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/setup/anthropic/code') return answer
      if (url === '/api/setup/anthropic') return { ok: true, json: async () => ANTHROPIC_OVERVIEW({ login: { ...ANTHROPIC_WAITING, delivered_at: '2026-09-02T10:00:00.000Z' } }) }
      if (url === '/api/setup/openai') return { ok: true, json: async () => OPENAI_OVERVIEW() }
      return { ok: true, json: async () => (init.method === 'POST' ? { ok: true } : SETUP()) }
    }
    page.UI.screen = 'setup'
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW({ login: ANTHROPIC_WAITING })
    calls = []
    await page.doSetupAnthropicCode(`  ${code} `)
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['POST', '/api/setup/anthropic/code'], ['GET', '/api/setup/anthropic']])
    assert.deepEqual(calls[0].body, { code })
    assert.equal(page.UI.setup.anthropic.login.delivered_at, '2026-09-02T10:00:00.000Z')
    assert.equal(JSON.stringify([page.UI.setup.anthropic, page.UI.act]).includes(code), false, 'the page keeps no copy of the code')
    assert.match(text(page.screenSetup(payload())), /Code delivered/)
    page.clearTimeout(page.UI.setup.anthropicTimer)

    answer = { ok: false, status: 409, json: async () => ({ error: 'the sign-in session is gone, so there is nothing to type the code into. Start the sign-in again.' }) }
    await page.doSetupAnthropicCode(code)
    assert.match(text(page.screenSetup(payload())), /the sign-in session is gone/)
    page.clearTimeout(page.UI.setup.anthropicTimer)
  })

  test('an Anthropic login that ended without a credential is said beside the plain row, and the press is offered again', () => {
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    page.UI.setup.openai = OPENAI_OVERVIEW()
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW({ ending: { provider: 'anthropic', state: 'failed', why: 'Anthropic answered HTTP 401 for the token read off the login pane', ended_at: '2026-09-02T10:15:00.000Z', after_s: 300 } })
    const html = page.screenSetup(payload())
    assert.match(text(html), /The last Anthropic sign-in ended: Anthropic answered HTTP 401 for the token read off the login pane/)
    assert.match(html, /onclick="doSetupAnthropicLogin\(\)">Sign in to Anthropic</)
  })

  test('a failed Anthropic row names the failure and the action, offers the sign-in again beside Try again, and shows no credential material', () => {
    const error = { failed: 'Anthropic refused the credential (HTTP 401: invalid x-api-key)', action: 'Sign in to Anthropic from this panel, then try again.' }
    page.setup = SETUP({ step: 'model', cards: { model: {
      state: 'failed', badge: 'Action required', error,
      providers: providers({ state: 'unconnected' }, { state: 'failed', error, detail: { stage: 'request', provider: 'anthropic', credential: { kind: 'setup-token', obtained_at: '2026-08-24T12:00:00.000Z', expires_at: '2027-08-24T12:00:00.000Z', estimated: true } } }),
    } } })
    page.UI.setup.openai = OPENAI_OVERVIEW()
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW({ secret: { state: 'present' }, credential: { kind: 'setup-token', obtained_at: '2026-08-24T12:00:00.000Z', expires_at: '2027-08-24T12:00:00.000Z', estimated: true } })
    const html = page.screenSetup(payload())
    assert.match(html, /class="setup-card model failed on"/)
    assert.match(text(html), /Anthropic refused the credential \(HTTP 401: invalid x-api-key\)/)
    assert.match(html, /onclick="doSetupAnthropicLogin\(\)">Sign in to Anthropic again</)
    assert.match(html, /onclick="retrySetup\(\)">Try again</)
    assert.doesNotMatch(html, /sk-ant-/)
  })

  test('a connected Anthropic row draws the adoption, the estimated expiry, the timed request, and the routing preset; with both rows connected the card says two providers', () => {
    const now = Date.now()
    page.setup = SETUP({ step: 'model', cards: { model: {
      ...ALL.model, badge: 'Two providers verified',
      providers: providers({
        state: 'connected', footer: { primary: 'OpenAI', secondary: 'verification request completed in 0.9 s', emoji: '⚡' },
        detail: {
          provider: 'openai', identity: { account_id: 'acct-42', plan_type: 'pro' }, credential: { expires_at: new Date(now + 9 * 86_400_000).toISOString() },
          request: { model: 'gpt-5.6-sol', id: 'resp_1', at: new Date(now).toISOString(), ms: 912, usage: { input_tokens: 12, output_tokens: 1 } },
          routing: { ready: true, applied: false, model: 'gpt', file: '/root/state/routing.local.yaml', rows: [], missing: [] }, verified_at: new Date(now).toISOString(),
        },
      }, {
        state: 'connected', footer: { primary: 'Anthropic', secondary: 'verification request completed in 1.4 s', emoji: '🧠' },
        detail: {
          provider: 'anthropic',
          credential: { kind: 'setup-token', obtained_at: new Date(now - 10 * 86_400_000).toISOString(), expires_at: new Date(now + 355 * 86_400_000).toISOString(), estimated: true },
          request: { model: 'claude-haiku-4-5-20251001', id: 'msg_01', request_id: 'req_abc', at: new Date(now).toISOString(), ms: 1402, stop_reason: 'end_turn', usage: { input_tokens: 31, output_tokens: 1 } },
          routing: { ready: true, applied: true, model: 'fable', file: '/root/state/routing.local.yaml', rows: [], missing: [] }, verified_at: new Date(now).toISOString(),
        },
      }),
    } } })
    const html = page.screenSetup(payload())
    assert.match(text(html), /Two providers verified/)
    assert.match(text(html), /Credential subscription token adopted 240h ago · about 355\.0d left, an estimate from Anthropic's documented lifetime/)
    assert.match(text(html), /Verification claude-haiku-4-5-20251001 answered in 1402 ms/)
    assert.match(text(html), /Routing fable for every ticket type that could not run · preset applied by Curia/)
    assert.match(html, /<details><summary>Sign in to Anthropic again<\/summary>/)
    assert.match(html, /<details><summary>Sign in to OpenAI again<\/summary>/)
    assert.doesNotMatch(html, /sk-ant-|acct-42/)
    assert.doesNotMatch(html, /Try again/)
  })

  // The rehearsal (#891): after a press the panel kept the pre-action content,
  // the sign-in steps or the old failure, until the next read landed with the
  // connected state. One mechanism for every card: the press switches the card
  // and its panel to what Curia is doing, and only the next read for that card
  // replaces it, with the failure or the connected state it found.
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
  const TAILSCALE_FAILED = { state: 'failed', badge: 'Action required', error: { failed: 'Tailscale Serve is not reachable', action: 'Run tailscale serve --bg 8445 on this host, then try again.' } }
  const TAILSCALE_READ = { requester: 'alp', operator: null, node: { installed: true, online: true, backend_state: 'Running', dns_name: 'curia.tail1234.ts.net', ips: ['100.1.2.3'] }, serve: null, app_url: null, first_operator: null, error: null }

  test('a card action switches the card and its panel to in-progress at once, with none of the old content, and the next read replaces it', async () => {
    const press = deferred()
    const read = deferred()
    page.setup = SETUP({ step: 'tailscale', cards: { tailscale: TAILSCALE_FAILED } })
    page.UI.setup.tailscale = TAILSCALE_READ
    page.fetch = async (url, init = {}) => {
      if (url === '/api/setup/tailscale/operator') { await press.promise; return { ok: true, json: async () => ({ ok: true }) } }
      if (url === '/api/setup') { await read.promise; return { ok: true, json: async () => SETUP({ step: 'tailscale', cards: { tailscale: ALL.tailscale } }) } }
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const before = page.screenSetup(payload())
    assert.match(before, /Confirm operator and verify/)
    assert.match(before, /Tailscale Serve is not reachable/)

    const pressed = page.doSetupTailscaleOperator()
    let html = page.screenSetup(payload())
    assert.match(html, /class="setup-card tailscale failed working on"/, 'the rail card shows the work')
    assert.match(text(html), /Tailscale Working Verifying the operator/)
    assert.match(html, /class="setup-panel working"/)
    assert.match(text(html), /Verifying the operator… /)
    assert.match(html, /class="setup-progress"/, 'a progress indicator, not a spinner in a button')
    assert.doesNotMatch(html, /Tailscale Serve is not reachable/, 'the previous failure is gone the moment the press lands')
    assert.doesNotMatch(html, /Confirm operator|setup-tailscale-name|Try again/, 'none of the pre-action content stays')

    press.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    html = page.screenSetup(payload())
    assert.match(html, /class="setup-panel working"/, 'the panel stays in progress until the read lands, not until the press answers')
    assert.doesNotMatch(html, /Serve is not reachable|Confirm operator/)

    read.resolve()
    await pressed
    html = page.screenSetup(payload())
    assert.doesNotMatch(html, /working/, 'the read settles the work')
    assert.match(html, /class="setup-card tailscale connected on"/)
    assert.match(text(html), /Connected and verified/)
    assert.doesNotMatch(text(html), /Verifying the operator/)
  })

  test('Try again on a failed card hides the failure while the fresh read is in flight, and a read that fails again shows the new failure', async () => {
    const read = deferred()
    page.setup = SETUP({ step: 'tailscale', cards: { tailscale: TAILSCALE_FAILED } })
    page.UI.setup.tailscale = TAILSCALE_READ
    page.fetch = async () => { await read.promise; return { ok: true, json: async () => SETUP({ step: 'tailscale', cards: { tailscale: { ...TAILSCALE_FAILED, error: { failed: 'No operator confirmed', action: 'Confirm the operator on this card.' } } } }) } }
    const retried = page.retrySetup()
    let html = page.screenSetup(payload())
    assert.match(text(html), /Verifying Tailscale again/)
    assert.doesNotMatch(html, /Serve is not reachable|Try again/)
    read.resolve()
    await retried
    html = page.screenSetup(payload())
    assert.doesNotMatch(html, /working|Serve is not reachable/)
    assert.match(html, /setup-problem"><b>No operator confirmed<\/b>Confirm the operator on this card\./)
    assert.match(html, /onclick="retrySetup\(\)">Try again</)
  })

  test('when a sign-in ends the model card says it is completing the model request until the verification answers, never the steps again', async () => {
    const read = deferred()
    page.setup = SETUP({ step: 'model', cards: { model: { state: 'unconnected', badge: 'Ready to connect', providers: providers({ state: 'unconnected' }) } } })
    page.UI.setup.openai = OPENAI_OVERVIEW({ login: WAITING })
    page.UI.setup.anthropic = ANTHROPIC_OVERVIEW()
    page.fetch = async (url) => {
      if (url === '/api/setup/openai') return { ok: true, json: async () => OPENAI_OVERVIEW({ secret: { state: 'present' } }) }
      if (url === '/api/setup') { await read.promise; return { ok: true, json: async () => SETUP({ step: 'model', cards: { model: ALL.model } }) } }
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const polled = page.loadOpenAISetup()
    await new Promise((resolve) => setImmediate(resolve))
    let html = page.screenSetup(payload())
    assert.match(text(html), /Completing one minimal model request and applying the routing preset…/)
    assert.doesNotMatch(html, /Sign in to OpenAI again|setup-steps|reauth-code/, 'neither the steps nor the finished login')
    assert.match(html, /class="setup-card model unconnected working on"/)
    read.resolve()
    await polled
    html = page.screenSetup(payload())
    assert.doesNotMatch(html, /class="setup-card model[^"]*working|setup-panel working/)
    assert.match(text(html), /Provider verified/)
  })

  test('Run Full loop selects the run panel in the main area with the eight legs, marks the rail card running, and scrolls the run into view', async () => {
    const press = deferred()
    const scrolled = []
    page.document.getElementById = (id) => (id === 'setup-run' ? { scrollIntoView: (opts) => scrolled.push(opts) } : null)
    page.setup = SETUP({ step: 'model', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts: RUN_FACTS, run: { state: 'idle', legs: [] } } })
    const running = RUN('running', { legs: ['complete', 'running'] })
    page.fetch = async (url, init = {}) => {
      if (init.method === 'POST') { await press.promise; return { ok: true, json: async () => ({ ok: true, run: running }) } }
      return { ok: true, json: async () => running }
    }
    let html = page.screenSetup(payload())
    assert.match(html, /<h2>Model provider<\/h2>/, 'the selected card is the panel before the press')
    const pressed = page.runFullLoop()
    html = page.screenSetup(payload())
    assert.match(html, /id="setup-run"/, 'the run is the selected panel from the press')
    assert.doesNotMatch(html, /<h2>Model provider<\/h2>/)
    assert.match(text(html), /Starting the Full loop…/)
    assert.doesNotMatch(html, /onclick="runFullLoop\(\)"/, 'no second press')
    assert.match(html, /class="setup-loop working on"/, 'the rail card shows the press')
    assert.equal(scrolled.length, 1, 'the page scrolls the run into view on the press')
    press.resolve()
    await pressed
    html = page.screenSetup(payload())
    const main = /<section>([\s\S]*)<\/section>/.exec(html)[1]
    assert.match(main, /id="setup-run"/)
    assert.match(text(main), /Running the Full loop\./)
    for (const title of LEG_TITLES) assert.match(text(main), new RegExp(`${title} · (complete|running|pending)`))
    assert.match(html, /class="setup-loop run running on"/, 'the rail card shows the running state')
    assert.doesNotMatch(/<aside[\s\S]*<\/aside>/.exec(html)[0], /loop-legs/, 'the legs live in the main area, not below the fold in the rail')
    page.clearTimeout(page.UI.setup.loopTimer)
    page.UI.setup.loopTimer = null
    // Selecting a card brings its panel back; the rail's Full loop card brings the run back.
    await page.selectSetupCard('github')
    assert.match(page.screenSetup(payload()), /<h2>GitHub<\/h2>/)
    page.selectSetupRun()
    assert.match(page.screenSetup(payload()), /id="setup-run"/)
  })

  test('Try again on a failed run selects the run panel and shows the retry in progress until the answer', async () => {
    const press = deferred()
    const failed = { leg: 'review', title: 'Review', cause: 'The agent ended before Review: the agent exited.', action: 'Fix it, then select Try again.' }
    page.setup = SETUP({ step: 'github', cards: ALL, full_loop: { ready: true, missing: [], reason: null, facts: RUN_FACTS, run: RUN('failed', { legs: ['complete', 'complete', 'complete', 'complete', 'failed'], failed }) } })
    page.UI.setup.panel = 'card'
    page.fetch = async () => { await press.promise; return { ok: true, json: async () => ({ ok: true, run: RUN('running', { legs: ['complete', 'complete', 'complete', 'complete', 'running'] }) }) } }
    const pressed = page.retryFullLoop()
    let html = page.screenSetup(payload())
    assert.match(html, /id="setup-run"/)
    assert.match(text(html), /Retrying Review…/)
    assert.doesNotMatch(html, /The agent ended before Review/, 'the old failure is gone while the retry is in flight')
    press.resolve()
    await pressed
    html = page.screenSetup(payload())
    assert.match(text(html), /Review · running/)
    page.clearTimeout(page.UI.setup.loopTimer)
    page.UI.setup.loopTimer = null
  })

  test('Watch these repositories and Restart Curia show their work the same way', async () => {
    const write = deferred()
    page.setup = SETUP({ step: 'github', cards: { github: { state: 'failed', badge: 'Action required', error: { failed: 'No watched repository is covered', action: 'Choose the repositories.' }, detail: { available: ['alp82/curia'], watched: [], owners: [] } } } })
    page.document.getElementById = (id) => (id === 'setup-github-repo-0' ? { checked: true } : null)
    page.fetch = async (url) => {
      if (url === '/api/setup/github/watch') { await write.promise; return { ok: true, json: async () => ({ ok: true }) } }
      return { ok: true, json: async () => SETUP({ step: 'github', cards: { github: ALL.github } }) }
    }
    const pressed = page.doSetupGitHubWatch()
    let html = page.screenSetup(payload())
    assert.match(text(html), /Saving the watch list and verifying the repositories…/)
    assert.doesNotMatch(html, /No watched repository is covered|Watch these repositories/)
    write.resolve()
    await pressed
    html = page.screenSetup(payload())
    assert.doesNotMatch(html, /working/)
    assert.match(html, /class="setup-card github connected on"/)

    page.setup = SETUP({ step: 'discord', cards: { discord: { ...ALL.discord, detail: { bridge: 'down', channel: { name: 'curia', url: 'https://discord.com/channels/2/4' }, guild: { name: 'g' }, confirmation: { posted: true, at: at(5), url: 'https://discord.com/channels/2/4/9' }, operator: { id: '1', name: 'alp' }, commands: ['start'] } } } })
    page.document.getElementById = () => null
    page.fetch = () => new Promise(() => {})
    assert.match(page.screenSetup(payload()), /onclick="doSetupRestart\(\);return false">Restart Curia</)
    page.doSetupRestart()
    html = page.screenSetup(payload())
    assert.match(text(html), /Restarting Curia so the bridge reads the token…/)
    assert.doesNotMatch(html, /The bridge reads the token when the service starts/)
    assert.match(html, /class="setup-card discord connected working on"/)
    page.clearTimeout(page.UI.setup.restartTimer)
  })
})

// The four read screens (#264) — home, agents, frontier, feed.
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

import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { DEFAULT_DASHBOARD_INDEX, DASHBOARD_PROTO } from '../src/dashboard.mjs'

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

function loadPage() {
  const ctx = vm.createContext({
    document: { title: '', getElementById: () => null, addEventListener() {}, visibilityState: 'hidden' },
    window: { addEventListener() {} },
    location: { hash: '', search: '', pathname: '/' },
    URLSearchParams,
    fetch: () => new Promise(() => {}),
    setTimeout,
    clearTimeout,
    console,
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
    location: { hash: '', search: '', pathname: '/' },
    URLSearchParams,
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
  // `config` is the six reloadable settings the daemon is RUNNING (#362). It
  // agrees with SETTINGS() below on purpose: the ordinary state is a daemon
  // running the files, and each test that wants a stale one says so.
  daemon: {
    port: 4271,
    uptime_s: 7200,
    auto_dispatch: true,
    max_concurrent: 3,
    config: {
      loaded_at: at(7200),
      dispatch: { auto_dispatch: true, max_concurrent: 3, poll_interval_s: 60, prototype_variations: 5 },
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
  // The GitHub App and where it is installed (#705). The ordinary box: an app
  // created, and the one watched owner it is installed on.
  github_app: {
    configured: true,
    app_id: '317489578',
    slug: 'curia-sh',
    name: 'curia-sh',
    html_url: 'https://github.com/apps/curia-sh',
    bot_login: 'curia-sh[bot]',
    key_file: '/srv/curia/daemon/.curia-app.pem',
    read_at: at(90),
    error: null,
    owners: [{ owner: 'alp82', installed: true, install_url: 'https://github.com/apps/curia-sh/installations/new' }],
  },
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
// `credentials` section on purpose — a daemon older than the section is a real
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

describe('the Atlas frame (#686)', () => {
  let page
  let shell

  before(() => {
    page = loadPage()
    page.document.getElementById = (id) => (id === 'app' ? { set innerHTML(value) { shell = value } } : null)
    page.payload = payload()
    page.render()
  })

  test('the desktop drawer names every Atlas screen in the decided order', () => {
    const drawer = /<nav class="drawer"[\s\S]*?<\/nav>/.exec(shell)?.[0]
    assert.ok(drawer)
    assert.deepEqual(
      [...drawer.matchAll(/<span class="nav-label">([^<]+)<\/span>/g)].map((match) => match[1]),
      // Credentials sits between Chat and Settings (#661). It landed while the
      // Atlas frame was in review, so the two agreed on every screen but this
      // one until they met on `main`.
      ['Home', 'Maps', 'Agents', 'Feed', 'Chat', 'Credentials', 'Settings'],
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
      page.screenFrontier,
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
    assert.doesNotMatch(shell, /title="the daemon is not running these files">●/)
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
          in_flight: { prev: 'a'.repeat(40), next: 'b'.repeat(40), state: 'rolling-back' },
          last: null,
          verdict_read_error: null,
        },
      })))
      assert.match(t, /Deploy/)
      assert.match(t, /a deploy is in flight: a{7} → b{7}/)
      assert.match(t, /state rolling-back/)
    })

    test('the home screen keeps the last deploy verdict and its error excerpt', () => {
      const t = text(page.screenHome(payload({
        deploy: {
          in_flight: null,
          last: {
            state: 'rolled-back', prev: 'a'.repeat(40), next: 'b'.repeat(40),
            reason: 'docker compose could not recreate the services', by: 'u1',
            resolved_at: at(30), log: 'Cannot connect to the Docker daemon',
          },
          verdict_read_error: null,
        },
      })))
      assert.match(t, /Last deploy/)
      assert.match(t, /ROLLED BACK: a{7} → b{7}/)
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
      assert.equal(page.document.title, '(2) Atlas · Curia')
      page.payload = payload({ escalations: [], review_gate: [] })
      page.render()
      assert.equal(page.document.title, 'Atlas · Curia')
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
    test('the table names the state in words and the meters in numbers', () => {
      const t = text(page.screenAgents(payload()))
      assert.match(t, /agents 3\/3/)
      assert.match(t, /bridge up/)
      assert.match(t, /curia-255 waiting/, 'an open question makes an agent waiting, whatever its record says')
      assert.match(t, /curia-263 working/, 'ready and working are one state')
      assert.match(t, /curia-review-263 reviewer/)
      assert.match(t, /claude-opus-5/)
      assert.match(t, /Recently: finished alp82\/curia#261/)
    })

    test('the ctx column reads the meter, and a missing meter is not zero', () => {
      const t = text(page.screenAgents(payload()))
      assert.match(t, /41%/)
      assert.match(t, /68%/)
      // curia-review-263 has no transcript reading. "—" is the honest cell.
      assert.doesNotMatch(t, /0%/)
      const over = payload()
      over.overview.agents[0].ctx_pct = 118
      over.overview.agents[0].ctx_over = true
      assert.match(text(page.screenAgents(over)), /118% ⚠/, 'over 100% is a complaint about the denominator, and is marked')
    })

    test('the contact column reads the silence, and states which null it is (#370)', () => {
      const t = text(page.screenAgents(payload()))
      assert.match(t, /12s/, 'an agent heard 12 seconds ago')
      assert.match(t, /8m/, 'and one heard 8 minutes ago')
      assert.match(t, /never is an agent that has said nothing since it spawned/, 'the table says what its words mean')

      const quiet = payload()
      // spawned by this process and never heard: the mute shape (#194)
      quiet.overview.agents[0].last_contact_s = null
      // adopted after a restart: no spawn on this process, so no uptime either
      quiet.overview.agents[1].last_contact_s = null
      quiet.overview.agents[1].uptime_s = null
      const q = text(page.screenAgents(quiet))
      assert.match(q, /never/)
      assert.match(q, /adopted/)
      assert.doesNotMatch(q, /\b0s\b/, 'no reading is never 0 seconds ago')
    })

    test('the fleet on home carries the same reading', () => {
      const t = text(page.screenHome(payload()))
      assert.match(t, /12s/)
    })

    test('only the agent that wants you is marked, and the mark is the only color', () => {
      const html = page.screenAgents(payload())
      const rows = html.split('<tr').filter((r) => r.includes('class="sess"'))
      const marked = rows.filter((r) => r.includes('esc-row'))
      assert.equal(marked.length, 1)
      assert.match(marked[0], /curia-255/)
    })

    test('an unreadable fleet says so here too', () => {
      const t = text(page.screenAgents(payload({ agents: null, fleet_error: 'tmux is indeterminate' })))
      assert.match(t, /could not be read — tmux is indeterminate/)
      assert.match(t, /agents —\/3/)
    })
  })

  describe('frontier — two levels', () => {
    test('cards draw the takeable set and what it unblocks', () => {
      page.UI.fr = { view: 'cards', repo: 'all', type: 'all' }
      const t = text(page.screenFrontier(payload()))
      assert.match(t, /takeable now \(2\)/)
      assert.match(t, /#265 task The settings write/)
      assert.match(t, /unblocks 1/)
      assert.match(t, /#266 grilling The verbs reach the browser/)
      assert.match(t, /unblocks nothing yet/)
      assert.match(t, /unblocked next \(1\)/)
      assert.match(t, /#267 The chat embeds the timeline attach ↖ #265/)
      assert.match(t, /computed \d+m ago/, 'the page states the age of the reading')
    })

    test('a repo whose read failed is not an empty frontier', () => {
      const t = text(page.screenFrontier(payload()))
      assert.match(t, /alp82\/aistack could not be read — gh api failed: HTTP 502/)
      assert.match(t, /there may be takeable tickets there/)
    })

    test('the tree says the same two levels', () => {
      page.UI.fr = { view: 'tree', repo: 'all', type: 'all' }
      const t = text(page.screenFrontier(payload()))
      assert.match(t, /alp82\/curia/)
      assert.match(t, /task #265 The settings write/)
      assert.match(t, /#267 The chat embeds the timeline attach/)
      page.UI.fr.view = 'cards'
    })

    test('the project filter narrows to one repo, and the type filter to one type', () => {
      page.UI.fr = { view: 'cards', repo: 'alp82/curia', type: 'all' }
      let t = text(page.screenFrontier(payload()))
      assert.doesNotMatch(t, /aistack could not be read/, 'a repo out of the filter is out of the page')
      page.UI.fr.type = 'grilling'
      t = text(page.screenFrontier(payload()))
      assert.match(t, /takeable now \(1\)/)
      assert.match(t, /#266/)
      assert.doesNotMatch(t, /#265 /)
      // A filter that matches nothing says so rather than drawing a blank page.
      page.UI.fr.type = 'research'
      assert.match(text(page.screenFrontier(payload())), /Nothing is takeable under this filter/)
      page.UI.fr = { view: 'cards', repo: 'all', type: 'all' }
    })

    test('picking a project resets the type — an unreachable filter draws an empty page and names no reason', () => {
      page.UI.fr = { view: 'cards', repo: 'all', type: 'grilling' }
      page.document.getElementById = () => ({ innerHTML: '' })
      page.frSet('repo', 'alp82/curia')
      assert.deepEqual(page.UI.fr, { view: 'cards', repo: 'alp82/curia', type: 'all' })
      page.document.getElementById = () => null
      page.UI.fr = { view: 'cards', repo: 'all', type: 'all' }
    })

    test('a frontier nobody has computed is not an empty frontier', () => {
      const t = text(page.screenFrontier(payload({ frontier: { computed_at: null, repos: [] } })))
      assert.match(t, /No frontier has been computed yet/)
      assert.match(t, /Reconcile computes it/)
    })

    test('a ticket with no wayfinder label has no type, and none is guessed for it', () => {
      const p = payload()
      p.overview.frontier.repos[0].items[0].labels = ['bug']
      assert.match(text(page.screenFrontier(p)), /#265 untyped/)
    })
  })

  describe('feed', () => {
    test('the journal reads as sentences, newest first', () => {
      const t = text(page.screenFeed(payload()))
      const spawn = t.indexOf('spawned on gpt-5.6-sol')
      const ask = t.indexOf('asks — choice')
      assert.ok(ask > -1 && spawn > ask, 'the last thing that happened is the first thing on the page')
      assert.match(t, /curia-255 spawned on gpt-5.6-sol — codex · alp82\/curia#255/)
    })

    test('an event nobody wrote prose for is still legible', () => {
      // `credentials_swept` has no line in the table on purpose: the daemon
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
    test('a daemon that is not answering shows the age of the held snapshot', () => {
      page.reachable = true
      const p = payload()
      p.daemon_up = false
      p.error = 'connect ECONNREFUSED'
      p.error_since = at(30)
      p.read_at = at(90)
      const t = text(page.screenHome(p))
      assert.match(t, /daemon restarting/)
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
  dispatch: { auto_dispatch: true, max_concurrent: 3, poll_interval_s: 60, prototype_variations: 5 },
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

  test('the two files it writes are named on the screen', () => {
    assert.match(text(screen()), /curia\.yaml · routing\.yaml/)
  })

  // ---- the drill-in frame (#699) -------------------------------------------
  //
  // The shape every later Atlas section page renders inside. What is pinned
  // here is the frame's contract rather than these four sections' words: one
  // list, one open section, a way back, and a read that a section takes on
  // arrival instead of on every poll.

  test('the main list names every section, each with a gist of its own', () => {
    const html = screen()
    assert.deepEqual(rows(html), ['routing', 'projects', 'dispatch', 'github', 'maintenance'])
    const t = text(html)
    assert.match(t, /Routing opus untyped · 2 of 3 models on/)
    assert.match(t, /Projects 2 repos watched/)
    assert.match(t, /Dispatch auto · 3 agents · 60s/)
    assert.match(t, /Maintenance in step/, 'a color state says a word too')
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
    assert.match(t, /switched off — the daemon refuses this config/)
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
    assert.ok(!t.includes('workspace_root'), 'a path on the daemon\'s filesystem is not a thing this screen writes')
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

  test('a number field posts a number, never the string the input holds', () => {
    page.setDispatchField('prototype_variations', '7')
    assert.strictEqual(page.settingsPatch().dispatch.prototype_variations, 7)
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

  test('applied: one sentence, and no button — the daemon took it', () => {
    page.UI.set.phase = 'applied'
    page.UI.set.note = 'Wrote curia.local.yaml, atomically, with the comments kept.'
    const html = screen()
    assert.match(text(html), /saved ✓/)
    assert.match(text(html), /The daemon is running it\./)
    assert.ok(!html.includes('doRestart()'), 'an applied save needs no button at all')
  })

  test('declined: the key that differs is named, and the restart is the mitigation', () => {
    page.UI.set.phase = 'declined'
    page.UI.set.note = 'Wrote curia.local.yaml, atomically, with the comments kept.'
    page.UI.set.error = 'curia.yaml `dispatch.workspace_root` changed, and that key is not one a reload applies — restart the daemon to take it'
    const html = screen()
    assert.match(html, /restart-hot/, 'the restart is the loud one here, because it is what applies the file')
    assert.match(text(html), /The daemon did not apply it\./)
    assert.match(text(html), /dispatch\.workspace_root/)
  })

  test('the daemon is down: the file is saved, no button, and the next boot is what takes it', () => {
    page.UI.set.phase = 'offline'
    page.UI.set.error = 'the daemon did not answer /reload within 4s'
    const html = screen()
    assert.ok(!html.includes('doRestart()'), 'a restart is not the mitigation for a daemon that is already not answering')
    assert.match(text(html), /takes this file at its next boot/)
    assert.match(text(html), /the daemon log names the key/)
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

  // ---- maintenance, and the marker on the nav (#362) ------------------------

  test('maintenance reads last, and says the daemon runs the files when it does', () => {
    const html = screen('maintenance')
    assert.match(text(html), /The daemon is running these files\./)
    assert.ok(!html.includes('restart-hot'), 'an ordinary restart button, because nothing disagrees')
    assert.match(html, /doRestart\(\)/, 'the one restart button lives here now')
    assert.deepEqual(rows(html), ['routing', 'projects', 'dispatch', 'github', 'maintenance'], 'still the last section, and it still reads last')
  })

  test('a daemon running something else names the keys, and the button goes red', () => {
    page.settings.dispatch.max_concurrent = 9
    page.settings.routing.models[0].active = true
    page.draft = JSON.parse(JSON.stringify(page.settings))
    const html = screen('maintenance')
    assert.match(html, /restart-hot/)
    assert.match(text(html), /The daemon is NOT running the files/)
    assert.match(text(html), /dispatch\.max_concurrent, routing\.models\.fable\.active/)
  })

  // Null is not agreement. A daemon that is not answering says what WAS true.
  test('a daemon that is not answering is unknown, never in step', () => {
    const p = { ...payload(), daemon_up: false }
    assert.equal(page.runningDiff(p), null)
    page.UI.drill.settings = { open: 'maintenance', list: false }
    assert.match(text(page.screenSettings(p)), /cannot tell whether the daemon runs these files: it is not answering/)
  })

  test('the settings nav item carries a marker while the daemon and the files disagree', () => {
    // `render` needs a mount point; everything else about the shell is inert.
    let html = ''
    page.document.getElementById = (id) => (id === 'app' ? { set innerHTML(v) { html = v } } : null)
    page.payload = payload()
    page.render()
    assert.ok(!/Settings <span class="n">/.test(html), 'nothing to say while the daemon runs the files')
    page.settings.dispatch.poll_interval_s = 5
    page.render()
    assert.match(html, /<span class="nav-label">Settings<\/span><span class="nav-marker">stale<\/span>/)
  })

  test('a restart the journal recorded reads as a sentence in the feed', () => {
    const p = payload({ events: [{ ts: at(30), type: 'restart_requested', by: 'dashboard', exit_code: 75 }] })
    assert.match(text(page.screenFeed(p)), /restart ordered by dashboard — the daemon exits 75/)
  })

  test('the reload reads as a sentence too, and so does one the daemon declined', () => {
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
    page.UI.act = { busy: null, said: null, note: null, mode: 'queue', tele: null }
    page.UI.fr = { view: 'cards', repo: 'all', type: 'all' }
  })

  // ---- start ---------------------------------------------------------------

  describe('start, on the frontier', () => {
    test('the button carries the routed model, so the account is named before it is spent', () => {
      const t = text(page.screenFrontier(payload()))
      assert.match(t, /Start → claude-opus-5 \(task default\)/)
      assert.match(t, /Start → gpt-5\.6-sol \(grilling default\)/)
    })

    test('it names the repo and the number, and the sidecar composes the rest', () => {
      const html = page.screenFrontier(payload())
      assert.match(html, /startTicket\('alp82\/curia','265'\)/)
    })

    test('a ticket an agent already holds shows the agent instead of a button that only refuses', () => {
      const p = payload()
      p.overview.agents[0].ticket = '265'
      const t = text(page.screenFrontier(p))
      assert.match(t, /⧗ dispatched — curia-263/)
      assert.equal(/startTicket\('alp82\/curia','265'\)/.test(page.screenFrontier(p)), false)
    })

    test('an unreadable fleet is not an idle one: the button stands and says curia cannot tell', () => {
      const p = payload({ agents: null, fleet_error: 'tmux is wedged' })
      const t = text(page.screenFrontier(p))
      assert.match(t, /Start/)
      assert.match(t, /cannot say whether this one is already running/)
    })

    test('an item carrying no routed model says so, rather than naming a model nobody chose', () => {
      const p = payload()
      delete p.overview.frontier.repos[0].items[0].model
      assert.match(text(page.screenFrontier(p)), /the routed model is not on this reading/)
    })

    test('the tree view starts a ticket too — the view is a way of reading, not a way of acting', () => {
      page.UI.fr.view = 'tree'
      assert.match(page.screenFrontier(payload()), /startTicket\('alp82\/curia','266'\)/)
    })

    test('a repo whose frontier could not be read offers no button there', () => {
      const t = text(page.screenFrontier(payload()))
      assert.match(t, /alp82\/aistack could not be read/)
      assert.match(t, /there may be takeable tickets there/)
    })
  })

  // ---- answer --------------------------------------------------------------

  describe('an answer, on the one answer surface', () => {
    test('a choice offers its own options, and the button sends the option verbatim', () => {
      const html = page.screenHome(payload())
      assert.match(html, /answerEsc\('esc-7','Drop the older note'\)/)
      assert.match(html, /answerEsc\('esc-7','Post both with stamps'\)/)
    })

    // An option is an AGENT's own words, and it lands inside an onclick
    // handler. A quote in it would close the JS string and open code, which
    // makes it the one value on this page that could ever do that.
    test('an option carrying a quote is escaped for the handler it sits in, not only for the html', () => {
      const raw = "x'),alert(1),('"
      const p = payload()
      p.overview.escalations[0].options = ["it's fine", raw]
      const html = page.screenHome(p)
      assert.ok(html.includes("answerEsc('esc-7','it\\'s fine')"), 'the quote is escaped, and the label still reads')
      assert.equal(html.includes(`,'${raw}')`), false, 'the raw option never reaches the handler')
      assert.ok(html.includes("x\\'),alert(1),(\\'"), 'every quote in it stays inside the string it was given')
    })

    test('every kind still takes words: an option list is not the only way to answer', () => {
      assert.match(page.screenHome(payload()), /answerTyped\('esc-7','ans-esc-7'\)/)
    })

    test('an approve-reject pair sends the two literals the daemon classifies', () => {
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

  describe('the diff digest on a live agent row', () => {
    beforeEach(() => {
      for (const k of Object.keys(page.diffs)) delete page.diffs[k]
      page.diffQueue.length = 0
      page.UI.act.diff = null
    })

    test('every live row carries the button, beside teleport', () => {
      const html = page.screenAgents(payload())
      assert.match(html, /openDiff\('curia-263'\)/)
    })

    test('a row nobody pressed reads nothing at all', () => {
      page.screenAgents(payload())
      assert.deepEqual(plain(page.diffQueue.filter((j) => j.key.startsWith('agent:'))), [])
      assert.deepEqual(plain(Object.keys(page.diffs).filter((k) => k.startsWith('agent:'))), [])
    })

    test('an open row waits on the count rather than drawing an empty change', () => {
      page.UI.act.diff = 'curia-263'
      assert.match(text(page.screenAgents(payload())), /counting the work so far/)
    })

    test('the read says it holds committed and uncommitted work together', () => {
      page.UI.act.diff = 'curia-263'
      const d = page.diffState('agent:curia-263')
      d.read = true
      d.digest = {
        uncommitted: true, files: 2, added: 9, deleted: 1, capped: false,
        list: [
          { path: 'src/app.mjs', added: 7, deleted: 1, status: 'M', binary: false, untracked: false, hunks: 2, from: null },
          { path: 'src/scratch.mjs', added: 2, deleted: 0, status: 'A', binary: false, untracked: true, hunks: null, from: null },
        ],
      }
      const t = text(page.screenAgents(payload()))
      assert.match(t, /2 files \+9 −1 — committed and uncommitted work together/)
      assert.match(t, /new, not committed yet/)
      assert.match(page.screenAgents(payload()), /toggleDiffFile\('agent:curia-263',1,'\/api\/diff\?agent=curia-263'\)/)
    })
  })

  // ---- note, teleport, cancel ----------------------------------------------

  describe('the three per-agent verbs', () => {
    test('every live agent row carries them', () => {
      const html = page.screenAgents(payload())
      assert.match(html, /noteBox\('curia-263'\)/)
      assert.match(html, /teleport\('curia-263','263'\)/)
      assert.match(html, /cancelAgent\('curia-263','alp82\/curia','263'\)/)
    })

    test('the note box states both delivery modes in ADR-0013\'s own terms', () => {
      page.UI.act.note = 'curia-263'
      const t = text(page.screenAgents(payload()))
      assert.match(t, /queue — it reads this with its next tool result/)
      assert.match(t, /interrupt — a short grace, then the words land as a user turn/)
      assert.match(page.screenAgents(payload()), /placeholder="say something to curia-263/)
    })

    test('queued is the default, so the mode nobody chose is the safe one', () => {
      assert.equal(page.UI.act.mode, 'queue')
      page.UI.act.note = 'curia-263'
      const html = page.screenAgents(payload())
      assert.match(html, /value="queue"|noteMode\('queue'\)/)
      assert.match(html, /name="nm-curia-263"[^>]*checked[^>]*onchange="noteMode\('queue'\)"/)
    })

    test('a note with no words is refused on the page, and nothing is sent', () => {
      page.document.getElementById = () => ({ value: '' })
      page.sendNote('curia-263', 'note-curia-263')
      assert.equal(page.UI.act.said.ok, false)
      assert.match(page.UI.act.said.text, /not a note/)
      page.document.getElementById = () => null
    })

    test('one box at a time, and pressing the same verb again closes it', () => {
      page.noteBox('curia-263')
      assert.equal(page.UI.act.note, 'curia-263')
      page.noteBox('curia-263')
      assert.equal(page.UI.act.note, null)
    })

    test('teleport shows the copyable command for the box, beside curia\'s own links', () => {
      page.UI.act.tele = 'curia-263'
      page.UI.act.said = { key: 'agent:curia-263', text: '🔗 timeline https://box.ts.net:8444/t/263', ok: true }
      const t = text(page.screenAgents(payload()))
      assert.match(t, /On the box itself, in a terminal:/)
      assert.match(page.screenAgents(payload()), /attach -t curia-263/)
      assert.match(t, /timeline/)
    })

    test('the copyable line goes in through the tmux container, which is where the server lives (#260)', () => {
      assert.match(page.attachCmd('curia-263'), /^docker compose .* exec tmux tmux -S \/run\/curia-tmux\/default attach -t curia-263$/)
    })
  })

  // ---- what curia said -----------------------------------------------------

  describe('the outcome of a press', () => {
    test('a command reply is curia\'s own sentence, rendered where the press was', () => {
      page.UI.act.said = { key: 'start:alp82/curia#265', text: '⚙️ `curia-265` spawned on **claude-opus-5**', ok: true }
      const html = page.screenFrontier(payload())
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

    test('a queued note says when the agent reads it; an interrupt says what it costs', () => {
      assert.match(page.outcome({ mode: 'queue', ok: true, agent: 'curia-263' }), /next tool result/)
      assert.match(page.outcome({ mode: 'interrupt', ok: true, session: 'curia-263', graceMs: 5000 }), /5s of grace/)
    })

    test('an interrupt curia refused still delivered the words — queued, which is the default anyway', () => {
      const said = page.outcome({ mode: 'interrupt', ok: false, why: 'curia-263 is waiting on esc-7', still_queued: true })
      assert.match(said, /waiting on esc-7/)
      assert.match(said, /stay queued/)
    })

    test('a note nothing took says only that, with no promise of delivery', () => {
      const said = page.outcome({ mode: 'queue', ok: false, why: 'curia is not running `curia-9`' })
      assert.match(said, /not running/)
      assert.equal(/queued/.test(said), false)
    })

    test('one act at a time: while a press is in flight every other control is disabled', () => {
      page.UI.act.busy = 'esc:esc-7'
      assert.match(page.screenFrontier(payload()), /button class="btn sm primary" disabled/)
      assert.match(page.screenAgents(payload()), /disabled/)
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
// behind it, where it goes, and that a daemon which is not answering is a chat
// that is not there, because every message reaches the overseer container
// through the daemon (#315).

describe('the chat screen (#267, the picker of #333)', () => {
  let page
  before(() => { page = loadPage() })
  // The screen reads `/api/console` on arrival, so every case below states what
  // that read answered. `null` is the read in flight, and it is NOT an empty
  // list — the two draw differently on purpose.
  const conv = (over) => ({
    key: 'console-2', session: 'curia-console-2', opened_at: at(600),
    last_turn_at: at(120), label: 'what is takeable on curia', ctx_pct: 31, ctx_over: false, ...over,
  })
  beforeEach(() => { page.conversations = { conversations: [conv()] } })

  test('a row opens ITS conversation at /chat, keyed on its own session', () => {
    const html = page.screenChat(payload())
    assert.match(html, /href="\/chat\?session=curia-console-2"/)
    const t = text(html)
    assert.match(t, /what is takeable on curia/, 'the label is the operator\'s own first message')
    assert.match(t, /console-2/)
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
    assert.match(t, /No conversations yet/)
    assert.match(t, /New conversation/, 'the one button is the only way one starts')
    assert.doesNotMatch(t, /console-\d/, 'a page read spends no number')
  })

  test('a list curia could not be asked for is not an empty one', () => {
    page.conversations = { conversations: null, error: 'the daemon answered 500 on /console' }
    const t = text(page.screenChat(payload()))
    assert.match(t, /could not read your conversations/)
    assert.match(t, /the daemon answered 500/)
    assert.doesNotMatch(t, /No conversations yet/)
  })

  test('the read in flight says so, and claims nothing about the list', () => {
    page.conversations = null
    const t = text(page.screenChat(payload()))
    assert.match(t, /Reading your conversations/)
    assert.doesNotMatch(t, /No conversations yet/)
  })

  test('the delete says the number is spent, because that is the part nobody can undo', () => {
    assert.match(page.screenChat(payload()), /onclick="doDeleteConversation\('console-2'\)"/)
    assert.match(text(page.screenChat(payload())), /Deleting one spends its number for good/)
  })

  test('it states the one thing the overseer cannot do, rather than leaving it to be found', () => {
    // #315: the overseer holds a reading shell now, so the limit that is left
    // is the write — the read-only token, and every effect crossing the daemon.
    assert.match(text(page.screenChat(payload())), /it cannot write one/)
    assert.match(text(page.screenChat(payload())), /read-only/)
  })

  test('a daemon that is not answering is a chat that is not there, and says which', () => {
    const p = payload()
    p.daemon_up = false
    p.error = 'connect ECONNREFUSED'
    p.error_since = at(30)
    const t = text(page.screenChat(p))
    assert.match(t, /The chat is down while the daemon restarts/)
    assert.match(t, /daemon restarting/, 'and the reading marker still says why')
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
    // #705 added a route to both halves and a field to `/overview`. A page
    // that read `github_app` from an older daemon would draw "no app" over a
    // box that has one, which is what the stamp exists to refuse.
    assert.match(src, /"\/api\/appsetup\/refresh"/)
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
  // read one out, and `sendText` refuses this session by name — so the typing
  // is theirs to do, and the panel must say so rather than showing a code that
  // does not exist.
  test('the anthropic lane asks for a paste-back and shows no code', () => {
    const t = text(page.screenCredentials(payload({
      credentials: { consumers: [], reauth: WAITING_REAUTH({ provider: 'anthropic', session: 'curia-auth-anthropic', typed: true, code: null }) },
    })))
    assert.match(t, /Paste the code the browser shows back into the terminal/)
    assert.match(t, /curia cannot type it for you/)
    assert.ok(!/Enter this code/.test(t))
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
  test('a scrape that missed says so and hands over the terminal', () => {
    const t = text(page.screenCredentials(payload({
      credentials: { consumers: [], reauth: WAITING_REAUTH({ url: null, code: null }) },
    })))
    assert.match(t, /curia could not read the login off the pane/)
    assert.match(t, /The terminal always works/)
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
  // fact about what this daemon owns.
  test('unowned is a row with nothing to press, not a missing row', () => {
    const t = text(page.screenCredentials(payload({
      credentials: {
        consumers: [{ consumer: 'codex', provider: 'openai', state: 'unowned', expires_at: null, lane: LANE('openai'), why: 'this daemon brokers no model credential for that provider' }],
        reauth: null,
      },
    })))
    assert.match(t, /codex openai unowned/)
    assert.match(t, /brokers no model credential/)
    assert.match(t, /nothing to press/)
  })

  // Null is not empty (rule 2). A daemon older than this page answers with no
  // credentials section at all, and that is not a box that owns none.
  test('a snapshot with no credentials section is not a daemon with no credentials', () => {
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

// ---------------------------------------------------------------------------
// The GitHub App section (#705), on the daemon flow of #694.
//
// What is pinned here is the half a human reading the preview cannot check:
// that a box with no app offers the create path and a box with one states its
// facts without a restart in the sentence, that every watched owner carries a
// state WORD beside its color and an install link where the state is not
// installed, that an unmeasured owner never renders as an uninstalled one, and
// — the boundary #694 drew — that the browser relays `code` and `state` and
// nothing else, to a redirect it never composed.

describe('the GitHub App section (#705)', () => {
  let page

  beforeEach(() => {
    page = loadPage()
    page.settings = SETTINGS()
    page.draft = JSON.parse(JSON.stringify(page.settings))
    page.UI.drill.settings = { open: 'github', list: false }
  })

  const screen = (p = payload()) => page.screenSettings(p)
  const withApp = (app) => payload({ github_app: app })
  const noApp = () => withApp({
    configured: false,
    app_id: null, slug: null, name: null, html_url: null, bot_login: null, key_file: null,
    read_at: null, error: null,
    owners: [
      { owner: 'alp82', installed: null, install_url: null },
      { owner: 'example', installed: null, install_url: null },
    ],
  })

  test('the list row says whether the app exists and how many owners hold it', () => {
    assert.match(text(screen()), /GitHub App 1 of 1 owner installed/)
    assert.match(text(screen(noApp())), /GitHub App no app — no agent can be dispatched/)
  })

  test('a box with no app offers the name, the create action and the manual route', () => {
    const html = screen(noApp())
    assert.match(html, /id="set-app-name"/)
    assert.match(html, /onclick="beginAppSetup\(\)"/)
    assert.match(html, /docs\/github-app\.md/)
    assert.match(text(html), /no GitHub App, so no agent can be dispatched/)
  })

  test('a created app states its own facts, and a restart is in none of them', () => {
    const t = text(screen())
    assert.match(t, /app id 317489578/)
    assert.match(t, /commits as curia-sh\[bot\]/)
    assert.match(t, /\.curia-app\.pem/)
    assert.match(t, /mints with it without a restart/)
    assert.ok(!screen().includes('id="set-app-name"'), 'there is nothing left to create')
  })

  test('a conversion that just landed says so from the page that asked for it', () => {
    page.UI.app.facts = { ok: true, app_id: '9', slug: 'curia-box', name: 'curia-box' }
    assert.match(text(screen()), /Created curia-box the daemon adopted it — no restart/)
    page.UI.app.facts = null
    page.UI.app.error = 'that GitHub App setup was already converted'
    assert.match(text(screen()), /The GitHub App setup failed — that GitHub App setup was already converted/)
  })

  test('every watched owner carries its state and, where it is missing, GitHub’s install link', () => {
    const p = withApp({
      ...OVERVIEW().github_app,
      owners: [
        { owner: 'alp82', installed: true, install_url: 'https://github.com/apps/curia-sh/installations/new' },
        { owner: 'example', installed: false, install_url: 'https://github.com/apps/curia-sh/installations/new' },
      ],
    })
    const t = text(screen(p))
    assert.match(t, /alp82 installed ✓/)
    assert.match(t, /example not installed install on GitHub/)
    assert.match(screen(p), /href="https:\/\/github\.com\/apps\/curia-sh\/installations\/new"/)
  })

  // The rule the whole page holds to (#262 rule 2), on the one section where
  // getting it wrong sends the operator to GitHub to repair an install that is
  // already right.
  test('an owner nothing has measured is not an owner without the app', () => {
    const t = text(screen(noApp()))
    assert.match(t, /alp82 not measured/)
    assert.ok(!t.includes('not installed'), 'unmeasured says its own word')
  })

  test('a snapshot older than this page says so, rather than drawing a box with no app', () => {
    const p = payload()
    delete p.overview.github_app
    assert.match(text(screen(p)), /carries no GitHub App section/)
  })

  // ---- the two presses ------------------------------------------------------

  test('the re-read is one press, and it names what it is for', () => {
    assert.match(screen(), /onclick="refreshInstalls\(\)"/)
    page.UI.hints['set-app-installs'] = true
    assert.match(text(screen()), /turns the owner green — there is no second setup to run/)
  })

  test('the re-read asks the sidecar and nothing else', async () => {
    const calls = []
    page.fetch = async (path, init) => {
      if (path.startsWith('/api/appsetup')) calls.push([path, init.body])
      return { ok: true, json: async () => ({ ok: true }) }
    }
    await page.refreshInstalls()
    assert.deepEqual(calls, [['/api/appsetup/refresh', '{}']])
  })

  test('a GitHub curia could not read leaves the last reading standing and says the failure', () => {
    const t = text(screen(withApp({ ...OVERVIEW().github_app, error: 'GitHub answered HTTP 502' })))
    assert.match(t, /The last read of GitHub failed — GitHub answered HTTP 502/)
    assert.match(t, /alp82 installed ✓/, 'the reading before it still stands')
  })

  test('create with no name is refused here, before it costs a call', async () => {
    let calls = 0
    page.fetch = async () => { calls += 1; return { ok: true, json: async () => ({}) } }
    await page.beginAppSetup()
    assert.equal(calls, 0)
    assert.match(page.UI.act.said.text, /Name the app first/)
  })

  // The manifest travels as a FORM POST to github.com, which is the only shape
  // GitHub's manifest flow takes. The action and the manifest are both the
  // daemon's — the page composes neither, and in particular composes no
  // redirect: a browser-named one would be a way to send the conversion code
  // somewhere else (#694).
  test('the manifest is posted to the action the daemon stated, with the state on it', async () => {
    const node = () => ({ children: [], appendChild(c) { this.children.push(c) } })
    const form = node()
    let submitted = false
    form.submit = () => { submitted = true }
    const created = []
    page.document.createElement = (tag) => {
      const el = tag === 'form' ? form : node()
      created.push(tag)
      return el
    }
    page.document.body = node()
    page.fetch = async () => ({
      ok: true,
      json: async () => ({
        state: 'a'.repeat(64),
        action: 'https://github.com/settings/apps/new?state=' + 'a'.repeat(64),
        manifest: { name: 'curia-box', redirect_url: 'https://box.ts.net:8443/' },
      }),
    })
    page.UI.app.name = 'curia-box'
    await page.beginAppSetup()
    assert.equal(form.method, 'POST')
    assert.match(form.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=a{64}$/)
    assert.deepEqual(form.children.map((c) => [c.name, c.type]), [['manifest', 'hidden']])
    assert.deepEqual(JSON.parse(form.children[0].value), {
      name: 'curia-box', redirect_url: 'https://box.ts.net:8443/',
    })
    assert.ok(submitted)
  })

  // THE BOUNDARY. GitHub redirects back to the address the daemon composed,
  // with a code and a state on it. Those two values are the whole of what the
  // browser relays, and what comes back is the app's public facts — the
  // conversion response and the private key never cross this wire.
  test('the return from github.com relays code and state, and nothing else', async () => {
    const sent = []
    page.location.search = '?code=abc123&state=' + 'b'.repeat(64) + '&redirect_uri=https://evil.example'
    page.fetch = async (path, init) => {
      if (!path.startsWith('/api/appsetup')) return { ok: true, json: async () => ({}) }
      sent.push([path, JSON.parse(init.body)])
      return { ok: true, json: async () => ({ ok: true, app_id: '9', slug: 'curia-box', name: 'curia-box' }) }
    }
    const back = page.appSetupReturn()
    await page.finishAppSetup(back.code, back.state)
    assert.deepEqual(sent, [['/api/appsetup/convert', { code: 'abc123', state: 'b'.repeat(64) }]])
    assert.equal(page.UI.app.busy, false)
    assert.equal(page.UI.app.facts.slug, 'curia-box')
  })

  test('a spent code is taken off the address bar, so a reload is not a second failure', () => {
    const replaced = []
    page.location.search = '?code=abc123&state=' + 'b'.repeat(64)
    page.location.pathname = '/'
    page.history = { replaceState: (_s, _t, url) => replaced.push(url) }
    const back = page.appSetupReturn()
    assert.equal(back.code, 'abc123')
    assert.equal(back.state, 'b'.repeat(64))
    assert.deepEqual(replaced, ['/#settings'])
  })

  test('an ordinary address starts no conversion at all', () => {
    page.location.search = ''
    assert.equal(page.appSetupReturn(), null)
    page.location.search = '?code=abc123'
    assert.equal(page.appSetupReturn(), null, 'a code with no state is not a return curia started')
  })

  test('a refused conversion is the operator’s own sentence, not a status code', async () => {
    page.fetch = async (path) => (path.startsWith('/api/appsetup')
      ? { ok: false, json: async () => ({ error: 'that GitHub App setup did not start on this box, or it lapsed' }) }
      : { ok: true, json: async () => ({}) })
    await page.finishAppSetup('abc123', 'c'.repeat(64))
    assert.match(page.UI.app.error, /did not start on this box/)
    assert.equal(page.UI.app.facts, null)
  })
})

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
import { DEFAULT_DASHBOARD_INDEX } from '../src/dashboard.mjs'

// The page boots itself only when a real document holds `#app`, so this fake
// one keeps the load inert: no render, no poll, no timer. `fetch` never settles
// on purpose — a rejection would flip the offline marker and every screen below
// would be testing that instead.
function loadPage() {
  const html = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
  const script = /<script>([\s\S]*)<\/script>/.exec(html)
  assert.ok(script, 'the page carries its script inline — there is no build step')
  const ctx = vm.createContext({
    document: { title: '', getElementById: () => null, addEventListener() {}, visibilityState: 'hidden' },
    window: { addEventListener() {} },
    location: { hash: '' },
    fetch: () => new Promise(() => {}),
    setTimeout,
    clearTimeout,
    console,
  })
  vm.runInContext(script[1], ctx)
  return ctx
}

// The wire shape of `GET /overview` (#262), with the ctx meter #264 joins onto
// each agent. Every fixture below starts from this and overrides one section.
const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString()
const ahead = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString()

const OVERVIEW = () => ({
  at: at(0),
  daemon: { port: 4271, uptime_s: 7200, auto_dispatch: true, max_concurrent: 3 },
  agents: [
    {
      session: 'curia-263', repo: 'alp82/curia', ticket: '263', title: 'The sidecar stands up',
      model: 'claude-opus-5', reviewer: false, state: 'ready', uptime_s: 900,
      result_received: false, tmux_live: true, waiting_on: [], ctx_pct: 41, ctx_over: false,
    },
    {
      session: 'curia-255', repo: 'alp82/curia', ticket: '255', title: 'The note queue drains in order',
      model: 'gpt-5.6-sol', reviewer: false, state: 'ready', uptime_s: 3600,
      result_received: false, tmux_live: true, waiting_on: [{ id: 'esc-7', kind: 'choice' }],
      ctx_pct: 68, ctx_over: false,
    },
    {
      session: 'curia-review-263', repo: 'alp82/curia', ticket: '263', title: 'Cross-check of curia-263',
      model: 'gpt-5.6-sol', reviewer: true, state: 'ready', uptime_s: 120,
      result_received: false, tmux_live: true, waiting_on: [], ctx_pct: null, ctx_over: false,
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
  }],
  bridge: 'up',
  bridge_health: { state: 'up', since: at(9000), unhealthy_for_s: 0, last_error: null },
  usage: [
    { provider: 'anthropic', from: 'account', session: null, windows: [
      { label: '5h', pct: 58, elapsed_pct: 48, resets_at: ahead(90), fresh: true },
      { label: '7d', pct: 22, elapsed_pct: 41, resets_at: ahead(4000), fresh: true },
    ] },
    { provider: 'openai', from: 'transcript', session: 'curia-255', windows: [
      { label: '5h', pct: 97, elapsed_pct: 48, resets_at: ahead(30), fresh: true },
    ] },
  ],
  events: [
    { ts: at(600), type: 'agent_spawned', agent: 'curia-255', repo: 'alp82/curia', ticket: '255', model: 'gpt-5.6-sol', harness: 'codex' },
    { ts: at(400), type: 'esc_open', id: 'esc-7', agent: 'curia-255', ticket: '255', kind: 'choice', prompt: 'Two notes race the same expiry line.' },
    { ts: at(60), type: 'credentials_swept', agent: 'curia-263', ticket: '263', repo: 'alp82/curia' },
  ],
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

// What a reader sees, with the markup taken out.
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

// The page runs in a vm, so an object it built has a different realm's
// prototype and deepEqual would refuse it on that alone.
const plain = (x) => JSON.parse(JSON.stringify(x))

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
      assert.match(t, /Needs you \(3\)/, 'the list adds the spent window the count does not')
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

    test('the provider strip says each window once, and no agent row repeats it', () => {
      const html = page.screenHome(payload())
      assert.equal((html.match(/class="prov"/g) ?? []).length, 2, 'one reading per provider')
      assert.match(text(html), /anthropic 5h 58% 7d 22%/)
      // The windows are an account fact. A per-agent copy would be the thing
      // #248 removed from the fleet.
      assert.equal(/<td[^>]*>[^<]*7d/.test(html), false)
    })

    test('a spent window joins the attention list and says when it rolls', () => {
      const t = text(page.screenHome(payload()))
      assert.match(t, /openai the 5h window is spent at 97%/)
      assert.match(t, /it rolls at \d\d:\d\d/)
    })

    test('the needs-you count is escalations plus the gate, and the tab title carries it', () => {
      assert.equal(page.needsYou(payload().overview), 2)
      assert.equal(page.needsYou(payload({ escalations: [], review_gate: [] }).overview), 0)
      // The tab title is written in render(), off that same function.
      page.payload = payload()
      const el = { innerHTML: '' }
      page.document.getElementById = () => el
      page.render()
      assert.equal(page.document.title, '(2) curia')
      page.payload = payload({ escalations: [], review_gate: [] })
      page.render()
      assert.equal(page.document.title, 'curia')
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
  dispatch: { auto_dispatch: false, max_concurrent: 6, poll_interval_s: 60 },
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

  const screen = (section = 'routing') => {
    page.UI.set.section = section
    return page.screenSettings(payload())
  }

  test('it is a screen now, not a promise of one', () => {
    assert.ok(!text(screen()).includes('lands on #265'))
    assert.match(text(screen()), /Settings/)
  })

  test('the two files it writes are named on the screen', () => {
    assert.match(text(screen()), /curia\.yaml · routing\.yaml/)
  })

  // ---- routing -------------------------------------------------------------

  test('the ticket-type table leads and the model list sits behind one click', () => {
    const t = text(screen('routing'))
    assert.match(t, /ticket type default model/)
    assert.match(t, /2 of 3 models active · manage/)
    assert.ok(!t.includes('runs on'), 'the model list is closed until it is asked for')
    page.UI.set.models = true
    const open = text(screen('routing'))
    assert.match(open, /2 of 3 models active · close/)
    assert.match(open, /runs on/)
    assert.match(open, /gpt gpt-5\.6-sol openai · codex/, 'the CLI name rides beside the routing label')
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

  test('dispatch carries the switch and the two numbers, each with what it costs', () => {
    const t = text(screen('dispatch'))
    assert.match(t, /auto_dispatch/)
    assert.match(t, /every dispatch is one the operator ordered/)
    assert.match(t, /max_concurrent How many agents may run at once\. Each one costs a container/)
    assert.match(t, /poll_interval_s/)
    assert.ok(!t.includes('workspace_root'), 'a path on the daemon\'s filesystem is not a thing this screen writes')
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
    page.setDispatchField('poll_interval_s', '30')
    assert.strictEqual(page.settingsPatch().dispatch.poll_interval_s, 30)
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

  // ---- the two-phase banner ------------------------------------------------

  test('phase one: unsaved changes count, and save is the primary button', () => {
    page.setDispatchField('max_concurrent', '4')
    const html = screen()
    assert.match(text(html), /1 unsaved change\./)
    assert.match(html, /class="btn primary" {2}onclick="doSave\(\)"/)
    assert.ok(!html.includes('restart-hot'), 'nothing is applied yet, so nothing is loud')
  })

  test('phase two: saved, and the RESTART is the loud one — the daemon still runs the old config', () => {
    page.UI.set.phase = 'saved'
    page.UI.set.note = 'Wrote curia.yaml, atomically, with the comments kept.'
    const html = screen()
    assert.match(html, /restart-hot/)
    assert.match(text(html), /Saved ✓ Restart to apply/)
    assert.match(text(html), /Wrote curia\.yaml, atomically, with the comments kept\./)
    assert.match(text(html), /The daemon still runs the config it booted with\./)
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

  test('a restart the journal recorded reads as a sentence in the feed', () => {
    const p = payload({ events: [{ ts: at(30), type: 'restart_requested', by: 'dashboard', exit_code: 75 }] })
    assert.match(text(page.screenFeed(p)), /restart ordered by dashboard — the daemon exits 75/)
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
  })
})

// ---------------------------------------------------------------------------
// the chat (#267)
// ---------------------------------------------------------------------------
//
// The screen draws no message and frames nothing: the chat is the timeline
// page, served at /chat. So what a test can pin is what the door SAYS — who is
// behind it, where it goes, and that a daemon which is not answering is a chat
// that is not there, because the overseer lives inside the daemon.

describe('the chat screen (#267)', () => {
  let page
  before(() => { page = loadPage() })

  test('the door names the overseer and opens the timeline at /chat', () => {
    const html = page.screenChat(payload())
    assert.match(html, /href="\/chat\?session=curia-overseer"/)
    const t = text(html)
    assert.match(t, /This is the overseer/)
    assert.match(t, /every watched repo/)
    assert.match(t, /curia-overseer/)
  })

  test('it states the one thing the overseer cannot do, rather than leaving it to be found', () => {
    assert.match(text(page.screenChat(payload())), /no shell and no checkout/)
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
})

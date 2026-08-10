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

import { test, describe, before } from 'node:test'
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
        { number: 265, title: 'The settings write', labels: ['wayfinder:task'], map: 244, mapTitle: 'Curia gets a face', unblocks: [
          { number: 267, title: 'The chat embeds the timeline attach', labels: ['wayfinder:task'] },
        ] },
        { number: 266, title: 'The verbs reach the browser', labels: ['wayfinder:grilling'], map: 244, mapTitle: 'Curia gets a face', unblocks: [] },
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
      assert.match(t, /Drop the older note · Post both with stamps/, 'and its options are named')
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

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
      dispatch: { auto_dispatch: true, max_concurrent: 3, poll_interval_s: 60 },
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
    { provider: 'openai', from: 'transcript', session: 'curia-255', windows: [
      { label: '5h', pct: 97, elapsed_pct: 48, resets_at: ahead(30), fresh: true },
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

    test('a spent window joins the attention list and says when it rolls', () => {
      const t = text(page.screenHome(payload()))
      assert.match(t, /openai the 5h window is spent at 97%/)
      assert.match(t, /it rolls at \d\d:\d\d/)
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
  dispatch: { auto_dispatch: true, max_concurrent: 3, poll_interval_s: 60 },
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

  // ---- the banner: one act, three outcomes (#362) ---------------------------

  test('before a save: unsaved changes count, save is the primary button, and no restart is offered', () => {
    page.setDispatchField('max_concurrent', '4')
    const html = screen()
    assert.match(text(html), /1 unsaved change\./)
    assert.match(html, /class="btn primary" {2}onclick="doSave\(\)"/)
    assert.ok(!html.includes('restart-hot'), 'nothing is applied yet, so nothing is loud')
    assert.ok(!html.includes('doRestart()'), 'the bar is just Save — the restart lives in Maintenance now')
  })

  test('applied: one sentence, and no button — the daemon took it', () => {
    page.UI.set.phase = 'applied'
    page.UI.set.note = 'Wrote curia.local.yaml, atomically, with the comments kept.'
    const html = screen()
    assert.match(text(html), /Saved ✓/)
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
    const tabs = [...html.matchAll(/onclick="setSection\('(\w+)'\)"/g)].map((m) => m[1])
    assert.deepEqual(tabs, ['routing', 'projects', 'dispatch', 'maintenance'], 'the fourth section, and it reads last')
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
    page.UI.set.section = 'maintenance'
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
    assert.match(html, /Settings <span class="n" title="the daemon is not running these files">/)
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
  })

  // Arriving is what takes the read. Settings holds its copy because a config
  // file changes when somebody saves it; this list carries a context percent
  // and a last-turn time, and both move with every turn from any device.
  test('every arrival on the Chat screen re-reads the list', () => {
    const src = fs.readFileSync(DEFAULT_DASHBOARD_INDEX, 'utf8')
    assert.match(src, /if \(k === "chat"\) loadConversations\(\)/)
  })
})

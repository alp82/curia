// `GET /overview` (#262) — the dashboard's one read of the daemon.
//
// Two halves, and they are tested two different ways on purpose.
//
// The ROUTE is a wire contract between two processes: the daemon and the
// sidecar of #263, which holds no secret, no GitHub token and no journal
// handle. A field that quietly changes name or nesting breaks a page nothing in
// this repo compiles against, so the shape is pinned against a REAL boot —
// src/index.mjs on an ephemeral port, the shipped code path, exactly as the
// CSRF suite does it.
//
// The FRONTIER STAMP is a dispatcher fact: reconcile computes the two-level
// frontier with the credentials that pass already holds, and stamps the instant
// it did. That is driven through the Dispatcher's injected `deps` seam — no gh,
// no tmux, no live box.

import { test, describe, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_ROUTES } from '../src/agenttoken.mjs'
import { Dispatcher } from '../src/dispatch.mjs'
import { directUnblocks } from '../src/github.mjs'
import { Reduction, RECENT_EVENTS, RECENT_OUTCOMES } from '../src/reduction.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'
import { ctxOnWire } from '../src/usage.mjs'
import { freePort, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml, TEST_PINS } from './fixtures/sandbox.mjs'
import { journalEvents, emptyQuestions } from './fixtures/journal.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.once('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

describe('GET /overview (index.mjs, real boot)', () => {
  let tmp
  let child
  let port
  let watch
  let tmuxShim

  const setTmux = (body) => {
    fs.writeFileSync(tmuxShim, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(tmuxShim, 0o755)
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overview-test-'))
    const cfgDir = path.join(tmp, 'config')
    const dataDir = path.join(tmp, 'data')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    // Inert failing stubs: boot reconcile's gh read comes back indeterminate,
    // which is a failed pass by design — and a failed pass is exactly the state
    // that must still serve an honest overview.
    for (const bin of ['gh', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    // tmux answers as a box with no server, which is POSITIVE evidence of no
    // sessions rather than an unreadable fleet — see tmux.mjs's NO_SERVER_RE.
    // One test below rewrites this file to make the read indeterminate instead.
    tmuxShim = path.join(shim, 'tmux')
    setTmux('echo "no server running on /tmp/tmux-0/default" >&2\nexit 1')
    const [daemonPort, ttydPort, servePort, proxyPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
    port = daemonPort
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:',
      '  - repo: example/fixture',
      '    mode: ready-for-agent',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 3',
      '  poll_interval_s: 60',
      `  workspace_root: ${path.join(tmp, 'work')}`,
      '  claim_login: alp82',
      '  ready_timeout_s: 5',
      '  confirm_ttl_h: 1',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      ...skillsYaml(seedSkillsRoot(tmp)),
      ...sandboxYaml(),
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
      'defaults:',
      '  untyped: sonnet',
      'models:',
      '  sonnet: { provider: anthropic, harness: claude }',
      'harnesses:',
      '  claude:',
      '    template: claude --model {model} "$(cat {prompt_file})"',
      "    ready: '⏵⏵|bypass permissions'",
      '    tool_channel_grace_s: 15',
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '', // REST-only: the overview must never depend on the bridge
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)
    await waitForBoot(watch, async () => {
      try {
        return (await request(port, 'GET', '/state')).status === 200
      } catch { return false }
    }, 'the /state route')
    // Listening is not settled. Boot reconcile runs AFTER the bind, and the
    // frontier is the last thing it does — so wait for the stamp, and every
    // test below reads a daemon that has finished booting rather than racing it.
    await waitForBoot(watch, async () => {
      try {
        return JSON.parse((await request(port, 'GET', '/overview')).body).frontier.computed_at !== null
      } catch { return false }
    }, 'a frontier stamped by boot reconcile')
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const overview = async () => {
    const res = await request(port, 'GET', '/overview')
    assert.equal(res.status, 200)
    return JSON.parse(res.body)
  }

  test('the route answers every section the console shell draws', async () => {
    const o = await overview()
    assert.match(o.at, /^\d{4}-\d{2}-\d{2}T/, 'the payload dates itself')
    assert.deepEqual(o.daemon, {
      port, uptime_s: o.daemon.uptime_s, auto_dispatch: false, max_concurrent: 3,
      config: o.daemon.config,
    })
    assert.ok(Number.isFinite(o.daemon.uptime_s))
    // The six reloadable settings this daemon is RUNNING, stamped (#362). The
    // console compares them against the file it read, which is what lets a save
    // say "applied" about something curia measured.
    assert.match(o.daemon.config.loaded_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(o.daemon.config.dispatch, { auto_dispatch: false, max_concurrent: 3, poll_interval_s: 60 })
    assert.deepEqual(o.daemon.config.watch, [{ repo: 'example/fixture', mode: 'ready-for-agent' }])
    assert.deepEqual(o.daemon.config.routing, {
      defaults: [{ type: 'untyped', model: 'sonnet' }],
      models: [{ name: 'sonnet', active: true }],
    })
    for (const key of ['agents', 'untracked', 'recent', 'escalations', 'review_gate', 'usage', 'pre_cooling', 'events']) {
      assert.ok(Array.isArray(o[key]), `${key} is a list`)
    }
    assert.equal(o.fleet_error, null, 'tmux answered, so the fleet is a reading rather than a refusal')
    // A bridgeless daemon says down in both spellings — the string /state
    // already gave this reader, and the whole record beside it.
    assert.equal(o.bridge, 'down')
    assert.deepEqual(o.bridge_health, { state: 'down', since: null, unhealthy_for_s: 0, last_error: null })
  })

  test('an unreadable fleet is null and says why, and every other section still answers', async () => {
    // The evidence rule on a page (tmux.mjs): a wedged tmux is not "no agents".
    // Serving `[]` here would draw an idle box over a live one, and 500-ing the
    // route would blank the feed, the escalations and the frontier as well —
    // exactly when the operator most needs to see them.
    setTmux('echo "connect failed: no such file or directory" >&2\nexit 1')
    try {
      const o = await overview()
      assert.equal(o.agents, null)
      assert.equal(o.untracked, null)
      assert.equal(o.recent, null)
      assert.match(o.fleet_error, /indeterminate/)
      assert.ok(Array.isArray(o.events) && o.events.length > 0, 'the feed still answers')
      assert.ok(Array.isArray(o.escalations), 'and so do the escalations')
      assert.ok(o.frontier, 'and so does the frontier')
    } finally {
      setTmux('echo "no server running on /tmp/tmux-0/default" >&2\nexit 1')
    }
  })

  test('boot reconcile computes the frontier, and a repo it could not read says so', async () => {
    // The frontier is the one section the route does not compute: reconcile
    // does, on the credentials that pass already holds, and stamps it. This
    // boot's `gh` stub fails, so the repo carries its error — which is a
    // different fact from an empty frontier, and renders differently.
    const o = await overview()
    assert.ok(Number.isFinite(Date.parse(o.frontier.computed_at)), 'boot reconcile stamped it')
    assert.deepEqual(o.frontier.repos.map((r) => r.repo), ['example/fixture'])
    assert.match(o.frontier.repos[0].error, /gh api/)
  })

  test('the feed carries the daemon journal, and never the journal itself', async () => {
    const o = await overview()
    assert.ok(o.events.length > 0, 'a booted daemon has journalled something')
    assert.ok(o.events.length <= 100, 'the feed is the tail, not the whole journal')
    for (const ev of o.events) assert.ok(ev.type && ev.ts, 'every event names itself and dates itself')
    assert.equal(JSON.stringify(o).includes('events.db'), false, 'the journal stays daemon-private')
  })

  test('open escalations and the review gate are two lists, and the gate carries its pull request', async () => {
    const open = async (kind, prompt) => {
      const res = await request(port, 'POST', '/escalate', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'curia-1', ticket: '1', kind, prompt }),
      })
      assert.equal(res.status, 200)
      return JSON.parse(res.body).id
    }
    const askId = await open('free-text', 'which way round?')
    const gateId = await open(REVIEW_KIND, 'is this done?')

    const o = await overview()
    const ask = o.escalations.find((r) => r.id === askId)
    assert.ok(ask, 'the question is an open escalation')
    assert.equal(ask.kind, 'free-text')
    assert.equal(ask.prompt, 'which way round?')
    assert.equal(ask.agent, 'curia-1')
    assert.equal(ask.rendered, false, 'no bridge rendered it')
    assert.equal(ask.payload_hash, undefined, 'the gate\'s own bookkeeping stays off the wire')

    assert.equal(o.escalations.some((r) => r.id === gateId), false, 'the gate is not in the escalation list')
    const gate = o.review_gate.find((r) => r.id === gateId)
    assert.ok(gate, 'the gate is its own list')
    assert.equal(gate.kind, REVIEW_KIND)
    assert.ok('pull_request' in gate, 'the gate card carries the pull request nothing else carries')
    // The digest (#355) is the second thing only the gate carries. This gate
    // was opened straight through `POST /escalate`, so nothing counted a diff
    // for it — and the field is present and NULL rather than absent, because
    // the card has to tell "curia could not count this" from "nothing changed".
    assert.ok('diff' in gate, 'the gate card carries the digest counted when it opened')
    assert.equal(gate.diff, null)
    assert.ok('diff_error' in gate)
    assert.equal('diff' in ask, false, 'only the gate carries a diff')

    // And an answered escalation leaves both lists at once.
    const answered = await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: askId, answer: 'this way' }),
    })
    assert.equal(answered.status, 200)
    const after = await overview()
    assert.equal(after.escalations.some((r) => r.id === askId), false)
  })

  test('the route is loopback tooling only — a browser and a container are both refused', async () => {
    const cross = await request(port, 'GET', '/overview', { headers: { origin: 'http://evil.com' } })
    assert.equal(cross.status, 403, 'the CSRF gate covers the whole surface, this route included')
    assert.equal(AGENT_ROUTES.has('/overview'), false, 'an agent container cannot reach the operator\'s own read')
  })

  // ---- GET /diff (#355) ------------------------------------------------------
  //
  // The one route the console reads OFF the poll. It is addressed by naming a
  // thing curia already knows — an escalation id or an agent — and the daemon
  // resolves the worktree itself. Nothing here can be pointed at a path.
  describe('GET /diff, the digest and the hunks on demand', () => {
    const diff = async (q) => {
      const res = await request(port, 'GET', `/diff${q}`)
      return { status: res.status, body: JSON.parse(res.body) }
    }

    test('it refuses a call that names neither a gate nor an agent', async () => {
      const r = await diff('')
      assert.equal(r.status, 400)
      assert.match(r.body.error, /escalation id or an agent/)
    })

    test('an escalation that is not the review gate carries no diff, and says so', async () => {
      const res = await request(port, 'POST', '/escalate', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'curia-1', ticket: '1', kind: 'free-text', prompt: 'which way?' }),
      })
      const id = JSON.parse(res.body).id
      const r = await diff(`?esc=${id}`)
      assert.equal(r.status, 400)
      assert.match(r.body.error, /not a review gate/)
    })

    test('a gate curia could not count answers null with its reason, never an empty file list', async () => {
      const res = await request(port, 'POST', '/escalate', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'curia-1', ticket: '1', kind: REVIEW_KIND, prompt: 'is this done?' }),
      })
      const id = JSON.parse(res.body).id
      const r = await diff(`?esc=${id}`)
      assert.equal(r.status, 200)
      assert.equal(r.body.digest, null)
      assert.equal(r.body.uncommitted, false, 'a gate states what it counted, and it counted commits')

      // A file index against a digest that does not exist is not a file.
      const f = await diff(`?esc=${id}&file=0`)
      assert.equal(f.status, 200)
      assert.equal(f.body.hunks, null)
    })

    test('an escalation curia has no record of is a 404, not a silent null', async () => {
      const r = await diff('?esc=esc-99999')
      assert.equal(r.status, 404)
    })

    test('the live row read says it holds uncommitted work, and names its own failure', async () => {
      const r = await diff('?agent=curia-4242')
      assert.equal(r.status, 200)
      assert.equal(r.body.uncommitted, true, 'a live row shows committed and uncommitted work together')
      assert.equal(r.body.digest, null)
      assert.ok(r.body.error, 'an unresolvable agent says why rather than answering an empty change')
    })

    test('it is loopback tooling too — no browser, no container', async () => {
      const cross = await request(port, 'GET', '/diff?agent=curia-1', { headers: { origin: 'http://evil.com' } })
      assert.equal(cross.status, 403)
      assert.equal(AGENT_ROUTES.has('/diff'), false, 'an agent has its own worktree and no business reading another\'s')
    })
  })
})

describe('the context meter on the wire (#264)', () => {
  // The dashboard's fleet table and agents table both carry a ctx column, and
  // `dispatcher.status()` cannot fill it: that read asks tmux and the journal,
  // never a transcript. So the route joins the meter on, and the join is the
  // thing that must not cost a row.
  test('a reading crosses as a percentage, and the over-100 mark crosses with it', () => {
    assert.deepEqual(ctxOnWire(() => ({ ctxPct: 41, ctxOver: false })), { ctx_pct: 41, ctx_over: false })
    // Over 100% is the daemon's complaint about the denominator (#146), not a
    // reading about the agent. It travels rather than being flattened here.
    assert.deepEqual(ctxOnWire(() => ({ ctxPct: 118, ctxOver: true })), { ctx_pct: 118, ctx_over: true })
  })

  test('no reading is null, never zero — an unmeasured context and an empty one are not one fact', () => {
    assert.deepEqual(ctxOnWire(() => ({ ctxPct: null, ctxOver: false })), { ctx_pct: null, ctx_over: false })
    assert.deepEqual(ctxOnWire(() => null), { ctx_pct: null, ctx_over: false })
  })

  test('a meter that throws costs this one column and never the agent', () => {
    assert.deepEqual(ctxOnWire(() => { throw new Error('no transcript on disk') }), { ctx_pct: null, ctx_over: false })
  })
})

describe('the journal tail the feed reads (#262)', () => {
  let dir
  const reduction = () => new Reduction(dir)

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overview-reduction-')) })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('the ring holds the last events, oldest first, and survives a restart as the file does', () => {
    const a = reduction()
    for (let i = 1; i <= RECENT_EVENTS + 20; i += 1) a.journal('notify', { n: i })
    const tail = a.recentEvents()
    assert.equal(tail.length, RECENT_EVENTS)
    assert.equal(tail[0].n, 21, 'oldest first, and the head has fallen off')
    assert.equal(tail.at(-1).n, RECENT_EVENTS + 20)
    assert.deepEqual(a.recentEvents(3).map((e) => e.n), [118, 119, 120], 'a smaller ask takes the newest')

    // A second reduction over the same journal rebuilds from it, so the tail is
    // right the instant the boot rebuild ends — no first-append warm-up.
    assert.deepEqual(reduction().recentEvents().map((e) => e.n), tail.map((e) => e.n))
  })

  // The digest (#355) is up to two hundred file rows, and the feed rides every
  // five-second poll. The journal keeps the list whole because it is the
  // durable record; the feed keeps the totals, so the cost #289 took off this
  // route does not come back under a new name. The console reads the list off
  // the review-gate record instead, in full.
  test('the feed keeps a diff digest\'s totals and drops its per-file list', () => {
    const a = reduction()
    const list = Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.mjs`, added: 1, deleted: 0, status: 'M' }))
    a.journal('review_requested', { repo: 'o/r', ticket: '9', agent: 'curia-9', diff: { files: 200, added: 200, deleted: 0, list } })

    const ev = a.recentEvents().at(-1)
    assert.equal(ev.diff.files, 200)
    assert.equal(ev.diff.added, 200)
    assert.equal(ev.diff.list, undefined, 'two hundred file rows must not ride the poll')
    assert.equal(ev.diff.list_on_the_record, 200, 'the feed says the list exists rather than hiding it')

    // The journal itself is untouched: the durable record carries the list.
    assert.equal(journalEvents(dir).at(-1).diff.list.length, 200)
  })
})

// The other two things the poll used to read the whole journal for (#289).
//
// The route answers a question about the RECENT past — the last few endings,
// and one agent's pull request — and it used to answer it by parsing every
// event curia ever wrote, once per poll and again per open review gate. The
// interval of #263 caps how OFTEN that happens and nothing about what one read
// costs, and that cost rises with the history.
//
// So both are reductions now, beside the feed's ring and filled the same way.
// The test that matters is the last one: it takes the file away and asks
// anyway.
describe('the recent past, answered without the file (#289)', () => {
  let dir
  const reduction = () => new Reduction(dir)

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-289-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('the outcomes keep the last few of each kind, newest last, in the order the status prints', () => {
    const s = reduction()
    for (let i = 1; i <= RECENT_OUTCOMES + 3; i += 1) s.journal('lifecycle_closed', { repo: 'o/r', ticket: i })
    s.journal('agent_cancelled', { repo: 'o/r', ticket: 90 })
    s.journal('agent_died', { repo: 'o/r', ticket: 91 })

    const out = s.recentOutcomes()
    assert.deepEqual(out.map((o) => o.kind), ['cancelled', ...Array(RECENT_OUTCOMES).fill('finished'), 'died'])
    assert.deepEqual(out.filter((o) => o.kind === 'finished').map((o) => o.ticket), ['4', '5', '6', '7', '8'],
      'newest last, and the head of a long run has fallen off')
    // A cap PER KIND, not one shared cap: eight endings must not push the one
    // cancellation off a list the operator reads to find it.
    assert.deepEqual(out[0], { kind: 'cancelled', repo: 'o/r', ticket: '90' })
  })

  test('a restart replays them, so the first poll after a restart is not blank', () => {
    const s = reduction()
    s.journal('lifecycle_closed', { repo: 'o/r', ticket: 42 })
    assert.deepEqual(reduction().recentOutcomes(), s.recentOutcomes())
  })

  test('the pull request answers per agent, and a fresh dispatch does not inherit the last one\'s', () => {
    const s = reduction()
    s.journal('pr_opened', { agent: 'curia-42', url: 'https://github.com/o/r/pull/9' })
    s.journal('pr_opened', { agent: 'curia-43', url: 'https://github.com/o/r/pull/10' })
    assert.equal(s.pullRequestFor('curia-42'), 'https://github.com/o/r/pull/9')
    assert.equal(s.pullRequestFor('curia-43'), 'https://github.com/o/r/pull/10')
    assert.equal(s.pullRequestFor('curia-99'), null, 'an agent with no pull request is null, never another agent\'s')

    // The session name is reused by every dispatch of a ticket, so the spawn
    // clears it (#253). The reuse and the repair both land on it after that.
    s.journal('agent_spawned', { agent: 'curia-42', ticket: 42 })
    assert.equal(s.pullRequestFor('curia-42'), null)
    s.journal('pr_reused', { agent: 'curia-42', url: 'https://github.com/o/r/pull/11' })
    assert.equal(s.pullRequestFor('curia-42'), 'https://github.com/o/r/pull/11')
    s.journal('land_repaired', { agent: 'curia-42', url: 'https://github.com/o/r/pull/12' })
    assert.equal(s.pullRequestFor('curia-42'), 'https://github.com/o/r/pull/12')
  })

  test('both answer with the journal read made to fail — the proof the poll never reads it', async () => {
    const s = reduction()
    s.journal('agent_cancelled', { repo: 'o/r', ticket: 3 })
    s.journal('lifecycle_closed', { repo: 'o/r', ticket: 4 })
    s.journal('pr_opened', { agent: 'curia-42', url: 'https://github.com/o/r/pull/9' })

    const d = new Dispatcher({
      config: {
        watch: [],
        dispatch: {
          auto_dispatch: false, max_concurrent: 1, poll_interval_s: 60,
          workspace_root: path.join(dir, 'work'), ready_timeout_s: 5, stop_nudge_budget: 3, claim_login: 'me',
        },
        attach: { ttyd_port: 7681, serve_port: 8443 },
        identity: { allow: ['tester@example.com'], proxy_port: 7682 },
        skills: null,
        sandbox: TEST_PINS,
      },
      routing: { defaults: { untyped: 'sonnet' }, models: {}, fallbacks: {}, harnesses: {} },
      reduction: s,
      notify: () => {},
      log: () => {},
      dataDir: dir,
      deps: { listSessions: async () => [] },
    })

    // Nothing on this path may read the journal, so the strongest statement of
    // that is to make every read fail. The medium moved to `node:sqlite` at
    // #407, and deleting a file an open connection holds proves nothing on
    // Linux. The reads are the questions since #408, so all of them throw.
    s.questions = new Proxy({}, {
      get: () => () => { throw new Error('the poll must never read the journal') },
    })

    const { recent } = await d.status()
    assert.deepEqual(recent, [
      { kind: 'cancelled', repo: 'o/r', ticket: '3' },
      { kind: 'finished', repo: 'o/r', ticket: '4' },
    ])
    assert.equal(d.pullRequestUrlFor('curia-42'), 'https://github.com/o/r/pull/9')
    assert.equal(d.pullRequestUrlFor('curia-77'), null)
  })

  test('the live agent record still wins over the reduction', () => {
    const s = reduction()
    s.journal('pr_opened', { agent: 'curia-42', url: 'https://github.com/o/r/pull/9' })
    const d = new Dispatcher({
      config: { watch: [], dispatch: { auto_dispatch: false, max_concurrent: 1, poll_interval_s: 60, workspace_root: path.join(dir, 'work'), ready_timeout_s: 5, stop_nudge_budget: 3 }, attach: { ttyd_port: 7681, serve_port: 8443 }, identity: { allow: [], proxy_port: 7682 }, skills: null, sandbox: TEST_PINS },
      routing: { defaults: { untyped: 'sonnet' }, models: {}, fallbacks: {}, harnesses: {} },
      reduction: s,
      notify: () => {},
      log: () => {},
      dataDir: dir,
      deps: {},
    })
    d.agents.set('curia-42', { session: 'curia-42', prUrl: 'https://github.com/o/r/pull/10' })
    assert.equal(d.pullRequestUrlFor('curia-42'), 'https://github.com/o/r/pull/10',
      'the record of the dispatch this process is holding is the newer fact')
    d.agents.clear()
  })
})

// The arm has to outlive the process that made it (#346). Cooling holds for
// hours and a deploy takes minutes, so an arm kept only in the dispatcher would
// mostly never fire. It is a reduction for the reason the pull request above is
// one: the boot replay is what hands it back.
describe('the limit resume curia still owes (#346)', () => {
  let dir
  const reduction = () => new Reduction(dir)

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-346-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('an arm is answered per ticket, with the repo and the instant it was written with', () => {
    const s = reduction()
    s.journal('limit_resume_armed', { repo: 'o/r', ticket: 42, resume_at: '2026-08-15T12:00:00.000Z' })
    s.journal('limit_resume_armed', { repo: 'o/r', ticket: 43, resume_at: '2026-08-15T13:00:00.000Z' })
    assert.deepEqual(s.armedLimitResumes(), [
      { ticket: '42', repo: 'o/r', at: '2026-08-15T12:00:00.000Z' },
      { ticket: '43', repo: 'o/r', at: '2026-08-15T13:00:00.000Z' },
    ])
  })

  test('a restart replays it, which is the whole point of the reduction', () => {
    const s = reduction()
    s.journal('limit_resume_armed', { repo: 'o/r', ticket: 42, resume_at: '2026-08-15T12:00:00.000Z' })
    assert.deepEqual(reduction().armedLimitResumes(), s.armedLimitResumes())
  })

  test('the attempt clears it, so one arm buys one attempt and never a loop', () => {
    const s = reduction()
    s.journal('limit_resume_armed', { repo: 'o/r', ticket: 42, resume_at: '2026-08-15T12:00:00.000Z' })
    s.journal('limit_resume', { repo: 'o/r', ticket: 42, outcome: 'ran' })
    assert.deepEqual(s.armedLimitResumes(), [])
  })

  test('an agent on that ticket by any other route clears it too', () => {
    const s = reduction()
    s.journal('limit_resume_armed', { repo: 'o/r', ticket: 42, resume_at: '2026-08-15T12:00:00.000Z' })
    s.journal('agent_spawned', { repo: 'o/r', ticket: 42, agent: 'curia-42' })
    assert.deepEqual(s.armedLimitResumes(), [], 'the operator resumed it by hand, so curia owes nothing')
  })

  test('a fresh cap after an attempt arms again', () => {
    const s = reduction()
    s.journal('limit_resume_armed', { repo: 'o/r', ticket: 42, resume_at: '2026-08-15T12:00:00.000Z' })
    s.journal('limit_resume', { repo: 'o/r', ticket: 42, outcome: 'ran' })
    s.journal('agent_spawned', { repo: 'o/r', ticket: 42, agent: 'curia-42' })
    s.journal('limit_resume_armed', { repo: 'o/r', ticket: 42, resume_at: '2026-08-15T17:00:00.000Z' })
    assert.deepEqual(s.armedLimitResumes(), [{ ticket: '42', repo: 'o/r', at: '2026-08-15T17:00:00.000Z' }])
  })
})

// The cap has to outlive the process that measured it (#377), for the reason
// the arm above does: a 5-hour window outlives a deploy. Both events already
// carried `reset_at`; this is the read side.
describe('the cooling a previous process measured (#377)', () => {
  let dir
  const reduction = () => new Reduction(dir)

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-377-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('a landed cap is answered per level, with the reset instant it was journalled with', () => {
    const s = reduction()
    s.journal('provider_cooling', { provider: 'anthropic', reset_at: '2026-08-15T14:00:00.000Z', reset_source: 'pane' })
    s.journal('model_cooling', { model: 'fable', reset_at: '2026-08-15T18:00:00.000Z', reset_source: 'transcript' })
    assert.deepEqual(s.armedCoolings(), {
      models: [{ model: 'fable', at: '2026-08-15T18:00:00.000Z' }],
      providers: [{ provider: 'anthropic', at: '2026-08-15T14:00:00.000Z' }],
    })
  })

  test('a restart replays it, which is the whole point of the reduction', () => {
    const s = reduction()
    s.journal('provider_cooling', { provider: 'anthropic', reset_at: '2026-08-15T14:00:00.000Z', reset_source: 'pane' })
    assert.deepEqual(reduction().armedCoolings().providers, [{ provider: 'anthropic', at: '2026-08-15T14:00:00.000Z' }])
  })

  test('the one-hour floor is kept like any other cap — the guess is the fact curia has', () => {
    const s = reduction()
    s.journal('provider_cooling', { provider: 'openai', reset_at: '2026-08-15T10:00:00.000Z', reset_source: 'floor' })
    assert.deepEqual(s.armedCoolings().providers, [{ provider: 'openai', at: '2026-08-15T10:00:00.000Z' }])
  })

  test('a later cap on the same key replaces the earlier one — a resume that re-cools states a fresh reset', () => {
    const s = reduction()
    s.journal('provider_cooling', { provider: 'anthropic', reset_at: '2026-08-15T14:00:00.000Z', reset_source: 'pane' })
    s.journal('provider_cooling', { provider: 'anthropic', reset_at: '2026-08-15T19:00:00.000Z', reset_source: 'pane' })
    assert.deepEqual(s.armedCoolings().providers, [{ provider: 'anthropic', at: '2026-08-15T19:00:00.000Z' }])
  })

  test('the two levels never mix: a model cap leaves its provider warm', () => {
    const s = reduction()
    s.journal('model_cooling', { model: 'fable', reset_at: '2026-08-15T18:00:00.000Z', reset_source: 'pane' })
    assert.deepEqual(s.armedCoolings().models, [{ model: 'fable', at: '2026-08-15T18:00:00.000Z' }])
    assert.deepEqual(s.armedCoolings().providers, [])
  })

  test('nothing else in the journal touches it — only a landed cap writes a hold', () => {
    const s = reduction()
    s.journal('dispatch_exhausted', { repo: 'o/r', ticket: 42, earliest_reset: '2026-08-15T14:00:00.000Z' })
    s.journal('reset_unparseable', { agent: 'curia-42', scope: 'provider', applied_cooldown_h: 1 })
    s.journal('agent_spawned', { repo: 'o/r', ticket: 42, agent: 'curia-42' })
    // #384's pre-emptive hold least of all: it is a guess re-made from a fresh
    // reading, and seeding it back would hold the frontier on a reading curia
    // no longer has.
    s.journal('provider_precooling', { provider: 'anthropic', window: '5h', pct: 96, reset_at: '2026-08-15T14:00:00.000Z' })
    assert.deepEqual(s.armedCoolings(), { models: [], providers: [] })
  })
})

describe('the two-level frontier, and reconcile\'s stamp (#262)', () => {
  let tmp
  const dispatchers = []

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-overview-frontier-')) })
  after(() => {
    for (const d of dispatchers) d.agents.clear()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // A map child, in the gh payload shape the frontier reads: labels and
  // assignees are arrays of OBJECTS.
  const child = (number, title, { blockedBy = 0, labels = [], assignees = [], state = 'open' } = {}) => ({
    number,
    title,
    state,
    assignees,
    labels: labels.map((name) => ({ name })),
    issue_dependencies_summary: { blocked_by: blockedBy, blocking: 0, total_blocked_by: blockedBy, total_blocking: 0 },
  })

  // #262's fixture map: two takeable tickets, and three behind them.
  //   11 (takeable) unblocks 21 and 22
  //   12 (takeable) unblocks 22 as well — one dependent, two blockers
  //   13 is claimed, so it is off the frontier and unblocks nothing anyone sees
  //   23 is blocked by 13 alone
  const ITEMS = [
    child(11, 'the first takeable one', { labels: ['wayfinder:task'] }),
    child(12, 'the second takeable one', { labels: ['wayfinder:grilling'] }),
    child(13, 'somebody is on this one', { assignees: [{ login: 'someone' }] }),
    child(21, 'waits on the first', { blockedBy: 1 }),
    child(22, 'waits on both', { blockedBy: 2 }),
    child(23, 'waits on the claimed one', { blockedBy: 1 }),
  ]
  const EDGES = {
    21: [{ number: 11, state: 'open' }],
    22: [{ number: 11, state: 'open' }, { number: 12, state: 'open' }],
    23: [{ number: 13, state: 'open' }],
  }

  function makeDispatcher(deps = {}) {
    const config = {
      watch: [{ repo: 'o/r', mode: 'map' }],
      dispatch: {
        auto_dispatch: false, max_concurrent: 1, poll_interval_s: 60,
        workspace_root: path.join(tmp, 'work'), ready_timeout_s: 5, stop_nudge_budget: 3, claim_login: 'me',
      },
      attach: { ttyd_port: 7681, serve_port: 8443 },
      identity: { allow: ['tester@example.com'], proxy_port: 7682 },
      skills: null,
      sandbox: TEST_PINS,
    }
    const d = new Dispatcher({
      config,
      routing: { defaults: { untyped: 'sonnet' }, models: { sonnet: { provider: 'anthropic', harness: 'claude' } }, fallbacks: {}, harnesses: {} },
      reduction: { journal: () => {}, questions: emptyQuestions(), openEscalations: () => [], answeredExchangeFor: () => [], boundTickets: () => [] },
      notify: () => {},
      log: () => {},
      dataDir: path.join(tmp, 'data'),
      deps: {
        listSessions: async () => [],
        hasSession: async () => false,
        repoMaps: async () => [{ number: 9, title: 'the map', state: 'open', labels: [] }],
        mapFrontier: async () => ITEMS,
        flatFrontier: async () => [],
        blockedByOf: async (repo, n) => EDGES[n] ?? [],
        probeTtyd: async () => ({ verified: true }),
        assertServe: async () => {},
        serveOff: async () => {},
        ...deps,
      },
    })
    dispatchers.push(d)
    return d
  }

  test('level two is what each takeable ticket directly unblocks', async () => {
    const [repo] = await makeDispatcher().frontier()
    assert.deepEqual(repo.numbers, [11, 12], 'level one is the takeable set, unchanged')
    const byNumber = Object.fromEntries(repo.items.map((i) => [i.number, i]))
    assert.deepEqual(byNumber[11].unblocks, [
      { number: 21, title: 'waits on the first', labels: [] },
      { number: 22, title: 'waits on both', labels: [] },
    ])
    // 22 sits behind two blockers, so it appears under each of them. It is one
    // level, never a closure: 23 is behind a CLAIMED ticket, which is on no
    // level of a frontier nobody can take.
    assert.deepEqual(byNumber[12].unblocks.map((i) => i.number), [22])
    assert.equal(repo.items.some((i) => i.unblocks.some((u) => u.number === 23)), false)
  })

  // #266: the console shows the routed model beside its start button, so the
  // operator knows which account a press spends before spending it. It is
  // `resolveModel` — the daemon's own precedence rule, computed where the labels
  // already are — never a second copy of that rule inside the page.
  test('every takeable ticket carries the model it would get if it started now', async () => {
    const d = makeDispatcher()
    d.routing = {
      ...d.routing,
      defaults: { untyped: 'sonnet', task: 'opus', grilling: 'gpt' },
    }
    const byNumber = Object.fromEntries((await d.frontier())[0].items.map((i) => [i.number, i.model]))
    assert.equal(byNumber[11], 'opus', 'the wayfinder:task default')
    assert.equal(byNumber[12], 'gpt', 'the wayfinder:grilling default')
  })

  test('a `model:` label on the ticket beats the type default, exactly as a dispatch would', async () => {
    const d = makeDispatcher({
      mapFrontier: async () => [child(11, 'pinned to one model', { labels: ['wayfinder:task', 'model:fable'] })],
      blockedByOf: async () => [],
    })
    d.routing = { ...d.routing, defaults: { untyped: 'sonnet', task: 'opus' } }
    assert.equal((await d.frontier())[0].items[0].model, 'fable')
  })

  test('a ticket with no wayfinder label falls to the untyped default, never to nothing', async () => {
    const d = makeDispatcher({
      mapFrontier: async () => [child(11, 'no type on it')],
      blockedByOf: async () => [],
    })
    assert.equal((await d.frontier())[0].items[0].model, 'sonnet')
  })

  test('reconcile computes the frontier and stamps when it did', async () => {
    const d = makeDispatcher()
    assert.deepEqual(d.frontierSnapshot(), { computed_at: null, repos: [] }, 'nothing is stamped before a pass runs')

    const before = Date.now()
    await d.reconcile({ boot: true })
    const snap = d.frontierSnapshot()
    const at = Date.parse(snap.computed_at)
    assert.ok(Number.isFinite(at), 'the snapshot dates itself')
    assert.ok(at >= before && at <= Date.now(), 'and dates itself to this pass')
    assert.deepEqual(snap.repos.map((r) => r.repo), ['o/r'])
    assert.deepEqual(snap.repos[0].items.map((i) => i.number), [11, 12])
    assert.deepEqual(snap.repos[0].items[0].unblocks.map((i) => i.number), [21, 22])

    // A later pass re-stamps it: the page shows the age of the reading, so a
    // stamp that never moved would age a frontier that had just been re-read.
    await new Promise((r) => setTimeout(r, 5))
    await d.reconcile({ boot: false })
    assert.ok(Date.parse(d.frontierSnapshot().computed_at) > at)
  })

  test('a frontier that cannot be read costs the snapshot, never the pass', async () => {
    const d = makeDispatcher()
    await d.reconcile({ boot: true })
    const good = d.frontierSnapshot()

    // Every gh read for this repo now throws. `frontier()` catches per repo, so
    // the pass completes and the snapshot re-stamps with the error in place of
    // the items — the page says "this repo could not be read", not "nothing is
    // takeable here".
    d.deps.repoMaps = async () => { throw new Error('gh is down') }
    await d.reconcile({ boot: false })
    const after = d.frontierSnapshot()
    assert.notEqual(after.computed_at, good.computed_at)
    assert.equal(after.repos[0].error, 'gh is down')
    assert.equal(after.repos[0].items, undefined)
  })

  test('an unreadable dependency edge drops the unblocks and the count, never the frontier', async () => {
    const d = makeDispatcher({ blockedByOf: async () => { throw new Error('no dependency read') } })
    const [repo] = await d.frontier()
    assert.deepEqual(repo.numbers, [11, 12], 'level one still stands')
    assert.equal(repo.agentOnly, null, 'the agent-only count says it does not know')
    assert.deepEqual(repo.items[0].unblocks, [], 'and level two is empty rather than invented')
  })
})

describe('directUnblocks', () => {
  const item = (number, state = 'open', extra = {}) => ({ number, state, ...extra })

  test('walks the blocked-by edges the other way round', () => {
    const out = directUnblocks({
      items: [item(21), item(22)],
      edges: { 21: [{ number: 11, state: 'open' }], 22: [{ number: 11, state: 'open' }] },
    })
    assert.deepEqual(out[11].map((i) => i.number), [21, 22])
  })

  test('a closed blocker and a closed dependent both drop out', () => {
    const out = directUnblocks({
      items: [item(21), item(22, 'closed')],
      edges: {
        21: [{ number: 11, state: 'closed' }, { number: 12, state: 'open' }],
        22: [{ number: 12, state: 'open' }],
      },
    })
    assert.equal(out[11], undefined, 'a closed ticket unblocks nothing anyone can take')
    assert.deepEqual(out[12].map((i) => i.number), [21], 'and a closed dependent is already done')
  })

  test('a pull request sharing the issue number space is never a dependent', () => {
    const out = directUnblocks({
      items: [item(21, 'open', { pull_request: {} })],
      edges: { 21: [{ number: 11, state: 'open' }] },
    })
    assert.deepEqual(out, {})
  })

  test('no edges at all is an empty answer, not a throw', () => {
    assert.deepEqual(directUnblocks(), {})
    assert.deepEqual(directUnblocks({ items: [item(21)] }), {})
  })
})

// The daemon says goodbye before it dies (#458, building the decision on #426).
//
// Three layers, each tested where it lives:
//   1. the words — an error that says restarting, not answered, and how long to wait
//   2. sayGoodbye — both registries woken, one journal line, and a drain nobody
//      pays for when no call was blocked
//   3. the deaths — a REAL daemon, a REAL blocked `ask_human` over the MCP
//      transport an agent uses, and the two deaths a test can stage: the restart
//      order and a deploy's SIGTERM
//   4. the death that says nothing — a real SIGKILL, and the journal left saying
//      so, which is the gate on the boot sweep (#489)
//
// Layer 3 is the one that matters, and it is the reason this file boots the
// shipped code rather than an extraction. The claim is about a tool result
// crossing a socket the process is about to close, and nothing smaller than the
// real transport can carry that claim. The third death, a crash, rides the #56
// guard, and its await is pinned in health.test.mjs terms below.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GOODBYE_WAIT_S, questionGoodbye, parkGoodbye, sayGoodbye,
  deathWasSilent, DAEMON_BOOT, DAEMON_GOODBYE,
} from '../src/goodbye.mjs'
import { installCrashGuard } from '../src/health.mjs'
import { TOKEN_HEADER, mintAgentToken } from '../src/agenttoken.mjs'
import { freePorts, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'
import { journalEvents } from './fixtures/journal.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1. the words ------------------------------------------------------------

describe('the goodbye says three things (#458)', () => {
  test('a blocked question is told curia is restarting, that this is NOT an answer, and how long to wait', () => {
    const text = questionGoodbye()
    assert.match(text, /CURIA IS RESTARTING/)
    assert.match(text, /NOT AN ANSWER/)
    assert.match(text, new RegExp(`sleep ${GOODBYE_WAIT_S}`))
    // "the same call", never "the same question": the review gate blocks in
    // here too, and it is repeated with `request_review`.
    assert.match(text, /make the\s+same call again/)
    // #56's fault, in one line: an agent took a broken call for permission to
    // decide the question itself.
    assert.match(text, /never decide the\s+question yourself/)
  })

  test('the words never read as an answer the operator gave', () => {
    for (const text of [questionGoodbye(), parkGoodbye('gate'), parkGoodbye('ending')]) {
      assert.doesNotMatch(text, /^ok\b/i)
      assert.match(text, /NOT AN? (ANSWER|VERDICT)/)
    }
  })

  test('a parked builder is told which call re-parks it, and that nothing was decided', () => {
    const gate = parkGoodbye('gate')
    assert.match(gate, /NOT A VERDICT/)
    assert.match(gate, /Nothing was approved and nothing was rejected/)
    assert.match(gate, /`request_review`/)
    // #258: the ending call parks too, and it is the call that builder must
    // make again — sending it to the gate it has already passed is the loop #48
    // refused.
    assert.match(parkGoodbye('ending'), /`report_result`/)
    assert.doesNotMatch(parkGoodbye('ending'), /`request_review`/)
  })
})

// ---- 2. sayGoodbye -----------------------------------------------------------

describe('sayGoodbye wakes every registry and journals what it cost (#458)', () => {
  const journalled = () => {
    const rows = []
    return { rows, journal: (type, detail) => rows.push({ type, ...detail }) }
  }

  test('both registries are woken, and the journal carries the reason and the counts', async () => {
    const { rows, journal } = journalled()
    const waited = []
    const out = await sayGoodbye({
      reason: 'restart',
      wake: { questions: () => 2, parks: () => 1 },
      journal,
      wait: async (ms) => waited.push(ms),
    })
    assert.deepEqual(out, { woken: 3, counts: { questions: 2, parks: 1 } })
    assert.equal(rows.length, 1, 'one event, not one per call')
    assert.deepEqual(rows[0], { type: 'daemon_goodbye', reason: 'restart', woken: 3, questions: 2, parks: 1 })
    assert.equal(waited.length, 1, 'the answers get their bounded moment to leave the socket')
  })

  test('nothing blocked costs no drain — a deploy must not get slower for an empty registry', async () => {
    const { rows, journal } = journalled()
    const waited = []
    const out = await sayGoodbye({
      reason: 'sigterm',
      wake: { questions: () => 0, parks: () => 0 },
      journal,
      wait: async (ms) => waited.push(ms),
    })
    assert.equal(out.woken, 0)
    assert.deepEqual(waited, [], 'no call was blocked, so there is nothing to drain')
    assert.equal(rows[0].woken, 0, 'the record still says a goodbye happened')
  })

  test('a registry that throws costs its own calls and never the other registry', async () => {
    const { rows, journal } = journalled()
    const out = await sayGoodbye({
      reason: 'crash',
      wake: {
        questions: () => { throw new Error('planted') },
        parks: () => 1,
      },
      journal,
      wait: async () => {},
    })
    assert.deepEqual(out.counts, { questions: 0, parks: 1 })
    assert.equal(rows[0].woken, 1, 'the count is what was really woken')
  })

  test('a journal that throws does not stop the goodbye — the exit is what waits on it', async () => {
    const out = await sayGoodbye({
      reason: 'crash',
      wake: { questions: () => 1 },
      journal: () => { throw new Error('disk full') },
      wait: async () => {},
    })
    assert.equal(out.woken, 1)
  })
})

// ---- 3a. the crash exit holds for the goodbye (#56 guard, #458 await) ---------

describe('the crash guard waits for the goodbye before it exits (#458)', () => {
  const cleanup = () => {
    process.removeAllListeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
  }

  test('an async onFault holds the exit until it settles, and then the daemon dies as it always did', async () => {
    let exited = null
    let said = false
    let release
    const handle = installCrashGuard({
      log: () => {},
      journal: () => {},
      onFault: () => new Promise((done) => { release = () => { said = true; done() } }),
      exit: (c) => { exited = c },
    })
    handle(new TypeError('planted'), 'uncaughtException')
    assert.equal(exited, null, 'the error has not left the socket yet')
    release()
    await sleep(0)
    assert.equal(said, true)
    assert.equal(exited, 1, 'the crash still kills the daemon, and with the code it always used')
    cleanup()
  })

  test('a goodbye that fails still lets the daemon die', async () => {
    let exited = null
    const handle = installCrashGuard({
      log: () => {},
      journal: () => {},
      onFault: () => Promise.reject(new Error('planted')),
      exit: (c) => { exited = c },
    })
    handle(new TypeError('planted'), 'uncaughtException')
    await sleep(0)
    assert.equal(exited, 1)
    cleanup()
  })
})

// ---- 3b. the deaths, against a real daemon -----------------------------------
//
// The fixture is the one every real-boot suite here uses: inert gh/tmux/
// tailscale shims, a temp config and data dir, and no bridge token — so the
// escalation opens, renders into nothing, and blocks, which is exactly the state
// a deploy catches an agent in.

function bootFixture(tmp) {
  const cfgDir = path.join(tmp, 'config')
  const shim = path.join(tmp, 'shim')
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.mkdirSync(shim, { recursive: true })
  for (const bin of ['gh', 'tmux', 'tailscale']) {
    const p = path.join(shim, bin)
    fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(p, 0o755)
  }
  return { cfgDir, shim }
}

async function writeConfig(cfgDir, tmp) {
  const [daemonPort, ttydPort, servePort, proxyPort, tlPort, tlServePort] = await freePorts(6)
  fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
    'watch:', '  - repo: example/fixture', '    mode: ready-for-agent',
    'dispatch:',
    '  auto_dispatch: false', '  max_concurrent: 1', '  poll_interval_s: 60',
    `  workspace_root: ${path.join(tmp, 'work')}`, '  ready_timeout_s: 5',
    '  claim_login: alp82',
    'attach:', `  ttyd_port: ${ttydPort}`, `  serve_port: ${servePort}`,
    'identity:', '  allow: [tester@example.com]', `  proxy_port: ${proxyPort}`,
    'timeline:', `  port: ${tlPort}`, `  serve_port: ${tlServePort}`,
    ...skillsYaml(seedSkillsRoot(tmp)),
    ...sandboxYaml(),
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(cfgDir, 'routing.yaml'), [
    'defaults:', '  untyped: sonnet',
    'models:', '  sonnet: { provider: anthropic, harness: claude }',
    'harnesses:', '  claude:',
    '    template: claude --model {model} "$(cat {prompt_file})"',
    "    ready: '⏵⏵|bypass permissions'",
    '    tool_channel_grace_s: 15',
    '',
  ].join('\n'))
  return daemonPort
}

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

// One `tools/call`, on the transport a real agent uses: streamable HTTP, the
// per-agent token in the header, and the answer arriving as an SSE frame
// whenever the daemon decides to send it. The promise settles when the frame
// carrying this call's id lands — which is the whole measurement.
// TYPED, because the flip refuses anything else (#422). A call carrying the
// retired `prompt` field opens no card at all, so a fixture that sent one would
// wait forever for an escalation that was refused before it existed.
function askHuman(port, { agent, ticket, token, headline, id = 1 }) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'ask_human',
      arguments: { kind: 'free-text', headline, questions: [{ text: headline }] },
    },
  })
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/mcp?agent=${agent}&ticket=${ticket}`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body),
        [TOKEN_HEADER]: token,
      },
    }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        for (const line of buf.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          let msg
          try { msg = JSON.parse(t.slice(5).trim()) } catch { continue } // a partial frame
          if (msg.id === id) resolve({ status: res.statusCode, msg })
        }
      })
      res.on('end', () => reject(new Error(`the tool channel closed with no result (HTTP ${res.statusCode}): ${buf || '(nothing at all)'}`)))
      res.on('error', reject)
    })
    req.once('error', reject)
    req.end(body)
  })
}

async function waitFor(what, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

// Boots a daemon, blocks one `ask_human` inside it, and hands back everything a
// drill needs to kill it and read what the blocked call got.
async function daemonHoldingAQuestion(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const dataDir = path.join(tmp, 'data')
  const { cfgDir, shim } = bootFixture(tmp)
  const port = await writeConfig(cfgDir, tmp)
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      PORT: String(port),
      CURIA_CONFIG_DIR: cfgDir,
      CURIA_DATA_DIR: dataDir,
      PATH: `${shim}:${process.env.PATH}`,
      DISCORD_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const watch = watchDaemon(child)
  await waitForBoot(watch, async () => {
    try { return (await request(port, 'GET', '/state')).status === 200 } catch { return false }
  }, 'the /state route')
  // After boot reconcile, because reconcile sweeps the tokens of agents tmux
  // does not know — and this fixture's agent is one no tmux ever ran.
  await waitFor('boot reconcile', async () => /boot reconcile (done|failed)/.test(watch.log()))
  const token = mintAgentToken(dataDir, 'curia-999')
  const asked = askHuman(port, { agent: 'curia-999', ticket: '999', token, headline: 'Is this call still open?' })
  await waitFor('the escalation to open', async () => {
    const state = JSON.parse((await request(port, 'GET', '/state')).body)
    return state.open_escalations.length === 1
  })
  return { tmp, dataDir, port, child, watch, asked }
}

const goodbyeText = (msg) => msg.result.content.map((c) => c.text).join('\n')

describe('POST /restart says goodbye to the call it is about to kill (#458, real boot)', () => {
  let held
  let answer
  let code

  before(async () => {
    held = await daemonHoldingAQuestion('curia-goodbye-restart-')
    const res = await request(held.port, 'POST', '/restart', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'dashboard' }),
    })
    assert.equal(res.status, 200, `the restart was refused: ${res.body}`)
    answer = await held.asked
    code = await new Promise((done) => held.child.once('close', (c) => done(c)))
  })

  after(() => {
    if (held?.child && held.child.exitCode === null) held.child.kill('SIGKILL')
    fs.rmSync(held.tmp, { recursive: true, force: true })
  })

  // The whole ticket, in one assertion: a codex client has no transport-drop
  // watchdog, so an error the daemon SENDS is the only thing that gives that
  // agent its turn back inside a day.
  test('the blocked call ends with a tool ERROR, and not with a text result', () => {
    assert.equal(answer.msg.result.isError, true, 'a text result reads as an answer — the #56 fault')
    assert.match(goodbyeText(answer.msg), /CURIA IS RESTARTING/)
    assert.match(goodbyeText(answer.msg), /NOT AN ANSWER/)
    assert.match(goodbyeText(answer.msg), new RegExp(`sleep ${GOODBYE_WAIT_S}`))
  })

  test('the daemon still exits the way the restart contract says', () => {
    assert.equal(code, 75, 'a clean exit stays down; `restart: on-failure` respawns on a failure')
  })

  test('the journal says what the restart cost, on one line', () => {
    const said = journalEvents(held.dataDir).filter((e) => e.type === 'daemon_goodbye')
    assert.equal(said.length, 1)
    assert.equal(said[0].reason, 'restart')
    assert.equal(said[0].woken, 1)
    assert.equal(said[0].questions, 1)
    assert.equal(said[0].parks, 0, 'the other registry was empty, and it is still counted')
  })

  test('the record stays OPEN — the question is still the operator\'s to answer', () => {
    const events = journalEvents(held.dataDir)
    assert.equal(events.filter((e) => e.type === 'esc_open').length, 1)
    for (const type of ['esc_answer', 'esc_cancel', 'esc_lapse']) {
      assert.deepEqual(events.filter((e) => e.type === type), [], `the goodbye must not ${type} anything`)
    }
  })
})

describe('a deploy SIGTERM says the same goodbye (#458, real boot)', () => {
  let held
  let answer
  let code

  before(async () => {
    held = await daemonHoldingAQuestion('curia-goodbye-sigterm-')
    // What `docker compose up --force-recreate` sends this container, and what
    // nothing caught before this ticket.
    held.child.kill('SIGTERM')
    answer = await held.asked
    code = await new Promise((done) => held.child.once('close', (c) => done(c)))
  })

  after(() => {
    if (held?.child && held.child.exitCode === null) held.child.kill('SIGKILL')
    fs.rmSync(held.tmp, { recursive: true, force: true })
  })

  test('the blocked call is told before the container goes, well inside the 10s grace', () => {
    assert.equal(answer.msg.result.isError, true)
    assert.match(goodbyeText(answer.msg), /CURIA IS RESTARTING/)
  })

  test('the daemon exits as it did with no handler at all', () => {
    assert.equal(code, 143, '128 + 15 — a deploy reads this exactly as it did before the goodbye')
  })

  test('the journal names this death by its own reason', () => {
    const said = journalEvents(held.dataDir).filter((e) => e.type === 'daemon_goodbye')
    assert.equal(said.length, 1)
    assert.equal(said[0].reason, 'sigterm')
    assert.equal(said[0].woken, 1)
  })
})

// ---- 4. the death that says nothing (#489, the boot sweep's gate) -------------
//
// The sweep presses Escape in an agent's pane, and #457 measured what that costs
// when the call is really live: the human's answer is lost in silence. So the
// gate has to be evidence rather than a guess. It is two journal lines — one per
// process at its start, one at its end when the daemon can speak — and the LAST
// of the two says how the last daemon died.
//
// A real SIGKILL is the only honest way to prove the negative half, and this is
// the same fixture the two deaths above use.

describe('a SIGKILL leaves the journal saying nobody was told (#489, real boot)', () => {
  let held

  const lifecycle = () => journalEvents(held.dataDir)
    .filter((e) => e.type === DAEMON_BOOT || e.type === DAEMON_GOODBYE)
    .map((e) => e.type)

  before(async () => {
    held = await daemonHoldingAQuestion('curia-panesweep-')
    // The blocked call never returns from a SIGKILL, and an unread rejection
    // must not fail this suite for the death it is here to stage.
    held.asked.catch(() => {})
  })

  after(() => {
    if (held?.child && held.child.exitCode === null) held.child.kill('SIGKILL')
    fs.rmSync(held.tmp, { recursive: true, force: true })
  })

  test('a live daemon has written its boot line, and nothing has said goodbye yet', () => {
    assert.deepEqual(lifecycle(), [DAEMON_BOOT])
    assert.equal(deathWasSilent(lifecycle().at(-1)), true)
  })

  test('the record a blocked call holds says a call is waiting on it', async () => {
    const state = JSON.parse((await request(held.port, 'GET', '/state')).body)
    assert.equal(state.open_escalations[0].awaited, true, 'the boot sweep asks the record this')
  })

  test('an escalate with no ?wait opens a record no call is blocked on', async () => {
    await request(held.port, 'POST', '/escalate', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'synthetic', ticket: '998', kind: 'free-text', prompt: 'nobody waits on this' }),
    })
    const state = JSON.parse((await request(held.port, 'GET', '/state')).body)
    const record = state.open_escalations.find((r) => String(r.ticket) === '998')
    assert.equal(record.awaited, false, 'the caller already has its answer — the id')
  })

  test('the KILL writes no goodbye, so the last line stays the boot one', async () => {
    held.child.kill('SIGKILL')
    await new Promise((done) => held.child.once('close', done))

    assert.deepEqual(lifecycle(), [DAEMON_BOOT], 'this is the death #458 cannot cover')
    assert.equal(deathWasSilent(lifecycle().at(-1)), true, 'the next boot sweeps')
  })
})

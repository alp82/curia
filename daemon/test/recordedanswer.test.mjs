// A re-asked question is answered from the record (#369).
//
// The fault this closes, as it really ran: a daemon restart kills the call that
// is asking, the card it opened stays live, the operator answers it, and #139
// parks question and answer as an agent note. The agent then re-asks. Supersede
// cannot help, because it only closes OPEN records and this one is answered. So
// a second card carried the same question, the operator answered it twice, and
// the first answer only arrived behind the second — `drainNotes()` runs after
// the answer resolves.
//
// The cure has two conditions and no clock: the payload must match word for
// word, and the parked note must still be unread. The note IS the window.
//
// Two levels here. The reduction half is a unit test, because the rule lives in the
// reduction. The wire half boots the REAL daemon twice on one data dir and
// drives it with a real MCP client, because nothing smaller exercises the path
// that actually failed: the resolver has to die with a process for `settle` to
// find none.

import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Reduction } from '../src/reduction.mjs'
import { sameDigest } from '../src/diffdigest.mjs'
import { REVIEW_KIND } from '../src/lifecycle.mjs'
import { TOKEN_HEADER, mintAgentToken } from '../src/agenttoken.mjs'
import { freePort, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'
import { journalEvents, journalText } from './fixtures/journal.mjs'

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

// The whole fault in one helper: open, answer with nothing waiting, park the
// answer. That is what a restart leaves behind.
function parkedAnswer(reduction, { agent = 'curia-9', ticket = '9', kind = 'free-text', prompt, options, answer, attachments = [], by = 'alp', diff = null } = {}) {
  const { record } = reduction.open({ agent, ticket, kind, prompt, options, diff })
  reduction.answer(record.id, { answer, attachments, by, via: 'button' })
  reduction.queueRecordedAnswer(reduction.get(record.id))
  return reduction.get(record.id)
}

describe('the recorded answer a re-asked question takes back (#369, reduction)', () => {
  let dir, reduction
  const dirs = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-recorded-'))
    dirs.push(dir)
    reduction = new Reduction(dir)
  })

  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

  test('the same question, asked again while the note is unread, finds its answer', () => {
    const record = parkedAnswer(reduction, { prompt: 'which port?', answer: '9012' })
    const hit = reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' })
    assert.equal(hit?.record.id, record.id)
    assert.equal(hit.record.answer, '9012')
    assert.equal(hit.note.handoff_for, record.id, 'the note names the record it carries')
  })

  test('taking it drops the note, so the answer is said once', () => {
    const record = parkedAnswer(reduction, { prompt: 'which port?', answer: '9012' })
    const hit = reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' })
    reduction.takeRecordedAnswer(hit.record, hit.note)
    assert.deepEqual(reduction.takeAgentNotes('curia-9'), [], 'the drain has nothing left to deliver')
    assert.equal(reduction.get(record.id).replayed_at != null, true, 'the record says the answer was served again')
  })

  test('and it cannot be taken twice', () => {
    parkedAnswer(reduction, { prompt: 'which port?', answer: '9012' })
    const hit = reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' })
    reduction.takeRecordedAnswer(hit.record, hit.note)
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' }), null)
  })

  test('an answer the agent has already drained is delivered, so nothing replays', () => {
    parkedAnswer(reduction, { prompt: 'which port?', answer: '9012' })
    reduction.takeAgentNotes('curia-9')
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' }), null)
  })

  // The load-bearing refusal. Supersede keys on the agent and the kind (#336);
  // this must not, or a genuinely new question is answered by an old answer
  // instead of by a human.
  test('a DIFFERENT question of the same kind never takes that answer', () => {
    parkedAnswer(reduction, { prompt: 'which port?', answer: '9012' })
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port, and which path?' }), null)
  })

  test('every part of the payload is part of the question', () => {
    parkedAnswer(reduction, { kind: 'choice', prompt: 'which harness?', options: ['claude', 'codex'], answer: 'claude' })
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'choice', prompt: 'which harness?', options: ['claude', 'codex'] })?.record.answer, 'claude')
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'choice', prompt: 'which harness?', options: ['claude', 'codex', 'pi'] }), null)
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which harness?', options: ['claude', 'codex'] }), null)
  })

  test('another agent asking the same words gets nothing', () => {
    parkedAnswer(reduction, { prompt: 'which port?', answer: '9012' })
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-4', kind: 'free-text', prompt: 'which port?' }), null)
  })

  test('an answer that reached its own live call parks no note and never replays', () => {
    const { record } = reduction.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'which port?' })
    reduction.answer(record.id, { answer: '9012', by: 'alp', via: 'button' })
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' }), null)
  })

  test('a cancelled question holds no answer to hand back', () => {
    const { record } = reduction.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'which port?' })
    reduction.cancel(record.id, { by: 'alp' })
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' }), null)
  })

  test('the answer and its window survive a restart, because both are journalled', () => {
    parkedAnswer(reduction, { prompt: 'which port?', answer: '9012' })
    const reborn = new Reduction(dir)
    const hit = reborn.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' })
    assert.equal(hit?.record.answer, '9012')
    reborn.takeRecordedAnswer(hit.record, hit.note)
    assert.equal(new Reduction(dir).recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' }), null)
  })

  // The journal is append-only, and every hand-off written before this ticket
  // carries no `handoff_for`. Those notes keep the delivery they always had.
  test('a hand-off note from before this ticket is delivered by the drain alone', () => {
    const { record } = reduction.open({ agent: 'curia-9', ticket: '9', kind: 'free-text', prompt: 'which port?' })
    reduction.answer(record.id, { answer: '9012', by: 'alp', via: 'button' })
    reduction.queueAgentNote('curia-9', 'a human answered esc-1 ...', { by: 'alp' })
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' }), null)
    assert.equal(reduction.takeAgentNotes('curia-9').length, 1)
  })

  test('the newest answer wins when one question was somehow answered twice', () => {
    parkedAnswer(reduction, { prompt: 'which port?', answer: '9012' })
    parkedAnswer(reduction, { prompt: 'which port?', answer: '9013' })
    assert.equal(reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'which port?' })?.record.answer, '9013')
  })

  test('the attachments ride with the recorded answer', () => {
    parkedAnswer(reduction, { prompt: 'does this look right?', answer: 'yes', attachments: ['/data/attachments/esc-1/shot.png'] })
    const hit = reduction.recordedAnswerFor({ agent: 'curia-9', kind: 'free-text', prompt: 'does this look right?' })
    assert.deepEqual(hit.record.attachments, ['/data/attachments/esc-1/shot.png'])
  })
})

// The gate's extra guard (#369 question 4): a recorded approval is handed back
// only when the code is still the code the operator approved.
describe('the digest guard on a recorded approval (#369)', () => {
  const digest = (over = {}) => ({
    uncommitted: false, files: 2, added: 30, deleted: 4, capped: false,
    list: [
      { path: 'daemon/src/reduction.mjs', status: 'M', added: 25, deleted: 4 },
      { path: 'daemon/test/reduction.test.mjs', status: 'A', added: 5, deleted: 0 },
    ],
    ...over,
  })

  test('the same measurement matches itself', () => {
    assert.equal(sameDigest(digest(), digest()), true)
  })

  test('a changed total, a changed path, or a changed count is a different diff', () => {
    assert.equal(sameDigest(digest(), digest({ added: 31 })), false)
    assert.equal(sameDigest(digest(), digest({ files: 3 })), false)
    assert.equal(sameDigest(digest(), digest({ list: [{ path: 'daemon/src/index.mjs', status: 'M', added: 25, deleted: 4 }, { path: 'daemon/test/reduction.test.mjs', status: 'A', added: 5, deleted: 0 }] })), false)
  })

  // Null is not empty (#355), and it is not evidence either.
  test('a gate curia could not count never matches, not even another uncounted one', () => {
    assert.equal(sameDigest(null, null), false)
    assert.equal(sameDigest(digest(), null), false)
  })

  test('a recorded gate answer is found by the same rule as any other question', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-recorded-gate-'))
    try {
      const reduction = new Reduction(dir)
      parkedAnswer(reduction, { kind: REVIEW_KIND, prompt: 'summary + charting', answer: 'approve', diff: digest() })
      const hit = reduction.recordedAnswerFor({ agent: 'curia-9', kind: REVIEW_KIND, prompt: 'summary + charting' })
      assert.equal(hit.record.answer, 'approve')
      assert.equal(sameDigest(hit.record.diff, digest()), true, 'the stored digest is what the guard compares')
      assert.equal(sameDigest(hit.record.diff, digest({ files: 5, added: 400 })), false, 'three more commits and the operator sees a fresh gate')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The shipped path, twice booted. The resolver must die with a PROCESS — that
// is the one thing no in-process test can stage, and it is the whole premise of
// the fault.
describe('the re-ask takes the recorded answer (#369, real boot pair + real MCP client)', () => {
  let tmp
  let child
  let port
  let watch

  const armed = (agent) => {
    const token = mintAgentToken(path.join(tmp, 'data'), agent)
    return { requestInit: { headers: { [TOKEN_HEADER]: token } } }
  }

  const bootDaemon = async () => {
    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(port),
        CURIA_CONFIG_DIR: path.join(tmp, 'config'),
        CURIA_DATA_DIR: path.join(tmp, 'data'),
        PATH: `${path.join(tmp, 'shim')}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)
    await waitForBoot(watch, async () => {
      try {
        return (await request(port, 'GET', '/state')).status === 200
      } catch { return false }
    }, 'the /state route')
  }

  const killDaemon = () => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    child.kill('SIGKILL')
  })

  const connect = async (agent, ticket) => {
    const client = new Client({ name: 'curia-369-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?agent=${agent}&ticket=${ticket}`), armed(agent))
    await client.connect(transport)
    return client
  }

  const call = async (agent, ticket, name, args) => {
    const client = await connect(agent, ticket)
    try {
      return await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 })
    } finally {
      await client.close().catch(() => {})
    }
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-369-test-'))
    const cfgDir = path.join(tmp, 'config')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    for (const bin of ['gh', 'tmux', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    const [daemonPort, ttydPort, servePort, proxyPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
    port = daemonPort
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:',
      '  - repo: example/fixture',
      '    mode: ready-for-agent',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 1',
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
  })

  after(async () => {
    await killDaemon()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the operator waits once: the second ask returns at once and opens no card', async () => {
    await bootDaemon()
    // The agent asks. The card opens. The daemon then dies under the call, so
    // its resolver dies with it — the #56 outage, exactly.
    const asking = await connect('curia-369', '369')
    asking
      .callTool({ name: 'ask_human', arguments: { prompt: 'which port should the dev server bind?', kind: 'free-text' } }, undefined, { timeout: 60_000 })
      .catch(() => { /* this call dies with the daemon, which IS the fault */ })
    const open = await (async () => {
      const deadline = Date.now() + 10_000
      for (;;) {
        const state = JSON.parse((await request(port, 'GET', '/state')).body)
        if (state.open_escalations[0]) return state.open_escalations[0]
        if (Date.now() > deadline) throw new Error('timed out waiting for the escalation to open')
        await new Promise((r) => setTimeout(r, 50))
      }
    })()
    await killDaemon()
    await asking.close().catch(() => {})

    // Daemon B recovers the record open, and the operator answers it. Nothing
    // is waiting, so #139 parks the answer.
    await bootDaemon()
    const answered = await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: open.id, answer: '9012' }),
    })
    assert.equal(JSON.parse(answered.body).ok, true)

    // The agent re-asks, word for word, as its standing orders tell it to.
    const second = await call('curia-369', '369', 'ask_human', { prompt: 'which port should the dev server bind?', kind: 'free-text' })
    const text = second.content.map((c) => c.text ?? '').join('\n')
    assert.match(text, /9012/, 'the answer came back on the call that asked')
    assert.match(text, /recorded answer/, 'and the agent is told it is a recorded one')
    assert.match(text, new RegExp(open.id), 'named by the record it came from')

    assert.deepEqual(
      JSON.parse((await request(port, 'GET', '/state')).body).open_escalations,
      [],
      'no second card: nobody was asked twice',
    )

    // One fact, one delivery: the parked note left with the answer, so the next
    // tool result does not say it again. `notify` returns at once and drains the
    // queue, which makes it the cheapest reader of what is left in it.
    const after = await call('curia-369', '369', 'notify', { message: 'binding 9012' })
    assert.doesNotMatch(
      after.content.map((c) => c.text ?? '').join('\n'),
      /operator note/,
      'the note went with the answer rather than riding the next tool result',
    )

    const events = journalEvents(path.join(tmp, 'data'))
    const replay = events.find((e) => e.type === 'esc_replayed')
    assert.ok(replay, 'the take is journalled, so a reader can see the operator was asked once')
    assert.equal(replay.id, open.id)
    assert.equal(replay.agent, 'curia-369')
  })
})

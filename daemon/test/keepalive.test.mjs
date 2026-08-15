// The keepalive is what makes #11's "block indefinitely" true in practice, and
// it is invisible from the outside: without it a blocked ask_human still looks
// perfectly healthy on the daemon side while the CLIENT quietly aborts the call
// after 300s of stream silence (Claude Code's MCP idle timeout). That failure
// mode cost #34 two full lab runs before it was understood, and a refactor that
// drops the notification would reintroduce it with every test still green — so
// this boots the REAL daemon and asserts the bytes actually reach a real MCP
// client mid-call.
//
// It also pins the first-valid-wins gate (#11/#31) end to end on the same boot:
// two answers race, exactly one closes the call, the loser is told why.
//
// Same fixture posture as index.test.mjs: inert gh/tmux/tailscale shims, temp
// config + data dir, REST-only (no bridge token) — nothing here touches the
// live box.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOKEN_HEADER, mintAgentToken } from '../src/agenttoken.mjs'
import { freePort, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

const KEEPALIVE_MS = 150

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Poll until `fn` returns something truthy, or give up loudly — never a bare
// sleep that passes on a slow machine and flakes on a busy one.
async function until(fn, what, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

describe('a blocked ask_human keeps its stream alive (index.mjs, real boot + real MCP client)', () => {
  let tmp
  let child
  let port
  let watch

  // Since #159 the daemon serves /mcp only to an agent that presents the token
  // it minted for that name — so every client here arms itself the way a real
  // harness does: the daemon writes the token file, the agent sends the header.
  // Minting straight into the child's own data dir is deliberate: the file IS
  // the contract between the two processes.
  const armed = (agent) => {
    const token = mintAgentToken(path.join(tmp, 'data'), agent)
    return { requestInit: { headers: { [TOKEN_HEADER]: token } } }
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-keepalive-test-'))
    const cfgDir = path.join(tmp, 'config')
    const dataDir = path.join(tmp, 'data')
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
      '  ready_timeout_s: 5',
      '  confirm_ttl_h: 1',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      // #212: the fixture owns its skills root, so this boot depends on
      // nothing under the host's HOME.
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
    "    ready: '\u23f5\u23f5|bypass permissions'",
    "    tool_channel_grace_s: 15",
      '',
    ].join('\n'))

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(daemonPort),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: dataDir,
        PATH: `${shim}:${process.env.PATH}`,
        DISCORD_BOT_TOKEN: '',
        MCP_KEEPALIVE_MS: String(KEEPALIVE_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watch = watchDaemon(child)

    await waitForBoot(watch, async () => {
      try {
        return (await request(port, 'GET', '/state')).status === 200
      } catch { return false }
    }, 'the /state route')
  })

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('progress notifications flow to the client while the call is still blocked, then the answer releases it', async () => {
    const client = new Client({ name: 'curia-keepalive-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?agent=curia-lab&ticket=77`), armed('curia-lab'))
    await client.connect(transport)

    // onprogress is what makes the SDK put a progressToken on the request —
    // exactly what Claude Code does, so this exercises the token branch.
    const progress = []
    const call = client.callTool(
      { name: 'ask_human', arguments: { prompt: 'keepalive fixture', kind: 'free-text' } },
      undefined,
      { onprogress: (p) => progress.push(p), timeout: 30_000 },
    )

    const open = await until(
      async () => JSON.parse((await request(port, 'GET', '/state')).body).open_escalations[0],
      'the escalation to open',
    )

    // Enough wall clock for several ticks; assert on the ones that landed, and
    // require more than one so a single flush cannot pass for a heartbeat.
    await sleep(KEEPALIVE_MS * 5)
    assert.ok(
      progress.length >= 2,
      `expected repeated progress notifications while blocked, got ${progress.length} — the client would go silent and abort`,
    )
    assert.match(String(progress.at(-1).message ?? ''), new RegExp(open.id), 'the keepalive names the escalation it is holding')

    // Still blocked: the notifications are keepalive, not a result.
    assert.equal(
      await Promise.race([call.then(() => 'resolved'), sleep(50).then(() => 'pending')]),
      'pending',
      'progress must not resolve the tool call',
    )

    const answered = await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: open.id, answer: 'released' }),
    })
    assert.equal(answered.status, 200)

    const result = await call
    assert.match(result.content.map((c) => c.text ?? '').join('\n'), /released/)
    await client.close()
  })

  // The other branch, and the codex lane's own (#342, gap 13). An agent harness
  // that offers no progressToken still has to get bytes, or it dies at its own
  // idle timeout exactly like Claude Code did — and this is the branch a silent
  // regression would leave uncovered, since Claude Code itself never takes it.
  // (What a *given* client does with a logging notification is its business;
  // the daemon's job is to keep sending.)
  //
  // The envelope is asserted alongside the text since #342. A logging
  // notification is routed by `level` and `logger` before anything reads its
  // data, so a keepalive that arrived unlabelled would be filtered out by a
  // conforming client and the lane would go silent with this test still green.
  test('a client that offers no progressToken still gets keepalive traffic', async () => {
    const client = new Client({ name: 'curia-keepalive-test-notoken', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?agent=curia-lab2&ticket=78`), armed('curia-lab2'))
    await client.connect(transport)

    const logs = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { logs.push(n) })

    // No onprogress ⇒ no progressToken on the wire ⇒ the fallback path.
    const call = client.callTool(
      { name: 'ask_human', arguments: { prompt: 'fallback fixture', kind: 'free-text' } },
      undefined,
      { timeout: 30_000 },
    )

    const open = await until(
      async () => JSON.parse((await request(port, 'GET', '/state')).body).open_escalations.find((e) => e.ticket === '78'),
      'the fallback escalation to open',
    )

    await sleep(KEEPALIVE_MS * 5)
    assert.ok(
      logs.length >= 2,
      `expected repeated logging notifications on the tokenless path, got ${logs.length}`,
    )
    assert.match(String(logs.at(-1).params.data ?? ''), new RegExp(open.id))
    assert.equal(logs.at(-1).params.level, 'info', 'an unlabelled notification is one a conforming client drops')
    assert.equal(logs.at(-1).params.logger, 'curia', 'and the logger is how it tells curia from the harness\'s own noise')

    await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: open.id, answer: 'released' }),
    })
    await call
    await client.close()
  })

  // #342, gap 13. The inbound half of #34, end to end on a real client — and
  // the reason it is a CODEX case rather than a claude one.
  //
  // Gap 8 of the codex-lane inventory (#152) asked whether an MCP `image` block
  // reaches a codex agent at all, because `inboundContent` predates that lane.
  // #176 settled it live: a stdio MCP server returned a 120x80 solid red PNG and
  // the codex agent answered with the colour and the dimensions, both of which
  // come only from the pixels. So the lane reads the block, and what is left to
  // hold is that the daemon still PRODUCES it — which no test asserted past
  // `inboundContent` itself. A refactor that let the answer's attachments stop
  // at the route would turn every screenshot answer into a silent drop on both
  // lanes, and the unit test of the pure function would stay green.
  test('a screenshot answer comes back as a real image block, not a path the agent must go and read', async () => {
    // A real PNG, because the block carries the bytes: 1x1, the smallest file
    // the format has.
    const workRoot = path.join(tmp, 'work')
    fs.mkdirSync(workRoot, { recursive: true })
    const shot = path.join(workRoot, 'shot.png')
    fs.writeFileSync(shot, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ))

    const client = new Client({ name: 'curia-image-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?agent=curia-70&ticket=70`), armed('curia-70')))
    const call = client.callTool(
      { name: 'ask_human', arguments: { prompt: 'does this look right?', kind: 'free-text' } },
      undefined,
      { timeout: 30_000 },
    )

    const open = await until(
      async () => JSON.parse((await request(port, 'GET', '/state')).body).open_escalations.find((e) => e.ticket === '70'),
      'the image escalation to open',
    )
    const answered = await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: open.id, answer: 'no — look at the header', attachments: [shot] }),
    })
    assert.equal(answered.status, 200)

    const { content } = await call
    const image = content.find((c) => c.type === 'image')
    assert.ok(image, `the answer's attachment must ride back as an image block — got ${JSON.stringify(content.map((c) => c.type))}`)
    assert.equal(image.mimeType, 'image/png')
    assert.equal(image.data, fs.readFileSync(shot).toString('base64'), 'the bytes are the picture, not a path to it')
    // Text stays the floor (#34): the words the human typed are never traded
    // for the picture.
    assert.match(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), /look at the header/)
    await client.close()
  })

  // #342, gap 13. #152 measured the `choice` kind working on a live codex agent
  // and filed it under "measured parity, so do not re-open it" — measured on a
  // transcript, and held by nothing since. It is the one kind whose payload the
  // agent supplies beyond the prompt, so it is the one that can rot: options
  // dropped from the record leave a human a text box where the agent asked for
  // a pick, and neither side can tell that anything was lost.
  test('the choice kind carries its options to the human and the pick back to the agent', async () => {
    const client = new Client({ name: 'curia-choice-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?agent=curia-71&ticket=71`), armed('curia-71')))
    const call = client.callTool(
      { name: 'ask_human', arguments: { prompt: 'which harness runs this?', kind: 'choice', options: ['claude', 'codex'] } },
      undefined,
      { timeout: 30_000 },
    )

    const open = await until(
      async () => JSON.parse((await request(port, 'GET', '/state')).body).open_escalations.find((e) => e.ticket === '71'),
      'the choice escalation to open',
    )
    assert.equal(open.kind, 'choice')
    assert.deepEqual(open.options, ['claude', 'codex'], 'the options reach the surface that has to draw the buttons')

    await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: open.id, answer: 'codex' }),
    })
    const result = await call
    assert.match(result.content.map((c) => c.text ?? '').join('\n'), /codex/, 'the pick reaches the agent as its tool result')
    await client.close()
  })

  test('the loser of an answer race is refused with a reason, and the winner stands', async () => {
    const opened = await request(port, 'POST', '/escalate', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'race fixture', kind: 'approve-reject' }),
    })
    const { id } = JSON.parse(opened.body)

    // Fired together: whichever the daemon serializes first wins — the point is
    // that the second is refused rather than overwriting a closed record.
    const [a, b] = await Promise.all([
      request(port, 'POST', '/answer', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, answer: 'approve' }),
      }),
      request(port, 'POST', '/answer', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, answer: 'reject' }),
      }),
    ])

    const codes = [a.status, b.status].sort()
    assert.deepEqual(codes, [200, 409], 'exactly one answer may close the escalation')

    const loser = JSON.parse(a.status === 409 ? a.body : b.body)
    assert.equal(loser.ok, false)
    assert.equal(loser.reason, 'answered', 'the loser is told the call was already answered, not left guessing')

    // The record kept the winner's answer, and the escalation is off the open list.
    const state = JSON.parse((await request(port, 'GET', '/state')).body)
    assert.equal(state.open_escalations.some((e) => e.id === id), false)
  })

  // #41 turned report_result from a fire-and-forget journal write into the call
  // that closes the TICKET, and it now reports back what the daemon did. On this
  // boot every `gh` is an inert failing shim, which is exactly the interesting
  // case: the resolve step must decline out loud instead of hanging the call or
  // taking the daemon down with it.
  test('report_result returns the daemon\'s resolve outcome, and declines safely when it cannot identify the ticket', async () => {
    const call = async (agent, ticket) => {
      const client = new Client({ name: 'curia-result-test', version: '0.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?agent=${agent}&ticket=${ticket}`), armed(agent)))
      const res = await client.callTool(
        { name: 'report_result', arguments: { ticket: String(ticket), status: 'resolved', summary: 'fixture' } },
        undefined,
        { timeout: 30_000 },
      )
      await client.close()
      return res.content.map((c) => c.text).join('\n')
    }

    // a session name that carries no TICKET number carries no ticket binding
    // at all (`curia-lab` passes the name check #159 added and fails SESSION_RE)
    assert.match(await call('curia-lab', 77), /no curia ticket is bound/)
    // a real binding, but no dispatch epoch and no readable gh ⇒ no repo
    assert.match(await call('curia-77', 77), /could not tell which repo #77 belongs to/)

    const journal = fs.readFileSync(path.join(tmp, 'data', 'events.jsonl'), 'utf8')
    assert.ok(journal.includes('"type":"result"'), 'the result is journalled either way')
    assert.equal(journal.match(/"type":"resolve_skipped"/g).length, 2)
    assert.ok(fs.existsSync(path.join(tmp, 'data', 'results', 'curia-77.json')), 'and the results file still gates the lifecycle')
    assert.equal(child.exitCode, null, 'the daemon is still up')
  })

  // #202: the journal line took the agent at its word, so a repo-qualified id
  // became the ticket every reader of that line keyed on — the status line
  // reposted under a thread named for the string, and reconcile counted a
  // result against the wrong number.
  test('a reported ticket id never becomes the journal event\'s ticket', async () => {
    const client = new Client({ name: 'curia-result-bind-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?agent=curia-88&ticket=88`), armed('curia-88')))
    await client.callTool(
      { name: 'report_result', arguments: { ticket: 'alp82/curia#164', status: 'resolved', summary: 'fixture' } },
      undefined,
      { timeout: 30_000 },
    )
    await client.close()

    const line = fs.readFileSync(path.join(tmp, 'data', 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .findLast((ev) => ev.type === 'result' && ev.agent === 'curia-88')
    assert.equal(line.ticket, '88', 'the bound ticket is the event\'s ticket')
    assert.equal(line.reported_ticket, 'alp82/curia#164', 'the disagreement is journalled beside it')
    assert.equal(child.exitCode, null, 'the daemon is still up')
  })
})

// THE FLIP (#422), on the wire.
//
// Four surfaces got their typed fields one ticket at a time, and each one
// accepted an untyped call while the next was still being built. This ticket
// closed that door: a call that omits a required field is refused, on every
// shipped surface, from the deploy that lands this branch.
//
// The unit tests next door hold the floor itself (lint.test.mjs). What only a
// real boot can answer is whether the refusal reaches the agent as a tool
// RESULT rather than a throw, and whether a refused call really opens nothing.
// #416 measured a rejection dying in silence on codex, which is why the
// carriage is tested here and not only in the pure function.
//
// The other half of the contract is ADR-0019's: A SCHEMA REJECTION NEVER TRAPS
// A QUESTION. An agent that keeps sending the old shape still reaches the
// operator at the cap, with its prompt flagged. The last two cases hold that.

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
import { TOKEN_HEADER, mintAgentToken } from '../src/agenttoken.mjs'
import { freePorts, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot, skillsYaml } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'
import { journalEvents } from './fixtures/journal.mjs'

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, what, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const openEscalations = async (port) => JSON.parse((await request(port, 'GET', '/state')).body).open_escalations

describe('an untyped ask_human is refused since the flip (#422, real boot)', () => {
  let tmp, child, port, watch

  // A refused call returns at once, so it can be awaited. A call that OPENS a
  // card blocks until somebody answers, so the flagged case fires it without
  // awaiting and answers it over REST.
  const client = async (agent, ticket) => {
    const token = mintAgentToken(path.join(tmp, 'data'), agent)
    const c = new Client({ name: 'curia-422-test', version: '0.0.0' })
    await c.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp?agent=${agent}&ticket=${ticket}`),
      { requestInit: { headers: { [TOKEN_HEADER]: token } } },
    ))
    return c
  }

  const ask = async (agent, ticket, args) => {
    const c = await client(agent, ticket)
    try {
      const r = await c.callTool({ name: 'ask_human', arguments: args }, undefined, { timeout: 30_000 })
      return r.content.map((x) => x.text ?? '').join('\n')
    } finally {
      await c.close().catch(() => {})
    }
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-422-test-'))
    const cfgDir = path.join(tmp, 'config')
    const shim = path.join(tmp, 'shim')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(shim, { recursive: true })
    for (const bin of ['gh', 'tmux', 'tailscale']) {
      const p = path.join(shim, bin)
      fs.writeFileSync(p, '#!/bin/sh\nexit 1\n')
      fs.chmodSync(p, 0o755)
    }
    const [daemonPort, ttydPort, servePort, proxyPort] = await freePorts(4)
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
      '  claim_login: fixture-operator',
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
      '    resume_template: claude --model {model} --continue "Continue the interrupted work."',
      "    ready: '⏵⏵|bypass permissions'",
      '    tool_channel_grace_s: 15',
      '',
    ].join('\n'))
    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        PORT: String(port),
        CURIA_CONFIG_DIR: cfgDir,
        CURIA_DATA_DIR: path.join(tmp, 'data'),
        PATH: `${shim}:${process.env.PATH}`,
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
  })

  after(async () => {
    await new Promise((resolve) => {
      if (!child || child.exitCode !== null) return resolve()
      child.once('exit', resolve)
      child.kill('SIGKILL')
    })
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('a prompt-only call opens no card, and the refusal names what it wants instead', async () => {
    const text = await ask('curia-422', '422', { kind: 'free-text', prompt: 'which port should the dev server bind?' })

    assert.match(text, /curia refused this call/)
    assert.match(text, /does not carry the fields this kind needs/)
    assert.match(text, /headline: missing/)
    assert.match(text, /questions: missing/)
    assert.match(text, /prompt: retired by the flip/, 'the agent is told where its own words go')
    assert.deepEqual(await openEscalations(port), [], 'a refused call asked nobody anything')
  })

  test('the typed round the flip asks for passes the same gate', async () => {
    const c = await client('curia-422-b', '422')
    const call = c.callTool({
      name: 'ask_human',
      arguments: {
        kind: 'free-text',
        headline: 'Two questions before I write the flip.',
        questions: [{ text: 'does the switch go?', recommendation: 'yes' }],
      },
    }, undefined, { timeout: 30_000 })

    const open = await until(async () => (await openEscalations(port)).find((e) => e.agent === 'curia-422-b'), 'the card to open')
    assert.match(open.prompt, /\*\*Two questions before I write the flip\.\*\*/)
    await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: open.id, answer: 'yes' }),
    })
    const text = (await call).content.map((x) => x.text ?? '').join('\n')
    assert.match(text, /yes/)
    await c.close().catch(() => {})
  })

  test('request_review owns tracker writes and sends their edges through the wave composer', async () => {
    const c = await client('curia-422-writes', '422')
    try {
      const listed = await c.listTools()
      const review = listed.tools.find((tool) => tool.name === 'request_review')
      const notify = listed.tools.find((tool) => tool.name === 'notify')
      assert.ok(review.inputSchema.properties.tracker_writes)
      assert.equal(notify.inputSchema.properties.tracker_writes, undefined)

      const result = await c.callTool({
        name: 'request_review',
        arguments: {
          headline: 'The build proposal is ready.',
          summary: 'The run prepared two tracker items.',
          charting: 'Publish the approved items.',
          tracker_writes: [
            { id: 'schema', title: 'Define the retry schema', labels: ['ready-for-agent'] },
            { id: 'worker', title: 'Drain the retry queue', labels: ['ready-for-agent'], after: ['missing'] },
          ],
        },
      }, undefined, { timeout: 30_000 })
      assert.equal(result.isError, true)
      assert.match(result.content.map((part) => part.text ?? '').join('\n'), /unknown item "missing"/)
    } finally {
      await c.close().catch(() => {})
    }
  })

  test('a composite ask keeps its order and opens only its last decision', async () => {
    const c = await client('curia-422-composite', '422')
    const messages = [
      { format: 'prose', label: 'answer', text: 'The shared contract is ready.', attachments: [] },
      {
        format: 'choice', label: 'decision', headline: 'Which surface should answer?', attachments: [],
        options: [
          { label: 'Use Atlas.', handle: 'Atlas', consequence: 'The browser records the answer.' },
          { label: 'Use Discord.', handle: 'Discord', consequence: 'The thread records the answer.' },
        ],
      },
    ]
    const call = c.callTool({ name: 'ask_human', arguments: { messages } }, undefined, { timeout: 30_000 })

    const open = await until(async () => (await openEscalations(port)).find((e) => e.agent === 'curia-422-composite'), 'the composite card')
    assert.match(open.prompt, /^-# 2 of 2 · decision\n\*\*Which surface should answer\?\*\*/)
    assert.deepEqual(open.options, ['Use Atlas.', 'Use Discord.'])
    assert.equal(open.payload.options[0].handle, 'Atlas')

    const send = journalEvents(path.join(tmp, 'data')).find((event) => event.type === 'composite_send' && event.agent === 'curia-422-composite')
    assert.deepEqual(send.messages, messages)
    await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: open.id, answer: 'Use Atlas.' }),
    })
    assert.match((await call).content.map((part) => part.text ?? '').join('\n'), /Use Atlas\./)
    await c.close().catch(() => {})
  })

  test('a bare string option is refused, and it is named once rather than per field', async () => {
    const text = await ask('curia-422-c', '422', {
      kind: 'choice',
      headline: 'which harness runs this?',
      options: ['claude', 'codex'],
    })

    assert.match(text, /options: a bare string/)
    assert.doesNotMatch(text, /options\[0\]/)
    assert.deepEqual(await openEscalations(port), [])
  })

  test('the retired recommended boolean is refused, because curia derives that button', async () => {
    const text = await ask('curia-422-d', '422', {
      kind: 'free-text',
      headline: 'one question, and a flag that no longer draws anything',
      questions: [{ text: 'is the button derived?', recommendation: 'yes' }],
      recommended: true,
    })

    assert.match(text, /recommended: retired by the flip/)
  })

  test('the cap is three, and the fourth untyped call reaches the operator flagged', async () => {
    // ADR-0019: a schema rejection never traps a question. An agent that keeps
    // sending the old shape still gets its question in front of the operator,
    // and the operator sees which fields were missing.
    const old = { kind: 'free-text', prompt: 'which port should the dev server bind?' }
    for (const attempt of [1, 2, 3]) {
      assert.match(await ask('curia-422-e', '422', old), new RegExp(`attempt ${attempt} of 3`))
    }

    const c = await client('curia-422-e', '422')
    const call = c.callTool({ name: 'ask_human', arguments: old }, undefined, { timeout: 30_000 })
    const open = await until(async () => (await openEscalations(port)).find((e) => e.agent === 'curia-422-e'), 'the flagged card')
    assert.equal(open.prompt, 'which port should the dev server bind?', 'the prompt it wrote is what the operator reads')
    assert.ok(open.lint_flags.some((f) => /headline: missing/.test(f)), 'the faults ride the record')

    await request(port, 'POST', '/answer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: open.id, answer: '9012' }),
    })
    const text = (await call).content.map((x) => x.text ?? '').join('\n')
    assert.match(text, /curia sent this call as it stands/)
    assert.match(text, /9012/)
    await c.close().catch(() => {})

    const events = journalEvents(path.join(tmp, 'data'))
    assert.equal(events.filter((e) => e.type === 'lint_rejected' && e.agent === 'curia-422-e').length, 3,
      'three rejections, and the fourth is a send rather than a fourth refusal')
  })

  test('a call with no prose at all is refused for good, because it has nothing to send', async () => {
    const empty = { kind: 'free-text' }
    for (const attempt of [1, 2, 3]) {
      assert.match(await ask('curia-422-f', '422', empty), new RegExp(`attempt ${attempt} of 3`))
    }
    const text = await ask('curia-422-f', '422', empty)

    assert.match(text, /refused this call for good/)
    assert.match(text, /Nothing here can reach the operator/)
    assert.deepEqual(await openEscalations(port), [], 'no card, because there is no question in it')
  })
})

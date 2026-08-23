// The typed cross-check verdict on the wire (#421, ADR-0010, ADR-0019).
//
// The composer and the grades are unit-tested next door (card.test.mjs,
// lint.test.mjs), and the way back is in crosscheck.test.mjs. What only a real
// boot can answer is whether the MCP tool really carries `findings`, and whether
// the reviewer really takes the lint it was exempt from until this ticket: the
// schema is zod, the refusal is a tool RESULT rather than a throw, and #416
// measured that carriage dying in silence on codex.

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

function request(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.once('error', reject)
    req.end()
  })
}

describe('report_result carries a typed verdict, and the reviewer is linted (#421, real boot)', () => {
  let tmp, child, port, watch

  const verdict = async (agent, ticket, args) => {
    const token = mintAgentToken(path.join(tmp, 'data'), agent)
    const client = new Client({ name: 'curia-421-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp?agent=${agent}&ticket=${ticket}`),
      { requestInit: { headers: { [TOKEN_HEADER]: token } } },
    )
    await client.connect(transport)
    try {
      const r = await client.callTool({ name: 'report_result', arguments: args }, undefined, { timeout: 30_000 })
      return r.content.map((c) => c.text ?? '').join('\n')
    } finally {
      await client.close().catch(() => {})
    }
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-421-test-'))
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

  test('the wire carries the findings, and a typed verdict lands whole', async () => {
    const text = await verdict('curia-review-4211', '4211', {
      ticket: '4211',
      status: 'resolved',
      headline: 'One blocker: the retry loop never exits',
      summary: 'I read the diff and ran the daemon suite. It is green.',
      findings: [
        { text: 'daemon/src/retry.mjs:41 loops while the socket is open, and nothing closes it.', severity: 'blocker' },
        { text: 'daemon/src/card.mjs:52 could name the marker helper once.', severity: 'note', out_of_scope: true },
      ],
    })

    assert.doesNotMatch(text, /curia refused this call/)
    const events = journalEvents(path.join(tmp, 'data'))
    const done = events.find((e) => e.type === 'result' && e.agent === 'curia-review-4211')
    assert.ok(done, 'the verdict is recorded')
    assert.equal(done.findings.length, 2, 'the findings reach the daemon as parts, not as prose')
  })

  test('a finding whose words break a rule is refused, and the refusal names the entry', async () => {
    const text = await verdict('curia-review-4212', '4212', {
      ticket: '4212',
      status: 'resolved',
      headline: 'One concern about the cap',
      summary: 'I read the diff and ran the suite.',
      findings: [{ text: 'daemon/src/lint.mjs:44 is wrong — and the cap is off by one.', severity: 'concern' }],
    })

    assert.match(text, /curia refused this call/)
    assert.match(text, /findings\[0\]\.text: an em-dash/)
    assert.match(text, /attempt 1 of 3/)
    const events = journalEvents(path.join(tmp, 'data'))
    assert.ok(events.some((e) => e.type === 'lint_rejected' && e.agent === 'curia-review-4212' && e.kind === 'report-result'),
      'one ledger for the reviewer, because it makes no other linted call')
    assert.ok(!events.some((e) => e.type === 'result' && e.agent === 'curia-review-4212'),
      'a refused verdict captured nothing')
  })

  test('a finding with no severity is a schema fault, and the fault names the set', async () => {
    const text = await verdict('curia-review-4213', '4213', {
      ticket: '4213',
      status: 'resolved',
      headline: 'One thing to fix',
      summary: 'I read the diff and ran the suite.',
      findings: [{ text: 'daemon/src/lint.mjs:44 states the cap twice.' }],
    })

    assert.match(text, /curia refused this call/)
    assert.match(text, /findings\[0\]\.severity: missing/)
    assert.match(text, /blocker, concern, note/)
    assert.match(text, /fields this kind needs/, 'a missing field is a schema fault, not a word fault')
  })

  test('an untyped verdict is refused since the flip (#422), and nothing of it lands', async () => {
    // The summary alone was a verdict until the flip. It is refused now, and
    // the refusal names both fields it wants: the reviewer writes a headline,
    // and it writes the list even when the list is empty.
    const text = await verdict('curia-review-4214', '4214', {
      ticket: '4214',
      status: 'resolved',
      summary: 'VERDICT: pass. I read the diff and ran the tests. They are green.',
    })

    assert.match(text, /curia refused this call/)
    assert.match(text, /headline: missing/)
    assert.match(text, /findings: missing/)
    const events = journalEvents(path.join(tmp, 'data'))
    assert.ok(!events.some((e) => e.type === 'result' && e.agent === 'curia-review-4214'),
      'a refused verdict reported nothing')
  })

  test('an empty findings list passes the flipped floor, because a clean reading is a result', async () => {
    const text = await verdict('curia-review-4215', '4215', {
      ticket: '4215',
      status: 'resolved',
      headline: 'The diff reads clean',
      summary: 'I read the diff and ran the daemon suite. It is green.',
      findings: [],
    })

    assert.doesNotMatch(text, /curia refused this call/)
    const events = journalEvents(path.join(tmp, 'data'))
    assert.ok(events.some((e) => e.type === 'result' && e.agent === 'curia-review-4215'))
  })
})

// The typed ending report on the wire (#419, ADR-0019).
//
// The composers and the grades are unit-tested next door (card.test.mjs,
// lint.test.mjs). What only a real boot can answer is whether the MCP tool
// really carries the new fields and really refuses a report whose words break a
// rule: the schema is zod, the refusal is a tool RESULT rather than a throw, and
// #416 measured that carriage dying in silence on codex.
//
// Two cases, and the second is the one that guards another ticket's surface. A
// reviewer's `report_result` summary IS the verdict, which ADR-0019 lists as a
// surface of its own and #421 types. It must reach the daemon untouched here.

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

describe('report_result carries the typed fields and the lint gate (#419, real boot)', () => {
  let tmp, child, port, watch

  const call = async (agent, ticket, args) => {
    const token = mintAgentToken(path.join(tmp, 'data'), agent)
    const client = new Client({ name: 'curia-419-test', version: '0.0.0' })
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-419-test-'))
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
      // Required since #390, with no default: a claim assigns a person, because
      // GitHub does not let an App be an assignee. Without it this boot refuses.
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

  test('a report whose words break a rule is refused, and the refusal names the field', async () => {
    const text = await call('curia-419', '419', {
      ticket: '419',
      status: 'resolved',
      headline: 'The report is typed; the lint reads it',
      summary: 'The gate refuses the call and the agent rewrites its own text.',
    })

    assert.match(text, /curia refused this call/)
    assert.match(text, /attempt 1 of 3/)
    assert.match(text, /headline: a semicolon/)
    assert.match(text, /Keep every option and every constraint/)
    const events = journalEvents(path.join(tmp, 'data'))
    assert.ok(events.some((e) => e.type === 'lint_rejected' && e.kind === 'report-result'),
      'the rejection is counted under the report, not under a question')
    assert.ok(!events.some((e) => e.type === 'result'),
      'a refused report reported nothing: no journal line, no results file, no word in the thread')
    assert.ok(!fs.existsSync(path.join(tmp, 'data', 'results', 'curia-419.json')))
  })

  test('a report with no headline is refused since the flip (#422)', async () => {
    const text = await call('curia-419-b', '419', {
      ticket: '419',
      status: 'resolved',
      summary: 'The switch is gone and every floor is unconditional.',
    })

    assert.match(text, /does not carry the fields this kind needs/)
    assert.match(text, /headline: missing/)
    assert.ok(!fs.existsSync(path.join(tmp, 'data', 'results', 'curia-419-b.json')),
      'a refused report reported nothing')
  })

  test("a reviewer takes the VERDICT's shape, which #421 typed and this ticket exempted", async () => {
    // The exemption this test guarded ended with #421. A verdict is linted on
    // its own fields now, and `typedverdict.test.mjs` holds that surface whole.
    const text = await call('curia-review-419', '419', {
      ticket: '419',
      status: 'resolved',
      headline: 'One blocker: the gate counts the wrong attempt',
      summary: 'I read the diff and ran the daemon suite. It is green.',
      findings: [{ text: 'daemon/src/lint.mjs:1 says the cap is a ceiling.', severity: 'note' }],
    })

    assert.doesNotMatch(text, /curia refused this call/)
    const events = journalEvents(path.join(tmp, 'data'))
    assert.ok(events.some((e) => e.type === 'result' && e.agent === 'curia-review-419'))
    assert.ok(!events.some((e) => e.type === 'lint_rejected' && e.agent === 'curia-review-419'))
  })
})

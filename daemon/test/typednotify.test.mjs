// The typed status line on the wire (#420, ADR-0019).
//
// The composer and the grades are unit-tested next door (card.test.mjs,
// lint.test.mjs). What only a real boot can answer is whether the MCP tool
// really carries the new fields, and whether a refused status line really posts
// nothing: the schema is zod, and the refusal is a tool RESULT rather than a
// throw, which #416 measured dying in silence on codex.
//
// The gate is the same one the question and the report go through, on a key of
// its own. A refused status line must not spend a question's three attempts.

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

describe('notify carries the typed fields and the lint gate (#420, real boot)', () => {
  let tmp, child, port, watch

  const call = async (agent, ticket, args) => {
    const token = mintAgentToken(path.join(tmp, 'data'), agent)
    const client = new Client({ name: 'curia-420-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp?agent=${agent}&ticket=${ticket}`),
      { requestInit: { headers: { [TOKEN_HEADER]: token } } },
    )
    await client.connect(transport)
    try {
      const r = await client.callTool({ name: 'notify', arguments: args }, undefined, { timeout: 30_000 })
      return r.content.map((c) => c.text ?? '').join('\n')
    } finally {
      await client.close().catch(() => {})
    }
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-420-test-'))
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

  test('a typed status line lands with its kind, its spoiler and its table', async () => {
    const text = await call('curia-420', '420', {
      kind: 'look',
      message: 'The prototype is up. The page is the one this ticket changed.',
      detail: 'The demo is prototypes/select-menu/index.html.',
      table: 'kind   you must do\nlook   open it now',
    })

    assert.match(text, /^ok/m)
    const events = journalEvents(path.join(tmp, 'data'))
    const line = events.findLast((e) => e.type === 'notify' && e.agent === 'curia-420')
    assert.equal(line.kind, 'look')
    assert.equal(line.detail, 'The demo is prototypes/select-menu/index.html.')
    assert.match(line.table, /look   open it now/)
  })

  test('a phase-only update reaches the editable status line', async () => {
    const text = await call('curia-420-phase', '420', {
      phase: { icon: '🚦', label: 'runs daemon tests' },
    })

    assert.match(text, /^ok/m)
    const events = journalEvents(path.join(tmp, 'data'))
    const phase = events.findLast((event) => event.type === 'agent_phase' && event.agent === 'curia-420-phase')
    assert.deepEqual(phase.phase, { icon: '🚦', label: 'runs daemon tests' })
  })

  test('an unrecognized phase icon reaches the lint refusal', async () => {
    const text = await call('curia-420-bad-phase', '420', {
      phase: { icon: '🏁', label: 'done' },
    })

    assert.match(text, /curia refused this call/)
    assert.match(text, /phase\.icon: use one of/)
    const events = journalEvents(path.join(tmp, 'data'))
    assert.ok(!events.some((event) => event.type === 'agent_phase' && event.agent === 'curia-420-bad-phase'))
  })

  test('an opening and phase update travel through the notify tool', async () => {
    const text = await call('curia-420-opening', '420', {
      opening: {
        goal: 'I’ll make the ticket thread tell one quiet story.',
        first_step: 'I’ll trace dispatch events into the status line first.',
      },
      phase: 'explore',
      label: 'reads the events',
    })

    assert.match(text, /^ok/m)
    const events = journalEvents(path.join(tmp, 'data'))
    const opening = events.findLast((e) => e.type === 'agent_opening' && e.agent === 'curia-420-opening')
    const progress = events.findLast((e) => e.type === 'agent_progress' && e.agent === 'curia-420-opening')
    assert.equal(opening.goal, 'I’ll make the ticket thread tell one quiet story.')
    assert.equal(progress.phase, 'explore')
    assert.equal(progress.label, 'reads the events')

    const duplicate = await call('curia-420-opening', '420', {
      opening: { goal: 'I’ll repeat the opening.', first_step: 'I’ll post it again.' },
      phase: 'build',
      label: 'repeats opening',
    })
    assert.match(duplicate, /opening: already sent for this dispatch/)
    assert.equal(
      journalEvents(path.join(tmp, 'data')).filter((e) => e.type === 'agent_opening' && e.agent === 'curia-420-opening').length,
      1,
    )
  })

  test('a message whose words break a rule is refused, and nothing is posted', async () => {
    const before = journalEvents(path.join(tmp, 'data')).filter((e) => e.type === 'notify').length
    const text = await call('curia-420-b', '420', {
      message: 'The tests are green; the branch is pushed.',
    })

    assert.match(text, /curia refused this call/)
    assert.match(text, /attempt 1 of 3/)
    assert.match(text, /message: a semicolon/)
    const events = journalEvents(path.join(tmp, 'data'))
    assert.ok(events.some((e) => e.type === 'lint_rejected' && e.kind === 'notify'),
      'the rejection is counted under the status line, not under a question')
    assert.equal(events.filter((e) => e.type === 'notify').length, before,
      'a refused status line posted nothing')
  })

  test('a status line with no message is a schema fault, named as one', async () => {
    const text = await call('curia-420-c', '420', { detail: 'facts with no line above them' })

    assert.match(text, /does not carry the fields this kind needs/)
    assert.match(text, /message: missing/)
  })

  test('the cap is three, and the fourth text goes out flagged', async () => {
    const bad = { message: 'The run is done — and the report is written.' }
    for (const attempt of [1, 2, 3]) {
      const text = await call('curia-420-d', '420', bad)
      assert.match(text, new RegExp(`attempt ${attempt} of 3`))
    }
    const text = await call('curia-420-d', '420', bad)

    assert.match(text, /curia posted your status line as it stands/)
    assert.match(text, /Do not send it again/)
    const events = journalEvents(path.join(tmp, 'data'))
    const line = events.findLast((e) => e.type === 'notify' && e.agent === 'curia-420-d')
    assert.ok(line, 'the fourth text is posted rather than refused for good')
    assert.equal(line.lint_flags.length, 1, 'the faults ride the record')
  })

  test('a rejected status line does not spend a question\'s three attempts', async () => {
    const events = journalEvents(path.join(tmp, 'data'))
    const kinds = new Set(events.filter((e) => e.type === 'lint_rejected').map((e) => e.kind))
    assert.ok(kinds.has('notify'))
    assert.ok(!kinds.has('free-text'), 'the ledger keys the status line apart from the card')
  })
})

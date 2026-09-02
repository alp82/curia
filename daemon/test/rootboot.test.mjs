// The real daemon under an installation root (#867).
//
// Two boots against a root the test owns. The first carries a long-lived
// credential in the environment, which the root refuses by key name and
// without printing the value. The second boots on the root's own layout: the
// journal lands in `state/`, the worktrees are told to go to `work/`, the
// secret files are read from `secrets/`, and the overview names each secret
// by presence and never by value.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePorts, waitForBoot, watchDaemon } from './fixtures/real-boot.mjs'
import { seedSkillsRoot } from './fixtures/skills.mjs'
import { sandboxYaml } from './fixtures/sandbox.mjs'
import { ensureLayout } from '../../cli/src/root.mjs'
import { CREDENTIAL_ENV_KEYS, SECRET_NAMES, writeSecret } from '../../cli/src/secrets.mjs'
import { writeDiscordSettings } from '../src/discordsettings.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

const TOKEN = 'MTIz.this-value-must-never-be-printed.abc'

describe('the daemon under an installation root (#867)', () => {
  let tmp
  let root
  let cfgDir
  let ports

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-rootboot-'))
    root = path.join(tmp, 'install')
    ensureLayout(root, { uid: process.getuid() })
    cfgDir = path.join(tmp, 'config')
    fs.mkdirSync(cfgDir, { recursive: true })
    ports = await freePorts(4)
    const [, ttydPort, servePort, proxyPort] = ports
    fs.writeFileSync(path.join(cfgDir, 'curia.yaml'), [
      'watch:',
      '  - repo: example/fixture',
      'dispatch:',
      '  auto_dispatch: false',
      '  max_concurrent: 1',
      '  poll_interval_s: 60',
      // The source deployment's answer, which the root outranks.
      `  workspace_root: ${path.join(tmp, 'not-the-workspace')}`,
      '  claim_login: alp82',
      '  ready_timeout_s: 5',
      'attach:',
      `  ttyd_port: ${ttydPort}`,
      `  serve_port: ${servePort}`,
      'identity:',
      '  allow: [tester@example.com]',
      `  proxy_port: ${proxyPort}`,
      'skills:',
      `  root: ${seedSkillsRoot(path.join(tmp, 'owned'))}`,
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
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  // The runner's own environment may carry a GitHub token; under a root every
  // one of those keys is blanked so the boot under test decides.
  const cleanEnv = () => Object.fromEntries(CREDENTIAL_ENV_KEYS.map((k) => [k, '']))

  const boot = (extraEnv) => spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      ...cleanEnv(),
      PORT: String(ports[0]),
      CURIA_CONFIG_DIR: cfgDir,
      CURIA_ROOT: root,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  test('a credential in the environment refuses the boot by key name, and the value is never printed', async () => {
    const child = boot({ DISCORD_BOT_TOKEN: TOKEN })
    const watch = watchDaemon(child)
    try {
      await assert.rejects(
        () => waitForBoot(watch, () => false, 'its listening line'),
        /never got a daemon[\s\S]*DISCORD_BOT_TOKEN[\s\S]*secrets/,
      )
      assert.ok(!watch.log().includes(TOKEN), 'the refusal names the key and never the value')
      assert.ok(watch.log().includes(path.join(root, 'secrets')), 'and names where the secret file goes')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })

  test('the same daemon boots on the root, and reads and reports secrets by presence only', async () => {
    writeSecret(root, 'discord-bot-token', `${TOKEN}\n`)
    // No allowed user: the bridge must refuse to start and say which file
    // names the gate, and the token must not leak into that sentence either.
    writeDiscordSettings(path.join(root, 'state'), { allowed_users: [] })
    const child = boot({})
    const watch = watchDaemon(child)
    try {
      await waitForBoot(watch, () => /curia daemon listening/.test(watch.log()), 'its listening line')
      const log = watch.log()
      assert.ok(!log.includes(TOKEN), 'the boot log never carries the token')
      assert.match(log, /discord\.json names no allowed user/)
      assert.ok(fs.existsSync(path.join(root, 'state', 'events.db')), 'the journal lands in state/')
      assert.ok(fs.existsSync(path.join(root, 'state', 'tokens')), 'the agent token store lands in state/')
      assert.ok(!fs.existsSync(path.join(tmp, 'not-the-workspace')), 'the file\'s workspace root is not used')

      const res = await fetch(`http://127.0.0.1:${ports[0]}/overview`)
      assert.equal(res.status, 200)
      const text = await res.text()
      assert.ok(!text.includes(TOKEN), 'the overview never carries the token')
      const overview = JSON.parse(text)
      assert.deepEqual(Object.keys(overview.secrets), [...SECRET_NAMES])
      assert.equal(overview.secrets['discord-bot-token'].state, 'present')
      assert.equal(overview.secrets['github-app.json'].state, 'absent')

      // Integration setup (#874) under the root: the read verifies fresh.
      // The GitHub card (#875) is plain while `secrets/github-app.json` is
      // absent, the Discord card (#876) fails on the missing operator ID
      // before Discord is asked and its sentence carries no token, every
      // card whose ticket has not landed is not available, the write keeps
      // the selected card in `state/setup.json`, and a field that is not on
      // the closed list is refused by name.
      const setupText = await (await fetch(`http://127.0.0.1:${ports[0]}/setup`)).text()
      assert.ok(!setupText.includes(TOKEN), 'the setup read never carries the token')
      const setup = JSON.parse(setupText)
      assert.deepEqual(setup.cards.map((c) => [c.key, c.state]), [
        ['github', 'unconnected'], ['discord', 'failed'], ['tailscale', 'unconnected'], ['model', 'unconnected'],
      ])
      // The OpenAI half of the model card (#878) under a root: the panel's
      // read is the credential by presence, no login in flight, and the
      // routing readiness, with no key and no token anywhere in it.
      const openaiText = await (await fetch(`http://127.0.0.1:${ports[0]}/setup/openai`)).text()
      assert.ok(!openaiText.includes(TOKEN))
      const openai = JSON.parse(openaiText)
      assert.deepEqual(openai.secret, { state: 'absent' })
      assert.equal(openai.login, null)
      assert.equal(openai.routing.ready, false)
      assert.ok(!/api_key|apiKey/.test(openaiText))
      // The Anthropic half (#879) under a root: the same presence-only
      // read on the store's secret file, no login in flight, the same
      // routing readiness, and no token and no key in it.
      const anthropicText = await (await fetch(`http://127.0.0.1:${ports[0]}/setup/anthropic`)).text()
      assert.ok(!anthropicText.includes(TOKEN))
      const anthropicRead = JSON.parse(anthropicText)
      assert.deepEqual(anthropicRead.secret, { state: 'absent' })
      assert.equal(anthropicRead.credential, null)
      assert.equal(anthropicRead.login, null)
      assert.equal(anthropicRead.routing.model, 'sonnet')
      assert.ok(!/api_key|apiKey|sk-ant-/.test(anthropicText))
      // The Tailscale card (#877) under a root: no operator is recorded, so
      // the identity read says nobody is admitted and the first-operator
      // window is open; curia.yaml's `tester@example.com` admits nobody here.
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${ports[0]}/identity`)).json(), { allow: [], first_operator: true })
      const noIdentity = await fetch(`http://127.0.0.1:${ports[0]}/setup/tailscale/operator`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: '', machine_name: 'curia.sh' }) })
      assert.equal(noIdentity.status, 400)
      assert.match((await noIdentity.json()).error, /no Tailscale identity/)
      const confirmedOp = await (await fetch(`http://127.0.0.1:${ports[0]}/setup/tailscale/operator`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'Operator@Example.com', machine_name: 'curia-rootboot-test' }) })).json()
      assert.equal(confirmedOp.ok, true)
      assert.equal(confirmedOp.operator.login, 'operator@example.com')
      assert.equal(confirmedOp.card.key, 'tailscale')
      // The name can't match this host, so the verification stops before the
      // Serve step and this test never publishes a route on the runner.
      assert.equal(confirmedOp.card.state, 'failed', 'a confirmed operator is verified, whatever this host says about tailscale')
      assert.ok(['node', 'certificate', 'name'].includes(confirmedOp.card.detail.stage), confirmedOp.card.detail.stage)
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${ports[0]}/identity`)).json(), { allow: ['operator@example.com'], first_operator: false })
      const tsRecord = JSON.parse(fs.readFileSync(path.join(root, 'state', 'tailscale.json'), 'utf8'))
      assert.equal(tsRecord.operator.login, 'operator@example.com')
      assert.equal(fs.statSync(path.join(root, 'state', 'tailscale.json')).mode & 0o777, 0o600)
      assert.match(setup.cards[1].error.failed, /No Discord user ID/)
      assert.equal(setup.step, 'github')
      assert.equal(setup.full_loop.ready, false)
      const post = (body) => fetch(`http://127.0.0.1:${ports[0]}/setup`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const kept = await post({ step: 'tailscale', progress: { tailscale: { machine_name: 'curia.sh' } } })
      assert.equal(kept.status, 200)
      const record = JSON.parse(fs.readFileSync(path.join(root, 'state', 'setup.json'), 'utf8'))
      assert.deepEqual(record, { format: 1, step: 'tailscale', progress: { tailscale: { machine_name: 'curia.sh' } } })
      const refused = await post({ progress: { discord: { token: TOKEN } } })
      assert.equal(refused.status, 400)
      const refusal = await refused.text()
      assert.match(refusal, /token.* is not a field the discord card may remember/)
      assert.ok(!refusal.includes(TOKEN))
      assert.ok(!fs.readFileSync(path.join(root, 'state', 'setup.json'), 'utf8').includes(TOKEN))
      assert.equal((await (await fetch(`http://127.0.0.1:${ports[0]}/setup`)).json()).step, 'tailscale')
      // The settings screen through the service (#880): under a root the app
      // mounts nothing, so its sidecar reads the two files here and lands a
      // save here, on the root's config/config.yaml and state/routing.local.yaml,
      // through the operator configuration contract.
      const settings = await (await fetch(`http://127.0.0.1:${ports[0]}/settings`)).json()
      assert.deepEqual(settings.writes, { curia: path.join(root, 'config', 'config.yaml'), routing: path.join(root, 'state', 'routing.local.yaml') })
      assert.equal(settings.dispatch.max_concurrent, 1)
      const saveSettingsAt = (body) => fetch(`http://127.0.0.1:${ports[0]}/settings`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const saved = await saveSettingsAt({ dispatch: { max_concurrent: 2 } })
      assert.equal(saved.status, 200)
      assert.deepEqual((await saved.json()).written, ['config.yaml'])
      const configFile = path.join(root, 'config', 'config.yaml')
      assert.equal(fs.statSync(configFile).mode & 0o777, 0o600)
      assert.match(fs.readFileSync(configFile, 'utf8'), /^max_concurrent: 2$/m)
      assert.equal((await (await fetch(`http://127.0.0.1:${ports[0]}/settings`)).json()).dispatch.max_concurrent, 2)
      const refusedSave = await saveSettingsAt({ dispatch: { max_concurrent: 0 } })
      assert.equal(refusedSave.status, 400)
      assert.match((await refusedSave.json()).error, /max_concurrent.*positive whole number/)
      assert.match(fs.readFileSync(configFile, 'utf8'), /^max_concurrent: 2$/m, 'a refused save moves nothing')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })
})

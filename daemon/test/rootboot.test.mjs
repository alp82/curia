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
import { createInstallationRecord, ensureLayout, versionPaths, writeInstallationRecord } from '../../cli/src/root.mjs'
import { CREDENTIAL_ENV_KEYS, SECRET_NAMES, writeSecret } from '../../cli/src/secrets.mjs'
import { STABLE_INDEX_KEY_FILE, createStableIndex, generateStableIndexKeys, signStableIndex } from '../../cli/src/stable.mjs'
import { APP_VERSION } from '../src/appversion.mjs'
import { writeDiscordSettings } from '../src/discordsettings.mjs'
import http from 'node:http'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(DIR, '..', 'src', 'index.mjs')

const TOKEN = 'MTIz.this-value-must-never-be-printed.abc'

describe('the daemon under an installation root (#867)', () => {
  let tmp
  let root
  let cfgDir
  let ports
  // The daily update check (#883): a signed stable-release index on a local
  // server, and the key that signed it where the daemon reads it, in the
  // active version's package under versions/.
  const indexKeys = generateStableIndexKeys()
  const indexText = signStableIndex(createStableIndex({ sequence: 3, updated: '2026-09-01T00:00:00Z', stable: '9.9.9', withdrawn: [APP_VERSION] }), indexKeys.privateKey)
  let indexServer
  let indexUrl

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-rootboot-'))
    root = path.join(tmp, 'install')
    ensureLayout(root, { uid: process.getuid() })
    writeInstallationRecord(root, createInstallationRecord(APP_VERSION))
    const keyDir = path.join(versionPaths(root, APP_VERSION).dir, 'cli')
    fs.mkdirSync(keyDir, { recursive: true })
    fs.writeFileSync(path.join(keyDir, STABLE_INDEX_KEY_FILE), indexKeys.publicKey)
    indexServer = http.createServer((req, res) => {
      res.writeHead(req.url === '/release/stable.json' ? 200 : 404, { 'content-type': 'application/json' })
      res.end(req.url === '/release/stable.json' ? indexText : '{}')
    })
    await new Promise((resolve) => indexServer.listen(0, '127.0.0.1', resolve))
    indexUrl = `http://127.0.0.1:${indexServer.address().port}/release/stable.json`
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
  after(() => {
    indexServer?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // The runner's own environment may carry a GitHub token; under a root every
  // one of those keys is blanked so the boot under test decides.
  const cleanEnv = () => Object.fromEntries(CREDENTIAL_ENV_KEYS.map((k) => [k, '']))

  // The Tailscale card compares no name since #891, so a confirmed operator
  // on a runner whose real node is logged in with a certificate would reach
  // the Serve step and publish a route. A `tailscale` shim first on the
  // daemon's PATH answers a logged-out node, so the verification stops at
  // the node and this test never touches the runner's tailnet.
  const shim = () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'tailscale-shim-'))
    fs.writeFileSync(path.join(dir, 'tailscale'), '#!/bin/sh\necho \'{"BackendState":"NeedsLogin","CertDomains":[],"Self":{"DNSName":"","Online":false}}\'\n', { mode: 0o755 })
    return dir
  }

  const boot = (extraEnv) => spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      ...cleanEnv(),
      PATH: `${shim()}:${process.env.PATH ?? ''}`,
      PORT: String(ports[0]),
      CURIA_CONFIG_DIR: cfgDir,
      CURIA_ROOT: root,
      CURIA_STABLE_INDEX_URL: indexUrl,
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

      // The switch (#884) proves the service came back on the target
      // release by reading its version off the reachability probe.
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${ports[0]}/ping`)).json(), { curia: 'curia-side-channel', port: ports[0], version: APP_VERSION })

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
      const noIdentity = await fetch(`http://127.0.0.1:${ports[0]}/setup/tailscale/operator`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: '' }) })
      assert.equal(noIdentity.status, 400)
      assert.match((await noIdentity.json()).error, /no Tailscale identity/)
      const confirmedOp = await (await fetch(`http://127.0.0.1:${ports[0]}/setup/tailscale/operator`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'Operator@Example.com' }) })).json()
      assert.equal(confirmedOp.ok, true)
      assert.equal(confirmedOp.operator.login, 'operator@example.com')
      assert.equal(confirmedOp.card.key, 'tailscale')
      // The shimmed node is logged out, so the verification stops at the
      // node and this test never publishes a route on the runner.
      assert.equal(confirmedOp.card.state, 'failed', 'a confirmed operator is verified, whatever this host says about tailscale')
      assert.equal(confirmedOp.card.detail.stage, 'node')
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
      // The Full loop's run (#882) under a root: nothing has run, the read
      // says so from the journal, and the press refuses the closed gate by
      // its reason without dispatching anything.
      const run = await (await fetch(`http://127.0.0.1:${ports[0]}/setup/full-loop`)).json()
      assert.equal(run.state, 'idle')
      assert.equal(run.legs.length, 8)
      assert.equal((await (await fetch(`http://127.0.0.1:${ports[0]}/setup`)).json()).full_loop.run.state, 'idle')
      const pressed = await fetch(`http://127.0.0.1:${ports[0]}/setup/full-loop`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      })
      assert.equal(pressed.status, 400)
      assert.match((await pressed.json()).error, /The Full loop isn't ready: Waiting for/)
      const retried = await fetch(`http://127.0.0.1:${ports[0]}/setup/full-loop/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      })
      assert.equal(retried.status, 400)
      assert.match((await retried.json()).error, /nothing to retry/i)
      assert.equal((await (await fetch(`http://127.0.0.1:${ports[0]}/setup/full-loop`)).json()).state, 'idle')
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
      // The daily update check (#883) under a root: the boot found no
      // record, so it checked at once against the local index, verified it
      // with the key under versions/<active>/cli/, recorded only the result
      // in state/, and the read says what it found. Nothing was downloaded.
      let update
      for (let i = 0; i < 100 && !update?.checked_at; i += 1) {
        update = await (await fetch(`http://127.0.0.1:${ports[0]}/update`)).json()
        if (!update.checked_at) await new Promise((r) => setTimeout(r, 100))
      }
      assert.equal(update.ok, true, update.error)
      assert.equal(update.managed, true)
      assert.equal(update.installed, APP_VERSION)
      assert.equal(update.recommended, '9.9.9')
      assert.equal(update.update_available, true)
      assert.equal(update.installed_withdrawn, true)
      assert.equal(update.release_notes.recommended, 'https://github.com/alp82/curia/releases/tag/v9.9.9')
      assert.ok(update.next_check_at > update.checked_at)
      const checkFile = path.join(root, 'state', 'update-check.json')
      assert.equal(fs.statSync(checkFile).mode & 0o777, 0o600)
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(checkFile, 'utf8'))), ['format', 'checked_at', 'ok', 'error', 'succeeded_at', 'index'])
      assert.match(watch.log(), /update check: stable 9\.9\.9, installed/)
      assert.ok(!fs.existsSync(path.join(root, 'versions', '9.9.9')), 'the check stages nothing')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })

  // The #891 rehearsal: a restart in the middle of the GitHub card found
  // `state/github-app-setup.json` with an Action identity and crashed on
  // the resume before the Action coordinator existed, in a loop.
  test('a pending GitHub App setup with an Action identity in state/ boots', async () => {
    const setupFile = path.join(root, 'state', 'github-app-setup.json')
    fs.writeFileSync(setupFile, `${JSON.stringify({ state: 'a'.repeat(64), expires_at: Date.now() + 3_600_000, status: 'pending', screen: 'setup', action_id: 'act-891' })}\n`, { mode: 0o600 })
    const child = boot({})
    const watch = watchDaemon(child)
    try {
      await waitForBoot(watch, () => /curia daemon listening/.test(watch.log()), 'its listening line')
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${ports[0]}/ping`)).json(), { curia: 'curia-side-channel', port: ports[0], version: APP_VERSION })
      const overview = await (await fetch(`http://127.0.0.1:${ports[0]}/overview`)).json()
      assert.equal(overview.github_app.status, 'pending', 'the setup in flight is still in flight')
      assert.equal(overview.github_app.action_id, 'act-891')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      fs.rmSync(setupFile, { force: true })
    }
  })
})

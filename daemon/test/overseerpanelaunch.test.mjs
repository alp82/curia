import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { conversationHomeFor, writeConversationConnection } from '../src/overseeridentity.mjs'
import { overseerHomeFor, overseerConfigDirFor } from '../src/overseerturn.mjs'
import { toolsFor } from '../src/overseerprompt.mjs'

const session = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const runner = fileURLToPath(new URL('../bin/curia-overseer-pane.mjs', import.meta.url))
const preload = fileURLToPath(new URL('./fixtures/overseer-pane-launch.mjs', import.meta.url))

for (const flag of ['--session-id', '--resume']) {
  test(`the executable launches ${flag} in bypass mode with its conversation connection`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-pane-launch-'))
    try {
      const home = conversationHomeFor(overseerHomeFor(root), session)
      const connection = writeConversationConnection({ home, url: 'http://example.invalid/mcp',
        serverName: 'curia', header: 'x-test', token: 'test-conversation-token' })
      const originalConnection = fs.readFileSync(connection, 'utf8')
      const capture = path.join(root, 'launch.json')
      execFileSync(process.execPath, ['--import', preload, runner, flag, session], {
        env: { ...process.env, CURIA_TEST_ROOT: root, CURIA_TEST_CAPTURE: capture },
        timeout: 15_000,
      })
      const launch = JSON.parse(fs.readFileSync(capture, 'utf8'))
      const value = (name) => launch.args[launch.args.indexOf(name) + 1]
      assert.ok(launch.args.includes('--permission-mode'))
      assert.equal(value('--permission-mode'), 'bypassPermissions')
      assert.equal(value(flag), session)
      assert.equal(launch.cwd, home)
      assert.equal(launch.configDir, overseerConfigDirFor(root))
      assert.equal(launch.toolSearch, '0')
      const policy = toolsFor({ shell: true })
      assert.equal(value('--allowed-tools'), policy.allowed.join(','))
      assert.equal(value('--disallowed-tools'), policy.disallowed.join(','))
      assert.equal(fs.readFileSync(connection, 'utf8'), originalConnection)
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
      assert.equal(settings.enableAllProjectMcpServers, true)
      const config = JSON.parse(fs.readFileSync(path.join(launch.configDir, '.claude.json'), 'utf8'))
      assert.equal(config.projects[home].hasTrustDialogAccepted, true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

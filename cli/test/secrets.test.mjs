import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, chmodSync, statSync, symlinkSync, writeFileSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SECRET_FILES, SECRET_NAMES, SECRET_MODE, SecretError, CREDENTIAL_ENV_KEYS,
  secretPath, readSecret, writeSecret, secretsStatus, credentialsInEnvironment, redact,
} from '../src/secrets.mjs'
import { ensureLayout } from '../src/root.mjs'

const me = process.getuid()

let home
let root

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'curia-secrets-'))
  root = join(home, 'curia')
  ensureLayout(root, { uid: me })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function refuses(fn, pattern) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof SecretError, `expected a SecretError, got ${e.name}: ${e.message}`)
    assert.match(e.message, pattern)
    return true
  })
}

describe('the catalogue', () => {
  test('names the five long-lived credentials Curia owns, one file each', () => {
    assert.deepEqual([...SECRET_NAMES], ['discord-bot-token', 'github-app.json', 'github-operator.json', 'anthropic.json', 'codex-auth.json'])
    for (const entry of SECRET_FILES) {
      assert.ok(entry.name && entry.holds && entry.writer, `${entry.name} is documented`)
    }
  })

  test('secret files are owner-only', () => {
    assert.equal(SECRET_MODE, 0o600)
  })

  test('secretPath is inside secrets/ and refuses a name off the catalogue', () => {
    assert.equal(secretPath(root, 'discord-bot-token'), join(root, 'secrets', 'discord-bot-token'))
    refuses(() => secretPath(root, 'passwords.txt'), /not a secret Curia knows/)
    refuses(() => secretPath(root, '../state/installation.json'), /not a secret Curia knows/)
  })
})

describe('writeSecret and readSecret', () => {
  test('a written secret lands owner-only and reads back whole', () => {
    writeSecret(root, 'discord-bot-token', 'MTIz.abc.def\n')
    const file = secretPath(root, 'discord-bot-token')
    assert.equal(statSync(file).mode & 0o777, SECRET_MODE)
    assert.equal(readSecret(root, 'discord-bot-token'), 'MTIz.abc.def\n')
    assert.deepEqual(readdirSync(join(root, 'secrets')), ['discord-bot-token'], 'no temp file left behind')
  })

  test('an absent secret reads as null', () => {
    assert.equal(readSecret(root, 'anthropic.json'), null)
  })

  test('a rewrite replaces the file atomically and keeps the mode', () => {
    writeSecret(root, 'anthropic.json', '{"token":"one"}\n')
    chmodSync(secretPath(root, 'anthropic.json'), 0o600)
    writeSecret(root, 'anthropic.json', '{"token":"two"}\n')
    assert.equal(readSecret(root, 'anthropic.json'), '{"token":"two"}\n')
    assert.equal(statSync(secretPath(root, 'anthropic.json')).mode & 0o777, SECRET_MODE)
  })

  test('an empty secret is refused before anything touches the disk', () => {
    refuses(() => writeSecret(root, 'discord-bot-token', '   \n'), /empty/)
    assert.equal(readSecret(root, 'discord-bot-token'), null)
  })

  test('a secret that other users can read is refused, and the message names the fix', () => {
    writeSecret(root, 'codex-auth.json', '{}\n')
    chmodSync(secretPath(root, 'codex-auth.json'), 0o644)
    refuses(() => readSecret(root, 'codex-auth.json'), /chmod 0600/)
  })

  test('a symbolic link at a secret path is refused', () => {
    const target = join(home, 'elsewhere')
    writeFileSync(target, 'x', { mode: 0o600 })
    symlinkSync(target, secretPath(root, 'github-app.json'))
    refuses(() => readSecret(root, 'github-app.json'), /symbolic link/)
    // The writer replaces the link with a real file rather than following it.
    writeSecret(root, 'github-app.json', '{"id":"1","pem":"k"}\n')
    assert.ok(!lstatSync(secretPath(root, 'github-app.json')).isSymbolicLink())
    assert.equal(readSecret(root, 'github-app.json'), '{"id":"1","pem":"k"}\n')
  })

  test('a secret owned by another user is refused', () => {
    writeSecret(root, 'discord-bot-token', 'tok\n')
    refuses(() => readSecret(root, 'discord-bot-token', { uid: me + 1 }), /owned by user/)
  })
})

describe('secretsStatus', () => {
  test('reports presence and refusals by name, never a value', () => {
    writeSecret(root, 'discord-bot-token', 'MTIz.secret.value\n')
    writeSecret(root, 'anthropic.json', '{"token":"sk-ant-secret"}\n')
    chmodSync(secretPath(root, 'anthropic.json'), 0o640)
    const status = secretsStatus(root)
    assert.deepEqual(Object.keys(status), [...SECRET_NAMES])
    assert.equal(status['discord-bot-token'].state, 'present')
    assert.equal(status['github-app.json'].state, 'absent')
    assert.equal(status['anthropic.json'].state, 'refused')
    assert.match(status['anthropic.json'].why, /chmod 0600/)
    const text = JSON.stringify(status)
    assert.ok(!text.includes('secret.value') && !text.includes('sk-ant-secret'), 'a status carries no value')
  })
})

describe('credentialsInEnvironment', () => {
  test('names the environment keys that carry a long-lived credential, and only those', () => {
    assert.deepEqual(credentialsInEnvironment({ PATH: '/bin', DISCORD_BOT_TOKEN: 'x', CURIA_GH_APP_KEY_FILE: 'k.pem', HOME: '/h' }),
      ['DISCORD_BOT_TOKEN', 'CURIA_GH_APP_KEY_FILE'])
    assert.deepEqual(credentialsInEnvironment({ DISCORD_BOT_TOKEN: '' }), [], 'an empty value carries nothing')
    assert.deepEqual(credentialsInEnvironment({}), [])
    for (const key of ['DISCORD_BOT_TOKEN', 'CURIA_GH_APP_ID', 'CURIA_GH_APP_KEY_FILE', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      assert.ok(CREDENTIAL_ENV_KEYS.includes(key), `${key} is on the list`)
    }
  })
})

describe('redact', () => {
  test('replaces every secret value in a text and leaves the rest alone', () => {
    const text = 'token=MTIz.abc.def and again MTIz.abc.def, key sk-ant-x'
    assert.equal(redact(text, ['MTIz.abc.def', 'sk-ant-x', '', null]), 'token=[redacted] and again [redacted], key [redacted]')
    assert.equal(redact('nothing here', ['MTIz']), 'nothing here')
  })
})

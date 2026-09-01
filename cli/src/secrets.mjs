import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeAtomically } from './atomic.mjs'

// The long-lived credentials Curia owns, one owner-only file each under
// `secrets/` in the installation root (#867, implementing #851 and #852).
//
// A long-lived credential reaches a consumer through a file and nothing else:
// never an environment variable, a Compose interpolation, a command argument,
// a log line, a diagnostic, or a browser response. The service is the one
// process that reads and replaces these files. Every other consumer gets a
// copy of the one credential it needs, written by the service into that
// consumer's own directory, or a renewable token derived from it.
//
// Renewable tokens (GitHub App installation tokens, agent tokens) and
// session-bound capabilities are not on this list. They live under `run/` and
// `work/` and are recreated or bound to a session.
export const SECRET_FILES = Object.freeze([
  Object.freeze({
    name: 'discord-bot-token',
    holds: 'the Discord bot token, one line',
    writer: 'the Discord integration step of setup',
  }),
  Object.freeze({
    name: 'github-app.json',
    holds: 'the GitHub App: `{ "id": "<app id>", "pem": "<private key>" }`',
    writer: 'the GitHub integration step of setup, from the manifest conversion',
  }),
  Object.freeze({
    name: 'anthropic.json',
    holds: 'the Anthropic subscription credential the service adopted',
    writer: 'the Anthropic integration step of setup, or `reauth anthropic`',
  }),
  Object.freeze({
    name: 'codex-auth.json',
    holds: 'the OpenAI Codex credential, refreshed by the service',
    writer: 'the OpenAI integration step of setup, or `reauth codex`, and the service on refresh',
  }),
])

export const SECRET_NAMES = Object.freeze(SECRET_FILES.map((s) => s.name))

export const SECRET_MODE = 0o600

// A secret boundary that is not met. It is not a `Refusal`: the process that
// meets one decides what it means. The service refuses to boot on it, and
// `curia doctor` reports it. The message never carries a secret value.
export class SecretError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SecretError'
  }
}

export function secretPath(root, name) {
  if (!SECRET_NAMES.includes(name)) {
    throw new SecretError(`${name} is not a secret Curia knows. The secret files are ${SECRET_NAMES.join(', ')}.`)
  }
  return join(root, 'secrets', name)
}

// The secret's text, or `null` when the file is absent. A file that is a
// symbolic link, that another user owns, or that the group or others can read
// is refused, because a secret that reaches past its owner is no longer a
// secret and the fix is the operator's.
export function readSecret(root, name, { uid = process.getuid?.() } = {}) {
  const file = secretPath(root, name)
  const fault = inspect(file, { uid })
  if (fault === 'absent') return null
  if (fault) throw new SecretError(fault)
  return readFileSync(file, 'utf8')
}

// Writes the secret atomically at mode 0600. A symbolic link at the target is
// replaced by the file, never followed. The parent `secrets/` exists because
// `ensureLayout` created it.
export function writeSecret(root, name, text) {
  const file = secretPath(root, name)
  if (typeof text !== 'string' || text.trim() === '') {
    throw new SecretError(`refusing to write an empty ${name}`)
  }
  writeAtomically(file, text, { mode: SECRET_MODE })
}

// Presence and refusals by name, for a diagnostic. No value is read.
export function secretsStatus(root, { uid = process.getuid?.() } = {}) {
  const status = {}
  for (const name of SECRET_NAMES) {
    const fault = inspect(secretPath(root, name), { uid })
    if (fault === 'absent') status[name] = { state: 'absent' }
    else if (fault) status[name] = { state: 'refused', why: fault }
    else status[name] = { state: 'present' }
  }
  return status
}

function inspect(file, { uid }) {
  let stat
  try {
    stat = lstatSync(file)
  } catch (e) {
    if (e.code === 'ENOENT') return 'absent'
    throw e
  }
  if (stat.isSymbolicLink()) {
    return `${file} is a symbolic link. Curia does not follow links in secrets/. Replace the link with the real file.`
  }
  if (!stat.isFile()) {
    return `${file} is not a regular file. Move it out of the way and write the secret again.`
  }
  if (uid !== undefined && stat.uid !== uid) {
    return `${file} is owned by user ${stat.uid}, not by you (user ${uid}). Run the service as the owner, or write the secret again as yourself.`
  }
  if ((stat.mode & 0o077) !== 0) {
    return `${file} has mode 0${(stat.mode & 0o777).toString(8).padStart(3, '0')}, which lets other users read it. Run 'chmod 0600 ${file}' and try again.`
  }
  return null
}

// The environment keys that used to carry a long-lived credential into the
// service, or would if an operator set them. A service running from an
// installation root refuses to boot while any of them is set, naming the key
// and the secret file to use instead, so a credential never enters a process
// environment by habit.
export const CREDENTIAL_ENV_KEYS = Object.freeze([
  'DISCORD_BOT_TOKEN',
  'CURIA_GH_APP_ID',
  'CURIA_GH_APP_KEY_FILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
])

export function credentialsInEnvironment(env) {
  return CREDENTIAL_ENV_KEYS.filter((key) => typeof env[key] === 'string' && env[key] !== '')
}

// Every occurrence of every given value replaced, for text that may carry a
// secret on its way to a log or a response.
export function redact(text, values) {
  let out = String(text)
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue
    out = out.split(value).join('[redacted]')
  }
  return out
}

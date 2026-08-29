import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

import { TOKEN_HEADER } from './agenttoken.mjs'
import { codexAccessTokenExpiry } from './credentials.mjs'

export const CODEX_CONFIG_ROOT_ENV = 'CODEX_HOME'
export const CODEX_MEMORY_FILE = 'AGENTS.md'
export const CODEX_REPO_SKILL_ROOTS = Object.freeze([
  ['.codex', 'skills'],
  ['.agents', 'skills'],
])

const MCP_SERVER_NAME = 'curia'
const LOOPBACK_HOST = '127.0.0.1'
const TOOL_TIMEOUT_S = 86_400

const toml = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const mcpUrl = (daemonPort, agent, ticket, host = LOOPBACK_HOST) => (
  `http://${host}:${daemonPort}/mcp?agent=${agent}&ticket=${ticket}`
)

const stopHookCommand = (daemonPort, agent, host = LOOPBACK_HOST, token) => [
  `curl -s -X POST 'http://${host}:${daemonPort}/agent_done?agent=${agent}'`,
  `-H 'Content-Type: application/json'`,
  `-H '${TOKEN_HEADER}: ${token}'`,
  '-d @-',
].join(' ')

function writeSecretFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

function hiddenSkillNames(cfgDir, names) {
  return (names ?? []).filter((name) => {
    const manifest = path.join(cfgDir, 'skills', name, 'agents', 'openai.yaml')
    let document
    try {
      document = parseYaml(fs.readFileSync(manifest, 'utf8'))
    } catch {
      return false
    }
    return document?.policy?.allow_implicit_invocation === false
  })
}

function skillDescription(cfgDir, name) {
  let text
  try {
    text = fs.readFileSync(path.join(cfgDir, 'skills', name, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  let frontmatter
  try {
    frontmatter = parseYaml(text.slice(3, end))
  } catch {
    return null
  }
  const description = frontmatter?.description
  return typeof description === 'string' && description.trim() ? description.trim() : null
}

export function writeCodexSkillPointers(cfgDir, names) {
  const written = []
  for (const name of hiddenSkillNames(cfgDir, names)) {
    const description = skillDescription(cfgDir, name)
    if (!description) continue
    const target = path.join(cfgDir, 'skills', name, 'SKILL.md')
    const pointer = path.join(cfgDir, 'skills', `curia-${name}`)
    fs.mkdirSync(pointer, { recursive: true })
    fs.writeFileSync(path.join(pointer, 'SKILL.md'), [
      '---',
      `name: ${JSON.stringify(`curia-${name}`)}`,
      `description: ${JSON.stringify(`${description} Read ${target} in full before you act on this.`)}`,
      '---',
      '',
      `This is the \`${name}\` skill. Read \`${target}\` completely, then follow it.`,
      '',
      'Curia installed that file and it is the whole skill. This pointer exists because codex does',
      `not list \`${name}\` in its own skill catalog, and it restates none of the skill itself.`,
      '',
      `Read \`${target}\` ONCE in a session. If you have already read it, you are still running it,`,
      'and reading it again only repeats what you have. Say that you are using this skill, then act.',
      '',
      'The curia standing orders win wherever the two disagree.',
      '',
    ].join('\n'))
    written.push(`curia-${name}`)
  }
  return written
}

function codexSkillDenyList(install) {
  const installed = new Set(install ?? [])
  let entries = []
  try {
    entries = fs.readdirSync(path.join(os.homedir(), '.agents', 'skills'), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => !installed.has(name))
    .sort()
}

function seedCredential(cfgDir, { sandboxed = false } = {}) {
  const destination = path.join(cfgDir, 'auth.json')
  const host = path.join(os.homedir(), '.codex', 'auth.json')
  fs.rmSync(destination, { force: true })
  if (!sandboxed) {
    fs.symlinkSync(host, destination)
    return
  }
  if (!fs.existsSync(host)) {
    throw new Error(`no codex credential for the container: ${host} does not exist, and a sandboxed codex agent cannot reach the host store - type \`reauth\` to sign in from a browser (#642)`)
  }
  const raw = fs.readFileSync(host, 'utf8')
  const expiry = codexAccessTokenExpiry(raw)
  if (expiry !== null && expiry <= Date.now()) {
    throw new Error(`refusing to seed the codex credential into the container: the host access token expired ${new Date(expiry).toISOString()}. A copy that starts expired refreshes at once, the server rotates the refresh token, and the read-only copy cannot store the rotation - that strands the host store too (#351) - type \`reauth\` to sign in from a browser first (#642)`)
  }
  fs.writeFileSync(destination, raw)
  fs.chmodSync(destination, 0o400)
}

function writeConnectionSettings({
  wtPath, cfgDir, agent, ticket, daemonPort, daemonHost,
  reasoningEffort, token, skills,
}) {
  writeSecretFile(path.join(cfgDir, 'config.toml'), [
    '# Written by the curia daemon per agent. Never hand-edited.',
    '',
    ...(reasoningEffort ? [`model_reasoning_effort = ${toml(reasoningEffort)}`, ''] : []),
    '[features]',
    'hooks = true',
    'apps = false',
    'plugins = false',
    'multi_agent = false',
    'browser_use = false',
    'browser_use_external = false',
    'browser_use_full_cdp_access = false',
    'in_app_browser = false',
    'computer_use = false',
    'in_app_updates = false',
    'skill_mcp_dependency_install = false',
    '',
    '[skills]',
    'bundled = { enabled = false }',
    ...codexSkillDenyList(skills?.install).flatMap((name) => [
      '',
      '[[skills.config]]',
      `name = ${toml(name)}`,
      'enabled = false',
    ]),
    '',
    `[projects.${toml(wtPath)}]`,
    'trust_level = "trusted"',
    '',
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = ${toml(mcpUrl(daemonPort, agent, ticket, daemonHost))}`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_S}`,
    `http_headers = { ${toml(TOKEN_HEADER)} = ${toml(token)} }`,
    '',
  ].join('\n'))
  writeSecretFile(path.join(cfgDir, 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{
        type: 'command',
        command: stopHookCommand(daemonPort, agent, daemonHost, token),
      }] }],
    },
  }, null, 2))
}

export const CODEX_WORKSPACE = Object.freeze({
  memoryFile: CODEX_MEMORY_FILE,
  provider: 'openai',
  skillPointers: writeCodexSkillPointers,
  hostStore: () => path.join(os.homedir(), '.codex'),
  env: (cfgDir) => ({ [CODEX_CONFIG_ROOT_ENV]: cfgDir }),
  seed: (cfgDir, _wtPath, options) => seedCredential(cfgDir, options),
  connectionSettings: writeConnectionSettings,
})

export const codexUntrustedProjectConfig = (wtPath) => path.join(wtPath, '.codex', 'hooks.json')

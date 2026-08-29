import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { TOKEN_HEADER } from './agenttoken.mjs'

export const CLAUDE_CONFIG_ROOT_ENV = 'CLAUDE_CONFIG_DIR'
export const CLAUDE_MEMORY_FILE = 'CLAUDE.md'
export const CLAUDE_API_KEY_TAIL_LENGTH = 20
export const CURIA_MCP_SERVER_NAME = 'curia'
export const LOOPBACK_HOST = '127.0.0.1'
export const CLAUDE_REPO_SKILL_ROOTS = Object.freeze([['.claude', 'skills']])

const mcpUrl = (daemonPort, agent, ticket, host = LOOPBACK_HOST) => (
  `http://${host}:${daemonPort}/mcp?agent=${agent}&ticket=${ticket}`
)

const stopHookCommand = (daemonPort, agent, host = LOOPBACK_HOST, token) => [
  `curl -s -X POST 'http://${host}:${daemonPort}/agent_done?agent=${agent}'`,
  `-H 'Content-Type: application/json'`,
  `-H '${TOKEN_HEADER}: ${token}'`,
  '-d @-',
].join(' ')

const writeSecretFile = (file, data) => {
  fs.writeFileSync(file, data, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

export function claudeApiKeyApproval(apiKey) {
  if (!apiKey) return null
  if (apiKey.length < CLAUDE_API_KEY_TAIL_LENGTH) {
    throw new Error(`the deployed Claude API key is shorter than ${CLAUDE_API_KEY_TAIL_LENGTH} characters`)
  }
  return apiKey.slice(-CLAUDE_API_KEY_TAIL_LENGTH)
}

export function writeClaudeConnection({
  dir, serverName, url, header, token, hooks = null, env = null,
}) {
  fs.mkdirSync(dir, { recursive: true })
  const mcpFile = path.join(dir, '.mcp.json')
  writeSecretFile(mcpFile, JSON.stringify({
    mcpServers: { [serverName]: { type: 'http', url, headers: { [header]: token } } },
  }, null, 2))
  const settingsDir = path.join(dir, '.claude')
  fs.mkdirSync(settingsDir, { recursive: true })
  writeSecretFile(path.join(settingsDir, 'settings.json'), JSON.stringify({
    enableAllProjectMcpServers: true,
    permissions: { defaultMode: 'bypassPermissions' },
    ...(env ? { env } : {}),
    ...(hooks ? { hooks } : {}),
  }, null, 2))
  return mcpFile
}

export const CLAUDE_WORKSPACE = Object.freeze({
  memoryFile: CLAUDE_MEMORY_FILE,
  provider: 'anthropic',
  hostStore: () => path.join(os.homedir(), '.claude'),
  env: (cfgDir, { sandboxed = false } = {}) => ({
    [CLAUDE_CONFIG_ROOT_ENV]: cfgDir,
    ...(sandboxed ? {} : { CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(os.homedir(), '.claude') }),
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(86_400_000),
  }),
  seed: (cfgDir, wtPath, { apiKey = null } = {}) => {
    const approvedApiKey = claudeApiKeyApproval(apiKey)
    fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      installMethod: 'native',
      autoUpdates: false,
      theme: 'dark',
      numStartups: 1,
      projects: {
        [wtPath]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
          hasClaudeMdExternalIncludesApproved: true,
          hasClaudeMdExternalIncludesWarningShown: true,
        },
      },
      ...(approvedApiKey ? {
        customApiKeyResponses: { approved: [approvedApiKey], rejected: [] },
      } : {}),
    }, null, 2))
    fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      disableClaudeAiConnectors: true,
      allowedMcpServers: [{ serverName: CURIA_MCP_SERVER_NAME }],
      cleanupPeriodDays: 36500,
    }, null, 2))
  },
  connectionSettings: ({ wtPath, agent, ticket, daemonPort, daemonHost, reasoningEffort, token }) => {
    writeClaudeConnection({
      dir: wtPath,
      serverName: CURIA_MCP_SERVER_NAME,
      url: mcpUrl(daemonPort, agent, ticket, daemonHost),
      header: TOKEN_HEADER,
      token,
      env: reasoningEffort ? { CLAUDE_CODE_EFFORT_LEVEL: reasoningEffort } : null,
      hooks: {
        Stop: [{ hooks: [{
          type: 'command', command: stopHookCommand(daemonPort, agent, daemonHost, token),
        }] }],
      },
    })
  },
})

export const claudeUntrustedProjectConfig = (wtPath) => (
  path.join(wtPath, '.claude', 'settings.local.json')
)

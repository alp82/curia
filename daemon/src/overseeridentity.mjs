// One durable tool identity per overseer conversation (#701, ADR-0024).
//
// #314 minted the overseer's tool secret PER TURN, because a turn was one HTTP
// POST into the container and it survived no restart. #688 made a conversation
// a live pane instead, and a pane outlives many turns, a parking, and a deploy.
// A secret that lives in one turn's memory has nothing to hand such a pane, so
// this file mints one token per CONVERSATION and keeps it on disk, on the
// pattern `agenttoken.mjs` proves.
//
// THE TOKEN IS THE CLAIM, AND THE KEY IS ONLY A LOOKUP. A pane reaches the
// daemon at `/overseer/mcp?conversation=<key>`, and the daemon reads the stored
// token for that key and compares it in constant time. A pane that names
// another conversation presents the wrong secret for it, so the name buys it
// nothing. That is what the acceptance rule "pane-supplied destination text
// never changes the route" means at the transport: the route comes from
// `overseerRoute`, a pure function of the authenticated key, and no field of
// the request or the tool call can reach it.
//
// THE PANE IS NEVER TOLD ITS KEY. #688 kept the conversation key off the pane
// command line, and this file keeps that promise: the daemon writes the pane's
// connection settings into the conversation's own project directory, and the
// pane only ever learns the session id it resumes.
//
// AUTHORITY DOESN'T WIDEN. The token opens the overseer verb catalogue and
// nothing else. It is not an agent token, it doesn't reach `AGENT_ROUTES`, and
// the daemon still composes every canonical command itself.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isConsoleKey } from './attach.mjs'
import { tokensEqual } from './agenttoken.mjs'

// A Discord thread id is digits, and a browser conversation is `console-<n>`.
// The same two shapes `overseerPaneSession` admits, stated once here because
// this value also becomes a FILE NAME and a query parameter.
const THREAD_KEY_RE = /^\d+$/

export function isOverseerKey(key) {
  const value = String(key ?? '')
  return isConsoleKey(value) || THREAD_KEY_RE.test(value)
}

// ---- the durable route ------------------------------------------------------

// Where a conversation's verb calls land, and who they land as. It is a pure
// function of the key, so the destination of a tool call is decided by the
// conversation the token proves and by nothing the caller said.
//
// `routeThreadId` is the Discord thread a confirm posts into. A browser
// conversation has none: its confirms land in the channel and on the needs-you
// list, which is the rule `browserTurn` already holds.
export function overseerRoute(key) {
  const value = String(key ?? '')
  if (isConsoleKey(value)) return { key: value, surface: 'console', routeThreadId: null, role: 'overseer' }
  if (THREAD_KEY_RE.test(value)) return { key: value, surface: 'discord', routeThreadId: value, role: 'overseer' }
  throw new Error(`"${value}" is not an overseer conversation key`)
}

// ---- the token store --------------------------------------------------------

// Daemon-owned, beside the agent tokens and under the same data directory. No
// container mounts this tree: the daemon writes the secret straight into the
// pane's connection settings, so the pane reads a file it can already see and
// this directory stays the daemon's own.
export function conversationTokensDir(dataDir) {
  return path.join(dataDir, 'overseer-tokens')
}

const TOKEN_RE = /^[0-9a-f]{64}$/

// The key is asserted before it is used as a file name. Neither shape admits a
// separator, so this stays a basename.
export function conversationTokenFile(dataDir, key) {
  if (!isOverseerKey(key)) return null
  return path.join(conversationTokensDir(dataDir), String(key))
}

export function readConversationToken(dataDir, key) {
  const file = conversationTokenFile(dataDir, key)
  if (!file) return null
  try {
    const token = fs.readFileSync(file, 'utf8').trim()
    return TOKEN_RE.test(token) ? token : null
  } catch {
    return null
  }
}

// The conversation's token, minted once and read back forever after.
//
// DURABLE, unlike `mintAgentToken`, which mints a fresh secret on every arm.
// An agent's arm is a new process for a new turn of work; a conversation is one
// thing that parks and rehydrates, and rewriting its token on every rehydration
// would leave a running pane holding a secret the daemon no longer honors.
export function ensureConversationToken(dataDir, key) {
  const file = conversationTokenFile(dataDir, key)
  if (!file) throw new Error(`refusing to mint a tool token for "${key}": not an overseer conversation key`)
  const existing = readConversationToken(dataDir, key)
  if (existing) return existing
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(conversationTokensDir(dataDir), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, token, { mode: 0o600 })
  // writeFileSync applies the mode only when it CREATES the file, and a token
  // file replaced after a revoke can find one there.
  fs.chmodSync(file, 0o600)
  return token
}

// Fails closed in every direction that isn't an exact match: an unknown key, an
// unminted conversation, a missing header, a wrong secret.
export function conversationTokenMatches(dataDir, key, presented) {
  return tokensEqual(readConversationToken(dataDir, key), presented)
}

// The revoke. A deleted conversation spends its number for good, so its token
// must not outlive it: a pane still running on the old secret loses the verbs
// on its next call.
export function revokeConversationToken(dataDir, key) {
  const file = conversationTokenFile(dataDir, key)
  if (file) fs.rmSync(file, { force: true })
}

// Every token whose conversation is not in a positively known list, removed.
// The same evidence rule `sweepAgentTokens` runs on.
export function sweepConversationTokens(dataDir, keys) {
  let names = []
  try {
    names = fs.readdirSync(conversationTokensDir(dataDir))
  } catch {
    return []
  }
  const keep = new Set([...keys].map(String))
  const swept = []
  for (const name of names) {
    if (keep.has(name) || !isOverseerKey(name)) continue
    revokeConversationToken(dataDir, name)
    swept.push(name)
  }
  return swept
}

// ---- the pane's connection settings -----------------------------------------

// The route the pane's harness calls, and the query parameter that names the
// conversation on it.
export const OVERSEER_CONVERSATION_PARAM = 'conversation'

export function conversationMcpUrl({ host, port, key, mcpPath }) {
  if (!isOverseerKey(key)) throw new Error(`"${key}" is not an overseer conversation key`)
  return `http://${host}:${port}${mcpPath}?${OVERSEER_CONVERSATION_PARAM}=${key}`
}

function writeSecretFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

// The conversation's own project directory, under the one config directory both
// sides mount at the same path.
//
// ONE DIRECTORY PER CONVERSATION, and the session id names it. The harness
// plants a project MCP server from the `.mcp.json` file in its working
// directory, so a shared working directory could carry only one conversation's
// token. The session id is the durable identity the pane already receives, so
// the daemon and the pane both reach the same directory without the key ever
// crossing the boundary.
//
// A project `.mcp.json` file rather than `--mcp-config`: the CLI connects the
// servers a flag names asynchronously, so turn one can start before the tool
// exists. The reject-on-lint prototype measured that.
export function conversationHomeFor(overseerHome, sessionId) {
  const id = String(sessionId ?? '')
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(`"${id}" is not an overseer session id`)
  return path.join(overseerHome, id)
}

// The pane's whole reach back into the daemon, written by the daemon.
//
// `enableAllProjectMcpServers` is what makes the harness trust a project server
// with no prompt, the same pair `workspace.mjs` writes for an agent worktree.
export function writeConversationConnection({ home, url, token, serverName, header }) {
  fs.mkdirSync(home, { recursive: true })
  writeSecretFile(path.join(home, '.mcp.json'), JSON.stringify({
    mcpServers: {
      [serverName]: { type: 'http', url, headers: { [header]: token } },
    },
  }, null, 2))
  const dotClaude = path.join(home, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  writeSecretFile(path.join(dotClaude, 'settings.json'), JSON.stringify({
    enableAllProjectMcpServers: true,
    permissions: { defaultMode: 'bypassPermissions' },
  }, null, 2))
  return path.join(home, '.mcp.json')
}

// ---- carrying a conversation into its own project directory -----------------

// The harness slug for a working directory: every character that isn't a letter
// or a digit becomes a hyphen. `projects/<slug>/<session id>.jsonl` is where the
// transcript of a session run in that directory lands.
export function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

// A resume finds its session only under the project directory it was recorded
// in. Conversations bound before #701 ran in the one shared overseer home, so
// the first pane that starts in a conversation's own directory would resume
// nothing.
//
// The fix is a copy, once: find the transcript wherever the config directory
// already holds it and place it under the new slug. It returns the file it
// wrote, or null when there is nothing to carry or the transcript is already
// there. Copy rather than move, because the Chat screen reads transcripts by
// scanning this tree and a move mid-read would lose the conversation.
export function carryOverseerTranscript({ configDir, sessionId, home }) {
  const id = String(sessionId ?? '')
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null
  const projects = path.join(configDir, 'projects')
  const target = path.join(projects, claudeProjectSlug(home), `${id}.jsonl`)
  if (fs.existsSync(target)) return null
  let dirs = []
  try {
    dirs = fs.readdirSync(projects)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${id}.jsonl`)
    if (candidate === target || !fs.existsSync(candidate)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(candidate, target)
    return target
  }
  return null
}

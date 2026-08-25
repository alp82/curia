// The agent's proof of its own name (#159).
//
// Two routes on the daemon are the agent's own — `POST /mcp?agent=` and
// `POST /agent_done?agent=` — and until this file existed the NAME WAS THE
// CLAIM. Any process that reached the daemon port could send another agent's
// name in that query param: report a result for it, open an escalation as it, or
// end its turn under it. The bare pane could always do that. #156 is what makes
// it matter, because the daemon now binds a second listener on the docker bridge
// gateway, and every container on the box can reach that address.
//
// So the daemon mints a secret per agent and hands it over inside the connection settings
// it already writes: one header on the MCP server, the same header on the Stop
// hook's curl. NOT an environment variable, which is what the ticket proposed —
// on the bare path a pane env rides `env K=V` in tmux argv and lands in `ps` for
// every user on the box, the exact cost #155 measured and asked #156 not to
// repeat. A header costs no new plumbing on either harness: `.mcp.json` takes a
// `headers` object and codex's `[mcp_servers.*]` takes `http_headers`.
//
// The token file is DAEMON-OWNED. It sits beside the results dir, never inside
// the config dir a container mounts, so an agent holds its own token and no
// other's. It is a file rather than a map in memory because a restarted daemon
// ADOPTS the agents its predecessor spawned (reconcile), and those agents keep
// using the token their connection settings already carry.
//
// What this does not do: on the bare path there is no boundary to enforce. Every
// agent runs as the same host user, so one can read another agent's settings
// whatever the daemon stores and where. The token is a real control for a
// CONTAINER, which mounts only its own two directories, and for anything else on
// the box that can reach the port but not the daemon's own data dir.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { validSessionName } from './attach.mjs'

// Lower case because node lower-cases every incoming header name, and this one
// string is written into `.mcp.json`, into codex's `config.toml`, into two curl
// commands, and read back off `req.headers`. One name for one thing.
export const TOKEN_HEADER = 'x-curia-agent-token'

// The routes an agent calls, and the only two that name an agent at all. This
// set does double duty: it is what the token gates, and it is the whole surface
// the container-facing listener serves (index.mjs). Adding a route that takes a
// `?agent=` and forgetting this set is the regression to guard against — the
// name would be the claim again.
export const AGENT_ROUTES = new Set(['/mcp', '/agent_done'])

// 32 bytes as hex: quote-free by construction, so it drops into a single-quoted
// curl argument, a JSON string and a TOML string with no escaping rule anywhere.
const TOKEN_RE = /^[0-9a-f]{64}$/

// ---- the file store ---------------------------------------------------------

// The shape both token stores keep: one 0600 file per name, under one directory
// of the daemon's data dir, holding a 64-hex secret and nothing else.
//
// The conversation store (`overseeridentity.mjs`) is the second caller. It
// keeps its own two rules — which names are valid, and a DURABLE token read
// back rather than reminted — and takes the rest from here: where the file
// lives, how the name is asserted before it becomes one, the mode that survives
// a rewrite, the constant-time compare, the revoke, and the sweep against a
// positively known list. Two stores that had to agree on all of that by hand is
// how one of them ends up world-readable.
export function tokenStore({ dirName, validName, dirMode = null, refusal }) {
  const dirFor = (dataDir) => path.join(dataDir, dirName)

  // The name comes off a query param at check time, so it is asserted before it
  // is ever used as a filename. Neither store's shape admits a `/`, which is
  // what keeps this a basename.
  const fileFor = (dataDir, name) => (validName(String(name ?? '')) ? path.join(dirFor(dataDir), String(name)) : null)

  const read = (dataDir, name) => {
    const file = fileFor(dataDir, name)
    if (!file) return null
    try {
      const token = fs.readFileSync(file, 'utf8').trim()
      return TOKEN_RE.test(token) ? token : null
    } catch {
      return null
    }
  }

  // A fresh secret, written where the name says.
  const mint = (dataDir, name) => {
    const file = fileFor(dataDir, name)
    if (!file) throw new Error(refusal(name))
    const token = crypto.randomBytes(32).toString('hex')
    fs.mkdirSync(dirFor(dataDir), { recursive: true, ...(dirMode === null ? {} : { mode: dirMode }) })
    fs.writeFileSync(file, token, { mode: 0o600 })
    // writeFileSync applies the mode only when it CREATES the file, and a name
    // minted twice already has one (same note as sandbox.mjs's env file).
    fs.chmodSync(file, 0o600)
    return token
  }

  const revoke = (dataDir, name) => {
    const file = fileFor(dataDir, name)
    if (file) fs.rmSync(file, { force: true })
  }

  // Every token whose name is not in a POSITIVELY known list — the same
  // evidence rule the rest of reconcile runs on. Returns the names collected.
  const sweep = (dataDir, live) => {
    let names = []
    try {
      names = fs.readdirSync(dirFor(dataDir))
    } catch {
      return [] // nothing was ever minted
    }
    const keep = new Set([...live].map(String))
    const swept = []
    for (const name of names) {
      if (keep.has(name) || !validName(name)) continue
      revoke(dataDir, name)
      swept.push(name)
    }
    return swept
  }

  return {
    dirFor,
    fileFor,
    read,
    mint,
    revoke,
    sweep,
    // Fails CLOSED in every direction that is not an exact match: no minted
    // token, an unreadable one, a missing header, a wrong one.
    matches: (dataDir, name, presented) => tokensEqual(read(dataDir, name), presented),
  }
}

// ---- the agent's store ------------------------------------------------------

const AGENTS = tokenStore({
  dirName: 'tokens',
  validName: (name) => validSessionName(name),
  refusal: (agent) => `refusing to mint an agent token for "${agent}": not a valid curia session name`,
})

export function tokensDir(dataDir) {
  return AGENTS.dirFor(dataDir)
}

// A FRESH secret, overwriting whatever the last arm of this agent left. The
// cross-harness respawn (#126) rewrites the connection settings, and the pane
// that died must not keep speaking for the name.
export function mintAgentToken(dataDir, agent) {
  return AGENTS.mint(dataDir, agent)
}

export function readAgentToken(dataDir, agent) {
  return AGENTS.read(dataDir, agent)
}

// One secret against another, in constant time. The overseer's per-turn secret
// (#314) is checked with this same function: it is minted differently and it
// lives in memory rather than in a file, but "is this the string curia handed
// out" is one question and it gets one answer.
export function tokensEqual(expected, presented) {
  if (!expected || typeof presented !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented.trim(), 'utf8')
  // timingSafeEqual throws on a length mismatch, and the length of a
  // fixed-width token is not a secret.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// An agent armed before #159 shipped has no way in — see
// docs/live-checks/159-worker-token.md for the one restart that costs, and its
// recovery.
export function agentTokenMatches(dataDir, agent, presented) {
  return AGENTS.matches(dataDir, agent, presented)
}

export function forgetAgentToken(dataDir, agent) {
  AGENTS.revoke(dataDir, agent)
}

export function sweepAgentTokens(dataDir, live) {
  return AGENTS.sweep(dataDir, live)
}

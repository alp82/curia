// The worker's proof of its own name (#159).
//
// Two routes on the daemon are the worker's own — `POST /mcp?worker=` and
// `POST /worker_done?worker=` — and until this file existed the NAME WAS THE
// CLAIM. Any process that reached the daemon port could send another worker's
// name in that query param: report a result for it, open an escalation as it, or
// end its turn under it. The bare pane could always do that. #156 is what makes
// it matter, because the daemon now binds a second listener on the docker bridge
// gateway, and every container on the box can reach that address.
//
// So the daemon mints a secret per worker and hands it over inside the harness it
// already writes: one header on the MCP server, the same header on the Stop
// hook's curl. NOT an environment variable, which is what the ticket proposed —
// on the bare path a pane env rides `env K=V` in tmux argv and lands in `ps` for
// every user on the box, the exact cost #155 measured and asked #156 not to
// repeat. A header costs no new plumbing on either lane: `.mcp.json` takes a
// `headers` object and codex's `[mcp_servers.*]` takes `http_headers`.
//
// The token file is DAEMON-OWNED. It sits beside the results dir, never inside
// the config dir a container mounts, so a worker holds its own token and no
// other's. It is a file rather than a map in memory because a restarted daemon
// ADOPTS the workers its predecessor spawned (reconcile), and those workers keep
// using the token their harness already carries.
//
// What this does not do: on the bare path there is no boundary to enforce. Every
// worker runs as the same host user, so one can read another's harness file
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
export const TOKEN_HEADER = 'x-curia-worker-token'

// The routes a worker calls, and the only two that name a worker at all. This
// set does double duty: it is what the token gates, and it is the whole surface
// the container-facing listener serves (index.mjs). Adding a route that takes a
// `?worker=` and forgetting this set is the regression to guard against — the
// name would be the claim again.
export const WORKER_ROUTES = new Set(['/mcp', '/worker_done'])

// 32 bytes as hex: quote-free by construction, so it drops into a single-quoted
// curl argument, a JSON string and a TOML string with no escaping rule anywhere.
const TOKEN_RE = /^[0-9a-f]{64}$/

export function tokensDir(dataDir) {
  return path.join(dataDir, 'tokens')
}

// The session name comes off a query param at check time, so it is asserted
// before it is ever used as a filename. `validSessionName` admits no `/`, which
// is what keeps this a basename.
function tokenFile(dataDir, worker) {
  if (!validSessionName(String(worker ?? ''))) return null
  return path.join(tokensDir(dataDir), String(worker))
}

// A FRESH secret, overwriting whatever the last arm of this worker left. The
// cross-backend respawn (#126) rewrites the harness, and the pane that died must
// not keep speaking for the name.
export function mintWorkerToken(dataDir, worker) {
  const file = tokenFile(dataDir, worker)
  if (!file) throw new Error(`refusing to mint a worker token for "${worker}": not a valid curia session name`)
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(tokensDir(dataDir), { recursive: true })
  fs.writeFileSync(file, token, { mode: 0o600 })
  // writeFileSync applies the mode only when it CREATES the file, and a worker
  // armed twice already has one (same note as sandbox.mjs's env file).
  fs.chmodSync(file, 0o600)
  return token
}

export function readWorkerToken(dataDir, worker) {
  const file = tokenFile(dataDir, worker)
  if (!file) return null
  try {
    const token = fs.readFileSync(file, 'utf8').trim()
    return TOKEN_RE.test(token) ? token : null
  } catch {
    return null
  }
}

// Fails CLOSED in every direction that is not an exact match: no minted token,
// an unreadable one, a missing header, a wrong one. A worker armed before this
// shipped therefore has no way in — see docs/live-checks/159-worker-token.md for
// the one restart that costs, and its recovery.
export function workerTokenMatches(dataDir, worker, presented) {
  const expected = readWorkerToken(dataDir, worker)
  if (!expected || typeof presented !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented.trim(), 'utf8')
  // timingSafeEqual throws on a length mismatch, and the length of a
  // fixed-width token is not a secret.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function forgetWorkerToken(dataDir, worker) {
  const file = tokenFile(dataDir, worker)
  if (file) fs.rmSync(file, { force: true })
}

// Every token whose worker is not in a POSITIVELY known session list — the same
// evidence rule the rest of reconcile runs on. Returns the names collected.
export function sweepWorkerTokens(dataDir, live) {
  let names = []
  try {
    names = fs.readdirSync(tokensDir(dataDir))
  } catch {
    return [] // nothing was ever minted
  }
  const keep = new Set(live)
  const swept = []
  for (const name of names) {
    if (keep.has(name) || !validSessionName(name)) continue
    forgetWorkerToken(dataDir, name)
    swept.push(name)
  }
  return swept
}
